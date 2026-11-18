// The restart flow on POSIX, where the port is probed with `lsof` (#776).
//
// This file exists because of a failure that NO amount of local testing on Windows
// could have caught. `probePortOwner` distinguishes "the port is free" from "I
// could not look", and on POSIX it draws that distinction from how `lsof` FAILED:
// exit 1 means "ran fine, matched nothing"; anything else means the probe itself
// did not work. The rest of the suite modelled "nothing is listening" as a bare
// `throw new Error(...)`, which carries neither an exit status nor an errno — so on
// POSIX every post-kill wait read it as "could not look", polled for its full
// budget, and the tests timed out. On Windows the netstat branch answers first and
// never reaches lsof, so the same suite was green.
//
// The platform is therefore MOCKED here rather than inherited, so this path is
// exercised on every developer machine and not only on a Linux runner.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeChild extends EventEmitter {
  unref = vi.fn();
  pid: number | undefined = 4321;
}

const mockConfig = vi.hoisted(() => ({
  resolvedPort: 8188,
  comfyuiPath: undefined as string | undefined,
  /** Mutable so a test can retarget mid-restart, as a second agent would. */
  baseUrl: "http://127.0.0.1:8188",
  remoteMode: false,
  /** Mutable so an A→B→A retarget (same base, new generation) can be modelled. */
  generation: 0,
}));
const mockExecSync = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());
const mockGetSystemStats = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn((_p: string) => true));
const mockFindComfyuiPython = vi.hoisted(() => vi.fn());

// FORCE THE POSIX BRANCH. port-owner captures `IS_WIN` at module load, so the
// platform has to be mocked before it is imported.
vi.mock("node:os", () => ({ platform: () => "linux" }));

vi.mock("../../config.js", () => ({
  config: mockConfig,
  getComfyUIBaseUrl: () => mockConfig.baseUrl,
  getComfyUIAuthHeaders: () => ({}),
  // #848 instance fence — a stable target here; the retarget cases live in
  // desktop-restart.test.ts and panel-restart-health-readiness.test.ts.
  getComfyuiTargetGeneration: () => mockConfig.generation,
  isRemoteMode: () => mockConfig.remoteMode,
}));

vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
  spawn: mockSpawn,
  execFile: vi.fn(),
  execFileSync: vi.fn(() => {
    throw new Error("no process reader in test");
  }),
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readlinkSync: vi.fn(() => {
    throw new Error("no /proc in test");
  }),
  // ENOENT, not a bare Error: the port probe classifies a failed kernel-table read
  // from its ERRNO. "The table does not exist" (this host has no /proc) hides
  // nothing and leaves lsof as the only source, which is the host these tests
  // model; an errno-less failure reads as "I could not look" — a blind spot that
  // would make every lsof answer here `unknown`.
  readFileSync: vi.fn(() => {
    throw Object.assign(new Error("no /proc in test"), { code: "ENOENT" });
  }),
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
  resolveEffectiveComfyUIBase: () => BASE,
  liveRootFromArgv: () => BASE,
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
  describeLifecycleStatus,
  restartComfyUI,
  startComfyUI,
} from "../../services/process-control.js";

// POSIX-DIALECT LITERALS, deliberately not `path.join`/`resolve`. The platform is
// mocked to linux, so every separator-sensitive comparison downstream (notably
// commandLineMatchesArgv, which normalises differently per platform) evaluates as
// POSIX. Building these with the host's `path` would produce Windows separators
// under a POSIX-thinking comparison — a test written in one dialect and evaluated
// in the other, which is its own class of false result.
const BASE = "/opt/PosixComfy/ComfyUI";
const MAIN = `${BASE}/main.py`;
const PYTHON = `${BASE}/venv/bin/python`;
const ARGV = [MAIN, "--port", "8188"];

/**
 * `lsof -V` positively STATING that nothing is listening — verbatim the shape a
 * real lsof produces (status 1, the "not located" line on stdout). This marker,
 * not the exit status, is what makes "the port is free" an actual finding: a
 * permission-restricted run also exits 1, and does so with empty stdout AND empty
 * stderr, so silence proves nothing.
 */
