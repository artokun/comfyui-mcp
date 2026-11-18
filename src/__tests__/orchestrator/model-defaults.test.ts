// "First rank" defaults: a session that names no model starts on the best one the
// account actually offers, instead of a baked id that goes stale every release.
// Claude: the newest Opus in supportedModels() (per-account). ChatGPT: the Codex
// catalog's priority-1 model. An explicit choice — env pin or picker — always wins.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBackend, AgentEvent, BackendStartOptions } from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";
import { pickTopClaudeModel } from "../../orchestrator/model-defaults.js";
import { CHATGPT_DEFAULT_MODEL, resolveChatGptDefaultModel } from "../../orchestrator/chatgpt-oauth-backend.js";

let PanelAgentManager: typeof import("../../orchestrator/panel-agent.js").PanelAgentManager;
beforeAll(async () => {
  ({ PanelAgentManager } = await import("../../orchestrator/panel-agent.js"));
});

describe("pickTopClaudeModel — the same rule as the panel's pickDefaultModel", () => {
  const v = (value: string, resolvedModel?: string) => ({ value, ...(resolvedModel ? { resolvedModel } : {}) });

  it("picks the newest Opus the account advertises", () => {
    expect(
      pickTopClaudeModel([v("default", "claude-sonnet-5-5"), v("claude-opus-5"), v("claude-opus-5-5"), v("claude-sonnet-5-5")]),
    ).toBe("claude-opus-5-5");
  });

  it("reads an alias's version from what it resolves to", () => {
    expect(pickTopClaudeModel([v("claude-opus-5"), v("opus", "claude-opus-5-5")])).toBe("opus");
  });

  it("on a tie, a pinned id beats an alias (aliases lagged in #377), in either order", () => {
    expect(pickTopClaudeModel([v("opus", "claude-opus-5-5"), v("claude-opus-5-5")])).toBe("claude-opus-5-5");
    expect(pickTopClaudeModel([v("claude-opus-5-5"), v("opus", "claude-opus-5-5")])).toBe("claude-opus-5-5");
  });

  it("on a tie, the plain id beats the [1m] variant", () => {
    expect(pickTopClaudeModel([v("claude-opus-5-5[1m]"), v("claude-opus-5-5")])).toBe("claude-opus-5-5");
  });

  it("never defaults to the differently-priced -fast variant", () => {
    expect(pickTopClaudeModel([v("claude-opus-5-5-fast"), v("claude-opus-5")])).toBe("claude-opus-5");
  });

  it("with no Opus, falls back to the first non-`default` row; empty gives nothing", () => {
    expect(pickTopClaudeModel([v("default"), v("claude-sonnet-5")])).toBe("claude-sonnet-5");
    expect(pickTopClaudeModel([v("default", "claude-sonnet-5")])).toBe("default"); // nothing else to pick
    expect(pickTopClaudeModel([])).toBeUndefined();
  });

  // The live supportedModels() list from a real account on 2026-10-13, verbatim.
  // The newest Opus is advertised ONLY through aliases — no pinned claude-opus-5-5
  // row exists — and `default` (resolving to the same model) came first. beta.5
  // picked `default`; the panel, which drops that row, picked `opus`.
  it("on the real account list, agrees with the panel: `opus`, never `default`", () => {
    const live = [
      v("default", "claude-opus-5-5"),
      v("opus", "claude-opus-5-5"),
      v("fable", "claude-fable-5-1"),
      v("sonnet", "claude-sonnet-5-5"),
      v("haiku", "claude-haiku-5-5"),
      v("claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001"),
      v("claude-sonnet-5", "claude-sonnet-5"),
      v("claude-opus-5", "claude-opus-5"),
      v("claude-fable-5", "claude-fable-5"),
      v("claude-opus-4-8", "claude-opus-4-8"),
      v("claude-opus-4-7", "claude-opus-4-7"),
      v("claude-opus-4-6", "claude-opus-4-6"),
      v("claude-sonnet-4-6", "claude-sonnet-4-6"),
    ];
    expect(pickTopClaudeModel(live)).toBe("opus");
  });
});

