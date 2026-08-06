/**
 * Fail the build when a tool name that no longer exists is still presented to a
 * model as callable.
 *
 *   npx tsx scripts/check-tool-vocabulary.mts
 *
 * WHY THIS IS NOT A GREP. During the 0.49.0 consolidation ~250 names die. The
 * dangerous leftover is not a stale mention in a changelog — it is a live hint
 * string that instructs a model to call something that will 404, which the model
 * cannot diagnose and the user experiences as the tool being broken. That rot
 * already exists: `panel_get_graph` was removed upstream yet survives in five
 * live hint strings in the panel repo.
 *
 * Three details are what make it correct rather than merely noisy:
 *
 * 1. WORD BOUNDARIES, NOT SUBSTRINGS — and not `\b` either. `\b` treats `_` as a
 *    word character, so `\bpanel_get_graph\b` does NOT match inside
 *    `mcp__comfyui__panel_get_graph`, which is exactly the form these names take
 *    in agent transcripts and skill files. Hence explicit character-class
 *    lookarounds plus an optional `mcp__<server>__` prefix. The inverse matters
 *    too: a plain substring search for `get_image` hits `retarget_image`
 *    (packs/artokun-flow/workflow.json), and the lookbehind rejects it.
 *
 * 2. HISTORY IS NOT ROT. "replaces the old panel_get_graph" is an accurate,
 *    useful sentence — a model that saw the old name in training data benefits
 *    from reading it. Blanket matching would flag it and the "fix" would be to
 *    delete correct prose. So exceptions are per-name, per-path, each with a
 *    stated reason in src/tools/vocabulary.ts, reviewed in the diff.
 *
 * 3. EXCEPTIONS EXPIRE. An `allowedIn` path that no longer contains the name is
 *    itself an error. Otherwise the ledger silently accumulates permissions that
 *    have stopped meaning anything, and a genuinely new reference to that file
 *    lands pre-approved.
 *
 * File list comes from `git ls-files`, which gets two things for free: untracked
 * scratch files are ignored, and `.gitignore`d agent worktrees under `.claude/`
 * are excluded (a full second copy of the repo lives there and would double
 * every finding).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  BASELINE_SHA256,
  DEAD_NAMES,
  MAX_TOOLS,
  PANEL_BASELINE_SHA256,
  panelRetirementBaseline,
  retirementBaseline,
  TOOL_NAMES,
  baselineIntegrity,
  actionLiteralSpans,
  deadNameRe,
  panelBaselineIntegrity,
  rotMentions,
  type DeadName,
} from "../src/tools/vocabulary.js";
import { buildPanelToolDefs } from "../src/orchestrator/panel-tools.js";

/**
 * Paths where any dead name is acceptable because the file's PURPOSE is to
 * record the past. Deliberately narrow and literal — a broad glob like `docs/**`
 * would cover live guidance that models actually read.
 */
const HISTORICAL = [
  /^CHANGELOG\.md$/,
  /^docs\/changelog\//,
  // docs/blog is deliberately NOT here. Blog posts are dated, but they are also
  // PUBLISHED and navigable (docs.json lists them), so a dead tool name in one
  // misleads a reader exactly as much as in any other page. Treating the directory
  // as archival hid a live line advertising a removed tool as "New panel tools:",
  // with CI green. Historical mentions in a dated post are exempted per-occurrence
  // via allowedIn instead, which forces each one to be read.
  //
  // Saved graphs are DATA: node ids and widget values that happen to collide
  // with tool names. Rewriting them would corrupt a workflow.
  /^packs\/[^/]+\/workflow\.json$/,
];

/**
 * The vocabulary machinery itself, which necessarily contains the strings it
 * hunts: the ledger stores dead names as DATA, this script documents the
 * patterns it detects, and the test asserts on them as FIXTURES. None of them is
 * an instruction to a model to call anything.
 *
 * This exclusion was not foreseen — it was discovered when committing these
 * three files turned the gate red. They had been reporting green only because
 * `git ls-files` cannot see untracked files, so the gate had never scanned
 * itself. Two lessons worth keeping: run this AFTER staging, and a green result
 * over a tree that omits the new files is not evidence.
 *
 * Exact paths, never a `scripts/` or `__tests__/` glob — a glob here would
 * silently exempt every future file in those directories, and skill files and
 * hint strings are exactly the kind of thing that lands in them.
 */
