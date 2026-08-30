// #2544 — content-only [root-shape-mismatch] must not block a read-only inspect.
//
// After manual MiniMaxH3Director custom-widget / builder edits, the panel refuses
// graph_query even when workflow and live canvas report the SAME node count. The
// difference is CONTENT (widgets, builder UI state), not size or identity. The
// panel's own remedy names panel_open_workflow / reload, which would discard the
// unsaved live canvas. This module is the MCP-side read-only path: classify that
// refusal, recover from a live serialize/get_state when the panel will still
// serve one, and otherwise rewrite the error so the caller is not sent into
// destructive rebind. Size disagreements and [root-workflow-uuid-mismatch] stay
// fail-closed.

import { queryApiGraph, type GraphQueryOptions } from "../services/graph-query.js";
import { isPlainObject, workflowFromSerializeReply } from "./open-identity-normalization.js";

export const CONTENT_ONLY_QUERY_NOTE =
  "READ-ONLY: the live canvas drifted in CONTENT from the workflow tracker " +
  "(custom-widget / builder edits) while the node count stayed the same. This " +
  "reply is the unsaved live canvas. Do NOT panel_open_workflow, panel_reload, " +
  "or rebind — those would discard unsaved builder work.";

export const CONTENT_ONLY_QUERY_REFUSAL_NOTE =
  "READ-ONLY: this is content-only drift from custom-widget / builder edits " +
  "(same node count, unsaved live canvas). The live canvas is still this " +
  "workflow. Do NOT panel_open_workflow, panel_reload, or rebind — those would " +
  "discard unsaved MiniMaxH3Director / custom-widget builder work.";

export type ToolResultLike = {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
};

function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (isPlainObject(err) && typeof err.message === "string") return err.message;
  return String(err ?? "");
}

function resultText(res: ToolResultLike): string {
  return res.content?.find((c) => c.type === "text")?.text ?? "";
}

/** Anchored to the panel's bracketed token. Optional `Error: ` prefix is the
 *  ToolResult wrapper ctx.call applies; a quoted token later in a message is not
 *  this verdict. */
export function isRootShapeMismatch(err: unknown): boolean {
  const text = errorText(err);
  return /^\s*(?:Error:\s*)?\[root-shape-mismatch\]/i.test(text);
}

function sizesDisagree(text: string): boolean {
  const m = /the workflow reports (\d+) node\(s\) but the live canvas holds (\d+)/i.exec(text);
  if (!m) return false;
  return m[1] !== m[2];
}

/**
 * True when the panel named [root-shape-mismatch] AND measured equal size —
 * CONTENT drift, not a different graph. The structure-exact wording is the
 * same class (widgets a node rewrote itself). A size disagreement is not.
 */
export function isContentOnlyRootShapeMismatch(err: unknown): boolean {
  if (!isRootShapeMismatch(err)) return false;
  const text = errorText(err);
  if (sizesDisagree(text)) return false;
  return (
    /CONTENT, not its size/i.test(text) ||
    /reproduces this workflow's STRUCTURE exactly/i.test(text) ||
    /both the workflow and the live canvas report \d+ node\(s\)/i.test(text)
  );
}

export function contentOnlyRootShapeReadNote(raw: string): string {
  const body = raw.replace(/^\s*(?:Error:\s*)?/i, "");
  return `${body}\n\n${CONTENT_ONLY_QUERY_REFUSAL_NOTE}`;
}

function jsonPayload(res: ToolResultLike): Record<string, unknown> | null {
  if (res.isError) return null;
  const text = resultText(res);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    // unknown-ok: live-canvas capture was not JSON
    return null;
  }
}

function nodeTitle(node: Record<string, unknown>): string | undefined {
  if (typeof node.title === "string" && node.title) return node.title;
  const meta = node._meta;
  if (isPlainObject(meta) && typeof meta.title === "string" && meta.title) return meta.title;
  return undefined;
}

function nodeWidgets(node: Record<string, unknown>): Record<string, unknown> {
  if (isPlainObject(node.widgets_values_named)) return node.widgets_values_named;
  if (isPlainObject(node.widgets)) return node.widgets;
  return {};
}

type ApiNodeLite = {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title: string };
};

/** Named widgets from a UI serialize / graph_get_state node list, for queryApiGraph. */
export function uiGraphToApiGraph(nodes: unknown): Record<string, ApiNodeLite> {
  const graph: Record<string, ApiNodeLite> = {};
  if (!Array.isArray(nodes)) return graph;
  for (const raw of nodes) {
    if (!isPlainObject(raw)) continue;
    if (raw.id == null) continue;
    const id = String(raw.id);
    const title = nodeTitle(raw);
    graph[id] = {
      class_type: typeof raw.type === "string" ? raw.type : "",
      inputs: nodeWidgets(raw),
      ...(title ? { _meta: { title } } : {}),
    };
  }
  return graph;
}

function nodesFromLiveCapture(payload: unknown): unknown[] | null {
  const wf = workflowFromSerializeReply(payload);
  if (wf && Array.isArray(wf.nodes) && wf.nodes.length > 0) return wf.nodes;
  if (isPlainObject(payload) && Array.isArray(payload.nodes) && payload.nodes.length > 0) {
    return payload.nodes;
  }
  return null;
}

export async function readLiveUiGraphForContentDrift(
  call: (cmd: Record<string, unknown>, timeoutMs?: number) => Promise<ToolResultLike>,
): Promise<{ nodes: unknown[]; recovered_from: "graph_serialize" | "graph_get_state" } | null> {
  const serialized = await call({ cmd: "graph_serialize" }, 8000);
  if (!serialized.isError) {
    const nodes = nodesFromLiveCapture(jsonPayload(serialized));
    if (nodes) return { nodes, recovered_from: "graph_serialize" };
  } else if (isRootShapeMismatch(resultText(serialized)) && !isContentOnlyRootShapeMismatch(resultText(serialized))) {
    return null;
  }

  const state = await call({ cmd: "graph_get_state" }, 8000);
  if (state.isError) return null;
  const nodes = nodesFromLiveCapture(jsonPayload(state));
  if (!nodes) return null;
  return { nodes, recovered_from: "graph_get_state" };
}

/**
 * Read-only inspection when graph_query was refused for content-only drift.
 * Never opens or rebinds. Returns null when the live canvas could not be read
 * (including a size/identity mismatch on the fallback capture).
 */
export async function recoverContentOnlyGraphQuery(
  call: (cmd: Record<string, unknown>, timeoutMs?: number) => Promise<ToolResultLike>,
  args: GraphQueryOptions = {},
): Promise<Record<string, unknown> | null> {
  const live = await readLiveUiGraphForContentDrift(call);
  if (!live) return null;
  const api = uiGraphToApiGraph(live.nodes);
  if (Object.keys(api).length === 0) return null;
  const queried = queryApiGraph(api, args);
  return {
    ...queried,
    content_drift: "content-only",
    recovered_from: live.recovered_from,
    note: CONTENT_ONLY_QUERY_NOTE,
  };
}
