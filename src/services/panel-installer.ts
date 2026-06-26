// Installs / updates / reinstalls the ComfyUI sidebar panel
// ("comfyui-agent-panel" on the Comfy Registry; repo comfyui-mcp-panel) into a
// LOCAL ComfyUI's custom_nodes, and auto-ensures it on MCP load.
//
// Policy (decided by the user):
//   - on load → install if MISSING (install-if-missing only, see ensurePanelInstalled).
//   - explicit `update` action → pull the latest nightly on demand.
//   - target version is always "nightly" (the registry git-HEAD channel) — there
//     is no clean semver to diff, so we never churn an existing install on load.
//
// SAFETY:
//   - LOCAL-only: no COMFYUI_PATH → no-op cleanly (remote/cloud modes).
//   - NEVER touch a dev install: custom_nodes/comfyui-mcp-panel is often a
//     SYMLINK/junction to the developer's working repo. lstat → skip/refuse.
//   - on-load ensure is fire-and-forget, hard-timed-out, and never throws.
//   - opt-out env COMFYUI_MCP_PANEL_AUTOINSTALL=0/false disables auto-ensure.
//   - install/update/reinstall queue via ComfyUI-Manager; ComfyUI must be
//     RESTARTED to load the new/updated node (we never auto-restart).

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config, isLocalMode } from "../config.js";
import { logger } from "../utils/logger.js";
import { parsePyproject } from "./node-authoring.js";
import {
  installCustomNode,
  updateCustomNode,
  reinstallCustomNode,
  type NodeOpResult,
} from "./node-management.js";
import { getSystemStats } from "../comfyui/client.js";

/** Comfy Registry id (also pyproject [project].name). Authoritative for detection. */
export const PANEL_REGISTRY_ID = "comfyui-agent-panel";

/** Always install/update/reinstall the panel from the registry git-HEAD channel. */
export const PANEL_VERSION = "nightly";

/**
 * Fast-path directory names to probe first. The panel installs to a custom_nodes
 * subdir named after the REPO ("comfyui-mcp-panel"), but the registry name is
 * "comfyui-agent-panel" — so check both quickly, then fall back to a full scan.
 * The pyproject `name == comfyui-agent-panel` match is always authoritative.
 */
const FAST_PATH_DIRS = ["comfyui-mcp-panel", "comfyui-agent-panel"];

/** Hard cap so the on-load ensure can never block startup. */
const ENSURE_TIMEOUT_MS = 20_000;

export class PanelInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanelInstallError";
  }
}

// ---------------------------------------------------------------------------
// Injectable deps (mirrors node-authoring's pattern for clean unit tests)
// ---------------------------------------------------------------------------

export interface PanelInstallerDeps {
  /**
   * True only in LOCAL mode. In remote (--comfyui-url) / cloud mode the Manager
   * mutations target a REMOTE host, so panel install/update/reinstall must be
   * refused even when COMFYUI_PATH happens to be set (the local FS scan would be
   * the WRONG filesystem). The on-load ensure also no-ops.
   */
  isLocalMode: () => boolean;
  /** Resolved local ComfyUI root, or undefined in remote/cloud mode. */
  comfyuiPath: () => string | undefined;
  /** Process env (for the opt-out flag). */
  env: () => NodeJS.ProcessEnv;
  existsSync: (p: string) => boolean;
  /** True when `p` is a symlink/junction (dev install). Never throws. */
  isSymlink: (p: string) => boolean;
  readdir: (p: string) => string[];
  readFile: (p: string) => string;
  /** Is the target ComfyUI reachable right now? Never throws. */
  isReachable: () => Promise<boolean>;
  install: (opts: { id: string; version?: string }) => Promise<NodeOpResult>;
  update: (opts: { id: string }) => Promise<NodeOpResult>;
  reinstall: (opts: { id: string; version?: string }) => Promise<NodeOpResult>;
}

export const defaultDeps: PanelInstallerDeps = {
  isLocalMode: () => isLocalMode(),
  comfyuiPath: () => config.comfyuiPath,
  env: () => process.env,
  existsSync,
  isSymlink: (p) => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  },
  readdir: (p) => readdirSync(p),
  readFile: (p) => readFileSync(p, "utf-8"),
  isReachable: async () => {
    try {
      await getSystemStats();
      return true;
    } catch {
      return false;
    }
  },
  install: (opts) => installCustomNode(opts),
  update: (opts) => updateCustomNode(opts),
  reinstall: (opts) => reinstallCustomNode(opts),
};

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface PanelDetection {
  /** Whether panel management even applies here (false in remote/cloud). */
  applicable: boolean;
  installed: boolean;
  /** Matched custom_nodes subdir, if installed. */
  dir?: string;
  /** Installed version, read from the matched dir's pyproject.toml. */
  version?: string;
  /** The matched dir is a symlink/junction → dev install, manage manually. */
  isDevSymlink: boolean;
}

