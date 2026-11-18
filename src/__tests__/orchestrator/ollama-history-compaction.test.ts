// #2231 — a long local-model session died with no error anywhere.
//
// The cause is not a crash. Ollama does NOT reject a prompt that exceeds
// num_ctx; it truncates the prompt from the FRONT. `this.history` is built once
// per session (index 0 = the system prompt) and, before this fix, only ever
// grew: `trimImagePayloadToBudget` bounded image BYTES and nothing at all
// bounded TEXT. So past a certain turn the front of the prompt — the system
// prompt and the entire tool-surface instruction block — fell off the edge. The
// model kept answering, now with no instructions and no tool vocabulary, so it
// stopped emitting valid tool calls and the agent "died" silently.
//
// chatStream already logged that this was IMMINENT (≥85% of the window) and
// then let it happen. These tests pin the thing that prevents it.
//
// The invariant that matters most is the LAST assertion of the first test:
// whatever else compaction does, `messages[0]` is still the system prompt.
// That is the message front-truncation would have eaten.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OllamaBackend, type McpToolClient } from "../../orchestrator/ollama-backend.js";
import type { AgentEvent, NeutralTurn } from "../../orchestrator/agent-backend.js";

type OpenAiMsg = { role: string; content: string | Array<{ type: string; text?: string }> };

let openaiChatRequests: Array<{ messages: OpenAiMsg[] }> = [];

function sseOk(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n`),
      );
      controller.enqueue(enc.encode("data: [DONE]\n"));
      controller.close();
    },
  });
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url.endsWith("/models")) {
    return new Response(JSON.stringify({ data: [{ id: "xiaomi/mimo-v2.5" }] }), { status: 200 });
  }
  if (url.endsWith("/chat/completions")) {
    openaiChatRequests.push(JSON.parse(String(init?.body)));
    return new Response(sseOk(), { status: 200 });
  }
  return new Response("not found", { status: 404 });
});

function fakeComfyClient(): McpToolClient {
  return {
    listTools: async () => ({
      tools: [{ name: "list_tools", description: "Catalog.", inputSchema: { type: "object", properties: {} } }],
    }),
    callTool: (async () => ({ content: [{ type: "text", text: "ok" }] })) as unknown as McpToolClient["callTool"],
    close: async () => {},
  };
}

function backend() {
  return new OllamaBackend({
    api: "openai",
    host: "http://127.0.0.1:9999/v1",
    apiKey: "sk-test",
    model: "xiaomi/mimo-v2.5",
    comfyuiUrl: "http://127.0.0.1:8188",
    connectToolClients: async () => ({ comfyui: fakeComfyClient() }),
  });
}

async function* turnsOf(...turns: NeutralTurn[]): AsyncGenerator<NeutralTurn> {
  for (const t of turns) yield t;
}

async function collect(b: OllamaBackend, channel: AsyncIterable<NeutralTurn>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of b.run({ channel })) events.push(ev);
  return events;
}

function assistantTexts(events: AgentEvent[]): string[] {
  return events.filter((e) => e.type === "assistant").map((e) => (e as { text: string }).text);
}

/** Flatten one request's messages to plain strings for substring assertions. */
function textsOf(req: { messages: OpenAiMsg[] }): string[] {
  return req.messages.map((m) =>
    typeof m.content === "string"
      ? m.content
      : m.content
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join(" "),
  );
}

/** A turn whose text is large enough to matter against a small window. */
const bigTurn = (marker: string): NeutralTurn => ({ text: `${marker} ${"filler words ".repeat(700)}` });

beforeEach(() => {
  openaiChatRequests = [];
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("#2231 — the text history is bounded so the window cannot eat the system prompt", () => {
  it("stubs the oldest prose once the history outgrows the budget, and never index 0", async () => {
    vi.stubEnv("COMFYUI_MCP_OLLAMA_NUM_CTX", "8000");

    const events = await collect(
      backend(),
      turnsOf(bigTurn("MARKER_ONE"), bigTurn("MARKER_TWO"), bigTurn("MARKER_THREE"), bigTurn("MARKER_FOUR")),
    );

    expect(openaiChatRequests).toHaveLength(4);
    const last = openaiChatRequests[3];
    const texts = textsOf(last);

    // The oldest turn lost its bulk (that is the reclaimed context) but kept its
    // opening words as a gist, plus a handle back to the full text.
    const oldest = texts.find((t) => t.includes("MARKER_ONE"));
    expect(oldest).toBeDefined();
    expect(oldest!.length).toBeLessThan(bigTurn("MARKER_ONE").text.length / 10);
    expect(oldest).toMatch(/archived as h\d+/);
    // Replaced by a stub, not deleted: the message count still covers every turn.
    expect(last.messages.length).toBe(8);
    // The live turn is untouched (it is inside the protected tail).
    expect(texts.some((t) => t.includes("MARKER_FOUR"))).toBe(true);

    // THE INVARIANT. Index 0 is still the system prompt, uncompacted — this is
    // the message Ollama's front-truncation would have taken, and losing it is
    // what made the agent stop calling tools.
    expect(last.messages[0].role).toBe("system");
    expect(String(last.messages[0].content)).not.toContain("[note:");
    expect(String(last.messages[0].content).length).toBeGreaterThan(200);

    // The user hears about it once, not once per round.
    const notices = assistantTexts(events).filter((t) => t.includes("condensed the oldest"));
    expect(notices).toHaveLength(1);
  });

  it("CONTROL: a short conversation under the default window is never touched", async () => {
    const events = await collect(backend(), turnsOf({ text: "hello" }, { text: "and again" }));
    const texts = textsOf(openaiChatRequests[1]);
    expect(texts.some((t) => t.includes("hello"))).toBe(true);
    expect(texts.some((t) => t.includes("[note:"))).toBe(false);
    expect(assistantTexts(events).some((t) => t.includes("condensed"))).toBe(false);
  });

  // An unusable budget override must fall back to the default rather than be
  // obeyed. Both directions are silent and both are destructive: a 0 budget
  // stubs the entire history on every request (the model loses the whole
  // conversation), and a >1 budget re-opens #2231 by never firing at all.
  it.each([
    ["0", "a budget nothing can fit under"],
    ["2", "a fraction above 1"],
    ["not-a-number", "an unparseable value"],
  ])("rejects %s (%s) and keeps the default fraction", async (value) => {
    vi.stubEnv("COMFYUI_MCP_OLLAMA_HISTORY_BUDGET", value);
    const events = await collect(backend(), turnsOf({ text: "hello" }, { text: "and again" }));
    expect(textsOf(openaiChatRequests[1]).some((t) => t.includes("hello"))).toBe(true);
    expect(assistantTexts(events).some((t) => t.includes("condensed"))).toBe(false);
  });
});
