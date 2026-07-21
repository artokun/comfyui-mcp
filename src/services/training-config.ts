// Generates ostris ai-toolkit training configs (the YAML `run.py` consumes) from
// a high-level request. This is the "derived from AI Toolkit" core: we own the
// mapping (flow + base model + dataset + params) → ai-toolkit's config schema,
// and ai-toolkit does the actual training unchanged.
//
// Schema mirrors ai-toolkit's example configs / notebooks:
//   job: extension
//   config: { name, process: [ { type: sd_trainer, training_folder, device,
//     trigger_word, network{lora}, save, datasets[], train{}, model{}, sample{} } ] }
// Defaults come from the `ai-toolkit-trainer` SKILL param tables + character-
// consistency research (rank 16, quantize on 24GB, batch 1, 512/768/1024 buckets).
//
// Phase 1 ships ONE flow (character) on ONE model (Flux.1-dev). The MODEL_SPECS
// and FLOW map are structured so later phases add Z-Image / WAN / edit without
// reshaping callers.

import { stringify } from "yaml";

/** Base models we can train against. P1 = flux1-dev only; others are capability-
 *  gated until verified against the installed ai-toolkit (see plan). */
export type TrainerModel = "flux1-dev";

/** Training flow. P1 = character; style/slider/edit/video come later. */
export type TrainerFlow = "character";

/** Tunables a caller (or the LLM) may override. All optional — sane defaults below. */
export interface TrainParams {
  /** Total training steps. 500–4000 is the useful range; 200 for a smoke test. */
  steps: number;
  /** Learning rate. */
  lr: number;
  /** LoRA rank (linear + linear_alpha). 16 simple, 16–32 detailed. */
  rank: number;
  /** Resolution buckets. Flux likes multiple; drop to [512] to save VRAM. */
  resolution: number[];
  /** Micro-batch. 1 unless you have VRAM to spare. */
  batchSize: number;
  /** Checkpoint cadence (steps). */
  saveEvery: number;
  /** Sample-image cadence (steps). */
  sampleEvery: number;
  /** 8-bit mixed precision to fit Flux on a 24GB card. */
  quantize: boolean;
}

export const DEFAULT_PARAMS: TrainParams = {
  steps: 2000,
  lr: 1e-4,
  rank: 16,
  resolution: [512, 768, 1024],
  batchSize: 1,
  saveEvery: 250,
  sampleEvery: 250,
  quantize: true,
};

/** Per-model ai-toolkit knobs. Keyed by TrainerModel so new bases are additive. */
interface ModelSpec {
  /** HF repo id (or local path) ai-toolkit loads. */
  nameOrPath: string;
  /** Extra `model` block flags for this arch. */
  modelFlags: Record<string, unknown>;
  /** Scheduler used for both train + sample (must match). */
  scheduler: string;
  /** Optimizer that fits this arch on consumer VRAM. */
  optimizer: string;
  /** Compute dtype. */
  dtype: string;
  /** train_text_encoder — off for Flux. */
  trainTextEncoder: boolean;
}

const MODEL_SPECS: Record<TrainerModel, ModelSpec> = {
  "flux1-dev": {
    nameOrPath: "black-forest-labs/FLUX.1-dev",
    modelFlags: { is_flux: true, quantize: true },
    scheduler: "flowmatch",
    optimizer: "adamw8bit",
    dtype: "bf16",
    trainTextEncoder: false,
  },
};

export interface TrainingConfigInput {
  /** Job name — becomes the output folder + `.safetensors` basename. */
  name: string;
  flow: TrainerFlow;
  model: TrainerModel;
  /** Path to the dataset folder (images + same-basename `.txt` captions), as the
   *  training process will see it (a container path when run in Docker). */
  datasetPath: string;
  /** Root the trainer writes checkpoints/samples into (`training_folder`). */
  outputDir: string;
  /** Optional trigger word — injected into captions / usable as `[trigger]`. */
  trigger?: string;
  /** GPU selector. */
  device?: string;
  /** Optional param overrides. */
  params?: Partial<TrainParams>;
  /** Optional sample prompts; `[trigger]` is substituted. Defaults provided. */
  samplePrompts?: string[];
  /** Override for `model.name_or_path` — a local model dir as the TRAINING
   *  process sees it (e.g. a pod path to a pre-uploaded HF snapshot), used
   *  when the default HF repo id can't be fetched (gated/offline). */
  modelPath?: string;
}

const DEFAULT_CHARACTER_PROMPTS = [
  "[trigger] a photo of the person, natural lighting, looking at the camera",
  "[trigger] the person in a city street, candid, golden hour",
  "[trigger] a close-up portrait of the person, soft studio lighting",
];

