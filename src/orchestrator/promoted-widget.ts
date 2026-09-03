/**
 * #1655 — a widget the panel LISTS as promoted must be settable.
 *
 * `graph_set_widget` on a subgraph wrapper can refuse with:
 *
 *   Cannot set widget on subgraph node 78: "width" is not a promoted widget
 *   on this subgraph (promoted: width, height, seed, …)
 *
 * The listing is `node.widgets[].name`. The write looks up host INPUT names /
 * `_subgraphSlot` aliases. Those two sets disagree for proxyWidgets promotions
 * (krea2-txt2img-manual node 78: width/height exist as widgets, not as inputs),
 * so the refusal names the requested widget in its own "promoted:" list.
 *
 * Detection matches that contradiction only. A genuine miss ("foo" against
 * `promoted: width, height`) is left alone. Resolution maps the displayed name
 * to a UNIQUE inner node+widget from `graph_get_subgraph` — never by guessing
 * among several inners that share the name, and never from a truncated read.
 */

import { isNodeIdString, normalizeNodeId } from "./node-id.js";

export type ContradictoryPromotedWidgetRefusal = {
  nodeId: string;
  widget: string;
  listed: string[];
};

export type InnerPromotedTarget = {
  innerNodeId: number | string;
  widget: string;
  /** Opaque panel-owned identity of the immediate inner node, when published. */
  nodeIdentity?: string;
  /** Current-panel witnesses must prove the exact local parent rail that
   * serializes this promoted value. Legacy envelopes omit this proof. */
  parentRail?: PromotedParentRailWitness;
  /** Terminal concrete endpoint supplied by a receiver that can recursively
   * resolve nested promotion chains. Omitted for legacy one-hop envelopes. */
  terminal?: PromotedTerminalWitness;
};

export type PromotedTerminalInput = {
  name: string;
  type?: string;
};

export type PromotedTerminalWitness = {
  nodeId: number | string;
  nodeType: string;
  widget: string;
  inputs: PromotedTerminalInput[];
  chainDepth: number;
};

export type PromotedParentRailWitness = {
  authoritative: true;
  widget: string;
  /** Per-instance host-input identity when the panel exposes it. The final
   * dispatch still re-resolves the live object, but this catches a relink to
   * another promoted store entry with the same display name. */
  widgetId?: string;
};

type PromotedTerminalEntry = {
  widget: string;
  parentRail?: PromotedParentRailWitness;
  immediateNodeId?: number | string;
  immediateWidget?: string;
  terminal?: PromotedTerminalWitness;
  error?: string;
};

export type PromotedViewingIdentity = {
  scope: "root" | "subgraph";
  ownerNodeId: string | null;
  /** Older/current panels may omit this while the active workflow identity is unreadable. */
  workflowUuid?: string;
  /** Object-keyed live graph identity. Required before a promoted write. */
  graphIdentity?: string;
};

/** The stable scope witness carried from the promotion read to the inner write. */
export type PromotedScopeWitness = {
  workflowUuid?: string;
  ownerNodeId: string;
  graphIdentity: string;
};

export type PromotedSubgraphEnvelope = {
  nodes: Array<Record<string, unknown>>;
  nodeId: string;
  nodeCount: number;
  /** Identity of the target graph reached by entering this wrapper. */
  targetGraphIdentity?: string;
  viewing?: PromotedViewingIdentity;
  promotedTerminals?: PromotedTerminalEntry[];
};

export type AmbiguousPromotedWidgetRefusal = {
  nodeId: string;
  widget: string;
  matches: number;
};

/** Panel warning when an inner write landed on a link-driven widget. The stored
 *  value is verified, but the enclosing subgraph input is what actually renders. */
export type LinkDrivenPromotedWriteWarning = {
  widget: string;
};

export type SubgraphScopeRefusal = {
  nodeId: string;
  enterPath: string[];
};

const CONTRADICTORY_RE =
  /Cannot set widget on subgraph node (\S+): "([^"]+)" is not a promoted widget on this subgraph \(promoted: ([^)]+)\)/i;

const AMBIGUOUS_RE =
  /(?:panel_set_widget refused "([^"]+)" on node (\S+)[\s\S]*?)?promoted widget "([^"]+)" is ambiguous\s*[—-]\s*(\d+)\s+promoted inputs? match/i;

const LINK_DRIVEN_RE =
  /will NOT change the render[\s\S]*widget "([^"]+)" on inner node is link-driven[\s\S]*ENCLOSING subgraph node/i;

const SCOPED_NODE_RE = /No node with id (\S+) in the current graph[\s\S]*?lives INSIDE a subgraph/i;
const ENTER_PATH_RE = /panel_enter_subgraph\((?:node_id=)?\s*([^)]+)\)/gi;

/** Exact name first; a unique case-insensitive hit is accepted so a listed
 *  `width` still matches a caller who sent `Width`. Several CI hits refuse. */
export function matchListedName(wanted: string, listed: readonly string[]): string | null {
  if (listed.includes(wanted)) return wanted;
  const ci = listed.filter((n) => n.toLowerCase() === wanted.toLowerCase());
  return ci.length === 1 ? ci[0] : null;
}

/**
 * Parse the panel's link-driven inner-write warning. Null unless the write was
 * verified AND the panel named the enclosing subgraph node as the durable target.
 * A success that does not carry both halves is left alone — that is often a
 * genuine inner widget, not a promoted input.
 */
export function parseLinkDrivenPromotedWriteWarning(
  text: string,
): LinkDrivenPromotedWriteWarning | null {
  const m = LINK_DRIVEN_RE.exec(text);
  if (!m) return null;
  const widget = m[1];
  return widget ? { widget } : null;
}

/**
 * Parse the panel's promoted-name/label ambiguity refusal. This is deliberately
 * diagnostic-only: the refusal proves that a blind second write could target the
 * wrong promoted rail, so callers must not turn the count into a guessed target.
 */
