import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// advertiseBridge is the connect-time "bridge-token update" POST to the pod's
// panel pack. When that ComfyUI sits behind Cloudflare Access, the POST must
// carry the CF-Access service-token headers or Access returns its sign-in page
// instead of the API (the exact failure this wiring fixes). It now shares the
// single getComfyUIAuthHeaders() source with every other ComfyUI request.

const OLD_ENV = process.env;

function advertiseCall(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls.find(([u]) => String(u).includes("/comfyui_mcp_panel/advertise_bridge"));
  expect(call, "advertise_bridge POST should have been made").toBeTruthy();
  return call as [string, RequestInit];
}

describe("advertiseBridge auth headers", () => {
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

  it("carries the CF-Access service-token headers on the advertise POST", async () => {
    process.env.CF_ACCESS_CLIENT_ID = "cid.access";
    process.env.CF_ACCESS_CLIENT_SECRET = "csecret";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const { advertiseBridge } = await import("../../services/secure-bridge.js");
    const ok = await advertiseBridge("https://podid-3000.proxy.runpod.net", "wss://relay/?token=t");

    expect(ok).toBe(true);
    const [, init] = advertiseCall(fetchMock);
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "CF-Access-Client-Id": "cid.access",
      "CF-Access-Client-Secret": "csecret",
    });
  });

  it("also forwards COMFYUI_AUTH_TOKEN alongside CF Access", async () => {
    process.env.COMFYUI_AUTH_TOKEN = "abc123";
    process.env.CF_ACCESS_CLIENT_ID = "cid.access";
    process.env.CF_ACCESS_CLIENT_SECRET = "csecret";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const { advertiseBridge } = await import("../../services/secure-bridge.js");
    await advertiseBridge("https://podid-3000.proxy.runpod.net", "wss://relay/?token=t");

    const [, init] = advertiseCall(fetchMock);
    expect(init.headers).toMatchObject({
      Authorization: "Bearer abc123",
      "CF-Access-Client-Id": "cid.access",
      "CF-Access-Client-Secret": "csecret",
    });
  });

  it("no auth configured → advertise POST carries only Content-Type (no regression)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const { advertiseBridge } = await import("../../services/secure-bridge.js");
    await advertiseBridge("https://podid-3000.proxy.runpod.net", "wss://relay/?token=t");

    const [, init] = advertiseCall(fetchMock);
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
  });
});

// The retry loop could not retry. A pod behind a proxy that accepts the
// connection and then answers nothing — the characteristic RunPod-route failure
// the function's own comment calls "not warm yet" — left attempt 1 awaiting
// forever on a signal-less fetch, so attempts 2 and 3 never ran and bridge
// exposure hung with no error at all.
describe("advertiseBridge cannot hang on attempt 1", () => {
  const OLD = process.env;
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...OLD, COMFYUI_URL: "http://127.0.0.1:8188" };
  });
  afterEach(() => {
    process.env = OLD;
    vi.unstubAllGlobals();
  });

  it("bounds each attempt so the loop can reach attempts 2 and 3", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const { advertiseBridge } = await import("../../services/secure-bridge.js");
    await advertiseBridge("https://podid-3000.proxy.runpod.net", "wss://relay/?token=t");

    const [, init] = advertiseCall(fetchMock);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  // Split deliberately from the assertion above, and NOT written as "wait for the
  // real ceiling to fire". AbortSignal.timeout is backed by a platform timer that
  // vitest's fake timers do not drive, so a version of this test using
  // advanceTimersByTimeAsync sat for the full real 10s and then failed — it was
  // measuring Node's timer, not our code.
  //
  // What is OURS is that an aborted attempt is caught and the loop proceeds. That
  // is the half the hang broke, and it is what this pins.
  it("an aborted attempt is caught and the NEXT attempt still runs", async () => {
    const abortErr = new Error("This operation was aborted");
    abortErr.name = "TimeoutError";
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(abortErr)
      .mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const { advertiseBridge } = await import("../../services/secure-bridge.js");
    const ok = await advertiseBridge("https://podid-3000.proxy.runpod.net", "wss://relay/?token=t");

    expect(ok).toBe(true);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});
