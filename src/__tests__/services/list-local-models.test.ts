import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Per-test control over the comfyuiPath toggle.
vi.mock("../../config.js", () => ({
  config: {
    comfyuiPath: "/comfy" as string | undefined,
  },
  // When comfyuiPath is unset the base resolver consults isRemoteMode; treat the
  // "no local path" tests as remote so it cleanly yields no local base.
  isRemoteMode: () => true,
}));

// Stub getClient so we control whether the HTTP REST path succeeds, fails, or
// throws (cloud mode).
const fetchApi = vi.fn();
const getClient = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getClient: (...args: unknown[]) => getClient(...args),
}));

// Filesystem fallback hooks (readFile feeds the CivitAI sidecar enrichment).
const readdir = vi.fn();
const stat = vi.fn();
const readFile = vi.fn();
vi.mock("node:fs/promises", () => ({
  readdir: (...a: unknown[]) => readdir(...a),
  stat: (...a: unknown[]) => stat(...a),
  readFile: (...a: unknown[]) => readFile(...a),
  // Unused by listLocalModels but required by other functions in the module.
  copyFile: vi.fn(),
  link: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  utimes: vi.fn(),
}));

const { config } = await import("../../config.js");
const { listLocalModels } = await import("../../services/model-resolver.js");

beforeEach(() => {
  getClient.mockReset();
  fetchApi.mockReset();
  readdir.mockReset();
  stat.mockReset();
  readFile.mockReset();
  // Default: no sidecar next to any model file (enrichment is best-effort).
  readFile.mockRejectedValue(new Error("ENOENT"));
  config.comfyuiPath = "/comfy";
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("listLocalModels — HTTP-first with FS fallback", () => {
  it("returns HTTP /models/<dir> results when available (skips FS scan)", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockImplementation(async (path: string) => {
      if (path === "/models/checkpoints") {
        return new Response(JSON.stringify(["sd_xl_base_1.0.safetensors"]), {
          status: 200,
        });
      }
      return new Response("[]", { status: 200 });
    });
    const result = await listLocalModels("checkpoints");
    expect(result).toEqual([
      {
        name: "sd_xl_base_1.0.safetensors",
        path: "checkpoints/sd_xl_base_1.0.safetensors",
        size: 0,
        modified: "",
        type: "checkpoints",
      },
    ]);
    // checkpoints has no GGUF category, so no supplemental query and no FS scan.
    expect(readdir).not.toHaveBeenCalled();
  });

  it("#526: unfiltered listing surfaces GGUF via ComfyUI-GGUF's registered categories", async () => {
    // Core `/models/<dir>` only lists supported_pt_extensions (no .gguf), so a static
    // scan of MODEL_SUBDIRS misses every GGUF model. ComfyUI-GGUF registers its own
    // categories (unet_gguf/clip_gguf) which ComfyUI serves over REST; discovering
    // them via `/models` and scanning them surfaces the GGUFs — typed by the category
    // ComfyUI itself registered, no folder guessing.
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockImplementation(async (path: string) => {
      if (path === "/models") {
        // Registry includes core categories + ComfyUI-GGUF's registered ones.
        return new Response(
          JSON.stringify(["checkpoints", "unet", "unet_gguf", "clip_gguf"]),
          { status: 200 },
        );
      }
      if (path === "/models/unet_gguf") {
        return new Response(
          JSON.stringify(["Wan2.1_I2V_480p_Q8.gguf", "z_image_turbo-Q6_K.gguf"]),
          { status: 200 },
        );
      }
      if (path === "/models/clip_gguf") {
        return new Response(JSON.stringify(["Qwen2.5-VL-7B-Q4.gguf"]), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });

    const result = await listLocalModels(); // no type → list all

    expect(result.find((m) => m.name === "Wan2.1_I2V_480p_Q8.gguf")).toEqual({
      name: "Wan2.1_I2V_480p_Q8.gguf",
      path: "unet_gguf/Wan2.1_I2V_480p_Q8.gguf",
      size: 0,
      modified: "",
      type: "unet_gguf",
    });
    expect(result.some((m) => m.name === "z_image_turbo-Q6_K.gguf" && m.type === "unet_gguf")).toBe(
      true,
    );
    expect(result.some((m) => m.name === "Qwen2.5-VL-7B-Q4.gguf" && m.type === "clip_gguf")).toBe(
      true,
    );
    // Authoritative REST listing — no filesystem scan involved.
    expect(readdir).not.toHaveBeenCalled();
  });

  it("#526: discovery is scoped to *_gguf categories, ignoring non-gguf / non-model keys", async () => {
    // `/models` lists the whole registry: core categories, other loaders' non-gguf
    // categories (tensorrt/.engine), and extension-BLIND non-model registries
    // (custom_nodes/datasets — empty extension sets that would list arbitrary files).
    // Only the `*_gguf` categories are safe to fold in; everything else must be
    // neither queried nor listed. Core categories are not re-queried.
    getClient.mockReturnValue({ fetchApi });
    const queried: string[] = [];
    fetchApi.mockImplementation(async (path: string) => {
      queried.push(path);
      if (path === "/models") {
        return new Response(
          JSON.stringify([
            "checkpoints", // core — queried by the core scan, not discovery
            "tensorrt", // non-gguf custom category — out of scope
            "custom_nodes", // extension-blind — would flood; must be ignored
            "datasets", // extension-blind — must be ignored
            "unet_gguf", // the one we want
          ]),
          { status: 200 },
        );
      }
      return path === "/models/unet_gguf"
        ? new Response(JSON.stringify(["flux-Q4.gguf"]), { status: 200 })
        : new Response("[]", { status: 200 });
    });

    const result = await listLocalModels();
    // Only the gguf model is surfaced by discovery.
    expect(result.map((m) => ({ name: m.name, type: m.type }))).toEqual([
      { name: "flux-Q4.gguf", type: "unet_gguf" },
    ]);
    // Non-gguf / non-model categories are never even queried.
    expect(queried).not.toContain("/models/tensorrt");
    expect(queried).not.toContain("/models/custom_nodes");
    expect(queried).not.toContain("/models/datasets");
    // `checkpoints` is core → queried exactly once by the core scan, not by discovery.
    expect(queried.filter((p) => p === "/models/checkpoints")).toHaveLength(1);
  });

  it("#526: a discovered gguf category emits only .gguf files (no flood / no double-count)", async () => {
    // Defense against a malformed `*_gguf` alias registered with an EMPTY extension
    // set over a shared dir: `/models/<cat>` would then return normal weights too.
    // We must emit only the .gguf entries, so normal weights aren't double-listed
    // (once under their core category, once under the alias) and no junk floods in.
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockImplementation(async (path: string) => {
      if (path === "/models") return new Response(JSON.stringify(["unet_gguf"]), { status: 200 });
      if (path === "/models/diffusion_models") {
        return new Response(JSON.stringify(["flux_dev.safetensors"]), { status: 200 });
      }
      if (path === "/models/unet_gguf") {
        // Empty-extension alias over diffusion_models/: returns EVERYTHING.
        return new Response(
          JSON.stringify(["flux_dev.safetensors", "flux-Q4.gguf", "notes.txt"]),
          { status: 200 },
        );
      }
      return new Response("[]", { status: 200 });
    });

    const result = await listLocalModels();
    // The safetensors is listed once (core diffusion_models), NOT again under the alias.
    expect(result.filter((m) => m.name === "flux_dev.safetensors")).toEqual([
      {
        name: "flux_dev.safetensors",
        path: "diffusion_models/flux_dev.safetensors",
        size: 0,
        modified: "",
        type: "diffusion_models",
      },
    ]);
    // Only the .gguf is pulled from the alias; the .txt is dropped.
    expect(result.find((m) => m.name === "flux-Q4.gguf")).toMatchObject({ type: "unet_gguf" });
    expect(result.some((m) => m.name === "notes.txt")).toBe(false);
  });

  it("#526: same .gguf via a core category AND a *_gguf alias is de-duped to ONE record", async () => {
    // A custom node re-registers `diffusion_models` to also admit `.gguf`, so the
    // same file is reported by BOTH /models/diffusion_models and /models/unet_gguf
    // (which is backed by diffusion_models). It must appear exactly once.
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockImplementation(async (path: string) => {
      if (path === "/models") return new Response(JSON.stringify(["unet_gguf"]), { status: 200 });
      if (path === "/models/diffusion_models") {
        return new Response(JSON.stringify(["flux-Q4.gguf"]), { status: 200 });
      }
      if (path === "/models/unet_gguf") {
        return new Response(JSON.stringify(["flux-Q4.gguf"]), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });

    const result = await listLocalModels();
    expect(result.filter((m) => m.name === "flux-Q4.gguf")).toHaveLength(1);
    // The core-category record wins (scanned first), keeping the real folder type.
    expect(result.find((m) => m.name === "flux-Q4.gguf")).toMatchObject({
      type: "diffusion_models",
    });
  });

  it("#526: distinct same-basename .gguf files in genuinely different folders are NOT collapsed", async () => {
    // A GGUF named `model.gguf` in the unet family AND a DIFFERENT `model.gguf` in
    // the text-encoder family (surfaced via clip_gguf) are distinct files → TWO.
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockImplementation(async (path: string) => {
      if (path === "/models") {
        return new Response(JSON.stringify(["unet_gguf", "clip_gguf"]), { status: 200 });
      }
      if (path === "/models/unet_gguf") {
        return new Response(JSON.stringify(["model.gguf"]), { status: 200 });
      }
      if (path === "/models/clip_gguf") {
        return new Response(JSON.stringify(["model.gguf"]), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });

    const result = await listLocalModels();
    const models = result.filter((m) => m.name === "model.gguf");
    expect(models).toHaveLength(2);
    expect(new Set(models.map((m) => m.type))).toEqual(new Set(["unet_gguf", "clip_gguf"]));
  });

  it("#526: de-dup preserves filename case (Model.gguf vs model.gguf are distinct)", async () => {
    // On a case-sensitive filesystem these are two different files; the identity key
    // must NOT lowercase the filename and collapse them.
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockImplementation(async (path: string) => {
      if (path === "/models") return new Response(JSON.stringify(["unet_gguf"]), { status: 200 });
      return path === "/models/unet_gguf"
        ? new Response(JSON.stringify(["Model.gguf", "model.gguf"]), { status: 200 })
        : new Response("[]", { status: 200 });
    });

    const result = await listLocalModels();
    expect(result.map((m) => m.name).sort()).toEqual(["Model.gguf", "model.gguf"]);
  });

  it("#526: a specific-category filter (unet_gguf) works directly via the core scan", async () => {
    // A filtered call already targets its exact category, so no discovery is needed:
    // listLocalModels("unet_gguf") must query /models/unet_gguf directly. It must NOT
    // hit the discovery endpoint at all.
    getClient.mockReturnValue({ fetchApi });
    const calls: string[] = [];
    fetchApi.mockImplementation(async (path: string) => {
      calls.push(path);
      return path === "/models/unet_gguf"
        ? new Response(JSON.stringify(["flux-Q8.gguf"]), { status: 200 })
        : new Response("[]", { status: 200 });
    });

    const result = await listLocalModels("unet_gguf");
    expect(result).toEqual([
      {
        name: "flux-Q8.gguf",
        path: "unet_gguf/flux-Q8.gguf",
        size: 0,
        modified: "",
        type: "unet_gguf",
      },
    ]);
    expect(calls).not.toContain("/models"); // filtered calls skip discovery
  });

  it("#526: filtered *_gguf call also emits only .gguf (guard not bypassed by filtering)", async () => {
    // Explicit `listLocalModels("unet_gguf")` against a malformed empty-extension
    // alias must still emit only .gguf — the guard applies to any *_gguf category,
    // not just discovered ones.
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockImplementation(async (path: string) =>
      path === "/models/unet_gguf"
        ? new Response(JSON.stringify(["flux_dev.safetensors", "flux-Q4.gguf", "readme.md"]), {
            status: 200,
          })
        : new Response("[]", { status: 200 }),
    );

    const result = await listLocalModels("unet_gguf");
    expect(result.map((m) => m.name)).toEqual(["flux-Q4.gguf"]);
  });

  it("#526: fs fallback for a *_gguf dir also emits only .gguf", async () => {
    // Server unreachable → Path 2. A `*_gguf` dir scan must apply the same .gguf guard.
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockResolvedValue(new Response("Not Found", { status: 404 })); // all REST 404 → fs
    readdir.mockResolvedValue(["weights.safetensors", "model-Q6.gguf", "notes.txt"]);
    stat.mockResolvedValue({
      isFile: () => true,
      size: 42,
      mtime: new Date("2026-07-30T00:00:00Z"),
    });

    const result = await listLocalModels("unet_gguf");
    expect(result.map((m) => m.name)).toEqual(["model-Q6.gguf"]);
  });

  it("#526: a GGUF-only server is NOT reported empty (discovered category is non-empty)", async () => {
    // Every core /models/<dir> is empty, but discovery finds unet_gguf with a file,
    // so httpReturnedAny becomes true and we return it (not fall through to empty).
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockImplementation(async (path: string) => {
      if (path === "/models") return new Response(JSON.stringify(["unet_gguf"]), { status: 200 });
      return path === "/models/unet_gguf"
        ? new Response(JSON.stringify(["Wan2_2-TI2V-5B-Turbo-Q5_K_M.gguf"]), { status: 200 })
        : new Response("[]", { status: 200 });
    });

    const result = await listLocalModels();
    expect(result).toEqual([
      {
        name: "Wan2_2-TI2V-5B-Turbo-Q5_K_M.gguf",
        path: "unet_gguf/Wan2_2-TI2V-5B-Turbo-Q5_K_M.gguf",
        size: 0,
        modified: "",
        type: "unet_gguf",
      },
    ]);
    // Purely REST — no filesystem fallback needed.
    expect(readdir).not.toHaveBeenCalled();
  });

  it("#526: GGUF categories are surfaced remotely (no local path, size 0)", async () => {
    // No comfyuiPath → no filesystem at all. The GGUF must still be visible via the
    // discovered REST category. This is the remote gap a filesystem-only patch cannot
    // cover.
    config.comfyuiPath = undefined;
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockImplementation(async (path: string) => {
      if (path === "/models") return new Response(JSON.stringify(["clip_gguf"]), { status: 200 });
      return path === "/models/clip_gguf"
        ? new Response(JSON.stringify(["Qwen2.5-VL-7B-Instruct-UD-Q4_K_S.gguf"]), { status: 200 })
        : new Response("[]", { status: 200 });
    });

    const result = await listLocalModels();
    expect(result).toEqual([
      {
        name: "Qwen2.5-VL-7B-Instruct-UD-Q4_K_S.gguf",
        path: "clip_gguf/Qwen2.5-VL-7B-Instruct-UD-Q4_K_S.gguf",
        size: 0,
        modified: "",
        type: "clip_gguf",
      },
    ]);
    expect(readdir).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  it("#526: falls back to core listing when /models discovery is unavailable", async () => {
    // Older server / transient error on /models must not break the normal listing:
    // core categories still list, and we don't throw.
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockImplementation(async (path: string) => {
      if (path === "/models") return new Response("Not Found", { status: 404 });
      if (path === "/models/checkpoints") {
        return new Response(JSON.stringify(["sd_xl_base_1.0.safetensors"]), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });

    const result = await listLocalModels();
    expect(result).toEqual([
      {
        name: "sd_xl_base_1.0.safetensors",
        path: "checkpoints/sd_xl_base_1.0.safetensors",
        size: 0,
        modified: "",
        type: "checkpoints",
      },
    ]);
  });

  it("falls back to filesystem when the HTTP endpoint returns empty", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockResolvedValue(new Response("[]", { status: 200 }));
    readdir.mockResolvedValue(["my-lora.safetensors"]);
    stat.mockResolvedValue({
      isFile: () => true,
      size: 1024 * 1024 * 50,
      mtime: new Date("2026-06-01T12:00:00Z"),
    });
    const result = await listLocalModels("loras");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "my-lora.safetensors",
      type: "loras",
      size: 1024 * 1024 * 50,
      modified: "2026-06-01T12:00:00.000Z",
    });
  });

  it("enriches entries from the CivitAI sidecar: trigger words, base, and the source URL", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockImplementation(async (path: string) =>
      path === "/models/loras"
        ? new Response(JSON.stringify(["detail.safetensors"]), { status: 200 })
        : new Response("[]", { status: 200 }),
    );
    readFile.mockResolvedValue(
      JSON.stringify({
        modelId: 162967,
        versionId: 183635,
        trainedWords: ["more detail"],
        baseModel: "SDXL 1.0",
        sourceUrl: "https://civitai.com/models/162967?modelVersionId=183635",
      }),
    );
    const result = await listLocalModels("loras");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "detail.safetensors",
      triggerWords: ["more detail"],
      baseModel: "SDXL 1.0",
      civitaiUrl: "https://civitai.com/models/162967?modelVersionId=183635",
    });
  });

  it("reconstructs the CivitAI URL from ids when the sidecar predates sourceUrl", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockImplementation(async (path: string) =>
      path === "/models/loras"
        ? new Response(JSON.stringify(["a.safetensors", "b.safetensors"]), { status: 200 })
        : new Response("[]", { status: 200 }),
    );
    // a: version-only sidecar (no modelId, no sourceUrl); b: both ids, no sourceUrl.
    readFile.mockImplementation(async (p: string) =>
      String(p).includes("a.safetensors")
        ? JSON.stringify({ versionId: 28907 })
        : JSON.stringify({ modelId: 211726, versionId: 3101597 }),
    );
    const result = await listLocalModels("loras");
    expect(result.map((m) => m.civitaiUrl)).toEqual([
      "https://civitai.com/model-versions/28907",
      "https://civitai.com/models/211726?modelVersionId=3101597",
    ]);
  });

  it("returns empty (no throw) in cloud mode when no comfyuiPath is set", async () => {
    config.comfyuiPath = undefined;
    getClient.mockImplementation(() => {
      const err = new Error(
        "getClient is not supported in Comfy Cloud mode",
      ) as Error & { code: string };
      err.code = "CLOUD_UNSUPPORTED";
      throw err;
    });
    const result = await listLocalModels("checkpoints");
    expect(result).toEqual([]);
  });

  it("returns empty when HTTP is unreachable in remote mode (no FS path)", async () => {
    config.comfyuiPath = undefined;
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockResolvedValue(new Response("Not Found", { status: 404 }));
    const result = await listLocalModels("checkpoints");
    expect(result).toEqual([]);
  });
});
