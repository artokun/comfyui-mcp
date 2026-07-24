import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// SHELL — implement per the PR spec, then (1) wire registerBatchTools into
// registerAllTools() in src/tools/index.ts and (2) add a unit test.
export function registerBatchTools(server: McpServer): void {
  server.tool(
    "submit_batch",
    "SHELL — not yet implemented. See PR spec.",
    { _shell: z.string().optional() },
    async () => ({ content: [{ type: "text" as const, text: "submit_batch: not implemented (shell)" }] }),
  );
  server.tool(
    "get_batch_status",
    "SHELL — not yet implemented. See PR spec.",
    { _shell: z.string().optional() },
    async () => ({ content: [{ type: "text" as const, text: "get_batch_status: not implemented (shell)" }] }),
  );
  server.tool(
    "get_batch_output",
    "SHELL — not yet implemented. See PR spec.",
    { _shell: z.string().optional() },
    async () => ({ content: [{ type: "text" as const, text: "get_batch_output: not implemented (shell)" }] }),
  );
  server.tool(
    "wait_for_batch",
    "SHELL — not yet implemented. See PR spec.",
    { _shell: z.string().optional() },
    async () => ({ content: [{ type: "text" as const, text: "wait_for_batch: not implemented (shell)" }] }),
  );
}
