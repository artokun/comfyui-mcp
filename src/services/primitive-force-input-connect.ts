/**
 * #2536 — `panel_connect` can report success for a frontend PrimitiveNode wired
 * to a forceInput-only STRING, then `panel_run` omits the required input.
 *
 * PrimitiveNode is LiteGraph-native: it is skipped from the queued prompt and
 * only serializes by copying its literal onto a target widget. A forceInput
 * socket has no widget, so the visible link disappears from `/prompt` and
 * ComfyUI rejects with `Required input is missing`.
 *
 * After a successful connect, prove the source is PrimitiveNode AND the target
 * input has no serializable widget binding, then disconnect and refuse with a
 * backend STRING producer (PrimitiveStringMultiline). Unreadable / truncated
 * probes fall open — they do not prove the force-only shape.
 */

import { normalizeNodeId } from "../orchestrator/node-id.js";
import {
  canonicalConnectNodeId,
  sameConnectNodeId,
  type ConnectArgs,
  type GraphCall,
  type ToolResultLike,
} from "./connect-live-graph.js";

export const FRONTEND_PRIMITIVE_NODE_TYPE = "PrimitiveNode";

const DETAIL_MAX_CHARS = 60000;
const DETAIL_TIMEOUT_MS = 8000;

export type LiveConnectInput = {
  name: string;
  slot: number | null;
  type: string | null;
  widget: unknown;
  forceInput: boolean;
  connectedFrom: unknown;
};

export type LiveConnectNode = {
  id: string;
  type: string;
  widgets: Record<string, unknown> | null;
  widgetsKnown: boolean;
  inputs: LiveConnectInput[];
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

function isForceInputFlag(value: unknown): boolean {
  return value === true;
}

function parseLiveConnectInput(raw: unknown, index: number): LiveConnectInput | null {
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
    connectedFrom: rec.connected_from ?? rec.connectedFrom ?? rec.link ?? null,
  };
}

function parseLiveConnectNode(raw: unknown): LiveConnectNode | null {
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
  if (!Array.isArray(rec.inputs)) return null;

  const widgetsKnown = Object.prototype.hasOwnProperty.call(rec, "widgets");
  const widgetsRaw = rec.widgets;
  const widgets =
    widgetsRaw && typeof widgetsRaw === "object" && !Array.isArray(widgetsRaw)
      ? (widgetsRaw as Record<string, unknown>)
      : null;

  const inputs: LiveConnectInput[] = [];
  for (let i = 0; i < rec.inputs.length; i++) {
    const input = parseLiveConnectInput(rec.inputs[i], i);
    if (input) inputs.push(input);
  }

  return {
    id,
    type,
    widgets: widgetsKnown ? widgets : null,
    widgetsKnown,
    inputs,
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
      /* compact/ids line */
    }
  }
  return rows;
}

export function isFrontendPrimitiveNodeType(type: string | null | undefined): boolean {
  return type === FRONTEND_PRIMITIVE_NODE_TYPE;
}

/** True when the live input carries a widget object/name the Primitive can bake onto. */
export function hasSerializableWidgetBinding(input: LiveConnectInput): boolean {
  const widget = input.widget;
  if (widget === true) return true;
  if (typeof widget === "string") return widget.length > 0;
  const rec = asRecord(widget);
  if (!rec) return false;
  if (typeof rec.name === "string") return rec.name.length > 0;
  return Object.keys(rec).length > 0;
}

/**
 * True when the live target input is proven forceInput-only / non-widget.
 * A missing widgets map is not evidence — that probe falls open.
 */
export function isForceInputOnlyNonWidget(
  input: LiveConnectInput,
  widgets: Record<string, unknown> | null,
  widgetsKnown: boolean,
): boolean {
  if (input.forceInput) return true;
  if (hasSerializableWidgetBinding(input)) return false;
  if (!widgetsKnown) return false;
  return !Object.prototype.hasOwnProperty.call(widgets ?? {}, input.name);
}

function connectedFromNodeId(connectedFrom: unknown): string | null {
  if (connectedFrom == null) return null;
  if (typeof connectedFrom === "number") return canonicalConnectNodeId(connectedFrom);
  if (typeof connectedFrom === "string") {
    const idPart = connectedFrom.split(".")[0] ?? connectedFrom;
    return canonicalConnectNodeId(idPart);
  }
  const rec = asRecord(connectedFrom);
  if (!rec) return null;
  return canonicalConnectNodeId(rec.node_id ?? rec.id);
}

