// #1524 — after a mid-session drop, the `comfyui` tools came back and the 92
// `panel_*` tools never did.
//
// The two servers are declared to the backend with DIFFERENT transports
// (orchestrator/index.ts, makeHttpBackendMcpServers): `comfyui` is **stdio** — a
// child process the client owns and respawns — while `panel` is **http**, a
// stateful session against this loopback server. So only the panel half depends
// on a session surviving, or on being told when it has not.
//
// The protocol has exactly one signal for that, and it is a status code:
//
//   - a request with NO session id, that is not an initialize  → 400 Bad Request
//   - a request carrying a session id the server does not know → 404 Not Found,
//     on which the client MUST open a new session with a fresh InitializeRequest
//
// (MCP Streamable HTTP, 2025-11-25 `basic/transports`; the SDK's own reference
// router returns `404 / -32001 Session not found` for the second case, and its
// review notes call conflating the two a recurring catch — "clients need to
// distinguish between a request error and a session issue".)
//
// This server answered BOTH with 400. A client holding a session id from before
// an orchestrator restart — which is routine here, since the dev install
// self-restarts on rebuild and every session map is process-local — therefore
// received "your request was malformed" where the protocol says "your session is
// gone, start another". There is no re-initialize on that path, so the panel
// server stays absent for the remainder of the conversation while the stdio
// `comfyui` server, which needs no such signal, is simply respawned.
//
// These tests drive the REAL server over a real socket. A fake would only prove
// the shape I already believe.
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startPanelMcpHttpServer, type PanelMcpHttpServer } from "../../orchestrator/panel-mcp-http.js";
import type { UiBridge } from "../../services/ui-bridge.js";

const TAB = "tmp:1524";

const TRANSIENT_ORCHESTRATOR_SEND_ERROR =
  "Transport send error: WorkerTransport<StreamableHttpClientWorker<...>> error: " +
  "HTTP request failed sending request to http://127.0.0.1:9198/orchestrator::codex";

/** A bridge that is never actually reached — these tests stop at the transport. */
const bridge = {
  send: async () => ({ ok: true }),
  push: () => 1,
  canReach: () => true,
  isHeadless: () => false,
  tabs: () => [{ tab_id: TAB, title: "A", connected_at: 0 }],
  resolveActiveTabId: () => TAB,
} as unknown as UiBridge;

let server: PanelMcpHttpServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

/** Bind on an ephemeral port so a developer's live orchestrator on 9181 is never
 *  disturbed, and two of these files can run in parallel. */
async function start(): Promise<PanelMcpHttpServer> {
  server = await startPanelMcpHttpServer(bridge, 0);
  return server;
}

interface Probe {
  status: number;
  code?: number;
  message?: string;
}

