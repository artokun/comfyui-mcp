// queue-monitor.self-attribution.test.ts — the backlog warning must tell the
// agent's OWN deliberate batch from a foreign or stuck job (#559).
//
// BUG: panel_run's "[QUEUE WARNING] … cancel with clear_pending:true" fired on ANY
// running job — so batching 11 renders (the normal way to run a comparison) made
// every run after the first warn about a "backlog" it created, and recommended the
// single most destructive action (kill the running render AND drop the queue).
//
// FIX: the orchestrator records the prompt ids it queued (markSelfQueued). A queue
// made of our own recent jobs is `selfAttributed` and is reported neutrally; only a
// job we did NOT queue drives the warning. Here we drive the singleton's state and
// assert snapshot()/report() attribution.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueueMonitor } from "../../services/queue-monitor.js";

type Priv = {
  url: string | null;
  stopped: boolean;
  selfQueuedIds: Set<string>;
  lastSelfQueueTs: number | null;
  state: {
    connected: boolean;
    runningPromptId: string | null;
    pendingPromptIds: string[];
    queueRemaining: number;
    lastActivityTs: number | null;
    lastServerAliveTs: number | null;
    lastFrameTs: number | null;
  };
};
const priv = QueueMonitor as unknown as Priv;

beforeEach(() => {
  priv.url = "http://127.0.0.1:9999";
  priv.stopped = false;
  priv.selfQueuedIds.clear();
  priv.lastSelfQueueTs = null;
  priv.state.connected = true;
  priv.state.runningPromptId = null;
  priv.state.pendingPromptIds = [];
  priv.state.queueRemaining = 0;
  priv.state.lastActivityTs = null;
  // Keep the server "alive" so report() never flags a stall on its own.
  priv.state.lastServerAliveTs = Date.now();
  priv.state.lastFrameTs = Date.now();
});

afterEach(() => {
  priv.selfQueuedIds.clear();
  priv.lastSelfQueueTs = null;
  priv.stopped = true;
  priv.url = null;
});

const STALL_MS = 180_000;

