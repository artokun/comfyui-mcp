// queue-monitor.stall.test.ts — the liveness-gated stall verdict (#183).
//
// The old heuristic flagged a stall on a flat "no FORWARD progress for N
// seconds", which false-fires on a legitimately long, progress-silent node
// (tiled VAE decode, audio/video sampling, a big model load): ComfyUI emits no
// progress tick for minutes while genuinely busy. report() now gates the verdict
// on server LIVENESS — a job is stalled only when the server has ALSO gone dark
// here (no ws frame + no successful /queue poll within the window). A reachable
// ComfyUI keeps the 1 Hz poll fresh, so a busy decode stays live; a crashed /
// wedged server lets the heartbeat lapse → a real stall still surfaces. A hard
// floor of 30 min backstops a genuine in-node deadlock on a reachable server —
// but NOT for runs whose graph contains a known TRAINING node class (#1652):
// TrainLoraNode & co. emit no per-step progress frames for hours by design, so
// the floor fired on every healthy long training run.
import { beforeEach, describe, expect, it } from "vitest";
import { QueueMonitor, type CompletionEvent, type StallReport } from "../../services/queue-monitor.js";

type Priv = {
  url: string | null;
  stopped: boolean;
  state: {
    connected: boolean;
    runningPromptId: string | null;
    currentNode: string | null;
    progressValue: number | null;
    progressMax: number | null;
    queueRemaining: number;
    runningNodeClassTypes: Record<string, string>;
    lastActivityTs: number | null;
    lastFrameTs: number | null;
    lastServerAliveTs: number | null;
    lastCompleted: CompletionEvent | null;
  };
  report(stallMs: number): StallReport;
};
const priv = QueueMonitor as unknown as Priv;

const STALL_MS = 180_000; // the default 180s threshold
const HARD_FLOOR_MS = 30 * 60 * 1000;

/** Put the monitor into "a job has been running, last forward progress was
 *  `idleForMs` ago" and set the two liveness heartbeats explicitly. */
function primeRunning(opts: {
  idleForMs: number;
  serverAliveAgoMs: number | null; // null = never / stale beyond memory
  wsFrameAgoMs: number | null;
  currentNode?: string | null;
  nodeClassTypes?: Record<string, string>;
}): void {
  const now = Date.now();
  priv.state.runningPromptId = "prompt-1";
  priv.state.currentNode = opts.currentNode ?? "42";
  priv.state.progressValue = 4;
  priv.state.progressMax = 8;
  priv.state.queueRemaining = 1;
  priv.state.runningNodeClassTypes = opts.nodeClassTypes ?? {};
  priv.state.lastActivityTs = now - opts.idleForMs;
  priv.state.lastServerAliveTs = opts.serverAliveAgoMs == null ? null : now - opts.serverAliveAgoMs;
  priv.state.lastFrameTs = opts.wsFrameAgoMs == null ? null : now - opts.wsFrameAgoMs;
}

beforeEach(() => {
  priv.url = "http://127.0.0.1:9999";
  priv.stopped = false;
  priv.state.connected = true;
  priv.state.runningPromptId = null;
  priv.state.currentNode = null;
  priv.state.progressValue = null;
  priv.state.progressMax = null;
  priv.state.queueRemaining = 0;
  priv.state.runningNodeClassTypes = {};
  priv.state.lastActivityTs = null;
  priv.state.lastFrameTs = null;
  priv.state.lastServerAliveTs = null;
  priv.state.lastCompleted = null;
});

describe("QueueMonitor.report — liveness-gated stall (#183)", () => {
  it("does NOT flag a busy long node: no forward progress but the /queue poll is fresh", () => {
    // The reporter's case: an LTX video/VAE step ran ~443s with no panel-visible
    // progress while ComfyUI was perfectly alive (answering /queue every second).
    primeRunning({ idleForMs: 443_000, serverAliveAgoMs: 800, wsFrameAgoMs: null });
    const rep = priv.report(STALL_MS);
    expect(rep.stalled).toBe(false);
    expect(rep.stalledForMs).toBe(0);
  });

  it("does NOT flag a busy node kept alive by ws frames alone (poll heartbeat absent)", () => {
    primeRunning({ idleForMs: 443_000, serverAliveAgoMs: null, wsFrameAgoMs: 1_000 });
    expect(priv.report(STALL_MS).stalled).toBe(false);
  });

  it("DOES flag a real stall: no forward progress AND the server has gone dark here", () => {
    // Server stopped answering /queue and stopped sending ws frames well beyond
    // the window — a crashed / event-loop-wedged ComfyUI, not a slow node.
    primeRunning({ idleForMs: STALL_MS + 60_000, serverAliveAgoMs: STALL_MS + 60_000, wsFrameAgoMs: STALL_MS + 60_000 });
    const rep = priv.report(STALL_MS);
    expect(rep.stalled).toBe(true);
    expect(rep.stalledForMs).toBeGreaterThanOrEqual(STALL_MS);
    expect(rep.runningPromptId).toBe("prompt-1");
  });

  it("hard-floor backstop: an in-node deadlock on a still-reachable server flags after 30 min", () => {
    // Server still answering (fresh poll) but ZERO forward progress for > 30 min
    // — a genuine deadlock that must not be suppressed forever.
    primeRunning({ idleForMs: HARD_FLOOR_MS + 60_000, serverAliveAgoMs: 500, wsFrameAgoMs: null });
    expect(priv.report(STALL_MS).stalled).toBe(true);
  });

  it("never flags when nothing is running", () => {
    priv.state.runningPromptId = null;
    priv.state.lastActivityTs = Date.now() - 10 * HARD_FLOOR_MS;
    expect(priv.report(STALL_MS).stalled).toBe(false);
  });
});

