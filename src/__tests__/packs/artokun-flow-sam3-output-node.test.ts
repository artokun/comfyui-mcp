// #2523 — artokun-flow cannot validate after a clean manifest install:
// REPLACEMENT MODE's SAM3 subgraph needs sam3.1_multiplex_fp16.safetensors but
// the manifest never downloaded it, and the only final save node was
// TSVideoCombineNoMetadata, which the teskor-hub teskors-utils Manager actually
// installs is not OUTPUT_NODE — so panel_run(to_node_id) refuses it.
//
// Pin the SHIPPED pack files apply_manifest / packs:gen consume — not a fixture.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadManifestFile, resolvePackManifestFile } from "../../services/manifest.js";

const PACK = "artokun-flow";
const PACK_DIR = join(process.cwd(), "packs", PACK);
const SAM3 = "sam3.1_multiplex_fp16.safetensors";
const SAM3_URL =
  "https://huggingface.co/Comfy-Org/sam3.1/resolve/main/checkpoints/sam3.1_multiplex_fp16.safetensors";
const SAM3_PATH = `checkpoints/${SAM3}`;
const ARTOKUN_UTILS = "https://github.com/artokun/comfyui-teskors-utils";
const TESKOR_HUB = "teskor-hub/comfyui-teskors-utils";
const OUTPUT_SAVER = "VHS_VideoCombine";
const INVALID_SAVER = "TSVideoCombineNoMetadata";

type UiNode = {
  id?: number;
  type?: string;
  mode?: number;
  widgets_values?: unknown;
  properties?: { aux_id?: string; cnr_id?: string };
};

type UiSubgraph = { nodes?: UiNode[]; definitions?: { subgraphs?: UiSubgraph[] } };
type UiWorkflow = UiSubgraph;

function loadUiWorkflow(): UiWorkflow {
  const file = join(PACK_DIR, "workflow.json");
  expect(existsSync(file), file).toBe(true);
  return JSON.parse(readFileSync(file, "utf8")) as UiWorkflow;
}

function walkNodes(graph: UiSubgraph, out: UiNode[] = []): UiNode[] {
  if (Array.isArray(graph.nodes)) out.push(...graph.nodes);
  for (const sub of graph.definitions?.subgraphs ?? []) walkNodes(sub, out);
  return out;
}

function workflowText(): string {
  return readFileSync(join(PACK_DIR, "workflow.json"), "utf8");
}

function widgetTreeHas(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value === needle || value.endsWith(`/${needle}`);
  if (Array.isArray(value)) return value.some((v) => widgetTreeHas(v, needle));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((v) => widgetTreeHas(v, needle));
  }
  return false;
}

describe("artokun-flow ships SAM3 and an OUTPUT_NODE saver (#2523)", () => {
  it("apply_manifest pack: name still resolves to the shipped manifest", () => {
    const file = resolvePackManifestFile(PACK);
    expect(file, "the reported pack must resolve from the running package root").toBeTruthy();
    expect(file).toMatch(/artokun-flow[\\/]manifest\.ya?ml$/);
  });

  it("the shipped manifest installs the SAM3 checkpoint REPLACEMENT MODE loads", async () => {
    const file = resolvePackManifestFile(PACK);
    expect(file).toBeTruthy();
    const manifest = await loadManifestFile(file!);
    const sam3 = manifest.models.find(
      (m) => m.local_path === SAM3_PATH || m.url === SAM3_URL || m.local_path?.endsWith(SAM3),
    );
    expect(sam3, "manifest must download sam3.1_multiplex_fp16.safetensors").toBeTruthy();
    expect(sam3!.url).toBe(SAM3_URL);
    expect(sam3!.local_path).toBe(SAM3_PATH);
  });

  it("REPLACEMENT MODE's CheckpointLoaderSimple still names that SAM3 file", () => {
    const nodes = walkNodes(loadUiWorkflow());
    const loaders = nodes.filter(
      (n) => n.type === "CheckpointLoaderSimple" && widgetTreeHas(n.widgets_values, SAM3),
    );
    expect(loaders.length, "SAM3 loader must remain in the shipped graph").toBeGreaterThan(0);
  });

  it("the root graph saves with an active VHS_VideoCombine, not TSVideoCombineNoMetadata", () => {
    const text = workflowText();
    expect(text).not.toContain(`"${INVALID_SAVER}"`);
    expect(text).toContain(`"${OUTPUT_SAVER}"`);
    const root = loadUiWorkflow().nodes ?? [];
    const active = (n: UiNode) => n.mode === 0 || n.mode === undefined;
    const vhs = root.filter((n) => n.type === OUTPUT_SAVER && active(n));
    expect(vhs.length, "an active VHS_VideoCombine OUTPUT_NODE saver").toBeGreaterThan(0);
    expect(vhs.some((n) => n.id === 758), "node 758 is the SAVE VIDEO output").toBe(true);
    const invalid = walkNodes(loadUiWorkflow()).filter((n) => n.type === INVALID_SAVER);
    expect(
      invalid,
      "TSVideoCombineNoMetadata is not OUTPUT_NODE on the Manager-installed teskor-hub pack",
    ).toEqual([]);
    const saver = vhs.find((n) => n.id === 758)!;
    const widgets = saver.widgets_values as { format?: string; frame_rate?: number } | unknown[];
    if (Array.isArray(widgets)) {
      expect(widgets).toContain("video/h264-mp4");
      expect(widgets).toContain(30);
    } else {
      expect(widgets.format).toBe("video/h264-mp4");
      expect(widgets.frame_rate).toBe(30);
    }
  });

  it("the manifest still requests the artokun teskors-utils origin, not teskor-hub", async () => {
    const file = resolvePackManifestFile(PACK);
    const manifest = await loadManifestFile(file!);
    expect(manifest.custom_nodes.join("\n")).toContain(ARTOKUN_UTILS);
    expect(manifest.custom_nodes.join("\n")).not.toContain(TESKOR_HUB);
    const raw = readFileSync(file!, "utf8");
    expect(raw).toContain(ARTOKUN_UTILS);
    expect(raw).not.toContain(`https://github.com/${TESKOR_HUB}`);
  });

  it("the shipped workflow stamps TS nodes with the artokun origin, not teskor-hub", () => {
    const text = workflowText();
    expect(text).not.toContain(TESKOR_HUB);
    expect(text).not.toContain("teskor-hub/NEW-UTILS");
    const tsNodes = walkNodes(loadUiWorkflow()).filter(
      (n) => n.type === "TSColorMatch" || n.type === "TSPoseDataSmoother",
    );
    expect(tsNodes.length, "color match + pose smoother stay in the graph").toBeGreaterThan(0);
    for (const node of tsNodes) {
      expect(node.properties?.aux_id, node.type).toBe("artokun/comfyui-teskors-utils");
    }
  });

  it("generated installers download SAM3 and clone the artokun origin", () => {
    for (const name of ["install-windows.bat", "install-runpod.sh"]) {
      const file = join(PACK_DIR, name);
      expect(existsSync(file), name).toBe(true);
      const text = readFileSync(file, "utf8");
      expect(text, name).toContain(SAM3);
      expect(text, name).toContain(SAM3_URL);
      expect(text, name).toContain(ARTOKUN_UTILS);
      expect(text, name).not.toContain(`https://github.com/${TESKOR_HUB}`);
    }
  });
});
