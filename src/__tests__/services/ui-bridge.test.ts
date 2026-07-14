import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { UiBridge } from "../../services/ui-bridge.js";

let bridge: UiBridge;
let port: number;

function connectPanel(tabId?: string, title = "workflow-a"): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    sock.on("open", () => {
      if (tabId) {
        sock.send(JSON.stringify({ type: "hello", tab_id: tabId, title }));
      }
      resolve(sock);
    });
    sock.on("error", reject);
  });
}

/** Auto-reply to commands with a tag identifying which panel answered. */
function autoReply(sock: WebSocket, tag: string): void {
  sock.on("message", (buf) => {
    const msg = JSON.parse(buf.toString());
    if (msg.rid && msg.cmd) {
      sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { from: tag, cmd: msg.cmd } }));
    }
  });
}

beforeEach(() => {
  port = 20000 + Math.floor(Math.random() * 20000);
  bridge = new UiBridge(port);
  bridge.start();
});

afterEach(async () => {
  await bridge.stop();
  vi.restoreAllMocks();
});

describe("UiBridge (token gate — secure/wss mode)", () => {
  it("accepts the correct token and rejects a missing one", async () => {
    const tport = 20000 + Math.floor(Math.random() * 20000);
    const tbridge = new UiBridge(tport, "s3cr3t-token");
    tbridge.start();
    expect(await tbridge.whenReady()).toBe(true);

    // No token → the verifyClient 401 makes the client error out without opening.
    await expect(
      new Promise((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${tport}`);
        s.on("open", () => reject(new Error("opened without a token")));
        s.on("error", () => resolve("rejected"));
      }),
    ).resolves.toBe("rejected");

    // Correct token → opens and can register a tab.
    const ok = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${tport}/?token=s3cr3t-token`);
      s.on("open", () => resolve(s));
      s.on("error", reject);
    });
    ok.send(JSON.stringify({ type: "hello", tab_id: "tab-secure-1", title: "wf" }));
    await vi.waitFor(() => expect(tbridge.connected()).toBe(true));
    ok.close();
    await tbridge.stop();
  });

  it("rejects a wrong token", async () => {
    const tport = 20000 + Math.floor(Math.random() * 20000);
    const tbridge = new UiBridge(tport, "right-token");
    tbridge.start();
    expect(await tbridge.whenReady()).toBe(true);
    await expect(
      new Promise((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${tport}/?token=wrong`);
        s.on("open", () => reject(new Error("opened with a wrong token")));
        s.on("error", () => resolve("rejected"));
      }),
    ).resolves.toBe("rejected");
    await tbridge.stop();
  });
});

describe("UiBridge (LAN bind — panel #54)", () => {
  it("refuses to construct a non-loopback bridge without a token", () => {
    expect(() => new UiBridge(20123, null, "0.0.0.0")).toThrow(/without a token/);
    expect(() => new UiBridge(20123, null, "192.168.1.10")).toThrow(/without a token/);
  });

  it("loopback hosts stay allowed without a token", async () => {
    const tport = 20000 + Math.floor(Math.random() * 20000);
    const lb = new UiBridge(tport, null, "localhost");
    lb.start();
    expect(await lb.whenReady()).toBe(true);
    await lb.stop();
  });

  it("binds 0.0.0.0 with a token, gates the upgrade, and serves a tab", async () => {
    const tport = 20000 + Math.floor(Math.random() * 20000);
    const lan = new UiBridge(tport, "lan-token", "0.0.0.0");
    lan.start();
    expect(await lan.whenReady()).toBe(true);

    // no token → rejected even on the LAN bind
    await expect(
      new Promise((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${tport}`);
        s.on("open", () => reject(new Error("opened without a token")));
        s.on("error", () => resolve("rejected"));
      }),
    ).resolves.toBe("rejected");

    // token in the URL (exactly what the panel's Advanced Bridge URL carries) → works
    const ok = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${tport}/?token=lan-token`);
      s.on("open", () => resolve(s));
      s.on("error", reject);
    });
    ok.send(JSON.stringify({ type: "hello", tab_id: "tab-lan-1", title: "wf" }));
    await vi.waitFor(() => expect(lan.connected()).toBe(true));
    ok.close();
    await lan.stop();
  });
});

describe("UiBridge (on-demand pairing listener — addListener)", () => {
  it("adds a token-gated second listener sharing tab routing; primary loopback stays token-less", async () => {
    // The beforeEach bridge is loopback + token-less (the local panel case).
    const pairPort = 20000 + Math.floor(Math.random() * 20000);
    await bridge.addListener("127.0.0.1", pairPort, "pair-token");

    // Pairing port WITHOUT a token → rejected.
    await expect(
      new Promise((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${pairPort}`);
        s.on("open", () => reject(new Error("opened pairing port without a token")));
        s.on("error", () => resolve("rejected"));
      }),
    ).resolves.toBe("rejected");

    // Wrong token → rejected.
    await expect(
      new Promise((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${pairPort}/?token=nope`);
        s.on("open", () => reject(new Error("opened pairing port with a wrong token")));
        s.on("error", () => resolve("rejected"));
      }),
    ).resolves.toBe("rejected");

    // Correct token → opens and registers a tab on the SAME bridge.
    const phone = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${pairPort}/?token=pair-token`);
      s.on("open", () => resolve(s));
      s.on("error", reject);
    });
    phone.send(JSON.stringify({ type: "hello", tab_id: "phone-1", title: "mobile" }));
    await vi.waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "phone-1")).toBe(true));

    // The primary loopback listener is STILL token-less (local panel unaffected).
    const local = await connectPanel("local-1");
    await vi.waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "local-1")).toBe(true));

    phone.close();
    local.close();
  });
});

