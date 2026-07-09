#!/usr/bin/env node
// Hybrid changelog generator, wired into the release flow.
//
//   node scripts/gen-changelog.mjs <version>
//
// It stamps a dated section for <version> at the top of CHANGELOG.md by:
//   1. Promoting whatever you hand-wrote under "## [Unreleased]" VERBATIM
//      (your highlights — the rich prose we care about), then
//   2. Appending anything in the git history since the last tag that your
//      highlights didn't already mention (deduped by PR number), grouped into
//      COMPONENT sections (MCP / RunPod image) and Keep-a-Changelog buckets
//      (Added / Fixed / Changed) from the conventional-commit type.
//   3. Resetting "## [Unreleased]" to an empty stub.
//
// So nothing in the history is ever missed, and your hand-written notes are
// never clobbered. Idempotent-ish: safe to re-run before the version is tagged.
//
// Repo config (COMPONENTS) below decides how a commit maps to a section — this
// file is the comfyui-mcp variant (MCP + RunPod); the panel ships its own.

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG = join(ROOT, "CHANGELOG.md");

// ── Repo config ─────────────────────────────────────────────────────────────
// First matching component wins; the last (match:()=>true) is the fallback.
const COMPONENTS = [
  { name: "RunPod image", match: (scope) => /^runpod/.test(scope || "") },
  { name: "MCP", match: () => true },
];
// conventional-commit type → Keep-a-Changelog bucket. Types not listed are
// dropped from the changelog (chore/ci/test/build/style/docs housekeeping).
const TYPE_SECTION = {
  feat: "Added",
  fix: "Fixed",
  perf: "Changed",
  refactor: "Changed",
  revert: "Changed",
};
const SECTION_ORDER = ["Added", "Fixed", "Changed"];

