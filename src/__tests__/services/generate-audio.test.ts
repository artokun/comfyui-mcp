import { describe, expect, it, beforeEach, vi } from "vitest";
import { generateAudio, type GenerateAudioDeps } from "../../services/generate-audio.js";
import { DefaultsManager } from "../../services/defaults-manager.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

// Models the dependency injection generateAudio expects: a per-type model
// resolver and an enqueue sink that records the constructed graph.
function makeDeps(
  models: Record<string, string | undefined> = {
    diffusion_models: "ace.safetensors",
    vae: "ace_vae.safetensors",
    text_encoders: "qwen.safetensors",
    checkpoints: "stable_audio.safetensors",
  },
): {
  deps: GenerateAudioDeps;
  enqueued: WorkflowJSON[];
  resolveFirstModel: ReturnType<typeof vi.fn>;
} {
  const enqueued: WorkflowJSON[] = [];
  const resolveFirstModel = vi.fn(async (type: string) => models[type]);
  const deps: GenerateAudioDeps = {
    resolveFirstModel,
    enqueue: async (wf) => {
      enqueued.push(wf);
      return { prompt_id: "pid-audio", queue_remaining: 0 };
    },
  };
  return { deps, enqueued, resolveFirstModel };
}

function byClass(wf: WorkflowJSON, classType: string) {
  return Object.values(wf).find((n) => n.class_type === classType);
}

