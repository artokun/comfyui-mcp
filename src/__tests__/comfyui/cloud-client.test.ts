import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFetch } from "../helpers/fake-fetch.js";

// Stub config helpers BEFORE importing the module under test.
vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>(
    "../../config.js",
  );
  return {
    ...actual,
    getCloudUrl: () => "https://cloud.example.test",
    getApiKey: () => "test-api-key",
    isCloudMode: () => true,
  };
});

const {
  enqueuePrompt,
  fetchImage,
  getCheckpoints,
  getHistory,
  getJobStatus,
  getQueue,
  getSamplers,
  getSchedulers,
  interrupt,
  uploadImageHttp,
} = await import("../../comfyui/cloud-client.js");

describe("cloud-client", () => {
  const originalFetch = global.fetch;
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    calls = [];
    global.fetch = fakeFetch(async (url, init) => {
      calls.push({ url, init });
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("authenticates every request with X-API-Key", async () => {
    await enqueuePrompt({ "1": { class_type: "Node", inputs: {} } } as never);
    expect(calls[0]?.url).toBe("https://cloud.example.test/api/prompt");
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("test-api-key");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("POSTs enqueue with extra_data when supplied", async () => {
    await enqueuePrompt(
      { "1": { class_type: "Node", inputs: {} } } as never,
      { api_key_comfy_org: "x" },
    );
    const body = JSON.parse((calls[0]?.init?.body as string) ?? "{}");
    expect(body.prompt).toBeDefined();
    expect(body.extra_data).toEqual({ api_key_comfy_org: "x" });
  });

  it("returns empty history (no global endpoint) when no prompt_id", async () => {
    const result = await getHistory();
    expect(result).toEqual({});
    expect(calls).toHaveLength(0); // no network call
  });

  it("wraps an unwrapped cloud history response in the expected shape", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ outputs: { "9": { images: [] } } }), {
        status: 200,
      }),
    );
    const result = await getHistory("abc-123");
    expect(result["abc-123"]).toBeDefined();
    expect(result["abc-123"]).toMatchObject({ outputs: { "9": { images: [] } } });
  });

  it("returns a placeholder QueueStatus (cloud has no queue endpoint)", async () => {
    const q = await getQueue();
    expect(q).toEqual({ queue_running: [], queue_pending: [] });
  });

  it("returns hardcoded sampler/scheduler lists", async () => {
    const samplers = await getSamplers();
    const schedulers = await getSchedulers();
    expect(samplers).toContain("euler");
    expect(samplers).toContain("dpmpp_2m");
    expect(schedulers).toContain("karras");
  });

  it("throws CLOUD_UNSUPPORTED when listing local model categories", async () => {
    await expect(getCheckpoints()).rejects.toMatchObject({
      code: "CLOUD_UNSUPPORTED",
    });
  });

  it("requires a prompt_id to interrupt and POSTs to /api/job/<id>/cancel", async () => {
    await expect(interrupt()).rejects.toMatchObject({ code: "CLOUD_UNSUPPORTED" });
    await interrupt("abc-123");
    expect(calls.at(-1)?.url).toBe(
      "https://cloud.example.test/api/job/abc-123/cancel",
    );
    expect(calls.at(-1)?.init?.method).toBe("POST");
  });

  it("reads job status from /api/job/<id>/status", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ status: "in_progress", prompt_id: "x" }), {
        status: 200,
      }),
    );
    const s = await getJobStatus("x");
    expect(s.status).toBe("in_progress");
  });

  it("fetches output images as base64 via /api/view", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    global.fetch = vi.fn(async () =>
      new Response(bytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    const r = await fetchImage("out.png");
    expect(r.mimeType).toBe("image/png");
    expect(r.base64).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("wraps non-2xx responses in a ComfyUIError with status code", async () => {
    global.fetch = vi.fn(async () =>
      new Response("forbidden", { status: 403, statusText: "Forbidden" }),
    );
    await expect(getHistory("abc")).rejects.toMatchObject({
      code: "CLOUD_API_ERROR",
    });
  });

  // #946 — the twin split: a path in `filename` is a subfolder request, sent
  // as the form field the API has. The self-hosted client got this fix first;
  // this twin kept the original defect (the whole path as the multipart
  // filename) until the split was shared.
  it("uploadImageHttp splits a path filename into the subfolder form field", async () => {
    await uploadImageHttp("assets/clip.mp4", Buffer.from("x"), "video/mp4");
    const form = calls.at(-1)?.init?.body as FormData;
    expect(form.get("subfolder")).toBe("assets");
    expect((form.get("image") as File).name).toBe("clip.mp4");
  });

  it("uploadImageHttp sends NO subfolder field for a plain filename", async () => {
    await uploadImageHttp("clip.mp4", Buffer.from("x"), "video/mp4");
    const form = calls.at(-1)?.init?.body as FormData;
    expect(form.has("subfolder")).toBe(false);
    expect((form.get("image") as File).name).toBe("clip.mp4");
  });

  it("uploadImageHttp refuses a traversal before anything is sent", async () => {
    await expect(uploadImageHttp("../escape.png", Buffer.from("x"))).rejects.toThrow(
      /walks outside/,
    );
    expect(calls).toHaveLength(0);
  });
});
