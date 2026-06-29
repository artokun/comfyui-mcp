import type { WorkflowJSON, WorkflowNode } from "../comfyui/types.js";
import { ValidationError } from "../utils/errors.js";

// --- Helpers ---

export function getNextNodeId(workflow: WorkflowJSON): string {
  const ids = Object.keys(workflow).map(Number).filter((n) => !Number.isNaN(n));
  return String(ids.length === 0 ? 1 : Math.max(...ids) + 1);
}

function conn(nodeId: string, outputIndex: number): [string, number] {
  return [nodeId, outputIndex];
}

// --- Template parameter types ---

interface Txt2ImgParams {
  checkpoint?: string;
  positive_prompt?: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
  sampler_name?: string;
  scheduler?: string;
}

interface Img2ImgParams extends Txt2ImgParams {
  image_path?: string;
  denoise?: number;
}

interface UpscaleParams {
  upscale_model?: string;
  image_path?: string;
  /** Net upscale factor. With the default 4x model, scale=2 supersamples the 4x
   *  result back down by half (sharper, fewer artifacts). Default 4. */
  scale?: 2 | 4;
}

interface InpaintParams extends Img2ImgParams {
  mask_path?: string;
}

interface ControlNetParams extends Txt2ImgParams {
  control_image?: string;
  controlnet_model?: string;
  strength?: number;
}

interface IpAdapterParams extends Txt2ImgParams {
  reference_image?: string;
  weight?: number;
  preset?: string;
}

type TemplateParams =
  | Txt2ImgParams
  | Img2ImgParams
  | UpscaleParams
  | InpaintParams
  | ControlNetParams
  | IpAdapterParams
  | RemoveBackgroundParams
  | LtxVideoParams;

// --- Templates ---

function buildTxt2Img(p: Txt2ImgParams): WorkflowJSON {
  const ckpt = p.checkpoint ?? "sd_xl_base_1.0.safetensors";
  const positive = p.positive_prompt ?? "";
  const negative = p.negative_prompt ?? "";
  const width = p.width ?? 1024;
  const height = p.height ?? 1024;
  const steps = p.steps ?? 20;
  const cfg = p.cfg ?? 8.0;
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 48);
  const sampler = p.sampler_name ?? "euler";
  const scheduler = p.scheduler ?? "normal";

  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: ckpt },
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { text: positive, clip: conn("1", 1) },
      _meta: { title: "Positive Prompt" },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: negative, clip: conn("1", 1) },
      _meta: { title: "Negative Prompt" },
    },
    "4": {
      class_type: "EmptyLatentImage",
      inputs: { width, height, batch_size: 1 },
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        model: conn("1", 0),
        positive: conn("2", 0),
        negative: conn("3", 0),
        latent_image: conn("4", 0),
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        denoise: 1.0,
      },
    },
    "6": {
      class_type: "VAEDecode",
      inputs: { samples: conn("5", 0), vae: conn("1", 2) },
    },
    "7": {
      class_type: "SaveImage",
      inputs: { images: conn("6", 0), filename_prefix: "ComfyUI" },
    },
  };
}

function buildImg2Img(p: Img2ImgParams): WorkflowJSON {
  const ckpt = p.checkpoint ?? "sd_xl_base_1.0.safetensors";
  const positive = p.positive_prompt ?? "";
  const negative = p.negative_prompt ?? "";
  const steps = p.steps ?? 20;
  const cfg = p.cfg ?? 8.0;
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 48);
  const sampler = p.sampler_name ?? "euler";
  const scheduler = p.scheduler ?? "normal";
  const denoise = p.denoise ?? 0.75;
  const imagePath = p.image_path ?? "input.png";

  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: ckpt },
    },
    "2": {
      class_type: "LoadImage",
      inputs: { image: imagePath },
    },
    "3": {
      class_type: "VAEEncode",
      inputs: { pixels: conn("2", 0), vae: conn("1", 2) },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: { text: positive, clip: conn("1", 1) },
      _meta: { title: "Positive Prompt" },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: { text: negative, clip: conn("1", 1) },
      _meta: { title: "Negative Prompt" },
    },
    "6": {
      class_type: "KSampler",
      inputs: {
        model: conn("1", 0),
        positive: conn("4", 0),
        negative: conn("5", 0),
        latent_image: conn("3", 0),
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        denoise,
      },
    },
    "7": {
      class_type: "VAEDecode",
      inputs: { samples: conn("6", 0), vae: conn("1", 2) },
    },
    "8": {
      class_type: "SaveImage",
      inputs: { images: conn("7", 0), filename_prefix: "ComfyUI" },
    },
  };
}

