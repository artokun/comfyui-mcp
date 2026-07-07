import { z } from "zod";
import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import { getClient, getObjectInfo, backfillObjectInfo } from "../comfyui/client.js";
import { errorToToolResult, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { isUiFormat, convertUiToApi, collectNodeTypes } from "../services/workflow-converter.js";
import { sliceWorkflow } from "../services/workflow-slicer.js";
import { detectSections } from "../services/workflow-sections.js";
import {
  generateOverview,
  generateSectionDetail,
  listSections,
  generateSummary,
} from "../services/hierarchical-mermaid.js";
import { convertToMermaid } from "../services/mermaid-converter.js";

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
    "Save a workflow JSON to the connected ComfyUI server's user library so it appears in the ComfyUI web UI. Requires a running ComfyUI server; this writes to that server's userdata and overwrites any existing file with the same filename without confirmation. IMPORTANT: pass Web-UI-format JSON ({ nodes: [], links: [] }) so the saved workflow opens and edits in the ComfyUI canvas — when re-saving an existing workflow, load it with get_workflow format='ui' and modify THAT. API-format graphs are accepted and stored verbatim, but the canvas CANNOT open them (users see a broken/blank load), so only save API format for headless re-queueing. Returns a confirmation message (with a warning when the input was API format), or the HTTP status and error text on failure.",
    {
      filename: z
        .string()
        .describe(
          "Filename to save as (e.g. 'my_workflow.json'). Will overwrite if it already exists.",
        ),
      workflow: z
        .record(z.string(), z.any())
        .describe("Workflow JSON to save. Prefer Web UI format ({ nodes: [], links: [] }) so it stays editable in ComfyUI's canvas; API format is accepted but the frontend cannot open it. Stored verbatim; not validated before saving."),
    },
    async (args) => {
      try {
        const client = getClient();
        const encoded = encodeURIComponent(`workflows/${args.filename}`);
        const body = JSON.stringify(args.workflow);

        const res = await client.fetchApi(
          `/api/userdata/${encoded}`,
          {
            method: "POST",
            body,
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

        // API-format saves are legal (headless re-queue) but the canvas can't
        // open them — the #1 way agents strand users with workflows that "exist"
        // in the library yet load blank, so they keep creating new ones instead
        // of navigating back. Warn loudly until auto-conversion ships.
        const apiFormatWarning = isUiFormat(args.workflow)
          ? ""
          : `\n\n⚠️ This was saved in API format — the ComfyUI canvas CANNOT open or edit it. ` +
            `If this workflow is meant to be reopened in the UI, rebuild it in Web UI format ` +
            `({ nodes: [], links: [] }) — e.g. load the on-canvas graph or an existing file via ` +
            `get_workflow format="ui", apply your changes to that, and save again.`;
        return {
          content: [
            {
              type: "text",
              text: `Workflow saved as "${args.filename}" in the ComfyUI user library.${apiFormatWarning}`,
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
        .enum(["summary", "overview", "detail", "list", "flat"])
        .optional()
        .default("summary")
        .describe(
          "summary (default): structured text with sections, node IDs, key settings, virtual wires, " +
            "and full connection graph — best for AI understanding. " +
            "overview: mermaid diagram showing sections as summary nodes with cross-section data flow. " +
            "detail: mermaid diagram for one section (requires section parameter). " +
            "list: text listing of all sections with data flow summary. " +
            "flat: single mermaid flowchart of the entire workflow (best for small workflows).",
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
