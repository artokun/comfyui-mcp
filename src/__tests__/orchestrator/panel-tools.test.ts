// Coverage for the SHARED panel_* tool surface (buildPanelToolDefs) — focused on
// the copy/paste merge + subgraph save/list/add tools, and on the parity
// guarantee that every shared def registers onto BOTH transports.
//
// The handlers are transport-agnostic: each forwards a bridge command via the
// injected ctx. We assert the exact commands/args they forward (the behavior the
// panel JS executors implement), and that the McpServer HTTP path registers the
// identical set.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getNsfwConsent, setNsfwConsent } from "../../services/panel-settings.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
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
    expect(Object.keys(def.schema).sort()).toEqual(["force", "mode", "node_id"]);
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

  it("forwards graph_set_node_mode with node_id + mode (+ force)", async () => {
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
        { type: "text", text: JSON.stringify({ queued: true, batch_count: 1, to_node_id: 9 }) },
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
      content: [{ type: "text", text: JSON.stringify({ queued: true, batch_count: 1 }) }],
    };
    const { ctx } = makeRunCtx(reply);
    const res = await defByName("panel_run").handler({}, ctx);
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain(QUEUED_NOTE);
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
    listReplies: Array<{ active: unknown }>;
  }): { ctx: PanelToolCtx; cmds: string[] } {
    const cmds: string[] = [];
    let listIdx = 0;
    const ctx = {
      call: async (cmd: Record<string, unknown>) => {
        cmds.push(cmd.cmd as string);
        if (cmd.cmd === "workflow_open") return opts.openReply();
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
      // First list: some other tab is active; second: our target is active.
      listReplies: [
        { active: { path: "other.json", filename: "other.json", key: "k-other" } },
        { active: { path: TARGET, filename: TARGET, key: "k-mine" } },
      ],
    });
    const res = (await defByName("panel_open_workflow").handler({ path: TARGET }, ctx)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toContain("recovered");
    expect(text).toMatch(/active workflow/i);
    // It DID poll the authoritative active signal after the open timed out.
    expect(cmds[0]).toBe("workflow_open");
    expect(cmds).toContain("workflow_list");
  });

  it("ack-timeout AND target never becomes active ⇒ clear FAILURE (no false success)", async () => {
    const { ctx } = makeVerifyCtx({
      openReply: () => timeoutResult(),
      listReplies: [{ active: { path: "other.json", filename: "other.json", key: "k-other" } }],
    });
    const res = (await defByName("panel_open_workflow").handler({ path: TARGET }, ctx)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/did not reply/i);
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

  it("normal fast success returns verbatim without polling workflow_list", async () => {
    let listCalls = 0;
    const ctx = {
      call: async (cmd: Record<string, unknown>) => {
        if (cmd.cmd === "workflow_open") {
          return {
            content: [
              { type: "text", text: JSON.stringify({ opened: { path: TARGET }, modified: false }) },
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
    const res = (await defByName("panel_open_workflow").handler({ path: TARGET }, ctx)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("opened");
    expect(listCalls).toBe(0);
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

  afterEach(() => {
    __panelAskTestHooks.setAskTiming(null);
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
    const dispatched: Array<Record<string, unknown>> = [];
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        if (cmd.cmd === "ask_user") return "Yes, go ahead";
        dispatched.push(cmd);
        return { rebooting: true };
      },
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
});
