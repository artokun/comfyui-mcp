// queue-monitor.poll.test.ts — the HTTP poll that restores run attribution on
// modern ComfyUI (issues #258/#259).
//
// Wire-level fact (verified live on ComfyUI 0.28.0): a passive, non-originating
// WS client receives ONLY `status` frames — execution_start / executing /
// execution_* / progress / progress_state are all sid-scoped to the client that
// queued the prompt. So for foreign runs the watchdog's WS carries no prompt_id
// and no completion signal at all. poll() supplies both over HTTP:
//   • GET /queue → queue_running[0][1] is the running prompt_id (#258);
//   • GET /history tail diff → completions with success/error status, including
//     runs that started AND finished entirely between polls (#259).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueueMonitor, type CompletionEvent } from "./queue-monitor.js";
import { logger } from "../utils/logger.js";

// Reach into the singleton the same way queue-status-broadcast.test.ts does —
// no real WS is opened (start() is never called here).
type Priv = {
  url: string | null;
  stopped: boolean;
  busy: boolean;
  pollInFlight: boolean;
  pollGeneration: number;
  monitorStartTs: number;
  historyPrimed: boolean;
  historySeen: Set<string>;
  completedReported: Set<string>;
  pendingCompletions: CompletionEvent[];
  state: {
    connected: boolean;
    runningPromptId: string | null;
    currentNode: string | null;
    progressValue: number | null;
    progressMax: number | null;
    queueRemaining: number;
    lastActivityTs: number | null;
    lastCompleted: CompletionEvent | null;
  };
  onMessage(text: string): void;
};
const priv = QueueMonitor as unknown as Priv;

/** Route fetches by path fragment; anything unmatched 404s. */
function mockFetch(routes: { queue?: unknown; history?: unknown }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const body = url.includes("/history")
        ? routes.history
        : url.includes("/queue")
          ? routes.queue
          : undefined;
      if (body === undefined) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => body };
    }),
  );
}

const emptyQueue = { queue_running: [], queue_pending: [] };
const historyEntry = (statusStr: string, messages: unknown[][] = []) => ({
  status: { status_str: statusStr, completed: statusStr === "success", messages },
});

beforeEach(() => {
  priv.url = "http://127.0.0.1:9999";
  priv.stopped = false;
  priv.busy = false;
  priv.pollInFlight = false;
  priv.monitorStartTs = Date.now();
  priv.historyPrimed = false;
  priv.historySeen = new Set();
  priv.completedReported = new Set();
  priv.pendingCompletions.length = 0;
  priv.state.runningPromptId = null;
  priv.state.currentNode = null;
  priv.state.progressValue = null;
  priv.state.progressMax = null;
  priv.state.queueRemaining = 0;
  priv.state.lastActivityTs = null;
  priv.state.lastCompleted = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  priv.stopped = true;
  priv.url = null;
});

describe("poll() /queue attribution (#258)", () => {
  it("adopts the running prompt_id and true depth from GET /queue", async () => {
    mockFetch({
      queue: {
        queue_running: [[5, "p-foreign", { "1": {} }, {}, ["7"]]],
        queue_pending: [[6, "p-next", {}, {}, []]],
      },
      history: {},
    });
    await QueueMonitor.poll();
    const snap = QueueMonitor.snapshot();
    expect(snap.running).toBe(true);
    expect(snap.runningPromptId).toBe("p-foreign");
    expect(snap.queueDepth).toBe(2);
  });

  it("clears the adopted run once GET /queue reports empty", async () => {
    mockFetch({ queue: { queue_running: [[5, "p-foreign", {}, {}, []]], queue_pending: [] }, history: {} });
    await QueueMonitor.poll();
    expect(QueueMonitor.snapshot().running).toBe(true);

    mockFetch({ queue: emptyQueue, history: {} });
    await QueueMonitor.poll();
    const snap = QueueMonitor.snapshot();
    expect(snap.running).toBe(false);
    expect(snap.runningPromptId).toBeNull();
    expect(snap.queueDepth).toBe(0);
  });

  it("survives a fetch failure without touching state", async () => {
    priv.state.runningPromptId = "p-keep";
    priv.state.queueRemaining = 1;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    await QueueMonitor.poll(); // must not reject
    expect(QueueMonitor.snapshot().runningPromptId).toBe("p-keep");
  });
});

