import {
  enqueuePrompt as clientEnqueuePrompt,
  getSystemStats as clientGetSystemStats,
} from "../comfyui/client.js";
import type {
  WorkflowJSON,
  SystemStats,
} from "../comfyui/types.js";
import { logger } from "../utils/logger.js";

export interface EnqueueWorkflowOptions {
  disable_random_seed?: boolean;
}

/**
 * Randomize seed and noise_seed fields in a workflow.
 * Replicates the behavior that the SDK's `enqueue()` does internally,
 * since `_enqueue_prompt()` is the raw HTTP POST without seed randomization.
 */
function randomizeSeeds(workflow: WorkflowJSON): WorkflowJSON {
  const copy = JSON.parse(JSON.stringify(workflow)) as WorkflowJSON;
  for (const node of Object.values(copy)) {
    if (node.inputs) {
      for (const key of ["seed", "noise_seed"]) {
        if (
          key in node.inputs &&
          typeof node.inputs[key] === "number"
        ) {
          node.inputs[key] = Math.floor(Math.random() * 2 ** 32);
        }
      }
    }
  }
  return copy;
}

/**
 * Fire-and-forget workflow enqueue. Returns prompt_id immediately
 * without waiting for execution to complete.
 */
export async function enqueueWorkflow(
  workflowJson: WorkflowJSON,
  options?: EnqueueWorkflowOptions,
): Promise<{ prompt_id: string; queue_remaining?: number }> {
  const workflow = options?.disable_random_seed
    ? workflowJson
    : randomizeSeeds(workflowJson);

  logger.info("Enqueueing workflow (fire-and-forget)");
  const result = await clientEnqueuePrompt(workflow as Record<string, unknown>);
  logger.info("Workflow enqueued", {
    prompt_id: result.prompt_id,
    queue_remaining: result.queue_remaining,
  });
  return result;
}

export async function getSystemInfo(): Promise<SystemStats> {
  return clientGetSystemStats();
}
