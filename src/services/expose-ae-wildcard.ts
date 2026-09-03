/**
 * #2493 — `panel_expose_subgraph_input` cannot expose Anything Everywhere?'s
 * wildcard source after Convert to Subgraph.
 *
 * The panel's `resolveSlot` matches input `.name` only. After conversion the
 * live LiteGraph array still carries the frontend wildcard (type `*`, display
 * label / localized_name "anything") while the name lookup lists widget sockets
 * such as `group_regex`. `panel_graph_outline` shows `[renamed "anything"]`;
 * `to_input:"anything"` is refused with `available: group_regex`.
 *
 * This module maps the requested name onto the LIVE slot array so the handler
 * can retry with an address `resolveSlot` already accepts. A STRING widget
 * socket is never chosen as a stand-in for the virtual bus. Index retry is
 * refused when the live names and the refusal's available names disagree —
 * those are different arrays, and guessing an index would expose the wrong slot.
 */

export const AE_WILDCARD_NODE_TYPES = new Set([
  "Anything Everywhere",
  "Anything Everywhere?",
  "Anything Everywhere3",
]);

const AE_WILDCARD_NAME_RE = /^anything[23]?$/i;

const MISSING_INPUT_SLOT_RE = /No input slot named "([^"]+)" \(available: ([^)]*)\)/;

export type LiveInputSlot = {
  slot: number;
  name: string | null;
  label: string | null;
  localized_name: string | null;
  type: string | null;
};

export type LiveExposeNode = {
  id: string;
  type: string | null;
  inputs: LiveInputSlot[];
};

export type MissingInputSlotRefusal = {
  requested: string;
  available: string[];
};

export type LiveSlotRetry = {
  to_input: string;
  via: "label" | "wildcard";
  slot: number;
  name: string;
};

type ToolResultLike = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function lower(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value.toLowerCase();
}

function slotType(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function isAeWildcardName(name: string): boolean {
  return AE_WILDCARD_NAME_RE.test(name);
}

export function isAeWildcardNodeType(type: string | null | undefined): boolean {
  return typeof type === "string" && AE_WILDCARD_NODE_TYPES.has(type);
}

export function isWildcardSlotType(type: string | null | undefined): boolean {
  return type === "*";
}

export function missingInputSlotRefusal(text: string): MissingInputSlotRefusal | null {
  const match = MISSING_INPUT_SLOT_RE.exec(text);
  if (!match) return null;
  const requested = match[1];
  const raw = match[2]?.trim() ?? "";
  if (!requested) return null;
  const available =
    raw === "" || raw.toLowerCase() === "none"
      ? []
      : raw
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part !== "");
  return { requested, available };
}

function queryNodeRecords(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((entry) => {
      const rec = asRecord(entry);
      return rec ? [rec] : [];
    });
  }
  const rec = asRecord(payload);
  if (!rec) return [];
  if (Array.isArray(rec.nodes)) {
    return rec.nodes.flatMap((entry) => {
      const node = asRecord(entry);
      return node ? [node] : [];
    });
  }
  if (typeof rec.text === "string") {
    const rows: Record<string, unknown>[] = [];
    for (const line of rec.text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const row = asRecord(JSON.parse(trimmed) as unknown);
        if (row) rows.push(row);
      } catch {
        /* skip a non-JSON detail line */
      }
    }
    if (rows.length) return rows;
  }
  if (rec.id != null && (rec.inputs !== undefined || rec.type !== undefined)) return [rec];
  return [];
}

function liveInputFromRecord(entry: unknown, index: number): LiveInputSlot | null {
  const rec = asRecord(entry);
  if (!rec) return null;
  const rawSlot = rec.slot;
  const slot =
    typeof rawSlot === "number" && Number.isInteger(rawSlot) && rawSlot >= 0 ? rawSlot : index;
  return {
    slot,
    name: typeof rec.name === "string" && rec.name ? rec.name : null,
    label: typeof rec.label === "string" && rec.label ? rec.label : null,
    localized_name:
      typeof rec.localized_name === "string" && rec.localized_name ? rec.localized_name : null,
    type: slotType(rec.type),
  };
}

