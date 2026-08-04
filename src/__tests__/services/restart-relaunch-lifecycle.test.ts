// NEVER STOP WHAT YOU CANNOT RESTART (#814, #767).
//
// Three reports, one rule. In each of them the tool took a server down and then
// discovered it could not bring it back:
//
//   #814 — panel_restart_comfyui asked ComfyUI-Manager to reboot a Comfy
//          Desktop-spawned server whose Electron supervisor had already moved on.
//          The reboot stopped the process; nothing restarted it. The result then
//          said it "can't confirm it came back" — a verdict computed AFTER a stop
//          it should never have made.
//   #767 — a ComfyUI wedged by a CUDA OOM stopped answering /system_stats, so the
//          launch arguments came back empty. `stop_comfyui` killed it anyway and
//          reported `has_restart_info: true`; `start_comfyui` then answered "No
//          command-line info captured from previous run". The OS had the whole
//          command line the entire time.
//
// So: relaunch capability is established BEFORE the stop, refusal is loud, and the
// claim that a restart is possible means a command was actually built and
// validated. Where a relaunch genuinely cannot be proven but the launch command WAS
// observed, the stop still happens (stop_comfyui is an explicit instruction, and a
// wedged server is exactly when someone means it) — but it says so, and hands over
// the command to run by hand.
//
// Boundaries only are mocked: config, the env services, the python resolver,
// child_process, node:fs, the ComfyUI client, and global fetch.

import { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyDesktopSupervision,
  compareStartTimes,
  unclassifiedSupervision,
} from "../../services/listener-ownership.js";
import { tokenizeCommandLine } from "../../services/live-interpreter.js";

/** `lsof -V` STATING that nothing is listening (see restart-live-first.test.ts). */
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
  pid: number | undefined = 4321;
}

const mockConfig = vi.hoisted(() => ({
  resolvedPort: 8188,
  comfyuiPath: undefined as string | undefined,
}));

const mockExecSync = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());
const mockGetSystemStats = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn((_p: string) => true));
const mockIsFile = vi.hoisted(() => vi.fn((_p: string) => true));
const mockFindComfyuiPython = vi.hoisted(() => vi.fn());
const mockResolveBase = vi.hoisted(() => vi.fn<[], string | undefined>());
const mockLiveRootFromArgv = vi.hoisted(() =>
  vi.fn<[string[], string?], string | undefined>(),
);

vi.mock("../../config.js", () => ({
  config: mockConfig,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyUIAuthHeaders: () => ({}),
  isRemoteMode: () => false,
}));

vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
  spawn: mockSpawn,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readlinkSync: vi.fn(() => {
    throw new Error("no /proc in test");
  }),
  readFileSync: vi.fn(() => {
    throw Object.assign(new Error("no /proc in test"), { code: "ENOENT" });
  }),
  // #795 walks /proc/<pid>/fd to attribute a socket; absent here so the port probe
  // answers from the lsof fixtures below.
  readdirSync: vi.fn(() => {
    throw Object.assign(new Error("no /proc in test"), { code: "ENOENT" });
  }),
  statSync: vi.fn((p: string) => {
    if (!mockExistsSync(String(p))) throw new Error("ENOENT");
    return { isFile: () => mockIsFile(String(p)) };
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

import {
  __processControlTestHooks,
  preflightLocalRestart,
  restartComfyUI,
  startComfyUI,
  stopComfyUI,
} from "../../services/process-control.js";

const BASE = resolve("ComfyUI_wedged", "ComfyUI");
const ABS_MAIN = join(BASE, "main.py");
const ABS_PYTHON = join(BASE, ".venv", "Scripts", "python.exe");

const ORIGINAL_ENV = { ...process.env };

/** A live pid on the port until a kill is issued, then a free port. */
function mockLivePortThenFree(pid = 4321): { killed: () => boolean } {
  let killed = false;
  mockExecSync.mockImplementation((cmd: string) => {
    if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
      killed = true;
      return "";
    }
    if (/netstat/i.test(cmd)) {
      return killed ? "" : `  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       ${pid}`;
    }
    if (/lsof/i.test(cmd)) {
      if (killed) throw noListener();
      return `p${pid}\nn127.0.0.1:8188\n`;
    }
    return "";
  });
  return { killed: () => killed };
}

/** Was a kill actually issued to the OS? */
function killWasIssued(): boolean {
  return mockExecSync.mock.calls.some((c) => /taskkill|pkill|\bkill\b/i.test(String(c[0])));
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  process.env.COMFYUI_STARTUP_CHECK_INTERVAL_S = "0.01";
  process.env.COMFYUI_STARTUP_CHECK_MAX_TRIES = "1";
  process.env.COMFYUI_PORT_FREE_TIMEOUT_S = "1";
  mockConfig.resolvedPort = 8188;
  mockConfig.comfyuiPath = undefined;
  mockFindComfyuiPython.mockReturnValue(ABS_PYTHON);
  mockLiveRootFromArgv.mockReturnValue(undefined);
  mockResolveBase.mockReturnValue(BASE);
  mockExistsSync.mockImplementation((p: string) => {
    const s = String(p);
    return s === ABS_MAIN || s === ABS_PYTHON;
  });
  mockIsFile.mockImplementation((_p: string) => true);
  __processControlTestHooks.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  __processControlTestHooks.reset();
});

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

