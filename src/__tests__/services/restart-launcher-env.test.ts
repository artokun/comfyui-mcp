// Launcher environment preservation across restart_comfyui (#776).
//
// restart_comfyui rebuilt the launch COMMAND but not the launch ENVIRONMENT: the
// relaunch spawned with no `env`, so the child inherited the ORCHESTRATOR's
// process.env instead of the environment the launcher gave the server. On a
// Stability Matrix install that dropped its bundled PortableGit and FFmpeg from
// PATH — ComfyUI-Manager aborted at import with "Bad git executable", ComfyUI
// never answered /system_stats, and the restart left the server DOWN.
//
// The invariants under test:
//   1. the environment is PRESERVED across a restart (live-read, or reconstructed
//      from a detected Stability Matrix layout);
//   2. an environment we cannot reproduce REFUSES **before** anything is stopped;
//   3. a relaunch that does not come back reports the truth (stopped, not started)
//      instead of claiming a successful restart.
//
// Boundaries only are mocked: config, workspace-env, the python resolver,
// child_process, node:fs, the ComfyUI client and global fetch. No real
// process/port/network/filesystem is touched.

import { EventEmitter } from "node:events";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeChild extends EventEmitter {
  unref = vi.fn();
  /** Set per-test when the listener-ownership check matters. */
  pid: number | undefined = undefined;
}

const mockConfig = vi.hoisted(() => ({
  resolvedPort: 8188,
  comfyuiPath: undefined as string | undefined,
  /** Monotonic ComfyUI-target generation — bumped by the retarget tests. */
  targetGeneration: 0,
}));

const mockExecSync = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());
const mockGetSystemStats = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn((_p: string) => true));
const mockFindComfyuiPython = vi.hoisted(() => vi.fn());
const mockResolveBase = vi.hoisted(() => vi.fn<[], string | undefined>());
const mockLiveRootFromArgv = vi.hoisted(() =>
  vi.fn<[string[], string?], string | undefined>(),
);
/** Contents served for `<Data>/settings.json`, or undefined for "no such file". */
/** An error carrying an errno `code`, as the real fs/child_process produce. */
const errno = vi.hoisted(
  () =>
    (code: string, message?: string): NodeJS.ErrnoException => {
      const err = new Error(message ?? code) as NodeJS.ErrnoException;
      err.code = code;
      return err;
    },
);

/** Per-test override letting a path's `statSync` fail with a chosen errno. */
const mockStatThrows = vi.hoisted(() => ({
  value: undefined as ((p: string) => NodeJS.ErrnoException | undefined) | undefined,
}));

const mockSettingsJsonRef = vi.hoisted(() => ({
  value: undefined as string | undefined,
  /** The file exists on disk but reading it throws. */
  unreadable: false,
}));

vi.mock("../../config.js", () => ({
  config: mockConfig,
  // Reads from the fixture so a retarget mid-restart can be modelled.
  getComfyUIBaseUrl: () => `http://127.0.0.1:${mockConfig.resolvedPort}`,
  getComfyUIAuthHeaders: () => ({}),
  // Stable by default; the retarget tests below drive it.
  getComfyuiTargetGeneration: () => mockConfig.targetGeneration,
  isRemoteMode: () => false,
}));

vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
  spawn: mockSpawn,
}));

// node:fs is shared by process-control (script/interpreter validation) AND by
// launcher-env (the on-disk corroboration of a launcher layout), so one existsSync
// map drives both.
vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readlinkSync: vi.fn(() => {
    throw new Error("no /proc in test");
  }),
  // Serves the launcher's own config file (launcherConfigMentions); everything
  // else — /proc reads — is absent, as on the reporter's platform.
  // Errors carry a `code`, because the launcher-config classifier reads the FAILURE
  // MODE: only ENOENT means "not there", everything else means "could not look".
  readFileSync: vi.fn((p: string) => {
    const s = String(p);
    if (/settings\.jsonc?$/i.test(s)) {
      if (mockSettingsJsonRef.unreadable) throw errno("EACCES", "permission denied");
      if (mockSettingsJsonRef.value !== undefined) return mockSettingsJsonRef.value;
    }
    throw errno("ENOENT", "no such file or directory");
  }),
  // statSync backs the launcher-evidence probe, which classifies from the ERRNO:
  // ENOENT means "not there", anything else means "could not look".
  statSync: vi.fn((p: string) => {
    const forced = mockStatThrows.value?.(String(p));
    if (forced) throw forced;
    if (!mockExistsSync(String(p))) throw errno("ENOENT", "no such file");
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
  resolveEffectiveComfyUIBase: mockResolveBase,
  liveRootFromArgv: mockLiveRootFromArgv,
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

import { detectStabilityMatrix } from "../../services/launcher-env.js";
import {
  __processControlTestHooks,
  preflightLocalRestart,
  restartComfyUI,
  startComfyUI,
  stopComfyUI,
} from "../../services/process-control.js";

// ---------------------------------------------------------------------------
// Install layouts. HOST-NATIVE absolute paths so the separator-agnostic
// detection is exercised on whatever OS runs the suite.
// ---------------------------------------------------------------------------

// Stability Matrix: packages under <Data>/Packages/<pkg>, shared tooling beside it.
const SM_DATA = resolve("StabilityMatrixTest", "Data");
const SM_PKG = join(SM_DATA, "Packages", "ComfyUI");
const SM_MAIN = join(SM_PKG, "main.py");
const SM_PY = join(SM_PKG, "venv", "Scripts", "python.exe");
const SM_GIT_ROOT = join(SM_DATA, "PortableGit");
const SM_GIT_DIR = join(SM_GIT_ROOT, "cmd");
const SM_GIT_EXE = join(SM_GIT_DIR, "git.exe");
const SM_ASSETS_ROOT = join(SM_DATA, "Assets");
const SM_ASSETS_PY = join(
  SM_ASSETS_ROOT,
  "Python",
  "cpython-3.12.11-windows-x86_64-none",
  "python.exe",
);
const SM_FFMPEG_ROOT = join(SM_ASSETS_ROOT, "ffmpeg");
const SM_SETTINGS = join(SM_DATA, "settings.json");
const SM_FFMPEG_DIR = join(SM_FFMPEG_ROOT, "bin");
const SM_FFMPEG_EXE = join(SM_FFMPEG_DIR, "ffmpeg.exe");

// A plain install (no launcher marker anywhere in its paths).
const PLAIN_BASE = resolve("PlainComfyTest", "ComfyUI");
const PLAIN_MAIN = join(PLAIN_BASE, "main.py");
const PLAIN_PY = join(PLAIN_BASE, "venv", "bin", "python");

// Pinokio: an app tree under a `pinokio` root.
const PINOKIO_HOME = resolve("pinokio");
const PINOKIO_API = join(PINOKIO_HOME, "api");
const PINOKIO_BIN = join(PINOKIO_HOME, "bin");
const PINOKIO_APP = join(PINOKIO_API, "comfy.git", "app");
const PINOKIO_MAIN = join(PINOKIO_APP, "main.py");
const PINOKIO_PY = join(PINOKIO_APP, "env", "bin", "python");

// An ordinary install that merely SITS under a `pinokio` tree (not inside its
// `api/` app subtree) — this must never be mistaken for a Pinokio-managed server.
const BENIGN_PINOKIO_PATH = join(PINOKIO_BIN, "comfy", "main.py");
const BENIGN_PINOKIO_PY = join(PINOKIO_BIN, "comfy", "venv", "bin", "python");

const ORIGINAL_ENV = { ...process.env };

/**
 * `lsof -V` STATING that nothing is listening — the port is free.
 *
 * Distinct from a spawn failure (which carries a `code`), because the port probe
 * must not read "I could not look" as "the port is free". The exit status alone
 * cannot carry that distinction either: lsof exits 1 both when it searched and
 * matched nothing AND when it could not search, and a permission-restricted run
 * exits 1 with BOTH streams empty. The `-V` marker — lsof naming what it failed to
 * locate — is the only positive statement of absence, verified against lsof 4.99.4
 * (it lands on STDOUT, with status 1).
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

/** A port probe that FAILS rather than reporting the port free. */
function portProbeUnavailable(): NodeJS.ErrnoException {
  const err = new Error("spawn lsof ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

/** Case-insensitive env lookup (Windows env blocks are case-insensitive). */
function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === wanted) return v;
  }
  return undefined;
}

/** execSync that reports a live PID on the port until a kill, then port free. */
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
      return "p4321\nn127.0.0.1:8188\n";
    }
    return "";
  });
  return { killed: () => killed };
}

/**
 * Model a spawn. The default pid matches the pid the port fixtures report, since
 * Node only leaves `pid` undefined when the spawn FAILED — a successful launch
 * always has one, and modelling it as absent would model a failure.
 * Pass `null` to model that failure explicitly.
 */
function spawnCapturingChildren(pid: number | null = 4321): FakeChild[] {
  const children: FakeChild[] = [];
  mockSpawn.mockImplementation(() => {
    const child = new FakeChild();
    child.pid = pid ?? undefined;
    children.push(child);
    return child;
  });
  return children;
}

function spawnOptions(): { cwd?: string; env?: NodeJS.ProcessEnv } {
  return mockSpawn.mock.calls[0][2] as { cwd?: string; env?: NodeJS.ProcessEnv };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  process.env.COMFYUI_STARTUP_CHECK_INTERVAL_S = "0.01";
  process.env.COMFYUI_STARTUP_CHECK_MAX_TRIES = "1";
  // Keep the port-free wait short: these fixtures deliberately exercise the
  // TIMEOUT path, and 15s of real waiting per test destabilises the whole suite.
  process.env.COMFYUI_PORT_FREE_TIMEOUT_S = "1";
  process.env.PATH = ORIGINAL_ENV.PATH ?? "/usr/bin";
  mockConfig.resolvedPort = 8188;
  mockConfig.comfyuiPath = undefined;
  mockConfig.targetGeneration = 0;
  mockResolveBase.mockReturnValue(undefined);
  mockLiveRootFromArgv.mockReturnValue(undefined);
  __processControlTestHooks.reset();
  // No live-process environment is readable by default (the Windows/macOS case,
  // and the #776 reporter's platform). Individual tests opt in.
  __processControlTestHooks.setLiveEnvResolver(() => undefined);
  // A readable creation stamp but no command line — the neutral shape. The stamp is
  // required to close the identity bracket around /system_stats; leaving the command
  // line out keeps the argv-corroboration check out of the way of tests that are not
  // about it. Tests exercising PID identity install their own resolver.
  __processControlTestHooks.setProcessIdentityResolver(() => ({
    startedAt: "stable-stamp",
  }));
  // Default lineage: the process on the port IS our child. Ownership tests
  // override this; every other test just needs the common case not to lie.
  __processControlTestHooks.setParentPidResolver(() => process.pid);
  mockSettingsJsonRef.value = undefined;
  mockSettingsJsonRef.unreadable = false;
  mockStatThrows.value = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  __processControlTestHooks.reset();
});

// ---------------------------------------------------------------------------

