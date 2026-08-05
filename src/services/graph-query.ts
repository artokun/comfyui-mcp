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
  truncated: boolean;
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

/**
 * The hard ceilings, in one place, because both the clamps below and every message
 * that says "raise it" have to agree on them. `raiseChars` is the whole point: past
 * the ceiling the tools' schemas REJECT a larger value, so "raise max_chars" stops
 * being a remedy and becomes a guaranteed validation error — the caller is sent to
 * do something that cannot work. Every site that used to say it unconditionally now
 * asks here instead.
 */
const MAX_CHARS_CEILING = 60000;
const LIMIT_CEILING = 200;

/** "raise max_chars" — or the truth, once there is nothing left to raise it to. */
function raiseChars(maxChars: number): string {
  return maxChars >= MAX_CHARS_CEILING
    ? `max_chars is already at its ${MAX_CHARS_CEILING} maximum`
    : `raise max_chars (max ${MAX_CHARS_CEILING})`;
}

// #609: per-widget-value cap for the `detail` projection. One oversized value
// (a ResolutionMaster presets JSON, LTXDirector.timeline_data, a VHS videopreview)
// must not consume the whole max_chars budget and starve the rest of the query.
const WIDGET_VALUE_CAP = 2048;

/** Bound one widget value by its ESCAPED (JSON-serialized) size (#609), so the bound
 *  holds regardless of content — control chars and lone surrogates escape to 6 chars
 *  each, not 2. A non-string is measured by its REAL serialized form (the single
 *  stringify below) — re-serializing that JSON text would double-count every escape
 *  and type-change a fitting object/array into a truncated string (review nit).
 *  Small values pass through; else the longest head prefix whose encoding fits `cap`,
 *  with an honest marker naming how many raw chars were dropped. */
function capWidgetValue(value: unknown, cap = WIDGET_VALUE_CAP): unknown {
  if (value == null) return value;
  const isString = typeof value === "string";
  const s = isString ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
  if (typeof s !== "string") return value;
  // A string is emitted escaped (JSON.stringify(s)); a non-string's emission IS s.
  const serializedSize = isString ? JSON.stringify(s).length : s.length;
  if (serializedSize <= cap) return value;
  const target = Math.max(2, cap - 40);
  let lo = 0;
  let hi = s.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (JSON.stringify(s.slice(0, mid)).length <= target) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return `${s.slice(0, best)}…(+${s.length - best} chars, truncated)`;
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
    const capped = capWidgetValue(entries[i][1], perValueCap);
    const size = entrySize(k, capped);
    if (Number.isFinite(totalCap) && Object.keys(out).length > 0 && used + size > totalCap) {
      omitted = entries.length - i;
      break;
    }
    out[k] = capped;
    used += size;
  }
  if (omitted > 0) out["…"] = `${omitted} widget(s) omitted (exceeded budget); ${raiseChars(totalCap)}`;
  return out;
}

/** Hard-clip an assembled COMPACT (plain-string) line to `maxChars` (#609) — the
 *  protected first match bypasses the running budget, so a thousands-of-widgets node
 *  would else emit an unbounded first line. */
