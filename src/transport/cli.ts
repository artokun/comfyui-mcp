import { parseComfyUIUrl } from "./comfyui-url.js";

export type TransportMode = "stdio" | "http";
export type ToolMode = "full" | "compact";

export interface CliOptions {
  /** --help / -h: print usage and exit WITHOUT starting a server. There was no
   *  help flag at all, so nothing at the CLI taught `--compact` / `--full` —
   *  and compact became the DEFAULT in #667, meaning the behaviour changed under
   *  users with no local way to discover the flag that controls it (#860). */
  help: boolean;
  transport: TransportMode;
  /** --compact / --tool-mode compact / COMFYUI_MCP_TOOL_MODE=compact (DEFAULT,
   *  #667): register only the list_tools/describe_tool/call_tool meta-tools
   *  instead of the full ~200-schema surface — the full surface costs a client
   *  ~200KB (~50k tokens) per tools/list, which harnesses that inject schemas
   *  into context pay on every read. --full / COMFYUI_MCP_TOOL_MODE=full opts
   *  back into the classic surface (frontier-model harnesses). */
  toolMode: ToolMode;
  host: string;
  port: number;
  /** --panel-orchestrator: run the standalone background orchestrator that owns
   *  the UI bridge and drives the panel with autonomous Agent SDK sessions
   *  (subscription auth, no API key). Mutually exclusive with the MCP server. */
  panelOrchestrator: boolean;
  /** Shared-secret token required on the HTTP /mcp endpoint when set
   *  (COMFYUI_MCP_HTTP_TOKEN). Undefined → endpoint is open (local default). */
  token?: string;
  /** --tunnel / MCP_TUNNEL=1: force http transport, auto-generate a token if
   *  none set, and open a cloudflared quick tunnel to the local port so the
   *  /mcp endpoint is reachable as a hosted/remote Custom Connector. */
  tunnel: boolean;
  /** --allow-unauthenticated-non-loopback / COMFYUI_MCP_ALLOW_UNAUTH=1: opt into
   *  an OPEN /mcp endpoint on a non-loopback host (otherwise a hard fail). */
  allowUnauthenticated: boolean;
  /** ComfyUI target URL captured from the `connect <comfyui-url>` subcommand.
   *  When set, startup exports it as COMFYUI_URL so the panel orchestrator drives
   *  that (possibly REMOTE, e.g. RunPod) ComfyUI from the agent running on THIS
   *  machine — no Node/agent needed on the ComfyUI box. Undefined when `connect`
   *  wasn't used (or used without a URL). `connect` also implies panelOrchestrator. */
  comfyuiUrl?: string;
  /** `setup <agent>` subcommand: merge a ready-to-run comfyui server entry into
   *  a non-Claude harness's own config file (hermes | openclaw | copilot), then
   *  exit — never starts the MCP server. Issue #97. */
  setupAgent?: string;
  /** --dry-run (setup only): print the merged config instead of writing it. */
  setupDryRun: boolean;
  /** Whether --compact/--tool-mode was passed explicitly (vs defaulted): lets
   *  `setup` distinguish "user chose a mode" from "use the per-agent default". */
  toolModeExplicit: boolean;
  /** --insecure-bridge / COMFYUI_MCP_INSECURE_BRIDGE=1: force the plain loopback
   *  `ws://127.0.0.1:<port>` bridge even when driving a REMOTE https ComfyUI.
   *  By default a remote-https target auto-upgrades the bridge to a token-gated
   *  `wss://` (cloudflared quick tunnel) so the pod's HTTPS panel page can reach
   *  it (a plain ws:// from https is blocked by the browser). Use this if you run
   *  your own SSH tunnel / reverse proxy and don't want a Cloudflare tunnel. */
  insecureBridge: boolean;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9100;

/**
 * Parse transport-related CLI flags and env vars. stdio is the default so
 * existing Claude Code / Desktop users are unaffected; --http opts into the
 * streamable-HTTP server. Supports both "--flag value" and "--flag=value".
 *
 * Precedence: explicit CLI flag > env var > built-in default.
 */
export function parseCliArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
  const args = argv.slice(2);

