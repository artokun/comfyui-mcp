import {
  execSync,
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readlinkSync, statSync } from "node:fs";
import { platform } from "node:os";
import { isAbsolute, join } from "node:path";
import { getSystemStats, resetClient, resetObjectInfoCache } from "../comfyui/client.js";
import { config, getComfyUIBaseUrl, isRemoteMode } from "../config.js";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { ProcessControlError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { findComfyuiPython } from "./env-capabilities.js";
import {
  readLiveProcessEnv,
  resolveLaunchEnvironment,
  type LaunchEnvInfo,
  type LaunchEnvResolution,
} from "./launcher-env.js";
import {
  classifyDesktopSupervision,
  classifyListenerOwnership,
  isDescendantOfChild,
  launchedChildStillRunning,
  unclassifiedOwnership,
  unclassifiedSupervision,
  type ListenerOwnership,
  type SupervisorRelaunch,
} from "./listener-ownership.js";
import { resetManagerApiCache } from "./manager-api-cache.js";
import {
  parseListenerPidFromNetstat,
  findPidByPort,
  probePortOwner,
} from "./port-owner.js";
import {
  recordLaunchedInterpreter,
  clearLaunchedInterpreter,
  readProcessIdentity,
  argv0FromCommandLine,
  commandLineMatchesArgv,
  type ProcessIdentity,
} from "./live-interpreter.js";
import {
  liveRootFromArgv,
  resolveEffectiveComfyUIBase,
  markLocalComfyUILaunched,
  resetLocalComfyUILaunchState,
} from "./workspace-env.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProcessInfo {
  pid: number;
  port: number;
  argv: string[];
  /**
   * The port owner's argv as the OS reports it, captured when the SERVER could not
   * report its own (#767).
   *
   * A ComfyUI wedged by a CUDA OOM stops answering `/system_stats`, so `argv` comes
   * back empty — and with it went every way to relaunch: `stop_comfyui` killed the
   * process anyway, announced `has_restart_info: true`, and `start_comfyui` then had
   * nothing to start. The OS knew the whole command line the entire time. The user's
   * own recovery was to read it out of the process table by hand.
   *
   * Kept in a SEPARATE field, never merged into `argv`, because the two have
   * different standing. `argv` is the server's own account of itself and is what the
   * OS command line is CORROBORATED against; folding a value derived from that same
   * command line into it would make the check compare a reading with itself and
   * always agree. This one is only ever spent to build a relaunch and to tell the
   * user how to start the server by hand.
   */
  osArgv?: string[];
  /**
   * May `osArgv` be SPAWNED, or only read?
   *
   * macOS reports a process's arguments as one flattened string (`ps -o command=`),
   * so `--output-directory /a/My Outputs` is indistinguishable from two arguments and
   * relaunching from it would spawn a command the user never ran — very possibly one
   * ComfyUI's own argument parser rejects, after we had already stopped the server
   * (codex gate round 6). Linux and Windows can be reconstructed faithfully.
   *
   * A flattened argv is still perfectly good for the two things it is READ for: the
   * recovery hint a human acts on, and the before/after comparison that catches a pid
   * substitution. Only the SPAWN needs fidelity.
   */
  osArgvExact?: boolean;
  /** The OS's raw command line — the recovery hint even when argv is not spawnable. */
  osCommandLine?: string;
  /**
   * TRUE when `pid` was found by SCANNING PROCESS NAMES for a Desktop shell, rather
   * than resolved from the port.
   *
   * The distinction decides whether anything may be concluded about supervision. A
   * port-resolved pid is the process that would be stopped, so what stands above it
   * is its supervisor. A name-scanned one is merely "a Desktop app is running
   * somewhere on this machine" — bound to no port and no backend — and a second,
   * unrelated Desktop window must never license stopping a server it has never heard
   * of (codex gate round 9).
   */
  pidFromDesktopScan?: boolean;
  isDesktopApp: boolean;
  desktopExePath?: string;
  /**
   * The live ComfyUI process's working directory, captured at gather-time while
   * the process is still ALIVE (a known-good moment). Used to resolve a RELATIVE
   * launch script (`python main.py`) to an absolute path so relaunch works
   * regardless of the orchestrator's own cwd — and, crucially, still resolves
   * after the stop kills the pid (when `/proc/<pid>/cwd` is gone) (#535).
   */
  liveCwd?: string;
  /**
   * The live ComfyUI process's own ENVIRONMENT, captured at gather-time while the
   * process is still ALIVE — the same known-good moment (and the same
   * disappears-on-kill constraint) as `liveCwd`. This is the launch environment
   * verbatim, so a relaunch reproduces it exactly instead of silently
   * substituting the orchestrator's own environment (#776). Linux only; other
   * platforms cannot read another process's environment block.
   */
  liveEnv?: NodeJS.ProcessEnv;
  /**
   * The port owner's process CREATION TIME, read at the same moment as the pid.
   * A pid is not an identity (pids are recycled), so anything that acts ON this
   * process (reading its environment, killing it) re-verifies this stamp first;
   * a changed stamp means the number now belongs to somebody else. Reuses #650's
   * pid+creation-time identity rather than inventing a second scheme.
   * `undefined` when the platform/permissions make it unreadable, in which case
   * the cheaper port-ownership re-check is the only guard.
   */
  startedAt?: string;
  /**
   * The resolved relaunch ENVIRONMENT decision (#776) — computed once by
   * assessRelaunch (pre-stop, so a refusal happens before anything is killed) and
   * reused verbatim by the spawn, so the process that comes back is launched into
   * the same environment the preflight approved.
   */
  envPlan?: LaunchEnvResolution;
}

/**
 * How to bring this instance back BY HAND — captured while the process is still
 * alive, because the process table entry dies with it (#814/#767).
 *
 * Every field is what we actually observed, with its provenance intact, because the
 * two sources are not equally complete. `server_argv` is Python's `sys.argv`: its
 * first element is the SCRIPT, so the interpreter is simply not in it and pasting it
 * into a shell would not work. `command` is the OS's view and IS the whole thing.
 * Presenting either as "the command to run" without saying which it is would hand a
 * user a recovery instruction that fails at the moment they need it most.
 */
interface RecoveryHint {
  /** The full command line the OS reported for the process, when readable. */
  command?: string;
  /**
   * TRUE when the OS gave us the arguments FLATTENED into one string (macOS), so a
   * value containing a space cannot be told from two arguments. The command is still
   * what a human needs — they can see where the quotes belong — but it is reported as
   * approximate rather than as something to paste unread.
   */
  command_flattened?: boolean;
  /** The server's own `sys.argv` — NO interpreter (Python does not put it there). */
  server_argv?: string[];
  /** The working directory the process was running in, when readable. */
  cwd?: string;
}

interface StopResult {
  stopped: boolean;
  message: string;
  /**
   * Can `start_comfyui` actually bring this back?
   *
   * It used to mean "we stored a ProcessInfo", which was true even when that info
   * held nothing runnable — so a stop reported `true` and the start that followed
   * reported "No command-line info captured from previous run" (#767). It now means
   * what its name says: a relaunch command was BUILT AND VALIDATED before the kill.
   */
  has_restart_info: boolean;
  /** Present whenever a hand-restart may be needed — always on a refusal. */
  restart_hint?: RecoveryHint;
  /** Why a relaunch could not be validated, when it could not. */
  relaunch_blocked?: string;
  auto_restart?: SupervisorResult;
  /**
   * Set when the stop was COMMITTED without being able to confirm the process
   * actually exited (every port probe failed after the kill). Carried separately
   * so a caller composing its own message cannot silently drop the caveat.
   */
  unverified_exit?: string;
}

interface StartResult {
  started: boolean;
  message: string;
  pid?: number;
  ready?: boolean;
  readiness?: StartupReadinessResult;
  auto_restart?: SupervisorResult;
  spawn_error?: ChildProcessErrorDetails;
  /** How the relaunch environment was resolved (#776). */
  launch_env?: LaunchEnvInfo;
  /**
   * Whether the process now listening on the port is the one WE launched.
   *
   * A STRING tri-state, not a boolean-or-undefined, precisely so the uncertain
   * case survives `JSON.stringify` (which DROPS `undefined` keys, making "we could
   * not determine this" indistinguishable from a response that never carried the
   * field at all). REQUIRED for the same reason: a field that is only SOMETIMES
   * present cannot be told apart from an older build that never emitted it, so
   * every return path — including the ones that never launched anything — states
   * it explicitly.
   */
  listener_ownership: ListenerOwnership;
}

interface RestartResult {
  stopped: boolean;
  started: boolean;
  message: string;
  /** How to start it by hand — carried on every refusal, so a user who is told
   *  "not restarting" is never left to dig the command out of the process table
   *  themselves (#814). */
  restart_hint?: RecoveryHint;
  ready?: boolean;
  readiness?: StartupReadinessResult;
  auto_restart?: SupervisorResult;
  spawn_error?: ChildProcessErrorDetails;
  /** How the relaunch environment was resolved (#776). */
  launch_env?: LaunchEnvInfo;
  /**
   * Whether the process now listening on the port is the one WE launched.
   *
   * A STRING tri-state, not a boolean-or-undefined, precisely so the uncertain
   * case survives `JSON.stringify` (which DROPS `undefined` keys, making "we could
   * not determine this" indistinguishable from a response that never carried the
   * field at all). REQUIRED for the same reason: a field that is only SOMETIMES
   * present cannot be told apart from an older build that never emitted it, so
   * every return path — including the ones that never launched anything — states
   * it explicitly.
   */
  listener_ownership: ListenerOwnership;
}

interface StartupReadinessResult {
  ready: boolean;
  timed_out: boolean;
  attempts: number;
  max_tries: number;
  interval_ms: number;
  waited_ms: number;
  probe_url: string;
}

interface SupervisorResult {
  enabled: boolean;
  supported: boolean;
  max_restarts: number;
  window_ms: number;
  restart_count: number;
  gave_up: boolean;
  message?: string;
}

interface RestartPolicy {
  enabled: boolean;
  maxRestarts: number;
  windowMs: number;
}

interface ChildProcessErrorDetails {
  message: string;
  code?: string;
  errno?: number;
  syscall?: string;
  path?: string;
}

// ---------------------------------------------------------------------------
// Module-level state — persists between MCP tool calls within a session
// ---------------------------------------------------------------------------

let lastProcessInfo: ProcessInfo | null = null;
let supervisedChild: ChildProcess | null = null;
let supervisedExitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
let supervisedErrorHandler: ((err: Error) => void) | null = null;
let supervisorRestartCount = 0;
let supervisorWindowStartedAt = 0;
let supervisorGaveUp = false;

// ---------------------------------------------------------------------------
// Cross-platform helpers
// ---------------------------------------------------------------------------

const IS_WIN = platform() === "win32";

// parseListenerPidFromNetstat / findPidByPort now live in port-owner.ts so the
// live-interpreter resolver can use them without importing this module (which would
// cycle through workspace-env). Re-exported here: this is still their public home.
export { parseListenerPidFromNetstat, findPidByPort };

/**
 * Find PIDs of the Desktop app's Electron shell — current branding
 * ("Comfy Desktop.exe" / "Comfy Desktop.app") and legacy ("ComfyUI.exe" /
 * "ComfyUI.app"). The Python backend is a child of the Electron app, so we
 * need to kill the parent to fully stop the Desktop app.
 */
