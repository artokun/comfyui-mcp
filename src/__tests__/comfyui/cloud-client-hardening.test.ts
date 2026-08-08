// The cloud client is a PARALLEL implementation of the headless one, and the last
// two rounds of hardening reached only its twin. That is how a parallel
// implementation rots: nothing fails, it simply stops keeping up.
//
// 1. NO TIMEOUT AT ALL. comfyuiFetch got a default ceiling in 0.50.11 because a
//    request that never answers otherwise waits forever. cloudFetch called bare
//    `fetch` with no signal anywhere in the file, so a hung cloud request hung the
//    whole tool call — no timeout, no error, nothing for the caller to act on.
//
// 2. "Failed to reach Comfy Cloud at <url>" was a CLAIM, not an observation. It
//    was produced for every transport error, including an ECONNRESET on the POST
//    to /api/prompt — which does not establish that the submission never landed.
//    A caller reading "failed to reach" retries, and the retry bills a SECOND
//    cloud render. Of every instance of this defect class in the repo, this is the
//    one that costs the user actual money.
//
// Both fixes reuse the headless client's helpers rather than re-deriving them, so
// there is one ceiling and one delivery-doubt rule.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  getApiKey: () => "test-key",
  getCloudUrl: () => "https://cloud.comfy.org",
  getComfyUIAuthHeaders: () => ({}),
}));

const cloud = await import("../../comfyui/cloud-client.js");

/** The exact shape undici throws: an opaque top-level, detail on `.cause`. */
function undiciFailure(code: string | undefined, detail: string): Error {
  const cause = new Error(detail);
  if (code !== undefined) (cause as { code?: string }).code = code;
  return new TypeError("fetch failed", { cause });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.COMFYUI_MCP_HTTP_TIMEOUT_S;
});

describe("cloudFetch applies a timeout ceiling", () => {
  it("passes a signal even when the caller supplies none", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);

    await cloud.getJobStatus("p1");

    const init = spy.mock.calls.at(-1)![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports its own ceiling as a timeout, not as a caller abort", async () => {
    const abort = new Error("The operation was aborted");
    abort.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));

    const err = await cloud.getJobStatus("p1").catch((e: unknown) => e);
    const msg = (err as Error).message;

    expect(msg).toMatch(/No reply from Comfy Cloud within \d+s/);
    expect(msg).toMatch(/COMFYUI_MCP_HTTP_TIMEOUT_S/);
  });

  // NOT TESTED, deliberately, and said out loud rather than faked: no exported
  // cloud function accepts a signal today (fetchImage takes filename/type/
  // subfolder, enqueuePrompt takes workflow/extraData, and so on), so the
  // `init?.signal === undefined` guard has no reachable caller from the public
  // surface. It exists for symmetry with comfyuiFetch, where callers DO pass their
  // own budgets, so that the day a cloud caller gains one the ceiling does not
  // silently overrule it.
  //
  // An earlier draft of this file "covered" that guard by passing an object where
  // `filename` goes and asserting `used.signal === own || used.signal instanceof
  // AbortSignal` — a tautology, green forever, testing nothing.
  it("applies the configured ceiling, not a hardcoded one", async () => {
    process.env.COMFYUI_MCP_HTTP_TIMEOUT_S = "7";
    const abort = new Error("The operation was aborted");
    abort.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));

    const err = await cloud.getJobStatus("p1").catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/within 7s/);
  });
});

describe("a transport failure no longer claims the request never arrived", () => {
  it("warns that a POST /api/prompt may already have been billed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(undiciFailure("ECONNRESET", "read ECONNRESET")),
    );

    const err = await cloud.enqueuePrompt({ "1": {} }).catch((e: unknown) => e);
    const msg = (err as Error).message;

    expect(msg).toMatch(/may already have been received and acted on/i);
    expect(msg).toMatch(/do NOT blindly re-issue/i);
    // It must say what was attempted, which "Failed to reach" never did.
    expect(msg).toMatch(/POST/);
    expect(msg).toMatch(/cloud\.comfy\.org\/api\/prompt/);
    // The underlying cause survives — matchers elsewhere look for it.
    expect(msg).toMatch(/fetch failed/);
    expect((err as { code?: string }).code).toBe("ECONNRESET");
  });

  it("stays silent when the connection was refused — nothing could have arrived", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(undiciFailure("ECONNREFUSED", "connect ECONNREFUSED")),
    );

    const err = await cloud.enqueuePrompt({ "1": {} }).catch((e: unknown) => e);
    const msg = (err as Error).message;

    expect(msg).not.toMatch(/may already have been received/i);
    expect(msg).toMatch(/fetch failed/);
  });

  it("stays silent for a READ, which cannot double-bill", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(undiciFailure("ECONNRESET", "read ECONNRESET")),
    );

    const err = await cloud.getJobStatus("p1").catch((e: unknown) => e);
    expect((err as Error).message).not.toMatch(/may already have been received/i);
  });

  // A genuine API error (4xx/5xx with a body) is an ANSWER, not a transport
  // failure. It must keep its own text and never acquire delivery doubt.
  it("leaves a real Cloud API error alone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 402, statusText: "Payment Required" })),
    );

    const err = await cloud.enqueuePrompt({ "1": {} }).catch((e: unknown) => e);
    const msg = (err as Error).message;

    expect(msg).toMatch(/Cloud API error: 402/);
    expect(msg).not.toMatch(/may already have been received/i);
  });
});
