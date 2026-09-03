/**
 * #1973 — panel_get_errors must not present a clean `errored_count: 0` while
 * its live combo scan still has nodes unchecked.
 *
 * The panel's graph_get_errors shares one elective server-call budget and
 * gives the live combo scan only a 4 s STEP cap (GET_ERRORS_STEP_CAP_MS), so a
 * ~77-node graph routinely returns `unchecked_budget_exhausted: true` with the
 * sampler / decoder / assembler / SaveVideo still in `unchecked_nodes`, plus
 * the clean-scan note. The orchestrator already waits 30 s for that reply, so
 * after a budget-exhausted payload it finishes the leftover nodes from ONE
 * batched `graph_get_object_info` plus bounded explicit-ID `graph_query` pages —
 * not another per-class round trip. If that completion cannot run, the reply still leads
 * with `audit_complete: false` and checked/unchecked counts rather than a
 * primary clean 0.
 *
 * TWO RULES THIS MODULE IS BUILT AROUND, both learned the expensive way:
 *
 * 1. ANY abstention makes the audit incomplete, not just a budget one. The
 *    panel abstains for five different reasons (live-combo-availability.js) and
 *    only two of them raise `unchecked_budget_exhausted`. The asset-probe cap,
 *    a failed /object_info lookup and an unanswered file check produce the
 *    SAME misread this issue reports — `errored_count: 0` first, "no errors
 *    recorded" attached — so completeness is judged from the abstention LIST,
 *    never from the budget flag alone.
 *
 * 2. This pass may retire an abstention; it may never manufacture a verdict the
 *    panel's own scanner would have refused to give. It has no /view probe, so
 *    on an UPLOAD input — the one option list ComfyUI structurally cannot
 *    enumerate (#1357/#387) — non-membership is not evidence of absence and the
 *    node stays unchecked. The upload-flag list here is ComfyUI's own
 *    (comfy_api/latest/_io.py `UploadType`), which is WIDER than the panel's:
 *    `UploadType.model` serialises as `file_upload`, and abstaining on a flag
 *    the panel misses is the fail-closed direction.
 */

import { LIMIT_CEILING, MAX_CHARS_CEILING } from "../services/graph-query.js";
import type { PanelToolCtx, ToolResult } from "./panel-tools.js";

/**
 * The panel reply this module rewrites. It must be the orchestrator's OWN
 * `ToolResult`, not a structurally-similar local alias: the alias compiled here
 * and then failed at the call site with TS2345, which is how #1981 reached CI
 * with a tree that does not build.
 */
export type GetErrorsToolResult = ToolResult;

/** Only the call surface this module uses, so a test can drive it with a stub. */
export type GetErrorsCallCtx = Pick<PanelToolCtx, "call" | "tabId">;

/**
 * The abstentions that a second, batched read can actually retire: the two the
 * panel raises when it runs out of the shared budget or its per-call class cap.
 * Everything else it abstains for (a failed lookup, an unanswered file probe,
 * the probe cap) is NOT retried here — but it still counts as an incomplete
 * audit. See `isGetErrorsAuditIncomplete`.
 */
const RETRYABLE_UNCHECKED_RE =
  /ran out of its shared server-call budget|lookup cap was reached/i;
const FILE_LIKE = /\.[A-Za-z0-9_]{2,12}$/;

/**
 * `graph_query` has no cursor/offset. Explicit-ID pages are therefore the only
 * pagination available to this completion pass, and keeping each detail page
 * small leaves room under its 60,000-character ceiling for ordinary workflows.
 * Pages are issued in graph order under one aggregate deadline; the graph-query
 * ceiling also bounds the pass at 200 leftover ids.
 */
const GET_ERRORS_QUERY_PAGE_SIZE = 10;

/**
 * ComfyUI's own upload-input flags, from `UploadType` in
 * comfy_api/latest/_io.py — image/audio/video plus `file_upload`, which is what
 * `UploadType.model` (Load3D, Load3DAnimation) serialises to. The panel's list
 * omits `file_upload`; matching ComfyUI rather than the panel is deliberate,
 * because every flag added here only ever makes this pass ABSTAIN more.
 * `model_upload` is kept for panels/packs that spell it that way.
 */
const UPLOAD_CONFIG_FLAGS = [
  "image_upload",
  "video_upload",
  "audio_upload",
  "model_upload",
  "file_upload",
] as const;

