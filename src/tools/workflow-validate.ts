import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import { validateWorkflow } from "../services/workflow-validator.js";
import { errorToToolResult, ValidationError } from "../utils/errors.js";

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

export function registerWorkflowValidateTools(server: McpServer): void {
  server.tool(
    "validate_workflow",
    "Validate a ComfyUI workflow without executing it. Checks for missing node types, broken connections, invalid output indices, missing models, and other issues. Returns a list of errors and warnings.",
    {
      workflow: z
        .union([z.string(), z.record(z.any())])
        .describe("ComfyUI workflow in API format (JSON string or object)"),
    },
    async (args) => {
      try {
        const workflow = parseWorkflow(args.workflow);
        const result = await validateWorkflow(workflow);

        const lines: string[] = [];
        lines.push(`## ${result.summary}`);
        lines.push("");

        if (result.issues.length === 0) {
          lines.push("No issues found. The workflow is ready to execute.");
        } else {
          const errors = result.issues.filter((i) => i.severity === "error");
          const warnings = result.issues.filter((i) => i.severity === "warning");

          if (errors.length > 0) {
            lines.push("### Errors");
            for (const issue of errors) {
              const loc = issue.node_id
                ? `Node ${issue.node_id} (${issue.node_type})`
                : "Workflow";
              lines.push(`- **${loc}**: ${issue.message}`);
            }
            lines.push("");
          }

          if (warnings.length > 0) {
            lines.push("### Warnings");
            for (const issue of warnings) {
              const loc = issue.node_id
                ? `Node ${issue.node_id} (${issue.node_type})`
                : "Workflow";
              lines.push(`- **${loc}**: ${issue.message}`);
            }
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: lines.join("\n"),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
