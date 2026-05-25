#!/usr/bin/env node
import { logger } from "../utils/logger.js";
import { maybeStartAgentPoc } from "./agent-poc.js";

// ---------------------------------------------------------------------------
// Standalone runner for the experimental embedded-agent-panel POC.
//
// This is intentionally NOT imported by src/index.ts — the default MCP server
// (stdio / HTTP) never touches the POC. Run it explicitly, e.g.:
//
//   COMFYUI_MCP_AGENT_POC=1 ANTHROPIC_API_KEY=... npx tsx src/experimental/run.ts
//   COMFYUI_MCP_AGENT_POC=1 COMFYUI_MCP_AGENT_TUNNEL=1 ... node dist/experimental/run.js
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const handle = await maybeStartAgentPoc();
  if (!handle) {
    logger.warn(
      "[agent-poc] COMFYUI_MCP_AGENT_POC is not set — nothing to run. Set it to 1 to start the POC.",
    );
    return;
  }

  logger.info(`[agent-poc] ready at ${handle.localUrl}/api/chat`);
  if (handle.publicUrl) {
    logger.info(`[agent-poc] public URL: ${handle.publicUrl}`);
  }

  const shutdown = (): void => {
    logger.info("[agent-poc] shutting down...");
    void handle.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error("[agent-poc] fatal error", err);
  process.exit(1);
});
