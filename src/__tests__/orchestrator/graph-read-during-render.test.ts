// #1639 — while a ComfyUI prompt is running, a graph_* MUTATION can time out with
// "tab may be backgrounded or frozen" and an unknown outcome. The orchestrator CAN
// see the running prompt via QueueMonitor (HTTP /queue, independent of the panel
// tab), so it fails a write closed BEFORE dispatch and the agent gets an explicit
// QUEUE BUSY instead of a 20/30s unknown-outcome timeout. `graph_run` is excluded:
// queuing behind an in-flight job is the documented sweep path.
//
// panel#1489 — that fence was applied to READS too, and this file used to pin
// exactly that (`expect(sent).toEqual([])` for panel_query_graph and
// panel_graph_outline). It should not have: a read that fails carries no unknown
// outcome, so refusing it unsent bought no safety and cost the agent its only way
// to LOOK at the graph mid-render.
//
// The property under test is therefore the SPLIT: `targeted` graph commands are
// refused unsent, `inert` ones are dispatched, and a dispatched read that does
// time out still comes back named QUEUE BUSY rather than "backgrounded or frozen".
// The classification is read from GRAPH_CMD_EFFECT, not from a second list.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { QueueMonitor } from "../../services/queue-monitor.js";
import {
  markDispatched,
  markMidCommandDisconnect,
  markReplyTimeout,
} from "../../services/ui-bridge.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "11111111-2222-4333-8444-555555555555";

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

/** Put a foreign prompt in flight, exactly as the reporter's repro does. */
function startRender(promptId = "p-in-flight", node: string | null = null): void {
  qm.state.runningPromptId = promptId;
  qm.state.currentNode = node;
  qm.state.queueRemaining = 1;
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
  qm.state.lastServerAliveTs = Date.now();
  qm.state.lastFrameTs = Date.now();
});

afterEach(() => {
  qm.selfQueuedIds.clear();
  qm.lastSelfQueueTs = null;
  qm.state.runningPromptId = null;
  qm.state.currentNode = null;
  qm.state.queueRemaining = 0;
  qm.stopped = true;
  qm.url = null;
});

describe("read-only graph inspection is allowed while a prompt runs (panel#1489)", () => {
  it("panel_graph_outline IS dispatched mid-render and returns the graph", async () => {
    startRender();

    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_graph_outline").handler({} as never, ctx);

    // The reported failure: rejected before dispatch, so the agent never saw the graph.
    expect(sent).toEqual(["graph_outline"]);
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).not.toMatch(/QUEUE BUSY/);
    expect(textOf(res)).not.toMatch(/was NOT sent/);
  });

  it("panel_query_graph IS dispatched mid-render", async () => {
    startRender();

    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_query_graph").handler(
      { ids: [1], fields: "ids" } as never,
      ctx,
    );

    expect(sent).toEqual(["graph_query"]);
    expect(res.isError).not.toBe(true);
  });

  it("panel_get_errors IS dispatched mid-render — the recurrence report's second command", async () => {
    startRender();

    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_get_errors").handler({} as never, ctx);

    // Diagnosing a stalled render is the moment this read matters most, and it was
    // refused for being spelled graph_*.
    expect(sent).toEqual(["graph_get_errors"]);
    expect(res.isError).not.toBe(true);
  });

  it("an inert non-read (a selection change) is dispatched too — the gate keys on EFFECT", async () => {
    startRender();

    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    // graph_select_nodes is GRAPH_CMD_EFFECT "inert" but is NOT in
    // BRIDGE_READONLY_CMDS — so this fails if the split is ever re-derived from
    // the re-dispatch-safety list instead of the effect ledger (#778's defect).
    const res = await defByName("panel_select_nodes").handler({ node_ids: [1] } as never, ctx);

    expect(sent).toEqual(["graph_select_nodes"]);
    expect(res.isError).not.toBe(true);
  });
});

