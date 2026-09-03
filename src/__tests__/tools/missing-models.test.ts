// #796 — the missing-model resolver (download_model action:"resolve_missing")
// folded a FAILED provider lookup into an empty
// result and then asserted "No candidates found on CivitAI or HuggingFace —
// try a different query": "could not look" narrated as "nothing exists",
// with advice that blames the query. The message must state the failure.

import { beforeEach, describe, expect, it, vi } from "vitest";

const objectInfo = vi.hoisted(() => ({
  current: {
    CheckpointLoaderSimple: {
      input: { required: { ckpt_name: [["already-have.safetensors"], {}] } },
    },
  } as Record<string, unknown>,
}));

const DEFAULT_OBJECT_INFO = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [["already-have.safetensors"], {}] } },
  },
};

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: async () => objectInfo.current,
  getSystemStats: async () => ({ devices: [{ vram_total: 16 * 1024 ** 3 }] }),
}));

const providers = vi.hoisted(() => ({ civitaiDown: true, hfDown: true }));
vi.mock("../../services/civitai-resolver.js", () => ({
  searchCivitaiModels: async () => {
    if (providers.civitaiDown) throw new Error("civitai 503");
    return { hits: [] };
  },
}));
vi.mock("../../services/model-resolver.js", () => ({
  searchHuggingFaceModels: async () => {
    if (providers.hfDown) throw new Error("hf timeout");
    return [];
  },
}));

import { resolveMissingModelsAction } from "../../tools/missing-models.js";

type Handler = (args: any) => Promise<{ content: Array<{ text?: unknown }> }>;

/**
 * 0.50.0 slice 11 retired the tool into download_model action:"resolve_missing".
 * The HANDLER is unchanged, so this file calls it directly; dispatch and the
 * `workflow` presence guard are covered in models-consolidated.test.ts.
 */
function captureHandler(): Handler {
  return resolveMissingModelsAction;
}

const WORKFLOW = {
  "1": {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "flux1-dev.safetensors" },
  },
};

// Production-shaped V1 /object_info combos for the core loaders. The API
// workflow carries the class_type alongside the named input value; the shared
// `clip_name` spelling is intentional here.
const CLIP_LOADER_OBJECT_INFO = {
  CLIPVisionLoader: {
    input: { required: { clip_name: [["installed-vision.safetensors"], {}] } },
  },
  CLIPLoader: {
    input: {
      required: {
        clip_name: [["installed-text.safetensors"], {}],
        type: [["stable_diffusion"], {}],
      },
      optional: { device: [["default", "cpu"], {}] },
    },
  },
  DualCLIPLoader: {
    input: {
      required: {
        clip_name1: [["installed-primary.safetensors"], {}],
        clip_name2: [["installed-secondary.safetensors"], {}],
        type: [["flux"], {}],
      },
      optional: { device: [["default", "cpu"], {}] },
    },
  },
};

beforeEach(() => {
  providers.civitaiDown = true;
  providers.hfDown = true;
  objectInfo.current = structuredClone(DEFAULT_OBJECT_INFO);
});

describe('action:"resolve_missing" never calls a failed lookup an empty one', () => {
  it("both providers down → 'could not look', NOT 'nothing exists'", async () => {
    const res = await captureHandler()({ workflow: WORKFLOW });
    const text = res.content[0]!.text as string;
    expect(text).toMatch(/the lookup FAILED/);
    expect(text).toMatch(/could not look/);
    expect(text).not.toMatch(/No candidates found on CivitAI or HuggingFace/);
  });

  it("one provider down with zero hits from the other → still not 'nothing exists'", async () => {
    providers.hfDown = false; // answers, but with nothing
    const res = await captureHandler()({ workflow: WORKFLOW });
    const text = res.content[0]!.text as string;
    expect(text).toMatch(/the lookup FAILED \(CivitAI\)/);
    expect(text).not.toMatch(/No candidates found on CivitAI or HuggingFace/);
  });

  it("both providers answering empty → the plain 'no candidates' message (control)", async () => {
    providers.civitaiDown = false;
    providers.hfDown = false;
    const res = await captureHandler()({ workflow: WORKFLOW });
    const text = res.content[0]!.text as string;
    expect(text).toMatch(/No candidates found on CivitAI or HuggingFace/);
    expect(text).not.toMatch(/lookup FAILED/);
  });
});

