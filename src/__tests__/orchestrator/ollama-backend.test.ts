import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OllamaBackend, isOllamaModel, type McpToolClient } from "../../orchestrator/ollama-backend.js";
import type { AgentEvent, NeutralTurn } from "../../orchestrator/agent-backend.js";

// ---------------------------------------------------------------------------
// fetch mock: routes /api/version, /api/tags, and a scripted /api/chat queue.
// Each /api/chat entry is an array of NDJSON chunk objects streamed to the
// backend; request bodies are recorded for assertions.
// ---------------------------------------------------------------------------

type ChatScript = Array<Array<Record<string, unknown>>>;

let chatScript: ChatScript = [];
let chatRequests: Array<{ model: string; messages: Array<Record<string, unknown>>; tools: unknown[] }> = [];
let hangingStreamController: ReadableStreamDefaultController<Uint8Array> | null = null;

function ndjsonStream(chunks: Array<Record<string, unknown>>, hang = false): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(`${JSON.stringify(c)}\n`));
      if (hang) {
        hangingStreamController = controller;
      } else {
        controller.close();
      }
    },
  });
}

let hangNextChat = false;
let modelsRequests: Array<{ url: string; headers: Record<string, string> }> = [];
let modelsResponse: string[] | "404" = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url.endsWith("/api/version")) {
    return new Response(JSON.stringify({ version: "0.31.1" }), { status: 200 });
  }
  if (url.endsWith("/api/tags")) {
    return new Response(
      JSON.stringify({ models: [{ name: "gemma4:e4b" }, { name: "qwen3:4b" }] }),
      { status: 200 },
    );
  }
  if (url.endsWith("/v1/models") || url.endsWith(":1234/models") || url.includes("1234/v1/models")) {
    // openai-dialect model listing (LM Studio-shaped). Capture headers so tests
    // can assert no Authorization leaks when no apiKey is configured.
    modelsRequests.push({ url, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
    if (modelsResponse === "404") return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ data: modelsResponse.map((id) => ({ id })) }), { status: 200 });
  }
  if (url.endsWith("/api/chat")) {
    const body = JSON.parse(String(init?.body));
    chatRequests.push(body);
    const chunks = chatScript.shift();
    if (!chunks) return new Response("no scripted response", { status: 500 });
    const hang = hangNextChat;
    hangNextChat = false;
    const stream = ndjsonStream(chunks, hang);
    // Wire the fetch abort signal through to the stream like undici does.
    if (hang && init?.signal) {
      init.signal.addEventListener("abort", () => {
        try {
          hangingStreamController?.error(new DOMException("aborted", "AbortError"));
        } catch {
          /* already closed */
        }
      });
    }
    return new Response(stream, { status: 200 });
  }
  return new Response("not found", { status: 404 });
});

function fakeMcpClient(tools: Array<{ name: string; description?: string; inputSchema?: unknown }>) {
  const callTool = vi.fn(async ({ name }: { name: string }) => ({
    content: [{ type: "text", text: `result-of-${name}` }],
  }));
  const client: McpToolClient = {
    listTools: async () => ({ tools }),
    callTool: callTool as unknown as McpToolClient["callTool"],
    close: async () => {},
  };
  return { client, callTool };
}

const COMFY_META = [
  { name: "list_tools", description: "Catalog.", inputSchema: { type: "object", properties: {} } },
  { name: "describe_tool", description: "Describe.", inputSchema: { type: "object", properties: {} } },
  { name: "call_tool", description: "Run.", inputSchema: { type: "object", properties: {} } },
];

async function* turnsOf(...turns: NeutralTurn[]): AsyncGenerator<NeutralTurn> {
  for (const t of turns) yield t;
}

async function collect(backend: OllamaBackend, channel: AsyncIterable<NeutralTurn>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of backend.run({ channel })) events.push(ev);
  return events;
}