function buildUpscale(p: UpscaleParams): WorkflowJSON {
  // 4x-ClearRealityV1 is a clean general-purpose ESRGAN model already shipped by
  // the anima/ernie packs (models/upscale_models/). The model itself is 4x; a
  // scale of 2 supersamples the 4x result back down by half (sharper, fewer
  // artifacts) — the "4x→2x supersample" recipe from the video-upscale skill.
  const model = p.upscale_model ?? "4x-ClearRealityV1.pth";
  const imagePath = p.image_path ?? "input.png";
  const scale = p.scale ?? 4;

  const wf: WorkflowJSON = {
    "1": {
      class_type: "LoadImage",
      inputs: { image: imagePath },
    },
    "2": {
      class_type: "UpscaleModelLoader",
      inputs: { model_name: model },
    },
    "3": {
      class_type: "ImageUpscaleWithModel",
      inputs: { upscale_model: conn("2", 0), image: conn("1", 0) },
    },
  };

  let imageOut = "3";
  if (scale === 2) {
    // Downsample the model's 4x output by half → net 2x, with anti-aliasing.
    wf["4"] = {
      class_type: "ImageScaleBy",
      inputs: { image: conn("3", 0), upscale_method: "lanczos", scale_by: 0.5 },
    };
    imageOut = "4";
  }

  const saveId = scale === 2 ? "5" : "4";
  wf[saveId] = {
    class_type: "SaveImage",
    inputs: { images: conn(imageOut, 0), filename_prefix: "ComfyUI_upscale" },
  };
  return wf;
}

// =============================================================
// Background removal
// =============================================================

interface RemoveBackgroundParams {
  image_path?: string;
  /** BiRefNet model file (ComfyUI-RMBG auto-downloads it on first run). */
  model?: string;
  filename_prefix?: string;
}

// Uses ComfyUI-RMBG's BiRefNetRMBG node (cnr id: comfyui-rmbg). The node loads a
// BiRefNet matting model (auto-downloaded to models/RMBG/BiRefNet/ on first use)
// and outputs the cutout (IMAGE, output 0), a MASK, and a MASK_IMAGE. We save the
// transparent cutout. Proven in packs/wan-transparent.
function buildRemoveBackground(p: RemoveBackgroundParams): WorkflowJSON {
  const imagePath = p.image_path ?? "input.png";
  const model = p.model ?? "BiRefNet_toonout";
  const prefix = p.filename_prefix ?? "ComfyUI_cutout";

  return {
    "1": {
      class_type: "LoadImage",
      inputs: { image: imagePath },
    },
    "2": {
      class_type: "BiRefNetRMBG",
      // `background: "Alpha"` forces a transparent RGBA cutout regardless of the
      // node version's default (matches packs/wan-transparent). The remaining
      // widgets (mask blur/offset, invert, refine) keep their defaults.
      inputs: { image: conn("1", 0), model, background: "Alpha" },
    },
    "3": {
      class_type: "SaveImage",
      inputs: { images: conn("2", 0), filename_prefix: prefix },
    },
  };
}

// =============================================================
// LTX-2.3 video generation
// =============================================================

