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
import { setConnectedPanelOrigins } from "../../comfyui/fetch.js";
import {
  PanelComfyUIReadRelayError,
  PanelImageRelayError,
  PANEL_COMFYUI_READ_MAX_BYTES,
  PANEL_COMFYUI_READ_OBJECT_INFO_MAX_BYTES,
} from "../../services/panel-image-relay.js";
import { resolvePanelReadOrigin } from "../../services/panel-fallback-target.js";
import { ComfyUIError } from "../../utils/errors.js";

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
  setConnectedPanelOrigins(null);
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

describe("connected-panel read fallback origin/API base (#2836)", () => {
  it("does not throw when api_base is undefined — origin stays unproven", () => {
    expect(resolvePanelReadOrigin(["http://127.0.0.1:8188"], undefined)).toEqual({
      kind: "unproven",
    });
  });

  it("does not pick the first origin when two proven origins differ", () => {
    expect(
      resolvePanelReadOrigin(["http://127.0.0.1:8188", "http://127.0.0.1:8189"], ""),
    ).toEqual({ kind: "unproven" });
  });

  it("treats loopback aliases as one proven origin", () => {
    expect(
      resolvePanelReadOrigin(["http://127.0.0.1:8188", "http://localhost:8188"], "/comfyapi"),
    ).toEqual({
      kind: "proven",
      origin: "http://127.0.0.1:8188",
      apiBase: "/comfyapi",
    });
  });

  function apiBaseCrash(): PanelComfyUIReadRelayError {
    return new PanelComfyUIReadRelayError(
      "The connected panel could not read ComfyUI.",
      "PANEL_FETCH_FAILED",
      false,
      "Cannot read properties of undefined (reading api_base)",
    );
  }

  it.each(["getHistory", "getSystemStats"] as const)(
    "%s fails closed when the published panel origin is unproven",
    async (name) => {
      fetchApi.mockRejectedValue(transportFailure());
      setConnectedPanelOrigins(() => ["not-an-origin", "ws://localhost:8188"]);

      const err = await (name === "getHistory" ? getHistory() : getSystemStats()).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(err).toBeInstanceOf(ComfyUIError);
      expect(err).toMatchObject({
        code: "PANEL_ORIGIN_UNPROVEN",
        message: expect.stringMatching(/ECONNREFUSED|fetch failed/),
      });
      expect(String(err instanceof Error ? err.message : err)).toContain("fetch_comfyui_read was not dispatched");
      expect(panelRead).not.toHaveBeenCalled();
    },
  );

  it("still reads history through the panel when the origin is proven", async () => {
    fetchApi.mockRejectedValue(transportFailure());
    setConnectedPanelOrigins(() => ["http://127.0.0.1:8188"]);
    const body = '{"prompt-1":{"status":{"status_str":"success"}}}';
    panelRead.mockResolvedValue({
      operation: "history",
      body,
      contentType: "application/json",
      bytes: Buffer.byteLength(body, "utf8"),
    });

    await expect(getHistory()).resolves.toEqual({
      "prompt-1": { status: { status_str: "success" } },
    });
    expect(panelRead).toHaveBeenCalledWith("history");
  });

  it.each(["getHistory", "getSystemStats"] as const)(
    "%s names a transport diagnostic instead of throwing on undefined api_base",
    async (name) => {
      fetchApi.mockRejectedValue(transportFailure());
      setConnectedPanelOrigins(() => ["http://127.0.0.1:8188"]);
      panelRead.mockRejectedValue(apiBaseCrash());

      const err = await (name === "getHistory" ? getHistory() : getSystemStats()).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(err).toBeInstanceOf(ComfyUIError);
      expect(err).toMatchObject({
        code: "PANEL_API_BASE_UNAVAILABLE",
        message: expect.stringMatching(/ECONNREFUSED|fetch failed/),
      });
      const message = String(err instanceof Error ? err.message : err);
      expect(message).toContain("transport diagnostic");
      expect(message).not.toContain("The panel reported:");
      expect(panelRead).toHaveBeenCalledWith(name === "getHistory" ? "history" : "system_stats");
    },
  );

  // Recurrence on 0.52.193: the live tab origin is not 8188, panel_run works,
  // but history/health still dispatched fetch_comfyui_read and died on
  // undefined api_base. The unique proven origin+api_base must be read
  // instead — this fails if that hop is skipped and only the relay runs.
  it.each(["getHistory", "getSystemStats"] as const)(
    "%s uses the unique proven panel origin+api_base when the relay has no api_base",
    async (name) => {
      fetchApi.mockRejectedValue(transportFailure());
      setConnectedPanelOrigins(() => ["http://127.0.0.1:8189"]);
      panelRead.mockRejectedValue(apiBaseCrash());
      const historyBody = '{"prompt-1":{"status":{"status_str":"success"}}}';
      const statsBody = '{"system":{"os":"windows"},"devices":[]}';
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("http://127.0.0.1:8189/comfyapi/")) {
          expect(new Headers(init?.headers).get("authorization")).toBeNull();
          const body = name === "getHistory" ? historyBody : statsBody;
          return new Response(body, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw transportFailure();
      });
      vi.stubGlobal("fetch", fetchMock);

      if (name === "getHistory") {
        await expect(getHistory()).resolves.toEqual({
          "prompt-1": { status: { status_str: "success" } },
        });
        expect(fetchMock.mock.calls.some(([input]) => String(input) === "http://127.0.0.1:8189/comfyapi/history")).toBe(true);
      } else {
        await expect(getSystemStats()).resolves.toMatchObject({
          system: { os: "windows" },
          devices: [],
        });
        expect(fetchMock.mock.calls.some(([input]) => String(input) === "http://127.0.0.1:8189/comfyapi/system_stats")).toBe(true);
      }
      expect(panelRead).not.toHaveBeenCalled();
    },
  );

  it.each(["getHistory", "getSystemStats"] as const)(
    "%s does not guess when two proven panel origins differ",
    async (name) => {
      fetchApi.mockRejectedValue(transportFailure());
      setConnectedPanelOrigins(() => ["http://127.0.0.1:8188", "http://127.0.0.1:8189"]);
      const fetchMock = vi.fn(async () => {
        throw transportFailure();
      });
      vi.stubGlobal("fetch", fetchMock);

      const err = await (name === "getHistory" ? getHistory() : getSystemStats()).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(err).toBeInstanceOf(ComfyUIError);
      expect(err).toMatchObject({ code: "PANEL_ORIGIN_UNPROVEN" });
      expect(panelRead).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("8189"))).toBe(false);
    },
  );
});
