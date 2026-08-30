// #2503 — opening an imported workflow JSON in a new temporary tab preserved the
// source graph's extra.comfyui_mcp.workflow_uuid, while the panel assigned a new
// active workflow UUID. panel_graph_outline then refused with
// root-workflow-uuid-mismatch. Recovery via panel_open_workflow on the active
// tmp: key also failed (unconfirmed-active-workflow after resolving the temp key).
//
// Tests drive bindImportedTmpWorkflowUuid and the shipped load/open paths that
// must call it. Dest identity is the tab the panel just assigned, never the
// source file's stamp. workflow_path is left alone (#2505).

import { describe, expect, it } from "vitest";

import {
  bindImportedTmpWorkflowUuid,
  extraWorkflowUuid,
  unsavedTmpWorkflowKey,
} from "../../orchestrator/open-identity-normalization.js";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

const SOURCE_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DEST_UUID = "11111111-2222-4333-8444-555555555555";
const SOURCE_PATH = "workflows/source.json";
const TMP_KEY = `tmp:${DEST_UUID}`;
const TAB = TMP_KEY;

const UI_GRAPH = {
  last_node_id: 2,
  nodes: [
    { id: 1, type: "CLIPTextEncode", widgets_values: ["a portrait"] },
    { id: 2, type: "SaveImage", widgets_values: ["out"] },
  ],
  links: [],
  extra: { comfyui_mcp: { workflow_path: SOURCE_PATH, workflow_uuid: SOURCE_UUID } },
};

const textOf = (res: ToolResult): string =>
  res.content.map((part) => (part as { text?: string }).text ?? "").join(" ");

function loadTool() {
  const tool = buildPanelToolDefs().find((def) => def.name === "panel_load_workflow");
  if (!tool) throw new Error("panel_load_workflow is not registered");
  return tool;
}

function openTool() {
  const tool = buildPanelToolDefs().find((def) => def.name === "panel_open_workflow");
  if (!tool) throw new Error("panel_open_workflow is not registered");
  return tool;
}

describe("bindImportedTmpWorkflowUuid (#2503)", () => {
  it("replaces the source extra.workflow_uuid with the assigned tab uuid", () => {
    const bound = bindImportedTmpWorkflowUuid(UI_GRAPH, DEST_UUID);
    expect(bound).not.toBeNull();
    expect(extraWorkflowUuid(bound)).toBe(DEST_UUID);
    expect(bound && extraWorkflowUuid(bound)).not.toBe(SOURCE_UUID);
  });

  it("does not rewrite extra.workflow_path — that is #2505", () => {
    const bound = bindImportedTmpWorkflowUuid(UI_GRAPH, DEST_UUID);
    expect(bound).not.toBeNull();
    const extra = bound?.extra;
    expect(extra && typeof extra === "object" && !Array.isArray(extra)).toBe(true);
    const meta =
      extra && typeof extra === "object" && !Array.isArray(extra)
        ? extra.comfyui_mcp
        : undefined;
    expect(meta && typeof meta === "object" && !Array.isArray(meta)).toBe(true);
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      expect(meta.workflow_path).toBe(SOURCE_PATH);
    }
  });

  it("does not mutate the source graph", () => {
    const original = structuredClone(UI_GRAPH);
    bindImportedTmpWorkflowUuid(UI_GRAPH, DEST_UUID);
    expect(UI_GRAPH).toEqual(original);
    expect(extraWorkflowUuid(UI_GRAPH)).toBe(SOURCE_UUID);
  });

  it("returns null when the stamp already names dest, or dest/graph are unusable", () => {
    const already = bindImportedTmpWorkflowUuid(
      { ...UI_GRAPH, extra: { comfyui_mcp: { workflow_uuid: DEST_UUID } } },
      DEST_UUID,
    );
    expect(already).toBeNull();
    expect(bindImportedTmpWorkflowUuid({ nodes: [] }, DEST_UUID)).toBeNull();
    expect(bindImportedTmpWorkflowUuid(UI_GRAPH, "")).toBeNull();
    expect(bindImportedTmpWorkflowUuid(null, DEST_UUID)).toBeNull();
    expect(bindImportedTmpWorkflowUuid("graph", DEST_UUID)).toBeNull();
  });
});

