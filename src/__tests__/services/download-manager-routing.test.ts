import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for shouldDispatchDownloadToManager — the single routing decision
 * that keeps model downloads working after a panel/orchestrator RECONNECT drops
 * the effective ComfyUI base (#420). Distinct from #418 (base resolution at
 * START): here the base is LOST later, and a nominally-local (loopback) session
 * must fall back to the connected ComfyUI-Manager route — the same live server
 * list_local_models still reaches over HTTP — instead of throwing
 * "no local ComfyUI path configured".
 */

const hoisted = vi.hoisted(() => ({
  remote: false,
  base: undefined as string | undefined,
  stats: undefined as unknown,
  statsThrows: false,
  // Whether an argv-derived live root is present on THIS filesystem. A
  // Docker/forwarded loopback server's container path is not host-local → false.
  liveRootExists: true,
  /** #1263 — the interpreter the live-process probe "finds", instead of whatever
   *  is really running on the developer's machine. undefined = nothing found. */
  livePython: undefined as string | undefined,
  /** #1374 — the OS's own record of the running image, which is what the probe has
   *  to work with when the launcher spelled the interpreter relatively (the stock
   *  Windows portable bundle). undefined = the OS gave none either. */
  liveImage: undefined as string | undefined,
  /** The stub itself, created here so the spec can assert BY IDENTITY that this
   *  is the function in force, and count the calls the code under test makes to
   *  it (codex). Its behaviour is installed in `beforeEach`. */
  liveProcess: vi.fn() as ReturnType<typeof vi.fn>,
}));

// The live-root routing branch only streams local when the root exists locally.
vi.mock("node:fs", () => ({
  existsSync: () => hoisted.liveRootExists,
}));

// isRemoteMode is the first gate; keep every other real config export.
vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return { ...actual, isRemoteMode: () => hoisted.remote };
});

// resolveEffectiveComfyUIBase is the "do we have a local base?" gate. Control it
// directly so the test doesn't depend on the host's real workspace config / FS.
vi.mock("../../services/workspace-env.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/workspace-env.js")>(
    "../../services/workspace-env.js",
  );
  return { ...actual, resolveEffectiveComfyUIBase: () => hoisted.base };
});

// #1263 — THE PROCESS TABLE IS NOT A FIXTURE. `resolveLiveServerRoot` falls back
// to `observeLivePython()`, which calls `observeLiveServerProcess` — and that
// shells out to netstat/WMI to find whatever python is really serving the port
// on THIS machine. So on a developer box with ComfyUI running, a relative
// `main.py` argv anchors onto the live interpreter, a root resolves, the mocked
// `existsSync` says it exists, and the #420 case streams local instead of routing
// to the Manager. On CI nothing is listening, the probe finds nothing, and the
// same test passes.
//
// That is why this file passed every CI run while failing locally: the assertion
// depended on whether the machine running it happened to have a ComfyUI up.
// Stubbed to "found nothing" by default, which is the state these cases describe;
// `hoisted.livePython` / `hoisted.liveImage` opt a case into the other answers.
vi.mock("../../services/live-interpreter.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/live-interpreter.js")>(
    "../../services/live-interpreter.js",
  );
  // The stub is created in `vi.hoisted` and handed over here, so the spec can
  // assert BY IDENTITY that this is the function in force, and count the calls
  // the code under test makes to it (codex).
  return { ...actual, observeLiveServerProcess: hoisted.liveProcess };
});

// getSystemStats stands in for the connected server's /system_stats. getClient is
// pulled in transitively by model-resolver; stub it so the import doesn't fail.
vi.mock("../../comfyui/client.js", () => ({
  getClient: () => ({ fetchApi: vi.fn() }),
  // #385 — call sites moved from `client.fetchApi` to `comfyApiFetch`, which
  // returns a 4xx instead of throwing. Routed to the SAME spy so every
  // existing "which route did we ask for" assertion still pins the same thing.
  comfyApiFetch: (...a: unknown[]) => (vi.fn())(...(a as [string])),
  getSystemStats: vi.fn(async () => {
    if (hoisted.statsThrows) throw new Error("ECONNREFUSED");
    return hoisted.stats;
  }),
}));

import { observeLiveServerProcess } from "../../services/live-interpreter.js";
import { shouldDispatchDownloadToManager } from "../../services/model-resolver.js";

beforeEach(() => {
  hoisted.remote = false;
  hoisted.base = undefined;
  hoisted.stats = undefined;
  hoisted.statsThrows = false;
  hoisted.liveRootExists = true;
  hoisted.livePython = undefined;
  hoisted.liveImage = undefined;
  // The stub is a spy now (so its calls can be counted), so its behaviour has to
  // be (re)installed here rather than living in the mock factory.
  hoisted.liveProcess.mockReset();
  hoisted.liveProcess.mockImplementation(() => {
    if (hoisted.livePython) {
      return { python: hoisted.livePython, source: "process-table", pid: 4242, image: hoisted.liveImage };
    }
    // Only the OS image: the process was identified, but its argv[0] named no file
    // we could probe (#1374).
    if (hoisted.liveImage) return { pid: 4242, image: hoisted.liveImage };
    return undefined;
  });
});

