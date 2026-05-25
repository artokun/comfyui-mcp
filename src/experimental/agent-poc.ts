import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { logger } from "../utils/logger.js";
import { handleChatRequest } from "./chat-handler.js";
import { startQuickTunnel, type QuickTunnel } from "../services/tunnel.js";

// ---------------------------------------------------------------------------
// Experimental entry point for the embedded-agent-panel POC.
//
// Starts a tiny HTTP server hosting `POST /api/chat` (AI SDK stream) and a
// `GET /health` probe, and OPTIONALLY opens a cloudflared quick tunnel so a
// remote / HTTPS ComfyUI page can reach it (solves mixed-content + remote
// installs — see design/embedded-agent-panel.md).
//
// This is gated behind COMFYUI_MCP_AGENT_POC=1 and is invoked from a separate
// module. It MUST NOT run during normal MCP startup or tests.
// ---------------------------------------------------------------------------

export interface AgentPocOptions {
  port?: number;
  host?: string;
  /** Open a cloudflared quick tunnel and log the public URL. */
  tunnel?: boolean;
}

export interface AgentPocHandle {
  /** Local URL the chat server is listening on. */
  localUrl: string;
  /** Public tunnel URL, if a tunnel was opened. */
  publicUrl: string | null;
  stop(): Promise<void>;
}

const DEFAULT_PORT = 8765;
const DEFAULT_HOST = "127.0.0.1";

/** Convert a Node IncomingMessage into a Fetch-style Request. */
async function toFetchRequest(
  req: IncomingMessage,
  host: string,
  port: number,
): Promise<Request> {
  const url = `http://${host}:${port}${req.url ?? "/"}`;
  const method = req.method ?? "GET";

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  const hasBody = method !== "GET" && method !== "HEAD";
  let body: string | undefined;
  if (hasBody) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    body = Buffer.concat(chunks).toString("utf-8");
  }

  return new Request(url, { method, headers, body });
}

/** Pipe a Fetch-style Response into a Node ServerResponse. */
async function sendFetchResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);

  if (response.body) {
    // response.body is a web ReadableStream; bridge it to the Node response.
    // Await pipeline so downstream/stream errors (e.g. client disconnect mid-
    // stream) reject here instead of surfacing as an unhandled 'error' event.
    const source = Readable.fromWeb(
      response.body as Parameters<typeof Readable.fromWeb>[0],
    );
    await pipeline(source, res);
  } else {
    res.end(await response.text());
  }
}

/**
 * Start the experimental agent POC HTTP server (and optional tunnel).
 * Returns a handle for shutdown. Callers gate this behind the env flag.
 */
export async function startAgentPoc(
  options: AgentPocOptions = {},
): Promise<AgentPocHandle> {
  const envPort = process.env.COMFYUI_MCP_AGENT_PORT
    ? Number(process.env.COMFYUI_MCP_AGENT_PORT)
    : undefined;
  const port =
    options.port ?? (envPort && !Number.isNaN(envPort) ? envPort : DEFAULT_PORT);
  const host = options.host ?? DEFAULT_HOST;

  const server = createServer((req, res) => {
    void handleRequest(req, res, host, port);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const localUrl = `http://${host}:${port}`;
  logger.info(`[agent-poc] chat server listening on ${localUrl}/api/chat`);

  let tunnel: QuickTunnel | null = null;
  if (options.tunnel) {
    try {
      tunnel = await startQuickTunnel(port);
      logger.info(`[agent-poc] public URL: ${tunnel.url}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[agent-poc] failed to open tunnel: ${message}`);
    }
  }

  return {
    localUrl,
    publicUrl: tunnel?.url ?? null,
    stop: async () => {
      tunnel?.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  host: string,
  port: number,
): Promise<void> {
  // CORS open: the tunnel is the perimeter (per the design's security model).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.method === "POST" && req.url === "/api/chat") {
    try {
      const request = await toFetchRequest(req, host, port);
      const response = await handleChatRequest(request);
      await sendFetchResponse(res, response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[agent-poc] /api/chat error: ${message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

/**
 * Gated bootstrap. Only starts the POC when COMFYUI_MCP_AGENT_POC is truthy.
 * Safe to call unconditionally from a side entry; a no-op otherwise.
 */
export async function maybeStartAgentPoc(): Promise<AgentPocHandle | null> {
  if (!process.env.COMFYUI_MCP_AGENT_POC) {
    return null;
  }
  return startAgentPoc({
    tunnel: process.env.COMFYUI_MCP_AGENT_TUNNEL === "1",
  });
}
