// Coverage for the SHARED panel_* tool surface (buildPanelToolDefs) — focused on
// the copy/paste merge + subgraph save/list/add tools, and on the parity
// guarantee that every shared def registers onto BOTH transports.
//
// The handlers are transport-agnostic: each forwards a bridge command via the
// injected ctx. We assert the exact commands/args they forward (the behavior the
// panel JS executors implement), and that the McpServer HTTP path registers the
// identical set.

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildPanelToolDefs,
  registerPanelTools,
  type PanelToolCtx,
} from "../../orchestrator/panel-tools.js";

type Forwarded = Record<string, unknown>;

function makeFakeCtx(): { ctx: PanelToolCtx; calls: Forwarded[] } {
  const calls: Forwarded[] = [];
  const ctx: PanelToolCtx = {
    call: async (cmd) => {
      calls.push(cmd);
      return { content: [{ type: "text", text: JSON.stringify(cmd) }] };
    },
    confirm: async () => true,
    bridge: {} as PanelToolCtx["bridge"],
    tabId: "test-tab",
  };
  return { ctx, calls };
}

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} not found in buildPanelToolDefs()`);
  return def;
}

describe("panel-tools: copy/paste + subgraph blueprints", () => {
  it("registers the new merge/reuse tools in the shared def list", () => {
    const names = buildPanelToolDefs().map((d) => d.name);
    for (const expected of [
      "panel_copy_nodes",
      "panel_paste_nodes",
      "panel_save_subgraph",
      "panel_list_subgraphs",
      "panel_add_subgraph",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("panel_copy_nodes forwards graph_copy_nodes with node_ids", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_copy_nodes").handler({ node_ids: [1, 2, 3] }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "graph_copy_nodes", node_ids: [1, 2, 3] });
  });

  it("panel_copy_nodes forwards graph_copy_nodes with no ids (copy selection)", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_copy_nodes").handler({}, ctx);
    expect(calls[0]).toMatchObject({ cmd: "graph_copy_nodes" });
    expect(calls[0].node_ids).toBeUndefined();
  });

  it("panel_paste_nodes forwards graph_paste_nodes with pos + connect_inputs", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_paste_nodes").handler(
      { pos: [10, 20], connect_inputs: true },
      ctx,
    );
    expect(calls[0]).toMatchObject({
      cmd: "graph_paste_nodes",
      pos: [10, 20],
      connect_inputs: true,
    });
  });

  it("panel_save_subgraph forwards graph_save_subgraph with node_id + name", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_save_subgraph").handler(
      { node_id: 7, name: "MyBlock" },
      ctx,
    );
    expect(calls[0]).toMatchObject({
      cmd: "graph_save_subgraph",
      node_id: 7,
      name: "MyBlock",
    });
  });

  it("panel_list_subgraphs forwards graph_list_subgraphs", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_list_subgraphs").handler({}, ctx);
    expect(calls[0]).toMatchObject({ cmd: "graph_list_subgraphs" });
  });

  it("panel_add_subgraph forwards graph_add_subgraph with name + pos", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_add_subgraph").handler(
      { name: "MyBlock", pos: [5, 5] },
      ctx,
    );
    expect(calls[0]).toMatchObject({
      cmd: "graph_add_subgraph",
      name: "MyBlock",
      pos: [5, 5],
    });
  });
});

describe("panel-tools: panel_load_workflow path (server-side disk read)", () => {
  it("reads an ABSOLUTE workflow .json off disk and fires graph_load with its graph", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-load-"));
    const file = join(dir, "pusa_extend.json");
    const graph = { nodes: [{ id: 1, type: "KSampler" }, { id: 2, type: "VAEDecode" }] };
    writeFileSync(file, JSON.stringify(graph), "utf8");

    const { ctx, calls } = makeFakeCtx();
    const res = await defByName("panel_load_workflow").handler({ path: file }, ctx);

    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cmd: "graph_load" });
    // The big JSON was read SERVER-SIDE and handed to graph_load verbatim.
    expect(calls[0].graph).toMatchObject(graph);
  });

  it("rejects a non-existent path WITHOUT firing graph_load", async () => {
    const { ctx, calls } = makeFakeCtx();
    const res = await defByName("panel_load_workflow").handler(
      { path: join(tmpdir(), "does-not-exist-12345.json") },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("rejects a .json that is not a UI workflow (no nodes array)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-load-"));
    const file = join(dir, "api-format.json");
    // API/prompt format (numeric keys) — NOT a UI workflow.
    writeFileSync(file, JSON.stringify({ "1": { class_type: "KSampler" } }), "utf8");

    const { ctx, calls } = makeFakeCtx();
    const res = await defByName("panel_load_workflow").handler({ path: file }, ctx);
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-.json path", async () => {
    const { ctx, calls } = makeFakeCtx();
    const res = await defByName("panel_load_workflow").handler(
      { path: join(tmpdir(), "not-a-workflow.txt") },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("panel-tools: transport parity", () => {
  it("registers every shared def (incl. the new tools) on the HTTP McpServer", () => {
    const registered: string[] = [];
    const fakeServer = {
      registerTool: (name: string) => {
        registered.push(name);
      },
    } as unknown as McpServer;
    const { ctx } = makeFakeCtx();

    registerPanelTools(fakeServer, ctx);

    const sharedNames = buildPanelToolDefs().map((d) => d.name);
    expect(registered).toEqual(sharedNames);
    for (const expected of [
      "panel_copy_nodes",
      "panel_paste_nodes",
      "panel_save_subgraph",
      "panel_list_subgraphs",
      "panel_add_subgraph",
    ]) {
      expect(registered).toContain(expected);
    }
  });
});
