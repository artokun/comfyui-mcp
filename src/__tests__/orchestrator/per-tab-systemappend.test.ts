// #358 — the ENVIRONMENT block's `Backend:` line must name the provider running
// THIS tab's turn, not the process default. Backends are per-tab, but the env
// block was built once from PANEL_AGENT_BACKEND, so a Grok tab was told it was
// Claude. The orchestrator now rebuilds the append per-tab-backend and feeds it
// to spawns through the manager's `makeSystemAppend` factory. This test pins the
// manager seam: makeAgent must prefer makeSystemAppend(key) over the static
// systemAppend (fail-before: the option did not exist, so the agent got the
// static default).

import { describe, expect, it, beforeAll } from "vitest";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";

let PanelAgentManager: typeof import("../../orchestrator/panel-agent.js").PanelAgentManager;

beforeAll(async () => {
  ({ PanelAgentManager } = await import("../../orchestrator/panel-agent.js"));
});

// A minimal backend so a spawn never touches a real provider.
class NoopBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: "sess" };
    for await (const turn of opts.channel) {
      void turn;
      yield { type: "result", ok: true, subtype: "success" };
    }
  }
  async interrupt(): Promise<void> {}
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

function makeManager(opts: Record<string, unknown>) {
  return new PanelAgentManager({
    mcpServers: {},
    systemAppend: "STATIC-DEFAULT",
    model: "m",
    onSay: () => {},
    onTurn: () => {},
    makeBackend: () => new NoopBackend(),
    ...opts,
  } as never);
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** White-box: read the systemAppend the manager actually handed the spawned agent. */
function spawnedAppend(manager: unknown, key: string): string {
  const agents = (manager as { agents: Map<string, { deps: { systemAppend: string } }> }).agents;
  return agents.get(key)!.deps.systemAppend;
}

describe("per-tab systemAppend (#358 — Backend line names the tab's real backend)", () => {
  it("prefers makeSystemAppend(key) over the static systemAppend for a spawn", async () => {
    const seen: string[] = [];
    const manager = makeManager({
      makeSystemAppend: (key: string) => {
        seen.push(key);
        return `ENV-FOR(${key})`;
      },
    });
    manager.send("tabGrok", "hi");
    await waitFor(() => (manager as { agents: Map<string, unknown> }).agents.has("tabGrok"));
    expect(seen).toContain("tabGrok");
    expect(spawnedAppend(manager, "tabGrok")).toBe("ENV-FOR(tabGrok)");
    expect(spawnedAppend(manager, "tabGrok")).not.toBe("STATIC-DEFAULT");
  });

  it("falls back to the static systemAppend when no factory is provided", async () => {
    const manager = makeManager({});
    manager.send("tabPlain", "hi");
    await waitFor(() => (manager as { agents: Map<string, unknown> }).agents.has("tabPlain"));
    expect(spawnedAppend(manager, "tabPlain")).toBe("STATIC-DEFAULT");
  });
});
