/**
 * Panel modules and the Director's graph tools.
 *
 * Two always-mounted entry points plus one mountable group:
 *
 *   panel_module   — list / describe / open / close / status for every panel module. This is
 *                    the door, so it can never be behind the door: it is not mountable, for
 *                    the same reason the facade tools are exempt from the surface filter.
 *   panel_pane     — read / close / set_dock for whichever side-panel pane is open. Generic
 *                    on purpose: the panel already handled civitai_close, civitai_read,
 *                    civitai_set_dock, training_close and training_set_dock, and no MCP tool
 *                    was ever wired to any of them, so the agent could open a pane and never
 *                    close it. One tool covers every surface, present and future.
 *   panel_director_graph / _link / _subgraph — the Director's graph. Mounted only while the Director
 *                    pane is open (see mountable-tools.ts).
 *
 * Every Director handler forwards ONE command over the bridge — `director_<action>` with the
 * args verbatim — and returns what the editor says. The editor is authoritative: it mints
 * every id and every connect goes through its own validation, so a tool call cannot bypass
 * anything the mouse cannot. That is ifr-node-lab's rule, and it is what keeps a tool edit
 * and a hand edit on exactly one code path.
 *
 * Every multi-purpose tool takes a FLAT `action` enum. A discriminated union renders as zero
 * parameters in the MCP schema and silently breaks dispatch, so per-action requiredness is
 * checked inside the handler — testing `=== undefined`, never falsiness.
 */

import { z } from "zod";
import type { MountGroup } from "./mountable-tools.js";
import type { PanelToolCtx, PanelToolDef, ToolResult } from "./panel-tools.js";
import { panePresence } from "../services/panel-pane-state.js";
import { calliopeSupervise } from "../services/calliope-supervisor.js";

type A = Record<string, unknown>;

const text = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const refuse = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

