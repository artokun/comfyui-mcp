/**
 * #1877 — panel_create_group can wrap a collapsed node and still report it
 * missing.
 *
 * The panel sizes the box from live `pos`/`size`. A collapsed node often has
 * `size[1] === 0` (title-chip only), so the box is ~100px tall around the
 * node's origin. Membership then tests the CENTRE of a boundingRect rebuilt
 * with the panel's `finiteExtent` fallback (0 is not a usable height, so the
 * body becomes 100px plus a 30px title). That centre sits a few pixels below
 * the box, so the group is empty even though the node's coordinates are inside.
 *
 * These helpers expand a created group's bounds just enough to contain every
 * membership-plausible centre of a requested node whose origin is already in
 * the box — then the caller writes those bounds with graph_edit_group.
 *
 * Constants match comfyui-mcp-panel `web/js/lib/group-geometry.js`
 * (`COLLAPSED_TITLE_HEIGHT`, `COLLAPSED_PILL_WIDTH`, `finiteExtent` fallbacks)
 * and LiteGraph's containsCentre rule (min edge inclusive, max edge exclusive).
 */

/** The slice of a panel tool result this module reads and rewrites. */
type ToolResultLike = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

export const NODE_TITLE_HEIGHT = 30;
export const COLLAPSED_PILL_WIDTH = 80;
export const DEFAULT_NODE_WIDTH = 200;
export const DEFAULT_NODE_BODY_HEIGHT = 100;

export type GroupQuad = [number, number, number, number];

export type QueriedNodeGeom = {
  id: string | number;
  pos: [number, number];
  size: [number, number];
  collapsed?: boolean;
  full_height?: number;
};

function finiteExtent(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function finiteQuad(v: unknown): GroupQuad | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const q: GroupQuad = [Number(v[0]), Number(v[1]), Number(v[2]), Number(v[3])];
  return q.every(Number.isFinite) ? q : null;
}

export function nodePosInsideGroupBounds(pos: [number, number], bounds: GroupQuad): boolean {
  const [gx, gy, gw, gh] = bounds;
  const [x, y] = pos;
  // Inclusive on every edge: the reporter's "bounds cover the node" is a
  // top-left origin sitting on or inside the box, not a centre test.
  return x >= gx && x <= gx + gw && y >= gy && y <= gy + gh;
}

/**
 * Centres LiteGraph / the panel might use for containsCentre, given only the
 * geometry panel_query_graph actually returns (pos, size, collapsed, full_height).
 */
export function membershipCandidateCenters(node: QueriedNodeGeom): Array<{ x: number; y: number }> {
  const x = node.pos[0];
  const y = node.pos[1];
  const pillW = finiteExtent(node.size[0], COLLAPSED_PILL_WIDTH);
  const fullW = finiteExtent(node.size[0], DEFAULT_NODE_WIDTH);
  const fullH = finiteExtent(node.size[1], DEFAULT_NODE_BODY_HEIGHT);
  const chipH = finiteExtent(node.full_height, NODE_TITLE_HEIGHT);
  return [
    // Collapsed title-chip (syncNodeArea without forceCollapsed).
    { x: x + pillW / 2, y: y - NODE_TITLE_HEIGHT + chipH / 2 },
    // forceCollapsed wantedNodeArea: size[1]===0 falls back to DEFAULT_NODE_BODY_HEIGHT.
    { x: x + fullW / 2, y: y - NODE_TITLE_HEIGHT + (fullH + NODE_TITLE_HEIGHT) / 2 },
    // Raw pos + stored size (degenerate when size[1] is 0 — origin itself).
    { x: x + fullW / 2, y: y + (node.size[1] > 0 ? node.size[1] : 0) / 2 },
  ];
}

/** Grow `bounds` so every point is a containsCentre member (max edge exclusive). */
export function expandBoundsToContainCenters(bounds: GroupQuad, points: Array<{ x: number; y: number }>): GroupQuad {
  let [x, y, w, h] = bounds;
  let x2 = x + w;
  let y2 = y + h;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < x) x = p.x;
    if (p.y < y) y = p.y;
    if (p.x >= x2) x2 = p.x + 1;
    if (p.y >= y2) y2 = p.y + 1;
  }
  return [x, y, x2 - x, y2 - y];
}

export function expandGroupBoundsForMembership(bounds: GroupQuad, nodes: QueriedNodeGeom[]): GroupQuad {
  const points: Array<{ x: number; y: number }> = [];
  for (const n of nodes) {
    if (!nodePosInsideGroupBounds(n.pos, bounds)) continue;
    points.push(...membershipCandidateCenters(n));
  }
  return points.length ? expandBoundsToContainCenters(bounds, points) : bounds;
}

function idKey(id: unknown): string {
  return String(id);
}

export function classifyRequestedMembership(
  requested: Array<string | number>,
  members: Array<string | number>,
): { extra: Array<string | number>; missing: Array<string | number> } {
  const reqKeys = new Set(requested.map(idKey));
  const memberKeys = new Set(members.map(idKey));
  return {
    extra: members.filter((id) => !reqKeys.has(idKey(id))),
    missing: requested.filter((id) => !memberKeys.has(idKey(id))),
  };
}

function asIdList(v: unknown): Array<string | number> {
  if (!Array.isArray(v)) return [];
  return v.filter((id) => typeof id === "number" || typeof id === "string");
}

