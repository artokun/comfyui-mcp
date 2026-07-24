import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { enqueueWorkflow } from "./workflow-executor.js";
import { getJobStatus } from "./queue-manager.js";
import { getHistory } from "../comfyui/client.js";
import { applyOverrides } from "./asset-registry.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import { ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BatchRecord {
  batch_id: string;
  created_at: string;
  prompt_ids: string[];
}

export type BatchJobState = "pending" | "running" | "done" | "error" | "unknown";

export interface BatchJobStatus {
  prompt_id: string;
  state: BatchJobState;
  status_str?: string;
  error_message?: string;
}

export interface BatchStatusResult {
  batch_id: string;
  created_at: string;
  count: number;
  jobs: BatchJobStatus[];
  rollup: Record<BatchJobState, number>;
  all_terminal: boolean;
}

export interface BatchOutputResult {
  batch_id: string;
  count: number;
  completed: number;
  outputs: Array<{
    prompt_id: string;
    state: BatchJobState;
    /** Raw ComfyUI history `outputs` for this prompt (node id → outputs, incl.
     *  images/videos/audio filenames), same shape get_history reports. */
    outputs?: Record<string, unknown>;
    error_message?: string;
  }>;
}

export interface SubmitBatchResult {
  batch_id: string;
  count: number;
  prompt_ids: string[];
  /** Present when some (but not all) enqueues failed. */
  enqueue_errors?: Array<{ index: number; error: string }>;
}

// ── Durable store (JSON file under the app data dir) ────────────────────────

// One JSON file PER batch under <data dir>/batches/<batch_id>.json.
// Per-batch files mean concurrent submits — even from SEPARATE server
// processes sharing the data dir — never read-modify-write a shared file, so
// no batch can be lost to a racing writer. Each write is tmp+rename (atomic).

function batchesDir(): string {
  const base =
    process.env.COMFYUI_MCP_DATA_DIR?.trim() || join(homedir(), ".comfyui-mcp");
  return join(base, "batches");
}

/** batch ids are generated as `batch_<uuid>`; reject anything else so a
 *  caller-supplied id can never traverse outside the batches dir. */
const BATCH_ID_RE = /^batch_[0-9a-f-]{36}$/;

function batchFilePath(batchId: string): string {
  return join(batchesDir(), `${batchId}.json`);
}

async function persistBatch(record: BatchRecord): Promise<void> {
  const file = batchFilePath(record.batch_id);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
  await rename(tmp, file);
}

export async function loadBatch(batchId: string): Promise<BatchRecord> {
  if (!BATCH_ID_RE.test(batchId)) {
    throw new ValidationError(
      `Invalid batch_id "${batchId}" — expected the batch_<uuid> id returned by submit_batch.`,
    );
  }
  let record: BatchRecord | undefined;
  try {
    const raw = await readFile(batchFilePath(batchId), "utf8");
    record = JSON.parse(raw) as BatchRecord;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      logger.warn("Batch record unreadable", {
        batch_id: batchId,
        error: err instanceof Error ? err.message : err,
      });
    }
  }
  if (!record || !Array.isArray(record.prompt_ids)) {
    throw new ValidationError(
      `Unknown batch_id "${batchId}". Batches persist across restarts in ${batchesDir()}; check the id returned by submit_batch.`,
    );
  }
  return record;
}

// ── submit ───────────────────────────────────────────────────────────────────

export interface SubmitBatchInput {
  workflows?: WorkflowJSON[];
  workflow?: WorkflowJSON;
  /** Param sweep: one job per override set, applied like modify_workflow's
   *  flat input overrides (every node that already has the input gets it). */
  sweep?: Array<Record<string, unknown>>;
  disable_random_seed?: boolean;
}