/** Require a field for an action, `=== undefined` and never falsiness — 0 and "" are values. */
function need(args: A, action: string, ...fields: string[]): ToolResult | null {
  const missing = fields.filter((f) => args[f] === undefined);
  return missing.length ? refuse(`action "${action}" needs ${missing.map((m) => `\`${m}\``).join(", ")}`) : null;
}

const DIRECTOR_READ_MS = 12_000;
const DIRECTOR_WRITE_MS = 20_000;

/** Forward one Director graph command and hand back the editor's reply. */
const forward = (ctx: PanelToolCtx, cmd: string, args: A, timeoutMs: number) => ctx.call({ ...args, cmd }, timeoutMs);

export const PANEL_MODULES = [
  {
    id: "director",
    label: "Director",
    summary:
      "Agent-driven long-form video editor: a nested scene graph of Beats (containers) and Scenes, with Character/Location/Item assets, backed by Calliope for rendering.",
    tools: ["panel_director_graph", "panel_director_link", "panel_director_subgraph"],
  },
] as const;


/** A Calliope call, routed through the pane: (namespace, op — dotted for story.beat.create, positional args). */
const calliope = (ctx: PanelToolCtx, ns: string, op: string, list: unknown[], timeoutMs = DIRECTOR_WRITE_MS) =>
  forward(ctx, "director_calliope", { ns, op, args: list }, timeoutMs);

/** The defined keys of `args` among `keys`, as a request body. */
const pick = (args: A, keys: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (args[k] !== undefined) out[k] = args[k];
  return out;
};

const ACTIVE_JOB = /^(queued|pending|running|in_progress|processing)$/i;

/** ctx.call wraps the panel's reply as text; the job list is inside it, bare or under `result`/`jobs`. */
function jobsFromReply(res: ToolResult): Array<Record<string, unknown>> {
  const first = res.content[0];
  if (!first || first.type !== "text") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(first.text);
  } catch {
    return [];
  }
  const unwrap = (v: unknown): unknown => (v && typeof v === "object" && !Array.isArray(v) ? ((v as Record<string, unknown>).result ?? (v as Record<string, unknown>).jobs ?? v) : v);
  let v = unwrap(parsed);
  if (!Array.isArray(v)) v = unwrap(v);
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

/** The `cal-sc-<id>` node ids the editor mints for Calliope scenes — the one bridge from a graph node back to its row. */
const CAL_SCENE_PREFIX = "cal-sc-";

/** The raw text half of a panel reply, for quoting an error back to the caller. */
function textOf(res: ToolResult): string {
  const first = res.content[0];
  return first && first.type === "text" ? first.text : "";
}

/** The text half of a panel reply, parsed when it is JSON and left as text when it is not. */
function bodyOfReply(res: ToolResult): unknown {
  const raw = textOf(res);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** The nodes array out of an `outline` reply, however the pane wrapped it. */
function nodesFromOutline(res: ToolResult): Array<Record<string, unknown>> {
  let v = bodyOfReply(res);
  for (let hop = 0; hop < 3; hop += 1) {
    if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
    if (!v || typeof v !== "object") return [];
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.nodes)) return o.nodes as Array<Record<string, unknown>>;
    v = o.result ?? o.outline ?? null;
  }
  return [];
}

/**
 * The Calliope scene ids whose Director node is BYPASSED.
 *
 * Bypass is a graph-side fact — the editor mutes a node, nothing in Calliope knows — so the only
 * way a render tool can honour it is to read the outline and map `cal-sc-12` back to scene 12.
 */
function bypassedSceneIds(outline: ToolResult): Set<number> {
  const out = new Set<number>();
  for (const n of nodesFromOutline(outline)) {
    if (n.kind !== "scene" || n.bypassed !== true) continue;
    const raw = typeof n.id === "string" && n.id.startsWith(CAL_SCENE_PREFIX) ? Number(n.id.slice(CAL_SCENE_PREFIX.length)) : Number.NaN;
    if (Number.isInteger(raw)) out.add(raw);
  }
  return out;
}

/** The row id in a create reply, however the pane wrapped it. Null when the reply carried none. */
function rowIdFromReply(res: ToolResult): number | null {
  let v = bodyOfReply(res);
  for (let hop = 0; hop < 3; hop += 1) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.id === "number" && Number.isInteger(o.id)) return o.id;
    v = o.result ?? null;
  }
  return null;
}

/**
 * Block until none of a project's jobs is active, or the budget runs out. Bounded on purpose:
 * an agent that wants to follow a render calls this, not an event stream it would have to be
 * trusted to close.
 */
async function waitForJobs(ctx: PanelToolCtx, projectId: number, timeoutS: number) {
  const budget = Math.min(Math.max(timeoutS, 1), 600) * 1000;
  const started = Date.now();
  for (;;) {
    const res = await calliope(ctx, "jobs", "list", [{ project_id: projectId, limit: 200 }], DIRECTOR_READ_MS);
    if (res.isError) return { settled: false, waited_ms: Date.now() - started, error: res.content[0]?.type === "text" ? res.content[0].text : "jobs_list failed" };
    const jobs = jobsFromReply(res);
    const active = jobs.filter((j) => ACTIVE_JOB.test(String(j.status ?? "")));
    if (!active.length) return { settled: true, waited_ms: Date.now() - started, jobs };
    if (Date.now() - started > budget) return { settled: false, waited_ms: Date.now() - started, active: active.length, jobs };
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * Enqueue a project's videos, honouring the graph's bypass flags.
 *
 * A bypassed node is the user saying "not this shot" on the surface they are looking at, and
 * Calliope cannot see it — the flag lives on the Director's node, not on the scene row. So the
 * skip is done HERE, against the outline read at dispatch time, and the reply says which ids
 * were dropped: a scene that silently did not render is indistinguishable from a queue failure.
 */
async function renderVideos(ctx: PanelToolCtx, args: A): Promise<ToolResult> {
  const pid = args.project_id;
  const requested = (args.scene_ids as number[]) ?? [];
  const body = pick(args, ["scene_ids", "workflow_id", "input_values", "prompts"]);
  if (args.skip_bypassed === false) return calliope(ctx, "jobs", "generateVideos", [pid, body]);

  const outline = await forward(ctx, "director_outline", {}, DIRECTOR_READ_MS);
  if (outline.isError) {
    // Unreadable outline: render what was asked for rather than refuse, and SAY the check
    // did not run — a silent fallback would look exactly like "nothing was bypassed".
    const res = await calliope(ctx, "jobs", "generateVideos", [pid, body]);
    return annotate(res, { bypass_check: "skipped — the outline could not be read", scene_ids: requested });
  }
  const bypassed = bypassedSceneIds(outline);
  const skipped = requested.filter((id) => bypassed.has(id));
  if (!skipped.length) return calliope(ctx, "jobs", "generateVideos", [pid, body]);

  const keep = requested.filter((id) => !bypassed.has(id));
  if (!keep.length) return refuse(`every scene requested is bypassed on the graph (${skipped.join(", ")}) — un-bypass one with panel_director_graph set_bypassed, or pass skip_bypassed false`);
  const res = await calliope(ctx, "jobs", "generateVideos", [pid, { ...body, scene_ids: keep }]);
  return annotate(res, { skipped_bypassed: skipped, scene_ids: keep });
}

/** Wrap a reply with what the tool decided before sending it, keeping the reply's own body intact. */
function annotate(res: ToolResult, note: Record<string, unknown>): ToolResult {
  // A fresh result rather than a spread: rewriting `content` while carrying the original
  // `structuredContent` would leave a machine half that describes the UN-annotated reply.
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ...note, result: bodyOfReply(res) }, null, 2) }],
    ...(res.isError ? { isError: true } : {}),
  };
}

/** Where Calliope answers — the same default the pane uses; override with CALLIOPE_BASE_URL. */
export const DEFAULT_CALLIOPE_BASE_URL = "http://127.0.0.1:8247";

export interface CalliopeProbe {
  reachable: boolean;
  base_url: string;
  version?: string;
  dry_run?: boolean;
  error?: string;
}

/**
 * Is Calliope up? Asked from the orchestrator, not the pane, so `panel_module status` can say
 * so even before the Director is open — the answer decides whether opening it is worth it.
 * Bounded: a backend that hangs reads as unreachable, not as a stuck tool.
 */
export async function probeCalliope(
  baseUrl: string = process.env.CALLIOPE_BASE_URL || DEFAULT_CALLIOPE_BASE_URL,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 1500,
): Promise<CalliopeProbe> {
  const base = baseUrl.replace(/\/+$/, "");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/api/health`, { signal: ctl.signal });
    if (!res.ok) return { reachable: false, base_url: base, error: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      reachable: true,
      base_url: base,
      ...(typeof body.version === "string" ? { version: body.version } : {}),
      ...(typeof body.dry_run === "boolean" ? { dry_run: body.dry_run } : {}),
    };
  } catch (err) {
    return { reachable: false, base_url: base, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export function buildDirectorToolDefs(): Array<PanelToolDef & { mountGroup?: MountGroup }> {
  return [
    {
      name: "panel_module",
      description:
        "Panel modules — sub-panels that ride the agent panel's side-panel shell (the Director today). " +
        "`list` names them and whether each pane is open; `describe` explains one and the tools it mounts; " +
        "`open` opens its pane beside the chat (the user keeps seeing the conversation), which MOUNTS that module's tools — " +
        "call tools/list again after opening, they were not there before; `close` closes the pane and unmounts them; " +
        "`status` reports open/mounted state (for the director, whether Calliope answers). Mounting is deliberate: a module's tools exist only while its pane does. " +
        "`calliope` runs the Director's Calliope bring-up from the installed panel: op `up` clones/installs/starts it if it is not already answering (first run takes minutes), `check` probes, `stop` stops what `up` started.",
      schema: {
        action: z.enum(["list", "describe", "open", "close", "status", "calliope"]).describe("What to do."),
        op: z.enum(["up", "check", "stop"]).optional().describe("calliope: which bring-up step (default up)."),
        module: z.string().optional().describe("Module id, e.g. \"director\". Required for describe/open/status."),
        dock: z.boolean().optional().describe("open: side-dock beside the chat (default true) rather than centred."),
      },
      handler: async (args: A, ctx) => {
        const action = args.action as string;
        const snap = panePresence.snapshot();
        if (action === "calliope") {
          const op = (args.op as "up" | "check" | "stop" | undefined) ?? "up";
          const r = await calliopeSupervise(op);
          return r.ok ? text(r) : { ...text(r), isError: true };
        }
        if (action === "list") {
          return text({
            modules: PANEL_MODULES.map((m) => ({ id: m.id, label: m.label, summary: m.summary, open: snap[m.id]?.open ?? false, mounted: snap[m.id]?.mounted ?? false })),
          });
        }
        const miss = need(args, action, "module");
        if (miss) return miss;
        const mod = PANEL_MODULES.find((m) => m.id === args.module);
        if (!mod) return refuse(`unknown module "${String(args.module)}" — panel_module list names the ones that exist`);
        if (action === "describe") return text({ ...mod, ...snap[mod.id] });
        if (action === "status") return text({ module: mod.id, ...snap[mod.id], ...(mod.id === "director" ? { calliope: await probeCalliope() } : {}) });
        if (action === "open") {
          const res = await ctx.call({ cmd: "module_open", module: mod.id, dock: args.dock !== false }, DIRECTOR_WRITE_MS);
          if (res.isError) return res;
          return text({ ok: true, module: mod.id, note: "pane opened — its tools are now mounted; call tools/list to see them", tools: mod.tools });
        }
        // close
        const res = await ctx.call({ cmd: "pane_close" }, DIRECTOR_READ_MS);
        if (res.isError) return res;
        return text({ ok: true, module: mod.id, note: "pane closed — its tools are unmounted" });
      },
    },
    {
      name: "panel_pane",
      description:
        "The side-panel pane that is currently open (CivitAI, Apps, Training, RunPod, Director). " +
        "`read` reports which pane is showing, whether it is docked, and for the Director the graph outline; " +
        "`close` closes it; `set_dock` docks it beside the chat (true) or centres it (false). " +
        "Use this to tidy up after yourself: a pane you opened stays open until someone closes it.",
      schema: {
        action: z.enum(["read", "close", "set_dock"]).describe("What to do."),
        docked: z.boolean().optional().describe("set_dock: true = beside the chat, false = centred."),
      },
      handler: async (args: A, ctx) => {
        const action = args.action as string;
        if (action === "read") return forward(ctx, "pane_read", {}, DIRECTOR_READ_MS);
        if (action === "close") return forward(ctx, "pane_close", {}, DIRECTOR_READ_MS);
        const miss = need(args, action, "docked");
        if (miss) return miss;
        return forward(ctx, "pane_set_dock", { docked: args.docked }, DIRECTOR_READ_MS);
      },
    },
    {
      name: "panel_director_graph",
      mountGroup: "director",
      description:
        "The Director's scene graph — nodes. `outline` returns every node (Scenes, assets, Beats with their rails) and every wire; read it first, ids come from here. " +
        "`read_node` one node in full; `inspect` opens the editor's inspector on it for the user. `add_node` places a Scene / Character / Location / Item at Director graph x,y (dropping inside a Beat joins it) and returns the id the EDITOR minted. " +
        "`remove_node`, `move_node`, `duplicate` (ids → the new ids), `select` (ids, empty clears), `fit_view` (frame ids, or everything), `set_title`, `set_color` (hex, Beats only), " +
        "`set_node_color` (one leaf's tint; null clears it), `set_collapsed` (subgraphs only), `set_node_collapsed` (collapse a leaf to its header), `set_bypassed` (mute a node: drawn faded and skipped by renders), " +
        "`set_parent` (move a node into a Beat, or out with parent_id null), `set_pin` (show a node on its subgraph's collapsed face — only meaningful inside a subgraph), " +
        "`add_note` / `set_note` (a sticky note at x,y), `reroute` (drop a pass-through dot on a wire at x,y). " +
        "Whole-graph persistence: `export_graph` / `import_graph` (json), `save_named` / `load_named` / `list_saves` / `delete_save` (name), `clear` (empty it), `reset_demo` (back to the demo project). " +
        "The user can be editing the same graph by hand at the same time; re-read the outline rather than assuming your last write is the whole story.",
      schema: {
        action: z
          .enum([
            "outline",
            "read_node",
            "inspect",
            "add_node",
            "remove_node",
            "move_node",
            "duplicate",
            "select",
            "fit_view",
            "set_title",
            "set_color",
            "set_node_color",
            "set_collapsed",
            "set_node_collapsed",
            "set_bypassed",
            "set_parent",
            "set_pin",
            "add_note",
            "set_note",
            "reroute",
            "export_graph",
            "import_graph",
            "save_named",
            "load_named",
            "list_saves",
            "delete_save",
            "clear",
            "reset_demo",
          ])
          .describe("What to do."),
        id: z.string().optional().describe("Node id (from outline). Required for read_node/inspect/remove_node/move_node/set_note and every set_*."),
        ids: z.array(z.string()).optional().describe("duplicate/select/fit_view: node ids. select with [] clears the selection; fit_view without ids frames the whole graph."),
        kind: z.enum(["scene", "character", "location", "item"]).optional().describe("add_node: what to add."),
        x: z.number().optional().describe("add_node/move_node/add_note/reroute: Director graph x."),
        y: z.number().optional().describe("add_node/move_node/add_note/reroute: Director graph y."),
        label: z.string().optional().describe("add_node/set_title: title text."),
        color: z.string().nullable().optional().describe("set_color: hex like #34d399. set_node_color: the same, or null to clear the tint."),
        collapsed: z.boolean().optional().describe("set_collapsed / set_node_collapsed."),
        bypassed: z.boolean().optional().describe("set_bypassed: muted or not."),
        parent_id: z.string().nullable().optional().describe("set_parent: Beat id, or null to move to the top level."),
        promoted: z.boolean().optional().describe("set_pin: pinned or not."),
        text: z.string().optional().describe("add_note/set_note: the note's text (markdown)."),
        edge_id: z.string().optional().describe("reroute: the wire to drop the dot onto (from outline)."),
        json: z.string().optional().describe("import_graph: a graph as export_graph returned it."),
        name: z.string().optional().describe("save_named/load_named/delete_save: the save's name."),
      },
      handler: async (args: A, ctx) => {
        const action = args.action as string;
        const required: Record<string, string[]> = {
          outline: [],
          read_node: ["id"],
          inspect: ["id"],
          add_node: ["kind", "x", "y"],
          remove_node: ["id"],
          move_node: ["id", "x", "y"],
          duplicate: ["ids"],
          select: ["ids"],
          fit_view: [],
          set_title: ["id", "label"],
          set_color: ["id", "color"],
          set_node_color: ["id", "color"],
          set_collapsed: ["id", "collapsed"],
          set_node_collapsed: ["id", "collapsed"],
          set_bypassed: ["id", "bypassed"],
          set_parent: ["id", "parent_id"],
          set_pin: ["id", "promoted"],
          add_note: ["x", "y", "text"],
          set_note: ["id", "text"],
          reroute: ["edge_id", "x", "y"],
          export_graph: [],
          import_graph: ["json"],
          save_named: ["name"],
          load_named: ["name"],
          list_saves: [],
          delete_save: ["name"],
          clear: [],
          reset_demo: [],
        };
        const miss = need(args, action, ...(required[action] ?? []));
        if (miss) return miss;
        const { action: _a, ...rest } = args;
        // Reads are cheap and must not sit on the write budget; everything else can redraw the graph.
        const READS = new Set(["outline", "read_node", "export_graph", "list_saves"]);
        return forward(ctx, `director_${action}`, rest, READS.has(action) ? DIRECTOR_READ_MS : DIRECTOR_WRITE_MS);
      },
    },
    {
      name: "panel_director_link",
      mountGroup: "director",
      description:
        "The Director's scene graph — wires. `connect` a source handle to a target handle (handle ids look like `sc-01:out:LAST FRAME` and `sc-02:in:IN FRAME`; a Beat's rails are `<beat>::<child handle>`); " +
        "types must match (text/ref/image/video) and an input takes one wire, so connecting replaces what was there. `disconnect` by edge_id, or by target_handle to clear an input. " +
        "`repair` re-derives every Beat's rails from the wires — use it if a rail looks wrong. Wires that cross a Beat boundary become rails automatically; you never wire to a rail's inner side yourself.",
      schema: {
        action: z.enum(["connect", "disconnect", "repair"]).describe("What to do."),
        source_handle: z.string().optional().describe("connect: `<node>:out:<PORT>` or a Beat's output rail id."),
        target_handle: z.string().optional().describe("connect/disconnect: `<node>:in:<PORT>` or a Beat's input rail id."),
        edge_id: z.string().optional().describe("disconnect: the wire id from outline."),
      },
      handler: async (args: A, ctx) => {
        const action = args.action as string;
        if (action === "connect") {
          const miss = need(args, action, "source_handle", "target_handle");
          if (miss) return miss;
        } else if (action === "disconnect" && args.edge_id === undefined && args.target_handle === undefined) {
          return refuse('action "disconnect" needs `edge_id` or `target_handle`');
        }
        const { action: _a, ...rest } = args;
        return forward(ctx, `director_${action}`, rest, DIRECTOR_WRITE_MS);
      },
    },
    {
      name: "panel_director_subgraph",
      mountGroup: "director",
      description:
        "The Director's Beats. A Beat is a container: `group` wraps node_ids in a new Beat; `promote` turns a Beat into a SUBGRAPH, which exposes every wire crossing its boundary as a named rail; " +
        "`dissolve` turns it back into a plain group; `reconcile` re-derives one Beat's rails. Rails are user-labelled: `set_rail_label` and `reorder_rail` (side in/out, from → to index). " +
        "`delete_container` removes a Beat: mode `all` takes everything inside with it, mode `shell` keeps the children and lifts them out. " +
        "Blueprints are reusable Beats: `save_blueprint` a subgraph under a name, `list_blueprints`, `apply_blueprint` to stamp a copy at x,y, `update_blueprint` to re-save one from a Beat (id), `delete_blueprint` to drop it.",
      schema: {
        action: z
          .enum([
            "group",
            "promote",
            "dissolve",
            "reconcile",
            "delete_container",
            "set_rail_label",
            "reorder_rail",
            "save_blueprint",
            "list_blueprints",
            "apply_blueprint",
            "update_blueprint",
            "delete_blueprint",
          ])
          .describe("What to do."),
        id: z.string().optional().describe("Beat id. Required for promote/dissolve/reconcile/delete_container/set_rail_label/reorder_rail/save_blueprint; optional for update_blueprint (the Beat to re-save from)."),
        node_ids: z.array(z.string()).optional().describe("group: nodes to wrap."),
        label: z.string().optional().describe("group: the new Beat's title; set_rail_label: the new label."),
        port_id: z.string().optional().describe("set_rail_label: the rail's id (from outline)."),
        side: z.enum(["in", "out"]).optional().describe("reorder_rail: which rail."),
        from: z.number().int().optional().describe("reorder_rail: current index."),
        to: z.number().int().optional().describe("reorder_rail: new index."),
        mode: z.enum(["all", "shell"]).optional().describe("delete_container: `all` deletes the children too, `shell` keeps them."),
        name: z.string().optional().describe("save_blueprint: blueprint name."),
        blueprint_id: z.string().optional().describe("apply_blueprint/update_blueprint/delete_blueprint: id from list_blueprints."),
        x: z.number().optional().describe("apply_blueprint: Director graph x."),
        y: z.number().optional().describe("apply_blueprint: Director graph y."),
      },
      handler: async (args: A, ctx) => {
        const action = args.action as string;
        const required: Record<string, string[]> = {
          group: ["node_ids"],
          promote: ["id"],
          dissolve: ["id"],
          reconcile: ["id"],
          delete_container: ["id", "mode"],
          set_rail_label: ["id", "port_id", "label"],
          reorder_rail: ["id", "side", "from", "to"],
          save_blueprint: ["id", "name"],
          list_blueprints: [],
          apply_blueprint: ["blueprint_id", "x", "y"],
          update_blueprint: ["blueprint_id"],
          delete_blueprint: ["blueprint_id"],
        };
        const miss = need(args, action, ...(required[action] ?? []));
        if (miss) return miss;
        const { action: _a, ...rest } = args;
        return forward(ctx, `director_${action}`, rest, action === "list_blueprints" ? DIRECTOR_READ_MS : DIRECTOR_WRITE_MS);
      },
    },

    // ── Calliope-backed tools ───────────────────────────────────────────────────
    // These do not touch the Director's graph algebra; they reach Calliope THROUGH the pane, which owns
    // the only client and re-reads the project after a mutation so the Director's graph shows what the
    // agent did. The pane refuses a (namespace, op) pair that is not a client method.
    {
      name: "panel_director_project",
      mountGroup: "director",
      description:
        "Calliope projects behind the Director. `list` them; `create` one (title, optional idea/genre/tone/target_duration) — then `open` it so the Director's graph shows it; " +
        "`current` says which project the Director's graph has loaded and whether Calliope is reachable; `refresh` re-reads it; `patch` edits title/idea/genre/tone/target_duration/status; `delete` removes a project and everything in it. " +
        "`set_cover` sets the project's poster image to a produced file's cover_path, or clears it with an explicit null. " +
        "`settings_get` / `settings_set` read and write Calliope's own settings (its ComfyUI URL, queue concurrency, dry_run) — its LLM settings are dead config here: this agent is the only model in the loop.",
      schema: {
        action: z.enum(["list", "create", "open", "current", "refresh", "patch", "set_cover", "delete", "settings_get", "settings_set"]).describe("What to do."),
        project_id: z.number().int().optional().describe("open/patch/set_cover/delete: which project."),
        title: z.string().optional(),
        idea: z.string().optional().describe("The premise, in a sentence or a paragraph."),
        genre: z.string().optional(),
        tone: z.string().optional(),
        target_duration: z.string().optional().describe("e.g. '2 min'."),
        status: z.string().optional().describe("patch: project status."),
        cover_path: z.string().nullable().optional().describe("set_cover: the poster image's path, or null to clear it."),
        settings: z.record(z.string(), z.unknown()).optional().describe("settings_set: the keys to change."),
      },
      handler: async (args: A, ctx) => {
        const action = args.action as string;
        const required: Record<string, string[]> = {
          create: ["title"],
          open: ["project_id"],
          patch: ["project_id"],
          // cover_path is required so CLEARING is something the caller said, not something an
          // omitted field did: `null` is the clear, and there is no way to reach it by accident.
          set_cover: ["project_id", "cover_path"],
          delete: ["project_id"],
          settings_set: ["settings"],
        };
        const miss = need(args, action, ...(required[action] ?? []));
        if (miss) return miss;
        const body = pick(args, ["title", "idea", "genre", "tone", "target_duration", "status"]);
        switch (action) {
          case "list":
            return calliope(ctx, "projects", "list", [], DIRECTOR_READ_MS);
          case "create":
            return calliope(ctx, "projects", "create", [body]);
          case "open":
            return forward(ctx, "director_project_open", { project_id: args.project_id }, DIRECTOR_WRITE_MS);
          case "current":
            return forward(ctx, "director_project_current", {}, DIRECTOR_READ_MS);
          case "refresh":
            return forward(ctx, "director_project_refresh", {}, DIRECTOR_WRITE_MS);
          case "patch":
            return calliope(ctx, "projects", "patch", [args.project_id, body]);
          case "set_cover":
            // Explicitly `cover_path`, never `pick`: an omitted key does not clear a column, a null does.
            return calliope(ctx, "projects", "patch", [args.project_id, { cover_path: args.cover_path ?? null }]);
          case "delete":
            return calliope(ctx, "projects", "delete", [args.project_id]);
          case "settings_get":
            return calliope(ctx, "settings", "get", [], DIRECTOR_READ_MS);
          default:
            return calliope(ctx, "settings", "set", [args.settings]);
        }
      },
    },
    {
      name: "panel_director_story",
      mountGroup: "director",
      description:
        "The story layer of a Calliope project: Beats, Characters, Locations, Items. `read` returns the whole bundle. " +
        "Beats (title, description, order_index) become Beat containers on the Director's graph; Characters (name, role, age, appearance, personality, consistency_prompt), Locations and Items (name, description, consistency_prompt) become asset nodes whose REF output wires into scenes. " +
        "Add/update/delete each with `<entity>_add`, `<entity>_update` (needs id), `<entity>_delete` (needs id). This agent writes the story; Calliope's own generators are never called.",
      schema: {
        action: z
          .enum(["read", "beat_add", "beat_update", "beat_delete", "character_add", "character_update", "character_delete", "location_add", "location_update", "location_delete", "item_add", "item_update", "item_delete"])
          .describe("What to do."),
        project_id: z.number().int().describe("The project."),
        id: z.number().int().optional().describe("update/delete: the row id."),
        title: z.string().optional().describe("Beat title."),
        description: z.string().optional(),
        order_index: z.number().int().optional().describe("Beat order."),
        name: z.string().optional().describe("Character/Location/Item name."),
        role: z.string().optional(),
        age: z.string().optional(),
        appearance: z.string().optional(),
        personality: z.string().optional(),
        consistency_prompt: z.string().optional().describe("The phrase every generation of this asset repeats, for consistency."),
      },
      handler: async (args: A, ctx) => {
        const action = args.action as string;
        const pid = args.project_id;
        if (action === "read") return calliope(ctx, "story", "get", [pid], DIRECTOR_READ_MS);
        const [entity, verb] = action.split("_") as [string, string];
        const fields: Record<string, string[]> = {
          beat: ["title", "description", "order_index"],
          character: ["name", "role", "age", "appearance", "personality", "consistency_prompt"],
          location: ["name", "description", "consistency_prompt"],
          item: ["name", "description", "consistency_prompt"],
        };
        const nameField = entity === "beat" ? "title" : "name";
        const miss = need(args, action, ...(verb === "add" ? [nameField] : ["id"]));
        if (miss) return miss;
        const body = pick(args, fields[entity] ?? []);
        if (verb === "add") return calliope(ctx, "story", `${entity}.create`, [pid, body]);
        if (verb === "update") return calliope(ctx, "story", `${entity}.patch`, [pid, args.id, body]);
        return calliope(ctx, "story", `${entity}.delete`, [pid, args.id]);
      },
    },
    {
      name: "panel_director_scene",
      mountGroup: "director",
      description:
        "Scenes — the shots. `list` them (with the estimated total duration); `add` one (heading, action, dialog, duration_sec, beat_id, location_id, character_ids, workflow_id, chain_from_prev — the create endpoint has no continuity field, so `add` sets it with a follow-up patch and reports the new scene_id); `patch` any of those by scene_id; `delete`; " +
        "`reorder` with the full scene_ids list — order_index IS the timeline, so this is the cut order. `set_prompt` stores the exact video prompt a scene will render with (this agent authors prompts; the draft is stamped against the scene's current text so Calliope honours it — edit the scene text and you must set the prompt again).",
      schema: {
        action: z.enum(["list", "add", "patch", "delete", "reorder", "set_prompt"]).describe("What to do."),
        project_id: z.number().int().describe("The project."),
        scene_id: z.number().int().optional().describe("patch/delete/set_prompt: which scene."),
        heading: z.string().optional(),
        action_text: z.string().optional().describe("The scene's action line (what happens)."),
        dialog: z.string().optional(),
        duration_sec: z.number().int().optional(),
        beat_id: z.number().int().nullable().optional().describe("Which Beat the scene belongs to."),
        location_id: z.number().int().nullable().optional(),
        character_ids: z.array(z.number().int()).optional(),
        workflow_id: z.number().int().nullable().optional(),
        chain_from_prev: z.boolean().optional().describe("Start this scene from the previous scene's last frame — the continuity wire."),
        order_index: z.number().int().optional(),
        scene_ids: z.array(z.number().int()).optional().describe("reorder: every scene id, in the new order."),
        prompt: z.string().optional().describe("set_prompt: the full prompt text."),
      },
      handler: async (args: A, ctx) => {
        const action = args.action as string;
        const pid = args.project_id;
        const required: Record<string, string[]> = { add: ["heading"], patch: ["scene_id"], delete: ["scene_id"], reorder: ["scene_ids"], set_prompt: ["scene_id", "prompt"] };
        const miss = need(args, action, ...(required[action] ?? []));
        if (miss) return miss;
        // `chain_from_prev` is deliberately NOT in this list: Calliope's SceneCreate has no such
        // field (only SceneUpdate does), so sending it on create is silently dropped by the
        // endpoint — the continuity flag would read as set and never be.
        const body = pick(args, ["heading", "dialog", "duration_sec", "beat_id", "location_id", "character_ids", "workflow_id", "order_index"]);
        if (args.action_text !== undefined) body.action = args.action_text;
        switch (action) {
          case "list":
            return calliope(ctx, "scenes", "list", [pid], DIRECTOR_READ_MS);
          case "add": {
            const created = await calliope(ctx, "scenes", "create", [pid, body]);
            if (created.isError || args.chain_from_prev === undefined) return created;
            // Two frames, on purpose: create, then patch the one field create cannot carry.
            const newId = rowIdFromReply(created);
            if (newId === null) {
              return {
                ...created,
                content: [
                  ...created.content,
                  { type: "text" as const, text: 'note: chain_from_prev was NOT applied — the create reply carried no scene id. Set it with action "patch" once you know the id.' },
                ],
              };
            }
            const chained = await calliope(ctx, "scenes", "patch", [pid, newId, { chain_from_prev: args.chain_from_prev }]);
            // The scene EXISTS either way — say so, or the agent retries `add` and gets a duplicate.
            if (chained.isError) return refuse(`scene ${newId} was created, but chain_from_prev could not be set: ${textOf(chained)}`);
            return text({ scene_id: newId, created: bodyOfReply(created), chain_from_prev: args.chain_from_prev, chained: bodyOfReply(chained) });
          }
          case "patch":
            return calliope(ctx, "scenes", "patch", [pid, args.scene_id, { ...body, ...pick(args, ["chain_from_prev"]) }]);
          case "delete":
            return calliope(ctx, "scenes", "delete", [pid, args.scene_id]);
          case "reorder":
            return calliope(ctx, "scenes", "reorder", [pid, { scene_ids: args.scene_ids }]);
          default:
            return forward(ctx, "director_scene_set_prompt", { project_id: pid, scene_id: args.scene_id, prompt: args.prompt }, DIRECTOR_WRITE_MS);
        }
      },
    },
    {
      name: "panel_director_workflow",
      mountGroup: "director",
      description:
        "The ComfyUI workflows Calliope renders with (API-format JSON; node roles come from titles like `Display Name (Input:prompt)`). `list` / `get` them; `analyze` a workflow_json to see which roles it exposes before you `register` it (name, kind, workflow_json); " +
        "`patch` name/kind/description/prompt_profile/is_enabled; `delete`. A Scene's ports map onto the roles prompt, character, location, image, video — a workflow without the role a scene wires receives nothing there.",
      schema: {
        action: z.enum(["list", "get", "analyze", "register", "patch", "delete"]).describe("What to do."),
        workflow_id: z.number().int().optional(),
        name: z.string().optional(),
        kind: z.string().optional().describe("e.g. 'video' or 'image'."),
        description: z.string().optional(),
        prompt_profile: z.string().optional(),
        is_enabled: z.boolean().optional(),
        workflow_json: z.record(z.string(), z.unknown()).optional().describe("analyze/register: the API-format workflow."),
      },
      handler: async (args: A, ctx) => {
        const action = args.action as string;
        const required: Record<string, string[]> = { get: ["workflow_id"], analyze: ["workflow_json"], register: ["name", "workflow_json"], patch: ["workflow_id"], delete: ["workflow_id"] };
        const miss = need(args, action, ...(required[action] ?? []));
        if (miss) return miss;
        switch (action) {
          case "list":
            return calliope(ctx, "workflows", "list", [], DIRECTOR_READ_MS);
          case "get":
            return calliope(ctx, "workflows", "get", [args.workflow_id], DIRECTOR_READ_MS);
          case "analyze":
            return calliope(ctx, "workflows", "analyze", [{ workflow_json: args.workflow_json }], DIRECTOR_READ_MS);
          case "register":
            return calliope(ctx, "workflows", "create", [pick(args, ["name", "kind", "workflow_json"])]);
          case "patch":
            return calliope(ctx, "workflows", "patch", [args.workflow_id, pick(args, ["name", "kind", "description", "prompt_profile", "is_enabled"])]);
          default:
            return calliope(ctx, "workflows", "delete", [args.workflow_id]);
        }
      },
    },
    {
      name: "panel_director_render",
      mountGroup: "director",
      description:
        "Rendering through Calliope's queue. `videos_generate` enqueues scene_ids (optionally a workflow_id, input_values, and `prompts` keyed by scene id — the surest way to render exactly the text you wrote), skipping any scene whose node the user has bypassed unless you pass skip_bypassed false; " +
        "`render_scene` opens the editor's composer on one scene instead of enqueuing it; `preview_prompt` shows what a scene would send; `assets_generate` renders portraits and environment images for character_ids/location_ids/item_ids (missing_only by default). " +
        "`jobs_list` (filter by project_id/status), `job_get`, `job_retry`, `job_cancel`; `queue_status`, `queue_pause`, `queue_resume`. `wait` blocks until the project's jobs settle or timeout_s passes and returns them. `export` concatenates the finished clips into the film. " +
        "`attach` puts a produced file (path) on a scene, character, location or item — it needs the project_id. `playground_jobs` lists the playground's own renders and `playground_delete` removes one with its files.",
      schema: {
        action: z
          .enum([
            "videos_generate",
            "render_scene",
            "preview_prompt",
            "assets_generate",
            "jobs_list",
            "job_get",
            "job_retry",
            "job_cancel",
            "queue_status",
            "queue_pause",
            "queue_resume",
            "wait",
            "export",
            "attach",
            "playground_jobs",
            "playground_delete",
          ])
          .describe("What to do."),
        project_id: z.number().int().optional().describe("Required for videos_generate/preview_prompt/assets_generate/wait/export; filters jobs_list."),
        scene_ids: z.array(z.number().int()).optional(),
        scene_id: z.number().int().optional(),
        workflow_id: z.number().int().optional(),
        input_values: z.record(z.string(), z.unknown()).optional().describe("Extra role values (seed, width, height, duration…)."),
        prompts: z.record(z.string(), z.string()).optional().describe("videos_generate: scene id → the exact prompt to render."),
        character_ids: z.array(z.number().int()).optional(),
        location_ids: z.array(z.number().int()).optional(),
        item_ids: z.array(z.number().int()).optional(),
        missing_only: z.boolean().optional(),
        asset_target: z.string().optional(),
        prompt: z.string().optional().describe("assets_generate: an explicit prompt."),
        job_id: z.number().int().optional(),
        status: z.string().optional().describe("jobs_list: filter."),
        limit: z.number().int().optional(),
        timeout_s: z.number().optional().describe("wait: how long to block (default 120, max 600)."),
        skip_bypassed: z.boolean().optional().describe("videos_generate: leave out scenes whose Director node is bypassed (default true)."),
        path: z.string().optional().describe("attach: the produced file."),
        target: z.string().optional().describe("attach: the endpoint's own names — character_sheet | location | item | scene."),
        character_id: z.number().int().optional(),
        location_id: z.number().int().optional(),
        item_id: z.number().int().optional(),
        name: z.string().optional(),
      },
      handler: async (args: A, ctx) => {
        const action = args.action as string;
        const required: Record<string, string[]> = {
          videos_generate: ["project_id", "scene_ids"],
          render_scene: ["scene_id"],
          preview_prompt: ["project_id", "scene_id"],
          assets_generate: ["project_id"],
          job_get: ["job_id"],
          job_retry: ["job_id"],
          job_cancel: ["job_id"],
          wait: ["project_id"],
          export: ["project_id"],
          // PlaygroundAttach declares project_id REQUIRED; omitting it is a 422, not a default.
          attach: ["path", "target", "project_id"],
          playground_delete: ["job_id"],
        };
        const miss = need(args, action, ...(required[action] ?? []));
        if (miss) return miss;
        const pid = args.project_id;
        switch (action) {
          case "videos_generate":
            return renderVideos(ctx, args);
          case "render_scene":
            return forward(ctx, "director_render_scene", { scene_id: args.scene_id }, DIRECTOR_WRITE_MS);
          case "preview_prompt":
            return calliope(ctx, "jobs", "previewPrompt", [pid, pick(args, ["scene_id", "workflow_id"])], DIRECTOR_READ_MS);
          case "assets_generate":
            return calliope(ctx, "assets", "generate", [pid, pick(args, ["character_ids", "location_ids", "item_ids", "missing_only", "workflow_id", "input_values", "asset_target", "prompt"])]);
          case "jobs_list":
            return calliope(ctx, "jobs", "list", [pick(args, ["project_id", "status", "limit"])], DIRECTOR_READ_MS);
          case "job_get":
            return calliope(ctx, "jobs", "get", [args.job_id], DIRECTOR_READ_MS);
          case "job_retry":
            return calliope(ctx, "jobs", "retry", [args.job_id]);
          case "job_cancel":
            return calliope(ctx, "jobs", "cancel", [args.job_id]);
          case "queue_status":
            return calliope(ctx, "jobs", "queueStatus", [], DIRECTOR_READ_MS);
          case "queue_pause":
            return calliope(ctx, "jobs", "pause", []);
          case "queue_resume":
            return calliope(ctx, "jobs", "resume", []);
          case "export":
            return calliope(ctx, "jobs", "exportFilm", [pid]);
          case "attach":
            return calliope(ctx, "playground", "attach", [pick(args, ["path", "project_id", "target", "character_id", "location_id", "item_id", "scene_id", "name"])]);
          case "playground_jobs":
            // `jobs(limit = 50)` takes a POSITIONAL scalar, not a query object — an omitted
            // limit must be an absent argument so the client's own default applies.
            return calliope(ctx, "playground", "jobs", args.limit === undefined ? [] : [args.limit], DIRECTOR_READ_MS);
          case "playground_delete":
            return calliope(ctx, "playground", "deleteJob", [args.job_id]);
          default:
            return text(await waitForJobs(ctx, pid as number, typeof args.timeout_s === "number" ? args.timeout_s : 120));
        }
      },
    },
  ];
}

/** Names this module contributes — what the panel vocabulary baseline must carry. */
export const DIRECTOR_TOOL_NAMES = [
  "panel_module",
  "panel_pane",
  "panel_director_graph",
  "panel_director_link",
  "panel_director_subgraph",
  "panel_director_project",
  "panel_director_story",
  "panel_director_scene",
  "panel_director_workflow",
  "panel_director_render",
] as const;
