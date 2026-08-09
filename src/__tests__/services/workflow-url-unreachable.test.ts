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
    ).rejects.toThrow(/NOT an empty result/i);
  });

  it("also covers a mid-connection drop — no response is no response", async () => {
    // This assertion is INVERTED from its first version, deliberately. I had it
    // fall through to the generic message on the reasoning that ECONNRESET means
    // "the host WAS reached". True at the socket layer, irrelevant here: `fetch`
    // rejected, so nothing was retrieved, so nothing follows about whether the
    // workflow exists. That is the claim #1136 is about, and drawing the line at
    // the transport code was how I kept mis-drawing it -- RST injection and
    // packet drops are two of the three ways a filter actually presents.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw transportError("ECONNRESET");
      }),
    );
    await expect(
      fetchWorkflowFromUrl("https://raw.githubusercontent.com/o/r/main/wf.json"),
    ).rejects.toThrow(/NOT an empty result/i);
  });

  it("distinguishes a TIMEOUT from a refusal, which a code list kept getting wrong", async () => {
    // undici's connect timeout beats this module's own 15s deadline, so the
    // AbortError branch never fires for a dropped connection and the code is
    // UND_ERR_CONNECT_TIMEOUT -- absent from the hand-rolled set this replaced.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw transportError("UND_ERR_CONNECT_TIMEOUT");
      }),
    );
    await expect(
      fetchWorkflowFromUrl("https://raw.githubusercontent.com/o/r/main/wf.json"),
    ).rejects.toThrow(/did not respond in time/i);
  });
});