type UncheckedEntry = {
  id?: unknown;
  type?: unknown;
  widget?: unknown;
  value?: unknown;
  reason?: unknown;
};

type QueryNode = {
  id: unknown;
  type: string;
  widgets: Record<string, unknown>;
  linkedInputs: Set<string>;
};

type ViewingIdentity = Record<string, unknown>;

type FollowUpRead = {
  payload: Record<string, unknown> | null;
  stayedOnPrimaryTab: boolean;
};

const GET_ERRORS_DEADLINE = Symbol("get-errors-completion-deadline");

export function parseToolResultJson(res: GetErrorsToolResult): Record<string, unknown> | null {
  if (!res || res.isError) return null;
  const entry = res.content?.find((c) => c.type === "text");
  const text = entry && entry.type === "text" ? entry.text : undefined;
  if (typeof text !== "string") return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asUncheckedList(payload: Record<string, unknown>): UncheckedEntry[] {
  return Array.isArray(payload.unchecked_nodes)
    ? (payload.unchecked_nodes as UncheckedEntry[])
    : [];
}

/** Red outlines are normally cosmetic, but a stale LoadImage outline can hide a
 * current combo value that the panel would refuse to write. Keep this separate from
 * unchecked_nodes: a stale flag is not itself an abstention and must remain untouched
 * unless a fresh same-view graph/schema read proves the value is unavailable. */
function asStaleFlags(payload: Record<string, unknown>): UncheckedEntry[] {
  return Array.isArray(payload.stale_flags)
    ? (payload.stale_flags as UncheckedEntry[])
    : [];
}

/** An abstention a second batched read has a chance of retiring. */
function isRetryableUnchecked(entry: UncheckedEntry): boolean {
  return typeof entry?.reason === "string" && RETRYABLE_UNCHECKED_RE.test(entry.reason);
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** Distinct node ids the scan abstained on — same counting rule as the panel. */
export function uncheckedNodeCount(unchecked: UncheckedEntry[]): number {
  return new Set(unchecked.map((u, i) => (u?.id == null ? `#${i}` : `id:${String(u.id)}`))).size;
}

/**
 * Judged from the abstention LIST, not from the budget flag.
 *
 * `unchecked_budget_exhausted` covers only two of the panel's five abstention
 * reasons. A scan stopped by the file-probe cap emits `unchecked_nodes` and
 * `unchecked_asset_probe_limit` with NO budget flag, and the panel's own `clean`
 * predicate does not consider abstentions at all — so that payload ships
 * `errored_count: 0` plus "no errors recorded" next to a list of nodes nobody
 * judged. That is the reported misread with a different cause, and the reporter
 * asked for the completeness header "when ANY nodes are unchecked".
 */
export function isGetErrorsAuditIncomplete(payload: Record<string, unknown>): boolean {
  if (payload.unchecked_budget_exhausted === true) return true;
  if (payload.unchecked_class_limit != null) return true;
  if (payload.unchecked_asset_probe_limit != null) return true;
  return asUncheckedList(payload).length > 0;
}

/**
 * The option list for an input spec, in either schema form, or null when this
 * pass has no authority over it.
 *
 * ComfyUI serialises a V1 combo as `[[...allowed], {cfg}]` and a V3 one as
 * `["COMBO", {options: [...], ...}]` (`add_to_dict_v1` writes
 * `(io_type, as_dict())`). Both are read here. A MULTISELECT combo is refused:
 * its stored value is a selection of several options, so membership in the list
 * is the wrong question and asking it reports every such widget as invalid.
 */
function comboOptions(spec: unknown): string[] | null {
  if (!Array.isArray(spec) || spec.length === 0) return null;
  const cfg = spec[1] && typeof spec[1] === "object" && !Array.isArray(spec[1])
    ? (spec[1] as Record<string, unknown>)
    : null;
  if (cfg?.multiselect) return null;
  const type = spec[0];
  if (Array.isArray(type)) return type.filter((v): v is string => typeof v === "string");
  if (typeof type !== "string" || !/COMBO/i.test(type) || /DYNAMIC/i.test(type)) return null;
  const opts = cfg?.options;
  if (!Array.isArray(opts)) return null;
  const strings = opts.filter((v): v is string => typeof v === "string");
  return strings.length === opts.length ? strings : null;
}

/**
 * An UPLOAD input, whose valid values live on DISK and not only in the combo
 * snapshot. Any truthy flag counts — the panel reads these the same way
 * (`UPLOAD_CONFIG_FLAGS.some((f) => config[f])`), and a pack that writes `1`
 * rather than `true` must not fall through to a hard verdict.
 */
function isUploadCombo(spec: unknown): boolean {
  if (!Array.isArray(spec)) return false;
  const cfg = spec[1];
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return false;
  const c = cfg as Record<string, unknown>;
  return UPLOAD_CONFIG_FLAGS.some((f) => !!c[f]);
}

function optionsLookLikeFiles(options: string[]): boolean {
  if (options.length === 0) return false;
  return options.filter((s) => FILE_LIKE.test(s)).length * 2 >= options.length;
}

/**
 * Upload combos can carry paths that the combo list deliberately cannot
 * enumerate. The panel's /view probe is the authority for those values, so a
 * stale outline must remain unknown until that evidence exists. Root-level
 * names are different: those are the values the refreshed list is expected to
 * enumerate, which is the evidence #2587 needs for the missing-value report.
 */
function isNonEnumerableUploadPath(value: string): boolean {
  return /^\[(?:input|output|temp)\]/i.test(value) || /[\\/]/.test(value);
}

function rewriteTextPayload(res: GetErrorsToolResult, payload: Record<string, unknown>): GetErrorsToolResult {
  const idx = res.content.findIndex((c) => c.type === "text");
  if (idx < 0) return res;
  return {
    ...res,
    content: res.content.map((c, i) =>
      i === idx && c.type === "text" ? { ...c, text: JSON.stringify(payload, null, 2) } : c,
    ),
  };
}

function parseQueryNodes(query: Record<string, unknown>): QueryNode[] {
  const out: QueryNode[] = [];
  const take = (raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const n = raw as Record<string, unknown>;
    if (n.id == null) return;
    const type = typeof n.type === "string" ? n.type : typeof n.class_type === "string" ? n.class_type : "";
    const widgets =
      n.widgets && typeof n.widgets === "object" && !Array.isArray(n.widgets)
        ? (n.widgets as Record<string, unknown>)
        : {};
    const linkedInputs = new Set<string>();
    if (Array.isArray(n.inputs)) {
      for (const rawInput of n.inputs) {
        if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) continue;
        const input = rawInput as Record<string, unknown>;
        if (typeof input.name !== "string") continue;
        if (input.link != null || input.connected_from != null) linkedInputs.add(input.name);
      }
    }
    if (n.driven_by_link && typeof n.driven_by_link === "object" && !Array.isArray(n.driven_by_link)) {
      for (const name of Object.keys(n.driven_by_link)) linkedInputs.add(name);
    }
    out.push({ id: n.id, type, widgets, linkedInputs });
  };
  if (Array.isArray(query.nodes)) for (const n of query.nodes) take(n);
  if (typeof query.text === "string") {
    for (const line of query.text.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        take(JSON.parse(t));
      } catch {
        /* a compact/ids line is not a detail row */
      }
    }
  }
  return out;
}

