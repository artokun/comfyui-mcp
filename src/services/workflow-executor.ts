import {
  getClient,
  connectClient,
  getSystemStats as clientGetSystemStats,
  getQueue as clientGetQueue,
  interrupt as clientInterrupt,
} from "../comfyui/client.js";
import type {
  WorkflowJSON,
  SystemStats,
  QueueStatus,
  JobResult,
} from "../comfyui/types.js";
import { WorkflowExecutionError, ConnectionError } from "../utils/errors.js";
import { arrayBufferToBase64 } from "../utils/image.js";
import { logger } from "../utils/logger.js";

export interface ExecuteWorkflowOptions {
  timeout_ms?: number;
  disable_random_seed?: boolean;
}

async function fetchImageFromUrl(
  url: string,
): Promise<{ data: string; mime: string } | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      logger.warn("Failed to fetch image from ComfyUI", {
        url,
        status: response.status,
      });
      return null;
    }
    const buffer = await response.arrayBuffer();
    const mime = response.headers.get("content-type") || "image/png";
    return { data: arrayBufferToBase64(buffer), mime };
  } catch (err) {
    logger.warn("Error fetching image", {
      url,
      error: err instanceof Error ? err.message : err,
    });
    return null;
  }
}

export async function executeWorkflow(
  workflowJson: WorkflowJSON,
  options?: ExecuteWorkflowOptions,
): Promise<JobResult> {
  const client = getClient();

  // Ensure WebSocket is connected for enqueue (uses WS internally)
  try {
    await connectClient();
  } catch (err) {
    if (err instanceof ConnectionError) throw err;
    throw new ConnectionError(
      `Failed to connect: ${err instanceof Error ? err.message : err}`,
    );
  }

  logger.info("Enqueueing workflow for execution");

  try {
    const result = await client.enqueue(
      workflowJson as Record<string, unknown>,
      {
        timeout_ms: options?.timeout_ms ?? 10 * 60 * 1000,
        disable_random_seed: options?.disable_random_seed,
        progress: (p) => {
          logger.debug("Execution progress", {
            value: p.value,
            max: p.max,
          });
        },
      },
    );

    // Handle both "buff" (ArrayBuffer) and "url" (ComfyUI /view endpoint) image types
    const images: { data: string; mime: string }[] = [];

    for (const img of result.images) {
      if (img.type === "buff") {
        const typedImg = img as { type: "buff"; data: ArrayBuffer; mime: string };
        images.push({
          data: arrayBufferToBase64(typedImg.data),
          mime: typedImg.mime,
        });
      } else if (img.type === "url") {
        const typedImg = img as { type: "url"; data: string };
        const fetched = await fetchImageFromUrl(typedImg.data);
        if (fetched) images.push(fetched);
      }
    }

    logger.info("Workflow execution completed", {
      prompt_id: result.prompt_id,
      image_count: images.length,
    });

    return {
      prompt_id: result.prompt_id,
      images,
      node_outputs: {},
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new WorkflowExecutionError(`Workflow execution failed: ${message}`);
  }
}

export async function getJobStatus(
  promptId: string,
): Promise<{ running: boolean; pending: boolean; done: boolean }> {
  const client = getClient();
  return client.getPromptStatus(promptId);
}

export async function getQueueStatus(): Promise<QueueStatus> {
  return clientGetQueue();
}

export async function cancelCurrentJob(): Promise<void> {
  await clientInterrupt();
  logger.info("Current job interrupted");
}

export async function getSystemInfo(): Promise<SystemStats> {
  return clientGetSystemStats();
}
