// #1243 — panel_ask's timeout told the agent two things that were not true together.
//
// 1. The tool description said it "BLOCKS until they pick" and never mentioned that the
//    wait is capped at ASK_TOTAL_BUDGET_CAP_MS (285s). An agent budgeting a turn had no
//    way to know a single unanswered question costs five minutes.
// 2. The timeout result offered "or no interactive panel surface rendered it" as an
//    alternative cause — but `ctx.ensureReachable()` had already run for this ask, so
//    that cause was ALREADY excluded. Offering it sends the agent to re-invoke "from an
//    interactive ComfyUI tab" it was demonstrably already on.
//
// The surface flag is threaded rather than assumed because `ensureReachable` is
// optional-chained at the call site: when no check ran, the alternative is still live
// and is still named.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("src/orchestrator/panel-tools.ts", "utf8");

describe("#1243 panel_ask timeout honesty", () => {
  it("the tool description discloses the ceiling instead of promising an unbounded block", () => {
    const at = src.indexOf('"panel_ask",');
    const desc = src.slice(at, at + 1200);
    expect(desc).toContain("does NOT block forever");
    expect(desc).toMatch(/~?285s/);
  });

  it("a confirmed surface yields a TIMEOUT message, not a delivery-failure guess", () => {
    const fn = src.slice(src.indexOf("function askTimeoutResult("), src.indexOf("function askTimeoutResult(") + 1800);
    expect(fn).toContain("this is a timeout, not a delivery failure");
    expect(fn).toContain("may simply not have been at the screen");
  });

  it("the ruled-out cause is only offered when NO reachability check ran", () => {
    const fn = src.slice(src.indexOf("function askTimeoutResult("), src.indexOf("function askTimeoutResult(") + 1800);
    // The no-surface wording must live on the surfaceConfirmed=false side only.
    const branch = fn.indexOf("surfaceConfirmed");
    const noSurface = fn.indexOf("no interactive panel surface rendered it");
    const elseArm = fn.indexOf("    : `The question card was not answered within");
    expect(branch).toBeGreaterThan(-1);
    expect(noSurface).toBeGreaterThan(elseArm);
  });

  it("the ask call site passes surfaceConfirmed=true, because ensureReachable ran", () => {
    expect(src).toContain("askTimeoutResult(tabId, fingerprint, outcome.recovery, true)");
  });

  it("both wordings state how long was actually waited", () => {
    const fn = src.slice(src.indexOf("function askTimeoutResult("), src.indexOf("function askTimeoutResult(") + 1800);
    expect(fn).toContain("const waited = ");
    expect((fn.match(/\$\{waited\}/g) || []).length).toBe(2);
  });
});