describe("UiBridge (mailbox — offline render delivery)", () => {
  it("buffers show_media for an offline tab and flushes it on reconnect", async () => {
    // No tab connected. A finished-render delivery to a specific (offline) tab is
    // buffered, not failed.
    const res = await bridge.send(
      { cmd: "show_media", items: [{ filename: "a.png" }] },
      { tabId: "phone-stable-1" },
    );
    expect(res).toMatchObject({ ok: true, mailboxed: true });

    // An INTERACTIVE command to an offline tab still rejects (not mailboxable).
    await expect(
      bridge.send({ cmd: "graph_outline" }, { tabId: "phone-stable-1" }),
    ).rejects.toThrow();

    // The phone reconnects (same stable tab id) → it gets the buffered show_media
    // (flagged mailbox:true) plus a mailbox_flush summary.
    const got: Array<Record<string, unknown>> = [];
    const phone = await connectPanel(); // open socket, no hello yet
    phone.on("message", (buf) => got.push(JSON.parse(buf.toString())));
    phone.send(JSON.stringify({ type: "hello", tab_id: "phone-stable-1", title: "mobile" }));

    await vi.waitFor(() => {
      const media = got.find((m) => m.cmd === "show_media");
      const flush = got.find((m) => m.type === "mailbox_flush");
      expect(media).toMatchObject({ mailbox: true });
      expect(flush).toMatchObject({ count: 1 });
    });
    phone.close();
  });

  it("does not mailbox interactive commands (only show_media)", async () => {
    await expect(
      bridge.send({ cmd: "graph_get_state" }, { tabId: "nobody" }),
    ).rejects.toThrow();
    // Reconnecting that tab flushes nothing.
    const got: Array<Record<string, unknown>> = [];
    const phone = await connectPanel();
    phone.on("message", (buf) => got.push(JSON.parse(buf.toString())));
    phone.send(JSON.stringify({ type: "hello", tab_id: "nobody", title: "x" }));
    await vi.waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "nobody")).toBe(true));
    expect(got.find((m) => m.type === "mailbox_flush")).toBeUndefined();
    phone.close();
  });
});

