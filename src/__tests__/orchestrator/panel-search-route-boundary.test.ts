// #1908 — panel_search_nodes is canvas-independent, so a frozen bound canvas
// tab must not consume the whole bridge window before the Manager query returns
// an honest structured timeout. It must not be guessed onto another instance.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __panelToolsTestHooks,
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const BOUND = "bound-frozen";
const ALTERNATE = "unproven-alternate";

function searchDef() {
  const def = buildPanelToolDefs().find((entry) => entry.name === "panel_search_nodes");
  if (!def) throw new Error("panel_search_nodes is not registered");
  return def;
}

function parseResult(res: ToolResult): Record<string, unknown> {
  const text = res.content.find((block) => block.type === "text")?.text;
  if (!text) throw new Error("panel_search_nodes returned no text content");
  return JSON.parse(text) as Record<string, unknown>;
}

function routeBridge(opts: {
  tabs: string[];
  clientOrigins?: Record<string, string | undefined>;
  serverOrigins?: Record<string, string | undefined>;
  send: (tabId: string, cmd: Record<string, unknown>, timeoutMs: number) => Promise<Record<string, unknown>>;
}): {
  bridge: PanelToolCtx["bridge"];
  sent: Array<{ tabId?: string; cmd: Record<string, unknown>; timeoutMs?: number }>;
  probes: { tabs: ReturnType<typeof vi.fn>; tabServerOrigin: ReturnType<typeof vi.fn> };
} {
  const sent: Array<{ tabId?: string; cmd: Record<string, unknown>; timeoutMs?: number }> = [];
  const tabs = vi.fn(() => opts.tabs.map((tab_id) => ({ tab_id, title: tab_id, connected_at: "now" })));
  const tabServerOrigin = vi.fn((tabId: string) => opts.serverOrigins?.[tabId]);
  // Keep the tempting, weaker proof surfaces in the seam. The route must not
  // consult them: tabServerOrigin is pathless and cannot prove instance identity.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the fake implements only the route-boundary surface under test
  const bridge = {
    send: async (cmd: Record<string, unknown>, sendOpts?: { tabId?: string; timeoutMs?: number }) => {
      sent.push({ tabId: sendOpts?.tabId, cmd, timeoutMs: sendOpts?.timeoutMs });
      return opts.send(sendOpts?.tabId ?? "", cmd, sendOpts?.timeoutMs ?? 0);
    },
    tabs,
    isHeadless: () => false,
    canReach: (tabId: string) => opts.tabs.includes(tabId),
    liveTabIdFor: (tabId: string) => (opts.tabs.includes(tabId) ? tabId : undefined),
    tabOrigin: (tabId: string) => opts.clientOrigins?.[tabId],
    tabServerOrigin,
  } as unknown as PanelToolCtx["bridge"];
  return { bridge, sent, probes: { tabs, tabServerOrigin } };
}

afterEach(() => {
  __panelToolsTestHooks.setPanelSearchRouteTiming(null);
});

describe("panel_search_nodes MCP route boundary (#1908)", () => {
  it("starts the MCP deadline before dispatch and returns a bound-tab timeout", async () => {
    __panelToolsTestHooks.setPanelSearchRouteTiming({ budgetMs: 60 });
    const { bridge, sent } = routeBridge({
      tabs: [BOUND, ALTERNATE],
      send: async () => new Promise<never>(() => undefined), // frozen listener: never starts
    });
    const ctx = makePanelToolCtx(bridge, BOUND, new WorkflowTargetStore());
    const started = Date.now();
    const result = await searchDef().handler({ query: "kj", limit: 5 }, ctx);

    expect(Date.now() - started).toBeLessThan(500);
    expect(result.isError).toBeUndefined();
    expect(parseResult(result)).toMatchObject({
      count: 0,
      results: [],
      query: "kj",
      timed_out: true,
      panel_unresponsive: true,
      panel_route: "bound_tab_timeout",
      timeout_ms: 60,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].tabId).toBe(BOUND);
    expect(sent[0].cmd).toMatchObject({ cmd: "nodes_search", query: "kj", limit: 5 });
    expect(sent[0].timeoutMs).toBe(60);
    expect(ctx.tabId).toBe(BOUND);
  });

  it.each([
    {
      label: "same host/port with unknown path",
      clientOrigins: { [BOUND]: "http://127.0.0.1:8188/comfy-a", [ALTERNATE]: undefined },
      serverOrigins: { [BOUND]: "http://127.0.0.1:8188", [ALTERNATE]: "http://127.0.0.1:8188" },
    },
    {
      label: "same host/port with a different path claim",
      clientOrigins: {
        [BOUND]: "http://127.0.0.1:8188/comfy-a",
        [ALTERNATE]: "http://127.0.0.1:8188/comfy-b",
      },
      serverOrigins: { [BOUND]: "http://127.0.0.1:8188", [ALTERNATE]: "http://127.0.0.1:8188" },
    },
    {
      label: "missing server proof",
      clientOrigins: {
        [BOUND]: "http://127.0.0.1:8188/comfy-a",
        [ALTERNATE]: "http://127.0.0.1:8188/comfy-a",
      },
      serverOrigins: { [BOUND]: "http://127.0.0.1:8188", [ALTERNATE]: undefined },
    },
  ])("does not use an alternate tab for $label", async ({ clientOrigins, serverOrigins }) => {
    __panelToolsTestHooks.setPanelSearchRouteTiming({ budgetMs: 60 });
    const { bridge, sent, probes } = routeBridge({
      tabs: [BOUND, ALTERNATE],
      clientOrigins,
      serverOrigins,
      send: async () => new Promise<never>(() => undefined),
    });
    const ctx = makePanelToolCtx(bridge, BOUND, new WorkflowTargetStore());
    const result = await searchDef().handler({ query: "unproven" }, ctx);

    expect(parseResult(result)).toMatchObject({
      query: "unproven",
      timed_out: true,
      panel_unresponsive: true,
      panel_route: "bound_tab_timeout",
    });
    expect(sent.map((entry) => entry.tabId)).toEqual([BOUND]);
    expect(probes.tabs).not.toHaveBeenCalled();
    expect(probes.tabServerOrigin).not.toHaveBeenCalled();
    expect(ctx.tabId).toBe(BOUND);
  });

  it.each(["resolves", "rejects"] as const)(
    "consumes a late bridge reply that %s without an unhandled rejection",
    async (outcome) => {
      __panelToolsTestHooks.setPanelSearchRouteTiming({ budgetMs: 20 });
      let resolveLate!: (value: Record<string, unknown>) => void;
      let rejectLate!: (error: Error) => void;
      const late = new Promise<Record<string, unknown>>((resolve, reject) => {
        resolveLate = resolve;
        rejectLate = reject;
      });
      const { bridge, sent } = routeBridge({
        tabs: [BOUND],
        send: async () => late,
      });
      const ctx = makePanelToolCtx(bridge, BOUND, new WorkflowTargetStore());
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        const result = await searchDef().handler({ query: "late" }, ctx);
        expect(parseResult(result)).toMatchObject({
          query: "late",
          timed_out: true,
          panel_unresponsive: true,
          panel_route: "bound_tab_timeout",
        });
        expect(sent.map((entry) => entry.tabId)).toEqual([BOUND]);

        if (outcome === "resolves") {
          resolveLate({ count: 1, results: [{ id: "late-reply" }] });
        } else {
          rejectLate(new Error("late bridge rejection"));
        }
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    },
  );
});
