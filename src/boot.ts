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
import { tryInstallRetiredNameRedirect } from "./tools/retired-redirect.js";
import { logger } from "./utils/logger.js";
import { readPackageVersion } from "./utils/package-version.js";
import { JobWatcher } from "./services/job-watcher.js";
import { parseCliArgs, validateConnectUrl, exportExplicitToolMode, type ToolMode } from "./transport/cli.js";
import { startHttpServer } from "./transport/http.js";
import { resolveToolSurfacePolicy } from "./tools/tool-surface-filter.js";
import { isLocalMode } from "./config.js";
import { ensurePanelInstalled } from "./services/panel-installer.js";
import { checkAndSelfUpdate } from "./services/self-update.js";
import { tr } from "./i18n/index.js";
import { banner, labelRows, numberedSteps } from "./i18n/terminal-layout.js";

/**
 * Fire-and-forget: ensure the ComfyUI sidebar panel is installed (install-if-
 * missing) on MCP load. LOCAL-only, hard-timed-out, and never throws — it must
 * never block or crash startup. Opt out with COMFYUI_MCP_PANEL_AUTOINSTALL=0.
 * The explicit `install_comfyui(action:'panel', panel_action:'update')` tool refreshes nightly on demand.
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
              "Run install_comfyui(action:'panel', panel_action:'status') to compare it against what this build needs.",
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

/**
 * #1447 — THE VERSION WE ADVERTISE MUST BE THE VERSION WE ARE.
 *
 * This was hardcoded `0.1.0`, so every `initialize` response told the client a version
 * this package has never shipped. The reporter noticed while filing a bug about something
 * else, and that is exactly the cost: `serverInfo.version` is what a client shows and what
 * a bug report quotes, so a constant here makes every report ambiguous about which build
 * produced it — including the reports we ask people to send us.
 *
 * Resolution lives in `readPackageVersion` (utils/package-version.ts) — cheap enough to sit
 * on the handshake path, and testable by execution rather than by reading this file's text.
 *
 * Read ONCE at module load rather than per call: a running process cannot hot-swap its own
 * code, so a later read could only differ if the files changed underneath it — which would
 * report a version this process is not executing.
 */
const SERVER_VERSION: string = readPackageVersion();

