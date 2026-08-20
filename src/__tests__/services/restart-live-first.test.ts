// Live-first restart script resolution (#476, #426).
//
// A reachable, self-spawned (non-Desktop) ComfyUI whose sys.argv[0] is the
// RELATIVE portable-launcher path `ComfyUI\main.py` must RESTART — anchored to
// the canonical ABSOLUTE install that download_model / the environment services
// already resolved (resolveEffectiveComfyUIBase) — instead of REFUSING because a
// stale/relative COMFYUI_PATH made the script path look nonexistent. The
// refuse-safe behavior is preserved when NO valid live script can be resolved.
//
// Boundaries only are mocked: config, the env-resolution service (workspace-env),
// the python resolver (env-capabilities), child_process, node:fs, the ComfyUI
// client, and global fetch. No real process/port/network/filesystem is touched.

import { EventEmitter } from "node:events";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const mockConfig = vi.hoisted(() => ({
  resolvedPort: 8188,
  // #476/#426: COMFYUI_PATH is unset/stale — the canonical absolute install is
  // known only to the env service (saved default workspace), exactly like the
  // one download_model wrote into in the same session.
  comfyuiPath: undefined as string | undefined,
}));

const mockExecSync = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());
const mockGetSystemStats = vi.hoisted(() => vi.fn());
const mockResetClient = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn((_p: string) => true));
// statSync backs isRegularFile (#535 regular-file validation). By default any path
// that "exists" is a regular file; individual tests override to model a directory.
const mockIsFile = vi.hoisted(() => vi.fn((_p: string) => true));
const mockFindComfyuiPython = vi.hoisted(() => vi.fn());
const mockResolveBase = vi.hoisted(() => vi.fn<[], string | undefined>());
const mockLiveRootFromArgv = vi.hoisted(() =>
  vi.fn<[string[], string?], string | undefined>(),
);
// #535 — the observed-process resolver process-control now falls back to when
// `/proc/<pid>/cwd` yields nothing (i.e. on Windows). Defaults to "unresolved".
const mockResolveLiveServerRoot = vi.hoisted(() =>
  vi.fn<[], { source: string; anchorDir?: string; observedPid?: number }>(() => ({
    source: "unresolved",
  })),
);

vi.mock("../../config.js", () => ({
  config: mockConfig,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyUIAuthHeaders: () => ({}),
  // #848 instance fence — a stable target here; the retarget cases live in
  // desktop-restart.test.ts and panel-restart-health-readiness.test.ts.
  getComfyuiTargetGeneration: () => 0,
  isRemoteMode: () => false,
}));

vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
  spawn: mockSpawn,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  // The live-cwd /proc reader is injected via setLiveCwdResolver in these tests;
  // keep a throwing stub so any un-mocked call path stays refuse-safe (#535).
  readlinkSync: vi.fn(() => {
    throw new Error("no /proc in test");
  }),
  // The port probe reads the kernel socket tables and classifies a failure from its
  // ERRNO: ENOENT ("no /proc on this host") hides nothing and leaves lsof as the
  // only source, which is what these tests model. Omitting this entirely used to
  // throw "readFileSync is not a function" — errno-less, i.e. "I could not look" —
  // which would make every post-kill probe `unknown` and hang the suite.
  readFileSync: vi.fn(() => {
    throw Object.assign(new Error("no /proc in test"), { code: "ENOENT" });
  }),
  // isRegularFile(#535) calls statSync().isFile(); throw for non-existent paths so
  // it returns false, mirroring existsSync, and honor per-test isFile overrides.
  statSync: vi.fn((p: string) => {
    if (!mockExistsSync(String(p))) throw new Error("ENOENT");
    return { isFile: () => mockIsFile(String(p)) };
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

vi.mock("../../services/env-capabilities.js", () => ({
  findComfyuiPython: mockFindComfyuiPython,
}));

// The env-resolution service is the boundary: it owns the canonical absolute base
// (download_model uses the same one) and the argv-derived live root.
vi.mock("../../services/workspace-env.js", () => ({
  resolveEffectiveComfyUIBase: mockResolveBase,
  liveRootFromArgv: mockLiveRootFromArgv,
  // #535 Windows anchor — the OS-observed stand-in for `/proc/<pid>/cwd`. Default
  // `unresolved` keeps every pre-existing case in this file describing exactly the
  // server it described before.
  resolveLiveServerRoot: mockResolveLiveServerRoot,
  // Launched-by-us env-trust flag (#633 P1b) — inert here; start/stop just toggle it.
  markLocalComfyUILaunched: vi.fn(),
  resetLocalComfyUILaunchState: vi.fn(),
}));

// #1904: acquireInstanceWitness opens a REAL WebSocket to COMFYUI_URL. Stub
// it so this file takes the no-witness branch whether or not something is
// listening on the configured ComfyUI port.
vi.mock("../../services/instance-witness.js", async () => ({
  ...(await vi.importActual("../../services/instance-witness.js")),
  acquireInstanceWitness: async () => undefined,
}));

import {
  __processControlTestHooks,
  restartComfyUI,
} from "../../services/process-control.js";

// The canonical live install — where download_model wrote, and where the running
// server's python actually lives. HOST-NATIVE absolute so the test is portable:
// production resolveScriptAnchor uses node:path.isAbsolute, so a hardcoded
// Windows path would read as relative on Ubuntu/macOS CI.
const BASE = resolve("ComfyUI_portable", "ComfyUI");
const ABS_MAIN = join(BASE, "main.py");
const ABS_PYTHON = join(BASE, "python_embeded", "python.exe");

const ORIGINAL_ENV = { ...process.env };

/**
 * execSync that reports a live PID on the port until a kill is issued, then
 * reports the port free — so gatherProcessInfo finds the instance and
 * waitForPortFree returns promptly after the (mocked) kill.
 */
function mockLivePortThenFree(): { killed: () => boolean } {
  let killed = false;
  mockExecSync.mockImplementation((cmd: string) => {
    if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
      killed = true;
      return "";
    }
    if (/netstat/i.test(cmd)) {
      return killed
        ? ""
        : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
    }
    if (/lsof/i.test(cmd)) {
      if (killed) throw noListener();
      // `lsof -nP -iTCP:PORT -sTCP:LISTEN -Fpn` field output: p<pid> / n<addr:port>.
      return "p4321\nn127.0.0.1:8188\n";
    }
    return "";
  });
  return { killed: () => killed };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  process.env.COMFYUI_STARTUP_CHECK_INTERVAL_S = "0.01";
  process.env.COMFYUI_STARTUP_CHECK_MAX_TRIES = "1";
  mockConfig.resolvedPort = 8188;
  mockConfig.comfyuiPath = undefined;
  mockFindComfyuiPython.mockReturnValue(ABS_PYTHON);
  // Portable launcher: relative argv → no argv-derived live root.
  mockLiveRootFromArgv.mockReturnValue(undefined);
  // #535 — restored explicitly because `clearAllMocks` above drops the factory
  // default, and an `undefined` return is NOT something the real resolver can do.
  // Leaving it cleared would only "work" because a try/catch swallows the
  // resulting TypeError — a harness disagreeing with production about its own
  // contract, which is how a mock starts proving nothing.
  mockResolveLiveServerRoot.mockReturnValue({ source: "unresolved" });
  // The env service knows the canonical absolute install.
  mockResolveBase.mockReturnValue(BASE);
  // Everything that resolves to the absolute canonical install exists on disk.
  mockExistsSync.mockImplementation((p: string) => {
    const s = String(p);
    return s === ABS_MAIN || s === ABS_PYTHON;
  });
  // Default: everything that exists is a regular file (tests override to model dirs).
  mockIsFile.mockImplementation((_p: string) => true);
  // Running server exposes the RELATIVE portable-launcher script path.
  mockGetSystemStats.mockResolvedValue({
    system: { argv: ["ComfyUI\\main.py", "--port", "8188"] },
  });
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

describe("restart_comfyui — live-first script resolution (#476, #426)", () => {
  it("RESTARTS a reachable install, anchoring a relative argv[0] to the canonical absolute base (not refusing on a stale/relative COMFYUI_PATH)", async () => {
    mockLivePortThenFree();
    const children: FakeChild[] = [];
    mockSpawn.mockImplementation(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    // Relaunch preflight passes, stop frees the port, relaunch spawns, and the
    // readiness probe sees a live API — a genuine successful restart.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    // It did NOT take the refuse-safe branch — it actually restarted.
    expect(result.message).not.toMatch(/refusing to restart/i);
    expect(result.stopped).toBe(true);
    // Ownership is asserted explicitly: `started` is derived from it (#776), so
    // pinning only `started` would report "false" without saying which evidence
    // produced it. The port is free after the kill in this fixture, so the port
    // owner is unmappable and ownership is honestly unconfirmed — never "not-ours".
    expect(result.listener_ownership).toBe("unconfirmed");
    expect(result.started).toBe(true);
    expect(result.ready).toBe(true);

    // The relaunch spawned the resolved interpreter with the ABSOLUTE main.py —
    // anchored to the canonical base, not the bare relative "ComfyUI\main.py".
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [exe, args] = mockSpawn.mock.calls[0];
    expect(exe).toBe(ABS_PYTHON);
    expect(args[0]).toBe(ABS_MAIN);

    killSpy.mockRestore();
  });

  it("REFUSES a bare relative `main.py` that cannot be anchored (no canonical base, no live root)", async () => {
    // Bare "main.py" with nothing to anchor it to is truly unresolvable — refuse
    // rather than kill a reachable server we cannot relaunch.
    mockResolveBase.mockReturnValue(undefined);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["main.py", "--port", "8188"] },
    });
    mockExistsSync.mockImplementation((p: string) => String(p) === ABS_PYTHON);
    mockLivePortThenFree();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/refusing to restart/i);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("RESTARTS a bare relative `main.py` by anchoring to the LIVE process cwd when no canonical base exists (#535)", async () => {
    // #535: `python main.py …` with an unset/stale COMFYUI_PATH → no canonical
    // base, no argv-derived live root — but the reachable process's cwd points at
    // a valid install containing main.py. Resolve the relative script against that
    // live cwd instead of refusing.
    const LIVE_CWD = resolve("proc", "live_comfy");
    const LIVE_MAIN = join(LIVE_CWD, "main.py");
    mockResolveBase.mockReturnValue(undefined); // no canonical base
    mockLiveRootFromArgv.mockReturnValue(undefined); // no argv root
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: ["main.py", "--cache-none", "--output-directory", "/data/out"],
      },
    });
    // The interpreter and the LIVE-cwd main.py exist; the bare "main.py" does not.
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === ABS_PYTHON || s === LIVE_MAIN;
    });
    // The running process's cwd (captured live, survives the kill).
    __processControlTestHooks.setLiveCwdResolver(() => LIVE_CWD);
    mockLivePortThenFree();
    const children: FakeChild[] = [];
    mockSpawn.mockImplementation(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    // It restarted (did NOT refuse), anchoring the relative script to the live cwd.
    expect(result.message).not.toMatch(/refusing to restart/i);
    expect(result.stopped).toBe(true);
    expect(result.started).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [exe, args, opts] = mockSpawn.mock.calls[0];
    expect(exe).toBe(ABS_PYTHON);
    expect(args[0]).toBe(LIVE_MAIN);
    // Spawn FROM the live cwd, not a stale/undefined config.comfyuiPath (#535 P1).
    expect((opts as { cwd?: string }).cwd).toBe(LIVE_CWD);

    killSpy.mockRestore();
  });

  it("WINDOWS: anchors a relative `ComfyUI\\main.py` on the OS-observed process when /proc yields nothing (#535)", async () => {
    // The 2026-08-10 recurrence. `resolveLiveProcessCwd` returns undefined on
    // Windows (no /proc), so the live-cwd anchor never fired and a relative script
    // with no canonical base was refused outright:
    //   "Resolved ComfyUI script does not exist on disk: ComfyUI\main.py"
    // The observed-process tier supplies the same fact the /proc symlink does — the
    // directory the server's relative main.py must have been resolved against.
    const LIVE_CWD = resolve("bundle");
    const LIVE_MAIN = join(LIVE_CWD, "ComfyUI", "main.py");
    mockResolveBase.mockReturnValue(undefined); // no canonical base
    mockLiveRootFromArgv.mockReturnValue(undefined); // no argv root
    mockGetSystemStats.mockResolvedValue({
      system: { argv: [join("ComfyUI", "main.py"), "--port", "8188"] },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === ABS_PYTHON || s === LIVE_MAIN;
    });
    // No /proc — exactly what Windows gives us.
    __processControlTestHooks.setLiveCwdResolver(() => undefined);
    // …but the OS knows which process holds the port, and its interpreter anchors
    // the relative dir. `anchorDir` is that resolved ancestor: the process's cwd.
    mockResolveLiveServerRoot.mockReturnValue({
      source: "observed-process",
      anchorDir: LIVE_CWD,
      observedPid: 4321, // the pid the port probe reports
    });
    mockLivePortThenFree();
    mockSpawn.mockImplementation(() => new FakeChild());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.message).not.toMatch(/refusing to restart/i);
    expect(result.stopped).toBe(true);
    expect(result.started).toBe(true);
    const [exe, args, opts] = mockSpawn.mock.calls[0];
    expect(exe).toBe(ABS_PYTHON);
    expect(args[0]).toBe(LIVE_MAIN); // the FULL relative path re-anchored, not the basename
    expect((opts as { cwd?: string }).cwd).toBe(LIVE_CWD);

    killSpy.mockRestore();
  });

  it("WINDOWS: a PID MISMATCH discards the observed anchor and keeps the refusal (#535)", async () => {
    // The safety property. The observation is anchored on "whatever is listening on
    // our port"; if that is a DIFFERENT process than the one we are about to kill,
    // its install is not the one being stopped. Anchoring on it would restart the
    // wrong tree after killing the right one — strictly worse than refusing.
    const OTHER_CWD = resolve("someone-elses-bundle");
    mockResolveBase.mockReturnValue(undefined);
    mockLiveRootFromArgv.mockReturnValue(undefined);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: [join("ComfyUI", "main.py"), "--port", "8188"] },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === ABS_PYTHON || s === join(OTHER_CWD, "ComfyUI", "main.py");
    });
    __processControlTestHooks.setLiveCwdResolver(() => undefined);
    mockResolveLiveServerRoot.mockReturnValue({
      source: "observed-process",
      anchorDir: OTHER_CWD,
      observedPid: 9999, // NOT the 4321 on our port
    });
    mockLivePortThenFree();
    mockSpawn.mockImplementation(() => new FakeChild());
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    // Refuse-safe: nothing stopped, nothing spawned, server left running.
    expect(result.message).toMatch(/refusing to restart/i);
    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("WINDOWS: a RELATIVE path argument blocks the inferred anchor (#535 codex gate)", async () => {
    // The anchor is INFERRED, not observed — a directory from which this relative
    // script WOULD name this install, which is not "the directory it was started
    // in". A symlinked launcher satisfies the inference from the wrong place. That
    // gap is harmless for the panel base (#1133) and NOT harmless here, because the
    // value becomes the relaunch's working directory. So when any argument could
    // itself be cwd-relative, the anchor is not adopted.
    const LIVE_CWD = resolve("bundle");
    mockResolveBase.mockReturnValue(undefined);
    mockLiveRootFromArgv.mockReturnValue(undefined);
    mockGetSystemStats.mockResolvedValue({
      system: {
        // `out` is cwd-relative: after a restart from a different cwd it would
        // point somewhere else entirely.
        argv: [join("ComfyUI", "main.py"), "--output-directory", "out"],
      },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === ABS_PYTHON || s === join(LIVE_CWD, "ComfyUI", "main.py");
    });
    __processControlTestHooks.setLiveCwdResolver(() => undefined);
    mockResolveLiveServerRoot.mockReturnValue({
      source: "observed-process",
      anchorDir: LIVE_CWD,
      observedPid: 4321,
    });
    mockLivePortThenFree();
    mockSpawn.mockImplementation(() => new FakeChild());
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.message).toMatch(/refusing to restart/i);
    expect(result.stopped).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("WINDOWS: an EQUALS-FORM relative path blocks the anchor too (#535)", async () => {
    // `--output-directory=out` hides its value inside the flag token, so a guard
    // that skips everything starting with "-" walks straight past it.
    const LIVE_CWD = resolve("bundle-eq");
    mockResolveBase.mockReturnValue(undefined);
    mockLiveRootFromArgv.mockReturnValue(undefined);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: [join("ComfyUI", "main.py"), "--output-directory=out"] },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === ABS_PYTHON || s === join(LIVE_CWD, "ComfyUI", "main.py");
    });
    __processControlTestHooks.setLiveCwdResolver(() => undefined);
    mockResolveLiveServerRoot.mockReturnValue({
      source: "observed-process",
      anchorDir: LIVE_CWD,
      observedPid: 4321,
    });
    mockLivePortThenFree();
    mockSpawn.mockImplementation(() => new FakeChild());
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.message).toMatch(/refusing to restart/i);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("WINDOWS: an equals-form ABSOLUTE path does NOT block the anchor (#535)", async () => {
    // The mirror: unwrapping the payload must not turn every `--flag=…` into a
    // refusal. An absolute value is still cwd-independent.
    const LIVE_CWD = resolve("bundle-eq2");
    const LIVE_MAIN = join(LIVE_CWD, "ComfyUI", "main.py");
    mockResolveBase.mockReturnValue(undefined);
    mockLiveRootFromArgv.mockReturnValue(undefined);
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: [join("ComfyUI", "main.py"), `--output-directory=${resolve("outdir")}`],
      },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === ABS_PYTHON || s === LIVE_MAIN;
    });
    __processControlTestHooks.setLiveCwdResolver(() => undefined);
    mockResolveLiveServerRoot.mockReturnValue({
      source: "observed-process",
      anchorDir: LIVE_CWD,
      observedPid: 4321,
    });
    mockLivePortThenFree();
    mockSpawn.mockImplementation(() => new FakeChild());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.message).not.toMatch(/refusing to restart/i);
    expect(mockSpawn.mock.calls[0][1][0]).toBe(LIVE_MAIN);

    killSpy.mockRestore();
  });

  it("WINDOWS: a plain non-path value (`--port 8188`) does NOT block the anchor (#535)", async () => {
    // The guard above must not be so broad it refuses the very case this issue is
    // about. The reporter's argv carries `--port 8188`; a number cannot be a path.
    const LIVE_CWD = resolve("bundle2");
    const LIVE_MAIN = join(LIVE_CWD, "ComfyUI", "main.py");
    mockResolveBase.mockReturnValue(undefined);
    mockLiveRootFromArgv.mockReturnValue(undefined);
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: [join("ComfyUI", "main.py"), "--port", "8188", "--enable-manager"],
      },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === ABS_PYTHON || s === LIVE_MAIN;
    });
    __processControlTestHooks.setLiveCwdResolver(() => undefined);
    mockResolveLiveServerRoot.mockReturnValue({
      source: "observed-process",
      anchorDir: LIVE_CWD,
      observedPid: 4321,
    });
    mockLivePortThenFree();
    mockSpawn.mockImplementation(() => new FakeChild());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.message).not.toMatch(/refusing to restart/i);
    expect(mockSpawn.mock.calls[0][1][0]).toBe(LIVE_MAIN);

    killSpy.mockRestore();
  });

  it("a CHANGED creation stamp discards the observed anchor — pid equality is not identity (#535 codex gate)", async () => {
    // pid + creation time is this file's standard for process identity, because
    // pid equality across a window is exactly what pid REUSE defeats. The observed
    // resolver re-queries the port owner AFTER the identity bracket has closed, so
    // it needs its own continuity proof.
    //
    // The bracket is left INTACT on purpose. Simply removing the stamp makes
    // `gatherProcessInfo` refuse earlier, with a different (also correct) message —
    // which passed on Windows and failed on Linux, and proved nothing about this
    // guard on either. So the bracket gets a consistent stamp and only the LATER
    // read differs, which is exactly the pid-reuse shape.
    const LIVE_CWD = resolve("bundle3");
    let reads = 0;
    __processControlTestHooks.setProcessIdentityResolver(() => ({
      // The bracket reads it twice (before/after the request) and must agree;
      // everything after that is the post-bracket world.
      startedAt: ++reads <= 2 ? "stable-stamp" : "recycled-pid-different-process",
    }));
    mockResolveBase.mockReturnValue(undefined);
    mockLiveRootFromArgv.mockReturnValue(undefined);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: [join("ComfyUI", "main.py"), "--port", "8188"] },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === ABS_PYTHON || s === join(LIVE_CWD, "ComfyUI", "main.py");
    });
    __processControlTestHooks.setLiveCwdResolver(() => undefined);
    mockResolveLiveServerRoot.mockReturnValue({
      source: "observed-process",
      anchorDir: LIVE_CWD,
      observedPid: 4321,
    });
    mockLivePortThenFree();
    mockSpawn.mockImplementation(() => new FakeChild());
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    // The refuse-safe INVARIANT, not a particular sentence: nothing was stopped,
    // nothing was spawned, the server is left running. The wording of the refusal
    // differs by which guard fires first, and asserting it is what made this test
    // platform-dependent.
    expect(result.started).toBe(false);
    expect(result.stopped).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  // Codex round 2: judging the VALUE was bypassable three ways, because `auto`,
  // `8188` and `-` are all legal directory names. The guard now keys on the FLAG
  // name, whose vocabulary is knowable. Each of these was a live bypass.
  it.each([
    ["a value that looks numeric", ["--output-directory", "8188"]],
    ["a value that looks enum-ish", ["--output-directory", "auto"]],
    ["a value that is a bare dash", ["--output-directory", "-"]],
    ["a positional after `--`", ["--", "relative/thing"]],
  ])("WINDOWS: %s still blocks the inferred anchor (#535 codex round 2)", async (_label, extra) => {
    const LIVE_CWD = resolve("bundle-bypass");
    mockResolveBase.mockReturnValue(undefined);
    mockLiveRootFromArgv.mockReturnValue(undefined);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: [join("ComfyUI", "main.py"), ...extra] },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === ABS_PYTHON || s === join(LIVE_CWD, "ComfyUI", "main.py");
    });
    __processControlTestHooks.setLiveCwdResolver(() => undefined);
    mockResolveLiveServerRoot.mockReturnValue({
      source: "observed-process",
      anchorDir: LIVE_CWD,
      observedPid: 4321,
    });
    mockLivePortThenFree();
    mockSpawn.mockImplementation(() => new FakeChild());
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.message).toMatch(/refusing to restart/i);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it.each([
    ["a BOOLEAN flag that merely reads path-ish", ["--cache-none", "--port", "8188"]],
    ["a counted flag whose value is not a path", ["--cache-lru", "10"]],
    ["a boolean flag before a path flag", ["--log-stdout", "--port", "8188"]],
  ])(
    "WINDOWS: %s does NOT block the anchor — the guard must not refuse ordinary launches (#535)",
    async (_label, extra) => {
      // The over-broad direction, and the one that would quietly un-fix this issue.
      // `--cache-none` and `--log-stdout` are BOOLEAN; a substring test on
      // dir|cache|log treats them as path-valued, eats the next token as their
      // "value", and refuses. `--cache-none` is in this issue's ORIGINAL report.
      const LIVE_CWD = resolve("bundle-bool");
      const LIVE_MAIN = join(LIVE_CWD, "ComfyUI", "main.py");
      mockResolveBase.mockReturnValue(undefined);
      mockLiveRootFromArgv.mockReturnValue(undefined);
      mockGetSystemStats.mockResolvedValue({
        system: { argv: [join("ComfyUI", "main.py"), ...extra] },
      });
      mockExistsSync.mockImplementation((p: string) => {
        const s = String(p);
        return s === ABS_PYTHON || s === LIVE_MAIN;
      });
      __processControlTestHooks.setLiveCwdResolver(() => undefined);
      mockResolveLiveServerRoot.mockReturnValue({
        source: "observed-process",
        anchorDir: LIVE_CWD,
        observedPid: 4321,
      });
      mockLivePortThenFree();
      mockSpawn.mockImplementation(() => new FakeChild());
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: true }) as Response),
      );
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      const result = await restartComfyUI();

      expect(result.message).not.toMatch(/refusing to restart/i);
      expect(mockSpawn.mock.calls[0][1][0]).toBe(LIVE_MAIN);

      killSpy.mockRestore();
    },
  );

  it("WINDOWS: a SECOND value of a multi-value path flag is checked too (#535 codex round 3)", async () => {
    // ComfyUI declares `--extra-model-paths-config` as nargs='+', so it carries
    // one-or-more paths. Checking only the first let `two.yaml` — relative, and
    // separator-free so the positional check waves it through — reach the anchor.
    const LIVE_CWD = resolve("bundle-multi");
    mockResolveBase.mockReturnValue(undefined);
    mockLiveRootFromArgv.mockReturnValue(undefined);
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: [
          join("ComfyUI", "main.py"),
          "--extra-model-paths-config",
          resolve("cfg", "one.yaml"), // absolute — fine on its own
          "two.yaml", // RELATIVE, and the one that used to slip
        ],
      },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === ABS_PYTHON || s === join(LIVE_CWD, "ComfyUI", "main.py");
    });
    __processControlTestHooks.setLiveCwdResolver(() => undefined);
    mockResolveLiveServerRoot.mockReturnValue({
      source: "observed-process",
      anchorDir: LIVE_CWD,
      observedPid: 4321,
    });
    mockLivePortThenFree();
    mockSpawn.mockImplementation(() => new FakeChild());
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.message).toMatch(/refusing to restart/i);
    expect(mockSpawn).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it.each([
    ["a device index on --directml", ["--directml", "0"]],
    ["a URL value carrying slashes", ["--comfy-api-base", "https://api.comfy.org"]],
  ])(
    "WINDOWS: %s does NOT block the anchor (#535 codex round 3)",
    async (_label, extra) => {
      // Two more over-broad cases. `--directml` takes a DEVICE INDEX, not a path —
      // I had wrongly enumerated it. And a URL carries slashes without being
      // something a working directory can move.
      const LIVE_CWD = resolve("bundle-ok");
      const LIVE_MAIN = join(LIVE_CWD, "ComfyUI", "main.py");
      mockResolveBase.mockReturnValue(undefined);
      mockLiveRootFromArgv.mockReturnValue(undefined);
      mockGetSystemStats.mockResolvedValue({
        system: { argv: [join("ComfyUI", "main.py"), ...extra] },
      });
      mockExistsSync.mockImplementation((p: string) => {
        const s = String(p);
        return s === ABS_PYTHON || s === LIVE_MAIN;
      });
      __processControlTestHooks.setLiveCwdResolver(() => undefined);
      mockResolveLiveServerRoot.mockReturnValue({
        source: "observed-process",
        anchorDir: LIVE_CWD,
        observedPid: 4321,
      });
      mockLivePortThenFree();
      mockSpawn.mockImplementation(() => new FakeChild());
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: true }) as Response),
      );
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      const result = await restartComfyUI();

      expect(result.message).not.toMatch(/refusing to restart/i);
      expect(mockSpawn.mock.calls[0][1][0]).toBe(LIVE_MAIN);

      killSpy.mockRestore();
    },
  );

  it("an UNRESOLVED observation changes nothing — the pre-#535 refusal stands (#535)", async () => {
    // The tri-state discipline: "could not observe" is not "observed something
    // usable". This is the branch that must never become a success.
    mockResolveBase.mockReturnValue(undefined);
    mockLiveRootFromArgv.mockReturnValue(undefined);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: [join("ComfyUI", "main.py"), "--port", "8188"] },
    });
    mockExistsSync.mockImplementation((p: string) => String(p) === ABS_PYTHON);
    __processControlTestHooks.setLiveCwdResolver(() => undefined);
    mockResolveLiveServerRoot.mockReturnValue({ source: "unresolved" });
    mockLivePortThenFree();
    mockSpawn.mockImplementation(() => new FakeChild());
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.message).toMatch(/refusing to restart/i);
    expect(result.stopped).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("pairs the live-cwd script with the live-cwd's OWN python, NOT a stale-but-existing COMFYUI_PATH python (#535)", async () => {
    // Stale COMFYUI_PATH points at an OLD install that still exists on disk (its
    // python resolves). The live server runs `python main.py` from a DIFFERENT
    // cwd. The relaunch must use the LIVE cwd's script AND its OWN interpreter —
    // never the old install's python (which would relaunch under the wrong env).
    const LIVE_CWD = resolve("proc", "live_comfy");
    const LIVE_MAIN = join(LIVE_CWD, "main.py");
    const LIVE_PY = join(LIVE_CWD, "venv", "bin", "python");
    const STALE_BASE = resolve("old_install");
    const STALE_PY = join(STALE_BASE, "venv", "bin", "python");
    mockConfig.comfyuiPath = STALE_BASE;
    mockResolveBase.mockReturnValue(STALE_BASE);
    mockLiveRootFromArgv.mockReturnValue(undefined);
    // Interpreter resolution is root-aware: live cwd -> live python; else stale.
    mockFindComfyuiPython.mockImplementation((root?: string) =>
      root === LIVE_CWD ? LIVE_PY : STALE_PY,
    );
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["main.py", "--port", "8188"] },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === LIVE_MAIN || s === LIVE_PY || s === STALE_PY;
    });
    __processControlTestHooks.setLiveCwdResolver(() => LIVE_CWD);
    mockLivePortThenFree();
    mockSpawn.mockImplementation(() => new FakeChild());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.message).not.toMatch(/refusing to restart/i);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [exe, args, opts] = mockSpawn.mock.calls[0];
    expect(exe).toBe(LIVE_PY); // live cwd's python, NOT STALE_PY
    expect(args[0]).toBe(LIVE_MAIN);
    expect((opts as { cwd?: string }).cwd).toBe(LIVE_CWD);

    killSpy.mockRestore();
  });

  it("REFUSES when the live-cwd `main.py` is a DIRECTORY, not a regular file (#535 atomic invariant)", async () => {
    // existsSync alone would accept a directory named main.py; the regular-file
    // guard must reject it so the reachable server is not killed for an unrunnable
    // relaunch. No canonical base, so it falls through to refuse-safe.
    const LIVE_CWD = resolve("proc", "live_comfy");
    const LIVE_MAIN = join(LIVE_CWD, "main.py");
    const LIVE_PY = join(LIVE_CWD, "venv", "bin", "python");
    mockResolveBase.mockReturnValue(undefined);
    mockLiveRootFromArgv.mockReturnValue(undefined);
    mockFindComfyuiPython.mockReturnValue(LIVE_PY);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["main.py", "--port", "8188"] },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === LIVE_MAIN || s === LIVE_PY;
    });
    // main.py exists but is a DIRECTORY; the interpreter is a real file.
    mockIsFile.mockImplementation((p: string) => String(p) !== LIVE_MAIN);
    __processControlTestHooks.setLiveCwdResolver(() => LIVE_CWD);
    mockLivePortThenFree();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/refusing to restart/i);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("REFUSES a live-cwd relative script when the interpreter is only a BARE PATH fallback (never kill without a validated interpreter, #535/#368)", async () => {
    // The live cwd holds main.py, but no venv/embedded python resolves — so the
    // interpreter is a bare `python3`. Killing then spawning that could ENOENT or
    // run the wrong environment; the refuse-safe gate must leave the server up.
    const LIVE_CWD = resolve("proc", "live_comfy");
    const LIVE_MAIN = join(LIVE_CWD, "main.py");
    mockResolveBase.mockReturnValue(undefined);
    mockLiveRootFromArgv.mockReturnValue(undefined);
    mockFindComfyuiPython.mockReturnValue("python3"); // bare, unvalidated
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["main.py", "--port", "8188"] },
    });
    // main.py exists under the live cwd; no absolute interpreter exists on disk.
    mockExistsSync.mockImplementation((p: string) => String(p) === LIVE_MAIN);
    __processControlTestHooks.setLiveCwdResolver(() => LIVE_CWD);
    mockLivePortThenFree();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/refusing to restart/i);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("still REFUSES when the live cwd does NOT contain the relative script (guard falls through to refuse-safe)", async () => {
    // A live cwd that does not hold main.py must NOT produce a bogus absolute
    // path — the on-disk guard rejects it and, with no canonical base, we refuse.
    const WRONG_CWD = resolve("proc", "not_comfy");
    mockResolveBase.mockReturnValue(undefined);
    mockLiveRootFromArgv.mockReturnValue(undefined);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["main.py", "--port", "8188"] },
    });
    // Only the interpreter exists; join(WRONG_CWD, "main.py") does not.
    mockExistsSync.mockImplementation((p: string) => String(p) === ABS_PYTHON);
    __processControlTestHooks.setLiveCwdResolver(() => WRONG_CWD);
    mockLivePortThenFree();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/refusing to restart/i);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("still REFUSES (leaves the server running) when no valid live script can be resolved at all", async () => {
    // No canonical base, no live root, and the relative script does not exist.
    mockResolveBase.mockReturnValue(undefined);
    mockExistsSync.mockImplementation((p: string) => String(p) === ABS_PYTHON);
    mockLivePortThenFree();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/refusing to restart/i);
    expect(result.message).toMatch(/stale/i);
    // Server left running: no relaunch spawn, no kill.
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
    expect(
      mockExecSync.mock.calls.some(([c]) => /taskkill/i.test(String(c))),
    ).toBe(false);

    killSpy.mockRestore();
  });
});

