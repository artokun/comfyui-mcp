import { describe, it, expect } from "vitest";
import {
  resolveBlindTabGate,
  BLIND_TAB_GRACE_MS,
} from "../../orchestrator/blind-tab-gate.js";

// #1841 — the reported failure: one blind tab that WENT AWAY pinned the whole
// conversation blind for the life of the orchestrator process. Every assertion
// below is about one of the two directions this gate must never get wrong:
//   fail CLOSED while a blind tab might still be watching, and
//   RETIRE an entry once it provably is not.

const T0 = 1_700_000_000_000;

function gate(
  over: Partial<Parameters<typeof resolveBlindTabGate>[0]> & {
    blindTabs: Set<string>;
  },
) {
  return resolveBlindTabGate({
    unreachableSince: new Map(),
    canReach: () => true,
    now: T0,
    ...over,
  });
}

describe("resolveBlindTabGate (#1841)", () => {
  it("no blind tabs → not blind", () => {
    const r = gate({ blindTabs: new Set() });
    expect(r.blind).toBe(false);
    expect(r.pruned).toEqual([]);
  });

  it("a reachable blind tab → blind, and never pruned", () => {
    const blindTabs = new Set(["live"]);
    const r = gate({ blindTabs, canReach: () => true });
    expect(r.blind).toBe(true);
    expect(r.pruned).toEqual([]);
    expect(blindTabs.has("live")).toBe(true);
  });

  // THE fail-closed case. A websocket drop is routine and brief; counting only
  // reachable tabs would hand pixels to the agent inside that window for a user
  // who never turned Blind off.
  it("an unreachable blind tab stays BLIND on first sight and is not pruned", () => {
    const blindTabs = new Set(["gone"]);
    const unreachableSince = new Map<string, number>();
    const r = gate({ blindTabs, unreachableSince, canReach: () => false });
    expect(r.blind).toBe(true);
    expect(r.pruned).toEqual([]);
    expect(r.pendingGone).toEqual(["gone"]);
    expect(blindTabs.has("gone")).toBe(true);
    expect(unreachableSince.get("gone")).toBe(T0);
  });

  it("stays blind for the whole grace window, then retires the tab", () => {
    const blindTabs = new Set(["gone"]);
    const unreachableSince = new Map([["gone", T0]]);
    const canReach = () => false;

    const justInside = gate({
      blindTabs,
      unreachableSince,
      canReach,
      now: T0 + BLIND_TAB_GRACE_MS - 1,
    });
    expect(justInside.blind).toBe(true);
    expect(blindTabs.has("gone")).toBe(true);

    const atBoundary = gate({
      blindTabs,
      unreachableSince,
      canReach,
      now: T0 + BLIND_TAB_GRACE_MS,
    });
    expect(atBoundary.blind).toBe(false);
    expect(atBoundary.pruned).toEqual(["gone"]);
    expect(blindTabs.has("gone")).toBe(false);
    expect(unreachableSince.has("gone")).toBe(false);
  });

  it("a reconnect inside the window clears the clock, so the tab is not retired later", () => {
    const blindTabs = new Set(["flappy"]);
    const unreachableSince = new Map<string, number>();

    gate({ blindTabs, unreachableSince, canReach: () => false, now: T0 });
    expect(unreachableSince.get("flappy")).toBe(T0);

    // Back online well inside the grace window.
    gate({ blindTabs, unreachableSince, canReach: () => true, now: T0 + 1_000 });
    expect(unreachableSince.has("flappy")).toBe(false);

    // Drops again later — the clock restarts from NOW, not from the first drop,
    // so the original absence cannot retire it retroactively.
    const later = T0 + BLIND_TAB_GRACE_MS + 2_000;
    const r = gate({ blindTabs, unreachableSince, canReach: () => false, now: later });
    expect(r.blind).toBe(true);
    expect(r.pruned).toEqual([]);
    expect(blindTabs.has("flappy")).toBe(true);
  });

  // A live blind tab must not mask the pruning of a dead one: the dead entry is
  // exactly what pins the session once the live tab finally goes.
  it("sweeps EVERY entry — a live blind tab does not shield a long-departed one", () => {
    const blindTabs = new Set(["live", "gone"]);
    const unreachableSince = new Map([["gone", T0]]);
    const r = gate({
      blindTabs,
      unreachableSince,
      canReach: (t) => t === "live",
      now: T0 + BLIND_TAB_GRACE_MS + 1,
    });
    expect(r.blind).toBe(true); // "live" is still blind
    expect(r.pruned).toEqual(["gone"]); // ...and "gone" was still retired
    expect(blindTabs.has("live")).toBe(true);
    expect(blindTabs.has("gone")).toBe(false);
  });

  it("a THROWING reachability probe is treated as unreachable, never as proof of departure", () => {
    const blindTabs = new Set(["boom"]);
    const unreachableSince = new Map<string, number>();
    const canReach = () => {
      throw new Error("bridge exploded");
    };
    const first = gate({ blindTabs, unreachableSince, canReach, now: T0 });
    expect(first.blind).toBe(true);
    expect(blindTabs.has("boom")).toBe(true);

    // ...but a permanently-throwing probe must not pin the session forever either.
    const later = gate({
      blindTabs,
      unreachableSince,
      canReach,
      now: T0 + BLIND_TAB_GRACE_MS,
    });
    expect(later.blind).toBe(false);
    expect(later.pruned).toEqual(["boom"]);
  });

  it("a clock that moves BACKWARDS re-stamps instead of retiring early", () => {
    const blindTabs = new Set(["gone"]);
    const unreachableSince = new Map([["gone", T0]]);
    const r = gate({
      blindTabs,
      unreachableSince,
      canReach: () => false,
      now: T0 - 60_000,
    });
    expect(r.blind).toBe(true);
    expect(r.pruned).toEqual([]);
    expect(unreachableSince.get("gone")).toBe(T0 - 60_000);
  });

  it("drops a stale clock for a tab that left the set via an explicit blind-off", () => {
    const blindTabs = new Set<string>();
    const unreachableSince = new Map([["turned-off", T0]]);
    const r = gate({ blindTabs, unreachableSince, canReach: () => false, now: T0 });
    expect(r.blind).toBe(false);
    expect(unreachableSince.has("turned-off")).toBe(false);
  });
});
