import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listLocalModels: vi.fn(),
  getSystemStats: vi.fn(),
  comfyuiPath: undefined as string | undefined,
}));

vi.mock("../../services/model-resolver.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/model-resolver.js")>(
    "../../services/model-resolver.js",
  );
  return { ...actual, listLocalModels: mocks.listLocalModels };
});

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: mocks.getSystemStats,
}));

vi.mock("../../config.js", () => ({
  get config() {
    return { comfyuiPath: mocks.comfyuiPath };
  },
}));

import {
  isLocalModelsListAction,
  listLocalModelsFallback,
} from "../../services/local-models-fallback.js";

const model = (name: string, type: string) => ({ name, path: `${type}/${name}`, size: 0, modified: "", type });

describe("comfy_cli models_* local fallback (#460)", () => {
  beforeEach(() => {
    mocks.listLocalModels.mockReset();
    mocks.getSystemStats.mockReset();
    mocks.comfyuiPath = undefined;
  });

  it("recognizes the read-only listing actions", () => {
    for (const a of ["list-folders", "list-folder", "search", "show"]) {
      expect(isLocalModelsListAction(a)).toBe(true);
    }
    for (const a of ["download", "remove"]) {
      expect(isLocalModelsListAction(a)).toBe(false);
    }
  });

  it("lists local model folders via the connected server when comfy-cli is absent", async () => {
    mocks.listLocalModels.mockResolvedValue([
      model("sd_xl.safetensors", "checkpoints"),
      model("lcm.safetensors", "loras"),
    ]);
    const { command, data } = await listLocalModelsFallback({ action: "list-folders" });
    expect(command).toBe("models list-folders");
    expect(data).toEqual({ folders: ["checkpoints", "loras"] });
    expect(mocks.getSystemStats).not.toHaveBeenCalled();
  });

  it("lists files in a folder", async () => {
    mocks.listLocalModels.mockResolvedValue([model("a.safetensors", "loras"), model("b.safetensors", "loras")]);
    const { data } = await listLocalModelsFallback({ action: "list-folder", folder: "loras" });
    expect(data).toEqual({ folder: "loras", count: 2, files: ["a.safetensors", "b.safetensors"] });
  });

  it("caps list-folder output at the limit (mirrors --limit)", async () => {
    mocks.listLocalModels.mockResolvedValue([
      model("a.safetensors", "loras"),
      model("b.safetensors", "loras"),
      model("c.safetensors", "loras"),
    ]);
    const { data } = await listLocalModelsFallback({ action: "list-folder", folder: "loras", limit: 2 });
    expect(data).toEqual({ folder: "loras", count: 2, files: ["a.safetensors", "b.safetensors"] });
  });

  // Mirrors comfy-cli's _TYPE_TO_FOLDER (comfy_cli/command/models/search.py)
  // EXACTLY — every alias must resolve to the same folder as the CLI.
  const CLI_TYPE_TO_FOLDER: Record<string, string> = {
    checkpoint: "checkpoints",
    checkpoints: "checkpoints",
    lora: "loras",
    loras: "loras",
    vae: "vae",
    controlnet: "controlnet",
    upscale: "upscale_models",
    upscale_models: "upscale_models",
    clip: "clip",
    clip_vision: "clip_vision",
    unet: "diffusion_models",
    diffusion: "diffusion_models",
    diffusion_models: "diffusion_models",
    style: "style_models",
    style_models: "style_models",
    embeddings: "embeddings",
    hypernetworks: "hypernetworks",
    gligen: "gligen",
  };

  it("resolves every comfy-cli --type alias to the same folder for search", async () => {
    mocks.listLocalModels.mockResolvedValue([]);
    mocks.getSystemStats.mockResolvedValue({});
    const aliases = Object.keys(CLI_TYPE_TO_FOLDER);
    for (const type of aliases) {
      await listLocalModelsFallback({ action: "search", type });
    }
    expect(mocks.listLocalModels.mock.calls.map((c) => c[0])).toEqual(
      aliases.map((a) => CLI_TYPE_TO_FOLDER[a]),
    );
  });

  it("maps aliases for list-folder too (e.g. upscale→upscale_models, diffusion→diffusion_models)", async () => {
    mocks.listLocalModels.mockResolvedValue([]);
    mocks.getSystemStats.mockResolvedValue({});
    await listLocalModelsFallback({ action: "list-folder", folder: "upscale" });
    await listLocalModelsFallback({ action: "list-folder", folder: "diffusion" });
    await listLocalModelsFallback({ action: "list-folder", folder: "checkpoint" });
    expect(mocks.listLocalModels.mock.calls.map((c) => c[0])).toEqual([
      "upscale_models",
      "diffusion_models",
      "checkpoints",
    ]);
  });

  it("searches by text and honors the limit", async () => {
    mocks.listLocalModels.mockResolvedValue([
      model("flux_dev.safetensors", "checkpoints"),
      model("flux_schnell.safetensors", "checkpoints"),
      model("sd15.safetensors", "checkpoints"),
    ]);
    const { data } = await listLocalModelsFallback({ action: "search", text: "flux", limit: 1 });
    expect(data).toMatchObject({ count: 1, results: [{ name: "flux_dev.safetensors", type: "checkpoints" }] });
  });

  it("show returns the exact (case-insensitive) name match", async () => {
    mocks.listLocalModels.mockResolvedValue([
      model("flux_dev.safetensors", "checkpoints"),
      model("flux_schnell.safetensors", "checkpoints"),
    ]);
    const { data } = await listLocalModelsFallback({ action: "show", name: "FLUX_DEV.safetensors" });
    expect(data).toMatchObject({ name: "flux_dev.safetensors", type: "checkpoints" });
  });

  it("show does NOT substring-guess — a partial name with multiple matches is not-found", async () => {
    mocks.listLocalModels.mockResolvedValue([
      model("flux_dev.safetensors", "checkpoints"),
      model("flux_schnell.safetensors", "checkpoints"),
    ]);
    await expect(listLocalModelsFallback({ action: "show", name: "flux" })).rejects.toThrow(/was not found/i);
  });

  it("throws a clear error when neither comfy-cli nor a readable server is available", async () => {
    mocks.listLocalModels.mockResolvedValue([]);
    mocks.getSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(listLocalModelsFallback({ action: "list-folders" })).rejects.toThrow(
      /no local model source could be established/i,
    );
  });

  // #796 — "UNREACHABLE" IS A SPECIFIC CLAIM, and this said it for every way the
  // probe can fail. The remedy it offered — "connect to a running ComfyUI
  // server" — is already done in most of them.
  it("carries the REAL failure instead of asserting the server is unreachable", async () => {
    mocks.listLocalModels.mockResolvedValue([]);
    // The shape #828/#952/#954 built: something ANSWERED, and it was not the API.
    mocks.getSystemStats.mockRejectedValue(
      new Error(
        "http://127.0.0.1:8188/system_stats answered 200 with an HTML page where JSON was " +
          "expected. Content-Type: text/html.",
      ),
    );

    const err = await listLocalModelsFallback({ action: "list-folders" }).catch((e) => e as Error);

    expect(err.message, "the diagnosis must survive").toMatch(/HTML page where JSON was expected/);
    expect(err.message, "and the wrong cause must not be asserted").not.toMatch(/is unreachable/);
  });

  it("does not tell someone to connect a server that already answered", async () => {
    mocks.listLocalModels.mockResolvedValue([]);
    mocks.getSystemStats.mockRejectedValue(new Error("answered 401 Unauthorized"));

    const err = await listLocalModelsFallback({ action: "list-folders" }).catch((e) => e as Error);

    expect(err.message).toMatch(/401/);
    // "connect to a running ComfyUI server" is a dead remedy when one answered.
    expect(err.message).not.toMatch(/connect to a running ComfyUI server/);
    expect(err.message, "point at one whose API answers is the honest ask").toMatch(
      /API answers/,
    );
  });

  it("still names all three ways to fix it", async () => {
    mocks.listLocalModels.mockResolvedValue([]);
    mocks.getSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));

    const err = await listLocalModelsFallback({ action: "list-folders" }).catch((e) => e as Error);

    expect(err.message).toMatch(/comfy-cli/);
    expect(err.message).toMatch(/COMFYUI_PATH/);
    expect(err.message).toMatch(/ECONNREFUSED/);
  });

  it("returns an empty list (not an error) when the server is reachable but empty", async () => {
    mocks.listLocalModels.mockResolvedValue([]);
    mocks.getSystemStats.mockResolvedValue({});
    const { data } = await listLocalModelsFallback({ action: "list-folders" });
    expect(data).toEqual({ folders: [] });
  });
});
