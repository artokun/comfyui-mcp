// #1136 — fetching a workflow from a URL we cannot reach must say so, and name
// the host.
//
// This site was already HALF right, which is why it is worth pinning: the
// AbortError branch (workflow-url.ts:259) has always said
// `Timed out after Nms fetching workflow from "<host>"`. The fallthrough did
// not — a DNS failure produced `Failed to fetch workflow URL: fetch failed`,
// with no host and no indication that the problem is reachability rather than a
// bad link. A filtered user reads that as "my URL is wrong" and edits the URL,
// which is the same dead end as reading empty as "does not exist".

import { describe, expect, it, vi, afterEach } from "vitest";

import { fetchWorkflowFromUrl } from "../../services/workflow-url.js";

/** A Node transport error as undici surfaces it: the code hangs off `cause`. */
function transportError(code: string): Error {
  const err = new TypeError("fetch failed");
  (err as unknown as { cause: unknown }).cause = Object.assign(new Error(code), { code });
  return err;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fetchWorkflowFromUrl unreachable-host reporting (#1136)", () => {
  it("names the host and says CONNECTIVITY when DNS fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw transportError("ENOTFOUND");
      }),
    );
    await expect(
      fetchWorkflowFromUrl("https://raw.githubusercontent.com/o/r/main/wf.json"),
    ).rejects.toThrow(/raw\.githubusercontent\.com/);
    await expect(
      fetchWorkflowFromUrl("https://raw.githubusercontent.com/o/r/main/wf.json"),
    ).rejects.toThrow(/not an empty result|CONNECTIVITY/i);
  });

  it("does NOT say unreachable for a mid-connection drop — the host WAS reached", async () => {
    // ECONNRESET fires on an established connection. Claiming "could not reach"
    // there would be the same overclaim in the other direction, and this branch
    // must keep falling through to the generic message.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw transportError("ECONNRESET");
      }),
    );
    await expect(
      fetchWorkflowFromUrl("https://raw.githubusercontent.com/o/r/main/wf.json"),
    ).rejects.toThrow(/Failed to fetch workflow URL/);
  });
});
