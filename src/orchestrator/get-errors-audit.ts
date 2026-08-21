/**
 * #1973 — panel_get_errors must not present a clean `errored_count: 0` while
 * its live combo scan still has execution nodes unchecked.
 *
 * The panel's graph_get_errors shares one elective server-call budget and
 * gives the live combo scan only a 4 s STEP cap (GET_ERRORS_STEP_CAP_MS), so a
 * ~77-node graph routinely returns `unchecked_budget_exhausted: true` with the
 * sampler / decoder / assembler / SaveVideo still in `unchecked_nodes`, plus
 * the clean-scan note. The orchestrator already waits 30 s for that reply, so
 * after a budget-exhausted payload it finishes the leftover nodes from ONE
 * batched `graph_get_object_info` plus a targeted `graph_query` — not another
 * per-class round trip. If that completion cannot run, the reply still leads
 * with `audit_complete: false` and checked/unchecked counts rather than a
 * primary clean 0.
 */

import { LIMIT_CEILING, MAX_CHARS_CEILING } from "../services/graph-query.js";

export type GetErrorsToolResult = {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
};

export type GetErrorsCallCtx = {
  call: (cmd: Record<string, unknown>, timeoutMs?: number) => Promise<GetErrorsToolResult>;
};

const BUDGET_UNCHECKED_RE =
  /ran out of its shared server-call budget|lookup cap was reached/i;
const CLEAN_NOTE_RE = /no errors recorded since the last execution/i;
const UNENUMERABLE_VALUE_RE = /[\\/]|\s\[(input|output|temp)\]\s*$/i;
const FILE_LIKE = /\.[A-Za-z0-9_]{2,12}$/;

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
};

export function parseToolResultJson(res: GetErrorsToolResult): Record<string, unknown> | null {
  if (!res || res.isError) return null;
  const text = res.content?.find((c) => c.type === "text")?.text;
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

function isBudgetUnchecked(entry: UncheckedEntry): boolean {
  return typeof entry?.reason === "string" && BUDGET_UNCHECKED_RE.test(entry.reason);
}

/** Distinct node ids the scan abstained on — same counting rule as the panel. */
export function uncheckedNodeCount(unchecked: UncheckedEntry[]): number {
  return new Set(unchecked.map((u, i) => (u?.id == null ? `#${i}` : `id:${String(u.id)}`))).size;
}

export function isGetErrorsAuditIncomplete(payload: Record<string, unknown>): boolean {
  if (payload.unchecked_budget_exhausted === true) return true;
  if (payload.unchecked_class_limit != null) return true;
  return asUncheckedList(payload).some(isBudgetUnchecked);
}

function comboOptions(spec: unknown): string[] | null {
  if (!Array.isArray(spec) || spec.length === 0) return null;
  const type = spec[0];
  if (Array.isArray(type)) return type.filter((v): v is string => typeof v === "string");
  if (typeof type !== "string" || !/COMBO/i.test(type) || /DYNAMIC/i.test(type)) return null;
  const cfg = spec[1] && typeof spec[1] === "object" && !Array.isArray(spec[1])
    ? (spec[1] as Record<string, unknown>)
    : null;
  const opts = cfg?.options;
  if (!Array.isArray(opts)) return null;
  const strings = opts.filter((v): v is string => typeof v === "string");
  return strings.length === opts.length ? strings : null;
}

function isUploadCombo(spec: unknown): boolean {
  if (!Array.isArray(spec)) return false;
  const cfg = spec[1];
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return false;
  const c = cfg as Record<string, unknown>;
  return c.image_upload === true || c.audio_upload === true || c.video_upload === true;
}

function optionsLookLikeFiles(options: string[]): boolean {
  if (options.length === 0) return false;
  return options.filter((s) => FILE_LIKE.test(s)).length * 2 >= options.length;
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
    out.push({ id: n.id, type, widgets });
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
    const def = objectInfo[className];
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
    // A def with combo widgets but no widget values is an unread node, not a pass.
    if (comboNames.length > 0 && Object.keys(node.widgets).length === 0) {
      stillUnchecked.push(entry);
      continue;
    }
    for (const [name, value] of Object.entries(node.widgets)) {
      const spec = specs[name];
      const options = comboOptions(spec);
      if (!options) continue;
      if (typeof value !== "string" || value === "") continue;
      if (isUploadCombo(spec) && UNENUMERABLE_VALUE_RE.test(value)) {
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
      });
    }
  }

  return { unavailable, stillUnchecked };
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
 * Put audit completeness FIRST so `errored_count: 0` cannot be read as a
 * finished clean scan. Drops the panel's "no errors recorded" note while the
 * audit is incomplete — that sentence is the misread this issue is about.
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
  } else if (typeof note === "string") {
    out.note = note;
  }
  return out;
}

