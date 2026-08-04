import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { UiBridge } from "../../services/ui-bridge.js";
import { RelayClient } from "../../services/relay-client.js";

/**
 * A minimal stand-in for the comfyui-mcp-relay Durable Object, speaking the same
 * {t,id,d} envelope on the orchestrator leg documented in that repo's README.
 * Exercises RelayClient + UiBridge.attachRelayConnection end to end without
 * needing a live Cloudflare deploy.
 *
 * Binds an OS-assigned port (listen(0)) and reads it back — never a guessed
 * random port, which can already be held on the machine (#821). A bind failure
 * rejects HERE, so a broken fixture reports as a setup failure instead of a
 * timeout in the behaviour under test.
 */
async function startFakeRelay(): Promise<{ port: number; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve, reject) => {
    wss.on("listening", () => resolve());
    wss.on("error", reject);
  });
  const addr = wss.address();
  if (!addr || typeof addr !== "object") {
    throw new Error("fixture setup failed: fake relay is listening but reported no address");
  }
  const port = addr.port;
  let orchestrator: WebSocket | null = null;
  const panels = new Map<string, WebSocket>();
  const allSockets = new Set<WebSocket>();
  let nextId = 0;

  wss.on("connection", (sock: WebSocket, req: IncomingMessage) => {
    allSockets.add(sock);
    sock.on("close", () => allSockets.delete(sock));
    const url = new URL(req.url ?? "/", "http://fake-relay");
    const role = url.searchParams.get("role") === "orchestrator" ? "orchestrator" : "panel";

    if (role === "orchestrator") {
      orchestrator = sock;
      sock.on("message", (buf: unknown) => {
        const msg = JSON.parse(String(buf));
        if (msg.t === "data" && msg.id) panels.get(msg.id)?.send(msg.d);
        else if (msg.t === "close" && msg.id) {
          panels.get(msg.id)?.close();
          panels.delete(msg.id);
        } else if (msg.t === "ping") {
          sock.send(JSON.stringify({ t: "pong" }));
        }
      });
      return;
    }

    const id = `c${nextId++}`;
    panels.set(id, sock);
    orchestrator?.send(JSON.stringify({ t: "open", id }));
    sock.on("message", (buf: unknown) => {
      orchestrator?.send(JSON.stringify({ t: "data", id, d: String(buf) }));
    });
    sock.on("close", () => {
      panels.delete(id);
      orchestrator?.send(JSON.stringify({ t: "close", id }));
    });
  });

  return {
    port,
    // wss.close() alone only stops accepting NEW connections — it waits for
    // already-open sockets to end on their own before its callback fires. Force
    // them shut so a test simulating "the relay disappeared" sees an immediate
    // client-side close instead of waiting out a TCP-level timeout.
    close: () => {
      for (const s of allSockets) {
        try {
          s.terminate();
        } catch {
          // already gone
        }
      }
      return new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

describe("RelayClient + UiBridge.attachRelayConnection (via a fake relay)", () => {
  let cleanup: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup.reverse()) await fn();
    cleanup = [];
    vi.restoreAllMocks();
  });

  it("routes a panel-tab hello + command/reply through the relay envelope", async () => {
    const fakeRelay = await startFakeRelay();
    const port = fakeRelay.port;
    cleanup.push(() => fakeRelay.close());

    // No .start() — attachRelayConnection doesn't touch the loopback server at all.
    const bridge = new UiBridge();

    const client = new RelayClient({
      relayUrl: `ws://127.0.0.1:${port}`,
      sessionId: "test-session",
      token: "tok",
      onAttach: (sock) => bridge.attachRelayConnection(sock),
    });
    client.start();
    cleanup.push(() => client.stop());
    await client.waitUntilOpen();

    const panelSock = new WebSocket(`ws://127.0.0.1:${port}/s/test-session?token=tok`);
    cleanup.push(() => panelSock.close());
    await new Promise<void>((resolve, reject) => {
      panelSock.on("open", () => resolve());
      panelSock.on("error", reject);
    });

    panelSock.on("message", (buf: unknown) => {
      const msg = JSON.parse(String(buf));
      if (msg.rid && msg.cmd) {
        panelSock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { via: "relay", cmd: msg.cmd } }));
      }
    });

    panelSock.send(JSON.stringify({ type: "hello", tab_id: "relay-tab-1", title: "relay-workflow" }));
    await vi.waitFor(() => expect(bridge.connected()).toBe(true));
    expect(bridge.tabs()).toHaveLength(1);
    expect(bridge.tabs()[0].title).toBe("relay-workflow");

    const result = await bridge.send({ cmd: "graph_get_state" });
    expect(result).toEqual({ via: "relay", cmd: "graph_get_state" });
  });

  it("supports multiple panel tabs multiplexed over the single orchestrator connection", async () => {
    const fakeRelay = await startFakeRelay();
    const port = fakeRelay.port;
    cleanup.push(() => fakeRelay.close());

    const bridge = new UiBridge();
    const client = new RelayClient({
      relayUrl: `ws://127.0.0.1:${port}`,
      sessionId: "multi-tab-session",
      token: "tok2",
      onAttach: (sock) => bridge.attachRelayConnection(sock),
    });
    client.start();
    cleanup.push(() => client.stop());
    await client.waitUntilOpen();

    const dial = (tabId: string, title: string): Promise<WebSocket> =>
      new Promise((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${port}/s/multi-tab-session?token=tok2`);
        cleanup.push(() => s.close());
        s.on("open", () => {
          s.send(JSON.stringify({ type: "hello", tab_id: tabId, title }));
          resolve(s);
        });
        s.on("error", reject);
      });

    await dial("tab-a", "workflow-a");
    await dial("tab-b", "workflow-b");

    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(2));
    const titles = bridge.tabs().map((t) => t.title).sort();
    expect(titles).toEqual(["workflow-a", "workflow-b"]);
  });

  it("closes shim connections when the relay control channel drops", async () => {
    const fakeRelay = await startFakeRelay();
    const port = fakeRelay.port;
    cleanup.push(() => fakeRelay.close());

    const bridge = new UiBridge();
    const client = new RelayClient({
      relayUrl: `ws://127.0.0.1:${port}`,
      sessionId: "drop-session",
      token: "tok3",
      onAttach: (sock) => bridge.attachRelayConnection(sock),
    });
    client.start();
    cleanup.push(() => client.stop());
    await client.waitUntilOpen();

    const panelSock = new WebSocket(`ws://127.0.0.1:${port}/s/drop-session?token=tok3`);
    cleanup.push(() => panelSock.close());
    await new Promise<void>((resolve) => panelSock.on("open", () => resolve()));
    panelSock.send(JSON.stringify({ type: "hello", tab_id: "drop-tab", title: "wf" }));
    await vi.waitFor(() => expect(bridge.connected()).toBe(true));

    // Kill the fake relay out from under the client — its control connection drops.
    await fakeRelay.close();
    await vi.waitFor(() => expect(bridge.connected()).toBe(false), { timeout: 3000 });
  });
});
