// In-process MCP server that gives the orchestrator's background agent LIVE
// control of the workflow the user is actually looking at.
//
// The panel pack already implements a fixed allowlist of graph executors
// (graph_get_state, graph_add_node, graph_set_widget, graph_run, …). This
// server exposes those operations to the background agent as MCP tools, each
// forwarding to the panel over the bridge
// the orchestrator owns (bridge.send → rid-correlated reply). Because it runs
// IN the orchestrator process (createSdkMcpServer, not a stdio subprocess), the
// tools can reach the live UiBridge directly.
//
// Each agent gets its own server bound to its tab id, so commands always target
// the workflow in that browser tab — no tab_id juggling for the model.
//
// PARITY (Codex): the tool definitions live in ONE shared list
// (`buildPanelToolDefs`) so they can be registered onto BOTH:
//   (a) the in-process Anthropic Agent SDK server (`createPanelMcpServer`,
//       used by the Claude backend), AND
//   (b) a `@modelcontextprotocol/sdk` `McpServer` over HTTP
//       (`registerPanelTools`, used by the Codex backend via an orchestrator-
//       hosted loopback HTTP MCP — see panel-mcp-http.ts).
// Sharing the list means the panel_* surface (including the destructive-confirm
// gating for panel_clear/panel_restart_comfyui) is IDENTICAL across providers,
// so parity is automatic — neither path reimplements a tool.

import { z } from "zod";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { parse as parseYaml } from "yaml";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UiBridge } from "../services/ui-bridge.js";
import {
  addUserMcpServer,
  readUserMcpServers,
  removeUserMcpServer,
  setUserMcpServerSecret,
} from "../services/user-mcp-config.js";
import { setComfyuiSecret } from "../services/panel-secrets.js";
import { getNsfwConsent, setNsfwConsent } from "../services/panel-settings.js";
import { QueueMonitor } from "../services/queue-monitor.js";
import { getObjectInfo, backfillObjectInfo } from "../comfyui/client.js";
import { convertUiToApi, collectNodeTypes } from "../services/workflow-converter.js";
import { sliceWorkflow } from "../services/workflow-slicer.js";
import type { UiWorkflow } from "../comfyui/types.js";

/** Treat these as an affirmative answer to the adult-content consent card. */
function isAffirmative(reply: unknown): boolean {
  if (typeof reply !== "string") return false;
  return /^(yes|allow|allowed|true|on|ok(ay)?|sure|agree|confirm|enable|i'?m? ?18|18\+?|adult)/i.test(
    reply.trim(),
  );
}

type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
};

