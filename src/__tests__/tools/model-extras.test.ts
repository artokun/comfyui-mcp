import { describe, expect, it, beforeEach, vi } from "vitest";
import { join, resolve } from "node:path";

// --- Mocks (declared before importing the module under test) ---

vi.mock("../../config.js", () => {
  const config = {
    comfyuiPath: "/comfy" as string | undefined,
    civitaiApiToken: undefined as string | undefined,
  };
  return {
    config,
    isLocalMode: () => Boolean(config.comfyuiPath),
    isRemoteMode: () => !config.comfyuiPath,
  };
});

const statMock = vi.fn();
const unlinkMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  copyFile: vi.fn(),
  link: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  stat: (...a: unknown[]) => statMock(...a),
  utimes: vi.fn(),
  unlink: (...a: unknown[]) => unlinkMock(...a),
}));

const downloadModelMock = vi.fn();
vi.mock("../../services/model-resolver.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/model-resolver.js")>(
    "../../services/model-resolver.js",
  );
  return {
    ...actual,
    downloadModel: (...a: unknown[]) => downloadModelMock(...a),
  };
});

const resolveCivitaiModelMock = vi.fn();
const resolveCivitaiModelVersionMock = vi.fn();
vi.mock("../../services/civitai-resolver.js", () => ({
  resolveCivitaiModel: (...a: unknown[]) => resolveCivitaiModelMock(...a),
  resolveCivitaiModelVersion: (...a: unknown[]) => resolveCivitaiModelVersionMock(...a),
}));

// Isolate these tests from on-disk extra_model_paths config: no extra roots by
// default. (Multi-root resolution is covered in model-resolver.test.ts.)
const getExtraModelRootsMock = vi.fn(async () => [] as Array<{ category: string; dir: string; group: string }>);
vi.mock("../../services/extra-paths.js", () => ({
  getExtraModelRoots: (...a: unknown[]) => getExtraModelRootsMock(...a),
}));

import { config } from "../../config.js";
import { registerModelExtrasTools } from "../../tools/model-extras.js";

// Build the models root the same way the product does (resolve against
// config.comfyuiPath) so paths match on Windows (drive-qualified, backslashes)
// as well as POSIX.
const MODELS_ROOT = resolve("/comfy", "models");

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

/** Minimal fake McpServer that captures registered tool handlers. */
function makeServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  registerModelExtrasTools(server as never);
  return {
    removeModel: handlers.get("remove_model")!,
    downloadCivitai: handlers.get("download_civitai_model")!,
  };
}

beforeEach(() => {
  statMock.mockReset();
  unlinkMock.mockReset();
  downloadModelMock.mockReset();
  resolveCivitaiModelMock.mockReset();
  resolveCivitaiModelVersionMock.mockReset();
  config.comfyuiPath = "/comfy";
  config.civitaiApiToken = undefined;
});

