// #1710 — a save-as copy opens onto the right node set, then save refuses
// because extra.comfyui_mcp still names the SOURCE, and outline shows empty
// promoted widgets the dest file still carries.
//
// Two levels stay separate:
//   presentation (order/size/named-vs-positional widgets) is not identity
//   a NON-EMPTY live widget that disagrees with dest is not dest's graph
//     (#1639: the previous workflow still answering under the old stamp)

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function normalizeWorkflowPath(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
  if (!normalized || /^(?:tmp:|wf:)/i.test(normalized)) return null;
  return normalized;
}

export function workflowFromSerializeReply(reply: unknown): Record<string, unknown> | null {
  if (!isPlainObject(reply)) return null;
  if (Array.isArray(reply.nodes)) return reply;
  const wf = reply.workflow;
  if (isPlainObject(wf) && Array.isArray(wf.nodes)) return wf;
  return null;
}

export function extraWorkflowPath(graph: unknown): string | null {
  if (!isPlainObject(graph)) return null;
  const extra = isPlainObject(graph.extra) ? graph.extra : null;
  const meta = extra && isPlainObject(extra.comfyui_mcp) ? extra.comfyui_mcp : null;
  return typeof meta?.workflow_path === "string" && meta.workflow_path ? meta.workflow_path : null;
}

export function extraWorkflowUuid(graph: unknown): string | null {
  if (!isPlainObject(graph)) return null;
  const extra = isPlainObject(graph.extra) ? graph.extra : null;
  const meta = extra && isPlainObject(extra.comfyui_mcp) ? extra.comfyui_mcp : null;
  return typeof meta?.workflow_uuid === "string" && meta.workflow_uuid ? meta.workflow_uuid : null;
}

/**
 * Exact unsaved routing handle (`tmp:<id>`). OPEN must accept any non-empty
 * tmp: token panel_list_workflows publishes — not only RFC-uuid suffixes — or an
 * already-active imported tab cannot rebind (#2503).
 */
export function unsavedTmpWorkflowKey(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return /^tmp:\S+$/.test(value) ? value : null;
}

/**
 * Saved-file path encoded in a panel tab id. `wf:<path>` (legacy handle) and
 * `wf:<tabRouteId>:<path>` (current route) both name dest A. `tmp:` and bare
 * uuids do not — those tabs have no saved identity (#2503).
 */
export function savedPathFromTabId(tabId: unknown): string | null {
  if (typeof tabId !== "string" || !tabId.startsWith("wf:")) return null;
  const rest = tabId.slice(3);
  if (!rest) return null;
  const sep = rest.indexOf(":");
  const head = sep === -1 ? "" : rest.slice(0, sep);
  const isRoute = sep > 1 && !/[/\\]/.test(head);
  const path = isRoute ? rest.slice(sep + 1) : rest;
  return normalizeWorkflowPath(path);
}

/**
 * #2503 — importing/loading onto a new tmp tab must not keep the source graph's
 * extra.comfyui_mcp.workflow_uuid. Replace it with the tab's assigned uuid.
 * Leaves workflow_path untouched (#2505).
 *
 * Returns a cloned graph when a rewrite is needed; null when dest/graph are
 * unusable or the stamp already names dest.
 */
export function bindImportedTmpWorkflowUuid(
  graph: unknown,
  destUuid: string,
): Record<string, unknown> | null {
  if (!isPlainObject(graph)) return null;
  if (typeof destUuid !== "string" || !destUuid) return null;
  const stamped = extraWorkflowUuid(graph);
  if (!stamped || stamped === destUuid) return null;
  const next: Record<string, unknown> = structuredClone(graph);
  const extra = isPlainObject(next.extra) ? { ...next.extra } : {};
  const meta = isPlainObject(extra.comfyui_mcp) ? { ...extra.comfyui_mcp } : {};
  meta.workflow_uuid = destUuid;
  extra.comfyui_mcp = meta;
  next.extra = extra;
  return next;
}

/**
 * #2505 — loading a graph onto another tab must not keep the source
 * extra.comfyui_mcp.workflow_path. Replace path (and uuid when destUuid is
 * known) with the active dest identity so a later in-place save is not refused
 * by the #1667 stale-canvas guard.
 *
 * Returns a cloned graph when a rewrite is needed; null when dest/graph are
 * unusable or the stamp already names dest.
 */
