// Slot type-compatibility rules — the ONE shared rule set that both the
// `dsl_to_workflow` advisory wiring warnings (server-side) and the panel's
// `panel_connect` auto-match resolver reason about, so the two never disagree.
//
// The panel (comfyui-mcp-panel) is served as live JS and cannot import this TS
// module, so it carries its OWN hand-kept JS copy of these rules (see the
// paired repo's `connect-auto-match` resolver / fl_api.js). If you change the
// rules here, mirror them there — both sides carry this cross-reference.
//
// Rules:
//   - exact match (same type name) is compatible and ranks highest;
//   - `*` wildcard is compatible with anything but ranks LAST;
//   - COMBO / enum array types are compatible only when identical;
//   - comma-joined multi-types ("IMAGE,MASK") match if ANY segment matches.

export type SlotType = string | string[];

export const RANK_INCOMPATIBLE = 0;
export const RANK_WILDCARD = 1;
export const RANK_EXACT = 2;

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function segments(t: string): string[] {
  return t
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Rank how well an `output` slot type feeds an `input` slot type.
 * Higher is a better match; `RANK_INCOMPATIBLE` (0) means the link is invalid.
 */
export function compatibilityRank(output: SlotType, input: SlotType): number {
  // COMBO / enum arrays only accept an identical array — never a plain type.
  if (Array.isArray(output) || Array.isArray(input)) {
    return Array.isArray(output) && Array.isArray(input) && arraysEqual(output, input)
      ? RANK_EXACT
      : RANK_INCOMPATIBLE;
  }

  // Wildcards accept anything but must rank below every concrete match.
  if (output === "*" || input === "*") return RANK_WILDCARD;

  // Exact / comma multi-type: any shared segment is an exact-type match.
  for (const o of segments(output)) {
    for (const i of segments(input)) {
      if (o === i) return RANK_EXACT;
    }
  }
  return RANK_INCOMPATIBLE;
}

export function isTypeCompatible(output: SlotType, input: SlotType): boolean {
  return compatibilityRank(output, input) > RANK_INCOMPATIBLE;
}
