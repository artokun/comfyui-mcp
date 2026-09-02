import { describe, expect, it, beforeEach, vi } from "vitest";
import { resolve } from "node:path";

// Control config (comfyuiPath) per test. isRemoteMode is a controllable mock:
// resolveEffectiveComfyUIBase() consults it only when comfyuiPath is unset, to
// decide whether a local default-workspace fallback is allowed (never in remote
// mode). Shared via vi.hoisted so the config.js and workspace-env.js mocks agree
// (resolveEffectiveComfyUIBase now backs resolveComfyUIBase and must see the same
// config + isRemoteMode + saved-workspace state the tests mutate).
const h = vi.hoisted(() => ({
  config: {
    comfyuiPath: "/comfy" as string | undefined,
    huggingfaceToken: undefined as string | undefined,
    civitaiApiToken: undefined as string | undefined,
  },
  isRemoteMode: vi.fn<() => boolean>(() => false),
  getSaved: vi.fn<() => string | undefined>(() => undefined),
}));
vi.mock("../../config.js", () => ({
  config: h.config,
  isRemoteMode: h.isRemoteMode,
}));

// Saved default workspace (set via workspace action:"set_default") — the local fallback
// resolveEffectiveComfyUIBase() uses when COMFYUI_PATH is unset and we're not
// remote. The shared helper replicates the real resolution order here.
const getSavedDefaultWorkspaceSyncMock = h.getSaved;
vi.mock("../../services/workspace-env.js", () => ({
  getSavedDefaultWorkspaceSync: h.getSaved,
  resolveEffectiveComfyUIBase: () =>
    h.config.comfyuiPath ?? (h.isRemoteMode() ? undefined : h.getSaved()),
}));

const resolveModelsDirWithBasesMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/output-dir.js", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("../../services/output-dir.js");
  return {
    resolveModelsDirWithBases: (...a: unknown[]) => resolveModelsDirWithBasesMock(...a),
    isLiveAuthoritativeModelsDir: real.isLiveAuthoritativeModelsDir,
    modelsDirNamedByServer: real.modelsDirNamedByServer,
    parseModelsDirFromArgv: real.parseModelsDirFromArgv,
    parseExtraModelPathsConfigsFromArgvRaw: real.parseExtraModelPathsConfigsFromArgvRaw,
    hasUnresolvableRelativeModelDirFlag: real.hasUnresolvableRelativeModelDirFlag,
  };
});

// node:fs/promises is mocked so stat answers per-path from a fixture map.
const statMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  copyFile: vi.fn(),
  link: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  stat: (...a: unknown[]) => statMock(...a),
  utimes: vi.fn(),
  unlink: vi.fn(),
}));

// Extra roots are injected; no real config file is read.
const getExtraModelRootsMock = vi.fn();
const getLiveExtraModelRootsMock = vi.fn();
const getLaunchStateExtraModelRootsMock = vi.fn();
vi.mock("../../services/extra-paths.js", () => ({
  getExtraModelRoots: (...a: unknown[]) => getExtraModelRootsMock(...a),
  getLiveExtraModelRoots: (...a: unknown[]) => getLiveExtraModelRootsMock(...a),
  getLaunchStateExtraModelRoots: (...a: unknown[]) => getLaunchStateExtraModelRootsMock(...a),
}));

import { config, isRemoteMode } from "../../config.js";
import { resolveExistingModelFile } from "../../services/model-resolver.js";
import { ModelError, ValidationError } from "../../utils/errors.js";

const MODELS_ROOT = resolve("/comfy", "models");
const EXTRA_LORAS = "E:/extra-drive/loras";
const LIVE_SHARED_MODELS_ROOT = resolve("/ComfyUI-Shared/models");

const resolveForRemoval = (path: string) =>
  resolveExistingModelFile(path, { mode: "remove" });

/** stat() resolves to a file for paths in `files`, a dir for `dirs`, else ENOENT. */
function fsFixture(files: string[], dirs: string[] = []) {
  const fileSet = new Set(files.map((p) => resolve(p)));
  const dirSet = new Set(dirs.map((p) => resolve(p)));
  statMock.mockImplementation(async (p: string) => {
    const key = resolve(p);
    if (fileSet.has(key)) return { isFile: () => true, size: 1234 };
    if (dirSet.has(key)) return { isFile: () => false, size: 0 };
    throw new Error("ENOENT");
  });
}

