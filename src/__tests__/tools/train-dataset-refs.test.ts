import { describe, expect, it, beforeEach, vi } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// train_prepare_dataset items now take path OR a ComfyUI ref — refs are how
// phone/panel pickers hand over selections. Pin the resolution semantics
// (output/input roots, containment) and the traversal rejections.
const prepareMock = vi.fn((opts: { items: Array<{ path: string; caption?: string }> }) =>
  Promise.resolve({ datasetPath: "/datasets/x", imageCount: opts.items.length, captionedCount: 0, warnings: [] }),
);
vi.mock("../../services/training-jobs.js", () => ({
  cancelJob: vi.fn(),
  getJob: vi.fn(),
  hfCacheRoot: vi.fn(),
  listJobs: vi.fn(() => Promise.resolve([])),
  prepareDataset: (...a: unknown[]) => prepareMock(...a),
  startTrainingJob: vi.fn(),
  trainingRoot: vi.fn(() => "/tmp/training"),
}));
vi.mock("../../services/ai-toolkit.js", () => ({
  buildTrainerImage: vi.fn(),
  dockerAvailable: vi.fn(),
  trainerDoctor: vi.fn(),
  trainerImageExists: vi.fn(),
  TRAINER_IMAGE: "trainer:test",
}));
let outRoot = "/comfy/output";
let remote = false;
vi.mock("../../services/output-dir.js", () => ({
  resolveOutputDir: () => Promise.resolve(outRoot),
  resolveInputDir: () => Promise.resolve("/comfy/input"),
}));
vi.mock("../../config.js", () => ({ isRemoteMode: () => remote }));

import { registerTrainTools } from "../../tools/train.js";

type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;
function getTool(name: string): { handler: ToolHandler; shape: Record<string, { safeParse: (v: unknown) => { success: boolean } }> } {
  let handler: ToolHandler | undefined;
  let shape: Record<string, never> | undefined;
  const server = { tool: (n: string, _d: string, s: unknown, h: ToolHandler) => { if (n === name) { handler = h; shape = s as never; } } };
  registerTrainTools(server as never);
  if (!handler || !shape) throw new Error(`tool ${name} not registered`);
  return { handler, shape: shape as never };
}

const call = (items: unknown[]) => getTool("train_prepare_dataset").handler({ action: "prepare", name: "ds", items });

beforeEach(() => {
  vi.clearAllMocks();
  outRoot = "/comfy/output";
  remote = false;
});

describe("train_prepare_dataset — path/ref items", () => {
  it("path-only items pass through untouched", async () => {
    await call([{ path: "/host/pic.png", caption: "c" }]);
    expect(prepareMock.mock.calls[0][0].items).toEqual([{ path: "/host/pic.png", caption: "c" }]);
  });

  it("an explicit path WINS when ref is also present", async () => {
    await call([{ path: "/host/pic.png", ref: { filename: "other.png" } }]);
    expect(prepareMock.mock.calls[0][0].items[0].path).toBe("/host/pic.png");
  });

  it("ref resolves against the output root by default (top level + subfolder)", async () => {
    await call([{ ref: { filename: "a.png" } }, { ref: { filename: "b.png", subfolder: "vid" } }]);
    const items = prepareMock.mock.calls[0][0].items;
    expect(items[0].path).toBe(resolve("/comfy/output", "a.png"));
    expect(items[1].path).toBe(resolve("/comfy/output", "vid", "b.png"));
  });

  it("ref type:'input' resolves against the input root", async () => {
    await call([{ ref: { filename: "up.png", type: "input" } }]);
    expect(prepareMock.mock.calls[0][0].items[0].path).toBe(resolve("/comfy/input", "up.png"));
  });

  it("ref filename with a path separator is rejected", async () => {
    const res = await call([{ ref: { filename: "sub/a.png" } }]);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("basename");
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it("a '..' subfolder escaping the root is rejected (path traversal)", async () => {
    const res = await call([{ ref: { filename: "secret.txt", subfolder: "../../.." } }]);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("escapes");
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it("an item with NEITHER path nor ref fails schema validation", () => {
    const { shape } = getTool("train_prepare_dataset");
    const items = shape.items as { safeParse: (v: unknown) => { success: boolean } };
    expect(items.safeParse([{ caption: "lost" }]).success).toBe(false);
    expect(items.safeParse([{ path: "/x.png" }]).success).toBe(true);
    expect(items.safeParse([{ ref: { filename: "x.png" } }]).success).toBe(true);
  });

  it("refs are REJECTED in remote mode (the paths would resolve on the wrong machine)", async () => {
    remote = true;
    const res = await call([{ ref: { filename: "a.png" } }]);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("LOCAL ComfyUI");
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it("a symlinked subfolder pointing OUTSIDE the root is rejected (codex: lexical check bypass)", async () => {
    const base = mkdtempSync(join(tmpdir(), "dsref-"));
    const out = join(base, "output");
    const outside = join(base, "outside");
    mkdirSync(out, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "x.png"), "x");
    symlinkSync(outside, join(out, "link"), "junction");
    outRoot = out;
    const res = await call([{ ref: { filename: "x.png", subfolder: "link" } }]);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("escapes");
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it("a symlink INSIDE the root pointing inside the root resolves to its real path", async () => {
    const base = mkdtempSync(join(tmpdir(), "dsref-"));
    const out = join(base, "output");
    const real = join(out, "real");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "y.png"), "y");
    symlinkSync(real, join(out, "alias"), "junction");
    outRoot = out;
    await call([{ ref: { filename: "y.png", subfolder: "alias" } }]);
    expect(prepareMock).toHaveBeenCalled();
    // train.ts canonicalises with fs/promises realpath — NATIVE semantics, which also
    // expands an 8.3 short temp dir (RUNNER~1 on GitHub's Windows runners); the JS
    // realpathSync would not, and expected a spelling the tool never produces.
    expect(prepareMock.mock.calls[0][0].items[0].path).toBe(
      realpathSync.native(join(out, "alias", "y.png")),
    );
  });
});
