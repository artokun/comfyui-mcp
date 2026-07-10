// The query engine behind query_workflow (headless) — and the SEMANTIC SPEC for
// the panel's graph_query executor twin (comfyui-mcp-panel), which mirrors it
// by hand in live-graph JS. If a behavior changes here, port it there.

import { describe, expect, it } from "vitest";
import { queryApiGraph } from "../../services/graph-query.js";

// A small but realistic txt2img chain with a second chained sampler:
//   1 ckpt → {2,3} prompts → 5 KSampler → 6 KSampler → 7 VAEDecode → 8 SaveImage
//   4 latent → 5
const G = {
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd15.safetensors" } },
  "2": { class_type: "CLIPTextEncode", inputs: { text: "a sunset over mountains", clip: ["1", 1] } },
  "3": { class_type: "CLIPTextEncode", inputs: { text: "blurry, low quality", clip: ["1", 1] } },
  "4": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512 } },
  "5": {
    class_type: "KSampler",
    inputs: { seed: 42, steps: 20, cfg: 7.5, sampler_name: "euler", model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0] },
  },
  "6": {
    class_type: "KSampler",
    _meta: { title: "refiner pass" },
    inputs: { seed: 1, steps: 30, cfg: 5, sampler_name: "dpmpp_2m", model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["5", 0] },
  },
  "7": { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["1", 2] } },
  "8": { class_type: "SaveImage", _meta: { title: "Final Save" }, inputs: { images: ["7", 0], filename_prefix: "out" } },
};

describe("queryApiGraph", () => {
  it("no filters → every node, compact one-liners with wiring", () => {
    const r = queryApiGraph(G);
    expect(r.total).toBe(8);
    expect(r.matched).toBe(8);
    expect(r.shown).toBe(8);
    expect(r.truncated).toBe(false);
    expect(r.text).toContain("#5 KSampler");
    expect(r.text).toContain("cfg=7.5");
    expect(r.text).toContain("← model:1"); // ref inputs shown as name:src
    expect(r.text).toContain("→ "); // downstream ids shown
  });

  it("types filter is case-insensitive substring, any-of", () => {
    const r = queryApiGraph(G, { types: ["ksampler", "vaedecode"] });
    expect(r.matched).toBe(3);
  });

  it("where: numeric compare", () => {
    expect(queryApiGraph(G, { where: ["cfg>7"] }).matched).toBe(1);
    expect(queryApiGraph(G, { where: ["steps<=20"] }).matched).toBe(1);
    expect(queryApiGraph(G, { where: ["cfg>=5"], types: ["KSampler"] }).matched).toBe(2);
  });

  it("where: string equality and contains; predicates AND", () => {
    expect(queryApiGraph(G, { where: ["sampler_name=euler"] }).matched).toBe(1);
    expect(queryApiGraph(G, { where: ["text~sunset"] }).matched).toBe(1);
    expect(queryApiGraph(G, { where: ["sampler_name=euler", "cfg>7"] }).matched).toBe(1);
    expect(queryApiGraph(G, { where: ["sampler_name=euler", "cfg<7"] }).matched).toBe(0);
  });

  it("a predicate on a missing widget never matches (link refs are NOT widgets)", () => {
    // "model" on the KSamplers is a link ref, not a widget — must not be comparable.
    expect(queryApiGraph(G, { where: ["model~1"] }).matched).toBe(0);
  });

  it("bad predicate throws with the expected-shape message", () => {
    expect(() => queryApiGraph(G, { where: ["cfg >> 7"] })).toThrow(/Bad predicate/); // mistyped op
    expect(() => queryApiGraph(G, { where: ["steps => 20"] })).toThrow(/Bad predicate/);
    expect(() => queryApiGraph(G, { where: ["cfg"] })).toThrow(/Bad predicate/); // no op at all
  });

  it("ids + detail projection carries widgets, upstream refs, and downstream ids", () => {
    const r = queryApiGraph(G, { ids: [8], fields: "detail" });
    expect(r.matched).toBe(1);
    const row = JSON.parse(r.text.split("\n")[1]);
    expect(row.type).toBe("SaveImage");
    expect(row.title).toBe("Final Save");
    expect(row.widgets.filename_prefix).toBe("out");
    expect(row.upstream.images).toBe("7.0");
    expect(row.downstream).toEqual([]);
  });

  it("upstream_of: seed at depth 0, hop-limited", () => {
    // 7's direct feeders are 6 (samples) and 1 (vae).
    const r1 = queryApiGraph(G, { upstream_of: 7, depth: 1 });
    expect(r1.candidates).toBe(3); // {7, 6, 1}
    const rAll = queryApiGraph(G, { upstream_of: 8 });
    expect(rAll.candidates).toBe(8); // full closure reaches everything
  });

  it("downstream_of: what consumes a node's outputs", () => {
    const r = queryApiGraph(G, { downstream_of: 2 });
    expect(r.candidates).toBe(5); // {2, 5, 6, 7, 8}
  });

  it("traversal scope composes with filters", () => {
    const r = queryApiGraph(G, { upstream_of: 7, types: ["KSampler"] });
    expect(r.matched).toBe(2);
  });

  it("unknown traversal seed → explanatory text, no throw", () => {
    const r = queryApiGraph(G, { upstream_of: 99 });
    expect(r.matched).toBe(0);
    expect(r.text).toContain("not found");
  });

  it("group_by type aggregates the matched set", () => {
    const r = queryApiGraph(G, { group_by: "type" });
    expect(r.text).toContain("2× KSampler");
    expect(r.text).toContain("2× CLIPTextEncode");
    expect(r.shown).toBe(8);
  });

  it("fields ids → bare comma list", () => {
    const r = queryApiGraph(G, { types: ["KSampler"], fields: "ids" });
    expect(r.text.split("\n")[1]).toBe("5,6");
  });

  it("limit truncates with the explicit marker", () => {
    const r = queryApiGraph(G, { limit: 2 });
    expect(r.shown).toBe(2);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("… truncated at 2 of 8");
  });

  it("max_chars bounds output with the explicit marker", () => {
    const r = queryApiGraph(G, { max_chars: 500 });
    expect(r.truncated).toBe(true);
    expect(r.shown).toBeLessThan(8);
    expect(r.text).toContain("truncated");
  });
});
