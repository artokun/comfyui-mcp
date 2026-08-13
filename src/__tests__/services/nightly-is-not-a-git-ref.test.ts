// #1470 — `install_custom_node` with a direct Git URL and version:"nightly" cloned fine,
// then failed at checkout and DELETED the clone:
//
//   fatal: '--detach' cannot be used with '-b/-B/--orphan'
//
// Reproduced the command shape locally (git 2.54 words it differently, same cause):
//
//   $ git checkout --detach --end-of-options nightly
//   fatal: git checkout: --detach does not take a path argument 'nightly'
//
// With `--end-of-options` an unresolvable ref is treated as a PATH and `--detach` rejects
// paths; an older git phrases that as the -b/-B/--orphan clash.
//
// THE WORD IS OVERLOADED IN OUR OWN SURFACE, which is the whole difficulty. For a Manager
// install "nightly" names the git-HEAD channel — one of our paths even MINTS it, rewriting
// an absent/"latest" version to "nightly" because the Manager rejects a registry "latest"
// for a repository-style entry. For a from-source git install, `version` is documented as a
// git ref. A caller typing version:"nightly" may mean either.
//
// A first fix collapsed the word to "no ref" up front. codex found the P1: a repository that
// genuinely HAS a `nightly` branch would then silently install its DEFAULT branch, and a
// quietly-wrong version is worse than the loud failure being fixed. So the meaning is
// resolved by TRYING the ref and handling the failure, not by guessing.
import { describe, expect, it } from "vitest";
import { gitRefForInstall, isGitHeadChannel, isLatestSentinel } from "../../services/node-management.js";

describe("the channel word is still offered to git as a ref (#1470)", () => {
  it("version:'nightly' is NOT collapsed — a real nightly branch must still win", () => {
    // The P1 direction. If this returns undefined, a repo with a `nightly` branch gets its
    // default branch instead and nobody is told.
    expect(gitRefForInstall({ version: "nightly" })).toBe("nightly");
  });

  it("version:'latest' IS collapsed — #1254, unchanged", () => {
    // "latest" has no second reading: it is never a ref anyone means.
    expect(gitRefForInstall({ version: "latest" })).toBeUndefined();
  });

  it("an explicit ref still wins over the version selector", () => {
    expect(gitRefForInstall({ ref: "v2", version: "nightly" })).toBe("v2");
    expect(gitRefForInstall({ urlRef: "abc123", version: "latest" })).toBe("abc123");
  });

  it("the channel test recognises what a caller actually types", () => {
    // Used only to decide what a FAILED checkout means, so its spelling tolerance is what
    // keeps " Nightly " from being treated as a hard error.
    expect(isGitHeadChannel("nightly")).toBe(true);
    expect(isGitHeadChannel("Nightly")).toBe(true);
    expect(isGitHeadChannel(" NIGHTLY ")).toBe(true);
    expect(isGitHeadChannel("v1.2.3")).toBe(false);
    expect(isGitHeadChannel("main")).toBe(false);
    expect(isGitHeadChannel(undefined)).toBe(false);
  });

  it("the two predicates stay separate", () => {
    // `isLatestSentinel` is also the test at the git-URL normalisation site, where "latest"
    // is the INPUT being translated and "nightly" is the RESULT. Folding them would make
    // that translation match its own output.
    expect(isLatestSentinel("latest")).toBe(true);
    expect(isLatestSentinel("nightly")).toBe(false);
    expect(isGitHeadChannel("latest")).toBe(false);
  });
});

describe("a failed checkout of the CHANNEL word keeps the clone (#1470)", () => {
  it("the clone path treats it as a warning, not a husk-and-throw", async () => {
    // Asserted on the source: this branch needs a real clone + a real git repo to drive,
    // and what is being pinned is the DECISION — that the channel word does not take the
    // discard path — which is a fact about the code.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../../services/node-management.ts", import.meta.url),
      "utf-8",
    );
    const at = src.indexOf("Cloned \"${gitId}\" but could not check out");
    expect(at, "the checkout-failure site moved — re-anchor this test").toBeGreaterThan(-1);
    // Look BACK from the throw: the channel-word branch must sit between the catch and it,
    // so a failure of that word never reaches discardFailedClone.
    const before = src.slice(Math.max(0, at - 1800), at);
    expect(before).toMatch(/isGitHeadChannel\(gitRef\)/);
    expect(before).toMatch(/warnings\.push/);
    // And the ordinary ref path still discards, which is what stops "asked for v1.2.3,
    // silently got HEAD".
    expect(src.slice(at - 400, at)).toMatch(/discardFailedClone/);
  });
});
