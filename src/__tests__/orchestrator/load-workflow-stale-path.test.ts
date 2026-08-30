// #2505 — panel_load_workflow loaded saved workflow B into active tab A but kept
// extra.comfyui_mcp.workflow_path from B. A later in-place panel_save_workflow
// (no name) was refused by the #1667 stale-canvas guard because the canvas was
// stamped as belonging to B.
//
// Tests drive bindLoadedWorkflowIdentity and the shipped load/save path. Dest
// identity is the ACTIVE tab (A), never the source file's stamp. #2503 owns tmp
// uuid rebinding and is not re-tested here.

import { describe, expect, it } from "vitest";

import {
  bindLoadedWorkflowIdentity,
  extraWorkflowPath,
  extraWorkflowUuid,
  savedPathFromTabId,
} from "../../orchestrator/open-identity-normalization.js";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

const SOURCE_PATH = "workflows/B.app.json";
const DEST_PATH = "workflows/A.app.json";
const SOURCE_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DEST_UUID = "11111111-2222-4333-8444-555555555555";
const TAB = `wf:tabA:${DEST_PATH}`;

const SOURCE_GRAPH = {
  last_node_id: 2,
  nodes: [
    { id: 1, type: "CLIPTextEncode", widgets_values: ["from B"] },
    { id: 2, type: "SaveImage", widgets_values: ["out"] },
  ],
  links: [],
  extra: { comfyui_mcp: { workflow_path: SOURCE_PATH, workflow_uuid: SOURCE_UUID } },
};

const STAMP_REFUSAL =
  `REFUSED to save: the canvas about to overwrite "${DEST_PATH}" is stamped as belonging to ` +
  `"${SOURCE_PATH}" (extra.comfyui_mcp.workflow_path), which is a different workflow that still ` +
  `exists. Writing it would replace that file's content with a graph that does not belong to it.`;

const textOf = (res: ToolResult): string =>
  res.content.map((part) => (part as { text?: string }).text ?? "").join(" ");

function loadTool() {
  const tool = buildPanelToolDefs().find((def) => def.name === "panel_load_workflow");
  if (!tool) throw new Error("panel_load_workflow is not registered");
  return tool;
}

function saveTool() {
  const tool = buildPanelToolDefs().find((def) => def.name === "panel_save_workflow");
  if (!tool) throw new Error("panel_save_workflow is not registered");
  return tool;
}

describe("savedPathFromTabId (#2505)", () => {
  it("extracts the saved file path from a wf: route and a legacy wf: handle", () => {
    expect(savedPathFromTabId(TAB)).toBe(DEST_PATH);
    expect(savedPathFromTabId(`wf:${DEST_PATH}`)).toBe(DEST_PATH);
  });

  it("does not treat tmp: or a bare uuid as a saved dest path", () => {
    expect(savedPathFromTabId(`tmp:${DEST_UUID}`)).toBeNull();
    expect(savedPathFromTabId(DEST_UUID)).toBeNull();
    expect(savedPathFromTabId("")).toBeNull();
    expect(savedPathFromTabId(null)).toBeNull();
  });
});

describe("bindLoadedWorkflowIdentity (#2505)", () => {
  it("replaces the source extra.workflow_path with the active dest path", () => {
    const bound = bindLoadedWorkflowIdentity(SOURCE_GRAPH, DEST_PATH, DEST_UUID);
    expect(bound).not.toBeNull();
    expect(extraWorkflowPath(bound)).toBe(DEST_PATH);
    expect(extraWorkflowPath(bound)).not.toBe(SOURCE_PATH);
    expect(extraWorkflowUuid(bound)).toBe(DEST_UUID);
    expect(extraWorkflowUuid(bound)).not.toBe(SOURCE_UUID);
  });

  it("does not mutate the source graph", () => {
    const original = structuredClone(SOURCE_GRAPH);
    bindLoadedWorkflowIdentity(SOURCE_GRAPH, DEST_PATH, DEST_UUID);
    expect(SOURCE_GRAPH).toEqual(original);
    expect(extraWorkflowPath(SOURCE_GRAPH)).toBe(SOURCE_PATH);
  });

  it("returns null when the stamp already names dest, or dest/graph are unusable", () => {
    const already = bindLoadedWorkflowIdentity(
      { ...SOURCE_GRAPH, extra: { comfyui_mcp: { workflow_path: DEST_PATH, workflow_uuid: DEST_UUID } } },
      DEST_PATH,
      DEST_UUID,
    );
    expect(already).toBeNull();
    expect(bindLoadedWorkflowIdentity({ nodes: [] }, DEST_PATH, DEST_UUID)).not.toBeNull();
    expect(bindLoadedWorkflowIdentity(SOURCE_GRAPH, "", DEST_UUID)).toBeNull();
    expect(bindLoadedWorkflowIdentity(SOURCE_GRAPH, `tmp:${DEST_UUID}`)).toBeNull();
    expect(bindLoadedWorkflowIdentity(null, DEST_PATH)).toBeNull();
    expect(bindLoadedWorkflowIdentity("graph", DEST_PATH)).toBeNull();
  });

  it("stamps dest identity onto a graph that has no extra yet", () => {
    const bound = bindLoadedWorkflowIdentity({ nodes: [] }, DEST_PATH, DEST_UUID);
    expect(extraWorkflowPath(bound)).toBe(DEST_PATH);
    expect(extraWorkflowUuid(bound)).toBe(DEST_UUID);
  });
});

