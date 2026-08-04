// Pure query engine over an API-format graph — the flat {id: {class_type,
// inputs, _meta}} shape every mutation tool consumes (issue #169).
//
// Fills the "missing middle" between analyze_workflow's fixed summary and
// get_workflow's full JSON dump: on big graphs (100+ nodes) an agent needs
// "the KSamplers with cfg>7", "what feeds node 42", "count nodes by type" —
// not a context-flooding dump and not an unfilterable outline. Output is
// TOKEN-BOUNDED with an explicit truncation marker, so a small local model
// can never lose its conversation to a graph read (the trigger of the
// context-swamp saga). The panel's live-graph twin (graph_query executor in
// comfyui-mcp-panel) mirrors these exact semantics — keep them in lockstep.

/** A widget predicate: "name op value". Ops: = != >= <= > < ~ (contains). */
const PREDICATE_RE = /^\s*([A-Za-z0-9_.]+)\s*(>=|<=|!=|=|>|<|~)\s*(.*?)\s*$/;

// #809: the REAL clamps, exported so the remedy strings below and the zod schema on
// query_workflow (src/tools/workflow-library.ts) are derived from ONE number. A hint
// that names a ceiling the runtime does not actually enforce is the same class of
// defect as a hint that names the wrong parameter — it sends the caller at a value
// that gets silently clamped, which reads to the caller as "the tool can't do this".
export const LIMIT_CEILING = 200;
export const MAX_CHARS_CEILING = 60000;
export const MAX_CHARS_FLOOR = 500;
/** Per-widget-value cap in the `detail` projection — a FIXED cap, NOT raised by max_chars. */
export const WIDGET_VALUE_CAP = 2048;
/** Widget values are clipped to this in the `compact` projection (fixed). */
export const COMPACT_VALUE_CLIP = 60;
/** Ref-inputs / downstream-consumer list caps in the `detail` projection (fixed). */
export const REF_CAP = 64;
export const DOWN_CAP = 64;

/**
 * #809 (codex gate): "raise `X` up to N" is ITSELF a dead retry when the caller is
 * already at N, and "raise `X`" with no ceiling leaves them guessing how far. Both waste
 * the round trip this issue exists to prevent. One helper so every marker — inline or
 * tail — states the same true thing.
 */
export function raiseOrCeiling(param: string, inForce: number, ceiling: number): string {
  return inForce >= ceiling
    ? `\`${param}\` is already at its ceiling of ${ceiling}`
    : `raise \`${param}\` (up to ${ceiling})`;
}


export interface GraphQueryOptions {
  /** Keep nodes whose class_type contains ANY of these (case-insensitive). */
  types?: string[];
  /** Keep nodes whose title contains this (case-insensitive). */
  title?: string;
  /** Widget predicates, ANDed: "cfg>7", "steps<=20", "sampler_name=euler",
   *  "text~sunset". Numeric compare when both sides parse as numbers. */
  where?: string[];
  /** Keep exactly these node ids (also the way to read ONE node's detail). */
  ids?: Array<string | number>;
  /** Scope to the dependency closure FEEDING this node (then filter). */
  upstream_of?: string | number;
  /** Scope to the nodes CONSUMING this node's outputs (then filter). */
  downstream_of?: string | number;
  /** Max hops from the seed (seed = 0). Absent = full closure. */
  depth?: number;
  /** Projection: ids | compact (one line per node, default) | detail (JSON). */
  fields?: "ids" | "compact" | "detail";
  /** Aggregate instead of listing: counts per class_type of the MATCHED set. */
  group_by?: "type";
  /** Max nodes listed (default 40, max 200). Aggregates ignore it. */
  limit?: number;
  /** Output character bound (default 12000) — the token-flood guard. */
  max_chars?: number;
}

