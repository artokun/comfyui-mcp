// #2415 — two defects that hide each other, both shipped in 7fc8920e (#2408).
//
// 1. The #971 recovery is unreachable for any normally-stored workflow. The
//    proof stores canonicalSavedRecordIdentity (`wf:workflows/demo.json`) and
//    compared it to canonicalBareSavedIdentity (`wf:demo.json`, or null for a
//    path containing `/`). Aligning those is the obvious fix.
// 2. Aligning (1) alone activates a fail-open: the proof is keyed to tabId +
//    savedIdentity, neither of which moves when the canvas does. A later
//    non-open canvas change would then accept a stale `{ok:true, routedTo}`.
//
// Tests drive the shipped matcher / drop and the tool path that uses them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetPanelBaseCache } from "../../services/panel-workspace.js";

const resetClient = vi.fn();
const resetObjectInfoCache = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: () => resetClient(),
  resetObjectInfoCache: () => resetObjectInfoCache(),
}));

const { buildPanelToolDefs, makePanelToolCtx, __panelToolsTestHooks, __openWorkflowTestHooks } =
  await import("../../orchestrator/panel-tools.js");
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import { markDispatched } from "../../services/ui-bridge.js";
import type { ExplicitCurrentRebindProof, PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const { legacyRebindMatchesRequested, dropStaleLegacyRebindProof } = __openWorkflowTestHooks;

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

function proofOf(savedIdentity: string, tabId = "tab-b"): ExplicitCurrentRebindProof {
  return { tabId, savedIdentity };
}

function reconnectingBridge(
  initial: string[] = [],
  activePath = "demo.json",
  resolveActiveTabId?: () => string,
) {
  const live = new Set(initial);
  const headless = new Set<string>();
  const sent: Array<{ cmd: Record<string, unknown>; tabId?: string }> = [];
  let currentPath = activePath;
  const bridge = {
    send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
      const id = opts?.tabId;
      if (id && !live.has(id)) {
        const connected = [...live].map((t) => `${t.slice(0, 8)} ("${t}")`).join(", ") || "none";
        throw markDispatched(new Error(`no connected tab with id "${id}". Connected: ${connected}`), false);
      }
      sent.push({ cmd, tabId: id });
      if (cmd.cmd === "workflow_list") {
        const active = { path: currentPath, routing_key: `wf:${currentPath}` };
        return {
          workflows: [...live].map((t) =>
            t === id
              ? { ...active, active: true }
              : { path: `${t}.json`, routing_key: `wf:${t}.json`, active: false },
          ),
          active,
        };
      }
      if (cmd.cmd === "workflow_new") {
        currentPath = "Unsaved Workflow";
        return { ok: true, routedTo: id, created: true, key: "tmp:new", routing_key: "tmp:new" };
      }
      return { ok: true, routedTo: id };
    },
    push: () => 1,
    canReach: (id: string) => live.has(id),
    isHeadless: (id: string) => headless.has(id),
    tabs: () => [...live].map((t) => ({ tab_id: t, title: t, connected_at: 0 })),
    resolveActiveTabId:
      resolveActiveTabId ??
      (() => {
        if (live.size === 1) return [...live][0];
        if (live.size === 0) throw new Error("Panel not reachable: no panel connected");
        throw new Error("Multiple panel tabs are connected and none is last active — pass tab_id.");
      }),
  } as unknown as PanelToolCtx["bridge"];
  return {
    bridge,
    live,
    headless,
    sent,
    setActivePath: (path: string) => {
      currentPath = path;
    },
  };
}

async function rebindCurrent(ctx: PanelToolCtx): Promise<ToolResult> {
  const target = buildPanelToolDefs().find((d) => d.name === "panel_set_workflow_target")!;
  return (await target.handler({ mode: "current" }, ctx)) as ToolResult;
}

async function openWorkflow(ctx: PanelToolCtx, path: string): Promise<ToolResult> {
  const open = buildPanelToolDefs().find((d) => d.name === "panel_open_workflow")!;
  return (await open.handler({ path }, ctx)) as ToolResult;
}

beforeEach(() => {
  __resetPanelBaseCache();
  __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 300, intervalMs: 5 });
});
afterEach(() => {
  __panelToolsTestHooks.setReconnectWaitTiming(null);
});

