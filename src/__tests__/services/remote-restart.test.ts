// Remote restart: when the orchestrator targets a REMOTE ComfyUI (--comfyui-url,
// e.g. a Cloudflare-tunnelled Desktop app), restart_comfyui must NOT throw — it
// fires a ComfyUI-Manager HTTP reboot and polls readiness until the (self-
// supervised) origin comes back. Everything is exercised through mocked
// comfyuiFetch + isRemoteMode; no real process/port/network is touched.

import { describe, expect, it, beforeEach, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  remoteMode: { value: true },
  fetchMock: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
  getSystemStats: vi.fn(async () => ({ system: { argv: [] as string[] } })),
  execSync: vi.fn(() => ""),
  spawn: vi.fn(),
}));

vi.mock("../../config.js", () => ({
  config: { resolvedPort: 8188, comfyuiPath: "/fake/comfy", comfyuiBasePath: "" },
  getComfyUIBaseUrl: () => "http://remote.example:8188",
  // #848 instance fence — a stable target here; the retarget case has its own test.
  getComfyuiTargetGeneration: () => 0,
  isRemoteMode: () => hoisted.remoteMode.value,
}));

vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: (url: string, init?: RequestInit) => hoisted.fetchMock(url, init),
}));

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: hoisted.getSystemStats,
  resetClient: hoisted.resetClient,
  resetObjectInfoCache: hoisted.resetObjectInfoCache,
}));

vi.mock("node:child_process", () => ({
  execSync: hoisted.execSync,
  spawn: hoisted.spawn,
  // workspace-env.ts (pulled in transitively via env-capabilities → process-control)
  // wraps execFile with promisify at load, so the mock must export a function.
  execFile: vi.fn(),
}));

import {
  restartComfyUI,
  __processControlTestHooks,
} from "../../services/process-control.js";

type FetchCall = [string, RequestInit | undefined];
const pathOf = (u: string): string => new URL(u).pathname;
const findCall = (pred: (path: string) => boolean): FetchCall | undefined =>
  (hoisted.fetchMock.mock.calls as FetchCall[]).find(([u]) => pred(pathOf(u)));

beforeEach(() => {
  hoisted.remoteMode.value = true;
  hoisted.fetchMock.mockReset();
  hoisted.resetClient.mockClear();
  hoisted.resetObjectInfoCache.mockClear();
  hoisted.getSystemStats.mockClear();
  hoisted.execSync.mockReset();
  hoisted.execSync.mockImplementation(() => "");
  __processControlTestHooks.reset();
});

