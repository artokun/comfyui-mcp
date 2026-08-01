import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  UiBridge,
  makeUnknownCommandError,
  panelVersionProvesUnsupported,
  isPanelCmdUnsupportedError,
  MIN_PANEL_VERSION_FOR_BRIDGE_COMMANDS,
  minPanelVersionForCmd,
  markDispatched,
  dispatchOutcomeOf,
  defaultBridgeTimeoutMs,
  BRIDGE_DEFAULT_TIMEOUT_MS,
  BRIDGE_READ_DEFAULT_TIMEOUT_MS,
  BRIDGE_READONLY_CMDS,
} from "../../services/ui-bridge.js";

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

beforeEach(async () => {
  port = 20000 + Math.floor(Math.random() * 20000);
  bridge = new UiBridge(port);
  bridge.start();
  // Await the actual bound `listening` event before any test connects a client.
  // start() binds asynchronously; without this, connectPanel() can race the bind
  // and fail with ECONNREFUSED on loaded CI (ubuntu-latest) — the #486 flake.
  expect(await bridge.whenReady()).toBe(true);
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

describe("UiBridge (typed dispatch outcome — panel #442 defect 4)", () => {
  // Reply to any command with an executor FAILURE (ok:false). Mirrors a panel-side
  // graph executor rejecting — the bridge turns it into a plain Error with NO typed
  // dispatch flag, so a caller must NOT treat it as a pre-dispatch "nothing applied".
  function replyError(sock: WebSocket, errorText: string): void {
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) sock.send(JSON.stringify({ rid: msg.rid, ok: false, error: errorText }));
    });
  }

  it("a resolveTarget refusal (no connected tab) rejects with dispatched:false", async () => {
    // No panel connected; a non-mailboxable (interactive) command can't be routed.
    let caught: unknown;
    await bridge.send({ cmd: "graph_set_widget" }, { tabId: "ghost-tab" }).catch((e) => (caught = e));
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/no connected tab with id "ghost-tab"/);
    // THE contract the #442 wrapper keys on: this is provably pre-dispatch (nothing sent).
    expect(dispatchOutcomeOf(caught)).toBe(false);
  });

  it("lists the actually-connected tabs (not 'none') when OTHER tabs are live — still dispatched:false", async () => {
    const a = await connectPanel("tab-live-1111", "flux-workflow");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    let caught: unknown;
    await bridge.send({ cmd: "graph_set_widget" }, { tabId: "gone-tab" }).catch((e) => (caught = e));
    // Faithful message: the routing error names the live tab, proving the multi-tab
    // read/edit-channel disagreement (#442) — panel_list_workflows would still answer.
    expect((caught as Error).message).toMatch(/Connected:.*flux-workflow/);
    expect(dispatchOutcomeOf(caught)).toBe(false);
    a.close();
  });

  it("a real executor ok:false failure carries NO typed flag (dispatchOutcomeOf === undefined)", async () => {
    // The tab IS connected and DID receive the command — its executor merely failed, with
    // an error string that even QUOTES the routing phrase. The wrapper must never treat
    // this as "nothing applied": the flag is absent, not false.
    const a = await connectPanel("tab-exec-1111");
    replyError(a, 'graph_set_widget failed: stale ref to "no connected tab" in cache');
    await vi.waitFor(() => expect(bridge.connected()).toBe(true));
    let caught: unknown;
    await bridge.send({ cmd: "graph_set_widget" }, { tabId: "tab-exec-1111" }).catch((e) => (caught = e));
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("stale ref");
    expect(dispatchOutcomeOf(caught)).toBeUndefined(); // NOT false — it WAS dispatched
    a.close();
  });

  it("a mailboxable delivery to an offline tab RESOLVES (never a dispatched:false rejection)", async () => {
    // The offline-render mailbox path returns a resolved value, so it never acquires a
    // dispatch flag — the #442 wrapper only ever sees genuine rejections.
    const res = await bridge.send(
      { cmd: "show_media", items: [{ filename: "a.png" }] },
      { tabId: "offline-phone-1" },
    );
    expect(res).toMatchObject({ ok: true, mailboxed: true });
  });

  it("a successfully-acked command resolves (no dispatch flag involved)", async () => {
    const a = await connectPanel("tab-ok-1111");
    autoReply(a, "A");
    await vi.waitFor(() => expect(bridge.connected()).toBe(true));
    const result = await bridge.send({ cmd: "graph_set_widget" }, { tabId: "tab-ok-1111" });
    expect(result).toMatchObject({ from: "A" });
    a.close();
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

  it("records the tab's ComfyUI origin from hello and preserves it across a re-hello (#509)", async () => {
    const a = await connectPanel("tab-origin-1", "wf");
    a.send(
      JSON.stringify({
        type: "hello",
        tab_id: "tab-origin-1",
        title: "wf",
        comfyui_url: "http://127.0.0.1:8188",
      }),
    );
    await vi.waitFor(() => expect(bridge.tabOrigin("tab-origin-1")).toBe("http://127.0.0.1:8188"));
    // Token-less loopback primary listener → server-trusted local provenance.
    expect(bridge.tabIsLocal("tab-origin-1")).toBe(true);
    // A later re-hello that OMITS comfyui_url must not wipe the stored origin.
    a.send(JSON.stringify({ type: "hello", tab_id: "tab-origin-1", title: "wf" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.tabOrigin("tab-origin-1")).toBe("http://127.0.0.1:8188");
    // Unknown tab → undefined origin / not-local.
    expect(bridge.tabOrigin("nope")).toBeUndefined();
    expect(bridge.tabIsLocal("nope")).toBe(false);
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

  it("a MUTATING command dropped mid-command reports OUTCOME UNKNOWN, not a clean failure (#450)", async () => {
    const a = await connectPanel("tab-aaaa-1111");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    // graph_run queues a real render — it was already written to the socket before
    // the drop, so the panel may have applied it. A blind retry = double render.
    const promise = bridge.send({ cmd: "graph_run" }, { timeoutMs: 5000 });
    a.close();
    await expect(promise).rejects.toThrow(/OUTCOME UNKNOWN/);
    await expect(promise).rejects.toThrow(/graph_run/);
  });

  it("an IDEMPOTENT read dropped mid-command RESUMES when the tab reconnects (#450)", async () => {
    const a1 = await connectPanel("tab-aaaa-1111");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    // No autoReply on a1 → the read stays in-flight (un-acked) when we drop it.
    const promise = bridge.send({ cmd: "graph_get_errors" }, { timeoutMs: 5000 });
    // Ensure the command reached the server (is pending) before dropping the socket.
    await new Promise((r) => setTimeout(r, 50));
    a1.close();
    // Same tab reconnects within the grace window and answers the resumed read.
    const a2 = await connectPanel("tab-aaaa-1111");
    autoReply(a2, "A2");
    await expect(promise).resolves.toMatchObject({ from: "A2", cmd: "graph_get_errors" });
    a2.close();
  });

  it("resumes a read addressed by tab-id PREFIX after reconnect (canonical key) (#450)", async () => {
    const a1 = await connectPanel("tab-aaaa-1111");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    // Address by prefix — parking must key on the canonical resolved id, not "tab-aaaa".
    const promise = bridge.send({ cmd: "graph_get_errors" }, { tabId: "tab-aaaa", timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    a1.close();
    const a2 = await connectPanel("tab-aaaa-1111");
    autoReply(a2, "A2");
    await expect(promise).resolves.toMatchObject({ from: "A2" });
    a2.close();
  });

  it("does NOT extend the caller's deadline when a read resumes (#450)", async () => {
    const a1 = await connectPanel("tab-aaaa-1111");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    // Short deadline. Drop, reconnect with a tab that NEVER replies → must reject
    // near the original 300ms deadline, not restart a fresh full timeout.
    const started = Date.now();
    const promise = bridge.send({ cmd: "graph_get_errors" }, { timeoutMs: 300 });
    await new Promise((r) => setTimeout(r, 30));
    a1.close();
    const a2 = await connectPanel("tab-aaaa-1111"); // reconnects but never autoReplies
    await expect(promise).rejects.toThrow(/did not reply|genuinely gone/);
    expect(Date.now() - started).toBeLessThan(2000);
    a2.close();
  });

  it("an idempotent read whose tab never returns fails as genuinely gone (#450)", async () => {
    const a = await connectPanel("tab-aaaa-1111");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    const promise = bridge.send({ cmd: "graph_get_errors" }, { timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    a.close();
    // No reconnect → after the bounded grace it rejects as genuinely gone.
    await expect(promise).rejects.toThrow(/genuinely gone/);
  }, 10000);

  it("fails fast with guidance when no tab is connected", async () => {
    await expect(bridge.send({ cmd: "x" })).rejects.toThrow(/no panel connected/);
  });

  it("rejects an unknown tab_id with the connected-tab list", async () => {
    const a = await connectPanel("tab-aaaa-1111", "one");
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    await expect(bridge.send({ cmd: "x" }, { tabId: "nope" })).rejects.toThrow(/no connected tab/);
    a.close();
  });

  // #436 priority 4: the no-panel guidance must be ACTIONABLE. Before any tab has
  // connected, "install the pack" is right. But once a tab HAS connected and later
  // dropped (the post-restart / tab-reload window), the pack is provably installed —
  // so the guidance must send the user to refresh the ComfyUI browser tab, never to
  // diagnose a nonexistent install problem (the exact wrong path the report hit).
  describe("actionable no-panel guidance after a reconnect drop (#436.4)", () => {
    it("suggests installing the pack ONLY when nothing has ever connected", () => {
      // Fresh bridge (beforeEach) — no tab has ever helloed.
      const msg = bridge.status();
      expect(msg).toMatch(/pack installed/);
      expect(msg).not.toMatch(/refresh/i);
    });

    it("after a tab connected then dropped, tells the user to refresh the browser tab (not install)", async () => {
      const a = await connectPanel("wf:workflows/x.json", "x");
      await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
      a.close();
      await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(0));
      const msg = bridge.status();
      expect(msg).toMatch(/refresh/i);
      expect(msg).toMatch(/browser tab/i);
      // Must NOT send the agent to diagnose a (nonexistent) install problem.
      expect(msg).not.toMatch(/pack installed and check the Agent sidebar/);
    });

    it("a WRITE to the pre-restart id after the drop fails with the refresh guidance appended, keeping 'Connected: none'", async () => {
      const a = await connectPanel("wf:workflows/x.json", "x");
      await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
      a.close();
      await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(0));
      const err = await bridge
        .send({ cmd: "graph_add_node" }, { tabId: "wf:workflows/x.json" })
        .catch((e) => e as Error);
      expect(err).toBeInstanceOf(Error);
      // Machine-readable phrase preserved (retry/transient classifiers + tests key on it)…
      expect(err.message).toMatch(/no connected tab with id "wf:workflows\/x\.json"\. Connected: none/);
      // …now with the actionable refresh guidance appended.
      expect(err.message).toMatch(/refresh/i);
      // The refusal is BEFORE any socket write — nothing was dispatched (fail-closed).
      expect(dispatchOutcomeOf(err)).toBe(false);
    });

    it("a HEADLESS-only history (phone mirror, no desktop tab) never claims the desktop pack is installed", async () => {
      // A canvas-less mobile/remote pseudo-panel connects then drops. It proves neither
      // that the sidebar pack is installed nor that a browser tab exists to refresh, so
      // the zero-tab guidance must stay the conservative "install the pack" wording.
      const phone = await new Promise<WebSocket>((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${port}`);
        s.on("open", () => {
          s.send(JSON.stringify({ type: "hello", tab_id: "phone-1", title: "mirror", headless: true }));
          resolve(s);
        });
        s.on("error", reject);
      });
      await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
      phone.close();
      await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(0));
      const msg = bridge.status();
      expect(msg).toMatch(/pack installed/);
      expect(msg).not.toMatch(/refresh/i);
    });

    it("a still-live OTHER tab keeps the exact tab listing (not the refresh guidance)", async () => {
      const a = await connectPanel("tab-aaaa-1111", "one");
      await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
      const err = await bridge
        .send({ cmd: "graph_add_node" }, { tabId: "wf:workflows/gone.json" })
        .catch((e) => e as Error);
      expect(err.message).toMatch(/Connected: tab-aaaa/);
      expect(err.message).not.toMatch(/refresh/i);
      a.close();
    });
  });

  // #436 priority 1: reads must be HONEST about the binding — a read cannot resolve a
  // tab the write path can't. Both a read (graph_outline) and a write (graph_add_node)
  // routed to the SAME id resolve through the SAME registry, so in the zero-tab window
  // BOTH refuse identically (no read false-positive), and once a tab is live BOTH reach
  // it. This is the registry-consistency guarantee the reconnect race violated.
  describe("read/write resolve against the same tab registry (#436.1)", () => {
    it("in the zero-tab window a read and a write to the same id BOTH refuse (dispatched:false)", async () => {
      const a = await connectPanel("wf:workflows/x.json", "x");
      await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
      a.close();
      await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(0));
      const readErr = await bridge
        .send({ cmd: "graph_outline" }, { tabId: "wf:workflows/x.json", timeoutMs: 500 })
        .catch((e) => e as Error);
      const writeErr = await bridge
        .send({ cmd: "graph_add_node" }, { tabId: "wf:workflows/x.json", timeoutMs: 500 })
        .catch((e) => e as Error);
      expect(readErr).toBeInstanceOf(Error);
      expect(writeErr).toBeInstanceOf(Error);
      // The read did NOT falsely resolve while the write was refused — both dispatched:false.
      expect(dispatchOutcomeOf(readErr)).toBe(false);
      expect(dispatchOutcomeOf(writeErr)).toBe(false);
      expect(readErr.message).toMatch(/no connected tab with id "wf:workflows\/x\.json"/);
    });
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

  it("SCRUBS a client-forged migrated_from (codex review: rebind hijack)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    bridge.onPanelMessage = (ev) => void seen.push(ev as unknown as Record<string, unknown>);
    const sock = await connectPanel();
    autoReply(sock, "attacker");
    // Fresh socket, FIRST hello — no migration happened, but the client claims one.
    sock.send(JSON.stringify({ type: "hello", tab_id: "attacker-tab", migrated_from: "victim-tab" }));
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    const hello = seen.find((e) => e.type === "hello" && e.tab_id === "attacker-tab");
    expect(hello).toBeTruthy();
    expect(hello!.migrated_from).toBeUndefined();
    bridge.onPanelMessage = null;
    sock.close();
  });

  it("a DEAD socket's migration alias never routes to an unrelated tab reusing the id (deterministic wf: reuse)", async () => {
    // sockA: legacy id → wf:reused (migration created), then DIES.
    const sockA = await connectPanel();
    autoReply(sockA, "A");
    sockA.send(JSON.stringify({ type: "hello", tab_id: "legacy-old-id" }));
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    sockA.send(JSON.stringify({ type: "hello", tab_id: "wf:reused" }));
    await vi.waitFor(() => expect(bridge.tabs()[0]?.tab_id).toBe("wf:reused"));
    sockA.close();
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(0));

    // sockB: an UNRELATED tab that happens to get the same deterministic wf: id.
    const sockB = await connectPanel();
    autoReply(sockB, "B");
    sockB.send(JSON.stringify({ type: "hello", tab_id: "wf:reused" }));
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));

    // The old legacy id must NOT resolve to sockB's tab via the stale alias.
    await expect(bridge.send({ cmd: "x" }, { tabId: "legacy-old-id" })).rejects.toThrow(/no connected tab/);
    sockB.close();
  });

  it("canReach + resolveActiveTabId back the orchestrator's explicit self-heal (#322/#331/#332)", async () => {
    // A session was bound to old-tab, which then DIES and a genuinely new socket
    // reconnects under new-tab — NO migration alias (different socket, first hello).
    const sockOld = await connectPanel();
    autoReply(sockOld, "old");
    sockOld.send(JSON.stringify({ type: "hello", tab_id: "old-tab" }));
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    sockOld.close();
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(0));

    const sockNew = await connectPanel();
    autoReply(sockNew, "new");
    sockNew.send(JSON.stringify({ type: "hello", tab_id: "new-tab" }));
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));

    // The old id is orphaned (no migration) — canReach is false, and the no-tabId
    // resolution the orchestrator invokes at the explicit rebind lands on the sole
    // live tab. resolveTarget itself is NOT weakened: the old id still throws.
    expect(bridge.canReach("old-tab")).toBe(false);
    expect(bridge.canReach("new-tab")).toBe(true);
    expect(bridge.resolveActiveTabId()).toBe("new-tab");
    await expect(bridge.send({ cmd: "x" }, { tabId: "old-tab" })).rejects.toThrow(/no connected tab/);

    sockNew.close();
  });

  it("resolveActiveTabId throws (no guess) when 2+ tabs are connected with no last-active", async () => {
    const sockA = await connectPanel();
    autoReply(sockA, "A");
    sockA.send(JSON.stringify({ type: "hello", tab_id: "tab-a" }));
    const sockB = await connectPanel();
    autoReply(sockB, "B");
    sockB.send(JSON.stringify({ type: "hello", tab_id: "tab-b" }));
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(2));

    expect(() => bridge.resolveActiveTabId()).toThrow(/Multiple panel tabs/);
    sockA.close();
    sockB.close();
  });

  it("follows MIGRATION CHAINS: uuid → tmp: → wf: (the exact #210 field sequence)", async () => {
    // The reported failure re-helloed TWICE: legacy random UUID, then the
    // unsaved-tab tmp:<uuid> id, then the saved wf:<hash> id. The ORIGINAL id
    // must still resolve after both hops (single-hop lookup lands on the dead
    // tmp: id) — the map path-compresses so every historical id points at the
    // live tab.
    const sock = await connectPanel();
    autoReply(sock, "chained");
    const uuid = "6eccc826-592e-4abb-b280-35434e00ddd1";
    sock.send(JSON.stringify({ type: "hello", tab_id: uuid, title: "image_flux2_fp8" }));
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));

    sock.send(JSON.stringify({ type: "hello", tab_id: "tmp:7eab1234", title: "image_flux2_fp8" }));
    await vi.waitFor(() => expect(bridge.tabs()[0]?.tab_id).toBe("tmp:7eab1234"));

    sock.send(JSON.stringify({ type: "hello", tab_id: "wf:workf", title: "image_flux2_fp8" }));
    await vi.waitFor(() => expect(bridge.tabs()[0]?.tab_id).toBe("wf:workf"));

    // Every id along the chain resolves to the live tab.
    for (const id of [uuid, "tmp:7eab1234", "wf:workf"]) {
      const r = await bridge.send({ cmd: "ping" }, { tabId: id });
      expect(r).toMatchObject({ from: "chained" });
    }
    sock.close();
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

// ── Desktop-tab mirror: multi-viewer fanout (mobile remote control) ───────────
function connectHeadless(tabId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    sock.on("open", () => {
      sock.send(JSON.stringify({ type: "hello", tab_id: tabId, title: "phone", headless: true }));
      resolve(sock);
    });
    sock.on("error", reject);
  });
}

function nextFrame(
  sock: WebSocket,
  match: (m: Record<string, unknown>) => boolean,
  timeoutMs = 1500,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      sock.off("message", h);
      reject(new Error("timeout waiting for frame"));
    }, timeoutMs);
    function h(buf: WebSocket.RawData) {
      const m = JSON.parse(buf.toString());
      if (match(m)) {
        clearTimeout(t);
        sock.off("message", h);
        resolve(m);
      }
    }
    sock.on("message", h);
  });
}

const settle = () => new Promise((r) => setTimeout(r, 60));

describe("UiBridge — desktop-tab mirror (multi-viewer fanout)", () => {
  it("lists desktop tabs (excluding headless viewers), attaches, and fans push out to primary + viewer", async () => {
    const desktop = await connectPanel("desktop-1", "My Graph");
    const phone = await connectHeadless("phone-1");
    await settle();

    phone.send(JSON.stringify({ type: "list_tabs", cid: "c1" }));
    const list = await nextFrame(phone, (m) => m.type === "tab_list" && m.cid === "c1");
    const tabs = list.tabs as Array<{ tab_id: string; title: string }>;
    expect(tabs.map((t) => t.tab_id)).toContain("desktop-1");
    expect(tabs.find((t) => t.tab_id === "desktop-1")?.title).toBe("My Graph");
    expect(tabs.some((t) => t.tab_id === "phone-1")).toBe(false); // headless not listed

    phone.send(JSON.stringify({ type: "attach_tab", cid: "c2", target_tab_id: "desktop-1" }));
    const att = await nextFrame(phone, (m) => m.type === "tab_attached" && m.cid === "c2");
    expect(att.ok).toBe(true);
    expect(bridge.connected()).toBe(true); // attach did NOT evict the primary

    const onDesktop = nextFrame(desktop, (m) => m.type === "say" && m.text === "hello");
    const onPhone = nextFrame(phone, (m) => m.type === "say" && m.text === "hello");
    bridge.push({ type: "say", text: "hello" }, "desktop-1");
    await Promise.all([onDesktop, onPhone]); // both receive, or the test times out
  });

  it("canvas send() targets the primary only, never a mirror viewer", async () => {
    const desktop = await connectPanel("desktop-2", "G");
    autoReply(desktop, "desktop");
    const phone = await connectHeadless("phone-2");
    await settle();
    phone.send(JSON.stringify({ type: "attach_tab", cid: "a", target_tab_id: "desktop-2" }));
    await nextFrame(phone, (m) => m.type === "tab_attached");

    let phoneGotCmd = false;
    phone.on("message", (buf) => {
      if (JSON.parse(buf.toString()).cmd) phoneGotCmd = true;
    });
    const res = (await bridge.send({ cmd: "graph_state" } as { cmd: string }, {
      tabId: "desktop-2",
    })) as { from?: string };
    expect(res.from).toBe("desktop");
    await settle();
    expect(phoneGotCmd).toBe(false);
  });

  it("detach_tab stops the fanout", async () => {
    await connectPanel("desktop-3", "G");
    const phone = await connectHeadless("phone-3");
    await settle();
    phone.send(JSON.stringify({ type: "attach_tab", cid: "a", target_tab_id: "desktop-3" }));
    await nextFrame(phone, (m) => m.type === "tab_attached");
    phone.send(JSON.stringify({ type: "detach_tab" }));
    await settle();

    let phoneGotSay = false;
    phone.on("message", (buf) => {
      if (JSON.parse(buf.toString()).type === "say") phoneGotSay = true;
    });
    bridge.push({ type: "say", text: "after-detach" }, "desktop-3");
    await settle();
    expect(phoneGotSay).toBe(false);
  });

  it("never fans out a correlated reply (cid-bearing) to mirror viewers", async () => {
    await connectPanel("desktop-4", "G");
    const phone = await connectHeadless("phone-4");
    await settle();
    phone.send(JSON.stringify({ type: "attach_tab", cid: "a", target_tab_id: "desktop-4" }));
    await nextFrame(phone, (m) => m.type === "tab_attached");

    let phoneGotResult = false;
    phone.on("message", (buf) => {
      if (JSON.parse(buf.toString()).type === "tool_result") phoneGotResult = true;
    });
    // A tool_result for the desktop tab must NOT leak to the mirror viewer.
    bridge.push(
      { type: "tool_result", cid: "x", tool: "list_workflows", ok: true, result: [] },
      "desktop-4",
    );
    await settle();
    expect(phoneGotResult).toBe(false);
  });

  it("mirrors only allowlisted activity frames — never secret/correlated ones (cid-less too)", async () => {
    await connectPanel("desktop-8", "G");
    const phone = await connectHeadless("phone-8");
    await settle();
    phone.send(JSON.stringify({ type: "attach_tab", cid: "a", target_tab_id: "desktop-8" }));
    await nextFrame(phone, (m) => m.type === "tab_attached");

    const leaked: string[] = [];
    phone.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.type && m.type !== "tab_attached" && m.type !== "tab_list") leaked.push(m.type);
    });
    // cid-LESS correlated/secret frames that a denylist-by-cid would have leaked.
    bridge.push({ type: "pair_url", url: "https://pair.example/secret" }, "desktop-8");
    bridge.push({ type: "secret_saved", key: "CIVITAI_API_TOKEN" }, "desktop-8");
    bridge.push({ type: "ack", ok: true, kind: "new_session" }, "desktop-8");
    bridge.push({ type: "backends", backends: [] }, "desktop-8");
    // history_list reply to a NO-cid request → cid:undefined, would slip a cid guard.
    bridge.push({ type: "history_list", cid: undefined, sessions: [] }, "desktop-8");
    await settle();
    expect(leaked).toEqual([]); // nothing off the allowlist reached the viewer

    // …but a genuine activity frame still mirrors.
    const onPhone = nextFrame(phone, (m) => m.type === "say" && m.text === "hi");
    bridge.push({ type: "say", text: "hi" }, "desktop-8");
    await onPhone;
  });

  it("routes an attached viewer's input to the mirrored tab's session (remote control)", async () => {
    await connectPanel("desktop-9", "G");
    const phone = await connectHeadless("phone-9");
    await settle();
    const seen: Array<{ type?: string; tab_id?: string; text?: string }> = [];
    bridge.onPanelMessage = (e) => seen.push(e as { type?: string; tab_id?: string; text?: string });

    phone.send(JSON.stringify({ type: "attach_tab", cid: "a", target_tab_id: "desktop-9" }));
    await nextFrame(phone, (m) => m.type === "tab_attached");

    // The phone sends a chat message (no tab_id — the server stamps it). While
    // attached it must drive desktop-9's session, NOT the phone's own tab.
    phone.send(JSON.stringify({ type: "user_message", text: "drive it", context: {} }));
    await settle();
    const drove = seen.find((e) => e.type === "user_message" && e.text === "drive it");
    expect(drove?.tab_id).toBe("desktop-9");

    // After detach, the phone's input reverts to its own tab.
    phone.send(JSON.stringify({ type: "detach_tab" }));
    await settle();
    phone.send(JSON.stringify({ type: "user_message", text: "my own", context: {} }));
    await settle();
    const own = seen.find((e) => e.type === "user_message" && e.text === "my own");
    expect(own?.tab_id).toBe("phone-9");
  });

  it("rejects attach to a non-existent desktop tab", async () => {
    const phone = await connectHeadless("phone-5");
    await settle();
    phone.send(JSON.stringify({ type: "attach_tab", cid: "a", target_tab_id: "ghost" }));
    const att = await nextFrame(phone, (m) => m.type === "tab_attached");
    expect(att.ok).toBe(false);
  });

  it("keeps mirroring across a same-socket tab-id migration", async () => {
    const desktop = await connectPanel("old-id", "G");
    const phone = await connectHeadless("phone-6");
    await settle();
    phone.send(JSON.stringify({ type: "attach_tab", cid: "a", target_tab_id: "old-id" }));
    await nextFrame(phone, (m) => m.type === "tab_attached");

    // Desktop re-hellos under a NEW id on the SAME socket (the migration path).
    desktop.send(JSON.stringify({ type: "hello", tab_id: "new-id", title: "G" }));
    await settle();

    // The real scenario: the tab's AGENT keeps pushing under the ORIGINAL id
    // ("old-id") after the migration — the fan-out must resolve that through the
    // migration map to the moved subscriber set (keyed under the canonical id).
    // Pushing under the new id would mask the bug (codex review).
    const onPhone = nextFrame(phone, (m) => m.type === "say" && m.text === "post-migrate");
    bridge.push({ type: "say", text: "post-migrate" }, "old-id");
    await onPhone; // resolves, or the test times out (fan-out broke)
  });

  it("refuses a headless hello takeover of a desktop tab id (no drive-path hijack)", async () => {
    const desktop = await connectPanel("desktop-h", "G");
    autoReply(desktop, "desktop");
    const phone = await connectHeadless("phone-h");
    await settle();

    // Malicious: the phone re-hellos under the DESKTOP's id to seize it without
    // going through attach_tab. This must be refused — the desktop stays primary.
    phone.send(JSON.stringify({ type: "hello", tab_id: "desktop-h", title: "evil", headless: true }));
    await settle();

    const res = (await bridge.send({ cmd: "graph_state" } as { cmd: string }, {
      tabId: "desktop-h",
    })) as { from?: string };
    expect(res.from).toBe("desktop"); // desktop not evicted; the takeover was refused
  });

  it("refuses a hello takeover even when the viewer FORGES headless:false (kind is pinned)", async () => {
    const desktop = await connectPanel("desktop-hf", "G");
    autoReply(desktop, "desktop");
    // The phone's FIRST hello pins it as headless; connectHeadless sends headless:true.
    const phone = await connectHeadless("phone-hf");
    await settle();

    // The bypass: forge headless:false to match the desktop's kind. The pinned
    // socket kind must win, so this is still refused and the desktop stays primary.
    phone.send(JSON.stringify({ type: "hello", tab_id: "desktop-hf", title: "evil", headless: false }));
    await settle();

    const res = (await bridge.send({ cmd: "graph_state" } as { cmd: string }, {
      tabId: "desktop-hf",
    })) as { from?: string };
    expect(res.from).toBe("desktop"); // forged flag ignored — takeover refused
  });

  it("re-attaching to another tab stops the first tab's fanout", async () => {
    await connectPanel("desktop-A", "A");
    await connectPanel("desktop-B", "B");
    const phone = await connectHeadless("phone-ab");
    await settle();
    phone.send(JSON.stringify({ type: "attach_tab", cid: "1", target_tab_id: "desktop-A" }));
    await nextFrame(phone, (m) => m.type === "tab_attached" && m.cid === "1");
    phone.send(JSON.stringify({ type: "attach_tab", cid: "2", target_tab_id: "desktop-B" }));
    await nextFrame(phone, (m) => m.type === "tab_attached" && m.cid === "2");

    let gotA = false;
    phone.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.type === "say" && m.text === "from-A") gotA = true;
    });
    bridge.push({ type: "say", text: "from-A" }, "desktop-A"); // old tab — must NOT arrive
    const onB = nextFrame(phone, (m) => m.type === "say" && m.text === "from-B");
    bridge.push({ type: "say", text: "from-B" }, "desktop-B"); // new tab — must arrive
    await onB;
    expect(gotA).toBe(false);
  });

  it("reverts a viewer's drive to its own tab when the mirrored desktop closes", async () => {
    const desktop = await connectPanel("desktop-c", "G");
    const phone = await connectHeadless("phone-c");
    await settle();
    const seen: Array<{ type?: string; tab_id?: string; text?: string }> = [];
    bridge.onPanelMessage = (e) => seen.push(e as { type?: string; tab_id?: string; text?: string });

    phone.send(JSON.stringify({ type: "attach_tab", cid: "a", target_tab_id: "desktop-c" }));
    await nextFrame(phone, (m) => m.type === "tab_attached");

    desktop.close(); // the mirrored desktop goes away
    await settle();

    phone.send(JSON.stringify({ type: "user_message", text: "after-close", context: {} }));
    await settle();
    const msg = seen.find((e) => e.type === "user_message" && e.text === "after-close");
    expect(msg?.tab_id).toBe("phone-c"); // reverted to own tab, not routed into the dead id
  });
});

describe("markDispatched / dispatchOutcomeOf (typed dispatch outcome — #509 P1)", () => {
  it("carries a TYPED boolean that survives message-text and is undefined otherwise", () => {
    const preWrite = markDispatched(new Error("failed — NOT dispatched (OUTCOME UNKNOWN)"), false);
    const postWrite = markDispatched(new Error("disconnected mid-command — OUTCOME UNKNOWN"), true);
    expect(dispatchOutcomeOf(preWrite)).toBe(false); // categorically NOT-dispatched
    expect(dispatchOutcomeOf(postWrite)).toBe(true); // authoritative accepted drop
    // Plain errors / non-errors carry no signal.
    expect(dispatchOutcomeOf(new Error("disconnected mid-command"))).toBeUndefined();
    expect(dispatchOutcomeOf(undefined)).toBeUndefined();
    expect(dispatchOutcomeOf("OUTCOME UNKNOWN")).toBeUndefined();
    // The flag is non-enumerable (doesn't pollute JSON / spreads).
    expect(Object.keys(preWrite)).not.toContain("dispatched");
  });
});

describe("tabServerOrigin (server-observed handshake Origin — #509 spoof gate)", () => {
  const connectWithOrigin = (tabId: string, origin?: string, comfyuiUrl?: string): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : undefined);
      sock.on("open", () => {
        sock.send(
          JSON.stringify({ type: "hello", tab_id: tabId, title: "wf", comfyui_url: comfyuiUrl }),
        );
        resolve(sock);
      });
      sock.on("error", reject);
    });

  it("reflects the browser handshake Origin, NOT the client-supplied comfyui_url", async () => {
    // The hello CLAIMS a different comfyui_url than the real handshake Origin. The trusted
    // server-observed value must be the handshake Origin; the claim only shows in tabOrigin.
    const s = await connectWithOrigin("tab-origin-1", "http://127.0.0.1:8188", "http://evil.example:1");
    await vi.waitFor(() => expect(bridge.canReach("tab-origin-1")).toBe(true));
    expect(bridge.tabServerOrigin("tab-origin-1")).toBe("http://127.0.0.1:8188");
    expect(bridge.tabOrigin("tab-origin-1")).toBe("http://evil.example:1"); // spoofable claim
    s.close();
  });

  it("is undefined when the handshake carried no Origin (non-browser client)", async () => {
    const s = await connectWithOrigin("tab-origin-2", undefined, "http://127.0.0.1:8188");
    await vi.waitFor(() => expect(bridge.canReach("tab-origin-2")).toBe(true));
    expect(bridge.tabServerOrigin("tab-origin-2")).toBeUndefined();
    expect(bridge.tabServerOrigin("nope")).toBeUndefined();
    s.close();
  });

  it("normalizes to scheme://host:port — any path is stripped (Origin carries none)", async () => {
    // Even if a client sends a path-bearing value, the stored origin is authority-only, so
    // a path-mounted boot base is fail-closed (never falsely matched) downstream.
    const s = await connectWithOrigin("tab-origin-3", "http://127.0.0.1:8188/comfy");
    await vi.waitFor(() => expect(bridge.canReach("tab-origin-3")).toBe(true));
    expect(bridge.tabServerOrigin("tab-origin-3")).toBe("http://127.0.0.1:8188");
    s.close();
  });
});

describe("defaultBridgeTimeoutMs — tolerant read timeout (#357)", () => {
  it("gives READ (idempotent) ops the tolerant default, mutating ops the tight one", () => {
    // Every readonly command gets the tolerant bound…
    for (const readCmd of BRIDGE_READONLY_CMDS) {
      expect(defaultBridgeTimeoutMs(readCmd)).toBe(BRIDGE_READ_DEFAULT_TIMEOUT_MS);
    }
    // …and anything else (a render/edit) keeps the tight default.
    for (const mutateCmd of ["graph_run", "graph_add_node", "graph_move_node", "workflow_save"]) {
      expect(defaultBridgeTimeoutMs(mutateCmd)).toBe(BRIDGE_DEFAULT_TIMEOUT_MS);
    }
  });

  it("covers the OTHER main-thread graph reads that share the FBX-busy hazard (#357)", () => {
    // These run on the same busy panel main thread as graph_query and are
    // dispatched with no explicit timeout — they must be tolerant too.
    for (const readCmd of [
      "graph_view_selected",
      "graph_view_nodes_in_viewport",
      "graph_get_state",
      "graph_get_subgraph",
      "graph_outline",
    ]) {
      expect(BRIDGE_READONLY_CMDS.has(readCmd)).toBe(true);
      expect(defaultBridgeTimeoutMs(readCmd)).toBe(BRIDGE_READ_DEFAULT_TIMEOUT_MS);
    }
  });

  it("classifies refresh_nodes as a READ so it is parked/resumed on reconnect and gets the tolerant default (#608)", () => {
    // refresh_nodes only re-registers node defs + rebuilds combos (idempotent, no
    // graph mutation). It MUST be a read so a mid-command socket drop parks and
    // resumes it (not OUTCOME-UNKNOWN, which the orchestrator won't retry) and so a
    // slow /object_info fetch on a large install isn't cut off at the tight 6s.
    expect(BRIDGE_READONLY_CMDS.has("refresh_nodes")).toBe(true);
    expect(defaultBridgeTimeoutMs("refresh_nodes")).toBe(BRIDGE_READ_DEFAULT_TIMEOUT_MS);
  });

  it("graph_query is tolerant and STRICTLY longer than the old flat 6s default (#357)", () => {
    // The regression: graph_query used the flat 6000ms default and timed out while
    // Preview3D loaded a large FBX on a busy-but-alive main thread.
    expect(defaultBridgeTimeoutMs("graph_query")).toBe(20_000);
    expect(defaultBridgeTimeoutMs("graph_query")).toBeGreaterThan(6000);
    expect(defaultBridgeTimeoutMs("graph_query")).toBeGreaterThan(defaultBridgeTimeoutMs("graph_run"));
  });

  it("a no-timeout READ stays alive PAST the old 6s cutoff (end-to-end) (#357)", async () => {
    const a = await connectPanel("tab-aaaa-1111"); // never auto-replies
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    let settled = false;
    // No explicit timeout → send() applies the tolerant read default (20s). Swallow
    // the eventual late rejection so it never surfaces as an unhandled rejection
    // (the bridge is torn down in afterEach; the pending read settles then).
    void bridge.send({ cmd: "graph_query" }).then(
      () => { settled = true; },
      () => { settled = true; },
    );
    // Wait comfortably past the OLD 6000ms default: before the fix this would have
    // already rejected (settled === true); after it, the read is still in-flight.
    await new Promise((r) => setTimeout(r, 6500));
    expect(settled).toBe(false);
    a.close();
  }, 12000);

  it("an explicit timeout always overrides the read default", async () => {
    const a = await connectPanel("tab-aaaa-1111"); // never replies
    await vi.waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    await expect(bridge.send({ cmd: "graph_query" }, { timeoutMs: 120 })).rejects.toThrow(
      /did not reply to "graph_query" within 120 ms/,
    );
    a.close();
  });
});

describe("makeUnknownCommandError (old-panel version gate)", () => {
  it("rewrites an Unknown command reply into an actionable update message", () => {
    // ui_render is not in the per-command map, so it falls back to the blanket
    // full-set baseline minimum.
    const e = makeUnknownCommandError('Unknown command "ui_render"');
    expect(e).not.toBeNull();
    expect(e?.message).toContain("ui_render");
    expect(e?.message).toContain(MIN_PANEL_VERSION_FOR_BRIDGE_COMMANDS);
    expect(e?.message.toLowerCase()).toContain("update");
    expect(e?.message.toLowerCase()).toContain("reconnect");
    // The opaque raw internal error must not leak through.
    expect(e?.message).not.toBe('Unknown command "ui_render"');
  });

  // #352 — the quoted minimum is COMMAND-SPECIFIC, not a blanket 0.11.4. The old
  // code told users to update to ≥0.11.4 for graph_outline even though it has
  // shipped since panel 0.4.6 — an inflated, wrong requirement.
  it("quotes the command's OWN minimum panel version, not the blanket baseline", () => {
    expect(minPanelVersionForCmd("graph_outline")).toBe("0.4.6");
    const e = makeUnknownCommandError('Unknown command "graph_outline"');
    expect(e?.message).toContain("0.4.6");
    expect(e?.message).not.toContain(MIN_PANEL_VERSION_FOR_BRIDGE_COMMANDS);
  });

  it("includes the detected panel version when known", () => {
    const e = makeUnknownCommandError('Unknown command "ui_render"', "0.6.8");
    expect(e?.message).toContain("0.6.8");
  });

  // #352 FALSE-NEGATIVE boundary: a panel that ADVERTISES a version at/above the
  // command's real minimum must NEVER be told it is "too old". An Unknown-command
  // reply from a provably-new-enough panel is not an age problem, so it is NOT
  // rewritten (returns null → the raw error surfaces, the #236 gate is not poisoned).
  it("does NOT declare a new-enough panel too old (advertised version meets the minimum)", () => {
    // graph_outline needs 0.4.6; a 0.11.21 panel is well past it.
    expect(makeUnknownCommandError('Unknown command "graph_outline"', "0.11.21")).toBeNull();
    // Exactly-at-the-boundary is new enough (>=), so also not rewritten.
    expect(makeUnknownCommandError('Unknown command "graph_outline"', "0.4.6")).toBeNull();
  });

  // An UNPARSEABLE advertised version must NOT be mistaken for new-enough
  // (compareSemver returns 0 both for "equal" and "unparseable"). Without the
  // parse screen, `panel_version: "dev"` would compare as 0 (>= 0 → "supported")
  // and wrongly leak the raw error / skip the #236 learning path.
  it("treats an unparseable advertised version as NOT proven new enough (still too old)", () => {
    for (const bad of ["dev", "unknown", "latest", ""]) {
      const e = makeUnknownCommandError('Unknown command "graph_outline"', bad);
      expect(e).not.toBeNull();
      expect(e?.message.toLowerCase()).toContain("too old");
    }
  });

  it("still declares a genuinely-too-old panel too old (advertised version below the minimum)", () => {
    // One patch below graph_outline's 0.4.6 minimum → genuinely too old.
    const e = makeUnknownCommandError('Unknown command "graph_outline"', "0.4.5");
    expect(e).not.toBeNull();
    expect(e?.message.toLowerCase()).toContain("too old");
    expect(e?.message).toContain("0.4.5"); // detected version surfaced
    expect(e?.message).toContain("0.4.6"); // correct minimum quoted
  });

  it("passes through a genuine command error (returns null)", () => {
    expect(makeUnknownCommandError("node 5 not found")).toBeNull();
    expect(makeUnknownCommandError("panel reported an error")).toBeNull();
  });

  it("does NOT rewrite an error that merely quotes the phrase mid-message (anchored)", () => {
    // A genuine command failure whose text happens to embed the phrase must pass
    // through untouched — only the panel dispatcher's own leading reply matches.
    expect(
      makeUnknownCommandError('graph_run failed: node emitted Unknown command "foo" to stdout'),
    ).toBeNull();
  });

  it("tolerates smart quotes and varied casing", () => {
    expect(makeUnknownCommandError("unknown command “graph_serialize”")?.message).toContain(
      "graph_serialize",
    );
  });
});

describe("panelVersionProvesUnsupported (#392 proactive version gate)", () => {
  it("is TRUE only for a listed command whose verified minimum the parseable version undercuts", () => {
    // graph_query shipped at panel 0.7.0 (changelog-verified).
    expect(panelVersionProvesUnsupported("graph_query", "0.6.8")).toBe(true);
    expect(panelVersionProvesUnsupported("graph_query", "0.6.99")).toBe(true);
    // At or above the minimum → supported → not proven-unsupported.
    expect(panelVersionProvesUnsupported("graph_query", "0.7.0")).toBe(false);
    expect(panelVersionProvesUnsupported("graph_query", "0.11.21")).toBe(false);
  });

  it("NEVER gates an unlisted command (would otherwise inherit the inflated 0.11.4 baseline and false-gate an early-but-capable panel)", () => {
    // graph_get_errors / graph_set_widget / ui_render shipped long before 0.11.4 but
    // are NOT in BRIDGE_CMD_MIN_PANEL_VERSION — proactively gating them off the
    // fallback baseline would wrongly block a 0.4.6–0.11.3 panel that supports them.
    expect(panelVersionProvesUnsupported("graph_get_errors", "0.6.8")).toBe(false);
    expect(panelVersionProvesUnsupported("graph_set_widget", "0.9.0")).toBe(false);
    expect(panelVersionProvesUnsupported("ui_render", "0.6.8")).toBe(false);
  });

  it("returns FALSE for a missing or unparseable version (can't prove it — fall through to the reactive path)", () => {
    expect(panelVersionProvesUnsupported("graph_query", undefined)).toBe(false);
    expect(panelVersionProvesUnsupported("graph_query", "")).toBe(false);
    expect(panelVersionProvesUnsupported("graph_query", "dev")).toBe(false);
    expect(panelVersionProvesUnsupported("graph_query", "nightly-2026")).toBe(false);
  });

  it("gates graph_serialize (0.8.2) and leaves graph_outline (0.4.6) effectively ungated for any modern panel", () => {
    expect(panelVersionProvesUnsupported("graph_serialize", "0.8.1")).toBe(true);
    expect(panelVersionProvesUnsupported("graph_serialize", "0.8.2")).toBe(false);
    expect(panelVersionProvesUnsupported("graph_outline", "0.4.5")).toBe(true);
    expect(panelVersionProvesUnsupported("graph_outline", "0.4.6")).toBe(false);
    expect(panelVersionProvesUnsupported("graph_outline", "0.11.7")).toBe(false);
  });
});

// #413 — the bridge REWRITES a panel's raw "Unknown command graph_serialize" into
// a "too old for graph_serialize" message (and throws the same, tagged, from the
// #236 proactive gate). A caller with a back-compat fallback (panel_strip_workflow
// → graph_get_state) needs to detect that condition WITHOUT string-matching the
// literal "unknown command" text that was rewritten away. isPanelCmdUnsupportedError
// reads the STRUCTURED tag buildPanelTooOldError attaches, with a message-regex
// fallback for errors that never passed through the rewrite.
describe("isPanelCmdUnsupportedError (#413 structured unsupported-command detection)", () => {
  it("detects the STRUCTURED tag on a rewritten 'too old' error (the reactive path)", () => {
    // makeUnknownCommandError funnels through buildPanelTooOldError, which tags
    // the error with panelCmdUnsupported — even though the message no longer says
    // "unknown command".
    const e = makeUnknownCommandError('Unknown command "graph_serialize"');
    expect(e).not.toBeNull();
    expect(e?.message.toLowerCase()).not.toContain("unknown command");
    expect(isPanelCmdUnsupportedError(e)).toBe(true);
    expect(isPanelCmdUnsupportedError(e, "graph_serialize")).toBe(true);
    // A tag for a DIFFERENT command must not match a specific query.
    expect(isPanelCmdUnsupportedError(e, "graph_outline")).toBe(false);
  });

  it("matches the raw panel 'Unknown command' text (untagged fallback)", () => {
    expect(isPanelCmdUnsupportedError(new Error('Unknown command "graph_serialize"'))).toBe(true);
    expect(
      isPanelCmdUnsupportedError(new Error('Unknown command "graph_serialize"'), "graph_serialize"),
    ).toBe(true);
    expect(
      isPanelCmdUnsupportedError(new Error('Unknown command "graph_serialize"'), "graph_outline"),
    ).toBe(false);
  });

  it("matches the rewritten 'too old for' text even without the tag", () => {
    const raw = new Error('This ComfyUI-MCP panel is too old for "graph_serialize" — update…');
    expect(isPanelCmdUnsupportedError(raw)).toBe(true);
    expect(isPanelCmdUnsupportedError(raw, "graph_serialize")).toBe(true);
  });

  it("does NOT match a genuine transport/timeout error (fallback must not fire)", () => {
    expect(isPanelCmdUnsupportedError(new Error("bridge ack timed out after 30000ms"))).toBe(false);
    expect(isPanelCmdUnsupportedError(new Error("panel not reachable"))).toBe(false);
    expect(isPanelCmdUnsupportedError(undefined)).toBe(false);
    expect(isPanelCmdUnsupportedError(null)).toBe(false);
  });
});

describe("UiBridge.send (graceful gate end-to-end)", () => {
  it("surfaces an actionable message (with panel version) when an old panel rejects a bridge command", async () => {
    const sock = await connectPanel(undefined);
    // Old panel: advertises its version, then rejects unknown bridge commands.
    sock.send(JSON.stringify({ type: "hello", tab_id: "old-tab", title: "wf", panel_version: "0.6.8" }));
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        sock.send(
          JSON.stringify({ rid: msg.rid, ok: false, error: `Unknown command "${msg.cmd}"` }),
        );
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    await expect(bridge.send({ cmd: "graph_query" }, { tabId: "old-tab" })).rejects.toThrow(
      /too old for "graph_query".*0\.6\.8.*update/is,
    );
  });

  // #236 — for a command with NO changelog-verified per-command minimum (so the
  // advertised version can't PROVE it unsupported in advance — see the #392 proactive
  // gate below), the FIRST call still round-trips to discover it's unsupported, and
  // every LATER call in the same session is gated proactively: rejected with the same
  // actionable message WITHOUT ever reaching the panel again. FAIL-before: the old
  // code always re-dispatched and re-parsed the panel's raw "Unknown command" string
  // on every single call. ui_render is used precisely because it is NOT in
  // BRIDGE_CMD_MIN_PANEL_VERSION, so only the REACTIVE (#236) path can gate it.
  it("gates a REPEAT call to an already-proven-unsupported command without re-dispatching to the panel", async () => {
    const sock = await connectPanel(undefined);
    let dispatchCount = 0;
    sock.send(JSON.stringify({ type: "hello", tab_id: "old-tab-2", title: "wf", panel_version: "0.6.8" }));
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        dispatchCount += 1;
        sock.send(JSON.stringify({ rid: msg.rid, ok: false, error: `Unknown command "${msg.cmd}"` }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    // First call: genuinely round-trips (no per-command minimum to prove it unsupported).
    await expect(bridge.send({ cmd: "ui_render" }, { tabId: "old-tab-2" })).rejects.toThrow(
      /too old for "ui_render"/i,
    );
    expect(dispatchCount).toBe(1);

    // Second call: gated proactively (learned) — same actionable message, but the panel
    // must NEVER see a second dispatch of this command.
    await expect(bridge.send({ cmd: "ui_render" }, { tabId: "old-tab-2" })).rejects.toThrow(
      /too old for "ui_render".*0\.6\.8.*update/is,
    );
    expect(dispatchCount).toBe(1);
  });

  // #392 — a command WITH a changelog-verified minimum (graph_query → 0.7.0), on a
  // panel whose ADVERTISED version parseably undercuts it (0.6.8), is gated PROACTIVELY
  // on the VERY FIRST call: the panel must never see a dispatch at all, and the honest,
  // correctly-versioned (≥0.7.0, NOT the inflated 0.11.4 baseline) verdict is returned
  // immediately. FAIL-before (#392): the tool was exposed/dispatched, the panel rejected
  // it at runtime, and only THEN was a verdict synthesized from the round-trip reply.
  it("PROACTIVELY gates a listed command the advertised version proves too old — no dispatch on the first call (#392)", async () => {
    const sock = await connectPanel(undefined);
    let dispatchCount = 0;
    sock.send(JSON.stringify({ type: "hello", tab_id: "old-tab-2b", title: "wf", panel_version: "0.6.8" }));
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        dispatchCount += 1;
        sock.send(JSON.stringify({ rid: msg.rid, ok: false, error: `Unknown command "${msg.cmd}"` }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    await expect(bridge.send({ cmd: "graph_query" }, { tabId: "old-tab-2b" })).rejects.toThrow(
      /too old for "graph_query".*0\.7\.0.*update/is,
    );
    // The FIRST call is gated before dispatch — the panel is never asked.
    expect(dispatchCount).toBe(0);
  });

  // A command that has NEVER been tried on this connection must never be
  // pre-emptively blocked by another command's failure (no blanket gate — only
  // the SPECIFIC cmd that was empirically proven unsupported is gated).
  it("does NOT gate a different, never-tried command after another command was proven unsupported", async () => {
    const sock = await connectPanel(undefined);
    sock.send(JSON.stringify({ type: "hello", tab_id: "old-tab-3", title: "wf", panel_version: "0.6.8" }));
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (!msg.rid || !msg.cmd) return;
      if (msg.cmd === "graph_query") {
        sock.send(JSON.stringify({ rid: msg.rid, ok: false, error: `Unknown command "${msg.cmd}"` }));
      } else {
        // Every other command this (otherwise old) panel actually DOES support.
        sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { cmd: msg.cmd } }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    await expect(bridge.send({ cmd: "graph_query" }, { tabId: "old-tab-3" })).rejects.toThrow(
      /too old for "graph_query"/i,
    );
    // graph_add_node must still be dispatched normally and succeed.
    const res = await bridge.send({ cmd: "graph_add_node" }, { tabId: "old-tab-3" });
    expect(res).toEqual({ cmd: "graph_add_node" });
  });

  // A reconnect (fresh hello) may be an updated panel build — a previously
  // learned "unsupported" verdict must never carry over and permanently block a
  // command the NEW connection could actually support.
  it("clears the learned-unsupported set on a fresh hello (reconnect may be an updated panel)", async () => {
    const sock1 = await connectPanel(undefined);
    sock1.send(JSON.stringify({ type: "hello", tab_id: "old-tab-4", title: "wf", panel_version: "0.6.8" }));
    sock1.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        sock1.send(JSON.stringify({ rid: msg.rid, ok: false, error: `Unknown command "${msg.cmd}"` }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));
    await expect(bridge.send({ cmd: "graph_query" }, { tabId: "old-tab-4" })).rejects.toThrow(
      /too old for "graph_query"/i,
    );

    // Reconnect under the same tab id with a NEWER panel that now supports it.
    const sock2 = await connectPanel(undefined);
    sock2.send(JSON.stringify({ type: "hello", tab_id: "old-tab-4", title: "wf", panel_version: "0.11.4" }));
    sock2.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        sock2.send(JSON.stringify({ rid: msg.rid, ok: true, result: { cmd: msg.cmd } }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    const res = await bridge.send({ cmd: "graph_query" }, { tabId: "old-tab-4" });
    expect(res).toEqual({ cmd: "graph_query" });
  });

  // #392 regression (codex WS review): panelVersion is INHERITED across a reconnect
  // that OMITS panel_version (so the reactive message can still quote a detected
  // version). That inherited, possibly-STALE version must NOT drive the proactive gate
  // — a reconnect may be a freshly UPGRADED panel. An old 0.6.8 connection followed by
  // a capable panel reconnecting under the same tab id WITHOUT re-advertising its
  // version must have its FIRST graph_query DISPATCHED (and succeed), never gated
  // unprobed. FAIL-before (had the gate keyed only on panelVersion): the inherited
  // 0.6.8 would proactively reject graph_query forever until yet another reconnect.
  it("does NOT proactively gate a reconnect that omits panel_version (inherited stale version must not block an upgraded panel) (#392)", async () => {
    const sock1 = await connectPanel(undefined);
    sock1.send(JSON.stringify({ type: "hello", tab_id: "reconn-tab", title: "wf", panel_version: "0.6.8" }));
    await new Promise((r) => setTimeout(r, 50));
    // First connection: advertised 0.6.8 → graph_query is proactively gated.
    await expect(bridge.send({ cmd: "graph_query" }, { tabId: "reconn-tab" })).rejects.toThrow(
      /too old for "graph_query"/i,
    );

    // Reconnect under the SAME tab id, this time WITHOUT panel_version, on a panel that
    // DOES support graph_query. The version is inherited (0.6.8) for messaging only.
    let dispatched = false;
    const sock2 = await connectPanel(undefined);
    sock2.send(JSON.stringify({ type: "hello", tab_id: "reconn-tab", title: "wf" }));
    sock2.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        dispatched = true;
        sock2.send(JSON.stringify({ rid: msg.rid, ok: true, result: { cmd: msg.cmd } }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    const res = await bridge.send({ cmd: "graph_query" }, { tabId: "reconn-tab" });
    expect(res).toEqual({ cmd: "graph_query" });
    // Proof it was actually PROBED, not answered from a stale proactive gate.
    expect(dispatched).toBe(true);
  });

  // #422 — DEMONSTRATED capability VETOES the proactive version gate. A panel that
  // has ALREADY served graph_query in this connection must never be re-gated as
  // "too old" just because a LATER re-hello (triggered by live graph edits) advertises
  // a version that parseably undercuts the declared minimum. FAIL-before: the #392 gate
  // read only the advertised version, so the second, undercutting hello flipped the gate
  // closed and graph_query — which had just succeeded twice — started returning "too old".
  it("does NOT re-gate a command the connection ALREADY served after an undercutting re-hello (#422)", async () => {
    let dispatchCount = 0;
    // First hello OMITS panel_version (browser-cached panel that predates advertising) —
    // so the proactive gate is skipped and graph_query round-trips and SUCCEEDS.
    const sock1 = await connectPanel(undefined);
    sock1.send(JSON.stringify({ type: "hello", tab_id: "served-tab", title: "wf" }));
    sock1.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        dispatchCount += 1;
        sock1.send(JSON.stringify({ rid: msg.rid, ok: true, result: { cmd: msg.cmd } }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    // Two successful graph_query calls — the panel demonstrably supports it.
    expect(await bridge.send({ cmd: "graph_query" }, { tabId: "served-tab" })).toEqual({
      cmd: "graph_query",
    });
    expect(await bridge.send({ cmd: "graph_query" }, { tabId: "served-tab" })).toEqual({
      cmd: "graph_query",
    });

    // Graph edits trigger a re-hello under the SAME tab id, this time ADVERTISING a
    // version (0.6.8) that parseably undercuts graph_query's 0.7.0 minimum. The panel
    // code did not change — capability was proven — so the gate must NOT fire.
    const sock2 = await connectPanel(undefined);
    sock2.send(
      JSON.stringify({ type: "hello", tab_id: "served-tab", title: "wf", panel_version: "0.6.8" }),
    );
    let redispatched = false;
    sock2.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        redispatched = true;
        sock2.send(JSON.stringify({ rid: msg.rid, ok: true, result: { cmd: msg.cmd } }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    const after = await bridge.send({ cmd: "graph_query" }, { tabId: "served-tab" });
    expect(after).toEqual({ cmd: "graph_query" });
    // Proof the veto worked by DISPATCHING, not by a stale gate rejecting it.
    expect(redispatched).toBe(true);
  });

  // #422 — the proven veto must SURVIVE a same-socket tab-id MIGRATION (tmp:<uuid> →
  // wf:<hash>), which is exactly what a workflow-tab switch / graph edit triggers. A
  // command served under the pre-migration id, then an undercutting-version hello under
  // the migrated id, must NOT be re-gated. FAIL-before: the migration deletes the old
  // conn, so the new conn started with an empty proven set and the gate fired.
  it("carries the proven veto across a same-socket tab-id migration (#422)", async () => {
    const sock = await connectPanel(undefined);
    // First hello under a tmp id, omitting panel_version → graph_query round-trips + succeeds.
    sock.send(JSON.stringify({ type: "hello", tab_id: "tmp:mig-uuid", title: "wf" }));
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { cmd: msg.cmd } }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await bridge.send({ cmd: "graph_query" }, { tabId: "tmp:mig-uuid" })).toEqual({
      cmd: "graph_query",
    });

    // SAME socket re-hellos under the migrated wf id, now advertising an undercutting
    // version. The migration carries the proven veto, so graph_query still dispatches.
    sock.send(
      JSON.stringify({ type: "hello", tab_id: "wf:mig-hash", title: "wf", panel_version: "0.6.8" }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(await bridge.send({ cmd: "graph_query" }, { tabId: "wf:mig-hash" })).toEqual({
      cmd: "graph_query",
    });
  });

  // #422 safety — the veto must NOT mask a genuine DOWNGRADE. If a reconnect reintroduces
  // a build that truly lacks the command, its own "Unknown command" reply clears the
  // proven-supported entry, and the reactive (#236) gate then blocks later calls.
  it("still gates after a genuine downgrade replies Unknown command, clearing the proven veto (#422)", async () => {
    const sock1 = await connectPanel(undefined);
    sock1.send(JSON.stringify({ type: "hello", tab_id: "downgrade-tab", title: "wf" }));
    sock1.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        sock1.send(JSON.stringify({ rid: msg.rid, ok: true, result: { cmd: msg.cmd } }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await bridge.send({ cmd: "graph_query" }, { tabId: "downgrade-tab" })).toEqual({
      cmd: "graph_query",
    });

    // Reconnect: an OLDER build under the same tab id that rejects graph_query.
    const sock2 = await connectPanel(undefined);
    sock2.send(
      JSON.stringify({ type: "hello", tab_id: "downgrade-tab", title: "wf", panel_version: "0.6.8" }),
    );
    sock2.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        sock2.send(JSON.stringify({ rid: msg.rid, ok: false, error: `Unknown command "${msg.cmd}"` }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    // The real rejection surfaces and clears the veto, so the connection now knows it's
    // unsupported — a later call is gated (reactively learned).
    await expect(bridge.send({ cmd: "graph_query" }, { tabId: "downgrade-tab" })).rejects.toThrow(
      /too old for "graph_query"/i,
    );
    await expect(bridge.send({ cmd: "graph_query" }, { tabId: "downgrade-tab" })).rejects.toThrow(
      /too old for "graph_query"/i,
    );
  });

  // #352 FALSE NEGATIVE end-to-end: a NEW-ENOUGH panel (advertises 0.11.21, well
  // past graph_outline's 0.4.6 minimum) that nonetheless replies "Unknown command
  // graph_outline" must NOT be told it's too old, and — critically — must NOT be
  // poisoned into the #236 proactive gate, so a later call still reaches the panel.
  it("does NOT rewrite/gate an Unknown-command reply from a panel that ADVERTISES a new-enough version (#352)", async () => {
    const sock = await connectPanel(undefined);
    let dispatchCount = 0;
    let replyUnknown = true;
    sock.send(
      JSON.stringify({ type: "hello", tab_id: "new-tab", title: "wf", panel_version: "0.11.21" }),
    );
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (!msg.rid || !msg.cmd) return;
      dispatchCount += 1;
      if (replyUnknown) {
        sock.send(JSON.stringify({ rid: msg.rid, ok: false, error: `Unknown command "${msg.cmd}"` }));
      } else {
        sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { cmd: msg.cmd } }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    // First call: the raw error surfaces (NOT a "too old — update your panel" verdict).
    await expect(bridge.send({ cmd: "graph_outline" }, { tabId: "new-tab" })).rejects.toThrow(
      /unknown command/i,
    );
    await expect(
      bridge.send({ cmd: "graph_outline" }, { tabId: "new-tab" }),
    ).rejects.not.toThrow(/too old/i);
    expect(dispatchCount).toBe(2); // NOT gated — the panel was re-reached, not poisoned.

    // Prove the gate was never poisoned: once the panel answers normally, it works.
    replyUnknown = false;
    const res = await bridge.send({ cmd: "graph_outline" }, { tabId: "new-tab" });
    expect(res).toEqual({ cmd: "graph_outline" });
  });

  it("tags a POST-write reply-timeout as dispatched:true (frozen tab may still apply it — #509)", async () => {
    // A connected tab that NEVER replies: sock.send() succeeds, then the reply timer fires.
    // The command WAS written, so the rejection must carry the typed dispatched:true flag.
    const sock = await connectPanel("frozen-tab", "wf");
    await vi.waitFor(() => expect(bridge.canReach("frozen-tab")).toBe(true));
    let caught: unknown;
    try {
      await bridge.send({ cmd: "comfy_reboot" }, { tabId: "frozen-tab", timeoutMs: 40 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/did not reply.*backgrounded or frozen/i);
    expect(dispatchOutcomeOf(caught)).toBe(true); // POST-write → accepted-but-unacked
    sock.close();
  });
});

// ── #486: a validated ask_user answer that lands AFTER the reply timeout must be
// buffered (keyed by ask_id) so the caller can still retrieve it, not discarded.
describe("UiBridge (late ask_user answer buffer — #486)", () => {
  it("buffers a valid ask_user reply that arrives after the reply timeout", async () => {
    const sock = await connectPanel("tab-ask", "wf");
    await vi.waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tab-ask")).toBe(true));
    // The panel validates a pick only AFTER the send's short reply timeout fires.
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd === "ask_user") {
        setTimeout(() => {
          sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: "Late Pick" }));
        }, 80);
      }
    });

    await expect(
      bridge.send(
        { cmd: "ask_user", ask_id: "ask-xyz", question: "?", options: [] },
        { tabId: "tab-ask", timeoutMs: 30 },
      ),
    ).rejects.toThrow(/did not reply/i);

    // The late-but-valid answer must be recoverable via the buffer, then drained.
    await vi.waitFor(() => expect(bridge.takeLateAskReply("ask-xyz")).toBe("Late Pick"));
    expect(bridge.takeLateAskReply("ask-xyz")).toBeUndefined(); // drained once
  });

  it("does not buffer a non-ask command's late reply (no ask_id → dropped)", async () => {
    const sock = await connectPanel("tab-plain", "wf");
    await vi.waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tab-plain")).toBe(true));
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd === "graph_outline") {
        setTimeout(() => {
          sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { late: true } }));
        }, 80);
      }
    });
    await expect(
      bridge.send({ cmd: "graph_outline" }, { tabId: "tab-plain", timeoutMs: 30 }),
    ).rejects.toThrow(/did not reply|disconnected|gone/i);
    // Give the late reply time to land; it must NOT be buffered under any ask id.
    await new Promise((r) => setTimeout(r, 120));
    expect(bridge.takeLateAskReply("tab-plain")).toBeUndefined();
  });
});
