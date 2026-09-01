// #2489 — panel_set_widget on an inner subgraph node delivered to the tab but
// no ACK within 90000 ms, even though the mutation had applied.
//
// The generic mutating-delivery disclosure then left the caller guessing:
// "may have been applied … a blind retry can apply it twice". The following
// panel_expose_subgraph_input completed, and a later panel_query_graph showed
// the requested ImageFromBatch.length. After a tagged no-reply we take ONE
// pinpoint graph_query of that node and report applied / not-applied, or
// return the original timeout WITH a mutation receipt when the read cannot
// answer.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

const { buildPanelToolDefs, makePanelToolCtx } = await import("../../orchestrator/panel-tools.js");
import { markReplyTimeout } from "../../services/ui-bridge.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const TAB = "11111111-2222-3333-4444-555555555555";
const OTHER_TAB = "99999999-8888-7777-6666-555555555555";
const MUTATION_RID = "rid-set-widget-2489";
const NODE_ID = 12;
const WIDGET = "length";
const VALUE = 4;
const PREVIOUS = 1;
const GRAPH_ID = "graph:2489-subgraph";
const WORKFLOW_UUID = "workflow-2489";

const textOf = (res: ToolResult): string =>
  res.content.map((c) => ("text" in c ? (c.text ?? "") : "")).join(" ");

const ackTimeout = (cmd: string, ms: number): Error =>
  new Error(
    `Panel tab ${TAB} did not reply to "${cmd}" within ${ms} ms — the ComfyUI tab may be ` +
      `backgrounded or frozen. This command MUTATES and was already delivered to the tab, so it ` +
      `may have been applied despite the missing reply — check the current state before ` +
      `re-issuing it; a blind retry can apply it twice`,
  );

let sent: Array<{
  cmd: string;
  payload: Record<string, unknown>;
  tabId?: string;
  timeoutMs?: number;
}> = [];

function nodeDetail(
  length: unknown,
  graphIdentity: string = GRAPH_ID,
  scope: "root" | "subgraph" = "subgraph",
): Record<string, unknown> {
  return {
    viewing: {
      scope,
      ...(scope === "subgraph" ? { owner_node_id: 7, title: "batch" } : {}),
      graph_identity: graphIdentity,
      workflow_uuid: WORKFLOW_UUID,
    },
    nodes: [
      {
        id: NODE_ID,
        type: "ImageFromBatch",
        is_subgraph: false,
        node_identity: "node-incarnation:2489:12",
        widgets: { length },
        inputs: [],
      },
    ],
  };
}

