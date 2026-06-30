import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm, utimes, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock resolveOutputDir so the scan targets our temp dir; everything else
// (readdir/stat/extname classification) runs for real.
let outputDir = "";
vi.mock("../../services/output-dir.js", () => ({
  resolveOutputDir: () => Promise.resolve(outputDir),
  resolveInputDir: () => Promise.resolve(outputDir),
}));

// Mock the client so the remote (history-derived) branch is controllable. Only
// getHistory is exercised here; the other exports are unused by listOutputImages.
const getHistoryMock = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getHistory: (...a: unknown[]) => getHistoryMock(...a),
  fetchImage: vi.fn(),
  uploadImageHttp: vi.fn(),
}));

// Keep the real config (and its mutable `comfyuiPath`) but make isRemoteMode()
// toggleable so we can exercise the "remote target + local COMFYUI_PATH set"
// case. The source keys the /history branch off isRemoteMode() *in addition to*
// the no-path fallback, so we must be able to force remote mode independently of
// comfyuiPath.
let remoteFlag = false;
vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return { ...actual, isRemoteMode: () => remoteFlag };
});

import { config } from "../../config.js";
import { listOutputImages } from "../../services/image-management.js";

async function touch(name: string, when: Date, bytes = 1024): Promise<void> {
  const p = join(outputDir, name);
  await writeFile(p, Buffer.alloc(bytes));
  await utimes(p, when, when);
}

async function touchSub(
  subfolder: string,
  name: string,
  when: Date,
  bytes = 1024,
): Promise<void> {
  await mkdir(join(outputDir, subfolder), { recursive: true });
  const p = join(outputDir, subfolder, name);
  await writeFile(p, Buffer.alloc(bytes));
  await utimes(p, when, when);
}

let prevComfyuiPath: string | undefined;

beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), "comfy-out-"));
  // The local filesystem scan only runs when COMFYUI_PATH is set; force local
  // mode for the scan-based tests (resolveOutputDir is mocked to our temp dir).
  prevComfyuiPath = config.comfyuiPath;
  config.comfyuiPath = outputDir;
  remoteFlag = false;
  getHistoryMock.mockReset();
});

afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
  config.comfyuiPath = prevComfyuiPath;
  vi.clearAllMocks();
});

describe("listOutputImages", () => {
  it("lists a VHS_VideoCombine .mp4 output tagged kind:video", async () => {
    await touch("stage2_ltx_00003.mp4", new Date("2026-06-26T12:00:00Z"));

    const results = await listOutputImages();
    const mp4 = results.find((r) => r.filename === "stage2_ltx_00003.mp4");
    expect(mp4).toBeDefined();
    expect(mp4?.kind).toBe("video");
    expect(mp4?.size).toBe(1024);
    expect(mp4?.modified).toBe(new Date("2026-06-26T12:00:00Z").toISOString());
  });

  it("classifies still images as kind:image and videos/animations as kind:video", async () => {
    const now = new Date("2026-06-26T12:00:00Z");
    await touch("pic.png", now);
    await touch("clip.webm", now);
    await touch("clip.mov", now);
    await touch("clip.mkv", now);
    await touch("clip.m4v", now);
    await touch("clip.avi", now);
    await touch("anim.gif", now);
    await touch("anim.webp", now);

    const byName = Object.fromEntries(
      (await listOutputImages({ limit: 100 })).map((r) => [r.filename, r.kind]),
    );
    expect(byName["pic.png"]).toBe("image");
    expect(byName["clip.webm"]).toBe("video");
    expect(byName["clip.mov"]).toBe("video");
    expect(byName["clip.mkv"]).toBe("video");
    expect(byName["clip.m4v"]).toBe("video");
    expect(byName["clip.avi"]).toBe("video");
    // .gif and .webp are emitted as animations by ComfyUI's video nodes.
    expect(byName["anim.gif"]).toBe("video");
    expect(byName["anim.webp"]).toBe("video");
  });

  it("skips non-media files", async () => {
    await touch("notes.txt", new Date("2026-06-26T12:00:00Z"));
    await touch("workflow.json", new Date("2026-06-26T12:00:00Z"));
    const results = await listOutputImages();
    expect(results).toHaveLength(0);
  });

  it("returns newest-first and honors limit", async () => {
    await touch("old.png", new Date("2026-06-01T00:00:00Z"));
    await touch("new.mp4", new Date("2026-06-26T00:00:00Z"));
    await touch("mid.png", new Date("2026-06-10T00:00:00Z"));

    const all = await listOutputImages();
    expect(all.map((r) => r.filename)).toEqual(["new.mp4", "mid.png", "old.png"]);

    const limited = await listOutputImages({ limit: 1 });
    expect(limited.map((r) => r.filename)).toEqual(["new.mp4"]);
  });

  it("filters by case-insensitive filename pattern", async () => {
    const now = new Date("2026-06-26T12:00:00Z");
    await touch("stage2_ltx_00003.mp4", now);
    await touch("portrait_00001.png", now);

    const results = await listOutputImages({ pattern: "LTX" });
    expect(results.map((r) => r.filename)).toEqual(["stage2_ltx_00003.mp4"]);
  });

  it("recurses into subfolders (SaveVideo writes to output/video/) and reports the subfolder", async () => {
    const now = new Date("2026-06-26T12:00:00Z");
    await touch("ComfyUI_00001_.png", now); // top-level still
    await touchSub("video", "LTX_2.3_i2v_00004_.mp4", now); // the file a flat scan would miss

    const results = await listOutputImages({ limit: 100 });
    const vid = results.find((r) => r.filename === "LTX_2.3_i2v_00004_.mp4");
    expect(vid).toBeDefined();
    expect(vid?.kind).toBe("video");
    expect(vid?.subfolder).toBe("video"); // forward-slash normalized, no leading sep
    // top-level files carry an empty subfolder
    expect(results.find((r) => r.filename === "ComfyUI_00001_.png")?.subfolder).toBe("");
  });

  it("matches the pattern against the subfolder-relative path", async () => {
    const now = new Date("2026-06-26T12:00:00Z");
    await touchSub("video", "clip_00001.mp4", now);
    await touch("clip_00002.png", now);

    // "video/" only matches the file under the video/ subfolder
    const results = await listOutputImages({ pattern: "video/" });
    expect(results.map((r) => r.filename)).toEqual(["clip_00001.mp4"]);
  });
});

