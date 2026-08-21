#!/usr/bin/env node
/**
 * anti-slop ratchet — seven vendored Oxlint rules behind a shrink-only baseline.
 *
 * The tracked defect class: TypeScript that asserts a shape it has no evidence
 * for. `x as unknown as Foo` launders an arbitrary value into a precise type;
 * a function declared to return `unknown` pushes the parsing onto every caller;
 * `Reflect.get(obj, key)` reads a property while telling the compiler nothing.
 * Each of these compiles, and each of them is where the next "could not
 * determine" quietly becomes "determined". The rules come from
 * dmmulroy/anti-slop, vendored at `tools/oxlint/anti-slop/` — the commit,
 * the date, and which rules are on and off (and why) are recorded in
 * `tools/oxlint/README.md`.
 *
 * WHY A BASELINE RATHER THAN A CLEAN GATE. The seven adopted rules report ~780
 * sites on the tree they landed on. Fixing them all in one change would be a
 * diff nobody could review, so the gate records the debt per file per rule and
 * refuses to let it grow. Paying it down is ordinary work that happens file by
 * file, and each payment shrinks the baseline in the same PR.
 *
 * DIRECTION OF THE RATCHET. The baseline may SHRINK and never grow. A file/rule
 * pair whose count rises — including a pair that was not there before — fails
 * the build and lists the sites. A pair whose count has fallen ALSO fails, but
 * in the other direction: the debt has been paid and the list has to say so, or
 * a re-introduced site in that file would land pre-approved. Same idiom as the
 * #796 unknown-collapse gate; the vocabulary baseline is the opposite kind
 * (append-only history), and the two should not be confused.
 *
 * THE ESCAPE HATCH IS THE POINT. Some findings are correct code: a test that
 * deliberately hands a malformed value to a parser, a boundary that really does
 * receive `unknown`. Waive those AT THE SITE, with the reason, using Oxlint's
 * own directive so the waiver and the code move together:
 *
 *     // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the test feeds a deliberately malformed event; the double cast is the point
 *     const ev = raw as unknown as PanelEvent;
 *
 * A directive naming an anti-slop rule with no `-- reason` is rejected here, and
 * the reason has to be words — four or more — not a bare ticket number. The
 * reason is the deliverable: it is what a reviewer reads instead of re-deriving
 * whether the cast is safe, and writing it is where an author notices that it
 * is not. A BLANKET `oxlint-disable` / `eslint-disable` that names no rule is
 * rejected whatever follows it: it switches every rule off for the line or the
 * whole file, and that is not something a reason can cover. Name the rule.
 *
 * Keep a `//` directive on ONE line. A continuation comment underneath it is
 * the "next line" as far as oxlint is concerned, so the directive silently
 * misses the code and the finding stays reported (verified against 1.79.0).
 * A reason that needs more room goes in a `/* … *\/` block, which may wrap.
 *
 * WHAT THIS IS NOT. Oxlint's built-in categories are all OFF in `.oxlintrc.json`;
 * this gate is about the anti-slop rules and nothing else. A diagnostic that is
 * not `anti-slop(...)` is reported as a configuration drift, not folded into the
 * debt, so that turning a built-in category on is a separate, deliberate change.
 *
 * Usage:
 *   node scripts/check-anti-slop.mjs            # gate; non-zero on failure
 *   node scripts/check-anti-slop.mjs --list     # every finding, file:line:col
 *   node scripts/check-anti-slop.mjs --baseline # rewrite the baseline
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `--src` (repeatable), `--config`, and `--baseline-file` exist so the gate can
 *  be tested against fixture trees. A gate nobody can test is a gate nobody
 *  trusts, and this one makes claims about what it will and will not flag that
 *  have to be demonstrable rather than asserted. All default to the real repo
 *  layout. */
function flagValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flagValues(name) {
  const out = [];
  process.argv.forEach((a, i) => {
    if (a === name && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
}
const TARGETS = flagValues("--src").length ? flagValues("--src") : ["src", "scripts"];
const CONFIG = flagValue("--config", join(ROOT, ".oxlintrc.json"));
const BASELINE = flagValue("--baseline-file", join(ROOT, "scripts", "anti-slop-baseline.json"));

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage"]);
const SOURCE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;

function die(...lines) {
  console.error(lines.filter((l) => l !== undefined && l !== "").join("\n"));
  process.exit(2);
}

/** Paths as oxlint prints them: relative to its cwd for files underneath it,
 *  absolute otherwise, and with the host separator. Normalised to a POSIX path
 *  relative to ROOT so a baseline written on one OS reads the same on another. */
function normalise(filename) {
  const abs = isAbsolute(filename) ? filename : join(ROOT, filename);
  return relative(ROOT, abs).split(sep).join("/");
}

/**
 * Run oxlint once and return its parsed JSON report.
 *
 * Invoked through `process.execPath` + the package's own bin script rather than
 * the `.bin` shim: the shim is a `.cmd` on Windows and a symlink elsewhere, and
 * spawning it portably is more code than resolving the file it points at.
 *
 * Oxlint exits 1 whenever it reports an error-severity diagnostic, which on this
 * tree is always. So the exit status says nothing useful; the JSON does. What
 * DOES matter is the case where there is no JSON at all — a plugin that failed
 * to load, a config that failed to parse — because a gate that treats "oxlint
 * crashed" as "oxlint found nothing" has switched itself off.
 */
function runOxlint() {
  const require = createRequire(import.meta.url);
  const bin = join(dirname(require.resolve("oxlint/package.json")), "bin", "oxlint");
  const r = spawnSync(process.execPath, [bin, "-c", CONFIG, "--format", "json", ...TARGETS], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) die(`anti-slop gate: could not spawn oxlint: ${r.error.message}`);
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    die(
      "anti-slop gate: oxlint produced no JSON report. Its output was:",
      "",
      r.stderr.trim(),
      r.stdout.trim(),
    );
  }
  if (!Array.isArray(report.diagnostics)) die("anti-slop gate: unexpected oxlint report shape.");
  // Zero files is never "clean" — it is a path or ignore pattern that has
  // quietly excluded everything.
  if (report.number_of_files === 0) {
    die(
      `anti-slop gate: oxlint found no files to lint under ${TARGETS.join(", ")}.`,
      "Check the paths and the ignorePatterns in .oxlintrc.json.",
    );
  }
  return report;
}

function scan() {
  const report = runOxlint();
  const findings = [];
  const unparsed = [];
  const foreign = [];
  for (const d of report.diagnostics) {
    const span = d.labels?.[0]?.span ?? {};
    const rec = { rel: normalise(d.filename), line: span.line ?? 0, column: span.column ?? 0 };
    // A parse error is a diagnostic with no `code` — not a finding, and not
    // something a baseline may absorb: a file oxlint cannot read is a file the
    // rules were never run on.
    if (typeof d.code !== "string") {
      unparsed.push({ ...rec, message: d.message });
      continue;
    }
    const m = /^anti-slop\(([\w-]+)\)$/.exec(d.code);
    if (!m) {
      foreign.push({ ...rec, code: d.code });
      continue;
    }
    findings.push({ ...rec, rule: m[1] });
  }
  return { findings, unparsed, foreign, fileCount: report.number_of_files };
}

/** `{ "src/a.ts": { "no-unknown-returns": 2 } }`, keys sorted at both levels so
 *  the baseline diffs line by line. */
function tally(findings) {
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.rel)) byFile.set(f.rel, new Map());
    const rules = byFile.get(f.rel);
    rules.set(f.rule, (rules.get(f.rule) ?? 0) + 1);
  }
  const out = {};
  for (const rel of [...byFile.keys()].sort()) {
    out[rel] = {};
    for (const rule of [...byFile.get(rel).keys()].sort()) out[rel][rule] = byFile.get(rel).get(rule);
  }
  return out;
}