export function bindLoadedWorkflowIdentity(
  graph: unknown,
  destPath: string,
  destUuid?: string,
): Record<string, unknown> | null {
  if (!isPlainObject(graph)) return null;
  const dest = normalizeWorkflowPath(destPath);
  if (!dest) return null;
  const stampedPath = normalizeWorkflowPath(extraWorkflowPath(graph));
  const stampedUuid = extraWorkflowUuid(graph);
  const pathNeeds = stampedPath !== dest;
  const uuidNeeds = Boolean(destUuid) && stampedUuid !== destUuid;
  if (!pathNeeds && !uuidNeeds) return null;
  const next: Record<string, unknown> = structuredClone(graph);
  const extra = isPlainObject(next.extra) ? { ...next.extra } : {};
  const meta = isPlainObject(extra.comfyui_mcp) ? { ...extra.comfyui_mcp } : {};
  meta.workflow_path = dest;
  if (destUuid) meta.workflow_uuid = destUuid;
  extra.comfyui_mcp = meta;
  next.extra = extra;
  return next;
}

export function extraStampDisagrees(graph: unknown, destPath: string): boolean {
  const stamped = normalizeWorkflowPath(extraWorkflowPath(graph));
  const dest = normalizeWorkflowPath(destPath);
  if (!stamped || !dest) return false;
  return stamped !== dest;
}

export function isEmptyWidgetValue(v: unknown): boolean {
  if (v == null) return true;
  if (v === "") return true;
  if (Array.isArray(v)) return v.length === 0 || v.every(isEmptyWidgetValue);
  if (isPlainObject(v)) {
    const vals = Object.values(v);
    return vals.length === 0 || vals.every(isEmptyWidgetValue);
  }
  return false;
}

function namedWidgets(node: Record<string, unknown>): Record<string, unknown> | null {
  if (isPlainObject(node.widgets_values_named)) return node.widgets_values_named;
  if (isPlainObject(node.widgets_values)) return node.widgets_values;
  return null;
}

function valuesDiffer(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return false;
  try {
    return JSON.stringify(a) !== JSON.stringify(b);
  } catch {
    return true;
  }
}

function nodeIdentityKey(node: unknown): string | null {
  if (!isPlainObject(node) || node.id == null || typeof node.type !== "string") return null;
  return `${String(node.id)}\0${node.type}`;
}

export function nodeIdentitySet(graph: unknown): Set<string> | null {
  if (!isPlainObject(graph) || !Array.isArray(graph.nodes)) return null;
  const keys = new Set<string>();
  for (const raw of graph.nodes) {
    const key = nodeIdentityKey(raw);
    if (key == null || keys.has(key)) return null;
    keys.add(key);
  }
  return keys;
}

