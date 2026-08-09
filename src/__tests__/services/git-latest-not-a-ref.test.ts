// #1254 — "latest" reached `git checkout` as though it were a ref.
//
//   install_custom_node(id: "https://github.com/…/comfyUI-blender-wrapper.git",
//                       source: "git", version: "latest")
//
//   → git checkout --detach --end-of-options latest
//   → fatal: git checkout: --detach does not take a path argument 'latest'
//
// `version` DEFAULTS to "latest", so this is the plain no-options install of any
// git URL, not an exotic argument. And the cost is not just a failed command:
// the checkout failure discards the clone as a husk, so the node is left
// partially installed after a clone that had already succeeded.
//
// "latest" is this tool's own word for "whatever is newest". A fresh clone is
// already on the default branch, which is exactly that — so the fix is to check
// out nothing, which also restores the shallow clone (full history is fetched
// only because a concrete ref might need it).
//
// The registry path has always treated the word as a sentinel (it rewrites an
// absent or "latest" version to "nightly"), so the two now share one test for
// what the word means rather than each having their own idea.

import { describe, expect, it } from "vitest";

import {
  gitRefForInstall,
  isLatestSentinel,
  normalizeGitUrlInstallArgs,
} from "../../services/node-management.js";

describe("isLatestSentinel (#1254)", () => {
  it.each(["latest", "LATEST", "Latest", "  latest  "])("treats %o as the sentinel", (v) => {
    expect(isLatestSentinel(v)).toBe(true);
  });

  it.each([
    ["v1.2.3", "a tag"],
    ["main", "a branch"],
    ["nightly", "the registry's own word — a real version there, not this sentinel"],
    ["latest-stable", "a ref that merely starts with it"],
    ["release/latest", "a ref that merely contains it"],
    ["", "empty"],
    [undefined, "absent"],
    [42, "not a string"],
  ])("does NOT treat %o as the sentinel (%s)", (v) => {
    expect(isLatestSentinel(v)).toBe(false);
  });
});

describe("gitRefForInstall (#1254)", () => {
  it("derives NO ref from a 'latest' version — the reported call", () => {
    // install_custom_node(source:"git", version:"latest") with nothing else set.
    expect(gitRefForInstall({ version: "latest" })).toBeUndefined();
  });

  it.each(["LATEST", " latest "])("derives no ref from %o either", (version) => {
    expect(gitRefForInstall({ version })).toBeUndefined();
  });

  it("passes a REAL version through as the ref", () => {
    expect(gitRefForInstall({ version: "v1.2.3" })).toBe("v1.2.3");
  });

  it("derives nothing when no version was given at all", () => {
    expect(gitRefForInstall({})).toBeUndefined();
  });

  it("honours an EXPLICIT ref literally, even the sentinel word", () => {
    // Repositories do carry a tag called `latest`. Ignoring it would check out a
    // different commit than the one asked for — a wrong answer, where the bug
    // being fixed was only a failure.
    expect(gitRefForInstall({ ref: "latest", version: "latest" })).toBe("latest");
    expect(gitRefForInstall({ ref: "v9", version: "latest" })).toBe("v9");
  });

  it("honours a #ref from the URL the same way", () => {
    expect(gitRefForInstall({ urlRef: "latest", version: "latest" })).toBe("latest");
    expect(gitRefForInstall({ urlRef: "abc1234", version: "latest" })).toBe("abc1234");
  });

  it("an explicit ref beats a URL ref, which beats the version", () => {
    expect(gitRefForInstall({ ref: "a", urlRef: "b", version: "c" })).toBe("a");
    expect(gitRefForInstall({ urlRef: "b", version: "c" })).toBe("b");
  });

  it("treats parseGitUrl's NULL 'no fragment' as absent, not as a ref", () => {
    // parseGitUrl reports a missing fragment as null. Passing that through would
    // make `git checkout null` — the same class of bug one value over.
    expect(gitRefForInstall({ urlRef: null, version: "latest" })).toBeUndefined();
    expect(gitRefForInstall({ urlRef: null, version: "v1" })).toBe("v1");
  });
});

// The OTHER consumer of the word, which must keep agreeing with the first.
describe("the registry path still rewrites 'latest' to nightly (#1254)", () => {
  it.each(["latest", "LATEST", " latest "])("rewrites %o", (version) => {
    const out = normalizeGitUrlInstallArgs({
      repository: "https://github.com/example/pack.git",
      version,
    });
    expect(out.version).toBe("nightly");
    expect(out.note, "and says why, since the version it was given is not what runs").toMatch(
      /nightly/,
    );
  });

  it("leaves a real version alone", () => {
    const out = normalizeGitUrlInstallArgs({
      repository: "https://github.com/example/pack.git",
      version: "v2.0.1",
    });
    expect(out.version).toBe("v2.0.1");
    expect(out.note).toBeUndefined();
  });

  it("an absent version is the sentinel too", () => {
    const out = normalizeGitUrlInstallArgs({
      repository: "https://github.com/example/pack.git",
    });
    expect(out.version).toBe("nightly");
  });
});
