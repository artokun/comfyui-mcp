// Orchestrator-hosted HTTP MCP server for the panel_* live-graph tools (Codex).
//
// The Codex `codex app-server` can only host CONFIG-DECLARED MCP servers — it
// can't run an in-process SDK MCP server the way the Claude Agent SDK does. So
// to give Codex the SAME live-canvas control Claude has, the orchestrator stands
// up a loopback HTTP MCP endpoint here and declares it to Codex as
// `mcp_servers.panel.url = http://127.0.0.1:<port>/<tabId>`.
//
// ROUTING: the URL path is the panel tab id. Each tab gets its OWN McpServer
// instance whose tools forward to `bridge.send(cmd, { tabId })` for THAT tab —
// exactly like the in-process per-tab server the Claude path uses. The tool
// SURFACE is shared (registerPanelTools / buildPanelToolDefs in panel-tools.ts),
// so Codex and Claude expose an identical panel toolset and parity is automatic.
//
// LOOPBACK ONLY: bound to 127.0.0.1; never exposed off-host. Sessions are
// stateful (the transport mints a session id per Codex connection) and held in
// a per-tab map so the same Codex thread reuses its server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { UiBridge } from "../services/ui-bridge.js";
import type { WorkflowTargetStore } from "../services/workflow-target-store.js";
import { makePanelToolCtx, registerPanelTools } from "./panel-tools.js";
import { PANEL_HANDSHAKE_INSTRUCTIONS } from "../handshake-instructions.js";
import { logger } from "../utils/logger.js";

/** A live MCP session: one McpServer + its streamable-HTTP transport, bound to a
 *  panel tab. Keyed by the transport's session id within a tab's session map. */
interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export interface PanelMcpHttpServer {
  /** The bound port (loopback). */
  readonly port: number;
  /** Build the URL Codex should connect to for a given tab. */
  urlFor(tabId: string): string;
  /** Stop the HTTP server and tear down every live session. */
  stop(): Promise<void>;
}

/** Read the raw request body (Codex POSTs JSON-RPC). The transport wants the
 *  parsed body passed alongside the req/res. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined); // let the transport reject malformed JSON
      }
    });
    req.on("error", () => resolve(undefined));
  });
}

/** Extract the tab id from the request URL path (`/<tabId>`). */
function tabIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const path = url.split("?")[0].replace(/^\/+|\/+$/g, "");
  return path.length ? decodeURIComponent(path) : null;
}

/**
 * Start the loopback HTTP MCP server that exposes the panel_* tools to Codex,
 * routed by tab id. Returns once the port is bound (or rejects on bind failure).
 */
