import sharp from "sharp";
import type { Metadata } from "sharp";

/**
 * #1495 — BOUND WHAT GOES ON THE WIRE, NOT WHAT GOES ON DISK.
 *
 * `get_image action:"get"` inlined whatever it fetched. An 8504×17008 render encoded to
 * ~267 MB and blew Codex code-mode's 64 MB IPC frame, so the agent could not look at an
 * output that had saved perfectly well. The reporter ended up adding a low-resolution
 * preview branch to their own workflow to inspect their own render.
 *
 * THE BUDGET IS ON THE ENCODED SIZE, not on pixels. base64 inflates by 4/3 and PNG
 * compression varies enormously with content — a flat 8K poster and a noisy 8K photo differ
 * by an order of magnitude — so a pixel cap alone still overshoots on exactly the images
 * that matter. The scale is therefore chosen by MEASURING the re-encode and shrinking again
 * if it is still over, rather than by predicting a compression ratio.
 *
 * WHAT THIS DOES NOT DO: it does not touch the saved file, and it does not claim to satisfy
 * any particular model's image limits (those differ per provider and this code cannot know
 * its consumer). It bounds the TRANSPORT, which is the failure in the report.
 *
 * SHARP'S PIXEL GUARD IS LEFT ON (codex). An early version passed
 * `limitInputPixels: false`, which was both unnecessary and dangerous: the reported
 * 8504×17008 image is ~145 MP, comfortably under sharp's ~268 MP default, so nothing in
 * this bug required disabling it — while a 20000×20000 solid-colour PNG encodes to a few MB,
 * sails under the byte budget, and would decode to a ~1.5 GiB RGBA surface. Turning the
 * guard off to fix an image it never blocked would have traded a transport failure for an
 * out-of-memory one. An image past the guard now REFUSES with its reason, which is a
 * survivable answer.
 */

/** Default ceiling on the base64 payload handed back inline. */
export const DEFAULT_INLINE_BUDGET_BYTES = 16 * 1024 * 1024;

/** Hard ceiling on any single side of the preview, applied even when bytes are fine. */
export const DEFAULT_MAX_PREVIEW_DIMENSION = 4096;

/** How many shrink attempts before giving up and reporting honestly. */
const MAX_ATTEMPTS = 5;

/** Source formats that CAN hold multiple frames/pages. See `sourceMayBeAnimated`.
 *  AVIF sequences and multi-page HEIF/TIFF belong here too (codex r2) — sharp reads all of
 *  them as multi-page, and each collapses to one still exactly like an animated GIF. */
const ANIMATABLE_MIME = /^image\/(gif|webp|apng|avif|heic|heif|tiff?)$/i;

/**
 * Coarse pixel ceiling, applied by sharp while it parses the header.
 *
 * This is NOT the memory bound — a pixel count cannot be one (codex r3). It only keeps a
 * absurdly-dimensioned file from reaching the decoder at all; the real check is
 * `DEFAULT_MAX_DECODED_BYTES` below, which is applied once the header has told us the
 * depth and channel count.
 *
 * Set above the reported 8504x17008 (~144.6 MP) on purpose: a guard that protected memory
 * by rejecting the very image this issue is about would be a fix in name only.
 */
export const DEFAULT_MAX_INPUT_PIXELS = 192_000_000;

/**
 * Ceiling on the DECODED SIZE of a source we will try to preview.
 *
 * A pixel limit is the wrong unit and sharp's own default proves it: ~268 MP passes a
 * 16383x16383 image whose 16-bit RGBA surface is ~2 GiB. My first attempt repeated the
 * mistake one step down — 192 MP was justified as "~768 MB at 4 bytes/px", which is only
 * true for 8-bit RGBA; the SAME 144.6 MP image at 16-bit RGBA decodes to ~1.08 GiB (codex).
 *
 * So the budget is expressed in BYTES and computed from the header's actual depth and
 * channel count, which makes it hold for every input rather than for the one I pictured.
 * 1.25 GiB clears the reported image at 8-bit RGBA (~578 MB) and at 16-bit RGBA (~1.08 GiB)
 * while still turning away the surfaces that would stall a process.
 */
