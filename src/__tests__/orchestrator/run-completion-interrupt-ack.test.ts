// #2486 — a user interrupt of a turn that has ALREADY reached the model must
// not re-deliver that turn's run-completion.
//
// interrupt() used to steal the carrying tokens from the result path and hand
// them back uncarried. onEventUndelivered then flushed immediately, so the
// same prompt was re-injected as RE-DELIVERED on every following Stop — three
// extra "Acknowledge the result in ONE short sentence" turns in the report.
//
// The proof that the model has the text is the same one #468 already uses:
// turnProducedEvents, a stamped event on a marker-declaring backend. A Stop
// BEFORE that proof still replays (the abandoned-turn contract). A Stop AFTER
// it settles.

import { describe, expect, it } from "vitest";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";
import {
  RunCompletionJournalImpl,
  type CompletionPayload,
} from "../../orchestrator/run-completion-journal.js";
import { PanelAgentManager } from "../../orchestrator/panel-agent.js";

const TAB = "tab-2486";
const PID = "79cb9c62-aaaa-bbbb-cccc-ddddeeeeffff";
const REDELIVERED = "RE-DELIVERED — this completion could not be handed to you when it arrived";
const MATCHED = "This is the run YOU queued with panel_run";

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * A marker-declaring backend that can hang mid-reply.
 *
 * `emitReply: true` (default) yields a stamped assistant event as soon as it
 * consumes the turn — the production shape of "[Request interrupted by user]"
 * landing while the model is generating. `emitReply: false` hangs silent, which
 * is the pre-submission window the abandoned-turn replay must still cover.
 */
class MidReplyBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  turns: string[] = [];
  /** Set after the stamped assistant event has been yielded. */
  sawReply = false;
  emitReply: boolean;
  private breakTurn: (() => void) | null = null;
  private brokenByInterrupt = false;

  constructor(opts: { emitReply?: boolean } = {}) {
    this.emitReply = opts.emitReply !== false;
  }

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: "sess-2486" };
    let turnSeq = 0;
    for await (const turn of opts.channel) {
      this.turns.push((turn as { text?: string }).text ?? "");
      turnSeq += 1;
      this.sawReply = false;
      if (this.emitReply) {
        yield { type: "assistant", text: "looking…", turn: turnSeq };
        this.sawReply = true;
      }
      await new Promise<void>((resolve) => {
        this.breakTurn = resolve;
      });
      this.breakTurn = null;
      if (this.brokenByInterrupt) {
        this.brokenByInterrupt = false;
        yield { type: "result", ok: false, subtype: "error_during_execution", turn: turnSeq };
      } else {
        yield { type: "result", ok: true, subtype: "success", turn: turnSeq };
      }
    }
  }

  finishTurn(): void {
    const brk = this.breakTurn;
    this.breakTurn = null;
    brk?.();
  }

  async interrupt(): Promise<void> {
    this.brokenByInterrupt = true;
    this.finishTurn();
  }

  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

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
    onEventUndelivered: (key: string, tokens: string[], opts?: { carried?: boolean }) => {
      for (const t of tokens) journal.release(t, { carried: opts?.carried === true });
      flush(key);
    },
    onAgentReady: (key: string) => flush(key),
  } as never);
  const arrive = (tab: string, payload: CompletionPayload) => {
    journal.record(tab, payload);
    flush(tab);
  };
  return { journal, manager, arrive };
}