describe("graph MUTATIONS still fail fast while a prompt is running (#1639)", () => {
  it("panel_set_widget is NOT delivered — outcome is known (nothing applied)", async () => {
    startRender();

    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_set_widget").handler(
      { node_id: 3, widget: "text", value: "a cat" } as never,
      ctx,
    );
    const text = textOf(res);

    expect(sent).toEqual([]);
    expect(res.isError).toBe(true);
    expect(text).toMatch(/QUEUE BUSY/);
    expect(text).toMatch(/was NOT sent — nothing was applied/);
    expect(text).toMatch(/running prompt p-in-flight/);
    // A mutation that never left must not invite retry_of / unknown-outcome.
    expect(text).not.toMatch(/may have been applied/);
    expect(text).not.toMatch(/retry_of/);
  });

  it("the refusal names the reads that ARE available instead of sending the agent to poll", async () => {
    startRender("p-in-flight", "42");

    const { bridge } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_set_widget").handler(
      { node_id: 3, widget: "text", value: "a cat" } as never,
      ctx,
    );
    const text = textOf(res);

    expect(text).toMatch(/currently at node 42/);
    expect(text).toMatch(/graph_outline/);
    expect(text).toMatch(/NOT fenced/);
    // The old text told every caller reads were unavailable too. Nothing may say so.
    expect(text).not.toMatch(/including read-only/);
  });

  it("a targeted command that is not a node edit is fenced as well", async () => {
    startRender();

    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    // graph_auto_layout moves every node; "targeted" in the ledger, and absent from
    // the MUTATING_GRAPH_EDIT_CMDS allowlist used by the reconnect gate.
    const res = await defByName("panel_auto_layout").handler({} as never, ctx);

    expect(sent).toEqual([]);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/QUEUE BUSY/);
  });

  it("idle queue: the same mutation is dispatched", async () => {
    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_set_widget").handler(
      { node_id: 3, widget: "text", value: "a cat" } as never,
      ctx,
    );

    expect(sent).toEqual(["graph_set_widget"]);
    expect(res.isError).not.toBe(true);
  });

  it("graph_run is still dispatched — queuing behind an in-flight job is the sweep path", async () => {
    qm.state.runningPromptId = "p-own";
    qm.state.queueRemaining = 1;
    QueueMonitor.markSelfQueued("p-own");

    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    // panel_run's own duplicate fence would refuse an unaccounted job; mark it ours.
    const res = await defByName("panel_run").handler({ allow_duplicate: true } as never, ctx);

    expect(sent).toContain("graph_run");
    expect(textOf(res)).not.toMatch(/was NOT sent/);
  });
});

