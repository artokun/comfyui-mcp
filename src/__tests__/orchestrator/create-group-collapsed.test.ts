// #1877 — panel_create_group with a collapsed node created an empty group and
// listed that node as missing, even though the returned bounds wrapped its
// origin. The shipped path is panel_create_group → graph_create_group; the
// handler now expands the box (graph_edit_group) when a requested node whose
// origin is already inside is still missing.
//
// The mock panel here applies LiteGraph's containsCentre rule independently
// (forceCollapsed wantedNodeArea: size[1]===0 falls back to a 100px body plus
// a 30px title). It does not import the expander under test.

import { describe, expect, it } from "vitest";

import {
  expandGroupBoundsForMembership,
  nodePosInsideGroupBounds,
  type QueriedNodeGeom,
} from "../../orchestrator/create-group-membership.js";
import {
  buildPanelToolDefs,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

type Forwarded = Record<string, unknown>;

const TITLE = 30;
const DEFAULT_BODY = 100;

/** Reporter's collapsed VAEDecode: origin inside a 100px-tall auto-fit box. */
const NODE_81: QueriedNodeGeom = {
  id: 81,
  pos: [9750, 5410],
  size: [225, 0],
  collapsed: true,
  full_height: 30,
};
const CREATED_BOUNDS: [number, number, number, number] = [9720, 5340, 285, 100];

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} not found in buildPanelToolDefs()`);
  return def;
}

function jsonResult(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function parseResult(res: ToolResult): Record<string, unknown> {
  const text = res.content.find((c) => c.type === "text")?.text;
  return JSON.parse(text ?? "{}") as Record<string, unknown>;
}

/**
 * LiteGraph containsCentre of the panel's forceCollapsed footprint
 * (`wantedNodeArea(node, true)` in group-geometry.js): zero-height size falls
 * back to 100, title band sits above pos. Max edge exclusive.
 */
function panelContainsCentre(
  bounds: [number, number, number, number],
  node: QueriedNodeGeom,
): boolean {
  const w = node.size[0] > 0 ? node.size[0] : 200;
  const h = node.size[1] > 0 ? node.size[1] : DEFAULT_BODY;
  const cx = node.pos[0] + w / 2;
  const cy = node.pos[1] - TITLE + (h + TITLE) / 2;
  const [gx, gy, gw, gh] = bounds;
  return cx >= gx && cx < gx + gw && cy >= gy && cy < gy + gh;
}

function asQuad(v: unknown): [number, number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const q: [number, number, number, number] = [Number(v[0]), Number(v[1]), Number(v[2]), Number(v[3])];
  return q.every(Number.isFinite) ? q : null;
}

describe("#1877 collapsed node membership (panel_create_group)", () => {
  it("the reporter's auto-fit box covers the origin and excludes the membership centre", () => {
    expect(nodePosInsideGroupBounds(NODE_81.pos, CREATED_BOUNDS)).toBe(true);
    expect(panelContainsCentre(CREATED_BOUNDS, NODE_81)).toBe(false);
  });

  it("expanding those bounds makes the same centre a member", () => {
    const expanded = expandGroupBoundsForMembership(CREATED_BOUNDS, [NODE_81]);
    expect(panelContainsCentre(expanded, NODE_81)).toBe(true);
    expect(nodePosInsideGroupBounds(NODE_81.pos, expanded)).toBe(true);
  });

  it("panel_create_group includes the requested collapsed node after the empty create", async () => {
    const calls: Forwarded[] = [];
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_create_group") {
          return jsonResult({
            group: {
              id: 13,
              title: "Group",
              bounding: CREATED_BOUNDS,
              node_count: 0,
              node_ids: [],
              requested_node_ids: [81],
              missing_node_ids: [81],
              warning: "group membership is geometric: misses 1 requested node(s)",
            },
          });
        }
        if (cmd.cmd === "graph_query") {
          return jsonResult({
            total: 1,
            matched: 1,
            shown: 1,
            text:
              `1 match(es) of 1 in scope (viewing: 1 nodes)\n` +
              JSON.stringify({
                id: 81,
                type: "VAEDecode",
                pos: NODE_81.pos,
                size: NODE_81.size,
                full_height: NODE_81.full_height,
                collapsed: true,
              }),
          });
        }
        if (cmd.cmd === "graph_edit_group") {
          const bounds = asQuad(cmd.bounds);
          const included = bounds ? panelContainsCentre(bounds, NODE_81) : false;
          return jsonResult({
            group: {
              id: 13,
              title: "Group",
              bounding: bounds ?? CREATED_BOUNDS,
              node_count: included ? 1 : 0,
              node_ids: included ? [81] : [],
            },
          });
        }
        return jsonResult({ ok: true });
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "test-tab",
    };

    const res = await defByName("panel_create_group").handler({ node_ids: [81] }, ctx);
    expect(res.isError).toBeFalsy();
    expect(calls.map((c) => c.cmd)).toEqual(["graph_create_group", "graph_query", "graph_edit_group"]);

    const payload = parseResult(res);
    const group = payload.group as Record<string, unknown>;
    expect(group.node_ids).toEqual([81]);
    expect(group.node_count).toBe(1);
    expect(group.missing_node_ids).toBeUndefined();
    expect(asQuad(group.bounding)).not.toEqual(CREATED_BOUNDS);
  });

  it("does not drag the box to a requested node whose origin is outside it", async () => {
    const far: QueriedNodeGeom = { id: 9, pos: [0, 0], size: [210, 80] };
    const calls: Forwarded[] = [];
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_create_group") {
          return jsonResult({
            group: {
              id: 2,
              bounding: CREATED_BOUNDS,
              node_count: 0,
              node_ids: [],
              missing_node_ids: [9],
            },
          });
        }
        if (cmd.cmd === "graph_query") {
          return jsonResult({
            text: `1 match(es)\n${JSON.stringify({ id: 9, pos: far.pos, size: far.size })}`,
          });
        }
        return jsonResult({ ok: true });
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "test-tab",
    };

    const res = await defByName("panel_create_group").handler({ node_ids: [9] }, ctx);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_create_group", "graph_query"]);
    const group = (parseResult(res).group as Record<string, unknown>) ?? {};
    expect(group.missing_node_ids).toEqual([9]);
    expect(group.node_ids).toEqual([]);
  });

  it("does not edit when requested members already fit their live size", async () => {
    const calls: Forwarded[] = [];
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_create_group") {
          return jsonResult({
            group: { id: 1, bounding: [0, 0, 400, 300], node_count: 2, node_ids: [1, 2] },
          });
        }
        if (cmd.cmd === "graph_query") {
          return jsonResult({
            text:
              `2 match(es)\n` +
              JSON.stringify({ id: 1, type: "KSampler", pos: [20, 20], size: [210, 80] }) +
              "\n" +
              JSON.stringify({ id: 2, type: "CLIPTextEncode", pos: [20, 140], size: [210, 80] }),
          });
        }
        return jsonResult({ ok: true });
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "test-tab",
    };
    const res = await defByName("panel_create_group").handler({ node_ids: [1, 2] }, ctx);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_create_group", "graph_query"]);
    expect((parseResult(res).group as Record<string, unknown>).node_ids).toEqual([1, 2]);
  });

  it("leaves the original missing report if the query fails", async () => {
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        if (cmd.cmd === "graph_create_group") {
          return jsonResult({
            group: {
              id: 13,
              bounding: CREATED_BOUNDS,
              node_count: 0,
              node_ids: [],
              missing_node_ids: [81],
            },
          });
        }
        return { isError: true, content: [{ type: "text", text: "Error: panel went away" }] };
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "test-tab",
    };
    const res = await defByName("panel_create_group").handler({ node_ids: [81] }, ctx);
    expect(res.isError).toBeFalsy();
    expect((parseResult(res).group as Record<string, unknown>).missing_node_ids).toEqual([81]);
  });
});