export function nodeIdentitiesMatch(a: unknown, b: unknown): boolean {
  const left = nodeIdentitySet(a);
  const right = nodeIdentitySet(b);
  if (!left || !right || left.size !== right.size || left.size === 0) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

/** True when dest has a NON-EMPTY widget live already holds as a different value. */
export function liveSemanticWidgetsDisagree(live: unknown, dest: unknown): boolean {
  if (!isPlainObject(live) || !isPlainObject(dest)) return true;
  if (!Array.isArray(live.nodes) || !Array.isArray(dest.nodes)) return true;
  const liveById = new Map<string, Record<string, unknown>>();
  for (const raw of live.nodes) {
    if (isPlainObject(raw) && raw.id != null) liveById.set(String(raw.id), raw);
  }
  for (const raw of dest.nodes) {
    if (!isPlainObject(raw) || raw.id == null) continue;
    const liveNode = liveById.get(String(raw.id));
    if (!liveNode) return true;
    if (nodeWidgetsDisagree(liveNode, raw)) return true;
  }
  return false;
}

function nodeWidgetsDisagree(liveNode: Record<string, unknown>, destNode: Record<string, unknown>): boolean {
  const destNamed = namedWidgets(destNode);
  if (destNamed) {
    const liveMap = namedWidgets(liveNode) ?? {};
    for (const [key, destVal] of Object.entries(destNamed)) {
      const liveVal = liveMap[key];
      if (isEmptyWidgetValue(liveVal)) continue;
      if (valuesDiffer(liveVal, destVal)) return true;
    }
    return false;
  }
  if (!Array.isArray(destNode.widgets_values)) return false;
  const destWv = destNode.widgets_values;
  const liveWv = Array.isArray(liveNode.widgets_values) ? liveNode.widgets_values : [];
  for (let i = 0; i < destWv.length; i++) {
    if (isEmptyWidgetValue(liveWv[i])) continue;
    if (valuesDiffer(liveWv[i], destWv[i])) return true;
  }
  return false;
}

function nodeNeedsPromotedRestore(
  liveNode: Record<string, unknown>,
  destNode: Record<string, unknown>,
): boolean {
  const destNamed = namedWidgets(destNode);
  if (destNamed) {
    const liveMap = namedWidgets(liveNode) ?? {};
    for (const [key, destVal] of Object.entries(destNamed)) {
      if (!isEmptyWidgetValue(destVal) && isEmptyWidgetValue(liveMap[key])) return true;
    }
  }
  if (Array.isArray(destNode.widgets_values)) {
    const liveWv = Array.isArray(liveNode.widgets_values) ? liveNode.widgets_values : [];
    for (let i = 0; i < destNode.widgets_values.length; i++) {
      if (!isEmptyWidgetValue(destNode.widgets_values[i]) && isEmptyWidgetValue(liveWv[i])) {
        return true;
      }
    }
  }
  return false;
}

export function destHasEmptyLivePromotedWidgets(live: unknown, dest: unknown): boolean {
  if (!isPlainObject(live) || !isPlainObject(dest)) return false;
  if (!Array.isArray(live.nodes) || !Array.isArray(dest.nodes)) return false;
  const liveById = new Map<string, Record<string, unknown>>();
  for (const raw of live.nodes) {
    if (isPlainObject(raw) && raw.id != null) liveById.set(String(raw.id), raw);
  }
  for (const raw of dest.nodes) {
    if (!isPlainObject(raw) || raw.id == null) continue;
    const liveNode = liveById.get(String(raw.id));
    if (liveNode && nodeNeedsPromotedRestore(liveNode, raw)) return true;
  }
  return false;
}

export function shouldRebindOpenIdentity(input: {
  live: unknown;
  dest: unknown;
  destPath: string;
}): boolean {
  if (!nodeIdentitiesMatch(input.live, input.dest)) return false;
  if (liveSemanticWidgetsDisagree(input.live, input.dest)) return false;
  return (
    extraStampDisagrees(input.live, input.destPath) ||
    destHasEmptyLivePromotedWidgets(input.live, input.dest)
  );
}

function restoreEmptyPromotedWidgets(
  liveNode: Record<string, unknown>,
  destNode: Record<string, unknown>,
): boolean {
  let restored = false;
  const destNamed = namedWidgets(destNode);
  if (destNamed) {
    const liveNamed = { ...(namedWidgets(liveNode) ?? {}) };
    let namedChanged = false;
    for (const [key, destVal] of Object.entries(destNamed)) {
      if (!isEmptyWidgetValue(destVal) && isEmptyWidgetValue(liveNamed[key])) {
        liveNamed[key] = destVal;
        namedChanged = true;
      }
    }
    if (namedChanged) {
      restored = true;
      if (isPlainObject(liveNode.widgets_values_named) || isPlainObject(destNode.widgets_values_named)) {
        liveNode.widgets_values_named = liveNamed;
      }
      if (isPlainObject(liveNode.widgets_values) || isPlainObject(destNode.widgets_values)) {
        liveNode.widgets_values = {
          ...(isPlainObject(liveNode.widgets_values) ? liveNode.widgets_values : {}),
          ...liveNamed,
        };
      }
    }
  }
  if (Array.isArray(destNode.widgets_values)) {
    const destWv = destNode.widgets_values;
    const liveWv = Array.isArray(liveNode.widgets_values) ? [...liveNode.widgets_values] : [];
    let positionalChanged = false;
    for (let i = 0; i < destWv.length; i++) {
      if (!isEmptyWidgetValue(destWv[i]) && isEmptyWidgetValue(liveWv[i])) {
        liveWv[i] = destWv[i];
        positionalChanged = true;
      }
    }
    if (positionalChanged) {
      liveNode.widgets_values = liveWv;
      restored = true;
    }
  }
  return restored;
}

export function patchOpenIdentity(
  live: Record<string, unknown>,
  dest: Record<string, unknown>,
  destPath: string,
  destUuid?: string,
): { graph: Record<string, unknown>; restoredWidgets: number } {
  const graph = structuredClone(live) as Record<string, unknown>;
  const extra = isPlainObject(graph.extra) ? { ...graph.extra } : {};
  const meta = isPlainObject(extra.comfyui_mcp) ? { ...extra.comfyui_mcp } : {};
  meta.workflow_path = destPath;
  if (destUuid) meta.workflow_uuid = destUuid;
  extra.comfyui_mcp = meta;
  graph.extra = extra;

  const destById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(dest.nodes)) {
    for (const raw of dest.nodes) {
      if (isPlainObject(raw) && raw.id != null) destById.set(String(raw.id), raw);
    }
  }
  let restoredWidgets = 0;
  if (Array.isArray(graph.nodes)) {
    for (const raw of graph.nodes) {
      if (!isPlainObject(raw) || raw.id == null) continue;
      const destNode = destById.get(String(raw.id));
      if (destNode && restoreEmptyPromotedWidgets(raw, destNode)) restoredWidgets += 1;
    }
  }
  return { graph, restoredWidgets };
}

