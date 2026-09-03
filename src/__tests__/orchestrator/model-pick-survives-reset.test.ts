// #2759 — a New chat silently threw away the model the user picked.
//
// The picker was set to sonnet; the agent that spawned after "New chat" ran the
// orchestrator's global default (opus), and the dropdown went on rendering the
// stale selection. Nothing errored, so the only signal was a user noticing their
// subscription's Opus limits draining while they believed they were on Sonnet.
//
// `reset()` deleted the key's picker override, on a rationale about provider
// switches that does not apply to it: the override map is keyed by the composite
// agent key whose last segment is the BACKEND, so a provider switch already reads
// a different key, and the only two callers of reset() are `new_session` and
// `resume_session`. Both are conversation boundaries, not provider boundaries.
//
// Harness follows effort-carry.test.ts: a backend that records the model each
// spawn was given.

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

/** Records the model handed to every run() — one entry per spawn. */
class ModelRecordingBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  models: Array<string | undefined> = [];

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    this.models.push(opts.model);
    yield { type: "session", sessionId: `sess-${this.models.length}` };
    for await (const turn of opts.channel) {
      void turn;
      yield { type: "result", subtype: "success" } as AgentEvent;
    }
  }

  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

function makeManager(backend: AgentBackend, model = "claude-opus-5") {
  return new PanelAgentManager({
    mcpServers: {},
    systemAppend: "",
    model,
    onSay: () => {},
    onTurn: () => {},
    makeBackend: () => backend,
  } as never);
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("#2759 the picker's model survives a New chat", () => {
  it("respawns on the PICKED model after reset(), not the global default", async () => {
    const backend = new ModelRecordingBackend();
    const manager = makeManager(backend); // global default: claude-opus-5
    const key = "scope::claude";

    await manager.setOptions(key, { model: "claude-sonnet-5" });
    manager.send(key, "first");
    await waitFor(() => backend.models.length >= 1);
    expect(backend.models[0]).toBe("claude-sonnet-5");

    // New chat.
    manager.reset(key);
    manager.send(key, "after new chat");
    await waitFor(() => backend.models.length >= 2);

    // The reported failure is exactly this line coming back "claude-opus-5".
    expect(backend.models[1]).toBe("claude-sonnet-5");
  });

  it("keeps reporting the override, so the picker and the spawn agree", async () => {
    // The other half of the report: the dropdown kept rendering the stale
    // selection. Whatever the UI shows, this is the value it reads.
    const backend = new ModelRecordingBackend();
    const manager = makeManager(backend);
    const key = "scope::claude";
    await manager.setOptions(key, { model: "claude-sonnet-5" });
    manager.reset(key);
    expect(manager.modelOverrideFor(key)).toBe("claude-sonnet-5");
  });

  it("still isolates providers — a pick on one key is invisible to the other", async () => {
    // The behaviour the deleted line was PROTECTING, pinned so removing it cannot
    // quietly reintroduce the "model gpt-5.5 may not exist" spawn. Isolation comes
    // from the key, not from reset(): the backend is the key's last segment.
    const backend = new ModelRecordingBackend();
    const manager = makeManager(backend);
    await manager.setOptions("scope::codex", { model: "gpt-5.5" });
    expect(manager.modelOverrideFor("scope::claude")).toBeUndefined();

    manager.send("scope::claude", "hello");
    await waitFor(() => backend.models.length >= 1);
    expect(backend.models[0]).toBe("claude-opus-5");
  });

  it("a tab that never picked anything still spawns on the default", async () => {
    const backend = new ModelRecordingBackend();
    const manager = makeManager(backend);
    const key = "scope::claude";
    manager.reset(key);
    manager.send(key, "hello");
    await waitFor(() => backend.models.length >= 1);
    expect(backend.models[0]).toBe("claude-opus-5");
  });
});
