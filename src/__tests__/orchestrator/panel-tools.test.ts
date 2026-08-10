// Coverage for the SHARED panel_* tool surface (buildPanelToolDefs) — focused on
// the copy/paste merge + subgraph save/list/add tools, and on the parity
// guarantee that every shared def registers onto BOTH transports.
//
// The handlers are transport-agnostic: each forwards a bridge command via the
// injected ctx. We assert the exact commands/args they forward (the behavior the
// panel JS executors implement), and that the McpServer HTTP path registers the
// identical set.

import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { getNsfwConsent, setNsfwConsent } from "../../services/panel-settings.js";
import { getBootLocalComfyUIBaseUrl } from "../../config.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  acceptedPromptIds,
  buildPanelToolDefs,
  makePanelToolCtx,
  registerPanelTools,
  __openWorkflowTestHooks,
  __panelToolsTestHooks,
  __panelRunTestHooks,
  __panelAskTestHooks,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import { markReplyTimeout } from "../../services/ui-bridge.js";
import { RunCompletions } from "../../orchestrator/run-completion-journal.js";
import { QueueMonitor } from "../../services/queue-monitor.js";
import { AskAnswers } from "../../orchestrator/ask-answer-journal.js";

type Forwarded = Record<string, unknown>;

function makeFakeCtx(
  bridgeReply?: unknown,
): { ctx: PanelToolCtx; calls: Forwarded[]; timeouts: (number | undefined)[] } {
  const calls: Forwarded[] = [];
  // Per-call ack timeout (ctx.call's 2nd arg), index-aligned with `calls`, so a
  // test can assert the #599 refresh-ack budget the tool forwarded.
  const timeouts: (number | undefined)[] = [];
  const ctx: PanelToolCtx = {
    call: async (cmd, timeoutMs) => {
      calls.push(cmd);
      timeouts.push(timeoutMs);
      return { content: [{ type: "text", text: JSON.stringify(cmd) }] };
    },
    confirm: async () => "yes" as const,
    // Some tools (panel_civitai_search) go through the raw bridge so they can
    // inspect the panel's reply. Record the forwarded cmd on the same `calls`
    // array and hand back a caller-supplied reply.
    bridge: {
      send: async (cmd: Forwarded) => {
        calls.push(cmd);
        return bridgeReply ?? {};
      },
    } as unknown as PanelToolCtx["bridge"],
    tabId: "test-tab",
  };
  return { ctx, calls, timeouts };
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

describe("panel-tools: panel_set_widget (empty-string clear, issue #347)", () => {
  it("forwards a normal non-empty value unchanged", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_set_widget").handler(
      { node_id: 39, widget: "text_input", value: "hello" },
      ctx,
    );
    expect(calls[0]).toMatchObject({
      cmd: "graph_set_widget",
      node_id: 39,
      widget: "text_input",
      value: "hello",
    });
  });

  it("forwards an explicit empty-string value (present-but-empty is honored)", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_set_widget").handler(
      { node_id: 39, widget: "text_input", value: "" },
      ctx,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      cmd: "graph_set_widget",
      node_id: 39,
      widget: "text_input",
      value: "",
    });
  });

  it("clear:true sets the widget to an empty string even when value is absent", async () => {
    const { ctx, calls } = makeFakeCtx();
    // Simulates the client that drops the empty-string value from the payload.
    await defByName("panel_set_widget").handler(
      { node_id: 39, widget: "text_input", clear: true },
      ctx,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      cmd: "graph_set_widget",
      node_id: 39,
      widget: "text_input",
      value: "",
    });
  });

  it("clear:true overrides any provided value", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_set_widget").handler(
      { node_id: 39, widget: "text_input", value: "stale", clear: true },
      ctx,
    );
    expect(calls[0]).toMatchObject({ cmd: "graph_set_widget", value: "" });
  });

  it("errors (does not forward) when neither value nor clear is provided", async () => {
    const { ctx, calls } = makeFakeCtx();
    const res = await defByName("panel_set_widget").handler(
      { node_id: 39, widget: "text_input" },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("panel-tools: fresh /object_info ack timeout (#599)", () => {
  // The refresh-before-validate FRONTEND handlers (graph_set_widget #338/#458,
  // graph_add_node #289/#458) await an authoritative /object_info fetch before
  // replying; on a large install that can outlast the bridge's 6000 ms default
  // ack, returning a FALSE "tab did not reply" timeout. The tools must forward a
  // larger BOUNDED ack budget so a slow-but-valid refresh isn't a false timeout.
  const REFRESH_ACK_MS = 30_000;

  it("panel_set_widget forwards graph_set_widget with the 30s refresh ack timeout, not the 6s default", async () => {
    const { ctx, calls, timeouts } = makeFakeCtx();
    await defByName("panel_set_widget").handler(
      { node_id: 39, widget: "image", value: "staged_00001_.png" },
      ctx,
    );
    expect(calls[0]).toMatchObject({ cmd: "graph_set_widget" });
    expect(timeouts[0]).toBe(REFRESH_ACK_MS);
  });

  it("panel_add_node forwards graph_add_node with the 30s refresh ack timeout", async () => {
    const { ctx, calls, timeouts } = makeFakeCtx();
    await defByName("panel_add_node").handler(
      { class_type: "LoadImage", pos: [0, 0] },
      ctx,
    );
    expect(calls[0]).toMatchObject({ cmd: "graph_add_node", class_type: "LoadImage" });
    expect(timeouts[0]).toBe(REFRESH_ACK_MS);
  });

  it("keeps the ack bounded (never Infinity) so a genuinely dead tab still fails", () => {
    expect(Number.isFinite(REFRESH_ACK_MS)).toBe(true);
    expect(REFRESH_ACK_MS).toBeLessThanOrEqual(60_000);
  });
});

describe("panel-tools: panel_add_node frontend-only virtual types (#741)", () => {
  // #741: Note/MarkdownNote/Reroute/PrimitiveNode are frontend-only virtual types —
  // they exist only in LiteGraph, never in the backend /object_info. The MCP side
  // must route them straight through to the panel (no class_type pre-validation),
  // and the description must tell agents annotation is possible at all.
  it("routes Note/MarkdownNote through to graph_add_node untouched", async () => {
    for (const class_type of ["Note", "MarkdownNote", "Reroute", "PrimitiveNode"]) {
      const { ctx, calls } = makeFakeCtx();
      await defByName("panel_add_node").handler({ class_type, pos: [0, 0] }, ctx);
      expect(calls[0]).toMatchObject({ cmd: "graph_add_node", class_type });
    }
  });

  it("documents Note/MarkdownNote as the supported annotation path", () => {
    const desc = defByName("panel_add_node").description;
    expect(desc).toContain("Note");
    expect(desc).toContain("MarkdownNote");
    expect(desc).toMatch(/annotat/i);
  });
});

describe("panel-tools: panel_refresh_nodes (#608 — force a combo/object_info refresh)", () => {
  it("forwards a bare refresh_nodes command (no graph mutation) with the refresh ack budget", async () => {
    const { ctx, calls, timeouts } = makeFakeCtx();
    await defByName("panel_refresh_nodes").handler({}, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ cmd: "refresh_nodes" });
    // Same 30s budget as the refresh-before-validate writes — this command's whole
    // purpose is to await a fresh /object_info fetch.
    expect(timeouts[0]).toBe(30_000);
  });

  it("takes no arguments (empty schema)", () => {
    expect(Object.keys(defByName("panel_refresh_nodes").schema)).toEqual([]);
  });
});

describe("panel-tools: panel_set_node_mode (bypass/mute/active)", () => {
  it("is present in the shared def list", () => {
    const names = buildPanelToolDefs().map((d) => d.name);
    expect(names).toContain("panel_set_node_mode");
  });

  it("exposes a node_id + mode enum schema (+ optional force) with exactly active/bypass/mute", () => {
    const def = defByName("panel_set_node_mode");
    expect(Object.keys(def.schema).sort()).toEqual(["force", "mode", "node_id", "retry_of"]);
    // The mode enum must match the executor contract EXACTLY.
    const mode = def.schema.mode as { options: string[] };
    expect([...mode.options].sort()).toEqual(["active", "bypass", "mute"]);
    // node_id rejects non-numbers (typed like the other per-node tools).
    const nodeId = def.schema.node_id as { safeParse: (v: unknown) => { success: boolean } };
    expect(nodeId.safeParse(7).success).toBe(true);
    // force is an optional boolean (unsafe-bypass override, #409).
    const force = def.schema.force as { safeParse: (v: unknown) => { success: boolean } };
    expect(force.safeParse(true).success).toBe(true);
    expect(force.safeParse(undefined).success).toBe(true);
  });

  it("preserves graph_set_node_mode for panels that predate graph_edit_node", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_set_node_mode").handler({ node_id: 143, mode: "bypass", force: true }, ctx);
    expect(calls[0]).toMatchObject({
      cmd: "graph_set_node_mode",
      node_id: 143,
      mode: "bypass",
      force: true,
    });
  });
});

describe("panel-tools: panel_edit_node (#572 presentation consolidation)", () => {
  it("is the shared core editor while compatibility names remain registered", () => {
    const names = buildPanelToolDefs().map((d) => d.name);
    expect(names).toContain("panel_edit_node");
    expect(names).toContain("panel_set_node_mode");
    for (const compatibility of [
      "panel_move_node",
      "panel_resize_node",
      "panel_set_node_title",
      "panel_set_node_collapsed",
      "panel_set_node_color",
    ]) {
      expect(names).toContain(compatibility);
    }
  });

  it("uses a flat schema with guarded presentation fields", () => {
    const def = defByName("panel_edit_node");
    expect(Object.keys(def.schema).sort()).toEqual([
      "bgcolor",
      "collapsed",
      "color",
      "force",
      "mode",
      "node_id",
      "node_ids",
      "pinned",
      "pos",
      "preset",
      "retry_of",
      "shape",
      "size",
      "title",
    ]);
    const color = def.schema.color as { safeParse: (v: unknown) => { success: boolean } };
    const size = def.schema.size as { safeParse: (v: unknown) => { success: boolean } };
    expect(color.safeParse("#abc").success).toBe(true);
    expect(color.safeParse("#abcd").success).toBe(true);
    expect(color.safeParse("#aabbcc").success).toBe(true);
    expect(color.safeParse("#aabbccdd").success).toBe(true);
    expect(color.safeParse("#12345").success).toBe(false);
    expect(color.safeParse("#1234567").success).toBe(false);
    expect(color.safeParse("rgb(1,2,3)").success).toBe(false);
    expect(size.safeParse([120, 80]).success).toBe(true);
    expect(size.safeParse([0, 80]).success).toBe(false);
    expect(size.safeParse([120]).success).toBe(false);
    expect(size.safeParse([120, 80, 60]).success).toBe(false);
  });

  it("forwards every supplied field to the single graph_edit_node bridge command", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_edit_node").handler(
      { node_ids: [7, 8], pos: [20, 30], size: [400, 200], title: "Loaders", color: "#336699", pinned: true, mode: "bypass", force: true },
      ctx,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      cmd: "graph_edit_node",
      node_ids: [7, 8],
      pos: [20, 30],
      size: [400, 200],
      title: "Loaders",
      color: "#336699",
      pinned: true,
      mode: "bypass",
      force: true,
    });
  });

  it.each([
    [{ pos: [1, 2] }, "exactly one of node_id or node_ids"],
    [{ node_id: 7, node_ids: [8], pos: [1, 2] }, "exactly one of node_id or node_ids"],
    [{ node_id: 7 }, "at least one editable field"],
    [{ node_id: 7, preset: "red", color: "#112233" }, "preset cannot be combined"],
  ])("rejects invalid cross-field input before dispatch: %o", async (args, expected) => {
    const { ctx, calls } = makeFakeCtx();
    const result = await defByName("panel_edit_node").handler(args, ctx);
    expect(calls).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(expected);
  });

  it.each([
    ["panel_move_node", { node_id: 7, pos: [1, 2] }, "graph_move_node"],
    ["panel_resize_node", { node_id: 7, size: [120, 80] }, "graph_resize_node"],
    ["panel_set_node_title", { node_id: 7, title: "Title" }, "graph_set_title"],
    ["panel_set_node_collapsed", { node_id: 7, collapsed: false }, "graph_set_node_collapsed"],
    ["panel_set_node_color", { node_id: 7, color: "#112233" }, "graph_set_node_color"],
  ])("keeps %s on its legacy bridge command for old panels", async (name, args, command) => {
    const { ctx, calls } = makeFakeCtx();
    await defByName(name).handler(args, ctx);
    expect(calls[0]).toMatchObject({ cmd: command, node_id: 7 });
  });

  it("keeps the legacy title command on its 15s mutation timeout", async () => {
    const { ctx, timeouts } = makeFakeCtx();
    await defByName("panel_set_node_title").handler({ node_id: 7, title: "Title" }, ctx);
    expect(timeouts[0]).toBe(15_000);
  });

  it("preserves CSS colors and preset-wins semantics on the legacy color wrapper", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_set_node_color").handler({ node_id: 7, preset: "red", color: "orange", bgcolor: "rebeccapurple" }, ctx);
    expect(calls).toEqual([
      { cmd: "graph_set_node_color", node_id: 7, preset: "red", color: "orange", bgcolor: "rebeccapurple" },
    ]);
  });

  it("keeps arbitrary CSS color strings and null clears valid for legacy callers", () => {
    const color = defByName("panel_set_node_color").schema.color as { safeParse: (v: unknown) => { success: boolean } };
    const preset = defByName("panel_set_node_color").schema.preset as { safeParse: (v: unknown) => { success: boolean } };
    expect(color.safeParse("red").success).toBe(true);
    expect(color.safeParse("rgb(1, 2, 3)").success).toBe(true);
    expect(color.safeParse("#12345").success).toBe(true);
    expect(color.safeParse(null).success).toBe(true);
    expect(preset.safeParse(null).success).toBe(true);
  });

  it("exports editor and legacy resize sizes as Codex-compatible homogeneous arrays", () => {
    for (const name of ["panel_edit_node", "panel_resize_node"]) {
      const def = defByName(name);
      const schema = z.toJSONSchema(z.object(def.schema), { reused: "inline", io: "input" }) as {
        properties?: Record<string, { type?: string; minItems?: number; maxItems?: number; items?: { type?: string } }>;
      };
      const size = schema.properties?.size;
      expect(size).toMatchObject({ type: "array", minItems: 2, maxItems: 2, items: { type: "number" } });
    }
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
    expect(Object.keys(def.schema).sort()).toEqual(["from_node_id", "from_output", "name", "retry_of"]);
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
    expect(Object.keys(def.schema).sort()).toEqual(["name", "retry_of", "to_input", "to_node_id"]);
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
    expect(Object.keys(def.schema)).toEqual(["node_id", "retry_of"]);
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
    // allow_duplicate (#862) opts out of the pre-queue duplicate fence.
    expect(Object.keys(def.schema).sort()).toEqual([
      "allow_duplicate",
      "batch_count",
      "retry_of",
      "to_node_id",
    ]);
    // to_node_id is an optional int — accepts a node id, rejects non-numbers,
    // and (being optional) accepts undefined for a normal full run.
    const toNode = def.schema.to_node_id as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(toNode.safeParse(27).success).toBe(true);
    expect(toNode.safeParse("x").success).toBe(false);
    expect(toNode.safeParse(undefined).success).toBe(true);
    // allow_duplicate is an optional boolean — defaults to the fenced behavior.
    const allowDup = def.schema.allow_duplicate as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(allowDup.safeParse(true).success).toBe(true);
    expect(allowDup.safeParse("yes").success).toBe(false);
    expect(allowDup.safeParse(undefined).success).toBe(true);
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

// A panel_run test ctx whose graph_run reply is fully controllable, so we can
// drive the four rejection/acceptance edge-cases the panel forwards from
// ComfyUI's /prompt. Records every forwarded cmd for assertion.
function makeRunCtx(reply: ToolResult): { ctx: PanelToolCtx; calls: Forwarded[] } {
  const calls: Forwarded[] = [];
  const ctx: PanelToolCtx = {
    call: async (cmd) => {
      calls.push(cmd);
      return reply;
    },
    confirm: async () => "yes" as const,
    bridge: {} as unknown as PanelToolCtx["bridge"],
    tabId: "test-tab",
  };
  return { ctx, calls };
}

/** Extract the joined text of a ToolResult for content assertions. */
function textOf(res: ToolResult): string {
  return (res.content ?? [])
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

const QUEUED_NOTE = "notified automatically";

describe("panel-tools: panel_run verdict is derived from the ComfyUI reply", () => {
  it("#213: a top-level /prompt error (empty node_errors) is a FAILURE, not queued:true", async () => {
    // ComfyUI split: a top-level rejection leaves node_errors empty. The panel's
    // stale guard may still forward queued:true — the orchestrator must NOT trust it.
    const reply: ToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            queued: true,
            error: {
              type: "prompt_outputs_failed_validation",
              message: "Prompt outputs failed validation",
            },
            node_errors: {},
          }),
        },
      ],
    };
    const { ctx } = makeRunCtx(reply);
    const res = await defByName("panel_run").handler({}, ctx);
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("Prompt outputs failed validation");
    expect(text).toContain("prompt_outputs_failed_validation");
    // The success-only anti-poll guidance must NOT be appended to a rejection.
    expect(text).not.toContain(QUEUED_NOTE);
  });

  it("#213: per-node node_errors are surfaced with node id + class_type", async () => {
    const reply: ToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            queued: false,
            node_errors: {
              "5": {
                class_type: "LoadImage",
                errors: [
                  { message: "Custom validation failed", details: "Invalid image: missing.png" },
                ],
              },
            },
          }),
        },
      ],
    };
    const { ctx } = makeRunCtx(reply);
    const res = await defByName("panel_run").handler({}, ctx);
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("LoadImage");
    expect(text).toContain("node 5");
    expect(text).toContain("Invalid image: missing.png");
    expect(text).not.toContain(QUEUED_NOTE);
  });

  it("#194: a root SaveImage run-to-node the panel ACCEPTS is queued success (not subgraph-rejected)", async () => {
    const reply: ToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ queued: true, batch_count: 1, to_node_id: 9, prompt_id: "p-194" }),
        },
      ],
    };
    const { ctx, calls } = makeRunCtx(reply);
    const res = await defByName("panel_run").handler({ to_node_id: 9 }, ctx);
    // Forwarded unchanged so the (fixed) panel can resolve the root output node.
    expect(calls[0]).toMatchObject({ cmd: "graph_run", to_node_id: 9 });
    expect(res.isError).toBeFalsy();
    // Accepted -> the anti-poll queued guidance IS appended.
    expect(textOf(res)).toContain(QUEUED_NOTE);
  });

  it("#194: a subgraph-rejection reply is surfaced cleanly WITHOUT the false success note", async () => {
    const reply: ToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            queued: false,
            error:
              "node 9 is not on the root graph — run-to-node targets a root-level output node",
          }),
        },
      ],
    };
    const { ctx } = makeRunCtx(reply);
    const res = await defByName("panel_run").handler({ to_node_id: 9 }, ctx);
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("not on the root graph");
    expect(text).not.toContain(QUEUED_NOTE);
  });

  it("#331: no queued-render guidance when no panel tab is connected", async () => {
    const reply: ToolResult = {
      content: [
        { type: "text", text: 'Error: no connected tab with id "tmp:abc". Connected: none' },
      ],
      isError: true,
    };
    const { ctx } = makeRunCtx(reply);
    const res = await defByName("panel_run").handler({ to_node_id: 25 }, ctx);
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("no connected tab");
    // The workflow was never queued — the automatic-delivery note must be absent.
    expect(text).not.toContain(QUEUED_NOTE);
  });

  it("#248: a thrown app.queuePrompt surfaces the browser stack detail, no success note", async () => {
    const stack =
      "app.queuePrompt failed:\n" +
      "TypeError: Cannot read properties of undefined (reading 'output')\n" +
      "    at app.graphToPrompt (http://127.0.0.1:8188/extensions/tts_audio_suite/audio_analyzer_interface.js:102:24)";
    const reply: ToolResult = {
      content: [{ type: "text", text: `Error: ${stack}` }],
      isError: true,
    };
    const { ctx } = makeRunCtx(reply);
    const res = await defByName("panel_run").handler({}, ctx);
    expect(res.isError).toBe(true);
    const text = textOf(res);
    // The actionable browser location must survive verbatim.
    expect(text).toContain("app.graphToPrompt");
    expect(text).toContain("audio_analyzer_interface.js:102:24");
    expect(text).not.toContain(QUEUED_NOTE);
  });

  it("a genuine queue (queued:true, no errors) still gets the anti-poll note", async () => {
    const reply: ToolResult = {
      content: [
        { type: "text", text: JSON.stringify({ queued: true, batch_count: 1, prompt_id: "p-ok" }) },
      ],
    };
    const { ctx } = makeRunCtx(reply);
    const res = await defByName("panel_run").handler({}, ctx);
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain(QUEUED_NOTE);
    // #468 — the anti-poll instruction is only safe because the completion can be
    // correlated back to this exact run; the ticket is what makes that possible.
    expect(RunCompletions.ticketFor("p-ok")).toBeDefined();
  });

  // #949 — batch_count > 1 makes the panel report `prompt_ids` for EVERY queued
  // render alongside `prompt_id` for the first. Only the first was ticketed, so
  // completions 2..N came back as "does NOT match any run you queued … its
  // origin is UNDETERMINED" — for runs the agent had just queued itself.
  it("#949: a BATCH tickets every prompt id, not just the first", async () => {
    const reply: ToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            queued: true,
            batch_count: 3,
            prompt_id: "p-batch-1",
            prompt_ids: ["p-batch-1", "p-batch-2", "p-batch-3"],
          }),
        },
      ],
    };
    const { ctx } = makeRunCtx(reply);
    const res = await defByName("panel_run").handler({ batch_count: 3 }, ctx);
    expect(res.isError).toBeFalsy();
    for (const id of ["p-batch-1", "p-batch-2", "p-batch-3"]) {
      expect(RunCompletions.ticketFor(id), id).toBeDefined();
    }
    // Every one of them is also OURS, so a later backlog warning does not call
    // the agent's own batch a foreign job (#559).
    for (const id of ["p-batch-2", "p-batch-3"]) {
      expect(QueueMonitor.attributeRun(id), id).toBe("mine");
    }
    // The batch is correlatable, so the anti-poll promise still stands.
    expect(textOf(res)).toContain(QUEUED_NOTE);
  });

  it("#949: prompt_id repeated inside prompt_ids opens ONE ticket, not two", async () => {
    const reply: ToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            queued: true,
            batch_count: 2,
            prompt_id: "p-dup-1",
            prompt_ids: ["p-dup-1", "p-dup-2"],
          }),
        },
      ],
    };
    const { ctx } = makeRunCtx(reply);
    await defByName("panel_run").handler({ batch_count: 2 }, ctx);
    // One prompt id always means one run — a duplicate must not stack a second
    // ticket, which openRun would otherwise treat as a re-queue.
    expect(RunCompletions.ticketFor("p-dup-1")).toBeDefined();
    expect(RunCompletions.ticketFor("p-dup-2")).toBeDefined();
    expect(acceptedPromptIds({ prompt_id: "p-dup-1", prompt_ids: ["p-dup-1", "p-dup-2"] })).toEqual([
      "p-dup-1",
      "p-dup-2",
    ]);
  });

  it("#949: a malformed prompt_ids does not break the single-id path", async () => {
    // Junk entries are skipped, not ticketed, and prompt_id still works.
    expect(acceptedPromptIds({ prompt_id: "p-a", prompt_ids: [null, 7, "", "  ", "p-b"] })).toEqual([
      "p-a",
      "p-b",
    ]);
    expect(acceptedPromptIds({ prompt_ids: "not-an-array" })).toEqual([]);
    expect(acceptedPromptIds(null)).toEqual([]);
  });

  it("#704: the ticket records the CONVERSATION that queued the run, not just the routed tab", async () => {
    // The tool session is bound to the shared conversation (#884), and the run is
    // routed to whichever tab is active. The journal needs BOTH: the tab is where
    // the completion will arrive from, the conversation is who gets to call it its
    // own — and only the second survives the panel re-registering under a new tab
    // id, which is what made an agent's own render come back "origin UNDETERMINED".
    const reply: ToolResult = {
      content: [
        { type: "text", text: JSON.stringify({ queued: true, batch_count: 1, prompt_id: "p-conv" }) },
      ],
    };
    const { ctx } = makeRunCtx(reply);
    ctx.tabId = "orchestrator::claude"; // the agent key this MCP session binds
    (ctx as { bridge: unknown }).bridge = {
      resolveSharedTabId: (scopeId?: string) =>
        scopeId === "orchestrator::claude" ? "tmp:active" : undefined,
    };
    const res = await defByName("panel_run").handler({}, ctx);
    expect(res.isError).toBeFalsy();
    const ticket = RunCompletions.ticketFor("p-conv");
    expect(ticket?.tabId).toBe("tmp:active");
    expect(ticket?.conversation).toBe("orchestrator::claude");
  });

  it("#468: a queue with NO prompt id does NOT promise automatic delivery — it says UNDETERMINED", async () => {
    // The panel forwards ComfyUI's /prompt reply; without a prompt_id there is
    // nothing to correlate a later completion to, so telling the agent to idle
    // and wait would park it on a promise the orchestrator cannot keep.
    const reply: ToolResult = {
      content: [{ type: "text", text: JSON.stringify({ queued: true, batch_count: 1 }) }],
    };
    const { ctx } = makeRunCtx(reply);
    const res = await defByName("panel_run").handler({}, ctx);
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).not.toContain(QUEUED_NOTE);
    expect(text).toContain("UNDETERMINED");
    expect(text).toContain("get_history");
  });
});

