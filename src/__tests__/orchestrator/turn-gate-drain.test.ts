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
 * Two properties make this a DETERMINISTIC guard (no wall-clock sleeps gate the
 * ordering, so CI jitter can't make the assertion vacuous):
 *
 *  • READ-AHEAD: as soon as a turn is read the pump starts reading the NEXT turn
 *    (`it.next()`) WITHOUT awaiting it before emitting the current turn's result —
 *    so the panel channel is parked inside the pump's pending `channel.next()`
 *    (i.e. at the turn gate) while the current turn is "in flight". If a future
 *    change reintroduces a read-ahead/gate deadlock, that pending read never
 *    resolves, the next turn never starts, and the test FAILS (times out).
 *
 *  • MANUAL RELEASE: each turn's terminal `result` is withheld until the test
 *    calls `releaseTurn()`. So the test can prove a message was queued DURING the
 *    turn (before its result) rather than racing a timer. `markStarted` lets the
 *    test await "turn N has been read by the pump" deterministically.
 */
class ConcurrentPumpBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  turns: string[] = [];
  interrupted = 0;
  /** One resolver per in-flight turn, FIFO — resolved by `releaseTurn()` to emit
   *  that turn's `result`. */
  private releaseResolvers: Array<() => void> = [];
  /** How many turns the pump has READ so far (in flight), + waiters for a count. */
  private startedCount = 0;
  private startedWaiters: Array<{ n: number; resolve: () => void }> = [];

  private markStarted(): void {
    this.startedCount += 1;
    this.startedWaiters = this.startedWaiters.filter((w) => {
      if (this.startedCount >= w.n) {
        w.resolve();
        return false;
      }
      return true;
    });
  }

  /** Resolve once the pump has READ at least `n` turns (each is then in flight,
   *  with its result withheld). Rejects after `timeoutMs` so a reintroduced gate
   *  deadlock — where the next turn never starts — fails the test fast instead of
   *  hanging. No sleeps gate the happy path; the timeout is only a failure cap. */
  waitStarted(n: number, timeoutMs = 2000): Promise<void> {
    if (this.startedCount >= n) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`turn ${n} never started (gate did not drain) — ${this.turns.length} read`)),
        timeoutMs,
      );
      this.startedWaiters.push({
        n,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  /** Release the OLDEST in-flight turn so its `result` is emitted (opens the gate). */
  releaseTurn(): void {
    this.releaseResolvers.shift()?.();
  }

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    const out: AgentEvent[] = [];
    let wakeOut: (() => void) | null = null;
    let inputDone = false;
    const emit = (ev: AgentEvent) => {
      out.push(ev);
      wakeOut?.();
      wakeOut = null;
    };

    // INPUT PUMP — concurrent, read-ahead, manual per-turn result release.
    const pump = (async () => {
      const it = opts.channel[Symbol.asyncIterator]();
      let r = await it.next(); // read turn 1
      while (!r.done) {
        this.turns.push(r.value.text);
        emit({ type: "assistant", text: `reply to: ${r.value.text}` });
        // DECOUPLED read-ahead: begin reading the NEXT turn now, concurrently,
        // WITHOUT awaiting it before this turn's result (mirrors the SDK, whose
        // input pump and output reader are independent). This parks the panel
        // channel at the turn gate while the current turn is in flight.
        const readAhead = it.next();
        // Withhold this turn's result until the test releases it.
        await new Promise<void>((resolve) => {
          this.releaseResolvers.push(resolve);
          this.markStarted();
        });
        emit({ type: "result", ok: true, subtype: "success" });
        // Consume the read-ahead: resolves only once the gate opened and the next
        // batch drained (or the channel closed on stop()).
        r = await readAhead;
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
    // Release every still-held turn so the pump unblocks and the run loop can wind
    // down (used by agent.stop() teardown — otherwise the pump parks forever).
    const held = this.releaseResolvers;
    this.releaseResolvers = [];
    for (const r of held) r();
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

describe("turn gate drains the next queued batch when a turn ends (no read-ahead deadlock)", () => {
  it("delivers a message queued during turn N right after N's result — with NO later message arriving", async () => {
    const turns: Array<"working" | "done"> = [];
    const backend = new ConcurrentPumpBackend();
    const agent = new PanelAgent("tab-drain", makeDeps(turns) as never, backend);
    void agent.start();

    // Turn 1 starts and is held in flight (its result withheld).
    agent.send("first message");
    await backend.waitStarted(1);
    expect(backend.turns).toEqual(["first message"]);
    expect(agent.isBusy).toBe(true);

    // PROVABLY queued DURING turn 1: turn 1's result has not been emitted yet
    // (we haven't released it), so this message lands behind the gate. Nothing
    // else is ever sent afterwards.
    agent.send("second message queued behind the first");

    // End turn 1. The invariant: the gate opens and turn 2 is delivered, with no
    // dependency on any further user message. (If the gate deadlocks, turn 2 never
    // starts and waitStarted(2) rejects → test fails.)
    backend.releaseTurn();
    await backend.waitStarted(2);
    expect(backend.turns[1]).toContain("second message");

    await agent.stop();
  });

  it("drains several messages queued behind one busy turn, in order", async () => {
    const turns: Array<"working" | "done"> = [];
    const backend = new ConcurrentPumpBackend();
    const agent = new PanelAgent("tab-drain2", makeDeps(turns) as never, backend);
    void agent.start();

    agent.send("A");
    await backend.waitStarted(1);
    // Queue B and C while A is held in flight; they must batch into the next turn.
    agent.send("B");
    agent.send("C");

    backend.releaseTurn(); // end turn A
    await backend.waitStarted(2);
    expect(backend.turns[1]).toContain("B");
    expect(backend.turns[1]).toContain("C");

    await agent.stop();
  });
});
