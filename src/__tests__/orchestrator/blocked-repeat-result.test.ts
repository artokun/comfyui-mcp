import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blockedRepeatResult } from "../../orchestrator/ollama-backend.js";

const SRC = readFileSync(
  fileURLToPath(new URL("../../orchestrator/ollama-backend.ts", import.meta.url)),
  "utf8",
);

/**
 * #2430 — REPEAT CALL BLOCKED used to return an error string with no payload
 * while telling the model to "use the earlier result". Small models then
 * invent the data (observed: 24.1 GB VRAM vs 31.84 GB, and a truncated argv
 * with an invented flag).
 *
 * These tests drive the shipped `blockedRepeatResult` (the loop's only
 * blocked-repeat answer). They fail on error-string-only and pass when the
 * earlier result is attached.
 */
describe("blockedRepeatResult (#2430)", () => {
  it("the tool loop answers a blocked repeat through the shipped function", () => {
    expect(SRC).toMatch(/blockedRepeatResult\(name, prior\?\.result\)/);
    expect(SRC).toMatch(/result: prior\?\.result \?\? text/);
    // The unfixed path inlined `{ text: \`REPEAT CALL BLOCKED…\`, isError: true }`
    // at the repeats >= 2 branch. The helper is the only answer now.
    expect(SRC).not.toMatch(/repeats >= 2\s*\?\s*\{/);
  });

  it("attaches the earlier payload instead of an error-string-only nudge", () => {
    const prior = JSON.stringify({
      vram_total_gb: 31.84,
      argv: "--feature-flag show_signin_button=true --enable-manager --listen 127.0.0.1,169.254.41.48 --port 8188 --fast",
    });
    const out = blockedRepeatResult("get_system_stats", prior);
    expect(out.isError).toBe(false);
    expect(out.text).toContain(prior);
    expect(out.text).toContain("31.84");
    expect(out.text).toContain("show_signin_button");
    // The unfixed path: isError + "Use the earlier result" with none of the
    // payload. That is the confabulation trap.
    expect(out.text.startsWith("REPEAT CALL BLOCKED")).toBe(false);
    expect(out.text).not.toMatch(/Use the earlier result/);
  });

  it("falls back to the breaker nudge only when there is no cached payload", () => {
    const out = blockedRepeatResult("get_system_stats", undefined);
    expect(out.isError).toBe(true);
    expect(out.text.startsWith("REPEAT CALL BLOCKED")).toBe(true);
    expect(out.text).toContain("get_system_stats");
  });
});
