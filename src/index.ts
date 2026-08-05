#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { collectToolCatalog, registerFullTools } from "./tools/index.js";
import { registerCompactTools } from "./tools/compact.js";
import { logger } from "./utils/logger.js";
import { JobWatcher } from "./services/job-watcher.js";
import { parseCliArgs, validateConnectUrl, exportExplicitToolMode, type ToolMode } from "./transport/cli.js";
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
        // #806 — "already present" is the whole claim. The line used to be paired
        // with `action: "up-to-date"`, and users read the pair as "you are on the
        // newest panel"; nothing on this path compares versions.
        case "present":
          logger.info(
            "Panel auto-install: panel already present — NOT a version check. " +
              "Run install_panel(action='status') to compare it against what this build needs.",
            res,
          );
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
        case "shadowed":
          logger.warn(
            "Panel auto-install: a SHADOW copy in custom_nodes may be served instead of the real panel (#641). " +
              "Move the backup dir OUT of custom_nodes and hard-refresh the ComfyUI tab.",
            res,
          );
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

async function createConfiguredServer(toolMode: ToolMode = "compact"): Promise<McpServer> {
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
  if (toolMode === "compact") {
    // Compact tool mode (DEFAULT since #667): capture the whole tool surface
    // into a catalog and expose only the list_tools/describe_tool/call_tool
    // meta-tools, keeping the client's context cost near-zero until a tool is
    // actually needed. Built for small/local LLMs (Hermes Agent, Ollama —
    // issue #97), but the right default for every harness that injects
    // tools/list into context: the full surface is ~200KB (~50k tokens) per
    // read. --full / COMFYUI_MCP_TOOL_MODE=full opts back into the classic
    // direct surface below.
    const catalog = await collectToolCatalog();
    registerCompactTools(server, catalog);
    logger.info(
      `Compact tool mode: ${catalog.tools.size} tools available via list_tools/describe_tool/call_tool`,
    );
  } else {
    // Full direct surface (opt-in via --full) PLUS the compact facade
    // (list_tools/describe_tool/call_tool) as a stable reconnect escape hatch —
    // see registerFullTools and issue #616. One atomic registration pass,
    // completed before the transport connects below. Opt out of the facade
    // with COMFYUI_MCP_NO_FACADE=1.
    await registerFullTools(server);
  }

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

/**
 * Open a cloudflared quick tunnel to the local HTTP MCP port and print a clear,
 * ready-to-paste Claude Desktop Custom Connector block (public https://…/mcp
 * URL + token + headless X-API-Key usage). Resilient: a missing cloudflared
 * binary (or any tunnel error) surfaces install guidance and leaves the local
 * server running instead of crashing.
 */
async function openTunnelAndAnnounce(
  host: string,
  port: number,
  token: string,
): Promise<void> {
  const { startQuickTunnel } = await import("./services/tunnel.js");
  logger.info("[tunnel] starting cloudflared quick tunnel…");
  let publicUrl: string;
  try {
    const tunnel = await startQuickTunnel(port);
    publicUrl = tunnel.url;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      `[tunnel] could not start cloudflared: ${message}\n` +
        `  Install it, then re-run with --tunnel:\n` +
        `    npm install -g cloudflared      # or: brew install cloudflared / winget install cloudflare.cloudflared\n` +
        `  The local server is still running at http://${host}:${port}/mcp (token auth active).`,
    );
    return;
  }

  const mcpUrl = `${publicUrl}/mcp`;
  const snippet = JSON.stringify(
    {
      mcpServers: {
        comfyui: {
          url: mcpUrl,
          headers: { "X-API-Key": token },
        },
      },
    },
    null,
    2,
  );

  // Single multi-line block to stderr so it survives MCP stdio framing and is
  // easy to copy from the terminal.
  process.stderr.write(
    [
      "",
      "════════════════════════════════════════════════════════════════════",
      " ComfyUI MCP — Remote / Hosted Connector is LIVE",
      "════════════════════════════════════════════════════════════════════",
      ` Public MCP URL : ${mcpUrl}`,
      ` Auth token     : ${token}`,
      "",
      " Claude Desktop → Settings → Connectors → Add custom connector:",
      `   • Name : ComfyUI`,
      `   • URL  : ${mcpUrl}`,
      `   • Header: X-API-Key: ${token}   (or Authorization: Bearer ${token})`,
      "",
      " Headless / programmatic config snippet:",
      snippet,
      "",
      " Keep this terminal open — the tunnel closes when the process exits.",
      "════════════════════════════════════════════════════════════════════",
      "",
    ].join("\n"),
  );
}

