// Secure bridge: when `connect` (or the panel orchestrator) drives a REMOTE
// https ComfyUI (e.g. a RunPod pod), the pod's HTTPS panel page cannot open a
// plain `ws://127.0.0.1:9180` to the local bridge — browsers block insecure
// (ws://) sockets from a secure (https://) page (mixed-content) and gate
// public→loopback access (Private Network Access). This module makes it work
// transparently, via one of two backends:
//
//   cloudflared (default) — open a cloudflared quick tunnel to the loopback
//     bridge port, giving a `wss://<rand>.trycloudflare.com/?token=<token>` URL.
//     Zero setup, but the tunnel is ephemeral (a fresh random hostname every run,
//     "no uptime guarantee" per Cloudflare's own disclaimer for this product).
//
//   relay (opt-in: COMFYUI_MCP_TUNNEL_BACKEND=relay + COMFYUI_MCP_RELAY_URL) —
//     dial OUT to a self-hosted comfyui-mcp-relay (Cloudflare Worker + Durable
//     Object; github.com/artokun/comfyui-mcp-relay, private) that gives a stable
//     wss:// endpoint under your own domain instead of a random one. See that
//     repo's README for the wire protocol.
//
// Either way: ADVERTISE the resulting URL to the pod's panel pack so the browser
// panel fetches and uses it automatically — the user never copies a URL. The
// token is the only thing gating a now-publicly-reachable bridge, so it is
// generated per session and checked constant-time on every WS upgrade
// (see UiBridge).

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { startQuickTunnel, type QuickTunnel } from "./tunnel.js";
import { RelayClient } from "./relay-client.js";
import { logger } from "../utils/logger.js";
import { getComfyUIAuthHeaders } from "../config.js";
import type { UiBridge } from "./ui-bridge.js";

export interface SecureBridge {
  /** The wss URL the panel connects to (token embedded). */
  wssUrl: string;
  /** Re-advertise to the (possibly retargeted) pod. Safe to call repeatedly. */
  advertise(comfyuiUrl: string): Promise<boolean>;
  /** Tear down the cloudflared tunnel. Idempotent. */
  stop(): void;
}

/** https://host → wss://host/?token=…  (the panel's bridge URL). */
function toWssUrl(httpsUrl: string, token: string): string {
  const u = new URL(httpsUrl);
  u.protocol = "wss:";
  u.search = "";
  u.searchParams.set("token", token);
  return u.toString();
}

/** Mask the token when logging a wss URL. */
function maskToken(url: string): string {
  return url.replace(/token=[^&]+/, "token=…");
}

/**
 * POST the bridge URL to the pod's panel pack so its browser panel can fetch it.
 * Retries a few times — the orchestrator may advertise before the pod route is
 * warm. Returns true on the first 2xx.
 */
export async function advertiseBridge(comfyuiUrl: string, wssUrl: string, shouldAdvertise?: (target: string) => boolean): Promise<boolean> {
  let endpoint: string;
  try {
    endpoint = new URL("/comfyui_mcp_panel/advertise_bridge", comfyuiUrl).toString();
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Re-check per attempt: the target may have moved DURING the retry sequence
    // — a stale pod must never receive the bridge URL (codex finding).
    if (shouldAdvertise && !shouldAdvertise(comfyuiUrl)) return false;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getComfyUIAuthHeaders() },
        body: JSON.stringify({ url: wssUrl }),
      });
      if (res.ok) return true;
      logger.warn(`[secure-bridge] advertise got HTTP ${res.status} from the pod panel`);
    } catch (err) {
      logger.warn(
        `[secure-bridge] advertise attempt ${attempt + 1}/3 failed: ${(err as Error).message}`,
      );
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  return false;
}

/**
 * GET the panel's status route to learn where ComfyUI lives on THIS machine.
 *
 * The sidebar panel serves `/comfyui_mcp_panel/status` with a `base_path` — the
 * ComfyUI install root the panel is running inside (panel commit f45054e). The
 * orchestrator consumes it as a LAST-RESORT source of the local ComfyUI base for
 * an embedded loopback session that has no CLI-configured workspace (COMFYUI_PATH
 * unset AND auto-detect empty), so the path-dependent LOCAL surface still works —
 * the comfyui MCP runs in LOCAL mode (download_model / apply_manifest / model
 * scans) and panel_load_workflow's local fallback can resolve names (#296).
 *
 * Best-effort and time-bounded: returns undefined on ANY failure (unreachable,
 * non-2xx, non-JSON, missing/blank field) so it can only ADD a path — it must
 * NEVER throw or stall session start. Sent with the same auth headers as
 * advertiseBridge so a token-gated panel answers. Disk validation is the caller's
 * job (this returns the panel's raw claim).
 */
