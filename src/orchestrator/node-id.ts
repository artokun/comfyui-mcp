/**
 * #1425 — the wire contract for a node id, including the SUBGRAPH-QUALIFIED shape.
 *
 * #845 made the tools accept back an id they had printed: the graph readers return
 * ids as strings (`"42"`), so `"42"` and `42` both had to mean node 42. That change
 * deliberately stopped short of `"5:12"`:
 *
 *   > a subgraph-qualified id is a real shape in newer ComfyUI, and silently
 *   > truncating it to `5` would target the WRONG node rather than fail. If those
 *   > need supporting, that is a separate, deliberate change to the wire contract.
 *
 * This is that change. Unpacking a subgraph leaves genuine ROOT-level nodes carrying
 * ids like `120:104` and `120:113:78`; the readers list them and render them, and
 * every write tool refused them — 18 of 21 nodes uneditable in the reporter's
 * workflow. So the refusal was not protecting anything by then, it was just the
 * conservative half of a trade whose other half never arrived.
 *
 * The two halves have to move TOGETHER. Widening the pattern alone would send
 * `"263:78"` through `Number.parseInt(…, 10)` and yield `263` — turning a loud
 * refusal into a silent edit of a DIFFERENT node, which is the exact outcome #845
 * refused to risk. So a qualified id is never converted: it stays the string the
 * reader printed, all the way to the panel.
 */

/**
 * A plain integer id, the form the wire has always carried.
 *
 * Exported because one argument needs this shape ON ITS OWN: panel_run's
 * `to_node_id` (#1497). Everything else takes NODE_ID_PATTERN, which admits the
 * qualified form too — but a run-to-node target is resolved by NUMBER all the way
 * down (the panel's findNodeInScopes does `Number(id)`, and its reply reports
 * `ran_to_node: Number(to_node_id)`), so admitting `"120:104"` there would trade a
 * clear schema refusal for a panel-side "node not found" about a node that exists.
 * The shape lives here so the two patterns cannot drift apart.
 */
export const PLAIN_NODE_ID_PATTERN = /^-?\d+$/;

/**
 * A subgraph-qualified id: integer segments joined by colons (`120:104`,
 * `120:113:78`). No depth limit — nesting is arbitrary, and a limit would fail the
 * deep case in exactly the way this fixes the shallow one. Only the FIRST segment
 * may be negative: a leading `-` marks the boundary-rail ids the readers emit, and
 * a `-` inside a path would be a shape nothing produces.
 */
const QUALIFIED = /^-?\d+(?::\d+)+$/;

/**
 * Both spellings in ONE pattern, so it can be handed to `z.string().regex()`.
 *
 * That matters beyond tidiness: `.regex()` puts a `pattern` on the advertised MCP
 * input schema, while `.refine()` renders as a bare `{"type":"string"}` (measured
 * with zod 4's toJSONSchema). Validating through a refine would therefore have told
 * every client LESS about a node id than the old integer-only rule did.
 */
export const NODE_ID_PATTERN = /^-?\d+(?::\d+)*$/;

/** Does this string name a node at all — either spelling? */
export function isNodeIdString(v: string): boolean {
  return NODE_ID_PATTERN.test(v);
}

/** True for the qualified form specifically (`"5:12"`), false for `"5"`. */
export function isQualifiedNodeId(v: string): boolean {
  return QUALIFIED.test(v);
}

/**
 * Normalize an accepted id to what goes on the wire.
 *
 * A plain id becomes the NUMBER the panel has always received, so nothing about
 * the existing surface changes. A qualified id is returned VERBATIM — parsing it
 * is precisely the bug. Callers must therefore treat a node id as `number | string`
 * rather than assuming the number.
 */
export function normalizeNodeId(v: number | string): number | string {
  if (typeof v === "number") return v;
  if (QUALIFIED.test(v)) return v;
  return Number.parseInt(v, 10);
}

/** The message a rejected id gets. Names the qualified shape explicitly, because a
 *  caller holding `263:78` needs to know whether it is unsupported or malformed. */
export const NODE_ID_MESSAGE =
  "a node id must be an integer (e.g. 42) or a subgraph-qualified id (e.g. 120:104)";
