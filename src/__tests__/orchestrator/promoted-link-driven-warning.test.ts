// #2514 — panel_set_widget on an enclosing subgraph's promoted noise_seed
// succeeds, but the remapped inner write is link-driven from that parent rail.
// The panel's #1087 warning then says the write will NOT change the render and
// to set the widget on the ENCLOSING subgraph node — which is what was called.
//
// The parent promotion is authoritative for a root-scope remapped write.
// The inner warning is only for a caller who targeted the inner node directly.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import {
  isInnerLinkDrivenWriteWarning,
  shapeParentAuthoritativePromotedWrite,
} from "../../orchestrator/promoted-widget.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:noise-seed";
const CONTAINER_ID = 42;
const INNER_ID = 13;
const WORKFLOW_UUID = "workflow-noise";
const ROOT_GRAPH = "graph:workflow-noise-root";
const CHILD_GRAPH = "graph:workflow-noise-container-42";
const SEED = 12345;

const LINK_DRIVEN_WARNING =
  `The write SUCCEEDED and was verified, but it will NOT change the render: widget ` +
  `"noise_seed" on node ${INNER_ID} is link-driven from promoted input, so the value arriving ` +
  `on that link is what serializes at queue time and this stored value is ignored. When ` +
  `the link comes from a promoted subgraph input, set the widget on the ENCLOSING ` +
  `subgraph node instead (panel_exit_subgraph, then panel_set_widget there) — that path ` +
  `syncs both and reports parent_widget_synced.`;

