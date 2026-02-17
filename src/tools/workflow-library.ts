import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import { getClient, getObjectInfo } from "../comfyui/client.js";
import { errorToToolResult, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { isUiFormat, convertUiToApi } from "../services/workflow-converter.js";
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
    "List saved workflows from the ComfyUI user library.",
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
          const objectInfo = await getObjectInfo();
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
    "save_workflow",
    "Save a workflow to the ComfyUI user library so it appears in the web UI. Accepts either API format or UI format JSON.",
    {
      filename: z
        .string()
        .describe(
          "Filename to save as (e.g. 'my_workflow.json'). Will overwrite if it already exists.",
        ),
      workflow: z
        .record(z.any())
        .describe("Workflow JSON to save (API or UI format)"),
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

        return {
          content: [
            {
              type: "text",
              text: `Workflow saved as "${args.filename}" in the ComfyUI user library.`,
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
