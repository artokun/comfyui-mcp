import {
  getClient,
  getHistory,
  getQueue as clientGetQueue,
  interrupt as clientInterrupt,
  deleteQueueItem as clientDeleteQueueItem,
  clearQueue as clientClearQueue,
  enqueuePrompt as clientEnqueuePrompt,
} from "../comfyui/client.js";
import * as cloudClient from "../comfyui/cloud-client.js";
import { isCloudMode } from "../config.js";
import type { QueueItem, WorkflowJSON } from "../comfyui/types.js";
import { logger } from "../utils/logger.js";
import { ComfyUIError, ValidationError } from "../utils/errors.js";
import { analyzeHistoryEntry, type ExecutionErrorDetails, type ExecutionStats } from "./job-history.js";
import { JobWatcher } from "./job-watcher.js";

export interface QueueSummary {
  running: number;
  pending: number;
  running_jobs: QueueJobInfo[];
  pending_jobs: QueueJobInfo[];
}

export interface QueueJobInfo {
  prompt_id: string;
  number: number;
  workflow?: WorkflowJSON;
  extra_data?: Record<string, unknown>;
}

export interface QueuedWorkflowInfo extends QueueJobInfo {
  position: number;
}

export interface RequeuedJobResult {
  old_prompt_id: string;
  new_prompt_id: string;
  queue_remaining?: number;
  position: "front" | "back";
  message: string;
}

export interface JobStatus {
  running: boolean;
  pending: boolean;
  done: boolean;
  status_str?: string;
  error?: ExecutionErrorDetails;
  execution_stats?: ExecutionStats;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function queueWorkflow(item: QueueItem): WorkflowJSON | undefined {
  const prompt = asRecord(item[2]);
  return prompt ? prompt as WorkflowJSON : undefined;
}

function queueExtraData(item: QueueItem): Record<string, unknown> | undefined {
  return asRecord(item[3]);
}

function extractJobInfo(items: QueueItem[], includeWorkflow = false): QueueJobInfo[] {
  return items.map((item) => {
    const out: QueueJobInfo = {
      number: item[0],
      prompt_id: item[1],
    };
    if (includeWorkflow) {
      const workflow = queueWorkflow(item);
      const extraData = queueExtraData(item);
      if (workflow) out.workflow = workflow;
      if (extraData && Object.keys(extraData).length > 0) out.extra_data = extraData;
    }
    return out;
  });
}

export async function getQueueSummary(opts: { include_workflows?: boolean } = {}): Promise<QueueSummary> {
  const queue = await clientGetQueue();
  const includeWorkflow = !!opts.include_workflows;
  return {
    running: queue.queue_running.length,
    pending: queue.queue_pending.length,
    running_jobs: extractJobInfo(queue.queue_running, includeWorkflow),
    pending_jobs: extractJobInfo(queue.queue_pending, includeWorkflow),
  };
}

function findPending(queue: { queue_pending: QueueItem[] }, promptId: string): { item: QueueItem; position: number } {
  const idx = queue.queue_pending.findIndex((item) => item[1] === promptId);
  if (idx < 0) {
    throw new ComfyUIError(
      `Pending job ${promptId} was not found. Only pending jobs can be edited or requeued; running jobs must be interrupted.`,
      "QUEUE_JOB_NOT_FOUND",
      { prompt_id: promptId },
    );
  }
  return { item: queue.queue_pending[idx], position: idx + 1 };
}

export async function getQueuedWorkflow(promptId: string): Promise<QueuedWorkflowInfo> {
  const queue = await clientGetQueue();
  const { item, position } = findPending(queue, promptId);
  const workflow = queueWorkflow(item);
  if (!workflow) {
    throw new ComfyUIError(
      `Pending job ${promptId} did not include a workflow payload in /queue.`,
      "QUEUE_PAYLOAD_UNAVAILABLE",
      { prompt_id: promptId },
    );
  }
  const extraData = queueExtraData(item);
  return {
    number: item[0],
    prompt_id: item[1],
    position,
    workflow,
    ...(extraData && Object.keys(extraData).length > 0 ? { extra_data: extraData } : {}),
  };
}

function cloneWorkflow(workflow: WorkflowJSON): WorkflowJSON {
  return JSON.parse(JSON.stringify(workflow)) as WorkflowJSON;
}

function applyInputUpdates(
  workflow: WorkflowJSON,
  updates?: Record<string, Record<string, unknown>>,
): WorkflowJSON {
  if (!updates) return workflow;
  for (const [nodeId, inputs] of Object.entries(updates)) {
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
      throw new ValidationError(`node_inputs.${nodeId} must be an object.`);
    }
    const node = workflow[nodeId];
    if (!node) throw new ValidationError(`Cannot edit queued workflow: node ${nodeId} does not exist.`);
    node.inputs = { ...(node.inputs ?? {}), ...inputs };
  }
  return workflow;
}

