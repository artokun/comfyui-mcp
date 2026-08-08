// panel#775 — a pack shipping API/prompt format reached three tools unvalidated.
//
// packs/ltx23-distill-3stage/workflow.json is API format (numeric keys →
// {class_type, inputs}, no nodes[]). panel_load_workflow refused it correctly;
// panel_strip_workflow crashed on ".map of undefined"; panel_flatten_workflow
// (apply:true) reported SUCCESS and loaded a 0-node graph.

import { describe, expect, it, vi } from "vitest";
import { buildPanelToolDefs } from "../../orchestrator/panel-tools.js";
import type { PanelToolCtx } from "../../orchestrator/panel-tools.js";

/** The real LTX pack shape, reduced: API/prompt format. */
const API_GRAPH = {
  "1": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" }, _meta: { title: "K" } },
  "2": { class_type: "ManualSigmas", inputs: { sigmas: "0.8, 0.0" }, _meta: { title: "S" } },
};
const UI_GRAPH = { nodes: [{ id: 1, type: "KSamplerSelect" }], links: [] };

function ctx(): PanelToolCtx {
  return {
    call: vi.fn(async () => ({ content: [{ type: "text", text: "{}" }] })),
    confirm: vi.fn(async () => "yes" as const),
    bridge: { send: vi.fn(async () => ({})) } as unknown as PanelToolCtx["bridge"],
    tabId: "t",
  } as unknown as PanelToolCtx;
}
const def = (n: string) => {
  const d = buildPanelToolDefs().find((x) => x.name === n);
  if (!d) throw new Error(`${n} not registered`);
  return d;
};

describe("#775 caller-supplied API-format input is refused, not crashed or silently applied", () => {
  for (const tool of ["panel_flatten_workflow", "panel_strip_workflow", "panel_slice_workflow"]) {
    it(`${tool} refuses an API/prompt graph with an actionable message`, async () => {
      await expect(def(tool).handler({ graph: API_GRAPH }, ctx())).rejects.toThrow(
        /not a UI workflow \(missing a top-level `nodes` array\)/,
      );
    });

    it(`${tool} names the SOURCE so the caller knows which input was wrong`, async () => {
      await expect(def(tool).handler({ graph: API_GRAPH }, ctx())).rejects.toThrow(
        /The supplied `graph`/,
      );
    });
  }

  it("a UI graph still gets through — the guard is a shape check, not a gate", async () => {
    // Guarding must not turn a working call into a refusal; only the wrong SHAPE
    // is rejected. (The handler may fail later for unrelated reasons; what matters
    // is that it is NOT the format refusal.)
    for (const tool of ["panel_flatten_workflow", "panel_strip_workflow"]) {
      let msg = "";
      try {
        await def(tool).handler({ graph: UI_GRAPH }, ctx());
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
      }
      expect(msg).not.toMatch(/not a UI workflow/);
    }
  });

  it("a JSON STRING carrying API format is refused too", async () => {
    // resolveWorkflowInput parses strings; the guard must sit after the parse,
    // not before it, or the string form would slip past.
    await expect(
      def("panel_flatten_workflow").handler({ graph: JSON.stringify(API_GRAPH) }, ctx()),
    ).rejects.toThrow(/not a UI workflow/);
  });

  it("a pack source is named as the pack, not as `graph`", async () => {
    // The reporter's case came from a PACK; the message has to point at the pack
    // so the fix (ship UI format) is obvious from the error alone.
    let msg = "";
    try {
      await def("panel_flatten_workflow").handler({ pack: "ltx23-distill-3stage" }, ctx());
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    // Either the pack is missing locally or it is API format — both name the pack.
    expect(msg).toMatch(/ltx23-distill-3stage/);
  });
});