export interface GraphQueryResult {
  /** Nodes in the whole graph. */
  total: number;
  /** Nodes in scope after traversal (== total when no traversal). */
  candidates: number;
  /** Nodes matching the filters within scope. */
  matched: number;
  /** Nodes actually rendered (≤ limit, ≤ char bound). */
  shown: number;
  /** Whether ROWS were dropped. Field-level caps inside a rendered row (per-widget,
   *  per-ref, compact value clip) do NOT set this — they are reported inline, next to
   *  the thing they cut, and are visible in `text`. Stated explicitly because "truncated
   *  is false" would otherwise read as "you have everything" (codex gate). */
  truncated: boolean;
  /** #809: WHICH ROW-LEVEL cap fired, so the remedy can name the lever that actually
   *  applies. `null` when no rows were dropped — which, per `truncated` above, does NOT
   *  mean no content was cut. "limit" ⇒ raising max_chars does nothing; "max_chars" ⇒
   *  raising limit does nothing (and makes the overflow worse). */
  truncated_by: "limit" | "max_chars" | null;
  text: string;
}

interface ApiNode {
  class_type?: string;
  inputs?: Record<string, unknown>;
  _meta?: { title?: string };
}

type ApiGraph = Record<string, ApiNode>;

/** Is this input value a [nodeId, slot] link reference? */
function isRef(v: unknown): v is [string | number, number] {
  return Array.isArray(v) && v.length === 2 && (typeof v[0] === "string" || typeof v[0] === "number") && typeof v[1] === "number";
}

