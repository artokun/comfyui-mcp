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
// floor of 30 min backstops a genuine in-node deadlock on a reachable server.
import { beforeEach, describe, expect, it } from "vitest";
import { QueueMonitor, type CompletionEvent, type StallReport } from "./queue-monitor.js";

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
}): void {
  const now = Date.now();
  priv.state.runningPromptId = "prompt-1";
  priv.state.currentNode = opts.currentNode ?? "42";
  priv.state.progressValue = 4;
  priv.state.progressMax = 8;
  priv.state.queueRemaining = 1;
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
