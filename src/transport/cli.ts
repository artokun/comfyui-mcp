import { parseComfyUIUrl } from "./comfyui-url.js";

export type TransportMode = "stdio" | "http";

export interface CliOptions {
  transport: TransportMode;
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

  let transport: TransportMode = env.MCP_TRANSPORT === "http" ? "http" : "stdio";
  let host = env.MCP_HOST ?? DEFAULT_HOST;
  let port = env.MCP_PORT ? Number(env.MCP_PORT) : DEFAULT_PORT;
  let panelOrchestrator =
    env.COMFYUI_MCP_PANEL_ORCHESTRATOR === "1" ||
    env.COMFYUI_MCP_PANEL_ORCHESTRATOR === "true";
  let token = env.COMFYUI_MCP_HTTP_TOKEN?.trim() || undefined;
  let tunnel = env.MCP_TUNNEL === "1" || env.MCP_TUNNEL === "true";
  let allowUnauthenticated =
    env.COMFYUI_MCP_ALLOW_UNAUTH === "1" || env.COMFYUI_MCP_ALLOW_UNAUTH === "true";
  let comfyuiUrl: string | undefined;

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
    }
  }

  // --tunnel implies the HTTP transport: a cloudflared quick tunnel needs an
  // HTTP origin to point at. (Token auto-generation happens at startup, not
  // here, to keep this parser pure/side-effect-free.)
  if (tunnel) transport = "http";

  return { transport, host, port, panelOrchestrator, token, tunnel, allowUnauthenticated, comfyuiUrl };
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