function perRuleTotals(files) {
  const totals = {};
  for (const rules of Object.values(files)) {
    for (const [rule, n] of Object.entries(rules)) totals[rule] = (totals[rule] ?? 0) + n;
  }
  return totals;
}

/** Symlinks are skipped rather than followed: a link back into the tree would
 *  loop, and a link out of it points at files oxlint was not asked about. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.isSymbolicLink()) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile() && SOURCE_EXT.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(p);
  }
  return out;
}

/**
 * Disable directives that would silence this gate, without a reason.
 *
 * Oxlint honours both its own spelling and ESLint's, on a line or as a block,
 * and `-- text` after the rule list is its reason syntax. Two shapes matter:
 * a directive that names an `anti-slop/` rule, and a directive that names NO
 * rule, which disables everything. Directives naming only other rules are
 * somebody else's business and are left alone.
 *
 * The reason is read the way oxlint reads the directive: to the end of the
 * line for `//`, to the closing `*\/` for a block — across lines if the block
 * wraps. A `//` reason is NOT followed onto the next comment line, because
 * oxlint does not follow it either (see the header).
 */
function bareWaivers() {
  const bare = [];
  const directive = /(?:eslint|oxlint)-disable(?:-next-line|-line)?\b([^\n]*)/g;
  for (const target of TARGETS) {
    const abs = isAbsolute(target) ? target : join(ROOT, target);
    const files = statSync(abs).isDirectory() ? walk(abs) : [abs];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        let m;
        while ((m = directive.exec(line))) {
          const before = line.slice(0, m.index);
          const open = before.lastIndexOf("/*");
          const inBlock = open !== -1 && before.lastIndexOf("*/") < open;
          // Only a directive inside a comment is a directive. The same words in
          // a string literal — an error message quoting the syntax, this file's
          // own usage text — are prose, and oxlint does not read them either.
          if (!inBlock && !before.includes("//")) continue;
          let body = m[1];
          if (inBlock && !body.includes("*/")) {
            for (let j = i + 1; j < lines.length; j++) {
              body += " " + lines[j];
              if (lines[j].includes("*/")) break;
            }
          }
          body = body.replace(/\*\/[^]*$/, "");
          const dash = body.indexOf("--");
          const ruleList = (dash === -1 ? body : body.slice(0, dash)).trim();
          const reason = dash === -1 ? "" : body.slice(dash + 2);
          // A blanket directive is rejected whatever follows it: it switches
          // every rule off for the line or the file, and "every rule" is not a
          // thing anyone can write a reason for. Name the rule.
          const blanket = ruleList === "";
          if (!blanket && !ruleList.includes("anti-slop/")) continue;
          // A reason must be words — not punctuation, and not a ticket number alone.
          const words = reason.split(/\s+/).filter((w) => /[a-z]{3}/i.test(w));
          if (!blanket && words.length >= 4) continue;
          bare.push({ rel: normalise(file), line: i + 1, blanket, text: line.trim() });
        }
      });
    }
  }
  return bare;
}

function readBaseline() {
  let raw = "";
  try {
    raw = readFileSync(BASELINE, "utf8");
  } catch (err) {
    // Genuinely absent is different from unreadable, and this gate of all things
    // should not confuse them: a missing baseline means every finding is new
    // (and the message says how to record them); an unreadable one throws.
    if (err?.code === "ENOENT") return { files: {}, absent: true };
    throw err;
  }
  const parsed = JSON.parse(raw);
  // `typeof null === "object"`, so the null check is not redundant.
  if (parsed === null || parsed.files === null || typeof parsed.files !== "object" || Array.isArray(parsed.files)) {
    die(`anti-slop gate: ${relative(ROOT, BASELINE)} has no "files" object. Rewrite it with --baseline.`);
  }
  return { files: parsed.files, absent: false };
}

