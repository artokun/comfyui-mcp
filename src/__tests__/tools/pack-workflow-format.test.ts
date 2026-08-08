// panel#775 — a pack shipping API/prompt format reached three tools that expect
// UI/litegraph, and each behaved differently: one refused, one crashed, one
// reported success on a 0-node graph. #1103 made all four refuse identically.
//
// This pins the INVARIANT the tools rely on, at the only place it can be caught
// before a user hits it: every pack's workflow.json is UI format. Nothing checked
// this, which is how a single bad file shipped and stayed shipped.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PACKS = join(process.cwd(), "packs");

/**
 * The one pack known to violate this, recorded rather than hidden.
 *
 * API/prompt format has already discarded node positions and link routing, so it
 * CANNOT be converted back to UI faithfully — fixing it needs a real UI export
 * from whoever authored the graph. Until that lands, this entry keeps the
 * invariant enforced for every OTHER pack (and for every pack added later)
 * instead of deleting the check because one file fails it.
 *
 * Do NOT add to this list to make a new pack pass. Export the UI workflow.
 */
const KNOWN_API_FORMAT: ReadonlyMap<string, string> = new Map([
  ["ltx23-distill-3stage", "panel#775 — ships API/prompt format; needs a UI re-export"],
]);

function packWorkflows(): { pack: string; file: string }[] {
  if (!existsSync(PACKS)) return [];
  return readdirSync(PACKS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ pack: e.name, file: join(PACKS, e.name, "workflow.json") }))
    .filter((p) => existsSync(p.file));
}

/** UI/litegraph carries a top-level `nodes` ARRAY. API/prompt is a map of node id
 *  → {class_type, inputs} and has no `nodes` at all. */
function isUiShape(parsed: unknown): boolean {
  return !!parsed && typeof parsed === "object" && Array.isArray((parsed as { nodes?: unknown }).nodes);
}

describe("panel#775 every pack ships a UI/litegraph workflow.json", () => {
  const found = packWorkflows();

  it("finds packs to check (a silent zero would make this test meaningless)", () => {
    expect(found.length).toBeGreaterThan(20);
  });

  for (const { pack, file } of found) {
    const known = KNOWN_API_FORMAT.get(pack);
    it(`${pack}${known ? " (known violation)" : ""}`, () => {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (known) {
        // Assert it is STILL broken. If someone fixes the export, this fails and
        // tells them to drop the entry — so the list cannot rot into a lie.
        expect(
          isUiShape(parsed),
          `${pack} is now UI format — remove it from KNOWN_API_FORMAT`,
        ).toBe(false);
        return;
      }
      expect(
        isUiShape(parsed),
        `${pack}/workflow.json is not UI format (no top-level \`nodes\` array). ` +
          `panel_load_workflow / flatten / slice / strip all require UI; export the UI ` +
          `workflow rather than the API/prompt one.`,
      ).toBe(true);
    });
  }

  it("the known-violation list names only packs that exist", () => {
    // A stale entry would silently weaken the check for a pack that was renamed.
    const names = new Set(found.map((p) => p.pack));
    for (const pack of KNOWN_API_FORMAT.keys()) expect(names.has(pack)).toBe(true);
  });
});
