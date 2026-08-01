import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorToToolResult } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type { CatalogedTool, ToolCatalog } from "./catalog.js";

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
 * Compact tool mode (COMFYUI_MCP_TOOL_MODE=compact / --compact): registers
 * exactly three meta-tools backed by the captured catalog, instead of the full
 * ~200-tool surface. Built for small/local models (Hermes Agent, Ollama, any
 * MCP client on a non-frontier LLM) where 200 JSON schemas blow the context
 * budget — see issue #97.
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
  register(
    "list_tools",
    "List every comfyui-mcp capability as a token-light catalog: tool names with one-line summaries, grouped by category. Start here. Then use describe_tool to get a tool's parameters and call_tool to run it.",
    {
      category: z
        .string()
        .optional()
        .describe("Only list this category (as shown in the catalog headings)."),
      search: z
        .string()
        .optional()
        .describe("Case-insensitive substring filter over tool names and descriptions."),
    },
    async (args) => text(buildManifest(catalog, args)),
  );

  register(
    "describe_tool",
    "Get the full description and JSON Schema of one tool from the catalog. Always call this before the first call_tool of a tool you haven't used in this session.",
    {
      name: z.string().optional().describe("Exact tool name from list_tools."),
      tool_name: z.string().optional().describe("Alias for name."),
    },
    async (params) => {
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
    },
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
      if (!tool) return errorText(unknownToolMessage(catalog, name));

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

function unknownToolMessage(catalog: ToolCatalog, name: string): string {
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
