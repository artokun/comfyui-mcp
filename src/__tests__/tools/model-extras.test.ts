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
    // #1374 — the route decision stamps the target it was made against, so this mock
    // has to provide it. Faked rather than spread from the real config: these suites
    // control `config` themselves and a real base URL would not match what they set.
    getComfyUIBaseUrl: () => `http://127.0.0.1:8188`,
  };
});

const statMock = vi.fn();
const unlinkMock = vi.fn();
const writeFileMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  copyFile: vi.fn(),
  link: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  realpath: (p: string) => Promise.resolve(p), // identity — no symlinks in these tests
  rename: vi.fn(),
  rm: vi.fn(),
  stat: (...a: unknown[]) => statMock(...a),
  utimes: vi.fn(),
  unlink: (...a: unknown[]) => unlinkMock(...a),
  writeFile: (...a: unknown[]) => writeFileMock(...a),
}));

const downloadModelMock = vi.fn();
vi.mock("../../services/model-resolver.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/model-resolver.js")>(
    "../../services/model-resolver.js",
  );
  return {
    ...actual,
    downloadModel: (...a: unknown[]) => downloadModelMock(...a),
    // startDownloadJob resolves the destination via this before streaming; stub
    // it so these tests don't need a live server to compute a targetPath.
    resolveDownloadTarget: async (url: string, sub: string, filename?: string) => {
      const name = filename ?? String(url).split("/").pop() ?? "model.safetensors";
      return { targetDir: `/m/${sub}`, filename: name, targetPath: `/m/${sub}/${name}` };
    },
  };
});

const resolveCivitaiModelMock = vi.fn();
const resolveCivitaiModelVersionMock = vi.fn();
const searchCivitaiModelsMock = vi.fn();
const searchCivitaiCreatorsMock = vi.fn();
const fetchCivitaiTopCreatorsMock = vi.fn();
vi.mock("../../services/civitai-resolver.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../services/civitai-resolver.js")
  >("../../services/civitai-resolver.js");
  return {
    ...actual,
    resolveCivitaiModel: (...a: unknown[]) => resolveCivitaiModelMock(...a),
    resolveCivitaiModelVersion: (...a: unknown[]) =>
      resolveCivitaiModelVersionMock(...a),
    searchCivitaiModels: (...a: unknown[]) => searchCivitaiModelsMock(...a),
    searchCivitaiCreators: (...a: unknown[]) => searchCivitaiCreatorsMock(...a),
    fetchCivitaiTopCreators: (...a: unknown[]) => fetchCivitaiTopCreatorsMock(...a),
  };
});

// Isolate these tests from on-disk extra_model_paths config: no extra roots by
// default. (Multi-root resolution is covered in model-resolver.test.ts.)
const getExtraModelRootsMock = vi.fn(async () => [] as Array<{ category: string; dir: string; group: string }>);
vi.mock("../../services/extra-paths.js", () => ({
  getExtraModelRoots: (...a: unknown[]) => getExtraModelRootsMock(...a),
}));

import { config } from "../../config.js";
import {
  downloadCivitaiModelAction,
  removeModelAction,
  searchCivitaiCreatorsAction,
  searchCivitaiModelsAction,
} from "../../tools/model-extras.js";

// Build the models root the same way the product does (resolve against
// config.comfyuiPath) so paths match on Windows (drive-qualified, backslashes)
// as well as POSIX.
const MODELS_ROOT = resolve("/comfy", "models");

type ToolHandler = (args: any) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

/**
 * 0.50.0 slice 11 retired these four tools into actions of `download_model` /
 * `list_local_models`; the HANDLERS are unchanged and still live here, so these
 * behaviour tests call them directly. Dispatch (which action reaches which of
 * these, and which arguments the per-action guards require) is covered
 * separately in models-consolidated.test.ts.
 */
function makeServer(): {
  removeModel: ToolHandler;
  downloadCivitai: ToolHandler;
  searchCivitai: ToolHandler;
  searchCreators: ToolHandler;
} {
  return {
    removeModel: removeModelAction,
    downloadCivitai: downloadCivitaiModelAction,
    searchCivitai: searchCivitaiModelsAction,
    searchCreators: searchCivitaiCreatorsAction,
  };
}

