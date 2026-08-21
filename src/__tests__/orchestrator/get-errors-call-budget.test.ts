// #1973 — panel_get_errors on a 77-node live workflow exhausted the panel's
// shared server-call budget, left the sampler / decoder / assembler / SaveVideo
// unchecked, and still led with errored_count: 0 plus "no errors recorded".
//
// The panel's live combo scan is a 4 s STEP inside that budget, so the leftover
// execution path is a property of the REPLY, not of a timeout. These tests drive
// the real panel_get_errors def: a stubbed panel returns the reporter's shape,
// and the assertions read the payload the caller actually gets.

import { describe, expect, it } from "vitest";
import { buildPanelToolDefs, type PanelToolCtx } from "../../orchestrator/panel-tools.js";

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

const BUDGET_REASON = "not checked: get_errors ran out of its shared server-call budget";
const CLEAN_NOTE = "no errors recorded since the last execution start";

const EXECUTION_NODES = [
  { id: 51, type: "KSampler", widget: "sampler_name", value: "euler" },
  { id: 62, type: "VAEDecode", widget: "vae", value: "vae.safetensors" },
  { id: 70, type: "VHS_VideoCombine", widget: "format", value: "video/h264-mp4" },
  { id: 71, type: "SaveVideo", widget: "codec", value: "h264" },
  { id: 73, type: "ImpactSwitch", widget: "select", value: "prompt_a" },
] as const;

function budgetExhaustedReply(opts?: { extraUnchecked?: number }): Record<string, unknown> {
  const extra = opts?.extraUnchecked ?? 35;
  const extras = Array.from({ length: extra }, (_, i) => ({
    id: i + 1,
    type: `Loader${i + 1}`,
    reason: BUDGET_REASON,
  }));
  const execution = EXECUTION_NODES.map((n) => ({
    id: n.id,
    type: n.type,
    reason: BUDGET_REASON,
  }));
  const unchecked = [...extras, ...execution];
  return {
    viewing: { kind: "root", workflow: "wan.json" },
    node_count: 37 + extra,
    errored_count: 0,
    nodes: [],
    unchecked_nodes: unchecked,
    unchecked_nodes_note: `NOT CHECKED: ${unchecked.length} node(s) this scan could not judge.`,
    unchecked_budget_exhausted: true,
    last_execution_error: null,
    node_errors: null,
    note: CLEAN_NOTE,
  };
}

function objectInfoFor(nodes: readonly { type: string; widget: string; value: string }[]): Record<string, unknown> {
  const info: Record<string, unknown> = {};
  for (const n of nodes) {
    const prev = (info[n.type] as { input?: { required?: Record<string, unknown> } } | undefined) ?? {
      input: { required: {} },
      output: [],
      name: n.type,
    };
    const required = { ...(prev.input?.required ?? {}) };
    required[n.widget] = [[n.value, "other"], {}];
    info[n.type] = { ...prev, input: { required } };
  }
  return info;
}

function detailText(
  nodes: readonly { id: number; type: string; widget: string; value: string }[],
): string {
  return nodes
    .map((n) => JSON.stringify({ id: n.id, type: n.type, widgets: { [n.widget]: n.value } }))
    .join("\n");
}

