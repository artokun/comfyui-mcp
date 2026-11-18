/**
 * #2931 / #2933 — node-keyed `panel_set_widget` refusals for widgets whose
 * frontend code owns the value that actually executes.
 *
 * - ComfyUI-Lora-Manager (#2931): the loader nodes declare BOTH an
 *   `AUTOCOMPLETE_TEXT_LORAS` `text` widget and a DOM-backed `LORAS` `loras`
 *   widget. Python deletes or ignores `text` and applies only `loras`, which the
 *   pack's own editor fills from typed text. A programmatic `text` write reads
 *   back equal and still loads no LoRA, so a read-back cannot certify it — this
 *   is a refusal, not a receipt.
 * - ComfyUI-MiniMaxH3-Easy (#2933): `web/minimax_h3_easy_ui.js` installs a
 *   prompt editor on three node types. `onSerialize` copies the editor document
 *   over widget `prompt`, and its `graphToPrompt` hook rebuilds the queued prompt
 *   from the editor unless the `prompt` input is LINKED, in which case the link
 *   is kept. `h3_prompt_mentions` is that editor's `serialize: false` DOM widget
 *   and never reaches the backend.
 *
 * Keyed on the proven node TYPE. The widget ADDRESS is resolved the way the panel
 * resolves it (exact name, `NAME[i]`, dotted base, case-insensitive name, unique
 * display label), so an alias cannot walk past a name-keyed refusal. An unknown
 * type is never refused here.
 */

import { backendStringProducerConnectAdvice } from "./primitive-force-input-connect.js";

type DerivedWidgetRule = {
  widgets: ReadonlySet<string>;
  /** Widgets whose established promoted host-rail route reaches execution by LINK
   *  (the host subgraph input drives the inner input socket). Only these may be
   *  written through that route; a direct inner write stays refused. */
  linkedHostRouteWidgets: ReadonlySet<string>;
  reason: (type: string, widget: string) => string;
  remedy: (type: string) => string;
};

const LORA_MANAGER_WIDGETS: ReadonlySet<string> = new Set(["text", "loras"]);

/** Text-driven replacement per LoraManager widget node, where the pack has one. */
const LORA_MANAGER_TEXT_LOADER: Readonly<Record<string, string>> = {
  "Lora Loader (LoraManager)": "LoRA Text Loader (LoraManager)",
  "WanVideo Lora Select (LoraManager)": "WanVideo Lora Select From Text (LoraManager)",
};

const LORA_MANAGER_RULE: DerivedWidgetRule = {
  widgets: LORA_MANAGER_WIDGETS,
  // The backend ignores `text` however it is supplied, so no route is exempt.
  linkedHostRouteWidgets: new Set(),
  reason: (type, widget) =>
    widget === "text"
      ? `${type} ignores "text" at execution — the backend applies only the DOM-backed ` +
        `"loras" list, which the node's own editor fills from typed text. A "text" write ` +
        `would read back as set and still load no LoRA.`
      : `"loras" on ${type} is owned by the node's custom LoRA-list widget; a programmatic ` +
        `write does not stick, and the backend executes whatever that widget holds.`,
  remedy: (type) => {
    const textLoader = LORA_MANAGER_TEXT_LOADER[type];
    return textLoader
      ? `Use "${textLoader}" instead: its lora_syntax input is a forceInput STRING. ` +
          `${backendStringProducerConnectAdvice("lora_syntax")} ` +
          `Or edit the LoRA rows in this node's UI.`
      : `Edit the LoRA rows in this node's UI.`;
  },
};

const MINIMAX_H3_EASY_WIDGETS: ReadonlySet<string> = new Set(["prompt", "h3_prompt_mentions"]);

const MINIMAX_H3_EASY_RULE: DerivedWidgetRule = {
  widgets: MINIMAX_H3_EASY_WIDGETS,
  linkedHostRouteWidgets: new Set(["prompt"]),
  reason: (type, widget) =>
    widget === "prompt"
      ? `${type}'s prompt editor copies its own document over widget "prompt" on serialize, ` +
        `and its queue hook rebuilds an unlinked prompt from that editor, so a widget write ` +
        `does not reach execution.`
      : `"h3_prompt_mentions" on ${type} is the prompt editor's frontend-only DOM widget ` +
        `(serialize: false); it is never sent to the backend.`,
  remedy: () =>
    `Drive the prompt by link: ${backendStringProducerConnectAdvice("prompt")} A linked ` +
    `prompt input is what executes and makes the editor read-only. Or type the text in the ` +
    `node's own prompt editor.`,
};

