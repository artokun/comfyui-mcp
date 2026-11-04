// #3002 — get_image on a VHS .mp4 "hung" and, once the HTTP ceiling fired, died
// with the bare "The operation was aborted due to timeout". comfyuiFetch arms
// its AbortSignal.timeout BEFORE the request goes out, so on a stalled /view
// body it always expires ahead of the bounded reader's own timer, and the body
// stream rejects with that DOMException instead of the structured
// VIEW_READ_TIMEOUT the reader was written to produce. The caller then had no
// filename, no endpoint and no remedy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../config.js", () => ({
  config: { comfyuiSsl: false, comfyuiPath: "", comfyuiBasePath: "" },
  getComfyUIApiHost: () => "127.0.0.1:8000",
  getComfyUIBasePath: () => "",
  getComfyUIBaseUrl: () => "http://127.0.0.1:8000",
  getComfyUIAuthHeaders: () => ({}),
  isCloudMode: () => false,
  isRemoteMode: () => true,
}));

import { fetchImage, resetClient } from "../../comfyui/client.js";
import { setConnectedPanelFallbackOrigins } from "../../comfyui/fetch.js";
import { ComfyUIError } from "../../utils/errors.js";

/** A 200 whose body delivers one chunk and then dies the way undici's does when the fetch signal expires. */
function stalledVideoResponse(reason: Error): Response {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (controller.desiredSize !== null && (controller as { pulled?: boolean }).pulled) {
        controller.error(reason);
        return;
      }
      (controller as { pulled?: boolean }).pulled = true;
      controller.enqueue(Uint8Array.from([0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70]));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "video/mp4" } });
}

beforeEach(() => {
  resetClient();
  setConnectedPanelFallbackOrigins(() => []);
});

afterEach(() => {
  setConnectedPanelFallbackOrigins(null);
  vi.unstubAllGlobals();
});

describe("fetchImage — body read cut short by the fetch ceiling (#3002)", () => {
  it("reports a TimeoutError from the body stream as VIEW_READ_TIMEOUT naming the file", async () => {
    const reason = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    vi.stubGlobal("fetch", vi.fn(async () => stalledVideoResponse(reason)));

    const err = await fetchImage("face_00005-audio.mp4", "output", "").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComfyUIError);
    const comfyErr = err as ComfyUIError;
    expect(comfyErr.code).toBe("VIEW_READ_TIMEOUT");
    expect(comfyErr.message).toContain('"face_00005-audio.mp4"');
    expect(comfyErr.message).toMatch(/did not finish sending/);
    expect(comfyErr.message).toContain("COMFYUI_MCP_HTTP_TIMEOUT_S");
    expect(comfyErr.message).not.toBe("The operation was aborted due to timeout");
  });

  it("still lets a non-timeout stream failure through unchanged", async () => {
    const reason = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    vi.stubGlobal("fetch", vi.fn(async () => stalledVideoResponse(reason)));

    const err = await fetchImage("face_00005-audio.mp4", "output", "").catch((e: unknown) => e);
    expect(err).toBe(reason);
  });
});