export function isStampMismatchSaveRefusal(text: string): boolean {
  return /stamped as belonging to/i.test(text) && /extra\.comfyui_mcp\.workflow_path/i.test(text);
}

/**
 * #1846 — dest vs live after a load that only rewrote node definitions / widget
 * schema (unknown placeholders rehydrated after a custom-node install).
 *
 * The panel compares the just-loaded state to the live serialize and treats an
 * unexplained `definitions` difference as unknown. This asks a narrower question:
 * does the live canvas still hold dest's nodes, connections, and non-empty widget
 * values? Schema fields (inputs/outputs/properties/size/order) and the
 * definitions store's widget-schema filling are ignored. Fail closed on anything
 * else — a rewired link, a missing node, a dest widget value live does not hold.
 */
function isUnknownPlaceholderType(type: string): boolean {
  const t = type.trim().toLowerCase();
  return t === "unknown" || t === "unknownnode";
}

function typesCompatibleForRehydration(destType: string, liveType: string): boolean {
  return destType === liveType || isUnknownPlaceholderType(destType);
}

function nodesById(graph: unknown): Map<string, Record<string, unknown>> | null {
  if (!isPlainObject(graph) || !Array.isArray(graph.nodes)) return null;
  const byId = new Map<string, Record<string, unknown>>();
  for (const raw of graph.nodes) {
    if (!isPlainObject(raw) || raw.id == null) return null;
    const id = String(raw.id);
    if (byId.has(id)) return null;
    byId.set(id, raw);
  }
  return byId;
}

function nodeIdentitiesMatchAllowingRehydration(dest: unknown, live: unknown): boolean {
  const destById = nodesById(dest);
  const liveById = nodesById(live);
  if (!destById || !liveById || destById.size !== liveById.size) return false;
  for (const [id, destNode] of destById) {
    const liveNode = liveById.get(id);
    if (!liveNode) return false;
    if (typeof destNode.type !== "string" || typeof liveNode.type !== "string") return false;
    if (!typesCompatibleForRehydration(destNode.type, liveNode.type)) return false;
  }
  return true;
}

function linkEndpointKey(link: unknown): string | null {
  if (Array.isArray(link) && link.length >= 5) {
    const origin = link[1];
    const target = link[3];
    if (origin == null || target == null) return null;
    return `${String(origin)}\0${String(link[2])}\0${String(target)}\0${String(link[4])}`;
  }
  if (!isPlainObject(link)) return null;
  const origin = link.origin_id ?? link.from;
  const target = link.target_id ?? link.to;
  if (origin == null || target == null) return null;
  const originSlot = link.origin_slot ?? link.from_slot ?? 0;
  const targetSlot = link.target_slot ?? link.to_slot ?? 0;
  return `${String(origin)}\0${String(originSlot)}\0${String(target)}\0${String(targetSlot)}`;
}

function linkTopologySet(graph: unknown): Set<string> | null {
  if (!isPlainObject(graph)) return null;
  if (graph.links == null) return new Set();
  if (!Array.isArray(graph.links)) return null;
  const keys = new Set<string>();
  for (const link of graph.links) {
    const key = linkEndpointKey(link);
    if (key == null) return null;
    keys.add(key);
  }
  return keys;
}

