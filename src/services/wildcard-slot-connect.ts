/**
 * #2542 — `panel_connect` can refuse a LiteGraph wildcard (`*`) output onto a
 * wildcard input even though both slots advertise `*` (PrimitiveNode
 * "connect to widget input" → LogicIF.when_true / when_false).
 *
 * The panel's diagnostic tail ("No input on node N accepts type *") is the
 * generic connect-failure sentence, not a compatibility verdict: shared
 * slot-compat ranks `*` → `*` as a valid wildcard pairing, and the primitive
 * is supposed to become typed from the downstream destination.
 *
 * On that refusal, re-read both endpoints and retry once with explicit slot
 * names. A forceInput-only STRING (no widget) is left alone — that is #2536,
 * a lying success that `panel_run` would omit, not a wildcard-to-wildcard
 * link.
 */

import { normalizeNodeId } from "../orchestrator/node-id.js";
import {
  canonicalConnectNodeId,
  type ConnectArgs,
  type GraphCall,
  type ToolResultLike,
} from "./connect-live-graph.js";
import { isLiteGraphWildcardType, isTypeCompatible } from "./slot-compat.js";

const ACCEPTS_TYPE_STAR_RE = /No input on node \S+ accepts type \*/i;
const SLOT_LISTING_RE = /\[(\d+)\] "([^"]*)" \(([^)]*)\)/g;
const OUTPUTS_LINE_RE = /Node \S+ outputs:\s*(.*)$/im;
const INPUTS_LINE_RE = /Node \S+ inputs:\s*(.*)$/im;

const DETAIL_MAX_CHARS = 60000;
const DETAIL_TIMEOUT_MS = 8000;

const FRONTEND_PRIMITIVE_NODE_TYPE = "PrimitiveNode";

export type DiagnosticSlot = {
  index: number;
  name: string;
  type: string;
};

export type WildcardConnectRefusal = {
  outputs: DiagnosticSlot[];
  inputs: DiagnosticSlot[];
};

export type LiveWildcardSlot = {
  name: string;
  slot: number | null;
  type: string | null;
  widget: unknown;
  forceInput: boolean;
};

export type LiveWildcardNode = {
  id: string;
  type: string;
  widgets: Record<string, unknown> | null;
  widgetsKnown: boolean;
  inputs: LiveWildcardSlot[];
  outputs: LiveWildcardSlot[];
};

