import type { WorkflowJSON } from "../comfyui/types.js";
import { createWorkflow } from "./workflow-composer.js";
import { DefaultsManager } from "./defaults-manager.js";
import { ValidationError } from "../utils/errors.js";

export interface GenerateImageArgs {
  prompt: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  seed?: number;
  checkpoint?: string;
  batch_size?: number;
}

export interface GenerateImageDeps {
  /** Resolve a checkpoint filename when none is given or defaulted. */
  resolveCheckpoint: () => Promise<string | undefined>;
  /** Submit the constructed workflow; returns the prompt id. */
  enqueue: (
    workflow: WorkflowJSON,
  ) => Promise<{ prompt_id: string; queue_remaining?: number; rejectedOutputs?: string }>;
}

export interface GenerateImageResult {
  prompt_id: string;
  queue_remaining?: number;
  /** #1037 — output branches ComfyUI REFUSED while accepting the prompt. Present
   *  only when some were: the run WAS queued, and the accepted branches still
   *  produce output, so this is a disclosure attached to a success. */
  rejectedOutputs?: string;
  checkpoint: string;
}

// Keys the DefaultsManager may supply for image generation.
const DEFAULTABLE_KEYS = [
  "negative_prompt",
  "width",
  "height",
  "steps",
  "cfg",
  "sampler",
  "scheduler",
  "seed",
  "checkpoint",
  "batch_size",
] as const;

/**
 * Construct a txt2img workflow from `args` backfilled by DefaultsManager,
 * auto-resolving a checkpoint if needed, then enqueue it. Reuses the existing
 * workflow-composer txt2img template rather than building the node graph here.
 */
export async function generateImage(
  args: GenerateImageArgs,
  deps: GenerateImageDeps,
): Promise<GenerateImageResult> {
  // Backfill only the defaultable knobs; prompt is always caller-supplied.
  const seed: Record<string, unknown> = {};
  for (const key of DEFAULTABLE_KEYS) {
    const v = args[key];
    if (v !== undefined) seed[key] = v;
  }
  const resolved = DefaultsManager.apply(seed);

  let checkpoint = resolved.checkpoint as string | undefined;
  if (!checkpoint) {
    checkpoint = await deps.resolveCheckpoint();
  }
  if (!checkpoint) {
    throw new ValidationError(
      "No checkpoint specified, defaulted, or found locally. " +
        "Pass `checkpoint`, set a default via get_defaults (action:\"set\"), or download one with download_model.",
    );
  }

  const workflow = createWorkflow("txt2img", {
    checkpoint,
    positive_prompt: args.prompt,
    negative_prompt: resolved.negative_prompt as string | undefined,
    width: resolved.width as number | undefined,
    height: resolved.height as number | undefined,
    steps: resolved.steps as number | undefined,
    cfg: resolved.cfg as number | undefined,
    seed: resolved.seed as number | undefined,
    sampler_name: resolved.sampler as string | undefined,
    scheduler: resolved.scheduler as string | undefined,
  });

  const batchSize = resolved.batch_size as number | undefined;
  if (batchSize !== undefined && batchSize !== 1) {
    for (const node of Object.values(workflow)) {
      if (node.class_type === "EmptyLatentImage") {
        node.inputs.batch_size = batchSize;
      }
    }
  }

  const { prompt_id, queue_remaining, rejectedOutputs } = await deps.enqueue(workflow);
  return { prompt_id, queue_remaining, rejectedOutputs, checkpoint };
}
