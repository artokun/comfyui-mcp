import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #2539 — get_image list_outputs scanned an unrelated COMFYUI_PATH (empty)
// while live /view had the files. resolveOutputDir is mocked to that empty
// directory so the history fallback is the thing under test, not path
// resolution.

let outputDir = "";
let tempDir = "";
let outputDirError: Error | null = null;
let tempDirError: Error | null = null;
vi.mock("../../services/output-dir.js", () => ({
  resolveOutputDir: () =>
    outputDirError ? Promise.reject(outputDirError) : Promise.resolve(outputDir),
  resolveInputDir: () => Promise.resolve(outputDir),
  resolveTempDir: () =>
    tempDirError ? Promise.reject(tempDirError) : Promise.resolve(tempDir),
}));

const getHistoryMock = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getHistory: (...a: unknown[]) => getHistoryMock(...a),
  fetchImage: vi.fn(),
  uploadImageHttp: vi.fn(),
  MAX_VIEW_RESPONSE_BYTES: 32 * 1024 * 1024,
}));

let remoteFlag = false;
vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return { ...actual, isRemoteMode: () => remoteFlag };
});

import { config } from "../../config.js";
import { listOutputMedia } from "../../services/image-management.js";

interface HistoryMedia {
  filename: string;
  subfolder: string;
  type: "output" | "temp";
}

function historyWithImages(images: HistoryMedia[]): Record<string, unknown> {
  return {
    prompt: { outputs: { "9": { images } } },
  };
}

async function touch(name: string, when: Date, bytes = 1024): Promise<void> {
  const p = join(outputDir, name);
  await writeFile(p, Buffer.alloc(bytes));
  await utimes(p, when, when);
}

let prevComfyuiPath: string | undefined;

beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), "comfy-out-"));
  tempDir = await mkdtemp(join(tmpdir(), "comfy-temp-"));
  prevComfyuiPath = config.comfyuiPath;
  config.comfyuiPath = outputDir;
  remoteFlag = false;
  outputDirError = null;
  tempDirError = null;
  getHistoryMock.mockReset();
});

afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
  await rm(tempDir, { recursive: true, force: true });
  config.comfyuiPath = prevComfyuiPath;
  vi.clearAllMocks();
});

describe("#2539 list_outputs empty local scan of an unrelated COMFYUI_PATH", () => {
  it("returns matching /history entries instead of an empty local-scan", async () => {
    // The scanned directory is empty — the unrelated COMFYUI_PATH from the report.
    // Live /history (and therefore /view) still has the three panel outputs.
    getHistoryMock.mockResolvedValue(
      historyWithImages([
        { filename: "panel_00001_.png", subfolder: "sub", type: "output" },
        { filename: "panel_00002_.png", subfolder: "sub", type: "output" },
        { filename: "panel_00003_.png", subfolder: "sub", type: "output" },
      ]),
    );

    const result = await listOutputMedia({ pattern: "panel", limit: 20 });

    expect(result.images.map((i) => i.filename)).toEqual([
      "panel_00001_.png",
      "panel_00002_.png",
      "panel_00003_.png",
    ]);
    expect(result.images.every((i) => i.subfolder === "sub")).toBe(true);
    expect(result.source.basis).toBe("server-history-fallback");
    expect(result.source.directory).toBe(outputDir);
    expect(getHistoryMock).toHaveBeenCalled();
  });

  it("does not consult /history when the local scan already found files", async () => {
    await touch("local_only.png", new Date("2026-08-29T12:00:00Z"));
    getHistoryMock.mockResolvedValue(
      historyWithImages([{ filename: "from_history.png", subfolder: "", type: "output" }]),
    );

    const result = await listOutputMedia({ limit: 20 });

    expect(result.images.map((i) => i.filename)).toEqual(["local_only.png"]);
    expect(result.source.basis).toBe("local-scan");
    expect(getHistoryMock).not.toHaveBeenCalled();
  });

  it("keeps an empty local-scan when /history is also empty", async () => {
    getHistoryMock.mockResolvedValue({});

    const result = await listOutputMedia({ pattern: "panel", limit: 20 });

    expect(result.images).toEqual([]);
    expect(result.source.basis).toBe("local-scan");
    expect(result.source.directory).toBe(outputDir);
  });

  it("keeps an empty local-scan when /history cannot be read", async () => {
    getHistoryMock.mockRejectedValue(new Error("unreachable"));

    const result = await listOutputMedia({ limit: 20 });

    expect(result.images).toEqual([]);
    expect(result.source.basis).toBe("local-scan");
  });

  it("applies the filename pattern to the /history fallback", async () => {
    getHistoryMock.mockResolvedValue(
      historyWithImages([
        { filename: "panel_00001_.png", subfolder: "", type: "output" },
        { filename: "other_00001_.png", subfolder: "", type: "output" },
      ]),
    );

    const result = await listOutputMedia({ pattern: "panel", limit: 20 });

    expect(result.images.map((i) => i.filename)).toEqual(["panel_00001_.png"]);
    expect(result.source.basis).toBe("server-history-fallback");
  });
});
