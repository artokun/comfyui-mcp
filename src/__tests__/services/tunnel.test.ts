import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the `cloudflared` package so no real binary is installed or spawned and
// no network/tunnel is created. We capture the args passed to Tunnel.quick and
// drive the fake tunnel's events by hand.
// ---------------------------------------------------------------------------

// vi.mock is hoisted above imports, so the mock state and the fake Tunnel must
// be created with vi.hoisted() to be available inside the factory. The require
// of node:events also happens here so it is ready before the factory runs.
const h = vi.hoisted(() => {
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  class FakeTunnel extends EventEmitter {
    stop = vi.fn();
  }
  const quickCalls: Array<{ url?: string; options?: Record<string, unknown> }> = [];
  const installMock = vi.fn(async (to: string) => to);
  const useMock = vi.fn();
  const state: { lastTunnel: FakeTunnel | null } = { lastTunnel: null };
  return { FakeTunnel, quickCalls, installMock, useMock, state };
});

const { quickCalls, installMock, useMock, state } = h;

vi.mock("cloudflared", () => ({
  // Pretend the bundled binary exists so ensureBinary() is a no-op.
  bin: "/fake/cloudflared",
  install: h.installMock,
  use: h.useMock,
  Tunnel: {
    quick: (url?: string, options?: Record<string, unknown>) => {
      h.quickCalls.push({ url, options });
      const t = new h.FakeTunnel();
      h.state.lastTunnel = t;
      return t;
    },
  },
}));

// Make ensureBinary believe the bundled binary is present.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (p: string) => (p === "/fake/cloudflared" ? true : actual.existsSync(p)),
  };
});

import { startQuickTunnel } from "../../services/tunnel.js";

describe("startQuickTunnel", () => {
  beforeEach(() => {
    quickCalls.length = 0;
    installMock.mockClear();
    useMock.mockClear();
    state.lastTunnel = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("wires Tunnel.quick with the local URL and the expected args, and resolves on `url`", async () => {
    const promise = startQuickTunnel(8765);

    // Tunnel.quick should be invoked synchronously after ensureBinary().
    await vi.waitFor(() => expect(quickCalls).toHaveLength(1));

    const call = quickCalls[0];
    expect(call.url).toBe("http://localhost:8765");
    expect(call.options).toEqual({
      "--config": process.platform === "win32" ? "NUL" : "/dev/null",
      "--edge-ip-version": "4",
    });

    // Did NOT need to install since the bundled binary "exists".
    expect(installMock).not.toHaveBeenCalled();

    // Emit the url event -> promise resolves with the public URL.
    state.lastTunnel!.emit("url", "https://random-poc.trycloudflare.com");

    const handle = await promise;
    expect(handle.url).toBe("https://random-poc.trycloudflare.com");
    expect(handle.getState()).toMatchObject({
      status: "running",
      url: "https://random-poc.trycloudflare.com",
    });
  });

  it("stop() tears down the tunnel and marks state stopped", async () => {
    const promise = startQuickTunnel(9000);
    await vi.waitFor(() => expect(quickCalls).toHaveLength(1));
    state.lastTunnel!.emit("url", "https://abc.trycloudflare.com");
    const handle = await promise;

    handle.stop();
    expect(state.lastTunnel!.stop).toHaveBeenCalledTimes(1);
    expect(handle.getState().status).toBe("stopped");
  });

  it("rejects when the tunnel errors before becoming ready", async () => {
    const promise = startQuickTunnel(9100);
    await vi.waitFor(() => expect(quickCalls).toHaveLength(1));
    state.lastTunnel!.emit("error", new Error("boom"));
    await expect(promise).rejects.toThrow(/boom/);
  });

  it("rejects when cloudflared exits before the url event", async () => {
    const promise = startQuickTunnel(9200);
    await vi.waitFor(() => expect(quickCalls).toHaveLength(1));
    state.lastTunnel!.emit("exit", 1, null);
    await expect(promise).rejects.toThrow(/exited before tunnel was ready/);
  });
});
