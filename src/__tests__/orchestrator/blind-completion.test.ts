/**
 * #1861 — Blind must fail CLOSED at EVERY door a run completion enters.
 *
 * The panel's own `executed` frame arrives at the orchestrator's agent-event ingress; the
 * #1789 watchdog SYNTHESISES a completion when that frame never comes. The strip lived
 * inline at the first door only, so the second recorded the raw payload. That was inert
 * while its `images` was always empty — and #1853 filled it from `/history`, making the
 * bypass live: Blind ON plus a dropped `executed` frame attached the render's pixels to
 * the agent turn about 45 s later.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stripBlindCompletion } from "../../orchestrator/blind-completion.js";

const INDEX_TS = fileURLToPath(new URL("../../orchestrator/index.ts", import.meta.url));

const completion = () => ({
  kind: "executed",
  prompt_id: "p1",
  images: [
    { filename: "secret_render_00001_.png", type: "output" },
    { filename: "secret_render_00002_.png", type: "output" },
  ],
  note: "The render finished.",
});

describe("stripBlindCompletion (#1861)", () => {
  it("removes the pixels and says so when blind", () => {
    const out = stripBlindCompletion(completion(), true);
    expect(out.images).toEqual([]);
    expect(String(out.note)).toContain("Blind mode is ON: 2 image(s)");
    // The original note is kept — the disclosure is appended, not substituted.
    expect(String(out.note)).toContain("The render finished.");
    // It must also override a sighted instruction the agent would otherwise follow.
    expect(String(out.note)).toContain("Do NOT comment on motion, sharpness, composition");
  });

  it("passes the completion through untouched when not blind", () => {
    const ev = completion();
    const out = stripBlindCompletion(ev, false);
    expect(out).toBe(ev);
    expect(out.images).toHaveLength(2);
  });

  it("discloses nothing when there was nothing to withhold", () => {
    // A status-only completion has no pixels; claiming images were withheld would report
    // a withholding that never happened.
    const out = stripBlindCompletion({ kind: "executed", note: "It failed." }, true);
    expect(out.images).toEqual([]);
    expect(String(out.note)).toBe("It failed.");
    expect(String(out.note)).not.toContain("Blind mode is ON");
  });

  it("treats a malformed images field as nothing to withhold, and still empties it", () => {
    // Fail closed on shape too: whatever `images` was, it is [] afterwards.
    for (const bad of [undefined, null, "two", 7, {}]) {
      const out = stripBlindCompletion({ kind: "executed", images: bad } as never, true);
      expect(out.images).toEqual([]);
      expect(String(out.note ?? "")).not.toContain("Blind mode is ON");
    }
  });
});

describe("#1861 WIRING: both completion doors go through the strip", () => {
  // A strip that is correct and applied at one door is the bug this fixes. Assert on the
  // source, because the second door's payload reaches `RunCompletions.record` inside the
  // orchestrator's construction and no unit test stands that up.
  const src = readFileSync(INDEX_TS, "utf8");

  it("the pure strip is the only implementation", () => {
    expect(src).toMatch(/import \{ stripBlindCompletion \} from "\.\/blind-completion\.js";/);
    // The disclosure text must not have been copied back inline anywhere.
    expect(src).not.toMatch(/Blind mode is ON: \$\{/);
  });

  it("EVERY RunCompletions.record call strips first", () => {
    const calls = src.match(/RunCompletions\.record\([^)]*/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(
        /blindStrippedCompletion\(|evForTab/.test(call),
        `a completion is recorded without the blind strip: ${call}`,
      ).toBe(true);
    }
  });

  it("the ingress and the watchdog both name the strip", () => {
    expect(src).toMatch(/const evForTab = blindStrippedCompletion\(ev\);/);
    expect(src).toMatch(/RunCompletions\.record\(ticket\.tabId, blindStrippedCompletion\(payload\)/);
  });
});