  let help = false;
  let transport: TransportMode = env.MCP_TRANSPORT === "http" ? "http" : "stdio";
  let toolMode: ToolMode = env.COMFYUI_MCP_TOOL_MODE === "full" ? "full" : "compact";
  let host = env.MCP_HOST ?? DEFAULT_HOST;
  let port = env.MCP_PORT ? Number(env.MCP_PORT) : DEFAULT_PORT;
  let panelOrchestrator =
    env.COMFYUI_MCP_PANEL_ORCHESTRATOR === "1" ||
    env.COMFYUI_MCP_PANEL_ORCHESTRATOR === "true";
  let token = env.COMFYUI_MCP_HTTP_TOKEN?.trim() || undefined;
  let tunnel = env.MCP_TUNNEL === "1" || env.MCP_TUNNEL === "true";
  let allowUnauthenticated =
    env.COMFYUI_MCP_ALLOW_UNAUTH === "1" || env.COMFYUI_MCP_ALLOW_UNAUTH === "true";
  let insecureBridge =
    env.COMFYUI_MCP_INSECURE_BRIDGE === "1" || env.COMFYUI_MCP_INSECURE_BRIDGE === "true";
  let comfyuiUrl: string | undefined;
  let setupAgent: string | undefined;
  let setupDryRun = false;
  let toolModeExplicit =
    env.COMFYUI_MCP_TOOL_MODE === "compact" || env.COMFYUI_MCP_TOOL_MODE === "full";

  const valueOf = (current: string, inline: string, i: number): [string, number] => {
    if (current.includes("=")) return [current.slice(current.indexOf("=") + 1), i];
    return [args[i + 1] ?? "", i + 1];
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "connect") {
      // `comfyui-mcp connect <comfyui-url>` — one-command local connect: run the
      // panel orchestrator (subscription auth, no API key) and point it at the
      // given ComfyUI via COMFYUI_URL. The URL is the next positional token (a
      // following "--flag" is left to be parsed normally). With no URL it's just
      // sugar for --panel-orchestrator (local default / inherited COMFYUI_URL).
      panelOrchestrator = true;
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        comfyuiUrl = next;
        i += 1; // consume the URL token
      }
    } else if (a === "--help" || a === "-h") {
      help = true;
    } else if (a === "--http") {
      transport = "http";
    } else if (a === "--stdio") {
      transport = "stdio";
    } else if (a === "--transport" || a.startsWith("--transport=")) {
      const [v, ni] = valueOf(a, "--transport", i);
      transport = v === "http" ? "http" : "stdio";
      i = ni;
    } else if (a === "--host" || a.startsWith("--host=")) {
      const [v, ni] = valueOf(a, "--host", i);
      if (v) host = v;
      i = ni;
    } else if (a === "--port" || a.startsWith("--port=")) {
      const [v, ni] = valueOf(a, "--port", i);
      if (v) port = Number(v);
      i = ni;
    } else if (a === "--panel-orchestrator") {
      panelOrchestrator = true;
    } else if (a === "--token" || a.startsWith("--token=")) {
      const [v, ni] = valueOf(a, "--token", i);
      if (v) token = v;
      i = ni;
    } else if (a === "--tunnel") {
      tunnel = true;
    } else if (a === "--allow-unauthenticated-non-loopback") {
      allowUnauthenticated = true;
    } else if (a === "--insecure-bridge") {
      insecureBridge = true;
    } else if (a === "--compact") {
      toolMode = "compact";
      toolModeExplicit = true;
    } else if (a === "--full") {
      toolMode = "full";
      toolModeExplicit = true;
    } else if (a === "--tool-mode" || a.startsWith("--tool-mode=")) {
      const [v, ni] = valueOf(a, "--tool-mode", i);
      toolMode = v === "full" ? "full" : "compact";
      toolModeExplicit = true;
      i = ni;
    } else if (a === "setup") {
      // `comfyui-mcp setup <agent>` — write the comfyui MCP entry into a
      // non-Claude harness's config (hermes | openclaw | copilot) and exit.
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        setupAgent = next;
        i += 1;
      } else {
        setupAgent = ""; // present but missing the agent → index.ts prints usage
      }
    } else if (a === "--dry-run") {
      setupDryRun = true;
    } else if (a === "--comfyui-url" || a.startsWith("--comfyui-url=")) {
      // Also parsed by config.ts for the server itself; captured here so
      // `setup` can embed it into the generated harness config.
      const [v, ni] = valueOf(a, "--comfyui-url", i);
      if (v) comfyuiUrl = v;
      i = ni;
    }
  }

  // --tunnel implies the HTTP transport: a cloudflared quick tunnel needs an
  // HTTP origin to point at. (Token auto-generation happens at startup, not
  // here, to keep this parser pure/side-effect-free.)
  if (tunnel) transport = "http";

  return {
    help,
    transport,
    toolMode,
    toolModeExplicit,
    host,
    port,
    panelOrchestrator,
    token,
    tunnel,
    allowUnauthenticated,
    comfyuiUrl,
    insecureBridge,
    setupAgent,
    setupDryRun,
  };
}

