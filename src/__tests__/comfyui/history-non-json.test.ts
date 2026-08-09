// #1149 — get_history and get_image both failed with `Unexpected end of JSON
// input` after a COMPLETED video render on a remote H100, and get_image wrapped
// it as HISTORY_UNREADABLE.
//
// getHistory was the last unguarded `res.json()` on the media read paths. Every
// sibling already routes through readComfyJson (#918/#946/#952), which names the
// URL, the status, the content type and a body prefix — so an empty body, an
// auth gate's login page and a proxy's HTML are each said out loud instead of
// collapsing into one parser message that names nothing.

import { describe, expect, it, beforeEach, vi } from "vitest";

const fetchApi = vi.hoisted(() => ({ impl: async (_p: string) => new Response("{}") }));
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
    async fetchApi(p: string) {
      return fetchApi.impl(p);
    }
    close() {}
  },
}));

vi.mock("../../config.js", () => ({
  config: { comfyuiSsl: false, comfyuiPath: "", comfyuiBasePath: "" },
  getComfyUIApiHost: () => "remote.example:8188",
  getComfyUIBasePath: () => "",
  getComfyUIBaseUrl: () => "http://remote.example:8188",
  getComfyUIAuthHeaders: () => ({}),
  isCloudMode: () => false,
  isRemoteMode: () => true,
}));

import { getHistory } from "../../comfyui/client.js";
import { isNonJsonResponseError } from "../../comfyui/json-guard.js";

beforeEach(() => {
  vi.clearAllMocks();
  fetchApi.impl = async () => new Response("{}", { status: 200 });
});

describe("getHistory does not leak a bare parser message (#1149)", () => {
  it("classifies an EMPTY body instead of 'Unexpected end of JSON input'", async () => {
    // The reporter's exact error. An empty body is the one case where the
    // evidence is unambiguous — the server answered and sent zero bytes.
    fetchApi.impl = async () => new Response("", { status: 200 });
    const err = await getHistory().catch((e: unknown) => e);
    expect(isNonJsonResponseError(err)).toBe(true);
    expect((err as Error).message).not.toMatch(/^Unexpected end of JSON input$/);
    expect((err as Error).message).toMatch(/\/history/);
  });

  it("names HTML as HTML — an auth gate or proxy, not a parse failure", async () => {
    fetchApi.impl = async () =>
      new Response("<!doctype html><html>login</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    const err = await getHistory().catch((e: unknown) => e);
    expect(isNonJsonResponseError(err)).toBe(true);
    expect((err as Error).message).toMatch(/HTML/i);
    expect((err as Error).message).not.toMatch(/Unexpected token/);
  });

  it("names the PROMPT-scoped url when one was requested", async () => {
    fetchApi.impl = async () => new Response("", { status: 200 });
    const err = await getHistory("abc123").catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/\/history\/abc123/);
  });

  it("an EMPTY history ({}) is a valid answer, not a failure", async () => {
    // The opposite defect, and the reason no expectShape is asserted: /history
    // legitimately returns {} when nothing has run, and calling that a bad shape
    // would fabricate a failure from a correct response.
    fetchApi.impl = async () => new Response("{}", { status: 200 });
    await expect(getHistory()).resolves.toEqual({});
  });

  it("passes a real history through unchanged", async () => {
    const body = { "p-1": { prompt: [], outputs: {}, status: { completed: true } } };
    fetchApi.impl = async () => new Response(JSON.stringify(body), { status: 200 });
    await expect(getHistory()).resolves.toEqual(body);
  });
});
