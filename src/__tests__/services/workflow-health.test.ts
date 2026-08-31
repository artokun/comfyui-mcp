import { describe, expect, it } from "vitest";
import { analyzeGraphHealth } from "../../services/workflow-health.js";
import type { ObjectInfo, WorkflowJSON } from "../../comfyui/types.js";

// Minimal /object_info covering the node types used across these cases.
const OBJECT_INFO = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [["sd_xl_base.safetensors"], {}] } },
    output: ["MODEL", "CLIP", "VAE"],
    output_node: false,
  },
  CLIPTextEncode: {
    input: { required: { text: ["STRING"], clip: ["CLIP"] } },
    output: ["CONDITIONING"],
    output_node: false,
  },
  KSampler: {
    input: {
      required: {
        model: ["MODEL"],
        positive: ["CONDITIONING"],
        negative: ["CONDITIONING"],
        latent_image: ["LATENT"],
      },
    },
    output: ["LATENT"],
    output_node: false,
  },
  VAEDecode: {
    input: { required: { samples: ["LATENT"], vae: ["VAE"] } },
    output: ["IMAGE"],
    output_node: false,
  },
  SaveImage: {
    input: { required: { images: ["IMAGE"] } },
    output: [],
    output_node: true,
  },
  UpscaleModelLoader: {
    input: { required: { model_name: [["x4.pth"], {}] } },
    output: ["UPSCALE_MODEL"],
    output_node: false,
  },
  EmptyLatentImage: {
    input: { required: { width: ["INT"], height: ["INT"], batch_size: ["INT"] } },
    output: ["LATENT"],
    output_node: false,
  },
  EmptySD3LatentImage: {
    input: { required: { width: ["INT"], height: ["INT"], batch_size: ["INT"] } },
    output: ["LATENT"],
    output_node: false,
  },
  VAEEncode: {
    input: { required: { pixels: ["IMAGE"], vae: ["VAE"] } },
    output: ["LATENT"],
    output_node: false,
  },
  LoadImage: {
    input: { required: { image: [["ref.png"], {}] } },
    output: ["IMAGE", "MASK"],
    output_node: false,
  },
  LatentUpscale: {
    input: { required: { samples: ["LATENT"], width: ["INT"], height: ["INT"] } },
    output: ["LATENT"],
    output_node: false,
  },
  TextEncodeQwenImageEditPlus: {
    input: { required: { clip: ["CLIP"], prompt: ["STRING"] } },
    output: ["CONDITIONING"],
    output_node: false,
  },
  ImageUpscaleWithModel: {
    input: { required: { upscale_model: ["UPSCALE_MODEL"], image: ["IMAGE"] } },
    output: ["IMAGE"],
    output_node: false,
  },
} as unknown as ObjectInfo;

const wf = (nodes: Record<string, unknown>) => nodes as unknown as WorkflowJSON;

