import { describe, it, expect } from "vitest";
import {
  convertApiToUi,
  convertUiToApi,
  isApiFormat,
  isUiFormat,
} from "../../services/workflow-converter.js";

// ─────────────────────────────────────────────────────────────────────────────
// convertApiToUi — API → UI with generated layout (issue #126)
// ─────────────────────────────────────────────────────────────────────────────

// Realistic txt2img object_info subset with outputs + input_order (widget order
// is definitional — the round-trip depends on it).
const T2I_INFO = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [["model_a.safetensors", "model_b.safetensors"]] } },
    input_order: { required: ["ckpt_name"] },
    output: ["MODEL", "CLIP", "VAE"],
    output_name: ["MODEL", "CLIP", "VAE"],
  },
  CLIPTextEncode: {
    input: { required: { text: ["STRING", { multiline: true }], clip: ["CLIP"] } },
    input_order: { required: ["text", "clip"] },
    output: ["CONDITIONING"],
    output_name: ["CONDITIONING"],
  },
  EmptyLatentImage: {
    input: {
      required: {
        width: ["INT", { default: 512 }],
        height: ["INT", { default: 512 }],
        batch_size: ["INT", { default: 1 }],
      },
    },
    input_order: { required: ["width", "height", "batch_size"] },
    output: ["LATENT"],
    output_name: ["LATENT"],
  },
  KSampler: {
    input: {
      required: {
        model: ["MODEL"],
        seed: ["INT", { default: 0, control_after_generate: true }],
        steps: ["INT", { default: 20 }],
        cfg: ["FLOAT", { default: 8.0 }],
        sampler_name: [["euler", "dpmpp_2m"]],
        scheduler: [["normal", "karras"]],
        positive: ["CONDITIONING"],
        negative: ["CONDITIONING"],
        latent_image: ["LATENT"],
        denoise: ["FLOAT", { default: 1.0 }],
      },
    },
    input_order: {
      required: [
        "model", "seed", "steps", "cfg", "sampler_name", "scheduler",
        "positive", "negative", "latent_image", "denoise",
      ],
    },
    output: ["LATENT"],
    output_name: ["LATENT"],
  },
  VAEDecode: {
    input: { required: { samples: ["LATENT"], vae: ["VAE"] } },
    input_order: { required: ["samples", "vae"] },
    output: ["IMAGE"],
    output_name: ["IMAGE"],
  },
  SaveImage: {
    input: {
      required: { images: ["IMAGE"], filename_prefix: ["STRING", { default: "ComfyUI" }] },
    },
    input_order: { required: ["images", "filename_prefix"] },
    output: [],
    output_name: [],
  },
} as never;

const T2I_API = {
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model_a.safetensors" } },
  "2": {
    class_type: "CLIPTextEncode",
    inputs: { text: "a cat in a hat", clip: ["1", 1] },
    _meta: { title: "Positive" },
  },
  "3": {
    class_type: "CLIPTextEncode",
    inputs: { text: "blurry, low quality", clip: ["1", 1] },
    _meta: { title: "Negative" },
  },
  "4": { class_type: "EmptyLatentImage", inputs: { width: 768, height: 512, batch_size: 1 } },
  "5": {
    class_type: "KSampler",
    inputs: {
      model: ["1", 0], seed: 42, steps: 25, cfg: 7.5,
      sampler_name: "euler", scheduler: "karras",
      positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0], denoise: 1.0,
    },
  },
  "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
  "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "roundtrip" } },
} as never;