beforeEach(() => {
  statMock.mockReset();
  getExtraModelRootsMock.mockReset();
  getExtraModelRootsMock.mockResolvedValue([]);
  getLiveExtraModelRootsMock.mockReset();
  getLiveExtraModelRootsMock.mockResolvedValue({ authoritative: false, roots: [] });
  getLaunchStateExtraModelRootsMock.mockReset();
  getLaunchStateExtraModelRootsMock.mockResolvedValue({ authoritative: false, roots: [] });
  resolveModelsDirWithBasesMock.mockReset();
  resolveModelsDirWithBasesMock.mockResolvedValue({
    modelsDir: MODELS_ROOT,
    baseDirs: [],
    snapshot: { reachable: false },
    source: "configured-base",
  });
  config.comfyuiPath = "/comfy";
  vi.mocked(isRemoteMode).mockReturnValue(false);
  getSavedDefaultWorkspaceSyncMock.mockReset();
  getSavedDefaultWorkspaceSyncMock.mockReturnValue(undefined);
});

describe("resolveExistingModelFile — multi-root resolution", () => {
  it("finds a model under the primary models/ root", async () => {
    fsFixture([resolve(MODELS_ROOT, "checkpoints/a.safetensors")]);

    const res = await resolveExistingModelFile("checkpoints/a.safetensors");

    expect(res.path).toBe(resolve(MODELS_ROOT, "checkpoints/a.safetensors"));
    expect(res.root).toBe(MODELS_ROOT);
    expect(res.info.isFile()).toBe(true);
    // Primary hit short-circuits before extra roots are queried.
    expect(getExtraModelRootsMock).not.toHaveBeenCalled();
  });

  it("finds a model under an extra_model_paths root (e.g. another drive)", async () => {
    getExtraModelRootsMock.mockResolvedValue([
      { category: "loras", dir: EXTRA_LORAS, group: "comfyui" },
    ]);
    // Absent from primary, present on the extra drive.
    fsFixture([resolve(EXTRA_LORAS, "cool.safetensors")]);

    const res = await resolveExistingModelFile("loras/cool.safetensors");

    expect(res.path).toBe(resolve(EXTRA_LORAS, "cool.safetensors"));
    expect(res.root).toBe(resolve(EXTRA_LORAS));
    expect(res.info.isFile()).toBe(true);
    expect(getExtraModelRootsMock).toHaveBeenCalledTimes(1);
  });

  it("keeps read-only lookup on configured roots when a reachable seam has no launch evidence", async () => {
    const sharedRoot = resolve("/ComfyUI-Shared/models/diffusion_models");
    resolveModelsDirWithBasesMock.mockResolvedValueOnce({
      modelsDir: MODELS_ROOT,
      baseDirs: [],
      snapshot: { reachable: true },
      source: "configured-base",
    });
    getExtraModelRootsMock.mockResolvedValueOnce([
      { category: "diffusion_models", dir: sharedRoot, group: "current-config" },
    ]);
    fsFixture([resolve(sharedRoot, "Chroma/chroma.safetensors")]);

    const res = await resolveExistingModelFile("diffusion_models/Chroma/chroma.safetensors");

    expect(res.path).toBe(resolve(sharedRoot, "Chroma/chroma.safetensors"));
    expect(getExtraModelRootsMock).toHaveBeenCalledTimes(1);
    expect(resolveModelsDirWithBasesMock).not.toHaveBeenCalled();
    expect(getLaunchStateExtraModelRootsMock).not.toHaveBeenCalled();
  });

  it("prefers a connected live primary root over a stale local primary root", async () => {
    const snapshot = {
      reachable: true,
      argv: ["python", "ComfyUI/main.py"],
    };
    const liveModel = resolve(
      LIVE_SHARED_MODELS_ROOT,
      "diffusion_models/Chroma/chroma.safetensors",
    );
    const staleModel = resolve(
      MODELS_ROOT,
      "diffusion_models/Chroma/chroma.safetensors",
    );
    resolveModelsDirWithBasesMock.mockResolvedValueOnce({
      modelsDir: LIVE_SHARED_MODELS_ROOT,
      baseDirs: [],
      snapshot,
      source: "live-root",
    });
    fsFixture([liveModel, staleModel]);

    const res = await resolveForRemoval("diffusion_models/Chroma/chroma.safetensors");

    expect(res.path).toBe(liveModel);
    expect(res.root).toBe(LIVE_SHARED_MODELS_ROOT);
    expect(statMock).toHaveBeenCalledWith(liveModel);
    expect(getLaunchStateExtraModelRootsMock).toHaveBeenCalledWith(snapshot);
    expect(getLiveExtraModelRootsMock).not.toHaveBeenCalled();
    expect(getExtraModelRootsMock).not.toHaveBeenCalled();
  });

  it("finds a category-relative model in a launch-named shared extra root", async () => {
    const sharedRoot = resolve("/ComfyUI-Shared/models/diffusion_models");
    const snapshot = {
      reachable: true,
      argv: [
        "python",
        "ComfyUI/main.py",
        "--extra-model-paths-config",
        "/live/shared_model_paths.yaml",
      ],
      processStartedAtMs: 1_000,
    };
    resolveModelsDirWithBasesMock.mockResolvedValueOnce({
      modelsDir: resolve("/stale/ComfyUI", "models"),
      baseDirs: [],
      snapshot,
      source: "configured-base",
    });
    getLaunchStateExtraModelRootsMock.mockResolvedValueOnce({
      authoritative: true,
      roots: [{ category: "diffusion_models", dir: sharedRoot, group: "desktop" }],
    });
    fsFixture([resolve(sharedRoot, "Chroma/chroma.safetensors")]);

    const res = await resolveForRemoval("diffusion_models/Chroma/chroma.safetensors");

    expect(res.path).toBe(resolve(sharedRoot, "Chroma/chroma.safetensors"));
    expect(res.root).toBe(sharedRoot);
    expect(getLaunchStateExtraModelRootsMock).toHaveBeenCalledWith(snapshot);
    expect(getLiveExtraModelRootsMock).not.toHaveBeenCalled();
    expect(getExtraModelRootsMock).not.toHaveBeenCalled();
  });

  it("does not unlink from a stale configured primary or mutable current extra root", async () => {
    const staleExtraRoot = resolve("/mutable/current/diffusion_models");
    const snapshot = {
      reachable: true,
      argv: ["python", "ComfyUI/main.py", "--extra-model-paths-config", "/live/launch.yaml"],
      processStartedAtMs: 1_000,
    };
    resolveModelsDirWithBasesMock.mockResolvedValueOnce({
      modelsDir: MODELS_ROOT,
      baseDirs: [],
      snapshot,
      source: "configured-base",
    });
    getExtraModelRootsMock.mockResolvedValueOnce([
      { category: "diffusion_models", dir: staleExtraRoot, group: "mutable-current-config" },
    ]);
    getLaunchStateExtraModelRootsMock.mockResolvedValueOnce({ authoritative: false, roots: [] });
    fsFixture([
      resolve(MODELS_ROOT, "diffusion_models/Chroma/chroma.safetensors"),
      resolve(staleExtraRoot, "Chroma/chroma.safetensors"),
    ]);

    await expect(
      resolveForRemoval("diffusion_models/Chroma/chroma.safetensors"),
    ).rejects.toThrow(/Searched 0 root\(s\)/);
    expect(getLaunchStateExtraModelRootsMock).toHaveBeenCalledWith(snapshot);
    expect(getExtraModelRootsMock).not.toHaveBeenCalled();
  });

  it("does not treat an OS-observed root as deletion authority", async () => {
    const observedRootModel = resolve(
      LIVE_SHARED_MODELS_ROOT,
      "diffusion_models/Chroma/chroma.safetensors",
    );
    const snapshot = {
      reachable: true,
      argv: ["python", "ComfyUI/main.py"],
      processStartedAtMs: 1_000,
    };
    resolveModelsDirWithBasesMock.mockResolvedValueOnce({
      modelsDir: LIVE_SHARED_MODELS_ROOT,
      baseDirs: [],
      snapshot,
      source: "observed-root",
    });
    fsFixture([observedRootModel]);

    await expect(
      resolveForRemoval("diffusion_models/Chroma/chroma.safetensors"),
    ).rejects.toThrow(/Searched 0 root\(s\)/);
    expect(statMock).not.toHaveBeenCalledWith(observedRootModel);
    expect(getLaunchStateExtraModelRootsMock).toHaveBeenCalledWith(snapshot);
  });

  it("ignores extra roots for a different category", async () => {
    getExtraModelRootsMock.mockResolvedValue([
      { category: "checkpoints", dir: "E:/extra-drive/checkpoints", group: "comfyui" },
    ]);
    fsFixture([resolve(EXTRA_LORAS, "cool.safetensors")]); // only the loras drive has it

    await expect(
      resolveExistingModelFile("loras/cool.safetensors"),
    ).rejects.toBeInstanceOf(ModelError);
  });

  it("throws a clear not-found error listing the roots searched", async () => {
    getExtraModelRootsMock.mockResolvedValue([
      { category: "loras", dir: EXTRA_LORAS, group: "comfyui" },
    ]);
    fsFixture([]); // nothing exists anywhere

    await expect(
      resolveExistingModelFile("loras/missing.safetensors"),
    ).rejects.toThrow(/not found/i);
    // Both the primary and the matching extra root are reported.
    await expect(
      resolveExistingModelFile("loras/missing.safetensors"),
    ).rejects.toThrow(/loras/);
  });

  it("rejects absolute paths before any filesystem access", async () => {
    await expect(
      resolveExistingModelFile("E:/secret/x.safetensors"),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(statMock).not.toHaveBeenCalled();
  });

  it("rejects traversal escapes even when extra roots exist", async () => {
    getExtraModelRootsMock.mockResolvedValue([
      { category: "loras", dir: EXTRA_LORAS, group: "comfyui" },
    ]);
    await expect(
      resolveExistingModelFile("loras/../../../etc/passwd"),
    ).rejects.toThrow(/outside the models directory/);
  });

  it("errors clearly when COMFYUI_PATH is unset (remote mode)", async () => {
    config.comfyuiPath = undefined;
    vi.mocked(isRemoteMode).mockReturnValue(true);
    // Remote mode never falls back to a local workspace, even if one is saved.
    getSavedDefaultWorkspaceSyncMock.mockReturnValue("/saved-ws");
    await expect(
      resolveExistingModelFile("loras/x.safetensors"),
    ).rejects.toThrow(/COMFYUI_PATH/);
  });

  it("falls back to the saved default workspace when COMFYUI_PATH is unset (local mode)", async () => {
    config.comfyuiPath = undefined;
    vi.mocked(isRemoteMode).mockReturnValue(false);
    getSavedDefaultWorkspaceSyncMock.mockReturnValue("/saved-ws");
    const savedRoot = resolve("/saved-ws", "models");
    fsFixture([resolve(savedRoot, "loras/x.safetensors")]);

    const res = await resolveExistingModelFile("loras/x.safetensors");

    expect(res.path).toBe(resolve(savedRoot, "loras/x.safetensors"));
    expect(res.root).toBe(savedRoot);
  });

  it("errors with a workspace set_default hint when unset and no saved workspace (local mode)", async () => {
    config.comfyuiPath = undefined;
    vi.mocked(isRemoteMode).mockReturnValue(false);
    getSavedDefaultWorkspaceSyncMock.mockReturnValue(undefined);
    await expect(
      resolveExistingModelFile("loras/x.safetensors"),
    ).rejects.toThrow(/workspace \(action:"set_default"\)/);
  });

  it("returns a directory match so callers can report 'not a file'", async () => {
    fsFixture([], [resolve(MODELS_ROOT, "checkpoints")]);

    const res = await resolveExistingModelFile("checkpoints");
    expect(res.info.isFile()).toBe(false);
    expect(res.path).toBe(resolve(MODELS_ROOT, "checkpoints"));
  });
});
