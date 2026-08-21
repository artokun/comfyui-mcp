// #1905 — upload_image (action:"video") received HTTP 413 with ComfyUI/aiohttp's
// plain-text size-limit sentence and classified it as NON_JSON_RESPONSE, then
// recommended checking the configured ComfyUI base URL. Connectivity was fine
// (/system_stats JSON). The cause was request size.
//
// These tests drive the SHIPPED upload helper (`uploadImageHttp`) through the
// real client wiring. Mocking classifyNonJson would let a 413 still become
// NON_JSON_RESPONSE plus the SPA-catch-all remedy.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  config: { comfyuiSsl: false, comfyuiPath: "", comfyuiBasePath: "" },
  getComfyUIApiHost: () => "remote.example:8188",
  getComfyUIBasePath: () => "",
  getComfyUIBaseUrl: () => "http://remote.example:8188",
  getComfyUIAuthHeaders: () => ({}),
  isCloudMode: () => false,
  isRemoteMode: () => true,
}));

import { resetClient, uploadImageHttp } from "../../comfyui/client.js";
import { isNonJsonResponseError, resetComfyApiRootValidated } from "../../comfyui/json-guard.js";

/** The exact sentence ComfyUI/aiohttp wrote in the reported 413. */
const COMFY_SIZE_LIMIT_BODY =
  "Maximum request body size 104857600 exceeded, actual body size 104923136";

function answer(status: number, body: string, contentType: string, statusText?: string): void {
  global.fetch = vi.fn(async () => {
    return new Response(body, {
      status,
      statusText: statusText ?? "",
      headers: { "content-type": contentType },
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetClient();
  resetComfyApiRootValidated();
});

describe("uploadImageHttp names HTTP 413 as a size limit, not a bad base URL (#1905)", () => {
  it("returns UPLOAD_TOO_LARGE for ComfyUI's plain-text size-limit sentence", async () => {
    answer(413, COMFY_SIZE_LIMIT_BODY, "text/plain", "Content Too Large");

    const err = await uploadImageHttp("clip.mp4", Buffer.from("x"), "video/mp4").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(isNonJsonResponseError(err)).toBe(false);
    expect((err as { code?: string }).code).toBe("UPLOAD_TOO_LARGE");

    const message = (err as Error).message;
    expect(message).toContain("/upload/image");
    expect(message).toContain("413");
    // Names the configured/observed limits from the body, not a guessed ceiling.
    expect(message).toContain("104857600");
    expect(message).toContain("104923136");
    expect(message).toMatch(/trim or compress/i);
    expect(message).toMatch(/FFmpeg/);
    // The misdiagnosis the reporter got.
    expect(message).not.toContain("NON_JSON_RESPONSE");
    expect(message).not.toContain("Confirm the configured ComfyUI base URL");
    expect(message).not.toContain("really is a ComfyUI API root");
    expect(message).not.toContain("the same catch-all that produced this page");
    expect((err as { details?: { limitBytes?: number; actualBytes?: number } }).details).toMatchObject({
      status: 413,
      limitBytes: 104857600,
      actualBytes: 104923136,
    });
  });

  it("still treats a 413 without the aiohttp sentence as a size limit", async () => {
    answer(413, "too large", "text/plain");

    const err = await uploadImageHttp("big.png", Buffer.from("x")).then(
      () => null,
      (e: unknown) => e,
    );

    expect((err as { code?: string }).code).toBe("UPLOAD_TOO_LARGE");
    const message = (err as Error).message;
    expect(message).toMatch(/trim or compress/i);
    expect(message).not.toContain("Confirm the configured ComfyUI base URL");
    expect(message).not.toContain("really is a ComfyUI API root");
  });

  it("does not recast a 401 sign-in gate as a size limit (#1160 must not regress)", async () => {
    answer(
      401,
      '<!DOCTYPE html><html><head><title>Sign in</title></head><body><form action="/login"><input type="password" name="p"></form></body></html>',
      "text/html",
      "Unauthorized",
    );

    const err = await uploadImageHttp("cat.png", Buffer.from("x")).then(
      () => null,
      (e: unknown) => e,
    );

    expect(isNonJsonResponseError(err)).toBe(true);
    expect((err as { code?: string }).code).toBe("NON_JSON_RESPONSE");
    expect((err as Error).message).toMatch(/SIGN-IN PAGE/);
  });

  it("still succeeds on a normal 2xx JSON response", async () => {
    answer(
      200,
      JSON.stringify({ name: "clip.mp4", subfolder: "", type: "input" }),
      "application/json",
    );
    await expect(uploadImageHttp("clip.mp4", Buffer.from("x"), "video/mp4")).resolves.toEqual({
      name: "clip.mp4",
      subfolder: "",
      type: "input",
    });
  });
});
