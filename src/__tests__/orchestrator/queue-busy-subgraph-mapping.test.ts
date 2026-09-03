// #2730 — after queue-busy correctly refuses panel_set_widget, an idle retry
// still refused ordinary root UNETLoader writes because graph_get_subgraph
// could not tell whether they were promoted containers. panel_graph_outline
// refreshed the mapping; the same writes then succeeded.
//
// The shipped handler must refresh that mapping itself (after the busy
// refusal clears, or once on a mapping-unknown root read) and fail closed
// if the node is still unverifiable.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetStaleSubgraphMappingForTest,
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { QueueMonitor } from "../../services/queue-monitor.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:2730-unet-root";
const NODE_ID = 12;
const ROOT_GRAPH_IDENTITY = "graph:2730-root";
const WORKFLOW_UUID = "27300000-0000-4000-8000-000000000012";
const NODE_IDENTITY = "node-incarnation:12:unet";
const UNET_NAME = "flux1-dev.safetensors";
const MAPPING_UNKNOWN =
  "Cannot read node 12 (UNETLoader) because the subgraph mapping is not loaded";

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
const qm = QueueMonitor as QMPriv;

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} not found`);
  return def;
}

function textOf(result: ToolResult): string {
  return result.content.map((block) => (block as { text?: string }).text ?? "").join(" ");
}

function startRender(promptId = "p-in-flight"): void {
  qm.state.runningPromptId = promptId;
  qm.state.currentNode = "UNETLoader";
  qm.state.queueRemaining = 1;
}

function stopRender(): void {
  qm.state.runningPromptId = null;
  qm.state.currentNode = null;
  qm.state.queueRemaining = 0;
}

beforeEach(() => {
  __resetStaleSubgraphMappingForTest();
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
  __resetStaleSubgraphMappingForTest();
  qm.selfQueuedIds.clear();
  qm.lastSelfQueueTs = null;
  qm.state.runningPromptId = null;
  qm.state.currentNode = null;
  qm.state.queueRemaining = 0;
  qm.stopped = true;
  qm.url = null;
});

function makeMappingBridge(opts?: { outlineHelps?: boolean; mappingReady?: boolean }) {
  const calls: Array<Record<string, unknown>> = [];
  let writes = 0;
  let mappingReady = opts?.mappingReady === true;
  const outlineHelps = opts?.outlineHelps !== false;
  const viewing = {
    scope: "root" as const,
    workflow_uuid: WORKFLOW_UUID,
    graph_identity: ROOT_GRAPH_IDENTITY,
  };

  const unetRow = (ready: boolean) => ({
    id: NODE_ID,
    type: "UNETLoader",
    ...(ready ? { is_subgraph: false, node_identity: NODE_IDENTITY } : {}),
    widgets: { unet_name: "old.safetensors" },
  });

  const bridge = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push({ ...cmd });
      if (cmd.cmd === "graph_outline") {
        if (outlineHelps) mappingReady = true;
        return { viewing, node_count: 1, outline: "12 UNETLoader" };
      }
      if (cmd.cmd === "graph_query") {
        return { viewing, nodes: [unetRow(mappingReady)] };
      }
      if (cmd.cmd === "graph_get_subgraph") {
        if (mappingReady) {
          throw new Error("Node 12 (UNETLoader) is not a subgraph");
        }
        throw new Error(MAPPING_UNKNOWN);
      }
      if (cmd.cmd === "graph_set_widget") {
        writes += 1;
        return {
          set: {
            node_id: cmd.node_id,
            widget: cmd.widget,
            previous: "old.safetensors",
            value: cmd.value,
          },
        };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    tabConnectionIdentity: () => ({ generation: 1, tabSessionId: "browser-tab-2730" }),
    tabExpectedNodeTypeFenceCapability: () => true,
    tabExpectedNodeIdentityFenceCapability: () => true,
    tabExpectedScopeGraphIdentityFenceCapability: () => true,
    tabPromotedTerminalWitnessCapability: () => true,
    tabPromotedParentRailFenceCapability: () => true,
    tabReceiverResolvable: () => true,
    workflowUuidFor: () => ({ known: true, uuid: WORKFLOW_UUID }),
    refreshWorkflowUuid: () => true,
    corroborateTabStamp: () => true,
    promotedScopeFor: () => ({
      known: true as const,
      scope: "root" as const,
      ownerNodeId: null,
      workflowUuid: WORKFLOW_UUID,
      graphIdentity: ROOT_GRAPH_IDENTITY,
    }),
  } as PanelToolCtx["bridge"];

  return {
    bridge,
    calls,
    get writes() {
      return writes;
    },
    goStale() {
      mappingReady = false;
    },
  };
}

async function setUnet(ctx: PanelToolCtx, value = UNET_NAME) {
  return defByName("panel_set_widget").handler(
    { node_id: NODE_ID, widget: "unet_name", value } as never,
    ctx,
  );
}

describe("ordinary root UNETLoader write after queue-busy (#2730)", () => {
  it("THE REPORTED CASE: queue-busy refuse, idle retry writes without a manual outline", async () => {
    const harness = makeMappingBridge({ mappingReady: true });
    const ctx = makePanelToolCtx(harness.bridge, TAB, new WorkflowTargetStore());

    startRender();
    const busy = await setUnet(ctx);
    expect(busy.isError).toBe(true);
    expect(textOf(busy)).toMatch(/QUEUE BUSY/);
    expect(harness.calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(0);
    expect(harness.writes).toBe(0);

    stopRender();
    harness.goStale();

    const idle = await setUnet(ctx);
    expect(textOf(idle)).not.toMatch(/could not determine whether the addressed node is a promoted container/);
    expect(idle.isError).toBeFalsy();
    expect(harness.calls.filter((call) => call.cmd === "graph_outline")).toHaveLength(1);
    expect(harness.calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({
        node_id: NODE_ID,
        widget: "unet_name",
        value: UNET_NAME,
        expected_node_type: "UNETLoader",
      }),
    ]);
    expect(harness.writes).toBe(1);
  });

  it("mapping-unknown at a proven root refreshes once and then writes", async () => {
    const harness = makeMappingBridge({ mappingReady: false });
    const ctx = makePanelToolCtx(harness.bridge, TAB, new WorkflowTargetStore());

    const written = await setUnet(ctx);
    expect(written.isError).toBeFalsy();
    expect(textOf(written)).not.toMatch(/could not determine whether the addressed node is a promoted container/);
    expect(harness.calls.map((call) => call.cmd)).toEqual([
      "graph_query",
      "graph_get_subgraph",
      "graph_outline",
      "graph_query",
      "graph_set_widget",
    ]);
    expect(harness.writes).toBe(1);
  });

  it("fails closed when the mapping is still unverifiable after one refresh", async () => {
    const harness = makeMappingBridge({ mappingReady: false, outlineHelps: false });
    const ctx = makePanelToolCtx(harness.bridge, TAB, new WorkflowTargetStore());

    const refused = await setUnet(ctx);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/could not determine whether the addressed node is a promoted container/);
    expect(harness.calls.filter((call) => call.cmd === "graph_outline")).toHaveLength(1);
    expect(harness.calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(0);
    expect(harness.writes).toBe(0);
  });
});
