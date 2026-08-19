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
