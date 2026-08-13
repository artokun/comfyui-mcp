// #1483 — check_runtime called a paid fal.ai node "local … no paid credits".
//
// THE FIXTURES ARE THE REPORT'S OWN NODE, and that is the point of this file. The
// appealing structural fix — "flag anything that takes an api_key input" — was measured
// against the actual pack (`gokayfem/ComfyUI-fal-API`, nodes/image_node.py) and its
// NanoBanana classes take NO credential input: `prompt`, `aspect_ratio`, `num_images`,
// `seed`, and the FAL key comes from the environment. A suite built around a convenient
// fixture would have gone green while the reporter's graph stayed "free".
//
// The other shapes here are the measured population of a real 4304-node /object_info:
// 3464 custom-node classes, 0 of them carrying api_node:true, 220 core partner nodes,
// and 49 classes exposing a credential input.
import { describe, expect, it } from "vitest";
import { checkWorkflowRuntime, isApiNode, isExternalServiceNode } from "../../services/api-nodes.js";
import type { ComfyUINodeDef, ObjectInfo } from "../../comfyui/types.js";

const def = (over: Partial<ComfyUINodeDef>): ComfyUINodeDef =>
  ({
    input: { required: {} },
    output: [],
    name: "n",
    display_name: "n",
    description: "",
    category: "",
    python_module: "nodes",
    ...over,
  }) as ComfyUINodeDef;

/** The reported node, as /object_info actually describes it. No credential input. */
const NANO_BANANA_PRO_FAL = def({
  name: "NanoBananaPro_fal",
  display_name: "Nano Banana Pro (fal)",
  category: "FAL/Image",
  python_module: "custom_nodes.ComfyUI-fal-API",
  input: {
    required: { prompt: ["STRING", {}], aspect_ratio: [["1:1", "16:9"], {}] },
    optional: { num_images: ["INT", {}], seed: ["INT", {}] },
  },
});

/** A local helper shipped INSIDE the same paid pack — flagging it costs a false prompt. */
const FAL_LOCAL_HELPER = def({
  name: "ImageResize_fal",
  category: "FAL/Utils",
  python_module: "custom_nodes.ComfyUI-fal-API",
  input: { required: { image: ["IMAGE", {}] } },
});

/** A paid third-party node from a pack nobody enumerated — caught by the credential input. */
const NOVITA = def({
  name: "NovitaVideoRequestNode",
  category: "utils/video",
  python_module: "custom_nodes.comfyui-utils-nodes",
  input: { required: { prompt: ["STRING", {}] }, optional: { api_key: ["STRING", {}] } },
});

/** An ordinary local third-party node — the 3464-class population that must stay free. */
const IMPACT = def({
  name: "ImpactMakeImageBatch",
  category: "ImpactPack/Util",
  python_module: "custom_nodes.ComfyUI-Impact-Pack",
  input: { required: { image1: ["IMAGE", {}] } },
});

const CORE_SAMPLER = def({ name: "KSampler", category: "sampling", python_module: "nodes" });
const CORE_PREVIEW = def({ name: "PreviewImage", category: "image", python_module: "nodes" });
const CORE_LOAD = def({ name: "LoadImage", category: "image", python_module: "nodes" });
/** A genuine Comfy partner node — must stay in `apiNodes`, not the new list. */
const PARTNER = def({ name: "ClaudeNode", category: "api node/text", api_node: true } as never);

const objectInfo = (entries: Record<string, ComfyUINodeDef>): ObjectInfo =>
  entries as unknown as ObjectInfo;

const runtimeOf = (classTypes: string[], oi: Record<string, ComfyUINodeDef>) =>
  checkWorkflowRuntime(
    Object.fromEntries(classTypes.map((ct, i) => [String(i + 1), { class_type: ct, inputs: {} }])),
    { getObjectInfo: async () => objectInfo(oi), enqueue: async () => ({ prompt_id: "x" }) },
  );

describe("a paid external-service node is never reported as local/free (#1483)", () => {
  it("THE REPORTED GRAPH: NanoBananaPro_fal is no longer local/free", async () => {
    // The exact class_types from the report, and the exact verdict it produced.
    const out = await runtimeOf(
      ["PreviewImage", "NanoBananaPro_fal", "ImpactMakeImageBatch", "LoadImage"],
      {
        PreviewImage: CORE_PREVIEW,
        NanoBananaPro_fal: NANO_BANANA_PRO_FAL,
        ImpactMakeImageBatch: IMPACT,
        LoadImage: CORE_LOAD,
      },
    );

    expect(out.runtime).toBe("mixed");
    expect(out.usesApiNodes).toBe(true);
    expect(out.externalApiNodes).toEqual(["NanoBananaPro_fal"]);
    // It is NOT a Comfy partner node and must not be described as one.
    expect(out.apiNodes).toEqual([]);
    // The report's `unknownNodes: []` was correct and stays correct — the node IS
    // installed. Being known is exactly what made it confidently misclassified before.
    expect(out.unknownNodes).toEqual([]);
  });

  it("the credential-input catch covers a pack nobody enumerated", async () => {
    const out = await runtimeOf(["NovitaVideoRequestNode", "PreviewImage"], {
      NovitaVideoRequestNode: NOVITA,
      PreviewImage: CORE_PREVIEW,
    });
    expect(out.usesApiNodes).toBe(true);
    expect(out.externalApiNodes).toEqual(["NovitaVideoRequestNode"]);
  });

  it("ORDINARY local third-party nodes stay free — the direction that must not regress", async () => {
    // 3464 of 4304 measured classes are custom-node-registered. If this drifts to
    // "possibly paid", every real workflow warns and the warning stops meaning anything.
    const out = await runtimeOf(["KSampler", "ImpactMakeImageBatch", "LoadImage"], {
      KSampler: CORE_SAMPLER,
      ImpactMakeImageBatch: IMPACT,
      LoadImage: CORE_LOAD,
    });
    expect(out.runtime).toBe("local");
    expect(out.usesApiNodes).toBe(false);
    expect(out.externalApiNodes).toBeUndefined();
  });

  it("a paid pack's OWN local helper is not flagged", async () => {
    // FAL/Utils resizes an image before upload and spends nothing. Being shipped next to
    // paid nodes is not evidence about this node.
    expect(isExternalServiceNode(FAL_LOCAL_HELPER)).toBe(false);
    const out = await runtimeOf(["ImageResize_fal", "KSampler"], {
      ImageResize_fal: FAL_LOCAL_HELPER,
      KSampler: CORE_SAMPLER,
    });
    expect(out.runtime).toBe("local");
  });

  it("a Comfy PARTNER node stays in apiNodes and out of the new list", async () => {
    // The two are not merged: `isApiNode` also drives listApiNodes and the 3D picker,
    // which hand out schemas on the assumption of Comfy's own auth model.
    expect(isApiNode(PARTNER)).toBe(true);
    expect(isExternalServiceNode(PARTNER)).toBe(false);
    const out = await runtimeOf(["ClaudeNode"], { ClaudeNode: PARTNER });
    expect(out.apiNodes).toEqual(["ClaudeNode"]);
    expect(out.externalApiNodes).toBeUndefined();
    expect(out.runtime).toBe("api");
  });

  it("an all-external graph reads `api`, not `mixed`", async () => {
    const out = await runtimeOf(["NanoBananaPro_fal"], { NanoBananaPro_fal: NANO_BANANA_PRO_FAL });
    expect(out.runtime).toBe("api");
    expect(out.usesApiNodes).toBe(true);
  });
});
