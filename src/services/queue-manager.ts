import {
  getClient,
  getHistory,
  getQueue as clientGetQueue,
  interrupt as clientInterrupt,
  deleteQueueItem as clientDeleteQueueItem,
  clearQueue as clientClearQueue,
  enqueuePrompt as clientEnqueuePrompt,
  freeMemory as clientFreeMemory,
} from "../comfyui/client.js";
import * as cloudClient from "../comfyui/cloud-client.js";
import { isCloudMode } from "../config.js";
import type { QueueItem, WorkflowJSON } from "../comfyui/types.js";
import { logger } from "../utils/logger.js";
import { ComfyUIError, ValidationError } from "../utils/errors.js";
import {
  analyzeHistoryEntry,
  type ExecutionErrorDetails,
  type ExecutionStats,
  type TextOutput,
} from "./job-history.js";
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
  /** Text emitted by preview/show-text nodes (Preview as Text, ShowText, …).
   *  These write no file, so without this a text-producing workflow finishes
   *  with nothing for the agent to report. Omitted when the run produced none. */
  text_outputs?: TextOutput[];
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
      ...(analysis.text_outputs ? { text_outputs: analysis.text_outputs } : {}),
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** How long to wait for an interrupt to actually stop the running job before
 *  escalating. ComfyUI only checks the interrupt flag BETWEEN nodes/steps, so a
 *  multi-minute single step won't honor it — that wait is what detects the wedge.
 *  Tunable via COMFYUI_MCP_INTERRUPT_S (seconds); default 30. */
function interruptHonorMs(): number {
  const s = Number(process.env.COMFYUI_MCP_INTERRUPT_S);
  return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : 30000;
}

/** The outcome of watching the queue for a job to leave the running slot. */
interface RunningClearance {
  outcome:
    /** A successful poll observed it gone. */
    | "cleared"
    /** Polls kept answering, and the job was still running when time ran out. */
    | "still-running"
    /** The observation itself failed — nothing was determined about the job. */
    | "unobservable";
  /** At least one poll in the window answered (so an "unobservable" outcome
   *  means the queue stopped answering PARTWAY through, not that it never
   *  answered — the messages must not conflate the two). */
  observed: boolean;
  /** EVERY poll in the window answered. A single failure in the middle is a
   *  HOLE in the observation: the job could have stopped and another started
   *  inside it, or ComfyUI could have restarted. The outcome is still whatever
   *  the last live poll saw — a hole does not make a present-tense reading
   *  wrong — but nothing may narrate a gapped window as continuous verified
   *  polling. */
  continuous: boolean;
}

/** Poll /queue until the target running job is gone (or any-running is gone when
 *  no id given), or the timeout elapses.
 *
 *  THREE outcomes, because a failed poll is not "still running": if ComfyUI
 *  died mid-job, /queue stops answering AND the job is gone — folding that
 *  into "still-running" ends in a confident "wedged, restart ComfyUI, do NOT
 *  queue another run" verdict about a job that no longer exists. "Cleared"
 *  and "still-running" both require a live observation; anything else is
 *  "unobservable". */
async function waitForRunningCleared(
  promptId: string | undefined,
  timeoutMs: number,
): Promise<RunningClearance> {
  const start = Date.now();
  let everObserved = false;
  let lastPollFailed = false;
  // Sticky, unlike `lastPollFailed`: a later successful poll re-establishes the
  // PRESENT state, but it cannot retroactively fill in what happened while the
  // queue was not answering.
  let anyPollFailed = false;
  while (Date.now() - start < timeoutMs) {
    await sleep(1500);
    // unknown-ok: a failed poll is recorded as a FAILED POLL rather than as an
    // empty queue — `lastPollFailed` / `anyPollFailed` carry the unknown forward
    // into the returned `continuous` and `observed` flags.
    const q = await getQueueSummary().catch(() => null);
    if (!q) {
      lastPollFailed = true;
      anyPollFailed = true;
      continue;
    }
    everObserved = true;
    lastPollFailed = false;
    if (q.running === 0) return { outcome: "cleared", observed: true, continuous: !anyPollFailed };
    // A DIFFERENT job is now running → the one we targeted has cleared.
    if (promptId && !q.running_jobs.some((j) => j.prompt_id === promptId)) {
      return { outcome: "cleared", observed: true, continuous: !anyPollFailed };
    }
  }
  // Timed out. "Still running" is a claim about NOW, and only a poll that is
  // still answering at the end of the window can make it — a run of failures
  // (or never observing at all) means the queue's state is simply unknown.
  return {
    outcome: everObserved && !lastPollFailed ? "still-running" : "unobservable",
    observed: everObserved,
    continuous: !anyPollFailed,
  };
}

