import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OllamaBackend, type McpToolClient } from "../../orchestrator/ollama-backend.js";
import type { AgentEvent, NeutralTurn } from "../../orchestrator/agent-backend.js";

// Audio attachments on an agent turn (#790).
//
// The wire facts asserted here were established LIVE against Ollama 0.x on
// 2026-08-04 with gemma4:e2b, not inferred from a model card:
//   • native /api/chat carries audio in message.images[] — a WAV posted that way
//     came back correctly transcribed, and cost +40 prompt tokens over the same
//     text-only turn, while the same bytes under an "audio" key cost 0 extra
//     (i.e. were silently ignored, the exact failure this feature prevents);
//   • /v1/chat/completions carries it as an input_audio part — also transcribed;
//     the same bytes in an image_url part are a hard 400 "invalid image input";
//   • POST /api/show reports capabilities including "audio" — and GET /api/tags
//     reported ["completion","tools","thinking"] for the SAME model, which is
//     why the probe below must not use the cheap listing.

let showCapabilities: string[] | null | "http-error" | "throw" = ["completion", "tools", "audio"];
let viewBody: Uint8Array = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // "RIFF"
let viewContentType = "application/octet-stream";
let viewStatus = 200;
let chatRequests: Array<Record<string, unknown>> = [];
let openaiChatRequests: Array<Record<string, unknown>> = [];
let rejectNextChatWith: string | null = null;
/** Reject the Nth /api/chat request of the file (1-based); null = never. */
let rejectChatRequestNo: number | null = null;
let chatRequestCount = 0;
/** Tool calls to return on the FIRST chat response, so a turn can run a
 *  successful round and then fail on a later one. */
let firstResponseToolCalls: Array<Record<string, unknown>> | null = null;
let showCalls = 0;

function ndjson(chunks: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(`${JSON.stringify(ch)}\n`));
      c.close();
    },
  });
}