/**
 * Scan <COMFYUI_PATH>/custom_nodes for a subdir whose pyproject.toml
 * `[project].name == "comfyui-agent-panel"`. LOCAL-only: with no comfyuiPath
 * (remote/cloud) returns applicable:false / installed:false.
 */
export async function detectPanelInstall(
  deps: PanelInstallerDeps = defaultDeps,
): Promise<PanelDetection> {
  const comfyPath = deps.comfyuiPath();
  // LOCAL-only: in remote/cloud mode the local FS is the wrong filesystem to
  // reason about, so detection is not applicable even if COMFYUI_PATH is set.
  if (!deps.isLocalMode() || !comfyPath) {
    return { applicable: false, installed: false, isDevSymlink: false };
  }

  const customNodes = join(comfyPath, "custom_nodes");

  // P1a — DEV-JUNCTION GUARD, FIRST and INDEPENDENT of pyproject parsing.
  // lstat the KNOWN panel target dirs directly: if either is a symlink/junction
  // it is a dev install and must be protected from any mutation, EVEN when its
  // pyproject.toml is missing, corrupt, or unreadable. (A missing/bad pyproject
  // must never downgrade a junction to "not installed" — that would let
  // install/reinstall clobber the developer's working repo.)
  for (const name of FAST_PATH_DIRS) {
    const dir = join(customNodes, name);
    if (deps.isSymlink(dir)) {
      let version: string | undefined;
      const pyproject = join(dir, "pyproject.toml");
      if (deps.existsSync(pyproject)) {
        try {
          version = parsePyproject(deps.readFile(pyproject)).version;
        } catch {
          version = undefined;
        }
      }
      return { applicable: true, installed: true, dir, version, isDevSymlink: true };
    }
  }

  // Candidate dirs: fast-path names first, then any other subdir.
  const candidates: string[] = FAST_PATH_DIRS.map((n) => join(customNodes, n));
  if (deps.existsSync(customNodes)) {
    let entries: string[] = [];
    try {
      entries = deps.readdir(customNodes);
    } catch {
      entries = [];
    }
    for (const e of entries) {
      const full = join(customNodes, e);
      if (!candidates.includes(full)) candidates.push(full);
    }
  }

  for (const dir of candidates) {
    const pyproject = join(dir, "pyproject.toml");
    if (!deps.existsSync(pyproject)) continue;
    let parsed: { projectName?: string; version?: string };
    try {
      parsed = parsePyproject(deps.readFile(pyproject));
    } catch {
      continue;
    }
    if (parsed.projectName === PANEL_REGISTRY_ID) {
      return {
        applicable: true,
        installed: true,
        dir,
        version: parsed.version,
        isDevSymlink: deps.isSymlink(dir),
      };
    }
  }

  return { applicable: true, installed: false, isDevSymlink: false };
}

// ---------------------------------------------------------------------------
// On-load ensure (install-if-missing only)
// ---------------------------------------------------------------------------

export type EnsureAction =
  | "installed"
  | "up-to-date"
  | "skipped-dev"
  | "skipped"
  | "unavailable";

export interface EnsureResult {
  action: EnsureAction;
  reason?: string;
  dir?: string;
  installedVersion?: string;
  restartRequired?: boolean;
}

export interface EnsureOptions {
  deps?: PanelInstallerDeps;
  timeoutMs?: number;
}

