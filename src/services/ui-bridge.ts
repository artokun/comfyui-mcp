// UI bridge: a loopback WebSocket server the comfyui-mcp-panel pack connects
// to. MCP tool handlers (src/tools/panel.ts) call `send(cmd)` and await the
// panel's rid-correlated reply — the user's own Claude Code session drives the
// live ComfyUI graph through its MCP connection, with zero LLM API keys.
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

import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "../utils/logger.js";

export const DEFAULT_BRIDGE_PORT = 9101;

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
  sock: WebSocket;
  tabId: string;
  title: string;
  connectedAt: string;
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

  private wss: WebSocketServer | null = null;
  private conns = new Map<string, Conn>(); // tabId -> connection
  private pending = new Map<string, Pending>();
  private portInUse = false;
  private bindRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private port: number;
  /** Tab the user most recently typed in — the default command target. */
  private lastActiveTabId: string | null = null;
  /** Resolves true once the port is bound, false if binding ultimately fails. */
  private readyPromise: Promise<boolean> | null = null;
  private readyResolve: ((ok: boolean) => void) | null = null;

  /** Called for panel-initiated frames (no rid): user messages, hellos. */
  onPanelMessage: ((event: PanelEvent) => void) | null = null;

  constructor(port = DEFAULT_BRIDGE_PORT) {
    this.port = port;
  }

  start(): void {
    this.portInUse = false;
    this.readyPromise = new Promise<boolean>((resolve) => {
      this.readyResolve = resolve;
    });
    this.attemptListen(0);
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
    // Loopback only — this drives the user's live editor and must never be
    // reachable from the LAN.
    const wss = new WebSocketServer({ port: this.port, host: "127.0.0.1" });

    wss.on("listening", () => {
      this.portInUse = false;
      this.wss = wss;
      logger.info(`[ui-bridge] listening on ws://127.0.0.1:${this.port}`);
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
      } else {
        logger.error(`[ui-bridge] server error: ${err.message}`);
        // If we never reached "listening", unblock any whenReady() waiter.
        this.readyResolve?.(false);
        this.readyResolve = null;
      }
    });

    wss.on("connection", (sock) => this.handleConnection(sock));
  }

  private handleConnection(sock: WebSocket): void {
    // The connection is anonymous until its hello frame names a tab id.
    let tabId: string | null = null;

    sock.on("message", (buf) => {
      const raw = buf.toString();
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        logger.warn("[ui-bridge] dropping malformed frame from panel");
        return;
      }

      // Hello: register (or refresh) this connection under its tab id.
      if (msg.type === "hello" && typeof msg.tab_id === "string") {
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
        });
        logger.info(
          `[ui-bridge] panel tab connected: ${tabId.slice(0, 8)} (“${this.conns.get(tabId)?.title}”) — ${this.conns.size} tab(s) total`,
        );
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
        if ((p as Pending & { sock?: WebSocket }).sock === sock) {
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

  send(cmd: BridgeCommand, opts: { tabId?: string; timeoutMs?: number } = {}): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? 6000;
    let conn: Conn;
    try {
      conn = this.resolveTarget(opts.tabId);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    if (conn.sock.readyState !== WebSocket.OPEN) {
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
      const pending: Pending & { sock?: WebSocket } = { resolve, reject, timer, sock: conn.sock };
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

  /** Push a fire-and-forget frame. Targeted when tabId given, else broadcast. */
  push(frame: Record<string, unknown>, tabId?: string): number {
    let sent = 0;
    const targets = tabId
      ? [this.resolveTarget(tabId)]
      : Array.from(this.conns.values());
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
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    this.wss = null;
  }
}

// Module-level singleton, started by --channels in src/index.ts.
let bridgeInstance: UiBridge | null = null;

export function startUiBridge(port?: number): UiBridge {
  if (!bridgeInstance) {
    bridgeInstance = new UiBridge(
      port ??
        (Number(process.env.COMFYUI_MCP_BRIDGE_PORT) || DEFAULT_BRIDGE_PORT),
    );
    bridgeInstance.start();
  }
  return bridgeInstance;
}

export function getUiBridge(): UiBridge | null {
  return bridgeInstance;
}
