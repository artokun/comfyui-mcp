// #509 honesty + security: the boot-endpoint probe classifies healthy / down /
// unknown for DOWN→UP restart detection. It must NOT follow redirects (redirect:
// "manual", so no auth is sent onward and a login/SPA redirect can't certify), must
// verify the response origin, and must count ONLY a genuine CONNECTION-level failure
// (the port stopped serving — a restarting process) as "down". ANY HTTP response —
// including a 5xx — means the listener is UP, so it is "unknown", never a down; likewise
// our own request timeout (port listening but slow). So a transient 500 / slow blip can
// never fake a restart cycle (codex false-success fix).

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../comfyui/fetch.js", () => ({ comfyuiFetch: vi.fn() }));
import { comfyuiFetch } from "../../comfyui/fetch.js";
const { __panelToolsTestHooks } = await import("../../orchestrator/panel-tools.js");

const mockFetch = comfyuiFetch as unknown as ReturnType<typeof vi.fn>;
const health = __panelToolsTestHooks.probeComfyHealth;
const status = __panelToolsTestHooks.probeComfyEndpoint;
const BASE = "http://127.0.0.1:8188";

function resLike(over: Partial<{ status: number; url: string; body: unknown }>): unknown {
  return {
    status: over.status ?? 200,
    url: over.url ?? `${BASE}/system_stats`,
    json: async () => over.body ?? { system: { comfyui_version: "0.3" }, devices: [] },
  };
}

afterEach(() => mockFetch.mockReset());

describe("probeComfyHealth boolean wrapper", () => {
  it("uses redirect:\"manual\" and returns true only for a same-origin valid /system_stats", async () => {
    mockFetch.mockResolvedValueOnce(resLike({}));
    await expect(health(BASE, 1000)).resolves.toBe(true);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE}/system_stats`);
    expect((init as { redirect?: string }).redirect).toBe("manual"); // never follow a 30x
  });

  it("a null base never touches the network", async () => {
    await expect(health(null, 1000)).resolves.toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("probeComfyEndpoint status classification (DOWN only = genuine unreachability)", () => {
  it("same-origin valid 2xx → healthy", async () => {
    mockFetch.mockResolvedValueOnce(resLike({}));
    await expect(status(BASE, 1000)).resolves.toBe("healthy");
  });

  it("ECONNREFUSED (port refused — nothing listening) → down", async () => {
    // The ONLY sound listener-down signal for a loopback probe: the host refused because
    // nothing is listening on the port (a restarting process closed it). Cover both the
    // undici err.cause.code and a top-level err.code shape.
    mockFetch.mockRejectedValueOnce(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8188"), { code: "ECONNREFUSED" }),
      }),
    );
    await expect(status(BASE, 1000)).resolves.toBe("down");
    mockFetch.mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    await expect(status(BASE, 1000)).resolves.toBe("down");
  });

  it("AMBIGUOUS / non-listener-down connection failures → unknown, NOT down", async () => {
    // A still-LISTENING server can reset/hang up or transiently fail TLS (ECONNRESET/EPIPE/
    // EPROTO/ETIMEDOUT), and a network/DNS reachability failure (ENETUNREACH/EHOSTUNREACH/
    // ENETDOWN/EHOSTDOWN/ENOTFOUND/EAI_AGAIN) does NOT prove the process cycled — the
    // listener can still be up (codex High). None may be a "down" a later 200 turns into a
    // phantom cycle.
    for (const code of [
      "ECONNRESET", "EPIPE", "EPROTO", "ETIMEDOUT",
      "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EHOSTDOWN", "ENOTFOUND", "EAI_AGAIN",
    ]) {
      mockFetch.mockRejectedValueOnce(
        Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error(`socket ${code}`), { code }),
        }),
      );
      await expect(status(BASE, 1000)).resolves.toBe("unknown");
    }
    mockFetch.mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    await expect(status(BASE, 1000)).resolves.toBe("unknown");
  });

  it("5xx (server ANSWERED with an error — listener is UP) → unknown, NOT down", async () => {
    // A transient 500/502/503 is NOT proof the process cycled — the HTTP server responded.
    // Counting it as "down" would let a blip + a later 200 fake a restart (codex false-success).
    for (const code of [500, 502, 503, 504]) {
      mockFetch.mockResolvedValueOnce(resLike({ status: code }));
      await expect(status(BASE, 1000)).resolves.toBe("unknown");
    }
  });

  it("OUR request timeout (port listening but slow) → unknown, NOT down", async () => {
    // Model fetch aborting due to our AbortController: the connection was accepted (port
    // up) but slow — not a process-down. Must be "unknown" so a slow no-op can't certify.
    mockFetch.mockImplementationOnce((_url: string, init: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        });
      });
    });
    await expect(status(BASE, 20)).resolves.toBe("unknown");
  });

  it("3xx redirect (not followed) → unknown, NOT down", async () => {
    mockFetch.mockResolvedValueOnce(resLike({ status: 302 }));
    await expect(status(BASE, 1000)).resolves.toBe("unknown");
  });

  it("4xx (401/403/404/429 — up but not our stats) → unknown, NOT down", async () => {
    for (const code of [401, 403, 404, 429]) {
      mockFetch.mockResolvedValueOnce(resLike({ status: code }));
      await expect(status(BASE, 1000)).resolves.toBe("unknown");
    }
  });

  it("2xx from a WRONG origin (redirect escape) → unknown", async () => {
    mockFetch.mockResolvedValueOnce(
      resLike({ url: "https://attacker.example/system_stats", body: { system: {} } }),
    );
    await expect(status(BASE, 1000)).resolves.toBe("unknown");
  });

  it("2xx with a malformed body → unknown, NOT down", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      url: `${BASE}/system_stats`,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    });
    await expect(status(BASE, 1000)).resolves.toBe("unknown");
  });

  it("2xx same-origin but NOT a ComfyUI body → unknown", async () => {
    mockFetch.mockResolvedValueOnce(resLike({ body: { login: "please" } }));
    await expect(status(BASE, 1000)).resolves.toBe("unknown");
  });

  it("a null base never touches the network", async () => {
    await expect(status(null, 1000)).resolves.toBe("unknown");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
