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
});
