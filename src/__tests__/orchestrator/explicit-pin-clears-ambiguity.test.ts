// panel#888 — after a reconnect delivered queued events from several tabs,
// `panel_graph_outline` refused as ambiguous (correct — #884's fence). The
// refusal names the way out:
//
//   Target a workflow explicitly (panel_set_workflow_target / panel_open_workflow)
//   or wait for the next single-origin message.
//
// The reporter did exactly that — `mode:"pinned"` with the exact active path. It
// reported success. The next `panel_graph_outline` returned the identical error.
//
// THE ADVICE WAS WIRED TO ONE MODE. `resolveTarget` throws the ambiguity error the
// moment `scopeTargetResolver` returns null. The escape hatch exists —
// `setScopeRepinHandler`, documented "EXPLICIT recovery from a DEAD or AMBIGUOUS
// pin" — but only `mode:"current"` ever reached it. `mode:"pinned"` wrote the
// workflow-target store and nothing else, so the tool reported success truthfully
// while the state actually blocking every subsequent command went untouched.
//
// The repin handler's OWN refusal already told the agent to do what did not work:
// "Name the workflow instead — panel_set_workflow_target with a path, or
// panel_open_workflow — and the pin follows it." It did not follow.
//
// WHY ROUTING `pinned` THROUGH THE SAME HANDLER IS SAFE. The P0 gate is shared
// rather than re-implemented: a pin that still reaches a live tab of this
// conversation is never displaced, however explicit the request. Only a dead or
// ambiguous pin can be recovered. A NAMED tab that is not eligible REFUSES —
// silently redirecting an explicit request to another workflow is the exact hazard
// #884 exists to prevent, and would be a worse bug than the one being fixed.
import { describe, expect, it, vi } from "vitest";

import { makeScopeRepinHandler, type ScopeRepinBridge } from "../../orchestrator/turn-origins.js";

const KEY = "orchestrator::codex";
const TAB_A = "wf:workflows/a.json";
const TAB_B = "wf:workflows/b.json";

/** `resolvedPinOf` is the real discriminator: string = a pin, null = ambiguous. */
function harness(opts: {
  pin: string | null | undefined;
  tabs: string[];
  reachable?: string[];
  active?: string;
  headless?: string[];
  backendOf?: (t: string) => string;
}) {
  const repinTo = vi.fn();
  const reachable = new Set(opts.reachable ?? opts.tabs);
  const bridge: ScopeRepinBridge = {
    canReach: (t) => reachable.has(t),
    resolveActiveScopeTab: () => opts.active,
    isHeadless: (t) => (opts.headless ?? []).includes(t),
    tabs: () => opts.tabs.map((tab_id) => ({ tab_id })),
  };
  const handler = makeScopeRepinHandler({
    bridge,
    tracker: { resolvedPinOf: () => opts.pin, repinTo } as never,
    scopeAgentKeyOf: () => KEY,
    backendForTab: opts.backendOf ?? (() => "codex"),
    backendOfKey: () => "codex",
    info: () => {},
  });
  return { handler, repinTo };
}

// ---------------------------------------------------------------------------
// 1. The fix: a NAMED workflow recovers an ambiguous pin.
// ---------------------------------------------------------------------------

describe("#888 naming a workflow recovers an AMBIGUOUS turn pin", () => {
  it("pins to the named tab", () => {
    // The reporter's state: pin is null (mixed-origin batch), several tabs live.
    const { handler, repinTo } = harness({ pin: null, tabs: [TAB_A, TAB_B] });

    expect(handler(KEY, TAB_B)).toBe(TAB_B);
    expect(repinTo).toHaveBeenCalledWith(KEY, TAB_B);
  });

  it("recovers even when NO active tab is among the eligible ones", () => {
    // This is the state whose own refusal says to name a workflow — and where
    // "current" is legitimately unable to choose. Naming one has to work here or
    // the advice is still a dead end.
    const { handler, repinTo } = harness({
      pin: null,
      tabs: [TAB_A, TAB_B],
      active: "wf:workflows/somebody-elses.json",
    });

    expect(handler(KEY, TAB_A)).toBe(TAB_A);
    expect(repinTo).toHaveBeenCalledWith(KEY, TAB_A);
  });

  it("recovers a DEAD pin by name too, not just an ambiguous one", () => {
    const { handler } = harness({ pin: "wf:workflows/gone.json", tabs: [TAB_A, TAB_B], reachable: [TAB_A, TAB_B] });

    expect(handler(KEY, TAB_B)).toBe(TAB_B);
  });
});