export function parseAmbiguousPromotedWidgetRefusal(
  text: string,
  requestedWidget?: string,
  requestedNodeId?: number | string,
): AmbiguousPromotedWidgetRefusal | null {
  const m = AMBIGUOUS_RE.exec(text);
  if (!m) return null;
  const widget = m[3] ?? m[1];
  if (!widget) return null;
  if (requestedWidget != null && requestedWidget.toLowerCase() !== widget.toLowerCase()) {
    return null;
  }
  const nodeId = m[2] ?? (requestedNodeId == null ? undefined : String(requestedNodeId));
  if (!nodeId) return null;
  const matches = Number(m[4]);
  if (!Number.isSafeInteger(matches) || matches < 2) return null;
  return { nodeId: nodeId.replace(/[,:]$/, ""), widget, matches };
}

/**
 * Parse the panel's pre-executor scope diagnosis. The enter path is taken only
 * from the panel's own `panel_enter_subgraph(...)` remedy, never inferred from a
 * node id or from a generic missing-node error.
 */
export function parseSubgraphScopeRefusal(
  text: string,
  requestedNodeId?: number | string,
): SubgraphScopeRefusal | null {
  const missing = SCOPED_NODE_RE.exec(text);
  if (!missing) return null;
  const nodeId = missing[1].replace(/[,:]$/, "");
  if (
    requestedNodeId != null &&
    String(requestedNodeId).replace(/[,:]$/, "") !== nodeId
  ) {
    return null;
  }

  const enterPath: string[] = [];
  ENTER_PATH_RE.lastIndex = 0;
  for (let m = ENTER_PATH_RE.exec(text); m; m = ENTER_PATH_RE.exec(text)) {
    const id = m[1].trim().replace(/[,:]$/, "");
    if (id) enterPath.push(id);
  }
  return enterPath.length > 0 ? { nodeId, enterPath } : null;
}

function parseListed(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed || /^none$/i.test(trimmed)) return [];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse the contradictory refusal. Returns null unless the requested widget
 * actually appears in the diagnostic's own promoted list — that is the bug.
 */
export function parseContradictoryPromotedWidgetRefusal(
  text: string,
  requestedWidget?: string,
): ContradictoryPromotedWidgetRefusal | null {
  const m = CONTRADICTORY_RE.exec(text);
  if (!m) return null;
  const listed = parseListed(m[3]);
  const fromError = matchListedName(m[2], listed);
  if (!fromError) return null;
  if (requestedWidget != null && matchListedName(requestedWidget, listed) == null) {
    return null;
  }
  const widget =
    requestedWidget != null ? (matchListedName(requestedWidget, listed) ?? fromError) : fromError;
  return { nodeId: m[1].replace(/[,:]$/, ""), widget, listed };
}

function terminalEntryMatchesDisplayedWidget(
  entry: PromotedTerminalEntry,
  displayedWidget: string,
): boolean {
  const wanted = displayedWidget.toLowerCase();
  if (entry.widget.toLowerCase() === wanted) return true;
  if (entry.immediateWidget && entry.immediateWidget.toLowerCase() === wanted) return true;
  return entry.terminal?.widget.toLowerCase() === wanted;
}

function selectPromotedTerminalEntries(
  entries: readonly PromotedTerminalEntry[],
  displayedWidget: string,
): PromotedTerminalEntry[] {
  const wanted = displayedWidget.toLowerCase();
  const byHostAlias = entries.filter((entry) => entry.widget.toLowerCase() === wanted);
  // Prefer the host/displayed alias. Inner/terminal names are only consulted
  // when no host alias matches, so a duplicated unrelated alias that happens
  // to carry the same immediate widget cannot veto this write (#2393 vs #2488).
  if (byHostAlias.length > 0) return byHostAlias;
  return entries.filter((entry) => terminalEntryMatchesDisplayedWidget(entry, displayedWidget));
}

function widgetNamesOnInner(node: Record<string, unknown>): string[] {
  const widgets = node.widgets;
  if (!widgets || typeof widgets !== "object" || Array.isArray(widgets)) return [];
  return Object.keys(widgets as Record<string, unknown>).filter((n) => n.length > 0);
}

/** True when `widget` is an inner input that is wired from another node — the
 * subgraph input-rail shape official templates use for promoted COMBOs. */
function innerWidgetIsRailBacked(node: Record<string, unknown>, widget: string): boolean {
  const inputs = node.inputs;
  if (!Array.isArray(inputs)) return false;
  const wanted = widget.toLowerCase();
  for (const raw of inputs) {
    if (!isRecord(raw) || typeof raw.name !== "string" || raw.name.toLowerCase() !== wanted) continue;
    const from = raw.connected_from;
    if (!isRecord(from)) continue;
    if (from.node_id === undefined || from.node_id === null) continue;
    if (typeof from.node_id !== "number" && typeof from.node_id !== "string") continue;
    return true;
  }
  return false;
}

function terminalInputsFromInnerNode(node: Record<string, unknown>): PromotedTerminalInput[] | null {
  if (!Object.prototype.hasOwnProperty.call(node, "inputs")) return [];
  const inputs = node.inputs;
  if (!Array.isArray(inputs)) return null;
  const out: PromotedTerminalInput[] = [];
  for (const raw of inputs) {
    if (!isRecord(raw) || typeof raw.name !== "string" || raw.name.length === 0) return null;
    if (raw.type !== undefined && typeof raw.type !== "string") return null;
    out.push({ name: raw.name, ...(raw.type !== undefined ? { type: raw.type } : {}) });
  }
  return out;
}

/**
 * #2393 recurrence — after an official template load, a promoted COMBO such as
 * `unet_name` can publish an incomplete own-entry (the host rail is a name-only
 * stub, so `_subgraphSlot` / parent-rail authentication fail) while the inner
 * listing still uniquely names the rail-backed loader. That inner widget is the
 * subgraph-definition store the queue reads when no per-instance widgetId exists.
 * Do not reuse an error entry's `immediate_node_id`: the live slot can point at
 * a different inner node after instance/definition input-count drift.
 */
