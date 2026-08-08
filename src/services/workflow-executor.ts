import {
  enqueuePrompt as clientEnqueuePrompt,
  getSystemStats as clientGetSystemStats,
  getObjectInfo as clientGetObjectInfo,
} from "../comfyui/client.js";
import type {
  ObjectInfo,
  WorkflowJSON,
  SystemStats,
} from "../comfyui/types.js";
import { logger } from "../utils/logger.js";
import { JobWatcher } from "./job-watcher.js";
import { convertApiToUi, isUiFormat } from "./workflow-converter.js";

export interface EnqueueWorkflowOptions {
  disable_random_seed?: boolean;
  /**
   * Seed input names (e.g. "seed") whose values the caller fixed deliberately
   * and which re-randomization must NOT overwrite (issue #865: an explicit
   * seed replaced by a random one silently loses a reproducible run). Used by
   * enqueue_workflow (action:"rerun") / generate_image (action:"regenerate")
   * so an override like `{ seed: 42 }` survives while the
   * remaining seeds still get fresh values.
   */
  preserve_seed_inputs?: readonly string[];
  /** Extra data attached to the /prompt request (e.g. comfy.org API-node creds). */
  extra_data?: Record<string, unknown>;
}

const SEED_INPUT_NAMES = ["seed", "noise_seed"] as const;

/**
 * Fallback draw range when a node's declared seed bounds are unavailable
 * (unknown class_type, /object_info unreachable): int32 `0..2147483647`.
 * Every stock ComfyUI seed widget is int32 or int64, so int32 draws are valid
 * for both — the previous fixed `2 ** 32` range overflowed int32-max nodes
 * (e.g. core's ClaudeNode) and was rejected with a 400 (issue #865).
 */
const FALLBACK_SEED_MIN = 0;
const FALLBACK_SEED_MAX = 2147483647; // 2^31 - 1

/**
 * Declared `[min, max]` for one node's seed input, from the /object_info
 * snapshot. Falls back to the int32 range when the node or the input's bounds
 * are unknown — an unreadable observation is never treated as a definite
 * range. Returns null when bounds ARE declared but no safely-drawable value
 * exists inside them (incoherent min > max, or a minimum above
 * MAX_SAFE_INTEGER): drawing the int32 fallback there would land OUTSIDE the
 * declared range and fail validation — the very bug this fixes — so the
 * caller's value must be left untouched instead.
 */
export function seedInputRange(
  objectInfo: ObjectInfo | undefined,
  classType: string,
  inputName: string,
): [number, number] | null {
  const def = objectInfo?.[classType];
  const spec =
    def?.input?.required?.[inputName] ?? def?.input?.optional?.[inputName];
  const config = Array.isArray(spec) ? spec[1] : undefined;
  const declaredMin =
    config && typeof config.min === "number" && Number.isFinite(config.min)
      ? config.min
      : undefined;
  const declaredMax =
    config && typeof config.max === "number" && Number.isFinite(config.max)
      ? config.max
      : undefined;
  const min = declaredMin ?? FALLBACK_SEED_MIN;
  // Clamp the draw ceiling to MAX_SAFE_INTEGER: declared maxes above 2^53
  // (KSampler declares 2^64-1) are inexact doubles, and a top-of-range draw
  // could round UP past the true maximum and fail validation.
  const max = Math.min(declaredMax ?? FALLBACK_SEED_MAX, Number.MAX_SAFE_INTEGER);
  // ceil/floor fractional declared bounds inward so the draw is always an
  // integer INSIDE the declared range (the input type is INT).
  const safeMin = Math.ceil(min);
  const safeMax = Math.floor(max);
  if (safeMin > safeMax) return null;
  return [safeMin, safeMax];
}

