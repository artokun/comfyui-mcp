export type TransportMode = "stdio" | "http";

export interface CliOptions {
  transport: TransportMode;
  host: string;
  port: number;
  /** --channels: start the UI bridge + register panel_* tools so the user's
   *  own agent session drives the ComfyUI sidebar panel (no LLM API keys). */
  channels: boolean;
  /** --panel-orchestrator: run the standalone background orchestrator that owns
   *  the UI bridge and drives the panel with autonomous Agent SDK sessions
   *  (subscription auth, no API key). Mutually exclusive with the MCP server. */
  panelOrchestrator: boolean;
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
  let channels = env.COMFYUI_MCP_CHANNELS === "1" || env.COMFYUI_MCP_CHANNELS === "true";
  let panelOrchestrator =
    env.COMFYUI_MCP_PANEL_ORCHESTRATOR === "1" ||
    env.COMFYUI_MCP_PANEL_ORCHESTRATOR === "true";

  const valueOf = (current: string, inline: string, i: number): [string, number] => {
    if (current.includes("=")) return [current.slice(current.indexOf("=") + 1), i];
    return [args[i + 1] ?? "", i + 1];
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--http") {
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
    } else if (a === "--channels") {
      channels = true;
    } else if (a === "--no-channels") {
      channels = false;
    } else if (a === "--panel-orchestrator") {
      panelOrchestrator = true;
    }
  }

  return { transport, host, port, channels, panelOrchestrator };
}
