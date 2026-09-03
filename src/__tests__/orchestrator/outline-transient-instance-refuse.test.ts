// #2483 — panel_graph_outline can refuse a saved workflow while panel_query_graph
// already reads it.
//
// Immediately after a live layout edit and save-in-place, outline was refused
// with a workflow-instance mismatch. In the same tab, query_graph returned all
// 17 nodes. A later outline succeeded with no tab switch and no mutation. The
// panel/orchestrator had not finished reconciling the saved workflow's
// instance/generation, and outline failed closed on that race while the cheaper
// query already proved the current instance.
//
// Outline is inert, so one retry cannot double-apply. The retry fires only when
// the tab identity (routing id + connection generation) is unchanged AND a
// fresh graph_query answers for the same instance. A real mismatch — query also
// refused, tab moved, query named a different uuid — still refuses, and names
// both expected and observed instance ids.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/saved.json";
const OTHER_TAB = "wf:workflows/other.json";
const STAMP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LIVE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const OUTLINE = {
  node_count: 17,
  outline: "1 CheckpointLoaderSimple \"ckpt\"\n2 KSampler \"ks\"",
};
const QUERY = { count: 17, nodes: [{ id: 1 }, { id: 2 }] };

const mismatch = (expected: string, observed: string): Error =>
  new Error(
    `workflow instance mismatch: this command was issued for workflow instance ${expected}, ` +
      `and the active canvas reports ${observed}. Nothing was applied.`,
  );

function settled(uuid: string): Record<string, unknown> {
  const active = { path: "workflows/saved.json", routing_key: TAB, workflow_uuid: uuid };
  return { active, workflows: [{ ...active, active: true }], active_confirmed: true };
}

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

type Harness = {
  sent: string[];
  outlineCalls: number;
  queryCalls: number;
  corroborated: string[];
  generation: number;
  tabId: string;
  fence: string;
  queryReply: Record<string, unknown>;
  queryThrows: boolean;
  outlineRetryThrows: boolean;
  moveTabOnQuery: boolean;
  bumpGenerationOnQuery: boolean;
};

