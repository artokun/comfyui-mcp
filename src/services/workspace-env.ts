import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, resolve as pathResolve, sep } from "node:path";
import { promisify } from "node:util";
import { config, getComfyUIBaseUrl, isRemoteMode } from "../config.js";
import { getSystemStats } from "../comfyui/client.js";
import { resolveLiveInterpreter } from "./live-interpreter.js";
import { logger } from "../utils/logger.js";
import { ValidationError } from "../utils/errors.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Workspace config persistence (mirrors comfy-cli set-default / which)
// ---------------------------------------------------------------------------

interface WorkspaceConfig {
  defaultWorkspace?: string;
}

/**
 * Resolve the path to the workspace config JSON file.
 * Uses XDG_CONFIG_HOME when set, otherwise ~/.config/comfyui-mcp/workspace.json.
 */
function defaultWorkspaceConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const root = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(root, "comfyui-mcp", "workspace.json");
}

// Module-level override hook so tests can point at a temp file. Defaults to the
// platform config path lazily (so env changes in tests are picked up before set).
let configPathOverride: string | undefined;

export function configureWorkspace(opts: { configPath?: string }): void {
  configPathOverride = opts.configPath;
}

export function resetWorkspaceConfig(): void {
  configPathOverride = undefined;
}

// Whether THIS MCP process launched the connected LOCAL ComfyUI during this session
// via a python `spawn` (which inherits process.env). When true, the running server
// shares our environment, so it is safe to expand `$VAR`/`${VAR}`/`%VAR%` in its live
// extra_model_paths config against process.env. A server we did NOT launch (separately
// started, possibly with a DIFFERENT env, or a Desktop-app launch whose env we don't
// share) must NOT have its config vars expanded against our env — that could authorize
// a wrong-place download destination (#633 P1b). Set ONLY on the env-inheriting python
// spawn path, cleared on stop; module-scoped, so it resets each MCP process lifetime.
//
// This flag is ENV-TRUST ONLY. The interpreter we launched with is recorded in
// live-interpreter.ts (recordLaunchedInterpreter) — the ONE launch record, trusted
// only after PID + creation-time identity validation. A second, unvalidated record
// here was the stale-record hazard: our child dies, another server takes the port
// under the same install root, and pip/update work would have been directed into the
// OLD interpreter while claiming to be exact (#401 re-gate).
let localComfyUILaunchedByUs = false;

/** Record that this MCP process spawned the local ComfyUI (env inherited). */
export function markLocalComfyUILaunched(): void {
  localComfyUILaunchedByUs = true;
}

/** Clear the launched-by-us flag (on stop, and a test seam). */
export function resetLocalComfyUILaunchState(): void {
  localComfyUILaunchedByUs = false;
}

/** True when this MCP process launched the connected local ComfyUI (shares our env). */
export function didLaunchLocalComfyUI(): boolean {
  return localComfyUILaunchedByUs;
}

function workspaceConfigPath(): string {
  return configPathOverride ?? defaultWorkspaceConfigPath();
}

/**
 * Synchronous read of the saved default workspace (set via workspace action:"set_default").
 * Mirrors readWorkspaceConfig()'s validation but is sync, so sync filesystem-path
 * resolvers (e.g. model-resolver.getModelsRoot) can consult the saved default
 * workspace without going async — this is what lets local downloads / model
 * lookups work when COMFYUI_PATH isn't set but a default workspace is saved.
 * Returns undefined when unset, invalid, or unreadable.
 */
export function getSavedDefaultWorkspaceSync(): string | undefined {
  const path = workspaceConfigPath();
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const dw = (parsed as Record<string, unknown>).defaultWorkspace;
    if (typeof dw === "string" && dw.trim().length > 0) return dw;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * QUESTION 1 — "where is a ComfyUI install on THIS machine?"
 *
 * Answers only that. It says nothing about whether the current session is pointed at
 * that install, and callers must not read it as though it did.
 *
 *   1. config.comfyuiPath — COMFYUI_PATH env or auto-detection (wins).
 *   2. the saved DEFAULT WORKSPACE (workspace action:"set_default").
 *
 * Use this ONLY where the operation is about the local machine as such and the caller
 * has established the session mode itself (panel installation is the real example: the
 * panel lives in the local install, and its callers gate on `isLocalMode()` first).
 */
export function resolveLocalWorkspaceBase(): string | undefined {
  return config.comfyuiPath ?? getSavedDefaultWorkspaceSync();
}

/**
 * QUESTION 2 — "which install does THIS OPERATION act on?"
 *
 * The single source of truth for every filesystem-backed tool (download_model,
 * node_pack (action:"verify"), model lookups, extra-paths, comfy-cli, apply_manifest's
 * adoption). Returns undefined whenever the session is NOT pointed at a local install,
 * because then no directory on this machine is the thing being operated on.
 *
 * The two questions used to share one answer, and that is #490: this function returned
 * `config.comfyuiPath` BEFORE looking at the mode, so a remote `--comfyui-url` session
 * with a stale local COMFYUI_PATH — the ordinary local configuration — was handed that
 * unrelated local install as "the target". Its own docstring promised the opposite. A
 * read-only caller got a wrong answer about the wrong tree; `comfy-cli uninstall` and
 * named-snapshot save DELETED FROM and WROTE INTO an install nobody had asked about,
 * while their replies talked only about the remote server. That is the #369 harm class,
 * and it survived being closed once because the comment claimed the guarantee the code
 * did not implement.
 *
 * SCOPE, stated precisely because an overclaiming comment is how this survived being
 * closed once: this refuses in REMOTE (`--comfyui-url`) mode. It does NOT refuse in
 * CLOUD mode (`isCloudMode()`, an API key), where the serving ComfyUI is equally not
 * this machine and the same wrong-install hazard exists in principle. That variant is
 * unfixed here and is not claimed to be fixed. Cloud is diverted at the client layer
 * (`comfyui/client.ts`) rather than at this resolver, so it is a different seam and
 * wants its own change; `isLocalMode()` is the check it would use.
 *
 * Returns undefined when no usable local target exists — callers then either detect a
 * live server base dir (/system_stats) or emit a clear, actionable error. They must not
 * substitute a local path of their own; doing so re-creates the bug one level up.
 */
export function resolveEffectiveComfyUIBase(): string | undefined {
  if (isRemoteMode()) return undefined;
  return resolveLocalWorkspaceBase();
}

/**
 * The install root a LOCAL, DESTRUCTIVE operation may act on — or the reason it
 * must not act at all.
 *
 * This began as a workaround for #490: `resolveEffectiveComfyUIBase()` used to
 * return `config.comfyuiPath` BEFORE consulting remote mode, so with
 * `--comfyui-url` and a stale local `COMFYUI_PATH` it handed back an install with
 * nothing to do with the connected server. Reading through that is survivable;
 * DELETING through it is not.
 *
 * That resolver is now fixed (it checks remote mode first), so this is no longer
 * the only thing standing between a destructive path and the wrong tree. It stays
 * because it answers a question `undefined` cannot: WHY there is no target. A
 * caller that must refuse needs to tell the user whether the install is missing or
 * merely unreachable from here, and those have different remedies.
 */
export function resolveLocalMutationTarget():
  | { base: string; refusal?: undefined }
  | { base?: undefined; refusal: string } {
  if (isRemoteMode()) {
    return {
      refusal:
        "this session targets a REMOTE ComfyUI (--comfyui-url), so there is no local " +
        "install this operation can safely modify. " +
        (config.comfyuiPath
          ? `COMFYUI_PATH is set to ${config.comfyuiPath}, but that is a DIFFERENT install ` +
            `from the server you are connected to — acting on it would modify something ` +
            `you are not looking at, while the checks around it describe the remote server. `
          : "") +
        "Run this against the machine the install lives on.",
    };
  }
  const base = resolveEffectiveComfyUIBase();
  if (!base) {
    return {
      refusal:
        "no local ComfyUI install path could be established: COMFYUI_PATH is unset and no " +
        "default workspace is saved (set one with the workspace tool, action 'set_default').",
    };
  }
  return { base };
}

/**
 * The LIVE connected server's own install root, derived from its /system_stats
 * launch argv (the `main.py` path — see liveRootFromArgv). This is the ComfyUI
 * that is ACTUALLY running, so it is the source of truth for where a download /
 * node install must land — even when COMFYUI_PATH is unset, OR points at a
 * DIFFERENT, stale install than the connected one (#490/#463). Returns undefined
 * in remote mode (the live root is a path on the REMOTE host, not usable as a
 * local target), when the server is unreachable, or when argv yields no
 * resolvable absolute root. Best-effort and NEVER throws.
 */
export async function resolveLiveComfyUIBase(): Promise<string | undefined> {
  if (isRemoteMode()) return undefined;
  try {
    const stats = await getSystemStats();
    return liveRootFromArgv(
      stats.system?.argv,
      (stats.system as { cwd?: string })?.cwd,
    );
  } catch {
    return undefined;
  }
}

/**
 * ONE `/system_stats` snapshot for callers that need to derive several things from the
 * SAME server state (the launch flags AND the install root), rather than issuing two
 * calls that could straddle a restart — the same invariant `resolveModelsDirWithBases`
 * keeps for the download destination. `reachable: false` covers remote mode (the server's
 * paths are on another host) and any failure. Never throws.
 */
export async function getLiveServerSnapshot(): Promise<{
  reachable: boolean;
  argv?: string[];
  cwd?: string;
}> {
  if (isRemoteMode()) return { reachable: false };
  try {
    const stats = await getSystemStats();
    return {
      reachable: true,
      argv: stats.system?.argv,
      cwd: (stats.system as { cwd?: string })?.cwd,
    };
  } catch {
    return { reachable: false };
  }
}

async function readWorkspaceConfig(): Promise<WorkspaceConfig> {
  const path = workspaceConfigPath();
  if (!existsSync(path)) return {};
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      logger.warn("Workspace config is not a JSON object, ignoring", { path });
      return {};
    }
    // Validate the shape rather than blindly casting: defaultWorkspace must be a
    // non-empty string when present, else it is dropped.
    const cfg: WorkspaceConfig = {};
    const dw = (parsed as Record<string, unknown>).defaultWorkspace;
    if (typeof dw === "string" && dw.trim().length > 0) {
      cfg.defaultWorkspace = dw;
    } else if (dw !== undefined) {
      logger.warn("Ignoring invalid defaultWorkspace in workspace config", {
        path,
        type: typeof dw,
      });
    }
    return cfg;
  } catch (err) {
    logger.warn("Failed to parse workspace config, ignoring", {
      path,
      error: err instanceof Error ? err.message : err,
    });
    return {};
  }
}

