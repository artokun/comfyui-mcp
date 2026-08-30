// #2283 — a connected sidebar panel can queue and complete renders while
// headless get_image list_assets and get_system_stats logs fail with
// ECONNREFUSED against COMFYUI_URL. History fallback already landed for
// prompt-scoped get_history (#2532/#2644); these production handlers must use
// the same authenticated panel read (and /view image relay) instead of guessing
// 8188. No live panel identity → fail closed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const panelRead = vi.hoisted(() => vi.fn());
const panelImage = vi.hoisted(() => vi.fn());
const fetchApi = vi.hoisted(() => vi.fn());

vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return {
    ...actual,
    config: { ...actual.config, comfyuiBasePath: "/comfyapi", comfyuiPath: "" },
    getComfyUIApiHost: () => "127.0.0.1:8000",
    getComfyUIBasePath: () => "/comfyapi",
    getComfyUIBaseUrl: () => "http://127.0.0.1:8000/comfyapi",
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

    apiHeaders(init?: { headers?: HeadersInit }) {
      return init?.headers ?? {};
    }

    async fetch(url: string, init?: RequestInit) {
      return await fetchApi(url, init);
    }

    fetchApi = fetchApi;
    close() {}
  },
}));

vi.mock("../../services/panel-image-relay.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/panel-image-relay.js")>(
    "../../services/panel-image-relay.js",
  );
  return {
    ...actual,
    requestPanelComfyUIRead: panelRead,
    requestPanelImage: panelImage,
  };
});

vi.mock("../../services/view-image.js", () => ({ viewAssetImage: vi.fn() }));
vi.mock("../../services/image-convert.js", () => ({ convertImage: vi.fn() }));
vi.mock("../../services/color-analysis.js", () => ({ analyzeColor: vi.fn() }));
vi.mock("../../services/storage-upload.js", () => ({ uploadOutput: vi.fn() }));

import { resetClient } from "../../comfyui/client.js";
import { PanelComfyUIReadRelayError } from "../../services/panel-image-relay.js";
import { registerImageManagementTools } from "../../tools/image-management.js";
import { registerSystemStatsTools } from "../../tools/system-stats.js";
import { AssetRegistry } from "../../services/asset-registry.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PROMPT = "panel-run-2283";
const FILENAME = "ComfyUI_00042_.png";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function registerTool(
  register: (server: { tool: (...args: unknown[]) => void }) => void,
  name: string,
): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (n: unknown, ...rest: unknown[]) => {
      if (n === name) {
        const candidate = rest.find((arg) => typeof arg === "function");
        if (typeof candidate === "function") handler = candidate as ToolHandler;
      }
    },
  };
  register(server as never);
  if (!handler) throw new Error(`${name} was not registered`);
  return handler;
}

function transportFailure(url = "http://127.0.0.1:8000/comfyapi"): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error(`connect ECONNREFUSED ${url}`), { code: "ECONNREFUSED" }),
  });
}

