import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../utils/logger.js";

export interface HttpServerOptions {
  host: string;
  port: number;
  /** Factory invoked once per session to build a fully-configured McpServer. */
  createServer: () => Promise<McpServer> | McpServer;
  /** Path the MCP endpoint is served on (default /mcp). */
  path?: string;
  /**
   * Optional shared-secret token. When set, EVERY request to the MCP endpoint
   * must present it as `Authorization: Bearer <token>` OR `X-API-Key: <token>`
   * (the latter matches Comfy Cloud's convention); missing/wrong → 401. When
   * unset, the endpoint is open (preserves the existing local stdio/http use).
   */
  token?: string;
  /**
   * Escape hatch for the "non-loopback host without a token" safety gate. By
   * default, binding a non-loopback host (anything but 127.0.0.1/::1/localhost)
   * with NO token is a HARD FAIL — an open MCP endpoint reachable off-box is a
   * footgun next to the tunnel/hosted path. Set this (via
   * `--allow-unauthenticated-non-loopback` / `COMFYUI_MCP_ALLOW_UNAUTH=1`) to
   * downgrade the failure to a warning and start anyway.
   */
  allowUnauthenticated?: boolean;
  /**
   * Close a session after this many milliseconds with no request. A session is
   * otherwise kept until the client sends DELETE, and every session holds its
   * own McpServer, so clients that never send DELETE (gateways, health probes,
   * crashed agents) grow memory without bound. A session with a request in
   * flight or an open GET/SSE stream is never closed. 0 disables expiry.
   * Default: DEFAULT_SESSION_IDLE_MS (env COMFYUI_MCP_SESSION_IDLE_MS).
   */
  sessionIdleMs?: number;
}

/** Default idle window before an HTTP MCP session is closed: 30 minutes. */
export const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;

/**
 * Parse COMFYUI_MCP_SESSION_IDLE_MS. Unset or not a non-negative number →
 * the default (a typo never turns expiry off); "0" disables expiry.
 */
export function parseSessionIdleMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_SESSION_IDLE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SESSION_IDLE_MS;
}

// Hostnames that keep traffic on the local machine. Anything else (including
// 0.0.0.0, which binds all interfaces) is reachable off-box, so an unset token
// there is a hard failure unless explicitly allowed.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

/**
 * Constant-time comparison of the presented credential against the configured
 * token. Reads `Authorization: Bearer <token>` first, then `X-API-Key`. Returns
 * true iff exactly one matches; the length-guard keeps timingSafeEqual from
 * throwing on mismatched lengths while staying constant-time per-comparison.
 */
function isAuthorized(req: http.IncomingMessage, token: string): boolean {
  const expected = Buffer.from(token);
  const candidates: string[] = [];

  const authHeader = req.headers["authorization"];
  const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) candidates.push(m[1].trim());
  }

  const apiKeyHeader = req.headers["x-api-key"];
  const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  if (apiKey) candidates.push(apiKey.trim());

  for (const candidate of candidates) {
    const provided = Buffer.from(candidate);
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return true;
    }
  }
  return false;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (raw.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJsonError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  );
}

/**
 * Start a streamable-HTTP MCP server using the canonical SDK session pattern:
 * a new transport + McpServer is created on the initialize request and reused
 * for subsequent requests carrying the mcp-session-id header.
 */
