// #2407 — mcp had a changelog GENERATOR and no verifier, and it cost three
// releases in one evening:
//
//   0.52.133  shipped #2378 and did not list it        (hand-corrected by #2384)
//   0.52.134  cut to carry a fix that had ALREADY shipped — no code changes at all
//   0.52.138  shipped #2400 and did not list it        (hand-corrected by #2406)
//
// One race produced all three: a PR merges between the release branch being cut
// and the release PR merging. Ancestry then resolves itself — the branch merges
// into main, so the tag gets the code — which is why nobody notices. Only the
// changelog gaps, and it gaps silently.
//
// WHY THE SCRATCH REPO. The guard's natural test subject is this repo's own
// CHANGELOG.md, and testing it that way is worthless twice over: the assertions
// move whenever a release lands, and a defect can only be exercised by breaking a
// real release. Every behaviour below is asserted against a synthetic history
// whose gap is deliberate, or against the pure audit with its git calls injected.
//
// MUTATION-CHECKED. Each coverage case was re-run with the `rangeCommits` block in
// scripts/check-changelog.mjs deleted, and with the fourth `isReleaseSubject`
// shape reverted; the named test fails in both cases. See the PR body.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  auditReleaseSection,
  main,
  parseCommitSubjects,
  parseReleaseSections,
} from "../../scripts/check-changelog.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const GUARD = join(ROOT, "scripts", "check-changelog.mjs");

// ── the pure audit ───────────────────────────────────────────────────────────

/** A commit as the guard sees it, with its issue/PR references already parsed. */
function commitOf(sha: string, subject: string) {
  return parseCommitSubjects(`${sha}\x1f${subject}\x1e`)[0];
}

function section(...body: string[]) {
  return ["# Changelog", "", "## Unreleased", "", "## [1.1.0] - 2026-08-26", "", ...body, ""].join("\n");
}

function gitFailure(status: number, stderr: string) {
  const error = new Error(stderr) as Error & { status: number; stderr: string };
  error.status = status;
  error.stderr = stderr;
  return error;
}

