// #796 — `waitForRunningCleared` folded a FAILED /queue poll into "still
// running", and after the timeout the caller declared the job "wedged inside
// a single step — restart ComfyUI, do NOT queue another run". A crashed
// ComfyUI also stops answering /queue — and takes the job with it — so the
// fold produced a confident wedge verdict (and a blocking instruction) about
// a job that no longer existed. The verdict is now three-state.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isCloudMode: () => queueBehavior.cloud,
}));

const queueBehavior = vi.hoisted(() => ({
  mode: "down" as
    | "down"
    | "running"
    | "dies"
    | "recovers"
    | "clears-after-free"
    | "unobserved-start"
    | "recovers-unobserved"
    | "someone-running"
    | "someone-wedged"
    | "dies-late"
    | "named-late"
    | "unwatched-then-wedged"
    | "gapped-then-wedged"
    | "gapped-final-wedged"
    | "target-clears-other-starts"
    | "stops-on-interrupt"
    | "idle"
    | "idle-with-pending",
  calls: 0,
  freeFails: false,
  clearFails: false,
  cloud: false,
}));

vi.mock("../../comfyui/client.js", () => ({
  getClient: vi.fn(),
  getHistory: vi.fn(),
  getQueue: async () => {
    queueBehavior.calls++;
    if (queueBehavior.mode === "down") throw new Error("ECONNREFUSED");
    if (queueBehavior.mode === "dies" && queueBehavior.calls > 2) {
      throw new Error("ECONNRESET");
    }
    // Unreachable through the honor window, then answers with an EMPTY queue:
    // the job is gone, but what removed it was never observed.
    if (queueBehavior.mode === "recovers") {
      if (queueBehavior.calls === 1) {
        return { queue_running: [[1, "prompt-xyz"]], queue_pending: [] };
      }
      if (queueBehavior.calls <= 3) throw new Error("ECONNRESET");
      return { queue_running: [], queue_pending: [] };
    }
    // The pre-interrupt read fails; every later poll answers EMPTY.
    if (queueBehavior.mode === "unobserved-start") {
      if (queueBehavior.calls === 1) throw new Error("ECONNREFUSED");
      return { queue_running: [], queue_pending: [] };
    }
    // NOTHING answers until the final verification poll, which is EMPTY.
    if (queueBehavior.mode === "recovers-unobserved") {
      if (queueBehavior.calls <= 3) throw new Error("ECONNRESET");
      return { queue_running: [], queue_pending: [] };
    }
    // Pre-check and first window fail; the named prompt appears in the FINAL window.
    if (queueBehavior.mode === "named-late") {
      if (queueBehavior.calls <= 3) throw new Error("ECONNRESET");
      return { queue_running: [[1, "prompt-xyz"]], queue_pending: [] };
    }
    // Running at every poll that answers, but one poll in the MIDDLE of the
    // honor window fails — so the window has a hole in it while still ending on
    // a live reading. (With COMFYUI_MCP_INTERRUPT_S=3.2 the honor window fits
    // three polls, calls 2–4; call 3 is the hole.)
    if (queueBehavior.mode === "gapped-then-wedged") {
      if (queueBehavior.calls === 3) throw new Error("ECONNRESET");
      return { queue_running: [[1, "prompt-xyz"]], queue_pending: [] };
    }
    // Mirror image: the honor window answers throughout, and the hole is in the
    // FINAL window instead (calls 5-7; call 6 is the hole).
    if (queueBehavior.mode === "gapped-final-wedged") {
      if (queueBehavior.calls === 6) throw new Error("ECONNRESET");
      return { queue_running: [[1, "prompt-xyz"]], queue_pending: [] };
    }
    // The NAMED target is running at the pre-check, and a DIFFERENT job holds
    // the running slot from the first poll on: the target cleared, the queue
    // did not go idle.
    if (queueBehavior.mode === "target-clears-other-starts") {
      if (queueBehavior.calls === 1) return { queue_running: [[1, "prompt-xyz"]], queue_pending: [] };
      return { queue_running: [[2, "someone-else"]], queue_pending: [] };
    }
    // Observed running at pre-check, honor window fails, final window: running.
    if (queueBehavior.mode === "unwatched-then-wedged") {
      if (queueBehavior.calls === 1) return { queue_running: [[1, "prompt-xyz"]], queue_pending: [] };
      if (queueBehavior.calls <= 3) throw new Error("ECONNRESET");
      return { queue_running: [[1, "prompt-xyz"]], queue_pending: [] };
    }
    // The FINAL window answers once (still running), then dies.
    if (queueBehavior.mode === "dies-late") {
      if (queueBehavior.calls <= 3) throw new Error("ECONNRESET");
      if (queueBehavior.calls === 4) return { queue_running: [[1, "prompt-xyz"]], queue_pending: [] };
      throw new Error("ECONNRESET");
    }
    // The pre-check fails; SOME job is running at every poll, forever.
    if (queueBehavior.mode === "someone-wedged") {
      if (queueBehavior.calls === 1) throw new Error("ECONNREFUSED");
      return { queue_running: [[1, "prompt-xyz"]], queue_pending: [] };
    }
    // The pre-check fails; the honor window shows SOME job running; empty after /free.
    if (queueBehavior.mode === "someone-running") {
      if (queueBehavior.calls === 1) throw new Error("ECONNREFUSED");
      if (queueBehavior.calls <= 3) return { queue_running: [[1, "prompt-xyz"]], queue_pending: [] };
      return { queue_running: [], queue_pending: [] };
    }
    // Running at the pre-check, empty from the first poll on.
    if (queueBehavior.mode === "stops-on-interrupt" && queueBehavior.calls >= 2) {
      return { queue_running: [], queue_pending: [] };
    }
    // Answering and running through the honor window, empty afterwards: the
    // /free escalation went out between the two.
    if (queueBehavior.mode === "clears-after-free" && queueBehavior.calls >= 4) {
      return { queue_running: [], queue_pending: [] };
    }
    // Idle at EVERY read: nothing running, nothing pending (#2517 — cancel
    // with clear_pending against this queue, and the clear request fails).
    if (queueBehavior.mode === "idle") {
      return { queue_running: [], queue_pending: [] };
    }
    // Nothing running, but pending jobs ARE queued and the clear cannot
    // remove them — the case where a failed clear IS a real failure.
    if (queueBehavior.mode === "idle-with-pending") {
      return { queue_running: [], queue_pending: [[2, "prompt-abc"]] };
    }
    return { queue_running: [[1, "prompt-xyz"]], queue_pending: [] };
  },
  interrupt: async () => {},
  deleteQueueItem: vi.fn(),
  clearQueue: async () => {
    if (queueBehavior.clearFails) throw new Error("clear refused");
  },
  enqueuePrompt: vi.fn(),
  freeMemory: async () => {
    if (queueBehavior.freeFails) throw new Error("free refused");
  },
}));

