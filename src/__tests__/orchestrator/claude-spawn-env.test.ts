// SECURITY regression (PR #270): the Claude Agent SDK spawns a Claude Code
// subprocess. When `options.env` is omitted the subprocess INHERITS process.env
// (sdk.d.ts: "When omitted, the subprocess inherits process.env"), so the user's
// TOOL secrets (RunPod/CivitAI/HF…) would leak into the LLM subprocess. Both the
// panel Claude backend AND the one-shot ai-proposer must pass
// `env: buildAgentSpawnEnv()` (a full env MINUS tool-only secrets — the SDK
// REPLACES the env, so it must be a complete copy).

import { describe, expect, it, beforeEach, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  optionsSeen: [] as Array<Record<string, unknown>>,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (arg: { options?: Record<string, unknown> }) => {
    hoisted.optionsSeen.push(arg.options ?? {});
    const iter = (async function* () {
      yield { type: "result", subtype: "success", result: "{}" };
    })();
    return Object.assign(iter, {
      supportedModels: async () => [],
      supportedCommands: async () => [],
      interrupt: async () => {},
      setModel: async () => {},
    });
  },
}));

beforeEach(() => {
  hoisted.optionsSeen.length = 0;
});

function withToolSecrets<T>(fn: () => Promise<T>): Promise<T> {
  const saved = {
    RUNPOD_API_KEY: process.env.RUNPOD_API_KEY,
    CIVITAI_API_TOKEN: process.env.CIVITAI_API_TOKEN,
    HF_TOKEN: process.env.HF_TOKEN,
  };
  process.env.RUNPOD_API_KEY = "rp-tool-secret";
  process.env.CIVITAI_API_TOKEN = "civ-tool-secret";
  process.env.HF_TOKEN = "hf-tool-secret";
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function assertScrubbed(env: Record<string, string | undefined> | undefined): void {
  expect(env, "options.env must be set (omitting it inherits process.env)").toBeDefined();
  expect(env!.RUNPOD_API_KEY).toBeUndefined();
  expect(env!.CIVITAI_API_TOKEN).toBeUndefined();
  expect(env!.HF_TOKEN).toBeUndefined();
  // Non-secret env still passes through (the subprocess needs PATH etc.).
  expect(env!.PATH ?? env!.Path).toBeDefined();
}

describe("Claude backend spawn env (tool-secret scoping)", () => {
  it("fetchSupportedModels passes an env WITHOUT tool-only secrets", async () => {
    const { fetchSupportedModels } = await import("../../orchestrator/claude-backend.js");
    await withToolSecrets(() => fetchSupportedModels("claude-opus-4-8"));
    expect(hoisted.optionsSeen.length).toBeGreaterThanOrEqual(1);
    assertScrubbed(hoisted.optionsSeen[0].env as Record<string, string | undefined> | undefined);
  });

  it("a run() turn passes an env WITHOUT tool-only secrets", async () => {
    const { ClaudeBackend } = await import("../../orchestrator/claude-backend.js");
    const backend = new ClaudeBackend({ mcpServers: {}, systemAppend: "" });
    async function* channel() {
      yield { text: "hi" };
    }
    await withToolSecrets(async () => {
      try {
        for await (const _ of backend.run({ channel: channel() as never })) void _;
      } catch {
        // The mock's minimal result shape may not fully route — the query()
        // call (and thus the options.env we assert on) has already happened.
      }
    });
    const runOpts = hoisted.optionsSeen.find((o) => "systemPrompt" in o) ?? hoisted.optionsSeen[0];
    assertScrubbed(runOpts.env as Record<string, string | undefined> | undefined);
  });
});

describe("ai-proposer spawn env (tool-secret scoping)", () => {
  it("proposeModelCard passes an env WITHOUT tool-only secrets", async () => {
    const { proposeModelCard } = await import("../../orchestrator/ai-proposer.js");
    await withToolSecrets(() => proposeModelCard({ filename: "x.safetensors" }));
    expect(hoisted.optionsSeen.length).toBeGreaterThanOrEqual(1);
    assertScrubbed(hoisted.optionsSeen[0].env as Record<string, string | undefined> | undefined);
  });
});
