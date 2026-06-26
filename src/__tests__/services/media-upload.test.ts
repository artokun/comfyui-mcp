import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolve } from "node:path";

vi.mock("../../config.js", () => ({
  config: { comfyuiPath: "/comfy" as string | undefined },
}));

const copyFileMock = vi.fn();
const readFileMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  readFile: (...a: unknown[]) => readFileMock(...a),
  copyFile: (...a: unknown[]) => copyFileMock(...a),
  readdir: vi.fn(),
  stat: vi.fn(),
}));

const uploadImageHttpMock = vi.fn();
const fetchImageMock = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  uploadImageHttp: (...a: unknown[]) => uploadImageHttpMock(...a),
  fetchImage: (...a: unknown[]) => fetchImageMock(...a),
}));

import { config } from "../../config.js";
import {
  uploadVideoAuto,
  uploadVideoLocal,
  uploadAudioAuto,
  uploadAudioLocal,
  stageOutputAsInput,
  inferMediaKind,
} from "../../services/image-management.js";
import { ValidationError } from "../../utils/errors.js";

beforeEach(() => {
  vi.clearAllMocks();
  (config as { comfyuiPath?: string }).comfyuiPath = "/comfy";
  readFileMock.mockResolvedValue(Buffer.from("data"));
  uploadImageHttpMock.mockResolvedValue({ name: "x" });
  copyFileMock.mockResolvedValue(undefined);
});

