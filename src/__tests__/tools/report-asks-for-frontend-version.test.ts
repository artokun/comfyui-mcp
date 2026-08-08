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

describe("#779 reports must ask for the FRONTEND version", () => {
  it("the report_issue tool asks for it in the body description", () => {
    expect(TOOL).toMatch(/ComfyUI FRONTEND version/);
  });

  it("…and says WHY, because 'another version field' reads as optional", () => {
    // The failure mode is not that people refuse; it is that they reasonably
    // think "ComfyUI version" already covers it. It does not.
    expect(TOOL).toMatch(/SEPARATE package from ComfyUI/);
    expect(TOOL).toMatch(/move independently/);
  });

  it("…and names where to GET it", () => {
    // An ask with no source is an ask that gets skipped. This is the tool that
    // prints both versions on one line.
    // The TS source escapes the inner quotes, so the raw file holds a backslash
    // before each one. Strip backslashes and assert on the sentence a reader
    // actually sees — writing the escape into the regex tests the escaping
    // rather than the instruction, and two attempts at it collapsed to a pattern
    // that matched nothing.
    const readable = TOOL.split("\\").join("");
    expect(readable).toContain('get_system_stats (action:"health")');
  });

  it("the report-bug skill asks for it too", () => {
    // Two independent paths tell an agent what to collect. Fixing one and
    // leaving the other is how the field keeps going missing.
    expect(SKILL).toMatch(/ComfyUI FRONTEND version/);
    expect(SKILL).toMatch(/get_system_stats \(action:"health"\)/);
  });

  it("the skill carries the evidence, not just the instruction", () => {
    // A rule with its story attached survives editing; a bare "also include X"
    // gets trimmed by the next person tightening the doc.
    expect(SKILL).toMatch(/779/);
    expect(SKILL).toMatch(/1\.50\.3/);
    expect(SKILL).toMatch(/1\.47\.12/);
  });

  it("neither place asks ONLY for the ComfyUI version any more", () => {
    // The exact string that shipped for months, which is what produced a report
    // missing the deciding variable.
    expect(TOOL).not.toMatch(/\(GPU\/VRAM, ComfyUI version, OS\)/);
    expect(SKILL).not.toMatch(/^OS \/ ComfyUI version \/ GPU\+VRAM/m);
  });
});
