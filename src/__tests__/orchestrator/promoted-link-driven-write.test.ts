// #2500 — writing a promoted widget on a saved subgraph container
// (duration/value_2, fps/value_3) was routed to the inner PrimitiveInt. The
// tool reported success and warned that those inner widgets are link-driven,
// so the write would not affect rendering. The enclosing container stayed at
// 5 seconds / 25 fps. Root query and queue serialization must receive the
// enclosing subgraph widget.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:ltx-flf";
const CONTAINER_ID = 42;
const DURATION_INNER_ID = 198;
const FPS_INNER_ID = 199;
const WORKFLOW_UUID = "workflow-flf";
const ROOT_GRAPH = "graph:workflow-flf-root";
const CHILD_GRAPH = "graph:workflow-flf-container-42";
const LINK_DRIVEN_WARNING =
  "The write SUCCEEDED and was verified, but it will NOT change the render: " +
  "widget value on inner node is link-driven from promoted input. " +
  "Set the enclosing subgraph node instead.";

const INNER_NODES = [
  {
    id: DURATION_INNER_ID,
    type: "PrimitiveInt",
    node_identity: `node-incarnation:test:${DURATION_INNER_ID}`,
    widgets: { value: 5 },
    inputs: [{ name: "value", type: "INT" }],
  },
  {
    id: FPS_INNER_ID,
    type: "PrimitiveInt",
    node_identity: `node-incarnation:test:${FPS_INNER_ID}`,
    widgets: { value: 25 },
    inputs: [{ name: "value", type: "INT" }],
  },
];

function promotedTerminal(widget: string, innerNodeId: number) {
  return {
    widget,
    parent_rail: { authoritative: true, widget },
    immediate_node_id: innerNodeId,
    immediate_widget: "value",
    terminal_node_id: innerNodeId,
    terminal_node_type: "PrimitiveInt",
    terminal_widget: "value",
    terminal_inputs: [{ name: "value", type: "INT" }],
    chain_depth: 0,
  };
}

function textOf(res: ToolResult): string {
  return res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");
}

