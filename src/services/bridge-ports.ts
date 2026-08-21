// Panel-orchestrator port block (#2030).
//
// One constant (`DEFAULT_PANEL_BRIDGE_PORT` in panel-launcher.ts) is the bridge.
// Everything else is derived from it through `panelPortBlock` so a test can pin
// the map and a future default change cannot leave +1..+4 arithmetic behind.
//
// The new default COUNTS DOWN from 9199: counting up would put the panel HTTP-MCP
// on 9200 (Elasticsearch / IANA wap-wsp). 9180-era sessions keep the historical
// +1..+4 block so a phone paired on 9182 and a panel MCP on 9181 still work
// across the migration.

import {
  DEFAULT_PANEL_BRIDGE_PORT,
  LEGACY_PANEL_BRIDGE_PORT,
} from "./panel-launcher.js";

export { DEFAULT_PANEL_BRIDGE_PORT, LEGACY_PANEL_BRIDGE_PORT };

export type PanelPortBlock = {
  bridge: number;
  panelMcp: number;
  pairing: number;
  console: number;
  tunnel: number;
};

/**
 * Derive the four sibling ports from the bridge.
 *
 * 9180 keeps the pre-#2030 +1..+4 layout (pairing 9182 still answers). Every
 * other bridge, including the new default 9199, counts down.
 */
export function panelPortBlock(bridgePort: number): PanelPortBlock {
  if (bridgePort === LEGACY_PANEL_BRIDGE_PORT) {
    return {
      bridge: bridgePort,
      panelMcp: bridgePort + 1,
      pairing: bridgePort + 2,
      console: bridgePort + 3,
      tunnel: bridgePort + 4,
    };
  }
  return {
    bridge: bridgePort,
    panelMcp: bridgePort - 1,
    pairing: bridgePort - 2,
    console: bridgePort - 3,
    tunnel: bridgePort - 4,
  };
}

function parsedPort(raw: string | undefined): number | undefined {
  if (raw == null || String(raw).trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return undefined;
  return n;
}

/**
 * The bridge port this process should bind.
 *
 *   1. `COMFYUI_MCP_BRIDGE_PORT` is a pin — honour it (including 9180).
 *   2. An unpinned self-restart (`COMFYUI_MCP_RESTART_GEN` > 0) was spawned by a
 *      predecessor that copied `process.env` without pinning. That predecessor
 *      was compiled against 9180; stay there so the child's bind-retry rides
 *      the parent's release instead of silently adopting 9199 and stranding
 *      the panel.
 *   3. A fresh launch with no pin binds the new default.
 */
export function resolveBridgePort(env: NodeJS.ProcessEnv = process.env): number {
  const pinned = parsedPort(env.COMFYUI_MCP_BRIDGE_PORT);
  if (pinned != null) return pinned;
  const gen = Number(env.COMFYUI_MCP_RESTART_GEN ?? "0");
  if (Number.isInteger(gen) && gen > 0) return LEGACY_PANEL_BRIDGE_PORT;
  return DEFAULT_PANEL_BRIDGE_PORT;
}

/**
 * Write the *effective* bound port into `env` so a child (auto-update restart,
 * crash respawn that inherits this environment, `panel_restart_comfyui`
 * relaunch) never re-derives a new compiled default.
 */
export function pinBoundBridgePort(
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  env.COMFYUI_MCP_BRIDGE_PORT = String(port);
  return env;
}

/** Loopback URL the panel dials. Advertised on `advertise_bridge` as `local_url`. */
export function localBridgeUrl(port: number): string {
  return `ws://127.0.0.1:${port}`;
}
