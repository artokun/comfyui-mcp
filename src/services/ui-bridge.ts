// UI bridge: a loopback WebSocket server the comfyui-mcp-panel pack connects
// to. The panel orchestrator calls `send(cmd)` and awaits the panel's
// rid-correlated reply — a background Claude agent drives the live ComfyUI
// graph over this bridge, with zero LLM API keys.
//
// MULTI-TAB: each ComfyUI browser tab holds its own connection, identified by
// a per-tab session id the panel sends in its `hello` frame (plus the open
// workflow's title, so the agent can tell tabs apart). Commands route by:
// explicit tab_id → the only connected tab → the tab the user most recently
// typed in → error listing connected tabs. Workflows are per-tab in ComfyUI,
// so there is no cross-tab state sync — just per-tab routing.
//
// Wire design ported from node-lab's mcp/bridge.ts (same author): every
// request is `{ rid, cmd, ...args }`; the panel replies `{ rid, ok, result }`
// or `{ rid, ok: false, error }`. Frames WITHOUT a rid are panel-initiated
// events (`hello`, `user_message`) and flow to `onPanelMessage`.

import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "../utils/logger.js";

export const DEFAULT_BRIDGE_PORT = 9101;

/**
 * The subset of the `ws` WebSocket surface `handleConnection` actually needs.
 * A real `ws.WebSocket` satisfies this structurally. It also lets a non-network
 * pseudo-socket plug in — the relay client (see relay-client.ts) wraps each
 * relay-multiplexed panel connection in an object satisfying this interface so
 * it can be handed to `attachRelayConnection` and treated identically to a
 * directly-connected loopback socket by all of this class's routing/reply logic.
 */
