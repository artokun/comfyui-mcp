// #1327, SECOND RECURRENCE — reported 2026-08-21 on comfyui-mcp 0.52.25 / panel
// 0.15.22, thirteen releases after the previous fix (#1618, v0.51.57) shipped.
//
//   panel_run(to_node_id: 149) returned prompt ba60be81-…; its delayed re-delivery
//   carried the identical id but said it did not match a queued run and marked the
//   origin UNDETERMINED. get_history confirmed success and output node 149.
//
// #1618 IS A FIX PRODUCTION NEVER REACHED, and its own tests are why nobody saw it.
// It moved the claim guard from `attempts` to `handoffs` on the stated premise that
// the arrival flush is REFUSED — "the agent is busy inside the very panel_run call
// whose reply has not come back yet" — and it PINNED that premise by hard-coding the
// refusal in the test: `journal.deliverPending(TAB, () => false)`.
//
// The real `PanelAgent.injectEvent` has no busy check. It refuses only for an agent
// that is missing, stopped, or handed a payload it cannot compose text for. For the
// ordinary via-panel session the agent exists and is mid-turn, so the flush TAKES the
// completion and returns true — `handoffs` is 1 before `openRun` ever runs, and the
// claim is skipped on precisely the race it exists to repair. Both counters are 1 at
// that instant, so swapping one for the other changed nothing on the live path.
//
// These tests drive the REAL PanelAgent and the REAL revoker wiring, so the premise
// cannot be assumed again — it is measured here (see the BASELINE test), and every
// verdict below is the one an agent would actually be shown.

import { describe, expect, it, vi } from "vitest";

import { PanelAgent } from "../../orchestrator/panel-agent.js";
import { RunCompletionJournalImpl } from "../../orchestrator/run-completion-journal.js";
import { makeCaptureBackend } from "./helpers/capture-backend.js";

const TAB = "wf:workflows/a.json";
const CONV = "conv-1";
const PID = "ba60be81-a4a3-4406-b1d7-56cf571cd72b";

/** The panel's real `executed` frame for the reporter's run. */
const FRAME = {
  kind: "executed",
  prompt_id: PID,
  duration_s: 0.1,
  images: [{ filename: "ComfyUI_00149_.png" }],
};

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

/**
 * The orchestrator's own wiring, verbatim in shape: `flushRunCompletions` injects
 * into the tab's agent, and `setRevoker` is given BOTH the revoke and the reflush
 * (index.ts). Tests that skip the revoker are testing a journal production does not
 * run — which is exactly how the previous fix passed while dormant.
 */
function wire(journal: RunCompletionJournalImpl, agent: PanelAgent) {
  const flush = (key: string) =>
    journal.deliverPending(key, (payload, token) =>
      agent.injectEvent(payload as never, { eventToken: token }),
    );
  journal.setRevoker(
    (_key, token) => agent.revokeEvent(token),
    (key) => void flush(key),
  );
  return flush;
}

describe("the premise the previous fix rested on, MEASURED (#1327)", () => {
  it("the arrival flush is TAKEN by a live agent — idle AND mid-turn", async () => {
    const { agent } = startAgent(TAB);

    const idle = agent.injectEvent({ ...FRAME } as never, { eventToken: "tok-idle" });
    // …and now with a turn genuinely in flight, which is the state #1618 assumed
    // would refuse.
    agent.send("render it" as never);
    expect(agent.isBusy).toBe(true);
    const midTurn = agent.injectEvent({ ...FRAME } as never, { eventToken: "tok-busy" });

    // THE DEFECT'S ROOT: both are hand-offs, so `handoffs > 0` was true before
    // `openRun` ran. Neither of these is a refusal.
    expect(idle).toBe(true);
    expect(midTurn).toBe(true);
    await agent.stop?.();
  });
});

describe("a completion that beat its ticket is claimed even once QUEUED (#1327)", () => {
  it("the reporter's sequence, end to end, through the real agent", async () => {
    const journal = new RunCompletionJournalImpl();
    const { agent, backend } = startAgent(TAB);
    const flush = wire(journal, agent);
    agent.send("render it" as never); // the turn sitting inside panel_run

    const dispatchedAt = Date.now();
    // The 0.1s cached render beats its own /prompt reply: index.ts records, then
    // flushes immediately — and the live agent TAKES it.
    journal.record(TAB, FRAME as never, { conversation: CONV });
    const arrival = flush(TAB);
    expect(arrival.delivered).toBe(1); // taken, not refused — the production ordering
    expect(arrival.blockedOn).toBeNull();

    // …and only now does the /prompt reply come back and open the ticket.
    journal.openRun(PID, { tabId: TAB, conversation: CONV, toNodeId: 149, dispatchedAt });

    const entry = journal.allOutstanding()[0];
    // THE RECURRENCE: this was `foreign` — the reporter's "origin is UNDETERMINED".
    expect(entry?.correlation.status).toBe("matched");
    // …and the second-order harm #1618 also claimed to fix was back with it: the
    // already-journaled entry made the fresh ticket `reused`, so EVERY later
    // completion for the run read UNDETERMINED too.
    expect((journal.ticketFor(PID) as { reused?: boolean } | undefined)?.reused ?? false).toBe(
      false,
    );

    // AND THE AGENT MUST ACTUALLY HAVE IT. Revoking without re-delivering would
    // replace a wrong verdict with no verdict at all — strictly worse. This is the
    // assertion that fails if `reissueClaimed` is deleted from the call site.
    // Asserted on CONTENT, not on a turn count: the agent batches everything queued
    // into one turn, so the completion may ride the same turn as the user message.
    // (Also NOT backend.waitForTurns() — that helper re-queues its own waiter from
    // inside the backend's drain loop and spins the event loop forever when it is
    // asked for a count the backend has not reached yet.)
    await vi.waitFor(() =>
      expect(backend.allText()).toContain("This is the run YOU queued with panel_run"),
    );
    const text = backend.allText();
    expect(text).toContain("This is the run YOU queued with panel_run");
    expect(text).toContain("ComfyUI_00149_.png");
    expect(text).not.toContain("does NOT match any run you queued");
    // Exactly one completion reached it — the revoked copy never did.
    expect(text.split("A run on the user's canvas just finished").length - 1).toBe(1);
    await agent.stop?.();
  });
});