async function followUpJson(
  ctx: GetErrorsCallCtx,
  cmd: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await ctx.call(cmd, timeoutMs);
    return parseToolResultJson(res);
  } catch {
    return null;
  }
}

/**
 * After a budget-exhausted graph_get_errors, finish leftover combo checks from
 * one batched object_info + a targeted graph_query, then present completeness
 * honestly. Never throws: a failed follow-up still returns the incomplete audit.
 */
export async function completeGetErrorsAudit(
  ctx: GetErrorsCallCtx,
  res: GetErrorsToolResult,
  timeoutMs: number,
): Promise<GetErrorsToolResult> {
  const payload = parseToolResultJson(res);
  if (!payload) return res;
  if (!isGetErrorsAuditIncomplete(payload)) return res;

  const leftover = asUncheckedList(payload).filter(isBudgetUnchecked);
  const leftoverIds = [
    ...new Set(leftover.map((e) => e.id).filter((id) => id != null)),
  ];

  if (leftoverIds.length > 0) {
    const [query, infoReply] = await Promise.all([
      followUpJson(
        ctx,
        {
          cmd: "graph_query",
          ids: leftoverIds,
          fields: "detail",
          limit: LIMIT_CEILING,
          max_chars: MAX_CHARS_CEILING,
        },
        timeoutMs,
      ),
      followUpJson(ctx, { cmd: "graph_get_object_info" }, timeoutMs),
    ]);
    const objectInfo = infoReply ? objectInfoFromReply(infoReply) : null;
    const nodes = query ? parseQueryNodes(query) : [];
    if (objectInfo && nodes.length > 0) {
      const judged = judgeLeftoverCombos(leftover, nodes, objectInfo);
      // Non-budget abstentions (unenumerable paths the panel already disclosed)
      // stay; budget leftovers are replaced by whatever this pass still could
      // not judge.
      const nextUnchecked = [
        ...asUncheckedList(payload).filter((e) => !isBudgetUnchecked(e)),
        ...judged.stillUnchecked,
      ];
      payload.unchecked_nodes = nextUnchecked;
      // The panel's note counts the PRE-completion list. Drop it rather than
      // leave "NOT CHECKED: 40" next to a shorter remainder.
      delete payload.unchecked_nodes_note;
      if (nextUnchecked.length === 0) {
        delete payload.unchecked_nodes;
      }
      const stillBudget = nextUnchecked.some(isBudgetUnchecked);
      if (!stillBudget) {
        delete payload.unchecked_budget_exhausted;
        delete payload.unchecked_class_limit;
      }
      if (judged.unavailable.length) {
        payload.unavailable_widget_values = mergeUnavailable(
          payload.unavailable_widget_values,
          judged.unavailable,
        );
      }
      payload.audit_completed_by = "orchestrator";
      if (typeof payload.note === "string" && CLEAN_NOTE_RE.test(payload.note) && judged.unavailable.length) {
        delete payload.note;
      }
    }
  }

  return rewriteTextPayload(res, presentGetErrorsAudit(payload));
}