describe("restart_comfyui — Stability Matrix launcher environment (#776)", () => {
  /**
   * @param git    the bundled git binary is resolvable
   * @param ffmpeg the bundled ffmpeg binary is resolvable
   * @param roots  which tooling ROOT directories exist (the detection evidence)
   */
  function useStabilityMatrix(opts?: {
    git?: boolean;
    ffmpeg?: boolean;
    roots?: string[];
    /** Contents of `<Data>/settings.json`, when the test wants one to exist. */
    settingsJson?: string;
    /** The config file EXISTS but every read of it throws. */
    settingsUnreadable?: boolean;
  }): void {
    const git = opts?.git ?? true;
    const ffmpeg = opts?.ffmpeg ?? true;
    const roots = opts?.roots ?? [SM_GIT_ROOT, SM_FFMPEG_ROOT];
    mockSettingsJsonRef.value = opts?.settingsJson;
    mockSettingsJsonRef.unreadable = opts?.settingsUnreadable ?? false;
    mockFindComfyuiPython.mockReturnValue(SM_PY);
    mockLiveRootFromArgv.mockReturnValue(SM_PKG);
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: [SM_MAIN, "--preview-method", "auto", "--enable-manager"],
      },
    });
    const configExists =
      opts?.settingsJson !== undefined || (opts?.settingsUnreadable ?? false);
    // A real filesystem implies every ancestor of an existing directory, so
    // listing `Assets/ffmpeg` must also make `Assets` exist — otherwise the mock
    // models a shape that cannot occur on disk.
    const existingDirs = new Set<string>();
    for (const root of roots) {
      let cur = root;
      while (cur.length > SM_DATA.length && cur.startsWith(SM_DATA)) {
        existingDirs.add(cur);
        cur = dirname(cur);
      }
      existingDirs.add(SM_DATA);
    }
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      if (s === SM_MAIN || s === SM_PY) return true;
      if (existingDirs.has(s)) return true;
      if (git && s === SM_GIT_EXE) return true;
      if (ffmpeg && s === SM_FFMPEG_EXE) return true;
      if (configExists && s === SM_SETTINGS) return true;
      return false;
    });
  }

  it("restores PortableGit + FFmpeg on PATH (and GIT_PYTHON_GIT_EXECUTABLE) for the relaunch", async () => {
    useStabilityMatrix();
    mockLivePortThenFree();
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(true);
    expect(result.started).toBe(true);
    expect(result.ready).toBe(true);
    // A HEALTHY restart whose listener could not be ATTRIBUTED is not the #367
    // "not confirmed yet" shape, and must not be composed as one. Widening
    // `startup:"unconfirmed"` to cover unmappable attribution briefly routed this
    // case into that branch, telling the user "NOT CONFIRMED YET" about a server
    // that was answering — and skipping the dispatch-record clear. `ready` is what
    // separates the two, and the composition keys on it.
    expect(result.startup).toBe("unconfirmed");
    expect(result.message).not.toMatch(/NOT CONFIRMED YET/);
    expect(result.message).toMatch(/up and ready after the restart/i);

    // The relaunch DID carry an explicit environment (the bug was `env` omitted,
    // silently inheriting the orchestrator's).
    const opts = spawnOptions();
    expect(opts.env).toBeDefined();
    const path = envGet(opts.env!, "PATH") ?? "";
    const entries = path.split(delimiter);
    // Both launcher directories are PREPENDED, ahead of whatever we inherited —
    // the launcher's own copies must win.
    expect(entries[0]).toBe(SM_GIT_DIR);
    expect(entries[1]).toBe(SM_FFMPEG_DIR);
    expect(envGet(opts.env!, "GIT_PYTHON_GIT_EXECUTABLE")).toBe(SM_GIT_EXE);

    // ...and the result SAYS the launcher shape was detected and restored.
    expect(result.launch_env?.source).toBe("stability-matrix");
    expect(result.launch_env?.launcher).toBe("Stability Matrix");
    expect(result.launch_env?.path_additions).toEqual([
      SM_GIT_DIR,
      SM_FFMPEG_DIR,
    ]);
    expect(result.message).toMatch(/Stability Matrix/i);

    killSpy.mockRestore();
  });

  async function expectRefusedBeforeStopping(): Promise<string> {
    mockLivePortThenFree();
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/refusing to restart/i);
    // NOTHING was stopped and nothing was spawned.
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
    expect(
      mockExecSync.mock.calls.some(([cmd]) => /taskkill/i.test(String(cmd))),
    ).toBe(false);

    killSpy.mockRestore();
    return result.message;
  }

  it("REFUSES before stopping when NONE of the launcher's tooling resolves", async () => {
    // Provably launcher-owned (both tooling roots are there) but neither binary
    // resolves — the environment cannot be reproduced. Guessing (= inheriting
    // ours) is exactly what took the server down in #776.
    useStabilityMatrix({ git: false, ffmpeg: false });

    const message = await expectRefusedBeforeStopping();

    expect(message).toMatch(/Stability Matrix/i);
    // Told to use the owning launcher — not the generic COMFYUI_PATH advice.
    expect(message).toMatch(/Restart ComfyUI from Stability Matrix/i);
  });

  it("REFUSES before stopping on a PARTIAL layout — FFmpeg present but the bundled Git missing", async () => {
    // A half-rebuilt environment is not a rebuilt environment: relaunching with
    // ffmpeg but no git reproduces the exact #776 failure (Manager aborts at
    // import with "Bad git executable" and the server never comes back).
    useStabilityMatrix({ git: false, ffmpeg: true });

    const message = await expectRefusedBeforeStopping();

    expect(message).toMatch(/bundled Git/i);
    expect(message).toMatch(/Bad git executable/i);
  });

  it("REFUSES before stopping when the FFmpeg asset dir exists but holds no ffmpeg binary", async () => {
    useStabilityMatrix({ git: true, ffmpeg: false });

    const message = await expectRefusedBeforeStopping();

    expect(message).toMatch(/bundled FFmpeg/i);
    expect(message).toMatch(/Assets/);
  });

  it("RESTARTS with Git alone when FFmpeg is provably NOT INSTALLED, and names what was not injected", async () => {
    // A legitimate SM install with PortableGit and no FFmpeg asset at all. There is
    // nothing for the launcher to inject either, so relaunching without it is
    // exactly what the launcher itself would do — refusing here would make such an
    // install PERMANENTLY unrestartable, which is not a safer resting place than a
    // launch that works.
    useStabilityMatrix({ git: true, ffmpeg: false, roots: [SM_GIT_ROOT] });
    mockLivePortThenFree();
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.message).not.toMatch(/refusing to restart/i);
    expect(result.started).toBe(true);
    expect(result.launch_env?.source).toBe("stability-matrix");
    // Git IS injected; FFmpeg is reported as absent rather than silently ignored.
    const opts = spawnOptions();
    expect(envGet(opts.env!, "PATH")!.split(delimiter)[0]).toBe(SM_GIT_DIR);
    expect(envGet(opts.env!, "GIT_PYTHON_GIT_EXECUTABLE")).toBe(SM_GIT_EXE);
    expect(result.launch_env?.path_additions).toEqual([SM_GIT_DIR]);
    expect(result.launch_env?.not_installed).toEqual(["FFmpeg"]);
    expect(result.message).toMatch(/no bundled FFmpeg anywhere under its Data folder/i);

    killSpy.mockRestore();
  });

  it("REFUSES when the launcher's tooling directories cannot be READ", async () => {
    // An ACL-unreadable `Data/PortableGit` looks exactly like "this install has no
    // PortableGit" to `existsSync`. Falling through to the plain-install plan there
    // relaunches a launcher-managed server WITHOUT its environment — #776 itself,
    // reached through the fix for it.
    mockFindComfyuiPython.mockReturnValue(SM_PY);
    mockLiveRootFromArgv.mockReturnValue(SM_PKG);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: [SM_MAIN, "--port", "8188"] },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === SM_MAIN || s === SM_PY || s === SM_ASSETS_ROOT;
    });
    // The layout is CORROBORATED — `Data/Assets` is present — and it is the
    // PortableGit directory that cannot be read. EACCES means "we could not look",
    // which must not be spent as "there is nothing here": that would relaunch a
    // launcher-managed server without the environment it needs.
    //
    // Note the corroboration is deliberately positive. An install whose ONLY
    // Stability Matrix evidence is an unreadable sibling is NOT treated as one —
    // unreadable evidence cannot prove the other shape either, and refusing there
    // would strand a plain install that merely lives under a `Data/Packages` path.
    mockStatThrows.value = (p: string) => {
      const s = String(p);
      if (s === SM_GIT_ROOT) return errno("EACCES", "permission denied");
      return undefined;
    };

    const message = await expectRefusedBeforeStopping();

    // Refused through the ordinary component-evidence path: an unreadable
    // PortableGit is `ambiguous`, exactly like one that exists but whose binary
    // cannot be located. There is no separate "inaccessible" verdict to maintain.
    expect(message).toMatch(/Stability Matrix/i);
    expect(message).toMatch(/bundled Git/i);
    expect(message).toMatch(/Restart ComfyUI from Stability Matrix/i);
  });

  it("REFUSES when the launcher's config EXISTS but cannot be read", async () => {
    // "not-installed" needs BOTH halves: directory absent AND config silent. An
    // unreadable config is neither — folding it into "no mention" would classify a
    // missing PortableGit as not-installed, relaunch without it, and let
    // ComfyUI-Manager abort at import. That is the original down-server bug,
    // reached through the very rule that stops over-refusing.
    useStabilityMatrix({
      git: false,
      ffmpeg: true,
      roots: [SM_FFMPEG_ROOT],
      settingsUnreadable: true,
    });

    const message = await expectRefusedBeforeStopping();

    expect(message).toMatch(/bundled Git/i);
    expect(message).toMatch(/Restart ComfyUI from Stability Matrix/i);
  });

  it("REFUSES when the launcher's own config names a component whose directory is missing", async () => {
    // "Absent" only means not-installed when NOTHING references it. Stability
    // Matrix records what it manages in Data/settings.json, so a mention there
    // turns absence into "expected but unlocatable" — the genuinely ambiguous case
    // that must refuse rather than silently drop what the launcher injects.
    useStabilityMatrix({
      git: true,
      ffmpeg: false,
      roots: [SM_GIT_ROOT],
      settingsJson: '{"assets":["ffmpeg","python310"]}',
    });

    const message = await expectRefusedBeforeStopping();

    expect(message).toMatch(/bundled FFmpeg/i);
    expect(message).toMatch(/Restart ComfyUI from Stability Matrix/i);
  });

  it("recognizes the `<Data>/Assets` store as Stability Matrix even without an ffmpeg subfolder", async () => {
    // The corroboration boundary: requiring `Assets/ffmpeg` specifically missed a
    // real layout — `Data/Packages/…` beside `Data/Assets`, with PortableGit
    // expected but unlocatable. That fell through as a plain install, inherited our
    // environment, and reproduced "Bad git executable". With the store recognized,
    // the per-component evidence rules apply: PortableGit is present but its binary
    // is not, which is ambiguous and must refuse.
    useStabilityMatrix({
      git: false,
      ffmpeg: false,
      roots: [SM_ASSETS_ROOT, SM_GIT_ROOT],
    });

    const message = await expectRefusedBeforeStopping();

    expect(message).toMatch(/Stability Matrix/i);
    expect(message).toMatch(/bundled Git/i);
  });

  it("does NOT mistake an ordinary install that merely lives under a `Data/Packages` path for Stability Matrix", async () => {
    // Name-only evidence must never trigger a refusal: no PortableGit/Assets
    // beside `Packages` means there is no launcher tooling to reconstruct, and
    // this install restarted fine before #776.
    useStabilityMatrix({ git: false, ffmpeg: false, roots: [] });
    mockLivePortThenFree();
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.message).not.toMatch(/refusing to restart/i);
    expect(result.started).toBe(true);
    expect(result.launch_env?.source).toBe("inherited");
    expect(result.launch_env?.reproducible).toBe(true);
    expect(spawnOptions().env).toBeUndefined();

    killSpy.mockRestore();
  });
});

