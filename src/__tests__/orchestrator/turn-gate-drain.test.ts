// Reproduction harness for the turn-gate "stuck after a turn ends" P1.
//
// Symptom: after a turn ACTUALLY finishes, the agent stays busy/"thinking"
// forever and NEVER drains the messages queued behind it — they sit PENDING and
// only the slow freeze watchdog eventually breaks the logjam. Send-now (interrupt)
// works; it's the NORMAL turn-end -> drain-next-queued path that's stuck.
//
// These fake backends model the REAL provider ordering where the agent runtime
// reads the channel AHEAD of finishing the current turn (the Claude Agent SDK's
// `streamInput` pump eagerly pulls the next user message while the current turn is
// still producing output). The assertion is the invariant the panel must hold:
//   a completed turn opens the gate and the next queued batch is delivered,
//   EVEN IF no further user message ever arrives.
//
// INVESTIGATION NOTE (2026-06): the hypothesized "read-ahead deadlock" (the SDK
// blocks on reading the next channel item before emitting turn N's `result`, while
// the gate blocks the read until N's result → circular hang) was NOT reproducible
// on the real backends:
//   • The Claude Agent SDK runs its input pump (`streamInput`) and output reader
//     (`readMessages`) as INDEPENDENT concurrent tasks, so turn N's `result` is
//     enqueued to the output stream regardless of the input pump being parked at
//     the gate (verified in node_modules/.../sdk.mjs).
//   • A LIVE probe against the real `claude` CLI confirmed it emits turn 1's
//     `result/success` with NO second user input ever sent — i.e. the result is
//     NOT withheld pending the next stdin line. So the gate cannot deadlock it.
//   • The Codex backend emits each turn's `result` (runTurn) BEFORE the outer
//     `for await (const turn of opts.channel)` reads the next turn — sequential,
//     not coupled.
// The gate deadlocks ONLY under a COUPLED model (a backend that awaits the next
// channel item before emitting the prior turn's result) — an ordering no current
// backend exhibits, and one whose fix is fundamentally incompatible with the
// send-now interrupt re-queue (which relies on the queue staying the source of
// truth until a turn completes). So this file is a GREEN REGRESSION GUARD for the
// drain invariant (it passes on current code), not a failing reproduction.

import { describe, expect, it, beforeAll } from "vitest";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";

// Keep the freeze watchdog FAR away so it can't mask a gate stall: the whole
// point is that the gate must drain WITHOUT the watchdog's help.
process.env.COMFYUI_MCP_TURN_IDLE_MS = String(60_000);

let PanelAgent: typeof import("../../orchestrator/panel-agent.js").PanelAgent;

beforeAll(async () => {
  ({ PanelAgent } = await import("../../orchestrator/panel-agent.js"));
});

/**
 * Faithful model of the Claude Agent SDK transport: an INPUT PUMP task drains the
 * channel concurrently (read-ahead) while OUTPUT (assistant/result events) is
 * produced on an independent queue — exactly how `streamInput` (input) and
 * `readMessages` (output) run as separate fire-and-forget tasks in the real SDK.
 *
 * Critically the pump reads the NEXT turn from the channel as soon as it has
 * written the current one (read-ahead), so when the current turn finishes the
 * channel is already parked inside the pump's pending `channel.next()`.
 */
class ConcurrentPumpBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  turns: string[] = [];
  interrupted = 0;
  private breakTurn: (() => void) | null = null;

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    const out: AgentEvent[] = [];
    let wakeOut: (() => void) | null = null;
    let inputDone = false;
    const emit = (ev: AgentEvent) => {
      out.push(ev);
      wakeOut?.();
      wakeOut = null;
    };

    // INPUT PUMP — concurrent, read-ahead. Mirrors SDK `streamInput`.
    const pump = (async () => {
      for await (const turn of opts.channel) {
        this.turns.push(turn.text);
        // The turn runs and finishes: emit its terminal events on the OUTPUT
        // queue, decoupled from this pump. Then the for-await immediately reads
        // the NEXT turn (read-ahead) — which parks at the panel's turn gate.
        emit({ type: "assistant", text: `reply to: ${turn.text}` });
        // Let the turn "hang" a tick so a second message can queue while busy,
        // then finish it. The result is what must open the gate.
        await new Promise<void>((resolve) => {
          this.breakTurn = resolve;
          setTimeout(resolve, 10);
        });
        this.breakTurn = null;
        emit({ type: "result", ok: true, subtype: "success" });
      }
      inputDone = true;
      wakeOut?.();
      wakeOut = null;
    })();

    emit({ type: "session", sessionId: "sess-pump" });
    try {
      while (!inputDone || out.length) {
        if (!out.length) {
          await new Promise<void>((resolve) => {
            wakeOut = resolve;
          });
          continue;
        }
        yield out.shift()!;
      }
    } finally {
      await pump.catch(() => {});
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

function makeDeps(turns: Array<"working" | "done">) {
  return {
    mcpServers: {},
    systemAppend: "",
    model: "claude-test",
    onSay: () => {},
    onTurn: (_tab: string, state: "working" | "done") => {
      turns.push(state);
    },
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("turn gate drains the next queued batch when a turn ends (no read-ahead deadlock)", () => {
  it("delivers a message queued during turn N right after N's result — with NO later message arriving", async () => {
    const turns: Array<"working" | "done"> = [];
    const backend = new ConcurrentPumpBackend();
    const agent = new PanelAgent("tab-drain", makeDeps(turns) as never, backend);
    void agent.start();

    // Turn 1 starts.
    agent.send("first message");
    await waitFor(() => backend.turns.length === 1);

    // While turn 1 is in flight, queue a second message. This is the message that
    // must drain when turn 1 ends — and NOTHING else is ever sent afterwards.
    agent.send("second message queued behind the first");

    // The invariant: turn 1 ends -> gate opens -> turn 2 is delivered promptly,
    // with no dependency on a further user message.
    await waitFor(() => backend.turns.length === 2, 1500);
    expect(backend.turns[1]).toContain("second message");

    await agent.stop();
  });

  it("drains several messages queued behind one busy turn, in order", async () => {
    const turns: Array<"working" | "done"> = [];
    const backend = new ConcurrentPumpBackend();
    const agent = new PanelAgent("tab-drain2", makeDeps(turns) as never, backend);
    void agent.start();

    agent.send("A");
    await waitFor(() => backend.turns.length === 1);
    // Queue B and C while A is busy; they should batch into the next turn.
    agent.send("B");
    agent.send("C");

    await waitFor(() => backend.turns.length === 2, 1500);
    expect(backend.turns[1]).toContain("B");
    expect(backend.turns[1]).toContain("C");

    await agent.stop();
  });
});
