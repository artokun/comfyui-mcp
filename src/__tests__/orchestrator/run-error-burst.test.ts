// #1489 — a cancelled 27-scene batch flooded every following turn with a GROWING block of
// "could not be confirmed after reconnecting" errors: turn N carried prompts 1..N, turn
// N+1 carried 1..N+1, reproducing ~25 messages dozens of times and dragging the user's
// original message along at the bottom.
//
// The report calls this "not deduplicated". It is not a dedupe problem — each notice names
// a different prompt id, so all N texts are distinct and nothing would dedupe. The cause is
// mechanical: `injectRunError` interrupted the in-flight turn with `requeueInFlight: true`,
// which re-queues that turn, and after the FIRST error the interrupted turn is itself an
// error turn. So error N re-queued errors 1..N-1 and the drain batched them.
//
// Measured against this exact harness before the fix: 419 → 827 → 1237 chars for three
// prompts, the last carrying all three plus the user's message.
import { describe, expect, it } from "vitest";
import { PanelAgent } from "../../orchestrator/panel-agent.js";
import type {
  AgentBackend,
  AgentCapabilities,
  AgentEvent,
  BackendStartOptions,
  NeutralTurn,
} from "../../orchestrator/agent-backend.js";

const CAPS: AgentCapabilities = {
  persistentChannel: true,
  streamingDeltas: true,
  interruptMidTurn: true,
  forkAtAnchor: false,
  inProcessMcp: false,
  modelEnumeration: false,
  slashCommands: false,
  hooks: false,
  vision: true,
  turnMarkers: true,
};

/**
 * A backend that takes a turn and HOLDS it, so the agent is genuinely `inFlight` when the
 * next error lands — the precondition for the requeue path this bug lives on. Each held
 * turn is released only when the test says so.
 */
function holdingBackend() {
  const seen: NeutralTurn[] = [];
  let release: (() => void) | null = null;
  const backend: AgentBackend = {
    id: "claude" as AgentBackend["id"],
    capabilities: CAPS,
    async *run(opts: BackendStartOptions): AsyncIterable<AgentEvent> {
      yield { type: "session", sessionId: "s1" };
      for await (const turn of opts.channel) {
        seen.push(turn);
        await new Promise<void>((r) => {
          release = r;
        });
        yield { type: "result", ok: true, turn: seen.length };
      }
    },
    async interrupt() {
      release?.();
      release = null;
    },
    async listModels() {
      return [];
    },
  };
  return { backend, seen, releaseNow: () => { release?.(); release = null; } };
}

const textOf = (t: NeutralTurn): string =>
  typeof (t as { text?: unknown }).text === "string" ? (t as { text: string }).text : JSON.stringify(t);

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("a BURST of run_errors coalesces instead of nesting (#1489)", () => {
  it("delivers each cancelled prompt ONCE, with no cumulative growth", async () => {
    const { backend, seen, releaseNow } = holdingBackend();
    const agent = new PanelAgent(
      "tab1",
      { mcpServers: undefined, systemAppend: "", model: "m", onSay: () => {} },
      backend,
    );
    const running = agent.start();

    // A normal user turn first — this is the reporter's shape, and it is why their older
    // prompt text kept reappearing: the original turn sits at the bottom of the re-queue
    // stack that each interrupt rebuilt.
    agent.send("USER_PROMPT");
    await settle();

    // Three cleared prompts land in quick succession, as they do when a cancelled batch is
    // reconciled after a reconnect.
    await agent.injectRunError("PROMPT_ONE could not be confirmed");
    await settle();
    await agent.injectRunError("PROMPT_TWO could not be confirmed");
    await settle();
    await agent.injectRunError("PROMPT_THREE could not be confirmed");
    await settle();

    // Drain: let each held turn finish so everything queued is actually delivered.
    for (let i = 0; i < 6; i++) {
      releaseNow();
      await settle();
    }
    void running;
    await agent.stop().catch(() => {});

    const texts = seen.map(textOf);
    const all = texts.join("\n---\n");

    // EVERY prompt still reaches the agent exactly once. Coalescing must not lose an
    // error — a swallowed failure is a far worse bug than a noisy one.
    expect(countOf(all, "PROMPT_ONE")).toBe(1);
    expect(countOf(all, "PROMPT_TWO")).toBe(1);
    expect(countOf(all, "PROMPT_THREE")).toBe(1);

    // And NO turn carries more than one of them twice over — the growth is gone. Before
    // the fix the final turn carried all three; now the later two share a single turn and
    // nothing is repeated across turns.
    const carryingAll = texts.filter(
      (t) => t.includes("PROMPT_ONE") && t.includes("PROMPT_TWO") && t.includes("PROMPT_THREE"),
    );
    expect(carryingAll).toHaveLength(0);

    // The user's own message is not re-sent alongside the errors on every turn.
    expect(countOf(all, "USER_PROMPT")).toBeLessThanOrEqual(2);
  });

  it("a SINGLE error still interrupts a user turn — the urgent path is unchanged", async () => {
    // The behaviour worth keeping: one error arriving during ordinary work stops that work
    // so the agent addresses it. Only a BURST is coalesced.
    const { backend, seen, releaseNow } = holdingBackend();
    const agent = new PanelAgent(
      "tab1",
      { mcpServers: undefined, systemAppend: "", model: "m", onSay: () => {} },
      backend,
    );
    const running = agent.start();

    agent.send("USER_PROMPT");
    await settle();
    await agent.injectRunError("ONLY_PROMPT could not be confirmed");
    await settle();

    // The error turn was dispatched ahead of the user's work rather than waiting for it.
    const texts = seen.map(textOf);
    expect(texts.some((t) => t.includes("ONLY_PROMPT"))).toBe(true);

    releaseNow();
    await settle();
    void running;
    await agent.stop().catch(() => {});
  });
});
