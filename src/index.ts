#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./tools/index.js";
import { logger } from "./utils/logger.js";

const server = new McpServer(
  {
    name: "comfyui-mcp",
    version: "0.1.0",
  },
  {
    capabilities: { tools: {} },
  },
);

registerAllTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("ComfyUI MCP server running on stdio");
}

main().catch((err) => {
  logger.error("Fatal error", err);
  process.exit(1);
});
