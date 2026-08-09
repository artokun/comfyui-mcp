// #1206 — /internal/logs reached a tool result with no credential scrub.
//
// A ComfyUI log is a plausible place for one to appear: a custom node logging
// the URL it fetched (CivitAI and HuggingFace download URLs routinely carry a
// token in the query string), ComfyUI-Manager logging an install URL, or any
// node logging a request header on failure.
//
// Both consumers are DIAGNOSTICS — get_system_stats action:"logs" and the health
// report — so they are called exactly when something is wrong, and their output
// is what a user pastes into a bug report. Found during the review of #1191.

import { describe, expect, it, vi } from "vitest";

const HF = "hf_aBcD3fGh1jKlMnOpQrStUvWxYz";
const CIVITAI = "civitai-9f2b7c41aa6e4d0e8b3f5a1c";

vi.mock("../../config.js", () => ({
  getComfyUIAuthHeaders: () => ({}),
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  config: { huggingfaceToken: HF, civitaiApiToken: CIVITAI, comfyuiApiKey: undefined },
}));

const { scrubLogLines } = await import("../../comfyui/json-guard.js");

describe("scrubLogLines (#1206)", () => {
  it("redacts a token in a logged download URL", () => {
    const out = scrubLogLines([
      `[INFO] fetching https://huggingface.co/org/repo/resolve/main/m.safetensors?token=${HF}`,
    ]);
    expect(out[0]).not.toContain(HF);
    // The line is still a line — the URL and the action survive.
    expect(out[0]).toContain("huggingface.co/org/repo");
    expect(out[0]).toContain("fetching");
  });

  it("redacts a CivitAI token too", () => {
    const out = scrubLogLines([`[INFO] GET https://civitai.com/api/download/1?token=${CIVITAI}`]);
    expect(out[0]).not.toContain(CIVITAI);
  });

  it("keeps ordinary log lines EXACTLY as they were", () => {
    // The whole value of a log is its fidelity. A scrub that rewrites innocent
    // lines makes the diagnostic untrustworthy.
    const lines = [
      "[INFO] Starting server",
      "Traceback (most recent call last):",
      '  File "/x/nodes.py", line 42, in load',
      "RuntimeError: CUDA out of memory",
    ];
    expect(scrubLogLines(lines)).toEqual(lines);
  });

  it("preserves the LINE COUNT — nothing is silently dropped", () => {
    const lines = ["a", `token=${HF}`, "c"];
    expect(scrubLogLines(lines)).toHaveLength(3);
  });

  // The FAIL-CLOSED half lives in log-scrub-withhold.test.ts: it needs a SHORT
  // configured credential (the documented "too short to replace safely" trigger)
  // and therefore a different config mock than the redaction cases here.
  //
  // Worth recording why: my first attempt tested it in this file with a
  // zero-width space, which `\s` does not match — so it never reached the null
  // branch and passed for the wrong reason.


  it("is a no-op on an empty log", () => {
    expect(scrubLogLines([])).toEqual([]);
  });
});

// THE WIRING. The helper cannot see whether its two consumers call it — the
// call-site blindness this repo keeps getting caught by. Both emit into a tool
// result, so both must.
describe("both log consumers scrub (#1206)", () => {
  it("getLogs and the health report both route through scrubLogLines", async () => {
    const { readFileSync } = await import("node:fs");
    const client = readFileSync(new URL("../../comfyui/client.ts", import.meta.url), "utf-8");
    const health = readFileSync(
      new URL("../../services/health-check.ts", import.meta.url),
      "utf-8",
    );

    // getLogs has TWO return paths — JSON-encoded and raw text — and both carry
    // the same exposure.
    const start = client.indexOf("export async function getLogs");
    const body = client.slice(start, client.indexOf("\n}", start));
    expect(body.split("scrubLogLines(").length - 1).toBe(2);

    // The health report emits matching error lines into its own text.
    expect(health).toContain("scrubLogLines(");
  });
});
