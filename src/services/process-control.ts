import { execSync, spawn } from "node:child_process";
import { platform } from "node:os";
import { getSystemStats, resetClient } from "../comfyui/client.js";
import { config, getComfyUIApiHost } from "../config.js";
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
}

interface StartResult {
  started: boolean;
  message: string;
  pid?: number;
}

interface RestartResult {
  stopped: boolean;
  started: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Module-level state — persists between MCP tool calls within a session
// ---------------------------------------------------------------------------

let lastProcessInfo: ProcessInfo | null = null;

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
 * Find PIDs of the Desktop app's Electron shell (ComfyUI.exe on Windows).
 * The Python backend is a child of the Electron app, so we need to kill
 * the parent to fully stop the Desktop app.
 */
function findDesktopAppPids(): number[] {
  const pids: number[] = [];
  try {
    if (IS_WIN) {
      const out = execSync(
        `tasklist /FI "IMAGENAME eq ComfyUI.exe" /FO CSV /NH`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
      for (const line of out.split("\n")) {
        // CSV format: "ComfyUI.exe","12345","Console","1","206,248 K"
        const match = line.match(/"ComfyUI\.exe","(\d+)"/i);
        if (match) pids.push(parseInt(match[1], 10));
      }
    } else {
      const out = execSync(`pgrep -f "ComfyUI.app"`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      for (const line of out.split("\n")) {
        const pid = parseInt(line, 10);
        if (!isNaN(pid) && pid > 0) pids.push(pid);
      }
    }
  } catch {
    // No Desktop app processes found
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
    joined.includes("comfyui.app")
  );
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

async function waitForApiReady(timeoutMs = 60000): Promise<void> {
  const host = getComfyUIApiHost();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`http://${host}/system_stats`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        logger.info("ComfyUI API is ready");
        return;
      }
    } catch {
      // Not ready yet
    }
    await sleep(1000);
  }
  throw new ProcessControlError(
    `ComfyUI API not ready after ${timeoutMs / 1000}s`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  logger.info("Stopping ComfyUI...");

  // Gather info before we kill it
  let info: ProcessInfo;
  try {
    info = await gatherProcessInfo();
  } catch (err) {
    return {
      stopped: false,
      message:
        err instanceof ProcessControlError
          ? err.message
          : `Failed to find ComfyUI process: ${err}`,
      has_restart_info: false,
    };
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

  // Reset the WebSocket client singleton
  resetClient();

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
  };
}

export async function startComfyUI(): Promise<StartResult> {
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

  const info = lastProcessInfo;
  if (!info) {
    return {
      started: false,
      message:
        "No previous process info available. Stop ComfyUI first with stop_comfyui so the restart info can be captured, or start ComfyUI manually.",
    };
  }

  logger.info("Starting ComfyUI...", {
    isDesktopApp: info.isDesktopApp,
    argv: info.argv.join(" "),
  });

  if (info.isDesktopApp) {
    // Launch the Desktop app
    if (IS_WIN) {
      const exe = info.desktopExePath;
      if (!exe) {
        return {
          started: false,
          message:
            "Could not determine ComfyUI Desktop executable path. Please start it manually.",
        };
      }
      spawn(exe, [], {
        detached: true,
        stdio: "ignore",
        shell: false,
      }).unref();
    } else {
      // macOS
      const appPath = info.desktopExePath ?? "ComfyUI";
      spawn("open", ["-a", appPath], {
        detached: true,
        stdio: "ignore",
      }).unref();
    }
  } else {
    // Manual Python install — reconstruct the command
    if (info.argv.length === 0) {
      return {
        started: false,
        message:
          "No command-line info captured from previous run. Start ComfyUI manually.",
      };
    }

    // argv[0] is python executable, argv[1..] are args (main.py, --port, etc.)
    const [pythonExe, ...args] = info.argv;
    spawn(pythonExe, args, {
      detached: true,
      stdio: "ignore",
      cwd: config.comfyuiPath ?? undefined,
      shell: false,
    }).unref();
  }

  // Wait for API to become ready
  try {
    await waitForApiReady();
  } catch {
    return {
      started: false,
      message:
        "ComfyUI process was launched but the API did not become ready within 60 seconds. Check the ComfyUI logs.",
    };
  }

  const newPid = findPidByPort(port);
  return {
    started: true,
    message: `ComfyUI started on port ${port}${newPid ? ` (PID ${newPid})` : ""}`,
    pid: newPid ?? undefined,
  };
}

export async function restartComfyUI(): Promise<RestartResult> {
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
      message: `ComfyUI was stopped but could not be started: ${startResult.message}`,
    };
  }

  return {
    stopped: true,
    started: true,
    message: `ComfyUI restarted successfully. ${startResult.message}`,
  };
}
