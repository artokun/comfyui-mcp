// Coverage for the SHARED panel_* tool surface (buildPanelToolDefs) — focused on
// the copy/paste merge + subgraph save/list/add tools, and on the parity
// guarantee that every shared def registers onto BOTH transports.
//
// The handlers are transport-agnostic: each forwards a bridge command via the
// injected ctx. We assert the exact commands/args they forward (the behavior the
// panel JS executors implement), and that the McpServer HTTP path registers the
// identical set.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setNsfwConsent } from "../../services/panel-settings.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  registerPanelTools,
  type PanelToolCtx,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

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

describe("panel-tools: panel_set_node_mode (bypass/mute/active)", () => {
  it("is present in the shared def list", () => {
    const names = buildPanelToolDefs().map((d) => d.name);
    expect(names).toContain("panel_set_node_mode");
  });

  it("exposes a node_id + mode enum schema with exactly active/bypass/mute", () => {
    const def = defByName("panel_set_node_mode");
    expect(Object.keys(def.schema).sort()).toEqual(["mode", "node_id"]);
    // The mode enum must match the executor contract EXACTLY.
    const mode = def.schema.mode as { options: string[] };
    expect([...mode.options].sort()).toEqual(["active", "bypass", "mute"]);
    // node_id rejects non-numbers (typed like the other per-node tools).
    const nodeId = def.schema.node_id as { safeParse: (v: unknown) => { success: boolean } };
    expect(nodeId.safeParse(7).success).toBe(true);
  });

  it("forwards graph_set_node_mode with node_id + mode", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_set_node_mode").handler({ node_id: 143, mode: "bypass" }, ctx);
    expect(calls[0]).toMatchObject({
      cmd: "graph_set_node_mode",
      node_id: 143,
      mode: "bypass",
    });
  });
});

