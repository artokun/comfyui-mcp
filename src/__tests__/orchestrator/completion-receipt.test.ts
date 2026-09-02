import { describe, expect, it } from "vitest";
import { buildCompletionReceipt } from "../../orchestrator/completion-receipt.js";

const PROMPT_ID = "8812d3a2-75e8-4ae5-b4d8-0a5b1e7c9f20";
const COMPLETION_KEY = JSON.stringify(["route-925", "conversation-925", PROMPT_ID, "nonce-1"]);

describe("#2700 completion receipts", () => {
  it("negatively acknowledges a keyed frame that reached the journal but is uncorrelated", () => {
    expect(buildCompletionReceipt(PROMPT_ID, COMPLETION_KEY, false)).toEqual({
      type: "ack",
      ok: false,
      kind: "completion",
      prompt_id: PROMPT_ID,
      completion_key: COMPLETION_KEY,
      reason: "uncorrelated",
    });
  });

  it("keeps accepted receipts unchanged and without a failure reason", () => {
    expect(buildCompletionReceipt(PROMPT_ID, COMPLETION_KEY, true)).toEqual({
      type: "ack",
      ok: true,
      kind: "completion",
      prompt_id: PROMPT_ID,
      completion_key: COMPLETION_KEY,
    });
  });

  it("does not emit a receipt for an incomplete or oversized identity", () => {
    expect(buildCompletionReceipt("", COMPLETION_KEY, false)).toBeUndefined();
    expect(buildCompletionReceipt(PROMPT_ID, "", false)).toBeUndefined();
    expect(buildCompletionReceipt(PROMPT_ID, "x".repeat(513), false)).toBeUndefined();
  });
});
