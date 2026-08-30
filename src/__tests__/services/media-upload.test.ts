import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolve } from "node:path";

// `isRemoteMode` is needed because the input/output dir fallbacks now resolve
// through the shared workspace resolver (#877) rather than reading
// `config.comfyuiPath` directly — a saved default workspace locates a local
// install perfectly well, and the bare env-var check made one look pathless.
const cfgRef = vi.hoisted(() => ({
  config: { comfyuiPath: "/comfy" as string | undefined },
}));
vi.mock("../../config.js", () => ({
  config: cfgRef.config,
  isRemoteMode: () => false,
}));

// The input/output dir fallbacks now resolve through the shared workspace
// resolver (#877): a saved default workspace locates a local install perfectly
// well, and the bare `config.comfyuiPath` check made one look pathless. Stubbed
// to the env var alone so "no local path" is a property of the TEST rather than
// of whichever machine runs it — this rig has a real saved workspace, which
// otherwise silently satisfies the case below.
vi.mock("../../services/workspace-env.js", () => ({
  resolveEffectiveComfyUIBase: () => cfgRef.config.comfyuiPath,
}));

const resolveInputDirMock = vi.fn();
vi.mock("../../services/output-dir.js", () => ({
  resolveInputDir: (...a: unknown[]) => resolveInputDirMock(...a),
  resolveOutputDir: vi.fn(),
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
const getObjectInfoMock = vi.fn();
const resetObjectInfoCacheMock = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  uploadImageHttp: (...a: unknown[]) => uploadImageHttpMock(...a),
  fetchImage: (...a: unknown[]) => fetchImageMock(...a),
  getObjectInfo: (...a: unknown[]) => getObjectInfoMock(...a),
  resetObjectInfoCache: (...a: unknown[]) => resetObjectInfoCacheMock(...a),
  MAX_VIEW_RESPONSE_BYTES: 32 * 1024 * 1024,
}));

import { config } from "../../config.js";
import {
  uploadImageAuto,
  uploadVideoAuto,
  uploadVideoLocal,
  uploadAudioAuto,
  uploadAudioLocal,
  stageOutputAsInput,
  inferMediaKind,
  stagedLoaderWidgetValue,
} from "../../services/image-management.js";
import { ValidationError } from "../../utils/errors.js";

