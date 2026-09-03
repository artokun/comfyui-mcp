// #2544 — panel_query_graph refused read-only inspection after manual
// MiniMaxH3Director custom prompt / builder UI edits with [root-shape-mismatch]
// even though workflow and canvas both reported 24 nodes. The difference is
// CONTENT, not size. Re-open / rebind would discard unsaved builder work.
//
// Tests drive the shipped classifier, recoverContentOnlyGraphQuery, and the
// real panel_query_graph handler. A size or identity mismatch must still refuse,
// and no recovery may dispatch workflow_open / set_workflow_target.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import {
  CONTENT_ONLY_QUERY_NOTE,
  CONTENT_ONLY_QUERY_REFUSAL_NOTE,
  contentOnlyRootShapeReadNote,
  isContentOnlyRootShapeMismatch,
  isRootShapeMismatch,
  recoverContentOnlyGraphQuery,
  uiGraphToApiGraph,
} from "../../orchestrator/root-shape-mismatch.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/video_minimax_h3_t2v.json";
const PROMPT = "wide shot of a rain-soaked street at dusk, neon reflections";

const CONTENT_ONLY = (
  `[root-shape-mismatch] The live graph is out of sync with the active workflow: both the workflow ` +
  `and the live canvas report 24 node(s), but the canvas does not reproduce the workflow's own ` +
  `state - the difference is in the graph's CONTENT, not its size. The panel cannot tell whether ` +
  `this is a DIFFERENT workflow's canvas or this workflow's own canvas drifted from the state it ` +
  `last captured, so it was NOT applied. Re-open the active workflow tab (panel_open_workflow) ` +
  `to rebind the graph in place; if that does not clear it, reload the panel (panel_reload ` +
  `scope:frontend), then retry.`
);

const STRUCTURE_EXACT = (
  `[root-shape-mismatch] The live canvas reproduces this workflow's STRUCTURE exactly — same ` +
  `node ids and types (24), same links, groups and subgraphs — but its CONTENT differs from the ` +
  `state the workflow last captured, and the canvas carries no identity stamp proving it is this ` +
  `workflow's. Re-open the active workflow tab (panel_open_workflow).`
);

const SIZE_MISMATCH = (
  `[root-shape-mismatch] The live graph is out of sync with the active workflow: the workflow ` +
  `reports 23 node(s) but the live canvas holds 24 — it is bound to a different graph. The canvas ` +
  `therefore holds a graph other than the one the workflow describes, so this command was NOT ` +
  `applied. Re-open the active workflow tab (panel_open_workflow) to rebind the graph in place.`
);

const UUID_MISMATCH = (
  `[root-workflow-uuid-mismatch] The live canvas carries a different workflow's identity tag ` +
  `than the active workflow, so this command was NOT applied. Re-open the active workflow tab ` +
  `(panel_open_workflow) to rebind the graph in place.`
);

const LIVE_NODES = Array.from({ length: 24 }, (_, i) => {
  if (i === 0) {
    return {
      id: 1,
      type: "MiniMaxH3Director",
      title: "Director",
      widgets_values_named: { prompt: PROMPT, duration: 6 },
    };
  }
  return { id: i + 1, type: "PreviewImage", widgets_values_named: {} };
});

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

function defOf(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`${name} is not registered`);
  return def;
}

type Harness = {
  sent: string[];
  queryThrows: string | null;
  serializeThrows: string | null;
  stateThrows: string | null;
};