export interface BridgeSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  terminate(): void;
  ping(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

export interface PanelEvent {
  type: string;
  text?: string;
  tab_id?: string;
  title?: string;
  /** Stamped by the panel on user_message: where the user is looking. */
  context?: { workflow?: string; subgraph?: string };
  [key: string]: unknown;
}

export interface PanelTab {
  tab_id: string;
  title: string;
  connected_at: string;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

interface Conn {
  sock: BridgeSocket;
  tabId: string;
  title: string;
  connectedAt: string;
  /** Canvas-less client (mobile/remote pseudo-panel) — advertised in `hello`.
   *  Lets tools resolve media to inline bytes instead of a browser /view ref. */
  headless: boolean;
}

export interface BridgeCommand {
  cmd: string;
  [key: string]: unknown;
}

export class UiBridge {
  /** Max EADDRINUSE retries before degrading to "panel unavailable". */
  private static readonly MAX_BIND_ATTEMPTS = 5;
  /** Backoff base; delays are 200, 400, 800, 1600, 3200ms (~6.2s total). */
  private static readonly BIND_RETRY_BASE_MS = 200;
  /** WebSocket keepalive: ping every 25s so a proxied connection (the cloudflared
   *  tunnel behind a secure wss:// bridge) is never idle long enough for Cloudflare
   *  to reap it (~100s idle timeout) during a long, quiet agent turn. Harmless on
   *  loopback. */
  private static readonly HEARTBEAT_MS = 25_000;
  /** Terminate a socket only after this many consecutive missed pongs (~50s of
   *  silence) — lenient enough that a briefly-backgrounded/throttled tab isn't
   *  falsely dropped, strict enough to reap a silently-dead tunnel connection. */
  private static readonly MAX_MISSED_PONGS = 2;

  private wss: WebSocketServer | null = null;
  /** Extra always-token-gated listeners — the on-demand phone-pairing bind (LAN
   *  and/or a loopback port a cloudflared tunnel fronts). Their connections route
   *  through the same tab/rid logic as the primary bridge; the primary loopback
   *  listener stays token-less so the local browser panel is unaffected. */
  private readonly extraServers: WebSocketServer[] = [];
  private conns = new Map<string, Conn>(); // tabId -> connection
  /**
   * Tab-id migrations (oldTabId → newTabId). When a panel socket re-hellos under
   * a NEW tab id (e.g. after a panel update that changed the id scheme from
   * random UUID to deterministic tmp:/wf: prefixed ids), the old id is mapped to
   * the new one so agent sessions that were bound to the old id can still resolve
   * their target via resolveTarget — the session self-heals instead of throwing
   * "no connected tab with id …" on every panel_* call.
   */
  private tabMigrations = new Map<string, string>();
  /** Per-tab "mailbox" of undeliverable render deliveries (show_media), buffered
   *  while a client is OFFLINE and flushed on reconnect — so a finished render is
   *  never lost when the mobile app is backgrounded/killed mid-render. Keyed by a
   *  STABLE tab id (the phone persists one). In-memory: survives disconnect ⇄
   *  reconnect within an orchestrator run, not a full orchestrator restart.
   *  Bounded per tab + TTL'd. */
  private readonly mailbox = new Map<string, Array<{ cmd: BridgeCommand; ts: number }>>();
  private static readonly MAILBOX_MAX = 30;
  private static readonly MAILBOX_TTL_MS = 24 * 60 * 60 * 1000;
  /** Tab ids that ever connected as a headless (mobile/remote) client — kept so
   *  `isHeadless` stays true across a disconnect (see isHeadless). */
  private readonly headlessSeen = new Set<string>();
  private seenTabs = new Set<string>(); // tabIds ever announced — dedup connect logs across reconnect churn
  /** Frames pushed at a tab with NO live connection, buffered for replay when that
   *  tab re-hellos. Per-workflow sessions re-target ONE socket between workflow tab
   *  ids, so a backgrounded workflow's agent output would otherwise be dropped on
   *  the floor and its finished turn lost to the user. Complements the send()-path
   *  `mailbox` (which buffers show_media command deliveries): this one buffers
   *  push()-path frames (agent turn output). Bounded per tab. */
  private missedFrames = new Map<string, Record<string, unknown>[]>();
  private static readonly MAX_MISSED_FRAMES = 100;
  private pending = new Map<string, Pending>();
  private portInUse = false;
  private bindRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Consecutive missed pongs per socket — reset to 0 on each pong. */
  private missedPongs = new WeakMap<WebSocket, number>();
  private port: number;
  /** When set, connections MUST present `?token=<token>` on the WS upgrade
   *  (constant-time compared). Used for the secure `wss://` bridge exposed over a
   *  cloudflared tunnel, where the endpoint is publicly reachable. null in the
   *  default loopback-only mode (no auth needed — not reachable off-box). */
  private token: string | null;
  /** Bind host. Default loopback; a LAN/all-interfaces bind (0.0.0.0, a LAN IP)
   *  is allowed ONLY together with a token — panel #54: browsers on OTHER
   *  machines reaching a 24/7 server-side orchestrator. */
  private host: string;
  /** Tab the user most recently typed in — the default command target. */
  private lastActiveTabId: string | null = null;
  /** Resolves true once the port is bound, false if binding ultimately fails. */
  private readyPromise: Promise<boolean> | null = null;
  private readyResolve: ((ok: boolean) => void) | null = null;

  /** Called for panel-initiated frames (no rid): user messages, hellos. */
  onPanelMessage: ((event: PanelEvent) => void) | null = null;

  constructor(port = DEFAULT_BRIDGE_PORT, token: string | null = null, host = "127.0.0.1") {
    this.port = port;
    this.token = token;
    this.host = host;
    if (!isLoopbackBindHost(host) && !token) {
      // The bridge drives the live canvas + agent; exposing it beyond loopback
      // without auth is never acceptable — refuse loudly at construction.
      throw new Error(
        `UiBridge: refusing to bind the panel bridge on non-loopback host "${host}" without a token. ` +
          `Set COMFYUI_MCP_BRIDGE_TOKEN (or let the orchestrator generate one).`,
      );
    }
  }

  /** Constant-time token check for the WS upgrade. Always true when no token is
   *  configured (loopback mode). Length-mismatch short-circuits before the
   *  timing-safe compare (which requires equal-length buffers). */
  private tokenOk(provided: string): boolean {
    if (!this.token) return true;
    const a = Buffer.from(provided);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  start(): void {
    this.portInUse = false;
    this.readyPromise = new Promise<boolean>((resolve) => {
      this.readyResolve = resolve;
    });
    this.attemptListen(0);
  }

  /**
   * WebSocket keepalive. Every HEARTBEAT_MS, ping each live socket so a proxied
   * connection (cloudflared tunnel) never sits idle long enough for Cloudflare to
   * reap it during a long, quiet agent turn — the root cause of "intermittent
   * connection and drops" on the secure wss:// bridge. A socket that misses
   * MAX_MISSED_PONGS pings in a row is treated as dead and terminated so the panel
   * reconnects onto a clean socket. The timer is unref'd so it never keeps the
   * process alive on its own.
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      // Ping the primary listener AND any pairing listeners — a phone on a LAN or
      // tunnel bind needs the same idle-keepalive the browser panel gets.
      const servers = [this.wss, ...this.extraServers].filter(
        (s): s is WebSocketServer => s !== null,
      );
      for (const server of servers) {
        for (const sock of server.clients) {
          const missed = this.missedPongs.get(sock) ?? 0;
          if (missed >= UiBridge.MAX_MISSED_PONGS) {
            try {
              sock.terminate();
            } catch {
              // already gone
            }
            continue;
          }
          this.missedPongs.set(sock, missed + 1);
          try {
            sock.ping();
          } catch {
            // socket mid-close — the next tick's terminate/close handler cleans up
          }
        }
      }
    }, UiBridge.HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  /**
   * Resolves true once the bridge port is bound, false if it ultimately can't
   * bind (port held by another process). Lets a caller that *must* own the port
   * — the panel orchestrator — fail loudly instead of running uselessly.
   */
  whenReady(): Promise<boolean> {
    return this.readyPromise ?? Promise.resolve(this.wss !== null);
  }

  /**
   * Bind the loopback bridge port, retrying briefly on EADDRINUSE. A fast
   * `/mcp` reconnect can race the previous session's bridge before the OS has
   * released the port; rather than degrade immediately we back off and retry,
   * so the common restart case self-heals. Non-blocking — this never delays
   * MCP stdio startup, which is what matters for the client's init timeout.
   */
  private attemptListen(attempt: number): void {
    // Loopback by default — this drives the user's live editor. Two ways it can
    // be reachable off-box, BOTH token-gated on the WS upgrade:
    //   • secure mode: loopback bind fronted by a cloudflared wss:// tunnel
    //   • LAN mode (panel #54): a non-loopback bind host, for a 24/7 server-side
    //     orchestrator; the constructor enforces token-with-non-loopback.
    const wss = new WebSocketServer({
      port: this.port,
      host: this.host,
      verifyClient: this.token
        ? (info, cb) => {
            let provided = "";
            try {
              provided =
                new URL(info.req.url ?? "/", "http://127.0.0.1").searchParams.get("token") ?? "";
            } catch {
              provided = "";
            }
            if (this.tokenOk(provided)) return cb(true);
            logger.warn("[ui-bridge] rejected a bridge connection with a missing/invalid token");
            cb(false, 401, "Unauthorized");
          }
        : undefined,
    });

    wss.on("listening", () => {
      this.portInUse = false;
      this.wss = wss;
      logger.info(
        `[ui-bridge] listening on ws://${this.host}:${this.port}${this.token ? " (token-gated)" : ""}`,
      );
      this.startHeartbeat();
      this.readyResolve?.(true);
      this.readyResolve = null;
    });

    wss.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Discard this server; a fresh one is created per retry.
        try {
          wss.close();
        } catch {
          // Nothing bound to clean up.
        }
        if (attempt < UiBridge.MAX_BIND_ATTEMPTS) {
          const delay = UiBridge.BIND_RETRY_BASE_MS * 2 ** attempt;
          logger.warn(
            `[ui-bridge] port ${this.port} in use — a previous session may still be releasing it; retrying in ${delay}ms (attempt ${attempt + 1}/${UiBridge.MAX_BIND_ATTEMPTS})`,
          );
          this.bindRetryTimer = setTimeout(() => {
            this.bindRetryTimer = null;
            this.attemptListen(attempt + 1);
          }, delay);
          return;
        }
        this.portInUse = true;
        logger.warn(
          `[ui-bridge] port ${this.port} still in use after ${UiBridge.MAX_BIND_ATTEMPTS} attempts — another comfyui-mcp session likely owns the panel. This session's MCP tools still work, but panel_* commands are unavailable until that session exits.`,
        );
        this.readyResolve?.(false);
        this.readyResolve = null;
      } else if (this.wss) {
        // We had successfully bound (listening) and the server errored AFTER
        // startup — the port/bridge is gone and can't recover in-process. Exit so
        // the panel pack respawns a CLEAN orchestrator instead of leaving a zombie
        // (process alive, bridge dead → panel can't reconnect). This was a root
        // cause of "the panel agent will no longer reconnect."
        logger.error(
          `[ui-bridge] fatal: server error after startup (${err.message}) — exiting so a fresh orchestrator can take over`,
        );
        this.wss = null;
        process.exit(1);
      } else {
        logger.error(`[ui-bridge] server error: ${err.message}`);
        // Never reached "listening" — unblock any whenReady() waiter.
        this.readyResolve?.(false);
        this.readyResolve = null;
      }
    });

    wss.on("connection", (sock) => {
      // Keepalive bookkeeping for the SERVER-LEVEL heartbeat loop, which only
      // iterates real wss.clients (relay-mediated shim connections aren't real
      // sockets bound by this server, so they're intentionally excluded — see
      // relay-client.ts / the relay README for why that's believed low-risk).
      this.missedPongs.set(sock, 0);
      sock.on("pong", () => this.missedPongs.set(sock, 0));
      this.handleConnection(sock);
    });
  }

  /**
   * Attach a non-loopback panel connection — used by the relay client
   * (relay-client.ts) to feed a relay-multiplexed panel-tab connection into the
   * exact same hello/rid/tab-routing logic a direct loopback socket gets. From
   * here on the relay shim is indistinguishable from a real connection.
   */
  attachRelayConnection(sock: BridgeSocket): void {
    this.handleConnection(sock);
  }

  /**
   * Open a SECOND, ALWAYS token-gated listener on `host:port` and route its
   * connections through the same tab/rid logic as the primary bridge. Used by the
   * on-demand "pair a phone" flow: a `0.0.0.0` bind so a phone can reach it over
   * the LAN, and/or a loopback port a cloudflared quick-tunnel fronts. The primary
   * loopback listener stays token-less, so the local browser panel is untouched.
   * Resolves once bound; rejects if the port can't be bound. Idempotent-ish: the
   * caller is responsible for not re-binding the same port.
   */
  addListener(host: string, port: number, token: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const wss = new WebSocketServer({
        port,
        host,
        verifyClient: (info, cb) => {
          let provided = "";
          try {
            provided =
              new URL(info.req.url ?? "/", "http://127.0.0.1").searchParams.get("token") ?? "";
          } catch {
            provided = "";
          }
          const a = Buffer.from(provided);
          const b = Buffer.from(token);
          if (a.length === b.length && timingSafeEqual(a, b)) return cb(true);
          logger.warn("[ui-bridge] pairing listener rejected a connection with a missing/invalid token");
          cb(false, 401, "Unauthorized");
        },
      });
      wss.on("connection", (sock) => {
        this.missedPongs.set(sock, 0);
        sock.on("pong", () => this.missedPongs.set(sock, 0));
        this.handleConnection(sock);
      });
      wss.on("listening", () => {
        settled = true;
        this.extraServers.push(wss);
        logger.info(`[ui-bridge] pairing listener on ws://${host}:${port} (token-gated)`);
        resolve();
      });
      wss.on("error", (err: NodeJS.ErrnoException) => {
        if (!settled) {
          settled = true;
          try {
            wss.close();
          } catch {
            // nothing bound
          }
          reject(err);
        } else {
          logger.warn(`[ui-bridge] pairing listener error: ${err.message}`);
        }
      });
    });
  }

  private handleConnection(sock: BridgeSocket): void {
    // The connection is anonymous until its hello frame names a tab id.
    let tabId: string | null = null;

    sock.on("message", (buf: unknown) => {
      const raw = String(buf);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        logger.warn("[ui-bridge] dropping malformed frame from panel");
        return;
      }

      // Hello: register (or refresh) this connection under its tab id.
      if (msg.type === "hello" && typeof msg.tab_id === "string") {
        // A single socket may RE-HELLO under a new tab id when the user switches
        // ComfyUI workflow tabs (per-workflow sessions). Drop this socket's PRIOR
        // tab mapping so a background agent's push() to the old tab can't leak into
        // the newly-targeted view (frames carry no tab_id — the socket is the tab).
        if (tabId && tabId !== msg.tab_id && this.conns.get(tabId)?.sock === sock) {
          this.tabMigrations.set(tabId, msg.tab_id);
          this.conns.delete(tabId);
        }
        tabId = msg.tab_id;
        const existing = this.conns.get(tabId);
        if (existing && existing.sock !== sock) {
          // Same tab reconnected (reload) — supersede the stale socket.
          try {
            existing.sock.close();
          } catch {
            // Already gone.
          }
        }
        this.conns.set(tabId, {
          sock,
          tabId,
          title: typeof msg.title === "string" && msg.title ? msg.title : "untitled",
          connectedAt: existing?.connectedAt ?? new Date().toISOString(),
          headless: (msg as { headless?: unknown }).headless === true,
        });
        if ((msg as { headless?: unknown }).headless === true) this.headlessSeen.add(tabId);
        // Log a real connect ONCE per tab id. A reconnect/ping-pong loop (a new
        // socket every couple seconds — e.g. two browser contexts sharing one tab
        // id) would otherwise spam this; dedup by tab id so churn stays at debug.
        if (!this.seenTabs.has(tabId)) {
          this.seenTabs.add(tabId);
          logger.info(
            `[ui-bridge] panel tab connected: ${tabId.slice(0, 8)} (“${this.conns.get(tabId)?.title}”) — ${this.conns.size} tab(s) total`,
          );
        } else {
          logger.debug(`[ui-bridge] tab ${tabId.slice(0, 8)} (re)hello`);
        }
        // Replay anything this tab's agent produced while the tab had no live
        // connection (its socket was re-helloed to another workflow). The panel
        // swaps to this workflow's thread synchronously before these frames can be
        // processed, so they render + record into the RIGHT conversation.
        const missed = this.missedFrames.get(tabId);
        if (missed?.length) {
          this.missedFrames.delete(tabId);
          for (const f of missed) {
            try {
              sock.send(JSON.stringify(f));
            } catch {
              break; // socket died mid-flush — frames stay lost, next turn recovers
            }
          }
          logger.debug(`[ui-bridge] replayed ${missed.length} missed frame(s) to tab ${tabId.slice(0, 8)}`);
        }
        // Deliver anything that finished while this tab was away.
        this.flushMailbox(tabId);
        this.onPanelMessage?.(msg as PanelEvent);
        return;
      }

      const rid = typeof msg.rid === "string" ? msg.rid : undefined;
      if (rid) {
        const p = this.pending.get(rid);
        if (!p) return; // late reply for a timed-out command
        clearTimeout(p.timer);
        this.pending.delete(rid);
        if (msg.ok) {
          p.resolve(msg.result);
        } else {
          p.reject(new Error(String(msg.error ?? "panel reported an error")));
        }
        return;
      }

      // Lightweight title update — keep the tab's title fresh
      // WITHOUT re-greeting. The panel sends this on title mutations instead of
      // a full hello, so a graph build / run progress doesn't spam greetings.
      if (msg.type === "title" && tabId) {
        const conn = this.conns.get(tabId);
        if (conn && typeof msg.title === "string" && msg.title) conn.title = msg.title;
        return;
      }

      // Panel-initiated event. Stamp the tab and track activity.
      if (typeof msg.type === "string") {
        if (tabId) {
          msg.tab_id = tabId;
          msg.title = this.conns.get(tabId)?.title;
          if (msg.type === "user_message") this.lastActiveTabId = tabId;
        }
        this.onPanelMessage?.(msg as PanelEvent);
      }
    });

    sock.on("close", () => {
      if (tabId && this.conns.get(tabId)?.sock === sock) {
        this.conns.delete(tabId);
        if (this.lastActiveTabId === tabId) this.lastActiveTabId = null;
        logger.info(
          `[ui-bridge] panel tab disconnected: ${tabId.slice(0, 8)} — ${this.conns.size} tab(s) remain`,
        );
      }
      // Reject any in-flight commands that were bound to this socket.
      for (const [rid, p] of this.pending) {
        if ((p as Pending & { sock?: BridgeSocket }).sock === sock) {
          clearTimeout(p.timer);
          p.reject(new Error("panel tab disconnected mid-command"));
          this.pending.delete(rid);
        }
      }
    });
  }

  connected(): boolean {
    return this.conns.size > 0;
  }

  /** True when the tab advertised itself as a canvas-less (mobile/remote) client
   *  in its `hello`. Unknown tabs → false. */
  isHeadless(tabId: string): boolean {
    // Sticky: a tab that EVER connected headless stays "headless" even while
    // offline, so a render finishing during a disconnect is byte-inlined (not a
    // bytes-less viewRef) and is renderable when the mailbox flushes to the phone.
    return this.conns.get(tabId)?.headless === true || this.headlessSeen.has(tabId);
  }

  /** All currently connected tabs, most recent hello last. */
  tabs(): PanelTab[] {
    return Array.from(this.conns.values()).map((c) => ({
      tab_id: c.tabId,
      title: c.title,
      connected_at: c.connectedAt,
    }));
  }

  status(): string {
    if (this.portInUse) {
      return `port ${this.port} is held by another comfyui-mcp session — close that session (or whatever owns the port) and reconnect`;
    }
    if (this.conns.size === 0) {
      return "no panel connected — open ComfyUI with the comfyui-mcp-panel pack installed and check the Agent sidebar tab";
    }
    const lines = this.tabs().map(
      (t) =>
        `- tab ${t.tab_id.slice(0, 8)} “${t.title}”${t.tab_id === this.lastActiveTabId ? " (last active)" : ""}`,
    );
    return `${this.conns.size} panel tab(s) connected:\n${lines.join("\n")}`;
  }

  /** Resolve which tab a command should go to. */
  private resolveTarget(tabId?: string): Conn {
    if (tabId) {
      // Accept full ids or unambiguous prefixes (status shows 8-char ids).
      const exact = this.conns.get(tabId);
      if (exact) return exact;
      // Tab-id migration fallback: an agent session was bound to a tabId that
      // no longer matches any connected tab (the panel's tab-id scheme changed
      // mid-session, e.g. random UUID → deterministic tmp:/wf:). Redirect to
      // the new tabId the socket re-helloed under so the session self-heals.
      const migrated = this.tabMigrations.get(tabId);
      if (migrated) {
        const target = this.conns.get(migrated);
        if (target) return target;
      }
      const prefixed = Array.from(this.conns.values()).filter((c) =>
        c.tabId.startsWith(tabId),
      );
      if (prefixed.length === 1) return prefixed[0];
      throw new Error(
        prefixed.length > 1
          ? `tab_id "${tabId}" is ambiguous — matches ${prefixed.length} tabs`
          : `no connected tab with id "${tabId}". Connected: ${this.tabs()
              .map((t) => `${t.tab_id.slice(0, 8)} (“${t.title}”)`)
              .join(", ") || "none"}`,
      );
    }
    if (this.conns.size === 1) {
      return this.conns.values().next().value as Conn;
    }
    if (this.lastActiveTabId && this.conns.has(this.lastActiveTabId)) {
      return this.conns.get(this.lastActiveTabId) as Conn;
    }
    if (this.conns.size === 0) {
      throw new Error(`Panel not reachable: ${this.status()}`);
    }
    throw new Error(
      `Multiple panel tabs are connected and none is "last active" — pass tab_id. ${this.status()}`,
    );
  }

  /** Deliveries worth mailboxing when the target is offline (a finished render),
   *  vs. interactive canvas ops that should just fail. */
  private static isMailboxable(cmd: BridgeCommand): boolean {
    return cmd.cmd === "show_media";
  }

  private storeMailbox(tabId: string, cmd: BridgeCommand): void {
    const box = this.mailbox.get(tabId) ?? [];
    box.push({ cmd, ts: Date.now() });
    while (box.length > UiBridge.MAILBOX_MAX) box.shift();
    this.mailbox.set(tabId, box);
    logger.info(
      `[ui-bridge] mailboxed "${cmd.cmd}" for offline tab ${tabId.slice(0, 8)} (${box.length} queued)`,
    );
  }

  /** Deliver any buffered render frames to a tab that just (re)connected, plus a
   *  `mailbox_flush` summary so the client can notify "N renders finished while
   *  you were away". Expired items (past TTL) are dropped. */
  private flushMailbox(tabId: string): void {
    const box = this.mailbox.get(tabId);
    if (!box || box.length === 0) return;
    this.mailbox.delete(tabId);
    const conn = this.conns.get(tabId);
    if (!conn) return;
    const now = Date.now();
    const fresh = box.filter((m) => now - m.ts <= UiBridge.MAILBOX_TTL_MS);
    for (const m of fresh) {
      try {
        conn.sock.send(JSON.stringify({ rid: randomUUID(), ...m.cmd, mailbox: true }));
      } catch {
        // socket raced closed; drop
      }
    }
    if (fresh.length > 0) {
      try {
        conn.sock.send(JSON.stringify({ type: "mailbox_flush", count: fresh.length }));
      } catch {
        /* best-effort */
      }
      logger.info(
        `[ui-bridge] flushed ${fresh.length} mailboxed frame(s) to reconnected tab ${tabId.slice(0, 8)}`,
      );
    }
  }

  send(cmd: BridgeCommand, opts: { tabId?: string; timeoutMs?: number } = {}): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? 6000;
    let conn: Conn;
    try {
      conn = this.resolveTarget(opts.tabId);
    } catch (err) {
      // Offline target: buffer a finished-render delivery for reconnect instead of
      // failing, so the agent's "here's your image" isn't lost while the phone is away.
      if (opts.tabId && UiBridge.isMailboxable(cmd)) {
        this.storeMailbox(opts.tabId, cmd);
        return Promise.resolve({ ok: true, mailboxed: true });
      }
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    if (conn.sock.readyState !== WebSocket.OPEN) {
      if (opts.tabId && UiBridge.isMailboxable(cmd)) {
        this.storeMailbox(opts.tabId, cmd);
        return Promise.resolve({ ok: true, mailboxed: true });
      }
      return Promise.reject(new Error(`Panel tab ${conn.tabId.slice(0, 8)} is not open`));
    }
    const rid = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(
          new Error(
            `Panel tab ${conn.tabId.slice(0, 8)} did not reply to "${cmd.cmd}" within ${timeoutMs} ms — the ComfyUI tab may be backgrounded or frozen`,
          ),
        );
      }, timeoutMs);
      const pending: Pending & { sock?: BridgeSocket } = { resolve, reject, timer, sock: conn.sock };
      this.pending.set(rid, pending);
      try {
        conn.sock.send(JSON.stringify({ rid, ...cmd }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(rid);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Push a fire-and-forget frame. Targeted when tabId given, else broadcast.
   *  Truly fire-and-forget: if the target tab has gone, this no-ops (returns 0)
   *  rather than throwing — a throw here becomes an unhandled rejection in the
   *  async push call sites and would crash the orchestrator. */
  push(frame: Record<string, unknown>, tabId?: string): number {
    let sent = 0;
    let targets: Conn[];
    if (tabId) {
      try {
        targets = [this.resolveTarget(tabId)];
      } catch {
        // Tab not connected (e.g. the user switched to another workflow and the
        // shared socket re-helloed under that workflow's id). Buffer for replay on
        // this tab's next hello, so a backgrounded agent's turn isn't lost.
        const q = this.missedFrames.get(tabId) ?? [];
        q.push(frame);
        if (q.length > UiBridge.MAX_MISSED_FRAMES) q.splice(0, q.length - UiBridge.MAX_MISSED_FRAMES);
        this.missedFrames.set(tabId, q);
        return 0;
      }
    } else {
      targets = Array.from(this.conns.values());
    }
    for (const conn of targets) {
      if (conn.sock.readyState !== WebSocket.OPEN) continue;
      try {
        conn.sock.send(JSON.stringify(frame));
        sent += 1;
      } catch {
        // Tab mid-disconnect — drop.
      }
    }
    return sent;
  }

  async stop(): Promise<void> {
    if (this.bindRetryTimer) {
      clearTimeout(this.bindRetryTimer);
      this.bindRetryTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const [rid, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("bridge stopped"));
      this.pending.delete(rid);
    }
    for (const conn of this.conns.values()) {
      try {
        conn.sock.close();
      } catch {
        // Already gone.
      }
    }
    this.conns.clear();
    for (const s of this.extraServers.splice(0)) {
      try {
        s.close();
      } catch {
        // already gone
      }
    }
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    this.wss = null;
  }
}

/** Bind-host classification for the guard above. `0.0.0.0`/`::` are exposure
 *  (all interfaces), so they are NOT loopback for this purpose. */
export function isLoopbackBindHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

// Module-level singleton (the last bridge started in this process).
let bridgeInstance: UiBridge | null = null;

export function startUiBridge(port?: number, token?: string | null, host?: string): UiBridge {
  if (!bridgeInstance) {
    bridgeInstance = new UiBridge(
      port ??
        (Number(process.env.COMFYUI_MCP_BRIDGE_PORT) || DEFAULT_BRIDGE_PORT),
      token ?? null,
      host ?? "127.0.0.1",
    );
    bridgeInstance.start();
  }
  return bridgeInstance;
}

export function getUiBridge(): UiBridge | null {
  return bridgeInstance;
}