const DERIVED_WIDGET_RULES: ReadonlyMap<string, DerivedWidgetRule> = new Map([
  ["Lora Loader (LoraManager)", LORA_MANAGER_RULE],
  ["Lora Stacker (LoraManager)", LORA_MANAGER_RULE],
  ["WanVideo Lora Select (LoraManager)", LORA_MANAGER_RULE],
  ["Create Hook LoRA (LoraManager)", LORA_MANAGER_RULE],
  ["MiniMaxH3Easy", MINIMAX_H3_EASY_RULE],
  ["MiniMaxH3EasyContextSegments", MINIMAX_H3_EASY_RULE],
  ["MiniMaxH3EasySelectedVideoContext", MINIMAX_H3_EASY_RULE],
]);

const ALL_DERIVED_WIDGET_NAMES: ReadonlySet<string> = new Set([
  ...LORA_MANAGER_WIDGETS,
  ...MINIMAX_H3_EASY_WIDGETS,
]);

const OCCURRENCE_SELECTOR = /^(.+)\[(\d+)\]$/;

/** Every name the address could reach under ANY of the panel's name forms, lower-cased.
 *  Deliberately broad: it only decides whether an untyped write is worth one identity
 *  probe, never whether an address is safe. */
function broadCandidates(address: string): string[] {
  const out = [address];
  const whole = address.match(OCCURRENCE_SELECTOR);
  if (whole) out.push(whole[1]);
  const dot = address.indexOf(".");
  if (dot > 0) {
    const head = address.slice(0, dot);
    out.push(head);
    const headSelector = head.match(OCCURRENCE_SELECTOR);
    if (headSelector) out.push(headSelector[1]);
  }
  return out.map((candidate) => candidate.toLowerCase());
}

/** True when `nodeType` has a derived-widget rule. */
export function isKnownDerivedNodeType(nodeType: string | undefined): boolean {
  return nodeType !== undefined && DERIVED_WIDGET_RULES.has(nodeType);
}

/** True when `address` could name a guarded widget on SOME known type under any name
 *  form (`text`, `TEXT`, `text[0]`, `TEXT.x`, …). An untyped write to such an address
 *  is worth one identity probe; the probe's row then decides. */
export function addressMayNameDerivedWidget(address: string): boolean {
  const candidates = broadCandidates(address);
  for (const name of ALL_DERIVED_WIDGET_NAMES) {
    if (candidates.includes(name.toLowerCase())) return true;
  }
  return false;
}

/** True when `widget` (a canonical name echoed by the panel) is guarded on some type. */
export function isDerivedWidgetName(widget: string): boolean {
  return ALL_DERIVED_WIDGET_NAMES.has(widget);
}

/**
 * The guarded widget `address` reaches on `nodeType` WITHOUT reading the node, or null.
 * Only forms whose resolution cannot depend on display labels are decided here, in the
 * panel's order (`resolveWidgetAddress`, then `resolveWidgetByName`): the exact name, a
 * `NAME[i]` selector on an exact name, an exact dotted base, a selector on an exact
 * dotted base, and a whole-string case-insensitive name (#524 — when one exists the
 * panel skips its label step). Anything else, e.g. a case-folded dotted base, can be
 * pre-empted by a label and needs {@link resolveDerivedAddressFromRow}.
 */
export function knownDerivedWidgetForAddress(nodeType: string, address: string): string | null {
  const rule = DERIVED_WIDGET_RULES.get(nodeType);
  if (!rule) return null;
  if (rule.widgets.has(address)) return address;
  const whole = address.match(OCCURRENCE_SELECTOR);
  if (whole && rule.widgets.has(whole[1])) return whole[1];
  const dot = address.indexOf(".");
  if (dot > 0) {
    const head = address.slice(0, dot);
    if (rule.widgets.has(head)) return head;
    const headSelector = head.match(OCCURRENCE_SELECTOR);
    if (headSelector && rule.widgets.has(headSelector[1])) return headSelector[1];
  }
  const lowered = address.toLowerCase();
  for (const name of rule.widgets) {
    if (name.toLowerCase() === lowered) return name;
  }
  return null;
}

export type DerivedAddressResolution =
  | { kind: "safe" }
  | { kind: "guarded"; widget: string }
  | { kind: "unresolved"; reason: string };

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The panel's `resolveWidgetByName` (#524): an exact name, else the ONE name that
 *  matches case-insensitively; several case-insensitive matches resolve nothing. */
function nameLookup(wanted: string, names: ReadonlySet<string>): string | null {
  if (names.has(wanted)) return wanted;
  const lowered = wanted.toLowerCase();
  const folded = [...names].filter((name) => name.toLowerCase() === lowered);
  return folded.length === 1 ? folded[0] : null;
}