function ok(value: unknown): ToolResult {
  return {
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

function fail(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

const slotRef = z.union([z.string(), z.number().int().min(0)]);

// ---- server-side pack workflow resolution (for panel_load_workflow) --------
// Read a bundled pack's UI workflow.json on the SERVER so the (large) graph
// never has to shuttle through the agent's conversation. Mirrors the package-
// root resolution in src/tools/skills-access.ts: this file compiles to
// dist/orchestrator/panel-tools.js, so the package root (shipping packs/) is two
// levels up.

/** A safe single path segment — a pack directory name, no traversal/separators. */
const SAFE_PACK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** packs/ dir: dist/orchestrator/panel-tools.js → ../../packs */
function packsDir(): string {
  return fileURLToPath(new URL("../../packs", import.meta.url));
}

/** Read + parse a bundled pack's UI workflow.json. Name-guarded and must exist. */
function readPackWorkflow(packName: string): Record<string, unknown> {
  const name = packName.trim();
  if (!SAFE_PACK_NAME.test(name)) {
    throw new Error(`Invalid pack name "${packName}". Use a plain pack directory name from list_packs.`);
  }
  const root = packsDir();
  const packDir = join(root, name);
  if (!packDir.startsWith(root) || !existsSync(packDir) || !statSync(packDir).isDirectory()) {
    throw new Error(`No pack named "${name}". Discover valid packs with list_packs.`);
  }
  // Resolve the workflow filename from pack.yaml (default workflow.json).
  let workflowName = "workflow.json";
  const metaFile = join(packDir, "pack.yaml");
  if (existsSync(metaFile)) {
    try {
      const meta = parseYaml(readFileSync(metaFile, "utf8")) as Record<string, unknown>;
      if (meta && typeof meta.workflow === "string") workflowName = meta.workflow;
    } catch {
      // keep default
    }
  }
  if (!SAFE_PACK_NAME.test(workflowName) && workflowName !== "workflow.json") {
    workflowName = "workflow.json";
  }
  const wfFile = join(packDir, workflowName);
  if (!wfFile.startsWith(packDir) || !existsSync(wfFile)) {
    throw new Error(`Pack "${name}" has no ready workflow (${workflowName} not found).`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(wfFile, "utf8"));
  } catch (err) {
    throw new Error(`Pack "${name}" workflow.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Pack "${name}" workflow.json did not parse to an object.`);
  }
  return parsed as Record<string, unknown>;
}

// ---- server-side ARBITRARY workflow.json resolution (for panel_load_workflow path) ----
// Read a workflow JSON file off the ORCHESTRATOR's local disk so a large graph
// (e.g. a 159KB staged example) never has to shuttle through the agent's chat
// context. The agent passes a path; we read+parse here, then load via graph_load —
// the same server-side-read pattern as the `pack` option.
//
// REMOTE-COMFYUI CAVEAT: this reads the ORCHESTRATOR's filesystem. For the panel
// the orchestrator runs LOCAL to ComfyUI (same machine), so a path under the
// ComfyUI workflows dir always resolves. It does NOT work against a remote
// ComfyUI whose files the orchestrator can't see — use the inline `graph` option
// for that.

/** Candidate ComfyUI workflows directories (where the frontend saves/stages files). */
function comfyWorkflowsDirs(): string[] {
  const base = process.env.COMFYUI_PATH;
  if (!base) return [];
  return [
    join(base, "user", "default", "workflows"),
    join(base, "user", "workflows"),
  ];
}

/** Read + parse a UI workflow JSON from disk by path. Resolves an absolute path,
 *  OR a path relative to a ComfyUI workflows dir (COMFYUI_PATH/user/default/workflows,
 *  then user/workflows). Guards: must be .json, must exist/be readable, and must
 *  parse to a UI workflow (a top-level `nodes` array). */
function readWorkflowFromPath(rawPath: string): Record<string, unknown> {
  const p = (rawPath ?? "").trim();
  if (!p) throw new Error("Provide a non-empty `path` to a workflow .json file.");
  if (!/\.json$/i.test(p)) {
    throw new Error(`"${p}" is not a .json file — pass the path to a ComfyUI workflow JSON.`);
  }

  // Build the candidate absolute paths to try, in order.
  const candidates: string[] = [];
  if (isAbsolute(p)) {
    candidates.push(resolve(p));
  } else {
    // Relative to each ComfyUI workflows dir (the common case — a just-staged file).
    for (const dir of comfyWorkflowsDirs()) candidates.push(resolve(dir, p));
    // Also relative to the orchestrator's CWD as a last resort.
    candidates.push(resolve(process.cwd(), p));
  }

  const resolved = candidates.find((c) => existsSync(c) && statSync(c).isFile());
  if (!resolved) {
    const where = isAbsolute(p)
      ? candidates[0]
      : `the ComfyUI workflows dir (${comfyWorkflowsDirs().join(" or ") || "COMFYUI_PATH not set"}) or an absolute path`;
    throw new Error(
      `No workflow file at "${p}". Looked under ${where}. Pass an absolute path, or a name relative to the ComfyUI workflows folder.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (err) {
    throw new Error(`"${resolved}" is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`"${resolved}" did not parse to a workflow object.`);
  }
  if (!Array.isArray((parsed as Record<string, unknown>).nodes)) {
    throw new Error(
      `"${resolved}" is not a UI workflow (missing a top-level \`nodes\` array). ` +
        `Provide a UI/litegraph workflow JSON, not API/prompt format.`,
    );
  }
  return parsed as Record<string, unknown>;
}

// IMPORTANT (Codex parity): use `z.array(z.number())` — NOT `z.tuple([...])` — for
// fixed-length coordinate vectors. zod's `.tuple()` emits JSON-Schema draft-04
// "tuple validation" (`items` as an ARRAY of schemas), which Codex's strict
// function-schema validator REJECTS — it silently DROPS any MCP tool whose schema
// uses array-form `items` (so panel_add_node etc. vanished from Codex's tool
// list). A plain number array (single-object `items` + minItems/maxItems) is
// accepted by both Codex and the Claude SDK, and is behaviorally identical
// (the panel executors already read pos/bounds as [x, y] / [x, y, w, h] arrays).
const xy = () =>
  z.array(z.number()).min(2).max(2).describe("[x, y] (two numbers).");
const rect = () =>
  z.array(z.number()).min(4).max(4).describe("[x, y, width, height] (four numbers).");

/**
 * The execution context every tool handler receives. Both transports (Anthropic
 * SDK in-process, MCP-SDK over HTTP) build the SAME context bound to a tab, so a
 * handler is transport-agnostic — it only ever talks to the bridge via `call` /
 * `confirm` / `bridge` and never knows which server invoked it.
 */
export interface PanelToolCtx {
  /** Forward a command to the panel and wrap the reply as a tool result. */
  call: (cmd: Record<string, unknown>, timeoutMs?: number) => Promise<ToolResult>;
  /** Human-in-the-loop yes/no confirm card (false on decline/timeout/no-panel). */
  confirm: (question: string, header: string) => Promise<boolean>;
  /** The raw bridge + tab id, for the handful of tools that need bespoke wiring
   *  (image screenshots, secret collection). */
  bridge: UiBridge;
  tabId: string;
}

/** Build a tab-bound execution context shared by both transports. */
export function makePanelToolCtx(bridge: UiBridge, tabId: string): PanelToolCtx {
  const call = async (cmd: Record<string, unknown>, timeoutMs?: number): Promise<ToolResult> => {
    try {
      return ok(await bridge.send(cmd as { cmd: string }, { tabId, timeoutMs }));
    } catch (err) {
      return fail(err);
    }
  };
  // Human-in-the-loop confirmation for a DESTRUCTIVE op: render a yes/no card in
  // the panel and block on the user's pick. Returns false on decline, timeout, or
  // no panel — so the op is SKIPPED, never performed without an explicit yes.
  // (We gate inside the tool because the SDK's canUseTool is bypassed under
  // bypassPermissions, which the panel agent runs in; the Codex HTTP path runs
  // approvalPolicy "never", so the same in-tool gate is the only safeguard.)
  const confirm = async (question: string, header: string): Promise<boolean> => {
    try {
      const reply = await bridge.send(
        {
          cmd: "ask_user",
          question,
          header,
          options: [
            { label: "Yes, go ahead", description: "" },
            { label: "No, cancel", description: "" },
          ],
        } as { cmd: string },
        { tabId, timeoutMs: 300000 },
      );
      return isAffirmative(reply);
    } catch {
      return false;
    }
  };
  return { call, confirm, bridge, tabId };
}

/** One shared tool definition: name, description, zod raw-shape schema, and a
 *  transport-agnostic handler that receives parsed args + the tab-bound context. */
export interface PanelToolDef {
  name: string;
  description: string;
  // A zod raw shape (object map of zod schemas), as accepted by BOTH the Anthropic
  // SDK `tool()` and the MCP SDK `registerTool({ inputSchema })`.
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, ctx: PanelToolCtx) => Promise<ToolResult>;
}

/**
 * The SINGLE source of truth for the panel_* tool surface. Both transports
 * register these exact definitions, so the Claude (in-process) and Codex (HTTP)
 * backends expose an identical panel toolset.
 */
export function buildPanelToolDefs(): PanelToolDef[] {
  // Local helper so each def reads like the original `tool(...)` call.
  const def = (
    name: string,
    description: string,
    schema: z.ZodRawShape,
    handler: (args: Record<string, unknown>, ctx: PanelToolCtx) => Promise<ToolResult>,
  ): PanelToolDef => ({ name, description, schema, handler });

  // Args are validated by zod before the handler runs (both transports parse with
  // the same shape), so handlers read fields off a loosely-typed bag.
  type A = Record<string, unknown>;

  return [
    def(
      "panel_get_graph",
      "Read the workflow the user is CURRENTLY VIEWING on their canvas (root graph or an opened subgraph — 'viewing' says which): node ids, types, titles, widget values, connections, and each node's MODE ('active', 'bypass', or 'mute'). Subgraph nodes are summarized shallowly — drill in with panel_get_subgraph. ALWAYS call this before your first edit so ids and slot names are accurate. CHECK THE MODE of every node on the path you care about: a node with mode 'bypass' is skipped (it just passes its input through) and one with mode 'mute' does not execute (and kills everything downstream) — so a BYPASSED/MUTED node means that part of the graph is OFF and may be why a render uses the wrong prompt/branch. If the path you intend to use is bypassed or muted, enable it with panel_set_node_mode before running. This is the user's live graph — they watch your edits happen. When you are VIEWING A SUBGRAPH (after panel_enter_subgraph), the response also includes `rails`: the input/output boundary rail node ids and their slots — read these to know exactly what's exposed on the boundary, and which interior outputs/inputs still need exposing (panel_expose_subgraph_output / panel_expose_subgraph_input) or repositioning (panel_move_rail). Read-only.",
      {},
      async (_args, ctx) => ctx.call({ cmd: "graph_get_state" }),
    ),
    def(
      "panel_graph_outline",
      "Read a COMPACT, dependency-ordered TEXT MAP of the workflow the user is viewing — the FASTEST way to UNDERSTAND a graph (especially a big loaded pack/template) before you touch it. Returns one `outline` string built for you to read top→down: nodes are topologically sorted (sources first, sinks last), each shown on its own block as `id Type \"title\" [bypass/mute] [OUTPUT] · group:X  widget=value …` with `← inputs` (as source_node.output_name) and `→ outputs` (as target_node.input_name), preceded by a GROUPS index (title → member node ids). Far cheaper and clearer than panel_get_graph's full JSON, and it shows the WIRING you'd otherwise have to reconstruct. Use this FIRST to get oriented; then panel_find_nodes to pinpoint a node, or panel_get_graph for one node's exact slot/widget detail. Read-only.",
      {},
      async (_args, ctx) => ctx.call({ cmd: "graph_outline" }),
    ),
    def(
      "panel_get_subgraph",
      "Read INSIDE a subgraph node on the user's open graph: ids, types, widget values, and connections of its inner nodes. Use after panel_get_graph shows a node with is_subgraph=true. Read-only.",
      { node_id: z.number().int().describe("Subgraph node id (is_subgraph=true).") },
      async (args: A, ctx) => ctx.call({ cmd: "graph_get_subgraph", node_id: args.node_id }),
    ),
    def(
      "panel_find_nodes",
      "SEARCH the workflow the user is CURRENTLY VIEWING for nodes matching filters — the right way to PINPOINT a node (a specific loader, sampler, save, switch) in a LARGE graph instead of dumping the whole thing with panel_get_graph and scanning it. This searches the LIVE graph ON THE CANVAS — NOT the installable node registry (that's panel_search_nodes). Unlike panel_get_graph it scans EVERY node (no truncation). Give a free-text `query` (matched case-insensitively across node type, title, description, widget NAMES, widget VALUES, and input/output port names+types — a node hits if ANY of those contain it) and/or targeted filters: type, title, input, output, widget (name), widget_value (contents), is_output, is_subgraph, mode. Targeted filters are ANDed together; the free `query` ORs across fields. Each match is the SAME rich summary as panel_get_graph (id, type, title, widgets, inputs WITH their connected_from sources, outputs, mode, is_output, …) PLUS the node's description and a `matched_on` list saying WHY it matched. Read-only. Examples — the video loader: {query:'tiktok'} or {type:'LoadVideo'} or {input:'video'}; every output node: {is_output:true}; the node whose widget holds a file: {widget_value:'.png'}; a bypassed switch: {type:'Switch', mode:'bypass'}.",
      {
        query: z
          .string()
          .optional()
          .describe(
            "Free text matched (case-insensitive substring) across type, title, description, widget names, widget values, and port names/types. A node matches if ANY field contains it.",
          ),
        type: z
          .string()
          .optional()
          .describe("Node class_type contains this (e.g. 'KSampler', 'LoadImage')."),
        title: z.string().optional().describe("Node title contains this."),
        input: z
          .string()
          .optional()
          .describe("Has an INPUT port whose name or type contains this (e.g. 'image', 'LATENT')."),
        output: z
          .string()
          .optional()
          .describe("Has an OUTPUT port whose name or type contains this."),
        widget: z
          .string()
          .optional()
          .describe("Has a widget whose NAME contains this (e.g. 'seed', 'ckpt_name')."),
        widget_value: z
          .string()
          .optional()
          .describe("Has a widget whose VALUE contains this (e.g. a filename or prompt fragment)."),
        is_output: z
          .boolean()
          .optional()
          .describe("true = only output nodes (SaveImage/PreviewImage/…); false = exclude them."),
        is_subgraph: z.boolean().optional().describe("true = only subgraph nodes."),
        mode: z
          .enum(["active", "bypass", "mute"])
          .optional()
          .describe("Only nodes in this execution mode."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max matches to return (default 40)."),
      },
      async (args: A, ctx) =>
        ctx.call({
          cmd: "graph_find_nodes",
          query: args.query,
          type: args.type,
          title: args.title,
          input: args.input,
          output: args.output,
          widget: args.widget,
          widget_value: args.widget_value,
          is_output: args.is_output,
          is_subgraph: args.is_subgraph,
          mode: args.mode,
          limit: args.limit,
        }),
    ),
    def(
      "panel_add_node",
      "Add a node to the user's OPEN ComfyUI graph by class_type (e.g. 'KSampler', 'CheckpointLoaderSimple'). The user sees it appear live; Ctrl+Z undoes it. Returns the created node's id, slots, and default widget values.",
      {
        class_type: z.string().describe("Exact ComfyUI node class_type to create."),
        pos: xy()
          .optional()
          .describe("Canvas [x, y] (two numbers). Auto-placed beside existing nodes when omitted."),
        title: z.string().optional().describe("Optional custom node title."),
      },
      async (args: A, ctx) =>
        ctx.call({ cmd: "graph_add_node", class_type: args.class_type, pos: args.pos, title: args.title }),
    ),
    def(
      "panel_remove_node",
      "Remove a node (and its connections) from the user's open graph by id. Undoable with Ctrl+Z.",
      { node_id: z.number().int().describe("Node id from panel_get_graph.") },
      async (args: A, ctx) => ctx.call({ cmd: "graph_remove_node", node_id: args.node_id }),
    ),
    def(
      "panel_clear",
      "Remove EVERY node from the user's open graph — only for an explicit 'clear/reset the canvas'. Just CALL THIS DIRECTLY when they ask to clear: the tool itself pops a confirm card and only wipes on a yes (don't ask separately first). The wipe is a single Ctrl+Z undo. NEVER use this for a 'new workflow' — that's panel_new_workflow (a new tab, leaves this graph intact).",
      {},
      async (_args, ctx) => {
        if (
          !(await ctx.confirm(
            "Clear the canvas? This removes every node from the open workflow. (One Ctrl+Z undoes it.)",
            "Clear canvas",
          ))
        ) {
          return ok("Cancelled — the canvas was left as-is.");
        }
        return ctx.call({ cmd: "graph_clear" });
      },
    ),
    def(
      "panel_strip_workflow",
      "Strip a workflow to a clean, flat, RESOLVED graph — Get/Set buses, Reroutes, subgraph " +
        "definitions, and bypassed/muted nodes all collapsed into real connections (the " +
        "'de-getter-setter' pass). Takes the same input as panel_load_workflow — a `pack`, a server-side " +
        "`path` (absolute or relative to the ComfyUI workflows folder), or an inline `graph` — but RETURNS " +
        "the de-virtualized graph plus a node-type summary for INSPECTION / REBUILD instead of loading it " +
        "onto the canvas. Use this to understand or rebuild an expert workflow's real wiring without the " +
        "virtual nodes (e.g. a staged 150KB graph full of GetNode/SetNode/Reroute). The resolved graph is " +
        "much smaller than the raw UI JSON and is read SERVER-SIDE.",
      {
        pack: z
          .string()
          .optional()
          .describe("Bundled pack name (from list_packs) — its UI workflow.json is read server-side."),
        path: z
          .string()
          .optional()
          .describe(
            "Path to a workflow .json on the ComfyUI machine's disk — absolute, or relative to the ComfyUI workflows folder (user/default/workflows). Local ComfyUI only.",
          ),
        graph: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe("Inline UI workflow (object or JSON string) to strip instead of a pack/path."),
      },
      async (args: A) => {
        let raw: Record<string, unknown>;
        if (args.pack) {
          raw = readPackWorkflow(args.pack as string);
        } else if (args.path) {
          raw = readWorkflowFromPath(args.path as string);
        } else if (args.graph != null) {
          raw = (typeof args.graph === "string"
            ? JSON.parse(args.graph as string)
            : args.graph) as Record<string, unknown>;
        } else {
          throw new Error("Provide exactly one of: pack, path, or graph.");
        }

        const ui = raw as unknown as UiWorkflow;
        const bulk = await getObjectInfo();
        const objectInfo = await backfillObjectInfo(bulk, collectNodeTypes(ui));
        const { workflow, warnings } = convertUiToApi(ui, objectInfo);

        const hist: Record<string, number> = {};
        for (const node of Object.values(workflow)) {
          const t = (node as { class_type?: string }).class_type ?? "?";
          hist[t] = (hist[t] ?? 0) + 1;
        }
        const summary = Object.entries(hist)
          .sort((a, b) => b[1] - a[1])
          .map(([t, c]) => `${c}× ${t}`)
          .join(", ");

        return ok(
          `Stripped to ${Object.keys(workflow).length} nodes` +
            (warnings.length ? ` · ${warnings.length} warning(s)` : "") +
            `\nNode types: ${summary}` +
            (warnings.length
              ? `\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}`
              : "") +
            `\n\n${JSON.stringify(workflow, null, 2)}`,
        );
      },
    ),
    def(
      "panel_slice_workflow",
      "Slice ONE pipeline out of a toggle-template workflow (built with rgthree 'Fast Groups " +
        "Bypasser/Muter' — one graph holding many pipelines, only one active at a time). Seeds from the " +
        "output nodes in the named `groups`, takes their backward closure (real links + virtual Set/Get " +
        "buses), un-bypasses the kept nodes and their subgraph internals, and RETURNS a standalone, " +
        "activated UI graph (only the subgraph defs it uses). Reads a `pack`, server-side `path`, or " +
        "inline `graph`. Pair with panel_strip_workflow to then flatten the Set/Get buses. This returns " +
        "the sliced graph for inspection — it does NOT load it onto the canvas (feed the result to " +
        "panel_load_workflow if you want that).",
      {
        pack: z.string().optional().describe("Bundled pack name (its UI workflow.json is read server-side)."),
        path: z
          .string()
          .optional()
          .describe("Path to a workflow .json on the ComfyUI machine's disk — absolute or relative to user/default/workflows."),
        graph: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe("Inline UI workflow (object or JSON string) to slice instead of a pack/path."),
        groups: z
          .union([z.string(), z.array(z.string())])
          .describe(
            "Group-title substrings (case-insensitive) whose output nodes seed the slice — CSV string or array, e.g. 'TEXT TO IMAGE' or ['extend','sampler'].",
          ),
      },
      async (args: A) => {
        let raw: Record<string, unknown>;
        if (args.pack) {
          raw = readPackWorkflow(args.pack as string);
        } else if (args.path) {
          raw = readWorkflowFromPath(args.path as string);
        } else if (args.graph != null) {
          raw = (typeof args.graph === "string"
            ? JSON.parse(args.graph as string)
            : args.graph) as Record<string, unknown>;
        } else {
          throw new Error("Provide exactly one of: pack, path, or graph.");
        }

        const groupList = Array.isArray(args.groups)
          ? (args.groups as string[])
          : String(args.groups ?? "").split(",");
        const { workflow, stats } = sliceWorkflow(raw as unknown as UiWorkflow, groupList);

        const flags =
          stats.badLinks || stats.orphanGets
            ? ` · ⚠ bad_links=${stats.badLinks} orphan_gets=${stats.orphanGets}`
            : "";
        return ok(
          `Sliced ${stats.nodes} nodes (un-bypassed ${stats.unbypassed}), ${stats.links} links, ` +
            `${stats.subgraphs} subgraph def(s) · seeds=${stats.seeds}${flags}` +
            `\n\n${JSON.stringify(workflow, null, 2)}`,
        );
      },
    ),
    def(
      "panel_load_workflow",
      "Load a full ComfyUI workflow onto the live canvas in one shot (replaces the current graph). Three ways to specify it: `pack:<name>` for a bundled installer pack's local-GPU workflow; `path:<file>` to read an arbitrary workflow .json off DISK server-side (absolute, or relative to the ComfyUI workflows folder) — use this to open a staged/downloaded example without shuttling its JSON through chat; or an inline `graph` object/JSON string. `pack` and `path` are read SERVER-SIDE so a large graph never enters your context. The replaced graph is captured as an undo point (double-Esc / revert). Pack workflows are LOCAL/free; for a `path`/`graph` that may use API nodes, check the runtime first (check_workflow_runtime) and ASK the user before spending paid api credits.",
      {
        pack: z
          .string()
          .optional()
          .describe("Bundled pack name (from list_packs, e.g. 'krea2-txt2img-manual'). Its UI workflow.json is read server-side and loaded onto the canvas. These are local-GPU/free."),
        path: z
          .string()
          .optional()
          .describe("Path to a workflow .json on the ComfyUI machine's disk — absolute, or relative to the ComfyUI workflows folder (user/default/workflows). Read + parsed server-side and loaded onto the canvas (keeps a large JSON out of chat). Local ComfyUI only."),
        graph: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe("A UI workflow graph (object or JSON string) to load instead of a pack/path. Must be UI/litegraph format (a `nodes` array), NOT API/prompt format."),
      },
      async (args: A, ctx) => {
        try {
          let data: unknown;
          if (args.pack) {
            // Read the (large) pack graph SERVER-SIDE so it never enters the agent's context.
            data = readPackWorkflow(args.pack as string);
          } else if (args.path) {
            // Read an arbitrary workflow JSON off the orchestrator's local disk —
            // same server-side-read pattern as `pack`, keeping the big JSON out of chat.
            data = readWorkflowFromPath(args.path as string);
          } else if (args.graph != null) {
            data = typeof args.graph === "string" ? JSON.parse(args.graph as string) : args.graph;
          } else {
            throw new Error("Provide one of `pack` (a bundled pack name), `path` (a workflow .json on disk), or `graph` (a UI workflow).");
          }
          // Generous timeout — loading a large graph onto the live canvas can take a moment.
          return await ctx.call({ cmd: "graph_load", graph: data }, 30000);
        } catch (err) {
          return fail(err);
        }
      },
    ),
    def(
      "panel_connect",
      "Connect an output slot of one node to an input slot of another in the user's open graph. Slots accept a name ('MODEL', 'samples') or numeric index. On a name mismatch the error lists available slots — re-check with panel_get_graph. Undoable.",
      {
        from_node_id: z.number().int().describe("Source node id."),
        from_output: slotRef.optional().describe("Source output slot name or index (default 0)."),
        to_node_id: z.number().int().describe("Target node id."),
        to_input: slotRef.optional().describe("Target input slot name or index (default 0)."),
      },
      async (args: A, ctx) =>
        ctx.call({
          cmd: "graph_connect",
          from_node_id: args.from_node_id,
          from_output: args.from_output,
          to_node_id: args.to_node_id,
          to_input: args.to_input,
        }),
    ),
    def(
      "panel_disconnect",
      "Disconnect an input slot of a node in the user's open graph. Undoable with Ctrl+Z.",
      {
        node_id: z.number().int().describe("Node id whose input to disconnect."),
        input: slotRef.optional().describe("Input slot name or index (default 0)."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "graph_disconnect", node_id: args.node_id, input: args.input }),
    ),
    def(
      "panel_set_widget",
      "Set a widget value on a node in the user's open graph (steps, cfg, seed, ckpt_name, text prompts, …). Returns the previous and new value. Undoable with Ctrl+Z.",
      {
        node_id: z.number().int().describe("Node id from panel_get_graph."),
        widget: z.string().describe("Widget name (e.g. 'steps', 'cfg', 'text')."),
        value: z
          .union([z.string(), z.number(), z.boolean()])
          .describe("New value. Must match the widget's expected type."),
      },
      async (args: A, ctx) =>
        ctx.call({ cmd: "graph_set_widget", node_id: args.node_id, widget: args.widget, value: args.value }),
    ),
    def(
      "panel_move_node",
      "Move a node to a new canvas position [x, y] in the user's open graph. Undoable.",
      {
        node_id: z.number().int().describe("Node id from panel_get_graph."),
        pos: xy().describe("New canvas [x, y] (two numbers)."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "graph_move_node", node_id: args.node_id, pos: args.pos }),
    ),
    def(
      "panel_canvas",
      "Control the user's canvas view: 'fit' frames the whole graph, 'center_on_node' jumps to a node (give node_id), 'pan' shifts by dx/dy, 'zoom' sets an absolute scale. View-only.",
      {
        action: z.enum(["fit", "center_on_node", "pan", "zoom"]),
        node_id: z.number().int().optional().describe("Required for center_on_node."),
        dx: z.number().optional().describe("Pan delta x."),
        dy: z.number().optional().describe("Pan delta y."),
        scale: z.number().optional().describe("Absolute zoom for 'zoom' (0.05–4, 1 = 100%)."),
      },
      async (args: A, ctx) =>
        ctx.call({
          cmd: "graph_canvas",
          action: args.action,
          node_id: args.node_id,
          dx: args.dx,
          dy: args.dy,
          scale: args.scale,
        }),
    ),
    def(
      "panel_run",
      "Queue the workflow the user has OPEN — exactly like them pressing Queue Prompt (current widget values, the live graph they can see). Returns queued:true, or queued:false with node_errors when frontend validation fails. Pass to_node_id to RUN ONLY ONE BRANCH ('run to node'): ComfyUI renders just that output node plus everything upstream of it and SKIPS every other output branch — handy for previewing or debugging part of a big graph without rendering the whole thing. to_node_id MUST be an OUTPUT node (SaveImage, PreviewImage, SaveVideo, …) — pick the one at the END of the branch you want; nodes are tagged is_output:true in panel_get_graph. Omit it to run the whole graph. Use this so the render runs on THEIR canvas and they see the result.",
      {
        batch_count: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Times to queue (default 1)."),
        to_node_id: z
          .number()
          .int()
          .optional()
          .describe(
            "Output node id to render UP TO (partial execution). Omit to run the whole graph. Must be an OUTPUT node — one with is_output:true in panel_get_graph.",
          ),
      },
      async (args: A, ctx) => {
        // BACKPRESSURE: the agent can't see ComfyUI's queue, so re-queuing while a
        // render is already running silently stacks behind it (this is how a stuck
        // job once let three more pile up). Snapshot the watchdog BEFORE we queue.
        const pre = QueueMonitor.snapshot();
        const res = await ctx.call(
          { cmd: "graph_run", batch_count: args.batch_count, to_node_id: args.to_node_id },
          20000,
        );
        // Append anti-poll guidance: the agent should go idle after queuing so the
        // executed event auto-injects the output image, rather than busy-polling.
        const note =
          "\n\n[IMPORTANT] You will be notified automatically with the output image(s)/video when the render finishes — do NOT poll get_queue, get_history, or list_output_images. Just end your turn now and wait for the result to be delivered to you.";
        let warn = "";
        if (pre.connected && pre.running) {
          const morePending = pre.queueDepth > 1 ? ` plus ${pre.queueDepth - 1} already pending` : "";
          warn =
            `\n\n[QUEUE WARNING] A render is ALREADY RUNNING${pre.runningPromptId ? ` (prompt ${pre.runningPromptId})` : ""}${morePending} — ` +
            `this new run is QUEUED BEHIND it and will not start until that finishes. If the running one looks stuck, do NOT keep queuing: ` +
            `call cancel_job with clear_pending:true (it interrupts the running job AND drops pending), then escalate to restart_comfyui if it reports the job wedged.`;
        }
        if (res.content?.[0]?.type === "text") {
          return {
            ...res,
            content: [{ type: "text", text: res.content[0].text + warn + note }, ...res.content.slice(1)],
          };
        }
        return res;
      },
    ),
    def(
      "panel_get_errors",
      "Read ComfyUI's pre-run VALIDATION errors (missing models, value_not_in_list / invalid widget values, broken links — the SAME 'N ERRORS' the user sees in the frontend's error panel) plus the most recent runtime execution error, from the user's open tab. The validation errors are populated by ComfyUI's own validator on ANY queue attempt — the user's OR yours — so this reflects what the user is looking at. A ⚠️ GRAPH VALIDATION block is also auto-injected at your turn start when this state changes; call this to re-check on demand (e.g. after you edit widgets/links). Read-only.",
      {},
      async (_args, ctx) => ctx.call({ cmd: "graph_get_errors" }),
    ),
    def(
      "panel_reload",
      "Soft-reload yourself to pick up code changes WITHOUT restarting ComfyUI — your chat session resumes automatically and you'll be nudged to continue. Use scope 'orchestrator' (default) after backend/orchestrator code changed (new tools, system prompt, services); use scope 'frontend' after the panel UI (web JS/CSS) changed. This ENDS the current turn — your tools/prompt are reloaded and you continue fresh. For custom-node or model changes that need a full ComfyUI restart, use panel_restart_comfyui instead. Only call this when code has actually changed and needs to take effect now.",
      {
        scope: z
          .enum(["orchestrator", "frontend"])
          .optional()
          .describe("'orchestrator' (default): respawn the agent for new backend code. 'frontend': reload the panel UI for new web code."),
      },
      async (args: A, ctx) =>
        ctx.call({ cmd: "soft_reload", scope: (args.scope as string) ?? "orchestrator" }, 15000),
    ),
    def(
      "panel_list_mcp",
      "List the MCP servers available to you. Returns the user's inherited servers (from their Claude config) plus your always-present built-ins (comfyui, the live-graph panel server). Use this to check whether a capability (e.g. CivitAI model search) is already connected before offering to add it.",
      {},
      async () => {
        try {
          const inherited = Object.keys(readUserMcpServers());
          return ok({
            inherited,
            builtin: ["comfyui", "panel"],
            note: "After panel_add_mcp / panel_remove_mcp, call panel_reload to apply the change to this session.",
          });
        } catch (err) {
          return fail(err);
        }
      },
    ),
    def(
      "panel_add_mcp",
      "Connect a new MCP server by writing it to the user's Claude config (~/.claude.json) — it then loads into THIS session after you call panel_reload, and also becomes available to the user's normal Claude session. Use for capabilities you don't have yet, e.g. the official CivitAI MCP: name 'civitai', transport 'http', url 'https://mcp.civitai.com/mcp'. ALWAYS ask the user before connecting a remote (http/sse) MCP — it's an external service connection. Some servers need an auth token: pass it via headers (http/sse) or env (stdio).",
      {
        name: z.string().describe("Server name/key, e.g. 'civitai'. Letters, digits, dot, dash, underscore."),
        transport: z.enum(["http", "sse", "stdio"]).describe("'http'/'sse' for a hosted URL server; 'stdio' for a local command."),
        url: z.string().optional().describe("Server URL (required for http/sse), e.g. 'https://mcp.civitai.com/mcp'."),
        command: z.string().optional().describe("Executable (required for stdio), e.g. 'npx'."),
        args: z.array(z.string()).optional().describe("Args for the stdio command."),
        headers: z.record(z.string(), z.string()).optional().describe("HTTP headers for http/sse (e.g. an Authorization token)."),
        env: z.record(z.string(), z.string()).optional().describe("Environment variables for a stdio server."),
      },
      async (args: A) => {
        try {
          const transport = args.transport as string;
          let config: Record<string, unknown>;
          if (transport === "stdio") {
            if (!args.command) throw new Error("stdio transport requires `command`.");
            config = {
              type: "stdio",
              command: args.command,
              ...(args.args ? { args: args.args } : {}),
              ...(args.env ? { env: args.env } : {}),
            };
          } else {
            if (!args.url) throw new Error(`${transport} transport requires \`url\`.`);
            config = {
              type: transport,
              url: args.url,
              ...(args.headers ? { headers: args.headers } : {}),
            };
          }
          addUserMcpServer(args.name as string, config);
          return ok(
            `Connected MCP server "${args.name}" (written to your Claude config). Call panel_reload to load it into this session — then its tools become available.`,
          );
        } catch (err) {
          return fail(err);
        }
      },
    ),
    def(
      "panel_remove_mcp",
      "Remove an MCP server from the user's Claude config by name. Call panel_reload afterward to drop it from this session. Cannot remove the built-in comfyui/panel servers.",
      { name: z.string().describe("Server name to remove (from panel_list_mcp).") },
      async (args: A) => {
        try {
          const removed = removeUserMcpServer(args.name as string);
          return ok(
            removed
              ? `Removed MCP server "${args.name}". Call panel_reload to apply.`
              : `No MCP server named "${args.name}" in the user config.`,
          );
        } catch (err) {
          return fail(err);
        }
      },
    ),
    def(
      "panel_request_secret",
      "Securely collect an API token / secret from the user and write it straight to config — you NEVER see the value and it is never saved to chat history. The panel shows a masked input; the pasted value goes directly to the orchestrator, which stores it on the target MCP server, then applies it. Returns only a redacted confirmation.\n\nTWO targets:\n• The BUILT-IN comfyui server (mcp_server 'comfyui', target_kind 'env') — for tokens YOUR OWN comfyui tools need. The env key MUST be one of a fixed allowlist: CIVITAI_API_TOKEN (download_civitai_model), HUGGINGFACE_TOKEN or HF_TOKEN (HuggingFace downloads). Any other key is rejected. The secret is injected into the comfyui server's env and the server is RESPAWNED automatically — NO panel_reload needed; after this turn ends the tools restart with it and you'll be nudged to retry. THIS is what fixes a download that returned HTTP 401.\n• A user-added MCP server (e.g. the 'civitai' http server you added with panel_add_mcp) — use target_kind 'header' (e.g. Authorization, value_prefix 'Bearer ') for http/sse, or 'env' for stdio; then call panel_reload to load it.\n\nFor a CivitAI DOWNLOAD 401, target 'comfyui' env CIVITAI_API_TOKEN — NOT the 'civitai' MCP server (that's only the search MCP).",
      {
        label: z.string().describe("Prompt shown above the masked input, e.g. 'Paste your CivitAI API token'."),
        target_kind: z.enum(["header", "env"]).describe("'header' for http/sse servers (e.g. Authorization); 'env' for stdio servers and the built-in comfyui server."),
        mcp_server: z.string().describe("MCP server to attach the secret to: 'comfyui' for the built-in tools (download_civitai_model etc.), or a user-added server name like 'civitai'."),
        key: z.string().describe("For 'comfyui': one of CIVITAI_API_TOKEN, HUGGINGFACE_TOKEN, HF_TOKEN (others rejected). For a user-added server: env var name or header name (e.g. 'Authorization')."),
        value_prefix: z.string().optional().describe("Optional string prepended to the token, e.g. 'Bearer '. Usually empty for env vars."),
        hint: z.string().optional().describe("Optional reassurance/help text shown under the input."),
      },
      async (args: A, ctx) => {
        try {
          const secret = await ctx.bridge.send(
            { cmd: "request_secret", label: args.label, hint: args.hint },
            { tabId: ctx.tabId, timeoutMs: 300000 },
          );
          if (typeof secret !== "string" || secret.length === 0) {
            return ok("No token entered — nothing was saved.");
          }
          const server = (args.mcp_server as string) ?? "";
          // The BUILT-IN comfyui server is NOT in the user's ~/.claude.json — the
          // orchestrator spawns it with its own env. Route its secrets to the
          // dedicated store, which injects them into that env and RESPAWNS the
          // server (no reload needed). Anything else is a user-config MCP server.
          if (server.toLowerCase() === "comfyui") {
            if ((args.target_kind as string) !== "env") {
              return ok(
                "The built-in comfyui server takes secrets as env vars — use target_kind 'env' (e.g. key 'CIVITAI_API_TOKEN').",
              );
            }
            setComfyuiSecret(args.key as string, `${(args.value_prefix as string) ?? ""}${secret}`);
            // Redacted ack ONLY — the secret never enters the agent's context. The
            // respawn is deferred to this turn's end, so this is accurate.
            return ok(
              `🔒 Token saved for the built-in comfyui tools (env "${args.key}"). It's being applied now — the comfyui tools respawn with it as soon as this turn ends, then I'll retry. No reload needed.`,
            );
          }
          setUserMcpServerSecret(
            {
              kind: args.target_kind as "header" | "env",
              server,
              key: args.key as string,
              prefix: args.value_prefix as string | undefined,
            },
            secret,
          );
          // Redacted ack ONLY — the secret never enters the agent's context.
          return ok(
            `🔒 Token saved to MCP server "${server}" (${args.target_kind} "${args.key}"). Call panel_reload to load it.`,
          );
        } catch (err) {
          return fail(err);
        }
      },
    ),
    def(
      "panel_get_content_mode",
      "Query the persistent adult-content (NSFW) consent state for this user. Returns { nsfw_allowed, decided_at }. ALWAYS check this before surfacing any adult/NSFW models, prompts, workflows, or imagery. It defaults to FALSE (SFW-only) until the user passes the consent gate (panel_request_adult_consent). Read-only.",
      {},
      async () => {
        try {
          const c = getNsfwConsent();
          return ok({ nsfw_allowed: c.allowed, decided_at: c.decidedAt ?? null });
        } catch (err) {
          return fail(err);
        }
      },
    ),
    def(
      "panel_request_adult_consent",
      "Show the user the adult-content consent gate and persist their decision. Call this ONLY when a request clearly intends NSFW/adult work AND panel_get_content_mode shows it's not already allowed. It renders a card asking the user to confirm they are 18+ AND that adult content is legal in their region; an affirmative answer turns the mode ON persistently (across reloads), a negative keeps it SFW. Returns the resulting { nsfw_allowed } state. Never assume consent — this tool is the only way to enable it.",
      {
        reason: z
          .string()
          .optional()
          .describe("Optional one-line context shown to the user about why you're asking (e.g. 'to search Civitai for mature LoRAs')."),
      },
      async (args: A, ctx) => {
        try {
          const question =
            "Adult-content gate — to enable NSFW work in this session, please confirm BOTH that you are at least 18 years old AND that creating/viewing adult content is legal in your country/region." +
            (args.reason ? `\n\nContext: ${args.reason}` : "") +
            "\n\nThis is recorded as your consent and can be turned off anytime.";
          const reply = await ctx.bridge.send(
            {
              cmd: "ask_user",
              question,
              header: "18+ consent",
              options: [
                { label: "Yes — I'm 18+ and it's legal in my region", description: "Enable adult content for this session" },
                { label: "No — keep it SFW", description: "Stay in safe-for-work mode" },
              ],
            },
            { tabId: ctx.tabId, timeoutMs: 300000 },
          );
          const allowed = isAffirmative(reply);
          const state = setNsfwConsent(allowed);
          return ok({
            nsfw_allowed: state.allowed,
            decided_at: state.decidedAt,
            note: allowed
              ? "Adult mode enabled. Hard limits still apply: no minors, no sexual deepfakes of real people, no depictions of actual non-consensual acts."
              : "Kept SFW. Don't surface adult content.",
          });
        } catch (err) {
          return fail(err);
        }
      },
    ),
    def(
      "panel_disable_adult_mode",
      "Turn the adult-content (NSFW) consent OFF — revert to SFW-only. Use when the user asks to disable it. No gate needed to turn it off.",
      {},
      async () => {
        try {
          const state = setNsfwConsent(false);
          return ok({ nsfw_allowed: state.allowed, note: "Adult mode disabled — back to SFW-only." });
        } catch (err) {
          return fail(err);
        }
      },
    ),
    def(
      "panel_set_todo",
      "Show/update a live TODO checklist in the panel's footer tray — a running view of your plan that the user watches as you work a multi-step task. Pass the FULL ordered list each call (it replaces the tray); update each step's status as you progress (pending → active → done). Pass an empty array to clear it. Use for genuinely multi-step work (3+ steps); skip it for quick one-shot replies. Mark exactly one step 'active' at a time.",
      {
        items: z
          .array(
            z.object({
              text: z.string().describe("Short step description (a few words)."),
              status: z
                .enum(["pending", "active", "done"])
                .optional()
                .describe("Step state (default 'pending'). Mark the one you're on 'active'."),
            }),
          )
          .describe("The full ordered checklist (replaces the current one). Empty array clears the tray."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "set_todo", items: args.items }, 5000),
    ),
    def(
      "panel_ask",
      "Ask the user to choose between options — renders an interactive question card in the panel chat and BLOCKS until they pick, returning their choice as text. Use this (NOT the AskUserQuestion tool, which never renders here) whenever you need the user to decide between options. Each option may carry a short description. The card always includes an 'Other…' free-text field, so the returned string may be a listed label or whatever the user typed (comma-joined for multi_select). Ask only when the answer genuinely changes what you do.",
      {
        question: z.string().describe("The question to ask, e.g. 'Which sampler should I use?'"),
        options: z
          .array(
            z.object({
              label: z.string().describe("Short choice text shown on the button."),
              description: z.string().optional().describe("Optional one-line explanation of this choice."),
            }),
          )
          .min(2)
          .describe("The choices (at least 2). An 'Other' free-text field is added automatically."),
        header: z.string().optional().describe("Very short label/chip for the card (e.g. 'Sampler')."),
        multi_select: z.boolean().optional().describe("Allow selecting multiple options (default false)."),
      },
      async (args: A, ctx) =>
        ctx.call(
          {
            cmd: "ask_user",
            question: args.question,
            options: args.options,
            header: args.header,
            multi_select: args.multi_select,
          },
          // Human-in-the-loop: wait up to 10 minutes for a pick.
          600000,
        ),
    ),
    def(
      "panel_save_workflow",
      "Save the user's open workflow PROGRAMMATICALLY — no Save/Rename dialog ever pops. A never-saved workflow is auto-named and persisted; pass `name` to give it (or rename it to) a specific name. Use this freely (e.g. after building a graph) — it won't interrupt the user.",
      { name: z.string().optional().describe("Name to save/rename to (no .json needed). Omit to save in place / auto-name an unsaved workflow.") },
      async (args: A, ctx) =>
        args.name
          ? ctx.call({ cmd: "workflow_save_as", name: args.name }, 15000)
          : ctx.call({ cmd: "workflow_save" }, 15000),
    ),
    def(
      "panel_list_workflows",
      "List the user's OPEN workflow tabs and which one is active (path, filename, modified, persisted). Use this to know what's open before switching/renaming/closing. Read-only.",
      {},
      async (_args, ctx) => ctx.call({ cmd: "workflow_list" }),
    ),
    def(
      "panel_new_workflow",
      "Open a brand-new BLANK workflow in a NEW TAB. Use this whenever the user wants a 'new workflow' / 'fresh canvas' / 'start over for a new project'. This does NOT touch their current workflow — it opens a separate tab. NEVER use panel_clear for a new workflow (panel_clear wipes the CURRENT graph and is only for 'clear/reset this canvas').",
      {},
      async (_args, ctx) => ctx.call({ cmd: "workflow_new" }, 15000),
    ),
    def(
      "panel_open_workflow",
      "Open / switch to a workflow by path or filename (from panel_list_workflows). Switches the active tab to it.",
      { path: z.string().describe("Workflow path, filename, or key from panel_list_workflows.") },
      async (args: A, ctx) => ctx.call({ cmd: "workflow_open", path: args.path }, 15000),
    ),
    def(
      "panel_rename_workflow",
      "Rename a workflow (the active one, or the one matching `path`).",
      {
        name: z.string().describe("New name (no .json needed)."),
        path: z.string().optional().describe("Which workflow to rename; omit for the active one."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "workflow_rename", name: args.name, path: args.path }, 15000),
    ),
    def(
      "panel_close_workflow",
      "Close a workflow tab (the active one, or the one matching `path`). Refuses if it has unsaved changes unless force:true — save first to avoid losing the user's work.",
      {
        path: z.string().optional().describe("Which workflow to close; omit for the active one."),
        force: z.boolean().optional().describe("Close even with unsaved changes (discards them). Default false."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "workflow_close", path: args.path, force: args.force }, 15000),
    ),
    def(
      "panel_select_nodes",
      "Select nodes on the user's canvas by id (highlights them, sets the multi-selection). Useful before panel_create_subgraph.",
      { node_ids: z.array(z.number().int()).describe("Node ids to select.") },
      async (args: A, ctx) => ctx.call({ cmd: "graph_select_nodes", node_ids: args.node_ids }),
    ),
    def(
      "panel_create_subgraph",
      "Group the given nodes into a SUBGRAPH (ComfyUI 'Convert to Subgraph') on the user's canvas — collapses them into one subgraph node. Returns the new subgraph node id. Undoable with Ctrl+Z. To wrap an existing GROUP, prefer panel_subgraph_group (you don't have to list the node_ids yourself).",
      { node_ids: z.array(z.number().int()).describe("Node ids to group into a subgraph.") },
      async (args: A, ctx) => ctx.call({ cmd: "graph_create_subgraph", node_ids: args.node_ids }, 15000),
    ),
    def(
      "panel_subgraph_group",
      "Wrap an existing GROUP's nodes into ONE subgraph node in a single step — the clean way to refactor a big graph into readable, TOGGLEABLE units. Pass the group by `group` (its title, e.g. 'REPLACEMENT MODE', or its numeric id from panel_get_graph's groups[]). LiteGraph groups don't own nodes — membership is geometric — so this computes which nodes sit inside the group box, selects them, and collapses them via ComfyUI 'Convert to Subgraph', returning the new subgraph node id + the wrapped node ids. After this you can toggle that whole region as ONE unit: panel_set_node_mode(node_id, 'bypass'/'active') on the subgraph node, then panel_run — e.g. queue one run with the region ON and one with it OFF. Undoable with Ctrl+Z. (For an arbitrary set of nodes that isn't a group, use panel_create_subgraph with explicit node_ids.)",
      {
        group: z
          .union([z.string(), z.number()])
          .describe(
            "Group to wrap: its title (case-insensitive substring, e.g. 'replacement mode') or its numeric id from panel_get_graph groups[].id.",
          ),
      },
      async (args: A, ctx) => ctx.call({ cmd: "graph_subgraph_group", group: args.group }, 15000),
    ),
    def(
      "panel_copy_nodes",
      "Copy nodes from the user's open graph to the clipboard. Pass node_ids to copy those nodes (they're selected first), or omit to copy the current canvas selection. The clipboard PERSISTS across workflow switches, so this is how you MERGE one workflow into another: copy here, then panel_open_workflow/panel_new_workflow to the destination, then panel_paste_nodes. Returns {copied: count}.",
      {
        node_ids: z
          .array(z.number().int())
          .optional()
          .describe("Node ids to copy. Omit to copy the current selection."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "graph_copy_nodes", node_ids: args.node_ids }, 15000),
    ),
    def(
      "panel_paste_nodes",
      "Paste the clipboard (from a prior panel_copy_nodes) onto the user's CURRENTLY OPEN graph — including a graph in a DIFFERENT workflow, which is how you merge/compose workflows. Returns the NEW node ids so you can wire or organize them. connect_inputs:false (default) pastes a disconnected copy; pos sets where the paste lands. Undoable with Ctrl+Z.",
      {
        pos: xy().optional().describe("Canvas [x, y] anchor for the paste. Auto-placed when omitted."),
        connect_inputs: z
          .boolean()
          .optional()
          .describe("Reconnect pasted nodes' inputs to existing nodes where they line up (default false)."),
      },
      async (args: A, ctx) =>
        ctx.call({ cmd: "graph_paste_nodes", pos: args.pos, connect_inputs: args.connect_inputs }, 15000),
    ),
    def(
      "panel_save_subgraph",
      "Save a SUBGRAPH node to the user's reusable blueprint LIBRARY (publish), so it can be dropped into any workflow later. Pass node_id to pick the subgraph node (else a single selected subgraph node is used) and name to title the blueprint (defaults to the node's title). Runs programmatically — NO save dialog pops. The blueprint becomes the addable type 'SubgraphBlueprint.<name>' (use panel_add_subgraph or panel_list_subgraphs). Returns {saved: {name, type}}.",
      {
        node_id: z.number().int().optional().describe("Subgraph node id to publish (is_subgraph=true). Omit to use the selected subgraph node."),
        name: z.string().optional().describe("Blueprint name. Defaults to the subgraph node's title."),
      },
      async (args: A, ctx) =>
        ctx.call({ cmd: "graph_save_subgraph", node_id: args.node_id, name: args.name }, 20000),
    ),
    def(
      "panel_list_subgraphs",
      "List the saved subgraph BLUEPRINTS in the user's library (from panel_save_subgraph, plus any global/bundled ones). Each entry has {name, type, display_name, description, is_global} — use name/type with panel_add_subgraph to drop it onto the canvas. Read-only.",
      {},
      async (_args, ctx) => ctx.call({ cmd: "graph_list_subgraphs" }, 15000),
    ),
    def(
      "panel_add_subgraph",
      "Add a saved subgraph blueprint (from panel_list_subgraphs) onto the user's open graph by name (or full 'SubgraphBlueprint.<name>' type). This is how you REUSE a built subgraph in another workflow. pos places it; auto-placed when omitted. Returns the added subgraph node. Undoable with Ctrl+Z.",
      {
        name: z.string().describe("Blueprint name or type from panel_list_subgraphs."),
        pos: xy().optional().describe("Canvas [x, y]. Auto-placed beside existing nodes when omitted."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "graph_add_subgraph", name: args.name, pos: args.pos }, 20000),
    ),
    def(
      "panel_create_group",
      "Create a labeled GROUP box (the colored rectangle that visually frames a region) on the user's open graph. This is the lightweight organizer, DISTINCT from a subgraph (which nests/hides nodes) — a group just draws a titled box around nodes, leaving them in place. Pass node_ids to auto-size the box around those nodes, or bounds [x, y, width, height] for an explicit box. Optional color (hex like '#3f789e') and title. Returns the new group's id. Undoable with Ctrl+Z.",
      {
        title: z.string().optional().describe("Group label shown on the box header."),
        node_ids: z
          .array(z.number().int())
          .optional()
          .describe("Wrap these nodes — the box is auto-sized (with padding) around them."),
        bounds: rect()
          .optional()
          .describe("Explicit [x, y, width, height] (four numbers). Ignored if node_ids is given."),
        color: z.string().optional().describe("Box/header color, e.g. '#3f789e'."),
        font_size: z.number().optional().describe("Title font size (default 24)."),
      },
      async (args: A, ctx) =>
        ctx.call(
          {
            cmd: "graph_create_group",
            title: args.title,
            node_ids: args.node_ids,
            bounds: args.bounds,
            color: args.color,
            font_size: args.font_size,
          },
          15000,
        ),
    ),
    def(
      "panel_move_group",
      "Move a group box to a new top-left [x, y] on the user's open graph. By default the nodes inside the group move with it (like dragging the group header); pass move_nodes:false to move only the box. Group id comes from panel_get_graph (the `groups` array) or panel_create_group. Undoable.",
      {
        group_id: z.number().int().describe("Group id from panel_get_graph / panel_create_group."),
        pos: xy().describe("New top-left [x, y] (two numbers)."),
        move_nodes: z.boolean().optional().describe("Move the contained nodes too (default true)."),
      },
      async (args: A, ctx) =>
        ctx.call({ cmd: "graph_move_group", group_id: args.group_id, pos: args.pos, move_nodes: args.move_nodes }),
    ),
    def(
      "panel_edit_group",
      "Edit a group box: its title, color, font_size, and/or bounds [x, y, width, height]. Only the fields you pass are changed. Undoable.",
      {
        group_id: z.number().int().describe("Group id from panel_get_graph / panel_create_group."),
        title: z.string().optional().describe("New label."),
        color: z.string().optional().describe("New box/header color, e.g. '#3f789e'."),
        font_size: z.number().optional().describe("New title font size."),
        bounds: rect()
          .optional()
          .describe("Resize/reposition the box: [x, y, width, height] (four numbers)."),
      },
      async (args: A, ctx) =>
        ctx.call(
          {
            cmd: "graph_edit_group",
            group_id: args.group_id,
            title: args.title,
            color: args.color,
            font_size: args.font_size,
            bounds: args.bounds,
          },
          15000,
        ),
    ),
    def(
      "panel_remove_group",
      "Remove a group box from the user's open graph. The nodes inside the group are NOT deleted — only the box. Undoable.",
      { group_id: z.number().int().describe("Group id from panel_get_graph / panel_create_group.") },
      async (args: A, ctx) => ctx.call({ cmd: "graph_remove_group", group_id: args.group_id }, 15000),
    ),
    def(
      "panel_set_node_title",
      "Rename a node's TITLE (the label on its header) — e.g. to label a node by its purpose. Different from panel_set_widget (which changes a value). Undoable with Ctrl+Z.",
      {
        node_id: z.number().int().describe("Node id from panel_get_graph."),
        title: z.string().describe("New title text."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "graph_set_title", node_id: args.node_id, title: args.title }, 15000),
    ),
    def(
      "panel_set_node_collapsed",
      "Collapse (minimize) or expand a node on the user's open graph. Collapsed nodes shrink to just their title bar — handy for tidying loaders or rarely-touched nodes. Undoable.",
      {
        node_id: z.number().int().describe("Node id from panel_get_graph."),
        collapsed: z.boolean().optional().describe("true = collapse/minimize (default), false = expand."),
      },
      async (args: A, ctx) =>
        ctx.call({ cmd: "graph_set_node_collapsed", node_id: args.node_id, collapsed: args.collapsed }),
    ),
    def(
      "panel_set_node_mode",
      "Set a node's EXECUTION MODE on the user's open graph — active, bypass, or mute — and return { node_id, mode, previous_mode }. This is how you turn a node ON or OFF without deleting it. Modes:\n" +
        "• 'active' — normal: the node executes.\n" +
        "• 'bypass' — the node is SKIPPED and PASSES ITS INPUT THROUGH to its output (downstream still runs, just as if this node weren't there). Use to disable a single processing node (an upscaler, a LoRA, a detailer) while keeping the pipeline connected.\n" +
        "• 'mute' — the node AND everything DOWNSTREAM of it do NOT execute (no pass-through). Use to fully switch off a branch/output.\n" +
        "CRITICAL — modes silently change what a render produces, so they are a top cause of 'wrong output'. A BYPASSED node contributes nothing of its own and a MUTED node kills its branch. Use this tool to ENABLE the path you actually want and DISABLE the one you don't — e.g. to drive a workflow from its Ideogram/JSON prompt builder you must set the manual-prompt node to 'bypass' and the JSON-builder path to 'active' (or vice-versa); likewise to pick one branch of an rgthree 'Fast Groups Bypasser'/Muter or a prompt-source switch. ALWAYS read modes first with panel_get_graph: if the intended path is bypassed/muted, fix it HERE before running, and never assume a switch/route is already active. Undoable with Ctrl+Z.",
      {
        node_id: z.number().int().describe("Node id from panel_get_graph."),
        mode: z
          .enum(["active", "bypass", "mute"])
          .describe(
            "'active' = runs normally; 'bypass' = skipped, passes input through (downstream still runs); 'mute' = node and everything downstream do not execute.",
          ),
      },
      async (args: A, ctx) =>
        ctx.call({ cmd: "graph_set_node_mode", node_id: args.node_id, mode: args.mode }),
    ),
    def(
      "panel_set_node_color",
      "Set a node's title-bar and/or body color on the user's open graph. Easiest: pass a `preset` from ComfyUI's palette (red, brown, green, blue, pale_blue, cyan, purple, yellow, black) for matched colors. Or set explicit `color` (title bar) and/or `bgcolor` (body) as hex like '#3f789e'. Pass null for a field to reset it to the theme default. Great for colour-coding stages. Undoable.",
      {
        node_id: z.number().int().describe("Node id from panel_get_graph."),
        preset: z
          .enum(["red", "brown", "green", "blue", "pale_blue", "cyan", "purple", "yellow", "black"])
          .optional()
          .describe("Named LiteGraph color preset (sets both title + body)."),
        color: z.string().nullable().optional().describe("Title-bar color hex, or null to clear. Ignored if preset given."),
        bgcolor: z.string().nullable().optional().describe("Body color hex, or null to clear. Ignored if preset given."),
      },
      async (args: A, ctx) =>
        ctx.call({
          cmd: "graph_set_node_color",
          node_id: args.node_id,
          preset: args.preset,
          color: args.color,
          bgcolor: args.bgcolor,
        }),
    ),
    def(
      "panel_screenshot",
      "Render the workflow the user is currently viewing (root graph, or the open subgraph) to a PNG and return it as an IMAGE so you can SEE the layout. It frames the whole graph (nodes + groups), captures, then restores the user's view. Use this to visually verify a layout you just built — overlaps, alignment, rails, colors, group bands — instead of reasoning from coordinates alone.",
      { padding: z.number().optional().describe("Margin around the graph in px (default 60).") },
      async (args: A, ctx) => {
        try {
          const res = (await ctx.bridge.send(
            { cmd: "graph_screenshot", padding: args.padding },
            { tabId: ctx.tabId },
          )) as {
            image?: string;
            mimeType?: string;
          };
          if (!res?.image) return fail("screenshot returned no image");
          return { content: [{ type: "image", data: res.image, mimeType: res.mimeType ?? "image/png" }] };
        } catch (err) {
          return fail(err);
        }
      },
    ),
    def(
      "panel_enter_subgraph",
      "Navigate INTO a subgraph node so you can read and EDIT its inner nodes — after this, panel_get_graph and all panel_* edit tools target the subgraph's inner graph (the user sees the canvas drill in). This is how you edit inside a subgraph (e.g. tweak a widget on an inner node). Call panel_exit_subgraph when done. Returns the new viewing scope.",
      { node_id: z.number().int().describe("Subgraph node id (is_subgraph=true).") },
      async (args: A, ctx) => ctx.call({ cmd: "graph_enter_subgraph", node_id: args.node_id }, 15000),
    ),
    def(
      "panel_exit_subgraph",
      "Leave the current subgraph and return to the root graph (undo a panel_enter_subgraph). After this, panel_* tools target the root graph again.",
      {},
      async (_args, ctx) => ctx.call({ cmd: "graph_exit_subgraph" }, 15000),
    ),
    def(
      "panel_move_rail",
      "Reposition a subgraph's input or output RAIL (the boundary I/O node that the inner wires connect to). You MUST be INSIDE the subgraph first (panel_enter_subgraph). Read current rail positions from panel_get_graph's `rails` field. Use this to place the input rail just left of the first node column and the output rail just right of the last one, so a tidy interior layout doesn't leave the rails stranded. rail is 'input' or 'output'.",
      {
        rail: z.enum(["input", "output"]).describe("Which boundary rail to move."),
        pos: xy().describe("New top-left [x, y] (two numbers)."),
      },
      async (args: A, ctx) => ctx.call({ cmd: "graph_move_rail", rail: args.rail, pos: args.pos }),
    ),
    def(
      "panel_promote_widget",
      "Expose (promote) an INNER subgraph widget on the PARENT subgraph node, so it can be set from outside without opening the subgraph — e.g. surface an inner KSampler's `seed`/`steps` on the subgraph node. You MUST be inside the subgraph first (call panel_enter_subgraph): `node_id` is an inner node (from panel_get_graph while inside) and `widget` is one of its widget names. Pass demote:true to un-promote. Undoable with Ctrl+Z.",
      {
        node_id: z.number().int().describe("Inner node id (from panel_get_graph while inside the subgraph)."),
        widget: z.string().describe("Name of the widget on that node to promote (e.g. 'seed', 'steps', 'text')."),
        demote: z.boolean().optional().describe("Set true to UN-promote (remove the widget from the parent node)."),
      },
      async (args: A, ctx) =>
        ctx.call({ cmd: "graph_promote_widget", node_id: args.node_id, widget: args.widget, demote: args.demote }, 15000),
    ),
    def(
      "panel_expose_subgraph_output",
      "Wire an interior node's OUTPUT to the subgraph's OUTPUT RAIL — i.e. expose it as a SUBGRAPH OUTPUT on the boundary so the PARENT graph can connect to the subgraph node's new output slot. You MUST be INSIDE the subgraph first (panel_enter_subgraph). This is the correct way to \"wire an internal output to the subgraph's output rail\": do NOT panel_connect to a guessed rail node id — call this with the interior node + the output you want exposed. Read panel_get_graph's `rails` to see the resulting boundary slots. `from_output` is an output slot NAME ('IMAGE', 'LATENT') or numeric index. Optional `name` titles the new boundary output (defaults from the source slot). Undoable with Ctrl+Z.",
      {
        from_node_id: z.number().int().describe("Interior (inner) node id whose output to expose (from panel_get_graph while inside the subgraph)."),
        from_output: slotRef.describe("Output slot name (e.g. 'IMAGE', 'LATENT') or numeric index on that node."),
        name: z.string().optional().describe("Optional name for the new subgraph output (boundary slot). Defaults from the source slot."),
      },
      async (args: A, ctx) =>
        ctx.call(
          {
            cmd: "graph_expose_subgraph_output",
            from_node_id: args.from_node_id,
            from_output: args.from_output,
            name: args.name,
          },
          15000,
        ),
    ),
    def(
      "panel_expose_subgraph_input",
      "Wire an interior node's INPUT to the subgraph's INPUT RAIL — i.e. expose it as a SUBGRAPH INPUT on the boundary so the PARENT graph can feed the subgraph node's new input slot. You MUST be INSIDE the subgraph first (panel_enter_subgraph). This is the correct way to wire an internal input to the subgraph's input rail: do NOT panel_connect to a guessed rail node id — call this with the interior node + the input you want exposed. Read panel_get_graph's `rails` to see the resulting boundary slots. `to_input` is an input slot NAME ('model', 'pixels') or numeric index. Optional `name` titles the new boundary input (defaults from the target slot). Undoable with Ctrl+Z.",
      {
        to_node_id: z.number().int().describe("Interior (inner) node id whose input to expose (from panel_get_graph while inside the subgraph)."),
        to_input: slotRef.describe("Input slot name (e.g. 'model', 'pixels') or numeric index on that node."),
        name: z.string().optional().describe("Optional name for the new subgraph input (boundary slot). Defaults from the target slot."),
      },
      async (args: A, ctx) =>
        ctx.call(
          {
            cmd: "graph_expose_subgraph_input",
            to_node_id: args.to_node_id,
            to_input: args.to_input,
            name: args.name,
          },
          15000,
        ),
    ),
    def(
      "panel_unpack_subgraph",
      "EXPAND / DISSOLVE a subgraph node on the user's open graph — inline its interior nodes back into the PARENT graph, rewire all external links to those now-inlined nodes, and remove the subgraph wrapper. This is the frontend's \"Unpack Subgraph\" (litegraph LGraph.unpackSubgraph) and the exact INVERSE of panel_create_subgraph. Use it to flatten a stage that was over-nested, or to edit interior nodes directly at the parent level. The interior nodes reappear on the parent canvas with their connections preserved. Undoable with Ctrl+Z.",
      { node_id: z.number().int().describe("Subgraph node id to unpack/dissolve (is_subgraph=true, from panel_get_graph).") },
      async (args: A, ctx) => ctx.call({ cmd: "graph_unpack_subgraph", node_id: args.node_id }, 15000),
    ),
    def(
      "panel_search_nodes",
      "Search installable custom-node packs via the user's BUILT-IN ComfyUI Manager (the same source the Manager UI uses). Returns matching packs {id, title, description}. Use the `id` with panel_install_node. Prefer this over the headless search_custom_nodes tool — it works against the user's actual (Desktop) Manager.",
      { query: z.string().describe("Search text, e.g. 'kjnodes', 'controlnet', 'ipadapter'."), limit: z.number().int().min(1).max(40).optional() },
      async (args: A, ctx) => ctx.call({ cmd: "nodes_search", query: args.query, limit: args.limit }, 20000),
    ),
    def(
      "panel_list_nodes",
      "List the custom-node packs currently installed in the user's ComfyUI (via the built-in Manager). Read-only.",
      {},
      async (_args, ctx) => ctx.call({ cmd: "nodes_list" }, 20000),
    ),
    def(
      "panel_install_node",
      "Install a custom-node pack into the user's ComfyUI via the BUILT-IN Manager (queues the install). Pass `id` (registry id like 'comfyui-kjnodes' or 'author/repo') from panel_search_nodes, or `repository` (git URL) for a nightly install. A ComfyUI restart (panel_restart_comfyui) is usually required afterward to load the nodes — poll panel_node_queue_status first. Prefer this over the headless install_custom_node tool.",
      {
        id: z.string().optional().describe("Registry id or 'author/repo'."),
        repository: z.string().optional().describe("Git URL (for a nightly/from-source install)."),
        version: z.string().optional().describe("Specific version; default 'latest' (or 'nightly' with repository)."),
        channel: z.string().optional().describe("Manager channel (default 'default')."),
        mode: z.enum(["remote", "local", "cache"]).optional().describe("DB source (default 'remote')."),
      },
      async (args: A, ctx) =>
        ctx.call(
          { cmd: "nodes_install", id: args.id, repository: args.repository, version: args.version, channel: args.channel, mode: args.mode },
          30000,
        ),
    ),
    def(
      "panel_update_node",
      "Update an ALREADY-INSTALLED custom-node pack to its latest (or nightly) code via the BUILT-IN Manager — the first thing to try when a node is broken or CRASHED ComfyUI (e.g. from a crash dump injected on resume). Pass `id` = the installed pack's name/dir (e.g. 'ComfyUI-WanVideoWrapper' from the crash culprit, or an id from panel_list_nodes). Use version 'nightly' to pull the very latest commit (good when a fix just landed upstream), else 'latest' for the newest release. Queues the update; poll panel_node_queue_status, then panel_restart_comfyui to load it. If updating doesn't fix the crash, escalate (git pull / source patch) per your steering.",
      {
        id: z.string().describe("Installed pack name or dir (e.g. 'ComfyUI-WanVideoWrapper'), or a registry id from panel_list_nodes."),
        version: z.string().optional().describe("'latest' (default) or 'nightly' to pull the newest commit."),
        channel: z.string().optional().describe("Manager channel (default 'default')."),
        mode: z.enum(["remote", "local", "cache"]).optional().describe("DB source (default 'remote')."),
      },
      async (args: A, ctx) =>
        ctx.call(
          { cmd: "graph_update_node", id: args.id, version: args.version, channel: args.channel, mode: args.mode },
          30000,
        ),
    ),
    def(
      "panel_node_queue_status",
      "Check the built-in Manager's install/update queue status (to see if a queued install finished). Read-only.",
      {},
      async (_args, ctx) => ctx.call({ cmd: "nodes_queue_status" }, 20000),
    ),
    def(
      "panel_restart_comfyui",
      "Restart the user's ComfyUI server via the built-in Manager — needed to load newly installed/updated custom nodes. CALL THIS DIRECTLY when a restart is needed: it pops a confirm card and only restarts on a yes (don't ask separately first). ComfyUI and this agent go down briefly, then the panel auto-reconnects and you resume. ⚠️ BUSY GUARD: a restart ABORTS any in-progress or queued generation — if ComfyUI is generating, this tool REFUSES and tells you (it does NOT restart). When that happens, tell the user a render is running and WAIT for it (poll panel_node_queue_status), or pass force:true ONLY if the user explicitly confirms they want to kill the running generation. Best practice: before restarting after an install, check the queue is idle first. Only call when a restart is actually needed.",
      { force: z.boolean().optional() },
      async ({ force }, ctx) => {
        if (
          !(await ctx.confirm(
            "Restart ComfyUI now? It (and this agent) will go down briefly, then reconnect and resume automatically.",
            "Restart ComfyUI",
          ))
        ) {
          return ok("Cancelled — ComfyUI was not restarted.");
        }
        return ctx.call({ cmd: "comfy_reboot", force: force === true }, 15000);
      },
    ),
    def(
      "panel_free_vram",
      "Unload all loaded models and free VRAM (ComfyUI /free). Use to unwedge a stuck/OOM ComfyUI when a cancel didn't free memory — before retrying or, last resort, restarting (panel_restart_comfyui). Does NOT restart ComfyUI; it just drops resident models and frees cached memory.",
      {},
      async (_args, ctx) => ctx.call({ cmd: "free_vram" }, 15000),
    ),
    def(
      "panel_show_media",
      "Display one or more images or videos directly in the panel chat. Use this whenever the user asks to SEE or SHOW a file — a disk path you composited/downloaded/generated (absolute path on the orchestrator host) OR a ComfyUI output ref ({ filename, subfolder?, type? }). Items are rendered as media cards in the agent chat area; supply optional captions. Max 8 items per call. NEVER describe an image with emoji or text placeholders — call this tool instead.",
      {
        items: z
          .array(
            z.object({
              source: z.union([
                // Absolute file path on the orchestrator host
                z.object({ path: z.string().min(1) }),
                // ComfyUI /view ref
                z.object({
                  filename: z.string().min(1),
                  subfolder: z.string().optional(),
                  type: z.string().optional(),
                }),
              ]),
              caption: z.string().optional(),
            }),
          )
          .min(1)
          .max(8),
      },
      async (args: A, ctx) => {
        const items = args.items as Array<{
          source:
            | { path: string }
            | { filename: string; subfolder?: string; type?: string };
          caption?: string;
        }>;

        const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
        const VIDEO_EXTS = new Set([".mp4", ".webm"]);
        const MAX_BYTES = 20 * 1024 * 1024; // 20 MB

        const resolved: Array<Record<string, unknown>> = [];
        for (const item of items) {
          const src = item.source;
          if ("path" in src) {
            // Absolute disk path — orchestrator reads + base64-encodes it.
            const p = src.path;
            if (!isAbsolute(p)) {
              return fail("path must be absolute: " + p);
            }
            if (!existsSync(p)) {
              return fail("file not found: " + p);
            }
            const stat = statSync(p);
            if (!stat.isFile()) {
              return fail("not a regular file: " + p);
            }
            if (stat.size > MAX_BYTES) {
              return fail(
                "file too large (" + (stat.size / 1024 / 1024).toFixed(1) + " MB > 20 MB): " + p,
              );
            }
            const ext = extname(p).toLowerCase();
            let mime: string;
            if (IMAGE_EXTS.has(ext)) {
              mime = ext === ".jpg" ? "image/jpeg" : "image/" + ext.slice(1);
            } else if (VIDEO_EXTS.has(ext)) {
              mime = "video/" + ext.slice(1);
            } else {
              return fail(
                "unsupported file type \"" + ext + "\" (allowed: " + [...IMAGE_EXTS, ...VIDEO_EXTS].join(", ") + "): " + p,
              );
            }
            const buf = readFileSync(p);
            const dataUrl = "data:" + mime + ";base64," + buf.toString("base64");
            const kind = IMAGE_EXTS.has(ext) ? "image" : "video";
            const filename = p.replace(/.*[\/]/, "");
            resolved.push({ kind, dataUrl, filename, caption: item.caption });
          } else {
            // ComfyUI /view ref — forward to panel; panel builds the URL.
            resolved.push({
              kind: "viewRef",
              viewRef: {
                filename: src.filename,
                subfolder: src.subfolder,
                type: src.type,
              },
              filename: src.filename,
              caption: item.caption,
            });
          }
        }

        return ctx.call({ cmd: "show_media", items: resolved }, 60000);
      },
    ),
  ];
}

/**
 * Build the per-tab live-graph MCP server for the Claude (in-process Agent SDK)
 * backend. `tabId` binds every command to the panel tab this agent serves.
 *
 * Behaviorally identical to before the parity refactor — it now just wires the
 * SHARED tool defs (buildPanelToolDefs) onto the Anthropic SDK server instead of
 * inlining them, so the Codex HTTP path reuses the exact same surface.
 */
export function createPanelMcpServer(
  bridge: UiBridge,
  tabId: string,
): McpSdkServerConfigWithInstance {
  const ctx = makePanelToolCtx(bridge, tabId);
  const defs = buildPanelToolDefs();
  // The Anthropic SDK's tool() accepts (name, description, zodRawShape, cb). The
  // shared handler is transport-agnostic — bind it to this tab's ctx. Each def's
  // schema is a distinct zod shape, so the produced tool generics differ; widen
  // to the SDK's tool-list element type so the heterogeneous array type-checks.
  type SdkTool = ReturnType<typeof tool>;
  const tools = defs.map((d) =>
    tool(d.name, d.description, d.schema, (args: Record<string, unknown>) => d.handler(args, ctx)),
  ) as unknown as SdkTool[];
  return createSdkMcpServer({
    name: "comfyui-panel",
    version: "1.0.0",
    tools,
  });
}

/**
 * Register the SHARED panel_* tools onto a `@modelcontextprotocol/sdk` McpServer
 * for the HTTP transport (Codex backend). `ctx` is tab-bound, so this server's
 * tools forward to the bridge for THAT tab — same surface as the Claude path.
 */
export function registerPanelTools(server: McpServer, ctx: PanelToolCtx): void {
  for (const d of buildPanelToolDefs()) {
    server.registerTool(
      d.name,
      {
        description: d.description,
        // The MCP SDK accepts a zod raw shape as inputSchema (same shape the
        // Anthropic SDK tool() takes), so the shared schema drops straight in.
        inputSchema: d.schema,
      },
      (async (args: Record<string, unknown>) => {
        const res = await d.handler(args ?? {}, ctx);
        // ToolResult is already the MCP CallToolResult shape (content[] + isError).
        return res as never;
      }) as never,
    );
  }
}
