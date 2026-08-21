// #1948 — "a requeued in-flight turn can put an already-dequeued completion back
// where revokeEvent can splice it".
//
// Filed as a maintainer-side residual of #1946 (the fix for #1327's second
// recurrence). #1946 replaced the old `handoffs > 0` guard with "can the #468
// revoker still pull this item back", and documented a successful revoke as PROOF
// that the model has not been shown the text. This file MEASURES that claim
// against the real PanelAgent instead of restating it, because a premise stated
// and never measured is exactly how #1618 shipped dormant and how #1327 came back
// thirteen releases later.
//
// WHAT THE MEASUREMENT SAYS.
//
//   1. The residual is REAL. `revokeEvent` returns false while the carrying turn is
//      live, and TRUE again once `interrupt({ requeueInFlight: true })` has restored
//      that turn's items to the queue — for text the backend was already sent.
//
//   2. The second failure mode in the report is NOT real. It claimed a requeued item
//      carries the drain's batched `eventTokens`, so revoking one token would splice
//      several completions. It does not: `carriedTokens` is assigned to `inFlight` /
//      `turnEventTokens`, `inFlight.items` keeps each item's own single-token array,
//      and the requeue restores those items. Pinned below anyway — a future change
//      that DID put a multi-token array on a queue item would turn that splice into a
//      silent loss of the sibling tokens, which nothing else would catch.
//
//   3. The residual is DELIBERATELY NOT SPECIAL-CASED, and the last two tests are why.
//      The suggested direction — mark carried items and have `revokeEvent` refuse them
//      so "revocable" keeps meaning "never shown" — makes the agent read the WRONG
//      verdict about its own render, in full, with no correction. Allowing the claim
//      costs a partially-seen line in a turn that was ABORTED anyway, and the
//      correction that follows is flagged `replayed` so it reads as a late
//      re-delivery rather than a second render. Duplicate over loss, which is this
//      journal's standing rule.
//
// If you are here because you are about to implement the refusal: the last test is
// the one that will go red, and it is the reason not to.

import { describe, expect, it, vi } from "vitest";

import { PanelAgent } from "../../orchestrator/panel-agent.js";
import { RunCompletionJournalImpl } from "../../orchestrator/run-completion-journal.js";
import { makeCaptureBackend } from "./helpers/capture-backend.js";

const TAB = "wf:workflows/a.json";
const CONV = "conv-1";
const PID = "ba60be81-a4a3-4406-b1d7-56cf571cd72b";

const FRAME = {
  kind: "executed",
  prompt_id: PID,
  duration_s: 0.1,
  images: [{ filename: "ComfyUI_00149_.png" }],
};

const MATCHED = "This is the run YOU queued with panel_run";
const UNDETERMINED = "does NOT match any run you queued";
const REDELIVERED = "RE-DELIVERED — this completion could not be handed to you when it arrived";

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

/** The orchestrator's own wiring (index.ts): inject to flush, revoke + reflush. */
function wire(
  journal: RunCompletionJournalImpl,
  agent: PanelAgent,
  revoke: (token: string) => boolean = (t) => agent.revokeEvent(t),
) {
  const flush = (key: string) =>
    journal.deliverPending(key, (payload, token) =>
      agent.injectEvent(payload as never, { eventToken: token }),
    );
  journal.setRevoker(
    (_key, token) => revoke(token),
    (key) => void flush(key),
  );
  return flush;
}

describe("the requeue window, MEASURED against the real agent (#1948)", () => {
  it("a completion is unrevocable IN a live turn and revocable again once re-queued", async () => {
    const { agent, backend } = startAgent(TAB);
    expect(agent.injectEvent({ ...FRAME } as never, { eventToken: "tok-A" })).toBe(true);

    // The agent DRAINS it: the text has gone to the backend.
    await vi.waitFor(() => expect(backend.turns.length).toBe(1));
    expect(backend.allText()).toContain("A run on the user's canvas just finished");

    // The proof #1946 rests on, and it holds while the turn is live.
    expect(agent.revokeEvent("tok-A")).toBe(false);

    // …and here is the window. "Send now" (and the run-error burst) re-queue the
    // interrupted turn's ORIGINAL items, so the already-read completion is back on
    // the queue with nothing recording that it was ever carried.
    await agent.interrupt({ requeueInFlight: true });

    // THE RESIDUAL, measured rather than argued: revocable again.
    expect(agent.revokeEvent("tok-A")).toBe(true);
    await agent.stop?.();
  });

  it("a re-queued item carries only its OWN token — never the drain's batch", async () => {
    // The report's second failure mode ("revoking one token can remove an item
    // carrying several other completions' tokens") has no producer: the batched
    // `carriedTokens` never go back onto a queue item. Pinned so a change that
    // introduced one would fail HERE rather than silently strand sibling tokens on a
    // spliced item — nothing releases those, so they would not even be replayed.
    const { agent, backend } = startAgent(TAB);
    agent.injectEvent({ ...FRAME } as never, { eventToken: "tok-A" });
    agent.injectEvent({ ...FRAME, prompt_id: "second-pid" } as never, { eventToken: "tok-B" });
    agent.send("and while you're there, upscale it");

    // One turn, three items — the drain merges them, and `inFlight.eventTokens` is the
    // batch ["tok-A", "tok-B"].
    await vi.waitFor(() => expect(backend.turns.length).toBe(1));
    await agent.interrupt({ requeueInFlight: true });

    // THE FACT THE REPORT GOT WRONG: the re-queue restores the ORIGINAL items, each
    // still holding only its own token. The batch stayed on the (now discarded)
    // in-flight turn.
    const requeued = (agent as unknown as { queue: Array<{ eventTokens?: string[] }> }).queue;
    expect(requeued.map((i) => i.eventTokens ?? [])).toEqual([["tok-A"], ["tok-B"], []]);

    // So a splice takes exactly one completion…
    expect(agent.revokeEvent("tok-A")).toBe(true);
    // …the sibling is still there and still separately revocable (it would not be if
    // tok-A's splice had taken its item with it)…
    expect(agent.revokeEvent("tok-B")).toBe(true);
    // …and the user's own message is untouched by either.
    const left = agent.takePending();
    expect(left.map((i) => i.text)).toEqual(["and while you're there, upscale it"]);
    await agent.stop?.();
  });
});