describe("restart_comfyui — the interpreter the HEALTHY server runs wins (#1654)", () => {
  // #1654: a Stability Matrix package holding BOTH `.venv` and `venv`. The layout
  // resolution prefers `.venv` whenever both exist, and this one was an EMPTY,
  // unrelated Python — so the restart stopped a healthy server and relaunched an
  // interpreter with no torch/sqlalchemy (exit 1 at `import sqlalchemy`), leaving
  // ComfyUI down. The working environment was `venv/Scripts/python.exe` — named
  // all along by the OS command line of the very process being restarted.
  const SM_EMPTY_PY = join(SM_PKG, ".venv", "Scripts", "python.exe");
  const SM_ARGV = [SM_MAIN, "--preview-method", "auto", "--enable-manager"];

  /**
   * The issue's disk shape: both environments exist under the package, the layout
   * resolution prefers the EMPTY `.venv`, and the launcher tooling roots are
   * present so the environment plan is reproducible either way.
   */
  function useDualVenvStabilityMatrix(): void {
    mockFindComfyuiPython.mockReturnValue(SM_EMPTY_PY);
    mockLiveRootFromArgv.mockReturnValue(SM_PKG);
    mockGetSystemStats.mockResolvedValue({ system: { argv: SM_ARGV } });
    const roots = [SM_GIT_ROOT, SM_FFMPEG_ROOT];
    // A real filesystem implies every ancestor of an existing directory.
    const existingDirs = new Set<string>();
    for (const root of roots) {
      let cur = root;
      while (cur.length > SM_DATA.length && cur.startsWith(SM_DATA)) {
        existingDirs.add(cur);
        cur = dirname(cur);
      }
      existingDirs.add(SM_DATA);
    }
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      if (s === SM_MAIN || s === SM_PY || s === SM_EMPTY_PY) return true;
      if (existingDirs.has(s)) return true;
      if (s === SM_GIT_EXE || s === SM_FFMPEG_EXE) return true;
      return false;
    });
  }

  /** The OS's view of the healthy server, as WMI reports it on Windows. */
  function osReportsInterpreter(commandLine: string): void {
    __processControlTestHooks.setProcessIdentityResolver((pid) =>
      pid === 4321 ? { startedAt: "stable-stamp", commandLine } : undefined,
    );
  }

  async function restartAndReturnSpawn(): Promise<{
    result: Awaited<ReturnType<typeof restartComfyUI>>;
    exe: string;
    args: string[];
  }> {
    mockLivePortThenFree();
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(true);
    expect(result.started).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [exe, args] = mockSpawn.mock.calls[0];
    killSpy.mockRestore();
    return { result, exe: String(exe), args: args as string[] };
  }

  it("relaunches the interpreter the OS reports for the running server, not the layout's empty `.venv`", async () => {
    // THE issue shape: the healthy server runs under `venv`, the layout prefers
    // `.venv`. The restart must preserve the environment the process was observed
    // running under — that observation is corroborated against the server's own
    // argv, so it cannot be a different install's interpreter.
    useDualVenvStabilityMatrix();
    osReportsInterpreter(
      `"${SM_PY}" "${SM_MAIN}" --preview-method auto --enable-manager`,
    );

    const { result, exe, args } = await restartAndReturnSpawn();

    expect(exe).toBe(SM_PY);
    expect(exe).not.toBe(SM_EMPTY_PY);
    expect(args).toEqual(SM_ARGV);
    // The launcher environment is still reconstructed around the observed
    // interpreter — the #776 preservation is untouched.
    expect(result.launch_env?.source).toBe("stability-matrix");
  });

  it("falls back to the layout resolution when the OS names no usable interpreter", async () => {
    // A shell with an activated venv launches a BARE `python`: argv[0] names no
    // file we can verify (the process's cwd is not ours), so the observation is
    // honestly unknown and the pre-#1654 resolution is what remains.
    useDualVenvStabilityMatrix();
    osReportsInterpreter(`python "${SM_MAIN}" --preview-method auto --enable-manager`);
    mockFindComfyuiPython.mockReturnValue(SM_PY);

    const { exe } = await restartAndReturnSpawn();

    expect(exe).toBe(SM_PY);
  });

  it("never adopts the SCRIPT as the interpreter (a directly exec'd main.py)", async () => {
    // A shebang-launched server has main.py AS argv[0]. Adopting that as the
    // interpreter would spawn a Python file as a program after the stop.
    useDualVenvStabilityMatrix();
    osReportsInterpreter(`"${SM_MAIN}" --preview-method auto --enable-manager`);
    mockFindComfyuiPython.mockReturnValue(SM_PY);

    const { exe, args } = await restartAndReturnSpawn();

    expect(exe).toBe(SM_PY);
    expect(args).toEqual(SM_ARGV);
  });
});

describe("restart_comfyui — Stability Matrix package venv, not Assets CPython (#1704)", () => {
  // #1704: restart/start launched
  //   <Data>/Assets/Python/cpython-…/python.exe
  // instead of the package venv
  //   <Data>/Packages/ComfyUI/venv/Scripts/python.exe
  // The Assets interpreter has no sqlalchemy/torch, so the child exits 1 and
  // leaves ComfyUI down. Happens when this session never observed the
  // interpreter (ComfyUI started outside, or action:"start" after another
  // session) AND when the OS names the venv trampoline's BASE interpreter.
  const SM_PACKAGES = join(SM_DATA, "Packages");
  const SM_ARGV = [SM_MAIN, "--preview-method", "auto", "--use-sage-attention"];

  function useAssetsVsPackageVenv(): void {
    mockFindComfyuiPython.mockReturnValue(SM_ASSETS_PY);
    mockLiveRootFromArgv.mockReturnValue(SM_PKG);
    mockGetSystemStats.mockResolvedValue({ system: { argv: SM_ARGV } });
    const roots = [SM_GIT_ROOT, SM_FFMPEG_ROOT, SM_PACKAGES];
    const existingDirs = new Set<string>();
    for (const root of roots) {
      let cur = root;
      while (cur.length > SM_DATA.length && cur.startsWith(SM_DATA)) {
        existingDirs.add(cur);
        cur = dirname(cur);
      }
      existingDirs.add(SM_DATA);
    }
    // Every ancestor of the Assets CPython (Assets/Python/cpython-…).
    let cur = dirname(SM_ASSETS_PY);
    while (cur.length >= SM_DATA.length && cur.startsWith(SM_DATA)) {
      existingDirs.add(cur);
      cur = dirname(cur);
    }
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      if (s === SM_MAIN || s === SM_PY || s === SM_ASSETS_PY) return true;
      if (existingDirs.has(s)) return true;
      if (s === SM_GIT_EXE || s === SM_FFMPEG_EXE) return true;
      return false;
    });
  }

  function osReportsInterpreter(commandLine: string): void {
    __processControlTestHooks.setProcessIdentityResolver((pid) =>
      pid === 4321 ? { startedAt: "stable-stamp", commandLine } : undefined,
    );
  }

  async function restartAndReturnSpawn(): Promise<{
    exe: string;
    args: string[];
  }> {
    mockLivePortThenFree();
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const result = await restartComfyUI();
    expect(result.stopped).toBe(true);
    expect(result.started).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [exe, args] = mockSpawn.mock.calls[0];
    killSpy.mockRestore();
    return { exe: String(exe), args: args as string[] };
  }

  it("relaunches the package venv when the layout/PATH guess is the unused Assets CPython", async () => {
    // THE additional-reproduction shape: no usable OS interpreter (bare
    // `python`), layout resolution returns Assets python, package venv exists.
    useAssetsVsPackageVenv();
    osReportsInterpreter(`python "${SM_MAIN}" --preview-method auto --use-sage-attention`);

    const { exe, args } = await restartAndReturnSpawn();

    expect(exe).toBe(SM_PY);
    expect(exe).not.toBe(SM_ASSETS_PY);
    expect(args).toEqual(SM_ARGV);
  });

  it("relaunches the package venv when the OS names the Assets CPython (venv trampoline base)", async () => {
    // Windows reports ExecutablePath / a CommandLine argv[0] of the BASE
    // interpreter the venv trampoline loads. Spawning that is the original
    // report: sqlalchemy missing, exit 1.
    useAssetsVsPackageVenv();
    osReportsInterpreter(
      `"${SM_ASSETS_PY}" "${SM_MAIN}" --preview-method auto --use-sage-attention`,
    );

    const { exe } = await restartAndReturnSpawn();

    expect(exe).toBe(SM_PY);
    expect(exe).not.toBe(SM_ASSETS_PY);
  });

  it("start uses the package venv when this session has no observed interpreter", async () => {
    // action:"start" after ComfyUI was started (and stopped) outside this
    // session — lastProcessInfo has the script argv but no observedInterpreter.
    useAssetsVsPackageVenv();
    __processControlTestHooks.setLastProcessInfo({
      pid: 0,
      port: 8188,
      argv: SM_ARGV,
      isDesktopApp: false,
    });
    mockExecSync.mockImplementation((cmd: string) => {
      if (/netstat/i.test(cmd)) return "";
      if (/lsof/i.test(cmd)) throw noListener();
      return "";
    });
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );

    const result = await startComfyUI();

    expect(result.started).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [exe] = mockSpawn.mock.calls[0];
    expect(String(exe)).toBe(SM_PY);
    expect(String(exe)).not.toBe(SM_ASSETS_PY);
  });
});

describe("restart_comfyui — Windows venv trampoline parent, not the base child (#1704)", () => {
  // Recurrence 2026-08-20: the port owner was a base CPython CHILD while its
  // parent was `<install>/venv/Scripts/python.exe`; both had matching
  // `main.py --port 8190 --use-sage-attention`. Restart stopped the tree and
  // relaunched the child's image — a home interpreter with no sqlalchemy.
  // #1761 only remaps Stability Matrix Assets CPython; this is the generic
  // trampoline shape, including when the home happens to be Assets.
  const TRAMPOLINE_ROOT = resolve("VenvTrampolineComfy");
  const TRAMPOLINE_MAIN = join(TRAMPOLINE_ROOT, "main.py");
  const TRAMPOLINE_VENV_PY = join(
    TRAMPOLINE_ROOT,
    "venv",
    "Scripts",
    "python.exe",
  );
  const TRAMPOLINE_BASE_PY = join(resolve("CPythonHome"), "python.exe");
  const TRAMPOLINE_ARGV = [
    TRAMPOLINE_MAIN,
    "--port",
    "8190",
    "--use-sage-attention",
  ];
  const PARENT_PID = 1001;

  function useTrampolineTree(opts?: {
    childCommandLine?: string;
    parentCommandLine?: string;
    parentPid?: number;
  }): void {
    mockFindComfyuiPython.mockReturnValue(TRAMPOLINE_BASE_PY);
    mockLiveRootFromArgv.mockReturnValue(TRAMPOLINE_ROOT);
    mockGetSystemStats.mockResolvedValue({ system: { argv: TRAMPOLINE_ARGV } });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return (
        s === TRAMPOLINE_MAIN ||
        s === TRAMPOLINE_VENV_PY ||
        s === TRAMPOLINE_BASE_PY
      );
    });
    const childCL =
      opts?.childCommandLine ??
      `"${TRAMPOLINE_BASE_PY}" "${TRAMPOLINE_MAIN}" --port 8190 --use-sage-attention`;
    const parentCL =
      opts?.parentCommandLine ??
      `"${TRAMPOLINE_VENV_PY}" "${TRAMPOLINE_MAIN}" --port 8190 --use-sage-attention`;
    const parentPid = opts?.parentPid ?? PARENT_PID;
    __processControlTestHooks.setProcessIdentityResolver((pid) => {
      if (pid === 4321) {
        return {
          startedAt: "child-stamp",
          commandLine: childCL,
          parentPid,
        };
      }
      if (pid === parentPid) {
        return { startedAt: "parent-stamp", commandLine: parentCL };
      }
      return undefined;
    });
  }

  async function restartAndReturnSpawn(): Promise<{
    exe: string;
    args: string[];
  }> {
    mockLivePortThenFree();
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const result = await restartComfyUI();
    expect(result.stopped).toBe(true);
    expect(result.started).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [exe, args] = mockSpawn.mock.calls[0];
    killSpy.mockRestore();
    return { exe: String(exe), args: args as string[] };
  }

  it("relaunches the venv parent when the port owner is the trampoline's base CPython child", async () => {
    useTrampolineTree();

    const { exe, args } = await restartAndReturnSpawn();

    expect(exe).toBe(TRAMPOLINE_VENV_PY);
    expect(exe).not.toBe(TRAMPOLINE_BASE_PY);
    expect(args).toEqual(TRAMPOLINE_ARGV);
  });

  it("relaunches the package venv when the trampoline child is Stability Matrix Assets CPython", async () => {
    // Same tree shape, home = SM Assets. #1761 remapping also covers Assets
    // when a Packages path is already in argv; the parent walk is what remains
    // when the observation is this child/parent pair.
    mockFindComfyuiPython.mockReturnValue(SM_ASSETS_PY);
    mockLiveRootFromArgv.mockReturnValue(SM_PKG);
    const argv = [SM_MAIN, "--port", "8190", "--use-sage-attention"];
    mockGetSystemStats.mockResolvedValue({ system: { argv } });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === SM_MAIN || s === SM_PY || s === SM_ASSETS_PY;
    });
    __processControlTestHooks.setProcessIdentityResolver((pid) => {
      if (pid === 4321) {
        return {
          startedAt: "child-stamp",
          commandLine: `"${SM_ASSETS_PY}" "${SM_MAIN}" --port 8190 --use-sage-attention`,
          parentPid: PARENT_PID,
        };
      }
      if (pid === PARENT_PID) {
        return {
          startedAt: "parent-stamp",
          commandLine: `"${SM_PY}" "${SM_MAIN}" --port 8190 --use-sage-attention`,
        };
      }
      return undefined;
    });

    const { exe } = await restartAndReturnSpawn();

    expect(exe).toBe(SM_PY);
    expect(exe).not.toBe(SM_ASSETS_PY);
  });

  it("does not adopt a venv parent whose command line is a different ComfyUI", async () => {
    useTrampolineTree({
      parentCommandLine: `"${TRAMPOLINE_VENV_PY}" "${join(resolve("OtherComfy"), "main.py")}" --port 8190 --use-sage-attention`,
    });

    const { exe } = await restartAndReturnSpawn();

    expect(exe).toBe(TRAMPOLINE_BASE_PY);
    expect(exe).not.toBe(TRAMPOLINE_VENV_PY);
  });
});