interface LtxVideoParams {
  prompt?: string;
  negative_prompt?: string;
  /** When set, builds an image-to-video graph seeded from this input image. */
  image_path?: string;
  checkpoint?: string;
  text_encoder?: string;
  distilled_lora?: string;
  abliterated_lora?: string;
  width?: number;
  height?: number;
  /** Frame count — must be 8n+1 (the caller normalizes this). */
  length?: number;
  fps?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
  sampler_name?: string;
  /** i2v adherence to the start frame (LTXVImgToVideoInplace widget). Higher =
   *  more adherence but LESS motion; 1.0 freezes the clip. Skill/pack-verified
   *  default 0.6 — the "LTX strength gotcha" (see plugin/skills/ltxv2-video). */
  strength?: number;
  filename_prefix?: string;
}

// LTX-2.3 distilled, video-only, single-stage graph built on the render-verified
// Comfy-Org node stack (all CORE comfy_extras): CheckpointLoaderSimple +
// LTXAVTextEncoderLoader (gemma + checkpoint) + the gemma-abliterated CLIP LoRA
// (prompt/eyes accuracy) + the dynamic distilled speed LoRA @0.5, sampled with
// SamplerCustomAdvanced (CFGGuider cfg=1, euler, LTXVScheduler). This deliberately
// OMITS the 48kHz audio track and the stage-2 latent spatial upscale that the full
// ltx-2.3 packs ship — load those packs for maximum fidelity. Node I/O verified
// against packs/ltx-2.3-img2vid/workflow.json.
function buildLtxVideo(p: LtxVideoParams): WorkflowJSON {
  const ckpt = p.checkpoint ?? "ltx-2.3-22b-dev.safetensors";
  const textEncoder = p.text_encoder ?? "gemma_3_12B_it_fp8_scaled.safetensors";
  const distilledLora =
    p.distilled_lora ??
    "ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors";
  const abliteratedLora =
    p.abliterated_lora ?? "gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors";
  const width = p.width ?? 768;
  const height = p.height ?? 512;
  const length = p.length ?? 97;
  const fps = p.fps ?? 25;
  const steps = p.steps ?? 8;
  const cfg = p.cfg ?? 1.0;
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 48);
  const sampler = p.sampler_name ?? "euler";
  const prompt = p.prompt ?? "";
  const negative = p.negative_prompt ?? "";
  const strength = p.strength ?? 0.6;
  const prefix = p.filename_prefix ?? "video/ltx-2.3";
  const isI2v = Boolean(p.image_path);

  const wf: WorkflowJSON = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } },
    "2": {
      class_type: "LTXAVTextEncoderLoader",
      inputs: { text_encoder: textEncoder, ckpt_name: ckpt },
    },
    // distilled speed LoRA on the checkpoint model @0.5 (this is the model the
    // guider samples with — matches the pack's LoraLoaderModelOnly placement).
    "3": {
      class_type: "LoraLoaderModelOnly",
      inputs: { model: conn("1", 0), lora_name: distilledLora, strength_model: 0.5 },
    },
    // gemma abliterated LoRA — used for its CLIP output (prompt/eyes accuracy);
    // the model output is left unused, mirroring the pack.
    "4": {
      class_type: "LoraLoader",
      inputs: {
        model: conn("3", 0),
        clip: conn("2", 0),
        lora_name: abliteratedLora,
        strength_model: 1.0,
        strength_clip: 1.0,
      },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: { text: prompt, clip: conn("4", 1) },
      _meta: { title: "Positive Prompt" },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: negative, clip: conn("4", 1) },
      _meta: { title: "Negative Prompt" },
    },
    "7": {
      class_type: "LTXVConditioning",
      inputs: { positive: conn("5", 0), negative: conn("6", 0), frame_rate: fps },
    },
  };

  // Conditioning (positive/negative) is shared by both modes — it comes straight
  // from LTXVConditioning (#7). Only the LATENT differs: t2v uses an empty video
  // latent; i2v bakes the start frame into that same empty latent via
  // LTXVImgToVideoInplace (the node the ltx-2.3 packs actually use — there is no
  // `LTXVImgToVideo` in any pack). LTXVImgToVideoInplace takes vae+image+latent
  // and re-emits a LATENT; `strength` and `bypass` are WIDGETS, not outputs.
  const condPos: [string, number] = conn("7", 0);
  const condNeg: [string, number] = conn("7", 1);
  let latent: [string, number];

  // Empty video latent (matches the pack's EmptyLTXVLatentVideo widget order).
  wf["8"] = {
    class_type: "EmptyLTXVLatentVideo",
    inputs: { width, height, length, batch_size: 1 },
  };

  if (isI2v) {
    wf["9"] = { class_type: "LoadImage", inputs: { image: p.image_path } };
    wf["10"] = {
      class_type: "LTXVImgToVideoInplace",
      inputs: {
        vae: conn("1", 2),
        image: conn("9", 0),
        latent: conn("8", 0),
        strength, // widget: start-frame adherence (the "LTX strength gotcha")
        bypass: false, // widget: false = apply the image (true = pure t2v)
      },
    };
    latent = conn("10", 0);
  } else {
    latent = conn("8", 0);
  }

  wf["20"] = { class_type: "RandomNoise", inputs: { noise_seed: seed } };
  wf["21"] = { class_type: "KSamplerSelect", inputs: { sampler_name: sampler } };
  wf["22"] = {
    class_type: "LTXVScheduler",
    inputs: {
      steps,
      max_shift: 2.05,
      base_shift: 0.95,
      stretch: true,
      terminal: 0.1,
      latent,
    },
  };
  wf["23"] = {
    // Model = distilled-LoRA path (#3); the abliterated LoRA (#4) only conditions
    // the CLIP that feeds the text encodes — mirrors the pack's guider wiring.
    class_type: "CFGGuider",
    inputs: { model: conn("3", 0), positive: condPos, negative: condNeg, cfg },
  };
  wf["24"] = {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: conn("20", 0),
      guider: conn("23", 0),
      sampler: conn("21", 0),
      sigmas: conn("22", 0),
      latent_image: latent,
    },
  };
  wf["25"] = {
    class_type: "VAEDecode",
    inputs: { samples: conn("24", 0), vae: conn("1", 2) },
  };
  wf["26"] = { class_type: "CreateVideo", inputs: { images: conn("25", 0), fps } };
  wf["27"] = {
    class_type: "SaveVideo",
    inputs: { video: conn("26", 0), filename_prefix: prefix },
  };
  return wf;
}

