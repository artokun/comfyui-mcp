import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OllamaBackend,
  comfyuiSpawnEnv,
  comfyuiSpawnToolMode,
  acceptsModelId,
  isOllamaModel,
  ollamaSystemPrompt,
  type McpToolClient,
} from "../../orchestrator/ollama-backend.js";
import { PANEL_TOOL_MCP_TIMEOUT_MS, __panelAskTestHooks } from "../../orchestrator/panel-tools.js";
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
/** When set, the NEXT chat request (either dialect) 400s with this text —
 *  simulates a text-only model/endpoint rejecting image input. */
let rejectNextChatWith: string | null = null;
/** Requests to the openai dialect's /chat/completions (body recorded). */
let openaiChatRequests: Array<{ model: string; messages: Array<Record<string, unknown>> }> = [];

function sseStream(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n`));
      controller.enqueue(enc.encode("data: [DONE]\n"));
      controller.close();
    },
  });
}

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
  if (url.includes("/view?")) {
    // ComfyUI image fetch for inline vision delivery: 4 PNG-ish bytes suffice.
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }
  if (url.endsWith("/chat/completions")) {
    const body = JSON.parse(String(init?.body));
    openaiChatRequests.push(body);
    if (rejectNextChatWith) {
      const msg = rejectNextChatWith;
      rejectNextChatWith = null;
      return new Response(msg, { status: 400 });
    }
    return new Response(sseStream([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]), {
      status: 200,
    });
  }
  if (url.endsWith("/api/chat")) {
    const body = JSON.parse(String(init?.body));
    chatRequests.push(body);
    if (rejectNextChatWith) {
      const msg = rejectNextChatWith;
      rejectNextChatWith = null;
      return new Response(msg, { status: 400 });
    }
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
  rejectNextChatWith = null;
  openaiChatRequests = [];
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
    expect(results).toEqual([{ type: "result", ok: true, turn: 1, usage: { input_tokens: 10, output_tokens: 5 } }]);
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
    // blanket 16384 here silently truncated conversations mid-flight) — but
    // Gemma-recommended sampling IS sent, un-baking the Modelfile's greedy
    // temperature 0 (the "goes in circles" loop machine).
    backend = new OllamaBackend({ model: "artokun/gemma4-comfyui-mcp:e4b", connectToolClients: async () => ({ comfyui: client }) });
    chatScript.push(oneTurn);
    await collect(backend, turnsOf({ text: "hi" }));
    expect((chatRequests.at(-1) as { options?: unknown }).options).toEqual({ temperature: 1.0, top_k: 64, top_p: 0.95 });

    // COMFYUI_MCP_OLLAMA_NUM_CTX beats everything (e.g. 128K on big VRAM).
    process.env.COMFYUI_MCP_OLLAMA_NUM_CTX = "131072";
    try {
      backend = new OllamaBackend({ model: "artokun/gemma4-comfyui-mcp:e4b", connectToolClients: async () => ({ comfyui: client }) });
      chatScript.push(oneTurn);
      await collect(backend, turnsOf({ text: "hi" }));
      expect((chatRequests.at(-1) as { options?: unknown }).options).toEqual({ num_ctx: 131072, temperature: 1.0, top_k: 64, top_p: 0.95 });
    } finally {
      delete process.env.COMFYUI_MCP_OLLAMA_NUM_CTX;
    }

    // Sampling env overrides replace the fine-tune defaults wholesale — an
    // explicit experiment (even temp 0) must win over our recommended trio.
    process.env.COMFYUI_MCP_OLLAMA_TEMPERATURE = "0";
    try {
      backend = new OllamaBackend({ model: "artokun/gemma4-comfyui-mcp:e4b", connectToolClients: async () => ({ comfyui: client }) });
      chatScript.push(oneTurn);
      await collect(backend, turnsOf({ text: "hi" }));
      expect((chatRequests.at(-1) as { options?: unknown }).options).toEqual({ temperature: 0 });
    } finally {
      delete process.env.COMFYUI_MCP_OLLAMA_TEMPERATURE;
    }

    // Stock models get NO sampling injection — their tags' own tuning governs.
    backend = new OllamaBackend({ model: "gemma4:e4b", connectToolClients: async () => ({ comfyui: client }) });
    chatScript.push(oneTurn);
    await collect(backend, turnsOf({ text: "hi" }));
    expect((chatRequests.at(-1) as { options?: unknown }).options).toEqual({ num_ctx: 16384 });
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
      { type: "result", ok: false, subtype: "tool_loop", turn: 1 },
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
    // The live panel wedge: hunting "lora loader" in the headless catalog —
    // the nudge must point graph actions at the panel router.
    expect(String(limitNudges[0].content)).toContain("panel_add_node");
    // And the turn ends on the loop-breaker, not by running to max_tool_rounds.
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: false, subtype: "tool_loop", turn: 1 },
    ]);
  });

  /**
   * 0.50.0 slice 11 folded the HuggingFace model search into
   * download_model action:"search", so the discovery counter had to become
   * action-aware. Keyed on the bare name it would count a download as a catalog
   * search — and four downloads in one turn would be answered with SEARCH LIMIT
   * instead of downloading, which is a fold turning legitimate calls into
   * refusals (#839).
   */
  it("the discovery breaker counts download_model's SEARCH action, never its downloads", async () => {
    const tools = [
      ...COMFY_META,
      { name: "download_model", description: "Models.", inputSchema: { type: "object", properties: {} } },
    ];

    // Six DIFFERENT downloads in one turn: distinct args, so the exact-repeat
    // breaker cannot fire either. Every one must dispatch.
    {
      const { client, callTool } = fakeMcpClient(tools);
      const backend = new OllamaBackend({ model: "gemma4:e4b", connectToolClients: async () => ({ comfyui: client }) });
      const dl = (n: number) => [
        {
          message: {
            content: "",
            tool_calls: [
              {
                function: {
                  name: "download_model",
                  arguments: { action: "download", url: `https://h/${n}.safetensors`, target_subfolder: "loras" },
                },
              },
            ],
          },
          done: true,
        },
      ];
      chatScript.push(dl(1), dl(2), dl(3), dl(4), dl(5), dl(6), [{ message: { content: "all six queued" }, done: true }]);
      await collect(backend, turnsOf({ text: "grab these six LoRAs" }));
      expect(callTool).toHaveBeenCalledTimes(6);
      const nudges = chatRequests
        .flatMap((r) => r.messages)
        .filter((m) => m.role === "tool" && String(m.content).startsWith("SEARCH LIMIT"));
      expect(nudges).toEqual([]);
    }

    // …while the SEARCH action still wedges out at the same threshold.
    {
      chatRequests = [];
      const { client, callTool } = fakeMcpClient(tools);
      const backend = new OllamaBackend({ model: "gemma4:e4b", connectToolClients: async () => ({ comfyui: client }) });
      const search = (q: string) => [
        {
          message: {
            content: "",
            tool_calls: [{ function: { name: "download_model", arguments: { action: "search", query: q } } }],
          },
          done: true,
        },
      ];
      chatScript.push(
        search("flux"), search("sdxl"), search("wan"), search("qwen"),
        search("ltx"), search("krea"), search("pony"), search("hunyuan"),
      );
      const events = await collect(backend, turnsOf({ text: "find me anything" }));
      expect(callTool).toHaveBeenCalledTimes(3);
      const nudges = chatRequests
        .flatMap((r) => r.messages)
        .filter((m) => m.role === "tool" && String(m.content).startsWith("SEARCH LIMIT"));
      expect(nudges.length).toBeGreaterThanOrEqual(1);
      // The nudge names the ACTION, so the model is not told to stop calling
      // download_model altogether.
      expect(String(nudges[0].content)).toContain('download_model action:"search"');
      expect(events.filter((e) => e.type === "result")).toEqual([
        { type: "result", ok: false, subtype: "tool_loop", turn: 1 },
      ]);
    }
  });

  /**
   * 0.50.0 slice 12 folded the pack-DETAILS lookup into `search_custom_nodes` as
   * action:"details". The discovery counter keys per DISCOVERY TOOL, and that
   * retired name was never one — so keying on the NAME after the fold
   * would start counting a call that never counted before, on the workflow that
   * is CORRECT: search once, then read details for three or four candidate
   * packs. The fourth would be answered with "STOP searching — it is very likely
   * NOT in this catalog" while the model is doing exactly the right thing, and
   * at eight the turn breaks outright. An invented refusal manufactured by a
   * pure surface change is the same defect class as a lost one.
   *
   * Both directions have to hold: the corrective must still fire on repeated
   * keyword SEARCHES, and must never fire on detail lookups.
   */
  describe("the discovery loop-breaker counts the search ACTION, not the folded tool name", () => {
    const call = (args: Record<string, unknown>) => [
      {
        message: {
          content: "",
          tool_calls: [{ function: { name: "search_custom_nodes", arguments: args } }],
        },
        done: true,
      },
    ];
    const nudges = () =>
      chatRequests
        .flatMap((r) => r.messages)
        .filter((m) => m.role === "tool" && String(m.content).startsWith("SEARCH LIMIT"));

    it("does NOT break a loop of distinct DETAIL lookups", async () => {
      const { client, callTool } = fakeMcpClient(COMFY_META);
      const backend = new OllamaBackend({
        model: "gemma4:e4b",
        connectToolClients: async () => ({ comfyui: client }),
      });
      // EIGHT distinct detail lookups — past the discovery threshold that
      // breaks the turn — with different args each time, so the exact-repeat
      // breaker cannot see them either. Every one must dispatch, because
      // get_node_pack_details never counted before the fold.
      for (const id of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
        chatScript.push(call({ action: "details", id: `${id}-pack` }));
      }
      chatScript.push([{ message: { content: "done" }, done: true }]);
      await collect(backend, turnsOf({ text: "compare these eight packs for me" }));
      expect(callTool).toHaveBeenCalledTimes(8);
      expect(nudges()).toHaveLength(0);
    });

    it("STILL breaks a loop of distinct registry searches", async () => {
      const { client, callTool } = fakeMcpClient(COMFY_META);
      const backend = new OllamaBackend({
        model: "gemma4:e4b",
        connectToolClients: async () => ({ comfyui: client }),
      });
      for (const query of [
        "lora", "flux", "civitai", "detailer", "upscale", "sampler", "controlnet", "vae",
      ]) {
        chatScript.push(call({ action: "search", query }));
      }
      const events = await collect(backend, turnsOf({ text: "find me a pack" }));
      // First 3 dispatch; the 4th+ get the corrective instead of another search.
      expect(callTool).toHaveBeenCalledTimes(3);
      expect(nudges().length).toBeGreaterThanOrEqual(1);
      // The corrective names the CALL, not just the tool — telling a model to
      // stop calling `search_custom_nodes` outright would also stop it reading
      // the details of a pack it has already found.
      expect(String(nudges()[0].content)).toContain('search_custom_nodes action:"search"');
      expect(events.filter((e) => e.type === "result")).toEqual([
        { type: "result", ok: false, subtype: "tool_loop", turn: 1 },
      ]);
    });
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
    expect(events.filter((e) => e.type === "result")).toEqual([{ type: "result", ok: true, turn: 1, usage: expect.anything() }]);
  });

  it("a retired comfy tool name gets the ledger's specific error, not the bare Available list (#659)", async () => {
    // No call_tool meta on the comfy client, so the forgiving direct dispatch
    // falls through to the backend's own unknown-tool fallback — the path that
    // used to answer with the full Available list.
    const { client } = fakeMcpClient([{ name: "get_queue", description: "x" }]);
    const backend = new OllamaBackend({ model: "gemma4:e4b", connectToolClients: async () => ({ comfyui: client }) });
    chatScript.push(
      [{ message: { content: "", tool_calls: [{ function: { name: "apps_list", arguments: {} } }] }, done: true }],
      [{ message: { content: "done" }, done: true }],
    );

    await collect(backend, turnsOf({ text: "list my apps" }));
    const toolMsg = chatRequests[1].messages.find((m) => m.role === "tool");
    const content = String(toolMsg?.content);
    expect(content).toContain("removed in 0.49.0");
    expect(content).toContain('apps (action:"list")');
    expect(content).not.toContain("Available:");
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
    // panel_call_tool unwrapped the JSON-string args and dispatched the real tool —
    // carrying the #325 request timeout that covers long-blocking card tools.
    expect(panelCall).toHaveBeenCalledWith(
      { name: "panel_focus_node", arguments: { node_id: 3 } },
      undefined,
      { timeout: PANEL_TOOL_MCP_TIMEOUT_MS },
    );
    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
  });

  it("unwraps a router-self-nested panel_call_tool envelope instead of refusing the real call (#1297)", async () => {
    const { client: comfy } = fakeMcpClient(COMFY_META);
    const { client: panel, callTool: panelCall } = fakeMcpClient([
      { name: "panel_focus_node", description: "Focus a node in the canvas." },
    ]);
    const backend = new OllamaBackend({
      model: "gemma4:e4b",
      connectToolClients: async () => ({ comfyui: comfy, panel }),
    });
    chatScript.push(
      [
        {
          message: {
            content: "",
            tool_calls: [
              // the malformed shape from the issue: the model wrapped the real
              // call in a second panel_call_tool envelope.
              {
                function: {
                  name: "panel_call_tool",
                  arguments: { name: "panel_call_tool", args: { name: "panel_focus_node", args: { node_id: 3 } } },
                },
              },
            ],
          },
          done: true,
        },
      ],
      [{ message: { content: "focused." }, done: true }],
    );

    await collect(backend, turnsOf({ text: "focus node 3" }));
    // the inner call ran exactly as spelled out — name and args unwrapped once
    expect(panelCall).toHaveBeenCalledWith(
      { name: "panel_focus_node", arguments: { node_id: 3 } },
      undefined,
      { timeout: PANEL_TOOL_MCP_TIMEOUT_MS },
    );
    const toolMsg = chatRequests[1].messages.find((m) => m.role === "tool");
    const content = String(toolMsg?.content);
    // the recovery is disclosed, and the correct shape is taught for next time
    expect(content).toContain("Recovered a nested panel_call_tool envelope");
    expect(content).toContain('panel_call_tool {"name": "panel_focus_node"');
    expect(content).toContain("result-of-panel_focus_node");
    expect(content).not.toContain("Unknown panel tool");
  });

  it("a router self-call WITHOUT a real nested panel tool is refused with the correct shape (#1297)", async () => {
    const { client: comfy } = fakeMcpClient(COMFY_META);
    const { client: panel, callTool: panelCall } = fakeMcpClient([
      { name: "panel_focus_node", description: "Focus a node in the canvas." },
    ]);
    const backend = new OllamaBackend({
      model: "gemma4:e4b",
      connectToolClients: async () => ({ comfyui: comfy, panel }),
    });
    chatScript.push(
      [
        {
          message: {
            content: "",
            tool_calls: [
              // nested envelope names a tool that does not exist — fail closed.
              {
                function: {
                  name: "panel_call_tool",
                  arguments: { name: "panel_call_tool", args: { name: "panel_nope" } },
                },
              },
              // bare self-call with no envelope at all
              { function: { name: "panel_call_tool", arguments: { name: "panel_list_tools" } } },
            ],
          },
          done: true,
        },
      ],
      [{ message: { content: "sorry" }, done: true }],
    );

    await collect(backend, turnsOf({ text: "do the thing" }));
    expect(panelCall).not.toHaveBeenCalled();
    const toolMsgs = chatRequests[1].messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(toolMsgs).toHaveLength(2);
    for (const content of toolMsgs) {
      expect(content).toContain("is this router itself, not a panel tool");
      expect(content).toContain('panel_call_tool {"name": "<panel tool>", "args": {...}}');
      expect(content).not.toContain("Unknown panel tool");
    }
  });

  // #1937 — ChatGPT's multi_tool_use.parallel names each recipient's payload
  // `parameters`, and after the first call in a batch the model copies that key
  // inward instead of `args`. #1824 fixed the headless `call_tool` facade for
  // exactly this; the panel router was left on `args ?? arguments` alone, so the
  // real payload was dropped and `panel_set_widget` was invoked with `{}` —
  // reaching the panel MCP server's strict schema as
  // "MCP error -32602: Input validation error ... received undefined at node_id;
  //  expected string, received undefined at widget", with the arguments the model
  // actually wrote sitting one key away.
  it("panel_call_tool runs the call when the payload is under `parameters` instead of `args` (#1937)", async () => {
    const { client: comfy } = fakeMcpClient(COMFY_META);
    const { client: panel, callTool: panelCall } = fakeMcpClient([
      { name: "panel_set_widget", description: "Set a widget value." },
    ]);
    const backend = new OllamaBackend({
      model: "gemma4:e4b",
      connectToolClients: async () => ({ comfyui: comfy, panel }),
    });
    chatScript.push(
      [
        {
          message: {
            content: "",
            tool_calls: [
              {
                function: {
                  name: "panel_call_tool",
                  arguments: {
                    name: "panel_set_widget",
                    parameters: { node_id: 30, widget: "frame_load_cap", value: 192 },
                  },
                },
              },
            ],
          },
          done: true,
        },
      ],
      [{ message: { content: "set." }, done: true }],
    );

    await collect(backend, turnsOf({ text: "set frame_load_cap to 192" }));
    expect(panelCall).toHaveBeenCalledWith(
      { name: "panel_set_widget", arguments: { node_id: 30, widget: "frame_load_cap", value: 192 } },
      undefined,
      { timeout: PANEL_TOOL_MCP_TIMEOUT_MS },
    );
  });

  // The reporter's wire shape, not a convenient one: the ChatGPT backend hands
  // `dispatch` the Responses API's `function_call.arguments` — a JSON STRING — so
  // the wrapper key arrives inside text that dispatch parses first. Pinned
  // separately because a fix that only ever saw a pre-parsed object would look
  // green while the path that actually reported the bug stayed broken.
  it("panel_call_tool accepts a `parameters` payload arriving as a JSON string (#1937)", async () => {
    const { client: comfy } = fakeMcpClient(COMFY_META);
    const { client: panel, callTool: panelCall } = fakeMcpClient([
      { name: "panel_set_widget", description: "Set a widget value." },
    ]);
    const backend = new OllamaBackend({
      model: "gemma4:e4b",
      connectToolClients: async () => ({ comfyui: comfy, panel }),
    });
    chatScript.push(
      [
        {
          message: {
            content: "",
            tool_calls: [
              {
                function: {
                  name: "panel_call_tool",
                  arguments:
                    '{"name":"panel_set_widget","parameters":{"node_id":30,"widget":"frame_load_cap","value":192}}',
                },
              },
            ],
          },
          done: true,
        },
      ],
      [{ message: { content: "set." }, done: true }],
    );

    await collect(backend, turnsOf({ text: "set frame_load_cap to 192" }));
    expect(panelCall).toHaveBeenCalledWith(
      { name: "panel_set_widget", arguments: { node_id: 30, widget: "frame_load_cap", value: 192 } },
      undefined,
      { timeout: PANEL_TOOL_MCP_TIMEOUT_MS },
    );
  });

  it("panel_call_tool prefers `args` over a colliding `parameters` wrapper (#1937)", async () => {
    const { client: comfy } = fakeMcpClient(COMFY_META);
    const { client: panel, callTool: panelCall } = fakeMcpClient([
      { name: "panel_set_widget", description: "Set a widget value." },
    ]);
    const backend = new OllamaBackend({
      model: "gemma4:e4b",
      connectToolClients: async () => ({ comfyui: comfy, panel }),
    });
    chatScript.push(
      [
        {
          message: {
            content: "",
            tool_calls: [
              {
                function: {
                  name: "panel_call_tool",
                  arguments: {
                    name: "panel_set_widget",
                    args: { node_id: 30, widget: "from_args", value: 1 },
                    parameters: { node_id: 99, widget: "from_parameters", value: 2 },
                  },
                },
              },
            ],
          },
          done: true,
        },
      ],
      [{ message: { content: "set." }, done: true }],
    );

    await collect(backend, turnsOf({ text: "set it" }));
    expect(panelCall).toHaveBeenCalledWith(
      { name: "panel_set_widget", arguments: { node_id: 30, widget: "from_args", value: 1 } },
      undefined,
      { timeout: PANEL_TOOL_MCP_TIMEOUT_MS },
    );
  });

  it("unwraps a self-nested envelope whose INNER payload is under `parameters` (#1937)", async () => {
    const { client: comfy } = fakeMcpClient(COMFY_META);
    const { client: panel, callTool: panelCall } = fakeMcpClient([
      { name: "panel_set_widget", description: "Set a widget value." },
    ]);
    const backend = new OllamaBackend({
      model: "gemma4:e4b",
      connectToolClients: async () => ({ comfyui: comfy, panel }),
    });
    chatScript.push(
      [
        {
          message: {
            content: "",
            tool_calls: [
              {
                function: {
                  name: "panel_call_tool",
                  arguments: {
                    name: "panel_call_tool",
                    args: {
                      name: "panel_set_widget",
                      parameters: { node_id: 30, widget: "frame_load_cap", value: 192 },
                    },
                  },
                },
              },
            ],
          },
          done: true,
        },
      ],
      [{ message: { content: "set." }, done: true }],
    );

    await collect(backend, turnsOf({ text: "set it" }));
    expect(panelCall).toHaveBeenCalledWith(
      { name: "panel_set_widget", arguments: { node_id: 30, widget: "frame_load_cap", value: 192 } },
      undefined,
      { timeout: PANEL_TOOL_MCP_TIMEOUT_MS },
    );
  });

  // The same wrapper key, one hop away: the FORGIVING DIRECT DISPATCH path below
  // the router exists because models call a panel tool by its bare name, and
  // `multi_tool_use.parallel` names THAT payload `parameters` too. Forwarded raw
  // it hits the panel server's strict schema as an unrecognized key AND two
  // missing required fields.
  it("a bare-name panel call unwraps a lone `parameters` wrapper (#1937)", async () => {
    const { client: comfy } = fakeMcpClient(COMFY_META);
    const { client: panel, callTool: panelCall } = fakeMcpClient([
      { name: "panel_set_widget", description: "Set a widget value." },
    ]);
    const backend = new OllamaBackend({
      model: "gemma4:e4b",
      connectToolClients: async () => ({ comfyui: comfy, panel }),
    });
    chatScript.push(
      [
        {
          message: {
            content: "",
            tool_calls: [
              {
                function: {
                  name: "panel_set_widget",
                  arguments: { parameters: { node_id: 30, widget: "frame_load_cap", value: 192 } },
                },
              },
            ],
          },
          done: true,
        },
      ],
      [{ message: { content: "set." }, done: true }],
    );

    await collect(backend, turnsOf({ text: "set frame_load_cap to 192" }));
    expect(panelCall).toHaveBeenCalledWith(
      { name: "panel_set_widget", arguments: { node_id: 30, widget: "frame_load_cap", value: 192 } },
      undefined,
      { timeout: PANEL_TOOL_MCP_TIMEOUT_MS },
    );
  });

  // The unwrap must never eat a payload the tool actually declares. panel_add_mcp
  // takes a real `args` array today, and a tool taking `parameters` must reach its
  // handler with that key intact — otherwise the recovery silently deletes a
  // legitimate argument.
  it("does NOT unwrap `parameters` when the panel tool declares it (#1937)", async () => {
    const { client: comfy } = fakeMcpClient(COMFY_META);
    const { client: panel, callTool: panelCall } = fakeMcpClient([
      {
        name: "panel_takes_parameters",
        description: "A tool whose own schema has a parameters field.",
        inputSchema: { type: "object", properties: { parameters: { type: "object" } } },
      },
    ]);
    const backend = new OllamaBackend({
      model: "gemma4:e4b",
      connectToolClients: async () => ({ comfyui: comfy, panel }),
    });
    chatScript.push(
      [
        {
          message: {
            content: "",
            tool_calls: [
              {
                function: {
                  name: "panel_takes_parameters",
                  arguments: { parameters: { depth: 3 } },
                },
              },
            ],
          },
          done: true,
        },
      ],
      [{ message: { content: "ok." }, done: true }],
    );

    await collect(backend, turnsOf({ text: "run it" }));
    expect(panelCall).toHaveBeenCalledWith(
      { name: "panel_takes_parameters", arguments: { parameters: { depth: 3 } } },
      undefined,
      { timeout: PANEL_TOOL_MCP_TIMEOUT_MS },
    );
  });

  // The headless surface has the same bare-name hole. #1824 fixed the `call_tool`
  // FACADE, which is all a compact-mode client can reach — but in full mode every
  // comfy tool is registered directly, so the wrapper lands on the tool itself and
  // the facade's alias never runs.
  it("a bare-name comfy call unwraps a lone `parameters` wrapper (#1937)", async () => {
    const { client: comfy, callTool: comfyCall } = fakeMcpClient([
      { name: "download_model", description: "Download a model." },
    ]);
    const backend = new OllamaBackend({
      model: "gemma4:e4b",
      connectToolClients: async () => ({ comfyui: comfy }),
    });
    chatScript.push(
      [
        {
          message: {
            content: "",
            tool_calls: [
              {
                function: {
                  name: "download_model",
                  arguments: { parameters: { action: "status", id: "dl-7" } },
                },
              },
            ],
          },
          done: true,
        },
      ],
      [{ message: { content: "checked." }, done: true }],
    );

    await collect(backend, turnsOf({ text: "check the download" }));
    expect(comfyCall).toHaveBeenCalledWith({
      name: "download_model",
      arguments: { action: "status", id: "dl-7" },
    });
  });

  // A wrapper key alongside real fields is NOT a wrapper — it is a model that
  // spelled most of the call correctly. Unwrapping there would throw the sibling
  // fields away, so the payload must pass through untouched and let the tool's
  // own schema speak.
  it("does NOT unwrap `parameters` when it sits alongside other keys (#1937)", async () => {
    const { client: comfy } = fakeMcpClient(COMFY_META);
    const { client: panel, callTool: panelCall } = fakeMcpClient([
      { name: "panel_set_widget", description: "Set a widget value." },
    ]);
    const backend = new OllamaBackend({
      model: "gemma4:e4b",
      connectToolClients: async () => ({ comfyui: comfy, panel }),
    });
    chatScript.push(
      [
        {
          message: {
            content: "",
            tool_calls: [
              {
                function: {
                  name: "panel_set_widget",
                  arguments: { node_id: 30, parameters: { widget: "frame_load_cap", value: 192 } },
                },
              },
            ],
          },
          done: true,
        },
      ],
      [{ message: { content: "ok." }, done: true }],
    );

    await collect(backend, turnsOf({ text: "set it" }));
    expect(panelCall).toHaveBeenCalledWith(
      { name: "panel_set_widget", arguments: { node_id: 30, parameters: { widget: "frame_load_cap", value: 192 } } },
      undefined,
      { timeout: PANEL_TOOL_MCP_TIMEOUT_MS },
    );
  });

  it("panel_call_tool without a name field says what is missing instead of 'Unknown panel tool '''", async () => {
    const { client: comfy } = fakeMcpClient(COMFY_META);
    const { client: panel, callTool: panelCall } = fakeMcpClient([
      { name: "panel_focus_node", description: "Focus a node in the canvas." },
    ]);
    const backend = new OllamaBackend({
      model: "gemma4:e4b",
      connectToolClients: async () => ({ comfyui: comfy, panel }),
    });
    chatScript.push(
      [
        {
          message: {
            content: "",
            tool_calls: [{ function: { name: "panel_call_tool", arguments: { args: { node_id: 3 } } } }],
          },
          done: true,
        },
      ],
      [{ message: { content: "sorry" }, done: true }],
    );

    await collect(backend, turnsOf({ text: "focus node 3" }));
    expect(panelCall).not.toHaveBeenCalled();
    const toolMsg = chatRequests[1].messages.find((m) => m.role === "tool");
    const content = String(toolMsg?.content);
    expect(content).toContain('panel_call_tool requires a "name" field');
    expect(content).toContain("panel_list_tools");
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
    expect(results).toEqual([{ type: "result", ok: false, subtype: "error", turn: 1 }]);
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
    expect(results).toEqual([{ type: "result", ok: false, subtype: "interrupted", turn: 1 }]);
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

describe("inline image delivery (per-model vision, graceful degradation)", () => {
  const IMG_TURN: NeutralTurn = {
    text: "what is in this screenshot?",
    images: [{ filename: "shot.png", type: "input" }],
  };

  it("native dialect: user-turn images are fetched from ComfyUI and attached as base64", async () => {
    const { client } = fakeMcpClient(COMFY_META);
    const backend = new OllamaBackend({
      model: "gemma4:e4b",
      comfyuiUrl: "http://127.0.0.1:8188",
      connectToolClients: async () => ({ comfyui: client }),
    });
    chatScript.push([{ message: { content: "I see a node graph." }, done: true }]);
    await collect(backend, turnsOf(IMG_TURN));
    const user = chatRequests[0].messages.find((m) => m.role === "user") as {
      images?: string[];
      content: string;
    };
    expect(user.images).toHaveLength(1);
    // base64 of the mocked PNG magic bytes
    expect(user.images?.[0]).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"));
  });

  it("openai dialect: images become image_url data-URL content parts", async () => {
    const { client } = fakeMcpClient(COMFY_META);
    const backend = new OllamaBackend({
      api: "openai",
      host: "http://127.0.0.1:9999/v1",
      apiKey: "sk-test",
      model: "vendor/vision-model",
      comfyuiUrl: "http://127.0.0.1:8188",
      connectToolClients: async () => ({ comfyui: client }),
    });
    await collect(backend, turnsOf(IMG_TURN));
    const user = openaiChatRequests[0].messages.find((m) => m.role === "user") as {
      content: Array<{ type: string; text?: string; image_url?: { url: string } }>;
    };
    expect(Array.isArray(user.content)).toBe(true);
    expect(user.content[0]).toEqual({ type: "text", text: "what is in this screenshot?" });
    expect(user.content[1].type).toBe("image_url");
    expect(user.content[1].image_url?.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("a rejecting endpoint gets ONE retry without images + an honest note both ways", async () => {
    const { client } = fakeMcpClient(COMFY_META);
    const backend = new OllamaBackend({
      model: "qwen3:4b",
      comfyuiUrl: "http://127.0.0.1:8188",
      connectToolClients: async () => ({ comfyui: client }),
    });
    rejectNextChatWith = "this model is missing data required for image input";
    chatScript.push([{ message: { content: "answering without the image" }, done: true }]);
    const events = await collect(backend, turnsOf(IMG_TURN));
    // request 1 carried the image; request 2 (retry) must not
    expect(chatRequests).toHaveLength(2);
    const first = chatRequests[0].messages.find((m) => m.role === "user") as { images?: string[] };
    const second = chatRequests[1].messages.find((m) => m.role === "user") as {
      images?: string[];
      content: string;
    };
    expect(first.images).toHaveLength(1);
    expect(second.images).toBeUndefined();
    // Model-facing note: it must be told it received NOTHING, in the wording
    // that also covers a mixed image+audio strip (#790).
    expect(second.content).toContain("did NOT receive them");
    expect(second.content).toContain("did not see any image");
    // the user was told, and the turn still completed successfully
    const notes = events.filter((e) => e.type === "assistant").map((e) => (e as { text: string }).text);
    expect(notes.some((t) => t.includes("rejected image input"))).toBe(true);
    const result = events.find((e) => e.type === "result") as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  it("a second failure after the strip is NOT retried again (no loop)", async () => {
    const { client } = fakeMcpClient(COMFY_META);
    const backend = new OllamaBackend({
      model: "qwen3:4b",
      comfyuiUrl: "http://127.0.0.1:8188",
      connectToolClients: async () => ({ comfyui: client }),
    });
    rejectNextChatWith = "no images please";
    // no scripted response for the retry → it 500s ("no scripted response")
    const events = await collect(backend, turnsOf(IMG_TURN));
    expect(chatRequests).toHaveLength(2);
    const result = events.find((e) => e.type === "result") as { ok: boolean; subtype?: string };
    expect(result.ok).toBe(false);
  });

  it("text-only turns are unchanged (no images field at all)", async () => {
    const { client } = fakeMcpClient(COMFY_META);
    const backend = new OllamaBackend({
      model: "gemma4:e4b",
      connectToolClients: async () => ({ comfyui: client }),
    });
    chatScript.push([{ message: { content: "hi" }, done: true }]);
    await collect(backend, turnsOf({ text: "hello" }));
    const user = chatRequests[0].messages.find((m) => m.role === "user") as { images?: string[] };
    expect(user.images).toBeUndefined();
  });
});

describe("the system prompt describes the surface that was actually advertised (#788)", () => {
  it("compact says six tools and routes through call_tool", () => {
    const p = ollamaSystemPrompt("compact");
    expect(p).toContain("exactly six tools");
    expect(p).toContain("list_tools / describe_tool / call_tool");
  });

  it("FULL does NOT claim there are six tools, nor that comfyui goes through the router", () => {
    // Auto-selecting full while telling the model the tools do not exist would
    // make the new selection worse than the old default: the model keeps calling
    // a router that is no longer the way in.
    const p = ollamaSystemPrompt("full");
    expect(p).not.toContain("exactly six tools");
    expect(p).toContain("advertised to you DIRECTLY");
    // The panel router IS still a router, and must still be described as one.
    expect(p).toContain("panel_list_tools");
    // No tool COUNT is stated for the full surface (#726 rewrites it).
    expect(p).not.toMatch(/\d+\s*(comfyui )?tools are advertised/i);
  });

  it("both modes keep the same operating rules", () => {
    for (const mode of ["compact", "full"] as const) {
      expect(ollamaSystemPrompt(mode)).toContain("never invent results");
      expect(ollamaSystemPrompt(mode)).toContain("PAID credits");
    }
  });
});

describe("acceptsModelId — a live switch must not be silently ignored (#788)", () => {
  it("takes any id the OpenAI-compatible endpoint's own catalog can return", () => {
    // LM Studio and friends name models whatever they like: `local-model-70b`
    // has neither a colon nor a slash. Refusing those meant the picker recorded
    // and displayed the new model while the backend kept running the old one on
    // the old tool surface — the wrong-model confusion model-keyed selection is
    // supposed to prevent.
    expect(acceptsModelId("local-model-70b", "openai")).toBe(true);
    expect(acceptsModelId("Meta-Llama-3.1-405B-Instruct", "openai")).toBe(true);
    expect(acceptsModelId("deepseek/deepseek-v4-pro", "openai")).toBe(true);
  });

  it("keeps the Ollama-tag shape rule on the NATIVE dialect", () => {
    expect(acceptsModelId("qwen3:4b", "ollama")).toBe(true);
    expect(acceptsModelId("artokun/gemma4-comfyui-mcp:e4b", "ollama")).toBe(true);
    expect(acceptsModelId("local-model-70b", "ollama")).toBe(false); // not a tag
  });

  it("still refuses the hosted frontier ids PanelAgent passes through, on BOTH dialects", () => {
    // This is the one thing the guard actually exists for.
    for (const api of ["ollama", "openai"] as const) {
      expect(acceptsModelId("claude-opus-5", api)).toBe(false);
      expect(acceptsModelId("gpt-5.6-terra", api)).toBe(false);
      expect(acceptsModelId("gemini-3-pro", api)).toBe(false);
      expect(acceptsModelId("", api)).toBe(false);
      expect(acceptsModelId("   ", api)).toBe(false);
    }
  });

  it("gpt-oss is local, on both dialects", () => {
    expect(acceptsModelId("gpt-oss:120b", "ollama")).toBe(true);
    expect(acceptsModelId("gpt-oss-120b", "openai")).toBe(true);
  });
});

describe("isOllamaModel — gpt-oss is a LOCAL family, not a hosted OpenAI model", () => {
  it("accepts gpt-oss tags so a live switch to one actually takes effect (#788)", () => {
    // #788 names gpt-oss:120b as a model that auto-selects the full surface. A
    // blanket ^gpt exclusion refused the switch, leaving the panel showing one
    // model while the backend ran another — wrong-model confusion exactly where
    // model-keyed selection is the promise.
    expect(isOllamaModel("gpt-oss:120b")).toBe(true);
    expect(isOllamaModel("gpt-oss:20b")).toBe(true);
  });

  it("still refuses the hosted OpenAI/Claude/Gemini ids the guard exists for", () => {
    expect(isOllamaModel("gpt-5.6-terra")).toBe(false);
    expect(isOllamaModel("claude-opus-5")).toBe(false);
    expect(isOllamaModel("gemini-3-pro")).toBe(false);
  });
});

describe("comfyuiSpawnEnv (#667)", () => {
  // The ollama path spawns the headless comfyui MCP COMPACT by default (small
  // local models choke on the full ~200-schema list), but an EXPLICIT user
  // choice must win over that default — the pre-#667 force overwrote even an
  // explicit COMFYUI_MCP_TOOL_MODE=full.
  it("an explicit COMFYUI_MCP_TOOL_MODE=full in the user env survives the ollama path", () => {
    const env = comfyuiSpawnEnv(undefined, { COMFYUI_MCP_TOOL_MODE: "full", PATH: "/bin" });
    expect(env.COMFYUI_MCP_TOOL_MODE).toBe("full");
    expect(env.PATH).toBe("/bin");
  });

  it("an explicit COMFYUI_MCP_TOOL_MODE=compact in the user env is honored (not just defaulted)", () => {
    const env = comfyuiSpawnEnv(undefined, { COMFYUI_MCP_TOOL_MODE: "compact" });
    expect(env.COMFYUI_MCP_TOOL_MODE).toBe("compact");
  });

  it("the spec's resolved lane mode wins over an unset user env (orchestrator → child channel)", () => {
    const env = comfyuiSpawnEnv({ COMFYUI_MCP_TOOL_MODE: "full", CIVITAI_API_TOKEN: "tok" }, {});
    expect(env.COMFYUI_MCP_TOOL_MODE).toBe("full");
    expect(env.CIVITAI_API_TOKEN).toBe("tok");
  });

  it("unset env AND no spec mode gets the documented compact default", () => {
    const env = comfyuiSpawnEnv(undefined, {});
    expect(env.COMFYUI_MCP_TOOL_MODE).toBe("compact");
  });

  // #788 — with nobody having chosen, the MODEL decides rather than the provider.
  it("a LARGE local model gets the full surface when nobody has chosen (#788)", () => {
    expect(comfyuiSpawnEnv(undefined, {}, "llama3.3:70b").COMFYUI_MCP_TOOL_MODE).toBe("full");
    const d = comfyuiSpawnToolMode(undefined, {}, "llama3.3:70b");
    // The REASON matters: the same "full" would also come out of an override.
    expect(d.source).toBe("model-parameters");
  });

  it("a SMALL local model keeps compact, attributed to the model (#788)", () => {
    expect(comfyuiSpawnEnv(undefined, {}, "qwen3:4b").COMFYUI_MCP_TOOL_MODE).toBe("compact");
    expect(comfyuiSpawnToolMode(undefined, {}, "qwen3:4b").source).toBe("model-parameters");
  });

  it("an explicit user choice still beats the model rule, in BOTH directions (#788)", () => {
    expect(
      comfyuiSpawnEnv(undefined, { COMFYUI_MCP_TOOL_MODE: "compact" }, "llama3.3:70b").COMFYUI_MCP_TOOL_MODE,
    ).toBe("compact");
    expect(comfyuiSpawnToolMode(undefined, { COMFYUI_MCP_TOOL_MODE: "compact" }, "llama3.3:70b").source).toBe(
      "user-explicit",
    );
    expect(comfyuiSpawnEnv(undefined, { COMFYUI_MCP_TOOL_MODE: "full" }, "qwen3:4b").COMFYUI_MCP_TOOL_MODE).toBe(
      "full",
    );
    expect(comfyuiSpawnToolMode(undefined, { COMFYUI_MCP_TOOL_MODE: "full" }, "qwen3:4b").source).toBe(
      "user-explicit",
    );
  });

  it("a spec-pinned mode (the HTTP lane's #291 value) still outranks the model rule", () => {
    const d = comfyuiSpawnToolMode({ COMFYUI_MCP_TOOL_MODE: "compact" }, {}, "llama3.3:70b");
    expect(d.mode).toBe("compact");
    expect(d.source).toBe("caller-explicit");
  });
});

describe("panel_ask survives a slow human answer (#325)", () => {
  // ROOT CAUSE of #325: the ollama-family backends reach panel_* tools over the
  // loopback HTTP MCP with an MCP SDK Client whose DEFAULT request timeout is
  // 60s. panel_ask is DESIGNED to block on a human up to ~285s (240s card
  // deadline + 45s late-answer grace, #486), so a user who didn't pick within
  // 60s got `MCP error -32001: Request timed out` — and their eventual choice,
  // delivered server-side, never reached the model. The fake panel client below
  // models the SDK's timeout behavior faithfully: it rejects with the exact
  // -32001 error when the request's timeout budget is shorter than the (slow)
  // user's answer time, and delivers the pick otherwise.
  const ASK_TOOL = [{ name: "panel_ask", description: "Ask the user to choose." }];
  const ANSWERED_AT_MS = 90_000; // a slow-but-normal human answer (T+90s)
  const USER_PICK = "Local GPU + Blender";

  function sdkTimeoutPanelClient(calls: Array<{ name: string; timeout?: number }>) {
    const callTool = vi.fn(
      async (
        params: { name: string; arguments: Record<string, unknown> },
        _resultSchema?: unknown,
        options?: { timeout?: number },
      ) => {
        calls.push({ name: params.name, timeout: options?.timeout });
        // The MCP SDK's Protocol.request rejects with -32001 after `timeout` ms
        // (60s when unspecified) — before a slow answer could ever arrive.
        const budget = options?.timeout ?? 60_000;
        if (budget < ANSWERED_AT_MS) throw new Error("MCP error -32001: Request timed out");
        return { content: [{ type: "text", text: USER_PICK }] };
      },
    );
    const client: McpToolClient = {
      listTools: async () => ({ tools: ASK_TOOL }),
      callTool: callTool as unknown as McpToolClient["callTool"],
      close: async () => {},
    };
    return { client, callTool };
  }

  const ASK_ARGS = {
    question: "Which?",
    options: [{ label: "Local GPU + Blender" }, { label: "Cloud" }],
  };

  function scriptPanelAskTurn(direct: boolean) {
    chatScript.push(
      [
        {
          message: {
            content: "",
            tool_calls: [
              {
                function: direct
                  ? { name: "panel_ask", arguments: ASK_ARGS } // bare name — forgiving dispatch
                  : { name: "panel_call_tool", arguments: { name: "panel_ask", args: ASK_ARGS } },
              },
            ],
          },
          done: true,
        },
      ],
      [{ message: { content: "done." }, done: true }],
    );
  }

  function lastToolResult(): string {
    const toolMsg = chatRequests[1].messages.filter((m) => m.role === "tool").at(-1);
    return String(toolMsg?.content ?? "");
  }

  it("an answered card resolves the call with the user's choice (panel_call_tool router)", async () => {
    const calls: Array<{ name: string; timeout?: number }> = [];
    const { client: panel, callTool } = sdkTimeoutPanelClient(calls);
    const backend = new OllamaBackend({
      model: "gemma4:e4b",
      connectToolClients: async () => ({ panel }),
    });
    scriptPanelAskTurn(false);

    await collect(backend, turnsOf({ text: "ask me which" }));
    // The request carried a timeout that covers a slow human answer — NOT the
    // SDK's 60s default that produced #325's -32001.
    expect(calls).toEqual([{ name: "panel_ask", timeout: PANEL_TOOL_MCP_TIMEOUT_MS }]);
    expect(callTool).toHaveBeenCalledTimes(1);
    // …so the user's pick (validated at T+90s, past the old 60s kill) was fed
    // back to the model as the tool result, not a -32001 transport error.
    expect(lastToolResult()).toContain(USER_PICK);
    expect(lastToolResult()).not.toContain("-32001");
  });

  it("an answered card resolves with the user's choice (forgiving direct dispatch)", async () => {
    const calls: Array<{ name: string; timeout?: number }> = [];
    const { client: panel } = sdkTimeoutPanelClient(calls);
    const backend = new OllamaBackend({
      model: "gemma4:e4b",
      connectToolClients: async () => ({ panel }),
    });
    scriptPanelAskTurn(true);

    await collect(backend, turnsOf({ text: "ask me which" }));
    expect(calls).toEqual([{ name: "panel_ask", timeout: PANEL_TOOL_MCP_TIMEOUT_MS }]);
    expect(lastToolResult()).toContain(USER_PICK);
    expect(lastToolResult()).not.toContain("-32001");
  });

  it("a genuine request timeout still surfaces truthfully (never swallowed)", async () => {
    // The transport REALLY timed out (e.g. the user walked away past the whole
    // card budget): the -32001 must reach the model as an honest tool error —
    // the fix widens the budget, it does not hide a real timeout.
    const callTool = vi.fn(async () => {
      throw new Error("MCP error -32001: Request timed out");
    });
    const panel: McpToolClient = {
      listTools: async () => ({ tools: ASK_TOOL }),
      callTool: callTool as unknown as McpToolClient["callTool"],
      close: async () => {},
    };
    const backend = new OllamaBackend({
      model: "gemma4:e4b",
      connectToolClients: async () => ({ panel }),
    });
    scriptPanelAskTurn(false);

    await collect(backend, turnsOf({ text: "ask me which" }));
    expect(lastToolResult()).toContain("-32001");
  });

  it("the client timeout covers the LONGEST blocking panel card with margin", () => {
    // panel_ask / confirm / consent are hard-capped at ASK_TOTAL_BUDGET_CAP_MS;
    // panel_request_secret waits up to 300s on its masked input. The client
    // timeout must exceed BOTH or one can still be killed client-side mid-answer.
    expect(PANEL_TOOL_MCP_TIMEOUT_MS).toBeGreaterThan(__panelAskTestHooks.ASK_TOTAL_BUDGET_CAP_MS);
    expect(PANEL_TOOL_MCP_TIMEOUT_MS).toBeGreaterThan(300_000);
  });
});

describe("panel-router retraction rides the mode-varying prompt (main↔#788 merge seam)", () => {
  it("no panel router → the system prompt retracts the panel tools; router present → no retraction", async () => {
    const { client: comfy } = fakeMcpClient(COMFY_META);
    // Without a panel client the three panel_* routers don't exist — the prompt
    // must say so rather than promise them (#841 lineage, kept through the merge).
    let backend = new OllamaBackend({ model: "gemma4:e4b", connectToolClients: async () => ({ comfyui: comfy }) });
    chatScript.push([{ message: { content: "hi" }, done: true }]);
    await collect(backend, turnsOf({ text: "hello" }));
    let sys = chatRequests.at(-1)!.messages[0] as { role: string; content: string };
    expect(sys.role).toBe("system");
    expect(sys.content).toContain("CORRECTION");
    expect(sys.content).toContain("DO NOT EXIST");

    const { client: panel } = fakeMcpClient([{ name: "panel_run", description: "Run." }]);
    backend = new OllamaBackend({ model: "gemma4:e4b", connectToolClients: async () => ({ comfyui: comfy, panel }) });
    chatScript.push([{ message: { content: "hi" }, done: true }]);
    await collect(backend, turnsOf({ text: "hello" }));
    sys = chatRequests.at(-1)!.messages[0] as { role: string; content: string };
    expect(sys.content).not.toContain("CORRECTION");
  });
});
