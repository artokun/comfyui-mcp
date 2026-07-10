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
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
  const maxChars = Math.min(Math.max(opts.max_chars ?? 12000, 500), 60000);

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
    text: `${which} node ${id} not found in the graph (${total} nodes).`,
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
      throw new Error(`Bad predicate "${w}" — expected "name op value" with op one of = != >= <= > < ~`);
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
    const lines = [...hist.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => `${c}× ${t}`);
    return {
      total, candidates: candidates.length, matched: matched.length,
      shown: matched.length, truncated: false,
      text: `${matched.length} node(s) across ${hist.size} type(s):\n${lines.join("\n")}`,
    };
  }

  // 4) Projection, char-bounded.
  const fields = opts.fields ?? "compact";
  const header =
    `${matched.length} match(es) of ${candidates.length} in scope (graph: ${total} nodes)` +
    (scope ? ` · traversal${Number.isFinite(depth) ? ` depth≤${depth}` : ""}` : "");
  const lines: string[] = [];
  let shown = 0;
  let truncated = false;
  let chars = header.length;
  for (const id of matched) {
    if (shown >= limit) { truncated = true; break; }
    const n = graph[id] ?? {};
    let line: string;
    if (fields === "ids") {
      line = String(id);
    } else if (fields === "detail") {
      const upRefs: Record<string, string> = {};
      for (const [k, v] of Object.entries(n.inputs ?? {})) if (isRef(v)) upRefs[k] = `${v[0]}.${v[1]}`;
      line = JSON.stringify({
        id, type: n.class_type ?? "?", title: n._meta?.title,
        widgets: widgetsOf(n), upstream: upRefs, downstream: [...(down.get(String(id)) ?? [])],
      });
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
    }
    if (chars + line.length + 1 > maxChars) { truncated = true; break; }
    chars += line.length + 1;
    lines.push(line);
    shown++;
  }
  const tail = truncated
    ? `\n… truncated at ${shown} of ${matched.length} — narrow with types/where/ids/depth, use group_by:"type", or raise limit.`
    : "";
  const body = fields === "ids" ? lines.join(",") : lines.join("\n");
  return {
    total, candidates: candidates.length, matched: matched.length, shown, truncated,
    text: `${header}\n${body}${tail}`,
  };
}
