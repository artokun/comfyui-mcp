// #2525 — krea2-identity-edit shipped LoraLoaderModelOnly.lora_name as
// Krea2\krea2_identity_edit_v1_2.safetensors (a Windows export). Linux ComfyUI
// publishes the same file as Krea2/krea2_identity_edit_v1_2.safetensors, so
// apply_manifest can install it and panel_get_errors still reports missing_asset
// on node 71. ComfyUI combo validation is an exact string match.
//
// Pin the SHIPPED workflow.json widget (and the notes that describe it). The
// files apply_manifest / panel_load_workflow actually consume — not a fixture.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadManifestFile, resolvePackManifestFile } from "../../services/manifest.js";

const PACK = "krea2-identity-edit";
const PACK_DIR = join(process.cwd(), "packs", PACK);
const LORA_FILE = "krea2_identity_edit_v1_2.safetensors";
const POSIX_WIDGET = `Krea2/${LORA_FILE}`;
const WINDOWS_WIDGET = `Krea2\\${LORA_FILE}`;
const WINDOWS_JSON = `Krea2\\\\${LORA_FILE}`;

function loadUiWorkflow() {
  const file = join(PACK_DIR, "workflow.json");
  expect(existsSync(file), file).toBe(true);
  return JSON.parse(readFileSync(file, "utf8")) as {
    nodes?: { id: number; type?: string; widgets_values?: unknown[] }[];
  };
}

describe("krea2-identity-edit ships a POSIX LoRA widget path (#2525)", () => {
  it("apply_manifest pack: name still resolves and still installs into loras/Krea2/", async () => {
    const file = resolvePackManifestFile(PACK);
    expect(file, "the reported pack must resolve from the running package root").toBeTruthy();
    expect(file).toMatch(/krea2-identity-edit[\\/]manifest\.ya?ml$/);
    const manifest = await loadManifestFile(file!);
    const lora = manifest.models.find((m) => m.local_path?.endsWith(LORA_FILE));
    expect(lora, "manifest still downloads the Identity Edit LoRA").toBeTruthy();
    expect(lora!.local_path).toBe(`loras/Krea2/${LORA_FILE}`);
  });

  it("workflow.json node 71 is LoraLoaderModelOnly with the POSIX combo value", () => {
    const parsed = loadUiWorkflow();
    expect(Array.isArray(parsed.nodes), "UI/litegraph shape").toBe(true);
    const node = parsed.nodes!.find((n) => n.id === 71);
    expect(node, "Identity Edit LoRA is node 71").toBeTruthy();
    expect(node!.type).toBe("LoraLoaderModelOnly");
    expect(node!.widgets_values?.[0]).toBe(POSIX_WIDGET);
    expect(node!.widgets_values?.[0]).not.toBe(WINDOWS_WIDGET);
    expect(String(node!.widgets_values?.[0])).not.toContain("\\");
    expect(node!.widgets_values).toEqual([POSIX_WIDGET, 1]);
  });

  it("the serialized workflow file itself does not encode a Windows LoRA path", () => {
    const text = readFileSync(join(PACK_DIR, "workflow.json"), "utf8");
    // JSON encodes a real backslash as \\. The unfixed pack stored that encoding,
    // which Linux combo options never match.
    expect(text).not.toContain(WINDOWS_JSON);
    expect(text).toContain(POSIX_WIDGET);
  });

  it("pack notes describe the POSIX widget path, not the Windows export", () => {
    const packYaml = readFileSync(join(PACK_DIR, "pack.yaml"), "utf8");
    const manifestYaml = readFileSync(join(PACK_DIR, "manifest.yaml"), "utf8");
    expect(packYaml).toContain(`"${POSIX_WIDGET}"`);
    expect(packYaml).not.toContain(WINDOWS_WIDGET);
    expect(manifestYaml).toContain(`\`${POSIX_WIDGET}\``);
    expect(manifestYaml).not.toContain(WINDOWS_WIDGET);
  });
});