function objectInfoFromReply(reply: Record<string, unknown>): Record<string, unknown> | null {
  const info = reply.object_info;
  if (info && typeof info === "object" && !Array.isArray(info) && Object.keys(info).length > 0) {
    return info as Record<string, unknown>;
  }
  // A panel that returns the map at the top level (no wrapper) is still a schema.
  const looksLikeDef = (v: unknown) =>
    !!v && typeof v === "object" && !Array.isArray(v) && ("input" in v || "output" in v);
  if (Object.values(reply).some(looksLikeDef) && !("cmd" in reply)) {
    return reply;
  }
  return null;
}

function inputSpecsOf(def: unknown): Record<string, unknown> {
  if (!def || typeof def !== "object" || Array.isArray(def)) return {};
  const input = (def as { input?: { required?: unknown; optional?: unknown } }).input;
  if (!input || typeof input !== "object") return {};
  return {
    ...(input.required && typeof input.required === "object" && !Array.isArray(input.required)
      ? input.required
      : {}),
    ...(input.optional && typeof input.optional === "object" && !Array.isArray(input.optional)
      ? input.optional
      : {}),
  };
}

type ComboJudgement = {
  unavailable: Array<Record<string, unknown>>;
  stillUnchecked: UncheckedEntry[];
};

type StaleLoadImageJudgement = {
  unavailable: Array<Record<string, unknown>>;
  reclassifiedIds: Set<string>;
};

