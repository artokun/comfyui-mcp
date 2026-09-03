import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ComfyUIError } from "../../utils/errors.js";

// #483: get_image for a valid `type:"input"` image must return the binary
// bytes as an inline image, and a non-image/empty /view body must yield a
// structured not-found — never an uncaught "Unexpected end of JSON input"
// from JSON-parsing a binary response. The binary-safe read + guard live in
// getOutputImage (service, covered in image-management-traversal.test.ts);
// this locks the TOOL handler contract on top of it.

const getOutputImageMock = vi.fn();
vi.mock("../../services/image-management.js", () => ({
  extractWorkflowFromImage: vi.fn(),
  listOutputImages: vi.fn(),
  listOutputMedia: vi.fn(async () => ({
    images: [],
    source: { directory: "C:\Comfy\output", basis: "local-scan" },
  })),
  getOutputImage: (...a: unknown[]) => getOutputImageMock(...a),
  uploadImageAuto: vi.fn(),
  uploadVideoAuto: vi.fn(),
  uploadAudioAuto: vi.fn(),
  stageOutputAsInput: vi.fn(),
}));

// Don't actually touch disk when the handler saves the file.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, mkdir: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) };
});

import { registerImageManagementTools } from "../../tools/image-management.js";

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;
function getHandler(name: string): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (n: string, _d: string, _s: unknown, h: ToolHandler) => {
      if (n === name) handler = h;
    },
  };
  registerImageManagementTools(server as never);
  if (!handler) throw new Error(`tool ${name} not registered`);
  return handler;
}

describe("get_image — binary-safe (#483)", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns an inline image block for a valid type:input image", async () => {
    const base64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    getOutputImageMock.mockResolvedValue({ base64, mimeType: "image/png", filename: "src.png" });

    const out = await getHandler("get_image")({
      action: "get",
      filename: "RogueTD_Ara_Locomotion_Source.png",
      type: "input",
      save_dir: "/tmp/x",
    });

    const image = out.content.find((c) => c.type === "image");
    expect(image).toBeDefined();
    expect(image?.data).toBe(base64);
    expect(image?.mimeType).toBe("image/png");
  });

  it("returns a structured error (not a JSON-parse crash) for an empty/non-image body", async () => {
    getOutputImageMock.mockRejectedValue(
      new ComfyUIError(
        'ComfyUI /view did not return an image for "x.png" (input); got an empty response.',
        "IMAGE_NOT_FOUND",
      ),
    );

    const out = await getHandler("get_image")({ action: "get", filename: "x.png", type: "input" });
    expect(out.isError).toBe(true);
    const text = out.content.map((c) => c.text ?? "").join("");
    expect(text).toContain("IMAGE_NOT_FOUND");
    expect(text).not.toContain("Unexpected end of JSON input");
    // #554: the failure envelope must itself be WELL-FORMED JSON (a clean
    // structured error), not free-form prose the caller then fails to parse.
    const parsed = JSON.parse(text) as { error?: string };
    expect(parsed.error).toBe("IMAGE_NOT_FOUND");
  });
});

describe("get_image — video/audio save-to-disk (#663)", () => {
  afterEach(() => vi.clearAllMocks());

  it("saves a video/mp4 asset to disk and returns text only (no inline image)", async () => {
    // Realistic MP4 header (24-byte ftyp box, isom brand) — the service's
    // magic-byte sniff accepts this shape; junk bytes would be rejected there.
    const base64 = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, // ....ftyp
      0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, // isom....
      0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, // isomiso2
    ]).toString("base64");
    getOutputImageMock.mockResolvedValue({
      base64,
      mimeType: "video/mp4",
      filename: "I2V_HD_FaceLock_00036-audio.mp4",
    });

    const out = await getHandler("get_image")({
      action: "get",
      filename: "I2V_HD_FaceLock_00036-audio.mp4",
      type: "output",
      subfolder: "Eros",
      save_dir: "/tmp/x",
    });

    expect(out.isError).toBeUndefined();
    // The handler must opt into media payloads so the service doesn't reject
    // the mp4 as IMAGE_NOT_FOUND.
    expect(getOutputImageMock).toHaveBeenCalledWith(
      "I2V_HD_FaceLock_00036-audio.mp4",
      "output",
      "Eros",
      { allowMedia: true, allowAttachment: true, allowJson: true },
    );
    // Saved under the original filename/extension in the requested save_dir. The dir is
    // resolved first, so on Windows a rootless "/tmp/x" becomes the drive-qualified path
    // Node would actually have written to — the reported path and the real one agree.
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
      join(resolve("/tmp/x"), "I2V_HD_FaceLock_00036-audio.mp4"),
      Buffer.from(base64, "base64"),
    );
    expect(out.content.find((c) => c.type === "image")).toBeUndefined();
    const text = out.content.map((c) => c.text ?? "").join("");
    expect(text).toContain("I2V_HD_FaceLock_00036-audio.mp4");
    expect(text).toContain("video/mp4");
  });

  it("writes NOTHING to disk when the service rejects a mislabeled media body", async () => {
    // A JSON/HTML error body mislabeled video/mp4 is rejected inside
    // getOutputImage (magic-byte sniff, see image-management-traversal.test.ts).
    // The tool must surface that structured error and must NOT save a
    // fabricated .mp4 from the junk bytes.
    getOutputImageMock.mockRejectedValue(
      new ComfyUIError(
        'ComfyUI /view did not return an image for "clip_00001_.mp4" (output/video); got content-type "video/mp4".',
        "IMAGE_NOT_FOUND",
      ),
    );

    const out = await getHandler("get_image")({
      action: "get",
      filename: "clip_00001_.mp4",
      type: "output",
      subfolder: "video",
      save_dir: "/tmp/x",
    });

    expect(out.isError).toBe(true);
    const parsed = JSON.parse(
      out.content.map((c) => c.text ?? "").join(""),
    ) as { error?: string };
    expect(parsed.error).toBe("IMAGE_NOT_FOUND");
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
  });
});
