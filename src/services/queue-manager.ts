import {
  getClient,
  getQueue as clientGetQueue,
  interrupt as clientInterrupt,
  deleteQueueItem as clientDeleteQueueItem,
  clearQueue as clientClearQueue,
} from "../comfyui/client.js";
import type { QueueItem } from "../comfyui/types.js";
import { logger } from "../utils/logger.js";

export interface QueueSummary {
  running: number;
  pending: number;
  running_jobs: Array<{ prompt_id: string; number: number }>;
  pending_jobs: Array<{ prompt_id: string; number: number }>;
}

function extractJobInfo(items: QueueItem[]): Array<{ prompt_id: string; number: number }> {
  return items.map((item) => ({
    number: item[0],
    prompt_id: item[1],
  }));
}

export async function getQueueSummary(): Promise<QueueSummary> {
  const queue = await clientGetQueue();
  return {
    running: queue.queue_running.length,
    pending: queue.queue_pending.length,
    running_jobs: extractJobInfo(queue.queue_running),
    pending_jobs: extractJobInfo(queue.queue_pending),
  };
}

export async function getJobStatus(
  promptId: string,
): Promise<{ running: boolean; pending: boolean; done: boolean }> {
  const client = getClient();
  return client.getPromptStatus(promptId);
}

export async function cancelRunningJob(promptId?: string): Promise<void> {
  await clientInterrupt(promptId);
  logger.info("Job interrupted", { prompt_id: promptId ?? "current" });
}

export async function cancelQueuedJob(promptId: string): Promise<void> {
  await clientDeleteQueueItem(promptId);
  logger.info("Queued job removed", { prompt_id: promptId });
}

export async function clearAllQueued(): Promise<void> {
  await clientClearQueue();
  logger.info("All pending queue items cleared");
}
