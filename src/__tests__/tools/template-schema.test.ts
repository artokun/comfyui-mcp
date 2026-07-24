import { describe, it, expect } from "vitest";
import {
  extractTemplateSlots,
  templateGraphToApi,
  classifyWidget,
  FALLBACK_OBJECT_INFO,
} from "../../tools/template-schema.js";
import type { ObjectInfo, WorkflowJSON } from "../../comfyui/types.js";

// A classic SD txt2img template in API/prompt format — the canonical sample.
const API_TEMPLATE: WorkflowJSON = {
  "3": {
    class_type: "KSampler",
    inputs: {
      seed: 123456789,
      steps: 20,
      cfg: 7.5,
      sampler_name: "euler",
      scheduler: "normal",
      denoise: 1,
      model: ["4", 0],
      positive: ["6", 0],
      negative: ["7", 0],
      latent_image: ["5", 0],
    },
  },
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base_1.0.safetensors" } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  "6": {
    class_type: "CLIPTextEncode",
    inputs: { text: "a cat", clip: ["4", 1] },
    _meta: { title: "Positive Prompt" },
  },
  "7": {
    class_type: "CLIPTextEncode",
    inputs: { text: "blurry", clip: ["4", 1] },
    _meta: { title: "Negative Prompt" },
  },
  "9": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI", images: ["3", 0] } },
};

const KEY_RE = /^[^.\s]+\.[A-Za-z_][A-Za-z0-9_.]*$/;

describe("extractTemplateSlots (API-format template)", () => {
  const { slots, other_slots } = extractTemplateSlots(API_TEMPLATE, FALLBACK_OBJECT_INFO);
  const byKey = new Map(slots.map((s) => [s.key, s]));

  it("emits the expected primary slots with <nodeId>.<widget> keys", () => {
    expect([...byKey.keys()].sort()).toEqual(
      [
        "3.seed", "3.steps", "3.cfg", "3.sampler_name", "3.scheduler", "3.denoise",
        "4.ckpt_name", "5.width", "5.height", "5.batch_size", "6.text", "7.text",
      ].sort(),
    );
    for (const s of [...slots, ...other_slots]) {
      expect(s.key).toMatch(KEY_RE);
      expect(s.key).toBe(`${s.node_id}.${s.widget}`);
    }
  });

  it("never emits a slot for a link input", () => {
    const all = [...slots, ...other_slots].map((s) => s.key);
    expect(all).not.toContain("3.model");
    expect(all).not.toContain("3.positive");
    expect(all).not.toContain("9.images");
  });

  it("assigns types, roles, values and range metadata from the node schema", () => {
    expect(byKey.get("3.seed")).toMatchObject({ role: "seed", type: "INT", value: 123456789, min: 0 });
    expect(byKey.get("3.steps")).toMatchObject({ role: "steps", type: "INT", value: 20, min: 1, max: 10000 });
    expect(byKey.get("3.cfg")).toMatchObject({ role: "cfg", type: "FLOAT", value: 7.5, min: 0, max: 100 });
    expect(byKey.get("3.sampler_name")).toMatchObject({ role: "sampler", type: "COMBO" });
    expect(byKey.get("3.denoise")).toMatchObject({ role: "denoise", type: "FLOAT", min: 0, max: 1 });
    expect(byKey.get("4.ckpt_name")).toMatchObject({ role: "checkpoint", value: "sd_xl_base_1.0.safetensors" });
    expect(byKey.get("5.width")).toMatchObject({ role: "width", type: "INT", value: 1024 });
    expect(byKey.get("6.text")).toMatchObject({ role: "prompt", type: "STRING", value: "a cat", node_title: "Positive Prompt" });
    expect(byKey.get("7.text")).toMatchObject({ role: "prompt", node_title: "Negative Prompt" });
  });

  it("routes structural widgets to other_slots, still overridable", () => {
    expect(byKey.has("9.filename_prefix")).toBe(false);
    const fp = other_slots.find((s) => s.key === "9.filename_prefix");
    expect(fp).toMatchObject({ role: "other", value: "ComfyUI", type: "STRING" });
  });

  it("surfaces combo options (truncated) when the live schema provides them", () => {
    const live: ObjectInfo = {
      ...FALLBACK_OBJECT_INFO,
      KSampler: {
        ...FALLBACK_OBJECT_INFO.KSampler,
        input: {
          required: {
            ...FALLBACK_OBJECT_INFO.KSampler.input.required!,
            sampler_name: [["euler", "euler_ancestral", "dpmpp_2m"], {}],
          },
        },
      },
    };
    const res = extractTemplateSlots(API_TEMPLATE, live);
    const sampler = res.slots.find((s) => s.key === "3.sampler_name");
    expect(sampler?.options).toEqual(["euler", "euler_ancestral", "dpmpp_2m"]);
    expect(sampler?.options_count).toBe(3);
  });

  it("does not crash on odd node shapes and infers types without a schema", () => {
    const weird = {
      a: { class_type: "TotallyUnknownNode", inputs: { foo: 3, bar: 1.5, baz: true, qux: "x" } },
      b: { class_type: "Broken", inputs: null },
      c: {},
    } as unknown as WorkflowJSON;
    const res = extractTemplateSlots(weird, null);
    const foo = res.other_slots.find((s) => s.key === "a.foo");
    expect(foo).toMatchObject({ type: "INT", value: 3 });
    expect(res.other_slots.find((s) => s.key === "a.bar")?.type).toBe("FLOAT");
    expect(res.other_slots.find((s) => s.key === "a.baz")?.type).toBe("BOOLEAN");
    expect(res.other_slots.find((s) => s.key === "a.qux")?.type).toBe("STRING");
    expect(res.slots).toEqual([]);
  });
});