function harness(init?: Partial<Harness>): { h: Harness; ctx: PanelToolCtx } {
  const h: Harness = {
    sent: [],
    queryThrows: CONTENT_ONLY,
    serializeThrows: null,
    stateThrows: CONTENT_ONLY,
    ...init,
  };
  const bridge = {
    send: async (cmd: Record<string, unknown>) => {
      const name = typeof cmd.cmd === "string" ? cmd.cmd : "";
      h.sent.push(name);
      if (name === "graph_query" && h.queryThrows) throw new Error(h.queryThrows);
      if (name === "graph_serialize") {
        if (h.serializeThrows) throw new Error(h.serializeThrows);
        return { nodes: LIVE_NODES, links: [] };
      }
      if (name === "graph_get_state") {
        if (h.stateThrows) throw new Error(h.stateThrows);
        return {
          nodes: LIVE_NODES.map((n) => ({
            id: n.id,
            type: n.type,
            title: "title" in n ? n.title : undefined,
            widgets: n.widgets_values_named,
          })),
        };
      }
      if (name === "workflow_list") {
        return {
          active: { path: "workflows/video_minimax_h3_t2v.json", routing_key: TAB },
          workflows: [{ path: "workflows/video_minimax_h3_t2v.json", active: true }],
          active_confirmed: true,
        };
      }
      throw new Error(h.queryThrows ?? CONTENT_ONLY);
    },
    push: () => 1,
    canReach: (id: string) => id === TAB,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    workflowUuidFor: () => ({ known: true, uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as PanelToolCtx["bridge"];
  return { h, ctx: makePanelToolCtx(bridge, TAB, new WorkflowTargetStore()) };
}

describe("content-only root-shape-mismatch classifier (#2544)", () => {
  it("matches the reporter's equal-size CONTENT wording", () => {
    expect(isRootShapeMismatch(CONTENT_ONLY)).toBe(true);
    expect(isContentOnlyRootShapeMismatch(CONTENT_ONLY)).toBe(true);
    expect(isContentOnlyRootShapeMismatch(`Error: ${CONTENT_ONLY}`)).toBe(true);
  });

  it("matches the structure-exact content-drift wording", () => {
    expect(isContentOnlyRootShapeMismatch(STRUCTURE_EXACT)).toBe(true);
  });

  it("does NOT match a size disagreement", () => {
    expect(isRootShapeMismatch(SIZE_MISMATCH)).toBe(true);
    expect(isContentOnlyRootShapeMismatch(SIZE_MISMATCH)).toBe(false);
  });

  it("does NOT match a quoted token or a uuid-mismatch verdict", () => {
    expect(
      isContentOnlyRootShapeMismatch(
        `a log quoted [root-shape-mismatch] CONTENT, not its size while diagnosing`,
      ),
    ).toBe(false);
    expect(isRootShapeMismatch(UUID_MISMATCH)).toBe(false);
    expect(isContentOnlyRootShapeMismatch(UUID_MISMATCH)).toBe(false);
  });

  it("the rewritten note forbids destructive reopen", () => {
    const note = contentOnlyRootShapeReadNote(CONTENT_ONLY);
    expect(note).toContain("[root-shape-mismatch]");
    expect(note).toContain(CONTENT_ONLY_QUERY_REFUSAL_NOTE);
    expect(note).toMatch(/Do NOT panel_open_workflow/i);
  });
});

describe("recoverContentOnlyGraphQuery (#2544)", () => {
  it("queries the live serialize when graph_query is the refused command", async () => {
    const sent: string[] = [];
    const recovered = await recoverContentOnlyGraphQuery(
      async (cmd) => {
        sent.push(String(cmd.cmd));
        if (cmd.cmd === "graph_serialize") {
          return { content: [{ type: "text", text: JSON.stringify({ nodes: LIVE_NODES }) }] };
        }
        throw new Error(`unexpected ${String(cmd.cmd)}`);
      },
      { types: ["MiniMaxH3Director"], fields: "detail" },
    );
    expect(recovered, "unfixed: content-only drift had no read-only inspect path").not.toBeNull();
    expect(recovered?.recovered_from).toBe("graph_serialize");
    expect(recovered?.content_drift).toBe("content-only");
    expect(recovered?.note).toBe(CONTENT_ONLY_QUERY_NOTE);
    expect(String(recovered?.text)).toContain("MiniMaxH3Director");
    expect(String(recovered?.text)).toContain(PROMPT);
    expect(sent).toEqual(["graph_serialize"]);
    expect(sent).not.toContain("workflow_open");
    expect(sent).not.toContain("workflow_load");
  });

  it("falls back to graph_get_state when serialize is also content-only refused", async () => {
    const recovered = await recoverContentOnlyGraphQuery(async (cmd) => {
      if (cmd.cmd === "graph_serialize") {
        return { isError: true, content: [{ type: "text", text: `Error: ${CONTENT_ONLY}` }] };
      }
      if (cmd.cmd === "graph_get_state") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                nodes: [{ id: 1, type: "MiniMaxH3Director", widgets: { prompt: PROMPT } }],
              }),
            },
          ],
        };
      }
      throw new Error(`unexpected ${String(cmd.cmd)}`);
    });
    expect(recovered?.recovered_from).toBe("graph_get_state");
    expect(String(recovered?.text)).toContain("MiniMaxH3Director");
  });

  it("CONTROL: a size mismatch on serialize does not inspect the wrong canvas", async () => {
    const recovered = await recoverContentOnlyGraphQuery(async (cmd) => {
      if (cmd.cmd === "graph_serialize") {
        return { isError: true, content: [{ type: "text", text: `Error: ${SIZE_MISMATCH}` }] };
      }
      if (cmd.cmd === "graph_get_state") {
        return { content: [{ type: "text", text: JSON.stringify({ nodes: LIVE_NODES }) }] };
      }
      throw new Error(`unexpected ${String(cmd.cmd)}`);
    });
    expect(recovered).toBeNull();
  });

  it("maps named widgets from a UI serialize for the query engine", () => {
    const api = uiGraphToApiGraph(LIVE_NODES);
    expect(api["1"]?.class_type).toBe("MiniMaxH3Director");
    expect(api["1"]?.inputs.prompt).toBe(PROMPT);
    expect(Object.keys(api)).toHaveLength(24);
  });
});