function clip(v: unknown, n = 60): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const one = (s ?? "").replace(/\s+/g, " ");
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** clip(), but reporting whether it actually cut — so the COMPACT projection can
 *  raise ONE footer note naming the lever (`fields`:"detail") instead of leaving a
 *  bare `…` per value (#809). */
function clipFlag(v: unknown, n = COMPACT_VALUE_CLIP): { text: string; clipped: boolean } {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const one = (s ?? "").replace(/\s+/g, " ");
  return one.length > n ? { text: `${one.slice(0, n - 1)}…`, clipped: true } : { text: one, clipped: false };
}

// #609: per-widget-value cap for the `detail` projection. One oversized value
// (a ResolutionMaster presets JSON, LTXDirector.timeline_data, a VHS videopreview)
// must not consume the whole max_chars budget and starve the rest of the query.
// WIDGET_VALUE_CAP is exported above (#809) so the remedy can state it honestly.

/** Bound one widget value by its ESCAPED (JSON-serialized) size (#609), so the bound
 *  holds regardless of content — control chars and lone surrogates escape to 6 chars
 *  each, not 2. A non-string is measured by its REAL serialized form (the single
 *  stringify below) — re-serializing that JSON text would double-count every escape
 *  and type-change a fitting object/array into a truncated string (review nit).
 *  Small values pass through; else the longest head prefix whose encoding fits `cap`,
 *  with an honest marker naming how many raw chars were dropped. */
function capWidgetValue(
  value: unknown,
  cap = WIDGET_VALUE_CAP,
  /** The `max_chars` in force, so a caller already at the ceiling isn't sent back. */
  maxChars = Number.POSITIVE_INFINITY,
): unknown {
  if (value == null) return value;
  const isString = typeof value === "string";
  const s = isString ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
  if (typeof s !== "string") return value;
  // A string is emitted escaped (JSON.stringify(s)); a non-string's emission IS s.
  const serializedSize = isString ? JSON.stringify(s).length : s.length;
  if (serializedSize <= cap) return value;
  // #809: name the lever that ACTUALLY applies. capWidgets() tightens the per-value
  // cap to the char budget only when the budget is the smaller of the two, so
  // `cap < WIDGET_VALUE_CAP` ⟺ max_chars is what cut this value and raising it helps.
  // At the FIXED 2048 cap raising max_chars does nothing, and saying so stops the
  // caller burning a retry on a parameter that cannot move this.
  const remedy =
    cap < WIDGET_VALUE_CAP
      ? `over the \`max_chars\` budget; ${raiseOrCeiling("max_chars", maxChars, MAX_CHARS_CEILING)}`
      : `at the ${WIDGET_VALUE_CAP}-char per-widget cap, which \`max_chars\` does not raise`;
  const marker = (dropped: number) => `…(+${dropped} chars cut ${remedy})`;
  // Reserve EXACTLY the marker's own size (its digit count is bounded by s.length),
  // not a fixed 40 — a longer, more useful marker must not be able to breach `cap`.
  const target = Math.max(2, cap - marker(s.length).length);
  let lo = 0;
  let hi = s.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (JSON.stringify(s.slice(0, mid)).length <= target) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return `${s.slice(0, best)}${marker(s.length - best)}`;
}

/** Clip a KEY/name to a small bound (#609) so a pathological long key can't blow the line. */
function capKey(key: string, cap = 128): string {
  const k = String(key);
  return k.length <= cap ? k : `${k.slice(0, cap)}…`;
}

/** Serialized (JSON-escaped) size of one `"key":value,` widget entry — the ACTUAL
 *  line contribution, so escape-heavy strings don't slip the budget. */
function entrySize(key: string, value: unknown): number {
  let vLen: number;
  try { vLen = JSON.stringify(value)?.length ?? 0; } catch { vLen = String(value).length; }
  return JSON.stringify(key).length + vLen + 2;
}

/** Cap every value in a widgets map, AND bound the TOTAL serialized size by dropping
 *  overflow widgets (keeping valid JSON) with an elision marker (#609) — so even a
 *  many-widget node can't blow the char budget. When a budget is set, the per-value
 *  cap is tightened to it so even the single retained widget respects it. At least one
 *  widget always survives. */
function capWidgets(widgets: Record<string, unknown>, totalCap = Number.POSITIVE_INFINITY): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // capWidgetValue bounds the ESCAPED size exactly, so the per-value cap can be the
  // budget itself (minus a small reserve for the key + JSON framing).
  const perValueCap = Number.isFinite(totalCap) ? Math.min(WIDGET_VALUE_CAP, Math.max(1, totalCap - 256)) : WIDGET_VALUE_CAP;
  const entries = Object.entries(widgets);
  let used = 0;
  let omitted = 0;
  for (let i = 0; i < entries.length; i++) {
    const k = capKey(entries[i][0]);
    const capped = capWidgetValue(entries[i][1], perValueCap, totalCap);
    const size = entrySize(k, capped);
    if (Number.isFinite(totalCap) && Object.keys(out).length > 0 && used + size > totalCap) {
      omitted = entries.length - i;
      break;
    }
    out[k] = capped;
    used += size;
  }
  // #809: `max_chars` backticked so the schema-driven remedy test can see it, and the
  // remaining count stated — the caller needs "how much is left", not just "some".
  if (omitted > 0)
    out["…"] =
      `${omitted} more widget(s) cut by the \`max_chars\` budget; ` +
      raiseOrCeiling("max_chars", totalCap, MAX_CHARS_CEILING);
  return out;
}

/** Hard-clip an assembled COMPACT (plain-string) line to `maxChars` (#609) — the
 *  protected first match bypasses the running budget, so a thousands-of-widgets node
 *  would else emit an unbounded first line. */
function clipLine(line: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || line.length <= maxChars) return line;
  // #809: a bare "…" told the caller nothing. Say how much was cut and name the lever
  // (raising max_chars genuinely lifts THIS cut). The reserve is the marker's own
  // worst-case size, so the clipped line still respects maxChars.
  const marker = (dropped: number) =>
    `…(+${dropped} chars over \`max_chars\`; ${raiseOrCeiling("max_chars", maxChars, MAX_CHARS_CEILING)})`;
  const keep = Math.max(0, maxChars - marker(line.length).length);
  return line.slice(0, keep) + marker(line.length - keep);
}

