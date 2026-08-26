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

export type SubgraphScopeRefusal = {
  nodeId: string;
  enterPath: string[];
};

const CONTRADICTORY_RE =
  /Cannot set widget on subgraph node (\S+): "([^"]+)" is not a promoted widget on this subgraph \(promoted: ([^)]+)\)/i;

const AMBIGUOUS_RE =
  /(?:panel_set_widget refused "([^"]+)" on node (\S+)[\s\S]*?)?promoted widget "([^"]+)" is ambiguous\s*[—-]\s*(\d+)\s+promoted inputs? match/i;

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

function widgetNamesOnInner(node: Record<string, unknown>): string[] {
  const widgets = node.widgets;
  if (!widgets || typeof widgets !== "object" || Array.isArray(widgets)) return [];
  return Object.keys(widgets as Record<string, unknown>).filter((n) => n.length > 0);
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
 * Validate the ownership and completeness claims made by graph_get_subgraph.
 * A node list is useful for a promoted write only when it names the wrapper the
 * caller asked about and contains exactly the advertised number of inner nodes.
 * The panel currently emits `truncated:false` for complete reads, but omission
 * remains accepted for older compatible replies; any asserted truncation is not.
 */
export function validatePromotedSubgraphEnvelope(
  subgraph: Record<string, unknown> | null | undefined,
  ownerNodeId: number | string,
): PromotedSubgraphEnvelope | null {
  if (!isRecord(subgraph)) return null;
  if (subgraph.truncated !== undefined && subgraph.truncated !== false) return null;

  const viewing = Object.prototype.hasOwnProperty.call(subgraph, "viewing")
    ? parsePromotedViewingIdentity(subgraph.viewing)
    : undefined;
  if (Object.prototype.hasOwnProperty.call(subgraph, "viewing") && !viewing) return null;

  const owner = subgraph.subgraph_of;
  if (
    !isRecord(owner) ||
    !isNodeId(owner.node_id) ||
    !isNodeId(ownerNodeId) ||
    !sameNodeId(owner.node_id, ownerNodeId)
  ) {
    return null;
  }
  const targetGraphIdentity = owner.graph_identity;
  if (
    targetGraphIdentity !== undefined &&
    (typeof targetGraphIdentity !== "string" ||
      targetGraphIdentity.length === 0 ||
      targetGraphIdentity.length > 256)
  ) {
    return null;
  }

  const nodeCount = subgraph.node_count;
  const nodes = subgraph.nodes;
  if (
    !Number.isSafeInteger(nodeCount) ||
    (nodeCount as number) < 0 ||
    !Array.isArray(nodes) ||
    nodes.length !== nodeCount
  ) {
    return null;
  }

  const normalized: Array<Record<string, unknown>> = [];
  for (const raw of nodes) {
    if (!isRecord(raw) || innerNodeId(raw) == null) return null;
    normalized.push(raw);
  }
  const promotedTerminals = Object.prototype.hasOwnProperty.call(subgraph, "promoted_terminals")
    ? parsePromotedTerminalEntries(subgraph.promoted_terminals)
    : undefined;
  if (Object.prototype.hasOwnProperty.call(subgraph, "promoted_terminals") && !promotedTerminals) {
    return null;
  }
  return {
    nodes: normalized,
    nodeId: stripNodeId(String(owner.node_id)),
    nodeCount: nodeCount as number,
    ...(targetGraphIdentity !== undefined ? { targetGraphIdentity } : {}),
    ...(viewing ? { viewing } : {}),
    ...(promotedTerminals ? { promotedTerminals } : {}),
  };
}

function parsePromotedTerminalEntries(value: unknown): PromotedTerminalEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: PromotedTerminalEntry[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.widget !== "string" || raw.widget.length === 0) return null;
    const immediateNodeId = raw.immediate_node_id;
    if (immediateNodeId !== undefined && !isNodeId(immediateNodeId)) return null;
    const immediateWidget = raw.immediate_widget;
    if (immediateWidget !== undefined && (typeof immediateWidget !== "string" || immediateWidget.length === 0)) {
      return null;
    }
    const error = raw.error;
    if (error !== undefined && (typeof error !== "string" || error.length === 0)) return null;
    const terminalRaw = raw.terminal_node_id === undefined && raw.terminal_node_type === undefined
      ? undefined
      : raw;
    const parentRailRaw = raw.parent_rail;
    let parentRail: PromotedParentRailWitness | undefined;
    let terminal: PromotedTerminalWitness | undefined;
    if (terminalRaw) {
      if (error !== undefined || immediateNodeId === undefined || immediateWidget === undefined) return null;
      if (
        !isRecord(parentRailRaw) ||
        parentRailRaw.authoritative !== true ||
        typeof parentRailRaw.widget !== "string" ||
        parentRailRaw.widget.length === 0
      ) {
        return null;
      }
      const parentRailWidgetId = parentRailRaw.widget_id;
      if (
        parentRailWidgetId !== undefined &&
        (typeof parentRailWidgetId !== "string" || parentRailWidgetId.length === 0)
      ) {
        return null;
      }
      parentRail = {
        authoritative: true,
        widget: parentRailRaw.widget,
        ...(parentRailWidgetId !== undefined ? { widgetId: parentRailWidgetId } : {}),
      };
      if (!isNodeId(terminalRaw.terminal_node_id)) return null;
      if (typeof terminalRaw.terminal_node_type !== "string" || terminalRaw.terminal_node_type.length === 0) {
        return null;
      }
      if (typeof terminalRaw.terminal_widget !== "string" || terminalRaw.terminal_widget.length === 0) {
        return null;
      }
      const chainDepth = terminalRaw.chain_depth;
      if (!Number.isSafeInteger(chainDepth) || (chainDepth as number) < 0 || (chainDepth as number) > 16) {
        return null;
      }
      if (!Array.isArray(terminalRaw.terminal_inputs)) return null;
      const inputs: PromotedTerminalInput[] = [];
      for (const input of terminalRaw.terminal_inputs) {
        if (!isRecord(input) || typeof input.name !== "string" || input.name.length === 0) return null;
        if (input.type !== undefined && typeof input.type !== "string") return null;
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
      return null;
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
  return entries;
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
    const entries = promotedTerminals.filter(
      (entry) => entry.widget.toLowerCase() === displayedWidget.toLowerCase(),
    );
    if (entries.length !== 1) return null;
    const entry = entries[0];
    if (
      entry.error ||
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
      parentRail: entry.parentRail,
      terminal: entry.terminal,
    };
  }

  const hits: InnerPromotedTarget[] = [];
  for (const node of envelope.nodes) {
    const id = innerNodeId(node);
    if (id == null) continue;
    const matched = matchListedName(displayedWidget, widgetNamesOnInner(node));
    if (matched) hits.push({ innerNodeId: id, widget: matched });
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
