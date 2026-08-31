import { describe, expect, it, vi, beforeEach } from "vitest";

// Control config.comfyApiKey per test; provide the config-module exports the
// api-nodes import graph touches.
const mockConfig = vi.hoisted(() => ({
  comfyApiKey: undefined as string | undefined,
  comfyuiSsl: false,
  comfyuiHost: "127.0.0.1",
  resolvedPort: 8188,
}));
vi.mock("../../config.js", () => ({
  config: mockConfig,
  getComfyUIApiHost: () => "127.0.0.1:8188",
  getComfyUIProtocol: () => "http",
}));

import {
  listApiNodes,
  getApiNodeSchema,
  generateWithApiNode,
  buildApiNodeInputs,
  isApiNode,
  checkWorkflowRuntime,
  type ApiNodesDeps,
} from "../../services/api-nodes.js";
import type { ObjectInfo, WorkflowJSON, ComfyUINodeDef } from "../../comfyui/types.js";

beforeEach(() => {
  mockConfig.comfyApiKey = undefined;
});

/** Minimal helper to build a node def with sensible defaults. */
function nodeDef(partial: Partial<ComfyUINodeDef>): ComfyUINodeDef {
  return {
    input: {},
    output: [],
    output_is_list: [],
    output_name: [],
    name: "",
    display_name: "",
    description: "",
    category: "",
    output_node: false,
    ...partial,
  };
}

function sampleObjectInfo(): ObjectInfo {
  return {
    // API node flagged via api_node:true AND "api node/" category.
    FluxProImageNode: nodeDef({
      api_node: true,
      category: "api node/image/BFL",
      display_name: "Flux Pro Image",
      description: "Generate an image with BFL Flux Pro.",
      output: ["IMAGE"],
      output_name: ["image"],
      input: {
        required: {
          prompt: ["STRING", { multiline: true }],
          aspect_ratio: [["1:1", "16:9"], { default: "1:1" }],
          seed: ["INT", { default: 0, min: 0, max: 4294967295 }],
        },
        optional: {
          steps: ["INT", { default: 25 }],
        },
        hidden: {
          auth_token_comfy_org: ["AUTH_TOKEN_COMFY_ORG"],
          api_key_comfy_org: ["API_KEY_COMFY_ORG"],
        },
      },
    }),
    // API node detected ONLY via category prefix (older builds without api_node flag).
    KlingVideoNode: nodeDef({
      category: "api node/video/Kling",
      display_name: "Kling Video",
      output: ["VIDEO"],
      input: { required: { prompt: ["STRING", {}] } },
    }),
    // Regular local node — must be excluded.
    KSampler: nodeDef({
      category: "sampling",
      display_name: "KSampler",
      output: ["LATENT"],
    }),
    // Edge case: category mentions "api" but is not the api-node prefix.
    SomeOtherNode: nodeDef({
      category: "utils/api helpers",
      display_name: "API Helpers",
    }),
    // v3 API node with a COMFY_DYNAMICCOMBO_V3 input ("model") that reveals nested
    // inputs — the Nano Banana 2 shape. Selecting the option exposes
    // aspect_ratio/resolution/thinking_level (positional widgets) plus an AUTOGROW
    // image list and an optional files input (neither a positional widget).
    GeminiNanoBanana2V2: nodeDef({
      api_node: true,
      category: "partner/image/Gemini",
      display_name: "Nano Banana 2",
      output: ["IMAGE", "STRING", "IMAGE"],
      output_name: ["IMAGE", "STRING", "thought_image"],
      input: {
        required: {
          prompt: ["STRING", { default: "", multiline: true }],
          model: [
            "COMFY_DYNAMICCOMBO_V3",
            {
              options: [
                {
                  key: "Nano Banana 2 (Gemini 3.1 Flash Image)",
                  inputs: {
                    required: {
                      aspect_ratio: [
                        "COMBO",
                        { default: "auto", options: ["auto", "1:1", "16:9"] },
                      ],
                      resolution: ["COMBO", { options: ["1K", "2K", "4K"] }],
                      thinking_level: ["COMBO", { options: ["MINIMAL", "HIGH"] }],
                      images: [
                        "COMFY_AUTOGROW_V3",
                        { template: { names: ["image_1"] }, min: 0 },
                      ],
                    },
                    optional: {
                      files: ["GEMINI_INPUT_FILES", {}],
                    },
                  },
                },
              ],
            },
          ],
          seed: ["INT", { default: 42, control_after_generate: true }],
          response_modalities: ["COMBO", { options: ["IMAGE", "IMAGE+TEXT"] }],
        },
        optional: {
          system_prompt: ["STRING", { default: "sys", multiline: true }],
        },
        hidden: {
          auth_token_comfy_org: ["AUTH_TOKEN_COMFY_ORG"],
          api_key_comfy_org: ["API_KEY_COMFY_ORG"],
        },
      },
    }),
    // Core output node, as every real ComfyUI registers it. generate picks its
    // auto-added sink out of /object_info, so the fixture has to carry the sinks
    // a real server would offer. Deliberately NO SaveVideo/SaveAudio* here: that
    // is the older-server shape, and it keeps the "no registered sink" fallback
    // exercised by the KlingVideoNode (VIDEO) case below.
    SaveImage: nodeDef({
      category: "image",
      display_name: "Save Image",
      output_node: true,
      input: {
        required: {
          images: ["IMAGE", {}],
          filename_prefix: ["STRING", { default: "ComfyUI" }],
        },
      },
    }),
  };
}