describe("restart_comfyui — explicit absolute spawn cwd, truthful refusal (#711)", () => {
  it("spawns with the resolved install dir as an EXPLICIT absolute cwd when COMFYUI_PATH is unset", async () => {
    // #711: the relaunch must not depend on a wrong/undefined working directory.
    // COMFYUI_PATH is unset; the canonical absolute install comes from the saved
    // default workspace (mockResolveBase). The spawn must run FROM that absolute
    // install dir — previously cwd was left undefined and inherited whatever
    // directory the MCP server happened to run in.
    expect(isAbsolute(BASE)).toBe(true); // the anchor the test resolves against
    mockLivePortThenFree();
    mockSpawn.mockImplementation(() => new FakeChild());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.message).not.toMatch(/refusing to restart/i);
    expect(result.stopped).toBe(true);
    // See the note above: pin the evidence, not just the flag derived from it.
    expect(result.listener_ownership).toBe("unconfirmed");
    expect(result.started).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [exe, args, opts] = mockSpawn.mock.calls[0];
    expect(exe).toBe(ABS_PYTHON);
    expect(args[0]).toBe(ABS_MAIN);
    expect((opts as { cwd?: string }).cwd).toBe(BASE);

    killSpy.mockRestore();
  });

  it("never spawns from a stale COMFYUI_PATH when the script anchored elsewhere — the anchor is the cwd", async () => {
    // #711's residual ENOENT shape: COMFYUI_PATH points at a stale/nonexistent
    // dir while the RUNNING server's script resolves against a DIFFERENT,
    // existing install. Spawning with the stale dir as cwd would ENOENT after
    // the server was already killed; the anchor must win as the spawn cwd.
    const STALE_BASE = resolve("stale_missing_install");
    const LIVE_BASE = resolve("proc", "live_comfy");
    const LIVE_MAIN = join(LIVE_BASE, "main.py");
    const LIVE_PY = join(LIVE_BASE, "venv", "bin", "python");
    mockConfig.comfyuiPath = STALE_BASE;
    mockResolveBase.mockReturnValue(STALE_BASE); // config.comfyuiPath is base input #1
    mockLiveRootFromArgv.mockReturnValue(LIVE_BASE); // live server's own argv root
    mockFindComfyuiPython.mockReturnValue(LIVE_PY);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: [LIVE_MAIN, "--port", "8188"] },
    });
    // The LIVE install exists on disk; the stale COMFYUI_PATH does not.
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === LIVE_MAIN || s === LIVE_PY;
    });
    mockLivePortThenFree();
    mockSpawn.mockImplementation(() => new FakeChild());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.message).not.toMatch(/refusing to restart/i);
    expect(result.stopped).toBe(true);
    expect(result.started).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [, args, opts] = mockSpawn.mock.calls[0];
    expect(args[0]).toBe(LIVE_MAIN);
    expect((opts as { cwd?: string }).cwd).toBe(LIVE_BASE);

    killSpy.mockRestore();
  });

  it("REFUSES with a truthful actionable error (never an ENOENT) when no install can be located", async () => {
    // cwd unset + nothing resolvable: bare relative main.py, no live root, no
    // live cwd, no canonical base. The refusal must say WHERE to point the fix
    // (COMFYUI_PATH or a default workspace) — not surface a raw spawn ENOENT —
    // and the reachable server must be left running.
    mockResolveBase.mockReturnValue(undefined);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["main.py", "--port", "8188"] },
    });
    mockExistsSync.mockImplementation((p: string) => String(p) === ABS_PYTHON);
    mockLivePortThenFree();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/refusing to restart/i);
    expect(result.message).toMatch(/could not locate the ComfyUI install/i);
    expect(result.message).toMatch(/COMFYUI_PATH or a default workspace/i);
    expect(result.message).not.toMatch(/ENOENT/i);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });
});
