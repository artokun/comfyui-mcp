// #2030 — the panel port block and the migration that must not strand a live
// 9180 session. Every assertion drives panelPortBlock / resolveBridgePort /
// pinBoundBridgePort / selfRestartChildEnv — no second copy of the map.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PANEL_BRIDGE_PORT,
  LEGACY_PANEL_BRIDGE_PORT,
  localBridgeUrl,
  panelPortBlock,
  pinBoundBridgePort,
  resolveBridgePort,
} from "../../services/bridge-ports.js";
import { defaultSpawnReplacement, selfRestartChildEnv } from "../../services/self-restart.js";

describe("panelPortBlock (#2030)", () => {
  it("counts down from the new default: 9199 / 9198 / 9197 / 9196 / 9195", () => {
    expect(DEFAULT_PANEL_BRIDGE_PORT).toBe(9199);
    expect(panelPortBlock(DEFAULT_PANEL_BRIDGE_PORT)).toEqual({
      bridge: 9199,
      panelMcp: 9198,
      pairing: 9197,
      console: 9196,
      tunnel: 9195,
    });
  });

  it("keeps the 9180-era +1..+4 block so pairing on 9182 still answers", () => {
    expect(LEGACY_PANEL_BRIDGE_PORT).toBe(9180);
    expect(panelPortBlock(LEGACY_PANEL_BRIDGE_PORT)).toEqual({
      bridge: 9180,
      panelMcp: 9181,
      pairing: 9182,
      console: 9183,
      tunnel: 9184,
    });
  });
});

describe("resolveBridgePort (#2030)", () => {
  it("a fresh launch with no pin binds 9199", () => {
    expect(resolveBridgePort({})).toBe(DEFAULT_PANEL_BRIDGE_PORT);
    expect(resolveBridgePort({})).toBe(9199);
  });

  it("a hand-set COMFYUI_MCP_BRIDGE_PORT=9180 is a pin and is never moved", () => {
    expect(resolveBridgePort({ COMFYUI_MCP_BRIDGE_PORT: "9180" })).toBe(9180);
  });

  it("an unpinned self-restart stays on 9180 so the bind-retry rides the parent", () => {
    expect(resolveBridgePort({ COMFYUI_MCP_RESTART_GEN: "1" })).toBe(LEGACY_PANEL_BRIDGE_PORT);
  });

  it("a pinned self-restart honours the pin, not the legacy fallback", () => {
    expect(
      resolveBridgePort({
        COMFYUI_MCP_RESTART_GEN: "2",
        COMFYUI_MCP_BRIDGE_PORT: "9199",
      }),
    ).toBe(9199);
  });
});

describe("pinBoundBridgePort + selfRestartChildEnv (#2030)", () => {
  it("selfRestartChildEnv(parent, 9180) pins 9180 even when the parent env has no port", () => {
    const parent = { PATH: "/usr/bin" };
    expect(resolveBridgePort(parent)).toBe(DEFAULT_PANEL_BRIDGE_PORT);
    const child = selfRestartChildEnv(parent, 9180);
    expect(child.COMFYUI_MCP_BRIDGE_PORT).toBe("9180");
    expect(resolveBridgePort(child)).toBe(9180);
  });

  it("defaultSpawnReplacement passes the bound port into the child env", () => {
    // Parent env has no pin — resolveBridgePort would pick 9199. The spawn
    // helper must pass boundPort=9180 as a distinct argument; deleting it
    // from the selfRestartChildEnv call site goes red.
    const captured: NodeJS.ProcessEnv[] = [];
    const ok = defaultSpawnReplacement({
      env: { PATH: "/usr/bin" },
      boundPort: 9180,
      spawn: (_cmd, _args, opts) => {
        captured.push(opts.env ?? {});
        return { pid: 4321, unref() {} };
      },
    });
    expect(ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].COMFYUI_MCP_BRIDGE_PORT).toBe("9180");
    expect(resolveBridgePort({ PATH: "/usr/bin" })).toBe(9199);

    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "services", "self-restart.ts"),
      "utf8",
    );
    expect(src).toMatch(/selfRestartChildEnv\(parentEnv,\s*boundPort\)/);
  });

  it("a child of a 9199 parent stays on 9199", () => {
    const parent = pinBoundBridgePort(DEFAULT_PANEL_BRIDGE_PORT, {});
    const child = selfRestartChildEnv(parent);
    expect(child.COMFYUI_MCP_BRIDGE_PORT).toBe(String(DEFAULT_PANEL_BRIDGE_PORT));
  });

  it("localBridgeUrl is the loopback URL advertised to the pack", () => {
    expect(localBridgeUrl(DEFAULT_PANEL_BRIDGE_PORT)).toBe("ws://127.0.0.1:9199");
    expect(localBridgeUrl(LEGACY_PANEL_BRIDGE_PORT)).toBe("ws://127.0.0.1:9180");
  });
});
