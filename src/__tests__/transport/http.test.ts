import { describe, expect, it, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseSessionIdleMs, startHttpServer } from "../../transport/http.js";

function stubServerFactory(): McpServer {
  const server = new McpServer(
    { name: "test-comfyui-mcp", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.tool("ping", "Returns pong", {}, async () => ({
    content: [{ type: "text" as const, text: "pong" }],
  }));
  server.tool(
    "echo",
    "Echoes the message",
    { message: z.string() },
    async ({ message }) => ({ content: [{ type: "text" as const, text: message }] }),
  );
  return server;
}

let httpServer: Server | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
  // Guard: when a test never started a server (e.g. startHttpServer rejected),
  // httpServer is undefined and `?.close(cb)` would short-circuit without ever
  // invoking the callback — leaving the promise (and the hook) hanging forever.
  await new Promise<void>((resolve) => {
    if (httpServer) httpServer.close(() => resolve());
    else resolve();
  });
  httpServer = undefined;
});

async function connectClient(): Promise<{ client: Client; port: number }> {
  httpServer = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    createServer: stubServerFactory,
  });
  const port = (httpServer.address() as AddressInfo).port;
  const c = new Client({ name: "test-client", version: "0.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  client = c;
  return { client: c, port };
}

describe("startHttpServer (streamable-HTTP)", () => {
  it("completes an MCP handshake and lists tools over HTTP", async () => {
    const { client } = await connectClient();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["echo", "ping"]);
  });

  it("executes a tool call over HTTP", async () => {
    const { client } = await connectClient();
    const result = await client.callTool({ name: "echo", arguments: { message: "hi there" } });
    const text = (result.content as Array<{ type: string; text?: string }>).find(
      (c) => c.type === "text",
    );
    expect(text?.text).toBe("hi there");
  });

  it("returns 404 for non-/mcp paths", async () => {
    httpServer = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      createServer: stubServerFactory,
    });
    const port = (httpServer.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/nope`, { method: "GET" });
    expect(res.status).toBe(404);
  });

  it("rejects a POST that is not an initialize request with 400", async () => {
    httpServer = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      createServer: stubServerFactory,
    });
    const port = (httpServer.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it("stays OPEN (no auth required) when no token is configured", async () => {
    // Same as the happy path — proves the default behavior is unchanged.
    const { client } = await connectClient();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["echo", "ping"]);
  });
});

const TOKEN = "s3cr3t-token";

async function startTokenServer(): Promise<number> {
  httpServer = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    createServer: stubServerFactory,
  });
  return (httpServer.address() as AddressInfo).port;
}

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "raw", version: "0.0.0" },
  },
});

async function connectAuthedClient(headers: Record<string, string>): Promise<Client> {
  const port = await startTokenServer();
  const c = new Client({ name: "test-client", version: "0.0.0" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers },
    }),
  );
  client = c;
  return c;
}

describe("startHttpServer auth (token configured)", () => {
  it("returns 401 for a request with no credentials", async () => {
    const port = await startTokenServer();
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: INIT_BODY,
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for a wrong token", async () => {
    const port = await startTokenServer();
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer nope",
      },
      body: INIT_BODY,
    });
    expect(res.status).toBe(401);
  });

  it("completes the handshake with a correct Authorization: Bearer token", async () => {
    const client = await connectAuthedClient({ Authorization: `Bearer ${TOKEN}` });
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["echo", "ping"]);
  });

  it("completes the handshake with a correct X-API-Key token", async () => {
    const client = await connectAuthedClient({ "X-API-Key": TOKEN });
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["echo", "ping"]);
  });
});

describe("startHttpServer non-loopback safety gate", () => {
  it("refuses to start on a non-loopback host with no token and no escape hatch", async () => {
    await expect(
      startHttpServer({
        host: "0.0.0.0",
        port: 0,
        createServer: stubServerFactory,
      }),
    ).rejects.toThrow(/Refusing to start/);
  });

  it("starts on a non-loopback host with no token when the escape hatch is set", async () => {
    httpServer = await startHttpServer({
      host: "0.0.0.0",
      port: 0,
      allowUnauthenticated: true,
      createServer: stubServerFactory,
    });
    expect((httpServer.address() as AddressInfo).port).toBeGreaterThan(0);
  });

  it("starts on a non-loopback host with a token (no escape hatch needed)", async () => {
    httpServer = await startHttpServer({
      host: "0.0.0.0",
      port: 0,
      token: TOKEN,
      createServer: stubServerFactory,
    });
    expect((httpServer.address() as AddressInfo).port).toBeGreaterThan(0);
  });
});

describe("startHttpServer idle-session expiry", () => {
  const ACCEPT = "application/json, text/event-stream";

  async function startIdleServer(sessionIdleMs: number): Promise<number> {
    httpServer = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      sessionIdleMs,
      createServer: stubServerFactory,
    });
    return (httpServer.address() as AddressInfo).port;
  }

  // Open a session the way a client that never sends DELETE would.
  async function openSession(port: number): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: ACCEPT },
      body: INIT_BODY,
    });
    await res.text();
    const sid = res.headers.get("mcp-session-id");
    expect(res.status).toBe(200);
    expect(sid).toBeTruthy();
    await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: ACCEPT,
        "mcp-session-id": sid!,
        "mcp-protocol-version": "2024-11-05",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }).then((r) => r.text());
    return sid!;
  }

  async function listTools(port: number, sid: string): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: ACCEPT,
        "mcp-session-id": sid,
        "mcp-protocol-version": "2024-11-05",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    await res.text();
    return res.status;
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("closes a session that has been idle past the window", async () => {
    const port = await startIdleServer(1_000);
    const sid = await openSession(port);
    expect(await listTools(port, sid)).toBe(200);
    await sleep(2_600);
    // Unknown session after expiry → the transport's existing 400.
    expect(await listTools(port, sid)).toBe(400);
    // The server still accepts new sessions.
    expect(await listTools(port, await openSession(port))).toBe(200);
  }, 10_000);

  it("keeps a session that keeps making requests", async () => {
    const port = await startIdleServer(1_000);
    const sid = await openSession(port);
    for (let i = 0; i < 8; i++) {
      await sleep(400);
      expect(await listTools(port, sid)).toBe(200);
    }
  }, 10_000);

  it("never closes a session with an open GET stream", async () => {
    const port = await startIdleServer(1_000);
    const sid = await openSession(port);
    const ctrl = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "GET",
      headers: { Accept: "text/event-stream", "mcp-session-id": sid, "mcp-protocol-version": "2024-11-05" },
      signal: ctrl.signal,
    });
    expect(stream.status).toBe(200);
    await sleep(3_000);
    ctrl.abort();
    await sleep(50);
    expect(await listTools(port, sid)).toBe(200);
  }, 10_000);

  it("does not expire sessions when sessionIdleMs is 0", async () => {
    const port = await startIdleServer(0);
    const sid = await openSession(port);
    await sleep(2_600);
    expect(await listTools(port, sid)).toBe(200);
  }, 10_000);
});

describe("parseSessionIdleMs", () => {
  it("defaults to 30 minutes when unset or blank", () => {
    expect(parseSessionIdleMs(undefined)).toBe(30 * 60 * 1000);
    expect(parseSessionIdleMs("  ")).toBe(30 * 60 * 1000);
  });
  it("accepts 0 (disabled) and positive values", () => {
    expect(parseSessionIdleMs("0")).toBe(0);
    expect(parseSessionIdleMs("600000")).toBe(600_000);
  });
  it("falls back to the default on an invalid value", () => {
    expect(parseSessionIdleMs("abc")).toBe(30 * 60 * 1000);
    expect(parseSessionIdleMs("-5")).toBe(30 * 60 * 1000);
  });
});
