#!/usr/bin/env node
/**
 * Verify the release section that is about to ship — or that just did.
 *
 *   node scripts/check-changelog.mjs [version] [--ref <git-ref>]
 *
 * WHY THIS EXISTS (#2407). gen-changelog.mjs is a generator; nothing verified its
 * output. On one evening three cuts went wrong the same way, and every one of them
 * was invisible:
 *
 *   0.52.133  shipped #2378 and did not list it        (hand-corrected by #2384)
 *   0.52.134  cut to carry a fix that had ALREADY shipped — no code changes at all
 *   0.52.138  shipped #2400 and did not list it        (hand-corrected by #2406)
 *
 * All three are one race: a PR merges between the release branch being cut and the
 * release PR merging. Ancestry then resolves itself — the branch merges into main,
 * so the tag gets the code — which is exactly why nobody notices. The CHANGELOG is
 * the only thing that gaps, and it gaps silently. 0.52.134 is the instructive one:
 * reading a notes gap as "the fix has not shipped yet" produced a whole no-op
 * version, the opposite error from the same root cause.
 *
 * TWO DIRECTIONS, and the second is the one that catches the above:
 *
 *   A. Everything CITED must be REACHABLE. A `## [X]` entry naming PR #N must have
 *      a commit carrying #N that is an ancestor of vX. Ported from the panel
 *      (comfyui-mcp-panel#1894); catches an entry credited to a release that does
 *      not contain it.
 *   B. Everything REACHABLE must be CITED. Every commit in `v<prev>..vX` that names
 *      a PR must be mentioned in [X]. The panel does not implement this half. A
 *      MISSING entry is a different failure from a wrong one, and it is the one
 *      that shipped three times.
 *
 * Plus the structural checks a hand-edited section needs: no version with two
 * sections, no heading repeated inside one, no PR credited twice.
 *
 * The audit is a pure function with `isAncestor` and both commit lists injected, so
 * it is tested against synthetic histories rather than against this repo's own
 * CHANGELOG — a guard whose only test subject is the file it guards can only be
 * exercised by breaking a release.
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { isReleaseSubject } from "./lib/release-subject.mjs";
import {
  ambiguousReferences,
  canonicalReference,
  commitReferences,
  isReleaseMerge,
  mentionedNumbers,
  mergeReferences,
  referenceAliases,
  referenceNumbers,
} from "./lib/changelog-refs.mjs";

const SCRIPT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// COMFYUI_MCP_CHANGELOG_ROOT is the override gen-changelog.mjs already takes, for
// the same reason it takes one: without it the only way to exercise this is to cut
// a release and read the result.
const ROOT = resolve(
  process.env.COMFYUI_MCP_CHANGELOG_ROOT || process.env.CHANGELOG_ROOT || SCRIPT_ROOT,
);
const CHANGELOG = join(ROOT, "CHANGELOG.md");

const gitAt = (root, ...gitArgs) =>
  execFileSync("git", ["-C", root, ...gitArgs], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const git = (...gitArgs) => gitAt(ROOT, ...gitArgs);

// ── parsing ──────────────────────────────────────────────────────────────────

/** `## [X] - date` sections, with the body lines that follow each. */
export function parseReleaseSections(markdown) {
  // mcp's CHANGELOG.md is CRLF and the panel's is LF. Normalise, or a heading
  // regex anchored with $ silently matches nothing in one of the two repos.
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const releases = [];
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##\s+\[([^\]]+)\](?:\s*-\s*(\S+))?/.exec(lines[index]);
    if (!match) continue;
    if (current) current.lines = lines.slice(current.start + 1, index);
    current = { version: match[1].trim(), date: match[2] ?? null, start: index, lines: [] };
    releases.push(current);
  }
  if (current) current.lines = lines.slice(current.start + 1);
  return releases;
}

