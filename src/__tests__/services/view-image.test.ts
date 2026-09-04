import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("../../services/image-management.js", () => ({
  getOutputImage: vi.fn(),
}));

import { AssetRegistry } from "../../services/asset-registry.js";
import { viewAssetImage } from "../../services/view-image.js";
import { getOutputImage } from "../../services/image-management.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

const mockedGetOutputImage = vi.mocked(getOutputImage);

function register(filename: string, type = "output", subfolder = ""): string {
  const wf: WorkflowJSON = {
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "x" } },
  };
  const [rec] = AssetRegistry.register({
    promptId: "p1",
    workflow: wf,
    outputs: [
      {
        node_id: "9",
        images: [{ filename, subfolder, type, url: "u" }],
      },
    ],
  });
  return rec.assetId;
}

describe("viewAssetImage", () => {
  beforeEach(() => {
    AssetRegistry.configure({ ttlMs: 60_000, now: Date.now });
    AssetRegistry.clear();
    mockedGetOutputImage.mockReset();
  });

  it("returns an image content block for a registered PNG asset", async () => {
    const assetId = register("hero.png");
    mockedGetOutputImage.mockResolvedValueOnce({
      base64: "aGVsbG8=",
      mimeType: "image/png",
      filename: "hero.png",
    });

    const result = await viewAssetImage(assetId);
    expect(mockedGetOutputImage).toHaveBeenCalledWith("hero.png", "output", "");
    const image = result.content.find((c) => c.type === "image");
    expect(image).toBeDefined();
    expect(image).toMatchObject({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
  });

  it("throws when asset_id is unknown or expired", async () => {
    await expect(viewAssetImage("a_deadbeef")).rejects.toThrow(/No asset found/);
    expect(mockedGetOutputImage).not.toHaveBeenCalled();
  });

  it("rejects unsupported mime types (e.g. audio/video)", async () => {
    const assetId = register("song.flac");
    mockedGetOutputImage.mockResolvedValueOnce({
      base64: "x",
      mimeType: "audio/flac",
      filename: "song.flac",
    });
    await expect(viewAssetImage(assetId)).rejects.toThrow(/not an image/i);
  });

  it("passes through subfolder and type to the fetcher", async () => {
    const assetId = register("a.png", "temp", "preview");
    mockedGetOutputImage.mockResolvedValueOnce({
      base64: "x",
      mimeType: "image/png",
      filename: "a.png",
    });
    await viewAssetImage(assetId);
    expect(mockedGetOutputImage).toHaveBeenCalledWith("a.png", "temp", "preview");
  });

  it("includes a text summary alongside the image block", async () => {
    const assetId = register("b.jpg");
    mockedGetOutputImage.mockResolvedValueOnce({
      base64: "x",
      mimeType: "image/jpeg",
      filename: "b.jpg",
    });
    const result = await viewAssetImage(assetId);
    const text = result.content.find((c) => c.type === "text");
    expect(text).toBeDefined();
    expect((text as { text: string }).text).toContain(assetId);
    expect((text as { text: string }).text).toContain("b.jpg");
  });
});

describe("#2692 the prescribed recovery names the asset's DIRECTORY", () => {
  // `get_image action:"get"` defaults to `args.type ?? "output"`. A prescription
  // that omits the type therefore fetches output/ for an asset living in input/ or
  // temp/ — the wrong file, or none, exactly when the inline preview was refused
  // and this string is the only instruction the caller has.
  it("adds type: for a non-output asset, on both prescriptions", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../services/view-image.ts", import.meta.url)),
      "utf8",
    );
    // One builder, used by both sites, so they cannot drift apart.
    expect(src).toMatch(/const getArgs = \(\): string =>/);
    expect(src).toMatch(/fetchType === "output" \? "" : `, type:"\$\{fetchType\}"`/);
    const uses = src.match(/\$\{getArgs\(\)\}/g) ?? [];
    expect(uses.length).toBe(2);
    // The regression: a prescription built from filename/subfolder alone.
    expect(src).not.toMatch(/action:"get", filename:"\$\{record\.filename\}"/);
  });
});