function bridge(opts: {
  setReply?: "timeout" | "acked-error" | "acked-error-timeout-worded" | "ok";
  probeLength?: unknown | "timeout" | "missing-node";
  loseTabAfterSet?: boolean;
  fencedGraphIdentity?: string;
  readbackGraphIdentity?: string;
  changeConnectionAfterSet?: boolean;
}) {
  let tabGone = false;
  let queryCount = 0;
  let currentGraphIdentity = GRAPH_ID;
  let connectionGeneration = 1;
  return {
    send: async (
      cmd: Record<string, unknown>,
      o?: { timeoutMs?: number; tabId?: string; onDispatchedRid?: (rid: string) => void },
    ) => {
      sent.push({
        cmd: String(cmd.cmd),
        payload: cmd,
        tabId: o?.tabId,
        timeoutMs: o?.timeoutMs,
      });
      if (cmd.cmd === "graph_set_widget") {
        if (opts.setReply === "acked-error") {
          throw new Error(`Cannot set widget on node ${NODE_ID}: "${WIDGET}" is linked`);
        }
        if (opts.setReply === "acked-error-timeout-worded") {
          throw new Error(
            `Panel tab ${TAB} did not reply to "graph_set_widget" within 90000 ms — the ` +
              `ComfyUI tab may be backgrounded or frozen. Reported by the widget owner: ` +
              `nothing was applied.`,
          );
        }
        if (opts.setReply === "ok" || opts.setReply === undefined) {
          o?.onDispatchedRid?.(MUTATION_RID);
          return {
            set: {
              node_id: cmd.node_id,
              widget: cmd.widget,
              previous: PREVIOUS,
              value: cmd.value,
            },
          };
        }
        if (opts.loseTabAfterSet) tabGone = true;
        o?.onDispatchedRid?.(MUTATION_RID);
        if (opts.changeConnectionAfterSet) connectionGeneration = 2;
        throw markReplyTimeout(ackTimeout("graph_set_widget", 90000));
      }
      if (cmd.cmd === "graph_query") {
        queryCount += 1;
        if (queryCount > 1 && opts.probeLength === "timeout") {
          throw ackTimeout("graph_query", 8000);
        }
        if (queryCount > 1 && opts.probeLength === "missing-node") {
          return { viewing: { scope: "subgraph", graph_identity: GRAPH_ID }, nodes: [] };
        }
        const graphIdentity =
          queryCount === 1
            ? opts.fencedGraphIdentity ?? GRAPH_ID
            : opts.readbackGraphIdentity ?? opts.fencedGraphIdentity ?? GRAPH_ID;
        currentGraphIdentity = graphIdentity;
        return nodeDetail(queryCount > 1 ? opts.probeLength ?? VALUE : PREVIOUS, graphIdentity);
      }
      if (cmd.cmd === "graph_get_subgraph") {
        throw new Error(`Node ${NODE_ID} (ImageFromBatch) is not a subgraph`);
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: (id: string) => (tabGone ? id === OTHER_TAB : id === TAB),
    isHeadless: () => false,
    tabs: () =>
      tabGone
        ? [{ tab_id: OTHER_TAB, title: "other", connected_at: 0 }]
        : [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => (tabGone ? OTHER_TAB : TAB),
    refreshWorkflowUuid: () => true,
    workflowUuidFor: () => ({ known: true, uuid: WORKFLOW_UUID }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    tabConnectionIdentity: () => ({ generation: connectionGeneration, tabSessionId: "browser-tab-2489" }),
    tabExpectedNodeTypeFenceCapability: () => true,
    tabExpectedNodeIdentityFenceCapability: () => true,
    tabExpectedScopeGraphIdentityFenceCapability: () => true,
    tabPromotedTerminalWitnessCapability: () => false,
    tabPromotedParentRailFenceCapability: () => false,
    tabReceiverResolvable: () => true,
    promotedScopeFor: () =>
      ({
        known: true,
        scope: "subgraph",
        ownerNodeId: "7",
        workflowUuid: WORKFLOW_UUID,
        graphIdentity: currentGraphIdentity,
      }),
  } as PanelToolCtx["bridge"];
}

async function runSetWidget(
  opts: Parameters<typeof bridge>[0],
  args: Record<string, unknown> = { node_id: NODE_ID, widget: WIDGET, value: VALUE },
): Promise<{ text: string; isError: boolean; boundTab: string }> {
  const ctx = makePanelToolCtx(bridge(opts), TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_set_widget");
  if (!def) throw new Error("panel_set_widget is not registered");
  const res: ToolResult = await def.handler(args as never, ctx);
  return { text: textOf(res), isError: res.isError === true, boundTab: ctx.tabId };
}

beforeEach(() => {
  sent = [];
});

describe("an unacknowledged subgraph widget write is settled by a read, not by a guess (#2489)", () => {
  it("reports the write as applied when the inner node holds the delivered value", async () => {
    const out = await runSetWidget({ setReply: "timeout", probeLength: VALUE });

    expect(sent.map((s) => s.cmd)).toEqual([
      "graph_query",
      "graph_get_subgraph",
      "graph_set_widget",
      "graph_query",
    ]);
    expect(sent[2]?.timeoutMs).toBe(90_000);
    expect(sent[3]?.payload).toMatchObject({
      cmd: "graph_query",
      ids: [NODE_ID],
      fields: "detail",
      limit: 1,
    });
    expect(sent[3]?.timeoutMs).toBe(8_000);

    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/CHECKED FOR YOU/);
    expect(out.text).toMatch(/"applied": true/);
    expect(out.text).toMatch(new RegExp(`"mutation_id": "${MUTATION_RID}"`));
    expect(out.text).toMatch(/not evidence the write failed/);
    expect(out.text).not.toMatch(/a blind retry can apply it twice/);
  });

  it("reports the write as NOT applied when the inner node holds a different value", async () => {
    const out = await runSetWidget({ setReply: "timeout", probeLength: PREVIOUS });

    expect(sent.map((s) => s.cmd)).toEqual([
      "graph_query",
      "graph_get_subgraph",
      "graph_set_widget",
      "graph_query",
    ]);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/"applied": false/);
    expect(out.text).toMatch(/does NOT show \\"length\\" holding the value/);
    expect(out.text).toMatch(new RegExp(`"mutation_id": "${MUTATION_RID}"`));
    expect(out.text).toMatch(/"observed": 1/);
    expect(out.text).not.toMatch(/a blind retry can apply it twice/);
  });

  it("returns a mutation receipt when the graph read itself cannot answer", async () => {
    const out = await runSetWidget({ setReply: "timeout", probeLength: "timeout" });

    expect(sent.map((s) => s.cmd)).toEqual([
      "graph_query",
      "graph_get_subgraph",
      "graph_set_widget",
      "graph_query",
    ]);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/may have been applied despite the missing reply/);
    expect(out.text).toMatch(/"applied": "unknown"/);
    expect(out.text).toMatch(new RegExp(`"mutation_id": "${MUTATION_RID}"`));
    expect(out.text).toMatch(/"requested"/);
    expect(out.text).toMatch(/"widget": "length"/);
    expect(out.text).toMatch(/cannot duplicate a different change/);
  });

  it("claims nothing when the probe cannot name the written node", async () => {
    const out = await runSetWidget({ setReply: "timeout", probeLength: "missing-node" });

    expect(sent.map((s) => s.cmd)).toEqual([
      "graph_query",
      "graph_get_subgraph",
      "graph_set_widget",
      "graph_query",
    ]);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/"applied": "unknown"/);
    expect(out.text).not.toMatch(/CHECKED FOR YOU/);
    expect(out.text).not.toMatch(/"applied": true/);
  });

  it("does not second-guess an ACKED executor error", async () => {
    const out = await runSetWidget({ setReply: "acked-error" });

    expect(sent.map((s) => s.cmd)).toEqual([
      "graph_query",
      "graph_get_subgraph",
      "graph_set_widget",
    ]);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/is linked/);
    expect(out.text).not.toMatch(/CHECKED FOR YOU/);
    expect(out.text).not.toMatch(/mutation_id/);
  });

  it("does not settle an ACKED error reproducing the canonical sentence VERBATIM", async () => {
    const out = await runSetWidget({ setReply: "acked-error-timeout-worded" });

    expect(out.text).toMatch(
      /did not reply to "graph_set_widget" within 90000 ms — the ComfyUI tab may be backgrounded or frozen/,
    );
    expect(sent.map((s) => s.cmd)).toEqual([
      "graph_query",
      "graph_get_subgraph",
      "graph_set_widget",
    ]);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/nothing was applied/);
    expect(out.text).not.toMatch(/CHECKED FOR YOU/);
  });

  it("claims nothing when the probe lands on a DIFFERENT tab", async () => {
    const out = await runSetWidget({
      setReply: "timeout",
      probeLength: VALUE,
      loseTabAfterSet: true,
    });

    expect(out.boundTab).toBe(OTHER_TAB);
    expect(sent.some((s) => s.cmd === "graph_query")).toBe(true);
    expect(out.isError).toBe(true);
    expect(out.text).not.toMatch(/CHECKED FOR YOU/);
    expect(out.text).not.toMatch(/"applied": true/);
    expect(out.text).toMatch(/"applied": "unknown"/);
    expect(out.text).toMatch(new RegExp(`"mutation_id": "${MUTATION_RID}"`));
  });

  it("does not take a graph read on a successful ACK", async () => {
    const out = await runSetWidget({ setReply: "ok" });

    expect(sent.map((s) => s.cmd)).toEqual([
      "graph_query",
      "graph_get_subgraph",
      "graph_set_widget",
    ]);
    expect(out.isError).toBe(false);
    expect(out.text).not.toMatch(/CHECKED FOR YOU/);
    expect(out.text).toMatch(/"previous": 1/);
    expect(out.text).toMatch(/"value": 4/);
  });

  it("does not certify a matching value after the same tab changes graph identity", async () => {
    const out = await runSetWidget({
      setReply: "timeout",
      probeLength: VALUE,
      fencedGraphIdentity: "graph:before",
      readbackGraphIdentity: "graph:after",
    });

    expect(sent.map((s) => s.cmd)).toEqual([
      "graph_query",
      "graph_get_subgraph",
      "graph_set_widget",
      "graph_query",
    ]);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/"applied": "unknown"/);
    expect(out.text).not.toMatch(/CHECKED FOR YOU/);
  });

  it("does not certify a matching value after the same tab reconnects", async () => {
    const out = await runSetWidget({
      setReply: "timeout",
      probeLength: VALUE,
      changeConnectionAfterSet: true,
    });

    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/"applied": "unknown"/);
    expect(out.text).not.toMatch(/CHECKED FOR YOU/);
  });
});