/** Headings and bullet entries inside one release body. */
export function parseReleaseBody(lines) {
  const headings = [];
  const entries = [];
  let section = null;
  let entry = null;
  // A heading's identity is its PATH, not its text. gen-changelog nests
  // `### <component>` > `#### <bucket>` for this repo's two components, so a
  // release touching both emits `#### Fixed` twice — once under `### MCP`, once
  // under `### RunPod image`. That is correct generated output, and keying
  // uniqueness on level+text alone rejected it: [0.50.37] is a real shipped
  // section that fails that way. Refusing a valid release is the direction that
  // blocks a good publish, so siblings are told apart by their parents.
  const openHeadings = [];

  const flush = () => {
    if (!entry) return;
    entries.push({ ...entry, text: entry.lines.join("\n").trim() });
    entry = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = /^(#{3,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      while (openHeadings.length && openHeadings.at(-1).level >= level) openHeadings.pop();
      const path = [...openHeadings, { level, text: heading[2] }]
        .map((item) => `${item.level}:${item.text.toLowerCase()}`)
        .join(" > ");
      section = { level, text: heading[2], line: index + 1, path };
      openHeadings.push(section);
      headings.push(section);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flush();
      entry = { section, line: index + 1, lines: [line.replace(/^[-*]\s+/, "")] };
      continue;
    }
    // A continuation line is blank or indented; anything else ends the entry.
    if (entry && (line.trim() === "" || /^\s+\S/.test(line))) entry.lines.push(line.trim());
    else if (entry) flush();
  }
  flush();
  return { headings, entries };
}

/** `<sha>\x1f<subject>\x1e…` from git log, which cannot be split on newlines. */
export function parseCommitSubjects(output) {
  return String(output ?? "")
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const separator = record.indexOf("\x1f");
      const sha = separator >= 0 ? record.slice(0, separator) : "";
      const subject = separator >= 0 ? record.slice(separator + 1) : record;
      return { sha, subject, refs: commitReferences(subject) };
    });
}

const semverIdentifier = "(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const strictSemver = new RegExp(
  `^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-${semverIdentifier}(?:\\.${semverIdentifier})*)?$`,
);

export const releaseVersion = (version) => String(version ?? "").replace(/^v/, "");
export const isStrictSemver = (version) => strictSemver.test(releaseVersion(version));

// ── the audit ────────────────────────────────────────────────────────────────

/**
 * @param markdown      CHANGELOG.md contents to audit
 * @param version       which release section to audit
 * @param commits       every commit reachable from targetRef (alias + ancestry pool)
 * @param rangeCommits  commits in previousRef..targetRef with no merges (coverage
 *                      pool), or null when the range could not be resolved
 * @param targetRef     the ref this section claims to describe
 * @param previousRef   the ref the release is measured from, for the message
 * @param historyComplete  false when `commits` is truncated or unreadable, which
 *                      makes reachability unanswerable rather than false
 * @param isAncestor    (sha, ref) => boolean
 */