export async function startHttpServer(opts: HttpServerOptions): Promise<http.Server> {
  const path = opts.path ?? "/mcp";
  const token = opts.token?.trim() || undefined;
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const idleMs = opts.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  // Per session: when its last request ended, and how many are still open
  // (an open GET/SSE stream counts until it closes).
  const lastSeen = new Map<string, number>();
  const openRequests = new Map<string, number>();

  if (!token && !LOOPBACK_HOSTS.has(opts.host.toLowerCase())) {
    if (!opts.allowUnauthenticated) {
      throw new Error(
        `Refusing to start: HTTP MCP transport bound on non-loopback host ${opts.host} ` +
          `WITHOUT an auth token — the /mcp endpoint would be OPEN to anyone who can reach ` +
          `this host. Fix one of:\n` +
          `  • set COMFYUI_MCP_HTTP_TOKEN=<secret> (recommended), or\n` +
          `  • use --tunnel (auto-generates a token), or\n` +
          `  • bind a loopback host (--host 127.0.0.1), or\n` +
          `  • explicitly opt into an open endpoint with ` +
          `--allow-unauthenticated-non-loopback (env COMFYUI_MCP_ALLOW_UNAUTH=1).`,
      );
    }
    logger.warn(
      `HTTP MCP transport bound on non-loopback host ${opts.host} WITHOUT an auth token — ` +
        `the /mcp endpoint is OPEN to anyone who can reach this host ` +
        `(allowed via --allow-unauthenticated-non-loopback / COMFYUI_MCP_ALLOW_UNAUTH).`,
    );
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname !== path) {
        sendJsonError(res, 404, `Not found. MCP endpoint is ${path}`);
        return;
      }

      // Auth gate: only enforced when a token is configured. Unset → open
      // (unchanged legacy behavior). Applies to every method on the endpoint.
      if (token && !isAuthorized(req, token)) {
        sendJsonError(res, 401, "Unauthorized: missing or invalid token");
        return;
      }

      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;
      if (sessionId && transport) {
        lastSeen.set(sessionId, Date.now());
        openRequests.set(sessionId, (openRequests.get(sessionId) ?? 0) + 1);
        res.on("close", () => {
          lastSeen.set(sessionId, Date.now());
          openRequests.set(sessionId, Math.max(0, (openRequests.get(sessionId) ?? 1) - 1));
        });
      }

      if (req.method === "POST") {
        const body = await readBody(req);
        if (!transport) {
          if (!isInitializeRequest(body)) {
            sendJsonError(res, 400, "No valid session: first request must be an initialize request");
            return;
          }
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transports.set(sid, transport!);
              lastSeen.set(sid, Date.now());
              logger.info("HTTP MCP session initialized", { session: sid });
            },
          });
          transport.onclose = () => {
            const sid = transport!.sessionId;
            if (sid) {
              transports.delete(sid);
              lastSeen.delete(sid);
              openRequests.delete(sid);
            }
          };
          const server = await opts.createServer();
          await server.connect(transport);
        }
        await transport.handleRequest(req, res, body);
      } else if (req.method === "GET" || req.method === "DELETE") {
        if (!transport) {
          sendJsonError(res, 400, "Missing or unknown mcp-session-id");
          return;
        }
        await transport.handleRequest(req, res);
      } else {
        sendJsonError(res, 405, "Method not allowed");
      }
    } catch (err) {
      logger.error("HTTP MCP request error", {
        error: err instanceof Error ? err.message : err,
      });
      if (!res.headersSent) sendJsonError(res, 500, "Internal server error");
    }
  });

  // Started only once the server is going to run (after the safety gate).
  let reaper: NodeJS.Timeout | undefined;
  if (idleMs > 0) {
    reaper = setInterval(
      () => {
        const now = Date.now();
        for (const [sid, t] of transports) {
          if ((openRequests.get(sid) ?? 0) > 0) continue;
          if (now - (lastSeen.get(sid) ?? now) > idleMs) {
            logger.info("HTTP MCP session expired (idle)", { session: sid });
            // transport.onclose removes it from the maps.
            t.close().catch(() => {});
          }
        }
      },
      Math.min(60_000, Math.max(1_000, Math.floor(idleMs / 2))),
    );
    reaper.unref();
  }

  httpServer.on("close", () => {
    if (reaper) clearInterval(reaper);
  });

  await new Promise<void>((resolve) => httpServer.listen(opts.port, opts.host, resolve));
  return httpServer;
}
