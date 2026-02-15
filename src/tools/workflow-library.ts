import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../comfyui/client.js";
import { errorToToolResult } from "../utils/errors.js";

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
    "Load a saved workflow from the ComfyUI user library by filename. Returns the workflow JSON. Note: saved workflows are in ComfyUI's UI format (nodes + links arrays), not API format.",
    {
      filename: z
        .string()
        .describe(
          "Workflow filename (e.g. 'my_workflow.json'). Use list_workflows to see available files.",
        ),
    },
    async (args) => {
      try {
        const client = getClient();
        const encoded = encodeURIComponent(args.filename);
        const res = await client.fetchApi(
          `/api/userdata/workflows/${encoded}`,
        );

        if (!res.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Workflow not found: ${args.filename} (${res.status})`,
              },
            ],
          };
        }

        const workflow = await res.json();
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
}