function writeBaseline(files) {
  const doc = {
    $comment: [
      "anti-slop ratchet — known findings per file per rule, from the seven rules",
      "enabled in .oxlintrc.json. See tools/oxlint/README.md for which rules and why.",
      "",
      "THIS IS A DEBT LIST. It may shrink and never grow. A count that rises fails",
      "CI; clear the new site by fixing it, or waive it AT THE SITE with a reasoned",
      "`// oxlint-disable-next-line anti-slop/<rule> -- <why>`. When counts fall,",
      "rewrite this file so the payment is recorded:",
      "",
      "    node scripts/check-anti-slop.mjs --baseline",
    ],
    files,
  };
  writeFileSync(BASELINE, JSON.stringify(doc, null, 2) + "\n", "utf8");
}

const args = process.argv.slice(2);
const { findings, unparsed, foreign, fileCount } = scan();
const current = tally(findings);

if (args.includes("--list")) {
  for (const f of findings.slice().sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line)) {
    console.log(`${f.rel}:${f.line}:${f.column}\t${f.rule}`);
  }
  const totals = perRuleTotals(current);
  console.log("");
  for (const rule of Object.keys(totals).sort()) console.log(`${String(totals[rule]).padStart(6)}  ${rule}`);
  console.log(`${String(findings.length).padStart(6)}  findings in ${Object.keys(current).length} files (${fileCount} linted)`);
  process.exit(0);
}

if (args.includes("--baseline")) {
  // A file oxlint could not parse contributes zero findings, so a baseline
  // written over it would be an undercount that fails the moment the file is
  // fixed. Refuse, rather than record a number that is not true.
  if (unparsed.length || foreign.length) {
    console.error("anti-slop — not writing a baseline over a tree oxlint could not fully lint:\n");
    for (const u of unparsed) console.error(`  ${u.rel}:${u.line}:${u.column}  ${u.message}`);
    for (const f of foreign) console.error(`  ${f.rel}:${f.line}:${f.column}  ${f.code} (not an anti-slop rule — check .oxlintrc.json)`);
    process.exit(1);
  }
  const before = perRuleTotals(readBaseline().files);
  writeBaseline(current);
  const after = perRuleTotals(current);
  let grew = false;
  for (const rule of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = before[rule] ?? 0;
    const b = after[rule] ?? 0;
    const delta = b - a;
    if (delta > 0) grew = true;
    console.log(`  ${rule}: ${a} -> ${b}${delta === 0 ? "" : ` (${delta > 0 ? "+" : ""}${delta})`}`);
  }
  console.log(`baseline written: ${findings.length} findings in ${Object.keys(current).length} files`);
  if (grew) {
    // Written anyway — the diff is what a reviewer reads — but growth is the
    // one direction this file is not supposed to move, so say so where the
    // author will see it. Legitimate growth exists (re-vendoring stricter rules,
    // adopting an eighth rule); new debt in ordinary work is not it.
    console.error(
      "\nNOTE: the baseline GREW. The ratchet only pays down. Unless this change\n" +
        "re-vendors the rules or adopts a new one, fix or waive the new sites at\n" +
        "the site instead of recording them here.",
    );
  }
  process.exit(0);
}

const baseline = readBaseline();
const added = [];
const paid = [];
for (const [rel, rules] of Object.entries(current)) {
  for (const [rule, now] of Object.entries(rules)) {
    const known = baseline.files[rel]?.[rule] ?? 0;
    if (now > known) {
      added.push({
        rel,
        rule,
        known,
        now,
        sites: findings.filter((f) => f.rel === rel && f.rule === rule).sort((a, b) => a.line - b.line),
      });
    }
  }
}
for (const [rel, rules] of Object.entries(baseline.files)) {
  for (const [rule, known] of Object.entries(rules)) {
    const now = current[rel]?.[rule] ?? 0;
    if (known > now) paid.push({ rel, rule, known, now });
  }
}
const bare = bareWaivers();

