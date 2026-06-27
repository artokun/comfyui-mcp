import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock resolveOutputDir so the scan targets our temp dir; everything else
// (readdir/stat/extname classification) runs for real.
let outputDir = "";
vi.mock("../../services/output-dir.js", () => ({
  resolveOutputDir: () => Promise.resolve(outputDir),
  resolveInputDir: () => Promise.resolve(outputDir),
}));

import { listOutputImages } from "../../services/image-management.js";

async function touch(name: string, when: Date, bytes = 1024): Promise<void> {
  const p = join(outputDir, name);
  await writeFile(p, Buffer.alloc(bytes));
  await utimes(p, when, when);
}

beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), "comfy-out-"));
});

afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
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
});
