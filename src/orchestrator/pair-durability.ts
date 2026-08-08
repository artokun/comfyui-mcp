/**
 * #875 — will this pairing URL still work after the orchestrator restarts?
 *
 * A user asked to pin the orchestrator version because "updating the npm version
 * bricks my communication with the agent". The version is not the cause. The
 * self-restarter is on by default, checks npm hourly, and restarts into new code
 * whenever the agent is idle — and a restart rotates up to two independent parts
 * of the URL the phone saved:
 *
 *   1. THE TOKEN. Generated per session unless COMFYUI_MCP_PAIR_TOKEN is pinned.
 *   2. THE HOSTNAME, tunnel mode only. Phone pairing opens a cloudflared QUICK
 *      tunnel, which mints a fresh random `<rand>.trycloudflare.com` every run.
 *
 * So a default-on feature silently invalidates another default-on feature, and
 * nothing at pair time says so. The user is left to infer it from a phone that
 * stopped working, which is how this arrived as "pin the version" rather than as
 * "my pairing URL expired".
 *
 * IMPORTANT, and the reason this file states the tunnel case unconditionally:
 * COMFYUI_MCP_TUNNEL_BACKEND=relay does NOT give a stable phone-pairing URL. That
 * setting is read only by services/secure-bridge.ts, for the `connect` path's
 * remote-pod bridge. The pairing path calls startQuickTunnel() directly and never
 * consults it. A relay operator therefore gets exactly the same rotating
 * trycloudflare hostname as everyone else, and advice to "deploy a relay" would
 * send them to build a Cloudflare Worker that cannot fix this. Whoever changes
 * pairing to honour a backend selection must revisit `hostRotates` here.
 *
 * This module only DESCRIBES. It does not defer restarts or persist a token —
 * both change behaviour the user did not ask for (persisting a
 * password-equivalent token removes the auto-expiry that a per-run token gives
 * you today), and neither is mine to decide silently.
 */

/** How a minted pairing URL fares across an orchestrator restart. */
export interface PairUrlDurability {
  /** True only when NOTHING in the URL is known to rotate on a restart. */
  survivesRestart: boolean;
  /** The parts that rotate, named. Empty exactly when `survivesRestart`. */
  rotates: ("token" | "hostname")[];
  /** One human sentence: what happens, and what to do about it. */
  note: string;
}

export interface PairDurabilityInput {
  /** "lan" → ws://<lan-ip>:<port>; "tunnel" → a cloudflared quick tunnel. */
  mode: "lan" | "tunnel";
  /** Whether the token is STABLE across restarts — persisted to disk by default,
   *  or pinned via COMFYUI_MCP_PAIR_TOKEN. Either way the phone's saved token
   *  keeps working; the note below must not name one mechanism as if it were the
   *  only one (#875). */
  stableToken: boolean;
  /** Whether the self-restarter can restart this process (default on). When it
   *  cannot, a rotating URL is far less likely to bite — say so rather than
   *  warning about a restart that will not happen on its own. */
  autoRestart: boolean;
}

/**
 * Describe the URL's durability from configuration alone — no probing, no
 * guessing. Every branch below is a fact about how the URL was constructed.
 */
export function pairUrlDurability(input: PairDurabilityInput): PairUrlDurability {
  const rotates: ("token" | "hostname")[] = [];
  // Tunnel pairing is ALWAYS a quick tunnel (see the note above): the hostname
  // is regenerated per run with no way to pin it.
  if (input.mode === "tunnel") rotates.push("hostname");
  if (!input.stableToken) rotates.push("token");

  if (rotates.length === 0) {
    return {
      survivesRestart: true,
      rotates: [],
      note:
        "This URL survives an orchestrator restart: the pairing token is stable (persisted, or " +
        "pinned via COMFYUI_MCP_PAIR_TOKEN) and the LAN address does not change per run. (If your router reassigns this machine a different " +
        "IP, the address changes for that reason, not because of a restart.)",
    };
  }

  // Name the parts, then the cause, then the remedy that exists for each. The
  // restarter clause is stated only when it is actually armed.
  const what =
    rotates.length === 2
      ? "both its hostname and its token are regenerated"
      : rotates[0] === "hostname"
        ? "its hostname is regenerated"
        : "its token is regenerated";

  const cause = input.autoRestart
    ? "The orchestrator restarts on its own to apply updates (hourly check, when idle), so this " +
      "can happen without you doing anything."
    : "Automatic restarts are disabled here, so this only happens when the orchestrator is " +
      "restarted deliberately.";

  const remedy = rotates.includes("hostname")
    ? "There is no way to pin the tunnel hostname today — phone pairing always uses a cloudflared " +
      "quick tunnel, and COMFYUI_MCP_TUNNEL_BACKEND=relay does not apply to it. To keep a link " +
      "that survives restarts, pair over LAN (the token is persisted, so a LAN URL keeps " +
      "working); otherwise re-pair from the panel after a restart. " +
      // #875 — the reassurance that matters mid-session: an automatic restart
      // will NOT yank this tunnel out from under a connected phone. Stated here
      // because pair time is where the user is looking; the deferral itself is a
      // gate on the self-restarter, and a log would not reach them.
      "While a phone is connected over this tunnel, automatic update-restarts are DEFERRED until " +
      "it disconnects, so an update cannot break the link mid-session (a tunnel left connected " +
      "indefinitely therefore postpones updates indefinitely)." +
      (rotates.includes("token")
        ? " (Pinning COMFYUI_MCP_PAIR_TOKEN alone will not help here — the hostname still rotates.)"
        : "")
    : "Set COMFYUI_MCP_PAIR_TOKEN to a fixed secret to keep this URL working across restarts; " +
      "the pairing listener then also starts automatically at boot, so the phone reconnects " +
      "without opening the panel.";

  return {
    survivesRestart: false,
    rotates,
    note: `This URL stops working when the orchestrator restarts — ${what}. ${cause} ${remedy}`,
  };
}
