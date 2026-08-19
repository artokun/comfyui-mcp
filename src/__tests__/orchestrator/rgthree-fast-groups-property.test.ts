// #1808 — panel_set_property(matchTitle) on Fast Groups Bypasser/Muter stores the
// property but does not rebuild the toggle list. The shipped path is
// panel_set_property → graph_set_node_property; rgthree has no onPropertyChanged
// and refreshWidgets leftover removal skips every other row. These tests drive
// that handler and the note it appends — they do not reimplement the filter.
import { describe, expect, it } from "vitest";

import {
  FAST_GROUPS_FILTER_PROPERTIES,
  fastGroupsFilterPropertyNote,
  isFastGroupsFilterProperty,
} from "../../orchestrator/rgthree-fast-groups-property.js";
import {
  buildPanelToolDefs,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

type Forwarded = Record<string, unknown>;

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} not found in buildPanelToolDefs()`);
  return def;
}

function makeCtx(reply?: ToolResult): { ctx: PanelToolCtx; calls: Forwarded[] } {
  const calls: Forwarded[] = [];
  const ctx: PanelToolCtx = {
    call: async (cmd) => {
      calls.push(cmd);
      return reply ?? { content: [{ type: "text", text: JSON.stringify(cmd) }] };
    },
    confirm: async () => "yes" as const,
    bridge: {} as PanelToolCtx["bridge"],
    tabId: "test-tab",
  };
  return { ctx, calls };
}

function textOf(res: ToolResult): string {
  return res.content.map((c) => ("text" in c ? String(c.text ?? "") : "")).join("");
}

describe("isFastGroupsFilterProperty (#1808)", () => {
  it("accepts every Fast Groups filter property by its pack name", () => {
    for (const name of FAST_GROUPS_FILTER_PROPERTIES) {
      expect(isFastGroupsFilterProperty(name)).toBe(true);
    }
  });

  it("rejects a non-filter name and a non-string", () => {
    expect(isFastGroupsFilterProperty("seed")).toBe(false);
    expect(isFastGroupsFilterProperty("RGTHREE_TOGGLE_AND_NAV")).toBe(false);
    expect(isFastGroupsFilterProperty(null)).toBe(false);
    expect(isFastGroupsFilterProperty(1)).toBe(false);
  });
});

describe("fastGroupsFilterPropertyNote (#1808)", () => {
  it("tells the caller to re-read and set again, not delete+re-add", () => {
    const note = fastGroupsFilterPropertyNote();
    expect(note).toMatch(/does NOT implement onPropertyChanged/);
    expect(note).toMatch(/widgets:\{\}/);
    expect(note).toMatch(/has not been built yet/);
    expect(note).toMatch(/set the property again/);
    expect(note).toMatch(/do not delete and re-add/);
    expect(note).toContain("panel_query_graph");
  });
});

describe("panel_set_property (#1808)", () => {
  it("forwards graph_set_node_property and appends the Fast Groups note on matchTitle", async () => {
    const { ctx, calls } = makeCtx();
    const res = await defByName("panel_set_property").handler(
      { node_id: 249, name: "matchTitle", value: "^Picture " },
      ctx,
    );
    expect(calls).toEqual([
      { cmd: "graph_set_node_property", node_id: 249, name: "matchTitle", value: "^Picture " },
    ]);
    expect(textOf(res)).toContain(fastGroupsFilterPropertyNote());
  });

  it("appends the same note for the other Fast Groups filter properties", async () => {
    for (const name of FAST_GROUPS_FILTER_PROPERTIES) {
      const { ctx } = makeCtx();
      const res = await defByName("panel_set_property").handler(
        { node_id: 1, name, value: "x" },
        ctx,
      );
      expect(textOf(res)).toContain(fastGroupsFilterPropertyNote());
    }
  });

  it("does not append the note for an unrelated property", async () => {
    const { ctx, calls } = makeCtx();
    const res = await defByName("panel_set_property").handler(
      { node_id: 7, name: "seed", value: 42 },
      ctx,
    );
    expect(calls).toEqual([{ cmd: "graph_set_node_property", node_id: 7, name: "seed", value: 42 }]);
    expect(textOf(res)).not.toContain(fastGroupsFilterPropertyNote());
  });

  it("does not append the note when the write failed", async () => {
    const { ctx } = makeCtx({
      content: [{ type: "text", text: "Error: No node with id 5" }],
      isError: true,
    });
    const res = await defByName("panel_set_property").handler(
      { node_id: 5, name: "matchTitle", value: "^Picture " },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain(fastGroupsFilterPropertyNote());
  });

  it("stops claiming Fast Groups re-filter live via onPropertyChanged", () => {
    const desc = defByName("panel_set_property").description;
    expect(desc).toMatch(/do NOT implement onPropertyChanged/);
    expect(desc).toMatch(/set the property again/);
    expect(desc).toMatch(/Do not delete and re-add/);
    expect(desc).toMatch(/widgets:\{\}/);
    expect(desc).not.toMatch(/rgthree re-filters its group list/);
  });
});