describe("run-completion interrupt after the model has the text (#2486)", () => {
  it("a mid-reply Stop settles the completion instead of re-delivering it", async () => {
    const backend = new MidReplyBackend();
    const { journal, manager, arrive } = makeHarness(backend);

    journal.openRun(PID, { tabId: TAB });
    manager.send(TAB, "queue the render");
    await waitFor(() => backend.sawReply);
    backend.finishTurn();

    arrive(TAB, {
      kind: "executed",
      prompt_id: PID,
      images: [{ filename: "ComfyUI_00149_.png" }],
    });
    await waitFor(() => backend.turns.length >= 2);
    await waitFor(() => backend.sawReply);
    expect(backend.turns[1]).toContain(MATCHED);
    expect(backend.turns[1]).toContain(PID);
    expect(journal.outstanding(TAB)).toHaveLength(1);

    // The reported sequence: user interrupts the acknowledgement turn.
    await manager.interrupt(TAB, { requeueInFlight: false });
    expect(journal.outstanding(TAB)).toHaveLength(0);
    expect(journal.ticketFor(PID)?.settled).toBe(true);

    manager.send(TAB, "do something else");
    await waitFor(() => backend.turns.length >= 3);
    expect(backend.turns[2]).toContain("do something else");
    expect(backend.turns[2]).not.toContain(REDELIVERED);
    expect(backend.turns[2]).not.toContain(PID);
  });

  it("repeated Stops after receipt do not mint a second acknowledgement turn", async () => {
    const backend = new MidReplyBackend();
    const { journal, manager, arrive } = makeHarness(backend);

    journal.openRun(PID, { tabId: TAB });
    manager.send(TAB, "go");
    await waitFor(() => backend.sawReply);
    backend.finishTurn();

    arrive(TAB, {
      kind: "executed",
      prompt_id: PID,
      images: [{ filename: "ComfyUI_00149_.png" }],
    });
    await waitFor(() => backend.turns.length >= 2);
    await waitFor(() => backend.sawReply);
    expect(backend.turns[1]).toContain(PID);
    expect(backend.turns[1]).not.toContain(REDELIVERED);

    await manager.interrupt(TAB, { requeueInFlight: false });
    manager.send(TAB, "first follow-up");
    await waitFor(() => backend.turns.length >= 3);
    await waitFor(() => backend.sawReply);

    await manager.interrupt(TAB, { requeueInFlight: false });
    manager.send(TAB, "second follow-up");
    await waitFor(() => backend.turns.length >= 4);

    expect(backend.turns.slice(2).every((t) => !t.includes(REDELIVERED))).toBe(true);
    expect(backend.turns.slice(2).every((t) => !t.includes(PID))).toBe(true);
    expect(journal.outstanding(TAB)).toHaveLength(0);
  });

  it("send-now after receipt requeues the user text, not the already-read completion", async () => {
    const backend = new MidReplyBackend();
    const { journal, manager, arrive } = makeHarness(backend);

    journal.openRun(PID, { tabId: TAB });
    manager.send(TAB, "keep going");
    await waitFor(() => backend.sawReply);

    arrive(TAB, {
      kind: "executed",
      prompt_id: PID,
      images: [{ filename: "ComfyUI_00149_.png" }],
    });
    manager.send(TAB, "and then upscale it");
    backend.finishTurn();
    await waitFor(() => backend.turns.length >= 2);
    await waitFor(() => backend.sawReply);
    expect(backend.turns[1]).toContain(PID);
    expect(backend.turns[1]).toContain("and then upscale it");

    manager.send(TAB, "wait, change the seed");
    await manager.interrupt(TAB, { requeueInFlight: true });
    await waitFor(() => backend.turns.length >= 3);

    const next = backend.turns[2];
    expect(next).toContain("and then upscale it");
    expect(next).toContain("wait, change the seed");
    expect(next).not.toContain(REDELIVERED);
    expect(next).not.toContain(PID);
    expect(journal.outstanding(TAB)).toHaveLength(0);
    expect(journal.ticketFor(PID)?.settled).toBe(true);
  });

  it("a Stop BEFORE the model receives the turn still replays (abandoned-turn contract)", async () => {
    const backend = new MidReplyBackend({ emitReply: false });
    const { journal, manager, arrive } = makeHarness(backend);

    journal.openRun(PID, { tabId: TAB });
    manager.send(TAB, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.finishTurn();

    arrive(TAB, {
      kind: "executed",
      prompt_id: PID,
      images: [{ filename: "kept_0001.png" }],
    });
    await waitFor(() => backend.turns.length >= 2);
    expect(backend.turns[1]).toContain("kept_0001.png");
    expect(backend.sawReply).toBe(false);

    await manager.interrupt(TAB, { requeueInFlight: false });
    await waitFor(() => backend.turns.length >= 3);
    expect(backend.turns[2]).toContain("kept_0001.png");
    expect(backend.turns[2]).toContain(REDELIVERED);
    expect(journal.outstanding(TAB)).toHaveLength(1);
    expect(journal.ticketFor(PID)?.settled).toBe(false);
  });
});