export async function fetchPanelBasePath(
  comfyuiUrl: string,
  timeoutMs = 2500,
): Promise<string | undefined> {
  let endpoint: string;
  try {
    endpoint = new URL("/comfyui_mcp_panel/status", comfyuiUrl).toString();
  } catch {
    return undefined;
  }
  try {
    const res = await fetch(endpoint, {
      headers: { ...getComfyUIAuthHeaders() },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as unknown;
    if (!data || typeof data !== "object") return undefined;
    // The route's field is snake_case `base_path`; tolerate a camelCase alias.
    const raw =
      (data as { base_path?: unknown }).base_path ??
      (data as { basePath?: unknown }).basePath;
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the effective LOCAL ComfyUI base directory for a session target,
 * consulting the panel's status route as a LAST-RESORT fallback (#296).
 *
 * Decision order — kept in ONE place so startup and the panel-`hello` retarget
 * path can never disagree about where ComfyUI lives:
 *   1. A CLI-configured / auto-detected local path (`localPath`) wins, but ONLY
 *      for a loopback, non-force-remote target (a REMOTE/force-remote target must
 *      never adopt a local dir — it isn't the remote host).
 *   2. Remote / force-remote target → undefined (routes through the Manager).
 *   3. Otherwise (loopback, non-force-remote, but NO local path) → GET the panel's
 *      `/comfyui_mcp_panel/status` `base_path` and adopt it, but ONLY if that path
 *      actually EXISTS on this machine (a bogus / remote-looking claim must not
 *      poison LOCAL mode).
 *
 * `fetchBasePath`/`exists` are injectable purely for tests; production uses the
 * real status fetch + `fs.existsSync`. Best-effort — never throws.
 */
export async function resolveComfyuiPathForTarget(opts: {
  target: string;
  localPath: string | undefined;
  forceRemote: boolean;
  isLoopback: boolean;
  fetchBasePath?: (url: string) => Promise<string | undefined>;
  exists?: (p: string) => boolean;
}): Promise<string | undefined> {
  const { target, localPath, forceRemote, isLoopback } = opts;
  if (!forceRemote && isLoopback && localPath) return localPath;
  if (forceRemote || !isLoopback) return undefined;
  const fetchBasePath = opts.fetchBasePath ?? fetchPanelBasePath;
  const exists = opts.exists ?? existsSync;
  let fromPanel: string | undefined;
  try {
    fromPanel = await fetchBasePath(target);
  } catch {
    return undefined; // bulletproof — a broken fetch must not break session start
  }
  if (fromPanel && exists(fromPanel)) return fromPanel;
  return undefined;
}

export interface SetupSecureBridgeOpts {
  bridgePort: number;
  comfyuiUrl: string;
  token: string;
  /** Needed only by the relay backend, to feed relay-multiplexed panel
   *  connections into the same routing logic a direct loopback socket gets. */
  bridge: UiBridge;
  /** Optional guard evaluated PER ADVERTISE TARGET (a slow tunnel setup or a
   *  later retarget must not hand the bridge URL to a stale pod — codex).
   *  Receives each candidate target URL. */
  shouldAdvertise?: (target: string) => boolean;
}

/**
 * Stand up the secure bridge and advertise its URL to the pod. Backend is
 * chosen by env (see the module doc comment above); cloudflared is the default.
 * Throws if the chosen backend can't come up (caller decides whether to fall
 * back to the plain ws bridge or fail).
 */
export async function setupSecureBridge(opts: SetupSecureBridgeOpts): Promise<SecureBridge> {
  const backendEnv = process.env.COMFYUI_MCP_TUNNEL_BACKEND?.trim().toLowerCase();
  const relayUrl = process.env.COMFYUI_MCP_RELAY_URL?.trim();
  if (backendEnv === "relay" || (backendEnv !== "cloudflared" && relayUrl)) {
    return setupRelayBridge(opts);
  }
  return setupCloudflaredBridge(opts);
}

/**
 * Dial a self-hosted comfyui-mcp-relay Worker as this session's orchestrator
 * connection. Each relay-multiplexed panel connection is fed into
 * bridge.attachRelayConnection, making it indistinguishable from a direct
 * loopback socket to the rest of the orchestrator.
 */
async function setupRelayBridge(opts: SetupSecureBridgeOpts): Promise<SecureBridge> {
  const { comfyuiUrl, token, bridge } = opts;
  const relayUrl = process.env.COMFYUI_MCP_RELAY_URL?.trim();
  if (!relayUrl) {
    throw new Error(
      "COMFYUI_MCP_TUNNEL_BACKEND=relay is set but COMFYUI_MCP_RELAY_URL is empty — set it to your " +
        "deployed comfyui-mcp-relay Worker URL (wss://…), or unset COMFYUI_MCP_TUNNEL_BACKEND to fall " +
        "back to the cloudflared quick-tunnel backend.",
    );
  }
  // Distinct from the bridge token — the session id is path-visible (low value,
  // just routes to the right Durable Object); the token is the actual secret.
  const sessionId = randomBytes(8).toString("hex");
  const client = new RelayClient({
    relayUrl,
    sessionId,
    token,
    accessKey: process.env.COMFYUI_MCP_RELAY_KEY?.trim() || undefined,
    onAttach: (sock) => bridge.attachRelayConnection(sock),
  });
  client.start();
  try {
    await client.waitUntilOpen();
  } catch (err) {
    // A failed setup must not leave a reconnecting client behind — the 5s
    // retry would pile one on every attempt during a relay outage (codex).
    client.stop();
    throw err;
  }

  const wssUrl = `${relayUrl.replace(/\/+$/, "")}/s/${sessionId}?token=${token}`;
  logger.info(`[secure-bridge] bridge exposed via relay at ${maskToken(wssUrl)}`);

  const advertise = async (target: string): Promise<boolean> => {
    const ok = await advertiseBridge(target, wssUrl, opts.shouldAdvertise);
    if (ok) {
      logger.info(`[secure-bridge] advertised the secure bridge URL to the pod panel`);
    } else {
      logger.warn(
        `[secure-bridge] could not reach the pod panel to advertise the bridge URL — ` +
          `open the pod's ComfyUI and it will retry on Connect`,
      );
    }
    return ok;
  };

  if (!opts.shouldAdvertise || opts.shouldAdvertise(comfyuiUrl)) {
    await advertise(comfyuiUrl);
  }

  return {
    wssUrl,
    advertise,
    stop: () => client.stop(),
  };
}

/**
 * Open a cloudflared tunnel to the loopback bridge and advertise the resulting
 * wss URL to the pod. Throws if the tunnel can't come up (caller decides whether
 * to fall back to the plain ws bridge or fail).
 */
async function setupCloudflaredBridge(opts: SetupSecureBridgeOpts): Promise<SecureBridge> {
  const { bridgePort, comfyuiUrl, token } = opts;
  // 127.0.0.1 (not localhost) — the bridge is IPv4 loopback-bound.
  const tunnel: QuickTunnel = await startQuickTunnel(bridgePort, "127.0.0.1");
  // Safety net: kill the tunnel on any process exit (e.g. the orchestrator's
  // uncaughtException → process.exit(1) path, which bypasses the graceful
  // shutdown that also calls stop()). Idempotent. Does not fire on SIGKILL.
  process.once("exit", () => {
    try {
      tunnel.stop();
    } catch {
      // already gone
    }
  });
  const wssUrl = toWssUrl(tunnel.url, token);
  logger.info(`[secure-bridge] bridge exposed securely at ${maskToken(wssUrl)}`);

  const advertise = async (target: string): Promise<boolean> => {
    const ok = await advertiseBridge(target, wssUrl, opts.shouldAdvertise);
    if (ok) {
      logger.info(`[secure-bridge] advertised the secure bridge URL to the pod panel`);
    } else {
      logger.warn(
        `[secure-bridge] could not reach the pod panel to advertise the bridge URL — ` +
          `open the pod's ComfyUI and it will retry on Connect`,
      );
    }
    return ok;
  };

  if (!opts.shouldAdvertise || opts.shouldAdvertise(comfyuiUrl)) {
    await advertise(comfyuiUrl);
  }

  return {
    wssUrl,
    advertise,
    stop: () => {
      try {
        tunnel.stop();
      } catch {
        // already gone
      }
    },
  };
}