describe("…and UNDETERMINED still fires when it should (#1327)", () => {
  it("a verdict the carrying turn ALREADY READ is never rewritten under it", async () => {
    // The guard's whole reason for existing. Once the injected item has been dequeued
    // into a running turn the text is in the model's context and cannot be recalled —
    // `revokeEvent` says so by returning false, and the claim must respect it.
    const journal = new RunCompletionJournalImpl();
    const { agent, backend } = startAgent(TAB);
    const flush = wire(journal, agent);

    const dispatchedAt = Date.now();
    journal.record(TAB, FRAME as never, { conversation: CONV });
    expect(flush(TAB).delivered).toBe(1);
    // The agent DRAINS it — the turn carrying the foreign wording has now started.
    await vi.waitFor(() => expect(backend.turns.length).toBe(1));
    expect(backend.allText()).toContain("does NOT match any run you queued");

    journal.openRun(PID, { tabId: TAB, conversation: CONV, toNodeId: 149, dispatchedAt });

    const entry = journal.allOutstanding()[0];
    expect(entry?.correlation.status).toBe("foreign");
    await agent.stop?.();
  });

  it("a completion from BEFORE the dispatch is not claimed — and not even pulled back", async () => {
    // The over-broad direction, and the one that matters most: an id genuinely reused
    // by ComfyUI carries a completion that predates this dispatch. Claiming it would
    // attribute an older run's result to a new one, which is worse than the bug.
    //
    // The entry here IS revocable (queued, unread), so only the timing proof refuses
    // it — and the revoke must never have been attempted, or a completion would be
    // yanked off an agent's queue for a claim that is then rejected.
    const journal = new RunCompletionJournalImpl();
    const { agent } = startAgent(TAB);
    const flush = wire(journal, agent);

    journal.record(TAB, { ...FRAME, duration_s: 9 } as never, { conversation: CONV });
    expect(flush(TAB).delivered).toBe(1);
    const token = journal.allOutstanding()[0]?.token as string;

    // The dispatch happens AFTER that arrival.
    journal.openRun(PID, { tabId: TAB, conversation: CONV, dispatchedAt: Date.now() + 5_000 });

    expect(journal.allOutstanding()[0]?.correlation.status).toBe("foreign");
    // Still sitting on the agent's queue, untouched: a successful revoke here proves
    // the claim never reached for it.
    expect(agent.revokeEvent(token)).toBe(true);
    await agent.stop?.();
  });

  it("another party's completion is not claimed, however revocable it is", async () => {
    const journal = new RunCompletionJournalImpl();
    const { agent } = startAgent("wf:other.json");
    const flush = wire(journal, agent);

    const dispatchedAt = Date.now();
    journal.record("wf:other.json", FRAME as never, { conversation: "conv-2" });
    expect(flush("wf:other.json").delivered).toBe(1);

    journal.openRun(PID, { tabId: TAB, conversation: CONV, dispatchedAt });

    expect(journal.allOutstanding()[0]?.correlation.status).toBe("foreign");
    await agent.stop?.();
  });

  it("an ID-LESS completion is never claimed, queued or not", async () => {
    const journal = new RunCompletionJournalImpl();
    const { agent } = startAgent(TAB);
    const flush = wire(journal, agent);

    const dispatchedAt = Date.now();
    journal.record(TAB, { kind: "executed", images: [{ filename: "x.png" }] } as never, {
      conversation: CONV,
    });
    expect(flush(TAB).delivered).toBe(1);

    journal.openRun(PID, { tabId: TAB, conversation: CONV, dispatchedAt });

    expect(journal.allOutstanding()[0]?.correlation.status).toBe("unidentified");
    await agent.stop?.();
  });

  it("with NO revoker installed a handed-off entry is left exactly as before", () => {
    // Fail-closed: a journal that cannot ask the agent anything must not assume the
    // answer. (This is also every bare-journal caller in the rest of the suite.)
    const journal = new RunCompletionJournalImpl();
    const dispatchedAt = Date.now();
    journal.record(TAB, FRAME as never, { conversation: CONV });
    journal.deliverPending(TAB, () => true); // taken, and unrevocable
    journal.release(journal.allOutstanding()[0]?.token as string, { carried: true });

    journal.openRun(PID, { tabId: TAB, conversation: CONV, dispatchedAt });

    expect(journal.allOutstanding()[0]?.correlation.status).toBe("foreign");
  });
});

describe("WIRING: the claim depends on a revoker the orchestrator actually installs", () => {
  it("index.ts gives setRevoker BOTH a revoke and a reflush", async () => {
    // `stillUnread` can only pull an entry back if production installed the revoker,
    // and `reissueClaimed` can only re-deliver it if production installed the REFLUSH.
    // Drop either argument and the fix goes dormant with every unit test still green —
    // which is the exact failure mode #1618 shipped with.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../orchestrator/index.ts", import.meta.url), "utf-8");

    const at = src.indexOf("RunCompletions.setRevoker(");
    expect(at).toBeGreaterThan(-1);
    const call = src.slice(at, src.indexOf(");", at));
    expect(call).toContain("manager.revokeEvent(");
    expect(call).toContain("flushRunCompletions(");
  });
});