export function findTargetConnectInput(
  target: LiveConnectNode,
  fromNodeId: unknown,
  toInput: unknown,
): LiveConnectInput | null {
  if (typeof toInput === "string" && toInput.length > 0) {
    const byName = target.inputs.find((input) => input.name === toInput);
    if (byName) return byName;
    const lower = toInput.toLowerCase();
    return target.inputs.find((input) => input.name.toLowerCase() === lower) ?? null;
  }
  if (typeof toInput === "number" && Number.isSafeInteger(toInput)) {
    const bySlot = target.inputs.find((input) => input.slot === toInput);
    if (bySlot) return bySlot;
    return target.inputs[toInput] ?? null;
  }
  const fromId = canonicalConnectNodeId(fromNodeId);
  if (!fromId) return null;
  return (
    target.inputs.find((input) => sameConnectNodeId(connectedFromNodeId(input.connectedFrom), fromId)) ??
    null
  );
}

export function parseLiveConnectNodes(payload: unknown): LiveConnectNode[] | null {
  const rec = asRecord(payload);
  if (!rec) return null;
  if (Object.prototype.hasOwnProperty.call(rec, "truncated") && rec.truncated !== false) {
    return null;
  }
  const nodes: LiveConnectNode[] = [];
  const seen = new Set<string>();
  for (const row of collectDetailRows(rec)) {
    const node = parseLiveConnectNode(row);
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    nodes.push(node);
  }
  return nodes.length > 0 ? nodes : null;
}

export function nodeByConnectId(
  nodes: readonly LiveConnectNode[],
  nodeId: unknown,
): LiveConnectNode | null {
  const want = canonicalConnectNodeId(nodeId);
  if (!want) return null;
  return nodes.find((node) => node.id === want) ?? null;
}

export function primitiveForceInputRefusal(opts: {
  fromNodeId: unknown;
  toNodeId: unknown;
  toType: string;
  inputName: string;
  inputType: string | null;
  disconnected: boolean;
}): string {
  const from = canonicalConnectNodeId(opts.fromNodeId) ?? String(opts.fromNodeId);
  const to = canonicalConnectNodeId(opts.toNodeId) ?? String(opts.toNodeId);
  const slot = opts.inputType ? `${opts.toType}.${opts.inputName} (${opts.inputType})` : `${opts.toType}.${opts.inputName}`;
  const undo = opts.disconnected
    ? "The LiteGraph link was disconnected so this is not reported as success."
    : "Disconnect that input before retrying with a backend STRING producer.";
  return (
    `Error: panel_connect refused frontend PrimitiveNode #${from} → #${to} ${slot}. ` +
    `A PrimitiveNode only serializes through a target widget; this input is forceInput-only ` +
    `(no serializable widget binding), so panel_run would omit the required input from the ` +
    `queued prompt. Add a backend STRING producer such as PrimitiveStringMultiline, set its ` +
    `STRING widget, then panel_connect that STRING output to "${opts.inputName}". ${undo} ` +
    `(artokun/comfyui-mcp#2536)`
  );
}

function errorResult<T extends ToolResultLike>(text: string, base: T): T {
  return { ...base, isError: true, content: [{ type: "text", text }] };
}

/**
 * After a successful graph_connect, refuse a frontend PrimitiveNode that landed
 * on a forceInput-only / non-widget input. Fail-open when the live detail cannot
 * prove that shape.
 */
export async function verifyPrimitiveForceInputAfterConnect<T extends ToolResultLike>(
  args: ConnectArgs,
  connected: T,
  call: GraphCall<T>,
): Promise<T> {
  if (connected.isError) return connected;

  const endpointIds = uniqueEndpointIds(args.from_node_id, args.to_node_id);
  if (endpointIds.length === 0) return connected;

  const detail = await call(
    {
      cmd: "graph_query",
      ids: endpointIds,
      fields: "detail",
      limit: endpointIds.length,
      max_chars: DETAIL_MAX_CHARS,
    },
    DETAIL_TIMEOUT_MS,
  );
  const nodes = parseLiveConnectNodes(parseJsonPayload(detail));
  if (!nodes) return connected;

  const source = nodeByConnectId(nodes, args.from_node_id);
  const target = nodeByConnectId(nodes, args.to_node_id);
  if (!source || !target) return connected;
  if (!isFrontendPrimitiveNodeType(source.type)) return connected;

  const input = findTargetConnectInput(target, args.from_node_id, args.to_input);
  if (!input) return connected;
  if (!isForceInputOnlyNonWidget(input, target.widgets, target.widgetsKnown)) {
    return connected;
  }

  let disconnected = false;
  const undone = await call({
    cmd: "graph_disconnect",
    node_id: args.to_node_id,
    input: input.name,
  });
  disconnected = undone.isError !== true;

  return errorResult(
    primitiveForceInputRefusal({
      fromNodeId: args.from_node_id,
      toNodeId: args.to_node_id,
      toType: target.type,
      inputName: input.name,
      inputType: input.type,
      disconnected,
    }),
    connected,
  );
}
