// ComfyUI Desktop-2 (#2482): the Windows layout is
//   core     ~/ComfyUI-Installs/ComfyUI/ComfyUI
//   venv     ~/Documents/ComfyUI/.venv
//   launcher ~/AppData/Local/Programs/ComfyUI/Comfy Desktop/Comfy Desktop.exe
//
// The python argv has no "Comfy Desktop" token, so stop used to kill the
// backend (or a child PID already gone), report stopped:false +
// has_restart_info:false, and leave start with no launcher — agents then
// guessed the legacy v1 ComfyUI.exe and broke the 0.34 core.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function noListener(): Error {
  const err = new Error("no listener") as Error & {
    status?: number;
    stdout?: string;
    stderr?: string;
  };
  err.status = 1;
  err.stdout =
    "lsof: Internet address not located: TCP:8188\nlsof: TCP state not located: LISTEN\n";
  err.stderr = "";
  return err;
}

class FakeChild extends EventEmitter {
  unref = vi.fn();
  pid: number | undefined = 8800;
}

const DESKTOP2_EXE =
  "C:\\Users\\x\\AppData\\Local\\Programs\\ComfyUI\\Comfy Desktop\\Comfy Desktop.exe";
const LEGACY_V1_EXE = "C:\\Users\\x\\AppData\\Local\\Programs\\ComfyUI\\ComfyUI.exe";
const MAIN = "C:\\Users\\x\\ComfyUI-Installs\\ComfyUI\\ComfyUI\\main.py";
const PYTHON = "C:\\Users\\x\\Documents\\ComfyUI\\.venv\\Scripts\\python.exe";
const MARKER = "C:\\Users\\x\\ComfyUI-Installs\\ComfyUI\\.comfyui-desktop-2";
const SNAP_DIR = "C:\\Users\\x\\ComfyUI-Installs\\ComfyUI\\.launcher\\snapshots";
const SERVER_ARGV = [MAIN, "--listen", "127.0.0.1", "--port", "8188"];
const SHELL_PID = 300;
const SERVER_PID = 4321;

const mockConfig = vi.hoisted(() => ({
  resolvedPort: 8188,
  comfyuiPath: undefined as string | undefined,
}));
const mockExecSync = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());
const mockGetSystemStats = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn((_p: string) => false));
const mockReaddirSync = vi.hoisted(() => vi.fn((_p: string): string[] => []));
const mockFindComfyuiPython = vi.hoisted(() => vi.fn());

vi.mock("../../config.js", () => ({
  config: mockConfig,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyuiTargetGeneration: () => 0,
  getComfyUIAuthHeaders: () => ({}),
  isRemoteMode: () => false,
}));

vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
  spawn: mockSpawn,
}));

vi.mock("node:fs", () => ({
  existsSync: (p: string) => mockExistsSync(String(p)),
  lstatSync: vi.fn((p: string) => {
    if (!mockExistsSync(String(p))) throw new Error("ENOENT");
    return { isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false };
  }),
  readlinkSync: vi.fn(() => {
    throw new Error("no /proc in test");
  }),
  readFileSync: vi.fn(() => {
    throw Object.assign(new Error("no /proc in test"), { code: "ENOENT" });
  }),
  readdirSync: (p: string) => mockReaddirSync(String(p)),
  statSync: vi.fn((p: string) => {
    if (!mockExistsSync(String(p))) throw new Error("ENOENT");
    return { isFile: () => true, isDirectory: () => false };
  }),
}));

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: mockGetSystemStats,
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../services/env-capabilities.js", () => ({
  findComfyuiPython: mockFindComfyuiPython,
}));

vi.mock("../../services/workspace-env.js", () => ({
  resolveEffectiveComfyUIBase: () => undefined,
  liveRootFromArgv: () => undefined,
  resolveLiveServerRoot: () => ({ source: "unresolved" }),
  markLocalComfyUILaunched: vi.fn(),
  resetLocalComfyUILaunchState: vi.fn(),
}));

vi.mock("../../services/instance-witness.js", async () => ({
  ...(await vi.importActual("../../services/instance-witness.js")),
  acquireInstanceWitness: async () => undefined,
}));

import {
  __processControlTestHooks,
  startComfyUI,
  stopComfyUI,
} from "../../services/process-control.js";

const ORIGINAL_ENV = { ...process.env };

function onDisk(...paths: string[]): void {
  const allowed = new Set(paths.map((p) => p.replace(/\\/g, "/").toLowerCase()));
  mockExistsSync.mockImplementation((p: string) =>
    allowed.has(String(p).replace(/\\/g, "/").toLowerCase()),
  );
}

