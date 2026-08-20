/**
 * The conversation-wide Blind-mode gate, as a pure decision over the blind-tab
 * set — extracted from the orchestrator so the one predicate that decides
 * whether the shared agent ever receives pixels is unit-testable without a
 * websocket (the same reason `panel-sync.ts` is a pure module).
 *
 * WHY THIS EXISTS AT ALL (#1841). Blind (#90) is a per-tab UI setting; #884 made
 * the GATE conversation-wide, because the agent is shared and a per-tab gate
 * would leak pixels to it through some other tab. The set that backs it was only
 * ever written by an explicit blind-off FROM THAT SAME TAB ID, or by the hello
 * migration path — so nothing removed a tab that simply WENT AWAY (browser
 * closed, a reconnect that minted a new id outside the migration path, a ComfyUI
 * restart). One departed blind tab therefore pinned `anyTabBlind()` true for the
 * life of the orchestrator process: every later agent and tool spawn got
 * `COMFYUI_MCP_BLIND=1` and every run completion was stripped, while the user's
 * current tab reported Blind as OFF and the panel composed its SIGHTED note.
 *
 * WHY NOT JUST `canReach()`. The obvious repair — count only tabs the bridge can
 * reach right now — inverts the failure direction of a privacy promise. A
 * websocket drop is routine and brief; during it every blind tab reads as
 * unreachable, so a completion landing in that window would hand pixels to the
 * agent for a user who never turned Blind off. Blind must fail CLOSED.
 *
 * WHAT THIS DOES INSTEAD. Unreachability starts a clock; it does not decide
 * anything. A blind tab that cannot be reached KEEPS blinding the conversation
 * for `graceMs`, and is dropped only once it has been continuously unreachable
 * past that grace. A reconnect inside the window clears the clock, and the tab's
 * own hello re-asserts its setting either way — so the reconnect path needs no
 * cooperation from this module. The exposure window a bare `canReach()` opened is
 * closed, and the permanent pin is bounded.
 *
 * The sweep is LEVEL-TRIGGERED — it needs no disconnect hook, no tab-lifecycle
 * callback, and no cooperation from the bridge beyond a reachability probe.
 */

/** How long a blind tab keeps blinding the conversation after it stops being
 *  reachable. Comfortably longer than a websocket reconnect (seconds), short
 *  enough that a closed tab cannot pin a long session. */
export const BLIND_TAB_GRACE_MS = 5 * 60_000;

export interface BlindTabGateInput {
  /** Tab ids currently known to have Blind ON. MUTATED: provably-gone ids are removed. */
  blindTabs: Set<string>;
  /** Tab id → epoch ms when it was first observed unreachable. MUTATED. */
  unreachableSince: Map<string, number>;
  /** Can a command bound to this exact tab id reach a live tab right now? */
  canReach: (tabId: string) => boolean;
  /** Injected clock (epoch ms). */
  now: number;
  /** Override the grace window; defaults to {@link BLIND_TAB_GRACE_MS}. */
  graceMs?: number;
}

export interface BlindTabGateResult {
  /** Whether pixels must be withheld from the shared agent. */
  blind: boolean;
  /** Tab ids dropped by THIS sweep because they outlived the grace window. */
  pruned: string[];
  /** Blind tabs currently unreachable but still inside their grace window. */
  pendingGone: string[];
}

/**
 * Sweep the blind-tab set and answer whether the conversation is blind.
 *
 * Every entry is visited on every call — no early return — so a live blind tab
 * can never mask the pruning of a stale one. That matters because the live tab
 * is usually the one that comes and goes, and an early return would leave the
 * permanently-dead entry unswept for exactly as long as anything else was blind.
 *
 * `blindTabs` and `unreachableSince` are mutated in place: this is the only
 * writer that retires an entry on evidence rather than on an explicit user
 * action, and keeping the bookkeeping beside the decision is what stops the two
 * from drifting apart.
 */
export function resolveBlindTabGate({
  blindTabs,
  unreachableSince,
  canReach,
  now,
  graceMs = BLIND_TAB_GRACE_MS,
}: BlindTabGateInput): BlindTabGateResult {
  const pruned: string[] = [];
  const pendingGone: string[] = [];
  let blind = false;

  for (const tabId of [...blindTabs]) {
    let reachable = false;
    try {
      reachable = canReach(tabId) === true;
    } catch {
      // A probe that THREW told us nothing. Treat it as unreachable so the grace
      // clock still runs (a permanently-throwing probe must not pin the session
      // forever either), but never as proof the tab is gone.
      reachable = false;
    }
    if (reachable) {
      // Present and blind: the clock is irrelevant, so clear it. Without this a
      // tab that flapped once would carry a stale stamp and could be pruned mid-
      // session while its user is still watching.
      unreachableSince.delete(tabId);
      blind = true;
      continue;
    }
    const since = unreachableSince.get(tabId);
    if (since == null) {
      // FIRST observation of absence is not evidence of departure — start the
      // clock and stay blind. This is the branch that makes the gate fail closed.
      unreachableSince.set(tabId, now);
      pendingGone.push(tabId);
      blind = true;
      continue;
    }
    // A clock running backwards (system time moved) must not retire an entry
    // early — re-stamp and keep blinding rather than trust the difference.
    if (now < since) {
      unreachableSince.set(tabId, now);
      pendingGone.push(tabId);
      blind = true;
      continue;
    }
    if (now - since < graceMs) {
      pendingGone.push(tabId);
      blind = true;
      continue;
    }
    // Continuously unreachable past the grace window: retire it. If that user
    // returns, their hello re-asserts Blind and re-adds the id.
    blindTabs.delete(tabId);
    unreachableSince.delete(tabId);
    pruned.push(tabId);
  }

  // Stamps for ids no longer in the set (an explicit blind-off arrived while a
  // clock was running) would otherwise accumulate for the process's lifetime.
  for (const tabId of [...unreachableSince.keys()]) {
    if (!blindTabs.has(tabId)) unreachableSince.delete(tabId);
  }

  return { blind, pruned, pendingGone };
}