async function createConfiguredServer(toolMode: ToolMode = "compact"): Promise<McpServer> {
  const server = new McpServer(
    {
      name: "comfyui-mcp",
      version: SERVER_VERSION,
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
    // issue #97), and the DEFAULT from #667 until 0.50.0, when it became the
    // OPT-IN: the reason it was default was that the direct surface cost
    // ~200KB (~50k tokens) per tools/list at 154 tools, and consolidation took
    // that to 37. Reach for `--compact` when the client's context is the
    // binding constraint — a small local model, or a harness that re-injects
    // tools/list on every read.
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

  // Serve the retirement ledger on the DIRECT tools/call path too, not only through
  // the call_tool facade — see src/tools/retired-redirect.ts. Installed here, after
  // BOTH branches, because both need it and for different reasons:
  //
  //  - full mode is the one the 0.50.0 flip (#726) makes the default, where 121
  //    retired names would otherwise answer with a bare "Tool X not found";
  //  - compact mode advertises only the 3 meta-tools, so a client calling a retired
  //    name DIRECTLY is exactly the stale-snapshot client the facade exists for (#616)
  //    — it holds a cached binding for a name this surface no longer lists, and the
  //    ledger is the only thing that can tell it where the capability went.
  //
  // Additive: a registered name, and any name the ledger does not know, dispatches
  // through the SDK unchanged. Deliberately BEFORE server.connect() (the callers
  // below connect the returned server), so no request can arrive mid-swap.
  //
  // The result is REPORTED rather than discarded. If it is false the server still
  // boots (see tryInstallRetiredNameRedirect for why bricking startup is the worse
  // failure), but "boots normally while silently answering 121 retired names with a
  // bare 404" is exactly the shape of failure this whole change exists to remove — so
  // it is stated on the same startup line an operator already reads to confirm the
  // surface came up, not left as one error line among registration noise.
  //
  // Residual risk, stated plainly rather than papered over: nothing here can make the
  // degraded state visible to the CALLER, because the wrapper is the only thing that
  // could have changed what the caller sees. What actually holds the guarantee is the
  // `~1.29.0` cap on `@modelcontextprotocol/sdk` in package.json — this is normally run
  // as `npx comfyui-mcp`, which resolves fresh, so an open range would have let a user
  // silently pick up internals nothing ever ran against.
  const redirects = await tryInstallRetiredNameRedirect(server);
  logger.info(
    `Tool mode: ${toolMode}. Retired-name redirects on direct tools/call: ` +
      (redirects
        ? "active"
        : "INACTIVE — a call to a name removed in an earlier release will 404 without naming its replacement"),
  );

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
    banner(`ComfyUI MCP — ${tr("cli.tunnel_title", "Remote / Hosted Connector is LIVE")}`, [
      ...labelRows(" ", [
        [tr("cli.tunnel_label_public_url", "Public MCP URL"), mcpUrl],
        [tr("cli.tunnel_label_token", "Auth token"), token],
      ]),
      "",
      // Names CLAUDE DESKTOP's own menu path, which is localised by Claude Desktop's
      // language setting and not by ours. The English fallback must keep matching that app's
      // English UI exactly; a catalog should only translate it to the wording Claude Desktop
      // itself uses in that language, never to a literal translation of these words.
      ` ${tr("cli.tunnel_desktop_connector_path", "Claude Desktop → Settings → Connectors → Add custom connector:")}`,
      // The header NAMES are wire protocol, not prose — only the row labels translate.
      ...labelRows("   • ", [
        [tr("cli.tunnel_field_name", "Name"), "ComfyUI"],
        [tr("cli.tunnel_field_url", "URL"), mcpUrl],
        [
          tr("cli.tunnel_field_header", "Header"),
          // The alternative is one phrase, not the word "or" plus a header name: a lone
          // conjunction is untranslatable without the sentence it sits in, and both header
          // spellings have to survive into every language byte-for-byte anyway.
          `X-API-Key: ${token}   ${tr("cli.tunnel_header_alt", "(or Authorization: Bearer {token})", { token })}`,
        ],
      ]),
      "",
      ` ${tr("cli.tunnel_headless_snippet", "Headless / programmatic config snippet:")}`,
      snippet,
      "",
      ` ${tr("cli.tunnel_keep_open", "Keep this terminal open — the tunnel closes when the process exits.")}`,
    ]),
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
      // Only the prose translates. The command itself is passed in as a variable rather than
      // spliced around a translated "Usage" label, so what the user has to type back stays
      // verbatim in every language — including the agent names, which are the literal values
      // the parser matches on.
      const usage = `comfyui-mcp setup <${AGENT_NAMES.join("|")}> [--compact|--full] [--comfyui-url <url>] [--dry-run]`;
      process.stderr.write(
        `\n${tr("cli.setup_usage", "Usage: {command}", { command: usage })}\n` +
          (cli.setupAgent
            ? `\n${tr("cli.setup_unknown_agent", 'Unknown agent "{agent}".', { agent: cli.setupAgent })}\n`
            : "") +
          `\n${tr("cli.setup_what_it_does", "Writes the comfyui MCP server entry into the agent's own config file.")}\n`,
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
          ? tr("cli.setup_wrote", '✓ Added the "comfyui" MCP server to {path}', {
              path: result.configPath,
            })
          : tr("cli.setup_dry_run", "— dry run: would write {path} as —", {
              path: result.configPath,
            }),
        ...(result.wrote ? [] : ["", result.content.trimEnd()]),
        "",
        tr("cli.setup_next_steps", "Next steps:"),
        ...result.nextSteps.map((s) => `  • ${s}`),
        "",
      ];
      process.stdout.write(lines.join("\n"));
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `\n${tr("cli.setup_failed", "comfyui-mcp setup failed: {error}", {
          error: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
      process.exit(1);
    }
  }

  // #873 — VALIDATE THE OPERATOR'S TOOL POLICY BEFORE ANY SERVER STARTS, of any kind.
  //
  // resolveToolSurfacePolicy() throws on a misconfiguration (an unknown preset, a variable
  // set but empty) with a message that says "Refusing to start". Making that true took two
  // corrections, both the same mistake:
  //
  //   - On --transport http the server is built LAZILY inside the request handler, so the
  //     socket bound, "running on http://…" printed, and every initialize came back 500
  //     with the reason buried in a log line.
  //   - Moving the call above the http branch left --panel-orchestrator, which returns
  //     BELOW me and never came back. A typo'd preset there started the bridge, the
  //     loopback panel MCP and the console, printed the ready banner, and only threw later
  //     at first use — inside a request handler, per session.
  //
  // Both times the fix was placed at the first spot that satisfied the case in front of me
  // rather than at the point every path passes through. This is that point: above every
  // branch that starts anything.
  resolveToolSurfacePolicy();

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
        process.stderr.write(
          `\n${tr("cli.cannot_start", "ComfyUI MCP — cannot start: {error}", { error: urlError })}\n\n`,
        );
        process.exit(1);
      }
      process.env.COMFYUI_URL = cli.comfyuiUrl;
      // Default panel bridge port is 9180 (one port shared by all providers);
      // COMFYUI_MCP_BRIDGE_PORT overrides.
      const bridgePort = Number(process.env.COMFYUI_MCP_BRIDGE_PORT) || 9180;
      // Remote https pod → secure wss:// tunnel (auto); local/http or
      // --insecure-bridge → plain loopback ws://. Informational only here.
      const secureBridge = !cli.insecureBridge && isRemoteHttpsPod(cli.comfyuiUrl);
      const bridgeValue = secureBridge
        ? tr("cli.connect_bridge_secure", "wss:// secure Cloudflare tunnel (auto — nothing to copy)")
        : `ws://127.0.0.1:${bridgePort}`;
      // Every string below that NAMES A PANEL CONTROL keeps its English fallback exactly as
      // the panel renders it in English today, and says so in its key. The panel's own labels
      // are being translated separately; until a catalog carries both, an English fallback is
      // the only wording that still matches the button the user has to find. A catalog entry
      // for one of these keys is only correct if it uses the panel's translation of that
      // control, not a fresh translation of the sentence.
      // There used to be a step here telling the user to turn ON "Use external/local
      // orchestrator (advanced)" in the panel's Settings → General. That control does not
      // exist. The panel declares the setting id and never registers a row for it, and
      // `externalOrchestratorMode()` returns true unconditionally — its own comment calls the
      // setting "a back-compat no-op", because a Registry-compliant pure-frontend pack can no
      // longer spawn the orchestrator, so external/local is the only mode there is. The step
      // therefore sent people hunting for a toggle that isn't there, to enable something that
      // cannot be turned off. It had just been translated into eleven languages, which is how
      // it surfaced: faithfully wrong in twelve.
      const steps = [
        tr("cli.connect_step_open_comfyui", "Open that ComfyUI in your browser: {url}", {
          url: cli.comfyuiUrl,
        }),
        tr(
          "cli.connect_step_click_connect",
          "Click Connect in the panel (the Agent panel's Connect dropdown).",
        ),
      ];
      process.stderr.write(
        banner(`ComfyUI MCP — ${tr("cli.connect_title", "local agent bridge is starting")}`, [
          ...labelRows(" ", [
            [tr("cli.connect_label_bridge", "Agent bridge"), bridgeValue],
            [tr("cli.connect_label_driving", "Driving"), cli.comfyuiUrl],
            ...(secureBridge
              ? ([
                  [
                    tr("cli.connect_label_secure", "Secure"),
                    tr(
                      "cli.connect_secure_note",
                      "the pod's HTTPS panel connects automatically over an\nencrypted tunnel — no URL to paste, works in any browser.",
                    ),
                  ],
                ] as const)
              : []),
          ]),
          "",
          ` ${tr("cli.connect_next_steps", "Next steps:")}`,
          ...numberedSteps(steps),
          "",
          ...tr(
            "cli.connect_quiet_note",
            "Until you click Connect this window stays quiet — that's expected, not\n" +
              "a hang. The agent runs HERE on your Claude/Codex login; nothing is\n" +
              "installed on the ComfyUI box. Keep this terminal open.",
          )
            .split("\n")
            .map((l) => ` ${l}`),
        ]),
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
