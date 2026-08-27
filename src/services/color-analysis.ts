import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { requireSharp } from "./sharp-loader.js";
import { AssetRegistry } from "./asset-registry.js";
import { getOutputImage } from "./image-management.js";
import { resolveOutputDir } from "./output-dir.js";
import { ValidationError } from "../utils/errors.js";

// ---------------------------------------------------------------------------
// get_image (action:"analyze_color") — objective color scopes/stats for a rendered image.
//
// Motivation: judging "washed out" by eye off a contact sheet is unreliable.
// This computes the numbers a colorist reads off scopes — black/white points,
// contrast (luma std), saturation, per-channel means (cast), and clipping —
// so the agent can diagnose color deterministically and pick a fix, plus an
// optional reference comparison (shot match) for "how far from the source?".
// ---------------------------------------------------------------------------

export interface AnalyzeColorOptions {
  asset_id?: string;
  path?: string;
  filename?: string;
  subfolder?: string;
  type?: "output" | "input" | "temp";
  reference_path?: string;
  histogram?: boolean;
}

export interface ColorStats {
  width: number;
  height: number;
  luma: {
    mean: number;
    median: number;
    contrast: number; // std-dev of luma (higher = punchier)
    blackPoint: number; // 1st percentile
    whitePoint: number; // 99th percentile
    dynamicRange: number; // whitePoint - blackPoint
    clippedLowPct: number; // % pixels at/near 0
    clippedHighPct: number; // % pixels at/near 255
  };
  saturation: {
    meanSaturation: number; // HSV S, 0..1
    meanChroma: number; // max-min, 0..255
  };
  channels: {
    rMean: number;
    gMean: number;
    bMean: number;
    castHint: string;
  };
  flags: {
    washedOut: boolean;
    lowContrast: boolean;
    liftedBlacks: boolean;
    dimHighlights: boolean;
    lowSaturation: boolean;
    colorCast: boolean;
  };
  verdict: string;
}

export interface AnalyzeColorResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
}

// Heuristic thresholds (8-bit). Rough but practical; tuned for video frames.
const TH = {
  liftedBlack: 16, // blackPoint above this = blacks not reaching 0
  dimWhite: 235, // whitePoint below this = highlights don't reach top
  lowContrast: 45, // luma std below this = flat
  lowSaturation: 0.22, // mean HSV saturation below this = desaturated
  colorCast: 12, // spread between channel means above this = cast
};