beforeEach(() => {
  vi.clearAllMocks();
  (config as { comfyuiPath?: string }).comfyuiPath = "/comfy";
  readFileMock.mockResolvedValue(Buffer.from("data"));
  uploadImageHttpMock.mockResolvedValue({ name: "x" });
  getObjectInfoMock.mockResolvedValue({});
  copyFileMock.mockResolvedValue(undefined);
  resolveInputDirMock.mockImplementation(async () => {
    const base = cfgRef.config.comfyuiPath;
    if (!base) {
      throw new ValidationError(
        "No local ComfyUI install path could be established: COMFYUI_PATH is not set and no " +
          "default workspace is saved. Set COMFYUI_PATH, or save one with the workspace tool " +
          "(action 'set_default').",
      );
    }
    return resolve(base, "input");
  });
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

  it("errors clearly when NO local install path can be established", async () => {
    (config as { comfyuiPath?: string }).comfyuiPath = undefined;
    await expect(uploadVideoLocal("/src/clip.mp4")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(copyFileMock).not.toHaveBeenCalled();
  });
});

describe("upload subfolder propagation (#946 recurrence)", () => {
  // A filename override carrying a path ("minimax_h3/clip1_end.png") is a
  // subfolder request: the server stores the file UNDER that subfolder and
  // answers { name, subfolder }. Dropping the subfolder here handed the caller
  // a bare name that did not resolve — queuing a loader failed with
  // FileNotFoundError for input/<name> while the file sat in input/minimax_h3/.
  it("uploadVideoAuto returns the subfolder alongside the stored name", async () => {
    uploadImageHttpMock.mockResolvedValueOnce({
      name: "clip1_end.mp4",
      subfolder: "minimax_h3",
      type: "input",
    });
    const r = await uploadVideoAuto("/src/clip1_end.mp4", "minimax_h3/clip1_end.mp4");
    expect(r).toEqual({ filename: "clip1_end.mp4", subfolder: "minimax_h3" });
  });

  it("uploadImageAuto returns the subfolder alongside the stored name", async () => {
    uploadImageHttpMock.mockResolvedValueOnce({
      name: "frame.png",
      subfolder: "assets",
      type: "input",
    });
    const r = await uploadImageAuto("/src/frame.png", "assets/frame.png");
    expect(r).toEqual({ filename: "frame.png", subfolder: "assets" });
  });

  it("defaults the subfolder to '' when the server omits it", async () => {
    uploadImageHttpMock.mockResolvedValueOnce({ name: "in.png" });
    const r = await uploadImageAuto("/src/in.png");
    expect(r).toEqual({ filename: "in.png", subfolder: "" });
  });

  it("passes the path-shaped override through to the transport, which owns the split", async () => {
    uploadImageHttpMock.mockResolvedValueOnce({
      name: "clip.mp4",
      subfolder: "assets",
      type: "input",
    });
    await uploadVideoAuto("/src/clip.mp4", "assets/clip.mp4");
    expect(uploadImageHttpMock).toHaveBeenCalledWith(
      "assets/clip.mp4",
      expect.any(Buffer),
      "video/mp4",
    );
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
      loaderSelectable: "unverified",
    });
  });

  it("verifies a nested stage reference against the fresh loader combo", async () => {
    uploadImageHttpMock.mockResolvedValueOnce({
      name: "example.png",
      subfolder: "stage",
      type: "input",
    });
    getObjectInfoMock.mockResolvedValueOnce({
      LoadImage: {
        input: { required: { image: ["COMBO", { options: ["stage/example.png"] }] } },
      },
    });

    const r = await stageOutputAsInput({
      filename: "source.png",
      asFilename: "stage/example.png",
    });

    expect(uploadImageHttpMock).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({
      filename: "example.png",
      subfolder: "stage",
      loaderSelectable: "verified",
    });
    expect(resetObjectInfoCacheMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to a root filename when the host omits nested paths from LoadImage", async () => {
    uploadImageHttpMock
      .mockResolvedValueOnce({ name: "example.png", subfolder: "stage", type: "input" })
      .mockResolvedValueOnce({ name: "example_1.png", subfolder: "", type: "input" });
    getObjectInfoMock
      .mockResolvedValueOnce({
        LoadImage: {
          input: { required: { image: ["COMBO", { options: ["other.png"] }] } },
        },
      })
      .mockResolvedValueOnce({
        LoadImage: {
          input: { required: { image: ["COMBO", { options: ["example_1.png"] }] } },
        },
      });

    const r = await stageOutputAsInput({
      filename: "source.png",
      asFilename: "stage/example.png",
    });

    expect(uploadImageHttpMock).toHaveBeenCalledTimes(2);
    expect(uploadImageHttpMock.mock.calls[1]).toEqual([
      "example.png",
      expect.any(Buffer),
      "image/png",
      false,
    ]);
    expect(r).toMatchObject({
      filename: "example_1.png",
      subfolder: "",
      loaderSelectable: "root-fallback",
      requestedFilename: "stage/example.png",
    });
  });

  it("does not claim loader selectability when /object_info is unavailable", async () => {
    uploadImageHttpMock.mockResolvedValueOnce({
      name: "example.png",
      subfolder: "stage",
      type: "input",
    });
    getObjectInfoMock.mockRejectedValueOnce(new Error("server unavailable"));

    const r = await stageOutputAsInput({
      filename: "source.png",
      asFilename: "stage/example.png",
    });

    expect(r.loaderSelectable).toBe("unverified");
    expect(uploadImageHttpMock).toHaveBeenCalledTimes(1);
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

describe("stageOutputAsInput video path mapping (#2083)", () => {
  // VHS_LoadVideo combo enumerates only top-level input/ files. Staging a
  // nested as_filename stored the MP4 under a subfolder that never appeared in
  // that combo. The #2094 root fallback then returned a top-level name that
  // VHS_LoadVideoPath.video (a STRING path widget) accepted, but panel_run
  // failed with Invalid file path — Path loaders need a filesystem path, and
  // the combo filename is not one (subfolder/path mismatch).
  const vhsObjectInfo = (comboFiles: string[]) => ({
    VHS_LoadVideo: {
      input: { required: { video: [comboFiles, {}] } },
    },
    VHS_LoadVideoPath: {
      input: {
        required: {
          video: ["STRING", { placeholder: "X://insert/path/here.mp4", vhs_path_extensions: ["mp4"] }],
        },
      },
    },
  });

  beforeEach(() => {
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from("bytes").toString("base64"),
      mimeType: "application/octet-stream",
    });
  });

  it("stages a nested video as_filename at the input root so VHS combo can select it", async () => {
    uploadImageHttpMock.mockResolvedValueOnce({
      name: "clip.mp4",
      subfolder: "",
      type: "input",
    });
    getObjectInfoMock.mockResolvedValueOnce(vhsObjectInfo(["clip.mp4", "other.mp4"]));

    const r = await stageOutputAsInput({
      filename: "source.mp4",
      asFilename: "C0028/clip.mp4",
    });

    expect(uploadImageHttpMock).toHaveBeenCalledTimes(1);
    expect(uploadImageHttpMock).toHaveBeenCalledWith(
      "clip.mp4",
      expect.any(Buffer),
      "video/mp4",
    );
    expect(r).toMatchObject({
      filename: "clip.mp4",
      subfolder: "",
      kind: "video",
      loaderSelectable: "root-fallback",
      requestedFilename: "C0028/clip.mp4",
    });
  });

  it("maps the staged video to a filesystem path for VHS_LoadVideoPath, not the combo name", async () => {
    uploadImageHttpMock.mockResolvedValueOnce({
      name: "clip.mp4",
      subfolder: "",
      type: "input",
    });
    getObjectInfoMock.mockResolvedValueOnce(vhsObjectInfo(["clip.mp4"]));

    const r = await stageOutputAsInput({
      filename: "source.mp4",
      asFilename: "C0028/clip.mp4",
    });

    const comboName = "clip.mp4";
    const fsPath = resolve("/comfy", "input", "clip.mp4");
    expect(r.pathReference).toBe(fsPath);
    expect(stagedLoaderWidgetValue(r, "VHS_LoadVideo")).toBe(comboName);
    expect(stagedLoaderWidgetValue(r, "VHS_LoadVideoFFmpeg")).toBe(comboName);
    expect(stagedLoaderWidgetValue(r, "VHS_LoadVideoPath")).toBe(fsPath);
    expect(stagedLoaderWidgetValue(r, "VHS_LoadVideoFFmpegPath")).toBe(fsPath);
    // The recurrence: a top-level combo name is not a valid Path-loader value.
    expect(stagedLoaderWidgetValue(r, "VHS_LoadVideoPath")).not.toBe(comboName);
  });

  it("never maps VHS_LoadVideoPath to a combo name while the file sits in a subfolder", async () => {
    uploadImageHttpMock.mockResolvedValue({
      name: "clip.mp4",
      subfolder: "C0028",
      type: "input",
    });
    getObjectInfoMock.mockResolvedValue(vhsObjectInfo(["other.mp4"]));

    const r = await stageOutputAsInput({
      filename: "source.mp4",
      asFilename: "C0028/clip.mp4",
    });

    expect(r.subfolder).toBe("C0028");
    expect(stagedLoaderWidgetValue(r, "VHS_LoadVideo")).toBe("C0028/clip.mp4");
    expect(stagedLoaderWidgetValue(r, "VHS_LoadVideoPath")).toBe(
      resolve("/comfy", "input", "C0028", "clip.mp4"),
    );
    expect(stagedLoaderWidgetValue(r, "VHS_LoadVideoPath")).not.toBe("clip.mp4");
  });

  it("does not treat a VHS_LoadVideoPath STRING widget as combo proof of a nested name", async () => {
    uploadImageHttpMock.mockResolvedValueOnce({
      name: "clip.mp4",
      subfolder: "",
      type: "input",
    });
    getObjectInfoMock.mockResolvedValueOnce({
      VHS_LoadVideoPath: {
        input: {
          required: {
            video: ["STRING", { placeholder: "X://insert/path/here.mp4" }],
          },
        },
      },
    });

    const r = await stageOutputAsInput({
      filename: "source.mp4",
      asFilename: "C0028/clip.mp4",
    });

    expect(r.loaderSelectable).not.toBe("verified");
    expect(stagedLoaderWidgetValue(r, "VHS_LoadVideoPath")).toBe(
      resolve("/comfy", "input", "clip.mp4"),
    );
  });
});
