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

// #2533 — remaining reports after #2500's PrimitiveInt value_2/value_3 path:
// a labelled PrimitiveString `value` (prompt) and MiniMax COMBO rails
// (unet_name/clip_name) still succeed on the link-driven inner while the
// enclosing subgraph widget stays at its initial serialized value.

const KREA_TAB = "wf:krea-turbo";
const KREA_CONTAINER_ID = 12;
const KREA_INNER_ID = 131;
const KREA_WORKFLOW_UUID = "workflow-krea-turbo";
const KREA_ROOT_GRAPH = "graph:workflow-krea-turbo-root";
const KREA_CHILD_GRAPH = "graph:workflow-krea-turbo-container-12";
const KREA_OLD_PROMPT = "a cat";
const KREA_NEW_PROMPT = "a red bicycle at dusk";
const MINIMAX_TAB = "wf:minimax-music";
const MINIMAX_CONTAINER_ID = 37;
const MINIMAX_UNET_INNER_ID = 6;
const MINIMAX_CLIP_INNER_ID = 8;
const MINIMAX_WORKFLOW_UUID = "workflow-minimax-music";
const MINIMAX_ROOT_GRAPH = "graph:workflow-minimax-music-root";
const MINIMAX_CHILD_GRAPH = "graph:workflow-minimax-music-container-37";
const MINIMAX_OLD_UNET = "music_fp16.safetensors";
const MINIMAX_NEW_UNET = "music_fp8.safetensors";
const MINIMAX_OLD_CLIP = "clip_fp16.safetensors";
const MINIMAX_NEW_CLIP = "clip_fp8.safetensors";

function linkDrivenWarning(widget: string): string {
  return (
    "The write SUCCEEDED and was verified, but it will NOT change the render: " +
    `widget ${widget} on inner node is link-driven from promoted input. ` +
    "Set the enclosing subgraph node instead. The container was not written."
  );
}

function promotedStringTerminal(hostWidget: string, innerWidget: string, innerNodeId: number) {
  return {
    widget: hostWidget,
    parent_rail: { authoritative: true, widget: hostWidget === "prompt" ? "value" : hostWidget },
    immediate_node_id: innerNodeId,
    immediate_widget: innerWidget,
    terminal_node_id: innerNodeId,
    terminal_node_type: "PrimitiveString",
    terminal_widget: innerWidget,
    terminal_inputs: [{ name: innerWidget, type: "STRING" }],
    chain_depth: 0,
  };
}

