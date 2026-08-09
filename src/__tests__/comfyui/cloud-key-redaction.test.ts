// #1191 (codex review) — the CLOUD API KEY was not among the known values the
// scrubber redacts.
//
// `getComfyUIAuthHeaders()` carries the ComfyUI auth token and the Cloudflare
// Access pair. It does NOT carry COMFYUI_API_KEY, which cloud-client sends as
// `X-API-Key` — so the cloud enqueue error path, whose body is the one most
// likely to reflect that key back, had no known-value pass for it at all.
//
// The by-name pass catches a LABELLED reflection ("api-key: …"). An UNLABELLED
// echo of a short key has neither a recognized label nor the 24-character
// opaque-run shape, and went straight out. That is the case pinned here.

import { describe, expect, it, vi } from "vitest";

const CLOUD_KEY = "cmfy-7Q2w9Z";      // short + unlabelled: no other pass catches it
const HF_TOKEN = "hf_aBcD3fGh1jK";

vi.mock("../../config.js", () => ({
  getComfyUIAuthHeaders: () => ({}),   // deliberately EMPTY: the old known-value source
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  config: { comfyuiApiKey: CLOUD_KEY, huggingfaceToken: HF_TOKEN, civitaiApiToken: undefined },
}));

const { scrubSecretShapedText, bodyPrefixOf } = await import("../../comfyui/json-guard.js");

describe("the scrubber knows every configured credential (#1191)", () => {
  it("redacts an UNLABELLED reflected cloud API key", () => {
    const out = scrubSecretShapedText(`upstream rejected ${CLOUD_KEY} at edge`);
    // null = withheld entirely (also acceptable); a returned string must not
    // carry the key.
    expect(out === null || !out.includes(CLOUD_KEY)).toBe(true);
  });

  it("redacts a reflected HuggingFace token", () => {
    const out = scrubSecretShapedText(`fetch failed for ${HF_TOKEN}`);
    expect(out === null || !out.includes(HF_TOKEN)).toBe(true);
  });

  it("bodyPrefixOf never returns the cloud key", () => {
    const body = JSON.stringify({ echo: { headers: { "X-API-Key": CLOUD_KEY } } });
    expect(bodyPrefixOf(body)).not.toContain(CLOUD_KEY);
  });

  it("leaves ordinary text alone", () => {
    // Fail-closed must not mean fail-always: an unrelated body still reads.
    const out = scrubSecretShapedText("upstream gateway exploded");
    expect(out).toBe("upstream gateway exploded");
  });
});