describe("convertApiToUi — structure and round-trip", () => {
  it("round-trips a full txt2img graph: convertUiToApi(convertApiToUi(x)) === x", () => {
    const { workflow: ui, warnings } = convertApiToUi(T2I_API, T2I_INFO);
    expect(warnings).toEqual([]);
    const back = convertUiToApi(ui as never, T2I_INFO);
    expect(back.workflow).toEqual(T2I_API);
  });

  it("emits canvas-loadable structure: nodes, links, slots, and workflow ids", () => {
    const { workflow: ui } = convertApiToUi(T2I_API, T2I_INFO);
    expect(ui.nodes).toHaveLength(7);
    expect(ui.links).toHaveLength(9); // clip×2, model, pos, neg, latent, samples, vae, images
    expect(ui.last_node_id).toBe(7);
    expect(ui.last_link_id).toBe(9);

    const ks = ui.nodes.find((n) => n.type === "KSampler")!;
    // control_after_generate seed carries the phantom widget slot.
    expect(ks.widgets_values).toEqual([42, "fixed", 25, 7.5, "euler", "karras", 1.0]);
    // Link inputs appear as slots in definition order with wired link ids.
    expect(ks.inputs!.map((i) => i.name)).toEqual([
      "model", "positive", "negative", "latent_image",
    ]);
    for (const inp of ks.inputs!) expect(inp.link).toBeTypeOf("number");

    const ckpt = ui.nodes.find((n) => n.type === "CheckpointLoaderSimple")!;
    expect(ckpt.outputs!.map((o) => o.name)).toEqual(["MODEL", "CLIP", "VAE"]);
    expect(ckpt.outputs![1].links).toHaveLength(2); // CLIP feeds both encoders

    // Every link's target slot index matches the target node's inputs array.
    for (const [id, , , tgtId, tgtSlot] of ui.links) {
      const tgt = ui.nodes.find((n) => n.id === tgtId)!;
      expect(tgt.inputs![tgtSlot].link).toBe(id);
    }
  });

  it("preserves _meta.title as node title and _meta.mode muted/bypassed as mode 2/4", () => {
    const api = {
      "1": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
      "2": {
        class_type: "SaveImage",
        inputs: { filename_prefix: "x" },
        _meta: { title: "Final Save", mode: "muted" },
      },
      "3": {
        class_type: "VAEDecode",
        inputs: {},
        _meta: { mode: "bypassed" },
      },
    } as never;
    const { workflow: ui } = convertApiToUi(api, T2I_INFO);
    const save = ui.nodes.find((n) => n.type === "SaveImage")!;
    expect(save.title).toBe("Final Save");
    expect(save.mode).toBe(2);
    expect(ui.nodes.find((n) => n.type === "VAEDecode")!.mode).toBe(4);
    expect(ui.nodes.find((n) => n.type === "EmptyLatentImage")!.mode).toBe(0);
  });

  it("generates a left-to-right topological layout with no overlapping positions", () => {
    const { workflow: ui } = convertApiToUi(T2I_API, T2I_INFO);
    const x = (type: string) =>
      (ui.nodes.find((n) => n.type === type)!.pos as [number, number])[0];
    expect(x("CLIPTextEncode")).toBeGreaterThan(x("CheckpointLoaderSimple"));
    expect(x("KSampler")).toBeGreaterThan(x("CLIPTextEncode"));
    expect(x("VAEDecode")).toBeGreaterThan(x("KSampler"));
    expect(x("SaveImage")).toBeGreaterThan(x("VAEDecode"));
    const seen = new Set(ui.nodes.map((n) => String(n.pos)));
    expect(seen.size).toBe(ui.nodes.length); // all positions distinct
    for (const n of ui.nodes) {
      const [w, h] = n.size as [number, number];
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
    }
  });

  it("represents a link-fed widget input as a converted slot and round-trips it", () => {
    const info = {
      MyInt: {
        input: { required: { value: ["INT", { default: 0 }] } },
        input_order: { required: ["value"] },
        output: ["INT"],
        output_name: ["INT"],
      },
      Blur: {
        input: { required: { image: ["IMAGE"], blur_radius: ["INT", { default: 5 }] } },
        input_order: { required: ["image", "blur_radius"] },
        output: ["IMAGE"],
        output_name: ["IMAGE"],
      },
      SolidColor: {
        input: { required: { width: ["INT", { default: 64 }], height: ["INT", { default: 64 }] } },
        input_order: { required: ["width", "height"] },
        output: ["IMAGE"],
        output_name: ["IMAGE"],
      },
    } as never;
    const api = {
      "1": { class_type: "MyInt", inputs: { value: 9 } },
      "2": { class_type: "SolidColor", inputs: { width: 64, height: 64 } },
      "3": { class_type: "Blur", inputs: { image: ["2", 0], blur_radius: ["1", 0] } },
    } as never;
    const { workflow: ui } = convertApiToUi(api, info);
    const blur = ui.nodes.find((n) => n.type === "Blur")!;
    const widgetSlot = blur.inputs!.find((i) => i.name === "blur_radius")!;
    expect(widgetSlot.widget).toEqual({ name: "blur_radius" });
    expect(widgetSlot.link).toBeTypeOf("number");
    expect(blur.widgets_values).toHaveLength(1); // positional placeholder kept

    const back = convertUiToApi(ui as never, info);
    expect(back.workflow).toEqual(api);
  });

  it("round-trips V3 dynamic-combo nested dotted keys", () => {
    const info = {
      GeminiNanoBanana2V2: {
        input: {
          required: {
            prompt: ["STRING", { multiline: true }],
            model: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "Nano Banana 2 (Gemini 3.1 Flash Image)",
                    inputs: {
                      required: {
                        aspect_ratio: ["COMBO", { options: ["auto", "1:1", "16:9"] }],
                        resolution: ["COMBO", { options: ["1K", "2K", "4K"] }],
                        thinking_level: ["COMBO", { options: ["MINIMAL", "HIGH"] }],
                        images: ["COMFY_AUTOGROW_V3", { min: 0 }],
                      },
                    },
                  },
                ],
              },
            ],
            seed: ["INT", { default: 42, control_after_generate: true }],
            response_modalities: ["COMBO", { options: ["IMAGE", "IMAGE+TEXT"] }],
          },
        },
        output: ["IMAGE"],
        output_name: ["IMAGE"],
      },
    } as never;
    const api = {
      "1": {
        class_type: "GeminiNanoBanana2V2",
        inputs: {
          prompt: "a red cube",
          model: "Nano Banana 2 (Gemini 3.1 Flash Image)",
          "model.aspect_ratio": "16:9",
          "model.resolution": "2K",
          "model.thinking_level": "HIGH",
          seed: 7,
          response_modalities: "IMAGE",
        },
      },
    } as never;
    const { workflow: ui, warnings } = convertApiToUi(api, info);
    expect(warnings).toEqual([]);
    expect(ui.nodes[0].widgets_values).toEqual([
      "a red cube",
      "Nano Banana 2 (Gemini 3.1 Flash Image)",
      "16:9", "2K", "HIGH",
      7, "fixed",
      "IMAGE",
    ]);
    const back = convertUiToApi(ui as never, info);
    expect(back.workflow).toEqual(api);
  });

  it("keeps connections for unknown node types (best-effort) and warns", () => {
    const api = {
      "1": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
      "2": { class_type: "TotallyUnknownNode", inputs: { latent: ["1", 0], strength: 0.5 } },
    } as never;
    const { workflow: ui, warnings } = convertApiToUi(api, T2I_INFO);
    expect(warnings.some((w) => w.includes("TotallyUnknownNode"))).toBe(true);
    const unk = ui.nodes.find((n) => n.type === "TotallyUnknownNode")!;
    expect(unk.inputs![0].link).toBeTypeOf("number");
    expect(unk.widgets_values).toEqual([0.5]);
    expect(ui.links).toHaveLength(1);
  });

  it("remaps non-numeric node keys with a warning, preserving connections", () => {
    const api = {
      latent: {
        class_type: "EmptyLatentImage",
        inputs: { width: 512, height: 512, batch_size: 1 },
      },
      save: { class_type: "SaveImage", inputs: { images: ["latent", 0], filename_prefix: "x" } },
    } as never;
    const { workflow: ui, warnings } = convertApiToUi(api, T2I_INFO);
    expect(warnings.some((w) => w.includes("not a usable unique positive integer"))).toBe(true);
    expect(ui.links).toHaveLength(1);
    const save = ui.nodes.find((n) => n.type === "SaveImage")!;
    expect(save.inputs!.find((i) => i.name === "images")!.link).toBe(ui.links[0][0]);
  });

  it('remaps colliding numeric keys ("1" vs "01") to unique ids, keeping wiring', () => {
    const api = {
      "1": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
      "01": { class_type: "EmptyLatentImage", inputs: { width: 256, height: 256, batch_size: 1 } },
      "2": { class_type: "SaveImage", inputs: { images: ["01", 0], filename_prefix: "x" } },
    } as never;
    const { workflow: ui, warnings } = convertApiToUi(api, T2I_INFO);
    expect(warnings.some((w) => w.includes('"01"'))).toBe(true);
    const ids = ui.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate node ids
    // The link still points at the REMAPPED "01" node, not the "1" node.
    const save = ui.nodes.find((n) => n.type === "SaveImage")!;
    const link = ui.links.find((l) => l[0] === save.inputs![0].link)!;
    const src = ui.nodes.find((n) => n.id === link[1])!;
    expect(src.widgets_values![0]).toBe(256);
  });

  it("warns on a literal value stuck on a connection-only input and drops it", () => {
    const api = {
      "1": { class_type: "VAEDecode", inputs: { samples: "not-a-link" } },
    } as never;
    const { warnings } = convertApiToUi(api, T2I_INFO);
    expect(warnings.some((w) => w.includes('"samples"') && w.includes("literal"))).toBe(true);
  });

  it("fills omitted widgets with object_info defaults so positions stay aligned", () => {
    const api = {
      "1": { class_type: "EmptyLatentImage", inputs: { width: 768 } }, // height/batch omitted
    } as never;
    const { workflow: ui } = convertApiToUi(api, T2I_INFO);
    expect(ui.nodes[0].widgets_values).toEqual([768, 512, 1]);
  });
});

describe("isApiFormat / isUiFormat detection", () => {
  it("classifies API format", () => {
    expect(isApiFormat(T2I_API)).toBe(true);
    expect(isUiFormat(T2I_API)).toBe(false);
  });
  it("classifies UI format", () => {
    const ui = { nodes: [], links: [] };
    expect(isUiFormat(ui)).toBe(true);
    expect(isApiFormat(ui)).toBe(false);
  });
  it("rejects empty objects, arrays, and junk", () => {
    expect(isApiFormat({})).toBe(false);
    expect(isApiFormat([])).toBe(false);
    expect(isApiFormat(null)).toBe(false);
    expect(isApiFormat({ a: { inputs: {} } })).toBe(false); // no class_type
  });
});