function buildInpaint(p: InpaintParams): WorkflowJSON {
  const ckpt = p.checkpoint ?? "sd_xl_base_1.0.safetensors";
  const positive = p.positive_prompt ?? "";
  const negative = p.negative_prompt ?? "";
  const steps = p.steps ?? 20;
  const cfg = p.cfg ?? 8.0;
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 48);
  const sampler = p.sampler_name ?? "euler";
  const scheduler = p.scheduler ?? "normal";
  const denoise = p.denoise ?? 0.85;
  const imagePath = p.image_path ?? "input.png";
  const maskPath = p.mask_path ?? "mask.png";

  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: ckpt },
    },
    "2": {
      class_type: "LoadImage",
      inputs: { image: imagePath },
      _meta: { title: "Input Image" },
    },
    "3": {
      class_type: "LoadImage",
      inputs: { image: maskPath },
      _meta: { title: "Mask" },
    },
    "4": {
      class_type: "VAEEncode",
      inputs: { pixels: conn("2", 0), vae: conn("1", 2) },
    },
    "5": {
      class_type: "SetLatentNoiseMask",
      inputs: { samples: conn("4", 0), mask: conn("3", 1) },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: positive, clip: conn("1", 1) },
      _meta: { title: "Positive Prompt" },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { text: negative, clip: conn("1", 1) },
      _meta: { title: "Negative Prompt" },
    },
    "8": {
      class_type: "KSampler",
      inputs: {
        model: conn("1", 0),
        positive: conn("6", 0),
        negative: conn("7", 0),
        latent_image: conn("5", 0),
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        denoise,
      },
    },
    "9": {
      class_type: "VAEDecode",
      inputs: { samples: conn("8", 0), vae: conn("1", 2) },
    },
    "10": {
      class_type: "SaveImage",
      inputs: { images: conn("9", 0), filename_prefix: "ComfyUI_inpaint" },
    },
  };
}

