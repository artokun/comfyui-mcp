import { beforeEach, describe, expect, it, vi } from "vitest";

// get_node_info structural-summary behavior (default) vs verbose=true full dump.
// Summary-by-default originally contributed by @joaolvivas in
// joaolvivas/comfyui-mcp-byjlucas@de82ecd — the motivating case is Loader nodes
// whose enum dropdowns embed the entire local model list (100s of KB per node).

const getObjectInfoMock = vi.fn();
const resetObjectInfoCacheMock = vi.fn();
const backfillObjectInfoMock = vi.fn(async (info: unknown) => info);
vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: (...a: unknown[]) => getObjectInfoMock(...a),
  resetObjectInfoCache: (...a: unknown[]) => resetObjectInfoCacheMock(...a),
  backfillObjectInfo: (...a: unknown[]) => backfillObjectInfoMock(...a),
}));

import { registerWorkflowComposeTools, summarizeNodeDef } from "../../tools/workflow-compose.js";
import type { ComfyUINodeDef } from "../../comfyui/types.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function getHandler(name: string): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (n: string, _d: string, _s: unknown, h: ToolHandler) => {
      if (n === name) handler = h;
    },
  };
  registerWorkflowComposeTools(server as never);
  if (!handler) throw new Error(`tool ${name} not registered`);
  return handler;
}

// A Loader-style node: the checkpoint dropdown enumerates many model filenames.
const modelList = Array.from({ length: 300 }, (_, i) => `model-${i}.safetensors`);
const loaderDef: ComfyUINodeDef = {
  input: {
    required: {
      ckpt_name: [modelList, { tooltip: "checkpoint to load" }],
    },
    optional: {
      strength: ["FLOAT", { default: 1.0, min: 0, max: 2 }],
    },
  },
  output: ["MODEL", "CLIP", "VAE"],
  output_is_list: [false, false, false],
  output_name: ["MODEL", "CLIP", "VAE"],
  name: "CheckpointLoaderSimple",
  display_name: "Load Checkpoint",
  description: "Loads a checkpoint",
  category: "loaders",
  output_node: false,
};

beforeEach(() => {
  getObjectInfoMock.mockReset();
  resetObjectInfoCacheMock.mockReset();
  backfillObjectInfoMock.mockClear();
  getObjectInfoMock.mockResolvedValue({ CheckpointLoaderSimple: loaderDef });
});

describe("get_node_info default (structural summary)", () => {
  it("collapses enum dropdowns to a value count and omits the values", async () => {
    const handler = getHandler("get_node_info");
    const res = await handler({ node_type: "CheckpointLoader" });
    const text = res.content[0].text;

    expect(text).toContain('"enum(300 values)"');
    // No individual dropdown value may leak into the summary.
    expect(text).not.toContain("model-0.safetensors");
    expect(text).not.toContain("model-299.safetensors");

    const parsed = JSON.parse(text);
    expect(parsed.count).toBe(1);
    const node = parsed.nodes[0];
    expect(node.name).toBe("CheckpointLoaderSimple");
    expect(node.input_required).toEqual({ ckpt_name: "enum(300 values)" });
    expect(node.input_optional).toEqual({ strength: "FLOAT" });
    expect(node.output_types).toEqual(["MODEL", "CLIP", "VAE"]);
    expect(node.output_names).toEqual(["MODEL", "CLIP", "VAE"]);
    expect(parsed.hint).toMatch(/verbose=true/);
  });

  it("is dramatically smaller than the raw definition for Loader nodes", async () => {
    const handler = getHandler("get_node_info");
    const res = await handler({ node_type: "CheckpointLoader" });
    const rawSize = JSON.stringify({ CheckpointLoaderSimple: loaderDef }).length;
    expect(res.content[0].text.length).toBeLessThan(rawSize / 5);
  });
});

describe("get_node_info verbose=true (full dump)", () => {
  it("returns the complete raw definition including dropdown values", async () => {
    const handler = getHandler("get_node_info");
    const res = await handler({ node_type: "CheckpointLoader", verbose: true });
    const parsed = JSON.parse(res.content[0].text);
    // Pre-summary behavior restored: keyed-by-name raw defs, enum values intact.
    expect(parsed.CheckpointLoaderSimple.input.required.ckpt_name[0]).toEqual(modelList);
  });
});

describe("get_node_info >20 matches (unchanged name-list behavior)", () => {
  it("returns the summarized name list and narrowing hint", async () => {
    const many: Record<string, ComfyUINodeDef> = {};
    for (let i = 0; i < 25; i++) {
      many[`Node${i}`] = { ...loaderDef, name: `Node${i}` };
    }
    getObjectInfoMock.mockResolvedValue(many);
    const handler = getHandler("get_node_info");
    const res = await handler({});
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.count).toBe(25);
    expect(parsed.nodes[0]).not.toHaveProperty("input_required");
    expect(parsed.hint).toMatch(/more specific/);
  });
});

describe("get_node_info refresh after external restart (issue #499)", () => {
  // A loader whose model dropdown is served from a STALE cache after the ComfyUI
  // server was restarted externally (systemd) and a new model file was added.
  // The stale snapshot omits the freshly-installed file; refresh:true must drop
  // the cache and refetch so the new file shows up in the verbose dropdown.
  const staleDef: ComfyUINodeDef = {
    ...loaderDef,
    input: { required: { clip_name: [["old-clip.gguf"]] } },
  };
  const freshDef: ComfyUINodeDef = {
    ...loaderDef,
    input: { required: { clip_name: [["old-clip.gguf", "Qwen2.5-VL-7B-Instruct-UD-Q8_0.gguf"]] } },
  };

  it("does NOT reset the cache when refresh is omitted (serves memoized snapshot)", async () => {
    getObjectInfoMock.mockResolvedValue({ CLIPLoaderGGUF: staleDef });
    const handler = getHandler("get_node_info");
    const res = await handler({ node_type: "CLIPLoaderGGUF", verbose: true });
    expect(resetObjectInfoCacheMock).not.toHaveBeenCalled();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.CLIPLoaderGGUF.input.required.clip_name[0]).toEqual(["old-clip.gguf"]);
  });

  it("refresh:true invalidates the cache BEFORE fetching, so the live post-restart dropdown surfaces", async () => {
    // The cache invalidation (resetObjectInfoCache) must happen before the fetch
    // so getObjectInfo re-reads the live server (which now lists the new file).
    // The reset→refetch guarantee itself is covered in object-info-cache.test.ts.
    let resetBeforeFetch = false;
    resetObjectInfoCacheMock.mockImplementation(() => {
      resetBeforeFetch = true;
    });
    getObjectInfoMock.mockImplementation(async () =>
      resetBeforeFetch ? { CLIPLoaderGGUF: freshDef } : { CLIPLoaderGGUF: staleDef },
    );
    const handler = getHandler("get_node_info");
    const res = await handler({ node_type: "CLIPLoaderGGUF", verbose: true, refresh: true });
    expect(resetObjectInfoCacheMock).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.CLIPLoaderGGUF.input.required.clip_name[0]).toContain(
      "Qwen2.5-VL-7B-Instruct-UD-Q8_0.gguf",
    );
  });
});

describe("summarizeNodeDef", () => {
  it("stringifies scalar type tags and handles missing input sections", () => {
    const def: ComfyUINodeDef = {
      ...loaderDef,
      input: {},
    };
    const s = summarizeNodeDef("X", def);
    expect(s.input_required).toEqual({});
    expect(s.input_optional).toEqual({});
  });
});
