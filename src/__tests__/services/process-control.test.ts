import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const mockConfig = vi.hoisted(() => ({
  resolvedPort: 8188,
  comfyuiPath: "/fake/ComfyUI" as string | undefined,
}));

const mockExecSync = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());
const mockGetSystemStats = vi.hoisted(() => vi.fn());
const mockResetClient = vi.hoisted(() => vi.fn());

vi.mock("../../config.js", () => ({
  config: mockConfig,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyUIAuthHeaders: () => ({}),
  // #848 instance fence — a stable target here; the retarget case has its own test.
  getComfyuiTargetGeneration: () => 0,
  isRemoteMode: () => false,
}));

vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
  spawn: mockSpawn,
  // workspace-env (imported transitively for live-first script anchoring)
  // promisifies execFile at module load, so it must be present.
  execFile: vi.fn(),
}));

// assessRelaunch (restart preflight) validates the resolved interpreter/script
// exist on disk. Default: everything exists; a test overrides for the stale-path
// case.
const mockExistsSync = vi.hoisted(() => vi.fn((_p: string) => true));
// statSync drives the spawn-cwd DIRECTORY proof (codex gate: an existing
// regular FILE at COMFYUI_PATH must not become the cwd). Default: a directory.
const mockStatSync = vi.hoisted(() =>
  vi.fn((_p: string) => ({ isDirectory: () => true })),
);
vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  statSync: mockStatSync,
  // The port probe reads the kernel socket tables and classifies a failure from its
  // ERRNO: ENOENT ("no /proc on this host") hides nothing and leaves lsof as the
  // only source, which is what these tests model. Omitting this entirely used to
  // throw "readFileSync is not a function" — errno-less, i.e. "I could not look" —
  // which would make every post-kill probe `unknown` and hang the suite.
  readFileSync: vi.fn(() => {
    throw Object.assign(new Error("no /proc in test"), { code: "ENOENT" });
  }),
}));

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: mockGetSystemStats,
  resetClient: mockResetClient,
  resetObjectInfoCache: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockFindComfyuiPython = vi.hoisted(() => vi.fn());
vi.mock("../../services/env-capabilities.js", () => ({
  findComfyuiPython: mockFindComfyuiPython,
}));

import {
  __processControlTestHooks,
  clearRestartDispatch,
  getRestartDispatchRecord,
  parseListenerPidFromNetstat,
  preflightLocalRestart,
  PROCESS_WIDE_RESTART_DISPATCH_TOKEN,
  restartComfyUI,
  startComfyUI,
  stopComfyUI,
} from "../../services/process-control.js";

/**
 * `lsof -V` STATING that nothing is listening — the port is free.
 *
 * The exit status alone cannot say this: lsof exits 1 both when it searched and
 * matched nothing AND when it could not search at all, and a run that enumerates
 * nothing for lack of permission exits 1 with BOTH streams empty. So the probe
 * keys on the `-V` marker, which is lsof positively naming what it failed to
 * locate. Verified against lsof 4.99.4: with `-V` and nothing listening, status is
 * 1 and `lsof: Internet address not located: TCP:<port>` goes to STDOUT; without
 * `-V`, status is 1 and both streams are empty — the ambiguity that makes
 * "quiet ⇒ free" unsound, so a fixture must not model absence as mere silence.
 *
 * Getting this wrong is invisible on Windows (the netstat branch never reaches
 * lsof) and HANGS the suite on POSIX: a caller waiting for the port to be released
 * never sees a release and waits out its whole budget (#776).
 */
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
  /**
   * Node only leaves `pid` undefined when the spawn FAILED, so a fake that models
   * a successful launch must carry one — 4321, matching the pid the port fixtures
   * below report (#776 listener-ownership).
   */
  pid: number | undefined = 4321;
}

const ORIGINAL_ENV = { ...process.env };

function setLaunchInfo(): void {
  __processControlTestHooks.setLastProcessInfo({
    pid: 0,
    port: 8188,
    argv: ["python", "main.py", "--port", "8188"],
    isDesktopApp: false,
  });
}

function mockSpawnedChildren(): FakeChild[] {
  const children: FakeChild[] = [];
  mockSpawn.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  return children;
}

function mockNoPortProcess(): void {
  mockExecSync.mockImplementation((cmd: string) => {
    if (cmd.includes("lsof")) throw noListener();
    return "";
  });
}

