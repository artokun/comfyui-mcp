// Compaction v2: a stub is a gist plus a handle, and the handle works.
//
// v1 (#2971) stopped front-truncation from eating the system prompt by shrinking
// old messages in place, but a shrunk message was simply gone: the model could
// only ask the user to repeat themselves. v2 archives the full text, keeps a gist
// in the stub, and registers history_recall so the model can read it back.
//
// These run on the NATIVE Ollama lane with scripted replies, so the model really
// calls history_recall and the recalled text really lands in the next request.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OllamaBackend, type McpToolClient } from "../../orchestrator/ollama-backend.js";
import type { AgentEvent, NeutralTurn } from "../../orchestrator/agent-backend.js";

type Msg = { role: string; content: string; tool_name?: string };
type ChatBody = { messages: Msg[]; tools?: Array<{ function?: { name?: string } }> };

let chatScript: Array<Array<Record<string, unknown>>> = [];
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
  if (url.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.31.1" }), { status: 200 });
  if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "qwen3:4b" }] }), { status: 200 });
  if (url.endsWith("/api/chat")) {
    chatRequests.push(JSON.parse(String(init?.body)));
    const chunks = chatScript.shift();
    return chunks ? new Response(ndjson(chunks), { status: 200 }) : new Response("no scripted response", { status: 500 });
  }
  return new Response("not found", { status: 404 });
});

function fakeClient(): McpToolClient {
  return {
    listTools: async () => ({ tools: [{ name: "list_tools", description: "Catalog.", inputSchema: { type: "object", properties: {} } }] }),
    callTool: (async () => ({ content: [{ type: "text", text: "ok" }] })) as unknown as McpToolClient["callTool"],
    close: async () => {},
  };
}

const say = (text: string) => [{ message: { content: text }, done: true, prompt_eval_count: 10, eval_count: 1 }];
const recall = (id: string) => [
  { message: { content: "", tool_calls: [{ function: { name: "history_recall", arguments: { id } } }] }, done: true },
];
const bigTurn = (marker: string): NeutralTurn => ({ text: `${marker} ${"filler words ".repeat(700)}` });

async function run(...turns: NeutralTurn[]): Promise<AgentEvent[]> {
  async function* ch(): AsyncGenerator<NeutralTurn> {
    for (const t of turns) yield t;
  }
  const b = new OllamaBackend({ model: "qwen3:4b", connectToolClients: async () => ({ comfyui: fakeClient() }) });
  const events: AgentEvent[] = [];
  for await (const ev of b.run({ channel: ch() })) events.push(ev);
  return events;
}

const toolNames = (r: ChatBody) => (r.tools ?? []).map((t) => t.function?.name);

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

describe("compaction v2 — gist + handle + history_recall", () => {
  it("the model can read a compacted message back in full", async () => {
    chatScript.push(say("ok"), say("ok"), say("ok"), recall("h1"), say("done"));
    await run(bigTurn("MARKER_ONE"), bigTurn("MARKER_TWO"), bigTurn("MARKER_THREE"), bigTurn("MARKER_FOUR"));

    // Nothing is archived yet on turn 1, so the tool surface is exactly as before.
    expect(toolNames(chatRequests[0])).not.toContain("history_recall");

    // Turn 4 compacts the first message: the stub keeps the gist and names the handle,
    // and the recall tool is on the SAME request (rebuilt mid-turn, not next turn).
    const turn4 = chatRequests[3];
    const stub = turn4.messages.find((m) => m.content.includes("MARKER_ONE"));
    expect(stub?.content).toContain('history_recall {"id":"h1"}');
    expect(toolNames(turn4)).toContain("history_recall");

    // The model called it; the full original is in the next request's tool result.
    const after = chatRequests[4].messages.find((m) => m.role === "tool");
    expect(after?.content.startsWith("[recalled h1] (user message)")).toBe(true);
    expect(after?.content).toContain("MARKER_ONE");
    expect(after!.content.length).toBeGreaterThan(5000);
  });

  it("an unknown handle answers with the handles that do exist", async () => {
    chatScript.push(say("ok"), say("ok"), say("ok"), recall("h99"), say("done"));
    await run(bigTurn("A"), bigTurn("B"), bigTurn("C"), bigTurn("D"));
    const res = chatRequests[4].messages.find((m) => m.role === "tool");
    expect(res?.content).toContain('No archived message "h99"');
    expect(res?.content).toContain("h1");
  });

  it("leaves a message alone when its stub would be longer than it is", async () => {
    // Just past the 240-char floor: a 300-char gist plus the wrapper outgrows it,
    // so stubbing would SPEND context to "save" it.
    const shortish = `SHORTMSG ${"x".repeat(250)}`;
    chatScript.push(say("ok"), say("ok"), say("ok"), say("ok"));
    await run({ text: shortish }, bigTurn("B"), bigTurn("C"), bigTurn("D"));
    const kept = chatRequests[3].messages.find((m) => m.content.includes("SHORTMSG"));
    expect(kept?.content).toBe(shortish);
  });

  it("a recalled result that gets compacted again keeps its original handle", async () => {
    chatScript.push(say("ok"), say("ok"), say("ok"), recall("h1"), say("done"), say("ok"), say("ok"), say("ok"));
    await run(bigTurn("A"), bigTurn("B"), bigTurn("C"), bigTurn("D"), bigTurn("E"), bigTurn("F"), bigTurn("G"));
    const last = chatRequests.at(-1)!;
    const recallMsg = last.messages.find((m) => m.role === "tool" && m.tool_name === "history_recall");
    // Compacted (it left the protected tail) and still pointing at h1, not a fresh copy.
    expect(recallMsg?.content).toMatch(/^\[compacted history_recall result, archived as h1\./);
  });
});
