// P1b — COALESCED restarts: a pending effort restart and a pending comfyui-MCP-env
// respawn that come due at the SAME idle moment must replace the agent EXACTLY
// ONCE, resuming from the original agent's session id (not the just-spawned,
// not-yet-session'd agent's null id) and firing the retry nudge a single time.
//
// Before the fix, onTurn("done") applied the effort restart first (spawning a
// fresh resumed agent) and then immediately applied the MCP restart against that
// brand-new agent — whose sessionId hadn't been emitted yet — so the second
// restart resumed from `undefined`, silently dropping the conversation, and the
// agent was restarted twice.

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
 * A backend that records every run() (a spawn or a restart) — the effort and
 * resume id it was given, plus the text of every turn it processes. Turns either
 * complete immediately (autoComplete) or hang until released, so a test can hold
 * the agent "busy" to force the deferred-restart path, then release it to fire
 * onTurn("done").
 */
class RecordingBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  runCount = 0;
  resumes: Array<string | undefined> = [];
  efforts: Array<string | undefined> = [];
  turnTexts: string[] = [];
  autoComplete = true;
  private releaseTurn: (() => void) | null = null;

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    this.runCount += 1;
    this.resumes.push(opts.resume);
    this.efforts.push(opts.effort);
    yield { type: "session", sessionId: "sess-x" };
    for await (const turn of opts.channel) {
      this.turnTexts.push(turn.text);
      if (!this.autoComplete) {
        await new Promise<void>((resolve) => {
          this.releaseTurn = resolve;
        });
        this.releaseTurn = null;
      }
      yield { type: "result", ok: true, subtype: "success" };
    }
  }

  /** Release a hanging turn so it completes (emits its result → onTurn done). */
  release(): void {
    const r = this.releaseTurn;
    this.releaseTurn = null;
    r?.();
  }

  async interrupt(): Promise<void> {
    this.release();
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

describe("coalesced effort + comfyui-MCP-env restart (P1b)", () => {
  it("both pending at idle → ONE restart, session preserved, nudge once", async () => {
    const backend = new RecordingBackend();
    backend.autoComplete = false; // first turn hangs → agent stays busy
    const manager = makeManager(backend, "low");
    const tab = "tab-coalesce";

    // Spawn the agent with a hanging first turn so it's BUSY.
    manager.send(tab, "hello");
    await waitFor(() => backend.runCount >= 1 && backend.turnTexts.length >= 1);
    expect(backend.resumes[0]).toBeUndefined(); // fresh spawn, no resume

    // While BUSY: queue an effort change (deferred) AND a comfyui-MCP-env respawn.
    const applied = await manager.setOptions(tab, { effort: "high" });
    expect(applied.deferred).toBe(true);
    expect(applied.restarted).toBe(false);
    manager.restartAllForMcpEnv("RETRY the download");

    // Subsequent turns should complete cleanly so the restarted agent settles.
    backend.autoComplete = true;
    // Release the hanging turn → onTurn("done") → coalesced restart fires once.
    backend.release();

    // Exactly ONE more run (the single coalesced restart) — NOT two.
    await waitFor(() => backend.runCount >= 2);
    await new Promise((r) => setTimeout(r, 100)); // give any erroneous 3rd run a chance
    expect(backend.runCount).toBe(2);

    // The restart RESUMED from the original agent's session id (preserved), not
    // the just-spawned agent's not-yet-emitted (undefined) id.
    expect(backend.resumes[1]).toBe("sess-x");
    // It ran at the NEW effort (the effort change was folded in).
    expect(backend.efforts[1]).toBe("high");
    // The retry nudge was delivered EXACTLY ONCE.
    expect(backend.turnTexts.filter((t) => t === "RETRY the download")).toHaveLength(1);
  });

  it("only the MCP respawn pending → single restart with nudge, resume preserved", async () => {
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend, "low");
    const tab = "tab-mcp-only";

    manager.send(tab, "hello");
    await waitFor(() => backend.runCount >= 1 && backend.turnTexts.length >= 1);

    manager.restartAllForMcpEnv("RETRY");
    backend.autoComplete = true;
    backend.release();

    await waitFor(() => backend.runCount >= 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(backend.runCount).toBe(2);
    expect(backend.resumes[1]).toBe("sess-x");
    expect(backend.efforts[1]).toBe("low"); // unchanged effort
    expect(backend.turnTexts.filter((t) => t === "RETRY")).toHaveLength(1);
  });
});
