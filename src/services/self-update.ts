// Self-update for the comfyui-mcp npm package.
//
// On MCP server START we check the npm registry; if a newer version is
// published we auto-update the on-disk package, then tell the agent/user to
// RECONNECT — the running Node process cannot hot-swap its own code, so the new
// version only takes effect after the MCP client reconnects (/mcp) or the
// orchestrator restarts.
//
// This mirrors the SAFETY model of the panel on-load ensure
// (src/services/panel-installer.ts):
//   - NEVER mutate a dev install. `npm link` makes the package resolve to the
//     developer's working checkout; updating it would clobber their repo. We
//     detect that (install mode "linked") and refuse, exactly like the panel's
//     dev-junction guard.
//   - opt-out env COMFYUI_MCP_AUTOUPDATE=0/false/no/off disables auto-update.
//   - every probe + the npm spawn is hard-timed-out, captures+swallows errors,
//     and NEVER throws — it can be fired-and-forgotten from startup without ever
//     blocking or crashing the server.
//   - we NEVER kill/restart the running MCP process; we only surface a
//     "reconnect to load vX" note.

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../utils/logger.js";

/** npm package name — authoritative for the registry lookup and update command. */
export const PACKAGE_NAME = "comfyui-mcp";

/** Hard caps so nothing here can ever block startup. */
const REGISTRY_TIMEOUT_MS = 5_000;
const NPM_TIMEOUT_MS = 120_000;

export type InstallMode = "linked" | "global" | "npx" | "local" | "unknown";

export interface InstallInfo {
  mode: InstallMode;
  /** Resolved package root (the dir containing package.json). */
  packageDir: string;
  /** Version from the package's own package.json, if readable. */
  currentVersion: string | undefined;
  /** True for an `npm link` / run-from-checkout install — NEVER auto-update. */
  isDevLink: boolean;
  /** For a local project dependency: the project root to run `npm i` in. */
  projectRoot?: string;
}

export type SelfUpdateAction =
  | "updated"
  | "up-to-date"
  | "skipped-dev"
  | "skipped-disabled"
  | "notify"
  | "unavailable";

export interface SelfUpdateResult {
  action: SelfUpdateAction;
  mode: InstallMode;
  from?: string;
  to?: string;
  /** Human-facing note (reconnect instruction, reason, etc.). */
  note?: string;
}

// ---------------------------------------------------------------------------
// Injectable deps (mirrors panel-installer's pattern for clean unit tests)
// ---------------------------------------------------------------------------

export interface SelfUpdateDeps {
  /** Raw package root, derived from import.meta.url (pre-realpath). */
  packageDir: () => string;
  /** Process env (opt-out flag). */
  env: () => NodeJS.ProcessEnv;
  existsSync: (p: string) => boolean;
  /** True when `p` is a symlink/junction. Never throws. */
  isSymlink: (p: string) => boolean;
  /**
   * fs.realpathSync, used to resolve `npm link` symlinks. Returns `undefined`
   * when resolution FAILS — callers must safe-fail to "unknown" rather than
   * trust the raw (unresolved) path for an updatable classification. Never throws.
   */
  realpath: (p: string) => string | undefined;
  /** Read a UTF-8 file. May throw; callers guard. */
  readFile: (p: string) => string;
  /** Fetch the latest published version from the npm registry, or undefined. */
  getLatestVersion: () => Promise<string | undefined>;
  /**
   * Run an `npm` command (args are fixed constants — no user input).
   * Resolves { ok } and NEVER throws.
   */
  runNpm: (args: string[], cwd?: string) => Promise<{ ok: boolean }>;
}

function defaultPackageDir(): string {
  // dist/services/self-update.js → packageDir = dist/.. (the package root).
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..");
}

async function defaultGetLatestVersion(): Promise<string | undefined> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { version?: unknown };
    return typeof json.version === "string" ? json.version : undefined;
  } catch {
    return undefined;
  }
}

