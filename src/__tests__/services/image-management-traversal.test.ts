import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolve } from "node:path";

const mockConfig = vi.hoisted(() => ({
  comfyuiPath: "/comfy" as string | undefined,
  remote: false,
}));

vi.mock("../../config.js", () => ({
  config: mockConfig,
  isCloudMode: () => false,
  isRemoteMode: () => mockConfig.remote,
}));

const readdirMock = vi.fn();
const readFileMock = vi.fn();
const openMock = vi.fn();
const realpathMock = vi.fn();
const statMock = vi.fn();
const resolveInputDirMock = vi.fn();
const resolveOutputDirMock = vi.fn();
const resolveTempDirMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  readFile: (...a: unknown[]) => readFileMock(...a),
  open: (...a: unknown[]) => openMock(...a),
  copyFile: vi.fn(),
  readdir: (...a: unknown[]) => readdirMock(...a),
  realpath: (...a: unknown[]) => realpathMock(...a),
  stat: (...a: unknown[]) => statMock(...a),
}));

vi.mock("../../services/output-dir.js", () => ({
  resolveInputDir: (...a: unknown[]) => resolveInputDirMock(...a),
  resolveOutputDir: (...a: unknown[]) => resolveOutputDirMock(...a),
  resolveTempDir: (...a: unknown[]) => resolveTempDirMock(...a),
}));

const fetchImageMock = vi.fn();
const uploadImageHttpMock = vi.fn();
const getHistoryMock = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  MAX_VIEW_RESPONSE_BYTES: 32 * 1024 * 1024,
  MAX_PREVIEW_SOURCE_BYTES: 64 * 1024 * 1024,
  fetchImage: (...a: unknown[]) => fetchImageMock(...a),
  uploadImageHttp: (...a: unknown[]) => uploadImageHttpMock(...a),
  getHistory: (...a: unknown[]) => getHistoryMock(...a),
}));

import { getOutputImage, listOutputImages } from "../../services/image-management.js";
import { ValidationError, ComfyUIError } from "../../utils/errors.js";

