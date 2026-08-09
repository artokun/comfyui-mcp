import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Force local mode and stub the underlying SDK Client so fetchApi is countable
// without a network. Mirrors object-info-cache.test.ts.
vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>(
    "../../config.js",
  );
  return {
    ...actual,
    isCloudMode: () => false,
    getComfyUIApiHost: () => "127.0.0.1:8188",
  };
});

const fetchApi = vi.fn();
vi.mock("@stable-canvas/comfyui-client", () => ({
  Client: class {
    // #385 — call sites moved to `comfyApiFetch`, which reuses the library's
    // own routing (apiURL/apiHeaders) and its injected `fetch`, so it can read a
    // 4xx instead of having `fetchApi` throw it away. The double routes `fetch`
    // back through its own `fetchApi`, so every existing impl and spy in this
    // file keeps working and keeps asserting the same route.
    apiURL(p: string) {
      return p;
    }
    apiHeaders(init?: { headers?: unknown }) {
      return (init && init.headers) || {};
    }
    async fetch(u: string, init?: unknown) {
      return (this as unknown as { fetchApi: (u: string, i?: unknown) => unknown }).fetchApi(u, init);
    }
    fetchApi = fetchApi;
    close() {}
  },
}));

const { getLogs } = await import("../../comfyui/client.js");

function logsResponse(text: string) {
  return { text: async () => text };
}

describe("getLogs reset-and-retry after restart (#399)", () => {
  beforeEach(() => {
    fetchApi.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("recovers a stale post-restart client by resetting and retrying once", async () => {
    // First call fails on the stale (torn-down) client — the bare "fetch failed"
    // #399 saw; the retry against a fresh client succeeds.
    fetchApi.mockRejectedValueOnce(new Error("fetch failed"));
    fetchApi.mockResolvedValueOnce(logsResponse("line one\nline two"));
    await expect(getLogs()).resolves.toEqual(["line one", "line two"]);
    expect(fetchApi).toHaveBeenCalledTimes(2);
  });

  it("surfaces the underlying error (not bare 'fetch failed') when the retry also fails", async () => {
    fetchApi.mockRejectedValueOnce(new Error("fetch failed"));
    fetchApi.mockRejectedValueOnce(new Error("ECONNREFUSED 127.0.0.1:8188"));
    await expect(getLogs()).rejects.toThrow("ECONNREFUSED 127.0.0.1:8188");
    expect(fetchApi).toHaveBeenCalledTimes(2);
  });

  it("parses a JSON-encoded log string on the happy path without retrying", async () => {
    fetchApi.mockResolvedValueOnce(logsResponse(JSON.stringify("a\nb\nc")));
    await expect(getLogs()).resolves.toEqual(["a", "b", "c"]);
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });
});
