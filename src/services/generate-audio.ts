// Audio generation (ACE Step 1.5 + Stable Audio 3) originally contributed by
// @x-yahya997 in `x-yahya997/comfyui-mcp@c2ff7a9` and merged here with thanks.
import type { WorkflowJSON } from "../comfyui/types.js";
import { createWorkflow } from "./workflow-composer.js";
import { DefaultsManager } from "./defaults-manager.js";
import { ValidationError } from "../utils/errors.js";

export interface GenerateAudioArgs {
  model_family: "ace_step_1.5" | "stable_audio_3";
  prompt: string;
  duration: number;
  seed?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  filename_prefix?: string;

  // ACE-specific
  unet?: string;
  vae?: string;
  clip_a?: string;
  clip_b?: string;
  lyrics?: string;
  language?: string;
  musical_key?: string;
  shift?: number;
  guidance_scale?: number;
  bpm?: number;
  timesignature?: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  generate_audio_codes?: boolean;
  audio_quality?: string;

  // Stable Audio 3 specific
  checkpoint?: string;
  clip?: string;
  negative_prompt?: string;
}

export interface GenerateAudioDeps {
  resolveFirstModel: (type: string) => Promise<string | undefined>;
  enqueue: (workflow: WorkflowJSON) => Promise<{ prompt_id: string; queue_remaining?: number }>;
}

export interface GenerateAudioResult {
  prompt_id: string;
  queue_remaining?: number;
  model_family: string;
}

const DEFAULTABLE_KEYS = [
  "seed",
  "steps",
  "cfg",
  "sampler",
  "scheduler",
  "filename_prefix",
  "unet",
  "vae",
  "clip_a",
  "clip_b",
  "lyrics",
  "language",
  "musical_key",
  "shift",
  "guidance_scale",
  "bpm",
  "timesignature",
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "generate_audio_codes",
  "audio_quality",
  "checkpoint",
  "clip",
  "negative_prompt",
] as const;

export async function generateAudio(
  args: GenerateAudioArgs,
  deps: GenerateAudioDeps,
): Promise<GenerateAudioResult> {
  if (!args.prompt) {
    throw new ValidationError("prompt is required for audio generation");
  }
  if (!args.duration || args.duration <= 0) {
    throw new ValidationError("duration must be a positive number (in seconds)");
  }

  const argsRecord = args as unknown as Record<string, unknown>;
  const seed: Record<string, unknown> = {};
  for (const key of DEFAULTABLE_KEYS) {
    const v = argsRecord[key];
    if (v !== undefined) seed[key] = v;
  }
  const resolved = DefaultsManager.apply(seed);

  let checkpoint = resolved.checkpoint as string | undefined;
  let unet = resolved.unet as string | undefined;
  let vae = resolved.vae as string | undefined;
  let clip = resolved.clip as string | undefined;
  let clipA = resolved.clip_a as string | undefined;
  let clipB = resolved.clip_b as string | undefined;

  if (args.model_family === "ace_step_1.5") {
    if (!unet) unet = await deps.resolveFirstModel("diffusion_models");
    if (!vae) vae = await deps.resolveFirstModel("vae");
    if (!clipA) clipA = await deps.resolveFirstModel("text_encoders");

    if (!unet) {
      throw new ValidationError(
        "No UNet model specified or found locally for ACE Step 1.5. " +
          "Pass `unet` or download one via download_model.",
      );
    }

    const workflow = createWorkflow("ace_step_15", {
      unet,
      vae: vae ?? "ace_1.5_vae.safetensors",
      clip_a: clipA ?? "qwen_0.6b_ace15.safetensors",
      clip_b: clipB ?? "qwen_4b_ace15.safetensors",
      prompt: args.prompt,
      lyrics: resolved.lyrics as string | undefined,
      duration: args.duration,
      seed: resolved.seed as number | undefined,
      steps: resolved.steps as number | undefined,
      cfg: resolved.cfg as number | undefined,
      sampler_name: resolved.sampler as string | undefined,
      scheduler: resolved.scheduler as string | undefined,
      shift: resolved.shift as number | undefined,
      language: resolved.language as string | undefined,
      musical_key: resolved.musical_key as string | undefined,
      guidance_scale: resolved.guidance_scale as number | undefined,
      bpm: resolved.bpm as number | undefined,
      timesignature: resolved.timesignature as string | undefined,
      temperature: resolved.temperature as number | undefined,
      top_p: resolved.top_p as number | undefined,
      top_k: resolved.top_k as number | undefined,
      min_p: resolved.min_p as number | undefined,
      generate_audio_codes: resolved.generate_audio_codes as boolean | undefined,
      audio_quality: resolved.audio_quality as string | undefined,
      filename_prefix: resolved.filename_prefix as string | undefined,
    });

    const { prompt_id, queue_remaining } = await deps.enqueue(workflow);
    return { prompt_id, queue_remaining, model_family: "ace_step_1.5" };
  }

  // Stable Audio 3
  if (!checkpoint) {
    const models = await deps.resolveFirstModel("checkpoints");
    if (models) checkpoint = models;
  }
  if (!clip) clip = await deps.resolveFirstModel("text_encoders");
  if (!checkpoint) {
    throw new ValidationError(
      "No checkpoint specified or found locally for Stable Audio 3. " +
        "Pass `checkpoint` or download one via download_model.",
    );
  }

  const workflow = createWorkflow("stable_audio_3", {
    checkpoint,
    clip: clip ?? "t5gemma_b_b_ul2.safetensors",
    prompt: args.prompt,
    negative_prompt: resolved.negative_prompt as string | undefined,
    duration: args.duration,
    seed: resolved.seed as number | undefined,
    steps: resolved.steps as number | undefined,
    cfg: resolved.cfg as number | undefined,
    sampler_name: resolved.sampler as string | undefined,
    scheduler: resolved.scheduler as string | undefined,
    filename_prefix: resolved.filename_prefix as string | undefined,
  });

  const { prompt_id, queue_remaining } = await deps.enqueue(workflow);
  return { prompt_id, queue_remaining, model_family: "stable_audio_3" };
}