const SELF = new Set([
  "src/tools/vocabulary.ts",
  "scripts/check-tool-vocabulary.mts",
  "src/__tests__/tools/vocabulary.test.ts",
  // Asserts, as FIXTURES, that the five retired bisect_* names are in DEAD_NAMES
  // (0.49.0 slice 1). Like vocabulary.test.ts above, it necessarily spells the dead
  // names it checks — they are data under assertion, not an instruction to a model
  // to call anything. Exact path, never an __tests__/ glob (see the note above).
  "src/__tests__/tools/node-bisect-tool.test.ts",
  // Same, for 0.49.0 slice 2: each asserts as FIXTURES that the names its tool
  // replaced are in DEAD_NAMES (node_snapshot ← 3, batch ← 4, apps ← 5).
  "src/__tests__/tools/node-snapshots-tool.test.ts",
  "src/__tests__/tools/batches.test.ts",
  "src/__tests__/tools/apps.test.ts",
  // Same, for 0.49.0 slice 3: asserts as FIXTURES that the eight retired
  // comfy_cli_* names are in DEAD_NAMES with `comfy_cli` replacements.
  "src/__tests__/tools/comfy-cli.test.ts",
  // Same, for 0.49.0 slice 4: asserts as FIXTURES that the eight retired
  // queue/jobs names are in DEAD_NAMES with `queue` replacements.
  "src/__tests__/tools/queue-management.test.ts",
  // Same, for 0.49.0 slice 5: asserts as FIXTURES that the three retired
  // model_metadata_* names are in DEAD_NAMES with `model_metadata` replacements.
  "src/__tests__/tools/model-explorer.test.ts",
  // Same, for 0.49.0 slice 6: asserts as FIXTURES that the three retired
  // workspace names are in DEAD_NAMES with `workspace` replacements.
  "src/__tests__/tools/workspace-env.test.ts",
  // Same, for 0.50.0 slice 8: asserts as FIXTURES that the ten retired runpod_*
  // names are in DEAD_NAMES with `runpod` / `runpod_watch` replacements.
  "src/__tests__/tools/runpod.test.ts",
  // Same, for 0.50.0 slice 7: each asserts as FIXTURES that the names its tool
  // replaced are in DEAD_NAMES (restart_comfyui ← 2, list_api_nodes ← 2,
  // get_defaults ← 3), and defaults.test.ts additionally asserts that the two
  // UI-settings redirects point at the _ui actions rather than the
  // generation-defaults ones — a check that cannot be written without spelling
  // the retired names.
  "src/__tests__/tools/process-control-tool.test.ts",
  "src/__tests__/tools/api-nodes.test.ts",
  "src/__tests__/tools/defaults.test.ts",
  // Same, for 0.50.0 slice 9: asserts as FIXTURES that the eight retired
  // knowledge names are in DEAD_NAMES with `list_packs` replacements — and that
  // no ACTION is spelled the same as one of them, which is the invariant that
  // keeps this gate's own replacement text writable.
  "src/__tests__/tools/skills-access.test.ts",
  // Same, for 0.50.0 slice 10: asserts as FIXTURES that the fifteen retired
  // train_* names are in DEAD_NAMES, and — the load-bearing one — that the two
  // retired DELETE names resolve to different tools keyed by different fields.
  "src/__tests__/tools/train-consolidation.test.ts",
  // Same, for 0.50.0 slice 11: asserts as FIXTURES that the twelve retired model
  // names are in DEAD_NAMES with their exact `download_model` /
  // `list_local_models` action replacements.
  "src/__tests__/tools/models-consolidated.test.ts",
  // Same, for 0.50.0 slice 14: each asserts as FIXTURES that the names its tool
  // replaced are in DEAD_NAMES (create_workflow ← 3, visualize_workflow ← 4,
  // get_workflow ← 7 and save_workflow ← 2).
  "src/__tests__/tools/workflow-compose.test.ts",
  "src/__tests__/tools/workflow-visualize.test.ts",
  "src/__tests__/tools/workflow-library.test.ts",
  // Same slice, one layer out: this passes three retired names to
  // callToolAdmission as FIXTURES and asserts the direct channel REFUSES them by
  // name. They are call arguments under test — the assertion is that nothing
  // serves them — not guidance to call anything.
  "src/__tests__/orchestrator/call-tool-admission.test.ts",
  // Same, for 0.50.0 slice 12: the three parts of the custom-node fold each
  // assert as FIXTURES that the names their tool replaced are in DEAD_NAMES
  // (install_custom_node ← 8, search_custom_nodes ← 1, node_pack ← 9). The
  // registry-search file also asserts the INVERSE — that `search_custom_nodes`
  // is NOT in DEAD_NAMES, because the owner's split kept it alive — which it
  // can only do by naming both it and the name it absorbed.
  "src/__tests__/tools/node-management.test.ts",
  "src/__tests__/tools/registry-search.test.ts",
  "src/__tests__/tools/node-pack.test.ts",
  // Same, for 0.50.0 slice 15: asserts as FIXTURES that the ten retired
  // image/asset names are in DEAD_NAMES with their exact `get_image` /
  // `upload_image` action replacements. Eight of the ten had their action
  // RENAMED (view_image -> action:"view"), so the action-literal rule cannot
  // reach them — they are a migration TABLE under assertion, not guidance.
  "src/__tests__/tools/image-assets.test.ts",
  // Same, for 0.50.0 slice 13: both spell the retired names as FIXTURES —
  // install-environment.test.ts asserts the six install/env retirements resolve
  // to the right `install_comfyui` action (including that the three tools which
  // already had an `action` of their own map onto `panel_action` /
  // `self_update_action` / `manager_setting` rather than colliding), and
  // system-stats.test.ts asserts `get_logs`/`health_check` redirect AND that
  // apply_manifest / clear_vram / report_issue / calculate stayed LIVE and out
  // of DEAD_NAMES — the owner's ruling, which cannot be pinned without naming
  // them.
  "src/__tests__/tools/install-environment.test.ts",
  "src/__tests__/tools/system-stats.test.ts",
  // Same, for the #659 retired-name error: these pass dead names to call_tool /
  // the ollama dispatch as FIXTURES and assert the error quotes the ledger's
  // replacement — the names are call arguments under test, not live guidance.
  "src/__tests__/tools/compact.test.ts",
  "src/__tests__/orchestrator/ollama-backend.test.ts",
  // Generated FROM the ledger by scripts/export-vocabulary.mts, so it reproduces
  // the dead names as data for the panel to consume. Caught this gate out a second
  // time, in the same way as the first: green while untracked, red once committed.
  "docs/design/tool-vocabulary.json",
  // The retirement baseline. By DEFINITION it lists every name that has ever
  // existed, including every dead one — that is the whole point of it. Scanning it
  // made a CORRECT retirement permanently red: adding get_queue to DEAD_NAMES
  // produced 20 hits, 19 fixable and one in the file that must preserve the name
  // forever. Found because the ratchet had only ever been tested on the path to RED,
  // never on the path to green. Its contents are protected by BASELINE_SHA256
  // instead, which is the right tool for a file that must not change.
  "docs/design/tool-surface.txt",
  // Same reasoning for the panel baseline.
  "docs/design/panel-surface.txt",
]);

