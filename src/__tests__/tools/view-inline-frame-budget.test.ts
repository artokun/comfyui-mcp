// #2692 — a code-mode script awaited nine `get_image action:"view"` results (the report
// names it by the per-tool spelling that action replaced) and forwarded all nine images. The serialized IPC frame came
// to 108,765,829 bytes against a hard 67,108,864-byte limit and the WHOLE response was
// lost, including the eight images that were not the problem.
//
// Two separate defects made that possible, and this file pins both AT THE TOOL BOUNDARY
// rather than at the helpers — the helpers were already correct, they were simply not
// reached from here. Only `getOutputImage` (the HTTP fetch) and the asset registry are
// stubbed; `view-image.ts`, `inline-preview.ts`, the frame budget and sharp are all real.
//
//   1. action:"view" had NO inline bound. #1495 capped action:"get" and this sibling was
//      left inlining whatever it fetched, at any size.
//   2. A per-image bound cannot bound a frame that carries N images. Measured on a
//      synthetic 3648x5472 source of the reported dimensions: WITH the #1495 bound each
//      asset still lands at ~11.1 MB of base64, and nine come to ~99.8 MB — over the limit
//      by half again. The batch needs a ceiling of its own.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { z } from "zod";

const getOutputImageMock = vi.fn();
vi.mock("../../services/image-management.js", () => ({
  extractWorkflowFromImage: vi.fn(),
  listOutputImages: vi.fn(async () => []),
  listOutputMedia: vi.fn(async () => ({ images: [], source: { basis: "local-scan" } })),
  getOutputImage: (...a: unknown[]) => getOutputImageMock(...a),
  uploadImageAuto: vi.fn(),
  uploadVideoAuto: vi.fn(),
  uploadAudioAuto: vi.fn(),
  stageOutputAsInput: vi.fn(),
}));

const registryGetMock = vi.fn();
vi.mock("../../services/asset-registry.js", () => ({
  AssetRegistry: { list: vi.fn(), get: (...a: unknown[]) => registryGetMock(...a) },
}));

vi.mock("../../services/asset-reconcile.js", () => ({
  MAX_RECONCILIATION_PROBE_ATTEMPTS: 16,
  reconcileAssetsFromHistory: vi.fn(),
}));

// action:"get" writes the fetched bytes to disk; never touch the real filesystem.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, mkdir: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) };
});

import { registerImageManagementTools } from "../../tools/image-management.js";
import { CODE_MODE_FRAME_BYTES, resetInlineImageSlots } from "../../services/inline-frame-budget.js";

type ToolResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
};
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function getImage(): Handler {
  const tools: Array<{ name: string; handler: Handler }> = [];
  const server = {
    tool: (name: string, _d: string, _s: z.ZodRawShape, handler: Handler) => {
      tools.push({ name, handler });
    },
  };
  registerImageManagementTools(server as never);
  expect(tools[0].name).toBe("get_image");
  return tools[0].handler;
}

/**
 * A NOISY PNG: incompressible, so its encoded size tracks its pixel count and a byte budget
 * is actually exercised. A flat fill compresses to nothing and would sail under any ceiling,
 * proving only that the test image was small.
 */
