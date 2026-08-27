import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(
  fileURLToPath(new URL("../../orchestrator/index.ts", import.meta.url)),
  "utf8",
);

/**
 * #2425 — `probeOk` was a `const` arrow declared ~2000 lines BELOW the hello-retarget
 * path that calls it, in the same function scope. A hello arriving while
 * the panel orchestrator entry function was still executing between the two reached the call first and
 * threw "Cannot access probeOk before initialization". The process-level handler
 * swallowed it as an ignored unhandled rejection, so the retarget silently did not
 * happen — it survived four releases that way.
 *
 * A TDZ is an ORDERING property, so the pin is structural: the binding must be a
 * FUNCTION DECLARATION, which hoists to the top of its scope and therefore cannot be
 * reached before initialisation no matter where the definition sits.
 */
describe("probeOk hoisting (#2425)", () => {
  it("is declared as a hoisted function, never a const arrow", () => {
    expect(SRC).toMatch(/async function probeOk\s*\(/);
    expect(SRC).not.toMatch(/const\s+probeOk\s*=/);
  });

  it("is still called from the hello-retarget path it was crashing on", () => {
    // A pin that stopped matching the caller would go green by deleting the
    // bug's reachability rather than its cause.
    expect(SRC).toMatch(/probe:\s*\(u\)\s*=>\s*probeOk\(u,/);
  });
});