/** Extensions that are never worth scanning as text. */
const BINARY = /\.(png|jpg|jpeg|gif|webp|ico|pdf|safetensors|ckpt|pt|bin|woff2?|mp4|webm|wav|mp3)$/i;

function tracked(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((p) => p && !BINARY.test(p) && !SELF.has(p));
}

/**
 * Catches a name assembled at runtime, which no name-based scan can see.
 *
 * The prefix list used to be five hand-picked strings, which covered 37 of 181 core
 * names and left 144 blind: `"panel_" + "get_graph"` was caught while
 * `"get_" + "queue"` sailed through, and escaped separators like `"panel\x5fget_graph"`
 * were invisible entirely.
 *
 * Now it is structural rather than a vocabulary: a string literal that ENDS in an
 * underscore and is immediately concatenated is a tool name being built, whatever the
 * prefix — `"get_" +`, `"comfy_cli_" +`, all of it. Plus escape-encoded underscores,
 * which are the other way to leave no contiguous token.
 *
 * Still a heuristic, not a proof. A name computed from data cannot be resolved by
 * reading source, and pretending otherwise is how the previous list looked adequate.
 */
const SPLIT_LITERAL = new RegExp(
  [
    // "get_" + …   /  "comfy_cli_".concat(…)
    // Any literal ENDING in an underscore that is concatenated. The earlier version
    // required the whole literal to be identifier characters, so `"Call panel_" + "…"`
    // — a fragment with a space in it, which is how these hints are actually written —
    // slipped through.
    `["'\`][^"'\`\\n]*[A-Za-z0-9]_["'\`]\\s*(?:\\+|\\.concat\\b)`,
    // … + "_get_graph"  — the underscore leading the SECOND fragment instead of
    // trailing the first, which the trailing-underscore rule alone missed.
    // Same-line only ([ \t] not \s): with newlines allowed this matched every
    // multi-line description string whose continuation happens to start with an
    // underscore, e.g. node-dev.ts:28-29 ending in `+` before `"__pycache__/ …"`.
    // `+` OR `.concat(` — the receiver-ends-in-underscore rule only covered one
    // direction, so `"Call panel".concat("_get_graph")` passed.
    //
    // The fragment must be a COMPLETE identifier chunk — `_get_graph` and nothing else
    // inside the quotes. That, not a same-line restriction, is what separates assembly
    // from ordinary multi-line prose: node-dev.ts:28-29 ends a line with `+` before
    // `"__pycache__/ and node_modules/. Use this to orient…"`, which begins with an
    // underscore but is plainly a sentence. Requiring the whole literal to be
    // identifier characters lets `\\s` span the newline safely, so the prettier-broken
    // form is caught without resurrecting that false positive.
    `(?:\\+|\\.concat\\()\\s*["'\`]_[A-Za-z0-9_]*["'\`]`,
    // ["panel","get","graph"].join("_")  — no fragment carries an underscore at all.
    `\\.join\\(\\s*["'\`]_["'\`]\\s*\\)`,
    // a bare "_" fragment: `"panel" + "_" + "get_graph"` carries the underscore in its
    // OWN literal, so neither the trailing- nor the leading-underscore rule saw it.
    `\\+\\s*["'\`]_["'\`]\\s*\\+`,
    // template interpolation of a literal: `Call get_${"queue"}` assembles at runtime
    // while every individual fragment looks innocent.
    `\\$\\{\\s*["'\`][A-Za-z0-9_]+["'\`]\\s*\\}`,
    // escape-encoded underscore
    `\\\\x5[fF]|\\\\u005[fF]`,
  ].join("|"),
);