// ── helpers ──────────────────────────────────────────────────────────────────
// stderr ignored: several queries (e.g. describe with no tags) fail by design and are try/caught.
const git = (args) => execSync(`git ${args}`, { cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** The ref to diff against = the previous release. Prefer the most recent
 *  version tag (mcp); fall back to the most recent release commit (the panel
 *  has no per-release tags); else the first commit. */
function prevTag() {
  try {
    const t = git("describe --tags --abbrev=0");
    if (t) return t;
  } catch {
    /* no tags */
  }
  try {
    const sha = git('log -1 --pretty=format:%H --grep="^\\(chore(release)\\|release\\):"');
    if (/^[0-9a-f]{7,40}$/.test(sha)) return sha;
  } catch {
    /* no release commit */
  }
  return git("rev-list --max-parents=0 HEAD").split(/\s+/)[0]; // first commit
}

/** Parsed conventional commits since `range`, newest-first, minus noise. */
function parseCommits(range) {
  const raw = git(`log ${range} --no-merges --pretty=format:%s`);
  if (!raw) return [];
  const out = [];
  for (const subject of raw.split("\n")) {
    if (/^release:/i.test(subject)) continue; // release commits describe themselves
    const m = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
    if (!m) continue; // non-conventional → skip (usually already covered by a PR merge)
    const [, type, scope, , desc] = m;
    const section = TYPE_SECTION[type.toLowerCase()];
    if (!section) continue;
    const pr = (desc.match(/\(#(\d+)\)/) || [])[1] || null;
    out.push({ type, scope: scope || "", desc: desc.trim(), section, pr });
  }
  return out;
}

function componentOf(scope) {
  return (COMPONENTS.find((c) => c.match(scope)) || COMPONENTS[COMPONENTS.length - 1]).name;
}

/** Build the auto-generated component/section body for commits not already
 *  covered by the hand-written highlights (deduped by PR number). */
function autoBody(commits, coveredPRs) {
  const fresh = commits.filter((c) => !(c.pr && coveredPRs.has(c.pr)));
  if (fresh.length === 0) return "";
  // component -> section -> bullets[]
  const byComp = new Map();
  for (const c of fresh) {
    const comp = componentOf(c.scope);
    if (!byComp.has(comp)) byComp.set(comp, new Map());
    const secs = byComp.get(comp);
    if (!secs.has(c.section)) secs.set(c.section, []);
    secs.get(c.section).push(`- ${c.desc}`);
  }
  // Single-component repos (e.g. the panel) read cleaner with flat `### Added`
  // headers; multi-component repos (mcp) nest `### Component` > `#### Added`.
  const single = COMPONENTS.length === 1;
  const lines = [];
  for (const comp of COMPONENTS.map((c) => c.name)) {
    const secs = byComp.get(comp);
    if (!secs) continue;
    if (!single) lines.push(`### ${comp}`, "");
    for (const section of SECTION_ORDER) {
      const bullets = secs.get(section);
      if (!bullets) continue;
      lines.push(single ? `### ${section}` : `#### ${section}`, ...bullets, "");
    }
  }
  return lines.join("\n").trimEnd();
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── main ─────────────────────────────────────────────────────────────────────
const backfill = process.argv.includes("--backfill");
const version = (process.argv.find((a) => /^v?\d+\.\d+\.\d+/.test(a)) || "").replace(/^v/, "");
if (!backfill && !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`usage: node scripts/gen-changelog.mjs <version> | --backfill`);
  process.exit(1);
}
// Preserve the file's own line-ending convention (mcp is CRLF, panel LF): work
// in LF internally, restore on write so we never spuriously rewrite the whole file.
const rawMd = readFileSync(CHANGELOG, "utf-8");
const EOL = rawMd.includes("\r\n") ? "\r\n" : "\n";
const writeChangelog = (s) => writeFileSync(CHANGELOG, EOL === "\r\n" ? s.replace(/\n/g, "\r\n") : s);

/** Build a dated entry string for `ver` from commits in `range`, folding in any
 *  hand-written highlights (deduped by PR). */
function buildEntry(ver, range, highlights = "") {
  const covered = new Set([...highlights.matchAll(/\(#(\d+)\)/g)].map((m) => m[1]));
  const commits = parseCommits(range);
  const auto = autoBody(commits, covered);
  const parts = [`## [${ver}] - ${today()}`, ""];
  if (highlights) parts.push(highlights, "");
  if (auto) parts.push(auto, "");
  if (!highlights && !auto) parts.push("_No user-facing changes._", "");
  return { text: parts.join("\n").trimEnd(), commits };
}

const md = rawMd.replace(/\r\n/g, "\n"); // normalized (LF) for matching + building
// Accept both "## [Unreleased]" (panel) and "## Unreleased" (mcp); preserve the
// exact header text so we don't reformat the file's own convention.
const UNREL = /(##[ \t]*(?:\[Unreleased\]|Unreleased))[ \t]*\n([\s\S]*?)(?=\n##[ \t]|\n<!-- end -->|$)/i;
const um = md.match(UNREL);
if (!um) {
  console.error("could not find an '## Unreleased' (or '## [Unreleased]') section in CHANGELOG.md");
  process.exit(1);
}
const unrelHeader = um[1]; // e.g. "## Unreleased" or "## [Unreleased]"
const highlights = um[2].trim();

if (backfill) {
  // One-time repair: emit a dated entry for every tag NEWER than the newest one
  // already in the CHANGELOG, oldest→newest, from the commits between tags.
  const tags = git("tag --sort=creatordate")
    .split("\n")
    .filter((t) => /^v?\d+\.\d+\.\d+$/.test(t));
  // Only catch up the changelog from where it left off — the newest version it
  // already documents. Don't resurrect ancient pre-changelog tags.
  const cmp = (a, b) => {
    const pa = a.split("."), pb = b.split(".");
    for (let i = 0; i < 3; i++) if (+pa[i] !== +pb[i]) return +pa[i] - +pb[i];
    return 0;
  };
  const documented = [...md.matchAll(/##\s*\[(\d+\.\d+\.\d+)\]/g)].map((m) => m[1]);
  const newest = documented.sort(cmp).pop() || "0.0.0";
  const missing = tags.filter(
    (t) => cmp(t.replace(/^v/, ""), newest) > 0 && !md.includes(`## [${t.replace(/^v/, "")}]`),
  );
  if (missing.length === 0) {
    console.log("backfill: nothing missing.");
    process.exit(0);
  }
  const blocks = [];
  for (let i = 0; i < missing.length; i++) {
    const tag = missing[i];
    const idx = tags.indexOf(tag);
    const prev = tags[idx - 1];
    const range = prev ? `${prev}..${tag}` : tag;
    blocks.push(buildEntry(tag.replace(/^v/, ""), range).text);
  }
  // newest first under Unreleased
  const body = blocks.reverse().join("\n\n");
  const next = md.replace(UNREL, `${unrelHeader}\n\n${body}\n\n`);
  writeChangelog(next);
  console.log(`backfill: added ${missing.length} missing version(s): ${missing.join(", ")}`);
  process.exit(0);
}

if (!version) {
  // REFRESH mode (no version arg): fold commits since the last tag into
  // [Unreleased] without stamping a version — keeps the changelog warm between
  // releases (e.g. after a runpod:release). Idempotent: items already present
  // (by PR number or exact text) are not re-added.
  const covered = new Set([...highlights.matchAll(/\(#(\d+)\)/g)].map((m) => m[1]));
  const commits = parseCommits(`${prevTag()}..HEAD`).filter(
    (c) => !(c.pr && covered.has(c.pr)) && !highlights.includes(c.desc),
  );
  const auto = autoBody(commits, new Set());
  if (!auto) {
    console.log("changelog: [Unreleased] already covers every commit since " + prevTag());
    process.exit(0);
  }
  const body = [highlights, auto].filter(Boolean).join("\n\n");
  writeChangelog(md.replace(UNREL, `${unrelHeader}\n\n${body}\n\n`));
  console.log(`changelog: refreshed [Unreleased] with ${commits.length} new commit(s) since ${prevTag()}`);
  process.exit(0);
}

if (md.includes(`## [${version}]`)) {
  console.error(`CHANGELOG already has a [${version}] section — nothing to do.`);
  process.exit(0);
}

const { text: entry, commits } = buildEntry(version, `${prevTag()}..HEAD`, highlights);
const next = md.replace(UNREL, `${unrelHeader}\n\n${entry}\n\n`);
writeChangelog(next);

const nComp = new Set(commits.map((c) => componentOf(c.scope))).size;
console.log(
  `changelog: wrote [${version}] — ${highlights ? "kept hand-written highlights + " : ""}${
    commits.length
  } commit(s) across ${nComp} component(s) since ${prevTag()}`,
);
