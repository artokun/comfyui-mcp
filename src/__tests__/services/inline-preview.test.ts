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
  DEFAULT_MAX_DECODED_BYTES,
  DEFAULT_MAX_INPUT_PIXELS,
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

  it("a source past the DECODED-PIXEL budget refuses instead of decoding (codex)", async () => {
    // sharp's own default is a PIXEL ceiling, not a memory one: a 16383x16383 16-bit RGBA
    // PNG passes it and still needs ~2 GiB of decoded surface. The limit here is derived
    // from a memory budget instead, and it is EXPOSED so this can be tested by behaviour —
    // sharp refuses to CREATE an image past its own guard, so an oversized fixture cannot
    // be built and the earlier source-text assertion could only prove the opt-out was
    // absent, never that a big image is actually turned away.
    const img = await noisyPng(400, 400); // 160,000 px

    const out = await boundInlineImage(img, "image/png", {
      budgetBytes: 1_000,
      maxDecodedBytes: 1_000, // far below this image's decoded surface
    });

    expect(out.refused).not.toBeNull();
    expect(out.refused?.reason).toMatch(/MB of memory/);
    expect(out.preview).toBeNull();
    // The full-resolution bytes are handed back untouched for the caller to save/report.
    expect(out.base64).toBe(img);
  });

  it("the memory budget is computed from the HEADER, not an assumed pixel size (codex r3)", async () => {
    // The mistake this replaced: justifying a PIXEL limit as a memory bound. The same
    // 144.6 MP image is ~578 MB at 8-bit RGBA and ~1.08 GiB at 16-bit, so a pixel count
    // cannot express the budget.
    //
    // Proven on the arithmetic rather than with a 16-bit fixture — sharp re-encodes a
    // 16-bit raw input to an 8-bit PNG, so the file would not carry the depth the test
    // claimed. A 400x400 3-channel 8-bit image decodes to exactly 480,000 bytes: the
    // budget must bite one byte below that and clear one byte above it, which is only
    // true if channels and depth come from the header (a hardcoded 4 bytes/px would put
    // the boundary at 640,000).
    const img = await noisyPng(400, 400);
    const exact = 400 * 400 * 3;

    const under = await boundInlineImage(img, "image/png", {
      budgetBytes: 1_000,
      maxDecodedBytes: exact - 1,
    });
    expect(under.refused).not.toBeNull();
    expect(under.refused?.reason).toMatch(/3 channels, 8-bit/);

    const over = await boundInlineImage(img, "image/png", {
      budgetBytes: 1_000,
      maxDecodedBytes: exact,
    });
    expect(over.refused).toBeNull();
    expect(over.preview).not.toBeNull();
  });

  it("the same image previews fine when the pixel budget allows it", async () => {
    // The other half of the guard: it must not be refusing things it should handle. The
    // real default covers the reported 8504x17008 (~144.6 MP) with headroom.
    const img = await noisyPng(400, 400);

    const out = await boundInlineImage(img, "image/png", { budgetBytes: 5_000 });

    expect(out.refused).toBeNull();
    expect(out.preview).not.toBeNull();
    // The reported image must still get through, at BOTH depths — a guard that rejected
    // the very image this issue is about would be a fix in name only.
    expect(DEFAULT_MAX_INPUT_PIXELS).toBeGreaterThan(8504 * 17008);
    expect(DEFAULT_MAX_DECODED_BYTES).toBeGreaterThan(8504 * 17008 * 4); // 8-bit RGBA
    expect(DEFAULT_MAX_DECODED_BYTES).toBeGreaterThan(8504 * 17008 * 8); // 16-bit RGBA
  });

  it("an ANIMATABLE source format is flagged as a single still (codex High)", async () => {
    // NOTE: this fixture is a ONE-FRAME WebP (codex r2 called that out). It proves the
    // format-keyed wiring, which is the whole mechanism — the flag is deliberately keyed
    // on the format rather than on frame count, because this build reports no frame
    // metadata at all, so a multi-frame fixture would not exercise anything extra.
    // Keyed on the FORMAT, not on frame metadata — measured: this sharp/libvips build
    // reports no `pages`, `delay`, `loop` or `pageHeight` at all for a real animated WebP,
    // so a `meta.pages > 1` check could never fire. Shipping that would have been a
    // disclosure that looks present and is dead.
    const w = 300;
    const h = 300;
    const px = Buffer.alloc(w * h * 3);
    let seed = 4242;
    for (let i = 0; i < px.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      px[i] = seed & 0xff;
    }
    const webp = (
      await sharp(px, { raw: { width: w, height: h, channels: 3 } }).webp({ lossless: true }).toBuffer()
    ).toString("base64");

    // Budget chosen by MEASURING this fixture, not guessed: lossless WebP squeezes this
    // pseudo-noise to ~8.4 KB, so a 20 KB budget left it under the bar and produced no
    // preview at all — a test that passed for no reason.
    const out = await boundInlineImage(webp, "image/webp", { budgetBytes: 4_000 });

    expect(out.preview).not.toBeNull();
    expect(out.preview?.sourceMayBeAnimated).toBe(true);

    // …and a PNG source is NOT flagged, so the caveat means something when it appears.
    const png = await noisyPng(300, 300);
    const stillOut = await boundInlineImage(png, "image/png", { budgetBytes: 4_000 });
    expect(stillOut.preview).not.toBeNull();
    expect(stillOut.preview?.sourceMayBeAnimated).toBe(false);
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
