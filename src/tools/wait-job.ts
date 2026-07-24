import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// SHELL — implement per the PR spec, then (1) wire registerWaitJobTools into
// registerAllTools() in src/tools/index.ts and (2) add a unit test.
export function registerWaitJobTools(server: McpServer): void {
  server.tool(
    "wait_for_job",
    "SHELL — not yet implemented. See PR spec.",
    { _shell: z.string().optional() },
    async () => ({ content: [{ type: "text" as const, text: "wait_for_job: not implemented (shell)" }] }),
  );
}
