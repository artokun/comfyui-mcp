// #1155 — a skill that cites no source for its prompting/wiring guidance cannot
// be checked: a wrong recommendation is indistinguishable from a right one until
// it fails on someone's machine. The distinction to enforce is *cited* vs
// *uncited*, not right vs wrong.
//
// Two shipped paths present skill text to an agent:
//   1. list_packs action:"generate_skill" → renderSkillMarkdown (new skills)
//   2. list_packs action:"skill_read"     → the bundled plugin/skills/*/SKILL.md
// Both must carry a `## Sources` section with **Official:** and **Empirical:**
// so the reader can tell vendor docs from working-graph notes.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  renderSkillMarkdown,
  renderSkillSourcesSection,
  SKILL_SOURCES_HEADING,
  type SkillData,
} from "../../services/skill-generator.js";
import { registerSkillsAccessTools } from "../../tools/skills-access.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function skillReadHandler(): Handler {
  const tools: Array<{ name: string; handler: Handler }> = [];
  const server = {
    tool: (name: string, _desc: string, _shape: z.ZodRawShape, handler: Handler) => {
      tools.push({ name, handler });
    },
  };
  registerSkillsAccessTools(server as never);
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe("list_packs");
  return tools[0].handler;
}

const textOf = (res: Awaited<ReturnType<Handler>>) => res.content.map((c) => c.text).join(" ");

function sourcesSection(markdown: string): string {
  const headingAt = markdown.search(/^## Sources[ \t]*$/m);
  expect(headingAt, "missing ## Sources heading").toBeGreaterThan(-1);
  const from = markdown.slice(headingAt);
  const afterHeading = from.slice(SKILL_SOURCES_HEADING.length);
  const nextHeading = afterHeading.search(/\n## /);
  return nextHeading === -1 ? from : from.slice(0, SKILL_SOURCES_HEADING.length + nextHeading);
}

const SAMPLE: SkillData = {
  name: "demo-pack",
  version: "1.0.0",
  description: "A demo node pack",
  repository: "https://github.com/acme/demo-pack",
  nodes: [],
  examples: [],
};

describe("#1155 generate_skill cites Official vs Empirical", () => {
  it("the helper emits the heading plus Official and Empirical labels from its inputs", () => {
    const official = "https://example.com/vendor-guide";
    const empirical = "inferred from a working graph";
    const block = renderSkillSourcesSection({ official, empirical });
    expect(block.startsWith(SKILL_SOURCES_HEADING)).toBe(true);
    expect(block).toContain(`**Official:** ${official}`);
    expect(block).toContain(`**Empirical:** ${empirical}`);
  });

  it("renderSkillMarkdown cites the repository URL as Official", () => {
    const md = renderSkillMarkdown(SAMPLE);
    const sources = sourcesSection(md);
    expect(sources).toContain(SKILL_SOURCES_HEADING);
    const officialLine = sources.split("\n").find((l) => l.includes("**Official:**")) ?? "";
    expect(officialLine).toContain(SAMPLE.repository);
    expect(sources).toContain("**Empirical:**");
  });

  it("Official says none found when there is no repository to cite", () => {
    const sources = sourcesSection(renderSkillMarkdown({ ...SAMPLE, repository: "" }));
    const officialLine = sources.split("\n").find((l) => l.includes("**Official:**")) ?? "";
    expect(officialLine).toMatch(/none found/i);
    expect(sources).toContain("**Empirical:**");
  });
});

describe("#1155 skill_read returns Official vs Empirical on every bundled skill", () => {
  const handler = skillReadHandler();

  it("finds the bundled skills through skill_list (vacuous-pass guard)", async () => {
    const res = await handler({ action: "skill_list" });
    const parsed = JSON.parse(textOf(res)) as { count: number; skills: Array<{ name: string }> };
    expect(parsed.count).toBeGreaterThan(30);
    expect(parsed.skills.length).toBe(parsed.count);
  });

  it("every skill_read body has ## Sources with Official and Empirical labels", async () => {
    const listed = await handler({ action: "skill_list" });
    const { skills } = JSON.parse(textOf(listed)) as { skills: Array<{ name: string }> };

    for (const { name } of skills) {
      const res = await handler({ action: "skill_read", name });
      expect(res.isError, `${name}: skill_read failed`).toBeUndefined();
      const sources = sourcesSection(textOf(res));
      expect(sources, name).toContain("**Official:**");
      expect(sources, name).toContain("**Empirical:**");
      // Cited vs uncited: Official is either a URL / in-repo product cite, or an
      // explicit "none found". An empty Official line would recreate the gap.
      const officialLine = sources.split("\n").find((l) => l.includes("**Official:**")) ?? "";
      const citesSomething =
        /https?:\/\//i.test(officialLine) ||
        /none found/i.test(officialLine) ||
        /this repo/i.test(officialLine) ||
        /comfyui-mcp/i.test(officialLine);
      expect({ name, officialLine, citesSomething }).toEqual({
        name,
        officialLine,
        citesSomething: true,
      });
    }
  });
});