// #1263 — THE STUB MUST BE PROVEN, NOT ASSUMED.
//
// Every case below depends on `resolveLiveInterpreter` returning what this file
// says it returns. If the mock ever stops intercepting — a vitest change, a path
// resolution difference, an import that reaches the module by another specifier —
// the stub goes INERT and these tests silently read the real process table again.
// The symptom is not an error: it is the #420 case receiving `false` on a machine
// with ComfyUI running, and passing on CI where nothing is listening. That is the
// original bug, and it recurred on 0.50.87 for a reporter whose vitest, OS and
// checkout all match a rig where it passes.
//
// The #1290 source gate asserts that a spec MENTIONS live-interpreter. It cannot
// see whether the mock takes effect. This can, and it fails with its own name on
// it rather than as a confusing routing assertion.
describe("the live-process stub is actually in force (#1263)", () => {
  it("the imported observeLiveServerProcess IS this file's stub, by identity", () => {
    // Identity, not behaviour (codex): a different implementation returning the
    // same two values would satisfy an output check.
    expect(
      observeLiveServerProcess,
      "vi.mock is not intercepting ../../services/live-interpreter.js — this file is " +
        "reading the REAL process table, so its assertions now depend on whether this " +
        "machine happens to have ComfyUI running (#1263).",
    ).toBe(hoisted.liveProcess);
  });

  it("and the CODE UNDER TEST reaches that same stub — not another copy", async () => {
    // The check that matters (codex): proving THIS file's import is mocked says
    // nothing about which module `shouldDispatchDownloadToManager` resolves. If
    // the SUT reached an unmocked copy — a different specifier, a duplicated
    // module instance — the identity check above would still pass while every
    // routing assertion silently consulted the real process table.
    //
    // The #420 shape is the one that must consult it: no local base, and a
    // RELATIVE main.py that can only be anchored via the live interpreter.
    hoisted.base = undefined;
    hoisted.stats = { system: { argv: ["main.py", "--listen"] } };
    await shouldDispatchDownloadToManager();

    expect(
      hoisted.liveProcess.mock.calls.length,
      "the routing code never called the stubbed probe, so it is resolving a DIFFERENT " +
        "copy of live-interpreter than this file mocked — the stub is inert for the " +
        "assertions that depend on it (#1263).",
    ).toBeGreaterThan(0);
  });

  it("the stub follows its fixture, so it is not merely returning undefined by luck", () => {
    // A real probe on a machine with no ComfyUI also returns undefined, so the
    // default proves nothing on its own.
    try {
      hoisted.livePython = "C:/probe/python.exe";
      expect(observeLiveServerProcess()).toMatchObject({
        python: "C:/probe/python.exe",
        pid: 4242,
      });
    } finally {
      // Restored here rather than left to beforeEach, so a failure above cannot
      // leave the fixture mutated for anything that runs before it (codex).
      hoisted.livePython = undefined;
    }
  });
});

