import type { UiWorkflow } from "../comfyui/types.js";

/** Stats describing a slice result (mirrors the slice-pipeline CLI summary). */
export interface SliceStats {
  nodes: number;
  unbypassed: number;
  links: number;
  subgraphs: number;
  seeds: number;
  badLinks: number;
  orphanGets: number;
}

// Loose working shapes — the UI/litegraph graph is dynamic JSON.
interface WNode {
  id: number;
  type: string;
  pos?: number[];
  mode?: number;
  inputs?: Array<{ link?: number | null }>;
  widgets_values?: unknown[];
}
type WLink = [number, number, number, number, number, string];
interface WGroup {
  title?: string;
  bounding?: number[];
}
interface WGraph {
  nodes?: WNode[];
  links?: unknown[];
  groups?: WGroup[];
  definitions?: { subgraphs?: Array<{ id?: string; nodes?: Array<{ mode?: number; type?: string }> }> };
}

const DEFAULT_KEEP_BYPASSED = ["TextGenerate"];
const SINK_TYPES = new Set([
  "SaveImage",
  "VHS_VideoCombine",
  "SaveVideo",
  "SaveAudio",
  "PreviewImage",
]);

const inBox = (pos: number[] | undefined, b: number[] | undefined): boolean =>
  !!pos && !!b && pos[0] >= b[0] && pos[0] <= b[0] + b[2] && pos[1] >= b[1] && pos[1] <= b[1] + b[3];

/**
 * Slice ONE pipeline out of a toggle-template workflow (the kind built with
 * rgthree "Fast Groups Bypasser/Muter": one graph with many pipelines, only one
 * active at a time). Seeds from the output/SaveImage nodes inside the named
 * groups, takes their backward dependency closure (through real links AND virtual
 * Set/Get buses), un-bypasses the kept nodes (and the internals of any subgraph
 * definitions they use), and returns a standalone, activated UI graph carrying
 * only the subgraph defs it uses.
 *
 * `groupSubstrings` are case-insensitive substrings of group titles whose output
 * nodes seed the slice — shared post-proc (upscale/grain/sharpen) is pulled in
 * automatically via the closure. The opt-in enhancer LLM (`TextGenerate`, or any
 * type in `opts.keepBypassed`) is left bypassed.
 */
export function sliceWorkflow(
  wf: UiWorkflow,
  groupSubstrings: string[],
  opts: { keepBypassed?: string[] } = {},
): { workflow: UiWorkflow; stats: SliceStats } {
  const g = wf as unknown as WGraph;
  const want = groupSubstrings.map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!want.length) throw new Error("Provide at least one group title substring to slice.");
  const keepBypassed = new Set(opts.keepBypassed ?? DEFAULT_KEEP_BYPASSED);

  const allNodes = g.nodes ?? [];
  const nodes = new Map<number, WNode>(allNodes.map((n) => [n.id, n]));
  const allLinks = (g.links ?? []).filter(
    (l): l is WLink => Array.isArray(l) && l.length >= 6,
  );
  const links = new Map<number, WLink>(allLinks.map((l) => [l[0], l]));
  const groups = g.groups ?? [];

  const groupOf = (n: WNode): string =>
    groups.find((gr) => inBox(n.pos, gr.bounding))?.title ?? "";
  const wantNode = (n: WNode): boolean => {
    const t = groupOf(n).toLowerCase();
    return want.some((w) => t.includes(w));
  };

  // Set/Get bus maps (keyed by the bus name in widgets_values[0]).
  const setByBus = new Map<unknown, number>();
  const getBus = new Map<number, unknown>();
  for (const n of allNodes) {
    if (n.type === "SetNode") setByBus.set(n.widgets_values?.[0], n.id);
    else if (n.type === "GetNode") getBus.set(n.id, n.widgets_values?.[0]);
  }
  const incoming = (id: number): Set<number> => {
    const n = nodes.get(id);
    const s = new Set<number>();
    for (const inp of n?.inputs ?? []) {
      const l = inp.link != null ? links.get(inp.link) : undefined;
      if (l) s.add(l[1]);
    }
    if (n?.type === "GetNode") {
      const bus = getBus.get(id);
      const src = setByBus.get(bus);
      if (src != null) s.add(src);
    }
    return s;
  };
  const closure = (seed: number[]): Set<number> => {
    const seen = new Set<number>();
    const st = [...seed];
    while (st.length) {
      const x = st.pop() as number;
      if (seen.has(x)) continue;
      seen.add(x);
      for (const s of incoming(x)) st.push(s);
    }
    return seen;
  };

  const seeds = allNodes.filter((n) => SINK_TYPES.has(n.type) && wantNode(n)).map((n) => n.id);
  if (!seeds.length) {
    throw new Error(
      `No output node (SaveImage / VHS_VideoCombine / …) found in groups matching: ${groupSubstrings.join(", ")}`,
    );
  }
  const keep = closure(seeds);

  // Subgraph instance nodes have a 36-char UUID type.
  const isSubgraph = (id: number): boolean => String(nodes.get(id)?.type ?? "").length === 36;
  let unbypassed = 0;
  const unbyp = (n: { mode?: number; type?: string }): void => {
    if ((n.mode === 2 || n.mode === 4) && !keepBypassed.has(n.type ?? "")) {
      n.mode = 0;
      unbypassed++;
    }
  };

  const newNodes = [...keep].map((id) => structuredClone(nodes.get(id) as WNode));
  for (const n of newNodes) unbyp(n);
  const newLinks = allLinks.filter((l) => keep.has(l[1]) && keep.has(l[3]));
  const usedDefs = new Set([...keep].filter(isSubgraph).map((id) => nodes.get(id)?.type));
  const keptDefs = (g.definitions?.subgraphs ?? [])
    .filter((d) => usedDefs.has(d.id))
    .map((d) => structuredClone(d));
  for (const d of keptDefs) for (const nd of d.nodes ?? []) unbyp(nd);

  const newWf = {
    ...(wf as unknown as WGraph),
    nodes: newNodes,
    links: newLinks,
    groups: groups.filter((gr) => [...keep].some((id) => inBox(nodes.get(id)?.pos, gr.bounding))),
    definitions: { subgraphs: keptDefs },
  } as unknown as UiWorkflow;

  const badLinks = newLinks.filter((l) => !keep.has(l[1]) || !keep.has(l[3])).length;
  const orphanGets = newNodes.filter((n) => {
    if (n.type !== "GetNode") return false;
    const bus = getBus.get(n.id);
    const src = setByBus.get(bus);
    return !(src != null && keep.has(src));
  }).length;

  return {
    workflow: newWf,
    stats: { nodes: newNodes.length, unbypassed, links: newLinks.length, subgraphs: keptDefs.length, seeds: seeds.length, badLinks, orphanGets },
  };
}