export interface EscalatedCancelResult {
  interrupted: boolean;
  honored: boolean; // did the running job actually stop?
  freed_vram: boolean; // did we escalate to POST /free?
  wedged: boolean; // still running after interrupt + free → needs a restart
  /** The queue stopped answering mid-verification — the job's fate is UNKNOWN,
   *  neither "stopped" nor "wedged" (a crashed ComfyUI also stops answering,
   *  and takes the job with it). */
  unverified?: boolean;
  /**
   * What a LIVE /queue read established about THE JOB THIS CALL ADDRESSED —
   * which is the whole of what a cancel promises, and the question that decides
   * whether its result is settled.
   *
   * NOT a statement that the queue is idle. With a `prompt_id`, "stopped" means
   * that job is gone; another job may have advanced into the running slot, and
   * pending jobs run next unless `clear_pending` was asked for (see
   * `pending_cleared` / `pending_clear_failed`, and the message, for that half).
   *
   * Deliberately separate from `unverified`, which covers a DIFFERENT unknown:
   * `unverified` can mean "it demonstrably stopped, but we cannot say our
   * interrupt is why". That is a caveat on the narration, not on the queue.
   * Folding both into one flag is how a caller ends up refusing to proceed
   * against a queue that is verifiably empty — or, the way round the gate
   * caught, treating an unreadable queue as an empty one.
   *
   *  - "stopped" — a live read showed the target gone (or showed nothing to
   *    interrupt in the first place).
   *  - "running" — a live read showed it STILL running: the wedge.
   *  - "unknown" — /queue could not be read, so neither is established.
   */
  target_state: "stopped" | "running" | "unknown";
  /** clear_pending was asked for and the clear did not complete — the pending
   *  jobs may still be queued. Distinct from `pending_cleared: undefined`,
   *  which is also what "clear_pending was never requested" looks like. */
  pending_clear_failed?: boolean;
  pending_cleared?: number; // how many pending jobs were dropped (if clear_pending)
  running_prompt_id?: string;
  message: string;
}

/**
 * Cancel the running job ROBUSTLY: optionally clear all pending first (so a
 * re-queue can't stack behind a backlog), interrupt, then WAIT and verify the
 * job actually stopped. If the interrupt isn't honored within the window, escalate
 * to POST /free and re-check; if it STILL won't die it's wedged inside a single
 * step — HTTP can't kill that, so report that a ComfyUI restart is required rather
 * than letting the agent re-queue on top of a zombie.
 */