function isAutoInstallDisabled(env: NodeJS.ProcessEnv): boolean {
  const v = (env.COMFYUI_MCP_PANEL_AUTOINSTALL ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`panel ensure timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function ensureInner(deps: PanelInstallerDeps): Promise<EnsureResult> {
  if (isAutoInstallDisabled(deps.env())) {
    return {
      action: "skipped",
      reason: "COMFYUI_MCP_PANEL_AUTOINSTALL disabled",
    };
  }

  if (!deps.isLocalMode()) {
    return {
      action: "unavailable",
      reason: "Panel auto-install is local-only (remote/cloud mode active).",
    };
  }

  if (!deps.comfyuiPath()) {
    return {
      action: "unavailable",
      reason: "No local ComfyUI (COMFYUI_PATH unset); panel auto-install is local-only.",
    };
  }

  if (!(await deps.isReachable())) {
    return { action: "unavailable", reason: "ComfyUI is not reachable." };
  }

  const detection = await detectPanelInstall(deps);

  if (detection.isDevSymlink) {
    return {
      action: "skipped-dev",
      reason: "dev install (symlink) — managed manually",
      dir: detection.dir,
      installedVersion: detection.version,
    };
  }

  if (!detection.installed) {
    await deps.install({ id: PANEL_REGISTRY_ID, version: PANEL_VERSION });
    return {
      action: "installed",
      reason: `Installed ${PANEL_REGISTRY_ID} (${PANEL_VERSION}).`,
      restartRequired: true,
    };
  }

  // Present already. We never diff nightly on load (no clean version), so we
  // leave it untouched — the explicit `update` action refreshes on demand.
  return {
    action: "up-to-date",
    dir: detection.dir,
    installedVersion: detection.version,
  };
}

/**
 * The on-load policy engine. LOCAL + reachable only; install-if-missing.
 * Hard-timed-out and swallows every error (returns `unavailable` on failure),
 * so it can be fired-and-forgotten from startup without ever blocking/crashing.
 */
export async function ensurePanelInstalled(
  opts: EnsureOptions = {},
): Promise<EnsureResult> {
  const deps = opts.deps ?? defaultDeps;
  try {
    return await withTimeout(ensureInner(deps), opts.timeoutMs ?? ENSURE_TIMEOUT_MS);
  } catch (err) {
    logger.debug("panel: ensure failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      action: "unavailable",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Tool-facing operations
// ---------------------------------------------------------------------------

export interface PanelStatus {
  applicable: boolean;
  installed: boolean;
  dir?: string;
  installedVersion?: string;
  isDevSymlink: boolean;
  targetVersion: string;
  note: string;
}

/** status action — never throws. */
export async function panelStatus(
  deps: PanelInstallerDeps = defaultDeps,
): Promise<PanelStatus> {
  const detection = await detectPanelInstall(deps).catch(
    () =>
      ({ applicable: false, installed: false, isDevSymlink: false }) as PanelDetection,
  );

  let note: string;
  if (!detection.applicable) {
    note = !deps.isLocalMode()
      ? "Remote/cloud mode — panel install is managed on the ComfyUI host, not from here."
      : "Panel management is local-only; no local ComfyUI (COMFYUI_PATH) is configured.";
  } else if (detection.isDevSymlink) {
    note = "dev install (symlink) — managed manually; install/update/reinstall are refused.";
  } else if (!detection.installed) {
    note = `Not installed. Run install_panel(action='install') to add the panel (${PANEL_VERSION}). Restart ComfyUI afterwards.`;
  } else {
    note = `Installed${
      detection.version ? ` (${detection.version})` : ""
    }. Run install_panel(action='update') to pull the latest ${PANEL_VERSION}. Restart ComfyUI after updating.`;
  }

  return {
    applicable: detection.applicable,
    installed: detection.installed,
    dir: detection.dir,
    installedVersion: detection.version,
    isDevSymlink: detection.isDevSymlink,
    targetVersion: PANEL_VERSION,
    note,
  };
}

export interface PanelActionResult {
  action: "install" | "update" | "reinstall";
  result: NodeOpResult;
  restartRequired: true;
  message: string;
}

/**
 * install/update/reinstall the panel. LOCAL-only and refuses dev symlinks.
 * Targets version "nightly". Caller must RESTART ComfyUI to load the change.
 */
export async function runPanelAction(
  action: "install" | "update" | "reinstall",
  deps: PanelInstallerDeps = defaultDeps,
): Promise<PanelActionResult> {
  // P1b — truly LOCAL-only. Refuse in remote/cloud mode even when COMFYUI_PATH
  // is set: installCustomNode/reinstallCustomNode would queue Manager mutations
  // against the REMOTE host while our symlink guard inspected the LOCAL disk —
  // the wrong filesystem. The panel must be managed on the ComfyUI host itself.
  if (!deps.isLocalMode()) {
    throw new PanelInstallError(
      `Panel ${action} is local-only and is refused in remote/cloud mode ` +
        `(a remote COMFYUI_URL / Comfy Cloud is active). Install the panel on ` +
        `the ComfyUI host itself.`,
    );
  }
  if (!deps.comfyuiPath()) {
    throw new PanelInstallError(
      `Panel ${action} is local-only and requires a local ComfyUI install. ` +
        `Set COMFYUI_PATH (this is a no-op in remote/cloud mode).`,
    );
  }

  const detection = await detectPanelInstall(deps);
  if (detection.isDevSymlink) {
    throw new PanelInstallError(
      `Refusing to ${action} the panel: it is a dev install (symlink at ${detection.dir}) ` +
        `— managed manually. Update it via your repo/git instead.`,
    );
  }

  let result: NodeOpResult;
  if (action === "install") {
    result = await deps.install({ id: PANEL_REGISTRY_ID, version: PANEL_VERSION });
  } else if (action === "update") {
    result = await deps.update({ id: PANEL_REGISTRY_ID });
  } else {
    result = await deps.reinstall({ id: PANEL_REGISTRY_ID, version: PANEL_VERSION });
  }

  return {
    action,
    result,
    restartRequired: true,
    message:
      `Panel ${action} queued via ComfyUI-Manager (${PANEL_VERSION}). ` +
      `RESTART ComfyUI to load the ${action === "update" ? "updated" : "new"} panel node.`,
  };
}
