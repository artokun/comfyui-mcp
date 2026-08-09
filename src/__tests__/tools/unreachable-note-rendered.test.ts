// S2 from the #1136 re-review: the user-visible half of the fix was unpinned.
//
// Gutting the `lines.push(result.catalogue_unavailable, "")` call in
// skills-access.ts killed ZERO tests — so "the note is rendered, and rendered
// BEFORE the misleading list" was true only by inspection. Producing the field
// and never printing it is the same class of miss as #694's install line: both
// halves covered, the join not.
//
// HONEST LIMITATION: this is a SOURCE assertion, not a render test. The
// renderers (installDepsAction / extractDepsAction) are not exported, so
// driving them means standing up the registered tool. A source scan cannot
// prove the string reaches a user — it only fails when someone deletes or
// reorders the push. That is strictly weaker than the integration test this
// deserves, and it is recorded here rather than dressed up as equivalent.

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const SRC = new URL("../../tools/skills-access.ts", import.meta.url);

describe("the #1136 caveats are actually printed, and printed first", () => {
  it("pushes catalogue_unavailable before the 'Could not resolve' header", async () => {
    const src = await readFile(SRC, "utf8");
    const push = src.indexOf("result.catalogue_unavailable");
    const header = src.indexOf("### Could not resolve");
    expect(push, "catalogue_unavailable must be rendered somewhere").toBeGreaterThan(-1);
    expect(header).toBeGreaterThan(-1);
    expect(push, "the caveat must come BEFORE the misleading header").toBeLessThan(header);
  });

  it("pushes mappings_unavailable before the 'Unresolved node types' header", async () => {
    const src = await readFile(SRC, "utf8");
    const push = src.indexOf("result.mappings_unavailable");
    const header = src.indexOf("### Unresolved node types");
    expect(push, "mappings_unavailable must be rendered somewhere").toBeGreaterThan(-1);
    expect(header).toBeGreaterThan(-1);
    expect(push).toBeLessThan(header);
  });

  it("still carries the claim the caveats exist to contradict", async () => {
    // If these strings ever leave, the caveats become noise and this test
    // should be revisited rather than deleted.
    const src = await readFile(SRC, "utf8");
    expect(src).toContain("neither installed nor known to ComfyUI-Manager");
    expect(src).toContain("Not found in ComfyUI-Manager");
  });
});