export interface BuiltTrainingConfig {
  /** ai-toolkit job name (== input.name, sanitized). */
  jobName: string;
  /** The config object (ordered to match ai-toolkit's examples). */
  config: Record<string, unknown>;
  /** YAML text to write and pass to `run.py`. */
  yaml: string;
}

/** ai-toolkit uses the job name as a filesystem path segment (it joins
 *  training_folder/name and writes there) — keep it safe. Dots-only names like
 *  "." / ".." would escape or collapse the per-job directory, so they fall back
 *  to "lora" (codex review finding #1). */
function sanitizeName(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!cleaned || /^\.+$/.test(cleaned)) return "lora";
  return cleaned;
}

/** Exported for callers that build job-scoped paths (pod job dirs) with the
 *  same rules the config generator applies internally. */
export const sanitizeJobName = sanitizeName;

/**
 * Build an ai-toolkit training config for the given request.
 * Throws on an unsupported flow/model so callers surface a clear error rather
 * than emitting a config ai-toolkit will choke on.
 */
export function buildTrainingConfig(input: TrainingConfigInput): BuiltTrainingConfig {
  if (input.flow !== "character") {
    throw new Error(`unsupported training flow "${input.flow}" (phase 1 supports: character)`);
  }
  const spec = MODEL_SPECS[input.model];
  if (!spec) {
    throw new Error(`unsupported base model "${input.model}" (phase 1 supports: flux1-dev)`);
  }

  const jobName = sanitizeName(input.name);
  // Drop undefined overrides so `{steps: undefined}` can't erase a default
  // (codex finding #3), then validate the merged values.
  const overrides = Object.fromEntries(
    Object.entries(input.params ?? {}).filter(([, v]) => v !== undefined),
  ) as Partial<TrainParams>;
  const p: TrainParams = { ...DEFAULT_PARAMS, ...overrides };
  if (!(p.steps > 0) || !(p.lr > 0) || !(p.rank > 0) || !(p.batchSize > 0) || !(p.saveEvery > 0) || !(p.sampleEvery > 0)) {
    throw new Error("invalid training params: steps/lr/rank/batchSize/saveEvery/sampleEvery must be positive");
  }
  if (!Array.isArray(p.resolution) || p.resolution.length === 0 || p.resolution.some((r) => !(r > 0))) {
    throw new Error("invalid training params: resolution must be a non-empty list of positive sizes");
  }
  const device = input.device ?? "cuda:0";
  // Function replacer: a trigger like "$&" must be inserted literally, not
  // interpreted as a String.replace special sequence (codex finding #2).
  const trigger = input.trigger;
  const prompts = (input.samplePrompts ?? DEFAULT_CHARACTER_PROMPTS).map((s) =>
    trigger ? s.replace(/\[trigger\]/g, () => trigger) : s.replace(/\[trigger\]\s*/g, ""),
  );

  const process: Record<string, unknown> = {
    type: "sd_trainer",
    training_folder: input.outputDir,
    device,
    ...(input.trigger ? { trigger_word: input.trigger } : {}),
    network: { type: "lora", linear: p.rank, linear_alpha: p.rank },
    save: { dtype: "float16", save_every: p.saveEvery, max_step_saves_to_keep: 4 },
    datasets: [
      {
        folder_path: input.datasetPath,
        caption_ext: "txt",
        caption_dropout_rate: 0.05,
        shuffle_tokens: false,
        cache_latents_to_disk: true,
        resolution: p.resolution,
      },
    ],
    train: {
      batch_size: p.batchSize,
      steps: p.steps,
      gradient_accumulation_steps: 1,
      train_unet: true,
      train_text_encoder: spec.trainTextEncoder,
      content_or_style: "balanced",
      gradient_checkpointing: true,
      noise_scheduler: spec.scheduler,
      optimizer: spec.optimizer,
      lr: p.lr,
      ema_config: { use_ema: true, ema_decay: 0.99 },
      dtype: spec.dtype,
    },
    model: {
      name_or_path: input.modelPath ?? spec.nameOrPath,
      ...spec.modelFlags,
      // Honor an explicit quantize override (e.g. off on a big card).
      quantize: p.quantize,
    },
    sample: {
      sampler: spec.scheduler,
      sample_every: p.sampleEvery,
      width: 1024,
      height: 1024,
      prompts,
      neg: "",
      seed: 42,
      walk_seed: true,
      guidance_scale: 4,
      sample_steps: 20,
    },
  };

  const config: Record<string, unknown> = {
    job: "extension",
    config: { name: jobName, process: [process] },
    meta: { name: "[name]", version: "1.0" },
  };

  return { jobName, config, yaml: stringify(config) };
}
