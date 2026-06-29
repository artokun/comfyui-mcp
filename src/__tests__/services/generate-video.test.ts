import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  generateVideo,
  normalizeFrameCount,
  parseResolution,
  type GenerateVideoDeps,
} from "../../services/generate-video.js";
import { DefaultsManager } from "../../services/defaults-manager.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

// The required LTX deps the service verifies (must be present for the happy path).
const DISTILLED_LORA =
  "ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors";
const ABLITERATED_LORA = "gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors";

// listModels(type) → the per-category roster the service checks (a throw means
// "can't determine, don't block"; [] means "determined empty" → missing-dep error).
function makeDeps(
  models: Record<string, string[]> = {
    checkpoints: ["ltx-2.3-22b-dev.safetensors"],
    text_encoders: ["gemma_3_12B_it_fp8_scaled.safetensors"],
    loras: [DISTILLED_LORA, ABLITERATED_LORA],
  },
) {
  const enqueued: WorkflowJSON[] = [];
  const listModels = vi.fn(async (type: string) => models[type] ?? []);
  const deps: GenerateVideoDeps = {
    listModels,
    enqueue: async (wf) => {
      enqueued.push(wf);
      return { prompt_id: "pid-video", queue_remaining: 0 };
    },
  };
  return { deps, enqueued, listModels };
}

function node(wf: WorkflowJSON, type: string) {
  return Object.values(wf).find((n) => n.class_type === type);
}

describe("normalizeFrameCount", () => {
  it("rounds to the nearest 8n+1 frame count", () => {
    expect(normalizeFrameCount(100)).toBe(97); // 4s @25fps
    expect(normalizeFrameCount(50)).toBe(49);
    expect(normalizeFrameCount(97)).toBe(97);
    expect(normalizeFrameCount(120)).toBe(121);
  });
  it("clamps to the valid range", () => {
    expect(normalizeFrameCount(1)).toBe(9);
    expect(normalizeFrameCount(100000)).toBe(257);
  });
});

describe("parseResolution", () => {
  it("parses WxH and rounds to multiples of 32", () => {
    expect(parseResolution("768x512")).toEqual({ width: 768, height: 512 });
    expect(parseResolution("960x540")).toEqual({ width: 960, height: 544 });
  });
  it("returns undefined for unparseable input", () => {
    expect(parseResolution(undefined)).toBeUndefined();
    expect(parseResolution("big")).toBeUndefined();
  });
});

