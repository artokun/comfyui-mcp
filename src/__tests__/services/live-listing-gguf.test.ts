// #2447 — apply_manifest validates existing files via liveListingHasBasename /
// liveListingHasEntry, which used to query ONLY the core category
// (`/models/text_encoders`, `/models/unet`). Core listings omit .gguf
// (supported_pt_extensions). ComfyUI-GGUF serves the same files through
// clip_gguf / unet_gguf — the inventory list_local_models already reads.
//
// These tests drive those SHIPPED functions against a fake /models server.
// A parallel checker that reimplements the mapping would pass while
// apply_manifest kept failing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** Per-category `/models/<cat>` body. Missing key → HTTP 404. */
  liveListings: {} as Record<string, string[] | undefined>,
  /** GET /models registry. undefined → derive from liveListings keys. */
  registry: undefined as string[] | undefined | "fail",
  fetchCalls: [] as string[],
}));

vi.mock("../../config.js", () => ({
  config: { comfyuiPath: "/comfy", huggingfaceToken: undefined, civitaiApiToken: undefined },
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyuiTargetGeneration: () => 0,
  isRemoteMode: () => false,
}));

vi.mock("../../comfyui/client.js", () => {
  const listingFetch = async (path: string) => {
    h.fetchCalls.push(path);
    if (path === "/models" || path === "/models/") {
      if (h.registry === "fail") return { ok: false, status: 500, json: async () => null };
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

const { liveListingHasBasename, liveListingHasEntry } = await import(
  "../../services/model-resolver.js"
);

beforeEach(() => {
  h.liveListings = {};
  h.registry = undefined;
  h.fetchCalls = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("liveListingHasBasename — GGUF custom categories (#2447)", () => {
  it("treats a text-encoder GGUF listed under clip_gguf as present", async () => {
    // The reporter's umt5-xxl-encoder-Q5_K_S.gguf: on disk under
    // models/text_encoders, served by ComfyUI-GGUF as clip_gguf, absent from
    // core /models/text_encoders (no .gguf in supported_pt_extensions).
    h.liveListings.text_encoders = ["umt5_xxl_fp8_e4m3fn.safetensors"];
    h.liveListings.clip_gguf = ["umt5-xxl-encoder-Q5_K_S.gguf"];

    await expect(
      liveListingHasBasename("text_encoders", "umt5-xxl-encoder-Q5_K_S.gguf"),
    ).resolves.toBe(true);
    expect(h.fetchCalls).toContain("/models/clip_gguf");
  });

  it("treats a unet GGUF listed under unet_gguf as present even when /models/unet 404s", async () => {
    // Modern ComfyUI 404s the legacy `unet` category (renamed to diffusion_models).
    // apply_manifest still targets models/unet/… from the wan-longer-videos-i2v
    // pack. Unfixed this is `undefined` ("could not be asked"); with ComfyUI-GGUF
    // the same file is in /models/unet_gguf.
    h.liveListings.unet_gguf = [
      "Wan2.2-I2V-A14B-HighNoise-Q4_K_S.gguf",
      "Wan2.2-I2V-A14B-LowNoise-Q4_K_S.gguf",
    ];

    await expect(
      liveListingHasBasename("unet", "Wan2.2-I2V-A14B-HighNoise-Q4_K_S.gguf"),
    ).resolves.toBe(true);
    await expect(
      liveListingHasBasename("unet", "Wan2.2-I2V-A14B-LowNoise-Q4_K_S.gguf"),
    ).resolves.toBe(true);
  });

  it("treats a diffusion_models GGUF listed under unet_gguf as present", async () => {
    h.liveListings.diffusion_models = ["flux1-dev.safetensors"];
    h.liveListings.unet_gguf = ["flux-Q4.gguf"];

    await expect(liveListingHasBasename("diffusion_models", "flux-Q4.gguf")).resolves.toBe(true);
  });

  it("still returns true when the core category itself lists the .gguf", async () => {
    h.liveListings.diffusion_models = ["new.gguf"];

    await expect(liveListingHasBasename("diffusion_models", "new.gguf")).resolves.toBe(true);
  });

  it("returns false when a registered GGUF view does not list the file", async () => {
    h.liveListings.text_encoders = ["clip.safetensors"];
    h.liveListings.clip_gguf = ["other-encoder.gguf"];

    await expect(liveListingHasBasename("text_encoders", "missing.gguf")).resolves.toBe(false);
  });

  it("does not treat a core .gguf miss as a determined negative when no GGUF view is registered", async () => {
    // Absence from /models/text_encoders is contractual for .gguf. Without a
    // clip_gguf category the server cannot name the file, so the answer is
    // unknown — never "the server does not list it under text_encoders".
    h.liveListings.text_encoders = ["clip.safetensors"];

    await expect(
      liveListingHasBasename("text_encoders", "umt5-xxl-encoder-Q5_K_S.gguf"),
    ).resolves.toBeUndefined();
  });

  it("does not consult GGUF views for a non-gguf file", async () => {
    h.liveListings.text_encoders = ["clip.safetensors"];
    h.liveListings.clip_gguf = ["clip.safetensors"];

    await expect(liveListingHasBasename("text_encoders", "clip.safetensors")).resolves.toBe(true);
    await expect(liveListingHasBasename("text_encoders", "missing.safetensors")).resolves.toBe(
      false,
    );
    expect(h.fetchCalls.filter((p) => p.includes("clip_gguf"))).toEqual([]);
  });

  it("still finds a GGUF when GET /models fails but the alias listing answers", async () => {
    h.registry = "fail";
    h.liveListings.text_encoders = [];
    h.liveListings.clip_gguf = ["umt5-xxl-encoder-Q5_K_S.gguf"];

    await expect(
      liveListingHasBasename("text_encoders", "umt5-xxl-encoder-Q5_K_S.gguf"),
    ).resolves.toBe(true);
  });
});

describe("liveListingHasEntry — GGUF custom categories (#2447)", () => {
  it("matches the exact category-relative path in the GGUF view", async () => {
    h.liveListings.text_encoders = [];
    h.liveListings.clip_gguf = ["nested/umt5-xxl-encoder-Q5_K_S.gguf"];

    await expect(
      liveListingHasEntry("text_encoders/nested", "umt5-xxl-encoder-Q5_K_S.gguf"),
    ).resolves.toBe(true);
  });

  it("does not satisfy a nested target from a different relative path in clip_gguf", async () => {
    h.liveListings.text_encoders = [];
    h.liveListings.clip_gguf = ["other/umt5-xxl-encoder-Q5_K_S.gguf"];

    await expect(
      liveListingHasEntry("text_encoders/nested", "umt5-xxl-encoder-Q5_K_S.gguf"),
    ).resolves.toBe(false);
  });
});
