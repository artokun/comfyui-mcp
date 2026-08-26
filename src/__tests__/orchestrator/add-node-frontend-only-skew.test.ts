// #1828 — panel_add_node for an allowlisted frontend-only type failed with
// "the ComfyUI backend does not provide it" and pointed at unrelated
// failed-import packs. The actual cause was panel version skew: the connected
// tab was running a pre-allowlist guard. After a pack update the same error
// persisted until a hard tab refresh (cached JS).
//
// The orchestrator must keep the panel's refusal and name the floor + the
// pack-update + Ctrl+Shift+R path, instead of leaving the backend-missing
// diagnosis as the last word.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { requiredPanelVersion } from "../../services/ui-bridge.js";
import { compareSemver } from "../../services/self-update.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";
const REPORTER_TYPE = "Fast Groups Muter (rgthree)";
const REPORTER_PANEL = "0.14.37";

/** The reporter's exact panel refusal (issue #1828). */
const REPORTER_REFUSAL =
  `Unknown node type "Fast Groups Muter (rgthree)" — the ComfyUI backend does not provide it ` +
  `(not installed, its pack was removed, or its pack failed to import). ` +
  `Check the exact class_type via create_workflow (action:"node_info") ` +
  `ComfyUI reported that these packs FAILED TO IMPORT at startup — .claude, teacache, foreach, ` +
  `comfyui-ltxvideo-registry-mattabyte.`;

function bridge(opts: {
  message: string;
  advertised?: string;
}) {
  const calls: string[] = [];
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push(String(cmd.cmd));
      throw new Error(opts.message);
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    advertisedPanelVersion: () =>
      opts.advertised ? { version: opts.advertised, raw: opts.advertised } : {},
  } as unknown as PanelToolCtx["bridge"];
  return { b, calls };
}

async function addNode(classType: string, message: string, advertised?: string) {
  const { b, calls } = bridge({ message, advertised });
  const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_add_node");
  if (!def) throw new Error("panel_add_node is not registered");
  const res: ToolResult = await def.handler({ class_type: classType } as never, ctx);
  return {
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    isError: res.isError === true,
    calls,
  };
}

describe("panel_add_node names panel version skew for allowlisted frontend-only types (#1828)", () => {
  it("the reporter's case: keeps the refusal and names pack update + hard refresh", async () => {
    const required = requiredPanelVersion();
    expect(compareSemver(REPORTER_PANEL, required)).toBeLessThan(0);

    const { text, isError, calls } = await addNode(
      REPORTER_TYPE,
      REPORTER_REFUSAL,
      REPORTER_PANEL,
    );

    expect(isError).toBe(true);
    expect(text).toContain(REPORTER_REFUSAL);
    expect(text).toContain(REPORTER_TYPE);
    expect(text).toContain(REPORTER_PANEL);
    expect(text).toContain(required);
    expect(text).toMatch(/NOT a missing backend pack/i);
    expect(text).toMatch(/frontend-only/i);
    expect(text).toMatch(/Ctrl\+Shift\+R/);
    expect(text).toMatch(/install_comfyui\(action:'panel', panel_action:'update'\)|update the panel pack on the ComfyUI host/);
    expect(text).toMatch(/cached old JS|hard-refresh/i);
    expect(calls).toEqual(["graph_add_node"]);
  });

  it("does not invent skew when the tab already announces the required floor", async () => {
    const required = requiredPanelVersion();
    const { text, isError } = await addNode(REPORTER_TYPE, REPORTER_REFUSAL, required);

    expect(isError).toBe(true);
    expect(text).toContain(REPORTER_REFUSAL);
    expect(text).not.toMatch(/NOT a missing backend pack/i);
    expect(text).not.toMatch(/Ctrl\+Shift\+R/);
  });

  it("does not invent skew when the tab announced no version", async () => {
    const { text, isError } = await addNode(REPORTER_TYPE, REPORTER_REFUSAL);

    expect(isError).toBe(true);
    expect(text).toContain(REPORTER_REFUSAL);
    expect(text).not.toMatch(/NOT a missing backend pack/i);
    expect(text).not.toMatch(/Ctrl\+Shift\+R/);
  });

  it("a type the current panel still refuses is left as a backend-missing error", async () => {
    // Bookmark is frontend-only but NOT on the add-node allowlist. Wrapping it
    // as version skew would send the caller to update a panel that would still
    // refuse the add.
    const { text, isError } = await addNode(
      "Bookmark (rgthree)",
      `Unknown node type "Bookmark (rgthree)" — the ComfyUI backend does not provide it ` +
        `(not installed, its pack was removed, or its pack failed to import).`,
      REPORTER_PANEL,
    );

    expect(isError).toBe(true);
    expect(text).not.toMatch(/NOT a missing backend pack/i);
    expect(text).not.toMatch(/Ctrl\+Shift\+R/);
  });

  it("a genuine missing backend type is left alone even on an old panel", async () => {
    const missing =
      `Unknown node type "KSampler" — the ComfyUI backend does not provide it ` +
      `(not installed, its pack was removed, or its pack failed to import).`;
    const { text, isError } = await addNode("KSampler", missing, REPORTER_PANEL);

    expect(isError).toBe(true);
    expect(text).toContain(missing);
    expect(text).not.toMatch(/NOT a missing backend pack/i);
    expect(text).not.toMatch(/Ctrl\+Shift\+R/);
  });
});