/**
 * Compute the real number of jobs remaining in the queue (running + pending),
 * clamped to >= 0. We do NOT trust the `number` field ComfyUI returns from
 * POST /prompt: that is the queue's monotonic priority counter, and it is
 * NEGATIVE when a job is enqueued at the front (front:true). Reusing it as a
 * "remaining" count produced nonsensical values like -17. A direct /queue read
 * is the authoritative count. Falls back to the (clamped) enqueue hint if the
 * queue can't be read.
 */
async function computeQueueRemaining(fallback?: number): Promise<number | undefined> {
  try {
    const queue = await clientGetQueue();
    return queue.queue_running.length + queue.queue_pending.length;
  } catch (err) {
    logger.debug("Could not read /queue for remaining count; using enqueue hint", { err });
    if (typeof fallback !== "number" || !Number.isFinite(fallback)) return undefined;
    return Math.max(0, fallback);
  }
}

async function requeuePendingJob(
  promptId: string,
  workflow: WorkflowJSON,
  extraData: Record<string, unknown> | undefined,
  position: "front" | "back",
): Promise<RequeuedJobResult> {
  await clientDeleteQueueItem(promptId);
  const result = await clientEnqueuePrompt(
    workflow as Record<string, unknown>,
    extraData,
    { front: position === "front" },
  );
  JobWatcher.watch(result.prompt_id, workflow);
  const queue_remaining = await computeQueueRemaining(result.queue_remaining);
  return {
    old_prompt_id: promptId,
    new_prompt_id: result.prompt_id,
    queue_remaining,
    position,
    message: `Pending job ${promptId} was requeued at the ${position}; new prompt_id is ${result.prompt_id}.`,
  };
}

export async function moveQueuedJob(
  promptId: string,
  position: "front" | "back",
): Promise<RequeuedJobResult> {
  const queued = await getQueuedWorkflow(promptId);
  const workflow = cloneWorkflow(queued.workflow!);
  return requeuePendingJob(promptId, workflow, queued.extra_data, position);
}

export async function editQueuedJob(opts: {
  prompt_id: string;
  workflow?: WorkflowJSON;
  node_inputs?: Record<string, Record<string, unknown>>;
  position?: "front" | "back";
}): Promise<RequeuedJobResult> {
  const queued = await getQueuedWorkflow(opts.prompt_id);
  const base = opts.workflow ? cloneWorkflow(opts.workflow) : cloneWorkflow(queued.workflow!);
  const workflow = applyInputUpdates(base, opts.node_inputs);
  return requeuePendingJob(opts.prompt_id, workflow, queued.extra_data, opts.position ?? "back");
}

async function cloudJobStatus(promptId: string): Promise<JobStatus> {
  // Cloud /api/job/<id>/status returns
  //   { status: "pending" | "in_progress" | "completed" | "failed", error?, prompt_id? }
  // Map onto local JobStatus shape so callers don't care about the backend.
  const cloud = await cloudClient.getJobStatus(promptId);
  const done = cloud.status === "completed" || cloud.status === "failed";
  const base: JobStatus = {
    running: cloud.status === "in_progress",
    pending: cloud.status === "pending",
    done,
    status_str: cloud.status,
  };

  if (!done) return base;

  // Try to enrich completed jobs from /api/history_v2/<id>; if that fails,
  // fall back to the bare cloud status (with the error message if present).
  try {
    const history = await getHistory(promptId);
    const entry = history[promptId];
    if (!entry) {
      return cloud.error
        ? {
            ...base,
            error: {
              node_id: "",
              node_type: "",
              exception_message: cloud.error,
            } satisfies ExecutionErrorDetails,
          }
        : base;
    }
    const analysis = analyzeHistoryEntry(entry);
    return {
      ...base,
      status_str: entry.status?.status_str ?? cloud.status,
      error: analysis.error,
      execution_stats: analysis.execution_stats,
    };
  } catch (err) {
    logger.warn("Cloud: could not enrich job status from history", {
      prompt_id: promptId,
      error: err instanceof Error ? err.message : err,
    });
    return cloud.error
      ? {
          ...base,
          error: {
            node_id: "",
            node_type: "",
            exception_message: cloud.error,
          } satisfies ExecutionErrorDetails,
        }
      : base;
  }
}

export async function getJobStatus(
  promptId: string,
): Promise<JobStatus> {
  if (isCloudMode()) return cloudJobStatus(promptId);

  const client = getClient();
  const status = await client.getPromptStatus(promptId);
  if (!status.done) return status;

  try {
    const history = await getHistory(promptId);
    const entry = history[promptId];
    if (!entry) return status;

    const analysis = analyzeHistoryEntry(entry);
    return {
      ...status,
      status_str: entry.status.status_str,
      error: analysis.error,
      execution_stats: analysis.execution_stats,
    };
  } catch (err) {
    logger.warn("Could not enrich job status from history", {
      prompt_id: promptId,
      error: err instanceof Error ? err.message : err,
    });
    return status;
  }
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