async function runGetErrors(
  replies: (cmd: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ payload: Record<string, unknown>; cmds: string[]; keys: string[] }> {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_get_errors");
  if (!def) throw new Error("panel_get_errors is not registered");
  const cmds: string[] = [];
  const res = (await def.handler(
    {},
    {
      call: async (cmd: Record<string, unknown>) => {
        cmds.push(String(cmd.cmd));
        return { content: [{ type: "text" as const, text: JSON.stringify(replies(cmd), null, 2) }] };
      },
    } as unknown as PanelToolCtx,
  )) as ToolResult;
  const text = res.content.find((c) => c.type === "text")?.text;
  if (typeof text !== "string") throw new Error("panel_get_errors returned no text");
  const payload = JSON.parse(text) as Record<string, unknown>;
  return { payload, cmds, keys: Object.keys(payload) };
}

describe("panel_get_errors leftover call-budget audit (#1973)", () => {
  it("does not lead with a clean errored_count:0 while the execution path is unchecked", async () => {
    const panel = budgetExhaustedReply();
    const { payload, cmds, keys } = await runGetErrors((cmd) => {
      if (cmd.cmd === "graph_get_errors") return panel;
      // Follow-ups fail closed: the incomplete presentation must still fire.
      return { ok: false };
    });

    expect(cmds[0]).toBe("graph_get_errors");
    expect(payload.audit_complete).toBe(false);
    expect(keys[0]).toBe("audit_complete");
    expect(keys.indexOf("audit_complete")).toBeLessThan(keys.indexOf("errored_count"));
    expect(payload.errored_count).toBe(0);
    expect(payload.unchecked_budget_exhausted).toBe(true);
    expect(payload.unchecked_count).toBe(
      new Set((panel.unchecked_nodes as Array<{ id: unknown }>).map((n) => String(n.id))).size,
    );
    expect(payload.checked_count).toBe(
      (panel.node_count as number) - (payload.unchecked_count as number),
    );
    expect(String(payload.note)).toMatch(/AUDIT INCOMPLETE/i);
    expect(String(payload.note)).not.toMatch(/no errors recorded since the last execution/i);
    expect(String(payload.note)).toMatch(/not a clean bill of health/i);
  });

  it("finishes leftover execution nodes from one batched object_info, not another per-class wait", async () => {
    const panel = budgetExhaustedReply({ extraUnchecked: 0 });
    const leftover = EXECUTION_NODES;
    const { payload, cmds } = await runGetErrors((cmd) => {
      if (cmd.cmd === "graph_get_errors") return panel;
      if (cmd.cmd === "graph_query") {
        expect(cmd.fields).toBe("detail");
        const ids = (cmd.ids as unknown[]).map(String);
        for (const n of leftover) expect(ids).toContain(String(n.id));
        return {
          matched: leftover.length,
          shown: leftover.length,
          text: detailText(leftover),
        };
      }
      if (cmd.cmd === "graph_get_object_info") {
        return { ok: true, object_info: objectInfoFor(leftover) };
      }
      return { ok: false };
    });

    expect(cmds.filter((c) => c === "graph_get_object_info")).toHaveLength(1);
    expect(cmds.filter((c) => c === "graph_query")).toHaveLength(1);
    expect(payload.audit_complete).toBe(true);
    expect(payload.unchecked_budget_exhausted).toBeUndefined();
    const leftoverIds = new Set(leftover.map((n) => String(n.id)));
    const still = Array.isArray(payload.unchecked_nodes) ? payload.unchecked_nodes : [];
    for (const n of still as Array<{ id?: unknown }>) {
      expect(leftoverIds.has(String(n.id)), `${n.id} should have been judged`).toBe(false);
    }
    expect(payload.errored_count).toBe(0);
    expect(payload.unavailable_widget_values).toBeUndefined();
  });

  it("reports a combo miss on an execution node the budget skip had hidden", async () => {
    const panel = budgetExhaustedReply({ extraUnchecked: 0 });
    const save = EXECUTION_NODES.find((n) => n.type === "SaveVideo")!;
    const { payload } = await runGetErrors((cmd) => {
      if (cmd.cmd === "graph_get_errors") return panel;
      if (cmd.cmd === "graph_query") {
        return {
          matched: EXECUTION_NODES.length,
          shown: EXECUTION_NODES.length,
          text: detailText(EXECUTION_NODES),
        };
      }
      if (cmd.cmd === "graph_get_object_info") {
        const info = objectInfoFor(EXECUTION_NODES);
        // The live widget names a codec the server does not offer.
        info.SaveVideo = {
          input: { required: { codec: [["prores", "vp9"], {}] } },
          output: [],
          name: "SaveVideo",
        };
        return { ok: true, object_info: info };
      }
      return { ok: false };
    });

    expect(payload.audit_complete).toBe(true);
    const unavailable = payload.unavailable_widget_values as Array<Record<string, unknown>>;
    expect(Array.isArray(unavailable)).toBe(true);
    const hit = unavailable.find((u) => String(u.id) === String(save.id));
    expect(hit, "the SaveVideo codec miss must surface").toBeTruthy();
    expect(hit?.widget).toBe("codec");
    expect(hit?.value).toBe(save.value);
    expect(String(payload.note ?? "")).not.toMatch(/no errors recorded since the last execution/i);
  });

  it("does not spend follow-up calls when the panel already finished the scan", async () => {
    const { payload, cmds } = await runGetErrors((cmd) => {
      if (cmd.cmd === "graph_get_errors") {
        return {
          node_count: 8,
          errored_count: 0,
          nodes: [],
          last_execution_error: null,
          node_errors: null,
          note: CLEAN_NOTE,
        };
      }
      throw new Error(`unexpected follow-up ${cmd.cmd}`);
    });

    expect(cmds).toEqual(["graph_get_errors"]);
    expect(payload.audit_complete).toBeUndefined();
    expect(payload.errored_count).toBe(0);
    expect(payload.note).toBe(CLEAN_NOTE);
  });
});