describe("#2544 panel_query_graph inspects content-only drift without rebind", () => {
  it("returns the live MiniMaxH3Director after the reporter's equal-size refusal", async () => {
    const { h, ctx } = harness();
    const res = await defOf("panel_query_graph").handler(
      { types: ["MiniMaxH3Director"], fields: "detail" } as never,
      ctx,
    );
    const text = textOf(res);

    expect(res.isError, "unfixed: content-only drift still blocked inspection").toBeFalsy();
    expect(text).toContain("MiniMaxH3Director");
    expect(text).toContain(PROMPT);
    expect(text).toContain("content-only");
    expect(h.sent).toContain("graph_query");
    expect(h.sent).toContain("graph_serialize");
    expect(h.sent).not.toContain("workflow_open");
    expect(h.sent).not.toContain("workflow_load");
    expect(h.sent.filter((c) => c === "graph_set_workflow_target")).toEqual([]);
  });

  it("rewrites the refusal instead of recommending reopen when the live capture also fails", async () => {
    const { h, ctx } = harness({ serializeThrows: CONTENT_ONLY, stateThrows: CONTENT_ONLY });
    const res = await defOf("panel_query_graph").handler({} as never, ctx);
    const text = textOf(res);

    expect(res.isError).toBe(true);
    expect(text).toContain("[root-shape-mismatch]");
    expect(text).toContain(CONTENT_ONLY_QUERY_REFUSAL_NOTE);
    expect(text).toMatch(/Do NOT panel_open_workflow/i);
    expect(h.sent).not.toContain("workflow_open");
  });

  it("CONTROL: a size mismatch is still refused and does not serialize-recover", async () => {
    const { h, ctx } = harness({ queryThrows: SIZE_MISMATCH });
    const res = await defOf("panel_query_graph").handler({} as never, ctx);
    const text = textOf(res);

    expect(res.isError).toBe(true);
    expect(text).toContain("[root-shape-mismatch]");
    expect(text).toContain("bound to a different graph");
    expect(h.sent).toEqual(["graph_query"]);
    expect(h.sent).not.toContain("graph_serialize");
    expect(h.sent).not.toContain("workflow_open");
  });

  it("CONTROL: a mutation still refuses content-only drift and does not auto-rebind", async () => {
    const { h, ctx } = harness();
    const res = await defOf("panel_disconnect").handler(
      { node_id: 2, input: "images" } as never,
      ctx,
    );
    const text = textOf(res);

    expect(res.isError).toBe(true);
    expect(text).toContain("[root-shape-mismatch]");
    expect(h.sent).toContain("graph_disconnect");
    expect(h.sent).not.toContain("workflow_open");
    expect(h.sent).not.toContain("graph_serialize");
  });
});
