// #845 — two defects a reporter hit while inspecting ONE node.
//
// (4) Node ids the tools PRINT could not be passed back in. Every graph reader
//     returns ids as strings (`"id": "42"`), while every input schema demanded
//     `z.number().int()`. So the obvious move — copy an id out of
//     panel_query_graph, paste it into panel_select_nodes — failed on the first
//     attempt, every time, with a raw zod `expected number, received string`.
//
// (3) panel_canvas used two names for one concept and dropped the other in
//     silence: `action:"zoom"` requires `scale`, while a `zoom` argument was not
//     in the schema at all. Passing `zoom: 0.55` with `center_on_node` returned
//     `scale: 0.067` — which reads as "applied, then overridden", when it was
//     never applied. The panel's center_on_node sets the offset and does not
//     touch the scale.

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildPanelToolDefs,
  ignoredCanvasArgs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text;

let sent: Array<Record<string, unknown>>;
let ctx: PanelToolCtx;

beforeEach(() => {
  sent = [];
  const bridge = {
    send: async (cmd: Record<string, unknown>) => {
      sent.push(cmd);
      // Mirror the panel: report the canvas's ACTUAL resulting state.
      return { ok: true, scale: cmd.action === "zoom" ? cmd.scale : 0.067 };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: "tab-1", title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => "tab-1",
  } as unknown as PanelToolCtx["bridge"];
  ctx = makePanelToolCtx(bridge, "tab-1");
});

const tool = (name: string) => buildPanelToolDefs().find((d) => d.name === name)!;

/**
 * Call a tool the way the MCP server does: PARSE the args through the tool's own
 * schema first, then hand the parsed value to the handler. Calling `handler`
 * directly skips zod entirely — which is exactly where the coercion lives, so a
 * direct call would test nothing about it.
 *
 * Returns the zod error as a failed ToolResult, mirroring the -32602 the caller
 * would receive.
 */
async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const def = tool(name);
  const parsed = z.object(def.schema).safeParse(args);
  if (!parsed.success) {
    return { isError: true, content: [{ type: "text", text: parsed.error.message }] } as ToolResult;
  }
  return def.handler(parsed.data as Record<string, unknown>, ctx);
}

describe("#845(4): an id the tools printed is accepted back", () => {
  it("panel_select_nodes takes the string form from panel_query_graph", async () => {
    const res = await callTool("panel_select_nodes", { node_ids: ["42"] });
    expect(res.isError).toBeFalsy();
    // …and the wire still carries the number it always did.
    expect(sent[0].node_ids).toEqual([42]);
  });

  it("still takes the numeric form", async () => {
    await callTool("panel_select_nodes", { node_ids: [42] });
    expect(sent[0].node_ids).toEqual([42]);
  });

  it("accepts a mixed list", async () => {
    await callTool("panel_select_nodes", { node_ids: ["42", 7] });
    expect(sent[0].node_ids).toEqual([42, 7]);
  });

  it("applies to scalar node_id args too", async () => {
    await callTool("panel_canvas", { action: "center_on_node", node_id: "42" });
    expect(sent[0].node_id).toBe(42);
  });

  // A subgraph-qualified id is a REAL shape in newer ComfyUI. #845 REFUSED it,
  // because coercing "5:12" to 5 would target the WRONG node and refusing was the
  // safe half of that trade. #1425 is the deliberate wire-contract change #845 said
  // this would take: unpacking a subgraph leaves genuine ROOT nodes with these ids,
  // the readers hand them out, and refusing left 18 of 21 nodes uneditable.
  //
  // The half that must NOT change is the one this test was really protecting: it is
  // still never allowed to become 5.
  it("accepts a subgraph-qualified id and forwards it VERBATIM", async () => {
    const res = await callTool("panel_select_nodes", { node_ids: ["5:12"] });
    expect(res.isError).toBeFalsy();
    expect(sent).toHaveLength(1);
    expect(sent[0].node_ids).toEqual(["5:12"]);
    // The trap #845 named, asserted directly rather than implied.
    expect(sent[0].node_ids).not.toContain(5);
  });

  it("accepts a DEEP qualified id — nesting has no depth limit", async () => {
    const res = await callTool("panel_select_nodes", { node_ids: ["120:113:78"] });
    expect(res.isError).toBeFalsy();
    expect(sent[0].node_ids).toEqual(["120:113:78"]);
  });

  it("still normalizes plain ids alongside qualified ones in the same call", async () => {
    const res = await callTool("panel_select_nodes", { node_ids: ["4", "263:78", 7] });
    expect(res.isError).toBeFalsy();
    expect(sent[0].node_ids).toEqual([4, "263:78", 7]);
  });

  it("refuses other non-integer strings", async () => {
    for (const bad of ["42px", "4.5", "", "abc", "1:", ":1", "1::2", "1:-2"]) {
      sent = [];
      const res = await callTool("panel_select_nodes", { node_ids: [bad] });
      expect(res.isError, bad).toBe(true);
    }
  });
});

