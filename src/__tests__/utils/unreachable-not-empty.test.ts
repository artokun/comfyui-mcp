// #1136 — an unreachable host must not read as an empty result.
//
// A Chinese-speaking user was told to search ComfyUI Manager for the panel and
// replied 我这边搜不到任何内容 — "I can't find anything when I search". Three
// consecutive pieces of advice were spent before anyone suspected the door
// itself could not open. Empty reads as "nothing matched", so the user
// concludes their query was wrong, or that the thing does not exist, and goes
// on trying variations of an action that can never succeed.
//
// The two search surfaces this repo owns are the ComfyUI Registry (custom-node
// packs) and HuggingFace (models). Both are commonly filtered. Both previously
// failed with a bare `fetch failed`, which names nothing.
//
// panel_civitai_results already gets this right, and its tool description says
// so: a total:0 result is NOT automatically "no matches" because an error field
// may be present. This applies the same rule to the paths that lacked it.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { unreachableHostMessage } from "../../utils/errors.js";

/** The shape undici throws: an opaque TypeError whose detail is on `.cause`. */
function fetchFailure(code: string, detail: string): Error {
  const err = new TypeError("fetch failed");
  (err as Error & { cause?: unknown }).cause = Object.assign(new Error(detail), { code });
  return err;
}

describe("unreachableHostMessage", () => {
  const dnsFail = () =>
    unreachableHostMessage(
      fetchFailure("ENOTFOUND", "getaddrinfo ENOTFOUND api.comfy.org"),
      "https://api.comfy.org/nodes?page=1",
      "the custom-node search",
    );

  it("names the host that could not be reached", () => {
    // The whole point for a filtered user: recognising their own situation.
    expect(dnsFail().message).toContain("api.comfy.org");
  });

  it("says explicitly that this is not an empty result", () => {
    const { message } = dnsFail();
    expect(message).toMatch(/NOT an empty result/);
    expect(message).toMatch(/nothing was queried/i);
  });

  it("names a blocked network as a likely cause, since ENOTFOUND does not", () => {
    expect(dnsFail().message).toMatch(/blocked by corporate, campus and national network filters/);
  });

  it("keeps the underlying detail and code", () => {
    const { message, code } = dnsFail();
    expect(code).toBe("ENOTFOUND");
    expect(message).toContain("getaddrinfo ENOTFOUND api.comfy.org");
  });

  it("calls a TIMEOUT a timeout, and does not claim the network is filtered", () => {
    // A slow host is not a blocked host. Telling someone their network is
    // filtered when it is not is its own wrong answer — it sends them to a VPN
    // for a problem a retry would have solved.
    const err = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    const { message } = unreachableHostMessage(err, "https://huggingface.co/api/models", "the search");
    expect(message).toMatch(/did not respond in time/);
    expect(message).not.toMatch(/blocked by corporate/);
    // Still not an empty result — that part holds for both causes.
    expect(message).toMatch(/NOT an empty result/);
  });

  it("appends a host-specific remedy when one exists", () => {
    const { message } = unreachableHostMessage(
      fetchFailure("ECONNREFUSED", "connect ECONNREFUSED"),
      "https://huggingface.co/api/models",
      "the search",
      { remedy: "Set HF_ENDPOINT to a mirror." },
    );
    expect(message).toContain("Set HF_ENDPOINT to a mirror.");
  });

  it("does not invent a host when the URL will not parse", () => {
    const { message } = unreachableHostMessage(new Error("boom"), "not a url", "the search");
    expect(message).toContain("the remote host");
    expect(message).toMatch(/NOT an empty result/);
  });
});

// THE WIRING. The helper cannot see whether either search actually calls it —
// exactly the call-site blindness this suite keeps getting caught by. These
// drive the real functions with a failing fetch.
describe("the search surfaces use it", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => {
      throw fetchFailure("ENOTFOUND", "getaddrinfo ENOTFOUND blocked.example");
    }) as unknown as typeof fetch;
  });

  it("searchNodes reports the registry as unreachable, and does NOT return []", async () => {
    const { searchNodes } = await import("../../services/registry-client.js");
    await expect(searchNodes("impact pack")).rejects.toThrow(/NOT an empty result/);
    await expect(searchNodes("impact pack")).rejects.toThrow(/api\.comfy\.org/);
  });

  it("searchHuggingFaceModels reports HuggingFace as unreachable, and does NOT return []", async () => {
    const { searchHuggingFaceModels } = await import("../../services/model-resolver.js");
    await expect(searchHuggingFaceModels("flux")).rejects.toThrow(/NOT an empty result/);
    await expect(searchHuggingFaceModels("flux")).rejects.toThrow(/HF_ENDPOINT/);
  });
});