describe("self-attribution of the in-flight queue (#559)", () => {
  it("a batch of OUR prompts (running + pending, all matched by id) is self-attributed", () => {
    QueueMonitor.markSelfQueued("p-mine-1");
    QueueMonitor.markSelfQueued("p-mine-2");
    QueueMonitor.markSelfQueued("p-mine-3");
    priv.state.runningPromptId = "p-mine-1";
    priv.state.pendingPromptIds = ["p-mine-2", "p-mine-3"];
    priv.state.queueRemaining = 3;

    expect(QueueMonitor.snapshot().selfAttributed).toBe(true);
    const rep = QueueMonitor.report(STALL_MS);
    expect(rep.selfAttributed).toBe(true);
    expect(rep.backlog).toBe(true); // depth > 1 — but it's OUR batch, so callers suppress the warning
    expect(rep.stalled).toBe(false);
  });

  it("a recent self-queue with NO recorded id attributes the in-flight work to us (timestamp fallback)", () => {
    // The panel reply carried no prompt_id — markSelfQueued(null) only marks the time.
    QueueMonitor.markSelfQueued(null);
    priv.state.runningPromptId = "p-unknown"; // id we never recorded
    priv.state.queueRemaining = 1;

    expect(QueueMonitor.snapshot().selfAttributed).toBe(true);
    expect(QueueMonitor.report(STALL_MS).selfAttributed).toBe(true);
  });

  it("a foreign running job (no self-queue at all) is NOT self-attributed → backlog warning stands", () => {
    priv.state.runningPromptId = "p-foreign";
    priv.state.queueRemaining = 2;

    expect(QueueMonitor.snapshot().selfAttributed).toBe(false);
    const rep = QueueMonitor.report(STALL_MS);
    expect(rep.selfAttributed).toBe(false);
    expect(rep.backlog).toBe(true);
  });

  it("P1-a: a foreign RUNNING id is NOT masked by a recent self-queue (explicit id mismatch)", () => {
    // We queued p-mine recently, but the job actually running is one we can SEE is
    // not ours. The time window must NOT override that.
    QueueMonitor.markSelfQueued("p-mine"); // recent, and gives us an id set
    priv.state.runningPromptId = "p-foreign"; // running job we did NOT queue
    priv.state.pendingPromptIds = [];
    priv.state.queueRemaining = 1;

    expect(QueueMonitor.snapshot().selfAttributed).toBe(false);
  });

  it("P1-b: our own running job does NOT cover a FOREIGN pending job", () => {
    QueueMonitor.markSelfQueued("p-mine");
    priv.state.runningPromptId = "p-mine"; // ours, running
    priv.state.pendingPromptIds = ["p-foreign"]; // someone else's job queued behind us
    priv.state.queueRemaining = 2;

    // Not the whole queue is ours → the agent should still be told.
    expect(QueueMonitor.snapshot().selfAttributed).toBe(false);
  });

  it("rapid own batch: queueRemaining outruns the poll's captured pending ids → still ours (recent self-queue)", () => {
    // The reported scenario: queuing a batch faster than the 1 Hz poll. Status
    // frames bumped queueRemaining to 3, but the poll has only captured the running
    // id so far. We queued them all seconds ago → still our batch.
    QueueMonitor.markSelfQueued("p-mine");
    priv.state.runningPromptId = "p-mine";
    priv.state.pendingPromptIds = []; // poll hasn't captured the 2 pending yet
    priv.state.queueRemaining = 3;

    expect(QueueMonitor.snapshot().selfAttributed).toBe(true);
  });

  it("stale extra depth with every VISIBLE id ours is still ours, even after the window (#559 recurrence)", () => {
    // Reporter: a long self-queued render was in selfQueuedIds; queueRemaining=2
    // from a status frame while /queue showed that one prompt running and nothing
    // pending. Once lastSelfQueueTs aged past the window, the old incomplete-
    // accounting path classified it as non-self and the turn note claimed this
    // session did not queue the work. Extra depth without a visible foreign id
    // is stale accounting, not a foreign job.
    const id = "a248c804-1111-2222-3333-444444444444";
    QueueMonitor.markSelfQueued(id);
    priv.lastSelfQueueTs = Date.now() - 11 * 60 * 1000;
    priv.state.runningPromptId = id;
    priv.state.pendingPromptIds = [];
    priv.state.queueRemaining = 2;

    expect(QueueMonitor.snapshot().selfAttributed).toBe(true);
    const rep = QueueMonitor.report(STALL_MS);
    expect(rep.selfAttributed).toBe(true);
    expect(rep.foreignVisible).toBe(false);
    // The duplicate fence stays strict: extra depth is still not PROVEN.
    expect(QueueMonitor.snapshot().selfAttributedProven).toBe(false);
  });

  it("attribution expires after the window (a stale self-queue no longer covers a new foreign job)", () => {
    QueueMonitor.markSelfQueued("p-old");
    // Age our last self-queue past the 10-minute window and drop the id.
    priv.lastSelfQueueTs = Date.now() - 11 * 60 * 1000;
    priv.selfQueuedIds.clear();
    priv.state.runningPromptId = "p-foreign-new";
    priv.state.queueRemaining = 2;

    expect(QueueMonitor.snapshot().selfAttributed).toBe(false);
  });

  it("markSelfQueued bounds its id set (no unbounded growth)", () => {
    for (let i = 0; i < 250; i++) QueueMonitor.markSelfQueued(`p-${i}`);
    expect(priv.selfQueuedIds.size).toBeLessThanOrEqual(200);
    // The most recent ids survive; the oldest are evicted FIFO.
    expect(priv.selfQueuedIds.has("p-249")).toBe(true);
    expect(priv.selfQueuedIds.has("p-0")).toBe(false);
  });
});