function judgeLeftoverCombos(
  leftover: UncheckedEntry[],
  nodes: QueryNode[],
  objectInfo: Record<string, unknown>,
): ComboJudgement {
  const byId = new Map(nodes.map((n) => [String(n.id), n]));
  const unavailable: Array<Record<string, unknown>> = [];
  const stillUnchecked: UncheckedEntry[] = [];

  // One pass per leftover NODE: a budget skip is a node-level abstention, and
  // judging its combos from the batched schema retires that skip.
  const leftoverById = new Map<string, UncheckedEntry>();
  for (const entry of leftover) {
    if (entry?.id == null) {
      stillUnchecked.push(entry);
      continue;
    }
    leftoverById.set(String(entry.id), entry);
  }

  for (const [id, entry] of leftoverById) {
    const node = byId.get(id);
    const className = node?.type || (typeof entry.type === "string" ? entry.type : "");
    if (!node || !className) {
      stillUnchecked.push(entry);
      continue;
    }
    // Own properties only. `objectInfo[className]` walks the prototype, so a
    // leftover type named `toString` (or `constructor`, `valueOf`, …) against
    // any ordinary non-empty /object_info map would resolve to a Function,
    // look "found", yield no combo specs, and retire the node — audit_complete
    // with unchecked_count:0 for a class that is not in the schema at all.
    const def = Object.hasOwn(objectInfo, className) ? objectInfo[className] : undefined;
    if (!def) {
      stillUnchecked.push({
        id: node.id,
        type: className,
        reason: "node type not found in /object_info",
      });
      continue;
    }
    const specs = inputSpecsOf(def);
    const comboNames = Object.entries(specs)
      .filter(([, spec]) => comboOptions(spec) !== null)
      .map(([name]) => name);
    // A linked combo is driven by its upstream value, not by the stored widget
    // value. This completion pass has no execution-value probe, so it must not
    // judge the stale/absent stored value as if it were live.
    const linkedCombos = comboNames.filter((name) => node.linkedInputs.has(name));
    if (linkedCombos.length > 0) {
      stillUnchecked.push({
        ...entry,
        reason: `not checked: combo widget(s) ${linkedCombos.join(", ")} are driven by a live link`,
      });
      continue;
    }
    // A def with a combo input whose widget value is absent is an unread node,
    // even when another non-combo widget (for example seed) is present. The old
    // empty-map check retired { widgets: { seed: 1 }, linked checkpoint }.
    const unreadCombos = comboNames.filter((name) => !Object.hasOwn(node.widgets, name));
    if (unreadCombos.length > 0) {
      stillUnchecked.push(entry);
      continue;
    }
    for (const [name, value] of Object.entries(node.widgets)) {
      const spec = specs[name];
      const options = comboOptions(spec);
      if (!options) continue;
      if (typeof value !== "string" || value === "") continue;
      // Upload inputs can accept a freshly uploaded root-level filename that
      // never appears in /object_info's enumerated options. This pass has no
      // /view probe, so every non-member on an upload combo is uncheckable —
      // not a missing asset verdict.
      if (isUploadCombo(spec) && !options.includes(value)) {
        stillUnchecked.push({
          id: node.id,
          type: className,
          widget: name,
          value,
          reason:
            "not checked: this value names a file below the input root (or under an [output]/[temp]/[input] annotation), which /object_info's combo list cannot enumerate",
        });
        continue;
      }
      if (options.includes(value)) continue;
      unavailable.push({
        id: node.id,
        type: className,
        widget: name,
        value,
        option_count: options.length,
        kind: options.length === 0 || optionsLookLikeFiles(options) ? "missing_asset" : "invalid_value",
        // WHO JUDGED THIS. Until #1973 every entry in unavailable_widget_values came
        // from the panel's own scanner, so the field name carried an implied
        // provenance. Appending here silently invalidates that: this pass reads the
        // V3 `["COMBO", {...}]` form the panel's parseClassCombos structurally cannot
        // see, and it has no /view probe to fall back on. Merging an unvetted verdict
        // into a vetted list under the same field is the attribution defect — a reader
        // that cannot tell which scanner spoke cannot weigh the answer, and a wrong
        // entry here would be untraceable in a bug report.
        source: "orchestrator_completion",
      });
    }
  }

  return { unavailable, stillUnchecked };
}

