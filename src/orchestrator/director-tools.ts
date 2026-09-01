/**
 * Panel modules and the Director's canvas tools.
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
 *   panel_director_graph / _link / _subgraph — the canvas. Mounted only while the Director
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

/** Forward one canvas command and hand back the editor's reply. */
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

export function buildDirectorToolDefs(): Array<PanelToolDef & { mountGroup?: MountGroup }> {
  return [
    {
      name: "panel_module",
      description:
        "Panel modules — sub-panels that ride the agent panel's side-panel shell (the Director today). " +
        "`list` names them and whether each pane is open; `describe` explains one and the tools it mounts; " +
        "`open` opens its pane beside the chat (the user keeps seeing the conversation), which MOUNTS that module's tools — " +
        "call tools/list again after opening, they were not there before; `close` closes the pane and unmounts them; " +
        "`status` reports open/mounted state. Mounting is deliberate: a module's tools exist only while its pane does.",
      schema: {
        action: z.enum(["list", "describe", "open", "close", "status"]).describe("What to do."),
        module: z.string().optional().describe("Module id, e.g. \"director\". Required for describe/open/status."),
        dock: z.boolean().optional().describe("open: side-dock beside the chat (default true) rather than centred."),
      },
      handler: async (args: A, ctx) => {
        const action = args.action as string;
        const snap = panePresence.snapshot();
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
        if (action === "status") return text({ module: mod.id, ...snap[mod.id] });
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
        "`read_node` one node in full. `add_node` places a Scene / Character / Location / Item at canvas x,y (dropping inside a Beat joins it) and returns the id the EDITOR minted. " +
        "`remove_node`, `move_node`, `set_title`, `set_color` (hex, Beats only), `set_collapsed` (subgraphs only), " +
        "`set_parent` (move a node into a Beat, or out with parent_id null), `set_pin` (show a node on its subgraph's collapsed face — only meaningful inside a subgraph). " +
        "The user can be editing the same graph by hand at the same time; re-read the outline rather than assuming your last write is the whole story.",
      schema: {
        action: z.enum(["outline", "read_node", "add_node", "remove_node", "move_node", "set_title", "set_color", "set_collapsed", "set_parent", "set_pin"]).describe("What to do."),
        id: z.string().optional().describe("Node id (from outline). Required for everything but outline/add_node."),
        kind: z.enum(["scene", "character", "location", "item"]).optional().describe("add_node: what to add."),
        x: z.number().optional().describe("add_node/move_node: canvas x."),
        y: z.number().optional().describe("add_node/move_node: canvas y."),
        label: z.string().optional().describe("add_node/set_title: title text."),
        color: z.string().optional().describe("set_color: hex like #34d399."),
        collapsed: z.boolean().optional().describe("set_collapsed."),
        parent_id: z.string().nullable().optional().describe("set_parent: Beat id, or null to move to the top level."),
        promoted: z.boolean().optional().describe("set_pin: pinned or not."),
      },
      handler: async (args: A, ctx) => {
        const action = args.action as string;
        const required: Record<string, string[]> = {
          outline: [],
          read_node: ["id"],
          add_node: ["kind", "x", "y"],
          remove_node: ["id"],
          move_node: ["id", "x", "y"],
          set_title: ["id", "label"],
          set_color: ["id", "color"],
          set_collapsed: ["id", "collapsed"],
          set_parent: ["id", "parent_id"],
          set_pin: ["id", "promoted"],
        };
        const miss = need(args, action, ...(required[action] ?? []));
        if (miss) return miss;
        const { action: _a, ...rest } = args;
        return forward(ctx, `director_${action}`, rest, action === "outline" || action === "read_node" ? DIRECTOR_READ_MS : DIRECTOR_WRITE_MS);
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
        "Blueprints are reusable Beats: `save_blueprint` a subgraph under a name, `list_blueprints`, `apply_blueprint` to stamp a copy at x,y.",
      schema: {
        action: z.enum(["group", "promote", "dissolve", "reconcile", "set_rail_label", "reorder_rail", "save_blueprint", "list_blueprints", "apply_blueprint"]).describe("What to do."),
        id: z.string().optional().describe("Beat id. Required for promote/dissolve/reconcile/set_rail_label/reorder_rail/save_blueprint."),
        node_ids: z.array(z.string()).optional().describe("group: nodes to wrap."),
        label: z.string().optional().describe("group: the new Beat's title; set_rail_label: the new label."),
        port_id: z.string().optional().describe("set_rail_label: the rail's id (from outline)."),
        side: z.enum(["in", "out"]).optional().describe("reorder_rail: which rail."),
        from: z.number().int().optional().describe("reorder_rail: current index."),
        to: z.number().int().optional().describe("reorder_rail: new index."),
        name: z.string().optional().describe("save_blueprint: blueprint name."),
        blueprint_id: z.string().optional().describe("apply_blueprint: id from list_blueprints."),
        x: z.number().optional().describe("apply_blueprint: canvas x."),
        y: z.number().optional().describe("apply_blueprint: canvas y."),
      },
      handler: async (args: A, ctx) => {
        const action = args.action as string;
        const required: Record<string, string[]> = {
          group: ["node_ids"],
          promote: ["id"],
          dissolve: ["id"],
          reconcile: ["id"],
          set_rail_label: ["id", "port_id", "label"],
          reorder_rail: ["id", "side", "from", "to"],
          save_blueprint: ["id", "name"],
          list_blueprints: [],
          apply_blueprint: ["blueprint_id", "x", "y"],
        };
        const miss = need(args, action, ...(required[action] ?? []));
        if (miss) return miss;
        const { action: _a, ...rest } = args;
        return forward(ctx, `director_${action}`, rest, action === "list_blueprints" ? DIRECTOR_READ_MS : DIRECTOR_WRITE_MS);
      },
    },
  ];
}

/** Names this module contributes — what the panel vocabulary baseline must carry. */
export const DIRECTOR_TOOL_NAMES = ["panel_module", "panel_pane", "panel_director_graph", "panel_director_link", "panel_director_subgraph"] as const;