export const DEFAULT_MAX_DECODED_BYTES = 1_342_177_280;

export interface BoundInlineImageOptions {
  /** Max base64 length to emit. */
  budgetBytes?: number;
  /** Max width/height of the preview. */
  maxDimension?: number;
  /** Coarse pixel ceiling handed to sharp's header parser. */
  maxInputPixels?: number;
  /** Ceiling on the source's DECODED byte size. Exposed so the refusal path can be tested
   *  by BEHAVIOUR rather than by reading the source — sharp will not create an image past
   *  its own guard, so an oversized fixture cannot be built. */
  maxDecodedBytes?: number;
}

export interface BoundInlineImage {
  /** The payload to inline — the original when it already fit. */
  base64: string;
  mimeType: string;
  /**
   * Null when the original was returned untouched. Otherwise the facts a caller needs to
   * avoid over-reading a preview: what it was, what it is now, and what it cost.
   *
   * A silently downscaled image is a WORSE failure than the one being fixed — an agent
   * will read fine detail off it and report confidently — so this is never optional
   * information, and the caller is expected to say it out loud.
   */
  preview: null | {
    width: number;
    height: number;
    originalWidth: number | null;
    originalHeight: number | null;
    encodedBytes: number;
    originalEncodedBytes: number;
    /**
     * True when the SOURCE FORMAT can carry animation (GIF/WebP/APNG) and the preview is
     * therefore a single still (codex).
     *
     * Keyed on the format, NOT on frame metadata, because measuring showed there is no
     * frame metadata to key on: this sharp/libvips build returns no `pages`, `delay`,
     * `loop` or `pageHeight` for a real animated WebP — the whole animation surface is
     * absent from `metadata()`. A `meta.pages > 1` check therefore could never fire, and
     * shipping it would have been a disclosure that looks present and is dead.
     *
     * The format is always known, so this can over-warn on a single-frame GIF and can
     * never under-warn on an animated one. For a caveat whose job is to stop an agent
     * judging motion from a still, that is the correct direction to be wrong in.
     */
    sourceMayBeAnimated: boolean;
    /** True when the preview is a lossy representation of the source's colour beyond the
     *  resize: 16-bit depth flattened to 8-bit, or CMYK re-expressed as RGB (codex). */
    recoded: boolean;
  };
  /** Set when the image was over budget and could NOT be reduced — nothing is inlined. */
  refused: null | { reason: string; originalEncodedBytes: number };
}

/**
 * Return `base64` unchanged when it fits, a downscaled PNG preview when it does not, or a
 * refusal when it cannot be reduced.
 *
 * Never throws for an unreadable/exotic image: a preview failure must not destroy a fetch
 * that succeeded, so it degrades to `refused` and the caller keeps the saved file and says
 * what happened.
 */
