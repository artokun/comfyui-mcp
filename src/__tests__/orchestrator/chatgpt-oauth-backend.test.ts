import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptOAuthBackend, CHATGPT_DEFAULT_MODEL } from "../../orchestrator/chatgpt-oauth-backend.js";
import type { McpToolClient } from "../../orchestrator/ollama-backend.js";
import type { AgentEvent, NeutralTurn } from "../../orchestrator/agent-backend.js";

vi.mock("../../services/code-provider-auth.js", () => ({
  resolveOpenAICodexOAuth: async () => ({ accessToken: "tok", accountId: "acct" }),
}));

// ---------------------------------------------------------------------------
// fetch mock: Codex Responses SSE + ComfyUI /view (image bytes for vision).
// ---------------------------------------------------------------------------

type ResponsesBody = {
  model: string;
  input: Array<{ type: string; role?: string; content?: Array<Record<string, unknown>> }>;
};

let responsesRequests: ResponsesBody[] = [];
let rejectNextWith: string | null = null;
/** Answer the next Responses call with a 429 carrying this body. */
let rateLimitNextWith: { body: string; headers?: Record<string, string> } | null = null;
/** Runs as that 429 goes out — stands in for the user switching model during the backoff. */
let onRateLimited: (() => void) | null = null;

function sse(blocks: Array<{ event: string; data: Record<string, unknown> }>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const b of blocks) {
        controller.enqueue(enc.encode(`event: ${b.event}\ndata: ${JSON.stringify(b.data)}\n\n`));
      }
      controller.close();
    },
  });
}

// Named so beforeEach can REINSTALL it. One case below calls
// fetchMock.mockImplementation() to make every request fail, and mockClear() does
// not undo that — it only forgets the calls. So every test declared after that one
// silently ran against a 400-always endpoint. The two that follow were written
// against a 429 and saw a 400 instead, which is how this was found.
const defaultFetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url.includes("/view?")) {
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }
  if (url.includes("/backend-api/codex/responses")) {
    responsesRequests.push(JSON.parse(String(init?.body)) as ResponsesBody);
    if (rateLimitNextWith) {
      const { body, headers } = rateLimitNextWith;
      rateLimitNextWith = null;
      onRateLimited?.();
      return new Response(body, { status: 429, headers: headers ?? {} });
    }
    if (rejectNextWith) {
      const msg = rejectNextWith;
      rejectNextWith = null;
      return new Response(msg, { status: 400 });
    }
    return new Response(sse([{ event: "response.output_text.delta", data: { delta: "I see it." } }]), {
      status: 200,
    });
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

async function* turnsOf(...turns: NeutralTurn[]): AsyncGenerator<NeutralTurn> {
  for (const t of turns) yield t;
}

async function collect(backend: ChatGptOAuthBackend, channel: AsyncIterable<NeutralTurn>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of backend.run({ channel })) events.push(ev);
  return events;
}

function makeBackend(): ChatGptOAuthBackend {
  return new ChatGptOAuthBackend({
    model: "gpt-5.4-mini",
    comfyuiUrl: "http://127.0.0.1:8188",
    connectToolClients: async () => ({ comfyui: fakeMcpClient() }),
  });
}

const IMG_TURN: NeutralTurn = {
  text: "what is in this screenshot?",
  images: [{ filename: "shot.png", type: "input" }],
};

function userContent(req: ResponsesBody): Array<Record<string, unknown>> {
  const user = req.input.find((i) => i.type === "message" && i.role === "user");
  return (user?.content ?? []) as Array<Record<string, unknown>>;
}

