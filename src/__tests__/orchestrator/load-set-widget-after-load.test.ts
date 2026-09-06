// #2886 — after panel_new_workflow then panel_load_workflow, panel_set_widget
// refused before dispatch: graph_get_subgraph could not tell whether the node
// was a promoted container. That hit a live H3 subgraph AND an ordinary root
// SaveVideo. Outline/query of the same nodes succeeded. A manual
// panel_set_workflow_target({mode:"current"}) then allowed the identical write.
//
// A successful load must drop leftover subgraph identity and mark the subgraph
// registry stale so the next write refreshes mapping once. A mapping-unknown
// miss on a live container must retry graph_get_subgraph after that walk.
// Still unverifiable stays fail-closed. Do not re-derive from whatever is
// active now (the #1478 P1).

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetStaleSubgraphMappingForTest,
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import {
  clearRememberedViewingScope,
  noteConfirmedViewing,
  rememberedSubgraphOwner,
} from "../../services/subgraph-viewing-scope.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "tmp:2886-new-then-load";
const SAVE_VIDEO_ID = 80;
const H3_ID = 42;
const H3_INNER_ID = 198;
const ROOT_GRAPH_IDENTITY = "graph:2886-loaded-root";
const CHILD_GRAPH_IDENTITY = "graph:2886-h3-child";
const WORKFLOW_UUID = "28860000-0000-4000-8000-000000000042";
const NODE_IDENTITY_SAVE = "node-incarnation:80:savevideo";
const NODE_IDENTITY_H3 = "node-incarnation:42:h3";
const MAPPING_UNKNOWN = (id: number, type: string) =>
  `Cannot read node ${id} (${type}) because the subgraph mapping is not loaded`;

const UI_GRAPH = {
  last_node_id: H3_ID,
  nodes: [
    { id: SAVE_VIDEO_ID, type: "SaveVideo", widgets_values: ["video"] },
    { id: H3_ID, type: "MiniMaxH3Director", widgets_values: ["old prompt"] },
  ],
  links: [],
};

