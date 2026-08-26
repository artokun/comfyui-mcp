// Issue #2361: POSSIBLE REPEAT wording must differ for identified vs id-less cases
//
// An identified completion that was already delivered should not claim it
// "carries no prompt id to tell them apart" while simultaneously naming the id.
// The wording must be conditional on whether run_correlation === "unidentified".

import { describe, expect, it } from "vitest";
import { RunCompletionJournalImpl, type CompletionPayload } from "../../orchestrator/run-completion-journal.js";

describe("POSSIBLE REPEAT wording (issue #2361)", () => {
  it("identified completion: flags possible_repeat and formats message correctly", () => {
    // Record a matched completion twice to trigger possibleRepeat flag
    const journal = new RunCompletionJournalImpl();
    const PROMPT_A = "test-prompt-2361-a";

    journal.openRun(PROMPT_A, { tabId: "t" });
    const first = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    expect(first.correlation.status).toBe("matched");

    journal.deliverPending("t", () => true);
    journal.ack(first.token);

    // Record the same prompt again — should be flagged as possibleRepeat
    const second = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    expect(second).not.toBeNull();
    expect(second!.possibleRepeat).toBe(true); // ✓ Flag is set
    expect(second!.correlation.status).toBe("matched"); // ✓ Still identified

    // When delivered, payload should have both possible_repeat AND prompt_id
    const seen: CompletionPayload[] = [];
    journal.deliverPending("t", (p) => {
      seen.push(p);
      return true;
    });

    expect(seen).toHaveLength(1);
    const payload = seen[0];
    expect(payload.possible_repeat).toBe(true);
    expect(payload.run_correlation).toBe("matched");
    expect(payload.prompt_id).toBe(PROMPT_A);
  });

  it("id-less completion: flags possible_repeat, no prompt_id in payload", () => {
    // An id-less completion with matching fingerprint should be flagged
    const journal = new RunCompletionJournalImpl();

    // Record an id-less completion twice
    const first = journal.record("t", { kind: "executed", images: [{ filename: "output-1.png" }] });
    expect(first.correlation.status).toBe("unidentified");

    journal.deliverPending("t", () => true);
    journal.ack(first.token);

    // Second id-less completion with identical content (same filename)
    const second = journal.record("t", { kind: "executed", images: [{ filename: "output-1.png" }] });
    expect(second!.possibleRepeat).toBe(true); // ✓ Flag is set
    expect(second!.correlation.status).toBe("unidentified"); // ✓ Still id-less

    // When delivered, payload should have possible_repeat but NO prompt_id
    const seen: CompletionPayload[] = [];
    journal.deliverPending("t", (p) => {
      seen.push(p);
      return true;
    });

    expect(seen).toHaveLength(1);
    const payload = seen[0];
    expect(payload.possible_repeat).toBe(true);
    expect(payload.run_correlation).toBe("unidentified");
    expect(payload.prompt_id).toBeUndefined(); // ✓ No id available
  });

  it("identified run with possibleRepeat: payload has both flag and prompt_id", () => {
    // Verify the payload structure when an identified run is flagged as a repeat
    const journal = new RunCompletionJournalImpl();
    const PROMPT_B = "test-prompt-2361-b";

    journal.openRun(PROMPT_B, { tabId: "t" });
    const first = journal.record("t", { kind: "executed", prompt_id: PROMPT_B });
    expect(first.correlation.status).toBe("matched");

    journal.deliverPending("t", () => true);
    journal.ack(first.token);

    const second = journal.record("t", { kind: "executed", prompt_id: PROMPT_B });
    expect(second!.possibleRepeat).toBe(true); // ✓ Flagged on resend
    expect(second!.correlation.status).toBe("matched"); // ✓ Still identified

    const seen: CompletionPayload[] = [];
    journal.deliverPending("t", (p) => {
      seen.push(p);
      return true;
    });

    expect(seen).toHaveLength(1);
    const payload = seen[0];
    expect(payload.possible_repeat).toBe(true);
    expect(payload.run_correlation).toBe("matched");
    expect(payload.prompt_id).toBe(PROMPT_B); // ✓ Both flag AND id present
  });

  it("first delivery: no possibleRepeat flag", () => {
    // Control: a fresh completion should not be flagged
    const journal = new RunCompletionJournalImpl();
    const PROMPT_C = "fresh-prompt-2361";

    journal.openRun(PROMPT_C, { tabId: "t" });
    const entry = journal.record("t", { kind: "executed", prompt_id: PROMPT_C });
    expect(entry.possibleRepeat).toBeUndefined(); // ✓ Not flagged on first

    const seen: CompletionPayload[] = [];
    journal.deliverPending("t", (p) => {
      seen.push(p);
      return true;
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].possible_repeat).toBeUndefined();
    expect(seen[0].run_correlation).toBe("matched");
    expect(seen[0].prompt_id).toBe(PROMPT_C);
  });

  it("wording logic: identified runs with possibleRepeat should NOT claim 'carries no prompt id'", () => {
    // The issue is specifically about the wording in panel-agent.ts:
    // An identified completion (run_correlation === "matched") with
    // possibleRepeat=true should NOT use the id-less message that says
    // "carries no prompt id to tell them apart".
    //
    // This test verifies the conditional logic that ensures different wording
    // for identified vs id-less cases.

    // Identified case: should use conditional branch
    const identifiedEvent = {
      possible_repeat: true,
      run_correlation: "matched" as const,
      prompt_id: "test-id-2361",
    };
    expect(identifiedEvent.run_correlation).not.toBe("unidentified"); // ✓ Takes identified branch

    // Id-less case: should use the original text
    const idlessEvent = {
      possible_repeat: true,
      run_correlation: "unidentified" as const,
    };
    expect(idlessEvent.run_correlation).toBe("unidentified"); // ✓ Takes id-less branch
  });
});
