// panel#887 — the drift predicate measured against records CAPTURED FROM THE LIVE
// PANEL, not invented.
//
// Both earlier fixtures for the unsaved-tab case were wrong, in opposite ways: the
// first put the label on `filename`; review "corrected" it to `path:null,
// filename:null, title:"Unsaved Workflow"`. The running panel (ComfyUI 0.31.1)
// actually emits a POPULATED synthetic path, the label on `filename`, and `title`
// null:
//
//   { path: "workflows/Unsaved Workflow.json", filename: "Unsaved Workflow",
//     title: null, key: "Unsaved Workflow.json" }
//
// That matters because this predicate can FAIL A HEALTHY OPEN. A fixture the panel
// never sends proves nothing about that risk, so these cases are pinned from real
// data and the same-file spellings are the ones a Windows user actually produces.
import { describe, expect, it } from "vitest";
import { readOpenActiveAgainstTarget, describeActiveRecord } from "../../orchestrator/panel-tools.js";
const LIVE_UNSAVED = { path: "workflows/Unsaved Workflow.json", filename: "Unsaved Workflow", title: null, key: "Unsaved Workflow.json" };
const LIVE_SAVED = { path: "workflows/Anima Wojak Batch.json", filename: "Anima Wojak Batch", title: null, key: "Anima Wojak Batch.json" };
describe("live shapes", () => {
  it("same file, many spellings, is NEVER drift", () => {
    for (const t of [
      "workflows/Anima Wojak Batch.json",
      "./workflows/Anima Wojak Batch.json",
      "workflows\Anima Wojak Batch.json",
      "Workflows/anima wojak batch.json",
      "Anima Wojak Batch.json",
    ]) {
      expect(readOpenActiveAgainstTarget(LIVE_SAVED, t, true), t).not.toBe("different");
    }
  });
  it("a genuinely different workflow IS drift", () => {
    expect(readOpenActiveAgainstTarget(LIVE_SAVED, "workflows/Artokun Flow v1.json", true)).toBe("different");
    expect(readOpenActiveAgainstTarget(LIVE_UNSAVED, "workflows/Anima Wojak Batch.json", true)).toBe("different");
  });
  it("the unsaved tab is not drift against its own path", () => {
    expect(readOpenActiveAgainstTarget(LIVE_UNSAVED, "workflows/Unsaved Workflow.json", true)).not.toBe("different");
  });
  it("labels are human-readable on the REAL shapes", () => {
    expect(describeActiveRecord(LIVE_UNSAVED)).toBe("workflows/Unsaved Workflow.json");
    expect(describeActiveRecord(LIVE_SAVED)).toBe("workflows/Anima Wojak Batch.json");
  });
});
