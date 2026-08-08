/**
 * Dump the live MCP tool surface — the ground-truth probe for the 0.49.0
 * consolidation.
 *
 * Every phase of that refactor claims "the surface is now N tools". This is how
 * that claim gets checked instead of asserted: it boots the real server, asks it
 * over a real MCP client, and prints what a client would actually see.
 *
 *   npx tsx scripts/tools-dump.mts                 # JSON: {count, tools:[…]}
 *   npx tsx scripts/tools-dump.mts --names         # one name per line, registration order
 *   npx tsx scripts/tools-dump.mts --max 30        # exit 1 if count > 30
 *   npx tsx scripts/tools-dump.mts --golden path/to/expected.txt
 *                                                  # diff names vs a committed golden
 *   npx tsx scripts/tools-dump.mts --write-golden path/to/expected.txt
 *
 * The golden is a snapshot of the LIVE surface. It is NOT docs/design/tool-surface.txt
 * or docs/design/panel-surface.txt — those are hash-pinned retirement baselines and
 * both invocations are refused against them; see RETIREMENT_BASELINES below.
 *
 * COMFYUI_URL is set so src/config.ts skips its network port-probe at import
 * time (same reason npm run docs:gen sets it).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { listRegisteredTools } from "../src/tools/introspect.js";

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);

/**
 * Every option this script accepts. An UNKNOWN option used to be ignored in silence,
 * so `--goden docs/design/tool-surface.txt` exited 0 having verified nothing — the
 * failure mode this whole script exists to prevent, reached by one typo.
 */
const KNOWN = ["--names", "--quiet", "--max", "--golden", "--write-golden"];
{
  const valueOf = new Set(["--max", "--golden", "--write-golden"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("-")) continue; // a value for the preceding option
    if (!KNOWN.includes(a)) {
      console.error(`[tools-dump] unknown option ${a}. Known: ${KNOWN.join(" ")}`);
      process.exit(2);
    }
    if (valueOf.has(a)) i++; // skip its value so a value starting with '-' is not re-read
  }
}

/** Exit code 2 = the invocation was wrong, distinct from 1 = a check failed. */
function usage(message: string): never {
  console.error(`[tools-dump] ${message}`);
  process.exit(2);
}

/**
 * A flag's value, refusing the two ways a missing value silently disarms a gate:
 * `--max` at the end of argv used to read as `undefined` and skip the budget
 * check entirely, and `--golden --quiet` used to consume `--quiet` AS THE
 * FILENAME. Both produce a passing run that verified nothing, which is worse than
 * either erroring or checking.
 */
const value = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const next = argv[i + 1];
  if (next === undefined) usage(`${name} needs a value.`);
  if (next.startsWith("-")) usage(`${name} needs a value, got the flag ${next}.`);
  // An EMPTY value used to survive to the `if (golden)` truthiness test and be skipped,
  // so `--golden ''` reported success having compared nothing.
  if (next.trim() === "") usage(`${name} needs a non-empty value.`);
  return next;
};

// Writing the baseline and checking against it in one run is incoherent: the
// write lands first, so the check compares the file to itself and ALWAYS passes.
// A gate that cannot fail is worse than no gate, because it reports success.
if (flag("--golden") && flag("--write-golden")) {
  usage("--golden and --write-golden are mutually exclusive (the write would self-approve the check).");
}

const tools = await listRegisteredTools();
const names = tools.map((t) => t.name);
let failed = false;

if (flag("--names")) {
  console.log(names.join("\n"));
} else if (!flag("--quiet")) {
  console.log(
    JSON.stringify(
      {
        count: tools.length,
        // Surfacing these two makes the Glama-relevant regressions visible in the
        // dump itself rather than needing a separate audit: a tool with no
        // annotations loses Behavioural Transparency, and a tool whose schema
        // normalised to an empty object advertises zero parameters.
        withAnnotations: tools.filter((t) => t.annotations).length,
        emptySchema: tools.filter((t) => {
          const s = t.inputSchema as { properties?: Record<string, unknown> } | undefined;
          return !s?.properties || Object.keys(s.properties).length === 0;
        }).length,
        tools,
      },
      null,
      2,
    ),
  );
}

const max = value("--max");
if (max !== undefined) {
  const limit = Number(max);
  if (!Number.isFinite(limit)) {
    console.error(`--max needs a number, got ${JSON.stringify(max)}`);
    process.exit(2);
  }
  if (tools.length > limit) {
    console.error(`\nFAIL: ${tools.length} tools registered, budget is ${limit}.`);
    failed = true;
  } else {
    console.error(`OK: ${tools.length}/${limit} tools.`);
  }
}

