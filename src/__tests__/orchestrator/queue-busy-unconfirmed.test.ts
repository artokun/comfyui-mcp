// #2684 — a believed running prompt that the monitored ComfyUI has stopped
// confirming must not keep being reported as present-tense fact.
//
// The reported session is the shape under test. A render wedged inside
// SamplerCustomAdvanced for ~1461 s; the orchestrator's own turn note said the
// server had gone dark ("appears STALLED", which fires off the LAPSE of the
// liveness heartbeat), while the queue-busy notes simultaneously asserted a
// specific prompt "is still running" — and a headless `queue` read showed
// `running: 0, pending: 0` at the same moment. Two statements reached the agent,
// one derived from the other's negation.
//
// The mechanism is not a race. `QueueMonitor` clears a run on exactly two paths
// (a ws `status` frame with queue_remaining === 0, or a `/queue` poll seeing an
// empty queue_running) and BOTH require the monitored server to answer. When it
// stops answering, `fetchJson` returns null, `applyQueue` returns before the
// clear can run, and `runningPromptId` persists with no upper bound and no
// expiry. Keeping last-known state across a blip is deliberate and right; having
// no point at which it becomes "unverified" rather than "true" is the defect.
//
// These tests drive the SHIPPED tool path — handler → fence/timeout → note — not
// the note helpers directly, because the load-bearing claim is what an agent
// actually receives from a tool call.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { QueueMonitor, RUNNING_UNCONFIRMED_MS } from "../../services/queue-monitor.js";
import { markReplyTimeout } from "../../services/ui-bridge.js";
import { formatQueueNote } from "../../orchestrator/queue-note.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "11111111-2222-4333-8444-555555555555";
const STALL_MS = 180_000;