export function liveExposeNodeFromQuery(payload: unknown, nodeId: unknown): LiveExposeNode | null {
  if (nodeId == null) return null;
  const wanted = String(nodeId);
  for (const rec of queryNodeRecords(payload)) {
    if (rec.id == null || String(rec.id) !== wanted) continue;
    const rawInputs = rec.inputs;
    const inputs: LiveInputSlot[] = [];
    if (Array.isArray(rawInputs)) {
      for (let i = 0; i < rawInputs.length; i++) {
        const slot = liveInputFromRecord(rawInputs[i], i);
        if (slot) inputs.push(slot);
      }
    }
    return {
      id: wanted,
      type: typeof rec.type === "string" && rec.type ? rec.type : null,
      inputs,
    };
  }
  return null;
}

function nameSet(names: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const name of names) {
    const key = lower(name);
    if (key) out.add(key);
  }
  return out;
}

/** True when the refusal's available names are the live slot names — same array. */
export function liveNamesMatchAvailable(
  available: readonly string[],
  inputs: readonly LiveInputSlot[],
): boolean {
  const avail = nameSet(available);
  if (avail.size === 0) return false;
  const live = nameSet(inputs.map((slot) => slot.name ?? ""));
  if (avail.size !== live.size) return false;
  for (const name of avail) if (!live.has(name)) return false;
  return true;
}