function clipLine(line: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || line.length <= maxChars) return line;
  return line.slice(0, Math.max(0, maxChars - 1)) + "…";
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
    detail_omitted: `full detail is ${line.length} chars > max_chars ${maxChars}; ${raiseChars(maxChars)} to read this node`,
  });
  if (s.length <= maxChars) return s;
  return JSON.stringify({
    id: typeof safe.id === "string" ? safe.id.slice(0, 40) : safe.id,
    detail_omitted: raiseChars(maxChars),
  });
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
  const maxChars = Math.min(Math.max(opts.max_chars ?? 12000, 500), MAX_CHARS_CEILING);

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
    total, candidates: 0, matched: 0, shown: 0, truncated: false,
    // #609: clip the caller-supplied id so an oversized seed can't flood the diagnostic.
    text: `${which} node ${clip(id, 120)} not found in the graph (${total} nodes).`,
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
    // An aggregate has no `limit` and no narrower projection to fall back on, so at
    // the ceiling the honest answer is that the type list cannot be shown whole —
    // scoping the query (types/where/ids/depth) is the only thing left.
    const aggTail = aggTruncated
      ? `\n…(${allLines.length - kept.length} more type(s) omitted; ${
          maxChars >= MAX_CHARS_CEILING
            ? `max_chars is already at its ${MAX_CHARS_CEILING} maximum, so scope the query with types/where/ids/depth instead`
            : `raise max_chars (max ${MAX_CHARS_CEILING})`
        })`
      : "";
    return {
      total, candidates: candidates.length, matched: matched.length,
      shown: matched.length, truncated: aggTruncated,
      text: `${head}\n${kept.join("\n")}${aggTail}`,
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
  // WHICH ceiling stopped the read, not merely THAT one did. Two different bounds
  // can break this loop and they have different remedies, but the tail below used
  // to pick its wording from `wantIds` — a property of the REQUEST — so it named
  // whichever cause it happened to be shaped for. A plain query truncated by the
  // char budget was told to "raise limit" (which changes nothing, and reads as the
  // retry having failed), and an id-scoped query truncated by the node limit was
  // told its "requested nodes exceed max_chars" (which is not what happened).
  // Recording the actual break condition is the whole fix: a message may only name
  // the cause it observed.
  //
  // NOT YET MIRRORED: the panel's live-graph twin (the graph_query executor in
  // comfyui-mcp-panel, which is what panel_query_graph actually runs) still picks
  // its tail the old way. Stated rather than implied, because the header above
  // promises the two stay in lockstep and a reader would otherwise assume the fix
  // reached both surfaces.
  let truncatedBy: "limit" | "chars" | null = null;
  // A COMPACT/IDS row long enough to exceed the whole budget is clipped in place by
  // clipLine. When that row is the protected first match — the ordinary "read one
  // node with a huge widget" case — no row is DROPPED, so `truncatedBy` stays null
  // and the reader used to get a bare "…" with nothing naming the remedy. (The
  // `detail` projection already self-explains via fitDetailLine's
  // `detail_omitted: "raise max_chars"` stub; this closes the same gap for the other
  // two projections.) `truncated` deliberately stays false: it means rows were
  // dropped, which is what panel-tools keys off, and a clipped row is not that.
  let clippedRow = false;
  let chars = header.length;
  for (const id of matched) {
    if (shown >= limit) { truncatedBy = "limit"; break; }
    const n = graph[id] ?? {};
    let line: string;
    if (fields === "ids") {
      const rawId = String(id); // #609: bound even a pathological long id
      line = clipLine(rawId, maxChars);
      // A clipped ID is worse than a clipped compact row: the caller cannot even
      // pass it back, so this branch needs the remedy note at least as much as the
      // other two.
      if (line !== rawId) clippedRow = true;
    } else if (fields === "detail") {
      // #609: bound EVERY field so the protected first line stays O(max_chars): clip
      // the title/type, clip ref-input names + source ids and cap their count, and cap
      // the downstream consumer list (a fan-out hub can have hundreds) — each with a
      // "+N more" / "…" tail. widgets is total-capped by capWidgets.
      const REF_CAP = 64;
      const upRefs: Record<string, string> = {};
      const refEntries = Object.entries(n.inputs ?? {}).filter(([, v]) => isRef(v));
      for (const [k, v] of refEntries.slice(0, REF_CAP)) {
        upRefs[capKey(k)] = clip(`${(v as [unknown, unknown])[0]}.${(v as [unknown, unknown])[1]}`, 128);
      }
      if (refEntries.length > REF_CAP) upRefs["…"] = `+${refEntries.length - REF_CAP} more`;
      const allDown = [...(down.get(String(id)) ?? [])];
      const DOWN_CAP = 64;
      const downstream: Array<string | number> =
        allDown.length > DOWN_CAP ? [...allDown.slice(0, DOWN_CAP), `…+${allDown.length - DOWN_CAP} more`] : allDown;
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
      const w = Object.entries(widgetsOf(n)).map(([k, v]) => `${k}=${clip(v)}`).join(" ");
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
      const full = line;
      line = clipLine(line, maxChars);
      if (line !== full) clippedRow = true;
    }
    const protectedLine = shown === 0; // first match always renders → shown≥1
    if (!protectedLine && chars + line.length + 1 > maxChars) { truncatedBy = "chars"; break; }
    chars += line.length + 1;
    lines.push(line);
    shown++;
  }
  const truncated = truncatedBy !== null;
  // The SCOPE half still keys off the request: "narrow with ids" is dead-end advice
  // for a caller who already named the ids it wants, so that branch offers fewer ids
  // instead. Only the CAUSE half is now driven by what actually happened.
  const narrowing = wantIds?.length
    ? "request fewer ids at once"
    : 'narrow with types/where/ids/depth, or use group_by:"type"';
  // "Raise it" stops being a remedy once the argument is AT its ceiling: the schema
  // rejects anything higher, so a caller told to raise a maxed-out limit is being
  // sent to a guaranteed validation error. At the cap the only real move left is to
  // narrow, and the message says exactly that instead of pretending otherwise.
  const raise = (atCap: boolean, arg: string, cap: number): string =>
    atCap
      ? `${arg} is already at its ${cap} maximum, so ${narrowing}.`
      : `raise ${arg} (max ${cap}), or ${narrowing}.`;
  // The two conditions COMPOSE — they are not alternatives, and writing them as an
  // either/or lost one of them. Rows can be dropped (`truncatedBy`) while a rendered
  // row was ALSO clipped in place (`clippedRow`): ask for `ids` with a 2000-char
  // first id and `limit: 1` and both happen at once. Emitting only the first left the
  // caller raising `limit`, getting the same unusable id back, and concluding the
  // remedy does not work — a remedy that addresses one of two live constraints reads
  // exactly like a broken tool. Each part states its own condition and its own fix.
  const truncationNote = truncatedBy
    ? `\n… truncated at ${shown} of ${matched.length} — ` +
      (truncatedBy === "limit"
        ? `hit the node limit (${limit}); ${raise(limit >= LIMIT_CEILING, "limit", LIMIT_CEILING)}`
        : `hit the max_chars budget (${maxChars}) (per-field values are already capped); ${raise(maxChars >= MAX_CHARS_CEILING, "max_chars", MAX_CHARS_CEILING)}`)
    : "";
  const clippedNote = clippedRow
    ? `\n… a rendered row was itself longer than max_chars (${maxChars}) and was clipped in place — that row is incomplete, though no node was dropped for it; ` +
      (maxChars >= MAX_CHARS_CEILING
        ? `max_chars is already at its ${MAX_CHARS_CEILING} maximum, so this row cannot be rendered whole at all.`
        : `raise max_chars (max ${MAX_CHARS_CEILING}) to read it in full.`)
    : "";
  const tail = truncationNote + clippedNote;
  const body = fields === "ids" ? lines.join(",") : lines.join("\n");
  return {
    total, candidates: candidates.length, matched: matched.length, shown, truncated,
    text: `${header}\n${body}${tail}`,
  };
}
