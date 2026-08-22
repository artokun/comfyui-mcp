// #2004 — panel widget writes blocked by object_info starvation; uncollapse
// rejects stored zero height; a save budget timeout can land after the reply.
//
// All three cases drive the shipped panel_* handlers on the real dispatch path
// (ctx.call → graph_set_widget / graph_edit_node / workflow_save). The panel's
// sizeSane and schema oracle live in the other repo; these compensations are
// what this orchestrator can still do for a caller who has not updated the panel.

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_NODE_BODY_HEIGHT,
  DEFAULT_NODE_WIDTH,
} from "../../orchestrator/create-group-membership.js";
import {
  needsUncollapseSizeRestore,
  restoredUncollapseSize,
} from "../../orchestrator/edit-node-uncollapse.js";
import {
  buildPanelToolDefs,
  __panelToolsTestHooks,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

type Forwarded = Record<string, unknown>;

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} not found in buildPanelToolDefs()`);
  return def;
}

function jsonResult(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function textOf(res: ToolResult): string {
  return res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");
}

/** Reporter's collapsed node: size [228, 0], uncollapse without an explicit size. */
const COLLAPSED = {
  id: 12,
  type: "OpenAICompatibleLLM",
  pos: [400, 200],
  size: [228, 0] as [number, number],
  collapsed: true,
  full_height: 30,
};

/** The panel's own starvation wording (assertTypeAgainstFreshBackend + oracle note). */
const STARVATION =
  `Cannot set widget on node 12 ("OpenAICompatibleLLM"): cannot verify the node type against the ` +
  `ComfyUI backend — no usable /object_info schema was obtained. Tried 2 routes: ` +
  `api.getNodeDefs() did not answer within its 10000ms share of the 20000ms budget; ` +
  `GET /object_info did not answer within its 5000ms share of the 20000ms budget. ` +
  `Refusing to write rather than trust a possibly-stale node cache (#458). ` +
  `Reconnect ComfyUI and retry.`;

const SAVE_TIMEOUT =
  `workflow_save did not finish within 13s for "graph". ` +
  `The tab is still live — other commands from it still answer, so this is not a backgrounded or frozen tab. ` +
  `The save may still complete in the background. The same tab reports modified:true persisted:true. ` +
  `modified:true means the canvas has not been marked clean, so the write has not been acknowledged as landed. ` +
  `Confirm by reading the saved file itself before retrying — a re-issue may write twice.`;

/** #2078 — the panel's own 13s budget wording, already tagging OUTCOME UNKNOWN. */
const SAVE_TIMEOUT_2078 =
  `workflow_save did not finish within 13s. The save may still complete in the background. OUTCOME UNKNOWN.`;

const FIRST_SAVE_TIMEOUT_2078 =
  `workflow_save did not finish within 13s. The active workflow changed from "Untitled Workflow" ` +
  `to "first-save" while the save was in flight, so which file the hung write targets cannot be determined from here.`;

describe("restored uncollapse size (#2004)", () => {
  it("a stored [228, 0] is not sizeSane and restores keeping the width", () => {
    expect(needsUncollapseSizeRestore([228, 0])).toBe(true);
    expect(restoredUncollapseSize([228, 0])).toEqual([228, DEFAULT_NODE_BODY_HEIGHT]);
  });

  it("a positive stored size is left alone", () => {
    expect(needsUncollapseSizeRestore([228, 140])).toBe(false);
    expect(restoredUncollapseSize([228, 140])).toEqual([228, 140]);
  });

  it("an unreadable size falls back to the panel's default extents", () => {
    expect(needsUncollapseSizeRestore(undefined)).toBe(true);
    expect(restoredUncollapseSize(undefined)).toEqual([DEFAULT_NODE_WIDTH, DEFAULT_NODE_BODY_HEIGHT]);
  });
});

describe("panel_edit_node restores a collapsed zero height before dispatch (#2004)", () => {
  it("THE REPORTED CASE: collapsed:false without size sends a positive size so the panel does not reject [228, 0]", async () => {
    const calls: Forwarded[] = [];
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_query") {
          return jsonResult({
            total: 1,
            matched: 1,
            shown: 1,
            text:
              `1 match(es) of 1 in scope (viewing: 1 nodes)\n` +
              JSON.stringify(COLLAPSED),
          });
        }
        return jsonResult({ edited: [{ node_id: 12, collapsed: false, size: cmd.size }] });
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "test-tab",
    };

    const res = await defByName("panel_edit_node").handler(
      { node_id: 12, collapsed: false },
      ctx,
    );

    expect(res.isError).toBeFalsy();
    expect(calls.map((c) => c.cmd)).toEqual(["graph_query", "graph_edit_node"]);
    const edit = calls.find((c) => c.cmd === "graph_edit_node");
    expect(edit).toMatchObject({
      cmd: "graph_edit_node",
      node_id: 12,
      collapsed: false,
      size: [228, DEFAULT_NODE_BODY_HEIGHT],
    });
    expect((edit?.size as number[])[1]).toBeGreaterThan(0);
  });

  it("does not invent a size when the stored height is already positive", async () => {
    const calls: Forwarded[] = [];
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_query") {
          return jsonResult({
            text: JSON.stringify({ id: 12, pos: [0, 0], size: [228, 140], collapsed: true }),
          });
        }
        return jsonResult({ edited: [{ node_id: 12 }] });
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "test-tab",
    };

    await defByName("panel_edit_node").handler({ node_id: 12, collapsed: false }, ctx);
    const edit = calls.find((c) => c.cmd === "graph_edit_node");
    expect(edit?.size).toBeUndefined();
  });

  it("an explicit size is the caller's, even on a zero-height node", async () => {
    const calls: Forwarded[] = [];
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        calls.push(cmd);
        return jsonResult({ edited: [{ node_id: 12 }] });
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "test-tab",
    };

    await defByName("panel_edit_node").handler(
      { node_id: 12, collapsed: false, size: [400, 200] },
      ctx,
    );
    expect(calls.map((c) => c.cmd)).toEqual(["graph_edit_node"]);
    expect(calls[0]).toMatchObject({ size: [400, 200], collapsed: false });
  });

  it("a failed geometry probe leaves the original uncollapse command untouched", async () => {
    const calls: Forwarded[] = [];
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_query") return errorResult("tab did not reply");
        return jsonResult({ edited: [{ node_id: 12 }] });
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "test-tab",
    };

    await defByName("panel_edit_node").handler({ node_id: 12, collapsed: false }, ctx);
    const edit = calls.find((c) => c.cmd === "graph_edit_node");
    expect(edit?.size).toBeUndefined();
    expect(edit).toMatchObject({ collapsed: false, node_id: 12 });
  });

  it("a title-only edit does not query or rewrite size", async () => {
    const calls: Forwarded[] = [];
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        calls.push(cmd);
        return jsonResult({ edited: [{ node_id: 12 }] });
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "test-tab",
    };

    await defByName("panel_edit_node").handler({ node_id: 12, title: "LLM" }, ctx);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_edit_node"]);
    expect(calls[0].size).toBeUndefined();
  });
});

