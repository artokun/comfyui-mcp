// #2447 — apply_manifest reported installed GGUF assets as failed/pending
// because its existing-file validation (liveListingHasBasename) only asked
// core /models/text_encoders and /models/unet. The same files are listed by
// ComfyUI-GGUF under clip_gguf / unet_gguf, which list_local_models already
// surfaces. Drive applyManifest with the REAL listing functions — not a
// mock of the unit under test, and not a parallel checker.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockConfig = vi.hoisted(() => ({
  comfyuiPath: "/fake/ComfyUI" as string | undefined,
  comfyuiCodePath: undefined as string | undefined,
  remote: undefined as boolean | undefined,
}));

const h = vi.hoisted(() => ({
  liveListings: {} as Record<string, string[] | undefined>,
  registry: undefined as string[] | undefined,
  fetchCalls: [] as string[],
}));

const statMock = vi.hoisted(() => vi.fn());
const isUnderLiveModelRootsMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{ inRoots: boolean | undefined; liveRoot?: string }> => ({
    inRoots: true,
  })),
);
const resolveExistingModelFileMock = vi.hoisted(() => vi.fn());
const listLocalModelsMock = vi.hoisted(() => vi.fn());
const downloadModelMock = vi.hoisted(() => vi.fn());
const listInstalledNodesMock = vi.hoisted(() => vi.fn());
const modelsDirMock = vi.hoisted(() => vi.fn(async () => "/fake/ComfyUI/models"));

vi.mock("../../config.js", () => ({
  config: mockConfig,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyuiTargetGeneration: () => 0,
  isRemoteMode: () => mockConfig.remote ?? !mockConfig.comfyuiPath,
}));

vi.mock("../../comfyui/client.js", () => {
  const listingFetch = async (path: string) => {
    h.fetchCalls.push(path);
    if (path === "/models" || path === "/models/") {
      const names = h.registry ?? Object.keys(h.liveListings);
      return { ok: true, status: 200, json: async () => names };
    }
    const category = decodeURIComponent(path.replace(/^\/models\//, ""));
    const listing = h.liveListings[category];
    if (listing === undefined) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => listing };
  };
  return {
    getClient: () => ({ fetchApi: listingFetch }),
    comfyApiFetch: listingFetch,
    getSystemStats: vi.fn(),
    getLogs: vi.fn(),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: (...a: unknown[]) => statMock(...a),
    mkdir: vi.fn(),
    realpath: vi.fn(async (p: string) => p),
    lstat: vi.fn(async () => {
      throw new Error("missing");
    }),
    readFile: vi.fn(),
  };
});

vi.mock("node:fs", () => ({
  existsSync: () => false,
}));

vi.mock("../../services/node-management.js", () => ({
  installCustomNode: vi.fn(),
  installModelViaManager: vi.fn(),
  listInstalledNodes: (...a: unknown[]) => listInstalledNodesMock(...a),
}));

vi.mock("../../services/model-resolver.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../services/model-resolver.js")>();
  return {
    ...real,
    // Keep liveListingHasBasename / liveListingHasEntry REAL — they are the
    // shipped validation apply_manifest uses for this bug.
    isUnderLiveModelRoots: (...a: unknown[]) => isUnderLiveModelRootsMock(...(a as [string])),
    resolveExistingModelFile: (...a: unknown[]) => resolveExistingModelFileMock(...(a as [string])),
    listLocalModels: (...a: unknown[]) => listLocalModelsMock(...(a as [string])),
    downloadModel: (...a: unknown[]) => downloadModelMock(...a),
    shouldDispatchDownloadToManager: async () => false,
    currentLiveModelsRoot: async () => "/fake/ComfyUI/models",
    verifyLandedModel: async (targetPath: string) => ({
      verifiedPath: targetPath,
      liveVisible: "visible" as const,
      verifiedAgainstRoot: "/fake/ComfyUI/models",
    }),
  };
});