function drawSeed(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Randomize seed and noise_seed fields in a workflow.
 * Replicates the behavior that the SDK's `enqueue()` does internally,
 * since `_enqueue_prompt()` is the raw HTTP POST without seed randomization.
 *
 * Each draw respects the target node's DECLARED `[min, max]` for that input
 * (from the memoized /object_info snapshot — the same one
 * create_workflow (action:"node_info") serves), so nodes with a sub-2^32 seed
 * max no longer fail validation with a
 * 400. Inputs named in `preserveInputs` are left exactly as supplied.
 */
async function randomizeSeeds(
  workflow: WorkflowJSON,
  preserveInputs?: ReadonlySet<string>,
): Promise<WorkflowJSON> {
  const copy = JSON.parse(JSON.stringify(workflow)) as WorkflowJSON;
  // Best-effort: without the snapshot every draw uses the int32 fallback,
  // which is still in range for every stock seed widget.
  let objectInfo: ObjectInfo | undefined;
  try {
    objectInfo = await clientGetObjectInfo();
  } catch (err) {
    logger.debug(
      "object_info unavailable for seed range lookup; using int32 fallback",
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
  for (const node of Object.values(copy)) {
    if (node.inputs) {
      for (const key of SEED_INPUT_NAMES) {
        if (preserveInputs?.has(key)) continue;
        if (
          key in node.inputs &&
          typeof node.inputs[key] === "number"
        ) {
          const range = seedInputRange(objectInfo, node.class_type, key);
          // null: bounds are declared but hold no safely-drawable value —
          // keep the caller's seed rather than draw out of range.
          if (!range) continue;
          node.inputs[key] = drawSeed(range[0], range[1]);
        }
      }
    }
  }
  return copy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function withWorkflowMetadata(
  workflow: WorkflowJSON,
  extraData?: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  // Present but not an object (an array, a string) — we cannot merge into it,
  // and spreading it would DISCARD whatever the caller put there. Attaching this
  // metadata is an enhancement; silently dropping a field the caller set would be
  // a regression, so leave the request exactly as it came.
  if (extraData?.extra_pnginfo !== undefined && !isRecord(extraData.extra_pnginfo)) {
    logger.debug("extra_pnginfo is not an object; leaving it untouched (no UI metadata attached)", {
      type: Array.isArray(extraData.extra_pnginfo) ? "array" : typeof extraData.extra_pnginfo,
    });
    return extraData;
  }

  const extraPngInfo = isRecord(extraData?.extra_pnginfo)
    ? extraData.extra_pnginfo
    : {};

  // A valid caller-provided canvas is authoritative. Do not spend time fetching
  // object_info or replace layout/provenance the caller already supplied.
  if (isUiFormat(extraPngInfo.workflow)) return extraData;

  try {
    // Reuse the client's existing TTL cache and single-flight request. Seed
    // randomization may already have warmed this exact snapshot.
    const objectInfo = await clientGetObjectInfo();
    const { workflow: uiWorkflow, warnings } = convertApiToUi(workflow, objectInfo);
    if (warnings.length > 0) {
      logger.warn("Workflow UI metadata conversion completed with warnings", {
        warnings,
      });
    }
    return {
      ...(extraData ?? {}),
      extra_pnginfo: {
        ...extraPngInfo,
        workflow: uiWorkflow,
      },
    };
  } catch (err) {
    logger.warn("Workflow UI metadata conversion failed; enqueueing without it", {
      error: err instanceof Error ? err.message : String(err),
    });
    return extraData;
  }
}

/**
 * Fire-and-forget workflow enqueue. Returns prompt_id immediately
 * without waiting for execution to complete.
 */
export async function enqueueWorkflow(
  workflowJson: WorkflowJSON,
  options?: EnqueueWorkflowOptions,
): Promise<{ prompt_id: string; queue_remaining?: number; rejectedOutputs?: string }> {
  const workflow = options?.disable_random_seed
    ? workflowJson
    : await randomizeSeeds(
        workflowJson,
        new Set(options?.preserve_seed_inputs ?? []),
      );

  const extraData = await withWorkflowMetadata(workflow, options?.extra_data);

  logger.info("Enqueueing workflow (fire-and-forget)");
  const result = await clientEnqueuePrompt(
    workflow as Record<string, unknown>,
    extraData,
  );
  logger.info("Workflow enqueued", {
    prompt_id: result.prompt_id,
    queue_remaining: result.queue_remaining,
  });
  // A 200 from /prompt does not mean every output was accepted: ComfyUI queues
  // the branches that validate and reports the rejected ones in node_errors. Log
  // it unconditionally so the fact survives even if a caller renders only
  // prompt_id — a rejected branch produces nothing while the run still completes.
  if (result.rejectedOutputs) {
    logger.warn(`[enqueue] ${result.rejectedOutputs}`, { prompt_id: result.prompt_id });
  }

  // Start background watcher for completion detection. Capture the workflow
  // that was actually sent (post-seed-randomization) so the AssetRegistry can
  // store an exact reproducible snapshot for generate_image (action:"regenerate").
  JobWatcher.watch(result.prompt_id, workflow);

  return result;
}

export async function getSystemInfo(): Promise<SystemStats> {
  return clientGetSystemStats();
}