interface RawPixels {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

async function resolveBytes(opts: AnalyzeColorOptions): Promise<Buffer> {
  if (opts.asset_id) {
    const record = AssetRegistry.get(opts.asset_id);
    if (!record) {
      throw new ValidationError(
        `No asset found for id "${opts.asset_id}". It may have expired or never been registered.`,
      );
    }
    const validType =
      record.type === "output" || record.type === "input" || record.type === "temp";
    const fetchType: "output" | "input" | "temp" = validType
      ? (record.type as "output" | "input" | "temp")
      : "output";
    const image = await getOutputImage(record.filename, fetchType, record.subfolder);
    return Buffer.from(image.base64, "base64");
  }

  if (opts.filename) {
    const image = await getOutputImage(
      opts.filename,
      opts.type ?? "output",
      opts.subfolder ?? "",
    );
    return Buffer.from(image.base64, "base64");
  }

  if (opts.path) {
    return readFile(await resolveSafePath(opts.path));
  }

  throw new ValidationError(
    'get_image (action:"analyze_color") requires one of: asset_id, filename (+optional subfolder/type), or path.',
  );
}

// Allow an absolute path anywhere readable, or a path under the ComfyUI output
// dir. Reject parent-dir escapes on relative inputs.
async function resolveSafePath(path: string): Promise<string> {
  if (path.trim().length === 0) {
    throw new ValidationError("path must be a non-empty string.");
  }
  if (isAbsolute(path)) return resolve(path);
  const outputDir = await resolveOutputDir();
  const resolved = resolve(outputDir, path);
  if (resolved !== outputDir && !resolved.startsWith(outputDir + sep)) {
    throw new ValidationError("relative path must stay within the ComfyUI output directory.");
  }
  return resolved;
}

async function toRaw(bytes: Buffer): Promise<RawPixels> {
  // #2411 — loaded HERE, not at module scope. A blocked libvips used to throw
  // while this file evaluated, which took every tool registration down with it.
  const sharp = await requireSharp("Colour analysis");
  const { data, info } = await sharp(bytes, { limitInputPixels: 100_000_000 })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function percentile(hist: Float64Array, total: number, p: number): number {
  if (total === 0) return 0;
  const target = p * total;
  let cum = 0;
  for (let i = 0; i < 256; i++) {
    cum += hist[i];
    if (cum >= target) return i;
  }
  return 255;
}

export function computeStats(raw: RawPixels): ColorStats {
  const { data, width, height, channels } = raw;
  const stride = channels;
  const pixelCount = width * height;

  const lumaHist = new Float64Array(256);

  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let satSum = 0;
  let chromaSum = 0;

  for (let i = 0; i < data.length; i += stride) {
    const r = data[i];
    const g = stride >= 3 ? data[i + 1] : r;
    const b = stride >= 3 ? data[i + 2] : r;

    rSum += r;
    gSum += g;
    bSum += b;

    // Rec.709 luma
    const luma = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    lumaHist[luma > 255 ? 255 : luma]++;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;
    chromaSum += chroma;
    satSum += max === 0 ? 0 : chroma / max;
  }

  // luma mean + std
  let lumaSum = 0;
  for (let v = 0; v < 256; v++) lumaSum += v * lumaHist[v];
  const lumaMean = lumaSum / pixelCount;
  let varSum = 0;
  for (let v = 0; v < 256; v++) {
    const d = v - lumaMean;
    varSum += d * d * lumaHist[v];
  }
  const lumaStd = Math.sqrt(varSum / pixelCount);

  const blackPoint = percentile(lumaHist, pixelCount, 0.01);
  const whitePoint = percentile(lumaHist, pixelCount, 0.99);
  const median = percentile(lumaHist, pixelCount, 0.5);

  let clippedLow = 0;
  let clippedHigh = 0;
  for (let v = 0; v <= 2; v++) clippedLow += lumaHist[v];
  for (let v = 253; v <= 255; v++) clippedHigh += lumaHist[v];

  const rMean = rSum / pixelCount;
  const gMean = gSum / pixelCount;
  const bMean = bSum / pixelCount;
  const meanSaturation = satSum / pixelCount;
  const meanChroma = chromaSum / pixelCount;

  const channelSpread =
    Math.max(rMean, gMean, bMean) - Math.min(rMean, gMean, bMean);
  let castHint = "neutral";
  if (channelSpread > TH.colorCast) {
    const top = Math.max(rMean, gMean, bMean);
    castHint =
      top === rMean ? "warm (red-heavy)" : top === bMean ? "cool (blue-heavy)" : "green-heavy";
  }

  const lowContrast = lumaStd < TH.lowContrast;
  const liftedBlacks = blackPoint > TH.liftedBlack;
  const dimHighlights = whitePoint < TH.dimWhite;
  const lowSaturation = meanSaturation < TH.lowSaturation;
  const colorCast = channelSpread > TH.colorCast;
  const washedOut = lowContrast && (liftedBlacks || lowSaturation || dimHighlights);

  const round = (n: number, d = 1) => Number(n.toFixed(d));

  const issues: string[] = [];
  if (lowContrast) issues.push(`low contrast (std ${round(lumaStd)})`);
  if (liftedBlacks) issues.push(`lifted blacks (black point ${blackPoint})`);
  if (dimHighlights) issues.push(`dim highlights (white point ${whitePoint})`);
  if (lowSaturation) issues.push(`low saturation (${round(meanSaturation, 2)})`);
  if (colorCast) issues.push(`${castHint} cast`);
  const verdict = washedOut
    ? `WASHED OUT — ${issues.join(", ")}`
    : issues.length
      ? `OK with notes: ${issues.join(", ")}`
      : "Color looks healthy (good contrast, full range, saturated)";

  return {
    width,
    height,
    luma: {
      mean: round(lumaMean),
      median,
      contrast: round(lumaStd),
      blackPoint,
      whitePoint,
      dynamicRange: whitePoint - blackPoint,
      clippedLowPct: round((clippedLow / pixelCount) * 100, 2),
      clippedHighPct: round((clippedHigh / pixelCount) * 100, 2),
    },
    saturation: {
      meanSaturation: round(meanSaturation, 3),
      meanChroma: round(meanChroma),
    },
    channels: {
      rMean: round(rMean),
      gMean: round(gMean),
      bMean: round(bMean),
      castHint,
    },
    flags: {
      washedOut,
      lowContrast,
      liftedBlacks,
      dimHighlights,
      lowSaturation,
      colorCast,
    },
    verdict,
  };
}

// Render a compact overlaid R/G/B/luma histogram PNG for visual confirmation.
async function renderHistogram(raw: RawPixels): Promise<{ data: string; mimeType: string }> {
  const { data, channels } = raw;
  const stride = channels;
  const W = 256;
  const H = 200;
  const rHist = new Float64Array(256);
  const gHist = new Float64Array(256);
  const bHist = new Float64Array(256);
  const lHist = new Float64Array(256);
  for (let i = 0; i < data.length; i += stride) {
    const r = data[i];
    const g = stride >= 3 ? data[i + 1] : r;
    const b = stride >= 3 ? data[i + 2] : r;
    rHist[r]++;
    gHist[g]++;
    bHist[b]++;
    const luma = Math.min(255, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b));
    lHist[luma]++;
  }
  const maxBin = Math.max(
    1,
    ...rHist,
    ...gHist,
    ...bHist,
    ...lHist,
  );
  const buf = Buffer.alloc(W * H * 3);
  // dark background
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = 18;
    buf[i + 1] = 18;
    buf[i + 2] = 26;
  }
  const draw = (hist: Float64Array, cr: number, cg: number, cb: number) => {
    for (let x = 0; x < W; x++) {
      const h = Math.round((hist[x] / maxBin) * (H - 1));
      for (let y = H - 1; y >= H - h; y--) {
        const idx = (y * W + x) * 3;
        // max-blend so overlaid curves stay visible
        buf[idx] = Math.max(buf[idx], cr);
        buf[idx + 1] = Math.max(buf[idx + 1], cg);
        buf[idx + 2] = Math.max(buf[idx + 2], cb);
      }
    }
  };
  draw(lHist, 120, 120, 130); // luma (gray, drawn first/behind)
  draw(rHist, 220, 60, 60);
  draw(gHist, 60, 200, 80);
  draw(bHist, 80, 130, 240);
  const sharp = await requireSharp("Colour analysis");
  const png = await sharp(buf, { raw: { width: W, height: H, channels: 3 } })
    .png()
    .toBuffer();
  return { data: png.toString("base64"), mimeType: "image/png" };
}