/**
 * #2587 — a panel can leave a red LoadImage under `stale_flags` after its live
 * scan has otherwise completed. A fresh whole `/object_info` plus a detail read
 * of the same graph can turn that particular cosmetic flag into an actionable
 * unavailable widget finding. This is deliberately narrower than the budget
 * completion scanner: only the concrete LoadImage.image combo is reclassified,
 * and only when both reads prove the current node and current view.
 *
 * Upload-input paths that are not enumerated by `/object_info` stay unknown here:
 * only the panel's `/view`/existence evidence can distinguish a valid nested or
 * annotated path from a missing file. A root-level value absent from the refreshed
 * list is the #2587 case. Unreadable schema, missing node detail, a linked image
 * input, and a value that is present in the list all preserve the original stale
 * flag.
 */
function judgeStaleLoadImages(
  staleFlags: UncheckedEntry[],
  nodes: QueryNode[],
  objectInfo: Record<string, unknown>,
): StaleLoadImageJudgement {
  const byId = new Map(nodes.map((n) => [String(n.id), n]));
  const unavailable: Array<Record<string, unknown>> = [];
  const reclassifiedIds = new Set<string>();

  for (const flag of staleFlags) {
    if (flag?.id == null || flag.type !== "LoadImage") continue;
    const node = byId.get(String(flag.id));
    if (!node || node.type !== "LoadImage" || node.linkedInputs.has("image")) continue;
    const def = Object.hasOwn(objectInfo, "LoadImage") ? objectInfo.LoadImage : undefined;
    const specs = inputSpecsOf(def);
    const options = comboOptions(specs.image);
    if (!options || !Object.hasOwn(node.widgets, "image")) continue;
    const value = node.widgets.image;
    if (typeof value !== "string" || value === "") continue;
    if (options.includes(value)) continue;
    if (isUploadCombo(specs.image) && isNonEnumerableUploadPath(value)) continue;

    unavailable.push({
      id: node.id,
      type: "LoadImage",
      widget: "image",
      value,
      option_count: options.length,
      kind: options.length === 0 || optionsLookLikeFiles(options) ? "missing_asset" : "invalid_value",
      source: "orchestrator_completion",
    });
    reclassifiedIds.add(String(flag.id));
  }

  return { unavailable, reclassifiedIds };
}

function mergeUnavailable(
  existing: unknown,
  extra: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const cur = Array.isArray(existing) ? [...(existing as Array<Record<string, unknown>>)] : [];
  const seen = new Set(
    cur.map((u) => JSON.stringify([u?.id, u?.widget, u?.value])),
  );
  for (const u of extra) {
    const key = JSON.stringify([u.id, u.widget, u.value]);
    if (seen.has(key)) continue;
    seen.add(key);
    cur.push(u);
  }
  return cur;
}

/**
 * Every surface in this payload that contradicts "no errors recorded".
 *
 * STRUCTURAL ON PURPOSE — the predicate this replaces matched the panel's note
 * prose (`/no errors recorded since the last execution/`), and that note ships
 * through `tr()`. It is translated in all twelve bundled locales, so on a
 * Japanese or French panel the match failed and the clean note survived beside
 * a populated `unavailable_widget_values`: exactly the #399/#984
 * self-contradiction, invisible to any English test.
 */
function payloadHasDefects(payload: Record<string, unknown>): boolean {
  const nonEmpty = (k: string) => Array.isArray(payload[k]) && (payload[k] as unknown[]).length > 0;
  if (typeof payload.errored_count === "number" && payload.errored_count > 0) return true;
  if (payload.node_errors != null && Object.keys(payload.node_errors as object).length > 0) return true;
  if (payload.last_execution_error != null) return true;
  if (typeof payload.missing_node_count === "number" && payload.missing_node_count > 0) return true;
  return (
    nonEmpty("unavailable_widget_values") ||
    nonEmpty("missing_models") ||
    nonEmpty("missing_media") ||
    nonEmpty("missing_node_types") ||
    nonEmpty("stale_placeholders")
  );
}

/**
 * Put audit completeness FIRST so `errored_count: 0` cannot be read as a
 * finished clean scan, and never ship the panel's "no errors recorded" note
 * beside something that contradicts it.
 */