const CONTROL_AFTER_GENERATE_WARNING =
  `control_after_generate='randomize' governs widget "noise_seed" on node ${INNER_ID}: ` +
  `ComfyUI automatically CHANGES this value on subsequent runs (a new random value each run), ` +
  `so the value you set will NOT persist. Set "control_after_generate" to 'fixed' to hold it.`;

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
    // The handler may append a disclosure after the JSON payload.
    const end = text.lastIndexOf("}");
    if (end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function harness(opts: { viewingInnerAtRoot?: boolean } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const containerWidgets: Record<string, number> = { noise_seed: 1 };
  const innerWidgets: Record<string, number> = { noise_seed: 1 };
  let inSubgraph = false;
  let currentGraphIdentity = ROOT_GRAPH;
  const connectionIdentity = { generation: 1, tabSessionId: "browser-tab-noise" };
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
      graphIdentity:
        typeof identity.graph_identity === "string" ? identity.graph_identity : currentGraphIdentity,
    };
    return value;
  };

  const innerNode = {
    id: INNER_ID,
    type: "RandomNoise",
    node_identity: `node-incarnation:test:${INNER_ID}`,
    widgets: { noise_seed: innerWidgets.noise_seed },
    inputs: [{ name: "noise_seed", type: "INT" }],
  };

  const subgraphEnvelope = () =>
    rememberViewing({
      subgraph_of: {
        node_id: CONTAINER_ID,
        title: "KSampler subgraph",
        graph_identity: CHILD_GRAPH,
      },
      node_count: 1,
      nodes: [{ ...innerNode, widgets: { noise_seed: innerWidgets.noise_seed } }],
      promoted_terminals: [
        {
          widget: "noise_seed",
          parent_rail: { authoritative: true, widget: "noise_seed" },
          immediate_node_id: INNER_ID,
          immediate_widget: "noise_seed",
          terminal_node_id: INNER_ID,
          terminal_node_type: "RandomNoise",
          terminal_widget: "noise_seed",
          terminal_inputs: [{ name: "noise_seed", type: "INT" }],
          chain_depth: 0,
        },
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

  const innerRootDetail = () =>
    rememberViewing({
      nodes: [
        {
          id: INNER_ID,
          type: "RandomNoise",
          is_subgraph: false,
          node_identity: `node-incarnation:test:${INNER_ID}`,
          widgets: { noise_seed: innerWidgets.noise_seed },
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
        if (nodeId === CONTAINER_ID && widget === "noise_seed") {
          const previous = containerWidgets.noise_seed;
          containerWidgets.noise_seed = Number(value);
          return {
            set: {
              node_id: nodeId,
              widget,
              previous,
              value: containerWidgets.noise_seed,
            },
            promoted_from: {
              inner_node_id: INNER_ID,
              parent_widget_synced: true,
              value_scope: "instance",
            },
          };
        }
        if (nodeId === INNER_ID && widget === "noise_seed") {
          innerWidgets.noise_seed = Number(value);
          return {
            set: { node_id: nodeId, widget, previous: 1, value },
            warning: LINK_DRIVEN_WARNING,
          };
        }
        throw new Error(`unexpected graph_set_widget ${nodeId} ${widget}`);
      }
      if (cmd.cmd === "graph_get_subgraph") {
        if (String(cmd.node_id) !== String(CONTAINER_ID)) {
          throw new Error(`Node ${cmd.node_id} (RandomNoise) is not a subgraph`);
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
        if (inSubgraph && wantId === String(INNER_ID)) {
          return rememberViewing({
            nodes: [
              {
                id: INNER_ID,
                type: "RandomNoise",
                node_identity: `node-incarnation:test:${INNER_ID}`,
              },
            ],
            viewing: currentViewing(),
          });
        }
        if (wantId === String(INNER_ID) || opts.viewingInnerAtRoot) {
          return innerRootDetail();
        }
        return containerDetail();
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "noise", connected_at: 0 }],
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
    viewing: () => observedPromotedScope,
  };
}

async function runSetWidget(nodeId: number, h = harness()) {
  const ctx = makePanelToolCtx(h.b, TAB, new WorkflowTargetStore());
  const setDef = buildPanelToolDefs().find((d) => d.name === "panel_set_widget");
  const queryDef = buildPanelToolDefs().find((d) => d.name === "panel_query_graph");
  if (!setDef || !queryDef) throw new Error("panel tools are not registered");
  const written: ToolResult = await setDef.handler(
    { node_id: nodeId, widget: "noise_seed", value: SEED } as never,
    ctx,
  );
  const queried: ToolResult = await queryDef.handler(
    { ids: [CONTAINER_ID], fields: "detail", limit: 1 } as never,
    ctx,
  );
  return { h, written, queried, text: textOf(written), payload: parseJson(written) };
}

describe("isInnerLinkDrivenWriteWarning (#2514)", () => {
  it("detects the panel's parent-rail #1087 warning", () => {
    expect(isInnerLinkDrivenWriteWarning(LINK_DRIVEN_WARNING)).toBe(true);
  });

  it("does not treat control_after_generate persist advice as that warning", () => {
    expect(isInnerLinkDrivenWriteWarning(CONTROL_AFTER_GENERATE_WARNING)).toBe(false);
  });
});

describe("shapeParentAuthoritativePromotedWrite (#2514)", () => {
  it("strips the inner warning and reports the parent-facing widget as synced", () => {
    const shaped = shapeParentAuthoritativePromotedWrite(
      {
        set: { node_id: INNER_ID, widget: "noise_seed", previous: 1, value: SEED },
        warning: LINK_DRIVEN_WARNING,
      },
      { nodeId: CONTAINER_ID, widget: "noise_seed", synced: true },
    );
    expect(shaped.warning).toBeUndefined();
    expect(shaped.parent_widget_synced).toBe(true);
    expect(shaped.set).toMatchObject({
      node_id: CONTAINER_ID,
      widget: "noise_seed",
      value: SEED,
    });
  });

  it("leaves an unrelated warning in place when the parent was not synced", () => {
    const shaped = shapeParentAuthoritativePromotedWrite(
      {
        set: { node_id: INNER_ID, widget: "noise_seed", value: SEED },
        warning: CONTROL_AFTER_GENERATE_WARNING,
      },
      { nodeId: CONTAINER_ID, widget: "noise_seed", synced: false },
    );
    expect(shaped.warning).toBe(CONTROL_AFTER_GENERATE_WARNING);
    expect(shaped.parent_widget_synced).toBeUndefined();
    expect(shaped.set).toMatchObject({ node_id: INNER_ID, widget: "noise_seed" });
  });
});

describe("panel_set_widget root-scope promoted link-driven warning (#2514)", () => {
  it("does not reuse the inner link-driven warning after writing the enclosing subgraph", async () => {
    const { h, text, payload, written } = await runSetWidget(CONTAINER_ID);
    expect(written.isError === true).toBe(false);
    expect(text).not.toMatch(/will NOT change the render/);
    expect(text).not.toMatch(/ENCLOSING subgraph/);
    expect(text).not.toMatch(/container was not written/);
    expect(payload?.parent_widget_synced).toBe(true);
    expect(payload?.warning).toBeUndefined();
    expect(payload?.set).toMatchObject({
      node_id: CONTAINER_ID,
      widget: "noise_seed",
      value: SEED,
    });
    expect(h.containerWidgets.noise_seed).toBe(SEED);
    expect(h.viewing().scope).toBe("root");
  });

  it("keeps the inner warning when the caller targeted the inner node directly", async () => {
    const { text, payload, written } = await runSetWidget(INNER_ID, harness({ viewingInnerAtRoot: true }));
    expect(written.isError === true).toBe(false);
    expect(text).toMatch(/will NOT change the render/);
    expect(text).toMatch(/ENCLOSING subgraph/);
    expect(payload?.parent_widget_synced).not.toBe(true);
    expect(payload?.warning).toMatch(/link-driven/);
    expect(payload?.set).toMatchObject({
      node_id: INNER_ID,
      widget: "noise_seed",
      value: SEED,
    });
  });
});