// #2068 — download_model action:"resolve_missing" must surface custom-node
// LoRA combo values that /object_info does not list, the same way
// panel_get_errors reports unavailable_widget_values. ComfyUI 0.33 publishes
// those slots as V3 ["COMBO", {options}], which the V1-only parser skipped.
describe('action:"resolve_missing" reports unavailable custom-node LoRA combos', () => {
  it("DonutLoRAStack lora_name_N absent from a V3 COMBO list is missing, not healthy", async () => {
    const wanted = [
      "krea2/general-purpose/realism_engine_krea2_v1.safetensors",
      "krea2/Krea2-realism-V2.safetensors",
      "krea2/general-purpose/Krea2_HMNSFW_AIO.safetensors",
      "krea2/Krea2_NSFW_Aesthetics_V1.safetensors",
    ];
    const installed = ["None", "already-have.safetensors"];
    const v3 = (options: string[]) => ["COMBO", { options }];
    objectInfo.current = {
      DonutLoRAStack: {
        input: {
          required: {
            lora_name_1: v3(installed),
            lora_name_2: v3(installed),
            lora_name_3: v3(installed),
          },
        },
      },
    };
    const workflow = {
      "10": {
        class_type: "DonutLoRAStack",
        inputs: { lora_name_1: wanted[0], lora_name_2: wanted[1], lora_name_3: "None" },
      },
      "11": {
        class_type: "DonutLoRAStack",
        inputs: { lora_name_1: wanted[2], lora_name_2: wanted[3], lora_name_3: "None" },
      },
    };

    providers.civitaiDown = false;
    providers.hfDown = false;
    const res = await captureHandler()({ workflow });
    const text = res.content[0]!.text as string;

    expect(text).not.toMatch(/No missing models/);
    expect(text).toMatch(new RegExp(`${wanted.length} missing model`));
    for (const file of wanted) {
      expect(text).toContain(file);
    }
    expect(text).toMatch(/DonutLoRAStack · lora_name_/);
    expect(text).toMatch(/models\/loras\//);
  });
});

// #2604 — `clip_name` is shared by the text and vision CLIP loaders, but
// ComfyUI resolves the former from models/text_encoders and the latter from
// models/clip_vision. Keep this assertion at the production action boundary so
// both the API workflow shape and object-info combo parsing are covered.
describe('action:"resolve_missing" gives CLIPVisionLoader the class-aware directory hint', () => {
  it("uses clip_vision only for CLIPVisionLoader and keeps ordinary CLIP loaders in text_encoders", async () => {
    objectInfo.current = structuredClone(CLIP_LOADER_OBJECT_INFO);
    const workflow = {
      "1": {
        class_type: "CLIPVisionLoader",
        inputs: { clip_name: "dino_v3_vit_h.safetensors" },
      },
      "2": {
        class_type: "CLIPLoader",
        inputs: { clip_name: "clip_l.safetensors", type: "stable_diffusion" },
      },
      "3": {
        class_type: "DualCLIPLoader",
        inputs: {
          clip_name1: "clip_g.safetensors",
          clip_name2: "t5xxl_fp16.safetensors",
          type: "flux",
        },
      },
    };

    const res = await captureHandler()({ workflow });
    const text = res.content[0]!.text as string;

    expect(text).toMatch(/4 missing model/);
    expect(text).toContain(
      "node 1 (CLIPVisionLoader · clip_name) → installs to `models/clip_vision/`",
    );
    expect(text).toContain("node 2 (CLIPLoader · clip_name) → installs to `models/text_encoders/`");
    expect(text).toContain("node 3 (DualCLIPLoader · clip_name1) → installs to `models/text_encoders/`");
    expect(text).toContain("node 3 (DualCLIPLoader · clip_name2) → installs to `models/text_encoders/`");
    expect(text).not.toContain("CLIPVisionLoader · clip_name) → installs to `models/text_encoders/`");
  });
});
