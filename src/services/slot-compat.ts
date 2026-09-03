// Slot type-compatibility rules — the ONE shared rule set that both the
// `visualize_workflow (action:"from_dsl")` advisory wiring warnings (server-side) and the panel's
// `panel_connect` auto-match resolver reason about, so the two never disagree.
//
// The panel (comfyui-mcp-panel) is served as live JS and cannot import this TS
// module, so it carries its OWN hand-kept JS copy of these rules (see the
// paired repo's `connect-auto-match` resolver / fl_api.js). If you change the
// rules here, mirror them there — both sides carry this cross-reference.
//
// Rules:
//   - exact match (same type name) is compatible and ranks highest;
//   - `*` wildcard is compatible with anything (including another `*`) but ranks LAST;
//   - COMBO / enum array types are compatible only when identical;
//   - comma-joined multi-types ("IMAGE,MASK") match if ANY segment matches;
//   - widget-spec arrays `["INT", { min, max }]` normalize to INT before ranking (#2778).

export type SlotType = string | string[];

export const RANK_INCOMPATIBLE = 0;
export const RANK_WILDCARD = 1;
export const RANK_EXACT = 2;

const SCALAR_SOCKET_TYPES = new Set(["INT", "FLOAT", "BOOLEAN", "STRING"]);

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function segments(t: string): string[] {
  return t
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isConstraintBag(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True when every comma-segment is a scalar socket (INT / FLOAT / BOOLEAN / STRING). */
function scalarSocketName(value: string): string | null {
  const parts = segments(value);
  if (parts.length === 0) return null;
  for (const part of parts) {
    if (!SCALAR_SOCKET_TYPES.has(part.toUpperCase())) return null;
  }
  return parts.join(",");
}

function comboStrings(type: unknown[]): string[] | null {
  const combo: string[] = [];
  for (const item of type) {
    if (typeof item !== "string") return null;
    combo.push(item);
  }
  return combo;
}

/**
 * Reduce a live / object_info slot type to the value compatibility ranks.
 *
 * Exposed subgraph rails (and some custom-node sockets) still carry the
 * widget spec `["INT", { min, max, step }]` as the slot type. That is not a
 * COMBO option list. The declared socket name is what LiteGraph wires.
 * `Array.toString()` of that spec is `INT,[object Object]` — strip it.
 * COMBO option arrays stay arrays. (artokun/comfyui-mcp#2778)
 */
export function normalizeSlotType(type: unknown): SlotType {
  if (typeof type === "string") {
    const stripped = type.replace(/,\[object Object\]/gi, "").trim();
    return scalarSocketName(stripped) ?? type;
  }
  if (!Array.isArray(type) || type.length === 0) {
    return typeof type === "number" ? String(type) : [];
  }
  const head = type[0];
  if (typeof head === "string") {
    const scalar = scalarSocketName(head);
    if (scalar) {
      if (type.length === 1) return scalar;
      if (type.length === 2 && isConstraintBag(type[1])) return scalar;
    }
  }
  return comboStrings(type) ?? [];
}

/**
 * Rank how well an `output` slot type feeds an `input` slot type.
 * Higher is a better match; `RANK_INCOMPATIBLE` (0) means the link is invalid.
 */
export function compatibilityRank(output: unknown, input: unknown): number {
  const out = normalizeSlotType(output);
  const inp = normalizeSlotType(input);
  // COMBO / enum arrays only accept an identical array — never a plain type.
  if (Array.isArray(out) || Array.isArray(inp)) {
    return Array.isArray(out) && Array.isArray(inp) && arraysEqual(out, inp)
      ? RANK_EXACT
      : RANK_INCOMPATIBLE;
  }

  // Wildcards accept anything — including another LiteGraph wildcard — but
  // must rank below every concrete match. `*` → `*` is a valid pairing
  // (Reroute, PrimitiveNode "connect to widget input", LogicIF when_true /
  // when_false); the panel's "no input accepts type *" tail is not a
  // compatibility verdict for that pair (artokun/comfyui-mcp#2542).
  if (out === "*" || inp === "*") return RANK_WILDCARD;

  // Exact / comma multi-type: any shared segment is an exact-type match.
  for (const o of segments(out)) {
    for (const i of segments(inp)) {
      if (o === i) return RANK_EXACT;
    }
  }
  return RANK_INCOMPATIBLE;
}

export function isTypeCompatible(output: unknown, input: unknown): boolean {
  return compatibilityRank(output, input) > RANK_INCOMPATIBLE;
}

/** True when a slot type is, or contains, LiteGraph's `*` wildcard segment. */
export function isLiteGraphWildcardType(type: SlotType | null | undefined): boolean {
  return typeof type === "string" && segments(type).includes("*");
}