describe("a graph_* timeout while a prompt is running is named QUEUE BUSY (#1639)", () => {
  it("a READ that times out mid-render still names the running prompt", async () => {
    startRender();

    const { bridge, sent } = makeBridge({ timeoutCmds: new Set(["graph_outline"]) });
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_graph_outline").handler({} as never, ctx);
    const text = textOf(res);

    // This is the half of #1639 that survives: the read is attempted, and when the
    // tab genuinely cannot answer, the diagnosis is still explicit rather than a
    // bare "backgrounded or frozen".
    expect(sent).toContain("graph_outline");
    expect(res.isError).toBe(true);
    expect(text).toMatch(/did not reply to "graph_outline"/);
    expect(text).toMatch(/QUEUE BUSY/);
    expect(text).toMatch(/running prompt p-in-flight/);
    expect(text).toMatch(/running: 0/);
  });

  it("that diagnosis does not over-claim: a backgrounded tab is ruled out only once idle", async () => {
    startRender();

    const { bridge } = makeBridge({ timeoutCmds: new Set(["graph_outline"]) });
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const text = textOf(await defByName("panel_graph_outline").handler({} as never, ctx));

    // Reads reach this path now, and a read that goes unanswered mid-render is
    // genuinely ambiguous — the render is the LIKELY cause, not a proven one. The
    // note used to flatly assert "this is not a backgrounded or frozen tab", which
    // is a claim the orchestrator cannot make about a tab that just went silent.
    expect(text).toMatch(/most likely reason/);
    expect(text).not.toMatch(/this is not a backgrounded or frozen tab/i);
    expect(text).toMatch(/if it still does not answer once the queue is idle/i);
  });

  it("graph_run's missing ack names the running prompt instead of a frozen tab", async () => {
    startRender();
    QueueMonitor.markSelfQueued("p-in-flight");

    const { bridge, sent } = makeBridge({ timeoutCmds: new Set(["graph_run"]) });
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_run").handler({ allow_duplicate: true } as never, ctx);
    const text = textOf(res);

    expect(sent).toContain("graph_run");
    expect(res.isError).toBe(true);
    expect(text).toMatch(/did not reply to "graph_run"/);
    expect(text).toMatch(/QUEUE BUSY/);
    expect(text).toMatch(/running prompt p-in-flight/);
  });

  it("an idle queue does not append QUEUE BUSY onto a genuine timeout", async () => {
    const { bridge } = makeBridge({ timeoutCmds: new Set(["graph_run"]) });
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_run").handler({} as never, ctx);
    const text = textOf(res);

    expect(res.isError).toBe(true);
    expect(text).toMatch(/did not reply to "graph_run"/);
    expect(text).not.toMatch(/QUEUE BUSY/);
  });
});

describe("panel_run treats a post-queue disconnect as queued when the prompt is new (panel#1524)", () => {
  function makeDisconnectBridge(afterDispatch?: () => void) {
    const sent: string[] = [];
    const bridge = {
      send: async (cmd: Record<string, unknown>, o?: { onDispatchedRid?: (rid: string) => void }) => {
        sent.push(String(cmd.cmd));
        o?.onDispatchedRid?.("rid-disco-1");
        afterDispatch?.();
        throw markMidCommandDisconnect(
          markDispatched(
            new Error(
              `panel tab ${TAB.slice(0, 8)} disconnected mid-command ("${cmd.cmd}") — OUTCOME UNKNOWN: ` +
                `the command was already sent, so the panel may have applied it (for a run, ComfyUI may already be rendering).`,
            ),
            true,
          ),
        );
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

  it("a NEW running prompt after graph_run disconnects is returned as queued:true", async () => {
    const { bridge, sent } = makeDisconnectBridge(() => {
      qm.state.runningPromptId = "p-poyo-queued";
      qm.state.queueRemaining = 1;
    });
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_run").handler({ to_node_id: 3 } as never, ctx);
    const text = textOf(res);

    expect(sent).toEqual(["graph_run"]);
    expect(res.isError, `expected queued success, got: ${text}`).toBeFalsy();
    expect(text).toContain("p-poyo-queued");
    expect(text).toContain("[RECOVERED]");
    expect(text).toMatch(/queued:true|"queued":\s*true/);
    expect(text).toContain("notified automatically");
    expect(text).toMatch(/Do NOT re-run/i);
  });

  it("the SAME prompt that was already running is NOT claimed as this run", async () => {
    startRender("p-already");
    QueueMonitor.markSelfQueued("p-already");
    const { bridge } = makeDisconnectBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_run").handler({ allow_duplicate: true } as never, ctx);
    const text = textOf(res);

    expect(res.isError).toBe(true);
    expect(text).toMatch(/OUTCOME UNKNOWN/);
    expect(text).not.toContain("[RECOVERED]");
  });

  it("an idle queue after disconnect stays unknown — does not invent a prompt id", async () => {
    const { bridge } = makeDisconnectBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_run").handler({} as never, ctx);
    const text = textOf(res);

    expect(res.isError).toBe(true);
    expect(text).toMatch(/OUTCOME UNKNOWN/);
    expect(text).not.toContain("[RECOVERED]");
    expect(text).not.toMatch(/"queued":\s*true/);
  });
});
