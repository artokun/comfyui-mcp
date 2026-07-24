import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getJobStatus, type JobStatus } from "../services/queue-manager.js";
import { errorToToolResult } from "../utils/errors.js";

const DEFAULT_TIMEOUT_S = 300;
/** Hard cap so wait_for_job can never hang an agent turn indefinitely. */
const MAX_TIMEOUT_S = 1800;
const DEFAULT_POLL_INTERVAL_MS = 1500;
const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 30_000;

export interface WaitForJobResult {
  prompt_id: string;
  timed_out: boolean;
  waited_s: number;
  polls: number;
  /** Final observed status — the same shape get_job_status returns. */
  status: JobStatus;
  message: string;
}

interface WaitForJobDeps {
  /** Status source (defaults to the same service get_job_status uses). */
  statusFn?: (promptId: string) => Promise<JobStatus>;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const POLL_HUNG = Symbol("poll-hung");

/** Race a status poll against the remaining deadline so a stalled/hung status
 *  request can never suspend the wait past its timeout (the hard cap must hold
 *  even when ComfyUI stops answering, not just when it answers slowly). */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof POLL_HUNG> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof POLL_HUNG>((resolve) => {
        timer = setTimeout(() => resolve(POLL_HUNG), Math.max(ms, 1));
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // If the deadline won, a later rejection of the abandoned poll must not
    // become an unhandled rejection.
    promise.catch(() => {});
  }
}

function describeState(status: JobStatus): string {
  if (status.running) return "running";
  if (status.pending) return "pending";
  return "in an unknown (not queued, not finished) state";
}

/** Poll a job's status until it reaches a terminal state or the timeout elapses.
 *  Never throws on timeout — the caller gets a clear timed_out result instead.
 *  Status-source errors DO propagate (same behavior as get_job_status). */
export async function waitForJob(
  opts: { prompt_id: string; timeout_s?: number; poll_interval_ms?: number },
  deps: WaitForJobDeps = {},
): Promise<WaitForJobResult> {
  const timeoutS = Math.min(Math.max(opts.timeout_s ?? DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S);
  const pollMs = Math.min(
    Math.max(opts.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS),
    MAX_POLL_INTERVAL_MS,
  );
  const statusFn = deps.statusFn ?? getJobStatus;
  const sleep = deps.sleepFn ?? realSleep;
  const now = deps.nowFn ?? Date.now;

  const start = now();
  const deadline = start + timeoutS * 1000;
  let polls = 0;

  let lastStatus: JobStatus | undefined;

  for (;;) {
    polls++;
    const polled = await withDeadline(statusFn(opts.prompt_id), deadline - now());
    const waitedS = Math.round((now() - start) / 100) / 10;

    if (polled === POLL_HUNG) {
      return {
        prompt_id: opts.prompt_id,
        timed_out: true,
        waited_s: waitedS,
        polls,
        status: lastStatus ?? { running: false, pending: false, done: false },
        message:
          `Timed out: the status check for job ${opts.prompt_id} did not respond within the ` +
          `${timeoutS}s timeout (${polls} polls${lastStatus ? `; last observed state: ${describeState(lastStatus)}` : ""}). ` +
          `ComfyUI may be busy or unreachable — the job has NOT been cancelled. ` +
          `Try wait_for_job again, get_job_status, or health_check.`,
      };
    }
    const status = polled;
    lastStatus = status;

    if (status.done) {
      const outcome = status.error
        ? `finished with an error (${status.error.exception_type ?? "execution error"})`
        : `completed${status.status_str ? ` (${status.status_str})` : ""}`;
      return {
        prompt_id: opts.prompt_id,
        timed_out: false,
        waited_s: waitedS,
        polls,
        status,
        message: `Job ${opts.prompt_id} ${outcome} after ${waitedS}s.`,
      };
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      return {
        prompt_id: opts.prompt_id,
        timed_out: true,
        waited_s: waitedS,
        polls,
        status,
        message:
          `Timed out: job ${opts.prompt_id} is still ${describeState(status)} after ${timeoutS}s ` +
          `(${polls} polls). It has NOT been cancelled — call wait_for_job again to keep waiting, ` +
          `get_job_status to check once, or cancel_job to stop it.`,
      };
    }

    await sleep(Math.min(pollMs, remaining));
  }
}

export function registerWaitJobTools(server: McpServer): void {
  server.tool(
    "wait_for_job",
    "Block until ONE ComfyUI job (by prompt_id from enqueue_workflow) reaches a terminal state — done or error — or the timeout elapses. Polls the same status source as get_job_status so the final result has the identical shape (running/pending/done, status_str, error details, execution_stats, text_outputs). Prefer this over calling get_job_status in a loop. On timeout it returns timed_out:true with the last observed status — the job keeps running; call again to keep waiting or cancel_job to stop it.",
    {
      prompt_id: z.string().describe("The prompt ID returned by enqueue_workflow"),
      timeout_s: z
        .number()
        .optional()
        .describe(`Max seconds to wait before returning timed_out:true. Default ${DEFAULT_TIMEOUT_S}, hard cap ${MAX_TIMEOUT_S}.`),
      poll_interval_ms: z
        .number()
        .optional()
        .describe(`Milliseconds between status polls. Default ${DEFAULT_POLL_INTERVAL_MS} (clamped to ${MIN_POLL_INTERVAL_MS}-${MAX_POLL_INTERVAL_MS}).`),
    },
    async (args) => {
      try {
        const result = await waitForJob(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