describe("panel-tools: detectRunRejection helper", () => {
  const { detectRunRejection } = __panelRunTestHooks;
  const jsonReply = (obj: unknown): ToolResult => ({
    content: [{ type: "text", text: JSON.stringify(obj) }],
  });

  it("returns null for a clean queued:true reply", () => {
    expect(detectRunRejection(jsonReply({ queued: true, batch_count: 1 }))).toBeNull();
  });

  it("returns null for an unparseable non-error reply (no regression)", () => {
    expect(detectRunRejection({ content: [{ type: "text", text: "plain ok" }] })).toBeNull();
  });

  it("flags a top-level error even alongside a stale queued:true", () => {
    const rej = detectRunRejection(
      jsonReply({ queued: true, error: { type: "missing_node_type", message: "boom" }, node_errors: {} }),
    );
    expect(rej?.isError).toBe(true);
  });

  it("passes an isError reply through verbatim", () => {
    const err: ToolResult = { content: [{ type: "text", text: "Error: boom" }], isError: true };
    expect(detectRunRejection(err)).toBe(err);
  });

  // #944 — ComfyUI's PARTIAL-validation path: some outputs fail, at least one
  // valid output remains, so it drops the bad ones ("Output will be ignored"),
  // MINTS A PROMPT ID, and runs the rest. The reply carries node_errors and a
  // prompt id together, and the #213 rule read that as a total refusal.
  //
  // What it cost: the agent was told nothing was queued while a render was
  // already running. It diagnosed a live graph, asked the user to mute a node
  // mid-render, and twice tried to "retry" — only the #556 graph-changed guard
  // stopped it double-queueing a 20-minute video.
  describe("#944: a minted prompt_id outranks the rejection signals", () => {
    const partial = {
      queued: true,
      prompt_id: "abc-123",
      node_errors: {
        "92": {
          class_type: "SaveVideo",
          errors: [{ message: "Exception when validating node", details: "'43069'" }],
        },
      },
    };

    it("does NOT report a refusal for a prompt ComfyUI accepted", () => {
      expect(detectRunRejection(jsonReply(partial))).toBeNull();
    });

    // A prompt id paired with a TOP-LEVEL error is a contradiction, not a
    // partial acceptance: the panel's own refusals (the #556/#772 run-to-node
    // race) arrive that way, and a prompt id there may be echoed from an earlier
    // run. Asserting either reading would be guessing, so it reports the conflict.
    it("a prompt id ALONGSIDE a top-level error is reported as uncertain, not as either", () => {
      const rej = detectRunRejection(
        jsonReply({ ...partial, error: { type: "prompt_outputs_failed_validation" } }),
      );
      expect(rej?.isError).toBe(true);
      const text = String(rej?.content?.[0]?.text ?? "");
      expect(text).toContain("[UNCERTAIN]");
      expect(text).toContain("abc-123");
      expect(text).toMatch(/Do NOT re-run/);
      // It must not resolve the conflict in either direction.
      expect(text).not.toMatch(/was queued successfully|nothing was queued$/i);
    });

    it("queued:false with a prompt id is uncertain too, never a clean queue", () => {
      const rej = detectRunRejection(jsonReply({ ...partial, queued: false }));
      expect(rej?.isError).toBe(true);
      expect(String(rej?.content?.[0]?.text ?? "")).toContain("[UNCERTAIN]");
    });

    // The #213 reply had NO prompt id, which is exactly why it still fails.
    it("still rejects when there is no prompt id (does not regress #213)", () => {
      expect(
        detectRunRejection(jsonReply({ queued: true, error: { type: "missing_node_type" } }))?.isError,
      ).toBe(true);
      expect(detectRunRejection(jsonReply({ queued: true, prompt_id: "" , error: { type: "x" } }))?.isError).toBe(true);
      expect(
        detectRunRejection(jsonReply({ queued: true, prompt_id: "   ", error: { type: "x" } }))?.isError,
      ).toBe(true);
    });

    it("an isError transport reply is still never a queue, prompt id or not", () => {
      const err: ToolResult = {
        content: [{ type: "text", text: JSON.stringify({ prompt_id: "abc" }) }],
        isError: true,
      };
      expect(detectRunRejection(err)).toBe(err);
    });
  });

  // Silence would be the opposite error: the caller would wait for a file that
  // is never written. The disclosure has to name the dropped outputs AND stop
  // the two harmful reflexes the report recorded (re-run, edit mid-render).
  describe("#944: the dropped outputs are disclosed on the success path", () => {
    const { describeDroppedOutputs } = __panelRunTestHooks;

    it("names the dropped output and what it means", () => {
      const note = describeDroppedOutputs({
        prompt_id: "abc-123",
        node_errors: {
          "92": { class_type: "SaveVideo", errors: [{ message: "Exception when validating node", details: "'43069'" }] },
        },
      });
      expect(note).toContain("ACCEPTED");
      expect(note).toContain("SaveVideo (node 92)");
      expect(note).toContain("'43069'");
      expect(note).toMatch(/Output will be ignored/);
      expect(note).toMatch(/Do NOT re-run/);
      expect(note).toMatch(/render is IN FLIGHT/);
    });

    it("says nothing for a clean run", () => {
      expect(describeDroppedOutputs({ prompt_id: "abc", queued: true })).toBe("");
      expect(describeDroppedOutputs({ prompt_id: "abc", node_errors: {} })).toBe("");
    });

    // Without a prompt id this is a real refusal, and detectRunRejection already
    // reports it. Emitting a "partial" note there would claim a queue that
    // does not exist — the #213 failure, re-created.
    it("says nothing when there is no prompt id", () => {
      expect(
        describeDroppedOutputs({ node_errors: { "92": { class_type: "SaveVideo", errors: [] } } }),
      ).toBe("");
      expect(describeDroppedOutputs(null)).toBe("");
    });

    // The contradiction case was reported as UNCERTAIN and never reaches the
    // success path; calling it an accepted-but-partial run would contradict that.
    it("says nothing for the uncertain (prompt id + top-level error) reply", () => {
      expect(
        describeDroppedOutputs({
          prompt_id: "abc",
          error: { type: "x" },
          node_errors: { "92": { class_type: "SaveVideo", errors: [] } },
        }),
      ).toBe("");
      expect(
        describeDroppedOutputs({
          prompt_id: "abc",
          queued: false,
          node_errors: { "92": { class_type: "SaveVideo", errors: [] } },
        }),
      ).toBe("");
    });
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
      "retry_of",
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
  // #809: the outline gained ONE optional argument — `max_chars`, deliberately the same
  // name and clamp as panel_query_graph's, so there is one budget concept to learn. It
  // stays argument-free for the "just show me the canvas" call.
  it("is registered and takes only the optional max_chars budget", () => {
    expect(buildPanelToolDefs().map((d) => d.name)).toContain("panel_graph_outline");
    expect(Object.keys(defByName("panel_graph_outline").schema)).toEqual(["max_chars"]);
  });

  it("forwards graph_outline", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_graph_outline").handler({}, ctx);
    expect(calls[0]).toMatchObject({ cmd: "graph_outline" });
  });

  it("forwards max_chars when the caller sets one", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_graph_outline").handler({ max_chars: 4000 }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "graph_outline", max_chars: 4000 });
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
    expect(Object.keys(def.schema)).toEqual(["group", "retry_of"]);
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

describe("panel-tools: single authoritative pin resolution (#259 wrong-tab)", () => {
  // A bridge whose workflow_list reports the OPEN tabs. Pinning must bind to the
  // authoritative record (canonical key), and FAIL CLOSED when the target isn't open.
  function listBridge(workflows: Array<Record<string, unknown>>, active?: Record<string, unknown>) {
    const sent: Record<string, unknown>[] = [];
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        sent.push(cmd);
        if (cmd.cmd === "workflow_list") return { workflows, active: active ?? workflows[0] };
        return { ok: true };
      },
      push: () => 1,
      canReach: () => true,
      resolveActiveTabId: () => "test-tab",
    } as unknown as PanelToolCtx["bridge"];
    return { bridge, sent };
  }

  it("canonicalizes a pin to the open workflow's stable key", async () => {
    const store = new WorkflowTargetStore();
    const { bridge } = listBridge([
      { path: "workflows/LTX.json", filename: "LTX.json", key: "wf-ltx-key" },
      { path: "workflows/krea.json", filename: "krea.json", key: "wf-krea-key" },
    ]);
    const ctx = makePanelToolCtx(bridge, "test-tab", store);
    const res = await defByName("panel_set_workflow_target").handler(
      { mode: "pinned", path: "workflows/LTX.json" },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    // Pin stored by canonical key so routing survives rename/reconnect (#259).
    expect(store.get("test-tab")).toMatchObject({ mode: "pinned", path: "wf-ltx-key" });
  });

  it("FAILS CLOSED when pinning to a workflow that is not open (never routes to another tab)", async () => {
    const store = new WorkflowTargetStore();
    const { bridge } = listBridge([
      { path: "workflows/krea.json", filename: "krea.json", key: "wf-krea-key" },
    ]);
    const ctx = makePanelToolCtx(bridge, "test-tab", store);
    const res = await defByName("panel_set_workflow_target").handler(
      { mode: "pinned", path: "workflows/LTX23_10Eros_KREA_StartFrame_I2V.json" },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/not open/i);
    // Nothing was pinned — the session stays on "current" rather than a wrong tab.
    expect(store.get("test-tab")).toMatchObject({ mode: "current" });
  });

  it("FAILS AT PIN TIME when the target is open but NOT the active canvas (#556) — no deferred mismatch", async () => {
    const store = new WorkflowTargetStore();
    // Two open tabs; the ACTIVE one is the Unsaved tab (workflows[1]). Pinning to the
    // BACKGROUND WAN workflow must be rejected up front — the panel can only edit the
    // in-view canvas, so accepting the pin would only defer a "workflow mismatch".
    const wan = { path: "workflows/Wan/WAN 2.2 SVI I2V.json", filename: "WAN 2.2 SVI I2V.json", key: "wf-wan", active: false };
    const unsaved = { path: null, filename: null, title: "Unsaved Workflow (2)", key: "tmp:uuid-active", active: true };
    const { bridge } = listBridge([wan, unsaved], unsaved);
    const ctx = makePanelToolCtx(bridge, "test-tab", store);
    const res = await defByName("panel_set_workflow_target").handler(
      { mode: "pinned", path: "workflows/Wan/WAN 2.2 SVI I2V.json" },
      ctx,
    );
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/not the active canvas/i);
    expect(text).toMatch(/Unsaved Workflow \(2\)/); // names the workflow actually in view
    expect(text).toMatch(/panel_open_workflow/); // actionable: switch to it first
    // Nothing was pinned — the session stays on "current" (never a silent background pin).
    expect(store.get("test-tab")).toMatchObject({ mode: "current" });
  });

  it("FAILS AT PIN TIME for an UNSAVED (persisted:false) background workflow (#571)", async () => {
    const store = new WorkflowTargetStore();
    // Workflow B is open but unsaved (persisted:false) and NOT active; A is active.
    const a = { path: "workflows/A.json", filename: "A.json", key: "wf-a", active: true, persisted: true };
    const b = { path: null, filename: null, title: "Unsaved Workflow", key: "tmp:uuid-b", active: false, persisted: false };
    const { bridge } = listBridge([a, b], a);
    const ctx = makePanelToolCtx(bridge, "test-tab", store);
    const res = await defByName("panel_set_workflow_target").handler(
      { mode: "pinned", path: "tmp:uuid-b" },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/not the active canvas/i);
    expect(store.get("test-tab")).toMatchObject({ mode: "current" });
  });

  it("PINS SUCCESSFULLY when the target IS the active canvas (positive control)", async () => {
    const store = new WorkflowTargetStore();
    const a = { path: "workflows/A.json", filename: "A.json", key: "wf-a", active: true };
    const b = { path: "workflows/B.json", filename: "B.json", key: "wf-b", active: false };
    const { bridge } = listBridge([a, b], a);
    const ctx = makePanelToolCtx(bridge, "test-tab", store);
    const res = await defByName("panel_set_workflow_target").handler(
      { mode: "pinned", path: "workflows/A.json" },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(store.get("test-tab")).toMatchObject({ mode: "pinned", path: "wf-a" });
  });

  it("stays LENIENT (pins) when the list carries NO active signal — indeterminate, not background (#556 P1b)", async () => {
    const store = new WorkflowTargetStore();
    // Enumerable list but neither a usable active object NOR per-record `active` flags:
    // active-ness is INDETERMINATE, so a valid pin must NOT be rejected (older/partial panel).
    const x = { path: "workflows/x.json", filename: "x.json", key: "kx" };
    const { bridge } = listBridge([x], {} as Record<string, unknown>);
    const ctx = makePanelToolCtx(bridge, "test-tab", store);
    const res = await defByName("panel_set_workflow_target").handler(
      { mode: "pinned", path: "workflows/x.json" },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(store.get("test-tab")).toMatchObject({ mode: "pinned", path: "kx" });
  });

  it("stays LENIENT when record and active object share NO comparable identity field (indeterminate, not background)", async () => {
    const store = new WorkflowTargetStore();
    // Record exposes only path/filename (no key); active object exposes only a key.
    // There is no comparable dimension, so active-ness is INDETERMINATE — a valid pin
    // must NOT be rejected as "background" (would regress older/partial-panel compat).
    const rec = { path: "workflows/y.json", filename: "y.json" };
    const { bridge } = listBridge([rec], { key: "k-something-else" } as Record<string, unknown>);
    const ctx = makePanelToolCtx(bridge, "test-tab", store);
    const res = await defByName("panel_set_workflow_target").handler(
      { mode: "pinned", path: "workflows/y.json" },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    // No key to canonicalize to → pins the raw path (lenient).
    expect(store.get("test-tab")).toMatchObject({ mode: "pinned", path: "workflows/y.json" });
  });

  it("duplicate filename across tabs: pins the ACTIVE same-name tab, not a background one (#556 P1a)", async () => {
    const store = new WorkflowTargetStore();
    // Two tabs share filename "dup.json" (different dirs). The ACTIVE one is dir2.
    const bg = { path: "workflows/dir1/dup.json", filename: "dup.json", key: "k-bg", active: false };
    const live = { path: "workflows/dir2/dup.json", filename: "dup.json", key: "k-live", active: true };
    const { bridge } = listBridge([bg, live], live);
    const ctx = makePanelToolCtx(bridge, "test-tab", store);
    const res = await defByName("panel_set_workflow_target").handler(
      { mode: "pinned", path: "dup.json" },
      ctx,
    );
    // A filename-only token matches BOTH; the resolver disambiguates to the active
    // record and pins it — never silently binds the background same-name tab.
    expect(res.isError).toBeFalsy();
    expect(store.get("test-tab")).toMatchObject({ mode: "pinned", path: "k-live" });
  });

  it("live-canvas capture (graph_serialize) carries the pinned workflow_path, not the visible tab", async () => {
    const store = new WorkflowTargetStore();
    store.set("test-tab", { mode: "pinned", path: "wf-pinned-key" });
    const sent: Record<string, unknown>[] = [];
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        sent.push(cmd);
        if (cmd.cmd === "graph_serialize") return { workflow: { nodes: [], links: [] } };
        return { ok: true };
      },
      push: () => 1,
      canReach: () => true,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "test-tab", store);
    // No pack/path/graph args ⇒ resolveWorkflowInput captures the live canvas.
    await defByName("panel_flatten_workflow").handler({}, ctx);
    const serialize = sent.find((c) => c.cmd === "graph_serialize");
    expect(serialize).toBeDefined();
    // The direct bridge.send must inject the pin so it reads the PINNED workflow.
    expect(serialize).toMatchObject({ workflow_path: "wf-pinned-key" });
  });

  it("panel_screenshot carries the pinned workflow_path (direct graph_screenshot send)", async () => {
    const store = new WorkflowTargetStore();
    store.set("test-tab", { mode: "pinned", path: "wf-pinned-key" });
    const sent: Record<string, unknown>[] = [];
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        sent.push(cmd);
        return { image: "iVBORw0KGgo=", mimeType: "image/png" };
      },
      push: () => 1,
      canReach: () => true,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "test-tab", store);
    await defByName("panel_screenshot").handler({}, ctx);
    expect(sent[0]).toMatchObject({ cmd: "graph_screenshot", workflow_path: "wf-pinned-key" });
  });
});

describe("panel-tools: post-reconnect retry-once (#278/#310/#332/#481)", () => {
  beforeAll(() => __panelToolsTestHooks.setRetrySettleMs(0));
  afterAll(() => __panelToolsTestHooks.setRetrySettleMs(null));

  // A bridge that DROPS the first send (the tab was replaced under a new id during a
  // reboot/free_vram/reconnect), then serves the reconnected tab on the retry.
  function droppingBridge() {
    const sent: Array<{ cmd: Record<string, unknown>; tabId?: string }> = [];
    let live = new Set(["old-tab"]);
    let dropsLeft = 1;
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
        const id = opts?.tabId;
        if (dropsLeft > 0) {
          dropsLeft--;
          live = new Set(["new-tab"]); // the tab reconnected under a fresh id
          throw new Error(`no connected tab with id "${id}". Connected: none`);
        }
        if (id && !live.has(id)) throw new Error(`no connected tab with id "${id}"`);
        sent.push({ cmd, tabId: id });
        return { ok: true, routedTo: id };
      },
      push: () => 1,
      canReach: (id: string) => live.has(id),
      resolveActiveTabId: () => {
        if (live.size === 1) return [...live][0];
        if (live.size === 0) throw new Error("Panel not reachable: no panel connected");
        throw new Error("Multiple panel tabs are connected and none is last active — pass tab_id.");
      },
    } as unknown as PanelToolCtx["bridge"];
    return { bridge, sent };
  }

  it("idempotent read (graph_get_errors) rebinds and succeeds after a mid-command drop (#310)", async () => {
    const store = new WorkflowTargetStore();
    const { bridge, sent } = droppingBridge();
    const ctx = makePanelToolCtx(bridge, "old-tab", store);
    const res = await defByName("panel_get_errors").handler({}, ctx);
    expect(res.isError).toBeFalsy();
    expect(ctx.tabId).toBe("new-tab"); // rebound onto the reconnected tab
    expect(sent.at(-1)?.tabId).toBe("new-tab");
  });

  it("idempotent UI write (set_todo) survives a post-restart reconnect race (#481)", async () => {
    const store = new WorkflowTargetStore();
    const { bridge, sent } = droppingBridge();
    const ctx = makePanelToolCtx(bridge, "old-tab", store);
    const res = await defByName("panel_set_todo").handler({ items: [] }, ctx);
    expect(res.isError).toBeFalsy();
    expect(sent.at(-1)?.cmd).toMatchObject({ cmd: "set_todo" });
    expect(sent.at(-1)?.tabId).toBe("new-tab");
  });

  it("Manager-backed list (nodes_list) retries a bare Failed-to-fetch during reconnect (#332)", async () => {
    const store = new WorkflowTargetStore();
    const sent: Array<{ tabId?: string }> = [];
    let dropsLeft = 1;
    let live = new Set(["old-tab"]);
    const bridge = {
      send: async (_cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
        if (dropsLeft > 0) {
          dropsLeft--;
          live = new Set(["new-tab"]);
          throw new Error("Failed to fetch");
        }
        sent.push({ tabId: opts?.tabId });
        return { nodes: [] };
      },
      push: () => 1,
      canReach: (id: string) => live.has(id),
      resolveActiveTabId: () => [...live][0],
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "old-tab", store);
    const res = await defByName("panel_list_nodes").handler({}, ctx);
    expect(res.isError).toBeFalsy();
    expect(sent.at(-1)?.tabId).toBe("new-tab");
  });

  it("MUTATING edit (graph_add_node) is NOT retried — no double-apply — and errors clearly", async () => {
    const store = new WorkflowTargetStore();
    const { bridge, sent } = droppingBridge();
    const ctx = makePanelToolCtx(bridge, "old-tab", store);
    const res = await defByName("panel_add_node").handler({ class_type: "KSampler" }, ctx);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/no connected tab/i);
    // The drop happened before any successful send — nothing was applied twice.
    expect(sent.length).toBe(0);
  });

  // Real-bridge behavior: with 2+ live tabs, resolveActiveTabId falls back to
  // lastActiveTabId (does NOT throw). The SILENT auto-heal must NOT ride that
  // fallback onto an unrelated tab — it must be strict-single (codex FAIL fix).
  function multiTabBridge(liveTabs: string[], lastActive: string) {
    const sent: Array<{ cmd: Record<string, unknown>; tabId?: string }> = [];
    const live = new Set(liveTabs);
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
        const id = opts?.tabId;
        if (id && !live.has(id)) throw new Error(`no connected tab with id "${id}". Connected: none`);
        sent.push({ cmd, tabId: id });
        return { ok: true, routedTo: id };
      },
      push: () => 1,
      canReach: (id: string) => live.has(id),
      tabs: () => liveTabs.map((t) => ({ tab_id: t, title: t, connected_at: 0 })),
      // Mirrors the REAL bridge: returns last-active for 2+ tabs (no throw).
      resolveActiveTabId: () => lastActive,
    } as unknown as PanelToolCtx["bridge"];
    return { bridge, sent };
  }

  it("does NOT silently auto-heal onto last-active among MULTIPLE live tabs (#265/#210 wrong-tab)", async () => {
    const store = new WorkflowTargetStore();
    // Session's own tab is dead; two OTHER tabs are live with a last-active fallback.
    const { bridge, sent } = multiTabBridge(["wan-tab", "flux-tab"], "flux-tab");
    const ctx = makePanelToolCtx(bridge, "dead-session-tab", store);
    const res = await defByName("panel_get_errors").handler({}, ctx);
    // Strict-single: refuses to guess, so the call errors instead of routing to flux.
    expect(res.isError).toBe(true);
    expect(ctx.tabId).toBe("dead-session-tab"); // never hijacked onto last-active
    expect(sent.length).toBe(0);
  });

  it("panel_reload refuses to guess among multiple live tabs when orphaned", async () => {
    const store = new WorkflowTargetStore();
    const { bridge } = multiTabBridge(["a-tab", "b-tab"], "b-tab");
    const ctx = makePanelToolCtx(bridge, "dead-session-tab", store);
    const res = await defByName("panel_reload").handler({}, ctx);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/multiple tabs/i);
  });

  // Regression (panel #478): panel_reload's ambiguity guard must invoke isHeadless
  // THROUGH the bridge, not via a detached `const headless = ctx.bridge.isHeadless`.
  // The real UiBridge.isHeadless is a plain method that reads `this.conns`; called
  // unbound its `this` is undefined and it threw "Cannot read properties of undefined
  // (reading 'conns')", so panel_reload failed outright instead of reloading. The fake
  // bridges above never set `isHeadless`, so they skipped the filter and never caught
  // this — this bridge mirrors the real one (method-form isHeadless over `this.conns`).
  function methodIsHeadlessBridge(liveTabs: string[]) {
    const sent: Array<{ cmd: Record<string, unknown>; tabId?: string }> = [];
    const live = new Set(liveTabs);
    const bridge = {
      // `conns` + method-form isHeadless: extracting the method and calling it
      // unbound (the #478 bug) throws on `this.conns`; calling it bound works.
      conns: new Map<string, { headless?: boolean }>(liveTabs.map((t) => [t, {}])),
      isHeadless(id: string): boolean {
        return this.conns.get(id)?.headless === true;
      },
      send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
        const id = opts?.tabId;
        if (id && !live.has(id)) throw new Error(`no connected tab with id "${id}". Connected: none`);
        sent.push({ cmd, tabId: id });
        return { ok: true, routedTo: id };
      },
      push: () => 1,
      canReach: (id: string) => live.has(id),
      tabs: () => liveTabs.map((t) => ({ tab_id: t, title: t, connected_at: 0 })),
      // Mirror the real UiBridge: a sole tab resolves; 2+ throw the ambiguity error
      // (so a rebind attempt lands in the recovery catch that also filters isHeadless).
      resolveActiveTabId: () => {
        if (liveTabs.length === 1) return liveTabs[0];
        throw new Error("Multiple panel tabs are connected and none is last active — pass tab_id.");
      },
    } as unknown as PanelToolCtx["bridge"];
    return { bridge, sent };
  }

  it("panel_reload does not crash on a method-form isHeadless bridge (#478 unbound `this.conns`)", async () => {
    const store = new WorkflowTargetStore();
    // Two live non-headless tabs + an orphaned session → the ambiguity guard runs the
    // interactive-tab filter, which is exactly where the unbound isHeadless call sat.
    const { bridge } = methodIsHeadlessBridge(["a-tab", "b-tab"]);
    const ctx = makePanelToolCtx(bridge, "dead-session-tab", store);
    const res = await defByName("panel_reload").handler({}, ctx);
    // Must reach the clear multi-tab error, NOT throw "reading 'conns'".
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/multiple tabs/i);
    expect((res.content[0] as { text: string }).text).not.toMatch(/conns/i);
  });

  it("panel_reload rebinds+forwards on a method-form isHeadless bridge with one live tab (#478)", async () => {
    const store = new WorkflowTargetStore();
    // Single live tab: the filter still calls isHeadless (must not crash), the session
    // rebinds onto it, and soft_reload is forwarded there.
    const { bridge, sent } = methodIsHeadlessBridge(["only-live-tab"]);
    const ctx = makePanelToolCtx(bridge, "orphaned-tab", store);
    const res = await defByName("panel_reload").handler({}, ctx);
    expect(res.isError).toBeUndefined();
    expect(ctx.tabId).toBe("only-live-tab");
    expect(sent.at(-1)).toMatchObject({
      cmd: { cmd: "soft_reload", scope: "orchestrator" },
      tabId: "only-live-tab",
    });
  });

  it("panel_reload (orchestrator scope) states that the panel_* tool process was NOT reloaded (#765)", async () => {
    // #765: an agent that patched orchestrator/service code called panel_reload
    // and then reported the change as live — but the panel_* tools run inside
    // the long-lived orchestrator process a soft reload never restarts. The
    // tool result (the agent's last context before the bounce, and read again
    // after the resume) must say so.
    const store = new WorkflowTargetStore();
    const { bridge } = methodIsHeadlessBridge(["only-live-tab"]);
    const ctx = makePanelToolCtx(bridge, "orphaned-tab", store);
    const res = await defByName("panel_reload").handler({}, ctx);
    expect(res.isError).toBeUndefined();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/does NOT reload/i);
    expect(text).toMatch(/orchestrator process must be restarted/);
  });

  it("panel_reload (frontend scope) does NOT append the orchestrator disclosure", async () => {
    // A frontend reload leaves the agent process untouched, so the "your agent
    // restarts fresh" framing would be wrong there.
    const store = new WorkflowTargetStore();
    const { bridge } = methodIsHeadlessBridge(["only-live-tab"]);
    const ctx = makePanelToolCtx(bridge, "orphaned-tab", store);
    const res = await defByName("panel_reload").handler({ scope: "frontend" }, ctx);
    expect(res.isError).toBeUndefined();
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toMatch(/does NOT reload/i);
  });

  it("panel_set_workflow_target recovery filters isHeadless bound, not detached (#478 sibling site)", async () => {
    const store = new WorkflowTargetStore();
    // Dead session + 2 ambiguous live non-headless tabs → rebindToActiveTab throws, and
    // the catch's interactive-tab filter runs isHeadless. Detached, it threw "reading
    // 'conns'"; bound, it counts 2 interactive tabs and returns the clear ambiguity error.
    const { bridge } = methodIsHeadlessBridge(["a-tab", "b-tab"]);
    const ctx = makePanelToolCtx(bridge, "dead-session-tab", store);
    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).not.toMatch(/conns/i);
    expect((res.content[0] as { text: string }).text).toMatch(/multiple|last active|pass tab_id/i);
  });

  // #884 confirming gate 3, P0 — the scope-repin double gate. A SCOPE-bound ctx
  // (shared conversation) is repinned ONLY by the explicit
  // panel_set_workflow_target({mode:"current"}) consent AND only when the pin is
  // provably dead; panel_reload is NOT a consent path. (The full path — real
  // UiBridge, real tracker, real repin handler — is driven in ui-bridge.test.ts;
  // these pin the panel-tools gate itself on a stub bridge.)
  describe("scope-bound ctx: repin consent gate (#884 gate 3)", () => {
    function scopeBridge(opts: { reachable: boolean }) {
      const sent: Array<{ cmd: Record<string, unknown>; tabId?: string }> = [];
      const repinCalls: string[] = [];
      const bridge = {
        send: async (cmd: Record<string, unknown>, sendOpts?: { tabId?: string }) => {
          if (!opts.reachable) {
            throw new Error(`no connected tab with id "${sendOpts?.tabId}". Connected: none`);
          }
          sent.push({ cmd, tabId: sendOpts?.tabId });
          return { ok: true };
        },
        push: () => 1,
        canReach: () => opts.reachable,
        tabs: () => [{ tab_id: "live-tab", title: "wf", connected_at: 0 }],
        isHeadless: () => false,
        resolveActiveTabId: () => "live-tab",
        repinScopeToActive: (scopeId: string) => {
          repinCalls.push(scopeId);
          return "live-tab";
        },
      } as unknown as PanelToolCtx["bridge"];
      return { bridge, sent, repinCalls };
    }

    it("panel_reload NEVER repins a scope ctx — healthy binding forwards to the scope untouched", async () => {
      const { bridge, sent, repinCalls } = scopeBridge({ reachable: true });
      const ctx = makePanelToolCtx(bridge, "orchestrator::claude", new WorkflowTargetStore());
      const res = await defByName("panel_reload").handler({ scope: "frontend" }, ctx);
      expect(res.isError).toBeFalsy();
      expect(repinCalls).toHaveLength(0); // the healthy turn was not re-aimed
      expect(ctx.tabId).toBe("orchestrator::claude"); // never narrowed to a real tab
      expect(sent.at(-1)).toMatchObject({
        cmd: { cmd: "soft_reload", scope: "frontend" },
        tabId: "orchestrator::claude",
      });
    });

    it("panel_reload on a DEAD scope pin FAILS naming the explicit recovery — no silent repin", async () => {
      const { bridge, repinCalls } = scopeBridge({ reachable: false });
      const ctx = makePanelToolCtx(bridge, "orchestrator::claude", new WorkflowTargetStore());
      const res = await defByName("panel_reload").handler({}, ctx);
      expect(res.isError).toBe(true);
      expect((res.content[0] as { text: string }).text).toMatch(
        /panel_set_workflow_target\(\{mode:"current"\}\)/,
      );
      expect(repinCalls).toHaveLength(0);
    });

    it("rebindToActiveTab repins a scope ctx ONLY with consent AND a provably dead pin", () => {
      // Healthy + consent → no repin (recovery only, never a re-target).
      const healthy = scopeBridge({ reachable: true });
      const healthyCtx = makePanelToolCtx(healthy.bridge, "orchestrator::claude", new WorkflowTargetStore());
      expect(healthyCtx.rebindToActiveTab!({ scopeRecoveryConsent: true })).toMatchObject({
        rebound: false,
      });
      expect(healthy.repinCalls).toHaveLength(0);
      // Dead + NO consent → no repin (implicit callers can never re-aim a turn).
      const dead = scopeBridge({ reachable: false });
      const deadCtx = makePanelToolCtx(dead.bridge, "orchestrator::claude", new WorkflowTargetStore());
      expect(deadCtx.rebindToActiveTab!()).toMatchObject({ rebound: false });
      expect(dead.repinCalls).toHaveLength(0);
      // Dead + consent → the one recovery path, and the ctx STAYS scope-bound.
      expect(deadCtx.rebindToActiveTab!({ scopeRecoveryConsent: true })).toMatchObject({
        rebound: true,
        current: "orchestrator::claude",
      });
      expect(dead.repinCalls).toEqual(["orchestrator::claude"]);
      expect(deadCtx.tabId).toBe("orchestrator::claude");
    });
  });

  it("a genuinely-gone tab (no reconnect) still fails clearly after the single retry", async () => {
    const store = new WorkflowTargetStore();
    // Nothing ever becomes live — retry can't rebind, so it must surface an error.
    const bridge = {
      send: async (_cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
        throw new Error(`no connected tab with id "${opts?.tabId}". Connected: none`);
      },
      push: () => 1,
      canReach: () => false,
      resolveActiveTabId: () => {
        throw new Error("Panel not reachable: no panel connected");
      },
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "gone-tab", store);
    const res = await defByName("panel_get_errors").handler({}, ctx);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/reconnect|no connected tab/i);
  });
});

describe("panel-tools: desktop-canvas fall-through for headless-bound sessions (#624)", () => {
  // The mobile / remote pseudo-panel is a HEADLESS bridge client: it accepts only
  // show_media and rejects every other ServerCommand with "mobile client has no open
  // canvas". A DESKTOP panel surface command (set_todo footer tray, open_civitai
  // in-panel browser) must therefore NOT be dispatched at a headless client — it must
  // resolve the live desktop canvas tab (the same canvas-owning filter graph tools
  // use) when the session's bound tab is headless, and fail with the REAL reason when
  // no single canvas can be picked — never surface the misleading mobile string.
  //
  // `lastActive` mirrors the real UiBridge.resolveActiveTabId: a sole tab resolves,
  // an explicit last-active id resolves among 2+, otherwise it throws the ambiguity.
  function headlessAwareBridge(
    tabs: Array<{ id: string; headless: boolean }>,
    lastActive?: string,
  ) {
    const sent: Array<{ cmd: Record<string, unknown>; tabId?: string }> = [];
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
        const id = opts?.tabId;
        if (id && !byId.has(id)) {
          throw new Error(`no connected tab with id "${id}". Connected: none`);
        }
        sent.push({ cmd, tabId: id });
        return { ok: true, routedTo: id };
      },
      push: () => 1,
      isHeadless: (id: string) => byId.get(id)?.headless === true,
      canReach: (id: string) => byId.has(id),
      tabs: () => tabs.map((t) => ({ tab_id: t.id, title: t.id, connected_at: 0 })),
      resolveActiveTabId: () => {
        if (lastActive) return lastActive;
        if (tabs.length === 1) return tabs[0].id;
        throw new Error("Multiple panel tabs are connected and none is last active — pass tab_id.");
      },
    } as unknown as PanelToolCtx["bridge"];
    return { bridge, sent };
  }

  const MOBILE_ERR = /mobile client has no open canvas/i;

  beforeAll(() => __panelToolsTestHooks.setRetrySettleMs(0));
  afterAll(() => __panelToolsTestHooks.setRetrySettleMs(null));

  it("panel_set_todo redirects onto the live desktop canvas when the session is bound to a headless tab", async () => {
    const store = new WorkflowTargetStore();
    const { bridge, sent } = headlessAwareBridge([
      { id: "mobile-tab", headless: true },
      { id: "desktop-tab", headless: false },
    ]);
    // Session bound to the headless mobile tab, but a real desktop canvas is open.
    const ctx = makePanelToolCtx(bridge, "mobile-tab", store);
    const res = await defByName("panel_set_todo").handler(
      { items: [{ text: "step 1", status: "active" }] },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect((res.content[0] as { text: string }).text).not.toMatch(MOBILE_ERR);
    // Dispatched at the DESKTOP canvas, not the headless mobile tab.
    expect(sent.at(-1)).toMatchObject({ cmd: { cmd: "set_todo" }, tabId: "desktop-tab" });
    // The session's own binding is left intact (no silent hijack of ctx.tabId).
    expect(ctx.tabId).toBe("mobile-tab");
  });

  it("panel_open_civitai redirects onto the live desktop canvas when the session is bound to a headless tab", async () => {
    const store = new WorkflowTargetStore();
    const { bridge, sent } = headlessAwareBridge([
      { id: "mobile-tab", headless: true },
      { id: "desktop-tab", headless: false },
    ]);
    const ctx = makePanelToolCtx(bridge, "mobile-tab", store);
    const res = await defByName("panel_open_civitai").handler(
      { tab: "loras", browsingLevels: [1, 2] },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect((res.content[0] as { text: string }).text).not.toMatch(MOBILE_ERR);
    expect(sent.at(-1)).toMatchObject({ cmd: { cmd: "open_civitai" }, tabId: "desktop-tab" });
    expect(ctx.tabId).toBe("mobile-tab");
  });

  it("fails with the REAL reason (not the mobile string) when the ONLY client is canvas-less", async () => {
    const store = new WorkflowTargetStore();
    const { bridge, sent } = headlessAwareBridge([{ id: "mobile-tab", headless: true }]);
    const ctx = makePanelToolCtx(bridge, "mobile-tab", store);
    const res = await defByName("panel_set_todo").handler({ items: [] }, ctx);
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toMatch(MOBILE_ERR);
    expect(text).toMatch(/canvas-less|desktop panel canvas|comfyui browser tab/i);
    // Nothing was blasted at the headless client.
    expect(sent.length).toBe(0);
  });

  it("leaves a normal desktop-bound session on the standard ctx.call path (no redirect)", async () => {
    const store = new WorkflowTargetStore();
    const { bridge, sent } = headlessAwareBridge([{ id: "desktop-tab", headless: false }]);
    const ctx = makePanelToolCtx(bridge, "desktop-tab", store);
    const res = await defByName("panel_set_todo").handler({ items: [] }, ctx);
    expect(res.isError).toBeFalsy();
    expect(sent.at(-1)).toMatchObject({ cmd: { cmd: "set_todo" }, tabId: "desktop-tab" });
  });

  it("redirects onto the LAST-ACTIVE desktop canvas among multiple desktop tabs", async () => {
    const store = new WorkflowTargetStore();
    const { bridge, sent } = headlessAwareBridge(
      [
        { id: "mobile-tab", headless: true },
        { id: "desktop-a", headless: false },
        { id: "desktop-b", headless: false },
      ],
      "desktop-b", // last-active is an interactive desktop tab
    );
    const ctx = makePanelToolCtx(bridge, "mobile-tab", store);
    const res = await defByName("panel_set_todo").handler({ items: [] }, ctx);
    expect(res.isError).toBeFalsy();
    expect(sent.at(-1)).toMatchObject({ cmd: { cmd: "set_todo" }, tabId: "desktop-b" });
  });

  it("fails with an ACCURATE ambiguity error (not the mobile string) when 2+ desktop tabs and none is last-active", async () => {
    const store = new WorkflowTargetStore();
    // Headless-bound + two desktop tabs + resolveActiveTabId throws (no last-active):
    // must NOT fall through to ctx.call (that would re-dispatch at the headless tab and
    // reproduce the mobile string) — it must fail with the real multi-desktop reason.
    const { bridge, sent } = headlessAwareBridge([
      { id: "mobile-tab", headless: true },
      { id: "desktop-a", headless: false },
      { id: "desktop-b", headless: false },
    ]);
    const ctx = makePanelToolCtx(bridge, "mobile-tab", store);
    const res = await defByName("panel_open_civitai").handler({}, ctx);
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toMatch(MOBILE_ERR);
    expect(text).toMatch(/multiple desktop tabs|pick one/i);
    expect(sent.length).toBe(0);
  });

  it("retry-safe set_todo redirect recovers from a transient drop by re-resolving the desktop tab (#481 parity)", async () => {
    const store = new WorkflowTargetStore();
    const sent: Array<{ cmd: Record<string, unknown>; tabId?: string }> = [];
    // Bound to a headless tab. The desktop tab drops mid-send once (throws a transient
    // "no connected tab") then reconnects under a NEW id — the redirect must re-resolve
    // and retry the idempotent set_todo onto the reconnected desktop tab.
    let liveDesktop = "desktop-old";
    let dropsLeft = 1;
    const headlessId = "mobile-tab";
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
        if (dropsLeft > 0) {
          dropsLeft--;
          liveDesktop = "desktop-new";
          throw new Error(`no connected tab with id "${opts?.tabId}". Connected: none`);
        }
        sent.push({ cmd, tabId: opts?.tabId });
        return { ok: true, routedTo: opts?.tabId };
      },
      push: () => 1,
      isHeadless: (id: string) => id === headlessId,
      canReach: (id: string) => id === headlessId || id === liveDesktop,
      tabs: () => [
        { tab_id: headlessId, title: "mobile", connected_at: 0 },
        { tab_id: liveDesktop, title: "desktop", connected_at: 0 },
      ],
      resolveActiveTabId: () => liveDesktop,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, headlessId, store);
    const res = await defByName("panel_set_todo").handler({ items: [] }, ctx);
    expect(res.isError).toBeFalsy();
    // Re-resolved onto the RECONNECTED desktop tab, not the stale id or the headless tab.
    expect(sent.at(-1)).toMatchObject({ cmd: { cmd: "set_todo" }, tabId: "desktop-new" });
  });
});