describe("shouldDispatchDownloadToManager (#420 reconnect routing)", () => {
  it("REMOTE mode always dispatches to the Manager", async () => {
    hoisted.remote = true;
    // Even if a local base somehow resolves, remote wins (no local FS).
    hoisted.base = "/some/local/comfy";
    expect(await shouldDispatchDownloadToManager()).toBe(true);
  });

  it("streams LOCAL when a local base is resolvable (COMFYUI_PATH / default workspace)", async () => {
    hoisted.base = "/home/me/ComfyUI";
    expect(await shouldDispatchDownloadToManager()).toBe(false);
  });

  it("#420: no local base + reachable server WITHOUT --base-directory → Manager route", async () => {
    // The reconnect case: base lost, but the live server is still connected. It
    // was NOT launched with --base-directory, so there's no local dir to stream
    // to — hand the fetch to its Manager rather than failing.
    hoisted.base = undefined;
    hoisted.stats = { system: { argv: ["main.py", "--listen"] } };
    expect(await shouldDispatchDownloadToManager()).toBe(true);
  });

  it("#463: no local base + reachable server whose ABSOLUTE main.py root is resolvable → streams local", async () => {
    // A panel-connected local ComfyUI with no COMFYUI_PATH/default, launched with
    // an absolute main.py path and NO --base-directory. Its own install root is
    // derivable from argv (the same live-first root resolveModelsDir writes into),
    // so stream locally into it instead of bouncing through the Manager (which
    // would fail when Manager isn't installed).
    hoisted.base = undefined;
    hoisted.stats = {
      system: { argv: ["python", "/opt/ComfyUI/main.py", "--listen"] },
    };
    expect(await shouldDispatchDownloadToManager()).toBe(false);
  });

  it("no local base + reachable server whose absolute main.py root is NOT present locally (Docker/forwarded) → Manager route", async () => {
    // Container-side main.py path resolvable but not on the host FS — must NOT be
    // treated as a local stream target (would create a bogus host dir); route the
    // fetch through the connected Manager (server-side write) instead.
    hoisted.base = undefined;
    hoisted.liveRootExists = false;
    hoisted.stats = { system: { argv: ["python", "/app/ComfyUI/main.py"] } };
    expect(await shouldDispatchDownloadToManager()).toBe(true);
  });

  it("no local base + reachable server WITH --base-directory → still streams local", async () => {
    // Desktop install advertises its real base dir via argv; that dir is on this
    // same (loopback) filesystem, so keep the local streaming path.
    hoisted.base = undefined;
    hoisted.stats = {
      system: { argv: ["main.py", "--base-directory", "/data/ComfyUI"] },
    };
    expect(await shouldDispatchDownloadToManager()).toBe(false);
  });

  it("no local base + UNREACHABLE server → stays local so the resolver throws a clear error", async () => {
    hoisted.base = undefined;
    hoisted.statsThrows = true;
    expect(await shouldDispatchDownloadToManager()).toBe(false);
  });

  it("routes to Manager for a RELATIVE --base-directory with no server cwd — EVEN with COMFYUI_PATH set", async () => {
    // The server's real models dir is unknown (relative flag, no reported cwd); a
    // local write to COMFYUI_PATH/models would be the WRONG place, so the server-side
    // Manager fetch must win over the local base short-circuit (codex).
    hoisted.base = "/home/me/ComfyUI";
    hoisted.stats = { system: { argv: ["python", "main.py", "--base-directory", "data"] } };
    expect(await shouldDispatchDownloadToManager()).toBe(true);
  });

  it("routes to Manager for a RELATIVE --models-directory with no server cwd (no local base)", async () => {
    hoisted.base = undefined;
    hoisted.stats = { system: { argv: ["python", "main.py", "--models-directory", "models2"] } };
    expect(await shouldDispatchDownloadToManager()).toBe(true);
  });

  it("streams LOCAL for a relative flag that IS resolvable via the server cwd (base set)", async () => {
    hoisted.base = "/home/me/ComfyUI";
    hoisted.stats = {
      system: { argv: ["python", "main.py", "--base-directory", "data"], cwd: "/srv/live" },
    };
    expect(await shouldDispatchDownloadToManager()).toBe(false);
  });
  // #1263 — the OTHER side of the live-process probe, which was previously
  // decided by whatever happened to be running on the developer's machine and so
  // was never actually asserted. Now that the probe is a fixture, both answers
  // are reachable on purpose.
  it("no local base, but the LIVE interpreter anchors a real root → streams local", async () => {
    hoisted.base = undefined;
    // A relative main.py with no reported cwd: unresolvable from argv alone, so
    // the decision falls to the live-process probe.
    hoisted.stats = { system: { argv: ["main.py", "--listen"] } };
    hoisted.livePython = "/opt/comfy/.venv/bin/python";
    hoisted.liveRootExists = true;

    expect(await shouldDispatchDownloadToManager()).toBe(false);
  });

  it("...and routes to the Manager when that anchored root is NOT on this filesystem", async () => {
    // A container/forwarded server: the probe reports a python, but its root is a
    // path that does not exist here, so there is nothing local to stream into.
    hoisted.base = undefined;
    hoisted.stats = { system: { argv: ["main.py", "--listen"] } };
    hoisted.livePython = "/opt/comfy/.venv/bin/python";
    hoisted.liveRootExists = false;

    expect(await shouldDispatchDownloadToManager()).toBe(true);
  });

  // #1374 — THE ROUTE, not just the anchor. A LOCAL Windows install could download
  // nothing: no COMFYUI_PATH, a relative `main.py` with no cwd, and a launcher that
  // spelled the interpreter relatively (`.\python_embeded\python.exe`, or a bare
  // `python` from an activated venv). argv[0] then named no file, the probe reported
  // no interpreter, no root resolved, and every download was handed to a
  // ComfyUI-Manager that was not serving its routes — a hard failure for a capability
  // that needs no Manager at all.
  //
  // This is the decision that has to change, so it is asserted here and not only on
  // the resolver: the OS image is enough to keep the download LOCAL.
  it("#1374: no local base + a probe that could only report the OS IMAGE → streams local", async () => {
    hoisted.base = undefined;
    hoisted.stats = { system: { argv: ["main.py", "--windows-standalone-build"] } };
    hoisted.livePython = undefined; // relative argv[0] — no interpreter answer
    hoisted.liveImage = "/portable/python_embeded/python.exe";
    hoisted.liveRootExists = true;

    expect(await shouldDispatchDownloadToManager()).toBe(false);
  });

  it("#1374: an OS image whose anchored root is NOT on this filesystem still routes to Manager", async () => {
    // The image is a weaker reading, not a privileged one: it earns a LOCAL route on
    // exactly the same evidence an interpreter does, and no more.
    hoisted.base = undefined;
    hoisted.stats = { system: { argv: ["main.py", "--windows-standalone-build"] } };
    hoisted.liveImage = "/portable/python_embeded/python.exe";
    hoisted.liveRootExists = false;

    expect(await shouldDispatchDownloadToManager()).toBe(true);
  });
});
