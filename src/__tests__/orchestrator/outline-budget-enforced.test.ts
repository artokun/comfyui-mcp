// #1203 — `panel_graph_outline` advertised a bound it did not enforce.
//
// A panel build older than the budget protocol ignores `max_chars` and returns
// the whole outline. The orchestrator NOTICED — it appends a note saying the
// budget "was NOT applied" — and forwarded the unbounded reply anyway. A caller
// that explicitly asked for 18000 characters got the full 137-node outline plus
// a warning about it.
//
// A warning is not a bound. The disclosure arrives after the cost is paid, and
// the cost is the thing the parameter exists to prevent.
//
// WHY REFUSING IS THE FIX AND TRUNCATING IS NOT. The tool's contract is that
// coverage is never traded away — over budget it sheds RESOLUTION and still
// describes every node, and if even that will not fit it returns NO outline
// rather than a partial one that reads as complete. Cutting the rendered text at
// a character count breaks precisely that: the reply would look like a finished
// outline that simply ends, and a caller acting on it would believe the graph
// stops where the string does. That is #1184 again with the truncation
// invisible. Shedding resolution needs the graph; the orchestrator has only the
// rendering, so it does what the panel does at its own floor.

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

let reply: Record<string, unknown>;

function bridge() {
  return {
    send: async (cmd: Record<string, unknown>) => (cmd.cmd === "graph_outline" ? reply : { ok: true }),
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: "tab-1", title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => "tab-1",
    workflowUuidFor: () => ({ known: true, uuid: "11111111-2222-4333-8444-555555555555" }),
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

async function callOutline(args: Record<string, unknown>): Promise<Record<string, any>> {
  const ctx = makePanelToolCtx(bridge(), "tab-1");
  const def = buildPanelToolDefs().find((d) => d.name === "panel_graph_outline")!;
  const res = (await def.handler(args, ctx)) as ToolResult;
  const t = res.content.find((c) => c.type === "text")!.text as string;
  return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
}

/** An OLD panel: returns the full outline and does NOT echo `max_chars`. */
const oldPanel = (chars: number, nodes = 137) => ({
  node_count: nodes,
  group_count: 4,
  viewing: "workflow.json",
  outline: "x".repeat(chars),
});

beforeEach(() => {
  reply = oldPanel(60_000);
});

describe("the orchestrator enforces max_chars the panel ignored (#1203)", () => {
  it("does NOT forward an outline that blows the bound", async () => {
    const out = await callOutline({ max_chars: 18_000 });
    expect(out.outline, "the 60k-char outline must not reach the caller").toBe("");
    expect(out.detail_level).toBe("refused");
  });

  it("says WHO applied the bound and how big the reply actually was", async () => {
    const out = await callOutline({ max_chars: 18_000 });
    expect(out.budget_applied_by).toBe("orchestrator");
    expect(out.unbounded_chars).toBe(60_000);
    // The counts are small, true and independent of the budget — they are the
    // part of the reply worth keeping.
    expect(out.node_count).toBe(137);
    expect(out.group_count).toBe(4);
  });

  it("names all three levers, including the one that actually fixes it", async () => {
    const out = await callOutline({ max_chars: 18_000 });
    const prose = JSON.stringify(out);
    expect(prose, "raising the bound, WITH its ceiling").toMatch(/Raise `max_chars` up to 60000/);
    expect(prose, "updating the panel").toMatch(/update the ComfyUI Agent Panel/i);
    expect(prose, "scoping the read").toContain("panel_query_graph");
  });

  it("says raising is USELESS when the outline is past the ceiling", async () => {
    // A dead retry offered inside the message explaining the first failure is
    // the recurring mistake this repo keeps catching.
    reply = oldPanel(400_000);
    const prose = JSON.stringify(await callOutline({ max_chars: 18_000 }));
    expect(prose).toMatch(/will NOT help/);
    expect(prose).not.toMatch(/Raise `max_chars` up to/);
  });

  it("does NOT claim the outline below is unbounded when there is none", async () => {
    // The old single sentence said exactly that, and it is now false.
    const prose = JSON.stringify(await callOutline({ max_chars: 18_000 }));
    expect(prose).not.toMatch(/the outline below is the full, unbounded one/);
  });
});

describe("what it must NOT do (#1203)", () => {
  it("passes through an outline that FITS, even though the panel ignored the bound", async () => {
    // A bound in name only would be the same defect in the other direction:
    // refusing a reply that satisfies the request.
    reply = oldPanel(5_000);
    const out = await callOutline({ max_chars: 18_000 });
    expect(out.outline).toHaveLength(5_000);
    expect(out.detail_level).toBeUndefined();
    expect(out.budget_applied_by).toBeUndefined();
  });

  it("tells the truth in the FITS case rather than warning about a flood", async () => {
    reply = oldPanel(5_000);
    const prose = JSON.stringify(await callOutline({ max_chars: 18_000 }));
    expect(prose).toMatch(/happens to fit within your bound/);
  });

  it("leaves a MODERN panel's reply completely alone", async () => {
    // It echoes max_chars back, having already walked its own shed ladder. Its
    // outline legitimately exceeds nothing, and second-guessing it would undo the
    // coverage guarantee it just honoured.
    reply = {
      node_count: 137,
      group_count: 4,
      outline: "y".repeat(60_000),
      max_chars: 18_000,
      detail_level: "no_values",
      degraded: true,
      degraded_reason: "Per-node detail reduced.",
    };
    const out = await callOutline({ max_chars: 18_000 });
    expect(out.outline).toHaveLength(60_000);
    expect(out.detail_level).toBe("no_values");
    expect(out.budget_applied_by).toBeUndefined();
  });

  it("leaves the reply alone when the caller set NO bound", async () => {
    // No bound means no bound. The default belongs to the panel, and inventing
    // one here would refuse a call that asked for everything.
    reply = oldPanel(60_000);
    const out = await callOutline({});
    expect(out.outline).toHaveLength(60_000);
    expect(out.detail_level).toBeUndefined();
  });

  it("never truncates — the outline is whole or absent, never cut", async () => {
    // The property that makes this fix safe. A cut string would read as a
    // complete outline that simply ends.
    for (const size of [17_999, 18_000, 18_001, 60_000]) {
      reply = oldPanel(size);
      const out = await callOutline({ max_chars: 18_000 });
      expect([0, size], `size ${size} produced a ${out.outline.length}-char outline`).toContain(
        out.outline.length,
      );
    }
  });
});
