// #1524, RENDERING — a session notice is not a turn failure, and must not be
// painted as one or charged to the turn's one error slot.
//
// The generic `error` line reads "The <model> turn failed: … Nothing was lost —
// try again". For "this session started without its panel MCP server" all three
// clauses are wrong: no turn failed, nothing was lost in a turn, and trying again
// re-runs a turn rather than the connection.
//
// The sharper hazard is the slot. `errorSurfaced` allows ONE chat line per turn,
// and init legitimately lands AFTER the first turn was dispatched — the SDK's
// prompt drain pulls the first batch before init is processed. A notice that took
// the slot would silence that turn's real failure, turning a message about a
// missing toolset into the "three Hellos into the void" bug it was written to
// prevent.

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
  inProcessMcp: true,
  modelEnumeration: false,
  slashCommands: false,
  hooks: false,
  vision: true,
  turnMarkers: true,
};

const NOTICE = "This session started without 1 of its MCP servers: `panel` (failed).";
const TURN_FAILURE = "REAL_TURN_FAILURE";

/** Emits the notice INSIDE the turn — the real ordering when init lands after the
 *  prompt drain has already dispatched the first batch — then the turn's own
 *  failure behind it. */
function noticeThenTurnErrorBackend(): AgentBackend {
  return {
    id: "claude" as AgentBackend["id"],
    capabilities: CAPS,
    async *run(opts: BackendStartOptions): AsyncIterable<AgentEvent> {
      yield { type: "session", sessionId: "s1" };
      for await (const _turn of opts.channel) {
        void _turn;
        yield { type: "error", sessionNotice: true, message: NOTICE };
        yield { type: "error", message: TURN_FAILURE };
        yield { type: "result", ok: false, subtype: "error_during_execution", turn: 1 };
      }
    },
    async interrupt() {},
    async listModels() {
      return [];
    },
  };
}

function outcomeUnknownBackend(): AgentBackend {
  return {
    id: "codex" as AgentBackend["id"],
    capabilities: CAPS,
    async *run(opts: BackendStartOptions): AsyncIterable<AgentEvent> {
      yield { type: "session", sessionId: "s-unknown" };
      for await (const _turn of opts.channel) {
        void _turn;
        yield { type: "error", outcomeUnknown: true, message: "MCP reconnect is pending; inspect before retrying." };
        yield { type: "result", ok: false, subtype: "error_during_execution", turn: 1 };
      }
    },
    async interrupt() {},
    async listModels() {
      return [];
    },
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe("a session notice renders on its own terms (#1524)", () => {
  it("is shown verbatim, without the turn-failure framing", async () => {
    const said: string[] = [];
    const agent = new PanelAgent(
      "tab-notice",
      { mcpServers: undefined, systemAppend: "", model: "claude-test-1", onSay: (_t, m) => said.push(m) } as never,
      noticeThenTurnErrorBackend(),
    );
    void agent.start();
    agent.send("hello");
    await settle();
    await agent.stop().catch(() => {});

    const line = said.find((m) => m.includes("panel"));
    expect(line).toBeDefined();
    expect(line).toBe(`⚠️ ${NOTICE}`);
    // The generic framing would name a turn that never failed and offer a retry
    // that re-runs nothing.
    expect(line).not.toMatch(/turn failed/);
    expect(line).not.toMatch(/Nothing was lost/);
  });

  it("shows an outcome-unknown transport error without generic retry framing (#1777)", async () => {
    const said: string[] = [];
    const agent = new PanelAgent(
      "tab-unknown",
      { mcpServers: undefined, systemAppend: "", model: "codex-test-1", onSay: (_t, m) => said.push(m) } as never,
      outcomeUnknownBackend(),
    );
    void agent.start();
    agent.send("queue a render");
    await settle();
    await agent.stop().catch(() => {});

    const line = said.find((m) => m.includes("MCP reconnect is pending"));
    expect(line).toBe("⚠️ MCP reconnect is pending; inspect before retrying.");
    expect(line).not.toMatch(/turn failed|Nothing was lost/i);
  });

  it("does not spend the turn's one error line", async () => {
    // Without this, a notice arriving mid-turn silences the turn's REAL failure —
    // the user watches the turn end with only a message about MCP servers.
    const said: string[] = [];
    const agent = new PanelAgent(
      "tab-slot",
      { mcpServers: undefined, systemAppend: "", model: "claude-test-1", onSay: (_t, m) => said.push(m) } as never,
      noticeThenTurnErrorBackend(),
    );
    void agent.start();
    agent.send("hello");
    await settle();
    await agent.stop().catch(() => {});

    expect(said.some((m) => m.includes(NOTICE))).toBe(true);
    expect(said.some((m) => m.includes(TURN_FAILURE))).toBe(true);
  });
});
