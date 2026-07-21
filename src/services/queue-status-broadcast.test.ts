// queue-status-broadcast.test.ts — the live `queue_status` bridge frame and its
// change-only throttle (the mobile app's live queue monitor rides on this).
// Contract under test:
//   • buildQueueStatusFrame maps a QueueMonitor snapshot 1:1 onto the wire shape;
//   • tick() pushes ONLY when the frame differs from the last one pushed — an
//     idle rig broadcasts nothing, a running render costs ≤ 1 frame per tick;
//   • current() always returns the live frame (the on-hello seed for a tab that
//     connects mid-render).
import { describe, expect, it } from "vitest";
import type { QueueSnapshot } from "./queue-monitor.js";
import {
  buildQueueStatusFrame,
  createQueueStatusBroadcaster,
  type QueueStatusFrame,
} from "./queue-status-broadcast.js";

const idle = (): QueueSnapshot => ({
  connected: true,
  running: false,
  runningPromptId: null,
  queueDepth: 0,
  currentNode: null,
  progressValue: null,
  progressMax: null,
  lastCompleted: null,
});

const running = (progress: number): QueueSnapshot => ({
  connected: true,
  running: true,
  runningPromptId: "p-123",
  queueDepth: 2,
  currentNode: "3",
  progressValue: progress,
  progressMax: 20,
  lastCompleted: null,
});

describe("buildQueueStatusFrame", () => {
  it("maps a running snapshot onto the wire shape", () => {
    expect(buildQueueStatusFrame(running(7))).toEqual({
      type: "queue_status",
      connected: true,
      running: true,
      queue_depth: 2,
      prompt_id: "p-123",
      node: "3",
      progress_value: 7,
      progress_max: 20,
      last_completed_prompt_id: null,
      last_completed_status: null,
      last_completed_at: null,
    });
  });

  it("carries the snapshot's lastCompleted onto the additive wire fields", () => {
    const snap = { ...idle(), lastCompleted: { promptId: "p-done", status: "error" as const, at: 1234 } };
    const f = buildQueueStatusFrame(snap);
    expect(f.last_completed_prompt_id).toBe("p-done");
    expect(f.last_completed_status).toBe("error");
    expect(f.last_completed_at).toBe(1234);
  });

  it("maps an idle snapshot with nulls, not zeros", () => {
    const f = buildQueueStatusFrame(idle());
    expect(f.running).toBe(false);
    expect(f.queue_depth).toBe(0);
    expect(f.prompt_id).toBeNull();
    expect(f.node).toBeNull();
    expect(f.progress_value).toBeNull();
    expect(f.progress_max).toBeNull();
  });
});

describe("createQueueStatusBroadcaster", () => {
  it("pushes the first frame, then stays silent while nothing changes", () => {
    let snap = idle();
    const pushed: QueueStatusFrame[] = [];
    const b = createQueueStatusBroadcaster(
      () => snap,
      (f) => pushed.push(f),
    );

    b.tick();
    expect(pushed).toHaveLength(1); // first observation always goes out

    b.tick();
    b.tick();
    b.tick();
    expect(pushed).toHaveLength(1); // idle rig: zero further frames

    snap = running(0);
    b.tick();
    expect(pushed).toHaveLength(2);
    expect(pushed[1].running).toBe(true);
    expect(pushed[1].prompt_id).toBe("p-123");
  });

  it("pushes once per progress change, not per tick", () => {
    let snap = running(5);
    const pushed: QueueStatusFrame[] = [];
    const b = createQueueStatusBroadcaster(
      () => snap,
      (f) => pushed.push(f),
    );

    b.tick(); // 5/20
    b.tick(); // unchanged (a wedged step re-emits the same value)
    expect(pushed).toHaveLength(1);

    snap = running(6);
    b.tick();
    snap = running(7);
    b.tick();
    b.tick(); // unchanged again
    expect(pushed).toHaveLength(3);
    expect(pushed.map((f) => f.progress_value)).toEqual([5, 6, 7]);
  });

  it("pushes the running→idle transition (the render-finished edge)", () => {
    let snap = running(19);
    const pushed: QueueStatusFrame[] = [];
    const b = createQueueStatusBroadcaster(
      () => snap,
      (f) => pushed.push(f),
    );
    b.tick();
    snap = idle();
    b.tick();
    expect(pushed).toHaveLength(2);
    expect(pushed[1].running).toBe(false);
    expect(pushed[1].queue_depth).toBe(0);
  });

  it("current() returns the live frame without affecting the throttle", () => {
    let snap = idle();
    const pushed: QueueStatusFrame[] = [];
    const b = createQueueStatusBroadcaster(
      () => snap,
      (f) => pushed.push(f),
    );

    expect(b.current().running).toBe(false);
    snap = running(1);
    expect(b.current().running).toBe(true); // live, not cached
    expect(pushed).toHaveLength(0); // current() never pushes

    b.tick();
    expect(pushed).toHaveLength(1); // and never consumed the change either
  });

  // Issue #259: a run that starts AND finishes entirely between ticks leaves
  // the state idle→idle — only the drained completion can reach subscribers.
  it("replays drained completions as frames even when the state never changed", () => {
    const done = { promptId: "p-flash", status: "error" as const, at: 5000 };
    let snap = idle();
    let queue: (typeof done)[] = [];
    const pushed: QueueStatusFrame[] = [];
    const b = createQueueStatusBroadcaster(
      () => snap,
      (f) => pushed.push(f),
      () => queue.splice(0),
    );

    b.tick(); // idle baseline
    expect(pushed).toHaveLength(1);

    // A sub-tick run fails: state is already idle again, but the monitor
    // recorded the completion (snapshot.lastCompleted + drained event).
    snap = { ...idle(), lastCompleted: done };
    queue = [done];
    b.tick();
    expect(pushed).toHaveLength(2);
    expect(pushed[1].running).toBe(false);
    expect(pushed[1].last_completed_prompt_id).toBe("p-flash");
    expect(pushed[1].last_completed_status).toBe("error");

    b.tick(); // nothing new — the sticky lastCompleted must not re-push
    expect(pushed).toHaveLength(2);
  });

  it("replays a BURST of completions as distinct frames, newest deduping into the state frame", () => {
    const a = { promptId: "p-a", status: "error" as const, at: 1 };
    const bEv = { promptId: "p-b", status: "success" as const, at: 2 };
    const snap = { ...idle(), lastCompleted: bEv };
    const pushed: QueueStatusFrame[] = [];
    let queue = [a, bEv];
    const b = createQueueStatusBroadcaster(
      () => snap,
      (f) => pushed.push(f),
      () => queue.splice(0),
    );
    b.tick();
    // Two frames: one per completion; the trailing state frame equals the
    // p-b frame and dedupes away.
    expect(pushed).toHaveLength(2);
    expect(pushed.map((f) => f.last_completed_prompt_id)).toEqual(["p-a", "p-b"]);
    b.tick();
    expect(pushed).toHaveLength(2);
  });
});