export async function boundInlineImage(
  base64: string,
  mimeType: string,
  opts: BoundInlineImageOptions = {},
): Promise<BoundInlineImage> {
  const budget = Math.max(1, opts.budgetBytes ?? DEFAULT_INLINE_BUDGET_BYTES);
  const maxDim = Math.max(1, opts.maxDimension ?? DEFAULT_MAX_PREVIEW_DIMENSION);
  const limitInputPixels = Math.max(1, opts.maxInputPixels ?? DEFAULT_MAX_INPUT_PIXELS);
  const maxDecodedBytes = Math.max(1, opts.maxDecodedBytes ?? DEFAULT_MAX_DECODED_BYTES);
  const originalEncodedBytes = base64.length;

  let width: number | null = null;
  let height: number | null = null;
  if (originalEncodedBytes <= budget) {
    // Under budget on bytes — but a very long, thin image can still exceed a consumer's
    // dimension limit while encoding small, so the dimension cap is checked too. Reading
    // metadata is cheap (a header parse), and a failure here is not a reason to withhold
    // an image that already fits.
    try {
      const meta = await sharp(Buffer.from(base64, "base64"), { limitInputPixels }).metadata();
      width = meta.width ?? null;
      height = meta.height ?? null;
    } catch {
      return { base64, mimeType, preview: null, refused: null };
    }
    if ((width ?? 0) <= maxDim && (height ?? 0) <= maxDim) {
      return { base64, mimeType, preview: null, refused: null };
    }
  }

  const source = Buffer.from(base64, "base64");
  let meta: Metadata;
  try {
    meta = await sharp(source, { limitInputPixels }).metadata();
  } catch (err) {
    return {
      base64,
      mimeType,
      preview: null,
      refused: {
        reason: `the image could not be decoded to build a preview (${err instanceof Error ? err.message : String(err)})`,
        originalEncodedBytes,
      },
    };
  }
  const ow = meta.width ?? null;
  const oh = meta.height ?? null;
  if (!ow || !oh) {
    return {
      base64,
      mimeType,
      preview: null,
      refused: { reason: "the image reported no dimensions, so it cannot be scaled", originalEncodedBytes },
    };
  }

  // THE MEMORY CHECK, made from the header rather than from an assumed pixel format. The
  // resize below is what allocates the full surface, so this is the last point at which a
  // refusal is still cheap.
  const bytesPerChannel = meta.depth != null && meta.depth !== "uchar" ? 2 : 1;
  const channels = meta.channels ?? 4;
  const decodedBytes = ow * oh * channels * bytesPerChannel;
  if (decodedBytes > maxDecodedBytes) {
    return {
      base64,
      mimeType,
      preview: null,
      refused: {
        reason:
          `decoding it would need about ${Math.round(decodedBytes / 1_048_576)} MB of memory ` +
          `(${ow}x${oh}, ${channels} channels, ${bytesPerChannel * 8}-bit), over the ` +
          `${Math.round(maxDecodedBytes / 1_048_576)} MB preview limit`,
        originalEncodedBytes,
      },
    };
  }

  // First target: the dimension cap, or a byte-driven guess when the cap alone is not the
  // binding constraint. The guess only picks a STARTING point — the loop below measures.
  let target = Math.min(maxDim, Math.max(ow, oh));
  if (originalEncodedBytes > budget) {
    const ratio = Math.sqrt(budget / originalEncodedBytes);
    target = Math.min(target, Math.max(1, Math.floor(Math.max(ow, oh) * ratio)));
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const buf = await sharp(source, { limitInputPixels })
        .resize({ width: target, height: target, fit: "inside", withoutEnlargement: true })
        .png({ compressionLevel: 9 })
        .toBuffer({ resolveWithObject: true });
      const encoded = buf.data.toString("base64");
      if (encoded.length <= budget) {
        return {
          base64: encoded,
          mimeType: "image/png",
          preview: {
            width: buf.info.width,
            height: buf.info.height,
            originalWidth: ow,
            originalHeight: oh,
            encodedBytes: encoded.length,
            originalEncodedBytes,
            sourceMayBeAnimated: ANIMATABLE_MIME.test(mimeType),
            // An ICC profile counts too (codex r2): sharp's default output converts to
            // sRGB and drops the profile, so a Display-P3 or Adobe-RGB source comes back
            // materially different in colour while being 8-bit and non-CMYK.
            recoded:
              (meta.depth != null && meta.depth !== "uchar") ||
              meta.space === "cmyk" ||
              // An ICC profile only counts when it is NOT already sRGB (codex r3): ComfyUI
              // PNGs routinely embed an sRGB profile, and flagging every one of them would
              // make the recode warning noise on the common case — which is how a caveat
              // stops being read.
              (meta.hasProfile === true && meta.space !== "srgb"),
          },
          refused: null,
        };
      }
      // Measured, still over. Halve and try again rather than trusting the ratio.
      target = Math.max(1, Math.floor(target / 2));
    } catch (err) {
      return {
        base64,
        mimeType,
        preview: null,
        refused: {
          reason: `building a preview failed (${err instanceof Error ? err.message : String(err)})`,
          originalEncodedBytes,
        },
      };
    }
  }

  return {
    base64,
    mimeType,
    preview: null,
    refused: {
      reason: `the image could not be reduced under ${budget} encoded bytes in ${MAX_ATTEMPTS} attempts`,
      originalEncodedBytes,
    },
  };
}
