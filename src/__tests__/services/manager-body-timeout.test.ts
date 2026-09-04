// #2773 — a Manager 2xx whose body stalls after headers used to escape as
// `TimeoutError: The operation was aborted due to timeout` with no URL and no
// method. comfyuiFetch's describeComfyTimeout rewrite cannot run: it has already
// returned. These tests drive SHIPPED managerFetch callers (listInstalledNodes,
// startManagerQueueForExternal) against a body that never finishes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => {
  const config = {
    comfyuiPath: "/fake/comfy",
    resolvedPort: 8188,
    comfyuiHost: "127.0.0.1",
    comfyuiSsl: false,
    githubToken: undefined as string | undefined,
  };
  return {
    config,
    getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
    getComfyuiTargetGeneration: () => 0,
    getComfyUIAuthHeaders: () => ({}),
    isLoopbackHost: (host?: string) => host === "127.0.0.1" || host === "localhost",
    isRemoteMode: () => false,
  };
});

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: "{}", stderr: "" })),
}));

const {
  NodeManagementError,
  listInstalledNodes,
  resetManagerApiCacheForTests,
  startManagerQueueForExternal,
} = await import("../../services/node-management.js");

const BASE = "http://127.0.0.1:8188";

/** Headers arrive; the body never enqueues and never closes. */
function stallingBody(status = 200): Response {
  return new Response(
    new ReadableStream({
      start() {
        /* deliberately never enqueues and never closes */
      },
    }),
    { status },
  );
}

describe("managerFetch body-read timeout (#2773)", () => {
  const previousTimeout = process.env.COMFYUI_MCP_HTTP_TIMEOUT_S;

  beforeEach(() => {
    process.env.COMFYUI_MCP_HTTP_TIMEOUT_S = "0.3";
    resetManagerApiCacheForTests("v2");
  });

  afterEach(() => {
    if (previousTimeout === undefined) delete process.env.COMFYUI_MCP_HTTP_TIMEOUT_S;
    else process.env.COMFYUI_MCP_HTTP_TIMEOUT_S = previousTimeout;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetManagerApiCacheForTests();
  });

  it("names a GET whose body never finishes, instead of a bare TimeoutError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string): Promise<Response> => {
        const path = new URL(url).pathname;
        if (path.startsWith("/v2/customnode/installed")) return stallingBody();
        return new Response("404: Not Found", { status: 404 });
      }),
    );

    const started = Date.now();
    const err = await listInstalledNodes().catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(5_000);

    expect(err).toBeInstanceOf(NodeManagementError);
    if (!(err instanceof NodeManagementError)) throw new Error("expected NodeManagementError");
    expect(err.name).not.toBe("TimeoutError");
    expect(err.message).toMatch(/No reply from ComfyUI within 0\.3s/);
    expect(err.message).toContain(`${BASE}/v2/customnode/installed?mode=default`);
    expect(err.message).toMatch(/\(GET\)/);
    expect(err.message).toMatch(/Headers had already arrived/);
    expect(err.message).toMatch(/body did not finish/);
    expect(err.message).toMatch(/Nothing was learned about the server/);
    expect(err.message).not.toMatch(/OUTCOME UNKNOWN/);
    expect(err.message).not.toMatch(/^The operation was aborted due to timeout$/);
    expect(err.details).toEqual(
      expect.objectContaining({
        kind: "manager-body-timeout",
        url: `${BASE}/v2/customnode/installed?mode=default`,
      }),
    );
    // A structured status would let dialect-mismatch retry re-enqueue. This
    // path has headers, not a 404/405, so it must carry none.
    expect(err.details).not.toHaveProperty("status");
  }, 20_000);

  it("calls a mutating body stall OUTCOME UNKNOWN", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const path = new URL(url).pathname;
        const method = init?.method ?? "GET";
        if (path === "/v2/manager/queue/start" && method === "POST") return stallingBody();
        return new Response("404: Not Found", { status: 404 });
      }),
    );

    const started = Date.now();
    const err = await startManagerQueueForExternal("v2").catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(5_000);

    expect(err).toBeInstanceOf(NodeManagementError);
    if (!(err instanceof NodeManagementError)) throw new Error("expected NodeManagementError");
    expect(err.message).toMatch(/No reply from ComfyUI within 0\.3s/);
    expect(err.message).toContain(`${BASE}/v2/manager/queue/start`);
    expect(err.message).toMatch(/\(POST\)/);
    expect(err.message).toMatch(/OUTCOME UNKNOWN/);
    expect(err.message).toMatch(/do NOT blindly re-issue/);
    expect(err.message).not.toMatch(/Nothing was learned about the server/);
    expect(err.details).toEqual(
      expect.objectContaining({
        kind: "manager-body-timeout",
        url: `${BASE}/v2/manager/queue/start`,
      }),
    );
  }, 20_000);

  it("keeps the transport-timeout rewrite when headers never arrive", async () => {
    // Passing a signal into comfyuiFetch would skip describeComfyTimeout
    // (init.signal !== undefined) and leave a bare abort in the wrapper.
    // Honour the signal the way undici does: the mock must reject when it fires,
    // or this would hang for the same reason a fetch double that ignores abort
    // hangs — which is not the production path under test.
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const fail = () => {
            reject(
              signal?.reason ??
                Object.assign(new Error("The operation was aborted due to timeout"), {
                  name: "TimeoutError",
                }),
            );
          };
          if (signal?.aborted) {
            fail();
            return;
          }
          signal?.addEventListener("abort", fail, { once: true });
        });
      }),
    );

    const started = Date.now();
    const err = await listInstalledNodes().catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(5_000);

    expect(err).toBeInstanceOf(NodeManagementError);
    if (!(err instanceof NodeManagementError)) throw new Error("expected NodeManagementError");
    expect(err.message).toMatch(/ComfyUI-Manager API unreachable/);
    expect(err.message).toMatch(/No reply from ComfyUI within 0\.3s/);
    expect(err.message).toMatch(/while requesting .*\/v2\/customnode\/installed/);
    expect(err.message).toMatch(/Whether a connection was ever established is NOT known/);
    expect(err.message).not.toMatch(/Headers had already arrived/);
    expect(err.details).not.toEqual(
      expect.objectContaining({ kind: "manager-body-timeout" }),
    );
  }, 20_000);
});