function buildControlNet(p: ControlNetParams): WorkflowJSON {
  const ckpt = p.checkpoint ?? "sd_xl_base_1.0.safetensors";
  const positive = p.positive_prompt ?? "";
  const negative = p.negative_prompt ?? "";
  const width = p.width ?? 1024;
  const height = p.height ?? 1024;
  const steps = p.steps ?? 20;
  const cfg = p.cfg ?? 8.0;
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 48);
  const sampler = p.sampler_name ?? "euler";
  const scheduler = p.scheduler ?? "normal";
  const controlNet = p.controlnet_model ?? "control_v11p_sd15_canny.pth";
  const controlImage = p.control_image ?? "control.png";
  const strength = p.strength ?? 1.0;

  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } },
    "2": {
      class_type: "LoadImage",
      inputs: { image: controlImage },
      _meta: { title: "Control Image" },
    },
    "3": { class_type: "ControlNetLoader", inputs: { control_net_name: controlNet } },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: { text: positive, clip: conn("1", 1) },
      _meta: { title: "Positive Prompt" },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: { text: negative, clip: conn("1", 1) },
      _meta: { title: "Negative Prompt" },
    },
    "6": {
      class_type: "ControlNetApplyAdvanced",
      inputs: {
        positive: conn("4", 0),
        negative: conn("5", 0),
        control_net: conn("3", 0),
        image: conn("2", 0),
        strength,
        start_percent: 0.0,
        end_percent: 1.0,
      },
    },
    "7": {
      class_type: "EmptyLatentImage",
      inputs: { width, height, batch_size: 1 },
    },
    "8": {
      class_type: "KSampler",
      inputs: {
        model: conn("1", 0),
        positive: conn("6", 0),
        negative: conn("6", 1),
        latent_image: conn("7", 0),
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        denoise: 1.0,
      },
    },
    "9": { class_type: "VAEDecode", inputs: { samples: conn("8", 0), vae: conn("1", 2) } },
    "10": {
      class_type: "SaveImage",
      inputs: { images: conn("9", 0), filename_prefix: "ComfyUI_controlnet" },
    },
  };
}

// =============================================================
// Audio generation templates
// =============================================================

interface AceStep15Txt2AudioParams {
  unet?: string;
  vae?: string;
  clip_a?: string;
  clip_b?: string;
  prompt?: string;
  lyrics?: string;
  duration?: number;
  seed?: number;
  steps?: number;
  cfg?: number;
  sampler_name?: string;
  scheduler?: string;
  shift?: number;
  language?: string;
  musical_key?: string;
  guidance_scale?: number;
  filename_prefix?: string;
}

interface StableAudio3Txt2AudioParams {
  checkpoint?: string;
  clip?: string;
  prompt?: string;
  negative_prompt?: string;
  duration?: number;
  seed?: number;
  steps?: number;
  cfg?: number;
  sampler_name?: string;
  scheduler?: string;
  filename_prefix?: string;
}

