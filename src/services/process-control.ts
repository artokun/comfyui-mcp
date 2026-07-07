import { execSync, spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import { getSystemStats, resetClient, resetObjectInfoCache } from "../comfyui/client.js";
import { config, getComfyUIBaseUrl, isRemoteMode } from "../config.js";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { ProcessControlError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProcessInfo {
  pid: number;
  port: number;
  argv: string[];
  isDesktopApp: boolean;
  desktopExePath?: string;
}

interface StopResult {
  stopped: boolean;
  message: string;
  has_restart_info: boolean;
  auto_restart?: SupervisorResult;
}

interface StartResult {
  started: boolean;
  message: string;
  pid?: number;
  ready?: boolean;
  readiness?: StartupReadinessResult;
  auto_restart?: SupervisorResult;
  spawn_error?: ChildProcessErrorDetails;
}

interface RestartResult {
  stopped: boolean;
  started: boolean;
  message: string;
  ready?: boolean;
  readiness?: StartupReadinessResult;
  auto_restart?: SupervisorResult;
  spawn_error?: ChildProcessErrorDetails;
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

function findPidByPort(port: number): number | null {
  try {
    if (IS_WIN) {
      // netstat -ano | findstr :PORT | findstr LISTENING
      const out = execSync(
        `netstat -ano | findstr :${port} | findstr LISTENING`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
      // Lines look like: TCP  0.0.0.0:8188  0.0.0.0:0  LISTENING  12345
      for (const line of out.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
          const pid = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(pid) && pid > 0) return pid;
        }
      }
    } else {
      const out = execSync(`lsof -ti :${port}`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      const pid = parseInt(out.split("\n")[0], 10);
      if (!isNaN(pid) && pid > 0) return pid;
    }
  } catch {
    // Command failed — no process on that port
  }
  return null;
}

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

async function waitForPortFree(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (findPidByPort(port) === null) return;
    await sleep(500);
  }
  throw new ProcessControlError(
    `Port ${port} still in use after ${timeoutMs / 1000}s`,
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
    maxTries: parsePositiveIntEnv("COMFYUI_STARTUP_CHECK_MAX_TRIES", 20),
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

async function waitForApiReady(): Promise<StartupReadinessResult> {
  const { intervalMs, maxTries } = getStartupReadinessConfig();
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

function spawnFromProcessInfo(info: ProcessInfo): ChildProcess | null {
  if (info.isDesktopApp) {
    if (IS_WIN) {
      const exe = info.desktopExePath;
      if (!exe) return null;
      return spawn(exe, [], {
        detached: true,
        stdio: "ignore",
        shell: false,
      });
    }

    const appPath = info.desktopExePath ?? "ComfyUI";
    return spawn("open", ["-a", appPath], {
      detached: true,
      stdio: "ignore",
    });
  }

  if (info.argv.length === 0) return null;
  const [pythonExe, ...args] = info.argv;
  return spawn(pythonExe, args, {
    detached: true,
    stdio: "ignore",
    cwd: config.comfyuiPath ?? undefined,
    shell: false,
  });
}

function handleSupervisedChildStop(
  child: ChildProcess,
  reason: {
    code?: number | null;
    signal?: NodeJS.Signals | null;
    error?: ChildProcessErrorDetails;
  },
): void {
  if (supervisedChild !== child) return;
  detachSupervisor();

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
  restarted.unref();
  superviseChild(restarted, lastProcessInfo);
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

async function gatherProcessInfo(): Promise<ProcessInfo> {
  const port = config.resolvedPort;

  // 1. Get argv from /system_stats
  let argv: string[] = [];
  try {
    const stats = await getSystemStats();
    argv = stats.system.argv ?? [];
  } catch {
    logger.warn("Could not fetch system_stats — will rely on PID detection");
  }

  // 2. Find PID by port
  const pid = findPidByPort(port);
  if (!pid) {
    throw new ProcessControlError(
      `No process found listening on port ${port}. Is ComfyUI running?`,
    );
  }

  const desktop = isDesktopApp(argv);
  const desktopExe = desktop ? findDesktopExePath(argv) : undefined;

  return { pid, port, argv, isDesktopApp: desktop, desktopExePath: desktopExe };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function stopComfyUI(): Promise<StopResult> {
  if (isRemoteMode()) {
    throw new ProcessControlError(
      "stop_comfyui operates on the local machine's ComfyUI process and is not " +
        "available when targeting a remote instance via --comfyui-url.",
    );
  }
  logger.info("Stopping ComfyUI...");
  detachSupervisor();

  // Gather info before we kill it
  let info: ProcessInfo;
  try {
    info = await gatherProcessInfo();
  } catch (err) {
    // API and port are dead — try OS-level Desktop app detection
    const desktopPids = findDesktopAppPids();
    if (desktopPids.length > 0) {
      logger.info(`API unreachable but found Desktop app PIDs: ${desktopPids.join(", ")}`);
      const port = config.resolvedPort;
      info = {
        pid: desktopPids[0],
        port,
        argv: [],
        isDesktopApp: true,
        desktopExePath: findDesktopExeFromCommonPaths(),
      };
    } else {
      return {
        stopped: false,
        message:
          err instanceof ProcessControlError
            ? err.message
            : `Failed to find ComfyUI process: ${err}`,
        has_restart_info: false,
      };
    }
  }

  // Save for later start
  lastProcessInfo = info;
  logger.info("Captured process info", {
    pid: info.pid,
    port: info.port,
    isDesktopApp: info.isDesktopApp,
    argv: info.argv.join(" "),
  });

  // Kill process tree (for Desktop app, kill the Electron shell too)
  if (info.isDesktopApp) {
    killDesktopApp(info.pid);
  } else {
    killProcessTree(info.pid);
  }

  // Reset the WebSocket client singleton + the memoized /object_info —
  // a restart is exactly when the node set may have changed.
  resetClient();
  resetObjectInfoCache();

  // Wait for port to actually free
  try {
    await waitForPortFree(info.port);
  } catch {
    logger.warn("Port did not free in time, but process kill was sent");
  }

  return {
    stopped: true,
    message: `ComfyUI (PID ${info.pid}) stopped on port ${info.port}`,
    has_restart_info: true,
    auto_restart: supervisorResult(info),
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

  // Check if already running
  const existingPid = findPidByPort(port);
  if (existingPid) {
    return {
      started: false,
      message: `ComfyUI is already running on port ${port} (PID ${existingPid})`,
      pid: existingPid,
    };
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
    };
  }
  const spawnError = captureChildProcessError(launched);
  launched.unref();
  lastProcessInfo = info;
  superviseChild(launched, info);

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
    };
  }

  const readiness = startupResult.readiness;
  if (!readiness.ready) {
    return {
      started: false,
      ready: false,
      readiness,
      message:
        `ComfyUI process was launched but the API did not become ready after ${readiness.waited_ms}ms (${readiness.attempts}/${readiness.max_tries} probes). Check the ComfyUI logs.`,
      auto_restart: supervisorResult(info),
    };
  }

  const newPid = findPidByPort(port);
  return {
    started: true,
    ready: true,
    readiness,
    message: `ComfyUI started on port ${port}${newPid ? ` (PID ${newPid})` : ""}`,
    pid: newPid ?? undefined,
    auto_restart: supervisorResult(info),
  };
}

export async function restartComfyUI(): Promise<RestartResult> {
  if (isRemoteMode()) {
    throw new ProcessControlError(
      "restart_comfyUI operates on the local machine's ComfyUI process and is not " +
        "available when targeting a remote instance via --comfyui-url.",
    );
  }
  logger.info("Restarting ComfyUI...");

  // Stop
  const stopResult = await stopComfyUI();
  if (!stopResult.stopped) {
    return {
      stopped: false,
      started: false,
      message: `Could not stop ComfyUI: ${stopResult.message}`,
    };
  }

  // Brief pause to let OS fully release resources
  await sleep(1000);

  // Start
  const startResult = await startComfyUI();
  if (!startResult.started) {
    return {
      stopped: true,
      started: false,
      ready: startResult.ready,
      readiness: startResult.readiness,
      message: `ComfyUI was stopped but could not be started: ${startResult.message}`,
      auto_restart: startResult.auto_restart,
      spawn_error: startResult.spawn_error,
    };
  }

  return {
    stopped: true,
    started: true,
    ready: startResult.ready,
    readiness: startResult.readiness,
    message: `ComfyUI restarted successfully. ${startResult.message}`,
    auto_restart: startResult.auto_restart,
  };
}

export const __processControlTestHooks = {
  reset(): void {
    detachSupervisor();
    lastProcessInfo = null;
    supervisorRestartCount = 0;
    supervisorWindowStartedAt = 0;
    supervisorGaveUp = false;
  },
  setLastProcessInfo(info: ProcessInfo): void {
    lastProcessInfo = info;
  },
};
