// #1243 — panel_ask's timeout told the agent two things that were not true together.
//
// 1. The description said it "BLOCKS until they pick" and never disclosed the 285s cap.
// 2. The timeout result offered "or no interactive panel surface rendered it" — a cause
//    `ctx.ensureReachable()` had ALREADY excluded for this ask. Offering it sent the
//    agent to re-invoke "from an interactive ComfyUI tab" it was demonstrably on.
//
// These call askTimeoutResult DIRECTLY. An earlier version asserted on source text, and
// a mutation flipping `surfaceConfirmed` to a constant SURVIVED it — both branches were
// still present in the source, so the assertions could not tell which one ran.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { askTimeoutResult } from "../../orchestrator/panel-tools.js";

const text = (surfaceConfirmed: boolean) => {
  const r = askTimeoutResult("wf:t", "fp", { kind: "none" } as never, surfaceConfirmed);
  return r.content.map((c: { text?: string }) => c.text ?? "").join("\n");
};

describe("#1243 panel_ask timeout honesty", () => {
  it("a CONFIRMED surface is reported as a timeout, not a delivery guess", () => {
    const t = text(true);
    expect(t).toContain("this is a timeout, not a delivery failure");
    expect(t).toContain("may simply not have been at the screen");
    expect(t).not.toContain("no interactive panel surface rendered it");
  });

  it("an UNCONFIRMED surface still names the alternative — absence is not exclusion", () => {
    // Suppressing it unconditionally would be the same bug pointing the other way.
    const t = text(false);
    expect(t).toContain("no interactive panel surface rendered it");
    expect(t).toContain("could not establish which");
  });

  it("both wordings state how long was actually waited", () => {
    for (const t of [text(true), text(false)]) expect(t).toMatch(/\b285s\b/);
  });

  it("both keep a usable next step rather than only reporting failure", () => {
    for (const t of [text(true), text(false)]) expect(t).toContain("plain chat text");
  });

  it("the tool description discloses the ceiling instead of promising an unbounded block", () => {
    const src = readFileSync("src/orchestrator/panel-tools.ts", "utf8");
    const at = src.indexOf('"panel_ask",');
    const desc = src.slice(at, at + 1400);
    expect(desc).toContain("does NOT block forever");
    expect(desc).toMatch(/~?285s/);
  });
});