function makeDeps(
  overrides: Partial<ApiNodesDeps> = {},
): { deps: ApiNodesDeps; enqueued: Array<{ wf: WorkflowJSON; opts?: unknown }> } {
  const enqueued: Array<{ wf: WorkflowJSON; opts?: unknown }> = [];
  const deps: ApiNodesDeps = {
    getObjectInfo: async () => sampleObjectInfo(),
    enqueue: async (wf, opts) => {
      enqueued.push({ wf, opts });
      return { prompt_id: "pid-123", queue_remaining: 2 };
    },
    ...overrides,
  };
  return { deps, enqueued };
}

describe("isApiNode", () => {
  it("matches api_node:true flag", () => {
    expect(isApiNode(nodeDef({ api_node: true, category: "whatever" }))).toBe(true);
  });
  it("matches 'api node/' category prefix (case-insensitive)", () => {
    expect(isApiNode(nodeDef({ category: "API node/Image/BFL" }))).toBe(true);
    expect(isApiNode(nodeDef({ category: "api node" }))).toBe(true);
  });
  it("does not match unrelated categories that merely contain 'api'", () => {
    expect(isApiNode(nodeDef({ category: "utils/api helpers" }))).toBe(false);
    expect(isApiNode(nodeDef({ category: "sampling" }))).toBe(false);
  });
});

describe("listApiNodes", () => {
  it("returns only API nodes, sorted by class_type", async () => {
    const { deps } = makeDeps();
    const nodes = await listApiNodes(undefined, deps);
    expect(nodes.map((n) => n.class_type)).toEqual([
      "FluxProImageNode",
      "GeminiNanoBanana2V2",
      "KlingVideoNode",
    ]);
    expect(nodes.find((n) => n.class_type === "KSampler")).toBeUndefined();
    expect(nodes.find((n) => n.class_type === "SomeOtherNode")).toBeUndefined();
  });

  it("includes summary metadata", async () => {
    const { deps } = makeDeps();
    const nodes = await listApiNodes(undefined, deps);
    const flux = nodes.find((n) => n.class_type === "FluxProImageNode")!;
    expect(flux.display_name).toBe("Flux Pro Image");
    expect(flux.category).toBe("api node/image/BFL");
    expect(flux.output).toEqual(["IMAGE"]);
  });

  it("filters case-insensitively across class_type/display/category", async () => {
    const { deps } = makeDeps();
    expect((await listApiNodes("video", deps)).map((n) => n.class_type)).toEqual([
      "KlingVideoNode",
    ]);
    expect((await listApiNodes("BFL", deps)).map((n) => n.class_type)).toEqual([
      "FluxProImageNode",
    ]);
    expect((await listApiNodes("kling", deps)).map((n) => n.class_type)).toEqual([
      "KlingVideoNode",
    ]);
  });

  it("returns an empty list when no API nodes are present", async () => {
    const { deps } = makeDeps({
      getObjectInfo: async () => ({ KSampler: nodeDef({ category: "sampling" }) }),
    });
    expect(await listApiNodes(undefined, deps)).toEqual([]);
  });
});