beforeEach(() => {
  mockConfig.comfyuiPath = "/comfy";
  mockConfig.remote = false;
  readdirMock.mockReset();
  getHistoryMock.mockReset().mockResolvedValue({});
  const bytes = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  ]);
  let position = 0;
  openMock.mockReset().mockResolvedValue({
    read: async (buffer: Buffer, offset: number, length: number) => {
      const slice = bytes.subarray(position, position + length);
      slice.copy(buffer, offset);
      position += slice.length;
      return { bytesRead: slice.length, buffer };
    },
    close: async () => undefined,
  });
  resolveInputDirMock.mockReset().mockResolvedValue(resolve("/comfy", "input"));
  resolveOutputDirMock.mockReset().mockResolvedValue(resolve("/comfy", "output"));
  resolveTempDirMock.mockReset().mockResolvedValue(resolve("/comfy", "temp"));
});

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

  it("accepts a get_history filename that already includes a relative subfolder (#2526)", async () => {
    // get_history (action:"list") prints media as `subfolder/filename` so
    // callers paste that combined string into get_image. That is a valid
    // ComfyUI output reference, not a traversal.
    await expect(
      getOutputImage(
        "out_F/qwen_baseline_face016_2807_00001_.png",
        "output",
        "",
      ),
    ).resolves.toBeDefined();
    expect(fetchImageMock).toHaveBeenCalledWith(
      "qwen_baseline_face016_2807_00001_.png",
      "output",
      "out_F",
    );
  });

  it("accepts a nested relative prefix in filename and splits it for /view (#2526)", async () => {
    await expect(
      getOutputImage("video/clip/frame.png", "output", ""),
    ).resolves.toBeDefined();
    expect(fetchImageMock).toHaveBeenCalledWith("frame.png", "output", "video/clip");
  });

  it("joins a filename prefix with an explicit subfolder (#2526)", async () => {
    await expect(
      getOutputImage("clip/frame.png", "output", "video"),
    ).resolves.toBeDefined();
    expect(fetchImageMock).toHaveBeenCalledWith("frame.png", "output", "video/clip");
  });

  it("treats a Windows-style relative prefix as a subfolder too (#2526)", async () => {
    await expect(
      getOutputImage("out_F\\face.png", "output", ""),
    ).resolves.toBeDefined();
    expect(fetchImageMock).toHaveBeenCalledWith("face.png", "output", "out_F");
  });

  it("accepts an empty subfolder (top-level output)", async () => {
    await expect(
      getOutputImage("a.png", "temp", ""),
    ).resolves.toBeDefined();
  });

  it("accepts a non-empty allowlisted OBJ attachment served as octet-stream", async () => {
    const obj = Buffer.from("# mesh\nv 0 0 0\n", "utf8");
    fetchImageMock.mockResolvedValue({
      base64: obj.toString("base64"),
      mimeType: "application/octet-stream",
    });

    await expect(
      getOutputImage("mesh.OBJ", "output", "meshes", { allowAttachment: true }),
    ).resolves.toMatchObject({
      base64: obj.toString("base64"),
      mimeType: "application/octet-stream",
      filename: "mesh.OBJ",
    });
  });

  it("does not allow an octet-stream attachment without the explicit opt-in", async () => {
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from("mesh", "utf8").toString("base64"),
      mimeType: "application/octet-stream",
    });

    await expect(getOutputImage("mesh.obj", "output", "", {})).rejects.toMatchObject({
      code: "ATTACHMENT_TYPE_UNSUPPORTED",
    });
  });

  it.each([
    ["wrong extension", "mesh.txt", "application/octet-stream", "bWVzaA=="],
    ["wrong MIME", "mesh.obj", "model/obj", "bWVzaA=="],
    ["empty body", "mesh.obj", "application/octet-stream", ""],
  ])("rejects an attachment with %s", async (_label, filename, mimeType, base64) => {
    fetchImageMock.mockResolvedValue({ base64, mimeType });

    await expect(
      getOutputImage(filename, "output", "", { allowAttachment: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });
});

describe("getOutputImage — ZIP attachments (#2858)", () => {
  const zipLocal = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
  const zipEmptyArchive = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00]);
  const zipSpanned = Buffer.from([0x50, 0x4b, 0x07, 0x08, 0x00, 0x00, 0x00, 0x00]);
  const zipFilename = "PCIDOL_Smart_Save_Suite_Image_v0.6.3_Video_v0.6.6.zip";

  it("accepts a ZIP labeled application/zip with PK local-file magic", async () => {
    fetchImageMock.mockResolvedValue({
      base64: zipLocal.toString("base64"),
      mimeType: "application/zip",
    });

    await expect(
      getOutputImage(zipFilename, "input", "", { allowAttachment: true }),
    ).resolves.toMatchObject({
      base64: zipLocal.toString("base64"),
      mimeType: "application/zip",
      filename: zipFilename,
    });
  });

  it("accepts application/x-zip-compressed with PK magic", async () => {
    fetchImageMock.mockResolvedValue({
      base64: zipLocal.toString("base64"),
      mimeType: "application/x-zip-compressed",
    });

    await expect(
      getOutputImage("suite.zip", "input", "", { allowAttachment: true }),
    ).resolves.toMatchObject({
      mimeType: "application/x-zip-compressed",
      filename: "suite.zip",
    });
  });

  it("accepts application/octet-stream ZIP with PK magic", async () => {
    fetchImageMock.mockResolvedValue({
      base64: zipLocal.toString("base64"),
      mimeType: "application/octet-stream",
    });

    await expect(
      getOutputImage("suite.zip", "input", "", { allowAttachment: true }),
    ).resolves.toMatchObject({
      mimeType: "application/octet-stream",
      filename: "suite.zip",
    });
  });

  it.each([
    ["empty-archive EOCD", zipEmptyArchive],
    ["spanned archive", zipSpanned],
  ])("accepts PK %s signature", async (_label, bytes) => {
    fetchImageMock.mockResolvedValue({
      base64: bytes.toString("base64"),
      mimeType: "application/zip",
    });

    await expect(
      getOutputImage("empty.zip", "input", "", { allowAttachment: true }),
    ).resolves.toMatchObject({ filename: "empty.zip", mimeType: "application/zip" });
  });

  it.each([
    ["HTML login page", Buffer.from("<html>login</html>", "utf8").toString("base64")],
    ["JSON error envelope", Buffer.from('{"error":"not found"}', "utf8").toString("base64")],
  ])("refuses a ZIP-labeled %s as IMAGE_NOT_FOUND", async (_label, base64) => {
    fetchImageMock.mockResolvedValue({ base64, mimeType: "application/zip" });

    await expect(
      getOutputImage("suite.zip", "input", "", { allowAttachment: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("refuses an empty ZIP body as IMAGE_NOT_FOUND", async () => {
    fetchImageMock.mockResolvedValue({ base64: "", mimeType: "application/zip" });

    await expect(
      getOutputImage("suite.zip", "input", "", { allowAttachment: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("refuses a real ZIP without allowAttachment as ATTACHMENT_TYPE_UNSUPPORTED", async () => {
    fetchImageMock.mockResolvedValue({
      base64: zipLocal.toString("base64"),
      mimeType: "application/zip",
    });

    await expect(getOutputImage("suite.zip", "input", "")).rejects.toMatchObject({
      code: "ATTACHMENT_TYPE_UNSUPPORTED",
    });
  });

  it("still refuses model/obj MIME on an OBJ even when ZIP MIME is accepted", async () => {
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from("# mesh\n", "utf8").toString("base64"),
      mimeType: "model/obj",
    });

    await expect(
      getOutputImage("mesh.obj", "output", "", { allowAttachment: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("does not treat foo.txt labeled application/zip as an attachment", async () => {
    fetchImageMock.mockResolvedValue({
      base64: zipLocal.toString("base64"),
      mimeType: "application/zip",
    });

    await expect(
      getOutputImage("foo.txt", "input", "", { allowAttachment: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });
});

describe("getOutputImage — local fallback for ComfyUI's 400 rejection (#2194)", () => {
  const filename = "dreamina-2026-08-12-1653-Locked-off camera, static 16_9 frame.smo....mp4";
  const mp4 = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  ]);

  function view400(): ComfyUIError {
    return new ComfyUIError(
      `ComfyUI /view returned 400 for "${filename}" (input).`,
      "VIEW_ERROR",
      { status: 400, filename, type: "input", subfolder: "" },
    );
  }

  it("reads a valid repeated-period input video from the local ComfyUI directory", async () => {
    const root = resolve("/comfy", "input");
    const localPath = resolve(root, filename);
    fetchImageMock.mockRejectedValue(view400());
    realpathMock.mockImplementation(async (path: string) => path);
    statMock.mockResolvedValue({ isFile: () => true });
    readFileMock.mockResolvedValue(mp4);

    await expect(getOutputImage(filename, "input", "", { allowMedia: true })).resolves.toMatchObject({
      base64: mp4.toString("base64"),
      mimeType: "video/mp4",
      filename,
    });
    expect(realpathMock).toHaveBeenCalledWith(root);
    expect(realpathMock).toHaveBeenCalledWith(localPath);
    expect(openMock).toHaveBeenCalledWith(localPath, "r");
  });

  it("preserves image/avif through the local 400 fallback and validates the bytes", async () => {
    const avifFilename = "frame.avif";
    const avif = Buffer.from(
      "AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANRtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+AABAAAAAAAAACAAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVGlwcnAAAAA2aXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAAIAAAACAAAADnBpeGkAAAAAAQgAAAAWaXBtYQAAAAAAAAABAAEDgQIDAAAAKG1kYXQSAAoHOAA2kBDQaTITGUJjBMAANAAAkEDJHGFCYtTGSg==",
      "base64",
    );
    const root = resolve("/comfy", "input");
    const localPath = resolve(root, avifFilename);
    let position = 0;
    fetchImageMock.mockRejectedValue(
      new ComfyUIError(
        `ComfyUI /view returned 400 for "${avifFilename}" (input).`,
        "VIEW_ERROR",
        { status: 400, filename: avifFilename, type: "input", subfolder: "" },
      ),
    );
    realpathMock.mockImplementation(async (path: string) => path);
    statMock.mockResolvedValue({ isFile: () => true, size: avif.length });
    openMock.mockResolvedValue({
      read: async (buffer: Buffer, offset: number, length: number) => {
        const slice = avif.subarray(position, position + length);
        slice.copy(buffer, offset);
        position += slice.length;
        return { bytesRead: slice.length, buffer };
      },
      close: async () => undefined,
    });

    await expect(
      getOutputImage(avifFilename, "input", "", { requireImageContent: true }),
    ).resolves.toMatchObject({ base64: avif.toString("base64"), mimeType: "image/avif" });
    expect(realpathMock).toHaveBeenCalledWith(root);
    expect(realpathMock).toHaveBeenCalledWith(localPath);
  });

  it.each([
    ["a filename traversal", "../outside.mp4", ""],
    ["a subfolder traversal", "safe.mp4", "../outside"],
    ["a filename drive-relative path", "C:outside.mp4", ""],
    ["a subfolder drive-relative path", "safe.mp4", "C:outside"],
  ])("rejects %s before the local fallback can read it", async (_label, name, subfolder) => {
    fetchImageMock.mockRejectedValue(view400());

    await expect(getOutputImage(name, "input", subfolder, { allowMedia: true })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(realpathMock).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("preserves the 400 when canonical containment detects an escaping symlink", async () => {
    const error = view400();
    const root = resolve("/comfy", "input");
    fetchImageMock.mockRejectedValue(error);
    realpathMock.mockImplementation(async (path: string) =>
      path === root ? root : resolve("/outside", filename),
    );
    statMock.mockResolvedValue({ isFile: () => true });

    await expect(getOutputImage(filename, "input", "", { allowMedia: true })).rejects.toBe(error);
    expect(readFileMock).not.toHaveBeenCalled();
  });
});

describe("getOutputImage — oversized PNG preview source (#2785)", () => {
  const filename = "NC04_4X_UPSCALE_00002_.png";
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const previewCap = 64 * 1024 * 1024;

  function viewTooLarge(maxBytes = 32 * 1024 * 1024): ComfyUIError {
    return new ComfyUIError(
      `ComfyUI /view response for "${filename}" exceeds the ${maxBytes / 1024 ** 2} MB safety limit.`,
      "VIEW_TOO_LARGE",
      { filename, maxBytes },
    );
  }

  function fileHandleFor(bytes: Buffer) {
    let position = 0;
    return {
      read: async (buffer: Buffer, offset: number, length: number) => {
        const slice = bytes.subarray(position, position + length);
        slice.copy(buffer, offset);
        position += slice.length;
        return { bytesRead: slice.length, buffer };
      },
      close: async () => undefined,
    };
  }

  it("asks /view for 64 MB when the caller will downscale a still image", async () => {
    await getOutputImage(filename, "output", "", { forInlinePreview: true });
    expect(fetchImageMock).toHaveBeenCalledWith(filename, "output", "", { maxBytes: previewCap });
  });

  it("does not raise the cap for video even when a preview was requested", async () => {
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
        0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
      ]).toString("base64"),
      mimeType: "video/mp4",
    });
    await getOutputImage("clip.mp4", "output", "", { forInlinePreview: true, allowMedia: true });
    expect(fetchImageMock).toHaveBeenCalledWith("clip.mp4", "output", "");
  });

  it("reads a 40 MB local PNG after /view hits VIEW_TOO_LARGE so preview can run", async () => {
    const root = resolve("/comfy", "output");
    const localPath = resolve(root, filename);
    fetchImageMock.mockRejectedValue(viewTooLarge());
    realpathMock.mockImplementation(async (path: string) => path);
    statMock.mockResolvedValue({ isFile: () => true, size: 40 * 1024 * 1024 });
    openMock.mockResolvedValue(fileHandleFor(png));

    await expect(
      getOutputImage(filename, "output", "", { forInlinePreview: true }),
    ).resolves.toMatchObject({
      base64: png.toString("base64"),
      mimeType: "image/png",
      filename,
    });
    expect(fetchImageMock).toHaveBeenCalledWith(filename, "output", "", { maxBytes: previewCap });
    expect(openMock).toHaveBeenCalledWith(localPath, "r");
  });

  it("refuses a source over the 64 MB preview cap without loading it", async () => {
    fetchImageMock.mockRejectedValue(viewTooLarge(previewCap));
    realpathMock.mockImplementation(async (path: string) => path);
    statMock.mockResolvedValue({ isFile: () => true, size: previewCap + 1 });

    await expect(
      getOutputImage(filename, "output", "", { forInlinePreview: true }),
    ).rejects.toMatchObject({
      code: "VIEW_TOO_LARGE",
      message: expect.stringMatching(/64 MB safety limit[\s\S]*max_preview_dimension/),
    });
    expect(openMock).not.toHaveBeenCalled();
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

  it("still rejects a filename whose separators are traversal, not a subfolder", async () => {
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

  it.each([
    ["a filename drive-relative path", "C:outside.png", ""],
    ["a subfolder drive-relative path", "hero.png", "C:outside"],
  ])("rejects %s before /view is called", async (_label, filename, subfolder) => {
    await expect(getOutputImage(filename, "output", subfolder)).rejects.toBeInstanceOf(ValidationError);
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

describe("getOutputImage — non-image /view payloads (issue #385)", () => {
  // ComfyUI (or a proxy) can answer /view with a 200 whose body is a JSON/HTML
  // error page or is empty — most often for a `type=input` ref that doesn't
  // resolve to a real input file. The old code saved those bytes as a `.png`
  // and returned a corrupt inline image, so the MCP client choked decoding it
  // ("Unexpected end of JSON input"). It must now throw a structured not-found.

  it("throws IMAGE_NOT_FOUND when /view returns a JSON error body for an input ref", async () => {
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from('{"error":"not found"}').toString("base64"),
      mimeType: "application/json",
    });
    const err = await getOutputImage("06.png", "input", "qwen").catch((e) => e);
    expect(err).toBeInstanceOf(ComfyUIError);
    expect(err.code).toBe("IMAGE_NOT_FOUND");
  });

  it("throws IMAGE_NOT_FOUND when /view returns an empty body", async () => {
    fetchImageMock.mockResolvedValue({ base64: "", mimeType: "image/png" });
    await expect(
      getOutputImage("06.png", "input", "qwen"),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("still resolves for a genuine image payload", async () => {
    // (mock default is image/png with real bytes)
    await expect(getOutputImage("06.png", "input", "qwen")).resolves.toMatchObject({
      mimeType: "image/png",
      filename: "06.png",
    });
  });
});

describe("getOutputImage — video/audio media (issue #663)", () => {
  // /view returns raw bytes for any media type, and video nodes like
  // VHS_VideoCombine legitimately produce .mp4 outputs that get_image must be
  // able to save to disk. allowMedia opts the caller into video/*/audio/*
  // payloads; the junk-body guards (empty / JSON / HTML) still apply — and the
  // declared media content-type is only accepted when the payload actually
  // sniffs as that media FORMAT (structural magic-byte checks, not just the
  // leading signature).

  // Realistic MP4 header: 24-byte ftyp box, isom major brand.
  const MP4_BASE64 = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, // ....ftyp
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, // isom....
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, // isomiso2
  ]).toString("base64");
  // WAV header: RIFF chunk whose declared size (8) is consistent with the
  // 16-byte body (chunk size + 8 header bytes == body length).
  const WAV_BASE64 = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x08, 0x00, 0x00, 0x00, // RIFF....
    0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, // WAVEfmt␠
  ]).toString("base64");
  // MP3 frame sync (0xFFFB = MPEG-1 Layer III) padded to a plausible file
  // size — the sync alone is only 2 bytes, so size is the structure here.
  const MP3_BASE64 = Buffer.from([0xff, 0xfb, ...new Array(254).fill(0)]).toString("base64");
  // AAC: ADTS frame sync (MPEG layer bits 00), padded to a plausible size.
  const AAC_BASE64 = Buffer.from([0xff, 0xf1, ...new Array(254).fill(0)]).toString("base64");
  // WebM: EBML magic, padded to a plausible file size.
  const WEBM_BASE64 = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...new Array(252).fill(0)]).toString("base64");
  // FLAC: magic + the mandatory first metadata block (a STREAMINFO block
  // header: type 0, length exactly 34) — 42 bytes total.
  const FLAC_BASE64 = Buffer.from([
    0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 0x22, // fLaC, STREAMINFO hdr
    ...new Array(34).fill(0),
  ]).toString("base64");
  // Ogg: capture pattern + version-0 page header; 1 segment of size 0.
  const OGG_BASE64 = Buffer.from([
    0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, // OggS, version 0, header type
    ...new Array(20).fill(0), // granule/serial/seq/crc
    0x01, 0x00, // 1 page segment, size 0
  ]).toString("base64");
  // m4a: 24-byte ftyp box with the audio-only M4A major brand.
  const M4A_BASE64 = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, // ....ftyp
    0x4d, 0x34, 0x41, 0x20, 0x00, 0x00, 0x00, 0x00, // M4A␠....
    0x4d, 0x34, 0x41, 0x20, 0x6d, 0x70, 0x34, 0x32, // M4A␠mp42
  ]).toString("base64");

  it("rejects a video/mp4 payload by default (inline callers stay image-only)", async () => {
    // Genuine MP4 bytes — the rejection must come from the missing allowMedia
    // opt-in, not from the payload sniff.
    fetchImageMock.mockResolvedValue({
      base64: MP4_BASE64,
      mimeType: "video/mp4",
    });
    await expect(
      getOutputImage("clip_00001_.mp4", "output", "video"),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("resolves a video/mp4 payload when allowMedia is set", async () => {
    fetchImageMock.mockResolvedValue({ base64: MP4_BASE64, mimeType: "video/mp4" });
    await expect(
      getOutputImage("clip_00001_.mp4", "output", "video", { allowMedia: true }),
    ).resolves.toMatchObject({
      base64: MP4_BASE64,
      mimeType: "video/mp4",
      filename: "clip_00001_.mp4",
    });
  });

  it("resolves an audio/wav payload when allowMedia is set", async () => {
    fetchImageMock.mockResolvedValue({ base64: WAV_BASE64, mimeType: "audio/wav" });
    await expect(
      getOutputImage("audio_00001_.wav", "output", "", { allowMedia: true }),
    ).resolves.toMatchObject({ mimeType: "audio/wav" });
  });

  it("still rejects a JSON error body even when allowMedia is set", async () => {
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from('{"error":"not found"}').toString("base64"),
      mimeType: "application/json",
    });
    await expect(
      getOutputImage("clip_00001_.mp4", "output", "video", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects a JSON error body MISLABELED as video/mp4 (declared type is no proof)", async () => {
    // A proxy can answer /view with a 200 whose body is a JSON error page but
    // whose content-type says video/mp4 — saving those bytes would fabricate a
    // successful media save. The payload must sniff as media, not just declare it.
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from('{"error":"not found"}').toString("base64"),
      mimeType: "video/mp4",
    });
    await expect(
      getOutputImage("clip_00001_.mp4", "output", "video", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects an HTML error page mislabeled as video/mp4", async () => {
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from("<!DOCTYPE html><html><body>404</body></html>").toString("base64"),
      mimeType: "video/mp4",
    });
    await expect(
      getOutputImage("clip_00001_.mp4", "output", "video", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects a WAV body mislabeled as video/mp4 (cross-family mismatch)", async () => {
    // Bytes AND label are both "media", but the families disagree — saving the
    // WAV under the requested .mp4 would report a corrupt video as a success.
    fetchImageMock.mockResolvedValue({ base64: WAV_BASE64, mimeType: "video/mp4" });
    await expect(
      getOutputImage("clip_00001_.mp4", "output", "video", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects an MP4 body mislabeled as audio/wav (cross-family mismatch)", async () => {
    fetchImageMock.mockResolvedValue({ base64: MP4_BASE64, mimeType: "audio/wav" });
    await expect(
      getOutputImage("audio_00001_.wav", "output", "", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  // ── Cross-FORMAT mislabels (#663 round 4): same family, wrong subtype ──

  it("rejects MP3 bytes mislabeled as audio/wav (cross-format within a family)", async () => {
    // Both are audio — but the sniffed format (MPEG sync) is not the declared
    // subtype (wav), so this must not be saved/reported as a .wav.
    fetchImageMock.mockResolvedValue({ base64: MP3_BASE64, mimeType: "audio/wav" });
    await expect(
      getOutputImage("audio_00001_.wav", "output", "", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects WAV bytes mislabeled as audio/mpeg", async () => {
    fetchImageMock.mockResolvedValue({ base64: WAV_BASE64, mimeType: "audio/mpeg" });
    await expect(
      getOutputImage("audio_00001_.mp3", "output", "", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects WebM bytes mislabeled as video/mp4", async () => {
    fetchImageMock.mockResolvedValue({ base64: WEBM_BASE64, mimeType: "video/mp4" });
    await expect(
      getOutputImage("clip_00001_.mp4", "output", "video", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects MP4 bytes mislabeled as video/webm", async () => {
    fetchImageMock.mockResolvedValue({ base64: MP4_BASE64, mimeType: "video/webm" });
    await expect(
      getOutputImage("clip_00001_.webm", "output", "video", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects WAV bytes mislabeled as audio/ogg", async () => {
    fetchImageMock.mockResolvedValue({ base64: WAV_BASE64, mimeType: "audio/ogg" });
    await expect(
      getOutputImage("audio_00001_.ogg", "output", "", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects Ogg bytes mislabeled as audio/flac", async () => {
    fetchImageMock.mockResolvedValue({ base64: OGG_BASE64, mimeType: "audio/flac" });
    await expect(
      getOutputImage("audio_00001_.flac", "output", "", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects a video-brand MP4 mislabeled as audio/mp4", async () => {
    // Same container family, wrong brand: isom is a VIDEO ftyp — audio/mp4
    // requires an audio brand (M4A/M4B).
    fetchImageMock.mockResolvedValue({ base64: MP4_BASE64, mimeType: "audio/mp4" });
    await expect(
      getOutputImage("audio_00001_.m4a", "output", "", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects an m4a (audio-brand ftyp) mislabeled as video/mp4", async () => {
    fetchImageMock.mockResolvedValue({ base64: M4A_BASE64, mimeType: "video/mp4" });
    await expect(
      getOutputImage("clip_00001_.mp4", "output", "video", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects MP3 bytes mislabeled as audio/aac (frame-sync formats are distinct)", async () => {
    // ADTS frames have MPEG layer bits 00; mp3 frames have them set.
    fetchImageMock.mockResolvedValue({ base64: MP3_BASE64, mimeType: "audio/aac" });
    await expect(
      getOutputImage("audio_00001_.aac", "output", "", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  // ── Positive controls: declared subtype matches sniffed format ──

  it("resolves MP3 bytes labeled audio/mpeg", async () => {
    fetchImageMock.mockResolvedValue({ base64: MP3_BASE64, mimeType: "audio/mpeg" });
    await expect(
      getOutputImage("audio_00001_.mp3", "output", "", { allowMedia: true }),
    ).resolves.toMatchObject({ mimeType: "audio/mpeg" });
  });

  it("resolves WebM bytes labeled video/webm", async () => {
    fetchImageMock.mockResolvedValue({ base64: WEBM_BASE64, mimeType: "video/webm" });
    await expect(
      getOutputImage("clip_00001_.webm", "output", "video", { allowMedia: true }),
    ).resolves.toMatchObject({ mimeType: "video/webm" });
  });

  it("resolves FLAC bytes labeled audio/flac (STREAMINFO structure)", async () => {
    fetchImageMock.mockResolvedValue({ base64: FLAC_BASE64, mimeType: "audio/flac" });
    await expect(
      getOutputImage("audio_00001_.flac", "output", "", { allowMedia: true }),
    ).resolves.toMatchObject({ mimeType: "audio/flac" });
  });

  it("resolves Ogg bytes labeled audio/ogg (page-header structure)", async () => {
    fetchImageMock.mockResolvedValue({ base64: OGG_BASE64, mimeType: "audio/ogg" });
    await expect(
      getOutputImage("audio_00001_.ogg", "output", "", { allowMedia: true }),
    ).resolves.toMatchObject({ mimeType: "audio/ogg" });
  });

  it("resolves AAC (ADTS sync) bytes labeled audio/aac", async () => {
    fetchImageMock.mockResolvedValue({ base64: AAC_BASE64, mimeType: "audio/aac" });
    await expect(
      getOutputImage("audio_00001_.aac", "output", "", { allowMedia: true }),
    ).resolves.toMatchObject({ mimeType: "audio/aac" });
  });

  // ── Truncated prefixes (#663 round 4): structure, not just signature ──

  it("rejects a 2-byte MPEG sync prefix labeled audio/mpeg", async () => {
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from([0xff, 0xfb]).toString("base64"),
      mimeType: "audio/mpeg",
    });
    await expect(
      getOutputImage("audio_00001_.mp3", "output", "", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects an undersized frame-sync body labeled audio/mpeg", async () => {
    // 102 bytes — above the bare sync, still below a plausible media file.
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from([0xff, 0xfb, ...new Array(100).fill(0)]).toString("base64"),
      mimeType: "audio/mpeg",
    });
    await expect(
      getOutputImage("audio_00001_.mp3", "output", "", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects a bare 3-byte 'ID3' prefix labeled audio/mpeg", async () => {
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from([0x49, 0x44, 0x33]).toString("base64"), // ID3
      mimeType: "audio/mpeg",
    });
    await expect(
      getOutputImage("audio_00001_.mp3", "output", "", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects an ID3 header whose size bytes are not syncsafe", async () => {
    // Full-size body, but a tag-size byte has the high bit set — malformed.
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from([
        0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x80, 0x00, 0x00, 0x10,
        ...new Array(246).fill(0),
      ]).toString("base64"),
      mimeType: "audio/mpeg",
    });
    await expect(
      getOutputImage("audio_00001_.mp3", "output", "", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects a RIFF/WAVE header claiming more bytes than the body holds", async () => {
    // Chunk size 36 but only 16 delivered — a truncated/fabricated prefix.
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, // RIFF$...
        0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, // WAVEfmt␠
      ]).toString("base64"),
      mimeType: "audio/wav",
    });
    await expect(
      getOutputImage("audio_00001_.wav", "output", "", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects a bare 4-byte 'OggS' prefix labeled audio/ogg", async () => {
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from([0x4f, 0x67, 0x67, 0x53]).toString("base64"),
      mimeType: "audio/ogg",
    });
    await expect(
      getOutputImage("audio_00001_.ogg", "output", "", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects a 'fLaC' magic with no STREAMINFO block labeled audio/flac", async () => {
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from([0x66, 0x4c, 0x61, 0x43, 0xff, 0xff, 0xff, 0xff]).toString("base64"),
      mimeType: "audio/flac",
    });
    await expect(
      getOutputImage("audio_00001_.flac", "output", "", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects an undersized EBML prefix labeled video/webm", async () => {
    // 4-byte EBML magic + 100 zero bytes — below the plausible-size floor.
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...new Array(100).fill(0)]).toString("base64"),
      mimeType: "video/webm",
    });
    await expect(
      getOutputImage("clip_00001_.webm", "output", "video", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects a truncated 8-byte body that is only '....ftyp' (no box behind it)", async () => {
    // The four bytes "ftyp" at offset 4 alone are not an MP4 — a valid ftyp
    // box needs the major brand and minor version too (>= 16 bytes), so a
    // truncated body must not sniff as media even labeled video/mp4.
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from([
        0x00, 0x00, 0x00, 0x08, 0x66, 0x74, 0x79, 0x70, // ....ftyp
      ]).toString("base64"),
      mimeType: "video/mp4",
    });
    await expect(
      getOutputImage("clip_00001_.mp4", "output", "video", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects an ftyp whose box size exceeds the actual body length", async () => {
    // 16-byte body, but the box header claims 32 bytes — an inconsistent,
    // fabricated header.
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from([
        0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, // box claims 32 bytes
        0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, // isom....
      ]).toString("base64"),
      mimeType: "video/mp4",
    });
    await expect(
      getOutputImage("clip_00001_.mp4", "output", "video", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("accepts a minimal 16-byte ftyp box (box size exactly covers the body)", async () => {
    // Boundary of the box-size check: size == body length == 16, printable
    // major brand, minor version present — the smallest well-formed ftyp.
    const MINIMAL_MP4_BASE64 = Buffer.from([
      0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, // box = 16 bytes
      0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00, // isom, minor 0
    ]).toString("base64");
    fetchImageMock.mockResolvedValue({
      base64: MINIMAL_MP4_BASE64,
      mimeType: "video/mp4",
    });
    await expect(
      getOutputImage("clip_00001_.mp4", "output", "video", { allowMedia: true }),
    ).resolves.toMatchObject({ mimeType: "video/mp4" });
  });

  it("resolves genuine MP4 bytes served as application/octet-stream (generic proxy label)", async () => {
    // ComfyUI itself reports video/mp4 (aiohttp mimetypes), but a proxy or a
    // signed URL hop can serve the same real bytes under the generic type —
    // the magic-byte sniff must still let them through.
    fetchImageMock.mockResolvedValue({
      base64: MP4_BASE64,
      mimeType: "application/octet-stream",
    });
    await expect(
      getOutputImage("clip_00001_.mp4", "output", "video", { allowMedia: true }),
    ).resolves.toMatchObject({ mimeType: "application/octet-stream" });
  });

  it("resolves genuine WAV bytes served as application/octet-stream", async () => {
    // The generic label declares no family, so any genuine media signature
    // passes — video OR audio.
    fetchImageMock.mockResolvedValue({
      base64: WAV_BASE64,
      mimeType: "application/octet-stream",
    });
    await expect(
      getOutputImage("audio_00001_.wav", "output", "", { allowMedia: true }),
    ).resolves.toMatchObject({ mimeType: "application/octet-stream" });
  });

  it("rejects octet-stream WAV bytes requested as .mp4 (extension is the only claim)", async () => {
    // Under the generic label the FILENAME is the last format claim: WAV bytes
    // saved as clip.mp4 would be a corrupt asset with a fabricated success.
    fetchImageMock.mockResolvedValue({
      base64: WAV_BASE64,
      mimeType: "application/octet-stream",
    });
    await expect(
      getOutputImage("clip_00001_.mp4", "output", "video", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("passes octet-stream media whose extension is unmapped (fail-open for exotic assets)", async () => {
    // An extension we can't classify declares nothing checkable — the bytes
    // still proved themselves via the structural sniff, so they pass.
    fetchImageMock.mockResolvedValue({
      base64: MP4_BASE64,
      mimeType: "application/octet-stream",
    });
    await expect(
      getOutputImage("clip_00001_.m2ts", "output", "video", { allowMedia: true }),
    ).resolves.toMatchObject({ mimeType: "application/octet-stream" });
  });

  it("rejects genuinely-declared audio/wav bytes requested as .mp4", async () => {
    // mime↔sniff agrees (wav is wav), but the filename claims video — every
    // claim must hold, or the save fabricates a corrupt asset.
    fetchImageMock.mockResolvedValue({ base64: WAV_BASE64, mimeType: "audio/wav" });
    await expect(
      getOutputImage("clip_00001_.mp4", "output", "video", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects video/mp4 bytes requested as .png (image extension claims a still)", async () => {
    fetchImageMock.mockResolvedValue({ base64: MP4_BASE64, mimeType: "video/mp4" });
    await expect(
      getOutputImage("frame_00001_.png", "output", "", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("resolves an m4a payload labeled audio/mp4 (audio-brand ftyp)", async () => {
    // .m4a is audio in an mp4 container — its ftyp major brand (M4A ) is the
    // audio/mp4 format, so it must not trip the cross-format guard.
    fetchImageMock.mockResolvedValue({ base64: M4A_BASE64, mimeType: "audio/mp4" });
    await expect(
      getOutputImage("audio_00001_.m4a", "output", "", { allowMedia: true }),
    ).resolves.toMatchObject({ mimeType: "audio/mp4" });
  });

  it("rejects a non-media body served as application/octet-stream", async () => {
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from('{"error":"not found"}').toString("base64"),
      mimeType: "application/octet-stream",
    });
    await expect(
      getOutputImage("clip_00001_.mp4", "output", "video", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("still rejects an empty body even when allowMedia is set", async () => {
    fetchImageMock.mockResolvedValue({ base64: "", mimeType: "video/mp4" });
    await expect(
      getOutputImage("clip_00001_.mp4", "output", "video", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });
});

describe("listOutputImages — remote mode keyed off isRemoteMode (issue #2 regression)", () => {
  it("uses /history (not a local-FS scan) when remote even though COMFYUI_PATH is set", async () => {
    // A remote target coexists with an unrelated local COMFYUI_PATH. Scanning the
    // local output dir would report the WRONG machine's outputs, so the remote
    // branch must key off isRemoteMode(), not mere comfyuiPath presence.
    mockConfig.comfyuiPath = "/comfy";
    mockConfig.remote = true;
    getHistoryMock.mockResolvedValue({
      a: {
        outputs: {
          "1": { images: [{ filename: "remote.png", subfolder: "", type: "output" }] },
        },
      },
    });

    const results = await listOutputImages();
    expect(getHistoryMock).toHaveBeenCalledTimes(1);
    expect(readdirMock).not.toHaveBeenCalled(); // no local-disk scan
    expect(results.map((r) => r.filename)).toEqual(["remote.png"]);
  });
});

describe("#1373 — a .json attachment is accepted by PARSING it, not by its content-type", () => {
  // get_image refused a valid ComfyUI workflow attachment because the reporter's server
  // labelled it `video/json` — neither image/* nor a sniffable media format. The input
  // directory legitimately holds workflow .json files, so they could not be saved at all.
  //
  // I could not reproduce that header: a stock ComfyUI 0.31.1 on this machine returns
  // `application/json` for the same request, and ComfyUI's own source has no `video/<ext>`
  // branch. So the label is install-specific, which is exactly why the fix cannot key on
  // it — the next install will invent a different one.
  //
  // The rule this follows is already in the file, one branch up: media payloads must SNIFF
  // as media, because "the declared content-type alone is no proof". JSON can answer that
  // question directly.

  const jsonBody = (text: string) => ({
    base64: Buffer.from(text, "utf8").toString("base64"),
    mimeType: "video/json",
  });

  it("accepts valid JSON however the server labelled it", async () => {
    fetchImageMock.mockResolvedValue(jsonBody('{"nodes":[],"links":[]}'));
    await expect(
      getOutputImage("08_SAM2_Rotoscope.json", "input", "", { allowMedia: true, allowJson: true }),
    ).resolves.toMatchObject({ filename: "08_SAM2_Rotoscope.json" });
  });

  it("…including the application/json a stock server actually sends", async () => {
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from('{"a":1}', "utf8").toString("base64"),
      mimeType: "application/json",
    });
    await expect(
      getOutputImage("wf.json", "input", "", { allowMedia: true, allowJson: true }),
    ).resolves.toBeDefined();
  });

  it("REFUSES a 200 JSON ERROR ENVELOPE — valid JSON is not the file they asked for", async () => {
    // ComfyUI answers 200 with a JSON error body in several cases, and {"error":"..."}
    // parses perfectly. Saving it as my_workflow.json is this issue's own bug in a new
    // costume: a failure written to disk under the name of the thing that failed.
    fetchImageMock.mockResolvedValue(jsonBody('{"error":"not found"}'));
    await expect(
      getOutputImage("wf.json", "input", "", { allowMedia: true, allowJson: true }),
    ).rejects.toThrow(/JSON ERROR body/);
  });

  it("…but a workflow that merely CONTAINS the word error is still saved", async () => {
    // The refusal is a top-level `error` KEY on an object, not a substring search. A node
    // titled "error handler" or a widget value mentioning errors is an ordinary workflow.
    fetchImageMock.mockResolvedValue(
      jsonBody('{"nodes":[{"title":"error handler","widgets_values":["error"]}]}'),
    );
    await expect(
      getOutputImage("wf.json", "input", "", { allowMedia: true, allowJson: true }),
    ).resolves.toBeDefined();
  });

  it("REFUSES an implausibly large .json rather than parsing it unchecked", async () => {
    // Parsing is the acceptance test, and parsing means decoding the whole body and
    // building an object graph — paid twice in memory before anything could reject it. A
    // workflow is kilobytes; 32 MB is far above any real one. Above the ceiling the answer
    // is REFUSE, because accepting unverified is exactly what this guard exists to prevent.
    // VALID JSON, deliberately — an invalid blob would be refused by the parse regardless,
    // so the test would pass with the ceiling removed and prove nothing. Mutation testing
    // caught exactly that: my first version used 45 MB of "A".
    const huge = JSON.stringify({ pad: "A".repeat(40 * 1024 * 1024) });
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from(huge, "utf8").toString("base64"),
      mimeType: "application/json",
    });
    // …and the message names the SIZE, not "the file may not exist" — the caller's
    // filename is perfectly correct and sending them to re-check it wastes the trip.
    await expect(
      getOutputImage("huge.json", "input", "", { allowMedia: true, allowJson: true }),
    ).rejects.toThrow(/over the 32 MB ceiling/);
  });

  it("REFUSES an HTML error page served as .json — the rejection this check exists for", async () => {
    // ComfyUI answers 200 with an error body often enough that this is the whole point.
    // A permissive "it was requested as .json, save it" would hand back a login page as a
    // workflow.
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from("<html><body>404 Not Found</body></html>", "utf8").toString("base64"),
      mimeType: "video/json",
    });
    await expect(
      getOutputImage("missing.json", "input", "", { allowMedia: true, allowJson: true }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("REFUSES truncated JSON", async () => {
    fetchImageMock.mockResolvedValue(jsonBody('{"nodes":[],"li'));
    await expect(
      getOutputImage("truncated.json", "input", "", { allowMedia: true, allowJson: true }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("REFUSES an empty body — and it is still a MISSING FILE, not a content refusal", async () => {
    // codex P2. An empty 200 is what an unresolved `input` reference looks like; that is
    // why #385 made it a structured not-found. Giving it the content-refusal code takes
    // the missing-file branch away from callers for `.json` alone — the same wrong-cause
    // failure this issue is about, pointed the other way.
    fetchImageMock.mockResolvedValue({ base64: "", mimeType: "application/json" });
    const err = await getOutputImage("empty.json", "input", "", {
      allowMedia: true,
      allowJson: true,
    }).catch((e) => e);
    expect(err.message).toMatch(/an empty response/);
    expect(err.code).toBe("IMAGE_NOT_FOUND");
    // ...and it must say the file may not exist, which is the actionable part.
    expect(err.message).toMatch(/may not exist/);
    // The reason rides along on both kinds: a caller should not have to parse a sentence
    // to learn whether the server sent an error envelope or nothing at all.
    expect(err.details?.rejectedBecause).toBe("an empty response");
  });

  it("catches the OTHER ComfyUI error shapes, not just a top-level `error` (codex)", async () => {
    // A single-key heuristic was calibrated wrong in both directions. These are error
    // bodies whatever they are called.
    for (const body of ['{"node_errors":{}}', '{"detail":"Not Found"}']) {
      fetchImageMock.mockResolvedValue(jsonBody(body));
      await expect(
        getOutputImage("wf.json", "input", "", { allowMedia: true, allowJson: true }),
      ).rejects.toThrow(/JSON ERROR body/);
    }
  });

  it("a content refusal carries its OWN error code, not IMAGE_NOT_FOUND (codex P2)", async () => {
    // The prose named the real reason; the CODE still said the file was missing — and the
    // code is the part automation reads. A caller branching on it retried, re-listed the
    // directory, and asked the user to check a filename that was never wrong.
    //
    // An HTML page from a proxy is the clean example of this kind: the name was right and
    // the payload was wrong, so checking the filename is useless.
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from("<html><body>login required</body></html>", "utf8").toString("base64"),
      mimeType: "application/json",
    });
    const err = await getOutputImage("wf.json", "input", "", {
      allowMedia: true,
      allowJson: true,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ComfyUIError);
    expect(err.code).toBe("ATTACHMENT_CONTENT_REJECTED");
    // The reason, structured, so a caller need not parse the sentence to act on it.
    expect(err.details?.rejectedBecause).toMatch(/not valid JSON/);
    // …and it must NOT send them off to re-check a filename that was never the problem.
    expect(err.message).not.toMatch(/may not exist/);
  });

  it("a JSON ERROR ENVELOPE is the server saying the file is ABSENT (codex round 3)", async () => {
    // Byte length was the first discriminator and it got this backwards. `/view` answering
    // `{"error":"not found"}` for a file that is genuinely gone is the server REPORTING
    // that — so the remedy is the filename, and calling it a content refusal sends the
    // caller to inspect a payload instead.
    fetchImageMock.mockResolvedValue(jsonBody('{"error":"not found"}'));
    const err = await getOutputImage("wf.json", "input", "", {
      allowMedia: true,
      allowJson: true,
    }).catch((e) => e);
    expect(err.code).toBe("IMAGE_NOT_FOUND");
    // Both halves: what came back, and the part the caller can act on.
    expect(err.details?.rejectedBecause).toMatch(/JSON ERROR body/);
    expect(err.message).toMatch(/JSON ERROR body/);
    expect(err.message).toMatch(/check the filename/);
  });

  it("…and a genuinely absent file still says IMAGE_NOT_FOUND", async () => {
    // The over-broad direction of the same change, which the test above cannot see:
    // relabelling every rejection would erase the missing-file signal that #385 added.
    //
    // The FIRST version of this test used `gone.png`, which never reaches the JSON gate at
    // all — so it asserted a branch the change could not affect and would have shipped the
    // P2 above unnoticed (codex). A `.json` request whose body never arrived is the case
    // that actually distinguishes the two codes.
    fetchImageMock.mockResolvedValue({ base64: "", mimeType: "application/json" });
    const missingJson = await getOutputImage("gone.json", "output", "", {
      allowMedia: true,
      allowJson: true,
    }).catch((e) => e);
    expect(missingJson.code).toBe("IMAGE_NOT_FOUND");
    expect(missingJson.details?.rejectedBecause).toBe("an empty response");

    // …and the non-JSON path, unchanged.
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from("<html>404</html>", "utf8").toString("base64"),
      mimeType: "text/html",
    });
    const err = await getOutputImage("gone.png", "output", "", {
      allowMedia: true,
      allowJson: true,
    }).catch((e) => e);
    expect(err.code).toBe("IMAGE_NOT_FOUND");
    expect(err.details?.rejectedBecause).toBeUndefined();
  });

  it("…and KEEPS a real workflow that carries its own top-level `error` field (codex)", async () => {
    // The other direction of the same miscalibration: rejecting a legitimate attachment
    // because a key name collided. A body with workflow markers is a workflow.
    fetchImageMock.mockResolvedValue(
      jsonBody('{"nodes":[],"links":[],"last_node_id":3,"error":"captured during the run"}'),
    );
    await expect(
      getOutputImage("wf.json", "input", "", { allowMedia: true, allowJson: true }),
    ).resolves.toBeDefined();
  });

  it("does NOT widen anything when allowJson is off", async () => {
    // The default path must be unchanged: this is opt-in from get_image(action:"get").
    fetchImageMock.mockResolvedValue(jsonBody('{"nodes":[]}'));
    await expect(getOutputImage("wf.json", "input", "")).rejects.toThrow(/did not return an image/);
  });

  it("does NOT accept JSON bytes requested under an IMAGE extension", async () => {
    // Gated on the requested extension, so a JSON body cannot arrive as a .png and be
    // saved as a working image.
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from('{"nodes":[]}', "utf8").toString("base64"),
      mimeType: "application/json",
    });
    await expect(
      getOutputImage("actually.png", "input", "", { allowMedia: true, allowJson: true }),
    ).rejects.toThrow(/did not return an image/);
  });
});
