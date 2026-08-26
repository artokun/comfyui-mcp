// #2361 — "POSSIBLE REPEAT text claims the completion 'carries no prompt id' even
// when it names one".
//
// The warning the orchestrator prepends to a run-completion turn was worded for
// the ID-LESS case only, but the flag that renders it is also set on the
// IDENTIFIED path: `alreadyDelivered` is computed inside the
// `correlation.status !== "unidentified"` branch of `record()`. So an agent turn
// could read, verbatim:
//
//   ⚠️ POSSIBLE REPEAT: … this one carries no prompt id to tell them apart.
//   This is the run YOU queued with panel_run (prompt 122c1547-…).
//
// The first sentence denies the id; the second prints it. A reporter hit exactly
// this on panel#1842 and concluded the dedupe was ignoring an id it had, which
// sent that investigation looking for an id-less emitter that was never involved.
//
// WHAT IS AND IS NOT UNDER TEST. The FLAG is correct and deliberately unchanged —
// `alreadyDelivered` is a label, never a veto, and suppressing an identified
// resend would trade a duplicate for a silent loss. Only the SENTENCE moves.
//
// These tests drive the REAL path — journal.record → deliverPending →
// PanelAgent.injectEvent → backend — because the defect lives in the composer,
// not in the journal. A journal-only assertion cannot see this bug at all: it
// passes identically before and after the fix, since the payload it inspects was
// always correct. The text handed to the agent is the artifact under test.

import { describe, expect, it, vi } from "vitest";

import { PanelAgent } from "../../orchestrator/panel-agent.js";
import { RunCompletionJournalImpl } from "../../orchestrator/run-completion-journal.js";
import { makeCaptureBackend } from "./helpers/capture-backend.js";

const TAB = "wf:workflows/a.json";
const CONV = "orchestrator::claude";
const PID = "122c1547-990a-4ea2-8594-95998585a364";

/** The sentence that must NEVER appear next to a named prompt id. */
const IDLESS_CLAIM = "carries no prompt id to tell them apart";
/** The identity preamble the id-less claim was contradicting. */
const MATCHED = "This is the run YOU queued with panel_run";

function startAgent(tabId: string) {
  const backend = makeCaptureBackend();
  const agent = new PanelAgent(
    tabId,
    { mcpServers: {}, systemAppend: "", model: "m" } as never,
    backend,
  );
  void agent.start();
  return { agent, backend };
}

/** The orchestrator's own wiring: drain the journal into the live agent. */
function flush(journal: RunCompletionJournalImpl, agent: PanelAgent) {
  return journal.deliverPending(TAB, (payload, token) =>
    agent.injectEvent(payload as never, { eventToken: token }),
  );
}

describe("POSSIBLE REPEAT wording is chosen on the correlation (#2361)", () => {
  it("an IDENTIFIED repeat does not claim it has no id, and names the id instead", async () => {
    const { agent, backend } = startAgent(TAB);
    const journal = new RunCompletionJournalImpl();

    // The issue's repro, steps 1-3: queue, complete, deliver, ack.
    journal.openRun(PID, { tabId: TAB, conversation: CONV });
    const first = journal.record(
      TAB,
      { kind: "executed", prompt_id: PID, images: [{ filename: "ComfyUI_00149_.png" }] },
      { conversation: CONV },
    );
    expect(first.correlation.status).toBe("matched");
    // Settle it through a sink rather than the agent. Its only job is to make
    // `alreadyDelivered` true for the record below; keeping it out of the agent
    // leaves exactly ONE turn to assert on, so the text under test cannot be
    // confused with the first delivery's.
    journal.deliverPending(TAB, () => true);
    journal.ack(first.token);

    // Step 4: the panel re-sends the same completion. It is flagged — correctly,
    // and this assertion is setup, not the subject: if the flag ever stopped
    // being set here the composer branch below would be unreachable and the rest
    // of this test would pass for the wrong reason.
    const second = journal.record(
      TAB,
      { kind: "executed", prompt_id: PID, images: [{ filename: "ComfyUI_00149_.png" }] },
      { conversation: CONV },
    );
    expect(second.possibleRepeat).toBe(true);
    expect(second.correlation.status).toBe("matched");

    // Step 5: render it through the composer the agent actually reads.
    expect(flush(journal, agent).delivered).toBe(1);
    await vi.waitFor(() => expect(backend.turns.length).toBe(1));
    const text = backend.turns[0].text ?? "";

    // The warning still fires — the flag is a label and we do not swallow it.
    expect(text).toContain("POSSIBLE REPEAT");
    // THE DEFECT: it must not deny an id it is about to print.
    expect(text).not.toContain(IDLESS_CLAIM);
    // …and it says what is actually true, naming the id as the thing to check.
    expect(text).toContain(`a completion for this run (prompt ${PID})`);
    // The preamble that produced the contradiction is still there and still
    // names the same id — so this is the exact pairing from the report, now
    // coherent rather than self-negating.
    expect(text).toContain(MATCHED);
    expect(text).toContain(PID);

    await agent.stop?.();
  });

  it("an ID-LESS repeat keeps the original wording — it genuinely has no id", async () => {
    // The control. This path is the one the sentence was written for, and the
    // fix must leave it exactly as it was.
    const { agent, backend } = startAgent(TAB);
    const journal = new RunCompletionJournalImpl();

    const first = journal.record(
      TAB,
      { kind: "executed", images: [{ filename: "ComfyUI_00150_.png" }] },
      { conversation: CONV },
    );
    expect(first.correlation.status).toBe("unidentified");
    journal.deliverPending(TAB, () => true);
    journal.ack(first.token);

    const second = journal.record(
      TAB,
      { kind: "executed", images: [{ filename: "ComfyUI_00150_.png" }] },
      { conversation: CONV },
    );
    expect(second.possibleRepeat).toBe(true);
    expect(second.correlation.status).toBe("unidentified");

    expect(flush(journal, agent).delivered).toBe(1);
    await vi.waitFor(() => expect(backend.turns.length).toBe(1));
    const text = backend.turns[0].text ?? "";

    expect(text).toContain("POSSIBLE REPEAT");
    // Still honest here: there really is no id to tell them apart.
    expect(text).toContain(IDLESS_CLAIM);
    // And it must not have acquired the identified branch's sentence, which
    // would print "(prompt undefined)" on a payload that carries no id.
    expect(text).not.toContain("a completion for this run (prompt");
    expect(text).not.toContain("(prompt undefined)");

    await agent.stop?.();
  });

  it("a FIRST delivery carries no repeat warning at all", async () => {
    // Guards the branch itself: if `possible_repeat` were ever set
    // unconditionally, both tests above would still pass while every ordinary
    // completion gained a false duplicate warning.
    const { agent, backend } = startAgent(TAB);
    const journal = new RunCompletionJournalImpl();

    journal.openRun(PID, { tabId: TAB, conversation: CONV });
    journal.record(
      TAB,
      { kind: "executed", prompt_id: PID, images: [{ filename: "ComfyUI_00151_.png" }] },
      { conversation: CONV },
    );
    flush(journal, agent);
    await vi.waitFor(() => expect(backend.turns.length).toBe(1));

    const text = backend.turns[0].text ?? "";
    expect(text).not.toContain("POSSIBLE REPEAT");
    expect(text).not.toContain(IDLESS_CLAIM);
    expect(text).toContain(MATCHED);

    await agent.stop?.();
  });
});