let failed = false;

if (unparsed.length) {
  failed = true;
  console.error(`\nanti-slop — oxlint could not parse ${unparsed.length} file(s); the rules never ran on them.\n`);
  for (const u of unparsed) console.error(`  ${u.rel}:${u.line}:${u.column}  ${u.message}`);
}

if (foreign.length) {
  failed = true;
  console.error(`\nanti-slop — ${foreign.length} diagnostic(s) from rules that are not anti-slop.\n`);
  console.error(
    "Oxlint's built-in categories are meant to be OFF in .oxlintrc.json; this\n" +
      "gate tracks the anti-slop rules only. Turning a built-in rule on is a\n" +
      "separate decision with its own baseline — do not fold it into this one.\n",
  );
  for (const f of foreign.slice(0, 20)) console.error(`  ${f.rel}:${f.line}:${f.column}  ${f.code}`);
  if (foreign.length > 20) console.error(`  … and ${foreign.length - 20} more`);
}

if (added.length) {
  failed = true;
  const n = added.reduce((s, a) => s + (a.now - a.known), 0);
  console.error(`\nanti-slop — ${n} new finding(s) in ${added.length} file/rule pair(s).\n`);
  console.error(
    "These patterns assert a shape the code has no evidence for: a chained cast,\n" +
      "a widened binding re-narrowed by assertion, an `unknown` return contract, a\n" +
      "Reflect.get/apply that hides the access from the type checker.\n",
  );
  for (const a of added) {
    console.error(`  ${a.rel}  ${a.rule}: baseline ${a.known}, now ${a.now}`);
    // The count says how many are new; it cannot say which. Every current site
    // is listed so the author can match them against their diff.
    for (const s of a.sites) console.error(`      ${a.rel}:${s.line}:${s.column}`);
  }
  console.error(
    "\nFix it by keeping the precise type from the boundary inward — parse once,\n" +
      "name the result, and let inference carry it. If the pattern really is right\n" +
      "here, say why at the site, on ONE line (a wrapped `//` comment becomes the\n" +
      "'next line' and the directive misses the code; use /* … */ to wrap):\n\n" +
      "    // oxlint-disable-next-line anti-slop/<rule> -- <why this pattern is correct here>\n",
  );
  if (baseline.absent) {
    console.error(
      `No baseline at ${relative(ROOT, BASELINE)}. To record the CURRENT tree as the starting debt:\n\n` +
        "    node scripts/check-anti-slop.mjs --baseline\n",
    );
  }
}

if (bare.length) {
  failed = true;
  console.error(`\nanti-slop — ${bare.length} disable directive(s) this gate will not accept.\n`);
  console.error(
    "A directive naming an anti-slop rule needs a reason in words after `--`;\n" +
      "a marker or a ticket number alone only hides the question. A directive\n" +
      "naming NO rule switches everything off and is refused outright — name the\n" +
      "rule you mean.\n",
  );
  for (const b of bare) console.error(`  ${b.rel}:${b.line}${b.blanket ? "  (blanket — names no rule)" : "  (no reason)"}\n      ${b.text}`);
}

if (paid.length) {
  // Not a failure in spirit — a paid debt. But the count has to come down, or
  // the list stops meaning anything and a re-introduced site lands pre-approved.
  failed = true;
  console.error(`\nanti-slop — ${paid.length} baseline entr(ies) are higher than the tree. Debt was paid; record it:\n`);
  for (const p of paid) console.error(`  ${p.rel}  ${p.rule}: baseline ${p.known}, now ${p.now}`);
  console.error(`\n  node scripts/check-anti-slop.mjs --baseline\n`);
}

if (!failed) {
  console.log(
    `anti-slop gate: ${findings.length} known finding(s) in ${Object.keys(current).length} file(s), ` +
      `${fileCount} linted, none added.`,
  );
}
process.exit(failed ? 1 : 0);