export type WildcardConnectRetry = {
  from_output: string | number;
  to_input: string | number;
  via: "explicit" | "typed";
  resolvedType: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toolText(res: ToolResultLike): string {
  return res.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

function parseJsonPayload(res: ToolResultLike): Record<string, unknown> | null {
  if (res.isError) return null;
  const text = res.content.find((c) => c.type === "text")?.text;
  if (typeof text !== "string") return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    // unknown-ok: unreadable JSON is not evidence the slots are wildcards.
    return null;
  }
}

function uniqueEndpointIds(fromNodeId: unknown, toNodeId: unknown): Array<number | string> {
  const ids: Array<number | string> = [];
  const seen = new Set<string>();
  for (const value of [fromNodeId, toNodeId]) {
    const canonical = canonicalConnectNodeId(value);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    const wire =
      typeof value === "number" || typeof value === "string" ? normalizeNodeId(value) : canonical;
    ids.push(wire);
  }
  return ids;
}

function slotTypeString(raw: string): string {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(0, slash).trim();
}

function parseSlotListing(line: string | undefined): DiagnosticSlot[] {
  if (!line) return [];
  const slots: DiagnosticSlot[] = [];
  SLOT_LISTING_RE.lastIndex = 0;
  for (const match of line.matchAll(SLOT_LISTING_RE)) {
    const index = Number.parseInt(match[1] ?? "", 10);
    const name = match[2] ?? "";
    const type = slotTypeString(match[3] ?? "");
    if (!Number.isSafeInteger(index) || !type) continue;
    slots.push({ index, name, type });
  }
  return slots;
}

export function isLiteGraphWildcardSlotType(type: string | null | undefined): boolean {
  return isLiteGraphWildcardType(type);
}

export function wildcardToWildcardRefusal(text: string): WildcardConnectRefusal | null {
  if (!ACCEPTS_TYPE_STAR_RE.test(text)) return null;
  const outputs = parseSlotListing(OUTPUTS_LINE_RE.exec(text)?.[1]);
  const inputs = parseSlotListing(INPUTS_LINE_RE.exec(text)?.[1]);
  if (!outputs.some((slot) => isLiteGraphWildcardSlotType(slot.type))) return null;
  if (!inputs.some((slot) => isLiteGraphWildcardSlotType(slot.type))) return null;
  return { outputs, inputs };
}

function slotNameKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

function findNamedSlot(slots: readonly DiagnosticSlot[], ref: unknown): DiagnosticSlot | null {
  const key = slotNameKey(ref);
  if (key) {
    const byName = slots.find((slot) => slot.name.toLowerCase() === key);
    if (byName) return byName;
  }
  if (typeof ref === "number" && Number.isSafeInteger(ref)) {
    return slots.find((slot) => slot.index === ref) ?? slots[ref] ?? null;
  }
  if (typeof ref === "string" && /^-?\d+$/.test(ref.trim())) {
    const index = Number.parseInt(ref.trim(), 10);
    return slots.find((slot) => slot.index === index) ?? slots[index] ?? null;
  }
  return null;
}

function uniqueWildcard(slots: readonly DiagnosticSlot[]): DiagnosticSlot | null {
  const wild = slots.filter((slot) => isLiteGraphWildcardSlotType(slot.type));
  return wild.length === 1 ? (wild[0] ?? null) : null;
}

export function resolveWildcardConnectRetry(
  refusal: WildcardConnectRefusal,
  args: ConnectArgs,
): WildcardConnectRetry | null {
  const out =
    findNamedSlot(refusal.outputs, args.from_output) ?? uniqueWildcard(refusal.outputs);
  if (!out || !isLiteGraphWildcardSlotType(out.type)) return null;

  const inp =
    findNamedSlot(refusal.inputs, args.to_input) ?? uniqueWildcard(refusal.inputs);
  if (!inp || !isLiteGraphWildcardSlotType(inp.type)) return null;

  return {
    from_output: out.name || out.index,
    to_input: inp.name || inp.index,
    via: "explicit",
    resolvedType: null,
  };
}

function isForceInputFlag(value: unknown): boolean {
  return value === true;
}

function parseLiveSlot(raw: unknown, index: number): LiveWildcardSlot | null {
  const rec = asRecord(raw);
  if (!rec || typeof rec.name !== "string" || rec.name.length === 0) return null;
  const slot =
    typeof rec.slot === "number" && Number.isSafeInteger(rec.slot)
      ? rec.slot
      : typeof rec.slot_index === "number" && Number.isSafeInteger(rec.slot_index)
        ? rec.slot_index
        : index;
  const config = asRecord(rec.config) ?? asRecord(rec.options);
  return {
    name: rec.name,
    slot,
    type: typeof rec.type === "string" && rec.type.length > 0 ? rec.type : null,
    widget: rec.widget,
    forceInput:
      isForceInputFlag(rec.forceInput) ||
      isForceInputFlag(rec.force_input) ||
      isForceInputFlag(config?.forceInput) ||
      isForceInputFlag(config?.force_input),
  };
}

function parseLiveSlots(raw: unknown): LiveWildcardSlot[] {
  if (!Array.isArray(raw)) return [];
  const slots: LiveWildcardSlot[] = [];
  for (let i = 0; i < raw.length; i++) {
    const slot = parseLiveSlot(raw[i], i);
    if (slot) slots.push(slot);
  }
  return slots;
}

function parseLiveNode(raw: unknown): LiveWildcardNode | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = canonicalConnectNodeId(rec.id);
  if (!id) return null;
  const type =
    typeof rec.type === "string" && rec.type.length > 0
      ? rec.type
      : typeof rec.class_type === "string" && rec.class_type.length > 0
        ? rec.class_type
        : null;
  if (!type) return null;

  const widgetsKnown = Object.prototype.hasOwnProperty.call(rec, "widgets");
  const widgetsRaw = rec.widgets;
  const widgets =
    widgetsRaw && typeof widgetsRaw === "object" && !Array.isArray(widgetsRaw)
      ? (widgetsRaw as Record<string, unknown>)
      : null;

  return {
    id,
    type,
    widgets: widgetsKnown ? widgets : null,
    widgetsKnown,
    inputs: parseLiveSlots(rec.inputs),
    outputs: parseLiveSlots(rec.outputs),
  };
}

