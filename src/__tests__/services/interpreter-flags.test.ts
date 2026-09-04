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

import { describe, expect, it } from "vitest";
import { interpreterFlagsFromOsArgv } from "../../services/process-control.js";

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

  it("matches the script across separator and case differences", () => {
    // The OS reports a backslash path on Windows; /system_stats often reports the
    // same file with forward slashes. Failing to corroborate on that alone would
    // silently recover nothing on the one platform this report comes from.
    expect(
      interpreterFlagsFromOsArgv({
        argv: ["C:/ComfyUI/main.py"],
        osArgv: [PY, "-s", ["C:", "ComfyUI", "MAIN.PY"].join(String.fromCharCode(92))],
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

  it("takes only FLAGS, never a bare value", () => {
    // A bare token before the script is an argument to a flag this code does not
    // model; copying it blind invents a command the server never had.
    expect(
      interpreterFlagsFromOsArgv({
        argv: [SCRIPT],
        osArgv: [PY, "-X", "utf8", "-s", SCRIPT],
        osArgvExact: true,
      }),
    ).toEqual(["-X", "-s"]);
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
