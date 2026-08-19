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
