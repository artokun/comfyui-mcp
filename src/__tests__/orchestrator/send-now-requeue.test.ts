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
 * Each turn HANGS (emits a session then waits) until `interrupt()` is called,
 * which ends the in-flight run iteration and lets the channel release the next
 * batch — mirroring how a real interrupt breaks the live stream. After interrupt
 * the generator's for-await resumes and pulls the next turn.
 */
class RecordingBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  /** Text of each turn the backend saw, in order. */
  turns: string[] = [];
  interrupted = 0;
  /** Resolver for the currently-hanging turn (called by interrupt()). */
  private breakTurn: (() => void) | null = null;
  /** When true a turn completes cleanly (emits result) instead of hanging. */
  autoComplete = false;

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: "sess-rec" };
    for await (const turn of opts.channel) {
      this.turns.push(turn.text);
      if (this.autoComplete) {
        // Clean completion → terminal result, no hang.
        yield { type: "result", ok: true, subtype: "success" };
        continue;
      }
      // Hang until interrupt() breaks us (the in-flight turn the user "stops").
      await new Promise<void>((resolve) => {
        this.breakTurn = resolve;
      });
      this.breakTurn = null;
    }
  }

  async interrupt(): Promise<void> {
    this.interrupted += 1;
    const brk = this.breakTurn;
    this.breakTurn = null;
    brk?.();
  }

  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

function makeDeps() {
  return {
    mcpServers: {},
    systemAppend: "",
    model: "claude-test",
    onSay: () => {},
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

    // The next turn must combine BOTH, interrupted-first.
    await waitFor(() => backend.turns.length === 2);
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
