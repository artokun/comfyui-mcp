// panel#1859 — the #2314 promoted-write fence was gated on a panel version the
// panel never released.
//
// `BRIDGE_CAPABILITY_MIN_PANEL_VERSION` said 0.15.97 for all three #2314
// capabilities. The panel's tags go 0.15.96 → 0.15.98; there is no 0.15.97, and
// the keys are absent from every published build up to and including 0.15.100.
// They first appear in v0.15.101:web/js/lib/session-rebind.js — the same release
// that added the `subgraph_of.graph_identity` the fence reads.
//
// The cost was not cosmetic. `requiredPanelVersion()` folds this table, so
// install_comfyui(action:'panel', panel_action:'status') called 0.15.98,
// 0.15.99 and 0.15.100 current while every promoted-container write on them was
// refused — the user is told they are up to date by the same orchestrator that
// is refusing them for being out of date.
//
// These numbers are therefore PINNED to a published tag, not to a merge commit:
// a fix that lands after a release cut ships in the NEXT one, which is how the
// off-by-one on `enforces_expected_node_type_at_write` (0.15.58 → 0.15.59)
// happened too. To move one, check the tag, not the PR.

import { describe, expect, it } from "vitest";

import {
  BRIDGE_CAPABILITY_MIN_PANEL_VERSION,
  panelVersionForCapability,
  requiredPanelVersion,
  SEMVER_RE,
} from "../../services/ui-bridge.js";
import { compareSemver } from "../../services/self-update.js";

/** Capability → the first PUBLISHED panel tag whose bundle advertises it.
 *  Verified with `git grep -c "<key>" v0.15.NNN -- web` in comfyui-mcp-panel. */
const VERIFIED_AGAINST_A_PUBLISHED_TAG: Readonly<Record<string, string>> = {
  // absent in v0.15.58, present in v0.15.59
  enforces_expected_node_type_at_write: "0.15.59",
  // absent in v0.15.96/98/99/100 (there is no v0.15.97), present in v0.15.101
  enforces_expected_scope_at_write: "0.15.101",
  enforces_expected_scope_graph_identity_at_write: "0.15.101",
  enforces_promoted_parent_rail_at_write: "0.15.101",
};

describe("panel#1859 — the capability floor names a version the panel actually shipped", () => {
  it.each(Object.entries(VERIFIED_AGAINST_A_PUBLISHED_TAG))(
    "%s is pinned to %s",
    (capability, tag) => {
      expect(BRIDGE_CAPABILITY_MIN_PANEL_VERSION[capability]).toBe(tag);
    },
  );

  it("does not reintroduce 0.15.97, which was never published", () => {
    expect(Object.values(BRIDGE_CAPABILITY_MIN_PANEL_VERSION)).not.toContain("0.15.97");
  });

  it("the aggregate sync floor is at least the promoted-write floor", () => {
    // The two answers are allowed to differ (the aggregate may be higher), but
    // the aggregate must never sit BELOW a capability the orchestrator refuses
    // on — that is the #708 shape this issue hit: "you are current" from the
    // same build that is refusing you for being old.
    const promoted = panelVersionForCapability("enforces_expected_scope_graph_identity_at_write");
    expect(promoted).toBeTruthy();
    expect(compareSemver(requiredPanelVersion(), String(promoted))).toBeGreaterThanOrEqual(0);
  });
});

describe("panel#1859 — panelVersionForCapability", () => {
  it("returns the table entry for a known capability", () => {
    expect(panelVersionForCapability("enforces_expected_scope_at_write")).toBe("0.15.101");
  });

  it("returns undefined for a capability the table does not know", () => {
    // A message composed from this must degrade to naming the remedy without a
    // number, never fall back to the aggregate floor (#352/#619) and never
    // fabricate one.
    expect(panelVersionForCapability("enforces_something_invented")).toBeUndefined();
  });

  it("returns undefined rather than a value SEMVER_RE would reject", () => {
    // Guards the screen itself: every published entry must pass, so a future
    // typo ("0.15.101.1", "v0.15.101-") surfaces here instead of reaching a
    // user-facing sentence as an unverifiable number.
    for (const [capability, value] of Object.entries(BRIDGE_CAPABILITY_MIN_PANEL_VERSION)) {
      expect(SEMVER_RE.test(value.trim()), `${capability} = ${value}`).toBe(true);
      expect(panelVersionForCapability(capability)).toBe(value.trim());
    }
  });
});
