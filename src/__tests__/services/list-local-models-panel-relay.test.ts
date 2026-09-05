// #2511 — list_local_models action:list fails with EHOSTUNREACH against the
// configured remote ComfyUI URL while the live sidebar panel is bound to that
// same origin. Headless MCP cannot reach the host; the panel can. Inventory
// must follow the #2283 object_info relay: authenticated panel fetch_comfyui_read
// after a transport-layer failure, not an undetermined listing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mode = vi.hoisted(() => ({
  remote: true,
  generation: 0,
  baseUrl: "https://gpu.example.internal:8188",
}));

vi.mock("../../config.js", () => ({
  config: { comfyuiPath: undefined as string | undefined },
  getComfyUIBaseUrl: () => mode.baseUrl,
  getComfyuiTargetGeneration: () => mode.generation,
  isRemoteMode: () => mode.remote,
}));

const fetchApi = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getClient: () => ({ fetchApi }),
  comfyApiFetch: (...a: unknown[]) => fetchApi(...a),
}));

const panelRead = vi.hoisted(() => vi.fn());
vi.mock("../../services/panel-image-relay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/panel-image-relay.js")>();
  return { ...actual, requestPanelComfyUIRead: panelRead };
});

vi.mock("../../services/extra-paths.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../services/extra-paths.js")>();
  return { ...real, getExtraModelRoots: async () => [] };
});

const { config } = await import("../../config.js");
const { listLocalModels, listLocalModelsWithCoverage } = await import(
  "../../services/model-resolver.js"
);
const { describeEmptyModelListing, registerModelManagementTools } = await import(
  "../../tools/model-management.js"
);

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function registeredListLocalModelsTool(): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (_name: string, _description: string, _schema: unknown, ...rest: unknown[]) => {
      const candidate = rest.find((arg) => typeof arg === "function");
      if (typeof candidate === "function") handler = candidate as ToolHandler;
    },
  };
  registerModelManagementTools(server as never);
  if (!handler) throw new Error("list_local_models was not registered");
  return handler;
}

function hostUnreachable(path: string): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error(`connect EHOSTUNREACH ${mode.baseUrl} while requesting ${path}`), {
      code: "EHOSTUNREACH",
    }),
  });
}

function panelBody(operation: string, payload: unknown): {
  operation: string;
  body: string;
  contentType: string;
  bytes: number;
} {
  const body = JSON.stringify(payload);
  return {
    operation,
    body,
    contentType: "application/json",
    bytes: Buffer.byteLength(body, "utf8"),
  };
}

