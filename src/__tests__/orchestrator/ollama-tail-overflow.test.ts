// The protected tail can overflow the window on its own.
//
// Live failure (qwen3.8-27b on Ollama 0.40.3, num_ctx 16384): compaction fired,
// then a few rounds later the model read a large workflow template. Tool results
// carry up to 16000 chars each and the last HISTORY_TAIL_KEEP messages were never
// compacted, so the tail alone outgrew the window. The server front-truncated,
// the user's request at index 1 was the first message to go, and Qwen's chat
// template refused the history: http 500 "No user query found in messages".
//
// Two fixes are pinned here: the tail's tool results are compacted when nothing
// older is left to cut, and an overflow refusal re-sends the round once instead
// of ending the turn.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OllamaBackend, contextOverflowed, type McpToolClient } from "../../orchestrator/ollama-backend.js";
import type { AgentEvent, NeutralTurn } from "../../orchestrator/agent-backend.js";

type Msg = { role: string; content: string; tool_name?: string };
type ChatBody = { messages: Msg[]; tools?: unknown[] };
type Scripted = { status: number; body: string } | Array<Record<string, unknown>>;

let chatScript: Scripted[] = [];
let chatRequests: ChatBody[] = [];

function ndjson(chunks: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(enc.encode(`${JSON.stringify(x)}\n`));
      c.close();
    },
  });
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.40.3" }), { status: 200 });
  if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "qwen3:4b" }] }), { status: 200 });
  if (url.endsWith("/api/chat")) {
    chatRequests.push(JSON.parse(String(init?.body)));
    const next = chatScript.shift();
    if (!next) return new Response("no scripted response", { status: 500 });
    if (!Array.isArray(next)) return new Response(next.body, { status: next.status });
    return new Response(ndjson(next), { status: 200 });
  }
  return new Response("not found", { status: 404 });
});

/** Every tool call answers with a result at the 16000-char history cap. */
function bigResultClient(): McpToolClient {
  let n = 0;
  return {
    listTools: async () => ({ tools: [{ name: "list_tools", description: "Catalog.", inputSchema: { type: "object", properties: {} } }] }),
    callTool: (async () => ({
      content: [{ type: "text", text: `RESULT_${++n} ${"{\"node\":\"KSampler\",\"inputs\":{}} ".repeat(600)}` }],
    })) as unknown as McpToolClient["callTool"],
    close: async () => {},
  };
}

const say = (text: string) => [{ message: { content: text }, done: true, prompt_eval_count: 10, eval_count: 1 }];
const callTool = (search: string) => [
  { message: { content: "", tool_calls: [{ function: { name: "list_tools", arguments: { search } } }] }, done: true },
];

async function run(...turns: NeutralTurn[]): Promise<AgentEvent[]> {
  async function* ch(): AsyncGenerator<NeutralTurn> {
    for (const t of turns) yield t;
  }
  const b = new OllamaBackend({ model: "qwen3:4b", connectToolClients: async () => ({ comfyui: bigResultClient() }) });
  const events: AgentEvent[] = [];
  for await (const ev of b.run({ channel: ch() })) events.push(ev);
  return events;
}

/** The same estimate the backend budgets with: 3.5 chars per token, tools included. */
const estimatedTokens = (r: ChatBody) =>
  Math.ceil((r.messages.reduce((n, m) => n + m.content.length, 0) + JSON.stringify(r.tools ?? []).length) / 3.5);

beforeEach(() => {
  chatScript = [];
  chatRequests = [];
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("COMFYUI_MCP_OLLAMA_NUM_CTX", "8000");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the protected tail cannot overflow the window", () => {
  it("compacts the tail's tool results when nothing older is left to cut", async () => {
    chatScript.push(callTool("a"), callTool("b"), callTool("c"), say("done"));
    await run({ text: "set up a minimax h3 reference video workflow" });

    expect(chatRequests).toHaveLength(4);
    for (const r of chatRequests) {
      // Every request fits the budget the backend aims for (75% of num_ctx).
      expect(estimatedTokens(r)).toBeLessThanOrEqual(6000);
      // And the user's request is still there for the chat template to find.
      expect(r.messages.some((m) => m.role === "user" && m.content.includes("minimax h3"))).toBe(true);
    }

    const last = chatRequests[3].messages.filter((m) => m.role === "tool");
    // An older result the model already read says so…
    expect(last[0].content).toMatch(/^\[compacted list_tools result, archived as h\d+\..*You DID receive/);
    // …and nothing claims the model saw a result it has not been shown yet.
    for (const m of last.filter((x) => x.content.includes("too large to fit"))) {
      expect(m.content).not.toContain("You DID receive");
      expect(m.content).toMatch(/history_recall \{"id":"h\d+"\}/);
    }
  });

  it("CONTROL: a tool result that fits is delivered in full", async () => {
    vi.stubEnv("COMFYUI_MCP_OLLAMA_NUM_CTX", "32768");
    chatScript.push(callTool("a"), say("done"));
    await run({ text: "hello" });
    const tool = chatRequests[1].messages.find((m) => m.role === "tool");
    expect(tool?.content.startsWith("RESULT_1")).toBe(true);
    expect(tool!.content.length).toBeGreaterThan(15000);
  });
});

describe("an overflow refusal re-sends the round instead of ending the turn", () => {
  const noUserQuery = JSON.stringify({
    error: JSON.stringify({
      error: { code: 500, message: "Error: Jinja Exception: No user query found in messages.", type: "server_error" },
    }),
  });

  it("retries once at a tighter budget after Qwen's 'No user query found'", async () => {
    chatScript.push(callTool("a"), { status: 500, body: noUserQuery }, say("done"));
    const events = await run({ text: "hello" });

    expect(chatRequests).toHaveLength(3);
    expect(events.some((e) => e.type === "assistant" && (e as { text: string }).text === "done")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("gives up after one retry rather than looping", async () => {
    chatScript.push({ status: 500, body: noUserQuery }, { status: 500, body: noUserQuery });
    await run({ text: "hello" }).catch(() => []);
    expect(chatRequests).toHaveLength(2);
  });

  it.each([
    [500, "Jinja Exception: No user query found in messages.", true],
    [400, '{"type":"exceed_context_size_error","message":"request (16614 tokens) exceeds the available context size (16384 tokens)"}', true],
    [500, "CUDA error: out of memory", false],
    [undefined, "No user query found in messages.", false],
  ])("contextOverflowed(%s, …) is %s", (status, message, expected) => {
    expect(contextOverflowed(status, message)).toBe(expected);
  });
});