beforeEach(() => {
  responsesRequests = [];
  rejectNextWith = null;
  rateLimitNextWith = null;
  onRateLimited = null;
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  fetchMock.mockImplementation(defaultFetchImpl);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChatGptOAuthBackend — Responses-API image delivery (#218)", () => {
  it("attaches user-turn images as input_image data-URL items", async () => {
    await collect(makeBackend(), turnsOf(IMG_TURN));
    const content = userContent(responsesRequests[0]);
    expect(content[0]).toEqual({ type: "input_text", text: "what is in this screenshot?" });
    expect(content[1].type).toBe("input_image");
    expect(String(content[1].image_url)).toBe(
      `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")}`,
    );
  });

  it("a rejecting endpoint gets ONE retry without images + an honest note both ways", async () => {
    rejectNextWith = "image input is not supported for this model";
    const events = await collect(makeBackend(), turnsOf(IMG_TURN));
    expect(responsesRequests).toHaveLength(2);
    expect(userContent(responsesRequests[0]).some((c) => c.type === "input_image")).toBe(true);
    const retry = userContent(responsesRequests[1]);
    expect(retry.some((c) => c.type === "input_image")).toBe(false);
    expect(String(retry[0].text)).toContain("rejected image input");
    const notes = events.filter((e) => e.type === "assistant").map((e) => (e as { text: string }).text);
    expect(notes.some((t) => t.includes("rejected image input"))).toBe(true);
    const result = events.find((e) => e.type === "result") as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  it("a second failure after the strip is NOT retried again (no loop)", async () => {
    rejectNextWith = "no images";
    // make the retry fail too: reject every request after re-arming inside the mock
    const events: AgentEvent[] = [];
    const backend = makeBackend();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/view?")) {
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url.includes("/backend-api/codex/responses")) {
        responsesRequests.push(JSON.parse(String(init?.body)) as ResponsesBody);
        return new Response("nope", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    });
    for await (const ev of backend.run({ channel: turnsOf(IMG_TURN) })) events.push(ev);
    expect(responsesRequests).toHaveLength(2); // original + one strip-retry, no loop
    const result = events.find((e) => e.type === "result") as { ok: boolean };
    expect(result.ok).toBe(false);
  });

  it("text-only turns carry no input_image items", async () => {
    await collect(makeBackend(), turnsOf({ text: "hello" }));
    expect(userContent(responsesRequests[0]).every((c) => c.type === "input_text")).toBe(true);
  });
});

describe("GPT-5.6-only model policy (issue #241 + 2026-07-20 deprecation)", () => {
  it("hides deprecated pre-5.6 ids when the codex cache carries the 5.6 family", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmcp-56-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "models_cache.json"),
      JSON.stringify({ models: [
        { id: "gpt-5.6-sol" }, { id: "gpt-5.6-terra" }, { id: "gpt-5.6-luna" },
        { id: "gpt-5.5" }, { id: "gpt-5.4-mini" },
      ] }),
    );
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(home, ".codex");
    try {
      const b = new ChatGptOAuthBackend({
        model: "gpt-5.6-sol",
        connectToolClients: async () => ({ comfyui: fakeMcpClient() }),
      });
      const ids = (await b.listModels()).map((m) => m.id);
      expect(ids).toContain("gpt-5.6-sol");
      expect(ids).toContain("gpt-5.6-terra");
      expect(ids).toContain("gpt-5.6-luna");
      expect(ids).not.toContain("gpt-5.5");
      expect(ids).not.toContain("gpt-5.4-mini");
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps the full cache when no 5.6 model is present (older plans never brick)", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmcp-56b-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "models_cache.json"),
      JSON.stringify({ models: [{ id: "gpt-5.5" }, { id: "gpt-5.4-mini" }] }),
    );
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(home, ".codex");
    try {
      const b = new ChatGptOAuthBackend({
        model: "gpt-5.5",
        connectToolClients: async () => ({ comfyui: fakeMcpClient() }),
      });
      const ids = (await b.listModels()).map((m) => m.id);
      expect(ids).toContain("gpt-5.5");
      expect(ids).toContain("gpt-5.4-mini");
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(!!process.env.COMFYUI_MCP_CHATGPT_MODEL)("CHATGPT_DEFAULT_MODEL is gpt-5.6-luna", () => {
    // (skipped when COMFYUI_MCP_CHATGPT_MODEL overrides the baked default)
    expect(CHATGPT_DEFAULT_MODEL).toBe("gpt-5.6-luna");
  });

  it("migrates a deprecated ACTIVE model to the family default instead of re-inserting it", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmcp-56c-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "models_cache.json"),
      JSON.stringify({ models: [
        { id: "gpt-5.6-sol" }, { id: "gpt-5.6-terra" }, { id: "gpt-5.6-luna" }, { id: "gpt-5.4-mini" },
      ] }),
    );
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(home, ".codex");
    try {
      // A tab that saved the OLD default keeps pushing it on reconnect — the
      // list must not re-insert it at the head (it 400s every turn now).
      const b = new ChatGptOAuthBackend({
        model: "gpt-5.4-mini",
        connectToolClients: async () => ({ comfyui: fakeMcpClient() }),
      });
      const ids = (await b.listModels()).map((m) => m.id);
      expect(ids).not.toContain("gpt-5.4-mini");
      expect(ids[0].startsWith("gpt-5.6")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// Both cases below came from the merge gate on this PR, not from the report.
describe("ChatGptOAuthBackend — a 429 is neither an image rejection nor a model switch", () => {
  it("a rate limit on a turn carrying an image does NOT strip the image", async () => {
    // The catch that handles image rejection fires on ANY error once the history holds an
    // image. A RateLimitError landing there tells the user this endpoint refused image
    // input — which is false — and then answers WITHOUT the image they attached. A 429
    // with no parseable window classifies as `unknown` and is never retried, so with the
    // guard absent the strip-and-retry path is the only thing that can run.
    rateLimitNextWith = { body: JSON.stringify({ error: { message: "slow down" } }) };
    const events = await collect(makeBackend(), turnsOf(IMG_TURN));

    // The image survives on EVERY request that went out — nothing silently dropped it.
    for (const req of responsesRequests) {
      expect(userContent(req).some((c) => c.type === "input_image")).toBe(true);
    }

    // And the user is never told this endpoint refused images, because it did not.
    const said = events
      .filter((e) => e.type === "assistant")
      .map((e) => (e as { text: string }).text)
      .join(" ");
    expect(said).not.toContain("rejected image input");
    // The note the strip path writes into history must be absent too.
    const historyNotes = responsesRequests.flatMap((r) =>
      userContent(r).map((c) => String(c.text ?? "")),
    );
    expect(historyNotes.some((t) => t.includes("were removed"))).toBe(false);
  });

  it("a retried request keeps the model the notice named, not one chosen mid-backoff", async () => {
    // The retry thunk re-read `this.model`, so a switch during the wait sent the SAME turn
    // to a different model while the notice the user had already read named the old one.
    const backend = makeBackend();
    onRateLimited = () => {
      void backend.setModel("gpt-5.4");
    };
    rateLimitNextWith = {
      body: JSON.stringify({ error: { message: "rate limited" } }),
      headers: { "retry-after": "1" },
    };

    await collect(backend, turnsOf({ text: "hello" }));

    expect(responsesRequests.length).toBeGreaterThanOrEqual(2);
    expect(responsesRequests[0].model).toBe("gpt-5.4-mini");
    // The switch DID land on the instance — this pins the capture, not inertia.
    expect(backend.model).toBe("gpt-5.4");
    expect(responsesRequests[1].model).toBe("gpt-5.4-mini");
  });
});