function defaultRunNpm(args: string[], cwd?: string): Promise<{ ok: boolean }> {
  return new Promise((resolveP) => {
    // `npm` is a .cmd shim on Windows; execFile needs shell:true to run it.
    // SAFE: every arg is a hard-coded constant (no interpolation of user input),
    // so there is no shell-injection surface.
    const isWin = process.platform === "win32";
    const cmd = isWin ? "npm.cmd" : "npm";
    try {
      const child = execFile(
        cmd,
        args,
        { cwd, timeout: NPM_TIMEOUT_MS, windowsHide: true, shell: isWin },
        (err) => resolveP({ ok: !err }),
      );
      child.on("error", () => resolveP({ ok: false }));
    } catch {
      resolveP({ ok: false });
    }
  });
}

export const defaultDeps: SelfUpdateDeps = {
  packageDir: defaultPackageDir,
  env: () => process.env,
  existsSync,
  isSymlink: (p) => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  },
  realpath: (p) => {
    try {
      return realpathSync(p);
    } catch {
      return undefined;
    }
  },
  readFile: (p) => readFileSync(p, "utf-8"),
  getLatestVersion: defaultGetLatestVersion,
  runNpm: defaultRunNpm,
};

// ---------------------------------------------------------------------------
// semver compare (major.minor.patch with a basic prerelease ordering)
// ---------------------------------------------------------------------------

/** Compare two semver strings. Returns 1 if a>b, -1 if a<b, 0 if equal/unparseable. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
    if (!m) return undefined;
    return {
      nums: [Number(m[1]), Number(m[2]), Number(m[3])] as const,
      pre: m[4] ?? "",
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] > pb.nums[i]) return 1;
    if (pa.nums[i] < pb.nums[i]) return -1;
  }
  // Equal core. A version WITHOUT a prerelease tag outranks one WITH it.
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1;
  if (pb.pre === "") return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

/** True when `latest` is strictly newer than `current`. */
export function isNewer(latest: string, current: string): boolean {
  return compareSemver(latest, current) > 0;
}

// ---------------------------------------------------------------------------
// Install-mode detection
// ---------------------------------------------------------------------------

