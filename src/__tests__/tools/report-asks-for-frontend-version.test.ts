// panel#779 — a report that omits the ComfyUI FRONTEND version cannot be
// diagnosed, and both places that tell an agent what to include asked for the
// wrong field.
//
// The reporter's environment block said `comfyui: 0.30.0`. A working machine was
// 0.30.2 — indistinguishable, and not the cause. The frontend package was 1.50.3
// vs 1.47.12 and that was the whole answer. It took an hour of eliminating the
// install, two browsers, the cache and the orchestrator to reach a number one
// line of output already had.
//
// mcp#1126 made the number visible. This pins the two places that ASK for it, so
// the request cannot quietly revert to "ComfyUI version" alone.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const TOOL = readFileSync(join(ROOT, "src", "tools", "report-issue.ts"), "utf8");
const SKILL = readFileSync(
  join(ROOT, "plugin", "skills", "report-bug", "SKILL.md"),
  "utf8",
);

describe("report_issue is ARCHIVED — its description no longer asks for anything", () => {
  // #779 pinned that the description asked for the ComfyUI FRONTEND version, because a
  // report without it could not be triaged. There is no triage any more: the project is
  // archived and the tool files nothing, so the description must say THAT, and must not
  // send the agent off collecting versions for a report that will never be read.
  it("says it is archived and files nothing", () => {
    expect(TOOL).toMatch(/ARCHIVED/);
    expect(TOOL).toMatch(/files NOTHING/);
  });
  it("points at the official tooling instead", () => {
    expect(TOOL).toMatch(/Comfy MCP/);
  });
  it("no longer instructs the agent to gather the FRONTEND version", () => {
    expect(TOOL).not.toMatch(/ComfyUI FRONTEND version/);
  });
});