describe("listOutputImages — remote mode (derived from /history)", () => {
  beforeEach(() => {
    // No local filesystem → the history-derived branch is used.
    config.comfyuiPath = undefined;
  });

  it("derives images + videos from history, newest-first, with kind", async () => {
    getHistoryMock.mockResolvedValue({
      // Oldest first (history insertion order); listing returns newest first.
      older: {
        outputs: {
          "9": { images: [{ filename: "old.png", subfolder: "", type: "output" }] },
        },
      },
      newer: {
        outputs: {
          "12": {
            videos: [{ filename: "clip.mp4", subfolder: "video", type: "output" }],
            gifs: [{ filename: "preview.webp", subfolder: "", type: "output" }],
          },
        },
      },
    });

    const results = await listOutputImages({ limit: 100 });
    // Newest entry ("newer") comes first.
    expect(results.map((r) => r.filename)).toEqual([
      "clip.mp4",
      "preview.webp",
      "old.png",
    ]);
    const byName = Object.fromEntries(results.map((r) => [r.filename, r]));
    expect(byName["clip.mp4"].kind).toBe("video");
    expect(byName["clip.mp4"].subfolder).toBe("video");
    expect(byName["preview.webp"].kind).toBe("video");
    expect(byName["old.png"].kind).toBe("image");
    // Size/modified are unavailable over HTTP.
    expect(byName["old.png"].size).toBe(0);
    expect(byName["old.png"].modified).toBe("");
  });

  it("skips temp-type assets and dedupes repeated filenames", async () => {
    getHistoryMock.mockResolvedValue({
      a: {
        outputs: {
          "1": {
            images: [
              { filename: "dup.png", subfolder: "", type: "output" },
              { filename: "preview.png", subfolder: "", type: "temp" },
            ],
          },
        },
      },
      b: {
        outputs: {
          "2": { images: [{ filename: "dup.png", subfolder: "", type: "output" }] },
        },
      },
    });

    const results = await listOutputImages({ limit: 100 });
    expect(results.map((r) => r.filename)).toEqual(["dup.png"]); // temp skipped, dup deduped
  });

  it("honors limit and pattern", async () => {
    getHistoryMock.mockResolvedValue({
      a: {
        outputs: {
          "1": {
            images: [
              { filename: "portrait.png", subfolder: "", type: "output" },
              { filename: "ltx_clip.mp4", subfolder: "", type: "output" },
            ],
          },
        },
      },
    });

    expect((await listOutputImages({ pattern: "LTX" })).map((r) => r.filename)).toEqual([
      "ltx_clip.mp4",
    ]);
    expect((await listOutputImages({ limit: 1 })).length).toBe(1);
  });

  it("returns [] when history is unavailable rather than throwing", async () => {
    getHistoryMock.mockRejectedValue(new Error("unreachable"));
    await expect(listOutputImages()).resolves.toEqual([]);
  });

  it("uses /history even when comfyuiPath IS set, as long as isRemoteMode() is true", async () => {
    // Regression guard: the branch must key off isRemoteMode(), NOT merely
    // `!config.comfyuiPath`. A remote target can coexist with an unrelated local
    // COMFYUI_PATH; scanning that local dir would report the wrong machine's
    // outputs. Reverting the condition to `!config.comfyuiPath` would make this
    // test list the local file and never call getHistory.
    remoteFlag = true;
    config.comfyuiPath = outputDir; // non-empty AND points at a real dir with a file
    // This local file would surface ONLY if the (forbidden) readdir scan ran.
    await touch("local_only.png", new Date("2026-06-26T12:00:00Z"));
    getHistoryMock.mockResolvedValue({
      j: {
        outputs: {
          "1": { images: [{ filename: "from_history.png", subfolder: "", type: "output" }] },
        },
      },
    });

    const results = await listOutputImages({ limit: 100 });

    // The /history path was taken…
    expect(getHistoryMock).toHaveBeenCalled();
    // …and ONLY the history-derived entry came back (readdir scan did NOT run).
    expect(results.map((r) => r.filename)).toEqual(["from_history.png"]);
    expect(results.find((r) => r.filename === "local_only.png")).toBeUndefined();
  });
});
