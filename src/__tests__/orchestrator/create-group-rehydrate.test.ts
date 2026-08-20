// #1921 — panel_create_group auto-bounds from compact SaveImage size do not
// survive widget rehydration. The shipped path is panel_create_group →
// graph_create_group; the handler now expands the box (graph_edit_group) so a
// requested SaveImage whose origin is already inside stays a member after its
// body grows from [270,58] to [270,326].
//
// The mock panel here applies LiteGraph's containsCentre rule independently
// against the REHYDRATED size (boundingRect = pos with a 30px title above).
// It does not import the expander under test.

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

/** Reporter's auto-fit box around nodes 5, 6, 7 before SaveImage rehydrate. */
const CREATED_BOUNDS: [number, number, number, number] = [1090, -30, 580, 404];
const COMPACT: [number, number] = [270, 58];
const REHYDRATED: [number, number] = [270, 326];

const NODE_5: QueriedNodeGeom = {
  id: 5,
  type: "SaveImage",
  pos: [1120, 40],
  size: COMPACT,
};
const NODE_6: QueriedNodeGeom = {
  id: 6,
  type: "SaveImage",
  pos: [1370, 40],
  size: COMPACT,
};
const NODE_7: QueriedNodeGeom = {
  id: 7,
  type: "SaveImage",
  pos: [1370, 250],
  size: COMPACT,
};

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

function asQuad(v: unknown): [number, number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const q: [number, number, number, number] = [Number(v[0]), Number(v[1]), Number(v[2]), Number(v[3])];
  return q.every(Number.isFinite) ? q : null;
}

/**
 * LiteGraph containsCentre of boundingRect (title bar above pos, max edge exclusive).
 * `size` is the body used for membership — compact at create, rehydrated after reopen.
 */
function panelContainsCentre(
  bounds: [number, number, number, number],
  node: QueriedNodeGeom,
  size: [number, number],
): boolean {
  const w = size[0] > 0 ? size[0] : 200;
  const h = size[1] > 0 ? size[1] : 100;
  const cx = node.pos[0] + w / 2;
  const cy = node.pos[1] - TITLE + (h + TITLE) / 2;
  const [gx, gy, gw, gh] = bounds;
  return cx >= gx && cx < gx + gw && cy >= gy && cy < gy + gh;
}

function detailLine(node: QueriedNodeGeom): string {
  return JSON.stringify({
    id: node.id,
    type: node.type,
    pos: node.pos,
    size: node.size,
  });
}

describe("#1921 SaveImage auto-bounds survive rehydration (panel_create_group)", () => {
  it("the reporter's compact box contains node 7 now and excludes it after rehydrate", () => {
    expect(nodePosInsideGroupBounds(NODE_7.pos, CREATED_BOUNDS)).toBe(true);
    expect(panelContainsCentre(CREATED_BOUNDS, NODE_7, COMPACT)).toBe(true);
    expect(panelContainsCentre(CREATED_BOUNDS, NODE_7, REHYDRATED)).toBe(false);
    expect(panelContainsCentre(CREATED_BOUNDS, NODE_5, REHYDRATED)).toBe(true);
    expect(panelContainsCentre(CREATED_BOUNDS, NODE_6, REHYDRATED)).toBe(true);
  });

  it("expanding those bounds keeps the rehydrated centre a member", () => {
    const expanded = expandGroupBoundsForMembership(CREATED_BOUNDS, [NODE_5, NODE_6, NODE_7]);
    expect(panelContainsCentre(expanded, NODE_7, REHYDRATED)).toBe(true);
    expect(panelContainsCentre(expanded, NODE_5, REHYDRATED)).toBe(true);
    expect(panelContainsCentre(expanded, NODE_6, REHYDRATED)).toBe(true);
    expect(nodePosInsideGroupBounds(NODE_7.pos, expanded)).toBe(true);
  });

  it("panel_create_group persists bounds that still contain node 7 after SaveImage rehydrate", async () => {
    const calls: Forwarded[] = [];
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_create_group") {
          return jsonResult({
            group: {
              id: 3,
              title: "Group",
              bounding: CREATED_BOUNDS,
              node_count: 3,
              node_ids: [5, 6, 7],
              requested_node_ids: [5, 6, 7],
            },
          });
        }
        if (cmd.cmd === "graph_query") {
          return jsonResult({
            total: 3,
            matched: 3,
            shown: 3,
            text:
              `3 match(es) of 3 in scope (viewing: 3 nodes)\n` +
              `${detailLine(NODE_5)}\n${detailLine(NODE_6)}\n${detailLine(NODE_7)}`,
          });
        }
        if (cmd.cmd === "graph_edit_group") {
          const bounds = asQuad(cmd.bounds);
          const members = [NODE_5, NODE_6, NODE_7].filter((n) =>
            bounds ? panelContainsCentre(bounds, n, REHYDRATED) : false,
          );
          return jsonResult({
            group: {
              id: 3,
              title: "Group",
              bounding: bounds ?? CREATED_BOUNDS,
              node_count: members.length,
              node_ids: members.map((n) => n.id),
            },
          });
        }
        return jsonResult({ ok: true });
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "test-tab",
    };

    const res = await defByName("panel_create_group").handler({ node_ids: [5, 6, 7] }, ctx);
    expect(res.isError).toBeFalsy();
    expect(calls.map((c) => c.cmd)).toEqual(["graph_create_group", "graph_query", "graph_edit_group"]);

    const payload = parseResult(res);
    const group = payload.group as Record<string, unknown>;
    expect(group.node_ids).toEqual([5, 6, 7]);
    expect(group.node_count).toBe(3);
    expect(group.missing_node_ids).toBeUndefined();
    const persisted = asQuad(group.bounding);
    expect(persisted).not.toEqual(CREATED_BOUNDS);
    expect(persisted && panelContainsCentre(persisted, NODE_7, REHYDRATED)).toBe(true);
  });

  it("does not grow a collapsed SaveImage to preview height", async () => {
    const collapsed: QueriedNodeGeom = {
      id: 7,
      type: "SaveImage",
      pos: NODE_7.pos,
      size: [270, 0],
      collapsed: true,
      full_height: 30,
    };
    const calls: Forwarded[] = [];
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_create_group") {
          return jsonResult({
            group: {
              id: 3,
              bounding: CREATED_BOUNDS,
              node_count: 1,
              node_ids: [7],
            },
          });
        }
        if (cmd.cmd === "graph_query") {
          return jsonResult({
            text:
              `1 match(es)\n` +
              JSON.stringify({
                id: 7,
                type: "SaveImage",
                pos: collapsed.pos,
                size: collapsed.size,
                collapsed: true,
                full_height: 30,
              }),
          });
        }
        return jsonResult({ ok: true });
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "test-tab",
    };

    const res = await defByName("panel_create_group").handler({ node_ids: [7] }, ctx);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_create_group", "graph_query"]);
    expect(asQuad((parseResult(res).group as Record<string, unknown>).bounding)).toEqual(CREATED_BOUNDS);
  });
});
