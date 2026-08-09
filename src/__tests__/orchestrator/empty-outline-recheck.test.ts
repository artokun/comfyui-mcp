// #1184 — a 0-node outline is a CLAIM, and one made mid-restore is not
// established.
//
// Right after a ComfyUI restart and a tab switch, panel_graph_outline returned
// `node_count: 0` for a tab holding a 7-node starter graph: the frontend was
// still restoring and the canvas transiently had nothing on it. The agent
// trusted the empty read, reported the canvas empty, and BUILT A NEW 9-NODE
// PIPELINE alongside the invisible one. A later panel_query_graph showed 16
// nodes — ids 1–7 had been there all along, which the frontend knew, because the
// new adds started at id 8.
//
// That is the worst shape of this defect class: the action taken on the false
// read destroys work. A duplicate pipeline cannot be un-built, and the user is
// left with two overlapping graphs and no way to tell which nodes are theirs.
//
// It is also unusually cheap to get right — an empty outline is trivially
// re-verifiable, because the restore has either finished or it has not.

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

let outlineReplies: Array<Record<string, unknown>>;
let outlineCalls: number;
let rereadThrows: boolean;

function bridge() {
  return {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "graph_outline") {
        const n = outlineCalls;
        outlineCalls += 1;
        if (rereadThrows && n > 0) throw new Error("panel went away mid-recheck");
        return outlineReplies[Math.min(n, outlineReplies.length - 1)];
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: "tab-1", title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => "tab-1",
    workflowUuidFor: () => ({ known: true, uuid: undefined }),
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

async function callOutline(): Promise<Record<string, unknown>> {
  const ctx = makePanelToolCtx(bridge(), "tab-1");
  const def = buildPanelToolDefs().find((d) => d.name === "panel_graph_outline");
  if (!def) throw new Error("panel_graph_outline is not registered");
  const res: ToolResult = await def.handler({}, ctx);
  const text = (res.content.find((c) => c.type === "text") as { text: string } | undefined)?.text;
  return JSON.parse(text ?? "{}") as Record<string, unknown>;
}

beforeEach(() => {
  outlineCalls = 0;
  rereadThrows = false;
});

describe("an empty outline is re-verified before it is believed (#1184)", () => {
  it("reports the REAL graph when the first read caught a restore in progress", async () => {
    // The reporter's shape exactly: transiently 0, then the 7 nodes appear.
    outlineReplies = [
      { node_count: 0, group_count: 0, outline: "0 nodes" },
      { node_count: 7, group_count: 0, outline: "7 nodes" },
    ];

    const out = await callOutline();

    expect(out.node_count, "the empty first read must not be reported").toBe(7);
    expect(outlineCalls, "it must actually re-read").toBe(2);
  });

  it("reports empty plainly when the canvas is GENUINELY empty", async () => {
    // A blank canvas is a normal state. Having confirmed it twice, it must be
    // reported without hedging — turning every blank canvas into a warning would
    // be its own false signal.
    outlineReplies = [{ node_count: 0, group_count: 0, outline: "0 nodes" }];

    const out = await callOutline();

    expect(out.node_count).toBe(0);
    expect(outlineCalls, "confirmed by a second read").toBe(2);
    expect(JSON.stringify(out)).not.toMatch(/restor|still loading/i);
  });

  it("does NOT re-read when the first outline already has nodes", async () => {
    // The cost must fall only on the empty case.
    outlineReplies = [{ node_count: 3, group_count: 1, outline: "3 nodes" }];

    const out = await callOutline();

    expect(out.node_count).toBe(3);
    expect(outlineCalls).toBe(1);
  });

  it("keeps the FIRST reply's fields when the re-read is also empty", async () => {
    // The second read is the same ANSWER, so the original reply — with whatever
    // else it carried — is what gets returned.
    //
    // The two empty replies are deliberately DISTINGUISHABLE: with identical
    // fixtures this test could not tell which one came back, and a mutation that
    // returned the second passed it. (Caught by mutating the empty-second-read
    // guard away.)
    outlineReplies = [
      { node_count: 0, group_count: 0, outline: "0 nodes", detail_level: "full", max_chars: 4000 },
      { node_count: 0, group_count: 0, outline: "0 nodes", detail_level: "SECOND", max_chars: 1 },
    ];

    const out = await callOutline();

    expect(out.detail_level).toBe("full");
    expect(out.max_chars).toBe(4000);
  });

  it("keeps the first reply when the RE-READ errors", async () => {
    // A failed confirmation must not downgrade a reply we already have. The
    // re-read is a chance to learn more, never a way to lose what was known.
    outlineReplies = [{ node_count: 0, group_count: 0, outline: "0 nodes", detail_level: "full" }];
    rereadThrows = true;

    const out = await callOutline();

    expect(out.node_count).toBe(0);
    expect(out.detail_level).toBe("full");
  });
});
