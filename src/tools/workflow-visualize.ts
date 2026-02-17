import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import { convertToMermaid } from "../services/mermaid-converter.js";
import { parseMermaid, resolveWorkflow } from "../services/mermaid-parser.js";
import { getObjectInfo } from "../comfyui/client.js";
import { errorToToolResult, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { detectSections } from "../services/workflow-sections.js";
import {
  generateOverview,
  generateSectionDetail,
  listSections,
} from "../services/hierarchical-mermaid.js";

function parseWorkflow(input: unknown): WorkflowJSON {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ValidationError("Workflow JSON must be an object with node IDs as keys");
      }
      return parsed as WorkflowJSON;
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(`Invalid JSON string: ${(err as Error).message}`);
    }
  }
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as WorkflowJSON;
  }
  throw new ValidationError("Workflow must be a JSON string or object");
}

export function registerWorkflowVisualizeTools(server: McpServer): void {
  server.tool(
    "visualize_workflow",
    "Convert a ComfyUI workflow JSON into a Mermaid flowchart diagram. Returns mermaid syntax showing nodes grouped by category (loading, conditioning, sampling, image, output) with connections labeled by data type.",
    {
      workflow: z
        .union([z.string(), z.record(z.any())])
        .describe("ComfyUI workflow JSON (as a JSON string or object)"),
      show_values: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include widget values (seed, steps, cfg, etc.) in node labels"),
      direction: z
        .enum(["LR", "TB"])
        .optional()
        .default("LR")
        .describe("Flowchart direction: LR (left-to-right) or TB (top-to-bottom)"),
    },
    async ({ workflow, show_values, direction }) => {
      try {
        logger.info("Visualizing workflow");
        const parsed = parseWorkflow(workflow);

        const nodeCount = Object.keys(parsed).length;
        if (nodeCount === 0) {
          throw new ValidationError("Workflow contains no nodes");
        }

        const mermaid = convertToMermaid(parsed, {
          showValues: show_values,
          direction,
        });

        return {
          content: [
            {
              type: "text",
              text: `\`\`\`mermaid\n${mermaid}\n\`\`\``,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "mermaid_to_workflow",
    "Convert a Mermaid flowchart diagram back into a ComfyUI workflow JSON. " +
      "Parses node definitions, connections (with data type labels), and widget values from the mermaid syntax. " +
      "Resolves node types and wires connections using ComfyUI's /object_info schemas. " +
      "Fills missing inputs with defaults. Returns a valid, executable ComfyUI API workflow.",
    {
      mermaid: z
        .string()
        .describe(
          "Mermaid flowchart text (with or without ```mermaid code fence). " +
            "Nodes should use ComfyUI class_type names as labels. " +
            "Connections should be labeled with data types (e.g., -->|MODEL|).",
        ),
    },
    async ({ mermaid }) => {
      try {
        logger.info("Converting mermaid to workflow");

        // Parse the mermaid text into nodes and edges
        const parsed = parseMermaid(mermaid);
        logger.info(
          `Parsed ${parsed.nodes.size} nodes and ${parsed.edges.length} edges`,
        );

        // Fetch node definitions from ComfyUI for schema resolution
        const objectInfo = await getObjectInfo();

        // Resolve into a valid workflow
        const { workflow, warnings } = resolveWorkflow(parsed, objectInfo);

        const nodeCount = Object.keys(workflow).length;
        const connectionCount = Object.values(workflow).reduce(
          (count, node) =>
            count +
            Object.values(node.inputs).filter(
              (v) =>
                Array.isArray(v) &&
                v.length === 2 &&
                typeof v[0] === "string" &&
                typeof v[1] === "number",
            ).length,
          0,
        );

        const content: Array<{ type: "text"; text: string }> = [];

        // Summary
        let summary = `Converted mermaid to workflow: ${nodeCount} nodes, ${connectionCount} connections.`;
        if (warnings.length > 0) {
          summary += `\n\n**Warnings (${warnings.length}):**\n${warnings.map((w) => `- ${w}`).join("\n")}`;
        }
        content.push({ type: "text", text: summary });

        // The workflow JSON
        content.push({
          type: "text",
          text: JSON.stringify(workflow, null, 2),
        });

        return { content };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "visualize_workflow_hierarchical",
    "Visualize a large ComfyUI workflow as a hierarchical diagram. " +
      "Detects logical sections using node categories from /object_info, resolves Get/Set virtual wires, " +
      "and produces either a compact overview (sections as summary nodes), a detailed view of one section, " +
      "or a text listing of all sections. Best for workflows with 20+ nodes.",
    {
      view: z
        .enum(["overview", "detail", "list"])
        .optional()
        .default("overview")
        .describe(
          "overview: compact diagram with sections as summary nodes; " +
            "detail: full diagram for one section; " +
            "list: text summary of all sections",
        ),
      section: z
        .string()
        .optional()
        .describe(
          "Section name to show in detail view (required when view=detail). " +
            "Use view=list to see available section names.",
        ),
      workflow: z
        .union([z.string(), z.record(z.any())])
        .describe("ComfyUI workflow in API format (JSON string or object)"),
      show_values: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include widget values in node labels (detail view only)"),
      direction: z
        .enum(["LR", "TB"])
        .optional()
        .describe(
          "Flowchart direction (default: TB for overview, LR for detail)",
        ),
    },
    async ({ view, section, workflow, show_values, direction }) => {
      try {
        logger.info(`Hierarchical visualization: view=${view}`);
        const parsed = parseWorkflow(workflow);

        const nodeCount = Object.keys(parsed).length;
        if (nodeCount === 0) {
          throw new ValidationError("Workflow contains no nodes");
        }

        // Fetch object_info for category-based section detection
        const objectInfo = await getObjectInfo();
        const { sections } = detectSections(parsed, objectInfo);

        if (view === "list") {
          const text = listSections(parsed, sections);
          return {
            content: [{ type: "text" as const, text }],
          };
        }

        if (view === "detail") {
          if (!section) {
            const available = [...sections.keys()].join(", ");
            throw new ValidationError(
              `section parameter is required for detail view. Available sections: ${available}`,
            );
          }
          const mermaid = generateSectionDetail(parsed, sections, section, {
            showValues: show_values,
            direction: direction ?? "LR",
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `\`\`\`mermaid\n${mermaid}\n\`\`\``,
              },
            ],
          };
        }

        // Default: overview
        const mermaid = generateOverview(parsed, sections, {
          direction: direction ?? "TB",
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `\`\`\`mermaid\n${mermaid}\n\`\`\``,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
