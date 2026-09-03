// #2702 — keep the shipped WAN MultiTalk pack runnable through both install
// paths: its workflow provenance must be declared by the manifest, and its
// UMT5 filename must match the WanVideoWrapper loader's supported architecture.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadManifestFile, resolvePackManifestFile } from "../../services/manifest.js";

const PACK = "wan-multitalk";
const PACK_DIR = fileURLToPath(new URL("../../../packs/wan-multitalk/", import.meta.url));
const AUDIO_NODE_PACK_URL =
  "https://github.com/christian-byrne/audio-separation-nodes-comfyui.git";
const UMT5_FP16_FILENAME = "umt5_xxl_fp16.safetensors";
const UMT5_SCALED_FP8_FILENAME = "umt5_xxl_fp8_e4m3fn_scaled.safetensors";
const INSTALLERS = ["install-windows.bat", "install-runpod.sh"] as const;

type UiNode = {
  type?: unknown;
  properties?: {
    cnr_id?: unknown;
    aux_id?: unknown;
  };
  widgets_values?: unknown;
};

function loadWorkflow(): { nodes: UiNode[] } {
  return JSON.parse(readFileSync(`${PACK_DIR}/workflow.json`, "utf8")) as { nodes: UiNode[] };
}

function loadInstaller(name: (typeof INSTALLERS)[number]): string {
  return readFileSync(`${PACK_DIR}/${name}`, "utf8");
}

describe(`${PACK} pack (#2702)`, () => {
  it("declares every non-core audio node pack used by the workflow", async () => {
    const manifestPath = resolvePackManifestFile(PACK);
    expect(manifestPath).toMatch(/wan-multitalk[\\/]manifest\.ya?ml$/);
    const manifest = await loadManifestFile(manifestPath!);
    const customNodes = new Set(manifest.custom_nodes);

    expect(customNodes).toContain(AUDIO_NODE_PACK_URL);

    const audioNodes = loadWorkflow().nodes.filter((node) =>
      node.type === "AudioCrop" || node.type === "AudioSeparation",
    );
    expect(audioNodes).toHaveLength(2);
    expect(audioNodes.every((node) =>
      node.properties?.cnr_id === "audio-separation-nodes-comfyui" &&
      node.properties?.aux_id === "christian-byrne/audio-separation-nodes-comfyui",
    )).toBe(true);

    for (const installerName of INSTALLERS) {
      const installer = loadInstaller(installerName);
      expect(installer, installerName).toContain(AUDIO_NODE_PACK_URL);
      expect(installer, installerName).toContain(UMT5_FP16_FILENAME);
      expect(installer, installerName).not.toContain(UMT5_SCALED_FP8_FILENAME);
    }
  });

  it("uses the UMT5 fp16 model supported by the bundled wrapper loader", async () => {
    const manifestPath = resolvePackManifestFile(PACK);
    const manifest = await loadManifestFile(manifestPath!);
    const textEncoder = manifest.models.find((model) =>
      model.local_path === `text_encoders/${UMT5_FP16_FILENAME}`,
    );

    expect(textEncoder?.url).toBe(
      "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp16.safetensors",
    );

    const textEncoderNodes = loadWorkflow().nodes.filter((node) =>
      node.type === "LoadWanVideoT5TextEncoder",
    );
    expect(textEncoderNodes).toHaveLength(1);
    expect(textEncoderNodes[0]?.widgets_values).toContain(UMT5_FP16_FILENAME);
    expect(JSON.stringify(loadWorkflow())).not.toContain(UMT5_SCALED_FP8_FILENAME);
    expect(JSON.stringify(loadWorkflow())).not.toContain("t5xxl_fp16.safetensors");
  });
});
