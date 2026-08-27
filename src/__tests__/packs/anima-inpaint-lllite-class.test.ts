// #2442 — bundled anima-inpaint serialized the stale class_type AnimaLLLiteApply.
// ComfyUI core now owns that ID (comfy_extras/nodes_model_patch.py) with a
// different signature (MODEL_PATCH from ModelPatchLoader, no mask). The kohya-ss
// pack renamed its node to AnimaLLLiteApply_sdscripts; ComfyUI silently skips a
// custom-node registration that collides with a built-in, so apply_manifest can
// clone ComfyUI-Anima-LLLite and the graph still shows an unknown/core-colliding
// node. extract_deps / missing-node recovery then treats AnimaLLLiteApply as
// builtin and does not install the kohya-ss pack.
//
// Pin the SHIPPED files (workflow.json, pack.yaml, skill examples) and the
// object_info alias split that makes the stale name miss the pack.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ComfyUINodeDef, ObjectInfo, WorkflowJSON } from "../../comfyui/types.js";
import { loadManifestFile, resolvePackManifestFile } from "../../services/manifest.js";
import {
  collectClassTypes,
  extractWorkflowDependencies,
  type WorkflowDepsDeps,
} from "../../services/workflow-deps.js";

const STALE = "AnimaLLLiteApply";
const CURRENT = "AnimaLLLiteApply_sdscripts";
const PACK = "anima-inpaint";
const PACK_DIR = join(process.cwd(), "packs", PACK);
const SKILL = join(process.cwd(), "plugin", "skills", "anima-base", "SKILL.md");
const LLLITE_PACKS = ["anima-inpaint", "anima", "anima-img2img"] as const;

/** Quoted serialized class — matches `"AnimaLLLiteApply"` and not `_sdscripts`. */
const STALE_QUOTED = /"AnimaLLLiteApply"/;

function def(name: string, pythonModule: string): ComfyUINodeDef {
  return {
    input: {},
    output: [],
    output_is_list: [],
    output_name: [],
    name,
    display_name: name,
    description: "",
    category: "",
    output_node: false,
    python_module: pythonModule,
  };
}

/** Live /object_info after ComfyUI 0.21+ and ComfyUI-Anima-LLLite are both loaded. */
function liveAliases(): ObjectInfo {
  return {
    [STALE]: def(STALE, "comfy_extras.nodes_model_patch"),
    [CURRENT]: def(CURRENT, "custom_nodes.ComfyUI-Anima-LLLite"),
    KSampler: def("KSampler", "nodes"),
  };
}

function makeDeps(objectInfo: ObjectInfo): WorkflowDepsDeps {
  return {
    fetchObjectInfo: vi.fn(async () => objectInfo),
    fetchManagerMappings: vi.fn(async () => ({
      "https://github.com/kohya-ss/ComfyUI-Anima-LLLite": [
        [CURRENT],
        { title: "ComfyUI-Anima-LLLite" },
      ],
    })),
    fetchManagerList: vi.fn(async () => ({ channel: "default", packs: [] })),
    queueInstall: vi.fn(async () => undefined),
    resetQueue: vi.fn(async () => undefined),
    startQueue: vi.fn(async () => undefined),
    queueStatus: vi.fn(async () => ({
      total_count: 0,
      done_count: 0,
      in_progress_count: 0,
      is_processing: false,
    })),
  };
}

function loadUiWorkflow(pack: string) {
  const file = join(process.cwd(), "packs", pack, "workflow.json");
  expect(existsSync(file), file).toBe(true);
  return JSON.parse(readFileSync(file, "utf8")) as {
    nodes?: { id: number; type?: string; widgets_values?: unknown[] }[];
  };
}

/** extract_deps is typed on API/prompt graphs; class types still come from UI `type`. */
function asApi(wf: { nodes?: { id: number; type?: string }[] }): WorkflowJSON {
  const out: WorkflowJSON = {};
  for (const n of wf.nodes ?? []) {
    if (n.type) out[String(n.id)] = { class_type: n.type, inputs: {} };
  }
  return out;
}