describe("poll() /history tail diff (#259)", () => {
  it("primes on the first look, then reports a sub-tick run that never showed in /queue", async () => {
    // Tick 1: idle, one pre-existing history entry — primes, emits nothing.
    mockFetch({ queue: emptyQueue, history: { "h-old": historyEntry("success") } });
    await QueueMonitor.poll();
    expect(QueueMonitor.drainCompletions()).toEqual([]);
    expect(QueueMonitor.snapshot().lastCompleted).toBeNull();

    // Tick 2: still idle on /queue (the run started AND failed between ticks),
    // but the history tail gained an errored entry.
    mockFetch({
      queue: emptyQueue,
      history: { "h-old": historyEntry("success"), "h-flash": historyEntry("error") },
    });
    await QueueMonitor.poll();
    const events = QueueMonitor.drainCompletions();
    expect(events).toHaveLength(1);
    expect(events[0].promptId).toBe("h-flash");
    expect(events[0].status).toBe("error");
    expect(QueueMonitor.snapshot().lastCompleted?.promptId).toBe("h-flash");

    // Tick 3: same tail — nothing new, no replay.
    await QueueMonitor.poll();
    expect(QueueMonitor.drainCompletions()).toEqual([]);
  });

  it("maps an interrupted run distinctly", async () => {
    mockFetch({ queue: emptyQueue, history: {} });
    await QueueMonitor.poll(); // prime
    mockFetch({
      queue: emptyQueue,
      history: { "h-int": historyEntry("error", [["execution_interrupted", { prompt_id: "h-int" }]]) },
    });
    await QueueMonitor.poll();
    expect(QueueMonitor.drainCompletions()[0]?.status).toBe("interrupted");
  });

  it("completing the tracked running prompt also clears the run state", async () => {
    mockFetch({ queue: { queue_running: [[1, "p-run", {}, {}, []]], queue_pending: [] }, history: {} });
    await QueueMonitor.poll();
    expect(QueueMonitor.snapshot().running).toBe(true);

    mockFetch({ queue: emptyQueue, history: { "p-run": historyEntry("success") } });
    await QueueMonitor.poll();
    const snap = QueueMonitor.snapshot();
    expect(snap.running).toBe(false);
    expect(snap.lastCompleted?.promptId).toBe("p-run");
    expect(QueueMonitor.drainCompletions().map((e) => e.promptId)).toEqual(["p-run"]);
  });

  it("dedupes a completion seen by BOTH the WS event and the history diff", async () => {
    mockFetch({ queue: emptyQueue, history: {} });
    await QueueMonitor.poll(); // prime
    // Own run: on older ComfyUI (or the originating client) the WS event lands first…
    priv.onMessage(JSON.stringify({ type: "execution_success", data: { prompt_id: "p-own" } }));
    expect(QueueMonitor.drainCompletions().map((e) => e.promptId)).toEqual(["p-own"]);
    // …then the next poll sees the same finish in history. Must not re-emit.
    mockFetch({ queue: emptyQueue, history: { "p-own": historyEntry("success") } });
    await QueueMonitor.poll();
    expect(QueueMonitor.drainCompletions()).toEqual([]);
  });
});