/** A remote (non-loopback) ComfyUI served over https — the case where the pod's
 *  browser panel needs the secure wss:// bridge instead of plain ws://. */
function isRemoteHttpsPod(u: string): boolean {
  try {
    const url = new URL(u);
    const h = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      !["127.0.0.1", "localhost", "::1", "0.0.0.0", ""].includes(h)
    );
  } catch {
    return false;
  }
}

async function main() {
  const cli = parseCliArgs(process.argv);

  // `--help` / `-h`: print usage and exit BEFORE anything else. It must precede
  // every other branch — including `setup` and `connect` — because a user who
  // asks for help has by definition not decided what to run yet, and starting a
  // server or writing a harness config in response to a help request is doing
  // something they did not ask for. Exits 0: asking for help is not an error.
  //
  // stdout, not stderr: this is the requested output, and a user piping it to a
  // pager or grep should get it on the stream that carries results.
  if (cli.help) {
    const { renderCliHelp } = await import("./transport/cli.js");
    process.stdout.write(renderCliHelp());
    return;
  }

  // `setup <agent>`: write the comfyui MCP entry into a non-Claude harness's
  // config (Hermes Agent / OpenClaw / Copilot CLI — issue #97), print next
  // steps, and exit. Never starts the MCP server.
  if (cli.setupAgent !== undefined) {
    const { setupAgent, AGENT_NAMES } = await import("./services/agent-setup.js");
    const agent = cli.setupAgent as (typeof AGENT_NAMES)[number];
    if (!AGENT_NAMES.includes(agent)) {
      process.stderr.write(
        `\nUsage: comfyui-mcp setup <${AGENT_NAMES.join("|")}> [--compact|--full] [--comfyui-url <url>] [--dry-run]\n` +
          (cli.setupAgent ? `\nUnknown agent "${cli.setupAgent}".\n` : "") +
          `\nWrites the comfyui MCP server entry into the agent's own config file.\n`,
      );
      process.exit(1);
    }
    try {
      const result = await setupAgent({
        agent,
        compact: cli.toolModeExplicit ? cli.toolMode === "compact" : undefined,
        comfyuiUrl: cli.comfyuiUrl,
        dryRun: cli.setupDryRun,
      });
      const lines = [
        "",
        result.wrote
          ? `✓ Added the "comfyui" MCP server to ${result.configPath}`
          : `— dry run: would write ${result.configPath} as —`,
        ...(result.wrote ? [] : ["", result.content.trimEnd()]),
        "",
        "Next steps:",
        ...result.nextSteps.map((s) => `  • ${s}`),
        "",
      ];
      process.stdout.write(lines.join("\n"));
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `\ncomfyui-mcp setup failed: ${err instanceof Error ? err.message : err}\n`,
      );
      process.exit(1);
    }
  }

  // Standalone background orchestrator: owns the UI bridge and drives the panel
  // with autonomous Agent SDK sessions. Not an MCP server — it never returns.
  if (cli.panelOrchestrator) {
    // `connect <comfyui-url>`: drive a (possibly REMOTE) ComfyUI from an agent on
    // THIS machine. Export the URL as COMFYUI_URL so the orchestrator and the
    // comfyui MCP it spawns target that server — the same remote-URL mechanism the
    // panel's "Remote ComfyUI URL" setting uses, just from the CLI. For a REMOTE
    // https pod the orchestrator auto-opens a secure wss:// Cloudflare tunnel so
    // the pod's HTTPS panel can reach the bridge (a plain ws:// from https is
    // browser-blocked); --insecure-bridge forces the plain loopback bridge.
    if (cli.insecureBridge) process.env.COMFYUI_MCP_INSECURE_BRIDGE = "1";
    // #667: an explicit --full/--compact must reach the orchestrator's spawned
    // MCP children, which read the mode from the ENV — the flag alone never
    // made it downstream, silently running compact when full was requested.
    exportExplicitToolMode(cli);
    if (cli.comfyuiUrl) {
      // Hard-fail on a bad `connect <url>` instead of silently falling back to the
      // local ComfyUI (which would make the banner below lie about what it drives).
      const urlError = validateConnectUrl(cli.comfyuiUrl);
      if (urlError) {
        process.stderr.write(`\nComfyUI MCP — cannot start: ${urlError}\n\n`);
        process.exit(1);
      }
      process.env.COMFYUI_URL = cli.comfyuiUrl;
      // Default panel bridge port is 9180 (one port shared by all providers);
      // COMFYUI_MCP_BRIDGE_PORT overrides.
      const bridgePort = Number(process.env.COMFYUI_MCP_BRIDGE_PORT) || 9180;
      // Remote https pod → secure wss:// tunnel (auto); local/http or
      // --insecure-bridge → plain loopback ws://. Informational only here.
      const secureBridge = !cli.insecureBridge && isRemoteHttpsPod(cli.comfyuiUrl);
      const bridgeLine = secureBridge
        ? " Agent bridge : wss:// secure Cloudflare tunnel (auto — nothing to copy)"
        : ` Agent bridge : ws://127.0.0.1:${bridgePort}`;
      process.stderr.write(
        [
          "",
          "════════════════════════════════════════════════════════════════════",
          " ComfyUI MCP — local agent bridge is starting",
          "════════════════════════════════════════════════════════════════════",
          bridgeLine,
          ` Driving      : ${cli.comfyuiUrl}`,
          secureBridge
            ? " Secure       : the pod's HTTPS panel connects automatically over an\n                encrypted tunnel — no URL to paste, works in any browser."
            : null,
          "",
          " Next steps:",
          `   1. Open that ComfyUI in your browser: ${cli.comfyuiUrl}`,
          "   2. In the Agent panel's Settings → General, turn ON",
          "      'Use external/local orchestrator (advanced)'.",
          "   3. Click Connect in the panel (the Agent panel's Connect dropdown).",
          "",
          " Until you click Connect this window stays quiet — that's expected, not",
          " a hang. The agent runs HERE on your Claude/Codex login; nothing is",
          " installed on the ComfyUI box. Keep this terminal open.",
          "════════════════════════════════════════════════════════════════════",
          "",
        ]
          .filter((l): l is string => l !== null)
          .join("\n"),
      );
    }
    const { runPanelOrchestrator } = await import("./orchestrator/index.js");
    await runPanelOrchestrator();
    return;
  }

  await JobWatcher.cleanupOldFiles();

  if (cli.transport === "http") {
    // In tunnel mode, require a token even if none was configured: the endpoint
    // is about to be exposed publicly, so generate a strong one on the fly.
    const token =
      cli.token ?? (cli.tunnel ? randomBytes(24).toString("hex") : undefined);

    await startHttpServer({
      host: cli.host,
      port: cli.port,
      token,
      allowUnauthenticated: cli.allowUnauthenticated,
      createServer: () => createConfiguredServer(cli.toolMode),
    });
    logger.info(`ComfyUI MCP server running on http://${cli.host}:${cli.port}/mcp`);
    if (token) {
      logger.info(
        `HTTP MCP auth ENABLED — send 'Authorization: Bearer <token>' or 'X-API-Key: <token>'.`,
      );
    }

    if (cli.tunnel) {
      await openTunnelAndAnnounce(cli.host, cli.port, token!);
    }
  } else {
    const server = await createConfiguredServer(cli.toolMode);
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
  // Error instances JSON-serialize to {} — log the message/stack explicitly so
  // a startup failure (e.g. the unauthenticated-non-loopback guard in Docker)
  // is actually debuggable from the console output.
  logger.error(
    `Fatal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
});
