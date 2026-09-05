// #1167 — MiniMax H3 is the first bundled skill with a real vendor prompting
// guide, so it is the #1155 pilot: Official must be a MiniMax URL, Empirical
// must say what was inferred, and we must not ship a copy of MiniMax's own
// skills/h3-prompt-writing (Community License includes Documentation).
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

const SKILL_URL = new URL("../../../plugin/skills/minimax-h3-video/SKILL.md", import.meta.url);
const SKILL = existsSync(SKILL_URL)
  ? readFileSync(SKILL_URL, "utf-8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")
  : "";

function sourcesSection(markdown: string): string {
  const headingAt = markdown.search(/^## Sources[ \t]*$/m);
  expect(headingAt, "missing ## Sources heading").toBeGreaterThan(-1);
  const from = markdown.slice(headingAt);
  const nextHeading = from.slice("## Sources".length).search(/\n## /);
  return nextHeading === -1 ? from : from.slice(0, "## Sources".length + nextHeading);
}

describe("the minimax-h3-video skill is the #1155 official-guide pilot (#1167)", () => {
  it("is bundled at plugin/skills/minimax-h3-video/SKILL.md", () => {
    expect(existsSync(SKILL_URL)).toBe(true);
  });

  it("is a loadable skill — frontmatter name matches its directory", () => {
    expect(SKILL).toMatch(/^---\nname: minimax-h3-video\n/);
    expect(SKILL).toMatch(/\ndescription: .+/);
  });

  it("cites MiniMax's official prompting guides by URL, not none found", () => {
    const sources = sourcesSection(SKILL);
    expect(sources).toContain("**Official:**");
    expect(sources).toContain("**Empirical:**");
    expect(sources).toContain(
      "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md",
    );
    expect(sources).toContain(
      "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md",
    );
    expect(sources).toContain("https://github.com/MiniMax-AI/MiniMax-H3");
    expect(sources).not.toMatch(/\*\*Official:\*\*\s*none found/i);
  });

  it("teaches the local-weights path and names the paid API nodes so they are not mixed", () => {
    expect(SKILL).toContain("MiniMaxH3ImageToVideo");
    expect(SKILL).toContain("MiniMaxH3ReferenceToVideo");
    expect(SKILL).toContain("EmptyMiniMaxH3LatentAV");
    expect(SKILL).toContain("MiniMaxH3SigmaShift");
    expect(SKILL).toContain("MinimaxHailuo03TextToVideoNode");
    expect(SKILL).toMatch(/must not be mixed/);
  });

  it("points at MiniMax's own skill instead of copying the licensed prompting prose", () => {
    expect(SKILL).toMatch(/cite by link|linked, not copied|Do not copy/i);
    expect(SKILL).toContain("h3-prompt-writing");
    // These headings exist only in MiniMax's licensed prompting guides / SKILL.md.
    expect(SKILL).not.toMatch(/subject_definitions/);
    expect(SKILL).not.toMatch(/integrated_multimodal_description/);
  });

  it('does not teach enqueue_workflow (action:"run_template") as the Comfy-Org template load path (#1801 review)', () => {
    // Core templates are invisible to list_templates /
    // enqueue_workflow (action:"run_template") and are not a
    // panel_load_workflow pack/path/graph. The old sentence claimed they were.
    expect(SKILL).not.toMatch(
      /Load with `panel_load_workflow` or `enqueue_workflow` `action:"run_template"`/,
    );
    expect(SKILL).toMatch(/Template Library → Video/);
    expect(SKILL).toContain(
      "https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_t2v.json",
    );
    expect(SKILL).toMatch(/list_templates/);
    expect(SKILL).toMatch(/will \*\*not\*\* list them/);
    const mentions = [...SKILL.matchAll(/action:"run_template"/g)];
    expect(mentions.length).toBeGreaterThan(0);
    for (const m of mentions) {
      const at = m.index ?? 0;
      const around = SKILL.slice(Math.max(0, at - 220), at + 180);
      expect(around).toMatch(/will \*\*not\*\*|Do not call it until a pack exists|cannot load/i);
    }
  });

  it("separates source-video timing from H3 length and documents complete expression edits (#2479)", () => {
    expect(SKILL).toContain("251 frames over 5 seconds");
    expect(SKILL).toMatch(/Resample the source video in\s+time to 24 fps/);
    expect(SKILL).toContain("ComfyMathExpression");
    expect(SKILL).toContain("one complete, balanced expression");
    expect(SKILL).toContain("panel_set_widget` forwards this text unchanged");
    expect(SKILL).toContain("max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17");
  });
});