describe("classifyDesktopSupervision — is anything going to start this again? (#814)", () => {
  const DESKTOP_SHELL = "C:\\Program Files\\Comfy Desktop\\Comfy Desktop.exe";
  const isSupervisorProcess = (identity: { commandLine?: string }): boolean =>
    (identity.commandLine ?? "").toLowerCase().includes("comfy desktop");

  /**
   * A process tree: pid → { parent, cmd, started }.
   *
   * `started` is a Linux-style clock-tick stamp, and it is load-bearing rather than
   * decoration: a parent pid outlives the process that earned it, so the link is
   * only real when the parent started no later than the child. Nodes default to a
   * stamp that satisfies that, and the recycled-pid tests break it deliberately.
   */
  function tree(
    nodes: Record<number, { parent?: number; cmd?: string; started?: string }>,
    opts: { vanished?: number[]; unknownExistence?: number[]; noStamps?: boolean } = {},
  ): Parameters<typeof classifyDesktopSupervision>[0] {
    return {
      pid: 500,
      readParentPid: (pid) => nodes[pid]?.parent,
      readIdentity: (pid) => {
        const node = nodes[pid];
        if (!node) return undefined;
        // A parent's default stamp is OLDER than its child's, which is what a real
        // tree looks like: deeper pids were started later.
        const started = opts.noStamps ? undefined : (node.started ?? String(pid));
        if (!node.cmd && started === undefined) return undefined;
        return { commandLine: node.cmd, startedAt: started };
      },
      processExists: (pid) => {
        if (opts.vanished?.includes(pid)) return false;
        if (opts.unknownExistence?.includes(pid)) return undefined;
        return true;
      },
      isSupervisorProcess,
    };
  }

  it("a live Desktop shell directly above the server is SUPERVISED", () => {
    const { verdict } = classifyDesktopSupervision(
      tree({ 500: { parent: 300 }, 300: { cmd: DESKTOP_SHELL, parent: 100 } }),
    );
    expect(verdict).toBe("supervised");
  });

  it("being a Desktop shell ITSELF proves nothing about the server on the port", () => {
    // An earlier revision short-circuited to `supervised` when the pid handed in was
    // itself a Desktop shell, to serve a caller that falls back to "use whatever
    // Desktop process is running" when the port cannot be attributed. But that
    // fallback picks a shell by scanning process NAMES — bound to no port and no
    // backend — so a second, unrelated Desktop window would have licensed stopping an
    // orphaned backend it has never heard of.
    //
    // The premise was the problem, not the walk: the caller now declines before
    // reaching here (see the preflight suite), and this classifier only ever sees a
    // pid resolved FROM THE PORT. Asked about a shell anyway, it answers the same way
    // it answers about anything with no supervisor above it.
    const { verdict } = classifyDesktopSupervision(
      tree({
        500: { cmd: DESKTOP_SHELL, started: "1000", parent: 400 },
        400: { cmd: "explorer.exe", started: "10", parent: 1 },
      }),
    );
    expect(verdict).not.toBe("supervised");
  });

  it("an intermediate wrapper is walked THROUGH, not treated as an answer", () => {
    // A launcher shim between the shell and python is ordinary. Stopping at the
    // first non-supervisor would report every wrapped Desktop install abandoned and
    // deny those users a restart that works.
    const { verdict } = classifyDesktopSupervision(
      tree({
        500: { parent: 400 },
        400: { cmd: "cmd.exe /c launch.bat", parent: 300 },
        300: { cmd: DESKTOP_SHELL, parent: 100 },
      }),
    );
    expect(verdict).toBe("supervised");
  });

  it("THE #814 SHAPE: the supervisor's pid is provably vacant → ABANDONED", () => {
    // The Desktop shell that spawned this server has exited. A Manager reboot stops
    // the process and there is nobody left to start it again.
    const { verdict } = classifyDesktopSupervision(
      tree({ 500: { parent: 300 }, 300: { cmd: DESKTOP_SHELL } }, { vanished: [300] }),
    );
    expect(verdict).toBe("abandoned");
  });

  it("a process reparented to init is ABANDONED", () => {
    // On POSIX the reparenting IS the record that whoever spawned it has gone.
    const { verdict } = classifyDesktopSupervision(tree({ 500: { parent: 1 } }));
    expect(verdict).toBe("abandoned");
  });

  it("a readable chain to the tree top with no supervisor on it is ABANDONED", () => {
    const { verdict } = classifyDesktopSupervision(
      tree({
        500: { parent: 400 },
        400: { cmd: "explorer.exe", parent: 200 },
        200: { cmd: "services.exe", parent: 1 },
      }),
    );
    expect(verdict).toBe("abandoned");
  });

  it("an UNREADABLE parent pid is unconfirmed — never abandoned", () => {
    // Refusing on missing evidence would take the Desktop restart away from every
    // host whose process tree cannot be read, which is the far more common and far
    // more damaging failure. Only a positive finding refuses.
    const { verdict } = classifyDesktopSupervision(tree({ 500: {} }));
    expect(verdict).toBe("unconfirmed");
  });

  it("A RECYCLED parent pid that looks exactly like a supervisor is ABANDONED, not supervised", () => {
    // The nastiest variant of #814, and the one a pid-plus-command-line check waves
    // straight through: the shell that spawned this backend exited, Windows handed
    // its number to ANOTHER Comfy Desktop.exe (the user restarted the app), and that
    // new shell has never heard of this backend. Causality catches it — a parent
    // cannot have started after its child.
    const { verdict } = classifyDesktopSupervision(
      tree({
        500: { parent: 300, started: "1000" },
        300: { cmd: DESKTOP_SHELL, started: "5000" }, // started AFTER its "child"
      }),
    );
    expect(verdict).toBe("abandoned");
  });

  it("a supervisor that genuinely predates the server is still SUPERVISED", () => {
    // The control for the causality check: an ordinary tree must not be broken by it.
    const { verdict } = classifyDesktopSupervision(
      tree({
        500: { parent: 300, started: "5000" },
        300: { cmd: DESKTOP_SHELL, started: "1000" },
      }),
    );
    expect(verdict).toBe("supervised");
  });

  it("stamps that cannot be compared leave the link UNVERIFIED, never supervised", () => {
    // Without a way to check the link, "that pid exists and looks like a shell" is
    // not evidence it is THIS server's shell. Unconfirmed still proceeds, so this
    // costs a restart nothing on a host with no readable start times.
    const { verdict } = classifyDesktopSupervision(
      tree({ 500: { parent: 300 }, 300: { cmd: DESKTOP_SHELL } }, { noStamps: true }),
    );
    expect(verdict).toBe("unconfirmed");
  });

  it("a parent that exists but cannot be IDENTIFIED is unconfirmed, not supervised", () => {
    // Pids are recycled: something holding that number is not evidence that a
    // supervisor does. This is the other direction of the same rule — an
    // unidentifiable parent must not license the stop either.
    const { verdict } = classifyDesktopSupervision(tree({ 500: { parent: 300 }, 300: {} }));
    expect(verdict).toBe("unconfirmed");
  });

  it("an unidentifiable ancestor STOPS the walk — it is not stepped over", () => {
    // A process we cannot see the nature of might BE the shell. Walking past it to
    // the tree top would turn "I could not tell" into `abandoned`, refusing a
    // restart on the strength of a process we never identified. The stamp is
    // readable, so only the identity is missing — which is exactly the case that
    // must not be mistaken for evidence.
    const { verdict } = classifyDesktopSupervision(
      tree({ 500: { started: "5000", parent: 300 }, 300: { started: "1000", parent: 1 } }),
    );
    expect(verdict).toBe("unconfirmed");
  });

  it("a parent whose existence cannot be established is unconfirmed", () => {
    const { verdict } = classifyDesktopSupervision(
      tree({ 500: { parent: 300 }, 300: { cmd: DESKTOP_SHELL } }, { unknownExistence: [300] }),
    );
    expect(verdict).toBe("unconfirmed");
  });

  it("a self-parenting reading is damage, not a tree root", () => {
    const { verdict } = classifyDesktopSupervision(tree({ 500: { parent: 500 } }));
    expect(verdict).toBe("unconfirmed");
  });

  it("running out of hops is 'did not finish looking', never a verdict", () => {
    // A chain longer than the budget is not a layout we can reason about.
    const nodes: Record<number, { parent?: number; cmd?: string; started?: string }> = {};
    // Each link is causally sound (every parent predates its child), so the walk is
    // stopped by the BUDGET and nothing else.
    for (let pid = 500; pid < 600; pid++) {
      nodes[pid] = { parent: pid + 1, cmd: "wrapper", started: String(2000 - pid) };
    }
    const { verdict } = classifyDesktopSupervision(tree(nodes));
    expect(verdict).toBe("unconfirmed");
  });

  it("a caller that did not classify may only say unconfirmed", () => {
    expect(unclassifiedSupervision()).toBe("unconfirmed");
  });
});

