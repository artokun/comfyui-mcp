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

/**
 * A host-reaching primitive: something a test can call that answers differently
 * depending on what is running on the machine executing it.
 *
 * #1263 was filed for ONE of these and the gate was written around it by name. There
 * is more than one, which is the whole point — `restart-live-first.test.ts` passed here
 * and failed on all three CI runners because `gatherProcessInfo` reaches
 * `acquireInstanceWitness`, which opens a REAL WebSocket to COMFYUI_URL. This rig has a
 * ComfyUI on 8188; CI has nothing. Same defect as the process probe, different coat,
 * and a gate hardcoded to the first could not see it.
 *
 * Adding one here is now a three-line change rather than a rewrite, which matters
 * because the next channel will not be the last: a health probe over `fetch` cost a CI
 * failure on #1332 the same day, for the same reason.
 *
 * THAT THIRD CHANNEL IS DELIBERATELY ABSENT, and the reason is worth recording so the
 * next person does not re-derive it. Its probe (`probeComfyEndpoint`, reached through
 * the private `probeComfyHealth` / `probeDeclineRecovery` / `observeRecovery`) has
 * exactly ONE exported caller: `buildPanelToolDefs()`. Every panel tool is registered
 * inside it, so every panel test names it — gating on it would flag essentially the
 * whole suite, and a gate that cries wolf is a list people learn to edit rather than
 * read. It is stubbable (`__panelToolsTestHooks.setHealthProbe`), so the remedy exists;
 * what is missing is a way to attribute reachability to a TOOL rather than to the one
 * export that registers all 91 of them. That is what would have to change first.
 */
interface Probe {
  /** Short name used in failure output. */
  id: string;
  /** The function whose CALLERS are the entry points into this channel. */
  callee: string;
  /** Entry points the walk cannot see because the caller is module-private. */
  privateSeeds: string[];
  /** A substring proving the test stubbed this channel at its module boundary. */
  moduleHint: string;
  /** What the reader must do about it. */
  remedy: string;
  /** Entry points that must be found, so a broken walk fails loudly instead of
   *  silently gating nothing. */
  expectEntries: string[];
}

const PROBES: Probe[] = [
  {
    id: "live process table",
    callee: "resolveLiveInterpreter",
    // `observeLivePython` is module-private, so its exported caller is the entry.
    privateSeeds: ["resolveLiveServerRoot"],
    moduleHint: "live-interpreter",
    expectEntries: ["resolveLiveServerRoot", "gatherEnvCapabilities"],
    remedy:
      "`resolveLiveInterpreter` shells out to find the python actually serving the port " +
      "on THIS machine, so these assert one thing where ComfyUI is running and another " +
      "where it is not. Stub it at its module boundary:\n\n" +
      '  vi.mock("../../services/live-interpreter.js", async () => ({\n' +
      '    ...(await vi.importActual("../../services/live-interpreter.js")),\n' +
      "    resolveLiveInterpreter: () => undefined,\n" +
      "  }));\n",
  },
  {
    // #1374 — SAME MODULE, SECOND DOOR. The shell-out moved down into
    // `observeLiveServerProcess`, which reports the OS's own image record as well as
    // the interpreter, and `resolveLiveInterpreter` is now a wrapper around it. A
    // file that stubs only the wrapper (which six of them did, verbatim from the
    // remedy above) still reaches the real process table through the other export —
    // and the probe above cannot see that, because its `moduleHint` is satisfied by
    // any mention of the module. So this one is keyed on the FUNCTION NAME: a file
    // is exempt only if it actually names the export it has to replace.
    id: "live process table (uncollapsed observation)",
    callee: "observeLiveServerProcess",
    privateSeeds: ["resolveLiveServerRoot"],
    moduleHint: "observeLiveServerProcess",
    expectEntries: ["resolveLiveServerRoot", "resolveLiveInterpreter"],
    remedy:
      "`observeLiveServerProcess` is where the netstat/WMI shell-out now lives, and " +
      "`resolveLiveInterpreter` only wraps it — so stubbing the wrapper alone leaves " +
      "these reading the REAL process table. Stub BOTH:\n\n" +
      '  vi.mock("../../services/live-interpreter.js", async () => ({\n' +
      '    ...(await vi.importActual("../../services/live-interpreter.js")),\n' +
      "    resolveLiveInterpreter: () => undefined,\n" +
      "    observeLiveServerProcess: () => undefined,\n" +
      "  }));\n",
  },
  {
    id: "instance witness (real WebSocket)",
    callee: "acquireInstanceWitness",
    // Both call sites sit in NON-exported functions (`gatherProcessInfo`,
    // `restartViaManagerReboot`), so the exported-caller walk finds nothing on its own
    // — which is precisely why a gate keyed on `export function` missed this channel.
    // Seeding the private names lets the second hop resolve their exported callers.
    privateSeeds: ["gatherProcessInfo", "restartViaManagerReboot"],
    moduleHint: "instance-witness",
    expectEntries: ["restartComfyUI"],
    remedy:
      "`acquireInstanceWitness` opens a REAL WebSocket to COMFYUI_URL, so these take one " +
      "branch on a machine with ComfyUI running and another on CI — which is exactly how " +
      "restart-live-first.test.ts passed here and failed on all three runners. Stub it:\n\n" +
      '  vi.mock("../../services/instance-witness.js", async () => ({\n' +
      '    ...(await vi.importActual("../../services/instance-witness.js")),\n' +
      "    acquireInstanceWitness: async () => undefined,\n" +
      "  }));\n",
  },
];

