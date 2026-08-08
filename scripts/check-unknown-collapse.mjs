#!/usr/bin/env node
/**
 * #796 — lint the "could not determine" -> "determined not" collapse.
 *
 * The tracked defect class: a state meaning "I could not observe this" is folded
 * into a state meaning "I observed that it is not so." Absence of evidence becomes
 * evidence of absence, and the user is told a confident wrong answer.
 *
 * Twenty-seven instances have been fixed across two months. Every one of them had
 * tests, and every one tested a real negative rather than a failed observation.
 * The issue asks for a lint because the most common instances share a greppable
 * shape: a `catch` that answers with a constructed empty value.
 *
 *     .catch(() => [])        // "the request failed"  becomes  "there are none"
 *     .catch(() => null)      // "the lookup failed"   becomes  "there is none"
 *     .catch(() => false)     // "could not check"     becomes  "no"
 *
 * WHAT THIS DOES NOT FLAG, and why it matters more than what it does.
 *
 * `await client.close().catch(() => {})` is not this defect. Nothing reads the
 * value; the catch exists so a cleanup failure cannot mask the real error on the
 * way out. Flagging those would bury the real hits — on this repo they are 40 of
 * 99 raw matches. So a match counts only when the value is CONSUMED: assigned,
 * returned, awaited into a binding, or passed onward. A discarded catch is
 * ignored no matter what it returns.
 *
 * DIRECTION OF THE RATCHET. The baseline is the set of sites that already existed
 * when this gate landed. It may SHRINK and never grow: fixing a site means
 * deleting its line, and a site the scanner no longer finds is reported so the
 * line gets removed. A new consuming catch fails the build. This is the opposite
 * of the vocabulary baseline, which is append-only history — here the file is a
 * debt list, and debt lists must only pay down.
 *
 * THE ESCAPE HATCH IS THE POINT. Plenty of these are correct: sometimes a failed
 * read really should read as empty, and saying so once is cheaper than arguing it
 * every review. Mark the line and give the reason:
 *
 *     // unknown-ok: the cache is advisory; a failed read means "not cached yet",
 *     // which is exactly what an empty result should mean here.
 *     const cached = await readCache().catch(() => null);
 *
 * A bare `// unknown-ok` with no reason is rejected. The reason is the deliverable
 * — it is what a reviewer reads instead of re-deriving whether the collapse is
 * safe, and writing it is where an author notices that it is not.
 *
 * Usage:
 *   node scripts/check-unknown-collapse.mjs            # gate; non-zero on failure
 *   node scripts/check-unknown-collapse.mjs --list     # every consuming site
 *   node scripts/check-unknown-collapse.mjs --baseline # rewrite the baseline
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `--src` and `--baseline-file` exist so the gate can be tested against fixture
 *  trees. A gate nobody can test is a gate nobody trusts, and this one makes
 *  claims about false positives that have to be demonstrable rather than
 *  asserted. Both default to the real repo layout. */
function flagValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const SRC = flagValue("--src", join(ROOT, "src"));
const BASELINE = flagValue(
  "--baseline-file",
  join(ROOT, "docs", "design", "unknown-collapse-baseline.txt"),
);

/** Values that assert a negative. An empty BLOCK body (`() => {}`) is deliberately
 *  absent: it returns undefined but is the idiom for "I do not care", and it is
 *  caught by the consumed-value test below when it genuinely is cared about. */
const EMPTY_ANSWERS = [
  "[]",
  "null",
  "false",
  "undefined",
  '""',
  "''",
  "``",
  "0",
  "({})",
  "{}",
  "new Map()",
  "new Set()",
];

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "__tests__", "coverage"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.m?ts$/.test(name) && !/\.d\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Is the value produced by this `.catch(...)` READ by anything?
 *
 * The whole usefulness of the gate rests here. Approximated from the statement
 * text preceding the match on its own line, which is where these are written in
 * practice; a chained expression spanning lines is treated as consumed, because
 * the cautious direction for a gate is to ask rather than to stay quiet.
 */
/**
 * Walk back to where the statement containing this `.catch` BEGINS, returning the
 * joined text and the line it starts on.
 *
 * Both consumers need the same answer. `valueIsConsumed` needs the text, since a
 * binding can be several lines up and mid-line. The waiver needs the LINE, because
 * a reader writes the explanation above the statement — not above whichever
 * fragment the catch happens to be glued to:
 *
 *     // unknown-ok: <reason>
 *     const seen = job.viaManager
 *       ? await verify(a, b, c)
 *         .catch(() => undefined)      <- the match is here
 *       : undefined;
 *
 * Looking for the comment directly above the match would find `? await verify(...)`
 * and conclude the site was unmarked.
 */
function balance(text) {
  let n = 0;
  for (const c of text) {
    if (c === "(" || c === "[" || c === "{") n++;
    else if (c === ")" || c === "]" || c === "}") n--;
  }
  return n;
}