function mockLivePortThenFree(opts?: {
  onKill?: (cmd: string) => void;
}): { killed: () => boolean } {
  let killed = false;
  mockExecSync.mockImplementation((cmd: string) => {
    if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
      killed = true;
      opts?.onKill?.(cmd);
      return "";
    }
    if (/tasklist/i.test(cmd)) return "";
    if (/pgrep/i.test(cmd)) {
      const err = new Error("no match") as Error & { status?: number };
      err.status = 1;
      throw err;
    }
    if (/if exist/i.test(cmd)) {
      if (cmd.includes("Comfy Desktop") && cmd.includes("Programs\\ComfyUI")) return "found";
      return "";
    }
    if (/netstat/i.test(cmd)) {
      return killed ? "" : `  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       ${SERVER_PID}`;
    }
    if (/lsof/i.test(cmd)) {
      if (killed) throw noListener();
      return `p${SERVER_PID}\nn127.0.0.1:8188\n`;
    }
    return "";
  });
  return { killed: () => killed };
}

function installDesktop2Tree(): void {
  __processControlTestHooks.setProcessIdentityResolver((pid) => {
    if (pid === SHELL_PID) {
      return {
        executablePath: DESKTOP2_EXE,
        commandLine: `"${DESKTOP2_EXE}"`,
        argv: [DESKTOP2_EXE],
        startedAt: "2000",
      };
    }
    if (pid === SERVER_PID) {
      return {
        startedAt: "5000",
        parentPid: SHELL_PID,
        commandLine: `"${PYTHON}" "${MAIN}" --listen 127.0.0.1 --port 8188`,
        argv: [PYTHON, ...SERVER_ARGV],
      };
    }
    return undefined;
  });
  __processControlTestHooks.setParentPidResolver((pid) =>
    pid === SERVER_PID ? SHELL_PID : undefined,
  );
  __processControlTestHooks.setProcessExistsProbe((pid) => pid === SERVER_PID || pid === SHELL_PID);
}

function spawnDesktop(): void {
  mockSpawn.mockImplementation(() => new FakeChild());
}

function expectSpawnedDesktop2(): void {
  expect(mockSpawn).toHaveBeenCalled();
  const dumped = JSON.stringify(mockSpawn.mock.calls[0]);
  expect(dumped).toContain("Comfy Desktop.exe");
  expect(dumped).not.toMatch(/ComfyUI\.exe/i);
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  process.env.LOCALAPPDATA = "C:\\Users\\x\\AppData\\Local";
  process.env.USERPROFILE = "C:\\Users\\x";
  process.env.COMFYUI_STARTUP_CHECK_INTERVAL_S = "0.01";
  process.env.COMFYUI_STARTUP_CHECK_MAX_TRIES = "1";
  process.env.COMFYUI_PORT_FREE_TIMEOUT_S = "1";
  mockConfig.resolvedPort = 8188;
  mockConfig.comfyuiPath = undefined;
  mockFindComfyuiPython.mockReturnValue(PYTHON);
  mockReaddirSync.mockImplementation(() => {
    throw Object.assign(new Error("no /proc in test"), { code: "ENOENT" });
  });
  onDisk(MAIN, PYTHON, DESKTOP2_EXE);
  mockGetSystemStats.mockResolvedValue({ system: { argv: [...SERVER_ARGV] } });
  vi.spyOn(process, "kill").mockImplementation(() => true);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true }) as Response));
  __processControlTestHooks.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  __processControlTestHooks.reset();
});