type QMBridge = PanelToolCtx["bridge"];

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} not found`);
  return def;
}

function textOf(result: ToolResult): string {
  return result.content.map((block) => (block as { text?: string }).text ?? "").join(" ");
}

beforeEach(() => {
  __resetStaleSubgraphMappingForTest();
  clearRememberedViewingScope();
});

afterEach(() => {
  __resetStaleSubgraphMappingForTest();
  clearRememberedViewingScope();
});

function makeLoadThenWriteBridge(opts?: { outlineHelps?: boolean }) {
  const calls: Array<Record<string, unknown>> = [];
  let writes = 0;
  let mappingReady = false;
  const outlineHelps = opts?.outlineHelps !== false;
  const viewing = {
    scope: "root" as const,
    workflow_uuid: WORKFLOW_UUID,
    graph_identity: ROOT_GRAPH_IDENTITY,
  };
  const connectionIdentity = { generation: 1, tabSessionId: "browser-tab-2886" };
  let observedScope: {
    known: true;
    scope: "root" | "subgraph";
    ownerNodeId: string | null;
    workflowUuid: string;
    graphIdentity: string;
  } = {
    known: true,
    scope: "root",
    ownerNodeId: null,
    workflowUuid: WORKFLOW_UUID,
    graphIdentity: ROOT_GRAPH_IDENTITY,
  };

  const rememberViewing = (value: Record<string, unknown>) => {
    const next = value.viewing;
    if (!next || typeof next !== "object" || Array.isArray(next)) return value;
    const rec = next as Record<string, unknown>;
    if (rec.scope !== "root" && rec.scope !== "subgraph") return value;
    observedScope = {
      known: true,
      scope: rec.scope,
      ownerNodeId: rec.owner_node_id == null ? null : String(rec.owner_node_id),
      workflowUuid: WORKFLOW_UUID,
      graphIdentity:
        typeof rec.graph_identity === "string" ? rec.graph_identity : ROOT_GRAPH_IDENTITY,
    };
    return value;
  };

  const saveVideoRow = (ready: boolean) => ({
    id: SAVE_VIDEO_ID,
    type: "SaveVideo",
    ...(ready ? { is_subgraph: false, node_identity: NODE_IDENTITY_SAVE } : {}),
    widgets: { filename_prefix: "video" },
  });

  const h3Row = () => ({
    id: H3_ID,
    type: "MiniMaxH3Director",
    is_subgraph: true,
    node_identity: NODE_IDENTITY_H3,
    widgets: { prompt: "old prompt" },
  });

  const h3Envelope = () =>
    rememberViewing({
      subgraph_of: {
        node_id: H3_ID,
        title: "MiniMax H3",
        graph_identity: CHILD_GRAPH_IDENTITY,
      },
      node_count: 1,
      nodes: [
        {
          id: H3_INNER_ID,
          type: "PrimitiveString",
          node_identity: "node-incarnation:198:prompt",
          widgets: { value: "old prompt" },
          inputs: [{ name: "value", type: "STRING" }],
        },
      ],
      promoted_terminals: [
        {
          widget: "prompt",
          parent_rail: { authoritative: true, widget: "prompt" },
          immediate_node_id: H3_INNER_ID,
          immediate_widget: "value",
          terminal_node_id: H3_INNER_ID,
          terminal_node_type: "PrimitiveString",
          terminal_widget: "value",
          terminal_inputs: [{ name: "value", type: "STRING" }],
          chain_depth: 0,
        },
      ],
      viewing,
    });

  const bridge = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push({ ...cmd });
      if (cmd.cmd === "graph_serialize") {
        return { workflow: { last_node_id: 0, nodes: [], links: [] }, node_count: 0 };
      }
      if (cmd.cmd === "graph_load") {
        mappingReady = false;
        return { loaded: true, node_count: UI_GRAPH.nodes.length };
      }
      if (cmd.cmd === "graph_outline") {
        if (outlineHelps) mappingReady = true;
        return rememberViewing({ viewing, node_count: 2, outline: "80 SaveVideo\n42 MiniMaxH3Director" });
      }
      if (cmd.cmd === "graph_query") {
        const wantId = Array.isArray(cmd.ids) && cmd.ids.length ? String(cmd.ids[0]) : null;
        if (wantId === String(SAVE_VIDEO_ID)) {
          return rememberViewing({ viewing, nodes: [saveVideoRow(mappingReady)] });
        }
        if (wantId === String(H3_ID)) {
          return rememberViewing({ viewing, nodes: [h3Row()] });
        }
        return rememberViewing({ viewing, nodes: [saveVideoRow(mappingReady), h3Row()] });
      }
      if (cmd.cmd === "graph_get_subgraph") {
        if (!mappingReady) {
          const id = Number(cmd.node_id);
          const type = id === H3_ID ? "MiniMaxH3Director" : "SaveVideo";
          throw new Error(MAPPING_UNKNOWN(id, type));
        }
        if (String(cmd.node_id) === String(SAVE_VIDEO_ID)) {
          throw new Error("Node 80 (SaveVideo) is not a subgraph");
        }
        if (String(cmd.node_id) !== String(H3_ID)) {
          throw new Error(`Node ${cmd.node_id} (OrdinaryNode) is not a subgraph`);
        }
        return h3Envelope();
      }
      if (cmd.cmd === "graph_set_widget") {
        writes += 1;
        return {
          set: {
            node_id: cmd.node_id,
            widget: cmd.widget,
            previous: "old prompt",
            value: cmd.value,
          },
        };
      }
      if (cmd.cmd === "workflow_list") {
        const active = {
          path: "workflows/other.json",
          routing_key: "wf:other",
          workflow_uuid: "99999999-8888-4777-a666-555555555555",
        };
        return { active, workflows: [active] };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "Unsaved Workflow", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    tabConnectionIdentity: () => connectionIdentity,
    tabExpectedNodeTypeFenceCapability: () => true,
    tabExpectedNodeIdentityFenceCapability: () => true,
    tabExpectedScopeGraphIdentityFenceCapability: () => true,
    tabPromotedTerminalWitnessCapability: () => true,
    tabPromotedParentRailFenceCapability: () => true,
    tabReceiverResolvable: () => true,
    workflowUuidFor: () => ({ known: true, uuid: WORKFLOW_UUID }),
    refreshWorkflowUuid: () => true,
    corroborateTabStamp: () => true,
    promotedScopeFor: () => observedScope,
    applyLiveRootViewing: (tabId: string) => {
      if (tabId === TAB) {
        observedScope = {
          known: true,
          scope: "root",
          ownerNodeId: null,
          workflowUuid: WORKFLOW_UUID,
          graphIdentity: ROOT_GRAPH_IDENTITY,
        };
      }
    },
    clearPromotedSubgraphIdentity: (tabId: string) => {
      if (tabId === TAB && observedScope.scope === "subgraph") {
        observedScope = {
          known: true,
          scope: "root",
          ownerNodeId: null,
          workflowUuid: WORKFLOW_UUID,
          graphIdentity: ROOT_GRAPH_IDENTITY,
        };
      }
    },
  } as QMBridge;

  return {
    bridge,
    calls,
    get writes() {
      return writes;
    },
  };
}

async function loadUi(ctx: PanelToolCtx) {
  return defByName("panel_load_workflow").handler({ graph: structuredClone(UI_GRAPH) } as never, ctx);
}

describe("panel_set_widget after panel_load_workflow (#2886)", () => {
  it("clears leftover subgraph identity on a successful UI load", async () => {
    noteConfirmedViewing(TAB, {
      viewing: {
        scope: "subgraph",
        owner_node_id: 12,
        workflow_uuid: WORKFLOW_UUID,
        graph_identity: "graph:stale-before-load",
      },
    });
    expect(rememberedSubgraphOwner(TAB)).toBe("12");

    const harness = makeLoadThenWriteBridge();
    const ctx = makePanelToolCtx(harness.bridge, TAB, new WorkflowTargetStore());
    const loaded = await loadUi(ctx);
    expect(loaded.isError).toBeFalsy();
    expect(rememberedSubgraphOwner(TAB)).toBeNull();
    expect(harness.calls.map((call) => call.cmd)).not.toContain("workflow_list");
  });

  it("THE REPORTED CASE: UI load then SaveVideo write without a manual current-target rebind", async () => {
    const harness = makeLoadThenWriteBridge();
    const ctx = makePanelToolCtx(harness.bridge, TAB, new WorkflowTargetStore());

    const loaded = await loadUi(ctx);
    expect(loaded.isError).toBeFalsy();

    const written = await defByName("panel_set_widget").handler(
      { node_id: SAVE_VIDEO_ID, widget: "filename_prefix", value: "ep01" } as never,
      ctx,
    );
    expect(textOf(written)).not.toMatch(
      /could not determine whether the addressed node is a promoted container/,
    );
    expect(written.isError).toBeFalsy();
    expect(harness.calls.filter((call) => call.cmd === "graph_outline")).toHaveLength(1);
    expect(harness.calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({
        node_id: SAVE_VIDEO_ID,
        widget: "filename_prefix",
        value: "ep01",
        expected_node_type: "SaveVideo",
      }),
    ]);
    expect(harness.writes).toBe(1);
  });

  it("writes a live H3 subgraph container after the same load without a current-target rebind", async () => {
    const harness = makeLoadThenWriteBridge();
    const ctx = makePanelToolCtx(harness.bridge, TAB, new WorkflowTargetStore());

    const loaded = await loadUi(ctx);
    expect(loaded.isError).toBeFalsy();

    const written = await defByName("panel_set_widget").handler(
      { node_id: H3_ID, widget: "prompt", value: "new prompt" } as never,
      ctx,
    );
    expect(textOf(written)).not.toMatch(
      /could not determine whether the addressed node is a promoted container/,
    );
    expect(written.isError).toBeFalsy();
    expect(harness.calls.filter((call) => call.cmd === "graph_outline")).toHaveLength(1);
    expect(harness.calls.filter((call) => call.cmd === "graph_get_subgraph").length).toBeGreaterThan(0);
    expect(harness.calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({
        node_id: H3_ID,
        widget: "prompt",
        value: "new prompt",
      }),
    ]);
    expect(harness.writes).toBe(1);
  });

  it("fails closed when the mapping is still unverifiable after one refresh", async () => {
    const harness = makeLoadThenWriteBridge({ outlineHelps: false });
    const ctx = makePanelToolCtx(harness.bridge, TAB, new WorkflowTargetStore());

    const loaded = await loadUi(ctx);
    expect(loaded.isError).toBeFalsy();

    const refused = await defByName("panel_set_widget").handler(
      { node_id: SAVE_VIDEO_ID, widget: "filename_prefix", value: "ep01" } as never,
      ctx,
    );
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(
      /could not determine whether the addressed node is a promoted container/,
    );
    expect(harness.calls.filter((call) => call.cmd === "graph_outline")).toHaveLength(1);
    expect(harness.calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(0);
    expect(harness.writes).toBe(0);
  });

  it("retries graph_get_subgraph for a live container after a mapping-unknown miss", async () => {
    const harness = makeLoadThenWriteBridge();
    const ctx = makePanelToolCtx(harness.bridge, TAB, new WorkflowTargetStore());
    // Skip load so the tab is not pre-marked stale: first probe sees a container
    // and graph_get_subgraph is mapping-unknown. #2730 only recovered ordinary
    // root; the container must retry the subgraph read after the outline walk.
    const written = await defByName("panel_set_widget").handler(
      { node_id: H3_ID, widget: "prompt", value: "direct" } as never,
      ctx,
    );
    expect(written.isError).toBeFalsy();
    expect(harness.calls.map((call) => call.cmd)).toEqual([
      "graph_query",
      "graph_get_subgraph",
      "graph_outline",
      "graph_query",
      "graph_get_subgraph",
      "graph_set_widget",
    ]);
    expect(harness.writes).toBe(1);
  });
});