export async function submitBatch(input: SubmitBatchInput): Promise<SubmitBatchResult> {
  let jobs: WorkflowJSON[];
  if (input.workflows && input.workflows.length > 0) {
    if (input.workflow || input.sweep) {
      throw new ValidationError("Provide EITHER `workflows` OR `workflow`+`sweep`, not both.");
    }
    jobs = input.workflows;
  } else if (input.workflow && input.sweep && input.sweep.length > 0) {
    jobs = input.sweep.map((overrides) => applyOverrides(input.workflow!, overrides));
  } else {
    throw new ValidationError(
      "submit_batch needs either `workflows` (non-empty array) or `workflow` + `sweep` (non-empty array of override sets).",
    );
  }

  const batchId = `batch_${randomUUID()}`;
  const promptIds: string[] = [];
  const errors: Array<{ index: number; error: string }> = [];

  for (let i = 0; i < jobs.length; i++) {
    try {
      const result = await enqueueWorkflow(jobs[i], {
        disable_random_seed: input.disable_random_seed,
      });
      promptIds.push(result.prompt_id);
    } catch (err) {
      errors.push({ index: i, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (promptIds.length === 0) {
    throw new ValidationError(
      `submit_batch: all ${jobs.length} enqueues failed. First error: ${errors[0]?.error ?? "unknown"}`,
    );
  }

  const record: BatchRecord = {
    batch_id: batchId,
    created_at: new Date().toISOString(),
    prompt_ids: promptIds,
  };
  await persistBatch(record);
  logger.info("Batch submitted", { batch_id: batchId, count: promptIds.length, failed: errors.length });

  return {
    batch_id: batchId,
    count: promptIds.length,
    prompt_ids: promptIds,
    ...(errors.length > 0 ? { enqueue_errors: errors } : {}),
  };
}

// ── status ───────────────────────────────────────────────────────────────────

export async function batchStatus(batchId: string): Promise<BatchStatusResult> {
  const record = await loadBatch(batchId);
  const jobs: BatchJobStatus[] = [];
  for (const promptId of record.prompt_ids) {
    try {
      const status = await getJobStatus(promptId);
      const state: BatchJobState = status.error
        ? "error"
        : status.done
          ? "done"
          : status.running
            ? "running"
            : status.pending
              ? "pending"
              : "unknown";
      jobs.push({
        prompt_id: promptId,
        state,
        ...(status.status_str ? { status_str: status.status_str } : {}),
        ...(status.error ? { error_message: status.error.exception_message } : {}),
      });
    } catch (err) {
      jobs.push({
        prompt_id: promptId,
        state: "unknown",
        error_message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const rollup: Record<BatchJobState, number> = { pending: 0, running: 0, done: 0, error: 0, unknown: 0 };
  for (const j of jobs) rollup[j.state]++;
  const all_terminal = jobs.every((j) => j.state === "done" || j.state === "error");

  return {
    batch_id: record.batch_id,
    created_at: record.created_at,
    count: jobs.length,
    jobs,
    rollup,
    all_terminal,
  };
}

// ── output ───────────────────────────────────────────────────────────────────

export async function batchOutput(batchId: string): Promise<BatchOutputResult> {
  const status = await batchStatus(batchId);
  const outputs: BatchOutputResult["outputs"] = [];
  let completed = 0;

  for (const job of status.jobs) {
    if (job.state === "done") {
      try {
        const history = await getHistory(job.prompt_id);
        const entry = history[job.prompt_id];
        completed++;
        outputs.push({
          prompt_id: job.prompt_id,
          state: job.state,
          outputs: entry?.outputs ?? {},
        });
      } catch (err) {
        outputs.push({
          prompt_id: job.prompt_id,
          state: job.state,
          error_message: `history fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else {
      outputs.push({
        prompt_id: job.prompt_id,
        state: job.state,
        ...(job.error_message ? { error_message: job.error_message } : {}),
      });
    }
  }

  return { batch_id: batchId, count: status.count, completed, outputs };
}

// ── wait ─────────────────────────────────────────────────────────────────────

/** Absolute hard cap so wait_for_batch can never hang an agent turn. */
export const WAIT_HARD_CAP_S = 600;
const DEFAULT_WAIT_S = 300;
const POLL_INTERVAL_MS = 2000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitForBatch(
  batchId: string,
  timeoutS?: number,
  pollIntervalMs = POLL_INTERVAL_MS,
): Promise<BatchStatusResult & { timed_out: boolean; waited_s: number }> {
  const requested = Number.isFinite(timeoutS) && timeoutS! > 0 ? timeoutS! : DEFAULT_WAIT_S;
  const capped = Math.min(requested, WAIT_HARD_CAP_S);
  const started = Date.now();
  const deadline = started + capped * 1000;

  // The HARD cap must hold even when an individual status fetch stalls on a
  // wedged/unreachable ComfyUI (the underlying fetch has no abort timeout) —
  // or when the data dir itself sits on a stalled network filesystem. So ALL
  // awaited work, including the initial record load, runs inside the poll
  // loop and races an absolute deadline timer: whichever finishes first wins,
  // and a stalled in-flight await is simply abandoned.
  let lastStatus: BatchStatusResult | null = null;
  let record: BatchRecord | null = null;

  const pollLoop = (async (): Promise<BatchStatusResult> => {
    // Validate the id first so a typo fails fast instead of polling.
    record = await loadBatch(batchId);
    let status = await batchStatus(batchId);
    lastStatus = status;
    while (!status.all_terminal && Date.now() < deadline) {
      await sleep(Math.min(pollIntervalMs, Math.max(50, deadline - Date.now())));
      status = await batchStatus(batchId);
      lastStatus = status;
    }
    return status;
  })();

  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadlineHit = new Promise<"deadline">((resolve) => {
    deadlineTimer = setTimeout(() => resolve("deadline"), Math.max(0, deadline - Date.now()));
    // Don't let this timer keep the process alive after the loop wins the race.
    deadlineTimer.unref?.();
  });

  try {
    const winner = await Promise.race([pollLoop, deadlineHit]);
    if (winner !== "deadline") {
      return {
        ...winner,
        timed_out: !winner.all_terminal,
        waited_s: Math.round((Date.now() - started) / 1000),
      };
    }
  } finally {
    clearTimeout(deadlineTimer);
    // Abandoned loop: swallow its eventual settlement so nothing goes unhandled.
    void pollLoop.catch(() => undefined);
  }

  // Deadline fired while a poll was still in flight (stalled server or data
  // dir) — return the last snapshot we managed to get, else an all-unknown
  // rollup built from the record, else (record load itself stalled) an empty
  // timed-out shell.
  // TS can't see the closure assignment above, so re-widen explicitly.
  const rec = record as BatchRecord | null;
  const fallback: BatchStatusResult =
    lastStatus ??
    (rec
      ? {
          batch_id: rec.batch_id,
          created_at: rec.created_at,
          count: rec.prompt_ids.length,
          jobs: rec.prompt_ids.map((prompt_id) => ({
            prompt_id,
            state: "unknown" as const,
            error_message: "status unavailable before wait deadline (ComfyUI unreachable or stalled)",
          })),
          rollup: { pending: 0, running: 0, done: 0, error: 0, unknown: rec.prompt_ids.length },
          all_terminal: false,
        }
      : {
          batch_id: batchId,
          created_at: "",
          count: 0,
          jobs: [],
          rollup: { pending: 0, running: 0, done: 0, error: 0, unknown: 0 },
          all_terminal: false,
        });
  return {
    ...fallback,
    timed_out: true,
    waited_s: Math.round((Date.now() - started) / 1000),
  };
}