function resolveRailBackedInnerFromEnvelope(
  envelope: { nodes: Array<Record<string, unknown>> },
  displayedWidget: string,
): InnerPromotedTarget | null {
  const hits: Array<{ node: Record<string, unknown>; id: number | string; widget: string }> = [];
  for (const node of envelope.nodes) {
    const id = innerNodeId(node);
    if (id == null) continue;
    const matched = matchListedName(displayedWidget, widgetNamesOnInner(node));
    if (!matched || !innerWidgetIsRailBacked(node, matched)) continue;
    hits.push({ node, id, widget: matched });
  }
  if (hits.length !== 1) return null;
  const hit = hits[0];
  const nodeType = hit.node.type;
  if (typeof nodeType !== "string" || nodeType.length === 0) return null;
  const inputs = terminalInputsFromInnerNode(hit.node);
  if (!inputs) return null;
  return {
    innerNodeId: hit.id,
    widget: hit.widget,
    ...(typeof hit.node.node_identity === "string" ? { nodeIdentity: hit.node.node_identity } : {}),
    terminal: {
      nodeId: hit.id,
      nodeType,
      widget: hit.widget,
      inputs,
      chainDepth: 0,
    },
  };
}

function inputName(value: unknown): string | null {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) return null;
  return value.name;
}

const PRIMITIVE_NODE_TYPE_RE =
  /^Primitive(?:Int|Float|Boolean|String|StringMultiline)$/;

function primitiveNodeType(innerNode: Record<string, unknown> | null | undefined, terminal?: PromotedTerminalWitness): string | null {
  if (isRecord(innerNode) && typeof innerNode.type === "string" && innerNode.type.length > 0) {
    return innerNode.type;
  }
  return terminal?.nodeType ?? null;
}

function innerHasNamedInput(
  innerNode: Record<string, unknown> | null | undefined,
  widget: string,
  terminal?: PromotedTerminalWitness,
): boolean {
  const wanted = widget.toLowerCase();
  if (isRecord(innerNode) && Array.isArray(innerNode.inputs)) {
    for (const raw of innerNode.inputs) {
      const name = inputName(raw);
      if (name && name.toLowerCase() === wanted) return true;
    }
  }
  return terminal?.inputs.some((input) => input.name.toLowerCase() === wanted) === true;
}

/**
 * #2500 — a Primitive* `value` widget that exists as a live input is driven by
 * the subgraph's promoted rail. Writing that inner widget reports success and
 * leaves the enclosing container (the value that serializes and renders)
 * unchanged. The enclosing subgraph widget is the write target. Converted
 * widgets on ordinary nodes (dynamic-combo children, etc.) are not this shape
 * unless an authoritative parent rail proves the inner input is that rail.
 * #2533 — same-name COMBO/STRING rails (unet_name, clip_name, labelled prompt)
 * with a parent-rail witness are the same store: the inner widget is live and
 * the container is what serializes. Incomplete own-entries (#2393) omit the
 * rail and keep the inner COMBO write.
 */
export function promotedInnerWidgetIsLinkDriven(
  innerNode: Record<string, unknown> | null | undefined,
  innerWidget: string,
  terminal?: PromotedTerminalWitness,
  parentRail?: PromotedParentRailWitness,
): boolean {
  if (innerWidget.toLowerCase() === "value") {
    const nodeType = primitiveNodeType(innerNode, terminal);
    if (nodeType && PRIMITIVE_NODE_TYPE_RE.test(nodeType) && innerHasNamedInput(innerNode, "value", terminal)) {
      return true;
    }
  }
  if (!parentRail) return false;
  return innerHasNamedInput(innerNode, innerWidget, terminal);
}