describe("panel-tools: session tabId self-heal (#322 reload / #331 workflow-switch / #332 reconnect)", () => {
  // A minimal fake bridge modelling the ONE fact that matters: which tab ids are
  // currently live. `send` routes only to a live id (throws `no connected tab`
  // otherwise, exactly like UiBridge.resolveTarget); canReach/resolveActiveTabId
  // mirror the real bridge's no-throw / no-tabId helpers.
  function fakeBridge(live: Set<string>) {
    const sent: Array<{ cmd: Record<string, unknown>; tabId?: string }> = [];
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
        const id = opts?.tabId;
        if (id && !live.has(id)) throw new Error(`no connected tab with id "${id}"`);
        sent.push({ cmd, tabId: id });
        return { ok: true, routedTo: id };
      },
      push: () => 1,
      canReach: (tabId: string) => live.has(tabId),
      resolveActiveTabId: () => {
        if (live.size === 1) return [...live][0];
        if (live.size === 0) throw new Error("Panel not reachable: no panel connected");
        throw new Error("Multiple panel tabs are connected and none is last active — pass tab_id.");
      },
    } as unknown as PanelToolCtx["bridge"];
    return { bridge, sent };
  }

  it("panel_set_workflow_target({mode:'current'}) rebinds a DEAD session onto the sole live tab; calls then succeed", async () => {
    const store = new WorkflowTargetStore();
    // Only the NEW tab is live; the session was created bound to the old (dead) id.
    const { bridge, sent } = fakeBridge(new Set(["new-live-tab"]));
    const ctx = makePanelToolCtx(bridge, "dead-old-tab", store);

    // Explicit rebind (no prior graph call, so auto-heal hasn't fired yet).
    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    expect(res.isError).toBeUndefined();
    expect(ctx.tabId).toBe("new-live-tab");
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("Rebound this session");

    // After rebind, subsequent panel_* calls route to the live tab and succeed.
    const after = await defByName("panel_graph_outline").handler({}, ctx);
    expect(after.isError).toBeUndefined();
    expect(sent.at(-1)?.tabId).toBe("new-live-tab");
  });

  // #934 — the note above used `.slice(0, 8)`, which renders EVERY
  // `wf:workflows/…` tab as the literal "wf:workf". The reporter read
  // "Rebound this session from tab wf:workf onto the active tab wf:workf"
  // during a wedge whose entire question was whether the retarget had done
  // anything — a real rebind between two different workflows, described as a
  // no-op. Two different tabs must not render identically.
  it("names workflow-keyed tabs distinguishably in the rebind note", async () => {
    const store = new WorkflowTargetStore();
    const from = "wf:workflows/Untitled 2026-08-06 03-58-41.json";
    const onto = "wf:workflows/portrait-v3.json";
    // The defect, stated: these are indistinguishable under the old rendering.
    expect(from.slice(0, 8)).toBe(onto.slice(0, 8));

    const { bridge } = fakeBridge(new Set([onto]));
    const ctx = makePanelToolCtx(bridge, from, store);
    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);

    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("Rebound this session");
    expect(text).toContain("portrait-v3.json");
    expect(text).toContain("Untitled 2026-08-06 03-58-41.json");
    // …and the collapsed rendering is gone.
    expect(text).not.toContain("from tab wf:workf onto the active tab wf:workf");
  });

  // ---- Auto-heal: an orphaned current-mode session self-recovers on the next
  // panel_* call, WITHOUT an explicit panel_set_workflow_target (#372/#178/#170/
  // #165/#166/#195). Conservative: only when the current tab is unreachable AND a
  // single active tab is unambiguous; healthy and pinned sessions stay strict.
  it("auto-heals a DEAD current-mode session onto the sole live tab on the next call", async () => {
    const store = new WorkflowTargetStore();
    const { bridge, sent } = fakeBridge(new Set(["reconnected-tab"]));
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", store);

    // No explicit rebind — a plain graph call recovers on its own.
    const res = await defByName("panel_graph_outline").handler({}, ctx);
    expect(res.isError).toBeUndefined();
    expect(ctx.tabId).toBe("reconnected-tab");
    expect(sent.at(-1)?.tabId).toBe("reconnected-tab");
  });

  it("does NOT auto-heal a HEALTHY session (no hijack of a live multi-tab deployment)", async () => {
    const store = new WorkflowTargetStore();
    const { bridge, sent } = fakeBridge(new Set(["my-tab", "other-tab"]));
    const ctx = makePanelToolCtx(bridge, "my-tab", store);

    const res = await defByName("panel_graph_outline").handler({}, ctx);
    expect(res.isError).toBeUndefined();
    expect(ctx.tabId).toBe("my-tab");
    expect(sent.at(-1)?.tabId).toBe("my-tab");
  });

  it("does NOT auto-heal a PINNED session — it keeps requiring explicit rebind", async () => {
    const store = new WorkflowTargetStore();
    store.set("dead-pinned-tab", { mode: "pinned", path: "workflows/keep.json" });
    const { bridge } = fakeBridge(new Set(["some-live-tab"]));
    const ctx = makePanelToolCtx(bridge, "dead-pinned-tab", store);

    const res = await defByName("panel_graph_outline").handler({}, ctx);
    // Pinned + dead tab: no silent rebind, so the call surfaces the clear error.
    expect(res.isError).toBe(true);
    expect(ctx.tabId).toBe("dead-pinned-tab");
  });

  it("does NOT auto-heal into an AMBIGUOUS multi-tab set (dead tab, 2+ live, no last-active)", async () => {
    const store = new WorkflowTargetStore();
    const { bridge } = fakeBridge(new Set(["a", "b"]));
    const ctx = makePanelToolCtx(bridge, "dead-tab", store);

    const res = await defByName("panel_graph_outline").handler({}, ctx);
    expect(res.isError).toBe(true); // bridge's own "no connected tab" error
    expect(ctx.tabId).toBe("dead-tab"); // never silently hijacked
  });

  it("auto-heals the direct-send adult-consent path (#372)", async () => {
    const store = new WorkflowTargetStore();
    const { bridge, sent } = fakeBridge(new Set(["live-again-tab"]));
    const ctx = makePanelToolCtx(bridge, "orphaned-tab", store);

    await defByName("panel_request_adult_consent").handler({}, ctx);
    expect(ctx.tabId).toBe("live-again-tab");
    // The ask_user consent card went to the healed tab, not the dead one.
    expect(sent.at(-1)?.tabId).toBe("live-again-tab");
  });

  it("panel_reload rebinds a DEAD session onto the sole live tab, then forwards soft_reload there", async () => {
    const store = new WorkflowTargetStore();
    const { bridge, sent } = fakeBridge(new Set(["reconnected-tab"]));
    const ctx = makePanelToolCtx(bridge, "orphaned-tab", store);

    const res = await defByName("panel_reload").handler({}, ctx);
    expect(res.isError).toBeUndefined();
    expect(ctx.tabId).toBe("reconnected-tab");
    expect(sent.at(-1)).toMatchObject({
      cmd: { cmd: "soft_reload", scope: "orchestrator" },
      tabId: "reconnected-tab",
    });
  });

  it("does NOT disturb a HEALTHY session: mode:'current' leaves a still-live tabId in place", async () => {
    const store = new WorkflowTargetStore();
    // Two live tabs incl. the session's own — a healthy multi-tab deployment.
    const { bridge } = fakeBridge(new Set(["my-tab", "other-tab"]));
    const ctx = makePanelToolCtx(bridge, "my-tab", store);

    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    expect(res.isError).toBeUndefined();
    // Untouched — no rebind (canReach true), so no hijack onto another tab.
    expect(ctx.tabId).toBe("my-tab");
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toContain("Rebound");
  });

  it("surfaces a CLEAR error (no guess) when the session is dead AND no single active tab exists", async () => {
    const store = new WorkflowTargetStore();
    // Session's tab is dead and 2+ others are live with no last-active → ambiguous.
    const { bridge } = fakeBridge(new Set(["a", "b"]));
    const ctx = makePanelToolCtx(bridge, "dead-tab", store);

    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/Multiple panel tabs/);
    // tabId is NOT silently changed to some arbitrary tab.
    expect(ctx.tabId).toBe("dead-tab");
  });

  it("carries a PINNED workflow target across the rebind to the new tab id", async () => {
    const store = new WorkflowTargetStore();
    store.set("dead-old-tab", { mode: "pinned", path: "workflows/pinned.json" });
    const { bridge } = fakeBridge(new Set(["new-live-tab"]));
    const ctx = makePanelToolCtx(bridge, "dead-old-tab", store);

    // panel_reload triggers the rebind without releasing the pin.
    await defByName("panel_reload").handler({}, ctx);
    expect(ctx.tabId).toBe("new-live-tab");
    expect(store.get("new-live-tab")).toMatchObject({ mode: "pinned", path: "workflows/pinned.json" });
    expect(store.get("dead-old-tab")).toMatchObject({ mode: "current" });
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

  // ── #623: panel_civitai_results returns inline sample IMAGE blocks ──────────
  // The agent recommends models/LoRAs for a VISUAL medium, so it must SEE the
  // sample thumbnails — not just read titles + counts. These assert the top-N
  // non-gated samples come back as {type:"image"} blocks, and that gating is
  // never bypassed (blurred/gated results withhold their pixels).

  // A ctx whose `call` returns a caller-supplied civitai_results reply as the
  // JSON text payload the real panel would send back.
  function makeReplyCtx(reply: unknown): { ctx: PanelToolCtx; calls: Forwarded[] } {
    const calls: Forwarded[] = [];
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        calls.push(cmd);
        // Mirror the real ctx.call, which wraps the panel reply via ok() (pretty JSON).
        return { content: [{ type: "text", text: JSON.stringify(reply, null, 2) }] };
      },
      confirm: async () => "yes" as const,
      bridge: { send: async () => reply } as unknown as PanelToolCtx["bridge"],
      tabId: "test-tab",
    };
    return { ctx, calls };
  }

  // Fake global fetch that returns a tiny image body with an honest Content-Length;
  // records the URLs it saw. Errors on a redirect request (redirect:"error"), never
  // reached by the same-origin proxy path in these tests.
  function stubImageFetch(): { urls: string[]; restore: () => void } {
    const urls: string[] = [];
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG SOI-ish
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      urls.push(String(input));
      if (init && init.redirect && init.redirect !== "error") {
        throw new Error(`unexpected redirect mode: ${init.redirect}`);
      }
      return {
        ok: true,
        headers: new Map([
          ["content-type", "image/jpeg"],
          ["content-length", String(bytes.length)],
        ]),
        arrayBuffer: async () => bytes.buffer.slice(0),
      };
    }) as unknown as typeof fetch;
    return { urls, restore: () => void (globalThis.fetch = realFetch) };
  }

  function imageBlocks(res: ToolResult) {
    return res.content.filter((c) => c.type === "image");
  }

  it("civitaiSampleEligible fails CLOSED — pixels only for explicit gated:false (#623)", () => {
    const { civitaiSampleEligible } = __panelToolsTestHooks;
    expect(civitaiSampleEligible({ gated: false })).toBe(true); // proven in-level → show
    expect(civitaiSampleEligible({ gated: true })).toBe(false); // blurred → withhold
    // Anything ambiguous (older panel omitting the flag, or a junk value) is
    // withheld — a missing flag must never leak a sample the UI would blur.
    expect(civitaiSampleEligible({})).toBe(false);
    expect(civitaiSampleEligible({ gated: undefined })).toBe(false);
    expect(civitaiSampleEligible({ gated: "false" })).toBe(false);
  });

  it("panel_civitai_results returns inline image blocks for non-gated results (#623)", async () => {
    const reply = {
      total: 2,
      loading: false,
      items: [
        { id: 5, kind: "model", title: "Dreamy LoRA", urls: ["/comfyui_mcp_panel/civitai/media?uuid=a&ext=jpeg"], gated: false },
        { id: 6, kind: "image", title: null, urls: ["/comfyui_mcp_panel/civitai/media?uuid=b&ext=jpeg", "/full/b"], gated: false },
      ],
    };
    const { ctx } = makeReplyCtx(reply);
    const fetchStub = stubImageFetch();
    try {
      const res = await defByName("panel_civitai_results").handler({ limit: 20 }, ctx);
      const imgs = imageBlocks(res);
      expect(imgs.length).toBe(2);
      expect(imgs[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
      expect(typeof (imgs[0] as { data: string }).data).toBe("string");
      // The original JSON text payload is preserved (additive enrichment).
      expect(res.content[0].type).toBe("text");
      expect((res.content[0] as { text: string }).text).toContain('"total": 2');
      // Each image is labelled with its result id so the agent can map it back.
      const labels = res.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
      expect(labels).toContain("result id 5");
      expect(labels).toContain("result id 6");
      // Only the thumbnail (urls[0]) is fetched, never the full/video url.
      expect(fetchStub.urls.some((u) => u.includes("uuid=a"))).toBe(true);
      expect(fetchStub.urls.some((u) => u.includes("/full/b"))).toBe(false);
    } finally {
      fetchStub.restore();
    }
  });

  it("panel_civitai_results WITHHOLDS pixels for gated/blurred results (#623 gating)", async () => {
    const reply = {
      total: 1,
      loading: false,
      items: [
        { id: 9, kind: "image", title: null, urls: ["/comfyui_mcp_panel/civitai/media?uuid=x&ext=jpeg"], gated: true },
      ],
    };
    const { ctx } = makeReplyCtx(reply);
    const fetchStub = stubImageFetch();
    try {
      const res = await defByName("panel_civitai_results").handler({ limit: 20 }, ctx);
      expect(imageBlocks(res).length).toBe(0);
      // The gated thumbnail is NEVER fetched.
      expect(fetchStub.urls.length).toBe(0);
    } finally {
      fetchStub.restore();
    }
  });

  it("panel_civitai_results withholds pixels for an OLDER panel that omits `gated` (fail-closed) (#623)", async () => {
    // No per-item `gated` flag at all (pre-flag panel build): the fail-closed rule
    // withholds every sample — a missing flag must never leak a blurred image.
    const reply = {
      total: 1,
      loading: false,
      items: [{ id: 3, kind: "image", title: null, urls: ["/comfyui_mcp_panel/civitai/media?uuid=z&ext=jpeg"] }],
    };
    const { ctx } = makeReplyCtx(reply);
    const fetchStub = stubImageFetch();
    try {
      const res = await defByName("panel_civitai_results").handler({ limit: 20 }, ctx);
      expect(imageBlocks(res).length).toBe(0);
      expect(fetchStub.urls.length).toBe(0);
    } finally {
      fetchStub.restore();
    }
  });

  it("panel_civitai_results refuses off-origin / absolute sample URLs (SSRF + auth-header guard) (#623)", async () => {
    const reply = {
      total: 3,
      loading: false,
      items: [
        // Absolute off-origin URL — must never be fetched (would leak ComfyUI auth headers).
        { id: 1, kind: "image", title: null, urls: ["http://evil.example/steal?uuid=a"], gated: false },
        // Protocol-relative host — also refused.
        { id: 2, kind: "image", title: null, urls: ["//evil.example/x.jpeg"], gated: false },
        // Same-origin path but NOT the media proxy — refused.
        { id: 3, kind: "image", title: null, urls: ["/comfyui_mcp_panel/civitai/download?versionId=9"], gated: false },
        // Backslash authority trick (`\`→`/` folding) — refused before fetch.
        { id: 4, kind: "image", title: null, urls: ["/\\evil.example/x.jpeg"], gated: false },
        // Same-origin route that merely ENDS WITH the proxy path — refused by the
        // EXACT-path check (endsWith would have let this reach an auth'd request).
        { id: 5, kind: "image", title: null, urls: ["/other/comfyui_mcp_panel/civitai/media?uuid=a"], gated: false },
      ],
    };
    const { ctx } = makeReplyCtx(reply);
    const fetchStub = stubImageFetch();
    try {
      const res = await defByName("panel_civitai_results").handler({ limit: 20 }, ctx);
      expect(imageBlocks(res).length).toBe(0);
      expect(fetchStub.urls.length).toBe(0); // nothing was fetched
    } finally {
      fetchStub.restore();
    }
  });

  it("panel_civitai_results skips a length-less/oversize sample body (unbounded-read guard) (#623)", async () => {
    const reply = {
      total: 2,
      loading: false,
      items: [
        { id: 1, kind: "image", title: null, urls: ["/comfyui_mcp_panel/civitai/media?uuid=nolen&ext=jpeg"], gated: false },
        { id: 2, kind: "image", title: null, urls: ["/comfyui_mcp_panel/civitai/media?uuid=big&ext=jpeg"], gated: false },
      ],
    };
    const { ctx } = makeReplyCtx(reply);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const s = String(input);
      const headers = new Map<string, string>([["content-type", "image/jpeg"]]);
      if (s.includes("uuid=big")) headers.set("content-length", String(5 * 1024 * 1024)); // > cap
      // uuid=nolen: no content-length header at all
      return {
        ok: true,
        headers,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      };
    }) as unknown as typeof fetch;
    try {
      const res = await defByName("panel_civitai_results").handler({ limit: 20 }, ctx);
      expect(imageBlocks(res).length).toBe(0); // both refused before/without buffering
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("panel_civitai_results honors images:0 (metadata only, no fetch) (#623)", async () => {
    const reply = {
      total: 1,
      loading: false,
      items: [{ id: 1, kind: "image", title: null, urls: ["/comfyui_mcp_panel/civitai/media?uuid=q&ext=jpeg"], gated: false }],
    };
    const { ctx } = makeReplyCtx(reply);
    const fetchStub = stubImageFetch();
    try {
      const res = await defByName("panel_civitai_results").handler({ images: 0 }, ctx);
      expect(imageBlocks(res).length).toBe(0);
      expect(fetchStub.urls.length).toBe(0);
    } finally {
      fetchStub.restore();
    }
    const images = defByName("panel_civitai_results").schema.images as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(images.safeParse(0).success).toBe(true);
    expect(images.safeParse(9).success).toBe(false); // > max 8
    expect(images.safeParse(undefined).success).toBe(true);
  });

  it("panel_civitai_results bounds fetch ATTEMPTS, not just successes, on dud URLs (#623)", async () => {
    // 50 eligible non-gated proxy URLs that all 404: with images:1 the loop must
    // NOT fire 50 requests — attempts are capped at images + a small slack.
    const items = Array.from({ length: 50 }, (_, i) => ({
      id: i, kind: "image", title: null,
      urls: [`/comfyui_mcp_panel/civitai/media?uuid=${i}&ext=jpeg`], gated: false,
    }));
    const { ctx } = makeReplyCtx({ total: 50, loading: false, items });
    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      urls.push(String(input));
      return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
    }) as unknown as typeof fetch;
    try {
      const res = await defByName("panel_civitai_results").handler({ images: 1 }, ctx);
      expect(imageBlocks(res).length).toBe(0); // all 404 → no images
      // images:1 + slack(4) = at most 5 network attempts, never all 50.
      expect(urls.length).toBeLessThanOrEqual(5);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("panel_civitai_results caps delivered samples at the requested images count (#623)", async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      id: i, kind: "image", title: null, urls: [`/comfyui_mcp_panel/civitai/media?uuid=${i}&ext=jpeg`], gated: false,
    }));
    const { ctx } = makeReplyCtx({ total: 6, loading: false, items });
    const fetchStub = stubImageFetch();
    try {
      const res = await defByName("panel_civitai_results").handler({ images: 2 }, ctx);
      expect(imageBlocks(res).length).toBe(2);
      expect(fetchStub.urls.length).toBe(2);
    } finally {
      fetchStub.restore();
    }
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
    const { ctx, calls } = makeFakeCtx({ creator: null });
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

  // #935 — the #374 guard below covers `creator` and nothing else, so
  // modelSort/baseModels/period could be supplied, ignored, and answered with a
  // full plausible list. A reporter saw download counts in no order at all
  // (48, 53, 53, 64, 1468) for a "Most Downloaded" sort. The guard's own rules
  // are pinned in civitai-filter-guard.test.ts; these cover the WIRING.
  it("panel_civitai_search WARNS when a supplied filter was not applied (#935)", async () => {
    const { ctx } = makeFakeCtx({
      creator: null,
      applied_filters: { modelSort: "Newest" },
    });
    const res = await defByName("panel_civitai_search").handler(
      { query: "flux lora", filters: { modelSort: "Most Downloaded" } },
      ctx,
    );
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/were NOT applied/);
    expect(text).toContain("Most Downloaded");
    expect(text).toContain("Newest");
    expect(text).toMatch(/do not describe them as sorted or narrowed/);
  });

  it("panel_civitai_search stays SILENT when the panel applied what was asked (#935)", async () => {
    const filters = { modelSort: "Most Downloaded" };
    const { ctx } = makeFakeCtx({ creator: null, applied_filters: filters });
    const res = await defByName("panel_civitai_search").handler({ query: "x", filters }, ctx);
    expect((res.content[0] as { text: string }).text).not.toMatch(/NOT applied|UNVERIFIED/);
  });

  it("panel_civitai_search reports an un-echoed filter as UNVERIFIED, not failed (#935)", async () => {
    // An older panel echoes no applied_filters. Absence is not evidence.
    const { ctx } = makeFakeCtx({ creator: null });
    const res = await defByName("panel_civitai_search").handler(
      { query: "x", filters: { baseModels: ["Flux.1 D"] } },
      ctx,
    );
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/UNVERIFIED/);
    expect(text).not.toMatch(/were NOT applied/);
  });

  it("panel_civitai_search folds a creator into the query as an @creator token (#374)", async () => {
    const { ctx, calls } = makeFakeCtx({ creator: "tenstrip" });
    await defByName("panel_civitai_search").handler(
      { query: "portrait", creator: "@tenstrip" },
      ctx,
    );
    // Leading @ is stripped/normalized, then re-prefixed so the panel's
    // parseCreatorQuery applies the username filter.
    expect(calls[0]).toMatchObject({ cmd: "civitai_search", query: "@tenstrip portrait" });
  });

  it("panel_civitai_search browses a creator with an empty query (@creator + trailing space)", async () => {
    const { ctx, calls } = makeFakeCtx({ creator: "tenstrip" });
    await defByName("panel_civitai_search").handler({ query: "", creator: "tenstrip" }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "civitai_search", query: "@tenstrip " });
  });

  it("panel_civitai_search WARNS when a requested creator was not applied (creator:null) — #374", async () => {
    // Panel echoes creator:null → the filter never took. The tool must surface an
    // explicit warning so the empty grid is not read as 'creator has no content'.
    const { ctx } = makeFakeCtx({ creator: null, total: 0, items: [] });
    const res = await defByName("panel_civitai_search").handler(
      { query: "", creator: "media-only-person" },
      ctx,
    );
    const text = res.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text).toContain("was NOT applied");
    expect(text.toLowerCase()).toContain("media-only-person".toLowerCase());
  });

  it("panel_civitai_search does NOT warn when the creator was honored", async () => {
    const { ctx } = makeFakeCtx({ creator: "tenstrip", total: 3, items: [] });
    const res = await defByName("panel_civitai_search").handler(
      { query: "", creator: "TenStrip" }, // case-insensitive match
      ctx,
    );
    const text = res.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text).not.toContain("was NOT applied");
  });

  it("panel_open_civitai folds a creator into the query too (#374)", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_open_civitai").handler(
      { query: "flux", creator: "someone", tab: "images" },
      ctx,
    );
    expect(calls[0]).toMatchObject({ cmd: "open_civitai", query: "@someone flux" });
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