/**
 * The two hash-pinned RETIREMENT BASELINES. Neither is a live-surface golden, and
 * pointing this script at either is a footgun in both directions.
 *
 * They are history, not state: docs/design/tool-surface.txt holds every core name
 * that has EVER existed (195), against which check-tool-vocabulary enforces
 * `BASELINE \ TOOL_NAMES ⊆ DEAD_NAMES`. The live surface is 37 after the 0.50.0
 * consolidation and will never equal it again.
 *
 * So `--golden docs/design/tool-surface.txt` — an invocation this script's own
 * usage text used to advertise — reports 158 removals and exits 1 on a perfectly
 * healthy repo. That alone is only noise. The danger is the remedy printed
 * underneath it: "re-run with --write-golden", which would overwrite the baseline
 * with the 37 live names and DELETE the other 158. Deleting a line from a
 * retirement baseline is exactly how the ratchet is disarmed for that name — every
 * stale reference to it stops being an error. One typo-free, instruction-following
 * run would have silently disarmed the repo's main vocabulary gate for 158 names,
 * leaving only the SHA pin, whose own error text invites updating the hash.
 *
 * Refused rather than warned: there is no correct reading of either invocation.
 * The baseline is maintained by APPENDING a newly shipped name and updating its
 * SHA deliberately, which is a reviewed edit, not a regenerate.
 */
const RETIREMENT_BASELINES = ["tool-surface.txt", "panel-surface.txt"];
const isRetirementBaseline = (p: string): boolean =>
  RETIREMENT_BASELINES.some((b) => p.replace(/\\/g, "/").endsWith(`docs/design/${b}`));

for (const opt of ["--golden", "--write-golden"] as const) {
  const p = value(opt);
  if (p !== undefined && isRetirementBaseline(p)) {
    usage(
      `${p} is a hash-pinned RETIREMENT BASELINE (every name that has ever existed), ` +
        `not a golden of the live surface — ${opt} would ` +
        (opt === "--write-golden"
          ? `overwrite it with today's ${names.length} live names and delete the rest, disarming the dead-name ratchet for every name dropped.`
          : `report every retired name as a removal and exit 1 on a healthy repo.`) +
        `\n  What enforces it: npm run check:vocabulary (BASELINE \\ TOOL_NAMES ⊆ DEAD_NAMES).` +
        `\n  To add a newly shipped tool: append the name, then update BASELINE_SHA256 in src/tools/vocabulary.ts.`,
    );
  }
}

const writeGolden = value("--write-golden");
if (writeGolden) {
  writeFileSync(writeGolden, `${names.join("\n")}\n`, "utf8");
  console.error(`Wrote ${names.length} names to ${writeGolden}`);
}

const golden = value("--golden");
if (golden) {
  const expected = readFileSync(golden, "utf8").trim().split("\n").filter(Boolean);

  // The VERDICT is exact sequence equality, nothing cleverer. Everything below is
  // only to make the FAILURE readable.
  //
  // Two earlier attempts were both wrong. Comparing sets passes on a pure
  // reordering ([A,B] vs [B,A] has no additions and no removals) even though
  // registration order is observable — it is what tools/list returns and what a
  // model reads top-down (src/tools/index.ts:68-70,133-135). Adding a `reordered`
  // flag guarded by equal lengths then still passed [A,A,B] against [A,B]: a
  // duplicate registration produces no added and no removed name, and the length
  // guard suppressed the order check. Sequence equality has no such gap.
  const equal = names.length === expected.length && names.every((n, i) => n === expected[i]);

  const added = names.filter((n) => !expected.includes(n));
  const removed = expected.filter((n) => !names.includes(n));
  const duplicated = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  const firstDivergence = names.findIndex((n, i) => n !== expected[i]);

  if (!equal) {
    console.error(`\nFAIL: surface differs from ${golden}`);
    for (const n of removed) console.error(`  - ${n}`);
    for (const n of added) console.error(`  + ${n}`);
    for (const n of duplicated) {
      console.error(`  ! ${n} is registered ${names.filter((x) => x === n).length} times`);
    }
    if (names.length !== expected.length) {
      console.error(`  # count: expected ${expected.length}, got ${names.length}`);
    }
    if (firstDivergence >= 0 && !added.length && !removed.length && !duplicated.length) {
      console.error(
        `  ~ same set, different order — first divergence at position ${firstDivergence}: ` +
          `expected ${expected[firstDivergence]}, got ${names[firstDivergence]}`,
      );
    }
    console.error(
      `\nIf this change is intended, re-run with --write-golden ${golden} and review the diff.`,
    );
    failed = true;
  } else {
    console.error(`OK: surface matches ${golden} exactly, in order (${names.length} tools).`);
  }
}

process.exit(failed ? 1 : 0);
