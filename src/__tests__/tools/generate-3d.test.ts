import { describe, expect, it, vi, beforeEach } from "vitest";

// Provide the config-module exports the api-nodes import graph touches.
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
  generate3d,
  find3dApiNodes,
  is3dApiNode,
} from "../../services/generate-3d.js";
import type { ApiNodesDeps } from "../../services/api-nodes.js";
import type { ComfyUINodeDef, ObjectInfo, WorkflowJSON } from "../../comfyui/types.js";
import { ValidationError } from "../../utils/errors.js";

beforeEach(() => {
  mockConfig.comfyApiKey = undefined;
});

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

/** ObjectInfo mirroring the real partner 3D catalog (Tripo text + image nodes). */
function objectInfoWith3d(): ObjectInfo {
  return {
    TripoTextToModelNode: nodeDef({
      api_node: true,
      category: "partner/3d/Tripo",
      display_name: "Tripo: Text to Model",
      output_node: true,
      output: ["STRING", "MODEL_TASK_ID", "FILE_3D_GLB"],
      output_name: ["model_file", "model task_id", "GLB"],
      input: {
        required: { prompt: ["STRING", { multiline: true }] },
        optional: {
          style: ["COMBO", { default: "None", options: ["None", "gold"] }],
          texture: ["BOOLEAN", { default: true }],
        },
        hidden: { auth_token_comfy_org: ["AUTH_TOKEN_COMFY_ORG"] },
      },
    }),
    TripoImageToModelNode: nodeDef({
      api_node: true,
      category: "partner/3d/Tripo",
      display_name: "Tripo: Image to Model",
      output_node: true,
      output: ["STRING", "MODEL_TASK_ID", "FILE_3D_GLB"],
      output_name: ["model_file", "model task_id", "GLB"],
      input: {
        required: { image: ["IMAGE", {}] },
        optional: { texture: ["BOOLEAN", { default: true }] },
        hidden: { auth_token_comfy_org: ["AUTH_TOKEN_COMFY_ORG"] },
      },
    }),
    // Post-processing 3D node with a non-IMAGE required link — must NOT be picked.
    TripoTextureNode: nodeDef({
      api_node: true,
      category: "partner/3d/Tripo",
      display_name: "Tripo: Texture model",
      output_node: true,
      output: ["STRING", "MODEL_TASK_ID", "FILE_3D_GLB"],
      input: { required: { model_task_id: ["MODEL_TASK_ID", {}] } },
    }),
    // DECOY: 3D-category API node with a prompt but NO FILE_3D output (a
    // utility/plumbing node) — must never be picked as a generation backend.
    Tripo3dTaskStatusNode: nodeDef({
      api_node: true,
      category: "partner/3d/Tripo",
      display_name: "Tripo: Task status",
      output: ["STRING"],
      input: { required: { prompt: ["STRING", {}] } },
    }),
    // Non-3D API node — excluded.
    FluxProImageNode: nodeDef({
      api_node: true,
      category: "api node/image/BFL",
      display_name: "Flux Pro",
      output: ["IMAGE"],
      input: { required: { prompt: ["STRING", {}] } },
    }),
    // Local node — excluded.
    KSampler: nodeDef({ category: "sampling", output: ["LATENT"] }),
  };
}

function objectInfoNo3d(): ObjectInfo {
  return {
    // Category-only 3D decoy (no FILE_3D output) — must NOT count as a backend.
    Some3dUtilityNode: nodeDef({
      api_node: true,
      category: "partner/3d/Acme",
      display_name: "Acme 3D utility",
      output: ["STRING"],
      input: { required: { prompt: ["STRING", {}] } },
    }),
    FluxProImageNode: nodeDef({
      api_node: true,
      category: "api node/image/BFL",
      output: ["IMAGE"],
      input: { required: { prompt: ["STRING", {}] } },
    }),
    KSampler: nodeDef({ category: "sampling", output: ["LATENT"] }),
  };
}

function depsFor(objectInfo: ObjectInfo): {
  deps: ApiNodesDeps;
  enqueued: WorkflowJSON[];
} {
  const enqueued: WorkflowJSON[] = [];
  return {
    enqueued,
    deps: {
      getObjectInfo: async () => objectInfo,
      enqueue: async (workflow) => {
        enqueued.push(workflow);
        return { prompt_id: "p-123", queue_remaining: 1 };
      },
    },
  };
}