async function writeWorkspaceConfig(cfg: WorkspaceConfig): Promise<void> {
  const path = workspaceConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cfg, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// ComfyUI install auto-detection
// (mirrors detectComfyUIPaths logic in src/config.ts — kept local because that
//  helper is not exported and config.ts is owned by another unit)
// ---------------------------------------------------------------------------

/**
 * Auto-detect ComfyUI installation directories. Checks common locations on
 * macOS, Linux, and Windows. Returns all found paths, most-preferred first.
 */
export function detectComfyUIInstalls(): string[] {
  const home = homedir();
  const candidates: string[] = [];

  // macOS: ComfyUI Desktop app stores data here
  candidates.push(join(home, "Documents", "ComfyUI"));
  // macOS: Application Support
  candidates.push(join(home, "Library", "Application Support", "ComfyUI"));
  // Common manual install locations
  candidates.push(join(home, "ComfyUI"));
  candidates.push(join(home, "code", "ComfyUI"));
  candidates.push(join(home, "projects", "ComfyUI"));
  candidates.push(join(home, "src", "ComfyUI"));
  // Linux common paths
  candidates.push("/opt/ComfyUI");
  candidates.push(join(home, ".local", "share", "ComfyUI"));
  // Windows common paths
  candidates.push(join(home, "AppData", "Local", "ComfyUI"));
  candidates.push(join(home, "Desktop", "ComfyUI"));
  // Windows: ComfyUI Desktop app installs here
  candidates.push(
    join(home, "AppData", "Local", "Programs", "ComfyUI", "resources", "ComfyUI"),
  );

  // Scan ~/Documents and ~/My Documents for any ComfyUI-named directories
  const documentsDirs = [join(home, "Documents"), join(home, "My Documents")];
  for (const dir of documentsDirs) {
    try {
      if (!existsSync(dir)) continue;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.toLowerCase().includes("comfyui")) {
          const fullPath = join(dir, entry.name);
          if (!candidates.includes(fullPath)) candidates.push(fullPath);
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  return candidates.filter((p) => {
    if (!existsSync(p)) return false;
    if (!p.includes("Documents")) return true;
    return existsSync(join(p, "models")) || existsSync(join(p, "custom_nodes"));
  });
}

// ---------------------------------------------------------------------------
// workspace action:"get" — mirrors comfy-cli which
// ---------------------------------------------------------------------------

export interface WorkspaceInfo {
  workspace_path?: string;
  workspace_source:
    | "env"
    | "auto-detected"
    | "default-config"
    /**
     * #769 — derived from the RUNNING ComfyUI's own launch argv, because
     * nothing was configured. Not persisted: reported so `workspace(get)` stops
     * contradicting `install_comfyui (action:"environment")`, which has always surfaced this path.
     */
    | "live-server"
    | "none";
  default_workspace?: string;
  api_target: string;
  /**
   * #769 — true when `workspace_path` came from the live server rather than
   * configuration. Persist it with workspace(action='set_default') if you want
   * it to survive a restart.
   */
  transient?: boolean;
}

export async function getWorkspace(): Promise<WorkspaceInfo> {
  const cfg = await readWorkspaceConfig();
  const apiTarget = getComfyUIBaseUrl();

  let source: WorkspaceInfo["workspace_source"];
  if (config.comfyuiPath) {
    // config.comfyuiPath is COMFYUI_PATH env or auto-detection
    source = process.env.COMFYUI_PATH ? "env" : "auto-detected";
  } else if (cfg.defaultWorkspace) {
    source = "default-config";
  } else {
    source = "none";
  }

  const configuredPath = config.comfyuiPath ?? cfg.defaultWorkspace;
  // #769 — `install_comfyui (action:"environment")` has always reported the live server's own install
  // root as the local workspace, resolved from the process it is talking to.
  // Reporting "none" here for the SAME machine was a straight contradiction,
  // and it sent users hunting for a misconfiguration that did not exist. Only
  // fills a GAP: a configured workspace still wins and is never overridden.
  if (!configuredPath) {
    const liveRoot = await resolveLiveComfyUIBase();
    if (liveRoot) {
      return {
        workspace_path: liveRoot,
        workspace_source: "live-server",
        default_workspace: cfg.defaultWorkspace,
        api_target: apiTarget,
        transient: true,
      };
    }
  }

  return {
    workspace_path: configuredPath,
    workspace_source: source,
    default_workspace: cfg.defaultWorkspace,
    api_target: apiTarget,
  };
}

// ---------------------------------------------------------------------------
// workspace action:"set_default" — mirrors comfy-cli set-default
// ---------------------------------------------------------------------------

export interface SetDefaultResult {
  saved: boolean;
  default_workspace: string;
  config_path: string;
  exists: boolean;
}

export async function setDefaultWorkspace(
  path: string,
): Promise<SetDefaultResult> {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("Workspace path must be a non-empty string.");
  }

  const cfg = await readWorkspaceConfig();
  cfg.defaultWorkspace = trimmed;
  await writeWorkspaceConfig(cfg);

  return {
    saved: true,
    default_workspace: trimmed,
    config_path: workspaceConfigPath(),
    exists: existsSync(trimmed),
  };
}

// ---------------------------------------------------------------------------
// workspace action:"list" — auto-detected installs + active + saved default
// ---------------------------------------------------------------------------

export interface WorkspaceListEntry {
  path: string;
  active: boolean;
  is_default: boolean;
  looks_valid: boolean;
}

export interface WorkspaceList {
  active_workspace?: string;
  default_workspace?: string;
  workspaces: WorkspaceListEntry[];
}

export async function listWorkspaces(): Promise<WorkspaceList> {
  const cfg = await readWorkspaceConfig();
  const detected = detectComfyUIInstalls();

  // Merge detected installs with active path and saved default so the caller
  // sees a complete picture even if one isn't in the detection list.
  const paths = new Set<string>(detected);
  if (config.comfyuiPath) paths.add(config.comfyuiPath);
  if (cfg.defaultWorkspace) paths.add(cfg.defaultWorkspace);
  // #769 — the install we are ACTUALLY connected to belongs in the list, even
  // when it sits somewhere `detectComfyUIInstalls`'s well-known-locations scan
  // never looks. Returning an empty list for a machine with a running ComfyUI
  // is the same contradiction `workspace(get)` had.
  const liveRoot = await resolveLiveComfyUIBase();
  if (liveRoot) paths.add(liveRoot);

  const workspaces: WorkspaceListEntry[] = [...paths].map((p) => ({
    path: p,
    active: p === config.comfyuiPath,
    is_default: p === cfg.defaultWorkspace,
    looks_valid:
      existsSync(join(p, "models")) || existsSync(join(p, "custom_nodes")),
  }));

  return {
    active_workspace: config.comfyuiPath,
    default_workspace: cfg.defaultWorkspace,
    workspaces,
  };
}

// ---------------------------------------------------------------------------
// install_comfyui (action:"environment") — mirrors comfy-cli env
// ---------------------------------------------------------------------------

const IS_WIN = platform() === "win32";

/** Run a command quietly; return trimmed stdout or undefined on any failure. */
async function probe(
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts?.cwd,
      timeout: 8000,
      windowsHide: true,
    });
    const out = (stdout || stderr || "").trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The launch SCRIPT token of a server argv: a POSITIONAL argument — one appearing BEFORE
 * the first `-`/`--` option token — that ends in `main.py`/`main.pyw`, with surrounding
 * quotes stripped. Python's `sys.argv[0]` is the script, so a main.py-shaped token that
 * appears only AFTER an option is that option's value or a later argument, never the
 * launch script: on a main-less `python -m comfyui … --extra-model-paths-config
 * /host/main.py` launch the CONFIG value would otherwise be accepted as the script and
 * self-prove the server's locality, letting a same-spelled host file be read/written
 * (#648 review). Returns the unquoted token, or undefined when argv has no positional
 * script (scanning stops at the first option token).
 */
function scriptTokenFromArgv(argv: string[] | undefined): string | undefined {
  if (!Array.isArray(argv)) return undefined;
  for (const rawArg of argv) {
    if (typeof rawArg !== "string") continue;
    // Strip surrounding quotes a launcher may leave on the path.
    const a = rawArg.trim().replace(/^["']+/, "").replace(/["']+$/, "");
    if (a.startsWith("-")) return undefined; // options begin — no positional script beyond
    // Must actually END in main.py / main.pyw (boundary guards against notmain.py).
    if (/(^|[\\/])main\.pyw?$/i.test(a)) return a;
  }
  return undefined;
}

/**
 * Derive the ABSOLUTE directory that holds the running server's `main.py` from its
 * `/system_stats` argv (Python's `sys.argv`, whose argv[0] is the script path). This
 * is the LIVE running instance's install root — the source of truth for which python
 * is actually running ComfyUI (#401 / PR #433 review). Robust against the argv shapes
 * codex flagged: surrounding quotes are stripped; only a POSITIONAL token before the
 * first option counts as the script — never a flag's VALUE (scriptTokenFromArgv,
 * #648 review); a RELATIVE `ComfyUI/main.py` or a bare `main.py` is resolved against
 * the server's reported cwd WHEN AVAILABLE; and if the main.py path cannot be resolved
 * to an absolute directory we return `undefined` (UNRESOLVED) rather than a
 * bogus/relative root — callers must NOT then silently fall back to a persisted
 * default and mark it "live".
 */
export function liveRootFromArgv(
  argv: string[] | undefined,
  cwd?: string,
): string | undefined {
  // Deliberately NOT delegating to liveScriptFromArgv. This function feeds the #633
  // download-authorization path, and dirname(scriptPath) normalizes two leaves that this
  // body returns verbatim (a bare "main.py" returns `cwd` exactly; `C:\x\.\main.py`
  // returns `C:\x\.`). The values are equivalent after resolve() — which every caller
  // applies — but "equivalent" is not "identical", and this is not the function to take
  // that risk in. What the two functions SHARE is only the script-token extraction
  // (scriptTokenFromArgv); the return shaping stays separate, pinned by a cross-check test.
  const a = scriptTokenFromArgv(argv);
  if (a === undefined) return undefined;
  const dir = dirname(a);
  if (dir === "." || dir === "") {
    return cwd && isAbsolute(cwd) ? cwd : undefined;
  }
  if (isAbsolute(dir)) return dir;
  if (cwd && isAbsolute(cwd)) return pathResolve(cwd, dir);
  return undefined;
}

/**
 * The same derivation as `liveRootFromArgv` but returning the `main.py` FILE itself
 * rather than its directory. `dirname()` of this equals `liveRootFromArgv`'s result after
 * normalization (a cross-check test pins that for every argv shape).
 *
 * The file path is what a caller needs to follow a SYMLINK: ComfyUI locates its implicit
 * `extra_model_paths.yaml` next to `os.path.realpath(__file__)`, so a launcher that keeps
 * `/launcher/main.py` symlinked to `/installs/B/main.py` reads `/installs/B/…`. Only the
 * script path can be realpath'd; the directory cannot (the symlink is on the file).
 * Callers that must not follow symlinks — notably the #633 authorization path, which is
 * anchored to the lexical argv root — keep using `liveRootFromArgv`.
 *
 * Like `liveRootFromArgv`, only the POSITIONAL launch-script token counts (shared
 * `scriptTokenFromArgv`) — a main.py-shaped flag VALUE is never the script (#648 review).
 */
export function liveScriptFromArgv(
  argv: string[] | undefined,
  cwd?: string,
): string | undefined {
  const a = scriptTokenFromArgv(argv);
  if (a === undefined) return undefined;
  const dir = dirname(a);
  if (dir === "." || dir === "") {
    // Bare "main.py" — only resolvable via an absolute cwd.
    return cwd && isAbsolute(cwd) ? pathResolve(cwd, a) : undefined;
  }
  if (isAbsolute(dir)) return a;
  // Relative dir (e.g. "ComfyUI/main.py") — resolve against the server's cwd.
  if (cwd && isAbsolute(cwd)) return pathResolve(cwd, a);
  return undefined; // cannot resolve to an absolute dir → UNRESOLVED
}

/**
 * The RELATIVE directory of the running server's `main.py` (e.g. `"ComfyUI"` for
 * `ComfyUI\main.py`, `"."` for a bare `main.py`). ComfyUI **Desktop** reports exactly
 * this — a relative argv[0] with no `cwd` — so `liveRootFromArgv` cannot resolve a
 * live root and interpreter resolution used to fall back to `COMFYUI_PATH` (the
 * bundle root), picking the launcher's `standalone-env` python instead of the
 * server's own `ComfyUI/.venv` (#401 recurrence). Callers anchor this against a
 * configured base and confirm a `main.py` is really there. Shares the positional-only
 * script extraction of `scriptTokenFromArgv` (#648 review). Returns `undefined` when
 * argv has no main.py, or when its dir is already absolute (use `liveRootFromArgv`).
 */
export function liveRelDirFromArgv(argv: string[] | undefined): string | undefined {
  const a = scriptTokenFromArgv(argv);
  if (a === undefined) return undefined;
  const dir = dirname(a);
  if (isAbsolute(dir)) return undefined;
  return dir === "" ? "." : dir;
}

// ---------------------------------------------------------------------------
// The ONE notion of "the live server's install root" (#369)
// ---------------------------------------------------------------------------

/** How the live server's install root was established. Only the first three are
 *  authoritative — each is anchored on something OBSERVED about the running
 *  process; `unresolved` means we genuinely do not know and callers that would
 *  otherwise WRITE must refuse rather than guess. */
export type LiveServerRootSource = "argv" | "observed-process" | "unresolved";

export interface LiveServerRootResolution {
  /** Absolute install root of the running ComfyUI, when it could be established. */
  root?: string;
  source: LiveServerRootSource;
  /** The RELATIVE `main.py` dir the server reported (`"ComfyUI"`, `"."`), when its
   *  argv named a relative script. Present even when the root stays unresolved —
   *  callers use it to anchor a corroborated fallback and to explain a refusal. */
  relDir?: string;
  /** The interpreter the OS reports for the process on our port, when observed. */
  observedPython?: string;
}

/** How far up from the observed interpreter we look for the live install root.
 *  Covers every layout ComfyUI ships: `<root>/python_embeded/python.exe` (1 up),
 *  `<root>/.venv/bin/python` (2 up), and a nested `<bundle>/ComfyUI/.venv/Scripts/
 *  python.exe` re-anchored on `ComfyUI` (4 up). Bounded so a stray `main.py` far
 *  above the install can never be mistaken for the server's. */
const OBSERVED_ROOT_MAX_ASCENT = 5;

/**
 * Env directories that only a ComfyUI BUNDLE ships — a portable/Desktop layout keeps
 * its interpreter here, one level ABOVE the server root (`<bundle>/python_embeded/
 * python.exe` + `<bundle>/ComfyUI/main.py`).
 *
 * A generic `.venv`/`venv`/`env` is deliberately NOT in this set. Those live
 * anywhere: a server started from `C:\Tools\venv\Scripts\python.exe` with a stale
 * `C:\Tools\ComfyUI\main.py` beside it would otherwise have that unrelated install
 * accepted as "observed" — a wrong destination presented as verified success (codex
 * gate, round 13). A generic venv still qualifies via the "interpreter is INSIDE the
 * candidate root" rule, which is what the real `<root>/.venv/...` layout satisfies.
 * Compared case-insensitively (Windows).
 */
const BUNDLE_ENV_DIR_NAMES = new Set([
  "python_embeded",
  "python_embedded",
  "standalone-env",
]);

/** Binary subdirectories that may sit below a bundle env dir. */
const ENV_BIN_DIR_NAMES = new Set(["scripts", "bin"]);

/**
 * Is `python` positioned INSIDE the install rooted at `root`, anchored from `base`?
 *
 * Two accepted shapes, and nothing else:
 *  1. the interpreter lives under `root` itself (`<root>/.venv/Scripts/python.exe`);
 *  2. it sits in a BUNDLE env directory of the bundle `base` that `root` was
 *     anchored on (`<bundle>/python_embeded/python.exe` + `<bundle>/ComfyUI/main.py`)
 *     — a layout only a ComfyUI portable/Desktop bundle has.
 *
 * Without this test the ascent is unsound (codex gate, round 3): a server started
 * with a SYSTEM python (`C:\Python311\python.exe`) has ancestors that are not its
 * install at all, so walking up to `C:\` and finding a stale `C:\ComfyUI\main.py`
 * would confidently name the WRONG install as live — reintroducing the very bug.
 * Shape 2 is restricted to BUNDLE env dirs for the same reason (round 13): a generic
 * `C:\Tools\venv` says nothing about a `C:\Tools\ComfyUI` that happens to sit beside it.
 */
function interpreterBelongsToInstall(python: string, base: string, root: string): boolean {
  const py = pathResolve(python);
  const pyDir = dirname(py);
  const within = (parent: string, child: string): boolean => {
    const p = pathResolve(parent);
    const c = pathResolve(child);
    return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
  };
  if (within(root, py)) return true;
  if (!within(base, py)) return false;
  const rel = pyDir.slice(pathResolve(base).length).split(sep).filter(Boolean);
  if (rel.length === 0) return true; // interpreter sits directly in the bundle root
  const [first, ...rest] = rel.map((seg) => seg.toLowerCase());
  return (
    BUNDLE_ENV_DIR_NAMES.has(first) && rest.every((seg) => ENV_BIN_DIR_NAMES.has(seg))
  );
}

/**
 * Anchor a RELATIVE `main.py` dir on the interpreter the OS says the live ComfyUI
 * process is running. Walk up from the interpreter and accept the first ancestor
 * under which `<ancestor>/<relDir>/main.py` really exists — but ONLY when the
 * interpreter is positioned inside that install (interpreterBelongsToInstall), so
 * an unrelated `main.py` further up the filesystem can never be adopted. Returns
 * undefined when nothing on the bounded path qualifies.
 */
function anchorRelDirOnInterpreter(python: string, relDir: string): string | undefined {
  if (!isAbsolute(python)) return undefined;
  let dir = dirname(pathResolve(python));
  for (let i = 0; i < OBSERVED_ROOT_MAX_ASCENT; i++) {
    const candidate = pathResolve(dir, relDir);
    if (hasMainPy(candidate) && interpreterBelongsToInstall(python, dir, candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * The interpreter the OS reports for the ComfyUI on our port.
 *
 * DELIBERATELY NOT CACHED. `resolveLiveInterpreter` shells out (netstat/WMI on
 * Windows, lsof on POSIX), so memoizing it is tempting — but this answer decides
 * WHERE A DOWNLOAD IS WRITTEN. A cache keyed on port+argv cannot tell a restarted
 * server apart from the one it replaced (a relaunch of ComfyUI reports the same
 * relative `ComfyUI\main.py` on the same port), so any reuse window is a window in
 * which a download can be written into the PREVIOUS install — the exact failure
 * #369 is about (codex gate, round 1). Each resolution re-observes the process
 * that is live right now; correctness here outranks a few hundred milliseconds.
 */
function observeLivePython(argv: string[] | undefined): string | undefined {
  let statsHost: string | undefined;
  try {
    statsHost = new URL(getComfyUIBaseUrl()).hostname;
  } catch {
    /* unparseable target → no host filter */
  }
  try {
    return resolveLiveInterpreter({
      port: config.resolvedPort,
      host: statsHost,
      remote: false,
      serverArgv: argv,
    })?.python;
  } catch {
    return undefined;
  }
}

/**
 * THE live ComfyUI server's install root — the single notion every write-side
 * caller (download destination, package install) must resolve through, so they can
 * never disagree about which install is "the live one".
 *
 * Two tiers, both anchored on something OBSERVED:
 *
 *  1. `argv` — the server's OWN `/system_stats` argv resolves to an absolute
 *     `main.py` directory (absolute argv[0], or a relative one plus an absolute
 *     server-reported cwd). The server told us where it lives.
 *
 *  2. `observed-process` — the server reported a RELATIVE `main.py` and NO cwd.
 *     This is the shape ComfyUI **Desktop** and the Windows **portable** bundle
 *     both report (`ComfyUI\main.py`), and it is exactly why #369 kept recurring:
 *     with argv unresolvable, the download destination silently fell through to
 *     COMFYUI_PATH — a DIFFERENT, stale install — and the model landed where the
 *     running server never reads. So we ask the OS instead: `resolveLiveInterpreter`
 *     identifies the process listening on our port (correlated against the server's
 *     own argv, so a proxy can't impersonate it) and reports its interpreter; the
 *     relative `main.py` dir is re-anchored on that interpreter's install tree.
 *
 * Anything else is `unresolved`. There is deliberately NO layout-guess tier: a
 * COMFYUI_PATH that merely looks plausible is what wrote 4.88 GB into the wrong
 * install. Callers decide what an unresolved root means for them (a WRITE must
 * refuse or fall back only to something independently corroborated).
 *
 * Never throws. `remote` short-circuits to unresolved — a remote server's paths are
 * on another host and no local process is it.
 */
export function resolveLiveServerRoot(
  argv: string[] | undefined,
  cwd?: string,
  opts?: {
    /** Test seam / caller-supplied observation, bypassing the process-table probe. */
    observedPython?: string;
    /** Skip the process-table probe entirely (remote server). Defaults to isRemoteMode(). */
    remote?: boolean;
  },
): LiveServerRootResolution {
  const relDir = liveRelDirFromArgv(argv);
  const fromArgv = liveRootFromArgv(argv, cwd);
  if (fromArgv) return { root: fromArgv, source: "argv", relDir };
  const remote = opts?.remote ?? isRemoteMode();
  if (remote || relDir === undefined) return { source: "unresolved", relDir };

  let observedPython = opts?.observedPython;
  if (!observedPython) observedPython = observeLivePython(argv);
  if (!observedPython) return { source: "unresolved", relDir };

  const anchored = anchorRelDirOnInterpreter(observedPython, relDir);
  if (anchored) {
    return { root: anchored, source: "observed-process", relDir, observedPython };
  }
  return { source: "unresolved", relDir, observedPython };
}

/**
 * Resolve the Python interpreter that ACTUALLY belongs to a ComfyUI install
 * `root`, honoring EVERY layout ComfyUI ships with — portable Windows builds keep
 * python under `standalone-env` / `python_embeded` (NOT just `.venv`/`venv`). Used
 * by apply_manifest's pip installs and the cloned-node deps installer so those run
 * under the install's OWN interpreter, not a bare system `python` that would
 * contaminate the host env while reporting success (#463 codex review). Returns
 * the first candidate present on disk, else a bare platform python name as a last
 * resort. `undefined` root → bare python.
 */
export function resolveRootInterpreter(root: string | undefined): string {
  const names = IS_WIN ? ["python.exe", "python"] : ["python3", "python"];
  if (root) {
    // Candidates directly under `root` ONLY — see interpreterCandidates: this is a
    // mutating path (pip installs) with no live server to verify a nested guess.
    for (const c of candidatesIn(root)) {
      if (safeExists(c)) return c;
    }
  }
  return names[0];
}

/** existsSync that never throws and never touches UNC paths (a dead network share
 *  can block existsSync for seconds). */
function safeExists(p: string): boolean {
  if (/^\\\\/.test(p)) return false;
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/** Does this directory hold a ComfyUI entrypoint (`main.py`/`main.pyw`)? */
function hasMainPy(dir: string): boolean {
  return safeExists(join(dir, "main.py")) || safeExists(join(dir, "main.pyw"));
}

/**
 * Public form of the entrypoint test, so a caller that must CORROBORATE a
 * configured base against the relative `main.py` the live server reported uses the
 * exact same on-disk check this module anchors with (never a second, drifting one).
 */
export function hasComfyUIEntrypoint(dir: string): boolean {
  return hasMainPy(dir);
}

/**
 * The server roots to search under a configured/derived base, MOST SPECIFIC first.
 *
 * ComfyUI Desktop (and the classic Windows portable bundle) nest the actual server
 * one level down: `<base>/ComfyUI/main.py` with its own `<base>/ComfyUI/.venv`,
 * while `<base>` itself holds the launcher's `standalone-env` python — a DIFFERENT
 * interpreter whose site-packages the running server never imports. Picking `<base>`
 * is what made `install_comfyui (action:"environment")` report `standalone-env/python.exe` and made pip
 * installs land where custom nodes couldn't see them (#401 recurrence). So when the
 * nested dir actually contains a `main.py`, it IS the server root and wins.
 */
function serverRootsUnder(base: string): string[] {
  // The base IS a server root already (its own main.py) — never let a nested checkout
  // outrank it. Otherwise an exact argv-derived root with a stray `ComfyUI/` inside it
  // would silently lose to that nested tree's interpreter.
  if (hasMainPy(base)) return [base];
  const nested = join(base, "ComfyUI");
  return hasMainPy(nested) ? [nested, base] : [base];
}

/** Platform interpreter candidates sitting DIRECTLY under one root, most-preferred
 *  first. This order is deliberately untouched by #401: it also decides which
 *  interpreter `resolveRootInterpreter` hands to pip installs, and reshuffling it
 *  would silently move installs between environments. Within a root the order is only
 *  a preference, never authority — resolveComfyuiPython marks a root holding several
 *  environments `ambiguous` and refuses to speak for it. */
function candidatesIn(r: string): string[] {
  const names = IS_WIN ? ["python.exe", "python"] : ["python3", "python"];
  const candidates: string[] = [];
  if (IS_WIN) {
    candidates.push(join(r, "standalone-env", "python.exe"));
    candidates.push(join(r, "python_embeded", "python.exe"));
    candidates.push(join(r, "..", "python_embeded", "python.exe"));
  }
  const venvBins = IS_WIN
    ? [join(r, ".venv", "Scripts"), join(r, "venv", "Scripts")]
    : [join(r, ".venv", "bin"), join(r, "venv", "bin")];
  for (const bin of venvBins) for (const n of names) candidates.push(join(bin, n));
  return candidates;
}

/** Candidates for a configured base, following a NESTED server root when the base is
 *  not one itself. Used only by resolveComfyuiPython — the live-aware reporting path,
 *  which cross-checks whatever it picks against the running server. The install-side
 *  `resolveRootInterpreter` deliberately does NOT follow the nesting: with no live
 *  server to check against, preferring a nested `.venv` over the base's own
 *  interpreter would be an unverifiable guess in a MUTATING path. */
function interpreterCandidates(root: string): string[] {
  return serverRootsUnder(root).flatMap(candidatesIn);
}

/** Is this candidate a portable "python_embeded" interpreter? ComfyUI's own
 *  `/system_stats.system.embedded_python` is exactly this test applied to its
 *  `sys.executable`, which makes it a cheap, decisive disambiguator between an
 *  install's `.venv` and a bundle's embedded python. */
function isEmbeddedCandidate(candidate: string): boolean {
  return basename(dirname(candidate)).toLowerCase() === "python_embeded";
}

/**
 * A BEST-GUESS interpreter, inferred from install layout.
 *
 * This is a GUESS and nothing more. It is fine for display and for probing (a
 * package we can SEE is really installed somewhere), but it must NEVER back a
 * negative or a "this is the server's environment" claim — that is what #401 was.
 * Authority comes only from `resolveLiveInterpreter()` in live-interpreter.ts,
 * which observes the actual process instead of guessing from directory layout.
 */
export interface ComfyuiPythonResolution {
  /** The interpreter to probe. Absolute when verified; a bare PATH name as last resort. */
  python: string | undefined;
  /** The interpreter exists on disk under a known ComfyUI root (venv/embedded). */
  verified: boolean;
  /** The live server's install root, when argv named one. Provenance only. */
  liveRoot?: string;
}

/**
 * BEST-GUESS interpreter for an install, from layout. Tries the running server's
 * argv-derived root first, then an explicit COMFYUI_PATH, then the saved default
 * workspace (#418); a relative argv `main.py` (the ComfyUI Desktop shape) is
 * re-anchored on those bases when a `main.py` is really there, which is what gets
 * the probe onto the server's own `ComfyUI/.venv` instead of the bundle launcher's
 * `standalone-env`. Portable/standalone installs keep python under python_embeded /
 * standalone-env, so those are checked too. Falls back to a bare PATH name.
 *
 * THIS IS A GUESS. It decides what to PROBE, never what to CLAIM: two cloned venvs
 * under one root, a conda env we don't enumerate, or a server started with an
 * interpreter from elsewhere all defeat layout reasoning, and no version or torch
 * "fingerprint" repairs that. Authority belongs to resolveLiveInterpreter(), which
 * observes the process. Callers must treat this result as unverified (#401).
 */
export function resolveComfyuiPython(
  comfyuiPath: string | undefined,
  statsArgv: string[] | undefined,
  opts?: { cwd?: string; remote?: boolean; embeddedPython?: boolean },
): ComfyuiPythonResolution {
  const names = IS_WIN ? ["python.exe", "python"] : ["python3", "python"];
  const remote = opts?.remote ?? false;
  const argvRoot = liveRootFromArgv(statsArgv, opts?.cwd);

  // The on-disk bases we may inspect, most-trusted first: an explicit COMFYUI_PATH,
  // else the saved default workspace (#418).
  const bases: string[] = [];
  if (comfyuiPath) bases.push(comfyuiPath);
  else if (!argvRoot && !remote) {
    const saved = resolveEffectiveComfyUIBase();
    if (saved) bases.push(saved);
  }

  // Re-anchor a RELATIVE argv `main.py` (ComfyUI Desktop reports `ComfyUI\main.py`
  // with no cwd) onto each base, accepted only when a main.py is really on disk.
  let anchoredRoot: string | undefined;
  if (!argvRoot && !remote) {
    const relDir = liveRelDirFromArgv(statsArgv);
    if (relDir !== undefined) {
      for (const base of bases) {
        const candidate = pathResolve(base, relDir);
        if (hasMainPy(candidate)) {
          anchoredRoot = candidate;
          break;
        }
      }
    }
  }

  const liveRoot = argvRoot ?? anchoredRoot;

  const roots: string[] = [];
  // Skip a live root entirely in remote mode — a coincident local path of the same
  // name is not the remote server's install.
  if (argvRoot && !remote) roots.push(argvRoot);
  if (anchoredRoot) roots.push(anchoredRoot);
  for (const base of bases) {
    if (base === argvRoot || base === anchoredRoot) continue;
    roots.push(base);
  }

  // The server's `embedded_python` self-report still ORDERS the guess (it says
  // whether its interpreter lives in a `python_embeded` dir), which helps us probe
  // the more likely candidate on a portable bundle. It does not confer authority.
  const hint = opts?.embeddedPython;
  for (const root of roots) {
    const existing = interpreterCandidates(root).filter(safeExists);
    if (existing.length === 0) continue;
    const matching =
      hint === undefined ? existing : existing.filter((c) => isEmbeddedCandidate(c) === hint);
    const pool = matching.length > 0 ? matching : existing;
    return { python: pool[0], verified: true, liveRoot };
  }
  return { python: names[0], verified: false, liveRoot };
}

// ---------------------------------------------------------------------------
// Install interpreter resolution (#651)
// ---------------------------------------------------------------------------

/** Where an install interpreter answer came from. "launched" and "observed" are both
 *  OBSERVED ground truth from live-interpreter.ts: "launched" is the child this MCP
 *  spawned, re-validated per call by PID + creation time (never a bare launch mark —
 *  a stale record refuses); "observed" is the OS process table corroborated against
 *  the server's own argv. "override" is the operator's COMFYUI_PYTHON. */
export type InstallInterpreterSource = "override" | "launched" | "observed" | "undetermined";

export interface InstallInterpreterResolution {
  python?: string;
  source: InstallInterpreterSource;
  /** An operator-facing explanation: mutation must never be a silent layout guess. */
  reason: string;
}

/** Desktop commonly reports `ComfyUI/main.py` without a cwd.  Anchor that only
 * against the install being modified, and only after confirming main.py exists.
 * Shares the positional-only script extraction of `scriptTokenFromArgv` via
 * `liveRelDirFromArgv` — a main.py-shaped flag VALUE is never the script (#648). */
function liveRootForInstall(argv: string[] | undefined, cwd: string | undefined, root: string | undefined): string | undefined {
  // Go through the ONE live-root resolver (#369) so the install path and the
  // download path can never disagree about which install is the live one. It
  // covers the argv-absolute case AND the OS-observed anchor for a relative
  // `main.py` — strictly more than the argv-only resolution this used to do.
  const live = resolveLiveServerRoot(argv, cwd);
  if (live.root) return live.root;
  if (!root) return undefined;
  const relDir = liveRelDirFromArgv(argv);
  if (relDir === undefined) return undefined;
  const candidate = pathResolve(root, relDir);
  if (hasMainPy(candidate)) return candidate;
  return undefined;
}

/**
 * Do two python version strings describe the same interpreter?
 *
 * We probe `sys.version` — the SAME string `/system_stats` reports — so both sides
 * carry the full banner ("3.13.12 (main, Feb 12 2026, 00:38:53) [MSC v.1944 64 bit
 * (AMD64)]"). When both banners have build/compiler text we compare it too: a
 * different build of the same version is a different interpreter. Otherwise we fall
 * back to the full dotted version, at whatever precision both sides supply (so a
 * bare "3.13" from an old probe never fails against "3.13.12").
 *
 * This is a CONTRADICTION check, never an identity check — two venvs cloned from one
 * base interpreter report byte-identical banners, so agreement proves nothing. Only
 * an OBSERVED interpreter (live-interpreter.ts) carries authority (#401).
 */
export function pythonVersionsAgree(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (v: string): string => v.replace(/^Python\s+/i, "").replace(/\s+/g, " ").trim();
  const na = norm(a);
  const nb = norm(b);
  // Both carry build/compiler detail → compare the whole banner.
  const detailed = (v: string): boolean => /[([]/.test(v);
  if (detailed(na) && detailed(nb)) return na === nb;
  const parts = (v: string): string[] =>
    (v.match(/^(\d+(?:\.\d+)*)/)?.[1] ?? "").split(".").filter(Boolean);
  const pa = parts(na);
  const pb = parts(nb);
  if (pa.length === 0 || pb.length === 0) return false;
  const depth = Math.min(pa.length, pb.length);
  for (let i = 0; i < depth; i++) if (pa[i] !== pb[i]) return false;
  return true;
}

/** A bundle root may contain its actual server in `ComfyUI/`; do not confuse a
 * nested independent checkout with that bundle layout. */
function targetsLiveInstall(serverRoot: string, requestedRoot: string | undefined): boolean {
  if (!requestedRoot) return true;
  const server = pathResolve(serverRoot);
  const requested = pathResolve(requestedRoot);
  return server === requested || (server.startsWith(requested + sep) && !hasMainPy(requested));
}

/**
 * Resolve a package-install interpreter without claiming that a path-shaped guess is
 * the process that is currently serving ComfyUI.  Success requires OBSERVED ground
 * truth (#401): an explicit COMFYUI_PYTHON is the operator's own claim; a server this
 * MCP launched is authoritative only while the process on the port is still that same
 * child — PID *and* creation time, validated per-call by live-interpreter.ts tier 1,
 * so a stale launch record (child dead, PID recycled, another server now on the same
 * install root) is never trusted; and the OS process table is ground truth when the
 * port owner's command line corroborates the server's own argv (tier 2).  In every
 * other case the live interpreter is UNOBSERVABLE — /system_stats has no
 * sys.executable, so even a single discovered `.venv` may be unrelated (for example,
 * the server can be using system Python).  FAIL CLOSED: refuse rather than report an
 * install into a layout-guessed env as applied when the running server may not be
 * able to import from it (#651).
 */
export async function resolveInstallInterpreter(
  root: string | undefined,
): Promise<InstallInterpreterResolution> {
  const override = process.env.COMFYUI_PYTHON?.trim();
  if (override) {
    return { python: override, source: "override", reason: `Using "${override}" because COMFYUI_PYTHON is set.` };
  }

  const refuse = (reason: string): InstallInterpreterResolution => ({
    source: "undetermined",
    reason,
  });
  if (isRemoteMode()) {
    return refuse(
      "Cannot verify the running server's interpreter: the connected ComfyUI is remote, " +
        "so a package installed locally would not affect it.",
    );
  }

  let system: { argv?: string[]; cwd?: string } | undefined;
  try {
    system = (await getSystemStats()).system as { argv?: string[]; cwd?: string };
  } catch {
    return refuse(
      "Cannot verify the running server's interpreter: no local ComfyUI is reachable. " +
        "Start ComfyUI or connect to it first.",
    );
  }
  const serverRoot = liveRootForInstall(system?.argv, system?.cwd, root);
  // OBSERVED ground truth (#401): /system_stats cannot name the interpreter, but the
  // OS can. resolveLiveInterpreter is the ONLY launch record this resolver trusts.
  let statsHost: string | undefined;
  try {
    statsHost = new URL(getComfyUIBaseUrl()).hostname;
  } catch {
    /* unparseable target → no host filter */
  }
  const live = resolveLiveInterpreter({
    port: config.resolvedPort,
    host: statsHost,
    remote: false,
    serverArgv: system?.argv,
  });
  // A VALIDATED launched-by-us observation (tier 1) is authoritative whenever the
  // live server is the requested install — or argv names no root to contradict it.
  if (live?.source === "launched-by-us" && (!serverRoot || targetsLiveInstall(serverRoot, root))) {
    return {
      python: live.python,
      source: "launched",
      reason:
        `Using "${live.python}", the interpreter this MCP server launched the running ` +
        `ComfyUI with (identity-confirmed for PID ${live.pid}).`,
    };
  }
  if (!serverRoot) {
    return refuse(
      "Cannot verify the running server's interpreter: the running ComfyUI did not report " +
        "a resolvable main.py location.",
    );
  }
  if (!targetsLiveInstall(serverRoot, root)) {
    return refuse(
      `The running ComfyUI is a different install ("${serverRoot}") than the requested path; ` +
        "installing into the requested layout would not affect the live server.",
    );
  }
  // A process-table observation (tier 2) is ground truth too, but only once the
  // guards above have tied the live server to the requested install. This strictly
  // ADDS a success source: when nothing observes the interpreter the install still
  // refuses (#651 fail-closed).
  if (live) {
    return {
      python: live.python,
      source: "observed",
      reason:
        `Using "${live.python}", the interpreter the OS reports for the running ComfyUI ` +
        `process (PID ${live.pid}), corroborated against the server's own argv.`,
    };
  }
  return refuse(
    `Cannot determine which interpreter the running ComfyUI at "${serverRoot}" uses: ` +
      "/system_stats does not expose sys.executable, so an interpreter discovered from its layout is unconfirmed.",
  );
}

/**
 * `pip show` output for the packages we care about, plus WHETHER THE QUERY RAN.
 *
 * An empty map has two causes that a caller must not confuse: pip answered and none of
 * these packages are installed, or pip never answered at all (absent from this
 * interpreter — common in uv-created venvs — or the probe timed out). Reporting the
 * second as the first invents a capability finding.
 *
 * The discriminator has to come from THIS invocation. A follow-up `pip --version` was
 * the obvious shortcut and is wrong: it shows that pip can start NOW, which is not
 * evidence that the query that already failed ever ran — a `pip show` killed by the 8s
 * timeout would be vouched for by a fast `pip --version` and its silence read as "none
 * installed". So `ran` requires POSITIVE evidence in pip's own output that pip looked:
 * a parsed record, or pip's own `WARNING: Package(s) not found: …`. Anything else —
 * pip absent, python itself failing, the probe killed, or that wording changing in some
 * future pip — is `ran: false`, i.e. "we could not tell", which is the safe direction.
 *
 * `probe()` is deliberately NOT used here. It discards everything on a non-zero exit,
 * and `pip show a b c` exits 1 whenever ANY named package is missing — which, with
 * xformers and diffusers in the list, is the ordinary state of a real machine. That
 * silently threw away the records for the packages pip DID find (torch among them) and
 * left `packages` empty, so `install_comfyui (action:"environment")` reported no packages on installs that had
 * them. A non-zero exit here is a completed run whose output must still be read.
 */
async function probePipPackages(
  pythonExe: string,
  names: string[],
): Promise<{ ran: boolean; packages: Record<string, string> }> {
  // `pip show` is portable across pip/uv-managed venvs.
  const found: Record<string, string> = {};
  let out = "";
  try {
    const res = await execFileAsync(pythonExe, ["-m", "pip", "show", ...names], {
      timeout: 8000,
      windowsHide: true,
    });
    out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  } catch (err) {
    // promisified execFile rejects on a non-zero exit but attaches the output it did
    // collect. Read it: a partial match lives there, and so does pip's not-found
    // warning. A spawn failure or a kill simply leaves both undefined.
    const e = err as { stdout?: unknown; stderr?: unknown };
    const parts = [e?.stdout, e?.stderr].filter((s): s is string => typeof s === "string");
    out = parts.join("\n");
  }
  // `pip show A B C` emits records separated by a line of "---".
  for (const block of out.split(/^---$/m)) {
    const nameMatch = block.match(/^Name:\s*(.+)$/m);
    const verMatch = block.match(/^Version:\s*(.+)$/m);
    if (nameMatch && verMatch) {
      found[nameMatch[1].trim().toLowerCase()] = verMatch[1].trim();
    }
  }
  // A parsed record IS pip speaking, so the run is self-evident. With none, only pip's
  // own not-found warning proves it looked — and it has to be pip's STRUCTURED line,
  // anchored at the start of a line with the WARNING prefix and trailing colon. A bare
  // substring match would be satisfied by any traceback or wrapper message that merely
  // quotes the phrase, and that would license the "none of these are installed" claim
  // off a `pip show` that never ran.
  if (Object.keys(found).length > 0) return { ran: true, packages: found };
  return { ran: /^\s*WARNING:\s*Package\(s\) not found:/im.test(out), packages: found };
}

async function probeGitRev(
  workspacePath: string,
): Promise<{ rev?: string; branch?: string } | undefined> {
  if (!existsSync(join(workspacePath, ".git"))) return undefined;
  const rev = await probe("git", ["rev-parse", "--short", "HEAD"], {
    cwd: workspacePath,
  });
  const branch = await probe("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: workspacePath,
  });
  if (!rev && !branch) return undefined;
  return { rev, branch };
}

/** Read ComfyUI-Manager version from its local install if present. */
async function readManagerVersion(
  workspacePath: string,
): Promise<string | undefined> {
  const dirNames = ["ComfyUI-Manager", "comfyui-manager"];
  for (const dirName of dirNames) {
    const file = join(workspacePath, "custom_nodes", dirName, "pyproject.toml");
    try {
      if (!existsSync(file)) continue;
      // Tiny TOML peek — only the version line, no full parser needed.
      const text = await readFile(file, "utf-8");
      const m = text.match(/^version\s*=\s*["']([^"']+)["']/m);
      if (m) return m[1];
      // Presence without a parseable version still tells us it's installed.
      return "installed";
    } catch {
      // try next
    }
  }
  // Fallback: directory presence
  for (const dirName of dirNames) {
    if (existsSync(join(workspacePath, "custom_nodes", dirName))) {
      return "installed";
    }
  }
  return undefined;
}

export interface EnvironmentInfo {
  // Running instance (from /system_stats — works remotely)
  running_instance: {
    reachable: boolean;
    api_target: string;
    os?: string;
    python_version?: string;
    embedded_python?: boolean;
    comfyui_version?: string;
    /** torch version the RUNNING server reports (e.g. "2.11.0.dev20260123+cu130"). */
    pytorch_version?: string;
    /** ComfyUI's own label for how it was deployed, e.g. "local-desktop2-standalone".
     *  Reported for context and used to explain WHY an interpreter could not be
     *  observed; it identifies the LAYOUT, never which interpreter is running. */
    deploy_environment?: string;
    devices?: Array<{
      name: string;
      type: string;
      vram_total_mb?: number;
      vram_free_mb?: number;
    }>;
    error?: string;
  };
  // Local workspace probes (omitted/degraded when no local path)
  local: {
    workspace_path?: string;
    python?: { executable: string; version: string };
    /** Whether the probed python is trusted to be the running ComfyUI's own
     *  interpreter. False when a bare PATH python was used or its version
     *  disagrees with the running instance — in that case `packages` is omitted
     *  rather than reporting versions from the wrong environment (#401). */
    python_probe_trusted?: boolean;
    /** HOW the interpreter was determined — "we know" vs "we're guessing" (#401):
     *  `launched-by-us` / `process-table` are OBSERVATIONS and are authoritative;
     *  `layout-guess` is inferred from directory layout and never is. */
    python_probe_source?: "launched-by-us" | "process-table" | "layout-guess";
    /** WHY the probe is (or isn't) trusted, in one sentence — so a reader can tell
     *  "we couldn't determine it" apart from "we determined it's absent" (#401). */
    python_probe_reason?: string;
    git?: { rev?: string; branch?: string };
    comfyui_manager_version?: string;
    packages?: Record<string, string>;
    note?: string;
  };
}

const KEY_PACKAGES = [
  "torch",
  "torchvision",
  "torchaudio",
  "xformers",
  "numpy",
  "transformers",
  "diffusers",
  "comfyui-frontend-package",
];

export async function getEnvironment(): Promise<EnvironmentInfo> {
  const apiTarget = getComfyUIBaseUrl();

  // 1. Running instance via /system_stats (works for remote targets too)
  const running: EnvironmentInfo["running_instance"] = {
    reachable: false,
    api_target: apiTarget,
  };
  // argv/cwd of the LIVE server (from /system_stats) drive live-first interpreter
  // resolution below — captured here so a probe never targets the wrong python.
  let statsArgv: string[] | undefined;
  let statsCwd: string | undefined;
  try {
    const stats = await getSystemStats();
    running.reachable = true;
    running.os = stats.system.os;
    running.python_version = stats.system.python_version;
    running.embedded_python = stats.system.embedded_python;
    running.comfyui_version = stats.system.comfyui_version;
    running.pytorch_version = stats.system.pytorch_version;
    running.deploy_environment = (stats.system as { deploy_environment?: string })
      .deploy_environment;
    statsArgv = stats.system.argv;
    // ComfyUI does not currently report cwd, but tolerate it if a future/build does.
    statsCwd = (stats.system as { cwd?: string }).cwd;
    running.devices = (stats.devices ?? []).map((d) => ({
      name: d.name,
      type: d.type,
      vram_total_mb:
        typeof d.vram_total === "number"
          ? Math.round(d.vram_total / (1024 * 1024))
          : undefined,
      vram_free_mb:
        typeof d.vram_free === "number"
          ? Math.round(d.vram_free / (1024 * 1024))
          : undefined,
    }));
  } catch (err) {
    running.error = err instanceof Error ? err.message : String(err);
  }

  // 2. Local probes — use the active path, else fall back to the saved default
  //    workspace (set via workspace action:"set_default") so `env` still inspects a known
  //    local install when COMFYUI_PATH isn't set.
  const local: EnvironmentInfo["local"] = {};
  const cfg = await readWorkspaceConfig();
  const workspacePath = config.comfyuiPath ?? cfg.defaultWorkspace;

  // LIVE-FIRST interpreter resolution — identical to resolveComfyuiPython used by
  // the panel env block, so the two paths can never disagree (#401 / PR #433). The
  // running server's argv root wins over an explicit COMFYUI_PATH, which wins over
  // the saved default.
  const remote = isRemoteMode();
  // GROUND TRUTH — did we launch it, or can the OS tell us? (See live-interpreter.ts.)
  // statsArgv is the server's OWN sys.argv: the process we find on the port must have
  // a command line consistent with it, or it is not the server that answered us.
  let statsHost: string | undefined;
  try {
    statsHost = new URL(apiTarget).hostname;
  } catch {
    /* unparseable target → no host filter */
  }
  const live = resolveLiveInterpreter({
    port: config.resolvedPort,
    host: statsHost,
    remote,
    serverArgv: statsArgv,
  });
  const resolved = resolveComfyuiPython(workspacePath, statsArgv, {
    cwd: statsCwd,
    remote,
    // Orders the GUESS only (used when there is no ground truth to show instead).
    embeddedPython: running.reachable ? running.embedded_python : undefined,
  });

  // The install root we can actually inspect on disk: an explicit/saved workspace,
  // else the live server's own root (so we still report git/manager for a live
  // server even when no workspace path is configured).
  const localRoot = workspacePath ?? resolved.liveRoot;
  if (!localRoot) {
    local.note =
      "No local ComfyUI path configured (COMFYUI_PATH unset, none auto-detected, " +
      "and no saved default workspace) and no live server main.py to locate one. " +
      "Local environment probes skipped; remote /system_stats used instead.";
    return { running_instance: running, local };
  }

  local.workspace_path = localRoot;
  if (!config.comfyuiPath && cfg.defaultWorkspace) {
    local.note = `Using saved default workspace "${cfg.defaultWorkspace}" (COMFYUI_PATH not set).`;
  }

  // GROUND TRUTH first: the interpreter we LAUNCHED ComfyUI with, or the one the OS
  // says the process on our port is running. Only these are observations; everything
  // below is a layout guess (#401).
  const groundTruth = live ?? undefined;
  const probeExe = groundTruth?.python ?? resolved.python;

  // Read `sys.version` — byte-for-byte what /system_stats reports — so the
  // contradiction check can compare build/compiler text, not just the number.
  // `--version` is the fallback for an interpreter that can't run -c.
  const version = probeExe
    ? ((await probe(probeExe, ["-c", "import sys;print(sys.version)"])) ??
      (await probe(probeExe, ["--version"])))
    : undefined;
  if (probeExe && version) {
    const ver = version.replace(/^Python\s+/i, "").replace(/\s+/g, " ").trim();
    // Display the plain number; keep the full banner for the comparison below.
    const shortVer = ver.match(/^(\d+(?:\.\d+)*)/)?.[1] ?? ver;
    local.python = { executable: probeExe, version: shortVer };

    // THE TERMINATING RULE (#401). An interpreter is authoritative only when we
    // OBSERVED it, never when we inferred it from install layout:
    //   1. we launched the process and recorded the interpreter we used;
    //   2. the OS process table reports argv[0] of the process on our port;
    //   3. otherwise UNKNOWN — no package list, no "not installed", no trust.
    // Everything that used to live here (sole-candidate-under-a-believed-root,
    // python/torch "fingerprints", ambiguity corroboration) was inference dressed up
    // as proof, and inference is what reported the wrong venv in the first place.
    const runningPy = running.python_version;
    let trusted = false;
    let reason: string;

    if (remote) {
      reason =
        "the running ComfyUI is REMOTE — no local interpreter is the remote server's, " +
        "and ComfyUI does not report its own sys.executable over HTTP";
    } else if (!groundTruth) {
      const deployed = running.deploy_environment
        ? ` (ComfyUI reports deploy_environment "${running.deploy_environment}")`
        : "";
      reason =
        `the interpreter shown is a BEST GUESS from install layout, not an observation: ` +
        `we did not launch this ComfyUI and could not read the interpreter of the ` +
        `process serving port ${config.resolvedPort} from the OS${deployed}. Package ` +
        `versions are omitted rather than attributed to the wrong environment`;
    } else if (!runningPy) {
      // NOT a mismatch. `pythonVersionsAgree` returns false when EITHER side is missing,
      // so this used to fall into the branch below and report "does not match the running
      // ComfyUI python (unreported)" — asserting a disagreement that was never observed.
      // One verdict, two causes; the message picked the wrong one. Say which happened.
      if (groundTruth.source === "launched-by-us") {
        // Nothing to cross-check against, and nothing that needs cross-checking: we
        // CHOSE this interpreter and spawned the process, and its PID + creation time
        // still match. Refusing here would be the opposite error — withholding a package
        // list we genuinely know, because a corroboration we never needed was missing.
        trusted = true;
        reason =
          `this MCP server launched ComfyUI (PID ${groundTruth.pid}) with this exact ` +
          `interpreter. The running ComfyUI did not report its own python version, so no ` +
          `cross-check was possible — none is needed, the interpreter is the one we chose`;
      } else {
        reason =
          `the observed interpreter (${groundTruth.source}) reports python ${shortVer}, but ` +
          `the running ComfyUI did not report a python version of its own, so the two could ` +
          `NOT be compared. That is an unverified match, not a mismatch — refusing to ` +
          `attribute this interpreter's packages to the server on an unmade comparison`;
      }
    } else if (!pythonVersionsAgree(ver, runningPy)) {
      // We DID observe the interpreter, yet it disagrees with the running server.
      // Something is off (a stale PID, a wrapper); report unknown, not a wrong list.
      reason =
        `the observed interpreter (${groundTruth.source}) reports python ${shortVer}, which ` +
        `does not match the running ComfyUI python ${runningPy} — ` +
        `refusing to attribute its packages to the server`;
    } else {
      trusted = true;
      reason =
        groundTruth.source === "launched-by-us"
          ? `this MCP server launched ComfyUI (PID ${groundTruth.pid}) with this exact interpreter`
          : `the OS reports PID ${groundTruth.pid} (serving port ${config.resolvedPort}) is running this interpreter`;
    }

    local.python_probe_trusted = trusted;
    local.python_probe_source = groundTruth?.source ?? "layout-guess";
    local.python_probe_reason = reason;

    let pkgs: Record<string, string> | undefined;

    if (trusted && probeExe) {
      const probed = await probePipPackages(probeExe, KEY_PACKAGES);
      pkgs = probed.packages;
      if (Object.keys(pkgs).length > 0) {
        local.packages = pkgs;
      } else {
        // An absent `packages` field otherwise reads identically to the deliberate
        // withholding below, and a reader would take it as "none of these are
        // installed". Which of the two actually happened is knowable, so say which —
        // narrating one cause for both would be the same fold this fix is about.
        local.note = [
          local.note,
          probed.ran
            ? `No package versions to report from ${probeExe}: pip answered and none of ` +
              `${KEY_PACKAGES.join(", ")} are installed in it. The interpreter IS trusted ` +
              `(${reason}), so this IS an observation — not a failed query.`
            : `Package versions could not be READ from ${probeExe}: pip did not answer at ` +
              `all (it may be absent from this interpreter — uv-created venvs often have ` +
              `no pip — or the probe timed out). The interpreter itself IS trusted ` +
              `(${reason}); the empty list is a failed query, NOT evidence that these ` +
              `packages are missing.`,
        ]
          .filter(Boolean)
          .join(" ");
      }
    } else {
      local.note = [
        local.note,
        `Package versions omitted: ${reason}, so reporting them would be a false ` +
          `capability report (#401). Start ComfyUI through restart_comfyui (action:"start"), or run it ` +
          `locally where this process can read its command line, for an accurate report.`,
      ]
        .filter(Boolean)
        .join(" ");
    }
  } else {
    local.note = [
      local.note,
      "Python interpreter not found on PATH or in the workspace venv/embedded python.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  const git = await probeGitRev(localRoot);
  if (git) local.git = git;

  const managerVersion = await readManagerVersion(localRoot);
  if (managerVersion) local.comfyui_manager_version = managerVersion;

  return { running_instance: running, local };
}