/** Everything that can reach the process probe: its direct callers, then the
 *  exported functions that call THOSE. Two hops is what the real graph needs
 *  today; a third would only widen the set, and the assertion below is about a
 *  set GROWING, so a miss shows up as a new unstubbed file rather than silence. */
function reachingEntryPoints(probe: Probe): string[] {
  const direct = new Set<string>();
  for (const file of PRODUCT) {
    for (const fn of enclosingExports(file, probe.callee)) direct.add(fn);
  }
  for (const seed of probe.privateSeeds) direct.add(seed);

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
function unstubbedTests(probe: Probe): string[] {
  const entries = reachingEntryPoints(probe);
  const out: string[] = [];
  for (const file of TESTS) {
    const s = readFileSync(file, "utf-8");
    if (s.includes(probe.moduleHint)) continue;
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
const KNOWN_UNSTUBBED: Record<string, string[]> = {
  "live process table": ["__tests__/orchestrator/late-mutation-e2e.test.ts"],
  // Pre-existing, and a finding about the FIRST probe rather than about #1374:
  // `env-capabilities.test.ts` has read the real process table all along, and was
  // exempted only because its prose mentions "live-interpreter" —
  // `moduleHint` cannot tell a stub from a comment. The name-keyed probe below sees
  // it. Ratcheted rather than fixed here for the reason the list exists: that file
  // deliberately runs the real probe set to prove a per-gather read is not cached,
  // and deciding what the process probe should answer for it is its own judgement.
  "live process table (uncollapsed observation)": [
    "__tests__/services/env-capabilities.test.ts",
  ],
  // Empty on purpose (#1904): the five restart/stop files that used to live here
  // now stub `acquireInstanceWitness`, so a future test that reaches the real
  // WebSocket without stubbing fails the "NO NEW" assertion instead of joining
  // a ratchet that had already named the known offenders.
  "instance witness (real WebSocket)": [],
};

describe.each(PROBES)("host-reaching probe: $id (#1290/#1263)", (probe) => {
  it("finds the entry points by reading the code, not from a list", () => {
    // If this ever comes back empty the gate is inert, and every assertion below
    // would pass while checking nothing.
    const entries = reachingEntryPoints(probe);
    for (const e of probe.expectEntries) expect(entries).toContain(e);
    expect(
      entries.length,
      `the graph walk found nothing for ${probe.id} — the gate is dead`,
    ).toBeGreaterThan(0);
  });

  it("NO NEW test file reaches this probe unstubbed", () => {
    const known = KNOWN_UNSTUBBED[probe.id] ?? [];
    const offenders = unstubbedTests(probe).filter((f) => !known.includes(f));
    expect(
      offenders,
      `These tests reach the ${probe.id} without stubbing it, so they assert one thing ` +
        `on a machine where ComfyUI is running and another where it is not — and CI ` +
        `cannot tell you, because CI is one of the machines where they pass (#1263).\n\n` +
        probe.remedy,
    ).toEqual([]);
  });

  it("the known list only shrinks — a fixed file must be removed from it", () => {
    // Otherwise the ratchet rusts: files get stubbed, the list keeps naming them,
    // and it stops describing anything.
    const known = KNOWN_UNSTUBBED[probe.id] ?? [];
    const current = unstubbedTests(probe);
    const stale = known.filter((f) => !current.includes(f));
    expect(stale, "these are stubbed now — delete them from KNOWN_UNSTUBBED").toEqual([]);
  });
});

describe("the gate itself (#1263)", () => {
  it("covers MORE THAN ONE channel — one hardcoded probe is how the second was missed", () => {
    // The original gate was written around `resolveLiveInterpreter` by name, so the
    // witness channel walked straight past it and cost three red CI runners. This
    // assertion is what stops the table collapsing back to a single entry.
    expect(PROBES.length).toBeGreaterThan(1);
    expect(PROBES.map((p) => p.callee)).toContain("acquireInstanceWitness");
  });
});
