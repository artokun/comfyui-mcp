import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

// Mirror how the product builds paths (resolve against config.comfyuiPath),
// so expectations/mock keys match on Windows (drive-qualified, backslashes)
// as well as POSIX.
const OUTPUT_DIR = resolve("/comfy", "output");
const outPath = (...segments: string[]): string => resolve(OUTPUT_DIR, ...segments);

vi.mock("../../config.js", () => ({
  config: {
    comfyuiPath: "/comfy" as string | undefined,
  },
}));

const getOutputImageMock = vi.fn();
vi.mock("../../services/image-management.js", () => ({
  getOutputImage: (...a: unknown[]) => getOutputImageMock(...a),
}));

const mkdirMock = vi.fn();
const readFileMock = vi.fn();
const realpathMock = vi.fn();
const lstatMock = vi.fn();
const statMock = vi.fn();
const writeFileMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  lstat: (...a: unknown[]) => lstatMock(...a),
  mkdir: (...a: unknown[]) => mkdirMock(...a),
  readFile: (...a: unknown[]) => readFileMock(...a),
  realpath: (...a: unknown[]) => realpathMock(...a),
  stat: (...a: unknown[]) => statMock(...a),
  writeFile: (...a: unknown[]) => writeFileMock(...a),
}));

const pngMock = vi.fn();
const jpegMock = vi.fn();
const webpMock = vi.fn();
const toBufferMock = vi.fn();
const sharpMock = vi.fn();
vi.mock("sharp", () => ({
  default: (...a: unknown[]) => sharpMock(...a),
}));

import { AssetRegistry } from "../../services/asset-registry.js";
import { convertImage } from "../../services/image-convert.js";
import { config } from "../../config.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

function registerAsset(filename = "hero.png"): string {
  const wf: WorkflowJSON = {
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "x" } },
  };
  const [record] = AssetRegistry.register({
    promptId: "p1",
    workflow: wf,
    outputs: [
      {
        node_id: "9",
        images: [{ filename, subfolder: "", type: "output", url: "u" }],
      },
    ],
  });
  return record.assetId;
}

beforeEach(() => {
  AssetRegistry.configure({ ttlMs: 60_000, now: Date.now });
  AssetRegistry.clear();
  config.comfyuiPath = "/comfy";
  getOutputImageMock.mockReset();
  mkdirMock.mockReset().mockResolvedValue(undefined);
  readFileMock.mockReset();
  realpathMock.mockReset().mockImplementation((path: string) => Promise.resolve(path));
  lstatMock.mockReset().mockRejectedValue(new Error("missing"));
  statMock.mockReset().mockResolvedValue({ isFile: () => true, size: Buffer.byteLength("large-source") });
  writeFileMock.mockReset().mockResolvedValue(undefined);
  pngMock.mockReset();
  jpegMock.mockReset();
  webpMock.mockReset();
  toBufferMock.mockReset().mockResolvedValue(Buffer.from("small"));
  const chain = {
    png: pngMock.mockReturnThis(),
    jpeg: jpegMock.mockReturnThis(),
    webp: webpMock.mockReturnThis(),
    toBuffer: toBufferMock,
  };
  sharpMock.mockReset().mockReturnValue(chain);
});