function sse(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n`));
      c.enqueue(enc.encode("data: [DONE]\n"));
      c.close();
    },
  });
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.31.1" }), { status: 200 });
  if (url.endsWith("/api/tags")) {
    // Deliberately reports NO audio capability. If the probe ever regresses to
    // this endpoint, the audio-capable cases below start refusing.
    return new Response(
      JSON.stringify({ models: [{ name: "gemma4:e2b", capabilities: ["completion", "tools", "thinking"] }] }),
      { status: 200 },
    );
  }
  if (url.endsWith("/v1/models")) {
    return new Response(JSON.stringify({ data: [{ id: "vendor/omni" }] }), { status: 200 });
  }
  if (url.endsWith("/api/show")) {
    showCalls++;
    if (showCapabilities === "throw") throw new Error("connection reset");
    if (showCapabilities === "http-error") return new Response("nope", { status: 500 });
    if (showCapabilities === null) return new Response(JSON.stringify({ details: {} }), { status: 200 });
    return new Response(JSON.stringify({ capabilities: showCapabilities }), { status: 200 });
  }
  if (url.includes("/view?")) {
    if (viewStatus !== 200) return new Response("gone", { status: viewStatus });
    return new Response(viewBody, { status: 200, headers: { "content-type": viewContentType } });
  }
  if (url.endsWith("/chat/completions")) {
    openaiChatRequests.push(JSON.parse(String(init?.body)));
    if (rejectNextChatWith) {
      const m = rejectNextChatWith;
      rejectNextChatWith = null;
      return new Response(m, { status: 400 });
    }
    return new Response(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]), { status: 200 });
  }
  if (url.endsWith("/api/chat")) {
    chatRequests.push(JSON.parse(String(init?.body)));
    chatRequestCount += 1;
    if (rejectChatRequestNo !== null && chatRequestCount === rejectChatRequestNo) {
      return new Response("unsupported media type", { status: 400 });
    }
    if (rejectNextChatWith) {
      const m = rejectNextChatWith;
      rejectNextChatWith = null;
      return new Response(m, { status: 400 });
    }
    if (chatRequestCount === 1 && firstResponseToolCalls) {
      return new Response(
        ndjson([{ message: { content: "", tool_calls: firstResponseToolCalls }, done: true }]),
        { status: 200 },
      );
    }
    return new Response(ndjson([{ message: { content: "ok" }, done: true }]), { status: 200 });
  }
  return new Response("not found", { status: 404 });
});

const COMFY_META = [{ name: "call_tool", description: "Run.", inputSchema: { type: "object", properties: {} } }];

function fakeMcpClient(): McpToolClient {
  return {
    listTools: async () => ({ tools: COMFY_META }),
    callTool: (async () => ({ content: [{ type: "text", text: "x" }] })) as unknown as McpToolClient["callTool"],
    close: async () => {},
  };
}

async function* turnsOf(...turns: NeutralTurn[]): AsyncGenerator<NeutralTurn> {
  for (const t of turns) yield t;
}

async function collect(backend: OllamaBackend, channel: AsyncIterable<NeutralTurn>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of backend.run({ channel })) events.push(ev);
  return events;
}

function assistantText(events: AgentEvent[]): string {
  return events
    .filter((e) => e.type === "assistant")
    .map((e) => (e as { text: string }).text)
    .join("\n");
}

function nativeBackend(model = "gemma4:e2b") {
  return new OllamaBackend({
    model,
    comfyuiUrl: "http://127.0.0.1:8188",
    connectToolClients: async () => ({ comfyui: fakeMcpClient() }),
  });
}

const AUDIO_TURN: NeutralTurn = {
  text: "what do you hear?",
  audio: [{ filename: "song.wav", type: "input" }],
};

const RIFF_B64 = Buffer.from([0x52, 0x49, 0x46, 0x46]).toString("base64");

beforeEach(() => {
  showCapabilities = ["completion", "tools", "audio"];
  viewBody = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
  viewContentType = "application/octet-stream";
  viewStatus = 200;
  chatRequests = [];
  openaiChatRequests = [];
  rejectNextChatWith = null;
  rejectChatRequestNo = null;
  chatRequestCount = 0;
  firstResponseToolCalls = null;
  showCalls = 0;
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("#790 — a backend that SUPPORTS audio, with a model that can hear", () => {
  it("native dialect: the audio rides in message.images[] (Ollama's own audio carrier)", async () => {
    const events = await collect(nativeBackend(), turnsOf(AUDIO_TURN));
    const user = (chatRequests[0].messages as Array<Record<string, unknown>>).find((m) => m.role === "user") as {
      images?: string[];
      content: string;
    };
    expect(user.images).toEqual([RIFF_B64]);
    // Our internal book-keeping fields must NOT reach the daemon.
    expect(user).not.toHaveProperty("audios");
    expect(user).not.toHaveProperty("audioMimes");
    // Capability was ESTABLISHED, so no hedging notice is shown.
    expect(assistantText(events)).not.toContain("cannot confirm");
  });

  it("tells the MODEL the audio is there, so it doesn't reason itself out of a sense it has", async () => {
    // Measured live: with the audio demonstrably in context (555 prompt tokens,
    // /api/show reporting `audio`), gemma4:e2b still answered "I do not have the
    // capability to transcribe audio" — the panel prompt casts it as a graph
    // operator. With this note it transcribes correctly, four runs out of four.
    await collect(nativeBackend(), turnsOf(AUDIO_TURN));
    const user = (chatRequests[0].messages as Array<Record<string, unknown>>).find((m) => m.role === "user") as {
      content: string;
    };
    expect(user.content).toContain("you can hear them");
    expect(user.content).toContain("gemma4:e2b");
    expect(user.content).toContain("Do NOT reply that you cannot process audio");
  });

  it("does NOT tell an unverified endpoint's model that it can hear", async () => {
    // Only the probe licenses that claim. Without one, the note must hedge.
    const backend = new OllamaBackend({
      api: "openai",
      host: "http://127.0.0.1:9999/v1",
      apiKey: "sk-test",
      model: "vendor/omni",
      comfyuiUrl: "http://127.0.0.1:8188",
      connectToolClients: async () => ({ comfyui: fakeMcpClient() }),
    });
    await collect(backend, turnsOf(AUDIO_TURN));
    const user = (openaiChatRequests[0].messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "user",
    ) as { content: Array<{ type: string; text?: string }> };
    const text = user.content.find((p) => p.type === "text")?.text ?? "";
    expect(text).toContain("UNCONFIRMED");
    expect(text).not.toContain("you can hear them");
  });

  it("establishes the capability from /api/show, NOT from the /api/tags listing", async () => {
    await collect(nativeBackend(), turnsOf(AUDIO_TURN));
    // The tags listing in this mock reports no audio for the same model; if the
    // probe read it, the attachment above would have been refused.
    expect(showCalls).toBeGreaterThan(0);
  });

  it("openai dialect: the audio becomes an input_audio part, never an image_url", async () => {
    const backend = new OllamaBackend({
      api: "openai",
      host: "http://127.0.0.1:9999/v1",
      apiKey: "sk-test",
      model: "vendor/omni",
      comfyuiUrl: "http://127.0.0.1:8188",
      connectToolClients: async () => ({ comfyui: fakeMcpClient() }),
    });
    await collect(backend, turnsOf(AUDIO_TURN));
    const user = (openaiChatRequests[0].messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "user",
    ) as { content: Array<{ type: string; input_audio?: { data: string; format: string } }> };
    const audioPart = user.content.find((p) => p.type === "input_audio");
    expect(audioPart?.input_audio).toEqual({ data: RIFF_B64, format: "wav" });
    // An audio data-URL in an image_url part is a hard 400 on this dialect.
    expect(user.content.some((p) => p.type === "image_url")).toBe(false);
  });
});

describe("#790 — a MODEL that cannot take audio", () => {
  it("REFUSES by name, quotes the reported capabilities, and sends no audio", async () => {
    showCapabilities = ["completion", "tools", "thinking"];
    const events = await collect(nativeBackend("qwen3:4b"), turnsOf(AUDIO_TURN));
    const said = assistantText(events);
    expect(said).toContain("qwen3:4b");
    expect(said).toContain("completion, tools, thinking");
    expect(said).toContain("ollama pull"); // the remedy, not just the verdict
    const user = (chatRequests[0].messages as Array<Record<string, unknown>>).find((m) => m.role === "user") as {
      images?: string[];
      content: string;
    };
    expect(user.images).toBeUndefined();
    // And the MODEL is told too, so it cannot answer as though it had listened.
    expect(user.content).toContain("did NOT hear");
  });
});

describe("#1972 — a model that ACCEPTS audio in images[] is not a model that can hear", () => {
  function viewFetches(): number {
    return fetchMock.mock.calls.filter((c) => String(c[0]).includes("/view?")).length;
  }

  it("REFUSES gemma-4-abliterated even when /api/show lists audio, and never puts bytes on images[]", async () => {
    // Live: this tag returns HTTP 200 plus a fluent fabricated transcript that
    // changes every run. The architecture flag is not a hearing guarantee, so
    // native Ollama must fail closed rather than ship a WAV in the image slot.
    showCapabilities = ["completion", "vision", "audio", "tools", "thinking"];
    const model = "huihui_ai/gemma-4-abliterated:E4b-qat";
    const events = await collect(nativeBackend(model), turnsOf(AUDIO_TURN));
    const said = assistantText(events);
    expect(said).toContain(model);
    expect(said).toContain("invent a transcript");
    expect(said).toContain("ollama pull");
    expect(said).not.toContain("cannot confirm");
    const user = (chatRequests[0].messages as Array<Record<string, unknown>>).find((m) => m.role === "user") as {
      images?: string[];
      content: string;
    };
    expect(user.images).toBeUndefined();
    expect(user.content).toContain("did NOT hear");
    // Refused before fetch — we do not pull ComfyUI bytes we will not send.
    expect(viewFetches()).toBe(0);
  });

  it("REFUSES the default fine-tune the same way — that tag HTTP 400s on the image slot", async () => {
    showCapabilities = ["completion", "vision", "audio", "tools", "thinking"];
    const events = await collect(nativeBackend("artokun/gemma4-comfyui-mcp:e4b"), turnsOf(AUDIO_TURN));
    const user = (chatRequests[0].messages as Array<Record<string, unknown>>).find((m) => m.role === "user") as {
      images?: string[];
    };
    expect(user.images).toBeUndefined();
    expect(assistantText(events)).toContain("artokun/gemma4-comfyui-mcp:e4b");
    expect(viewFetches()).toBe(0);
  });

  it("does NOT apply the allowlist on the OpenAI dialect — that path uses input_audio, not images[]", async () => {
    const backend = new OllamaBackend({
      api: "openai",
      host: "http://127.0.0.1:9999/v1",
      apiKey: "sk-test",
      model: "huihui_ai/gemma-4-abliterated:E4b-qat",
      comfyuiUrl: "http://127.0.0.1:8188",
      connectToolClients: async () => ({ comfyui: fakeMcpClient() }),
    });
    await collect(backend, turnsOf(AUDIO_TURN));
    const user = (openaiChatRequests[0].messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "user",
    ) as { content: Array<{ type: string; input_audio?: { data: string; format: string } }> };
    const audioPart = user.content.find((p) => p.type === "input_audio");
    expect(audioPart?.input_audio).toEqual({ data: RIFF_B64, format: "wav" });
  });

  it("a live model SWITCH does not replay delivered audio into the new model's images[]", async () => {
    // The attach-time gate only sees the turn the audio arrives on. Ollama is
    // stateless per request, so history is re-serialized every turn and
    // toOllamaMessages merges `audios` into `images[]` — measured: turn 2 to
    // huihui_ai/gemma-4-abliterated:E4b-qat carried ["UklGRg=="] plus the
    // earlier "you can hear them" note, with no new attachment anywhere in it.
    // Reachable from panel-agent.ts setModel, which switches live and keeps
    // history.
    const backend = nativeBackend("gemma4:e2b"); // allowlisted: turn 1 delivers
    await collect(backend, turnsOf(AUDIO_TURN));
    const t1 = (chatRequests[0].messages as Array<Record<string, unknown>>).find((m) => m.role === "user") as {
      images?: string[];
    };
    expect(t1.images).toEqual([RIFF_B64]); // baseline — the gate let this through

    await backend.setModel("huihui_ai/gemma-4-abliterated:E4b-qat");
    await collect(backend, turnsOf({ text: "and now?" })); // TEXT only — no new audio

    const t2 = chatRequests[1];
    expect(t2.model).toBe("huihui_ai/gemma-4-abliterated:E4b-qat");
    const replayed = (t2.messages as Array<Record<string, unknown>>).filter((m) =>
      Array.isArray((m as { images?: string[] }).images),
    );
    for (const m of replayed) expect((m as { images: string[] }).images).not.toContain(RIFF_B64);
    // The stale "you can hear them" note is still in that message, so silence is
    // not enough — the new model must be told the audio is NOT in its context.
    const stale = (t2.messages as Array<Record<string, unknown>>).find((m) =>
      String((m as { content: string }).content).includes("what do you hear?"),
    ) as { content: string };
    expect(stale.content).toContain("You did NOT hear this audio");
    expect(stale.content).toContain("no longer applies");
  });
});

describe("#790 — an UNSUPPORTED attachment type", () => {
  it("REFUSES a non-audio file and lists the formats that would work", async () => {
    const events = await collect(
      nativeBackend(),
      turnsOf({ text: "listen", audio: [{ filename: "clip.mp4", type: "input" }] }),
    );
    const said = assistantText(events);
    expect(said).toContain("clip.mp4");
    expect(said).toContain("mp3");
    const user = (chatRequests[0].messages as Array<Record<string, unknown>>).find((m) => m.role === "user") as {
      images?: string[];
      content: string;
    };
    expect(user.images).toBeUndefined();
    expect(user.content).toContain("did NOT hear");
  });
});

describe("#790 — an attachment that is PRESENT but EMPTY", () => {
  it("REFUSES a zero-byte file out loud instead of sending nothing quietly", async () => {
    viewBody = new Uint8Array([]);
    const events = await collect(nativeBackend(), turnsOf(AUDIO_TURN));
    const said = assistantText(events);
    expect(said).toContain("song.wav");
    expect(said).toContain("0 bytes");
    const user = (chatRequests[0].messages as Array<Record<string, unknown>>).find((m) => m.role === "user") as {
      images?: string[];
    };
    expect(user.images).toBeUndefined();
  });
});

describe("#790 — the capability probe is itself an operation that can fail", () => {
  it("a THROWING probe is not a refusal: audio is still attached, and the user is told it is unconfirmed", async () => {
    showCapabilities = "throw";
    const events = await collect(nativeBackend(), turnsOf(AUDIO_TURN));
    const user = (chatRequests[0].messages as Array<Record<string, unknown>>).find((m) => m.role === "user") as {
      images?: string[];
      content: string;
    };
    expect(user.images).toEqual([RIFF_B64]); // attempted, not refused
    const said = assistantText(events);
    expect(said).toContain("cannot confirm");
    expect(said).not.toContain("ollama pull gemma4:e2b\n"); // not a capability refusal
    expect(user.content).toContain("UNCONFIRMED");
  });

  it("an HTTP-error probe degrades the same way", async () => {
    showCapabilities = "http-error";
    const events = await collect(nativeBackend(), turnsOf(AUDIO_TURN));
    const user = (chatRequests[0].messages as Array<Record<string, unknown>>).find((m) => m.role === "user") as {
      images?: string[];
    };
    expect(user.images).toEqual([RIFF_B64]);
    expect(assistantText(events)).toContain("cannot confirm");
  });

  it("a response with no capabilities array is UNKNOWN, not 'no audio'", async () => {
    showCapabilities = null;
    const events = await collect(nativeBackend(), turnsOf(AUDIO_TURN));
    const user = (chatRequests[0].messages as Array<Record<string, unknown>>).find((m) => m.role === "user") as {
      images?: string[];
    };
    expect(user.images).toEqual([RIFF_B64]);
    expect(assistantText(events)).toContain("cannot confirm");
  });

  it("a failed probe is NOT memoised — a later turn re-probes and can establish it", async () => {
    const backend = nativeBackend();
    showCapabilities = "throw";
    const first = await collect(backend, turnsOf(AUDIO_TURN));
    expect(assistantText(first)).toContain("cannot confirm");
    showCapabilities = ["completion", "audio"];
    const second = await collect(backend, turnsOf(AUDIO_TURN));
    expect(assistantText(second)).not.toContain("cannot confirm");
  });
});

describe("#790 — an endpoint that rejects the request after we attached audio", () => {
  it("corrects the record, naming HEARING rather than sight", async () => {
    rejectNextChatWith = "unsupported media type";
    const events = await collect(nativeBackend(), turnsOf(AUDIO_TURN));
    const said = assistantText(events);
    expect(said).toContain("rejected the request carrying the audio attachment");
    expect(said).toContain("did NOT hear it");
    expect(said).not.toContain("I can't see the image");
    // The retry carries no audio, and the model is told why.
    const retried = (chatRequests[1].messages as Array<Record<string, unknown>>).find((m) => m.role === "user") as {
      images?: string[];
      content: string;
    };
    expect(retried.images).toBeUndefined();
    expect(retried.content).toContain("did NOT receive them");
    expect(retried.content).toContain("did not hear any audio");
  });
});

describe("#790 — a request carrying BOTH an image and audio is rejected", () => {
  it("does not pick a cause the endpoint never gave, and names BOTH lost senses", async () => {
    // The endpoint's error carries no attribution. Blaming the audio (or the
    // image) would be a diagnosis we cannot make — a fabricated observation.
    // Leave the generic octet-stream Content-Type: the audio path accepts it and
    // the image path clamps it, so BOTH attachments land and the rejection below
    // is genuinely ambiguous - which is the point of this test.
    rejectNextChatWith = "cannot process input";
    const backend = nativeBackend();
    const events = await collect(
      backend,
      turnsOf({
        text: "compare these",
        images: [{ filename: "shot.png", type: "input" }],
        audio: [{ filename: "song.wav", type: "input" }],
      }),
    );
    const said = assistantText(events);
    expect(said).toContain("didn't say which one it objected to");
    expect(said).toContain("did NOT see the image");
    expect(said).toContain("did NOT hear the audio");
    // …and it must NOT assert the audio-only story.
    expect(said).not.toContain("rejected the request carrying the audio attachment,");
  });
});

describe("#790 — only an OBSERVED rejection may be reported as one", () => {
  it("a transport failure is NOT reported as the model refusing the audio", async () => {
    // A connection reset says nothing about the attachment. Stripping it and
    // saying "I did NOT hear it" would report a delivery state nobody observed.
    const backend = nativeBackend();
    const boom = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).endsWith("/api/chat")) throw new Error("ECONNRESET");
      return fetchMock(input, init);
    });
    vi.stubGlobal("fetch", boom);
    const events = await collect(backend, turnsOf(AUDIO_TURN));
    const said = assistantText(events);
    expect(said).not.toContain("did NOT hear");
    expect(said).not.toContain("rejected the request carrying");
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("a 5xx is not a rejection of the attachment either", async () => {
    const backend = nativeBackend();
    const boom = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).endsWith("/api/chat")) return new Response("upstream down", { status: 503 });
      return fetchMock(input, init);
    });
    vi.stubGlobal("fetch", boom);
    const said = assistantText(await collect(backend, turnsOf(AUDIO_TURN)));
    expect(said).not.toContain("did NOT hear");
  });
});

describe("#790 — a later error must not fabricate a delivery failure", () => {
  it("a failure in a LATER ROUND of the same turn does not blame audio the model already got", async () => {
    // Round 1 carries the audio and succeeds — the model has it. Round 2 (after
    // a tool call) fails. Stripping then, and saying "you were not heard",
    // reports a delivery failure that did not happen, for a file the model
    // demonstrably received. This is the case the per-turn proof exists for.
    firstResponseToolCalls = [{ function: { name: "call_tool", arguments: {} } }];
    rejectChatRequestNo = 2;
    const said = assistantText(await collect(nativeBackend(), turnsOf(AUDIO_TURN)));
    expect(said).not.toContain("did NOT hear");
    expect(said).not.toContain("rejected the request carrying");
  });

  it("but a failure on the FIRST round, before anything landed, IS reported", async () => {
    // The mirror image: nothing has come back, so the audio plausibly did not
    // arrive — and after the strip it certainly hasn't.
    rejectChatRequestNo = 1;
    const said = assistantText(await collect(nativeBackend(), turnsOf(AUDIO_TURN)));
    expect(said).toContain("rejected the request carrying the audio attachment");
    expect(said).toContain("did NOT hear it");
  });

  it("does not blame the attachment once a request carrying it has already succeeded", async () => {
    // Turn 1 delivers the audio fine. Turn 2 (whose history still holds it)
    // fails for an unrelated reason. Telling the user "I did NOT hear it" then
    // would report a failure that never happened for media the model received.
    const backend = nativeBackend();
    await collect(backend, turnsOf(AUDIO_TURN));
    rejectNextChatWith = "rate limited";
    const events = await collect(backend, turnsOf({ text: "and now?" }));
    const said = assistantText(events);
    expect(said).not.toContain("did NOT hear");
    expect(said).not.toContain("rejected the request carrying");
    // The error surfaces as a normal error rather than a false attachment story.
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("an accepted IMAGE is not evidence that audio is accepted", async () => {
    // One shared latch would let an earlier image swallow a genuine audio
    // rejection — the silent unheard attachment, hidden by the guard meant to
    // prevent the opposite mistake.
    const backend = nativeBackend();
    await collect(backend, turnsOf({ text: "look", images: [{ filename: "shot.png", type: "input" }] }));
    rejectNextChatWith = "unsupported media type";
    const said = assistantText(await collect(backend, turnsOf(AUDIO_TURN)));
    expect(said).toContain("did NOT hear it");
  });

  it("a NEW audio file is judged on its own, not on an earlier file's success", async () => {
    // Session-wide proof is too coarse in this direction: an earlier clip
    // landing says nothing about the one attached NOW (a codec the model cannot
    // decode, a longer file). Suppressing the correction here would leave the
    // user with a generic failure and no idea the audio never arrived.
    const backend = nativeBackend();
    await collect(backend, turnsOf(AUDIO_TURN)); // accepted
    rejectNextChatWith = "unsupported media type";
    const said = assistantText(await collect(backend, turnsOf(AUDIO_TURN))); // a NEW attachment
    expect(said).toContain("rejected the request carrying the audio attachment");
    expect(said).toContain("did NOT hear it");
  });

  it("a tool-listing failure drops the surface instead of claiming one it does not have", async () => {
    // A client can CONNECT and still fail to enumerate. Keeping the decision
    // would report a mode for a catalog the model does not actually have, and
    // reconcile would read it as live-and-matching and never retry.
    const backend = new OllamaBackend({
      model: "gemma4:e2b",
      connectToolClients: async () => ({
        comfyui: {
          listTools: async () => {
            throw new Error("mcp closed");
          },
          callTool: (async () => ({ content: [] })) as unknown as McpToolClient["callTool"],
          close: async () => {},
        },
      }),
    });
    const anyBackend = backend as unknown as { comfy: unknown; comfyTools: unknown[]; toolModeDecision: unknown };
    await backend.prepare();
    expect(anyBackend.comfy).toBeNull();
    expect(anyBackend.comfyTools).toEqual([]);
    expect(anyBackend.toolModeDecision).toBeNull();
  });

  it("an accepted AUDIO turn still suppresses a later unrelated error", async () => {
    // The other direction of the same rule: once audio HAS been accepted, a
    // later error must not be reported as an audio rejection.
    const backend = nativeBackend();
    await collect(backend, turnsOf(AUDIO_TURN));
    rejectNextChatWith = "rate limited";
    const said = assistantText(await collect(backend, turnsOf({ text: "and?" })));
    expect(said).not.toContain("did NOT hear");
  });

  it("the proof does not carry across a MODEL SWITCH either", async () => {
    // The per-turn rule gets this for free, and it is the case that matters
    // most: the new model has never taken anything, so its rejection must be
    // reported rather than swallowed by what the previous model accepted.
    const backend = nativeBackend();
    await collect(backend, turnsOf(AUDIO_TURN)); // gemma4:e2b accepts it
    await backend.setModel("gemma4:e4b");
    showCapabilities = "http-error"; // unverified, so delivery is attempted
    rejectNextChatWith = "unsupported media type";
    const said = assistantText(await collect(backend, turnsOf(AUDIO_TURN)));
    expect(said).toContain("rejected the request carrying the audio attachment");
    expect(said).toContain("did NOT hear it");
  });

  it("when only an EARLIER turn's media is in history, it does not claim the user's new message lost anything", async () => {
    const b2 = nativeBackend();
    const anyB2 = b2 as unknown as { history: Array<Record<string, unknown>> };
    // Turn 1 carries NO media, so nothing has proven the endpoint accepts
    // attachments and the degradation path stays armed. It also establishes the
    // session, so turn 2 keeps this history rather than starting fresh.
    await collect(b2, turnsOf({ text: "first" }));
    anyB2.history.push({ role: "user", content: "older turn", images: ["QUJD"] });
    rejectNextChatWith = "cannot process input";
    const events = await collect(b2, turnsOf({ text: "plain follow-up" }));
    const said = assistantText(events);
    // A turn that attached nothing makes NO claim about media inherited from an
    // earlier turn: that media was already delivered, so "you did not hear it"
    // would be false, and "I dropped it" is noise on an unrelated error.
    expect(said).not.toContain("did NOT hear");
    expect(said).not.toContain("rejected");
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});

describe("#790 — a strip must not fabricate a non-delivery for accepted media", () => {
  it("tells the model that EARLIER, accepted media was only dropped from context", async () => {
    // Turn 1's audio was accepted - the model heard it. Turn 2 attaches new
    // audio that is rejected; the retry has to clear ALL media so it can
    // succeed, but annotating turn 1 with "you did NOT hear it" would invent a
    // failure for a file the model demonstrably received.
    const backend = nativeBackend();
    await collect(backend, turnsOf(AUDIO_TURN)); // accepted
    rejectNextChatWith = "unsupported media type";
    await collect(backend, turnsOf(AUDIO_TURN)); // new attachment, rejected
    const retried = (chatRequests.at(-1)!.messages as Array<Record<string, unknown>>).filter(
      (m) => m.role === "user",
    ) as Array<{ content: string }>;
    // The OLD message: dropped from context, but received.
    expect(retried[0].content).toContain("You DID receive them earlier");
    expect(retried[0].content).not.toContain("did NOT receive");
    // The NEW message: genuinely never received.
    expect(retried[retried.length - 1].content).toContain("did NOT receive them");
  });
});

describe("#790 — a malformed capabilities payload is UNKNOWN, not a refusal", () => {
  it("does not turn a broken /api/show response into a confident 'no audio'", async () => {
    showCapabilities = [null as unknown as string];
    const events = await collect(nativeBackend(), turnsOf(AUDIO_TURN));
    const said = assistantText(events);
    expect(said).not.toContain("no audio");
    expect(said).toContain("cannot confirm"); // attempted, unconfirmed
    const user = (chatRequests[0].messages as Array<Record<string, unknown>>).find((m) => m.role === "user") as {
      images?: string[];
    };
    expect(user.images).toEqual([RIFF_B64]);
  });

  it("an EMPTY capabilities array is also unknown, not 'no audio'", async () => {
    showCapabilities = [];
    const said = assistantText(await collect(nativeBackend(), turnsOf(AUDIO_TURN)));
    expect(said).not.toContain("no audio");
    expect(said).toContain("cannot confirm");
  });
});

describe("#788 — the session prompt follows the mode the child was spawned with", () => {
  it("a FULL surface gets the full-surface prompt, not the compact router one", async () => {
    // The decision and the prompt have to agree. Advertising the whole catalog
    // while telling the model it "has exactly six tools" and must go through
    // call_tool makes the auto-selected full surface worse than the default it
    // replaced: the model keeps calling a router that is no longer the way in.
    const backend = new OllamaBackend({
      model: "llama3.3:70b",
      mcpServers: { comfyui: { transport: "stdio", command: "node", args: [], env: {} } },
    });
    const anyBackend = backend as unknown as {
      connectTools: () => Promise<void>;
      comfy: unknown;
      comfyTools: unknown[];
      comfySpecEnv: Record<string, string> | undefined;
      toolModeDecision: unknown;
      model: string;
    };
    anyBackend.connectTools = async () => {
      anyBackend.comfySpecEnv = {};
      anyBackend.comfy = fakeMcpClient();
      const { comfyuiSpawnToolMode } = await import("../../orchestrator/ollama-backend.js");
      anyBackend.toolModeDecision = comfyuiSpawnToolMode({}, {}, anyBackend.model);
      anyBackend.comfyTools = [];
    };
    await backend.prepare();
    await collect(backend, turnsOf({ text: "hi" }));
    const system = (chatRequests[0].messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "system",
    ) as { content: string };
    expect(system.content).toContain("advertised to you DIRECTLY");
    expect(system.content).not.toContain("exactly six tools");
  });

  it("a COMPACT surface keeps the router prompt", async () => {
    await collect(nativeBackend(), turnsOf({ text: "hi" }));
    const system = (chatRequests[0].messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "system",
    ) as { content: string };
    expect(system.content).toContain("exactly six tools");
  });
});

describe("#788 — a live model switch reconciles the tool surface", () => {
  it("respawns the comfyui tool server when the new model wants a different surface", async () => {
    let connects = 0;
    const backend = new OllamaBackend({
      model: "qwen3:4b",
      comfyuiUrl: "http://127.0.0.1:8188",
      // Exercise the real decision path: an mcpServers spec is what makes the
      // backend own the child (and therefore the tool mode) at all.
      mcpServers: { comfyui: { transport: "stdio", command: "node", args: [], env: {} } },
    });
    // Stub the spawn so the test drives reconciliation, not a real child.
    const anyBackend = backend as unknown as {
      connectTools: () => Promise<void>;
      comfy: unknown;
      comfyTools: unknown[];
      comfySpecEnv: Record<string, string> | undefined;
      toolModeDecision: { mode: string; source: string } | null;
      model: string;
    };
    anyBackend.connectTools = async () => {
      connects++;
      anyBackend.comfySpecEnv = {};
      anyBackend.comfy = fakeMcpClient();
      const { comfyuiSpawnToolMode } = await import("../../orchestrator/ollama-backend.js");
      anyBackend.toolModeDecision = comfyuiSpawnToolMode({}, {}, anyBackend.model);
      anyBackend.comfyTools = [];
    };
    await backend.prepare();
    expect(connects).toBe(1);
    expect(anyBackend.toolModeDecision?.mode).toBe("compact");

    await backend.setModel("llama3.3:70b");
    await collect(backend, turnsOf({ text: "hi" }));
    // The surface the 4B model was given must not be what the 70B one runs on.
    expect(connects).toBe(2);
    expect(anyBackend.toolModeDecision?.mode).toBe("full");
    expect(anyBackend.toolModeDecision?.source).toBe("model-parameters");
  });

  it("rewrites the system prompt of a LIVE conversation when the surface changes", async () => {
    // The prompt is written once, when the session opens. A live switch changes
    // the surface underneath an existing conversation, so leaving the old text
    // in history tells a model now holding the whole catalog that it "has
    // exactly six tools" - and the auto-selected surface goes unused.
    const backend = new OllamaBackend({
      model: "qwen3:4b",
      mcpServers: { comfyui: { transport: "stdio", command: "node", args: [], env: {} } },
    });
    const anyBackend = backend as unknown as {
      connectTools: () => Promise<void>;
      comfy: unknown;
      comfyTools: unknown[];
      comfySpecEnv: Record<string, string> | undefined;
      toolModeDecision: unknown;
      model: string;
    };
    anyBackend.connectTools = async () => {
      anyBackend.comfySpecEnv = {};
      anyBackend.comfy = fakeMcpClient();
      const { comfyuiSpawnToolMode } = await import("../../orchestrator/ollama-backend.js");
      anyBackend.toolModeDecision = comfyuiSpawnToolMode({}, {}, anyBackend.model);
      anyBackend.comfyTools = [];
    };
    await backend.prepare();
    await collect(backend, turnsOf({ text: "first" })); // opens the session on COMPACT
    const firstSystem = (chatRequests[0].messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "system",
    ) as { content: string };
    expect(firstSystem.content).toContain("exactly six tools");

    await backend.setModel("llama3.3:70b"); // same conversation, new surface
    await collect(backend, turnsOf({ text: "second" }));
    const laterSystem = (chatRequests.at(-1)!.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "system",
    ) as { content: string };
    expect(laterSystem.content).toContain("advertised to you DIRECTLY");
    expect(laterSystem.content).not.toContain("exactly six tools");
  });

  it("a FAILED respawn is retried on the next turn instead of being treated as done", async () => {
    let connects = 0;
    let failNext = false;
    const backend = new OllamaBackend({
      model: "qwen3:4b",
      mcpServers: { comfyui: { transport: "stdio", command: "node", args: [], env: {} } },
    });
    const anyBackend = backend as unknown as {
      connectTools: () => Promise<void>;
      comfy: unknown;
      comfyTools: unknown[];
      comfySpecEnv: Record<string, string> | undefined;
      toolModeDecision: { mode: string } | null;
      model: string;
    };
    anyBackend.connectTools = async () => {
      connects++;
      anyBackend.comfySpecEnv = {};
      if (failNext) {
        // connectTools SWALLOWS a connect failure. Simulate the WORST shape:
        // the mode was recorded but no client came up. "The surface is in the
        // right mode" must be judged on a LIVE client, not on the record alone,
        // or the missing surface is never rebuilt.
        anyBackend.comfy = null;
        const { comfyuiSpawnToolMode } = await import("../../orchestrator/ollama-backend.js");
        anyBackend.toolModeDecision = comfyuiSpawnToolMode({}, {}, anyBackend.model);
        return;
      }
      anyBackend.comfy = fakeMcpClient();
      const { comfyuiSpawnToolMode } = await import("../../orchestrator/ollama-backend.js");
      anyBackend.toolModeDecision = comfyuiSpawnToolMode({}, {}, anyBackend.model);
      anyBackend.comfyTools = [];
    };
    await backend.prepare();
    expect(connects).toBe(1);

    failNext = true;
    await backend.setModel("llama3.3:70b");
    await collect(backend, turnsOf({ text: "one" }));
    expect(connects).toBe(2);
    expect(anyBackend.comfy).toBeNull(); // the surface really is missing

    failNext = false;
    await collect(backend, turnsOf({ text: "two" }));
    expect(connects).toBe(3); // retried
    expect(anyBackend.toolModeDecision?.mode).toBe("full");
  });

  it("does NOT respawn when the new model wants the same surface", async () => {
    let connects = 0;
    const backend = new OllamaBackend({
      model: "qwen3:4b",
      mcpServers: { comfyui: { transport: "stdio", command: "node", args: [], env: {} } },
    });
    const anyBackend = backend as unknown as {
      connectTools: () => Promise<void>;
      comfy: unknown;
      comfyTools: unknown[];
      comfySpecEnv: Record<string, string> | undefined;
      toolModeDecision: { mode: string; model?: string } | null;
      model: string;
    };
    anyBackend.connectTools = async () => {
      connects++;
      anyBackend.comfySpecEnv = {};
      anyBackend.comfy = fakeMcpClient();
      const { comfyuiSpawnToolMode } = await import("../../orchestrator/ollama-backend.js");
      anyBackend.toolModeDecision = comfyuiSpawnToolMode({}, {}, anyBackend.model);
      anyBackend.comfyTools = [];
    };
    await backend.prepare();
    await backend.setModel("gemma4:e2b"); // also small → still compact
    await collect(backend, turnsOf({ text: "hi" }));
    expect(connects).toBe(1);
    // The explanation still catches up to the model actually in use.
    expect(anyBackend.toolModeDecision?.model).toBe("gemma4:e2b");
  });

  it("the post-switch rewrite KEEPS the panel-router retraction", async () => {
    // The rewrite replaces the whole system message. A rebuild that emitted only
    // the mode text would silently restore "you have panel_list_tools /
    // panel_describe_tool / panel_call_tool" in a session whose router never
    // registered — the false capability claim the retraction exists to remove,
    // reintroduced by the fix for a different problem.
    const backend = new OllamaBackend({
      model: "qwen3:4b",
      // NOTE: no panel entry — the router is NOT registered in this session.
      mcpServers: { comfyui: { transport: "stdio", command: "node", args: [], env: {} } },
    });
    const anyBackend = backend as unknown as {
      connectTools: () => Promise<void>;
      comfy: unknown;
      comfyTools: unknown[];
      comfySpecEnv: Record<string, string> | undefined;
      toolModeDecision: unknown;
      model: string;
    };
    anyBackend.connectTools = async () => {
      anyBackend.comfySpecEnv = {};
      anyBackend.comfy = fakeMcpClient();
      const { comfyuiSpawnToolMode } = await import("../../orchestrator/ollama-backend.js");
      anyBackend.toolModeDecision = comfyuiSpawnToolMode({}, {}, anyBackend.model);
      anyBackend.comfyTools = [];
    };
    await backend.prepare();
    await collect(backend, turnsOf({ text: "first" }));
    const firstSystem = (chatRequests[0].messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "system",
    ) as { content: string };
    expect(firstSystem.content).toContain("DO NOT EXIST right now");

    await backend.setModel("llama3.3:70b"); // respawns onto the full surface
    await collect(backend, turnsOf({ text: "second" }));
    const laterSystem = (chatRequests.at(-1)!.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "system",
    ) as { content: string };
    expect(laterSystem.content).toContain("advertised to you DIRECTLY"); // the new surface
    expect(laterSystem.content).toContain("DO NOT EXIST right now"); // …and the retraction survived
  });

  it("ADDS the retraction when the respawn loses a router the session had", async () => {
    // The reconcile tears the PANEL client down too. If the respawn fails to
    // bring it back, a session that opened WITH a working router is left holding
    // a prompt that still names panel_list_tools / panel_describe_tool /
    // panel_call_tool — and nothing else in the conversation retracts it. The
    // rewrite therefore has to happen on the failure branch as well, and it has
    // to re-derive the retraction from the router that is live NOW.
    let first = true;
    const backend = new OllamaBackend({
      model: "qwen3:4b",
      mcpServers: { comfyui: { transport: "stdio", command: "node", args: [], env: {} } },
    });
    const anyBackend = backend as unknown as {
      connectTools: () => Promise<void>;
      comfy: unknown;
      comfyTools: unknown[];
      panel: unknown;
      panelTools: unknown[];
      comfySpecEnv: Record<string, string> | undefined;
      toolModeDecision: unknown;
      model: string;
    };
    anyBackend.connectTools = async () => {
      anyBackend.comfySpecEnv = {};
      if (!first) throw new Error("spawn failed");
      first = false;
      anyBackend.comfy = fakeMcpClient();
      anyBackend.panel = fakeMcpClient();
      anyBackend.panelTools = [{ name: "panel_list_tools", inputSchema: { type: "object" } }];
      const { comfyuiSpawnToolMode } = await import("../../orchestrator/ollama-backend.js");
      anyBackend.toolModeDecision = comfyuiSpawnToolMode({}, {}, anyBackend.model);
      anyBackend.comfyTools = [];
    };
    await backend.prepare();
    await collect(backend, turnsOf({ text: "first" }));
    const firstSystem = (chatRequests[0].messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "system",
    ) as { content: string };
    // The router WAS there when the session opened — nothing to retract.
    expect(firstSystem.content).not.toContain("DO NOT EXIST right now");

    await backend.setModel("llama3.3:70b");
    await collect(backend, turnsOf({ text: "second" }));
    expect(anyBackend.panel).toBeNull(); // the respawn really did lose it
    const laterSystem = (chatRequests.at(-1)!.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "system",
    ) as { content: string };
    expect(laterSystem.content).toContain("DO NOT EXIST right now");
  });
});

describe("#790 — the capability probe is never memoised", () => {
  it("re-asks on every audio turn, because an ollama tag can be re-pulled", async () => {
    const backend = nativeBackend();
    showCapabilities = ["completion", "audio"];
    await collect(backend, turnsOf(AUDIO_TURN));
    const afterFirst = showCalls;
    expect(afterFirst).toBeGreaterThan(0);
    // The tag now points at different weights that can no longer hear.
    showCapabilities = ["completion", "tools"];
    const second = await collect(backend, turnsOf(AUDIO_TURN));
    expect(showCalls).toBeGreaterThan(afterFirst);
    expect(assistantText(second)).toContain("no audio");
    // The SECOND turn's user message (history carries the first one too).
    const users = (chatRequests[1].messages as Array<Record<string, unknown>>).filter((m) => m.role === "user");
    const user = users[users.length - 1] as { images?: string[] };
    expect(user.images).toBeUndefined();
  });
});

describe("#790 — more attachments than one turn carries", () => {
  it("REFUSES the excess out loud rather than truncating it away", async () => {
    const events = await collect(
      nativeBackend(),
      turnsOf({
        text: "listen",
        audio: [{ filename: "a.wav" }, { filename: "b.wav" }, { filename: "c.wav" }],
      }),
    );
    const said = assistantText(events);
    expect(said).toContain("c.wav");
    expect(said).toContain("follow-up message");
    const user = (chatRequests[0].messages as Array<Record<string, unknown>>).find((m) => m.role === "user") as {
      images?: string[];
    };
    expect(user.images).toHaveLength(2);
  });
});

describe("#790 — a turn with no audio is completely unaffected", () => {
  it("never probes and never mentions audio", async () => {
    const events = await collect(nativeBackend(), turnsOf({ text: "hello" }));
    // Exactly one /api/show: the once-per-model context-window read. A
    // capability probe would make it two.
    expect(showCalls).toBe(1);
    expect(assistantText(events)).not.toContain("audio");
  });
});