beforeEach(() => {
  statMock.mockReset();
  unlinkMock.mockReset();
  writeFileMock.mockReset();
  writeFileMock.mockResolvedValue(undefined);
  downloadModelMock.mockReset();
  resolveCivitaiModelMock.mockReset();
  resolveCivitaiModelVersionMock.mockReset();
  searchCivitaiModelsMock.mockReset();
  searchCivitaiCreatorsMock.mockReset();
  fetchCivitaiTopCreatorsMock.mockReset();
  config.comfyuiPath = "/comfy";
  config.civitaiApiToken = undefined;
});

describe('list_local_models action:"remove" path safety', () => {
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

describe('download_model action:"download_civitai"', () => {
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
      undefined,
      false, // routing decision threaded through (local, #420 codex round 1)
      expect.any(Function), // onResume callback — reports the resume decision onto the job (#467)
      expect.any(AbortSignal), // per-download abort signal threaded from the job's controller (#515)
      expect.any(Function), // onTrayId callback — aligns the job trayId with the tray row id (#515)
      expect.any(Function), // onLanded callback — commits done synchronously at the destination rename (#515)
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
      undefined,
      false, // routing decision threaded through (local, #420 codex round 1)
      expect.any(Function), // onResume callback — reports the resume decision onto the job (#467)
      expect.any(AbortSignal), // per-download abort signal threaded from the job's controller (#515)
      expect.any(Function), // onTrayId callback — aligns the job trayId with the tray row id (#515)
      expect.any(Function), // onLanded callback — commits done synchronously at the destination rename (#515)
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
      undefined,
      false, // routing decision threaded through (local, #420 codex round 1)
      expect.any(Function), // onResume callback — reports the resume decision onto the job (#467)
      expect.any(AbortSignal), // per-download abort signal threaded from the job's controller (#515)
      expect.any(Function), // onTrayId callback — aligns the job trayId with the tray row id (#515)
      expect.any(Function), // onLanded callback — commits done synchronously at the destination rename (#515)
    );
  });

  it("writes .civitai.json + .civitai.md sidecars when metadata is present", async () => {
    const savedPath = join(MODELS_ROOT, "loras", "cool.safetensors");
    resolveCivitaiModelMock.mockResolvedValueOnce({
      downloadUrl: "https://civitai.com/api/download/models/201",
      filename: "cool.safetensors",
      versionId: 201,
      modelName: "Cool LoRA",
      metadata: {
        modelId: 100,
        modelName: "Cool LoRA",
        modelType: "LORA",
        versionId: 201,
        baseModel: "SDXL 1.0",
        trainedWords: ["coolstyle", "vibrant"],
        sourceUrl: "https://civitai.com/models/100?modelVersionId=201",
        examples: [
          { url: "https://img/1.jpeg", type: "image", meta: { seed: 42, prompt: "a cat" } },
          { url: "https://img/2.jpeg", type: "image", meta: null },
        ],
      },
    });
    downloadModelMock.mockResolvedValueOnce(savedPath);

    const { downloadCivitai } = makeServer();
    const res = await downloadCivitai({ model_id: 100, target_subfolder: "loras" });

    const written = writeFileMock.mock.calls.map((c) => c[0] as string);
    expect(written).toContain(`${savedPath}.civitai.json`);
    expect(written).toContain(`${savedPath}.civitai.md`);
    // The markdown carries trigger words + the example recipe.
    const md = writeFileMock.mock.calls.find(
      (c) => (c[0] as string).endsWith(".md"),
    )?.[1] as string;
    expect(md).toContain("coolstyle");
    expect(md).toContain("seed: 42");
    // The tool result surfaces the trigger words + a recipe count.
    expect(res.content[0].text).toContain("Trigger words: coolstyle, vibrant");
    expect(res.content[0].text).toContain("1 example recipe");
  });

  it("does not write sidecars in remote mode (no local path)", async () => {
    config.comfyuiPath = undefined; // remote
    resolveCivitaiModelVersionMock.mockResolvedValueOnce({
      downloadUrl: "https://civitai.com/api/download/models/55",
      versionId: 55,
      metadata: { versionId: 55, trainedWords: [], sourceUrl: "x", examples: [] },
    });
    downloadModelMock.mockResolvedValueOnce("Dispatched to ComfyUI host.");

    const { downloadCivitai } = makeServer();
    await downloadCivitai({ model_version_id: 55, target_subfolder: "loras" });

    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("errors when neither model_id nor model_version_id is given", async () => {
    const { downloadCivitai } = makeServer();
    const res = await downloadCivitai({ target_subfolder: "checkpoints" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("model_id");
    expect(downloadModelMock).not.toHaveBeenCalled();
  });
});

describe('download_model action:"search_civitai" creator filter', () => {
  it("errors when neither query nor creator is given", async () => {
    const { searchCivitai } = makeServer();
    const res = await searchCivitai({});

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("VALIDATION_ERROR");
    expect(searchCivitaiModelsMock).not.toHaveBeenCalled();
  });

  it("passes creator through and labels the results with it", async () => {
    searchCivitaiModelsMock.mockResolvedValueOnce({
      hits: [
        { model_id: 1, name: "Detail Slider", type: "LORA", creator: "alcaitiff", version_id: 9 },
      ],
    });
    const { searchCivitai } = makeServer();
    const res = await searchCivitai({ creator: "alcaitiff" });

    expect(searchCivitaiModelsMock).toHaveBeenCalledWith(
      "",
      expect.objectContaining({ creator: "alcaitiff" }),
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("creator alcaitiff");
    expect(res.content[0].text).toContain("Detail Slider");
    expect(res.content[0].text).not.toContain("scan cap");
  });

  it('no-hits message points at action:"search_creators" for a creator miss', async () => {
    searchCivitaiModelsMock.mockResolvedValueOnce({ hits: [] });
    const { searchCivitai } = makeServer();
    const res = await searchCivitai({ creator: "nobody" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('action:"search_creators"');
  });

  it("surfaces the bounded-scan cap so a capped miss is never presented as definitive", async () => {
    searchCivitaiModelsMock.mockResolvedValueOnce({
      hits: [],
      scanned: 400,
      scanCapped: true,
    });
    const { searchCivitai } = makeServer();
    const res = await searchCivitai({ creator: "prolific", query: "detail" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("No CivitAI models matched");
    expect(res.content[0].text).toContain("first 400 models (scan cap)");
  });
});

describe('download_model action:"search_creators"', () => {
  it("no query → leaderboard mode (default 'overall'), ranked lines + models hand-off", async () => {
    fetchCivitaiTopCreatorsMock.mockResolvedValueOnce([
      {
        username: "alcaitiff",
        profile_url: "https://civitai.com/user/alcaitiff",
        position: 1,
        score: 81140,
        downloads: 42294,
        thumbs_up: 2253,
        entries: 13,
      },
    ]);
    const { searchCreators } = makeServer();
    const res = await searchCreators({});

    expect(fetchCivitaiTopCreatorsMock).toHaveBeenCalledWith({
      board: "overall",
      limit: undefined,
    });
    expect(searchCivitaiCreatorsMock).not.toHaveBeenCalled();
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('"overall" leaderboard');
    expect(res.content[0].text).toContain("1. **alcaitiff**");
    expect(res.content[0].text).toContain("https://civitai.com/user/alcaitiff");
    expect(res.content[0].text).toContain('{"action": "search_civitai", "creator"');
  });

  it("query → username-search mode with model counts", async () => {
    searchCivitaiCreatorsMock.mockResolvedValueOnce({
      hits: [
        { username: "jedikun", profile_url: "https://civitai.com/user/jedikun", model_count: 18 },
      ],
      total: 6,
    });
    const { searchCreators } = makeServer();
    const res = await searchCreators({ query: "jed", limit: 5 });

    expect(searchCivitaiCreatorsMock).toHaveBeenCalledWith("jed", { limit: 5 });
    expect(fetchCivitaiTopCreatorsMock).not.toHaveBeenCalled();
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("jedikun");
    expect(res.content[0].text).toContain("18 model(s)");
    expect(res.content[0].text).toContain("6 total matches");
  });

  it("query with no matches suggests the leaderboard", async () => {
    searchCivitaiCreatorsMock.mockResolvedValueOnce({ hits: [], total: 0 });
    const { searchCreators } = makeServer();
    const res = await searchCreators({ query: "zzz" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("No CivitAI creators matched");
  });
});
