// Focused tests for the effort carry-over across a backend/agent (re)spawn.
//
// BUG CONTEXT (RD5 FIX 1): switching backends (ChatGPT/Codex → Claude) was
// dropping the chosen reasoning effort. The panel snaps the level to the nearest
// one the target model supports; the ORCHESTRATOR must then make sure a freshly
// spawned agent actually RUNS at the manager's live effort — regardless of
// whether the set_options arrived BEFORE the agent was spawned or AFTER (idle).
// There must be no stale-capture gap: backend.run reads PanelAgent.this.effort,
// which comes from deps.effort = the manager's current effort AT SPAWN.

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

/**
 * A backend that records the `effort` it was constructed/run with for every run
 * iteration (a fresh spawn or an effort restart starts a new run). Turns either
 * hang (so the agent reports busy) or complete cleanly (so it stays idle),
 * controlled by `autoComplete`.
 */
class EffortRecordingBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  /** The effort passed to each run() (per spawn/restart), in order. */
  efforts: Array<string | undefined> = [];
  autoComplete = true;
  private breakTurn: (() => void) | null = null;

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    this.efforts.push(opts.effort);
    yield { type: "session", sessionId: "sess-effort" };
    for await (const turn of opts.channel) {
      void turn;
      if (this.autoComplete) {
        yield { type: "result", ok: true, subtype: "success" };
        continue;
      }
      await new Promise<void>((resolve) => {
        this.breakTurn = resolve;
      });
      this.breakTurn = null;
    }
  }

  async interrupt(): Promise<void> {
    const brk = this.breakTurn;
    this.breakTurn = null;
    brk?.();
  }

  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

function makeManager(backend: AgentBackend, startEffort?: "low" | "high") {
  return new PanelAgentManager({
    mcpServers: {},
    systemAppend: "",
    model: "claude-test",
    effort: startEffort,
    onSay: () => {},
    onTurn: () => {},
    // Inject our recording backend for every tab.
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

describe("effort carries to a freshly-spawned agent (no stale-capture gap)", () => {
  it("set_options BEFORE the agent spawns → the first run uses the chosen effort", async () => {
    const backend = new EffortRecordingBackend();
    const manager = makeManager(backend); // no initial effort
    const tab = "tab-before";

    // The picker pushes set_options before any message has spawned an agent.
    const applied = await manager.setOptions(tab, { effort: "high" });
    expect(applied.effort).toBe("high");
    expect(applied.restarted).toBe(false); // no agent existed → nothing to restart
    expect(backend.efforts).toHaveLength(0); // still no run

    // First message spawns the agent — it must adopt the manager's live effort.
    manager.send(tab, "hello");
    await waitFor(() => backend.efforts.length >= 1);
    expect(backend.efforts[0]).toBe("high");
  });

  it("set_options AFTER an idle agent spawned → restarts the session at the new effort", async () => {
    const backend = new EffortRecordingBackend();
    backend.autoComplete = true; // turns complete cleanly → agent goes idle
    const manager = makeManager(backend, "low");
    const tab = "tab-after";

    // Spawn the agent at the starting effort.
    manager.send(tab, "first");
    await waitFor(() => backend.efforts.length >= 1);
    expect(backend.efforts[0]).toBe("low");

    // Wait for the turn to complete so the agent is idle (immediate restart path).
    await new Promise((r) => setTimeout(r, 50));

    // Now switch effort — idle → restartForEffort spawns a fresh agent that must
    // run at the NEW effort (the mapped/snapped level the panel sends).
    const applied = await manager.setOptions(tab, { effort: "high" });
    expect(applied.effort).toBe("high");
    expect(applied.restarted).toBe(true);

    await waitFor(() => backend.efforts.length >= 2);
    expect(backend.efforts[backend.efforts.length - 1]).toBe("high");
  });

  it("an unchanged effort does NOT respawn the agent", async () => {
    const backend = new EffortRecordingBackend();
    const manager = makeManager(backend, "high");
    const tab = "tab-noop";

    manager.send(tab, "first");
    await waitFor(() => backend.efforts.length >= 1);
    await new Promise((r) => setTimeout(r, 50));

    const applied = await manager.setOptions(tab, { effort: "high" }); // same level
    expect(applied.restarted).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(backend.efforts).toHaveLength(1); // no extra run
  });
});
