import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  config: { comfyuiSsl: false, comfyuiPath: "", comfyuiBasePath: "/comfyapi" },
  getComfyUIApiHost: () => "127.0.0.1:8000",
  getComfyUIBasePath: () => "/comfyapi",
  getComfyUIBaseUrl: () => "http://127.0.0.1:8000/comfyapi",
  getComfyUIAuthHeaders: () => ({ Authorization: "Bearer headless-token" }),
  isCloudMode: () => false,
  isRemoteMode: () => true,
}));

import { fetchImage, MAX_VIEW_RESPONSE_BYTES, resetClient } from "../../comfyui/client.js";
import { setConnectedPanelOrigins } from "../../comfyui/fetch.js";

const HEADLESS = "http://127.0.0.1:8000";
const PANEL = "http://localhost:8188";

function transportFailure(): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
  });
}

function imageResponse(status = 200): Response {
  return new Response(Uint8Array.from([1, 2, 3]), {
    status,
    headers: { "content-type": "image/jpeg" },
  });
}

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };

let calls: FetchCall[];

beforeEach(() => {
  calls = [];
  resetClient();
  setConnectedPanelOrigins(() => []);
});

afterEach(() => {
  setConnectedPanelOrigins(null);
  vi.unstubAllGlobals();
});

describe("fetchImage connected-panel fallback (#2149)", () => {
  it("retries an unreachable headless target at the one different panel origin", async () => {
    setConnectedPanelOrigins(() => [PANEL]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        const url = String(input);
        if (url.startsWith(HEADLESS)) throw transportFailure();
        return imageResponse();
      }),
    );

    await expect(fetchImage("render.png", "output", "shots")).resolves.toEqual({
      base64: "AQID",
      mimeType: "image/jpeg",
    });
    expect(calls).toHaveLength(2);
    expect(String(calls[0].input)).toContain(`${HEADLESS}/comfyapi/view?`);
    expect(String(calls[1].input)).toContain(`${PANEL}/comfyapi/view?`);
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe("Bearer headless-token");
    expect(calls[1].init?.headers).toBeUndefined();
  });

  it("does not guess when multiple different panel origins are connected", async () => {
    setConnectedPanelOrigins(() => ["http://127.0.0.1:8188", "http://localhost:8189"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push({ input });
        throw transportFailure();
      }),
    );

    const err = await fetchImage("render.png").catch((error: unknown) => error as Error);
    expect(err.message).toContain("I did NOT retry against a connected panel");
    expect(err.message).toContain("127.0.0.1:8188");
    expect(err.message).toContain("localhost:8189");
    expect(calls).toHaveLength(1);
  });

  it("does not retry a loopback alias of the failed target", async () => {
    setConnectedPanelOrigins(() => ["http://localhost:8000"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push({ input });
        throw transportFailure();
      }),
    );

    await expect(fetchImage("render.png")).rejects.toThrow(/fetch failed/);
    expect(calls).toHaveLength(1);
  });

  it("keeps a panel response's HTTP error classified as an image error", async () => {
    setConnectedPanelOrigins(() => [PANEL]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push({ input });
        if (calls.length === 1) throw transportFailure();
        return imageResponse(404);
      }),
    );

    const err = await fetchImage("missing.png").catch(
      (error: unknown) => error as { code?: string; message: string },
    );
    expect(err.code).toBe("IMAGE_NOT_FOUND");
    expect(err.message).toContain(`at ${PANEL}`);
    expect(calls).toHaveLength(2);
  });

  it("does not retry a timeout as if it were a dead target", async () => {
    setConnectedPanelOrigins(() => [PANEL]);
    const timeout = new Error("request timed out");
    timeout.name = "TimeoutError";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push({ input });
        throw timeout;
      }),
    );

    await expect(fetchImage("render.png")).rejects.toThrow(/No reply from ComfyUI within 120s/);
    expect(calls).toHaveLength(1);
  });

  it.each([
    "http://evil.example:8188",
    "ws://localhost:8188",
    "http://localhost:8188/comfyapi",
    "http://localhost:8188?token=leak",
    "http://user:pass@localhost:8188",
  ])("rejects unsafe panel origin %s without contacting it", async (unsafeOrigin) => {
    setConnectedPanelOrigins(() => [PANEL, unsafeOrigin]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push({ input });
        throw transportFailure();
      }),
    );

    await expect(fetchImage("render.png")).rejects.toThrow(/malformed, unsupported, remote, or otherwise unsafe/);
    expect(calls).toHaveLength(1);
  });

  it("does not follow a cross-origin redirect from the panel", async () => {
    setConnectedPanelOrigins(() => [PANEL]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        if (calls.length === 1) throw transportFailure();
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/collect" },
        });
      }),
    );

    await expect(fetchImage("render.png")).rejects.toMatchObject({ code: "VIEW_REDIRECT_UNSAFE" });
    expect(calls).toHaveLength(2);
    expect(calls[1].init?.redirect).toBe("manual");
    expect(calls[1].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses manual redirects for the configured target too", async () => {
    setConnectedPanelOrigins(() => [PANEL]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/collect" },
        });
      }),
    );

    await expect(fetchImage("render.png")).rejects.toMatchObject({ code: "VIEW_REDIRECT_UNSAFE" });
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.redirect).toBe("manual");
  });

  it("refuses a response whose final URL is a different origin", async () => {
    setConnectedPanelOrigins(() => [PANEL]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push({ input });
        if (calls.length === 1) throw transportFailure();
        const response = imageResponse();
        Object.defineProperty(response, "url", { value: "http://evil.example:8188/view" });
        return response;
      }),
    );

    await expect(fetchImage("render.png")).rejects.toMatchObject({ code: "VIEW_RESPONSE_ORIGIN" });
    expect(calls).toHaveLength(2);
  });

  it("refuses an oversized streamed response before buffering it", async () => {
    setConnectedPanelOrigins(() => [PANEL]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push({ input });
        if (calls.length === 1) throw transportFailure();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_VIEW_RESPONSE_BYTES + 1));
            controller.close();
          },
        });
        return new Response(body, { headers: { "content-type": "image/png" } });
      }),
    );

    await expect(fetchImage("huge.png")).rejects.toMatchObject({ code: "VIEW_TOO_LARGE" });
    expect(calls).toHaveLength(2);
  });
});
