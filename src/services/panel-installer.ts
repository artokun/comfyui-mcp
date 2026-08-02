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

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
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
import {
  describePanelPin,
  getPanelPinState,
  PANEL_PIN_ENV_VAR,
  type PanelPinState,
} from "./panel-settings.js";
import { withPanelMutationLock } from "./panel-pin-guard.js";
import { resolveEffectiveComfyUIBase } from "./workspace-env.js";

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

/** How long the fire-and-forget on-load ensure will wait for the panel op lock
 *  before giving up (well inside ENSURE_TIMEOUT_MS, so a lock held by another
 *  orchestrator process degrades to `unavailable` rather than a timeout). */
const ENSURE_LOCK_WAIT_MS = 3_000;

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
  /** Resolved local ComfyUI root, or undefined when no local workspace is known. */
  comfyuiPath: () => string | undefined;
  /** Process env (for the opt-out flag). */
  env: () => NodeJS.ProcessEnv;
  existsSync: (p: string) => boolean;
  /**
   * Tri-state REGULAR-FILE probe: true = a regular file exists at `p`, false =
   * confirmed not-a-servable-file (ENOENT, ENOTDIR, or it exists but is a
   * directory), undefined = could not determine (EACCES/EIO/…). Used to detect a
   * served web asset — only a regular file is served, and unlike existsSync
   * (which collapses every error to false), an indeterminate probe lets the
   * shadow scan fail closed instead of silently omitting a served copy. Never
   * throws.
   */
  probeFile: (p: string) => boolean | undefined;
  /** True when `p` is a symlink/junction (dev install). Never throws. */
  isSymlink: (p: string) => boolean;
  /**
   * Tri-state directory check (following symlinks): true = directory, false =
   * CONFIRMED non-directory (a regular file), undefined = COULD NOT DETERMINE
   * (stat error). Callers must only SKIP an entry on an explicit `false`; an
   * undefined must be treated as a possible directory (fail closed). Never throws.
   */
  isDirectory: (p: string) => boolean | undefined;
  /**
   * Canonical physical path of `p` (resolves symlinks + the real on-disk case),
   * or undefined if it can't be resolved. Used to decide whether two entries are
   * the SAME directory independent of case-sensitivity quirks. Never throws.
   */
  realPath: (p: string) => string | undefined;
  readdir: (p: string) => string[];
  readFile: (p: string) => string;
  /**
   * Resolve the git commit sha the pack dir's checkout is currently at (HEAD),
   * or undefined if it isn't a git checkout / can't be resolved. Used to detect
   * a `nightly` (git-HEAD) update that advanced the COMMIT without bumping the
   * pyproject version string. Never throws.
   */
  gitRevision: (dir: string) => string | undefined;
  /**
   * The user's explicit panel-version pin, if any. While a pin is in force NO
   * code path here may move the panel — install/update/reinstall refuse and the
   * on-load ensure skips. Never throws (an unreadable pin reports
   * `indeterminate`, which counts as pinned).
   */
  readPin: () => PanelPinState;
  /** Is the target ComfyUI reachable right now? Never throws. */
  isReachable: () => Promise<boolean>;
  install: (opts: { id: string; version?: string }) => Promise<NodeOpResult>;
  update: (opts: { id: string }) => Promise<NodeOpResult>;
  reinstall: (opts: { id: string; version?: string }) => Promise<NodeOpResult>;
}

/**
 * Resolve the current commit sha of a git checkout at `dir` by reading its
 * `.git` metadata directly (no subprocess). Handles a normal `.git/` dir, a
 * `.git` FILE pointer (worktrees/submodules: `gitdir: <path>`), a symbolic HEAD
 * (`ref: refs/heads/<branch>`) resolved via loose refs then `packed-refs`, and a
 * detached HEAD (raw sha). Returns undefined and NEVER throws on any failure.
 */
