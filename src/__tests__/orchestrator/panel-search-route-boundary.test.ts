// #1908 — panel_search_nodes is canvas-independent, so a frozen bound canvas
// tab must not consume the whole bridge window before the Manager query can be
// tried on another tab or return an honest structured timeout.

import { afterEach, describe, expect, it } from "vitest";
import {
  __panelToolsTestHooks,
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const BOUND = "bound-frozen";
const FALLBACK = "same-comfyui";

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
  clientOrigins: Record<string, string | undefined>;
  serverOrigins: Record<string, string | undefined>;
  headless?: string[];
  reachable?: Record<string, boolean>;
  send: (tabId: string, cmd: Record<string, unknown>, timeoutMs: number) => Promise<Record<string, unknown>>;
}): { bridge: PanelToolCtx["bridge"]; sent: Array<{ tabId?: string; cmd: Record<string, unknown>; timeoutMs?: number }> } {
  const sent: Array<{ tabId?: string; cmd: Record<string, unknown>; timeoutMs?: number }> = [];
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the fake implements only the route-boundary surface under test
  const bridge = {
    send: async (cmd: Record<string, unknown>, sendOpts?: { tabId?: string; timeoutMs?: number }) => {
      sent.push({ tabId: sendOpts?.tabId, cmd, timeoutMs: sendOpts?.timeoutMs });
      return opts.send(sendOpts?.tabId ?? "", cmd, sendOpts?.timeoutMs ?? 0);
    },
    tabs: () => opts.tabs.map((tab_id) => ({ tab_id, title: tab_id, connected_at: "now" })),
    isHeadless: (tabId: string) => opts.headless?.includes(tabId) ?? false,
    canReach: (tabId: string) => opts.reachable?.[tabId] ?? opts.tabs.includes(tabId),
    liveTabIdFor: (tabId: string) => (opts.tabs.includes(tabId) ? tabId : undefined),
    // Keep the spoofable client claim in the seam so the tests prove it is not
    // sufficient for authorization.
    tabOrigin: (tabId: string) => opts.clientOrigins[tabId],
    tabServerOrigin: (tabId: string) => opts.serverOrigins[tabId],
  } as unknown as PanelToolCtx["bridge"];
  return { bridge, sent };
}

afterEach(() => {
  __panelToolsTestHooks.setPanelSearchRouteTiming(null);
});

describe("panel_search_nodes MCP route boundary (#1908)", () => {
  it("uses server origin proof when client hello origins conflict", async () => {
    __panelToolsTestHooks.setPanelSearchRouteTiming({ budgetMs: 100, fallbackTriggerMs: 10 });
    const { bridge, sent } = routeBridge({
      tabs: [BOUND, FALLBACK],
      clientOrigins: { [BOUND]: "http://127.0.0.1:8188", [FALLBACK]: "https://spoofed.example" },
      serverOrigins: { [BOUND]: "http://127.0.0.1:8188/", [FALLBACK]: "http://127.0.0.1:8188" },
      send: async (tabId, cmd) => {
        if (tabId === BOUND) return new Promise<never>(() => undefined); // frozen listener: never starts
        return { count: 1, results: [{ id: "KJNodes", title: "KJNodes", description: "ok" }], cmd };
      },
    });
    const ctx = makePanelToolCtx(bridge, BOUND, new WorkflowTargetStore());
    const started = Date.now();
    const result = await searchDef().handler({ query: "kj", limit: 5 }, ctx);

    expect(Date.now() - started).toBeLessThan(500);
    expect(result.isError).toBeUndefined();
    expect(parseResult(result)).toMatchObject({
      count: 1,
      results: [{ id: "KJNodes" }],
    });
    expect(sent.map((entry) => entry.tabId)).toEqual([BOUND, FALLBACK]);
    expect(sent[0].cmd).toMatchObject({ cmd: "nodes_search", query: "kj", limit: 5 });
    expect(sent[0].timeoutMs).toBe(100);
    expect(sent[1].timeoutMs).toBeLessThanOrEqual(90);
    expect(ctx.tabId).toBe(BOUND);
  });

  it("rejects headless, unreachable, missing-proof, and mismatched-proof candidates", async () => {
    __panelToolsTestHooks.setPanelSearchRouteTiming({ budgetMs: 60, fallbackTriggerMs: 10 });
    const headless = "headless";
    const unreachable = "unreachable";
    const missingServerProof = "missing-server-proof";
    const mismatchedServerProof = "mismatched-server-proof";
    const { bridge, sent } = routeBridge({
      tabs: [BOUND, headless, unreachable, missingServerProof, mismatchedServerProof],
      clientOrigins: {
        [BOUND]: "http://127.0.0.1:8188",
        [headless]: "http://127.0.0.1:8188",
        [unreachable]: "http://127.0.0.1:8188",
        [missingServerProof]: "http://127.0.0.1:8188",
        [mismatchedServerProof]: "http://127.0.0.1:8188",
      },
      serverOrigins: {
        [BOUND]: "http://127.0.0.1:8188",
        [headless]: "http://127.0.0.1:8188",
        [unreachable]: "http://127.0.0.1:8188",
        [mismatchedServerProof]: "http://127.0.0.1:8189",
      },
      headless: [headless],
      reachable: { [unreachable]: false },
      send: async () => new Promise<never>(() => undefined),
    });
    const ctx = makePanelToolCtx(bridge, BOUND, new WorkflowTargetStore());
    const started = Date.now();
    const result = await searchDef().handler({ query: "missing" }, ctx);

    expect(Date.now() - started).toBeLessThan(500);
    expect(result.isError).toBeUndefined();
    expect(parseResult(result)).toMatchObject({
      count: 0,
      results: [],
      query: "missing",
      timed_out: true,
      panel_unresponsive: true,
      panel_route: "bound_tab_timeout",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].tabId).toBe(BOUND);
    expect(ctx.tabId).toBe(BOUND);
  });

  it("fails closed when the bound tab has no server origin proof", async () => {
    __panelToolsTestHooks.setPanelSearchRouteTiming({ budgetMs: 60, fallbackTriggerMs: 10 });
    const { bridge, sent } = routeBridge({
      tabs: [BOUND, FALLBACK],
      clientOrigins: { [BOUND]: "http://127.0.0.1:8188", [FALLBACK]: "http://127.0.0.1:8188" },
      serverOrigins: { [FALLBACK]: "http://127.0.0.1:8188" },
      send: async () => new Promise<never>(() => undefined),
    });
    const ctx = makePanelToolCtx(bridge, BOUND, new WorkflowTargetStore());
    const result = await searchDef().handler({ query: "missing-bound-proof" }, ctx);

    expect(result.isError).toBeUndefined();
    expect(parseResult(result)).toMatchObject({
      query: "missing-bound-proof",
      timed_out: true,
      panel_unresponsive: true,
      panel_route: "bound_tab_timeout",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].tabId).toBe(BOUND);
  });
});
