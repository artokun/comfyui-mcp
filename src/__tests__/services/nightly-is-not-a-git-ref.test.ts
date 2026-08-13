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
// THE WORD IS OVERLOADED IN OUR OWN SURFACE. For a Manager install "nightly" names the
// git-HEAD channel — one of our paths mints it, rewriting an absent/"latest" version because
// the Manager rejects a registry "latest" for a repository-style entry. For a from-source
// git install, `version` is documented as a git ref. A caller typing version:"nightly" may
// mean either, so the meaning is resolved by ASKING the repository, not by guessing.
//
// Two review findings shaped this, both worth keeping visible:
//   • collapsing the word to "no ref" up front would silently install the DEFAULT branch of
//     a repository that genuinely HAS a `nightly` branch — a quietly-wrong version, worse
//     than the loud failure being fixed;
//   • deciding by CATCHING the checkout failure swallowed unrelated errors (corrupt repo,
//     permissions) as "no such branch", and claimed a usable HEAD after a checkout that had
//     just failed in an unknown way.
import { describe, expect, it } from "vitest";
import {
  checkoutPlanForMissingRef,
  gitRefForInstall,
  isGitHeadChannel,
  isLatestSentinel,
} from "../../services/node-management.js";

describe("the ref resolver keeps 'nightly' as a ref (#1470)", () => {
  it("version:'nightly' is NOT collapsed — a real nightly branch must still win", () => {
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
});

describe("what a MISSING ref means depends on where it came from (#1470)", () => {
  it("a version-derived 'nightly' the repo lacks falls back to HEAD", () => {
    // The reported case: the repository has no such branch, and the clone already sits at
    // the default HEAD — which is what the channel reading of the word asks for.
    expect(checkoutPlanForMissingRef({ ref: "nightly", fromVersion: true })).toBe("skip-at-head");
    expect(checkoutPlanForMissingRef({ ref: " Nightly ", fromVersion: true })).toBe("skip-at-head");
  });

  it("an EXPLICIT ref:'nightly' the repo lacks still FAILS", () => {
    // The caller named a git ref. Installing something else because the name happens to
    // spell a channel word would be the wrong-version bug in a new place.
    expect(checkoutPlanForMissingRef({ ref: "nightly", fromVersion: false })).toBe("fail");
  });

  it("any other missing ref fails, whatever its provenance", () => {
    // Asking for v1.2.3 and silently getting HEAD is exactly what must not happen.
    expect(checkoutPlanForMissingRef({ ref: "v1.2.3", fromVersion: true })).toBe("fail");
    expect(checkoutPlanForMissingRef({ ref: "main", fromVersion: true })).toBe("fail");
    expect(checkoutPlanForMissingRef({ ref: "v1.2.3", fromVersion: false })).toBe("fail");
  });

  it("the channel test recognises what a caller actually types", () => {
    expect(isGitHeadChannel("nightly")).toBe(true);
    expect(isGitHeadChannel("Nightly")).toBe(true);
    expect(isGitHeadChannel(" NIGHTLY ")).toBe(true);
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
