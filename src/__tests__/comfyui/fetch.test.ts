import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the config layer so we can drive getComfyUIAuthHeaders per test.
const authHeaders = vi.fn<() => Record<string, string>>();
vi.mock("../../config.js", () => ({
  getComfyUIAuthHeaders: () => authHeaders(),
}));

import { comfyuiFetch } from "../../comfyui/fetch.js";

function undiciFailure(code: string): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error(`connect ${code}`), { code }),
  });
}

describe("comfyuiFetch", () => {
  const fetchMock = vi.fn(async () => new Response("ok"));

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
    authHeaders.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Passthrough for everything the caller supplied — plus a timeout ceiling the
  // caller did not. A call with no signal previously had NO limit at all and
  // could hang forever against a host that accepts the connection and never
  // answers; `init.signal` still always wins (see fetch-failure-diagnostics).
  it("passes the caller's init through when no auth is configured", async () => {
    authHeaders.mockReturnValue({});
    await comfyuiFetch("http://comfy/prompt", { method: "POST" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://comfy/prompt");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("injects the configured auth header", async () => {
    authHeaders.mockReturnValue({ Authorization: "Bearer abc" });
    await comfyuiFetch("http://comfy/system_stats");
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers((init as RequestInit).headers).get("Authorization")).toBe("Bearer abc");
  });

  it("preserves caller headers (e.g. Content-Type) alongside auth", async () => {
    authHeaders.mockReturnValue({ "X-API-Key": "k" });
    await comfyuiFetch("http://comfy/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-API-Key")).toBe("k");
  });

  it("does not clobber an explicit auth header set by the caller", async () => {
    authHeaders.mockReturnValue({ Authorization: "Bearer fromconfig" });
    await comfyuiFetch("http://comfy/prompt", {
      headers: { Authorization: "Bearer explicit" },
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers((init as RequestInit).headers).get("Authorization")).toBe("Bearer explicit");
  });

  it("retries a manual redirect request through localhost after a bare IPv4 refusal", async () => {
    authHeaders.mockReturnValue({});
    const response = new Response("ok");
    fetchMock.mockRejectedValueOnce(undiciFailure("ECONNREFUSED")).mockResolvedValueOnce(response);

    await expect(
      comfyuiFetch("http://127.0.0.1:8188/view?filename=out.png", { redirect: "manual" }),
    ).resolves.toBe(response);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = fetchMock.mock.calls[0];
    const [retryUrl, retryInit] = fetchMock.mock.calls[1];
    expect(firstUrl).toBe("http://127.0.0.1:8188/view?filename=out.png");
    expect(retryUrl).toBe("http://localhost:8188/view?filename=out.png");
    expect((firstInit as RequestInit).redirect).toBe("manual");
    expect((retryInit as RequestInit).redirect).toBe("manual");
    expect((retryInit as RequestInit).signal).toBe((firstInit as RequestInit).signal);
  });

  it("replays a Request body only after the literal target is refused", async () => {
    authHeaders.mockReturnValue({});
    const response = new Response("ok");
    fetchMock.mockRejectedValueOnce(undiciFailure("ECONNREFUSED")).mockResolvedValueOnce(response);
    const input = new Request("http://127.0.0.1:8188/prompt", {
      method: "POST",
      body: JSON.stringify({ prompt: "p" }),
      headers: { "Content-Type": "application/json" },
    });

    await expect(comfyuiFetch(input)).resolves.toBe(response);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0]?.[0] as Request;
    const retry = fetchMock.mock.calls[1]?.[0] as Request;
    expect(first.url).toBe("http://127.0.0.1:8188/prompt");
    expect(retry.url).toBe("http://localhost:8188/prompt");
    await expect(retry.text()).resolves.toBe(JSON.stringify({ prompt: "p" }));
  });

  it.each([
    ["localhost", "http://localhost:8188/view", undiciFailure("ECONNREFUSED")],
    ["a different loopback address", "http://127.0.0.2:8188/view", undiciFailure("ECONNREFUSED")],
    ["a remote target", "https://comfy.example/view", undiciFailure("ECONNREFUSED")],
    ["a non-refused transport error", "http://127.0.0.1:8188/view", undiciFailure("ECONNRESET")],
    ["a non-bare fetch error", "http://127.0.0.1:8188/view", new Error("fetch failed after sending")],
  ])("does not retry %s when the manual request is outside the narrow gate", async (_label, target, failure) => {
    authHeaders.mockReturnValue({});
    fetchMock.mockRejectedValueOnce(failure);

    await comfyuiFetch(target, { redirect: "manual" }).catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