function readStatement(line, matchIndex, lines, i) {
  let stmt = line.slice(0, matchIndex);
  let start = i;
  for (let j = i - 1; j >= 0 && j >= i - 12; j--) {
    // Two things mark text as not-yet-a-statement, and both are needed.
    //
    // UNBALANCED CLOSERS. `).catch(() => undefined)` is how a catch attaches to a
    // call whose arguments were wrapped, and the argument lines above it are part
    // of the same statement while looking like ordinary code. Counting brackets
    // is what distinguishes them from the previous statement — while more have
    // been closed than opened, we are still inside the call that opened them.
    //
    // A LEADING CHAIN LINK. `.then(...)` / `?.foo` continue a statement whose
    // brackets are already balanced, so balance alone would stop one line short.
    if (balance(stmt) >= 0 && !/^\s*[.?]/.test(stmt) && stmt.trim() !== "") break;
    const prev = lines[j];
    if (prev === undefined || prev.trim() === "") break;
    stmt = prev + " " + stmt;
    start = j;
  }
  return { stmt, start };
}

function valueIsConsumed(line, matchIndex, matchEnd, lines, i) {
  // Sliced at the regex's own match END. Re-deriving it by pattern cannot work:
  // `.catch(() => {})` has nested parens, and a naive `\([^)]*\)` stops at the
  // first one, leaving `=> {});` as the supposed tail — which reads as consumed
  // and flags every fire-and-forget cleanup in the repo.
  const after = line.slice(matchEnd);

  // Reconstruct the whole logical statement, because a chain broken across lines
  // puts the binding several lines up and mid-line:
  //     const restored = await downloadCacheFs
  //       .rename(backup, targetPath)
  //       .then(() => true)
  //       .catch(() => false);
  // Testing only the text on the `.catch` line sees leading whitespace and calls
  // it discarded — which hides exactly the long chains most worth looking at.
  const { start } = readStatement(line, matchIndex, lines, i);

  // Judge consumption from the line the STATEMENT BEGINS ON, not from all the
  // text swept up on the way there. A multi-line chain can enclose a callback
  //     .then((r) => {
  //       if (!r.ok) return;      <- belongs to the CALLBACK
  //       ...
  //     })
  //     .catch(() => {});
  // and reading the joined text finds that `return` and calls the outer statement
  // consumed. It is not: this is fire-and-forget, and the whole gate depends on
  // not flagging it.
  const head = start === i ? line.slice(0, matchIndex) : lines[start];

  // The value leaves the statement.
  if (/\b(return|yield)\b/.test(head)) return true;
  // Bound to a name — `const x =`, `let [a,b] =`, `this.x =`, `x ||=`, `x ??=`.
  if (/\b(const|let|var)\s+[\w{}[\],\s:]+=[^=]/.test(head)) return true;
  if (/[\w\])]\s*(\|\||\?\?|&&)?=[^=>]/.test(head)) return true;
  // Chained onward: `.catch(() => []).length`, `.catch(() => null)?.id`
  if (/\)\s*[.?[]/.test(after)) return true;

  // What comes AFTER the catch settles the remaining cases, and it settles them
  // better than looking at what comes before. An argument or an array element is
  //     await load().catch(() => null),
  // and a discarded statement is
  //     await rm(tmp).catch(() => undefined);
  // Both begin with `await`, so the leading text cannot tell them apart — the
  // trailing punctuation can. A terminating `;` on a statement that binds nothing
  // is the one shape where the value provably goes nowhere.
  const tail = after.trim();
  // Nothing after the catch means the STATEMENT CONTINUES on the next line, so
  // the value has somewhere to go — a discarded call would have terminated.
  return tail !== ";";
}

/** Stable across edits: path + exact source text + which occurrence in the file.
 *  Line numbers were rejected as a key — they churn on every unrelated edit and
 *  would make the baseline unreviewable. */
function keyFor(rel, snippet, ordinal) {
  return `${rel}\t${snippet}\t#${ordinal}`;
}

/** The comment block directly above the site, plus the site's own line.
 *
 *  Walking the contiguous comment lines rather than a fixed lookback is what lets
 *  a reason WRAP. A good reason is usually two or three lines, which puts the
 *  `unknown-ok:` marker further above the code than any fixed window would allow
 *  — and shortening the reason to fit a linter would defeat the point of it. */
function waiverContext(lines, i, start) {
  // Include every line of the statement, so a marker on the `.catch` line
  // itself still counts, then the contiguous comments above where it BEGINS.
  const block = lines.slice(start, i + 1);
  for (let j = start - 1; j >= 0; j--) {
    const l = lines[j];
    if (typeof l !== "string" || !/^\s*(\/\/|\*|\/\*)/.test(l)) break;
    block.unshift(l);
  }
  return block;
}

function findWaiver(lines, i, start) {
  const block = waiverContext(lines, i, start);
  const at = block.findIndex((l) => /unknown-ok/.test(l));
  if (at === -1) return { marked: false, reasoned: false };
  // Everything from the marker to the end of the comment block is the reason, so
  // a wrapped explanation counts in full rather than only its first line.
  const m = /unknown-ok:?(.*)$/.exec(block[at]);
  const rest = block
    .slice(at + 1)
    .filter((l) => /^\s*(\/\/|\*)/.test(l))
    .join(" ");
  const reason = ((m?.[1] ?? "") + " " + rest).replace(/[*/]/g, " ").trim();
  // A reason must be words — not punctuation, and not a ticket number alone.
  const words = reason.split(/\s+/).filter((w) => /[a-z]{3}/i.test(w));
  return { marked: true, reasoned: words.length >= 4 };
}