function findDesktopAppPids(): number[] {
  const pids: number[] = [];
  if (IS_WIN) {
    for (const exe of ["ComfyUI.exe", "Comfy Desktop.exe"]) {
      try {
        const out = execSync(
          `tasklist /FI "IMAGENAME eq ${exe}" /FO CSV /NH`,
          { encoding: "utf-8", timeout: 5000 },
        ).trim();
        for (const line of out.split("\n")) {
          // CSV format: "ComfyUI.exe","12345","Console","1","206,248 K"
          // (the image name is already filtered — match any first column)
          const match = line.match(/^"[^"]+","(\d+)"/);
          if (match) pids.push(parseInt(match[1], 10));
        }
      } catch {
        // No processes with this image name
      }
    }
  } else {
    try {
      const out = execSync(`pgrep -f "ComfyUI.app|Comfy Desktop.app"`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      for (const line of out.split("\n")) {
        const pid = parseInt(line, 10);
        if (!isNaN(pid) && pid > 0) pids.push(pid);
      }
    } catch {
      // No Desktop app processes found
    }
  }
  return pids;
}

function killProcessTree(pid: number): void {
  try {
    if (IS_WIN) {
      execSync(`taskkill /PID ${pid} /T /F`, {
        encoding: "utf-8",
        timeout: 10000,
      });
    } else {
      // Try SIGTERM first, then SIGKILL after a short wait
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
      // Give it a moment, then force kill
      try {
        execSync(`sleep 1 && kill -9 ${pid} 2>/dev/null`, {
          encoding: "utf-8",
          timeout: 5000,
        });
      } catch {
        // Already dead — that's fine
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // "not found" / "no such process" are fine — process already dead
    if (!/not found|no such process|does not exist/i.test(msg)) {
      throw new ProcessControlError(`Failed to kill process ${pid}: ${msg}`);
    }
  }
}

/**
 * Kill the Desktop app entirely — find all Electron shell PIDs and kill each tree.
 * Falls back to killing just the port PID if no Desktop processes found.
 */
function killDesktopApp(portPid: number): void {
  const desktopPids = findDesktopAppPids();
  if (desktopPids.length > 0) {
    logger.info(`Killing Desktop app processes: ${desktopPids.join(", ")}`);
    for (const pid of desktopPids) {
      killProcessTree(pid);
    }
  } else {
    // Fallback — just kill the port process
    killProcessTree(portPid);
  }
}

/**
 * Is THIS PROCESS the Desktop supervisor — the Electron shell itself?
 *
 * Deliberately NOT `isDesktopApp`, and the difference matters. That one asks "was
 * this SERVER started by Desktop?", and answers yes on any mention of the Desktop
 * install — including a `--extra-model-paths-config` pointing into
 * `…/Comfy Desktop/…`, which is exactly how a Desktop backend identifies itself.
 * Reusing it here would let a WRAPPER that merely passes such a flag stand in for
 * the shell, and a wrapper cannot re-exec anything (codex gate).
 *
 * So this requires the Desktop binary to be the process's OWN EXECUTABLE — argv[0],
 * never merely somewhere on the command line. Searching the whole line let a wrapper
 * that PASSES the Desktop exe as an argument
 * (`python wrapper.py --desktop-exe "…/Comfy Desktop.exe"`) stand in for the shell,
 * and a wrapper re-execs nothing (codex gate round 2).
 *
 * THE ASYMMETRY IS DELIBERATE. Failing to recognise a real supervisor costs the walk
 * a hop and can end in `abandoned` — a REFUSED restart, which leaves the server
 * running and points the user at the Desktop app that would have restarted it
 * anyway. Recognising a NON-supervisor licenses a stop that nothing undoes. So when
 * the evidence is shaped awkwardly, this errs strict.
 */
function isDesktopSupervisorProcess(identity: ProcessIdentity): boolean {
  const looksLikeDesktopBinary = (path: string): boolean => {
    const norm = path.replace(/\\/g, "/").toLowerCase();
    const base = norm.split("/").pop() ?? "";
    // Current and legacy Windows branding, including the electron-era install dir.
    if (base === "comfy desktop.exe" || base === "comfyui.exe") return true;
    // macOS: the bundle's MAIN binary, which by convention is named after the bundle
    // (`Comfy Desktop.app/Contents/MacOS/Comfy Desktop`). Accepting ANY binary under
    // `Contents/MacOS/` was too loose: a venv shim or launcher script living inside
    // the bundle would pass, and a shim re-execs nothing (coordinator gate). The
    // backreference ties the two halves together so the binary must belong to the
    // bundle naming it. Electron HELPERS are excluded structurally — they live in
    // `Contents/Frameworks/<Helper>.app/Contents/MacOS/…`, so the first bundle in the
    // path is not followed by `Contents/MacOS/`.
    return /\/(comfy desktop|comfyui)\.app\/contents\/macos\/\1$/.test(norm);
  };

  // THE KERNEL'S ANSWER FIRST, and ALONE when it exists (codex gate round 3).
  // argv[0] is a string the launcher chose: `exec -a`, or a hand-built Windows
  // command line, lets any program present itself as any other, so a check that
  // trusts it can be told "I am Comfy Desktop.exe" by something that is not. The
  // executable path comes from the OS (`Win32_Process.ExecutablePath`,
  // `/proc/<pid>/exe`) and the process cannot set it. When we have it, a NEGATIVE
  // from it is final — falling through to argv[0] afterwards would hand the claim
  // back its authority.
  if (identity.executablePath) return looksLikeDesktopBinary(identity.executablePath);

  // argv[0] — exact on Linux, and on Windows the launcher quotes a path with spaces
  // (which "Comfy Desktop" always has), so the tokeniser recovers it whole. Reached
  // only where the OS withheld the authenticated path (macOS `ps` has no such
  // column; an elevated Windows process may withhold it), which is the evidence this
  // check had before and is still better than nothing.
  const exe =
    identity.argv?.[0] ?? argv0FromCommandLine(identity.commandLine ?? "") ?? "";
  if (looksLikeDesktopBinary(exe)) return true;
  // macOS: `ps -o command=` prints argv joined by SPACES, so an app-bundle argv[0]
  // containing one ("Comfy Desktop.app" — the current branding) cannot be tokenised
  // back out, and every such install would otherwise walk past its own shell into a
  // false `abandoned`. It is still recognisable by POSITION rather than content:
  // argv[0] OPENS the command line, and the only space in the bundle path is inside
  // the app name itself, so the directory prefix before it has none. An argument can
  // never satisfy that — reaching it would mean crossing the space that separates it
  // from argv[0].
  //
  // The BINARY NAME is required here too, for the same reason as above: a launcher
  // script or venv shim inside the bundle would otherwise be read as the shell
  // (coordinator gate). `\2` ties it to the bundle that names it, and the match must
  // end at whitespace or end-of-line so the binary is the whole argv[0] rather than a
  // prefix of some longer name.
  const line = (identity.commandLine ?? "").trim().replace(/\\/g, "/").toLowerCase();
  return /^"?(\/[^\s"]*\/)?(comfy desktop|comfyui)\.app\/contents\/macos\/\2(\s|"|$)/.test(
    line,
  );
}

function isDesktopApp(argv: string[]): boolean {
  const joined = argv.join(" ").toLowerCase();
  return (
    joined.includes("programs/comfyui/resources") ||
    joined.includes("programs\\comfyui\\resources") ||
    joined.includes("comfyui.app") ||
    // Current branding ("Comfy Desktop\Comfy Desktop.exe", "Comfy Desktop.app")
    // and the electron-era install dir.
    joined.includes("comfy desktop") ||
    joined.includes("@comfyorgcomfyui-electron")
  );
}

/**
 * Try to find the ComfyUI Desktop exe from common install locations.
 * Used as a fallback when no process info was previously captured.
 */
function findDesktopExeFromCommonPaths(): string | undefined {
  if (IS_WIN) {
    const home = process.env.LOCALAPPDATA || process.env.USERPROFILE || "";
    const candidates = [
      // Current branding: "Comfy Desktop" (per-machine and per-user installs)
      `C:\\Program Files\\Comfy Desktop\\Comfy Desktop.exe`,
      `${process.env.LOCALAPPDATA}\\Programs\\Comfy Desktop\\Comfy Desktop.exe`,
      // Electron-era install dir
      `${process.env.LOCALAPPDATA}\\Programs\\@comfyorgcomfyui-electron\\ComfyUI.exe`,
      // Legacy names
      `${home}\\Programs\\ComfyUI\\ComfyUI.exe`,
      `${process.env.LOCALAPPDATA}\\Programs\\ComfyUI\\ComfyUI.exe`,
      `C:\\Program Files\\ComfyUI\\ComfyUI.exe`,
    ];
    for (const p of candidates) {
      try {
        const result = execSync(`if exist "${p}" echo found`, { encoding: "utf-8", timeout: 2000 });
        if (result.includes("found")) return p;
      } catch {
        // Not found
      }
    }
  } else {
    // macOS
    const candidates = [
      "/Applications/Comfy Desktop.app",
      `${process.env.HOME}/Applications/Comfy Desktop.app`,
      "/Applications/ComfyUI.app",
      `${process.env.HOME}/Applications/ComfyUI.app`,
    ];
    for (const p of candidates) {
      try {
        execSync(`test -d "${p}"`, { timeout: 2000 });
        return p;
      } catch {
        // Not found
      }
    }
  }
  return undefined;
}

function findDesktopExePath(argv: string[]): string | undefined {
  const joined = argv.join(" ");

  if (IS_WIN) {
    // Look for the main ComfyUI Desktop exe by walking up from the python/main.py path
    // Typical: C:\Users\X\AppData\Local\Programs\ComfyUI\resources\ComfyUI\main.py
    // Desktop exe: C:\Users\X\AppData\Local\Programs\ComfyUI\ComfyUI.exe
    const match = joined.match(
      /([A-Za-z]:[\\\/].*?[\\\/]Programs[\\\/]ComfyUI)[\\\/]resources/i,
    );
    if (match) return `${match[1]}\\ComfyUI.exe`;
  } else {
    // macOS: /Applications/ComfyUI.app/...
    const match = joined.match(/(\/.*?ComfyUI\.app)/);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Wait until the port is OBSERVED free.
 *
 * "Observed" is the load-bearing word: `findPidByPort` returns null both when
 * nothing is listening and when the lookup itself failed, and treating the second
 * as the first would let a transient failure certify that a still-running server
 * had gone (codex gate). So this polls the tri-state probe and returns only on a
 * definite `free`; an `unknown` keeps waiting and, if that is all we ever get,
 * surfaces as the timeout — a caller must not read it as success.
 */
/** How long to wait for the port to be observed free after a kill. Tunable for the
 *  same reason the startup probes are (COMFYUI_STARTUP_CHECK_*): a host with a slow
 *  or unavailable port probe should not be stuck with one hardcoded budget. */
function getPortFreeTimeoutMs(): number {
  return Math.round(parsePositiveNumberEnv("COMFYUI_PORT_FREE_TIMEOUT_S", 15) * 1000);
}

async function waitForPortFree(
  port: number,
  timeoutMs = getPortFreeTimeoutMs(),
): Promise<void> {
  const start = Date.now();
  let lastUnknown: string | undefined;
  while (Date.now() - start < timeoutMs) {
    const probe = probePortOwner(port);
    if (probe.state === "free") return;
    if (probe.state === "unknown") lastUnknown = probe.reason;
    await sleep(500);
  }
  throw new ProcessControlError(
    `Port ${port} still in use after ${timeoutMs / 1000}s` +
      (lastUnknown ? ` (last port probe could not complete: ${lastUnknown})` : ""),
  );
}

function parsePositiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

function getStartupReadinessConfig(): { intervalMs: number; maxTries: number } {
  return {
    intervalMs: Math.round(
      parsePositiveNumberEnv("COMFYUI_STARTUP_CHECK_INTERVAL_S", 1) * 1000,
    ),
    // Default budget is 60s (was 20s). ComfyUI with a normal set of custom nodes
    // routinely takes >20s to answer /system_stats on a cold start, so a 20-probe
    // budget reported `started:false` moments before a healthy instance became
    // ready (issue #367). Tunable via COMFYUI_STARTUP_CHECK_MAX_TRIES.
    maxTries: parsePositiveIntEnv("COMFYUI_STARTUP_CHECK_MAX_TRIES", 60),
  };
}

function getRestartPolicy(): RestartPolicy {
  const enabled = /^(1|true|yes)$/i.test(process.env.COMFYUI_ALWAYS_RESTART ?? "");
  return {
    enabled,
    maxRestarts: parsePositiveIntEnv("COMFYUI_RESTART_MAX_ATTEMPTS", 3),
    windowMs: Math.round(
      parsePositiveNumberEnv("COMFYUI_RESTART_WINDOW_S", 60) * 1000,
    ),
  };
}

/**
 * Poll `/system_stats` until ComfyUI answers 2xx. This poller is TOLERANT of the
 * down window: a thrown fetch error (ECONNRESET / socket hang up / fetch failed)
 * and any non-2xx (including a 502/503/504 from a proxy/tunnel in front of a
 * killed origin) are all swallowed and treated as "not ready yet — keep polling".
 * That property is what lets the same routine cover both a locally-spawned start
 * and a remote ComfyUI-Manager reboot (where ComfyUI briefly disappears).
 *
 * `cfg` overrides the interval/try budget — the local start uses the short
 * env-tuned default; the remote reboot passes a longer budget.
 */
async function waitForApiReady(
  cfg?: { intervalMs: number; maxTries: number },
): Promise<StartupReadinessResult> {
  const { intervalMs, maxTries } = cfg ?? getStartupReadinessConfig();
  const probeUrl = `${getComfyUIBaseUrl()}/system_stats`;
  const start = Date.now();
  let attempts = 0;

  for (; attempts < maxTries; attempts++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      let res: Response;
      try {
        res = await comfyuiFetch(probeUrl, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (res.ok) {
        logger.info("ComfyUI API is ready");
        return {
          ready: true,
          timed_out: false,
          attempts: attempts + 1,
          max_tries: maxTries,
          interval_ms: intervalMs,
          waited_ms: Date.now() - start,
          probe_url: probeUrl,
        };
      }
    } catch {
      // Not ready yet
    }
    if (attempts < maxTries - 1) await sleep(intervalMs);
  }

  return {
    ready: false,
    timed_out: true,
    attempts,
    max_tries: maxTries,
    interval_ms: intervalMs,
    waited_ms: Date.now() - start,
    probe_url: probeUrl,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detachSupervisor(): void {
  if (supervisedChild && supervisedExitHandler) {
    supervisedChild.off("exit", supervisedExitHandler);
  }
  if (supervisedChild && supervisedErrorHandler) {
    supervisedChild.off("error", supervisedErrorHandler);
  }
  supervisedChild = null;
  supervisedExitHandler = null;
  supervisedErrorHandler = null;
}

function childProcessErrorDetails(err: unknown): ChildProcessErrorDetails {
  if (!(err instanceof Error)) return { message: String(err) };
  const nodeErr = err as NodeJS.ErrnoException;
  return {
    message: err.message,
    code: typeof nodeErr.code === "string" ? nodeErr.code : undefined,
    errno: typeof nodeErr.errno === "number" ? nodeErr.errno : undefined,
    syscall: typeof nodeErr.syscall === "string" ? nodeErr.syscall : undefined,
    path: typeof nodeErr.path === "string" ? nodeErr.path : undefined,
  };
}


/** Injectable parent-pid reader (see readParentPid). */
let parentPidResolverOverride: ((pid: number) => number | undefined) | null = null;

/**
 * The parent pid of `pid` — the evidence that a process IS the child we spawned.
 *
 * Unlike a creation stamp (which can only ever be read some time AFTER the spawn,
 * by which point a same-instant exit may already have handed the number to
 * somebody else), parentage does not depend on when we look: we spawned our child,
 * so its parent is this very orchestrator. Another ComfyUI — even one with a
 * byte-identical command line and an identical creation second, started by some
 * other launcher — has a different parent. Unreadable means "cannot tell", never
 * "ours". Consulted only on the ownership decision, so its cost (a PowerShell
 * spawn on Windows) is paid once per start, never per poll.
 */
function readParentPid(pid: number): number | undefined {
  if (parentPidResolverOverride) return parentPidResolverOverride(pid);
  // Same OS call as the rest of the identity — never a second spawn.
  return resolveProcessIdentity(pid)?.parentPid;
}



/** The launch-environment facts to report, once a plan has been resolved (#776). */
function launchEnvInfo(info?: ProcessInfo): LaunchEnvInfo | undefined {
  return info?.envPlan?.info;
}

/**
 * The sentence naming the DEATH of the process we launched, when it died before
 * the API answered. Far more actionable than "60/60 probes": it says the relaunch
 * itself failed (the #776 shape — ComfyUI aborting during import), not that it is
 * merely slow.
 */
function exitCause(exit: {
  code: number | null;
  signal: NodeJS.Signals | null;
}): string {
  if (exit.signal != null) return `killed by ${exit.signal}`;
  if (exit.code != null) return `exit code ${exit.code}`;
  return "for an unknown reason";
}

function describeLaunchedChildExit(
  exit: { code: number | null; signal: NodeJS.Signals | null } | undefined,
): string {
  if (!exit) return "";
  return ` The process this call launched EXITED (${exitCause(exit)}) before the API came up, so ComfyUI is DOWN — this was a failed relaunch, not a slow start.`;
}

/**
 * The sentence appended to a start/restart message when the server had to be
 * launched WITHOUT a launcher environment we could not rebuild (#776). Only
 * reachable from the already-down path — the still-running path refuses instead.
 */
function launchEnvWarning(info?: ProcessInfo): string {
  const plan = info?.envPlan;
  if (!plan || plan.reproducible) return "";
  return (
    ` WARNING: ${plan.reason ?? plan.info.note}` +
    ` It was launched with this process's environment instead, which may not be enough for it to come up. ` +
    (plan.advice ?? "")
  ).replace(/\s+$/, "");
}

function supervisorResult(info?: ProcessInfo): SupervisorResult {
  const policy = getRestartPolicy();
  return {
    enabled: policy.enabled,
    supported: Boolean(info && !info.isDesktopApp),
    max_restarts: policy.maxRestarts,
    window_ms: policy.windowMs,
    restart_count: supervisorRestartCount,
    gave_up: supervisorGaveUp,
    message: !policy.enabled
      ? "Auto-restart is disabled."
      : info?.isDesktopApp
        ? "Auto-restart supervision is only supported for directly spawned Python ComfyUI processes."
        : undefined,
  };
}

function rememberRestartAttempt(policy: RestartPolicy): boolean {
  const now = Date.now();
  if (supervisorWindowStartedAt === 0 || now - supervisorWindowStartedAt > policy.windowMs) {
    supervisorWindowStartedAt = now;
    supervisorRestartCount = 0;
    supervisorGaveUp = false;
  }

  if (supervisorRestartCount >= policy.maxRestarts) {
    supervisorGaveUp = true;
    return false;
  }

  supervisorRestartCount += 1;
  return true;
}

interface SpawnedComfyUI {
  child: ChildProcess;
  /**
   * The exact (interpreter + args) we launched, for a NON-Desktop spawn. Used to
   * corroborate that the process later found on the port really is the one we
   * started, rather than a different program that inherited its pid.
   */
  launchArgv?: string[];
}

let recordedLaunchChild: ChildProcess | undefined;

function adoptLaunchedChild(child: ChildProcess): void {
  recordedLaunchChild = child;
  // Env-trust ONLY (#633 P1b) — the launched interpreter itself is recorded by
  // spawnFromProcessInfo via recordLaunchedInterpreter (live-interpreter.ts), the
  // single launch record, and trusted only after PID + creation-time validation.
  markLocalComfyUILaunched();
  const clearIfCurrent = (): void => {
    if (recordedLaunchChild !== child) return;
    recordedLaunchChild = undefined;
    resetLocalComfyUILaunchState();
    // Same fail-closed reasoning for the recorded interpreter: once our child is
    // gone, a successor on that port may run a DIFFERENT python (#401).
    clearLaunchedInterpreter();
  };
  child.once("exit", clearIfCurrent);
  child.once("error", clearIfCurrent);
}

function spawnFromProcessInfo(info: ProcessInfo): SpawnedComfyUI | null {
  if (info.isDesktopApp) {
    if (IS_WIN) {
      const exe = info.desktopExePath;
      if (!exe) return null;
      return { child: spawn(exe, [], { detached: true, stdio: "ignore", shell: false }) };
    }

    const appPath = info.desktopExePath ?? "ComfyUI";
    return { child: spawn("open", ["-a", appPath], { detached: true, stdio: "ignore" }) };
  }

  const cmd = resolveLaunchCommand(info);
  if (!cmd) return null;
  // #776: the relaunch ENVIRONMENT is as load-bearing as the relaunch command.
  // Resolve it here too (not only in assessRelaunch) so EVERY spawn site — the
  // restart relaunch, a bare start_comfyui, and the crash supervisor — launches
  // into the SAME environment the preflight approved.
  //
  // This site never REFUSES: reaching it means nothing is listening on the port,
  // i.e. the server is already down, and leaving it down is the one outcome worse
  // than a possibly-degraded launch (#776 cardinal rule). An irreproducible
  // launcher environment is refused earlier, by assessRelaunch, while the server
  // is still UP; here it only downgrades to "inherit + warn".
  const envPlan = ensureLaunchEnvPlan(info, cmd);
  const child = spawn(cmd.exe, cmd.args, {
    detached: true,
    stdio: "ignore",
    // Omitted (undefined) for a plain install → the child inherits this process's
    // environment, exactly as before #776. Set only when we have a BETTER answer:
    // the live process's own environment, or a launcher environment reconstructed
    // from disk.
    env: envPlan.env,
    // Prefer the cwd the command resolved against (the live process cwd or the
    // absolute install anchor for a relaunch, #535/#711); only then the
    // configured install dir — and only as an ABSOLUTE path that exists on disk.
    // A stale/relative/nonexistent config.comfyuiPath as cwd would ENOENT the
    // spawn (#711); omitting cwd inherits this process's (existing) working dir.
    cwd: cmd.cwd ?? configuredInstallCwd(),
    shell: false,
    windowsHide: true,
  });
  // GROUND TRUTH for #401: we chose this interpreter, so we KNOW which python the
  // server runs — no layout inference required. Keyed to the PID so it is discarded
  // the moment a different process owns the port. (Desktop-app launches return
  // above: that exe is a launcher, not an interpreter.)
  if (child.pid) recordLaunchedInterpreter(child.pid, cmd.exe);
  return { child, launchArgv: [cmd.exe, ...cmd.args] };
}

/**
 * Turn captured process info into a spawnable (executable, args) pair.
 *
 * The argv we save comes from ComfyUI's `/system_stats` — i.e. Python's
 * `sys.argv`, whose argv[0] is the SCRIPT path (`…/main.py`), NOT the Python
 * interpreter. Spawning that script directly with `shell:false` fails on
 * Windows with `spawn EFTYPE` (the OS cannot exec a `.py` as a PE binary),
 * which is exactly the restart_comfyui relaunch failure in #330. When argv[0]
 * is a script we resolve the real ComfyUI Python interpreter and pass the whole
 * argv (main.py + flags) as its args. When argv[0] is already an interpreter
 * (e.g. a supervised child we spawned ourselves), we spawn it verbatim.
 */
/**
 * The ABSOLUTE ComfyUI dir (the one directly holding `main.py`) to anchor a
 * RELATIVE sys.argv[0] against, resolved LIVE-FIRST and consistently with the
 * canonical base download_model / the environment services already use (#476,
 * #426). Order, most-trustworthy first:
 *   1. the LIVE running server's own argv-derived install root (absolute argv[0]);
 *   2. the canonical effective base — COMFYUI_PATH or the saved default workspace
 *      — i.e. the exact absolute install download_model wrote into in the same
 *      session (resolveEffectiveComfyUIBase);
 *   3. config.comfyuiPath, when absolute, as a last resort.
 * Returns undefined only when none is absolute; callers then fall back to the raw
 * (possibly relative) argv and the refuse-safe preflight refuses a genuinely
 * unresolvable install.
 */
function resolveScriptAnchor(argv: string[]): string | undefined {
  const live = liveRootFromArgv(argv);
  if (live && isAbsolute(live)) return live;
  const base = resolveEffectiveComfyUIBase();
  if (base && isAbsolute(base)) return base;
  if (config.comfyuiPath && isAbsolute(config.comfyuiPath)) {
    return config.comfyuiPath;
  }
  return undefined;
}

/**
 * The live process's own working directory — the most authoritative anchor for a
 * RELATIVE launch script. A ComfyUI launched as `python main.py …` has argv[0] =
 * `main.py` with no path root, an unset/stale COMFYUI_PATH gives no canonical base,
 * and no absolute argv root exists — so every anchor in resolveScriptAnchor comes
 * up empty and restart refuses, even though the reachable process's cwd points at a
 * valid install containing main.py (#535). On Linux we read `/proc/<pid>/cwd`. This
 * MUST be captured while the process is still alive (gatherProcessInfo) because the
 * symlink vanishes the instant the pid is killed; other OSes have no cheap /proc
 * equivalent and return undefined (the existing refuse-safe fallback still applies).
 */
let liveCwdResolverOverride: ((pid: number) => string | undefined) | null = null;
/**
 * Injectable live-ENVIRONMENT reader (#776) — same rationale and lifetime as the
 * live-cwd resolver above: it must run while the process is alive, and tests need
 * to drive it without a real `/proc`.
 */
let liveEnvResolverOverride:
  | ((pid: number) => NodeJS.ProcessEnv | undefined)
  | null = null;

function resolveLiveProcessEnv(pid: number): NodeJS.ProcessEnv | undefined {
  if (liveEnvResolverOverride) return liveEnvResolverOverride(pid);
  return readLiveProcessEnv(pid);
}

/**
 * Injectable process-IDENTITY reader (creation time), reusing #650's identity
 * scheme from live-interpreter rather than inventing a second one.
 *
 * Native reads happen only on Linux, where `/proc/<pid>/stat` is a free file read
 * AND which is the only platform where we read `/proc/<pid>/environ` at all. The
 * Windows/macOS readers cost a PowerShell/`ps` spawn per call and would buy
 * nothing the port-ownership re-check below does not already give: a recycled pid
 * belongs to an unrelated program, which by definition is not listening on our
 * port. An injected override always wins so tests can drive recycled-pid
 * scenarios on any host.
 */
let processIdentityOverride:
  | ((pid: number) => ProcessIdentity | undefined)
  | null = null;

/**
 * Read a process's identity — command line, creation time and PARENT pid — in one
 * OS call.
 *
 * This is deliberately NOT platform-gated any more. It was, on cost grounds: the
 * Windows reader is a PowerShell `Get-CimInstance` spawn, measured at ~2.4s even
 * for a pid that does not exist. But skipping it there meant Windows had NO
 * identity evidence at all, so "the re-check couldn't reach the server" collapsed
 * to a bare numeric port/pid comparison — and a replacement instance with
 * different argv was killed on the strength of the previous one's answer (codex
 * gate). That is the reported platform and the common case on it.
 *
 * The cost is bounded by WHERE it is called: once when binding the pid, once
 * immediately before the kill, and once when deciding ownership after a launch —
 * never inside a poll. A restart already spends tens of seconds; a few of them
 * buying "we are certain this is the right process" is the trade the whole issue
 * is about.
 */
function resolveProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (processIdentityOverride) return processIdentityOverride(pid);
  if (!pid || pid <= 0) return undefined;
  try {
    return readProcessIdentity(pid);
  } catch {
    return undefined;
  }
}

/**
 * A process identity we are willing to BIND to the ComfyUI that answered us.
 *
 * A creation-time stamp read moments after the port lookup is not by itself proof
 * that the number still denotes the server: in the window between them ComfyUI can
 * exit, the OS can recycle the pid, and a replacement can take the port — after
 * which every later re-read agrees with itself about the WRONG process (coordinator
 * gate). A timestamp cannot close that; an INDEPENDENT observation can. So the
 * OS's view of the pid must corroborate the server's own view of itself: the
 * process's command line has to match the `sys.argv` that `/system_stats` reported
 * over HTTP (the same correlation #401 uses to keep a proxy on the port from
 * passing itself off as ComfyUI). Anything unreadable or non-matching yields no
 * identity at all, and the caller falls back to evidence that refuses rather than
 * guesses.
 */
type IdentityCorroboration =
  /** The OS's view of the pid matches the server's own — safe to bind. */
  | { kind: "confirmed"; identity: ProcessIdentity }
  /**
   * POSITIVE counter-evidence: the OS says that pid is running something OTHER
   * than the ComfyUI that answered us. Never collapsed into "unknown" — that would
   * let a later transport hiccup wave the substitution through (codex gate).
   */
  | { kind: "mismatch"; commandLine: string }
  /** No readable evidence either way. Absence of proof, not proof of absence. */
  | { kind: "unknown" };

function resolveCorroboratedIdentity(
  pid: number,
  argv: string[],
): IdentityCorroboration {
  if (argv.length === 0) return { kind: "unknown" };
  const identity = resolveProcessIdentity(pid);
  if (!identity) return { kind: "unknown" };
  if (identity.commandLine && !commandLineMatchesArgv(identity.commandLine, argv)) {
    logger.warn(
      "PID mismatch: the OS's command line for the port owner does not match the argv ComfyUI reported",
      { pid, commandLine: identity.commandLine },
    );
    return { kind: "mismatch", commandLine: identity.commandLine };
  }
  if (!identity.startedAt) return { kind: "unknown" };
  return { kind: "confirmed", identity };
}

/**
 * The live environment of a pid we can still PROVE is the process we identified.
 *
 * Reading `/proc/<pid>/environ` from a bare number is not enough: between the port
 * lookup and the read, ComfyUI can exit and the OS can hand the number to an
 * unrelated process, whose environment we would then adopt as ComfyUI's launch
 * environment. So the creation time is re-verified immediately AFTER the read, and
 * any gap in the evidence (no stamp before, no stamp after, or a changed stamp)
 * discards the capture and falls through to the on-disk tiers, which refuse rather
 * than guess.
 */
function captureVerifiedLiveEnv(
  pid: number,
  startedAt: string | undefined,
  argv: string[],
): NodeJS.ProcessEnv | undefined {
  if (!startedAt) return undefined;
  const env = resolveLiveProcessEnv(pid);
  if (!env) return undefined;
  // Re-verify with the SAME corroboration used to bind in the first place, so a
  // recycled pid cannot satisfy the re-check just by agreeing with itself.
  const recheck = resolveCorroboratedIdentity(pid, argv);
  const after = recheck.kind === "confirmed" ? recheck.identity.startedAt : undefined;
  if (!after || after !== startedAt) {
    logger.warn(
      "Discarding the captured ComfyUI environment: the pid's identity changed while reading it",
      { pid, before: startedAt, after: after ?? "(unavailable)" },
    );
    return undefined;
  }
  return env;
}

/**
 * May we still act on (kill) the process we identified? Returns a refusal reason
 * when the pid provably no longer denotes that process.
 *
 * Two independent checks, cheapest first:
 *   1. it must STILL own the port we found it on - a recycled pid belongs to some
 *      unrelated program, which by definition is not listening there;
 *   2. when a creation-time stamp was captured, it must still match.
 * Missing evidence is NOT treated as failure (that would refuse restarts on hosts
 * where the reads are unavailable); only a POSITIVE mismatch refuses.
 */
function processIdentityStillValid(
  info: ProcessInfo,
): { ok: true } | { ok: false; reason: string } {
  // A Desktop pid may legitimately not be the port owner (it can come from the
  // Electron-shell scan when the API is unreachable), so the port check is
  // meaningless there.
  if (!info.isDesktopApp) {
    let owner: number | null = null;
    try {
      owner = findPidByPort(info.port);
    } catch {
      owner = null;
    }
    if (owner !== info.pid) {
      return {
        ok: false,
        reason:
          `the process identified on port ${info.port} (PID ${info.pid}) no longer owns that port ` +
          `(now ${owner ?? "nothing"}), so it exited on its own - this PID may since have been ` +
          "reused by an unrelated program and must not be killed",
      };
    }
  }
  // Same corroboration as the binding. NOTE both checks are independent of whether
  // a creation stamp was ever obtained: a command line that does not match the
  // server's argv is POSITIVE evidence this pid is somebody else, and gating it
  // behind `startedAt` would discard that evidence exactly when we have least of
  // it (codex gate).
  // WHAT THIS PROCESS SHOULD STILL BE RUNNING — the server's own account when it
  // gave one, otherwise the OS's EARLIER reading of the same pid.
  //
  // Passing `info.argv` unguarded was wrong: commandLineMatchesArgv fails CLOSED on
  // an empty argv, which is right for "is this ComfyUI?" and wrong here — a server
  // that never answered has no argv to disagree with, and reading that absence as a
  // mismatch refuses to stop exactly the wedged instance the user is recovering
  // (#767). But simply SKIPPING the check there left the wedged path with nothing
  // but numeric pid/port equality (codex gate round 5). The OS reading is the
  // answer: comparing a LATER reading against an EARLIER one is not
  // self-corroboration — they are two observations separated in time, which is
  // exactly what a substitution has to survive. Together with the creation stamp
  // below (now retained on this path), a replacement that inherited the number is
  // caught whether or not it runs the same command line.
  const expectedArgv = info.argv.length > 0 ? info.argv : (info.osArgv ?? []);
  const now = resolveProcessIdentity(info.pid);
  if (
    expectedArgv.length > 0 &&
    now?.commandLine &&
    !commandLineMatchesArgv(now.commandLine, expectedArgv)
  ) {
    return {
      ok: false,
      reason:
        `PID ${info.pid} is running something other than the ComfyUI we identified ` +
        `(its command line does not match that server's arguments), so it must not be killed`,
    };
  }
  if (info.startedAt && now?.startedAt && now.startedAt !== info.startedAt) {
    return {
      ok: false,
      reason:
        `PID ${info.pid} is no longer the ComfyUI process we identified (its creation time ` +
        "changed), so the number has been reused by a different program and must not be killed",
    };
  }
  return { ok: true };
}

function resolveLiveProcessCwd(pid: number): string | undefined {
  if (liveCwdResolverOverride) return liveCwdResolverOverride(pid);
  if (!pid || IS_WIN) return undefined;
  try {
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    return cwd && isAbsolute(cwd) ? cwd : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The argv a relaunch is built from: the SERVER's own `sys.argv` when it could tell
 * us, otherwise the OS's view of the same process (#767).
 *
 * The two differ in shape and both are handled downstream: `sys.argv[0]` is the
 * SCRIPT (`main.py`, so an interpreter has to be resolved for it), while the OS's
 * argv[0] is the INTERPRETER itself — which is strictly better, since it needs no
 * resolution at all. The order is not a preference between sources of truth: the
 * server's answer simply comes with an identity binding the OS reading cannot have,
 * so it is used whenever it exists.
 */
function relaunchArgv(info: ProcessInfo): string[] {
  if (info.argv.length > 0) return info.argv;
  // A FLATTENED reading is not a command. It is still reported to the user, who can
  // see where the quotes belong; we cannot, and guessing would spawn arguments the
  // server never had (codex gate round 6).
  return info.osArgvExact ? (info.osArgv ?? []) : [];
}

function resolveLaunchCommand(
  info: ProcessInfo,
): { exe: string; args: string[]; cwd?: string } | null {
  const argv = relaunchArgv(info);
  if (argv.length === 0) return null;
  const [first, ...rest] = argv;
  // Strip surrounding quotes a launcher may leave on the script path BEFORE the
  // suffix test — otherwise `"C:\…\main.py"` fails the `.py` check, bypasses the
  // unified live-first resolver, and gets treated as the executable (#401 / PR #433
  // round 3). Kept in sync with liveRootFromArgv's quote handling.
  const firstUnquoted = first.trim().replace(/^["']+/, "").replace(/["']+$/, "");
  const looksLikeScript = /\.pyw?$/i.test(firstUnquoted);
  if (looksLikeScript) {
    const python = findComfyuiPython(config.comfyuiPath ?? undefined, argv);
    if (!python) return null;
    // sys.argv[0] can be RELATIVE (the standard Windows portable launcher runs
    // `python ComfyUI\main.py` from the portable root). We force cwd to
    // config.comfyuiPath — the ComfyUI dir that directly holds main.py — so a
    // relative script would resolve against the wrong dir (…/ComfyUI/ComfyUI/
    // main.py). Anchor it: use the absolute path as-is, otherwise main.py under
    // the resolved ComfyUI root.
    //
    // The argv mirrors the running ComfyUI's sys.argv, which is Windows-flavored
    // when ComfyUI runs on Windows — regardless of what OS this process is on.
    // So detect absoluteness and the script basename in a separator-agnostic way
    // rather than trusting the host `path` module (which mangles `C:\…` / `\`
    // paths on POSIX). The final join stays host-native to match comfyuiPath.
    const isWindowsAbsolute =
      /^[a-zA-Z]:[\\/]/.test(firstUnquoted) || /^\\\\/.test(firstUnquoted);
    const scriptBasename = firstUnquoted.split(/[\\/]/).pop() || firstUnquoted;
    // LIVE-FIRST anchor for a RELATIVE argv[0]: resolve the canonical ABSOLUTE
    // ComfyUI dir the same way download_model / the env services do, so restart
    // never refuses on a stale/relative COMFYUI_PATH while the reachable install
    // lives elsewhere (#476, #426). config.comfyuiPath is only ONE input to that
    // canonical base (which also honors the saved default workspace), so anchor
    // to the base — not to config.comfyuiPath directly. When no absolute anchor
    // exists we keep the raw (possibly relative) script and let assessRelaunch's
    // refuse-safe preflight catch a truly unresolvable install.
    const anchor = resolveScriptAnchor(argv);
    const scriptIsAbsolute = isAbsolute(firstUnquoted) || isWindowsAbsolute;
    // LIVE-CWD anchor (#535): before falling back to the canonical base, resolve a
    // RELATIVE script against the running process's OWN cwd (captured live, so it
    // survives the stop that kills the pid). Two hard requirements keep the stop
    // refuse-safe and env-consistent:
    //   1. Both the script AND the interpreter must be resolved from the SAME live
    //      cwd — never pair a live-cwd script with a stale COMFYUI_PATH's python,
    //      which would relaunch the live server under the wrong environment (codex
    //      round-2 P1). So the interpreter is re-resolved with the live cwd as its
    //      search root (finds that install's own venv/embedded python).
    //   2. Both must be validated as REGULAR FILES (not just existsSync): a dir
    //      named `main.py`, or a dir at the interpreter path, must NOT unlock a kill
    //      we can't actually exec afterward (codex round-2 P1).
    // Split into segments + re-join so a Windows `ComfyUI\main.py` normalizes to
    // host-native separators on a POSIX host instead of a literal one-segment name.
    const relSegments = firstUnquoted.split(/[\\/]/).filter(Boolean);
    let liveCwdScript: string | undefined;
    let liveCwdPython: string | undefined;
    if (!scriptIsAbsolute && info.liveCwd && relSegments.length > 0) {
      const candidateScript = join(info.liveCwd, ...relSegments);
      const candidatePython = findComfyuiPython(info.liveCwd, argv);
      const pythonIsAbsolute =
        !!candidatePython &&
        (isAbsolute(candidatePython) || /^[a-zA-Z]:[\\/]/.test(candidatePython));
      if (
        isRegularFile(candidateScript) &&
        pythonIsAbsolute &&
        isRegularFile(candidatePython)
      ) {
        liveCwdScript = candidateScript;
        liveCwdPython = candidatePython;
      }
    }
    const script = scriptIsAbsolute
      ? firstUnquoted
      : liveCwdScript
        ? liveCwdScript
        : anchor
          ? join(anchor, scriptBasename)
          : firstUnquoted;
    // When the script was anchored to the LIVE cwd, use that install's OWN python
    // and spawn FROM that cwd — never a stale/nonexistent config.comfyuiPath, which
    // would ENOENT the spawn after the server was already killed (#535). An
    // absolute / canonical-base script spawns from its OWN anchor dir the same way
    // (#711): the anchor is the absolute install root the script was resolved
    // against, so the relaunch never depends on a wrong/undefined working
    // directory. Only an UNANCHORED relative script leaves cwd unset — the
    // refuse-safe preflight (#476/#426) rejects that case before any stop.
    const exe = liveCwdScript ? liveCwdPython! : python;
    const cwd = liveCwdScript ? info.liveCwd : anchor;
    return { exe, args: [script, ...rest], cwd };
  }
  return { exe: first, args: rest };
}

/**
 * Resolve (once) the ENVIRONMENT this instance must be relaunched into (#776),
 * memoized on the ProcessInfo so the pre-stop preflight and the post-stop spawn
 * can never disagree: whatever assessRelaunch approved is exactly what gets
 * spawned. The paths handed to the resolver are the ones the relaunch actually
 * uses (resolved script, interpreter, cwd) plus the raw argv[0], so a launcher
 * layout is recognized whichever of them carries it.
 */
function ensureLaunchEnvPlan(
  info: ProcessInfo,
  cmd: { exe: string; args: string[]; cwd?: string },
): LaunchEnvResolution {
  if (info.envPlan) return info.envPlan;
  const plan = resolveLaunchEnvironment({
    paths: [cmd.args[0], cmd.exe, cmd.cwd, info.argv[0], info.liveCwd],
    liveEnv: info.liveEnv,
  });
  info.envPlan = plan;
  return plan;
}

function fileExists(p: string | undefined): boolean {
  if (!p) return false;
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/**
 * config.comfyuiPath as a spawn cwd — only when it is an ABSOLUTE path to an
 * existing DIRECTORY. A stale, relative, or nonexistent COMFYUI_PATH passed as
 * cwd would ENOENT the spawn after the server was already stopped (#711), and
 * a path that resolves to a regular FILE fails the same way (ENOTDIR) — both
 * recreate the lost-server failure this guard exists to prevent (codex gate).
 * Callers then omit cwd and the child inherits this process's (existing)
 * working dir.
 */
function configuredInstallCwd(): string | undefined {
  if (!config.comfyuiPath || !isAbsolute(config.comfyuiPath)) return undefined;
  try {
    return statSync(config.comfyuiPath).isDirectory()
      ? config.comfyuiPath
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stricter than fileExists: the path must be a REGULAR FILE, not a directory.
 * Used to unlock the atomic live-cwd relaunch (#535) — a directory named
 * `main.py`, or a directory at the interpreter path, exists per existsSync yet
 * cannot be exec'd, so validating it as a file keeps the stop refuse-safe. NOT a
 * drop-in for fileExists elsewhere: a macOS `.app` bundle is a directory.
 */
function isRegularFile(p: string | undefined): boolean {
  if (!p) return false;
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** True when a token looks like a filesystem path (has a separator or a drive). */
function looksLikePath(s: string): boolean {
  return /[\\/]/.test(s) || /^[a-zA-Z]:/.test(s);
}

/** Quote a token only when it needs it, so the hint can be pasted into a shell. */
function quoteToken(token: string): string {
  return /[\s"]/.test(token) ? `"${token.replace(/"/g, '\\"')}"` : token;
}

/**
 * Everything we know about how to restart this instance by hand, captured from a
 * LIVE process (#814/#767). Both sources are reported with their provenance rather
 * than merged: see RecoveryHint.
 */
function recoveryHint(info: ProcessInfo): RecoveryHint | undefined {
  const hint: RecoveryHint = {};
  if (info.osArgvExact && info.osArgv?.length) {
    hint.command = info.osArgv.map(quoteToken).join(" ");
  } else if (info.osCommandLine) {
    // Re-quoting a flattened reading would invent boundaries we do not know, so it is
    // passed through EXACTLY as the OS printed it and labelled as approximate.
    hint.command = info.osCommandLine;
    hint.command_flattened = true;
  }
  if (info.argv.length > 0) hint.server_argv = info.argv;
  if (info.liveCwd) hint.cwd = info.liveCwd;
  return hint.command || hint.server_argv || hint.cwd ? hint : undefined;
}

/** The sentence appended to a refusal so the user can act on it immediately. */
function describeRecovery(hint: RecoveryHint | undefined): string {
  if (!hint) return "";
  if (hint.command) {
    return (
      ` To start it by hand, run: ${hint.command}${
        hint.cwd ? ` (from ${hint.cwd})` : ""
      }.` +
      (hint.command_flattened
        ? " (This OS reports arguments flattened into one line, so any path containing" +
          " a space needs re-quoting before you run it.)"
        : "")
    );
  }
  if (hint.server_argv) {
    return ` The server reported these launch arguments: ${hint.server_argv
      .map(quoteToken)
      .join(" ")}${
      hint.cwd ? ` (from ${hint.cwd})` : ""
    } — note this is Python's sys.argv, so the interpreter that ran it is not part of it.`;
  }
  return "";
}

/** Injectable existence probe, so supervision can be driven without real pids. */
let processExistsOverride: ((pid: number) => boolean | undefined) | null = null;

/**
 * Does something hold this pid? TRI-STATE — see SupervisionEvidence.processExists.
 * EPERM is "exists but not ours to signal", which is still existence; anything else
 * unrecognised is "cannot tell" and must not be spent as either answer.
 */
function processExists(pid: number): boolean | undefined {
  if (processExistsOverride) return processExistsOverride(pid);
  if (!pid || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return undefined;
  }
}

/**
 * Will the Desktop supervisor bring this instance back after a Manager reboot?
 *
 * A Desktop instance is NEVER killed and relaunched by us (#400) — the Electron
 * shell owns it, so the restart path asks ComfyUI-Manager to re-exec the process and
 * depends on that shell being there to do it. #814 is the case where it was not: two
 * ComfyUI backends off one install, the shell that spawned the bound one had moved
 * on, the reboot stopped it, and nothing brought it back. The tool then said it
 * "couldn't confirm it came back" — a verdict computed AFTER the stop, about a stop
 * it should never have made.
 *
 * ONLY `supervised` proceeds. `unconfirmed` REFUSES, and the asymmetry with the rest
 * of this file is deliberate rather than an inconsistency (coordinator gate):
 *
 *   `listener_ownership` reports on an action that HAS ALREADY HAPPENED — the child
 *   was spawned, the server is answering — and only the DESCRIPTION of it is
 *   uncertain. Denying `started` there would turn an uncertain description into a
 *   false one, so uncertainty is DISCLOSED.
 *
 *   A reboot has NOT happened yet and cannot be undone. Uncertainty about whether
 *   anything will restart the process is uncertainty about whether the user still has
 *   a ComfyUI afterwards, so it is REFUSED.
 *
 * Refuse before, disclose after — the same principle pointed in opposite directions
 * by whether the irreversible step is still ahead.
 *
 * The earlier reading — that proceeding on `unconfirmed` preserved #400 — conflated
 * two different claims. #400 established that a Desktop process must never be KILLED
 * locally, because respawning the exe does not reliably bring the listener back. It
 * did not establish that an UNVERIFIED Manager stop is safe. Only the first is
 * settled, and refusing here does not touch it: the refusal leaves the server
 * RUNNING and points the user at the Desktop app, which restarts it reliably.
 */
function assessDesktopSupervision(info: ProcessInfo): {
  ok: boolean;
  reason?: string;
  supervision: SupervisorRelaunch;
} {
  const cannotAssess = (because: string): {
    ok: boolean;
    reason: string;
    supervision: SupervisorRelaunch;
  } => ({
    ok: false,
    supervision: unclassifiedSupervision(),
    reason:
      `this is a ComfyUI Desktop instance, and it could not be established that a Desktop app ` +
      `is still supervising it (${because}). A restart from here asks ComfyUI-Manager to STOP ` +
      `the process and depends on that supervisor to start it again — so without that, the ` +
      `stop could not be undone.`,
  });

  // A SHELL FOUND BY NAME IS NOT EVIDENCE ABOUT THIS PORT'S SERVER. When ComfyUI
  // could not be attributed to the port, the caller falls back to whatever Desktop
  // process is running anywhere on the machine. That pid is bound to no port and no
  // backend: a second, unrelated Desktop window would otherwise stand in as the
  // supervisor of an orphaned backend it has never heard of, and the reboot would
  // stop a server nothing restarts (codex gate round 9). There is nothing to classify
  // here — the premise is missing, not the evidence.
  if (info.pidFromDesktopScan) {
    return cannotAssess(
      `the server on port ${info.port} could not be identified, and the only ComfyUI Desktop ` +
        `process found (PID ${info.pid}) was located by scanning process names — nothing ties ` +
        `it to that port, so it cannot be shown to supervise the server this would stop`,
    );
  }
  // NO SPECIAL CASE FOR A MISSING PID. An early `ok: true` here would be one more
  // permissive exit skipping the guard, and an untestable one at that. The classifier
  // already handles pid 0 the way it handles any pid it cannot read — the identity
  // and parent reads come back empty and the verdict is `unconfirmed`, which now
  // refuses — so letting it fall through inherits a path that IS tested.
  const { verdict, because } = classifyDesktopSupervision({
    pid: info.pid,
    readParentPid,
    readIdentity: resolveProcessIdentity,
    processExists,
    isSupervisorProcess: isDesktopSupervisorProcess,
  });
  if (verdict === "supervised") return { ok: true, supervision: verdict };
  if (verdict === "abandoned") {
    return {
      ok: false,
      supervision: verdict,
      reason:
        `ComfyUI Desktop started the server on port ${info.port} (PID ${info.pid}), but no ` +
        `Desktop app is still supervising it — its parent process is gone. A restart from here ` +
        `asks ComfyUI-Manager to stop the process and relies on that supervisor to start it ` +
        `again, so it would be stopped and nothing would bring it back.`,
    };
  }
  return {
    ...cannotAssess(because ?? `the process tree above PID ${info.pid} could not be read`),
    supervision: verdict,
  };
}

/**
 * Can we actually relaunch this instance? A restart must be atomic-ish: if we
 * can't build (and validate) a relaunch command, we must NOT stop the running
 * server — losing a restart is cheap, losing the server is not (issues
 * #368/#370). For a Desktop app this also RESOLVES + validates the launcher exe
 * (mutating `info.desktopExePath`) so the subsequent spawn uses a real path
 * rather than a regex guess that never matched the current "Comfy Desktop"
 * branding. For a script-based install it confirms the resolved interpreter and
 * `main.py` exist on disk — catching a stale COMFYUI_PATH that points at an
 * install with no runnable server.
 */
function assessRelaunch(
  info: ProcessInfo,
  opts?: {
    /**
     * Also require that the launch ENVIRONMENT can be reproduced (#776). TRUE for
     * our own kill+relaunch, which spawns a brand-new process and must therefore
     * rebuild its environment. FALSE for an OUT-OF-BAND restart preflight (the
     * panel's ComfyUI-Manager reboot): Manager re-execs the SAME process, which
     * inherits its own environment, so the launcher environment is preserved for
     * free and refusing on it would only cost the user a working restart.
     */
    requireReproducibleEnv?: boolean;
  },
): { ok: boolean; reason?: string; advice?: string } {
  if (info.isDesktopApp) {
    if (IS_WIN) {
      const exe = fileExists(info.desktopExePath)
        ? info.desktopExePath
        : findDesktopExeFromCommonPaths();
      if (!exe || !fileExists(exe)) {
        return {
          ok: false,
          reason:
            "Could not determine (or locate on disk) the ComfyUI Desktop executable to relaunch.",
        };
      }
      info.desktopExePath = exe;
      return { ok: true };
    }
    // macOS: relaunch via `open -a`, which accepts an app bundle path or name.
    // Prefer a bundle that still exists on disk; fall back to a located one.
    const appPath = fileExists(info.desktopExePath)
      ? info.desktopExePath
      : findDesktopExeFromCommonPaths();
    if (!appPath || !fileExists(appPath)) {
      return {
        ok: false,
        reason:
          "Could not determine (or locate on disk) the ComfyUI Desktop app to relaunch.",
      };
    }
    info.desktopExePath = appPath;
    return { ok: true };
  }

  const cmd = resolveLaunchCommand(info);
  if (!cmd) {
    return {
      ok: false,
      reason:
        "Could not build a relaunch command from the running server's launch arguments.",
    };
  }
  if (looksLikePath(cmd.exe) && !fileExists(cmd.exe)) {
    return {
      ok: false,
      reason: `Resolved Python interpreter does not exist on disk: ${cmd.exe}.`,
    };
  }
  const script = cmd.args[0];
  if (script && /\.pyw?$/i.test(script)) {
    // We could only VALIDATE the script when it was resolved to an ABSOLUTE path
    // (either argv[0] was absolute, or resolveScriptAnchor anchored a relative
    // argv[0] to a canonical absolute install). A script still RELATIVE here means
    // the live-first anchor produced nothing absolute — i.e. a truly unresolvable
    // install (stale/relative COMFYUI_PATH, no saved workspace, no argv root). We
    // cannot confirm it exists, so REFUSE rather than kill a reachable server we
    // can't relaunch (#476/#426 refuse-safe; also covers a bare `main.py`).
    const scriptIsAbsolute =
      isAbsolute(script) ||
      /^[a-zA-Z]:[\\/]/.test(script) ||
      /^\\\\/.test(script);
    if (!scriptIsAbsolute || !fileExists(script)) {
      return {
        ok: false,
        reason:
          `Resolved ComfyUI script does not exist on disk: ${script} — ` +
          "could not locate the ComfyUI install; set COMFYUI_PATH or a default " +
          "workspace (COMFYUI_PATH may point at a stale/old install that has no " +
          "runnable server).",
      };
    }
  }
  // #776: the command is only half the relaunch. A launcher (Stability Matrix,
  // Pinokio) hands ComfyUI an environment we do NOT inherit — relaunching without
  // it starts a process that dies during import and leaves the server DOWN. Decide
  // it HERE, pre-stop, so an irreproducible environment refuses while the server is
  // still running rather than after it has been killed.
  if (opts?.requireReproducibleEnv) {
    const envPlan = ensureLaunchEnvPlan(info, cmd);
    if (!envPlan.reproducible) {
      return {
        ok: false,
        reason: envPlan.reason ?? envPlan.info.note,
        advice: envPlan.advice,
      };
    }
  }
  return { ok: true };
}

/**
 * Resolve the running instance to control: ComfyUI's /system_stats argv + the
 * PID on the port, falling back to OS-level Desktop-app detection when the API
 * and port are unreachable. Returns null when nothing can be found.
 */
async function acquireProcessInfo(): Promise<{
  info: ProcessInfo | null;
  diagnostic?: string;
}> {
  try {
    return { info: await gatherProcessInfo() };
  } catch (err) {
    // #449: the server answered /system_stats but we could not map its port to
    // a PID. Do NOT fall through to killing a Desktop shell we can't confirm
    // owns :PORT — surface the diagnostic and leave everything untouched.
    if (
      err instanceof ProcessControlError &&
      (err.reachableButNoPid || err.identityAmbiguous)
    ) {
      return { info: null, diagnostic: err.message };
    }
    const desktopPids = findDesktopAppPids();
    if (desktopPids.length > 0) {
      logger.info(
        `API unreachable but found Desktop app PIDs: ${desktopPids.join(", ")}`,
      );
      return {
        info: {
          pid: desktopPids[0],
          port: config.resolvedPort,
          argv: [],
          isDesktopApp: true,
          desktopExePath: findDesktopExeFromCommonPaths(),
          // FOUND BY NAME, NOT BY PORT — nothing ties this shell to the server on
          // config.resolvedPort. Recorded so the restart preflight cannot mistake
          // "a Desktop app is running" for "this Desktop app supervises that server".
          pidFromDesktopScan: true,
        },
      };
    }
    // Genuinely down (not reachable, no Desktop shell): let callers use their
    // existing friendly "no process" message.
    return { info: null };
  }
}

/**
 * TRUE while a deliberate stop is mid-kill. The supervisor must not read the exit
 * WE are causing as a crash and respawn into it — that window exists because the
 * supervisor teardown deliberately happens AFTER the kill returns, so that a kill
 * which THREW leaves supervision intact (coordinator gate P1(3)).
 */
let deliberateStop = false;

function handleSupervisedChildStop(
  child: ChildProcess,
  reason: {
    code?: number | null;
    signal?: NodeJS.Signals | null;
    error?: ChildProcessErrorDetails;
  },
): void {
  if (supervisedChild !== child) return;
  // A stop WE are performing is not a crash — never respawn into it.
  if (deliberateStop) return;
  detachSupervisor();

  // The supervised ComfyUI is GONE (crash/exit), whether or not we go on to
  // respawn it. Whatever Manager dialect we classified belonged to that dead
  // instance, and a respawn can come back as a different Manager generation on
  // the same URL — re-probe rather than trust it (#646).
  resetManagerApiCache("supervised comfyui exited");

  if (!lastProcessInfo) return;
  const currentPolicy = getRestartPolicy();
  if (!currentPolicy.enabled) return;

  if (!rememberRestartAttempt(currentPolicy)) {
    logger.warn("ComfyUI exited unexpectedly; auto-restart limit reached", {
      code: reason.code,
      signal: reason.signal,
      error: reason.error,
      maxRestarts: currentPolicy.maxRestarts,
      windowMs: currentPolicy.windowMs,
    });
    return;
  }

  logger.warn("ComfyUI exited unexpectedly; restarting", {
    code: reason.code,
    signal: reason.signal,
    error: reason.error,
    restartCount: supervisorRestartCount,
    maxRestarts: currentPolicy.maxRestarts,
  });

  const restarted = spawnFromProcessInfo(lastProcessInfo);
  if (!restarted) {
    logger.warn("Could not auto-restart ComfyUI because launch info was incomplete");
    return;
  }
  restarted.child.unref();
  if (!lastProcessInfo.isDesktopApp) adoptLaunchedChild(restarted.child);
  superviseChild(restarted.child, lastProcessInfo);
}

function captureChildProcessError(
  child: ChildProcess,
): Promise<ChildProcessErrorDetails> {
  return new Promise((resolve) => {
    child.once("error", (err) => {
      const error = childProcessErrorDetails(err);
      logger.error("ComfyUI child process emitted an error", { error });
      resolve(error);
    });
  });
}

function superviseChild(child: ChildProcess, info: ProcessInfo): void {
  detachSupervisor();
  const policy = getRestartPolicy();
  if (!policy.enabled || info.isDesktopApp) return;

  supervisedChild = child;
  supervisedExitHandler = (code, signal) => {
    handleSupervisedChildStop(child, { code, signal });
  };
  supervisedErrorHandler = (err) => {
    const error = childProcessErrorDetails(err);
    logger.error("ComfyUI child process emitted an error", { error });
    handleSupervisedChildStop(child, { error });
  };
  child.on("exit", supervisedExitHandler);
  child.once("error", supervisedErrorHandler);
}

// ---------------------------------------------------------------------------
// Gather process info from running ComfyUI
// ---------------------------------------------------------------------------

/**
 * Re-ask the server who it is, now that a pid is in hand, and require the answer
 * to be unchanged AND that pid to still own the port.
 *
 * Returns:
 *   "confirmed" — same argv, same port owner. The pid and the HTTP response are
 *                 bound to each other as tightly as observation allows.
 *   "changed"   — the server answered with DIFFERENT launch arguments, or the port
 *                 changed hands. Positive evidence of substitution.
 *   "unknown"   — the re-fetch failed (transport hiccup). Absence of evidence, and
 *                 deliberately NOT treated as evidence of absence: a transient
 *                 network error must not refuse a restart that would work.
 */
async function reconfirmAnsweringServer(
  argv: string[],
  pid: number,
  port: number,
): Promise<"confirmed" | "changed" | "unknown"> {
  let secondArgv: string[];
  try {
    const stats = await getSystemStats();
    secondArgv = stats.system.argv ?? [];
  } catch {
    return "unknown";
  }
  // An empty second answer says nothing about identity.
  if (secondArgv.length === 0 && argv.length === 0) return "unknown";
  const same =
    secondArgv.length === argv.length &&
    secondArgv.every((token, i) => token === argv[i]);
  if (!same) return "changed";
  let ownerNow: number | null = null;
  try {
    ownerNow = findPidByPort(port);
  } catch {
    return "unknown";
  }
  if (ownerNow == null) return "unknown";
  return ownerNow === pid ? "confirmed" : "changed";
}

async function gatherProcessInfo(): Promise<ProcessInfo> {
  const port = config.resolvedPort;

  // 1. Get argv from /system_stats, BRACKETED by port-owner lookups.
  //
  // The argv and the pid are two separate observations, and the whole hazard is
  // that they may describe two different processes: A answers, A exits, B binds
  // the port, and the pid we then look up is B's — after which B is "identified"
  // from A's answer and is what a restart would kill. Re-asking afterwards does
  // NOT settle this: it only proves the CURRENT owner is self-consistent, which a
  // replacement with identical argv satisfies perfectly (codex gate).
  //
  // So carry something across the two observations that a substitution cannot
  // reproduce: the identity of the port owner BEFORE the HTTP call. If the same
  // pid still owns the port afterwards, the answer we hold was produced while that
  // one process held the socket throughout.
  // The bracket is REQUIRED, not best-effort (codex gate): if the first lookup
  // came back empty we have no anchor, and A-answers-then-B-takes-the-port with
  // identical argv would sail through every later self-consistent check. A single
  // flaky lookup is retried; a bracket we still cannot close refuses.
  //
  // Both ends of the bracket compare a full process IDENTITY, not a pid number:
  // pid equality across a window is exactly what pid REUSE defeats (A owns 4321,
  // answers, exits; B inherits 4321 before the closing lookup and the bracket would
  // close on the number alone). So each end reads pid + creation time together, and
  // an end whose stamp cannot be read is "did not observe", never "observed the
  // same" (codex gate).
  //
  // `missing` records WHICH capability was unavailable, so a refusal can name it
  // rather than leaving the user to guess. This is a real, if narrow, platform
  // limitation: a host that cannot report process creation times cannot have its
  // restart verified, and we would rather say so than kill on an unverified pairing.
  let missingCapability: string | undefined;
  const observeOwner = (): { pid: number; startedAt: string } | null => {
    let owner: number | null = null;
    try {
      owner = findPidByPort(port);
    } catch {
      owner = null;
    }
    if (owner == null) {
      missingCapability =
        `the process listening on port ${port} could not be identified (no usable ` +
        `port-owner lookup — on Linux this needs \`lsof\`, on Windows \`netstat\`/PowerShell)`;
      return null;
    }
    const startedAt = resolveProcessIdentity(owner)?.startedAt;
    if (!startedAt) {
      missingCapability =
        `the creation time of PID ${owner} could not be read, so that number cannot be ` +
        `tied to a specific process (this host does not expose process start times to us)`;
      return null;
    }
    return { pid: owner, startedAt };
  };

  let argv: string[] = [];
  let pid: number | null = null;
  let bracketed = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = observeOwner();
    try {
      const stats = await getSystemStats();
      argv = stats.system.argv ?? [];
    } catch {
      argv = [];
      logger.warn("Could not fetch system_stats — will rely on PID detection");
    }
    const after = observeOwner();
    pid = after?.pid ?? before?.pid ?? null;
    if (pid == null) {
      try {
        pid = findPidByPort(port);
      } catch {
        pid = null;
      }
    }
    // No answer to bind means there is nothing to mis-bind: the pid-only paths
    // below (including #449's reachable-but-unmapped) own that case.
    if (argv.length === 0) break;
    if (before && after) {
      if (before.pid !== after.pid || before.startedAt !== after.startedAt) {
        const err = new ProcessControlError(
          `The process listening on port ${port} changed while ComfyUI was being identified ` +
            `(PID ${before.pid} answered; PID ${after.pid} holds the port now${
              before.pid === after.pid ? ", and it is a different process reusing that number" : ""
            }). Nothing was stopped: the launch arguments we hold describe the instance that has ` +
            `gone, not the one running now. Re-run once the server has settled.`,
        );
        err.identityAmbiguous = true;
        throw err;
      }
      bracketed = true;
      break;
    }
    // One side of the bracket was unobservable — retry once before giving up.
  }
  if (argv.length > 0 && pid != null && !bracketed) {
    const err = new ProcessControlError(
      `ComfyUI answered on port ${port}, but its answer could not be tied to PID ${pid}: ` +
        `${missingCapability ?? "the port owner's identity could not be observed on both sides of the request"}. ` +
        `Nothing was stopped — killing a process we cannot identify risks taking down the wrong ` +
        `one. Restart ComfyUI from the launcher that owns it, or install the missing tool ` +
        `(\`lsof\` on Linux) and try again.`,
    );
    err.identityAmbiguous = true;
    throw err;
  }
  if (!pid) {
    // Liveness is the reachable SERVER, not only a local PID scan. If
    // /system_stats just answered (argv populated) yet we still can't map the
    // listening socket to a PID, say so precisely instead of claiming the
    // process doesn't exist (issue #449).
    if (argv.length > 0) {
      const reachableErr = new ProcessControlError(
        `ComfyUI is reachable on port ${port} but its listening process could not ` +
          `be mapped to a local PID (port-owner lookup failed). The server was left ` +
          `untouched. On a portable/embedded-Python install, restart it via its ` +
          `launcher/console or trigger a ComfyUI-Manager reboot.`,
      );
      reachableErr.reachableButNoPid = true;
      throw reachableErr;
    }
    throw new ProcessControlError(
      `No process found listening on port ${port}. Is ComfyUI running?`,
    );
  }

  // THE SERVER COULD NOT SAY WHAT IT IS RUNNING — ask the OS (#767).
  //
  // An empty `argv` means `/system_stats` did not answer: the server is wedged
  // (a CUDA OOM is the reported case) or otherwise unreachable, which is EXACTLY
  // when a user reaches for stop/restart. Everything downstream then had nothing to
  // relaunch from, so the stop went ahead and the start could not follow. The OS has
  // the command line throughout.
  //
  // Read here, while the pid is alive, for the same reason `liveCwd` is: the process
  // table entry is gone the instant the kill lands.
  const osIdentity = argv.length === 0 ? resolveProcessIdentity(pid) : undefined;
  const osArgv = osIdentity?.argv;
  const osArgvExact = osIdentity?.argvFidelity === "exact";
  const osCommandLine = osIdentity?.commandLine;

  // Desktop is decided from WHATEVER account of the process we have. Deciding it
  // from `argv` alone meant an unreachable Desktop instance (argv empty) classified
  // as an ordinary Python install — and would then be KILLED, which is the one thing
  // the Desktop path exists to never do (#400).
  const identifyingArgv = argv.length > 0 ? argv : (osArgv ?? []);
  const desktop = isDesktopApp(identifyingArgv);
  const desktopExe = desktop ? findDesktopExePath(identifyingArgv) : undefined;
  // Capture the live process cwd NOW, while the pid is guaranteed alive — the
  // `/proc/<pid>/cwd` symlink is gone the instant a later stop kills it (#535).
  const liveCwd = desktop ? undefined : resolveLiveProcessCwd(pid);
  // Same live-only window for the ENVIRONMENT (#776): read it now, while the pid
  // is guaranteed alive, so a relaunch can reproduce the launcher environment the
  // server was actually started with instead of substituting the orchestrator's.
  // The pid's IDENTITY (creation time), CORROBORATED against the argv the server
  // itself reported — so a pid recycled between the port lookup and this read is
  // never bound to, however self-consistent its own later re-reads would be.
  // POSITIVE counter-evidence refuses outright: if the OS says the process holding
  // our port is running something other than the ComfyUI that just answered us,
  // then the answer and the pid describe different processes, and everything built
  // on that pairing — the environment we would reproduce, the argv we would
  // relaunch, the process we would KILL — is about the wrong one. Applies whatever
  // the argv looked like, Desktop included (codex gate).
  const corroboration = resolveCorroboratedIdentity(pid, argv);
  if (corroboration.kind === "mismatch") {
    const err = new ProcessControlError(
      `The process listening on port ${port} (PID ${pid}) is not running the ComfyUI that ` +
        `answered /system_stats — the OS reports its command line as "${corroboration.commandLine}", ` +
        `which does not match that server's launch arguments. Nothing was stopped: acting on this ` +
        `pairing would control the wrong process. Re-run once the server has settled.`,
    );
    err.identityAmbiguous = true;
    throw err;
  }
  const startedAt = desktop
    ? undefined
    : corroboration.kind === "confirmed"
      ? corroboration.identity.startedAt
      : // THE WEDGED PATH KEEPS ITS STAMP (codex gate round 5). With no answer from
        // the server there is nothing to corroborate the pid against, and the
        // corroboration therefore comes back `unknown` — but the pid's own creation
        // time was read all the same, and that stamp is precisely what pid REUSE
        // defeats. Discarding it would leave the pre-kill check with nothing but
        // numeric pid/port equality, so a replacement instance that rebound the port
        // after inheriting the number would be killed as if it were the one we
        // identified. Only reachable when the server said nothing: a corroboration
        // that came back `mismatch` has already thrown above.
        osIdentity?.startedAt;

  // BIND THE PID TO THE PROCESS THAT ANSWERED (coordinator gate P1(1)).
  //
  // `argv` came from an HTTP response; the pid came from a port lookup made
  // AFTERWARDS. Nothing so far rules out: ComfyUI A answers /system_stats, exits,
  // and ComfyUI B takes the port before the lookup — B is then "identified" from
  // A's answer and is what we would kill. A creation stamp cannot see that: it
  // only proves B was stable AFTER the lookup.
  //
  // So close the loop against the observation itself: ask the server again, now
  // that we hold a pid, and require the SAME argv to come back AND the same pid to
  // still own the port. A substitution by a differently-launched instance changes
  // the argv and is caught; a transport failure proves nothing and is not treated
  // as evidence either way.
  //
  // Runs for DESKTOP too (codex gate): `desktop` is itself derived from the FIRST,
  // possibly stale argv, so skipping the recheck there is how a Desktop answer from
  // A gets a Manager reboot fired at a non-Desktop B that took the port.
  const recheck = await reconfirmAnsweringServer(argv, pid, port);
  if (recheck === "changed") {
    const err = new ProcessControlError(
      `The ComfyUI answering on port ${port} changed while it was being identified ` +
        `(a different instance now owns the port, or reports different launch ` +
        `arguments). Nothing was stopped. Re-run once the server has settled.`,
    );
    err.identityAmbiguous = true;
    throw err;
  }

  // Bound to that identity - never adopted from a pid we cannot still prove.
  const liveEnv = desktop
    ? undefined
    : captureVerifiedLiveEnv(pid, startedAt, argv);

  return {
    pid,
    port,
    argv,
    osArgv,
    osArgvExact,
    osCommandLine,
    isDesktopApp: desktop,
    desktopExePath: desktopExe,
    liveCwd,
    liveEnv,
    startedAt,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function stopComfyUI(preInfo?: ProcessInfo): Promise<StopResult> {
  if (isRemoteMode()) {
    throw new ProcessControlError(
      "stop_comfyui operates on the local machine's ComfyUI process and is not " +
        "available when targeting a remote instance via --comfyui-url.",
    );
  }
  logger.info("Stopping ComfyUI...");

  // Gather info before we kill it (or reuse the caller's pre-validated info so a
  // relaunch preflight in restartComfyUI is not discarded).
  let info = preInfo ?? null;
  let acquireDiagnostic: string | undefined;
  if (!info) {
    const acquired = await acquireProcessInfo();
    info = acquired.info;
    acquireDiagnostic = acquired.diagnostic;
  }
  if (!info) {
    return {
      stopped: false,
      message:
        acquireDiagnostic ??
        `No ComfyUI process found on port ${config.resolvedPort}. Is ComfyUI running?`,
      has_restart_info: false,
    };
  }

  // LAST-MOMENT IDENTITY CHECK: the pid was resolved before the relaunch preflight
  // ran, and a pid is not a process identity. If the server exited in that window
  // and the OS recycled the number, killing it would destroy an unrelated program.
  // Refuse instead - nothing has been touched yet, so this costs a restart, never
  // the server.
  //
  // ORDERING IS LOAD-BEARING (coordinator gate): this runs BEFORE the supervisor
  // teardown below. A refusal leaves a still-RUNNING server, and tearing down its
  // crash supervision first would silently disarm auto-restart for a server we
  // then declined to touch — turning a safe refusal into a later lost server.
  const identity = processIdentityStillValid(info);
  if (!identity.ok) {
    return {
      stopped: false,
      message:
        `Refusing to stop: ${identity.reason}. Nothing was killed. ` +
        "Re-run once ComfyUI is running again (or start it with start_comfyui).",
      has_restart_info: false,
    };
  }

  logger.info("Captured process info", {
    pid: info.pid,
    port: info.port,
    isDesktopApp: info.isDesktopApp,
    argv: info.argv.join(" "),
  });

  // CAN THIS BE STARTED AGAIN? Asked BEFORE the kill, and answered honestly (#767).
  //
  // The stop used to report `has_restart_info: true` on the strength of having
  // stored a ProcessInfo — which is true even when that info holds nothing runnable.
  // A user recovering a wedged server was told the restart information was there,
  // and `start_comfyui` then answered "No command-line info captured from previous
  // run". By then the server was gone.
  //
  // A REFUSAL is reserved for the genuinely unrecoverable case: no launch command
  // from the server, none from the OS, nothing to tell the user to run. Then the stop
  // is a one-way door and it is not ours to walk through. When a command WAS observed
  // the stop proceeds — `stop_comfyui` is an explicit instruction to stop, and a
  // wedged server is precisely when someone means it — but `has_restart_info` states
  // whether we can do the starting, and the hint says how to do it by hand.
  //
  // `requireReproducibleEnv` is deliberately NOT set here, and the distinction is the
  // point: this flag answers "is there a command to run?", which is what #767 was
  // about and what start_comfyui needs to exist at all. An irreproducible launcher
  // environment is a different, weaker fact — the spawn still happens, it may simply
  // fail during import — and it is reported as its own caveat below rather than
  // collapsed into "there is no restart information", which would say something
  // untrue about a case where the command is right there.
  const relaunch = assessRelaunch(info);
  // Resolved EXPLICITLY rather than read off `info.envPlan`, which is only populated
  // by whichever caller happened to ask for it — a caveat that appears when the stop
  // came through restartComfyUI and vanishes when the same install is stopped
  // directly would be worse than no caveat at all.
  let envPlan: LaunchEnvResolution | undefined;
  if (relaunch.ok && !info.isDesktopApp) {
    const cmd = resolveLaunchCommand(info);
    if (cmd) envPlan = ensureLaunchEnvPlan(info, cmd);
  }
  const hint = recoveryHint(info);
  if (!relaunch.ok && !hint) {
    return {
      stopped: false,
      has_restart_info: false,
      relaunch_blocked: relaunch.reason,
      message:
        `Refusing to stop ComfyUI (PID ${info.pid}): ${relaunch.reason} Nothing was killed — ` +
        `and nothing was observed about how this server was launched, so stopping it would ` +
        `leave you with no way to bring it back, by this tool or by hand. Stop it from the ` +
        `launcher/console that owns it instead.`,
    };
  }

  // Remember HOW to relaunch before doing anything irreversible. Saving this only
  // after a committed stop meant that any later refusal — including one taken while
  // the server may already be dead — left `start_comfyui` with no launch info to
  // recover from (codex gate). It is only a record of what we observed; a start
  // still re-validates and refuses to double-launch onto an occupied port.
  lastProcessInfo = info;

  // Kill process tree (for Desktop app, kill the Electron shell too).
  //
  // A KILL THAT THREW IS NOT A COMMITTED STOP (coordinator gate P1(3)). `taskkill`
  // / `kill` fail for ordinary reasons — access denied above all — and the server
  // is then still running. Tearing supervision down first would disarm auto-restart
  // for a server we did not manage to stop, which is the same "safe refusal turned
  // into a later lost server" bug one step further along. So the teardown happens
  // ONLY after the kill returns, and a throw leaves every guarantee intact.
  //
  // `deliberateStop` covers the tiny window in between: the kill can deliver our
  // supervised child's `exit` before the teardown runs, and the supervisor must not
  // read a stop we asked for as a crash to recover from.
  deliberateStop = true;
  try {
    if (info.isDesktopApp) {
      killDesktopApp(info.pid);
    } else {
      killProcessTree(info.pid);
    }
  } catch (err) {
    deliberateStop = false;
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("Stop aborted: the kill failed, so nothing was torn down", {
      pid: info.pid,
      error: msg,
    });
    return {
      stopped: false,
      message:
        `Could not stop ComfyUI (PID ${info.pid}): ${msg}. The server was left as it was — ` +
        "its crash supervision and launch record are untouched. This is usually a " +
        "permissions problem: stop it from the launcher/console that owns it.",
      has_restart_info: false,
    };
  }

  // A KILL THAT RETURNED IS STILL NOT PROOF THE PROCESS DIED (codex gate). On
  // POSIX the forced `kill -9` is issued through a shell whose failure is swallowed
  // wholesale — an ignored SIGTERM followed by a failed SIGKILL looks exactly like
  // success from here. The port is the observable that settles it: wait for it to
  // be released, and let the timeout DECIDE rather than merely warn.
  let blockedReason: string | undefined;
  let unverified: string | undefined;
  try {
    await waitForPortFree(info.port);
  } catch {
    // Timed out. Three outcomes, and they must NOT be conflated:
    //   • still held by OUR target → the kill did not work, so the server is UP.
    //     Refusing is safe AND correct: it costs a restart, never the server.
    //   • held by somebody else → our target did die and a successor took the port.
    //   • could not be determined → see below.
    const probe = probePortOwner(info.port);
    if (probe.state === "owned" && probe.pid === info.pid) {
      blockedReason =
        `PID ${info.pid} still holds port ${info.port} after the kill was issued, so it is ` +
        `still running`;
    } else if (probe.state === "unknown") {
      // We CANNOT tell whether the process died — and unlike every other
      // uncertainty in this file, refusing here does not restore anything: the kill
      // has already been issued. If it worked, refusing leaves the user's server
      // dead AND unrelaunched, which is the one outcome this whole issue exists to
      // prevent. So we commit and let the relaunch run; if the kill in fact failed,
      // the old server is still serving and the relaunch simply finds the port
      // taken (reported honestly as `not-ours`). Proceed — and say it is unverified.
      unverified =
        `the port could not be checked after the kill (${probe.reason}), so it is not ` +
        `confirmed that PID ${info.pid} exited`;
      logger.warn("Stop committed without port verification", {
        pid: info.pid,
        port: info.port,
        reason: probe.reason,
      });
    } else {
      logger.warn(
        "Port did not free in time, but it is no longer held by the process we killed",
        { pid: info.pid, owner: probe.state === "owned" ? probe.pid : "(free)" },
      );
    }
  }
  if (blockedReason) {
    deliberateStop = false;
    logger.warn("Stop aborted before commit", { pid: info.pid, port: info.port, blockedReason });
    return {
      stopped: false,
      message:
        `Could not stop ComfyUI: ${blockedReason}. Nothing was torn down — its crash ` +
        `supervision and launch record are untouched. Stop it from the launcher/console ` +
        `that owns it.`,
      has_restart_info: false,
    };
  }

  // COMMITTED — the process is gone, or (when `unverified`) the kill has been
  // issued and we have chosen going forward over a refusal that could not restore
  // anything. Only now may we drop supervision.
  detachSupervisor();
  // The server we may have launched is going away — clear the shares-our-env flag so
  // a differently-launched successor doesn't inherit env-trust it shouldn't (#633 P1b).
  // Forget the recorded interpreter too: a stop was requested, so the launch record
  // must not outlive the process it describes (#401).
  recordedLaunchChild = undefined;
  resetLocalComfyUILaunchState();
  clearLaunchedInterpreter();
  deliberateStop = false;

  // Reset the WebSocket client singleton + the memoized /object_info —
  // a restart is exactly when the node set may have changed. The detected
  // ComfyUI-Manager API dialect is live-derived the same way: the instance that
  // comes back on this port can be a different Manager generation (a 3.x→4.x
  // upgrade, or dropping --enable-manager-legacy-ui) at an unchanged URL, and a
  // stale dialect misroutes every later Manager call (#646).
  resetClient();
  resetObjectInfoCache();
  resetManagerApiCache("comfyui stopped");

  return {
    stopped: true,
    message:
      `ComfyUI (PID ${info.pid}) stopped on port ${info.port}` +
      (unverified ? ` — NOTE: ${unverified}; continuing so the server can be brought back.` : "") +
      // Said PLAINLY and up front, not left to a boolean the caller may not read:
      // start_comfyui will not be able to do this, so the human has to.
      (relaunch.ok
        ? // A command exists, but the environment it was launched into may not be
          // reproducible — a weaker claim, stated as one.
          envPlan && !envPlan.reproducible
          ? ` NOTE: ${envPlan.reason ?? envPlan.info.note} start_comfyui will still try, but the relaunch may fail during import.` +
            describeRecovery(hint)
          : ""
        : ` WARNING: start_comfyui will NOT be able to bring this back — ${relaunch.reason}` +
          describeRecovery(hint)),
    // The one claim #767 was about: it now means a relaunch command was built AND
    // validated, not merely that some process info was stored.
    has_restart_info: relaunch.ok,
    relaunch_blocked: relaunch.ok ? undefined : relaunch.reason,
    restart_hint: hint,
    auto_restart: supervisorResult(info),
    unverified_exit: unverified,
  };
}

export async function startComfyUI(): Promise<StartResult> {
  if (isRemoteMode()) {
    throw new ProcessControlError(
      "start_comfyui launches ComfyUI on the local machine and is not " +
        "available when targeting a remote instance via --comfyui-url.",
    );
  }
  const port = config.resolvedPort;

  // Check if already running. TRI-STATE: "the lookup could not run" is NOT "the
  // port is free". Collapsing them let us spawn into a port the old server may
  // still hold, and then report `started:true` because readiness reached THAT
  // server before the new child's bind failure surfaced — a restart claimed on
  // evidence nobody had (codex gate P1-c).
  const preLaunchProbe = probePortOwner(port);
  if (preLaunchProbe.state === "owned") {
    return {
      started: false,
      message: `ComfyUI is already running on port ${port} (PID ${preLaunchProbe.pid})`,
      pid: preLaunchProbe.pid,
      // Something is serving the port and we never got as far as spawning. We did
      // not classify a launch of ours, so we may not name a definite verdict.
      listener_ownership: unclassifiedOwnership(),
    };
  }
  /** Was the port OBSERVED free before we spawned? `false` = we could not tell. */
  const portObservedFreeBeforeLaunch = preLaunchProbe.state === "free";
  if (!portObservedFreeBeforeLaunch) {
    logger.warn(
      "Could not determine whether the port was free before launching — a start will not be claimed on readiness alone",
      { port, reason: preLaunchProbe.state === "unknown" ? preLaunchProbe.reason : "" },
    );
  }

  let info = lastProcessInfo;
  if (!info) {
    // No saved info — try to detect and launch the Desktop app
    const desktopExe = findDesktopExeFromCommonPaths();
    if (desktopExe) {
      logger.info(`No saved process info, but found Desktop app at: ${desktopExe}`);
      info = {
        pid: 0,
        port,
        argv: [],
        isDesktopApp: true,
        desktopExePath: desktopExe,
      };
    } else {
      return {
        started: false,
        message:
          "No previous process info and could not find ComfyUI Desktop app. Start ComfyUI manually.",
        listener_ownership: unclassifiedOwnership(),
      };
    }
  }

  logger.info("Starting ComfyUI...", {
    isDesktopApp: info.isDesktopApp,
    argv: info.argv.join(" "),
  });

  const launched = spawnFromProcessInfo(info);
  if (!launched) {
    return {
      started: false,
      message: info.isDesktopApp
        ? "Could not determine ComfyUI Desktop executable path. Please start it manually."
        : "No command-line info captured from previous run. Start ComfyUI manually.",
      auto_restart: supervisorResult(info),
      listener_ownership: unclassifiedOwnership(),
    };
  }
  const spawnError = captureChildProcessError(launched.child);
  // TRUTHFULNESS WATCH (codex gate): remember whether the process WE launched died
  // before the readiness poll finished. Readiness only proves that SOMETHING answers
  // on the port — it cannot tell our relaunch apart from an external
  // launcher/supervisor that grabbed the port meanwhile. Recording the exit (rather
  // than racing it) changes no timing and no outcome; it only lets the report name
  // what actually happened instead of implying our child is the healthy server.
  let launchedChildExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  launched.child.once("exit", (code, signal) => {
    launchedChildExit = { code, signal };
  });
  // Latched SEPARATELY from the readiness race below: if another launcher's server
  // answers first, the race resolves on readiness and the spawn failure would never
  // be consulted — leaving a launch that never happened reported as an unconfirmed
  // success (codex gate).
  let launchedSpawnFailed = false;
  launched.child.once("error", () => {
    launchedSpawnFailed = true;
  });
  launched.child.unref();
  lastProcessInfo = info;
  superviseChild(launched.child, info);
  // A python `spawn` inherits our process.env, so this local server shares our
  // environment — mark it so its live extra_model_paths $VAR references may be
  // expanded against process.env (#633 P1b). A Desktop-app launch's env is NOT
  // guaranteed to be ours, so it stays fail-closed (unmarked).
  if (!info.isDesktopApp) {
    adoptLaunchedChild(launched.child);
    // Revoke env-trust the instant OUR launched child goes away — on EXIT and on a
    // failed spawn (ERROR): a successor server that later takes the port may have a
    // DIFFERENT env, so it must NOT inherit our trust (#633 P1b stale-flag). Fail
    // closed the moment we no longer own the process (`error` covers the spawn_error
    // path where `exit` may not fire). adoptLaunchedChild wires both handlers.
  }

  // A NEW server instance is coming up on this port — whatever Manager dialect we
  // classified belonged to whatever ran here before (start_comfyui is also
  // reachable without a preceding stopComfyUI, e.g. after an external kill or a
  // Manager upgrade), so re-probe rather than trust it (#646).
  resetManagerApiCache("comfyui started");

  // Wait for API to become ready
  const startupResult = await Promise.race([
    waitForApiReady().then((readiness) => ({ readiness })),
    spawnError.then((error) => ({ spawn_error: error })),
  ]);
  if ("spawn_error" in startupResult) {
    return {
      started: false,
      ready: false,
      message:
        `ComfyUI process failed to launch: ${startupResult.spawn_error.message}`,
      spawn_error: startupResult.spawn_error,
      auto_restart: supervisorResult(info),
      launch_env: launchEnvInfo(info),
      // The spawn failed outright: whatever may be serving that port, it is
      // certainly not something this call started.
      listener_ownership: unclassifiedOwnership(),
    };
  }

  const readiness = startupResult.readiness;
  if (!readiness.ready) {
    const env = launchEnvInfo(info);
    return {
      started: false,
      ready: false,
      readiness,
      // TRUTHFUL FAILURE (#776): the process was spawned but never answered, so
      // ComfyUI is DOWN. Report that plainly — and name the environment it was
      // launched into, which is the first thing to check when a relaunch of an
      // otherwise-healthy install fails during import.
      message:
        `ComfyUI process was launched but the API did not become ready after ${readiness.waited_ms}ms (${readiness.attempts}/${readiness.max_tries} probes). Check the ComfyUI logs.` +
        describeLaunchedChildExit(launchedChildExit) +
        (env ? ` Launch environment: ${env.note}.` : "") +
        launchEnvWarning(info),
      auto_restart: supervisorResult(info),
      launch_env: env,
      // Nothing is serving the port, so there is no listener to attribute — the
      // down state is already carried by started:false / ready:false.
      listener_ownership: unclassifiedOwnership(),
    };
  }

  const newPid = findPidByPort(port);
  const env = launchEnvInfo(info);
  // The API just answered, so ask it what it is running. This is the one identity
  // signal that needs no pid at all, and it is what keeps hosts with an unusable
  // port-owner lookup from getting a permanent "cannot tell".
  let servingArgv: string[] | undefined;
  try {
    servingArgv = (await getSystemStats()).system.argv ?? undefined;
  } catch {
    servingArgv = undefined;
  }
  // Is the healthy listener actually OURS?
  //   • A Desktop launch is UNDECIDABLE by design: we spawn the Electron shell (or
  //     macOS `open`), and the process that binds the port is its child, so a pid
  //     mismatch there proves nothing.
  //   • A launched child that has ALREADY EXITED cannot be the healthy listener —
  //     that is decisive even when the port owner cannot be mapped at all (the #449
  //     shape), which is precisely the "an external supervisor restored the API"
  //     case that must never be reported as our successful restart (codex gate).
  //   • Otherwise it needs both pids. An unmappable port owner (a real, supported
  //     condition on some hosts — #449) is "unconfirmed": we assert NEITHER way.
  //     It deliberately does NOT become a failure — the child we launched is still
  //     alive and the API is ready, so denying it would report every ordinary
  //     restart as failed on any host where the port-owner lookup is unavailable,
  //     which is a far worse (and far more common) lie than an unconfirmed
  //     success. That uncertainty is carried by an EXPLICIT string state, so it
  //     survives JSON serialization instead of vanishing with an `undefined`.
  const ourPid = launched.child.pid;
  const ownership: ListenerOwnership = classifyListenerOwnership({
    isDesktopApp: info.isDesktopApp,
    childExited: launchedChildExit != null,
    spawnFailed: launchedSpawnFailed,
    child: launched.child,
    launchArgv: launched.launchArgv,
    portOwnerPid: newPid,
    servingArgv,
    // The OS readers are injected so the classifier stays free of platform code
    // (and so tests can drive lineage without a real process tree).
    readParentPid,
    readIdentity: resolveProcessIdentity,
    childIsAlive: launchedChildStillRunning(launched.child),
  });
  // Only the NON-Desktop undecidable case is worth calling out: for a Desktop
  // launcher the pid relationship is indirect by design, not a gap in evidence.
  const ownershipUnconfirmed = !info.isDesktopApp && ownership === "unconfirmed";
  // The pre-launch "the port was free" observation deliberately does NOT carry the
  // claim: another process can bind between that probe and `spawn()`, so it is a
  // fact about a moment that has PASSED, not about the server now answering. It was
  // briefly used to gate `started` and that was wrong twice over — stale evidence,
  // and it made an `unconfirmed` classification report success for somebody else's
  // process. It now only ever appears as a stated ABSENCE in the message below,
  // which is a safe thing to spend.
  //
  // `started` therefore rests on the classification alone: `not-ours` is the one
  // verdict that denies it. `unconfirmed` keeps it TRUE by the standing ruling —
  // denying it would report every ordinary restart as failed on any host whose
  // port-owner lookup is unavailable, a far more common and more damaging lie than
  // an unconfirmed success that the message explicitly qualifies.
  const mayClaimStart = ownership !== "not-ours";
  return {
    // `started` means "THIS call started the server". When the healthy listener is
    // provably NOT the process we launched, we did not start it — programmatic
    // callers must not read a failed relaunch as a success just because something
    // answers (codex gate). `ready` stays TRUE because the server genuinely IS
    // ready: claiming otherwise would be its own lie and would push callers into
    // needless recovery.
    started: mayClaimStart,
    ready: true,
    readiness,
    message:
      `ComfyUI ${ownership === "not-ours" ? "is ready" : "started"} on port ${port}${newPid ? ` (PID ${newPid})` : ""}` +
      // Say WHICH environment it came back in whenever that was not simply ours
      // (#776) — the user needs to know a launcher environment was restored.
      (env && env.source !== "inherited" ? ` — ${env.note}.` : "") +
      // NEVER imply our relaunch is the healthy server when the port is owned by
      // a DIFFERENT process (codex gate): an external launcher/supervisor can bind
      // the port while our child fails, and readiness alone cannot tell them apart.
      (ownership === "not-ours"
        ? ` NOTE: the healthy server on port ${port}${newPid ? ` (PID ${newPid})` : ""} is NOT the process this call launched (PID ${
            ourPid ?? "unknown"
          }${launchedChildExit ? `, which exited: ${exitCause(launchedChildExit)}` : ""}) — another launcher or supervisor owns it, so this server was not started by us.`
        : "") +
      // Undecidable ownership is stated, never implied away: the caller learns that
      // "our relaunch is the healthy server" is unconfirmed rather than proven.
      (ownershipUnconfirmed
        ? ` (Could not map the process owning port ${port}, so this could not be confirmed as the process this call launched — the launched process is alive and the API is ready.)`
        : "") +
      // The port was never observed free, so a healthy API is not evidence WE
      // produced it — it may be the server that was already there.
      (!portObservedFreeBeforeLaunch && ownership !== "ours"
        ? ` NOTE: the port was never observed free before launching, so this call cannot claim to have started the server that is answering.`
        : "") +
      launchEnvWarning(info),
    pid: newPid ?? undefined,
    auto_restart: supervisorResult(info),
    launch_env: env,
    listener_ownership: ownership,
  };
}

// ---------------------------------------------------------------------------
// Remote restart — reboot a remote/tunnelled ComfyUI through ComfyUI-Manager.
//
// A locally-spawned ComfyUI is restarted by killing + relaunching the process.
// A REMOTE ComfyUI (reached via --comfyui-url, e.g. a Cloudflare-tunnelled
// ComfyUI Desktop app) can't be process-controlled from here — but ComfyUI
// Desktop self-supervises, so a ComfyUI-Manager HTTP reboot DOES bring it back.
// We fire that reboot and poll readiness instead of throwing.
// ---------------------------------------------------------------------------

interface RebootResult {
  rebooting: boolean;
  endpoint?: string;
  method?: string;
  reason?: string;
  note?: string;
}

// Match the repo's Manager path convention (node-management.ts appends these to
// getComfyUIBaseUrl() with no `/api` prefix — the panel's `/api/...` form is only
// because its browser `api.fetchApi` prepends `/api`). Canonical v4 POST route
// first, then the legacy GET route for older Manager builds.
// TWO Manager generations serve reboot on DIFFERENT routes+verbs (issue #116):
//   • v4 lineage (pip comfyui_manager ≥4.x): POST /v2/manager/reboot
//   • released Manager 3.x legacy: GET /manager/reboot — and some 3.x builds
//     register it under POST, so we try both verbs on the legacy path before
//     giving up (panel #253/#266, this repo #425). ComfyUI's frontend catchall
//     answers unknown GETs 200/404 and unregistered POSTs 405, so a wrong route
//     surfaces as 404/405 and we fall through to the next candidate.
const REBOOT_ROUTES: ReadonlyArray<{ path: string; method: "POST" | "GET" }> = [
  { path: "/v2/manager/reboot", method: "POST" },
  { path: "/manager/reboot", method: "GET" },
  { path: "/manager/reboot", method: "POST" },
];

/**
 * A dropped/aborted connection is the SUCCESS signal for a reboot: the Manager
 * handler calls exit(0) the instant it accepts the request, so the origin dies
 * before it can send an HTTP response and `fetch` rejects.
 */
function isConnectionDrop(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // NOTE: ECONNREFUSED is deliberately absent — it means "nothing is listening"
  // (the origin was ALREADY down before we called), not "we killed it mid-request".
  // A process reboot we caused surfaces as ECONNRESET / socket-hang-up / terminated.
  return /ECONNRESET|socket hang up|fetch failed|network|ECONNABORTED|EPIPE|terminated|premature close|other side closed|aborted/i.test(
    msg,
  );
}

/**
 * Fire a ComfyUI-Manager reboot over HTTP against the connected (remote) base URL.
 * Classification:
 *   FIRED   (rebooting:true)  — res.ok (2xx) OR a connection drop OR HTTP 502/503/504.
 *                               A killed origin behind a proxy/Cloudflare surfaces
 *                               as a 5xx bad-gateway (NOT a raw socket drop), so we
 *                               must treat those as "reboot fired" too.
 *   REFUSED (rebooting:false) — HTTP 403 → Manager security forbids remote reboot.
 *   NO-ENDPOINT (rebooting:false) — every route gave a non-firing failure (e.g. 404).
 */
/**
 * True when a 200 response is (almost certainly) ComfyUI's frontend SPA catchall
 * rather than a real Manager reboot ack. The catchall serves the index HTML with
 * Content-Type text/html; a Manager reboot route either drops the connection or
 * returns a tiny non-HTML body. Best-effort and defensive: any read error →
 * treat as NOT a catchall (don't suppress a genuine ack on a transient read
 * failure).
 */
async function looksLikeSpaCatchall(res: Response): Promise<boolean> {
  try {
    const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ctype.includes("text/html")) return true;
    // No/unknown content-type: sniff the first bytes for an HTML document.
    const body = (await res.clone().text()).trimStart().slice(0, 256).toLowerCase();
    return body.startsWith("<!doctype html") || body.startsWith("<html");
  } catch {
    return false;
  }
}

async function rebootViaManager(): Promise<RebootResult> {
  const base = getComfyUIBaseUrl();
  const failures: string[] = [];

  for (const { path, method } of REBOOT_ROUTES) {
    const url = `${base}${path}`;
    try {
      const res = await comfyuiFetch(url, { method });
      if (res.ok) {
        // GUARD (codex P1): ComfyUI's frontend catchall answers an UNKNOWN GET
        // with the SPA index — HTTP 200 text/html — so a 200 here does NOT prove
        // a reboot route exists. A genuine Manager reboot handler exits before it
        // can respond (→ a connection drop, handled below) or returns a tiny
        // non-HTML ack; treat a 200 that looks like the HTML catchall as "route
        // absent" and fall through to the next candidate rather than falsely
        // reporting a reboot that never fired (which readiness — a still-up
        // server — would then rubber-stamp as success).
        if (await looksLikeSpaCatchall(res)) {
          failures.push(`${method} ${path} → HTTP 200 (frontend catchall, not a reboot route)`);
          continue;
        }
        return { rebooting: true, endpoint: path, method };
      }
      if (res.status === 403) {
        return {
          rebooting: false,
          reason: "manager-security",
          note:
            "Reboot refused (HTTP 403) — ComfyUI-Manager's security level (or an " +
            "access proxy in front) forbids it; lower the Manager security level or reboot on the host.",
        };
      }
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        return {
          rebooting: true,
          endpoint: path,
          method,
          note: `reboot fired — the origin dropped behind a proxy (HTTP ${res.status}) as it went down`,
        };
      }
      // 404 / other non-OK: wrong route for this Manager build — try the next.
      failures.push(`${method} ${path} → HTTP ${res.status}`);
    } catch (err) {
      if (isConnectionDrop(err)) {
        return {
          rebooting: true,
          endpoint: path,
          method,
          note: "connection dropped (origin going down) — reboot fired",
        };
      }
      failures.push(
        `${method} ${path} → ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    rebooting: false,
    reason: "no-endpoint",
    note:
      `No reachable ComfyUI-Manager reboot endpoint (this ComfyUI likely runs the ` +
      `LEGACY Manager 3.x, which does not expose an HTTP reboot route).${
        failures.length ? ` Tried: ${failures.join("; ")}.` : ""
      } For a LOCAL install, use the headless restart_comfyui tool (kill + relaunch); ` +
      `otherwise restart ComfyUI on the host, or upgrade to Manager v4+.`,
  };
}

interface RemoteRebootTiming {
  /** Grace pause after firing before we start probing (lets the origin actually go down). */
  settleMs: number;
  /** Total readiness budget. */
  budgetMs: number;
  /** Interval between readiness probes. */
  intervalMs: number;
}

let remoteRebootTimingOverride: RemoteRebootTiming | null = null;

function getRemoteRebootTiming(): RemoteRebootTiming {
  if (remoteRebootTimingOverride) return remoteRebootTimingOverride;
  return {
    settleMs: Math.round(
      parsePositiveNumberEnv("COMFYUI_REMOTE_REBOOT_SETTLE_S", 3) * 1000,
    ),
    budgetMs: Math.round(
      parsePositiveNumberEnv("COMFYUI_REMOTE_REBOOT_BUDGET_S", 120) * 1000,
    ),
    intervalMs: Math.round(
      parsePositiveNumberEnv("COMFYUI_REMOTE_REBOOT_INTERVAL_S", 2) * 1000,
    ),
  };
}

/**
 * Restart via a ComfyUI-Manager HTTP reboot instead of killing a process.
 *
 * Used for BOTH the remote target (--comfyui-url) AND a locally-installed
 * ComfyUI **Desktop** instance. Desktop is Electron-supervised: killing its
 * Python backend (or even the Electron shell) leaves it down with no reliable
 * relaunch — spawning "Comfy Desktop.exe" does not deterministically bring the
 * :PORT listener back, which is exactly issue #400 (stopped:true, started:false
 * after 60 probes). The Manager `/v2/manager/reboot` handler asks the SAME
 * supervisor that owns the process to cycle it, so it comes back the way it
 * started. We therefore NEVER kill a Desktop instance; if the reboot can't be
 * fired we refuse and leave the server running rather than take it down with no
 * way back.
 */
async function restartViaManagerReboot(context: {
  /** Human label for logs and the success message ("remote" | "Desktop"). */
  label: string;
}): Promise<RestartResult> {
  logger.info(`Restarting ${context.label} ComfyUI via ComfyUI-Manager reboot...`);

  const reboot = await rebootViaManager();
  if (!reboot.rebooting) {
    return {
      stopped: false,
      started: false,
      message: reboot.note ?? "ComfyUI-Manager reboot could not be triggered.",
      // The Manager reboot path never spawns a process of ours, so ownership of
      // whatever serves the port is never something this call can claim.
      listener_ownership: unclassifiedOwnership(),
    };
  }

  logger.info("ComfyUI-Manager reboot fired", {
    endpoint: reboot.endpoint,
    method: reboot.method,
    note: reboot.note,
  });

  // The reboot HAS been accepted — the server is going down regardless of what
  // the readiness poll below concludes. Drop the detected dialect now so the
  // timed-out branch (which returns early) can't leave the pre-reboot dialect
  // pinned for the instance that eventually comes back (#646).
  resetManagerApiCache("comfyui reboot fired via Manager");
  // #742 r4/r5: record the dispatch — a later decline-path DOWN report may
  // name restart causation only against such a record. No session identity
  // exists here, so stamp the shared PROCESS-WIDE slot (never grounds
  // causation on its own).
  recordRestartDispatch(getComfyUIBaseUrl(), PROCESS_WIDE_RESTART_DISPATCH_TOKEN);

  const timing = getRemoteRebootTiming();
  if (timing.settleMs > 0) await sleep(timing.settleMs);

  // Clamp the interval to a sane floor: a 0 (or tiny) env value would make
  // maxTries unbounded (ceil(budget/0) = Infinity) and hot-loop the poller,
  // hanging the tool call if the host never returns.
  const intervalMs = Math.max(250, timing.intervalMs);
  const maxTries = Math.max(1, Math.ceil(timing.budgetMs / intervalMs));
  const readiness = await waitForApiReady({ intervalMs, maxTries });

  if (!readiness.ready) {
    return {
      stopped: true,
      started: false,
      ready: false,
      readiness,
      message:
        `Reboot was triggered but ComfyUI did not come back within ${timing.budgetMs}ms — ` +
        "check the host (is it the Desktop app / supervised?).",
      listener_ownership: unclassifiedOwnership(),
    };
  }

  // Back and ready — refresh the WS client singleton + memoized /object_info +
  // the detected Manager dialect, since a reboot is exactly when the node set
  // and the Manager generation may have changed (#646). The dialect is dropped a
  // SECOND time here on purpose: a probe that ran against the half-booted server
  // during the readiness wait must not stay pinned.
  resetClient();
  resetObjectInfoCache();
  resetManagerApiCache("comfyui rebooted via Manager");
  // #742 r4/r5: the dispatched restart was observed back — clear OUR record
  // (the process-wide slot only; never another session's record).
  clearRestartDispatch(PROCESS_WIDE_RESTART_DISPATCH_TOKEN);

  return {
    stopped: true,
    started: true,
    ready: true,
    readiness,
    message:
      `ComfyUI rebooted via ComfyUI-Manager and came back ready (${readiness.waited_ms}ms) — ` +
      `${context.label}/supervised restart.`,
    // The supervisor that owns the process cycled it; we launched nothing, so we
    // cannot (and must not) claim the listener as ours.
    listener_ownership: unclassifiedOwnership(),
  };
}

export async function restartComfyUI(): Promise<RestartResult> {
  if (isRemoteMode()) {
    // Remote target: can't process-control it, but a Manager HTTP reboot brings
    // back a self-supervised ComfyUI (e.g. the tunnelled Desktop app).
    return restartViaManagerReboot({ label: "remote" });
  }
  logger.info("Restarting ComfyUI...");

  // Preflight: resolve the RUNNING instance and confirm we can relaunch it
  // BEFORE stopping anything. A restart must be atomic-ish — if the relaunch
  // command can't be built/validated (stale COMFYUI_PATH, unknown Desktop exe),
  // refuse and leave the server up rather than take it down with no way back
  // (issues #368/#370).
  const { info, diagnostic } = await acquireProcessInfo();
  if (!info) {
    return {
      stopped: false,
      started: false,
      message:
        diagnostic ??
        `No ComfyUI process found on port ${config.resolvedPort} to restart. Is ComfyUI running?`,
      listener_ownership: unclassifiedOwnership(),
    };
  }
  // A locally-installed ComfyUI **Desktop** instance is Electron-supervised.
  // Killing it (Python backend or Electron shell) and re-spawning the exe does
  // not reliably bring the :PORT listener back (issue #400: stopped:true,
  // started:false after 60 probes). Route it through the Manager reboot — the
  // supervisor that owns the process cycles it — and NEVER kill it. Only
  // self-spawned Python installs fall through to the kill+relaunch path below.
  if (info.isDesktopApp) {
    // …but only when a supervisor is actually there to do the cycling. The Manager
    // reboot STOPS the process; the Electron shell is what starts it again. When the
    // shell has provably gone, firing the reboot is stopping a server we cannot
    // restart, which is the #814 lost-server. Decided BEFORE anything is dispatched.
    const desktop = assessDesktopSupervision(info);
    if (!desktop.ok) {
      const hint = recoveryHint(info);
      return {
        stopped: false,
        started: false,
        message:
          `Refusing to restart: ${desktop.reason} ComfyUI was left running (not stopped) so ` +
          `you don't lose the server. Restart it from the ComfyUI Desktop app.` +
          describeRecovery(hint),
        restart_hint: hint,
        // Nothing was stopped and nothing launched.
        listener_ownership: unclassifiedOwnership(),
      };
    }
    return restartViaManagerReboot({ label: "Desktop" });
  }

  // requireReproducibleEnv: this path KILLS the process and spawns a fresh one, so
  // the launch ENVIRONMENT has to be rebuilt as well as the command (#776).
  const relaunch = assessRelaunch(info, { requireReproducibleEnv: true });
  if (!relaunch.ok) {
    return {
      stopped: false,
      started: false,
      restart_hint: recoveryHint(info),
      message:
        `Refusing to restart: ${relaunch.reason} ComfyUI was left running (not stopped) ` +
        "so you don't lose the server. " +
        (relaunch.advice ??
          "Fix the launch path (e.g. COMFYUI_PATH) and try again.") +
        describeRecovery(recoveryHint(info)),
      // Refused before touching anything: the still-running server is the one that
      // was already there, which this call did not start.
      listener_ownership: unclassifiedOwnership(),
    };
  }

  // Stop — hand it the pre-validated info so the relaunch details (incl. the
  // resolved Desktop exe) survive into startComfyUI's lastProcessInfo.
  const stopResult = await stopComfyUI(info);
  if (!stopResult.stopped) {
    return {
      stopped: false,
      started: false,
      message: `Could not stop ComfyUI: ${stopResult.message}`,
      // Nothing was stopped and nothing launched — whatever is on the port is not
      // this call's doing.
      listener_ownership: unclassifiedOwnership(),
    };
  }
  // #742 r4/r5: the stop DID happen — record the dispatch. No session identity
  // exists here, so stamp the shared PROCESS-WIDE slot (never grounds causation
  // on its own; a panel caller stamps its own session token from the result).
  recordRestartDispatch(getComfyUIBaseUrl(), PROCESS_WIDE_RESTART_DISPATCH_TOKEN);

  // Brief pause to let OS fully release resources
  await sleep(1000);

  // A caveat from the stop must survive into whatever we report: the stop can
  // commit WITHOUT confirming the process exited (every port probe failed after
  // the kill), and that is exactly the situation where a bare "restarted
  // successfully" would overstate what we know.
  const stopCaveat = stopResult.unverified_exit
    ? ` NOTE from the stop: ${stopResult.unverified_exit}.`
    : "";

  // Start
  const startResult = await startComfyUI();
  if (!startResult.started) {
    return {
      stopped: true,
      started: false,
      ready: startResult.ready,
      readiness: startResult.readiness,
      // Two distinct failures share this branch, and they must NOT read alike: the
      // server may be DOWN (our relaunch never answered), or UP but owned by
      // somebody else (an external supervisor beat us to the port — our relaunch
      // still failed). Saying "could not be started" about a healthy server would
      // be as wrong as claiming success for it (codex gate).
      message:
        (startResult.ready
          ? `ComfyUI is back up, but NOT as a result of this restart: ${startResult.message}`
          : `ComfyUI was stopped but could not be started: ${startResult.message}`) +
        stopCaveat,
      auto_restart: startResult.auto_restart,
      spawn_error: startResult.spawn_error,
      launch_env: startResult.launch_env,
      listener_ownership: startResult.listener_ownership,
    };
  }

  // #742 r4/r5: the restart was observed back — clear OUR record (the
  // process-wide slot only; never another session's record).
  clearRestartDispatch(PROCESS_WIDE_RESTART_DISPATCH_TOKEN);

  return {
    stopped: true,
    started: true,
    ready: startResult.ready,
    readiness: startResult.readiness,
    // Reached only when startComfyUI reported started:true — i.e. the healthy
    // listener is ours, or ownership was undecidable. A listener that is provably
    // NOT ours returns started:false and is handled in the branch above.
    //
    // "restarted successfully" is a claim of PROOF, so it is reserved for the case
    // where the port owner was actually matched to the process we launched. When
    // ownership could not be determined the server is genuinely up and the flags
    // stay positive (denying that would mislabel every ordinary restart on hosts
    // where the port-owner lookup is unavailable), but the sentence must not
    // ATTRIBUTE that healthy listener to this restart (coordinator gate).
    message:
      (startResult.listener_ownership === "unconfirmed"
        ? "ComfyUI is up and ready after the restart, though this call's own process could not be confirmed as the one serving the port. "
        : "ComfyUI restarted successfully. ") +
      startResult.message +
      stopCaveat,
    auto_restart: startResult.auto_restart,
    launch_env: startResult.launch_env,
    listener_ownership: startResult.listener_ownership,
  };
}

// ---------------------------------------------------------------------------
// Restart dispatch records (#742 r4/r5) — bookkeeping of restarts THIS
// orchestrator actually dispatched (a Manager reboot fired, or a kill+relaunch
// whose stop succeeded). The panel decline path may name restart CAUSATION for
// a down server only against a record whose TOKEN the declining session holds
// (r5): the orchestrator hosts many per-tab/per-connection sessions, so a
// module-global record would let session A's failed restart fabricate
// causation for session B's decline (and A's recovery clear B's record).
// Records are keyed by an opaque token returned to the stamper; a session
// stores only its own token. Headless stamp sites (no session identity) share
// the single PROCESS-WIDE slot — a documented process-wide fallback that can
// NEVER ground causation (no session holds that token).
// ---------------------------------------------------------------------------

interface RestartDispatchRecord {
  /** Epoch ms when the restart was dispatched. */
  at: number;
  /** The ComfyUI base URL the restart targeted (null = unknown). */
  base: string | null;
}

/** Token → record. Only the holder of a token may ground causation on (or
 *  clear) its record. */
const restartDispatchRecords = new Map<string, RestartDispatchRecord>();

/** The shared slot for session-less (headless) stamps — never causation. */
export const PROCESS_WIDE_RESTART_DISPATCH_TOKEN = "process-wide";

/** How long a recorded dispatch plausibly explains a down server. Also the
 *  prune horizon: older records can never ground causation, so they are
 *  reaped on each stamp (bounds the map across many sessions). */
export const RESTART_DISPATCH_CAUSATION_WINDOW_MS = 10 * 60_000; // 10 min

/**
 * Stamp that a restart was ACTUALLY dispatched (reboot fired / stop done) and
 * return the opaque token identifying the record. Callers WITH a session
 * identity take the fresh token and store it per-session; session-less
 * (headless) callers pass PROCESS_WIDE_RESTART_DISPATCH_TOKEN so all unheld
 * stamps share one bounded slot. Stale records are pruned on each stamp.
 */
export function recordRestartDispatch(base: string | null, token?: string): string {
  const now = Date.now();
  for (const [t, r] of restartDispatchRecords) {
    if (now - r.at > RESTART_DISPATCH_CAUSATION_WINDOW_MS) {
      restartDispatchRecords.delete(t);
    }
  }
  const t = token ?? randomUUID();
  restartDispatchRecords.set(t, { at: now, base });
  return t;
}

/** Remove ONLY the record identified by `token` — a recovery may never clear
 *  another session's record (r5). Unknown token → no-op. */
export function clearRestartDispatch(token: string): void {
  restartDispatchRecords.delete(token);
}

/** The record identified by `token`, or null. */
export function getRestartDispatchRecord(
  token: string,
): RestartDispatchRecord | null {
  return restartDispatchRecords.get(token) ?? null;
}

/**
 * Refuse-safe preflight for an OUT-OF-BAND restart — one that stops ComfyUI
 * WITHOUT going through our validated kill+relaunch (e.g. the panel's
 * ComfyUI-Manager reboot, which asks the Manager to cycle the process and never
 * consults our relaunch command). The same atomic-ish invariant as
 * restartComfyUI applies (#368/#370): a stop must never happen before a
 * relaunch is proven possible. On a Pinokio-style install (#742) the running
 * server is externally supervised yet its relaunch is NOT provable from here
 * (a relative `main.py` argv with no COMFYUI_PATH/workspace anchor and no live
 * process cwd), and the supervisor does NOT re-launch after a plain Manager
 * restart — so the reboot would kill ComfyUI permanently.
 *
 * WHAT PASSES is now stated positively, because every "everything else proceeds"
 * clause here turned out to be a way in for the same loss:
 *   - remote mode — there is no local process to assess, and the Manager reboot is
 *     that target's restart path by design;
 *   - a Desktop instance a live supervisor is proven to be watching (#400's safe
 *     path, now checked rather than assumed);
 *   - a non-Desktop instance whose relaunch command can be built and validated
 *     (assessRelaunch, the #476/#426 machinery).
 * Everything else — including an instance that could not be identified at all —
 * REFUSES, and says what it could not establish.
 */
export async function preflightLocalRestart(): Promise<{
  ok: boolean;
  reason?: string;
}> {
  if (isRemoteMode()) return { ok: true };
  const { info, diagnostic } = await acquireProcessInfo();
  // NOTHING COULD BE RESOLVED — and that is not a pass (coordinator gate).
  //
  // This was the door beside the widened gate: a local instance whose listener cannot
  // be attributed (a container with no `lsof`, a permission wall, no `/proc`) resolves
  // to NOTHING here, so the preflight "assessed" it, passed, and the reboot went out
  // without anyone having checked whether a supervisor was still there. That is the
  // container/permission form of the very #814 loss the gate exists to prevent — an
  // instance we cannot identify is an instance whose relaunch we cannot prove.
  //
  // The refusal is safe in the genuinely-nothing-running case too: there is no server
  // to lose, and the message says exactly what could not be established rather than
  // asserting something is wrong.
  if (!info) {
    return {
      ok: false,
      reason:
        `the ComfyUI this restart would stop could not be identified from here` +
        (diagnostic ? ` (${diagnostic})` : ` (nothing was found listening on port ${config.resolvedPort})`) +
        `, so it could not be established that stopping it is something we could undo.`,
    };
  }
  if (info.isDesktopApp) {
    // NOT an automatic pass any more (#814). Electron supervision is what makes a
    // Desktop reboot safe, and it is a FACT about the running process tree, not a
    // property of the install. See assessDesktopSupervision for why UNCONFIRMED
    // refuses here while it is merely disclosed on the post-launch ownership path.
    const desktop = assessDesktopSupervision(info);
    if (desktop.ok) return { ok: true };
    return { ok: false, reason: `${desktop.reason}${describeRecovery(recoveryHint(info))}` };
  }
  // NOTE (#776): the launch-ENVIRONMENT check is deliberately NOT applied here.
  // This preflight guards an OUT-OF-BAND ComfyUI-Manager reboot, which re-execs
  // the SAME process — it inherits its own (launcher-supplied) environment, so a
  // Stability Matrix / Pinokio environment survives that restart for free.
  // Refusing on it would cost those users a restart path that actually works.
  const relaunch = assessRelaunch(info);
  if (relaunch.ok) return { ok: true };
  return { ok: false, reason: relaunch.reason };
}

export const __processControlTestHooks = {
  reset(): void {
    detachSupervisor();
    lastProcessInfo = null;
    supervisorRestartCount = 0;
    supervisorWindowStartedAt = 0;
    supervisorGaveUp = false;
    remoteRebootTimingOverride = null;
    liveCwdResolverOverride = null;
    liveEnvResolverOverride = null;
    processIdentityOverride = null;
    parentPidResolverOverride = null;
    processExistsOverride = null;
    deliberateStop = false;
    restartDispatchRecords.clear();
  },
  /** Inject a fake parent-pid reader so the lineage check can be driven without a
   *  real process tree. */
  setParentPidResolver(fn: ((pid: number) => number | undefined) | null): void {
    parentPidResolverOverride = fn;
  },
  /** Inject a fake pid-existence probe (#814) so the Desktop supervision check can
   *  be driven without spawning and killing real processes. */
  setProcessExistsProbe(fn: ((pid: number) => boolean | undefined) | null): void {
    processExistsOverride = fn;
  },
  /** Inject a fake process-identity (creation time) reader so tests can drive
   *  recycled-PID scenarios on any host, including where the native read is
   *  deliberately skipped. */
  setProcessIdentityResolver(
    fn: ((pid: number) => { startedAt?: string } | undefined) | null,
  ): void {
    processIdentityOverride = fn;
  },
  /** Inject a fake live-process-ENVIRONMENT reader (#776) so tests can drive the
   *  `/proc/<pid>/environ` capture without a real process. */
  setLiveEnvResolver(
    fn: ((pid: number) => NodeJS.ProcessEnv | undefined) | null,
  ): void {
    liveEnvResolverOverride = fn;
  },
  /** Inject a fake live-process-cwd resolver (#535) so tests can drive the
   *  `/proc/<pid>/cwd` relative-script anchor without a real process/filesystem. */
  setLiveCwdResolver(fn: ((pid: number) => string | undefined) | null): void {
    liveCwdResolverOverride = fn;
  },
  setLastProcessInfo(info: ProcessInfo): void {
    lastProcessInfo = info;
  },
  /** Seed/remove a #742 r4/r5 restart-dispatch record directly (fresh/stale/
   *  foreign base) so decline-path causation tests don't run a real restart. */
  setRestartDispatchRecord(
    token: string,
    record: RestartDispatchRecord | null,
  ): void {
    if (record == null) restartDispatchRecords.delete(token);
    else restartDispatchRecords.set(token, record);
  },
  /** Inject fast remote-reboot timing so tests don't wait the real ~120s budget. */
  setRemoteRebootTimingForTests(timing: RemoteRebootTiming | null): void {
    remoteRebootTimingOverride = timing;
  },
};
