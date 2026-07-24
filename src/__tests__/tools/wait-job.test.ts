import { describe, expect, it, vi } from "vitest";
import { waitForJob } from "../../tools/wait-job.js";
import type { JobStatus } from "../../services/queue-manager.js";

const PROMPT_ID = "prompt-wait-1";

const running: JobStatus = { running: true, pending: false, done: false };
const pending: JobStatus = { running: false, pending: true, done: false };
const done: JobStatus = {
  running: false,
  pending: false,
  done: true,
  status_str: "success",
};

/** Deterministic clock: sleep advances a fake clock instead of real time. */
function fakeClock() {
  let t = 0;
  return {
    nowFn: () => t,
    sleepFn: vi.fn(async (ms: number) => {
      t += ms;
    }),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("waitForJob", () => {
  it("polls until the job is done and returns the terminal status", async () => {
    const clock = fakeClock();
    const statusFn = vi
      .fn<(id: string) => Promise<JobStatus>>()
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(done);

    const result = await waitForJob(
      { prompt_id: PROMPT_ID, timeout_s: 300, poll_interval_ms: 1500 },
      { statusFn, ...clock },
    );

    expect(statusFn).toHaveBeenCalledTimes(4);
    expect(statusFn).toHaveBeenCalledWith(PROMPT_ID);
    expect(result.timed_out).toBe(false);
    expect(result.polls).toBe(4);
    expect(result.status).toEqual(done);
    expect(result.message).toContain("completed");
    // Slept between polls, never after the terminal poll.
    expect(clock.sleepFn).toHaveBeenCalledTimes(3);
    expect(clock.sleepFn).toHaveBeenCalledWith(1500);
  });

  it("reports an error outcome when the job finishes failed", async () => {
    const failed: JobStatus = {
      running: false,
      pending: false,
      done: true,
      status_str: "error",
      error: {
        exception_type: "RuntimeError",
        exception_message: "CUDA out of memory",
      } as JobStatus["error"],
    };
    const clock = fakeClock();
    const statusFn = vi.fn(async () => failed);

    const result = await waitForJob({ prompt_id: PROMPT_ID }, { statusFn, ...clock });

    expect(result.timed_out).toBe(false);
    expect(result.status.error).toBeDefined();
    expect(result.message).toContain("RuntimeError");
  });

  it.each(["failed", "error"] as const)(
    "in cloud mode, reports done+status_str:'%s' with no error object as a definitive failure",
    async (statusStr) => {
      // Cloud history enrichment can rewrite "failed" to "error", so both
      // spellings must classify as failure in cloud mode.
      const failed: JobStatus = {
        running: false,
        pending: false,
        done: true,
        status_str: statusStr,
      };
      const clock = fakeClock();
      const statusFn = vi.fn(async () => failed);

      const result = await waitForJob(
        { prompt_id: PROMPT_ID },
        { statusFn, ...clock, cloudModeFn: () => true },
      );

      expect(result.timed_out).toBe(false);
      expect(result.message).toContain("failed");
      // Cloud failure is definitive — must NOT be hedged as maybe-cancelled.
      expect(result.message).not.toContain("interrupted");
      expect(result.message).not.toContain("cancelled");
    },
  );

  it("does not call a local interrupted job (done+error status, no error object) a failure", async () => {
    // Local ComfyUI reports interruptions exactly like this — done:true,
    // status_str "error", and NO structured error.
    const interrupted: JobStatus = {
      running: false,
      pending: false,
      done: true,
      status_str: "error",
    };
    const clock = fakeClock();
    const statusFn = vi.fn(async () => interrupted);

    const result = await waitForJob(
      { prompt_id: PROMPT_ID },
      { statusFn, ...clock, cloudModeFn: () => false },
    );

    expect(result.timed_out).toBe(false);
    expect(result.message).not.toContain("finished with an error");
    expect(result.message).toContain("interrupted");
  });

  it("treats cloud-style 'cancelled' (done:false) as terminal instead of spinning", async () => {
    const cancelled: JobStatus = {
      running: false,
      pending: false,
      done: false,
      status_str: "cancelled",
    };
    const clock = fakeClock();
    const statusFn = vi
      .fn<(id: string) => Promise<JobStatus>>()
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(cancelled);

    const result = await waitForJob({ prompt_id: PROMPT_ID }, { statusFn, ...clock });

    expect(statusFn).toHaveBeenCalledTimes(2);
    expect(result.timed_out).toBe(false);
    expect(result.message).toContain("cancelled");
  });

  it("returns timed_out (without throwing) when the job never finishes", async () => {
    const clock = fakeClock();
    const statusFn = vi.fn(async () => running);

    const result = await waitForJob(
      { prompt_id: PROMPT_ID, timeout_s: 6, poll_interval_ms: 1500 },
      { statusFn, ...clock },
    );

    expect(result.timed_out).toBe(true);
    // 6s / 1.5s poll -> initial poll + 4 sleeps + final poll at deadline.
    expect(result.polls).toBe(5);
    expect(result.status).toEqual(running);
    expect(result.message).toContain("still running after 6s");
    expect(result.message).toContain("NOT been cancelled");
  });

  it("clamps timeout to the hard cap so it can never wait forever", async () => {
    const clock = fakeClock();
    const statusFn = vi.fn(async () => pending);

    const result = await waitForJob(
      { prompt_id: PROMPT_ID, timeout_s: 999_999, poll_interval_ms: 30_000 },
      { statusFn, ...clock },
    );

    expect(result.timed_out).toBe(true);
    // Hard cap 1800s at 30s polls -> bounded number of polls, not ~33k.
    expect(statusFn.mock.calls.length).toBeLessThanOrEqual(62);
    expect(result.message).toContain("after 1800s");
  });

  it("clamps poll_interval_ms so tiny values cannot busy-spin", async () => {
    const clock = fakeClock();
    const statusFn = vi
      .fn<(id: string) => Promise<JobStatus>>()
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(done);

    await waitForJob(
      { prompt_id: PROMPT_ID, poll_interval_ms: 1 },
      { statusFn, ...clock },
    );

    expect(clock.sleepFn).toHaveBeenCalledWith(250);
  });

  it("times out even when the status source hangs and never resolves", async () => {
    const clock = fakeClock();
    // Never resolves — simulates ComfyUI stalling mid-request. The deadline
    // race uses REAL time, so use the minimum 1s timeout.
    const statusFn = vi.fn(() => new Promise<JobStatus>(() => {}));

    const result = await waitForJob(
      { prompt_id: PROMPT_ID, timeout_s: 1 },
      { statusFn, ...clock },
    );

    expect(result.timed_out).toBe(true);
    expect(result.polls).toBe(1);
    expect(result.status.done).toBe(false);
    expect(result.message).toContain("did not respond");
  }, 10_000);

  it("propagates status-source errors like get_job_status does", async () => {
    const clock = fakeClock();
    const statusFn = vi.fn(async () => {
      throw new Error("ComfyUI unreachable");
    });

    await expect(
      waitForJob({ prompt_id: PROMPT_ID }, { statusFn, ...clock }),
    ).rejects.toThrow("ComfyUI unreachable");
  });
});
