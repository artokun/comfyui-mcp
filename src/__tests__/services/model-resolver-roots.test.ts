import { describe, expect, it, beforeEach, vi } from "vitest";
import { resolve } from "node:path";

// Control config (comfyuiPath) per test.
vi.mock("../../config.js", () => ({
  config: {
    comfyuiPath: "/comfy" as string | undefined,
    huggingfaceToken: undefined as string | undefined,
    civitaiApiToken: undefined as string | undefined,
  },
}));

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
vi.mock("../../services/extra-paths.js", () => ({
  getExtraModelRoots: (...a: unknown[]) => getExtraModelRootsMock(...a),
}));

import { config } from "../../config.js";
import { resolveExistingModelFile } from "../../services/model-resolver.js";
import { ModelError, ValidationError } from "../../utils/errors.js";

const MODELS_ROOT = resolve("/comfy", "models");
const EXTRA_LORAS = "E:/extra-drive/loras";

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
  config.comfyuiPath = "/comfy";
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
    await expect(
      resolveExistingModelFile("loras/x.safetensors"),
    ).rejects.toThrow(/COMFYUI_PATH/);
  });

  it("returns a directory match so callers can report 'not a file'", async () => {
    fsFixture([], [resolve(MODELS_ROOT, "checkpoints")]);

    const res = await resolveExistingModelFile("checkpoints");
    expect(res.info.isFile()).toBe(false);
    expect(res.path).toBe(resolve(MODELS_ROOT, "checkpoints"));
  });
});
