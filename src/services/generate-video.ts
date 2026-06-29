import type { WorkflowJSON } from "../comfyui/types.js";
import { createWorkflow } from "./workflow-composer.js";
import { DefaultsManager } from "./defaults-manager.js";
import { ValidationError } from "../utils/errors.js";

export interface GenerateVideoArgs {
  prompt: string;
  /** When set, image-to-video from this input-dir filename (upload it first). */
  image?: string;
  negative_prompt?: string;
  /** Clip length in seconds (default 4). Converted to an 8n+1 frame count. */
  seconds?: number;
  /** "WIDTHxHEIGHT" (e.g. "768x512"); rounded to multiples of 32. */
  resolution?: string;
  fps?: number;
  seed?: number;
  steps?: number;
  cfg?: number;
  /** i2v adherence to the start frame (0-1). Higher = less motion; ~0.6 default. */
  strength?: number;
  checkpoint?: string;
  filename_prefix?: string;
}

export interface GenerateVideoDeps {
  resolveFirstModel: (type: string) => Promise<string | undefined>;
  enqueue: (workflow: WorkflowJSON) => Promise<{ prompt_id: string; queue_remaining?: number }>;
}

export interface GenerateVideoResult {
  prompt_id: string;
  queue_remaining?: number;
  mode: "t2v" | "i2v";
  checkpoint: string;
  width: number;
  height: number;
  length: number;
  fps: number;
}

const DEFAULT_SECONDS = 4;
const DEFAULT_FPS = 25;
const DEFAULT_WIDTH = 768;
const DEFAULT_HEIGHT = 512;
const MAX_FRAMES = 257; // LTX practical cap (~10s @25fps)

const DEFAULTABLE_KEYS = [
  "negative_prompt",
  "seed",
  "steps",
  "cfg",
  "fps",
  "checkpoint",
  "filename_prefix",
] as const;

/** Round to the nearest valid LTX frame count (8n+1), clamped to [9, MAX_FRAMES]. */
export function normalizeFrameCount(frames: number): number {
  const n = Math.max(1, Math.round((frames - 1) / 8));
  const length = n * 8 + 1;
  return Math.min(Math.max(length, 9), MAX_FRAMES);
}

/** Round a dimension to the nearest multiple of 32 (LTX requirement). */
function roundTo32(value: number): number {
  return Math.max(32, Math.round(value / 32) * 32);
}

/** Parse a "WIDTHxHEIGHT" string; returns undefined if it doesn't parse. */
export function parseResolution(
  resolution: string | undefined,
): { width: number; height: number } | undefined {
  if (!resolution) return undefined;
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(resolution.trim());
  if (!m) return undefined;
  const width = roundTo32(Number(m[1]));
  const height = roundTo32(Number(m[2]));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  return { width, height };
}

/**
 * Compose + enqueue an LTX-2.3 distilled video workflow (text-to-video, or
 * image-to-video when `image` is given). Resolves the LTX checkpoint + gemma
 * text encoder from local models, normalizes seconds → an 8n+1 frame count, and
 * throws an actionable error pointing at the ltx-2.3 packs when the models are
 * missing. Reuses the `ltx_video` composer template.
 */
export async function generateVideo(
  args: GenerateVideoArgs,
  deps: GenerateVideoDeps,
): Promise<GenerateVideoResult> {
  if (!args.prompt || !args.prompt.trim()) {
    throw new ValidationError("prompt is required for video generation.");
  }
  if (args.seconds !== undefined && args.seconds <= 0) {
    throw new ValidationError("seconds must be a positive number.");
  }
  if (args.strength !== undefined && (args.strength < 0 || args.strength > 1)) {
    throw new ValidationError("strength must be between 0 and 1.");
  }

  const argsRecord = args as unknown as Record<string, unknown>;
  const seed: Record<string, unknown> = {};
  for (const key of DEFAULTABLE_KEYS) {
    const v = argsRecord[key];
    if (v !== undefined) seed[key] = v;
  }
  const resolved = DefaultsManager.apply(seed);

  let checkpoint = (resolved.checkpoint as string | undefined) ?? args.checkpoint;
  if (!checkpoint) checkpoint = await deps.resolveFirstModel("checkpoints");
  if (!checkpoint) {
    throw new ValidationError(
      "No LTX checkpoint specified or found in models/checkpoints/. Install the LTX-2.3 " +
        "pack with apply_manifest --path packs/ltx-2.3-txt2vid/manifest.yaml (downloads " +
        "ltx-2.3-22b-dev.safetensors + the gemma text encoder + the distilled/abliterated " +
        "LoRAs), or pass `checkpoint`.",
    );
  }

  // The gemma text encoder is required by LTXAVTextEncoderLoader; auto-resolve it
  // but fall back to the canonical filename so the graph is still well-formed.
  const textEncoder =
    (await deps.resolveFirstModel("text_encoders")) ??
    "gemma_3_12B_it_fp8_scaled.safetensors";

  const fps = (resolved.fps as number | undefined) ?? DEFAULT_FPS;
  const seconds = args.seconds ?? DEFAULT_SECONDS;
  const length = normalizeFrameCount(seconds * fps);

  const res = parseResolution(args.resolution) ?? {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  };

  const mode: "t2v" | "i2v" = args.image ? "i2v" : "t2v";

  const workflow = createWorkflow("ltx_video", {
    prompt: args.prompt,
    negative_prompt: resolved.negative_prompt as string | undefined,
    image_path: args.image,
    checkpoint,
    text_encoder: textEncoder,
    width: res.width,
    height: res.height,
    length,
    fps,
    steps: resolved.steps as number | undefined,
    cfg: resolved.cfg as number | undefined,
    seed: resolved.seed as number | undefined,
    strength: args.strength,
    filename_prefix: resolved.filename_prefix as string | undefined,
  });

  const { prompt_id, queue_remaining } = await deps.enqueue(workflow);
  return {
    prompt_id,
    queue_remaining,
    mode,
    checkpoint,
    width: res.width,
    height: res.height,
    length,
    fps,
  };
}