export async function cancelRunningJobEscalating(opts: {
  prompt_id?: string;
  clear_pending?: boolean;
}): Promise<EscalatedCancelResult> {
  let pending_cleared: number | undefined;
  let clearPendingFailed = false;
  if (opts.clear_pending) {
    // unknown-ok: null suppresses the COUNT rather than reporting a wrong one — see
    // pending_cleared below, which stays undefined so the message says "cleared"
    // without a number it never observed.
    const before = await getQueueSummary().catch(() => null);
    await clearAllQueued().catch((err) => {
      clearPendingFailed = true;
      logger.warn("clear_pending failed (continuing)", { err });
    });
    // Only a clear that did not fail may report a count — "cleared (N)" on a
    // failed request is a confident false statement.
    pending_cleared = clearPendingFailed ? undefined : before?.pending;
  }
  // The pending half of every verdict message, true to what actually happened.
  const pendingNote = !opts.clear_pending
    ? `Pending jobs were NOT cleared — pass clear_pending:true or call queue (action:"clear").`
    : clearPendingFailed
      ? `Clearing pending jobs FAILED — they may still be queued; check queue (action:"list").`
      : pending_cleared != null
        ? `Pending jobs were cleared (${pending_cleared}).`
        : `Pending jobs were cleared.`;

  // Identify the job we're trying to stop so we can verify it actually clears.
  // unknown-ok: null makes targetSeenRunning false, and "interrupted" is only
  // claimed about a job we OBSERVED running (see the comment below). A failed
  // summary therefore withholds the claim instead of fabricating it.
  const pre = await getQueueSummary().catch(() => null);
  const runningId = opts.prompt_id ?? pre?.running_jobs?.[0]?.prompt_id;
  // "Interrupted" is only a claim we may make about a job we OBSERVED running.
  const targetSeenRunning = opts.prompt_id
    ? !!pre?.running_jobs.some((j) => j.prompt_id === opts.prompt_id)
    : !!pre && pre.running > 0;

  if (pre && pre.running === 0 && !opts.prompt_id) {
    return {
      interrupted: false,
      honored: true,
      freed_vram: false,
      wedged: false,
      target_state: "stopped",
      pending_clear_failed: clearPendingFailed || undefined,
      pending_cleared,
      message: `No job is running.${opts.clear_pending ? ` ${pendingNote}` : ""}`,
    };
  }
  if (pre && opts.prompt_id && !targetSeenRunning) {
    return {
      interrupted: false,
      honored: true,
      freed_vram: false,
      wedged: false,
      target_state: "stopped",
      pending_clear_failed: clearPendingFailed || undefined,
      pending_cleared,
      message:
        `${opts.prompt_id} is not running (verified via /queue) — nothing to interrupt.` +
        `${opts.clear_pending ? ` ${pendingNote}` : ""}`,
    };
  }

  await clientInterrupt(opts.prompt_id);
  logger.info("Interrupt sent (escalating cancel)", { prompt_id: runningId ?? "current" });

  const firstClearance = await waitForRunningCleared(runningId, interruptHonorMs());
  if (firstClearance.outcome === "cleared") {
    if (!targetSeenRunning) {
      // The queue is verifiably empty NOW, but the pre-interrupt read failed —
      // so "the interrupt stopped it" asserts a start state nobody observed.
      return {
        interrupted: true,
        honored: false,
        freed_vram: false,
        wedged: false,
        unverified: true,
        target_state: "stopped",
        pending_clear_failed: clearPendingFailed || undefined,
        pending_cleared,
        running_prompt_id: runningId,
        message:
          `Interrupt sent${runningId ? ` (${runningId})` : ""}, and nothing is running now ` +
          `(verified via /queue) — but the queue could not be read BEFORE the interrupt, so ` +
          `whether a job was running, and whether the interrupt stopped it, is UNKNOWN.` +
          `${opts.clear_pending ? ` ${pendingNote}` : ""}`,
      };
    }
    return {
      interrupted: true,
      honored: true,
      freed_vram: false,
      wedged: false,
      target_state: "stopped",
      pending_clear_failed: clearPendingFailed || undefined,
      pending_cleared,
      running_prompt_id: runningId,
      message: `Interrupted the running job${runningId ? ` (${runningId})` : ""}.${
        opts.clear_pending ? ` ${pendingNote}` : ""
      }`,
    };
  }

  // Not honored — the step is long-running. Free VRAM and re-check. The /free
  // result is tracked, not swallowed into the narration: a failed escalation
  // must not be described as a performed one — and a throw only means no
  // successful completion was OBSERVED (the request may have applied and the
  // response been lost), so "never reached the server" is not ours to say
  // either. On Comfy Cloud the call is a deliberate no-op, which no message
  // may narrate as a VRAM free.
  logger.warn("Interrupt not honored in window; escalating to /free", { prompt_id: runningId ?? "current" });
  const freeRan = !isCloudMode();
  let freeFailed = false;
  await clientFreeMemory({ unload_models: true, free_memory: true }).catch((err) => {
    freeFailed = true;
    logger.warn("/free during cancel escalation failed (continuing)", { err });
  });
  // freed_vram is true only when the escalation RAN and did not fail.
  const freedVram = freeRan && !freeFailed;
  const freeFailedPhrase =
    "the VRAM-free escalation did not complete — whether it freed anything is unknown";

  const finalClearance = await waitForRunningCleared(
    runningId,
    Math.min(interruptHonorMs(), 12000),
  );
  // The duration the message may claim: continuous verified polling only when
  // the FIRST window was observed end-to-end; otherwise only the final check
  // was a live observation, and the message must not claim more.
  //
  // "End-to-end" means EVERY poll answered. A window with a hole in it still
  // supports the present-tense reading its last live poll made — but calling it
  // "~Ns of verified polling" is a sampled observation with a gap narrated as
  // continuous verification, and this claim is load-bearing: it is what makes
  // "restart ComfyUI, do NOT queue another run" sound settled. A restart or a
  // disconnect inside the gap is exactly the case that guidance would be wrong
  // about, so the gap is named rather than smoothed over.
  // BOTH windows, because the duration claimed spans both: a hole anywhere in
  // the stated span makes the span not continuously verified, and checking only
  // the first window would leave the same claim standing over a gap in the
  // second (codex gate).
  const escalationWindowS = Math.round(Math.min(interruptHonorMs(), 12000) / 1000);
  const watchedDuration = (first: RunningClearance, final: RunningClearance): string => {
    if (first.outcome !== "still-running") {
      // One check, not a window — a gap before it does not touch this claim.
      return ` at a verified check ~${escalationWindowS}s after the escalation`;
    }
    const totalS = Math.round((interruptHonorMs() + Math.min(interruptHonorMs(), 12000)) / 1000);
    return first.continuous && final.continuous
      ? ` across ~${totalS}s of verified polling`
      : ` across ~${totalS}s of polling that /queue did NOT answer throughout — it was ` +
          `seen running by the polls that did answer, including the most recent one, but ` +
          `the gap could hide a restart`;
  };
  // "The job stopped" (or "this job is wedged") is only ours to claim when the
  // target was seen running BEFORE the interrupt. A named prompt first sighted
  // in a later window may have STARTED after the interrupt — the interrupt was
  // a no-op for it, and its later stop is not our doing.
  const stopVerified = targetSeenRunning;
  if (finalClearance.outcome === "cleared") {
    // The queue is verifiably empty — but WHY is only knowable if we watched
    // it the whole time, and WHETHER a job was running at all is only knowable
    // if the start was observed.
    // A job was SEEN during the window, but never tied to the interrupt.
    const sawUntiedJob =
      !stopVerified &&
      (firstClearance.outcome === "still-running" || firstClearance.observed);
    const message =
      firstClearance.outcome === "unobservable" && targetSeenRunning
        ? `The running job${runningId ? ` (${runningId})` : ""} has STOPPED (verified via /queue), ` +
          `but what stopped it is unknown — the queue was unreachable for a while after the ` +
          `interrupt${
            freeFailed
              ? `, and ${freeFailedPhrase} — so the interrupt may have worked late or ComfyUI restarted`
              : freeRan
                ? `, so the interrupt may have worked late, the VRAM free may have done it, or ComfyUI restarted`
                : `, so the interrupt may have worked late or ComfyUI restarted`
          }.${opts.clear_pending ? ` ${pendingNote}` : ""}`
        : sawUntiedJob
          ? `A job was running during the interrupt window and nothing is running now (verified ` +
            `via /queue) — but the queue could not be read BEFORE the interrupt, so whether the ` +
            `job that stopped is the one that was interrupted is UNKNOWN.${
              opts.clear_pending ? ` ${pendingNote}` : ""
            }`
          : !stopVerified
            ? `Nothing is running now (verified via /queue), but /queue never answered from before ` +
              `the interrupt through the honor window — so whether a job was running at all, and ` +
              `what stopped it if one was, is UNKNOWN.${opts.clear_pending ? ` ${pendingNote}` : ""}`
            : freeFailed
              ? `The job didn't stop on interrupt and ${freeFailedPhrase}, but the job ` +
                `HAS now stopped anyway (verified via /queue)${runningId ? ` (${runningId})` : ""}.${
                  opts.clear_pending ? ` ${pendingNote}` : ""
                }`
              : freeRan
                ? `The job didn't stop within the interrupt window; after the VRAM-free escalation it ` +
                  `has now STOPPED (verified via /queue)${runningId ? ` (${runningId})` : ""}.${
                    opts.clear_pending ? ` ${pendingNote}` : ""
                  }`
                : `The job didn't stop within the interrupt window and has now STOPPED ` +
                  `(verified via /queue)${runningId ? ` (${runningId})` : ""}.${
                    opts.clear_pending ? ` ${pendingNote}` : ""
                  }`;
    return {
      interrupted: true,
      honored: stopVerified,
      freed_vram: freedVram,
      wedged: false,
      unverified: stopVerified ? undefined : true,
      target_state: "stopped",
      pending_clear_failed: clearPendingFailed || undefined,
      pending_cleared,
      running_prompt_id: runningId,
      message,
    };
  }

  if (finalClearance.outcome === "unobservable") {
    const subject = targetSeenRunning
      ? `⚠️ The running job${runningId ? ` (${runningId})` : ""} was sent an interrupt`
      : `⚠️ An interrupt was sent${runningId ? ` for ${runningId}` : ""}`;
    const unknownWhat = targetSeenRunning
      ? `whether it is still running is UNKNOWN — ComfyUI may be down or restarting, which would ` +
        `ALSO have stopped the job`
      : `whether a job was running — and whether one still is — is UNKNOWN. ComfyUI may be down ` +
        `or restarting`;
    // "Stopped answering" is only a claim we may make if it answered at all.
    const reachability = finalClearance.observed
      ? `stopped answering partway through verification`
      : `did not answer during verification`;
    return {
      interrupted: true,
      honored: false,
      freed_vram: freedVram,
      wedged: false,
      unverified: true,
      target_state: "unknown",
      pending_clear_failed: clearPendingFailed || undefined,
      pending_cleared,
      running_prompt_id: runningId,
      message:
        subject +
        (freeFailed
          ? ` (${freeFailedPhrase})`
          : freeRan && targetSeenRunning
            ? ` (and a VRAM free)`
            : ``) +
        `, but /queue ${reachability}, so ${unknownWhat}. This is not a confirmed wedge. ` +
        `Check ComfyUI is up (install_comfyui (action:"environment")) and inspect the queue before deciding anything. ` +
        (opts.clear_pending
          ? pendingNote
          : `Pending jobs were NOT cleared — pass clear_pending:true or call queue (action:"clear").`),
    };
  }

  if (!stopVerified) {
    // A job is verifiably wedged — but nothing established it is the job the
    // interrupt addressed (no pre-interrupt read; a named prompt may have
    // STARTED after it). The wedge itself is real (interrupt + VRAM free did
    // not stop it); only the IDENTITY is unknown.
    return {
      interrupted: true,
      honored: false,
      freed_vram: freedVram,
      wedged: true,
      unverified: true,
      // Only a NAMED target gets "running": waitForRunningCleared matched that
      // prompt_id in the running slot, so the job this call addressed is the one
      // observed. Without an id and with no pre-interrupt read, `runningId` is
      // undefined and the poll only established that SOME job is running — which
      // is what the message below already says. Calling that "running" would
      // make the field claim the identity the prose disclaims (codex gate).
      target_state: opts.prompt_id ? "running" : "unknown",
      pending_clear_failed: clearPendingFailed || undefined,
      pending_cleared,
      running_prompt_id: runningId,
      message:
        `⚠️ ${opts.prompt_id ? `The job ${opts.prompt_id}` : "A job"} is still running after interrupt` +
        (freeFailed ? ` (${freeFailedPhrase})` : freeRan ? ` + VRAM free` : ``) +
        watchedDuration(firstClearance, finalClearance) +
        ` — it is wedged inside a single step (ComfyUI only honors interrupts ` +
        `BETWEEN steps). Whether this IS the job the interrupt addressed is UNKNOWN — ` +
        (opts.prompt_id
          ? `it was never observed running before the interrupt, so it may have started after. `
          : `the queue could not be read beforehand. `) +
        `An HTTP cancel cannot kill a wedged step; restart ` +
        `ComfyUI (panel_restart_comfyui, or restart_comfyui) to clear it. ` +
        `${pendingNote} Do NOT queue another run until this is gone.`,
    };
  }

  return {
    interrupted: true,
    honored: false,
    freed_vram: freedVram,
    wedged: true,
    target_state: "running",
    pending_clear_failed: clearPendingFailed || undefined,
    pending_cleared,
    running_prompt_id: runningId,
    message:
      `⚠️ The running job${runningId ? ` (${runningId})` : ""} did NOT stop after interrupt` +
      (freeFailed ? ` (${freeFailedPhrase})` : freeRan ? ` + VRAM free` : ``) +
      watchedDuration(firstClearance, finalClearance) +
      ` — it is wedged inside a single step (ComfyUI only honors interrupts ` +
      `BETWEEN steps, so a multi-minute step ignores cancel). An HTTP cancel cannot kill this; restart ComfyUI ` +
      `(panel_restart_comfyui, or restart_comfyui) to clear it. ` +
      `${pendingNote} Do NOT queue another run until this is gone.`,
  };
}

export async function cancelQueuedJob(promptId: string): Promise<void> {
  await clientDeleteQueueItem(promptId);
  logger.info("Queued job removed", { prompt_id: promptId });
}

export async function clearAllQueued(): Promise<void> {
  await clientClearQueue();
  logger.info("All pending queue items cleared");
}
