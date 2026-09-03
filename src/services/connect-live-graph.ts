/**
 * #2502 — `panel_connect` can refuse a node that the immediately preceding
 * `panel_graph_outline` listed on the same live root graph.
 *
 * After a completed canvas render the mutation executor can still be bound to a
 * stale graph object while reads (`graph_outline` / `graph_query`) already walk
 * the live snapshot. The panel then reports "No node with id N in the current
 * graph" even though the identity string and root scope match the outline.
 *
 * Re-resolve the live graph (the same query surface outline uses) before treating
 * that refusal as final, and retry the connect once when both endpoints are
 * present. A node that truly is absent, or that lives in another subgraph, is
 * left alone.
 */

import { NODE_ID_PATTERN, normalizeNodeId } from "../orchestrator/node-id.js";

const MISSING_NODE_RE = /No node with id (\S+) in the current graph/i;
const INSIDE_SUBGRAPH_RE = /lives INSIDE a subgraph/i;

export type LiveGraphBinding = {
  scope: "root" | "subgraph";
  graphIdentity?: string;
};

export type ConnectArgs = {
  from_node_id: unknown;
  from_output?: unknown;
  to_node_id: unknown;
  to_input?: unknown;
  auto_match?: unknown;
};

export type ToolResultLike = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

export type GraphCall<T extends ToolResultLike> = (
  cmd: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<T>;

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

export function canonicalConnectNodeId(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? String(value) : null;
  }
  if (typeof value !== "string" || value.length === 0) return null;
  if (!NODE_ID_PATTERN.test(value)) return null;
  return String(normalizeNodeId(value));
}

export function sameConnectNodeId(left: unknown, right: unknown): boolean {
  const a = canonicalConnectNodeId(left);
  const b = canonicalConnectNodeId(right);
  return a !== null && a === b;
}

/** True when the panel refused a node as missing from the current graph, and
 *  did not locate it inside another subgraph. */
export function isMissingNodeInCurrentGraphRefusal(text: string): boolean {
  return MISSING_NODE_RE.test(text) && !INSIDE_SUBGRAPH_RE.test(text);
}

export function missingNodeIdInCurrentGraph(text: string): string | null {
  if (!isMissingNodeInCurrentGraphRefusal(text)) return null;
  const match = MISSING_NODE_RE.exec(text);
  const raw = match?.[1];
  return raw ? canonicalConnectNodeId(raw) : null;
}

export function isUsableLiveGraphBinding(value: unknown): value is LiveGraphBinding {
  const rec = asRecord(value);
  if (!rec) return false;
  if (rec.scope !== "root" && rec.scope !== "subgraph") return false;
  if (rec.graphIdentity !== undefined) {
    return (
      typeof rec.graphIdentity === "string" &&
      rec.graphIdentity.length > 0 &&
      rec.graphIdentity.length <= 256
    );
  }
  return true;
}

export function parseLiveGraphBinding(value: unknown): LiveGraphBinding | null {
  const rec = asRecord(value);
  if (!rec) return null;
  if (rec.scope !== "root" && rec.scope !== "subgraph") return null;
  const graphIdentity = rec.graph_identity;
  if (
    graphIdentity !== undefined &&
    (typeof graphIdentity !== "string" || graphIdentity.length === 0 || graphIdentity.length > 256)
  ) {
    return null;
  }
  const binding: LiveGraphBinding = { scope: rec.scope };
  if (typeof graphIdentity === "string") binding.graphIdentity = graphIdentity;
  return isUsableLiveGraphBinding(binding) ? binding : null;
}

function collectLiveNodeIds(payload: unknown): Set<string> | null {
  const rec = asRecord(payload);
  if (!rec) return null;
  if (Object.prototype.hasOwnProperty.call(rec, "truncated") && rec.truncated !== false) {
    return null;
  }

  const ids = new Set<string>();
  const add = (value: unknown): void => {
    const id = canonicalConnectNodeId(value);
    if (id) ids.add(id);
  };

  if (Array.isArray(rec.nodes)) {
    for (const entry of rec.nodes) {
      const node = asRecord(entry);
      if (node) add(node.id);
      else add(entry);
    }
  }
  if (Array.isArray(rec.ids)) {
    for (const entry of rec.ids) add(entry);
  }
  if (typeof rec.text === "string") {
    for (const line of rec.text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^\d+ match\(es\) of \d+ in scope/.test(trimmed)) continue;
      const compact = trimmed.match(/^#(\S+)\s+\S+/);
      if (compact) {
        add(compact[1]);
        continue;
      }
      for (const part of trimmed.split(/[,\s]+/)) add(part);
    }
  }
  return ids;
}

/** True when the live graph_query (same snapshot outline uses) lists `nodeId`. */
export function liveGraphHasNodeId(payload: unknown, nodeId: unknown): boolean {
  const want = canonicalConnectNodeId(nodeId);
  if (!want) return false;
  const ids = collectLiveNodeIds(payload);
  return ids !== null && ids.has(want);
}

export function liveGraphHasConnectEndpoints(
  payload: unknown,
  fromNodeId: unknown,
  toNodeId: unknown,
): boolean {
  return liveGraphHasNodeId(payload, fromNodeId) && liveGraphHasNodeId(payload, toNodeId);
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

function withNote<T extends ToolResultLike>(res: T, note: string | null): T {
  if (!note) return res;
  return { ...res, content: [...res.content, { type: "text", text: note }] };
}

function retriedNote(missingId: string): string {
  return (
    `Re-resolved node ${missingId} on the live graph (same binding as panel_graph_outline) ` +
    `and retried panel_connect (artokun/comfyui-mcp#2502).`
  );
}

/**
 * Dispatch graph_connect. On a current-graph missing-node refusal, look the
 * endpoints up on the live graph_query snapshot and retry once when both exist.
 */
export async function retryConnectAgainstLiveGraph<T extends ToolResultLike>(
  args: ConnectArgs,
  call: GraphCall<T>,
  timeoutMs?: number,
): Promise<T> {
  const cmd = connectCommand(args);
  const first = await call(cmd, timeoutMs);
  if (!first.isError) return first;

  const text = toolText(first);
  const missingId = missingNodeIdInCurrentGraph(text);
  if (!missingId) return first;
  if (
    !sameConnectNodeId(missingId, args.from_node_id) &&
    !sameConnectNodeId(missingId, args.to_node_id)
  ) {
    return first;
  }

  const endpointIds = uniqueEndpointIds(args.from_node_id, args.to_node_id);
  if (endpointIds.length === 0) return first;

  const live = await call(
    {
      cmd: "graph_query",
      ids: endpointIds,
      fields: "ids",
      limit: endpointIds.length,
      max_chars: 4000,
    },
    8000,
  );
  const payload = parseJsonPayload(live);
  const rec = asRecord(payload);
  if (!rec) return first;
  if (rec.viewing !== undefined && !parseLiveGraphBinding(rec.viewing)) return first;
  if (!liveGraphHasConnectEndpoints(payload, args.from_node_id, args.to_node_id)) {
    return first;
  }

  const retry = await call(cmd, timeoutMs);
  if (!retry.isError) return withNote(retry, retriedNote(missingId));
  return retry;
}
