// panel#654 — after a confirmed restart the tool reported `server_ready:true`
// with `panel_tab_reconnected:false`, and the reporter had to refresh the browser
// by hand.
//
// THE PATH. `panel_tab_reconnected` was `tabBack`, i.e.
// `awaitPostRestartReachable(preRestartPanelIdentity, …)`, which opens with
//
//   if (before == null) return false;   // immediate — nothing is awaited
//
// `before` is `bridge.tabConnectionIdentity(tabId)`, undefined whenever the
// socket is not OPEN **at capture time** (captured BEFORE the restart dispatch,
// so a socket still settling after a Manager install lands exactly there), the
// tab session id is absent, or resolveTarget throws.
//
// So `false` meant two unrelated things: "watched, did not come back", and
// "nothing was ever watched". The reporter's output is reproducible with the
// panel never having failed — which is why every panel-side measurement in that
// thread showed healthy recovery. The orchestrator never looked.
//
// WHAT IS NOT CHANGED. `ready` and `graph_tools_ready` still key off the boolean,
// so an undetermined reconnect still withholds graph tools. Failing closed on
// CAPABILITY is right. What changes is that the reply stops asserting an
// observation nobody made — `"unknown"`, following this file's existing
// `stale: true | "unknown"` shape rather than adding a field a reader could miss
// while still acting on the misleading boolean.
import { describe, expect, it } from "vitest";

import { classifyTabReconnect } from "../../orchestrator/panel-tools.js";

// ---------------------------------------------------------------------------
// 1. The decision.
// ---------------------------------------------------------------------------

describe("#654 a reconnect that was never watched is not a failed reconnect", () => {
  it("no baseline captured ⇒ unknown, even though the server came back", () => {
    // The reporter's exact state.
    expect(classifyTabReconnect({ serverReady: true, baselineCaptured: false, tabBack: false })).toBe("unknown");
  });

  it("baseline captured and the tab did not return ⇒ a real false", () => {
    // The honest negative must survive: this is a genuine observation.
    expect(classifyTabReconnect({ serverReady: true, baselineCaptured: true, tabBack: false })).toBe(false);
  });

  it("the tab returned ⇒ true, however the baseline went", () => {
    for (const baselineCaptured of [true, false]) {
      expect(classifyTabReconnect({ serverReady: true, baselineCaptured, tabBack: true })).toBe(true);
    }
  });

  it("server never came back ⇒ unknown, because the tab is only watched after it does", () => {
    // Reporting `false` here would blame the tab for the server's failure.
    for (const baselineCaptured of [true, false]) {
      expect(classifyTabReconnect({ serverReady: false, baselineCaptured, tabBack: false })).toBe("unknown");
    }
  });

  it("a returned tab is never downgraded by an unhealthy server reading", () => {
    // Defensive: tabBack:true is a positive observation and outranks everything.
    expect(classifyTabReconnect({ serverReady: false, baselineCaptured: true, tabBack: true })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. The gate. This must NOT become collateral of the honesty fix.
// ---------------------------------------------------------------------------

describe("#654 the strictness of ready/graph_tools_ready is untouched", () => {
  it("unknown is still not ready — the boolean still gates", () => {
    // `ready`/`graph_tools_ready` are computed from `tabBack`, not from this
    // classification, so an unproven reconnect still withholds graph tools. If a
    // refactor ever routes the gate through the classification, "unknown" must
    // not become truthy — this is the assertion that would catch it.
    const verdict = classifyTabReconnect({ serverReady: true, baselineCaptured: false, tabBack: false });
    expect(verdict).not.toBe(true);
    // …and it is explicitly not a bare false either, which is the whole fix.
    expect(verdict).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 3. WIRING. The classifier being right is worth nothing if the restart replies
//    still emit the raw boolean — which is the bug.
// ---------------------------------------------------------------------------

describe("#654 WIRING: both restart replies report the classification", () => {
  const src = () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    return readFileSync(new URL("../../orchestrator/panel-tools.ts", import.meta.url), "utf8");
  };

  it("neither reply emits the bare boolean any more", () => {
    const s = src();
    expect(/panel_tab_reconnected: tabBack\b/.test(s), "a reply still emits the raw boolean").toBe(false);
    expect((s.match(/panel_tab_reconnected: tabReconnect\b/g) ?? []).length).toBe(2);
  });

  it("both call sites derive baselineCaptured from the pre-restart identity", () => {
    // The mutation this catches is `baselineCaptured: true` — which type-checks,
    // reads plausibly, and restores the bug exactly.
    expect((src().match(/baselineCaptured: preRestartPanelIdentity != null/g) ?? []).length).toBe(2);
  });

  it("the undetermined note tells the reader what to do INSTEAD of refreshing", () => {
    // The refresh is the manual step this issue is about; on this path it may
    // never have been necessary. Both replies must offer the cheap check first.
    const s = src();
    // >= 2, not == 2: an exact count of a PHRASE across a 12k-line file is
    // hostage to any other line that happens to say it (there is already a third).
    // The invariant is "both notes say it", not "the file says it twice".
    expect((s.match(/could NOT be determined/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // Both notes point at the cheap probe first, and neither ASSERTS which of the
    // three causes applied — the whole point of this fix is not asserting an
    // unobserved fact, and the first cut of these very notes did exactly that.
    expect((s.match(/panel_list_workflows/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // "WHY is not" and NOT the fuller phrase: these notes are built by
    // concatenating literals, and the sentence splits across a `+` at a different
    // word in each one. I wrote the caveat above and then matched a longer phrase
    // anyway; it found 0 of 2. Short tokens that cannot straddle a break are the
    // only prose worth asserting on — which is itself the argument for the
    // behavioural test below rather than more of these.
    expect((s.match(/WHY is not/g) ?? []).length).toBe(2);
    expect(/watched \(its socket was not/.test(s), "a note still states one cause as fact").toBe(false);
    expect((s.match(/UNPROVEN|unproven/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 4. The BEHAVIOURAL coverage lives in panel-restart-legacy-fallback.test.ts,
//    which already has the hoisted config/process-control mocks needed to reach
//    the restart reply. A first attempt here rebuilt that harness from scratch,
//    could not get past the preflight refusal, and guarded its assertions with
//    `if (text.includes("panel_tab_reconnected"))` — which made it pass
//    vacuously. It survived the very gate refactor it claimed to catch. Deleted
//    rather than left looking like coverage.
// ---------------------------------------------------------------------------
