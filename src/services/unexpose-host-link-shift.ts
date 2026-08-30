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
 * from a landed `removed` object, not a detected divergence — UNLESS the panel
 * reports `removed.host_links_reindexed: true` (panel ≥0.15.120 / #1969), in
 * which case survivors were already re-pointed and the note would be a lie
 * (#2473), OR the removed index was last so no later slot exists to reindex
 * (#2491). The repair that re-resolves the index is disconnect + reconnect
 * remaining later host links BY NAME. The reindex itself is panel-side and
 * must not be improvised here: panel#668 saw a SubgraphNode disconnect
 * cascade into deleting unrelated nodes.
 */

/** Later rail-slot names that sat AFTER the removed index (already shifted). */
export type UnexposeLaterSlots = readonly string[] | undefined;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function removedRecord(payload: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(payload)?.removed);
}

function landedSlot(removed: Record<string, unknown>): number | null {
  if (removed.side !== "input" && removed.side !== "output") return null;
  const slot = removed.slot;
  return typeof slot === "number" && Number.isInteger(slot) && slot >= 0 ? slot : null;
}

function nonNegInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    out.push(item);
  }
  return out;
}

function railSide(removed: Record<string, unknown>): "input" | "output" {
  return removed.side === "output" ? "output" : "input";
}

/**
 * Remaining later slot names from a post-removal `rails` snapshot.
 * After splicing index `removedSlot`, survivors that shifted sit at
 * `index >= removedSlot`. `undefined` when that rail is not in the snapshot.
 */
export function laterSlotsFromRails(
  rails: unknown,
  side: "input" | "output",
  removedSlot: number,
): UnexposeLaterSlots {
  const rail = asRecord(asRecord(rails)?.[side]);
  if (!rail) return undefined;
  const slots = side === "output" ? rail.accepts_inputs : rail.provides_outputs;
  if (!Array.isArray(slots)) return undefined;
  const later: string[] = [];
  for (const [i, entry] of slots.entries()) {
    const rec = asRecord(entry);
    const index = rec ? (nonNegInt(rec.index) ?? i) : i;
    if (index < removedSlot) continue;
    const name = rec && typeof rec.name === "string" && rec.name ? rec.name : `(slot ${index})`;
    later.push(name);
  }
  return later;
}

/**
 * Later-slot evidence already on the unexpose payload. `[]` proves the
 * removed index was last (#2491). `undefined` means the payload did not look.
 */
export function laterSlotsFromUnexposePayload(payload: unknown): UnexposeLaterSlots {
  const removed = removedRecord(payload);
  const slot = removed ? landedSlot(removed) : null;
  if (removed == null || slot == null) return undefined;

  const named = stringArray(removed.later_slots) ?? stringArray(removed.remaining_later_slots);
  if (named !== undefined) return named;

  const remainingCount =
    nonNegInt(removed.remaining_count) ?? nonNegInt(removed.remaining_slot_count);
  if (remainingCount != null && remainingCount <= slot) return [];

  return laterSlotsFromRails(asRecord(payload)?.rails, railSide(removed), slot);
}

/**
 * Combine the unexpose payload with an optional follow-up graph read that
 * carries `rails`. Payload evidence wins; the live rails fill an UNKNOWN list.
 */
export function laterSlotsAfterUnexpose(
  unexposePayload: unknown,
  remainingGraphPayload?: unknown,
): UnexposeLaterSlots {
  const fromPayload = laterSlotsFromUnexposePayload(unexposePayload);
  if (fromPayload !== undefined) return fromPayload;
  const removed = removedRecord(unexposePayload);
  const slot = removed ? landedSlot(removed) : null;
  if (removed == null || slot == null) return undefined;
  return laterSlotsFromRails(asRecord(remainingGraphPayload)?.rails, railSide(removed), slot);
}

/**
 * True when the panel reported a landed unexpose (`removed.side` + integer
 * `removed.slot`). A refusal has no `removed` and produces no note.
 */
export function isLandedUnexpose(payload: unknown): boolean {
  const removed = removedRecord(payload);
  return removed != null && landedSlot(removed) != null;
}

/** True when the panel already re-pointed survivors (#2473 / panel ≥0.15.120). */
export function hostLinksAlreadyReindexed(payload: unknown): boolean {
  return removedRecord(payload)?.host_links_reindexed === true;
}

/**
 * The agent-facing repair for a landed unexpose whose remaining later host
 * links were not reindexed. `null` when there is nothing to disclose:
 *  - not a landed `removed` object (refusal / unparseable);
 *  - panel reported `removed.host_links_reindexed: true` (#2473);
 *  - the removed index was last — no later slot exists to reindex (#2491);
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
  if (removed.host_links_reindexed === true) return null;
  const later =
    laterSlotNames !== undefined ? laterSlotNames : laterSlotsFromUnexposePayload(payload);
  if (later && later.length === 0) return null;

  const side = railSide(removed);
  const name = typeof removed.name === "string" && removed.name ? removed.name : "(unnamed)";
  const named =
    later && later.length > 0
      ? ` Remaining later host ${side} slots that shifted: ${later.map((s) => JSON.stringify(s)).join(", ")}.`
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
