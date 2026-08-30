// #2545 — panel_set_widget changed MiniMaxH3Director duration 5→6 (read-back
// confirmed) then reported a frontend setting-store onValueChange throw:
// write_warning: Cannot read properties of undefined (reading 'options')
// write_warning_frame: at onValueChange (/assets/settingStore-*.js)
//
// The assignment already landed. Treating that callback throw as a failed write
// invites a retry of a mutation that is already in effect.

import { describe, expect, it } from "vitest";
import {
  buildPanelToolDefs,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

const NODE_ID = 12;
const REQUESTED = 6;
const PREVIOUS = 5;
const OPTIONS_THROW = "Cannot read properties of undefined (reading 'options')";
const SETTING_STORE_FRAME =
  "at onValueChange (/assets/settingStore-KkBYyEnh.js:153:120812)";

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`${name} is not registered`);
  return def;
}

function textOf(res: ToolResult): string {
  return res.content.map((c) => ("text" in c ? (c.text ?? "") : "")).join(" ");
}

function parseJson(res: ToolResult): Record<string, unknown> | null {
  const text = textOf(res).replace(/^Error:\s*/i, "").trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function durationNode(widgets: Record<string, unknown>) {
  return {
    truncated: false,
    viewing: { scope: "root", graph_identity: "graph:2545", workflow_uuid: "wf-2545" },
    nodes: [
      {
        id: NODE_ID,
        type: "MiniMaxH3Director",
        is_subgraph: false,
        inputs: [],
        widgets,
      },
    ],
  };
}

function setEnvelope(extra: Record<string, unknown> = {}) {
  return {
    set: {
      node_id: NODE_ID,
      widget: "duration",
      previous: PREVIOUS,
      value: REQUESTED,
      ...extra,
    },
  };
}

function okResult(body: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

function errResult(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: `Error: ${text}` }] };
}

async function runSetWidget(
  call: PanelToolCtx["call"],
  args: Record<string, unknown> = { node_id: NODE_ID, widget: "duration", value: REQUESTED },
): Promise<ToolResult> {
  return defByName("panel_set_widget").handler(args as never, {
    call,
    confirm: async () => "yes" as const,
    bridge: {} as PanelToolCtx["bridge"],
    tabId: "t-2545",
  } as PanelToolCtx);
}

function scriptedCall(opts: {
  write: ToolResult;
  queryWidgets?: Record<string, unknown>;
  queryError?: string;
}): { call: PanelToolCtx["call"]; cmds: string[] } {
  const cmds: string[] = [];
  const call: PanelToolCtx["call"] = async (cmd) => {
    cmds.push(String(cmd.cmd));
    if (cmd.cmd === "graph_set_widget") return opts.write;
    if (cmd.cmd === "graph_query") {
      if (opts.queryError) return errResult(opts.queryError);
      return okResult(durationNode(opts.queryWidgets ?? { duration: REQUESTED }));
    }
    return okResult({});
  };
  return { call, cmds };
}

describe("panel_set_widget MiniMaxH3Director duration callback throw (#2545)", () => {
  it("THE REPORTED CASE: duration 5→6 with setting-store onValueChange write_warning is success", async () => {
    const { call, cmds } = scriptedCall({
      write: okResult(
        setEnvelope({
          write_warning: OPTIONS_THROW,
          write_warning_frame: SETTING_STORE_FRAME,
          write_warning_source: "widget_callback",
        }),
      ),
    });
    const res = await runSetWidget(call);
    const payload = parseJson(res);
    const set = payload?.set as Record<string, unknown> | undefined;

    expect(cmds).toContain("graph_set_widget");
    expect(res.isError).toBeUndefined();
    expect(set).toMatchObject({
      node_id: NODE_ID,
      widget: "duration",
      previous: PREVIOUS,
      value: REQUESTED,
    });
    expect(set?.write_warning).toBeUndefined();
    expect(set?.write_warning_frame).toBeUndefined();
    expect(set?.write_warning_source).toBeUndefined();
    expect(textOf(res)).not.toMatch(/write_warning/);
  });

  it("reclassifies an isError write_warning when the set envelope already shows the value landed", async () => {
    const { call } = scriptedCall({
      write: errResult(
        JSON.stringify(
          setEnvelope({
            write_warning: OPTIONS_THROW,
            write_warning_frame: SETTING_STORE_FRAME,
          }),
        ),
      ),
    });
    const res = await runSetWidget(call);
    const set = parseJson(res)?.set as Record<string, unknown> | undefined;

    expect(res.isError).toBeUndefined();
    expect(set?.value).toBe(REQUESTED);
    expect(set?.write_warning).toBeUndefined();
  });

  it("settles a write_warning error without a set envelope from a graph read-back of the landed value", async () => {
    const { call, cmds } = scriptedCall({
      write: errResult(
        `write_warning: ${OPTIONS_THROW}\nwrite_warning_frame: ${SETTING_STORE_FRAME}`,
      ),
      queryWidgets: { duration: REQUESTED },
    });
    const res = await runSetWidget(call);
    const set = parseJson(res)?.set as Record<string, unknown> | undefined;

    expect(cmds.filter((c) => c === "graph_query").length).toBeGreaterThan(0);
    expect(res.isError).toBeUndefined();
    expect(set?.value).toBe(REQUESTED);
    expect(textOf(res)).not.toMatch(/write_warning/);
  });

  it("does NOT succeed when the same warning fired but duration did not land", async () => {
    const { call } = scriptedCall({
      write: errResult(
        `write_warning: ${OPTIONS_THROW}\nwrite_warning_frame: ${SETTING_STORE_FRAME}`,
      ),
      queryWidgets: { duration: PREVIOUS },
    });
    const res = await runSetWidget(call);

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/write_warning/);
    expect(textOf(res)).toMatch(/reading 'options'/);
  });

  it("does NOT swallow a real duration write failure", async () => {
    const { call, cmds } = scriptedCall({
      write: errResult(`Cannot set widget "duration" on node ${NODE_ID}: widget not found`),
    });
    const res = await runSetWidget(call);

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/widget not found/);
    expect(cmds.filter((c) => c === "graph_set_widget")).toHaveLength(1);
  });

  it("does NOT strip an unrelated write_warning on a landed duration write", async () => {
    const { call } = scriptedCall({
      write: okResult(
        setEnvelope({
          write_warning: "Cannot delete property 'foo' of undefined",
          write_warning_source: "widget_callback",
        }),
      ),
    });
    const res = await runSetWidget(call);
    const set = parseJson(res)?.set as Record<string, unknown> | undefined;

    expect(res.isError).toBeUndefined();
    expect(set?.value).toBe(REQUESTED);
    expect(set?.write_warning).toMatch(/Cannot delete property/);
  });

  it("does NOT swallow the same warning on a different widget", async () => {
    const { call } = scriptedCall({
      write: okResult({
        set: {
          node_id: NODE_ID,
          widget: "steps",
          previous: 20,
          value: 30,
          write_warning: OPTIONS_THROW,
          write_warning_frame: SETTING_STORE_FRAME,
        },
      }),
    });
    const res = await runSetWidget(call, { node_id: NODE_ID, widget: "steps", value: 30 });
    const set = parseJson(res)?.set as Record<string, unknown> | undefined;

    expect(res.isError).toBeUndefined();
    expect(set?.value).toBe(30);
    expect(set?.write_warning).toBe(OPTIONS_THROW);
  });
});
