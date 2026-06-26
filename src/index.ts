#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { registerAllTools } from "./tools/index.js";
import { logger } from "./utils/logger.js";
import { JobWatcher } from "./services/job-watcher.js";
import { parseCliArgs } from "./transport/cli.js";
import { startHttpServer } from "./transport/http.js";
import { isLocalMode } from "./config.js";
import { ensurePanelInstalled } from "./services/panel-installer.js";
import { checkAndSelfUpdate } from "./services/self-update.js";

/**
 * Fire-and-forget: ensure the ComfyUI sidebar panel is installed (install-if-
 * missing) on MCP load. LOCAL-only, hard-timed-out, and never throws — it must
 * never block or crash startup. Opt out with COMFYUI_MCP_PANEL_AUTOINSTALL=0.
 * The explicit `install_panel(action='update')` tool refreshes nightly on demand.
 */
function ensurePanelOnLoad(): void {
  if (!isLocalMode()) return;
  void ensurePanelInstalled()
    .then((res) => {
      switch (res.action) {
        case "installed":
          logger.info(
            "Panel auto-install: installed the sidebar panel (nightly). RESTART ComfyUI to load it.",
            res,
          );
          break;
        case "up-to-date":
          logger.info("Panel auto-install: panel already present.", res);
          break;
        case "skipped-dev":
          logger.info(
            "Panel auto-install: skipped — dev install (symlink), managed manually.",
            res,
          );
          break;
        case "skipped":
          logger.debug("Panel auto-install: disabled via COMFYUI_MCP_PANEL_AUTOINSTALL.", res);
          break;
        default:
          logger.debug("Panel auto-install: unavailable.", res);
      }
    })
    .catch(() => {});
}

/**
 * Fire-and-forget: on MCP load, check the npm registry and (for global/local
 * installs) auto-update the package on disk, then surface a "reconnect to load
 * vX" note — the running process can't hot-swap its own code. NEVER updates a
 * dev (npm link) install, hard-timed-out, and never throws. Opt out with
 * COMFYUI_MCP_AUTOUPDATE=0. Mirrors the panel auto-install ensure pattern.
 */
function selfUpdateOnLoad(): void {
  void checkAndSelfUpdate()
    .then((res) => {
      switch (res.action) {
        case "updated":
          logger.info(
            `Self-update: updated comfyui-mcp ${res.from} → ${res.to} (${res.mode}). ${res.note ?? ""}`,
            res,
          );
          break;
        case "notify":
          logger.info(`Self-update: ${res.note ?? `v${res.to} available.`}`, res);
          break;
        case "up-to-date":
          logger.debug("Self-update: already on the latest version.", res);
          break;
        case "skipped-dev":
          logger.info("Self-update: skipped — dev install (npm link / checkout).", res);
          break;
        case "skipped-disabled":
          logger.debug("Self-update: disabled via COMFYUI_MCP_AUTOUPDATE.", res);
          break;
        default:
          logger.debug("Self-update: unavailable.", res);
      }
    })
    .catch(() => {});
}

async function createConfiguredServer(): Promise<McpServer> {
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
      },
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
      createServer: () => createConfiguredServer(),
    });
    logger.info(`ComfyUI MCP server running on http://${cli.host}:${cli.port}/mcp`);
  } else {
    const server = await createConfiguredServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("ComfyUI MCP server running on stdio");
  }

  // After the server is up: auto-ensure the sidebar panel (non-blocking).
  ensurePanelOnLoad();
  // ...and self-check the npm registry for a newer published version (non-blocking).
  selfUpdateOnLoad();
}

main().catch((err) => {
  logger.error("Fatal error", err);
  process.exit(1);
});
