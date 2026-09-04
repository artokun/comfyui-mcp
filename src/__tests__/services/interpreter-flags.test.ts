// #2693 — a relaunch dropped the Python interpreter flags.
//
// The reporter's portable install launches with `-s` (ignore user site-packages).
// `relaunchArgv` rebuilds from the server's own `sys.argv`, and CPython consumes
// `-s` before `sys.argv` exists — so it is structurally absent there, and the
// relaunched server imported from a different package set than the one that was
// running. Same for `-E`, `-I`, `-B`, `-O`, `-u`.
//
// The OS's view of the same process does carry them. Taking them from there is only
// sound with the identity binding that makes `sys.argv` the preferred source in the
// first place, so recovery REFUSES unless the OS reading is exact AND names the same
// script — the same file from two independent sources.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  interpreterFlagsFromOsArgv,
  __processControlTestHooks,
} from "../../services/process-control.js";

const SCRIPT = "C:/ComfyUI/main.py";
const PY = "C:/ComfyUI/python_embeded/python.exe";

describe("#2693 interpreter flags are recovered from the OS argv", () => {
  it("recovers -s, which sys.argv can never contain", () => {
    expect(
      interpreterFlagsFromOsArgv({
        argv: [SCRIPT, "--listen"],
        osArgv: [PY, "-s", SCRIPT, "--listen"],
        osArgvExact: true,
      }),
    ).toEqual(["-s"]);
  });

  it("recovers several, in order", () => {
    expect(
      interpreterFlagsFromOsArgv({
        argv: [SCRIPT],
        osArgv: [PY, "-s", "-E", "-u", SCRIPT],
        osArgvExact: true,
      }),
    ).toEqual(["-s", "-E", "-u"]);
  });

  it("matches across separator and case ON WINDOWS, and only there", () => {
    // The OS reports a backslash path on Windows; /system_stats often reports the
    // same file with forward slashes. Failing to corroborate on that alone would
    // silently recover nothing on the one platform this report comes from.
    //
    // But the fold is a WINDOWS rule. This case previously asserted ["-s"] on every
    // host, which is wrong on Linux — /ComfyUI/main.py and /comfyui/MAIN.PY are two
    // different files there, and a backslash is a legal filename character, so
    // corroborating them would splice flags out of another process's command line.
    // Reachable: argvFidelity "exact" is set on the /proc/<pid>/cmdline path too.
    //
    // The old expectation passed locally on Windows and failed on the Linux runner,
    // which is how it surfaced.
    expect(
      interpreterFlagsFromOsArgv({
        argv: ["C:/ComfyUI/main.py"],
        osArgv: [PY, "-s", ["C:", "ComfyUI", "MAIN.PY"].join(String.fromCharCode(92))],
        osArgvExact: true,
      }),
    ).toEqual(process.platform === "win32" ? ["-s"] : []);
  });

  it("corroborates an EXACT POSIX path on any host", () => {
    // The separator/case fold is the only thing that is host-specific; an exact
    // match must still work everywhere, so the change above cannot have disabled
    // recovery on Linux wholesale.
    expect(
      interpreterFlagsFromOsArgv({
        argv: ["/opt/ComfyUI/main.py"],
        osArgv: ["/usr/bin/python3", "-s", "/opt/ComfyUI/main.py"],
        osArgvExact: true,
      }),
    ).toEqual(["-s"]);
  });
});

describe("#2693 recovery refuses without the identity binding", () => {
  it("takes nothing when the OS reading is not EXACT", () => {
    // A flattened command line is not a command: the quoting is unknowable, so any
    // split is a guess.
    expect(
      interpreterFlagsFromOsArgv({
        argv: [SCRIPT],
        osArgv: [PY, "-s", SCRIPT],
        osArgvExact: false,
      }),
    ).toEqual([]);
  });

  it("takes nothing when the OS argv names a DIFFERENT script", () => {
    // Without corroboration this could be a recycled pid running something else --
    // the exact hazard that makes sys.argv the preferred source.
    expect(
      interpreterFlagsFromOsArgv({
        argv: [SCRIPT],
        osArgv: [PY, "-s", "C:/Other/main.py"],
        osArgvExact: true,
      }),
    ).toEqual([]);
  });

  it("takes NOTHING when an UNMODELLED flag carries a separate value", () => {
    // My first version filtered to tokens starting with "-" and returned
    // ["-X", "-s"] — which rebuilds as `python -X -s main.py`, where -X swallows
    // -s. Dropping a value while keeping its flag is worse than either alternative,
    // so an unmodellable command line is not rebuilt at all.
    //
    // NARROWED, not relaxed. This used to assert the same of `-X utf8`, on the
    // grounds that modelling the CPython option table is not something to
    // hand-roll. That holds for the table at large and NOT for -X and -W, which
    // always consume the next token — there is no ambiguity left to hand-roll.
    // And the old rule's cost was measured on a REAL Windows command line:
    // `-X utf8`, the encoding flag this issue is about, was the one flag a
    // relaunch dropped. Those two are modelled now; everything else still refuses.
    expect(
      interpreterFlagsFromOsArgv({
        argv: [SCRIPT],
        osArgv: [PY, "--jit", "yes", SCRIPT],
        osArgvExact: true,
      }),
    ).toEqual([]);
  });

  it("still takes a run of plain flags", () => {
    // The neighbour that must keep working: no bare token, nothing ambiguous.
    expect(
      interpreterFlagsFromOsArgv({
        argv: [SCRIPT],
        osArgv: [PY, "-s", "-E", SCRIPT],
        osArgvExact: true,
      }),
    ).toEqual(["-s", "-E"]);
  });

  it("takes nothing when there is nothing before the script", () => {
    expect(
      interpreterFlagsFromOsArgv({ argv: [SCRIPT], osArgv: [PY, SCRIPT], osArgvExact: true }),
    ).toEqual([]);
  });

  it("takes nothing when the server reported no argv at all", () => {
    // That path already falls back to the OS argv wholesale; there is nothing to
    // merge into.
    expect(
      interpreterFlagsFromOsArgv({ argv: [], osArgv: [PY, "-s", SCRIPT], osArgvExact: true }),
    ).toEqual([]);
  });
});