describe("panel-tools: subgraph I/O (expose rails + unpack)", () => {
  it("registers the three new subgraph I/O tools in the shared def list", () => {
    const names = buildPanelToolDefs().map((d) => d.name);
    for (const expected of [
      "panel_expose_subgraph_output",
      "panel_expose_subgraph_input",
      "panel_unpack_subgraph",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("panel_expose_subgraph_output exposes from_node_id + from_output + name schema", () => {
    const def = defByName("panel_expose_subgraph_output");
    expect(Object.keys(def.schema).sort()).toEqual(["from_node_id", "from_output", "name"]);
    // from_node_id is an int like the other per-node tools.
    const fromNode = def.schema.from_node_id as { safeParse: (v: unknown) => { success: boolean } };
    expect(fromNode.safeParse(3).success).toBe(true);
    expect(fromNode.safeParse("x").success).toBe(false);
    // from_output is a string|number slot ref.
    const fromOut = def.schema.from_output as { safeParse: (v: unknown) => { success: boolean } };
    expect(fromOut.safeParse("IMAGE").success).toBe(true);
    expect(fromOut.safeParse(0).success).toBe(true);
  });

  it("panel_expose_subgraph_output forwards graph_expose_subgraph_output", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_expose_subgraph_output").handler(
      { from_node_id: 5, from_output: "IMAGE", name: "out0" },
      ctx,
    );
    expect(calls[0]).toMatchObject({
      cmd: "graph_expose_subgraph_output",
      from_node_id: 5,
      from_output: "IMAGE",
      name: "out0",
    });
  });

  it("panel_expose_subgraph_input exposes to_node_id + to_input + name schema", () => {
    const def = defByName("panel_expose_subgraph_input");
    expect(Object.keys(def.schema).sort()).toEqual(["name", "to_input", "to_node_id"]);
    const toNode = def.schema.to_node_id as { safeParse: (v: unknown) => { success: boolean } };
    expect(toNode.safeParse(3).success).toBe(true);
    expect(toNode.safeParse("x").success).toBe(false);
    const toIn = def.schema.to_input as { safeParse: (v: unknown) => { success: boolean } };
    expect(toIn.safeParse("model").success).toBe(true);
    expect(toIn.safeParse(1).success).toBe(true);
  });

  it("panel_expose_subgraph_input forwards graph_expose_subgraph_input", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_expose_subgraph_input").handler(
      { to_node_id: 9, to_input: 0 },
      ctx,
    );
    expect(calls[0]).toMatchObject({
      cmd: "graph_expose_subgraph_input",
      to_node_id: 9,
      to_input: 0,
    });
  });

  it("panel_unpack_subgraph exposes a single node_id int schema", () => {
    const def = defByName("panel_unpack_subgraph");
    expect(Object.keys(def.schema)).toEqual(["node_id"]);
    const nodeId = def.schema.node_id as { safeParse: (v: unknown) => { success: boolean } };
    expect(nodeId.safeParse(12).success).toBe(true);
    expect(nodeId.safeParse(1.5).success).toBe(false);
  });

  it("panel_unpack_subgraph forwards graph_unpack_subgraph with node_id", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_unpack_subgraph").handler({ node_id: 42 }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "graph_unpack_subgraph", node_id: 42 });
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

describe("panel-tools: panel_run (run-to-node partial execution)", () => {
  it("exposes a batch_count + optional to_node_id schema", () => {
    const def = defByName("panel_run");
    expect(Object.keys(def.schema).sort()).toEqual(["batch_count", "to_node_id"]);
    // to_node_id is an optional int — accepts a node id, rejects non-numbers,
    // and (being optional) accepts undefined for a normal full run.
    const toNode = def.schema.to_node_id as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(toNode.safeParse(27).success).toBe(true);
    expect(toNode.safeParse("x").success).toBe(false);
    expect(toNode.safeParse(undefined).success).toBe(true);
  });

  it("forwards graph_run with to_node_id undefined for a full run", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_run").handler({ batch_count: 2 }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "graph_run", batch_count: 2 });
    expect(calls[0].to_node_id).toBeUndefined();
  });

  it("forwards graph_run with to_node_id for a run-to-node", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_run").handler({ to_node_id: 27 }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "graph_run", to_node_id: 27 });
  });
});

describe("panel-tools: panel_auto_layout (one-shot canvas arrange)", () => {
  it("is registered in the shared def list", () => {
    expect(buildPanelToolDefs().map((d) => d.name)).toContain("panel_auto_layout");
  });

  it("exposes the node_ids/mode/spacing/groups/dry_run schema", () => {
    const def = defByName("panel_auto_layout");
    expect(Object.keys(def.schema).sort()).toEqual([
      "dry_run",
      "groups",
      "mode",
      "node_ids",
      "spacing",
    ]);
    // mode enum must match the engine contract exactly.
    const mode = def.schema.mode as { safeParse: (v: unknown) => { success: boolean } };
    expect(mode.safeParse("flow_horizontal").success).toBe(true);
    expect(mode.safeParse("grid").success).toBe(true);
    expect(mode.safeParse("diagonal").success).toBe(false);
    expect(mode.safeParse(undefined).success).toBe(true);
    // spacing is clamped to 0.25–4.
    const spacing = def.schema.spacing as { safeParse: (v: unknown) => { success: boolean } };
    expect(spacing.safeParse(1).success).toBe(true);
    expect(spacing.safeParse(0.1).success).toBe(false);
    expect(spacing.safeParse(5).success).toBe(false);
    // groups enum.
    const groups = def.schema.groups as { safeParse: (v: unknown) => { success: boolean } };
    expect(groups.safeParse("preserve").success).toBe(true);
    expect(groups.safeParse("nope").success).toBe(false);
  });

  it("forwards graph_auto_layout with every provided arg", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_auto_layout").handler(
      { node_ids: [1, 2, 3], mode: "grid", spacing: 1.5, groups: "cluster", dry_run: true },
      ctx,
    );
    expect(calls[0]).toMatchObject({
      cmd: "graph_auto_layout",
      node_ids: [1, 2, 3],
      mode: "grid",
      spacing: 1.5,
      groups: "cluster",
      dry_run: true,
    });
  });

  it("forwards graph_auto_layout with no args (arrange whole graph, defaults)", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_auto_layout").handler({}, ctx);
    expect(calls[0]).toMatchObject({ cmd: "graph_auto_layout" });
    expect(calls[0].node_ids).toBeUndefined();
  });
});

