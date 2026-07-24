import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// SHELL — implement per the PR spec, then (1) wire registerTemplateSchemaTools into
// registerAllTools() in src/tools/index.ts and (2) add a unit test.
export function registerTemplateSchemaTools(server: McpServer): void {
  server.tool(
    "get_template_schema",
    "SHELL — not yet implemented. See PR spec.",
    { _shell: z.string().optional() },
    async () => ({ content: [{ type: "text" as const, text: "get_template_schema: not implemented (shell)" }] }),
  );
}