/**
 * Concatenations that are NOT tool names.
 *
 * The structural heuristic covers every prefix, which is the point — and the price is
 * that it also matches ordinary identifier-building. Each exception is a file plus a
 * context substring plus a reason, matched on the line, exactly like `allowedIn`. Only
 * "this string is not a tool name" belongs here.
 */
const SPLIT_ALLOWED: Array<{ path: string; context: string; why: string }> = [
  {
    path: "src/services/hierarchical-mermaid.ts",
    context: 'return "sec_" + name.replace(',
    why: "builds a Mermaid section id from a node title — nothing to do with tool names",
  },
  {
    path: "src/__tests__/services/graph-command-effect.test.ts",
    context: '["graph", "via", "call"].join("_")',
    why:
      "NOT a tool name — a synthetic BRIDGE command in a test that proves the graph-effect " +
      "ledger's runtime probe catches a command whose name is assembled at runtime. The " +
      "assembly is the thing under test: a literal here would defeat the test's whole point, " +
      "which is that a literal scan cannot see this and the runtime probe can.",
  },
  {
    path: "src/__tests__/services/graph-command-effect.test.ts",
    context: '["graph", "via", "bridge"].join("_")',
    why:
      "NOT a tool name — same test, the ctx.bridge.send door rather than the ctx.call door. " +
      "See the entry above.",
  },
];