describe("convertImage", () => {
  it.each([
    ["png" as const, "image/png", pngMock, { quality: 80 }],
    ["jpeg" as const, "image/jpeg", jpegMock, { quality: 75, progressive: true }],
    ["webp" as const, "image/webp", webpMock, { quality: 70, lossless: false, effort: 5 }],
  ])("converts asset sources to %s inline", async (format, mimeType, encoder, options) => {
    const assetId = registerAsset();
    getOutputImageMock.mockResolvedValueOnce({
      base64: Buffer.from("source-data").toString("base64"),
      mimeType: "image/png",
      filename: "hero.png",
    });

    const result = await convertImage({ asset_id: assetId, format, ...options });

    expect(getOutputImageMock).toHaveBeenCalledWith("hero.png", "output", "");
    expect(sharpMock).toHaveBeenCalledWith(
      Buffer.from("source-data"),
      expect.objectContaining({ limitInputPixels: expect.any(Number) }),
    );
    expect(encoder).toHaveBeenCalledWith(expect.objectContaining(options));
    expect(result.mimeType).toBe(mimeType);
    expect(result.outputBytes).toBe(5);
    expect(result.bytesSaved).toBe(Buffer.byteLength("source-data") - 5);
    expect(result.content).toContainEqual({
      type: "image",
      data: Buffer.from("small").toString("base64"),
      mimeType,
    });
  });

  it("converts a path source under the output directory and writes out_path", async () => {
    readFileMock.mockResolvedValueOnce(Buffer.from("large-source"));

    const result = await convertImage({
      path: "nested/source.png",
      format: "webp",
      quality: 60,
      out_path: "converted/source.webp",
    });

    expect(statMock).toHaveBeenCalledWith(outPath("nested", "source.png"));
    expect(readFileMock).toHaveBeenCalledWith(outPath("nested", "source.png"));
    expect(webpMock).toHaveBeenCalledWith({ quality: 60, lossless: undefined, effort: undefined });
    expect(mkdirMock).toHaveBeenCalledWith(outPath("converted"), { recursive: true });
    expect(writeFileMock).toHaveBeenCalledWith(outPath("converted", "source.webp"), Buffer.from("small"));
    expect(result.outPath).toBe(outPath("converted", "source.webp"));
    expect(result.sourceBytes).toBe(Buffer.byteLength("large-source"));
    expect(result.bytesSaved).toBe(Buffer.byteLength("large-source") - 5);
    const text = result.content.find((c) => c.type === "text") as { text: string };
    expect(JSON.parse(text.text)).toMatchObject({
      output_bytes: 5,
      bytes_saved: Buffer.byteLength("large-source") - 5,
      out_path: outPath("converted", "source.webp"),
    });
  });

  it("rejects path traversal before reading source files", async () => {
    await expect(
      convertImage({ path: "../secret.png", format: "jpeg" }),
    ).rejects.toThrow(/output directory/i);
    expect(statMock).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("rejects source symlinks that escape the output directory", async () => {
    realpathMock.mockImplementation((path: string) => {
      if (path === OUTPUT_DIR) return Promise.resolve(OUTPUT_DIR);
      if (path === outPath("link", "secret.png")) return Promise.resolve("/tmp/secret.png");
      return Promise.resolve(path);
    });

    await expect(
      convertImage({ path: "link/secret.png", format: "jpeg" }),
    ).rejects.toThrow(/output directory/i);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("rejects path traversal in out_path before writing", async () => {
    readFileMock.mockResolvedValueOnce(Buffer.from("large-source"));

    await expect(
      convertImage({ path: "source.png", format: "jpeg", out_path: "../x.jpg" }),
    ).rejects.toThrow(/output directory/i);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("rejects out_path symlinked parents that escape the output directory", async () => {
    readFileMock.mockResolvedValueOnce(Buffer.from("large-source"));
    realpathMock.mockImplementation((path: string) => {
      if (path === OUTPUT_DIR) return Promise.resolve(OUTPUT_DIR);
      if (path === outPath("link")) return Promise.resolve("/tmp/outside");
      return Promise.resolve(path);
    });

    await expect(
      convertImage({ path: "source.png", format: "webp", out_path: "link/out.webp" }),
    ).rejects.toThrow(/output directory/i);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("rejects path sources above the configured byte cap before reading", async () => {
    const oldCap = process.env.COMFYUI_CONVERT_IMAGE_MAX_SOURCE_BYTES;
    process.env.COMFYUI_CONVERT_IMAGE_MAX_SOURCE_BYTES = "4";
    statMock.mockResolvedValueOnce({ isFile: () => true, size: 5 });
    try {
      await expect(
        convertImage({ path: "huge.png", format: "jpeg" }),
      ).rejects.toThrow(/too large/i);
      expect(readFileMock).not.toHaveBeenCalled();
    } finally {
      if (oldCap === undefined) delete process.env.COMFYUI_CONVERT_IMAGE_MAX_SOURCE_BYTES;
      else process.env.COMFYUI_CONVERT_IMAGE_MAX_SOURCE_BYTES = oldCap;
    }
  });

  it("validates quality and effort ranges before resolving the source", async () => {
    const assetId = registerAsset();
    await expect(
      convertImage({ asset_id: assetId, format: "jpeg", quality: 101 }),
    ).rejects.toThrow(/quality/i);
    await expect(
      convertImage({ asset_id: assetId, format: "webp", effort: 7 }),
    ).rejects.toThrow(/effort/i);
    expect(getOutputImageMock).not.toHaveBeenCalled();
  });

  it("rejects missing assets clearly", async () => {
    await expect(
      convertImage({ asset_id: "a_missing", format: "webp" }),
    ).rejects.toThrow(/No asset found/);
  });
});
