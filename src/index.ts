#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { registerAllTools } from "./tools/index.js";
import { enqueuePanelMessage, registerPanelTools } from "./tools/panel.js";
import { logger } from "./utils/logger.js";
import { JobWatcher } from "./services/job-watcher.js";
import { startUiBridge } from "./services/ui-bridge.js";
import { parseCliArgs } from "./transport/cli.js";
import { startHttpServer } from "./transport/http.js";

/**
 * Channels mode (--channels / COMFYUI_MCP_CHANNELS=1): start the loopback
 * WS bridge the comfyui-mcp-panel pack connects to, register the panel_*
 * tools, and forward panel user messages into the agent session — queued for
 * panel_inbox, and pushed as a `notifications/claude/channel` event for hosts
 * that surface those (Claude Code). The user's own subscription session is
 * the agent; no LLM API keys are involved.
 */
function enableChannels(server: McpServer): void {
  const bridge = startUiBridge();
  registerPanelTools(server);
  bridge.onPanelMessage = (event) => {
    if (event.type !== "user_message" || typeof event.text !== "string") return;
    enqueuePanelMessage(event.text, {
      tab_id: event.tab_id,
      title: event.title,
      subgraph: event.context?.subgraph,
    });
    // Echo into the originating tab so the user sees their message land.
    bridge.push({ type: "echo", text: event.text }, event.tab_id);
    // Push into the agent session as a channel event. Requires the
    // `claude/channel` experimental capability declared at construction;
    // the host injects { content, meta } as a <channel> block in the
    // prompt. panel_inbox remains the pull fallback for other hosts.
    void server.server
      .notification({
        method: "notifications/claude/channel",
        params: {
          content: event.text,
          meta: {
            source: "comfyui-panel",
            kind: "user_message",
            ...(event.tab_id ? { tab_id: event.tab_id } : {}),
            ...(event.title ? { workflow: event.title } : {}),
            ...(event.context?.subgraph ? { subgraph: event.context.subgraph } : {}),
          },
        },
      })
      .catch((err: unknown) => {
        logger.debug("channel notification not delivered", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };
  logger.info("[channels] panel bridge active — panel_* tools registered");
}

async function createConfiguredServer(channels = false): Promise<McpServer> {
  const server = new McpServer(
    {
      name: "comfyui-mcp",
      version: "0.1.0",
    },
    {
      // We declare `resources` and `prompts` (with noop list handlers below)
      // so federating clients like LiteLLM's MCP gateway, which probe every
      // standard list endpoint on initialize fan-out, get a fast empty list
      // instead of a per-server timeout from "Method not found". We don't
      // expose resources or prompts today; advertising them is spec-correct
      // when paired with a list handler that returns the empty set.
      // Reported by @ductiletoaster in #29.
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        // Channels mode: declaring the experimental `claude/channel`
        // capability is what makes Claude Code surface our
        // `notifications/claude/channel` pushes (panel user messages) as
        // <channel> events in the agent's prompt. Without it the host
        // silently drops them.
        ...(channels ? { experimental: { "claude/channel": {} } } : {}),
      },
      ...(channels
        ? {
            instructions:
              'Messages the user types into the ComfyUI sidebar panel arrive as <channel source="comfyui-panel" kind="user_message"> events (with the tab_id and workflow title in meta). Act on them and reply with the panel_say tool — that is the only way your words reach the panel. panel_inbox is the pull fallback on hosts without channel support.',
          }
        : {}),
    },
  );
  await registerAllTools(server);

  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [],
  }));
  server.server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async () => ({ resourceTemplates: [] }),
  );
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [],
  }));

  if (channels) enableChannels(server);

  return server;
}

async function main() {
  const cli = parseCliArgs(process.argv);

  // Standalone background orchestrator: owns the UI bridge and drives the panel
  // with autonomous Agent SDK sessions. Not an MCP server — it never returns.
  if (cli.panelOrchestrator) {
    const { runPanelOrchestrator } = await import("./orchestrator/index.js");
    await runPanelOrchestrator();
    return;
  }

  await JobWatcher.cleanupOldFiles();

  if (cli.transport === "http") {
    await startHttpServer({
      host: cli.host,
      port: cli.port,
      createServer: () => createConfiguredServer(cli.channels),
    });
    logger.info(`ComfyUI MCP server running on http://${cli.host}:${cli.port}/mcp`);
  } else {
    const server = await createConfiguredServer(cli.channels);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("ComfyUI MCP server running on stdio");
  }
}

main().catch((err) => {
  logger.error("Fatal error", err);
  process.exit(1);
});