import { cancelRunningJobEscalating } from "../../services/queue-manager.js";

let savedInterruptS: string | undefined;

beforeEach(() => {
  queueBehavior.calls = 0;
  queueBehavior.freeFails = false;
  queueBehavior.clearFails = false;
  queueBehavior.cloud = false;
  savedInterruptS = process.env.COMFYUI_MCP_INTERRUPT_S;
  process.env.COMFYUI_MCP_INTERRUPT_S = "2"; // keep the honor window short
});

afterEach(() => {
  if (savedInterruptS === undefined) delete process.env.COMFYUI_MCP_INTERRUPT_S;
  else process.env.COMFYUI_MCP_INTERRUPT_S = savedInterruptS;
});

describe("cancel escalation never folds a dead queue into a wedge verdict", () => {
  it(
    "a queue that NEVER answers reports UNKNOWN, not wedged",
    { timeout: 20000 },
    async () => {
      queueBehavior.mode = "down";
      const res = await cancelRunningJobEscalating({});
      expect(res.wedged).toBe(false);
      expect(res.unverified).toBe(true);
      expect(res.honored).toBe(false);
      // Nothing about the queue was established, so nothing may read this as
      // permission to carry on (the tool turns this into isError).
      expect(res.target_state).toBe("unknown");
      expect(res.message).toMatch(/UNKNOWN/);
      // It never answered — the message must not claim a transition.
      expect(res.message).toMatch(/did not answer during verification/);
      // The confident wedge diagnosis and its blocking instruction must be gone.
      expect(res.message).not.toMatch(/wedged inside a single step/);
      expect(res.message).not.toMatch(/Do NOT queue another run/);
    },
  );

  it(
    "a queue that dies MID-verification is unknown, not wedged",
    { timeout: 20000 },
    async () => {
      queueBehavior.mode = "dies";
      const res = await cancelRunningJobEscalating({});
      expect(res.wedged).toBe(false);
      expect(res.unverified).toBe(true);
      expect(res.target_state).toBe("unknown");
      expect(res.message).toMatch(/UNKNOWN/);
      // The final verification window never answered.
      expect(res.message).toMatch(/did not answer during verification/);
    },
  );

  it(
    "cloud mode never narrates a VRAM free (the call is a no-op there)",
    { timeout: 20000 },
    async () => {
      queueBehavior.mode = "running";
      queueBehavior.cloud = true;
      const res = await cancelRunningJobEscalating({});
      expect(res.wedged).toBe(true);
      expect(res.freed_vram).toBe(false);
      expect(res.message).not.toMatch(/VRAM free/);
    },
  );

  it(
    "a wedge after an UNWATCHED first window does not claim continuous polling",
    { timeout: 20000 },
      async () => {
      queueBehavior.mode = "unwatched-then-wedged";
      const res = await cancelRunningJobEscalating({});
      expect(res.wedged).toBe(true);
      expect(res.message).toMatch(/wedged inside a single step/);
      expect(res.message).toMatch(/at a verified check/);
      expect(res.message).not.toMatch(/across ~\d+s of verified polling/);
    },
  );

  // `lastPollFailed` was cleared by any later successful poll, so a window that
  // went running → poll failure → running came back as plain "still-running"
  // and the wedge message called it "~Ns of VERIFIED polling". A restart or a
  // disconnect inside that hole is exactly the case the "restart ComfyUI, do
  // NOT queue another run" guidance would be wrong about — a sampled
  // observation with a gap narrated as continuous verification.
  it(
    "a window with a FAILED poll in the middle is not narrated as verified polling",
    { timeout: 30000 },
    async () => {
      process.env.COMFYUI_MCP_INTERRUPT_S = "3.2"; // two polls per window
      queueBehavior.mode = "gapped-then-wedged";
      const res = await cancelRunningJobEscalating({});
      // The verdict itself is unchanged: the last poll of each window answered
      // and showed it running, and that IS a live reading of now. Only the
      // claim about the window narrows — turning this into "unobservable"
      // would be the overshoot, refusing a wedge that was actually observed.
      expect(res.wedged).toBe(true);
      expect(res.target_state).toBe("running");
      expect(res.message).toMatch(/wedged inside a single step/);
      expect(res.message).not.toMatch(/of verified polling/);
      expect(res.message).toMatch(/did NOT answer throughout/);
    },
  );

  // The stated duration spans BOTH windows, so a hole in either one makes the
  // span not continuously verified. Checking only the first window left the
  // same overclaim standing over a gap in the second (codex gate).
  it(
    "a gap in the FINAL window is not narrated as verified polling either",
    { timeout: 30000 },
    async () => {
      process.env.COMFYUI_MCP_INTERRUPT_S = "3.2";
      queueBehavior.mode = "gapped-final-wedged";
      const res = await cancelRunningJobEscalating({});
      expect(res.wedged).toBe(true);
      expect(res.target_state).toBe("running");
      expect(res.message).not.toMatch(/of verified polling/);
      expect(res.message).toMatch(/did NOT answer throughout/);
    },
  );

  // target_state answers for the JOB THIS CALL ADDRESSED, not for the queue.
  // The cancel did exactly what it promised; the queue advancing to the next
  // job is normal, and failing the call for it would be a false failure —
  // clear_pending is the switch for emptying the queue.
  it(
    "a named target that clears while ANOTHER job runs is stopped, not unsettled",
    { timeout: 20000 },
    async () => {
      queueBehavior.mode = "target-clears-other-starts";
      const res = await cancelRunningJobEscalating({ prompt_id: "prompt-xyz" });
      expect(res.target_state).toBe("stopped");
      expect(res.wedged).toBe(false);
      expect(res.honored).toBe(true);
      expect(res.message).toMatch(/Interrupted the running job/);
    },
  );

  it(
    "a wedged verdict with a failed /free does not claim freed VRAM",
    { timeout: 20000 },
    async () => {
      queueBehavior.mode = "running";
      queueBehavior.freeFails = true;
      const res = await cancelRunningJobEscalating({});
      expect(res.wedged).toBe(true);
      expect(res.freed_vram).toBe(false);
      expect(res.message).toMatch(/VRAM-free escalation did not complete/);
    },
  );

  it(
    "a job still running on a LIVE queue is still declared wedged (control)",
    { timeout: 20000 },
    async () => {
      queueBehavior.mode = "running";
      const res = await cancelRunningJobEscalating({});
      expect(res.wedged).toBe(true);
      expect(res.unverified).toBeUndefined();
      expect(res.target_state).toBe("running");
      expect(res.message).toMatch(/wedged inside a single step/);
      // The stated duration must be BOTH windows (2s honor + 2s re-check here),
      // not just the first.
      expect(res.message).toMatch(/across ~4s of verified polling/);
    },
  );

  it(
    "a FAILED /free escalation is not narrated as a performed one",
    { timeout: 20000 },
    async () => {
      queueBehavior.mode = "down";
      queueBehavior.freeFails = true;
      const res = await cancelRunningJobEscalating({});
      expect(res.unverified).toBe(true);
      expect(res.freed_vram).toBe(false);
      expect(res.message).toMatch(/VRAM-free escalation did not complete/);
      // A throw means no completion was OBSERVED — never "never reached the server".
      expect(res.message).not.toMatch(/never reached the server/);
      expect(res.message).not.toMatch(/\(and a VRAM free\)/);
    },
  );

  it(
    "a FAILED clear_pending is not reported as cleared",
    { timeout: 20000 },
    async () => {
      queueBehavior.mode = "down";
      queueBehavior.clearFails = true;
      const res = await cancelRunningJobEscalating({ clear_pending: true });
      expect(res.unverified).toBe(true);
      expect(res.pending_cleared).toBeUndefined();
      expect(res.message).toMatch(/Clearing pending jobs FAILED/);
      expect(res.message).not.toMatch(/Pending jobs were cleared/);
    },
  );

  it(
    "an idle queue is not told pending jobs FAILED to clear when the request fails (#2517)",
    { timeout: 20000 },
    async () => {
      // Nothing running, nothing pending — and the clear REQUEST still fails.
      // The queue the same call just read holds no pending jobs, so "they may
      // still be queued" is a contradiction, not a caution: the goal the clear
      // was for is verifiably settled, and the result must read as a clean
      // no-op rather than an unsettled failure.
      queueBehavior.mode = "idle";
      queueBehavior.clearFails = true;
      const res = await cancelRunningJobEscalating({ clear_pending: true });
      expect(res.target_state).toBe("stopped");
      expect(res.pending_clear_failed).toBeUndefined();
      expect(res.pending_cleared).toBeUndefined();
      expect(res.message).toMatch(/No job is running\./);
      // The failed request is still disclosed — honestly, and in present tense.
      expect(res.message).toMatch(/clear request failed/);
      expect(res.message).toMatch(/no pending jobs/);
      expect(res.message).not.toMatch(/FAILED/);
      expect(res.message).not.toMatch(/may still be queued/);
      expect(res.message).not.toMatch(/Pending jobs were cleared/);
    },
  );

  it(
    "a clear that fails with pending jobs STILL queued is still a failure (control)",
    { timeout: 20000 },
    async () => {
      // The inverse, which is how the #2517 fix could overshoot: nothing is
      // running, but the pending backlog IS there and the clear did not
      // remove it. That remains a real failure.
      queueBehavior.mode = "idle-with-pending";
      queueBehavior.clearFails = true;
      const res = await cancelRunningJobEscalating({ clear_pending: true });
      expect(res.target_state).toBe("stopped");
      expect(res.pending_clear_failed).toBe(true);
      expect(res.pending_cleared).toBeUndefined();
      expect(res.message).toMatch(/Clearing pending jobs FAILED/);
      expect(res.message).not.toMatch(/Pending jobs were cleared/);
    },
  );

  it(
    "cleared after /free states the SEQUENCE, never the cause",
    { timeout: 20000 },
    async () => {
      queueBehavior.mode = "clears-after-free";
      const res = await cancelRunningJobEscalating({});
      expect(res.honored).toBe(true);
      expect(res.wedged).toBe(false);
      expect(res.message).toMatch(/has now STOPPED \(verified via \/queue\)/);
      expect(res.message).not.toMatch(/freeing VRAM cleared it/);
    },
  );

  it(
    "an unclear stop after a FAILED /free does not suggest the free may have worked",
    { timeout: 20000 },
    async () => {
      queueBehavior.mode = "recovers";
      queueBehavior.freeFails = true;
      const res = await cancelRunningJobEscalating({});
      expect(res.honored).toBe(true);
      expect(res.freed_vram).toBe(false);
      expect(res.message).toMatch(/VRAM-free escalation did not complete/);
      expect(res.message).not.toMatch(/VRAM free may have done it/);
    },
  );

  it(
    "gone-after-an-unobservable window does NOT credit the VRAM free with the stop",
    { timeout: 20000 },
    async () => {
      queueBehavior.mode = "recovers";
      const res = await cancelRunningJobEscalating({});
      expect(res.honored).toBe(true);
      expect(res.wedged).toBe(false);
      // The stop is verified; its cause is not. `unverified` covers the CAUSE
      // here, and target_state must not borrow that doubt: /queue was read and
      // is empty, so a consumer treating this as unsettled would refuse a
      // caller the free queue it can see.
      expect(res.target_state).toBe("stopped");
      expect(res.message).toMatch(/what stopped it is unknown/);
      expect(res.message).not.toMatch(/freeing VRAM cleared it/);
    },
  );

  it(
    "an UNOBSERVED start is not reported as 'Interrupted the running job'",
    { timeout: 20000 },
    async () => {
      // The pre-interrupt read failed, then the queue answered EMPTY. All that
      // is established is "nothing is running now" — never that the interrupt
      // stopped something.
      queueBehavior.mode = "unobserved-start";
      const res = await cancelRunningJobEscalating({});
      expect(res.honored).toBe(false);
      expect(res.unverified).toBe(true);
      expect(res.wedged).toBe(false);
      // Same split: the START was never observed, but the queue is verifiably
      // empty NOW.
      expect(res.target_state).toBe("stopped");
      expect(res.message).toMatch(/nothing is running now/);
      expect(res.message).toMatch(/UNKNOWN/);
      expect(res.message).not.toMatch(/Interrupted the running job/);
    },
  );

  it(
    "an observed stop is still reported as interrupted (control)",
    { timeout: 20000 },
    async () => {
      queueBehavior.mode = "stops-on-interrupt";
      const res = await cancelRunningJobEscalating({});
      expect(res.honored).toBe(true);
      expect(res.unverified).toBeUndefined();
      expect(res.message).toMatch(/Interrupted the running job/);
    },
  );

  it(
    "empty-after-total-outage asserts neither a running job nor a stop cause",
    { timeout: 20000 },
    async () => {
      queueBehavior.mode = "recovers-unobserved";
      const res = await cancelRunningJobEscalating({});
      expect(res.honored).toBe(false);
      expect(res.unverified).toBe(true);
      expect(res.wedged).toBe(false);
      expect(res.message).toMatch(/Nothing is running now \(verified via \/queue\)/);
      expect(res.message).toMatch(/UNKNOWN/);
      expect(res.message).not.toMatch(/The running job/);
    },
  );

  it(
    "the UNKNOWN verdict never invents an observed running job",
    { timeout: 20000 },
    async () => {
      queueBehavior.mode = "down";
      const res = await cancelRunningJobEscalating({});
      expect(res.unverified).toBe(true);
      expect(res.message).toMatch(/An interrupt was sent/);
      expect(res.message).not.toMatch(/The running job/);
    },
  );

  it(
    "a named prompt first sighted INSIDE the window is not a verified stop either",
    { timeout: 20000 },
    async () => {
      // Pre-check fails; the prompt appears during the honor window (it may
      // have STARTED after the interrupt — a no-op for it), then clears.
      queueBehavior.mode = "someone-running";
      const res = await cancelRunningJobEscalating({ prompt_id: "prompt-xyz" });
      expect(res.honored).toBe(false);
      expect(res.unverified).toBe(true);
      expect(res.message).toMatch(/whether the job that stopped is the one that was interrupted is UNKNOWN/);
      expect(res.message).not.toMatch(/has now STOPPED/);
    },
  );

  it(
    "a NAMED prompt never observed before the interrupt keeps the identity caveat",
    { timeout: 20000 },
    async () => {
      queueBehavior.mode = "named-late";
      const res = await cancelRunningJobEscalating({ prompt_id: "prompt-xyz" });
      expect(res.wedged).toBe(true);
      expect(res.unverified).toBe(true);
      expect(res.message).toMatch(/Whether this IS the job the interrupt addressed is UNKNOWN/);
      expect(res.message).toMatch(/may have started after/);
      expect(res.message).not.toMatch(/did NOT stop after interrupt/);
    },
  );

  it(
    "a queue that answers once in the final window and then dies says so",
    { timeout: 20000 },
    async () => {
      queueBehavior.mode = "dies-late";
      const res = await cancelRunningJobEscalating({});
      expect(res.unverified).toBe(true);
      expect(res.message).toMatch(/stopped answering partway through verification/);
      expect(res.message).not.toMatch(/did not answer during verification/);
    },
  );

  it(
    "a wedged job whose start was never observed keeps the caveat",
    { timeout: 20000 },
    async () => {
      queueBehavior.mode = "someone-wedged";
      const res = await cancelRunningJobEscalating({});
      // A job IS verifiably wedged — but its identity was never established.
      expect(res.wedged).toBe(true);
      expect(res.unverified).toBe(true);
      // …so the FIELD must not claim the identity the prose disclaims. With no
      // prompt_id and no pre-interrupt read, the poll established that SOME job
      // is running, not that it is the one the interrupt addressed.
      expect(res.target_state).toBe("unknown");
      expect(res.message).toMatch(/wedged inside a single step/);
      expect(res.message).toMatch(/Whether this IS the job the interrupt addressed is UNKNOWN/);
      expect(res.message).not.toMatch(/The running job/);
    },
  );

  it(
    "a job seen only DURING the window is not tied to the interrupt",
    { timeout: 20000 },
    async () => {
      queueBehavior.mode = "someone-running";
      const res = await cancelRunningJobEscalating({});
      expect(res.honored).toBe(false);
      expect(res.unverified).toBe(true);
      expect(res.message).toMatch(/whether the job that stopped is the one that was interrupted is UNKNOWN/);
      expect(res.message).not.toMatch(/The job didn't stop/);
    },
  );
});
