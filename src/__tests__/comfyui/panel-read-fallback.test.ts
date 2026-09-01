import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const panelRead = vi.hoisted(() => vi.fn());
const panelImage = vi.hoisted(() => vi.fn());
const fetchApi = vi.hoisted(() => vi.fn());

const VALID_OBJECT_INFO = {
  KSampler: {
    input: { required: {} },
    output: ["MODEL"],
    output_is_list: [false],
    output_name: ["model"],
    name: "KSampler",
    display_name: "KSampler",
    description: "",
    category: "sampling",
    output_node: false,
  },
};

vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return {
    ...actual,
    config: { ...actual.config, comfyuiBasePath: "/comfyapi", comfyuiPath: "" },
    getComfyUIApiHost: () => "127.0.0.1:8188",
    getComfyUIBasePath: () => "/comfyapi",
    getComfyUIBaseUrl: () => "http://127.0.0.1:8188/comfyapi",
    getComfyUIAuthHeaders: () => ({ Authorization: "Bearer headless-token" }),
    isCloudMode: () => false,
    isRemoteMode: () => true,
  };
});

vi.mock("@stable-canvas/comfyui-client", () => ({
  Client: class {
    apiURL(path: string): string {
      return path;
    }

    apiHeaders(init?: { headers?: unknown }): unknown {
      return init?.headers ?? {};
    }

    async fetch(url: string, init?: unknown): Promise<unknown> {
      return await fetchApi(url, init);
    }

    async getNodeDefs(): Promise<Record<string, unknown>> {
      return await fetchApi("/object_info");
    }

    fetchApi = fetchApi;
    close() {}
  },
}));

vi.mock("../../services/panel-image-relay.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/panel-image-relay.js")>(
    "../../services/panel-image-relay.js",
  );
  return { ...actual, requestPanelComfyUIRead: panelRead, requestPanelImage: panelImage };
});

import {
  fetchImage,
  getHistory,
  getLogs,
  getObjectInfo,
  getSystemStats,
  resetObjectInfoCache,
  resetClient,
} from "../../comfyui/client.js";
import {
  PanelComfyUIReadRelayError,
  PanelImageRelayError,
  PANEL_COMFYUI_READ_MAX_BYTES,
  PANEL_COMFYUI_READ_OBJECT_INFO_MAX_BYTES,
} from "../../services/panel-image-relay.js";

function transportFailure(): TypeError {
  return new TypeError(
    "fetch failed",
    { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) },
  );
}

