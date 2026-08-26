// #468 — `panel_run`'s completion event must survive AUTOMATIC GOAL CONTINUATION.
//
// The old delivery path (agent_event → manager.injectEvent → PanelAgent.queue)
// was fire-and-forget: uncorrelated, silently dropped when no agent was live,
// and discarded outright when a queued-but-unread item died with its agent. An
// ordinary single run leaves the agent IDLE, so the completion is drained
// instantly and none of that shows. A goal continuation keeps the agent BUSY for
// the whole render — which is exactly the window where the completion sits
// unread and the continuation's own turn churn (deferred effort/MCP restarts,
// the self-restart loop) tears the listener down underneath it.
//
// These tests lock the four properties the fix promises:
//   1. delivered across a continuation (the agent is busy the whole render);
//   2. a completion with no live agent is JOURNALED and replayed, correlated to
//      the run it arrived for;
//   3. a completion that cannot be correlated is REPORTED as undetermined, never
//      swallowed and never presented as the awaited render;
//   4. a replay can never satisfy a DIFFERENT run.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";
import {
  RunCompletionJournalImpl,
  describe as describeCorrelation,
  type CompletionPayload,
} from "../../orchestrator/run-completion-journal.js";
import { AskAnswerJournalImpl } from "../../orchestrator/ask-answer-journal.js";

let PanelAgentManager: typeof import("../../orchestrator/panel-agent.js").PanelAgentManager;

beforeAll(async () => {
  // Short freeze window so the #587 stall/steer path is reachable deterministically.
  // panel-agent reads this at module load, hence the dynamic import below it.
  process.env.COMFYUI_MCP_TURN_IDLE_MS = "150";
  ({ PanelAgentManager } = await import("../../orchestrator/panel-agent.js"));
});

const PROMPT_A = "246da5fc-a6b4-4e85-bbd5-5f2463a757a0";
const PROMPT_B = "5bc36c41-fe83-481f-8a71-b9dd1c3b05a4";
// #1516 — a sweep queues several runs, and their completions share one turn.
const PROMPT_C = "9f1e2d3c-4b5a-6978-8c7d-0e1f2a3b4c5d";
const PROMPT_D = "11112222-3333-4444-5555-666677778888";

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * A backend that models AUTOMATIC GOAL CONTINUATION: it holds each turn open
 * until the test releases it, so the agent is continuously busy while the render
 * completes — the exact state the completion has to survive.
 */
class ContinuationBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES; // declares turnMarkers: true
  turns: string[] = [];
  turnImages: string[][] = [];
  /** Resolves the turn currently in flight. */
  private release: (() => void) | null = null;
  /** When true, a turn never produces a `result` (a stalled/abandoned turn). */
  strandTurns = false;

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: "sess-468" };
    let turnSeq = 0;
    for await (const turn of opts.channel) {
      this.turns.push((turn as { text?: string }).text ?? "");
      this.turnImages.push((turn.images ?? []).map((image) => image.filename));
      turnSeq += 1;
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
      if (this.strandTurns) continue;
      // Stamped with its own turn marker, exactly as a real marker-declaring
      // backend does — that is what lets it ack the completion it carried.
      yield { type: "result", ok: true, subtype: "success", turn: turnSeq };
    }
  }

  /** Let the in-flight turn finish (its `result` acks any carried completion). */
  finishTurn(): void {
    const r = this.release;
    this.release = null;
    r?.();
  }

  async interrupt(): Promise<void> {
    this.finishTurn();
  }
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

/**
 * A MARKER-STAMPING backend (like Claude): every turn's events carry the turn's
 * marker, and the test drives the event stream by hand so a straggler from an
 * abandoned turn can be injected at will.
 */
class MarkerBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES; // declares turnMarkers: true
  turns: string[] = [];
  private sink: ((ev: AgentEvent) => void) | null = null;
  private queued: AgentEvent[] = [];
  /** When true a turn emits NO stamped event at all (the zero-output turn whose
   *  traceless terminal is what breaks a learn-by-observation ack gate). */
  private readonly silentTurns: boolean;

  constructor(opts: { silentTurns?: boolean } = {}) {
    this.silentTurns = opts.silentTurns === true;
  }

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    let wake: (() => void) | null = null;
    this.sink = (ev) => {
      this.queued.push(ev);
      const w = wake;
      wake = null;
      w?.();
    };
    void (async () => {
      for await (const turn of opts.channel) {
        this.turns.push((turn as { text?: string }).text ?? "");
        if (this.silentTurns) continue;
        this.sink?.({ type: "assistant", text: "", turn: this.turns.length } as AgentEvent);
      }
    })();
    for (;;) {
      while (this.queued.length) yield this.queued.shift()!;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  emit(ev: AgentEvent): void {
    this.sink?.(ev);
  }
  async interrupt(): Promise<void> {}
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

/** Wires a manager to a journal exactly as the orchestrator does (index.ts's
 *  flushRunCompletions / onEventDelivered / onEventUndelivered / onAgentReady),
 *  through the journal's own deliverPending so no delivery logic is duplicated. */
function makeHarness(backend: AgentBackend) {
  const journal = new RunCompletionJournalImpl();
  const flush = (tab: string) =>
    journal.deliverPending(tab, (payload, token) =>
      manager.injectEvent(tab, payload, { eventToken: token }),
    );
  journal.setRevoker(
    (key, token) => manager.revokeEvent(key, token),
    (key) => void flush(key),
  );
  const manager = new PanelAgentManager({
    mcpServers: {},
    systemAppend: "",
    model: "claude-test",
    onSay: () => {},
    onTurn: () => {},
    makeBackend: () => backend,
    onEventDelivered: (_key: string, tokens: string[]) => {
      for (const t of tokens) journal.ack(t);
    },
    // Mirrors index.ts exactly, INCLUDING the `carried` flag — a harness that
    // drops it would silently exercise the unbounded path.
    onEventUndelivered: (key: string, tokens: string[], opts?: { carried?: boolean }) => {
      for (const t of tokens) journal.release(t, { carried: opts?.carried === true });
      flush(key);
    },
    onAgentReady: (key: string) => flush(key),
  } as never);
  /** The orchestrator's agent_event handler for kind:"executed". */
  const arrive = (tab: string, payload: CompletionPayload) => {
    journal.record(tab, payload);
    flush(tab);
  };
  /** Mirrors index.ts's keyed executed ingress, including the ACK gate. */
  const arriveProduction = (tab: string, payload: CompletionPayload, conversation: string) => {
    const completionKey =
      typeof payload.completion_key === "string" && payload.completion_key.length > 0
        ? payload.completion_key
        : null;
    const promptId = typeof payload.prompt_id === "string" ? payload.prompt_id : null;
    const alreadyKnown =
      completionKey !== null &&
      promptId !== null &&
      journal.hasCompletionReceipt(completionKey, { promptId, key: tab, conversation });
    const entry =
      alreadyKnown || promptId === null
        ? alreadyKnown
          ? null
          : journal.record(tab, payload, { conversation })
        : journal.record(tab, payload, { conversation });
    const acked =
      completionKey !== null &&
      promptId !== null &&
      journal.acceptsCompletionReceipt(completionKey, promptId, tab, conversation);
    flush(tab);
    return { entry, acked };
  };
  return { journal, manager, flush, arrive, arriveProduction };
}

describe("#1824 production keyed completion ingress", () => {
  it("ACKs a keyed completion only for the current ticket generation", () => {
    const backend = new ContinuationBackend();
    const { journal, arriveProduction } = makeHarness(backend);
    const tab = "tab-production-1824";
    const conversation = "orchestrator::claude";
    const keyA = JSON.stringify([tab, conversation, PROMPT_A, "generation-a"]);
    const keyB = JSON.stringify([tab, conversation, PROMPT_A, "generation-b"]);

    journal.openRun(PROMPT_A, { tabId: tab, conversation, completionKey: keyA });
    const first = arriveProduction(
      tab,
      { kind: "executed", prompt_id: PROMPT_A, completion_key: keyA },
      conversation,
    );
    expect(first.acked).toBe(true);
    const firstEntry = journal.outstanding(tab)[0];
    expect(firstEntry).toBeDefined();
    journal.ack(firstEntry!.token);

    // ComfyUI reused the prompt id. A late frame from generation A must be
    // journaled as foreign and must not be mistaken for B's receipt.
    journal.openRun(PROMPT_A, { tabId: tab, conversation, completionKey: keyB });
    const stale = arriveProduction(
      tab,
      { kind: "executed", prompt_id: PROMPT_A, completion_key: keyA, note: "stale A" },
      conversation,
    );
    expect(stale.acked).toBe(false);
    expect(stale.entry?.correlation.status).toBe("foreign");
    expect(journal.outstanding(tab)).toHaveLength(1);
  });

  it("fences a watchdog handoff against the panel's keyed completion", () => {
    const backend = new ContinuationBackend();
    const { journal, arriveProduction } = makeHarness(backend);
    const tab = "tab-watchdog-1824";
    const conversation = "orchestrator::claude";
    const key = JSON.stringify([tab, conversation, PROMPT_B, "generation-watchdog"]);

    // The history watchdog wins just before the panel frame reaches the
    // executed ingress. Both observations are the same current ticket.
    journal.openRun(PROMPT_B, { tabId: tab, conversation, completionKey: key });
    const watchdog = journal.record(
      tab,
      {
        kind: "executed",
        prompt_id: PROMPT_B,
        completion_source: "orchestrator-history-watchdog",
        images: [{ filename: "watchdog.png" }],
      },
      { conversation },
    );
    const panel = arriveProduction(
      tab,
      { kind: "executed", prompt_id: PROMPT_B, completion_key: key, images: [{ filename: "panel.png" }] },
      conversation,
    );

    expect(journal.ticketFor(PROMPT_B)).toMatchObject({ completionKey: key });
    expect(journal.ticketFor(PROMPT_B)?.reused).toBeUndefined();
    expect(panel.entry?.token).toBe(watchdog.token);
    expect(panel.entry?.payload.completion_key).toBe(key);
    expect(panel.entry).toMatchObject({
      ticketSeq: journal.ticketFor(PROMPT_B)?.seq,
      correlation: { status: "matched", promptId: PROMPT_B },
    });
    expect(panel.acked).toBe(true);
    expect(journal.outstanding(tab)).toHaveLength(1);
    expect(journal.outstanding(tab)[0].payload.completion_key).toBe(key);
  });

  it("keeps a delivered watchdog fallback fenced until the keyed frame arrives", () => {
    const backend = new ContinuationBackend();
    const { journal, arriveProduction } = makeHarness(backend);
    const tab = "tab-watchdog-delivered-1824";
    const conversation = "orchestrator::claude";
    const key = JSON.stringify([tab, conversation, PROMPT_C, "generation-watchdog"]);

    journal.openRun(PROMPT_C, { tabId: tab, conversation, completionKey: key });
    const watchdog = journal.record(
      tab,
      { kind: "executed", prompt_id: PROMPT_C, completion_source: "orchestrator-history-watchdog" },
      { conversation },
    );
    journal.deliverPending(tab, () => true);
    journal.ack(watchdog.token);

    const panel = arriveProduction(
      tab,
      { kind: "executed", prompt_id: PROMPT_C, completion_key: key },
      conversation,
    );
    expect(panel.entry).toBeNull();
    expect(panel.acked).toBe(true);
    expect(journal.outstanding(tab)).toHaveLength(0);
  });

  it("lets a late receipt bind a settled watchdog ticket without reopening it", () => {
    const backend = new ContinuationBackend();
    const { journal, arriveProduction } = makeHarness(backend);
    const tab = "tab-watchdog-receipt-1824";
    const conversation = "orchestrator::claude";
    const key = JSON.stringify([tab, conversation, PROMPT_D, "generation-watchdog"]);

    journal.openRun(PROMPT_D, { tabId: tab, conversation });
    const watchdog = journal.record(
      tab,
      { kind: "executed", prompt_id: PROMPT_D, completion_source: "orchestrator-history-watchdog" },
      { conversation },
    );
    journal.deliverPending(tab, () => true);
    journal.ack(watchdog.token);

    expect(journal.bindCompletionKey(PROMPT_D, key)).toBe(true);
    const panel = arriveProduction(
      tab,
      { kind: "executed", prompt_id: PROMPT_D, completion_key: key },
      conversation,
    );
    expect(panel.entry).toBeNull();
    expect(panel.acked).toBe(true);
    expect(journal.outstanding(tab)).toHaveLength(0);
  });
});

describe("run completion across automatic goal continuation (#468)", () => {
  it("delivers the completion into the next turn while the agent is busy continuing a goal", async () => {
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-continuation";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "render it and keep going");
    await waitFor(() => backend.turns.length >= 1);

    // The render finishes MID-CONTINUATION: the agent is still inside turn 1.
    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "out_0001.png" }] });
    expect(backend.turns.length).toBe(1); // nothing delivered yet — still busy

    backend.finishTurn(); // the continuation turn ends
    await waitFor(() => backend.turns.length >= 2);

    expect(backend.turns[1]).toContain("out_0001.png");
    expect(backend.turns[1]).toContain(PROMPT_A);
    expect(backend.turns[1]).toContain("This is the run YOU queued");
    expect(backend.turnImages[1]).toEqual(["out_0001.png"]);
    // Still journaled until the turn CARRYING it ends — hand-off is not proof.
    expect(journal.outstanding(tab)).toHaveLength(1);

    backend.finishTurn();
    await waitFor(() => journal.outstanding(tab).length === 0);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(true);
  });

  it("journals a completion that lands with no live agent and replays it to the right run", async () => {
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-no-agent";

    journal.openRun(PROMPT_A, { tabId: tab });
    // No agent exists yet for this tab (the previous one was torn down by a
    // restart the continuation triggered) — the old code dropped this silently.
    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "late_0001.png" }] });
    expect(journal.outstanding(tab)).toHaveLength(1);
    expect(journal.pending(tab)).toHaveLength(1); // still awaiting a delivery attempt

    // A fresh agent comes back → onAgentReady replays it.
    manager.send(tab, "still here?");
    await waitFor(() => backend.turns.length >= 1);

    // The replay is queued AHEAD of the message that spawned the agent, so both
    // land; assert the completion text is present in some turn.
    const all = backend.turns.join("\n");
    expect(all).toContain("late_0001.png");
    expect(all).toContain(PROMPT_A);
    expect(all).toContain("This is the run YOU queued");

    backend.finishTurn();
    await waitFor(() => journal.outstanding(tab).length === 0);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(true);
  });

  it("replays a completion whose carrying turn was abandoned — it is never swallowed", async () => {
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-abandoned";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.finishTurn();

    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "kept_0001.png" }] });
    await waitFor(() => backend.turns.length >= 2);
    expect(backend.turns[1]).toContain("kept_0001.png");

    // The turn carrying it is thrown away (a plain Stop / abandoned turn). The
    // completion must come BACK, not die with the turn.
    await manager.interrupt(tab, { requeueInFlight: false });
    await waitFor(() => backend.turns.length >= 3);
    expect(backend.turns[2]).toContain("kept_0001.png");
    expect(backend.turns[2]).toContain("RE-DELIVERED");
  });

  it("a traceless straggler result does NOT ack the current turn's completion", async () => {
    // #728 lets an UNMARKED result through the dead-letter guard for gate
    // liveness. On a marker-declaring backend that result may belong to an
    // abandoned earlier turn, so it must not retire a completion the CURRENT
    // turn is carrying — otherwise a turn that then stalls has nothing to
    // hand back and the completion is gone.
    const backend = new MarkerBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-straggler";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.emit({ type: "result", ok: true, subtype: "success", turn: 1 });

    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "carried.png" }] });
    await waitFor(() => backend.turns.length >= 2); // turn 2 carries the completion

    // An unmarked straggler from the abandoned turn 1 arrives.
    backend.emit({ type: "result", ok: false, subtype: "error_during_execution" });
    // It is handed BACK, not acked — and immediately re-delivered into a new
    // turn, so the completion is neither lost nor fabricated as delivered.
    await waitFor(() => backend.turns.length >= 3);
    expect(backend.turns[2]).toContain("carried.png");
    expect(backend.turns[2]).toContain("RE-DELIVERED");
    expect(journal.outstanding(tab)).toHaveLength(1);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(false);

    // Only the carrying turn's OWN marked result settles it.
    backend.emit({ type: "result", ok: true, subtype: "success", turn: 3 });
    await waitFor(() => journal.outstanding(tab).length === 0);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(true);
  });

  it("a straggler arriving BEFORE the carrying turn stamps anything still cannot ack", async () => {
    // The unsound-inference case: a gate that LEARNS "this backend stamps" by
    // observation is still unlearned in exactly this window — a zero-output
    // turn's traceless terminal lands before the replacement turn emits any
    // stamped event. Capability is DECLARED, so the gate holds from the start.
    const backend = new MarkerBackend({ silentTurns: true });
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-straggler-early";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go"); // turn 1 emits NOTHING
    await waitFor(() => backend.turns.length >= 1);
    backend.emit({ type: "result", ok: true, subtype: "success", turn: 1 });

    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "early.png" }] });
    await waitFor(() => backend.turns.length >= 2); // turn 2 carries it, still silent

    // No marker has EVER been observed on this run at this point — a
    // learn-by-observation gate would ack here and destroy the replay.
    backend.emit({ type: "result", ok: false, subtype: "error_during_execution" });
    await waitFor(() => backend.turns.length >= 3); // handed back and re-delivered
    expect(backend.turns[2]).toContain("early.png");
    expect(journal.outstanding(tab)).toHaveLength(1);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(false);
  });

  it("a completion parked in held mail survives retire() (provider switch)", async () => {
    // retire() PRESERVES held mail, which is why it used to strand the
    // completion riding in it: the journal entry stayed `handed_off` — a state
    // deliverPending() skips — with no agent left to consume it.
    const doomed: AgentBackend = {
      id: "claude" as const,
      capabilities: CLAUDE_CAPABILITIES,
      async prepare() {
        throw new Error("endpoint rejected the key (http 401)");
      },
      async *run(): AsyncGenerator<AgentEvent> {
        throw new Error("never runs");
      },
      async interrupt() {},
      async listModels() {
        return [];
      },
    };
    const { journal, manager, arrive } = makeHarness(doomed);
    const tab = "tab-retire-heldmail";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "retired.png" }] });
    await waitFor(() => journal.pending(tab).length === 0); // taken by the doomed agent
    await waitFor(() => manager.hasHeldMail(tab));

    manager.retire(tab); // provider switch retires the failed key
    expect(journal.pending(tab)).toHaveLength(1); // handed back, replayable
    expect(journal.outstanding(tab)).toHaveLength(1);
  });

  it("reports an uncorrelatable completion as UNDETERMINED instead of swallowing it", async () => {
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-unknown";

    journal.openRun(PROMPT_A, { tabId: tab }); // the agent IS waiting on a run
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.finishTurn();

    // …but the completion that arrives carries no prompt id at all.
    arrive(tab, { kind: "executed", images: [{ filename: "mystery_0001.png" }] });
    await waitFor(() => backend.turns.length >= 2);

    const text = backend.turns[1];
    expect(text).toContain("mystery_0001.png"); // still delivered
    expect(text).toContain("UNDETERMINED");
    expect(text).toContain("get_history");
    expect(text).not.toContain("This is the run YOU queued");
    expect(text).toContain("pixels are NOT attached");
    expect(backend.turnImages[1]).toEqual([]);
    // …and it must not settle the run the agent is actually waiting on.
    backend.finishTurn();
    await waitFor(() => journal.outstanding(tab).length === 0);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(false);
  });

  it("reports a completion for a run this session never queued as UNDETERMINED", async () => {
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-foreign";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.finishTurn();

    arrive(tab, { kind: "executed", prompt_id: PROMPT_B, images: [{ filename: "theirs.png" }] });
    await waitFor(() => backend.turns.length >= 2);

    const text = backend.turns[1];
    expect(text).toContain("does NOT match any run you queued");
    expect(text).toContain("UNDETERMINED");
    expect(text).toContain(PROMPT_B);
    expect(text).toContain("pixels are NOT attached");
    expect(backend.turnImages[1]).toEqual([]);

    backend.finishTurn();
    await waitFor(() => journal.outstanding(tab).length === 0);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(false); // our run is still open
  });

  it("bounds a matched run's automatic previews while leaving every output visible in the panel", async () => {
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-many-previews";
    const images = Array.from({ length: 28 }, (_, i) => ({ filename: `preview_${i + 1}.png` }));

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "render comparison");
    await waitFor(() => backend.turns.length >= 1);
    backend.finishTurn();

    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images });
    await waitFor(() => backend.turns.length >= 2);

    expect(backend.turnImages[1]).toEqual(images.slice(0, 8).map((image) => image.filename));
    expect(backend.turns[1]).toContain("The first 8 image(s) are attached below");
    expect(backend.turns[1]).toContain("20 further preview(s) were omitted");
    expect(backend.turns[1]).toContain("all 28 outputs are already shown to the user");
    // Every output is still NAMED, and the bound names a reader that can produce
    // the pixels — a bounded-away preview costs a tool call, it is not lost.
    expect(backend.turns[1]).toContain("preview_28.png");
    expect(backend.turns[1]).toContain("get_image");

    // …and the bound holds on the REPLAY too. The turn carrying it is abandoned,
    // so the journal hands the completion back and re-delivers it; a bound that
    // only applied to the first delivery would let the replay re-inflate.
    await manager.interrupt(tab, { requeueInFlight: false });
    await waitFor(() => backend.turns.length >= 3);
    expect(backend.turns[2]).toContain("RE-DELIVERED");
    expect(backend.turnImages[2]).toEqual(images.slice(0, 8).map((image) => image.filename));
  });

  it("#1516: a replayed foreign completion re-reports its outputs but never re-attaches pixels", async () => {
    // The reported amplifier, in order: two FOREIGN completions at startup
    // attached 28 images each; the interrupted turn handed both back to the
    // journal; the replay produced a second ~105 MB record carrying the same 28
    // images, and the app-server stopped replying. The replay is the half that
    // compounds, so the withholding has to hold on EVERY delivery — not only the
    // first one, which is all a first-delivery test can see.
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-foreign-replay";
    const images = Array.from({ length: 28 }, (_, i) => ({ filename: `foreign_${i + 1}.png` }));

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.finishTurn();

    arrive(tab, { kind: "executed", prompt_id: PROMPT_B, images });
    await waitFor(() => backend.turns.length >= 2);
    expect(backend.turnImages[1]).toEqual([]);

    await manager.interrupt(tab, { requeueInFlight: false });
    await waitFor(() => backend.turns.length >= 3);
    expect(backend.turns[2]).toContain("RE-DELIVERED");
    expect(backend.turns[2]).toContain("foreign_28.png"); // still fully REPORTED…
    expect(backend.turns[2]).toContain("get_image"); // …and still reachable…
    expect(backend.turnImages[2]).toEqual([]); // …but no pixels ride the replay.
  });

  it("#1516: the preview budget is PER TURN — N completions sharing a turn do not deliver 8N", async () => {
    // The defect a per-event cap hides. channel() drains the WHOLE queue into one
    // turn and flatMaps the attachments, so four completions that land while the
    // agent is busy each passed their own 8-image budget and the turn carried 32
    // — measured at 32 before the budget moved per-turn, which is #1516's
    // compounding shape rather than a hypothetical.
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-shared-turn";
    const prompts = [PROMPT_A, PROMPT_B, PROMPT_C, PROMPT_D];

    for (const p of prompts) journal.openRun(p, { tabId: tab });
    manager.send(tab, "run the sweep");
    await waitFor(() => backend.turns.length >= 1);

    // All four finish WHILE the agent is inside turn 1, so all four queue up.
    for (const p of prompts) {
      arrive(tab, {
        kind: "executed",
        prompt_id: p,
        images: Array.from({ length: 28 }, (_, i) => ({ filename: `${p.slice(0, 4)}_${i}.png` })),
      });
    }
    expect(backend.turns.length).toBe(1); // still busy — nothing delivered yet

    backend.finishTurn();
    await waitFor(() => backend.turns.length >= 2);

    // ONE budget for the turn, not one per completion.
    expect(backend.turnImages[1]).toHaveLength(8);
    // …and the completions that got nothing say so, instead of inheriting the
    // first one's "attached below".
    expect(backend.turns[1]).toContain("NONE of these outputs are attached");
    expect(backend.turns[1]).toContain("already spent its 8-image preview budget");

    // An interrupt that REQUEUES the batch cannot route around it either: the
    // requeued items are back on the queue, so the next arrivals see them.
    await manager.interrupt(tab, { requeueInFlight: true });
    for (const p of prompts) {
      journal.openRun(`${p}-b`, { tabId: tab });
      arrive(tab, {
        kind: "executed",
        prompt_id: `${p}-b`,
        images: Array.from({ length: 28 }, (_, i) => ({ filename: `${p.slice(0, 4)}b_${i}.png` })),
      });
    }
    await waitFor(() => backend.turns.length >= 3);
    expect(backend.turnImages[2].length).toBeLessThanOrEqual(8);
  });

  it("#1516: a turn that trims an IN-FLIGHT-window completion corrects its own claim", async () => {
    // The state a per-queue budget cannot see, and the reason the drain has to
    // speak rather than log. `queuedPreviewImageCount()` reads `queue`; an
    // in-flight batch is not on it. So:
    //   1. completion A is taken IN FLIGHT with its 8 previews;
    //   2. completion B arrives behind it, reads the budget as untouched
    //      (queue is empty), and commits its own 8 — saying "attached below";
    //   3. an interrupt requeues A beside B, and ONE drain sees 16.
    // The ceiling holds at 8, but B's images are the ones cut, so B's notice now
    // describes attachments that are not on the turn. Measured before the drain
    // disclosed it: 8 images delivered, all A's, B's filenames nowhere in the
    // text because B carried a custom note — an unfetchable false claim.
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-inflight-window";
    const previews = (tag: string) =>
      Array.from({ length: 28 }, (_, i) => ({ filename: `${tag}_${i}.png`, type: "temp" }));

    journal.openRun(PROMPT_A, { tabId: tab });
    journal.openRun(PROMPT_B, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);

    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: previews("A") });
    backend.finishTurn();
    await waitFor(() => backend.turns.length >= 2);
    expect(backend.turnImages[1]).toHaveLength(8); // A is in flight with its 8

    // B lands while A is IN FLIGHT, and carries a note — so its filenames never
    // enter its own text and only the drain can name them.
    arrive(tab, {
      kind: "executed",
      prompt_id: PROMPT_B,
      note: "A 3-second video was rendered; this is its storyboard.",
      images: previews("B"),
    });
    await manager.interrupt(tab, { requeueInFlight: true });
    await waitFor(() => backend.turns.length >= 3);

    const turn = backend.turns[2];
    // The ceiling still holds…
    expect(backend.turnImages[2]).toHaveLength(8);
    // …and the turn does NOT quietly carry a notice that contradicts it.
    expect(turn).toContain("were NOT attached to this turn");
    expect(turn).toContain("THIS note is the accurate one");
    // The trimmed outputs are named, WITH the coordinates get_image needs — this
    // is the only place they appear, because B's note replaced its own list.
    expect(turn).toContain('B_0.png (type:"temp")');
    expect(turn).toContain('get_image action:"get"');
  });

  it("#1516: a withheld preview is named with coordinates get_image can actually use", async () => {
    // The remedy has to be callable. get_image action:"get" takes a FILENAME and
    // defaults `type` to "output" — but a PreviewImage output lives in `temp`, and
    // the event's own name list carries filenames only. Worse, a custom `note`
    // (the panel's video-storyboard summary) replaces that list outright, so a
    // withheld output would be named nowhere at all.
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-coordinates";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.finishTurn();

    // Foreign → every pixel withheld, and a note that suppresses the name list.
    arrive(tab, {
      kind: "executed",
      prompt_id: PROMPT_B,
      note: "A 3-second video was rendered; this is its storyboard.",
      images: [
        { filename: "preview_a.png", type: "temp" },
        { filename: "preview_b.png", type: "temp", subfolder: "clips" },
        { filename: "final_c.png" },
      ],
    });
    await waitFor(() => backend.turns.length >= 2);

    const text = backend.turns[1];
    expect(backend.turnImages[1]).toEqual([]); // pixels withheld…
    expect(text).toContain("storyboard"); // the panel's note still replaces the default wording
    // …and each withheld output is still reachable: the temp ones carry the type
    // (get_image would otherwise look in output/ and miss them) and the nested
    // one carries its subfolder.
    expect(text).toContain('preview_a.png (type:"temp")');
    expect(text).toContain('preview_b.png (type:"temp", subfolder:"clips")');
    expect(text).toContain("final_c.png"); // plain output needs no coordinates
    expect(text).toContain('get_image action:"get"');
  });

  it("#1516: a completion whose outputs have no usable filename promises nothing", async () => {
    // attachedImgs is empty here for a reason that is NOT the budget, and the
    // old wording said "The image(s) are attached below" while attaching none.
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-unnamed";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.finishTurn();

    arrive(tab, {
      kind: "executed",
      prompt_id: PROMPT_A,
      images: [{ filename: "" }, { filename: "" }],
    });
    await waitFor(() => backend.turns.length >= 2);

    const text = backend.turns[1];
    expect(backend.turnImages[1]).toEqual([]);
    expect(text).not.toContain("attached below");
    expect(text).toContain("no usable filename");
    expect(text).toContain("get_history"); // the only reader left when there is no name
    // …and it must never offer get_image with an empty list after the colon.
    expect(text).not.toMatch(/get_image action:"get"[^.]*:\s*\./);
  });

  it("#1516: a MIXED event discloses the unnamed remainder instead of saying they are attached", async () => {
    // The gap a pre-merge review found. Every count in this text is over the
    // event's outputs; the attachments are over the ones with a filename. When
    // NONE has a name that disagreement has its own branch — but one named
    // sibling was enough to keep the generic "The image(s) are attached below"
    // alive, so a 2-output event attached 1 and said nothing about the other.
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-mixed";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.finishTurn();

    arrive(tab, {
      kind: "executed",
      prompt_id: PROMPT_A,
      images: [{ filename: "named_a.png" }, { filename: "" }],
    });
    await waitFor(() => backend.turns.length >= 2);

    const text = backend.turns[1];
    // The named one really is attached — the disclosure must not cost the pixels
    // this event was able to carry.
    expect(backend.turnImages[1]).toHaveLength(1);
    expect(text).toContain("2 output image(s)");
    expect(text).toContain("attached below"); // still true of the one that has a name
    // …and the other one is now accounted for, with the only reader that can
    // answer for a nameless output.
    expect(text).toContain("1 of those 2 output(s) arrived with no usable filename");
    expect(text).toContain("get_history");
  });

  it("#1516: past the cap, a MIXED event's arithmetic closes", async () => {
    // `omittedImgs` counts only the attachable ones, so on a mixed event
    // attached + omitted was less than the total the same sentence quotes. The
    // unnamed clause is what makes those numbers add up.
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-mixed-capped";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.finishTurn();

    // 10 named + 2 unnamed: 8 attach, 2 named are omitted under the bound, and 2
    // were never attachable at all.
    arrive(tab, {
      kind: "executed",
      prompt_id: PROMPT_A,
      images: [
        ...Array.from({ length: 10 }, (_, i) => ({ filename: `named_${i}.png` })),
        { filename: "" },
        { filename: "" },
      ],
    });
    await waitFor(() => backend.turns.length >= 2);

    const text = backend.turns[1];
    expect(backend.turnImages[1]).toHaveLength(8);
    expect(text).toContain("The first 8 image(s) are attached below");
    expect(text).toContain("2 further preview(s) were omitted");
    expect(text).toContain("2 of those 12 output(s) arrived with no usable filename");
    // 8 attached + 2 bounded + 2 nameless = the 12 the sentence claims.
  });

  it("#1516: an UNDETERMINED mixed event does not offer a fetch for the nameless half", async () => {
    // The withheld-coordinates list can only name what has a name, so on an
    // UNDETERMINED run the "fetch one with get_image" sentence silently covered
    // fewer outputs than it counted.
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-mixed-foreign";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.finishTurn();

    arrive(tab, { kind: "executed", images: [{ filename: "named_a.png" }, { filename: "" }] });
    await waitFor(() => backend.turns.length >= 2);

    const text = backend.turns[1];
    expect(backend.turnImages[1]).toEqual([]); // UNDETERMINED attaches nothing
    expect(text).toContain("UNDETERMINED");
    expect(text).toContain("1 of those 2 output(s) arrived with no usable filename");
    expect(text).toContain("get_history");
  });

  it("#1516: an all-named event says nothing about a remainder that does not exist", async () => {
    // The clause must be silent in the ordinary case, or every completion grows a
    // sentence about images that were never missing.
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-all-named";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.finishTurn();

    arrive(tab, {
      kind: "executed",
      prompt_id: PROMPT_A,
      images: [{ filename: "named_a.png" }, { filename: "named_b.png" }],
    });
    await waitFor(() => backend.turns.length >= 2);

    expect(backend.turns[1]).not.toContain("no usable filename");
    expect(backend.turnImages[1]).toHaveLength(2);
  });

  it("#1516: an UNDETERMINED run with no usable filename offers no empty remedy either", async () => {
    // The id-less case is exactly where "unidentified" and "no filename" meet, so
    // the withheld-coordinates sentence must not degrade to a dangling colon.
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-unnamed-foreign";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.finishTurn();

    arrive(tab, { kind: "executed", images: [{ filename: "" }] }); // no id, no name
    await waitFor(() => backend.turns.length >= 2);

    const text = backend.turns[1];
    expect(text).toContain("UNDETERMINED");
    expect(text).toContain("cannot be fetched by name");
    expect(text).not.toMatch(/get_image action:"get"[^.]*:\s*\./);
    expect(backend.turnImages[1]).toEqual([]);
  });

  it("#1516: the bound sits on the route a real panel completion travels", async () => {
    // makeHarness MIRRORS index.ts. A mirror can show the bound works; it can
    // never show the orchestrator still uses the route it mirrors — and a bound
    // helper nothing calls is this repo's recurring failure mode. Pin the hops
    // that carry a panel `agent_event` into the bounded method:
    //   agent_event kind:"executed" → flushRunCompletions
    //   flushRunCompletions         → manager.injectEvent → PanelAgent.injectEvent
    const { readFile } = await import("node:fs/promises");
    // Normalise line endings FIRST. A Windows checkout stores these files CRLF,
    // so an end-of-block marker written `\n  }\n` finds nothing here and matches
    // on CI — the test would then be green on Linux and red on the platform this
    // project is developed on.
    const read = async (rel: string) =>
      (await readFile(new URL(rel, import.meta.url), "utf-8")).replace(/\r\n/g, "\n");
    const orchestrator = await read("../../orchestrator/index.ts");
    // Every slice below is bounded by an index that must EXIST — an unfound
    // marker returns -1, and a slice to -1 hands `toContain` most of the file,
    // which would make this whole test pass while measuring nothing. That is not
    // hypothetical: it is what the first version of this test did.
    const branchAt = orchestrator.indexOf('if (ev.kind === "executed") {');
    expect(branchAt).toBeGreaterThan(-1);
    const branchEnd = orchestrator.indexOf("return;", branchAt);
    expect(branchEnd).toBeGreaterThan(branchAt);
    const executedBranch = orchestrator.slice(branchAt, branchEnd);
    expect(executedBranch).toContain("flushRunCompletions(event.tab_id)");

    const flushAt = orchestrator.indexOf("function flushRunCompletions(");
    expect(flushAt).toBeGreaterThan(-1);
    const flushEnd = orchestrator.indexOf("\n  }\n", flushAt);
    expect(flushEnd).toBeGreaterThan(flushAt);
    const flushBody = orchestrator.slice(flushAt, flushEnd);
    expect(flushBody).toContain("manager.injectEvent(");

    // …and the method they land in is the one that applies the bound: the
    // attachment is built from the BOUNDED list, so no later edit can re-widen
    // it by reaching past `attachedImgs`.
    const agent = await read("../../orchestrator/panel-agent.ts");
    const injectAt = agent.indexOf("\n  injectEvent(");
    expect(injectAt).toBeGreaterThan(-1);
    const injectEnd = agent.indexOf("\n  }\n", injectAt);
    expect(injectEnd).toBeGreaterThan(injectAt);
    const injectBody = agent.slice(injectAt, injectEnd);
    expect(injectBody).toContain("MAX_RUN_COMPLETION_IMAGE_ATTACHMENTS");
    expect(injectBody).toMatch(/images = attachedImgs/);
    // …and the ceiling also sits at the seam where N completions become ONE
    // turn, which is the only place a per-event budget cannot reach.
    const channelAt = agent.indexOf("private async *channel(");
    expect(channelAt).toBeGreaterThan(-1);
    const channelEnd = agent.indexOf("\n  }\n", channelAt);
    expect(channelEnd).toBeGreaterThan(channelAt);
    const channelBody = agent.slice(channelAt, channelEnd);
    expect(channelBody).toContain("MAX_RUN_COMPLETION_IMAGE_ATTACHMENTS");
    expect(channelBody).toMatch(/it\.completionOnly/);
  });

  it("a completion parked in HELD mail survives a reset that discards that mail", async () => {
    // A failed start parks the agent's whole queue — including an injected
    // completion — in heldMessages. `reset()` (New chat / resume_session) throws
    // that mail away; the completion must come BACK to the journal, not be left
    // stranded in a hand-off state nothing ever flushes again.
    const doomed: AgentBackend = {
      id: "claude" as const,
      capabilities: CLAUDE_CAPABILITIES,
      async prepare() {
        throw new Error("endpoint rejected the key (http 401)");
      },
      async *run(): AsyncGenerator<AgentEvent> {
        throw new Error("never runs");
      },
      async interrupt() {},
      async listModels() {
        return [];
      },
    };
    const { journal, manager, arrive } = makeHarness(doomed);
    const tab = "tab-heldmail";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go"); // spawns an agent whose prepare() rejects
    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "held.png" }] });
    // Taken onto the doomed agent's queue…
    await waitFor(() => journal.pending(tab).length === 0);
    // …then parked in held mail when the start failed.
    await waitFor(() => manager.hasHeldMail(tab));

    manager.reset(tab); // New chat — held mail is discarded
    expect(journal.pending(tab)).toHaveLength(1); // handed back, replayable
    expect(journal.outstanding(tab)).toHaveLength(1);
  });

  it("retire() removes the completion from held mail, not just its token", async () => {
    // retire() PRESERVES held mail on purpose. Stripping only the token left the
    // event's TEXT in that mail: switching Claude→Codex handed the journal token
    // to Codex (delivered, correctly), and switching BACK to Claude re-delivered
    // the retained text as an ordinary user message — no token, no flag,
    // indistinguishable from a real second completion.
    const doomed: AgentBackend = {
      id: "claude" as const,
      capabilities: CLAUDE_CAPABILITIES,
      async prepare() {
        throw new Error("endpoint rejected the key (http 401)");
      },
      async *run(): AsyncGenerator<AgentEvent> {
        throw new Error("never runs");
      },
      async interrupt() {},
      async listModels() {
        return [];
      },
    };
    // Fails the first TWO starts (parking, re-delivering, then re-parking the
    // queue in held mail), then works. Two consecutive failures matter: the
    // re-delivery goes through send(), which must preserve the completionOnly
    // marker or the second parking makes the completion's text un-removable.
    const healthy = new ContinuationBackend();
    let failuresLeft = 2;
    const flaky: AgentBackend = {
      id: "claude" as const,
      capabilities: CLAUDE_CAPABILITIES,
      async prepare() {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("endpoint rejected the key (http 401)");
        }
      },
      run: (o) => healthy.run(o),
      async interrupt() {},
      async listModels() {
        return [];
      },
    };
    const { journal, manager, arrive } = makeHarness(flaky);
    const tab = "tab-retire-textleak";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "keep me"); // an ordinary user message must SURVIVE
    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "leak.png" }] });
    await waitFor(() => journal.pending(tab).length === 0); // taken by the doomed agent
    await waitFor(() => manager.hasHeldMail(tab));

    // A second start also fails: the held mail is re-delivered through send()
    // and re-parked. The completionOnly marker must survive that round trip.
    manager.send(tab, "try again");
    await waitFor(() => manager.hasHeldMail(tab) && failuresLeft === 0);

    manager.retire(tab); // provider switch retires the failed key
    expect(journal.pending(tab)).toHaveLength(1); // its token came back

    // Next start succeeds: held mail replays, and the journal replays the
    // completion. The completion's text must appear exactly once.
    manager.send(tab, "hello again");
    await waitFor(() => healthy.turns.length >= 1);
    healthy.finishTurn();
    await new Promise((r) => setTimeout(r, 30));

    const all = healthy.turns.join("\n");
    expect(all).toContain("keep me"); // the user's message survived
    // …and the completion appears EXACTLY ONCE. Stripping only the token left a
    // second, token-less copy of this text behind in the preserved mail.
    expect(all.split("leak.png").length - 1).toBe(1);
  });

  it("a STEERED stall keeps the completion on the live turn — it is not handed back", async () => {
    // #587 added a stall path that does NOT abandon the turn: a capable provider
    // is steered with a harness notice and the turn stays authoritative. The
    // #468 token hand-back therefore belongs in finishStalledTurn (the genuinely
    // abandoned path) and MUST NOT run here — releasing on a live turn replays a
    // completion that turn is still carrying, i.e. a duplicate.
    const backend = new MarkerBackend({ silentTurns: true });
    let steers = 0;
    (backend as unknown as { recoverStalledTurn: (n: string) => Promise<boolean> }).recoverStalledTurn =
      async () => {
        steers += 1;
        return true; // provider accepted the notice — turn stays live
      };
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-steered-stall";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.emit({ type: "result", ok: true, subtype: "success", turn: 1 });

    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "steered.png" }] });
    await waitFor(() => backend.turns.length >= 2); // turn 2 carries it, then freezes

    await waitFor(() => steers >= 1, 4000); // the watchdog steered instead of abandoning
    await new Promise((r) => setTimeout(r, 30));

    // The completion is STILL on the live turn: one entry, still handed off, and
    // handed off EXACTLY ONCE. `attempts` is the discriminator — releasing on the
    // steer path re-queues it, so the agent would hold two copies of the same
    // completion (one in the live turn, one behind it) even though the entry
    // count and the turn count both look unchanged.
    expect(journal.outstanding(tab)).toHaveLength(1);
    expect(journal.outstanding(tab)[0].state).toBe("handed_off");
    expect(journal.outstanding(tab)[0].attempts).toBe(1);
    expect(journal.outstanding(tab)[0].carriedReleases ?? 0).toBe(0);
    expect(backend.turns).toHaveLength(2); // no replay turn was created
  });

  it("an ABANDONED stall (no provider recovery) does hand the completion back", async () => {
    // The other side of the #587 split: with no `recoverStalledTurn` the turn is
    // genuinely written off, so the completion it carried must come back rather
    // than die with it. This is the path the #468 release now lives on.
    const backend = new MarkerBackend({ silentTurns: true }); // no steer hook
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-abandoned-stall";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.emit({ type: "result", ok: true, subtype: "success", turn: 1 });

    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "abandoned.png" }] });
    await waitFor(() => backend.turns.length >= 2); // turn 2 carries it, then freezes

    // Handed back and immediately re-offered — never lost with the written-off turn.
    await waitFor(() => backend.turns.length >= 3, 4000);
    expect(backend.turns[2]).toContain("abandoned.png");
    expect(journal.outstanding(tab)).toHaveLength(1);
    // …and UNCARRIED: turn 2 produced no stamped event, so the backend never
    // proved it received the completion.
    expect(journal.outstanding(tab)[0].carriedReleases ?? 0).toBe(0);
  });

  it("a rewind hands its completion back as CARRIED (bounded, not an infinite replay)", async () => {
    // A turn abandoned by a rewind (and, by the same wiring, by the stall
    // watchdog) must return the completion it was carrying — but as a CARRIED
    // release, or an agent that keeps abandoning turns would be handed the same
    // completion on every turn forever.
    const backend = new MarkerBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-rewind-carried";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.emit({ type: "result", ok: true, subtype: "success", turn: 1 });

    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "rewound.png" }] });
    // MarkerBackend emits a stamped event per turn, so turn 2 is PROVEN received
    // before the rewind — which is what makes the release carried.
    await waitFor(() => backend.turns.length >= 2);
    await waitFor(() => journal.outstanding(tab).length === 1);

    manager.rewind(tab, null); // abandons the in-flight turn
    await waitFor(() => (journal.outstanding(tab)[0]?.carriedReleases ?? 0) >= 1);
    expect(journal.outstanding(tab)).toHaveLength(1); // returned, not lost
  });

  it("an unmarked straggler RESULT never counts as carried, so it can't settle an unseen completion", async () => {
    // #728 lets unmarked events past the dead-letter gate. On a marker-declaring
    // backend such a result may belong to an abandoned turn and arrive while the
    // replacement turn is still pre-submission — three of those must not walk the
    // settle bound and retire a completion nobody ever received.
    const silent = new MarkerBackend({ silentTurns: true });
    const { journal, manager, arrive } = makeHarness(silent);
    const tab = "tab-straggler-bound";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => silent.turns.length >= 1);
    silent.emit({ type: "result", ok: true, subtype: "success", turn: 1 });

    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "unseen.png" }] });
    await waitFor(() => silent.turns.length >= 2); // dispatched, no events for it

    for (let i = 0; i < 4; i++) {
      silent.emit({ type: "result", ok: false, subtype: "error_during_execution" }); // UNMARKED
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(journal.outstanding(tab)).toHaveLength(1); // never settled
    expect(journal.outstanding(tab)[0].carriedReleases ?? 0).toBe(0);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(false);
  });

  it("a turn the backend never RECEIVED is released UNCARRIED — it can't count toward the bound", async () => {
    // The token is attached at dispatch, but Claude resolves output images before
    // submitting the turn. Aborting in that window means the model never saw the
    // completion, so it must not count toward the settle bound.
    const silent = new MarkerBackend({ silentTurns: true });
    const { journal, manager, arrive } = makeHarness(silent);
    const tab = "tab-unreceived";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => silent.turns.length >= 1);
    silent.emit({ type: "result", ok: true, subtype: "success", turn: 1 });

    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "unseen.png" }] });
    await waitFor(() => silent.turns.length >= 2); // dispatched, but NO events for it

    manager.rewind(tab, null);
    await new Promise((r) => setTimeout(r, 30));
    expect(journal.outstanding(tab)).toHaveLength(1); // returned…
    expect(journal.outstanding(tab)[0].carriedReleases ?? 0).toBe(0); // …unbounded
  });

  it("a failed start never HOLDS a completion — it goes back to the journal", async () => {
    // Held mail is unbounded and the journal's revocation only reaches a LIVE
    // agent's queue, so a completion parked in held mail is a copy the journal
    // can no longer cap: each failed-start/retry cycle would strand another
    // batch, and the pile eventually drains into one turn. The journal is their
    // record, so they are handed back instead — and the user's own message is
    // still held.
    const doomed: AgentBackend = {
      id: "claude" as const,
      capabilities: CLAUDE_CAPABILITIES,
      async prepare() {
        throw new Error("endpoint rejected the key (http 401)");
      },
      async *run(): AsyncGenerator<AgentEvent> {
        throw new Error("never runs");
      },
      async interrupt() {},
      async listModels() {
        return [];
      },
    };
    const { journal, manager, arrive } = makeHarness(doomed);
    const tab = "tab-no-held-completions";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "keep me"); // a real user message
    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "held.png" }] });
    await waitFor(() => journal.pending(tab).length === 0); // taken by the doomed agent
    await waitFor(() => manager.hasHeldMail(tab)); // …the USER message is held

    // The completion came straight back to the journal, replayable and capped.
    expect(journal.pending(tab)).toHaveLength(1);
    expect(journal.outstanding(tab)).toHaveLength(1);
  });

  it("a completion survives an agent whose self-restart loop GAVE UP", async () => {
    // The give-up branch of settle() only unmapped the agent — its still-unread
    // queue died with it, leaving the journal entry `handed_off`, a state
    // deliverPending() skips. Silent, permanent loss.
    let starts = 0;
    const flappy: AgentBackend = {
      id: "claude" as const,
      capabilities: CLAUDE_CAPABILITIES,
      // A session that ends immediately, every time, without reading the channel.
      async *run(): AsyncGenerator<AgentEvent> {
        starts += 1;
        return;
      },
      async interrupt() {},
      async listModels() {
        return [];
      },
    };
    const { journal, manager, arrive } = makeHarness(flappy);
    const tab = "tab-gaveup";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "gaveup.png" }] });
    await waitFor(() => journal.pending(tab).length === 0); // taken onto the doomed queue
    await waitFor(() => starts >= 4, 5000); // the bounded restart loop gives up

    // Held for the next start, with its token intact — not stranded handed_off.
    await waitFor(() => manager.hasHeldMail(tab), 5000);
    expect(journal.outstanding(tab)).toHaveLength(1);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(false);
  });

  it("a queued completion whose id is then REUSED is pulled back and re-worded", async () => {
    // The wording is baked in when the event is queued. If the completion is
    // still sitting unread and its correlation then weakens (ComfyUI reused the
    // prompt id), the stale copy would otherwise reach the agent still claiming
    // "the run YOU queued" — letting it read run A's output as run B's result.
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-reissue";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1); // turn 1 is HELD open

    // A's completion lands while the agent is busy → queued, unread.
    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "runA.png" }] });
    expect(journal.outstanding(tab)[0].state).toBe("handed_off");

    // ComfyUI reuses the id for run B while A's copy is still unread: the stale
    // copy is pulled back off the queue and immediately re-queued, re-worded.
    journal.openRun(PROMPT_A, { tabId: tab });
    expect(journal.outstanding(tab)).toHaveLength(1); // one copy, not two

    backend.finishTurn();
    await waitFor(() => backend.turns.length >= 2);
    const text = backend.turns[1];
    expect(text).toContain("runA.png"); // still delivered — never swallowed
    expect(text).not.toContain("This is the run YOU queued");
    expect(text).toContain("UNDETERMINED");
  });

  it("a replayed completion never satisfies a DIFFERENT run", async () => {
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-two-runs";

    // Run A completes but its delivery is stranded (no agent yet).
    journal.openRun(PROMPT_A, { tabId: tab });
    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "a.png" }] });
    expect(journal.pending(tab)).toHaveLength(1);

    // Only AFTER that does the agent queue run B. The stranded completion must
    // not drift onto it when it is finally replayed.
    journal.openRun(PROMPT_B, { tabId: tab });

    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.finishTurn();
    await waitFor(() => journal.outstanding(tab).length === 0);

    const all = backend.turns.join("\n");
    expect(all).toContain("a.png");
    expect(all).toContain(PROMPT_A);
    expect(all).not.toContain(PROMPT_B);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(true);
    expect(journal.ticketFor(PROMPT_B)?.settled).toBe(false); // B is still outstanding
  });
});

