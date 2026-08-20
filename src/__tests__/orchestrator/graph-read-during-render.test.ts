// #1639 — while a ComfyUI prompt is running, graph_* (including read-only
// graph_query / graph_outline) time out with "tab may be backgrounded or frozen"
// and mutating commands report an unknown outcome. 100% correlated with
// queue action:"list" showing running:1; the same calls succeed the moment
// the queue drains.
//
// The frontend main thread is what cannot answer. The orchestrator CAN see the
// running prompt via QueueMonitor (HTTP /queue, independent of the panel tab).
// Fail closed BEFORE dispatch for graph EDITS so the agent gets an explicit
// QUEUE BUSY instead of a 20/30s unknown-outcome timeout. `graph_run` is
// excluded: queuing behind an in-flight job is the documented sweep path. A
// timeout that still happens is annotated with the same QUEUE BUSY rather than
// "backgrounded or frozen".
//
// panel#1517 — #1745 applied that refusal to READS too, which cost read-only
// inspection for the whole duration of a render: an agent could not read the
// prompt warning it was trying to correct for the next run. A read has no
// mutation outcome to be unknown about, so an `inert` command (GRAPH_CMD_EFFECT)
// is DISPATCHED while a prompt runs; if the tab genuinely cannot answer it, the
// bounded read budget produces the same QUEUE BUSY text on the timeout path.
// The edit refusal is unchanged — that is what the unknown outcome is about.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { QueueMonitor } from "../../services/queue-monitor.js";
import { isMutatingGraphCommand, markReplyTimeout } from "../../services/ui-bridge.js";
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

describe("graph EDITS fail fast while a prompt is running (#1639)", () => {
  it("panel_set_widget is NOT delivered — outcome is known (nothing applied)", async () => {
    qm.state.runningPromptId = "p-in-flight";
    qm.state.currentNode = "42";
    qm.state.queueRemaining = 1;

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
    expect(text).toMatch(/running prompt p-in-flight/);
    expect(text).toMatch(/currently at node 42/);
    expect(text).toMatch(/was NOT sent — nothing was applied/);
    expect(text).toMatch(/running: 0/);
    // A mutation that never left must not invite retry_of / unknown-outcome.
    expect(text).not.toMatch(/may have been applied/);
    expect(text).not.toMatch(/retry_of/);
  });

  it("the edit refusal points at the reads that ARE still available (panel#1517)", async () => {
    qm.state.runningPromptId = "p-in-flight";
    qm.state.queueRemaining = 1;

    const { bridge } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_set_widget").handler(
      { node_id: 3, widget: "text", value: "a cat" } as never,
      ctx,
    );
    const text = textOf(res);

    expect(text).toMatch(/panel_graph_outline/);
    expect(text).toMatch(/panel_query_graph/);
    // The pre-#1517 wording told the agent reads were refused too. If that ever
    // comes back the message is lying about the behaviour this file pins below.
    expect(text).not.toMatch(/including read-only graph_query \/ graph_outline/);
  });

  it("idle queue: the same read is dispatched", async () => {
    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_query_graph").handler({ ids: [1], fields: "ids" } as never, ctx);

    expect(sent).toEqual(["graph_query"]);
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

// panel#1517 — the reported defect: a live-canvas READ is refused while a prompt
// runs, so an agent cannot inspect or correct a prompt warning for the next run.
// These pin that reads are DISPATCHED. Delete the `isMutatingGraphCommand` line
// in graphCmdBlockedByRunningPrompt and every one of them fails on `sent`.
describe("read-only graph commands are dispatched while a prompt runs (panel#1517)", () => {
  beforeEach(() => {
    qm.state.runningPromptId = "p-in-flight";
    qm.state.currentNode = "42";
    qm.state.queueRemaining = 1;
  });

  it("panel_graph_outline is sent and answers — the reported call", async () => {
    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_graph_outline").handler({} as never, ctx);

    expect(sent).toEqual(["graph_outline"]);
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).not.toMatch(/was NOT sent/);
  });

  it("panel_query_graph is sent — the other call named in the report", async () => {
    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_query_graph").handler({ ids: [1], fields: "ids" } as never, ctx);

    expect(sent).toEqual(["graph_query"]);
    expect(res.isError).not.toBe(true);
  });

  it("panel_get_errors is sent — the prompt-warning surface the reporter wanted", async () => {
    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_get_errors").handler({} as never, ctx);

    expect(sent).toContain("graph_get_errors");
    expect(textOf(res)).not.toMatch(/was NOT sent/);
  });

  it("a read that DOES time out still gets the QUEUE BUSY explanation, not a frozen tab", async () => {
    const { bridge, sent } = makeBridge({ timeoutCmds: new Set(["graph_outline"]) });
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_graph_outline").handler({} as never, ctx);
    const text = textOf(res);

    // It was ATTEMPTED — that is the whole change. The outcome when the tab
    // really cannot answer is no worse than the old refusal, only later.
    expect(sent).toContain("graph_outline");
    expect(res.isError).toBe(true);
    expect(text).toMatch(/QUEUE BUSY/);
    expect(text).toMatch(/running prompt p-in-flight/);
    expect(text).toMatch(/not a backgrounded or frozen tab/i);
  });

  it("an UNCLASSIFIED graph_* command still fails closed as an edit", async () => {
    // The ledger fails closed, so a command nobody classified is refused here —
    // the same rule GRAPH_CMD_EFFECT applies at the workflow fence. Asserted
    // through the predicate the guard actually consults.
    expect(isMutatingGraphCommand("graph_some_future_mutator")).toBe(true);
    expect(isMutatingGraphCommand("graph_outline")).toBe(false);
    expect(isMutatingGraphCommand("graph_query")).toBe(false);
    expect(isMutatingGraphCommand("graph_get_errors")).toBe(false);
    expect(isMutatingGraphCommand("graph_set_widget")).toBe(true);
  });
});

describe("a graph_* timeout while a prompt is running is named QUEUE BUSY (#1639)", () => {
  it("graph_run's missing ack names the running prompt instead of a frozen tab", async () => {
    qm.state.runningPromptId = "p-in-flight";
    qm.state.queueRemaining = 1;
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
    expect(text).toMatch(/not a backgrounded or frozen tab/i);
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
