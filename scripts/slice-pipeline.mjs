#!/usr/bin/env node
// Slice ONE pipeline out of a toggle-template pack workflow into a standalone,
// activated graph. Thin CLI wrapper around the shared sliceWorkflow() service
// (src/services/workflow-slicer.ts) — the same implementation the slice_workflow
// / panel_slice_workflow tools use.
//
//   node scripts/slice-pipeline.mjs <src/workflow.json> <out.json> "<grpA>,<grpB>,..."
//
// Group args are case-insensitive substrings of group titles whose output nodes
// seed the slice (shared post-proc like UPSCALE/GRAIN/SHARP are pulled in
// automatically via the closure). Verify the result with verify-render.mjs.

import { readFileSync, writeFileSync } from "node:fs";
import { sliceWorkflow } from "../dist/services/workflow-slicer.js";

const [src, out, groupCsv] = process.argv.slice(2);
if (!src || !out || !groupCsv) {
  console.error('usage: slice-pipeline.mjs <src.json> <out.json> "<grp substrs csv>"');
  process.exit(2);
}

try {
  const wf = JSON.parse(readFileSync(src, "utf8"));
  const { workflow, stats } = sliceWorkflow(wf, groupCsv.split(","));
  writeFileSync(out, JSON.stringify(workflow, null, 2));
  console.log(
    `${out}: ${stats.nodes} nodes (un-bypassed ${stats.unbypassed}), ${stats.links} links, ` +
      `${stats.subgraphs} subgraphs | seeds=${stats.seeds} bad_links=${stats.badLinks} orphan_gets=${stats.orphanGets}`,
  );
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