describe("checkWorkflowRuntime", () => {
  // A graph whose custom nodes aren't in this server's /object_info.
  const graphWithUninstalledNodes = {
    "1": { class_type: "QwenImageEditLoader", inputs: {} },
    "2": { class_type: "QwenImageSampler", inputs: {} },
    "3": { class_type: "SaveImage", inputs: {} },
  } as unknown as WorkflowJSON;

  // Server only knows the core SaveImage node; the two Qwen nodes are absent.
  const partialObjectInfo = async () => ({ SaveImage: nodeDef({ category: "image" }) });

  it("returns 'unknown' for an arbitrary graph with unclassifiable nodes", async () => {
    const { deps } = makeDeps({ getObjectInfo: partialObjectInfo });
    const rt = await checkWorkflowRuntime(graphWithUninstalledNodes, deps);
    expect(rt.runtime).toBe("unknown");
    expect(rt.usesApiNodes).toBeNull();
    expect(rt.unknownNodes).toEqual(
      expect.arrayContaining(["QwenImageEditLoader", "QwenImageSampler"]),
    );
  });

  // Regression for #464: a BUNDLED pack is guaranteed local/free, so uninstalled
  // custom nodes must not collapse the verdict to "unknown" and wrongly demand a
  // paid-credits confirmation.
  it("trusts a bundled pack as local even when its custom nodes aren't installed (#464)", async () => {
    const { deps } = makeDeps({ getObjectInfo: partialObjectInfo });
    const rt = await checkWorkflowRuntime(graphWithUninstalledNodes, deps, {
      bundledLocalPack: true,
    });
    expect(rt.runtime).toBe("local");
    expect(rt.usesApiNodes).toBe(false);
    // The unclassifiable nodes are still surfaced for transparency.
    expect(rt.unknownNodes).toEqual(
      expect.arrayContaining(["QwenImageEditLoader", "QwenImageSampler"]),
    );
  });

  it("still reports API nodes in a bundled pack rather than masking them as local", async () => {
    const graph = {
      "1": { class_type: "FluxProImageNode", inputs: {} },
      "2": { class_type: "QwenImageSampler", inputs: {} },
    } as unknown as WorkflowJSON;
    const { deps } = makeDeps(); // sampleObjectInfo knows FluxProImageNode as an API node
    const rt = await checkWorkflowRuntime(graph, deps, { bundledLocalPack: true });
    expect(rt.usesApiNodes).toBe(true);
    expect(rt.apiNodes).toContain("FluxProImageNode");
    expect(["api", "mixed"]).toContain(rt.runtime);
  });
});

describe("getApiNodeSchema", () => {
  it("extracts required + optional inputs with types and config", async () => {
    const { deps } = makeDeps();
    const schema = await getApiNodeSchema("FluxProImageNode", deps);

    expect(schema.is_api_node).toBe(true);
    expect(schema.output).toEqual(["IMAGE"]);

    const byName = Object.fromEntries(schema.inputs.map((i) => [i.name, i]));
    expect(byName.prompt.required).toBe(true);
    expect(byName.prompt.type).toBe("STRING");
    expect(byName.aspect_ratio.type).toEqual(["1:1", "16:9"]);
    expect(byName.aspect_ratio.config).toEqual({ default: "1:1" });
    expect(byName.steps.required).toBe(false);
    expect(byName.seed.config).toMatchObject({ min: 0, max: 4294967295 });
  });

  it("exposes hidden auth inputs separately from visible inputs", async () => {
    const { deps } = makeDeps();
    const schema = await getApiNodeSchema("FluxProImageNode", deps);
    expect(schema.hidden_inputs).toEqual(["auth_token_comfy_org", "api_key_comfy_org"]);
    expect(schema.inputs.map((i) => i.name)).not.toContain("auth_token_comfy_org");
  });

  it("throws a clear error for unknown nodes", async () => {
    const { deps } = makeDeps();
    await expect(getApiNodeSchema("DoesNotExist", deps)).rejects.toThrow(/was not found/i);
  });

  it("throws when the node exists but is not an API node", async () => {
    const { deps } = makeDeps();
    await expect(getApiNodeSchema("KSampler", deps)).rejects.toThrow(/not an API\/partner node/i);
  });
});