describe("compareStartTimes — a parent cannot start after its child", () => {
  it("compares a Windows FILETIME exactly, beyond Number's safe range", () => {
    // 18-digit FILETIMEs exceed Number.MAX_SAFE_INTEGER (9007199254740991), so a
    // float comparison silently equates stamps 100ns — or much more — apart. Two
    // real, adjacent FILETIMEs that differ only in their last digits:
    const older = "133700000000000001";
    const newer = "133700000000000002";
    expect(Number(older) === Number(newer)).toBe(true); // the trap, demonstrated
    expect(compareStartTimes(older, newer)).toBe("parent-first");
    expect(compareStartTimes(newer, older)).toBe("parent-newer");
  });

  it("treats an equal stamp as sound — coarse clocks put a spawn in the same second", () => {
    expect(compareStartTimes("1000", "1000")).toBe("parent-first");
  });

  it("compares macOS ctime-style stamps by date", () => {
    expect(compareStartTimes("Fri Aug  1 12:00:00 2026", "Fri Aug  1 12:00:05 2026")).toBe(
      "parent-first",
    );
    expect(compareStartTimes("Fri Aug  1 12:00:05 2026", "Fri Aug  1 12:00:00 2026")).toBe(
      "parent-newer",
    );
  });

  it("an unreadable or unparseable stamp is UNKNOWN, never 'fine'", () => {
    expect(compareStartTimes(undefined, "1000")).toBe("unknown");
    expect(compareStartTimes("1000", undefined)).toBe("unknown");
    expect(compareStartTimes("stable-stamp", "also-not-a-time")).toBe("unknown");
  });
});

describe("tokenizeCommandLine — the OS's flattened command line back into argv", () => {
  it("groups a quoted path with spaces", () => {
    expect(
      tokenizeCommandLine('"C:\\Program Files\\ComfyUI\\python.exe" main.py --port 8188'),
    ).toEqual(["C:\\Program Files\\ComfyUI\\python.exe", "main.py", "--port", "8188"]);
  });

  it("follows the Windows backslash rule so a trailing separator cannot swallow the rest", () => {
    // `"a\\"` is a quoted argument ending in ONE backslash — the doubled backslashes
    // are literal and the quote CLOSES. A naive parser reads that quote as an opener
    // instead, fusing every later argument into one string: the relaunch then spawns
    // with mangled arguments while the existence checks upstream still pass, because
    // they only validate the executable and the script.
    // The command line is literally:  python "C:\Comfy\\" --port 8188
    expect(tokenizeCommandLine('python "C:\\Comfy\\\\" --port 8188')).toEqual([
      "python",
      "C:\\Comfy\\",
      "--port",
      "8188",
    ]);
    // And the ODD count is the other half of the same rule: one backslash before a
    // quote escapes it, so the quote stays open and the argument runs on. Pinning
    // both directions is what keeps a "fix" from simply inverting the bug.
    expect(tokenizeCommandLine('python "C:\\Comfy\\" --port 8188')).toEqual([
      "python",
      'C:\\Comfy" --port 8188',
    ]);
  });

  it("an escaped quote is a literal character, not a delimiter", () => {
    expect(tokenizeCommandLine('python --title \\"hi\\" --port 8188')).toEqual([
      "python",
      "--title",
      '"hi"',
      "--port",
      "8188",
    ]);
  });

  it("leaves a POSIX path's backslashes alone", () => {
    // Backslash is a legal filename character on POSIX, and nothing here quotes.
    expect(tokenizeCommandLine("python /srv/comfy\\ui/main.py")).toEqual([
      "python",
      "/srv/comfy\\ui/main.py",
    ]);
  });

  it("keeps an empty quoted argument", () => {
    expect(tokenizeCommandLine('python --flag "" --port 8188')).toEqual([
      "python",
      "--flag",
      "",
      "--port",
      "8188",
    ]);
  });
});

// ---------------------------------------------------------------------------
// #767 — the stop and the start must agree
// ---------------------------------------------------------------------------

