// #1767 — packs:check-models is now a CI gate, so its false-positive rate is no
// longer cosmetic: a gate that cries wolf gets deleted, and a gate that stays
// quiet on a real gap ships a broken pack.
//
// The defect that motivated this file: when a widget is promoted to an input and
// connected, litegraph keeps the old string in `widgets_values` forever, but
// `graphToPrompt` builds that input from the LINK. The stored string is dead.
// Seven `LoraLoader` slots across two shipped packs were exactly this, and the
// gate reported all seven as missing models that no install can ever miss.
//
// The tests below fix BOTH directions. The negative half (a dead slot stays
// quiet) is the fix; the positive half (an ambiguous node still fails, the link
// SOURCE is still caught) is what stops the fix from becoming a silencer.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts", "check-pack-models.mjs");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "packmodels-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Write a synthetic one-pack fixture. `manifest` lists what the pack downloads. */
function pack(nodes: unknown[], provided: string[] = [], packYaml = "") {
  const p = join(dir, "fixture");
  mkdirSync(p, { recursive: true });
  writeFileSync(
    join(p, "manifest.yaml"),
    `name: fixture\nmodels:\n${provided.map((f) => `  - url: https://example.invalid/${f}\n    local_path: loras/${f}\n`).join("") || "  []\n"}`,
  );
  writeFileSync(join(p, "pack.yaml"), `name: fixture\nworkflow: workflow.json\n${packYaml}`);
  writeFileSync(join(p, "workflow.json"), JSON.stringify({ nodes }));
  return p;
}

/** Run the gate against a fixture. The MESSAGE is part of the contract — a
 *  developer who cannot tell which node fired will reach for the allow-list. */
function run(fixture: string) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, fixture], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

/** A LoraLoader whose `lora_name` widget was promoted to an input. `link` null
 *  means promoted-but-UNCONNECTED, which still reads its widget value. */
const loraLoader = (id: number, widgetValue: string, link: number | null) => ({
  id,
  type: "LoraLoader",
  mode: 0,
  widgets_values: [widgetValue, 1, 1],
  inputs: [
    { name: "model", type: "MODEL", link: 1 },
    { name: "clip", type: "CLIP", link: 2 },
    { name: "lora_name", type: "COMBO", widget: { name: "lora_name" }, link },
  ],
});

describe("#1767 a widget slot fed by a link is DEAD, not a reference", () => {
  it("stays quiet on the exact shape that shipped in z-image-xy-plot", () => {
    // Five LoraLoaders carrying a stale filename, every lora_name link-fed.
    const nodes = [86, 91, 99, 113, 129].map((id) =>
      loraLoader(id, "01margott_W_000001000.safetensors", 100 + id),
    );
    const r = run(pack(nodes));
    expect(r.out).not.toContain("01margott_W_000001000.safetensors");
    expect(r.code).toBe(0);
  });

  it("DOES fail when the promoted widget is not connected", () => {
    // Same node, link: null. The widget value is what ComfyUI loads, so a gap
    // here is real. This is the pair that proves the fix keys on the LINK and
    // not merely on "lora_name was promoted".
    const r = run(pack([loraLoader(91, "unobtainable.safetensors", null)]));
    expect(r.code).toBe(1);
    expect(r.out).toContain("unobtainable.safetensors");
    expect(r.out).toContain("LoraLoader#91");
  });

  it("still catches the value at the LINK SOURCE, so no coverage is lost", () => {
    // The real reference lives on the selector node that feeds the link. This is
    // why skipping the dead slot loses nothing: the gap is still reported, just
    // against the node that actually supplies the value.
    const nodes = [
      loraLoader(91, "stale-and-dead.safetensors", 153),
      { id: 92, type: "easy loraNames", mode: 0, widgets_values: ["really-missing.safetensors"], inputs: [] },
    ];
    const r = run(pack(nodes));
    expect(r.code).toBe(1);
    expect(r.out).toContain("really-missing.safetensors");
    expect(r.out).toContain("easy loraNames#92");
    expect(r.out).not.toContain("stale-and-dead.safetensors");
  });

  it("a satisfied link source is clean end to end", () => {
    const nodes = [
      loraLoader(91, "stale-and-dead.safetensors", 153),
      { id: 92, type: "easy loraNames", mode: 0, widgets_values: ["shipped.safetensors"], inputs: [] },
    ];
    const r = run(pack(nodes, ["shipped.safetensors"]));
    expect(r.code).toBe(0);
    expect(r.out).toContain("no live gaps");
  });
});

describe("#1767 the fix must not become a silencer", () => {
  it("an AMBIGUOUS node still fails — more model strings than linked slots", () => {
    // clip_name1 is link-fed, clip_name2 is typed in. The script has no
    // object_info and cannot tell which slot is which, so it must report BOTH
    // rather than guess and hide a genuinely missing model.
    const nodes = [
      {
        id: 7,
        type: "DualCLIPLoader",
        mode: 0,
        widgets_values: ["fed-by-link.safetensors", "typed-in-and-missing.safetensors", "ltxv"],
        inputs: [{ name: "clip_name1", type: "COMBO", widget: { name: "clip_name1" }, link: 55 }],
      },
    ];
    const r = run(pack(nodes));
    expect(r.code).toBe(1);
    expect(r.out).toContain("typed-in-and-missing.safetensors");
  });

  it("a linked input that is NOT a model selector suppresses nothing", () => {
    // The shape wan-animate ships: positive_prompt is link-fed while the node
    // also carries a real, live text-encoder filename in widgets_values.
    const nodes = [
      {
        id: 65,
        type: "WanVideoTextEncodeCached",
        mode: 0,
        widgets_values: ["umt5-xxl-enc-bf16.safetensors", "some prompt"],
        inputs: [{ name: "positive_prompt", type: "STRING", widget: { name: "positive_prompt" }, link: 9 }],
      },
    ];
    const r = run(pack(nodes));
    expect(r.code).toBe(1);
    expect(r.out).toContain("umt5-xxl-enc-bf16.safetensors");
  });

  it("a plain unpromoted loader gap still fails", () => {
    const nodes = [{ id: 10, type: "UnetLoaderGGUF", mode: 0, widgets_values: ["absent-Q8_0.gguf"], inputs: [] }];
    const r = run(pack(nodes));
    expect(r.code).toBe(1);
    expect(r.out).toContain("absent-Q8_0.gguf");
    expect(r.out).toContain("UnetLoaderGGUF#10");
  });

  it("external_models still downgrades a declared gap to clean", () => {
    const nodes = [{ id: 1, type: "LoraLoader", mode: 0, widgets_values: ["YOUR-LORA-final.safetensors", 1, 1], inputs: [] }];
    const r = run(pack(nodes, [], "external_models:\n  - YOUR-LORA-final.safetensors\n"));
    expect(r.code).toBe(0);
  });
});