function mockFetchOk(ok: boolean): Mock {
  const fetchMock = vi.fn(async () => ({ ok }) as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function spawnError(message = "spawn python ENOENT"): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  err.syscall = "spawn python";
  err.path = "python";
  return err;
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.COMFYUI_ALWAYS_RESTART;
  delete process.env.COMFYUI_RESTART_MAX_ATTEMPTS;
  delete process.env.COMFYUI_RESTART_WINDOW_S;
  delete process.env.COMFYUI_STARTUP_CHECK_INTERVAL_S;
  delete process.env.COMFYUI_STARTUP_CHECK_MAX_TRIES;
  mockConfig.resolvedPort = 8188;
  mockConfig.comfyuiPath = "/fake/ComfyUI";
  mockFindComfyuiPython.mockReturnValue("/fake/ComfyUI/python_embeded/python.exe");
  mockExistsSync.mockImplementation(() => true);
  mockStatSync.mockImplementation(() => ({ isDirectory: () => true }));
  // The listener-ownership check (#776) probes the spawned child's liveness with a
  // signal-0 `process.kill`. These fakes model a LIVE child, so the probe must say
  // so rather than reaching the real OS and getting ESRCH for a pid that was never
  // real. Individual tests re-spy this where they assert on killing.
  vi.spyOn(process, "kill").mockImplementation(() => true);
  __processControlTestHooks.reset();
  // The identity bracket around /system_stats (#776) needs the port owner's process
  // creation time at both ends — pid equality alone is what pid REUSE defeats. This
  // module's child_process mock has no execFileSync, so the real reader cannot run;
  // model the ordinary host where the stamp IS readable.
  __processControlTestHooks.setProcessIdentityResolver(() => ({
    startedAt: "stable-stamp",
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  __processControlTestHooks.reset();
});

/**
 * A live ComfyUI Desktop shell supervising the backend on the port (#814).
 *
 * A Manager reboot STOPS the process and depends on that shell to start it again, so
 * a Desktop restart now has to prove the shell is there before it dispatches
 * anything. Tests about what happens AFTER the dispatch — the reboot firing, the
 * caches, the dispatch record, "it is never killed" — therefore have to model the
 * install they mean to model: an ordinary Desktop with its supervisor running.
 * Without this they exercise the refusal instead, which is a different test.
 */
function installLiveDesktopSupervisor(backendPid = 4321, shellPid = 300): void {
  __processControlTestHooks.setProcessIdentityResolver((pid) => {
    if (pid === backendPid) return { startedAt: "5000", parentPid: shellPid };
    if (pid === shellPid) {
      return {
        // The OS's own record of the binary — what the supervisor check trusts.
        executablePath: "C:\\Program Files\\Comfy Desktop\\Comfy Desktop.exe",
        commandLine: '"C:\\Program Files\\Comfy Desktop\\Comfy Desktop.exe"',
        // The shell predates the backend it spawned, as causality requires.
        startedAt: "2000",
      };
    }
    return undefined;
  });
  __processControlTestHooks.setParentPidResolver((pid) =>
    pid === backendPid ? shellPid : undefined,
  );
  __processControlTestHooks.setProcessExistsProbe(() => true);
}

describe("process-control startup readiness", () => {
  it("reports ready after the bounded readiness probe succeeds", async () => {
    setLaunchInfo();
    const children = mockSpawnedChildren();
    mockNoPortProcess();
    const fetchMock = mockFetchOk(true);

    const result = await startComfyUI();

    expect(result.started).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.readiness).toEqual({
      ready: true,
      timed_out: false,
      attempts: 1,
      max_tries: 60,
      interval_ms: 1000,
      waited_ms: expect.any(Number),
      probe_url: "http://127.0.0.1:8188/system_stats",
    });
    expect(result.auto_restart?.enabled).toBe(false);
    expect(mockSpawn).toHaveBeenCalledWith(
      "python",
      ["main.py", "--port", "8188"],
      expect.objectContaining({
        detached: true,
        cwd: "/fake/ComfyUI",
        shell: false,
        stdio: "ignore",
      }),
    );
    expect(children[0].unref).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("relaunches via the resolved Python interpreter when argv[0] is a main.py script (#330)", async () => {
    // Real ComfyUI /system_stats argv is sys.argv: argv[0] is the SCRIPT path
    // (…/main.py), NOT the interpreter. Spawning that directly on Windows fails
    // with `spawn EFTYPE`; the relaunch must resolve the Python interpreter and
    // pass the whole argv as its args.
    __processControlTestHooks.setLastProcessInfo({
      pid: 0,
      port: 8188,
      argv: ["C:\\ComfyUI\\main.py", "--port", "8188"],
      isDesktopApp: false,
    });
    const children = mockSpawnedChildren();
    mockNoPortProcess();
    mockFetchOk(true);

    const result = await startComfyUI();

    expect(result.started).toBe(true);
    expect(mockFindComfyuiPython).toHaveBeenCalledWith("/fake/ComfyUI", [
      "C:\\ComfyUI\\main.py",
      "--port",
      "8188",
    ]);
    expect(mockSpawn).toHaveBeenCalledWith(
      "/fake/ComfyUI/python_embeded/python.exe",
      ["C:\\ComfyUI\\main.py", "--port", "8188"],
      expect.objectContaining({
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      }),
    );
    // The spawn cwd is the ABSOLUTE anchor the script resolved against (#711):
    // the live script's own install dir when the host parses the Windows argv
    // path (win32), otherwise the configured install dir (POSIX fallback).
    const spawnOpts = mockSpawn.mock.calls[0][2] as { cwd?: string };
    expect(["C:\\ComfyUI", "/fake/ComfyUI"]).toContain(spawnOpts.cwd);
    expect(children[0].unref).toHaveBeenCalled();
  });

  it("recognizes a QUOTED main.py script path and relaunches via the interpreter (#401 / #433)", async () => {
    // A launcher can leave surrounding quotes on argv[0] ("C:\ComfyUI\main.py").
    // The suffix test must strip them, else the quoted path fails the `.py` check,
    // bypasses the resolver, and is spawned as the executable.
    __processControlTestHooks.setLastProcessInfo({
      pid: 0,
      port: 8188,
      argv: ['"C:\\ComfyUI\\main.py"', "--port", "8188"],
      isDesktopApp: false,
    });
    const children = mockSpawnedChildren();
    mockNoPortProcess();
    mockFetchOk(true);

    const result = await startComfyUI();

    expect(result.started).toBe(true);
    // Resolved via the Python interpreter, with the UNQUOTED script path.
    expect(mockSpawn).toHaveBeenCalledWith(
      "/fake/ComfyUI/python_embeded/python.exe",
      ["C:\\ComfyUI\\main.py", "--port", "8188"],
      expect.objectContaining({ detached: true, shell: false }),
    );
    expect(children[0].unref).toHaveBeenCalled();
  });

  it("anchors a RELATIVE script argv[0] to the ComfyUI root (portable launcher, #330)", async () => {
    // The standard Windows portable launcher runs `python ComfyUI\main.py` from
    // the portable ROOT, so sys.argv[0] is relative. Since we force cwd to the
    // nested ComfyUI dir, passing it verbatim would look for ComfyUI\ComfyUI\
    // main.py — it must be anchored to config.comfyuiPath.
    __processControlTestHooks.setLastProcessInfo({
      pid: 0,
      port: 8188,
      argv: ["ComfyUI\\main.py", "--port", "8188"],
      isDesktopApp: false,
    });
    mockSpawnedChildren();
    mockNoPortProcess();
    mockFetchOk(true);

    const result = await startComfyUI();

    expect(result.started).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith(
      "/fake/ComfyUI/python_embeded/python.exe",
      [join("/fake/ComfyUI", "main.py"), "--port", "8188"],
      expect.objectContaining({ cwd: "/fake/ComfyUI", shell: false }),
    );
  });

  it("omits the spawn cwd when COMFYUI_PATH points at a nonexistent dir (#711)", async () => {
    // A stale/nonexistent COMFYUI_PATH passed as the spawn cwd would ENOENT the
    // relaunch. The fallback must omit cwd instead — the child then inherits
    // this process's (existing) working directory.
    mockConfig.comfyuiPath = "/stale/missing/ComfyUI";
    mockExistsSync.mockImplementation(() => false);
    mockStatSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    setLaunchInfo();
    mockSpawnedChildren();
    mockNoPortProcess();
    mockFetchOk(true);

    const result = await startComfyUI();

    expect(result.started).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const opts = mockSpawn.mock.calls[0][2] as { cwd?: string };
    expect(opts.cwd).toBeUndefined();
  });

  it("omits the spawn cwd when COMFYUI_PATH resolves to a regular FILE (codex gate)", async () => {
    // An existing-but-not-a-directory COMFYUI_PATH passed as the spawn cwd
    // fails ENOTDIR after the server was already stopped — the same
    // lost-server failure class as #711. The fallback must omit cwd.
    mockConfig.comfyuiPath = "/fake/ComfyUI/main.py";
    mockStatSync.mockImplementation(() => ({ isDirectory: () => false }));
    setLaunchInfo();
    mockSpawnedChildren();
    mockNoPortProcess();
    mockFetchOk(true);

    const result = await startComfyUI();

    expect(result.started).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const opts = mockSpawn.mock.calls[0][2] as { cwd?: string };
    expect(opts.cwd).toBeUndefined();
  });

  it("reports timeout instead of ready when bounded probes never succeed", async () => {
    vi.useFakeTimers();
    process.env.COMFYUI_STARTUP_CHECK_INTERVAL_S = "0.01";
    process.env.COMFYUI_STARTUP_CHECK_MAX_TRIES = "2";
    setLaunchInfo();
    mockSpawnedChildren();
    mockNoPortProcess();
    const fetchMock = mockFetchOk(false);

    const pending = startComfyUI();
    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;

    // #367: the budget expired while the launched process was STILL ALIVE, so the
    // verdict is "not confirmed yet", not "failed". `ready` stays false — nothing
    // answered — but the launch itself is reported as the thing that did happen.
    expect(result.started).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.startup).toBe("unconfirmed");
    expect(result.readiness).toMatchObject({
      ready: false,
      timed_out: true,
      attempts: 2,
      max_tries: 2,
      interval_ms: 10,
      probe_url: "http://127.0.0.1:8188/system_stats",
    });
    expect(result.message).toMatch(/NOT CONFIRMED YET/);
    // ASSERT THE REASON, NOT THE STATE: the whole bug was a message that read as a
    // failure. A test that only checked "an error came back" passes either way.
    expect(result.message).toMatch(/does NOT mean it failed/i);
    expect(result.message).not.toMatch(/failed relaunch/i);
    expect(result.message).not.toMatch(/ComfyUI is DOWN/);
    // …and it must steer the caller AWAY from the destructive response.
    expect(result.message).toMatch(/Do NOT kill it/i);
    expect(result.message).toMatch(/get_system_stats \(action:"health"\)/);
    expect(result.message).toMatch(/COMFYUI_STARTUP_CHECK_MAX_TRIES/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a launched process that DIED before the API answered is a failure, not 'not yet' (#367)", async () => {
    // The other side of the same split. Only an OBSERVED death may produce the
    // definite negative — and when we have one, #776's truthful DOWN report is
    // preserved exactly.
    vi.useFakeTimers();
    process.env.COMFYUI_STARTUP_CHECK_INTERVAL_S = "0.01";
    process.env.COMFYUI_STARTUP_CHECK_MAX_TRIES = "2";
    setLaunchInfo();
    const children = mockSpawnedChildren();
    mockNoPortProcess();
    const fetchMock = mockFetchOk(false);

    const pending = startComfyUI();
    // The relaunch aborts during import — the #776 shape.
    children[0].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;

    expect(result.started).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.startup).toBe("failed");
    expect(result.message).toMatch(/EXITED \(exit code 1\)/);
    expect(result.message).toMatch(/THIS RELAUNCH FAILED/);
    expect(result.message).toMatch(/not a slow start/i);
    // It must NOT be softened into the unconfirmed wording — a real failure
    // reported as "it may still be coming up" is the mirror-image lie.
    expect(result.message).not.toMatch(/NOT CONFIRMED YET/);
    expect(result.message).not.toMatch(/Do NOT kill it/i);
    // …but the scope of the claim is OUR launch, not the machine. Our child dying
    // does not establish that nothing is serving the port: an external supervisor
    // may have brought one back since the last probe, and the old wording asserted
    // a present global state from a fact about our own process (codex gate).
    expect(result.message).not.toMatch(/ComfyUI is DOWN/);
    expect(result.message).toMatch(/re-check with get_system_stats \(action:"health"\)/i);
    // Nor may it claim the API NEVER came up. A poll establishes only what the
    // SCHEDULED PROBES saw; the server could have answered in a gap between two of
    // them, so the supportable statement is about the probes (codex gate round 3).
    expect(result.message).not.toMatch(/before the API came up/i);
    expect(result.message).not.toMatch(/did not become ready/i);
    // "HEALTHY response": the poller counts any non-2xx as not-ready, so a 503 from
    // a half-started server IS a response and "no response" would be false.
    expect(result.message).toMatch(/no readiness probe got a healthy response/i);
    expect(result.message).not.toMatch(/no readiness probe got a response\b/i);
    expect(result.message).toMatch(/the last one included/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports child process spawn errors without throwing", async () => {
    setLaunchInfo();
    const children = mockSpawnedChildren();
    mockNoPortProcess();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

    const pending = startComfyUI();
    expect(() => children[0].emit("error", spawnError())).not.toThrow();
    const result = await pending;

    expect(result).toMatchObject({
      started: false,
      ready: false,
      message: expect.stringMatching(/failed to launch/i),
      spawn_error: {
        message: "spawn python ENOENT",
        code: "ENOENT",
        syscall: "spawn python",
        path: "python",
      },
    });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});

describe("process-control crash supervision", () => {
  it("does not restart a supervised child after deliberate restart_comfyui (action:\"stop\")", async () => {
    process.env.COMFYUI_ALWAYS_RESTART = "1";
    setLaunchInfo();
    const children = mockSpawnedChildren();
    mockFetchOk(true);

    let portCheckCalls = 0;
    let killIssued = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killIssued = true;
        return "";
      }
      if (cmd.includes("netstat") || cmd.includes("lsof")) {
        portCheckCalls += 1;
        // The first two lookups belong to restart_comfyui (action:"start") (the already-running guard
        // and the post-readiness PID). From then until the kill, the port is OWNED:
        // restart_comfyui (action:"stop") looks it up, re-confirms the server that answered still owns
        // it, and re-checks the identity again immediately before killing (#776) —
        // a count-based fixture would break every time that evidence chain grows.
        // After the kill the port is free, so waitForPortFree returns at once.
        if (portCheckCalls >= 3 && !killIssued) {
          if (cmd.includes("netstat"))
            return "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
          // `lsof -nP -iTCP:PORT -sTCP:LISTEN -Fpn` field output: p<pid> / n<addr:port>.
          return "p4321\nn127.0.0.1:8188\n";
        }
        throw noListener();
      }
      return "";
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--port", "8188"] },
    });

    await startComfyUI();
    const stopResult = await stopComfyUI();
    expect(() => children[0].emit("error", spawnError("late EIO"))).not.toThrow();
    children[0].emit("exit", 1, null);

    expect(stopResult.stopped).toBe(true);
    expect(stopResult.auto_restart?.enabled).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockResetClient).toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("restarts unexpected child exits up to the configured window limit", async () => {
    process.env.COMFYUI_ALWAYS_RESTART = "1";
    process.env.COMFYUI_RESTART_MAX_ATTEMPTS = "2";
    process.env.COMFYUI_RESTART_WINDOW_S = "60";
    setLaunchInfo();
    const children = mockSpawnedChildren();
    mockNoPortProcess();
    mockFetchOk(true);

    const startResult = await startComfyUI();
    children[0].emit("exit", 1, null);
    children[1].emit("exit", 1, null);
    children[2].emit("exit", 1, null);

    expect(startResult.started).toBe(true);
    expect(startResult.auto_restart).toMatchObject({
      enabled: true,
      supported: true,
      max_restarts: 2,
      window_ms: 60000,
    });
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(children).toHaveLength(3);
  });

  it("counts repeated supervised child errors against the restart budget", async () => {
    process.env.COMFYUI_ALWAYS_RESTART = "1";
    process.env.COMFYUI_RESTART_MAX_ATTEMPTS = "2";
    process.env.COMFYUI_RESTART_WINDOW_S = "60";
    setLaunchInfo();
    const children = mockSpawnedChildren();
    mockNoPortProcess();
    mockFetchOk(true);

    const startResult = await startComfyUI();
    expect(() => children[0].emit("error", spawnError("first"))).not.toThrow();
    expect(() => children[1].emit("error", spawnError("second"))).not.toThrow();
    expect(() => children[2].emit("error", spawnError("third"))).not.toThrow();

    expect(startResult.started).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(children).toHaveLength(3);
  });
});

describe("process-control restart relaunch preflight (#368/#370)", () => {
  // execSync mock that reports a live PID on the port (so the running instance
  // is found) but records any kill so a test can assert the server was NOT taken
  // down.
  function mockLivePortNoKill(): void {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("netstat"))
        return "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      // `lsof -nP -iTCP:PORT -sTCP:LISTEN -Fpn` field output: p<pid> / n<addr:port>.
      if (cmd.includes("lsof")) return "p4321\nn127.0.0.1:8188\n";
      // tasklist (desktop detection), taskkill, `if exist`, etc. → nothing found
      return "";
    });
  }

  it("refuses to stop when the resolved script points at a stale install that doesn't exist", async () => {
    mockLivePortNoKill();
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["C:\\stale\\ComfyUI\\main.py", "--port", "8188"] },
    });
    // The interpreter resolves and exists, but the stale main.py does not.
    mockExistsSync.mockImplementation((p: string) => !/stale/i.test(p));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/refusing to restart/i);
    expect(result.message).toMatch(/stale/i);
    // Server must be left running: no relaunch spawn, no kill, no client reset
    // (resetClient only fires inside the stop path).
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockResetClient).not.toHaveBeenCalled();
    expect(
      mockExecSync.mock.calls.some(([c]) => /taskkill/i.test(String(c))),
    ).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("reboots a local Desktop app via ComfyUI-Manager instead of killing it (#400)", async () => {
    // A Desktop install is Electron-supervised: killing it and re-spawning the
    // exe leaves it down (stopped:true, started:false). It must reboot via the
    // Manager HTTP endpoint and never be killed. The old behavior (refuse when
    // the exe can't be located) no longer applies — the exe is irrelevant now.
    mockLivePortNoKill();
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: [
          "C:\\Users\\x\\AppData\\Local\\Programs\\Comfy Desktop\\resources\\ComfyUI\\main.py",
          "--port",
          "8188",
        ],
      },
    });
    // Exe cannot be located on disk — under the old path this refused; now it
    // is never consulted because we reboot via the Manager instead.
    mockExistsSync.mockImplementation(() => false);
    // …and the shell that would re-exec it is running, which is what makes the
    // reboot a safe stop at all (#814).
    installLiveDesktopSupervisor();
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 1000,
      intervalMs: 5,
    });
    const fetchMock = mockFetchOk(true); // reboot fires + /system_stats ready
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(true);
    expect(result.ready).toBe(true);
    // See desktop-restart.test.ts — a Manager reboot spawns nothing of ours, so
    // `started` has no evidence to rest on and `ready` carries the outcome.
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/reboot request was acknowledged/i);
    expect(result.message).toMatch(/Desktop\/supervised/i);
    // Never killed / re-spawned.
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
    expect(
      mockExecSync.mock.calls.some(([c]) => /taskkill/i.test(String(c))),
    ).toBe(false);
    // The Manager reboot endpoint was hit.
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes("/manager/reboot")),
    ).toBe(true);

    killSpy.mockRestore();
  });
});

