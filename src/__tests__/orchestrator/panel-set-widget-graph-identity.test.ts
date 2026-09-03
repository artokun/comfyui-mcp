// #2550 — panel_set_widget must not turn a scope read from one graph object
// into a success envelope for a graph object that appeared after reconnect.
//
// This drives the shipped tool definition and makePanelToolCtx through the
// production beforeDispatch seam. The command/response shapes are the live
// panel protocol: graph_query publishes viewing.graph_identity and the panel
// accepts expected_node_type / expected_node_identity on graph_set_widget.

import { describe, expect, it } from "vitest";
import {
  markDispatched,
  type TabPromotedScopeRead,
  type TabWorkflowUuidRead,
} from "../../services/ui-bridge.js";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/identity-fence.json";
const WORKFLOW_UUID = "25500000-0000-4000-8000-000000000000";
const NODE_ID = 7;
const NODE_TYPE = "PrimitiveFloat";
const NODE_IDENTITY = "node:7:original";

type Mode = "stable" | "stale-before-dispatch" | "unknown-after-dispatch";

function textOf(result: ToolResult): string {
  return result.content.map((block) => (block as { text?: string }).text ?? "").join(" ");
}

function setWidgetDef() {
  const definition = buildPanelToolDefs().find((candidate) => candidate.name === "panel_set_widget");
  if (!definition) throw new Error("panel_set_widget is not registered");
  return definition;
}

function makeBridge(mode: Mode): {
  bridge: PanelToolCtx["bridge"];
  calls: Array<Record<string, unknown>>;
  dispatchedWrites: number;
} {
  const calls: Array<Record<string, unknown>> = [];
  let graphIdentity = "graph:root-before-reconnect";
  let currentScope: Extract<TabPromotedScopeRead, { known: true }> = {
    known: true,
    scope: "root",
    ownerNodeId: null,
    workflowUuid: WORKFLOW_UUID,
    graphIdentity,
  };
  let connectionIdentity = { generation: 1, tabSessionId: "browser-tab-2550" };
  let dispatchedWrites = 0;

  const bridgeShape = {
    send: async (
      command: Record<string, unknown>,
      options?: { beforeDispatch?: () => void },
    ) => {
      calls.push({ ...command });
      if (command.cmd === "graph_query") {
        return {
          viewing: {
            scope: "root",
            kind: "root",
            workflow: "identity-fence.json",
            workflow_uuid: WORKFLOW_UUID,
            graph_identity: graphIdentity,
          },
          truncated: false,
          nodes: [
            {
              id: NODE_ID,
              type: NODE_TYPE,
              is_subgraph: false,
              node_identity: NODE_IDENTITY,
              widgets: { value: 0.5 },
            },
          ],
          node_count: 1,
        };
      }
      if (command.cmd === "graph_set_widget") {
        if (mode === "stale-before-dispatch") {
          // A same-workflow rebind replaces the graph object while the
          // connection tuple remains readable. This isolates the graph fence
          // from the separate tab/connection fence.
          graphIdentity = "graph:root-after-reconnect";
          currentScope = { ...currentScope, graphIdentity };
        }
        options?.beforeDispatch?.();
        dispatchedWrites += 1;
        if (mode === "unknown-after-dispatch") {
          throw markDispatched(
            new Error(
              `Panel tab ${TAB} disconnected mid-command ("graph_set_widget") — ` +
                `OUTCOME UNKNOWN: the command was already sent, so the panel may have applied it.`,
            ),
            true,
          );
        }
        return {
          set: {
            node_id: command.node_id,
            widget: command.widget,
            previous: 0.5,
            value: command.value,
          },
        };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB }],
    resolveActiveTabId: () => TAB,
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    tabConnectionIdentity: () => connectionIdentity,
    promotedScopeFor: () => currentScope,
    tabExpectedNodeTypeFenceCapability: () => true,
    tabExpectedNodeIdentityFenceCapability: () => true,
    tabExpectedScopeGraphIdentityFenceCapability: () => true,
    tabPromotedTerminalWitnessCapability: () => true,
    tabPromotedParentRailFenceCapability: () => true,
    tabReceiverResolvable: () => true,
    workflowUuidFor: (): TabWorkflowUuidRead => ({ known: true, uuid: WORKFLOW_UUID }),
  } as Partial<PanelToolCtx["bridge"]>;
  const bridge = bridgeShape as PanelToolCtx["bridge"];

  return { bridge, calls, get dispatchedWrites() { return dispatchedWrites; } };
}

async function run(mode: Mode) {
  const harness = makeBridge(mode);
  const ctx = makePanelToolCtx(harness.bridge, TAB, new WorkflowTargetStore());
  const result = await setWidgetDef().handler(
    { node_id: NODE_ID, widget: "value", value: 0.75 } as never,
    ctx,
  );
  return { ...harness, result, text: textOf(result) };
}

describe("panel_set_widget graph identity fence (#2550)", () => {
  it("refuses a reconnect-stale graph before dispatch and names the rebind remedy", async () => {
    const { result, text, calls, dispatchedWrites } = await run("stale-before-dispatch");

    expect(result.isError).toBe(true);
    expect(text).toMatch(/current graph identity changed/);
    expect(text).toMatch(/No graph_set_widget was dispatched/);
    expect(text).toMatch(/panel_set_workflow_target\(\{mode:"current"\}\)/);
    expect(calls.filter((command) => command.cmd === "graph_set_widget")).toHaveLength(1);
    expect(dispatchedWrites).toBe(0);
  });

  it("returns the normal success envelope when the current graph identity still matches", async () => {
    const { result, text, calls, dispatchedWrites } = await run("stable");

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text)).toMatchObject({
      set: { node_id: NODE_ID, widget: "value", value: 0.75 },
    });
    expect(calls.filter((command) => command.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({
        node_id: NODE_ID,
        expected_node_type: NODE_TYPE,
        expected_node_identity: NODE_IDENTITY,
      }),
    ]);
    expect(dispatchedWrites).toBe(1);
  });

  it("preserves the post-dispatch unknown outcome instead of returning a success envelope", async () => {
    const { result, text, dispatchedWrites } = await run("unknown-after-dispatch");

    expect(result.isError).toBe(true);
    expect(text).toMatch(/OUTCOME UNKNOWN/);
    expect(text).toMatch(/may have applied/);
    expect(() => JSON.parse(text)).toThrow();
    expect(dispatchedWrites).toBe(1);
  });
});
