// Focused tests for SEND-NOW re-queue: when the panel interrupts a turn mid-reply
// and immediately sends a new message ("send now"), the agent must address BOTH
// the interrupted message AND the new one — the interrupted text must NOT be
// dropped. A normal (non-interrupt) turn must be unaffected, and a clean turn
// completion must never re-queue.

import { describe, expect, it, beforeAll } from "vitest";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";

let PanelAgent: typeof import("../../orchestrator/panel-agent.js").PanelAgent;

beforeAll(async () => {
  ({ PanelAgent } = await import("../../orchestrator/panel-agent.js"));
});

/**
 * A backend that records the text of every turn it receives from the channel.
 * Each turn HANGS (emits a session then waits) until `interrupt()` is called.
 * On interrupt the aborted turn emits a terminal `result` event — mirroring how
 * the real Claude SDK emits a result message for an interrupted turn — which is
 * what releases the turn gate (via completeTurn) at the right moment. The
 * for-await then pulls the next (re-queued) batch.
 */
class RecordingBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  /** Text of each turn the backend saw, in order. */
  turns: string[] = [];
  interrupted = 0;
  /** Resolver for the currently-hanging turn (called by interrupt()). */
  private breakTurn: (() => void) | null = null;
  /** Set by interrupt() so the resumed turn knows to emit an interrupted result
   *  (rather than a stop/teardown, where we just exit). */
  private brokenByInterrupt = false;
  /** When true a turn completes cleanly (emits result) instead of hanging. */
  autoComplete = false;
  /** Subtype for autoComplete results — lets a test simulate a REAL failed turn
   *  (error subtype without any interrupt). */
  completeSubtype = "success";

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: "sess-rec" };
    for await (const turn of opts.channel) {
      this.turns.push(turn.text);
      if (this.autoComplete) {
        // Completion → terminal result, no hang (subtype per completeSubtype).
        yield {
          type: "result",
          ok: this.completeSubtype === "success",
          subtype: this.completeSubtype,
        };
        continue;
      }
      // Hang until interrupt() breaks us (the in-flight turn the user "stops").
      await new Promise<void>((resolve) => {
        this.breakTurn = resolve;
      });
      this.breakTurn = null;
      if (this.brokenByInterrupt) {
        // The interrupted turn ends with a result (like the real SDK) — this is
        // the signal that releases the turn gate for the next batch. The real
        // Claude SDK reports an interrupted turn with an ERROR subtype
        // (error_during_execution), so mirror that: the panel must not paint it
        // as a turn failure.
        this.brokenByInterrupt = false;
        yield { type: "result", ok: false, subtype: "error_during_execution" };
      }
    }
  }

  async interrupt(): Promise<void> {
    this.interrupted += 1;
    const brk = this.breakTurn;
    this.breakTurn = null;
    if (brk) this.brokenByInterrupt = true;
    brk?.();
  }

  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

function makeDeps(says: string[] = []) {
  return {
    mcpServers: {},
    systemAppend: "",
    model: "claude-test",
    onSay: (_tab: string, text: string) => {
      says.push(text);
    },
    onTurn: () => {},
  };
}

