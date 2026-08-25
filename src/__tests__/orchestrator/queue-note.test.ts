// queue-note.test.ts — the turn-start stall/backlog note (#559).
//
// Drives the shipped composition the injector uses: QueueMonitor.report() →
// formatQueueNote(). The 2026-08-22 recurrence: a long self-queued panel_run
// (prompt in selfQueuedIds) got "two tasks in flight that this session did not
// queue" because queueRemaining was stale-high and the timestamp window had
// aged. That wording + the clear_pending remedy must not fire unless a VISIBLE
// in-flight id is actually foreign.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueueMonitor } from "../../services/queue-monitor.js";
import { formatQueueNote } from "../../orchestrator/queue-note.js";

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

const STALL_MS = 180_000;
const OWN = "a248c804-1111-2222-3333-444444444444";

beforeEach(() => {
  priv.url = "http://127.0.0.1:9999";
  priv.stopped = false;
  priv.selfQueuedIds.clear();
  priv.lastSelfQueueTs = null;
  priv.state.connected = true;
  priv.state.runningPromptId = null;
  priv.state.pendingPromptIds = [];
  priv.state.queueRemaining = 0;
  priv.state.lastActivityTs = Date.now();
  priv.state.lastServerAliveTs = Date.now();
  priv.state.lastFrameTs = Date.now();
});

afterEach(() => {
  priv.selfQueuedIds.clear();
  priv.lastSelfQueueTs = null;
  priv.stopped = true;
  priv.url = null;
});

describe("formatQueueNote ← QueueMonitor.report (#559 recurrence)", () => {
  it("does not claim a self-owned long render is foreign work just because depth is stale", () => {
    QueueMonitor.markSelfQueued(OWN);
    priv.lastSelfQueueTs = Date.now() - 11 * 60 * 1000;
    priv.state.runningPromptId = OWN;
    priv.state.pendingPromptIds = [];
    priv.state.queueRemaining = 2;

    const note = formatQueueNote(QueueMonitor.report(STALL_MS));
    expect(note).toBeNull();
  });

  it("does not claim foreign work when extra depth has no visible foreign id (unproven)", () => {
    // Depth-only, no prompt ids at all — the original #559 "gate on staleness,
    // not count": depth alone is not evidence of a wedge or of foreign work.
    priv.state.runningPromptId = null;
    priv.state.pendingPromptIds = [];
    priv.state.queueRemaining = 2;

    const note = formatQueueNote(QueueMonitor.report(STALL_MS));
    expect(note).toBeNull();
  });

  it("still names foreign work when a VISIBLE in-flight id is not ours", () => {
    QueueMonitor.markSelfQueued(OWN);
    priv.state.runningPromptId = OWN;
    priv.state.pendingPromptIds = ["p-foreign"];
    priv.state.queueRemaining = 2;

    const note = formatQueueNote(QueueMonitor.report(STALL_MS));
    expect(note).toMatch(/didn't queue/);
    expect(note).toMatch(/queue \(action:"list"\)/);
    // clear_pending is a last-resort option, not a "the queue is stuck" headline.
    expect(note).not.toMatch(/You likely queued behind/);
    expect(note).not.toMatch(/\[QUEUE WARNING\]/);
  });

  it("a self-owned batch of several visible ids is silent", () => {
    QueueMonitor.markSelfQueued("p-1");
    QueueMonitor.markSelfQueued("p-2");
    priv.state.runningPromptId = "p-1";
    priv.state.pendingPromptIds = ["p-2"];
    priv.state.queueRemaining = 2;

    expect(formatQueueNote(QueueMonitor.report(STALL_MS))).toBeNull();
  });
});
