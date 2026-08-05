import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorToToolResult } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type { CatalogedTool, ToolCatalog } from "./catalog.js";
import { retiredToolMessage } from "./vocabulary.js";

/** First sentence of a tool description, hard-capped so the manifest stays token-light. */
export function summarize(description: string, maxLen = 160): string {
  const firstSentence = description.split(/(?<=\.)\s+/, 1)[0] ?? description;
  const line = firstSentence.replace(/\s+/g, " ").trim();
  return line.length <= maxLen ? line : `${line.slice(0, maxLen - 1).trimEnd()}…`;
}

function text(s: string): CallToolResult {
  return { content: [{ type: "text", text: s }] };
}

function errorText(s: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: s }] };
}

function inputJsonSchema(tool: CatalogedTool): Record<string, unknown> | undefined {
  if (!tool.schema || Object.keys(tool.schema).length === 0) return undefined;
  const json = z.toJSONSchema(z.object(tool.schema), {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete json.$schema; // noise for an LLM reader
  return json;
}

/** Searchable corpus for one tool: name, description, and the parameter
 *  names + descriptions — so a search like "checkpoint" also finds tools
 *  whose relevance only shows in their arguments (e.g. list_local_models). */
function searchCorpus(tool: CatalogedTool): string {
  const params = Object.entries(tool.schema ?? {})
    .map(([key, schema]) => `${key} ${(schema as { description?: string }).description ?? ""}`)
    .join(" ");
  return `${tool.name} ${tool.description} ${params}`.toLowerCase();
}

export function buildManifest(
  catalog: ToolCatalog,
  opts: { category?: string; search?: string } = {},
): string {
  const search = opts.search?.toLowerCase();
  const lines: string[] = [];
  let shown = 0;
  for (const [category, tools] of catalog.byCategory()) {
    if (opts.category && category !== opts.category) continue;
    const matching = search ? tools.filter((t) => searchCorpus(t).includes(search)) : tools;
    if (matching.length === 0) continue;
    lines.push("", `## ${category} (${matching.length})`);
    for (const t of matching) {
      lines.push(`- ${t.name}: ${summarize(t.description)}`);
      shown++;
    }
  }
  if (shown === 0) {
    const cats = [...catalog.byCategory().keys()].join(", ");
    return `No tools matched (category=${opts.category ?? "any"}, search=${opts.search ?? "none"}). Categories: ${cats}`;
  }
  const header =
    `comfyui-mcp tool catalog — ${shown} of ${catalog.tools.size} tools` +
    (opts.category || opts.search ? " (filtered)" : "") +
    ". Workflow: pick a tool → describe_tool {\"name\": ...} for its parameters → call_tool {\"name\": ..., \"args\": {...}}.";
  const footer =
    (opts.category || opts.search) && shown < catalog.tools.size
      ? `\n\nThis is a FILTERED view (${catalog.tools.size - shown} tools hidden). If nothing here fits the task, call list_tools again with a broader search or no filter.`
      : "";
  return header + lines.join("\n") + footer;
}

/**
 * Compact tool mode — the DEFAULT registration (since #667; --full /
 * COMFYUI_MCP_TOOL_MODE=full opts out): registers exactly three meta-tools
 * backed by the captured catalog, instead of the full ~200-tool surface.
 * Built for small/local models (Hermes Agent, Ollama, any MCP client on a
 * non-frontier LLM) where 200 JSON schemas blow the context budget — see
 * issue #97 — and the right default everywhere: the full surface costs a
 * client ~200KB (~50k tokens) per tools/list.
 */
export function registerCompactTools(
  server: McpServer,
  catalog: ToolCatalog,
  opts: { skip?: ReadonlySet<string> } = {},
): void {
  // A caller may reserve some meta-tool names — e.g. registerFullTools layers the
  // facade onto the full direct surface, and if the user has an autoloaded
  // workflow literally named `call_tool`/`list_tools`/`describe_tool`, that name
  // is ALREADY registered on the live server; re-registering it here would throw
  // (McpServer rejects duplicate tool names) and take down startup. `skip`
  // dedups the EXPECTED collisions the caller detected. The try/catch is the
  // belt-and-suspenders: collision detection relies on a catalog snapshot that
  // could, in a startup race, disagree with what's actually on the live server
  // (a workflow file removed between the two discovery passes), so a duplicate
  // that slips past `skip` is swallowed and logged rather than crashing startup.
  // In every collision case the FIRST registration (the user's direct tool)
  // keeps the name; the rest of the facade still registers. (#616)
  const skip = opts.skip ?? new Set<string>();
  const register: McpServer["tool"] = ((...args: Parameters<McpServer["tool"]>) => {
    const name = args[0] as string;
    if (skip.has(name)) return undefined as unknown as ReturnType<McpServer["tool"]>;
    try {
      return server.tool(...args);
    } catch (err) {
      logger.warn(
        `[compact] skipping facade meta-tool '${name}' — already registered (name collision): ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined as unknown as ReturnType<McpServer["tool"]>;
    }
  }) as McpServer["tool"];
  const listToolsSchema = {
    category: z
      .string()
      .optional()
      .describe("Only list this category (as shown in the catalog headings)."),
    search: z
      .string()
      .optional()
      .describe("Case-insensitive substring filter over tool names and descriptions."),
  };
  const describeToolSchema = {
    name: z.string().optional().describe("Exact tool name from list_tools."),
    tool_name: z.string().optional().describe("Alias for name."),
  };
  const describeTool = (params: { name?: string; tool_name?: string }): CallToolResult => {
    const name = params.name ?? params.tool_name;
    if (!name) return errorText('Missing tool name. Call as: describe_tool {"name": "<tool>"}');
    const tool = catalog.get(name);
    if (!tool) return errorText(unknownToolMessage(catalog, name));
    const schema = inputJsonSchema(tool);
    const sections = [
      `# ${tool.name}  (category: ${tool.category})`,
      "",
      tool.description,
      "",
      schema
        ? `Parameters (JSON Schema):\n${JSON.stringify(schema, null, 1)}`
        : "Parameters: none.",
      "",
      `Run it with: call_tool {"name": "${tool.name}", "args": ${schema ? "{...}" : "{}"}}`,
    ];
    return text(sections.join("\n"));
  };
  register(
    "list_tools",
    "List every comfyui-mcp capability as a token-light catalog: tool names with one-line summaries, grouped by category. Start here. Then use describe_tool to get a tool's parameters and call_tool to run it.",
    listToolsSchema,
    async (args) => text(buildManifest(catalog, args)),
  );

  register(
    "describe_tool",
    "Get the full description and JSON Schema of one tool from the catalog. Always call this before the first call_tool of a tool you haven't used in this session.",
    describeToolSchema,
    async (params) => describeTool(params),
  );

  register(
    "call_tool",
    "Execute a tool from the catalog by name. Pass its parameters in `args` (object). The result is exactly what the underlying tool returns.",
    {
      // Everything is optional and loosely typed on purpose: small models
      // frequently alias field names or mis-type values, and an SDK-level
      // -32602 gives them nothing to correct from. We validate inside the
      // handler instead, where errors can carry the expected schema.
      name: z.string().optional().describe("Exact tool name from list_tools."),
      tool_name: z.string().optional().describe("Alias for name."),
      args: z
        .unknown()
        .optional()
        .describe(
          "The tool's parameters as an object matching its describe_tool schema. A JSON-encoded string is also accepted. Omit for tools without parameters.",
        ),
      arguments: z.unknown().optional().describe("Alias for args."),
    },
    async (params) => {
      const name = params.name ?? params.tool_name;
      if (!name) {
        return errorText('Missing tool name. Call as: call_tool {"name": "<tool>", "args": {...}}');
      }
      const tool = catalog.get(name);
      // #693 — a client can retain the stable call_tool binding while its direct
      // describe_tool/list_tools bindings are stale after a reconnect. The manifest
      // itself tells that client to describe a tool before calling it, so route those
      // two facade control-plane operations through call_tool too. Do this ONLY when
      // the catalog has no direct tool under the same name: in full mode a user
      // workflow may legitimately claim a reserved name and win the direct registry.
      const facadeMeta = !tool && (name === "list_tools" || name === "describe_tool") ? name : null;
      if (!tool && !facadeMeta) return errorText(unknownToolMessage(catalog, name));

      const args = params.args ?? params.arguments;
      let rawArgs: Record<string, unknown> = {};
      if (typeof args === "string") {
        if (args.trim()) {
          try {
            const parsed: unknown = JSON.parse(args);
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
              return errorText(`args must be a JSON object, got: ${args.slice(0, 200)}`);
            }
            rawArgs = parsed as Record<string, unknown>;
          } catch {
            return errorText(`args is not valid JSON: ${args.slice(0, 200)}`);
          }
        }
      } else if (Array.isArray(args)) {
        return errorText(
          `args must be a JSON object keyed by parameter name, not an array. Use describe_tool {"name": "${name}"} to see the schema.`,
        );
      } else if (args !== undefined && args !== null) {
        if (typeof args !== "object") {
          return errorText(
            `args must be a JSON object, got ${typeof args}. Use describe_tool {"name": "${name}"} to see the schema.`,
          );
        }
        rawArgs = args as Record<string, unknown>;
      }

      if (facadeMeta === "list_tools") {
        const parsed = z.object(listToolsSchema).safeParse(rawArgs);
        if (!parsed.success) return errorText(`Invalid arguments for list_tools: ${parsed.error.message}`);
        return text(buildManifest(catalog, parsed.data));
      }
      if (facadeMeta === "describe_tool") {
        const parsed = z.object(describeToolSchema).safeParse(rawArgs);
        if (!parsed.success) return errorText(`Invalid arguments for describe_tool: ${parsed.error.message}`);
        return describeTool(parsed.data);
      }

      // The only catalog-less names above returned through facadeMeta, so the
      // remaining branch always has a concrete application tool to validate.
      if (!tool) return errorText(unknownToolMessage(catalog, name));

      const validated = z.object(tool.schema ?? {}).safeParse(rawArgs);
      if (!validated.success) {
        const issues = validated.error.issues
          .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n");
        const schema = inputJsonSchema(tool);
        return errorText(
          `Invalid arguments for ${name}:\n${issues}\n\nExpected schema:\n${JSON.stringify(schema ?? {}, null, 1)}`,
        );
      }

      try {
        return await tool.handler(validated.data as Record<string, unknown>);
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}

/**
 * `panel_…`, with or without a client's `mcp__<server>__` namespacing — the same
 * prefix form `deadNameRe`/`findDeadName` accept, because that is how tool names
 * appear in agent transcripts and skill files.
 */
const PANEL_NAMESPACE_RE = /^(?:mcp__[A-Za-z0-9_]+__)?panel_/;

/**
 * The answer for a `panel_*` name, which is NOT the same question as "does this
 * tool exist".
 *
 * The panel_* live-canvas tools are registered by a DIFFERENT server — the
 * orchestrator's per-tab surface (registerPanelTools / startPanelMcpHttpServer),
 * never by this one. So this catalog's silence about `panel_graph_outline` says
 * nothing whatsoever about whether that tool exists; it only says this server
 * does not serve it. The bare "Unknown tool 'panel_graph_outline'." that used to
 * come back is the #804 defect in miniature: a tool the caller could not SEE,
 * narrated as a tool that does not EXIST — and a model that reads it that way
 * tells the user the capability is missing, which is false and sends them to
 * reinstall something that is already fine.
 *
 * This path is reachable through our own prose, not just through a model's
 * imagination: `visualize_workflow` and `visualize_workflow_hierarchical` both
 * tell the reader to "use panel_graph_outline instead" for the live canvas, and
 * the bundled plugin's debug-render / director skills name panel_* tools too —
 * all of which an outside MCP client reads while holding none of them (#784, same
 * family: recovery guidance naming a tool the caller cannot invoke).
 *
 * What this message must NOT do is replace one asserted cause with another. The
 * test is only a PREFIX, so four separate things stay deliberately unclaimed:
 *
 *  - whether `name` is a real panel tool at all. `panel_typo` reaches here too,
 *    and the namespace fact is true of it while "it exists elsewhere" is not.
 *  - that NO `panel_`-prefixed tool can be on this surface. An autoloaded workflow
 *    file (registerAutoloadedWorkflows) is registered under its slugified filename,
 *    so `panel_custom.json` really would be a `panel_custom` tool here — and it
 *    would be found by `catalog.get()` long before this function runs. The claim is
 *    therefore about whose prefix it is, not about what could ever be registered.
 *  - which surfaces the caller holds. From inside this catalog a panel-hosted
 *    session and an outside client are indistinguishable, so both are addressed.
 *  - HOW the caller would reach the panel surface if it has one. Not every host
 *    exposes the panel tools by their own names: the Ollama backend advertises a
 *    three-tool panel router (panel_list_tools / panel_describe_tool /
 *    panel_call_tool) instead, so "call it directly" would be wrong advice there.
 *    The caller's own tool list is the authority, and it is the one thing the
 *    caller can read and we cannot.
 *  - that the sidebar's agent necessarily holds these tools. It usually does, but
 *    the `pi` backend has no MCP client at all (see pi-backend.ts) and therefore
 *    gets no ComfyUI tools whatever is installed — so that fallback is stated
 *    with its condition rather than as a guarantee.
 */
function panelNamespaceMessage(name: string): string {
  return (
    `Unknown tool '${name}' — no tool by that name is registered on THIS server, and the ` +
    "`panel_` prefix is not this server's to serve: it is the live-canvas surface, served " +
    "separately by the ComfyUI sidebar panel's own per-tab MCP server. So this answers WHICH " +
    `SURFACE you reached, and says nothing about whether '${name}' exists. This server cannot ` +
    "see what else your client holds, so check the tool list your client gave you. " +
    `If it offers ${name}, or a panel router such as panel_call_tool, go that way — call_tool ` +
    "dispatches only within this server's own catalog and can never reach the panel surface. " +
    "If it offers nothing under `panel_`, there is no live-canvas route from here: read the " +
    "workflow from disk instead (list_workflows, get_workflow, analyze_workflow, query_workflow), " +
    "or ask the user to make the request from the Agent tab in the ComfyUI sidebar, on a backend " +
    "that has ComfyUI tools (the pi backend has no MCP client and so has none)."
  );
}

function unknownToolMessage(catalog: ToolCatalog, name: string): string {
  // A name in the retirement ledger gets a specific answer — which version
  // removed it and what to call instead (#659). Exact matches only: partial
  // names still get the fuzzy suggestions below.
  //
  // Checked BEFORE the panel namespace, because the ledger holds retired panel_*
  // names too and has a strictly better answer for them — a named live replacement
  // — than "wrong surface" does. Answering "ask the panel agent" for a name no
  // panel agent serves either would send the caller to a second dead end.
  const retired = retiredToolMessage(name);
  if (retired) return retired;
  if (PANEL_NAMESPACE_RE.test(name)) return panelNamespaceMessage(name);
  const needle = name.toLowerCase();
  const close = [...catalog.tools.keys()]
    .filter((n) => n.includes(needle) || needle.includes(n))
    .slice(0, 5);
  return (
    `Unknown tool '${name}'.` +
    (close.length ? ` Did you mean: ${close.join(", ")}?` : "") +
    " Use list_tools to see the catalog."
  );
}
