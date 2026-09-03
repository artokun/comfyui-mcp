import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// #2499 — download_model action:"download_civitai" wrote LoRAs under
// <COMFYUI_PATH>/models/loras while extra_model_paths.yaml mapped the generic
// models root to another drive. The auto-redirect only fires when the live
// server is reachable AND argv names an absolute --extra-model-paths-config.
// These tests drive the REAL resolver + extra-paths reader: /system_stats is
// unreachable, the extra yaml is on disk, and the unit under test is not mocked.

const mockGetSystemStats = vi.hoisted(() =>
  vi.fn(async (): Promise<{ system?: { argv?: string[]; cwd?: string } }> => {
    throw new Error("ECONNREFUSED 127.0.0.1:8188");
  }),
);
const mockIsRemoteMode = vi.hoisted(() => vi.fn(() => false));

vi.mock("../../config.js", () => ({
  config: { comfyuiPath: undefined as string | undefined },
  isRemoteMode: mockIsRemoteMode,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyuiTargetGeneration: () => 0,
}));

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: (...a: unknown[]) => mockGetSystemStats(...a),
  getClient: () => ({
    fetchApi: async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:8188");
    },
  }),
  comfyApiFetch: async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:8188");
  },
  getLogs: async () => "",
}));

import { config } from "../../config.js";
import { resolveDownloadTarget } from "../../services/model-resolver.js";
import { ModelError } from "../../utils/errors.js";
import { configureWorkspace, resetWorkspaceConfig } from "../../services/workspace-env.js";

const URL_ = "https://example.invalid/lora.safetensors";
const oldComfyuiPathEnv = process.env.COMFYUI_PATH;
let dirs: string[] = [];

async function trackTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "comfyui-2499-"));
  dirs.push(dir);
  return dir;
}

function yamlPath(p: string): string {
  return p.replace(/\\/g, "/");
}

beforeEach(() => {
  config.comfyuiPath = undefined;
  delete process.env.COMFYUI_PATH;
  dirs = [];
  mockGetSystemStats.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:8188"));
  mockIsRemoteMode.mockReturnValue(false);
  configureWorkspace({ configPath: join(tmpdir(), "comfyui-mcp-no-such-workspace.json") });
});

afterEach(async () => {
  if (oldComfyuiPathEnv === undefined) delete process.env.COMFYUI_PATH;
  else process.env.COMFYUI_PATH = oldComfyuiPathEnv;
  config.comfyuiPath = undefined;
  resetWorkspaceConfig();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("#2499 extra-model root selector when the live server is unreachable", () => {
  async function installWithGenericModelsRoot(): Promise<{
    comfy: string;
    extraModels: string;
  }> {
    const comfy = await trackTmp();
    const extraModels = await trackTmp();
    await mkdir(join(comfy, "models", "loras"), { recursive: true });
    await mkdir(join(extraModels, "loras"), { recursive: true });
    await writeFile(
      join(comfy, "extra_model_paths.yaml"),
      `shared:\n  models: ${yamlPath(extraModels)}\n`,
      "utf-8",
    );
    config.comfyuiPath = comfy;
    process.env.COMFYUI_PATH = comfy;
    return { comfy, extraModels };
  }

  it("MISSES the extra root without model_root — the unreachable-server fallback", async () => {
    const { comfy, extraModels } = await installWithGenericModelsRoot();
    const res = await resolveDownloadTarget(URL_, "loras", "lora.safetensors");
    expect(res.targetDir).toBe(resolve(comfy, "models", "loras"));
    expect(res.targetDir).not.toBe(resolve(extraModels, "loras"));
  });

  it("lands in the extra models root when model_root is that known list_paths directory", async () => {
    const { extraModels } = await installWithGenericModelsRoot();
    const res = await resolveDownloadTarget(
      URL_,
      "loras",
      "lora.safetensors",
      extraModels,
    );
    expect(res.targetDir).toBe(resolve(extraModels, "loras"));
    expect(res.targetPath).toBe(resolve(extraModels, "loras", "lora.safetensors"));
  });

  it("keeps a nested remainder under the selected generic models root", async () => {
    const { extraModels } = await installWithGenericModelsRoot();
    const res = await resolveDownloadTarget(
      URL_,
      "loras/sdxl",
      "lora.safetensors",
      extraModels,
    );
    expect(res.targetDir).toBe(resolve(extraModels, "loras", "sdxl"));
  });

  it("selects a category-specific extra root listed by list_paths", async () => {
    const comfy = await trackTmp();
    const extra = await trackTmp();
    const extraLoras = join(extra, "loras");
    await mkdir(join(comfy, "models", "loras"), { recursive: true });
    await mkdir(extraLoras, { recursive: true });
    await writeFile(
      join(comfy, "extra_model_paths.yaml"),
      `shared:\n  base_path: ${yamlPath(extra)}\n  loras: loras\n`,
      "utf-8",
    );
    config.comfyuiPath = comfy;
    process.env.COMFYUI_PATH = comfy;

    const res = await resolveDownloadTarget(
      URL_,
      "loras",
      "lora.safetensors",
      extraLoras,
    );
    expect(res.targetDir).toBe(resolve(extraLoras));
  });

  it("refuses an invented path that list_paths does not name", async () => {
    await installWithGenericModelsRoot();
    const invented = resolve(await trackTmp(), "not-a-known-root");
    await expect(
      resolveDownloadTarget(URL_, "loras", "lora.safetensors", invented),
    ).rejects.toThrow(ModelError);
    const err = await resolveDownloadTarget(
      URL_,
      "loras",
      "lora.safetensors",
      invented,
    ).catch((e: Error) => e);
    expect(err.message).toMatch(/not a known model root/);
    expect(err.message).toMatch(/Do not invent a path/);
  });

  it("refuses a relative model_root", async () => {
    await installWithGenericModelsRoot();
    await expect(
      resolveDownloadTarget(URL_, "loras", "lora.safetensors", "models"),
    ).rejects.toThrow(/must be an absolute directory/);
  });

  it("refuses a custom_nodes extra path as a download destination", async () => {
    const comfy = await trackTmp();
    const extraModels = await trackTmp();
    const customNodes = await trackTmp();
    await mkdir(join(comfy, "models", "loras"), { recursive: true });
    await writeFile(
      join(comfy, "extra_model_paths.yaml"),
      [
        "shared:",
        `  models: ${yamlPath(extraModels)}`,
        `  custom_nodes: ${yamlPath(customNodes)}`,
        "",
      ].join("\n"),
      "utf-8",
    );
    config.comfyuiPath = comfy;
    process.env.COMFYUI_PATH = comfy;

    await expect(
      resolveDownloadTarget(URL_, "loras", "lora.safetensors", customNodes),
    ).rejects.toThrow(/not a known model root/);
  });

  it("refuses a category extra root that does not match the target subfolder", async () => {
    const comfy = await trackTmp();
    const extra = await trackTmp();
    const extraCheckpoints = join(extra, "checkpoints");
    await mkdir(join(comfy, "models", "loras"), { recursive: true });
    await mkdir(extraCheckpoints, { recursive: true });
    await writeFile(
      join(comfy, "extra_model_paths.yaml"),
      `shared:\n  base_path: ${yamlPath(extra)}\n  checkpoints: checkpoints\n`,
      "utf-8",
    );
    config.comfyuiPath = comfy;
    process.env.COMFYUI_PATH = comfy;

    await expect(
      resolveDownloadTarget(URL_, "loras", "lora.safetensors", extraCheckpoints),
    ).rejects.toThrow(/not "loras"/);
  });
});
