import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const IS_WIN = process.platform === "win32";
// The product (manifest.ts) detects an executable on Windows with
// `where <cmd>` and on POSIX with `<cmd> --version`. Mirror that here so the
// detection assertion passes on both platforms.
const detectCmd = IS_WIN ? "where" : "uv";
const detectArgs = IS_WIN ? ["uv"] : ["--version"];
const COMFY = "/fake/ComfyUI";

const mockConfig = vi.hoisted(() => ({
  comfyuiPath: "/fake/ComfyUI" as string | undefined,
}));

const readFileMock = vi.hoisted(() => vi.fn());
const statMock = vi.hoisted(() => vi.fn());
const mkdirMock = vi.hoisted(() => vi.fn());
const realpathMock = vi.hoisted(() => vi.fn());
const lstatMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
const installCustomNodeMock = vi.hoisted(() => vi.fn());
const listInstalledNodesMock = vi.hoisted(() => vi.fn());
const downloadModelMock = vi.hoisted(() => vi.fn());

vi.mock("../../config.js", () => ({
  config: mockConfig,
}));

vi.mock("node:fs/promises", () => ({
  lstat: (...a: unknown[]) => lstatMock(...a),
  mkdir: (...a: unknown[]) => mkdirMock(...a),
  readFile: (...a: unknown[]) => readFileMock(...a),
  realpath: (...a: unknown[]) => realpathMock(...a),
  stat: (...a: unknown[]) => statMock(...a),
}));

vi.mock("node:fs", () => ({
  existsSync: (...a: unknown[]) => existsSyncMock(...a),
}));

vi.mock("node:child_process", () => ({
  execFileSync: (...a: unknown[]) => execFileSyncMock(...a),
}));

vi.mock("../../services/node-management.js", () => ({
  installCustomNode: (...a: unknown[]) => installCustomNodeMock(...a),
  listInstalledNodes: (...a: unknown[]) => listInstalledNodesMock(...a),
}));

