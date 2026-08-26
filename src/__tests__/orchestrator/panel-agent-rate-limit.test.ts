// What the USER sees when a provider rate-limits their turn.
//
// `rate_limit` was declared on AgentEvent and consumed by nobody — claude-backend
// even carried a comment noting the panel never read them. So the only rate-limit
// signal that reached a user was whatever raw text a backend happened to throw,
// rendered through the generic "The <model> turn failed: <backend>: …" wrapper.
//
// These cases pin the two halves of the fix at the panel boundary: a wait is
// narrated once and does NOT end the turn, and a rate limit that could not be
// waited out is rendered as its own sentence instead of being buried under
// prefixes that name the adapter rather than the limit.

import { describe, expect, it } from "vitest";
import { PanelAgent } from "../../orchestrator/panel-agent.js";
import type {
  AgentBackend,
  AgentCapabilities,
  AgentEvent,
  BackendStartOptions,
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

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

/** A backend that replays a fixed script of events for each turn it receives. */
function scriptedBackend(script: (turnNo: number) => AgentEvent[]) {
  let turns = 0;
  const backend: AgentBackend = {
    id: "claude" as AgentBackend["id"],
    capabilities: CAPS,
    async *run(opts: BackendStartOptions): AsyncIterable<AgentEvent> {
      yield { type: "session", sessionId: "s1" };
      for await (const _turn of opts.channel) {
        turns += 1;
        for (const ev of script(turns)) yield { ...ev, turn: turns };
      }
    },
    async interrupt() {},
    async listModels() {
      return [];
    },
  };
  return backend;
}

async function saidDuring(script: (turnNo: number) => AgentEvent[]): Promise<string[]> {
  const said: string[] = [];
  const agent = new PanelAgent(
    "tab1",
    { mcpServers: undefined, systemAppend: "", model: "kimi-k3", onSay: (_tab, text) => said.push(text) },
    scriptedBackend(script),
  );
  const running = agent.start();
  agent.send("hello");
  await settle();
  void running;
  await agent.stop().catch(() => {});
  return said;
}

describe("a rate-limit WAIT is narrated, not mourned", () => {
  it("shows the backend's line and lets the turn finish normally", async () => {
    const said = await saidDuring(() => [
      { type: "rate_limit", kind: "retryable", retryInMs: 20_000, message: "⏳ kimi-k3 is rate limited. Retrying in 20s…" },
      { type: "assistant", text: "done" },
      { type: "result", ok: true },
    ]);
    expect(said.some((s) => s.includes("Retrying in 20s"))).toBe(true);
    // It is NOT a failure: nothing may claim the turn died.
    expect(said.some((s) => s.includes("turn failed"))).toBe(false);
    expect(said.some((s) => s === "done")).toBe(true);
  });

  it("says it once, however many rounds of one turn get limited", async () => {
    // A 3-req/min limiter can 429 several rounds of the same turn. A bubble per
    // retry would bury the conversation under status about itself.
    const said = await saidDuring(() => [
      { type: "rate_limit", retryInMs: 20_000, message: "⏳ kimi-k3 is rate limited. Retrying in 20s…" },
      { type: "rate_limit", retryInMs: 20_000, message: "⏳ kimi-k3 is rate limited. Retrying in 20s…" },
      { type: "rate_limit", retryInMs: 20_000, message: "⏳ kimi-k3 is rate limited. Retrying in 20s…" },
      { type: "result", ok: true },
    ]);
    expect(said.filter((s) => s.includes("Retrying in 20s"))).toHaveLength(1);
  });

  it("does not spend the once-per-turn error slot", async () => {
    // A wait that swallowed the slot would silence the first REAL error after it.
    const said = await saidDuring(() => [
      { type: "rate_limit", retryInMs: 20_000, message: "⏳ kimi-k3 is rate limited. Retrying in 20s…" },
      { type: "error", message: "something else broke" },
      { type: "result", ok: false },
    ]);
    expect(said.some((s) => s.includes("Retrying in 20s"))).toBe(true);
    expect(said.some((s) => s.includes("something else broke"))).toBe(true);
  });

  it("a silent sub-second wait puts nothing in the chat", async () => {
    // The backend omits `message` for waits too short to be worth a word; the
    // panel must not invent one.
    const said = await saidDuring(() => [
      { type: "rate_limit", retryInMs: 800 },
      { type: "assistant", text: "done" },
      { type: "result", ok: true },
    ]);
    expect(said.some((s) => s.includes("rate limit"))).toBe(false);
    expect(said).toContain("done");
  });
});

describe("a rate limit that could NOT be waited out", () => {
  const FINISHED =
    "⚠️ kimi-k3 hit its rate limit — max RPM: 3. " +
    "Try again in a moment or switch models from the composer picker — but if the turn had " +
    "already started changing the graph, check the canvas before re-sending, because " +
    "re-sending runs those steps again.";

  it("renders the finished sentence without the generic turn-failure wrapper", async () => {
    const said = await saidDuring(() => [
      { type: "error", message: FINISHED, rateLimit: true },
      { type: "result", ok: false, subtype: "rate_limit" },
    ]);
    const line = said.find((s) => s.includes("rate limit"));
    expect(line).toBeDefined();
    // No "The kimi-k3 turn failed: ollama backend: …" stack of prefixes, and the
    // model is named once rather than twice.
    expect(line).not.toContain("turn failed");
    expect(line).not.toContain("check the terminal");
    expect(line?.match(/kimi-k3/g)).toHaveLength(1);
    // Exactly one ⚠️: the backend's own marker is not doubled by the renderer.
    expect(line?.match(/⚠️/g)).toHaveLength(1);
  });

  it("still consumes the error slot, so the failing result does not report twice", async () => {
    const said = await saidDuring(() => [
      { type: "error", message: FINISHED, rateLimit: true },
      { type: "result", ok: false, subtype: "rate_limit" },
    ]);
    expect(said.filter((s) => s.includes("⚠️"))).toHaveLength(1);
  });

  it("an ordinary error is untouched — it keeps the turn-failure framing", async () => {
    const said = await saidDuring(() => [
      { type: "error", message: "ollama backend: connect ECONNREFUSED" },
      { type: "result", ok: false },
    ]);
    const line = said.find((s) => s.includes("ECONNREFUSED"));
    expect(line).toContain("The kimi-k3 turn failed:");
    expect(line).toContain("check the terminal");
  });
});