beforeEach(() => {
  fetchApi.mockReset();
  panelRead.mockReset();
  config.comfyuiPath = undefined;
  mode.remote = true;
  mode.generation = 0;
  mode.baseUrl = "https://gpu.example.internal:8188";
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("#2511: list_local_models relays inventory through the connected panel", () => {
  it("returns panel-relayed checkpoints when headless /models/checkpoints is EHOSTUNREACH", async () => {
    fetchApi.mockImplementation(async (path: string) => {
      throw hostUnreachable(path);
    });
    panelRead.mockImplementation(async (operation: string) => {
      if (operation === "models/checkpoints") {
        return panelBody(operation, ["remote-ckpt.safetensors"]);
      }
      if (operation === "object_info") {
        throw new Error("object_info must not be used as the models inventory");
      }
      return undefined;
    });

    const { models, coverage } = await listLocalModelsWithCoverage("checkpoints");

    expect(models).toEqual([
      {
        name: "remote-ckpt.safetensors",
        path: "checkpoints/remote-ckpt.safetensors",
        size: 0,
        modified: "",
        type: "checkpoints",
      },
    ]);
    expect(coverage.answered).toEqual(["checkpoints"]);
    expect(coverage.noSourceAvailable).toBeUndefined();
    expect(panelRead).toHaveBeenCalledWith("models/checkpoints");
    expect(panelRead.mock.calls.map(([operation]) => operation)).not.toContain("object_info");
  });

  it("list_local_models action:list renders the relayed files, not an undetermined inventory", async () => {
    fetchApi.mockImplementation(async (path: string) => {
      throw hostUnreachable(path);
    });
    panelRead.mockImplementation(async (operation: string) => {
      if (operation === "models/checkpoints") {
        return panelBody(operation, ["remote-ckpt.safetensors"]);
      }
      return undefined;
    });

    const list = registeredListLocalModelsTool();
    const res = await list({ action: "list", model_type: "checkpoints" });
    const text = res.content.map((part) => part.text).join("\n");

    expect(res.isError).toBeFalsy();
    expect(text).toContain("remote-ckpt.safetensors");
    expect(text).not.toMatch(/Could not determine which .+ are installed/i);
    expect(describeEmptyModelListing("checkpoints", {
      answered: [],
      unanswered: [{ dir: "checkpoints", reason: "connect EHOSTUNREACH" }],
      usedFilesystem: false,
      noSourceAvailable: true,
    })).toMatch(/Could not determine which checkpoints models are installed/i);
  });

  it("unfiltered listing uses the panel /models index and per-category reads", async () => {
    fetchApi.mockImplementation(async (path: string) => {
      throw hostUnreachable(path);
    });
    panelRead.mockImplementation(async (operation: string) => {
      if (operation === "models") {
        return panelBody(operation, ["checkpoints", "loras"]);
      }
      if (operation === "models/checkpoints") {
        return panelBody(operation, ["remote-ckpt.safetensors"]);
      }
      if (operation === "models/loras") {
        return panelBody(operation, ["remote-lora.safetensors"]);
      }
      return undefined;
    });

    const result = await listLocalModels();
    expect(result.map((m) => ({ name: m.name, type: m.type }))).toEqual(
      expect.arrayContaining([
        { name: "remote-ckpt.safetensors", type: "checkpoints" },
        { name: "remote-lora.safetensors", type: "loras" },
      ]),
    );
    expect(panelRead).toHaveBeenCalledWith("models");
    expect(panelRead).toHaveBeenCalledWith("models/checkpoints");
    expect(panelRead).toHaveBeenCalledWith("models/loras");
  });

  it("does not use the panel for a configured-route HTTP error", async () => {
    fetchApi.mockResolvedValue(new Response("gateway down", { status: 503 }));

    const { models, coverage } = await listLocalModelsWithCoverage("checkpoints");

    expect(models).toEqual([]);
    expect(coverage.unanswered).toEqual([{ dir: "checkpoints", reason: "HTTP 503" }]);
    expect(panelRead).not.toHaveBeenCalled();
  });

  it("recovers loras and diffusion_models from panel object_info when models/<category> is outside the panel allowlist", async () => {
    fetchApi.mockImplementation(async (path: string) => {
      throw hostUnreachable(path);
    });
    panelRead.mockImplementation(async (operation: string) => {
      if (operation === "models" || operation.startsWith("models/")) {
        throw new Error(
          "fetch_comfyui_read rejected the operation: operation must be one of history, system_stats, logs, object_info",
        );
      }
      if (operation === "object_info") {
        return panelBody(operation, {
          LoraLoader: {
            input: {
              required: {
                lora_name: [["remote-lora.safetensors"], {}],
              },
            },
          },
          UNETLoader: {
            input: {
              required: {
                unet_name: [["remote-unet.safetensors"], {}],
              },
            },
          },
        });
      }
      return undefined;
    });

    const loras = await listLocalModelsWithCoverage("loras");
    expect(loras.models).toEqual([
      {
        name: "remote-lora.safetensors",
        path: "loras/remote-lora.safetensors",
        size: 0,
        modified: "",
        type: "loras",
      },
    ]);
    expect(loras.coverage.answered).toEqual(["loras"]);
    expect(loras.coverage.noSourceAvailable).toBeUndefined();

    const diffusion = await listLocalModelsWithCoverage("diffusion_models");
    expect(diffusion.models).toEqual([
      {
        name: "remote-unet.safetensors",
        path: "diffusion_models/remote-unet.safetensors",
        size: 0,
        modified: "",
        type: "diffusion_models",
      },
    ]);
    expect(diffusion.coverage.answered).toEqual(["diffusion_models"]);
    expect(panelRead.mock.calls.map(([operation]) => operation)).toContain("object_info");
    expect(panelRead.mock.calls.map(([operation]) => operation)).toContain("models/loras");
    expect(panelRead.mock.calls.map(([operation]) => operation)).toContain("models/diffusion_models");
  });
  it("a non-document object_info body is a FAILED read, not an empty inventory", async () => {
    // The relay hands back whatever the panel sent. `null` parses fine, and the
    // memo keyed on `!== undefined` used to cache it — so the call site's
    // `info === undefined` guard passed and the walkers were handed a
    // non-document. The listing then reported ZERO models as though the panel had
    // answered, which is the failure mode #2511 exists to remove.
    fetchApi.mockImplementation(async (path: string) => {
      throw hostUnreachable(path);
    });
    panelRead.mockImplementation(async (operation: string) => {
      if (operation === "models" || operation.startsWith("models/")) {
        throw new Error(
          "fetch_comfyui_read rejected the operation: operation must be one of history, system_stats, logs, object_info",
        );
      }
      if (operation === "object_info") return panelBody(operation, null);
      return undefined;
    });

    const loras = await listLocalModelsWithCoverage("loras");
    expect(loras.models).toEqual([]);
    // The point of the pin: "no source could answer", NOT "answered with nothing".
    expect(loras.coverage.answered).not.toContain("loras");
    expect(loras.coverage.noSourceAvailable).toBeDefined();
  });
});
