// #2221 — the openai-compatible lane shipped inline images unbounded, and the
// recovery that should have caught the resulting 413 was unreachable from the
// state that produced it.
//
// Two halves, pinned separately here because either one alone leaves the bug:
//
//   • The BOUND. `fetchImageB64` caps a single ref at 12 MB of RAW bytes; the
//     wire carries base64 (4/3 larger), a turn may attach 4 refs, and
//     `this.history` is built once per session and never trimmed — so every
//     image any turn ever attached rides every later request. Nothing summed
//     that.
//   • The RECOVERY. The 4xx strip-and-retry is gated on `unprovenMedia`, which
//     is false for a turn that attaches nothing. The reported turn was plain
//     text, so the strip never armed and the error rethrew — and since history
//     is stable, every retry rebuilt the identical oversized payload. The
//     session could not be talked out of it.
//
// The reproduction below is the reported shape exactly: an image lands on one
// turn, and a later PLAIN-TEXT turn is refused for size.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OllamaBackend, type McpToolClient } from "../../orchestrator/ollama-backend.js";
import type { AgentEvent, NeutralTurn } from "../../orchestrator/agent-backend.js";

type OpenAiMsg = {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
};

let openaiChatRequests: Array<{ messages: OpenAiMsg[] }> = [];
/** Statuses to answer the next chat requests with, consumed one per request.
 *  An entry of 0 (or an exhausted queue) means "respond normally". */
let chatStatusQueue: number[] = [];
/** Raw bytes /view hands back for every image ref. */
let viewImageRawBytes = 4;

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
  if (url.includes("/view?")) {
    return new Response(new Uint8Array(viewImageRawBytes).fill(0x41), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }
  if (url.endsWith("/models")) {
    // `prepare()` reachability probe — without it every run() throws before a
    // single chat request is made.
    return new Response(JSON.stringify({ data: [{ id: "xiaomi/mimo-v2.5" }] }), { status: 200 });
  }
  if (url.endsWith("/chat/completions")) {
    openaiChatRequests.push(JSON.parse(String(init?.body)));
    const status = chatStatusQueue.shift() ?? 0;
    if (status) {
      return new Response(
        JSON.stringify({ error: { message: "Downloaded image content cannot exceed 30MB", code: status } }),
        { status },
      );
    }
    return new Response(sseOk(), { status: 200 });
  }
  return new Response("not found", { status: 404 });
});