describe("restartComfyUI — remote (Manager reboot)", () => {
  it("reboot POST 502, then /system_stats errors twice then 200 → ready, dispatch UNacknowledged", async () => {
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 1000,
      intervalMs: 5,
    });
    let statsCalls = 0;
    hoisted.fetchMock.mockImplementation(async (url: string) => {
      const path = pathOf(url);
      if (path === "/v2/manager/reboot") {
        // Killed origin behind a proxy/tunnel surfaces as a 5xx bad-gateway.
        return new Response("bad gateway", { status: 502 });
      }
      if (path === "/system_stats") {
        statsCalls++;
        if (statsCalls <= 2) throw new Error("fetch failed");
        return new Response(JSON.stringify({ system: {} }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const res = await restartComfyUI();

    expect(res.stopped).toBe(true);
    expect(res.ready).toBe(true);
    // No process of ours was spawned, so there is no positive evidence this call
    // started anything; `ready:true` carries the good news (codex gate round 8).
    expect(res.started).toBe(false);
    // A 502 is INFERRED to mean the handler took it and the origin dropped — a good
    // inference, and the reason this path works through a tunnel at all, but not an
    // acknowledgement. A tunnel hiccup in front of a server that was never restarted
    // produces the identical signal, so the report must not call it accepted (codex
    // gate round 7).
    expect(res.message).toContain("dispatched but not acknowledged");
    expect(res.message).not.toMatch(/request was acknowledged/i);
    // The OBSERVED signal is named — the status, and only the status — rather than
    // one of the causes this branch covers being narrated as the fact. Two earlier
    // wordings each named a different one: "the origin dropped as it went down"
    // (gate round 8) and "a proxy in front of ComfyUI answered" (gate round 9).
    // Nothing here identifies a proxy, and ComfyUI or the Manager can return a 502
    // directly.
    expect(res.message).toContain("the request returned HTTP 502");
    expect(res.message).not.toMatch(/connection dropped/i);
    expect(res.message).not.toMatch(/proxy/i);
    // …and no causal HEDGE either. "which usually means the handler accepted it and
    // the server went down" made two inferences and a frequency claim nobody
    // measured, and it undercut the very next sentence, which correctly says the
    // cycle was not directly observed (codex gate round 10).
    expect(res.message).not.toMatch(/usually means/i);
    expect(res.message).not.toMatch(/went down/i);
    expect(res.message).toMatch(/not directly observed/i);
    expect(res.startup).toBe("unconfirmed");
    expect(hoisted.resetClient).toHaveBeenCalledTimes(1);
    expect(hoisted.resetObjectInfoCache).toHaveBeenCalledTimes(1);
    // The 502 on the canonical POST route counts as "fired" — the legacy GET
    // route must never be tried.
    expect(findCall((p) => p === "/manager/reboot")).toBeUndefined();
  });

  it("Manager returns 403 → not started, manager-security note, does NOT throw", async () => {
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 100,
      intervalMs: 5,
    });
    hoisted.fetchMock.mockImplementation(async (url: string) => {
      // Both routes end in "/manager/reboot"; refuse either with 403.
      if (pathOf(url).endsWith("/manager/reboot")) {
        return new Response("forbidden", { status: 403 });
      }
      return new Response("", { status: 404 });
    });

    const res = await restartComfyUI();

    expect(res.started).toBe(false);
    expect(res.stopped).toBe(false);
    expect(res.message).toContain("403");
    expect(res.message).toContain("security");
    // A refusal must not arm a readiness poll or reset the client.
    expect(findCall((p) => p === "/system_stats")).toBeUndefined();
    expect(hoisted.resetClient).not.toHaveBeenCalled();
  });

  it("reboot fires but readiness never returns within budget → NOT CONFIRMED, never 'did not come back' (#367)", async () => {
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 30,
      intervalMs: 10,
    });
    hoisted.fetchMock.mockImplementation(async (url: string) => {
      const path = pathOf(url);
      if (path === "/v2/manager/reboot") return new Response("", { status: 200 });
      if (path === "/system_stats") throw new Error("ECONNRESET");
      return new Response("", { status: 404 });
    });

    const res = await restartComfyUI();

    expect(res.stopped).toBe(true);
    // No process of OURS was spawned here — the supervisor is what brings it back —
    // so `started` cannot be claimed. What changed is that it may no longer be READ
    // as the other definite answer: `startup` says which, and the sentence agrees.
    expect(res.started).toBe(false);
    expect(res.ready).toBe(false);
    expect(res.startup).toBe("unconfirmed");
    // ASSERT THE REASON. "did not come back" asserted a definite negative the
    // expired budget never established — that phrasing must be gone, not merely
    // reworded around.
    expect(res.message).not.toMatch(/did not come back/i);
    // Nor may it claim the server "went down": nothing observed a down transition —
    // the poller only records that no probe got a 2xx, which is equally consistent
    // with a server that was never reachable from here (codex gate round 2).
    expect(res.message).not.toMatch(/went down/i);
    expect(res.message).toMatch(/reboot request was acknowledged/i);
    expect(res.message).toMatch(/NOT CONFIRMED YET/);
    expect(res.message).toMatch(/does NOT mean it failed/i);
    expect(res.message).toMatch(/get_system_stats \(action:"health"\)/);
    expect(res.message).toMatch(/COMFYUI_REMOTE_REBOOT_BUDGET_S/);
    expect(hoisted.resetClient).not.toHaveBeenCalled();
  });

  it("legacy Manager 3.x (v2 405, legacy 404/405) → no-endpoint, actionable message; tries legacy POST too", async () => {
    // Reproduces #425/#253/#266 at the reboot boundary: the v2 route 405s and the
    // legacy GET 404s. Before the fix we stopped there; now we ALSO try POST
    // /manager/reboot, and when everything fails we return an actionable note.
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 50,
      intervalMs: 5,
    });
    const rebootAttempts: string[] = [];
    hoisted.fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = pathOf(url);
      if (path === "/v2/manager/reboot") {
        rebootAttempts.push(`${init?.method} ${path}`);
        return new Response("405: Method Not Allowed", { status: 405 });
      }
      if (path === "/manager/reboot") {
        rebootAttempts.push(`${init?.method} ${path}`);
        // GET 404s (classic legacy symptom), POST also unsupported.
        return new Response("not found", { status: init?.method === "GET" ? 404 : 405 });
      }
      return new Response("", { status: 404 });
    });

    const res = await restartComfyUI();

    expect(res.started).toBe(false);
    // The legacy POST /manager/reboot fallback route is now attempted.
    expect(rebootAttempts).toContain("POST /manager/reboot");
    expect(res.message).toMatch(/legacy manager 3\.x/i);
    expect(res.message).toMatch(/restart_comfyui/i);
    // No endpoint fired → no readiness poll, no cache reset.
    expect(findCall((p) => p === "/system_stats")).toBeUndefined();
    expect(hoisted.resetClient).not.toHaveBeenCalled();
  });

  it("legacy GET /manager/reboot answered by the SPA catchall (200 HTML) is NOT a false reboot", async () => {
    // codex P1: ComfyUI's frontend catchall serves the index HTML (200 text/html)
    // for an unknown GET. A 200 there must NOT be classified as "reboot fired"
    // (readiness — a still-up server — would rubber-stamp it). The legacy POST
    // route must still be tried; when all fail → honest no-endpoint.
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 50,
      intervalMs: 5,
    });
    const attempts: string[] = [];
    hoisted.fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = pathOf(url);
      if (path === "/v2/manager/reboot") {
        attempts.push(`${init?.method} ${path}`);
        return new Response("405", { status: 405 });
      }
      if (path === "/manager/reboot") {
        attempts.push(`${init?.method} ${path}`);
        if (init?.method === "GET") {
          // The SPA index — a 200 that is NOT a reboot.
          return new Response("<!doctype html><html><body>ComfyUI</body></html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }
        return new Response("405", { status: 405 });
      }
      return new Response("", { status: 404 });
    });

    const res = await restartComfyUI();

    // Did NOT falsely report a reboot off the HTML 200, and DID try the POST route.
    expect(res.started).toBe(false);
    expect(attempts).toContain("POST /manager/reboot");
    expect(res.message).toMatch(/legacy manager 3\.x|no reachable/i);
    // No readiness poll fired (nothing rebooted).
    expect(findCall((p) => p === "/system_stats")).toBeUndefined();
    expect(hoisted.resetClient).not.toHaveBeenCalled();
  });

  it("local mode routes through stop/start — the remote reboot path is not taken", async () => {
    hoisted.remoteMode.value = false;
    // No PID on the port and no Desktop app process → stopComfyUI can't find it.
    hoisted.execSync.mockImplementation(() => "");
    hoisted.fetchMock.mockImplementation(async () => new Response("", { status: 200 }));

    const res = await restartComfyUI();

    // Went down the local stop→start path (the relaunch preflight finds no
    // running process to restart), never the Manager reboot path.
    expect(res.started).toBe(false);
    expect(res.stopped).toBe(false);
    expect(res.message).toContain("No ComfyUI process found");
    expect(findCall((p) => p.endsWith("/manager/reboot"))).toBeUndefined();
  });
});
