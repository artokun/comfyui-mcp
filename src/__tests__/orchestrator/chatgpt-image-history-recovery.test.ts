// #2224 — ChatGPT's private Codex Responses endpoint has no evidenced request
// budget we can safely apply proactively. Keep valid images until the endpoint
// actually rejects the request, then prove the production strip-and-retry path
// recovers even when only inherited history carries the images.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatGptOAuthBackend } from "../../orchestrator/chatgpt-oauth-backend.js";
import type { AgentEvent, NeutralTurn } from "../../orchestrator/agent-backend.js";
import type { McpToolClient } from "../../orchestrator/ollama-backend.js";

vi.mock("../../services/code-provider-auth.js", () => ({
  resolveOpenAICodexOAuth: async () => ({ accessToken: "token", accountId: "account" }),
}));

type CodexInputItem = {
  type: string;
  role?: string;
  content?: Array<{ type?: string; text?: string; image_url?: string }>;
};

type CodexRequest = { input: CodexInputItem[] };

let codexRequests: CodexRequest[] = [];
let responseStatuses: number[] = [];
let imageFetches = 0;

function successSse(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: "ok" })}\n\n`,
        ),
      );
      controller.close();
    },
  });
}

const defaultFetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url.includes("/view?")) {
    imageFetches++;
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, imageFetches]), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }
  if (url.includes("/backend-api/codex/responses")) {
    codexRequests.push(JSON.parse(String(init?.body)) as CodexRequest);
    const status = responseStatuses.shift() ?? 200;
    if (status !== 200) {
      return new Response(JSON.stringify({ error: { message: "request too large" } }), { status });
    }
    return new Response(successSse(), { status: 200 });
  }
  return new Response("not found", { status: 404 });
};

const fetchMock = vi.fn(defaultFetchImpl);

function fakeMcpClient(): McpToolClient {
  return {
    listTools: async () => ({
      tools: [{ name: "list_tools", description: "Catalog.", inputSchema: { type: "object", properties: {} } }],
    }),
    callTool: (async () => ({ content: [{ type: "text", text: "ok" }] })) as unknown as McpToolClient["callTool"],
    close: async () => {},
  };
}

function backend(): ChatGptOAuthBackend {
  return new ChatGptOAuthBackend({
    model: "gpt-5.6-luna",
    comfyuiUrl: "http://127.0.0.1:8188",
    connectToolClients: async () => ({ comfyui: fakeMcpClient() }),
  });
}

async function* turnsOf(...turns: NeutralTurn[]): AsyncGenerator<NeutralTurn> {
  for (const turn of turns) yield turn;
}

async function collect(instance: ChatGptOAuthBackend, ...turns: NeutralTurn[]): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of instance.run({ channel: turnsOf(...turns) })) events.push(event);
  return events;
}

function imageTurn(text: string, count: number): NeutralTurn {
  return {
    text,
    images: Array.from({ length: count }, (_, i) => ({ filename: `image-${i + 1}.png`, type: "input" })),
  };
}

function imageCount(request: CodexRequest): number {
  return request.input.reduce(
    (total, item) => total + (item.content?.filter((part) => part.type === "input_image").length ?? 0),
    0,
  );
}

function userTexts(request: CodexRequest): string[] {
  return request.input
    .filter((item) => item.type === "message" && item.role === "user")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "input_text")
    .map((part) => String(part.text ?? ""));
}

beforeEach(() => {
  codexRequests = [];
  responseStatuses = [];
  imageFetches = 0;
  fetchMock.mockClear();
  fetchMock.mockImplementation(defaultFetchImpl);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("#2224 — ChatGPT inherited image history recovery", () => {
  it("keeps every valid image when no provider rejection establishes a need to drop one", async () => {
    // This variable belongs to the OpenRouter/Ollama lane. Even an absurdly low
    // value must not silently become a ChatGPT policy without provider evidence.
    vi.stubEnv("COMFYUI_MCP_OLLAMA_MAX_IMAGE_BYTES", "1");

    const events = await collect(backend(), imageTurn("compare all four", 4));

    expect(imageFetches).toBe(4);
    expect(codexRequests).toHaveLength(1);
    expect(imageCount(codexRequests[0])).toBe(4);
    expect(userTexts(codexRequests[0]).join(" ")).not.toContain("were removed");
    expect(events.find((event) => event.type === "result")).toMatchObject({ ok: true });
  });

  it("recovers an inherited-history 413 with one image-free retry and exact counts", async () => {
    // Turn one succeeds with three images. Turn two has no attachment of its
    // own, but its first request inherits all three and receives the 413.
    responseStatuses = [200, 413, 200];

    const events = await collect(
      backend(),
      imageTurn("remember these three", 3),
      { text: "now compare what you remember" },
    );

    expect(codexRequests).toHaveLength(3);
    expect(codexRequests.map(imageCount)).toEqual([3, 3, 0]);

    const retryTexts = userTexts(codexRequests[2]);
    expect(retryTexts).toHaveLength(2);
    expect(retryTexts[0]).toContain("were removed");
    expect(retryTexts[1]).toBe("now compare what you remember");

    const notices = events
      .filter((event) => event.type === "assistant")
      .map((event) => (event as { text: string }).text);
    expect(notices.filter((text) => text.includes("rejected image input"))).toHaveLength(1);
    expect(events.filter((event) => event.type === "result")).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
  });

  it("does not loop when the single inherited-history strip retry also fails", async () => {
    responseStatuses = [200, 413, 413];

    const events = await collect(
      backend(),
      imageTurn("remember both", 2),
      { text: "continue without another attachment" },
    );

    // One successful image turn, one rejected inherited request, and exactly
    // one image-free retry. The second 413 must surface instead of retrying.
    expect(codexRequests).toHaveLength(3);
    expect(codexRequests.map(imageCount)).toEqual([2, 2, 0]);
    expect(events.filter((event) => event.type === "result")).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: false, subtype: "error" }),
    ]);
  });
});