describe("uploadVideoAuto (HTTP)", () => {
  it("uploads a .mp4 with the video/mp4 mime type", async () => {
    uploadImageHttpMock.mockResolvedValueOnce({ name: "clip.mp4" });
    const r = await uploadVideoAuto("/src/clip.mp4");
    expect(r.filename).toBe("clip.mp4");
    expect(uploadImageHttpMock).toHaveBeenCalledWith(
      "clip.mp4",
      expect.any(Buffer),
      "video/mp4",
    );
  });

  it("respects a filename override and maps .webm", async () => {
    uploadImageHttpMock.mockResolvedValueOnce({ name: "renamed.webm" });
    await uploadVideoAuto("/src/clip.webm", "renamed.webm");
    expect(uploadImageHttpMock).toHaveBeenCalledWith(
      "renamed.webm",
      expect.any(Buffer),
      "video/webm",
    );
  });

  it("rejects an unsupported extension before any upload", async () => {
    await expect(uploadVideoAuto("/src/notes.txt")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(uploadImageHttpMock).not.toHaveBeenCalled();
  });
});

describe("uploadAudioAuto (HTTP)", () => {
  it("uploads a .wav with the audio/wav mime type", async () => {
    uploadImageHttpMock.mockResolvedValueOnce({ name: "track.wav" });
    const r = await uploadAudioAuto("/src/track.wav");
    expect(r.filename).toBe("track.wav");
    expect(uploadImageHttpMock).toHaveBeenCalledWith(
      "track.wav",
      expect.any(Buffer),
      "audio/wav",
    );
  });

  it("rejects an image extension (wrong media kind)", async () => {
    await expect(uploadAudioAuto("/src/pic.png")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(uploadImageHttpMock).not.toHaveBeenCalled();
  });
});

describe("uploadVideoLocal / uploadAudioLocal (filesystem)", () => {
  it("copies a video into <comfyui>/input and returns the path", async () => {
    const r = await uploadVideoLocal("/src/clip.mov");
    expect(copyFileMock).toHaveBeenCalledWith(
      "/src/clip.mov",
      resolve("/comfy", "input", "clip.mov"),
    );
    expect(r).toEqual({
      filename: "clip.mov",
      path: resolve("/comfy", "input", "clip.mov"),
    });
  });

  it("rejects an unsupported audio extension before copying", async () => {
    await expect(uploadAudioLocal("/src/clip.mp4")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(copyFileMock).not.toHaveBeenCalled();
  });

  it("errors clearly when COMFYUI_PATH is unset (remote mode)", async () => {
    (config as { comfyuiPath?: string }).comfyuiPath = undefined;
    await expect(uploadVideoLocal("/src/clip.mp4")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(copyFileMock).not.toHaveBeenCalled();
  });
});

describe("inferMediaKind", () => {
  it("classifies image / video / audio by extension", () => {
    expect(inferMediaKind("frame_00001_.png")).toBe("image");
    expect(inferMediaKind("LTX_video_00001.mp4")).toBe("video");
    expect(inferMediaKind("score.wav")).toBe("audio");
  });

  it("throws on an unknown extension", () => {
    expect(() => inferMediaKind("notes.txt")).toThrow(ValidationError);
  });
});

describe("stageOutputAsInput (output → input via server API)", () => {
  beforeEach(() => {
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from("bytes").toString("base64"),
      mimeType: "application/octet-stream",
    });
  });

  it("fetches the output via /view and re-uploads an image with the image mime", async () => {
    uploadImageHttpMock.mockResolvedValueOnce({
      name: "Krea2_00001_.png",
      subfolder: "",
      type: "input",
    });
    const r = await stageOutputAsInput({ filename: "Krea2_00001_.png" });
    expect(fetchImageMock).toHaveBeenCalledWith("Krea2_00001_.png", "output", "");
    expect(uploadImageHttpMock).toHaveBeenCalledWith(
      "Krea2_00001_.png",
      expect.any(Buffer),
      "image/png",
    );
    expect(r).toEqual({
      filename: "Krea2_00001_.png",
      subfolder: "",
      type: "input",
      kind: "image",
    });
  });

  it("infers video and uploads with the video mime", async () => {
    uploadImageHttpMock.mockResolvedValueOnce({
      name: "LTX_00001.mp4",
      subfolder: "",
      type: "input",
    });
    const r = await stageOutputAsInput({ filename: "LTX_00001.mp4" });
    expect(uploadImageHttpMock).toHaveBeenCalledWith(
      "LTX_00001.mp4",
      expect.any(Buffer),
      "video/mp4",
    );
    expect(r.kind).toBe("video");
  });

  it("infers audio and uploads with the audio mime", async () => {
    uploadImageHttpMock.mockResolvedValueOnce({
      name: "track.wav",
      subfolder: "",
      type: "input",
    });
    const r = await stageOutputAsInput({ filename: "track.wav" });
    expect(uploadImageHttpMock).toHaveBeenCalledWith(
      "track.wav",
      expect.any(Buffer),
      "audio/wav",
    );
    expect(r.kind).toBe("audio");
  });

  it("honors type:temp and an as_filename override", async () => {
    uploadImageHttpMock.mockResolvedValueOnce({
      name: "staged.png",
      subfolder: "",
      type: "input",
    });
    await stageOutputAsInput({
      filename: "preview.png",
      type: "temp",
      subfolder: "previews",
      asFilename: "staged.png",
    });
    expect(fetchImageMock).toHaveBeenCalledWith("preview.png", "temp", "previews");
    expect(uploadImageHttpMock).toHaveBeenCalledWith(
      "staged.png",
      expect.any(Buffer),
      "image/png",
    );
  });

  it("respects an explicit kind override", async () => {
    uploadImageHttpMock.mockResolvedValueOnce({
      name: "clip.webm",
      subfolder: "",
      type: "input",
    });
    const r = await stageOutputAsInput({ filename: "clip.webm", kind: "video" });
    expect(uploadImageHttpMock).toHaveBeenCalledWith(
      "clip.webm",
      expect.any(Buffer),
      "video/webm",
    );
    expect(r.kind).toBe("video");
  });

  it("rejects an unknown extension before fetching", async () => {
    await expect(stageOutputAsInput({ filename: "data.bin" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(fetchImageMock).not.toHaveBeenCalled();
    expect(uploadImageHttpMock).not.toHaveBeenCalled();
  });
});