function kreaHarness() {
  const calls: Array<Record<string, unknown>> = [];
  const containerWidgets: Record<string, string> = { value: KREA_OLD_PROMPT };
  const innerWidgets: Record<string, string> = { value: KREA_OLD_PROMPT };
  let inSubgraph = false;
  let currentGraphIdentity = KREA_ROOT_GRAPH;
  const connectionIdentity = { generation: 1, tabSessionId: "browser-tab-krea" };
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
    workflowUuid: KREA_WORKFLOW_UUID,
    graphIdentity: KREA_ROOT_GRAPH,
  };

  const currentViewing = () => ({
    scope: inSubgraph ? "subgraph" : "root",
    ...(inSubgraph ? { owner_node_id: KREA_CONTAINER_ID } : {}),
    graph_identity: currentGraphIdentity,
    workflow_uuid: KREA_WORKFLOW_UUID,
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
      workflowUuid: KREA_WORKFLOW_UUID,
      graphIdentity: typeof identity.graph_identity === "string"
        ? identity.graph_identity
        : currentGraphIdentity,
    };
    return value;
  };

  const innerNode = {
    id: KREA_INNER_ID,
    type: "PrimitiveString",
    node_identity: `node-incarnation:test:${KREA_INNER_ID}`,
    widgets: { value: innerWidgets.value },
    inputs: [{ name: "value", type: "STRING" }],
  };

  const b = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push({ ...cmd });
      if (cmd.cmd === "graph_set_widget") {
        const nodeId = Number(cmd.node_id);
        const widget = String(cmd.widget);
        const value = String(cmd.value);
        if (nodeId === KREA_CONTAINER_ID && (widget === "value" || widget === "prompt")) {
          containerWidgets.value = value;
          if (widget === "prompt") containerWidgets.prompt = value;
          return { set: { node_id: nodeId, widget, previous: KREA_OLD_PROMPT, value } };
        }
        if (nodeId === KREA_INNER_ID && (widget === "value" || widget === "prompt")) {
          innerWidgets.value = value;
          return {
            set: { node_id: nodeId, widget, previous: KREA_OLD_PROMPT, value },
            warning: linkDrivenWarning(widget),
          };
        }
        throw new Error(`unexpected graph_set_widget ${nodeId} ${widget}`);
      }
      if (cmd.cmd === "graph_get_subgraph") {
        if (String(cmd.node_id) !== String(KREA_CONTAINER_ID)) {
          throw new Error(`Node ${cmd.node_id} (OrdinaryNode) is not a subgraph`);
        }
        return rememberViewing({
          subgraph_of: {
            node_id: KREA_CONTAINER_ID,
            title: "Text to Image (Krea-2 Turbo)",
            graph_identity: KREA_CHILD_GRAPH,
          },
          node_count: 1,
          nodes: [{ ...innerNode, widgets: { value: innerWidgets.value } }],
          promoted_terminals: [
            promotedStringTerminal("prompt", "value", KREA_INNER_ID),
          ],
          viewing: currentViewing(),
        });
      }
      if (cmd.cmd === "graph_enter_subgraph") {
        inSubgraph = true;
        currentGraphIdentity = KREA_CHILD_GRAPH;
        return { scope: "subgraph", node_id: cmd.node_id };
      }
      if (cmd.cmd === "graph_exit_subgraph") {
        inSubgraph = false;
        currentGraphIdentity = KREA_ROOT_GRAPH;
        return { scope: "root" };
      }
      if (cmd.cmd === "graph_query") {
        const wantId = Array.isArray(cmd.ids) && cmd.ids.length ? String(cmd.ids[0]) : null;
        if (inSubgraph && wantId === String(KREA_INNER_ID)) {
          return rememberViewing({
            nodes: [{ id: innerNode.id, type: innerNode.type, node_identity: innerNode.node_identity }],
            viewing: currentViewing(),
          });
        }
        return rememberViewing({
          nodes: [
            {
              id: KREA_CONTAINER_ID,
              type: "SubgraphNode",
              is_subgraph: true,
              node_identity: "node-incarnation:test:12",
              widgets: { ...containerWidgets },
            },
          ],
          viewing: currentViewing(),
        });
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: KREA_TAB, title: "krea", connected_at: 0 }],
    resolveActiveTabId: () => KREA_TAB,
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
    workflowUuidFor: () => ({ known: true, uuid: KREA_WORKFLOW_UUID }),
  } as PanelToolCtx["bridge"];

  return {
    b,
    calls,
    containerWidgets,
    innerWidgets,
    serializeForQueue: () => ({ value: containerWidgets.value }),
    viewing: () => observedPromotedScope,
    get inSubgraph() {
      return inSubgraph;
    },
  };
}

async function runKreaSetWidget(widget: "prompt" | "value") {
  const h = kreaHarness();
  const ctx = makePanelToolCtx(h.b, KREA_TAB, new WorkflowTargetStore());
  const setDef = buildPanelToolDefs().find((d) => d.name === "panel_set_widget");
  const queryDef = buildPanelToolDefs().find((d) => d.name === "panel_query_graph");
  if (!setDef || !queryDef) throw new Error("panel tools are not registered");
  const written: ToolResult = await setDef.handler(
    { node_id: KREA_CONTAINER_ID, widget, value: KREA_NEW_PROMPT } as never,
    ctx,
  );
  const queried: ToolResult = await queryDef.handler(
    { ids: [KREA_CONTAINER_ID], fields: "detail", limit: 1 } as never,
    ctx,
  );
  return { h, written, queried };
}