function collectDetailRows(payload: Record<string, unknown>): unknown[] {
  if (Array.isArray(payload.nodes)) return payload.nodes;
  if (typeof payload.text !== "string") return [];
  const rows: unknown[] = [];
  for (const line of payload.text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // unknown-ok: compact/ids lines are not node rows.
    }
  }
  return rows;
}

export function parseLiveWildcardNodes(payload: unknown): LiveWildcardNode[] | null {
  const rec = asRecord(payload);
  if (!rec) return null;
  if (Object.prototype.hasOwnProperty.call(rec, "truncated") && rec.truncated !== false) {
    return null;
  }
  const nodes: LiveWildcardNode[] = [];
  const seen = new Set<string>();
  for (const row of collectDetailRows(rec)) {
    const node = parseLiveNode(row);
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    nodes.push(node);
  }
  return nodes.length > 0 ? nodes : null;
}

export function nodeByConnectId(
  nodes: readonly LiveWildcardNode[],
  nodeId: unknown,
): LiveWildcardNode | null {
  const want = canonicalConnectNodeId(nodeId);
  if (!want) return null;
  return nodes.find((node) => node.id === want) ?? null;
}

function hasSerializableWidgetBinding(slot: LiveWildcardSlot): boolean {
  const widget = slot.widget;
  if (widget === true) return true;
  if (typeof widget === "string") return widget.length > 0;
  const rec = asRecord(widget);
  if (!rec) return false;
  if (typeof rec.name === "string") return rec.name.length > 0;
  return Object.keys(rec).length > 0;
}

/**
 * True when a PrimitiveNode landing here would be the #2536 forceInput-only
 * STRING case (no widget to bake onto). Wildcard `*` is not STRING — leave
 * that pairing eligible for retry.
 */
export function isForceInputOnlyStringSlot(
  slot: LiveWildcardSlot,
  widgets: Record<string, unknown> | null,
  widgetsKnown: boolean,
): boolean {
  if (slot.type !== "STRING") return false;
  if (hasSerializableWidgetBinding(slot)) return false;
  if (slot.forceInput) return true;
  if (!widgetsKnown) return false;
  return !Object.prototype.hasOwnProperty.call(widgets ?? {}, slot.name);
}

function findLiveSlot(
  slots: readonly LiveWildcardSlot[],
  ref: unknown,
): LiveWildcardSlot | null {
  const key = slotNameKey(ref);
  if (key) {
    const byName = slots.find((slot) => slot.name.toLowerCase() === key);
    if (byName) return byName;
  }
  if (typeof ref === "number" && Number.isSafeInteger(ref)) {
    const bySlot = slots.find((slot) => slot.slot === ref);
    if (bySlot) return bySlot;
    return slots[ref] ?? null;
  }
  if (typeof ref === "string" && /^-?\d+$/.test(ref.trim())) {
    const index = Number.parseInt(ref.trim(), 10);
    const bySlot = slots.find((slot) => slot.slot === index);
    if (bySlot) return bySlot;
    return slots[index] ?? null;
  }
  return null;
}

function uniqueLiveWildcard(slots: readonly LiveWildcardSlot[]): LiveWildcardSlot | null {
  const wild = slots.filter((slot) => isLiteGraphWildcardSlotType(slot.type));
  return wild.length === 1 ? (wild[0] ?? null) : null;
}

/** First concrete (non-wildcard) type on the node — the destination typing route. */
export function inferConcreteTypeFromNode(node: LiveWildcardNode): string | null {
  for (const slot of [...node.outputs, ...node.inputs]) {
    if (!slot.type || isLiteGraphWildcardSlotType(slot.type)) continue;
    if (slot.type.toUpperCase() === "COMBO") continue;
    return slot.type;
  }
  return null;
}