describe("run completion journal correlation (#468)", () => {
  let journal: RunCompletionJournalImpl;
  beforeEach(() => {
    journal = new RunCompletionJournalImpl();
  });

  it("correlates ONLY by exact prompt id — there is no most-recent-run fallback", () => {
    journal.openRun(PROMPT_A, { tabId: "t" });
    expect(journal.correlate("t", { prompt_id: PROMPT_A })).toEqual({
      status: "matched",
      promptId: PROMPT_A,
    });
    expect(journal.correlate("t", { prompt_id: PROMPT_B })).toEqual({
      status: "foreign",
      promptId: PROMPT_B,
    });
    expect(journal.correlate("t", {})).toEqual({ status: "unidentified" });
    // A near-miss id is foreign, never "close enough".
    expect(journal.correlate("t", { prompt_id: `${PROMPT_A}x` }).status).toBe("foreign");
  });

  it("a run queued on ANOTHER tab never matches — cross-tab is foreign, not matched", () => {
    journal.openRun(PROMPT_A, { tabId: "wf:one" });
    expect(journal.correlate("wf:one", { prompt_id: PROMPT_A }).status).toBe("matched");
    // The same run finishing after the browser tab switched to a different
    // workflow must NOT be presented to the new workflow's agent as its own.
    expect(journal.correlate("wf:two", { prompt_id: PROMPT_A }).status).toBe("foreign");
  });

  // ── #704 — WHOSE run is it: the conversation, not the tab ──────────────────
  //
  // The reported failure: `panel_run` returned prompt bc023bc3…, that exact run
  // came back RE-DELIVERED, and it was annotated "does NOT match any run you
  // queued with panel_run — its origin is UNDETERMINED. Do NOT treat it as the
  // render you are waiting on." That does not merely mislabel a correct result —
  // it instructs the agent to discard it and go re-verify.
  //
  // Why it happened: the ticket was owned by the panel TAB ID, which is a routing
  // address, not an identity. A panel that reconnects re-registers under a new id
  // (an unsaved workflow mints a fresh `tmp:<uuid>` on every page load) and only a
  // SAME-SOCKET re-hello carries the `migrated_from` that moveKey follows — so the
  // ticket was stranded under a dead id while the completion arrived under the
  // live one. The conversation (#884: one orchestrator-scoped session across every
  // tab and workflow) is the thing that actually queued the run and does not churn.
  //
  // Both directions are locked below: an own run stays attributable across the
  // gap, and a run this conversation did NOT queue stays unattributable.

  it("#704: a run this CONVERSATION queued still matches after the panel reconnects under a NEW tab id", () => {
    const CLAUDE = "orchestrator::claude";
    journal.openRun(PROMPT_A, { tabId: "tmp:before-reload", conversation: CLAUDE });
    // The browser reloaded mid-render: same panel, same conversation, new socket,
    // and the unsaved workflow minted a fresh tmp: id — no migration alias exists
    // for moveKey to follow, so the ticket's tab is simply gone.
    expect(journal.correlate("tmp:after-reload", { prompt_id: PROMPT_A }, CLAUDE)).toEqual({
      status: "matched",
      promptId: PROMPT_A,
    });
  });

  it("#704: the RE-DELIVERED completion carries the matched verdict, not the UNDETERMINED warning", () => {
    // End to end through the journal, in the shape the issue reported: the
    // completion lands when no agent can take it (so it is replayed later), and
    // the tab it lands on is not the one the run was queued from.
    const CLAUDE = "orchestrator::claude";
    journal.openRun(PROMPT_A, { tabId: "tmp:before-reload", conversation: CLAUDE });
    const entry = journal.record(
      "tmp:after-reload",
      { kind: "executed", prompt_id: PROMPT_A },
      { conversation: CLAUDE },
    );
    expect(entry.correlation.status).toBe("matched");
    journal.deliverPending("tmp:after-reload", () => false); // no agent — journaled
    const seen: CompletionPayload[] = [];
    journal.deliverPending("tmp:after-reload", (p) => {
      seen.push(p);
      return true;
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].replayed).toBe(true); // …the "RE-DELIVERED" prefix
    expect(seen[0].run_correlation).toBe("matched"); // …but NOT "its origin is UNDETERMINED"
  });

  it("#704 NEGATIVE: a run this conversation never queued is STILL unattributable", () => {
    // The user pressing Queue Prompt themselves, or any render nothing ticketed:
    // there is no ticket, so nothing to own, and the warning must still fire.
    const CLAUDE = "orchestrator::claude";
    journal.openRun(PROMPT_A, { tabId: "wf:one", conversation: CLAUDE });
    expect(journal.correlate("wf:one", { prompt_id: PROMPT_B }, CLAUDE)).toEqual({
      status: "foreign",
      promptId: PROMPT_B,
    });
    // …including on the very tab that queued A, and for a near-miss id.
    expect(journal.correlate("wf:one", { prompt_id: `${PROMPT_A}x` }, CLAUDE).status).toBe(
      "foreign",
    );
  });

  it("#704 NEGATIVE: ANOTHER conversation's run never matches, even on the same tab", () => {
    // Two backends are two conversations. A render codex queued must never be
    // handed to claude as "the run YOU queued" — and this is STRICTER than the old
    // by-tab rule, which matched on the tab alone and would have.
    journal.openRun(PROMPT_A, { tabId: "wf:one", conversation: "orchestrator::codex" });
    expect(
      journal.correlate("wf:one", { prompt_id: PROMPT_A }, "orchestrator::claude").status,
    ).toBe("foreign");
    expect(
      journal.correlate("wf:one", { prompt_id: PROMPT_A }, "orchestrator::codex").status,
    ).toBe("matched");
  });

  it("#704 NEGATIVE: New chat still ends ownership, even for a ticket whose tab id has churned", () => {
    // The replacement conversation reuses the SAME key string
    // (`orchestrator::<backend>`), so the boundary cannot rest on the key — the
    // ticket has to be deleted. Closing by conversation is what reaches a ticket
    // whose tab was re-registered and is therefore in no member-tab sweep.
    const CLAUDE = "orchestrator::claude";
    journal.openRun(PROMPT_A, { tabId: "tmp:gone", conversation: CLAUDE });
    const arrived = journal.record(
      "tmp:live",
      { kind: "executed", prompt_id: PROMPT_A },
      { conversation: CLAUDE },
    );
    expect(arrived.correlation.status).toBe("matched");
    journal.closeRuns("tmp:live", CLAUDE); // New chat, swept over the LIVE tab only
    expect(journal.ticketFor(PROMPT_A)).toBeUndefined();
    expect(journal.correlate("tmp:live", { prompt_id: PROMPT_A }, CLAUDE).status).toBe("foreign");
    // …and the already-arrived one is downgraded, never swallowed.
    expect(journal.pending("tmp:live")).toHaveLength(1);
    expect(journal.pending("tmp:live")[0].correlation.status).toBe("foreign");
  });

  it("#704: an own run keeps its dedupe identity across the tab change (no phantom duplicate)", () => {
    // Ownership drives the GENERATION too. If it did not, a completion that
    // correlates as ours would still be stamped generation 0 — "no identity" — and
    // lose both its ack memo and its already-delivered flag, so a panel re-sending
    // the frame would look like a brand-new render.
    const CLAUDE = "orchestrator::claude";
    journal.openRun(PROMPT_A, { tabId: "tmp:before", conversation: CLAUDE });
    const entry = journal.record(
      "tmp:after",
      { kind: "executed", prompt_id: PROMPT_A },
      { conversation: CLAUDE },
    );
    expect(entry.ticketSeq).toBeGreaterThan(0);
    expect(entry.ambiguousId).toBeUndefined();
    journal.deliverPending("tmp:after", () => true);
    journal.ack(entry.token);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(true);
    const resend = journal.record(
      "tmp:after",
      { kind: "executed", prompt_id: PROMPT_A },
      { conversation: CLAUDE },
    );
    expect(resend.possibleRepeat).toBe(true); // flagged, never suppressed
  });

  it("#704: a New chat on ANOTHER backend does not close this conversation's ticket", () => {
    // Boundaries are per conversation, and a tab can change which conversation it
    // belongs to. Closing by tab as well looked like the safe direction — closing
    // too much only weakens a verdict — but it is the #704 failure in miniature:
    // claude queues on tab T, T switches to codex, a codex New chat runs, and
    // claude's own render comes back UNDETERMINED (adversarial gate, round 2).
    journal.openRun(PROMPT_A, { tabId: "wf:one", conversation: "orchestrator::claude" });
    journal.closeRuns("wf:one", "orchestrator::codex"); // codex's boundary, same tab
    expect(journal.ticketFor(PROMPT_A)).toBeDefined();
    expect(
      journal.correlate("wf:one", { prompt_id: PROMPT_A }, "orchestrator::claude").status,
    ).toBe("matched");
    // …and codex still cannot claim it.
    expect(
      journal.correlate("wf:one", { prompt_id: PROMPT_A }, "orchestrator::codex").status,
    ).toBe("foreign");
    // A ticket with no conversation to name is still closed by its tab, so the
    // legacy path keeps a boundary rather than leaking one.
    journal.openRun(PROMPT_B, { tabId: "wf:one" });
    journal.closeRuns("wf:one", "orchestrator::codex");
    expect(journal.ticketFor(PROMPT_B)).toBeUndefined();
  });

  it("#704 NEGATIVE: a REUSED prompt id is still detected when the delivery was acked under a different tab id", () => {
    // Ownership and the already-delivered MEMO have to agree about who a run
    // belongs to. When the memo was still filed under the tab, a delivery acked
    // after a reconnect became invisible to the reuse check: the id looked like a
    // clean identity when ComfyUI handed it out again, and the EARLIER
    // generation's late completion could then be presented as the new run's
    // result (found by the adversarial gate).
    const CLAUDE = "orchestrator::claude";
    journal.openRun(PROMPT_A, { tabId: "tmp:before", conversation: CLAUDE });
    const first = journal.record(
      "tmp:after",
      { kind: "executed", prompt_id: PROMPT_A },
      { conversation: CLAUDE },
    );
    journal.deliverPending("tmp:after", () => true);
    journal.ack(first.token); // delivered + memoized, entry gone
    // A busy session evicts the settled ticket…
    for (let i = 0; i < 80; i++) {
      journal.openRun(`later-${i}`, { tabId: "tmp:after", conversation: CLAUDE });
    }
    expect(journal.ticketFor(PROMPT_A)).toBeUndefined();
    // …and ComfyUI hands the same id out again, queued from a third tab id.
    journal.openRun(PROMPT_A, { tabId: "tmp:third", conversation: CLAUDE });
    expect(journal.ticketFor(PROMPT_A)?.reused).toBe(true);
    // So neither generation's completion may claim to be the run now outstanding.
    expect(journal.correlate("tmp:third", { prompt_id: PROMPT_A }, CLAUDE).status).toBe("foreign");
  });

  it("forget drops the tab's RUN TICKETS too, so a late completion reads as undetermined", () => {
    journal.openRun(PROMPT_A, { tabId: "wf:one" });
    journal.forget("wf:one");
    expect(journal.ticketFor(PROMPT_A)).toBeUndefined();
    expect(journal.correlate("wf:one", { prompt_id: PROMPT_A }).status).toBe("foreign");
  });

  it("moveKey carries the run tickets, so a migrated tab's own run still matches", () => {
    journal.openRun(PROMPT_A, { tabId: "tmp:draft" });
    journal.moveKey("tmp:draft", "wf:saved.json");
    expect(journal.correlate("wf:saved.json", { prompt_id: PROMPT_A }).status).toBe("matched");
    expect(journal.correlate("tmp:draft", { prompt_id: PROMPT_A }).status).toBe("foreign");
  });

  it("closeRuns keeps the arrived completions but DOWNGRADES them to undetermined", () => {
    // New chat / switch to a historical session: the conversation that queued the
    // run is gone, so a render it queued must not be introduced to the
    // replacement agent as "the run YOU queued" — neither a future completion
    // nor one already sitting undelivered in the journal.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const arrived = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    expect(arrived?.correlation.status).toBe("matched");
    journal.closeRuns("t");
    expect(journal.ticketFor(PROMPT_A)).toBeUndefined();
    expect(journal.correlate("t", { prompt_id: PROMPT_A }).status).toBe("foreign");
    // Still deliverable — never swallowed — but no longer claimed as ours. A
    // correlation may only ever weaken, never strengthen.
    expect(journal.pending("t")).toHaveLength(1);
    expect(journal.pending("t")[0].correlation.status).toBe("foreign");
  });

  it("a completion re-sent AFTER its delivery was acked is FLAGGED, never suppressed", () => {
    // "Already delivered" is a LABEL, not a veto. Every proof it could rest on
    // (the memo, the ticket's settled flag, the ticket itself) is bounded, so
    // suppressing on one turns into a silent loss the moment it expires at the
    // wrong time — which is exactly how this defect kept coming back.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const entry = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    journal.deliverPending("t", () => true);
    journal.ack(entry!.token); // the carrying turn ended — entry is gone
    const resend = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    expect(resend.possibleRepeat).toBe(true);
    expect(journal.pending("t")).toHaveLength(1);
    // …and the flag reaches the agent, so it can decline to double-count it.
    const seen: CompletionPayload[] = [];
    journal.deliverPending("t", (p) => {
      seen.push(p);
      return true;
    });
    expect(seen[0].possible_repeat).toBe(true);
  });

  it("evicting a HANDED-OFF completion is counted too — a hand-off is not proof of consumption", () => {
    for (let i = 0; i < 32; i++) journal.record("t", { kind: "executed", prompt_id: `h-${i}` });
    journal.deliverPending("t", () => true); // all handed off, none acked
    expect(journal.droppedFor("t")).toBe(0);
    // One more arrival pushes the oldest handed-off entry out. If its agent dies
    // before reading it, `release` would have nothing to re-arm — so it counts.
    journal.record("t", { kind: "executed", prompt_id: "h-overflow" });
    expect(journal.droppedFor("t")).toBe(1);
  });

  it("a re-sent completion never RE-ARMS the handed-off copy (it gets its own entry instead)", () => {
    // The original hand-off must not be re-armed: its text is already in a turn,
    // so re-arming would deliver that same text twice off one entry and leave the
    // second delivery untracked. It gets a separate entry instead — the
    // deliberate duplicate-over-loss trade, since merging into committed text is
    // how a newer completion gets deleted by an older one's ack.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const first = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    journal.deliverPending("t", () => true); // handed off, not yet acked
    expect(journal.pending("t")).toHaveLength(0);

    const resend = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "resend" });
    expect(resend!.token).not.toBe(first!.token);
    expect(journal.outstanding("t")).toHaveLength(2);
    // …and the first entry is untouched: still handed off, still its own payload.
    expect(journal.outstanding("t")[0].state).toBe("handed_off");
    expect(journal.outstanding("t")[0].payload.note).toBeUndefined();
  });

  it("evicting a still-pending completion is COUNTED and reported on the next delivery", () => {
    // Fill past the per-tab ceiling with completions nothing can deliver.
    for (let i = 0; i < 40; i++) {
      journal.record("t", { kind: "executed", prompt_id: `p-${i}` });
    }
    const lost = journal.droppedFor("t");
    expect(lost).toBeGreaterThan(0);
    const seen: CompletionPayload[] = [];
    journal.deliverPending("t", (p) => {
      seen.push(p);
      return true;
    });
    expect(seen[0].dropped_completions).toBe(lost);
    // Carried by the entry it rode out on, so only THAT one reports it…
    expect(seen[1]?.dropped_completions).toBeUndefined();
    // …and it is spent only when that entry's carrying turn ends (a hand-off is
    // not consumption — see the replay test below).
    expect(journal.droppedFor("t")).toBe(lost);
    journal.ack(journal.outstanding("t")[0].token);
    expect(journal.droppedFor("t")).toBe(0);
  });

  it("freezes the correlation at arrival — a run opened later can never claim it", () => {
    const entry = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    expect(entry.correlation.status).toBe("foreign"); // A wasn't queued yet
    journal.openRun(PROMPT_A, { tabId: "t" }); // …now it is
    // The stored entry keeps its arrival verdict; only NEW arrivals see the run.
    expect(journal.pending("t")[0].correlation.status).toBe("foreign");
  });

  it("openRun without a prompt id is refused — nothing can be correlated to it", () => {
    expect(journal.openRun(null, { tabId: "t" })).toBe(false);
    expect(journal.openRun("", { tabId: "t" })).toBe(false);
    expect(journal.openRun(PROMPT_A, { tabId: "t" })).toBe(true);
  });

  it("collapses a re-sent completion for the same run onto one entry", () => {
    journal.openRun(PROMPT_A, { tabId: "t" });
    const first = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    const again = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    expect(again.token).toBe(first.token);
    expect(journal.outstanding("t")).toHaveLength(1);
  });

  it("a REUSED prompt id delivers every completion, as UNDETERMINED, suppressing none", () => {
    // Nothing on the wire distinguishes generation A's completion from B's — the
    // panel sends only the id. So once an id is queued twice it identifies no
    // single run: suppressing on the delivered proofs could swallow B's real
    // result, and claiming a match could present A's result as B's.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const first = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    expect(first!.correlation.status).toBe("matched"); // not reused yet
    journal.deliverPending("t", () => true);
    journal.ack(first!.token);
    expect(journal.record("t", { kind: "executed", prompt_id: PROMPT_A }).possibleRepeat).toBe(true);

    journal.openRun(PROMPT_A, { tabId: "t" }); // ComfyUI reused the id
    expect(journal.ticketFor(PROMPT_A)?.reused).toBe(true);

    // Both a late resend of A and B's real completion are now delivered, each
    // labelled UNDETERMINED. Neither is suppressed; neither claims to be "the
    // run YOU queued".
    const second = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    expect(second).not.toBeNull();
    expect(second!.correlation.status).toBe("foreign");
    journal.deliverPending("t", () => true);
    journal.ack(second!.token);
    const third = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    expect(third).not.toBeNull(); // NOT swallowed as a duplicate of the previous
    expect(third!.correlation.status).toBe("foreign");
  });

  it("a REUSED id never COALESCES — B's completion gets its own entry, so A's ack can't take it", () => {
    // Coalescing assumes the prompt id identifies one run; `reused` is exactly
    // the state where that is void. Merging B into A's entry would return A's
    // entry for B, leave A's text in the already-queued turn, and let A's ack
    // remove the sole entry — B never delivered. Duplicate over loss.
    journal.openRun(PROMPT_A, { tabId: "t" });
    journal.openRun(PROMPT_A, { tabId: "t" }); // ComfyUI reused the id
    expect(journal.ticketFor(PROMPT_A)?.reused).toBe(true);

    const late = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "run A (late)" });
    journal.deliverPending("t", () => true); // A handed off, unread

    const real = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "run B (real)" });
    expect(real).not.toBeNull();
    expect(real!.token).not.toBe(late!.token); // its OWN entry, never merged
    expect(real!.payload.note).toBe("run B (real)");

    // A's turn ends: it takes only its own entry with it.
    journal.ack(late!.token);
    expect(journal.pending("t")).toHaveLength(1);
    expect(journal.pending("t")[0].payload.note).toBe("run B (real)");
  });

  it("NEVER coalesces onto a handed-off entry — the rule that closes every ordering", () => {
    // The correctness rule is a property of the TARGET'S CURRENT STATE, so it
    // holds with no knowledge of history: no reuse, no eviction, nothing marked.
    // A handed-off entry's text is committed to a turn that will ack and delete
    // it, so merging newer news into it loses that news.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const first = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "first" });
    journal.deliverPending("t", () => true); // handed off, unread, unacked
    expect(first!.ambiguousId).toBeUndefined(); // no marking involved at all

    const second = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "second" });
    expect(second!.token).not.toBe(first!.token);

    journal.ack(first!.token); // the queued turn ends
    expect(journal.pending("t")).toHaveLength(1);
    expect(journal.pending("t")[0].payload.note).toBe("second");
  });

  it("the eviction-BEFORE-reuse ordering cannot lose the new run either", () => {
    // The ordering no marking scheme could cover: A's ticket is evicted BEFORE
    // the id is reused, so B takes the fresh-ticket path and nothing anywhere
    // knows the id is ambiguous. The `pending` predicate closes it regardless.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const late = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "run A (late)" });
    journal.deliverPending("t", () => true); // handed off, unread

    for (let i = 0; i < 80; i++) journal.openRun(`later-${i}`, { tabId: "t" }); // evict A's ticket
    expect(journal.ticketFor(PROMPT_A)).toBeUndefined();

    journal.openRun(PROMPT_A, { tabId: "t" }); // B reuses the id — a FRESH ticket
    // …but NOT a fresh identity: this tab already has history for the id, so the
    // new ticket is born ambiguous and every completion for it reads UNDETERMINED.
    expect(journal.ticketFor(PROMPT_A)?.reused).toBe(true);
    const real = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "run B (real)" });
    expect(real).not.toBeNull();
    expect(real!.token).not.toBe(late!.token);

    journal.ack(late!.token);
    expect(journal.pending("t")).toHaveLength(1);
    expect(journal.pending("t")[0].payload.note).toBe("run B (real)");
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(false); // A's ack settles nothing
  });

  it("an older generation's PENDING entry is never merged into by a newer run", () => {
    // Both entries are `pending`, so the state predicate alone permits the merge
    // — identity is what forbids it. A's completion arrived with no agent to
    // take it; its ticket is then evicted and the id re-queued for B. Merging
    // would overwrite A's result with B's and leave the survivor stamped with
    // A's generation, so its ack could settle neither run.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const a = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "run A" });
    expect(journal.pending("t")).toHaveLength(1); // never handed off

    for (let i = 0; i < 80; i++) journal.openRun(`later-${i}`, { tabId: "t" }); // evict A's ticket
    journal.openRun(PROMPT_A, { tabId: "t" }); // B reuses the id — fresh generation

    const b = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "run B" });
    expect(b!.token).not.toBe(a!.token); // separate entries, both deliverable
    expect(journal.pending("t")).toHaveLength(2);
    expect(journal.pending("t").map((e) => e.payload.note)).toEqual(["run A", "run B"]);
  });

  it("an older generation's ack cannot write a memo that suppresses the newer run", () => {
    // A is handed off; A's ticket is evicted; B reuses the id; THEN A's carrying
    // turn ends. A's ack must not leave a proof that swallows B's real result.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const a = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "run A" });
    journal.deliverPending("t", () => true); // A handed off, unread

    for (let i = 0; i < 80; i++) journal.openRun(`later-${i}`, { tabId: "t" }); // evict A's ticket
    journal.openRun(PROMPT_A, { tabId: "t" }); // B reuses the id — fresh generation
    journal.ack(a!.token); // A's turn ends AFTER B was queued

    const b = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "run B" });
    expect(b).not.toBeNull(); // NOT suppressed by A's memo
    expect(b!.payload.note).toBe("run B");
  });

  it("a FRESH ticket after eviction also retires the older run's queued completion", () => {
    // The retire/downgrade pass used to run only on the reopen path. After an
    // eviction the same id takes the fresh-ticket path, so an older `matched`
    // entry survived untouched and went on telling the agent "this is the run
    // YOU queued" — letting run A's output be acted on as run B's.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const a = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "run A" });
    expect(a!.correlation.status).toBe("matched");

    for (let i = 0; i < 80; i++) journal.openRun(`later-${i}`, { tabId: "t" }); // evict A's ticket
    expect(journal.ticketFor(PROMPT_A)).toBeUndefined();

    journal.openRun(PROMPT_A, { tabId: "t" }); // B takes the FRESH-ticket path
    expect(a!.correlation.status).toBe("foreign"); // A downgraded…
    expect(a!.superseded).toBe(true); // …and retired
  });

  it("two foreign completions sharing a prompt id are BOTH delivered", () => {
    // Generation 0 means "this tab never queued that id", so it is a bucket
    // shared by every foreign completion — not an identity. Two genuinely
    // different external renders that reuse a prompt id (a ComfyUI restart does
    // exactly that) must not merge, and the second must not be suppressed after
    // the first is acked.
    const first = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "external 1" });
    expect(first!.correlation.status).toBe("foreign");
    const second = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "external 2" });
    expect(second!.token).not.toBe(first!.token); // never merged
    expect(journal.pending("t")).toHaveLength(2);

    journal.deliverPending("t", () => true);
    journal.ack(first!.token);
    const third = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "external 3" });
    expect(third).not.toBeNull(); // never suppressed by the first's ack
  });

  it("a late resend of an ACKED run cannot settle — nor suppress — the run that reused its id", () => {
    // The nastiest ordering: A completes and is fully acked; A's ticket is
    // evicted; B reuses the id. A's late resend is byte-identical to B's
    // completion, so treating the new ticket as a clean identity meant the
    // resend correlated as B, its ack SETTLED B, and B's real completion was
    // then suppressed by B's own settled flag — misattribution and loss.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const a = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "run A" });
    journal.deliverPending("t", () => true);
    journal.ack(a!.token); // A fully delivered and settled

    for (let i = 0; i < 80; i++) journal.openRun(`later-${i}`, { tabId: "t" }); // evict A's ticket
    journal.openRun(PROMPT_A, { tabId: "t" }); // B reuses the id

    const resend = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "A resend" });
    expect(resend).not.toBeNull();
    expect(resend!.correlation.status).toBe("foreign"); // cannot claim to be B
    journal.deliverPending("t", () => true);
    journal.ack(resend!.token);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(false); // B is NOT answered

    const real = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "run B" });
    expect(real).not.toBeNull(); // B's own completion still lands
    expect(real!.payload.note).toBe("run B");
  });

  it("even with ALL history expired, a resend can't suppress the run that reused its id", () => {
    // The last ordering: A is acked, then enough later runs expire BOTH its
    // ticket (64) and its delivered memo (512), so nothing remembers the id at
    // all. B then queues it and looks, correctly, like a fresh identity.
    // A's late resend is now indistinguishable from B's completion — and that is
    // fine, because "already delivered" no longer VETOES anything. Whatever
    // arrives is delivered; the worst case is a flagged duplicate, never a loss.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const a = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "run A" });
    journal.deliverPending("t", () => true);
    journal.ack(a.token);

    for (let i = 0; i < 600; i++) {
      journal.openRun(`later-${i}`, { tabId: "t" });
      const e = journal.record("t", { kind: "executed", prompt_id: `later-${i}` });
      journal.deliverPending("t", () => true);
      journal.ack(e.token);
    }
    expect(journal.ticketFor(PROMPT_A)).toBeUndefined(); // all history expired

    journal.openRun(PROMPT_A, { tabId: "t" }); // B — looks fresh, and is treated so
    const resend = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "A resend" });
    journal.deliverPending("t", () => true);
    journal.ack(resend.token); // the resend settles the ticket it matched

    // B's REAL completion still lands. Under the old suppress-on-proof rule this
    // was the loss: B's own settled flag swallowed it.
    const real = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "run B" });
    expect(real.payload.note).toBe("run B");
    expect(real.possibleRepeat).toBe(true); // …flagged, so it isn't double-counted
    expect(journal.pending("t")).toHaveLength(1);
  });

  it("the no-coalesce rule survives the reused TICKET being evicted", () => {
    // Tickets are the smallest bound (64) and evictable. If ambiguity were read
    // only from the live ticket, 64 later runs would make the incoming side
    // forget — and the next ambiguous completion would merge into the earlier
    // one, whose ack then removes the sole entry. The mark lives on the ENTRY,
    // which outlives the ticket.
    journal.openRun(PROMPT_A, { tabId: "t" });
    journal.openRun(PROMPT_A, { tabId: "t" }); // reused
    const late = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "run A (late)" });
    expect(late!.ambiguousId).toBe(true);
    journal.deliverPending("t", () => true); // handed off, unread

    // Evict the reused ticket with 64+ later runs.
    for (let i = 0; i < 80; i++) journal.openRun(`later-${i}`, { tabId: "t" });
    expect(journal.ticketFor(PROMPT_A)).toBeUndefined();

    const real = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "run B (real)" });
    expect(real!.token).not.toBe(late!.token); // still its OWN entry
    journal.ack(late!.token);
    expect(journal.pending("t")).toHaveLength(1);
    expect(journal.pending("t")[0].payload.note).toBe("run B (real)");
  });

  it("re-queuing a prompt id SUPERSEDES the old entry — the old result can't answer for the new run", () => {
    // Prompt-id reuse while the previous completion is still in an agent's queue.
    // Merging into that entry would hand the OLD result over as the NEW run's
    // (its queued turn still holds the old text) and the new completion would
    // never be delivered at all.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const old = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "run A" });
    journal.deliverPending("t", () => true); // handed off, unread, unacked

    journal.openRun(PROMPT_A, { tabId: "t" }); // ComfyUI reused the id
    const fresh = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "run B" });
    expect(fresh).not.toBeNull();
    expect(fresh!.token).not.toBe(old!.token); // its OWN entry, not a merge
    expect(journal.pending("t")).toHaveLength(1);

    // …and it is DOWNGRADED: it may still be delivered (it is a real result) but
    // never as "the run YOU queued", which would present run A's output as the
    // awaited outcome of run B.
    expect(old!.correlation.status).toBe("foreign");

    // The old entry's turn ends: it must NOT settle the reopened ticket, and must
    // NOT memoize the id as delivered (which would suppress run B's completion).
    journal.ack(old!.token);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(false);
    expect(journal.pending("t")).toHaveLength(1); // run B still awaits delivery

    // Run B's own completion is delivered too — as UNDETERMINED, because a
    // reused id can no longer be attributed to one run.
    journal.deliverPending("t", () => true);
    journal.ack(fresh!.token);
    expect(journal.outstanding("t")).toHaveLength(0);
  });

  it("an eviction disclosure rides a surviving entry, so it can't be discarded before it's told", () => {
    // The side map is bounded; a count parked there for a tab that still HAS a
    // deliverable entry could be discarded before it was ever reported. The
    // count now rides that entry instead.
    journal.record("t", { kind: "executed", prompt_id: "keeper" });
    for (let i = 0; i < 40; i++) journal.record("t", { kind: "executed", prompt_id: `e-${i}` });
    const lost = journal.droppedFor("t");
    expect(lost).toBeGreaterThan(0);
    // The count must live ON a surviving entry, not in the boundable side map —
    // that is what makes it undiscardable while the tab can still be told.
    const carrier = journal.outstanding("t").find((e) => (e.disclose ?? 0) > 0);
    expect(carrier).toBeDefined();
    expect(carrier!.disclose).toBe(lost);
    // Churn far past the side map's bound with agentless tabs; ours is untouched.
    for (let i = 0; i < 200; i++) {
      journal.record(`ghost-${i}`, { kind: "executed", prompt_id: `g-${i}` });
      journal.forget(`ghost-${i}`);
    }
    expect(journal.droppedFor("t")).toBe(lost); // still intact
    const seen: CompletionPayload[] = [];
    journal.deliverPending("t", (p) => {
      seen.push(p);
      return true;
    });
    expect(seen[0].dropped_completions).toBe(lost);
  });

  it("an eviction REVOKES the queued copy, so the agent's queue stays bounded with the journal", () => {
    // The journal's cap bounds the journal; the agent's QUEUE owns the payload.
    // Evicting only the record left the text queued forever, so a panel resending
    // in a loop grew that queue without limit — and it all drains into one turn,
    // starving the genuine completion.
    const queued = new Set<string>();
    journal.setRevoker((_key, token) => queued.delete(token));
    for (let i = 0; i < 60; i++) {
      const e = journal.record("t", { kind: "executed", prompt_id: `p-${i}` });
      journal.deliverPending("t", (_p, token) => {
        queued.add(token);
        return true;
      });
      void e;
    }
    // The journal is capped… and so is what the agent is actually holding.
    expect(journal.outstanding("t").length).toBeLessThanOrEqual(32);
    expect(queued.size).toBe(journal.outstanding("t").length);
  });

  it("an eviction disclosure never lands on a HANDED-OFF entry that can't report it", () => {
    // deliverPending only reads PENDING entries. Stamping the count on a
    // handed-off one attaches the warning to text already queued (nobody will
    // build that payload again) and ack() then spends it: neither replayed nor
    // disclosed. With no pending entry it must go to the side map, where the
    // next pending delivery picks it up.
    for (let i = 0; i < 32; i++) journal.record("t", { kind: "executed", prompt_id: `h-${i}` });
    journal.deliverPending("t", () => true); // all handed off, none acked
    expect(journal.pending("t")).toHaveLength(0);

    journal.record("t", { kind: "executed", prompt_id: "overflow" }); // evicts one
    const lost = journal.droppedFor("t");
    expect(lost).toBeGreaterThan(0);
    // No pending entry carries it…
    expect(journal.outstanding("t").filter((e) => e.state === "handed_off" && e.disclose)).toHaveLength(0);
    // …and the next PENDING delivery reports it.
    const seen: CompletionPayload[] = [];
    journal.deliverPending("t", (p) => {
      seen.push(p);
      return true;
    });
    expect(seen[0].dropped_completions).toBe(lost);
  });

  it("a resend is FLAGGED while the run's IDENTITY survives, and merely undetermined after", () => {
    // The repeat FLAG is keyed by ticket generation, so it lasts exactly as long
    // as the identity that makes "we already reported THIS run" a true statement.
    // Either way the completion is delivered — only the labelling changes.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const entry = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    journal.deliverPending("t", () => true);
    journal.ack(entry!.token);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(true);
    expect(journal.record("t", { kind: "executed", prompt_id: PROMPT_A }).possibleRepeat).toBe(true);

    // Flood with REAL runs so the ticket map overflows and this run's identity
    // is evicted. Past that point the journal genuinely cannot tell a resend
    // from a first delivery for an id it no longer knows.
    for (let i = 0; i < 200; i++) {
      journal.openRun(`flood-${i}`, { tabId: "t" });
      const e = journal.record("t", { kind: "executed", prompt_id: `flood-${i}` });
      journal.deliverPending("t", () => true);
      journal.ack(e!.token);
    }
    expect(journal.ticketFor(PROMPT_A)).toBeUndefined();

    // Delivered again rather than swallowed — and honestly, as UNDETERMINED.
    // Duplicate over loss: the alternative is a generation-blind memo, which is
    // what used to suppress a genuinely NEW run that reused the id.
    const late = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    expect(late).not.toBeNull();
    expect(late!.correlation.status).toBe("foreign");
  });

  it("an eviction disclosure survives a hand-off that is never consumed", () => {
    // A hand-off is not consumption. If the agent holding the warning is stopped
    // before its turn runs, the replay must carry the warning again — clearing it
    // at hand-off left the eviction permanently undisclosed.
    journal.record("t", { kind: "executed", prompt_id: "keeper" });
    for (let i = 0; i < 40; i++) journal.record("t", { kind: "executed", prompt_id: `e-${i}` });
    const lost = journal.droppedFor("t");
    expect(lost).toBeGreaterThan(0);

    const first: CompletionPayload[] = [];
    journal.deliverPending("t", (p) => {
      first.push(p);
      return true;
    });
    expect(first[0].dropped_completions).toBe(lost);

    // The agent died before reading it → released → replayed.
    for (const e of journal.outstanding("t")) journal.release(e.token);
    const again: CompletionPayload[] = [];
    journal.deliverPending("t", (p) => {
      again.push(p);
      return true;
    });
    expect(again[0].dropped_completions).toBe(lost); // still disclosed

    // Only the carrying turn ENDING spends it.
    const carrier = journal.outstanding("t")[0];
    journal.ack(carrier.token);
    expect(journal.droppedFor("t")).toBe(0);
  });

  it("a prompt id reused AFTER its ticket was evicted still delivers the new run's completion", () => {
    // The memo outlives the ticket by design, so a reuse can take the
    // FRESH-ticket path with a stale memo still standing. `panel_run` promises
    // automatic delivery for that new run — the memo must not swallow it. And
    // because this tab already has history for the id, the new ticket is born
    // ambiguous: delivered, but honestly, as UNDETERMINED.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const first = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    journal.deliverPending("t", () => true);
    journal.ack(first!.token);
    for (let i = 0; i < 200; i++) {
      journal.openRun(`flood-${i}`, { tabId: "t" });
      const e = journal.record("t", { kind: "executed", prompt_id: `flood-${i}` });
      journal.deliverPending("t", () => true);
      journal.ack(e!.token);
    }
    expect(journal.ticketFor(PROMPT_A)).toBeUndefined(); // evicted, so this is a FRESH ticket

    journal.openRun(PROMPT_A, { tabId: "t" }); // ComfyUI reused the id for a NEW run
    expect(journal.ticketFor(PROMPT_A)?.reused).toBe(true); // history ⇒ ambiguous
    const second = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    // DELIVERED — the older run's memo never reaches it — but as UNDETERMINED,
    // because a late resend of the older run is indistinguishable from this one.
    expect(second).not.toBeNull();
    expect(second!.correlation.status).toBe("foreign");
    // …and a further completion for the id is not suppressed by this one's ack.
    journal.deliverPending("t", () => true);
    journal.ack(second!.token);
    expect(journal.record("t", { kind: "executed", prompt_id: PROMPT_A })).not.toBeNull();
  });

  it("a stall/rewind abandon is CARRIED, so a freezing backend can't replay forever", () => {
    // Both auto-repeat, so an unbounded release there is an infinite replay
    // source. Three dispatched-and-abandoned turns settle it instead.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const entry = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    for (let i = 0; i < 3; i++) {
      journal.deliverPending("t", () => true);
      journal.release(entry!.token, { carried: true });
    }
    expect(journal.outstanding("t")).toHaveLength(0);
  });

  it("hasOutstanding reports any undelivered completion (the self-restart gate)", () => {
    expect(journal.hasOutstanding()).toBe(false);
    const entry = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    expect(journal.hasOutstanding()).toBe(true);
    journal.deliverPending("t", () => true);
    expect(journal.hasOutstanding()).toBe(true); // handed off is NOT delivered
    journal.ack(entry!.token);
    expect(journal.hasOutstanding()).toBe(false);
  });

  it("allOutstanding names every undelivered completion, per tab, for the exit disclosure", () => {
    // A FATAL self-exit bypasses the idle gate by design and the journal is
    // in-memory, so these die with the process. They must be reported on the way
    // out (per tab, naming the run) rather than silently evaporating.
    journal.openRun(PROMPT_A, { tabId: "wf:one" });
    journal.record("wf:one", { kind: "executed", prompt_id: PROMPT_A });
    journal.record("wf:two", { kind: "executed", prompt_id: PROMPT_B });
    const handed = journal.record("wf:two", { kind: "executed" });
    journal.deliverPending("wf:two", () => true); // handed off still counts

    const all = journal.allOutstanding();
    expect(all).toHaveLength(3);
    expect(all.filter((e) => e.key === "wf:one")).toHaveLength(1);
    expect(all.filter((e) => e.key === "wf:two")).toHaveLength(2);
    expect(describeCorrelation(all[0].correlation)).toContain(PROMPT_A);

    journal.ack(handed!.token);
    expect(journal.allOutstanding()).toHaveLength(2); // acked ones are gone
  });

  it("only the entry's OWN run is settled on ack", () => {
    journal.openRun(PROMPT_A, { tabId: "t" });
    journal.openRun(PROMPT_B, { tabId: "t" });
    const entry = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    journal.ack(entry.token);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(true);
    expect(journal.ticketFor(PROMPT_B)?.settled).toBe(false);
  });

  it("an entry is only cleared by ack — a hand-off alone keeps it replayable", () => {
    journal.openRun(PROMPT_A, { tabId: "t" });
    journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    const dead = journal.deliverPending("t", () => false);
    expect(dead.delivered).toBe(0);
    expect(dead.blockedOn).not.toBeNull();
    expect(journal.pending("t")).toHaveLength(1); // refused → still pending

    const seen: CompletionPayload[] = [];
    journal.deliverPending("t", (p) => {
      seen.push(p);
      return true;
    });
    expect(seen[0].replayed).toBe(true); // second attempt is flagged a re-delivery
    expect(journal.pending("t")).toHaveLength(0); // handed off
    expect(journal.outstanding("t")).toHaveLength(1); // …but not acked, so kept

    journal.release(journal.outstanding("t")[0].token);
    expect(journal.pending("t")).toHaveLength(1); // handed back → replayable again
  });

  it("delivery stops at the first refusal so completions keep arrival order", () => {
    journal.openRun(PROMPT_A, { tabId: "t" });
    journal.openRun(PROMPT_B, { tabId: "t" });
    journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    journal.record("t", { kind: "executed", prompt_id: PROMPT_B });
    const seen: string[] = [];
    journal.deliverPending("t", (p) => {
      seen.push(String(p.prompt_id));
      return false;
    });
    expect(seen).toEqual([PROMPT_A]);
  });

  it("moveKey MERGES pending entries onto the destination without losing either side (#884)", () => {
    // #884 retired the tab-id-migration collision purge (destinationHasCollisionState):
    // the conversation is orchestrator-scoped, so a same-socket re-hello MOVES the
    // journals onto the new tab id — a render finishing after a workflow switch
    // still reaches the one shared conversation that queued it. What must hold now
    // is that moveKey merges without dropping entries on either key.
    journal.record("wf:dest", { kind: "executed", prompt_id: PROMPT_B });
    journal.record("wf:src", { kind: "executed", prompt_id: PROMPT_A });
    journal.moveKey("wf:src", "wf:dest");
    expect(journal.outstanding("wf:src")).toHaveLength(0);
    expect(journal.outstanding("wf:dest")).toHaveLength(2);
    // forget() (no orchestrator call sites since #884) still purges when called.
    journal.forget("wf:dest");
    expect(journal.outstanding("wf:dest")).toHaveLength(0);
  });

  it("an identical ID-LESS completion is NEVER merged — it gets its own entry, flagged", () => {
    // For an id-less completion "a twin nobody has seen yet" is not
    // establishable: there is no id, and ComfyUI reuses temp output names, so
    // same-tab/same-content/both-pending is exactly the state two genuinely
    // different renders present. Merging there would delete one of them. So the
    // collapse is gone entirely — the last surviving suppression.
    const payload = { kind: "executed", images: [{ filename: "mystery_0001.png" }] };
    const first = journal.record("t", { ...payload });
    expect(first.possibleRepeat).toBeUndefined(); // nothing preceded it

    const second = journal.record("t", { ...payload });
    expect(second.token).not.toBe(first.token); // its OWN entry
    expect(second.possibleRepeat).toBe(true); // …flagged, so it isn't double-counted
    expect(journal.pending("t")).toHaveLength(2);

    // Both reach the agent, and the second says so.
    const seen: CompletionPayload[] = [];
    journal.deliverPending("t", (p) => {
      seen.push(p);
      return true;
    });
    expect(seen).toHaveLength(2);
    expect(seen[0].possible_repeat).toBeUndefined();
    expect(seen[1].possible_repeat).toBe(true);

    // A DIFFERENT id-less render is its own entry, and NOT flagged.
    const other = journal.record("t", { kind: "executed", images: [{ filename: "other_0002.png" }] });
    expect(other.possibleRepeat).toBeUndefined();
  });

  it("an ID-LESS twin is NEVER merged into an entry that is already handed off", () => {
    // The collapse is only safe while BOTH copies are undelivered. A
    // `handed_off` entry is sitting unread in a busy agent's queue and will be
    // acked when its turn ends — merging a second real render into it would
    // delete the second render outright, with no flag. That is a silent swallow,
    // the exact hazard the design splits to avoid.
    const payload = { kind: "executed", images: [{ filename: "ComfyUI_temp_00001_.png" }] };
    const first = journal.record("t", { ...payload });
    journal.deliverPending("t", () => true); // handed off, still unread + unacked
    expect(journal.pending("t")).toHaveLength(0);

    const second = journal.record("t", { ...payload });
    expect(second).not.toBeNull();
    expect(second!.token).not.toBe(first!.token); // its OWN entry
    expect(second!.possibleRepeat).toBe(true); // …and flagged
    expect(journal.pending("t")).toHaveLength(1);

    // Acking the first must not take the second with it.
    journal.ack(first!.token);
    expect(journal.outstanding("t")).toHaveLength(1);
  });

  it("an ID-LESS completion matching an ALREADY-DELIVERED one is FLAGGED, never swallowed", () => {
    // Identical content is not proof of identity — ComfyUI reuses temp output
    // names across a restart — so suppressing here could silently lose a second
    // real render. Deliver it, flagged, and let the agent decide.
    const payload = { kind: "executed", images: [{ filename: "ComfyUI_temp_00001_.png" }] };
    const first = journal.record("t", { ...payload });
    journal.deliverPending("t", () => true);
    journal.ack(first!.token);

    const again = journal.record("t", { ...payload });
    expect(again).not.toBeNull(); // NOT swallowed
    expect(again!.possibleRepeat).toBe(true);
    const seen: CompletionPayload[] = [];
    journal.deliverPending("t", (p) => {
      seen.push(p);
      return true;
    });
    expect(seen[0].possible_repeat).toBe(true);
    expect(seen[0].run_correlation).toBe("unidentified");
  });

  it("the id-less content memo moves with a tab-id migration", () => {
    const payload = { kind: "executed", images: [{ filename: "idless.png" }] };
    const entry = journal.record("tmp:draft", { ...payload });
    journal.deliverPending("tmp:draft", () => true);
    journal.ack(entry!.token);
    journal.moveKey("tmp:draft", "wf:saved.json");
    const again = journal.record("wf:saved.json", { ...payload });
    expect(again!.possibleRepeat).toBe(true); // the memo followed the tab
  });

  it("teardown hand-backs are UNBOUNDED — only turns that ran count toward the settle bound", () => {
    // A completion queued behind a busy turn can survive several ordinary
    // provider/session replacements before anything drains that queue. Those
    // hand-backs must never settle it: nobody read it.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const entry = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    for (let i = 0; i < 10; i++) {
      journal.deliverPending("t", () => true);
      journal.release(entry!.token); // teardown: uncarried
    }
    expect(journal.outstanding("t")).toHaveLength(1);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(false);

    // A turn that RAN and ended without a provable ack is the cycle that IS
    // bounded — three of those settle it rather than replay forever.
    for (let i = 0; i < 3; i++) {
      journal.deliverPending("t", () => true);
      journal.release(entry!.token, { carried: true });
    }
    expect(journal.outstanding("t")).toHaveLength(0);
  });

  it("moveKey carries the delivered memo and the eviction counter, not just the entries", () => {
    // A tmp: → wf: save/rename migration must move ALL per-tab state, or a
    // post-migration re-send is delivered twice and an eviction disclosure is
    // silently dropped.
    journal.openRun(PROMPT_A, { tabId: "tmp:draft" });
    const entry = journal.record("tmp:draft", { kind: "executed", prompt_id: PROMPT_A });
    journal.deliverPending("tmp:draft", () => true);
    journal.ack(entry!.token);
    for (let i = 0; i < 40; i++) journal.record("tmp:draft", { kind: "executed", prompt_id: `d-${i}` });
    const lost = journal.droppedFor("tmp:draft");
    expect(lost).toBeGreaterThan(0);

    journal.moveKey("tmp:draft", "wf:saved.json");
    expect(journal.droppedFor("wf:saved.json")).toBe(lost);
    expect(journal.droppedFor("tmp:draft")).toBe(0);
    // The re-send is still RECOGNISED under the NEW id (flagged, not suppressed).
    expect(
      journal.record("wf:saved.json", { kind: "executed", prompt_id: PROMPT_A }).possibleRepeat,
    ).toBe(true);
  });

  it("moveKey re-addresses a tab's entries without touching anyone else's", () => {
    journal.openRun(PROMPT_A, { tabId: "old" });
    journal.record("old", { kind: "executed", prompt_id: PROMPT_A });
    journal.record("other", { kind: "executed", prompt_id: PROMPT_B });
    journal.moveKey("old", "new");
    expect(journal.pending("old")).toHaveLength(0);
    expect(journal.pending("new")).toHaveLength(1);
    expect(journal.pending("other")).toHaveLength(1);
  });

  it("forget drops a gone tab's entries and leaves other tabs alone", () => {
    journal.record("gone", { kind: "executed", prompt_id: PROMPT_A });
    journal.record("kept", { kind: "executed", prompt_id: PROMPT_B });
    journal.forget("gone");
    expect(journal.outstanding("gone")).toHaveLength(0);
    expect(journal.outstanding("kept")).toHaveLength(1);
  });
});