async function noisyPngBase64(width: number, height: number, seedStart: number): Promise<string> {
  const px = Buffer.alloc(width * height * 3);
  let seed = seedStart;
  for (let i = 0; i < px.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    px[i] = seed & 0xff;
  }
  const buf = await sharp(px, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
  return buf.toString("base64");
}

const inlineBytes = (res: ToolResult) =>
  res.content.filter((c) => c.type === "image").reduce((n, c) => n + (c.data?.length ?? 0), 0);
const textOf = (res: ToolResult) => res.content.map((c) => c.text ?? "").join(" ");

beforeEach(() => {
  vi.clearAllMocks();
  resetInlineImageSlots();
  registryGetMock.mockImplementation((id: string) => ({
    assetId: id,
    promptId: "p1",
    nodeId: "9",
    filename: `${id}.png`,
    subfolder: "",
    type: "output",
    url: "u",
    source: "watched",
    createdAt: 0,
    createdAtSource: "watched",
  }));
});

afterEach(() => {
  resetInlineImageSlots();
  delete process.env.COMFYUI_MCP_AGGREGATE_INLINE_BYTES;
});

describe('get_image action:"view" bounds its inline payload at all (#2692 defect 1)', () => {
  it("an OVER-BUDGET asset is downscaled to fit and announces itself", async () => {
    const original = await noisyPngBase64(700, 700, 12345);
    getOutputImageMock.mockResolvedValue({ base64: original, mimeType: "image/png" });

    const res = await getImage()({ action: "view", asset_id: "a_1", max_preview_bytes: 120_000 });

    // Before this fix the asset went out at full encoded size, whatever that was. This is
    // the assertion that fails outright when the boundInlineImage call is deleted from
    // view-image.ts — nothing else in the path caps anything.
    expect(inlineBytes(res)).toBeLessThanOrEqual(120_000);
    expect(inlineBytes(res)).toBeGreaterThan(0);
    expect(original.length).toBeGreaterThan(120_000);

    // A silent downscale is a worse failure than the one being fixed: an agent reads fine
    // detail off a preview and reports confidently. So it must SAY it is a preview, give the
    // true original dimensions, and name a route to the real pixels.
    const t = textOf(res);
    expect(t).toContain("PREVIEW ONLY");
    expect(t).toContain("700×700");
    expect(t).toContain('get_image (action:"get"');
  });

  it("an UNDER-BUDGET asset is passed through byte-identical — no silent re-encode", async () => {
    const original = await noisyPngBase64(40, 40, 777);
    getOutputImageMock.mockResolvedValue({ base64: original, mimeType: "image/png" });

    const res = await getImage()({ action: "view", asset_id: "a_1" });

    const img = res.content.find((c) => c.type === "image");
    expect(img?.data).toBe(original);
    expect(img?.mimeType).toBe("image/png");
    // No caveat, because nothing happened to it. A preview warning on an untouched image is
    // how a reader learns to ignore the warning.
    expect(textOf(res)).not.toContain("PREVIEW ONLY");
    expect(textOf(res)).not.toContain("BATCH LIMIT");
  });
});

describe("a BATCH of view calls fits one transport frame (#2692 defect 2)", () => {
  /**
   * The aggregate is scaled down for the test rather than the images scaled up. Nine real
   * 3648x5472 sources take minutes to encode nine times over; the arithmetic being pinned —
   * "nine per-image budgets overflow, nine shared budgets do not" — is identical at any
   * scale, and the production numbers are pinned separately in
   * `inline-frame-budget.test.ts` (9 x 16 MB > 64 MiB).
   */
  const SCALED_AGGREGATE = 900_000;

  async function fixtures(n: number): Promise<string[]> {
    return Promise.all(Array.from({ length: n }, (_, i) => noisyPngBase64(320, 480, 1000 + i)));
  }

  it("nine CONCURRENT views total under the aggregate; the same nine SEQUENTIALLY do not", async () => {
    process.env.COMFYUI_MCP_AGGREGATE_INLINE_BYTES = String(SCALED_AGGREGATE);
    const images = await fixtures(9);
    getOutputImageMock.mockImplementation(async (filename: string) => {
      const idx = Number(/a_(\d+)/.exec(filename)?.[1] ?? 0);
      return { base64: images[idx], mimeType: "image/png" };
    });
    const handler = getImage();
    const call = (i: number) => handler({ action: "view", asset_id: `a_${i}` });

    // THE CONTROL, and it runs against the same aggregate, the same images and the same
    // handler — only the overlap differs. Without it "the total is small" could just mean
    // the fixtures were small, and the test would pass with the slot wiring deleted.
    let sequentialTotal = 0;
    for (let i = 0; i < 9; i++) sequentialTotal += inlineBytes(await call(i));
    expect(sequentialTotal).toBeGreaterThan(SCALED_AGGREGATE);

    resetInlineImageSlots();

    const results = await Promise.all(Array.from({ length: 9 }, (_, i) => call(i)));
    const concurrentTotal = results.reduce((n, r) => n + inlineBytes(r), 0);
    expect(concurrentTotal).toBeLessThanOrEqual(SCALED_AGGREGATE);
    expect(concurrentTotal).toBeLessThan(sequentialTotal);

    // Every image still comes back. Refusing six of nine would also fit the frame and would
    // be a worse answer than the bug.
    for (const r of results) expect(inlineBytes(r)).toBeGreaterThan(0);

    // And each one says WHY it is small, because "smaller than you asked for, no reason
    // given" is the failure mode inline-preview.ts exists to prevent.
    const t = textOf(results[0]);
    expect(t).toContain("BATCH LIMIT");
    expect(t).toContain("9 image fetches were in flight");
    expect(t).toContain("Fetch fewer at a time");
  });

  it('the batch ceiling reaches action:"get" too, not just action:"view"', async () => {
    // #1495 fixed one exit of this family and left its sibling unbounded, which is how
    // #2692 happened. The batch ceiling is wired at the handler, above both actions —
    // assert that from the outside rather than trusting the placement.
    process.env.COMFYUI_MCP_AGGREGATE_INLINE_BYTES = String(SCALED_AGGREGATE);
    const images = await fixtures(9);
    getOutputImageMock.mockImplementation(async (filename: string) => {
      const idx = Number(/(\d+)/.exec(filename)?.[1] ?? 0);
      return { base64: images[idx], mimeType: "image/png" };
    });
    const handler = getImage();

    const results = await Promise.all(
      Array.from({ length: 9 }, (_, i) => handler({ action: "get", filename: `${i}.png` })),
    );
    const total = results.reduce((n, r) => n + inlineBytes(r), 0);
    expect(total).toBeLessThanOrEqual(SCALED_AGGREGATE);
    expect(textOf(results[0])).toContain("BATCH LIMIT");
  });

  it("a NON-inlining action running alongside does not widen the batch", async () => {
    // action:"list_assets" carries no pixels. If it took a slot it would shrink a real image's
    // preview for nothing, which is the over-refusal this design has to avoid.
    process.env.COMFYUI_MCP_AGGREGATE_INLINE_BYTES = String(SCALED_AGGREGATE);
    const image = await noisyPngBase64(320, 480, 4242);
    getOutputImageMock.mockResolvedValue({ base64: image, mimeType: "image/png" });
    const handler = getImage();

    const [viewRes] = await Promise.all([
      handler({ action: "view", asset_id: "a_0" }),
      ...Array.from({ length: 8 }, () => handler({ action: "list_assets" })),
    ]);

    // Alone among the inlining calls, so it gets the whole aggregate — which here is larger
    // than the image, so the image goes out untouched.
    expect(inlineBytes(viewRes)).toBe(image.length);
    expect(textOf(viewRes)).not.toContain("BATCH LIMIT");
  });

  it("slots are released even when the fetch throws, so a later batch is not narrowed", async () => {
    // A leaked slot never fails loudly. It silently prices every later call for a batch that
    // finished long ago, and nothing about that symptom points at this file.
    process.env.COMFYUI_MCP_AGGREGATE_INLINE_BYTES = String(SCALED_AGGREGATE);
    const handler = getImage();
    getOutputImageMock.mockRejectedValue(new Error("connection reset"));
    await Promise.all(Array.from({ length: 8 }, (_, i) => handler({ action: "view", asset_id: `a_${i}` })));

    const image = await noisyPngBase64(320, 480, 99);
    getOutputImageMock.mockResolvedValue({ base64: image, mimeType: "image/png" });
    const after = await handler({ action: "view", asset_id: "a_0" });
    expect(inlineBytes(after)).toBe(image.length);
  });

  it("nine unshared per-image budgets would overrun the real frame", () => {
    // The production arithmetic the scaled test stands in for, stated in the real numbers
    // from the report so a future reader can check it without re-deriving the scale.
    expect(9 * 12_085_092).toBeGreaterThan(CODE_MODE_FRAME_BYTES);
    expect(CODE_MODE_FRAME_BYTES).toBe(67_108_864);
  });
});