export function resolveLiveWildcardRetry(
  source: LiveWildcardNode,
  target: LiveWildcardNode,
  args: ConnectArgs,
  diagnostic: WildcardConnectRetry,
): WildcardConnectRetry | null {
  const out =
    findLiveSlot(source.outputs, diagnostic.from_output) ??
    findLiveSlot(source.outputs, args.from_output) ??
    uniqueLiveWildcard(source.outputs);
  const inp =
    findLiveSlot(target.inputs, diagnostic.to_input) ??
    findLiveSlot(target.inputs, args.to_input) ??
    uniqueLiveWildcard(target.inputs);
  if (!out || !inp) return null;

  if (
    source.type === FRONTEND_PRIMITIVE_NODE_TYPE &&
    isForceInputOnlyStringSlot(inp, target.widgets, target.widgetsKnown)
  ) {
    return null;
  }

  const outType = out.type ?? "*";
  const inType = inp.type ?? "*";
  if (!isTypeCompatible(outType, inType)) return null;

  const outIsWild = isLiteGraphWildcardSlotType(out.type);
  const inIsWild = isLiteGraphWildcardSlotType(inp.type);
  if (!outIsWild && !inIsWild) return null;

  const typedIn = inIsWild ? null : inp.type;
  return {
    from_output: out.name || diagnostic.from_output,
    to_input: inp.name || diagnostic.to_input,
    via: typedIn ? "typed" : "explicit",
    resolvedType: typedIn ?? inferConcreteTypeFromNode(target),
  };
}

function connectCommand(args: ConnectArgs): Record<string, unknown> {
  return {
    cmd: "graph_connect",
    from_node_id: args.from_node_id,
    from_output: args.from_output,
    to_node_id: args.to_node_id,
    to_input: args.to_input,
    auto_match: args.auto_match,
  };
}

function sameSlotRef(left: unknown, right: unknown): boolean {
  if (left == null && right == null) return true;
  if (typeof left === "number" && typeof right === "number") return left === right;
  const a = slotNameKey(left);
  const b = slotNameKey(right);
  if (a && b) return a === b;
  return left === right;
}

function retriedNote(retry: WildcardConnectRetry): string {
  const via =
    retry.via === "typed" && retry.resolvedType
      ? `typed-resolution (${retry.resolvedType})`
      : "explicit wildcard slots";
  return (
    `Retried panel_connect over compatible LiteGraph wildcard-to-wildcard slots ` +
    `(${via}) so a PrimitiveNode \`*\` output can land on a \`*\` input and become ` +
    `typed from the destination (artokun/comfyui-mcp#2542).`
  );
}

function withNote<T extends ToolResultLike>(res: T, note: string | null): T {
  if (!note) return res;
  return { ...res, content: [...res.content, { type: "text", text: note }] };
}

/**
 * After a failed graph_connect, retry once when the refusal is a compatible
 * LiteGraph wildcard-to-wildcard pairing (`*` → `*`).
 */
export async function retryWildcardSlotConnect<T extends ToolResultLike>(
  args: ConnectArgs,
  first: T,
  call: GraphCall<T>,
  timeoutMs?: number,
): Promise<T> {
  if (!first.isError) return first;

  const text = toolText(first);
  const refusal = wildcardToWildcardRefusal(text);
  if (!refusal) return first;

  const diagnosticRetry = resolveWildcardConnectRetry(refusal, args);
  if (!diagnosticRetry) return first;

  const endpointIds = uniqueEndpointIds(args.from_node_id, args.to_node_id);
  if (endpointIds.length === 0) return first;

  const live = await call(
    {
      cmd: "graph_query",
      ids: endpointIds,
      fields: "detail",
      limit: endpointIds.length,
      max_chars: DETAIL_MAX_CHARS,
    },
    DETAIL_TIMEOUT_MS,
  );
  const nodes = parseLiveWildcardNodes(parseJsonPayload(live));
  let retryPlan: WildcardConnectRetry | null = diagnosticRetry;
  if (nodes) {
    const source = nodeByConnectId(nodes, args.from_node_id);
    const target = nodeByConnectId(nodes, args.to_node_id);
    retryPlan =
      source && target
        ? resolveLiveWildcardRetry(source, target, args, diagnosticRetry)
        : diagnosticRetry;
  }
  if (!retryPlan) return first;

  if (
    sameSlotRef(args.from_output, retryPlan.from_output) &&
    sameSlotRef(args.to_input, retryPlan.to_input) &&
    args.auto_match === false
  ) {
    return first;
  }

  const retryArgs: ConnectArgs = {
    from_node_id: args.from_node_id,
    from_output: retryPlan.from_output,
    to_node_id: args.to_node_id,
    to_input: retryPlan.to_input,
    auto_match: false,
  };
  const retry = await call(connectCommand(retryArgs), timeoutMs);
  if (!retry.isError) return withNote(retry, retriedNote(retryPlan));
  return retry;
}
