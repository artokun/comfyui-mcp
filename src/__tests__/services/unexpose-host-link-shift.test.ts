// #2437 — remaining host IMAGE links look connected after unexpose, fail at queue.
//
// The mutation is panel-side (`graph_unexpose_subgraph_input` does not re-point
// survivors). MCP remaining piece is the disclosure: a post-removal snapshot of
// `node.inputs[i].link` cannot see the bug, so the note is a priori from a
// landed `removed` object. Tests drive the shipped function AND the handlers
// that attach it — a reimplementation in the test file would stay green if the
// wrap were deleted.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  appendReplyNote,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import {
  hostLinksAlreadyReindexed,
  isLandedUnexpose,
  laterSlotsAfterUnexpose,
  laterSlotsFromRails,
  laterSlotsFromUnexposePayload,
  unexposeHostLinkShiftNote,
} from "../../services/unexpose-host-link-shift.js";

const SRC = readFileSync(
  fileURLToPath(new URL("../../orchestrator/panel-tools.ts", import.meta.url)),
  "utf8",
);

/** The reporter's exact unexpose reply: `text` at index 3, one interior link, zero host links. */
const REPORTER_REMOVED = {
  removed: {
    side: "input",
    name: "text",
    type: "STRING",
    slot: 3,
    interior_links_dropped: 1,
    host_links_dropped: 0,
  },
};

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} not found`);
  return def;
}

function jsonResult(payload: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function makeCtx(
  reply: ToolResult | ((cmd: Record<string, unknown>) => ToolResult),
): { ctx: PanelToolCtx; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const ctx: PanelToolCtx = {
    call: async (cmd) => {
      calls.push(cmd);
      return typeof reply === "function" ? reply(cmd) : reply;
    },
    confirm: async () => "yes" as const,
    bridge: {} as PanelToolCtx["bridge"],
    tabId: "test-tab",
  };
  return { ctx, calls };
}

/** #2491 — reporter removed value_3 at index 3 of 4, then value_2 at the new last index. */
const LAST_SLOT_REMOVED = {
  removed: {
    side: "input",
    name: "value_3",
    type: "INT",
    slot: 3,
    interior_links_dropped: 1,
    host_links_dropped: 0,
    host_links_reindexed: true,
  },
};

const LAST_SLOT_REMAINING_RAILS = {
  rails: {
    input: {
      provides_outputs: [
        { index: 0, name: "value" },
        { index: 1, name: "value_1" },
        { index: 2, name: "value_2" },
      ],
    },
  },
};

function allText(res: ToolResult): string {
  return res.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n");
}

describe("unexposeHostLinkShiftNote (#2437)", () => {
  it("the unexpose handlers attach the shipped note, not a copy", () => {
    expect(SRC).toMatch(
      /unexposeHostLinkShiftNote\(payload, laterSlotsAfterUnexpose\(payload, remainingGraph\)\)/,
    );
    expect(SRC).toMatch(/cmd: "graph_unexpose_subgraph_input"/);
    expect(SRC).toMatch(/cmd: "graph_unexpose_subgraph_output"/);
  });

  it("THE REPORTED CASE: text at index 3, zero host links dropped, remaining IMAGE slots shifted", () => {
    const note = unexposeHostLinkShiftNote(REPORTER_REMOVED, ["image", "image_1", "noise_seed"]);
    expect(note).toBeTruthy();
    expect(note).toMatch(/artokun\/comfyui-mcp#2437/);
    expect(note).toMatch(/"text"/);
    expect(note).toMatch(/index 3/);
    expect(note).toMatch(/panel_query_graph/);
    expect(note).toMatch(/panel_graph_outline/);
    expect(note).toMatch(/Required input is missing/);
    expect(note).toMatch(/by NAME/);
    expect(note).not.toMatch(/by index/);
    expect(note).toMatch(/panel_exit_subgraph/);
    expect(note).toContain('"image"');
    expect(note).toContain('"image_1"');
    expect(note).toContain('"noise_seed"');
    // Must not claim a positional connectedness check saw the bug — that check
    // cannot see it (owner trace).
    expect(note).not.toMatch(/detected|divergence|snapshot showed/i);
  });

  it("still warns when later slot names are unknown — skipping is how the reporter queued", () => {
    const note = unexposeHostLinkShiftNote(REPORTER_REMOVED);
    expect(note).toBeTruthy();
    expect(note).toMatch(/reconnect each remaining later host link by NAME/);
  });

  it("is silent when the caller proved there are no later slots", () => {
    expect(unexposeHostLinkShiftNote(REPORTER_REMOVED, [])).toBeNull();
  });

  it("#2473 is silent when the panel reports host_links_reindexed", () => {
    expect(
      unexposeHostLinkShiftNote({
        removed: { ...REPORTER_REMOVED.removed, host_links_reindexed: true },
      }, ["image", "image_1"]),
    ).toBeNull();
  });

  it("#2491 is silent when the removed index is last — no later slot exists", () => {
    expect(unexposeHostLinkShiftNote(LAST_SLOT_REMOVED)).toBeNull();
    expect(
      unexposeHostLinkShiftNote({
        removed: { side: "input", name: "value_3", slot: 3, remaining_count: 3 },
      }),
    ).toBeNull();
    expect(
      unexposeHostLinkShiftNote(
        { removed: { side: "input", name: "value_3", slot: 3 } },
        [],
      ),
    ).toBeNull();
    expect(laterSlotsFromUnexposePayload({
      removed: { side: "input", name: "value_3", slot: 3, remaining_count: 3 },
    })).toEqual([]);
    expect(
      laterSlotsFromRails(LAST_SLOT_REMAINING_RAILS.rails, "input", 3),
    ).toEqual([]);
    expect(
      laterSlotsAfterUnexpose(
        { removed: { side: "input", name: "value_3", slot: 3 } },
        LAST_SLOT_REMAINING_RAILS,
      ),
    ).toEqual([]);
  });

  it("#2491 still warns when a remaining later slot exists and was not reindexed", () => {
    const payload = {
      removed: { side: "input", name: "value_1", slot: 1, remaining_count: 3 },
    };
    expect(laterSlotsFromUnexposePayload(payload)).toBeUndefined();
    const note = unexposeHostLinkShiftNote(payload, ["value_2", "value_3"]);
    expect(note).toMatch(/#2437/);
    expect(note).toContain('"value_2"');
  });

  it("is silent on a refusal / missing removed (nothing landed)", () => {
    expect(isLandedUnexpose({ error: "unknown slot" })).toBe(false);
    expect(unexposeHostLinkShiftNote({ error: "unknown slot" })).toBeNull();
    expect(unexposeHostLinkShiftNote(null)).toBeNull();
    expect(unexposeHostLinkShiftNote("not json")).toBeNull();
    expect(unexposeHostLinkShiftNote({ removed: { side: "input", name: "text" } })).toBeNull();
  });

  it("covers the output twin — host outputs are the same positional lockstep", () => {
    const note = unexposeHostLinkShiftNote({
      removed: { side: "output", name: "IMAGE", type: "IMAGE", slot: 0, host_links_dropped: 2 },
    });
    expect(note).toMatch(/boundary output slots/);
    expect(note).toMatch(/"IMAGE"/);
    expect(note).toMatch(/by NAME/);
  });
});

describe("panel_unexpose_subgraph_input attaches the #2437 note", () => {
  it("the reporter's landed reply keeps the JSON and adds the repair as its own block", async () => {
    const { ctx, calls } = makeCtx(jsonResult(REPORTER_REMOVED));
    const res = await defByName("panel_unexpose_subgraph_input").handler({ name: "text" }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "graph_unexpose_subgraph_input", name: "text" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.type).toBe("text");
    expect(JSON.parse(res.content[0]!.text!)).toEqual(REPORTER_REMOVED);
    expect(res.content).toHaveLength(2);
    expect(res.content[1]?.text).toBe(unexposeHostLinkShiftNote(REPORTER_REMOVED));
    expect(allText(res)).toMatch(/Required input is missing/);
  });

  it("#2473 a panel that reindexed does not get the stale remaining-piece note", async () => {
    const payload = { removed: { ...REPORTER_REMOVED.removed, host_links_reindexed: true } };
    const { ctx, calls } = makeCtx(jsonResult(payload));
    const res = await defByName("panel_unexpose_subgraph_input").handler({ name: "text" }, ctx);
    expect(res.isError).toBeUndefined();
    expect(res.content).toHaveLength(1);
    expect(allText(res)).not.toMatch(/#2437/);
    expect(calls).toHaveLength(1);
    expect(hostLinksAlreadyReindexed(payload)).toBe(true);
  });

  it("#2491 THE REPORTED CASE: last-slot unexpose with host_links_reindexed does not warn", async () => {
    const { ctx, calls } = makeCtx(jsonResult(LAST_SLOT_REMOVED));
    const res = await defByName("panel_unexpose_subgraph_input").handler({ name: "value_3" }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "graph_unexpose_subgraph_input", name: "value_3" });
    expect(calls).toHaveLength(1);
    expect(res.isError).toBeUndefined();
    expect(res.content).toHaveLength(1);
    expect(JSON.parse(res.content[0]!.text!)).toEqual(LAST_SLOT_REMOVED);
    expect(allText(res)).not.toMatch(/#2437/);
    expect(allText(res)).not.toMatch(/were not reindexed/);
  });

  it("#2491 last-slot on an older panel is proven by remaining rails, not warned", async () => {
    const payload = {
      removed: { side: "input", name: "value_3", type: "INT", slot: 3, host_links_dropped: 0 },
    };
    const { ctx, calls } = makeCtx((cmd) =>
      jsonResult(cmd.cmd === "graph_query" ? LAST_SLOT_REMAINING_RAILS : payload),
    );
    const res = await defByName("panel_unexpose_subgraph_input").handler({ name: "value_3" }, ctx);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_unexpose_subgraph_input", "graph_query"]);
    expect(res.content).toHaveLength(1);
    expect(allText(res)).not.toMatch(/#2437/);
  });

  it("a panel refusal is not decorated — nothing was removed", async () => {
    const refusal = jsonResult("No input boundary slot \"text\"", true);
    const { ctx } = makeCtx(refusal);
    const res = await defByName("panel_unexpose_subgraph_input").handler({ name: "text" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toHaveLength(1);
    expect(allText(res)).not.toMatch(/#2437/);
  });

  it("the description names the repair before the agent queues", () => {
    const def = defByName("panel_unexpose_subgraph_input");
    expect(def.description).toMatch(/#2437/);
    expect(def.description).toMatch(/by NAME/i);
    expect(def.description).toMatch(/Required input is missing/);
  });
});

describe("panel_unexpose_subgraph_output attaches the same remaining-piece note", () => {
  it("a landed output removal is disclosed the same way", async () => {
    const payload = {
      removed: { side: "output", name: "IMAGE", type: "IMAGE", slot: 1, host_links_dropped: 1 },
    };
    const { ctx, calls } = makeCtx(jsonResult(payload));
    const res = await defByName("panel_unexpose_subgraph_output").handler({ name: "IMAGE" }, ctx);
    expect(calls[0]).toMatchObject({ cmd: "graph_unexpose_subgraph_output", name: "IMAGE" });
    expect(res.content).toHaveLength(2);
    expect(res.content[1]?.text).toBe(unexposeHostLinkShiftNote(payload));
  });

  it("the description names the same positional hazard", () => {
    expect(defByName("panel_unexpose_subgraph_output").description).toMatch(/#2437/);
  });
});

describe("appendReplyNote keeps the JSON document at index 0", () => {
  it("the unexpose wrap uses the exported helper, not a splice into the JSON string", () => {
    const base = jsonResult(REPORTER_REMOVED);
    const noted = appendReplyNote(base, unexposeHostLinkShiftNote(REPORTER_REMOVED)!);
    expect(JSON.parse(noted.content[0]!.text!)).toEqual(REPORTER_REMOVED);
    expect(noted.content[1]?.text).toMatch(/#2437/);
  });
});
