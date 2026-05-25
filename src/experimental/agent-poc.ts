import { randomBytes, timingSafeEqual } from "node:crypto";
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
//
// Security: `/api/chat` requires a bearer token (auto-generated, or
// COMFYUI_MCP_AGENT_TOKEN) so a leaked tunnel URL alone cannot spend provider
// keys. Request bodies are size-capped. The model is chosen server-side
// (see provider-registry) — clients cannot pick arbitrary models.
// ---------------------------------------------------------------------------

export interface AgentPocOptions {
  port?: number;
  host?: string;
  /** Open a cloudflared quick tunnel and log the public URL. */
  tunnel?: boolean;
  /** Bearer token required on /api/chat. Auto-generated if omitted. */
  token?: string;
  /** Max accepted request body size in bytes for /api/chat (default 1 MiB). */
  maxBodyBytes?: number;
}

export interface AgentPocHandle {
  /** Local URL the chat server is listening on. */
  localUrl: string;
  /** Public tunnel URL, if a tunnel was opened. */
  publicUrl: string | null;
  /** Bearer token clients must send as `Authorization: Bearer <token>`. */
  token: string;
  stop(): Promise<void>;
}

const DEFAULT_PORT = 8765;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

class PayloadTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`Request body exceeds the ${limit}-byte limit`);
    this.name = "PayloadTooLargeError";
  }
}

interface RequestContext {
  host: string;
  port: number;
  token: string;
  maxBodyBytes: number;
}

/** Convert a Node IncomingMessage into a Fetch-style Request (body size-capped). */
async function toFetchRequest(
  req: IncomingMessage,
  ctx: RequestContext,
): Promise<Request> {
  const url = `http://${ctx.host}:${ctx.port}${req.url ?? "/"}`;
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
    let total = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      // Cap the body while reading so a huge/chunked POST can't exhaust memory
      // before JSON parsing (the server may be exposed via the tunnel).
      if (total > ctx.maxBodyBytes) {
        throw new PayloadTooLargeError(ctx.maxBodyBytes);
      }
      chunks.push(buf);
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

/** Constant-time `Authorization: Bearer <token>` check. */
function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers["authorization"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return false;
  const m = /^Bearer\s+(.+)$/i.exec(value.trim());
  if (!m) return false;
  const provided = Buffer.from(m[1].trim());
  const expected = Buffer.from(token);
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

/**
 * Start the experimental agent POC HTTP server (and optional tunnel).
 * Returns a handle (incl. the bearer token). Callers gate this behind the env flag.
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
  const token =
    options.token ??
    process.env.COMFYUI_MCP_AGENT_TOKEN ??
    randomBytes(24).toString("hex");
  const ctx: RequestContext = {
    host,
    port,
    token,
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res, ctx);
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
  logger.info(
    `[agent-poc] session token (send as 'Authorization: Bearer <token>'): ${token}`,
  );

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
    token,
    stop: async () => {
      tunnel?.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  // CORS: the tunnel + bearer token are the perimeter. `*` is safe here because
  // requests are non-credentialed and must carry the Authorization header below.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health probe stays open (no secret, no provider spend).
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // Everything past here requires the bearer token.
  if (!isAuthorized(req, ctx.token)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  if (req.method === "POST" && req.url === "/api/chat") {
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      res.writeHead(415, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: "Expected content-type: application/json" }),
      );
      return;
    }
    try {
      const request = await toFetchRequest(req, ctx);
      const response = await handleChatRequest(request);
      await sendFetchResponse(res, response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[agent-poc] /api/chat error: ${message}`);
      if (res.headersSent) {
        // Streaming already started — destroy the socket rather than corrupt
        // the stream protocol by appending a JSON error body to it.
        res.destroy(err instanceof Error ? err : new Error(message));
      } else if (err instanceof PayloadTooLargeError) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      } else {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      }
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