describe("generateVideo", () => {
  beforeEach(() => {
    DefaultsManager.reset();
    DefaultsManager.configure({ configPath: "/tmp/__never__.json", env: {} });
  });

  it("builds a text-to-video LTX graph with the verified loader stack", async () => {
    const { deps, enqueued } = makeDeps();
    const res = await generateVideo({ prompt: "a cat surfing" }, deps);

    expect(res.mode).toBe("t2v");
    const wf = enqueued[0];
    expect(node(wf, "CheckpointLoaderSimple")!.inputs.ckpt_name).toBe(
      "ltx-2.3-22b-dev.safetensors",
    );
    expect(node(wf, "LTXAVTextEncoderLoader")!.inputs.text_encoder).toBe(
      "gemma_3_12B_it_fp8_scaled.safetensors",
    );
    // Both LoRAs present (abliterated on CLIP, distilled on model).
    expect(node(wf, "LoraLoader")).toBeDefined();
    expect(node(wf, "LoraLoaderModelOnly")!.inputs.strength_model).toBe(0.5);
    // t2v uses an empty latent, not a LoadImage / i2v node.
    expect(node(wf, "EmptyLTXVLatentVideo")).toBeDefined();
    expect(node(wf, "LoadImage")).toBeUndefined();
    expect(node(wf, "LTXVImgToVideo")).toBeUndefined();
    // The distilled sampler tail + video output.
    expect(node(wf, "SamplerCustomAdvanced")).toBeDefined();
    expect(node(wf, "SaveVideo")).toBeDefined();
    // Positive prompt wired in.
    const pos = Object.values(wf).find(
      (n) => n.class_type === "CLIPTextEncode" && n._meta?.title === "Positive Prompt",
    );
    expect(pos!.inputs.text).toBe("a cat surfing");
  });

  it("builds an image-to-video graph with the strength gotcha default (0.6)", async () => {
    const { deps, enqueued } = makeDeps();
    const res = await generateVideo({ prompt: "she waves", image: "start.png" }, deps);

    expect(res.mode).toBe("i2v");
    const wf = enqueued[0];
    expect(node(wf, "LoadImage")!.inputs.image).toBe("start.png");
    // i2v uses LTXVImgToVideoInplace (the node the ltx-2.3 packs actually use),
    // which bakes the start frame into the base EmptyLTXVLatentVideo. strength is
    // a widget on that node — the "LTX strength gotcha" default of 0.6.
    const i2v = node(wf, "LTXVImgToVideoInplace")!;
    expect(i2v.inputs.strength).toBe(0.6);
    expect(i2v.inputs.bypass).toBe(false);
    expect(node(wf, "LTXVImgToVideo")).toBeUndefined();
  });

  it("honors an explicit i2v strength override", async () => {
    const { deps, enqueued } = makeDeps();
    await generateVideo({ prompt: "p", image: "s.png", strength: 0.9 }, deps);
    expect(node(enqueued[0], "LTXVImgToVideoInplace")!.inputs.strength).toBe(0.9);
  });

  it("converts seconds + fps into an 8n+1 frame length", async () => {
    const { deps, enqueued } = makeDeps();
    const res = await generateVideo({ prompt: "p", seconds: 2, fps: 25 }, deps);
    expect(res.length).toBe(49);
    expect(node(enqueued[0], "EmptyLTXVLatentVideo")!.inputs.length).toBe(49);
  });

  it("applies a resolution preset rounded to multiples of 32", async () => {
    const { deps, enqueued } = makeDeps();
    const res = await generateVideo({ prompt: "p", resolution: "960x540" }, deps);
    expect(res.width).toBe(960);
    expect(res.height).toBe(544);
    expect(node(enqueued[0], "EmptyLTXVLatentVideo")!.inputs.width).toBe(960);
  });

  it("verifies the checkpoint, text encoder, and LoRAs from local models", async () => {
    const { deps, listModels } = makeDeps();
    await generateVideo({ prompt: "p" }, deps);
    expect(listModels).toHaveBeenCalledWith("checkpoints");
    expect(listModels).toHaveBeenCalledWith("text_encoders");
    expect(listModels).toHaveBeenCalledWith("loras");
  });

  it("throws an actionable error when no LTX checkpoint is found", async () => {
    // Roster is readable but the checkpoint is absent → determined-missing → error
    // (a throw from listModels would instead mean "can't determine" and proceed).
    const { deps } = makeDeps({
      checkpoints: [],
      text_encoders: ["gemma_3_12B_it_fp8_scaled.safetensors"],
      loras: [DISTILLED_LORA, ABLITERATED_LORA],
    });
    await expect(generateVideo({ prompt: "p" }, deps)).rejects.toThrow(
      /ltx-2\.3|apply_manifest|checkpoint/i,
    );
  });

  it("backfills steps/cfg from defaults", async () => {
    await DefaultsManager.set({ steps: 12, cfg: 2.5 });
    const { deps, enqueued } = makeDeps();
    await generateVideo({ prompt: "p" }, deps);
    expect(node(enqueued[0], "LTXVScheduler")!.inputs.steps).toBe(12);
    expect(node(enqueued[0], "CFGGuider")!.inputs.cfg).toBe(2.5);
  });

  it("rejects an empty prompt", async () => {
    const { deps } = makeDeps();
    await expect(generateVideo({ prompt: "" }, deps)).rejects.toThrow(/prompt is required/i);
  });

  it("rejects an out-of-range strength", async () => {
    const { deps } = makeDeps();
    await expect(
      generateVideo({ prompt: "p", image: "s.png", strength: 2 }, deps),
    ).rejects.toThrow(/strength/i);
  });
});