vi.mock("../../services/model-resolver.js", () => ({
  MODEL_SUBDIRS: [
    "checkpoints",
    "loras",
    "vae",
    "upscale_models",
    "controlnet",
    "embeddings",
    "clip",
    "diffusers",
    "diffusion_models",
    "gligen",
    "hypernetworks",
    "photomaker",
    "style_models",
    "text_encoders",
    "unet",
  ],
  downloadModel: (...a: unknown[]) => downloadModelMock(...a),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  applyManifest,
  loadManifestFile,
} from "../../services/manifest.js";
import { ProcessControlError } from "../../utils/errors.js";

beforeEach(() => {
  mockConfig.comfyuiPath = "/fake/ComfyUI";
  readFileMock.mockReset();
  statMock.mockReset().mockRejectedValue(new Error("missing"));
  mkdirMock.mockReset().mockResolvedValue(undefined);
  realpathMock.mockReset().mockImplementation((path: string) => Promise.resolve(path));
  lstatMock.mockReset().mockRejectedValue(new Error("missing"));
  existsSyncMock.mockReset().mockReturnValue(false);
  execFileSyncMock.mockReset().mockReturnValue("ok");
  installCustomNodeMock.mockReset().mockResolvedValue({ message: "installed node" });
  listInstalledNodesMock.mockReset().mockResolvedValue([]);
  downloadModelMock.mockReset().mockResolvedValue("/fake/ComfyUI/models/checkpoints/m.safetensors");
});

describe("loadManifestFile", () => {
  it("parses JSON manifests", async () => {
    statMock.mockResolvedValueOnce({ size: 128 });
    readFileMock.mockResolvedValueOnce(JSON.stringify({
      pip: ["numpy"],
      custom_nodes: ["comfyui-impact-pack"],
    }));

    await expect(loadManifestFile("/tmp/manifest.json")).resolves.toMatchObject({
      pip: ["numpy"],
      custom_nodes: ["comfyui-impact-pack"],
      apt: [],
      models: [],
    });
  });

  it("parses YAML manifests", async () => {
    statMock.mockResolvedValueOnce({ size: 128 });
    readFileMock.mockResolvedValueOnce(
      [
        "apt:",
        "  - ffmpeg",
        "models:",
        "  - url: https://example.com/model.safetensors",
        "    model_type: loras",
      ].join("\n"),
    );

    await expect(loadManifestFile("/tmp/manifest.yaml")).resolves.toMatchObject({
      apt: ["ffmpeg"],
      models: [{ url: "https://example.com/model.safetensors", model_type: "loras" }],
    });
  });

  it("rejects oversized manifest files before reading", async () => {
    statMock.mockResolvedValueOnce({ size: 1024 * 1024 + 1 });

    await expect(loadManifestFile("/tmp/manifest.yaml")).rejects.toThrow(/too large/i);
    expect(readFileMock).not.toHaveBeenCalled();
  });
});

describe("applyManifest", () => {
  it("skips apt entries and already-detected custom nodes/models", async () => {
    listInstalledNodesMock.mockResolvedValueOnce([
      { module: "ComfyUI-Impact-Pack", cnrId: "comfyui-impact-pack", enabled: true },
    ]);
    statMock.mockResolvedValueOnce({ isFile: () => true });

    const result = await applyManifest({
      manifest: {
        apt: ["ffmpeg"],
        custom_nodes: ["comfyui-impact-pack"],
        models: [
          {
            url: "https://example.com/model.safetensors",
            model_type: "checkpoints",
            filename: "model.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toEqual({ applied: 0, skipped: 3, failed: 0 });
    expect(result.results.map((r) => r.status)).toEqual(["skipped", "skipped", "skipped"]);
    expect(installCustomNodeMock).not.toHaveBeenCalled();
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  it("continues after individual failures and reports each item", async () => {
    installCustomNodeMock.mockRejectedValueOnce(new Error("node failed"));
    downloadModelMock.mockResolvedValueOnce("/fake/ComfyUI/models/loras/model.safetensors");

    const result = await applyManifest({
      manifest: {
        custom_nodes: ["bad-node"],
        models: [
          {
            url: "https://example.com/model.safetensors",
            local_path: "loras/model.safetensors",
          },
        ],
      },
    });

    expect(result.success).toBe(false);
    expect(result.summary).toEqual({ applied: 1, skipped: 0, failed: 1 });
    expect(result.results).toMatchObject([
      { action: "custom_node", item: "bad-node", status: "failed" },
      { action: "model", item: "loras/model.safetensors", status: "applied" },
    ]);
    expect(downloadModelMock).toHaveBeenCalledWith(
      "https://example.com/model.safetensors",
      "loras",
      "model.safetensors",
    );
  });

  it("installs pip entries via uv when available", async () => {
    execFileSyncMock.mockReturnValue("ok");

    const result = await applyManifest({
      manifest: { pip: ["torch==2.4.0"] },
    });

    expect(result.summary).toEqual({ applied: 1, skipped: 0, failed: 0 });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      detectCmd,
      detectArgs,
      expect.objectContaining({ stdio: "ignore" }),
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "uv",
      ["pip", "install", "--python", expect.stringMatching(/python/), "torch==2.4.0"],
      expect.objectContaining({ cwd: COMFY }),
    );
  });

  it("falls back to python -m pip when uv is unavailable", async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      // Make `uv` detection fail on both platforms: POSIX probes with
      // `uv --version`; Windows probes with `where uv`.
      const probesUv = IS_WIN
        ? cmd === "where" && args[0] === "uv"
        : cmd === "uv" && args[0] === "--version";
      if (probesUv) throw new Error("no uv");
      return "ok";
    });

    await applyManifest({ manifest: { pip: ["numpy"] } });

    expect(execFileSyncMock).toHaveBeenCalledWith(
      expect.stringMatching(/python/),
      ["-m", "pip", "install", "numpy"],
      expect.objectContaining({ cwd: COMFY }),
    );
  });

  it.each([
    ["--index-url=evil"],
    ["-r/etc/passwd"],
    ["numpy\u0000"],
  ])("rejects unsafe pip entry %s before invoking pip", async (pkg) => {
    const result = await applyManifest({ manifest: { pip: [pkg] } });

    expect(result.success).toBe(false);
    expect(result.results).toMatchObject([
      { action: "pip", item: pkg, status: "failed" },
    ]);
    expect(execFileSyncMock).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["install", pkg]),
      expect.any(Object),
    );
  });

  it("rejects model local_path when a symlinked parent escapes models", async () => {
    // The product resolves these paths with node:path, yielding
    // backslash-separated absolute paths on Windows. Build the mock keys the
    // same way so they match what the product passes to realpath.
    const modelsDir = resolve(COMFY, "models");
    const linkDir = join(modelsDir, "link");
    const outside = resolve("/tmp/outside");
    realpathMock.mockImplementation((path: string) => {
      if (path === modelsDir) return Promise.resolve(modelsDir);
      if (path === linkDir) return Promise.resolve(outside);
      return Promise.resolve(path);
    });

    const result = await applyManifest({
      manifest: {
        models: [{ url: "https://example.com/model.safetensors", local_path: "link/model.safetensors" }],
      },
    });

    expect(result.success).toBe(false);
    expect(result.results).toMatchObject([
      { action: "model", status: "failed", item: "link/model.safetensors" },
    ]);
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  it("errors clearly in remote mode", async () => {
    mockConfig.comfyuiPath = undefined;

    await expect(
      applyManifest({ manifest: { custom_nodes: ["x"] } }),
    ).rejects.toBeInstanceOf(ProcessControlError);
  });
});