describe("generateWithApiNode", () => {
  it("builds the API-node workflow and wires a SaveImage output node", async () => {
    const { deps, enqueued } = makeDeps();
    const result = await generateWithApiNode(
      { class_type: "FluxProImageNode", inputs: { prompt: "a cat", aspect_ratio: "16:9" } },
      deps,
    );

    expect(result.prompt_id).toBe("pid-123");
    expect(result.queue_remaining).toBe(2);
    expect(enqueued).toHaveLength(1);

    const wf = enqueued[0].wf;
    expect(wf["1"].class_type).toBe("FluxProImageNode");
    // seed (required INT, default 0) is auto-filled; prompt + aspect_ratio as given.
    expect(wf["1"].inputs).toEqual({ prompt: "a cat", aspect_ratio: "16:9", seed: 0 });
    expect(wf["1"]._meta?.title).toBe("Flux Pro Image");
    // FluxProImageNode outputs IMAGE but is not itself an output node, so a
    // SaveImage is wired to its IMAGE output (index 0) — without a terminal
    // output node ComfyUI rejects the prompt with "prompt_no_outputs".
    expect(wf["2"].class_type).toBe("SaveImage");
    expect(wf["2"].inputs.images).toEqual(["1", 0]);
    expect(result.notes.some((n) => /SaveImage output node/i.test(n))).toBe(true);
  });

  it("strips hidden auth inputs the caller mistakenly supplied", async () => {
    const { deps, enqueued } = makeDeps();
    const result = await generateWithApiNode(
      {
        class_type: "FluxProImageNode",
        inputs: { prompt: "x", aspect_ratio: "1:1", seed: 1, auth_token_comfy_org: "leaked" },
      },
      deps,
    );
    expect(enqueued[0].wf["1"].inputs).not.toHaveProperty("auth_token_comfy_org");
    expect(result.notes.some((n) => /hidden input/i.test(n))).toBe(true);
  });

  it("fills omitted required widget inputs from their schema defaults", async () => {
    const { deps, enqueued } = makeDeps();
    const result = await generateWithApiNode(
      { class_type: "FluxProImageNode", inputs: { prompt: "x" } },
      deps,
    );
    expect(enqueued).toHaveLength(1);
    // aspect_ratio (combo default "1:1") and seed (INT default 0) are auto-filled,
    // so they are NOT reported as missing — only inputs with no determinable
    // default would be.
    expect(enqueued[0].wf["1"].inputs).toMatchObject({
      prompt: "x",
      aspect_ratio: "1:1",
      seed: 0,
    });
    expect(result.notes.some((n) => /Missing required input/i.test(n))).toBe(false);
  });

  it("notes a required input that has no determinable default", async () => {
    const { deps, enqueued } = makeDeps();
    // prompt is a STRING with no default — omitting it leaves it genuinely missing.
    const result = await generateWithApiNode(
      { class_type: "FluxProImageNode", inputs: { aspect_ratio: "1:1" } },
      deps,
    );
    expect(enqueued).toHaveLength(1);
    expect(result.notes.some((n) => /Missing required input/i.test(n))).toBe(true);
    expect(result.notes.some((n) => /prompt/.test(n))).toBe(true);
  });

  it("notes unknown inputs but passes them through", async () => {
    const { deps, enqueued } = makeDeps();
    const result = await generateWithApiNode(
      { class_type: "FluxProImageNode", inputs: { prompt: "x", aspect_ratio: "1:1", seed: 0, bogus: 1 } },
      deps,
    );
    expect(enqueued[0].wf["1"].inputs).toHaveProperty("bogus", 1);
    expect(result.notes.some((n) => /Unknown input "bogus"/.test(n))).toBe(true);
  });

  it("notes the COMFY_API_KEY auth situation", async () => {
    const { deps } = makeDeps();
    const result = await generateWithApiNode(
      { class_type: "FluxProImageNode", inputs: { prompt: "x", aspect_ratio: "1:1", seed: 0 } },
      deps,
    );
    expect(result.notes.some((n) => /COMFY_API_KEY/.test(n))).toBe(true);
  });

  it("passes COMFY_API_KEY to the server via extra_data.api_key_comfy_org", async () => {
    mockConfig.comfyApiKey = "ck-secret";
    const { deps, enqueued } = makeDeps();
    await generateWithApiNode(
      { class_type: "FluxProImageNode", inputs: { prompt: "x", aspect_ratio: "1:1", seed: 0 } },
      deps,
    );
    const opts = enqueued[0].opts as { extra_data?: Record<string, unknown> };
    expect(opts.extra_data).toEqual({ api_key_comfy_org: "ck-secret" });
  });

  it("omits extra_data when no COMFY_API_KEY is configured", async () => {
    const { deps, enqueued } = makeDeps();
    await generateWithApiNode(
      { class_type: "FluxProImageNode", inputs: { prompt: "x", aspect_ratio: "1:1", seed: 0 } },
      deps,
    );
    const opts = enqueued[0].opts as { extra_data?: unknown };
    expect(opts.extra_data).toBeUndefined();
  });

  it("does not add a SaveImage when the API node is itself an output node", async () => {
    const outputApiNode = nodeDef({
      api_node: true,
      category: "api node/image/Save",
      display_name: "Save To Cloud",
      output: [],
      output_node: true,
      input: { required: { images: ["IMAGE", {}] } },
    });
    const { deps, enqueued } = makeDeps({
      getObjectInfo: async () => ({ SaveToCloudNode: outputApiNode }),
    });
    const result = await generateWithApiNode(
      { class_type: "SaveToCloudNode", inputs: {} },
      deps,
    );
    expect(Object.keys(enqueued[0].wf)).toEqual(["1"]);
    expect(result.notes.some((n) => /SaveImage/.test(n))).toBe(false);
  });

  it("warns when the server registers no output node for the declared type", async () => {
    // KlingVideoNode returns VIDEO; sampleObjectInfo deliberately has no
    // SaveVideo (the older-server shape), so there is nothing to wire.
    const { deps, enqueued } = makeDeps();
    const result = await generateWithApiNode(
      { class_type: "KlingVideoNode", inputs: { prompt: "x" } },
      deps,
    );
    expect(Object.keys(enqueued[0].wf)).toEqual(["1"]);
    expect(result.notes.some((n) => /prompt_no_outputs/.test(n))).toBe(true);
    // The note names the type we could not terminate, so the caller knows what
    // to wire via extra_nodes.
    expect(result.notes.some((n) => /returns VIDEO/.test(n))).toBe(true);
  });

  // ── #2686 — terminal output sinks beyond IMAGE ─────────────────────────────
  //
  // generate only ever wired a SaveImage, so every API node returning something
  // else shipped a prompt with no output node and ComfyUI 400d it with
  // "prompt_no_outputs". On ComfyUI 0.33 that is 173 of the 241 non-output API
  // nodes (VIDEO 112, STRING ~25, AUDIO 10, SVG 5).

  /** Core sinks, shaped as ComfyUI 0.33 /object_info reports them. */
  const SAVE_AUDIO_ADVANCED = nodeDef({
    category: "audio",
    display_name: "Save Audio (Advanced)",
    output_node: true,
    input: {
      required: {
        audio: ["AUDIO", {}],
        filename_prefix: ["STRING", { default: "audio/ComfyUI" }],
        format: [
          "COMFY_DYNAMICCOMBO_V3",
          {
            options: [
              { key: "flac", inputs: { required: {} } },
              {
                key: "mp3",
                inputs: {
                  required: {
                    quality: ["COMBO", { options: ["V0", "128k", "320k"], default: "V0" }],
                  },
                },
              },
            ],
          },
        ],
      },
    },
  });

  /** The deprecated-but-still-registered FLAC saver older builds ship. */
  const SAVE_AUDIO_LEGACY = nodeDef({
    category: "audio",
    display_name: "Save Audio (FLAC)",
    output_node: true,
    input: {
      required: {
        audio: ["AUDIO", {}],
        filename_prefix: ["STRING", { default: "audio/ComfyUI" }],
      },
    },
  });

  const SAVE_VIDEO = nodeDef({
    category: "video",
    display_name: "Save Video",
    output_node: true,
    input: {
      required: {
        video: ["VIDEO", {}],
        filename_prefix: ["STRING", { default: "video/ComfyUI" }],
        format: [
          "COMFY_DYNAMICCOMBO_V3",
          {
            options: [
              {
                key: "auto",
                inputs: {
                  required: { codec: ["COMBO", { options: ["auto", "h264", "av1"] }] },
                },
              },
              {
                key: "webm",
                inputs: { required: { codec: ["COMBO", { options: ["auto", "av1"] }] } },
              },
            ],
          },
        ],
      },
    },
  });

  const SAVE_TEXT = nodeDef({
    category: "text",
    display_name: "Save Text",
    output_node: true,
    input: {
      required: {
        text: ["STRING", { forceInput: true }],
        filename_prefix: ["STRING", { default: "ComfyUI" }],
        format: ["COMBO", { options: ["txt", "csv", "md", "json"], default: "txt" }],
      },
    },
  });

  /** The node from the report: AUDIO out, not itself an OUTPUT_NODE. */
  const BYTEDANCE_SEED_AUDIO = nodeDef({
    api_node: true,
    category: "partner/audio/ByteDance",
    display_name: "ByteDance Seed Audio 1.0",
    output: ["AUDIO"],
    output_name: ["audio"],
    input: { required: { text_prompt: ["STRING", { default: "", multiline: true }] } },
  });

  /** A node returning ("STRING", "VIDEO") — the 13-node Kling-style shape. */
  const VIDEO_AND_TEXT = nodeDef({
    api_node: true,
    category: "api node/video/Kling",
    display_name: "Kling With Text",
    output: ["STRING", "VIDEO"],
    output_name: ["response", "video"],
    input: { required: { prompt: ["STRING", {}] } },
  });

  it("wires an audio sink for an AUDIO-returning API node (the #2686 repro)", async () => {
    const { deps, enqueued } = makeDeps({
      getObjectInfo: async () => ({
        ByteDanceSeedAudio: BYTEDANCE_SEED_AUDIO,
        SaveAudioAdvanced: SAVE_AUDIO_ADVANCED,
      }),
    });
    const result = await generateWithApiNode(
      { class_type: "ByteDanceSeedAudio", inputs: { text_prompt: "hello" } },
      deps,
    );

    const wf = enqueued[0].wf;
    expect(wf["2"].class_type).toBe("SaveAudioAdvanced");
    expect(wf["2"].inputs.audio).toEqual(["1", 0]);
    expect(wf["2"].inputs.filename_prefix).toBe("audio/ComfyUI");
    // The graph now HAS a terminal output node, which is the whole point: a
    // prompt without one is what ComfyUI rejected with prompt_no_outputs.
    expect(result.notes.some((n) => /prompt_no_outputs/.test(n))).toBe(false);
    expect(result.notes.some((n) => /SaveAudioAdvanced output node/.test(n))).toBe(true);
  });

  it("fills the sink's own required dynamic combo in the dotted server form", async () => {
    // SaveVideo's `format` is a REQUIRED v3 dynamic combo. Sending only the link
    // + filename_prefix would 400 with required_input_missing, so the sink's own
    // widgets are resolved from its /object_info entry.
    const { deps, enqueued } = makeDeps({
      getObjectInfo: async () => ({
        KlingVideoNode: sampleObjectInfo().KlingVideoNode,
        SaveVideo: SAVE_VIDEO,
      }),
    });
    await generateWithApiNode({ class_type: "KlingVideoNode", inputs: { prompt: "x" } }, deps);

    const sink = enqueued[0].wf["2"];
    expect(sink.class_type).toBe("SaveVideo");
    expect(sink.inputs).toEqual({
      video: ["1", 0],
      filename_prefix: "video/ComfyUI",
      format: "auto",
      "format.codec": "auto",
    });
  });

  it("falls back to a sink the server actually registers", async () => {
    // An older ComfyUI has no SaveAudioAdvanced. Naming it anyway would swap a
    // "no outputs" 400 for a "node type not found" 400 — no better.
    const { deps, enqueued } = makeDeps({
      getObjectInfo: async () => ({
        ByteDanceSeedAudio: BYTEDANCE_SEED_AUDIO,
        SaveAudio: SAVE_AUDIO_LEGACY,
      }),
    });
    await generateWithApiNode(
      { class_type: "ByteDanceSeedAudio", inputs: { text_prompt: "hello" } },
      deps,
    );

    const sink = enqueued[0].wf["2"];
    expect(sink.class_type).toBe("SaveAudio");
    expect(sink.inputs).toEqual({ audio: ["1", 0], filename_prefix: "audio/ComfyUI" });
  });

  it("prefers the media output over a sibling STRING output", async () => {
    const { deps, enqueued } = makeDeps({
      getObjectInfo: async () => ({
        KlingWithText: VIDEO_AND_TEXT,
        SaveVideo: SAVE_VIDEO,
        SaveText: SAVE_TEXT,
      }),
    });
    await generateWithApiNode({ class_type: "KlingWithText", inputs: { prompt: "x" } }, deps);

    const sink = enqueued[0].wf["2"];
    expect(sink.class_type).toBe("SaveVideo");
    // Wired to slot 1 — the VIDEO output's real index, not a hardcoded 0.
    expect(sink.inputs.video).toEqual(["1", 1]);
  });

  it("falls through to another declared type when the preferred sink is absent", async () => {
    // Same node, but this server has no SaveVideo. The STRING output can still
    // terminate the graph, so the run happens instead of being rejected.
    const { deps, enqueued } = makeDeps({
      getObjectInfo: async () => ({ KlingWithText: VIDEO_AND_TEXT, SaveText: SAVE_TEXT }),
    });
    await generateWithApiNode({ class_type: "KlingWithText", inputs: { prompt: "x" } }, deps);

    const sink = enqueued[0].wf["2"];
    expect(sink.class_type).toBe("SaveText");
    expect(sink.inputs).toEqual({
      text: ["1", 0],
      filename_prefix: "ComfyUI",
      format: "txt", // required COMBO filled from its schema default
    });
  });

  it("wires SaveGLB for a 3D API node, preferring the model over its STRING", async () => {
    // The ('FILE_3D_GLB', 'STRING') shape services/generate-3d.ts drives behind
    // generate_image (action:"3d"). SaveGLB's `mesh` is a MultiType covering the
    // whole File3D family, so one sink serves them all.
    const model3d = nodeDef({
      api_node: true,
      category: "api node/3d/Tripo",
      display_name: "Tripo Model",
      output: ["FILE_3D_GLB", "STRING"],
      output_name: ["model_file", "task_id"],
      input: { required: { prompt: ["STRING", {}] } },
    });
    const saveGlb = nodeDef({
      category: "3d",
      display_name: "Save 3D Model",
      output_node: true,
      input: {
        required: {
          mesh: ["MESH", {}],
          filename_prefix: ["STRING", { default: "3d/ComfyUI" }],
        },
      },
    });
    const { deps, enqueued } = makeDeps({
      getObjectInfo: async () => ({ TripoModel: model3d, SaveGLB: saveGlb, SaveText: SAVE_TEXT }),
    });
    await generateWithApiNode({ class_type: "TripoModel", inputs: { prompt: "a chair" } }, deps);

    const sink = enqueued[0].wf["2"];
    expect(sink.class_type).toBe("SaveGLB");
    expect(sink.inputs).toEqual({ mesh: ["1", 0], filename_prefix: "3d/ComfyUI" });
  });

  it("forwards disable_random_seed to enqueue", async () => {
    const enqueue = vi.fn(async () => ({ prompt_id: "p", queue_remaining: 0 }));
    const { deps } = makeDeps({ enqueue });
    await generateWithApiNode(
      { class_type: "KlingVideoNode", inputs: { prompt: "x" }, disable_random_seed: true },
      deps,
    );
    expect(enqueue).toHaveBeenCalledWith(expect.any(Object), { disable_random_seed: true });
  });

  it("rejects when the target node is not an API node", async () => {
    const { deps, enqueued } = makeDeps();
    await expect(
      generateWithApiNode({ class_type: "KSampler", inputs: {} }, deps),
    ).rejects.toThrow(/not an API\/partner node/i);
    expect(enqueued).toHaveLength(0);
  });

  // ── v3 dynamic-combo (dotted widget) serialization ────────────────────────
  // ComfyUI rejects (HTTP 400 "required_input_missing: model.resolution") a flat
  // form; the canvas serializes the revealed widgets as dotted `model.<nested>`
  // keys. These prove our builder emits the dotted form the server accepts.

  it("serializes v3 dynamic-combo nested inputs into dotted model.* keys", async () => {
    const { deps, enqueued } = makeDeps();
    await generateWithApiNode(
      {
        class_type: "GeminiNanoBanana2V2",
        inputs: {
          prompt: "a red cube",
          model: "Nano Banana 2 (Gemini 3.1 Flash Image)",
          aspect_ratio: "16:9",
          resolution: "2K",
          thinking_level: "HIGH",
          seed: 7,
          response_modalities: "IMAGE",
        },
        disable_random_seed: true,
      },
      deps,
    );
    const inputs = enqueued[0].wf["1"].inputs;
    expect(inputs).toMatchObject({
      prompt: "a red cube",
      model: "Nano Banana 2 (Gemini 3.1 Flash Image)",
      "model.aspect_ratio": "16:9",
      "model.resolution": "2K",
      "model.thinking_level": "HIGH",
      seed: 7,
      response_modalities: "IMAGE",
    });
    // The flat nested keys must NOT survive — the server ignores them.
    expect(inputs).not.toHaveProperty("aspect_ratio");
    expect(inputs).not.toHaveProperty("resolution");
    expect(inputs).not.toHaveProperty("thinking_level");
    // AUTOGROW image list / optional files are not positional widgets → omitted.
    expect(inputs).not.toHaveProperty("model.images");
    expect(inputs).not.toHaveProperty("model.files");
  });

  it("accepts already-dotted nested keys as-is", async () => {
    const { deps, enqueued } = makeDeps();
    await generateWithApiNode(
      {
        class_type: "GeminiNanoBanana2V2",
        inputs: {
          prompt: "x",
          "model.aspect_ratio": "1:1",
          "model.resolution": "4K",
          "model.thinking_level": "MINIMAL",
          seed: 1,
          response_modalities: "IMAGE",
        },
        disable_random_seed: true,
      },
      deps,
    );
    expect(enqueued[0].wf["1"].inputs).toMatchObject({
      "model.aspect_ratio": "1:1",
      "model.resolution": "4K",
      "model.thinking_level": "MINIMAL",
    });
  });

  it("fills omitted required nested combo inputs from their defaults", async () => {
    const { deps, enqueued } = makeDeps();
    await generateWithApiNode(
      {
        class_type: "GeminiNanoBanana2V2",
        inputs: { prompt: "x", response_modalities: "IMAGE" },
        disable_random_seed: true,
      },
      deps,
    );
    const inputs = enqueued[0].wf["1"].inputs;
    expect(inputs).toMatchObject({
      model: "Nano Banana 2 (Gemini 3.1 Flash Image)", // default option key
      "model.aspect_ratio": "auto", // combo default
      "model.resolution": "1K", // first option (no default)
      "model.thinking_level": "MINIMAL", // first option (no default)
      seed: 42, // top-level INT default
    });
  });

  it("does not flag dotted/flat nested combo inputs as unknown", async () => {
    const { deps } = makeDeps();
    const result = await generateWithApiNode(
      {
        class_type: "GeminiNanoBanana2V2",
        inputs: {
          prompt: "x",
          aspect_ratio: "1:1",
          "model.resolution": "1K",
          response_modalities: "IMAGE",
        },
        disable_random_seed: true,
      },
      deps,
    );
    expect(result.notes.some((n) => /Unknown input/.test(n))).toBe(false);
  });
});