function innerNodeId(node: Record<string, unknown>): number | string | null {
  const id = node.id;
  return isNodeId(id) ? id : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNodeId(value: unknown): value is number | string {
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (typeof value !== "string" || !isNodeIdString(value)) return false;
  const normalized = normalizeNodeId(value);
  return typeof normalized === "string" || Number.isSafeInteger(normalized);
}

function canonicalPromotedNodeId(value: unknown): string | null {
  if (!isNodeId(value)) return null;
  const normalized = normalizeNodeId(value);
  return typeof normalized === "number"
    ? Number.isSafeInteger(normalized)
      ? String(normalized)
      : null
    : normalized;
}

export type HostPromotedWidgetMapping = {
  hostWidget: string;
  label?: string;
  type?: string;
  innerNodeId?: number | string;
};

function hostInputWidgetName(record: Record<string, unknown>): string | null {
  const widget = record.widget;
  if (typeof widget === "string" && widget.length > 0) return widget;
  if (isRecord(widget) && typeof widget.name === "string" && widget.name.length > 0) {
    return widget.name;
  }
  return null;
}

/**
 * #2791 — official Qwen Image host node 76 lists input label `prompt` mapped to
 * widget `text`. A unique host input that actually carries a widget binding is
 * the promoted rail to write when the terminal witness is incomplete. Name,
 * label, and widget-name aliases are accepted; two distinct host widgets that
 * all match the request are not.
 */
export function resolveHostPromotedWidgetMapping(
  hostNode: Record<string, unknown> | null | undefined,
  requestedWidget: string,
): HostPromotedWidgetMapping | null {
  if (!isRecord(hostNode) || requestedWidget.length === 0) return null;
  const inputs = hostNode.inputs;
  if (!Array.isArray(inputs)) return null;
  const wanted = requestedWidget.toLowerCase();
  const hits: HostPromotedWidgetMapping[] = [];
  for (const raw of inputs) {
    if (!isRecord(raw)) continue;
    const widgetName = hostInputWidgetName(raw);
    if (!widgetName) continue;
    const name = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : null;
    const label = typeof raw.label === "string" && raw.label.length > 0 ? raw.label : undefined;
    const aliases = [name, label, widgetName];
    if (!aliases.some((alias) => alias !== null && alias !== undefined && alias.toLowerCase() === wanted)) {
      continue;
    }
    const type = typeof raw.type === "string" && raw.type.length > 0 ? raw.type : undefined;
    hits.push({
      hostWidget: widgetName,
      ...(label ? { label } : {}),
      ...(type ? { type } : {}),
    });
  }
  if (hits.length === 0) return null;
  const hostWidgets = new Set(hits.map((hit) => hit.hostWidget.toLowerCase()));
  if (hostWidgets.size !== 1) return null;
  const hit = hits[0];
  const properties = isRecord(hostNode.properties) ? hostNode.properties : null;
  const proxyWidgets = properties?.proxyWidgets;
  if (Array.isArray(proxyWidgets)) {
    const innerIds: Array<number | string> = [];
    for (const relation of proxyWidgets) {
      if (!Array.isArray(relation) || relation.length < 2) continue;
      const innerId = relation[0];
      const innerWidget = relation[1];
      if (!isNodeId(innerId) || typeof innerWidget !== "string" || innerWidget.length === 0) continue;
      if (innerWidget.toLowerCase() !== hit.hostWidget.toLowerCase()) continue;
      innerIds.push(innerId);
    }
    if (innerIds.length === 1) hit.innerNodeId = innerIds[0];
  }
  return hit;
}

function innerTargetFromEnvelopeNode(
  node: Record<string, unknown>,
  widget: string,
): InnerPromotedTarget | null {
  const id = innerNodeId(node);
  if (id == null) return null;
  const nodeType = node.type;
  if (typeof nodeType !== "string" || nodeType.length === 0) return null;
  const matched =
    matchListedName(widget, widgetNamesOnInner(node)) ??
    (innerHasNamedInput(node, widget) ? widget : null);
  if (!matched) return null;
  const inputs = terminalInputsFromInnerNode(node);
  if (!inputs) return null;
  return {
    innerNodeId: id,
    widget: matched,
    ...(typeof node.node_identity === "string" ? { nodeIdentity: node.node_identity } : {}),
    terminal: {
      nodeId: id,
      nodeType,
      widget: matched,
      inputs,
      chainDepth: 0,
    },
  };
}

/**
 * Map a host-proven promoted STRING onto the unique inner terminal named by
 * `proxyWidgets` or, failing that, the unique rail-backed inner widget. A miss
 * is not an ordinary-widget proof.
 */
export function resolveInnerFromHostPromotedMapping(
  subgraph: Record<string, unknown> | null | undefined,
  mapping: HostPromotedWidgetMapping,
  ownerNodeId: number | string,
): InnerPromotedTarget | null {
  const envelope = validatePromotedSubgraphEnvelope(subgraph, ownerNodeId);
  if (!envelope) return null;
  if (mapping.innerNodeId !== undefined) {
    const targetId = canonicalPromotedNodeId(mapping.innerNodeId);
    if (!targetId) return null;
    const node = envelope.nodes.find((candidate) => {
      const candidateId = innerNodeId(candidate);
      return candidateId !== null && canonicalPromotedNodeId(candidateId) === targetId;
    });
    if (!node) return null;
    return innerTargetFromEnvelopeNode(node, mapping.hostWidget);
  }
  return resolveRailBackedInnerFromEnvelope(envelope, mapping.hostWidget);
}

/** #2791 — host detail uniquely proved a STRING rail, and the inner terminal
 * agrees with that widget. Incomplete witnesses may then write the host. */
export function isHostProvenPromotedStringWrite(
  mapping: HostPromotedWidgetMapping | null | undefined,
  inner: InnerPromotedTarget | null | undefined,
): boolean {
  if (!mapping || !inner) return false;
  if (mapping.type !== "STRING") return false;
  if (inner.widget.toLowerCase() !== mapping.hostWidget.toLowerCase()) return false;
  if (!inner.terminal || inner.terminal.chainDepth !== 0) return false;
  if (mapping.innerNodeId !== undefined) {
    const mapped = canonicalPromotedNodeId(mapping.innerNodeId);
    const innerId = canonicalPromotedNodeId(inner.innerNodeId);
    if (!mapped || !innerId || mapped !== innerId) return false;
  }
  const named = inner.terminal.inputs.find(
    (input) => input.name.toLowerCase() === inner.widget.toLowerCase(),
  );
  if (named?.type !== undefined && named.type !== "STRING") return false;
  return true;
}

/** Parse the panel's structured current-graph identity without accepting a
 * prose/detail fallback. The panel deliberately omits workflow_uuid when the
 * live workflow identity cannot be read; owner_node_id remains the required
 * subgraph witness for this promoted mapping. */
export function parsePromotedViewingIdentity(value: unknown): PromotedViewingIdentity | null {
  if (!isRecord(value)) return null;
  const scope = value.scope;
  if (scope !== "root" && scope !== "subgraph") return null;
  const workflowUuid = value.workflow_uuid;
  if (workflowUuid !== undefined && (typeof workflowUuid !== "string" || workflowUuid.length === 0)) {
    return null;
  }
  const graphIdentity = value.graph_identity;
  if (
    graphIdentity !== undefined &&
    (typeof graphIdentity !== "string" || graphIdentity.length === 0 || graphIdentity.length > 256)
  ) {
    return null;
  }

  const rawOwner = value.owner_node_id;
  let ownerNodeId: string | null = null;
  if (rawOwner !== undefined && rawOwner !== null) {
    ownerNodeId = canonicalPromotedNodeId(rawOwner);
    if (!ownerNodeId) return null;
  }
  return {
    scope,
    ownerNodeId,
    ...(workflowUuid !== undefined ? { workflowUuid } : {}),
    ...(graphIdentity !== undefined ? { graphIdentity } : {}),
  };
}

/**
 * #2688 — WHY THIS RETURNS A REASON AND NOT JUST `null`.
 *
 * This validator has ~20 distinct rejection exits and every one of them used to
 * surface as a single sentence: "graph_get_subgraph returned a malformed,
 * stale, or incomplete ownership envelope", followed by "retry only after the
 * panel binding and subgraph mapping are stable".
 *
 * That sentence is undiagnosable AND its remedy is wrong. Every check below is
 * a pure function of ONE reply captured in ONE snapshot, so none of them is a
 * binding state that settles: the reporter re-opened the workflow, re-bound the
 * tab, and retried, and got the identical refusal every time, with no exit from
 * the loop and nothing to report except "something in the envelope was wrong".
 *
 * The reason strings are deliberately SHAPE-ONLY — field paths, array indices,
 * counts, and the two node ids that were compared (one of which is the caller's
 * own argument). No widget name, no widget value, no node type, no title.
 * Naming the failed invariant must not become a way to read a graph the fence
 * is refusing to write to.
 *
 * The fence itself does not move. {@link validatePromotedSubgraphEnvelope} is
 * this function with the reason discarded, so accept/reject is one decision in
 * one place and cannot drift between the diagnostic and the authorization.
 */
export type PromotedSubgraphEnvelopeResult =
  | { ok: true; envelope: PromotedSubgraphEnvelope }
  | { ok: false; invariant: string };

function envelopeInvariant(invariant: string): { ok: false; invariant: string } {
  return { ok: false, invariant };
}

/**
 * Validate the ownership and completeness claims made by graph_get_subgraph,
 * and name the first claim that failed.
 *
 * A node list is useful for a promoted write only when it names the wrapper the
 * caller asked about and contains exactly the advertised number of inner nodes.
 * The panel currently emits `truncated:false` for complete reads, but omission
 * remains accepted for older compatible replies; any asserted truncation is not.
 */
export function describePromotedSubgraphEnvelope(
  subgraph: Record<string, unknown> | null | undefined,
  ownerNodeId: number | string,
): PromotedSubgraphEnvelopeResult {
  if (!isRecord(subgraph)) {
    return envelopeInvariant("the reply was not a JSON object");
  }
  if (subgraph.truncated !== undefined && subgraph.truncated !== false) {
    return envelopeInvariant(
      "the reply's `truncated` flag was not `false`, so the inner node list it carried " +
        "cannot be taken as the whole subgraph",
    );
  }

  const viewing = Object.prototype.hasOwnProperty.call(subgraph, "viewing")
    ? parsePromotedViewingIdentity(subgraph.viewing)
    : undefined;
  if (Object.prototype.hasOwnProperty.call(subgraph, "viewing") && !viewing) {
    return envelopeInvariant(
      "`viewing` was present but did not parse as a graph-scope identity " +
        '(`scope` must be "root" or "subgraph"; `owner_node_id` must be a node id or null; ' +
        "`workflow_uuid` and `graph_identity`, when present, must be non-empty strings)",
    );
  }

  const owner = subgraph.subgraph_of;
  if (!isRecord(owner)) {
    return envelopeInvariant("`subgraph_of` was missing or not an object");
  }
  if (!isNodeId(owner.node_id)) {
    return envelopeInvariant("`subgraph_of.node_id` was missing or not a node id");
  }
  if (!isNodeId(ownerNodeId)) {
    return envelopeInvariant("the addressed node id was not a usable node id");
  }
  if (!sameNodeId(owner.node_id, ownerNodeId)) {
    return envelopeInvariant(
      `\`subgraph_of.node_id\` named node ${stripNodeId(String(owner.node_id))}, ` +
        `not the addressed node ${stripNodeId(String(ownerNodeId))}`,
    );
  }
  const targetGraphIdentity = owner.graph_identity;
  if (
    targetGraphIdentity !== undefined &&
    (typeof targetGraphIdentity !== "string" ||
      targetGraphIdentity.length === 0 ||
      targetGraphIdentity.length > 256)
  ) {
    return envelopeInvariant(
      "`subgraph_of.graph_identity` was present but not a string of 1-256 characters",
    );
  }

  const nodeCount = subgraph.node_count;
  const nodes = subgraph.nodes;
  if (!Number.isSafeInteger(nodeCount) || (nodeCount as number) < 0) {
    return envelopeInvariant("`node_count` was missing or not a non-negative integer");
  }
  if (!Array.isArray(nodes)) {
    return envelopeInvariant("`nodes` was missing or not an array");
  }
  if (nodes.length !== nodeCount) {
    return envelopeInvariant(
      `\`node_count\` claimed ${nodeCount as number} inner node(s) but \`nodes\` carried ${nodes.length}`,
    );
  }

  const normalized: Array<Record<string, unknown>> = [];
  // Indexed, not `nodes.entries()`: the array is parsed from an untrusted reply
  // and `entries` is an own-property a caller can shadow, which would iterate
  // something other than what `nodes.length !== nodeCount` was checked against.
  // The loops this replaced walked `Symbol.iterator`; an index walks neither.
  for (let index = 0; index < nodes.length; index += 1) {
    const raw: unknown = nodes[index];
    if (!isRecord(raw) || innerNodeId(raw) == null) {
      return envelopeInvariant(`\`nodes[${index}]\` was not an object carrying a usable \`id\``);
    }
    const nodeIdentity = raw.node_identity;
    if (
      nodeIdentity !== undefined &&
      (typeof nodeIdentity !== "string" || nodeIdentity.length === 0 || nodeIdentity.length > 256)
    ) {
      return envelopeInvariant(
        `\`nodes[${index}].node_identity\` was present but not a string of 1-256 characters`,
      );
    }
    normalized.push(raw);
  }
  let promotedTerminals: PromotedTerminalEntry[] | undefined;
  if (Object.prototype.hasOwnProperty.call(subgraph, "promoted_terminals")) {
    const parsed = describePromotedTerminalEntries(subgraph.promoted_terminals);
    if (!parsed.ok) return envelopeInvariant(parsed.invariant);
    promotedTerminals = parsed.entries;
  }
  return {
    ok: true,
    envelope: {
      nodes: normalized,
      nodeId: stripNodeId(String(owner.node_id)),
      nodeCount: nodeCount as number,
      ...(targetGraphIdentity !== undefined ? { targetGraphIdentity } : {}),
      ...(viewing ? { viewing } : {}),
      ...(promotedTerminals ? { promotedTerminals } : {}),
    },
  };
}

/**
 * The fence. Identical accept/reject to
 * {@link describePromotedSubgraphEnvelope} by construction — it IS that
 * function with the reason dropped, so a diagnostic change can never widen
 * what authorizes a promoted write.
 */
export function validatePromotedSubgraphEnvelope(
  subgraph: Record<string, unknown> | null | undefined,
  ownerNodeId: number | string,
): PromotedSubgraphEnvelope | null {
  const result = describePromotedSubgraphEnvelope(subgraph, ownerNodeId);
  return result.ok ? result.envelope : null;
}

type PromotedTerminalEntriesResult =
  | { ok: true; entries: PromotedTerminalEntry[] }
  | { ok: false; invariant: string };

/**
 * The witness array is ALL-OR-NOTHING: one unusable entry refuses every
 * promoted write on the wrapper, including widgets whose own entry is fine.
 * That is deliberate — an array that cannot be fully parsed is not evidence of
 * a complete alias mapping, and a partial mapping is exactly what would let a
 * renamed promotion resolve to the wrong terminal. So each reason below names
 * the OFFENDING INDEX, because the caller's own widget is usually not it.
 */
function describePromotedTerminalEntries(value: unknown): PromotedTerminalEntriesResult {
  if (!Array.isArray(value)) {
    return envelopeInvariant("`promoted_terminals` was present but not an array");
  }
  const at = (index: number, detail: string) =>
    envelopeInvariant(`\`promoted_terminals[${index}]\` ${detail}`);
  const entries: PromotedTerminalEntry[] = [];
  // Indexed for the same reason as the node loop above.
  for (let index = 0; index < value.length; index += 1) {
    const raw: unknown = value[index];
    if (!isRecord(raw)) return at(index, "was not an object");
    if (typeof raw.widget !== "string" || raw.widget.length === 0) {
      return at(index, "had a missing or empty `widget`");
    }
    const immediateNodeId = raw.immediate_node_id;
    if (immediateNodeId !== undefined && !isNodeId(immediateNodeId)) {
      return at(index, "carried an `immediate_node_id` that is not a node id");
    }
    const immediateWidget = raw.immediate_widget;
    if (
      immediateWidget !== undefined &&
      (typeof immediateWidget !== "string" || immediateWidget.length === 0)
    ) {
      return at(index, "carried an `immediate_widget` that is not a non-empty string");
    }
    const error = raw.error;
    if (error !== undefined && (typeof error !== "string" || error.length === 0)) {
      return at(index, "carried an `error` that is not a non-empty string");
    }
    const terminalRaw =
      raw.terminal_node_id === undefined && raw.terminal_node_type === undefined ? undefined : raw;
    const parentRailRaw = raw.parent_rail;
    let parentRail: PromotedParentRailWitness | undefined;
    let terminal: PromotedTerminalWitness | undefined;
    if (terminalRaw) {
      if (error !== undefined) {
        return at(
          index,
          "published a terminal endpoint AND an `error`; a witness is one or the other",
        );
      }
      if (immediateNodeId === undefined) {
        return at(index, "published a terminal endpoint without `immediate_node_id`");
      }
      if (immediateWidget === undefined) {
        return at(index, "published a terminal endpoint without `immediate_widget`");
      }
      if (
        !isRecord(parentRailRaw) ||
        parentRailRaw.authoritative !== true ||
        typeof parentRailRaw.widget !== "string" ||
        parentRailRaw.widget.length === 0
      ) {
        return at(
          index,
          "published a terminal endpoint without a `parent_rail` asserting `authoritative:true` and a non-empty `widget`",
        );
      }
      const parentRailWidgetId = parentRailRaw.widget_id;
      if (
        parentRailWidgetId !== undefined &&
        (typeof parentRailWidgetId !== "string" || parentRailWidgetId.length === 0)
      ) {
        return at(index, "carried a `parent_rail.widget_id` that is not a non-empty string");
      }
      parentRail = {
        authoritative: true,
        widget: parentRailRaw.widget,
        ...(parentRailWidgetId !== undefined ? { widgetId: parentRailWidgetId } : {}),
      };
      if (!isNodeId(terminalRaw.terminal_node_id)) {
        return at(index, "carried a `terminal_node_id` that is missing or not a node id");
      }
      if (
        typeof terminalRaw.terminal_node_type !== "string" ||
        terminalRaw.terminal_node_type.length === 0
      ) {
        return at(index, "carried a `terminal_node_type` that is missing or not a non-empty string");
      }
      if (
        typeof terminalRaw.terminal_widget !== "string" ||
        terminalRaw.terminal_widget.length === 0
      ) {
        return at(index, "carried a `terminal_widget` that is missing or not a non-empty string");
      }
      const chainDepth = terminalRaw.chain_depth;
      if (
        !Number.isSafeInteger(chainDepth) ||
        (chainDepth as number) < 0 ||
        (chainDepth as number) > 16
      ) {
        return at(index, "carried a `chain_depth` that is missing or outside 0-16");
      }
      if (!Array.isArray(terminalRaw.terminal_inputs)) {
        return at(index, "carried a `terminal_inputs` that is missing or not an array");
      }
      const inputs: PromotedTerminalInput[] = [];
      const rawInputs: unknown[] = terminalRaw.terminal_inputs;
      for (let inputIndex = 0; inputIndex < rawInputs.length; inputIndex += 1) {
        const input: unknown = rawInputs[inputIndex];
        if (!isRecord(input) || typeof input.name !== "string" || input.name.length === 0) {
          return at(
            index,
            `carried a \`terminal_inputs[${inputIndex}]\` without a non-empty \`name\``,
          );
        }
        if (input.type !== undefined && typeof input.type !== "string") {
          return at(index, `carried a \`terminal_inputs[${inputIndex}].type\` that is not a string`);
        }
        inputs.push({ name: input.name, ...(input.type !== undefined ? { type: input.type } : {}) });
      }
      terminal = {
        nodeId: terminalRaw.terminal_node_id,
        nodeType: terminalRaw.terminal_node_type,
        widget: terminalRaw.terminal_widget,
        inputs,
        chainDepth: chainDepth as number,
      };
    } else if (error === undefined) {
      return at(
        index,
        "published neither a terminal endpoint (`terminal_node_id`/`terminal_node_type`) nor an `error`, " +
          "so the witness array cannot be read as a complete alias mapping",
      );
    }
    entries.push({
      widget: raw.widget,
      ...(parentRail ? { parentRail } : {}),
      ...(immediateNodeId !== undefined ? { immediateNodeId } : {}),
      ...(immediateWidget !== undefined ? { immediateWidget } : {}),
      ...(terminal ? { terminal } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  }
  return { ok: true, entries };
}

/** Extract the target owner and workflow identity from a validated promotion
 * envelope. The caller must keep this witness with the resolved inner mapping;
 * a later inner-id/type match without it is not sufficient because ids are
 * local to the currently viewed graph. */
export function promotedScopeWitnessFromEnvelope(
  envelope: PromotedSubgraphEnvelope | null,
): PromotedScopeWitness | null {
  if (!envelope?.viewing) return null;
  const ownerNodeId = canonicalPromotedNodeId(envelope.nodeId);
  if (!ownerNodeId || typeof envelope.targetGraphIdentity !== "string") return null;
  return {
    ...(envelope.viewing.workflowUuid !== undefined
      ? { workflowUuid: envelope.viewing.workflowUuid }
      : {}),
    ownerNodeId,
    graphIdentity: envelope.targetGraphIdentity,
  };
}

/** A post-entry graph query must prove that the panel is viewing the exact
 * subgraph owned by the wrapper that produced the promotion mapping. */
export function promotedViewingMatchesScope(
  payload: Record<string, unknown> | null,
  expected: PromotedScopeWitness,
): boolean {
  const viewing = parsePromotedViewingIdentity(payload?.viewing);
  return (
    viewing?.scope === "subgraph" &&
    viewing.ownerNodeId === expected.ownerNodeId &&
    (expected.workflowUuid === undefined || viewing.workflowUuid === expected.workflowUuid) &&
    viewing.graphIdentity === expected.graphIdentity
  );
}

/**
 * Map a displayed promoted name to the unique inner node that owns a widget
 * of that name. `graph_get_subgraph` does not ship a reliable promotion
 * pairing across frontend versions, so uniqueness is the only attribution
 * we will act on. A truncated inner list cannot prove uniqueness.
 */
export function resolveInnerPromotedTarget(
  subgraph: Record<string, unknown> | null | undefined,
  displayedWidget: string,
  ownerNodeId?: number | string,
): InnerPromotedTarget | null {
  const envelope =
    ownerNodeId === undefined
      ? isRecord(subgraph) && subgraph.truncated !== true && Array.isArray(subgraph.nodes)
        ? { nodes: subgraph.nodes.filter(isRecord) }
        : null
      : validatePromotedSubgraphEnvelope(subgraph, ownerNodeId);
  if (!envelope) return null;

  const promotedTerminals =
    "promotedTerminals" in envelope ? envelope.promotedTerminals : undefined;
  if (promotedTerminals !== undefined) {
    // Current panels publish the authoritative alias -> immediate -> terminal
    // relation. Prefer it over the legacy same-name scan: renamed outer and
    // intermediate aliases are valid addresses, while the inner node summary
    // intentionally contains only the concrete widget's programmatic name.
    // #2488 — the caller may address the host with either the displayed alias
    // (`frame_counts`) or the inner programmatic name (`length`). Both names
    // identify the same unique promotion; uniqueness is still required.
    const entries = selectPromotedTerminalEntries(promotedTerminals, displayedWidget);
    if (entries.length !== 1) return null;
    const entry = entries[0];
    // A complete own-entry is still the preferred mapping. An incomplete own-entry
    // is not authorization to trust its immediate ids — those can be the drifted
    // live slot. Fall back only to a unique rail-backed same-name inner widget.
    if (entry.error) return resolveRailBackedInnerFromEnvelope(envelope, displayedWidget);
    if (
      !entry.terminal ||
      !entry.parentRail ||
      entry.immediateNodeId === undefined ||
      !entry.immediateWidget
    ) {
      return null;
    }
    const immediateId = canonicalPromotedNodeId(entry.immediateNodeId);
    if (!immediateId) return null;
    const immediateNode = envelope.nodes.find((node) => {
      const candidateId = innerNodeId(node);
      return candidateId !== null && canonicalPromotedNodeId(candidateId) === immediateId;
    });
    if (!immediateNode) return null;
    return {
      innerNodeId: entry.immediateNodeId,
      widget: entry.immediateWidget,
      ...(typeof immediateNode.node_identity === "string"
        ? { nodeIdentity: immediateNode.node_identity }
        : {}),
      parentRail: entry.parentRail,
      terminal: entry.terminal,
    };
  }

  const hits: InnerPromotedTarget[] = [];
  for (const node of envelope.nodes) {
    const id = innerNodeId(node);
    if (id == null) continue;
    const matched = matchListedName(displayedWidget, widgetNamesOnInner(node));
    if (matched) {
      hits.push({
        innerNodeId: id,
        widget: matched,
        ...(typeof node.node_identity === "string" ? { nodeIdentity: node.node_identity } : {}),
      });
    }
  }
  if (hits.length !== 1) return null;
  return hits[0];
}

/**
 * Resolve only the legacy same-name relation. A payload from a receiver that
 * does not advertise `promoted_terminals` is not allowed to use an unadvertised
 * witness array as an ordinary-write proof: that array may be partial on a
 * capability-skewed panel. Legacy compatibility is therefore limited to the
 * old, positive inner-node/name match; a miss remains indeterminate.
 */
export function resolveLegacyInnerPromotedTarget(
  subgraph: Record<string, unknown> | null | undefined,
  displayedWidget: string,
  ownerNodeId?: number | string,
): InnerPromotedTarget | null {
  if (!isRecord(subgraph)) return null;
  const { promoted_terminals: _untrustedWitnesses, ...legacyPayload } = subgraph;
  return resolveInnerPromotedTarget(legacyPayload, displayedWidget, ownerNodeId);
}

/** True when the refusal listed `requestedWidget` as promoted. */
export function isContradictoryPromotedWidgetRefusal(
  text: string,
  requestedWidget: string,
): boolean {
  return parseContradictoryPromotedWidgetRefusal(text, requestedWidget) != null;
}

/**
 * panel#1558 — a successful promoted write can still be ephemeral: the inner
 * widget is governed by control_after_generate='randomize', and that control
 * is NOT promoted onto the subgraph node the caller addressed. The panel
 * warns and names an enter → set-inner-fixed → exit sequence the caller
 * cannot follow without hidden inner ids.
 *
 * Only this unpromoted-inner shape is parsed. A DIRECT seed warning (control
 * already on the addressed node) is left alone — randomize there is often
 * intentional. A "promoted as" outer-node remedy is also left alone: that
 * write is already parent-scope.
 */
export type UnpromotedControlPersistRemedy = {
  outerNodeId: string;
  enterPath: string[];
  innerNodeId: string;
  controlWidget: string;
  exitCount: number;
  mode: string;
};

const WILL_NOT_PERSIST_RE = /will NOT persist/i;
const NOT_PROMOTED_RE = /is NOT promoted onto subgraph node (\S+)/i;
const ENTER_RE = /panel_enter_subgraph\(node_id=([^)]+)\)/gi;
const SET_FIXED_RE =
  /panel_set_widget\(node_id=([^,]+),\s*widget='([^']+)',\s*value='fixed'\)/i;
const EXIT_TIMES_RE = /panel_exit_subgraph\(\)\s+(\d+)\s+times/i;
const MODE_RE = /control_after_generate='([^']+)'/i;