function buildAceStep15Txt2Audio(p: AceStep15Txt2AudioParams): WorkflowJSON {
  const unet = p.unet ?? "acestep_v1.5_xl_sft_bf16.safetensors";
  const vae = p.vae ?? "ace_1.5_vae.safetensors";
  const clipA = p.clip_a ?? "qwen_0.6b_ace15.safetensors";
  const clipB = p.clip_b ?? "qwen_4b_ace15.safetensors";
  const prompt = p.prompt ?? "";
  const lyrics = p.lyrics ?? "";
  const duration = p.duration ?? 60;
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 48);
  const steps = p.steps ?? 50;
  const cfg = p.cfg ?? 7;
  const sampler = p.sampler_name ?? "euler";
  const scheduler = p.scheduler ?? "simple";
  const shift = p.shift ?? 3;
  const language = p.language ?? "en";
  const key = p.musical_key ?? "C major";
  const posCfg = p.guidance_scale ?? 0.85;
  const prefix = p.filename_prefix ?? "audio/ace_step";

  return {
    "1": {
      class_type: "UNETLoader",
      inputs: { ckpt_name: unet, weight_dtype: "default" },
    },
    "2": {
      class_type: "DualCLIPLoader",
      inputs: {
        clip_name1: clipA,
        clip_name2: clipB,
        type: "ace",
      },
    },
    "3": {
      class_type: "VAELoader",
      inputs: { vae_name: vae },
    },
    "4": {
      class_type: "ModelSamplingAuraFlow",
      inputs: { model: conn("1", 0), shift },
    },
    "5": {
      class_type: "EmptyAceStep1.5LatentAudio",
      inputs: { seconds: duration, batch_size: 1 },
    },
    "6": {
      class_type: "TextEncodeAceStepAudio1.5",
      inputs: {
        clip: conn("2", 0),
        seed,
        duration,
        text: prompt,
        lyrics,
        language,
        key,
        cfg: posCfg,
      },
    },
    "7": {
      class_type: "ConditioningZeroOut",
      inputs: { conditioning: conn("6", 0) },
    },
    "8": {
      class_type: "KSampler",
      inputs: {
        model: conn("4", 0),
        positive: conn("6", 0),
        negative: conn("7", 0),
        latent_image: conn("5", 0),
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        denoise: 1.0,
      },
    },
    "9": {
      class_type: "VAEDecodeAudio",
      inputs: { samples: conn("8", 0), vae: conn("3", 0) },
    },
    "10": {
      class_type: "SaveAudioMP3",
      inputs: { audio: conn("9", 0), filename_prefix: prefix },
    },
  };
}

function buildStableAudio3Txt2Audio(p: StableAudio3Txt2AudioParams): WorkflowJSON {
  const checkpoint = p.checkpoint ?? "stable_audio_3_medium_base.safetensors";
  const clip = p.clip ?? "t5gemma_b_b_ul2.safetensors";
  const prompt = p.prompt ?? "";
  const negativePrompt = p.negative_prompt ?? "";
  const duration = p.duration ?? 60;
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 48);
  const steps = p.steps ?? 50;
  const cfg = p.cfg ?? 7;
  const sampler = p.sampler_name ?? "lcm";
  const scheduler = p.scheduler ?? "simple";
  const prefix = p.filename_prefix ?? "audio/stable_audio_3";

  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: checkpoint },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: { clip_name: clip, type: "stable_audio" },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { clip: conn("2", 0), text: prompt },
      _meta: { title: "Positive Prompt" },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: { clip: conn("2", 0), text: negativePrompt },
      _meta: { title: "Negative Prompt" },
    },
    "5": {
      class_type: "EmptyLatentAudio",
      inputs: { seconds: duration, batch_size: 1 },
    },
    "6": {
      class_type: "KSampler",
      inputs: {
        model: conn("1", 0),
        positive: conn("3", 0),
        negative: conn("4", 0),
        latent_image: conn("5", 0),
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        denoise: 1.0,
      },
    },
    "7": {
      class_type: "VAEDecodeAudio",
      inputs: { samples: conn("6", 0), vae: conn("1", 2) },
    },
    "8": {
      class_type: "SaveAudioMP3",
      inputs: { audio: conn("7", 0), filename_prefix: prefix },
    },
  };
}