describe("#2407 half B: everything REACHABLE must be CITED", () => {
  it("reports a PR that shipped in the range and is named nowhere in the section", () => {
    const shipped = commitOf("aaa", "fix(900): the entry that was never written (#901)");
    const violations = auditReleaseSection({
      markdown: section("### Fixed", "- something else (#801)"),
      version: "1.1.0",
      commits: [shipped, commitOf("bbb", "fix: something else (#801)")],
      rangeCommits: [shipped, commitOf("bbb", "fix: something else (#801)")],
      targetRef: "v1.1.0",
      previousRef: "v1.0.0",
      isAncestor: () => true,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("does not mention PR #901");
    expect(violations[0]).toContain("v1.0.0");
  });

  it("accepts the ISSUE spelling, because a squash subject links the two", () => {
    // `fix(900): … (#901)` is one shipped change under two numbers. An entry that
    // cites #900 has documented #901, and demanding the PR spelling would report a
    // release as gapped when the entry is sitting right there.
    const shipped = commitOf("aaa", "fix(900): one change, two numbers (#901)");
    expect(
      auditReleaseSection({
        markdown: section("### Fixed", "- one change, two numbers (#900)"),
        version: "1.1.0",
        commits: [shipped],
        rangeCommits: [shipped],
        targetRef: "v1.1.0",
        previousRef: "v1.0.0",
      }),
    ).toEqual([]);
  });

  it("accepts a BARE #N written in prose, not just the generator's (#N)", () => {
    // 0.52.135 documents its predecessor's misattribution as "credit #2378 to
    // 0.52.133, where it shipped". That is an entry. Requiring parentheses here
    // would fail a release for the hand-written note that fixed a previous one.
    const shipped = commitOf("aaa", "fix: hand-written note (#901)");
    expect(
      auditReleaseSection({
        markdown: section("### Changed", "- credit #901 to the release where it shipped"),
        version: "1.1.0",
        commits: [shipped],
        rangeCommits: [shipped],
        targetRef: "v1.1.0",
        previousRef: "v1.0.0",
      }),
    ).toEqual([]);
  });

  it("ignores the release commit — `v<prev>..vX` always contains X's own", () => {
    // The shape protected main actually writes. Without the fourth
    // isReleaseSubject regex this reports EVERY release as missing an entry for
    // itself, which would make the guard useless on its first run.
    const release = commitOf("ccc", "chore: release v1.1.0 (#999)");
    expect(
      auditReleaseSection({
        markdown: section("### Fixed", "- a real change (#801)"),
        version: "1.1.0",
        commits: [commitOf("bbb", "fix: a real change (#801)"), release],
        rangeCommits: [commitOf("bbb", "fix: a real change (#801)"), release],
        targetRef: "v1.1.0",
        previousRef: "v1.0.0",
      }),
    ).toEqual([]);
  });

  it("ignores a commit with no PR number — the generator drops those too", () => {
    // A local commit a squash superseded. The guard and the generator have to
    // agree on what counts as shipped, or the guard fights its own generator.
    expect(
      auditReleaseSection({
        markdown: section("### Fixed", "- a real change (#801)"),
        version: "1.1.0",
        commits: [commitOf("bbb", "fix: a real change (#801)")],
        rangeCommits: [
          commitOf("bbb", "fix: a real change (#801)"),
          commitOf("ddd", "wip: local work in progress"),
        ],
        targetRef: "v1.1.0",
        previousRef: "v1.0.0",
      }),
    ).toEqual([]);
  });

  it("does NOT treat a numeric conventional scope as a shipped PR identity", () => {
    // Review round 3, and a false positive I introduced in round 2: the merge
    // fallback read commit.refs, which also holds a numeric SCOPE. `fix(2333): a
    // UUID redacts its whole token` carries no PR at all — 2333 is the issue, and
    // the commit is a local step inside merge #2294 — yet the guard demanded the
    // changelog cite #2333 as a PR, and flagged the real 0.52.124 for it.
    const scopeOnly = commitOf("aaa", "fix(2333): a UUID redacts its whole token");
    expect(
      auditReleaseSection({
        markdown: section("### Fixed", "- something else (#801)"),
        version: "1.1.0",
        commits: [scopeOnly, commitOf("bbb", "fix: something else (#801)")],
        rangeCommits: [scopeOnly, commitOf("bbb", "fix: something else (#801)")],
        targetRef: "v1.1.0",
        previousRef: "v1.0.0",
      }),
    ).toEqual([]);
  });

  it("does not let a fix ABOUT a release be skipped as one", () => {
    // Review round 3. The release shape accepted any commit type, so
    // `fix: release v1.2.3 (#778)` — a real change — was dropped by the guard AND
    // by the generator, which is the silent omission this whole file exists to
    // stop. Only `chore:` writes a release here.
    const aboutARelease = commitOf("aaa", "fix: release v1.2.3 (#778)");
    const violations = auditReleaseSection({
      markdown: section("### Fixed", "- something else (#801)"),
      version: "1.1.0",
      commits: [aboutARelease, commitOf("bbb", "fix: something else (#801)")],
      rangeCommits: [aboutARelease, commitOf("bbb", "fix: something else (#801)")],
      targetRef: "v1.1.0",
      previousRef: "v1.0.0",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("#778");
  });

  it("sees a REAL merge commit, whose PR number is a bare #N on the merge subject", () => {
    // Review round 2, verified against history: this repo mostly squash-merges but
    // not always, and `--no-merges` plus the parenthesised-only regex made every
    // true merge invisible. Four shipped that way across sixteen releases —
    // #2294, #2307, #2326, #2340 — and not one of them appears anywhere in
    // CHANGELOG.md. 0.52.124 shipped a single entry while carrying four PRs.
    const merge = commitOf("aaa", "Merge pull request #2294 from artokun/fix/rate-limit-429");
    const violations = auditReleaseSection({
      markdown: section("### Fixed", "- something else (#801)"),
      version: "1.1.0",
      commits: [merge, commitOf("bbb", "fix: something else (#801)")],
      rangeCommits: [merge, commitOf("bbb", "fix: something else (#801)")],
      targetRef: "v1.1.0",
      previousRef: "v1.0.0",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("does not mention PR #2294");
  });

  it("takes the issue from a merge branch, but only in the <type>/<issue>-<slug> shape", () => {
    // `fix/2319-remote-list` yields 2319, so an entry citing the issue covers the
    // merge PR. `fix/rate-limit-429` must yield NOTHING — a trailing number in a
    // slug is not an issue, and a bogus alias would let an unrelated entry vouch
    // for a real change, which is the failure this guard exists to prevent.
    const linked = commitOf("aaa", "Merge pull request #2326 from artokun/fix/2319-remote-list");
    expect(
      auditReleaseSection({
        markdown: section("### Fixed", "- fence local model listings (#2319)"),
        version: "1.1.0",
        commits: [linked],
        rangeCommits: [linked],
        targetRef: "v1.1.0",
        previousRef: "v1.0.0",
      }),
    ).toEqual([]);

    const slugNumber = commitOf("bbb", "Merge pull request #2294 from artokun/fix/rate-limit-429");
    expect(
      auditReleaseSection({
        markdown: section("### Fixed", "- an entry citing the slug number (#429)"),
        version: "1.1.0",
        commits: [slugNumber],
        rangeCommits: [slugNumber],
        targetRef: "v1.1.0",
        previousRef: "v1.0.0",
      }).some((v) => v.includes("#2294")),
    ).toBe(true);
  });

  it("ignores the merge that lands a release branch", () => {
    const releaseMerge = commitOf("ccc", "Merge pull request #2337 from artokun/release/0.52.124");
    expect(
      auditReleaseSection({
        markdown: section("### Fixed", "- a real change (#801)"),
        version: "1.1.0",
        commits: [commitOf("bbb", "fix: a real change (#801)"), releaseMerge],
        rangeCommits: [commitOf("bbb", "fix: a real change (#801)"), releaseMerge],
        targetRef: "v1.1.0",
        previousRef: "v1.0.0",
      }),
    ).toEqual([]);
  });

  it("an UMBRELLA issue vouches for itself and nothing else", () => {
    // #2393 took two PRs, and #2409 fixed a sibling exit five lines from the one
    // #2400 fixed. One entry citing the umbrella must not stand in for both, or the
    // second fix is invisible — a fix on one exit leaving its siblings behind.
    const first = commitOf("aaa", "fix(2393): the first exit (#2400)");
    const second = commitOf("bbb", "fix(2393): the sibling exit (#2409)");
    const violations = auditReleaseSection({
      markdown: section("### Fixed", "- a promoted write is judged on its own witness entry (#2393)"),
      version: "1.1.0",
      commits: [first, second],
      rangeCommits: [first, second],
      targetRef: "v1.1.0",
      previousRef: "v1.0.0",
    });
    expect(violations).toHaveLength(2);
    expect(violations.some((v) => v.includes("#2400"))).toBe(true);
    expect(violations.some((v) => v.includes("#2409"))).toBe(true);
  });

  it("does NOT chain issue\u2192PR links transitively", () => {
    // Review round 7. The panel's union-find makes the issue->PR relation
    // transitive, and transitivity is false here: this project routinely reuses a
    // previous PR number as the next commit's scope -- 62 numeric scopes in recent
    // history are also PR numbers -- so `fix(100): (#200)` and `fix(200): (#300)`
    // collapse into one class and a section citing only #100 silently vouches for
    // #300. That hides a missing entry, the precise failure this guard exists for.
    const chained = [
      commitOf("aaa", "fix(100): first (#200)"),
      commitOf("bbb", "fix(200): second (#300)"),
    ];
    const violations = auditReleaseSection({
      markdown: section("### Fixed", "- only the first (#100)"),
      version: "1.1.0",
      commits: chained,
      rangeCommits: chained,
      targetRef: "v1.1.0",
      previousRef: "v1.0.0",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("does not mention PR #300");
  });

  it("but an umbrella still covers commits whose ONLY identity is that issue", () => {
    // The first attempt excluded ambiguous references outright and over-fired: six
    // commits in 0.52.125 carry #2313 as their sole reference, shipped under merge
    // #2340, so citing #2313 is the only way they are documentable at all. That
    // release is correctly written and must stay green.
    const soleIdentity = commitOf("aaa", "fix(rate-limit): one part (#2313)");
    // Two PRs under #2313 make it genuinely ambiguous, so the vouching rule is
    // actually under test rather than trivially satisfied.
    const commits = [
      soleIdentity,
      commitOf("bbb", "fix(2313): the first PR (#2331)"),
      commitOf("ccc", "fix(2313): the second PR (#2340)"),
    ];
    const violations = auditReleaseSection({
      markdown: section("### Fixed", "- sanitize identifiers (#2313)"),
      version: "1.1.0",
      commits,
      rangeCommits: [soleIdentity],
      targetRef: "v1.1.0",
      previousRef: "v1.0.0",
    });
    expect(violations).toEqual([]);
  });

  it("says nothing about coverage when the range could not be resolved", () => {
    // A shallow clone or a repo with no previous tag cannot answer "what shipped
    // since the last release" — it can only answer it wrong, by reporting every
    // PR as missing. `null` is not an empty range.
    expect(
      auditReleaseSection({
        markdown: section("### Fixed", "- a real change (#801)"),
        version: "1.1.0",
        commits: [commitOf("bbb", "fix: a real change (#801)")],
        rangeCommits: null,
        targetRef: "v1.1.0",
        previousRef: null,
      }),
    ).toEqual([]);
  });
});

describe("#2407 half A: everything CITED must be REACHABLE", () => {
  it("reports an entry credited to a release that does not contain it", () => {
    const violations = auditReleaseSection({
      markdown: section("### Fixed", "- shipped somewhere else (#801)"),
      version: "1.1.0",
      commits: [commitOf("bbb", "fix: shipped somewhere else (#801)")],
      rangeCommits: [],
      targetRef: "v1.1.0",
      previousRef: "v1.0.0",
      isAncestor: () => false,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("is an ancestor of v1.1.0");
  });

  it("checks EVERY cited PR, not just the trailing one", () => {
    // Review round 2. Checking only `refs.at(-1)` let an unreachable first citation
    // hide behind a reachable second — a wrong credit surviving the half built to
    // catch wrong credits. #999 is carried by no commit at all.
    const violations = auditReleaseSection({
      markdown: section("### Fixed", "- one entry, a bogus first citation (#999, #901)"),
      version: "1.1.0",
      commits: [commitOf("aaa", "fix: the real change (#901)")],
      // null, not []: this exercises reachability only. An EMPTY range is a
      // different claim — a release that shipped nothing may cite nothing.
      rangeCommits: null,
      targetRef: "v1.1.0",
      previousRef: "v1.0.0",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("#999");
  });

  it("checks an entry that closes TWO PRs in one comma list", () => {
    // 0.52.136 writes `… (#2382, #2387)`. The panel's single-reference regex
    // returns nothing for that, which does not fail — it makes this whole half
    // skip the entry in silence, exempting it from the check meant to catch a
    // wrong credit. Coverage still passed it (that half reads bare #N), so the
    // release looked fully audited while half of the audit saw nothing.
    const violations = auditReleaseSection({
      markdown: section("### Fixed", "- one entry, two PRs (#2382, #2387)"),
      version: "1.1.0",
      commits: [
        commitOf("aaa", "fix: the first half (#2382)"),
        commitOf("bbb", "fix: the second half (#2387)"),
      ],
      rangeCommits: null,
      targetRef: "v1.1.0",
      previousRef: "v1.0.0",
      isAncestor: (sha: string) => sha !== "bbb",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("#2387");
  });

  it("asks NOTHING about reachability when the history is truncated", () => {
    // Found by the review gate on this PR, and reproduced: on a depth-1 clone the
    // commit pool holds one commit, so EVERY entry looks unreachable. Against a
    // shallow checkout of this very branch the guard invented three failures
    // (#2398, #2399, #2400) for a perfectly correct release. Skipping coverage
    // alone was not enough — an incomplete pool cannot tell "credited to the wrong
    // release" from "not in my pool", and answering anyway fails a good publish.
    const violations = auditReleaseSection({
      markdown: section("### Fixed", "- shipped, but out of the shallow pool (#801)"),
      version: "1.1.0",
      commits: [],
      rangeCommits: null,
      targetRef: "HEAD",
      previousRef: null,
      historyComplete: false,
      isAncestor: () => false,
    });
    expect(violations).toEqual([]);
  });

  it("still reports STRUCTURE when the history is truncated — that needs no git", () => {
    const violations = auditReleaseSection({
      markdown: [
        "# Changelog",
        "",
        "## [1.1.0] - 2026-08-26",
        "",
        "### Fixed",
        "- one thing (#801)",
        "",
        "### Fixed",
        "- again (#802)",
        "",
      ].join("\n"),
      version: "1.1.0",
      commits: [],
      rangeCommits: null,
      targetRef: "HEAD",
      historyComplete: false,
    });
    expect(violations.some((v) => v.includes('repeats the heading "Fixed"'))).toBe(true);
    expect(violations.some((v) => v.includes("names PR"))).toBe(false);
  });

  it("REACHABLE is not SHIPPED HERE — an older PR cannot be re-credited", () => {
    // Review round 4, and a real one: every earlier release is reachable from this
    // tag, so ancestry alone accepts a section crediting itself with work that
    // landed two releases ago. That is the 0.52.134 mistake. [0.52.133] credits
    // itself with #2196, whose commit is not in v0.52.132..v0.52.133 at all — its
    // actual work was #2376, which the coverage half separately reports as missing.
    const older = commitOf("old", "fix: shipped two releases ago (#2196)");
    const current = commitOf("new", "fix: this release's real work (#2376)");
    const violations = auditReleaseSection({
      markdown: section("### Fixed", "- authorize panel template relays (#2196)"),
      version: "1.1.0",
      commits: [older, current],
      rangeCommits: [current],
      targetRef: "v1.1.0",
      previousRef: "v1.0.0",
      isAncestor: () => true,
    });
    expect(violations.some((v) => v.includes("not in v1.0.0..v1.1.0"))).toBe(true);
  });

  it("but makes no such claim when the range is unknown", () => {
    // Without a range there is nothing to be outside of, and guessing would fail
    // correct releases — the direction that blocks a good publish.
    const older = commitOf("old", "fix: shipped two releases ago (#2196)");
    expect(
      auditReleaseSection({
        markdown: section("### Fixed", "- authorize panel template relays (#2196)"),
        version: "1.1.0",
        commits: [older],
        rangeCommits: null,
        targetRef: "v1.1.0",
        previousRef: null,
        isAncestor: () => true,
      }),
    ).toEqual([]);
  });

  it("reports an entry naming a number no commit carries", () => {
    // This is the 0.52.134 shape: the section cited #2378, no commit anywhere
    // carried it, and reading that gap as "not shipped yet" produced a whole
    // no-op version.
    const violations = auditReleaseSection({
      markdown: section("### Changed", "- no code changes; this already shipped (#2378)"),
      version: "1.1.0",
      commits: [commitOf("bbb", "fix(codex): the real subject (#2379)")],
      rangeCommits: [],
      targetRef: "v1.1.0",
      previousRef: "v1.0.0",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("no commit reachable from v1.1.0 carries that reference");
  });
});

describe("#2407 structure: a hand-edited section stays well formed", () => {
  const markdown = [
    "# Changelog",
    "",
    "## [1.1.0] - 2026-08-26",
    "",
    "### Fixed",
    "- one thing (#801)",
    "",
    "### Fixed",
    "- one thing again (#801)",
    "",
    "## [1.1.0] - 2026-08-25",
    "",
    "### Fixed",
    "- a duplicate section",
    "",
  ].join("\n");

  it("catches a repeated version, a repeated heading and a twice-credited PR", () => {
    const violations = auditReleaseSection({
      markdown,
      version: "1.1.0",
      commits: [commitOf("bbb", "fix: one thing (#801)")],
      rangeCommits: [],
      targetRef: "v1.1.0",
      previousRef: "v1.0.0",
    });
    expect(violations.some((v) => v.includes("repeats the [1.1.0] release section"))).toBe(true);
    expect(violations.some((v) => v.includes('repeats the heading "Fixed"'))).toBe(true);
    expect(violations.some((v) => v.includes("credits issue/PR identity #801 twice"))).toBe(true);
  });

  it("allows the SAME bucket under two components — that is valid generated output", () => {
    // Review round 5, reproduced on real history. gen-changelog nests
    // `### <component>` > `#### <bucket>`, so a release touching both components
    // emits `#### Fixed` twice. [0.50.37] shipped exactly that, and keying
    // heading uniqueness on level+text alone REJECTED it — a false positive that
    // blocks a correct release, the worst direction for this guard.
    const twoComponents = [
      "# Changelog",
      "",
      "## [1.1.0] - 2026-08-26",
      "",
      "### RunPod image",
      "",
      "#### Fixed",
      "- a hash that could not be computed (#1123)",
      "",
      "### MCP",
      "",
      "#### Fixed",
      "- a different fix entirely (#1134)",
      "",
    ].join("\n");
    expect(
      auditReleaseSection({
        markdown: twoComponents,
        version: "1.1.0",
        targetRef: "v1.1.0",
        historyComplete: false,
      }).filter((v: string) => v.includes("repeats the heading")),
    ).toEqual([]);
  });

  it("...but still catches the same bucket twice under ONE component", () => {
    const realDuplicate = [
      "# Changelog",
      "",
      "## [1.1.0] - 2026-08-26",
      "",
      "### MCP",
      "",
      "#### Fixed",
      "- a (#1)",
      "",
      "#### Fixed",
      "- b (#2)",
      "",
    ].join("\n");
    expect(
      auditReleaseSection({
        markdown: realDuplicate,
        version: "1.1.0",
        targetRef: "v1.1.0",
        historyComplete: false,
      }).some((v: string) => v.includes('repeats the heading "Fixed"')),
    ).toBe(true);
  });

  it("reports a missing or empty section rather than passing it", () => {
    expect(
      auditReleaseSection({ markdown: "# Changelog\n", version: "1.1.0", targetRef: "v1.1.0" }).join(),
    ).toContain("has no [1.1.0] release section");
    expect(
      auditReleaseSection({
        markdown: "# Changelog\n\n## [1.1.0] - 2026-08-26\n\n",
        version: "1.1.0",
        targetRef: "v1.1.0",
      }).join(),
    ).toContain("[1.1.0] release section is empty");
  });

  it("parses CRLF, which is the line ending mcp's CHANGELOG.md actually uses", () => {
    // The panel's file is LF and mcp's is CRLF. A heading regex that survives one
    // and not the other reads as a clean run while seeing nothing at all.
    const parsed = parseReleaseSections("# Changelog\r\n\r\n## [1.1.0] - 2026-08-26\r\n\r\n- x (#1)\r\n");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].version).toBe("1.1.0");
    expect(parsed[0].lines.some((l: string) => l.includes("(#1)"))).toBe(true);
  });
});

// ── the real CLI, against a real (tiny) repository ───────────────────────────

describe("#2407 end to end: the guard blocks the cut that shipped 0.52.138", () => {
  let dir: string;

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();

  const commit = (subject: string) => {
    writeFileSync(join(dir, "f.txt"), subject);
    git("add", "-A");
    git("commit", "-q", "-m", subject);
  };

  const writeChangelog = (...body: string[]) =>
    // CRLF deliberately: this repo's CHANGELOG.md is CRLF, and the guard reads the
    // file rather than a normalised copy.
    writeFileSync(join(dir, "CHANGELOG.md"), body.join("\r\n") + "\r\n");

  const runGuard = (...args: string[]) =>
    spawnSync(process.execPath, [GUARD, ...args], {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, COMFYUI_MCP_CHANGELOG_ROOT: dir },
    });

  const runCli = (args: string[], fail: (gitArgs: string[]) => boolean) => {
    const calls: string[][] = [];
    const result = main(["node", GUARD, ...args], {
      root: dir,
      changelog: join(dir, "CHANGELOG.md"),
      runGit: (...gitArgs: string[]) => {
        calls.push(gitArgs);
        if (fail(gitArgs)) throw gitFailure(128, "fatal: injected git failure");
        return git(...gitArgs);
      },
    });
    return { result, calls };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clguard-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeChangelog("# Changelog", "", "## Unreleased", "", "## [1.0.0] - 2026-08-26", "", "### Fixed", "- the first thing (#801)", "");
    commit("fix: the first thing (#801)");
    git("tag", "v1.0.0");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("fails, and names the PR, when a release ships a fix it does not list", () => {
    // Exactly the 0.52.138 shape: #901 merges into the release, ancestry is fine,
    // and only the notes gap.
    commit("fix(900): the one that got away (#901)");
    writeChangelog(
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "## [1.1.0] - 2026-08-27",
      "",
      "### Fixed",
      "- an unrelated tidy-up (#902)",
      "",
      "## [1.0.0] - 2026-08-26",
      "",
      "### Fixed",
      "- the first thing (#801)",
      "",
    );
    commit("fix: an unrelated tidy-up (#902)");
    commit("chore: release v1.1.0 (#903)");
    git("tag", "v1.1.0");

    const result = runGuard();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not mention PR #901");
    // The release commit itself must NOT be reported; that noise would bury the
    // one line that matters.
    expect(result.stderr).not.toContain("#903");
  });

  it("passes once the missing entry is added — nothing else about the cut changed", () => {
    commit("fix(900): the one that got away (#901)");
    writeChangelog(
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "## [1.1.0] - 2026-08-27",
      "",
      "### Fixed",
      "- the one that got away (#901)",
      "",
      "## [1.0.0] - 2026-08-26",
      "",
      "### Fixed",
      "- the first thing (#801)",
      "",
    );
    commit("chore: release v1.1.0 (#903)");
    git("tag", "v1.1.0");

    const result = runGuard();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("lists every PR since v1.0.0");
  });

  it("reports a PR that landed as a REAL merge commit, through the actual git range", () => {
    // WIRING, not the helper. The pure audit understands a merge subject, but the
    // range that feeds it is a `git log` invocation, and restoring `--no-merges`
    // there left every merge test green while making the CLI blind again — the
    // fix present, the path to it severed. This drives the real query.
    git("checkout", "-q", "-b", "fix/900-thing");
    commit("wip: work with no PR number of its own");
    git("checkout", "-q", "main");
    git(
      "merge",
      "--no-ff",
      "-m",
      "Merge pull request #901 from artokun/fix/900-thing",
      "fix/900-thing",
    );
    writeChangelog(
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "## [1.1.0] - 2026-08-27",
      "",
      "### Fixed",
      "- an unrelated tidy-up (#902)",
      "",
      "## [1.0.0] - 2026-08-26",
      "",
      "### Fixed",
      "- the first thing (#801)",
      "",
    );
    commit("fix: an unrelated tidy-up (#902)");
    commit("chore: release v1.1.0 (#903)");
    git("tag", "v1.1.0");

    const result = runGuard();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not mention PR #901");
  });

  it("audits the cut BEFORE the tag exists, which is when a release can still be fixed", () => {
    // `npm version` and the release PR both run before the tag is pushed. If the
    // guard only worked against a tag it would report the mistake after publish.
    commit("fix(900): the one that got away (#901)");
    writeChangelog(
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "## [1.1.0] - 2026-08-27",
      "",
      "### Fixed",
      "- an unrelated tidy-up (#902)",
      "",
      "## [1.0.0] - 2026-08-26",
      "",
      "### Fixed",
      "- the first thing (#801)",
      "",
    );
    commit("fix: an unrelated tidy-up (#902)");

    const result = runGuard();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not mention PR #901");
    expect(result.stderr).toContain("reachable from HEAD");
  });

  it("invents NOTHING on a shallow clone, and does not call that a verified pass", () => {
    // The end-to-end form of the gate's finding. A depth-1 clone of a healthy
    // release must not produce a single violation, and must not print the sentence
    // a fully verified run prints — a skip that reads like a pass is the failure
    // this guard exists to stop, turned on itself.
    commit("fix(900): a shipped change (#901)");
    writeChangelog(
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "## [1.1.0] - 2026-08-27",
      "",
      "### Fixed",
      "- a shipped change (#901)",
      "",
      "## [1.0.0] - 2026-08-26",
      "",
      "### Fixed",
      "- the first thing (#801)",
      "",
    );
    commit("chore: release v1.1.0 (#903)");
    git("tag", "v1.1.0");

    const shallow = mkdtempSync(join(tmpdir(), "clguard-shallow-"));
    try {
      execFileSync(
        "git",
        ["clone", "--depth", "1", "--branch", "main", `file://${dir.replace(/\\/g, "/")}`, shallow],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(
        execFileSync("git", ["-C", shallow, "rev-parse", "--is-shallow-repository"], {
          encoding: "utf-8",
        }).trim(),
      ).toBe("true");

      const result = spawnSync(process.execPath, [GUARD], {
        cwd: shallow,
        encoding: "utf-8",
        env: { ...process.env, COMFYUI_MCP_CHANGELOG_ROOT: shallow },
      });
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("names PR");
      expect(result.stderr).toContain("reachability AND coverage were NOT checked");
      expect(result.stdout).not.toContain("lists every PR since");
      expect(result.stdout).toContain("NOTHING about what shipped was verified");
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });

  it("FAILS closed when the shallow-history probe fails", () => {
    const { result, calls } = runCli([], (args) =>
      args.length === 2 && args[0] === "rev-parse" && args[1] === "--is-shallow-repository",
    );

    expect(result).toBe(1);
    expect(calls.some((args) => args[0] === "describe")).toBe(false);
  });

  it("FAILS closed when the target-tag lookup fails", () => {
    const { result, calls } = runCli([], (args) =>
      args.length === 3 &&
      args[0] === "rev-parse" &&
      args[1] === "--verify" &&
      args[2] === "v1.0.0^{commit}",
    );

    expect(result).toBe(1);
    expect(calls.some((args) => args[0] === "log")).toBe(false);
  });

  it("FAILS closed on an unexpected release-tag describe failure", () => {
    commit("fix: a later change (#901)");
    const { result, calls } = runCli(["1.1.0", "--ref", "HEAD"], (args) => args[0] === "describe");

    expect(result).toBe(1);
    expect(calls.some((args) => args[0] === "tag")).toBe(false);
  });

  it("FAILS closed when the release-range git log fails", () => {
    commit("fix: a later change (#901)");
    const { result, calls } = runCli(
      ["1.1.0", "--ref", "HEAD"],
      (args) => args[0] === "log" && args[1] === "v1.0.0..HEAD",
    );

    expect(result).toBe(1);
    expect(calls.some((args) => args[0] === "describe")).toBe(true);
  });

  it("FAILS a release with no section at all, instead of auditing its predecessor", () => {
    // Review round 4. Defaulting to the newest SECTION meant a cut that wrote no
    // notes was audited as the previous version — and passed, because the previous
    // version is fine. The one release with no notes whatsoever is precisely the
    // one that must fail. package.json is what is being released.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.1.0" }));
    commit("fix(900): a change with nowhere to be listed (#901)");
    commit("chore: release v1.1.0 (#903)");
    git("tag", "v1.1.0");

    const result = runGuard();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has no [1.1.0] release section");
    // The predecessor must NOT be what got audited and waved through.
    expect(result.stdout).not.toContain("[1.0.0]");
  });

  it("FAILS when git breaks inside a repository, rather than reporting a pass", () => {
    // Review round 2: a git failure and "there is no repository here" shared exit 0,
    // so an EPERM or a corrupt object store turned run-checks' green tick into a
    // gate that passed because it could not look.
    //
    // Removing .git/objects makes git itself answer "not a git repository", which is
    // why the presence check asks the FILESYSTEM instead — the first attempt asked
    // git, and this very case walked straight past it into the skip path. The same
    // trap swallows the `spawnSync git EPERM` that prompted the finding: if git
    // cannot run, it cannot tell you that you are in a repository either.
    rmSync(join(dir, ".git", "objects"), { recursive: true, force: true });
    expect(existsSync(join(dir, ".git"))).toBe(true);
    const result = runGuard();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("target tag v1.0.0 lookup failed");
    expect(result.stdout).not.toContain("structurally sound");
  });

  it("but SKIPS when there is no repository at all — a tarball has nothing to verify", () => {
    const bare = mkdtempSync(join(tmpdir(), "clguard-norepo-"));
    try {
      writeFileSync(
        join(bare, "CHANGELOG.md"),
        ["# Changelog", "", "## [1.0.0] - 2026-08-26", "", "### Fixed", "- a thing (#801)", ""].join("\r\n"),
      );
      const result = spawnSync(process.execPath, [GUARD], {
        cwd: bare,
        encoding: "utf-8",
        env: { ...process.env, COMFYUI_MCP_CHANGELOG_ROOT: bare },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("lists every PR since");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("SKIPS a source tarball nested inside another Git checkout", () => {
    const nested = join(dir, "nested-tarball");
    mkdirSync(nested);
    writeFileSync(
      join(nested, "CHANGELOG.md"),
      [
        "# Changelog",
        "",
        "## [1.0.0] - 2026-08-26",
        "",
        "### Fixed",
        "- an entry that exists only in the tarball (#999)",
        "",
      ].join("\r\n"),
    );

    const result = spawnSync(process.execPath, [GUARD], {
      cwd: nested,
      encoding: "utf-8",
      env: { ...process.env, COMFYUI_MCP_CHANGELOG_ROOT: nested },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("history was unavailable");
    expect(result.stdout).not.toContain("lists every PR since");
  });

  it("measures from the previous RELEASE tag, not from a stray non-version tag", () => {
    // Review round 5. `describe --tags` matches ANY tag, and this repo carries a
    // non-release one (`backup/570-prerebase`). A stray tag sitting after the last
    // release narrows the range past the unlisted PR, and the gap then passes —
    // silently, which is the exact failure the coverage half exists to catch.
    commit("fix(900): the one that got away (#901)");
    git("tag", "backup/scratch-work");
    writeChangelog(
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "## [1.1.0] - 2026-08-27",
      "",
      "### Fixed",
      "- an unrelated tidy-up (#902)",
      "",
      "## [1.0.0] - 2026-08-26",
      "",
      "### Fixed",
      "- the first thing (#801)",
      "",
    );
    commit("fix: an unrelated tidy-up (#902)");
    commit("chore: release v1.1.0 (#903)");
    git("tag", "v1.1.0");

    const result = runGuard();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not mention PR #901");
    // ...and it must say it measured from the release, not the scratch tag.
    expect(result.stderr).toContain("not from v1.0.0");
  });

  it("refuses a malformed version argument instead of auditing a different section", () => {
    for (const malformed of ["1.1", "1.1.0; touch pwned", "--bad-version"]) {
      const result = runGuard(malformed);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("invalid release version");
      expect(result.stderr).not.toContain("has no [");
    }
  });

  it("skips coverage LOUDLY when there is no previous tag, rather than reporting every PR", () => {
    rmSync(join(dir, ".git", "refs", "tags", "v1.0.0"));
    const result = runGuard("1.0.0");
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("coverage");
    expect(result.stderr).toContain("was NOT checked");
    // A skip must never read like a clean pass.
    expect(result.stdout).not.toContain("lists every PR since");
  });
});

// ── wiring ───────────────────────────────────────────────────────────────────

describe("#2407 WIRING: the guard actually runs on the paths that matter", () => {
  // A guard nothing invokes is a green dormant mechanism. These assert the whole
  // chain by PATH, because every link in it is a place the wiring can be dropped
  // without a single test going red.
  const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf-8");

  it("npm test runs it", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.test).toContain("scripts/run-checks.mjs");
    const checks = read("scripts", "run-checks.mjs");
    expect(checks).toContain("scripts/check-changelog.mjs");
  });

  it("and npm test is what ci.yml and release.yml both run", () => {
    // release.yml enforcing less than ci.yml is a documented past failure in this
    // repo — three gates were CI-only and a tag could publish what a pull request
    // would have blocked. Wiring into `npm test` is what keeps the two in step.
    expect(read(".github", "workflows", "ci.yml")).toMatch(/^\s*-\s*run:\s*npm test\s*$/m);
    expect(read(".github", "workflows", "release.yml")).toMatch(/^\s*-\s*run:\s*npm test\s*$/m);
  });

  it("and both check out at fetch-depth: 0, or the guard silently checks nothing", () => {
    // The guard cannot verify a truncated history and correctly declines to try.
    // That makes `fetch-depth: 0` load-bearing: drop it and every run becomes a
    // structural check that still exits 0 — a gate that passes because it looked
    // at nothing. Both files already set it (for check:blog-stale); this pins it
    // as a dependency of THIS guard too, so removing it fails here rather than
    // quietly disarming the release gate.
    // Anchored to a whole LINE, not a substring. Both files also EXPLAIN
    // fetch-depth: 0 in a comment, so the loose form of this assertion matched the
    // prose and survived setting the real key to 1 — a wiring test that passes on
    // a comment is worth less than no test, because it reads as coverage.
    const settingLine = /^\s*fetch-depth:\s*0\s*$/m;
    expect(read(".github", "workflows", "ci.yml")).toMatch(settingLine);
    expect(read(".github", "workflows", "release.yml")).toMatch(settingLine);
  });

  it("and the guard shares ONE release-commit predicate with the generator", () => {
    // A second copy would drift silently: the generator has no failing output,
    // only a wrong one, and the guard would start disagreeing with it about what
    // counts as shipped.
    expect(read("scripts", "check-changelog.mjs")).toContain(
      'import { isReleaseSubject } from "./lib/release-subject.mjs"',
    );
    expect(read("scripts", "check-changelog.mjs")).not.toMatch(/const isReleaseSubject\s*=/);
  });
});