describe("analyzeGraphHealth", () => {
  it("reports an isolated node as disconnected", () => {
    const h = analyzeGraphHealth(
      wf({
        "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "9": { class_type: "SaveImage", inputs: {} },
      }),
      OBJECT_INFO,
    );
    const dc = h.findings.filter((f) => f.kind === "disconnected");
    // Node 1 has no consumers (nothing reads it) and no inbound → isolated.
    expect(dc.some((f) => f.node_ids.includes("1"))).toBe(true);
    // SaveImage is an output node → never flagged disconnected.
    expect(dc.some((f) => f.node_ids.includes("9"))).toBe(false);
  });

  it("reports a duplicate checkpoint load once, listing all node ids", () => {
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "17": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "5": { class_type: "KSampler", inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["4", 2] } },
        "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["17", 2] } },
        "9": { class_type: "SaveImage", inputs: { images: ["6", 0] } },
      }),
      OBJECT_INFO,
    );
    const dup = h.findings.filter((f) => f.kind === "duplicate_model_load");
    expect(dup).toHaveLength(1);
    expect(dup[0].node_ids.sort()).toEqual(["17", "4"]);
    expect(dup[0].detail).toMatch(/sd_xl_base\.safetensors/);
  });

  it("reports an orphaned upscale branch that never reaches a save node", () => {
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "5": { class_type: "KSampler", inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["4", 2] } },
        "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["4", 2] } },
        "9": { class_type: "SaveImage", inputs: { images: ["6", 0] } },
        // Orphaned branch: loader -> upscale, output feeds nothing.
        "22": { class_type: "UpscaleModelLoader", inputs: { model_name: "x4.pth" } },
        "23": { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["22", 0], image: ["6", 0] } },
      }),
      OBJECT_INFO,
    );
    const orphans = h.findings.filter((f) => f.kind === "orphaned_branch");
    expect(orphans).toHaveLength(1);
    // Node 23's output reaches nothing; 22 feeds 23. Both are in the component.
    expect(orphans[0].node_ids).toContain("23");
    expect(orphans[0].node_ids).toContain("22");
  });

  it("flags a graph with NO output node (the 'Prompt has no outputs' failure)", () => {
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "5": { class_type: "KSampler", inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["4", 2] } },
        "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["4", 2] } },
        // No SaveImage / PreviewImage — ComfyUI would reject this prompt.
      }),
      OBJECT_INFO,
    );
    const noOut = h.findings.filter((f) => f.kind === "no_output_reachable");
    expect(noOut).toHaveLength(1);
    expect(noOut[0].detail).toMatch(/Prompt has no outputs/);
    expect(noOut[0].detail).toMatch(/SaveImage/);
  });

  it("does NOT flag no_output_reachable when a save node is present", () => {
    const h = analyzeGraphHealth(
      wf({
        "6": { class_type: "VAEDecode", inputs: {} },
        "9": { class_type: "SaveImage", inputs: { images: ["6", 0] } },
      }),
      OBJECT_INFO,
    );
    expect(h.findings.filter((f) => f.kind === "no_output_reachable")).toHaveLength(0);
  });

  it("groups multiple unreached nodes into one finding per connected component", () => {
    const h = analyzeGraphHealth(
      wf({
        "9": { class_type: "SaveImage", inputs: {} },
        // Component A: 10 -> 11 (unreached, connected to each other)
        "10": { class_type: "UpscaleModelLoader", inputs: { model_name: "x4.pth" } },
        "11": { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["10", 0], image: ["10", 0] } },
        // Component B: 20 -> 21 (separate unreached chain)
        "20": { class_type: "UpscaleModelLoader", inputs: { model_name: "x4.pth" } },
        "21": { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["20", 0], image: ["20", 0] } },
      }),
      OBJECT_INFO,
    );
    const orphans = h.findings.filter((f) => f.kind === "orphaned_branch");
    // Two disjoint components → exactly two findings (not four line items).
    expect(orphans).toHaveLength(2);
    for (const o of orphans) expect(o.node_ids).toHaveLength(2);
  });

  it("falls back to slot-name heuristics for a Sampler-family class absent from object_info", () => {
    const h = analyzeGraphHealth(
      wf({
        // Unknown custom sampler, missing the `model` required input.
        "1": { class_type: "MyCustomSampler", inputs: { positive: ["2", 0], negative: ["2", 0], latent_image: ["2", 0] } },
        "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
      }),
      OBJECT_INFO,
    );
    const missing = h.findings.filter((f) => f.kind === "missing_required_input");
    const modelMiss = missing.find((f) => f.node_ids.includes("1") && /model/.test(f.detail));
    expect(modelMiss).toBeDefined();
    expect(modelMiss?.heuristic).toBe(true);
  });

  it("reports muted/bypassed nodes as info via _meta.mode", () => {
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "9": { class_type: "KSampler", inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["4", 2] }, _meta: { mode: "bypassed" } },
        "10": { class_type: "SaveImage", inputs: { images: ["9", 0] } },
      }),
      OBJECT_INFO,
    );
    const info = h.findings.filter((f) => f.kind === "muted_or_bypassed");
    expect(info).toHaveLength(1);
    expect(info[0].severity).toBe("info");
    expect(info[0].node_ids).toEqual(["9"]);
    expect(info[0].detail).toMatch(/bypassed/);
  });

  it("populates the node-type histogram and total_nodes", () => {
    const h = analyzeGraphHealth(
      wf({
        "1": { class_type: "CLIPTextEncode", inputs: { text: "a", clip: ["4", 1] } },
        "2": { class_type: "CLIPTextEncode", inputs: { text: "b", clip: ["4", 1] } },
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "9": { class_type: "SaveImage", inputs: {} },
      }),
      OBJECT_INFO,
    );
    expect(h.total_nodes).toBe(4);
    expect(h.node_type_histogram.CLIPTextEncode).toBe(2);
    expect(h.node_type_histogram.CheckpointLoaderSimple).toBe(1);
  });

  // --- partial denoise over an empty latent (#2678) -------------------------

  it("flags a sampler running denoise below 1.0 on a latent straight from EmptyLatentImage", () => {
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "8": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
        "9": {
          class_type: "KSampler",
          inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["8", 0], denoise: 0.65 },
        },
        "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["4", 2] } },
        "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
      }),
      OBJECT_INFO,
    );
    const f = h.findings.filter((x) => x.kind === "partial_denoise_empty_latent");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("warning");
    // Both ends of the bad pairing are named so the caller can jump to either.
    expect(f[0].node_ids).toEqual(["9", "8"]);
    expect(f[0].node_type).toBe("KSampler");
    expect(f[0].detail).toMatch(/0\.65/);
    expect(f[0].detail).toMatch(/VAEEncode/);
  });

  it("reproduces the #2678 graph: TextEncodeQwenImageEditPlus + EmptyLatentImage at denoise 0.65", () => {
    // The reporter's shape verbatim -- LoadImage reference, Plus encoder (CONDITIONING
    // only), EmptyLatentImage 1024x1024, KSampler steps 50 / cfg 4 / denoise 0.65.
    // It validated and executed with no error and rendered a texture-only field.
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "5": { class_type: "LoadImage", inputs: { image: "ref.png" } },
        "6": { class_type: "TextEncodeQwenImageEditPlus", inputs: { clip: ["4", 1], prompt: "change the garment" } },
        "7": { class_type: "TextEncodeQwenImageEditPlus", inputs: { clip: ["4", 1], prompt: "" } },
        "8": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
        "9": {
          class_type: "KSampler",
          inputs: {
            model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["8", 0],
            seed: 42, steps: 50, cfg: 4, sampler_name: "euler", scheduler: "simple", denoise: 0.65,
          },
        },
        "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["4", 2] } },
        "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
      }),
      OBJECT_INFO,
    );
    expect(h.findings.some((x) => x.kind === "partial_denoise_empty_latent")).toBe(true);
  });

  it("does NOT flag denoise 1.0 over an empty latent -- that is ordinary txt2img", () => {
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "8": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
        "9": {
          class_type: "KSampler",
          inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["8", 0], denoise: 1.0 },
        },
        "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["4", 2] } },
        "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
      }),
      OBJECT_INFO,
    );
    expect(h.findings.filter((x) => x.kind === "partial_denoise_empty_latent")).toHaveLength(0);
  });

  it("does NOT flag a sub-1.0 denoise fed by VAEEncode -- that is correct img2img", () => {
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "5": { class_type: "LoadImage", inputs: { image: "ref.png" } },
        "8": { class_type: "VAEEncode", inputs: { pixels: ["5", 0], vae: ["4", 2] } },
        "9": {
          class_type: "KSampler",
          inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["8", 0], denoise: 0.65 },
        },
        "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["4", 2] } },
        "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
      }),
      OBJECT_INFO,
    );
    expect(h.findings.filter((x) => x.kind === "partial_denoise_empty_latent")).toHaveLength(0);
  });

  it("does NOT flag a hires-fix chain where the empty latent is one hop upstream", () => {
    // EmptyLatentImage -> KSampler(denoise 1.0) -> LatentUpscale -> KSampler(denoise 0.5).
    // The second sampler's latent carries real content, so the direct-connection scope
    // is what keeps this healthy graph quiet.
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "8": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
        "9": {
          class_type: "KSampler",
          inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["8", 0], denoise: 1.0 },
        },
        "12": { class_type: "LatentUpscale", inputs: { samples: ["9", 0], width: 1024, height: 1024 } },
        "13": {
          class_type: "KSampler",
          inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["12", 0], denoise: 0.5 },
        },
        "10": { class_type: "VAEDecode", inputs: { samples: ["13", 0], vae: ["4", 2] } },
        "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
      }),
      OBJECT_INFO,
    );
    expect(h.findings.filter((x) => x.kind === "partial_denoise_empty_latent")).toHaveLength(0);
  });

  it("covers the whole Empty*Latent* family, not just EmptyLatentImage", () => {
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "8": { class_type: "EmptySD3LatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
        "9": {
          class_type: "KSampler",
          inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["8", 0], denoise: 0.8 },
        },
        "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["4", 2] } },
        "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
      }),
      OBJECT_INFO,
    );
    const f = h.findings.filter((x) => x.kind === "partial_denoise_empty_latent");
    expect(f).toHaveLength(1);
    expect(f[0].detail).toMatch(/EmptySD3LatentImage/);
  });

  it("uses ComfyUI's own 0.9999 full-denoise threshold as the boundary", () => {
    const at = (denoise: number) =>
      analyzeGraphHealth(
        wf({
          "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
          "8": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
          "9": {
            class_type: "KSampler",
            inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["8", 0], denoise },
          },
          "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["4", 2] } },
          "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
        }),
        OBJECT_INFO,
      ).findings.filter((x) => x.kind === "partial_denoise_empty_latent").length;

    // comfy/samplers.py set_steps truncates the schedule for `denoise <= 0.9999`
    // and takes the full schedule above it. The finding must land on that seam.
    expect(at(0.9999)).toBe(1);
    expect(at(0.99991)).toBe(0);
    expect(at(1.0)).toBe(0);
  });

  it("ignores a denoise that is a converted input rather than a literal widget value", () => {
    // `["12", 0]` is a link -- its runtime value is unknowable statically, so claiming
    // the graph is broken would be a guess.
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "8": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
        "9": {
          class_type: "KSampler",
          inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["8", 0], denoise: ["12", 0] },
        },
        "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["4", 2] } },
        "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } },
      }),
      OBJECT_INFO,
    );
    expect(h.findings.filter((x) => x.kind === "partial_denoise_empty_latent")).toHaveLength(0);
  });

  it("flags an unknown custom sampler class by its slot shape, not a class allowlist", () => {
    const h = analyzeGraphHealth(
      wf({
        "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
        "8": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
        "9": {
          class_type: "SomeCustomKSampler",
          inputs: { model: ["4", 0], positive: ["4", 1], negative: ["4", 1], latent_image: ["8", 0], denoise: 0.5 },
        },
        "10": { class_type: "SaveImage", inputs: { images: ["9", 0] } },
      }),
      OBJECT_INFO,
    );
    const f = h.findings.filter((x) => x.kind === "partial_denoise_empty_latent");
    expect(f).toHaveLength(1);
    expect(f[0].node_type).toBe("SomeCustomKSampler");
  });
});