describe("panel_set_widget names object_info starvation (#2004)", () => {
  it("THE REPORTED CASE: keeps the refusal and says this is a timeout, not a missing node", async () => {
    const calls: Forwarded[] = [];
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_set_widget") return errorResult(STARVATION);
        return jsonResult({ ok: true });
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "test-tab",
    };

    const res = await defByName("panel_set_widget").handler(
      { node_id: 12, widget: "system_prompt", value: "You are a helpful assistant." },
      ctx,
    );

    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain(STARVATION);
    expect(text).toMatch(/refresh TIMEOUT, not a missing node/i);
    expect(text).toMatch(/already on the canvas/i);
    expect(text).toMatch(/Do NOT reinstall a pack/);
    // The refusal is pre-mutation — do not re-issue a write that will pay the same 15s.
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
  });

  it("an unrelated set_widget refusal is not wrapped as starvation", async () => {
    const ctx: PanelToolCtx = {
      call: async () => errorResult('panel_set_widget refused "seed" on node 3 (KSampler): not a valid option'),
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "test-tab",
    };

    const res = await defByName("panel_set_widget").handler(
      { node_id: 3, widget: "seed", value: 1 },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toMatch(/refresh TIMEOUT, not a missing node/i);
  });
});

describe("panel_save_workflow acknowledges a save that landed after the budget (#2004, #2078)", () => {
  afterEach(() => {
    __panelToolsTestHooks.setSaveTimeoutSettleGraceMs(null);
  });

  it("THE REPORTED CASE: modified:false persisted:true after the 13s budget is treated as saved", async () => {
    const calls: Forwarded[] = [];
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "workflow_save") return errorResult(SAVE_TIMEOUT);
        if (cmd.cmd === "workflow_list") {
          return jsonResult({
            active: {
              path: "workflows/graph.json",
              routing_key: "wf:workflows/graph.json",
              filename: "graph",
              modified: false,
              persisted: true,
            },
          });
        }
        return jsonResult({ ok: true });
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "test-tab",
    };

    const res = await defByName("panel_save_workflow").handler({}, ctx);
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toMatch(/"saved": true/);
    expect(text).toMatch(/"late_ack": true/);
    expect(text).toMatch(/"acknowledged_after_timeout": true/);
    expect(calls.map((c) => c.cmd)).toContain("workflow_save");
    expect(calls.map((c) => c.cmd)).toContain("workflow_list");
  });

  it("#2078 THE REPORTED CASE: a list that is still dirty, then clean, is saved not unknown", async () => {
    // The 13s budget fires with modified:true. #2004 listed once, still saw
    // dirty, and returned OUTCOME UNKNOWN. The caller's next panel_list_workflows
    // was already modified:false persisted:true. Keep reading for the grace.
    __panelToolsTestHooks.setSaveTimeoutSettleGraceMs(1500);
    const calls: Forwarded[] = [];
    let lists = 0;
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "workflow_save") return errorResult(SAVE_TIMEOUT_2078);
        if (cmd.cmd === "workflow_list") {
          lists += 1;
          return jsonResult({
            active: {
              path: "workflows/graph.json",
              routing_key: "wf:workflows/graph.json",
              filename: "graph",
              modified: lists === 1,
              persisted: true,
            },
          });
        }
        return jsonResult({ ok: true });
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "test-tab",
    };

    const res = await defByName("panel_save_workflow").handler({}, ctx);
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toMatch(/"saved": true/);
    expect(text).toMatch(/"late_ack": true/);
    expect(text).not.toMatch(/OUTCOME UNKNOWN/);
    expect(lists).toBeGreaterThanOrEqual(2);
    expect(calls.filter((c) => c.cmd === "workflow_save")).toHaveLength(1);
  });

  it("a clean different workflow after the timeout does not acknowledge the save", async () => {
    __panelToolsTestHooks.setSaveTimeoutSettleGraceMs(0);
    let lists = 0;
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        if (cmd.cmd === "workflow_save") return errorResult(SAVE_TIMEOUT_2078);
        if (cmd.cmd === "workflow_list") {
          lists += 1;
          return jsonResult({
            active: {
              path: "workflows/b.json",
              routing_key: "wf:workflows/b.json",
              modified: false,
              persisted: true,
            },
            late_save_receipts: [],
          });
        }
        return jsonResult({ ok: true });
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "test-tab",
    };

    const res = await defByName("panel_save_workflow").handler({}, ctx);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/OUTCOME UNKNOWN/);
    expect(lists).toBe(1);
  });

  it("a first-save successor with the timed-out command's late receipt can be acknowledged", async () => {
    __panelToolsTestHooks.setSaveTimeoutSettleGraceMs(0);
    let lists = 0;
    const ctx: PanelToolCtx = {
      call: async (cmd, _timeoutMs, onDispatchedRid) => {
        if (cmd.cmd === "workflow_save") onDispatchedRid?.("save-rid");
        if (cmd.cmd === "workflow_save") return errorResult(FIRST_SAVE_TIMEOUT_2078);
        if (cmd.cmd === "workflow_list") {
          lists += 1;
          return jsonResult({
            active: {
              path: "workflows/first-save.json",
              filename: "first-save",
              routing_key: "wf:workflows/first-save.json",
              modified: false,
              persisted: true,
            },
            late_save_receipts: [
              {
                rid: "save-rid",
                cmd: "workflow_save",
                result: { saved: true, routing_key: "wf:workflows/first-save.json" },
              },
            ],
          });
        }
        return jsonResult({ ok: true });
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "test-tab",
    };

    const res = await defByName("panel_save_workflow").handler({}, ctx);
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/"late_ack": true/);
    expect(lists).toBe(2);
  });

  it("a first-save timeout cannot acknowledge an unrelated clean successor", async () => {
    __panelToolsTestHooks.setSaveTimeoutSettleGraceMs(0);
    let lists = 0;
    const ctx: PanelToolCtx = {
      call: async (cmd, _timeoutMs, onDispatchedRid) => {
        if (cmd.cmd === "workflow_save") onDispatchedRid?.("save-rid");
        if (cmd.cmd === "workflow_save") return errorResult(FIRST_SAVE_TIMEOUT_2078);
        if (cmd.cmd === "workflow_list") {
          lists += 1;
          return jsonResult({
            active: {
              path: "workflows/other.json",
              filename: "other",
              routing_key: "wf:workflows/other.json",
              modified: false,
              persisted: true,
            },
            late_save_receipts: [
              {
                rid: "save-rid",
                cmd: "workflow_save",
                result: { saved: true, routing_key: "wf:workflows/first-save.json" },
              },
            ],
          });
        }
        return jsonResult({ ok: true });
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "test-tab",
    };

    const res = await defByName("panel_save_workflow").handler({}, ctx);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/OUTCOME UNKNOWN/);
    expect(lists).toBe(1);
  });

  it("modified:true persisted:true at follow-up is still outcome-unknown, not success", async () => {
    // The timeout snapshot itself. Treating persisted:true as proof would have
    // reported the reporter's still-dirty canvas as saved. Grace 0 = one list.
    __panelToolsTestHooks.setSaveTimeoutSettleGraceMs(0);
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        if (cmd.cmd === "workflow_save") return errorResult(SAVE_TIMEOUT);
        if (cmd.cmd === "workflow_list") {
          return jsonResult({
            active: {
              path: "workflows/graph.json",
              routing_key: "wf:workflows/graph.json",
              modified: true,
              persisted: true,
            },
          });
        }
        return jsonResult({ ok: true });
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "test-tab",
    };

    const res = await defByName("panel_save_workflow").handler({}, ctx);
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain(SAVE_TIMEOUT);
    expect(text).toMatch(/OUTCOME UNKNOWN/);
    expect(text).toMatch(/re-issue may write twice/);
  });
});