function stripNodeId(raw: string): string {
  return raw.trim().replace(/[,:]$/, "");
}

function sameNodeId(a: unknown, b: unknown): boolean {
  return stripNodeId(String(a)) === stripNodeId(String(b));
}

/** Parse the panel#650 unpromoted-control persist warning. Null unless the
 *  value will not persist AND the control is only reachable by entering. */
export function parseUnpromotedControlPersistRemedy(
  text: string,
): UnpromotedControlPersistRemedy | null {
  if (!WILL_NOT_PERSIST_RE.test(text)) return null;
  const notPromoted = NOT_PROMOTED_RE.exec(text);
  if (!notPromoted) return null;
  const outerNodeId = stripNodeId(notPromoted[1]);
  if (!outerNodeId) return null;

  const enterPath: string[] = [];
  ENTER_RE.lastIndex = 0;
  for (let m = ENTER_RE.exec(text); m; m = ENTER_RE.exec(text)) {
    const id = stripNodeId(m[1]);
    if (id) enterPath.push(id);
  }
  if (enterPath.length === 0) return null;

  const setFixed = SET_FIXED_RE.exec(text);
  if (!setFixed) return null;
  const innerNodeId = stripNodeId(setFixed[1]);
  const controlWidget = setFixed[2];
  if (!innerNodeId || !controlWidget) return null;
  if (sameNodeId(innerNodeId, outerNodeId)) return null;

  const times = EXIT_TIMES_RE.exec(text);
  const parsedTimes = times ? Number(times[1]) : NaN;
  const exitCount =
    Number.isFinite(parsedTimes) && parsedTimes > 0 ? parsedTimes : enterPath.length;

  const modeMatch = MODE_RE.exec(text);
  const mode = modeMatch?.[1] && modeMatch[1] !== "fixed" ? modeMatch[1] : "randomize";

  return { outerNodeId, enterPath, innerNodeId, controlWidget, exitCount, mode };
}