/** Poll until `cond()` is true or the timeout elapses (no fixed sleeps). */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("send-now re-queues the interrupted message", () => {
  it("the next turn addresses BOTH the interrupted and the new message (interrupted-first)", async () => {
    const backend = new RecordingBackend();
    const agent = new PanelAgent("tab-sendnow", makeDeps() as never, backend);
    void agent.start();

    // First message starts a turn that hangs (the agent is mid-reply).
    agent.send("first message the agent is working on");
    await waitFor(() => backend.turns.length === 1);
    expect(backend.turns[0]).toContain("first message");

    // The user types a second message; it QUEUES while the turn is busy (this is
    // how the panel's pending tray works — "send now" acts on an already-queued msg).
    agent.send("urgent second message sent now");

    // Panel "send now" = interrupt the in-flight turn WITH requeueInFlight. The
    // interrupted message is re-queued at the FRONT, ahead of the already-queued
    // second message. (A plain Stop would NOT re-queue — see the test below.)
    await agent.interrupt({ requeueInFlight: true });

    // The next turn must combine BOTH, interrupted-first — and arrive PROMPTLY
    // (driven by the interrupted turn's result, not the slow release fallback or
    // the multi-minute idle watchdog). 500ms guards against regressing to either.
    await waitFor(() => backend.turns.length === 2, 500);
    const second = backend.turns[1];
    expect(second).toContain("first message"); // interrupted message NOT dropped
    expect(second).toContain("urgent second message"); // new message included
    expect(second.indexOf("first message")).toBeLessThan(
      second.indexOf("urgent second message"),
    );

    await agent.stop();
  });

  it("a plain Stop/interrupt does NOT re-queue the in-flight turn (no double-run)", async () => {
    // The P1: a bare interrupt (Stop / Ctrl+C / Esc — no requeueInFlight) must NOT
    // re-queue the turn the user just stopped, or it would silently re-run it and
    // repeat its tool actions.
    const backend = new RecordingBackend();
    const agent = new PanelAgent("tab-stop", makeDeps() as never, backend);
    void agent.start();

    agent.send("message the user then STOPS");
    await waitFor(() => backend.turns.length === 1);

    await agent.interrupt(); // plain Stop — default requeueInFlight=false

    // Give any erroneous re-queued turn a chance to run; the stopped turn must NOT
    // be re-processed.
    await new Promise((r) => setTimeout(r, 150));
    expect(backend.turns).toHaveLength(1);

    await agent.stop();
  });

  it("a clean turn completion does NOT re-queue (no double-processing)", async () => {
    const backend = new RecordingBackend();
    backend.autoComplete = true; // turns complete cleanly (emit result)
    const agent = new PanelAgent("tab-clean", makeDeps() as never, backend);
    void agent.start();

    agent.send("only message");
    await waitFor(() => backend.turns.length === 1);

    // Interrupt AFTER the clean completion — there is no in-flight turn, so the
    // already-processed message must NOT be re-queued.
    await agent.interrupt();
    // Give any erroneous re-queued turn a chance to run.
    await new Promise((r) => setTimeout(r, 100));
    expect(backend.turns).toHaveLength(1);
    expect(backend.turns[0]).toContain("only message");

    await agent.stop();
  });

  it("a user interrupt does NOT paint the '⚠️ That turn failed' banner", async () => {
    // The real Claude SDK ends an interrupted turn with an error-subtype result
    // (error_during_execution). That is the INTERRUPT landing, not a failure —
    // the never-end-in-silence guard must stay quiet for it.
    const says: string[] = [];
    const backend = new RecordingBackend();
    const agent = new PanelAgent("tab-banner", makeDeps(says) as never, backend);
    void agent.start();

    agent.send("message the user send-nows past");
    await waitFor(() => backend.turns.length === 1);
    agent.send("the send-now message");
    await agent.interrupt({ requeueInFlight: true });
    await waitFor(() => backend.turns.length === 2, 500);

    expect(says.filter((s) => s.includes("That turn failed"))).toHaveLength(0);
    await agent.stop();
  });

  it("a REAL failed turn (no interrupt) still paints the failure banner", async () => {
    const says: string[] = [];
    const backend = new RecordingBackend();
    backend.autoComplete = true;
    backend.completeSubtype = "error_during_execution"; // genuine failure, no interrupt
    const agent = new PanelAgent("tab-realerr", makeDeps(says) as never, backend);
    void agent.start();

    agent.send("message whose turn genuinely fails");
    await waitFor(() => says.some((s) => s.includes("That turn failed")), 2000);

    await agent.stop();
  });

  it("a normal interrupt with nothing in flight does not invent a turn", async () => {
    const backend = new RecordingBackend();
    const agent = new PanelAgent("tab-idle", makeDeps() as never, backend);
    void agent.start();
    // Let the session init before interrupting (no message ever sent).
    await new Promise((r) => setTimeout(r, 50));

    await agent.interrupt(); // idle interrupt
    await new Promise((r) => setTimeout(r, 100));
    expect(backend.turns).toHaveLength(0);

    await agent.stop();
  });
});