/** Final guard for a DETAIL (JSON) line (#609): if a node's fully-capped detail STILL
 *  exceeds `maxChars` — a high-fan-in node whose upstream/downstream the per-field
 *  caps don't fully bound against a shared budget — replace it with a bounded
 *  VALID-JSON stub. The row is never dropped (shown ≥ 1) but every rendered detail
 *  line is ≤ maxChars. */
function fitDetailLine(line: string, stub: Record<string, unknown>, maxChars: number): string {
  if (!Number.isFinite(maxChars) || line.length <= maxChars) return line;
  // Clip the stub's OWN fields too — a graph may carry an arbitrarily long node id or
  // type, which would otherwise blow even the stub past the budget.
  const clipF = (v: unknown) => (typeof v === "string" && v.length > 60 ? `${v.slice(0, 60)}…` : v);
  const safe: Record<string, unknown> = { id: clipF(stub.id), type: clipF(stub.type) };
  if (stub.title != null) safe.title = clipF(stub.title);
  const s = JSON.stringify({
    ...safe,
    detail_omitted: `full detail is ${line.length} chars > \`max_chars\` ${maxChars}; ${raiseOrCeiling("max_chars", maxChars, MAX_CHARS_CEILING)} to read this node`,
  });
  if (s.length <= maxChars) return s;
  return JSON.stringify({ id: typeof safe.id === "string" ? safe.id.slice(0, 40) : safe.id, detail_omitted: "raise `max_chars`" });
}

function matchPredicate(value: unknown, op: string, rhs: string): boolean {
  const lhsNum = typeof value === "number" ? value : Number(value);
  const rhsNum = Number(rhs);
  const numeric = !Number.isNaN(lhsNum) && !Number.isNaN(rhsNum) && String(value).trim() !== "";
  if (numeric) {
    switch (op) {
      case "=": return lhsNum === rhsNum;
      case "!=": return lhsNum !== rhsNum;
      case ">": return lhsNum > rhsNum;
      case ">=": return lhsNum >= rhsNum;
      case "<": return lhsNum < rhsNum;
      case "<=": return lhsNum <= rhsNum;
      // "~" falls through to string contains below
    }
  }
  const l = String(value ?? "").toLowerCase();
  const r = rhs.toLowerCase();
  switch (op) {
    case "=": return l === r;
    case "!=": return l !== r;
    case "~": return l.includes(r);
    // Ordered ops on non-numeric values: lexicographic (rarely useful, never throws).
    case ">": return l > r;
    case ">=": return l >= r;
    case "<": return l < r;
    case "<=": return l <= r;
    default: return false;
  }
}