describe("poll() hardening (codex review of PR #261)", () => {
  it("issues the /queue and /history fetches in PARALLEL (worst case one timeout, not two)", async () => {
    const resolvers: Array<() => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (input: unknown) =>
          new Promise((res) => {
            const body = String(input).includes("/history") ? {} : emptyQueue;
            resolvers.push(() => res({ ok: true, json: async () => body }));
          }),
      ),
    );
    const done = QueueMonitor.poll();
    await Promise.resolve(); // let poll() issue its requests
    // BOTH requests must be in flight before either has resolved — a serial
    // implementation would only have issued /queue at this point.
    expect(resolvers).toHaveLength(2);
    for (const r of resolvers) r();
    await done;
  });

  it("fetches a 32-entry tail and warns (does not silently claim coverage) when a diff saturates it", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      mockFetch({ queue: emptyQueue, history: {} });
      await QueueMonitor.poll(); // prime
      const urls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("max_items=32"))).toBe(true);

      // 32 brand-new entries — the whole window is unseen: possible gap.
      const burst = Object.fromEntries(
        Array.from({ length: 32 }, (_, i) => [
          `h-${i}`,
          { ...historyEntry("success"), prompt: [i + 1, `h-${i}`, {}, {}, []] },
        ]),
      );
      mockFetch({ queue: emptyQueue, history: burst });
      await QueueMonitor.poll();
      expect(QueueMonitor.drainCompletions()).toHaveLength(32);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("saturated"));
    } finally {
      warn.mockRestore();
    }
  });

  it("priming does NOT swallow a run that finished during startup (timestamp cutoff)", async () => {
    priv.monitorStartTs = 1000;
    mockFetch({
      queue: emptyQueue,
      history: {
        "h-old": {
          ...historyEntry("success", [["execution_success", { prompt_id: "h-old", timestamp: 500 }]]),
          prompt: [1, "h-old", {}, {}, []],
        },
        "h-during": {
          ...historyEntry("error", [["execution_error", { prompt_id: "h-during", timestamp: 2000 }]]),
          prompt: [2, "h-during", {}, {}, []],
        },
      },
    });
    await QueueMonitor.poll(); // FIRST look — primes, but must keep h-during
    const events = QueueMonitor.drainCompletions();
    expect(events.map((e) => e.promptId)).toEqual(["h-during"]);
    expect(events[0].status).toBe("error");
    // …and h-during is not double-reported on the next diff.
    await QueueMonitor.poll();
    expect(QueueMonitor.drainCompletions()).toEqual([]);
  });

  it("abandons an in-flight poll's responses when the generation changes (retarget race)", async () => {
    const resolvers: Array<() => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (input: unknown) =>
          new Promise((res) => {
            const body = String(input).includes("/history")
              ? { "h-stale": historyEntry("success") }
              : { queue_running: [[9, "p-stale", {}, {}, []]], queue_pending: [] };
            resolvers.push(() => res({ ok: true, json: async () => body }));
          }),
      ),
    );
    priv.historyPrimed = true; // pretend a diff baseline exists so h-stale WOULD report
    const done = QueueMonitor.poll();
    await Promise.resolve();
    priv.pollGeneration++; // what stop()/start(newUrl) does mid-flight
    for (const r of resolvers) r();
    await done;
    // The old target's responses must not have touched anything.
    const snap = QueueMonitor.snapshot();
    expect(snap.running).toBe(false);
    expect(snap.runningPromptId).toBeNull();
    expect(QueueMonitor.drainCompletions()).toEqual([]);
  });

  it("start() resets completion state so nothing leaks across a retarget", () => {
    priv.state.lastCompleted = { promptId: "p-old", status: "success", at: 1 };
    priv.pendingCompletions.push({ promptId: "p-old", status: "success", at: 1 });
    priv.completedReported.add("p-old");
    priv.historyPrimed = true;
    const gen = priv.pollGeneration;
    QueueMonitor.start("http://127.0.0.1:9997"); // different URL → full retarget path
    try {
      expect(priv.pollGeneration).toBeGreaterThan(gen);
      expect(QueueMonitor.snapshot().lastCompleted).toBeNull();
      expect(priv.pendingCompletions).toHaveLength(0);
      expect(priv.completedReported.size).toBe(0);
      expect(priv.historyPrimed).toBe(false);
    } finally {
      QueueMonitor.stop();
    }
  });

  it("replays a burst in ComfyUI queue-number order (prompt[0]), not /history object order", async () => {
    mockFetch({ queue: emptyQueue, history: {} });
    await QueueMonitor.poll(); // prime
    // Object order deliberately scrambled vs. the queue counter.
    mockFetch({
      queue: emptyQueue,
      history: {
        "h-b": { ...historyEntry("success"), prompt: [7, "h-b", {}, {}, []] },
        "h-a": { ...historyEntry("error"), prompt: [5, "h-a", {}, {}, []] },
        "h-c": { ...historyEntry("success"), prompt: [6, "h-c", {}, {}, []] },
      },
    });
    await QueueMonitor.poll();
    const events = QueueMonitor.drainCompletions();
    expect(events.map((e) => e.promptId)).toEqual(["h-a", "h-c", "h-b"]);
    // lastCompleted is the genuinely newest run, not the last object key.
    expect(QueueMonitor.snapshot().lastCompleted?.promptId).toBe("h-b");
  });
});
