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

  // ---- #609: a single node's detail must never truncate to shown:0 -----------
  describe("#609: budget never starves the node you asked for", () => {
    // A node whose ONE widget is a pathological blob (ResolutionMaster presets JSON,
    // LTXDirector.timeline_data, VHS videopreview…). Raw, its detail line alone
    // exceeds the default single-node budget → the old loop returned shown:0.
    const BLOB = "x".repeat(20000);
    const Gblob = {
      "164": { class_type: "ResolutionMaster", inputs: { auto_detect_presets_json: BLOB, width: 1024 } },
      "165": { class_type: "KSampler", inputs: { steps: 20, cfg: 7 } },
    };

    it("one requested huge-blob node renders (shown:1, not shown:0)", () => {
      const r = queryApiGraph(Gblob, { ids: [164], fields: "detail", max_chars: 7000 });
      expect(r.matched).toBe(1);
      expect(r.shown).toBe(1); // FAIL-BEFORE: was 0
    });

    it("the oversized widget value is capped, not dropped silently", () => {
      const r = queryApiGraph(Gblob, { ids: [164], fields: "detail" });
      expect(r.text).toContain("truncated)"); // the per-value cap marker
      expect(r.text.length).toBeLessThan(BLOB.length); // blob no longer flooding
      expect(r.text).toContain('"width":1024'); // the small sibling value survives intact
    });

    it("one node's blob no longer starves its siblings", () => {
      // Query both nodes; the blob node sorts first. Before the cap+protection it
      // rendered alone and truncated node 165 away.
      const r = queryApiGraph(Gblob, { fields: "detail", max_chars: 7000 });
      expect(r.shown).toBe(2);
      expect(r.text).toContain("KSampler");
    });

    it("explicit-ids truncation stays token-bounded and gives followable advice", () => {
      // Three capped blobs, all requested by id, tiny budget. Only the first renders
      // (the token bound is preserved — we do NOT wholesale-exempt every id), and the
      // tail must advise raising max_chars, NOT the dead-end 'narrow with ids'.
      const G2 = {
        "1": { class_type: "A", inputs: { blob: "a".repeat(5000) } },
        "2": { class_type: "B", inputs: { blob: "b".repeat(5000) } },
        "3": { class_type: "C", inputs: { blob: "c".repeat(5000) } },
      };
      const r = queryApiGraph(G2, { ids: [1, 2, 3], fields: "detail", max_chars: 600 });
      expect(r.matched).toBe(3);
      expect(r.shown).toBe(1); // first renders, rest budget-truncated (bounded output)
      expect(r.truncated).toBe(true);
      expect(r.text).toContain("raise max_chars");
      expect(r.text).not.toContain("narrow with"); // no dead-end advice for explicit ids
    });

    it("even the protected first node's detail stays token-bounded (many oversized widgets)", () => {
      // A pathological node: 40 independently oversized widgets. Per-value capping
      // alone would still yield ~40×2KB; the total-widgets cap must keep the ONE
      // protected first line near max_chars, not blow it.
      const widgets: Record<string, unknown> = {};
      for (let i = 0; i < 40; i++) widgets[`w${i}`] = "z".repeat(5000);
      const Gwide = { "1": { class_type: "Pathological", inputs: widgets } };
      const maxChars = 3000;
      const r = queryApiGraph(Gwide, { ids: [1], fields: "detail", max_chars: maxChars });
      expect(r.shown).toBe(1); // still renders the requested node
      // Bounded: the single line must not be an order of magnitude over the budget.
      expect(r.text.length).toBeLessThan(maxChars * 2);
      expect(r.text).toContain("omitted (exceeded budget)"); // honest elision marker
    });

    it("detail bound holds for a SMALL budget, even with ESCAPE-HEAVY content", () => {
      // max_chars 600 < WIDGET_VALUE_CAP AND every char JSON-escapes to two ("→\").
      // The retained widget must be tightened accounting for escaping, so the line
      // stays near the budget rather than doubling past it.
      const Gsmall = { "1": { class_type: "X", inputs: { blob: '"'.repeat(5000) } } };
      const r = queryApiGraph(Gsmall, { ids: [1], fields: "detail", max_chars: 600 });
      expect(r.shown).toBe(1);
      expect(r.text.length).toBeLessThan(600 * 2);
    });

    it("detail bounds a fan-out node's downstream consumer list (#609)", () => {
      // A source feeding 500 consumers would otherwise emit a 500-id downstream array
      // in the protected first line. Cap it with a "+N more" tail.
      const G3: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
        "1": { class_type: "Source", inputs: {} },
      };
      for (let i = 2; i < 502; i++) G3[String(i)] = { class_type: "Sink", inputs: { x: ["1", 0] } };
      const r = queryApiGraph(G3, { ids: [1], fields: "detail", max_chars: 2000 });
      expect(r.shown).toBe(1);
      expect(r.text).toContain("more"); // "+N more" downstream tail
      expect(r.text.length).toBeLessThan(2000 * 2);
    });

    it("compact projection is bounded by widget COUNT for the protected first line", () => {
      // 5000 tiny widgets: each clips to ~60 chars in compact, but the protected first
      // line would be ~5000×small without the line clip. Must stay near max_chars.
      const widgets: Record<string, unknown> = {};
      for (let i = 0; i < 5000; i++) widgets[`k${i}`] = i;
      const Gmany = { "1": { class_type: "Wide", inputs: widgets } };
      const maxChars = 2000;
      const r = queryApiGraph(Gmany, { ids: [1], fields: "compact", max_chars: maxChars });
      expect(r.shown).toBe(1);
      expect(r.text.length).toBeLessThan(maxChars * 2);
    });

    it("detail bounds pathological KEYS and a wide upstream fan-in (#609)", () => {
      // A 10k-char widget key and 300 ref-inputs would each blow the line via a field
      // the widget-value cap doesn't touch. Keys are clipped, upstream count is capped.
      const inputs: Record<string, unknown> = { ["k".repeat(10000)]: "v" };
      for (let i = 0; i < 300; i++) inputs[`in${i}`] = [String(i + 1000), 0];
      const G4 = { "1": { class_type: "Wide", inputs } };
      const r = queryApiGraph(G4, { ids: [1], fields: "detail", max_chars: 2000 });
      expect(r.shown).toBe(1);
      expect(r.text.length).toBeLessThan(2000 * 2);
    });

    it("the protected detail line NEVER exceeds max_chars — degrades to a bounded stub (#609)", () => {
      // Extreme high-fan-in: 500 ref inputs with long names + 500 consumers + big widget,
      // at a tiny budget. Even after every per-field cap the row can exceed max_chars, so
      // it must degrade to a valid-JSON stub. Assert the single line body is ≤ max_chars.
      const inputs: Record<string, unknown> = { blob: "z".repeat(9000) };
      for (let i = 0; i < 500; i++) inputs[`input_slot_name_${i}`] = [String(i + 2000), 3];
      const Gbig: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
        "1": { class_type: "Hub", inputs },
      };
      for (let i = 0; i < 500; i++) Gbig[String(i + 2000)] = { class_type: "Src", inputs: {} };
      // make node 1 feed 500 consumers
      for (let i = 0; i < 500; i++) Gbig[`c${i}`] = { class_type: "Sink", inputs: { x: ["1", 0] } };
      const maxChars = 800;
      const r = queryApiGraph(Gbig, { ids: [1], fields: "detail", max_chars: maxChars });
      expect(r.shown).toBe(1);
      const body = r.text.split("\n").slice(1).join("\n"); // drop header
      expect(body.length).toBeLessThanOrEqual(maxChars); // the one detail line ≤ budget
      expect(r.text).toContain("detail_omitted"); // valid-JSON stub marker
      expect(() => JSON.parse(body)).not.toThrow(); // still valid JSON
    });

    it("the degraded stub itself stays ≤ max_chars even for a pathologically long node id (#609)", () => {
      // A 5000-char node id + overflowing detail: the stub must clip its OWN id/type,
      // so even the fallback row respects the budget.
      const longId = "n".repeat(5000);
      const inputs: Record<string, unknown> = { blob: "z".repeat(9000) };
      const G5: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
        [longId]: { class_type: "T".repeat(5000), inputs },
      };
      const maxChars = 600;
      const r = queryApiGraph(G5, { ids: [longId], fields: "detail", max_chars: maxChars });
      expect(r.shown).toBe(1);
      const body = r.text.split("\n").slice(1).join("\n");
      expect(body.length).toBeLessThanOrEqual(maxChars);
      expect(() => JSON.parse(body)).not.toThrow();
    });

    it("error/diagnostic paths clip an oversized caller-supplied seed/predicate (#609)", () => {
      const bigSeed = "z".repeat(1_000_000);
      const rSeed = queryApiGraph(G, { upstream_of: bigSeed });
      expect(rSeed.text.length).toBeLessThan(500); // not ~1MB
      expect(rSeed.text).toContain("not found");
      // Bad predicate error message is likewise clipped.
      expect(() => queryApiGraph(G, { where: [`cfg==${"9".repeat(1_000_000)}`] })).toThrow(/Bad predicate/);
      try {
        queryApiGraph(G, { where: [`cfg==${"9".repeat(1_000_000)}`] });
      } catch (e) {
        expect((e as Error).message.length).toBeLessThan(500);
      }
    });

    it("group_by:'type' aggregate is char-bounded too (#609)", () => {
      const G7: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {};
      for (let i = 0; i < 2000; i++) G7[String(i)] = { class_type: `VeryLongNodeTypeName_${i}`, inputs: {} };
      const maxChars = 1000;
      const r = queryApiGraph(G7, { group_by: "type", max_chars: maxChars });
      expect(r.text.length).toBeLessThan(maxChars * 2);
      expect(r.truncated).toBe(true);
      expect(r.text).toContain("more type(s) omitted");
    });

    it("fields:'ids' also bounds a pathologically long node id (#609)", () => {
      const longId = "n".repeat(5000);
      const G6 = { [longId]: { class_type: "X", inputs: {} } };
      const maxChars = 500;
      const r = queryApiGraph(G6, { ids: [longId], fields: "ids", max_chars: maxChars });
      expect(r.shown).toBe(1);
      const body = r.text.split("\n").slice(1).join("\n");
      expect(body.length).toBeLessThanOrEqual(maxChars);
    });

    it("without explicit ids the advice still points at narrowing", () => {
      const many: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {};
      for (let i = 0; i < 30; i++) many[String(i)] = { class_type: "KSampler", inputs: { note: "y".repeat(400) } };
      const r = queryApiGraph(many, { fields: "detail", max_chars: 800 });
      expect(r.truncated).toBe(true);
      expect(r.text).toContain("narrow with types/where/ids/depth");
    });
  });
});