describe("templateGraphToApi (UI-format template, offline fallback schema)", () => {
  // Minimal UI-format txt2img: KSampler widgets_values includes the phantom
  // control_after_generate value ("randomize") that must NOT become a slot.
  const ui = {
    last_node_id: 6,
    last_link_id: 2,
    nodes: [
      {
        id: 3,
        type: "KSampler",
        pos: [0, 0],
        inputs: [{ name: "positive", type: "CONDITIONING", link: 1 }],
        outputs: [],
        widgets_values: [42, "randomize", 30, 4.0, "euler", "simple", 0.85],
      },
      {
        id: 6,
        type: "CLIPTextEncode",
        pos: [0, 0],
        inputs: [],
        outputs: [{ name: "CONDITIONING", type: "CONDITIONING", links: [1] }],
        widgets_values: ["a scenic mountain"],
        title: "Positive Prompt",
      },
    ],
    links: [[1, 6, 0, 3, 0, "CONDITIONING"]],
    version: 0.4,
  };

  it("maps positional widgets_values to named slots via the fallback schema", () => {
    const norm = templateGraphToApi(ui, null);
    expect(norm).not.toBeNull();
    const { slots } = extractTemplateSlots(norm!.api, norm!.objectInfo);
    const byKey = new Map(slots.map((s) => [s.key, s]));
    expect(byKey.get("3.seed")?.value).toBe(42);
    expect(byKey.get("3.steps")?.value).toBe(30);
    expect(byKey.get("3.cfg")?.value).toBe(4.0);
    expect(byKey.get("3.sampler_name")?.value).toBe("euler");
    expect(byKey.get("3.scheduler")?.value).toBe("simple");
    expect(byKey.get("3.denoise")?.value).toBe(0.85);
    expect(byKey.get("6.text")?.value).toBe("a scenic mountain");
    // The phantom control widget never leaks into any slot.
    const values = [...slots.map((s) => s.value)];
    expect(values).not.toContain("randomize");
  });

  it("keeps a two-number literal widget value that is not a node reference", () => {
    const api = {
      "1": { class_type: "TotallyUnknownNode", inputs: { size: [512, 512], real_link: ["2", 0] } },
      "2": { class_type: "AnotherNode", inputs: {} },
    } as unknown as WorkflowJSON;
    const res = extractTemplateSlots(api, null);
    const keys = [...res.slots, ...res.other_slots].map((s) => s.key);
    expect(keys).toContain("1.size"); // literal, kept
    expect(keys).not.toContain("1.real_link"); // actual connection, dropped
  });

  it("survives malformed UI node entries without crashing", () => {
    const broken = {
      nodes: [
        null,
        { pos: [0, 0] }, // missing id/type
        {
          id: 6,
          type: "CLIPTextEncode",
          pos: [0, 0],
          inputs: [],
          outputs: [],
          widgets_values: ["ok"],
        },
      ],
      links: [null, [1, 6, 0]],
    };
    const norm = templateGraphToApi(broken, null);
    expect(norm).not.toBeNull();
    const { slots } = extractTemplateSlots(norm!.api, norm!.objectInfo);
    expect(slots.map((s) => s.key)).toContain("6.text");
    expect(norm!.warnings.join(" ")).toMatch(/malformed/i);
  });

  it("returns null for JSON that is neither UI nor API format", () => {
    expect(templateGraphToApi({ hello: "world" }, null)).toBeNull();
    expect(templateGraphToApi([1, 2, 3], null)).toBeNull();
    expect(templateGraphToApi("nope", null)).toBeNull();
  });
});

describe("classifyWidget", () => {
  it("classifies the common runtime widgets", () => {
    expect(classifyWidget("CLIPTextEncode", "text")).toBe("prompt");
    expect(classifyWidget("RandomNoise", "noise_seed")).toBe("seed");
    expect(classifyWidget("LoraLoader", "lora_name")).toBe("lora");
    expect(classifyWidget("LoraLoader", "strength_model")).toBe("strength");
    expect(classifyWidget("LoadImage", "image")).toBe("input_image");
    expect(classifyWidget("UNETLoader", "unet_name")).toBe("model");
    expect(classifyWidget("FluxGuidance", "guidance")).toBe("guidance");
    expect(classifyWidget("SaveImage", "filename_prefix")).toBe("other");
  });
});