function uniqueSlot(hits: LiveInputSlot[]): LiveInputSlot | null {
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

function displayKeys(slot: LiveInputSlot): string[] {
  const keys = [slot.label, slot.localized_name];
  return keys.flatMap((key) => {
    const lowered = lower(key);
    return lowered ? [lowered] : [];
  });
}

export function resolveExposeInputAgainstLiveSlots(opts: {
  requested: string;
  available: readonly string[];
  nodeType: string | null;
  inputs: readonly LiveInputSlot[];
}): LiveSlotRetry | null {
  const requested = opts.requested.trim();
  const wanted = lower(requested);
  if (!wanted) return null;
  if (!liveNamesMatchAvailable(opts.available, opts.inputs)) return null;

  const wildcardRequest = isAeWildcardName(requested);
  const labelHits = opts.inputs.filter((slot) => displayKeys(slot).includes(wanted));
  const labelHit = uniqueSlot(labelHits);
  if (labelHit && labelHit.name) {
    if (wildcardRequest && !isWildcardSlotType(labelHit.type)) return null;
    return { to_input: labelHit.name, via: "label", slot: labelHit.slot, name: labelHit.name };
  }

  if (!wildcardRequest) return null;
  if (opts.nodeType != null && !isAeWildcardNodeType(opts.nodeType)) return null;

  const starHits = opts.inputs.filter((slot) => isWildcardSlotType(slot.type) && slot.name);
  const namedStar = uniqueSlot(
    starHits.filter((slot) => lower(slot.name) === wanted || displayKeys(slot).includes(wanted)),
  );
  const star = namedStar ?? uniqueSlot(starHits);
  if (!star || !star.name) return null;
  return { to_input: star.name, via: "wildcard", slot: star.slot, name: star.name };
}

export function extraLiveWildcardIndexNote(
  requested: string,
  available: readonly string[],
  node: LiveExposeNode | null,
): string | null {
  if (!node || !isAeWildcardName(requested)) return null;
  if (node.type != null && !isAeWildcardNodeType(node.type)) return null;
  if (liveNamesMatchAvailable(available, node.inputs)) return null;
  const wanted = lower(requested);
  if (!wanted) return null;
  const starHits = node.inputs.filter((slot) => isWildcardSlotType(slot.type));
  const named = starHits.filter(
    (slot) => lower(slot.name) === wanted || displayKeys(slot).includes(wanted),
  );
  const hit = uniqueSlot(named.length ? named : starHits);
  if (!hit) return null;
  const address = hit.name ? `"${hit.name}"` : `index ${hit.slot}`;
  return (
    `The live LiteGraph node ${node.id} (${node.type ?? "unknown type"}) still has a wildcard \`*\` ` +
    `input at slot ${hit.slot} (${address}), but the panel's name lookup only listed ` +
    `${available.length ? available.map((s) => JSON.stringify(s)).join(", ") : "no names"} ` +
    `(artokun/comfyui-mcp#2493). Retry panel_expose_subgraph_input with to_input:${hit.slot} ` +
    `(the live index). If that is refused as out of range, Convert to Subgraph dropped the ` +
    `frontend wildcard from the array the panel mutates — re-add Anything Everywhere? inside ` +
    `the subgraph so the live \`anything\` socket exists.`
  );
}

export function missingAeWildcardNote(
  requested: string,
  available: readonly string[],
  node: LiveExposeNode | null,
): string | null {
  if (!isAeWildcardName(requested)) return null;
  if (node?.type != null && !isAeWildcardNodeType(node.type)) return null;
  if (node && node.inputs.some((slot) => isWildcardSlotType(slot.type))) return null;
  const where = node
    ? `live node ${node.id} (${node.type ?? "unknown type"})`
    : "the interior node";
  const listed = available.length
    ? available.map((s) => JSON.stringify(s)).join(", ")
    : "none";
  return (
    `${where} has no wildcard \`*\` input after subgraph conversion (artokun/comfyui-mcp#2493). ` +
    `panel_graph_outline's [renamed "${requested}"] is a display label, not an addressable bus socket. ` +
    `The panel's available slot(s) are widget sockets (${listed}), not the Anything Everywhere? source. ` +
    `Re-add the node inside the subgraph so the live LiteGraph \`anything\` socket exists, then expose ` +
    `that slot from panel_query_graph (name, label, or index).`
  );
}

function toolText(res: ToolResultLike): string {
  return res.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

function parseJsonPayload(res: ToolResultLike) {
  if (res.isError) return null;
  const text = res.content.find((c) => c.type === "text")?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function withNote<T extends ToolResultLike>(res: T, note: string | null): T {
  if (!note) return res;
  return { ...res, content: [...res.content, { type: "text", text: note }] };
}

/**
 * First try the panel's name lookup. On the #2493 missing-name refusal, query
 * the live node and retry with the addressable live slot name when that is
 * unique and safe. Never throws.
 */
export async function retryExposeSubgraphInput<T extends ToolResultLike>(
  args: { to_node_id: unknown; to_input: unknown; name?: unknown },
  call: (cmd: Record<string, unknown>, timeoutMs?: number) => Promise<T>,
): Promise<T> {
  const first = await call(
    {
      cmd: "graph_expose_subgraph_input",
      to_node_id: args.to_node_id,
      to_input: args.to_input,
      name: args.name,
    },
    15000,
  );
  if (!first.isError) return first;
  if (typeof args.to_input === "number") return first;

  const refusal = missingInputSlotRefusal(toolText(first));
  if (!refusal) return first;

  const detail = await call(
    { cmd: "graph_query", ids: [args.to_node_id], fields: "detail", limit: 1 },
    8000,
  );
  const node = liveExposeNodeFromQuery(parseJsonPayload(detail), args.to_node_id);
  const resolved = node
    ? resolveExposeInputAgainstLiveSlots({
        requested: refusal.requested,
        available: refusal.available,
        nodeType: node.type,
        inputs: node.inputs,
      })
    : null;

  if (resolved && lower(resolved.to_input) !== lower(refusal.requested)) {
    const retry = await call(
      {
        cmd: "graph_expose_subgraph_input",
        to_node_id: args.to_node_id,
        to_input: resolved.to_input,
        name: args.name,
      },
      15000,
    );
    if (!retry.isError) {
      return withNote(
        retry,
        `Resolved to_input ${JSON.stringify(args.to_input)} to live slot ` +
          `${JSON.stringify(resolved.to_input)} (index ${resolved.slot}, via ${resolved.via}) ` +
          `because the panel's name lookup missed the frontend wildcard (artokun/comfyui-mcp#2493).`,
      );
    }
  }

  return withNote(
    first,
    extraLiveWildcardIndexNote(refusal.requested, refusal.available, node) ??
      missingAeWildcardNote(refusal.requested, refusal.available, node),
  );
}