// Requires the ComfyUI_IPAdapter_plus custom node pack (IPAdapterUnifiedLoader, IPAdapter).
function buildIpAdapter(p: IpAdapterParams): WorkflowJSON {
  const ckpt = p.checkpoint ?? "sd_xl_base_1.0.safetensors";
  const positive = p.positive_prompt ?? "";
  const negative = p.negative_prompt ?? "";
  const width = p.width ?? 1024;
  const height = p.height ?? 1024;
  const steps = p.steps ?? 20;
  const cfg = p.cfg ?? 8.0;
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 48);
  const sampler = p.sampler_name ?? "euler";
  const scheduler = p.scheduler ?? "normal";
  const refImage = p.reference_image ?? "reference.png";
  const weight = p.weight ?? 0.8;
  const preset = p.preset ?? "PLUS (high strength)";

  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } },
    "2": {
      class_type: "LoadImage",
      inputs: { image: refImage },
      _meta: { title: "Reference Image" },
    },
    "3": {
      class_type: "IPAdapterUnifiedLoader",
      inputs: { model: conn("1", 0), preset },
    },
    "4": {
      class_type: "IPAdapter",
      inputs: {
        model: conn("3", 0),
        ipadapter: conn("3", 1),
        image: conn("2", 0),
        weight,
        start_at: 0.0,
        end_at: 1.0,
      },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: { text: positive, clip: conn("1", 1) },
      _meta: { title: "Positive Prompt" },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: negative, clip: conn("1", 1) },
      _meta: { title: "Negative Prompt" },
    },
    "7": {
      class_type: "EmptyLatentImage",
      inputs: { width, height, batch_size: 1 },
    },
    "8": {
      class_type: "KSampler",
      inputs: {
        model: conn("4", 0),
        positive: conn("5", 0),
        negative: conn("6", 0),
        latent_image: conn("7", 0),
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        denoise: 1.0,
      },
    },
    "9": { class_type: "VAEDecode", inputs: { samples: conn("8", 0), vae: conn("1", 2) } },
    "10": {
      class_type: "SaveImage",
      inputs: { images: conn("9", 0), filename_prefix: "ComfyUI_ipadapter" },
    },
  };
}

const TEMPLATES: Record<string, (params: Record<string, unknown>) => WorkflowJSON> = {
  txt2img: (p) => buildTxt2Img(p as Txt2ImgParams),
  img2img: (p) => buildImg2Img(p as Img2ImgParams),
  upscale: (p) => buildUpscale(p as UpscaleParams),
  inpaint: (p) => buildInpaint(p as InpaintParams),
  controlnet: (p) => buildControlNet(p as ControlNetParams),
  ip_adapter: (p) => buildIpAdapter(p as IpAdapterParams),
  ace_step_15: (p) => buildAceStep15Txt2Audio(p as AceStep15Txt2AudioParams),
  stable_audio_3: (p) => buildStableAudio3Txt2Audio(p as StableAudio3Txt2AudioParams),
  remove_background: (p) => buildRemoveBackground(p as RemoveBackgroundParams),
  ltx_video: (p) => buildLtxVideo(p as LtxVideoParams),
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATES);

export function createWorkflow(
  template: string,
  params: Record<string, unknown> = {},
): WorkflowJSON {
  const builder = TEMPLATES[template];
  if (!builder) {
    throw new ValidationError(
      `Unknown template "${template}". Available: ${TEMPLATE_NAMES.join(", ")}`,
    );
  }
  return builder(params);
}

// --- Modification operations ---

interface SetInputOp {
  op: "set_input";
  node_id: string;
  input_name: string;
  value: unknown;
}

interface AddNodeOp {
  op: "add_node";
  class_type: string;
  inputs?: Record<string, unknown>;
  id?: string;
}

interface RemoveNodeOp {
  op: "remove_node";
  node_id: string;
}

interface ConnectOp {
  op: "connect";
  source_id: string;
  output_index: number;
  target_id: string;
  input_name: string;
}

interface InsertBetweenOp {
  op: "insert_between";
  source_id: string;
  output_index: number;
  target_id: string;
  input_name: string;
  new_class_type: string;
  new_inputs?: Record<string, unknown>;
}