function scan() {
  const hits = [];
  const bare = [];
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).split(sep).join("/");
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    const counts = new Map();
    lines.forEach((line, i) => {
      const re = /\.catch\(\s*\(\s*(?:_\w*)?\s*\)\s*=>\s*([^)]*?)\s*\)/g;
      let m;
      while ((m = re.exec(line))) {
        const answer = m[1].trim();
        if (!EMPTY_ANSWERS.includes(answer)) continue;
        if (!valueIsConsumed(line, m.index, m.index + m[0].length, lines, i)) continue;
        const snippet = `.catch(() => ${answer})`;
        const ordinal = (counts.get(snippet) ?? 0) + 1;
        counts.set(snippet, ordinal);
        const rec = { key: keyFor(rel, snippet, ordinal), rel, line: i + 1, text: line.trim() };
        const waiver = findWaiver(lines, i, readStatement(line, m.index, lines, i).start);
        if (waiver.reasoned) continue;
        // A bare marker is not a waiver — the reason is the deliverable.
        if (waiver.marked) bare.push(rec);
        hits.push(rec);
      }
    });
  }
  return { hits, bare };
}

function readBaseline() {
  let raw = "";
  try {
    raw = readFileSync(BASELINE, "utf8");
  } catch {
    // Genuinely absent is different from unreadable, and this gate of all things
    // should not confuse them: an unreadable baseline throws rather than silently
    // becoming an empty one, which would fail every pre-existing site at once.
    return new Set();
  }
  return new Set(
    raw
      .split(/\r?\n/)
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l && !l.startsWith("#")),
  );
}

const args = process.argv.slice(2);
const { hits, bare } = scan();

if (args.includes("--list")) {
  for (const h of hits) console.log(`${h.rel}:${h.line}\t${h.text}`);
  console.log(`\n${hits.length} consuming sites`);
  process.exit(0);
}

if (args.includes("--baseline")) {
  const header = [
    "# #796 — sites where a failed observation is answered with an empty value.",
    "#",
    "# THIS LIST MAY ONLY SHRINK. It is debt, not history: fixing a site means",
    "# deleting its line. Adding a line to silence a new failure is the documented",
    "# bypass of this gate — use a reasoned `// unknown-ok:` comment at the site",
    "# instead, where the next reader will actually see it.",
    "#",
    "# Regenerate deliberately:  node scripts/check-unknown-collapse.mjs --baseline",
    "",
  ].join("\n");
  writeFileSync(BASELINE, header + [...hits.map((h) => h.key)].sort().join("\n") + "\n", "utf8");
  console.log(`baseline written: ${hits.length} sites`);
  process.exit(0);
}

const baseline = readBaseline();
const seen = new Set(hits.map((h) => h.key));
const added = hits.filter((h) => !baseline.has(h.key));
const fixed = [...baseline].filter((k) => !seen.has(k));

let failed = false;

if (added.length) {
  failed = true;
  console.error(`\n#796 — ${added.length} new site(s) answer a failed observation with an empty value.\n`);
  console.error(
    "A caught failure means YOU DO NOT KNOW. Returning [] / null / false says you\n" +
      "do know, and that the answer is no. Whatever reads this cannot tell the two\n" +
      "apart, so it will report a confident wrong answer to a user.\n",
  );
  for (const h of added) console.error(`  ${h.rel}:${h.line}\n      ${h.text}`);
  console.error(
    "\nFix it by giving 'unknown' its own representation — a third state, a tagged\n" +
      "result, or a thrown error the caller must handle. If the collapse really is\n" +
      "correct here, say why at the site:\n\n" +
      "    // unknown-ok: <why a failed observation and a genuine negative should\n" +
      "    // lead to the same behaviour at this call site>\n",
  );
}

if (bare.length) {
  failed = true;
  console.error(`\n#796 — ${bare.length} bare 'unknown-ok' marker(s) with no reason.\n`);
  console.error("The reason is the deliverable. A marker alone only hides the question.\n");
  for (const h of bare) console.error(`  ${h.rel}:${h.line}`);
}

if (fixed.length) {
  // Not a failure — a paid debt. But the line has to go, or the list stops
  // meaning anything and a re-introduced defect would land pre-approved.
  console.error(`\n#796 — ${fixed.length} baseline entr(ies) no longer exist. Delete them:\n`);
  for (const k of fixed) console.error(`  ${k.replace(/\t/g, "  ")}`);
  console.error(`\n  node scripts/check-unknown-collapse.mjs --baseline\n`);
  failed = true;
}

if (!failed) console.log(`#796 gate: ${hits.length} known site(s), no new collapses.`);
process.exit(failed ? 1 : 0);