describe("parseListenerPidFromNetstat — locale-independent port→PID (#449)", () => {
  it("finds the owning PID from an English LISTENING line", () => {
    const out = "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       6789";
    expect(parseListenerPidFromNetstat(out, 8188)).toBe(6789);
  });

  it("finds the PID even when the state word is LOCALIZED (German 'ABHÖREN')", () => {
    // The old detector piped through `findstr LISTENING`; on non-English Windows
    // the state column is translated, so that filter matched nothing and a
    // reachable ComfyUI looked like 'no process on port' (issue #449).
    const out = [
      "Aktive Verbindungen",
      "",
      "  Proto  Lokale Adresse     Remoteadresse      Status      PID",
      "  TCP    0.0.0.0:8188       0.0.0.0:0          ABHÖREN     6789",
    ].join("\n");
    expect(parseListenerPidFromNetstat(out, 8188)).toBe(6789);
  });

  it("matches an IPv6 listener too", () => {
    const out = "  TCP    [::]:8188   [::]:0   ABHÖREN   6789";
    expect(parseListenerPidFromNetstat(out, 8188)).toBe(6789);
  });

  it("IGNORES an outbound/established connection whose REMOTE peer uses the port", () => {
    // Local column is bound to an ephemeral port; only the foreign column shows
    // :8188. Anchoring on the local column must skip this line.
    const out = "  TCP    127.0.0.1:54210   127.0.0.1:8188   HERGESTELLT   4444";
    expect(parseListenerPidFromNetstat(out, 8188)).toBeNull();
  });

  it("does not confuse a superset port (:81880 / :18188) with :8188", () => {
    const out = [
      "  TCP    0.0.0.0:81880   0.0.0.0:0   LISTENING   1111",
      "  TCP    0.0.0.0:18188   0.0.0.0:0   LISTENING   2222",
    ].join("\n");
    expect(parseListenerPidFromNetstat(out, 8188)).toBeNull();
  });

  it("rejects a non-listening row whose LOCAL side is bound to :8188 (foreign endpoint not :0)", () => {
    // An established/outbound socket can have its LOCAL side on :8188 while the
    // server is actually down. A listener always has foreign port 0; requiring
    // that avoids returning (and killing) the wrong PID.
    const out = "  TCP    127.0.0.1:8188   203.0.113.9:55123   HERGESTELLT   9999";
    expect(parseListenerPidFromNetstat(out, 8188)).toBeNull();
  });

  it("still selects the LISTENING row when a live established connection is also present", () => {
    const out = [
      "  TCP    0.0.0.0:8188      0.0.0.0:0          ABHÖREN       6789",
      "  TCP    127.0.0.1:8188    127.0.0.1:55123    HERGESTELLT   6789",
    ].join("\n");
    expect(parseListenerPidFromNetstat(out, 8188)).toBe(6789);
  });
});