interface Hit {
  path: string;
  line: number;
  text: string;
  dead: DeadName;
}

const files = tracked();
const hits: Hit[] = [];
const splitHits: Array<{ path: string; line: number; text: string }> = [];
/** `${name}\u0000${path}` → the lines it was seen on, to expire stale exceptions. */
const seenIn = new Map<string, string[]>();
/** Same key, for `implementedIn` paths that actually licensed an action literal. */
const implementedUsed = new Set<string>();
const seenKey = (name: string, path: string) => `${name}\u0000${path}`;

for (const path of files) {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    continue; // unreadable or genuinely binary — nothing to assert about
  }
  // Cheap pre-filter: most files contain none of these names.
  const candidates = DEAD_NAMES.filter((d) => content.includes(d.name));
  // Assembly is a CODE construct, so only code files are scanned for it. Applying it to
  // prose produced false positives the moment the pattern widened: markdown like
  // "(+ `_sharp` variants)" reads as a concatenation of an underscore-leading literal.
  //
  // Python and shell ARE code — 64 tracked files were exempt because the first version of
  // this list said "code" and then enumerated only the TypeScript family. A Python route
  // handler emitting `"panel_" + "get_graph"` is exactly as capable of sending a model to
  // a dead tool as a .ts file is.
  // .mts/.cts and .bat/.ps1 are code too — the repo tracks 3 and 57 of them, and the
  // earlier list simply forgot they existed.
  const isCode = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|py|sh|bash|zsh|bat|ps1)$/.test(path);
  const looksSplit = isCode && SPLIT_LITERAL.test(content);
  if (candidates.length === 0 && !looksSplit) continue;

  const historical = HISTORICAL.some((re) => re.test(path));
  const lines = content.split("\n");

  for (const dead of candidates) {
    const re = deadNameRe(dead.name);
    for (const [i, text] of lines.entries()) {
      if (!re.test(text)) continue;
      // A mention sitting inside a verbatim copy of this name's OWN declared
      // replacement is the migration target, not rot — see rotMentions() in
      // src/tools/vocabulary.ts for why that is principled rather than a loophole.
      //
      // Checked BEFORE `seenIn` on purpose: a replacement form is not a mention of
      // the dead name for ANY purpose, staleness included. Recording it would let a
      // file whose only remaining occurrences are legitimate replacement forms keep
      // an obsolete `allowedIn` entry looking fresh — and a stale exception is a
      // hole that opens later, which is the whole reason the expiry check exists.
      //
      // Also BEFORE `allowedIn`, and independent of it: this is the one new decision
      // point, it needs no ledger entry (it is self-derived), and a line carrying
      // BOTH an allowedIn-covered mention and a replacement form still fails the
      // occurrence count below — fail-closed on the ambiguous case.
      // `path` enables the `implementedIn` rule for this file — see rotMentions.
      if (dead.implementedIn?.includes(path) && actionLiteralSpans(dead.name, text).length > 0) {
        implementedUsed.add(seenKey(dead.name, path));
      }
      if (rotMentions(dead, text, path).length === 0) continue;
      const key = seenKey(dead.name, path);
      if (!seenIn.has(key)) seenIn.set(key, []);
      seenIn.get(key)!.push(text);
      if (historical) continue;
      // An exemption covers ONE occurrence, not the whole line. With a line-wide
      // exemption, `replaces the old panel_get_graph dump; CALL panel_get_graph now`
      // passed — the historical clause laundering a live instruction beside it. If the
      // name appears more than once, the context cannot say which one is history, so
      // the line is reported and must be split.
      // The exemption must COVER the occurrence, not merely share a line with it.
      //
      // Requiring "context present + exactly one occurrence" was still launderable:
      //   > **TL;DR.** New panel tools: richer; CALL panel_get_graph now
      // has the historical context AND one occurrence — but the occurrence is the live
      // instruction, not the history. Binding the name to the context string means the
      // exempted text must itself contain the name, so an instruction added beside it is
      // a second occurrence and fails.
      const occurrences = text.split(dead.name).length - 1;
      if (
        occurrences === 1 &&
        dead.allowedIn?.some(
          (a) => a.path === path && text.includes(a.context) && a.context.includes(dead.name),
        )
      ) {
        continue;
      }
      hits.push({ path, line: i + 1, text: text.trim().slice(0, 160), dead });
    }
  }

  if (looksSplit && !historical) {
    const before = splitHits.length;
    // Tracked separately from `before` so an EXEMPTED single-line match does not look
    // like "no line matched" and trip the multiline fallback below — which is exactly
    // what happened when the first exception was added: it suppressed the real line and
    // the fallback then reported the same file at line 1 with empty text.
    let suppressed = false;
    for (const [i, text] of lines.entries()) {
      if (SPLIT_LITERAL.test(text)) {
        if (SPLIT_ALLOWED.some((a) => a.path === path && text.includes(a.context))) {
          suppressed = true;
          continue;
        }
        splitHits.push({ path, line: i + 1, text: text.trim().slice(0, 160) });
      }
    }
    // The file matched but no single line did, so the concatenation spans lines:
    //     "panel_"
    //     + "get_graph"
    // Re-testing line by line found nothing and the finding was silently dropped.
    // Report it at file level rather than lose it.
    if (splitHits.length === before && !suppressed) {
      const idx = lines.findIndex((l) => /["'`](?:comfy_|panel_|canvas_|runpod_|train_)["'`]\s*$/.test(l));
      splitHits.push({
        path,
        line: idx >= 0 ? idx + 1 : 1,
        text: "(concatenation spans multiple lines) " + (lines[idx] ?? "").trim().slice(0, 120),
      });
    }
  }
}

const errors: string[] = [];

if (hits.length > 0) {
  const lines = [`${hits.length} reference(s) to removed tool name(s):`, ""];
  for (const h of hits) {
    lines.push(`  ${h.path}:${h.line}  ${h.dead.name}`);
    lines.push(`    ${h.text}`);
    lines.push(`    → use ${h.dead.replacement}  (${h.dead.name}: ${h.dead.since})`);
    lines.push("");
  }
  lines.push(
    "If a mention is accurate HISTORY rather than a live instruction to call it,",
    "add it to that name's `allowedIn` in src/tools/vocabulary.ts with a reason.",
    "Do NOT widen the HISTORICAL path list to make this pass.",
  );
  errors.push(lines.join("\n"));
}

if (splitHits.length > 0) {
  const lines = [
    `${splitHits.length} tool name(s) appear to be assembled from string fragments:`,
    "",
  ];
  for (const h of splitHits) lines.push(`  ${h.path}:${h.line}  ${h.text}`);
  lines.push(
    "",
    "A name built at runtime is invisible to this gate, so it survives every rename.",
    "Write the full literal, or import it from src/tools/vocabulary.ts.",
  );
  errors.push(lines.join("\n"));
}

// A stale exception is a hole that opens later: the next real reference added to
// that file arrives pre-approved.
const stale = DEAD_NAMES.flatMap((d) =>
  (d.allowedIn ?? [])
    // Stale in EITHER direction: the file no longer mentions the name at all, or it
    // does but no line still contains the exempted context (the sentence was
    // reworded). The second case is the dangerous one — the exemption survives,
    // pointing at nothing, silently pre-approving whatever lands in that file next.
    .filter((a) => !(seenIn.get(seenKey(d.name, a.path)) ?? []).some((l) => l.includes(a.context)))
    .map((a) => `  ${d.name} → ${a.path}  (context: ${JSON.stringify(a.context)})`),
);
if (stale.length > 0) {
  errors.push(
    [
      `${stale.length} stale allowedIn exception(s) — the name is no longer in that file:`,
      "",
      ...stale,
      "",
      "Delete the exception. Leaving it means a future reference to that file is",
      "pre-approved by an entry nobody re-reviewed.",
    ].join("\n"),
  );
}

// Same expiry rule for `implementedIn`, and for the same reason: a path that no
// longer spells the name as a quoted action literal has stopped meaning anything,
// and leaving it there pre-approves whatever lands in that file next. This is the
// half of the exemption that is scoped by PATH rather than by syntax, so it is the
// half that can rot.
const staleImplemented = DEAD_NAMES.flatMap((d) =>
  (d.implementedIn ?? [])
    .filter((p) => !implementedUsed.has(seenKey(d.name, p)))
    .map((p) => `  ${d.name} → ${p}`),
);
if (staleImplemented.length > 0) {
  errors.push(
    [
      `${staleImplemented.length} stale implementedIn path(s) — no quoted action literal remains:`,
      "",
      ...staleImplemented,
      "",
      "Either the file no longer implements that action, or the path is wrong. Delete",
      "it: an implementedIn path is an exception, and exceptions expire.",
    ].join("\n"),
  );
}

// THE RATCHET, enforced in CI independently of vitest. Everything else here hunts
// names that are ALREADY in DEAD_NAMES, so an omitted entry disarms the whole gate
// for that name. Comparing against the frozen 0.48.6 baseline makes the obligation
// impossible to skip: retire a tool without declaring it dead and the build fails.
const retiredButNotDeclared = retirementBaseline().filter(
  (n) => !(TOOL_NAMES as readonly string[]).includes(n) && !DEAD_NAMES.some((d) => d.name === n),
);
if (retiredButNotDeclared.length > 0) {
  errors.push(
    [
      `${retiredButNotDeclared.length} tool(s) were removed but never declared dead:`,
      "",
      ...retiredButNotDeclared.map((n) => `  ${n}`),
      "",
      "Each existed at 0.48.6 and is no longer registered, so nothing currently flags",
      "the prose, hint strings, skills and docs that still tell a model to call it.",
      "Add each to DEAD_NAMES in src/tools/vocabulary.ts with a replacement — that is",
      "what turns this gate from a list of known-bad names into a ratchet.",
    ].join("\n"),
  );
}

// The baseline is the ratchet's anchor, so its integrity IS the ratchet. Editing the
// file in the same commit as a removal made the invariant above vacuous.
const integrity = baselineIntegrity();
if (!integrity.ok) {
  errors.push(
    [
      "docs/design/tool-surface.txt does not match BASELINE_SHA256.",
      "",
      `  expected ${BASELINE_SHA256}`,
      `  actual   ${integrity.actual}`,
      "",
      "This file is the frozen record of every tool that has ever existed, and the",
      "retirement ratchet is computed against it. DELETING a line from it disables the",
      "ratchet for that name. If you APPENDED newly shipped tools, update",
      "BASELINE_SHA256 in src/tools/vocabulary.ts and say so in the commit message.",
    ].join("\n"),
  );
}

// MAX_TOOLS must equal the ledger size — see its doc comment. A loose ceiling let the
// count drift in either direction with every gate green.
if (MAX_TOOLS !== TOOL_NAMES.length) {
  errors.push(
    `MAX_TOOLS is ${MAX_TOOLS} but the ledger has ${TOOL_NAMES.length} tools. ` +
      `Set MAX_TOOLS to ${TOOL_NAMES.length} — it exists so the count is an explicit, ` +
      `reviewed number in the diff, which a mere upper bound never was.`,
  );
}

// The PANEL half of the ratchet. Without it this was a core-tool ratchet wearing a
// two-surface description: 181 covered, 87 not — and Phase 6 renames all 87.
const livePanel = new Set(buildPanelToolDefs().map((d) => d.name));
const panelRetiredNotDeclared = panelRetirementBaseline().filter(
  (n) => !livePanel.has(n) && !DEAD_NAMES.some((d) => d.name === n),
);
if (panelRetiredNotDeclared.length > 0) {
  errors.push(
    [
      `${panelRetiredNotDeclared.length} PANEL tool(s) were removed but never declared dead:`,
      "",
      ...panelRetiredNotDeclared.map((n) => `  ${n}`),
      "",
      "Each existed at 0.48.6 and buildPanelToolDefs() no longer returns it, so nothing",
      "flags the hint strings, PANEL_SYSTEM_APPEND text and docs that still name it.",
      "Add each to DEAD_NAMES in src/tools/vocabulary.ts with a replacement.",
    ].join("\n"),
  );
}

const panelIntegrity = panelBaselineIntegrity();
if (!panelIntegrity.ok) {
  errors.push(
    [
      "docs/design/panel-surface.txt does not match PANEL_BASELINE_SHA256.",
      "",
      `  expected ${PANEL_BASELINE_SHA256}`,
      `  actual   ${panelIntegrity.actual}`,
      "",
      "Deleting a line disables the panel retirement ratchet for that name. If you",
      "APPENDED newly shipped panel tools, update PANEL_BASELINE_SHA256 deliberately.",
    ].join("\n"),
  );
}

// THE OTHER HALF OF THE RATCHET: every LIVE name must also be in the baseline.
//
// Without this the invariant only ever covered the 181 names frozen at 0.48.6, so any
// name CREATED later escaped it permanently — which is precisely what Phase 5 does. The
// two-step bypass: introduce `comfy_queue`, declare the old `get_queue` dead, never
// append the new name to the baseline (all green); later retire `comfy_queue` without a
// DEAD_NAMES entry (still green, because it was never in the baseline to be missed).
// Hash-pinning does not help — the bypass never touches the baseline.
//
// Requiring live ⊆ baseline makes shipping a tool the moment it enters the ratchet:
// append it, update the hash, and from then on retiring it is enforced like any other.
const missingFromBaseline = (TOOL_NAMES as readonly string[]).filter(
  (n) => !retirementBaseline().includes(n),
);
if (missingFromBaseline.length > 0) {
  errors.push(
    [
      `${missingFromBaseline.length} live tool(s) are not in docs/design/tool-surface.txt:`,
      "",
      ...missingFromBaseline.map((n) => `  ${n}`),
      "",
      "The baseline is the record of every name that has EVER existed, so a new tool must",
      "join it when it ships — otherwise retiring it later is unenforced, because nothing",
      "will notice it is gone. Append the name(s), then update BASELINE_SHA256.",
    ].join("\n"),
  );
}

const panelMissingFromBaseline = [...livePanel].filter(
  (n) => !panelRetirementBaseline().includes(n),
);
if (panelMissingFromBaseline.length > 0) {
  errors.push(
    [
      `${panelMissingFromBaseline.length} live PANEL tool(s) are not in docs/design/panel-surface.txt:`,
      "",
      ...panelMissingFromBaseline.map((n) => `  ${n}`),
      "",
      "Append them (sorted), then update PANEL_BASELINE_SHA256.",
    ].join("\n"),
  );
}

// A name cannot be both alive and dead. Catches a bad revert that re-registers a
// tool while the ledger still lists it as removed.
const contradictions = DEAD_NAMES.filter((d) => (TOOL_NAMES as readonly string[]).includes(d.name));
if (contradictions.length > 0) {
  errors.push(
    `Name(s) in BOTH TOOL_NAMES and DEAD_NAMES: ${contradictions.map((d) => d.name).join(", ")}`,
  );
}

if (errors.length > 0) {
  console.error(`\n[check-tool-vocabulary] FAIL\n\n${errors.join("\n\n")}\n`);
  process.exit(1);
}

console.error(
  `[check-tool-vocabulary] OK — ${files.length} tracked files, ` +
    `${DEAD_NAMES.length} dead name(s) in the ledger, no live references.`,
);
