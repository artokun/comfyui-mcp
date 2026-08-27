/**
 * #2437 — remaining host links after `graph_unexpose_subgraph_input/output`.
 *
 * Host SubgraphNode slots are positional and lockstep with `subgraph.inputs` /
 * `subgraph.outputs`. The panel executor counts host links at the OLD index,
 * calls `removeInput`/`removeOutput`, and reports. It does not re-point the
 * survivors. Later host slots then look connected in `panel_query_graph` /
 * `panel_graph_outline` (same positional lens) and missing at queue time
 * (`graphToPrompt` resolves the boundary differently).
 *
 * A post-removal snapshot of `node.inputs[i].link` cannot see this: it shares
 * the mutation's dependency and agrees with the reader. This note is a priori
 * from a landed `removed` object, not a detected divergence. The repair that
 * re-resolves the index is disconnect + reconnect remaining later host links
 * BY NAME. The reindex itself is panel-side (artokun/comfyui-mcp-panel#1969)
 * and must not be improvised here: panel#668 saw a SubgraphNode disconnect
 * cascade into deleting unrelated nodes.
 */

/** Later rail-slot names that sat AFTER the removed index (already shifted). */
export type UnexposeLaterSlots = readonly string[] | undefined;

function removedRecord(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const removed = (payload as Record<string, unknown>).removed;
  if (!removed || typeof removed !== "object" || Array.isArray(removed)) return null;
  return removed as Record<string, unknown>;
}

function landedSlot(removed: Record<string, unknown>): number | null {
  if (removed.side !== "input" && removed.side !== "output") return null;
  const slot = removed.slot;
  return typeof slot === "number" && Number.isInteger(slot) && slot >= 0 ? slot : null;
}

/**
 * True when the panel reported a landed unexpose (`removed.side` + integer
 * `removed.slot`). A refusal has no `removed` and produces no note.
 */
export function isLandedUnexpose(payload: unknown): boolean {
  const removed = removedRecord(payload);
  return removed != null && landedSlot(removed) != null;
}

/**
 * The agent-facing repair for a landed unexpose whose remaining later host
 * links were not reindexed. `null` when there is nothing to disclose:
 *  - not a landed `removed` object (refusal / unparseable);
 *  - caller proved there are no later slots (`laterSlotNames` is `[]`).
 *
 * An UNKNOWN later list still produces the note: the cheap positional
 * connectedness check cannot prove the survivors are valid, and skipping the
 * note on "we did not look" is how the reporter queued a broken graph.
 */
export function unexposeHostLinkShiftNote(
  payload: unknown,
  laterSlotNames?: UnexposeLaterSlots,
): string | null {
  const removed = removedRecord(payload);
  const slot = removed ? landedSlot(removed) : null;
  if (removed == null || slot == null) return null;
  if (laterSlotNames && laterSlotNames.length === 0) return null;

  const side = removed.side === "output" ? "output" : "input";
  const name = typeof removed.name === "string" && removed.name ? removed.name : "(unnamed)";
  const named =
    laterSlotNames && laterSlotNames.length > 0
      ? ` Remaining later host ${side} slots that shifted: ${laterSlotNames.map((s) => JSON.stringify(s)).join(", ")}.`
      : "";

  return (
    `Host links on remaining later boundary ${side} slots were not reindexed after removing ` +
    `"${name}" at index ${slot} (artokun/comfyui-mcp#2437). Host SubgraphNode slots are ` +
    `positional and lockstep with the rail; nothing in the panel executor re-points the ` +
    `survivors. panel_query_graph and panel_graph_outline may still show those host links ` +
    `as connected — they read the same positional array — but queue-time serialization ` +
    `does not, so panel_run can fail with Required input is missing.` +
    named +
    ` Do not trust that connectedness. Repair: panel_exit_subgraph, then disconnect and ` +
    `reconnect each remaining later host link by NAME (not index); reconnecting by name ` +
    `re-resolves the index. Then re-enter if you still need the interior.`
  );
}