function harness(init?: Partial<Harness>): { h: Harness; bridge: PanelToolCtx["bridge"] } {
  const h: Harness = {
    sent: [],
    outlineCalls: 0,
    queryCalls: 0,
    corroborated: [],
    generation: 1,
    tabId: TAB,
    fence: STAMP,
    queryReply: QUERY,
    queryThrows: false,
    outlineRetryThrows: false,
    moveTabOnQuery: false,
    bumpGenerationOnQuery: false,
    ...init,
  };
  const box: { ctx: PanelToolCtx | null } = { ctx: null };
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test bridge is a partial mock of UiBridge
  const bridge = {
    send: async (cmd: Record<string, unknown>) => {
      const name = typeof cmd.cmd === "string" ? cmd.cmd : "";
      h.sent.push(name);
      if (name === "workflow_list") return settled(h.fence);
      if (name === "graph_query") {
        h.queryCalls += 1;
        if (h.moveTabOnQuery && box.ctx) box.ctx.tabId = OTHER_TAB;
        if (h.bumpGenerationOnQuery) h.generation += 1;
        if (h.queryThrows) throw mismatch(STAMP, LIVE);
        return h.queryReply;
      }
      if (name === "graph_outline") {
        h.outlineCalls += 1;
        if (h.outlineCalls === 1) throw mismatch(STAMP, LIVE);
        if (h.outlineRetryThrows) throw mismatch(STAMP, LIVE);
        return OUTLINE;
      }
      throw mismatch(STAMP, LIVE);
    },
    push: () => 1,
    canReach: (id: string) => id === h.tabId,
    isHeadless: () => false,
    tabs: () => [{ tab_id: h.tabId, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => h.tabId,
    workflowUuidFor: () => ({ known: true, uuid: h.fence }),
    refreshWorkflowUuid: (_tabId: string, uuid: string) => {
      h.fence = uuid;
      return true;
    },
    corroborateTabStamp: (_tabId: string, uuid: string) => {
      h.corroborated.push(uuid);
      return true;
    },
    tabConnectionIdentity: () => ({ generation: h.generation, tabSessionId: "browser-tab-a" }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  return { h, bridge, box };
}

async function callOutline(
  bridge: PanelToolCtx["bridge"],
  box: { ctx: PanelToolCtx | null },
): Promise<{ text: string; res: ToolResult; ctx: PanelToolCtx }> {
  const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
  box.ctx = ctx;
  const def = buildPanelToolDefs().find((d) => d.name === "panel_graph_outline");
  if (!def) throw new Error("panel_graph_outline is not registered");
  const res: ToolResult = await def.handler({} as never, ctx);
  return { text: textOf(res), res, ctx };
}

describe("#2483 panel_graph_outline retries once when query_graph proves the instance", () => {
  it("returns the outline when the first call races and query already reads this tab", async () => {
    const { h, bridge, box } = harness();
    const { text, res } = await callOutline(bridge, box);

    expect(res.isError).toBeFalsy();
    expect(text).toContain("CheckpointLoaderSimple");
    expect(h.outlineCalls).toBe(2);
    expect(h.queryCalls).toBe(1);
    expect(h.corroborated).toEqual([STAMP]);
    expect(h.sent.filter((c) => c === "graph_outline")).toEqual(["graph_outline", "graph_outline"]);
    expect(h.sent).toContain("graph_query");
  });

  it("CONTROL: panel_query_graph itself is not recovered by the outline retry", async () => {
    const { h, bridge } = harness({ queryThrows: true });
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const def = buildPanelToolDefs().find((d) => d.name === "panel_query_graph");
    if (!def) throw new Error("panel_query_graph is not registered");
    const res: ToolResult = await def.handler({} as never, ctx);
    const text = textOf(res);

    expect(res.isError).toBe(true);
    expect(text).toMatch(/workflow instance mismatch/);
    expect(h.outlineCalls).toBe(0);
    // The query is the refused command; it must not spawn a second query as an
    // outline-style retry (that retry is gated on graph_outline).
    expect(h.queryCalls).toBe(1);
  });

  it("stays refused when query_graph is also mismatched, and names both instance ids", async () => {
    const { h, bridge, box } = harness({ queryThrows: true });
    const { text, res } = await callOutline(bridge, box);

    expect(res.isError).toBe(true);
    expect(text).toMatch(/workflow instance mismatch/);
    expect(text).toContain(`instance expected=${STAMP}`);
    expect(text).toContain(`observed=${LIVE}`);
    expect(h.outlineCalls).toBe(1);
    expect(h.queryCalls).toBe(1);
  });

  it("does not retry when the tab identity moved during the query proof", async () => {
    const { h, bridge, box } = harness({ moveTabOnQuery: true });
    const { text, res } = await callOutline(bridge, box);

    expect(res.isError).toBe(true);
    expect(text).toMatch(/workflow instance mismatch/);
    expect(text).toContain(`instance expected=${STAMP}`);
    expect(h.outlineCalls).toBe(1);
    expect(h.queryCalls).toBe(1);
  });

  it("does not retry when the connection generation moved during the query proof", async () => {
    const { h, bridge, box } = harness({ bumpGenerationOnQuery: true });
    const { text, res } = await callOutline(bridge, box);

    expect(res.isError).toBe(true);
    expect(text).toMatch(/workflow instance mismatch/);
    expect(h.outlineCalls).toBe(1);
    expect(h.queryCalls).toBe(1);
  });

  it("does not retry when query_graph names a different workflow instance", async () => {
    const { h, bridge, box } = harness({
      queryReply: { ...QUERY, workflow_uuid: LIVE },
    });
    const { text, res } = await callOutline(bridge, box);

    expect(res.isError).toBe(true);
    expect(text).toMatch(/workflow instance mismatch/);
    expect(h.outlineCalls).toBe(1);
    expect(h.queryCalls).toBe(1);
  });

  it("names both instance ids when the outline retry still mismatches", async () => {
    const { h, bridge, box } = harness({ outlineRetryThrows: true });
    const { text, res } = await callOutline(bridge, box);

    expect(res.isError).toBe(true);
    expect(h.outlineCalls).toBe(2);
    expect(h.queryCalls).toBe(1);
    expect(text).toContain(`instance expected=${STAMP}`);
    expect(text).toContain(`observed=${LIVE}`);
  });
});