beforeEach(() => {
  fetchApi.mockReset();
  panelRead.mockReset();
  panelImage.mockReset();
  resetClient();
  resetObjectInfoCache();
  vi.stubGlobal("fetch", vi.fn(async () => { throw transportFailure(); }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authenticated panel-backed ComfyUI read fallback (#2283)", () => {
  it("maps history, system_stats, and logs to the panel operations and parses bodies", async () => {
    fetchApi.mockRejectedValue(transportFailure());
    panelRead.mockImplementation(async (operation: string) => {
      if (operation === "history") {
        const body = '{"prompt-1":{"status":{"status_str":"success"}}}';
        return {
          operation,
          body,
          contentType: "application/json",
          bytes: Buffer.byteLength(body, "utf8"),
        };
      }
      if (operation === "logs") {
        const body = JSON.stringify("line one\nline two");
        return { operation, body, contentType: "text/plain", bytes: Buffer.byteLength(body, "utf8") };
      }
      const body = '{"system":{"os":"windows"},"devices":[]}';
      return { operation, body, contentType: "application/json", bytes: Buffer.byteLength(body, "utf8") };
    });

    await expect(getHistory()).resolves.toEqual({
      "prompt-1": { status: { status_str: "success" } },
    });
    await expect(getSystemStats()).resolves.toMatchObject({ system: { os: "windows" }, devices: [] });
    await expect(getLogs()).resolves.toEqual(["line one", "line two"]);
    expect(panelRead.mock.calls.map(([operation]) => operation)).toEqual([
      "history",
      "system_stats",
      "logs",
    ]);
  });

  it("maps a transport-failed /object_info retry to the authenticated panel and parses the registry", async () => {
    fetchApi.mockRejectedValue(transportFailure());
    const body = JSON.stringify(VALID_OBJECT_INFO);
    panelRead.mockResolvedValue({
      operation: "object_info",
      body,
      contentType: "application/json",
      bytes: Buffer.byteLength(body, "utf8"),
    });

    await expect(getObjectInfo()).resolves.toEqual(JSON.parse(body));
    expect(panelRead).toHaveBeenCalledWith("object_info");
  });

  it("parses a production-sized relayed /object_info body above the generic read cap", async () => {
    const body = JSON.stringify({
      KSampler: {
        ...VALID_OBJECT_INFO.KSampler,
        description: "x".repeat(PANEL_COMFYUI_READ_MAX_BYTES + 1),
      },
    });
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(PANEL_COMFYUI_READ_MAX_BYTES);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(PANEL_COMFYUI_READ_OBJECT_INFO_MAX_BYTES);
    fetchApi.mockRejectedValue(transportFailure());
    panelRead.mockResolvedValue({
      operation: "object_info",
      body,
      contentType: "application/json",
      bytes: Buffer.byteLength(body, "utf8"),
    });

    await expect(getObjectInfo()).resolves.toMatchObject({ KSampler: { name: "KSampler" } });
    expect(panelRead).toHaveBeenCalledWith("object_info");
  });

  it.each([
    ["an empty registry", {}],
    ["an error envelope", { error: "upstream unavailable" }],
    ["a status envelope", { status: "ok" }],
    ["a message envelope", { message: "not a node registry" }],
  ])("does not cache %s as object_info", async (_label, invalidBody) => {
    fetchApi.mockRejectedValue(transportFailure());
    const invalid = JSON.stringify(invalidBody);
    const valid = JSON.stringify(VALID_OBJECT_INFO);
    panelRead
      .mockResolvedValueOnce({
        operation: "object_info",
        body: invalid,
        contentType: "application/json",
        bytes: Buffer.byteLength(invalid, "utf8"),
      })
      .mockResolvedValueOnce({
        operation: "object_info",
        body: valid,
        contentType: "application/json",
        bytes: Buffer.byteLength(valid, "utf8"),
      });

    await expect(getObjectInfo()).rejects.toThrow(
      /not a ComfyUI \/object_info node registry object/,
    );
    await expect(getObjectInfo()).resolves.toEqual(JSON.parse(valid));
    expect(panelRead).toHaveBeenCalledTimes(2);
  });

  it("does not use the panel for a configured-route HTTP error, timeout, or fetchImage", async () => {
    fetchApi.mockResolvedValue(new Response("gateway down", { status: 503 }));
    await expect(getHistory()).rejects.toThrow();
    expect(panelRead).not.toHaveBeenCalled();

    fetchApi.mockReset();
    fetchApi.mockRejectedValue(transportFailure());
    const timedOut = new Error("request timed out");
    timedOut.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn(async () => { throw timedOut; }));
    await expect(getSystemStats()).rejects.toThrow(/No reply from ComfyUI within/);
    expect(panelRead).not.toHaveBeenCalled();

    vi.stubGlobal("fetch", vi.fn(async () => { throw transportFailure(); }));
    await expect(fetchImage("render.png")).rejects.toThrow(/fetch failed/);
    expect(panelRead).not.toHaveBeenCalled();

    fetchApi.mockReset();
    fetchApi.mockRejectedValueOnce(new Error("HTTP 503 from the configured route"));
    fetchApi.mockRejectedValueOnce(transportFailure());
    await expect(getLogs()).rejects.toThrow(/ECONNREFUSED|Failed to fetch ComfyUI logs/);
    expect(panelRead).not.toHaveBeenCalled();
  });

  it("surfaces an authenticated panel timeout/error without retrying unrelated origins", async () => {
    fetchApi.mockRejectedValue(transportFailure());
    panelRead.mockRejectedValue(new PanelComfyUIReadRelayError("panel timed out", "TIMEOUT"));

    await expect(getLogs()).rejects.toThrow(/read fallback failed safely \(TIMEOUT\)/);
    expect(panelRead).toHaveBeenCalledWith("logs");
  });

  // #2703 — the reporter's own call. A dead COMFYUI_URL plus a live panel whose
  // read declined, and the message named only the code. The relay now carries
  // the cause; this pins that get_history's CALL SITE actually says it, because
  // this message is built from the code here — not taken from the relay error —
  // so a relay that carries a reason nobody reads would still ship the dead end.
  it("names the panel-side cause behind a PANEL_FETCH_FAILED history read", async () => {
    fetchApi.mockRejectedValue(transportFailure());
    panelRead.mockRejectedValue(
      new PanelComfyUIReadRelayError(
        "The connected panel could not read ComfyUI.",
        "PANEL_FETCH_FAILED",
        false,
        "fetch_comfyui_read response exceeds the 16777216-byte limit",
      ),
    );

    const failure = await getHistory().then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toContain("read fallback failed safely (PANEL_FETCH_FAILED)");
    expect(failure?.message).toContain("The panel reported: fetch_comfyui_read response exceeds the 16777216-byte limit");
    expect(panelRead).toHaveBeenCalledWith("history");
  });

  // #2703 — the SIBLING call site. fetchImage builds its own message from the
  // code the same way, and mutating this line alone left every other test green:
  // a fix on one exit with an untested twin is a fix that half-ships.
  it("names the panel-side cause behind a PANEL_FETCH_FAILED image read", async () => {
    fetchApi.mockRejectedValue(transportFailure());
    panelImage.mockRejectedValue(
      new PanelImageRelayError(
        "The connected panel could not fetch that image.",
        "PANEL_FETCH_FAILED",
        false,
        "fetch_image could not reach /view: Failed to fetch",
      ),
    );

    const failure = await fetchImage("render.png").then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toContain("image relay failed safely (PANEL_FETCH_FAILED)");
    expect(failure?.message).toContain("The panel reported: fetch_image could not reach /view: Failed to fetch");
  });

  it("keeps the bare code when the relay carried no cause", async () => {
    fetchApi.mockRejectedValue(transportFailure());
    panelRead.mockRejectedValue(
      new PanelComfyUIReadRelayError("The connected panel could not read ComfyUI.", "PANEL_FETCH_FAILED"),
    );

    const failure = await getHistory().then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toContain("read fallback failed safely (PANEL_FETCH_FAILED).");
    expect(failure?.message).not.toContain("The panel reported:");
  });
});