describe("what the claim does in that window, end to end (#1948)", () => {
  /** The reporter's #1327 sequence, with a send-now interrupt landing inside it. */
  async function runWindow(revoke?: (agent: PanelAgent, token: string) => boolean) {
    const journal = new RunCompletionJournalImpl();
    const { agent, backend } = startAgent(TAB);
    const flush = wire(journal, agent, revoke ? (t) => revoke(agent, t) : undefined);

    const dispatchedAt = Date.now();
    // The cached render beats its own /prompt reply back; the live agent takes it.
    journal.record(TAB, FRAME as never, { conversation: CONV });
    expect(flush(TAB).delivered).toBe(1);

    // It drains, so the UNDETERMINED wording really did reach the backend…
    await vi.waitFor(() => expect(backend.turns.length).toBe(1));
    expect(backend.allText()).toContain(UNDETERMINED);

    // …and THEN the panel's "send now" interrupts and re-queues that turn. The
    // `panel_run` call is still awaiting /prompt — it is served by the panel MCP
    // server, not by the turn — so `openRun` still runs after this.
    await agent.interrupt({ requeueInFlight: true });
    journal.openRun(PID, { tabId: TAB, conversation: CONV, toNodeId: 149, dispatchedAt });

    const entry = journal.allOutstanding()[0];
    const reused = (journal.ticketFor(PID) as { reused?: boolean } | undefined)?.reused ?? false;
    // What the agent will actually hand the model next.
    const next = agent.takePending().map((i) => i.text).join("\n");
    await agent.stop?.();
    return { status: entry?.correlation.status, reused, next };
  }

  it("ALLOWING it corrects the verdict, and the correction is disclosed as a replay", async () => {
    const { status, reused, next } = await runWindow();

    // The completion is re-attributed to the run that produced it…
    expect(status).toBe("matched");
    // …the ticket stays clean, so LATER completions for the same run are still
    // attributable (the second-order harm #1618 claimed to fix)…
    expect(reused).toBe(false);
    // …the stale copy is gone from the queue, and what replaces it says the honest
    // thing AND flags itself as a late re-delivery, so the agent does not count the
    // partially-seen copy and this one as two renders.
    expect(next).toContain(MATCHED);
    expect(next).toContain(REDELIVERED);
    expect(next).not.toContain(UNDETERMINED);
  });

  it("REFUSING it (the suggested fix) re-introduces #1327's reported harm", async () => {
    // The suggested direction, simulated exactly: mark items the drain has carried and
    // have the revoker refuse those, so "still revocable" keeps meaning "never shown".
    const carried = new WeakSet<object>();
    const { status, reused, next } = await runWindow((agent, token) => {
      const queue = (agent as unknown as { queue: object[] }).queue;
      // Everything on the queue at revoke time got there via the re-queue, i.e. it was
      // carried — which is the whole state the suggested `dequeuedAt` flag would record.
      for (const item of queue) carried.add(item);
      const hit = (queue as Array<{ eventTokens?: string[] }>).find((i) =>
        i.eventTokens?.includes(token),
      );
      if (hit && carried.has(hit)) return false; // "partially read — refuse"
      return agent.revokeEvent(token);
    });

    // The proof is now strictly correct — and the agent is strictly worse off. Its own
    // successful render is still reported as UNDETERMINED, and this time it reads that
    // verdict in FULL, with no correction behind it. That is the exact sentence #1327
    // was filed about: it does not merely mislabel a result, it tells the agent to
    // disbelieve a correct one.
    expect(status).toBe("foreign");
    expect(next).toContain(UNDETERMINED);
    expect(next).not.toContain(MATCHED);
    // …and it does not stop at this one completion. With the claim refused, the entry
    // is still journaled under an id the fresh ticket has no history for, so the ticket
    // is marked REUSED — which turns EVERY later completion for that run undetermined
    // too. That is the second-order harm #1618/#1946 exist to prevent, and refusing the
    // requeued item hands it straight back.
    expect(reused).toBe(true);
  });
});