describe("findPidByPort resilience to localized netstat state (#449)", () => {
  // IS_WIN is captured from os.platform() at module load, so this test exercises
  // the Windows `netstat` branch only on Windows. On Ubuntu CI findPidByPort
  // takes the `lsof` path and this wiring test is not meaningful — the pure
  // parseListenerPidFromNetstat suite above covers the locale mechanism on every
  // platform. (The reachable-diagnostic tests below are platform-agnostic: they
  // resolve no PID on either branch.)
  const winIt = process.platform === "win32" ? it : it.skip;
  winIt("restart_comfyui (action:\"stop\") finds the listener PID even on non-English Windows", async () => {
    // Realistic German netstat -ano blob: state column is 'ABHÖREN', not
    // 'LISTENING'. The mock emulates the actual shell pipeline — a chained
    // `findstr LISTENING` (the OLD detector) would filter every line out,
    // reproducing the false 'no process on port' failure. The current detector
    // parses `netstat -ano` directly and must still map the port to PID 6789.
    const GERMAN_BLOB = [
      "Aktive Verbindungen",
      "",
      "  Proto  Lokale Adresse     Remoteadresse      Status      PID",
      "  TCP    0.0.0.0:8188       0.0.0.0:0          ABHÖREN     6789",
      "  TCP    [::]:8188          [::]:0             ABHÖREN     6789",
      "  TCP    127.0.0.1:54210    127.0.0.1:8188     HERGESTELLT 4444",
    ].join("\n");

    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (cmd.includes("netstat")) {
        if (killed) return ""; // port freed after kill → waitForPortFree resolves
        // Emulate the shell: a chained `findstr LISTENING` filters by that word.
        if (/findstr\s+LISTENING/i.test(cmd)) {
          return GERMAN_BLOB.split("\n")
            .filter((l) => l.includes("LISTENING"))
            .join("\n");
        }
        return GERMAN_BLOB;
      }
      if (cmd.includes("lsof")) throw noListener();
      return ""; // tasklist / powershell fallback / `if exist` → nothing
    });
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--port", "8188"] },
    });

    const result = await stopComfyUI();

    expect(result.stopped).toBe(true);
    expect(result.message).toContain("6789");
    expect(
      mockExecSync.mock.calls.some(([c]) => /taskkill/i.test(String(c))),
    ).toBe(true);
    expect(mockResetClient).toHaveBeenCalled();
  });

  it("restart reports a REACHABLE diagnostic (not 'no process') when the server answers but no PID maps", async () => {
    // /system_stats answers (server reachable) but every port→PID lookup comes
    // back empty. Liveness is the reachable server, so we must NOT claim the
    // process is absent — and we must NOT take the server down (issue #449).
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("lsof")) throw noListener();
      return ""; // netstat, powershell, tasklist → nothing resolves a PID
    });
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--port", "8188"] },
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/reachable on port 8188/i);
    expect(result.message).not.toMatch(/no comfyui process found/i);
    // Server left untouched: no relaunch, no kill.
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(
      mockExecSync.mock.calls.some(([c]) => /taskkill/i.test(String(c))),
    ).toBe(false);

    killSpy.mockRestore();
  });

  it("reachable-but-no-PID must NOT fall through to killing a Desktop shell (atomic-restart)", async () => {
    // Server answers /system_stats but no port→PID maps, AND a Desktop shell
    // (Comfy Desktop.exe) is present. We must NOT kill that shell — we can't
    // confirm it owns :8188 — so leave everything untouched and diagnose.
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("lsof")) throw noListener();
      if (/tasklist/i.test(cmd)) {
        // A Comfy Desktop shell IS running.
        return '"Comfy Desktop.exe","4242","Console","1","206,248 K"';
      }
      return ""; // netstat / powershell resolve no listener PID
    });
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--port", "8188"] },
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/reachable on port 8188/i);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(
      mockExecSync.mock.calls.some(([c]) => /taskkill/i.test(String(c))),
    ).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });
});