describe("QueueMonitor snapshot plumbing", () => {
  // Drive the real singleton's (private) WS message handler with captured
  // ComfyUI frames, and assert the NEW snapshot fields carry node + progress —
  // the exact plumbing queue_status broadcasts to the phone.
  it("exposes currentNode + progress from live ComfyUI frames", async () => {
    const { QueueMonitor } = await import("./queue-monitor.js");
    const onMessage = (
      QueueMonitor as unknown as { onMessage(text: string): void }
    ).onMessage.bind(QueueMonitor);

    onMessage(JSON.stringify({ type: "execution_start", data: { prompt_id: "p-9" } }));
    onMessage(JSON.stringify({ type: "executing", data: { node: "3", prompt_id: "p-9" } }));
    onMessage(JSON.stringify({ type: "progress", data: { value: 4, max: 20, node: "3" } }));

    let snap = QueueMonitor.snapshot();
    expect(snap.running).toBe(true);
    expect(snap.runningPromptId).toBe("p-9");
    expect(snap.currentNode).toBe("3");
    expect(snap.progressValue).toBe(4);
    expect(snap.progressMax).toBe(20);

    // Success clears everything back to idle (leave the singleton clean).
    onMessage(JSON.stringify({ type: "execution_success", data: { prompt_id: "p-9" } }));
    snap = QueueMonitor.snapshot();
    expect(snap.running).toBe(false);
    expect(snap.currentNode).toBeNull();
    expect(snap.progressValue).toBeNull();
  });

  // Modern ComfyUI (verified live on 0.28) sends execution_start / executing /
  // execution_success ONLY to the client that queued the prompt. A passive
  // watchdog sees just the broadcast frames: status / progress / progress_state.
  // The run state must be derivable from those alone.
  it("derives running state from broadcast-only frames (modern ComfyUI)", async () => {
    const { QueueMonitor } = await import("./queue-monitor.js");
    const onMessage = (
      QueueMonitor as unknown as { onMessage(text: string): void }
    ).onMessage.bind(QueueMonitor);

    // Frames captured verbatim from a live ComfyUI 0.28 as a NON-originating
    // client (trimmed): status → progress_state → progress → status(0).
    onMessage(
      JSON.stringify({
        type: "status",
        data: { status: { exec_info: { queue_remaining: 1 } } },
      }),
    );
    onMessage(
      JSON.stringify({
        type: "progress_state",
        data: {
          prompt_id: "612c9766",
          nodes: { "4": { value: 0, max: 1, state: "running", node_id: "4", prompt_id: "612c9766" } },
        },
      }),
    );
    let snap = QueueMonitor.snapshot();
    expect(snap.running).toBe(true);
    expect(snap.runningPromptId).toBe("612c9766");
    expect(snap.currentNode).toBe("4");

    onMessage(
      JSON.stringify({
        type: "progress",
        data: { value: 5, max: 12, prompt_id: "612c9766", node: "5" },
      }),
    );
    snap = QueueMonitor.snapshot();
    expect(snap.currentNode).toBe("5");
    expect(snap.progressValue).toBe(5);
    expect(snap.progressMax).toBe(12);

    // The drained status frame is the only "done" signal a passive client gets.
    onMessage(
      JSON.stringify({
        type: "status",
        data: { status: { exec_info: { queue_remaining: 0 } } },
      }),
    );
    snap = QueueMonitor.snapshot();
    expect(snap.running).toBe(false);
    expect(snap.runningPromptId).toBeNull();
    expect(snap.queueDepth).toBe(0);
  });
});
