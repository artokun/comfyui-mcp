// #875 — a user asked to pin the orchestrator version because "updating the npm
// version bricks my communication with the agent".
//
// The version was never the cause. The self-restarter is on by default, checks
// npm hourly, and restarts into new code whenever the agent is idle — and a
// restart rotates up to two independent parts of the URL the phone saved: the
// pair token (per session unless COMFYUI_MCP_PAIR_TOKEN is pinned) and, in
// tunnel mode, the cloudflared quick-tunnel hostname (always).
//
// So one default-on feature silently invalidated another, and nothing at pair
// time said so. That is why the report arrived as "let me pin the version"
// instead of "my pairing URL expired" — the user could only infer a cause from a
// phone that stopped working.

import { describe, expect, it } from "vitest";

import { pairUrlDurability } from "../../orchestrator/pair-durability.js";
import { canSelfRestart } from "../../services/self-restart.js";

describe("#875: what the pairing URL actually promises", () => {
  it("LAN + pinned token is the ONE durable combination", () => {
    const d = pairUrlDurability({ mode: "lan", stableToken: true, autoRestart: true });
    expect(d.survivesRestart).toBe(true);
    expect(d.rotates).toEqual([]);
    expect(d.note).toMatch(/survives an orchestrator restart/);
  });

  it("LAN without a pinned token rotates the token, and names the fix", () => {
    const d = pairUrlDurability({ mode: "lan", stableToken: false, autoRestart: true });
    expect(d.survivesRestart).toBe(false);
    expect(d.rotates).toEqual(["token"]);
    expect(d.note).toMatch(/COMFYUI_MCP_PAIR_TOKEN/);
    expect(d.note).toMatch(/reconnects/);
  });

  it("tunnel rotates the hostname EVEN WITH a pinned token", () => {
    const d = pairUrlDurability({ mode: "tunnel", stableToken: true, autoRestart: true });
    expect(d.survivesRestart).toBe(false);
    expect(d.rotates).toEqual(["hostname"]);
  });

  it("tunnel without a pinned token rotates both", () => {
    const d = pairUrlDurability({ mode: "tunnel", stableToken: false, autoRestart: true });
    expect(d.rotates).toEqual(["hostname", "token"]);
    expect(d.note).toMatch(/both its hostname and its token/);
  });

  // The correction that matters most. The issue proposed deploying a relay as
  // the workaround for a stable tunnel URL. COMFYUI_MCP_TUNNEL_BACKEND is read
  // ONLY by services/secure-bridge.ts, for the `connect` path's remote-pod
  // bridge; the pairing path calls startQuickTunnel() directly. Telling a user
  // to stand up a Cloudflare Worker that cannot fix their problem is worse than
  // telling them nothing.
  it("does not offer the relay backend as a tunnel remedy — it does not apply", () => {
    const d = pairUrlDurability({ mode: "tunnel", stableToken: false, autoRestart: true });
    expect(d.note).toMatch(/COMFYUI_MCP_TUNNEL_BACKEND=relay does not apply/);
    expect(d.note).toMatch(/no way to pin the tunnel hostname/);
  });

  it("does not tell a tunnel user that pinning the token will save them", () => {
    const d = pairUrlDurability({ mode: "tunnel", stableToken: false, autoRestart: true });
    expect(d.note).toMatch(/will not help here/);
  });

  // A warning about spontaneous restarts is false when they are switched off.
  it("only blames automatic restarts when they are actually armed", () => {
    const on = pairUrlDurability({ mode: "lan", stableToken: false, autoRestart: true });
    expect(on.note).toMatch(/restarts on its own/);

    const off = pairUrlDurability({ mode: "lan", stableToken: false, autoRestart: false });
    expect(off.note).toMatch(/Automatic restarts are disabled/);
    expect(off.note).not.toMatch(/restarts on its own/);
    // Still not durable — a deliberate restart breaks it just the same.
    expect(off.survivesRestart).toBe(false);
  });

  it("rotates is empty exactly when survivesRestart", () => {
    for (const mode of ["lan", "tunnel"] as const) {
      for (const stableToken of [true, false]) {
        for (const autoRestart of [true, false]) {
          const d = pairUrlDurability({ mode, stableToken, autoRestart });
          expect(d.rotates.length === 0).toBe(d.survivesRestart);
        }
      }
    }
  });
});

// The note's restart clause is only honest if it matches what the restarter
// really does. Deriving it from the env vars separately is how the two drift, so
// the pairing site calls this exported predicate rather than re-reading them.
describe("#875: canSelfRestart matches both documented switches", () => {
  it("is on by default", () => {
    expect(canSelfRestart({})).toBe(true);
  });

  it("is off under the master switch", () => {
    expect(canSelfRestart({ COMFYUI_MCP_AUTO_UPDATE_DISABLE: "1" })).toBe(false);
  });

  it("is off under the restart-only opt-out", () => {
    expect(canSelfRestart({ COMFYUI_MCP_AUTORESTART: "0" })).toBe(false);
  });

  it("accepts the documented falsey spellings of the opt-out", () => {
    for (const v of ["0", "false", "no", "off", "OFF", " No "]) {
      expect(canSelfRestart({ COMFYUI_MCP_AUTORESTART: v }), v).toBe(false);
    }
  });

  it("does not treat an unrelated value as off", () => {
    expect(canSelfRestart({ COMFYUI_MCP_AUTORESTART: "1" })).toBe(true);
  });
});
