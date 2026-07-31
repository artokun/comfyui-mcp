import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #296: an embedded LOCAL sidebar session with no CLI-configured workspace
// (COMFYUI_PATH unset, auto-detect empty) used to spawn path-less because the
// orchestrator never consumed the panel's `/comfyui_mcp_panel/status` route,
// which exposes the ComfyUI install `base_path` (panel commit f45054e). These
// tests cover the new orchestrator-side consumer that recovers that base_path.
//
// Fail-before: `fetchPanelBasePath` did not exist on main (the route had zero
// consumers), so importing/calling it failed. Pass-after: it GETs the status
// route and returns the `base_path`, degrading to undefined on any failure so it
// can only ADD a path, never break session start.

const OLD_ENV = process.env;

function statusCall(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.find(([u]) =>
    String(u).includes("/comfyui_mcp_panel/status"),
  );
}

describe("fetchPanelBasePath (#296)", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...OLD_ENV };
    // Pin the target so config.ts's import-time port probe never runs (and can't
    // pollute the fetch mock).
    process.env.COMFYUI_URL = "http://127.0.0.1:8188";
    process.env.COMFYUI_AUTH_TOKEN = "";
    process.env.COMFYUI_AUTH_HEADER = "";
    process.env.COMFYUI_AUTH_SCHEME = "";
    process.env.CF_ACCESS_CLIENT_ID = "";
    process.env.CF_ACCESS_CLIENT_SECRET = "";
  });

  afterEach(() => {
    process.env = OLD_ENV;
    vi.unstubAllGlobals();
  });

  it("GETs the panel status route and returns its base_path", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ base_path: "C:/Users/me/ComfyUI" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchPanelBasePath } = await import("../../services/secure-bridge.js");
    const out = await fetchPanelBasePath("http://127.0.0.1:8188");

    expect(out).toBe("C:/Users/me/ComfyUI");
    const call = statusCall(fetchMock);
    expect(call, "status GET should have been made").toBeTruthy();
    // A GET (no explicit method / no POST body), not a mutation.
    const init = (call as [string, RequestInit | undefined])[1];
    expect(init?.method ?? "GET").toBe("GET");
  });

  it("trims surrounding whitespace on the returned base_path", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ base_path: "  /home/me/ComfyUI  " }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchPanelBasePath } = await import("../../services/secure-bridge.js");
    expect(await fetchPanelBasePath("http://127.0.0.1:8188")).toBe("/home/me/ComfyUI");
  });

  it("tolerates a camelCase basePath alias", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ basePath: "/opt/ComfyUI" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchPanelBasePath } = await import("../../services/secure-bridge.js");
    expect(await fetchPanelBasePath("http://127.0.0.1:8188")).toBe("/opt/ComfyUI");
  });

  it("carries the ComfyUI auth headers so a token-gated panel answers", async () => {
    process.env.COMFYUI_AUTH_TOKEN = "abc123";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ base_path: "/x" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchPanelBasePath } = await import("../../services/secure-bridge.js");
    await fetchPanelBasePath("http://127.0.0.1:8188");

    const init = (statusCall(fetchMock) as [string, RequestInit])[1];
    expect(init.headers).toMatchObject({ Authorization: "Bearer abc123" });
  });

  it("returns undefined on a non-2xx status (no consumer error)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchPanelBasePath } = await import("../../services/secure-bridge.js");
    expect(await fetchPanelBasePath("http://127.0.0.1:8188")).toBeUndefined();
  });

  it("returns undefined when base_path is missing / blank", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ base_path: "   " }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchPanelBasePath } = await import("../../services/secure-bridge.js");
    expect(await fetchPanelBasePath("http://127.0.0.1:8188")).toBeUndefined();
  });

  it("never throws when the route is unreachable — degrades to undefined", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchPanelBasePath } = await import("../../services/secure-bridge.js");
    let out: string | undefined = "unset";
    await expect(
      (async () => {
        out = await fetchPanelBasePath("http://127.0.0.1:8188");
      })(),
    ).resolves.toBeUndefined();
    expect(out).toBeUndefined();
  });

  it("returns undefined for a non-JSON body without throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchPanelBasePath } = await import("../../services/secure-bridge.js");
    expect(await fetchPanelBasePath("http://127.0.0.1:8188")).toBeUndefined();
  });
});