export function auditReleaseSection({
  markdown,
  version,
  commits = [],
  rangeCommits = null,
  targetRef,
  previousRef,
  historyComplete = true,
  isAncestor = () => true,
}) {
  const normalizedVersion = releaseVersion(version);
  const sections = parseReleaseSections(markdown);
  const violations = [];

  // One version, one section. A hand-edited reconcile has produced two before.
  const seenReleaseSections = new Map();
  for (const item of sections) {
    const itemVersion = releaseVersion(item.version);
    if (!isStrictSemver(itemVersion)) continue;
    const line = item.start + 1;
    if (seenReleaseSections.has(itemVersion)) {
      violations.push(
        `CHANGELOG.md repeats the [${itemVersion}] release section at lines ` +
          `${seenReleaseSections.get(itemVersion)} and ${line}. Keep one top-level section.`,
      );
    } else {
      seenReleaseSections.set(itemVersion, line);
    }
  }

  const section = sections.find((item) => releaseVersion(item.version) === normalizedVersion);
  if (!section) {
    return [...violations, `CHANGELOG.md has no [${normalizedVersion}] release section.`];
  }
  if (!section.lines.some((line) => line.trim())) {
    return [...violations, `CHANGELOG.md [${normalizedVersion}] release section is empty.`];
  }

  const { headings, entries } = parseReleaseBody(section.lines);
  const aliases = referenceAliases(commits);
  const canonical = (ref) => canonicalReference(ref, aliases);

  const seenHeadings = new Map();
  for (const heading of headings) {
    const key = heading.path;
    const line = section.start + heading.line;
    if (seenHeadings.has(key)) {
      violations.push(
        `[${normalizedVersion}] repeats the heading "${heading.text}" at lines ` +
          `${seenHeadings.get(key)} and ${line}. Merge the two blocks.`,
      );
    } else {
      seenHeadings.set(key, line);
    }
  }

  const seenReferences = new Map();
  for (const item of entries) {
    const keys = [...new Set(referenceNumbers(item.text).map(canonical))];
    const line = section.start + item.line;
    for (const key of keys) {
      if (seenReferences.has(key)) {
        violations.push(
          `[${normalizedVersion}] credits issue/PR identity #${key} twice, at lines ` +
            `${seenReferences.get(key)} and ${line}.`,
        );
      } else {
        seenReferences.set(key, line);
      }
    }
  }

  // A. Everything CITED must be REACHABLE from the ref this section describes.
  //
  // Gated on a COMPLETE history, because a truncated one cannot distinguish "this
  // entry is credited to the wrong release" from "that commit is simply not in my
  // pool". A depth-1 clone holds one commit, so every entry in the section looks
  // unreachable: the guard reported #2398, #2399 and #2400 as bogus on a shallow
  // checkout of this very branch, which fails a CORRECT release. Skipping coverage
  // alone was not enough — and worse, saying so implied reachability had been
  // checked when it had been checked against nothing.
  const byRef = new Map();
  for (const commit of commits) {
    for (const ref of commit.refs) {
      if (!byRef.has(ref)) byRef.set(ref, []);
      byRef.get(ref).push(commit);
    }
  }
  const shippedHere = rangeCommits && new Set(rangeCommits.map((commit) => commit.sha));
  for (const item of historyComplete ? entries : []) {
    // EVERY parenthesised citation, not only the trailing one. `(#2382, #2387)`
    // names two shipped changes, and checking just the last let an unreachable
    // first citation hide behind a reachable second — a wrong credit surviving the
    // half built to catch wrong credits. Measured across sixteen releases: this
    // adds ZERO violations, so the extra strictness costs no noise. Bare `#N` in
    // prose is deliberately NOT ancestry-checked; that is commentary rather than a
    // citation, and 0.52.135's "credit #2378 to 0.52.133, where it shipped" is a
    // correct note about a ref that is legitimately unreachable from that tag.
    const refs = [...new Set(referenceNumbers(item.text))];
    const line = section.start + item.line;
    for (const pr of refs) {
      const candidates = byRef.get(pr) ?? [];
      if (!candidates.length) {
        violations.push(
          `[${normalizedVersion}] entry at line ${line} names PR #${pr}, but no commit reachable ` +
            `from ${targetRef} carries that reference.`,
        );
        continue;
      }
      if (!candidates.some((candidate) => isAncestor(candidate.sha, targetRef))) {
        violations.push(
          `[${normalizedVersion}] entry at line ${line} names PR #${pr}, but no commit carrying it ` +
            `is an ancestor of ${targetRef} — it did not ship in this release.`,
        );
        continue;
      }
      // Reachable is not the same as SHIPPED HERE. Every earlier release is
      // reachable from this tag, so an entry crediting this version with a change
      // that landed two releases ago passes the ancestry test — which is the
      // 0.52.134 mistake exactly. [0.52.133] credits itself with #2196, whose
      // commit is not in v0.52.132..v0.52.133 at all; its real work was #2376.
      if (shippedHere && !candidates.some((candidate) => shippedHere.has(candidate.sha))) {
        violations.push(
          `[${normalizedVersion}] entry at line ${line} names PR #${pr}, but the commit carrying ` +
            `it is not in ${previousRef}..${targetRef} — it shipped in an earlier release.`,
        );
      }
    }
  }

  // B. Everything REACHABLE must be CITED. The half that catches a silent gap.
  if (rangeCommits) {
    // An umbrella issue vouches for NOTHING. It has several PRs in this history, so
    // one entry citing it would satisfy coverage for every one of them and hide all
    // but the first — the shape where a fix on one exit leaves its siblings behind.
    // referenceAliases already refuses to ALIAS these; refusing to alias is not
    // refusing to vouch, which is the hole this closes.
    const ambiguous = ambiguousReferences(commits);
    const mentioned = new Set(mentionedNumbers(section.lines.join("\n")).map(canonical));
    for (const commit of rangeCommits) {
      // A release describes itself, not something it contains. `v<prev>..<target>`
      // includes the target, so X's own release commit is always in this range — and
      // in the merge-commit flow, so is the merge that landed the release branch.
      if (isReleaseSubject(commit.subject) || isReleaseMerge(commit.subject)) continue;
      // A squash carries its PR as `(#N)`; a REAL merge carries it as a bare `#N` on
      // `Merge pull request #N from …`, which commitReferences resolves and the
      // parenthesised form never sees. Four PRs shipped that way across sixteen
      // releases (#2294, #2307, #2326, #2340) and none of them is in the changelog.
      // Anything with no reference at all is a local commit a squash superseded —
      // gen-changelog drops those too, and the two must agree or the guard fights
      // its own generator.
      // The fallback is for MERGE subjects specifically, not for anything whose
      // refs happen to be non-empty. Reading commit.refs here also swallowed a
      // numeric conventional SCOPE: `fix(2333): a UUID redacts its whole token`
      // carries no PR at all — 2333 is the issue — and the guard demanded the
      // changelog cite #2333 as though it were one. That commit is a local step
      // inside merge #2294, and 0.52.124 was flagged for it.
      const cited = referenceNumbers(commit.subject);
      const shipped = cited.length ? cited : mergeReferences(commit.subject);
      if (!shipped.length) continue;
      // What this commit IS, as opposed to what it merely references.
      const identity = shipped.at(-1);
      const covered = commit.refs.some((ref) => {
        if (!mentioned.has(canonical(ref))) return false;
        // An umbrella issue vouches only for ITSELF. Citing #2393 documents the
        // commits whose sole identity is #2393, but it must not stand in for
        // #2400 and #2409 — two separate fixes, one of them then invisible.
        // Excluding ambiguous references outright was the first attempt and it
        // over-fired: six commits in 0.52.125 carry #2313 as their ONLY reference,
        // shipped under merge #2340, and citing #2313 is the only way they are
        // documentable at all. That release is correctly written and must stay green.
        return !ambiguous.has(ref) || ref === identity;
      });
      if (covered) continue;
      violations.push(
        `[${normalizedVersion}] does not mention PR #${shipped.at(-1)}, which shipped in this ` +
          `release (reachable from ${targetRef}, not from ${previousRef}): "${commit.subject}". ` +
          `Add the entry, or add #${shipped.at(-1)} to the entry that already covers it.`,
      );
    }
  }

  return violations;
}