describe("generateAudio", () => {
  beforeEach(() => {
    DefaultsManager.reset();
    DefaultsManager.configure({ configPath: "/tmp/__never__.json", env: {} });
  });

  describe("ACE Step 1.5", () => {
    it("builds an ACE audio graph with the prompt and duration wired in", async () => {
      const { deps, enqueued } = makeDeps();
      const res = await generateAudio(
        {
          model_family: "ace_step_1.5",
          prompt: "lofi piano loop",
          duration: 30,
          unet: "ace.safetensors",
        },
        deps,
      );

      expect(res.prompt_id).toBe("pid-audio");
      expect(res.model_family).toBe("ace_step_1.5");
      expect(enqueued).toHaveLength(1);

      const wf = enqueued[0];
      // The prompt is the ACE "tags" (style/description) input, not `text`.
      expect(byClass(wf, "TextEncodeAceStepAudio1.5")?.inputs.tags).toBe("lofi piano loop");
      expect(byClass(wf, "EmptyAceStep1.5LatentAudio")?.inputs.seconds).toBe(30);
      // The decode/save tail must exist so the run produces a file.
      expect(byClass(wf, "VAEDecodeAudio")).toBeDefined();
      expect(byClass(wf, "SaveAudioMP3")).toBeDefined();
    });

    // Regression for #448: the built-in ace_step_15 template used stale node
    // schemas (ckpt_name instead of unet_name, `text`/`cfg` on the encoder,
    // no `quality` on SaveAudioMP3) and omitted 9 required encoder inputs, so
    // ComfyUI rejected every generated graph with "Required input is missing".
    // This asserts the exact runtime contract of comfy_extras.nodes_ace.
    it("emits every required input for the current comfy_extras.nodes_ace schema (#448)", async () => {
      const { deps, enqueued } = makeDeps();
      await generateAudio(
        {
          model_family: "ace_step_1.5",
          prompt: "ambient pads",
          duration: 60,
          unet: "acestep_v1.5_xl_sft_bf16.safetensors",
          musical_key: "E minor",
          guidance_scale: 3.5,
        },
        deps,
      );
      // Round-trip through JSON: ComfyUI receives the serialized graph, and any
      // `undefined` input silently disappears on serialization — which is
      // exactly the "Required input is missing" failure mode of #448. Asserting
      // on the post-serialization object catches present-but-undefined fields.
      const wf = JSON.parse(JSON.stringify(enqueued[0])) as WorkflowJSON;

      // 1. UNETLoader takes `unet_name`, never `ckpt_name`.
      const unetLoader = byClass(wf, "UNETLoader");
      expect(unetLoader?.inputs.unet_name).toBe("acestep_v1.5_xl_sft_bf16.safetensors");
      expect(unetLoader?.inputs).not.toHaveProperty("ckpt_name");

      // 2. TextEncodeAceStepAudio1.5 must supply all required inputs (each with
      //    a defined, serializable value) and must not carry the retired
      //    `text`/`cfg`/`key` names.
      const enc = byClass(wf, "TextEncodeAceStepAudio1.5");
      expect(enc).toBeDefined();
      for (const req of [
        "tags",
        "lyrics",
        "seed",
        "bpm",
        "duration",
        "timesignature",
        "language",
        "keyscale",
        "generate_audio_codes",
        "cfg_scale",
        "temperature",
        "top_p",
        "top_k",
        "min_p",
      ]) {
        // After the JSON round-trip an `undefined` value would have been
        // dropped, so hasOwnProperty here proves the field is really present.
        expect(
          Object.prototype.hasOwnProperty.call(enc?.inputs ?? {}, req),
          `encoder missing required input: ${req}`,
        ).toBe(true);
        expect(enc?.inputs[req], `encoder input ${req} is undefined`).not.toBeUndefined();
      }
      expect(enc?.inputs).not.toHaveProperty("text");
      expect(enc?.inputs).not.toHaveProperty("cfg");
      expect(enc?.inputs).not.toHaveProperty("key");
      expect(typeof enc?.inputs.generate_audio_codes).toBe("boolean");
      // Concrete values / arg mappings.
      expect(enc?.inputs.tags).toBe("ambient pads"); // prompt -> tags
      expect(enc?.inputs.duration).toBe(60);
      expect(enc?.inputs.keyscale).toBe("E minor"); // musical_key -> keyscale
      expect(enc?.inputs.cfg_scale).toBe(3.5); // guidance_scale -> cfg_scale

      // 3. SaveAudioMP3 requires `quality`.
      const save = byClass(wf, "SaveAudioMP3");
      expect(save?.inputs.quality).toBeDefined();
      expect(["V0", "128k", "320k"]).toContain(save?.inputs.quality);
    });

    // Regression for #501 (bug 5): the generate_audio tool/service dropped the
    // ACE encoder's musical controls (bpm, timesignature, temperature, top_p,
    // top_k, min_p, generate_audio_codes) and SaveAudioMP3 `quality` — they were
    // absent from DEFAULTABLE_KEYS and the createWorkflow passthrough, so callers
    // could never change them off the composer defaults. They must now flow all
    // the way into the emitted graph.
    it("threads bpm/timesignature/LLM-sampling controls + audio_quality into the graph (#501)", async () => {
      const { deps, enqueued } = makeDeps();
      await generateAudio(
        {
          model_family: "ace_step_1.5",
          prompt: "uptempo synthwave",
          duration: 40,
          unet: "ace.safetensors",
          bpm: 90,
          timesignature: "3",
          temperature: 1.1,
          top_p: 0.8,
          top_k: 50,
          min_p: 0.05,
          generate_audio_codes: false,
          audio_quality: "V0",
        },
        deps,
      );
      const wf = JSON.parse(JSON.stringify(enqueued[0])) as WorkflowJSON;
      const enc = byClass(wf, "TextEncodeAceStepAudio1.5");
      expect(enc?.inputs.bpm).toBe(90);
      expect(enc?.inputs.timesignature).toBe("3");
      expect(enc?.inputs.temperature).toBe(1.1);
      expect(enc?.inputs.top_p).toBe(0.8);
      expect(enc?.inputs.top_k).toBe(50);
      expect(enc?.inputs.min_p).toBe(0.05);
      expect(enc?.inputs.generate_audio_codes).toBe(false);
      const save = byClass(wf, "SaveAudioMP3");
      expect(save?.inputs.quality).toBe("V0");
    });

    it("auto-resolves UNet/VAE/CLIP from local models when not specified", async () => {
      const { deps, resolveFirstModel } = makeDeps();
      await generateAudio({ model_family: "ace_step_1.5", prompt: "p", duration: 10 }, deps);
      expect(resolveFirstModel).toHaveBeenCalledWith("diffusion_models");
      expect(resolveFirstModel).toHaveBeenCalledWith("vae");
      expect(resolveFirstModel).toHaveBeenCalledWith("text_encoders");
    });

    it("throws a helpful error when no UNet is available", async () => {
      const { deps } = makeDeps({ diffusion_models: undefined });
      await expect(
        generateAudio({ model_family: "ace_step_1.5", prompt: "p", duration: 10 }, deps),
      ).rejects.toThrow(/no unet/i);
    });
  });

  describe("Stable Audio 3", () => {
    it("builds a Stable Audio 3 graph with the prompt and duration wired in", async () => {
      const { deps, enqueued } = makeDeps();
      const res = await generateAudio(
        {
          model_family: "stable_audio_3",
          prompt: "rain on a tin roof",
          duration: 45,
          checkpoint: "stable_audio.safetensors",
        },
        deps,
      );

      expect(res.model_family).toBe("stable_audio_3");
      const wf = enqueued[0];
      expect(byClass(wf, "CheckpointLoaderSimple")?.inputs.ckpt_name).toBe(
        "stable_audio.safetensors",
      );
      const positive = Object.values(wf).find(
        (n) => n.class_type === "CLIPTextEncode" && n._meta?.title === "Positive Prompt",
      );
      expect(positive?.inputs.text).toBe("rain on a tin roof");
      expect(byClass(wf, "EmptyLatentAudio")?.inputs.seconds).toBe(45);
    });

    it("throws a helpful error when no checkpoint is available", async () => {
      const { deps } = makeDeps({ checkpoints: undefined });
      await expect(
        generateAudio({ model_family: "stable_audio_3", prompt: "p", duration: 10 }, deps),
      ).rejects.toThrow(/no checkpoint/i);
    });
  });

  describe("validation", () => {
    it("rejects an empty prompt", async () => {
      const { deps } = makeDeps();
      await expect(
        generateAudio({ model_family: "ace_step_1.5", prompt: "", duration: 10 }, deps),
      ).rejects.toThrow(/prompt is required/i);
    });

    it("rejects a non-positive duration", async () => {
      const { deps } = makeDeps();
      await expect(
        generateAudio({ model_family: "ace_step_1.5", prompt: "p", duration: 0 }, deps),
      ).rejects.toThrow(/duration must be a positive number/i);
    });
  });

  it("backfills unspecified params from DefaultsManager", async () => {
    await DefaultsManager.set({ steps: 12, cfg: 4.5 });
    const { deps, enqueued } = makeDeps();
    await generateAudio(
      { model_family: "ace_step_1.5", prompt: "p", duration: 10, unet: "ace.safetensors" },
      deps,
    );
    const ksampler = byClass(enqueued[0], "KSampler");
    expect(ksampler?.inputs.steps).toBe(12);
    expect(ksampler?.inputs.cfg).toBe(4.5);
  });
});
