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
  // Explicit remote override. When undefined, isRemoteMode mirrors the legacy
  // "no comfyuiPath" gate; set true to model a remote target that COEXISTS with
  // a local COMFYUI_PATH (the regression issue #1 guards against).
  remote: undefined as boolean | undefined,
}));

const readFileMock = vi.hoisted(() => vi.fn());
const statMock = vi.hoisted(() => vi.fn());
const mkdirMock = vi.hoisted(() => vi.fn());
const realpathMock = vi.hoisted(() => vi.fn());
const lstatMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
const installCustomNodeMock = vi.hoisted(() => vi.fn());
const installModelViaManagerMock = vi.hoisted(() => vi.fn());
const listInstalledNodesMock = vi.hoisted(() => vi.fn());
const downloadModelMock = vi.hoisted(() => vi.fn());
const resolveExistingModelFileMock = vi.hoisted(() => vi.fn());
const listLocalModelsMock = vi.hoisted(() => vi.fn());

vi.mock("../../config.js", () => ({
  config: mockConfig,
  // apply_manifest routes models through the Manager in remote mode (no
  // comfyuiPath). isRemoteMode mirrors that gate for the tests.
  isRemoteMode: () => mockConfig.remote ?? !mockConfig.comfyuiPath,
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
  installModelViaManager: (...a: unknown[]) => installModelViaManagerMock(...a),
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
  resolveExistingModelFile: (...a: unknown[]) => resolveExistingModelFileMock(...a),
  listLocalModels: (...a: unknown[]) => listLocalModelsMock(...a),
  // Faithful mirror of the real managerModelDestination (pure logic) so the
  // remote-model path resolves a Manager-valid { type, save_path }.
  managerModelDestination: (category: string, relPath?: string) => {
    const map: Record<string, string> = {
      checkpoints: "checkpoints",
      loras: "lora",
      vae: "vae",
      upscale_models: "upscale",
      controlnet: "controlnet",
      embeddings: "embeddings",
      clip: "clip",
      diffusion_models: "diffusion_model",
      gligen: "gligen",
      text_encoders: "text_encoders",
      unet: "unet",
    };
    const type = map[category] ?? category;
    if (relPath && relPath !== category) return { type, save_path: relPath };
    if (map[category]) return { type, save_path: "default" };
    return { type, save_path: category };
  },
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  applyManifest,
  loadManifestFile,
} from "../../services/manifest.js";

beforeEach(() => {
  mockConfig.comfyuiPath = "/fake/ComfyUI";
  mockConfig.remote = undefined;
  readFileMock.mockReset();
  statMock.mockReset().mockRejectedValue(new Error("missing"));
  mkdirMock.mockReset().mockResolvedValue(undefined);
  realpathMock.mockReset().mockImplementation((path: string) => Promise.resolve(path));
  lstatMock.mockReset().mockRejectedValue(new Error("missing"));
  existsSyncMock.mockReset().mockReturnValue(false);
  execFileSyncMock.mockReset().mockReturnValue("ok");
  installCustomNodeMock.mockReset().mockResolvedValue({ message: "installed node" });
  installModelViaManagerMock
    .mockReset()
    .mockResolvedValue({ mechanism: "manager-http", message: "queued model" });
  listInstalledNodesMock.mockReset().mockResolvedValue([]);
  downloadModelMock.mockReset().mockResolvedValue("/fake/ComfyUI/models/checkpoints/m.safetensors");
  // Default: the model is found in NO root (multi-root resolver rejects, HTTP
  // listing is empty). Individual tests override to simulate an existing model.
  resolveExistingModelFileMock.mockReset().mockRejectedValue(new Error("not found"));
  listLocalModelsMock.mockReset().mockResolvedValue([]);
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

  it("reports a custom_node as FAILED when Manager queued it but it isn't present afterward", async () => {
    // ComfyUI-Manager drains the queue "done" for a git URL not in its registry
    // even though nothing was cloned. installCustomNode resolves, but the
    // post-install verification (listInstalledNodes) must catch the no-op.
    installCustomNodeMock.mockResolvedValueOnce({
      message: "Queued + installed via ComfyUI-Manager.",
    });
    listInstalledNodesMock.mockResolvedValue([]); // never shows up — clone no-op'd

    const result = await applyManifest({
      manifest: {
        custom_nodes: ["https://github.com/capitan01R/ComfyUI-Krea2T-Enhancer"],
        models: [],
      },
    });

    expect(result.summary).toMatchObject({ applied: 0, failed: 1 });
    expect(result.results[0]).toMatchObject({
      action: "custom_node",
      status: "failed",
    });
    expect(result.results[0].message).toMatch(/not present afterward/i);
  });

  it("reports a custom_node as APPLIED only after verifying it's actually installed", async () => {
    installCustomNodeMock.mockResolvedValueOnce({
      message: "Queued + installed via ComfyUI-Manager.",
    });
    listInstalledNodesMock
      .mockResolvedValueOnce([]) // pre-install skip-check: not yet installed
      .mockResolvedValueOnce([
        { module: "comfyui-krea2t-enhancer", enabled: true },
      ]); // verification: the freshly-cloned node now shows on disk

    const result = await applyManifest({
      manifest: {
        custom_nodes: ["https://github.com/capitan01R/ComfyUI-Krea2T-Enhancer"],
        models: [],
      },
    });

    expect(result.summary).toMatchObject({ applied: 1, failed: 0 });
    expect(result.results[0]).toMatchObject({
      action: "custom_node",
      status: "applied",
    });
  });

  it("skips a model already present in an ALTERNATE model root (extra_model_paths)", async () => {
    // The computed target under <COMFYUI_PATH>/models does NOT exist (statMock
    // rejects by default), but the user already has the file under an extra root
    // declared in extra_model_paths.yaml (e.g. another drive). The multi-root
    // resolver finds it, so we must skip — not re-download.
    const altPath = "E:/AImodels/checkpoints/big.safetensors";
    resolveExistingModelFileMock.mockResolvedValueOnce({
      path: altPath,
      root: "E:/AImodels",
      info: { isFile: () => true },
    });

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/big.safetensors",
            model_type: "checkpoints",
            filename: "big.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toEqual({ applied: 0, skipped: 1, failed: 0 });
    expect(result.results).toMatchObject([
      { action: "model", status: "skipped", item: "big.safetensors" },
    ]);
    expect(result.results[0].message).toContain(altPath);
    expect(resolveExistingModelFileMock).toHaveBeenCalledWith(
      "checkpoints/big.safetensors",
    );
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  it("skips a CATEGORY-ROOT target found by filename anywhere in the served category", async () => {
    // model_type: checkpoints (category-root target). Not at the computed path
    // nor the exact relative path in any root, but ComfyUI serves it from a
    // nested subfolder within the category. Basename-anywhere match → skip.
    listLocalModelsMock.mockResolvedValueOnce([
      { name: "sdxl/big.safetensors", path: "checkpoints/sdxl/big.safetensors", type: "checkpoints" },
    ]);

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/big.safetensors",
            model_type: "checkpoints",
            filename: "big.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toEqual({ applied: 0, skipped: 1, failed: 0 });
    expect(result.results[0].status).toBe("skipped");
    expect(listLocalModelsMock).toHaveBeenCalledWith("checkpoints");
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  it("skips a NESTED local_path model present at the exact category-relative path", async () => {
    // Nested target asks for checkpoints/foo/model.safetensors and ComfyUI
    // serves exactly that (foo/model.safetensors within checkpoints) → skip.
    listLocalModelsMock.mockResolvedValueOnce([
      { name: "foo/model.safetensors", path: "checkpoints/foo/model.safetensors", type: "checkpoints" },
    ]);

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/model.safetensors",
            local_path: "checkpoints/foo/model.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toEqual({ applied: 0, skipped: 1, failed: 0 });
    expect(result.results[0].status).toBe("skipped");
    expect(listLocalModelsMock).toHaveBeenCalledWith("checkpoints");
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  it("downloads a NESTED local_path when only a same-named file in a DIFFERENT subfolder exists", async () => {
    // Manifest wants checkpoints/foo/model.safetensors but only
    // checkpoints/bar/model.safetensors exists. A basename match would
    // false-skip and leave the requested file absent — must still download.
    listLocalModelsMock.mockResolvedValueOnce([
      { name: "bar/model.safetensors", path: "checkpoints/bar/model.safetensors", type: "checkpoints" },
    ]);

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/model.safetensors",
            local_path: "checkpoints/foo/model.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toEqual({ applied: 1, skipped: 0, failed: 0 });
    expect(downloadModelMock).toHaveBeenCalledWith(
      "https://example.com/model.safetensors",
      expect.stringMatching(/checkpoints[\\/]foo/),
      "model.safetensors",
    );
  });

  it("downloads when the model exists in NO root (multi-root check graceful miss)", async () => {
    // resolveExistingModelFile rejects and listLocalModels is empty (defaults):
    // the model is genuinely absent everywhere, so we must download it.
    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/new.safetensors",
            model_type: "loras",
            filename: "new.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toEqual({ applied: 1, skipped: 0, failed: 0 });
    expect(downloadModelMock).toHaveBeenCalledWith(
      "https://example.com/new.safetensors",
      "loras",
      "new.safetensors",
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

  describe("remote mode (no COMFYUI_PATH) — per-section handling", () => {
    beforeEach(() => {
      mockConfig.comfyuiPath = undefined;
    });

    it("does not throw up-front; routes each section by mode", async () => {
      installCustomNodeMock.mockResolvedValueOnce({ message: "installed node" });
      // First check: not installed yet. After install: present → "applied".
      listInstalledNodesMock
        .mockResolvedValueOnce([])
        .mockResolvedValue([{ module: "x", enabled: true }]);

      const result = await applyManifest({
        manifest: {
          apt: ["ffmpeg"],
          pip: ["numpy"],
          custom_nodes: ["x"],
          models: [
            {
              url: "https://example.com/model.safetensors",
              model_type: "checkpoints",
              filename: "model.safetensors",
            },
          ],
        },
      });

      const byAction = Object.fromEntries(
        result.results.map((r) => [r.action, r]),
      );
      // apt + pip are unsupported remotely → skipped, never executed.
      expect(byAction.apt.status).toBe("skipped");
      expect(byAction.pip.status).toBe("skipped");
      expect(execFileSyncMock).not.toHaveBeenCalled();
      // custom_nodes still go through the Manager HTTP install (remote-ok).
      expect(installCustomNodeMock).toHaveBeenCalledWith({ id: "x" });
      // models route through installModelViaManager, NOT the local downloadModel.
      expect(downloadModelMock).not.toHaveBeenCalled();
      expect(installModelViaManagerMock).toHaveBeenCalledWith({
        name: "model.safetensors",
        url: "https://example.com/model.safetensors",
        filename: "model.safetensors",
        type: "checkpoints",
        save_path: "default",
      });
      expect(byAction.model.status).toBe("applied");
    });

    it("derives type + save_path from a nested model local_path", async () => {
      await applyManifest({
        manifest: {
          models: [
            {
              url: "https://example.com/lora.safetensors",
              local_path: "loras/pusa/lora.safetensors",
            },
          ],
        },
      });

      // Nested local_path → explicit save_path verbatim; our "loras" category
      // maps to Manager's singular "lora" type key; name falls back to filename.
      expect(installModelViaManagerMock).toHaveBeenCalledWith({
        name: "lora.safetensors",
        url: "https://example.com/lora.safetensors",
        filename: "lora.safetensors",
        type: "lora",
        save_path: "loras/pusa",
      });
    });
  });

  describe("remote mode while a local COMFYUI_PATH is also set (issue #1 regression)", () => {
    beforeEach(() => {
      // A remote target coexists with an unrelated local install path. The
      // local/remote split must key off isRemoteMode(), NOT comfyuiPath presence.
      mockConfig.comfyuiPath = "/fake/ComfyUI";
      mockConfig.remote = true;
    });

    it("routes pip + models remotely and never touches the local install/disk", async () => {
      const result = await applyManifest({
        manifest: {
          pip: ["numpy"],
          models: [
            {
              url: "https://example.com/model.safetensors",
              model_type: "checkpoints",
              filename: "model.safetensors",
            },
          ],
        },
      });

      const byAction = Object.fromEntries(
        result.results.map((r) => [r.action, r]),
      );
      // pip has no remote equivalent → skipped, never shelled out locally.
      expect(byAction.pip.status).toBe("skipped");
      expect(execFileSyncMock).not.toHaveBeenCalled();
      // Model goes through the Manager (remote), NOT the local downloadModel,
      // and the local model-existence check is skipped entirely.
      expect(downloadModelMock).not.toHaveBeenCalled();
      expect(resolveExistingModelFileMock).not.toHaveBeenCalled();
      expect(installModelViaManagerMock).toHaveBeenCalledWith({
        name: "model.safetensors",
        url: "https://example.com/model.safetensors",
        filename: "model.safetensors",
        type: "checkpoints",
        save_path: "default",
      });
      expect(byAction.model.status).toBe("applied");
    });
  });
});
