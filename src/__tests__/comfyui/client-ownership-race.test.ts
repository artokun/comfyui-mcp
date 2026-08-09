import { beforeEach, describe, expect, it, vi } from "vitest";

// Force local mode. Each `new Client()` is a DISTINCT instance whose getNodeDefs
// behaviour is settable per instance and whose close() is observable — so we can
// prove a stale request's catch never closes a NEWER client (codex WS-3 round-2).
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

const instances = vi.hoisted(() => [] as Array<{ closed: boolean }>);
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
    closed = false;
    _impl: () => Promise<unknown> = () => Promise.reject(new Error("unset"));
    getNodeDefs = () => this._impl();
    constructor() {
      instances.push(this);
    }
    close() {
      this.closed = true;
    }
  },
}));

const { getObjectInfo, resetObjectInfoCache, resetClient, resetClientIfCurrent, getClient } =
  await import("../../comfyui/client.js");

type FakeClient = {
  closed: boolean;
  _impl: () => Promise<unknown>;
};

describe("client ownership race", () => {
  beforeEach(() => {
    instances.length = 0;
    resetClient();
    resetObjectInfoCache();
  });

  it("resetClientIfCurrent only resets when the argument is still the current client", () => {
    const c1 = getClient() as unknown as FakeClient;
    resetClient(); // c1 closed, singleton cleared
    const c2 = getClient() as unknown as FakeClient;
    // c1 is stale — must NOT close the newer c2.
    expect(resetClientIfCurrent(c1 as never)).toBe(false);
    expect(c2.closed).toBe(false);
    // c2 is current — resets.
    expect(resetClientIfCurrent(c2 as never)).toBe(true);
    expect(c2.closed).toBe(true);
    // null never resets.
    expect(resetClientIfCurrent(null)).toBe(false);
  });

  it("a stale request's delayed rejection does NOT close the newer client", async () => {
    // Request A starts on client C1 with a first attempt that rejects LATER.
    let rejectA!: (e: unknown) => void;
    const c1 = getClient() as unknown as FakeClient;
    c1._impl = () => new Promise((_res, rej) => (rejectA = rej));
    const pA = getObjectInfo(); // inflight on C1, epoch N

    // A restart fires: close C1 and abandon the cache slot (epoch N+1).
    resetClient();
    resetObjectInfoCache();

    // Request B creates C2 and succeeds.
    const c2 = getClient() as unknown as FakeClient;
    c2._impl = () => Promise.resolve({ NewNode: {} });
    await expect(getObjectInfo()).resolves.toEqual({ NewNode: {} });
    expect(c2.closed).toBe(false);

    // NOW A's first attempt rejects. Its catch must reset only if C1 is current —
    // it isn't (C2 is), so C2 stays open. A retries against the current C2.
    c2._impl = () => Promise.resolve({ NewNode: {} });
    rejectA(new Error("fetch failed"));
    await expect(pA).resolves.toEqual({ NewNode: {} });
    expect(c2.closed).toBe(false);
  });
});
