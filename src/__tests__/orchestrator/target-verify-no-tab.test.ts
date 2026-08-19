// #1703 — after a direct ComfyUI restart, panel_set_workflow_target({mode:"current"})
// reported that its prescribed graph_query had succeeded and no recovery was needed.
// The immediately following panel_graph_outline then failed with no connected tab
// and listed a different short wf id. A second identical rebind recovered it.
//
// The #1473 settling read ran against a scope pin that still reached the OLD tab
// (a zombie socket in the reconnect overlap). ensureReachable will not move a
// scope-bound ctx, so the next graph command kept that dead routing key.
// The verification must confirm the connected-tab route the next command will
// use — or keep the probe unverified rather than claiming it succeeded.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

const { buildPanelToolDefs, makePanelToolCtx, __panelToolsTestHooks } = await import(
  "../../orchestrator/panel-tools.js"
);
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import { SHARED_SESSION_SCOPE } from "../../services/session-scope.js";
import { markDispatched } from "../../services/ui-bridge.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const SCOPE = `${SHARED_SESSION_SCOPE}::claude`;
const OLD = "wf:old-route:workflows/a.json";
const NEW = "wf:new-route:workflows/a.json";
const SAME_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

function def(name: string) {
  const found = buildPanelToolDefs().find((d) => d.name === name);
  if (!found) throw new Error(`${name} is not registered`);
  return found;
}

/**
 * Post-restart overlap: the scope is pinned to OLD, which is still in the
 * registry when the settling graph_query runs, then the reconnect completes
 * under NEW (a different wf:<route>:<path>) before the next graph command.
 *
 * `afterQuery` is applied after that first graph_query returns, so the test
 * can keep NEW, drop it, or leave the pin stranded.
 */
function reconnectingScopeBridge(opts?: { afterQuery?: (live: Set<string>) => void }) {
  const live = new Set<string>([OLD]);
  let pin = OLD;
  const sent: string[] = [];

  const resolve = (tabId?: string): string | undefined => {
    if (!tabId) return undefined;
    if (tabId === SCOPE) return pin;
    return tabId;
  };

  const throwNoTab = (wanted: string) => {
    const connected =
      [...live].map((t) => `${t.slice(0, 8)} (“${t}”)`).join(", ") || "none";
    throw markDispatched(
      new Error(`no connected tab with id "${wanted}". Connected: ${connected}`),
      false,
    );
  };

  const bridge = {
    send: async (cmd: Record<string, unknown>, o?: { tabId?: string }) => {
      sent.push(String(cmd.cmd));
      const routed = resolve(o?.tabId);
      if (o?.tabId && (routed == null || !live.has(routed))) throwNoTab(o.tabId);
      if (cmd.cmd === "workflow_list") {
        return {
          active: {
            path: "workflows/a.json",
            filename: "a.json",
            title: "a.json",
            key: "workflows/a.json",
            routing_key: pin,
            workflow_uuid: SAME_UUID,
          },
          workflows: [{ path: "workflows/a.json", active: true, modified: false, persisted: true }],
          active_confirmed: false,
        };
      }
      if (cmd.cmd === "graph_query") {
        // The reported race: the settling read answers on OLD, then the old
        // socket is replaced by a new route id for the same workflow.
        live.delete(OLD);
        live.add(NEW);
        opts?.afterQuery?.(live);
        return { ids: [1] };
      }
      if (cmd.cmd === "graph_outline") {
        return { outline: "1 CheckpointLoader", node_count: 1 };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: (id: string) => {
      const routed = resolve(id);
      return routed != null && live.has(routed);
    },
    liveTabIdFor: (id: string) => {
      const routed = resolve(id);
      return routed != null && live.has(routed) ? routed : undefined;
    },
    isHeadless: () => false,
    tabs: () => [...live].map((t) => ({ tab_id: t, title: "wf", connected_at: 0 })),
    resolveActiveTabId: () => [...live][0],
    resolveActiveScopeTab: () => [...live][0],
    refreshWorkflowUuid: () => true,
    workflowUuidFor: () => ({ known: true, uuid: SAME_UUID }),
    tabCanMutateGraph: () => false,
    tabGraphMutationCapability: () => ({ known: false, reason: "test" }),
    repinScopeToActive: (scopeId: string) => {
      if (scopeId !== SCOPE) return undefined;
      if (live.has(pin)) {
        return {
          repinned: false as const,
          reason: `the existing pin still reaches a live tab`,
        };
      }
      const tabs = [...live];
      if (tabs.length !== 1) {
        return { repinned: false as const, reason: "no single live tab to pin" };
      }
      pin = tabs[0];
      return pin;
    },
  } as unknown as PanelToolCtx["bridge"];

  return { bridge, sent, pinOf: () => pin };
}

beforeEach(() => {
  __panelToolsTestHooks.setRetrySettleMs(0);
  __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 1, intervalMs: 1 });
});

afterEach(() => {
  __panelToolsTestHooks.setRetrySettleMs(null);
  __panelToolsTestHooks.setReconnectWaitTiming(null);
});

describe("a settling graph_query during reconnect does not strand the next graph call (#1703)", () => {
  it("rebinds the dead scope pin so the following panel_graph_outline reaches the new tab", async () => {
    const { bridge, sent, pinOf } = reconnectingScopeBridge();
    const ctx = makePanelToolCtx(bridge, SCOPE, new WorkflowTargetStore());

    await def("panel_set_workflow_target").handler({ mode: "current" } as never, ctx);

    expect(sent).toContain("graph_query");
    expect(pinOf(), "the scope pin must follow the tab the next command will use").toBe(NEW);
    expect(bridge.canReach(SCOPE)).toBe(true);

    const outline = await def("panel_graph_outline").handler({} as never, ctx);
    expect(outline.isError, textOf(outline)).toBeFalsy();
    expect(textOf(outline)).toMatch(/CheckpointLoader/);
    expect(sent).toContain("graph_outline");
  });

  it("does not claim the graph_query succeeded when no connected tab remains", async () => {
    const { bridge, sent } = reconnectingScopeBridge({
      afterQuery: (live) => live.clear(),
    });
    const ctx = makePanelToolCtx(bridge, SCOPE, new WorkflowTargetStore());

    const bind = await def("panel_set_workflow_target").handler({ mode: "current" } as never, ctx);
    const bindText = textOf(bind);

    expect(sent).toContain("graph_query");
    expect(bind.isError).toBe(true);
    expect(bindText).not.toMatch(/it SUCCEEDED/);
    expect(bindText).not.toMatch(/Nothing suggests a recovery step is needed/);
    expect(bindText).not.toMatch(/"graph_binding":\s*"bound"/);
  });
});