describe("UiBridge (multi-tab)", () => {
  it("routes to the single connected tab without tab_id", async () => {
    const a = await connectPanel("tab-aaaa-1111");
    autoReply(a, "A");
    await vi.waitFor(() => expect(bridge.connected()).toBe(true));
    const result = await bridge.send({ cmd: "graph_get_state" });
    expect(result).toEqual({ from: "A", cmd: "graph_get_state" });
    a.close();
  });

  it("registers multiple tabs and lists them in status()", async () => {
    const a = await connectPanel("tab-aaaa-1111", "flux-workflow");
    const b = await connectPanel("tab-bbbb-2222", "video-workflow");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(2));
    const status = bridge.status();
    expect(status).toContain("2 panel tab(s) connected");
    expect(status).toContain("flux-workflow");
    expect(status).toContain("video-workflow");
    a.close();
    b.close();
  });

  it("routes by explicit tab_id (full id and 8-char prefix)", async () => {
    const a = await connectPanel("tab-aaaa-1111");
    const b = await connectPanel("tab-bbbb-2222");
    autoReply(a, "A");
    autoReply(b, "B");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(2));

    const full = await bridge.send({ cmd: "x" }, { tabId: "tab-bbbb-2222" });
    expect(full).toMatchObject({ from: "B" });
    const prefix = await bridge.send({ cmd: "x" }, { tabId: "tab-aaaa" });
    expect(prefix).toMatchObject({ from: "A" });
    a.close();
    b.close();
  });

  it("errors with the tab list when multiple tabs and no target", async () => {
    const a = await connectPanel("tab-aaaa-1111", "one");
    const b = await connectPanel("tab-bbbb-2222", "two");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(2));
    await expect(bridge.send({ cmd: "x" })).rejects.toThrow(/pass tab_id/);
    a.close();
    b.close();
  });

  it("defaults to the last tab the user typed in", async () => {
    const a = await connectPanel("tab-aaaa-1111");
    const b = await connectPanel("tab-bbbb-2222");
    autoReply(a, "A");
    autoReply(b, "B");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(2));

    // User types in tab B → it becomes the default target.
    b.send(JSON.stringify({ type: "user_message", text: "hi from B" }));
    await vi.waitFor(async () => {
      const result = await bridge.send({ cmd: "x" });
      expect(result).toMatchObject({ from: "B" });
    });
    a.close();
    b.close();
  });

  it("stamps user_message events with tab_id and title", async () => {
    const received: unknown[] = [];
    bridge.onPanelMessage = (e) => {
      if (e.type === "user_message") received.push(e);
    };
    const a = await connectPanel("tab-aaaa-1111", "my-flux-graph");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    a.send(JSON.stringify({ type: "user_message", text: "make it dreamier" }));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      text: "make it dreamier",
      tab_id: "tab-aaaa-1111",
      title: "my-flux-graph",
    });
    a.close();
  });

  it("push() broadcasts to all tabs by default and targets with tabId", async () => {
    const got: Record<string, unknown[]> = { A: [], B: [] };
    const a = await connectPanel("tab-aaaa-1111");
    const b = await connectPanel("tab-bbbb-2222");
    a.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.type === "say") got.A.push(m);
    });
    b.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.type === "say") got.B.push(m);
    });
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(2));

    expect(bridge.push({ type: "say", text: "to all" })).toBe(2);
    expect(bridge.push({ type: "say", text: "only B" }, "tab-bbbb")).toBe(1);
    await vi.waitFor(() => {
      expect(got.A).toHaveLength(1);
      expect(got.B).toHaveLength(2);
    });
    a.close();
    b.close();
  });

  it("same tab reconnecting (reload) supersedes its stale socket without touching other tabs", async () => {
    const a1 = await connectPanel("tab-aaaa-1111");
    const b = await connectPanel("tab-bbbb-2222");
    autoReply(b, "B");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(2));

    const a2 = await connectPanel("tab-aaaa-1111"); // reload of tab A
    autoReply(a2, "A2");
    await vi.waitFor(() => expect(a1.readyState).toBe(WebSocket.CLOSED));
    expect(bridge.tabs()).toHaveLength(2);

    const viaA = await bridge.send({ cmd: "x" }, { tabId: "tab-aaaa" });
    expect(viaA).toMatchObject({ from: "A2" });
    const viaB = await bridge.send({ cmd: "x" }, { tabId: "tab-bbbb" });
    expect(viaB).toMatchObject({ from: "B" });
    a2.close();
    b.close();
  });

  it("times out when the target tab never replies", async () => {
    const a = await connectPanel("tab-aaaa-1111");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    await expect(bridge.send({ cmd: "x" }, { timeoutMs: 100 })).rejects.toThrow(/did not reply/);
    a.close();
  });

  it("rejects in-flight commands when the target tab disconnects", async () => {
    const a = await connectPanel("tab-aaaa-1111");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    const promise = bridge.send({ cmd: "x" }, { timeoutMs: 5000 });
    a.close();
    await expect(promise).rejects.toThrow(/disconnected mid-command/);
  });

  it("fails fast with guidance when no tab is connected", async () => {
    await expect(bridge.send({ cmd: "x" })).rejects.toThrow(/no panel connected/);
  });

  it("rejects an unknown tab_id with the connected-tab list", async () => {
    const a = await connectPanel("tab-aaaa-1111", "one");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    await expect(bridge.send({ cmd: "x" }, { tabId: "nope" })).rejects.toThrow(/no connected tab/);
    a.close();
  });

  it("resolves via tab-id migration when a socket re-hellos under a new scheme (tmp:→wf:)", async () => {
    // Simulate the bug scenario: a tab first connects with a random-UUID tab id
    // (the old scheme), an agent binds to it, then the SAME socket re-hellos
    // under a deterministic tmp:/wf: scheme (the new scheme). bridge.send() with
    // the OLD id must still resolve to the new connection.
    const sock = await connectPanel(); // open socket, no hello yet
    autoReply(sock, "old-tab");
    await vi.waitFor(() => expect(bridge.connected()).toBe(false));

    // 1) First hello: old-style random-UUID tab id.
    const oldId = "6eccc826-592e-4abb-b280-35434e00ddd1";
    sock.send(JSON.stringify({ type: "hello", tab_id: oldId, title: "image_flux2_fp8" }));
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));

    // Verify the old id works.
    const oldResult = await bridge.send({ cmd: "graph_outline" }, { tabId: oldId });
    expect(oldResult).toMatchObject({ from: "old-tab" });

    // 2) Same socket re-hellos under a new deterministic tab id (the migration).
    const newId = "wf:workf";
    sock.send(JSON.stringify({ type: "hello", tab_id: newId, title: "image_flux2_fp8" }));
    await vi.waitFor(() => {
      expect(bridge.tabs()).toHaveLength(1);
      expect(bridge.tabs()[0].tab_id).toBe(newId);
    });

    // 3) The old agent (still holding the old tabId) sends a command via the
    //    bridge — this MUST resolve via the migration map instead of throwing.
    const migratedResult = await bridge.send({ cmd: "graph_get_state" }, { tabId: oldId });
    expect(migratedResult).toMatchObject({ from: "old-tab", cmd: "graph_get_state" });

    // 4) An UNKNOWN id (no migration, no connection) still fails with the
    //    expected error — plus a prefix mismatch for the old id should work too.
    await expect(
      bridge.send({ cmd: "x" }, { tabId: "completely-unknown" }),
    ).rejects.toThrow(/no connected tab/);

    sock.close();
  });

  it("migrates tab id when socket re-hellos to a different scheme and rejects absent tab_id", async () => {
    // Same scenario but with TWO tabs to ensure the migration is per-socket and
    // doesn't cross-contaminate.
    const sockA = await connectPanel();
    const sockB = await connectPanel();
    autoReply(sockA, "A");
    autoReply(sockB, "B");

    const oldA = "legacy-a-1111";
    const oldB = "legacy-b-2222";
    sockA.send(JSON.stringify({ type: "hello", tab_id: oldA, title: "flux-workflow" }));
    sockB.send(JSON.stringify({ type: "hello", tab_id: oldB, title: "video-workflow" }));
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(2));

    // Migrate tab A's socket to a new id, leave tab B unchanged.
    const newA = "wf:flux123";
    sockA.send(JSON.stringify({ type: "hello", tab_id: newA, title: "flux-workflow" }));
    await vi.waitFor(() => {
      expect(bridge.tabs()).toHaveLength(2);
      expect(bridge.tabs().find((t) => t.tab_id === newA)).toBeTruthy();
      expect(bridge.tabs().find((t) => t.tab_id === oldA)).toBeFalsy();
    });

    // Old id A still routes to the migrated tab.
    const fromA = await bridge.send({ cmd: "x" }, { tabId: oldA });
    expect(fromA).toMatchObject({ from: "A" });

    // Old id B (never migrated) still works normally.
    const fromB = await bridge.send({ cmd: "x" }, { tabId: oldB });
    expect(fromB).toMatchObject({ from: "B" });

    // New id works directly too.
    const fromNewA = await bridge.send({ cmd: "x" }, { tabId: newA });
    expect(fromNewA).toMatchObject({ from: "A" });

    sockA.close();
    sockB.close();
  });

  it("retries binding when the port is briefly held, then self-heals", async () => {
    // Simulate a fast /mcp reconnect: a previous session still owns the port
    // when the new bridge starts. It should back off, retry, and bind once the
    // old owner releases the port — without crashing.
    //
    // DETERMINISM: the original version released the port on a 250ms timer,
    // racing the bridge's FINITE retry schedule (5 attempts / ~6.2s total)
    // against the assertion deadline — under heavy machine load the clocks
    // skew and the test flakes. Instead: start the bridge while the port is
    // held (the initial bind reliably EADDRINUSEs), then release the port
    // FULLY (awaited close) before the first retry can fire, so attempt #1
    // deterministically succeeds. Same code path — bind failure → backoff →
    // self-heal — zero timing choreography.
    const racePort = 40000 + Math.floor(Math.random() * 20000);
    const blocker = new WebSocketServer({ port: racePort, host: "127.0.0.1" });
    await new Promise<void>((resolve) => blocker.on("listening", () => resolve()));

    const reconnecting = new UiBridge(racePort);
    reconnecting.start(); // hits EADDRINUSE, schedules a retry
    // Release the contended port and WAIT for the close to complete — the
    // first retry (≥200ms out) then finds it free no matter how loaded the
    // machine is.
    await new Promise<void>((resolve) => blocker.close(() => resolve()));

    try {
      // Eventually the retried bind succeeds and accepts a panel connection.
      await vi.waitFor(
        () =>
          new Promise<void>((resolve, reject) => {
            const probe = new WebSocket(`ws://127.0.0.1:${racePort}`);
            const done = (err?: Error) => {
              // settle exactly once and drop listeners so a late 'error' from
              // the closing socket can't surface as an unhandled event
              probe.removeAllListeners();
              probe.on("error", () => {});
              probe.close();
              if (err) reject(err);
              else resolve();
            };
            probe.on("open", () => done());
            probe.on("error", (err) => done(err));
          }),
        // generous: must exceed the bridge's full backoff schedule even on a
        // heavily loaded machine (arena runs, docker exports, CI neighbors)
        { timeout: 15000, interval: 150 },
      );
    } finally {
      await reconnecting.stop();
    }
  });
});
