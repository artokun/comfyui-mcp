// New ChatGPT generations never reached the panel's model picker.
//
// The Codex CLI keeps ~/.codex/models_cache.json current, and on 2026-10-13 it
// already listed gpt-6-astra and gpt-6.1-sol. Three gpt-5 locks in
// chatgpt-oauth-backend dropped them anyway:
//
//   • listModels kept only ids starting with "gpt-5.6" — a policy meant to hide
//     OLDER models that, written as an allow-list, hid NEWER ones too;
//   • it then migrated any non-5.6 ACTIVE model back to gpt-5.6-luna as
//     "deprecated", so a gen-6 pick could not stick;
//   • setModel's isChatGptModel was /^gpt-5/, so a gen-6 pick was silently ignored.
//
// Current Codex writes the server's own catalog (visibility, priority, upgrade,
// display_name), so the fix follows that instead of guessing. These fixtures are
// shaped like the real cache. Bare-id caches from older Codex are covered by the
// unchanged policy tests in chatgpt-oauth-backend.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptOAuthBackend, isChatGptModel } from "../../orchestrator/chatgpt-oauth-backend.js";
import type { McpToolClient } from "../../orchestrator/ollama-backend.js";

vi.mock("../../services/code-provider-auth.js", () => ({
  resolveOpenAICodexOAuth: async () => ({ accessToken: "tok", accountId: "acct" }),
}));

function fakeMcpClient(): McpToolClient {
  return {
    listTools: async () => ({ tools: [] }),
    callTool: (async () => ({ content: [{ type: "text", text: "ok" }] })) as unknown as McpToolClient["callTool"],
    close: async () => {},
  };
}

type Entry = {
  slug: string;
  display_name?: string;
  visibility?: "list" | "hide";
  priority?: number;
  upgrade?: { model: string; retirement_at?: string } | null;
};

/** The catalog as it appeared on 2026-10-13, trimmed to the fields that matter. */
const CATALOG: Entry[] = [
  { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list", priority: 1, upgrade: null },
  { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list", priority: 2, upgrade: null },
  { slug: "gpt-6-sol", display_name: "GPT-6-Sol", visibility: "list", priority: 3, upgrade: null },
  { slug: "gpt-6-luna", display_name: "GPT-6-Luna", visibility: "list", priority: 4, upgrade: null },
  { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide", priority: 4, upgrade: null },
  { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", priority: 5, upgrade: null },
  { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list", priority: 9, upgrade: null },
  {
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
    visibility: "list",
    priority: 13,
    upgrade: { model: "gpt-6.1-sol", retirement_at: "2026-10-14T19:00:00Z" },
  },
  { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", priority: 43, upgrade: null },
];

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

/** Point CODEX_HOME at a temp dir holding `models` and build a backend on `model`. */
function backendWith(models: Entry[], model: string): ChatGptOAuthBackend {
  const home = mkdtempSync(join(tmpdir(), "cmcp-catalog-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "models_cache.json"), JSON.stringify({ models }));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(home, ".codex");
  cleanup = () => {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  };
  return new ChatGptOAuthBackend({ model, connectToolClients: async () => ({ comfyui: fakeMcpClient() }) });
}

describe("ChatGPT model list follows the Codex server catalog", () => {
  it("offers the new generation, in server order, under the server's labels", async () => {
    const list = await backendWith(CATALOG, "gpt-6.1-sol").listModels();
    expect(list.map((m) => m.id)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
    expect(list.find((m) => m.id === "gpt-6-astra")?.label).toBe("GPT-6-Astra");
  });

  it("leaves out what the server marks hidden", async () => {
    const ids = (await backendWith(CATALOG, "gpt-6.1-sol").listModels()).map((m) => m.id);
    expect(ids).not.toContain("gpt-reserve");
    expect(ids).not.toContain("codex-auto-review");
  });

  it("keeps a gen-6 ACTIVE model instead of migrating it back to 5.6", async () => {
    const b = backendWith(CATALOG, "gpt-6-astra");
    const list = await b.listModels();
    expect(list[0].id).toBe("gpt-6-astra");
  });

  it("keeps a model whose retirement is still in the future — it works until then", async () => {
    const future = CATALOG.map((e) =>
      e.slug === "gpt-5.5" ? { ...e, upgrade: { model: "gpt-6.1-sol", retirement_at: "2999-01-01T00:00:00Z" } } : e,
    );
    expect((await backendWith(future, "gpt-5.5").listModels())[0].id).toBe("gpt-5.5");
  });

  it("moves a RETIRED active model to the replacement the server names", async () => {
    const past = CATALOG.map((e) =>
      e.slug === "gpt-5.5" ? { ...e, upgrade: { model: "gpt-6.1-sol", retirement_at: "2000-01-01T00:00:00Z" } } : e,
    );
    const list = await backendWith(past, "gpt-5.5").listModels();
    expect(list[0].id).toBe("gpt-6.1-sol");
    expect(list.filter((m) => m.id === "gpt-5.5")).toHaveLength(1); // still listed, just not selected
  });

  it("moves an active model the catalog no longer has, rather than re-inserting it", async () => {
    // A tab that saved a long-gone id keeps pushing it on reconnect; heading the
    // list with it kept it selected and 400ing every turn.
    const list = await backendWith(CATALOG, "gpt-5.4-mini").listModels();
    expect(list.map((m) => m.id)).not.toContain("gpt-5.4-mini");
    expect(list[0].id).toBe("gpt-6.1-sol"); // the catalog's top rank, not the baked default
  });

  it("keeps a HIDDEN model the user chose on purpose — hidden is not retired", async () => {
    const list = await backendWith(CATALOG, "gpt-reserve").listModels();
    expect(list[0]).toEqual({ id: "gpt-reserve", label: "GPT-Reserve" });
  });

  it("an old bare-id cache still lets a newer generation past the 5.6 floor", async () => {
    const bare = [{ slug: "gpt-6-astra" }, { slug: "gpt-5.6-sol" }, { slug: "gpt-5.4-mini" }];
    const ids = (await backendWith(bare, "gpt-6-astra").listModels()).map((m) => m.id);
    expect(ids).toContain("gpt-6-astra");
    expect(ids).toContain("gpt-5.6-sol");
    expect(ids).not.toContain("gpt-5.4-mini");
  });
});

describe("isChatGptModel is generation-agnostic", () => {
  it.each(["gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-luna", "gpt-reserve", "gpt-7", "codex-auto-review"])(
    "accepts %s",
    (id) => expect(isChatGptModel(id)).toBe(true),
  );
  // What it is FOR: keeping a Claude id the panel pushes out of a ChatGPT request.
  it.each(["claude-opus-5-5", "claude-sonnet-5", "gpt-oss:20b", "gpt-oss-120b", "qwen3:27b"])(
    "rejects %s",
    (id) => expect(isChatGptModel(id)).toBe(false),
  );

  it("setModel now takes a gen-6 pick instead of silently ignoring it", async () => {
    const b = backendWith(CATALOG, "gpt-5.6-sol");
    await b.setModel("gpt-6-astra");
    expect((await b.listModels())[0].id).toBe("gpt-6-astra");
  });
});