function lsofNoMatches(): Error {
  const err = new Error("no listener") as Error & {
    status?: number;
    stdout?: string;
    stderr?: string;
  };
  err.status = 1;
  err.stdout = "lsof: Internet address not located: TCP:8188\n";
  err.stderr = "";
  return err;
}

/** `lsof` exiting 1 SILENTLY — the shape a restricted enumeration produces. Not
 *  a statement about the port, and must never be read as one. */
function lsofQuietFailure(): Error {
  const err = new Error("") as Error & { status?: number; stdout?: string; stderr?: string };
  err.status = 1;
  err.stdout = "";
  err.stderr = "";
  return err;
}

/** `lsof` not installed — the shell reports 127. The probe did NOT run. */
function lsofMissing(): Error {
  const err = new Error("sh: lsof: not found") as Error & { status?: number };
  err.status = 127;
  return err;
}

const ORIGINAL_ENV = { ...process.env };

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
  mockConfig.resolvedPort = 8188;
  mockConfig.comfyuiPath = BASE;
  mockConfig.baseUrl = "http://127.0.0.1:8188";
  mockConfig.remoteMode = false;
  mockConfig.generation = 0;
  mockFindComfyuiPython.mockReturnValue(PYTHON);
  mockExistsSync.mockImplementation((p: string) => {
    const s = String(p);
    return s === MAIN || s === PYTHON || s === BASE;
  });
  mockGetSystemStats.mockResolvedValue({ system: { argv: ARGV } });
  mockSpawn.mockImplementation(() => new FakeChild());
  __processControlTestHooks.reset();
  __processControlTestHooks.setProcessIdentityResolver(() => ({
    startedAt: "stable-stamp",
  }));
  __processControlTestHooks.setParentPidResolver(() => process.pid);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  __processControlTestHooks.reset();
});