export type ModifyOperation =
  | SetInputOp
  | AddNodeOp
  | RemoveNodeOp
  | ConnectOp
  | InsertBetweenOp;

function applySetInput(wf: WorkflowJSON, op: SetInputOp): void {
  const node = wf[op.node_id];
  if (!node) throw new ValidationError(`Node "${op.node_id}" not found`);
  node.inputs[op.input_name] = op.value;
}

function applyAddNode(wf: WorkflowJSON, op: AddNodeOp): string {
  const id = op.id ?? getNextNodeId(wf);
  if (wf[id]) throw new ValidationError(`Node ID "${id}" already exists`);
  wf[id] = {
    class_type: op.class_type,
    inputs: op.inputs ?? {},
  };
  return id;
}

function applyRemoveNode(wf: WorkflowJSON, op: RemoveNodeOp): void {
  if (!wf[op.node_id]) throw new ValidationError(`Node "${op.node_id}" not found`);
  delete wf[op.node_id];

  // Clean up any connections pointing to the removed node
  for (const node of Object.values(wf)) {
    for (const [key, val] of Object.entries(node.inputs)) {
      if (
        Array.isArray(val) &&
        val.length === 2 &&
        typeof val[0] === "string" &&
        val[0] === op.node_id
      ) {
        delete node.inputs[key];
      }
    }
  }
}

function applyConnect(wf: WorkflowJSON, op: ConnectOp): void {
  if (!wf[op.source_id]) throw new ValidationError(`Source node "${op.source_id}" not found`);
  if (!wf[op.target_id]) throw new ValidationError(`Target node "${op.target_id}" not found`);
  wf[op.target_id].inputs[op.input_name] = [op.source_id, op.output_index];
}

function applyInsertBetween(wf: WorkflowJSON, op: InsertBetweenOp): string {
  if (!wf[op.source_id]) throw new ValidationError(`Source node "${op.source_id}" not found`);
  if (!wf[op.target_id]) throw new ValidationError(`Target node "${op.target_id}" not found`);

  const newId = getNextNodeId(wf);
  const newInputs: Record<string, unknown> = { ...(op.new_inputs ?? {}) };

  // Connect the new node's first input to the original source
  // Find the first input name that isn't already set -- use a convention-based approach
  // The new node receives the source output on its primary input
  // We'll figure out the right input name by looking for common patterns
  const primaryInputNames = ["model", "clip", "samples", "latent_image", "image", "conditioning", "pixels"];
  let connected = false;
  for (const name of primaryInputNames) {
    if (!(name in newInputs)) {
      newInputs[name] = [op.source_id, op.output_index];
      connected = true;
      break;
    }
  }
  if (!connected) {
    // Fallback: add as first unused slot
    newInputs["input"] = [op.source_id, op.output_index];
  }

  wf[newId] = {
    class_type: op.new_class_type,
    inputs: newInputs,
  };

  // Rewire: target's input now points to the new node's output 0
  wf[op.target_id].inputs[op.input_name] = [newId, 0];

  return newId;
}

export function modifyWorkflow(
  workflow: WorkflowJSON,
  operations: ModifyOperation[],
): { workflow: WorkflowJSON; added_ids: string[] } {
  // Deep clone to avoid mutating the original
  const wf: WorkflowJSON = JSON.parse(JSON.stringify(workflow));
  const addedIds: string[] = [];

  for (const op of operations) {
    switch (op.op) {
      case "set_input":
        applySetInput(wf, op);
        break;
      case "add_node": {
        const id = applyAddNode(wf, op);
        addedIds.push(id);
        break;
      }
      case "remove_node":
        applyRemoveNode(wf, op);
        break;
      case "connect":
        applyConnect(wf, op);
        break;
      case "insert_between": {
        const id = applyInsertBetween(wf, op);
        addedIds.push(id);
        break;
      }
      default:
        throw new ValidationError(`Unknown operation: ${(op as { op: string }).op}`);
    }
  }

  return { workflow: wf, added_ids: addedIds };
}
