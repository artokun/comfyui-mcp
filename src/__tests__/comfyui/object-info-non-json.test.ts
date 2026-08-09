// #828 — getObjectInfo goes through the client library, which parses JSON
// itself, so an HTML answer arrives as a bare "Unexpected token '<'" naming
// neither the URL nor the responder. It retries once against a fresh client;
// if that retry hits an unrelated transport blip, reporting ONLY the retry
// downgrades a proven non-JSON answer to "server unavailable" and sends the
// user to check whether ComfyUI is running (codex gate, round 8, finding 2).

import { describe, expect, it, beforeEach, vi } from "vitest";

const nodeDefs = vi.hoisted(() => ({ impl: async () => ({}) as unknown }));
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
    async getNodeDefs() {
      return nodeDefs.impl();
    }
    async getSystemStats() {
      return {};
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

import { getObjectInfo, resetObjectInfoCache } from "../../comfyui/client.js";
import { isNonJsonResponseError } from "../../comfyui/json-guard.js";

const HTML_PARSE_ERROR = () =>
  new SyntaxError(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`);

beforeEach(() => {
  vi.clearAllMocks();
  resetObjectInfoCache();
});

describe("getObjectInfo reports the attempt that PROVED a non-JSON answer (#828)", () => {
  it("keeps the HTML diagnosis when the FIRST attempt got HTML and the retry hit a transport blip", async () => {
    let call = 0;
    nodeDefs.impl = async () => {
      call += 1;
      if (call === 1) throw HTML_PARSE_ERROR();
      throw new Error("fetch failed"); // an unrelated blip on the retry
    };
    // The re-probe of /object_info sees the HTML page.
    global.fetch = vi.fn(
      async () =>
        new Response("<!DOCTYPE html><html><head><title>ComfyUI</title></head></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ) as unknown as typeof fetch;

    await expect(getObjectInfo()).rejects.toSatisfy((e: unknown) => {
      if (!isNonJsonResponseError(e)) return false;
      return e.message.includes("/object_info") && e.message.includes("HTML page");
    });
  });

  it("reports the retry's own HTML answer when that is the one that proved it", async () => {
    nodeDefs.impl = async () => {
      throw HTML_PARSE_ERROR();
    };
    global.fetch = vi.fn(
      async () =>
        new Response("<!DOCTYPE html><html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ) as unknown as typeof fetch;
    await expect(getObjectInfo()).rejects.toSatisfy((e: unknown) => isNonJsonResponseError(e));
  });

  it("leaves a plain transport failure alone — nothing proved a non-JSON answer", async () => {
    nodeDefs.impl = async () => {
      throw new Error("fetch failed");
    };
    const probe = vi.fn();
    global.fetch = probe as unknown as typeof fetch;
    await expect(getObjectInfo()).rejects.toThrow(/fetch failed/);
    expect(probe).not.toHaveBeenCalled(); // no speculative re-probe
  });

  it("returns the definitions when the retry succeeds", async () => {
    let call = 0;
    nodeDefs.impl = async () => {
      call += 1;
      if (call === 1) throw new Error("fetch failed");
      return { KSampler: {} };
    };
    await expect(getObjectInfo()).resolves.toHaveProperty("KSampler");
  });
});
