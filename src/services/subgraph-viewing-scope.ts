/**
 * #2553 — last confirmed subgraph viewing, per bound tab.
 *
 * `panel_enter_subgraph` / `panel_query_graph` can prove `viewing.scope=subgraph`
 * and the very next MCP call still land on the root graph. Subgraph-interior
 * mutations (`unexpose` / `expose` / rail / promote) then refuse with
 * "must be run INSIDE a subgraph" even though this session already confirmed
 * the inner scope. The panel canvas is the live view; this store is the last
 * confirmation the session actually saw, so a later mutation can re-enter that
 * owner instead of silently targeting root.
 *
 * Root after an explicit `panel_exit_subgraph` (or a query that saw root) is
 * also remembered, so a deliberate leave is not undone.
 */

export type ConfirmedViewingScope = {
  scope: "root" | "subgraph";
  ownerNodeId: string | null;
  workflowUuid?: string;
};

export type ToolResultLike = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

export type GraphCall<T extends ToolResultLike> = (
  cmd: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<T>;

/** Bridge commands that the panel refuses unless the active graph IS a subgraph. */
export const SUBGRAPH_INTERIOR_CMDS: ReadonlySet<string> = new Set([
  "graph_unexpose_subgraph_input",
  "graph_unexpose_subgraph_output",
  "graph_expose_subgraph_input",
  "graph_expose_subgraph_output",
  "graph_move_rail",
  "graph_promote_widget",
]);

const OUTSIDE_SUBGRAPH_RE = /(?:must be run|must run) INSIDE a subgraph/i;

const rememberedByTab = new Map<string, ConfirmedViewingScope>();

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toolText(res: ToolResultLike): string {
  return res.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

export function parseJsonPayload(res: ToolResultLike): Record<string, unknown> | null {
  if (res.isError) return null;
  const text = res.content.find((c) => c.type === "text")?.text;
  if (typeof text !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function canonicalNodeId(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? String(value) : null;
  }
  if (typeof value !== "string" || value.length === 0) return null;
  if (!/^-?\d+(?::\d+)*$/.test(value)) return null;
  return value;
}

function wireNodeId(id: string): number | string {
  return /^-?\d+$/.test(id) ? Number.parseInt(id, 10) : id;
}

export function parseViewingScope(value: unknown): ConfirmedViewingScope | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const scope = rec.scope;
  if (scope !== "root" && scope !== "subgraph") return null;
  const workflowUuid = rec.workflow_uuid;
  if (
    workflowUuid !== undefined &&
    (typeof workflowUuid !== "string" || workflowUuid.length === 0)
  ) {
    return null;
  }
  let ownerNodeId: string | null = null;
  if (rec.owner_node_id !== undefined && rec.owner_node_id !== null) {
    ownerNodeId = canonicalNodeId(rec.owner_node_id);
    if (!ownerNodeId) return null;
  }
  return {
    scope,
    ownerNodeId,
    ...(typeof workflowUuid === "string" ? { workflowUuid } : {}),
  };
}

export function isOutsideSubgraphRefusal(text: string): boolean {
  return OUTSIDE_SUBGRAPH_RE.test(text);
}

export function isSubgraphInteriorCmd(cmd: unknown): boolean {
  return typeof cmd === "string" && SUBGRAPH_INTERIOR_CMDS.has(cmd);
}

export function rememberedViewingScope(tabId: string): ConfirmedViewingScope | null {
  return rememberedByTab.get(tabId) ?? null;
}

export function rememberedSubgraphOwner(tabId: string): string | null {
  const rec = rememberedByTab.get(tabId);
  return rec?.scope === "subgraph" ? rec.ownerNodeId : null;
}

export function clearRememberedViewingScope(tabId?: string): void {
  if (tabId === undefined) {
    rememberedByTab.clear();
    return;
  }
  rememberedByTab.delete(tabId);
}

/** Drop a remembered subgraph owner. A later live root read or an explicit
 * current-mode rebind must not keep authorizing the promoted-subgraph path. */
export function clearStaleSubgraphIdentity(tabId: string): void {
  if (!tabId) return;
  const rec = rememberedByTab.get(tabId);
  if (rec?.scope === "subgraph") rememberedByTab.delete(tabId);
}

/** Record a live root viewing so a prior subgraph confirmation cannot linger. */
export function applyLiveRootViewing(tabId: string, viewing: unknown): boolean {
  if (!tabId) return false;
  const parsed = parseViewingScope(viewing);
  if (parsed?.scope !== "root") return false;
  rememberedByTab.set(tabId, parsed);
  return true;
}

export function noteConfirmedViewing(
  tabId: string,
  payload: unknown,
  extras?: { enteredNodeId?: unknown },
): ConfirmedViewingScope | null {
  if (!tabId) return null;
  const rec = asRecord(payload);
  const viewing = parseViewingScope(rec?.viewing);
  const entered = canonicalNodeId(extras?.enteredNodeId ?? rec?.entered);

  let next: ConfirmedViewingScope | null = null;
  if (viewing?.scope === "root") {
    next = viewing;
  } else if (viewing?.scope === "subgraph") {
    next = {
      ...viewing,
      ownerNodeId: viewing.ownerNodeId ?? entered,
    };
  } else if (entered) {
    next = { scope: "subgraph", ownerNodeId: entered };
  }
  if (!next) return null;
  rememberedByTab.set(tabId, next);
  return next;
}

export function noteConfirmedViewingFromToolResult(
  tabId: string,
  res: ToolResultLike,
  extras?: { enteredNodeId?: unknown },
): ConfirmedViewingScope | null {
  const payload = parseJsonPayload(res);
  return payload ? noteConfirmedViewing(tabId, payload, extras) : null;
}

function withNote<T extends ToolResultLike>(res: T, note: string | null): T {
  if (!note) return res;
  return { ...res, content: [...res.content, { type: "text", text: note }] } as T;
}

function restoreNote(ownerNodeId: string): string {
  return (
    `Re-entered subgraph node ${ownerNodeId} from the last confirmed viewing scope ` +
    `(artokun/comfyui-mcp#2553) — the canvas had returned to root between tool calls.`
  );
}

function reenterFailedNote(ownerNodeId: string, enterText: string): string {
  return (
    `The canvas was at root, so this session tried to restore the last confirmed ` +
    `subgraph (node ${ownerNodeId}) before retrying. panel_enter_subgraph failed: ` +
    `${enterText} The original refusal stands. Call panel_enter_subgraph yourself ` +
    `if that is still the graph you mean to edit. (artokun/comfyui-mcp#2553)`
  );
}

function missingOwnerNote(): string {
  return (
    `This session last confirmed viewing.scope=subgraph, but no owner_node_id was ` +
    `published, so the subgraph cannot be re-entered automatically. Call ` +
    `panel_enter_subgraph with the subgraph node id. (artokun/comfyui-mcp#2553)`
  );
}

function workflowMismatchNote(remembered: string, live: string): string {
  return (
    `The last confirmed subgraph scope belonged to workflow ${remembered}, but the ` +
    `live canvas now reports ${live}. Not re-entering that subgraph. Call ` +
    `panel_enter_subgraph if the live canvas is the one you mean. (artokun/comfyui-mcp#2553)`
  );
}

/**
 * Remember viewing from a successful graph reply (enter / query / exit / outline).
 * Failures do not overwrite a prior confirmation.
 */
export async function callAndRememberViewing<T extends ToolResultLike>(
  tabId: string,
  cmd: Record<string, unknown>,
  call: GraphCall<T>,
  timeoutMs?: number,
): Promise<T> {
  const res = await call(cmd, timeoutMs);
  if (!res.isError) {
    noteConfirmedViewingFromToolResult(
      tabId,
      res,
      cmd.cmd === "graph_enter_subgraph" ? { enteredNodeId: cmd.node_id } : undefined,
    );
  }
  return res;
}

/**
 * Dispatch a subgraph-interior mutation. On the panel's "must be run INSIDE a
 * subgraph" refusal, re-enter the last confirmed owner for this tab (when the
 * live canvas is at root) and retry once. A remembered root — an explicit exit
 * or a query that saw root — is left alone.
 */
export async function callWithRememberedSubgraph<T extends ToolResultLike>(
  tabId: string,
  cmd: Record<string, unknown>,
  call: GraphCall<T>,
  timeoutMs?: number,
): Promise<T> {
  const first = await call(cmd, timeoutMs);
  if (!first.isError || !isOutsideSubgraphRefusal(toolText(first))) return first;
  if (!isSubgraphInteriorCmd(cmd.cmd)) return first;

  const remembered = rememberedViewingScope(tabId);
  if (!remembered || remembered.scope !== "subgraph") return first;
  if (!remembered.ownerNodeId) return withNote(first, missingOwnerNote());

  const probe = await call({ cmd: "graph_query", fields: "ids", limit: 1 }, 8000);
  const live = parseViewingScope(parseJsonPayload(probe)?.viewing);
  if (
    remembered.workflowUuid &&
    live?.workflowUuid &&
    remembered.workflowUuid !== live.workflowUuid
  ) {
    return withNote(first, workflowMismatchNote(remembered.workflowUuid, live.workflowUuid));
  }
  if (live?.scope === "subgraph") {
    const retried = await call(cmd, timeoutMs);
    return retried;
  }

  const ownerNodeId = remembered.ownerNodeId;
  const enter = await call(
    { cmd: "graph_enter_subgraph", node_id: wireNodeId(ownerNodeId) },
    15000,
  );
  if (enter.isError) {
    return withNote(first, reenterFailedNote(ownerNodeId, toolText(enter)));
  }
  noteConfirmedViewingFromToolResult(tabId, enter, { enteredNodeId: ownerNodeId });

  const retried = await call(cmd, timeoutMs);
  if (!retried.isError) return withNote(retried, restoreNote(ownerNodeId));
  return withNote(
    retried,
    `Re-entered subgraph node ${ownerNodeId}, but the mutation still failed: ${toolText(retried)}`,
  );
}