/** Name parity with the panel's guard, which the port started from. */
export const checkChangelog = auditReleaseSection;

// ── CLI ──────────────────────────────────────────────────────────────────────

function readCommits(ref, runGit = git) {
  const commit = runGit("rev-parse", "--verify", ref + "^{commit}");
  return parseCommitSubjects(runGit("log", "--format=%H%x1f%s%x1e", commit));
}

function gitErrorMessage(error) {
  const detail = error?.stderr || error?.message || error;
  return String(detail).trim().split(/\r?\n/, 1)[0];
}

function classifiedGitError(phase, error) {
  const classified = new Error(phase + ": " + gitErrorMessage(error), { cause: error });
  classified.phase = phase;
  return classified;
}

function isMissingPreviousReleaseTag(error) {
  return (
    error?.status === 128 &&
    /No names found, cannot describe anything|No tags can describe/i.test(gitErrorMessage(error))
  );
}

function resolveTargetRef({ version, explicitRef = null, runGit = git }) {
  if (explicitRef) return explicitRef;

  const tag = "v" + version;
  try {
    runGit("show-ref", "--verify", "--quiet", "refs/tags/" + tag);
  } catch (error) {
    if (error?.status === 1) return "HEAD";
    throw classifiedGitError("target tag " + tag + " lookup failed", error);
  }

  try {
    runGit("rev-parse", "--verify", tag + "^{commit}");
  } catch (error) {
    throw classifiedGitError("target tag " + tag + " lookup failed", error);
  }
  return tag;
}

