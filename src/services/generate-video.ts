import type { WorkflowJSON } from "../comfyui/types.js";
import { createWorkflow } from "./workflow-composer.js";
import { DefaultsManager } from "./defaults-manager.js";
import { ValidationError } from "../utils/errors.js";
import {
  assertSafeInputFilename,
  assertSafeFilenamePrefix,
} from "../utils/input-paths.js";

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
  /** i2v adherence to the start frame (0-1). Higher = less motion; 1.0 freezes it.
   *  Default 0.6 (the "LTX strength gotcha"). */
  strength?: number;
  checkpoint?: string;
  filename_prefix?: string;
}

export interface GenerateVideoDeps {
  /** List local model filenames for a category (may be empty; throws when the
   *  listing can't be obtained, e.g. no running server). */
  listModels: (type: string) => Promise<string[]>;
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

// Canonical LTX-2.3 dependency filenames (render-verified Comfy-Org stack).
const LTX_CHECKPOINTS = [
  "ltx-2.3-22b-dev.safetensors",
  "ltx-2.3-22b-dev-fp8.safetensors",
];
const GEMMA_ENCODER = "gemma_3_12B_it_fp8_scaled.safetensors";
const DISTILLED_LORA =
  "ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors";
const ABLITERATED_LORA = "gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors";

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

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** True if `name` (by basename, case-insensitive) is in the listing. */
function hasModel(listing: string[], name: string): boolean {
  const target = baseName(name).toLowerCase();
  return listing.some((m) => baseName(m).toLowerCase() === target);
}

/**
 * Return the first candidate present in `listing`, or push an actionable entry to
 * `missing` and return the primary candidate. When `listing` is null the model
 * roster couldn't be read (e.g. no running server) — we can't verify, so we
 * assume the primary candidate and skip the check rather than false-block.
 */
function requireModel(
  listing: string[] | null,
  candidates: string[],
  label: string,
  missing: string[],
): string {
  const primary = candidates[0];
  if (listing === null) return primary;
  for (const c of candidates) {
    if (hasModel(listing, c)) return c;
  }
  missing.push(`${label} (${candidates.join(" or ")})`);
  return primary;
}

/**
 * Compose + enqueue an LTX-2.3 distilled video workflow (text-to-video, or
 * image-to-video when `image` is given). Verifies the SPECIFIC LTX checkpoint,
 * gemma text encoder, and the two required LoRAs are present before enqueuing —
 * any missing dependency throws one actionable error pointing at the ltx-2.3
 * packs. Normalizes seconds → an 8n+1 frame count. Reuses the `ltx_video`
 * composer template.
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

  // Sanitize file-ish inputs before they reach LoadImage / SaveVideo.
  if (args.image !== undefined) assertSafeInputFilename(args.image, "image");

  const argsRecord = args as unknown as Record<string, unknown>;
  const seed: Record<string, unknown> = {};
  for (const key of DEFAULTABLE_KEYS) {
    const v = argsRecord[key];
    if (v !== undefined) seed[key] = v;
  }
  const resolved = DefaultsManager.apply(seed);

  const filenamePrefix = resolved.filename_prefix as string | undefined;
  if (filenamePrefix !== undefined) assertSafeFilenamePrefix(filenamePrefix);

  // Resolution: reject unparseable input rather than silently defaulting.
  let res: { width: number; height: number };
  if (args.resolution !== undefined) {
    const parsed = parseResolution(args.resolution);
    if (!parsed) {
      throw new ValidationError(
        `Invalid resolution "${args.resolution}": use "WIDTHxHEIGHT", e.g. "768x512".`,
      );
    }
    res = parsed;
  } else {
    res = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  }

  // Verify every required LTX dependency is actually present. A null listing
  // means we couldn't read the roster (no server) — verification is skipped.
  const safeList = async (type: string): Promise<string[] | null> => {
    try {
      return await deps.listModels(type);
    } catch {
      return null;
    }
  };
  const checkpointList = await safeList("checkpoints");
  const encoderList = await safeList("text_encoders");
  const loraList = await safeList("loras");

  // Only a per-call `args.checkpoint` is a deliberate override (presence-checked).
  // We deliberately do NOT widen the candidate list with an ambient DEFAULT
  // checkpoint: a global default set to a non-LTX model (e.g. an SD1.5 ckpt) would
  // otherwise be silently accepted and enqueue a broken LTX graph. With no explicit
  // arg we require one of the known LTX checkpoints.
  const explicitCheckpoint = args.checkpoint;

  const missing: string[] = [];
  const checkpoint = requireModel(
    checkpointList,
    explicitCheckpoint ? [explicitCheckpoint] : LTX_CHECKPOINTS,
    "LTX checkpoint",
    missing,
  );
  const textEncoder = requireModel(
    encoderList,
    [GEMMA_ENCODER],
    "Gemma text encoder",
    missing,
  );
  requireModel(loraList, [DISTILLED_LORA], "distilled speed LoRA", missing);
  requireModel(loraList, [ABLITERATED_LORA], "gemma abliterated LoRA", missing);

  if (missing.length > 0) {
    throw new ValidationError(
      `Missing required LTX-2.3 model file(s): ${missing.join("; ")}. Install them with ` +
        "apply_manifest --path packs/ltx-2.3-txt2vid/manifest.yaml (or ltx-2.3-img2vid " +
        "for image-to-video), or pass an explicit `checkpoint` you already have.",
    );
  }

  const fps = (resolved.fps as number | undefined) ?? DEFAULT_FPS;
  const seconds = args.seconds ?? DEFAULT_SECONDS;
  const length = normalizeFrameCount(seconds * fps);

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
    filename_prefix: filenamePrefix,
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
