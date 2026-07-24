import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// SHELL — implement per the PR spec, then (1) wire registerGenerate3dTools into
// registerAllTools() in src/tools/index.ts and (2) add a unit test.
export function registerGenerate3dTools(server: McpServer): void {
  server.tool(
    "generate_3d",
    "SHELL — not yet implemented. See PR spec.",
    { _shell: z.string().optional() },
    async () => ({ content: [{ type: "text" as const, text: "generate_3d: not implemented (shell)" }] }),
  );
}