describe("panel_set_widget promoted STRING prompt/value (#2533)", () => {
  it.each(["prompt", "value"] as const)(
    "writes the enclosing subgraph when the caller addresses the labelled STRING as %s",
    async (widget) => {
      const { h, written, queried } = await runKreaSetWidget(widget);

      expect(written.isError === true).toBe(false);
      expect(textOf(written)).not.toMatch(/will NOT change the render|The container was not written/);
      expect(h.calls.map((call) => call.cmd)).not.toContain("graph_enter_subgraph");
      expect(h.inSubgraph).toBe(false);
      expect(h.viewing().scope).toBe("root");

      const writes = h.calls.filter((call) => call.cmd === "graph_set_widget");
      expect(writes).toHaveLength(1);
      expect(writes[0]).toEqual(
        expect.objectContaining({ node_id: KREA_CONTAINER_ID, value: KREA_NEW_PROMPT }),
      );
      expect(writes.some((call) => Number(call.node_id) === KREA_INNER_ID)).toBe(false);

      expect(h.serializeForQueue()).toEqual({ value: KREA_NEW_PROMPT });

      const detail = parseJson(queried);
      const nodes = detail?.nodes as Array<Record<string, unknown>> | undefined;
      expect(nodes?.[0]).toMatchObject({
        id: KREA_CONTAINER_ID,
        widgets: expect.objectContaining({ value: KREA_NEW_PROMPT }),
      });
    },
  );
});