// #486 — a `panel_ask` answer goes back to the model as a TOOL RESULT, so it has
// no hand-off to ack. It rides the turn its tool call is running inside, and is
// acked by exactly the same rule a run completion is: that turn produced its own
// marked result. "Written to the transport" is NOT that rule — a `tools/call` can
// be abandoned, which is the whole of #486 — so these tests drive a real manager
// and hold the difference.
describe("panel_ask answer acks on the turn that returned it (#486)", () => {
  function askHarness(backend: AgentBackend) {
    const journal = new AskAnswerJournalImpl();
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "claude-test",
      onSay: () => {},
      onTurn: () => {},
      makeBackend: () => backend,
      onEventDelivered: (_key: string, tokens: string[], from?: { carrier?: string }) => {
        for (const t of tokens) journal.ack(t, from);
      },
      onEventUndelivered: (_key: string, tokens: string[], opts?: { carried?: boolean }) => {
        for (const t of tokens) journal.release(t, { carried: opts?.carried === true });
      },
      onAgentReady: () => {},
    } as never);
    journal.setTurnAttacher((key, token) => manager.attachTurnToken(key, token));
    return { journal, manager };
  }

  /** What the ask handler does from inside a live turn. */
  function answerDuringTurn(
    journal: AskAnswerJournalImpl,
    tab: string,
    askId: string,
    answer: string,
  ): string {
    journal.openAsk(askId, { tabId: tab, fingerprint: "fp-sampler", question: "Which sampler?" });
    const token = journal.record(askId, answer, { tabId: tab }).token;
    journal.markReturned(token); // hands it back AND rides the turn
    journal.closeAsk(askId);
    return token;
  }

  it("acks only when the turn that returned the answer produces its result", async () => {
    const backend = new ContinuationBackend();
    const { journal, manager } = askHarness(backend);
    const tab = "tab-ask-ack";

    manager.send(tab, "ask me which sampler");
    await waitFor(() => backend.turns.length >= 1);

    const token = answerDuringTurn(journal, tab, "pa-ack-1", "dpmpp_2m");
    // Handed to the tool result — but the turn has not finished, so there is NO
    // proof the model read it yet.
    expect(journal.entriesFor(tab)[0].returned).toBe(true);
    expect(journal.entriesFor(tab)[0].acked).toBeUndefined();

    backend.finishTurn(); // the turn's own marked result lands
    await waitFor(() => journal.entriesFor(tab)[0]?.acked === true);
    expect(journal.entriesFor(tab)[0].token).toBe(token);
    // An acked answer is not news: it holds no gate and is not named on exit.
    expect(journal.hasOutstanding()).toBe(false);
    expect(journal.allOutstanding()).toHaveLength(0);
  });

  it("a turn that never completes leaves the answer UNACKED and accounted for", async () => {
    const backend = new ContinuationBackend();
    backend.strandTurns = true; // the turn never yields a result — the #486 shape
    const { journal, manager } = askHarness(backend);
    const tab = "tab-ask-stranded";

    manager.send(tab, "ask me which sampler");
    await waitFor(() => backend.turns.length >= 1);
    answerDuringTurn(journal, tab, "pa-ack-2", "dpmpp_2m");

    // Tear the agent down mid-turn: the token comes back unacked.
    manager.reset(tab);
    await waitFor(() => journal.entriesFor(tab).length === 1);
    expect(journal.entriesFor(tab)[0].acked).toBeUndefined();
    // …and it is still the only copy of the user's decision: named on the way out
    // and still recoverable by a re-ask of the same question.
    expect(journal.allOutstanding().map((e) => e.answer)).toContain("dpmpp_2m");
    expect(journal.recover(tab, "fp-sampler").status).toBe("recovered");
  });

  it("an answer returned with NO live turn is never treated as read", () => {
    const backend = new ContinuationBackend();
    const { journal, manager } = askHarness(backend);
    const tab = "tab-ask-noturn";
    // Nothing was ever sent, so there is no turn to ride.
    expect(manager.attachTurnToken(tab, "aa-nope")).toBeNull();
    answerDuringTurn(journal, tab, "pa-ack-3", "dpmpp_2m");
    const entry = journal.entriesFor(tab)[0];
    expect(entry.carrier).toBeNull();
    expect(entry.acked).toBeUndefined();
    // …and nothing can ever settle it, however the ack is dressed up.
    journal.ack(entry.token, { carrier: "pa1" });
    journal.ack(entry.token);
    expect(journal.entriesFor(tab)[0].acked).toBeUndefined();
  });

  // COORDINATOR GATE P0-2. The tab -> agent mapping MOVES on a provider switch,
  // so an ack resolved from "whoever owns this tab now" let the NEW provider's
  // turn certify an answer the new conversation never saw — after which the
  // entry was acked and therefore silently evictable. The carrier identity is
  // captured at the instant of return and compared at ack, so it cannot.
  it("a provider switch cannot ack an answer handed to the previous conversation", async () => {
    const backend = new ContinuationBackend();
    const { journal, manager } = askHarness(backend);
    const tab = "tab-ask-switch";

    // The card is shown and answered inside provider A's turn.
    manager.send(tab, "ask me which sampler");
    await waitFor(() => backend.turns.length >= 1);
    const token = answerDuringTurn(journal, tab, "pa-switch", "dpmpp_2m");
    const carrierA = journal.entriesFor(tab)[0].carrier;
    expect(carrierA).not.toBeNull();

    // The user switches provider: the old agent is retired and the SAME tab key
    // is taken over by a brand-new agent instance.
    journal.closeAsks(tab); // what the switch path does
    manager.reset(tab);
    manager.send(tab, "different provider now");
    await waitFor(() => backend.turns.length >= 2);
    const carrierB = manager.attachTurnToken(tab, "aa-probe");
    expect(carrierB).not.toBe(carrierA);

    // The NEW conversation's turn completes. It must not settle the old
    // conversation's answer.
    backend.finishTurn();
    await new Promise((r) => setTimeout(r, 50));
    const entry = journal.entriesFor(tab).find((e) => e.token === token);
    expect(entry?.acked).toBeUndefined();
    // …so the answer is still accounted for: named on the way out, and never a
    // candidate for a silent eviction.
    expect(journal.allOutstanding().map((e) => e.answer)).toContain("dpmpp_2m");
  });

  // The sharper shape of the same defect: a STALE pre-switch ask handler resumes
  // AFTER the switch (its card was clicked late) and hands the answer back. It
  // would otherwise attach to whatever turn is running now — the new
  // conversation's — whose result then certifies, accurately and uselessly, an
  // answer that conversation was never shown.
  it("a stale handler resuming after a switch cannot attach to the new conversation's turn", async () => {
    const backend = new ContinuationBackend();
    const { journal, manager } = askHarness(backend);
    const tab = "tab-ask-stale";

    manager.send(tab, "ask me which sampler");
    await waitFor(() => backend.turns.length >= 1);
    journal.openAsk("pa-stale", {
      tabId: tab,
      fingerprint: "fp-sampler",
      question: "Which sampler?",
    });
    const token = journal.record("pa-stale", "dpmpp_2m", { tabId: tab }).token;

    // Provider switch happens BEFORE the handler gets to return.
    journal.closeAsks(tab);
    manager.reset(tab);
    manager.send(tab, "different provider now");
    await waitFor(() => backend.turns.length >= 2);

    // …and only now does the stale handler resume and hand the answer back.
    journal.markReturned(token);
    expect(journal.entriesFor(tab)[0].carrier).toBeNull();

    backend.finishTurn();
    await new Promise((r) => setTimeout(r, 50));
    expect(journal.entriesFor(tab)[0].acked).toBeUndefined();
    expect(journal.allOutstanding().map((e) => e.answer)).toContain("dpmpp_2m");
  });

  it("an ack from a DIFFERENT agent instance is refused", () => {
    const backend = new ContinuationBackend();
    const { journal } = askHarness(backend);
    const tab = "tab-ask-wrongcarrier";
    journal.setTurnAttacher(() => "pa-agent-A");
    journal.openAsk("pa-x", { tabId: tab, fingerprint: "fp", question: "Which sampler?" });
    const token = journal.record("pa-x", "dpmpp_2m", { tabId: tab }).token;
    journal.markReturned(token);
    expect(journal.entriesFor(tab)[0].carrier).toBe("pa-agent-A");

    journal.ack(token, { carrier: "pa-agent-B" }); // a different conversation
    expect(journal.entriesFor(tab)[0].acked).toBeUndefined();
    journal.ack(token); // …and an ack with no identity at all is unverifiable
    expect(journal.entriesFor(tab)[0].acked).toBeUndefined();

    journal.ack(token, { carrier: "pa-agent-A" }); // the one that carried it
    expect(journal.entriesFor(tab)[0].acked).toBe(true);
  });

  // P1-1: a RECOVERY hands the answer to a live turn exactly as a fresh answer
  // does, so it must attach by construction. It used to set the flags by hand and
  // never attach — so a perfect recovery stayed unacked forever, aged into
  // apparent loss, and eventually raised warnings despite successful receipt.
  it("a recovered answer attaches to its turn and can be acked", async () => {
    const backend = new ContinuationBackend();
    const { journal, manager } = askHarness(backend);
    const tab = "tab-ask-recover";

    manager.send(tab, "ask me which sampler");
    await waitFor(() => backend.turns.length >= 1);
    // An answer arrives with no handler waiting (the #486 orphan).
    journal.openAsk("pa-rec", { tabId: tab, fingerprint: "fp-sampler", question: "Which sampler?" });
    journal.closeAsk("pa-rec");
    const token = journal.record("pa-rec", "dpmpp_2m", { tabId: tab }).token;
    // A re-ask recovers it and hands it back inside the live turn.
    const rec = journal.recover(tab, "fp-sampler");
    expect(rec.status).toBe("recovered");
    journal.markSurfaced(token);
    expect(journal.entriesFor(tab)[0].carrier).not.toBeNull();

    backend.finishTurn();
    await waitFor(() => journal.entriesFor(tab)[0]?.acked === true);
    // Proven read → not news, and quietly forgettable.
    expect(journal.allOutstanding()).toHaveLength(0);
  });
});