describe("restart_comfyui on POSIX — port release via lsof (#776)", () => {
  it("completes PROMPTLY when lsof reports the port free after the kill", async () => {
    // The regression: reading lsof's exit-1 as "could not look" made the port-free
    // wait burn its entire budget on every successful restart. The budget is raised
    // back to 10s for THIS test so the ceiling below actually proves the wait
    // resolved early, rather than passing because the budget itself was short.
    process.env.COMFYUI_PORT_FREE_TIMEOUT_S = "10";
    let killed = false;
    let relaunched = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/kill/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/lsof/i.test(cmd)) {
        // Free once the kill lands, then owned again by the relaunched child. That
        // is the ordinary successful shape — and the only one that can PROVE a
        // start, now that a claim requires identifying our own listener.
        if (killed && !relaunched) throw lsofNoMatches();
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
    __processControlTestHooks.setParentPidResolver(() => process.pid);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const startedAt = Date.now();
    const result = await restartComfyUI();
    const elapsed = Date.now() - startedAt;

    expect(result.stopped).toBe(true);
    expect(result.listener_ownership).toBe("ours");
    expect(result.started).toBe(true);
    expect(elapsed).toBeLessThan(8000);

    killSpy.mockRestore();
  }, 20_000);

  /** Port owned while identifying, then unmappable for good once the kill lands. */
  function killThenUnmappablePort(): void {
    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/kill/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/lsof/i.test(cmd)) {
        if (killed) throw lsofNoMatches();
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
  }

  it("does NOT fabricate 'not-ours' when the port owner is UNMAPPABLE", async () => {
    // No listener can be identified at all after the kill. "I could not determine
    // who owns this listener" must not be reported as "I determined this listener is
    // not ours" — `not-ours` is a POSITIVE finding about an identified process,
    // never the shape of an absence.
    killThenUnmappablePort();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("unconfirmed");
    // `started` stays TRUE for `unconfirmed` by standing ruling: denying it would
    // report every ordinary restart as failed on a host whose port-owner lookup is
    // unavailable. What must NOT happen is a definite verdict — and the message
    // qualifies the claim rather than asserting proof.
    expect(result.ready).toBe(true);
    expect(result.started).toBe(true);
    expect(result.message).not.toMatch(/restarted successfully/i);

    killSpy.mockRestore();
  }, 20_000);

  it("does NOT read a WINDOWS-flavoured sys.argv as a different program", async () => {
    // `sys.argv` follows the SERVER, not us: a Windows-launched ComfyUI answers
    // `ComfyUI\main.py` however this orchestrator is running. Compared with
    // host-dialect normalisation that never matches our POSIX-resolved absolute
    // path, and the "difference" reported is really "I could not compare these".
    //
    // Driven through the child-exited branch, where the argv comparison is what
    // decides: our direct child is gone (positive evidence), so a genuine mismatch
    // would say `not-ours` — only a correct match keeps it at `unconfirmed`.
    let answers = 0;
    mockGetSystemStats.mockImplementation(async () => {
      answers++;
      // Identification uses the absolute argv; the server that answers AFTER the
      // relaunch reports the Windows-flavoured relative form of the same script.
      return {
        system: {
          argv: answers <= 2 ? ARGV : ["ComfyUI\\main.py", "--port", "8188"],
        },
      };
    });
    let killed = false;
    const children: FakeChild[] = [];
    mockSpawn.mockImplementation(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    mockExecSync.mockImplementation((cmd: string) => {
      if (/kill/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/lsof/i.test(cmd)) {
        if (killed) throw lsofNoMatches();
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // The process we launched is gone — the branch where argv decides.
        children[0]?.emit("exit", 0, null);
        return { ok: true } as Response;
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("unconfirmed");

    killSpy.mockRestore();
  }, 20_000);

  it("does NOT claim a start when the port was never OBSERVED free before launching", async () => {
    // The stop committed unverified, and the port lookup is unavailable from then
    // on. We still launch (refusing after a kill could leave the server down), but
    // readiness may be reaching the server that was ALREADY there — so a healthy
    // API is not evidence that THIS call started anything.
    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/kill/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/lsof/i.test(cmd)) {
        if (killed) throw lsofMissing(); // probe unusable from here on
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

    expect(result.ready).toBe(true);
    // The stale pre-launch observation carries no CLAIM either way — it is a fact
    // about a moment that has passed. What it still earns is disclosure: the
    // message states that the port was never seen free, so a reader knows the
    // healthy API may be the server that was already there.
    expect(result.listener_ownership).toBe("unconfirmed");
    expect(result.message).toMatch(/never observed free before launching/i);
    expect(result.message).not.toMatch(/restarted successfully/i);

    killSpy.mockRestore();
  }, 30_000);

  it("does NOT treat CASE-DISTINCT POSIX paths as the same install", async () => {
    // The dangerous direction. Folding case unconditionally made
    // `/opt/PosixComfy/ComfyUI/main.py` and `/opt/posixcomfy/comfyui/main.py` —
    // different directories on a case-sensitive filesystem — compare EQUAL, which
    // fabricates a MATCH. A match can promote a descendant listener to "ours" and
    // so license stopping a process that is not ours.
    //
    // Driven through the child-exited branch, where the argv comparison decides:
    // a fabricated match would read "unconfirmed", the real answer is "not-ours".
    let answers = 0;
    mockGetSystemStats.mockImplementation(async () => {
      answers++;
      return {
        system: {
          argv:
            answers <= 2
              ? ARGV
              : ["/opt/posixcomfy/comfyui/main.py", "--port", "8188"],
        },
      };
    });
    let killed = false;
    const children: FakeChild[] = [];
    mockSpawn.mockImplementation(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    mockExecSync.mockImplementation((cmd: string) => {
      if (/kill/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/lsof/i.test(cmd)) {
        if (killed) throw lsofNoMatches();
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        children[0]?.emit("exit", 0, null);
        return { ok: true } as Response;
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("not-ours");

    killSpy.mockRestore();
  }, 20_000);

  it("DOES treat case-distinct WINDOWS paths as the same install", async () => {
    // The other half of the same rule: Windows filesystems ARE case-insensitive, so
    // folding is correct there — and withholding it would manufacture a spurious
    // "different program" for a perfectly ordinary Windows install.
    //
    // The launch path must be DRIVE-ROOTED, which is what identifies the dialect.
    // A bare `COMFYUI\MAIN.PY` alone cannot: backslashes with no drive are equally
    // a legal POSIX filename, and folding on that evidence is the false-match bug
    // the sibling test guards. On a real Windows host our side is always rooted,
    // so the pair folds; pairing a POSIX launch path with a Windows-cased serving
    // argv is a combination that cannot occur.
    const WIN_MAIN = "C:\\Comfy\\ComfyUI\\main.py";
    const WIN_PY = "C:\\Comfy\\ComfyUI\\venv\\Scripts\\python.exe";
    mockFindComfyuiPython.mockReturnValue(WIN_PY);
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === WIN_MAIN || s === WIN_PY;
    });
    let answers = 0;
    mockGetSystemStats.mockImplementation(async () => {
      answers++;
      return {
        system: {
          argv:
            answers <= 2
              ? [WIN_MAIN, "--port", "8188"]
              : ["COMFYUI\\MAIN.PY", "--port", "8188"],
        },
      };
    });
    let killed = false;
    const children: FakeChild[] = [];
    mockSpawn.mockImplementation(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    mockExecSync.mockImplementation((cmd: string) => {
      if (/kill/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/lsof/i.test(cmd)) {
        if (killed) throw lsofNoMatches();
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        children[0]?.emit("exit", 0, null);
        return { ok: true } as Response;
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("unconfirmed");

    killSpy.mockRestore();
  }, 20_000);

  it("treats `.`/`..` spellings of the SAME path as equal, not as a difference", async () => {
    let answers = 0;
    mockGetSystemStats.mockImplementation(async () => {
      answers++;
      return {
        system: {
          argv:
            answers <= 2
              ? ARGV
              : ["/opt/PosixComfy/x/../ComfyUI/./main.py", "--port", "8188"],
        },
      };
    });
    let killed = false;
    const children: FakeChild[] = [];
    mockSpawn.mockImplementation(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    mockExecSync.mockImplementation((cmd: string) => {
      if (/kill/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/lsof/i.test(cmd)) {
        if (killed) throw lsofNoMatches();
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        children[0]?.emit("exit", 0, null);
        return { ok: true } as Response;
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("unconfirmed");

    killSpy.mockRestore();
  }, 20_000);

  it("does NOT fold case for a POSIX path that merely CONTAINS a backslash", async () => {
    // Backslash is a legal filename character on POSIX. Treating it as a Windows
    // marker enabled case folding, so `/srv/Comfy\A` and `/srv/comfy\a` — two
    // different installs — compared equal. That is the false-MATCH direction, and
    // with a descendant listener a false match promotes to `ours`, which licenses
    // stopping a process that is not ours.
    let answers = 0;
    mockGetSystemStats.mockImplementation(async () => {
      answers++;
      return {
        system: {
          argv:
            answers <= 2
              ? ["/opt/Comfy\\A/main.py", "--port", "8188"]
              : ["/opt/comfy\\a/main.py", "--port", "8188"],
        },
      };
    });
    mockFindComfyuiPython.mockReturnValue("/opt/Comfy\\A/venv/bin/python");
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === "/opt/Comfy\\A/main.py" || s === "/opt/Comfy\\A/venv/bin/python";
    });
    let killed = false;
    const children: FakeChild[] = [];
    mockSpawn.mockImplementation(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    mockExecSync.mockImplementation((cmd: string) => {
      if (/kill/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/lsof/i.test(cmd)) {
        if (killed) throw lsofNoMatches();
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        children[0]?.emit("exit", 0, null);
        return { ok: true } as Response;
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("not-ours");

    killSpy.mockRestore();
  }, 20_000);

  it("cannot compare DRIVE-RELATIVE paths, and says so rather than matching them", async () => {
    // `C:ComfyUI\main.py` resolves against that drive's own working directory, so
    // identical text can denote different installs in two processes. Comparing it
    // as if it were a location is a fabricated match.
    let answers = 0;
    mockGetSystemStats.mockImplementation(async () => {
      answers++;
      return {
        system: {
          argv: answers <= 2 ? ARGV : ["C:ComfyUI\\main.py", "--port", "8188"],
        },
      };
    });
    let killed = false;
    const children: FakeChild[] = [];
    mockSpawn.mockImplementation(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    mockExecSync.mockImplementation((cmd: string) => {
      if (/kill/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/lsof/i.test(cmd)) {
        if (killed) throw lsofNoMatches();
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        children[0]?.emit("exit", 0, null);
        return { ok: true } as Response;
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    // Not comparable => "unknown" => the departed-child branch degrades rather
    // than convicting, and certainly does not promote.
    expect(result.listener_ownership).toBe("unconfirmed");

    killSpy.mockRestore();
  }, 20_000);

  it("does NOT read a SILENT lsof failure as proof the port is free", async () => {
    // The inverse of the fix: a restricted enumeration exits 1 having listed
    // nothing and says nothing on either stream. Reading "quiet" as "free" would
    // certify a release that never happened — and no `-w`/warning heuristic can
    // rescue it, since the silence is indistinguishable. Only lsof's explicit
    // "Internet address not located" is a finding.
    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/kill/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/lsof/i.test(cmd)) {
        if (killed) throw lsofQuietFailure();
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

    // The stop still COMMITS (a refusal after the kill could not restore anything)
    // but it is reported as unverified rather than as a confirmed release.
    expect(result.stopped).toBe(true);
    expect(result.message).toMatch(/could not be checked after the kill/i);

    killSpy.mockRestore();
  }, 30_000);

  it("does NOT read a MISSING lsof as proof the port is free", async () => {
    // A container without lsof. The probe did not run, so the stop cannot claim the
    // process died — but it still commits and relaunches, because a refusal after
    // the kill could not restore anything.
    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/kill/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/lsof/i.test(cmd)) {
        if (killed) throw lsofMissing();
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

    expect(result.stopped).toBe(true);
    expect(result.message).toMatch(/could not be checked after the kill/i);
    // ...and the server was brought back rather than abandoned.
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    killSpy.mockRestore();
  }, 30_000);
});

// Moved from restart-target-anchor.test.ts (#2947). That file is pinned to win32,
// where a local kill+relaunch now refuses before the stop; the post-stop window
// these cover exists only off Windows, so they run here on the POSIX branch.
describe("a local restart never abandons the instance it stopped", () => {
  /** A live local server on 8188 that goes quiet once killed. */
  const liveThenFree = (pid = 4321): { killed: () => boolean } => {
    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/kill/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/lsof/i.test(cmd)) {
        if (killed) throw lsofNoMatches();
        return `p${pid}\nn127.0.0.1:8188\n`;
      }
      return "";
    });
    return { killed: () => killed };
  };

  it("reports the stop honestly instead of throwing when another agent retargets to REMOTE mid-stop", async () => {
    // The P0 in full: the stop commits, then the relaunch used to hit the
    // remote-mode refusal and throw — unwinding past every report and leaving
    // the caller with an exception where the fact "your server is down" should
    // have been. This drives `restartComfyUI`, not the unit below it, so it
    // fails if the refusal is reinstated OR if the post-stop catch is removed
    // and something else throws past the same point.
    const port = liveThenFree();
    // The retarget lands during the post-stop window, exactly as a second agent
    // on this rig would do it.
    mockSpawn.mockImplementation(() => {
      mockConfig.remoteMode = true;
      mockConfig.baseUrl = "http://beta.example:8188";
      throw new Error("relaunch could not be spawned");
    });
    // Nothing is listening after the failed relaunch — the ordinary case.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    // The whole assertion is that this RESOLVES. A rejection here is the bug.
    const res = await restartComfyUI();

    expect(port.killed()).toBe(true); // the stop really did happen
    expect(res.stopped).toBe(true); // ...and the report says so
    expect(res.started).toBe(false);
    // The relaunch WAS attempted and threw partway, so what we cannot say is
    // whether it took effect. "not-attempted" would be a different claim, and a
    // false one.
    expect(res.startup).toBe("unconfirmed");
    expect(res.message).toMatch(/relaunch failed partway/i);
    // NOT a bare "ComfyUI is NOT running": nothing answered when asked, which is
    // one observation, and this branch exists to stop exactly that becoming a
    // verdict. The wording must keep the two apart.
    expect(res.message).toMatch(/most likely down/i);
    expect(res.message).toMatch(/not a settled fact/i);
    // The one thing it must never say is the remote-mode refusal, which would be
    // a bucket narrated as the cause of a dead local server.
    expect(res.message).not.toMatch(/targeting a remote/i);

    killSpy.mockRestore();
  }, 20_000);

  it("does NOT say nothing answered when the endpoint returns 503 — not healthy is not not-there", async () => {
    // `waitForApiReady` counts a 502/503/504 as not-ready, which is right for
    // readiness and wrong as evidence of absence. Reading `ready:false` as
    // "nothing is listening" is the same fold one level down: a proxy answering
    // 503 in front of a starting server would be reported as a dead machine.
    liveThenFree();
    mockSpawn.mockImplementation(() => {
      throw new Error("relaunch could not be spawned");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("service unavailable", { status: 503 })),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const res = await restartComfyUI();

    expect(res.startup).toBe("unconfirmed");
    expect(res.message).not.toMatch(/nothing answered/i);
    // It may still say "most likely down" — that is a hedge, not a claim — but it
    // must carry the caveat that something could be listening.
    expect(res.message).toMatch(/not "?not there"?|may well be listening/i);

    killSpy.mockRestore();
  }, 20_000);

  it("does NOT report down when something IS answering after a failed relaunch", async () => {
    // The other half of the same finding: a supervisor may have brought the
    // instance back while we were unwinding, or the throw may have landed after
    // a spawn. Reporting "down" over a live server is the unverified negative in
    // its most misleading form — the user goes looking for a dead process.
    liveThenFree();
    mockSpawn.mockImplementation(() => {
      throw new Error("relaunch could not be spawned");
    });
    // The post-failure probe finds a live server.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ system: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const res = await restartComfyUI();

    expect(res.startup).toBe("unconfirmed");
    expect(res.message).toMatch(/IS answering/i);
    expect(res.message).not.toMatch(/most likely down/i);
    // And it must not claim that server either — this call did not start it.
    expect(res.started).toBe(false);
    expect(res.message).toMatch(/cannot claim that server as its own/i);

    killSpy.mockRestore();
  }, 20_000);
});

// #2948 off Windows: action:"status" reports the POSIX routes, and is just as
// read-only — no spawn, no kill, no Manager reboot, the saved record untouched.
describe('restart_comfyui (action:"status") on POSIX (#2948)', () => {
  function expectNoEffects(fetchSpy?: ReturnType<typeof vi.fn>): void {
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(
      mockExecSync.mock.calls.some(([c]) => /\bkill\b|pkill|taskkill/i.test(String(c))),
    ).toBe(false);
    for (const [input, init] of (fetchSpy?.mock.calls ?? []) as [unknown, RequestInit?][]) {
      expect(new URL(String(input)).pathname).toBe("/system_stats");
      expect((init?.method ?? "GET").toUpperCase()).toBe("GET");
    }
  }

  it("a validated local install: restart is kill+relaunch, and a stop is recoverable with start", async () => {
    mockExecSync.mockImplementation((cmd: string) =>
      /lsof/i.test(cmd) ? "p4321\nn127.0.0.1:8188\n" : "",
    );
    const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchSpy);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const status = await describeLifecycleStatus();

    expect(status.windows_direct_launch_blocked).toBe(false);
    expect(status.instance).toMatchObject({ identified: "yes", pid: 4321 });
    expect(status.start.launches).toBe("no"); // already running: start is a no-op
    expect(status.stop).toMatchObject({ allowed: "yes", recoverable_by_start: "yes" });
    expect(status.restart).toMatchObject({
      route: "kill-relaunch",
      will_attempt: "yes",
      evidence: "validated-command",
    });
    expectNoEffects(fetchSpy);
    // Signal 0 is an existence probe; nothing may be SENT a real signal.
    expect(killSpy.mock.calls.every(([, sig]) => sig === 0)).toBe(true);
    expect(__processControlTestHooks.getLastProcessInfo()).toBeNull();
    killSpy.mockRestore();
  });

  it("a remote target: Manager reboot with UNVERIFIED recovery, local actions unavailable, nothing contacted", async () => {
    mockConfig.remoteMode = true;
    mockConfig.baseUrl = "http://remote.example:8188";
    const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const status = await describeLifecycleStatus();

    expect(status.target.remote).toBe(true);
    expect(status.restart).toMatchObject({
      route: "comfyui-manager-remote",
      will_attempt: "yes",
      evidence: "unverified-remote",
    });
    expect(status.start.launches).toBe("no");
    expect(status.stop).toMatchObject({ allowed: "no", recoverable_by_start: "not-applicable" });
    expect(status.instance.identified).toBe("unknown");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockGetSystemStats).not.toHaveBeenCalled();
    expectNoEffects();
  });

  it("nothing running but a saved launch record that validates: start would launch it, and the record is unchanged", async () => {
    mockGetSystemStats.mockRejectedValue(new Error("fetch failed"));
    mockExecSync.mockImplementation((cmd: string) => {
      if (/lsof/i.test(cmd)) throw lsofNoMatches();
      if (/pgrep/i.test(cmd)) throw Object.assign(new Error("no match"), { status: 1 });
      return "";
    });
    __processControlTestHooks.setLastProcessInfo({
      pid: 4321,
      port: 8188,
      argv: ARGV,
      isDesktopApp: false,
    });
    const saved = __processControlTestHooks.getLastProcessInfo();
    const snapshot = JSON.stringify(saved);

    const status = await describeLifecycleStatus();

    expect(status.instance.identified).toBe("no");
    expect(status.start.launches).toBe("yes");
    expect(status.restart.will_attempt).toBe("no");
    expectNoEffects();
    expect(__processControlTestHooks.getLastProcessInfo()).toBe(saved);
    expect(JSON.stringify(__processControlTestHooks.getLastProcessInfo())).toBe(snapshot);
  });
});

// Review P2 on 06b6528e: status must reach the SAME start decision startComfyUI
// reaches — fence first, then the port owner — and must never mix two targets.
// Each case pairs the status answer with the actual (mocked) start decision.
describe('action:"status" start prediction agrees with startComfyUI (#2948 review)', () => {
  const validRecord = {
    pid: 4321,
    port: 8188,
    argv: ARGV,
    isDesktopApp: false,
  };

  /** Nothing answers /system_stats; lsof reports what `port` says. */
  function serverUnreachable(port: "free" | "owned" | "unknown"): void {
    mockGetSystemStats.mockRejectedValue(new Error("fetch failed"));
    mockExecSync.mockImplementation((cmd: string) => {
      if (/lsof/i.test(cmd)) {
        if (port === "owned") return "p4321\nn127.0.0.1:8188\n";
        if (port === "unknown") throw lsofMissing();
        throw lsofNoMatches();
      }
      if (/pgrep/i.test(cmd)) throw Object.assign(new Error("no match"), { status: 1 });
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
  }

  it("a saved record with NO target fence: status says start refuses, start refuses, record untouched by status", async () => {
    serverUnreachable("free");
    const record = { ...validRecord };
    __processControlTestHooks.setRawLastProcessInfo(record);

    const status = await describeLifecycleStatus();

    expect(status.start.launches).toBe("no");
    expect(status.start.reason).toMatch(/no target identity/);
    expect(__processControlTestHooks.getLastProcessInfo()).toBe(record);
    expect(mockSpawn).not.toHaveBeenCalled();

    const started = await startComfyUI();
    expect(started.started).toBe(false);
    expect(started.message).toMatch(/no target identity/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("a saved record for an OLDER target: status says start refuses, start refuses", async () => {
    serverUnreachable("free");
    const record = {
      ...validRecord,
      targetFence: { baseUrl: "http://old.example:8188", generation: 0, comfyuiPath: BASE },
    };
    __processControlTestHooks.setRawLastProcessInfo(record);

    const status = await describeLifecycleStatus();

    expect(status.start.launches).toBe("no");
    expect(status.start.reason).toMatch(/older ComfyUI target/);
    expect(__processControlTestHooks.getLastProcessInfo()).toBe(record);

    const started = await startComfyUI();
    expect(started.started).toBe(false);
    expect(started.message).toMatch(/older ComfyUI target/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("an OCCUPIED port while /system_stats is unavailable: status says no launch, start reports already running", async () => {
    serverUnreachable("owned");
    __processControlTestHooks.setLastProcessInfo(validRecord);

    const status = await describeLifecycleStatus();

    expect(status.start.launches).toBe("no");
    expect(status.start.reason).toMatch(/held by PID 4321/);

    const started = await startComfyUI();
    expect(started.started).toBe(false);
    expect(started.message).toMatch(/already running on port 8188 \(PID 4321\)/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("an OCCUPIED port whose holder cannot be tied to the answering server (ambiguous PID): no false yes", async () => {
    // /system_stats answers and lsof names PID 4321, but neither end of the
    // request can stamp that process and no witness is available, so the instance
    // is refused as ambiguous — acquireProcessInfo resolves nothing. Only the port
    // probe knows the port is taken, and that is what start decides on.
    mockGetSystemStats.mockResolvedValue({ system: { argv: ARGV } });
    mockExecSync.mockImplementation((cmd: string) =>
      /lsof/i.test(cmd) ? "p4321\nn127.0.0.1:8188\n" : "",
    );
    __processControlTestHooks.setProcessIdentityResolver(() => undefined);
    __processControlTestHooks.setLastProcessInfo(validRecord);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true }) as Response));

    const status = await describeLifecycleStatus();

    expect(status.instance.identified).toBe("unknown");
    expect(status.start.launches).toBe("no");
    expect(status.start.reason).toMatch(/held by PID 4321/);

    const started = await startComfyUI();
    expect(started.started).toBe(false);
    expect(started.message).toMatch(/already running on port 8188 \(PID 4321\)/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("an UNDETERMINABLE port owner is not promoted to yes — start would still try, and status says exactly that", async () => {
    serverUnreachable("unknown");
    __processControlTestHooks.setLastProcessInfo(validRecord);

    const status = await describeLifecycleStatus();

    expect(status.start.launches).toBe("unknown");
    expect(status.start.reason).toMatch(/could not be determined/);
    expect(status.start.reason).toMatch(/would still try/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("KEEPS the positive case: free port + a current, disk-valid record → yes, and start does launch it", async () => {
    serverUnreachable("free");
    __processControlTestHooks.setLastProcessInfo(validRecord);

    const status = await describeLifecycleStatus();
    expect(status.start.launches).toBe("yes");
    expect(mockSpawn).not.toHaveBeenCalled();

    await startComfyUI();
    expect(mockSpawn).toHaveBeenCalledTimes(1); // the MOCKED spawn: nothing real runs
    expect((mockSpawn.mock.calls[0] as [string, string[]])[1][0]).toBe(MAIN);
  }, 20_000);

  it.each([
    ["the base URL moves", () => { mockConfig.baseUrl = "http://127.0.0.1:9999"; }],
    // A→B→A leaves the base equal; only the generation shows it.
    ["only the generation moves (A→B→A)", () => { mockConfig.generation += 1; }],
  ])("a target change DURING collection (%s) returns unknown + retry, never a mixed answer", async (_label, retarget) => {
    mockExecSync.mockImplementation((cmd: string) =>
      /lsof/i.test(cmd) ? "p4321\nn127.0.0.1:8188\n" : "",
    );
    mockGetSystemStats.mockImplementation(async () => {
      retarget();
      return { system: { argv: ARGV } };
    });
    const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchSpy);
    __processControlTestHooks.setLastProcessInfo(validRecord);
    const saved = __processControlTestHooks.getLastProcessInfo();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const status = await describeLifecycleStatus();

    expect(status.target_stable).toBe(false);
    expect(status.target.base_url).toBe("http://127.0.0.1:8188"); // the target it began for
    expect(status.instance.identified).toBe("unknown");
    expect(status.start.launches).toBe("unknown");
    expect(status.stop).toMatchObject({ allowed: "unknown", recoverable_by_start: "unknown" });
    expect(status.restart).toMatchObject({ will_attempt: "unknown", evidence: "none" });
    expect(status.summary).toMatch(/Retry/);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy.mock.calls.every(([, sig]) => sig === 0)).toBe(true);
    expect(__processControlTestHooks.getLastProcessInfo()).toBe(saved);
    killSpy.mockRestore();
  });

  it("a stable target reports target_stable:true", async () => {
    serverUnreachable("free");
    const status = await describeLifecycleStatus();
    expect(status.target_stable).toBe(true);
  });
});