describe("legacyRebindMatchesRequested (#2415)", () => {
  it("matches a bare filename to the stored workflows/ identity — the unreachable recovery", () => {
    // Unfixed: `wf:workflows/demo.json` === canonicalBareSavedIdentity("demo.json")
    // is `wf:workflows/demo.json` === `wf:demo.json`.
    expect(legacyRebindMatchesRequested(proofOf("wf:workflows/demo.json"), "demo.json")).toBe(true);
  });

  it("matches the exact stored path", () => {
    expect(
      legacyRebindMatchesRequested(proofOf("wf:workflows/demo.json"), "workflows/demo.json"),
    ).toBe(true);
  });

  it("still matches the no-slash identity the existing #971 tests use", () => {
    expect(legacyRebindMatchesRequested(proofOf("wf:demo.json"), "demo.json")).toBe(true);
  });

  it("rejects a different file", () => {
    expect(legacyRebindMatchesRequested(proofOf("wf:workflows/demo.json"), "other.json")).toBe(false);
  });

  it("rejects a different workflows/ path that shares the basename", () => {
    expect(
      legacyRebindMatchesRequested(proofOf("wf:workflows/demo.json"), "other/demo.json"),
    ).toBe(false);
  });
});

describe("dropStaleLegacyRebindProof (#2415)", () => {
  it("keeps the proof when the live canvas is still that identity", () => {
    const ctx = {
      tabId: "tab-b",
      lastExplicitCurrentRebind: proofOf("wf:workflows/a.json"),
    };
    dropStaleLegacyRebindProof(ctx, {
      path: "workflows/a.json",
      routing_key: "wf:workflows/a.json",
    });
    expect(ctx.lastExplicitCurrentRebind).toEqual(proofOf("wf:workflows/a.json"));
  });

  it("drops the proof when the live canvas moved to a different saved workflow", () => {
    const ctx = {
      tabId: "tab-b",
      lastExplicitCurrentRebind: proofOf("wf:workflows/a.json"),
    };
    dropStaleLegacyRebindProof(ctx, {
      path: "workflows/b.json",
      routing_key: "wf:workflows/b.json",
    });
    expect(ctx.lastExplicitCurrentRebind).toBeUndefined();
  });

  it("drops the proof when the observation is not a saved identity", () => {
    const ctx = {
      tabId: "tab-b",
      lastExplicitCurrentRebind: proofOf("wf:a.json"),
    };
    dropStaleLegacyRebindProof(ctx, { ok: true, routedTo: "tab-b" });
    expect(ctx.lastExplicitCurrentRebind).toBeUndefined();
  });
});

describe("the shipped #971 recovery path (#2415)", () => {
  it("recovers a legacy open of a bare alias after rebind to a workflows/ path", async () => {
    const { bridge } = reconnectingBridge(["tab-a", "tab-b"], "workflows/demo.json", () => "tab-b");
    const ctx = makePanelToolCtx(bridge, "stale-tab", new WorkflowTargetStore());

    const rebound = await rebindCurrent(ctx);
    expect(rebound.isError).toBeFalsy();
    expect(ctx.tabId).toBe("tab-b");
    expect(ctx.lastExplicitCurrentRebind).toEqual(proofOf("wf:workflows/demo.json"));

    const opened = await openWorkflow(ctx, "demo.json");
    expect(opened.isError).toBeFalsy();
    expect(ctx.lastExplicitCurrentRebind).toBeUndefined();
  });

  it("does not accept a stale proof after a non-open canvas move", async () => {
    // Uses the no-slash identity so the unfixed comparison WOULD match — the
    // fail-open that aligning identities alone activates.
    const { bridge } = reconnectingBridge(["tab-a", "tab-b"], "a.json", () => "tab-b");
    const ctx = makePanelToolCtx(bridge, "stale-tab", new WorkflowTargetStore());

    expect((await rebindCurrent(ctx)).isError).toBeFalsy();
    expect(ctx.lastExplicitCurrentRebind).toEqual(proofOf("wf:a.json"));

    const created = buildPanelToolDefs().find((d) => d.name === "panel_new_workflow")!;
    expect(((await created.handler({}, ctx)) as ToolResult).isError).toBeFalsy();
    expect(ctx.lastExplicitCurrentRebind).toBeUndefined();

    const opened = await openWorkflow(ctx, "a.json");
    expect(opened.isError).toBe(true);
    expect(textOf(opened)).toMatch(/resolved path|UNKNOWN/i);
  });
});