/**
 * Propagate an explicitly-chosen tool mode into the process environment so the
 * panel orchestrator's spawned MCP children inherit it (#667). Children read
 * the mode from the ENV (resolveHttpLaneComfyToolMode for the HTTP lane,
 * comfyuiSpawnEnv for the Ollama family) — a bare --full/--compact flag
 * otherwise never reaches them, so `--full --panel-orchestrator` silently ran
 * compact downstream. A DEFAULTED mode is deliberately NOT exported: unset env
 * is how children tell "user chose nothing" from "user chose compact", and
 * unset resolves to the documented compact default on its own.
 */
export function exportExplicitToolMode(
  cli: Pick<CliOptions, "toolMode" | "toolModeExplicit">,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (cli.toolModeExplicit) env.COMFYUI_MCP_TOOL_MODE = cli.toolMode;
}

/**
 * Validate the `connect <comfyui-url>` positional before the orchestrator starts.
 * The URL is exported as COMFYUI_URL and used to drive a (possibly remote)
 * ComfyUI, so a bad value (e.g. `connect not-a-url`) must hard-fail instead of
 * silently falling back to the local default — which would leave the startup
 * banner claiming it's "Driving <bad url>" while actually targeting localhost.
 *
 * Reuses parseComfyUIUrl (the same parser COMFYUI_URL / --comfyui-url use) so the
 * accept/reject rules stay identical. Returns a clear, actionable error message
 * when the URL is invalid, or null when it parses cleanly.
 */
export function validateConnectUrl(url: string): string | null {
  try {
    parseComfyUIUrl(url);
    return null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return (
      `Invalid ComfyUI URL passed to \`connect\`: "${url}" (${reason}). ` +
      `Pass a full http(s) URL, e.g. https://abcd-8188.proxy.runpod.net or http://127.0.0.1:8188.`
    );
  }
}

/**
 * Usage text for `--help` / `-h`.
 *
 * Every default shown is DERIVED by parsing an empty argv against an empty env,
 * not restated. That is the whole point: a hand-written default is a claim that
 * drifts the moment the parser changes, and this repo has just spent a release
 * cycle on documentation that confidently asserted the opposite of the code —
 * `.env.example` said the tool mode defaulted to `full` when #667 had made it
 * `compact`, and a user reading it configured the reverse of what they wanted.
 * Deriving makes that class of drift impossible rather than unlikely.
 *
 * Deliberately carries NO tool COUNT. RFC #726 consolidates the surface to ~30
 * tools, so any number written here expires; the text describes the shapes
 * instead ("three meta-tools" is a property of the facade, not a census).
 */
export function renderCliHelp(): string {
  const d = parseCliArgs([], {});
  const def = (v: string | number | boolean) => `(default: ${String(v)})`;

  return [
    "",
    "comfyui-mcp — drive ComfyUI from an AI agent",
    "",
    "USAGE",
    "  comfyui-mcp [options]                      start the MCP server",
    "  comfyui-mcp connect [<comfyui-url>]        run the panel orchestrator against a (possibly remote) ComfyUI",
    "  comfyui-mcp setup <hermes|openclaw|copilot> [--compact|--full] [--comfyui-url <url>] [--dry-run]",
    "                                             write the comfyui entry into that harness's config, then exit",
    "",
    "TOOL SURFACE",
    `  --compact                                  register only the three meta-tools ${def(d.toolMode === "compact")}`,
    "                                             (list_tools / describe_tool / call_tool)",
    "  --full                                     register the full direct tool surface",
    "  --tool-mode <compact|full>                 same, as a value",
    `                                             env: COMFYUI_MCP_TOOL_MODE      ${def(d.toolMode)}`,
    "",
    "TRANSPORT",
    `  --stdio                                    stdio transport ${def(d.transport === "stdio")}`,
    "  --http                                     streamable-HTTP transport",
    "  --transport <stdio|http>                   same, as a value    env: MCP_TRANSPORT",
    `  --host <host>                              HTTP bind host      env: MCP_HOST   ${def(d.host)}`,
    `  --port <port>                              HTTP bind port      env: MCP_PORT   ${def(d.port)}`,
    "  --token <token>                            require this shared secret on /mcp   env: COMFYUI_MCP_HTTP_TOKEN",
    "  --tunnel                                   open a cloudflared quick tunnel (implies --http)   env: MCP_TUNNEL",
    "  --allow-unauthenticated-non-loopback       allow an OPEN /mcp on a non-loopback host",
    "",
    "PANEL / COMFYUI",
    "  --panel-orchestrator                       run the background orchestrator that drives the panel",
    "  --comfyui-url <url>                        target a specific (incl. remote) ComfyUI   env: COMFYUI_URL",
    "  --insecure-bridge                          allow an unauthenticated panel bridge",
    "",
    "  -h, --help                                 show this and exit",
    "",
    "Full reference: https://github.com/artokun/comfyui-mcp#readme",
    "",
  ].join("\n");
}