describe("launcher layout detection — path-root handling (#776)", () => {
  // The paths come from the running ComfyUI's sys.argv, which is WINDOWS-flavored
  // whenever ComfyUI runs on Windows regardless of this host. These are pure
  // string+existsSync tests, so they pin the parsing on every OS.
  function pinTooling(dataRoot: string, sep: string): string {
    const gitRoot = `${dataRoot}${sep}PortableGit`;
    const gitExe = `${gitRoot}${sep}cmd${sep}git.exe`;
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === gitRoot || s === gitExe;
    });
    return gitExe;
  }

  it("keeps a UNC root intact (both leading backslashes)", () => {
    const DATA = "\\\\server\\share\\SM\\Data";
    const gitExe = pinTooling(DATA, "\\");

    const sm = detectStabilityMatrix([`${DATA}\\Packages\\ComfyUI\\main.py`]);

    expect(sm?.dataRoot).toBe(DATA);
    expect(sm?.gitExe).toBe(gitExe);
  });

  it("keeps an extended-length (\\\\?\\) root intact", () => {
    const DATA = "\\\\?\\C:\\SM\\Data";
    const gitExe = pinTooling(DATA, "\\");

    const sm = detectStabilityMatrix([`${DATA}\\Packages\\ComfyUI\\main.py`]);

    expect(sm?.dataRoot).toBe(DATA);
    expect(sm?.gitExe).toBe(gitExe);
  });

  it("keeps a drive-letter root intact", () => {
    const DATA = "C:\\Stability Matrix\\Data";
    const gitExe = pinTooling(DATA, "\\");

    const sm = detectStabilityMatrix([`${DATA}\\Packages\\ComfyUI\\main.py`]);

    expect(sm?.dataRoot).toBe(DATA);
    expect(sm?.gitExe).toBe(gitExe);
  });

  it("keeps a POSIX absolute root intact", () => {
    const DATA = "/home/u/StabilityMatrix/Data";
    const gitExe = `${DATA}/PortableGit/cmd/git`;
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === `${DATA}/PortableGit` || s === gitExe;
    });

    const sm = detectStabilityMatrix([`${DATA}/Packages/ComfyUI/main.py`]);

    expect(sm?.dataRoot).toBe(DATA);
    expect(sm?.gitExe).toBe(gitExe);
  });
});

describe("restart_comfyui — irreproducible launcher environments (#776)", () => {
  function usePinokio(opts?: { corroborated?: boolean }): void {
    const corroborated = opts?.corroborated ?? true;
    mockFindComfyuiPython.mockReturnValue(PINOKIO_PY);
    mockLiveRootFromArgv.mockReturnValue(PINOKIO_APP);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: [PINOKIO_MAIN, "--port", "8188"] },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      if (s === PINOKIO_MAIN || s === PINOKIO_PY) return true;
      // BOTH `api/` and `bin/` are the on-disk evidence of a real Pinokio home.
      return corroborated && (s === PINOKIO_API || s === PINOKIO_BIN);
    });
  }

  it("REFUSES a Pinokio-launched server BEFORE stopping it", async () => {
    usePinokio();
    mockLivePortThenFree();
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/refusing to restart/i);
    expect(result.message).toMatch(/Pinokio/);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("does NOT refuse an ordinary install that merely SITS under a `pinokio` tree", async () => {
    // The inverse regression: a real Pinokio home (both `api/` and `bin/` present)
    // but an install living under `pinokio/bin/...`, NOT inside the `api/` app
    // subtree Pinokio manages. A path-component name is not evidence, and a false
    // refusal blocks a restart that would have worked.
    mockFindComfyuiPython.mockReturnValue(BENIGN_PINOKIO_PY);
    mockLiveRootFromArgv.mockReturnValue(join(PINOKIO_BIN, "comfy"));
    mockGetSystemStats.mockResolvedValue({
      system: { argv: [BENIGN_PINOKIO_PATH, "--port", "8188"] },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return (
        s === BENIGN_PINOKIO_PATH ||
        s === BENIGN_PINOKIO_PY ||
        s === PINOKIO_API ||
        s === PINOKIO_BIN
      );
    });
    mockLivePortThenFree();
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.message).not.toMatch(/refusing to restart/i);
    expect(result.message).not.toMatch(/Pinokio/);
    expect(result.started).toBe(true);
    expect(result.launch_env?.source).toBe("inherited");
    expect(result.launch_env?.reproducible).toBe(true);

    killSpy.mockRestore();
  });

  it("does NOT treat a directory merely NAMED `pinokio` as a Pinokio install", async () => {
    // Name-only evidence must never refuse a restart that works today.
    usePinokio({ corroborated: false });
    mockLivePortThenFree();
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.message).not.toMatch(/refusing to restart/i);
    expect(result.started).toBe(true);
    expect(result.launch_env?.source).toBe("inherited");
    expect(result.launch_env?.reproducible).toBe(true);

    killSpy.mockRestore();
  });

  it("still allows the OUT-OF-BAND Manager reboot preflight (that restart preserves the environment itself)", async () => {
    // A Manager reboot re-execs the SAME process, which keeps its own launcher
    // environment — so the environment rule must NOT leak into this preflight.
    usePinokio();
    mockLivePortThenFree();

    // toMatchObject, not toEqual: the preflight also reports the launch arguments
    // it OBSERVED (#848) so the caller can compare them after the reboot. What this
    // test is about is the verdict.
    await expect(preflightLocalRestart()).resolves.toMatchObject({ ok: true });
  });

  it("REPORTS the launch arguments it observed, so the caller can compare them (#848)", async () => {
    // The panel's argv-drift note is built from THIS field. Every panel test injects
    // a fake preflight, so without a direct assertion here `observedLaunch` and both
    // of its spreads could be deleted and the whole suite would stay green (codex
    // gate round 4) — the note would simply go silent forever, and #848 would be
    // un-fixed with nothing to show it.
    usePinokio();
    mockLivePortThenFree();

    const result = await preflightLocalRestart();

    expect(result.ok).toBe(true);
    expect(result.observedArgv).toEqual([PINOKIO_MAIN, "--port", "8188"]);
    expect(result.isDesktopApp).toBe(false);
  });

  it("does NOT refuse from restart_comfyui (action:\"start\") when the server is ALREADY down — it launches and warns", async () => {
    // The refusal exists to protect a RUNNING server. Once ComfyUI is already
    // stopped, refusing would leave it down forever — the one outcome worse than a
    // possibly-degraded launch. So restart_comfyui (action:"start") launches and says so plainly.
    usePinokio();
    mockLivePortThenFree();
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const stopped = await stopComfyUI();
    expect(stopped.stopped).toBe(true);

    const started = await startComfyUI();

    expect(started.started).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    // Best available environment = ours (never a fabricated launcher one).
    expect(spawnOptions().env).toBeUndefined();
    expect(started.launch_env?.reproducible).toBe(false);
    expect(started.launch_env?.launcher).toBe("Pinokio");
    expect(started.message).toMatch(/WARNING/);
    expect(started.message).toMatch(/Pinokio/);

    killSpy.mockRestore();
  });

  it("relaunches a Pinokio server when its LIVE environment could be read", async () => {
    // Same install, but this time we captured the real environment off the live
    // process — there is nothing left to guess, so the restart proceeds.
    usePinokio();
    const LIVE_ENV = {
      PATH: `/pinokio/bin/git:/usr/bin`,
      GIT_PYTHON_GIT_EXECUTABLE: "/pinokio/bin/git/git",
      PINOKIO_APP_NAME: "comfy",
    };
    __processControlTestHooks.setLiveEnvResolver(() => ({ ...LIVE_ENV }));
    // A STABLE identity that also CORROBORATES the server's own argv — the capture
    // is only adopted when the pid provably still denotes that same ComfyUI.
    __processControlTestHooks.setProcessIdentityResolver(() => ({
      startedAt: "t1",
      commandLine: `${PINOKIO_PY} ${PINOKIO_MAIN} --port 8188`,
    }));
    mockLivePortThenFree();
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(true);
    expect(result.started).toBe(true);
    // Spawned with the LIVE environment verbatim — not the orchestrator's.
    expect(spawnOptions().env).toEqual(LIVE_ENV);
    expect(result.launch_env?.source).toBe("live-process");

    killSpy.mockRestore();
  });
});