async function probe(
  s: PanelMcpHttpServer,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Probe> {
  const res = await fetch(s.urlFor(TAB), {
    method,
    headers: {
      // The transport's DNS-rebinding guard admits only exact-loopback hosts,
      // and `urlFor` already produces one — but be explicit so a future change
      // to that helper fails loudly here rather than as a mystery 403.
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let code: number | undefined;
  let message: string | undefined;
  try {
    const j = (await res.json()) as { error?: { code?: number; message?: string } };
    code = j?.error?.code;
    message = j?.error?.message;
  } catch {
    /* a body-less response is fine; the status is the subject here */
  }
  return { status: res.status, code, message };
}

const STALE = "11111111-2222-4333-8444-555555555555";
const CALL = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

describe("a stale panel MCP session is reported as a SESSION problem (#1524)", () => {
  it("answers 404 to a POST carrying a session id this process never minted", async () => {
    // The reported case, reduced: the client survived, its session id did not.
    // 404 is the only status that tells it to re-initialize; on 400 it stays down.
    const s = await start();
    const r = await probe(s, "POST", { "mcp-session-id": STALE }, CALL);
    expect(r.status, "an unknown session id is a session problem, not a bad request").toBe(404);
    expect(r.code).toBe(-32001);
  });

  it("answers 404 to a GET (the SSE re-attach) carrying an unknown session id", async () => {
    // This is the request a reconnecting client actually makes first, so getting
    // it wrong is what makes the tools stay missing rather than merely fail once.
    const s = await start();
    const r = await probe(s, "GET", { "mcp-session-id": STALE });
    expect(r.status).toBe(404);
    expect(r.code).toBe(-32001);
  });

  it("answers 404 to a DELETE carrying an unknown session id", async () => {
    // A client tidying up a session this process has already forgotten is not
    // making a malformed request either.
    const s = await start();
    const r = await probe(s, "DELETE", { "mcp-session-id": STALE });
    expect(r.status).toBe(404);
    expect(r.code).toBe(-32001);
  });

  it("still answers 400 when there is NO session id and the POST is not an initialize", async () => {
    // The other half of the distinction, and the reason this cannot be a blanket
    // 404: a client that never initialized has no session to recover, and telling
    // it to re-initialize a session it never had would send it round a loop.
    const s = await start();
    const r = await probe(s, "POST", {}, CALL);
    expect(r.status).toBe(400);
  });

  it("still answers 400 to a GET with no session id at all", async () => {
    const s = await start();
    const r = await probe(s, "GET", {});
    expect(r.status).toBe(400);
  });

  it("a session it DID mint keeps working — the 404 is not a blanket refusal", async () => {
    // Guards the direction that would silently un-ship every panel tool: a fix
    // that returns 404 too eagerly breaks the healthy path, and the two failures
    // look identical from the issue's vantage point (tools missing).
    const s = await start();
    const init = await fetch(s.urlFor(TAB), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-1524", version: "1" },
        },
      }),
    });
    expect(init.status).toBe(200);
    const sid = init.headers.get("mcp-session-id");
    expect(sid, "the server must mint a session id to have one to invalidate").toBeTruthy();
    // Drain the initialize response so the connection is not left mid-stream.
    await init.text();

    const r = await probe(s, "POST", { "mcp-session-id": sid! }, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(r.status, "a live session must not be told it is gone").not.toBe(404);
  });
});

describe("idempotent panel reads retry a transient orchestrator send error (#2233)", () => {
  it("retries panel_query_graph and panel_graph_outline once through the real HTTP MCP path", async () => {
    const attempts = new Map<string, number>();
    const readBridge = {
      ...bridge,
      send: async (cmd: { cmd: string }) => {
        const attempt = (attempts.get(cmd.cmd) ?? 0) + 1;
        attempts.set(cmd.cmd, attempt);
        if (attempt === 1) throw new Error(TRANSIENT_ORCHESTRATOR_SEND_ERROR);
        return cmd.cmd === "graph_query"
          ? { text: "1 KSampler", nodes: [{ id: 1, type: "KSampler" }], node_count: 1 }
          : { outline: "1 KSampler", node_count: 1, group_count: 0 };
      },
    } as unknown as UiBridge;
    const s = await startPanelMcpHttpServer(readBridge, 0);
    let client: Client | undefined;
    try {
      client = new Client({ name: "test-2233", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(s.urlFor(TAB))));

      const query = await client.callTool({ name: "panel_query_graph", arguments: {} });
      const outline = await client.callTool({ name: "panel_graph_outline", arguments: {} });

      expect(query.isError).not.toBe(true);
      expect(outline.isError).not.toBe(true);
      expect(attempts.get("graph_query")).toBe(2);
      expect(attempts.get("graph_outline")).toBe(2);
    } finally {
      await client?.close();
      await s.stop();
    }
  });

  it("does not retry a mutation on the same transport error", async () => {
    let attempts = 0;
    const mutationBridge = {
      ...bridge,
      send: async () => {
        attempts += 1;
        throw new Error(TRANSIENT_ORCHESTRATOR_SEND_ERROR);
      },
    } as unknown as UiBridge;
    const s = await startPanelMcpHttpServer(mutationBridge, 0);
    let client: Client | undefined;
    try {
      client = new Client({ name: "test-2233-mutation", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(s.urlFor(TAB))));

      const result = await client.callTool({
        name: "panel_set_widget",
        arguments: { node_id: 1, widget: "steps", value: 20 },
      });

      expect(result.isError).toBe(true);
      expect(attempts).toBe(1);
    } finally {
      await client?.close();
      await s.stop();
    }
  });
});