// The adoption DECISION (which the orchestrator threads into every spawn env at
// startup AND on a panel-`hello` retarget). This is the exact logic that decides
// whether an embedded local session gets a LOCAL ComfyUI base — including the
// retarget case where the previous version silently stayed path-less.
describe("resolveComfyuiPathForTarget (#296 adoption decision)", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...OLD_ENV };
    process.env.COMFYUI_URL = "http://127.0.0.1:8188";
  });
  afterEach(() => {
    process.env = OLD_ENV;
    vi.unstubAllGlobals();
  });

  const LOOPBACK = "http://127.0.0.1:8188";

  it("prefers a configured/auto-detected local path without fetching the panel", async () => {
    const fetchBasePath = vi.fn(async () => "/should/not/be/used");
    const { resolveComfyuiPathForTarget } = await import("../../services/secure-bridge.js");
    const out = await resolveComfyuiPathForTarget({
      target: LOOPBACK,
      localPath: "/home/me/ComfyUI",
      forceRemote: false,
      isLoopback: true,
      fetchBasePath,
      exists: () => true,
    });
    expect(out).toBe("/home/me/ComfyUI");
    expect(fetchBasePath).not.toHaveBeenCalled();
  });

  it("falls back to the panel status base_path when there is NO local path", async () => {
    const fetchBasePath = vi.fn(async () => "/panel/ComfyUI");
    const { resolveComfyuiPathForTarget } = await import("../../services/secure-bridge.js");
    const out = await resolveComfyuiPathForTarget({
      target: LOOPBACK,
      localPath: undefined,
      forceRemote: false,
      isLoopback: true,
      fetchBasePath,
      exists: (p) => p === "/panel/ComfyUI",
    });
    expect(out).toBe("/panel/ComfyUI");
    expect(fetchBasePath).toHaveBeenCalledWith(LOOPBACK);
  });

  it("REFUSES a panel base_path that does not exist on this machine", async () => {
    const fetchBasePath = vi.fn(async () => "/remote/only/ComfyUI");
    const { resolveComfyuiPathForTarget } = await import("../../services/secure-bridge.js");
    const out = await resolveComfyuiPathForTarget({
      target: LOOPBACK,
      localPath: undefined,
      forceRemote: false,
      isLoopback: true,
      fetchBasePath,
      exists: () => false, // path not present locally
    });
    expect(out).toBeUndefined();
  });

  it("never fetches (and never adopts a local path) for a REMOTE target", async () => {
    const fetchBasePath = vi.fn(async () => "/x");
    const { resolveComfyuiPathForTarget } = await import("../../services/secure-bridge.js");
    const out = await resolveComfyuiPathForTarget({
      target: "https://pod-3000.proxy.runpod.net",
      localPath: "/home/me/ComfyUI",
      forceRemote: false,
      isLoopback: false,
      fetchBasePath,
      exists: () => true,
    });
    expect(out).toBeUndefined();
    expect(fetchBasePath).not.toHaveBeenCalled();
  });

  it("never fetches under --force-remote even for a loopback (port-forward to a pod)", async () => {
    const fetchBasePath = vi.fn(async () => "/x");
    const { resolveComfyuiPathForTarget } = await import("../../services/secure-bridge.js");
    const out = await resolveComfyuiPathForTarget({
      target: LOOPBACK,
      localPath: "/home/me/ComfyUI",
      forceRemote: true,
      isLoopback: true,
      fetchBasePath,
      exists: () => true,
    });
    expect(out).toBeUndefined();
    expect(fetchBasePath).not.toHaveBeenCalled();
  });

  it("degrades to undefined (no throw) when the panel fetch itself throws", async () => {
    const fetchBasePath = vi.fn(async () => {
      throw new Error("boom");
    });
    const { resolveComfyuiPathForTarget } = await import("../../services/secure-bridge.js");
    let out: string | undefined = "unset";
    await expect(
      (async () => {
        out = await resolveComfyuiPathForTarget({
          target: LOOPBACK,
          localPath: undefined,
          forceRemote: false,
          isLoopback: true,
          fetchBasePath,
          exists: () => true,
        });
      })(),
    ).resolves.toBeUndefined();
    expect(out).toBeUndefined();
  });
});