describe("panel-tools: adult-consent card survives an idle-user timeout (#390)", () => {
  const origSettings = process.env.COMFYUI_MCP_PANEL_SETTINGS;
  // The card's exact affirmative/decline option labels — the SAME source constants the
  // classifier matches byte-for-byte, so tests can't drift from the real card.
  const CONSENT_YES_LABEL = __panelToolsTestHooks.CONSENT_YES_LABEL;
  const CONSENT_NO_LABEL = __panelToolsTestHooks.CONSENT_NO_LABEL;

  beforeAll(() => {
    // Isolate the persistent consent store to a throwaway file for this suite.
    const dir = mkdtempSync(join(tmpdir(), "consent-390-"));
    process.env.COMFYUI_MCP_PANEL_SETTINGS = join(dir, "panel-settings.json");
  });
  afterAll(() => {
    if (origSettings === undefined) delete process.env.COMFYUI_MCP_PANEL_SETTINGS;
    else process.env.COMFYUI_MCP_PANEL_SETTINGS = origSettings;
  });
  afterEach(() => {
    // Restore the real ask timing so other suites see the production defaults.
    __panelAskTestHooks.setAskTiming(null);
  });

  // A card-reply TIMEOUT the bridge surfaces when the tab never answered — the EXACT
  // canonical whole-message ui-bridge emits, so isReplyTimeoutError treats it as
  // recoverable (not a hard error). Must match the bridge form verbatim.
  const replyTimeoutErr = (ms: number) =>
    new Error(
      `Panel tab abcd did not reply to "ask_user" within ${ms} ms — the ComfyUI tab may be backgrounded or frozen`,
    );

  function timeoutBridge(late?: () => unknown) {
    let forwardedTimeout = 0;
    let forwardedAskId: unknown;
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
        forwardedTimeout = opts?.timeoutMs ?? 0;
        forwardedAskId = (cmd as { ask_id?: unknown }).ask_id;
        throw replyTimeoutErr(opts?.timeoutMs ?? 0);
      },
      canReach: () => true,
      isHeadless: () => false,
      resolveActiveTabId: () => "abcd",
      push: () => 1,
      takeLateAskReply: () => (late ? late() : undefined),
    } as unknown as PanelToolCtx["bridge"];
    return {
      ctx: { bridge, tabId: "abcd", ensureReachable: () => {} } as unknown as PanelToolCtx,
      get forwardedTimeout() {
        return forwardedTimeout;
      },
      get forwardedAskId() {
        return forwardedAskId;
      },
    };
  }

  function replyBridge(reply: unknown) {
    return {
      send: async () => reply,
      canReach: () => true,
      isHeadless: () => false,
      resolveActiveTabId: () => "abcd",
      push: () => 1,
    } as unknown as PanelToolCtx["bridge"];
  }

  function parse(res: ToolResult): Record<string, unknown> {
    return JSON.parse((res.content[0] as { text: string }).text);
  }

  it("an unanswered card resolves cleanly as { timed_out:true } WITHOUT granting consent", async () => {
    setNsfwConsent(false);
    __panelAskTestHooks.setAskTiming({ deadlineMs: 5, graceMs: 20, pollMs: 2 });
    const h = timeoutBridge(); // no late reply ever arrives
    const res = await defByName("panel_request_adult_consent").handler({}, h.ctx);
    // Resolves cleanly — NOT a transport error (the whole point of #390).
    expect(res.isError).toBeFalsy();
    const out = parse(res);
    expect(out.timed_out).toBe(true);
    expect(out.nsfw_allowed).toBe(false);
    // GATE PRESERVED: a timeout must NEVER auto-grant the persistent consent.
    expect(getNsfwConsent().allowed).toBe(false);
    // The card deadline was clamped under the ~300s MCP tools/call budget and a
    // stable ask_id was sent so a late-but-valid answer could still be keyed.
    expect(h.forwardedTimeout).toBeGreaterThan(0);
    expect(h.forwardedTimeout).toBeLessThan(300000);
    expect(typeof h.forwardedAskId).toBe("string");
  });

  it("honors a late-but-valid YES buffered after the reply timeout and grants consent", async () => {
    setNsfwConsent(false);
    __panelAskTestHooks.setAskTiming({ deadlineMs: 5, graceMs: 500, pollMs: 2 });
    let takes = 0;
    const h = timeoutBridge(() => {
      takes += 1;
      return takes >= 2 ? "Yes — I'm 18+ and it's legal in my region" : undefined;
    });
    const res = await defByName("panel_request_adult_consent").handler({}, h.ctx);
    const out = parse(res);
    expect(out.timed_out).toBeUndefined();
    expect(out.nsfw_allowed).toBe(true);
    expect(getNsfwConsent().allowed).toBe(true);
  });

  it("honors a late-but-valid NO buffered after the reply timeout and stays SFW", async () => {
    setNsfwConsent(false);
    __panelAskTestHooks.setAskTiming({ deadlineMs: 5, graceMs: 500, pollMs: 2 });
    let takes = 0;
    const h = timeoutBridge(() => {
      takes += 1;
      return takes >= 2 ? "No — keep it SFW" : undefined;
    });
    const res = await defByName("panel_request_adult_consent").handler({}, h.ctx);
    const out = parse(res);
    expect(out.nsfw_allowed).toBe(false);
    expect(getNsfwConsent().allowed).toBe(false);
  });

  it("a fast YES grants and a fast NO keeps SFW — the gate is not weakened", async () => {
    // Fast NO → stays SFW.
    setNsfwConsent(false);
    let ctx = { bridge: replyBridge("No — keep it SFW"), tabId: "abcd", ensureReachable: () => {} } as unknown as PanelToolCtx;
    let out = parse(await defByName("panel_request_adult_consent").handler({}, ctx));
    expect(out.nsfw_allowed).toBe(false);
    expect(getNsfwConsent().allowed).toBe(false);

    // Fast affirmative → grants (the only path that turns the gate ON).
    ctx = {
      bridge: replyBridge("Yes — I'm 18+ and it's legal in my region"),
      tabId: "abcd",
      ensureReachable: () => {},
    } as unknown as PanelToolCtx;
    out = parse(await defByName("panel_request_adult_consent").handler({}, ctx));
    expect(out.nsfw_allowed).toBe(true);
    expect(getNsfwConsent().allowed).toBe(true);
  });

  it("an idle timeout does NOT drop a previously GRANTED consent", async () => {
    setNsfwConsent(true); // user consented earlier this session
    __panelAskTestHooks.setAskTiming({ deadlineMs: 5, graceMs: 20, pollMs: 2 });
    const h = timeoutBridge();
    const out = parse(await defByName("panel_request_adult_consent").handler({}, h.ctx));
    expect(out.timed_out).toBe(true);
    // Reflects — and preserves — the surviving grant; the timeout wrote nothing.
    expect(out.nsfw_allowed).toBe(true);
    expect(getNsfwConsent().allowed).toBe(true);
  });

  // P0 (gate integrity): the card has a free-text "Other" box, so a LATE reply can
  // be arbitrary user text. It must go through the STRICT consent classifier, NOT
  // the broad isAffirmative() prefix match — a stray string that merely STARTS with
  // "on…"/"adult…"/"18…" must NEVER grant adult mode.
  it("a late FREE-TEXT reply that only loosely resembles yes does NOT grant (P0 regression)", async () => {
    const strays = [
      "On second thought, no",
      "adult content is illegal here",
      "18 is the age but I decline",
      "enable? actually no",
      "yes but only sfw please",
    ];
    for (const stray of strays) {
      setNsfwConsent(false);
      __panelAskTestHooks.setAskTiming({ deadlineMs: 5, graceMs: 500, pollMs: 2 });
      let takes = 0;
      const h = timeoutBridge(() => {
        takes += 1;
        return takes >= 2 ? stray : undefined;
      });
      const out = parse(await defByName("panel_request_adult_consent").handler({}, h.ctx));
      expect(out.nsfw_allowed, `late reply "${stray}" must NOT grant`).toBe(false);
      expect(getNsfwConsent().allowed, `late reply "${stray}" must NOT persist a grant`).toBe(false);
    }
  });

  // P1: a stray/ambiguous LATE reply must not clobber a prior genuine grant — same
  // "change nothing unless it's an EXACT yes/no" rule as the no-answer path.
  it("a late ambiguous reply PRESERVES a prior genuine grant (does not revoke) (P1 regression)", async () => {
    setNsfwConsent(true); // real prior consent
    __panelAskTestHooks.setAskTiming({ deadlineMs: 5, graceMs: 500, pollMs: 2 });
    let takes = 0;
    const h = timeoutBridge(() => {
      takes += 1;
      return takes >= 2 ? "hmm let me think about it" : undefined;
    });
    const out = parse(await defByName("panel_request_adult_consent").handler({}, h.ctx));
    expect(out.nsfw_allowed).toBe(true);
    expect(getNsfwConsent().allowed).toBe(true);
  });

  // The same strict gate applies to an IMMEDIATE free-text reply (the pre-existing
  // isAffirmative hole): "adult content is illegal here" must not enable adult mode.
  it("an IMMEDIATE free-text reply resembling 'adult…' does NOT grant (strict gate)", async () => {
    setNsfwConsent(false);
    const ctx = {
      bridge: replyBridge("adult content is illegal here"),
      tabId: "abcd",
      ensureReachable: () => {},
    } as unknown as PanelToolCtx;
    const out = parse(await defByName("panel_request_adult_consent").handler({}, ctx));
    expect(out.nsfw_allowed).toBe(false);
    expect(getNsfwConsent().allowed).toBe(false);
  });

  it("an EXACT decline explicitly reverts a prior grant to SFW", async () => {
    setNsfwConsent(true);
    const ctx = {
      bridge: replyBridge(CONSENT_NO_LABEL),
      tabId: "abcd",
      ensureReachable: () => {},
    } as unknown as PanelToolCtx;
    const out = parse(await defByName("panel_request_adult_consent").handler({}, ctx));
    expect(out.nsfw_allowed).toBe(false);
    expect(getNsfwConsent().allowed).toBe(false);
  });

  it("a bare exact 'yes' typed in the Other box grants (strict whole-string token)", async () => {
    setNsfwConsent(false);
    const ctx = {
      bridge: replyBridge("yes"),
      tabId: "abcd",
      ensureReachable: () => {},
    } as unknown as PanelToolCtx;
    const out = parse(await defByName("panel_request_adult_consent").handler({}, ctx));
    expect(out.nsfw_allowed).toBe(true);
    expect(getNsfwConsent().allowed).toBe(true);
  });

  it("a whitespace tolerant 'yes' token still grants (deliberately-loose free-text path)", async () => {
    for (const token of [" yes ", "\n yes \n", "  Y  ", "i agree"]) {
      setNsfwConsent(false);
      const ctx = {
        bridge: replyBridge(token),
        tabId: "abcd",
        ensureReachable: () => {},
      } as unknown as PanelToolCtx;
      const out = parse(await defByName("panel_request_adult_consent").handler({}, ctx));
      expect(out.nsfw_allowed, `token ${JSON.stringify(token)} should grant`).toBe(true);
      expect(getNsfwConsent().allowed).toBe(true);
    }
  });

  // The exact-affirmative OPTION path is byte-exact — a near-label wrapped in
  // zero-width / BOM / line-separator / whitespace chars (which .trim() would strip)
  // must NOT be accepted as the affirmative option; it falls to the free-text token
  // path, doesn't match a whole-string yes token, and stays "unclear" → no grant.
  it("a BOM/whitespace-wrapped near-affirmative-LABEL does NOT grant (byte-exact identity)", async () => {
    const nearLabels = [
      ` ${CONSENT_YES_LABEL}`, // leading space
      `${CONSENT_YES_LABEL}﻿`, // trailing BOM / zero-width no-break space
      `${CONSENT_YES_LABEL} `, // trailing line separator
      `\n ${CONSENT_YES_LABEL} \n`, // newline-wrapped
    ];
    for (const near of nearLabels) {
      setNsfwConsent(false);
      const ctx = {
        bridge: replyBridge(near),
        tabId: "abcd",
        ensureReachable: () => {},
      } as unknown as PanelToolCtx;
      const out = parse(await defByName("panel_request_adult_consent").handler({}, ctx));
      expect(out.nsfw_allowed, `near-label ${JSON.stringify(near)} must NOT grant`).toBe(false);
      expect(getNsfwConsent().allowed).toBe(false);
    }
    // Sanity: the exact byte-for-byte label DOES grant.
    setNsfwConsent(false);
    const ctxExact = {
      bridge: replyBridge(CONSENT_YES_LABEL),
      tabId: "abcd",
      ensureReachable: () => {},
    } as unknown as PanelToolCtx;
    const outExact = parse(await defByName("panel_request_adult_consent").handler({}, ctxExact));
    expect(outExact.nsfw_allowed).toBe(true);
  });

  // A tab_id containing a space makes the canonical timeout message unsegmentable by a
  // `\S+` regex; the bridge's TYPED reply-timeout marker keys the recoverable-timeout
  // decision instead, so a genuine late reply for that round is still honored (not lost
  // to fail()).
  it("a TYPED reply-timeout with a spaced tab_id is recoverable — late YES is honored", async () => {
    setNsfwConsent(false);
    __panelAskTestHooks.setAskTiming({ deadlineMs: 5, graceMs: 500, pollMs: 2 });
    let takes = 0;
    const bridge = {
      send: async () => {
        // Canonical text with a SPACED tab id — but the decision keys on the marker.
        throw markReplyTimeout(
          new Error(
            'Panel tab ab cd12 did not reply to "ask_user" within 500 ms — the ComfyUI tab may be backgrounded or frozen',
          ),
        );
      },
      canReach: () => true,
      isHeadless: () => false,
      resolveActiveTabId: () => "ab cd12",
      push: () => 1,
      takeLateAskReply: () => {
        takes += 1;
        return takes >= 2 ? CONSENT_YES_LABEL : undefined;
      },
    } as unknown as PanelToolCtx["bridge"];
    const ctx = { bridge, tabId: "ab cd12", ensureReachable: () => {} } as unknown as PanelToolCtx;
    const out = parse(await defByName("panel_request_adult_consent").handler({}, ctx));
    expect(out.nsfw_allowed).toBe(true);
    expect(getNsfwConsent().allowed).toBe(true);
  });

  // A genuine transport/executor error that merely mentions — or WRAPS — the reply
  // phrase (NOT the canonical whole-message `Panel tab … did not reply to "…" within
  // N ms — the ComfyUI tab may be backgrounded or frozen`) must NOT be treated as a
  // recoverable card timeout. It must surface as a real error (fail), never a quiet
  // "nothing changed" success that masks the failure. isReplyTimeoutError is anchored
  // ^…$ to the whole canonical message, so a prefixed/suffixed wrapper won't match.
  it("a non-timeout transport error surfaces as fail(), not a swallowed unchanged-state result", async () => {
    const wrapped = [
      // Bare phrase in an unrelated error.
      "upstream service did not reply to us within 500 ms while loading",
      // PREFIXED wrapper around the exact bridge phrase (the P1c trigger).
      'relay failed: Panel tab abcd did not reply to "ask_user" within 500 ms; reconnecting',
      // SUFFIXED wrapper (canonical phrase then extra trailing text).
      'Panel tab abcd did not reply to "ask_user" within 500 ms — the ComfyUI tab may be backgrounded or frozen; socket closed',
      // LEADING whitespace before canonical (fails the `^` start anchor).
      '  Panel tab abcd did not reply to "ask_user" within 500 ms — the ComfyUI tab may be backgrounded or frozen',
      // Canonical + a trailing newline ONLY: JS `$` matches just before a final "\n",
      // so this specifically exercises the HARD end anchor (?![\s\S]) that rejects it.
      'Panel tab abcd did not reply to "ask_user" within 500 ms — the ComfyUI tab may be backgrounded or frozen\n',
      // NONCANONICAL spacing before "ms" — not the bridge's literal single space.
      'Panel tab abcd did not reply to "ask_user" within 500ms — the ComfyUI tab may be backgrounded or frozen',
      'Panel tab abcd did not reply to "ask_user" within 500\tms — the ComfyUI tab may be backgrounded or frozen',
    ];
    for (const message of wrapped) {
      setNsfwConsent(false);
      let polled = false;
      const bridge = {
        send: async () => {
          throw new Error(message);
        },
        canReach: () => true,
        isHeadless: () => false,
        resolveActiveTabId: () => "abcd",
        push: () => 1,
        takeLateAskReply: () => {
          polled = true;
          return undefined;
        },
      } as unknown as PanelToolCtx["bridge"];
      const ctx = { bridge, tabId: "abcd", ensureReachable: () => {} } as unknown as PanelToolCtx;
      const res = await defByName("panel_request_adult_consent").handler({}, ctx);
      expect(res.isError, `wrapped error "${message}" must fail(), not succeed`).toBe(true);
      // Not misclassified as a card timeout, so the late-reply buffer was never polled.
      expect(polled, `wrapped error "${message}" must NOT be polled as a timeout`).toBe(false);
      // And the gate was never touched.
      expect(getNsfwConsent().allowed).toBe(false);
    }
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
      confirm: async () => "yes" as const,
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

describe("panel_open_workflow: verify active state after ack-timeout (#215/#319/#496)", () => {
  const TARGET = "my-workflow.json";
  const timeoutResult = () => ({
    content: [
      {
        type: "text" as const,
        text: `Error: Panel tab abcd1234 did not reply to "workflow_open" within 15000 ms — the ComfyUI tab may be backgrounded or frozen`,
      },
    ],
    isError: true,
  });

  // Programmable ctx: workflow_open returns whatever `openReply` yields; each
  // workflow_list returns the next entry in `listReplies` (last one repeats).
  function makeVerifyCtx(opts: {
    openReply: () => unknown;
    listReplies: Array<Record<string, unknown>>;
    rid?: string;
  }): { ctx: PanelToolCtx; cmds: string[] } {
    const cmds: string[] = [];
    let listIdx = 0;
    const ctx = {
      call: async (
        cmd: Record<string, unknown>,
        _timeoutMs?: number,
        onDispatchedRid?: (rid: string) => void,
      ) => {
        cmds.push(cmd.cmd as string);
        if (cmd.cmd === "workflow_open") {
          onDispatchedRid?.(opts.rid ?? "open-rid-1");
          return opts.openReply();
        }
        if (cmd.cmd === "workflow_list") {
          const reply = opts.listReplies[Math.min(listIdx, opts.listReplies.length - 1)];
          listIdx++;
          return { content: [{ type: "text", text: JSON.stringify(reply) }] };
        }
        return { content: [{ type: "text", text: "{}" }] };
      },
      confirm: async () => "yes" as const,
      bridge: {} as unknown as PanelToolCtx["bridge"],
      tabId: "test-tab",
    } as PanelToolCtx;
    return { ctx, cmds };
  }

  beforeAll(() => {
    // Fast, deterministic verify timing so the test doesn't wait the real budget.
    __openWorkflowTestHooks.setOpenVerifyTiming({ budgetMs: 200, intervalMs: 1, probeTimeoutMs: 50 });
  });
  afterAll(() => {
    __openWorkflowTestHooks.setOpenVerifyTiming(null);
  });

  it("ack-timeout BUT target becomes active ⇒ SUCCESS with a recovered note", async () => {
    const { ctx, cmds } = makeVerifyCtx({
      openReply: () => timeoutResult(),
      listReplies: [
        {
          active_confirmed: true,
          active: { path: "other.json", filename: "other.json", key: "k-other" },
          last_open: {
            rid: "open-rid-1",
            answers_only_command_rid: "open-rid-1",
            cmd: "workflow_open",
            requested: TARGET,
            resolved: { path: TARGET, filename: TARGET, routing_key: "k-mine" },
            applied: true,
          },
        },
      ],
    });
    const res = (await defByName("panel_open_workflow").handler({ path: TARGET }, ctx)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toContain("recovered");
    expect(text).toMatch(/request-id-correlated open receipt/i);
    // It DID poll the authoritative active signal after the open timed out.
    expect(cmds[0]).toBe("workflow_open");
    expect(cmds).toContain("workflow_list");
  });

  it("ack-timeout AND target never becomes active ⇒ clear FAILURE (no false success)", async () => {
    const { ctx } = makeVerifyCtx({
      openReply: () => timeoutResult(),
      // Regression #661: active can already match after a reconnect even though
      // this open request has no receipt. That is an undetermined outcome.
      listReplies: [{ active: { path: TARGET, filename: TARGET, key: "k-mine" } }],
    });
    const res = (await defByName("panel_open_workflow").handler({ path: TARGET }, ctx)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/outcome is undetermined/i);
    expect(res.content[0].text).not.toMatch(/recovered|Do NOT retry/i);
  });

  it("does not treat a stale receipt for the same active target as this request's success", async () => {
    const { ctx } = makeVerifyCtx({
      openReply: () => timeoutResult(),
      listReplies: [
        {
          active_confirmed: true,
          active: { path: TARGET, filename: TARGET, key: "k-mine" },
          last_open: {
            rid: "older-open-rid",
            answers_only_command_rid: "older-open-rid",
            cmd: "workflow_open",
            requested: TARGET,
            resolved: { path: TARGET, filename: TARGET, routing_key: "k-mine" },
            applied: true,
          },
        },
      ],
    });
    const res = await defByName("panel_open_workflow").handler({ path: TARGET }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.type === "text" ? res.content[0].text : "").toMatch(/outcome is undetermined/i);
  });

  it("does not recover when the matching RID resolves to a different workflow", async () => {
    const { ctx } = makeVerifyCtx({
      openReply: () => timeoutResult(),
      listReplies: [{
        active_confirmed: true,
        last_open: {
          rid: "open-rid-1", answers_only_command_rid: "open-rid-1", cmd: "workflow_open",
          requested: TARGET,
          resolved: { path: "other.json", filename: "other.json", routing_key: "wf:other.json" },
          applied: true,
        },
      }],
    });
    const res = await defByName("panel_open_workflow").handler({ path: TARGET }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.type === "text" ? res.content[0].text : "").toMatch(/outcome is undetermined/i);
  });

  it("does not substitute a matching resolved filename for a different path", async () => {
    const { ctx } = makeVerifyCtx({
      openReply: () => timeoutResult(),
      listReplies: [{
        active_confirmed: true,
        last_open: {
          rid: "open-rid-1", answers_only_command_rid: "open-rid-1", cmd: "workflow_open",
          requested: "wanted/foo.json",
          resolved: { path: "other/foo.json", filename: "foo.json", routing_key: "wf:other/foo.json" },
          applied: true,
        },
      }],
    });
    const res = await defByName("panel_open_workflow").handler({ path: "wanted/foo.json" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.type === "text" ? res.content[0].text : "").toMatch(/outcome is undetermined/i);
  });

  it("recovers an exact receipt but never refreshes from a different same-basename active workflow (#716 P1)", async () => {
    const requested = "workflows/a/foo.json";
    const refresh = vi.fn(() => true);
    const { ctx } = makeVerifyCtx({
      openReply: () => timeoutResult(),
      listReplies: [{
        active_confirmed: true,
        active: {
          path: "workflows/b/foo.json",
          routing_key: "wf:workflows/b/foo.json",
          workflow_uuid: "22222222-2222-4222-8222-222222222222",
        },
        last_open: {
          rid: "open-rid-1", answers_only_command_rid: "open-rid-1", cmd: "workflow_open",
          requested,
          resolved: { path: requested, filename: "foo.json", routing_key: "wf:workflows/a/foo.json" },
          applied: true,
        },
      }],
    });
    (ctx.bridge as unknown as { refreshWorkflowUuid: typeof refresh }).refreshWorkflowUuid = refresh;

    const res = await defByName("panel_open_workflow").handler({ path: requested }, ctx);
    expect(res.isError).toBeFalsy(); // The RID-correlated receipt still proves the open happened.
    expect(refresh).not.toHaveBeenCalled(); // But B's valid UUID must never stamp the next A command.
  });

  it("recovers a matching receipt but never refreshes from an active path/routing contradiction (#716 P1)", async () => {
    const requested = "workflows/a/foo.json";
    const refresh = vi.fn(() => true);
    const { ctx } = makeVerifyCtx({
      openReply: () => timeoutResult(),
      listReplies: [{
        active_confirmed: true,
        active: {
          path: requested,
          routing_key: "wf:workflows/b/foo.json",
          workflow_uuid: "22222222-2222-4222-8222-222222222222",
        },
        last_open: {
          rid: "open-rid-1", answers_only_command_rid: "open-rid-1", cmd: "workflow_open",
          requested,
          resolved: { path: requested, filename: "foo.json", routing_key: "wf:workflows/a/foo.json" },
          applied: true,
        },
      }],
    });
    (ctx.bridge as unknown as { refreshWorkflowUuid: typeof refresh }).refreshWorkflowUuid = refresh;
    const res = await defByName("panel_open_workflow").handler({ path: requested }, ctx);
    expect(res.isError).toBeFalsy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("never refreshes a receipt recovery for a temporary routing token (#716 P1)", async () => {
    const requested = "tmp:ephemeral-tab";
    const refresh = vi.fn(() => true);
    const { ctx } = makeVerifyCtx({
      openReply: () => timeoutResult(),
      listReplies: [{
        active_confirmed: true,
        active: { path: requested, routing_key: "wf:tmp:ephemeral-tab", workflow_uuid: "22222222-2222-4222-8222-222222222222" },
        last_open: {
          rid: "open-rid-1", answers_only_command_rid: "open-rid-1", cmd: "workflow_open",
          requested,
          resolved: { path: requested, routing_key: "wf:tmp:ephemeral-tab" },
          applied: true,
        },
      }],
    });
    (ctx.bridge as unknown as { refreshWorkflowUuid: typeof refresh }).refreshWorkflowUuid = refresh;
    const res = await defByName("panel_open_workflow").handler({ path: requested }, ctx);
    expect(res.isError).toBeFalsy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("recovers a receipt but never refreshes from a partial or replayed active list record (#716 P1)", async () => {
    const requested = "workflows/a/foo.json";
    for (const routing_key of [undefined, "wf:workflows/replayed.json", "not-a-routing-key"]) {
      const refresh = vi.fn(() => true);
      const { ctx } = makeVerifyCtx({
        openReply: () => timeoutResult(),
        listReplies: [{
          active_confirmed: true,
          active: { path: requested, routing_key, workflow_uuid: "22222222-2222-4222-8222-222222222222" },
          last_open: {
            rid: "open-rid-1", answers_only_command_rid: "open-rid-1", cmd: "workflow_open",
            requested,
            resolved: { path: requested, filename: "foo.json", routing_key: "wf:workflows/a/foo.json" },
            applied: true,
          },
        }],
      });
      (ctx.bridge as unknown as { refreshWorkflowUuid: typeof refresh }).refreshWorkflowUuid = refresh;
      const res = await defByName("panel_open_workflow").handler({ path: requested }, ctx);
      expect(res.isError).toBeFalsy();
      expect(refresh).not.toHaveBeenCalled();
    }
  });

  it("a genuine acked open-failure (missing file) still fails clearly, unverified", async () => {
    let listCalls = 0;
    const ctx = {
      call: async (cmd: Record<string, unknown>) => {
        if (cmd.cmd === "workflow_open") {
          return {
            content: [{ type: "text", text: `Error: no workflow matching "${TARGET}"` }],
            isError: true,
          };
        }
        if (cmd.cmd === "workflow_list") listCalls++;
        return { content: [{ type: "text", text: "{}" }] };
      },
      confirm: async () => "yes" as const,
      bridge: {} as unknown as PanelToolCtx["bridge"],
      tabId: "test-tab",
    } as PanelToolCtx;
    const res = (await defByName("panel_open_workflow").handler({ path: TARGET }, ctx)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/no workflow matching/i);
    // A genuine error is NOT an ack-timeout, so verification must NOT run.
    expect(listCalls).toBe(0);
  });

  it("a timeout-WORDED acked executor error is NOT treated as a no-reply (not verified)", async () => {
    // A genuine executor error that happens to contain "did not reply … within N ms"
    // wording but is NOT the canonical bridge `Panel tab …` no-reply must fail
    // verbatim and must NOT trigger workflow_list verification (no false recovery).
    let listCalls = 0;
    const ctx = {
      call: async (cmd: Record<string, unknown>) => {
        if (cmd.cmd === "workflow_open") {
          return {
            content: [
              {
                type: "text",
                text: `Error: upstream service did not reply to us within 500 ms while loading`,
              },
            ],
            isError: true,
          };
        }
        if (cmd.cmd === "workflow_list") listCalls++;
        return { content: [{ type: "text", text: JSON.stringify({ active: { path: TARGET } }) }] };
      },
      confirm: async () => "yes" as const,
      bridge: {} as unknown as PanelToolCtx["bridge"],
      tabId: "test-tab",
    } as PanelToolCtx;
    const res = (await defByName("panel_open_workflow").handler({ path: TARGET }, ctx)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/upstream service did not reply/i);
    expect(listCalls).toBe(0);
  });

  it("normal fast success returns verbatim and re-reads active identity before refreshing", async () => {
    const exactTarget = "workflows/my-workflow.json";
    let listCalls = 0;
    const ctx = {
      call: async (cmd: Record<string, unknown>) => {
        if (cmd.cmd === "workflow_open") {
          return {
            content: [
              { type: "text", text: JSON.stringify({ opened: { path: exactTarget }, routing_key: "wf:workflows/my-workflow.json", modified: false }) },
            ],
          };
        }
        if (cmd.cmd === "workflow_list") listCalls++;
        return { content: [{ type: "text", text: "{}" }] };
      },
      confirm: async () => "yes" as const,
      bridge: {} as unknown as PanelToolCtx["bridge"],
      tabId: "test-tab",
    } as PanelToolCtx;
    const res = (await defByName("panel_open_workflow").handler({ path: exactTarget }, ctx)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("opened");
    expect(listCalls).toBe(1);
  });
});

describe("#716 workflow UUID refresh after reconnect/open/re-pin", () => {
  const OLD_UUID = "11111111-1111-4111-8111-111111111111";
  const LIVE_UUID = "22222222-2222-4222-8222-222222222222";
  const TARGET = "workflows/reconnected.json";

  it("refreshes the next command stamp from a successful panel_open_workflow response", async () => {
    const refresh = vi.fn(() => true);
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        if (cmd.cmd === "workflow_list") {
          return {
            content: [{ type: "text", text: JSON.stringify({ active: { path: TARGET, routing_key: "wf:workflows/reconnected.json", workflow_uuid: LIVE_UUID } }) }],
          };
        }
        expect(cmd).toMatchObject({ cmd: "workflow_open", path: TARGET });
        return {
          content: [{ type: "text", text: JSON.stringify({ opened: { path: TARGET }, routing_key: "wf:workflows/reconnected.json", workflow_uuid: LIVE_UUID }) }],
        };
      },
      confirm: async () => "yes" as const,
      bridge: { refreshWorkflowUuid: refresh } as unknown as PanelToolCtx["bridge"],
      tabId: "reconnected-tab",
    };

    const res = await defByName("panel_open_workflow").handler({ path: TARGET }, ctx);
    expect(res.isError).toBeFalsy();
    expect(refresh).toHaveBeenCalledExactlyOnceWith("reconnected-tab", LIVE_UUID.toLowerCase());
  });

  it("does not refresh fast success from a partial or replayed active list record (#716 P1)", async () => {
    for (const routing_key of [undefined, "wf:workflows/replayed.json", "not-a-routing-key"]) {
      const refresh = vi.fn(() => true);
      const ctx: PanelToolCtx = {
        call: async (cmd) =>
          cmd.cmd === "workflow_list"
            ? { content: [{ type: "text", text: JSON.stringify({ active: { path: TARGET, routing_key, workflow_uuid: LIVE_UUID } }) }] }
            : { content: [{ type: "text", text: JSON.stringify({ opened: { path: TARGET }, routing_key: "wf:workflows/reconnected.json", workflow_uuid: LIVE_UUID }) }] },
        confirm: async () => "yes" as const,
        bridge: { refreshWorkflowUuid: refresh } as unknown as PanelToolCtx["bridge"],
        tabId: "reconnected-tab",
      };
      const res = await defByName("panel_open_workflow").handler({ path: TARGET }, ctx);
      expect(res.isError).toBeFalsy();
      expect(refresh).not.toHaveBeenCalled();
    }
  });

  it("does not refresh from an absent or noncanonical open UUID, preserving the old fail-closed stamp", async () => {
    for (const workflow_uuid of [
      undefined,
      "not-a-uuid",
      OLD_UUID + "-suffix",
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee".toUpperCase(),
      "33333333-3333-0333-8333-333333333333", // invalid version
      "44444444-4444-4444-7444-444444444444", // invalid variant
    ]) {
      const refresh = vi.fn(() => true);
      const ctx: PanelToolCtx = {
        call: async (cmd) =>
          cmd.cmd === "workflow_list"
            ? { content: [{ type: "text", text: JSON.stringify({ active: { path: TARGET } }) }] }
            : { content: [{ type: "text", text: JSON.stringify({ opened: { path: TARGET }, workflow_uuid }) }] },
        confirm: async () => "yes" as const,
        bridge: { refreshWorkflowUuid: refresh } as unknown as PanelToolCtx["bridge"],
        tabId: "reconnected-tab",
      };
      const res = await defByName("panel_open_workflow").handler({ path: TARGET }, ctx);
      expect(res.isError).toBeFalsy();
      expect(refresh).not.toHaveBeenCalled();
    }
  });

  it("does not refresh from a late open reply once a newer navigation is active", async () => {
    const refresh = vi.fn(() => true);
    const ctx: PanelToolCtx = {
      call: async (cmd) =>
        cmd.cmd === "workflow_list"
          ? { content: [{ type: "text", text: JSON.stringify({ active: { path: "workflows/newer.json", workflow_uuid: LIVE_UUID } }) }] }
          : { content: [{ type: "text", text: JSON.stringify({ opened: { path: TARGET }, workflow_uuid: OLD_UUID }) }] },
      confirm: async () => "yes" as const,
      bridge: { refreshWorkflowUuid: refresh } as unknown as PanelToolCtx["bridge"],
      tabId: "reconnected-tab",
    };

    const res = await defByName("panel_open_workflow").handler({ path: TARGET }, ctx);
    expect(res.isError).toBeFalsy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not refresh a successful open from a different same-basename active workflow (#716 P1)", async () => {
    const requested = "workflows/a/foo.json";
    const refresh = vi.fn(() => true);
    const ctx: PanelToolCtx = {
      call: async (cmd) =>
        cmd.cmd === "workflow_list"
          ? {
              content: [{
                type: "text",
                text: JSON.stringify({
                  active: {
                    path: "workflows/b/foo.json",
                    routing_key: "wf:workflows/b/foo.json",
                    workflow_uuid: LIVE_UUID,
                  },
                }),
              }],
            }
          : {
              content: [{
                type: "text",
                text: JSON.stringify({
                  opened: { path: requested },
                  routing_key: "wf:workflows/a/foo.json",
                  workflow_uuid: OLD_UUID,
                }),
              }],
            },
      confirm: async () => "yes" as const,
      bridge: { refreshWorkflowUuid: refresh } as unknown as PanelToolCtx["bridge"],
      tabId: "reconnected-tab",
    };

    const res = await defByName("panel_open_workflow").handler({ path: requested }, ctx);
    // #716 P1's subject — the uuid must NOT be adopted from a same-basename
    // workflow in another directory — is unchanged and is still the point here.
    expect(refresh).not.toHaveBeenCalled();
    // #887 — but the OPEN is no longer reported as a success. This assertion was
    // `toBeFalsy()` and is deliberately inverted: the caller asked for
    // workflows/a/foo.json, the panel's post-open re-read says workflows/b/foo.json
    // is active, and answering "opened workflows/a/foo.json" to that is the exact
    // report that let a reporter Save-As onto the wrong canvas. Suppressing the
    // refresh protected the FENCE; it never protected the CALLER, who was told the
    // open landed. Both halves are now covered.
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain("workflows/b/foo.json");
  });

  it("does not promote an alias request to a reply-resolved path for fast-success refresh (#716 P1)", async () => {
    const requested = "foo.json";
    const resolved = "workflows/a/foo.json";
    const refresh = vi.fn(() => true);
    const ctx: PanelToolCtx = {
      call: async (cmd) =>
        cmd.cmd === "workflow_list"
          ? { content: [{ type: "text", text: JSON.stringify({ active: { path: resolved, routing_key: "wf:workflows/a/foo.json", workflow_uuid: LIVE_UUID } }) }] }
          : { content: [{ type: "text", text: JSON.stringify({ opened: { path: resolved }, routing_key: "wf:workflows/a/foo.json", workflow_uuid: LIVE_UUID }) }] },
      confirm: async () => "yes" as const,
      bridge: { refreshWorkflowUuid: refresh } as unknown as PanelToolCtx["bridge"],
      tabId: "reconnected-tab",
    };

    const res = await defByName("panel_open_workflow").handler({ path: requested }, ctx);
    expect(res.isError).toBeFalsy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not refresh fast success from an active path/routing contradiction or temporary path (#716 P1)", async () => {
    for (const { requested, active, opened } of [
      {
        requested: "workflows/a/foo.json",
        active: { path: "workflows/a/foo.json", routing_key: "wf:workflows/b/foo.json", workflow_uuid: LIVE_UUID },
        opened: { path: "workflows/a/foo.json", routing_key: "wf:workflows/a/foo.json", workflow_uuid: LIVE_UUID },
      },
      {
        requested: "tmp:ephemeral-tab",
        active: { path: "tmp:ephemeral-tab", routing_key: "wf:tmp:ephemeral-tab", workflow_uuid: LIVE_UUID },
        opened: { path: "tmp:ephemeral-tab", routing_key: "wf:tmp:ephemeral-tab", workflow_uuid: LIVE_UUID },
      },
    ]) {
      const refresh = vi.fn(() => true);
      const ctx: PanelToolCtx = {
        call: async (cmd) =>
          cmd.cmd === "workflow_list"
            ? { content: [{ type: "text", text: JSON.stringify({ active }) }] }
            : { content: [{ type: "text", text: JSON.stringify({ opened, routing_key: opened.routing_key, workflow_uuid: opened.workflow_uuid }) }] },
        confirm: async () => "yes" as const,
        bridge: { refreshWorkflowUuid: refresh } as unknown as PanelToolCtx["bridge"],
        tabId: "reconnected-tab",
      };
      const res = await defByName("panel_open_workflow").handler({ path: requested }, ctx);
      expect(res.isError).toBeFalsy();
      expect(refresh).not.toHaveBeenCalled();
    }
  });

  it("re-pin refreshes only from the same fresh active workflow record, so the following run is fenced to it", async () => {
    const refresh = vi.fn(() => true);
    const store = new WorkflowTargetStore();
    const sent: Array<Record<string, unknown>> = [];
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        expect(cmd).toMatchObject({ cmd: "workflow_list" });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              active_confirmed: true,
              active: { path: TARGET, key: "wf:workflows/reconnected.json", routing_key: "wf:workflows/reconnected.json", workflow_uuid: LIVE_UUID },
              workflows: [{ path: TARGET, key: "wf:workflows/reconnected.json", routing_key: "wf:workflows/reconnected.json", active: true, workflow_uuid: LIVE_UUID }],
            }),
          }],
        };
      },
      confirm: async () => "yes" as const,
      bridge: {
        refreshWorkflowUuid: refresh,
        push: (frame: Record<string, unknown>) => { sent.push(frame); return 1; },
      } as unknown as PanelToolCtx["bridge"],
      tabId: "reconnected-tab",
      workflowTarget: store,
    };

    const pin = await defByName("panel_set_workflow_target").handler({ mode: "pinned", path: TARGET }, ctx);
    expect(pin.isError).toBeFalsy();
    expect(store.get("reconnected-tab")).toMatchObject({ mode: "pinned", path: "wf:workflows/reconnected.json" });
    expect(refresh).toHaveBeenCalledExactlyOnceWith("reconnected-tab", LIVE_UUID.toLowerCase());
    expect(sent).toHaveLength(1);
  });

  it("does not refresh a re-pin from an alias, routing token, temporary token, or malformed caller path (#716 P1)", async () => {
    for (const callerPath of ["foo.json", "wf:workflows/reconnected.json", "tmp:ephemeral-tab", "not-a-canonical-path"]) {
      const refresh = vi.fn(() => true);
      const store = new WorkflowTargetStore();
      const ctx: PanelToolCtx = {
        call: async () => ({
          content: [{
            type: "text",
            text: JSON.stringify({
              active: { path: TARGET, routing_key: "wf:workflows/reconnected.json", workflow_uuid: LIVE_UUID },
              workflows: [{
                path: TARGET,
                filename: "foo.json",
                // Each caller form can resolve through legacy aliases; that must
                // not give it authority to replace the command fence.
                key: callerPath,
                routing_key: "wf:workflows/reconnected.json",
                active: true,
              }],
            }),
          }],
        }),
        confirm: async () => "yes" as const,
        bridge: { refreshWorkflowUuid: refresh, push: () => 1 } as unknown as PanelToolCtx["bridge"],
        tabId: "reconnected-tab",
        workflowTarget: store,
      };
      const pin = await defByName("panel_set_workflow_target").handler({ mode: "pinned", path: callerPath }, ctx);
      expect(pin.isError).toBeFalsy();
      expect(refresh).not.toHaveBeenCalled();
    }
  });

  it("does not refresh a re-pin from a partial or replayed selected/list-active record (#716 P1)", async () => {
    for (const routing_key of [undefined, "wf:workflows/replayed.json", "not-a-routing-key"]) {
      const refresh = vi.fn(() => true);
      const store = new WorkflowTargetStore();
      const ctx: PanelToolCtx = {
        call: async () => ({
          content: [{
            type: "text",
            text: JSON.stringify({
              active: { path: TARGET, routing_key, workflow_uuid: LIVE_UUID },
              workflows: [{ path: TARGET, key: "wf:workflows/reconnected.json", routing_key, active: true }],
            }),
          }],
        }),
        confirm: async () => "yes" as const,
        bridge: { refreshWorkflowUuid: refresh, push: () => 1 } as unknown as PanelToolCtx["bridge"],
        tabId: "reconnected-tab",
        workflowTarget: store,
      };
      const pin = await defByName("panel_set_workflow_target").handler({ mode: "pinned", path: TARGET }, ctx);
      expect(pin.isError).toBeFalsy();
      expect(refresh).not.toHaveBeenCalled();
    }
  });

  it("does not refresh a re-pin from an alias-selected stale active:true record that contradicts top-level active (#716 P1)", async () => {
    const refresh = vi.fn(() => true);
    const store = new WorkflowTargetStore();
    const requestedAlias = "foo.json";
    const ctx: PanelToolCtx = {
      call: async () => ({
        content: [{
          type: "text",
          text: JSON.stringify({
            // The list's item flag claims A is active, but the authoritative
            // top-level active record says B. Their same basename must not let
            // B's valid UUID replace the existing fail-closed command stamp.
            active: {
              path: "workflows/b/foo.json",
              routing_key: "wf:workflows/b/foo.json",
              workflow_uuid: LIVE_UUID,
            },
            workflows: [{
              path: "workflows/a/foo.json",
              filename: "foo.json",
              key: "wf:workflows/a/foo.json",
              routing_key: "wf:workflows/a/foo.json",
              active: true,
            }],
          }),
        }],
      }),
      confirm: async () => "yes" as const,
      bridge: {
        refreshWorkflowUuid: refresh,
        push: () => 1,
      } as unknown as PanelToolCtx["bridge"],
      tabId: "reconnected-tab",
      workflowTarget: store,
    };

    const pin = await defByName("panel_set_workflow_target").handler({ mode: "pinned", path: requestedAlias }, ctx);
    expect(pin.isError).toBeFalsy(); // Preserve legacy pin resolution; only the fence refresh is unsafe.
    expect(store.get("reconnected-tab")).toMatchObject({ mode: "pinned", path: "wf:workflows/a/foo.json" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not refresh a top-level-active re-pin unless an exact list record corroborates it (#716 P1)", async () => {
    const refresh = vi.fn(() => true);
    const store = new WorkflowTargetStore();
    const requested = "workflows/a/foo.json";
    const ctx: PanelToolCtx = {
      call: async () => ({
        content: [{
          type: "text",
          text: JSON.stringify({
            active: { path: requested, routing_key: "wf:workflows/a/foo.json", workflow_uuid: LIVE_UUID },
            // The active object is absent from this enumerable list, so there
            // is no selected record whose identity can corroborate its UUID.
            workflows: [{ path: "workflows/other.json", routing_key: "wf:workflows/other.json", active: false }],
          }),
        }],
      }),
      confirm: async () => "yes" as const,
      bridge: { refreshWorkflowUuid: refresh, push: () => 1 } as unknown as PanelToolCtx["bridge"],
      tabId: "reconnected-tab",
      workflowTarget: store,
    };

    const pin = await defByName("panel_set_workflow_target").handler({ mode: "pinned", path: requested }, ctx);
    expect(pin.isError).toBeFalsy();
    expect(store.get("reconnected-tab")).toMatchObject({ mode: "pinned", path: requested });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not refresh when a late/replayed workflow_list marks the requested target as background", async () => {
    const refresh = vi.fn(() => true);
    const ctx: PanelToolCtx = {
      call: async () => ({
        content: [{
          type: "text",
          text: JSON.stringify({
            active: { path: "workflows/other.json", key: "wf:other", workflow_uuid: LIVE_UUID },
            workflows: [{ path: TARGET, key: "wf:target", active: false, workflow_uuid: OLD_UUID }],
          }),
        }],
      }),
      confirm: async () => "yes" as const,
      bridge: { refreshWorkflowUuid: refresh, push: () => 1 } as unknown as PanelToolCtx["bridge"],
      tabId: "reconnected-tab",
      workflowTarget: new WorkflowTargetStore(),
    };

    const pin = await defByName("panel_set_workflow_target").handler({ mode: "pinned", path: TARGET }, ctx);
    expect(pin.isError).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("panel_ask surface + late-answer resilience (#300/#486) and set_todo bound (#322)", () => {
  const REPLY_TIMEOUT_ERR = (cmd: string, ms: number) =>
    new Error(
      `Panel tab abcd1234 did not reply to "${cmd}" within ${ms} ms — the ComfyUI tab may be backgrounded or frozen`,
    );

  afterEach(() => {
    // Reset the injected fast ask timing so other suites see the real defaults.
    __panelAskTestHooks.setAskTiming(null);
  });

  function askText(res: ToolResult): string {
    return (res.content[0] as { text: string }).text;
  }

  // #300 — NO INTERACTIVE SURFACE: a canvas-less/headless client (mobile mirror,
  // remote viewer, or an exec/headless run) can't render the choice card, so the
  // ask must FAIL FAST with an actionable error instead of blocking. We must never
  // even dispatch ask_user in that case.
  it("panel_ask fails FAST with an actionable error when no interactive surface can render the card (#300)", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        sent.push(cmd);
        // Simulate the old hang: never resolve. If the handler awaited this the
        // test would time out — so a passing test proves we short-circuited.
        return new Promise<never>(() => {});
      },
      canReach: () => true,
      isHeadless: () => true,
      resolveActiveTabId: () => "abcd1234",
      push: () => 1,
    } as unknown as PanelToolCtx["bridge"];
    const ctx: PanelToolCtx = { bridge, tabId: "abcd1234" } as unknown as PanelToolCtx;

    const res = await defByName("panel_ask").handler(
      { question: "Local or pod?", options: [{ label: "Local" }, { label: "Pod" }] },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(askText(res)).toMatch(/no interactive panel surface|plain chat|headless|exec/i);
    // Never dispatched — no indefinite block on a surface that can't answer.
    expect(sent.length).toBe(0);
  });

  // #486 — LATE-BUT-VALID ANSWER: the card-reply timer fired (bridge.send rejected
  // with a reply-timeout), but the user validated a pick slightly late. The bridge
  // buffered it; the handler must poll the buffer and HONOR the answer, not discard
  // it as a timeout.
  it("panel_ask honors a late-but-valid answer buffered after a reply timeout (#486)", async () => {
    __panelAskTestHooks.setAskTiming({ deadlineMs: 5, graceMs: 500, pollMs: 2 });
    let takes = 0;
    const bridge = {
      send: async (_cmd: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
        // The card timed out before the (slow) user answered.
        throw REPLY_TIMEOUT_ERR("ask_user", opts?.timeoutMs ?? 0);
      },
      canReach: () => true,
      isHeadless: () => false,
      resolveActiveTabId: () => "abcd1234",
      // The validated answer lands one poll later, after the send already rejected.
      takeLateAskReply: (_askId: string) => {
        takes += 1;
        return takes >= 2 ? "Local GPU + Blender" : undefined;
      },
      push: () => 1,
    } as unknown as PanelToolCtx["bridge"];
    const ctx: PanelToolCtx = { bridge, tabId: "abcd1234" } as unknown as PanelToolCtx;

    const res = await defByName("panel_ask").handler(
      { question: "Which?", options: [{ label: "Local GPU + Blender" }, { label: "Cloud" }] },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(askText(res)).toBe("Local GPU + Blender");
  });

  // Codex gate: the clamp must be a HARD ceiling on deadline + grace, not just the
  // default — a large env override must never be able to recreate #486.
  it("hard-clamps deadline+grace under the MCP budget even with oversized env overrides (#486)", () => {
    const prevD = process.env.COMFYUI_PANEL_ASK_DEADLINE_S;
    const prevG = process.env.COMFYUI_PANEL_ASK_GRACE_S;
    process.env.COMFYUI_PANEL_ASK_DEADLINE_S = "600"; // 600s
    process.env.COMFYUI_PANEL_ASK_GRACE_S = "600"; // 600s
    try {
      const t = __panelAskTestHooks.getAskTiming();
      expect(t.deadlineMs).toBeGreaterThan(0);
      expect(t.deadlineMs + t.graceMs).toBeLessThanOrEqual(
        __panelAskTestHooks.ASK_TOTAL_BUDGET_CAP_MS,
      );
      expect(t.deadlineMs + t.graceMs).toBeLessThan(300000);
    } finally {
      if (prevD === undefined) delete process.env.COMFYUI_PANEL_ASK_DEADLINE_S;
      else process.env.COMFYUI_PANEL_ASK_DEADLINE_S = prevD;
      if (prevG === undefined) delete process.env.COMFYUI_PANEL_ASK_GRACE_S;
      else process.env.COMFYUI_PANEL_ASK_GRACE_S = prevG;
    }
  });

  it("panel_ask clamps the card deadline under the ~300s MCP tools/call budget and returns the pick (#486)", async () => {
    let forwardedTimeout = 0;
    const bridge = {
      send: async (_cmd: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
        forwardedTimeout = opts?.timeoutMs ?? 0;
        return "Pod";
      },
      canReach: () => true,
      isHeadless: () => false,
      resolveActiveTabId: () => "abcd1234",
      push: () => 1,
    } as unknown as PanelToolCtx["bridge"];
    const ctx: PanelToolCtx = { bridge, tabId: "abcd1234" } as unknown as PanelToolCtx;

    const res = await defByName("panel_ask").handler(
      { question: "Where?", options: [{ label: "Local" }, { label: "Pod" }] },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(askText(res)).toBe("Pod");
    // Must NOT be the old 600000ms (which outlived the 300s MCP budget → lost answer).
    expect(forwardedTimeout).toBeGreaterThan(0);
    expect(forwardedTimeout).toBeLessThan(300000);
  });

  // #322 — set_todo must not false-timeout a responsive session. Model a tab that
  // acks in ~8s (momentarily backgrounded): the OLD 5s bound would reject it; the
  // handler must forward a sane bound (>=15s) so the ack succeeds.
  it("panel_set_todo does NOT false-timeout a responsive (8s-ack) session — sane bound (#322)", async () => {
    const RESPONSIVE_ACK_MS = 8000;
    let forwardedTimeout = 0;
    const sent: Array<Record<string, unknown>> = [];
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
        forwardedTimeout = opts?.timeoutMs ?? 6000;
        if (forwardedTimeout < RESPONSIVE_ACK_MS) {
          throw REPLY_TIMEOUT_ERR("set_todo", forwardedTimeout);
        }
        sent.push(cmd);
        return { ok: true };
      },
      canReach: () => true,
      resolveActiveTabId: () => "abcd1234",
      push: () => 1,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "abcd1234");

    const res = await defByName("panel_set_todo").handler(
      { items: [{ text: "step one", status: "active" }] },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(forwardedTimeout).toBeGreaterThanOrEqual(15000);
    expect(sent.at(-1)).toMatchObject({ cmd: "set_todo" });
  });
});

describe("confirm-card timeout is honest, bounded, and late-answer-safe (#360)", () => {
  const REPLY_TIMEOUT_ERR = (cmd: string, ms: number) =>
    new Error(
      `Panel tab abcd1234 did not reply to "${cmd}" within ${ms} ms — the ComfyUI tab may be backgrounded or frozen`,
    );

  function toolText(res: ToolResult): string {
    return (res.content[0] as { text: string }).text;
  }

  // #814 widened the refuse-safe preflight to EVERY local target, not only a
  // tab-bound one, so panel_restart_comfyui now consults it on this path too.
  // These tests are about the confirm card, and the real preflight would do live
  // process/port discovery against the host — stub a PASS so the card is the only
  // thing under test.
  beforeEach(() => {
    __panelToolsTestHooks.setLocalRestartPreflight(async () => ({ ok: true }));
  });

  afterEach(() => {
    __panelAskTestHooks.setAskTiming(null);
    __panelToolsTestHooks.setHealthProbe(null);
    __panelToolsTestHooks.setLocalRestartPreflight(null);
    __panelToolsTestHooks.setPanelRebootTiming(null);
  });

  // FAIL-BEFORE: the old confirm swallowed a card-reply timeout as `false`, so an
  // unanswered restart card reported "Cancelled — ComfyUI was not restarted." (a
  // wrong, definitive decline). PASS-AFTER: an unanswered card reports an honest
  // "timed out waiting for confirmation" AND never dispatches the reboot.
  it("panel_restart_comfyui reports a timeout honestly and does NOT restart when the card is unanswered", async () => {
    __panelAskTestHooks.setAskTiming({ deadlineMs: 5, graceMs: 20, pollMs: 2 });
    const dispatched: Array<Record<string, unknown>> = [];
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
        if (cmd.cmd === "ask_user") throw REPLY_TIMEOUT_ERR("ask_user", opts?.timeoutMs ?? 0);
        dispatched.push(cmd);
        return { rebooting: true };
      },
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "abcd1234");

    const res = await defByName("panel_restart_comfyui").handler({}, ctx);
    expect(res.isError).toBeFalsy();
    // #404: honest, ACTIONABLE timeout — names the retry AND the restart_comfyui fallback.
    expect(toolText(res)).toMatch(/no confirmation received within/i);
    expect(toolText(res)).toMatch(/restart_comfyui/);
    expect(toolText(res)).not.toMatch(/^Cancelled/);
    // Critically: the reboot was NEVER dispatched (no auto-confirm).
    expect(dispatched.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  // The confirm card deadline must be CLAMPED under the ~300s MCP tools/call budget
  // (the old hardcoded 300000ms had zero margin and blew the transport).
  it("panel_restart_comfyui clamps the confirm-card deadline under the MCP budget", async () => {
    // #742: the decline path probes the server before reporting — stub it healthy
    // (a clean decline; no real loopback fetch in a unit test).
    __panelToolsTestHooks.setHealthProbe(async () => true);
    let forwardedTimeout = Infinity;
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
        if (cmd.cmd === "ask_user") {
          forwardedTimeout = opts?.timeoutMs ?? 0;
          return "No, cancel";
        }
        return { rebooting: true };
      },
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "abcd1234");

    await defByName("panel_restart_comfyui").handler({}, ctx);
    expect(forwardedTimeout).toBeGreaterThan(0);
    expect(forwardedTimeout).toBeLessThan(300000);
  });

  // #404: the confirm-card wait must be bounded by the dedicated restart-confirm
  // ceiling — NOT the full ~255s remaining budget it used to inherit (which read as an
  // indefinite hang when a card went unanswered after a prior restart's reconnect).
  it("panel_restart_comfyui bounds the confirm-card wait by RESTART_CONFIRM_TIMEOUT_MS (not the full ~255s budget)", async () => {
    // No ask-timing override → the REAL getAskTiming (240s) is in effect, so the forwarded
    // reply timeout reflects the handler's own confirm budget, not a test clamp.
    // #742: the decline path probes the server before reporting — stub it healthy
    // (a clean decline; no real loopback fetch in a unit test).
    __panelToolsTestHooks.setHealthProbe(async () => true);
    let forwardedTimeout = Infinity;
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
        if (cmd.cmd === "ask_user") {
          forwardedTimeout = opts?.timeoutMs ?? 0;
          return "No, cancel";
        }
        return { rebooting: true };
      },
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "abcd1234");

    await defByName("panel_restart_comfyui").handler({}, ctx);
    expect(forwardedTimeout).toBeGreaterThan(0);
    expect(forwardedTimeout).toBeLessThanOrEqual(
      __panelToolsTestHooks.RESTART_CONFIRM_TIMEOUT_MS,
    );
    // And well under the old ~255s inheritance that produced the #404 hang.
    expect(forwardedTimeout).toBeLessThan(240000);
  });

  // #404 core regression: an unanswered/undelivered restart confirmation must REJECT with
  // the actionable timeout error WITHIN the bound — never hang indefinitely — and must
  // NOT dispatch the reboot (no auto-confirm). Bounded via the fast ask-timing override
  // so the test proves the fail-fast without waiting the real ceiling.
  it("panel_restart_comfyui fails fast with an actionable error when the confirmation card is never answered (#404)", async () => {
    __panelAskTestHooks.setAskTiming({ deadlineMs: 5, graceMs: 15, pollMs: 2 });
    const dispatched: Array<Record<string, unknown>> = [];
    const bridge = {
      // The card is DELIVERED but the tab never replies (backgrounded / reconnecting).
      send: async (cmd: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
        if (cmd.cmd === "ask_user") throw REPLY_TIMEOUT_ERR("ask_user", opts?.timeoutMs ?? 0);
        dispatched.push(cmd);
        return { rebooting: true };
      },
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "abcd1234");

    const started = Date.now();
    const res = await defByName("panel_restart_comfyui").handler({}, ctx);
    // Settled promptly — not an indefinite hang.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.isError).toBeFalsy();
    const text = toolText(res);
    expect(text).toMatch(/no confirmation received within/i);
    expect(text).toMatch(/backgrounded|reconnecting/i);
    expect(text).toMatch(/restart_comfyui/);
    // The reboot was NEVER dispatched — the wait is bounded, not the confirmation bypassed.
    expect(dispatched.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  // #404: a normally-confirmed restart still proceeds to dispatch the reboot — the bound
  // is on the WAIT only; a real "yes" is honored exactly as before.
  it("panel_restart_comfyui still dispatches the reboot on a normal 'yes' confirmation (#404)", async () => {
    // A BOUND tab (below) means the handler also observes recovery on the boot
    // endpoint, so give it a fast, deterministic budget — this test asserts that the
    // confirmation is honored and the reboot dispatched, not what the recovery says.
    __panelToolsTestHooks.setPanelRebootTiming({
      settleMs: 0,
      budgetMs: 30,
      intervalMs: 5,
      probeTimeoutMs: 10,
    });
    __panelToolsTestHooks.setHealthProbe(async () => false);
    const dispatched: Array<Record<string, unknown>> = [];
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        if (cmd.cmd === "ask_user") return "Yes, go ahead";
        dispatched.push(cmd);
        return { rebooting: true };
      },
      // BOUND to our own boot instance (#814): a LOCAL target the panel cannot tie
      // to the instance this server accounts for is refused before dispatch, since a
      // reboot STOPS a server and it must know which one. This test is about the
      // CONFIRMATION being honored, so it models the ordinary local panel.
      tabIsLocal: () => true,
      tabServerOrigin: () => (getBootLocalComfyUIBaseUrl() ?? "http://127.0.0.1:8188").replace(/[/]+$/, ""),
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "abcd1234");

    const res = await defByName("panel_restart_comfyui").handler({}, ctx);
    expect(res.isError).toBeFalsy();
    expect(dispatched.some((c) => c.cmd === "comfy_reboot")).toBe(true);
  });

  // #360 mirrors #486: a slow-but-valid answer buffered after the card timeout must
  // be HONORED, not lost — a late "yes" still performs the action. Uses panel_clear
  // (dispatch-and-return) so the assertion isolates the confirm path.
  it("confirm honors a late-but-valid 'yes' buffered after the card timeout", async () => {
    __panelAskTestHooks.setAskTiming({ deadlineMs: 5, graceMs: 500, pollMs: 2 });
    const dispatched: Array<Record<string, unknown>> = [];
    let takes = 0;
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
        if (cmd.cmd === "ask_user") throw REPLY_TIMEOUT_ERR("ask_user", opts?.timeoutMs ?? 0);
        dispatched.push(cmd);
        return {};
      },
      takeLateAskReply: (_askId: string) => {
        takes += 1;
        return takes >= 2 ? "Yes, go ahead" : undefined;
      },
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "abcd1234");

    const res = await defByName("panel_clear").handler({}, ctx);
    expect(res.isError).toBeFalsy();
    expect(toolText(res)).not.toMatch(/timed out|Cancelled/i);
    expect(dispatched.some((c) => c.cmd === "graph_clear")).toBe(true);
  });

  // An explicit decline is still a clean, definitive "Cancelled" (not a timeout).
  it("panel_clear reports a clean cancel on an explicit decline and a timeout on no answer", async () => {
    __panelAskTestHooks.setAskTiming({ deadlineMs: 5, graceMs: 20, pollMs: 2 });
    // Decline branch.
    const declineDispatched: Array<Record<string, unknown>> = [];
    const declineBridge = {
      send: async (cmd: Record<string, unknown>) => {
        if (cmd.cmd === "ask_user") return "No, cancel";
        declineDispatched.push(cmd);
        return {};
      },
    } as unknown as PanelToolCtx["bridge"];
    const declineRes = await defByName("panel_clear").handler(
      {},
      makePanelToolCtx(declineBridge, "abcd1234"),
    );
    expect(toolText(declineRes)).toMatch(/^Cancelled/);
    expect(declineDispatched.some((c) => c.cmd === "graph_clear")).toBe(false);

    // Timeout branch.
    const timeoutBridge = {
      send: async (cmd: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
        if (cmd.cmd === "ask_user") throw REPLY_TIMEOUT_ERR("ask_user", opts?.timeoutMs ?? 0);
        return {};
      },
    } as unknown as PanelToolCtx["bridge"];
    const timeoutRes = await defByName("panel_clear").handler(
      {},
      makePanelToolCtx(timeoutBridge, "abcd1234"),
    );
    expect(toolText(timeoutRes)).toMatch(/timed out waiting for your confirmation/i);
  });
});

describe("panel_strip_workflow live-canvas fallback (issue #384)", () => {
  it("reconstructUiFromState rebuilds nodes + links with name-keyed widgets", () => {
    const state = {
      nodes: [
        {
          id: 1,
          type: "CheckpointLoaderSimple",
          widgets: { ckpt_name: "m.ckpt" },
          inputs: [],
          outputs: [{ name: "MODEL", type: "MODEL" }],
        },
        {
          id: 2,
          type: "KSampler",
          widgets: { seed: 42, steps: 20 },
          inputs: [
            { name: "model", type: "MODEL", connected_from: { node_id: 1, output_slot: 0 } },
          ],
          outputs: [],
        },
      ],
    };
    const ui = __panelToolsTestHooks.reconstructUiFromState(state) as {
      nodes: Array<{ id: number; inputs: Array<{ link: number | null }>; widgets_values: unknown }>;
      links: unknown[];
    } | null;
    expect(ui).not.toBeNull();
    expect(ui!.nodes.length).toBe(2);
    expect(ui!.links.length).toBe(1);
    const ks = ui!.nodes.find((n) => n.id === 2)!;
    expect(ks.inputs[0].link).not.toBeNull();
    // widgets survive keyed BY NAME (convertUiToApi maps them by name)
    expect(ks.widgets_values).toEqual({ seed: 42, steps: 20 });
  });

  it("returns null when the state reply has no nodes", () => {
    expect(__panelToolsTestHooks.reconstructUiFromState({ nodes: [] })).toBeNull();
    expect(__panelToolsTestHooks.reconstructUiFromState({})).toBeNull();
  });

  it("refuses a TRUNCATED state reply rather than stripping a partial graph", () => {
    const partial = {
      truncated: true,
      node_count: 250,
      nodes: [{ id: 1, type: "SaveImage", widgets: {}, inputs: [], outputs: [] }],
    };
    expect(__panelToolsTestHooks.reconstructUiFromState(partial)).toBeNull();
    // also caught by the node_count > nodes.length guard alone
    expect(
      __panelToolsTestHooks.reconstructUiFromState({
        node_count: 3,
        nodes: [{ id: 1, type: "SaveImage", widgets: {}, inputs: [], outputs: [] }],
      }),
    ).toBeNull();
  });

  it("falls back to graph_get_state when graph_serialize is an unknown command", async () => {
    const sent: string[] = [];
    const ctx = {
      tabId: "t",
      ensureReachable: () => {},
      bridge: {
        send: async (cmd: { cmd: string }) => {
          sent.push(cmd.cmd);
          if (cmd.cmd === "graph_serialize") {
            throw new Error('Unknown command "graph_serialize"');
          }
          if (cmd.cmd === "graph_get_state") {
            return {
              nodes: [
                { id: 1, type: "SaveImage", widgets: { filename_prefix: "out" }, inputs: [], outputs: [] },
              ],
            };
          }
          return {};
        },
      },
    } as unknown as PanelToolCtx;
    const wf = (await __panelToolsTestHooks.resolveWorkflowInput({}, ctx)) as {
      nodes: Array<{ type: string }>;
    };
    expect(sent).toContain("graph_serialize");
    expect(sent).toContain("graph_get_state");
    expect(wf.nodes[0].type).toBe("SaveImage");
  });

  it("surfaces the actionable error when neither serialize nor state is available", async () => {
    const ctx = {
      tabId: "t",
      ensureReachable: () => {},
      bridge: {
        send: async (cmd: { cmd: string }) => {
          throw new Error(`Unknown command "${cmd.cmd}"`);
        },
      },
    } as unknown as PanelToolCtx;
    await expect(
      __panelToolsTestHooks.resolveWorkflowInput({}, ctx),
    ).rejects.toThrow(/pass pack, path, or graph/);
  });

  it("does NOT fall back when allowStateFallback is false (flatten/slice keep the actionable error)", async () => {
    const sent: string[] = [];
    const ctx = {
      tabId: "t",
      ensureReachable: () => {},
      bridge: {
        send: async (cmd: { cmd: string }) => {
          sent.push(cmd.cmd);
          throw new Error('Unknown command "graph_serialize"');
        },
      },
    } as unknown as PanelToolCtx;
    await expect(
      __panelToolsTestHooks.resolveWorkflowInput({}, ctx, false),
    ).rejects.toThrow(/pass pack, path, or graph/);
    // the lossy state reconstruction must NOT run for flatten/slice
    expect(sent).not.toContain("graph_get_state");
  });

  it("does NOT fall back on a genuine transport error (surfaces as-is)", async () => {
    const sent: string[] = [];
    const ctx = {
      tabId: "t",
      ensureReachable: () => {},
      bridge: {
        send: async (cmd: { cmd: string }) => {
          sent.push(cmd.cmd);
          throw new Error("disconnected mid-command — genuinely gone");
        },
      },
    } as unknown as PanelToolCtx;
    await expect(
      __panelToolsTestHooks.resolveWorkflowInput({}, ctx),
    ).rejects.toThrow(/Couldn't capture the live canvas/);
    // never attempted the state fallback for a non-unknown-command failure
    expect(sent).not.toContain("graph_get_state");
  });

  // #413 — the REAL bridge does NOT surface the raw "Unknown command" text: the
  // reactive rewrite (makeUnknownCommandError) and the #236 proactive gate both
  // throw a "too old for graph_serialize" error instead. The old
  // /unknown command/ test here never matched that, so the graph_get_state
  // fallback was silently SKIPPED and the actionable error surfaced even though
  // the back-compat path would have worked. These assert the fallback now fires.
  it("falls back to graph_get_state on the bridge's REWRITTEN 'too old' error (message-only)", async () => {
    const sent: string[] = [];
    const ctx = {
      tabId: "t",
      ensureReachable: () => {},
      bridge: {
        send: async (cmd: { cmd: string }) => {
          sent.push(cmd.cmd);
          if (cmd.cmd === "graph_serialize") {
            // The bridge-rewritten message — note it no longer says "unknown command".
            throw new Error(
              'This ComfyUI-MCP panel is too old for "graph_serialize" (detected 0.7.0) — update the ComfyUI-MCP panel to ≥0.8.2, then reconnect.',
            );
          }
          if (cmd.cmd === "graph_get_state") {
            return {
              nodes: [
                { id: 1, type: "SaveImage", widgets: { filename_prefix: "out" }, inputs: [], outputs: [] },
              ],
            };
          }
          return {};
        },
      },
    } as unknown as PanelToolCtx;
    const wf = (await __panelToolsTestHooks.resolveWorkflowInput({}, ctx)) as {
      nodes: Array<{ type: string }>;
    };
    expect(sent).toContain("graph_serialize");
    expect(sent).toContain("graph_get_state");
    expect(wf.nodes[0].type).toBe("SaveImage");
  });

  it("falls back on the STRUCTURED unsupported-command tag (the #236 proactive gate throws this)", async () => {
    const sent: string[] = [];
    const tagged = Object.assign(
      new Error('This ComfyUI-MCP panel is too old for "graph_serialize" — update…'),
      { panelCmdUnsupported: "graph_serialize" },
    );
    const ctx = {
      tabId: "t",
      ensureReachable: () => {},
      bridge: {
        send: async (cmd: { cmd: string }) => {
          sent.push(cmd.cmd);
          if (cmd.cmd === "graph_serialize") throw tagged;
          if (cmd.cmd === "graph_get_state") {
            return {
              nodes: [{ id: 9, type: "PreviewImage", widgets: {}, inputs: [], outputs: [] }],
            };
          }
          return {};
        },
      },
    } as unknown as PanelToolCtx;
    const wf = (await __panelToolsTestHooks.resolveWorkflowInput({}, ctx)) as {
      nodes: Array<{ type: string }>;
    };
    expect(sent).toContain("graph_get_state");
    expect(wf.nodes[0].type).toBe("PreviewImage");
  });

  // #721 — the version hint ("an older panel may not support graph_serialize —
  // pass pack, path, or graph instead") is only accurate for an actual
  // unsupported-command rejection. Appending it to ANY capture failure
  // misdiagnosed e.g. the panel's graph desync guard (whose remedy is
  // rebinding/opening the workflow), sending the agent down the wrong path.
  it("does NOT append the version hint to a desync-guard-style error (original message preserved)", async () => {
    const sent: string[] = [];
    const ctx = {
      tabId: "t",
      ensureReachable: () => {},
      bridge: {
        send: async (cmd: { cmd: string }) => {
          sent.push(cmd.cmd);
          // The panel's graph desync guard — NOT an unsupported-command
          // rejection; its own message already carries the remedy.
          throw new Error(
            "live graph is out of sync with the active workflow — rebind or open the workflow in the panel, then retry",
          );
        },
      },
    } as unknown as PanelToolCtx;
    const err = await __panelToolsTestHooks.resolveWorkflowInput({}, ctx).then(
      () => {
        throw new Error("expected resolveWorkflowInput to reject");
      },
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain("live graph is out of sync with the active workflow");
    expect(err.message).toContain("Couldn't capture the live canvas");
    expect(err.message).not.toContain("may not support graph_serialize");
    expect(err.message).not.toContain("pass pack, path, or graph");
    // no graph_get_state fallback attempt for a non-unsupported failure
    expect(sent).not.toContain("graph_get_state");
  });

  it("DOES append the version hint when the error IS an unsupported-command rejection", async () => {
    const ctx = {
      tabId: "t",
      ensureReachable: () => {},
      bridge: {
        send: async (cmd: { cmd: string }) => {
          // Every command unsupported — the graph_get_state fallback also
          // fails, so the throw path is reached with the original
          // unsupported-command error for graph_serialize.
          throw new Error(`Unknown command "${cmd.cmd}"`);
        },
      },
    } as unknown as PanelToolCtx;
    const err = await __panelToolsTestHooks.resolveWorkflowInput({}, ctx).then(
      () => {
        throw new Error("expected resolveWorkflowInput to reject");
      },
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain("may not support graph_serialize");
    expect(err.message).toContain("pass pack, path, or graph");
  });
});

// -- #486: a VALIDATED panel_ask answer must survive the tool call that asked --
//
// The whole failure is that the user's answer has exactly one delivery channel —
// the return value of an MCP `tools/call` that can be dead by the time it
// arrives. These tests drive the real handler over a fake bridge and hold both
// halves of the fix: an answer that was given is never lost, and a recovered
// answer is never applied to a different question.
describe("panel_ask keeps a validated answer across a tool timeout (#486)", () => {
  const REPLY_TIMEOUT_ERR = (cmd: string, ms: number) =>
    new Error(
      `Panel tab abcd1234 did not reply to "${cmd}" within ${ms} ms — the ComfyUI tab may be backgrounded or frozen`,
    );
  const TAB = "abcd1234";
  const SAMPLER = {
    question: "Which sampler should I use?",
    options: [{ label: "euler" }, { label: "dpmpp_2m" }],
  };
  const SCHEDULER = {
    question: "Which scheduler should I use?",
    options: [{ label: "karras" }, { label: "normal" }],
  };

  /** Ask ids of every card the handler actually dispatched, in order. */
  let dispatchedAskIds: string[] = [];

  function timingOutBridge(): PanelToolCtx["bridge"] {
    return {
      send: async (cmd: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
        if (typeof cmd.ask_id === "string") dispatchedAskIds.push(cmd.ask_id);
        throw REPLY_TIMEOUT_ERR(String(cmd.cmd), opts?.timeoutMs ?? 0);
      },
      canReach: () => true,
      isHeadless: () => false,
      resolveActiveTabId: () => TAB,
      takeLateAskReply: () => undefined,
      push: () => 1,
    } as unknown as PanelToolCtx["bridge"];
  }

  function askText(res: ToolResult): string {
    return (res.content[0] as { text: string }).text;
  }

  beforeEach(() => {
    AskAnswers.reset();
    AskAnswers.setFlusher(() => {});
    dispatchedAskIds = [];
    __panelAskTestHooks.setAskTiming({ deadlineMs: 5, graceMs: 10, pollMs: 2 });
  });
  afterEach(() => {
    __panelAskTestHooks.setAskTiming(null);
    AskAnswers.reset();
  });

  /** Play out the real #486 sequence: the card times out (the tool call is gone),
   *  and only THEN does the user validate a pick, which the bridge's late-answer
   *  sink journals with nobody left to hand it to. */
  async function askThenAnswerLate(
    ask: { question: string; options: unknown },
    answer: string,
  ): Promise<ToolResult> {
    const ctx: PanelToolCtx = {
      bridge: timingOutBridge(),
      tabId: TAB,
    } as unknown as PanelToolCtx;
    const res = await defByName("panel_ask").handler(ask as Record<string, unknown>, ctx);
    const askId = dispatchedAskIds[dispatchedAskIds.length - 1];
    AskAnswers.record(askId, answer, { tabId: TAB }); // the bridge sink
    return res;
  }

  it("journals the answer as an ORPHAN when no tool call is left to receive it", async () => {
    const first = await askThenAnswerLate(SAMPLER, "dpmpp_2m");
    expect(first.isError).toBe(true); // the first call genuinely timed out
    const orphans = AskAnswers.orphansFor(TAB);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].answer).toBe("dpmpp_2m");
    expect(orphans[0].question).toBe(SAMPLER.question);
    // Armed for the durable push, so the agent learns of it even if panel_ask is
    // never called again.
    expect(orphans[0].delivery).toBe("pending");
  });

  it("a re-ask of the SAME question returns the answer the user already gave", async () => {
    await askThenAnswerLate(SAMPLER, "dpmpp_2m");
    const ctx: PanelToolCtx = {
      bridge: timingOutBridge(),
      tabId: TAB,
    } as unknown as PanelToolCtx;
    // The user does not answer again — they believe they already did.
    const res = await defByName("panel_ask").handler(SAMPLER as Record<string, unknown>, ctx);
    expect(res.isError).toBeFalsy();
    const text = askText(res);
    expect(text).toContain("dpmpp_2m");
    expect(text).toContain("RECOVERED ANSWER");
    expect(text).toContain(SAMPLER.question);
  });

  // codex round 3, P0: the recovery used to DELETE the journal's copy the moment
  // it handed the answer back — but that hand-off is a ToolResult, which is
  // exactly the thing that can be abandoned (it IS #486). Destroying the copy
  // there recreates the bug one level up, so a further re-ask gets it AGAIN,
  // flagged so the agent does not act on it twice.
  it("a recovered answer survives its own hand-off and is re-surfaced, flagged", async () => {
    await askThenAnswerLate(SAMPLER, "dpmpp_2m");
    const ctx = () => ({ bridge: timingOutBridge(), tabId: TAB }) as unknown as PanelToolCtx;
    const first = await defByName("panel_ask").handler(SAMPLER as Record<string, unknown>, ctx());
    expect(first.isError).toBeFalsy();
    expect(askText(first)).toContain("dpmpp_2m");
    expect(askText(first)).not.toMatch(/handed to you before/i);
    const second = await defByName("panel_ask").handler(SAMPLER as Record<string, unknown>, ctx());
    expect(second.isError).toBeFalsy();
    expect(askText(second)).toContain("dpmpp_2m");
    expect(askText(second)).toMatch(/handed to you before/i);
  });

  // THE INVERSE, and the more damaging direction: a replayed answer must never
  // satisfy a DIFFERENT question. The agent acting on an answer to something else
  // is worse than the agent losing the answer entirely.
  it("a journaled answer NEVER satisfies a different question", async () => {
    await askThenAnswerLate(SAMPLER, "dpmpp_2m");
    const ctx: PanelToolCtx = {
      bridge: timingOutBridge(),
      tabId: TAB,
    } as unknown as PanelToolCtx;
    const res = await defByName("panel_ask").handler(SCHEDULER as Record<string, unknown>, ctx);
    // NOT answered — the scheduler question has no answer on file.
    expect(res.isError).toBe(true);
    const text = askText(res);
    // #1243 — the wording now states the elapsed ceiling rather than a vague
    // "in time", and distinguishes a timeout from a delivery failure. The
    // assertion tracks the INTENT (it is reported as unanswered) rather than the
    // old phrasing.
    expect(text).toMatch(/went unanswered for \d+s|not answered within \d+s/i);
    // ...but the sampler answer is REPORTED rather than swallowed, quoted with
    // the question it actually answers and an explicit refusal to let it stand in.
    expect(text).toContain(SAMPLER.question);
    expect(text).toContain("dpmpp_2m");
    expect(text).toMatch(/do NOT use any of them as the answer to the question you just asked/i);
  });

  it("an answer given on a DIFFERENT tab never leaks into this tab's ask", async () => {
    await askThenAnswerLate(SAMPLER, "dpmpp_2m");
    const ctx: PanelToolCtx = {
      bridge: timingOutBridge(),
      tabId: "zzzz9999",
    } as unknown as PanelToolCtx;
    const res = await defByName("panel_ask").handler(SAMPLER as Record<string, unknown>, ctx);
    expect(res.isError).toBe(true);
    expect(askText(res)).not.toContain("dpmpp_2m");
  });

  it("an answer that merely lost the grace-poll race is returned as THIS ask's own answer", async () => {
    // The sink journals the pick microseconds after the last poll. It is this
    // card's answer, so it comes back verbatim — not dressed up as a recovery.
    let askId: string | null = null;
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
        askId = String(cmd.ask_id);
        throw REPLY_TIMEOUT_ERR(String(cmd.cmd), opts?.timeoutMs ?? 0);
      },
      canReach: () => true,
      isHeadless: () => false,
      resolveActiveTabId: () => TAB,
      takeLateAskReply: () => {
        // Landed in the journal instead of the buffer, just after the last poll.
        if (askId) AskAnswers.record(askId, "dpmpp_2m", { tabId: TAB });
        return undefined;
      },
      push: () => 1,
    } as unknown as PanelToolCtx["bridge"];
    const ctx: PanelToolCtx = { bridge, tabId: TAB } as unknown as PanelToolCtx;
    const res = await defByName("panel_ask").handler(SAMPLER as Record<string, unknown>, ctx);
    expect(res.isError).toBeFalsy();
    expect(askText(res)).toBe("dpmpp_2m");
  });

  it("the ordinary answered path is unchanged — the raw pick, and nothing pushed", async () => {
    const bridge = {
      send: async () => "euler",
      canReach: () => true,
      isHeadless: () => false,
      resolveActiveTabId: () => TAB,
      takeLateAskReply: () => undefined,
      push: () => 1,
    } as unknown as PanelToolCtx["bridge"];
    const ctx: PanelToolCtx = { bridge, tabId: TAB } as unknown as PanelToolCtx;
    const res = await defByName("panel_ask").handler(SAMPLER as Record<string, unknown>, ctx);
    expect(res.isError).toBeFalsy();
    expect(askText(res)).toBe("euler");
    // A ToolResult is a hand-off, not a proof, so the answer stays on file — but
    // it must NOT be announced to the agent as an orphan, or every single ask
    // would be reported twice.
    expect(AskAnswers.hasOutstanding()).toBe(false);
    expect(AskAnswers.orphansFor(TAB)).toHaveLength(0);
  });

  it("a plain unanswered ask (nothing ever given) still fails cleanly and quietly", async () => {
    const ctx: PanelToolCtx = {
      bridge: timingOutBridge(),
      tabId: TAB,
    } as unknown as PanelToolCtx;
    const res = await defByName("panel_ask").handler(SAMPLER as Record<string, unknown>, ctx);
    expect(res.isError).toBe(true);
    expect(askText(res)).toMatch(/went unanswered for \d+s|not answered within \d+s/i);
    expect(askText(res)).not.toMatch(/HOWEVER/);
  });

  // codex round 1, P0: an answer that went into a ToolResult used to be forgotten
  // once it aged past the recovery window. But "it went into a ToolResult" is
  // exactly what is NOT provable here (that IS #486), so a re-ask of the same
  // question past the window must still be TOLD the user answered it — the
  // difference between a stale answer and silence.
  it("a re-ask past the recovery window is told the user answered it before", async () => {
    const bridge = {
      send: async () => "dpmpp_2m",
      canReach: () => true,
      isHeadless: () => false,
      resolveActiveTabId: () => TAB,
      takeLateAskReply: () => undefined,
      push: () => 1,
    } as unknown as PanelToolCtx["bridge"];
    const first = await defByName("panel_ask").handler(SAMPLER as Record<string, unknown>, {
      bridge,
      tabId: TAB,
    } as unknown as PanelToolCtx);
    expect(askText(first)).toBe("dpmpp_2m");
    // Age it out of the recovery window (it must NOT have been deleted).
    const entry = AskAnswers.entriesFor(TAB)[0];
    expect(entry).toBeDefined();
    entry.answeredAt = Date.now() - 60 * 60_000;
    const res = await defByName("panel_ask").handler(SAMPLER as Record<string, unknown>, {
      bridge: timingOutBridge(),
      tabId: TAB,
    } as unknown as PanelToolCtx);
    // Not served as this ask's answer (too old to present as a fresh decision)…
    expect(res.isError).toBe(true);
    // …but reported, quoted with the question it answers.
    expect(askText(res)).toContain("dpmpp_2m");
    expect(askText(res)).toContain(SAMPLER.question);
  });

  it("an answer to a card whose CONVERSATION was replaced can never satisfy a re-ask", async () => {
    await askThenAnswerLate(SAMPLER, "dpmpp_2m");
    AskAnswers.closeAsks(TAB); // New chat / resume of a historical session
    const res = await defByName("panel_ask").handler(SAMPLER as Record<string, unknown>, {
      bridge: timingOutBridge(),
      tabId: TAB,
    } as unknown as PanelToolCtx);
    expect(res.isError).toBe(true);
    expect(askText(res)).not.toContain("RECOVERED ANSWER");
    // Reported as a COUNT, never as content: the pick belongs to the replaced
    // conversation, and showing it here is the leak the boundary exists to stop.
    expect(askText(res)).not.toContain("dpmpp_2m");
    expect(askText(res)).toMatch(/belong to a DIFFERENT conversation/i);
    // …and it is still on file, not swallowed.
    expect(AskAnswers.entriesFor(TAB).some((e) => e.answer === "dpmpp_2m")).toBe(true);
  });

  // codex round 9, P0: the LATE answer is claimed from a bridge buffer keyed by
  // `ask_id` ALONE. If that id ever stood for two cards, the buffer cannot say
  // which one the reply came from — and the handler used to return it as this
  // question's answer regardless, handing card B the answer given to card A.
  // The rid-correlated path is exempt: a reply on THIS send's own request id is
  // this card's reply by construction.
  it("a LATE answer whose ask id is ambiguous is reported, never returned as the answer", async () => {
    let askId: string | null = null;
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
        askId = String(cmd.ask_id);
        // Make the id stand for a SECOND card before the late answer is claimed.
        AskAnswers.openAsk(askId, {
          tabId: TAB,
          fingerprint: "some-other-question",
          question: "A different question entirely?",
        });
        throw REPLY_TIMEOUT_ERR(String(cmd.cmd), opts?.timeoutMs ?? 0);
      },
      canReach: () => true,
      isHeadless: () => false,
      resolveActiveTabId: () => TAB,
      takeLateAskReply: () => "dpmpp_2m",
      push: () => 1,
    } as unknown as PanelToolCtx["bridge"];
    const ctx: PanelToolCtx = { bridge, tabId: TAB } as unknown as PanelToolCtx;
    const res = await defByName("panel_ask").handler(SAMPLER as Record<string, unknown>, ctx);
    expect(res.isError).toBe(true);
    expect(askText(res)).toMatch(/CANNOT be attributed/i);
    // The pick is still surfaced — reported, never swallowed — and it was not
    // counted as delivered, so the orphan machinery still owns it.
    expect(askText(res)).toContain("dpmpp_2m");
    expect(AskAnswers.orphansFor(TAB).some((e) => e.answer === "dpmpp_2m")).toBe(true);
  });

  // Gate: a rid proves WHICH CARD replied — it says nothing about whose
  // conversation is live. An ask retired while its request was still pending (a
  // different browser tab took the recurring key over, a New chat, a rewind)
  // must not have its answer handed back through the tool-result channel, which
  // is the one path a conversation boundary does not otherwise police.
  it("an answer arriving after its conversation was replaced is reported, not returned", async () => {
    let askId: string | null = null;
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        askId = String(cmd.ask_id);
        // The boundary lands while this request is still in flight…
        AskAnswers.closeAsks(TAB);
        // …and only then does the user click, resolving THIS send's own rid.
        return "dpmpp_2m";
      },
      canReach: () => true,
      isHeadless: () => false,
      resolveActiveTabId: () => TAB,
      takeLateAskReply: () => undefined,
      push: () => 1,
    } as unknown as PanelToolCtx["bridge"];
    const ctx: PanelToolCtx = { bridge, tabId: TAB } as unknown as PanelToolCtx;

    const res = await defByName("panel_ask").handler(SAMPLER as Record<string, unknown>, ctx);
    expect(askId).not.toBeNull();
    expect(res.isError).toBe(true);
    expect(askText(res)).toMatch(/conversation that asked it has been replaced/i);
    // The pick is NOT shown. Labelling it "for the replaced conversation" does
    // not stop the replacement turn from reading it — the tool result is the one
    // channel a boundary never policed, and a label is not a fence.
    expect(askText(res)).not.toContain("dpmpp_2m");
    // …and it was not counted as delivered to anyone, nor swallowed.
    expect(AskAnswers.entriesFor(TAB)[0].returned).toBe(false);
    expect(AskAnswers.entriesFor(TAB)[0].answer).toBe("dpmpp_2m");
  });

  // Gate P0-2: the timeout report rendered every same-key entry's question AND
  // answer verbatim. `others` never went through the boundary gate, because
  // nothing about a disclosure looked like a hand-off — so tab A's chosen option
  // was printed into tab B's result.
  it("a timed-out ask never prints another conversation's chosen option", async () => {
    await askThenAnswerLate(SAMPLER, "dpmpp_2m");
    AskAnswers.closeAsks(TAB); // the conversation that asked is replaced

    const res = await defByName("panel_ask").handler(SCHEDULER as Record<string, unknown>, {
      bridge: timingOutBridge(),
      tabId: TAB,
    } as unknown as PanelToolCtx);

    expect(res.isError).toBe(true);
    // The pick is NOT rendered…
    expect(askText(res)).not.toContain("dpmpp_2m");
    // …but the fact that something was answered IS disclosed.
    expect(askText(res)).toMatch(/belong to a DIFFERENT conversation/i);
    expect(AskAnswers.entriesFor(TAB).some((e) => e.answer === "dpmpp_2m")).toBe(true);
  });

  // Gate P0-3: the debt footnote is added by a helper, and the helper reported
  // the CURRENT occupant's debt and attached its token to the CURRENT turn — so a
  // result belonging to a conversation replaced mid-ask could carry, and have
  // settled, a warning that conversation never saw.
  it("a result from a replaced conversation carries no debt footnote", async () => {
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
        void cmd;
        // The boundary lands while this ask is still in flight (its own debt is
        // surfaced and retired there)…
        AskAnswers.closeAsks(TAB);
        // …and the REPLACEMENT conversation then loses answers of its own. That
        // debt is owed to it, not to the ask that is about to unwind here.
        AskAnswers.noteDroppedForTest(TAB, 2);
        throw REPLY_TIMEOUT_ERR("ask_user", opts?.timeoutMs ?? 0);
      },
      canReach: () => true,
      isHeadless: () => false,
      resolveActiveTabId: () => TAB,
      takeLateAskReply: () => undefined,
      push: () => 1,
    } as unknown as PanelToolCtx["bridge"];

    const res = await defByName("panel_ask").handler(SAMPLER as Record<string, unknown>, {
      bridge,
      tabId: TAB,
    } as unknown as PanelToolCtx);

    expect(res.isError).toBe(true);
    // No "N further validated answer(s) were dropped" on a result that belongs to
    // a conversation that no longer exists — the live turn's ack would otherwise
    // settle a warning nobody was shown.
    expect(askText(res)).not.toMatch(/were dropped before they/i);
    // …and the replacement conversation is still owed it, undisturbed.
    expect(AskAnswers.droppedFor(TAB)).toBe(2);
    expect(AskAnswers.reportDropped(TAB)).toBe(2);
  });

  it("holds the WHOLE handler under one wall-clock ceiling anchored at entry", () => {
    // The card deadline and the grace poll used to be additive on top of
    // everything else, so a bounded ask could still overrun the enclosing
    // tools/call budget and die as a raw transport timeout instead of a result.
    const t = __panelAskTestHooks.getAskTiming();
    expect(t.deadlineMs + t.graceMs).toBeLessThanOrEqual(
      __panelAskTestHooks.ASK_TOTAL_BUDGET_CAP_MS,
    );
    expect(__panelAskTestHooks.ASK_TOTAL_BUDGET_CAP_MS).toBeLessThan(300000);
  });
});