function minimaxHarness() {
  const calls: Array<Record<string, unknown>> = [];
  const containerWidgets: Record<string, string> = {
    unet_name: MINIMAX_OLD_UNET,
    clip_name: MINIMAX_OLD_CLIP,
  };
  const innerWidgets: Record<number, Record<string, string>> = {
    [MINIMAX_UNET_INNER_ID]: { unet_name: MINIMAX_OLD_UNET },
    [MINIMAX_CLIP_INNER_ID]: { clip_name: MINIMAX_OLD_CLIP },
  };
  let inSubgraph = false;
  let currentGraphIdentity = MINIMAX_ROOT_GRAPH;
  const connectionIdentity = { generation: 1, tabSessionId: "browser-tab-minimax" };
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
    workflowUuid: MINIMAX_WORKFLOW_UUID,
    graphIdentity: MINIMAX_ROOT_GRAPH,
  };

  const currentViewing = () => ({
    scope: inSubgraph ? "subgraph" : "root",
    ...(inSubgraph ? { owner_node_id: MINIMAX_CONTAINER_ID } : {}),
    graph_identity: currentGraphIdentity,
    workflow_uuid: MINIMAX_WORKFLOW_UUID,
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
      workflowUuid: MINIMAX_WORKFLOW_UUID,
      graphIdentity: typeof identity.graph_identity === "string"
        ? identity.graph_identity
        : currentGraphIdentity,
    };
    return value;
  };

  const innerNodes = [
    {
      id: MINIMAX_UNET_INNER_ID,
      type: "UNETLoader",
      node_identity: `node-incarnation:test:${MINIMAX_UNET_INNER_ID}`,
      widgets: { unet_name: MINIMAX_OLD_UNET, weight_dtype: "default" },
      inputs: [
        { name: "unet_name", type: "COMBO" },
        { name: "weight_dtype", type: "COMBO" },
      ],
    },
    {
      id: MINIMAX_CLIP_INNER_ID,
      type: "CLIPLoader",
      node_identity: `node-incarnation:test:${MINIMAX_CLIP_INNER_ID}`,
      widgets: { clip_name: MINIMAX_OLD_CLIP, type: "stable_diffusion" },
      inputs: [
        { name: "clip_name", type: "COMBO" },
        { name: "type", type: "COMBO" },
      ],
    },
  ];

  const b = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push({ ...cmd });
      if (cmd.cmd === "graph_set_widget") {
        const nodeId = Number(cmd.node_id);
        const widget = String(cmd.widget);
        const value = String(cmd.value);
        if (nodeId === MINIMAX_CONTAINER_ID && (widget === "unet_name" || widget === "clip_name")) {
          const previous = containerWidgets[widget];
          containerWidgets[widget] = value;
          return { set: { node_id: nodeId, widget, previous, value } };
        }
        if (nodeId === MINIMAX_UNET_INNER_ID && widget === "unet_name") {
          innerWidgets[nodeId].unet_name = value;
          return {
            set: { node_id: nodeId, widget, previous: MINIMAX_OLD_UNET, value },
            warning: linkDrivenWarning(widget),
          };
        }
        if (nodeId === MINIMAX_CLIP_INNER_ID && widget === "clip_name") {
          innerWidgets[nodeId].clip_name = value;
          return {
            set: { node_id: nodeId, widget, previous: MINIMAX_OLD_CLIP, value },
            warning: linkDrivenWarning(widget),
          };
        }
        throw new Error(`unexpected graph_set_widget ${nodeId} ${widget}`);
      }
      if (cmd.cmd === "graph_get_subgraph") {
        if (String(cmd.node_id) !== String(MINIMAX_CONTAINER_ID)) {
          throw new Error(`Node ${cmd.node_id} (OrdinaryNode) is not a subgraph`);
        }
        return rememberViewing({
          subgraph_of: {
            node_id: MINIMAX_CONTAINER_ID,
            title: "audio_minimax_music_3",
            graph_identity: MINIMAX_CHILD_GRAPH,
          },
          node_count: innerNodes.length,
          nodes: innerNodes.map((node) => ({
            ...node,
            widgets: { ...node.widgets, ...innerWidgets[node.id] },
          })),
          promoted_terminals: [
            {
              widget: "unet_name",
              parent_rail: { authoritative: true, widget: "unet_name" },
              immediate_node_id: MINIMAX_UNET_INNER_ID,
              immediate_widget: "unet_name",
              terminal_node_id: MINIMAX_UNET_INNER_ID,
              terminal_node_type: "UNETLoader",
              terminal_widget: "unet_name",
              terminal_inputs: [
                { name: "unet_name", type: "COMBO" },
                { name: "weight_dtype", type: "COMBO" },
              ],
              chain_depth: 0,
            },
            {
              widget: "clip_name",
              parent_rail: { authoritative: true, widget: "clip_name" },
              immediate_node_id: MINIMAX_CLIP_INNER_ID,
              immediate_widget: "clip_name",
              terminal_node_id: MINIMAX_CLIP_INNER_ID,
              terminal_node_type: "CLIPLoader",
              terminal_widget: "clip_name",
              terminal_inputs: [
                { name: "clip_name", type: "COMBO" },
                { name: "type", type: "COMBO" },
              ],
              chain_depth: 0,
            },
          ],
          viewing: currentViewing(),
        });
      }
      if (cmd.cmd === "graph_enter_subgraph") {
        inSubgraph = true;
        currentGraphIdentity = MINIMAX_CHILD_GRAPH;
        return { scope: "subgraph", node_id: cmd.node_id };
      }
      if (cmd.cmd === "graph_exit_subgraph") {
        inSubgraph = false;
        currentGraphIdentity = MINIMAX_ROOT_GRAPH;
        return { scope: "root" };
      }
      if (cmd.cmd === "graph_query") {
        const wantId = Array.isArray(cmd.ids) && cmd.ids.length ? String(cmd.ids[0]) : null;
        if (inSubgraph && wantId) {
          const node = innerNodes.find((candidate) => String(candidate.id) === wantId);
          if (node) {
            return rememberViewing({
              nodes: [{ id: node.id, type: node.type, node_identity: node.node_identity }],
              viewing: currentViewing(),
            });
          }
        }
        return rememberViewing({
          nodes: [
            {
              id: MINIMAX_CONTAINER_ID,
              type: "SubgraphNode",
              is_subgraph: true,
              node_identity: "node-incarnation:test:37",
              widgets: { ...containerWidgets },
            },
          ],
          viewing: currentViewing(),
        });
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: MINIMAX_TAB, title: "minimax", connected_at: 0 }],
    resolveActiveTabId: () => MINIMAX_TAB,
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
    workflowUuidFor: () => ({ known: true, uuid: MINIMAX_WORKFLOW_UUID }),
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

async function runMinimaxSetWidget(widget: "unet_name" | "clip_name", value: string) {
  const h = minimaxHarness();
  const ctx = makePanelToolCtx(h.b, MINIMAX_TAB, new WorkflowTargetStore());
  const setDef = buildPanelToolDefs().find((d) => d.name === "panel_set_widget");
  const queryDef = buildPanelToolDefs().find((d) => d.name === "panel_query_graph");
  if (!setDef || !queryDef) throw new Error("panel tools are not registered");
  const written: ToolResult = await setDef.handler(
    { node_id: MINIMAX_CONTAINER_ID, widget, value } as never,
    ctx,
  );
  const queried: ToolResult = await queryDef.handler(
    { ids: [MINIMAX_CONTAINER_ID], fields: "detail", limit: 1 } as never,
    ctx,
  );
  return { h, written, queried };
}