// #2000 — the OTHER refusal shape, and the one an old panel emits on a HEALTHY
// ComfyUI: panel_refresh_nodes timed out fetching /object_info, and the next
// panel_add_node "MarkdownNote" was refused because the panel's guard checked
// /object_info AVAILABILITY before consulting its frontend-only allowlist. The
// panel-side fix is comfyui-mcp-panel#1586; this note is what reaches a user who
// has not updated the panel yet, and the orchestrator ships far more often.

/** The reporter's exact panel refusal (issue #2000). */
const UNAVAILABLE_REFUSAL =
  `cannot verify node type "MarkdownNote" against the ComfyUI backend ` +
  `(object_info is unavailable — the backend is unreachable or the fetch failed). ` +
  `Refusing to add rather than trust a possibly-stale node cache (#458). Reconnect ComfyUI and retry.`;

describe("#2000 frontend-only type refused for an unavailable /object_info", () => {
  it("THE REPORTED CASE: names the fact that /object_info never lists this type, and says not to reinstall", async () => {
    const r = await addNode("MarkdownNote", UNAVAILABLE_REFUSAL, "0.15.97");
    expect(r.isError).toBe(true);
    // The panel's own refusal is KEPT — the note is appended, never a replacement.
    expect(r.text).toContain("object_info is unavailable");
    expect(r.text).toContain("FRONTEND-ONLY");
    expect(r.text).toMatch(/never lists it in \/object_info by design/i);
    expect(r.text).toMatch(/Do NOT reinstall a pack/i);
    // A healthy-but-slow ComfyUI produces this exact state; say so.
    expect(r.text).toMatch(/merely SLOW/i);
  });

  it("adds the version sentence ONLY when the tab actually advertised a version below the floor", async () => {
    // The floor is read to pick an INPUT, never to compute an expectation — a floor
    // that moves must not silently change what this test proves.
    const BELOW = "0.0.1";
    expect(compareSemver(BELOW, requiredPanelVersion())).toBeLessThan(0);
    const below = await addNode("MarkdownNote", UNAVAILABLE_REFUSAL, BELOW);
    expect(below.text).toContain(BELOW);
    expect(below.text).toMatch(/HARD-REFRESH/i);

    // No advertised version = no evidence of skew. The note still explains the type,
    // but must NOT assert a stale panel — panel#612: no definite verdicts from
    // absent evidence.
    const unknown = await addNode("MarkdownNote", UNAVAILABLE_REFUSAL);
    expect(unknown.text).toContain("FRONTEND-ONLY");
    expect(unknown.text).not.toMatch(/below this orchestrator's floor/i);
    expect(unknown.text).not.toMatch(/HARD-REFRESH/i);
    // …and it still gives the caller something to do.
    expect(unknown.text).toMatch(/wait a moment and retry/i);
  });

  it("THE REPORTER'S OWN VERSION is ABOVE the floor — so the note must not depend on skew", async () => {
    // Measured, and it is the reason this note is not gated on the version floor at
    // all: the reporter ran panel 0.15.98 while the floor is lower, because the floor
    // tracks BRIDGE CAPABILITY requirements, not "the version with the latest fixes".
    // Gating on it would have made this hint fire for almost nobody — and it is also
    // why #1828's skew note could never have fired for this reporter.
    const REPORTER_VERSION = "0.15.98";
    expect(compareSemver(REPORTER_VERSION, requiredPanelVersion())).toBeGreaterThan(0);
    const r = await addNode("MarkdownNote", UNAVAILABLE_REFUSAL, REPORTER_VERSION);
    expect(r.text).toContain("FRONTEND-ONLY");
    expect(r.text).toMatch(/merely SLOW/i);
    // No skew evidence ⇒ no skew claim.
    expect(r.text).not.toMatch(/below this orchestrator's floor/i);
  });

  it("does NOT tell a REAL backend type that it is frontend-only", async () => {
    // The same refusal shape for a type that genuinely needs /object_info must keep
    // the panel's wording untouched — this is the false-positive direction.
    const r = await addNode(
      "KSampler",
      UNAVAILABLE_REFUSAL.replace("MarkdownNote", "KSampler"),
      "0.15.97",
    );
    expect(r.isError).toBe(true);
    expect(r.text).toContain("object_info is unavailable");
    expect(r.text).not.toMatch(/FRONTEND-ONLY/);
    expect(r.text).not.toMatch(/Do NOT reinstall/i);
  });

  it("the two refusal shapes stay mutually exclusive — #1828 keeps its own note", async () => {
    const skew = await addNode(REPORTER_TYPE, REPORTER_REFUSAL, REPORTER_PANEL);
    expect(skew.text).toMatch(/NOT a missing backend pack/i);
    // The #2000 note must not also fire on the #1828 shape.
    expect(skew.text).not.toMatch(/merely SLOW/i);
  });
});