function deltaReport(target: ColorStats, ref: ColorStats): string {
  const d = (a: number, b: number) => {
    const v = Number((a - b).toFixed(1));
    return v > 0 ? `+${v}` : `${v}`;
  };
  return [
    "Shot-match delta (target − reference):",
    `  contrast ${d(target.luma.contrast, ref.luma.contrast)} | ` +
      `black point ${d(target.luma.blackPoint, ref.luma.blackPoint)} | ` +
      `white point ${d(target.luma.whitePoint, ref.luma.whitePoint)}`,
    `  saturation ${d(target.saturation.meanSaturation, ref.saturation.meanSaturation)} | ` +
      `R ${d(target.channels.rMean, ref.channels.rMean)} ` +
      `G ${d(target.channels.gMean, ref.channels.gMean)} ` +
      `B ${d(target.channels.bMean, ref.channels.bMean)}`,
  ].join("\n");
}

export async function analyzeColor(opts: AnalyzeColorOptions): Promise<AnalyzeColorResult> {
  const raw = await toRaw(await resolveBytes(opts));
  const stats = computeStats(raw);

  const content: AnalyzeColorResult["content"] = [];
  // This header used to be the TOOL's name, which 0.50.0 slice 15 retired. It is
  // a label on a SUCCESS response, not remedy guidance, so it does not want to be
  // a call form (`get_image (action:"analyze_color") — 1024x1024` reads as an
  // instruction where none is wanted). It says what the block is instead — the
  // same information the tool name carried, minus a name that would 404. Every
  // other field of the response is unchanged.
  let summary = `Color analysis — ${stats.width}x${stats.height}\n${stats.verdict}\n\n` +
    JSON.stringify(stats, null, 2);

  if (opts.reference_path) {
    const refRaw = await toRaw(await readFile(await resolveSafePath(opts.reference_path)));
    const refStats = computeStats(refRaw);
    summary += `\n\n${deltaReport(stats, refStats)}`;
  }

  content.push({ type: "text", text: summary });

  if (opts.histogram) {
    const hist = await renderHistogram(raw);
    content.push({ type: "image", data: hist.data, mimeType: hist.mimeType });
  }

  return { content };
}
