import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// SHELL — implement per the PR spec, then (1) wire registerRunTemplateTools into
// registerAllTools() in src/tools/index.ts and (2) add a unit test.
export function registerRunTemplateTools(server: McpServer): void {
  server.tool(
    "run_template",
    "SHELL — not yet implemented. See PR spec.",
    { _shell: z.string().optional() },
    async () => ({ content: [{ type: "text" as const, text: "run_template: not implemented (shell)" }] }),
  );
}