export function addressedNodeMatchesPersistRemedy(
  addressedNodeId: unknown,
  remedy: UnpromotedControlPersistRemedy,
): boolean {
  return (
    sameNodeId(addressedNodeId, remedy.outerNodeId) ||
    sameNodeId(addressedNodeId, remedy.enterPath[0])
  );
}

/**
 * #2514 — the panel's #1087 warning for a DIRECT write to a widget that is
 * link-driven from a promoted subgraph input. That warning tells the caller
 * to set the widget on the ENCLOSING subgraph node. It is contradictory when
 * MCP already remapped a parent-addressed write onto that inner widget.
 */
const INNER_LINK_DRIVEN_WARNING_RE =
  /will NOT change the render[\s\S]*\blink-driven\b[\s\S]*ENCLOSING subgraph node/i;

export function isInnerLinkDrivenWriteWarning(text: string): boolean {
  return INNER_LINK_DRIVEN_WARNING_RE.test(text);
}

export type ParentAuthoritativePromotedWrite = {
  nodeId: number | string;
  widget: string;
  synced: boolean;
};

/**
 * Shape a remapped promoted-write receipt around the parent the caller
 * addressed. The inner link-driven warning is dropped only on that path;
 * an unrelated warning (control_after_generate, etc.) is left in place.
 * `set` is rewritten to the parent-facing widget only when the parent
 * rail was actually synced — otherwise the inner assignment stands.
 */
export function shapeParentAuthoritativePromotedWrite(
  payload: Record<string, unknown>,
  parent: ParentAuthoritativePromotedWrite,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...payload };
  if (typeof next.warning === "string" && isInnerLinkDrivenWriteWarning(next.warning)) {
    delete next.warning;
  }
  if (parent.synced) {
    next.parent_widget_synced = true;
    const set = next.set;
    if (set && typeof set === "object" && !Array.isArray(set)) {
      next.set = {
        ...(set as Record<string, unknown>),
        node_id: parent.nodeId,
        widget: parent.widget,
      };
    }
    const promotedFrom = next.promoted_from;
    if (promotedFrom && typeof promotedFrom === "object" && !Array.isArray(promotedFrom)) {
      next.promoted_from = {
        ...(promotedFrom as Record<string, unknown>),
        parent_widget_synced: true,
      };
    }
  }
  return next;
}