describe("restart_comfyui — a PID is not a process identity (#776)", () => {
  const PINOKIO_ARGV = [PINOKIO_MAIN, "--port", "8188"];
  const PLAIN_ARGV = [PLAIN_MAIN, "--port", "8188"];

  function usePinokioInstall(): void {
    mockFindComfyuiPython.mockReturnValue(PINOKIO_PY);
    mockLiveRootFromArgv.mockReturnValue(PINOKIO_APP);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: PINOKIO_ARGV },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return (
        s === PINOKIO_MAIN ||
        s === PINOKIO_PY ||
        s === PINOKIO_API ||
        s === PINOKIO_BIN
      );
    });
  }

  /**
   * An identity reader returning the given (creation-time, command-line) pairs in
   * call order. A plain string is shorthand for "this stamp, still running the
   * ComfyUI we identified".
   */
  function identitySequence(
    steps: Array<string | { startedAt: string; commandLine: string }>,
    matchingArgv: string[],
  ): void {
    let i = 0;
    __processControlTestHooks.setProcessIdentityResolver(() => {
      const step = steps[Math.min(i, steps.length - 1)];
      i++;
      return typeof step === "string"
        ? { startedAt: step, commandLine: matchingArgv.join(" ") }
        : step;
    });
  }

  it("does NOT adopt the environment of a PID that was recycled during the read", async () => {
    // ComfyUI exits after the port lookup and the OS hands its number to an
    // unrelated process, whose /proc/<pid>/environ we would otherwise adopt as
    // ComfyUI's launch environment. Proof that it is rejected: this Pinokio
    // install is only restartable BECAUSE of a live environment, so discarding
    // the bogus capture must drop it back to the irreproducible-launcher refusal.
    usePinokioInstall();
    __processControlTestHooks.setLiveEnvResolver(() => ({
      PATH: "/some/unrelated/process/path",
      NOT_COMFYUI: "1",
    }));
    // The identity bracket around /system_stats closes cleanly (reads 1-3 agree);
    // it is the re-verify AFTER the environment read that sees a different process.
    identitySequence(["t1", "t1", "t1", "t2"], PINOKIO_ARGV);
    mockLivePortThenFree();
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/refusing to restart/i);
    expect(result.message).toMatch(/Pinokio/);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("REFUSES outright when the OS says the port owner is running something other than the server that answered", async () => {
    // The gap a creation-time stamp alone cannot close: if the pid was recycled
    // BEFORE we ever read its stamp, every later re-read agrees with itself about
    // the WRONG process. The independent signal is the server's own /system_stats
    // argv — an unrelated program on that number cannot match it. That is POSITIVE
    // counter-evidence, so it must refuse on its own rather than merely decline to
    // bind (which would leave a later transport hiccup free to wave it through).
    usePinokioInstall();
    __processControlTestHooks.setLiveEnvResolver(() => ({ NOT_COMFYUI: "1" }));
    __processControlTestHooks.setProcessIdentityResolver(() => ({
      startedAt: "t9",
      commandLine: "/usr/bin/some-unrelated-daemon --serve",
    }));
    mockLivePortThenFree();
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/not running the ComfyUI that answered/i);
    expect(result.message).toMatch(/some-unrelated-daemon/);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("REFUSES on that mismatch EVEN IF the HTTP re-check then fails transiently", async () => {
    // The combination that used to slip through: the command-line mismatch was
    // downgraded to "no identity", the re-fetch errored so it proved nothing, and
    // the pre-kill check then only re-verified the numeric PID's port ownership —
    // killing the replacement using the previous server's argv and env plan.
    usePinokioInstall();
    let answers = 0;
    mockGetSystemStats.mockImplementation(async () => {
      answers++;
      if (answers > 1) throw new Error("ECONNRESET");
      return { system: { argv: [PINOKIO_MAIN, "--port", "8188"] } };
    });
    __processControlTestHooks.setProcessIdentityResolver(() => ({
      startedAt: "t9",
      commandLine: "/usr/bin/some-unrelated-daemon --serve",
    }));
    mockLivePortThenFree();
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.message).toMatch(/not running the ComfyUI that answered/i);
    expect(killSpy).not.toHaveBeenCalled();
    expect(
      mockExecSync.mock.calls.some(([cmd]) => /taskkill/i.test(String(cmd))),
    ).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("re-checks identity for a DESKTOP answer too, so a substituted instance is never rebooted in its place", async () => {
    // `isDesktopApp` is derived from the FIRST, possibly stale argv. Skipping the
    // recheck there is how a Desktop answer from A gets a ComfyUI-Manager reboot
    // fired at a non-Desktop B that took the port in the meantime.
    const DESKTOP_MAIN = join(
      resolve("AppData", "Local", "Programs", "@comfyorgcomfyui-electron"),
      "resources",
      "ComfyUI",
      "main.py",
    );
    let answers = 0;
    mockFindComfyuiPython.mockReturnValue(PLAIN_PY);
    mockLiveRootFromArgv.mockReturnValue(PLAIN_BASE);
    mockGetSystemStats.mockImplementation(async () => {
      answers++;
      // A = the Desktop app; B = an ordinary install that grabbed the port.
      return {
        system: {
          argv:
            answers <= 1
              ? [DESKTOP_MAIN, "--port", "8188"]
              : [PLAIN_MAIN, "--port", "8188"],
        },
      };
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === PLAIN_MAIN || s === PLAIN_PY;
    });
    mockLivePortThenFree();
    spawnCapturingChildren();
    const rebootFetch = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", rebootFetch);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/changed while it was being identified/i);
    // No Manager reboot was fired at the substituted instance, and nothing killed.
    expect(rebootFetch).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("does NOT KILL a PID that no longer owns the port it was found on", async () => {
    // The server exited between the port lookup and the stop. Its number may
    // already belong to something else, so nothing may be killed.
    usePlainInstallForIdentity();
    // Three lookups belong to identifying the server: the one bracketing
    // /system_stats on each side, and the re-confirmation's. The FOURTH is the
    // pre-kill re-check — by which point the process has exited on its own.
    const IDENTIFY_LOOKUPS = 3;
    let netstatCalls = 0;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/netstat/i.test(cmd)) {
        netstatCalls++;
        return netstatCalls <= IDENTIFY_LOOKUPS
          ? "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321"
          : "";
      }
      if (/lsof/i.test(cmd)) {
        netstatCalls++;
        if (netstatCalls > IDENTIFY_LOOKUPS) throw noListener();
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/no longer owns that port/i);
    expect(result.message).toMatch(/must not be killed/i);
    expect(killSpy).not.toHaveBeenCalled();
    expect(
      mockExecSync.mock.calls.some(([cmd]) => /taskkill/i.test(String(cmd))),
    ).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("does NOT KILL a PID whose process CREATION TIME changed under it", async () => {
    // The stronger identity: the number is still listening, but it is not the
    // process we identified (#650's pid + creation-time identity).
    usePlainInstallForIdentity();
    // Identification (reads 1-3) is consistent; the PRE-KILL re-verify sees the
    // number now belonging to a different process.
    identitySequence(["t1", "t1", "t1", "t2"], PLAIN_ARGV);
    mockLivePortThenFree();
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/creation time/i);
    expect(result.message).toMatch(/must not be killed/i);
    expect(killSpy).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("REFUSES when the port changes hands around the /system_stats call, even with IDENTICAL argv", async () => {
    // The re-ask cannot settle this on its own: A answers, A exits, B binds the
    // port, and if B reports the same argv then both the second answer and the
    // second port lookup are self-consistent — B is accepted and killed. What B
    // cannot reproduce is the identity of the port owner BEFORE the HTTP call, so
    // that observation is what the answer is bracketed by.
    usePlainInstallForIdentity();
    let portLookups = 0;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/netstat/i.test(cmd)) {
        portLookups++;
        // A owns it during the pre-fetch lookup; B owns it by the post-fetch one.
        return portLookups <= 1
          ? "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321"
          : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       5555";
      }
      if (/lsof/i.test(cmd)) {
        portLookups++;
        return portLookups <= 1
          ? "p4321\nn127.0.0.1:8188\n"
          : "p5555\nn127.0.0.1:8188\n";
      }
      return "";
    });
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/changed while ComfyUI was being identified/i);
    expect(result.message).toMatch(/4321/);
    expect(result.message).toMatch(/5555/);
    expect(killSpy).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("REFUSES when the SAME pid number is a different process at each end of the bracket", async () => {
    // Pid equality across a window is exactly what pid REUSE defeats: A owns 4321,
    // answers /system_stats, exits, and B inherits 4321 before the closing lookup.
    // Comparing numbers alone closes the bracket; comparing IDENTITY does not.
    usePlainInstallForIdentity();
    identitySequence(["A-started", "B-started"], PLAIN_ARGV);
    mockLivePortThenFree();
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/changed while ComfyUI was being identified/i);
    expect(result.message).toMatch(/different process reusing that number/i);
    expect(killSpy).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("does NOT treat an unreadable port probe as proof the killed process died — but still brings the server back", async () => {
    // Two mirror-image mistakes to avoid. Reading "the probe failed" as "the port is
    // free" would tear supervision down under a live server. But REFUSING on it is
    // worse: the kill has already been issued, so a refusal cannot restore anything
    // and would leave a dead server unrelaunched — the cardinal failure. So the stop
    // commits, says plainly that it is unverified, and the relaunch runs.
    usePlainInstallForIdentity();
    let killIssued = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killIssued = true;
        return "";
      }
      // EVERY port probe — netstat, the Get-NetTCPConnection fallback, and lsof —
      // stops working once the kill has been issued. Anything less would leave one
      // probe running and legitimately reporting the port free.
      if (/netstat|Get-NetTCPConnection|lsof/i.test(cmd)) {
        if (killIssued) throw portProbeUnavailable();
        return /lsof/i.test(cmd)
          ? "p4321\nn127.0.0.1:8188\n"
          : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      return "";
    });
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    // The stop went through — refusing here could not have un-killed anything.
    expect(result.stopped).toBe(true);
    expect(result.message).toMatch(/could not be checked after the kill/i);
    expect(result.message).toMatch(/not confirmed that PID 4321 exited/i);
    // ...and, crucially, the relaunch was attempted rather than abandoned.
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    killSpy.mockRestore();
  }, 30_000);

  it("still REFUSES when the probe can see that our target is the one holding the port", async () => {
    // The determinable half of the same situation: the kill did not work and the
    // server is provably still running. Here a refusal costs a restart, not a
    // server — so nothing is torn down and no second instance is launched.
    usePlainInstallForIdentity();
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) return "";
      if (/netstat/i.test(cmd)) {
        return "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (/lsof/i.test(cmd)) return "p4321\nn127.0.0.1:8188\n";
      return "";
    });
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.message).toMatch(/still holds port 8188/i);
    expect(result.message).toMatch(/nothing was torn down/i);
    expect(mockSpawn).not.toHaveBeenCalled();

    killSpy.mockRestore();
  }, 30_000);

  it("REFUSES rather than binding an answer it could not bracket (port lookup unreadable on one side)", async () => {
    // The bracket must be REQUIRED, not best-effort: if the pre-call lookup comes
    // back empty there is no anchor, and A-answers-then-B-takes-the-port with
    // identical argv would satisfy every later self-consistent check. One flaky
    // lookup is retried; a bracket that still cannot be closed refuses.
    usePlainInstallForIdentity();
    let lookups = 0;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/netstat/i.test(cmd)) {
        lookups++;
        // Every PRE-call lookup (odd) is unreadable; every post-call one succeeds.
        return lookups % 2 === 1
          ? ""
          : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (/lsof/i.test(cmd)) {
        lookups++;
        if (lookups % 2 === 1) throw noListener();
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    // The refusal names the MISSING CAPABILITY and a remedy, rather than leaving
    // the user to guess why a restart declined on their host.
    expect(result.message).toMatch(/could not be tied to PID/i);
    expect(result.message).toMatch(/no usable port-owner lookup|creation time/i);
    expect(result.message).toMatch(/restart ComfyUI from the launcher|install the missing tool/i);
    expect(killSpy).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("RETRIES a single flaky lookup rather than refusing outright", async () => {
    // Refusing on the first hiccup would be its own regression — one bad read is
    // retried, and a stable bracket on the retry proceeds normally.
    usePlainInstallForIdentity();
    let lookups = 0;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        lookups = 100; // past the kill the port is free
        return "";
      }
      if (/netstat/i.test(cmd)) {
        lookups++;
        if (lookups === 1) return ""; // one flaky pre-call read
        return lookups < 100
          ? "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321"
          : "";
      }
      if (/lsof/i.test(cmd)) {
        lookups++;
        if (lookups === 1 || lookups >= 100) throw noListener();
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.message).not.toMatch(/could not be tied to PID/i);
    expect(result.stopped).toBe(true);
    expect(result.started).toBe(true);

    killSpy.mockRestore();
  });

  it("REFUSES when the server that answered is NOT the one that ends up owning the port", async () => {
    // ComfyUI A answers /system_stats, exits, and ComfyUI B — a DIFFERENT install,
    // different argv — takes the port before the lookup. Binding A's answer to B's
    // pid would make us kill B on the strength of A's launch arguments. Re-asking
    // the server after the pid is in hand catches exactly that.
    usePlainInstallForIdentity();
    const OTHER_MAIN = join(resolve("OtherComfy"), "main.py");
    let answers = 0;
    mockGetSystemStats.mockImplementation(async () => {
      answers++;
      // First answer: install A. Second (after the pid was bound): install B.
      return {
        system: { argv: answers <= 1 ? PLAIN_ARGV : [OTHER_MAIN, "--port", "8188"] },
      };
    });
    mockLivePortThenFree();
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/changed while it was being identified/i);
    expect(killSpy).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(
      mockExecSync.mock.calls.some(([cmd]) => /taskkill/i.test(String(cmd))),
    ).toBe(false);

    killSpy.mockRestore();
  });

  it("does NOT refuse when the identity re-check merely fails to reach the server", async () => {
    // Absence of evidence is not evidence: a transport hiccup on the re-fetch must
    // not turn a perfectly good restart into a refusal.
    usePlainInstallForIdentity();
    let answers = 0;
    mockGetSystemStats.mockImplementation(async () => {
      answers++;
      if (answers > 1) throw new Error("ECONNRESET");
      return { system: { argv: PLAIN_ARGV } };
    });
    mockLivePortThenFree();
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(true);
    expect(result.started).toBe(true);

    killSpy.mockRestore();
  });

  it("does NOT report a successful stop when the killed process still holds the port", async () => {
    // A kill that RETURNS is not proof of death: on POSIX the forced `kill -9` runs
    // through a shell whose failure is swallowed, so an ignored signal looks exactly
    // like success. Teardown would then disarm supervision on a live server and
    // report stopped:true. The port release is the observable that decides.
    usePlainInstallForIdentity();
    mockExecSync.mockImplementation((cmd: string) => {
      // The kill "succeeds" (returns cleanly) but the process never dies, so the
      // port stays held by the very PID we targeted.
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) return "";
      if (/netstat/i.test(cmd)) {
        return "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (/lsof/i.test(cmd)) return "p4321\nn127.0.0.1:8188\n";
      return "";
    });
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/still holds port 8188/i);
    expect(result.message).toMatch(/nothing was torn down/i);
    // Critically: no relaunch was attempted against a server that is still running.
    expect(mockSpawn).not.toHaveBeenCalled();

    killSpy.mockRestore();
  }, 30_000);

  it("leaves crash supervision INTACT when the kill itself fails", async () => {
    // `taskkill`/`kill` fail for ordinary reasons — access denied above all — and
    // the server is then still running. Tearing supervision down before the kill
    // would disarm auto-restart for a server we did not manage to stop.
    usePlainInstallForIdentity();
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        throw new Error("ERROR: The process ... could not be terminated. Access is denied.");
      }
      if (/netstat/i.test(cmd)) {
        return "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (/lsof/i.test(cmd)) return "p4321\nn127.0.0.1:8188\n";
      return "";
    });
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("EPERM");
    });

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/could not stop comfyui/i);
    expect(result.message).toMatch(/crash supervision and launch record are untouched/i);
    // Nothing was relaunched — the old server is still the one running.
    expect(mockSpawn).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  function usePlainInstallForIdentity(): void {
    mockFindComfyuiPython.mockReturnValue(PLAIN_PY);
    mockLiveRootFromArgv.mockReturnValue(PLAIN_BASE);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: PLAIN_ARGV },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === PLAIN_MAIN || s === PLAIN_PY;
    });
  }
});

