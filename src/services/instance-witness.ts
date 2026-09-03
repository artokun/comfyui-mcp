// Per-instance continuity witness (#871, #914).
//
// The restart fences compare URLs and target generations, but neither can see a
// ComfyUI server being REPLACED at the same URL — a second agent (or a
// supervisor, or the user) restarting it while we are between two observations.
// /system_stats carries no per-instance token, and we cannot add one to a server
// we do not control. What a replacement cannot survive is a connection: a
// WebSocket accepted by instance A dies with A, and no successor at the same URL
// inherits it. So a connection held OPEN across a window is the per-instance
// identity the codebase did not have — continuity proven by liveness, not by a
// value the server reports.
//
// The proof is one-directional, and the direction matters:
//   - still OPEN  → the instance that accepted the handshake is the instance
//                   serving now. A replacement cannot produce this.
//   - CLOSED      → NOT positive evidence of replacement. Tunnels hiccup,
//                   proxies time idle connections out, and our own reboot closes
//                   it by design. It is the ABSENCE of the continuity proof,
//                   never proof of absence — callers treat it as inconclusive.
//
// Scope is the single trust domain: this guards against ACCIDENTAL substitution
// (a concurrent restart racing our reads), not an adversary — a proxy that
// holds client connections alive while swapping backends would mask a
// replacement, and no handshake this server can perform rules that out.

import { randomUUID } from "node:crypto";
import { getComfyUIAuthHeaders } from "../config.js";
import { logger } from "../utils/logger.js";
import { LoopbackWebSocket } from "../transport/loopback-websocket.js";

export interface InstanceWitness {
  /** The WS URL the witness is connected to (diagnostics only). */
  readonly url: string;
  /**
   * True while the handshake connection is still open — i.e. the instance that
   * accepted it has not been replaced. See the module note: a false here is
   * inconclusive, not evidence of substitution.
   */
  alive(): boolean;
  /**
   * Epoch ms when the connection was observed closed (the close EVENT's delivery
   * — a death is stamped when we hear about it, so within event-delivery slack a
   * close is attributed to whichever side of a dispatch it surfaced on), or
   * undefined while it is still open.
   */
  closedAt(): number | undefined;
  /** Release the connection. Idempotent; never throws. */
  close(): void;
}

/**
 * Open a dedicated WebSocket to the ComfyUI at `baseUrl` and hand back the
 * continuity witness for it. TOTAL: never throws and never hangs — any failure
 * (refused, unreachable, proxied-away, timed out) resolves to `undefined`, the
 * "could not be read" outcome callers already know how to fence with.
 *
 * Deliberately NOT the shared client singleton: that one auto-reconnects, and a
 * reconnect after a replacement would look exactly like continuity. This socket
 * is opened once and never recovered.
 */
export async function acquireInstanceWitness(
  baseUrl: string,
  timeoutMs = 3000,
): Promise<InstanceWitness | undefined> {
  const url =
    `${baseUrl.replace(/^http/, "ws").replace(/\/+$/, "")}` +
    `/ws?clientId=comfyui-mcp-instance-witness-${randomUUID()}`;
  let ws: LoopbackWebSocket;
  try {
    // Ride the same auth as HTTP (COMFYUI_AUTH_* + Cloudflare Access service
    // token) so the witness reaches a ComfyUI behind a gateway — the queue
    // monitor's established pattern. undefined when unauth'd → identical to
    // `new WebSocket(url)`.
    const authHeaders = getComfyUIAuthHeaders();
    ws = new LoopbackWebSocket(
      url,
      Object.keys(authHeaders).length ? { headers: authHeaders } : undefined,
    );
  } catch (err) {
    logger.debug(
      `instance witness: WS construct failed for ${baseUrl}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return undefined;
  }

  let closedAt: number | undefined;
  // `ws` always follows an error with a close; the no-op error listener exists
  // because an unhandled 'error' on an EventEmitter throws.
  ws.on("error", () => {});
  ws.on("close", () => {
    closedAt ??= Date.now();
  });

  const opened = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(true);
    });
    // A close before the open is a refused handshake.
    ws.once("close", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });

  if (!opened) {
    try {
      ws.terminate();
    } catch {
      /* already gone — which is all terminate() was asked to ensure */
    }
    return undefined;
  }

  return {
    url,
    alive: () => closedAt === undefined && ws.readyState === WebSocket.OPEN,
    closedAt: () => closedAt,
    close: () => {
      try {
        ws.close();
      } catch {
        /* a socket we cannot close is one that is already closing */
      }
    },
  };
}
