// The instance witness against a REAL loopback WebSocket server (ws's
// WebSocketServer on an ephemeral port — listen(0) and read the port back;
// picking a fixed port is the #843 flake). No mocking of the thing under test:
// the continuity property only means anything if a genuine server death drops
// the connection.

import { describe, expect, it, afterEach } from "vitest";
import { WebSocketServer } from "ws";
import { acquireInstanceWitness } from "../../services/instance-witness.js";

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          for (const client of s.clients) client.terminate();
          s.close(() => resolve());
        }),
    ),
  );
});

async function startServer(host = "127.0.0.1"): Promise<{ wss: WebSocketServer; base: string; port: number }> {
  const wss = new WebSocketServer({ port: 0, host });
  servers.push(wss);
  await new Promise<void>((resolve) => wss.on("listening", resolve));
  const address = wss.address();
  if (typeof address === "string" || !address) throw new Error("no address");
  return { wss, base: `http://${host === "::1" ? "[::1]" : host}:${address.port}`, port: address.port };
}

describe("acquireInstanceWitness", () => {
  it("hands back a LIVE witness once the handshake completes", async () => {
    const { base } = await startServer();

    const witness = await acquireInstanceWitness(base);

    expect(witness).toBeDefined();
    expect(witness?.alive()).toBe(true);
    expect(witness?.closedAt()).toBeUndefined();
    witness?.close();
  });

  it("connects a legacy IPv4 loopback URL to an IPv6-only listener", async () => {
    const { port } = await startServer("::1");

    const witness = await acquireInstanceWitness(`http://127.0.0.1:${port}`);

    expect(witness).toBeDefined();
    expect(witness?.url.startsWith(`ws://localhost:${port}/ws?clientId=`)).toBe(true);
    expect(witness?.alive()).toBe(true);
    witness?.close();
  });

  it("observes the server dying: alive() flips and closedAt is stamped", async () => {
    const { wss, base } = await startServer();
    const witness = await acquireInstanceWitness(base);
    expect(witness?.alive()).toBe(true);

    // The instance is replaced: every socket it held dies with it.
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => {
      const started = Date.now();
      const poll = () => {
        if (witness && !witness.alive()) return resolve();
        if (Date.now() - started > 2000) return resolve();
        setTimeout(poll, 5);
      };
      poll();
    });

    expect(witness?.alive()).toBe(false);
    expect(witness?.closedAt()).toBeTypeOf("number");
    witness?.close();
  });

  it("returns undefined — never throws — when nothing answers the handshake", async () => {
    // A freshly-bound-then-closed ephemeral port: guaranteed nothing listens.
    const { wss, base } = await startServer();
    await new Promise<void>((resolve) => wss.close(() => resolve()));

    const witness = await acquireInstanceWitness(base, 500);

    expect(witness).toBeUndefined();
  });

  it("returns undefined when the handshake outlives the timeout", async () => {
    // A TCP listener that accepts but never speaks WS: the handshake can only
    // time out. (The witness must bound its wait — a restart cannot hang on it.)
    const { createServer } = await import("node:net");
    const sockets = new Set<import("node:net").Socket>();
    const hanging = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
    const address = hanging.address();
    if (typeof address === "string" || !address) throw new Error("no address");
    try {
      const witness = await acquireInstanceWitness(
        `http://127.0.0.1:${address.port}`,
        200,
      );
      expect(witness).toBeUndefined();
    } finally {
      // close() only settles once every accepted socket is gone — destroy them
      // rather than wait out a peer that never speaks.
      for (const socket of sockets) socket.destroy();
      hanging.closeAllConnections?.();
      hanging.close();
    }
  });
});