describe("stop_comfyui — has_restart_info means a relaunch was BUILT (#767)", () => {
  /**
   * The #767 shape: a wedged server. `/system_stats` does not answer, so the launch
   * arguments come back EMPTY — every relaunch decision downstream used to have
   * nothing to work with.
   */
  function wedgedServer(): void {
    mockGetSystemStats.mockRejectedValue(new Error("fetch failed"));
  }

  /**
   * A wedged server that is REPLACED once it has been identified.
   *
   * The swap has to happen at a definite point in the gather, and the last
   * `/system_stats` attempt is one: the pid's identity is captured before it, and the
   * pre-kill re-check happens after. Keying on that rather than on "the Nth call to
   * the identity reader" keeps the test about the substitution instead of about how
   * many times any one reader happens to be consulted.
   */
  function swapAfterSecondStatsAttempt(): () => boolean {
    let attempts = 0;
    let swapped = false;
    mockGetSystemStats.mockImplementation(async () => {
      attempts++;
      if (attempts >= 2) swapped = true;
      throw new Error("fetch failed");
    });
    return () => swapped;
  }

  it("rebuilds the relaunch from the OS command line when the server cannot answer", async () => {
    // The user's own recovery in #767 was to read the command line out of the
    // process table by hand. It was readable the whole time.
    wedgedServer();
    mockLivePortThenFree();
    __processControlTestHooks.setProcessIdentityResolver(() => ({
      startedAt: "stable-stamp",
      commandLine: `${ABS_PYTHON} ${ABS_MAIN} --cache-none`,
      argv: [ABS_PYTHON, ABS_MAIN, "--cache-none"],
      // Linux/Windows: the argument vector can be reconstructed faithfully, so it is
      // a command and not merely a reading.
      argvFidelity: "exact" as const,
    }));
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

    const stopped = await stopComfyUI();
    expect(stopped.stopped).toBe(true);
    // THE CLAIM #767 WAS ABOUT — and it is now backed by a built command.
    expect(stopped.has_restart_info).toBe(true);

    const started = await startComfyUI();
    expect(started.started).toBe(true);
    // The OS argv[0] is the INTERPRETER (unlike sys.argv, whose first element is
    // the script), so it is spawned verbatim — no interpreter has to be guessed.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [exe, args] = mockSpawn.mock.calls[0];
    expect(exe).toBe(ABS_PYTHON);
    expect(args).toEqual([ABS_MAIN, "--cache-none"]);

    killSpy.mockRestore();
  });

  it("will not SPAWN a command line the OS could only report FLATTENED", async () => {
    // macOS `ps -o command=` joins argv with spaces, so `--output-directory
    // /Users/a/Comfy Outputs` cannot be told from two arguments. Relaunching from
    // that reading would spawn a command the user never ran — very possibly one
    // ComfyUI's own argument parser rejects, AFTER the server had been stopped
    // (codex gate round 6). The reading is still shown to the user, who can see where
    // the quotes belong; we cannot.
    wedgedServer();
    mockLivePortThenFree();
    const OUT = "/Users/a/Comfy Outputs";
    __processControlTestHooks.setProcessIdentityResolver(() => ({
      startedAt: "stable-stamp",
      commandLine: `${ABS_PYTHON} ${ABS_MAIN} --output-directory ${OUT}`,
      // What a naive split yields — and precisely why it must not be spawned.
      argv: [ABS_PYTHON, ABS_MAIN, "--output-directory", "/Users/a/Comfy", "Outputs"],
      argvFidelity: "flattened" as const,
    }));
    mockSpawn.mockImplementation(() => new FakeChild());
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const stopped = await stopComfyUI();

    // The stop still happens — it was asked for — but the tool does not claim it can
    // undo it, and the hint says the arguments are approximate.
    expect(stopped.stopped).toBe(true);
    expect(stopped.has_restart_info).toBe(false);
    expect(stopped.restart_hint?.command).toBe(
      `${ABS_PYTHON} ${ABS_MAIN} --output-directory ${OUT}`,
    );
    expect(stopped.restart_hint?.command_flattened).toBe(true);
    expect(stopped.message).toMatch(/needs re-quoting/i);

    // And the start does NOT spawn the mangled argv.
    const started = await startComfyUI();
    expect(started.started).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("REFUSES the stop when nothing at all was observed about how to start it", async () => {
    // Neither the server nor the OS could say what this process is running, so a
    // stop is a one-way door: not by this tool, and not by hand either. That is the
    // one case where an explicit "stop" is declined.
    wedgedServer();
    mockLivePortThenFree();
    __processControlTestHooks.setProcessIdentityResolver(() => ({
      startedAt: "stable-stamp",
    }));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const stopped = await stopComfyUI();

    expect(stopped.stopped).toBe(false);
    expect(stopped.has_restart_info).toBe(false);
    expect(stopped.message).toMatch(/refusing to stop/i);
    expect(stopped.message).toMatch(/no way to bring it back/i);
    // CRITICAL: the server is untouched.
    expect(killWasIssued()).toBe(false);

    killSpy.mockRestore();
  });

  it("stops but says PLAINLY that start_comfyui cannot bring it back, and how to do it by hand", async () => {
    // FAIL-BEFORE: this reported `has_restart_info: true` and a bare success, and
    // the start that followed failed. The stop is still performed — it was asked
    // for, and a wedged server is exactly when someone means it — but the report
    // does not pretend the tool can undo it.
    wedgedServer();
    mockLivePortThenFree();
    // The command line names an install that is NOT on disk, so no relaunch can be
    // validated — but it is still what a human needs to see.
    const GONE_PY = join(resolve("gone"), "main.py");
    __processControlTestHooks.setProcessIdentityResolver(() => ({
      startedAt: "stable-stamp",
      commandLine: `python ${GONE_PY} --port 8188`,
      argv: ["python", GONE_PY, "--port", "8188"],
    }));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const stopped = await stopComfyUI();

    expect(stopped.stopped).toBe(true);
    expect(stopped.has_restart_info).toBe(false);
    expect(stopped.message).toMatch(/start_comfyui will NOT be able to bring this back/i);
    expect(stopped.relaunch_blocked).toBeTruthy();
    // The recovery command is handed over, not left in the process table.
    expect(stopped.restart_hint?.command).toContain(GONE_PY);
    expect(stopped.message).toMatch(/To start it by hand, run:/i);

    killSpy.mockRestore();
  });

  it("refuses to kill a REPLACEMENT that inherited the wedged server's PID", async () => {
    // Round-5 codex gate. Recovering a wedged server means acting on a pid that no
    // server answered for, so the usual corroboration (the OS's command line against
    // the server's own argv) has nothing to work with. That must not collapse into
    // bare pid/port equality: A is observed, A exits, B rebinds the port after
    // inheriting A's number, and the stop would kill B using A's relaunch data.
    //
    // The pid's creation stamp is read on this path too, and it is exactly what pid
    // reuse defeats — so it is retained, and re-checked before the kill.
    mockLivePortThenFree();
    // The substitution lands AFTER the instance has been identified. The identity is
    // captured before the last /system_stats attempt of the gather, so counting that
    // attempt is a stable way to say "now the pid means somebody else" without
    // depending on how many times any single reader happens to be called.
    const swapped = swapAfterSecondStatsAttempt();
    __processControlTestHooks.setProcessIdentityResolver(() => ({
      // Byte-identical command line — a replacement ComfyUI looks just like the one
      // that went away, so the command line alone cannot separate them.
      commandLine: `${ABS_PYTHON} ${ABS_MAIN} --cache-none`,
      argv: [ABS_PYTHON, ABS_MAIN, "--cache-none"],
      // …but it is a different process, and the OS says so.
      startedAt: swapped() ? "second-boot" : "first-boot",
    }));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const stopped = await stopComfyUI();

    expect(stopped.stopped).toBe(false);
    expect(stopped.message).toMatch(/refusing to stop/i);
    expect(stopped.message).toMatch(/creation time/i);
    // CRITICAL: the replacement is untouched.
    expect(killWasIssued()).toBe(false);

    killSpy.mockRestore();
  });

  it("refuses when the pid is now running something else entirely", async () => {
    // The other half of the same protection: the number was reused by a program with
    // a DIFFERENT command line. Comparing the OS's later reading against its earlier
    // one is not self-corroboration — the two are separated in time, which is what a
    // substitution has to survive.
    mockLivePortThenFree();
    const swapped = swapAfterSecondStatsAttempt();
    __processControlTestHooks.setProcessIdentityResolver(() =>
      swapped()
        ? {
            commandLine: "C:\\Windows\\System32\\notepad.exe",
            argv: ["C:\\Windows\\System32\\notepad.exe"],
            startedAt: "stable-stamp",
          }
        : {
            commandLine: `${ABS_PYTHON} ${ABS_MAIN} --cache-none`,
            argv: [ABS_PYTHON, ABS_MAIN, "--cache-none"],
            startedAt: "stable-stamp",
          },
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const stopped = await stopComfyUI();

    expect(stopped.stopped).toBe(false);
    expect(stopped.message).toMatch(/refusing to stop/i);
    expect(stopped.message).toMatch(/running something other than/i);
    expect(killWasIssued()).toBe(false);

    killSpy.mockRestore();
  });

  it("a healthy install still reports has_restart_info true", async () => {
    // The control: the claim must not become uniformly pessimistic. A server whose
    // relaunch really is buildable still says so.
    mockGetSystemStats.mockResolvedValue({
      system: { argv: [ABS_MAIN, "--port", "8188"] },
    });
    mockLivePortThenFree();
    __processControlTestHooks.setProcessIdentityResolver(() => ({
      startedAt: "stable-stamp",
    }));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const stopped = await stopComfyUI();

    expect(stopped.stopped).toBe(true);
    expect(stopped.has_restart_info).toBe(true);
    expect(stopped.message).not.toMatch(/will NOT be able/i);

    killSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// #814 — a Desktop instance is never stopped on an assumption about its supervisor
// ---------------------------------------------------------------------------

describe("restart_comfyui — a Desktop reboot needs a supervisor that is actually there (#814)", () => {
  /**
   * A ComfyUI **Desktop** instance as it really appears: `sys.argv` carries the
   * Desktop-flavoured `--extra-model-paths-config`, which is what identifies it
   * (captured from the #814 report's own recovery command line).
   */
  const DESKTOP_ARGV = [
    "ComfyUI\\main.py",
    "--enable-manager",
    "--extra-model-paths-config",
    "C:\\Users\\u\\AppData\\Roaming\\Comfy Desktop\\shared_model_paths.yaml",
    "--port",
    "8188",
  ];

  function desktopServer(): void {
    mockGetSystemStats.mockResolvedValue({ system: { argv: DESKTOP_ARGV } });
    mockLivePortThenFree();
  }

  it("REFUSES before any reboot when the Desktop supervisor has gone", async () => {
    // #814 exactly: two backends off one install, the shell that spawned the bound
    // one had moved on, and the reboot stopped a server nothing would restart.
    desktopServer();
    __processControlTestHooks.setProcessIdentityResolver((pid) =>
      pid === 4321
        ? { startedAt: "stable-stamp", parentPid: 300, argv: DESKTOP_ARGV }
        : undefined,
    );
    __processControlTestHooks.setParentPidResolver((pid) =>
      pid === 4321 ? 300 : undefined,
    );
    // The shell's pid is vacant — it exited.
    __processControlTestHooks.setProcessExistsProbe((pid) => (pid === 300 ? false : true));
    const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/refusing to restart/i);
    expect(result.message).toMatch(/no Desktop app is still supervising it/i);
    expect(result.message).toMatch(/left running/i);
    // CRITICAL: no reboot was fired and nothing was killed. The refusal happened
    // BEFORE the stop, which is the entire point.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(killWasIssued()).toBe(false);
    // And the user is told how to bring it back if they need to.
    expect(result.restart_hint?.server_argv).toEqual(DESKTOP_ARGV);
  });

  it("proceeds to the Manager reboot when a live Desktop shell IS supervising it", async () => {
    // The control for the refusal: an ordinary Desktop restart must keep working
    // (#400 routes it here precisely because killing it does not). The shell
    // genuinely predates the backend, so the parent link is verified rather than
    // merely unreadable — this proves the SUPERVISED path, not the unconfirmed one.
    desktopServer();
    __processControlTestHooks.setProcessIdentityResolver((pid) => {
      if (pid === 4321) return { startedAt: "5000", parentPid: 300 };
      if (pid === 300) {
        return {
          // As Windows really reports it: a path with spaces is QUOTED, and
          // ExecutablePath is supplied alongside — which is what actually decides.
          commandLine: '"C:\\Program Files\\Comfy Desktop\\Comfy Desktop.exe"',
          argv: ["C:\\Program Files\\Comfy Desktop\\Comfy Desktop.exe"],
          executablePath: "C:\\Program Files\\Comfy Desktop\\Comfy Desktop.exe",
          startedAt: "2000",
        };
      }
      return undefined;
    });
    __processControlTestHooks.setParentPidResolver((pid) => (pid === 4321 ? 300 : undefined));
    __processControlTestHooks.setProcessExistsProbe(() => true);
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await restartComfyUI();

    expect(result.message).not.toMatch(/refusing to restart/i);
    // The Manager reboot route was actually taken.
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("a wrapper that PASSES THE DESKTOP EXE AS AN ARGUMENT is not a supervisor", async () => {
    // Round-2 codex gate. Testing the whole command line for the Desktop binary is
    // not enough: a wrapper can carry that exact path as an argument, pass the
    // start-time causality check, and be read as the shell — after which the reboot
    // stops a server the wrapper will never restart. The supervisor must BE the
    // Desktop binary (argv[0]), not merely name it.
    desktopServer();
    __processControlTestHooks.setProcessIdentityResolver((pid) => {
      if (pid === 4321) return { startedAt: "5000", parentPid: 300 };
      if (pid === 300) {
        // Both spellings of the same trick in one command line: the Windows exe AND
        // a macOS bundle binary, each carried as an ARGUMENT. Neither may stand in
        // for the shell, and the positional macOS fallback must not be reachable
        // from a path that does not open the line.
        const commandLine =
          'python.exe wrapper.py --desktop-exe "C:\\Program Files\\Comfy Desktop\\Comfy Desktop.exe"' +
          ' --mac-app "/Applications/Comfy Desktop.app/Contents/MacOS/Comfy Desktop"';
        return {
          commandLine,
          // argv[0] is the WRAPPER's own executable — the Desktop paths are arguments.
          argv: [
            "python.exe",
            "wrapper.py",
            "--desktop-exe",
            "C:\\Program Files\\Comfy Desktop\\Comfy Desktop.exe",
            "--mac-app",
            "/Applications/Comfy Desktop.app/Contents/MacOS/Comfy Desktop",
          ],
          startedAt: "2000",
          parentPid: 1,
        };
      }
      return undefined;
    });
    __processControlTestHooks.setParentPidResolver((pid) => {
      if (pid === 4321) return 300;
      if (pid === 300) return 1;
      return undefined;
    });
    __processControlTestHooks.setProcessExistsProbe(() => true);
    const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await restartComfyUI();

    expect(result.message).toMatch(/no Desktop app is still supervising it/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(killWasIssued()).toBe(false);
  });

  it("a process CLAIMING to be the Desktop shell in argv[0] is not one", async () => {
    // Round-3 codex gate. argv[0] is a string the launcher chose — `exec -a`, or a
    // hand-built Windows command line, lets any program present itself as any other.
    // A wrapper that spawned the backend and predates it would otherwise pass the
    // causality check, be read as the shell, and get the reboot dispatched; it
    // restarts nothing, so the server stays down. The OS's own record of the binary
    // is what the process cannot set, and it settles this.
    desktopServer();
    __processControlTestHooks.setProcessIdentityResolver((pid) => {
      if (pid === 4321) return { startedAt: "5000", parentPid: 300 };
      if (pid === 300) {
        return {
          // Everything the process says about itself is a Desktop shell…
          commandLine: '"C:\\Program Files\\Comfy Desktop\\Comfy Desktop.exe"',
          argv: ["C:\\Program Files\\Comfy Desktop\\Comfy Desktop.exe"],
          // …and the kernel says it is python.
          executablePath: "C:\\tools\\python.exe",
          startedAt: "2000",
          parentPid: 1,
        };
      }
      return undefined;
    });
    __processControlTestHooks.setParentPidResolver((pid) => {
      if (pid === 4321) return 300;
      if (pid === 300) return 1;
      return undefined;
    });
    __processControlTestHooks.setProcessExistsProbe(() => true);
    const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await restartComfyUI();

    expect(result.message).toMatch(/no Desktop app is still supervising it/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(killWasIssued()).toBe(false);
  });

  it("the authenticated executable path is enough on its own, with NO command line at all", async () => {
    // The other direction of the same rule, and the absent-field path specifically:
    // a process whose command line cannot be read but whose EXECUTABLE the OS names
    // is still identified. Gating the walk on the command line alone would stop
    // here and never consult the authenticated evidence that exists to settle
    // exactly this — in this direction it would deny a working Desktop restart, and
    // in the other it would let a wrapper through (codex gate round 4).
    desktopServer();
    __processControlTestHooks.setProcessIdentityResolver((pid) => {
      if (pid === 4321) return { startedAt: "5000", parentPid: 300 };
      if (pid === 300) {
        return {
          // No commandLine and no argv — the OS gave us only the binary.
          executablePath: "C:\\Program Files\\Comfy Desktop\\Comfy Desktop.exe",
          startedAt: "2000",
          parentPid: 1,
        };
      }
      return undefined;
    });
    __processControlTestHooks.setParentPidResolver((pid) => {
      if (pid === 4321) return 300;
      if (pid === 300) return 1;
      return undefined;
    });
    __processControlTestHooks.setProcessExistsProbe(() => true);
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await restartComfyUI();

    expect(result.message).not.toMatch(/refusing to restart/i);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("a NON-Desktop binary with no command line is not waved through as unconfirmed", async () => {
    // The negative half of the absent-field path. Stopping the walk at "no command
    // line" would report `unconfirmed` — which PROCEEDS — for a wrapper the OS has
    // already told us is python, and the reboot would then stop a server nothing
    // restarts. With the executable known, the walk carries on past it and reaches
    // the top of the tree, which is the honest answer.
    desktopServer();
    __processControlTestHooks.setProcessIdentityResolver((pid) => {
      if (pid === 4321) return { startedAt: "5000", parentPid: 300 };
      if (pid === 300) {
        return {
          executablePath: "C:\\tools\\python.exe",
          startedAt: "2000",
          parentPid: 1,
        };
      }
      return undefined;
    });
    __processControlTestHooks.setParentPidResolver((pid) => {
      if (pid === 4321) return 300;
      if (pid === 300) return 1;
      return undefined;
    });
    __processControlTestHooks.setProcessExistsProbe(() => true);
    const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await restartComfyUI();

    expect(result.message).toMatch(/no Desktop app is still supervising it/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(killWasIssued()).toBe(false);
  });

  it("recognises a macOS app-bundle shell whose path contains a space", async () => {
    // `ps -o command=` joins argv with spaces, so "Comfy Desktop.app" cannot be
    // tokenised back out — and if the shell went unrecognised the walk would carry on
    // past it to launchd and report a working install ABANDONED, refusing a restart
    // that works. It is recognised by POSITION instead: argv[0] opens the line, and
    // the directory prefix before the app name has no spaces.
    desktopServer();
    const BUNDLE =
      "/Applications/Comfy Desktop.app/Contents/MacOS/Comfy Desktop --no-sandbox";
    __processControlTestHooks.setProcessIdentityResolver((pid) => {
      if (pid === 4321) return { startedAt: "5000", parentPid: 300 };
      if (pid === 300) {
        return {
          commandLine: BUNDLE,
          // Truncated at the first space, exactly as the tokeniser must leave it.
          argv: ["/Applications/Comfy"],
          startedAt: "2000",
          parentPid: 1,
        };
      }
      return undefined;
    });
    // The shell's own parent is launchd, so a failure to recognise the shell does
    // NOT land in a harmless "unconfirmed": the walk reaches the top of the tree and
    // reports a perfectly healthy install ABANDONED. That is what makes this test
    // about the recognition rather than about the walk stopping early.
    __processControlTestHooks.setParentPidResolver((pid) => {
      if (pid === 4321) return 300;
      if (pid === 300) return 1;
      return undefined;
    });
    __processControlTestHooks.setProcessExistsProbe(() => true);
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await restartComfyUI();

    expect(result.message).not.toMatch(/refusing to restart/i);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("a shim living INSIDE the bundle is not the bundle's shell", async () => {
    // The accidental sibling of the two forgeries the gate already caught. Accepting
    // any binary under `Contents/MacOS/` meant a launcher script or venv python that
    // happens to live inside the app bundle was read as the Electron shell — and a
    // shim re-execs nothing, so the reboot would stop a server nothing restarts. The
    // bundle's MAIN binary is named after the bundle; a shim is not.
    desktopServer();
    __processControlTestHooks.setProcessIdentityResolver((pid) => {
      if (pid === 4321) return { startedAt: "5000", parentPid: 300 };
      if (pid === 300) {
        return {
          commandLine:
            "/Applications/Comfy Desktop.app/Contents/MacOS/python launch.py --port 8188",
          startedAt: "2000",
          parentPid: 1,
        };
      }
      return undefined;
    });
    __processControlTestHooks.setParentPidResolver((pid) => {
      if (pid === 4321) return 300;
      if (pid === 300) return 1;
      return undefined;
    });
    __processControlTestHooks.setProcessExistsProbe(() => true);
    const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await restartComfyUI();

    expect(result.message).toMatch(/refusing to restart/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(killWasIssued()).toBe(false);
  });

  it("a shim inside the bundle is rejected on the AUTHENTICATED path too", async () => {
    // The same rule has to hold wherever the executable comes from. Here the OS names
    // the binary outright — and it is a python living in the bundle's MacOS dir, not
    // the bundle's own binary. A check that accepted any path through
    // `Contents/MacOS/` would call it the shell on the strength of authenticated
    // evidence, which is worse than doing it on a guess.
    desktopServer();
    __processControlTestHooks.setProcessIdentityResolver((pid) => {
      if (pid === 4321) return { startedAt: "5000", parentPid: 300 };
      if (pid === 300) {
        return {
          commandLine: "(unreadable)",
          executablePath: "/Applications/Comfy Desktop.app/Contents/MacOS/python",
          startedAt: "2000",
          parentPid: 1,
        };
      }
      return undefined;
    });
    __processControlTestHooks.setParentPidResolver((pid) => {
      if (pid === 4321) return 300;
      if (pid === 300) return 1;
      return undefined;
    });
    __processControlTestHooks.setProcessExistsProbe(() => true);
    const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await restartComfyUI();

    expect(result.message).toMatch(/no Desktop app is still supervising it/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the bundle's OWN binary on the authenticated path IS the shell", async () => {
    // The control for the two rejections above: the real thing must still be
    // recognised, or macOS Desktop users lose the restart entirely.
    desktopServer();
    __processControlTestHooks.setProcessIdentityResolver((pid) => {
      if (pid === 4321) return { startedAt: "5000", parentPid: 300 };
      if (pid === 300) {
        return {
          commandLine: "(unreadable)",
          executablePath:
            "/Applications/Comfy Desktop.app/Contents/MacOS/Comfy Desktop",
          startedAt: "2000",
          parentPid: 1,
        };
      }
      return undefined;
    });
    __processControlTestHooks.setParentPidResolver((pid) => {
      if (pid === 4321) return 300;
      if (pid === 300) return 1;
      return undefined;
    });
    __processControlTestHooks.setProcessExistsProbe(() => true);
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await restartComfyUI();

    expect(result.message).not.toMatch(/refusing to restart/i);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("an Electron HELPER inside the bundle is not the shell either", async () => {
    // Helpers live at `<App>.app/Contents/Frameworks/<Helper>.app/Contents/MacOS/…`,
    // so the bundle naming the path is not the one followed by `Contents/MacOS`. They
    // are excluded structurally rather than by a name blocklist.
    desktopServer();
    __processControlTestHooks.setProcessIdentityResolver((pid) => {
      if (pid === 4321) return { startedAt: "5000", parentPid: 300 };
      if (pid === 300) {
        return {
          commandLine:
            "/Applications/Comfy Desktop.app/Contents/Frameworks/Comfy Desktop Helper.app" +
            "/Contents/MacOS/Comfy Desktop Helper --type=renderer",
          startedAt: "2000",
          parentPid: 1,
        };
      }
      return undefined;
    });
    __processControlTestHooks.setParentPidResolver((pid) => {
      if (pid === 4321) return 300;
      if (pid === 300) return 1;
      return undefined;
    });
    __processControlTestHooks.setProcessExistsProbe(() => true);
    const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await restartComfyUI();

    expect(result.message).toMatch(/refusing to restart/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a WRAPPER that merely mentions the Desktop install is not a supervisor", async () => {
    // A Desktop BACKEND identifies itself by carrying `--extra-model-paths-config
    // …/Comfy Desktop/…`. Testing a candidate supervisor with that same rule would
    // let any wrapper passing that flag stand in for the Electron shell — and a
    // wrapper cannot re-exec anything, so the reboot would still lose the server
    // (codex gate). The supervisor test requires the Desktop BINARY.
    desktopServer();
    __processControlTestHooks.setProcessIdentityResolver((pid) => {
      if (pid === 4321) return { startedAt: "5000", parentPid: 300 };
      if (pid === 300) {
        return {
          // Mentions the Desktop install, but is python — not the Electron shell.
          commandLine:
            "python.exe wrapper.py --extra-model-paths-config " +
            "C:\\Users\\u\\AppData\\Roaming\\Comfy Desktop\\shared_model_paths.yaml",
          startedAt: "2000",
          parentPid: 1,
        };
      }
      return undefined;
    });
    __processControlTestHooks.setParentPidResolver((pid) => {
      if (pid === 4321) return 300;
      if (pid === 300) return 1; // the wrapper's own parent is gone
      return undefined;
    });
    __processControlTestHooks.setProcessExistsProbe(() => true);
    const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await restartComfyUI();

    expect(result.message).toMatch(/no Desktop app is still supervising it/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(killWasIssued()).toBe(false);
  });

  it("an UNREADABLE process tree REFUSES the reboot, and names what it could not establish", async () => {
    // THE POLICY, and it is the inverse of the one that governs `listener_ownership`.
    //
    // There, `unconfirmed` keeps `started: true` because the launch has ALREADY
    // HAPPENED and only its description is uncertain — denying it would turn an
    // uncertain description into a false one, so uncertainty is DISCLOSED.
    //
    // A reboot has NOT happened yet and cannot be undone. "I could not establish that
    // anything will restart this" is uncertainty about whether the user still has a
    // ComfyUI afterwards, so it is REFUSED. Refuse before, disclose after.
    //
    // The chain here is exactly the dangerous shape: a Desktop parent that HAS
    // departed, on a host where the probe cannot say so. Proceeding would stop an
    // orphaned backend that nothing relaunches — #814 recurring through a gap in the
    // evidence rather than through a gap in the check.
    desktopServer();
    __processControlTestHooks.setProcessIdentityResolver((pid) =>
      pid === 4321 ? { startedAt: "5000", parentPid: 300 } : undefined,
    );
    __processControlTestHooks.setParentPidResolver((pid) => (pid === 4321 ? 300 : undefined));
    // The parent is gone, but this host cannot establish that either way.
    __processControlTestHooks.setProcessExistsProbe(() => undefined);
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/refusing to restart/i);
    // The refusal SAYS what it failed to establish — a bare "unconfirmed" would leave
    // the user with nothing to act on.
    expect(result.message).toMatch(
      /could not be established whether PID 300 .* is still running/i,
    );
    expect(result.message).toMatch(/still running \(not stopped\)|left running/i);
    // CRITICAL: nothing was dispatched and nothing was killed.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(killWasIssued()).toBe(false);
  });

  it("#400 is not disturbed: the refusal leaves the server RUNNING, it never kills it", async () => {
    // The claim this policy had to be separated from. #400 established that a Desktop
    // process must never be KILLED locally, because respawning the exe does not
    // reliably bring the listener back. Refusing an unverified Manager stop does not
    // touch that: the server stays up and the user is pointed at the app that
    // restarts it reliably.
    desktopServer();
    __processControlTestHooks.setProcessIdentityResolver((pid) =>
      pid === 4321 ? { startedAt: "5000" } : undefined,
    );
    __processControlTestHooks.setParentPidResolver(() => undefined);
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await restartComfyUI();

    expect(result.message).toMatch(/refusing to restart/i);
    expect(result.message).toMatch(/Restart it from the ComfyUI Desktop app/i);
    expect(killWasIssued()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a wedged DESKTOP instance is recognised from the OS command line and never killed", async () => {
    // With no answer from the server, `isDesktopApp` used to see an empty argv and
    // classify a Desktop instance as an ordinary Python install — which routes to
    // KILL + relaunch, the one thing #400 exists to prevent. The OS knows what it is.
    mockGetSystemStats.mockRejectedValue(new Error("fetch failed"));
    mockLivePortThenFree();
    __processControlTestHooks.setProcessIdentityResolver((pid) =>
      pid === 4321
        ? {
            startedAt: "stable-stamp",
            commandLine: DESKTOP_ARGV.join(" "),
            argv: DESKTOP_ARGV,
            parentPid: 300,
          }
        : undefined,
    );
    __processControlTestHooks.setParentPidResolver((pid) => (pid === 4321 ? 300 : undefined));
    __processControlTestHooks.setProcessExistsProbe((pid) => (pid === 300 ? false : true));
    const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await restartComfyUI();

    // It took the Desktop path (and refused there, since the shell is gone) rather
    // than the kill+relaunch path.
    expect(result.message).toMatch(/no Desktop app is still supervising it/i);
    expect(killWasIssued()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The out-of-band preflight — the door beside the gate
// ---------------------------------------------------------------------------

describe("preflightLocalRestart — an instance we cannot identify is not a pass", () => {
  it("REFUSES when the local ComfyUI cannot be resolved at all", async () => {
    // The widened gate had a door beside it: a local instance whose listener cannot
    // be attributed — a container with no `lsof`, a permission wall, no `/proc` —
    // resolves to NOTHING here, and `!info` returned ok:true. The preflight
    // "assessed" it, passed, and the Manager reboot went out without anyone having
    // checked whether a supervisor was still there: the container/permission form of
    // the same #814 loss.
    //
    // Modelled as probes that cannot RUN (which is "I could not look") and a server
    // that does not answer.
    mockGetSystemStats.mockRejectedValue(new Error("fetch failed"));
    mockExecSync.mockImplementation((cmd: string) => {
      if (/netstat|lsof|tasklist|pgrep|powershell/i.test(String(cmd))) {
        throw new Error("command not found");
      }
      return "";
    });

    const result = await preflightLocalRestart();

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not be identified/i);
    // It says what it could not establish rather than asserting something is wrong.
    expect(result.reason).toMatch(/could not be established that stopping it/i);
  });

  it("REFUSES when the only Desktop app found was located by scanning process names", async () => {
    // Round-9 gate. When the port cannot be attributed, acquireProcessInfo falls back
    // to the first Desktop process on the machine — bound to no port and no backend.
    // Treating it as the supervisor let an unrelated Desktop window (a reopened app,
    // a second install) authorize stopping an orphaned backend it has never heard of:
    // the same lost server by a new route.
    //
    // Modelled as: the server does not answer, no port owner can be resolved, and a
    // Desktop process IS found by name.
    mockGetSystemStats.mockRejectedValue(new Error("fetch failed"));
    mockExecSync.mockImplementation((cmd: string) => {
      const c = String(cmd);
      // The port cannot be attributed at all.
      if (/netstat|lsof/i.test(c)) throw new Error("command not found");
      // …but a Desktop shell is running somewhere.
      if (/tasklist/i.test(c)) return '"Comfy Desktop.exe","900","Console","1","206,248 K"';
      if (/pgrep/i.test(c)) return "900\n";
      return "";
    });
    // Even a perfectly readable, live shell at that pid must not stand in.
    __processControlTestHooks.setProcessIdentityResolver((pid) =>
      pid === 900
        ? {
            executablePath: "C:\\Program Files\\Comfy Desktop\\Comfy Desktop.exe",
            startedAt: "1000",
          }
        : undefined,
    );
    __processControlTestHooks.setProcessExistsProbe(() => true);

    const result = await preflightLocalRestart();

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/scanning process names/i);
    expect(result.reason).toMatch(/nothing ties it to that port/i);
  });

  it("still PASSES a non-Desktop instance whose relaunch is validated", async () => {
    // The control: the refusal must be about missing evidence, not a blanket denial.
    // A reachable install with a resolvable launch command proceeds exactly as before.
    mockGetSystemStats.mockResolvedValue({
      system: { argv: [ABS_MAIN, "--port", "8188"] },
    });
    mockLivePortThenFree();
    __processControlTestHooks.setProcessIdentityResolver(() => ({
      startedAt: "stable-stamp",
    }));

    const result = await preflightLocalRestart();

    expect(result.ok).toBe(true);
  });
});