function savedTabBridge() {
  let live: Record<string, unknown> = {
    last_node_id: 1,
    nodes: [{ id: 1, type: "Note", widgets_values: ["tab A"] }],
    links: [],
    extra: { comfyui_mcp: { workflow_path: DEST_PATH, workflow_uuid: DEST_UUID } },
  };
  const sent: Array<Record<string, unknown>> = [];
  const bridge = {
    send: async (cmd: Record<string, unknown>) => {
      sent.push(cmd);
      if (cmd.cmd === "graph_serialize") {
        return { workflow: live, node_count: Array.isArray(live.nodes) ? live.nodes.length : 0 };
      }
      if (cmd.cmd === "graph_load") {
        const graph = cmd.graph;
        if (graph && typeof graph === "object" && !Array.isArray(graph)) {
          live = graph;
        }
        return { loaded: true, node_count: Array.isArray(live.nodes) ? live.nodes.length : 0 };
      }
      if (cmd.cmd === "workflow_list") {
        return {
          active_confirmed: true,
          active: {
            path: DEST_PATH,
            filename: "A.app.json",
            key: `wf:${DEST_PATH}`,
            routing_key: TAB,
            workflow_uuid: DEST_UUID,
          },
        };
      }
      if (cmd.cmd === "workflow_save") {
        const stamped = extraWorkflowPath(live);
        if (stamped && stamped !== DEST_PATH) throw new Error(STAMP_REFUSAL);
        return { saved: true, workflow: DEST_PATH };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "A.app.json", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    workflowUuidFor: () => ({ known: true, uuid: DEST_UUID }),
    refreshWorkflowUuid: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as PanelToolCtx["bridge"];
  return { bridge, sent, liveOf: () => live };
}

describe("panel_load_workflow restamps extra.workflow_path onto the active tab (#2505)", () => {
  it("sends graph_load stamped as dest A, not source B", async () => {
    const { bridge, sent } = savedTabBridge();
    const res = await loadTool().handler(
      { graph: structuredClone(SOURCE_GRAPH) },
      makePanelToolCtx(bridge, TAB),
    );

    expect(res.isError).toBeFalsy();
    const loadCmd = sent.find((cmd) => cmd.cmd === "graph_load");
    expect(loadCmd).toBeTruthy();
    expect(extraWorkflowPath(loadCmd?.graph)).toBe(DEST_PATH);
    expect(extraWorkflowPath(loadCmd?.graph)).not.toBe(SOURCE_PATH);
    expect(extraWorkflowUuid(loadCmd?.graph)).toBe(DEST_UUID);
    expect(extraWorkflowUuid(loadCmd?.graph)).not.toBe(SOURCE_UUID);
  });
});

describe("panel_save_workflow after load-into-A is not a stale-canvas refusal (#2505)", () => {
  it("saves in place with no name after loading B onto A", async () => {
    const { bridge } = savedTabBridge();
    const ctx = makePanelToolCtx(bridge, TAB);

    const loaded = await loadTool().handler({ graph: structuredClone(SOURCE_GRAPH) }, ctx);
    expect(loaded.isError).toBeFalsy();

    const saved = await saveTool().handler({}, ctx);
    expect(saved.isError).toBeFalsy();
    expect(textOf(saved)).toMatch(/saved/i);
    expect(textOf(saved)).not.toMatch(/stamped as belonging to/i);
  });
});