vi.mock("../../services/workspace-env.js", () => ({
  getSavedDefaultWorkspaceSync: () => undefined,
  resolveLiveComfyUIBase: async () => undefined,
  resolveEffectiveComfyUICodeBaseLive: async () => mockConfig.comfyuiPath,
  resolveEffectiveComfyUIBaseLive: async () => mockConfig.comfyuiPath,
  resolveCustomNodesScanBaseLiveStrict: async () => mockConfig.comfyuiPath,
  getLiveServerSnapshot: async () => ({ reachable: true }),
  resolveRootInterpreter: (root: string | undefined) => (root ? `${root}/python` : "python"),
  resolveInstallInterpreter: async (root: string | undefined) => ({
    python: root ? `${root}/python` : "python",
    source: "launched",
    reason: "test interpreter",
  }),
}));

vi.mock("../../services/output-dir.js", () => ({
  resolveModelsDir: (...a: unknown[]) => modelsDirMock(...(a as [])),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { applyManifest } from "../../services/manifest.js";

beforeEach(() => {
  mockConfig.comfyuiPath = "/fake/ComfyUI";
  mockConfig.comfyuiCodePath = undefined;
  mockConfig.remote = undefined;
  h.liveListings = {};
  h.registry = undefined;
  h.fetchCalls = [];
  statMock.mockReset().mockResolvedValue({ isFile: () => true });
  isUnderLiveModelRootsMock.mockReset().mockResolvedValue({ inRoots: true });
  resolveExistingModelFileMock.mockReset().mockRejectedValue(new Error("not found"));
  listLocalModelsMock.mockReset().mockResolvedValue([]);
  downloadModelMock.mockReset();
  listInstalledNodesMock.mockReset().mockResolvedValue([]);
  modelsDirMock.mockReset().mockResolvedValue("/fake/ComfyUI/models");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("apply_manifest GGUF custom-category validation (#2447)", () => {
  it("skips wan-longer-videos-i2v GGUFs listed under clip_gguf / unet_gguf", async () => {
    // Reproduce the reporter: files exist on disk under models/text_encoders and
    // models/unet; core /models/text_encoders omits the GGUF; /models/unet 404s;
    // list_local_models sees all three under clip_gguf / unet_gguf.
    h.liveListings.text_encoders = ["umt5_xxl_fp8_e4m3fn.safetensors"];
    h.liveListings.clip_gguf = ["umt5-xxl-encoder-Q5_K_S.gguf"];
    h.liveListings.unet_gguf = [
      "Wan2.2-I2V-A14B-HighNoise-Q4_K_S.gguf",
      "Wan2.2-I2V-A14B-LowNoise-Q4_K_S.gguf",
    ];
    h.liveListings.vae = ["wan_2.1_vae.safetensors"];

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://huggingface.co/Aitrepreneur/FLX/resolve/main/umt5-xxl-encoder-Q5_K_S.gguf",
            local_path: "text_encoders/umt5-xxl-encoder-Q5_K_S.gguf",
          },
          {
            url: "https://huggingface.co/Aitrepreneur/FLX/resolve/main/wan_2.1_vae.safetensors",
            local_path: "vae/wan_2.1_vae.safetensors",
          },
          {
            url: "https://huggingface.co/Aitrepreneur/FLX/resolve/main/Wan2.2-I2V-A14B-HighNoise-Q4_K_S.gguf",
            local_path: "unet/Wan2.2-I2V-A14B-HighNoise-Q4_K_S.gguf",
          },
          {
            url: "https://huggingface.co/Aitrepreneur/FLX/resolve/main/Wan2.2-I2V-A14B-LowNoise-Q4_K_S.gguf",
            local_path: "unet/Wan2.2-I2V-A14B-LowNoise-Q4_K_S.gguf",
          },
        ],
      },
    });

    expect(result.summary).toEqual({ applied: 0, skipped: 4, failed: 0, pending: 0 });
    expect(result.success).toBe(true);
    expect(downloadModelMock).not.toHaveBeenCalled();
    expect(h.fetchCalls).toContain("/models/clip_gguf");
    expect(h.fetchCalls).toContain("/models/unet_gguf");
    for (const row of result.results) {
      expect(row.status).toBe("skipped");
      expect(row.message).toMatch(/already exists/i);
    }
  });

  it("still fails a contained safetensors the live server does not list", async () => {
    h.liveListings.checkpoints = ["other.safetensors"];

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

    expect(result.summary).toMatchObject({ skipped: 0, failed: 1 });
    expect(result.results[0].message).toMatch(/does not list/);
    expect(downloadModelMock).not.toHaveBeenCalled();
  });
});
