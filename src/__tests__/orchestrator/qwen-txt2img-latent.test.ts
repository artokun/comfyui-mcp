// #2758 — the bundled qwen-txt2img skill wired Qwen Image to `EmptyLatentImage`
// while the official Comfy-Org `image_qwen_image` template uses `EmptySD3LatentImage`.
//
// The report's stated impact was WRONG and this test deliberately does not encode it:
// ComfyUI's `fix_empty_latent_channels` (comfy/sample.py, called by common_ksampler)
// repeats an all-zero latent up to the model's channel count, so both nodes hand the
// Qwen sampler a byte-identical (1, 16, 1, H/8, W/8) tensor. Measured against the
// installed ComfyUI, and that fixup is present verbatim at upstream tag v0.33.0.
//
// What IS load-bearing: the rescue is gated on `torch.count_nonzero(latent) == 0`.
// Approach 2 exists to invite inserting nodes between stages, and the first inserted
// node that writes into the latent takes the rescue away. So the examples must start
// 16-channel, and must agree with the template a preflight will compare them against.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SKILL_URL = new URL("../../../plugin/skills/qwen-txt2img/SKILL.md", import.meta.url);
const SKILL = readFileSync(SKILL_URL, "utf-8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

type Node = { class_type?: unknown; inputs?: Record<string, unknown> };

/** Every ```json block in the skill that parses, as a parsed value. */
function jsonBlocks(markdown: string): unknown[] {
  const out: unknown[] = [];
  for (const m of markdown.matchAll(/```json\n([\s\S]*?)\n```/g)) {
    // A block that does not parse is a separate defect; surface it rather than skip it.
    out.push(JSON.parse(m[1]));
  }
  return out;
}

/** A prompt-format graph: an object whose values are all nodes carrying a class_type. */
function asGraph(value: unknown): Record<string, Node> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return undefined;
  const isNode = (v: unknown) =>
    typeof v === "object" && v !== null && typeof (v as Node).class_type === "string";
  return entries.every(([, v]) => isNode(v)) ? (value as Record<string, Node>) : undefined;
}

describe("#2758 qwen-txt2img latent examples match the official Qwen Image template", () => {
  it("parses every JSON example the skill ships", () => {
    expect(jsonBlocks(SKILL).length).toBeGreaterThan(0);
  });

  it("feeds every KSampler's latent_image from EmptySD3LatentImage, not EmptyLatentImage", () => {
    let checked = 0;
    for (const block of jsonBlocks(SKILL)) {
      const graph = asGraph(block);
      if (!graph) continue;
      for (const [id, node] of Object.entries(graph)) {
        if (node.class_type !== "KSampler") continue;
        const link = node.inputs?.latent_image;
        expect(Array.isArray(link), `KSampler "${id}" has no linked latent_image`).toBe(true);
        const producer = graph[(link as [string, number])[0]];
        expect(producer, `KSampler "${id}" latent_image points at a missing node`).toBeDefined();
        expect(producer.class_type).toBe("EmptySD3LatentImage");
        checked += 1;
      }
    }
    // Guards the guard: if the examples stop containing a KSampler, the loop above
    // passes vacuously and this test would stop defending anything.
    expect(checked, "no KSampler example left to check").toBeGreaterThanOrEqual(2);
  });

  it("names no EmptyLatentImage node in any shipped example or the pipeline diagram", () => {
    expect(SKILL).not.toMatch(/"class_type":\s*"EmptyLatentImage"/);
    expect(SKILL).not.toMatch(/^EmptyLatentImage \(/m);
  });

  it("keeps the reason on the page so this is not re-filed, or 'fixed' elsewhere on a false premise", () => {
    // Six other bundled skills use EmptyLatentImage with 16-channel models and are
    // correct for the same reason. Naming the mechanism is what stops that edit.
    expect(SKILL).toContain("fix_empty_latent_channels");
    expect(SKILL).toContain("count_nonzero");
  });

  it("cites the official template it now agrees with", () => {
    expect(SKILL).toContain(
      "https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_qwen_image.json",
    );
    expect(SKILL).not.toMatch(/\*\*Official:\*\*\s*none found/i);
  });
});
