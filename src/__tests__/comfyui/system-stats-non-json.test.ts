// #828 — get_system_stats on a remote target returned "Unexpected token '<',
// "<!DOCTYPE "... is not valid JSON". getSystemStats now fetches the endpoint
// itself (so a non-JSON answer can be diagnosed) and additionally checks that a
// JSON 200 actually LOOKS like a ComfyUI /system_stats document — a bare 2xx
// from a gateway that answers everything with its own JSON envelope is not
// system stats and must not be handed on as though it were.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { fakeFetch } from "../helpers/fake-fetch.js";

vi.mock("../../config.js", () => ({
  config: { comfyuiSsl: false, comfyuiPath: "", comfyuiBasePath: "" },
  getComfyUIApiHost: () => "remote.example:8188",
  getComfyUIBasePath: () => "",
  getComfyUIBaseUrl: () => "http://remote.example:8188",
  getComfyUIAuthHeaders: () => ({}),
  isCloudMode: () => false,
  isRemoteMode: () => true,
}));

import { getSystemStats } from "../../comfyui/client.js";
import { isNonJsonResponseError } from "../../comfyui/json-guard.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getSystemStats against a non-ComfyUI responder (#828)", () => {
  it("explains an HTML page instead of throwing a bare JSON syntax error", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response("<!DOCTYPE html><html><body>login</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    await expect(getSystemStats()).rejects.toSatisfy((e: unknown) => {
      if (!isNonJsonResponseError(e)) return false;
      return (
        e.message.includes("http://remote.example:8188/system_stats") &&
        e.message.includes("HTML page")
      );
    });
  });

  it("rejects a 200 that parses as JSON but is not a ComfyUI /system_stats document", async () => {
    // An API gateway that answers every route with its own JSON envelope. The old
    // path would have returned this as "stats" and every reader would have seen
    // an empty machine.
    global.fetch = vi.fn(
      async () =>
        new Response('{"message":"forbidden","code":403}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(getSystemStats()).rejects.toThrow(
      /valid JSON that is not a ComfyUI \/system_stats document/,
    );
  });

  it("returns the stats when the endpoint answers like ComfyUI", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ system: { comfyui_version: "0.3.0" }, devices: [{ name: "cuda:0" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const stats = await getSystemStats();
    expect(stats.system.comfyui_version).toBe("0.3.0");
    expect(stats.devices).toHaveLength(1);
  });

  it("accepts a devices-only document (some builds omit `system`)", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ devices: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(getSystemStats()).resolves.toBeTruthy();
  });

  it("hits the base URL's /system_stats route (path prefix preserved)", async () => {
    const spy = fakeFetch(
      async () =>
        new Response(JSON.stringify({ devices: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    global.fetch = spy;
    await getSystemStats();
    expect(String(spy.mock.calls[0][0])).toBe("http://remote.example:8188/system_stats");
  });
});