describe("anima-inpaint ships AnimaLLLiteApply_sdscripts (#2442)", () => {
  it("apply_manifest pack: name still resolves and still clones ComfyUI-Anima-LLLite", async () => {
    const file = resolvePackManifestFile(PACK);
    expect(file, "the reported pack must resolve from the running package root").toBeTruthy();
    expect(file).toMatch(/anima-inpaint[\\/]manifest\.ya?ml$/);
    const manifest = await loadManifestFile(file!);
    expect(manifest.custom_nodes.join("\n")).toMatch(/kohya-ss\/ComfyUI-Anima-LLLite/);
  });

  it("workflow.json node 1017 is the kohya-ss class, not the stale core alias", () => {
    const parsed = loadUiWorkflow(PACK);
    expect(Array.isArray(parsed.nodes), "UI/litegraph shape").toBe(true);
    const types = parsed.nodes!.map((n) => n.type);
    expect(types, "stale AnimaLLLiteApply would resolve to core and miss the pack").not.toContain(STALE);
    expect(types).toContain(CURRENT);
    const node = parsed.nodes!.find((n) => n.id === 1017);
    expect(node, "inpaint LLLite is node 1017").toBeTruthy();
    expect(node!.type).toBe(CURRENT);
    expect(node!.widgets_values).toEqual([
      "anima-lllite-inpainting-v1.safetensors",
      1.0,
      0.0,
      1.0,
      true,
    ]);
  });

  it("the serialized workflow file itself does not quote the stale class", () => {
    const text = readFileSync(join(PACK_DIR, "workflow.json"), "utf8");
    expect(text).not.toMatch(STALE_QUOTED);
    expect(text).toContain(`"${CURRENT}"`);
  });

  it("extract_deps against live object_info aliases installs the kohya-ss pack, not core", async () => {
    const aliases = liveAliases();
    const graph = asApi(loadUiWorkflow(PACK));
    const current = await extractWorkflowDependencies(graph, makeDeps(aliases));
    expect(collectClassTypes(graph)).toContain(CURRENT);
    expect(collectClassTypes(graph)).not.toContain(STALE);

    const byType = Object.fromEntries(current.dependencies.map((d) => [d.class_type, d]));
    expect(byType[CURRENT]).toMatchObject({
      builtin: false,
      installed: true,
      pack: "ComfyUI-Anima-LLLite",
    });
    expect(current.requiredPacks).toContain("ComfyUI-Anima-LLLite");

    // The defect: the same live aliases classify the STALE name as builtin, so
    // missing-node recovery never queues ComfyUI-Anima-LLLite.
    const stale = await extractWorkflowDependencies(
      { "1017": { class_type: STALE, inputs: {} } },
      makeDeps(aliases),
    );
    expect(stale.dependencies).toEqual([
      expect.objectContaining({
        class_type: STALE,
        builtin: true,
        pack: null,
        installed: true,
        source: "object_info",
      }),
    ]);
    expect(stale.requiredPacks).not.toContain("ComfyUI-Anima-LLLite");
  });

  it("skill examples serialize the current class_type, not the stale core alias", () => {
    expect(existsSync(SKILL)).toBe(true);
    const text = readFileSync(SKILL, "utf8");
    expect(text).not.toMatch(/"class_type"\s*:\s*"AnimaLLLiteApply"/);
    expect(text).toMatch(/"class_type"\s*:\s*"AnimaLLLiteApply_sdscripts"/);
  });
});

describe("sibling anima LLLite graphs do not keep the stale class (#2442)", () => {
  it.each(LLLITE_PACKS)("%s workflow.json has no quoted AnimaLLLiteApply", (pack) => {
    const file = join(process.cwd(), "packs", pack, "workflow.json");
    expect(existsSync(file), file).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(STALE_QUOTED);
    const parsed = JSON.parse(text) as { nodes?: { type?: string }[] };
    const lllite = (parsed.nodes ?? []).filter((n) => n.type === CURRENT || n.type === STALE);
    expect(lllite.length, `${pack} must still ship an LLLite node`).toBeGreaterThan(0);
    expect(lllite.every((n) => n.type === CURRENT)).toBe(true);
  });
});
