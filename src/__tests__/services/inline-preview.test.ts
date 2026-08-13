// #1495 — get_image inlined an 8504×17008 PNG (~267 MB encoded) and blew the caller's
// 64 MB IPC frame, so a render that saved perfectly could not be looked at.
//
// These use REAL images built with sharp, not stubs. The whole claim of the fix is that a
// predicted compression ratio is not trustworthy — base64 inflates by 4/3 and PNG size
// swings by an order of magnitude with content — so the implementation MEASURES the
// re-encode. A test that stubbed the encoder would be asserting the prediction I chose not
// to trust.
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  boundInlineImage,
  DEFAULT_MAX_PREVIEW_DIMENSION,
} from "../../services/inline-preview.js";

/** A NOISY image: incompressible, so its encoded size tracks its pixel count. */
async function noisyPng(width: number, height: number): Promise<string> {
  const px = Buffer.alloc(width * height * 3);
  // Deterministic pseudo-noise — a flat fill would compress to almost nothing and would
  // not exercise a byte budget at all.
  let seed = 12345;
  for (let i = 0; i < px.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    px[i] = seed & 0xff;
  }
  const buf = await sharp(px, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
  return buf.toString("base64");
}

async function dimsOf(base64: string): Promise<{ width?: number; height?: number }> {
  const m = await sharp(Buffer.from(base64, "base64")).metadata();
  return { width: m.width, height: m.height };
}

describe("boundInlineImage caps what goes on the wire (#1495)", () => {
  it("an OVER-BUDGET image is downscaled to fit, and says so", async () => {
    const original = await noisyPng(900, 900);
    const budget = 100_000; // far below what 900×900 of noise encodes to

    const out = await boundInlineImage(original, "image/png", { budgetBytes: budget });

    // The actual payload fits — measured, not predicted. This is the assertion the whole
    // design exists for.
    expect(out.base64.length).toBeLessThanOrEqual(budget);
    expect(out.refused).toBeNull();

    // And it announces itself, with the TRUE original dimensions, so an agent cannot read
    // fine detail off a preview believing it is the full render.
    expect(out.preview).not.toBeNull();
    expect(out.preview?.originalWidth).toBe(900);
    expect(out.preview?.originalHeight).toBe(900);
    expect(out.preview?.width).toBeLessThan(900);
    expect(out.preview?.originalEncodedBytes).toBe(original.length);
  });

  it("an UNDER-BUDGET image is returned byte-identical — no silent re-encode", async () => {
    // The direction that must not regress: an ordinary render has to come back untouched,
    // or every image an agent sees is quietly degraded to fix a pathological case.
    const original = await noisyPng(64, 64);

    const out = await boundInlineImage(original, "image/png", { budgetBytes: 10_000_000 });

    expect(out.base64).toBe(original);
    expect(out.mimeType).toBe("image/png");
    expect(out.preview).toBeNull();
    expect(out.refused).toBeNull();
  });

  it("a small-but-ENORMOUS-dimension image is still capped", async () => {
    // The reporter's image was 17008px on one side. A long, thin, flat image can encode
    // tiny while still exceeding a consumer's dimension limit, so bytes alone are not the
    // only bound.
    const wide = (
      await sharp({
        create: { width: 9000, height: 8, channels: 3, background: { r: 3, g: 4, b: 5 } },
      })
        .png()
        .toBuffer()
    ).toString("base64");

    const out = await boundInlineImage(wide, "image/png", { budgetBytes: 50_000_000 });

    expect(out.preview).not.toBeNull();
    const dims = await dimsOf(out.base64);
    expect(dims.width).toBeLessThanOrEqual(DEFAULT_MAX_PREVIEW_DIMENSION);
    expect(out.preview?.originalWidth).toBe(9000);
  });

  it("an UNDECODABLE payload refuses instead of throwing away the fetch", async () => {
    // A preview failure must never destroy an image that was fetched and saved fine — the
    // caller keeps the file and reports what happened.
    const junk = Buffer.from("this is not an image at all").toString("base64");

    const out = await boundInlineImage(junk, "image/png", { budgetBytes: 10 });

    expect(out.refused).not.toBeNull();
    expect(out.refused?.originalEncodedBytes).toBe(junk.length);
    expect(out.preview).toBeNull();
  });

  it("an absurd budget refuses rather than looping or emitting an over-budget payload", async () => {
    // Bounded attempts. The failure has to be honest: no payload is better than one that
    // dies in transport with a byte count and no mention of the image.
    const original = await noisyPng(600, 600);

    const out = await boundInlineImage(original, "image/png", { budgetBytes: 32 });

    if (out.refused) {
      expect(out.refused.reason).toMatch(/could not be reduced/);
    } else {
      // If it did manage it, the invariant still holds.
      expect(out.base64.length).toBeLessThanOrEqual(32);
    }
  });
});