describe("#2693 relaunchArgv actually re-attaches them", () => {
  // The helper tests above all passed with the recovery severed from relaunchArgv --
  // extraction covered, re-attachment not. That is the half a relaunch uses.
  const { relaunchArgv } = __processControlTestHooks;

  it("splices the flags between the script and its arguments", () => {
    const out = relaunchArgv({
      argv: [SCRIPT, "--listen", "0.0.0.0"],
      osArgv: [PY, "-s", SCRIPT, "--listen", "0.0.0.0"],
      osArgvExact: true,
    } as never);
    expect(out).toEqual([SCRIPT, "-s", "--listen", "0.0.0.0"]);
  });

  it("returns sys.argv UNCHANGED when there is nothing to recover", () => {
    // The ordinary case must be byte-identical to before this existed.
    const argv = [SCRIPT, "--listen"];
    expect(relaunchArgv({ argv, osArgv: [PY, SCRIPT], osArgvExact: true } as never)).toEqual(argv);
    expect(relaunchArgv({ argv } as never)).toEqual(argv);
  });
});

// `-X` and `-W` are the only interpreter options that plausibly appear on a ComfyUI
// launch AND always consume the next token, so taking them as pairs is the one part
// of CPython's option table with no ambiguity in it.
//
// This is not a hypothetical shape. Captured from a real Windows process via
// Win32_Process.CommandLine while writing these:
//
//     "C:\Users\...\python.exe" -X utf8 -s C:\...\main.py
//
// and before the pair handling it reconstructed to [] — so the encoding flag #2693
// is ABOUT was precisely the one a relaunch dropped. Restart, and the CP949
// workaround the user started the server with is gone.
describe("#2693 a value-taking interpreter flag survives the relaunch", () => {
  const SCRIPT = "C:/x/main.py";
  const PY = "C:/py/python.exe";
  const recover = (osArgv: string[]) =>
    interpreterFlagsFromOsArgv({ argv: [SCRIPT], osArgv, osArgvExact: true });

  it("keeps -X and its value, alongside ordinary flags", () => {
    expect(recover([PY, "-X", "utf8", "-s", SCRIPT])).toEqual(["-X", "utf8", "-s"]);
    expect(recover([PY, "-X", "utf8", SCRIPT])).toEqual(["-X", "utf8"]);
    expect(recover([PY, "-W", "once", SCRIPT])).toEqual(["-W", "once"]);
  });

  it("leaves the joined form alone — it was never a bare token", () => {
    expect(recover([PY, "-Xutf8", SCRIPT])).toEqual(["-Xutf8"]);
  });

  // The bail-out is the safety property and must not have widened: a flag whose
  // value belongs to an option this code does NOT model still reconstructs nothing,
  // because keeping the flag and dropping its value would rebuild a command the
  // server never had.
  it("still refuses every shape it cannot model", () => {
    expect(recover([PY, "--jit", "yes", SCRIPT])).toEqual([]);
    expect(recover([PY, "-X", SCRIPT])).toEqual([]);
    expect(recover([PY, "-X", "-s", SCRIPT])).toEqual([]);
  });
});

describe("#2693 script corroboration is HOST-AWARE", () => {
  // The comparison folded case and rewrote backslashes on every platform. That is
  // correct on Windows and wrong on Linux, where /ComfyUI/main.py and
  // /comfyui/main.py are different files and a backslash is a legal filename
  // character — so two DIFFERENT scripts could corroborate and splice interpreter
  // flags out of a command line belonging to something else.
  //
  // Reachable: argvFidelity "exact" is also set on the Linux /proc/<pid>/cmdline
  // path (live-interpreter.ts), where the kernel NUL-separates argv. Only the `ps`
  // fallback is "flattened".
  it("uses the module's own host-aware path rule, not a restated one", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../services/process-control.ts", import.meta.url)),
      "utf8",
    );
    const i = src.indexOf("export function interpreterFlagsFromOsArgv");
    expect(i).toBeGreaterThan(-1);
    const fn = src.slice(i, i + 2600);
    expect(fn).toMatch(/sameRecoveryPath\(tok, script\)/);
    // The regression: an unconditional lowercase/backslash fold inside this function.
    expect(fn).not.toMatch(/\.toLowerCase\(\) ===/);
  });

  it("still corroborates a Windows argv that differs only in case and separator", () => {
    // normalizeRecoveryPath folds case and separators on win32, so this must keep
    // working there; off win32 the same input is legitimately two different files.
    const script = "ComfyUI" + String.fromCharCode(92) + "main.py";
    const osArgv = ["C:/py/python.exe", "-s", "comfyui/MAIN.PY", "--listen"];
    const flags = interpreterFlagsFromOsArgv({ argv: [script, "--listen"], osArgv, osArgvExact: true });
    expect(flags).toEqual(process.platform === "win32" ? ["-s"] : []);
  });
});