describe("resolveChatGptDefaultModel — the Codex catalog's priority 1", () => {
  let home = "";
  const prevEnv = process.env.COMFYUI_MCP_CHATGPT_MODEL;
  const withCache = (models: unknown[] | null): string => {
    home = mkdtempSync(join(tmpdir(), "cmcp-default-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    if (models) writeFileSync(join(home, ".codex", "models_cache.json"), JSON.stringify({ models }));
    return home;
  };
  const prevCodexHome = process.env.CODEX_HOME;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = "";
    if (prevEnv === undefined) delete process.env.COMFYUI_MCP_CHATGPT_MODEL;
    else process.env.COMFYUI_MCP_CHATGPT_MODEL = prevEnv;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
  });
  const resolveIn = (h: string) => {
    process.env.CODEX_HOME = join(h, ".codex");
    return resolveChatGptDefaultModel(h);
  };

  it("is the top-ranked LISTED model — a hidden one never becomes the default", async () => {
    delete process.env.COMFYUI_MCP_CHATGPT_MODEL;
    const h = withCache([
      { slug: "gpt-reserve", visibility: "hide", priority: 0 },
      { slug: "gpt-6-astra", visibility: "list", priority: 2 },
      { slug: "gpt-6.1-sol", visibility: "list", priority: 1 },
    ]);
    expect(await resolveIn(h)).toBe("gpt-6.1-sol");
  });

  it("an explicit env pin always wins", async () => {
    process.env.COMFYUI_MCP_CHATGPT_MODEL = "gpt-6-luna";
    const h = withCache([{ slug: "gpt-6.1-sol", visibility: "list", priority: 1 }]);
    expect(await resolveIn(h)).toBe("gpt-6-luna");
  });

  it("no catalog (missing cache, or an older Codex's bare ids) keeps the baked default", async () => {
    delete process.env.COMFYUI_MCP_CHATGPT_MODEL;
    expect(await resolveIn(withCache(null))).toBe(CHATGPT_DEFAULT_MODEL);
    rmSync(home, { recursive: true, force: true });
    expect(await resolveIn(withCache([{ id: "gpt-6-astra" }, { id: "gpt-5.6-sol" }]))).toBe(CHATGPT_DEFAULT_MODEL);
  });
});

describe("PanelAgentManager.adoptDefaultModel", () => {
  class FakeBackend implements AgentBackend {
    readonly id = "claude" as const;
    readonly capabilities = CLAUDE_CAPABILITIES;
    startModel: string | undefined;
    setModelCalls: string[] = [];
    async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
      this.startModel = opts.model;
      yield { type: "session", sessionId: "s" };
      for await (const _turn of opts.channel) yield { type: "result", ok: true, subtype: "success" };
    }
    async setModel(model: string): Promise<void> {
      this.setModelCalls.push(model);
    }
  }

  const build = () => {
    const backends = new Map<string, FakeBackend>();
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "claude-opus-5",
      onSay: () => {},
      onTurn: () => {},
      makeBackend: (key: string) => {
        const b = new FakeBackend();
        backends.set(key, b);
        return b;
      },
    } as never);
    return { manager, backends };
  };
  const waitFor = async (cond: () => boolean): Promise<void> => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > 3000) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const isClaude = (key: string) => key.endsWith("::claude");

  it("switches live Claude tabs with no pick, and leaves picks and other providers alone", async () => {
    const { manager, backends } = build();
    await manager.setOptions("picked::claude", { model: "claude-sonnet-5-5" });
    for (const key of ["fresh::claude", "picked::claude", "other::chatgpt"]) manager.send(key, "hi");
    await waitFor(() => backends.size === 3);

    const switched = await manager.adoptDefaultModel("claude-opus-5-5", isClaude);

    expect(switched).toEqual(["fresh::claude"]);
    expect(backends.get("fresh::claude")?.setModelCalls).toEqual(["claude-opus-5-5"]);
    // An explicit pick outranks any default.
    expect(backends.get("picked::claude")?.setModelCalls).toEqual([]);
    // A Claude id must never reach another provider's agent.
    expect(backends.get("other::chatgpt")?.setModelCalls).toEqual([]);
    expect(manager.defaultModel).toBe("claude-opus-5-5");
  });

  it("a tab spawned after adoption starts on the new default; adopting it again is a no-op", async () => {
    const { manager, backends } = build();
    await manager.adoptDefaultModel("claude-opus-5-5", isClaude);
    manager.send("later::claude", "hi");
    await waitFor(() => backends.get("later::claude")?.startModel !== undefined);
    expect(backends.get("later::claude")?.startModel).toBe("claude-opus-5-5");
    expect(await manager.adoptDefaultModel("claude-opus-5-5", isClaude)).toEqual([]);
  });
});