describe("panel-tools: panel_find_nodes (live-graph search)", () => {
  it("is registered in the shared def list", () => {
    expect(buildPanelToolDefs().map((d) => d.name)).toContain("panel_find_nodes");
  });

  it("exposes the full filter schema", () => {
    const def = defByName("panel_find_nodes");
    expect(Object.keys(def.schema).sort()).toEqual([
      "input",
      "is_output",
      "is_subgraph",
      "limit",
      "mode",
      "output",
      "query",
      "title",
      "type",
      "widget",
      "widget_value",
    ]);
    // mode is the active/bypass/mute enum, optional (undefined ok); reject others.
    const mode = def.schema.mode as { safeParse: (v: unknown) => { success: boolean } };
    expect(mode.safeParse("bypass").success).toBe(true);
    expect(mode.safeParse("nope").success).toBe(false);
    expect(mode.safeParse(undefined).success).toBe(true);
    const query = def.schema.query as { safeParse: (v: unknown) => { success: boolean } };
    expect(query.safeParse(undefined).success).toBe(true);
  });

  it("forwards graph_find_nodes with every provided filter", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_find_nodes").handler(
      { query: "tiktok", type: "LoadVideo", widget_value: ".mp4", is_output: false, mode: "bypass" },
      ctx,
    );
    expect(calls[0]).toMatchObject({
      cmd: "graph_find_nodes",
      query: "tiktok",
      type: "LoadVideo",
      widget_value: ".mp4",
      is_output: false,
      mode: "bypass",
    });
  });
});

describe("panel-tools: panel_graph_outline (compact text map)", () => {
  it("is registered and takes no args", () => {
    expect(buildPanelToolDefs().map((d) => d.name)).toContain("panel_graph_outline");
    expect(Object.keys(defByName("panel_graph_outline").schema)).toEqual([]);
  });

  it("forwards graph_outline", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_graph_outline").handler({}, ctx);
    expect(calls[0]).toMatchObject({ cmd: "graph_outline" });
  });
});

describe("panel-tools: panel_audit_prompt_director", () => {
  it("is read-only, takes no args, and forwards the dedicated graph audit command", async () => {
    const def = defByName("panel_audit_prompt_director");
    expect(Object.keys(def.schema)).toEqual([]);
    expect(def.description).toContain("READ-ONLY");

    const { ctx, calls } = makeFakeCtx();
    await def.handler({}, ctx);
    expect(calls[0]).toMatchObject({ cmd: "graph_prompt_director_audit" });
  });
});

describe("panel-tools: panel_subgraph_group (wrap a group into a subgraph)", () => {
  it("is registered and takes a string|number group ref", () => {
    expect(buildPanelToolDefs().map((d) => d.name)).toContain("panel_subgraph_group");
    const def = defByName("panel_subgraph_group");
    expect(Object.keys(def.schema)).toEqual(["group"]);
    const group = def.schema.group as { safeParse: (v: unknown) => { success: boolean } };
    expect(group.safeParse("REPLACEMENT MODE").success).toBe(true);
    expect(group.safeParse(3).success).toBe(true);
    expect(group.safeParse({}).success).toBe(false);
  });

  it("forwards graph_subgraph_group with the group ref (title or id)", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_subgraph_group").handler({ group: "REPLACEMENT MODE" }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "graph_subgraph_group", group: "REPLACEMENT MODE" });
    await defByName("panel_subgraph_group").handler({ group: 2 }, ctx);
    expect(calls[1]).toMatchObject({ cmd: "graph_subgraph_group", group: 2 });
  });
});

describe("panel-tools: workflow target (per-workflow agent)", () => {
  it("registers get/set workflow target tools", () => {
    const names = buildPanelToolDefs().map((d) => d.name);
    expect(names).toContain("panel_get_workflow_target");
    expect(names).toContain("panel_set_workflow_target");
  });

  it("injects workflow_path on graph commands when pinned", async () => {
    const store = new WorkflowTargetStore();
    store.set("test-tab", { mode: "pinned", path: "workflows/pinned.json" });
    const calls: Forwarded[] = [];
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        calls.push(cmd);
        return { ok: true };
      },
      push: () => 1,
    } as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "test-tab", store);
    // Upstream replaced panel_get_graph (graph_get_state) with panel_query_graph
    // (graph_query) — same injection path: any graph_* command gets the pin.
    await defByName("panel_query_graph").handler({}, ctx);
    expect(calls[0]).toMatchObject({
      cmd: "graph_query",
      workflow_path: "workflows/pinned.json",
    });
  });

  it("panel_set_workflow_target pins and returns note", async () => {
    const store = new WorkflowTargetStore();
    const pushes: unknown[] = [];
    const bridge = {
      send: async () => ({}),
      push: (frame: unknown) => {
        pushes.push(frame);
        return 1;
      },
    } as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "test-tab", store);
    const res = await defByName("panel_set_workflow_target").handler(
      { mode: "pinned", path: "workflows/a.json", filename: "a.json" },
      ctx,
    );
    expect(store.get("test-tab")).toMatchObject({
      mode: "pinned",
      path: "workflows/a.json",
    });
    expect(pushes[0]).toMatchObject({
      type: "workflow_target",
      target: { mode: "pinned", path: "workflows/a.json", filename: "a.json" },
    });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("Pinned");
  });
});

