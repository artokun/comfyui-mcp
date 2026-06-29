import { describe, expect, it, beforeEach, vi } from "vitest";
import { upscaleImage, type UpscaleImageDeps } from "../../services/upscale-image.js";
import { DefaultsManager } from "../../services/defaults-manager.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

function makeDeps(overrides: Partial<UpscaleImageDeps> = {}) {
  const enqueued: WorkflowJSON[] = [];
  const deps: UpscaleImageDeps = {
    resolveUpscaleModel: vi.fn(async () => "auto_4x.pth"),
    enqueue: async (wf) => {
      enqueued.push(wf);
      return { prompt_id: "pid-upscale", queue_remaining: 0 };
    },
    ...overrides,
  };
  return { deps, enqueued };
}

function node(wf: WorkflowJSON, type: string) {
  return Object.values(wf).find((n) => n.class_type === type);
}

describe("upscaleImage", () => {
  beforeEach(() => {
    DefaultsManager.reset();
    DefaultsManager.configure({ configPath: "/tmp/__never__.json", env: {} });
  });

  it("builds an UpscaleModelLoader → ImageUpscaleWithModel graph at default 4x", async () => {
    const { deps, enqueued } = makeDeps();
    const res = await upscaleImage({ image: "photo.png", model: "4x-UltraSharp.pth" }, deps);

    expect(res.scale).toBe(4);
    const wf = enqueued[0];
    expect(node(wf, "LoadImage")!.inputs.image).toBe("photo.png");
    expect(node(wf, "UpscaleModelLoader")!.inputs.model_name).toBe("4x-UltraSharp.pth");
    const upscale = node(wf, "ImageUpscaleWithModel")!;
    expect(upscale.inputs.upscale_model).toEqual(["2", 0]);
    expect(upscale.inputs.image).toEqual(["1", 0]);
    // At 4x there is no downsample node; SaveImage reads the upscale output.
    expect(node(wf, "ImageScaleBy")).toBeUndefined();
    expect(node(wf, "SaveImage")!.inputs.images).toEqual(["3", 0]);
  });

  it("inserts an ImageScaleBy 0.5 downsample for scale=2", async () => {
    const { deps, enqueued } = makeDeps();
    const res = await upscaleImage({ image: "photo.png", model: "m.pth", scale: 2 }, deps);

    expect(res.scale).toBe(2);
    const wf = enqueued[0];
    const downsample = node(wf, "ImageScaleBy")!;
    expect(downsample.inputs.scale_by).toBe(0.5);
    expect(downsample.inputs.image).toEqual(["3", 0]);
    // SaveImage now reads the downsampled image, not the raw 4x output.
    expect(node(wf, "SaveImage")!.inputs.images).toEqual(["4", 0]);
  });

  it("auto-resolves the upscale model when none is given", async () => {
    const { deps, enqueued } = makeDeps();
    const res = await upscaleImage({ image: "photo.png" }, deps);
    expect(deps.resolveUpscaleModel).toHaveBeenCalledOnce();
    expect(node(enqueued[0], "UpscaleModelLoader")!.inputs.model_name).toBe("auto_4x.pth");
    expect(res.model).toBe("auto_4x.pth");
  });

  it("throws an actionable error when no upscale model can be resolved", async () => {
    const { deps } = makeDeps({ resolveUpscaleModel: async () => undefined });
    await expect(upscaleImage({ image: "photo.png" }, deps)).rejects.toThrow(
      /upscale_models|download_model|model/i,
    );
  });

  it("backfills the model from defaults", async () => {
    await DefaultsManager.set({ upscale_model: "def_4x.pth" });
    const { deps, enqueued } = makeDeps();
    await upscaleImage({ image: "photo.png" }, deps);
    expect(node(enqueued[0], "UpscaleModelLoader")!.inputs.model_name).toBe("def_4x.pth");
  });

  it("throws when image is missing", async () => {
    const { deps } = makeDeps();
    await expect(upscaleImage({ image: "" }, deps)).rejects.toThrow(/image is required/i);
  });
});