function sampleGraph(): WorkflowJSON {
  return {
    "3": { class_type: "KSampler", inputs: { seed: 42, steps: 20, cfg: 7 } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI", images: ["8", 0] } },
  };
}

function historyEntry(promptId: string, filename: string, successTs: number) {
  return {
    prompt: [12, promptId, sampleGraph(), {}, []],
    outputs: { "9": { images: [{ filename, subfolder: "", type: "output" }] } },
    status: {
      status_str: "success",
      completed: true,
      messages: [
        ["execution_start", { prompt_id: promptId, timestamp: successTs - 8000 }],
        ["execution_success", { prompt_id: promptId, timestamp: successTs }],
      ],
    },
  };
}

function panelHistoryBody(payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  return {
    operation: "history" as const,
    body,
    contentType: "application/json",
    bytes: Buffer.byteLength(body, "utf8"),
  };
}

function panelLogsBody(text: string) {
  const body = JSON.stringify(text);
  return {
    operation: "logs" as const,
    body,
    contentType: "text/plain",
    bytes: Buffer.byteLength(body, "utf8"),
  };
}

let fetchTargets: string[];

beforeEach(() => {
  fetchApi.mockReset();
  panelRead.mockReset();
  panelImage.mockReset();
  fetchTargets = [];
  resetClient();
  AssetRegistry.configure({ ttlMs: 24 * 60 * 60 * 1000, now: Date.now });
  AssetRegistry.clear();
  fetchApi.mockImplementation(async (url: string) => {
    fetchTargets.push(String(url));
    throw transportFailure(String(url));
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      fetchTargets.push(String(input));
      throw transportFailure(String(input));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function assertNeverGuessed8188() {
  expect(fetchTargets.join("\n")).not.toMatch(/:8188\b/);
}

describe("get_image list_assets and get_system_stats logs use panel fallback (#2283)", () => {
  it("list_assets registers a panel_run output when headless /history is ECONNREFUSED", async () => {
    const successTs = Date.now() - 4000;
    panelRead.mockImplementation(async (operation: string) => {
      if (operation !== "history") return undefined;
      return panelHistoryBody({
        [PROMPT]: historyEntry(PROMPT, FILENAME, successTs),
      });
    });
    panelImage.mockResolvedValue({
      base64: VALID_PNG_BASE64,
      mimeType: "image/png",
      bytes: 68,
    });

    const listAssets = registerTool(registerImageManagementTools, "get_image");
    const res = await listAssets({ action: "list_assets", limit: 20 });
    expect(res.isError).toBeUndefined();
    const out = JSON.parse(res.content[0].text) as {
      count: number;
      assets: Array<{ filename: string; prompt_id: string; source: string; type: string }>;
      note?: string;
    };

    expect(out.count).toBe(1);
    expect(out.note).toBeUndefined();
    expect(out.assets[0]).toMatchObject({
      filename: FILENAME,
      prompt_id: PROMPT,
      source: "history-reconcile",
      type: "output",
    });
    expect(panelRead).toHaveBeenCalledWith("history");
    expect(panelImage).toHaveBeenCalledWith(FILENAME, "output", "");
    assertNeverGuessed8188();
  });

  it("get_system_stats logs returns panel /internal/logs when headless logs are ECONNREFUSED", async () => {
    panelRead.mockImplementation(async (operation: string) => {
      if (operation !== "logs") return undefined;
      return panelLogsBody("line one\nPreviewImage executed\nline three");
    });

    const stats = registerTool(registerSystemStatsTools, "get_system_stats");
    const res = await stats({ action: "logs", keyword: "PreviewImage", max_lines: 50 });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe("PreviewImage executed");
    expect(panelRead).toHaveBeenCalledWith("logs");
    assertNeverGuessed8188();
  });

  it("fails closed when panel identity is unavailable and does not guess 8188", async () => {
    panelRead.mockResolvedValue(undefined);
    panelImage.mockResolvedValue(undefined);

    const listAssets = registerTool(registerImageManagementTools, "get_image");
    const listed = await listAssets({ action: "list_assets" });
    expect(listed.isError).toBeUndefined();
    const out = JSON.parse(listed.content[0].text) as { count: number; note?: string };
    expect(out.count).toBe(0);
    expect(out.note).toMatch(/Could not refresh from ComfyUI history/i);
    expect(out.note).toMatch(/ECONNREFUSED|fetch failed/i);

    const stats = registerTool(registerSystemStatsTools, "get_system_stats");
    const logs = await stats({ action: "logs" });
    expect(logs.isError).toBe(true);
    expect(logs.content[0].text).toMatch(/Failed to fetch ComfyUI logs after reconnect retry/);
    expect(logs.content[0].text).toMatch(/ECONNREFUSED|fetch failed/);
    expect(logs.content[0].text).not.toMatch(/127\.0\.0\.1:8188/);
    assertNeverGuessed8188();
  });

  it("does not use the panel for a configured-route HTTP error", async () => {
    fetchApi.mockReset();
    fetchApi.mockImplementation(async (url: string) => {
      fetchTargets.push(String(url));
      // Production Client.fetchApi throws outside [200, 400). A 503 body is
      // not a transport failure, so the panel must not be consulted.
      throw new Error("HTTP 503 from the configured route");
    });

    const listAssets = registerTool(registerImageManagementTools, "get_image");
    const listed = await listAssets({ action: "list_assets" });
    expect(listed.isError).toBeUndefined();
    const out = JSON.parse(listed.content[0].text) as { count: number; note?: string };
    expect(out.count).toBe(0);
    expect(out.note).toMatch(/Could not refresh from ComfyUI history/i);
    expect(panelRead).not.toHaveBeenCalled();
    expect(panelImage).not.toHaveBeenCalled();

    const stats = registerTool(registerSystemStatsTools, "get_system_stats");
    const logs = await stats({ action: "logs" });
    expect(logs.isError).toBe(true);
    expect(logs.content[0].text).toMatch(/HTTP 503 from the configured route/);
    expect(panelRead).not.toHaveBeenCalled();
    assertNeverGuessed8188();
  });

  it("surfaces an authenticated panel timeout without retrying unrelated origins", async () => {
    panelRead.mockRejectedValue(new PanelComfyUIReadRelayError("panel timed out", "TIMEOUT"));

    const stats = registerTool(registerSystemStatsTools, "get_system_stats");
    const logs = await stats({ action: "logs" });
    expect(logs.isError).toBe(true);
    expect(logs.content[0].text).toMatch(/read fallback failed safely \(TIMEOUT\)/);
    expect(panelRead).toHaveBeenCalledWith("logs");
    assertNeverGuessed8188();
  });
});