describe("panel_connect slot aliases (live panel finding: stripped aliases → auto-match scramble)", () => {
  it("maps from_slot_name/to_slot_name onto from_output/to_input on the wire", async () => {
    const { ctx, calls } = makeFakeCtx();
    const def = defByName("panel_connect");
    await def.handler(
      { from_node_id: 10, from_slot_name: "MODEL", to_node_id: 3, to_slot_name: "model" },
      ctx,
    );
    expect(calls[0]).toMatchObject({
      cmd: "graph_connect",
      from_node_id: 10,
      from_output: "MODEL",
      to_node_id: 3,
      to_input: "model",
    });
  });

  it("canonical names win over aliases; bare aliases output/input also map", async () => {
    const { ctx, calls } = makeFakeCtx();
    const def = defByName("panel_connect");
    await def.handler(
      { from_node_id: 1, from_output: "LATENT", from_slot: "WRONG", to_node_id: 2, input: "samples" },
      ctx,
    );
    expect(calls[0]).toMatchObject({ from_output: "LATENT", to_input: "samples" });
  });
});

describe("panel-tools: agent-driven CivitAI + training modals", () => {
  it("registers every new drive tool in the shared def list", () => {
    const names = buildPanelToolDefs().map((d) => d.name);
    for (const expected of [
      "panel_civitai_results",
      "panel_civitai_highlight",
      "panel_civitai_clear_highlight",
      "panel_civitai_switch_tab",
      "panel_civitai_search",
      "panel_civitai_open_lightbox",
      "panel_training_open",
      "panel_training_get_state",
      "panel_training_set_field",
      "panel_training_goto_step",
      "panel_training_set_target",
      "panel_training_highlight",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("panel_open_civitai forwards a dock flag alongside the existing args", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_open_civitai").handler({ query: "flux", dock: true }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "open_civitai", query: "flux", dock: true });
  });

  it("panel_civitai_results forwards civitai_results with limit and clamps the range", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_civitai_results").handler({ limit: 20 }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "civitai_results", limit: 20 });
    const limit = defByName("panel_civitai_results").schema.limit as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(limit.safeParse(0).success).toBe(false);
    expect(limit.safeParse(51).success).toBe(false);
    expect(limit.safeParse(undefined).success).toBe(true);
  });

  it("panel_civitai_highlight forwards ids + kind, and requires at least one id", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_civitai_highlight").handler({ ids: [1, "abc"], kind: "media" }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "civitai_highlight", ids: [1, "abc"], kind: "media" });
    const ids = defByName("panel_civitai_highlight").schema.ids as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(ids.safeParse([]).success).toBe(false);
    const kind = defByName("panel_civitai_highlight").schema.kind as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(kind.safeParse("model").success).toBe(true);
    expect(kind.safeParse("nope").success).toBe(false);
  });

  it("panel_civitai_clear_highlight forwards civitai_clear_highlight with no args", async () => {
    const { ctx, calls } = makeFakeCtx();
    expect(Object.keys(defByName("panel_civitai_clear_highlight").schema)).toEqual([]);
    await defByName("panel_civitai_clear_highlight").handler({}, ctx);
    expect(calls[0]).toMatchObject({ cmd: "civitai_clear_highlight" });
  });

  it("panel_civitai_switch_tab forwards civitai_switch_tab with a real tab enum", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_civitai_switch_tab").handler({ tab: "loras" }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "civitai_switch_tab", tab: "loras" });
    const tab = defByName("panel_civitai_switch_tab").schema.tab as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(tab.safeParse("favorites").success).toBe(true);
    expect(tab.safeParse("nope").success).toBe(false);
  });

  it("panel_civitai_search forwards query + filters", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_civitai_search").handler(
      { query: "ghibli", filters: { baseModels: ["Flux.1 D"] } },
      ctx,
    );
    expect(calls[0]).toMatchObject({
      cmd: "civitai_search",
      query: "ghibli",
      filters: { baseModels: ["Flux.1 D"] },
    });
  });

  it("panel_training_get_state forwards training_get_state with no args", async () => {
    const { ctx, calls } = makeFakeCtx();
    expect(Object.keys(defByName("panel_training_get_state").schema)).toEqual([]);
    await defByName("panel_training_get_state").handler({}, ctx);
    expect(calls[0]).toMatchObject({ cmd: "training_get_state" });
  });

  it("panel_civitai_open_lightbox forwards civitai_open_lightbox with a string|number id", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_civitai_open_lightbox").handler({ id: 42 }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "civitai_open_lightbox", id: 42 });
    const id = defByName("panel_civitai_open_lightbox").schema.id as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(id.safeParse("abc").success).toBe(true);
    expect(id.safeParse(1).success).toBe(true);
  });

  it("panel_training_open forwards open_training with an optional dock flag", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_training_open").handler({ dock: false }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "open_training", dock: false });
  });

  it("panel_training_set_field forwards an allowlisted name + value, rejecting others", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_training_set_field").handler({ name: "datasetName", value: "my-lora" }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "training_set_field", name: "datasetName", value: "my-lora" });
    // name is a real enum: only the four allowlisted fields pass.
    const name = defByName("panel_training_set_field").schema.name as {
      safeParse: (v: unknown) => { success: boolean };
    };
    for (const ok of ["datasetName", "trigger", "preset", "target"]) {
      expect(name.safeParse(ok).success).toBe(true);
    }
    for (const bad of ["learning_rate", "name", "steps", "dataset_path"]) {
      expect(name.safeParse(bad).success).toBe(false);
    }
    const value = defByName("panel_training_set_field").schema.value as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(value.safeParse("standard").success).toBe(true);
    expect(value.safeParse(true).success).toBe(true);
    expect(value.safeParse({}).success).toBe(false);
  });

  it("panel_training_goto_step forwards a 1-based int step clamped to 1..4", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_training_goto_step").handler({ step: 2 }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "training_goto_step", step: 2 });
    const step = defByName("panel_training_goto_step").schema.step as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(step.safeParse(1).success).toBe(true);
    expect(step.safeParse(4).success).toBe(true);
    expect(step.safeParse(0).success).toBe(false);
    expect(step.safeParse(5).success).toBe(false);
    expect(step.safeParse(1.5).success).toBe(false);
  });

  it("panel_training_set_target forwards a local|pod enum", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_training_set_target").handler({ target: "pod" }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "training_set_target", target: "pod" });
    const target = defByName("panel_training_set_target").schema.target as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(target.safeParse("local").success).toBe(true);
    expect(target.safeParse("cloud").success).toBe(false);
  });

  it("panel_training_highlight forwards refs and requires at least one", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_training_highlight").handler({ refs: ["step:2", "field:lr"] }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "training_highlight", refs: ["step:2", "field:lr"] });
    const refs = defByName("panel_training_highlight").schema.refs as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(refs.safeParse([]).success).toBe(false);
  });
});