describe("restart truthfulness + Pinokio-shaped refusal (#742)", () => {
  // Same live-port wiring as the #368/#370 preflight suite: a live PID on the
  // port (so the running instance is found) with every kill recorded, so a test
  // can prove the server was NOT taken down.
  function mockLivePortNoKill(): void {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("netstat"))
        return "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      if (cmd.includes("lsof")) return "p4321\nn127.0.0.1:8188\n";
      return ""; // tasklist / taskkill / `if exist` → nothing
    });
  }

  // The #742 shape: a Pinokio-managed ComfyUI — externally supervised, launched
  // as a RELATIVE `main.py`, with no COMFYUI_PATH anchor and no resolvable
  // interpreter from here. A plain Manager restart kills it and the supervisor
  // does NOT re-launch it, so any restart from us must refuse BEFORE a stop.
  function mockPinokioShapedInstall(): void {
    mockLivePortNoKill();
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["main.py", "--port", "8188"] },
    });
    mockConfig.comfyuiPath = undefined;
    mockFindComfyuiPython.mockReturnValue(undefined);
  }

  it("preflightLocalRestart refuses a Pinokio-shaped install (no resolvable main.py/interpreter)", async () => {
    mockPinokioShapedInstall();

    const preflight = await preflightLocalRestart();

    expect(preflight.ok).toBe(false);
    expect(preflight.reason).toMatch(/could not build a relaunch command/i);
  });

  it("restartComfyUI refuses a Pinokio-shaped install BEFORE any stop (no kill, no spawn)", async () => {
    mockPinokioShapedInstall();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/refusing to restart/i);
    expect(result.message).toMatch(/left running/i);
    expect(result.message).not.toMatch(/cancel/i);
    // Server left running: no kill, no relaunch spawn, no client reset.
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockResetClient).not.toHaveBeenCalled();
    expect(
      mockExecSync.mock.calls.some(([c]) => /taskkill/i.test(String(c))),
    ).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("preflightLocalRestart passes a resolvable local install", async () => {
    mockLivePortNoKill();
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["/fake/ComfyUI/main.py", "--port", "8188"] },
    });
    // Default mocks: interpreter resolved, every path exists.

    const preflight = await preflightLocalRestart();

    expect(preflight.ok).toBe(true);
  });

  it("preflightLocalRestart passes a Desktop app whose supervisor is PROVEN live (#400)", async () => {
    // #400's ruling is preserved exactly: the Manager reboot is the Desktop restart
    // path and the relaunch command is never consulted. What changed is that being
    // Desktop no longer stands in for being SUPERVISED — that is a fact about the
    // running process tree, and here it is established.
    mockLivePortNoKill();
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: [
          "C:\\Users\\x\\AppData\\Local\\Programs\\Comfy Desktop\\resources\\ComfyUI\\main.py",
          "--port",
          "8188",
        ],
      },
    });
    mockExistsSync.mockImplementation(() => false); // relaunch never consulted
    installLiveDesktopSupervisor();

    const preflight = await preflightLocalRestart();

    expect(preflight.ok).toBe(true);
  });

  it("preflightLocalRestart REFUSES a Desktop app whose supervision cannot be established (#814)", async () => {
    // The counterpart, and the policy the #814 loss forced. A reboot has not happened
    // yet and cannot be undone, so "I could not establish that anything will restart
    // this" refuses — unlike `listener_ownership`, where the launch has ALREADY
    // happened and uncertainty is merely disclosed. Refuse before, disclose after.
    mockLivePortNoKill();
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: [
          "C:\\Users\\x\\AppData\\Local\\Programs\\Comfy Desktop\\resources\\ComfyUI\\main.py",
          "--port",
          "8188",
        ],
      },
    });
    // No parent chain readable — the ordinary shape on a locked-down host.
    __processControlTestHooks.setParentPidResolver(() => undefined);

    const preflight = await preflightLocalRestart();

    expect(preflight.ok).toBe(false);
    expect(preflight.reason).toMatch(/could not be established/i);
  });

  it("preflightLocalRestart REFUSES when no running process can be identified", async () => {
    // The door beside the gate: an instance whose listener cannot be attributed — a
    // container with no `lsof`, a permission wall — used to resolve to NOTHING and
    // return ok, so the reboot went out with no check at all. An instance we cannot
    // identify is an instance whose relaunch we cannot prove.
    mockNoPortProcess();
    mockGetSystemStats.mockRejectedValue(new Error("connection refused"));

    const preflight = await preflightLocalRestart();

    expect(preflight.ok).toBe(false);
    expect(preflight.reason).toMatch(/could not be identified/i);
  });

  it("stop succeeded but relaunch fails → truthful lost-server message, never 'cancelled' (#742)", async () => {
    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill/i.test(String(cmd))) {
        killed = true;
        return "";
      }
      if (cmd.includes("netstat")) {
        if (killed) return ""; // port freed after the kill
        return "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (cmd.includes("lsof")) {
        if (killed) throw noListener();
        return "p4321\nn127.0.0.1:8188\n";
      }
      return ""; // tasklist / `sleep 1 && kill -9` / etc.
    });
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["/fake/ComfyUI/main.py", "--port", "8188"] },
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      killed = true;
      return true;
    });
    const children = mockSpawnedChildren();
    // Readiness never resolves; the relaunch's spawn error short-circuits it.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

    const pending = restartComfyUI();
    await vi.waitFor(() => expect(children.length).toBe(1), {
      timeout: 10000,
      interval: 20,
    });
    children[0].emit("error", spawnError());
    const result = await pending;

    // The stop DID happen — the report must say so truthfully.
    expect(result.stopped).toBe(true);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/stopped but could not be started/i);
    expect(result.message).not.toMatch(/cancel/i);
    expect(result.spawn_error).toBeTruthy();
    // r4/r5: the stop stamped the restart-dispatch record (process-wide slot;
    // never cleared — the relaunch failed).
    const rec = getRestartDispatchRecord(PROCESS_WIDE_RESTART_DISPATCH_TOKEN);
    expect(rec).not.toBeNull();
    expect(rec!.base).toBe("http://127.0.0.1:8188");

    killSpy.mockRestore();
  });

  it("a successful kill+relaunch restart CLEARS the dispatch record (r4)", async () => {
    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill/i.test(String(cmd))) {
        killed = true;
        return "";
      }
      if (cmd.includes("netstat")) {
        if (killed) return ""; // port freed after the kill
        return "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (cmd.includes("lsof")) {
        if (killed) throw noListener();
        return "p4321\nn127.0.0.1:8188\n";
      }
      return ""; // tasklist / `sleep 1 && kill -9` / etc.
    });
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["/fake/ComfyUI/main.py", "--port", "8188"] },
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      killed = true;
      return true;
    });
    mockSpawnedChildren();
    mockFetchOk(true); // the relaunch comes up healthy on the first probe

    const result = await restartComfyUI();

    expect(result.stopped).toBe(true);
    expect(result.started).toBe(true);
    // Observed back → OUR process-wide record is cleared: this restart
    // explains no later down.
    expect(getRestartDispatchRecord(PROCESS_WIDE_RESTART_DISPATCH_TOKEN)).toBeNull();

    killSpy.mockRestore();
  });

  it("a Manager reboot that never comes back leaves the dispatch record stamped (r4)", async () => {
    // Desktop argv → the Manager-reboot path. The reboot FIRES (connection
    // drop) but readiness never returns — the record must stay stamped.
    mockLivePortNoKill();
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: [
          "C:\\Users\\x\\AppData\\Local\\Programs\\Comfy Desktop\\resources\\ComfyUI\\main.py",
          "--port",
          "8188",
        ],
      },
    });
    installLiveDesktopSupervisor();
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 30,
      intervalMs: 5,
    });
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes("reboot")) throw new Error("socket hang up"); // drop = fired
      return { ok: false } as Response; // readiness never ok
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(true);
    expect(result.started).toBe(false);
    const rec = getRestartDispatchRecord(PROCESS_WIDE_RESTART_DISPATCH_TOKEN);
    expect(rec).not.toBeNull();
    expect(rec!.base).toBe("http://127.0.0.1:8188");
  });

  it("a recovery clear removes ONLY the dispatching session's record (r5)", () => {
    // Two sessions' records coexist; clearing one's token must never touch the
    // other's — A's recovery cannot clear B's record.
    __processControlTestHooks.setRestartDispatchRecord("tok-a", {
      at: Date.now(),
      base: "http://127.0.0.1:8188",
    });
    __processControlTestHooks.setRestartDispatchRecord("tok-b", {
      at: Date.now(),
      base: "http://127.0.0.1:8188",
    });

    clearRestartDispatch("tok-a");
    expect(getRestartDispatchRecord("tok-a")).toBeNull();
    expect(getRestartDispatchRecord("tok-b")).not.toBeNull(); // B's survives

    clearRestartDispatch("tok-b");
    expect(getRestartDispatchRecord("tok-b")).toBeNull();
    // Unknown token → no-op, never throws.
    expect(() => clearRestartDispatch("tok-nope")).not.toThrow();
  });
});
