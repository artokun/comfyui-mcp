import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../config.js", () => ({
  config: { comfyuiPath: "/comfy" as string | undefined },
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  copyFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
}));

const fetchImageMock = vi.fn();
const uploadImageHttpMock = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  fetchImage: (...a: unknown[]) => fetchImageMock(...a),
  uploadImageHttp: (...a: unknown[]) => uploadImageHttpMock(...a),
}));

import { getOutputImage } from "../../services/image-management.js";
import { ValidationError } from "../../utils/errors.js";

beforeEach(() => {
  vi.clearAllMocks();
  fetchImageMock.mockResolvedValue({
    base64: "aGVsbG8=",
    mimeType: "image/png",
  });
});

describe("getOutputImage — happy path (legitimate ComfyUI references)", () => {
  it("accepts a plain filename in the output root", async () => {
    await expect(
      getOutputImage("hero_00001_.png", "output", ""),
    ).resolves.toBeDefined();
    expect(fetchImageMock).toHaveBeenCalledWith("hero_00001_.png", "output", "");
  });

  it("accepts a nested subfolder ComfyUI legitimately writes to (e.g. video/clip)", async () => {
    await expect(
      getOutputImage("clip_00001_.mp4", "output", "video/clip"),
    ).resolves.toBeDefined();
    expect(fetchImageMock).toHaveBeenCalledWith(
      "clip_00001_.mp4",
      "output",
      "video/clip",
    );
  });

  it("accepts an empty subfolder (top-level output)", async () => {
    await expect(
      getOutputImage("a.png", "temp", ""),
    ).resolves.toBeDefined();
  });
});

describe("getOutputImage — path-traversal sanitisation (CWE-22)", () => {
  // ComfyUI's /view endpoint historically allows path traversal via the
  // subfolder parameter. Untrusted MCP tool inputs must be rejected BEFORE
  // they are forwarded to the server.

  it("rejects a subfolder containing '..' traversal", async () => {
    await expect(
      getOutputImage("hero.png", "output", "../../etc"),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });

  it("rejects a subfolder that is a pure '..'", async () => {
    await expect(
      getOutputImage("hero.png", "output", ".."),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });

  it("rejects an absolute POSIX subfolder", async () => {
    await expect(
      getOutputImage("hero.png", "output", "/etc"),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });

  it("rejects an absolute Windows-style subfolder", async () => {
    await expect(
      getOutputImage("hero.png", "output", "C:\\Windows"),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });

  it("rejects a subfolder containing NUL bytes", async () => {
    await expect(
      getOutputImage("hero.png", "output", "ok\u0000../etc"),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });

  it("rejects a filename containing path separators", async () => {
    await expect(
      getOutputImage("../../etc/passwd", "output", ""),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });

  it("rejects a filename with a backslash separator", async () => {
    await expect(
      getOutputImage("..\\..\\windows\\win.ini", "output", ""),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });

  it("rejects a filename that is '..'", async () => {
    await expect(
      getOutputImage("..", "output", ""),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });

  it("rejects an empty filename", async () => {
    await expect(
      getOutputImage("", "output", ""),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });

  it("rejects a subfolder containing a NUL byte even if it looks safe", async () => {
    await expect(
      getOutputImage("hero.png", "output", "video\u0000/../.."),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });

  it("rejects a subfolder with an embedded '..' segment between safe parts", async () => {
    await expect(
      getOutputImage("hero.png", "output", "video/../.."),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });
});