export function presentGetErrorsAudit(payload: Record<string, unknown>): Record<string, unknown> {
  const incomplete = isGetErrorsAuditIncomplete(payload);
  const unchecked = asUncheckedList(payload);
  const uncheckedCount = uncheckedNodeCount(unchecked);
  const nodeCount = typeof payload.node_count === "number" && Number.isFinite(payload.node_count)
    ? payload.node_count
    : null;
  const checkedCount =
    nodeCount != null ? Math.max(0, nodeCount - uncheckedCount) : null;

  const note = payload.note;
  const rest: Record<string, unknown> = { ...payload };
  delete rest.note;
  delete rest.audit_complete;
  delete rest.audit_incomplete_reason;
  delete rest.checked_count;
  delete rest.unchecked_count;
  const out: Record<string, unknown> = {};
  out.audit_complete = !incomplete;
  if (incomplete) {
    out.audit_incomplete_reason =
      payload.unchecked_budget_exhausted === true
        ? "get_errors ran out of its shared server-call budget"
        : "some nodes were not judged before the scan stopped";
  }
  if (nodeCount != null) out.node_count = nodeCount;
  if (checkedCount != null) out.checked_count = checkedCount;
  out.unchecked_count = uncheckedCount;
  if ("errored_count" in rest) {
    out.errored_count = rest.errored_count;
    delete rest.errored_count;
  }
  delete rest.node_count;
  for (const [k, v] of Object.entries(rest)) {
    if (!(k in out)) out[k] = v;
  }
  if (incomplete) {
    const shown = typeof out.errored_count === "number" ? out.errored_count : 0;
    out.note =
      `AUDIT INCOMPLETE: ${uncheckedCount} node(s) were not checked. ` +
      `errored_count (${shown}) counts only the nodes this scan judged — ` +
      `it is not a clean bill of health for the rest.`;
  } else if (typeof note === "string" && !payloadHasDefects(payload)) {
    out.note = note;
  }
  return out;
}