// ---------------------------------------------------------------------------
// #770 / #803 / #716 — panel_set_workflow_target({mode:"current"}) as a recovery
// that actually recovers.
//
// The reported wedge: after a reconnect, a soft reload, or a same-tab workflow
// replacement, the active canvas gets a NEW workflow-instance uuid while the
// session keeps the OLD one as its command stamp. Every stamped command is then
// (correctly) refused by the panel's fence with `workflow instance mismatch`.
// The error text names mode:"current" as the remedy — but that call only ever
// re-pointed ROUTING, and routing is a no-op while the bound tab is still
// reachable, so it returned "Following the user's current workflow tab." and
// changed nothing. A documented recovery that could not recover.
//
// Every assertion below checks the REASON, not just the state: a refusal for the
// wrong cause and a refusal for the right cause are different results, and one
// bucket verdict covering four causes is what this cluster is about.
// ---------------------------------------------------------------------------
describe("panel-tools: mode:'current' re-derives the workflow command fence (#770/#803)", () => {
  const STALE = "11111111-1111-4111-8111-111111111111";
  const LIVE = "22222222-2222-4222-8222-222222222222";

  /** A bridge modelling the ONE thing that matters here: the tab is REACHABLE,
   *  the session holds `fence`, and the panel's live active record reports
   *  `active`. `workflow_list` answers from `active`; everything else acks.
   *  `tabCanMutateGraph` defaults to TRUE — a current panel — so the common tests
   *  exercise the realistic path rather than the can't-tell one. The false and
   *  unanswerable cases get their own tests. */
  function fenceBridge(opts: {
    fence?: string;
    active?: Record<string, unknown> | null;
    /** Override the `workflows` list. By DEFAULT the stub mirrors `active` into a
     *  single `active:true` entry — the shape a healthy panel returns, and the
     *  CORROBORATION a fence adoption requires. Pass this explicitly to model a
     *  stale/mixed/absent list. Supplying only a top-level `active` object is NOT
     *  a safe fixture: it is the exact reply shape that let another canvas's uuid
     *  overwrite this tab's stamp, so the default must not encode it. */
    workflows?: Array<Record<string, unknown>>;
    /** Send NO `workflows` field at all — an older build, as distinct from a
     *  build that sends an empty one (#1292). */
    omitWorkflows?: boolean;
    activeConfirmed?: boolean;
    listThrows?: string;
    refreshReturns?: boolean;
    tabId?: string;
  }) {
    const tab = opts.tabId ?? "wf:workflows/a.json";
    let stamp = opts.fence;
    const sent: Array<Record<string, unknown>> = [];
    const refresh = vi.fn((_tabId: string, uuid: string) => {
      if (opts.refreshReturns === false) return false;
      stamp = uuid;
      return true;
    });
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        sent.push(cmd);
        if (cmd.cmd === "workflow_list") {
          if (opts.listThrows) throw new Error(opts.listThrows);
          if (opts.active == null) return { workflows: opts.workflows ?? [] };
          // Mirror `active` into a corroborating `active:true` entry unless the
          // test is deliberately modelling a stale/mixed/absent list.
          const workflows = opts.workflows ?? [{ ...opts.active, active: true }];
          if (opts.omitWorkflows) {
            return {
              active: opts.active,
              ...(opts.activeConfirmed === undefined
                ? {}
                : { active_confirmed: opts.activeConfirmed }),
            };
          }
          return {
            active: opts.active,
            workflows,
            ...(opts.activeConfirmed === undefined ? {} : { active_confirmed: opts.activeConfirmed }),
          };
        }
        return { ok: true };
      },
      push: () => 1,
      canReach: (id: string) => id === tab,
      isHeadless: () => false,
      tabs: () => [{ tab_id: tab, title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => tab,
      refreshWorkflowUuid: refresh,
      // The REAL bridge contract: tri-state. `{known:true}` with no uuid means
      // "definitively unfenced" — a claim the stub is entitled to make because it
      // is standing in for the map that holds the stamp.
      workflowUuidFor: () => ({ known: true, uuid: stamp }),
      tabCanMutateGraph: () => true,
      tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    } as unknown as PanelToolCtx["bridge"];
    return { bridge, sent, refresh, tab, currentStamp: () => stamp };
  }

  async function setCurrent(bridge: PanelToolCtx["bridge"], tab: string) {
    const ctx = makePanelToolCtx(bridge, tab, new WorkflowTargetStore());
    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    return { res, ctx, text: (res.content[0] as { text: string }).text };
  }

  it("REBINDS a stale fence onto the live canvas — the wedge these reports describe", async () => {
    // The tab never went away (canReach true), so the pre-existing routing rebind
    // is a no-op; only the FENCE is wrong. This is the reported dominant case.
    const { bridge, refresh, tab, currentStamp } = fenceBridge({
      fence: STALE,
      active: { path: "workflows/a.json", routing_key: "wf:workflows/a.json", workflow_uuid: LIVE },
    });
    const { res, ctx, text } = await setCurrent(bridge, tab);

    expect(res.isError).toBeFalsy();
    expect(ctx.tabId).toBe(tab); // routing untouched — it was never the problem
    expect(refresh).toHaveBeenCalledExactlyOnceWith(tab, LIVE);
    expect(currentStamp()).toBe(LIVE); // the fence a later graph command will carry
    expect(JSON.parse(text)).toMatchObject({
      graph_binding: "bound",
      graph_binding_status: "refreshed",
    });
    // The REASON, rendered: both uuids named, so a reader can verify the swap.
    expect(text).toContain(LIVE);
    expect(text).toContain(STALE);
    expect(text).toMatch(/Rebound the graph command fence onto the live canvas/);
  });

  it("rebinds for an UNSAVED (tmp:) canvas, which the saved-path #716 refresh can never reach", async () => {
    // No `path`/`routing_key` to corroborate — canonicalRequestedSavedIdentity()
    // returns null for every unsaved token, which is why open/pin cannot refresh
    // here. mode:"current" has no caller-supplied target to corroborate: the live
    // active canvas IS the target.
    const { bridge, refresh, tab, currentStamp } = fenceBridge({
      fence: STALE,
      // A real unsaved workflow has no saved path, but it DOES have a stable
      // routing key — which is what corroborates it against the open list.
      active: {
        key: "tmp:abc123",
        routing_key: "tmp:abc123",
        workflow_uuid: LIVE,
        filename: "Unsaved Workflow",
      },
      tabId: "tmp:abc123",
    });
    const { res, text } = await setCurrent(bridge, tab);

    expect(res.isError).toBeFalsy();
    expect(refresh).toHaveBeenCalledExactlyOnceWith("tmp:abc123", LIVE);
    expect(currentStamp()).toBe(LIVE);
    expect(JSON.parse(text).graph_binding_status).toBe("refreshed");
  });

  // ---- The corroboration the fence adoption requires -----------------------
  //
  // A stale or MIXED workflow_list can carry a top-level `active` naming ANOTHER
  // canvas, whose uuid is perfectly valid in shape and origin. Adopting it
  // overwrites this tab's stamp, wedges the next graph command, and — because the
  // adoption "succeeded" — gets reported as `bound`. A fresh wedge announced as a
  // recovery is strictly worse than the wedge this whole PR exists to fix.
  //
  // `resolveOpenWorkflow` had already arrived at this rule for pins: an
  // uncorroborated top-level `active` "is never a safe source for replacing a
  // command fence". These cases hold the rebind to it.

  it("ADOPTS when the identities differ only in path SYNTAX — a contradiction check must not refuse a real match", async () => {
    // The contradiction check compares through the same canonicalizer the rest of
    // this file uses. Comparing raw strings would call "./workflows/a.json" and
    // "workflows/a.json" a contradiction and refuse a legitimate recovery — this
    // defect class pointed the other way, which is precisely what the check was
    // added to avoid committing (codex gate).
    const { bridge, refresh, tab } = fenceBridge({
      fence: STALE,
      active: {
        path: "./workflows/a.json",
        routing_key: "wf:workflows/a.json",
        workflow_uuid: LIVE,
      },
      workflows: [
        { path: "workflows/a.json", routing_key: "wf:workflows/a.json", active: true },
      ],
    });
    const { res } = await setCurrent(bridge, tab);

    expect(refresh).toHaveBeenCalledExactlyOnceWith(tab, LIVE);
    expect(res.isError).toBeFalsy();
  });

  it("REFUSES a PARTIAL contradiction — one matching field never outvotes a conflicting one", async () => {
    const OTHER = "33333333-3333-4333-8333-333333333333";
    const { bridge, refresh, tab, currentStamp } = fenceBridge({
      fence: STALE,
      // The pathological middle case the total-disagreement test above cannot
      // reach: `routing_key` AGREES while `path` flatly contradicts. The verdict
      // returned on the FIRST equal pair without ever reading the rest, so a
      // reply that disagreed with itself was adopted as a positive identity
      // (codex gate P0). A contradicted positive is worse than an unverified one.
      active: {
        path: "workflows/b.json",
        routing_key: "wf:workflows/a.json",
        workflow_uuid: OTHER,
      },
      workflows: [
        { path: "workflows/a.json", routing_key: "wf:workflows/a.json", active: true },
      ],
    });
    const { res, text } = await setCurrent(bridge, tab);

    expect(refresh).not.toHaveBeenCalled();
    expect(currentStamp()).toBe(STALE);
    expect(res.isError).toBe(true);
    expect(text).not.toMatch(/"graph_binding": "bound"/);
  });

  it("REFUSES to adopt when the active record CONTRADICTS the open-workflow list (stale/mixed reply)", async () => {
    const OTHER = "33333333-3333-4333-8333-333333333333";
    const { bridge, refresh, tab, currentStamp } = fenceBridge({
      fence: STALE,
      // Top-level active names canvas B, carrying a VALID uuid…
      active: { path: "workflows/b.json", routing_key: "wf:workflows/b.json", workflow_uuid: OTHER },
      // …while the panel's own list says canvas A is the active one.
      workflows: [{ path: "workflows/a.json", routing_key: "wf:workflows/a.json", active: true }],
    });
    const { res, text } = await setCurrent(bridge, tab);

    // Nothing adopted — the other canvas's uuid never reaches the fence.
    expect(refresh).not.toHaveBeenCalled();
    expect(currentStamp()).toBe(STALE);
    // …and it is NOT reported as a recovery.
    expect(res.isError).toBe(true);
    expect(text).not.toMatch(/"graph_binding": "bound"/);
    expect(text).toMatch(/could not be corroborated, so nothing was adopted/);
    expect(text).toMatch(/name DIFFERENT workflows \(a stale or mixed reply\)/);
    // The reason it matters, stated: this is what protects the tab.
    expect(text).toMatch(/could have stamped ANOTHER canvas's identity onto this tab/);
    // The remedy fits the cause — not "update your panel", which is the sibling
    // failure's fix and unactionable here.
    expect(text).not.toMatch(/must be UPDATED/);
    // #1292 — and it no longer prescribes the retry the tool JUST PERFORMED. This
    // stub never settles, so all four reads refused; saying "call this again in a
    // moment" after that sends the caller to do the least likely thing left.
    expect(text).toMatch(/ALREADY TRIED: the panel was re-read \d+ times/);
    expect(text).not.toMatch(/call this again in a moment/);
  });

  it("REFUSES to adopt from a reply with no open-workflow list to corroborate against", async () => {
    const { bridge, refresh, tab, currentStamp } = fenceBridge({
      fence: STALE,
      active: { path: "workflows/a.json", routing_key: "wf:workflows/a.json", workflow_uuid: LIVE },
      workflows: [], // the exact shape the first version of this fix accepted
    });
    const { res, text } = await setCurrent(bridge, tab);

    expect(refresh).not.toHaveBeenCalled();
    expect(currentStamp()).toBe(STALE);
    expect(res.isError).toBe(true);
    // #1292 split what this message used to fold. An EMPTY list is a snapshot of
    // what is open right now — a mid-restore panel reports it before its tabs
    // come back, so it is worth re-reading. An ABSENT `workflows` field is a
    // property of the installed build and will never change; that one keeps the
    // original wording and is NOT re-read. Both still refuse.
    expect(text).toMatch(/open-workflow list was empty, so nothing corroborates the active record/);
  });

  it("REFUSES — and does not re-read — a reply that carries NO open-workflow field at all", async () => {
    // The other half of the split above: rechecking a build that cannot answer
    // differently would only make the identical error ~2.9s slower (#1292).
    const { bridge, refresh, tab, currentStamp, sent } = fenceBridge({
      fence: STALE,
      active: { path: "workflows/a.json", routing_key: "wf:workflows/a.json", workflow_uuid: LIVE },
      workflows: undefined as unknown as Array<Record<string, unknown>>,
      omitWorkflows: true,
    });
    const { res, text } = await setCurrent(bridge, tab);

    expect(refresh).not.toHaveBeenCalled();
    expect(currentStamp()).toBe(STALE);
    expect(res.isError).toBe(true);
    expect(text).toMatch(/no open-workflow list to corroborate the active record against/);
    expect(sent.filter((c) => c.cmd === "workflow_list")).toHaveLength(1);
    expect(text).toMatch(/WHY RETRYING WILL NOT HELP/);
  });

  it("REFUSES a MIXED list with two entries marked active, rather than arbitrating", async () => {
    const { bridge, refresh, tab } = fenceBridge({
      fence: STALE,
      active: { path: "workflows/a.json", routing_key: "wf:workflows/a.json", workflow_uuid: LIVE },
      workflows: [
        { path: "workflows/a.json", routing_key: "wf:workflows/a.json", active: true },
        { path: "workflows/b.json", routing_key: "wf:workflows/b.json", active: true },
      ],
    });
    const { res, text } = await setCurrent(bridge, tab);

    expect(refresh).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(text).toMatch(/2 entries in the open-workflow list are marked active \(a mixed reply\)/);
  });

  it("REFUSES when the panel itself says its active record is UNCONFIRMED", async () => {
    const { bridge, refresh, tab } = fenceBridge({
      fence: STALE,
      active: { path: "workflows/a.json", routing_key: "wf:workflows/a.json", workflow_uuid: LIVE },
      activeConfirmed: false,
    });
    const { res, text } = await setCurrent(bridge, tab);

    expect(refresh).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(text).toMatch(/reported its active workflow as UNCONFIRMED/);
  });

  it("an UNCORROBORATED reply with NO prior fence is `unverified`, not a wedge and not a repair", async () => {
    // Nothing was stale, so nothing failed to be repaired — but nothing was
    // established either. Calling it `reads_only` would describe a permanent
    // limitation this is not (the panel DOES report identities); calling it
    // `not_recovered` would report a wedge that does not exist.
    const { bridge, refresh, tab } = fenceBridge({
      fence: undefined,
      active: { path: "workflows/a.json", routing_key: "wf:workflows/a.json", workflow_uuid: LIVE },
      workflows: [], // uncorroborated
    });
    const { res, text } = await setCurrent(bridge, tab);

    expect(res.isError).toBeFalsy();
    expect(refresh).not.toHaveBeenCalled();
    expect(JSON.parse(text)).toMatchObject({
      graph_binding: "unverified",
      graph_binding_status: "no_identity",
    });
    expect(text).toMatch(/had no fence to damage, so it is no worse off/);
    expect(text).toMatch(/call this again in a moment/);
    // NOT the update-your-panel remedy: this panel reports identities fine.
    expect(text).not.toMatch(/must be UPDATED/);
  });

  it("REFUSES when the active record and the list share no comparable identity field", async () => {
    // Agreement was never established — which is not agreement. Filename is
    // deliberately not comparable: it collides across tabs.
    const { bridge, refresh, tab } = fenceBridge({
      fence: STALE,
      active: { filename: "a.json", workflow_uuid: LIVE },
      workflows: [{ filename: "a.json", active: true }],
    });
    const { res, text } = await setCurrent(bridge, tab);

    expect(refresh).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(text).toMatch(/share no comparable identity field/);
  });

  it("reports ALREADY_CURRENT (and points at the panel) rather than a hollow rebind", async () => {
    const { bridge, refresh, tab } = fenceBridge({
      fence: LIVE,
      active: { path: "workflows/a.json", routing_key: "wf:workflows/a.json", workflow_uuid: LIVE },
    });
    const { res, text } = await setCurrent(bridge, tab);

    expect(res.isError).toBeFalsy();
    // Nothing to change — so nothing is claimed to have changed.
    expect(refresh).not.toHaveBeenCalled();
    expect(JSON.parse(text).graph_binding_status).toBe("already_current");
    expect(text).toMatch(/already named the canvas the panel reported as active a moment ago/);
    // The SAME post-probe switch window `refreshed` discloses — a switch in that
    // instant leaves this stamp stale too, and the fix for that is this very call.
    expect(text).toMatch(/cleared by calling this\s+again/);
    // …so the reload is reserved for a mismatch that SURVIVES a repeat, which is
    // the only thing that actually implicates the panel.
    expect(text).toMatch(/call this once more/);
    expect(text).toMatch(/If the\s+mismatch SURVIVES that repeat/);
    expect(text.indexOf("call this once more")).toBeLessThan(text.indexOf("manually refresh"));
  });

  it("FAILS — and discloses what did apply — when the live identity is UNREADABLE and a stale fence remains", async () => {
    const { bridge, refresh, tab, currentStamp } = fenceBridge({
      fence: STALE,
      listThrows: "no connected tab",
    });
    const { res, text } = await setCurrent(bridge, tab);

    // Never "your recovery worked" when it did not.
    expect(res.isError).toBe(true);
    expect(text).toMatch(/did NOT restore this session's graph binding/);
    // DISCLOSE, don't retract: the target write already happened.
    expect(text).toMatch(/APPLIED \(do not repeat this part\)[\s\S]*mode:"current"/);
    // The REASON — an unknown, explicitly not a rebind — and the stale uuid still in force.
    expect(text).toMatch(/Could NOT read the live canvas identity/);
    expect(text).toMatch(/This is not a rebind — it is an unknown/);
    expect(text).toMatch(/NOTHING about this session's graph binding was observed/);
    expect(text).toContain(STALE);
    expect(refresh).not.toHaveBeenCalled();
    expect(currentStamp()).toBe(STALE); // the fence was left intact, not cleared

    // The remedy must be reachable AND must not contradict itself. The quoted
    // transport cause can itself say "rebind with panel_set_workflow_target
    // ({mode:'current'})" — the call that just failed — so the quote is labelled
    // and explicitly disarmed, and our own remedy is stated BEFORE it.
    expect(text).toMatch(/disregard any rebind advice inside it/);
    expect(text.indexOf("WHAT TO DO")).toBeLessThan(text.indexOf("UNDERLYING CAUSE"));
    // …and the remedy never sends the caller to panel_reload, which #803 observed
    // leaving the tab permanently unresponsive from exactly this state.
    expect(text).toMatch(/Do NOT use panel_reload/);
  });

  it("an UNREADABLE read is an unknown even with NO prior fence — it never claims reads work", async () => {
    // The read that would have told us whether this session is usable is the one
    // that failed. Reporting "graph READS work" from a failed observation is the
    // same could-not-determine/therefore-not fold, pointed at a positive.
    const { bridge, tab } = fenceBridge({ fence: undefined, listThrows: "no connected tab" });
    const { res, text } = await setCurrent(bridge, tab);

    expect(res.isError).toBe(true);
    expect(text).toMatch(/whether graph reads work is unknown/i);
    expect(text).not.toMatch(/graph READS work/);
    // …and the FIRST remedy offered is the one reachable right now.
    expect(text).toMatch(/WHAT TO DO: retry in a moment/);
  });

  it("distinguishes NO_IDENTITY from UNREADABLE — same wedge, different remedy", async () => {
    const { bridge, refresh, tab } = fenceBridge({
      fence: STALE,
      active: { path: "workflows/a.json" }, // panel answered; no workflow_uuid in it
    });
    const { res, text } = await setCurrent(bridge, tab);

    expect(res.isError).toBe(true);
    expect(text).toMatch(/reported NO workflow identity for the active canvas/);
    // NOT the unreadable wording — the panel DID answer, which is a different fact.
    expect(text).not.toMatch(/Could NOT read the live canvas identity/);
    // …and NOT the uncorroborated wording either: this reply hung together fine,
    // the panel simply has no identity to give. Different fact, different remedy.
    expect(text).not.toMatch(/could not be corroborated/);
    expect(text).toMatch(/cached bundle/);
    // …and the remedy is the one that actually replaces a cached bundle.
    expect(text).toMatch(/HARD refresh here specifically/);
    expect(text).toMatch(/must be UPDATED — no rebind can add it/);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("distinguishes a REJECTED adoption — read the identity, could not take it", async () => {
    const { bridge, refresh, tab, currentStamp } = fenceBridge({
      fence: STALE,
      active: { path: "workflows/a.json", routing_key: "wf:workflows/a.json", workflow_uuid: LIVE },
      refreshReturns: false, // the orchestrator's validator declined it
    });
    const { res, text } = await setCurrent(bridge, tab);

    expect(res.isError).toBe(true);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(tab, LIVE);
    expect(currentStamp()).toBe(STALE); // fail closed — old fence untouched
    expect(text).toMatch(/could NOT adopt it as this session's graph command fence/);
    // Distinct from both "unreadable" and "no identity": we DID read it.
    expect(text).not.toMatch(/Could NOT read the live canvas identity/);
    expect(text).not.toMatch(/reported NO workflow identity/);
    expect(text).toContain(LIVE);
  });

  it("does NOT fail a session that never had a fence (an old panel stays usable)", async () => {
    // Nothing was stale, so nothing failed to be repaired. Reporting this as a
    // failed recovery would be the same fold in the opposite direction.
    const { bridge, tab } = fenceBridge({ fence: undefined, active: { path: "workflows/a.json" } });
    const { res, text } = await setCurrent(bridge, tab);

    expect(res.isError).toBeFalsy();
    // …but it is NOT reported as a usable graph binding either: reads work,
    // mutations do not. "bound" here would overstate in the other direction.
    expect(JSON.parse(text)).toMatchObject({
      graph_binding: "reads_only",
      graph_binding_status: "no_identity",
    });
    expect(text).toMatch(/graph MUTATIONS stay refused/);
    // The remedy must be reachable: a panel build with no workflow identity will
    // NEVER acquire one by reconnecting, so "wait for a reconnect" would be an
    // aspirational instruction. Name the thing that does work.
    expect(text).toMatch(/reconnecting alone will NOT restore mutations/);
    expect(text).toMatch(/pack UPDATED/);
  });

  it("does NOT read the live canvas at all when the rebind DEFERRED (zero tabs connected)", async () => {
    // There is nothing to read from yet, and the deferred note already says so.
    // Probing anyway would turn a truthful deferral into a spurious failure.
    // Collapse the real ~20s reconnect wait — this asserts a branch, not a clock.
    __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 1, intervalMs: 1 });
    const sent: Array<Record<string, unknown>> = [];
    const refresh = vi.fn(() => true);
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        sent.push(cmd);
        throw new Error(`no connected tab with id "x". Connected: none`);
      },
      push: () => 1,
      canReach: () => false,
      isHeadless: () => false,
      tabs: () => [],
      resolveActiveTabId: () => {
        throw new Error("Panel not reachable: no panel connected");
      },
      refreshWorkflowUuid: refresh,
      workflowUuidFor: () => STALE,
    } as unknown as PanelToolCtx["bridge"];
    const { res, text } = await setCurrent(bridge, "wf:gone");

    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text)).toMatchObject({ deferred: true });
    expect(sent.filter((c) => c.cmd === "workflow_list")).toHaveLength(0);
    expect(text).not.toMatch(/graph command fence/);
    __panelToolsTestHooks.setReconnectWaitTiming(null);
  });

  it("leaves mode:'pinned' on its own #716 path — no extra live-canvas adoption", async () => {
    // The pinned path adopts only a uuid corroborated against the CALLER's exact
    // saved path. It must not inherit the target-free adoption above.
    const store = new WorkflowTargetStore();
    const refresh = vi.fn(() => true);
    const bridge = {
      send: async (cmd: Record<string, unknown>) =>
        cmd.cmd === "workflow_list"
          ? {
              active: {
                path: "workflows/other.json",
                routing_key: "wf:workflows/other.json",
                workflow_uuid: LIVE,
              },
              workflows: [
                {
                  path: "workflows/other.json",
                  key: "k",
                  routing_key: "wf:workflows/other.json",
                  active: true,
                },
              ],
            }
          : { ok: true },
      push: () => 1,
      canReach: () => true,
      isHeadless: () => false,
      tabs: () => [{ tab_id: "t", title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => "t",
      refreshWorkflowUuid: refresh,
      workflowUuidFor: () => STALE,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "t", store);
    const res = await defByName("panel_set_workflow_target").handler(
      { mode: "pinned", path: "workflows/notthisone.json" },
      ctx,
    );
    // Not open under that caller path → the #259 fail-closed refusal still wins,
    // and no fence adoption happened on the way.
    expect(res.isError).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does NOT report `bound` when the panel cannot fence a WRITE — a stamp is not a capability", async () => {
    // tabCanMutateGraph requires the panel to advertise BOTH write-boundary fences
    // ON TOP of a valid stamp. An older bundle can report a perfectly good workflow
    // uuid and still have every mutation refused at dispatch, so reporting "graph
    // tools will now target the workflow in view" off the stamp alone answers a
    // question nobody asked.
    const { bridge, refresh, tab } = fenceBridge({
      fence: STALE,
      active: { path: "workflows/a.json", routing_key: "wf:workflows/a.json", workflow_uuid: LIVE },
    });
    const ctx = makePanelToolCtx(bridge, tab, new WorkflowTargetStore());
    // Observed absent, and the WHY is an old panel build — which is what makes
    // the pack-update remedy below the right one. The sibling test covers the
    // other why.
    ctx.tabGraphMutationCapability = () => ({
      known: true,
      canMutate: false,
      because: "capability" as const,
    });
    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    const text = (res.content[0] as { text: string }).text;

    // The fence WAS repaired — that part really happened and is reported.
    expect(res.isError).toBeFalsy();
    expect(refresh).toHaveBeenCalledExactlyOnceWith(tab, LIVE);
    expect(JSON.parse(text).graph_binding_status).toBe("refreshed");
    // …but the session is read-only, and the remedy is the one that exists.
    expect(JSON.parse(text).graph_binding).toBe("reads_only");
    expect(text).toMatch(/graph MUTATIONS are still refused for this tab/);
    expect(text).toMatch(/update the comfyui-mcp-panel pack/);
    // The remedy must not tell the caller to re-run a tool that cannot help.
    expect(text).toMatch(/including calling this tool again — can add it/);
  });

  it("does NOT blame the panel version when the tab is simply UNREACHABLE", async () => {
    // Both whys yield canMutate:false, and they used to share one value — so this
    // path told the user to update their panel pack and hard-refresh a tab that
    // was gone, while their READS were failing too and the note said reads work
    // (codex gate P1). A bucket narrated as a cause, with a remedy for a problem
    // they did not have.
    const { bridge, tab } = fenceBridge({
      fence: STALE,
      active: { path: "workflows/a.json", routing_key: "wf:workflows/a.json", workflow_uuid: LIVE },
    });
    const ctx = makePanelToolCtx(bridge, tab, new WorkflowTargetStore());
    ctx.tabGraphMutationCapability = () => ({
      known: true,
      canMutate: false,
      because: "unroutable" as const,
    });
    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    const text = (res.content[0] as { text: string }).text;

    expect(text).toMatch(/NOT REACHABLE/);
    // The wrong remedy must be absent, not merely accompanied by the right one.
    expect(text).not.toMatch(/update the comfyui-mcp-panel pack/);
    expect(text).toMatch(/NOT a panel-version problem/);
    // And it must not leave "reads work" standing, which is false for a tab that
    // cannot be routed to at all.
    expect(text).toMatch(/reads are not working either/);
  });

  it("does NOT blame the panel version when the socket is merely CLOSING", async () => {
    // Transport, not version. Folding this into "capability" told the user to
    // update a pack that was already correct (codex gate).
    const { bridge, tab } = fenceBridge({
      fence: STALE,
      active: { path: "workflows/a.json", routing_key: "wf:workflows/a.json", workflow_uuid: LIVE },
    });
    const ctx = makePanelToolCtx(bridge, tab, new WorkflowTargetStore());
    ctx.tabGraphMutationCapability = () => ({
      known: true,
      canMutate: false,
      because: "disconnected" as const,
    });
    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    const text = (res.content[0] as { text: string }).text;

    expect(text).toMatch(/socket is CLOSING/);
    expect(text).not.toMatch(/update the comfyui-mcp-panel pack/);
    expect(text).toMatch(/wait for the panel to reconnect/);
  });

  it("does NOT blame the panel version when only the workflow IDENTITY is missing", async () => {
    // A modern panel advertising both fences, with no trusted stamp. Reads work
    // and a rebind is the fix — so "no rebind can add it" and "update the pack"
    // are both false here (codex gate).
    const { bridge, tab } = fenceBridge({
      fence: STALE,
      active: { path: "workflows/a.json", routing_key: "wf:workflows/a.json", workflow_uuid: LIVE },
    });
    const ctx = makePanelToolCtx(bridge, tab, new WorkflowTargetStore());
    ctx.tabGraphMutationCapability = () => ({
      known: true,
      canMutate: false,
      because: "no_identity" as const,
    });
    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    const text = (res.content[0] as { text: string }).text;

    expect(text).toMatch(/no trusted workflow identity/);
    expect(text).toMatch(/panel build is FINE/);
    expect(text).not.toMatch(/update the comfyui-mcp-panel pack/);
    // The old wording actively told the caller a retry could not help. It can.
    expect(text).not.toMatch(/including calling this tool again — can add it/);
    expect(text).toMatch(/call this tool again to bind an identity/);
  });

  it("reports `unverified` — not `bound` — when the write capability cannot be determined", async () => {
    // An unanswerable capability probe is an UNKNOWN. Rounding it up to `bound`
    // (which the tool description defines as "graph tools are usable again") is
    // the same could-not-determine/therefore-yes fold, one step further out.
    const { bridge, tab } = fenceBridge({
      fence: STALE,
      active: { path: "workflows/a.json", routing_key: "wf:workflows/a.json", workflow_uuid: LIVE },
    });
    const ctx = makePanelToolCtx(bridge, tab, new WorkflowTargetStore());
    // The PRODUCTION shape of "cannot tell": the bridge probe answers known:false.
    ctx.tabGraphMutationCapability = () => ({ known: false, reason: "could not inspect the tab" });
    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    const text = (res.content[0] as { text: string }).text;

    expect(res.isError).toBeFalsy(); // the fence WAS repaired — that is not a failure
    expect(JSON.parse(text).graph_binding).toBe("unverified");
    expect(text).toMatch(/could not be determined from this context/);
    expect(text).toMatch(/treat mutation readiness as unconfirmed/);
  });

  it("a THROWING adoption is not narrated as a refusal — whether the fence changed is UNKNOWN", async () => {
    // A refusal (`false`) proves the old fence survived. A THROW can land on
    // either side of the write, so "the previous fence is unchanged" would be a
    // state nobody observed. It also must not escape the handler: the target
    // write and push already happened, and their disclosure would be lost.
    const tab = "wf:workflows/a.json";
    const bridge = {
      send: async (cmd: Record<string, unknown>) =>
        cmd.cmd === "workflow_list"
          ? {
              active: { path: "workflows/a.json", routing_key: "wf:workflows/a.json", workflow_uuid: LIVE },
              workflows: [{ path: "workflows/a.json", routing_key: "wf:workflows/a.json", active: true }],
            }
          : { ok: true },
      push: () => 1,
      canReach: (id: string) => id === tab,
      isHeadless: () => false,
      tabs: () => [{ tab_id: tab, title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => tab,
      refreshWorkflowUuid: () => {
        throw new Error("validator exploded");
      },
      workflowUuidFor: () => ({ known: true, uuid: STALE }),
      tabCanMutateGraph: () => true,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, tab, new WorkflowTargetStore());

    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    const text = (res.content[0] as { text: string }).text;

    expect(res.isError).toBe(true);
    // The disclosure that survived the throw.
    expect(text).toMatch(/APPLIED \(do not repeat this part\)/);
    expect(text).toMatch(/adopting it as this session's graph command fence THREW/);
    expect(text).toMatch(/whether the\s+fence changed is UNKNOWN/);
    expect(text).toMatch(/validator exploded/);
    // Explicitly NOT the refusal wording, which would claim the old fence survived.
    expect(text).not.toMatch(/The adoption was REFUSED/);
    // …and the remedy is safe to follow.
    expect(text).toMatch(/call this again — a second attempt is safe and settles it/);
  });

  it("RE-READS the fence when the probe moved the session, instead of comparing against the old tab", async () => {
    // ctx.call's retry can rebind ctx.tabId. Comparing the NEW tab's live canvas
    // against the OLD tab's fence can yield a bogus `already_current` — skipping a
    // refresh the new tab genuinely needed and reporting a binding that is still
    // wedged. Here the OLD tab's fence happens to equal the new canvas's uuid,
    // while the NEW tab is stale: the naive comparison says "nothing to do".
    const OLD = "wf:workflows/old.json";
    const NEW = "wf:workflows/new.json";
    const stamps = new Map<string, string>([
      [OLD, LIVE], // old tab already names the live canvas…
      [NEW, STALE], // …but the tab we end up on does NOT
    ]);
    let live = OLD;
    let dropped = false;
    const refresh = vi.fn((tabId: string, uuid: string) => {
      stamps.set(tabId, uuid);
      return true;
    });
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
        if (cmd.cmd === "workflow_list" && !dropped) {
          dropped = true;
          live = NEW;
          throw new Error(`no connected tab with id "${opts?.tabId}". Connected: none`);
        }
        if (cmd.cmd === "workflow_list") {
          return {
            active: { path: "workflows/new.json", routing_key: "wf:workflows/new.json", workflow_uuid: LIVE },
            workflows: [{ path: "workflows/new.json", routing_key: "wf:workflows/new.json", active: true }],
          };
        }
        return { ok: true };
      },
      push: () => 1,
      canReach: (id: string) => id === live,
      isHeadless: () => false,
      tabs: () => [{ tab_id: live, title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => live,
      refreshWorkflowUuid: refresh,
      workflowUuidFor: (id: string) => ({ known: true, uuid: stamps.get(id) }),
      tabCanMutateGraph: () => true,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, OLD, new WorkflowTargetStore());

    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    const text = (res.content[0] as { text: string }).text;

    expect(ctx.tabId).toBe(NEW);
    // The NEW tab's stale stamp was actually replaced — not skipped as "already current".
    expect(refresh).toHaveBeenCalledWith(NEW, LIVE);
    expect(stamps.get(NEW)).toBe(LIVE);
    expect(JSON.parse(text).graph_binding_status).toBe("refreshed");
    expect(JSON.parse(text).graph_binding_status).not.toBe("already_current");
  });

  it("does not narrate an UNREADABLE prior fence as an ABSENT one", async () => {
    // `workflowUuidFor` swallows a throwing resolver, so "could not read the
    // fence" and "there is no fence" arrive as the same value unless the read is
    // tri-state. Rendering the first as the second asserts an absence nobody saw.
    const tab = "wf:workflows/a.json";
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        if (cmd.cmd === "workflow_list") throw new Error("no connected tab");
        return { ok: true };
      },
      push: () => 1,
      canReach: (id: string) => id === tab,
      isHeadless: () => false,
      tabs: () => [{ tab_id: tab, title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => tab,
      refreshWorkflowUuid: () => true,
      workflowUuidFor: () => {
        throw new Error("resolver exploded");
      },
      tabCanMutateGraph: () => true,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, tab, new WorkflowTargetStore());
    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    const text = (res.content[0] as { text: string }).text;

    expect(res.isError).toBe(true);
    expect(text).toMatch(/could not be read either, so its binding is\s+entirely unknown/);
    expect(text).toMatch(/not known-good and not known-absent/);
    // NOT the absent-fence wording.
    expect(text).not.toMatch(/It has no graph command fence/);
  });

  it("reports `unverified` when the panel has no identity AND the prior fence is unreadable", async () => {
    // Failing would report a wedge nobody observed; succeeding would report a
    // repair nobody observed. Neither is available, so it says so.
    const tab = "wf:workflows/a.json";
    const bridge = {
      send: async (cmd: Record<string, unknown>) =>
        cmd.cmd === "workflow_list" ? { active: { path: "workflows/a.json" } } : { ok: true },
      push: () => 1,
      canReach: (id: string) => id === tab,
      isHeadless: () => false,
      tabs: () => [{ tab_id: tab, title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => tab,
      refreshWorkflowUuid: () => true,
      tabCanMutateGraph: () => true,
      // no workflowUuidFor at all — this bridge cannot answer
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, tab, new WorkflowTargetStore());
    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    const text = (res.content[0] as { text: string }).text;

    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text).graph_binding).toBe("unverified");
    expect(text).toMatch(/could NOT be determined/);
    expect(text).toMatch(/Treat graph tools as unconfirmed/);
  });

  it("reports `bound` when the panel DOES advertise the write fence", async () => {
    const { bridge, tab } = fenceBridge({
      fence: STALE,
      active: { path: "workflows/a.json", routing_key: "wf:workflows/a.json", workflow_uuid: LIVE },
    });
    const ctx = makePanelToolCtx(bridge, tab, new WorkflowTargetStore());
    ctx.tabGraphMutationCapability = () => ({ known: true, canMutate: true });
    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    const text = (res.content[0] as { text: string }).text;

    expect(JSON.parse(text).graph_binding).toBe("bound");
    expect(text).not.toMatch(/graph MUTATIONS are still refused/);
  });

  it("REFUSES to claim mode:'current' when the probe moved this session onto a PINNED tab", async () => {
    // workflow_list is retry-safe: a transient drop makes ctx.call rebind onto
    // another tab and retry there. The fence then belongs to the NEW tab while the
    // mode:"current" record belongs to the OLD one — and if the new tab carries
    // someone else's pin, the next graph command routes through that pin. Claiming
    // "following the user's current workflow tab" would name a state that is not
    // the case, and overwriting the pin would clobber another session's binding.
    const store = new WorkflowTargetStore();
    const OLD = "wf:workflows/old.json";
    const NEW = "wf:workflows/new.json";
    store.set(NEW, { mode: "pinned", path: "workflows/other.json", filename: "other.json" });
    let live = OLD;
    let dropped = false;
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
        if (cmd.cmd === "workflow_list" && !dropped) {
          dropped = true;
          live = NEW; // the old tab is gone; a different one is live now
          throw new Error(`no connected tab with id "${opts?.tabId}". Connected: none`);
        }
        if (cmd.cmd === "workflow_list") {
          return {
            active: { path: "workflows/new.json", routing_key: "wf:workflows/new.json", workflow_uuid: LIVE },
            workflows: [{ path: "workflows/new.json", routing_key: "wf:workflows/new.json", active: true }],
          };
        }
        return { ok: true };
      },
      push: () => 1,
      canReach: (id: string) => id === live,
      isHeadless: () => false,
      tabs: () => [{ tab_id: live, title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => live,
      refreshWorkflowUuid: () => true,
      workflowUuidFor: () => STALE,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, OLD, store);

    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    const text = (res.content[0] as { text: string }).text;

    expect(res.isError).toBe(true);
    expect(ctx.tabId).toBe(NEW);
    // The other session's pin is LEFT ALONE.
    expect(store.get(NEW)).toMatchObject({ mode: "pinned", path: "workflows/other.json" });
    expect(text).toMatch(/did NOT take effect on the tab this session is now bound to/);
    expect(text).toMatch(/rebound from tab wf:workflows\/old\.json onto tab wf:workflows\/new\.json/);
    expect(text).toMatch(/that pin was left untouched/);
    // The remedy must not be SELF-DEFEATING: re-issuing mode:"current" on this tab
    // would delete the very pin we just declined to clobber. Say that plainly
    // instead of prescribing it, and name what to do when ownership is unclear.
    expect(text).toMatch(/WILL REPLACE that pin — do that only if the pin is yours/);
    expect(text).toMatch(/ask the user which workflow they want this session on/);
    // …and disclose that the fence WAS refreshed, since that did happen.
    expect(text).toMatch(/graph command fence WAS refreshed onto this tab's live canvas/);
  });

  it("does NOT claim the fence was refreshed on the moved-to pinned tab when it was not", async () => {
    // The moved-to-pinned disclosure used to say "the fence WAS refreshed"
    // unconditionally — false whenever the probe came back unreadable, identity-
    // less, refused, or already matching. Here the panel answers with NO workflow
    // identity, so nothing was adopted, and the text must say so.
    const store = new WorkflowTargetStore();
    const OLD = "wf:workflows/old.json";
    const NEW = "wf:workflows/new.json";
    store.set(NEW, { mode: "pinned", path: "workflows/other.json", filename: "other.json" });
    let live = OLD;
    let dropped = false;
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
        if (cmd.cmd === "workflow_list" && !dropped) {
          dropped = true;
          live = NEW;
          throw new Error(`no connected tab with id "${opts?.tabId}". Connected: none`);
        }
        // Answers, but exposes no workflow identity → nothing to adopt.
        if (cmd.cmd === "workflow_list") return { active: { path: "workflows/new.json" } };
        return { ok: true };
      },
      push: () => 1,
      canReach: (id: string) => id === live,
      isHeadless: () => false,
      tabs: () => [{ tab_id: live, title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => live,
      refreshWorkflowUuid: () => true,
      workflowUuidFor: () => ({ known: true, uuid: STALE }),
      tabCanMutateGraph: () => true,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, OLD, store);

    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    const text = (res.content[0] as { text: string }).text;

    expect(res.isError).toBe(true);
    expect(text).not.toMatch(/fence WAS refreshed/);
    expect(text).toMatch(/fence was NOT established on this tab \(no_identity\)/);
    expect(text).toMatch(/may also fail here with a workflow-instance mismatch/);
  });

  it("re-applies mode:'current' onto the moved-to tab when that takes nothing away", async () => {
    const store = new WorkflowTargetStore();
    const OLD = "wf:workflows/old.json";
    const NEW = "wf:workflows/new.json";
    let live = OLD;
    let dropped = false;
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
        if (cmd.cmd === "workflow_list" && !dropped) {
          dropped = true;
          live = NEW;
          throw new Error(`no connected tab with id "${opts?.tabId}". Connected: none`);
        }
        if (cmd.cmd === "workflow_list") {
          return {
            active: { path: "workflows/new.json", routing_key: "wf:workflows/new.json", workflow_uuid: LIVE },
            workflows: [{ path: "workflows/new.json", routing_key: "wf:workflows/new.json", active: true }],
          };
        }
        return { ok: true };
      },
      push: () => 1,
      canReach: (id: string) => id === live,
      isHeadless: () => false,
      tabs: () => [{ tab_id: live, title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => live,
      refreshWorkflowUuid: () => true,
      workflowUuidFor: () => STALE,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, OLD, store);

    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    const text = (res.content[0] as { text: string }).text;

    expect(res.isError).toBeFalsy();
    // The record now governs the tab the session is actually on…
    expect(store.get(NEW)).toMatchObject({ mode: "current" });
    // …and the move is DISCLOSED, not silently absorbed.
    expect(text).toMatch(/moved from tab wf:workflows\/old\.json onto tab wf:workflows\/new\.json/);
  });

  it("COMMITS the target store BEFORE the live-canvas round trip, so a concurrent pin isn't clobbered", async () => {
    // The store is shared by every session bound to this tab. An await placed
    // between the decision and the write widens the window in which THIS call's
    // staler `current` overwrites a concurrent agent's later, successful pin —
    // and that agent was told its edits were pinned. It also makes the failure
    // text's "APPLIED (do not repeat this part)" literally true.
    const store = new WorkflowTargetStore();
    const order: string[] = [];
    const tab = "wf:workflows/a.json";
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        if (cmd.cmd === "workflow_list") {
          order.push("workflow_list");
          // The target must ALREADY be committed by the time we are asked to read.
          expect(store.get(tab)).toMatchObject({ mode: "current" });
          throw new Error("no connected tab");
        }
        return { ok: true };
      },
      push: () => {
        order.push("push");
        return 1;
      },
      canReach: (id: string) => id === tab,
      isHeadless: () => false,
      tabs: () => [{ tab_id: tab, title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => tab,
      refreshWorkflowUuid: () => true,
      workflowUuidFor: () => STALE,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, tab, store);

    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    // The fence read failed, so the call reports failure…
    expect(res.isError).toBe(true);
    // …but the target write it already performed is NOT retracted, and it landed
    // before the round trip (the push precedes the read).
    expect(store.get(tab)).toMatchObject({ mode: "current" });
    // The push (which follows the store write) precedes EVERY workflow_list probe —
    // ctx.call retries a retry-safe read once, so there may be more than one.
    expect(order[0]).toBe("push");
    expect(order.filter((o) => o === "workflow_list").length).toBeGreaterThan(0);
    expect(order.indexOf("push")).toBeLessThan(order.indexOf("workflow_list"));
    expect((res.content[0] as { text: string }).text).toMatch(/APPLIED \(do not repeat this part\)/);
  });
});

// ---------------------------------------------------------------------------
// #772 — the run-to-node graph-stamp race is the ONE rejection safe to re-issue,
// because the panel CERTIFIES that nothing entered the queue. Everything else
// stays terminal: a wrong "retryable" here queues a second render.
// ---------------------------------------------------------------------------
describe("panel-tools: panel_run scoped-run stamp-race retry (#772)", () => {
  const RACE =
    "run-to-node scope for node 650 was NOT applied: the workflow graph CHANGED after the run " +
    "was queued - the deferred dispatch would render a modified workflow, not the one that was " +
    "scoped. Nothing was queued - refusing to fall through to a full-graph execution (#556).";

  /** A ctx whose graph_run replies are scripted per attempt. A reply of
   *  `{__error}` is an isError ToolResult; `{__throw}` makes ctx.call THROW. */
  function runCtx(replies: Array<Record<string, unknown>>) {
    const runs: Record<string, unknown>[] = [];
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        if (cmd.cmd !== "graph_run") return { content: [{ type: "text", text: "{}" }] };
        const reply = replies[runs.length] ?? { queued: true };
        runs.push(cmd);
        if (typeof reply.__throw === "string") throw new Error(reply.__throw);
        if (typeof reply.__error === "string") {
          return { content: [{ type: "text", text: `Error: ${reply.__error}` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(reply) }] };
      },
      confirm: async () => "yes" as const,
      bridge: { push: () => 1 } as unknown as PanelToolCtx["bridge"],
      tabId: "t",
    };
    return { ctx, runs };
  }

  const runText = (r: ToolResult) => (r.content[0] as { text: string }).text;

  it("re-issues the scoped run EXACTLY ONCE and discloses the extra dispatch", async () => {
    const { ctx, runs } = runCtx([{ error: RACE }, { queued: true, prompt_id: "p1" }]);
    const res = await defByName("panel_run").handler({ to_node_id: 650 }, ctx);

    expect(res.isError).toBeFalsy();
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ cmd: "graph_run", to_node_id: 650 }); // same scope
    expect(runText(res)).toMatch(/re-issued once/);
    expect(runText(res)).toMatch(/first dispatch contributed NOTHING to the queue/);
  });

  it("does NOT claim a render COUNT — batch_count means the second dispatch can queue several", async () => {
    // `batch_count` is "times to queue", and the panel reports one prompt id, not a
    // count. The certified fact is about DISPATCHES ("the first queued nothing"),
    // not renders. Naming a number would be an unobserved state.
    const { ctx, runs } = runCtx([{ error: RACE }, { queued: true, prompt_id: "p1" }]);
    const res = await defByName("panel_run").handler({ to_node_id: 650, batch_count: 3 }, ctx);

    expect(res.isError).toBeFalsy();
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ batch_count: 3 }); // the batch is preserved, not dropped
    expect(runText(res)).not.toMatch(/Exactly one render/i);
    expect(runText(res)).toMatch(/queued once, not twice/);
  });

  // #1050 — the re-issue used to fire in the SAME tick as the refusal, so it
  // landed in the very window the panel had just refused for. A reporter's
  // retry raced identically and instantly: the one re-issue was spent for
  // nothing and the run was refused twice with nothing queued.
  //
  // The pause is a SETTLE, not the mutation-quiescence barrier the report asked
  // for — the panel exposes no such signal, and inventing a graph-is-quiet
  // reading from out here would be guessing at the frontend's state. What it
  // buys is a moment for pending edits to land, exactly as the reconnect retry
  // already does for a dropped socket.
  describe("#1050: the re-issue settles first", () => {
    it("waits before re-dispatching instead of racing in the same tick", async () => {
      __panelToolsTestHooks.setRetrySettleMs(40);
      try {
        const { ctx, runs } = runCtx([{ error: RACE }, { queued: true, prompt_id: "p1" }]);
        const started = Date.now();
        const res = await defByName("panel_run").handler({ to_node_id: 650 }, ctx);
        const elapsed = Date.now() - started;

        expect(res.isError).toBeFalsy();
        expect(runs).toHaveLength(2);
        // The gap is the whole fix: without it the second dispatch is issued
        // synchronously into the window that just refused the first.
        expect(elapsed).toBeGreaterThanOrEqual(35);
      } finally {
        __panelToolsTestHooks.setRetrySettleMs(0);
      }
    });

    it("still re-issues EXACTLY once when the pause does not save it", async () => {
      const { ctx, runs } = runCtx([{ error: RACE }, { error: RACE }]);
      const res = await defByName("panel_run").handler({ to_node_id: 650 }, ctx);

      expect(res.isError).toBe(true);
      expect(runs).toHaveLength(2); // never a third — a second race is surfaced
    });

    // A graph still moving after the pause means the canvas is being edited, and
    // that is the one thing the caller can act on.
    it("says a second race means the graph is still changing", async () => {
      const { ctx } = runCtx([{ error: RACE }, { error: RACE }]);
      const res = await defByName("panel_run").handler({ to_node_id: 650 }, ctx);
      const text = runText(res);
      expect(text).toMatch(/after a short pause to let pending graph edits land/);
      expect(text).toMatch(/still changing under the run/);
      // …and the certified fact is unchanged.
      expect(text).toMatch(/first dispatch definitely queued nothing/);
    });

    // The pause must not apply to rejections that are NOT the certified race —
    // those are terminal and must stay instant.
    it("does not pause a rejection it will not retry", async () => {
      __panelToolsTestHooks.setRetrySettleMs(300);
      try {
        const { ctx, runs } = runCtx([{ error: "ComfyUI refused: node 3 has no input 'x'" }]);
        const started = Date.now();
        const res = await defByName("panel_run").handler({ to_node_id: 650 }, ctx);
        expect(res.isError).toBe(true);
        expect(runs).toHaveLength(1);
        expect(Date.now() - started).toBeLessThan(250);
      } finally {
        __panelToolsTestHooks.setRetrySettleMs(0);
      }
    });
  });

  it("does NOT retry a rejection that is not the certified race (validation failure)", async () => {
    const { ctx, runs } = runCtx([
      { node_errors: { 5: { class_type: "KSampler", errors: [{ message: "bad seed" }] } } },
    ]);
    const res = await defByName("panel_run").handler({ to_node_id: 650 }, ctx);

    expect(res.isError).toBe(true);
    expect(runs).toHaveLength(1);
    expect(runText(res)).toMatch(/bad seed/);
    expect(runText(res)).not.toMatch(/re-issued/);
  });

  it("does NOT retry when the panel omits the 'Nothing was queued' certification", async () => {
    // Same race verdict, no proof the queue is clean → a retry could double-queue.
    const uncertified = RACE.replace("Nothing was queued - refusing", "Refusing");
    const { ctx, runs } = runCtx([{ error: uncertified }, { queued: true }]);
    const res = await defByName("panel_run").handler({ to_node_id: 650 }, ctx);

    expect(res.isError).toBe(true);
    expect(runs).toHaveLength(1);
  });

  it("does NOT retry an isError reply even when it quotes both phrases (outcome unknown)", async () => {
    // A post-write timeout / transport drop may ALREADY have queued the run.
    const { ctx, runs } = runCtx([{ __error: RACE }, { queued: true }]);
    const res = await defByName("panel_run").handler({ to_node_id: 650 }, ctx);

    expect(res.isError).toBe(true);
    expect(runs).toHaveLength(1);
  });

  it("does NOT retry a FULL-graph run — the gate reads our own args, not panel prose", async () => {
    const { ctx, runs } = runCtx([{ error: RACE }, { queued: true }]);
    const res = await defByName("panel_run").handler({}, ctx);

    expect(res.isError).toBe(true);
    expect(runs).toHaveLength(1);
  });

  it("re-races once and then STOPS, disclosing the second dispatch without claiming its outcome", async () => {
    const { ctx, runs } = runCtx([{ error: RACE }, { error: RACE }]);
    const res = await defByName("panel_run").handler({ to_node_id: 650 }, ctx);

    expect(res.isError).toBe(true);
    expect(runs).toHaveLength(2); // never a third
    expect(runText(res)).toMatch(/re-issued exactly once/);
    expect(runText(res)).toMatch(/the first dispatch definitely queued nothing/);
    // It does NOT assert the second dispatch's queue state — only the first is certified.
    expect(runText(res)).not.toMatch(/Exactly one render was queued/);
  });

  it("STRUCTURED queue evidence vetoes the prose — `queued:true` alongside the race never retries", async () => {
    // detectRunRejection deliberately calls any non-empty `error` a rejection even
    // with a stale `queued:true` (#213). For the RETRY decision that same reply is
    // the opposite case: an OBSERVED positive queue signal. "Nothing was queued" is
    // prose the panel wrote; `queued:true` is a fact it reported. Retrying here
    // would put a SECOND render in the queue.
    const { ctx, runs } = runCtx([{ queued: true, error: RACE }, { queued: true }]);
    const res = await defByName("panel_run").handler({ to_node_id: 650 }, ctx);

    expect(res.isError).toBe(true);
    expect(runs).toHaveLength(1);
  });

  it("a reported prompt_id also vetoes the retry", async () => {
    const { ctx, runs } = runCtx([{ error: RACE, prompt_id: "p-already-queued" }, { queued: true }]);
    const res = await defByName("panel_run").handler({ to_node_id: 650 }, ctx);

    expect(res.isError).toBe(true);
    expect(runs).toHaveLength(1);
    // #944: the reply claims both a refusal and a prompt id. It is reported as a
    // failure (unchanged), but the text no longer settles the contradiction it
    // has no way to settle.
    expect(runText(res)).toContain("[UNCERTAIN]");
  });

  // #944 END-TO-END. The unit tests above cover the decision; this covers the
  // WIRING — that the disclosure actually reaches the caller's text. Without it,
  // deleting the append at the call site breaks nothing visible.
  it("a partially-validated run comes back as a QUEUE, with the dropped output named", async () => {
    const { ctx, runs } = runCtx([
      {
        queued: true,
        prompt_id: "p-partial",
        node_errors: {
          "92": {
            class_type: "SaveVideo",
            errors: [{ message: "Exception when validating node", details: "'43069'" }],
          },
        },
      },
    ]);
    const res = await defByName("panel_run").handler({}, ctx);

    // The reported bug: this was `isError` with "ComfyUI refused to queue".
    expect(res.isError).toBeFalsy();
    expect(runs).toHaveLength(1);
    const text = runText(res);
    expect(text).not.toMatch(/refused to queue/i);
    expect(text).toContain("[PARTIAL]");
    expect(text).toContain("SaveVideo (node 92)");
    expect(text).toMatch(/Do NOT re-run/);
    // The partial notice must lead the appendices — it changes what to expect
    // from this run, so it cannot trail behind the anti-poll boilerplate.
    expect(text.indexOf("[PARTIAL]")).toBeLessThan(text.indexOf("[IMPORTANT]"));
  });

  it("does NOT retry an unparseable reply — unreadable is an unknown, not a clean queue", async () => {
    const runs: Record<string, unknown>[] = [];
    const ctx = {
      call: async (cmd: Record<string, unknown>) => {
        if (cmd.cmd !== "graph_run") return { content: [{ type: "text", text: "{}" }] };
        runs.push(cmd);
        // Non-JSON body that still carries both phrases.
        return { content: [{ type: "text", text: RACE }] };
      },
      confirm: async () => "yes" as const,
      bridge: { push: () => 1 } as unknown as PanelToolCtx["bridge"],
      tabId: "t",
    } as unknown as PanelToolCtx;
    await defByName("panel_run").handler({ to_node_id: 650 }, ctx);
    expect(runs).toHaveLength(1);
  });

  it("a THROWING second dispatch reports both facts instead of destroying them", async () => {
    // The one point where a throw would lose evidence we already hold: that the
    // first dispatch was certified not-queued, and that a second went out whose
    // outcome is now unknown. Never claim the queue is clean; never invite a third.
    const { ctx, runs } = runCtx([{ error: RACE }, { __throw: "socket exploded" }]);
    const res = await defByName("panel_run").handler({ to_node_id: 650 }, ctx);

    expect(res.isError).toBe(true);
    expect(runs).toHaveLength(2);
    const t = runText(res);
    expect(t).toMatch(/outcome is UNKNOWN and it may have queued a render/);
    expect(t).toMatch(/FIRST dispatch was certified by the panel to have queued nothing/);
    expect(t).toMatch(/Do NOT re-run blindly/);
    expect(t).toMatch(/socket exploded/); // the cause is preserved, not swallowed
  });

  it("the retryable-race classifier itself refuses an unknown outcome", () => {
    const race: ToolResult = { content: [{ type: "text", text: RACE }] };
    const answered: ToolResult = { content: [{ type: "text", text: "{}" }] };
    const errored: ToolResult = { content: [{ type: "text", text: "boom" }], isError: true };
    const queued: ToolResult = {
      content: [{ type: "text", text: JSON.stringify({ queued: true, error: RACE }) }],
    };
    const unparseable: ToolResult = { content: [{ type: "text", text: "not json" }] };
    expect(__panelRunTestHooks.isRetryableRunToNodeStampRace(answered, race)).toBe(true);
    expect(__panelRunTestHooks.isRetryableRunToNodeStampRace(errored, race)).toBe(false);
    expect(__panelRunTestHooks.isRetryableRunToNodeStampRace(queued, race)).toBe(false);
    expect(__panelRunTestHooks.isRetryableRunToNodeStampRace(unparseable, race)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #803 — the bridge now names the FULL routing tab id in its no-reply timeout.
// The ack-timeout classifier must keep matching it, INCLUDING ids with spaces
// (ComfyUI's own default workflow name has two), or the whole verify-after-
// timeout recovery silently stops firing for exactly the workflows in these
// reports: a guard answering "no" because it could not parse.
// ---------------------------------------------------------------------------
describe("panel-tools: ack-timeout classification survives a full, spaced tab id (#803)", () => {
  const timeout = (tabId: string): ToolResult => ({
    content: [
      {
        type: "text",
        text:
          `Panel tab ${tabId} did not reply to "workflow_open" within 15000 ms — ` +
          `the ComfyUI tab may be backgrounded or frozen`,
      },
    ],
    isError: true,
  });

  it("classifies a SPACED full routing id as an ack timeout", () => {
    expect(
      __openWorkflowTestHooks.isAckTimeout(
        timeout("wf:workflows/Untitled 2026-08-04 06-15-58.json"),
      ),
    ).toBe(true);
  });

  it("still classifies the unspaced and legacy sliced forms", () => {
    expect(__openWorkflowTestHooks.isAckTimeout(timeout("wf:workflows/a.json"))).toBe(true);
    expect(__openWorkflowTestHooks.isAckTimeout(timeout("wf:workf"))).toBe(true);
  });

  it("accepts the wrapper's `Error: ` prefix and an APPENDED retry token", () => {
    // ctx.call surfaces a reply timeout as exactly `Error: ` + the bridge message,
    // and #694 may append a retry-token sentence. Both must still classify, or the
    // recovery silently switches off.
    const wrapped: ToolResult = {
      content: [
        {
          type: "text",
          text:
            `Error: Panel tab wf:workflows/My Graph.json did not reply to "workflow_open" within ` +
            `15000 ms — the ComfyUI tab may be backgrounded or frozen\n\nTo retry this exact ` +
            `mutation, re-issue identical args plus retry_of:"abc"; otherwise call normally.`,
        },
      ],
      isError: true,
    };
    expect(__openWorkflowTestHooks.isAckTimeout(wrapped)).toBe(true);
  });

  it("REFUSES an acked executor error that merely EMBEDS the timeout phrase", () => {
    // Only the bridge's own no-reply message STARTS with the preamble. A relayed
    // executor failure that quotes it is a real, acked error — treating it as a
    // no-reply sends it down the receipt-recovery path, where it can be reported
    // as a "recovered" success for something that genuinely failed.
    const embedded: ToolResult = {
      content: [
        {
          type: "text",
          text: `relay failed: Panel tab wf:workflows/a.json did not reply to "workflow_open" within 15000 ms — reconnecting`,
        },
      ],
      isError: true,
    };
    expect(__openWorkflowTestHooks.isAckTimeout(embedded)).toBe(false);
  });

  it("REFUSES a whitespace- or newline-prefixed message (the anchor is not trimmed away)", () => {
    // The bridge message never carries leading whitespace, so trimming before the
    // anchor buys nothing and only lets a prefixed acked error through.
    for (const prefix of [" ", "\n", "\t", "  \n"]) {
      expect(
        __openWorkflowTestHooks.isAckTimeout({
          content: [
            {
              type: "text",
              text: `${prefix}Panel tab wf:a.json did not reply to "workflow_open" within 15000 ms — the ComfyUI tab may be backgrounded or frozen`,
            },
          ],
          isError: true,
        }),
      ).toBe(false);
    }
  });

  it("still refuses a timeout for a DIFFERENT command, and any non-error result", () => {
    const other: ToolResult = {
      content: [
        {
          type: "text",
          text: `Panel tab wf:workflows/My Graph.json did not reply to "graph_run" within 20000 ms — the ComfyUI tab may be backgrounded or frozen`,
        },
      ],
      isError: true,
    };
    expect(__openWorkflowTestHooks.isAckTimeout(other)).toBe(false);
    expect(
      __openWorkflowTestHooks.isAckTimeout({
        ...timeout("wf:workflows/a.json"),
        isError: undefined,
      }),
    ).toBe(false);
  });
});

describe("#754 panel_view_nodes_in_viewport: the character budget is REACHABLE", () => {
  // The panel has enforced a character budget here since #845 (a 135k-character
  // reply for a caller inspecting one node). But the orchestrator declared `{}`
  // and called with no arguments, so the budget applied at its default and no
  // caller could move it. An enforced-but-hidden cap is the worst shape: callers
  // hit a limit they can neither see nor raise, and the reply looks merely small.
  it("forwards max_chars when the caller supplies it", async () => {
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_view_nodes_in_viewport").handler({ max_chars: 50000 }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "graph_view_nodes_in_viewport", max_chars: 50000 });
  });

  it("omits the key entirely when the caller does not", async () => {
    // Not `max_chars: undefined` on the wire: the panel's normalizer treats a
    // nonsense value as "fall back to the default", so sending the key at all
    // would record this caller as having asked for something it did not.
    const { ctx, calls } = makeFakeCtx();
    await defByName("panel_view_nodes_in_viewport").handler({}, ctx);
    expect(calls[0]).toMatchObject({ cmd: "graph_view_nodes_in_viewport" });
    expect("max_chars" in calls[0]).toBe(false);
  });

  it("declares the ceiling it advertises, so the stated number is enforced", () => {
    // The remedy string says "Raise `max_chars` up to 200000". A prose ceiling the
    // schema does not enforce is the #809 defect in miniature — the caller raises
    // past it and nothing changes. Read the ceiling off the zod shape itself.
    const def = defByName("panel_view_nodes_in_viewport");
    const shape = def.schema as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
    expect(shape.max_chars).toBeDefined();
    expect(shape.max_chars.safeParse(200000).success).toBe(true);
    expect(shape.max_chars.safeParse(200001).success).toBe(false);
    // …and the remedy's number matches what was just proven enforceable.
    expect(def.description).not.toContain("node_ids");
    const remedy = JSON.stringify(def);
    if (remedy.includes("up to ")) {
      expect(remedy).toContain("up to 200000");
    }
  });
});

describe("#690(3) expose_subgraph_* disclose that `name` is dropped on reuse", () => {
  // The executor is idempotent-ish: if the slot is ALREADY exposed it returns the
  // existing boundary slot with `reused:true` and its ORIGINAL name. The tool
  // descriptions promised `name` "titles the new boundary output" with no mention
  // of that, so a caller passing a name got a differently-named slot and a success.
  // Both twins behave identically; the reporter only hit the output one.
  for (const tool of ["panel_expose_subgraph_output", "panel_expose_subgraph_input"]) {
    it(`${tool} says the name is IGNORED on reuse`, () => {
      const def = defByName(tool);
      expect(def.description).toMatch(/IGNORED when this slot is ALREADY exposed/);
      expect(def.description).toMatch(/reused:true/);
      // …and the parameter's own describe() must not contradict the prose.
      const shape = def.schema as Record<string, { description?: string }>;
      expect(shape.name?.description ?? "").toMatch(/IGNORED when the slot is already exposed/);
    });
  }

  it("cites no tool that does not exist", () => {
    // An earlier draft of this text pointed at a `panel_rename_subgraph_slot` that
    // was never built — the #809 "names the wrong lever" defect, in a description
    // rather than a truncation remedy. There is no boundary-slot rename tool, and
    // saying so is more useful than inventing one.
    const names = new Set(buildPanelToolDefs().map((d) => d.name));
    for (const tool of ["panel_expose_subgraph_output", "panel_expose_subgraph_input"]) {
      const text = defByName(tool).description;
      for (const m of text.match(/panel_[a-z_]+/g) ?? []) {
        expect(names.has(m), `${tool} description cites ${m}, which is not a registered tool`).toBe(true);
      }
    }
  });
});

describe("#767 panel_add_node warns against parallel bursts", () => {
  // Parallel adds each carry a fresh /object_info payload, and the coalescer
  // registers those SERIALLY (deliberately — joining an older in-flight refresh
  // once dropped a just-installed node's defs, #289 P2). So N concurrent adds
  // become N sequential refresh cycles; on a large install that outruns the 30s
  // per-command deadline and the later adds time out WHILE STILL QUEUED, then
  // apply when their turn comes. The reporter found "ghost" nodes matching calls
  // they had been told failed.
  //
  // The coalescing fix is a separate, riskier change (its failure mode is
  // silently dropping node definitions). Telling the caller not to walk into it
  // costs nothing and is where an agent actually looks.
  it("tells the caller to add sequentially, and says why", () => {
    const d = defByName("panel_add_node");
    expect(d.description).toMatch(/ONE AT A TIME/);
    expect(d.description).toMatch(/register SERIALLY|SERIALLY/);
    expect(d.description).toMatch(/30s per-command deadline/);
  });

  it("names the consequence that makes it worth heeding", () => {
    // "be careful" is ignorable; "you will be told it failed and it will happen
    // anyway" is not. That asymmetry is the whole point of the sentence.
    const d = defByName("panel_add_node");
    expect(d.description).toMatch(/time out WHILE STILL QUEUED/);
    expect(d.description).toMatch(/told had failed/);
  });

  it("does not promise a fix that has not shipped", () => {
    // The coalescing change is NOT done; the description must not imply adds are
    // now safe to parallelise or that the timeout was raised.
    const d = defByName("panel_add_node");
    expect(d.description).not.toMatch(/now safe|no longer times out|timeout (has been )?raised/i);
  });
});

describe("panel#769 restart refusal names the tunnelled-remote case", () => {
  // remoteUrlActive = forceRemote || !isLoopbackHost(host). A REMOTE ComfyUI
  // reached over a tunnel or port-forward has a LOOPBACK host, so it classifies
  // as local, this refusal fires, and it correctly reports that it cannot find a
  // local process to account for — because there is none. The refusal was right
  // about what it observed and useless about what to do: the reader goes looking
  // for a local install that does not exist.
  const refusal = () => {
    const src = readFileSync(
      new URL("../../orchestrator/panel-tools.ts", import.meta.url),
      "utf8",
    );
    const i = src.indexOf("Refusing to restart ComfyUI: I could not confirm");
    expect(i).toBeGreaterThan(-1);
    return src.slice(i, i + 3000);
  };

  it("names the classification as HOST-based, not instance-based", () => {
    const t = refusal();
    expect(t).toMatch(/reached through a tunnel/);
    expect(t).toMatch(/proves the route is local, not the instance/);
  });

  it("names the exact setting that re-classifies it", () => {
    // A lever that does not exist is worse than no lever (#809's defect in a
    // description). Both spellings are real: resolveForceRemote() reads
    // COMFYUI_MCP_FORCE_REMOTE and argv --force-remote.
    const t = refusal();
    expect(t).toMatch(/COMFYUI_MCP_FORCE_REMOTE=1/);
    expect(t).toMatch(/--force-remote/);
  });

  it("says what the remote path then does, so it is not a blind flag", () => {
    expect(refusal()).toMatch(/restarts through ComfyUI-Manager/);
  });

  it("keeps the original alternative — this is additive", () => {
    // restart_comfyui remains the answer for a genuinely local install that
    // simply could not be identified; the tunnel note must not displace it.
    const t = refusal();
    expect(t).toMatch(/USE restart_comfyui/);
  });
});
