import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OllamaBackend } from "../../orchestrator/ollama-backend.js";
import { openAiKeyProvider, openAiKeyProviderModel } from "../../services/openai-provider-registry.js";
import { resolveOpenAiKeyCredentials } from "../../services/code-provider-auth.js";
import type { NeutralTurn } from "../../orchestrator/agent-backend.js";

const FLASH = "MiniMax-M3.1-Flash";
const OR_FLASH = "minimax/minimax-m3.1-flash:free";
let catalog: string[];
let catalogStatus: number;
let requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }>;

beforeEach(() => {
  catalog = ["MiniMax-M2.7", "MiniMax-M3", FLASH, "MiniMax-M3-highspeed", "image-01"];
  catalogStatus = 200;
  requests = [];
  vi.stubEnv("MINIMAX_API_KEY", "fixture-minimax-key");
  vi.stubEnv("COMFYUI_MCP_MINIMAX_MODEL", "");
  vi.stubEnv("COMFYUI_MCP_MINIMAX_BASE_URL", "");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: catalog.map((id) => ({ id })) }), { status: catalogStatus });
    }
    if (url.includes("/view?")) {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } });
    }
    if (url.endsWith("/chat/completions")) {
      requests.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// Same registry → credentials → shared backend path as makeOpenAiKeyBackend.
function nativeBackend() {
  const reg = openAiKeyProvider("minimax")!;
  const creds = resolveOpenAiKeyCredentials(reg.id);
  return new OllamaBackend({
    backendId: reg.id,
    model: openAiKeyProviderModel(reg),
    api: "openai",
    host: creds.baseUrl,
    apiKey: creds.apiKey,
    comfyuiUrl: "http://fixture.invalid:8188",
    connectToolClients: async () => ({}),
  });
}

async function run(backend: OllamaBackend, model?: string) {
  async function* channel(): AsyncGenerator<NeutralTurn> {
    yield { text: "describe this", images: [{ filename: "shot.png", type: "input" }] };
  }
  const events = [];
  for await (const event of backend.run({ channel: channel(), model })) events.push(event);
  expect(events).toContainEqual(expect.objectContaining({ type: "result", ok: true }));
  await backend.close();
  return requests[0];
}

describe("MiniMax text choices and actual serialized requests", () => {
  it.each(["https://api.minimax.io/v1", "https://api.minimaxi.com/v1"])("defaults to Flash on %s", async (host) => {
    // The global case exercises the resolver's default; CN uses its documented override.
    if (host.includes("minimaxi.com")) vi.stubEnv("COMFYUI_MCP_MINIMAX_BASE_URL", `${host}/`);
    const backend = nativeBackend();
    expect((await backend.listModels()).map((m) => m.id)).toEqual([FLASH, "MiniMax-M3", "image-01"]);
    const request = await run(backend);
    expect(request.url).toBe(`${host}/chat/completions`);
    expect(request.headers.get("authorization")).toBe("Bearer fixture-minimax-key");
    expect(request.body).toMatchObject({ model: FLASH, stream: true, max_tokens: 8192 });
    for (const field of ["thinking", "reasoning_effort", "reasoning_split", "service_tier"]) {
      expect(request.body).not.toHaveProperty(field);
    }
    const messages = request.body.messages as Array<{ role: string; content: unknown }>;
    expect(messages.find((m) => m.role === "user")?.content).toEqual(expect.arrayContaining([
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw==" } },
    ]));
  });

  it.each(["MiniMax-M3", "MiniMax-M2.7", "my-custom-model"])("preserves explicit model %s", async (model) => {
    vi.stubEnv("COMFYUI_MCP_MINIMAX_MODEL", model);
    const backend = nativeBackend();
    expect((await backend.listModels()).map((m) => m.id)).toContain(model);
    expect((await run(backend)).body.model).toBe(model);
  });

  it("preserves a saved session model at the outgoing boundary", async () => {
    const backend = nativeBackend();
    expect((await run(backend, "MiniMax-M2.7")).body.model).toBe("MiniMax-M2.7");
  });

  it("retains both current choices and the configured legacy model when discovery fails", async () => {
    vi.stubEnv("COMFYUI_MCP_MINIMAX_MODEL", "MiniMax-M2.7");
    catalogStatus = 404;
    expect((await nativeBackend().listModels()).map((m) => m.id)).toEqual([FLASH, "MiniMax-M3", "MiniMax-M2.7"]);
  });

  it("leaves custom endpoint discovery and requests under operator control", async () => {
    vi.stubEnv("COMFYUI_MCP_MINIMAX_BASE_URL", "https://custom.invalid/v1");
    vi.stubEnv("COMFYUI_MCP_MINIMAX_MODEL", "custom-deployment");
    const backend = nativeBackend();
    expect((await backend.listModels()).map((m) => m.id)).toContain("MiniMax-M2.7");
    const request = await run(backend);
    expect(request.url).toBe("https://custom.invalid/v1/chat/completions");
    expect(request.body.model).toBe("custom-deployment");
  });

  it("curates OpenRouter text choices without dropping other providers, media, or a saved legacy model", async () => {
    catalog = ["minimax/minimax-m2.7", "minimax/minimax-01", "minimax/minimax-m3", OR_FLASH, "minimax/image-01", "vendor/other"];
    const backend = new OllamaBackend({
      backendId: "openrouter", api: "openai", host: "https://openrouter.ai/api/v1",
      model: OR_FLASH, apiKey: "fixture-router-key", connectToolClients: async () => ({}),
    });
    expect((await backend.listModels()).map((m) => m.id)).toEqual([
      OR_FLASH, "minimax/minimax-m3", "minimax/image-01", "vendor/other",
    ]);
    const request = await run(backend, "minimax/minimax-m2.7");
    expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(request.body.model).toBe("minimax/minimax-m2.7");
    expect((await backend.listModels()).map((m) => m.id)).toContain("minimax/minimax-m2.7");
  });

  it("sends the verified OpenRouter Flash route verbatim", async () => {
    const backend = new OllamaBackend({
      backendId: "openrouter", api: "openai", host: "https://openrouter.ai/api/v1",
      model: OR_FLASH, apiKey: "fixture-router-key", connectToolClients: async () => ({}),
    });
    expect((await run(backend)).body.model).toBe(OR_FLASH);
  });
});
