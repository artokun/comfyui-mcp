// Regression for panel #176: a STRUCTURED backend/ComfyUI failure object pushed
// into a tab's agent must reach the model as readable text, never the literal
// "[object Object]". Both injection paths are covered: injectRunError (urgent,
// front-queued) and injectEvent({kind:"run_error"}) (normal enqueue).

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

/** Records every user-turn text the panel feeds it; ends each turn immediately. */
class RecordingBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  turns: string[] = [];
  private resolveNext: (() => void) | null = null;

  /** Resolve once at least `n` turns have been read. */
  waitTurns(n: number, timeoutMs = 2000): Promise<void> {
    if (this.turns.length >= n) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`only ${this.turns.length} turns read`)), timeoutMs);
      this.resolveNext = () => {
        if (this.turns.length >= n) {
          clearTimeout(timer);
          resolve();
        }
      };
    });
  }

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: "sess-rec" };
    for await (const turn of opts.channel) {
      this.turns.push(turn.text);
      this.resolveNext?.();
      yield { type: "assistant", text: "ok" };
      yield { type: "result", ok: true, subtype: "success" };
    }
  }
  async interrupt(): Promise<void> {}
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

describe("[object Object] never appears — structured failures serialize to readable text (#176)", () => {
  it("injectRunError serializes a structured error object", async () => {
    const backend = new RecordingBackend();
    const agent = new PanelAgent("tab-inj1", makeDeps() as never, backend);
    void agent.start();

    // The #176 shape: a structured failure carrying a readable `message` field.
    await agent.injectRunError({ message: "Individual quota reached.", code: 429 });
    await backend.waitTurns(1);

    expect(backend.turns[0]).not.toContain("[object Object]");
    expect(backend.turns[0]).toContain("Individual quota reached.");

    await agent.stop();
  });

  it("injectEvent run_error serializes an object with no string field via JSON", async () => {
    const backend = new RecordingBackend();
    const agent = new PanelAgent("tab-inj2", makeDeps() as never, backend);
    void agent.start();

    agent.injectEvent({ kind: "run_error", error: { node: "KSampler", status: 500 } });
    await backend.waitTurns(1);

    expect(backend.turns[0]).not.toContain("[object Object]");
    expect(backend.turns[0]).toContain("KSampler");

    await agent.stop();
  });
});
