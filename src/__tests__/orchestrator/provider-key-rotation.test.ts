// #278 — rotating an active provider API key must REBUILD the live keyed agent
// so the new/revoked key takes effect. Keyed backends (OpenRouter/Custom/GLM/
// Kimi/Moonshot) capture the credential at construction, so a cache-drop alone
// leaves the old key in use until the backend is rebuilt. restartForProviderKey
// drives that rebuild at idle WITHOUT a download-retry nudge.

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

/** A keyed backend that SNAPSHOTS the credential at construction (like the real
 *  OpenRouter/GLM backends), so a test can prove a rebuild picks up a new key. */
class KeyedBackend implements AgentBackend {
  readonly id = "openrouter" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  readonly capturedKey: string;
  turnTexts: string[] = [];
  constructor(readKey: () => string) {
    this.capturedKey = readKey(); // captured ONCE at construction
  }
  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: `sess-${this.capturedKey}` };
    for await (const turn of opts.channel) {
      this.turnTexts.push(turn.text);
      yield { type: "result", ok: true, subtype: "success" };
    }
  }
  async interrupt(): Promise<void> {}
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("provider-key rotation rebuilds the live keyed agent (#278)", () => {
  it("restartForProviderKey rebuilds the backend with the ROTATED key, no nudge", async () => {
    let currentKey = "key-OLD";
    const built: KeyedBackend[] = [];
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "or-model",
      onSay: () => {},
      onTurn: () => {},
      makeBackend: () => {
        const b = new KeyedBackend(() => currentKey);
        built.push(b);
        return b;
      },
    } as never);
    const tab = "tab-key-rotate";

    manager.send(tab, "hello");
    await waitFor(() => built.length >= 1 && built[0].turnTexts.includes("hello"));
    expect(built[0].capturedKey).toBe("key-OLD");

    // Rotate the key, then trigger the keyed rebuild (what onAgentSecretsChanged
    // now does for a live keyed tab).
    currentKey = "key-NEW";
    manager.restartForProviderKey(tab);

    // A SECOND backend is constructed — and it captured the NEW key.
    await waitFor(() => built.length >= 2);
    expect(built[1].capturedKey).toBe("key-NEW");
    // No download-retry nudge was injected into the rebuilt agent.
    expect(built[1].turnTexts).not.toContain(
      "🔑 The API token you just provided is now active for the comfyui tools — retry the action that needed it (e.g. the download that returned 401).",
    );
  });
});