function linkTopologiesMatch(dest: unknown, live: unknown): boolean {
  const destLinks = linkTopologySet(dest);
  const liveLinks = linkTopologySet(live);
  if (!destLinks || !liveLinks || destLinks.size !== liveLinks.size) return false;
  for (const key of destLinks) if (!liveLinks.has(key)) return false;
  return true;
}

function stableWidgetsDisagree(destNode: Record<string, unknown>, liveNode: Record<string, unknown>): boolean {
  const destNamed = namedWidgets(destNode);
  if (destNamed) {
    const liveMap = namedWidgets(liveNode) ?? {};
    for (const [key, destVal] of Object.entries(destNamed)) {
      if (isEmptyWidgetValue(destVal)) continue;
      const liveVal = liveMap[key];
      if (isEmptyWidgetValue(liveVal) || valuesDiffer(liveVal, destVal)) return true;
    }
    return false;
  }
  if (!Array.isArray(destNode.widgets_values)) return false;
  const destWv = destNode.widgets_values;
  const liveWv = Array.isArray(liveNode.widgets_values) ? liveNode.widgets_values : [];
  for (let i = 0; i < destWv.length; i++) {
    if (isEmptyWidgetValue(destWv[i])) continue;
    if (isEmptyWidgetValue(liveWv[i]) || valuesDiffer(liveWv[i], destWv[i])) return true;
  }
  return false;
}

function graphStableWidgetsDisagree(dest: unknown, live: unknown): boolean {
  const destById = nodesById(dest);
  const liveById = nodesById(live);
  if (!destById || !liveById) return true;
  for (const [id, destNode] of destById) {
    const liveNode = liveById.get(id);
    if (!liveNode || stableWidgetsDisagree(destNode, liveNode)) return true;
  }
  return false;
}

function subgraphEntries(graph: unknown): unknown[] | null {
  if (!isPlainObject(graph)) return null;
  if (!Object.prototype.hasOwnProperty.call(graph, "definitions")) return [];
  const defs = graph.definitions;
  if (defs == null) return [];
  if (!isPlainObject(defs)) return null;
  if (!Object.prototype.hasOwnProperty.call(defs, "subgraphs")) return [];
  const subgraphs = defs.subgraphs;
  if (subgraphs == null) return [];
  if (Array.isArray(subgraphs)) return subgraphs;
  if (isPlainObject(subgraphs)) return Object.values(subgraphs);
  return null;
}

function subgraphsById(graph: unknown): Map<string, Record<string, unknown>> | null {
  const entries = subgraphEntries(graph);
  if (!entries) return null;
  const byId = new Map<string, Record<string, unknown>>();
  for (const raw of entries) {
    if (!isPlainObject(raw)) return null;
    if (typeof raw.id !== "string" && typeof raw.id !== "number") return null;
    const id = String(raw.id);
    if (byId.has(id)) return null;
    byId.set(id, raw);
  }
  return byId;
}

export function openLiveMatchesDestContent(live: unknown, dest: unknown): boolean {
  if (!nodeIdentitiesMatchAllowingRehydration(dest, live)) return false;
  if (!linkTopologiesMatch(dest, live)) return false;
  if (graphStableWidgetsDisagree(dest, live)) return false;
  const destSgs = subgraphsById(dest);
  const liveSgs = subgraphsById(live);
  if (!destSgs || !liveSgs) return false;
  for (const [id, destSg] of destSgs) {
    const liveSg = liveSgs.get(id);
    if (!liveSg) return false;
    if (!openLiveMatchesDestContent(liveSg, destSg)) return false;
  }
  return true;
}

/**
 * #2501 — dest vs live after reconnect, once identity and node id/type/link
 * topology already agree. The panel's post-restart serialize fills
 * inputs/outputs/properties and rewrites widgets_values / widgets_values_named
 * (envelopes, extra default slots, named-vs-positional). Those frontend-derived
 * bags are not a failed load.
 *
 * Additive to {@link openLiveMatchesDestContent}: named-first dest bags still
 * fail that matcher when live only holds positional/envelope widgets. Fail closed
 * on a missing node, a rewired link, or a dest widget value live does not hold.
 */