describe("unsavedTmpWorkflowKey (#2503)", () => {
  it("accepts the exact tmp: token list_workflows publishes, including non-RFC suffixes", () => {
    expect(unsavedTmpWorkflowKey(TMP_KEY)).toBe(TMP_KEY);
    expect(unsavedTmpWorkflowKey("tmp:unsaved-imported")).toBe("tmp:unsaved-imported");
    expect(unsavedTmpWorkflowKey("wf:workflows/a.json")).toBeNull();
    expect(unsavedTmpWorkflowKey("workflows/a.json")).toBeNull();
    expect(unsavedTmpWorkflowKey("tmp:")).toBeNull();
    expect(unsavedTmpWorkflowKey("tmp: has space")).toBeNull();
  });
});

function tmpLoadBridge(opts?: { destUuid?: string }) {
  const destUuid = opts?.destUuid ?? DEST_UUID;
  const sent: Array<Record<string, unknown>> = [];
  const bridge = {
    send: async (cmd: Record<string, unknown>) => {
      sent.push(cmd);
      if (cmd.cmd === "graph_serialize") {
        return { workflow: { last_node_id: 0, nodes: [], links: [] }, node_count: 0 };
      }
      if (cmd.cmd === "graph_load") {
        return { loaded: true, node_count: UI_GRAPH.nodes.length };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "Unsaved Workflow", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    workflowUuidFor: () => ({ known: true, uuid: destUuid }),
    refreshWorkflowUuid: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  return { bridge, sent };
}

describe("panel_load_workflow restamps extra.workflow_uuid onto a tmp tab (#2503)", () => {
  it("sends graph_load with the tab uuid, not the source file's uuid", async () => {
    const { bridge, sent } = tmpLoadBridge();
    const res = await loadTool().handler(
      { graph: structuredClone(UI_GRAPH) },
      makePanelToolCtx(bridge, TAB),
    );

    expect(res.isError).toBeFalsy();
    const loadCmd = sent.find((cmd) => cmd.cmd === "graph_load");
    expect(loadCmd).toBeTruthy();
    expect(extraWorkflowUuid(loadCmd?.graph)).toBe(DEST_UUID);
    expect(extraWorkflowUuid(loadCmd?.graph)).not.toBe(SOURCE_UUID);
    const extra =
      loadCmd?.graph && typeof loadCmd.graph === "object" && !Array.isArray(loadCmd.graph)
        ? loadCmd.graph.extra
        : undefined;
    const meta =
      extra && typeof extra === "object" && !Array.isArray(extra) ? extra.comfyui_mcp : undefined;
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      expect(meta.workflow_path).toBe(SOURCE_PATH);
    }
  });

  it("does not invent a dest uuid when the tab has no fence", async () => {
    const { bridge, sent } = tmpLoadBridge();
    bridge.workflowUuidFor = () => ({ known: false });
    const res = await loadTool().handler(
      { graph: structuredClone(UI_GRAPH) },
      makePanelToolCtx(bridge, TAB),
    );

    expect(res.isError).toBeFalsy();
    const loadCmd = sent.find((cmd) => cmd.cmd === "graph_load");
    expect(extraWorkflowUuid(loadCmd?.graph)).toBe(SOURCE_UUID);
  });
});

function tmpOpenBridge(opts: {
  routingKey?: string | null;
  nestRoutingKey?: boolean;
  openedPath?: string | null;
  liveExtraUuid?: string;
  destUuid?: string;
  requestedKey?: string;
}) {
  const destUuid = opts.destUuid ?? DEST_UUID;
  const requestedKey = opts.requestedKey ?? TMP_KEY;
  const liveExtraUuid = opts.liveExtraUuid ?? SOURCE_UUID;
  let live = {
    ...structuredClone(UI_GRAPH),
    extra: { comfyui_mcp: { workflow_path: SOURCE_PATH, workflow_uuid: liveExtraUuid } },
  };
  const sent: Array<Record<string, unknown>> = [];
  const opened: Record<string, unknown> = {
    path: opts.openedPath === undefined ? "workflows/Unsaved Workflow.json" : opts.openedPath,
    filename: "Unsaved Workflow",
  };
  if (opts.nestRoutingKey && typeof opts.routingKey === "string") {
    opened.routing_key = opts.routingKey;
  }
  const openReply: Record<string, unknown> = {
    opened,
    ...(opts.nestRoutingKey || opts.routingKey == null
      ? {}
      : { routing_key: opts.routingKey }),
    workflow_uuid: destUuid,
    modified: true,
  };
  const list = {
    active_confirmed: true,
    active: {
      path: null,
      filename: null,
      title: "Unsaved Workflow",
      key: requestedKey,
      routing_key: requestedKey,
      workflow_uuid: destUuid,
    },
  };
  let fence: string | undefined = SOURCE_UUID;
  const bridge = {
    send: async (cmd: Record<string, unknown>) => {
      sent.push(cmd);
      if (cmd.cmd === "workflow_open") return openReply;
      if (cmd.cmd === "workflow_list") return list;
      if (cmd.cmd === "graph_serialize") {
        return { workflow: live, node_count: live.nodes.length };
      }
      if (cmd.cmd === "graph_load") {
        const graph = cmd.graph;
        if (graph && typeof graph === "object" && !Array.isArray(graph)) {
          live = {
            ...live,
            extra: isRecord(graph.extra) ? graph.extra : live.extra,
          };
        }
        return { loaded: true, node_count: live.nodes.length };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "Unsaved Workflow", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    workflowUuidFor: () => ({ known: Boolean(fence), uuid: fence }),
    refreshWorkflowUuid: (_tabId: string, uuid: string) => {
      fence = uuid;
      return true;
    },
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  return { bridge, sent, stampOf: () => fence };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("panel_open_workflow rebinds an already-active tmp tab by exact key (#2503)", () => {
  it("does not reject a tmp: open as an unresolved filename when opened.path looks saved and routing_key is absent", async () => {
    const { bridge } = tmpOpenBridge({ routingKey: null, openedPath: "workflows/Unsaved Workflow.json" });
    const res = await openTool().handler({ path: TMP_KEY }, makePanelToolCtx(bridge, TAB));

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).not.toMatch(/unconfirmed active workflow after resolving this filename/i);
    expect(textOf(res)).not.toMatch(/active canvas is UNKNOWN/i);
  });

  it("restamps live extra.workflow_uuid to the assigned tab uuid", async () => {
    const { bridge, sent, stampOf } = tmpOpenBridge({
      routingKey: TMP_KEY,
      openedPath: "workflows/Unsaved Workflow.json",
    });
    const res = await openTool().handler({ path: TMP_KEY }, makePanelToolCtx(bridge, TAB));

    expect(res.isError).toBeFalsy();
    const loadCmd = sent.find((cmd) => cmd.cmd === "graph_load");
    expect(loadCmd).toBeTruthy();
    expect(extraWorkflowUuid(loadCmd?.graph)).toBe(DEST_UUID);
    expect(stampOf()).toBe(DEST_UUID);
  });

  it("rebinds a non-RFC tmp: key without filename resolution", async () => {
    const key = "tmp:unsaved-imported";
    const { bridge, sent } = tmpOpenBridge({
      requestedKey: key,
      routingKey: null,
      openedPath: "workflows/Unsaved Workflow.json",
    });
    const res = await openTool().handler({ path: key }, makePanelToolCtx(bridge, key));

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).not.toMatch(/unconfirmed active workflow after resolving this filename/i);
    expect(textOf(res)).not.toMatch(/active canvas is UNKNOWN/i);
    // Fence adoption stays RFC-strict on the key (#812). The open itself must
    // still succeed so recovery is not a filename-resolution dead end.
    expect(sent.map((cmd) => cmd.cmd)).not.toContain("workflow_list");
  });

  it("does not restamp when extra already names the assigned tab", async () => {
    const { bridge, sent } = tmpOpenBridge({
      routingKey: TMP_KEY,
      liveExtraUuid: DEST_UUID,
    });
    const res = await openTool().handler({ path: TMP_KEY }, makePanelToolCtx(bridge, TAB));

    expect(res.isError).toBeFalsy();
    expect(sent.map((cmd) => cmd.cmd)).not.toContain("graph_load");
  });
});
