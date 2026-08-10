// #1290 — A TEST THAT READS THE LIVE PROCESS TABLE AGREES WITH YOU ON THE
// MACHINES WHERE IT DOES NOT RUN.
//
// `resolveLiveInterpreter` shells out (netstat/WMI) to find whichever python is
// really serving the port ON THE MACHINE RUNNING THE TEST. A test that reaches
// it decides its assertion by whether the developer happens to have ComfyUI up.
//
// That is what #1263 was: `download-manager-routing > #420` failed on a clean
// origin/main locally while CI reported success for the same SHA. With ComfyUI
// running, a relative `main.py` argv anchored onto the live interpreter and the
// case routed local instead of to the Manager; on CI nothing was listening, the
// probe found nothing, and the identical test passed. It survived every CI run.
//
// The failure mode is not a red test. It is a test that SILENTLY STOPS TESTING —
// and CI cannot warn you, because CI is one of the machines where it passes.
//
// So this gate is not a list of files someone typed. It COMPUTES which exported
// functions reach the probe and which test files touch them, and fails when a
// file joins that set without stubbing. A hand-written list is exactly what
// rotted: the eight files named in #1263's commit message were partly wrong, and
// this computation disagrees with four of them.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const ALL_TS = walk(SRC);
const PRODUCT = ALL_TS.filter((p) => !p.includes("__tests__"));
const TESTS = ALL_TS.filter((p) => p.includes("__tests__"));

/** The exported function enclosing a given call, so entry points are derived
 *  from the code rather than restated here (and cannot drift when one is
 *  renamed). */
function enclosingExports(file: string, callee: string): string[] {
  const lines = readFileSync(file, "utf-8").split("\n");
  const found: string[] = [];
  let current: string | undefined;
  for (const line of lines) {
    const m = /^export (?:async )?function ([A-Za-z0-9_]+)/.exec(line);
    if (m) current = m[1];
    // END the function at a column-0 closing brace. Without this the tracker
    // never resets, so every call BELOW the last exported function in a file is
    // attributed to it — which pulled `getEnvironment`, `loadManifestFile` and
    // `updateComfyUICore` into the entry set and flagged two innocent test
    // files. A gate that cries wolf is a list people learn to edit, not read.
    else if (line.startsWith("}")) current = undefined;
    if (current && line.includes(`${callee}(`) && !line.trimStart().startsWith("*")) {
      found.push(current);
    }
  }
  return [...new Set(found)];
}

/** Everything that can reach the process probe: its direct callers, then the
 *  exported functions that call THOSE. Two hops is what the real graph needs
 *  today; a third would only widen the set, and the assertion below is about a
 *  set GROWING, so a miss shows up as a new unstubbed file rather than silence. */
function reachingEntryPoints(): string[] {
  const direct = new Set<string>();
  for (const file of PRODUCT) {
    for (const fn of enclosingExports(file, "resolveLiveInterpreter")) direct.add(fn);
  }
  // `observeLivePython` is module-private, so its exported caller is the entry.
  direct.add("resolveLiveServerRoot");

  const hop2 = new Set<string>();
  for (const file of PRODUCT) {
    const lines = readFileSync(file, "utf-8").split("\n");
    let current: string | undefined;
    for (const line of lines) {
      const m = /^export (?:async )?function ([A-Za-z0-9_]+)/.exec(line);
      if (m) current = m[1];
      else if (line.startsWith("}")) current = undefined;
      if (!current || line.trimStart().startsWith("*")) continue;
      for (const d of direct) if (line.includes(`${d}(`)) hop2.add(current);
    }
  }
  return [...new Set([...direct, ...hop2])];
}

/**
 * A test file that can actually REACH the probe.
 *
 * Two ways to be exempt, and the second is the difference between reaching the
 * code and merely naming it:
 *
 *  1. the probe itself is stubbed (`vi.mock` of live-interpreter);
 *  2. every entry point the file names is REPLACED by it — `getEnvironment:
 *     vi.fn()` in a mock factory means the real one never runs, so no process
 *     table is ever read.
 *
 * The first version of this gate had only (1) and flagged two innocent files
 * that mock `getEnvironment` outright. A gate that cries wolf is a list people
 * learn to edit rather than read, so its false-positive direction matters as
 * much as its false-negative one.
 */
function unstubbedTests(): string[] {
  const entries = reachingEntryPoints();
  const out: string[] = [];
  for (const file of TESTS) {
    const s = readFileSync(file, "utf-8");
    if (s.includes("live-interpreter")) continue;
    const reaches = entries.some(
      (e) =>
        new RegExp(`\\b${e}\\b`).test(s) &&
        // Redefined as a property → this file supplies its own implementation.
        !new RegExp(`^\\s*${e}\\s*:`, "m").test(s),
    );
    if (!reaches) continue;
    out.push(file.slice(SRC.length).replace(/\\/g, "/"));
  }
  return out.sort();
}

/**
 * The files that read the live process table today. A RATCHET, not an allowlist:
 * the set may shrink freely, and any addition fails.
 *
 * Not fixed wholesale because eight passing files is a large diff with no
 * observable failure behind it — and each one needs its own judgement about what
 * the probe should return for the case it is testing, which is exactly the
 * thinking that produced #1263's two new cases.
 */
const KNOWN_UNSTUBBED = [
  "__tests__/orchestrator/late-mutation-e2e.test.ts",
];

describe("the live-process probe is stubbed in tests that reach it (#1290)", () => {
  it("finds the entry points by reading the code, not from a list", () => {
    // If this ever comes back empty the gate is inert, and every assertion below
    // would pass while checking nothing.
    const entries = reachingEntryPoints();
    expect(entries).toContain("resolveLiveServerRoot");
    expect(entries).toContain("gatherEnvCapabilities");
    expect(entries.length, "the graph walk found nothing — the gate is dead").toBeGreaterThan(2);
  });

  it("NO NEW test file reads the live process table", () => {
    const offenders = unstubbedTests().filter((f) => !KNOWN_UNSTUBBED.includes(f));
    expect(
      offenders,
      "These tests reach `resolveLiveInterpreter`, which shells out to find the python " +
        "actually serving the port on THIS machine — so they assert one thing where " +
        "ComfyUI is running and another where it is not, and CI cannot tell you (#1263). " +
        "Stub it at its module boundary:\n\n" +
        '  vi.mock("../../services/live-interpreter.js", async () => ({\n' +
        "    ...(await vi.importActual(\"../../services/live-interpreter.js\")),\n" +
        "    resolveLiveInterpreter: () => undefined,\n" +
        "  }));\n",
    ).toEqual([]);
  });

  it("the known list only shrinks — a fixed file must be removed from it", () => {
    // Otherwise the ratchet rusts: files get stubbed, the list keeps naming them,
    // and it stops describing anything.
    const current = unstubbedTests();
    const stale = KNOWN_UNSTUBBED.filter((f) => !current.includes(f));
    expect(stale, "these are stubbed now — delete them from KNOWN_UNSTUBBED").toEqual([]);
  });
});