describe("remove_model path safety", () => {
  it("removes a file inside the models directory", async () => {
    statMock.mockResolvedValueOnce({ isFile: () => true, size: 2 * 1024 * 1024 });
    unlinkMock.mockResolvedValueOnce(undefined);

    const { removeModel } = makeServer();
    const res = await removeModel({ path: "checkpoints/model.safetensors" });

    const expectedTarget = join(MODELS_ROOT, "checkpoints", "model.safetensors");
    expect(unlinkMock).toHaveBeenCalledWith(expectedTarget);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain(expectedTarget);
    expect(res.content[0].text).toContain("MB freed");
  });

  it("rejects parent-directory traversal (../)", async () => {
    const { removeModel } = makeServer();
    const res = await removeModel({ path: "../../etc/passwd" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("VALIDATION_ERROR");
    expect(unlinkMock).not.toHaveBeenCalled();
    expect(statMock).not.toHaveBeenCalled();
  });

  it("rejects traversal that escapes after a valid prefix", async () => {
    const { removeModel } = makeServer();
    const res = await removeModel({ path: "checkpoints/../../../secret" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("outside the models directory");
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it("rejects absolute paths", async () => {
    const { removeModel } = makeServer();
    const res = await removeModel({ path: "/etc/passwd" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("absolute");
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it("rejects a path that resolves to the models root itself", async () => {
    const { removeModel } = makeServer();
    const res = await removeModel({ path: "." });

    expect(res.isError).toBe(true);
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it("rejects a sibling directory sharing the models-root prefix", async () => {
    // e.g. /comfy/models-evil should NOT be treated as inside /comfy/models
    const { removeModel } = makeServer();
    const res = await removeModel({ path: "../models-evil/x" });

    expect(res.isError).toBe(true);
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it("reports a clear error when the file does not exist", async () => {
    statMock.mockRejectedValueOnce(new Error("ENOENT"));
    const { removeModel } = makeServer();
    const res = await removeModel({ path: "loras/missing.safetensors" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("not found");
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it("refuses to remove a directory", async () => {
    statMock.mockResolvedValueOnce({ isFile: () => false, size: 0 });
    const { removeModel } = makeServer();
    const res = await removeModel({ path: "checkpoints" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Not a file");
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it("reports a clear 'not supported remotely' message in remote mode (no isError)", async () => {
    config.comfyuiPath = undefined;
    const { removeModel } = makeServer();
    const res = await removeModel({ path: "checkpoints/x.safetensors" });

    // Graceful degrade: a clear message rather than an opaque thrown error.
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("not supported against a remote ComfyUI");
    expect(unlinkMock).not.toHaveBeenCalled();
  });
});

describe("download_civitai_model", () => {
  it("resolves a model id and downloads via downloadModel", async () => {
    resolveCivitaiModelMock.mockResolvedValueOnce({
      downloadUrl: "https://civitai.com/api/download/models/201",
      filename: "cool.safetensors",
      versionId: 201,
      modelName: "Cool Model",
    });
    downloadModelMock.mockResolvedValueOnce(
      join(MODELS_ROOT, "checkpoints", "cool.safetensors"),
    );

    const { downloadCivitai } = makeServer();
    const res = await downloadCivitai({ model_id: 100, target_subfolder: "checkpoints" });

    expect(resolveCivitaiModelMock).toHaveBeenCalledWith(100, undefined);
    expect(downloadModelMock).toHaveBeenCalledWith(
      "https://civitai.com/api/download/models/201",
      "checkpoints",
      "cool.safetensors",
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Cool Model");
    expect(res.content[0].text).toContain("201");
  });

  it("resolves a model-version id directly", async () => {
    resolveCivitaiModelVersionMock.mockResolvedValueOnce({
      downloadUrl: "https://civitai.com/api/download/models/55",
      filename: "v.safetensors",
      versionId: 55,
    });
    downloadModelMock.mockResolvedValueOnce(join(MODELS_ROOT, "loras", "v.safetensors"));

    const { downloadCivitai } = makeServer();
    const res = await downloadCivitai({ model_version_id: 55, target_subfolder: "loras" });

    expect(resolveCivitaiModelVersionMock).toHaveBeenCalledWith(55);
    expect(downloadModelMock).toHaveBeenCalledWith(
      "https://civitai.com/api/download/models/55",
      "loras",
      "v.safetensors",
    );
    expect(res.isError).toBeFalsy();
  });

  it("uses model_version_id to select a specific version of a model", async () => {
    resolveCivitaiModelMock.mockResolvedValueOnce({
      downloadUrl: "https://civitai.com/api/download/models/200",
      versionId: 200,
    });
    downloadModelMock.mockResolvedValueOnce(join(MODELS_ROOT, "vae", "model.safetensors"));

    const { downloadCivitai } = makeServer();
    await downloadCivitai({ model_id: 100, model_version_id: 200, target_subfolder: "vae" });

    expect(resolveCivitaiModelMock).toHaveBeenCalledWith(100, 200);
  });

  it("honors a filename override", async () => {
    resolveCivitaiModelVersionMock.mockResolvedValueOnce({
      downloadUrl: "https://civitai.com/api/download/models/55",
      filename: "default.safetensors",
      versionId: 55,
    });
    downloadModelMock.mockResolvedValueOnce(join(MODELS_ROOT, "loras", "custom.safetensors"));

    const { downloadCivitai } = makeServer();
    await downloadCivitai({
      model_version_id: 55,
      target_subfolder: "loras",
      filename: "custom.safetensors",
    });

    expect(downloadModelMock).toHaveBeenCalledWith(
      "https://civitai.com/api/download/models/55",
      "loras",
      "custom.safetensors",
    );
  });

  it("errors when neither model_id nor model_version_id is given", async () => {
    const { downloadCivitai } = makeServer();
    const res = await downloadCivitai({ target_subfolder: "checkpoints" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("model_id");
    expect(downloadModelMock).not.toHaveBeenCalled();
  });
});