describe("buildApiNodeInputs (v3 dynamic-combo serialization)", () => {
  it("emits the dotted model.* form and drops the flat nested keys", async () => {
    const { deps } = makeDeps();
    const schema = await getApiNodeSchema("GeminiNanoBanana2V2", deps);
    const { inputs, consumed } = buildApiNodeInputs(schema, {
      prompt: "hello",
      model: "Nano Banana 2 (Gemini 3.1 Flash Image)",
      aspect_ratio: "16:9",
      resolution: "2K",
      thinking_level: "HIGH",
      seed: 3,
      response_modalities: "IMAGE+TEXT",
    });
    expect(inputs).toEqual({
      prompt: "hello",
      model: "Nano Banana 2 (Gemini 3.1 Flash Image)",
      "model.aspect_ratio": "16:9",
      "model.resolution": "2K",
      "model.thinking_level": "HIGH",
      seed: 3,
      response_modalities: "IMAGE+TEXT",
    });
    // The flat nested keys were absorbed by the combo expansion.
    expect(consumed.has("aspect_ratio")).toBe(true);
    expect(consumed.has("resolution")).toBe(true);
    expect(consumed.has("thinking_level")).toBe(true);
  });

  it("supports a nested object for the combo input", async () => {
    const { deps } = makeDeps();
    const schema = await getApiNodeSchema("GeminiNanoBanana2V2", deps);
    const { inputs } = buildApiNodeInputs(schema, {
      prompt: "hello",
      model: {
        key: "Nano Banana 2 (Gemini 3.1 Flash Image)",
        aspect_ratio: "1:1",
        resolution: "4K",
        thinking_level: "HIGH",
      },
      response_modalities: "IMAGE",
    });
    expect(inputs).toMatchObject({
      model: "Nano Banana 2 (Gemini 3.1 Flash Image)",
      "model.aspect_ratio": "1:1",
      "model.resolution": "4K",
      "model.thinking_level": "HIGH",
    });
  });

  it("drops hidden auth inputs", async () => {
    const { deps } = makeDeps();
    const schema = await getApiNodeSchema("GeminiNanoBanana2V2", deps);
    const { inputs } = buildApiNodeInputs(schema, {
      prompt: "x",
      response_modalities: "IMAGE",
      api_key_comfy_org: "leaked",
    });
    expect(inputs).not.toHaveProperty("api_key_comfy_org");
  });
});