beforeEach(() => {
  chatScript = [];
  chatRequests = [];
  hangNextChat = false;
  modelsRequests = [];
  modelsResponse = [];
  hangingStreamController = null;
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OllamaBackend", () => {
  it("streams a plain text turn: session first, deltas, one assistant, exactly one ok result", async () => {
    const { client } = fakeMcpClient(COMFY_META);
    const backend = new OllamaBackend({ model: "gemma4:e4b", connectToolClients: async () => ({ comfyui: client }) });
    chatScript.push([
      { message: { content: "Hel" } },
      { message: { content: "lo!" } },
      { message: { content: "" }, done: true, prompt_eval_count: 10, eval_count: 5 },
    ]);

    const events = await collect(backend, turnsOf({ text: "hi" }));
    expect(events[0]).toMatchObject({ type: "session", model: "gemma4:e4b" });
    expect(events.filter((e) => e.type === "assistant_delta").map((e) => (e as { text: string }).text)).toEqual(["Hel", "lo!"]);
    expect(events.filter((e) => e.type === "stream_start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "stream_end")).toHaveLength(1);
    const assistant = events.find((e) => e.type === "assistant") as { text: string; usage?: Record<string, number> };
    expect(assistant.text).toBe("Hello!");
    expect(assistant.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    const results = events.filter((e) => e.type === "result");
    expect(results).toEqual([{ type: "result", ok: true, usage: { input_tokens: 10, output_tokens: 5 } }]);
  });

  it("num_ctx is model-aware: 16384 for stock, OMITTED for the fine-tune (baked 65536 governs), env override wins", async () => {
    const { client } = fakeMcpClient(COMFY_META);
    const oneTurn: Array<Record<string, unknown>> = [{ message: { content: "ok" }, done: true }];

    // Stock model → explicit 16384 (its tag bakes no window; Ollama's own default is 4096).
    let backend = new OllamaBackend({ model: "gemma4:e4b", connectToolClients: async () => ({ comfyui: client }) });
    chatScript.push(oneTurn);
    await collect(backend, turnsOf({ text: "hi" }));
    expect((chatRequests.at(-1) as { options?: unknown }).options).toEqual({ num_ctx: 16384 });

    // Our fine-tune → num_ctx omitted so the Modelfile's 65536 governs (a
    // blanket 16384 here silently truncated conversations mid-flight).
    backend = new OllamaBackend({ model: "artokun/gemma4-comfyui-mcp:e4b", connectToolClients: async () => ({ comfyui: client }) });
    chatScript.push(oneTurn);
    await collect(backend, turnsOf({ text: "hi" }));
    expect((chatRequests.at(-1) as { options?: unknown }).options).toEqual({});

    // COMFYUI_MCP_OLLAMA_NUM_CTX beats everything (e.g. 128K on big VRAM).
    process.env.COMFYUI_MCP_OLLAMA_NUM_CTX = "131072";
    try {
      backend = new OllamaBackend({ model: "artokun/gemma4-comfyui-mcp:e4b", connectToolClients: async () => ({ comfyui: client }) });
      chatScript.push(oneTurn);
      await collect(backend, turnsOf({ text: "hi" }));
      expect((chatRequests.at(-1) as { options?: unknown }).options).toEqual({ num_ctx: 131072 });
    } finally {
      delete process.env.COMFYUI_MCP_OLLAMA_NUM_CTX;
    }
  });

  it("breaks a tool loop: identical repeat calls are blocked, 4th repeat ends the turn", async () => {
    const { client, callTool } = fakeMcpClient(COMFY_META);
    const backend = new OllamaBackend({ model: "gemma4:e4b", connectToolClients: async () => ({ comfyui: client }) });
    const sameCall = [
      { message: { content: "", tool_calls: [{ function: { name: "list_tools", arguments: { search: "krea" } } }] }, done: true },
    ];
    // The model re-issues the exact same call every round, forever.
    chatScript.push(sameCall, sameCall, sameCall, sameCall, sameCall, sameCall);

    const events = await collect(backend, turnsOf({ text: "find krea" }));
    // Dispatched exactly once — repeats got the corrective nudge, not a re-run.
    expect(callTool).toHaveBeenCalledTimes(1);
    // Repeat calls receive the nudge as their tool result on the wire.
    const nudges = chatRequests
      .flatMap((r) => r.messages)
      .filter((m) => m.role === "tool" && String(m.content).startsWith("REPEAT CALL BLOCKED"));
    expect(nudges.length).toBeGreaterThanOrEqual(1);
    // Turn ends with the loop-breaker, not max_tool_rounds (32 rounds later).
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: false, subtype: "tool_loop" },
    ]);
    expect(chatRequests.length).toBeLessThanOrEqual(5);
  });

  it("recovers an EMPTY final after tool rounds with one summarize nudge (never loops)", async () => {
    const { client } = fakeMcpClient(COMFY_META);
    const backend = new OllamaBackend({ model: "artokun/gemma4-comfyui-mcp:e4b", connectToolClients: async () => ({ comfyui: client }) });
    chatScript.push(
      // round 0: one tool call
      [{ message: { content: "", tool_calls: [{ function: { name: "list_tools", arguments: {} } }] }, done: true }],
      // round 1: EMPTY final (the live-E2E quirk) → should trigger the nudge
      [{ message: { content: "" }, done: true }],
      // round 2: the nudged summary
      [{ message: { content: "I found download_civitai_model — give me a model id and I'll fetch it." }, done: true }],
    );
    const events = await collect(backend, turnsOf({ text: "find a lora" }));
    const assistant = events.filter((e) => e.type === "assistant") as Array<{ text: string }>;
    expect(assistant).toHaveLength(1);
    expect(assistant[0].text).toContain("download_civitai_model");
    // The nudge rode the wire as a user message exactly once.
    const nudges = chatRequests.flatMap((r) => r.messages).filter((m) => m.role === "user" && String(m.content).includes("your reply was EMPTY"));
    expect(nudges).toHaveLength(1);
    expect(events.filter((e) => e.type === "result")).toMatchObject([{ type: "result", ok: true }]);

    // Second empty in a row → falls through (empty answer, but NO infinite nudging).
    chatScript.push(
      [{ message: { content: "", tool_calls: [{ function: { name: "list_tools", arguments: { search: "x" } } }] }, done: true }],
      [{ message: { content: "" }, done: true }],
      [{ message: { content: "" }, done: true }],
    );
    const backend2 = new OllamaBackend({ model: "artokun/gemma4-comfyui-mcp:e4b", connectToolClients: async () => ({ comfyui: client }) });
    const events2 = await collect(backend2, turnsOf({ text: "find a lora" }));
    expect(events2.filter((e) => e.type === "result")).toMatchObject([{ type: "result", ok: true }]);
    // …but never SILENTLY: the double-empty turn still shows a fallback line
    // (live panel test: Civitai 503 → double empty → user saw nothing at all).
    const finals2 = events2.filter((e) => e.type === "assistant") as Array<{ text: string }>;
    expect(finals2).toHaveLength(1);
    expect(finals2[0].text).toContain("couldn't compose a reply");
  });

  it("breaks a DISCOVERY loop: list_tools with a different search each round (the Civitai-hunt wedge)", async () => {
    const { client, callTool } = fakeMcpClient(COMFY_META);
    const backend = new OllamaBackend({ model: "gemma4:e4b", connectToolClients: async () => ({ comfyui: client }) });
    // Every round the model searches list_tools with a NEW query — the exact-
    // repeat breaker can't see these as repeats, but the discovery counter can.
    const search = (q: string) => [
      { message: { content: "", tool_calls: [{ function: { name: "list_tools", arguments: { search: q } } }] }, done: true },
    ];
    chatScript.push(
      search("civitai"), search("lora"), search("flux"), search("download lora"),
      search("model search"), search("find civitai"), search("browse"), search("more"),
    );
    const events = await collect(backend, turnsOf({ text: "find a good Flux LoRA on Civitai and add it" }));
    // The first 3 distinct searches dispatch; the 4th+ get the SEARCH LIMIT nudge
    // (which names the Civitai reality) instead of another catalog dump.
    expect(callTool).toHaveBeenCalledTimes(3);
    const limitNudges = chatRequests
      .flatMap((r) => r.messages)
      .filter((m) => m.role === "tool" && String(m.content).startsWith("SEARCH LIMIT"));
    expect(limitNudges.length).toBeGreaterThanOrEqual(1);
    expect(String(limitNudges[0].content)).toContain("Civitai");
    // And the turn ends on the loop-breaker, not by running to max_tool_rounds.
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: false, subtype: "tool_loop" },
    ]);
  });

  it("dispatches comfyui meta-tool calls and feeds results back to the next request", async () => {
    const { client, callTool } = fakeMcpClient(COMFY_META);
    const backend = new OllamaBackend({ model: "gemma4:e4b", connectToolClients: async () => ({ comfyui: client }) });
    chatScript.push(
      [
        { message: { content: "", tool_calls: [{ function: { name: "list_tools", arguments: {} } }] }, done: true },
      ],
      [{ message: { content: "done!" }, done: true }],
    );

    const events = await collect(backend, turnsOf({ text: "what can you do?" }));
    expect(callTool).toHaveBeenCalledWith({ name: "list_tools", arguments: {} });
    const toolEvents = events.filter((e) => e.type === "tool_call");
    expect(toolEvents).toMatchObject([
      { name: "list_tools", phase: "start" },
      { name: "list_tools", phase: "end" },
    ]);
    // second request must carry the tool result back
    const second = chatRequests[1];
    const toolMsg = second.messages.find((m) => m.role === "tool");
    expect(toolMsg).toMatchObject({ tool_name: "list_tools", content: "result-of-list_tools" });
    expect(events.filter((e) => e.type === "result")).toEqual([{ type: "result", ok: true, usage: expect.anything() }]);
  });

  it("synthesizes panel meta-tools over the panel MCP client", async () => {
    const { client: comfy } = fakeMcpClient(COMFY_META);
    const { client: panel, callTool: panelCall } = fakeMcpClient([
      { name: "panel_focus_node", description: "Focus a node in the canvas. Long detail here." },
      { name: "panel_clear", description: "Clear the graph." },
    ]);
    const backend = new OllamaBackend({
      model: "gemma4:e4b",
      connectToolClients: async () => ({ comfyui: comfy, panel }),
    });
    chatScript.push(
      [{ message: { content: "", tool_calls: [{ function: { name: "panel_list_tools", arguments: {} } }] }, done: true }],
      [
        {
          message: {
            content: "",
            tool_calls: [
              { function: { name: "panel_call_tool", arguments: { name: "panel_focus_node", args: '{"node_id": 3}' } } },
            ],
          },
          done: true,
        },
      ],
      [{ message: { content: "focused." }, done: true }],
    );

    const events = await collect(backend, turnsOf({ text: "focus node 3" }));
    // the manifest fed back after panel_list_tools names both tools, one line each
    const listResult = chatRequests[1].messages.filter((m) => m.role === "tool").at(-1);
    expect(String(listResult?.content)).toContain("panel_focus_node: Focus a node in the canvas.");
    expect(String(listResult?.content)).toContain("panel_clear");
    expect(String(listResult?.content)).not.toContain("Long detail here");
    // panel_call_tool unwrapped the JSON-string args and dispatched the real tool
    expect(panelCall).toHaveBeenCalledWith({ name: "panel_focus_node", arguments: { node_id: 3 } });
    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
  });

  it("the model sees exactly six tools", async () => {
    const { client: comfy } = fakeMcpClient(COMFY_META);
    const { client: panel } = fakeMcpClient([{ name: "panel_focus_node", description: "x" }]);
    const backend = new OllamaBackend({
      model: "gemma4:e4b",
      connectToolClients: async () => ({ comfyui: comfy, panel }),
    });
    chatScript.push([{ message: { content: "hi" }, done: true }]);
    await collect(backend, turnsOf({ text: "hello" }));
    const names = (chatRequests[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(names.sort()).toEqual([
      "call_tool",
      "describe_tool",
      "list_tools",
      "panel_call_tool",
      "panel_describe_tool",
      "panel_list_tools",
    ]);
  });

  it("emits error + exactly one failed result when ollama errors mid-turn", async () => {
    const { client } = fakeMcpClient(COMFY_META);
    const backend = new OllamaBackend({ model: "gemma4:e4b", connectToolClients: async () => ({ comfyui: client }) });
    // no chatScript entries -> /api/chat returns 500

    const events = await collect(backend, turnsOf({ text: "hi" }));
    expect(events.some((e) => e.type === "error")).toBe(true);
    const results = events.filter((e) => e.type === "result");
    expect(results).toEqual([{ type: "result", ok: false, subtype: "error" }]);
  });

  it("interrupt() aborts the in-flight stream and yields one interrupted result", async () => {
    const { client } = fakeMcpClient(COMFY_META);
    const backend = new OllamaBackend({ model: "gemma4:e4b", connectToolClients: async () => ({ comfyui: client }) });
    hangNextChat = true;
    chatScript.push([{ message: { content: "thinking…" } }]); // stream stays open

    const events: AgentEvent[] = [];
    const done = (async () => {
      for await (const ev of backend.run({ channel: turnsOf({ text: "hi" }) })) {
        events.push(ev);
        if (ev.type === "assistant_delta") void backend.interrupt();
      }
    })();
    await done;
    const results = events.filter((e) => e.type === "result");
    expect(results).toEqual([{ type: "result", ok: false, subtype: "interrupted" }]);
    expect(events.some((e) => e.type === "error")).toBe(false); // interrupt is not an error
  });

  it("keeps the configured model when the panel passes a Claude id, honors a real tag", async () => {
    const { client } = fakeMcpClient(COMFY_META);
    const backend = new OllamaBackend({ model: "gemma4:e4b", connectToolClients: async () => ({ comfyui: client }) });
    chatScript.push([{ message: { content: "a" }, done: true }]);
    for await (const _ of backend.run({ channel: turnsOf({ text: "x" }), model: "claude-opus-4-8" })) {
      // drain
    }
    expect(chatRequests[0].model).toBe("gemma4:e4b");

    chatScript.push([{ message: { content: "b" }, done: true }]);
    for await (const _ of backend.run({ channel: turnsOf({ text: "y" }), model: "qwen3:4b" })) {
      // drain
    }
    expect(chatRequests[1].model).toBe("qwen3:4b");
  });

  it("listModels maps /api/tags to ModelChoice[]", async () => {
    const backend = new OllamaBackend({ connectToolClients: async () => ({}) });
    expect(await backend.listModels()).toEqual([
      { id: "gemma4:e4b", label: "gemma4:e4b" },
      { id: "qwen3:4b", label: "qwen3:4b" },
    ]);
  });

  it("lmstudio-shaped openai dialect: listModels lists served ids and sends NO auth header without a key", async () => {
    const backend = new OllamaBackend({ api: "openai", host: "http://127.0.0.1:1234/v1", model: "qwen2.5-7b" });
    modelsResponse = ["qwen2.5-7b", "gemma-4-e4b"];
    const models = await backend.listModels();
    expect(models.map((m) => m.id)).toContain("qwen2.5-7b");
    expect(models.map((m) => m.id)).toContain("gemma-4-e4b");
    expect(modelsRequests).toHaveLength(1);
    const headerKeys = Object.keys(modelsRequests[0].headers).map((k) => k.toLowerCase());
    expect(headerKeys).not.toContain("authorization");
  });

  it("openai dialect: listModels falls back to the configured model when /models 404s", async () => {
    const backend = new OllamaBackend({ api: "openai", host: "http://127.0.0.1:1234/v1", model: "my-local-model" });
    modelsResponse = "404";
    const models = await backend.listModels();
    expect(models).toEqual([{ id: "my-local-model", label: "my-local-model" }]);
  });

  it("isOllamaModel accepts local tags and rejects provider ids", () => {
    expect(isOllamaModel("qwen3:4b")).toBe(true);
    expect(isOllamaModel("gemma4:e4b")).toBe(true);
    expect(isOllamaModel("claude-opus-4-8")).toBe(false);
    expect(isOllamaModel("gemini-2.5-pro")).toBe(false);
    expect(isOllamaModel("gpt-5.5")).toBe(false);
  });
});