describe("panel_set_widget promoted unet_name/clip_name (#2533)", () => {
  it("writes unet_name on the enclosing MiniMax container so queue serialization leaves the fp16 default", async () => {
    const { h, written, queried } = await runMinimaxSetWidget("unet_name", MINIMAX_NEW_UNET);

    expect(written.isError === true).toBe(false);
    expect(textOf(written)).not.toMatch(/will NOT change the render|The container was not written/);
    expect(h.calls.map((call) => call.cmd)).not.toContain("graph_enter_subgraph");
    expect(h.inSubgraph).toBe(false);
    expect(h.viewing().scope).toBe("root");

    const writes = h.calls.filter((call) => call.cmd === "graph_set_widget");
    expect(writes).toEqual([
      expect.objectContaining({
        node_id: MINIMAX_CONTAINER_ID,
        widget: "unet_name",
        value: MINIMAX_NEW_UNET,
      }),
    ]);
    expect(writes.some((call) => Number(call.node_id) === MINIMAX_UNET_INNER_ID)).toBe(false);

    expect(h.containerWidgets.unet_name).toBe(MINIMAX_NEW_UNET);
    expect(h.containerWidgets.clip_name).toBe(MINIMAX_OLD_CLIP);
    expect(h.serializeForQueue()).toEqual({
      unet_name: MINIMAX_NEW_UNET,
      clip_name: MINIMAX_OLD_CLIP,
    });

    const detail = parseJson(queried);
    const nodes = detail?.nodes as Array<Record<string, unknown>> | undefined;
    expect(nodes?.[0]).toMatchObject({
      id: MINIMAX_CONTAINER_ID,
      widgets: { unet_name: MINIMAX_NEW_UNET, clip_name: MINIMAX_OLD_CLIP },
    });
  });

  it("writes clip_name on the enclosing MiniMax container so the parent rail is not left at the fp16 clip", async () => {
    const { h, written, queried } = await runMinimaxSetWidget("clip_name", MINIMAX_NEW_CLIP);

    expect(written.isError === true).toBe(false);
    expect(h.calls.map((call) => call.cmd)).not.toContain("graph_enter_subgraph");
    expect(h.inSubgraph).toBe(false);

    const writes = h.calls.filter((call) => call.cmd === "graph_set_widget");
    expect(writes).toEqual([
      expect.objectContaining({
        node_id: MINIMAX_CONTAINER_ID,
        widget: "clip_name",
        value: MINIMAX_NEW_CLIP,
      }),
    ]);
    expect(writes.some((call) => Number(call.node_id) === MINIMAX_CLIP_INNER_ID)).toBe(false);

    expect(h.containerWidgets).toEqual({
      unet_name: MINIMAX_OLD_UNET,
      clip_name: MINIMAX_NEW_CLIP,
    });
    expect(h.serializeForQueue()).toEqual({
      unet_name: MINIMAX_OLD_UNET,
      clip_name: MINIMAX_NEW_CLIP,
    });

    const detail = parseJson(queried);
    const nodes = detail?.nodes as Array<Record<string, unknown>> | undefined;
    expect(nodes?.[0]).toMatchObject({
      id: MINIMAX_CONTAINER_ID,
      widgets: { unet_name: MINIMAX_OLD_UNET, clip_name: MINIMAX_NEW_CLIP },
    });
  });

  it("fails closed on the reported misroute: an inner UNETLoader write leaves container unet_name at fp16", async () => {
    const h = minimaxHarness();
    await h.b.send({
      cmd: "graph_set_widget",
      node_id: MINIMAX_UNET_INNER_ID,
      widget: "unet_name",
      value: MINIMAX_NEW_UNET,
    });
    expect(h.innerWidgets[MINIMAX_UNET_INNER_ID].unet_name).toBe(MINIMAX_NEW_UNET);
    expect(h.containerWidgets.unet_name).toBe(MINIMAX_OLD_UNET);
    expect(h.serializeForQueue().unet_name).toBe(MINIMAX_OLD_UNET);
  });
});
