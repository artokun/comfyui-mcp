import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { handleChatRequest, tools } from "../../experimental/chat-handler.js";

// ---------------------------------------------------------------------------
// Light test of the experimental chat handler with the model mocked.
// No provider keys, no network — MockLanguageModelV3 emits a canned stream.
// ---------------------------------------------------------------------------

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const helloModel = new MockLanguageModelV3({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Hello" },
        { type: "text-delta", id: "t1", delta: ", world!" },
        { type: "text-end", id: "t1" },
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
        },
      ],
      chunkDelayInMs: null,
      initialDelayInMs: null,
    }),
  }),
});

describe("handleChatRequest", () => {
  it("streams a UI message response using the (mocked) model", async () => {
    const req = makeRequest({
      messages: [
        { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ],
    });

    const res = await handleChatRequest(req, { model: helloModel });

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    // UI message stream protocol uses server-sent events.
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    // The streamed text deltas should be present in the SSE body.
    expect(text).toContain("Hello");
    expect(text).toContain("world!");
  });

  it("exposes a single server-side generate_image tool with an execute fn", async () => {
    expect(Object.keys(tools)).toEqual(["generate_image"]);
    const result = await tools.generate_image.execute!(
      { prompt: "a cat", width: 512, height: 512 },
      { toolCallId: "tc1", messages: [] },
    );
    expect(result).toMatchObject({
      status: "stubbed",
      prompt: "a cat",
      width: 512,
      height: 512,
    });
  });
});
