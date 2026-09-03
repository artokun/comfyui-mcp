// #2518 — after a root panel_query_graph, panel_set_widget must not classify a
// root StringConcatenate widget as promoted. Rebind mode current must clear
// stale subgraph/promoted identity so a retry is not stuck on the same path.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import {
  clearRememberedViewingScope,
  noteConfirmedViewing,
  rememberedSubgraphOwner,
  rememberedViewingScope,
} from "../../services/subgraph-viewing-scope.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const SRC = readFileSync(
  fileURLToPath(new URL("../../orchestrator/panel-tools.ts", import.meta.url)),
  "utf8",
);

const TAB = "wf:2518-root-concat";
const NODE_ID = 53;
const ROOT_GRAPH_IDENTITY = "graph:2518-root";
const WORKFLOW_UUID = "25180000-0000-4000-8000-000000000000";

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} not found`);
  return def;
}

function textOf(result: ToolResult): string {
  return result.content.map((block) => (block as { text?: string }).text ?? "").join(" ");
}

afterEach(() => {
  clearRememberedViewingScope();
});

function rootViewing(scope: "root" | "subgraph" = "root") {
  return scope === "root"
    ? {
        scope: "root" as const,
        workflow_uuid: WORKFLOW_UUID,
        graph_identity: ROOT_GRAPH_IDENTITY,
      }
    : {
        scope: "subgraph" as const,
        owner_node_id: 12,
        workflow_uuid: WORKFLOW_UUID,
        graph_identity: "graph:2518-stale-subgraph",
      };
}

function makeRootSequenceBridge() {
  const calls: Array<Record<string, unknown>> = [];
  let writes = 0;
  let currentScope: {
    known: true;
    scope: "root" | "subgraph";
    ownerNodeId: string | null;
    workflowUuid: string;
    graphIdentity: string;
  } = {
    known: true,
    scope: "subgraph",
    ownerNodeId: "12",
    workflowUuid: WORKFLOW_UUID,
    graphIdentity: "graph:2518-stale-subgraph",
  };

  const applyRootScope = () => {
    currentScope = {
      known: true,
      scope: "root",
      ownerNodeId: null,
      workflowUuid: WORKFLOW_UUID,
      graphIdentity: ROOT_GRAPH_IDENTITY,
    };
  };

  const bridge = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push({ ...cmd });
      if (cmd.cmd === "graph_query") {
        applyRootScope();
        const wantId = Array.isArray(cmd.ids) && cmd.ids.length ? String(cmd.ids[0]) : null;
        const concatNode = {
          id: NODE_ID,
          type: "StringConcatenate",
          is_subgraph: false,
          widgets: { string_a: "old", string_b: "world", delimiter: "," },
        };
        if (wantId === String(NODE_ID) || cmd.fields === "detail") {
          return {
            viewing: rootViewing("root"),
            truncated: true,
            nodes: [concatNode],
          };
        }
        return {
          viewing: rootViewing("root"),
          truncated: false,
          nodes: [concatNode, { id: 9, type: "SaveImage", widgets: { filename_prefix: "ComfyUI" } }],
        };
      }
      if (cmd.cmd === "graph_disconnect") {
        return { disconnected: { node_id: cmd.node_id, input: cmd.input } };
      }
      if (cmd.cmd === "graph_connect") {
        return {
          connected: {
            from_node_id: cmd.from_node_id,
            to_node_id: cmd.to_node_id,
            to_input: cmd.to_input,
          },
        };
      }
      if (cmd.cmd === "graph_get_subgraph") {
        throw new Error("stale subgraph identity must not be consulted on a root-scope write");
      }
      if (cmd.cmd === "graph_set_widget") {
        writes += 1;
        return {
          set: { node_id: cmd.node_id, widget: cmd.widget, previous: "old", value: cmd.value },
        };
      }
      if (cmd.cmd === "workflow_list") {
        const active = {
          path: "workflows/2518.json",
          routing_key: TAB,
          workflow_uuid: WORKFLOW_UUID,
        };
        return { active, workflows: [active] };
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
    tabConnectionIdentity: () => undefined,
    promotedScopeFor: () => currentScope,
    clearPromotedSubgraphIdentity: (tabId: string) => {
      if (tabId === TAB && currentScope.scope === "subgraph") {
        currentScope = {
          known: true,
          scope: "root",
          ownerNodeId: null,
          workflowUuid: WORKFLOW_UUID,
          graphIdentity: ROOT_GRAPH_IDENTITY,
        };
      }
    },
    applyLiveRootViewing: (tabId: string) => {
      if (tabId === TAB) applyRootScope();
    },
    tabExpectedNodeTypeFenceCapability: () => true,
    tabExpectedNodeIdentityFenceCapability: () => true,
    tabExpectedScopeGraphIdentityFenceCapability: () => true,
    tabPromotedTerminalWitnessCapability: () => true,
    tabPromotedParentRailFenceCapability: () => true,
    tabReceiverResolvable: () => true,
    workflowUuidFor: () => ({ known: true, uuid: WORKFLOW_UUID }),
    refreshWorkflowUuid: () => true,
    corroborateTabStamp: () => true,
  } as PanelToolCtx["bridge"];

  return {
    bridge,
    calls,
    get writes() {
      return writes;
    },
    get currentScope() {
      return currentScope;
    },
  };
}

describe("root widget promoted misclassification (#2518)", () => {
  it("handlers apply a live root viewing and clear stale subgraph identity on current rebind", () => {
    expect(SRC).toMatch(/applyLiveRootViewing\(/);
    expect(SRC).toMatch(/clearStaleSubgraphIdentity\(/);
    expect(SRC).toMatch(/clearPromotedSubgraphIdentity/);
  });

  it("THE REPORTED CASE: root detail query, disconnect/connect, then set_widget on StringConcatenate", async () => {
    noteConfirmedViewing(TAB, { viewing: rootViewing("subgraph") });
    expect(rememberedSubgraphOwner(TAB)).toBe("12");

    const harness = makeRootSequenceBridge();
    const ctx = makePanelToolCtx(harness.bridge, TAB, new WorkflowTargetStore());

    const queried = await defByName("panel_query_graph").handler(
      { fields: "detail", max_chars: 4000 },
      ctx,
    );
    expect(queried.isError).toBeFalsy();
    expect(rememberedViewingScope(TAB)?.scope).toBe("root");

    const disconnected = await defByName("panel_disconnect").handler(
      { node_id: NODE_ID, input: "string_b" },
      ctx,
    );
    expect(disconnected.isError).toBeFalsy();

    const connected = await defByName("panel_connect").handler(
      { from_node_id: 9, from_output: 0, to_node_id: NODE_ID, to_input: "string_b" },
      ctx,
    );
    expect(connected.isError).toBeFalsy();

    const written = await defByName("panel_set_widget").handler(
      { node_id: NODE_ID, widget: "string_a", value: "hello" },
      ctx,
    );
    expect(written.isError).toBeFalsy();
    expect(textOf(written)).not.toMatch(/refused the promoted/);
    expect(harness.calls.filter((call) => call.cmd === "graph_get_subgraph")).toHaveLength(0);
    expect(harness.calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({ node_id: NODE_ID, widget: "string_a", value: "hello" }),
    ]);
    expect(harness.writes).toBe(1);
    expect(rememberedSubgraphOwner(TAB)).toBeNull();
  });

  it("a successful mode:current rebind clears stale subgraph identity so a retry is not stuck", async () => {
    noteConfirmedViewing(TAB, { viewing: rootViewing("subgraph") });
    expect(rememberedSubgraphOwner(TAB)).toBe("12");

    const harness = makeRootSequenceBridge();
    const ctx = makePanelToolCtx(harness.bridge, TAB, new WorkflowTargetStore());
    const rebound = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    expect(rebound.isError).toBeFalsy();
    expect(rememberedSubgraphOwner(TAB)).toBeNull();
    expect(harness.currentScope.scope).toBe("root");

    const written = await defByName("panel_set_widget").handler(
      { node_id: NODE_ID, widget: "delimiter", value: " | " },
      ctx,
    );
    expect(written.isError).toBeFalsy();
    expect(harness.calls.filter((call) => call.cmd === "graph_get_subgraph")).toHaveLength(0);
    expect(harness.writes).toBe(1);
  });
});