export function startPanelMcpHttpServer(
  bridge: UiBridge,
  port: number,
  host = "127.0.0.1",
  workflowTargets?: WorkflowTargetStore,
  onRunTicketOpened?: (promptIds: readonly string[]) => void,
  manifestOutcomeScopeForTab?: (tabId: string) => string | undefined,
  manifestOutcomeTarget?: () => { url: string; generation: number } | undefined,
): Promise<PanelMcpHttpServer> {
  // tabId -> (sessionId -> Session). A tab can hold multiple Codex sessions
  // across reconnects; each is its own server+transport over the SAME tab ctx.
  const tabs = new Map<string, Map<string, Session>>();

  // The port ACTUALLY bound, which is not always the port asked for: `listen(0)`
  // means "any free port", and the OS picks it. Everything downstream — the URL
  // handed to the backend, the transport's DNS-rebinding allowlist, and the Host
  // guard below — has to name the real one, or a server that came up fine is
  // unreachable at the address it advertises and rejects the requests that do
  // arrive. Kept in sync at `listen`, before any of those readers can run.
  let boundPort = port;

  const newSession = async (tabId: string): Promise<Session> => {
    const server = new McpServer(
      { name: "comfyui-panel", version: "1.0.0" },
      // #1747 — live-canvas flows only. Different audience from the stdio
      // server; do not recap that catalog here.
      { instructions: PANEL_HANDSHAKE_INSTRUCTIONS },
    );
    // Tab-bound context: every tool forwards to the bridge for THIS tab — the
    // same surface the Claude in-process server exposes (shared defs).
    //
    // `inheritsUserMcpServers: false` is a statement about THIS LANE, not a guess
    // about the backend behind it (#2311). This server exists only for the
    // CLI-driven backends, and every one of them is spawned from
    // makeHttpBackendMcpServers(), which declares exactly two MCP servers — the
    // stdio `comfyui` child and this loopback `panel` HTTP MCP. The user's
    // ~/.claude.json entries are never among them. Without this the shared
    // panel_list_mcp handler reported them as inherited on every lane, which is
    // how a Codex session was told it had `story-mixer-comfy` and then got
    // `unknown MCP server` from every call to it.
    //
    // It says nothing about MCP servers the CLI's OWN config (~/.codex/config.toml
    // and friends) may add — we only know what we declared, and the handler's
    // wording is careful to claim no more than that.
    registerPanelTools(
      server,
      makePanelToolCtx(bridge, tabId, workflowTargets, onRunTicketOpened, {
        inheritsUserMcpServers: false,
        manifestOutcomeScope: manifestOutcomeScopeForTab?.(tabId),
        ...(manifestOutcomeTarget ? { manifestOutcomeTarget } : {}),
      }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Defense in depth against DNS rebinding (a malicious page resolving its own
      // host to 127.0.0.1 to reach this loopback server). We also Host/Origin-guard
      // in the request handler since we hand-roll http.createServer.
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`],
      allowedOrigins: [], // no browser origin should ever reach this (Codex sends none)
      onsessioninitialized: (sid) => {
        let m = tabs.get(tabId);
        if (!m) {
          m = new Map();
          tabs.set(tabId, m);
        }
        m.set(sid, { server, transport });
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        const m = tabs.get(tabId);
        m?.delete(sid);
        if (m && m.size === 0) tabs.delete(tabId); // don't leak empty per-tab maps
      }
    };
    await server.connect(transport);
    return { server, transport };
  };

  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        // SECURITY (P1): this loopback server is reachable by any local process and,
        // via DNS rebinding, by a malicious web page the user has open. Only the
        // local Codex app-server should reach it — and it sends an exact-loopback
        // Host and NO browser Origin. Reject anything else before doing any work.
        const hostHeader = req.headers.host;
        if (hostHeader !== `127.0.0.1:${boundPort}` && hostHeader !== `localhost:${boundPort}`) {
          res.writeHead(403, { "content-type": "application/json" }).end(
            JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Forbidden host." }, id: null }),
          );
          return;
        }
        if (req.headers.origin) {
          res.writeHead(403, { "content-type": "application/json" }).end(
            JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Cross-origin requests are not allowed." }, id: null }),
          );
          return;
        }
        const tabId = tabIdFromUrl(req.url);
        if (!tabId) {
          res.writeHead(404, { "content-type": "application/json" }).end(
            JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Missing tab id in path (/<tabId>)." }, id: null }),
          );
          return;
        }
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        const tabSessions = tabs.get(tabId);
        const existing = sessionId ? tabSessions?.get(sessionId) : undefined;

        // #1524 — a session id we do not know is a SESSION problem, and the status
        // code is the only place the protocol says so. 404 means "that session is
        // gone", on which the client MUST open a new one with a fresh
        // InitializeRequest; 400 means "this request was malformed", which no
        // client retries and none re-initializes on. Answering the first case with
        // the second is why the panel half of a dropped session never came back
        // while the stdio `comfyui` half — which the client simply respawns, and
        // which needs no such signal — always did.
        //
        // Every session map here is process-local, so an orchestrator restart
        // invalidates every id at once. That is not an edge case on this install:
        // the dev build self-restarts on rebuild.
        //
        // Scoped deliberately to "an id was presented and is unknown". A request
        // with NO id keeps its 400 below: there is no session to recover, and
        // sending it to re-initialize something it never opened would loop it.
        if (sessionId && !existing) {
          res.writeHead(404, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32001,
                message:
                  "Session not found — this session id is not known to this orchestrator " +
                  "(it may have restarted). Open a new session with an initialize request.",
              },
              id: null,
            }),
          );
          return;
        }

        if (existing) {
          // Established session — GET (SSE), POST (messages), DELETE (close).
          const body = req.method === "POST" ? await readJsonBody(req) : undefined;
          await existing.transport.handleRequest(req, res, body);
          return;
        }

        // No session yet: only an initialize POST may open one.
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          if (isInitializeRequest(body)) {
            const sess = await newSession(tabId);
            try {
              await sess.transport.handleRequest(req, res, body);
            } catch (e) {
              // Initialize failed before the session registered — tear down the
              // freshly-connected server/transport so it doesn't leak.
              try {
                await sess.transport.close();
              } catch {
                // best-effort
              }
              throw e;
            }
            return;
          }
          res.writeHead(400, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "No valid session id, and not an initialize request." },
              id: null,
            }),
          );
          return;
        }

        // GET/DELETE without a known session.
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Unknown or missing session id." }, id: null }),
        );
      } catch (err) {
        logger.error(`[panel-mcp-http] request error: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" }).end(
            JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error." }, id: null }),
          );
        }
      }
    })();
  });

  return new Promise<PanelMcpHttpServer>((resolve, reject) => {
    httpServer.on("error", (err) => reject(err));
    httpServer.listen(port, host, () => {
      // Read the port back off the socket rather than echoing the request. They
      // are the same number for every caller that names one, and different for
      // `listen(0)` — where echoing produced a server advertising `:0`, which no
      // client can dial and whose own Host guard would reject anything that did.
      const addr = httpServer.address();
      boundPort = typeof addr === "object" && addr ? addr.port : port;
      logger.info(
        `[panel-mcp-http] panel_* MCP listening on http://${host}:${boundPort}/<tabId> (loopback, Codex)`,
      );
      resolve({
        port: boundPort,
        urlFor: (tabId: string) => `http://${host}:${boundPort}/${encodeURIComponent(tabId)}`,
        stop: async () => {
          for (const tabSessions of tabs.values()) {
            for (const s of tabSessions.values()) {
              try {
                await s.transport.close();
              } catch {
                // best-effort during shutdown
              }
            }
          }
          tabs.clear();
          await new Promise<void>((r) => httpServer.close(() => r()));
        },
      });
    });
  });
}