function readVersion(deps: SelfUpdateDeps, dir: string): string | undefined {
  try {
    const pkg = JSON.parse(deps.readFile(join(dir, "package.json"))) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Split a path into segments, tolerant of mixed separators / Windows drives.
 * Empty segments are KEPT so a leading "/" (POSIX absolute root) survives
 * reconstruction (segs[0] === "" → rejoin yields "/home/...").
 */
function segmentsOf(p: string): string[] {
  return p.replace(/\\/g, "/").split("/");
}

/**
 * Classify how this package is installed by inspecting the resolved package dir:
 *   - linked  → `npm link` / run-from-checkout (NOT under node_modules, or the
 *     dir is itself a symlink). DEV install — never auto-update.
 *   - npx     → resolved inside an `_npx` cache dir (npx -y comfyui-mcp).
 *   - local   → under a project's node_modules; the OUTERMOST host dir with a
 *     package.json is the project root (correctly handles pnpm/yarn nested
 *     `node_modules/.pnpm/<pkg>/node_modules/<pkg>` virtual-store layouts).
 *   - global  → the canonical single-`node_modules` global layout (package sits
 *     directly inside node_modules, no project package.json above it).
 *   - unknown → couldn't classify confidently → caller MUST NOT auto-update.
 *
 * SAFE-FAIL: any uncertainty (realpath resolution failed, nested/ambiguous
 * virtual-store layout with no identifiable project root) returns "unknown"
 * (notify only) — NEVER "global". The dangerous wrong-direction failure is
 * classifying a local install as global and running `npm i -g` against it, so
 * the classifier only ever errs toward "unknown".
 *
 * Uses realpath to follow an `npm link` symlink to the developer's checkout, and
 * lstat to catch the --preserve-symlinks case where the dir is the symlink.
 */
export function detectInstallMode(deps: SelfUpdateDeps = defaultDeps): InstallInfo {
  let rawDir: string;
  try {
    rawDir = deps.packageDir();
  } catch {
    return { mode: "unknown", packageDir: "", currentVersion: undefined, isDevLink: false };
  }

  // --preserve-symlinks: the dir we run from is itself the link → dev link.
  const dirIsSymlink = deps.isSymlink(rawDir);
  // Default Node resolves symlinks for import.meta.url, so a linked package's
  // dir already points at the real checkout; realpath is a harmless no-op there.
  // `undefined` means resolution FAILED — we must not trust the raw path for an
  // updatable classification (safe-fail to "unknown" below).
  const resolved = deps.realpath(rawDir);
  const realpathFailed = resolved === undefined;
  const real = resolved ?? rawDir;
  const currentVersion = readVersion(deps, real) ?? readVersion(deps, rawDir);

  const segs = segmentsOf(real);
  const lower = segs.map((s) => s.toLowerCase());

  // npx cache (npm's `_npx` directory) — always notify-only, so realpath
  // uncertainty is harmless here.
  if (lower.includes("_npx")) {
    return { mode: "npx", packageDir: real, currentVersion, isDevLink: false };
  }

  // All `node_modules` segment indices (outermost → innermost).
  const nmIndices: number[] = [];
  for (let i = 0; i < lower.length; i++) {
    if (lower[i] === "node_modules") nmIndices.push(i);
  }

  if (dirIsSymlink || nmIndices.length === 0) {
    // Not under node_modules (or it's a raw symlink): a working checkout, i.e.
    // `npm link` / `npm run dev` / a git clone. DEV — never auto-update.
    return { mode: "linked", packageDir: real, currentVersion, isDevLink: true };
  }

  // Under node_modules but realpath FAILED → we can't trust the on-disk
  // location → safe-fail to unknown (notify only, never an update).
  if (realpathFailed) {
    return { mode: "unknown", packageDir: real, currentVersion, isDevLink: false };
  }

  // LOCAL: walk OUTWARD — the outermost node_modules whose containing dir has a
  // package.json is the real project root. This makes a pnpm/yarn nested path
  //   <proj>/node_modules/.pnpm/<pkg>@x/node_modules/<pkg>
  // resolve to <proj> (local), instead of the virtual-store folder (which has no
  // package.json and would otherwise be misread as a global prefix).
  for (const i of nmIndices) {
    const host = segs.slice(0, i).join("/") || "/";
    if (deps.existsSync(join(host, "package.json"))) {
      return { mode: "local", packageDir: real, currentVersion, isDevLink: false, projectRoot: host };
    }
  }

  // GLOBAL: only the canonical layout — a SINGLE node_modules with the package
  // sitting directly inside it (`<prefix>/.../node_modules/comfyui-mcp`) and no
  // project package.json above it (the npm prefix has none).
  const lastNm = nmIndices[nmIndices.length - 1];
  const packageIsDirectChild = lastNm === segs.length - 2;
  if (nmIndices.length === 1 && packageIsDirectChild) {
    return { mode: "global", packageDir: real, currentVersion, isDevLink: false };
  }

  // Ambiguous (nested/virtual-store layout with no identifiable project root)
  // → safe-fail to unknown. NEVER "global".
  return { mode: "unknown", packageDir: real, currentVersion, isDevLink: false };
}

/** Public, error-swallowing wrapper around the npm-registry probe. */
export async function getLatestPublishedVersion(
  deps: SelfUpdateDeps = defaultDeps,
): Promise<string | undefined> {
  try {
    return await deps.getLatestVersion();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Policy engine
// ---------------------------------------------------------------------------

function isAutoUpdateDisabled(env: NodeJS.ProcessEnv): boolean {
  const v = (env.COMFYUI_MCP_AUTOUPDATE ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

const RECONNECT_NOTE =
  "The running MCP server is still on the OLD code — RECONNECT (/mcp) or restart " +
  "the orchestrator to load the new version.";

/**
 * Build the `npm install` argv for a self-update. Every token is a CONSTANT —
 * no user/dynamic value is ever interpolated into the command (the Windows path
 * runs npm.cmd via shell:true, so injection-safety relies on this). `--no-audit
 * --no-fund` keep it non-interactive and cut extra network/output.
 */
function npmInstallArgs(mode: "global" | "local"): string[] {
  const base =
    mode === "global"
      ? ["i", "-g", `${PACKAGE_NAME}@latest`]
      : ["i", `${PACKAGE_NAME}@latest`];
  return [...base, "--no-audit", "--no-fund"];
}

export interface SelfUpdateOptions {
  deps?: SelfUpdateDeps;
}

async function checkInner(deps: SelfUpdateDeps): Promise<SelfUpdateResult> {
  const info = detectInstallMode(deps);

  // 1) DEV LINK — highest-priority safety guard. Never mutate a dev checkout,
  //    even if the user did not set the opt-out env.
  if (info.isDevLink || info.mode === "linked") {
    return {
      action: "skipped-dev",
      mode: info.mode,
      from: info.currentVersion,
      note: "Dev install (npm link / checkout) — self-update is disabled; update via git.",
    };
  }

  // 2) Opt-out.
  if (isAutoUpdateDisabled(deps.env())) {
    return {
      action: "skipped-disabled",
      mode: info.mode,
      from: info.currentVersion,
      note: "Self-update disabled via COMFYUI_MCP_AUTOUPDATE.",
    };
  }

  // 3) Registry probe.
  const latest = await deps.getLatestVersion();
  if (!latest) {
    return {
      action: "unavailable",
      mode: info.mode,
      from: info.currentVersion,
      note: "npm registry unreachable (offline or timed out).",
    };
  }

  // 4) Up to date (also covers an unreadable current version → don't churn).
  if (!info.currentVersion || !isNewer(latest, info.currentVersion)) {
    return {
      action: "up-to-date",
      mode: info.mode,
      from: info.currentVersion,
      to: latest,
    };
  }

  // 5) Newer available. Only global/local can be safely self-replaced on disk.
  if (info.mode === "global" || info.mode === "local") {
    const args = npmInstallArgs(info.mode);
    const { ok } = await deps.runNpm(args, info.mode === "local" ? info.projectRoot : undefined);
    if (!ok) {
      return {
        action: "unavailable",
        mode: info.mode,
        from: info.currentVersion,
        to: latest,
        note: `npm update to ${latest} failed; staying on ${info.currentVersion}.`,
      };
    }
    return {
      action: "updated",
      mode: info.mode,
      from: info.currentVersion,
      to: latest,
      note: `Updated ${PACKAGE_NAME} ${info.currentVersion} → ${latest}. ${RECONNECT_NOTE}`,
    };
  }

  // 6) npx / unknown — can't safely self-replace; notify only.
  const how =
    info.mode === "npx"
      ? "npx already fetches the latest on next run — restart to pick it up."
      : "Could not classify the install; update manually.";
  return {
    action: "notify",
    mode: info.mode,
    from: info.currentVersion,
    to: latest,
    note: `${PACKAGE_NAME} ${latest} is available (current ${info.currentVersion}). ${how}`,
  };
}

/**
 * The on-load policy engine. Detects install mode, checks the registry, and (for
 * global/local) self-updates on disk — then asks the user to RECONNECT. Swallows
 * every error and NEVER throws, so it can be fired-and-forgotten from startup.
 */
export async function checkAndSelfUpdate(
  opts: SelfUpdateOptions = {},
): Promise<SelfUpdateResult> {
  const deps = opts.deps ?? defaultDeps;
  try {
    return await checkInner(deps);
  } catch (err) {
    logger.debug("self-update: check failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    let mode: InstallMode = "unknown";
    try {
      mode = detectInstallMode(deps).mode;
    } catch {
      /* ignore */
    }
    return {
      action: "unavailable",
      mode,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Tool-facing status (never throws)
// ---------------------------------------------------------------------------

export interface SelfUpdateStatus {
  mode: InstallMode;
  packageDir: string;
  currentVersion: string | undefined;
  latestVersion: string | undefined;
  updateAvailable: boolean;
  isDevLink: boolean;
  autoUpdateDisabled: boolean;
  note: string;
}

/** status action — never throws. Reports mode + current vs latest + notes. */
export async function selfUpdateStatus(
  deps: SelfUpdateDeps = defaultDeps,
): Promise<SelfUpdateStatus> {
  let info: InstallInfo;
  try {
    info = detectInstallMode(deps);
  } catch {
    info = { mode: "unknown", packageDir: "", currentVersion: undefined, isDevLink: false };
  }
  const latest = await getLatestPublishedVersion(deps);
  const autoUpdateDisabled = isAutoUpdateDisabled(deps.env());
  const updateAvailable =
    !!latest && !!info.currentVersion && isNewer(latest, info.currentVersion);

  let note: string;
  if (info.isDevLink || info.mode === "linked") {
    note = "Dev install (npm link / checkout) — self-update is disabled; update via git.";
  } else if (!latest) {
    note = "npm registry unreachable; cannot determine the latest version.";
  } else if (!updateAvailable) {
    note = `Up to date (${info.currentVersion}).`;
  } else if (info.mode === "npx") {
    note = `${latest} available — npx fetches the latest on next run; restart to pick it up.`;
  } else if (info.mode === "unknown") {
    note = `${latest} available — could not classify install; update manually.`;
  } else {
    note =
      `${latest} available (current ${info.currentVersion}). ` +
      `Run self_update(action='update')${autoUpdateDisabled ? "" : " (or it auto-updates on start)"}. ${RECONNECT_NOTE}`;
  }

  return {
    mode: info.mode,
    packageDir: info.packageDir,
    currentVersion: info.currentVersion,
    latestVersion: latest,
    updateAvailable,
    isDevLink: info.isDevLink || info.mode === "linked",
    autoUpdateDisabled,
    note,
  };
}

export class SelfUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfUpdateError";
  }
}

/**
 * Explicit `update` action. Refuses on a dev link. Returns the same result shape
 * as the on-load check. Unlike the on-load path this IGNORES the opt-out env
 * (the user explicitly asked), but still never updates a dev link, npx, or
 * unknown install.
 */
export async function runSelfUpdate(
  deps: SelfUpdateDeps = defaultDeps,
): Promise<SelfUpdateResult> {
  const info = detectInstallMode(deps);
  if (info.isDevLink || info.mode === "linked") {
    throw new SelfUpdateError(
      "Refusing to self-update a dev install (npm link / checkout). Update via git instead.",
    );
  }

  const latest = await getLatestPublishedVersion(deps);
  if (!latest) {
    return {
      action: "unavailable",
      mode: info.mode,
      from: info.currentVersion,
      note: "npm registry unreachable (offline or timed out).",
    };
  }
  if (!info.currentVersion || !isNewer(latest, info.currentVersion)) {
    return { action: "up-to-date", mode: info.mode, from: info.currentVersion, to: latest };
  }
  if (info.mode === "global" || info.mode === "local") {
    const args = npmInstallArgs(info.mode);
    const { ok } = await deps.runNpm(args, info.mode === "local" ? info.projectRoot : undefined);
    return ok
      ? {
          action: "updated",
          mode: info.mode,
          from: info.currentVersion,
          to: latest,
          note: `Updated ${PACKAGE_NAME} ${info.currentVersion} → ${latest}. ${RECONNECT_NOTE}`,
        }
      : {
          action: "unavailable",
          mode: info.mode,
          from: info.currentVersion,
          to: latest,
          note: `npm update to ${latest} failed; staying on ${info.currentVersion}.`,
        };
  }
  // npx / unknown
  return {
    action: "notify",
    mode: info.mode,
    from: info.currentVersion,
    to: latest,
    note:
      info.mode === "npx"
        ? `${latest} available — npx fetches the latest on next run; restart to pick it up.`
        : `${latest} available — could not classify install; update manually.`,
  };
}