type FrontendWidgetAtom = string | number | boolean | null;
type FrontendWidgetValue =
  | FrontendWidgetAtom
  | FrontendWidgetAtom[]
  | Record<string, unknown>
  | undefined;

function asFrontendWidgetValue(value: unknown): FrontendWidgetValue {
  if (value === undefined || value === null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.every(
      (entry) =>
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "number" ||
        typeof entry === "boolean",
    )
      ? value
      : undefined;
  }
  return isPlainObject(value) ? value : undefined;
}

function frontendWidgetPrimitive(value: unknown): FrontendWidgetValue {
  if (!isPlainObject(value) || !Object.prototype.hasOwnProperty.call(value, "value")) {
    return asFrontendWidgetValue(value);
  }
  for (const key of Object.keys(value)) {
    if (key !== "name" && key !== "value" && key !== "type" && key !== "label") {
      return asFrontendWidgetValue(value);
    }
  }
  if (value.name != null && typeof value.name !== "string") return asFrontendWidgetValue(value);
  if (value.type != null && typeof value.type !== "string") return asFrontendWidgetValue(value);
  return asFrontendWidgetValue(value.value);
}

function frontendWidgetValuesEquivalent(a: unknown, b: unknown): boolean {
  const left = frontendWidgetPrimitive(a);
  const right = frontendWidgetPrimitive(b);
  if (Object.is(left, right)) return true;
  if (
    (typeof left === "number" && typeof right === "string") ||
    (typeof left === "string" && typeof right === "number")
  ) {
    const n = Number(left);
    const m = Number(right);
    if (Number.isFinite(n) && Number.isFinite(m) && n === m) return true;
  }
  return !valuesDiffer(left, right);
}

function destAuthoredWidgetSequence(node: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(node.widgets_values)) return node.widgets_values;
  const named = namedWidgets(node);
  return named ? Object.values(named) : null;
}

function liveSerializedWidgetSequence(node: Record<string, unknown>): unknown[] {
  if (Array.isArray(node.widgets_values)) return node.widgets_values;
  const named = namedWidgets(node);
  return named ? Object.values(named) : [];
}

function frontendStableWidgetsDisagree(
  destNode: Record<string, unknown>,
  liveNode: Record<string, unknown>,
): boolean {
  const destNamed = namedWidgets(destNode);
  const liveNamed = namedWidgets(liveNode);
  if (destNamed && liveNamed && !Array.isArray(destNode.widgets_values)) {
    for (const [key, destVal] of Object.entries(destNamed)) {
      if (isEmptyWidgetValue(destVal)) continue;
      const liveVal = liveNamed[key];
      if (isEmptyWidgetValue(liveVal) || !frontendWidgetValuesEquivalent(liveVal, destVal)) {
        return true;
      }
    }
    return false;
  }
  const destWv = destAuthoredWidgetSequence(destNode);
  if (!destWv) return false;
  const liveWv = liveSerializedWidgetSequence(liveNode);
  for (let i = 0; i < destWv.length; i++) {
    if (isEmptyWidgetValue(destWv[i])) continue;
    if (isEmptyWidgetValue(liveWv[i]) || !frontendWidgetValuesEquivalent(liveWv[i], destWv[i])) {
      return true;
    }
  }
  return false;
}

function graphFrontendStableWidgetsDisagree(dest: unknown, live: unknown): boolean {
  const destById = nodesById(dest);
  const liveById = nodesById(live);
  if (!destById || !liveById) return true;
  for (const [id, destNode] of destById) {
    const liveNode = liveById.get(id);
    if (!liveNode || frontendStableWidgetsDisagree(destNode, liveNode)) return true;
  }
  return false;
}

export function openLiveMatchesDestAfterReconnect(live: unknown, dest: unknown): boolean {
  if (!nodeIdentitiesMatchAllowingRehydration(dest, live)) return false;
  if (!linkTopologiesMatch(dest, live)) return false;
  if (graphFrontendStableWidgetsDisagree(dest, live)) return false;
  const destSgs = subgraphsById(dest);
  const liveSgs = subgraphsById(live);
  if (!destSgs || !liveSgs) return false;
  for (const [id, destSg] of destSgs) {
    const liveSg = liveSgs.get(id);
    if (!liveSg) return false;
    if (!openLiveMatchesDestAfterReconnect(liveSg, destSg)) return false;
  }
  return true;
}