describe("restart_comfyui — plain installs are unchanged (#776)", () => {
  /**
   * After the restart, make `/system_stats` describe a DIFFERENT server than the
   * one we launched (or fail outright). The identification phase before the stop
   * consumes two calls — the bracketed fetch and the re-confirmation — so only the
   * third and later answers belong to whatever came back on the port.
   */
  function servingArgvAfterRestart(argv: string[] | "unreachable"): void {
    let calls = 0;
    mockGetSystemStats.mockImplementation(async () => {
      calls++;
      if (calls <= 2) return { system: { argv: [PLAIN_MAIN, "--port", "8188"] } };
      if (argv === "unreachable") throw new Error("ECONNRESET");
      return { system: { argv } };
    });
  }

  function usePlainInstall(): void {
    mockFindComfyuiPython.mockReturnValue(PLAIN_PY);
    mockLiveRootFromArgv.mockReturnValue(PLAIN_BASE);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: [PLAIN_MAIN, "--port", "8188"] },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === PLAIN_MAIN || s === PLAIN_PY;
    });
  }

  it("inherits this process's environment (no `env` override) and still restarts", async () => {
    usePlainInstall();
    mockLivePortThenFree();
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(true);
    expect(result.started).toBe(true);
    // No env override: `spawn` inherits process.env, exactly as before #776.
    expect(spawnOptions().env).toBeUndefined();
    expect(result.launch_env?.source).toBe("inherited");

    killSpy.mockRestore();
  });

  it("does NOT claim a successful restart when the healthy listener is somebody ELSE's process", async () => {
    // Readiness only proves that SOMETHING answers on the port. If an external
    // launcher/supervisor bound it while our child failed, the server is up but
    // OUR relaunch did not do it — saying "restarted successfully" would be false.
    usePlainInstall();
    // The port owner reported after the relaunch (4321) is not our child (999),
    // and it sits outside our process tree entirely (parented to init).
    spawnCapturingChildren(999);
    __processControlTestHooks.setParentPidResolver((pid) =>
      pid === 999 ? process.pid : 1,
    );
    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        // Free during the post-kill wait, then a DIFFERENT process owns it again.
        return killed && !restarted
          ? ""
          : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (/lsof/i.test(cmd)) {
        if (killed && !restarted) throw noListener();
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    let restarted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        restarted = true; // something answers on the port again
        return { ok: true } as Response;
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("not-ours");
    // The STRUCTURED result must not read as a successful restart either: this
    // call did not start the server. `ready` stays true — the server really is up.
    expect(result.started).toBe(false);
    expect(result.ready).toBe(true);
    // …and `startup` must not CONFIRM the very attribution just denied (codex gate
    // round 9). The API answered, but provably not as our relaunch: that is an
    // OBSERVED failure of this call's launch, not a confirmation of it.
    expect(result.startup).toBe("failed");
    expect(JSON.parse(JSON.stringify(result)).startup).toBe("failed");
    expect(result.message).not.toMatch(/restarted successfully/i);
    expect(result.message).toMatch(/NOT as a result of this restart/i);
    expect(result.message).toMatch(/another launcher or supervisor owns it/i);
    expect(result.message).not.toMatch(/could not be started/i);
    // ...and it must SURVIVE the tool's JSON serialization.
    expect(JSON.parse(JSON.stringify(result)).listener_ownership).toBe("not-ours");

    killSpy.mockRestore();
  });

  it("does NOT claim success when our child died and the replacement listener's PID cannot even be mapped", async () => {
    // The #449 shape: a healthy API but an unmappable port owner. A DEAD launched
    // child is decisive on its own — it cannot be the process now answering — so
    // "undecidable PID" must not launder a failed relaunch into a success.
    usePlainInstall();
    // The replacement is another launcher's ComfyUI, running a different install.
    servingArgvAfterRestart([join(resolve("OtherComfy"), "main.py"), "--port", "8188"]);
    const children = spawnCapturingChildren(999);
    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      // After the kill the port owner is never mappable again.
      if (/netstat/i.test(cmd)) {
        return killed ? "" : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (/lsof/i.test(cmd)) {
        if (killed) throw noListener();
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // Our child is gone, yet something healthy answers on the port.
        children[0]?.emit("exit", 1, null);
        return { ok: true } as Response;
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("not-ours");
    expect(result.started).toBe(false);
    expect(result.ready).toBe(true);
    expect(result.message).not.toMatch(/restarted successfully/i);
    expect(result.message).toMatch(/NOT as a result of this restart/i);
    expect(result.message).toMatch(/which exited: exit code 1/);

    killSpy.mockRestore();
  });

  it("claims a successful restart ONLY when the port owner is matched to the process we launched", async () => {
    // The one case where "restarted successfully" is a claim we can back: the
    // mapped port owner IS our child's pid.
    usePlainInstall();
    spawnCapturingChildren(4321);
    let killed = false;
    let relaunched = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        return killed && !relaunched
          ? ""
          : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (/lsof/i.test(cmd)) {
        if (killed && !relaunched) throw noListener();
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        relaunched = true;
        return { ok: true } as Response;
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.started).toBe(true);
    expect(result.listener_ownership).toBe("ours");
    expect(result.message).toMatch(/restarted successfully/i);
    expect(result.message).not.toMatch(/could not be confirmed/i);

    killSpy.mockRestore();
  });

  it("does NOT convict a departed child when the server's argv is UNREADABLE", async () => {
    // The third leg of a tri-state, which is how the polarity bug survived: the
    // existing tests covered `match` and `differ`, so testing `=== "match"` and
    // defaulting the rest to `not-ours` looked correct. `unknown` — the serving
    // argv could not be obtained — is an ABSENCE, and must degrade exactly as a
    // match does. Otherwise the wrapper-launched user this branch exists to protect
    // is told their own server is not theirs whenever the argv cannot be read.
    usePlainInstall();
    servingArgvAfterRestart("unreachable");
    const children = spawnCapturingChildren(4321);
    let killed = false;
    let relaunched = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        return killed && !relaunched
          ? ""
          : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (/lsof/i.test(cmd)) {
        if (killed && !relaunched) throw noListener();
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        relaunched = true;
        // The wrapper we spawned has exited; its grandchild serves the port.
        children[0]?.emit("exit", 0, null);
        return { ok: true } as Response;
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("unconfirmed");
    expect(result.message).not.toMatch(/NOT as a result of this restart/i);

    killSpy.mockRestore();
  });

  it("does NOT claim a matching PID as ours when the child is already gone but its `exit` event has not been delivered", async () => {
    // The lifecycle race: our child dies, the OS reuses its number for a program
    // that binds the port, and readiness sees that healthy replacement BEFORE Node
    // delivers the `exit` event. A bare `portOwnerPid === ourPid` would call it
    // "ours". A synchronous signal-0 probe says otherwise.
    usePlainInstall();
    // ...and the process that inherited the number runs a different install, so the
    // argv cross-check agrees rather than rescuing it.
    servingArgvAfterRestart([join(resolve("OtherComfy"), "main.py"), "--port", "8188"]);
    spawnCapturingChildren(4321);
    let killed = false;
    let relaunched = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        return killed && !relaunched
          ? ""
          : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (/lsof/i.test(cmd)) {
        if (killed && !relaunched) throw noListener();
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        relaunched = true;
        return { ok: true } as Response;
      }),
    );
    // Signal-0 liveness probes for our child report ESRCH; the process-group kill
    // during the stop still succeeds. NOTE the `exit` event is deliberately never
    // emitted — that is the whole point of the race.
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((pid: number, signal?: string | number) => {
        if (signal === 0) {
          const err = new Error("ESRCH") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        return true;
      });

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("not-ours");
    expect(result.started).toBe(false);
    expect(result.ready).toBe(true);
    expect(result.message).not.toMatch(/restarted successfully/i);
    expect(result.message).toMatch(/NOT as a result of this restart/i);

    killSpy.mockRestore();
  });


  /** The relaunch scenario shared by the lineage tests: same pid, alive, and the
   *  port owned again once the API answers. */
  function stableRelaunchOnPid4321(): void {
    usePlainInstall();
    spawnCapturingChildren(4321);
    let killed = false;
    let relaunched = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        return killed && !relaunched
          ? ""
          : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (/lsof/i.test(cmd)) {
        if (killed && !relaunched) throw noListener();
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    __processControlTestHooks.setProcessIdentityResolver(() => ({
      startedAt: "same-second",
      commandLine: `${PLAIN_PY} ${PLAIN_MAIN} --port 8188`,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        relaunched = true;
        return { ok: true } as Response;
      }),
    );
  }

  it("does NOT claim ownership when LINEAGE says the process on the port is not our child", async () => {
    // Everything else matches — pid, liveness, creation stamp, command line — as it
    // would for a number recycled by ANOTHER ComfyUI with identical argv (and on
    // macOS, within the same `lstart` second). Parentage is the one signal that
    // does not depend on when we looked.
    stableRelaunchOnPid4321();
    __processControlTestHooks.setParentPidResolver(() => process.pid + 1);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("not-ours");
    expect(result.started).toBe(false);
    expect(result.message).not.toMatch(/restarted successfully/i);

    killSpy.mockRestore();
  });

  it("withholds the claim when the parent cannot be read at all", async () => {
    stableRelaunchOnPid4321();
    __processControlTestHooks.setParentPidResolver(() => undefined);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    // Not knowing is never promoted to a claim — but it does not deny the restart
    // either, so the server stays reported as up.
    expect(result.listener_ownership).toBe("unconfirmed");
    expect(result.started).toBe(true);
    expect(result.message).not.toMatch(/restarted successfully/i);

    killSpy.mockRestore();
  });

  it("claims a GRANDCHILD listener as ours — a wrapper/double-fork launch is not a foreign server", async () => {
    // An indirect launcher (wrapper script, double fork, trampoline) means the
    // process holding the port is our grandchild, not our child. A direct-child
    // test would tell that user their own server "was not started by us".
    usePlainInstall();
    spawnCapturingChildren(4321);
    let killed = false;
    let relaunched = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        // After the relaunch a DIFFERENT pid (our grandchild) holds the port.
        return killed && !relaunched
          ? ""
          : `  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       ${relaunched ? 9999 : 4321}`;
      }
      if (/lsof/i.test(cmd)) {
        if (killed && !relaunched) throw noListener();
        return `p${relaunched ? 9999 : 4321}\nn127.0.0.1:8188\n`;
      }
      return "";
    });
    // 9999's parent is 4321 (the child we spawned), whose parent is us.
    __processControlTestHooks.setParentPidResolver((pid) =>
      pid === 9999 ? 4321 : pid === 4321 ? process.pid : 1,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        relaunched = true;
        return { ok: true } as Response;
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("ours");
    expect(result.started).toBe(true);
    expect(result.message).toMatch(/restarted successfully/i);

    killSpy.mockRestore();
  });

  it("does NOT claim a DESCENDANT listener that is running something other than what we launched", async () => {
    // Lineage says the port owner is in our tree, but the server reports different
    // launch arguments — our wrapper stayed alive and brought up a different (or
    // stale) ComfyUI. Being in our tree does not make it the process we launched,
    // so this must not read as a successful restart.
    usePlainInstall();
    servingArgvAfterRestart([join(resolve("OtherComfy"), "main.py"), "--port", "8188"]);
    spawnCapturingChildren(4321);
    let killed = false;
    let relaunched = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        return killed && !relaunched
          ? ""
          : `  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       ${relaunched ? 9999 : 4321}`;
      }
      if (/lsof/i.test(cmd)) {
        if (killed && !relaunched) throw noListener();
        return `p${relaunched ? 9999 : 4321}\nn127.0.0.1:8188\n`;
      }
      return "";
    });
    // 9999 IS our grandchild — lineage alone would say "ours".
    __processControlTestHooks.setParentPidResolver((pid) =>
      pid === 9999 ? 4321 : pid === 4321 ? process.pid : 1,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        relaunched = true;
        return { ok: true } as Response;
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("not-ours");
    expect(result.started).toBe(false);
    expect(result.message).not.toMatch(/restarted successfully/i);

    killSpy.mockRestore();
  });

  it("does NOT claim a SIBLING of this call's child — ancestry under the orchestrator is not ancestry under the launch", async () => {
    // The stale-instance case. A ComfyUI started by an EARLIER request is also a
    // descendant of this long-lived MCP process, has identical argv, and may still
    // hold the port. Tracing ancestry to the ORCHESTRATOR reports it as ours and
    // announces a restart that never happened — while the child we just spawned may
    // have died on a bind failure. Lineage has to be traced to THIS launch's child.
    usePlainInstall();
    spawnCapturingChildren(4321);
    let killed = false;
    let relaunched = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        return killed && !relaunched
          ? ""
          : `  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       ${relaunched ? 7777 : 4321}`;
      }
      if (/lsof/i.test(cmd)) {
        if (killed && !relaunched) throw noListener();
        return `p${relaunched ? 7777 : 4321}
n127.0.0.1:8188
`;
      }
      return "";
    });
    // 7777 is a SIBLING: its parent is the orchestrator, not our child 4321.
    __processControlTestHooks.setParentPidResolver((pid) =>
      pid === 7777 ? process.pid : pid === 4321 ? process.pid : 1,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        relaunched = true;
        return { ok: true } as Response;
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("not-ours");
    expect(result.started).toBe(false);
    expect(result.message).not.toMatch(/restarted successfully/i);

    killSpy.mockRestore();
  });

  it("reports a listener OUTSIDE our process tree as not-ours", async () => {
    usePlainInstall();
    spawnCapturingChildren(4321);
    let killed = false;
    let relaunched = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        return killed && !relaunched
          ? ""
          : `  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       ${relaunched ? 9999 : 4321}`;
      }
      if (/lsof/i.test(cmd)) {
        if (killed && !relaunched) throw noListener();
        return `p${relaunched ? 9999 : 4321}\nn127.0.0.1:8188\n`;
      }
      return "";
    });
    // 9999 belongs to some other launcher's tree, rooted at init.
    __processControlTestHooks.setParentPidResolver((pid) => (pid === 9999 ? 1 : process.pid));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        relaunched = true;
        return { ok: true } as Response;
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("not-ours");
    expect(result.started).toBe(false);

    killSpy.mockRestore();
  });

  it("DOES claim it when the process is provably our own child", async () => {
    stableRelaunchOnPid4321();
    __processControlTestHooks.setParentPidResolver(() => process.pid);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("ours");
    expect(result.message).toMatch(/restarted successfully/i);

    killSpy.mockRestore();
  });

  it("does NOT launder a FAILED spawn into an unconfirmed success when someone else answers first", async () => {
    // The spawn fails asynchronously and the child never gets a pid, but another
    // launcher's server answers readiness before the `error` event wins the race.
    // "We could not tell whose listener that is" would be a lie: we know our launch
    // never happened.
    usePlainInstall();
    const children = spawnCapturingChildren(null);
    let killed = false;
    let relaunched = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        return killed && !relaunched
          ? ""
          : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       7777";
      }
      if (/lsof/i.test(cmd)) {
        if (killed && !relaunched) throw noListener();
        return "p7777\nn127.0.0.1:8188\n";
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        relaunched = true;
        // Readiness WINS the race — the spawn error lands later, so ownership must
        // be decided from the missing pid alone.
        setTimeout(() => children[0]?.emit("error", new Error("spawn EACCES")), 50);
        return { ok: true } as Response;
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("not-ours");
    expect(result.started).toBe(false);
    expect(result.message).not.toMatch(/restarted successfully/i);
    expect(result.message).not.toMatch(/up and ready after the restart/i);

    killSpy.mockRestore();
  });

  it("does NOT launder a failed DESKTOP launch either — the never-launched checks precede the Desktop shortcut", async () => {
    // Desktop ownership is undecidable by design ONCE IT HAS STARTED (we spawn the
    // shell; its child binds the port). But a launch that never happened is
    // decisive on every path, so the Desktop shortcut must not sit in front of it.
    __processControlTestHooks.setLastProcessInfo({
      pid: 4321,
      port: 8188,
      argv: [],
      isDesktopApp: true,
      desktopExePath: join(resolve("Programs"), "Comfy Desktop", "Comfy Desktop.exe"),
    });
    const children = spawnCapturingChildren(null); // the spawn produced no process
    let probed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/netstat/i.test(cmd)) {
        // Nothing listening at the pre-launch check; another launcher answers after.
        return probed ? "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       7777" : "";
      }
      if (/lsof/i.test(cmd)) {
        if (!probed) throw noListener();
        return "p7777\nn127.0.0.1:8188\n";
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        probed = true;
        setTimeout(() => children[0]?.emit("error", new Error("spawn ENOENT")), 50);
        return { ok: true } as Response;
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await startComfyUI();

    expect(result.listener_ownership).toBe("not-ours");
    expect(result.started).toBe(false);
    expect(result.message).not.toMatch(/^ComfyUI started/);

    killSpy.mockRestore();
  });

  it("does NOT promote a matching server argv to ownership — another supervisor can run the same command", async () => {
    // The #449 host: no usable port-owner lookup, and the server reports exactly the
    // command line we launched. That is corroboration, NOT proof: another supervisor
    // could have started the same ComfyUI and won the bind race. So it stays
    // unconfirmed — never "restarted successfully" — while still not denying a
    // restart that almost certainly worked.
    usePlainInstall();
    servingArgvAfterRestart([PLAIN_MAIN, "--port", "8188"]);
    spawnCapturingChildren(4321);
    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        // Owned while identifying; never mappable again afterwards.
        return killed ? "" : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (/lsof/i.test(cmd)) {
        if (killed) throw noListener();
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("unconfirmed");
    expect(result.started).toBe(true);
    expect(result.message).not.toMatch(/restarted successfully/i);

    killSpy.mockRestore();
  });

  it("does NOT call a foreign listener ours when its argv is a strict SUBSET of what we launched", async () => {
    // `commandLineMatchesArgv(haystack, tokens)` is a containment test, so a single
    // call in one direction is a SUBSET check: a foreign server started with fewer
    // flags would "match" ours and be promoted. Comparing both ways closes that.
    usePlainInstall();
    // Ours carries an extra flag; theirs is otherwise identical.
    mockGetSystemStats.mockImplementation(async () => ({
      system: { argv: [PLAIN_MAIN, "--port", "8188"] },
    }));
    servingArgvAfterRestart([PLAIN_MAIN]); // a strict subset of our launch argv
    spawnCapturingChildren(4321);
    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        return killed ? "" : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (/lsof/i.test(cmd)) {
        if (killed) throw noListener();
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    // The port owner is unmappable, so NO listener was identified — and an absence
    // can never yield the positive verdict `not-ours`. What matters here is that a
    // subset argv does not read as a MATCH and so cannot promote to "ours": the
    // claim is withheld, and no success is reported.
    expect(result.listener_ownership).toBe("unconfirmed");
    expect(result.message).not.toMatch(/restarted successfully/i);

    killSpy.mockRestore();
  });

  it("treats an EXHAUSTED lineage walk as 'do not know', never as a foreign process", async () => {
    // A deep-but-legitimate wrapper chain runs out of hop budget. Running out of
    // budget is not a negative answer, and reporting one would tell that user their
    // own server is not theirs.
    usePlainInstall();
    servingArgvAfterRestart("unreachable"); // argv cannot rescue it either
    spawnCapturingChildren(4321);
    let killed = false;
    let relaunched = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        return killed && !relaunched
          ? ""
          : `  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       ${relaunched ? 9999 : 4321}`;
      }
      if (/lsof/i.test(cmd)) {
        if (killed && !relaunched) throw noListener();
        return `p${relaunched ? 9999 : 4321}\nn127.0.0.1:8188\n`;
      }
      return "";
    });
    // An unbroken chain that never reaches us and never reaches init.
    __processControlTestHooks.setParentPidResolver((pid) => pid + 1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        relaunched = true;
        return { ok: true } as Response;
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("unconfirmed");
    expect(result.started).toBe(true);
    expect(result.message).not.toMatch(/NOT as a result of this restart/i);

    killSpy.mockRestore();
  });

  it("does NOT report a wrapper-launched grandchild as NOT ours once the wrapper has exited", async () => {
    // A wrapper script launches ComfyUI and exits; the grandchild is reparented, so
    // lineage is a dead end by construction. The server's own command line cannot
    // prove the listener is ours (another supervisor could run the same command),
    // but it does stop us asserting the negative — otherwise a legitimately
    // indirect launcher is told its own server is not its own.
    usePlainInstall();
    servingArgvAfterRestart([PLAIN_MAIN, "--port", "8188"]);
    const children = spawnCapturingChildren(4321);
    let killed = false;
    let relaunched = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        return killed && !relaunched
          ? ""
          : `  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       ${relaunched ? 9999 : 4321}`;
      }
      if (/lsof/i.test(cmd)) {
        if (killed && !relaunched) throw noListener();
        return `p${relaunched ? 9999 : 4321}\nn127.0.0.1:8188\n`;
      }
      return "";
    });
    // The grandchild has been reparented to init — lineage is a dead end here.
    __processControlTestHooks.setParentPidResolver(() => 1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        relaunched = true;
        // The wrapper we spawned exits once its child is up.
        children[0]?.emit("exit", 0, null);
        return { ok: true } as Response;
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("unconfirmed");
    expect(result.started).toBe(true);
    expect(result.message).not.toMatch(/NOT as a result of this restart/i);

    killSpy.mockRestore();
  });

  it("says so plainly when listener ownership is UNDECIDABLE — without denying a restart that worked", async () => {
    // Unmappable port owner, a still-alive launched child, AND a server that will
    // not say what it is running — every identity signal exhausted. Reporting this
    // as a FAILED restart would mislabel every ordinary restart on hosts where the
    // port-owner lookup is unavailable, so the result stays started:true and the
    // uncertainty is stated instead of guessed either way.
    usePlainInstall();
    servingArgvAfterRestart("unreachable");
    spawnCapturingChildren(999);
    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        return killed ? "" : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (/lsof/i.test(cmd)) {
        if (killed) throw noListener();
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.started).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.listener_ownership).toBe("unconfirmed");
    expect(result.message).toMatch(/could not be confirmed as the process this call launched/i);
    // ...and the headline must not ATTRIBUTE the healthy listener to this restart.
    expect(result.message).not.toMatch(/restarted successfully/i);
    expect(result.message).toMatch(/could not be confirmed as the one serving the port/i);
    // THE POINT of a string state: `undefined` would be dropped by JSON.stringify,
    // leaving a payload indistinguishable from one that never carried the field —
    // i.e. from a plain success. The uncertainty has to reach the consumer.
    const serialized = JSON.parse(JSON.stringify(result));
    expect(Object.hasOwn(serialized, "listener_ownership")).toBe(true);
    expect(serialized.listener_ownership).toBe("unconfirmed");

    killSpy.mockRestore();
  });

  it("names the launched process's EXIT when it dies before the API comes up", async () => {
    usePlainInstall();
    mockLivePortThenFree();
    const children = spawnCapturingChildren();
    // The API never answers; meanwhile the process we launched dies (the #776
    // shape: ComfyUI aborting during import in a degraded environment).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        children[0]?.emit("exit", 1, null);
        throw new Error("ECONNREFUSED");
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(true);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/EXITED \(exit code 1\)/);
    expect(result.message).toMatch(/THIS RELAUNCH FAILED/);
    expect(result.message).toMatch(/not a slow start/i);
    // The claim is scoped to OUR relaunch. Our child dying does not establish that
    // nothing is serving the port now (codex gate).
    expect(result.message).not.toMatch(/ComfyUI is DOWN/);
    // …nor that the API never came up: a poll only establishes what the SCHEDULED
    // PROBES saw, and the server could have answered between two of them.
    expect(result.message).not.toMatch(/before the API came up/i);
    expect(result.message).toMatch(/the last one included/i);

    killSpy.mockRestore();
  });

  it("states listener ownership on EVERY return path, including 'another launcher took the port'", async () => {
    // After our stop, a different launcher binds the port during the settle delay,
    // so restart_comfyui (action:"start") exits via its "already running" branch. That branch used to
    // carry no ownership at all — and since JSON.stringify DROPS undefined, the
    // payload was indistinguishable from an old build that never had the field.
    usePlainInstall();
    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        // Freed by the kill, then taken again by somebody else before the relaunch.
        return killed && netstatCalls++ === 0
          ? ""
          : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       7777";
      }
      if (/lsof/i.test(cmd)) {
        if (killed && netstatCalls++ === 0) throw noListener();
        return "p7777\nn127.0.0.1:8188\n";
      }
      return "";
    });
    let netstatCalls = 0;
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    // `unconfirmed`, NOT `not-ours`: this branch never ran ownership
    // classification — it returned the moment it saw the port occupied. Only the
    // classifier may name a definite verdict, so a site that did not classify
    // cannot claim one (it is a compile error to try). What this test guards is
    // unchanged: the field is PRESENT on this path, it survives JSON, and no
    // success is claimed.
    expect(result.listener_ownership).toBe("unconfirmed");
    const serialized = JSON.parse(JSON.stringify(result));
    expect(Object.hasOwn(serialized, "listener_ownership")).toBe(true);
    expect(serialized.listener_ownership).toBe("unconfirmed");
    expect(result.message).not.toMatch(/restarted successfully/i);

    killSpy.mockRestore();
  });

  it("reports the TRUTH when the relaunch has not answered YET (#367: stopped, dispatched, unconfirmed)", async () => {
    usePlainInstall();
    mockLivePortThenFree();
    spawnCapturingChildren();
    // The process is spawned and STILL ALIVE, but the API has not answered inside
    // the budget. This test used to assert "stopped but could not be started",
    // which is the #367 defect itself: the relaunched process is right there, and
    // in the reported case it answered about two seconds after the deadline.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.startup).toBe("unconfirmed");
    // NEITHER definite verdict may be printed. Both of these have been the wording
    // at some point, and each is a lie in the opposite direction.
    expect(result.message).not.toMatch(/could not be started/i);
    expect(result.message).not.toMatch(/restarted successfully/i);
    expect(result.message).toMatch(/NOT CONFIRMED YET/);
    expect(result.message).toMatch(/not known to have failed/i);
    // The environment it was launched into is still named, so a slow start that
    // turns out to be a broken one is debuggable from this same report.
    expect(result.launch_env?.source).toBe("inherited");

    killSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // The ComfyUI target is MUTABLE (a panel hello can retarget it) and every step of
  // a restart is an await. Nothing here may end with a server stopped and a
  // relaunch aimed somewhere else.
  // -------------------------------------------------------------------------

  it("restart_comfyui (action:\"stop\") REFUSES when the target moved while it resolved the instance", async () => {
    // A DIRECT stop had no fence at all, and its saved launch record does not repair
    // the loss: restart_comfyui (action:"start") afterwards consults the NEW live target, so it can
    // refuse as remote or find that port occupied rather than relaunch what was
    // killed (codex gate round 12).
    usePlainInstall();
    mockLivePortThenFree();
    mockGetSystemStats.mockImplementation(async () => {
      mockConfig.targetGeneration += 1; // a hello retarget lands during the resolve
      return { system: { argv: [ABS_MAIN, "--port", "8188"] } };
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await stopComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.message).toMatch(/Refusing to stop/i);
    expect(result.message).toMatch(/target changed while the running instance was being identified/i);
    expect(result.message).toMatch(/Nothing was killed/i);
    const killIssued = mockExecSync.mock.calls.some(([c]: [string]) =>
      /taskkill|pkill|\bkill\b/i.test(String(c)),
    );
    expect(killIssued).toBe(false);
    // A refusal has to be actionable from where the caller is.
    expect(result.message).toMatch(/Let the target settle, then retry/i);
    // …and it must not claim a relaunch is on file for an instance it declined to
    // touch (#767: has_restart_info means a command was BUILT AND VALIDATED).
    expect(result.has_restart_info).toBe(false);

    killSpy.mockRestore();
  });

  it("the relaunch is ANCHORED to the instance that was stopped, not the live target", async () => {
    // After the kill, restartComfyUI awaits the port release and a settle delay. A
    // retarget in that window used to leave the relaunch probing the NEW target's
    // port: if that port was occupied it returned "already running" WITHOUT
    // spawning, and the instance just killed stayed dead (codex gate round 12).
    //
    // Modelled by pointing the live config at a DIFFERENT, occupied port after the
    // stop. Anchored, the restart still relaunches and grades the original.
    usePlainInstall();
    mockLivePortThenFree();
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    // The retarget lands at the KILL — after the resolve, so the pre-stop fence
    // (which spans only the resolve) passes and the post-stop window is what is
    // exercised. Port 9999 is OCCUPIED, which is what makes the un-anchored version
    // bail out with "already running" instead of relaunching.
    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        mockConfig.resolvedPort = 9999; // config now points at a DIFFERENT instance
        return "";
      }
      if (/netstat/i.test(cmd)) {
        // `netstat -ano` carries no port argument — the caller filters the TABLE by
        // the port it is asking about. So emit the whole table and let it choose:
        // after the kill 8188 is free and an UNRELATED server holds 9999.
        if (!killed) return "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
        return "  TCP    0.0.0.0:9999   0.0.0.0:0   LISTENING       777";
      }
      if (/lsof/i.test(cmd)) {
        // lsof IS asked per-port (`-iTCP:<port>`), so answer per-port.
        if (!killed) return "p4321\nn127.0.0.1:8188\n";
        if (/9999/.test(cmd)) return "p777\nn127.0.0.1:9999\n";
        throw noListener();
      }
      return "";
    });

    const result = await restartComfyUI();

    expect(killed).toBe(true);
    expect(mockConfig.resolvedPort).toBe(9999); // the retarget really happened
    // It RELAUNCHED rather than bailing out on the other target's occupied port…
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(result.message).not.toMatch(/already running/i);
    // …and the readiness verdict is about the anchored instance's URL, not the
    // config's current one.
    expect(result.readiness?.probe_url).toBe("http://127.0.0.1:8188/system_stats");
    expect(result.ready).toBe(true);

    killSpy.mockRestore();
  });

  it("reports the TRUTH when the relaunched process DIED (stopped, not started)", async () => {
    // The definite negative, and the evidence that licenses it: we watched the
    // process we launched exit. #776's truthful DOWN report is unchanged here.
    usePlainInstall();
    mockLivePortThenFree();
    // The relaunched child aborts during import the instant it is spawned — the
    // #776 shape. Wired at the spawn site rather than raced from the test, so the
    // exit is guaranteed to land before the readiness poll concludes: a mutant that
    // survives only because a timer won a race is not a caught mutant.
    mockSpawn.mockImplementation(() => {
      const child = new FakeChild();
      child.pid = 4321;
      queueMicrotask(() => child.emit("exit", 1, null));
      return child;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(true);
    expect(result.started).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.startup).toBe("failed");
    expect(result.message).toMatch(/stopped but could not be started/i);
    expect(result.message).toMatch(/THIS RELAUNCH FAILED/);
    // A real failure must NOT be softened into "it may still be coming up".
    expect(result.message).not.toMatch(/NOT CONFIRMED YET/);
    // …nor overstated into a claim about the machine we did not observe.
    expect(result.message).not.toMatch(/ComfyUI is DOWN/);
    expect(result.launch_env?.source).toBe("inherited");

    killSpy.mockRestore();
  });
});