/**
 * Resolve `address` on a node of a KNOWN derived type from its live detail row
 * (`widgets`, `widget_labels`, `duplicate_widgets`), following the panel's precedence:
 * `resolveWidgetAddress` (exact name; whole `NAME[i]`; exact dotted base; `NAME[i]` on
 * the dotted base; display label, skipped when any name matches the whole string
 * case-insensitively), then the write's `resolveWidgetByName` (#524 unique
 * case-insensitive whole name), then its #560 dotted base through that same lookup.
 * No other semantics are added. A row the read could not carry completely, or a label
 * two widgets carry (which the panel refuses), is `unresolved`; an address that reaches
 * no widget is `safe` because the panel refuses it as missing.
 */
export function resolveDerivedAddressFromRow(
  nodeType: string,
  address: string,
  row: Record<string, unknown>,
): DerivedAddressResolution {
  const rule = DERIVED_WIDGET_RULES.get(nodeType);
  if (!rule) return { kind: "safe" };
  const byName = knownDerivedWidgetForAddress(nodeType, address);
  if (byName) return { kind: "guarded", widget: byName };

  const widgets = recordOf(row.widgets);
  if (!widgets) return { kind: "unresolved", reason: "the node row carried no widget names" };
  if (Object.prototype.hasOwnProperty.call(widgets, "…")) {
    return { kind: "unresolved", reason: "the node row omitted widgets to fit its budget" };
  }
  const duplicates = recordOf(row.duplicate_widgets) ?? {};
  const names: ReadonlySet<string> = new Set([...Object.keys(widgets), ...Object.keys(duplicates)]);
  const verdict = (name: string): DerivedAddressResolution =>
    rule.widgets.has(name) ? { kind: "guarded", widget: name } : { kind: "safe" };

  // resolveWidgetAddress steps 1-4: exact spellings only.
  if (names.has(address)) return verdict(address);
  const whole = address.match(OCCURRENCE_SELECTOR);
  if (whole && names.has(whole[1])) return verdict(whole[1]);
  const dot = address.indexOf(".");
  const head = dot > 0 ? address.slice(0, dot) : null;
  if (head !== null) {
    if (names.has(head)) return verdict(head);
    const headSelector = head.match(OCCURRENCE_SELECTOR);
    if (headSelector && names.has(headSelector[1])) return verdict(headSelector[1]);
  }

  // Step 5: display labels, unless a name matches the whole string case-insensitively.
  const lowered = address.toLowerCase();
  const foldedWhole = [...names].some((name) => name.toLowerCase() === lowered);
  if (!foldedWhole) {
    const labelled = new Set<string>();
    const labels = recordOf(row.widget_labels) ?? {};
    for (const [name, label] of Object.entries(labels)) {
      if (label === address) labelled.add(name);
    }
    for (const [name, rows] of Object.entries(duplicates)) {
      if (!Array.isArray(rows)) continue;
      for (const entry of rows) {
        if (recordOf(entry)?.label === address) labelled.add(name);
      }
    }
    if (labelled.size > 1) {
      return { kind: "unresolved", reason: `more than one widget is labelled "${address}"` };
    }
    const [labelledName] = labelled;
    if (labelledName !== undefined) return verdict(labelledName);
  }

  // The write's own lookup: #524 on the whole string, then the #560 dotted base.
  const folded = nameLookup(address, names);
  if (folded) return verdict(folded);
  if (head !== null) {
    const base = nameLookup(head, names);
    if (base) return verdict(base);
  }
  // No name or label reaches a widget: the panel refuses it as a missing widget.
  return { kind: "safe" };
}

/** The refusal text for a proven `nodeType` + canonical `widget`, or null when the
 *  pair is not a known derived write. `address` is what the caller sent when it
 *  differs from the canonical name; `linkedHostRoute` marks the established
 *  promoted host-rail route, which only the rule's linked widgets may take. */
export function knownDerivedWidgetRefusalText(
  nodeType: string,
  widget: string,
  opts: { address?: string; linkedHostRoute?: boolean } = {},
): string | null {
  const rule = DERIVED_WIDGET_RULES.get(nodeType);
  if (!rule || !rule.widgets.has(widget)) return null;
  if (opts.linkedHostRoute === true && rule.linkedHostRouteWidgets.has(widget)) return null;
  const addressed =
    opts.address !== undefined && opts.address !== widget ? ` (addressed as "${opts.address}")` : "";
  return (
    `panel_set_widget cannot set "${widget}"${addressed} on ${nodeType}. ` +
    `${rule.reason(nodeType, widget)} No graph_set_widget was dispatched. ${rule.remedy(nodeType)} ` +
    `Do not retry panel_set_widget on this widget.`
  );
}