describe("#845(3): panel_canvas says what it ignored", () => {
  it("accepts `zoom` as the alias it obviously is", async () => {
    await callTool("panel_canvas", { action: "zoom", zoom: 0.55 });
    expect(sent[0].scale).toBe(0.55);
  });

  it("prefers an explicit `scale` when both are given", async () => {
    await callTool("panel_canvas", { action: "zoom", scale: 0.8, zoom: 0.55 });
    expect(sent[0].scale).toBe(0.8);
  });

  // The reported case, exactly.
  it("says the zoom was ignored rather than letting it vanish", async () => {
    const res = await callTool("panel_canvas", 
      { action: "center_on_node", node_id: 42, zoom: 0.55 },
    );
    expect(res.isError).toBeFalsy(); // a harmless extra arg must not fail the move
    const text = textOf(res);
    expect(text).toContain("does not use scale/zoom");
    expect(text).toContain("ignored, not applied");
    expect(text).toContain('action:"zoom"'); // the call that would work
  });

  it("stays quiet when every supplied argument is used", async () => {
    const res = await callTool("panel_canvas", { action: "pan", dx: 10, dy: 20 });
    expect(textOf(res)).not.toContain("ignored");
  });

  it("stays quiet for a bare action", async () => {
    const res = await callTool("panel_canvas", { action: "fit" });
    expect(textOf(res)).not.toContain("ignored");
  });
});

describe("#845(3): which args each action consumes", () => {
  it("names only the supplied-but-unused ones", () => {
    expect(ignoredCanvasArgs("center_on_node", { node_id: 42, scale: 0.5 })).toEqual(["scale/zoom"]);
    expect(ignoredCanvasArgs("zoom", { scale: 0.5 })).toEqual([]);
    expect(ignoredCanvasArgs("pan", { dx: 1, dy: 2 })).toEqual([]);
    expect(ignoredCanvasArgs("pan", { dx: 1, node_id: 42 })).toEqual(["node_id"]);
    expect(ignoredCanvasArgs("fit", { node_id: 42, dx: 1, dy: 2, scale: 0.5 })).toEqual([
      "node_id",
      "dx",
      "dy",
      "scale/zoom",
    ]);
  });

  it("ignores absent arguments — undefined is not 'supplied'", () => {
    expect(ignoredCanvasArgs("fit", {})).toEqual([]);
    expect(ignoredCanvasArgs("fit", { node_id: undefined })).toEqual([]);
  });

  // An unknown action is the enum's job to reject. Guessing a consumed-arg set
  // here would invent a claim about behaviour nobody defined.
  it("claims nothing about an action it does not know", () => {
    expect(ignoredCanvasArgs("teleport", { node_id: 42, scale: 1 })).toEqual([]);
  });
});

// #1497 — the ONE argument #845 never reached.
//
// The reporter did exactly what the tool descriptions tell an agent to do: read
// the id back out of panel_add_node (`"11"`, because summarizeNode returns
// `id: node.id` and LiteGraph ids are strings on the modern frontend) and hand it
// to panel_run as `to_node_id`. That call died in zod with
// `expected number, received string` — the identical failure #845 fixed for the
// other 27 node-id arguments and #427 hit on panel_create_group. A canonical
// validator is adopted per CALL SITE; this call site was missed.
//
// The wire is unchanged: what the panel receives is still the NUMBER it has
// always received. That matters beyond tidiness — two branches in panel_run gate
// on `typeof args.to_node_id === "number"` (#772's stamp-race re-issue and #468's
// run ticket), so a to_node_id that stayed a string would silently skip both.
describe("#1497: panel_run accepts the node id its own tools printed", () => {
  it("takes the string spelling panel_add_node returns", async () => {
    const res = await callTool("panel_run", { to_node_id: "11" });
    expect(res.isError).toBeFalsy();
    expect(sent).toHaveLength(1);
    expect(sent[0].cmd).toBe("graph_run");
    // Normalized to the number the panel has always been sent…
    expect(sent[0].to_node_id).toBe(11);
    // …and it really is a number, not the string that merely prints as one:
    // #772/#468 both branch on typeof === "number".
    expect(typeof sent[0].to_node_id).toBe("number");
  });

  it("still takes the numeric spelling", async () => {
    const res = await callTool("panel_run", { to_node_id: 11 });
    expect(res.isError).toBeFalsy();
    expect(sent[0].to_node_id).toBe(11);
  });

  it("leaves a full run alone — an omitted to_node_id stays undefined", async () => {
    const res = await callTool("panel_run", { batch_count: 2 });
    expect(res.isError).toBeFalsy();
    expect(sent[0].to_node_id).toBeUndefined();
    expect(sent[0].batch_count).toBe(2);
  });

  // The half that must NOT widen. A run-to-node target is an EXECUTION ROOT, and
  // the panel resolves it numerically the whole way down (findNodeInScopes matches
  // on Number(id); the reply reports ran_to_node: Number(to_node_id)). Accepting
  // "120:104" here would swap a clear schema refusal for a panel-side
  // "node 120:104 was not found" about a node that plainly exists — and drop the
  // #468 run ticket on the way. So it is still refused, but now BY NAME.
  it("refuses a subgraph-qualified id, and says why", async () => {
    const res = await callTool("panel_run", { to_node_id: "120:104" });
    expect(res.isError).toBe(true);
    expect(sent).toHaveLength(0); // nothing was dispatched
    const msg = textOf(res);
    expect(msg).toContain("plain integer node id");
    expect(msg).toContain("execution root");
  });

  it("refuses ids that are not ids at all", async () => {
    for (const bad of ["11px", "1.5", "", "abc", "1:", " 11"]) {
      sent = [];
      const res = await callTool("panel_run", { to_node_id: bad });
      expect(res.isError, JSON.stringify(bad)).toBe(true);
      expect(sent, JSON.stringify(bad)).toHaveLength(0);
    }
  });
});