async function followUpJson(
  ctx: GetErrorsCallCtx,
  cmd: Record<string, unknown>,
  timeoutMs: number,
  deadlineAt: number,
  primaryTabId?: string,
): Promise<FollowUpRead> {
  const tabBefore = ctx.tabId;
  const remaining = Math.min(timeoutMs, deadlineAt - Date.now());
  if (!(remaining > 0)) {
    return {
      payload: null,
      stayedOnPrimaryTab: primaryTabId == null || tabBefore === primaryTabId,
    };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<typeof GET_ERRORS_DEADLINE>((resolve) => {
      timer = setTimeout(() => resolve(GET_ERRORS_DEADLINE), remaining);
    });
    const res = await Promise.race([ctx.call(cmd, remaining), timeout]);
    if (res === GET_ERRORS_DEADLINE) {
      return {
        payload: null,
        stayedOnPrimaryTab: primaryTabId == null || tabBefore === primaryTabId,
      };
    }
    const tabAfter = ctx.tabId;
    return {
      payload: parseToolResultJson(res),
      stayedOnPrimaryTab:
        primaryTabId == null || (tabBefore === primaryTabId && tabAfter === primaryTabId),
    };
  } catch {
    return {
      payload: null,
      stayedOnPrimaryTab: primaryTabId == null || tabBefore === primaryTabId,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function viewingIdentity(payload: Record<string, unknown> | null): ViewingIdentity | null {
  const raw = payload?.viewing;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as ViewingIdentity;
  const keys = [
    "workflow_uuid",
    "workflow",
    "graph_identity",
    "kind",
    "scope",
    "owner_node_id",
    "title",
  ];
  const identity = Object.fromEntries(keys.filter((key) => key in v).map((key) => [key, v[key]]));
  return Object.keys(identity).length > 0 ? identity : null;
}

function queryReplyWasTruncated(payload: Record<string, unknown> | null): boolean {
  if (!payload) return true;
  if (payload.truncated === true) return true;
  return (
    typeof payload.matched === "number" &&
    typeof payload.shown === "number" &&
    payload.shown < payload.matched
  );
}

/**
 * A follow-up may only retire leftovers when it identifies the same live graph
 * as the primary read. Compare every stable identity field both replies expose;
 * requiring a shared field makes an omitted/opaque identity fail closed.
 */
function sameViewingIdentity(
  primary: Record<string, unknown> | null,
  followUp: Record<string, unknown> | null,
): boolean {
  const a = viewingIdentity(primary);
  const b = viewingIdentity(followUp);
  if (!a || !b) return false;
  // Scope and owner/title are not workflow-instance identity. A tab can switch
  // from root workflow A to root workflow B, or from subgraph A to a same-shaped
  // subgraph B, without changing the tab id. The panel's graph replies publish
  // the root workflow_uuid for this purpose; without it, never retire A's
  // leftovers from an opaque follow-up read.
  if (typeof a.workflow_uuid !== "string" || typeof b.workflow_uuid !== "string") return false;
  if (!Object.is(a.workflow_uuid, b.workflow_uuid)) return false;
  // A path is useful corroboration when both replies publish one, but it cannot
  // replace the per-instance UUID: the same saved path may be reopened in place.
  if ("workflow" in a || "workflow" in b) {
    if (!("workflow" in a) || !("workflow" in b) || !Object.is(a.workflow, b.workflow)) return false;
  }
  // Ownerless subgraphs in one workflow are still distinct graphs. A graph
  // replacement/reconnect can also retain the workflow UUID while changing
  // this object-keyed identity, so never let an omitted or mismatched witness
  // retire the primary read's leftovers.
  if ("graph_identity" in a || "graph_identity" in b) {
    if (
      typeof a.graph_identity !== "string" ||
      typeof b.graph_identity !== "string" ||
      a.graph_identity.length === 0 ||
      b.graph_identity.length === 0 ||
      !Object.is(a.graph_identity, b.graph_identity)
    ) {
      return false;
    }
  }
  const shared = Object.keys(a).filter((key) => key in b);
  return shared.length > 0 && shared.every((key) => Object.is(a[key], b[key]));
}

/**
 * After a graph_get_errors, finish retryable combo checks and stale LoadImage
 * reclassification from one batched object_info + bounded targeted graph_query
 * pages, then present completeness honestly. Never throws: a failed follow-up
 * leaves the original audit untouched.
 *
 * A payload the panel already finished still goes through presentGetErrorsAudit.
 * Completeness is not consistency: `errored_count: 0` plus a translated
 * "no errors recorded" note beside `unavailable_widget_values` is a completed
 * audit that still contradicts itself. Skipping the sanitizer because nobody
 * was left unchecked is how that contradiction would ship.
 */
export async function completeGetErrorsAudit(
  ctx: GetErrorsCallCtx,
  res: GetErrorsToolResult,
  timeoutMs: number,
  primaryTabId?: string,
): Promise<GetErrorsToolResult> {
  const payload = parseToolResultJson(res);
  if (!payload) return res;
  const staleLoadImageFlags = asStaleFlags(payload).filter((entry) => entry?.type === "LoadImage");
  if (!isGetErrorsAuditIncomplete(payload) && staleLoadImageFlags.length === 0) {
    return rewriteTextPayload(res, presentGetErrorsAudit(payload));
  }

  const leftover = asUncheckedList(payload).filter(isRetryableUnchecked);
  const leftoverIds = [
    ...new Set(leftover.map((e) => e.id).filter((id) => id != null)),
  ];
  const staleLoadImageIds = staleLoadImageFlags
    .map((entry) => entry.id)
    .filter((id) => id != null);
  const candidateIds = [
    ...new Map(
      [...leftoverIds, ...staleLoadImageIds]
        .filter((id) => id != null)
        .map((id) => [String(id), id] as const),
    ).values(),
  ];

  if (candidateIds.length > 0) {
    // graph_query has no cursor/offset, and a single detail reply can be cut by
    // max_chars even when its limit is high. Page by explicit ids so every normal
    // 50-node workflow gets a complete detail read within one bounded follow-up
    // pass. A truncated page stays wholly unchecked below; it must never silently
    // retire only the rows that happened to fit in the reply.
    const deadlineAt = Date.now() + Math.max(0, timeoutMs);
    const infoRead = await followUpJson(
      ctx,
      { cmd: "graph_get_object_info" },
      timeoutMs,
      deadlineAt,
      primaryTabId,
    );
    const infoReply = infoRead.payload;
    const objectInfo = infoReply ? objectInfoFromReply(infoReply) : null;
    const queryReads: Array<{ ids: unknown[]; read: FollowUpRead }> = [];
    if (objectInfo && infoRead.stayedOnPrimaryTab) {
      for (const ids of chunks(candidateIds.slice(0, LIMIT_CEILING), GET_ERRORS_QUERY_PAGE_SIZE)) {
        const read = await followUpJson(
          ctx,
          {
            cmd: "graph_query",
            ids,
            fields: "detail",
            limit: Math.min(LIMIT_CEILING, ids.length),
            max_chars: MAX_CHARS_CEILING,
          },
          timeoutMs,
          deadlineAt,
          primaryTabId,
        );
        queryReads.push({ ids, read });
        if (Date.now() >= deadlineAt) break;
      }
    }
    const incompletePageIds = new Set(
      candidateIds.slice(LIMIT_CEILING).map((id) => String(id)),
    );
    const nodes = queryReads.flatMap(({ ids, read }) => {
      if (queryReplyWasTruncated(read.payload)) {
        for (const id of ids) incompletePageIds.add(String(id));
      }
      return read.payload ? parseQueryNodes(read.payload) : [];
    });
    const sameGraph =
      queryReads.every(
        ({ read }) => read.stayedOnPrimaryTab && sameViewingIdentity(payload, read.payload),
      ) &&
      infoRead.stayedOnPrimaryTab &&
      queryReads.length > 0;
    if (sameGraph && objectInfo && nodes.length > 0) {
      const judgeable = leftover.filter((entry) => !incompletePageIds.has(String(entry.id)));
      const judged = judgeLeftoverCombos(judgeable, nodes, objectInfo);
      const judgeableStaleLoadImages = staleLoadImageFlags.filter(
        (entry) => !incompletePageIds.has(String(entry.id)),
      );
      const judgedStaleLoadImages = judgeStaleLoadImages(
        judgeableStaleLoadImages,
        nodes,
        objectInfo,
      );
      // Non-retryable abstentions (the probe cap, a failed lookup, an unenumerable
      // path the panel already disclosed) stay; retryable leftovers are replaced by
      // whatever this pass still could not judge.
      const nextUnchecked = [
        ...asUncheckedList(payload).filter((e) => !isRetryableUnchecked(e)),
        ...leftover.filter((entry) => incompletePageIds.has(String(entry.id))),
        ...judged.stillUnchecked,
      ];
      payload.unchecked_nodes = nextUnchecked;
      // The panel's note counts the PRE-completion list. Drop it rather than
      // leave "NOT CHECKED: 40" next to a shorter remainder.
      delete payload.unchecked_nodes_note;
      if (nextUnchecked.length === 0) {
        delete payload.unchecked_nodes;
      }
      const stillRetryable = nextUnchecked.some(isRetryableUnchecked);
      if (!stillRetryable) {
        delete payload.unchecked_budget_exhausted;
        delete payload.unchecked_class_limit;
      }
      if (judgedStaleLoadImages.reclassifiedIds.size > 0) {
        const remainingStaleFlags = asStaleFlags(payload).filter(
          (entry) => !judgedStaleLoadImages.reclassifiedIds.has(String(entry.id)),
        );
        if (remainingStaleFlags.length > 0) payload.stale_flags = remainingStaleFlags;
        else delete payload.stale_flags;
      }
      const completionUnavailable = [
        ...judged.unavailable,
        ...judgedStaleLoadImages.unavailable,
      ];
      if (completionUnavailable.length) {
        const merged = mergeUnavailable(payload.unavailable_widget_values, completionUnavailable);
        const added = merged.length - (Array.isArray(payload.unavailable_widget_values)
          ? (payload.unavailable_widget_values as unknown[]).length
          : 0);
        payload.unavailable_widget_values = merged;
        // The panel's note carries a COUNT of the pre-completion list
        // (comboAvailabilityNote), so appending to the list without replacing it
        // ships "1 widget value(s)" above two entries — the same stale-count
        // defect the unchecked_nodes_note delete above exists to avoid.
        if (added > 0) {
          payload.unavailable_widget_values_note =
            `LIVE SCAN + ORCHESTRATOR COMPLETION: ${merged.length} widget value(s) the server ` +
            `does not offer, ${added} of them judged from one fresh /object_info read and ` +
            `same-view graph detail read; entries added here are marked ` +
            `source:"orchestrator_completion".`;
        }
      }
      payload.audit_completed_by = "orchestrator";
    }
  }

  return rewriteTextPayload(res, presentGetErrorsAudit(payload));
}
