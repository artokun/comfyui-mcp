// #2484 — apply_manifest({pack: "z-image-turbo-inpainting"}) used to clone the
// z-image-turbo monolith's full custom_nodes list. The standalone inpaint slice
// never references eight of those packs, so a fresh ComfyUI install pulled
// third-party code that extract_deps would not require.
//
// The shipped pack must not pull those deps on ANY install path: apply_manifest
// (manifest.yaml), the generated one-click scripts, or loading workflow.json
// (extract_deps / missing-node recovery). Tests the files apply_manifest and
// packs:gen actually consume — not a parallel fixture.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadManifestFile, resolvePackManifestFile } from "../../services/manifest.js";

const PACK = "z-image-turbo-inpainting";
const PACK_DIR = join(process.cwd(), "packs", PACK);

const REQUIRED_REPOS = [
  "city96/ComfyUI-GGUF",
  "rgthree/rgthree-comfy",
  "yolain/ComfyUI-Easy-Use",
  "cubiq/ComfyUI_essentials",
] as const;

const UNUSED_RE = /KJNodes|UltimateSDUpscale|wlsh_nodes|vrgamedevgirl|RES4LYF|SeedVarianceEnhancer|Detail-Daemon|controlnet_aux/i;

const CUSTOM_CNR = new Set(["ComfyUI-GGUF", "rgthree-comfy", "comfyui-easy-use", "comfyui_essentials"]);
const CUSTOM_TYPES = new Set([
  "CLIPLoaderGGUF",
  "UnetLoaderGGUF",
  "Power Lora Loader (rgthree)",
  "easy cleanGpuUsed",
  "easy clearCacheAll",
  "MaskBlur+",
]);

describe("z-image-turbo-inpainting does not install unused custom-node packs (#2484)", () => {
  it("apply_manifest pack: name resolves to the shipped manifest", () => {
    const file = resolvePackManifestFile(PACK);
    expect(file, "the reported pack must resolve from the running package root").toBeTruthy();
    expect(file).toMatch(/z-image-turbo-inpainting[\\/]manifest\.ya?ml$/);
  });

  it("the shipped manifest lists only the four packs the inpaint graph uses", async () => {
    const file = resolvePackManifestFile(PACK);
    expect(file).toBeTruthy();
    const manifest = await loadManifestFile(file!);
    expect(manifest.custom_nodes).toHaveLength(REQUIRED_REPOS.length);
    for (const repo of REQUIRED_REPOS) {
      expect(manifest.custom_nodes.join("\n")).toMatch(new RegExp(repo.replace("/", "\\/")));
    }
    expect(manifest.custom_nodes.join("\n")).not.toMatch(UNUSED_RE);
    // Also pin the on-disk YAML (comments + unparsed extras) so a commented-back
    // clone cannot sneak past the schema parse.
    const raw = parse(readFileSync(file!, "utf8")) as {
      custom_nodes?: unknown;
    };
    const nodes = Array.isArray(raw.custom_nodes) ? raw.custom_nodes : [];
    expect(nodes).toHaveLength(REQUIRED_REPOS.length);
    for (const entry of nodes) {
      expect(String(entry), String(entry)).not.toMatch(UNUSED_RE);
    }
  });

  it("workflow.json custom nodes belong only to those four packs", () => {
    const file = join(PACK_DIR, "workflow.json");
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(UNUSED_RE);
    const parsed = JSON.parse(text) as {
      nodes?: { type?: string; properties?: { cnr_id?: string; aux_id?: string } }[];
      extra?: { groupNodes?: Record<string, { nodes?: { type?: string }[] }> };
    };
    expect(Array.isArray(parsed.nodes), "UI/litegraph shape").toBe(true);
    const types = new Set((parsed.nodes ?? []).map((n) => n.type).filter((t): t is string => !!t));
    for (const t of CUSTOM_TYPES) expect(types.has(t), t).toBe(true);
    for (const node of parsed.nodes ?? []) {
      const cnr = node.properties?.cnr_id;
      if (cnr && cnr !== "comfy-core") {
        expect(CUSTOM_CNR.has(cnr), `unexpected cnr_id ${cnr} on ${node.type}`).toBe(true);
      }
      const aux = node.properties?.aux_id;
      if (aux) {
        expect(
          REQUIRED_REPOS.some((repo) => aux === repo),
          `unexpected aux_id ${aux} on ${node.type}`,
        ).toBe(true);
      }
    }
    for (const group of Object.values(parsed.extra?.groupNodes ?? {})) {
      for (const node of group.nodes ?? []) {
        expect(node.type, node.type).not.toMatch(UNUSED_RE);
      }
    }
  });

  it("generated installers clone only the four required packs", () => {
    for (const name of ["install-windows.bat", "install-runpod.sh"]) {
      const file = join(PACK_DIR, name);
      expect(existsSync(file), name).toBe(true);
      const text = readFileSync(file, "utf8");
      expect(text, name).not.toMatch(UNUSED_RE);
      for (const repo of REQUIRED_REPOS) {
        expect(text, name).toContain(`https://github.com/${repo}`);
      }
    }
  });
});
