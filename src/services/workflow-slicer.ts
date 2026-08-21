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
  const g = wf as WGraph;
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
    // #690(4) — the old message named only what was searched FOR, never what was
    // there, so six different substrings produced six identical dead ends and the
    // caller had no way to converge except guessing. Everything needed to explain
    // the miss is already in hand here.
    throw new Error(
      describeSliceMiss({
        groupSubstrings,
        groupTitles: groups.map((gr) => gr.title ?? ""),
        sinks: allNodes
          .filter((n) => SINK_TYPES.has(n.type))
          .map((n) => ({ id: n.id, type: n.type, group: groupOf(n) })),
      }),
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
    ...g,
    nodes: newNodes,
    links: newLinks,
    groups: groups.filter((gr) => [...keep].some((id) => inBox(nodes.get(id)?.pos, gr.bounding))),
    definitions: { subgraphs: keptDefs },
  } as UiWorkflow;

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

/** Cap the enumerations so a 200-group workflow cannot turn one refusal into a wall
 *  of text. The counts are always exact, so a truncated list still says how much it
 *  is hiding rather than quietly implying that is all there is. */
const SLICE_MISS_LIST_CAP = 25;

function capped(items: string[], cap = SLICE_MISS_LIST_CAP): string {
  if (!items.length) return "(none)";
  if (items.length <= cap) return items.join(", ");
  return `${items.slice(0, cap).join(", ")} … and ${items.length - cap} more`;
}

/**
 * #690(4) — explain a slice that matched no output node.
 *
 * The reporter tried six different `groups` substrings against one workflow and got
 * the same message every time: it named the substrings they had just supplied and
 * nothing about the workflow, so there was no way to converge except blind trial and
 * error. Their workflow DID have an output node (a `SaveVideo`, node 92) — and
 * `SaveVideo` is in SINK_TYPES, so the sink type was never the problem. What failed
 * was group matching: a node belongs to a group only by falling inside its bounding
 * box, so an output node sitting outside every group, or inside one whose title none
 * of the substrings match, yields no seeds.
 *
 * Both facts are known at the throw site, so the refusal now carries them:
 *   • the group titles that actually exist — no more guessing at names;
 *   • every output node found ANYWHERE in the workflow and the group it falls in,
 *     which distinguishes "your substring is wrong" from "this output node is not
 *     inside any group at all" — two different fixes that produced one message.
 *
 * Deliberately still a REFUSAL. Falling back to "slice from any output node" would
 * silently produce a different workflow than the caller asked for, which is worse
 * than a clear stop.
 */
export function describeSliceMiss(info: {
  groupSubstrings: string[];
  groupTitles: string[];
  sinks: Array<{ id: number; type: string; group: string }>;
}): string {
  const { groupSubstrings, groupTitles, sinks } = info;
  const titles = groupTitles.map((t) => String(t ?? "").trim()).filter(Boolean);
  const lines = [
    `No output node (SaveImage / VHS_VideoCombine / SaveVideo / SaveAudio / PreviewImage) ` +
      `found in groups matching: ${groupSubstrings.join(", ")}`,
    `Groups in this workflow (${titles.length}): ${capped(titles)}`,
  ];
  if (!sinks.length) {
    lines.push(
      "This workflow contains NO output node of any recognized type, so no substring can " +
        "match — slicing needs one to seed from.",
    );
  } else {
    lines.push(
      `Output nodes present (${sinks.length}): ` +
        capped(sinks.map((s) => `#${s.id} ${s.type} in ${s.group ? `"${s.group}"` : "NO group"}`)),
    );
    // The distinction that decides what to do next. A node belongs to a group purely
    // by geometry, so an output node outside every box can never be matched by any
    // substring, and telling the caller to try another one would send them in circles.
    if (sinks.every((s) => !s.group)) {
      lines.push(
        "None of them is inside ANY group, so no `groups` value can match. Move the output " +
          "node into the group's bounds on the canvas, or slice a workflow whose pipelines " +
          "are grouped.",
      );
    } else {
      lines.push("Pass a substring of one of the group titles listed above.");
    }
  }
  return lines.join("\n");
}