function probeShallowRepository({ runGit = git } = {}) {
  try {
    return {
      status: "ok",
      shallow: runGit("rev-parse", "--is-shallow-repository") === "true",
    };
  } catch (error) {
    return { status: "error", error: classifiedGitError("git shallow-history probe failed", error) };
  }
}

export function main(argv, { runGit = git, root = ROOT, changelog = CHANGELOG } = {}) {
  const args = argv.slice(2);
  const refIndex = args.indexOf("--ref");
  const refValueIndex = refIndex >= 0 ? refIndex + 1 : -1;
  const explicitRef = refIndex >= 0 ? args[refValueIndex] : null;
  // Option-shaped leftovers stay in the version candidates so `--bad-version` is
  // REJECTED rather than ignored — ignoring it would silently audit a different
  // section than the caller named.
  const versionArgs = args.filter((_, index) => index !== refIndex && index !== refValueIndex);

  if (refIndex >= 0 && !explicitRef) {
    console.error("changelog: --ref requires a Git commit ref");
    return 2;
  }
  if (versionArgs.length > 1) {
    console.error("changelog: expected at most one release version argument");
    return 2;
  }

  let markdown;
  if (explicitRef) {
    try {
      runGit("rev-parse", "--verify", `${explicitRef}^{commit}`);
      markdown = runGit("show", `${explicitRef}:CHANGELOG.md`);
    } catch (error) {
      console.error(
        `changelog: could not read CHANGELOG.md at ${explicitRef}: ${String(error.message).split("\n")[0]}`,
      );
      return 1;
    }
  } else {
    markdown = readFileSync(changelog, "utf8");
  }

  let version;
  if (versionArgs.length === 1) {
    version = releaseVersion(versionArgs[0]);
    if (!isStrictSemver(version)) {
      console.error(`changelog: invalid release version "${versionArgs[0]}"; expected strict SemVer`);
      return 2;
    }
  } else {
    // What is BEING RELEASED, not whichever section happens to be newest.
    //
    // Taking the newest section meant a cut that wrote no section at all was
    // audited as its PREDECESSOR — and passed, because the predecessor is fine.
    // The one release with no notes whatsoever is exactly the one that must fail.
    // package.json is the authority: `npm version` bumps it and gen-changelog
    // stamps the matching section, so the two agree on every healthy release, and
    // a missing section becomes "has no [X] release section" instead of silence.
    //
    // With --ref the working tree's package.json describes a different commit, so
    // the tag name is the authority there instead.
    const fromRef = explicitRef && /^v?\d+\.\d+\.\d+/.test(explicitRef) ? explicitRef : null;
    let fromPackage = null;
    if (!fromRef) {
      try {
        fromPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
      } catch {
        fromPackage = null;
      }
    }
    version = releaseVersion(
      fromRef ??
        fromPackage ??
        parseReleaseSections(markdown).find((item) => isStrictSemver(item.version))?.version,
    );
  }
  if (!version) {
    console.error("usage: node scripts/check-changelog.mjs [version] [--ref <git-ref>]");
    return 2;
  }

  let commits = [];
  let rangeCommits = null;
  let previousRef = null;
  // "There is no repository here" and "the repository is there and git FAILED" are
  // different answers and must not share an exit code. A source tarball or a zip
  // download legitimately has no .git and nothing to verify against, so it skips.
  // An EPERM, a corrupt object store or a missing git binary is an ERROR — and
  // letting that exit 0 turns run-checks' green tick into a gate that passed
  // because it could not look, which is the whole failure this guard exists to
  // stop, aimed at itself.
  // Asked of the FILESYSTEM, not of git. Asking git is circular: if git cannot be
  // executed at all (`spawnSync git EPERM` — the case that prompted this), then
  // `rev-parse --is-inside-work-tree` fails too and the broken state reads as "no
  // repository here", which is the exact pass this is meant to prevent. Deleting
  // .git/objects reproduces the same trap: git then reports "not a git repository"
  // even though the checkout plainly is one. `.git` is a directory in a normal
  // clone and a FILE in a git worktree; existsSync answers both.
  const repositoryPresent =
    existsSync(join(root, ".git")) ||
    (() => {
      try {
        return runGit("rev-parse", "--is-inside-work-tree") === "true";
      } catch {
        return false;
      }
    })();

  // Only a proven missing target tag may use HEAD. A failed lookup means the
  // target commit was not reliably identified and must fail closed.
  let targetRef = explicitRef;
  if (!targetRef && repositoryPresent) {
    try {
      targetRef = resolveTargetRef({ version, runGit });
    } catch (error) {
      console.error(
        "changelog: " + error.message + ". Refusing to report a pass on a check " +
          "that could not identify its target commit.",
      );
      return 1;
    }
  } else if (!targetRef) {
    targetRef = "HEAD";
  }

  try {
    commits = readCommits(targetRef, runGit);
  } catch (error) {
    if (repositoryPresent) {
      console.error(
        `changelog: git failed inside a repository at ${targetRef} ` +
          `(${String(error.message).split("\n")[0]}). Refusing to report a pass on a ` +
          `check that could not run.`,
      );
      return 1;
    }
    // Loud, and never confusable with a pass: name the halves that did not run.
    console.error(
      `changelog: could not read history at ${targetRef} ` +
        `(${String(error.message).split("\n")[0]}) — structure was checked, ` +
        `reachability and coverage were NOT.`,
    );
  }

  // A shallow clone cannot answer "what shipped since the last release". It can
  // only answer it WRONG, by reporting every PR as missing. Probe failure is not
  // evidence of a full clone, so it fails closed instead of claiming verification.
  const shallowResult = repositoryPresent
    ? probeShallowRepository({ runGit })
    : { status: "ok", shallow: false };
  if (shallowResult.status === "error") {
    console.error(
      "changelog: " + shallowResult.error.message + ". Refusing to report a pass on a " +
        "history check that could not run.",
    );
    return 1;
  }
  const shallow = shallowResult.shallow;
  // A truncated history cannot answer EITHER question — not just coverage. Both
  // ci.yml and release.yml check out at fetch-depth: 0 precisely so this branch is
  // never taken where it matters; a developer's shallow clone gets the honest
  // "checked nothing" instead of three invented failures.
  const historyComplete = commits.length > 0 && !shallow;
  if (shallow) {
    console.error(
      "changelog: shallow clone — reachability AND coverage were NOT checked; only " +
        "the section's structure was. Re-run in a full clone (CI uses fetch-depth: 0).",
    );
  } else if (commits.length) {
    try {
      // The base is "the previous release REACHABLE from this one". That is only
      // the immediate predecessor while version tags stay on the branch — which is
      // true of the current flow (every tag from v0.52.13 on is an ancestor of
      // main) and was NOT true of the 0.50/0.51 flow, where the tag was pushed
      // from a local commit and the bump squash-merged onto protected main as a
      // different sha. 130 of 311 tags are still unreachable for that reason, and
      // #988 is the same root cause hitting the generator.
      //
      // Left as-is deliberately rather than second-guessed from the changelog's
      // own ordering: `describe` only considers REACHABLE tags, so a wrong answer
      // is always too OLD, never too new. That over-reports — it cannot hide a
      // missing entry — and every message names the base it used, so the mistake
      // reads off the failure instead of having to be inferred. Guessing a newer
      // base would trade a loud, wrong-looking failure for a silent gap, which is
      // the exact direction this guard exists to close.
      // --match v[0-9]*: `--tags` alone matches ANY tag, and this repo carries a
      // non-release one (`backup/570-prerebase`). Selecting a stray tag as the
      // previous release narrows the range, and everything before it then passes
      // uncited — a silent gap, which is the failure this whole guard exists for.
      previousRef = runGit("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", `${targetRef}^`);
    } catch (error) {
      if (!isMissingPreviousReleaseTag(error)) {
        console.error(
          "changelog: " + classifiedGitError("git describe failed", error).message +
            ". Refusing to report a pass on a coverage check that could not run.",
        );
        return 1;
      }
      // `describe` fails for two very different reasons, and the round-2 fix to the
      // history read left this sibling exit behind: no tag is REACHABLE (the first
      // release — legitimate, skip), or the tag refs cannot be read at all (broken —
      // and silently skipping coverage there is a gate passing because it could not
      // look). Listing tags separates them: it succeeds in the first case and throws
      // in the second.
      try {
        runGit("tag", "--list");
      } catch (error) {
        console.error(
          `changelog: git could not read tags (${String(error.message).split("\n")[0]}). ` +
            `Refusing to report a pass on a coverage check that could not run.`,
        );
        return 1;
      }
      console.error(
        `changelog: no release tag before ${targetRef} — coverage ` +
          `(every shipped PR is listed) was NOT checked.`,
      );
      rangeCommits = null;
    }
    // The range read is its OWN failure, not a missing tag. Sharing a catch with
    // `describe` meant a `git log` error landed in the no-previous-tag handler and
    // skipped coverage at exit 0 — the third sibling of this family, after the
    // history read and `describe` itself. Here the tag has already resolved, so
    // git demonstrably works and any failure is real.
    if (previousRef) {
      try {
        rangeCommits = parseCommitSubjects(
          runGit("log", `${previousRef}..${targetRef}`, "--format=%H%x1f%s%x1e"),
        );
      } catch (error) {
        console.error(
          `changelog: could not read ${previousRef}..${targetRef} ` +
            `(${String(error.message).split("\n")[0]}). Refusing to report a pass on a ` +
            `coverage check that could not run.`,
        );
        return 1;
      }
    }
  }

  const violations = auditReleaseSection({
    markdown,
    version,
    commits,
    rangeCommits,
    targetRef,
    previousRef,
    historyComplete,
    isAncestor: (sha, ref) => {
      try {
        runGit("merge-base", "--is-ancestor", sha, ref);
        return true;
      } catch {
        return false;
      }
    },
  });

  if (violations.length) {
    for (const violation of violations) console.error(`changelog: ERROR — ${violation}`);
    return 1;
  }
  // Three outcomes, named apart. A run that verified nothing must never print the
  // sentence a fully verified run prints.
  if (!historyComplete) {
    console.log(`changelog: [${version}] is structurally sound; history was unavailable, so NOTHING about what shipped was verified`);
  } else if (rangeCommits) {
    console.log(`changelog: [${version}] lists every PR since ${previousRef}, and every entry it names is reachable from ${targetRef}`);
  } else {
    console.log(`changelog: [${version}] names only entries reachable from ${targetRef}; coverage was not checked`);
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(main(process.argv));
