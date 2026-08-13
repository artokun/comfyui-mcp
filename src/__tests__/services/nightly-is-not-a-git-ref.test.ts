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
// With `--end-of-options`, an unresolvable ref is treated as a PATH and `--detach` rejects
// paths; an older git phrases that as the -b/-B/--orphan clash. Either way "nightly" was
// never a ref.
//
// It is this tool's word for the git-HEAD channel — and one of our OWN paths mints it: a
// git-URL install with an absent/"latest" version is rewritten to version:"nightly" because
// ComfyUI-Manager rejects a registry "latest" for a repository-style entry. So the system
// produced the value that the ref resolver then misread. Same shape as #1254, one word over.
import { describe, expect, it } from "vitest";
import {
  gitRefForInstall,
  isGitHeadChannel,
  isLatestSentinel,
} from "../../services/node-management.js";

describe("a channel word never becomes a git ref (#1470)", () => {
  it("version:'nightly' yields NO ref — the reported failure", () => {
    // The exact input from the report: a direct Git URL install with the nightly channel.
    // Undefined means "leave the clone where it landed" (at HEAD), which is what nightly
    // has always meant.
    expect(gitRefForInstall({ version: "nightly" })).toBeUndefined();
  });

  it("still true for the spellings a caller actually types", () => {
    expect(gitRefForInstall({ version: "Nightly" })).toBeUndefined();
    expect(gitRefForInstall({ version: " NIGHTLY " })).toBeUndefined();
  });

  it("version:'latest' is unchanged — #1254's fix is not disturbed", () => {
    expect(gitRefForInstall({ version: "latest" })).toBeUndefined();
  });

  it("an EXPLICIT ref:'nightly' is still honoured", () => {
    // The direction that must not regress. A repository may genuinely have a branch or tag
    // called `nightly`, and swallowing the caller's explicit ref would replace this bug
    // with a quieter one: an install that silently checks out something else.
    expect(gitRefForInstall({ ref: "nightly" })).toBe("nightly");
    expect(gitRefForInstall({ urlRef: "nightly" })).toBe("nightly");
    // …and an explicit ref still wins over the channel selector.
    expect(gitRefForInstall({ ref: "nightly", version: "latest" })).toBe("nightly");
  });

  it("a real version/ref still passes through", () => {
    expect(gitRefForInstall({ version: "v1.2.3" })).toBe("v1.2.3");
    expect(gitRefForInstall({ version: "main" })).toBe("main");
    expect(gitRefForInstall({ ref: "abc1234" })).toBe("abc1234");
  });

  it("the two sentinels stay SEPARATE predicates", () => {
    // Not folded together: `isLatestSentinel` is also the test at the git-URL
    // normalisation site, where "latest" is the input being translated and "nightly" is
    // the result. Widening it there would make that translation match its own output.
    expect(isLatestSentinel("latest")).toBe(true);
    expect(isLatestSentinel("nightly")).toBe(false);
    expect(isGitHeadChannel("nightly")).toBe(true);
    expect(isGitHeadChannel("latest")).toBe(false);
  });
});