// ---------------------------------------------------------------------------
// 2. The P0 property. This must not become collateral of the fix.
// ---------------------------------------------------------------------------

describe("#888 a HEALTHY pin is still never displaced", () => {
  it("refuses even when a workflow is named explicitly", () => {
    // The whole point of the gate: an explicit request is not consent to steal a
    // live turn's binding. Naming a workflow must not become a way around it.
    const { handler, repinTo } = harness({ pin: TAB_A, tabs: [TAB_A, TAB_B] });

    const out = handler(KEY, TAB_B);
    expect(typeof out).toBe("object");
    expect((out as { reason: string }).reason).toMatch(/still reaches a live tab/);
    expect(repinTo).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. A named tab that is not eligible REFUSES — never a silent redirect.
// ---------------------------------------------------------------------------

describe("#888 an ineligible named tab refuses loudly", () => {
  it("does not fall back to the active tab", () => {
    // Falling back would answer an explicit "target workflow B" by pinning A —
    // a silent wrong-canvas re-target, worse than the bug being fixed.
    const { handler, repinTo } = harness({ pin: null, tabs: [TAB_A], active: TAB_A });

    const out = handler(KEY, "wf:workflows/not-open.json");
    expect(typeof out).toBe("object");
    expect((out as { reason: string }).reason).toMatch(/not a tab of this conversation/i);
    expect((out as { reason: string }).reason).toMatch(/NOT moved|not silently redirected/i);
    expect(repinTo).not.toHaveBeenCalled();
  });

  it("refuses a named tab that belongs to ANOTHER backend's conversation", () => {
    const { handler, repinTo } = harness({
      pin: null,
      tabs: [TAB_A, TAB_B],
      backendOf: (t) => (t === TAB_B ? "claude" : "codex"),
    });

    expect(typeof handler(KEY, TAB_B)).toBe("object");
    expect(repinTo).not.toHaveBeenCalled();
  });

  it("refuses a named tab that is headless", () => {
    const { handler, repinTo } = harness({ pin: null, tabs: [TAB_A, TAB_B], headless: [TAB_B] });

    expect(typeof handler(KEY, TAB_B)).toBe("object");
    expect(repinTo).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Naming nothing keeps the old behaviour exactly.
// ---------------------------------------------------------------------------

describe("#888 mode:'current' is unchanged", () => {
  it("still resolves via the active tab when no workflow is named", () => {
    const { handler } = harness({ pin: null, tabs: [TAB_A, TAB_B], active: TAB_B });

    expect(handler(KEY)).toBe(TAB_B);
  });

  it("still refuses when 'current' cannot identify one of several tabs", () => {
    const { handler } = harness({ pin: null, tabs: [TAB_A, TAB_B], active: "wf:other.json" });

    const out = handler(KEY);
    expect(typeof out).toBe("object");
    // ...and still points at the recovery that now actually works.
    expect((out as { reason: string }).reason).toMatch(/Name the workflow instead/);
  });
});

// ---------------------------------------------------------------------------
// 5. WIRING / REACHABILITY. The helper being right is worth nothing if
//    `mode:"pinned"` never calls it — which was the entire bug.
// ---------------------------------------------------------------------------

describe("#888 WIRING: the pinned path actually reaches the handler", () => {
  const src = () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    return readFileSync(new URL("../../orchestrator/panel-tools.ts", import.meta.url), "utf8");
  };

  it("panel_set_workflow_target calls repinScopeToTab on the pinned branch", () => {
    // The mutation this catches is deleting the call: every behavioural test
    // above still passes, because they drive the handler directly. Only the call
    // site can show the production path reaches it — the exact gap that made the
    // previous attempt at panel#887 a no-op.
    const s = src();
    expect(s).toMatch(/scopeRepin = ctx\.bridge\.repinScopeToTab\(ctx\.tabId, namedTab\)/);
    expect(s).toMatch(/mode === "pinned" && pinPath && isScopeAddress\(ctx\.tabId\)/);
  });

  it("the named tab is derived from the pinned PATH, not the active tab", () => {
    // `canonicalRequestedSavedIdentity` yields `wf:<canonical path>` and returns
    // null for a bare basename, which is why an alias cannot repin.
    expect(src()).toMatch(/const namedTab = canonicalRequestedSavedIdentity\(pinPath\)/);
  });

  it("the outcome is reported to the caller, not swallowed", () => {
    const s = src();
    expect(s).toMatch(/turn_routing: "repinned"/);
    expect(s).toMatch(/was NOT re-pinned: \$\{scopeRepin\.reason\}/);
  });
});