describe("panel-tools: NSFW consent enforced server-side on CivitAI browsing levels", () => {
  const origSettings = process.env.COMFYUI_MCP_PANEL_SETTINGS;

  beforeAll(() => {
    // Isolate the persistent consent store to a throwaway file for this suite.
    const dir = mkdtempSync(join(tmpdir(), "nsfw-consent-"));
    process.env.COMFYUI_MCP_PANEL_SETTINGS = join(dir, "panel-settings.json");
  });
  afterAll(() => {
    if (origSettings === undefined) delete process.env.COMFYUI_MCP_PANEL_SETTINGS;
    else process.env.COMFYUI_MCP_PANEL_SETTINGS = origSettings;
  });
  beforeEach(() => {
    setNsfwConsent(false); // default: no consent
  });

  it("panel_open_civitai clamps adult levels out when un-consented, keeping SFW", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_open_civitai").handler(
      { query: "x", browsingLevels: [1, 2, 4, 8, 16] },
      ctx,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].browsingLevels).toEqual([1, 2]);
  });

  it("panel_open_civitai REJECTS an all-adult request when un-consented (no bridge call)", async () => {
    const { ctx, calls } = makeFakeCtx();
    const res = await defByName("panel_open_civitai").handler({ browsingLevels: [16] }, ctx);
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("panel_open_civitai passes adult levels through when consent IS granted", async () => {
    setNsfwConsent(true);
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_open_civitai").handler({ browsingLevels: [1, 16] }, ctx);
    expect(calls[0].browsingLevels).toEqual([1, 16]);
  });

  it("panel_open_civitai rejects an unknown level value", async () => {
    const { ctx, calls } = makeFakeCtx();
    const res = await defByName("panel_open_civitai").handler({ browsingLevels: [3] }, ctx);
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("panel_open_civitai leaves omitted browsingLevels undefined (panel default applies)", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_open_civitai").handler({ query: "cats" }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "open_civitai", query: "cats" });
    expect(calls[0].browsingLevels).toBeUndefined();
  });

  it("panel_civitai_search enforces the SAME gate on its post-open browsingLevels", async () => {
    const { ctx, calls } = makeFakeCtx();
    // Un-consented: adult stripped, SFW kept.
    await defByName("panel_civitai_search").handler(
      { query: "y", browsingLevels: [2, 8] },
      ctx,
    );
    expect(calls[0].browsingLevels).toEqual([2]);

    // Consented: passes through.
    setNsfwConsent(true);
    await defByName("panel_civitai_search").handler(
      { query: "y", browsingLevels: [8] },
      ctx,
    );
    expect(calls[1].browsingLevels).toEqual([8]);
  });

  it("panel_civitai_search rejects an all-adult un-consented search (no bridge call)", async () => {
    const { ctx, calls } = makeFakeCtx();
    const res = await defByName("panel_civitai_search").handler(
      { query: "z", browsingLevels: [8, 16] },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("panel-tools: strip/slice read the live canvas by default", () => {
  const CANVAS_GRAPH = {
    nodes: [
      {
        id: 1,
        type: "SaveImage",
        pos: [10, 10],
        size: [100, 50],
        inputs: [],
        outputs: [],
        widgets_values: [],
      },
    ],
    links: [],
    groups: [{ id: 1, title: "OUT", bounding: [0, 0, 200, 200] }],
  };

  function ctxWithCanvas(sendImpl?: () => Promise<unknown>) {
    const send = vi.fn(sendImpl ?? (async () => ({ workflow: CANVAS_GRAPH, node_count: 1 })));
    const ctx: PanelToolCtx = {
      call: async (cmd) => ({ content: [{ type: "text", text: JSON.stringify(cmd) }] }),
      confirm: async () => true,
      bridge: { send } as unknown as PanelToolCtx["bridge"],
      tabId: "test-tab",
    };
    return { ctx, send };
  }

  it("panel_slice_workflow with no source captures the canvas via graph_serialize", async () => {
    const { ctx, send } = ctxWithCanvas();
    const res = await defByName("panel_slice_workflow").handler({ groups: "OUT" }, ctx);
    expect(send).toHaveBeenCalledWith({ cmd: "graph_serialize" }, { tabId: "test-tab", timeoutMs: 30000 });
    const text = (res as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain("Sliced");
  });

  it("panel_strip_workflow with no source surfaces a clear error when the canvas capture fails", async () => {
    const { ctx, send } = ctxWithCanvas(async () => {
      throw new Error("no panel tab");
    });
    await expect(defByName("panel_strip_workflow").handler({}, ctx)).rejects.toThrow(
      /Couldn't capture the live canvas/,
    );
    expect(send).toHaveBeenCalled();
  });

  it("explicit inline graph still wins over the canvas (no bridge call)", async () => {
    const { ctx, send } = ctxWithCanvas();
    const res = await defByName("panel_slice_workflow").handler(
      { graph: CANVAS_GRAPH, groups: "OUT" },
      ctx,
    );
    expect(send).not.toHaveBeenCalled();
    const text = (res as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain("Sliced");
  });
});