export function resolveGitRevision(dir: string): string | undefined {
  const read = (p: string): string | undefined => {
    try {
      return readFileSync(p, "utf-8");
    } catch {
      return undefined;
    }
  };
  try {
    let base = join(dir, ".git");
    let st;
    try {
      st = lstatSync(base);
    } catch {
      return undefined;
    }
    if (st.isFile()) {
      const pointer = (read(base) ?? "").trim();
      const m = pointer.match(/^gitdir:\s*(.+)$/);
      if (!m) return undefined;
      base = isAbsolute(m[1]) ? m[1] : join(dir, m[1]);
    }
    const head = (read(join(base, "HEAD")) ?? "").trim();
    if (!head) return undefined;
    const refM = head.match(/^ref:\s*(.+)$/);
    if (!refM) {
      // Detached HEAD → the sha is inline.
      // A FULL SHA-1 (40) or SHA-256 (64) object id — never a truncated value.
      return /^([0-9a-f]{40}|[0-9a-f]{64})$/i.test(head) ? head : undefined;
    }
    const refPath = refM[1].trim();
    // A resolved ref value must be a real commit sha — never return transient or
    // symbolic content (e.g. "ref: ...", "updating") that would look like a
    // spurious HEAD move and fabricate a successful update.
    const asSha = (v: string | undefined): string | undefined => {
      const t = (v ?? "").trim();
      // FULL SHA-1 (40) or SHA-256 (64) only — reject truncated/abbreviated ids.
      return /^([0-9a-f]{40}|[0-9a-f]{64})$/i.test(t) ? t : undefined;
    };
    // A linked worktree keeps HEAD in its per-worktree gitdir but the shared refs
    // (loose + packed-refs) in `commondir`. Search the gitdir first, then it.
    const searchDirs = [base];
    const commondir = (read(join(base, "commondir")) ?? "").trim();
    if (commondir) {
      searchDirs.push(isAbsolute(commondir) ? commondir : join(base, commondir));
    }
    for (const d of searchDirs) {
      const loose = asSha(read(join(d, refPath)));
      if (loose) return loose;
      const packed = read(join(d, "packed-refs"));
      if (packed) {
        for (const line of packed.split(/\r?\n/)) {
          if (!line || line.startsWith("#") || line.startsWith("^")) continue;
          const sp = line.indexOf(" ");
          if (sp <= 0) continue;
          if (line.slice(sp + 1).trim() === refPath) {
            const sha = asSha(line.slice(0, sp));
            if (sha) return sha;
          }
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export const defaultDeps: PanelInstallerDeps = {
  isLocalMode: () => isLocalMode(),
  // Keep panel management aligned with get_environment, downloads, and
  // comfy-cli: an explicit COMFYUI_PATH wins, then a saved default workspace
  // is a valid local install when this target is not remote (#700).
  comfyuiPath: () => resolveEffectiveComfyUIBase(),
  env: () => process.env,
  existsSync,
  probeFile: (p) => {
    try {
      return statSync(p).isFile(); // true = regular file, false = exists but a dir
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      // ENOENT/ENOTDIR = confirmed no servable file here; else indeterminate.
      return code === "ENOENT" || code === "ENOTDIR" ? false : undefined;
    }
  },
  isSymlink: (p) => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  },
  isDirectory: (p) => {
    try {
      // statSync follows symlinks: a dir symlink IS web-served, so it counts.
      return statSync(p).isDirectory();
    } catch {
      // Could not determine — return undefined so the caller fails closed rather
      // than treating a served backup as a skippable "file".
      return undefined;
    }
  },
  realPath: (p) => {
    try {
      // .native returns the real on-disk case on Windows/macOS.
      return realpathSync.native(p);
    } catch {
      return undefined;
    }
  },
  readdir: (p) => readdirSync(p),
  readFile: (p) => readFileSync(p, "utf-8"),
  gitRevision: (dir) => resolveGitRevision(dir),
  readPin: () => getPanelPinState(),
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
// Version pin
//
// A pin is the user's explicit "hold the panel here". Every mutating path in
// this file consults it FIRST and refuses while it is in force — the on-load
// ensure, install, update and reinstall alike. The escape hatch is to clear the
// pin (install_panel(action='unpin'), or COMFYUI_MCP_PANEL_PIN=off), never for
// us to decide the pin was probably fine to ignore.
// ---------------------------------------------------------------------------

/**
 * Read the pin so that NO failure mode reads as "unpinned". A reader that throws
 * is reported as an indeterminate pin, which counts as pinned: silently moving a
 * user off a pin we merely failed to read is the exact bug this guards.
 */
function readPinSafe(deps: PanelInstallerDeps): PanelPinState {
  try {
    return deps.readPin();
  } catch (err) {
    logger.warn(
      `[panel] could not read the panel version pin: ${
        err instanceof Error ? err.message : String(err)
      } — treating the panel as PINNED (refusing to move it).`,
    );
    return { pinned: true, source: "settings", indeterminate: true };
  }
}

/*
 * Serializes every panel MUTATION (the on-load ensure and each
 * install/update/reinstall). Two overlapping panel ops would each read the
 * other's half-applied disk state, and the #639 "did it move?" proof compares a
 * pre-image against a post-image — interleave them and both comparisons are
 * meaningless. One at a time makes each op's before/after its own.
 *
 * It also closes the pin race: the final pin check (assertNotPinned, immediately
 * before the Manager call) and the call itself sit inside this critical section,
 * so a pin cannot be written in between — by this process OR another one.
 */
/**
 * Exported so PIN WRITES take the same lock. Without that, a pin could be
 * committed after an in-flight update passed its final pin check but before the
 * Manager actually touched disk — the update would then land on a now-pinned
 * install and report success. Serializing both means a pin either lands before
 * an op starts (and blocks it) or after it finishes (and blocks the next one);
 * it never slices one in half.
 *
 * The underlying lock is a FILE, not module state: running more than one
 * orchestrator process (one per MCP client) is ordinary here, and two processes
 * do not share a promise chain. See panel-pin-guard.ts.
 */
export function withPanelOpLock<T>(
  fn: () => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  return withPanelMutationLock(fn, opts);
}

/** The refusal a pin produces for a mutating action, with the way out. */
function pinRefusalMessage(action: string, pin: PanelPinState): string {
  return (
    `Refusing to ${action} the panel: it is ${describePanelPin(pin)}. ` +
    `A pin is honoured even when a newer panel exists — clear it first with ` +
    `install_panel(action='unpin')` +
    (pin.source === "env"
      ? ` (this pin comes from the ${PANEL_PIN_ENV_VAR} environment variable, so ` +
        `it must be unset/changed in the environment — unpin cannot remove it)`
      : ``) +
    `, then re-run the ${action}.`
  );
}

/**
 * Throw if a pin is in force. Called BOTH on entry (fail fast with a good
 * message before any work) and again immediately before the ComfyUI-Manager
 * call inside the op lock — detection can take a while, and a pin set during
 * that window must still be honoured.
 */
function assertNotPinned(action: string, deps: PanelInstallerDeps): void {
  const pin = readPinSafe(deps);
  if (pin.pinned) throw new PanelInstallError(pinRefusalMessage(action, pin));
}

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
  /**
   * Current git commit sha of the matched dir's checkout (if it is one). Lets an
   * `update` detect a `nightly` git-HEAD advance that did NOT bump the version
   * string, and prove a genuine no-change (identical pre/post sha).
   */
  gitRev?: string;
  /** The matched dir is a symlink/junction → dev install, manage manually. */
  isDevSymlink: boolean;
  /**
   * False when the pre-op inspection was INCONCLUSIVE — the custom_nodes
   * enumeration failed, OR a candidate's pyproject existed but could not be
   * read/parsed (it might be the panel we failed to read). A `installed: false`
   * verdict is then NOT a proven absence, so action paths must not treat it as a
   * fresh-install (absent→present) baseline — that would fabricate success.
   */
  scanReliable?: boolean;
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
      return {
        applicable: true,
        installed: true,
        dir,
        version,
        gitRev: deps.gitRevision(dir),
        isDevSymlink: true,
      };
    }
  }

  // Candidate dirs: fast-path names first, then any other subdir.
  const candidates: string[] = FAST_PATH_DIRS.map((n) => join(customNodes, n));
  let scanReliable = true;
  if (deps.existsSync(customNodes)) {
    let entries: string[] = [];
    try {
      entries = deps.readdir(customNodes);
    } catch {
      // Enumeration FAILED — a "not installed" verdict from here is unreliable.
      entries = [];
      scanReliable = false;
    }
    for (const e of entries) {
      const full = join(customNodes, e);
      if (!candidates.includes(full)) candidates.push(full);
    }
  }

  for (const dir of candidates) {
    // Never resolve a backup/copy-shaped dir (e.g. ".comfyui-agent-panel.bak-*")
    // as the canonical install — it is a shadow, handled by findPanelShadows
    // (#641). The FAST_PATH canonical names are never backup-shaped.
    if (looksLikePanelBackupName(basename(dir))) continue;
    const pyproject = join(dir, "pyproject.toml");
    if (!deps.existsSync(pyproject)) continue;
    let parsed: { projectName?: string; version?: string };
    try {
      parsed = parsePyproject(deps.readFile(pyproject));
    } catch {
      // A candidate pyproject EXISTS but could not be read/parsed — this dir
      // MIGHT be the panel we failed to read. A resulting "not installed" verdict
      // is therefore NOT conclusive: mark the scan unreliable so callers don't
      // treat it as a proven absence (which would fabricate an absent→present
      // install). Read reliability is folded into scanReliable.
      scanReliable = false;
      continue;
    }
    if (parsed.projectName === PANEL_REGISTRY_ID) {
      return {
        applicable: true,
        installed: true,
        dir,
        version: parsed.version,
        gitRev: deps.gitRevision(dir),
        isDevSymlink: deps.isSymlink(dir),
        scanReliable,
      };
    }
  }

  return { applicable: true, installed: false, isDevSymlink: false, scanReliable };
}

// ---------------------------------------------------------------------------
// Shadow detection (#641)
//
// ComfyUI serves EVERY directory under custom_nodes as a web extension —
// INCLUDING dot-prefixed ones (the Python node loader skips dotdirs, but the web
// server does NOT). So a leftover backup like `.comfyui-agent-panel.bak-0.11.28`
// is served live at /extensions/.comfyui-agent-panel.bak-0.11.28/... and, because
// "." sorts before "c", can WIN registration and shadow the real panel. The disk
// pyproject of the canonical dir then reads the new version while the browser
// keeps loading the old one — a silent fabricated-success just like the #639
// no-op. We scan custom_nodes for ANY panel-serving dir other than the canonical
// install and fail closed when one exists.
// ---------------------------------------------------------------------------

export interface PanelShadow {
  /** custom_nodes subdir name (e.g. ".comfyui-agent-panel.bak-0.11.28"). */
  name: string;
  /** Version read from its pyproject, if any. */
  version?: string;
}

/**
 * EXACT (case-sensitive) canonical panel dir basename. Used only to avoid
 * flagging the real install when no canonical dir was resolved; a case-VARIANT
 * (e.g. "ComfyUI-MCP-Panel" on a case-sensitive volume) is NOT exempted here —
 * it is content-checked like any other dir so a distinct serving copy is caught.
 */
function isExactCanonicalPanelName(name: string): boolean {
  return (FAST_PATH_DIRS as readonly string[]).includes(name);
}

/**
 * Whether two paths are the SAME on-disk directory, by PHYSICAL identity:
 * realpath resolves symlinks + the real filesystem case, which is authoritative
 * regardless of case-sensitivity. On a case-INSENSITIVE volume "ComfyUI-MCP-Panel"
 * and "comfyui-mcp-panel" resolve to the same real path (one dir → exempt the
 * canonical); on a case-SENSITIVE volume (Linux, or a case-sensitive APFS/macOS
 * volume) they resolve to DISTINCT real paths (two dirs → never exempt the
 * shadow). When realpath cannot resolve EITHER side, physical identity is
 * unknown, so we FAIL CLOSED and exempt only an EXACT string match — never
 * case-fold a possibly-distinct directory into the canonical.
 */
function samePathCI(
  a: string | undefined,
  b: string | undefined,
  deps: PanelInstallerDeps,
): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const ra = deps.realPath(a);
  const rb = deps.realPath(b);
  if (ra && rb) return ra === rb; // authoritative physical identity
  // realpath unavailable → can't prove identity → only exact-equal is "same".
  return false;
}

/**
 * The remainder (after the canonical base) of a panel BACKUP name: only
 * separators / digits / dots may precede the FIRST backup marker, which is
 * either "~" or a whole-word backup keyword. Descriptive text AFTER the marker is
 * allowed (e.g. "-backup-2026-final", "~snapshot"); a non-backup word BEFORE the
 * marker ("-tools-old", "-holder-backup") means it is a backup of a DIFFERENT
 * (sibling) node, not the panel, so it must NOT match.
 */
const PANEL_BACKUP_REST =
  /^[._\-0-9]*(?:~|(?:bak|backup|old|copy|orig|save|prev|previous)(?![a-z]))/i;

/**
 * A dir NAME that looks like a leftover copy/backup OF THE PANEL — the shadowing
 * trap from #641. The name must START WITH a canonical panel base name (after an
 * optional leading dot) and then be EITHER exactly that name while hidden (a
 * dot-prefixed copy of the real panel) OR a panel-backup suffix (see
 * PANEL_BACKUP_REST). Copies that dropped their name are caught by the CONTENT
 * signal instead.
 */
export function looksLikePanelBackupName(name: string): boolean {
  const hidden = name.startsWith(".");
  const core = (hidden ? name.slice(1) : name).toLowerCase();
  const base = (FAST_PATH_DIRS as readonly string[]).find(
    (n) => core === n || core.startsWith(n),
  );
  if (!base) return false;
  const rest = core.slice(base.length);
  // Exactly a canonical name: a HIDDEN copy (".comfyui-agent-panel") shadows the
  // real panel; a plain "comfyui-agent-panel" IS the real install (not a backup).
  if (rest === "") return hidden;
  return PANEL_BACKUP_REST.test(rest);
}

/**
 * Web-extension asset paths ComfyUI serves for the panel. A custom_nodes dir that
 * contains ANY of these is served as the panel's frontend (at /extensions/<dir>/…)
 * and therefore shadows the canonical install regardless of its dir name or
 * pyproject — this is the #641 CONTENT signal, spelling-independent.
 */
const PANEL_WEB_MARKERS = [
  ["web", "js", "comfyui-mcp-panel.js"],
  ["web", "img", "comfyui-mcp-wordmark.svg"],
] as const;

/**
 * Tri-state: does `dir` serve the panel's web-extension assets? true = a marker
 * is present, false = all markers CONFIRMED absent, undefined = a probe FAILED
 * (indeterminate). Callers must treat undefined as a POSSIBLE shadow (fail
 * closed), never as "no assets". Never throws.
 */
function servesPanelWebAssets(
  dir: string,
  deps: PanelInstallerDeps,
): boolean | undefined {
  let probeFailed = false;
  for (const seg of PANEL_WEB_MARKERS) {
    const r = deps.probeFile(join(dir, ...seg));
    if (r === true) return true;
    if (r === undefined) probeFailed = true; // indeterminate — can't confirm absent
  }
  return probeFailed ? undefined : false;
}

/**
 * Find panel-serving dirs under custom_nodes that would SHADOW the canonical
 * install — any dir (other than the true canonical) that ComfyUI would SERVE as
 * the panel's web extension. Detection is CONTENT-first (the dir serves the
 * panel's web assets → spelling-independent), plus a cheap name heuristic and an
 * exact pyproject-name match. FAILS CLOSED on uncertainty: a served copy whose
 * pyproject is unreadable/absent is still flagged (as a possible shadow with no
 * version), never silently omitted. LOCAL-only.
 *
 * THROWS if custom_nodes exists but cannot be enumerated: shadow inspection is
 * then INDETERMINATE and the ACTION paths must fail closed rather than assume
 * "no shadow". (panelStatus wraps this and stays non-throwing.)
 */
export function findPanelShadows(
  canonicalDir: string | undefined,
  deps: PanelInstallerDeps = defaultDeps,
): PanelShadow[] {
  const comfyPath = deps.comfyuiPath();
  if (!deps.isLocalMode() || !comfyPath) return [];
  const customNodes = join(comfyPath, "custom_nodes");

  // Enumerate custom_nodes. A missing dir (ENOENT) legitimately means "no
  // shadows"; ANY other failure (EACCES/EIO/…) is INDETERMINATE — NOT swallowed,
  // so the action paths fail closed rather than assume "no shadows".
  let entries: string[];
  try {
    entries = deps.readdir(customNodes);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }

  const shadows: PanelShadow[] = [];
  for (const name of entries) {
    const dir = join(customNodes, name);
    // ComfyUI serves DIRECTORIES as web extensions — a regular FILE that happens
    // to share the name is not served and must not block actions. Skip ONLY on a
    // CONFIRMED non-directory; an undefined (stat error) is indeterminate and
    // must NOT omit a possible served backup → fail closed by continuing to check.
    if (deps.isDirectory(dir) === false) continue;
    // PHYSICAL IDENTITY FIRST: a symlink/junction/alias that resolves to the
    // canonical dir serves the SAME (updated) assets → it is NOT a shadow, even
    // if its NAME is backup-shaped (e.g. ".comfyui-agent-panel.bak" ->
    // comfyui-mcp-panel). realpath-unavailable falls back to exact-string only.
    if (samePathCI(dir, canonicalDir, deps)) continue;
    // With no canonical resolved, don't flag a dir whose name is EXACTLY a
    // canonical basename (it is most likely the real install). Case-variant or
    // backup-shaped names are still content-checked below — never exempted here.
    if (!canonicalDir && isExactCanonicalPanelName(name)) continue;
    const isBackup = looksLikePanelBackupName(name);

    // CONTENT signal: does this dir serve the panel's web assets? If so it is a
    // shadow no matter how it is named or whether its pyproject is readable. An
    // INDETERMINATE probe (undefined) is treated as a possible shadow (fail
    // closed) — only a CONFIRMED-absent (false) clears the content signal.
    const servesPanel = servesPanelWebAssets(dir, deps) !== false;

    let isPanelCopy = isBackup || servesPanel;
    let version: string | undefined;
    const pyproject = join(dir, "pyproject.toml");
    if (deps.existsSync(pyproject)) {
      try {
        const parsed = parsePyproject(deps.readFile(pyproject));
        if (parsed.projectName === PANEL_REGISTRY_ID) {
          isPanelCopy = true;
          version = parsed.version;
        }
        // else: pyproject readable but a different name. If it still SERVES panel
        // assets (isPanelCopy) it remains a shadow with an unknown panel version.
      } catch {
        // FAIL CLOSED: unreadable pyproject does NOT clear a content/name signal.
        // A served copy we cannot identify is a POSSIBLE shadow, not "no shadow".
      }
    }
    if (isPanelCopy) shadows.push({ name, version });
  }
  return shadows;
}

/** Fail closed when a shadowing panel dir exists (used by install/update/reinstall). */
function assertNoPanelShadow(
  action: string,
  canonicalDir: string | undefined,
  deps: PanelInstallerDeps,
): void {
  let shadows: PanelShadow[];
  try {
    shadows = findPanelShadows(canonicalDir, deps);
  } catch (err) {
    // Indeterminate: we could not enumerate custom_nodes, so we CANNOT rule out a
    // shadowing backup. Fail closed rather than fabricate success.
    throw new PanelInstallError(
      `Panel ${action} cannot be confirmed: unable to inspect custom_nodes for ` +
        `shadowing panel copies (${err instanceof Error ? err.message : String(err)}). ` +
        `A leftover backup dir there could shadow the real panel in the browser ` +
        `(#641). NOT reporting success — check custom_nodes for stray panel copies ` +
        `(especially dot-prefixed ".comfyui-agent-panel.bak-*"), then retry.`,
    );
  }
  if (shadows.length === 0) return;
  const names = shadows
    .map(
      (s) =>
        `"${s.name}"${s.version ? ` (${s.version})` : " (identity could not be verified)"}`,
    )
    .join(", ");
  throw new PanelInstallError(
    `Panel ${action} cannot be confirmed: a SHADOW copy of the panel exists in ` +
      `custom_nodes — ${names}. ComfyUI serves EVERY dir under custom_nodes as a web ` +
      `extension (including dot-prefixed ones the node loader hides), and such a ` +
      `copy can WIN registration by sort order (e.g. ".comfyui-agent-panel.bak-*" ` +
      `sorts before "comfyui-agent-panel"), so the BROWSER may keep loading the old ` +
      `panel even though the real dir on disk is up to date (#641). NOT reporting ` +
      `success. Remove or MOVE the offending dir OUT of custom_nodes (e.g. to a temp ` +
      `folder) — or, if its identity could not be verified, make its pyproject.toml ` +
      `readable so it can be identified — then hard-refresh the ComfyUI tab. A ` +
      `backup belongs anywhere EXCEPT under custom_nodes.`,
  );
}

/**
 * Non-throwing shadow describe for the fire-and-forget on-load ensure. Returns a
 * human warning when a shadow exists OR the inspection was indeterminate, else
 * undefined. (The explicit tool paths use the throwing assertNoPanelShadow.)
 */
function describePanelShadow(
  canonicalDir: string | undefined,
  deps: PanelInstallerDeps,
): string | undefined {
  let shadows: PanelShadow[];
  try {
    shadows = findPanelShadows(canonicalDir, deps);
  } catch (err) {
    return (
      `could not inspect custom_nodes for shadowing panel copies ` +
      `(${err instanceof Error ? err.message : String(err)}) — a stray ` +
      `".comfyui-agent-panel.bak-*" there could shadow the panel in the browser (#641)`
    );
  }
  if (shadows.length === 0) return undefined;
  const names = shadows.map((s) => `"${s.name}"`).join(", ");
  return (
    `${shadows.length} shadow copy/copies in custom_nodes (${names}) are ALSO ` +
    `web-served and can win registration by sort order — the browser may load the ` +
    `OLD panel. Move them OUT of custom_nodes, then hard-refresh the ComfyUI tab (#641)`
  );
}

// ---------------------------------------------------------------------------
// On-load ensure (install-if-missing only)
// ---------------------------------------------------------------------------

export type EnsureAction =
  | "installed"
  | "up-to-date"
  | "skipped-dev"
  | "skipped"
  | "shadowed" // installed/present, but a #641 shadow copy will win in the browser
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

/**
 * The explicit opt-out applies to every unattended panel mutation. A user who
 * disables on-load installation must not get an automatic version sync later
 * merely because a desktop tab says hello.
 */
export function isPanelAutoInstallDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
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
  if (isPanelAutoInstallDisabled(deps.env())) {
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

  // An explicit pin outranks auto-install: installing the `nightly` channel over
  // a pinned version is exactly the silent move the pin forbids. Skip and say so.
  const pin = readPinSafe(deps);
  if (pin.pinned) {
    return {
      action: "skipped",
      reason: `panel version pin in force — ${describePanelPin(pin)}`,
    };
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
    // #639 — if the pre-op enumeration FAILED, "not installed" is unreliable: a
    // pre-existing panel in a non-fast-path dir may have been missed. Installing
    // blind risks a duplicate (shadow), and we could not honestly claim a fresh
    // install, so skip and report unavailable rather than fabricate "installed".
    if (detection.scanReliable === false) {
      return {
        action: "unavailable",
        reason:
          "Could not enumerate custom_nodes to confirm the panel is missing; " +
          "skipping auto-install to avoid a duplicate/unverified install.",
      };
    }
    // Final pin check adjacent to the mutation (see runPanelActionInner): the
    // reachability probe and detection above are not instantaneous.
    const latePin = readPinSafe(deps);
    if (latePin.pinned) {
      return {
        action: "skipped",
        reason: `panel version pin in force — ${describePanelPin(latePin)}`,
      };
    }
    await deps.install({ id: PANEL_REGISTRY_ID, version: PANEL_VERSION });
    // #639 — VERIFY it actually landed (fresh re-read); never log "installed"
    // from the Manager result alone (a stale 3.x no-op drains the queue trivially).
    const post = await detectPanelInstall(deps);
    const landed = post.installed && !!post.version;
    // #641 — report a shadow FIRST: a served backup copy explains a wrong panel in
    // the browser whether or not the canonical install landed this run.
    const shadow = describePanelShadow(post.dir, deps);
    if (shadow) {
      return {
        action: "shadowed",
        reason: landed
          ? `Installed ${PANEL_REGISTRY_ID} (${post.version}) but ${shadow}.`
          : `Panel auto-install could not be verified on disk (likely a stale ` +
            `ComfyUI-Manager no-op, #639/#424), AND ${shadow}`,
        dir: post.dir,
        installedVersion: post.version,
        restartRequired: landed ? true : undefined,
      };
    }
    if (!landed) {
      return {
        action: "unavailable",
        reason:
          `Panel auto-install could not be verified on disk — ComfyUI-Manager ` +
          `reported the queue drained but the pack is not present. Likely a stale ` +
          `ComfyUI-Manager 3.x no-op (#639/#424). Install the panel from source or ` +
          `update ComfyUI-Manager, then restart ComfyUI.`,
      };
    }
    return {
      action: "installed",
      reason: `Installed ${PANEL_REGISTRY_ID} (${post.version}).`,
      dir: post.dir,
      installedVersion: post.version,
      restartRequired: true,
    };
  }

  // Present already. We never diff nightly on load (no clean version), so we
  // leave it untouched — the explicit `update` action refreshes on demand. But a
  // #641 shadow copy still mis-serves the panel, so surface it if present.
  const shadow = describePanelShadow(detection.dir, deps);
  if (shadow) {
    return {
      action: "shadowed",
      reason: shadow,
      dir: detection.dir,
      installedVersion: detection.version,
    };
  }
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
    // Serialized with the explicit actions: the on-load ensure must not race an
    // install_panel call the user fired at the same moment. Its lock wait is
    // SHORT — this is fire-and-forget at startup, so if another process holds
    // the lock we give up quickly (returning `unavailable`) rather than eating
    // the whole ensure budget waiting.
    return await withTimeout(
      withPanelOpLock(() => ensureInner(deps), { timeoutMs: ENSURE_LOCK_WAIT_MS }),
      opts.timeoutMs ?? ENSURE_TIMEOUT_MS,
    );
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
  /**
   * #641 — other panel-serving dirs under custom_nodes that SHADOW the real
   * install in the browser (e.g. a ".comfyui-agent-panel.bak-*" backup). When
   * non-empty, the SERVED panel may not match `installedVersion` on disk.
   */
  shadows: PanelShadow[];
  /**
   * #641 — the shadow scan could NOT be completed (custom_nodes was not
   * enumerable). `shadows: []` then means "we did not find any" rather than
   * "there are none", so callers must not read the empty array as an all-clear.
   * Structural, not just prose in `note`: a consumer branching on
   * `shadows.length` would otherwise treat an indeterminate scan as safe.
   */
  shadowInspectFailed?: boolean;
  /**
   * The user's explicit version pin. While `pin.pinned` is true, install/update/
   * reinstall refuse and the on-load ensure skips — see the pin guard above.
   */
  pin: PanelPinState;
  /**
   * #639 — the custom_nodes enumeration itself FAILED, so `installed: false` is
   * unreliable: a pre-existing panel may have been missed, and installing blind
   * risks a duplicate (or clobbering a NEWER one). Consumers must not treat an
   * unreliable "absent" as an install invitation.
   */
  scanReliable?: boolean;
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

  let shadows: PanelShadow[] = [];
  let shadowInspectFailed = false;
  if (detection.applicable) {
    try {
      shadows = findPanelShadows(detection.dir, deps);
    } catch {
      shadowInspectFailed = true;
    }
  }
  const shadowNote = shadowInspectFailed
    ? ` NOTE (#641): could not enumerate custom_nodes to check for shadowing panel ` +
      `backups — a stray ".comfyui-agent-panel.bak-*" there could shadow the real ` +
      `panel in the browser. Check manually.`
    : shadows.length > 0
      ? ` WARNING (#641): ${shadows.length} shadow copy/copies in custom_nodes (${shadows
          .map((s) => `"${s.name}"`)
          .join(", ")}) are ALSO served as web extensions and may shadow the real ` +
        `panel in the browser (dot-prefixed dirs win by sort order). Remove/move ` +
        `them OUT of custom_nodes, then hard-refresh the ComfyUI tab.`
      : "";

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

  const pin = readPinSafe(deps);
  const pinNote = pin.pinned
    ? ` PIN: ${describePanelPin(pin)} — install/update/reinstall are refused ` +
      `until it is cleared with install_panel(action='unpin')` +
      (pin.source === "env" ? ` (env pins must be unset in the environment).` : `.`)
    : "";

  return {
    applicable: detection.applicable,
    installed: detection.installed,
    dir: detection.dir,
    installedVersion: detection.version,
    isDevSymlink: detection.isDevSymlink,
    targetVersion: PANEL_VERSION,
    shadows,
    shadowInspectFailed,
    scanReliable: detection.scanReliable,
    pin,
    note: note + shadowNote + pinNote,
  };
}

/**
 * Read the panel status for a caller-selected LOCAL ComfyUI root.
 *
 * `apply_manifest` may adopt a saved/default/live root for one call while
 * `config.comfyuiPath` remains unset. Verifying through the ordinary default
 * status in that case would inspect no directory (or a different one) and turn
 * a Manager queue result into fabricated panel success. This narrow adapter
 * keeps the status scan — including #641's served-shadow check — on the same
 * root the manifest install targeted without mutating process-global config.
 */
export function panelStatusAt(comfyuiPath: string): Promise<PanelStatus> {
  return panelStatus({
    ...defaultDeps,
    isLocalMode: () => true,
    comfyuiPath: () => comfyuiPath,
  });
}

export interface PanelActionResult {
  action: "install" | "update" | "reinstall";
  result: NodeOpResult;
  restartRequired: boolean;
  message: string;
  /** update only — installed version read from disk BEFORE the op (if known). */
  previousVersion?: string;
  /** update only — installed version RE-READ from disk AFTER the op (if known). */
  installedVersion?: string;
}

// ---------------------------------------------------------------------------
// Update verification (#639)
//
// ComfyUI-Manager reports its queue "drained" as soon as done_count >= total_count
// (see runManagerQueue). A stale/legacy Manager 3.x returns total_count:0 with a
// non-zero done_count — the drain check passes TRIVIALLY (2 >= 0) while nothing is
// ever enqueued, so the pack on disk is untouched. Trusting that signal as proof
// of work is the silent fabricate-success bug (#639, same root cause as #424).
//
// The fix: after an `update`, RE-READ the installed identity fresh from disk (the
// pyproject version AND the git-HEAD sha) and require PROVEN movement to claim
// success. Nothing moved → fail closed. Never trust the Manager counts as proof
// of work (they are queue-wide, not task-correlated); they only sharpen the
// failure diagnostic. Shadow copies (#641) are checked separately.
// ---------------------------------------------------------------------------

interface QueueCounts {
  total?: number;
  done?: number;
  inProgress?: number;
  pending?: number;
  processing?: boolean;
}

/**
 * Best-effort extraction of ComfyUI-Manager queue counts from a NodeOpResult's
 * raw `details`. Returns `{}` when `details` isn't a manager-http queue status
 * object (e.g. the cm-cli path returns a string). Never throws.
 */
export function readQueueCounts(details: unknown): QueueCounts {
  if (!details || typeof details !== "object") return {};
  const d = details as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return {
    total: num(d.total_count),
    done: num(d.done_count),
    inProgress: num(d.in_progress_count),
    pending: num(d.pending_count),
    processing: typeof d.is_processing === "boolean" ? (d.is_processing as boolean) : undefined,
  };
}

/**
 * The stale ComfyUI-Manager 3.x silent no-op signature: the queue "drained" but
 * the requested task was never really run. Either nothing was ever enqueued
 * (total_count:0 — the drain check `done >= total` passes trivially) or the
 * counts are incoherent (done > total, impossible in a real queue). These are
 * NEVER produced by a task that actually executed, so they are a safe FAILURE
 * signal (used only to fail closed / sharpen diagnostics, never to claim work).
 */
export function looksLikeManagerNoOp(details: unknown): boolean {
  const c = readQueueCounts(details);
  const nothingEnqueued = c.total === 0;
  const incoherent =
    c.total !== undefined && c.done !== undefined && c.done > c.total;
  return nothingEnqueued || incoherent;
}

export type UpdateOutcome =
  | "updated" // version OR git-HEAD moved on disk → the update definitely applied.
  | "no-op" // nothing moved AND Manager shows the stale-3.x no-op signature.
  | "unverified"; // nothing provably moved / can't read post identity — fail closed.

export interface UpdateVerdict {
  outcome: UpdateOutcome;
  previousVersion?: string;
  installedVersion?: string;
  previousRev?: string;
  installedRev?: string;
  counts: QueueCounts;
}

export interface PanelUpdateIdentity {
  previousVersion?: string;
  installedVersion?: string;
  previousRev?: string;
  installedRev?: string;
}

/**
 * Decide whether an `update` actually advanced the panel on disk. Heart of the
 * #639 fix.
 *
 * SUCCESS REQUIRES PROVEN MOVEMENT. We compare the pre/post ON-DISK identity —
 * the pyproject version AND the git-HEAD commit sha (post RE-READ fresh from
 * disk, never cached) — and only report `updated` when one of them actually
 * MOVED. The panel tracks the `nightly` (git-HEAD) channel, so a commit can
 * advance WITHOUT a version bump; a moved sha therefore also counts as updated.
 *
 * Crucially, an UNCHANGED local git-HEAD is NOT proof of being current: it only
 * proves nothing was pulled locally — which is exactly the #639 no-op. Local
 * HEAD says nothing about the upstream tip, so we never treat "HEAD unchanged"
 * as success. When nothing moved we fail closed: `no-op` when the Manager counts
 * show the stale-3.x signature (total_count:0, or the incoherent done>total), and
 * `unverified` otherwise. The queue counts are queue-WIDE drain counters (not
 * correlated to this task), so they are used ONLY to sharpen the FAILURE
 * diagnostic — NEVER as positive proof that work happened.
 */
export function classifyPanelUpdate(
  identity: PanelUpdateIdentity,
  details: unknown,
): UpdateVerdict {
  const { previousVersion, installedVersion, previousRev, installedRev } = identity;
  const counts = readQueueCounts(details);
  const base = { ...identity, counts };

  // Can't read ANY post-update identity → cannot confirm anything landed.
  if (!installedVersion && !installedRev) {
    return { ...base, outcome: "unverified" };
  }

  // Something moved on disk (version bump OR git-HEAD advance) → update applied.
  const versionMoved =
    !!previousVersion && !!installedVersion && installedVersion !== previousVersion;
  const revMoved = !!previousRev && !!installedRev && installedRev !== previousRev;
  if (versionMoved || revMoved) return { ...base, outcome: "updated" };

  // Nothing provably moved. Use the Manager counts ONLY to name the failure:
  // the stale-3.x no-op signature → the reported no-op; otherwise we simply
  // couldn't confirm.
  if (looksLikeManagerNoOp(details)) return { ...base, outcome: "no-op" };

  return { ...base, outcome: "unverified" };
}

/** Turn an update verdict into an honest result — or throw when it did not apply. */
function finalizeUpdate(
  verdict: UpdateVerdict,
  post: PanelDetection,
  result: NodeOpResult,
): PanelActionResult {
  const { outcome, previousVersion, installedVersion, counts } = verdict;
  const dirNote = post.dir ? ` at ${post.dir}` : "";

  if (outcome === "updated") {
    const from = verdict.previousVersion ?? verdict.previousRev?.slice(0, 8) ?? "?";
    const to = verdict.installedVersion ?? verdict.installedRev?.slice(0, 8) ?? "?";
    return {
      action: "update",
      result,
      restartRequired: true,
      message:
        `Panel updated (${from} → ${to}) via ComfyUI-Manager (${PANEL_VERSION}). ` +
        `RESTART ComfyUI to load the updated panel node.`,
      previousVersion,
      installedVersion,
    };
  }

  // Nothing provably moved → NEVER report success. An unchanged local git-HEAD /
  // version cannot distinguish "already at the upstream tip" from "the update
  // silently no-op'd", so we fail closed with an honest, actionable diagnostic.
  if (outcome === "no-op") {
    throw new PanelInstallError(
      `Panel update did NOT apply: nothing changed on disk${dirNote} (installed ` +
        `version still ${previousVersion ?? "unknown"}) after ComfyUI-Manager ` +
        `reported the queue drained. Manager reported done_count=` +
        `${counts.done ?? "?"} with total_count=${counts.total ?? "?"} — it never ` +
        `actually enqueued the update. This is the stale ComfyUI-Manager 3.x silent ` +
        `no-op (#639, same root cause as #424). Fix: update ComfyUI-Manager on the ` +
        `host (git pull in custom_nodes/ComfyUI-Manager, or pip install -U ` +
        `comfyui_manager) and retry, or reinstall the panel from source (git pull ` +
        `the panel dir / reinstall the pack), then RESTART ComfyUI.`,
    );
  }

  // unverified — no proof it advanced, and no clear no-op signature either.
  throw new PanelInstallError(
    `Could not verify the panel update applied: the installed version ` +
      `(${installedVersion ?? "unreadable"}) and git-HEAD did not change` +
      `${dirNote} after ComfyUI-Manager reported the queue drained. NOT reporting ` +
      `success — an unchanged checkout can't prove you are at the latest nightly ` +
      `versus a silent no-op. You may already be current; otherwise ComfyUI-Manager ` +
      `may be stale (#424). RESTART ComfyUI and re-check the version, or reinstall ` +
      `the panel from source.`,
  );
}

export interface PanelActionOptions {
  /**
   * Target version for install/reinstall, defaulting to the `nightly` channel.
   *
   * Exists so a caller that asked for a SPECIFIC version — e.g.
   * `install_custom_node(id="comfyui-agent-panel", version="0.11.20")`, which is
   * redirected here to get the verified path — actually gets the version it
   * asked for. Redirecting and silently substituting `nightly` would do
   * something other than what the caller requested while reporting success.
   * (`update` has no version to honour; it always pulls the channel tip.)
   */
  version?: string;
}

/**
 * install/update/reinstall the panel. LOCAL-only and refuses dev symlinks.
 * Targets the "nightly" channel unless a version is given. Caller must RESTART
 * ComfyUI to load the change.
 */
export function runPanelAction(
  action: "install" | "update" | "reinstall",
  deps: PanelInstallerDeps = defaultDeps,
  opts: PanelActionOptions = {},
): Promise<PanelActionResult> {
  // Serialized: never let two panel mutations interleave (see withPanelOpLock).
  return withPanelOpLock(() => runPanelActionInner(action, deps, opts));
}

export async function runPanelActionInner(
  action: "install" | "update" | "reinstall",
  deps: PanelInstallerDeps,
  opts: PanelActionOptions = {},
): Promise<PanelActionResult> {
  const targetVersion = opts.version?.trim() || PANEL_VERSION;
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

  // PIN GUARD — before any Manager mutation is queued. This is the single choke
  // point that makes "we never move a pinned user" true for every caller (the
  // sync skill, the panel, a hand-written install_panel call), not just the ones
  // that remembered to check. It is re-checked once more immediately before the
  // Manager call, since detection below is not instantaneous.
  assertNotPinned(action, deps);

  const detection = await detectPanelInstall(deps);
  if (detection.isDevSymlink) {
    throw new PanelInstallError(
      `Refusing to ${action} the panel: it is a dev install (symlink at ${detection.dir}) ` +
        `— managed manually. Update it via your repo/git instead.`,
    );
  }

  // Capture the on-disk identity BEFORE the op (from the guard detection we just
  // did — read fresh, not cached elsewhere).
  const wasPresent = detection.installed;
  const previousVersion = detection.version;
  const previousRev = detection.gitRev;

  if (action === "update") {
    // Final pin check, inside the op lock and adjacent to the mutation: a pin
    // set while detection was running must still be honoured.
    assertNotPinned(action, deps);
    const result = await deps.update({ id: PANEL_REGISTRY_ID });
    // #639 — VERIFY the update actually advanced the pack. Re-read the installed
    // identity FRESH from disk (never trust Manager's queue-drained signal, nor
    // any value captured before the op), then classify honestly.
    const post = await detectPanelInstall(deps);
    // #641 — a shadowing copy makes the SERVED panel differ from post.version, so
    // even a real version advance is a fabricated success. Fail closed first.
    assertNoPanelShadow(action, post.dir, deps);
    // #639 req — the installed VERSION must be readable post-update, else we
    // cannot verify the applied version (fail closed; never trust a HEAD move
    // alone when the pyproject version can't be read).
    if (!post.installed || !post.version) {
      throw new PanelInstallError(
        `Could not verify the panel update applied: the pack is ${
          post.installed ? "present but its version is unreadable" : "not present"
        } after ComfyUI-Manager reported the queue drained. NOT reporting success. ` +
          `Re-check the pack and retry, or reinstall the panel from source, then ` +
          `RESTART ComfyUI.`,
      );
    }
    const verdict = classifyPanelUpdate(
      {
        previousVersion,
        installedVersion: post.version,
        previousRev,
        installedRev: post.gitRev,
      },
      result.details,
    );
    return finalizeUpdate(verdict, post, result);
  }

  // install / reinstall. Same final pin check as the update path above.
  assertNotPinned(action, deps);
  const result =
    action === "install"
      ? await deps.install({ id: PANEL_REGISTRY_ID, version: targetVersion })
      : await deps.reinstall({ id: PANEL_REGISTRY_ID, version: targetVersion });

  // #639 — VERIFY the pack afterward. installCustomNode verifies presence
  // downstream (#232), but reinstallCustomNode does NOT — it returns as soon as
  // the Manager queue drains, which the stale 3.x no-op passes trivially. Re-read
  // fresh from disk here so BOTH paths fail closed rather than fabricate success.
  const post = await detectPanelInstall(deps);
  // #641 — fail closed on a shadow FIRST: a served backup copy is the more
  // actionable diagnostic (it explains a wrong panel in the browser) and is named
  // with its specific remedy, even when the canonical install itself did not land.
  assertNoPanelShadow(action, post.dir, deps);
  if (!post.installed || !post.version) {
    throw new PanelInstallError(
      `Panel ${action} did NOT land: the pack is ${
        post.installed ? "present but its version is unreadable" : "not present"
      } in custom_nodes after ComfyUI-Manager reported the queue drained. This is ` +
        `the stale ComfyUI-Manager 3.x silent no-op (#639, same root cause as #424): ` +
        `NOT reporting success. Fix: update ComfyUI-Manager on the host (git pull in ` +
        `custom_nodes/ComfyUI-Manager, or pip install -U comfyui_manager) and retry, ` +
        `or install the panel from source, then RESTART ComfyUI.`,
    );
  }

  // SUCCESS REQUIRES PROVEN CHANGE (mirrors the update path): the pack went from
  // ABSENT→present (fresh install landed), or its version/git-HEAD moved. Proven
  // disk movement is checked FIRST — the ComfyUI-Manager queue counts are
  // queue-WIDE (not task-correlated), so they must NEVER veto a change the disk
  // already proves.
  const versionMoved =
    !!previousVersion && !!post.version && post.version !== previousVersion;
  const revMoved =
    !!previousRev && !!post.gitRev && post.gitRev !== previousRev;
  // Only a RELIABLE pre-op scan may establish absent→present. If the pre-op
  // enumeration failed (indeterminate), a "was absent" baseline is untrustworthy
  // — a pre-existing panel in a non-fast-path dir could have been missed — so we
  // do NOT infer a fresh install from it (that would fabricate success).
  const reliablyAbsent = !wasPresent && detection.scanReliable !== false;
  const changed = reliablyAbsent || versionMoved || revMoved;

  if (!changed) {
    // Nothing provably changed. Use the stale-3.x no-op count signature ONLY here
    // (not as a veto above) to sharpen the failure diagnostic.
    if (looksLikeManagerNoOp(result.details)) {
      const c = readQueueCounts(result.details);
      throw new PanelInstallError(
        `Panel ${action} did NOT execute: ComfyUI-Manager reported the queue ` +
          `drained without actually enqueuing the task (total_count=` +
          `${c.total ?? "?"}, done_count=${c.done ?? "?"}), so the pack on disk ` +
          `(${PANEL_REGISTRY_ID} ${post.version}) is unchanged — likely a stale ` +
          `pre-existing copy. This is the stale ComfyUI-Manager 3.x silent no-op ` +
          `(#639, same root cause as #424): NOT reporting success. Fix: update ` +
          `ComfyUI-Manager on the host (git pull in custom_nodes/ComfyUI-Manager, ` +
          `or pip install -U comfyui_manager) and retry, or install the panel from ` +
          `source, then RESTART ComfyUI.`,
      );
    }
    throw new PanelInstallError(
      `Panel ${action} did NOT change anything on disk: the pack is still ` +
        `${PANEL_REGISTRY_ID} ${post.version} (git-HEAD unchanged) after ` +
        `ComfyUI-Manager reported the queue drained. NOT reporting success — an ` +
        `unchanged checkout can't prove the ${action} actually executed versus a ` +
        `silent no-op (stale ComfyUI-Manager 3.x, #424). If you meant to refresh or ` +
        `upgrade, update ComfyUI-Manager on the host and retry, use ` +
        `install_panel(action='update'), or install the panel from source, then ` +
        `RESTART ComfyUI.`,
    );
  }

  return {
    action,
    result,
    restartRequired: true,
    message:
      `Panel ${action} applied via ComfyUI-Manager: pack ${
        wasPresent ? "advanced to" : "installed on disk at"
      } ${PANEL_REGISTRY_ID} ${post.version}. RESTART ComfyUI to load the panel node.`,
    previousVersion,
    installedVersion: post.version,
  };
}