type QMPriv = {
  url: string | null;
  stopped: boolean;
  selfQueuedIds: Set<string>;
  lastSelfQueueTs: number | null;
  state: {
    connected: boolean;
    runningPromptId: string | null;
    pendingPromptIds: string[];
    currentNode: string | null;
    queueRemaining: number;
    lastActivityTs: number | null;
    lastServerAliveTs: number | null;
    lastFrameTs: number | null;
  };
};
const qm = QueueMonitor as unknown as QMPriv;

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} not found`);
  return def;
}

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

function makeBridge(opts?: { timeoutCmds?: Set<string> }) {
  const sent: string[] = [];
  const timeoutCmds = opts?.timeoutCmds ?? new Set<string>();
  const bridge = {
    send: async (cmd: Record<string, unknown>, o?: { onDispatchedRid?: (rid: string) => void }) => {
      sent.push(String(cmd.cmd));
      o?.onDispatchedRid?.("rid-timeout-1");
      if (timeoutCmds.has(String(cmd.cmd))) {
        throw markReplyTimeout(
          new Error(
            `Panel tab ${TAB} did not reply to "${cmd.cmd}" within 20000 ms — the ComfyUI tab ` +
              `may be backgrounded or frozen`,
          ),
        );
      }
      return { ok: true, ids: [1], node_count: 1 };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: () => true,
    workflowUuidFor: () => ({ known: true, uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  return { bridge, sent };
}

/** A run believed in flight. `silentForMs` back-dates BOTH liveness heartbeats
 *  — the only thing the monitor has that can date its own belief. */
function startRender(silentForMs: number, promptId = "383f84bb-dead-4beef-8000-000000000001"): void {
  const now = Date.now();
  qm.state.runningPromptId = promptId;
  qm.state.currentNode = "12";
  qm.state.queueRemaining = 1;
  // Forward progress stopped when the server did — the reporter's ~1461 s wedge.
  qm.state.lastActivityTs = now - silentForMs;
  qm.state.lastServerAliveTs = now - silentForMs;
  qm.state.lastFrameTs = now - silentForMs;
}

beforeEach(() => {
  qm.url = "http://127.0.0.1:9999";
  qm.stopped = false;
  qm.selfQueuedIds.clear();
  qm.lastSelfQueueTs = null;
  qm.state.connected = true;
  qm.state.runningPromptId = null;
  qm.state.pendingPromptIds = [];
  qm.state.currentNode = null;
  qm.state.queueRemaining = 0;
  qm.state.lastActivityTs = null;
  qm.state.lastServerAliveTs = Date.now();
  qm.state.lastFrameTs = Date.now();
});

afterEach(() => {
  qm.selfQueuedIds.clear();
  qm.lastSelfQueueTs = null;
  qm.state.runningPromptId = null;
  qm.state.currentNode = null;
  qm.state.queueRemaining = 0;
  qm.state.lastActivityTs = null;
  qm.stopped = true;
  qm.url = null;
});

describe("#2684: an ack timeout stops blaming a run the server never confirmed", () => {
  it("does not assert the prompt is still running once the server has gone dark", async () => {
    startRender(1461_000);

    const { bridge, sent } = makeBridge({ timeoutCmds: new Set(["graph_outline"]) });
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const text = textOf(await defByName("panel_graph_outline").handler({} as never, ctx));

    expect(sent).toContain("graph_outline");
    // The exact sentence the reporter was handed. It is a present-tense claim
    // about a server that had not answered for ~1461 s.
    expect(text).not.toMatch(/a ComfyUI prompt is still running/);
    expect(text).toMatch(/UNCONFIRMED/);
    // It must still say WHICH run it last knew about — downgrading the tense
    // must not cost the agent the prompt id it needs to go check.
    expect(text).toMatch(/383f84bb-dead-4beef-8000-000000000001/);
    // And it must date the belief rather than leaving it undated.
    expect(text).toMatch(/has not answered this orchestrator for ~14\d\ds/);
  });

  it("stops offering the stale run as the CAUSE of the tab's silence", async () => {
    startRender(1461_000);

    const { bridge } = makeBridge({ timeoutCmds: new Set(["graph_outline"]) });
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const text = textOf(await defByName("panel_graph_outline").handler({} as never, ctx));

    // "which is the most likely reason the tab did not answer in time" is the
    // misexplanation: the same lapsed heartbeat that makes the run unconfirmed
    // is itself the likelier story.
    expect(text).not.toMatch(/most likely reason/);
    // "Retry after queue (action:"list") shows running: 0" was advice against a
    // queue that was ALREADY idle — the reporter had just read running: 0.
    expect(text).not.toMatch(/if it still does not answer once the queue is idle/i);
    expect(text).toMatch(/Settle it with queue \(action:"list"\)/);
  });

  it("a live server keeps the original present-tense diagnosis", async () => {
    startRender(0);

    const { bridge } = makeBridge({ timeoutCmds: new Set(["graph_outline"]) });
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const text = textOf(await defByName("panel_graph_outline").handler({} as never, ctx));

    // #1639's diagnosis is correct when the monitor can still see the server —
    // a render really can occupy the panel's main thread. Nothing about that case
    // changes here.
    expect(text).toMatch(/QUEUE BUSY: a ComfyUI prompt is still running/);
    expect(text).toMatch(/most likely reason/);
    expect(text).not.toMatch(/UNCONFIRMED/);
  });

  it("tolerates a transient blip: one lapsed poll does not downgrade the run", async () => {
    // Deliberately right, and stated as a property so it cannot be tuned away:
    // a single timed-out poll is not evidence a render finished. The downgrade
    // only fires past the threshold.
    //
    // The blip is a FIXED 5 s, not `RUNNING_UNCONFIRMED_MS - 5_000`. Deriving the
    // setup from the constant under test makes it move with any mutation of that
    // constant, so the assertion below stays green no matter what the threshold
    // becomes — a control that shares the mutation's dependency is not a control.
    // Setting the threshold to 0 must fail this test, so pin the premise first.
    expect(RUNNING_UNCONFIRMED_MS).toBeGreaterThan(5_000);
    startRender(5_000);

    const { bridge } = makeBridge({ timeoutCmds: new Set(["graph_outline"]) });
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const text = textOf(await defByName("panel_graph_outline").handler({} as never, ctx));

    expect(text).toMatch(/a ComfyUI prompt is still running/);
    expect(text).not.toMatch(/UNCONFIRMED/);
  });
});

describe("#2684: the mutation fence still fences — only its wording changes", () => {
  it("a graph edit is STILL refused unsent on an unconfirmed run", async () => {
    startRender(1461_000);

    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_set_widget").handler(
      { node_id: 3, widget: "text", value: "a cat" } as never,
      ctx,
    );
    const text = textOf(res);

    // Fail-closed is CORRECT here and must not be loosened: an unverified run is
    // not a verified idle, and a delivered mutation cannot be retracted. The bug
    // was never that the fence fenced — it was what the refusal claimed.
    expect(sent).toEqual([]);
    expect(res.isError).toBe(true);
    expect(text).toMatch(/QUEUE BUSY/);
    expect(text).toMatch(/panel_set_widget was NOT sent — nothing was applied/);
    // ...but it no longer states the run as fact.
    expect(text).not.toMatch(/QUEUE BUSY: a ComfyUI prompt is running/);
    expect(text).toMatch(/was last seen running/);
    expect(text).toMatch(/UNCONFIRMED/);
  });

  it("an idle queue still dispatches the mutation", async () => {
    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_set_widget").handler(
      { node_id: 3, widget: "text", value: "a cat" } as never,
      ctx,
    );

    expect(sent).toContain("graph_set_widget");
    expect(res.isError).not.toBe(true);
  });
});

describe("#2684: the STALLED notice and the busy note can no longer contradict", () => {
  it("when the turn note says the server went dark, the busy note agrees", async () => {
    startRender(1461_000);

    // Both statements the reporter received in one session, produced from the
    // same monitor state. formatQueueNote fires off `serverAlive` — i.e. the
    // server has NOT answered recently.
    const stallNote = formatQueueNote(QueueMonitor.report(STALL_MS));
    expect(stallNote).toMatch(/appears STALLED/);

    const { bridge } = makeBridge({ timeoutCmds: new Set(["graph_outline"]) });
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const busy = textOf(await defByName("panel_graph_outline").handler({} as never, ctx));

    // The contradiction: one message derived from "the server has not answered",
    // the other asserting a specific prompt is present-tense running.
    expect(busy).not.toMatch(/is still running/);
    expect(busy).toMatch(/UNCONFIRMED/);
  });

  it("the two notes read one heartbeat, so they cannot drift apart", () => {
    startRender(1461_000);
    const contact = QueueMonitor.snapshot().lastServerContactTs;
    expect(contact).not.toBeNull();

    // `report()`'s serverAlive and the snapshot's lastServerContactTs are the
    // same reduction of the same two fields. Moving the heartbeat forward must
    // move BOTH: a fresh contact un-stalls the report and re-confirms the run.
    expect(QueueMonitor.report(STALL_MS).stalled).toBe(true);
    qm.state.lastServerAliveTs = Date.now();
    expect(QueueMonitor.snapshot().lastServerContactTs).toBeGreaterThan(contact as number);
    expect(QueueMonitor.report(STALL_MS).stalled).toBe(false);
  });

  it("a server that has NEVER answered is unconfirmed, not fresh", async () => {
    // The one case that cannot be dated. It is MORE unverified than a lapsed
    // heartbeat, so it must not fall through to the present-tense branch — the
    // null-is-falsy reading is exactly how this class of bug returns.
    startRender(1461_000);
    qm.state.lastServerAliveTs = null;
    qm.state.lastFrameTs = null;
    expect(QueueMonitor.snapshot().lastServerContactTs).toBeNull();

    const { bridge } = makeBridge({ timeoutCmds: new Set(["graph_outline"]) });
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const text = textOf(await defByName("panel_graph_outline").handler({} as never, ctx));

    expect(text).not.toMatch(/is still running/);
    expect(text).toMatch(/UNCONFIRMED/);
    expect(text).toMatch(/has never answered this orchestrator/);
  });
});