function parseJson(res: ToolResult): Record<string, unknown> | null {
  const text = textOf(res).trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function harness() {
  const calls: Array<Record<string, unknown>> = [];
  const containerWidgets: Record<string, number> = { value_2: 5, value_3: 25 };
  const innerWidgets: Record<number, number> = {
    [DURATION_INNER_ID]: 5,
    [FPS_INNER_ID]: 25,
  };
  let inSubgraph = false;
  let currentGraphIdentity = ROOT_GRAPH;
  const connectionIdentity = { generation: 1, tabSessionId: "browser-tab-flf" };
  let observedPromotedScope: {
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
    graphIdentity: ROOT_GRAPH,
  };

  const currentViewing = () => ({
    scope: inSubgraph ? "subgraph" : "root",
    ...(inSubgraph ? { owner_node_id: CONTAINER_ID } : {}),
    graph_identity: currentGraphIdentity,
    workflow_uuid: WORKFLOW_UUID,
  });

  const rememberViewing = (value: Record<string, unknown>) => {
    const viewing = value.viewing;
    if (!viewing || typeof viewing !== "object" || Array.isArray(viewing)) return value;
    const identity = viewing as Record<string, unknown>;
    if (identity.scope !== "root" && identity.scope !== "subgraph") return value;
    observedPromotedScope = {
      known: true,
      scope: identity.scope,
      ownerNodeId: identity.owner_node_id == null ? null : String(identity.owner_node_id),
      workflowUuid: WORKFLOW_UUID,
      graphIdentity: typeof identity.graph_identity === "string"
        ? identity.graph_identity
        : currentGraphIdentity,
    };
    return value;
  };

  const subgraphEnvelope = () =>
    rememberViewing({
      subgraph_of: {
        node_id: CONTAINER_ID,
        title: "First-Last-Frame to Video (LTX-2.3)",
        graph_identity: CHILD_GRAPH,
      },
      node_count: INNER_NODES.length,
      nodes: INNER_NODES,
      promoted_terminals: [
        promotedTerminal("value_2", DURATION_INNER_ID),
        promotedTerminal("value_3", FPS_INNER_ID),
      ],
      viewing: currentViewing(),
    });

  const containerDetail = () =>
    rememberViewing({
      nodes: [
        {
          id: CONTAINER_ID,
          type: "SubgraphNode",
          is_subgraph: true,
          node_identity: "node-incarnation:test:42",
          widgets: { ...containerWidgets },
        },
      ],
      viewing: currentViewing(),
    });

  const b = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push({ ...cmd });
      if (cmd.cmd === "graph_set_widget") {
        const nodeId = Number(cmd.node_id);
        const widget = String(cmd.widget);
        const value = cmd.value;
        if (nodeId === CONTAINER_ID && (widget === "value_2" || widget === "value_3")) {
          const previous = containerWidgets[widget];
          containerWidgets[widget] = Number(value);
          return {
            set: { node_id: nodeId, widget, previous, value: containerWidgets[widget] },
          };
        }
        if (
          (nodeId === DURATION_INNER_ID || nodeId === FPS_INNER_ID) &&
          widget === "value"
        ) {
          innerWidgets[nodeId] = Number(value);
          return {
            set: { node_id: nodeId, widget, previous: 5, value },
            warning: LINK_DRIVEN_WARNING,
          };
        }
        throw new Error(`unexpected graph_set_widget ${nodeId} ${widget}`);
      }
      if (cmd.cmd === "graph_get_subgraph") {
        if (String(cmd.node_id) !== String(CONTAINER_ID)) {
          throw new Error(`Node ${cmd.node_id} (OrdinaryNode) is not a subgraph`);
        }
        return subgraphEnvelope();
      }
      if (cmd.cmd === "graph_enter_subgraph") {
        inSubgraph = true;
        currentGraphIdentity = CHILD_GRAPH;
        return { scope: "subgraph", node_id: cmd.node_id };
      }
      if (cmd.cmd === "graph_exit_subgraph") {
        inSubgraph = false;
        currentGraphIdentity = ROOT_GRAPH;
        return { scope: "root" };
      }
      if (cmd.cmd === "graph_query") {
        const wantId = Array.isArray(cmd.ids) && cmd.ids.length ? String(cmd.ids[0]) : null;
        if (inSubgraph && wantId) {
          const node = INNER_NODES.find((candidate) => String(candidate.id) === wantId);
          if (node) {
            return rememberViewing({
              nodes: [{ id: node.id, type: node.type, node_identity: node.node_identity }],
              viewing: currentViewing(),
            });
          }
        }
        return containerDetail();
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "flf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    tabCanMutateGraph: () => true,
    tabConnectionIdentity: () => connectionIdentity,
    promotedScopeFor: () => observedPromotedScope,
    tabExpectedNodeTypeFenceCapability: () => true,
    tabExpectedNodeIdentityFenceCapability: () => true,
    tabExpectedScopeGraphIdentityFenceCapability: () => true,
    tabPromotedTerminalWitnessCapability: () => true,
    tabPromotedParentRailFenceCapability: () => true,
    tabReceiverResolvable: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    workflowUuidFor: () => ({ known: true, uuid: WORKFLOW_UUID }),
  } as PanelToolCtx["bridge"];

  return {
    b,
    calls,
    containerWidgets,
    innerWidgets,
    serializeForQueue: () => ({ ...containerWidgets }),
    viewing: () => observedPromotedScope,
    get inSubgraph() {
      return inSubgraph;
    },
  };
}

async function runSetWidget(widget: "value_2" | "value_3", value: number) {
  const h = harness();
  const ctx = makePanelToolCtx(h.b, TAB, new WorkflowTargetStore());
  const setDef = buildPanelToolDefs().find((d) => d.name === "panel_set_widget");
  const queryDef = buildPanelToolDefs().find((d) => d.name === "panel_query_graph");
  if (!setDef || !queryDef) throw new Error("panel tools are not registered");
  const written: ToolResult = await setDef.handler(
    { node_id: CONTAINER_ID, widget, value } as never,
    ctx,
  );
  const queried: ToolResult = await queryDef.handler(
    { ids: [CONTAINER_ID], fields: "detail", limit: 1 } as never,
    ctx,
  );
  return { h, written, queried };
}

describe("panel_set_widget promoted link-driven inner misroute (#2500)", () => {
  it("writes duration/value_2 on the enclosing subgraph so root query and queue serialization receive 4", async () => {
    const { h, written, queried } = await runSetWidget("value_2", 4);

    expect(written.isError === true).toBe(false);
    expect(textOf(written)).not.toMatch(/will NOT change the render|Set the enclosing subgraph node/);
    expect(h.calls.map((call) => call.cmd)).not.toContain("graph_enter_subgraph");
    expect(h.inSubgraph).toBe(false);
    expect(h.viewing().scope).toBe("root");

    const writes = h.calls.filter((call) => call.cmd === "graph_set_widget");
    expect(writes).toEqual([
      expect.objectContaining({ node_id: CONTAINER_ID, widget: "value_2", value: 4 }),
    ]);
    expect(writes.some((call) => Number(call.node_id) === DURATION_INNER_ID)).toBe(false);

    expect(h.containerWidgets.value_2).toBe(4);
    expect(h.containerWidgets.value_3).toBe(25);
    expect(h.serializeForQueue()).toEqual({ value_2: 4, value_3: 25 });

    const detail = parseJson(queried);
    const nodes = detail?.nodes as Array<Record<string, unknown>> | undefined;
    expect(nodes?.[0]).toMatchObject({
      id: CONTAINER_ID,
      widgets: { value_2: 4, value_3: 25 },
    });
  });

  it("writes fps/value_3 on the enclosing subgraph so root query and queue serialization receive 24", async () => {
    const { h, written, queried } = await runSetWidget("value_3", 24);

    expect(written.isError === true).toBe(false);
    expect(h.calls.map((call) => call.cmd)).not.toContain("graph_enter_subgraph");
    expect(h.inSubgraph).toBe(false);

    const writes = h.calls.filter((call) => call.cmd === "graph_set_widget");
    expect(writes).toEqual([
      expect.objectContaining({ node_id: CONTAINER_ID, widget: "value_3", value: 24 }),
    ]);
    expect(writes.some((call) => Number(call.node_id) === FPS_INNER_ID)).toBe(false);

    expect(h.containerWidgets).toEqual({ value_2: 5, value_3: 24 });
    expect(h.serializeForQueue()).toEqual({ value_2: 5, value_3: 24 });

    const detail = parseJson(queried);
    const nodes = detail?.nodes as Array<Record<string, unknown>> | undefined;
    expect(nodes?.[0]).toMatchObject({
      id: CONTAINER_ID,
      widgets: { value_2: 5, value_3: 24 },
    });
  });

  it("fails closed on the reported misroute: an inner link-driven write leaves the container at 5s/25fps", async () => {
    const h = harness();
    await h.b.send({
      cmd: "graph_set_widget",
      node_id: DURATION_INNER_ID,
      widget: "value",
      value: 4,
    });
    expect(h.innerWidgets[DURATION_INNER_ID]).toBe(4);
    expect(h.containerWidgets.value_2).toBe(5);
    expect(h.serializeForQueue().value_2).toBe(5);
  });
});