describe("QueueMonitor.report — training exemption from the hard floor (#1652)", () => {
  // A TrainLoraNode run emits no per-step progress frames: idleFor grows for
  // the whole run while ComfyUI stays perfectly responsive. The hard floor
  // fired on EVERY training run past 30 minutes and the injected note told the
  // agent to cancel it — killing a healthy 65-minute job.
  const TRAINING_GRAPH = {
    "3": "LoadImageTextDataSetFromFolder",
    "5": "MakeTrainingDataset",
    "7": "TrainLoraNode",
    "9": "SaveLoRA",
  };

  it("does NOT flag a healthy training run past the hard floor — current node unknown (the reported case)", () => {
    // Attached mid-run: no progress_state transition ever arrives, so
    // currentNode stays null and only the /queue graph names the trainer.
    primeRunning({
      idleForMs: HARD_FLOOR_MS + 15 * 60_000, // 45 min in — mid-training
      serverAliveAgoMs: 800, // /queue poll fresh: server fully responsive
      wsFrameAgoMs: null,
      currentNode: null,
      nodeClassTypes: TRAINING_GRAPH,
    });
    const rep = priv.report(STALL_MS);
    expect(rep.stalled).toBe(false);
    expect(rep.stalledForMs).toBe(0);
  });

  it("does NOT flag when the current node IS the trainer", () => {
    primeRunning({
      idleForMs: HARD_FLOOR_MS + 60_000,
      serverAliveAgoMs: 800,
      wsFrameAgoMs: null,
      currentNode: "7",
      nodeClassTypes: TRAINING_GRAPH,
    });
    expect(priv.report(STALL_MS).stalled).toBe(false);
  });

  it("still hard-flags a NON-training node past the floor, even inside a training graph", () => {
    // Stuck on an ordinary node in a graph that also trains: the exemption is
    // scoped to the trainer itself, so the deadlock backstop is preserved.
    primeRunning({
      idleForMs: HARD_FLOOR_MS + 60_000,
      serverAliveAgoMs: 500,
      wsFrameAgoMs: null,
      currentNode: "9", // SaveLoRA
      nodeClassTypes: TRAINING_GRAPH,
    });
    expect(priv.report(STALL_MS).stalled).toBe(true);
  });

  it("still hard-flags an ordinary render past the floor when class types were captured", () => {
    primeRunning({
      idleForMs: HARD_FLOOR_MS + 60_000,
      serverAliveAgoMs: 500,
      wsFrameAgoMs: null,
      currentNode: "4",
      nodeClassTypes: { "4": "KSampler", "6": "SaveImage" },
    });
    expect(priv.report(STALL_MS).stalled).toBe(true);
  });

  it("still flags a training run when the server has gone DARK (liveness gate is untouched)", () => {
    primeRunning({
      idleForMs: STALL_MS + 60_000,
      serverAliveAgoMs: STALL_MS + 60_000,
      wsFrameAgoMs: STALL_MS + 60_000,
      currentNode: null,
      nodeClassTypes: TRAINING_GRAPH,
    });
    expect(priv.report(STALL_MS).stalled).toBe(true);
  });

  it("applies the floor as before when the /queue graph was never captured", () => {
    // No class types on record (poll never succeeded / pre-fix state) → nothing
    // is exempt; behaviour is exactly the pre-fix backstop.
    primeRunning({
      idleForMs: HARD_FLOOR_MS + 60_000,
      serverAliveAgoMs: 500,
      wsFrameAgoMs: null,
      currentNode: null,
      nodeClassTypes: {},
    });
    expect(priv.report(STALL_MS).stalled).toBe(true);
  });
});
