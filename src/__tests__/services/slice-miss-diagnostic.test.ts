// panel#690(4) — `panel_slice_workflow` refused with a message that named only the
// substrings the caller had just supplied and nothing about the workflow. The
// reporter tried SIX different `groups` values against one file and got the same
// dead end each time, with no way to converge except guessing.
//
// Their workflow did have an output node (a `SaveVideo`, node 92), and `SaveVideo`
// is in SINK_TYPES — so the sink type was never the problem, and the report's
// suspicion there was unfounded. Group matching is what failed: a node belongs to a
// group purely by falling inside its bounding box.

import { describe, expect, it } from "vitest";
import { describeSliceMiss, sliceWorkflow } from "../../services/workflow-slicer.js";
import type { UiWorkflow } from "../../comfyui/types.js";

describe("slice miss explains itself (panel#690(4))", () => {
  it("names the groups that ACTUALLY exist, so the caller stops guessing", () => {
    const msg = describeSliceMiss({
      groupSubstrings: ["video", "minimax"],
      groupTitles: ["Load & Prep", "H3 Pipeline", "Post"],
      sinks: [{ id: 92, type: "SaveVideo", group: "H3 Pipeline" }],
    });
    expect(msg).toContain("Load & Prep, H3 Pipeline, Post");
    // …and what it searched for, so the mismatch is visible side by side.
    expect(msg).toContain("video, minimax");
  });

  it("names every output node found and the group it is in", () => {
    // This is what distinguishes "wrong substring" from "not in any group" — two
    // different fixes that the old message collapsed into one.
    const msg = describeSliceMiss({
      groupSubstrings: ["save"],
      groupTitles: ["H3 Pipeline"],
      sinks: [{ id: 92, type: "SaveVideo", group: "H3 Pipeline" }],
    });
    expect(msg).toContain("#92 SaveVideo");
    expect(msg).toContain('"H3 Pipeline"');
    expect(msg).toContain("Pass a substring of one of the group titles listed above.");
  });

  it("says outright when NO output node is inside any group — no substring can help", () => {
    // The load-bearing case: telling this caller to try another substring would send
    // them in circles, because geometry, not naming, is the problem.
    const msg = describeSliceMiss({
      groupSubstrings: ["save", "output", "video"],
      groupTitles: ["Pipeline A", "Pipeline B"],
      sinks: [
        { id: 92, type: "SaveVideo", group: "" },
        { id: 93, type: "PreviewImage", group: "" },
      ],
    });
    expect(msg).toContain("NO group");
    expect(msg).toMatch(/None of them is inside ANY group/);
    expect(msg).toMatch(/Move the output node into the group's bounds/);
    expect(msg).not.toContain("Pass a substring of one of the group titles");
  });

  it("says when the workflow has NO recognized output node at all", () => {
    const msg = describeSliceMiss({
      groupSubstrings: ["x"],
      groupTitles: ["A"],
      sinks: [],
    });
    expect(msg).toMatch(/contains NO output node of any recognized type/);
  });

  it("lists SaveVideo among the recognized types — the report suspected it was missing", () => {
    const msg = describeSliceMiss({ groupSubstrings: ["x"], groupTitles: [], sinks: [] });
    expect(msg).toContain("SaveVideo");
  });

  it("caps huge enumerations but always reports the exact count", () => {
    // A truncated list must say how much it is hiding, or it implies that is all
    // there is — which would resume the guessing this fixes.
    const titles = Array.from({ length: 40 }, (_, i) => `Group ${i}`);
    const msg = describeSliceMiss({ groupSubstrings: ["z"], groupTitles: titles, sinks: [] });
    expect(msg).toContain("Groups in this workflow (40)");
    expect(msg).toMatch(/… and 15 more/);
    expect(msg).not.toContain("Group 39");
  });

  it("blank/whitespace group titles are not offered as suggestions", () => {
    const msg = describeSliceMiss({
      groupSubstrings: ["x"],
      groupTitles: ["", "   ", "Real"],
      sinks: [],
    });
    expect(msg).toContain("Groups in this workflow (1): Real");
  });

  it("WIRING: sliceWorkflow throws the diagnostic, not the old bare string", () => {
    // The tests above cannot prove the helper is reached. This drives the real
    // sliceWorkflow with the reporter's shape: a SaveVideo outside every group.
    const wf = {
      nodes: [
        { id: 92, type: "SaveVideo", pos: [5000, 5000] },
        { id: 1, type: "CheckpointLoaderSimple", pos: [0, 0] },
      ],
      links: [],
      groups: [{ title: "H3 Pipeline", bounding: [0, 0, 100, 100] }],
    } as unknown as UiWorkflow;

    expect(() => sliceWorkflow(wf, ["video", "minimax"])).toThrow(/H3 Pipeline/);
    expect(() => sliceWorkflow(wf, ["video", "minimax"])).toThrow(/#92 SaveVideo in NO group/);
    expect(() => sliceWorkflow(wf, ["video", "minimax"])).toThrow(/None of them is inside ANY group/);
  });

  it("a successful slice is unaffected", () => {
    const wf = {
      nodes: [
        { id: 92, type: "SaveVideo", pos: [10, 10] },
        { id: 1, type: "CheckpointLoaderSimple", pos: [20, 20] },
      ],
      links: [],
      groups: [{ title: "H3 Pipeline", bounding: [0, 0, 100, 100] }],
    } as unknown as UiWorkflow;
    const { stats } = sliceWorkflow(wf, ["h3"]);
    expect(stats.seeds).toBe(1);
  });
});

describe("slice seeds from nested overlapping groups (#2780)", () => {
  // Outer group listed FIRST so groups.find() would attribute the SaveImage to
  // "Save Group" and miss a slice for the inner title.
  const nestedOverlapWf = {
    nodes: [
      { id: 838, type: "SaveImage", pos: [50, 50] },
      { id: 1, type: "CheckpointLoaderSimple", pos: [40, 40] },
    ],
    links: [[1, 1, 0, 838, 0, "IMAGE"]],
    groups: [
      { title: "Save Group", bounding: [0, 0, 200, 200] },
      { title: "#Save Draft 📐", bounding: [25, 25, 75, 75] },
    ],
  } as UiWorkflow;

  it("slices when the output is inside a nested inner group that overlaps a larger outer group", () => {
    const { stats, workflow } = sliceWorkflow(nestedOverlapWf, ["save draft"]);
    expect(stats.seeds).toBe(1);
    expect(workflow.nodes?.some((n) => n.id === 838)).toBe(true);
  });

  it("still slices by the outer overlapping group title", () => {
    const { stats } = sliceWorkflow(nestedOverlapWf, ["save group"]);
    expect(stats.seeds).toBe(1);
  });

  it("lists every containing group on a miss, not only the first box", () => {
    expect(() => sliceWorkflow(nestedOverlapWf, ["#Save Draft"])).not.toThrow();
    try {
      sliceWorkflow(nestedOverlapWf, ["does-not-match"]);
      throw new Error("expected slice miss");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("Save Group");
      expect(msg).toContain("#Save Draft");
      expect(msg).toContain("#838 SaveImage");
    }
  });
});