function fakeComfyClient(): McpToolClient {
  return {
    listTools: async () => ({
      tools: [
        { name: "list_tools", description: "Catalog.", inputSchema: { type: "object", properties: {} } },
        { name: "describe_tool", description: "Describe.", inputSchema: { type: "object", properties: {} } },
        { name: "call_tool", description: "Run.", inputSchema: { type: "object", properties: {} } },
      ],
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

const imageTurn = (text: string, filename: string): NeutralTurn => ({
  text,
  images: [{ filename, type: "input" }],
});

/** Every image_url data URL on the request, in order. */
function imagePartsOf(req: { messages: OpenAiMsg[] }): string[] {
  return req.messages.flatMap((m) =>
    Array.isArray(m.content)
      ? m.content.filter((p) => p.type === "image_url").map((p) => p.image_url?.url ?? "")
      : [],
  );
}

function assistantTexts(events: AgentEvent[]): string[] {
  return events.filter((e) => e.type === "assistant").map((e) => (e as { text: string }).text);
}

beforeEach(() => {
  openaiChatRequests = [];
  chatStatusQueue = [];
  viewImageRawBytes = 4;
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("#2221 — inline image payload is bounded before the request is sent", () => {
  it("sums images across the WHOLE history and drops the oldest to fit the budget", async () => {
    // 3000 raw bytes encodes to exactly 4000 base64 bytes. Two of them (8000)
    // overrun a 5000-byte budget; one does not — so the trim must remove
    // precisely the older message's image and keep the newer one.
    viewImageRawBytes = 3000;
    vi.stubEnv("COMFYUI_MCP_OLLAMA_MAX_IMAGE_BYTES", "5000");

    const events = await collect(
      backend(),
      turnsOf(imageTurn("first frame?", "a.png"), imageTurn("and the last frame?", "b.png")),
    );

    // Turn 1 was under budget on its own and went out untouched.
    expect(imagePartsOf(openaiChatRequests[0])).toHaveLength(1);
    // Turn 2 would have carried BOTH (this is the accumulation that made the
    // payload grow without limit); it carries only the newest.
    expect(imagePartsOf(openaiChatRequests[1])).toHaveLength(1);
    // Exactly one request per turn — the bound is applied a priori, not by
    // spending a round-trip on a rejection first.
    expect(openaiChatRequests).toHaveLength(2);

    // The model is told, and told the TRUE version: it did see that image, it
    // just no longer has it. Claiming a non-delivery for media it described a
    // turn ago would put it at odds with its own transcript.
    const trimmedMsg = openaiChatRequests[1].messages.find(
      (m) => typeof m.content === "string" && m.content.includes("first frame?"),
    );
    expect(String(trimmedMsg?.content)).toContain("You DID receive them earlier");
    // The budget is named in units that survive a sub-megabyte override — a
    // note claiming an "0 MB image limit" would be worse than no number.
    expect(String(trimmedMsg?.content)).toContain("image limit (5000 bytes)");

    // And so is the user — a silently dropped attachment is the failure mode
    // this whole file exists to avoid.
    expect(assistantTexts(events).some((t) => t.includes("dropped the oldest 1 image(s)"))).toBe(true);
  });

  it("CONTROL: an ordinary image turn under the default budget is untouched", async () => {
    // No env override: the real 30 MB default. A normal attachment must not be
    // trimmed, or the fix would silently un-ship inline vision.
    viewImageRawBytes = 3000;
    const events = await collect(backend(), turnsOf(imageTurn("what is this?", "a.png")));
    expect(imagePartsOf(openaiChatRequests[0])).toHaveLength(1);
    expect(assistantTexts(events).some((t) => t.includes("dropped"))).toBe(false);
  });

  it("ignores a non-numeric budget override rather than dropping every image", async () => {
    // `=30MB` parses to NaN. Obeying it would compare against NaN, which is
    // false for `<=`, and strip every image on every request forever.
    viewImageRawBytes = 3000;
    vi.stubEnv("COMFYUI_MCP_OLLAMA_MAX_IMAGE_BYTES", "30MB");
    await collect(backend(), turnsOf(imageTurn("what is this?", "a.png")));
    expect(imagePartsOf(openaiChatRequests[0])).toHaveLength(1);
  });
});

describe("#2221 — a 413 on inherited images is recoverable, not terminal", () => {
  it("REPRODUCTION: a plain-text turn refused for size strips history and retries once", async () => {
    // The reported sequence. Turn 1 delivers an image successfully. Turn 2 is
    // ordinary text — `turnSentImages` is false — and the endpoint answers the
    // accumulated payload with 413. Before the fix this rethrew: the strip was
    // gated on media THIS turn attached, so it never armed, and the next
    // attempt rebuilt the same bytes. Every later turn in the session died the
    // same way.
    chatStatusQueue = [0, 413]; // turn 1 lands; turn 2's first request is refused
    const events = await collect(
      backend(),
      turnsOf(imageTurn("look at this frame", "a.png"), { text: "this workflow appears to have firstframe last frame" }),
    );

    // turn 1 → 1 request; turn 2 → the refused one plus ONE retry.
    expect(openaiChatRequests).toHaveLength(3);
    expect(imagePartsOf(openaiChatRequests[1])).toHaveLength(1); // the payload that 413'd
    expect(imagePartsOf(openaiChatRequests[2])).toHaveLength(0); // the retry is clean

    // The turn COMPLETES. This is the whole point: the session is no longer
    // bricked by bytes it accumulated.
    const result = events.filter((e) => e.type === "result").at(-1) as { ok: boolean };
    expect(result.ok).toBe(true);

    // The user is told the real cause, and told that retrying is not the
    // remedy — the one thing the generic "turn failed … try again" got wrong.
    const texts = assistantTexts(events);
    expect(texts.some((t) => t.includes("too large for the endpoint (http 413)"))).toBe(true);
    expect(texts.some((t) => t.includes("will fail the same way"))).toBe(true);
    // It must NOT be reported as a vision-capability problem: the model can see
    // fine, and "switch to a vision-capable model" would send the user to
    // change a setting that changes nothing.
    expect(texts.some((t) => t.includes("vision-capable model"))).toBe(false);

    // The model is told the honest version too: it DID get that image.
    const stripped = openaiChatRequests[2].messages.find(
      (m) => typeof m.content === "string" && m.content.includes("look at this frame"),
    );
    expect(String(stripped?.content)).toContain("You DID receive them earlier");
  });

  it("a 413 with NO media in history is not retried, and names size as the cause", async () => {
    // Nothing to strip: a conversation that is merely long. Retrying would
    // spend a request to fail identically, so the turn ends — but it must not
    // end as an anonymous failure, because the panel's fallback advice for a
    // dead turn is "try again".
    chatStatusQueue = [413];
    const events = await collect(backend(), turnsOf({ text: "hello" }));

    expect(openaiChatRequests).toHaveLength(1); // refused, no retry
    const result = events.find((e) => e.type === "result") as { ok: boolean };
    expect(result.ok).toBe(false);

    const texts = assistantTexts(events);
    expect(texts.some((t) => t.includes("too large for this endpoint to accept (http 413)"))).toBe(true);
    expect(texts.some((t) => t.includes("Retrying the same message will not help"))).toBe(true);
    // The provider's own sentence is the most useful one available — keep it.
    expect(texts.some((t) => t.includes("Downloaded image content cannot exceed 30MB"))).toBe(true);
  });

  it("a 5xx is NOT treated as an oversized payload (no strip, no size claim)", async () => {
    // 413 is the only status that licenses blaming size. A 502 is the endpoint
    // failing, and stripping the user's image on one would destroy context for
    // a reason that was never observed.
    chatStatusQueue = [0, 502];
    const events = await collect(
      backend(),
      turnsOf(imageTurn("look at this frame", "a.png"), { text: "and now?" }),
    );
    expect(openaiChatRequests).toHaveLength(2); // no retry
    expect(assistantTexts(events).some((t) => t.includes("too large"))).toBe(false);
    // history keeps the image: the second request still carried it
    expect(imagePartsOf(openaiChatRequests[1])).toHaveLength(1);
  });
});