/** BFS over an adjacency map, depth-capped (seed = depth 0, included). */
function closure(adj: Map<string, Set<string>>, seed: string, depth: number): Set<string> {
  const seen = new Set<string>([seed]);
  let frontier = [seed];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of adj.get(id) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

/**
 * Query an API-format graph. Pipeline: traversal scope → filters → projection
 * (or aggregate), then char-bound the text. Never throws on malformed nodes —
 * a node without class_type/inputs simply matches less.
 */
export function queryApiGraph(graph: ApiGraph, opts: GraphQueryOptions = {}): GraphQueryResult {
  const nodeIds = Object.keys(graph);
  const total = nodeIds.length;
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), LIMIT_CEILING);
  const maxChars = Math.min(Math.max(opts.max_chars ?? 12000, MAX_CHARS_FLOOR), MAX_CHARS_CEILING);

  // Adjacency (upstream = the nodes my ref-inputs point at; downstream = inverse).
  const up = new Map<string, Set<string>>();
  const down = new Map<string, Set<string>>();
  for (const id of nodeIds) {
    for (const v of Object.values(graph[id]?.inputs ?? {})) {
      if (isRef(v)) {
        const src = String(v[0]);
        if (!up.has(id)) up.set(id, new Set());
        up.get(id)!.add(src);
        if (!down.has(src)) down.set(src, new Set());
        down.get(src)!.add(id);
      }
    }
  }

  // 1) Traversal scope.
  let scope: Set<string> | null = null;
  const depth = opts.depth != null && opts.depth >= 0 ? opts.depth : Number.POSITIVE_INFINITY;
  const seedErr = (which: string, id: string): GraphQueryResult => ({
    total, candidates: 0, matched: 0, shown: 0, truncated: false, truncated_by: null,
    // #609: clip the caller-supplied id so an oversized seed can't flood the diagnostic.
    // #809: SAY when it was clipped — echoing back a shortened id with a bare "…" reads
    // as "that is the id I looked for", so the caller cannot tell a typo from a clip.
    text:
      `${which} node ${clip(id, 120)}${id.length > 120 ? ` (id shown clipped to 120 of ${id.length} chars)` : ""}` +
      ` not found in the graph (${total} nodes).`,
  });
  if (opts.upstream_of != null) {
    const seed = String(opts.upstream_of);
    if (!graph[seed]) return seedErr("upstream_of", seed);
    scope = closure(up, seed, depth);
  }
  if (opts.downstream_of != null) {
    const seed = String(opts.downstream_of);
    if (!graph[seed]) return seedErr("downstream_of", seed);
    const d = closure(down, seed, depth);
    scope = scope ? new Set([...scope].filter((x) => d.has(x))) : d;
  }
  const candidates = scope ? [...scope] : nodeIds;

  // 2) Filters.
  const wantIds = opts.ids?.map(String);
  const types = opts.types?.map((t) => t.toLowerCase()).filter(Boolean);
  const title = opts.title?.toLowerCase();
  const predicates = (opts.where ?? []).map((w) => {
    const m = PREDICATE_RE.exec(w);
    // Reject a value that starts with an operator char — it means the op was
    // mistyped ("cfg >> 7", "steps => 20") and would otherwise silently match
    // nothing as a string compare.
    if (!m || /^[=<>~]/.test(m[3])) {
      // #609: clip the caller-supplied predicate so an oversized value can't flood the error.
      throw new Error(`Bad predicate "${clip(w, 120)}" — expected "name op value" with op one of = != >= <= > < ~`);
    }
    return { name: m[1], op: m[2], rhs: m[3] };
  });
  const widgetsOf = (n: ApiNode): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n.inputs ?? {})) if (!isRef(v)) out[k] = v;
    return out;
  };
  const matched = candidates.filter((id) => {
    const n = graph[id] ?? {};
    if (wantIds && !wantIds.includes(String(id))) return false;
    const t = (n.class_type ?? "").toLowerCase();
    if (types?.length && !types.some((x) => t.includes(x))) return false;
    if (title && !(n._meta?.title ?? "").toLowerCase().includes(title)) return false;
    if (predicates.length) {
      const w = widgetsOf(n);
      for (const p of predicates) {
        if (!(p.name in w) || !matchPredicate(w[p.name], p.op, p.rhs)) return false;
      }
    }
    return true;
  });
  // Stable numeric-ish ordering so results read like the graph.
  matched.sort((a, b) => (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b));

  // 3) Aggregate?
  if (opts.group_by === "type") {
    const hist = new Map<string, number>();
    for (const id of matched) {
      const t = graph[id]?.class_type ?? "?";
      hist.set(t, (hist.get(t) ?? 0) + 1);
    }
    // #609: bound the aggregate too — clip each type and char-bound the list so a graph
    // with thousands of distinct/long class_types can't flood the read.
    const allLines = [...hist.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => `${c}× ${clip(t, 200)}`);
    const head = `${matched.length} node(s) across ${hist.size} type(s):`;
    const kept: string[] = [];
    let used = head.length;
    let aggTruncated = false;
    for (const l of allLines) {
      if (used + l.length + 1 > maxChars) { aggTruncated = true; break; }
      kept.push(l);
      used += l.length + 1;
    }
    // #809: the aggregate can ONLY be cut by the char budget (limit is ignored here),
    // so name that one lever and its real ceiling.
    const aggAssemble = (): string => {
      const tail = aggTruncated
        ? `\n…(${allLines.length - kept.length} more type(s) cut by \`max_chars\`=${maxChars}; ${
            maxChars >= MAX_CHARS_CEILING
              ? `\`max_chars\` is already at its ceiling of ${MAX_CHARS_CEILING} — narrow the matched set with \`types\`/\`where\`/\`upstream_of\` instead`
              : `raise \`max_chars\` up to ${MAX_CHARS_CEILING}`
          })`
        : "";
      return `${head}\n${kept.join("\n")}${tail}`;
    };
    // The tail is part of the result here too (codex gate) — the loop above filled the
    // budget with rows and then appended it, breaching the bound on exactly the path the
    // row projection had already been fixed for. Fit afterwards, same as there.
    let aggText = aggAssemble();
    while (aggText.length > maxChars && kept.length > 0) {
      kept.pop();
      aggTruncated = true;
      aggText = aggAssemble();
    }
    return {
      total, candidates: candidates.length, matched: matched.length,
      shown: matched.length, truncated: aggTruncated,
      truncated_by: aggTruncated ? "max_chars" : null,
      text: aggText,
    };
  }

  // 4) Projection, char-bounded.
  const fields = opts.fields ?? "compact";
  const header =
    `${matched.length} match(es) of ${candidates.length} in scope (graph: ${total} nodes)` +
    (scope ? ` · traversal${Number.isFinite(depth) ? ` depth≤${depth}` : ""}` : "");
  // #609: protect ONLY the FIRST match from the char budget so asking for one node
  // by id never returns shown:0 (a huge sibling or one oversized widget blob can no
  // longer starve the thing you asked for). We deliberately do NOT exempt every
  // requested id — that would disable the max_chars token bound for a large `ids`
  // list; at most one line (the first, itself per-value capped) can overflow.
  // NOTE (#607): link-driven-widget staleness cannot occur in this API-format engine
  // — ref inputs are excluded from widgetsOf() by construction (isRef), so a
  // link-driven input is never reported as a stale widget value. #607 is panel-only.
  const lines: string[] = [];
  let shown = 0;
  let truncated = false;
  // #809: WHICH cap fired. `limit` and `max_chars` are different levers with opposite
  // remedies — the pre-#809 tail named `limit` for both, so a caller cut by the char
  // budget was told to raise the one parameter that makes the overflow worse.
  let truncatedBy: "limit" | "max_chars" | null = null;
  /** #809: compact rows clip widget values at a FIXED 60 chars, which no parameter
   *  raises — so the footer points at `fields`:"detail" (the projection that carries
   *  fuller values) rather than at a lever that would do nothing.
   *
   *  Counted PER ROW and summed over the rows actually RETURNED (codex gate). A running
   *  total would include rows the budget rejected and rows the post-fit loop popped, so
   *  the footer would claim clips the reader cannot see — a false claim inside the very
   *  note that has to be trustworthy. */
  const lineClips: number[] = [];
  let rowClips = 0;
  let chars = header.length;
  for (const id of matched) {
    if (shown >= limit) { truncated = true; truncatedBy = "limit"; break; }
    const n = graph[id] ?? {};
    rowClips = 0;
    let line: string;
    if (fields === "ids") {
      line = clipLine(String(id), maxChars); // #609: bound even a pathological long id
    } else if (fields === "detail") {
      // #609: bound EVERY field so the protected first line stays O(max_chars): clip
      // the title/type, clip ref-input names + source ids and cap their count, and cap
      // the downstream consumer list (a fan-out hub can have hundreds) — each with a
      // "+N more" / "…" tail. widgets is total-capped by capWidgets.
      const upRefs: Record<string, string> = {};
      const refEntries = Object.entries(n.inputs ?? {}).filter(([, v]) => isRef(v));
      for (const [k, v] of refEntries.slice(0, REF_CAP)) {
        upRefs[capKey(k)] = clip(`${(v as [unknown, unknown])[0]}.${(v as [unknown, unknown])[1]}`, 128);
      }
      // #809: these two are FIXED caps that no parameter raises — so the marker names
      // the traversal that DOES return the full set instead of a lever that cannot.
      // The suggested follow-up carries its OWN `limit` (codex gate): a bare
      // `upstream_of`+`depth`:1 would re-truncate at the default limit of 40 and land the
      // caller in a second silent cut, which is the failure this issue exists to stop.
      // `fields`:"ids" keeps that follow-up cheap. The seed counts as one row, hence +1.
      // The traversal returns the seed PLUS every direct neighbour, so it needs
      // count+1 rows. Past LIMIT_CEILING that is unreachable in one call, and claiming
      // "list all" there would be a second false promise (codex gate) — so the verb
      // changes with the fact.
      const followUpText = (param: string, count: number) => {
        const need = count + 1; // the traversal returns the seed PLUS its neighbours
        const call = `\`${param}\`:${id}, \`depth\`:1, \`limit\`:${Math.min(LIMIT_CEILING, need)}, \`fields\`:"ids"`;
        // Above the ceiling a single call CANNOT return them all, and query_workflow has
        // no cursor/offset — so "page through them" would be a second false promise
        // inside the remedy for the first one (codex gate). Say what is actually true.
        return need <= LIMIT_CEILING
          ? `list all with ${call}`
          : `list the first ${LIMIT_CEILING} with ${call}; there is no cursor/offset, so enumerate the rest by re-running that query with \`types\`/\`where\` narrowed`;
      };
      if (refEntries.length > REF_CAP)
        upRefs["…"] = `+${refEntries.length - REF_CAP} more (fixed ${REF_CAP}-ref cap) — ${followUpText("upstream_of", refEntries.length)}`;
      const allDown = [...(down.get(String(id)) ?? [])];
      const downstream: Array<string | number> =
        allDown.length > DOWN_CAP
          ? [
              ...allDown.slice(0, DOWN_CAP),
              `…+${allDown.length - DOWN_CAP} more (fixed ${DOWN_CAP}-consumer cap) — ${followUpText("downstream_of", allDown.length)}`,
            ]
          : allDown;
      const title = n._meta?.title != null ? clip(n._meta.title, 200) : n._meta?.title;
      line = JSON.stringify({
        id, type: clip(n.class_type ?? "?", 200), title,
        widgets: capWidgets(widgetsOf(n), maxChars), upstream: upRefs, downstream,
      });
      // Final guard: if the fully-capped detail STILL exceeds max_chars (a pathological
      // high-fan-in node), degrade the protected line to a bounded valid-JSON stub so it
      // is never dropped yet can't flood — every rendered detail line ends up ≤ max_chars.
      line = fitDetailLine(line, { id, type: clip(n.class_type ?? "?", 200) }, maxChars);
    } else {
      const w = Object.entries(widgetsOf(n))
        .map(([k, v]) => {
          const c = clipFlag(v);
          if (c.clipped) rowClips++;
          return `${k}=${c.text}`;
        })
        .join(" ");
      const ins = Object.entries(n.inputs ?? {})
        .filter(([, v]) => isRef(v))
        .map(([k, v]) => `${k}:${(v as [unknown, unknown])[0]}`)
        .join(" ");
      const outs = [...(down.get(String(id)) ?? [])].join(",");
      line =
        `#${id} ${n.class_type ?? "?"}${n._meta?.title ? ` "${clip(n._meta.title, 40)}"` : ""}` +
        (w ? ` · ${w}` : "") + (ins ? `  ← ${ins}` : "") + (outs ? `  → ${outs}` : "");
      // #609: bound the compact line by widget COUNT too — the protected first line
      // bypasses the running budget, so a thousands-of-widgets node would else be
      // unbounded. Plain string ⇒ a tail ellipsis is safe.
      line = clipLine(line, maxChars);
    }
    const protectedLine = shown === 0; // first match always renders → shown≥1
    if (!protectedLine && chars + line.length + 1 > maxChars) {
      truncated = true;
      truncatedBy = "max_chars";
      break;
    }
    chars += line.length + 1;
    lines.push(line);
    lineClips.push(rowClips);
    shown++;
  }
  // #809 (defect 1): BOTH cuts above land here, and they have OPPOSITE remedies —
  // raising `limit` on a char-budget cut only makes the overflow worse. Name the lever
  // that actually fired, with its REAL ceiling, and say plainly that the other one
  // will not help, so a caller cannot burn a retry proving the tool "can't do this".
  //
  // AND (codex gate): "raise X up to N" is itself a dead retry when the caller is ALREADY
  // at N. Telling someone at limit=200 to raise limit to 200 is the same wasted round
  // trip as naming the wrong lever — so at the ceiling the remedy switches to what is
  // actually left: narrowing, or the aggregate.
  const buildTail = (by: "limit" | "max_chars" | null, shownNow: number): string => {
    if (!by) return "";
    const atCeiling = by === "limit" ? limit >= LIMIT_CEILING : maxChars >= MAX_CHARS_CEILING;
    const param = by === "limit" ? "limit" : "max_chars";
    const ceiling = by === "limit" ? LIMIT_CEILING : MAX_CHARS_CEILING;
    const raise = atCeiling
      ? `\`${param}\` is already at its ceiling of ${ceiling}, so raising it is not an option`
      : `raise \`${param}\` up to ${ceiling}`;
    const other =
      by === "limit" ? "`max_chars` is not the constraint here." : "Raising `limit` will not help.";
    const narrow = wantIds?.length
      ? "request fewer `ids` at once"
      : 'narrow with `types`/`where`/`ids`/`depth`, or count with `group_by`:"type"';
    const cutBy =
      by === "limit"
        ? `\`limit\`=${limit}`
        : `\`max_chars\`=${maxChars}${wantIds?.length ? " (per-field values are already capped)" : ""}`;
    const subject = wantIds?.length ? " requested node(s)" : "";
    return `\n… truncated at ${shownNow} of ${matched.length}${subject} by ${cutBy} — ${raise}, or ${narrow}. ${other}`;
  };
  // #809: the compact projection's 60-char value clip is FIXED — no parameter lifts it,
  // so point at the projection that carries fuller values instead of at a dead lever.
  const buildClipNote = (n: number): string =>
    n > 0
      ? `\n(${n} widget value(s) clipped to ${COMPACT_VALUE_CLIP} chars by \`fields\`:"compact" — read fuller values with \`fields\`:"detail", which caps values at ${WIDGET_VALUE_CAP} chars.)`
      : "";
  const assemble = (): string => {
    const body = fields === "ids" ? lines.join(",") : lines.join("\n");
    return `${header}\n${body}${buildTail(truncatedBy, shown)}${buildClipNote(lineClips.reduce((x, y) => x + y, 0))}`;
  };

  // #809 (codex gate): the tail and the footer are part of the RESULT and must fit inside
  // `max_chars`, not be appended past it. Reserving their worst case UP FRONT was wrong —
  // at the 500 floor it pre-spent the whole budget and manufactured a truncation on a
  // result that fitted, which is the false-truncation defect this issue also exists to
  // remove. So fit AFTERWARDS instead: drop rows from the end, exactly as many as needed.
  // The first row is never dropped (the documented #609 protection), so a single
  // pathological row can still exceed the budget — that exception is unchanged.
  let text = assemble();
  while (text.length > maxChars && lines.length > 1) {
    lines.pop();
    lineClips.pop();
    shown--;
    truncated = true;
    truncatedBy = "max_chars";
    text = assemble();
  }
  return {
    total, candidates: candidates.length, matched: matched.length, shown, truncated,
    truncated_by: truncatedBy,
    text,
  };
}
