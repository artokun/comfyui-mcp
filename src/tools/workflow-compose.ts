import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import {
  createWorkflow,
  modifyWorkflow,
  TEMPLATE_NAMES,
  type ModifyOperation,
} from "../services/workflow-composer.js";
import { getObjectInfo } from "../comfyui/client.js";
import { errorToToolResult, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

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

const operationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set_input"),
    node_id: z.string(),
    input_name: z.string(),
    value: z.any(),
  }),
  z.object({
    op: z.literal("add_node"),
    class_type: z.string(),
    inputs: z.record(z.any()).optional(),
    id: z.string().optional(),
  }),
  z.object({
    op: z.literal("remove_node"),
    node_id: z.string(),
  }),
  z.object({
    op: z.literal("connect"),
    source_id: z.string(),
    output_index: z.number(),
    target_id: z.string(),
    input_name: z.string(),
  }),
  z.object({
    op: z.literal("insert_between"),
    source_id: z.string(),
    output_index: z.number(),
    target_id: z.string(),
    input_name: z.string(),
    new_class_type: z.string(),
    new_inputs: z.record(z.any()).optional(),
  }),
]);

export function registerWorkflowComposeTools(server: McpServer): void {
  // 1. create_workflow
  server.tool(
    "create_workflow",
    `Create a ComfyUI workflow from a named template. Available templates: ${TEMPLATE_NAMES.join(", ")}. Returns the complete workflow JSON ready for execution or further modification.`,
    {
      template: z
        .enum(TEMPLATE_NAMES as [string, ...string[]])
        .describe("Template name: txt2img, img2img, upscale, or inpaint"),
      params: z
        .record(z.any())
        .optional()
        .default({})
        .describe(
          "Template parameters (e.g. checkpoint, positive_prompt, negative_prompt, width, height, steps, cfg, seed, sampler_name, scheduler, denoise, image_path, mask_path, upscale_model)",
        ),
    },
    async ({ template, params }) => {
      try {
        logger.info("Creating workflow", { template, params });
        const workflow = createWorkflow(template, params);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(workflow, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  // 2. modify_workflow
  server.tool(
    "modify_workflow",
    "Apply modification operations to an existing ComfyUI workflow. Supports: set_input, add_node, remove_node, connect, insert_between. Returns the modified workflow JSON and IDs of any newly added nodes.",
    {
      workflow: z
        .union([z.string(), z.record(z.any())])
        .describe("ComfyUI workflow JSON (as a JSON string or object)"),
      operations: z
        .array(operationSchema)
        .describe(
          "Array of operations to apply in order. Each has an 'op' field: set_input, add_node, remove_node, connect, or insert_between",
        ),
    },
    async ({ workflow, operations }) => {
      try {
        logger.info("Modifying workflow", { opCount: operations.length });
        const parsed = parseWorkflow(workflow);
        const result = modifyWorkflow(parsed, operations as ModifyOperation[]);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  workflow: result.workflow,
                  added_node_ids: result.added_ids,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  // 3. get_node_info
  server.tool(
    "get_node_info",
    "Query ComfyUI's /object_info endpoint to get available node type definitions. Optionally filter by node type name (substring match). Returns node inputs, outputs, and descriptions.",
    {
      node_type: z
        .string()
        .optional()
        .describe(
          "Filter by node class_type name (case-insensitive substring match). Omit to list all available nodes.",
        ),
    },
    async ({ node_type }) => {
      try {
        logger.info("Getting node info", { filter: node_type });
        const info = await getObjectInfo();

        let entries = Object.entries(info);
        if (node_type) {
          const lower = node_type.toLowerCase();
          entries = entries.filter(([name]) => name.toLowerCase().includes(lower));
        }

        if (entries.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: node_type
                  ? `No nodes found matching "${node_type}"`
                  : "No node definitions returned from ComfyUI",
              },
            ],
          };
        }

        // For large result sets, return just names + descriptions
        if (entries.length > 20) {
          const summary = entries.map(([name, def]) => ({
            name,
            display_name: def.display_name,
            category: def.category,
            description: def.description || "",
          }));
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    count: summary.length,
                    nodes: summary,
                    hint: "Use a more specific node_type filter to see full definitions with inputs/outputs",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        const result = Object.fromEntries(entries);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
