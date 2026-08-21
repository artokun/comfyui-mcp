import type { WorkflowJSON } from "../comfyui/types.js";
import { createWorkflow } from "./workflow-composer.js";
import { DefaultsManager } from "./defaults-manager.js";
import { ValidationError } from "../utils/errors.js";

interface CommonArgs {
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
}

export interface ControlNetArgs extends CommonArgs {
  control_image: string;
  controlnet_model?: string;
  strength?: number;
}

export interface IpAdapterArgs extends CommonArgs {
  reference_image: string;
  weight?: number;
  preset?: string;
  /** IPAdapter weight mode ('standard' | 'prompt is more important' | 'style transfer'). */
  weight_type?: string;
}

export interface ConditionedDeps {
  resolveCheckpoint: () => Promise<string | undefined>;
  enqueue: (workflow: WorkflowJSON) => Promise<{ prompt_id: string; queue_remaining?: number }>;
  /** Optional: resolve a local ControlNet model when none is given/defaulted. */
  resolveControlNetModel?: () => Promise<string | undefined>;
}

export interface ConditionedResult {
  prompt_id: string;
  queue_remaining?: number;
  checkpoint: string;
}

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
] as const;

function withDefaults(args: CommonArgs): Record<string, unknown> {
  const seed: Record<string, unknown> = {};
  for (const key of DEFAULTABLE_KEYS) {
    const v = args[key];
    if (v !== undefined) seed[key] = v;
  }
  return DefaultsManager.apply(seed);
}

async function resolveCheckpointOrThrow(
  explicit: string | undefined,
  resolved: Record<string, unknown>,
  resolveCheckpoint: () => Promise<string | undefined>,
): Promise<string> {
  let checkpoint = explicit ?? (resolved.checkpoint as string | undefined);
  if (!checkpoint) checkpoint = await resolveCheckpoint();
  if (!checkpoint) {
    throw new ValidationError(
      "No checkpoint specified, defaulted, or found locally. " +
        "Pass `checkpoint`, set a default via get_defaults (action:\"set\"), or download one with download_model.",
    );
  }
  return checkpoint;
}

function commonTemplateParams(
  args: CommonArgs,
  resolved: Record<string, unknown>,
  checkpoint: string,
): Record<string, unknown> {
  return {
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
  };
}

/**
 * Build + enqueue a ControlNet-conditioned txt2img workflow. `control_image`
 * must already exist in ComfyUI's input dir (use upload_image (action:"image") first).
 */
export async function generateWithControlNet(
  args: ControlNetArgs,
  deps: ConditionedDeps,
): Promise<ConditionedResult> {
  if (!args.control_image) {
    throw new ValidationError("control_image is required (upload it first with upload_image (action:\"image\"))");
  }
  const resolved = withDefaults(args);
  const checkpoint = await resolveCheckpointOrThrow(args.checkpoint, resolved, deps.resolveCheckpoint);

  let controlnetModel = args.controlnet_model;
  if (!controlnetModel && deps.resolveControlNetModel) {
    controlnetModel = await deps.resolveControlNetModel();
  }
  if (!controlnetModel) {
    throw new ValidationError(
      "No controlnet_model specified and none found locally. Pass `controlnet_model` " +
        "(a file in models/controlnet/) or download one with download_model.",
    );
  }

  const workflow = createWorkflow("controlnet", {
    ...commonTemplateParams(args, resolved, checkpoint),
    control_image: args.control_image,
    controlnet_model: controlnetModel,
    strength: args.strength,
  });

  const { prompt_id, queue_remaining } = await deps.enqueue(workflow);
  return { prompt_id, queue_remaining, checkpoint };
}

/**
 * Build + enqueue an IP-Adapter-conditioned txt2img workflow. Requires the
 * ComfyUI_IPAdapter_plus custom nodes. `reference_image` must already exist in
 * ComfyUI's input dir (use upload_image (action:"image") first).
 */
export async function generateWithIpAdapter(
  args: IpAdapterArgs,
  deps: ConditionedDeps,
): Promise<ConditionedResult> {
  if (!args.reference_image) {
    throw new ValidationError("reference_image is required (upload it first with upload_image (action:\"image\"))");
  }
  const resolved = withDefaults(args);
  const checkpoint = await resolveCheckpointOrThrow(args.checkpoint, resolved, deps.resolveCheckpoint);

  const workflow = createWorkflow("ip_adapter", {
    ...commonTemplateParams(args, resolved, checkpoint),
    reference_image: args.reference_image,
    weight: args.weight,
    preset: args.preset,
    weight_type: args.weight_type,
  });

  const { prompt_id, queue_remaining } = await deps.enqueue(workflow);
  return { prompt_id, queue_remaining, checkpoint };
}
