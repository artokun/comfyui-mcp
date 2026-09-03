// #2801 — concurrent upload_image (action:"stage") POSTs can EPIPE and leave
// the caller unable to tell whether /upload/image committed.
//
// Five overlapping POSTs to one ComfyUI target used to share a socket; one
// write EPIPE then surfaced as outcome-unknown, and a retry was unsafe because
// staging is not idempotent. The shipped helper is `uploadImageHttp` (stage
// re-registers via the same POST). These tests fail if uploads overlap again,
// or if a transport EPIPE is returned while /view can still prove committed
// vs absent.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFetch, jsonResponse } from "../helpers/fake-fetch.js";

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
import { resetComfyApiRootValidated } from "../../comfyui/json-guard.js";

function undiciFailure(code: string, detail: string): Error {
  const cause = new Error(detail);
  (cause as { code?: string }).code = code;
  return new TypeError("fetch failed", { cause });
}

function isUploadPost(url: string, init?: RequestInit): boolean {
  return url.includes("/upload/image") && String(init?.method ?? "GET").toUpperCase() === "POST";
}

function isViewGet(url: string, init?: RequestInit): boolean {
  return url.includes("/view") && String(init?.method ?? "GET").toUpperCase() !== "POST";
}

beforeEach(() => {
  vi.clearAllMocks();
  resetClient();
  resetComfyApiRootValidated();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("uploadImageHttp serializes POSTs to one ComfyUI target (#2801)", () => {
  it("runs concurrent uploads one at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    global.fetch = fakeFetch(async (url, init) => {
      if (!isUploadPost(url, init)) throw new Error(`unexpected ${url}`);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return jsonResponse({ name: "frame.png", subfolder: "", type: "input" });
    });

    const bytes = Buffer.from("png-bytes");
    await Promise.all([
      uploadImageHttp("a.png", bytes),
      uploadImageHttp("b.png", bytes),
      uploadImageHttp("c.png", bytes),
      uploadImageHttp("d.png", bytes),
      uploadImageHttp("e.png", bytes),
    ]);

    expect(maxInFlight).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(5);
  });
});

describe("uploadImageHttp settles a transport EPIPE against /view (#2801)", () => {
  it("returns committed when /view serves the uploaded bytes after write EPIPE", async () => {
    const payload = Buffer.from("staged-png-bytes");
    let posts = 0;
    global.fetch = fakeFetch(async (url, init) => {
      if (isUploadPost(url, init)) {
        posts += 1;
        throw undiciFailure("EPIPE", "write EPIPE");
      }
      if (isViewGet(url, init)) {
        expect(url).toMatch(/filename=cat\.png/);
        expect(url).toMatch(/type=input/);
        return new Response(payload, {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    await expect(uploadImageHttp("cat.png", payload)).resolves.toEqual({
      name: "cat.png",
      subfolder: "",
      type: "input",
    });
    expect(posts).toBe(1);
  });

  it("retries once when /view 404 proves the POST did not land", async () => {
    const payload = Buffer.from("retry-bytes");
    let posts = 0;
    global.fetch = fakeFetch(async (url, init) => {
      if (isUploadPost(url, init)) {
        posts += 1;
        if (posts === 1) throw undiciFailure("EPIPE", "write EPIPE");
        return jsonResponse({ name: "cat.png", subfolder: "", type: "input" });
      }
      if (isViewGet(url, init)) {
        return new Response("not found", { status: 404, statusText: "Not Found" });
      }
      throw new Error(`unexpected ${url}`);
    });

    await expect(uploadImageHttp("cat.png", payload)).resolves.toEqual({
      name: "cat.png",
      subfolder: "",
      type: "input",
    });
    expect(posts).toBe(2);
  });

  it("keeps outcome unknown when /view also fails to answer", async () => {
    const payload = Buffer.from("unknown-bytes");
    global.fetch = fakeFetch(async (url, init) => {
      if (isUploadPost(url, init) || isViewGet(url, init)) {
        throw undiciFailure("EPIPE", "write EPIPE");
      }
      throw new Error(`unexpected ${url}`);
    });

    const err = await uploadImageHttp("cat.png", payload).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/fetch failed/);
    expect(message).toMatch(/EPIPE/);
    expect(message).toMatch(/upload\/image/);
    expect(message).toMatch(/may already have been received and acted on/i);
  });

  it("does not probe /view for a never-delivered refusal", async () => {
    global.fetch = fakeFetch(async (url, init) => {
      if (isUploadPost(url, init)) {
        throw undiciFailure("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:8188");
      }
      throw new Error(`unexpected probe ${url}`);
    });

    const err = await uploadImageHttp("cat.png", Buffer.from("x")).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/ECONNREFUSED/);
    expect((err as Error).message).not.toMatch(/may already have been received/i);
  });
});