describe("3D API-node detection", () => {
  it("classifies partner 3D nodes and filters by mode capability", () => {
    const info = objectInfoWith3d();
    expect(is3dApiNode(info.TripoTextToModelNode)).toBe(true);
    expect(is3dApiNode(info.FluxProImageNode)).toBe(false);
    // Category alone must not qualify — a real FILE_3D output is required.
    expect(is3dApiNode(info.Tripo3dTaskStatusNode)).toBe(false);
    expect(is3dApiNode(info.KSampler)).toBe(false);

    const text = find3dApiNodes(info, "text");
    expect(text.map((c) => c.class_type)).toEqual(["TripoTextToModelNode"]);
    expect(text[0].formats).toEqual(["GLB"]);

    const image = find3dApiNodes(info, "image");
    expect(image.map((c) => c.class_type)).toEqual(["TripoImageToModelNode"]);
    expect(image[0].image_input).toBe("image");
  });
});

describe("generate3d — happy paths", () => {
  it("text mode enqueues a single partner 3D node with the prompt", async () => {
    const { deps, enqueued } = depsFor(objectInfoWith3d());
    const result = await generate3d(
      { mode: "text", prompt: "a bronze dragon statue" },
      deps,
    );

    expect(result.prompt_id).toBe("p-123");
    expect(result.class_type).toBe("TripoTextToModelNode");
    expect(result.formats).toEqual(["GLB"]);
    expect(enqueued).toHaveLength(1);
    const wf = enqueued[0];
    expect(wf["1"].class_type).toBe("TripoTextToModelNode");
    expect(wf["1"].inputs.prompt).toBe("a bronze dragon statue");
    // Output node — no SaveImage should be auto-added.
    expect(Object.keys(wf)).toEqual(["1"]);
  });

  it("image mode wires a LoadImage feeder into the node's IMAGE input", async () => {
    const { deps, enqueued } = depsFor(objectInfoWith3d());
    const result = await generate3d(
      { mode: "image", image: "chair.png", inputs: { texture: false } },
      deps,
    );

    expect(result.class_type).toBe("TripoImageToModelNode");
    const wf = enqueued[0];
    expect(wf["1"].inputs.image).toEqual(["10", 0]);
    expect(wf["1"].inputs.texture).toBe(false);
    expect(wf["10"].class_type).toBe("LoadImage");
    expect(wf["10"].inputs.image).toBe("chair.png");
  });

  it("image mode notes an ignored prompt when the node takes none", async () => {
    const { deps } = depsFor(objectInfoWith3d());
    const result = await generate3d(
      { mode: "image", image: "chair.png", prompt: "make it shiny" },
      deps,
    );
    expect(result.notes.some((n) => /prompt was ignored/i.test(n))).toBe(true);
  });

  it("honors an explicit node override and rejects incapable ones", async () => {
    const { deps } = depsFor(objectInfoWith3d());
    const ok = await generate3d(
      { mode: "text", prompt: "a cube", node: "TripoTextToModelNode" },
      deps,
    );
    expect(ok.class_type).toBe("TripoTextToModelNode");

    await expect(
      generate3d({ mode: "text", prompt: "a cube", node: "TripoTextureNode" }, deps),
    ).rejects.toThrow(/not a text-capable 3D API node/);
  });
});

describe("generate3d — capability detection / errors", () => {
  it("errors honestly + actionably when the server has no 3D API nodes", async () => {
    const { deps, enqueued } = depsFor(objectInfoNo3d());
    const err = await generate3d({ mode: "text", prompt: "a cube" }, deps).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(String(err.message)).toMatch(/No 3D-capable API\/partner nodes/);
    expect(String(err.message)).toMatch(/install_custom_node/);
    expect(String(err.message)).toMatch(/Hunyuan3DWrapper|TripoSR/);
    // Nothing must be enqueued on the failure path.
    expect(enqueued).toHaveLength(0);
  });

  it("validates mode-specific required arguments", async () => {
    const { deps } = depsFor(objectInfoWith3d());
    await expect(generate3d({ mode: "text" }, deps)).rejects.toThrow(
      /requires a non-empty prompt/,
    );
    await expect(generate3d({ mode: "image" }, deps)).rejects.toThrow(
      /requires an input image/,
    );
  });
});