describe("restart_comfyui — Desktop-2 recognition and stop/start (#2482)", () => {
  it("records the Desktop-2 launcher from the parent process so start can relaunch it", async () => {
    mockLivePortThenFree();
    installDesktop2Tree();
    spawnDesktop();

    const stopped = await stopComfyUI();
    expect(stopped.stopped).toBe(true);
    expect(stopped.has_restart_info).toBe(true);
    expect(stopped.launch?.exe).toBe(DESKTOP2_EXE);
    expect(stopped.message).not.toMatch(/left as it was/i);

    const started = await startComfyUI();
    expect(started.started).toBe(true);
    expectSpawnedDesktop2();
  });

  it("recognises Desktop-2 via the .comfyui-desktop-2 marker when argv has no Desktop token", async () => {
    mockLivePortThenFree();
    onDisk(MAIN, PYTHON, DESKTOP2_EXE, MARKER);
    __processControlTestHooks.setProcessIdentityResolver(() => ({
      startedAt: "5000",
      commandLine: `"${PYTHON}" "${MAIN}" --listen 127.0.0.1 --port 8188`,
      argv: [PYTHON, ...SERVER_ARGV],
    }));
    spawnDesktop();

    const stopped = await stopComfyUI();
    expect(stopped.stopped).toBe(true);
    expect(stopped.has_restart_info).toBe(true);
    expect(stopped.launch?.exe).toBe(DESKTOP2_EXE);

    const started = await startComfyUI();
    expect(started.started).toBe(true);
    expectSpawnedDesktop2();
  });

  it("recognises Desktop-2 via .launcher/snapshots/*.json", async () => {
    mockLivePortThenFree();
    onDisk(MAIN, PYTHON, DESKTOP2_EXE, SNAP_DIR);
    mockReaddirSync.mockImplementation((p: string) => {
      if (String(p).replace(/\\/g, "/").toLowerCase().includes(".launcher/snapshots")) {
        return ["auto-2026-08-30.json"];
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    __processControlTestHooks.setProcessIdentityResolver(() => ({
      startedAt: "5000",
      commandLine: `"${PYTHON}" "${MAIN}" --listen 127.0.0.1 --port 8188`,
      argv: [PYTHON, ...SERVER_ARGV],
    }));
    spawnDesktop();

    const stopped = await stopComfyUI();
    expect(stopped.stopped).toBe(true);
    expect(stopped.has_restart_info).toBe(true);
    expect(stopped.launch?.exe).toBe(DESKTOP2_EXE);
  });

  it("does not report stopped:false when taskkill fails but the port is already free", async () => {
    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill/i.test(cmd) || /pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        const err = new Error(`Command failed: taskkill /PID 47224 /T /F`) as Error & {
          stderr?: string;
        };
        err.stderr =
          'ERROR: The process with PID 47224 could not be terminated.\nReason: Access is denied.\n';
        throw err;
      }
      if (/tasklist/i.test(cmd)) {
        return '"Comfy Desktop.exe","47224","Console","1","200,000 K"\n';
      }
      if (/pgrep/i.test(cmd)) return "47224\n";
      if (/if exist/i.test(cmd)) {
        return cmd.includes("Comfy Desktop") && cmd.includes("Programs\\ComfyUI") ? "found" : "";
      }
      if (/netstat/i.test(cmd)) {
        return killed ? "" : `  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       ${SERVER_PID}`;
      }
      if (/lsof/i.test(cmd)) {
        if (killed) throw noListener();
        return `p${SERVER_PID}\nn127.0.0.1:8188\n`;
      }
      return "";
    });
    vi.spyOn(process, "kill").mockImplementation(() => {
      killed = true;
      const err = new Error("kill EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
    installDesktop2Tree();
    spawnDesktop();

    const stopped = await stopComfyUI();
    expect(stopped.stopped).toBe(true);
    expect(stopped.has_restart_info).toBe(true);
    expect(stopped.launch?.exe).toBe(DESKTOP2_EXE);
    expect(stopped.message).not.toMatch(/left as it was/i);
    expect(stopped.message).not.toMatch(/Could not stop ComfyUI/i);

    const started = await startComfyUI();
    expect(started.started).toBe(true);
    expectSpawnedDesktop2();
  });

  it("still reports stopped:false when the kill fails and the original pid owns the port", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill/i.test(cmd) || /pkill|\bkill\b/i.test(cmd)) {
        const err = new Error(`Command failed: taskkill /PID ${SERVER_PID} /T /F`) as Error & {
          stderr?: string;
        };
        err.stderr = "ERROR: Access is denied.\n";
        throw err;
      }
      if (/tasklist/i.test(cmd)) return "";
      if (/pgrep/i.test(cmd)) {
        const err = new Error("no match") as Error & { status?: number };
        err.status = 1;
        throw err;
      }
      if (/netstat/i.test(cmd)) {
        return `  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       ${SERVER_PID}`;
      }
      if (/lsof/i.test(cmd)) return `p${SERVER_PID}\nn127.0.0.1:8188\n`;
      return "";
    });
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("kill EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
    installDesktop2Tree();

    const stopped = await stopComfyUI();
    expect(stopped.stopped).toBe(false);
    expect(stopped.has_restart_info).toBe(false);
    expect(stopped.message).toMatch(/left as it was/i);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "win32")(
    "prefers the Desktop-2 launcher over legacy ComfyUI.exe when both exist on disk",
    async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) return "";
      if (/tasklist/i.test(cmd)) return "";
      if (/pgrep/i.test(cmd)) {
        const err = new Error("no match") as Error & { status?: number };
        err.status = 1;
        throw err;
      }
      if (/if exist/i.test(cmd)) {
        if (cmd.includes("Comfy Desktop.exe") || cmd.includes("ComfyUI.exe")) return "found";
        return "";
      }
      if (/netstat/i.test(cmd) || /lsof/i.test(cmd)) throw noListener();
      return "";
    });
    onDisk(DESKTOP2_EXE, LEGACY_V1_EXE);
    spawnDesktop();

    const started = await startComfyUI();
    expect(started.started).toBe(true);
    expectSpawnedDesktop2();
    const dumped = JSON.stringify(mockSpawn.mock.calls[0]);
    expect(dumped).not.toContain(LEGACY_V1_EXE.replace(/\\/g, "\\\\"));
    },
  );
});
