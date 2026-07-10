import { z } from "zod";
import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import { getClient, getObjectInfo, backfillObjectInfo } from "../comfyui/client.js";
import { errorToToolResult, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import {
  isUiFormat,
  isApiFormat,
  convertUiToApi,
  convertApiToUi,
  collectNodeTypes,
} from "../services/workflow-converter.js";
import { sliceWorkflow } from "../services/workflow-slicer.js";
import { queryApiGraph } from "../services/graph-query.js";
import { detectSections } from "../services/workflow-sections.js";
import {
  generateOverview,
  generateSectionDetail,
  listSections,
  generateSummary,
} from "../services/hierarchical-mermaid.js";
import { convertToMermaid } from "../services/mermaid-converter.js";
import { analyzeGraphHealth } from "../services/workflow-health.js";

export function registerWorkflowLibraryTools(server: McpServer): void {
  server.tool(
    "list_workflows",
    "List the filenames of workflows saved in the connected ComfyUI server's user library (the same workflows visible in the ComfyUI web UI). Requires a running ComfyUI server. Takes no parameters. Returns a numbered list of .json filenames; pass a filename to get_workflow or analyze_workflow to load one. Returns \"No saved workflows found.\" when the library is empty.",
    {},
    async () => {
      try {
        const client = getClient();
        const res = await client.fetchApi("/api/userdata?dir=workflows");
        const files = (await res.json()) as string[];

        if (files.length === 0) {
          return {
            content: [{ type: "text", text: "No saved workflows found." }],
          };
        }

        const text = files
          .map((f, i) => `${i + 1}. ${f}`)
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Found ${files.length} workflows:\n\n${text}`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "get_workflow",
    "Load a saved workflow and return its raw JSON. " +
      "Use analyze_workflow instead if you just need to understand the workflow — it returns a structured summary without flooding context with JSON. " +
      "Use get_workflow only when you need the actual JSON for enqueue_workflow, modify_workflow, or save_workflow.",
    {
      filename: z
        .string()
        .describe(
          "Workflow filename (e.g. 'my_workflow.json'). Use list_workflows to see available files.",
        ),
      format: z
        .enum(["ui", "api"])
        .optional()
        .default("api")
        .describe(
          "Output format: 'api' (default, recommended) converts to compact API format with " +
            "named inputs, connection references, and _meta.mode flags for muted/bypassed nodes. " +
            "'ui' returns the raw UI format with layout positions and links arrays.",
        ),
    },
    async ({ filename, format }) => {
      try {
        const client = getClient();
        const encoded = encodeURIComponent(`workflows/${filename}`);
        const res = await client.fetchApi(
          `/api/userdata/${encoded}`,
        );

        if (!res.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Workflow not found: ${filename} (${res.status})`,
              },
            ],
          };
        }

        const raw = await res.json();

        // If API format requested and workflow is in UI format, convert
        if (format === "api" && isUiFormat(raw)) {
          const bulk = await getObjectInfo();
          // Backfill node types missing from the bulk /object_info (e.g.
          // controlnet_aux's DWPreprocessor) so the converter doesn't skip them.
          const objectInfo = await backfillObjectInfo(bulk, collectNodeTypes(raw));
          const { workflow, warnings } = convertUiToApi(raw, objectInfo);

          const content: Array<{ type: "text"; text: string }> = [];
          if (warnings.length > 0) {
            content.push({
              type: "text",
              text: `**Conversion warnings (${warnings.length}):**\n${warnings.map((w) => `- ${w}`).join("\n")}`,
            });
          }
          content.push({
            type: "text",
            text: JSON.stringify(workflow, null, 2),
          });
          return { content };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(raw, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "strip_workflow",
    "Strip a workflow to a clean, flat API graph — resolving Get/Set buses, Reroutes, " +
      "subgraph definitions, and bypassed/muted nodes into real connections (the 'de-getter-setter' pass). " +
      "Unlike get_workflow, this reads from ANY server-side file path on disk (not just the cached " +
      "workflow library), so it loads ad-hoc / expert workflow files that workflow_list and " +
      "panel_open_workflow can't resolve. Provide exactly one of: path, filename, or graph. Returns " +
      "conversion warnings, a node-type summary, and the stripped graph (much smaller than the raw UI JSON).",
    {
      path: z
        .string()
        .optional()
        .describe(
          "Absolute server-side path to a workflow .json on disk (e.g. " +
            "C:\\\\Users\\\\you\\\\ComfyUI\\\\user\\\\default\\\\workflows\\\\pusa_extend.json). Read directly from disk — no library lookup.",
        ),
      filename: z
        .string()
        .optional()
        .describe("Workflow filename in the ComfyUI userdata library, as an alternative to path."),
      graph: z
        .record(z.string(), z.any())
        .optional()
        .describe("Inline UI-format workflow JSON, as an alternative to path/filename."),
      format: z
        .enum(["api", "raw"])
        .optional()
        .default("api")
        .describe("'api' (default) strips to the flat resolved graph; 'raw' returns the file/graph unchanged."),
    },
    async ({ path, filename, graph, format }) => {
      try {
        const provided = [path, filename, graph].filter((v) => v != null).length;
        if (provided !== 1) {
          throw new ValidationError("Provide exactly one of: path, filename, or graph.");
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let raw: any;
        if (graph) {
          raw = graph;
        } else if (path) {
          raw = JSON.parse(await readFile(path, "utf8"));
        } else {
          const client = getClient();
          const encoded = encodeURIComponent(`workflows/${filename}`);
          const res = await client.fetchApi(`/api/userdata/${encoded}`);
          if (!res.ok) {
            throw new ValidationError(`Workflow not found in library: ${filename} (${res.status})`);
          }
          raw = await res.json();
        }

        if (format === "raw" || !isUiFormat(raw)) {
          return { content: [{ type: "text", text: JSON.stringify(raw, null, 2) }] };
        }

        const bulk = await getObjectInfo();
        const objectInfo = await backfillObjectInfo(bulk, collectNodeTypes(raw));
        const { workflow, warnings } = convertUiToApi(raw, objectInfo);

        const hist: Record<string, number> = {};
        for (const node of Object.values(workflow)) {
          const t = (node as { class_type?: string }).class_type ?? "?";
          hist[t] = (hist[t] ?? 0) + 1;
        }
        const summary = Object.entries(hist)
          .sort((a, b) => b[1] - a[1])
          .map(([t, c]) => `${c}× ${t}`)
          .join(", ");

        return {
          content: [
            {
              type: "text",
              text:
                `Stripped to ${Object.keys(workflow).length} nodes` +
                (warnings.length ? ` · ${warnings.length} warning(s)` : "") +
                `\nNode types: ${summary}` +
                (warnings.length
                  ? `\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}`
                  : ""),
            },
            { type: "text", text: JSON.stringify(workflow, null, 2) },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "query_workflow",
    "QUERY a workflow file — filter, traverse, project, and aggregate over its nodes WITHOUT " +
      "dumping the whole JSON (the missing middle between analyze_workflow's fixed summary and " +
      "get_workflow's full dump; on 100+-node graphs this is the ONLY context-safe way to answer " +
      "questions like 'which KSamplers run cfg>7', 'what feeds node 42', 'count nodes by type'). " +
      "Provide exactly one of path/filename/graph, then combine: `types` (class_type contains any), " +
      "`title` (contains), `where` widget predicates ANDed ('cfg>7', 'steps<=20', 'sampler_name=euler', " +
      "'text~sunset' — ops = != >= <= > < ~contains), `ids` (exact nodes — the way to read ONE node's " +
      "detail), `upstream_of`/`downstream_of` + `depth` (dependency traversal: upstream = what FEEDS " +
      "that node, downstream = what CONSUMES it; seed included at depth 0), `fields` ('compact' one " +
      "line per node [default], 'ids', or 'detail' JSON rows with widgets + wiring), `group_by:'type'` " +
      "(counts only), `limit` (default 40). Output is TOKEN-BOUNDED with an explicit truncation marker. " +
      "For the LIVE canvas use panel_query_graph instead. Read-only.",
    {
      path: z.string().optional().describe("Absolute server-side path to a workflow .json on disk."),
      filename: z
        .string()
        .optional()
        .describe("Workflow filename in the ComfyUI userdata library, as an alternative to path."),
      graph: z
        .record(z.string(), z.any())
        .optional()
        .describe("Inline workflow JSON (UI or API format), as an alternative to path/filename."),
      types: z
        .array(z.string())
        .optional()
        .describe("Keep nodes whose class_type contains ANY of these (case-insensitive)."),
      title: z.string().optional().describe("Keep nodes whose title contains this."),
      where: z
        .array(z.string())
        .optional()
        .describe("Widget predicates, ANDed: 'cfg>7', 'sampler_name=euler', 'text~sunset'."),
      ids: z
        .array(z.union([z.string(), z.number()]))
        .optional()
        .describe("Keep exactly these node ids."),
      upstream_of: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Scope to the dependency closure FEEDING this node id."),
      downstream_of: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Scope to the nodes CONSUMING this node id's outputs."),
      depth: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Max hops from the traversal seed (seed=0). Absent = full closure."),
      fields: z
        .enum(["ids", "compact", "detail"])
        .optional()
        .describe("Projection: compact one-liners (default), bare ids, or detail JSON rows."),
      group_by: z.enum(["type"]).optional().describe("Aggregate: counts per class_type instead of listing."),
      limit: z.number().int().min(1).max(200).optional().describe("Max nodes listed (default 40)."),
      max_chars: z
        .number()
        .int()
        .min(500)
        .max(60000)
        .optional()
        .describe("Output character bound (default 12000). Raise only for deliberate full reads."),
    },
    async ({ path, filename, graph, ...query }) => {
      try {
        const provided = [path, filename, graph].filter((v) => v != null).length;
        if (provided !== 1) {
          throw new ValidationError("Provide exactly one of: path, filename, or graph.");
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let raw: any;
        if (graph) {
          raw = graph;
        } else if (path) {
          raw = JSON.parse(await readFile(path, "utf8"));
        } else {
          const client = getClient();
          const encoded = encodeURIComponent(`workflows/${filename}`);
          const res = await client.fetchApi(`/api/userdata/${encoded}`);
          if (!res.ok) {
            throw new ValidationError(`Workflow not found in library: ${filename} (${res.status})`);
          }
          raw = await res.json();
        }
        let api = raw;
        const notes: string[] = [];
        if (isUiFormat(raw)) {
          const bulk = await getObjectInfo();
          const objectInfo = await backfillObjectInfo(bulk, collectNodeTypes(raw));
          const converted = convertUiToApi(raw, objectInfo);
          api = converted.workflow;
          if (converted.warnings.length)
            notes.push(`${converted.warnings.length} conversion warning(s) — see strip_workflow for details`);
        } else if (!isApiFormat(raw)) {
          throw new ValidationError("Not a recognizable workflow (neither UI nor API format).");
        }
        const result = queryApiGraph(api, query);
        return {
          content: [
            { type: "text", text: result.text + (notes.length ? `\n(${notes.join("; ")})` : "") },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "slice_workflow",
    "Slice ONE pipeline out of a toggle-template workflow — the kind built with rgthree " +
      "'Fast Groups Bypasser/Muter' where one graph holds many pipelines and only one is active at a time. " +
      "Seeds from the output/SaveImage nodes in the named groups, takes their backward dependency closure " +
      "(through real links AND virtual Set/Get buses), un-bypasses the kept nodes (and the internals of any " +
      "subgraph defs they use), and returns a STANDALONE, activated UI graph carrying only the subgraph " +
      "defs it uses. Reads from any server-side path, userdata filename, or inline graph. Pair with " +
      "strip_workflow afterward to flatten the Set/Get buses into real connections.",
    {
      path: z.string().optional().describe("Absolute server-side path to the workflow .json on disk."),
      filename: z.string().optional().describe("Workflow filename in the ComfyUI userdata library."),
      graph: z.record(z.string(), z.any()).optional().describe("Inline UI-format workflow JSON."),
      groups: z
        .union([z.string(), z.array(z.string())])
        .describe(
          "Group-title substrings (case-insensitive) whose output nodes seed the slice — CSV string or " +
            "array, e.g. 'TEXT TO IMAGE,TXT' or ['extend','sampler']. Shared post-proc is pulled in via the closure.",
        ),
    },
    async ({ path, filename, graph, groups }) => {
      try {
        const provided = [path, filename, graph].filter((v) => v != null).length;
        if (provided !== 1) {
          throw new ValidationError("Provide exactly one of: path, filename, or graph.");
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let raw: any;
        if (graph) {
          raw = graph;
        } else if (path) {
          raw = JSON.parse(await readFile(path, "utf8"));
        } else {
          const client = getClient();
          const encoded = encodeURIComponent(`workflows/${filename}`);
          const res = await client.fetchApi(`/api/userdata/${encoded}`);
          if (!res.ok) {
            throw new ValidationError(`Workflow not found in library: ${filename} (${res.status})`);
          }
          raw = await res.json();
        }

        const groupList = Array.isArray(groups) ? groups : String(groups).split(",");
        const { workflow, stats } = sliceWorkflow(raw, groupList);

        const flags =
          stats.badLinks || stats.orphanGets
            ? ` · ⚠ bad_links=${stats.badLinks} orphan_gets=${stats.orphanGets}`
            : "";
        return {
          content: [
            {
              type: "text",
              text:
                `Sliced ${stats.nodes} nodes (un-bypassed ${stats.unbypassed}), ${stats.links} links, ` +
                `${stats.subgraphs} subgraph def(s) · seeds=${stats.seeds}${flags}`,
            },
            { type: "text", text: JSON.stringify(workflow, null, 2) },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "save_workflow",
    "Save a workflow JSON to the connected ComfyUI server's user library so it appears in the ComfyUI web UI. Requires a running ComfyUI server; this writes to that server's userdata and overwrites any existing file with the same filename without confirmation. Web-UI-format JSON ({ nodes: [], links: [] }) is saved as-is and is the preferred input — when re-saving an existing workflow, load it with get_workflow format='ui' and modify THAT. API-format graphs ({ '1': { class_type, inputs } }) are AUTO-CONVERTED to Web UI format with a generated layout so the saved file always opens in the ComfyUI canvas (the canvas cannot open raw API format). Returns a confirmation message (noting the conversion and any warnings), or the HTTP status and error text on failure.",
    {
      filename: z
        .string()
        .describe(
          "Filename to save as (e.g. 'my_workflow.json'). Will overwrite if it already exists.",
        ),
      workflow: z
        .record(z.string(), z.any())
        .describe("Workflow JSON to save. Web UI format ({ nodes: [], links: [] }) is stored verbatim; API format ({ '1': { class_type, inputs } }) is auto-converted to Web UI format (generated layout) so it stays openable in ComfyUI's canvas. Not validated against the server before saving."),
    },
    async (args) => {
      try {
        const client = getClient();
        const encoded = encodeURIComponent(`workflows/${args.filename}`);

        // API-format graphs can't be opened by the canvas — the #1 way agents
        // strand users with workflows that "exist" in the library yet load
        // blank. Auto-convert them to UI format with a generated layout; fall
        // back to a verbatim save (with the loud warning) only if conversion
        // itself fails.
        let toSave: unknown = args.workflow;
        let note = "";
        if (!isUiFormat(args.workflow) && isApiFormat(args.workflow)) {
          try {
            const apiGraph = args.workflow as WorkflowJSON;
            const bulk = await getObjectInfo();
            const objectInfo = await backfillObjectInfo(
              bulk,
              Object.values(apiGraph).map((n) => n.class_type),
            );
            const { workflow: ui, warnings } = convertApiToUi(apiGraph, objectInfo);
            toSave = ui;
            note =
              `\n\nℹ️ Input was API format — auto-converted to Web UI format (generated layout) ` +
              `so it opens in the ComfyUI canvas.`;
            if (warnings.length > 0) {
              note += `\nConversion warnings (${warnings.length}):\n${warnings.map((w) => `- ${w}`).join("\n")}`;
            }
          } catch (convErr) {
            note =
              `\n\n⚠️ Input was API format and auto-conversion to Web UI format failed ` +
              `(${convErr instanceof Error ? convErr.message : String(convErr)}) — saved verbatim. ` +
              `The ComfyUI canvas CANNOT open or edit this file. If it is meant to be reopened in ` +
              `the UI, rebuild it in Web UI format ({ nodes: [], links: [] }) — e.g. load the ` +
              `on-canvas graph or an existing file via get_workflow format="ui", apply your ` +
              `changes to that, and save again.`;
          }
        } else if (!isUiFormat(args.workflow)) {
          note =
            `\n\n⚠️ This JSON is neither Web UI format ({ nodes: [], links: [] }) nor API format ` +
            `({ '1': { class_type, inputs } }) — saved verbatim, but the ComfyUI canvas likely ` +
            `cannot open it.`;
        }

        const res = await client.fetchApi(
          `/api/userdata/${encoded}`,
          {
            method: "POST",
            body: JSON.stringify(toSave),
          },
        );

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          return {
            content: [
              {
                type: "text",
                text: `Failed to save workflow: ${res.status} ${res.statusText}${errText ? `\n${errText}` : ""}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Workflow saved as "${args.filename}" in the ComfyUI user library.${note}`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  // Helper: load and convert a workflow from the library
  async function loadWorkflowApi(filename: string): Promise<{ workflow: WorkflowJSON; warnings: string[] }> {
    const client = getClient();
    const encoded = encodeURIComponent(`workflows/${filename}`);
    const res = await client.fetchApi(`/api/userdata/${encoded}`);

    if (!res.ok) {
      throw new ValidationError(`Workflow not found: ${filename} (${res.status})`);
    }

    const raw = await res.json();
    const objectInfo = await getObjectInfo();

    if (isUiFormat(raw)) {
      return convertUiToApi(raw, objectInfo);
    }

    // Already API format
    return { workflow: raw as WorkflowJSON, warnings: [] };
  }

  server.tool(
    "analyze_workflow",
    "Load a saved workflow and return a structured analysis — sections, node settings, connections, " +
      "and data flow. Use this to understand any workflow before modifying or executing it. " +
      "Returns a concise text summary (not raw JSON) optimized for AI reasoning. " +
      "Prefer this over get_workflow unless you need the raw JSON for enqueue_workflow or modify_workflow.",
    {
      filename: z
        .string()
        .describe(
          "Workflow filename (e.g. 'Scene Builder v3.json'). Use list_workflows to see available files.",
        ),
      view: z
        .enum(["summary", "overview", "detail", "list", "flat", "health"])
        .optional()
        .default("summary")
        .describe(
          "summary (default): structured text with sections, node IDs, key settings, virtual wires, " +
            "and full connection graph — best for AI understanding. " +
            "overview: mermaid diagram showing sections as summary nodes with cross-section data flow. " +
            "detail: mermaid diagram for one section (requires section parameter). " +
            "list: text listing of all sections with data flow summary. " +
            "flat: single mermaid flowchart of the entire workflow (best for small workflows). " +
            "health: graph-health heuristics (disconnected nodes, duplicate model loads, orphaned branches, muted/bypassed).",
        ),
      section: z
        .string()
        .optional()
        .describe(
          "Section name for detail view. Use view='list' first to see available section names.",
        ),
    },
    async ({ filename, view, section }) => {
      try {
        logger.info(`Analyzing workflow: ${filename} (view=${view})`);
        const { workflow, warnings } = await loadWorkflowApi(filename);
        const objectInfo = await getObjectInfo();

        const nodeCount = Object.keys(workflow).length;
        if (nodeCount === 0) {
          throw new ValidationError("Workflow contains no nodes");
        }

        const content: Array<{ type: "text"; text: string }> = [];

        // Prepend warnings if any
        if (warnings.length > 0) {
          content.push({
            type: "text",
            text: `**Conversion warnings (${warnings.length}):**\n${warnings.map((w) => `- ${w}`).join("\n")}`,
          });
        }

        if (view === "flat") {
          // Simple mermaid flowchart — good for small workflows
          const mermaid = convertToMermaid(workflow, { showValues: true, direction: "LR" });
          content.push({ type: "text", text: `\`\`\`mermaid\n${mermaid}\n\`\`\`` });
          return { content };
        }

        if (view === "health") {
          const health = analyzeGraphHealth(workflow, objectInfo);
          const lines: string[] = ["### Graph health", `- ${health.summary}`];
          if (health.findings.length === 0) {
            lines.push("- No health issues found.");
          } else {
            for (const f of health.findings) {
              const tag = f.heuristic ? `${f.severity}, heuristic` : f.severity;
              lines.push(`- [${tag}] ${f.detail}`);
            }
          }
          content.push({ type: "text", text: lines.join("\n") });
          return { content };
        }

        // All other views need section detection
        const detection = detectSections(workflow, objectInfo);
        const { sections, virtualEdges, nodeToSection, getSetNodeIds } = detection;

        if (view === "summary") {
          const text = generateSummary(
            workflow, sections, objectInfo, virtualEdges, nodeToSection, getSetNodeIds,
          );
          content.push({ type: "text", text });
          return { content };
        }

        if (view === "list") {
          const text = listSections(workflow, sections);
          content.push({ type: "text", text });
          return { content };
        }

        if (view === "detail") {
          if (!section) {
            const available = [...sections.keys()].join(", ");
            throw new ValidationError(
              `section parameter is required for detail view. Available sections: ${available}`,
            );
          }
          const mermaid = generateSectionDetail(workflow, sections, section, {
            showValues: true,
            direction: "LR",
          });
          content.push({ type: "text", text: `\`\`\`mermaid\n${mermaid}\n\`\`\`` });
          return { content };
        }

        // overview
        const mermaid = generateOverview(workflow, sections, { direction: "TB" });
        content.push({ type: "text", text: `\`\`\`mermaid\n${mermaid}\n\`\`\`` });
        return { content };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