function parseToolJson(res: ToolResultLike): Record<string, unknown> | null {
  if (!res || res.isError) return null;
  const text = res.content.find((c) => c.type === "text")?.text;
  if (typeof text !== "string") return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function withPayload<T extends ToolResultLike>(res: T, payload: unknown): T {
  const first = res.content[0];
  if (!first || first.type !== "text") return res;
  return {
    ...res,
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }, ...res.content.slice(1)],
  };
}

function groupFromCreateReply(payload: Record<string, unknown>): Record<string, unknown> | null {
  const inner = payload.group;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) return inner as Record<string, unknown>;
  if ("bounding" in payload || "node_ids" in payload) return payload;
  return null;
}

export function parseDetailNodesFromQueryText(text: unknown): QueriedNodeGeom[] {
  if (typeof text !== "string") return [];
  const out: QueriedNodeGeom[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const row = JSON.parse(s) as Record<string, unknown>;
      const id = row.id;
      if (typeof id !== "number" && typeof id !== "string") continue;
      const pos = row.pos;
      const size = row.size;
      if (!Array.isArray(pos) || pos.length < 2 || !Array.isArray(size) || size.length < 2) continue;
      const x = Number(pos[0]);
      const y = Number(pos[1]);
      const w = Number(size[0]);
      const h = Number(size[1]);
      if (![x, y, w, h].every(Number.isFinite)) continue;
      const geom: QueriedNodeGeom = { id, pos: [x, y], size: [w, h] };
      if (row.collapsed === true) geom.collapsed = true;
      if (typeof row.full_height === "number" && Number.isFinite(row.full_height)) {
        geom.full_height = row.full_height;
      }
      out.push(geom);
    } catch {
      /* skip a non-JSON detail line */
    }
  }
  return out;
}

function honestyWarning(extra: number, missing: number): string {
  return (
    "group membership is geometric: the box that wraps the requested nodes " +
    `also captures ${extra} unrelated node(s) (their centre falls inside)` +
    (missing ? ` and misses ${missing} requested node(s)` : "") +
    ". Move the intended nodes into a contiguous region (panel_edit_node / " +
    "panel_auto_layout) before grouping, or edit the group bounds, to get an exact set."
  );
}

function attachHonesty(
  group: Record<string, unknown>,
  requested: Array<string | number>,
): Record<string, unknown> {
  const live = asIdList(group.node_ids);
  const { extra, missing } = classifyRequestedMembership(requested, live);
  const out: Record<string, unknown> = { ...group, requested_node_ids: requested };
  delete out.extra_node_ids;
  delete out.missing_node_ids;
  delete out.warning;
  if (extra.length || missing.length) {
    if (extra.length) out.extra_node_ids = extra;
    if (missing.length) out.missing_node_ids = missing;
    out.warning = honestyWarning(extra.length, missing.length);
  }
  return out;
}

function quadsEqual(a: GroupQuad, b: GroupQuad): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

type Call = (
  cmd: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<ToolResultLike>;

/**
 * After graph_create_group, if requested ids are missing AND their origin sits
 * inside the new box, expand the box so those centres are members and rewrite
 * the reply. Never throws: a failed repair returns the original create result.
 */
export async function includeRequestedCreateGroupMembers<T extends ToolResultLike>(
  created: T,
  requestedIds: unknown,
  call: Call,
): Promise<T> {
  try {
    if (created.isError) return created;
    const requested = asIdList(requestedIds);
    if (!requested.length) return created;
    const payload = parseToolJson(created);
    if (!payload) return created;
    const group = groupFromCreateReply(payload);
    if (!group) return created;
    const bounds = finiteQuad(group.bounding);
    if (!bounds) return created;
    const live = asIdList(group.node_ids);
    const reportedMissing = asIdList(group.missing_node_ids);
    const missing = reportedMissing.length
      ? reportedMissing.filter((id) => requested.some((r) => idKey(r) === idKey(id)))
      : classifyRequestedMembership(requested, live).missing;
    if (!missing.length) return created;

    const query = await call(
      {
        cmd: "graph_query",
        ids: missing,
        fields: "detail",
        limit: Math.min(Math.max(missing.length, 1), 200),
      },
      8000,
    );
    if (query.isError) return created;
    const qPayload = parseToolJson(query);
    const nodes = parseDetailNodesFromQueryText(qPayload?.text).filter((n) =>
      missing.some((id) => idKey(id) === idKey(n.id)),
    );
    const repairable = nodes.filter((n) => nodePosInsideGroupBounds(n.pos, bounds));
    if (!repairable.length) return created;

    const expanded = expandGroupBoundsForMembership(bounds, repairable);
    if (quadsEqual(expanded, bounds)) return created;

    const groupId = group.id;
    if (typeof groupId !== "number" && typeof groupId !== "string") return created;
    const edited = await call({ cmd: "graph_edit_group", group_id: groupId, bounds: expanded }, 15000);
    if (edited.isError) return created;
    const ePayload = parseToolJson(edited);
    if (!ePayload) return created;
    const editedGroup = groupFromCreateReply(ePayload);
    if (!editedGroup) return created;
    return withPayload(created, { ...ePayload, group: attachHonesty(editedGroup, requested) });
  } catch {
    return created;
  }
}
