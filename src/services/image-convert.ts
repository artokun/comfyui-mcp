import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import { AssetRegistry } from "./asset-registry.js";
import { getOutputImage } from "./image-management.js";
import { resolveOutputDir } from "./output-dir.js";
import { ValidationError } from "../utils/errors.js";

export type ConvertImageFormat = "png" | "jpeg" | "webp";

export interface ConvertImageOptions {
  asset_id?: string;
  path?: string;
  format: ConvertImageFormat;
  quality?: number;
  progressive?: boolean;
  lossless?: boolean;
  effort?: number;
  out_path?: string;
}

export interface ConvertImageResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  format: ConvertImageFormat;
  mimeType: string;
  sourceBytes: number;
  outputBytes: number;
  bytesSaved: number;
  outPath?: string;
}

interface SourceImage {
  label: string;
  bytes: Buffer;
}

const MIME_BY_FORMAT: Record<ConvertImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

const SUPPORTED_SOURCE_MIME = /^image\/(png|jpe?g|webp)$/i;
const DEFAULT_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const DEFAULT_LIMIT_INPUT_PIXELS = 100_000_000;

// Resolve ComfyUI's REAL output directory (honors --output-directory /
// --base-directory redirects via /system_stats), falling back to
// <COMFYUI_PATH>/output. Async because it may query the running ComfyUI.
async function getOutputDir(): Promise<string> {
  return resolveOutputDir();
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function maxSourceBytes(): number {
  return parsePositiveIntEnv(
    "COMFYUI_CONVERT_IMAGE_MAX_SOURCE_BYTES",
    DEFAULT_MAX_SOURCE_BYTES,
  );
}

function limitInputPixels(): number {
  return parsePositiveIntEnv(
    "COMFYUI_CONVERT_IMAGE_LIMIT_INPUT_PIXELS",
    DEFAULT_LIMIT_INPUT_PIXELS,
  );
}

async function resolveOutputPath(path: string, label: string): Promise<string> {
  if (path.trim().length === 0) {
    throw new ValidationError(`${label} must be a non-empty path.`);
  }

  const outputDir = await getOutputDir();
  const resolved = isAbsolute(path) ? resolve(path) : resolve(outputDir, path);
  if (resolved === outputDir || !resolved.startsWith(outputDir + sep)) {
    throw new ValidationError(`${label} must stay within the ComfyUI output directory.`);
  }
  return resolved;
}

async function realOutputRoot(): Promise<string> {
  return realpath(await getOutputDir());
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertInsideRealOutputDir(
  root: string,
  candidate: string,
  label: string,
  opts: { allowRoot?: boolean } = {},
): void {
  if (!isInsideOrEqual(root, candidate) || (!opts.allowRoot && candidate === root)) {
    throw new ValidationError(`${label} must stay within the ComfyUI output directory.`);
  }
}

async function validateExistingOutputAncestors(
  root: string,
  parent: string,
  label: string,
): Promise<void> {
  const outputDir = await getOutputDir();
  let cursor = parent;
  while (cursor !== outputDir && cursor.startsWith(outputDir + sep)) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        const realCursor = await realpath(cursor);
        assertInsideRealOutputDir(root, realCursor, label, { allowRoot: true });
      } else if (!info.isDirectory()) {
        throw new ValidationError(`${label} parent is not a directory: ${cursor}`);
      }
      return;
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      cursor = dirname(cursor);
    }
  }
}

async function resolveSourcePath(path: string): Promise<{ path: string; size: number }> {
  const lexicalPath = await resolveOutputPath(path, "path");
  const root = await realOutputRoot();
  const sourcePath = await realpath(lexicalPath).catch(() => undefined);
  if (!sourcePath) {
    throw new ValidationError(`Source image not found: ${lexicalPath}`);
  }
  assertInsideRealOutputDir(root, sourcePath, "path");

  const info = await stat(sourcePath).catch(() => undefined);
  if (!info?.isFile()) {
    throw new ValidationError(`Source image not found: ${sourcePath}`);
  }
  const maxBytes = maxSourceBytes();
  if (info.size > maxBytes) {
    throw new ValidationError(
      `Source image is too large (${info.size} bytes). Maximum is ${maxBytes} bytes.`,
    );
  }
  return { path: sourcePath, size: info.size };
}

async function resolveWritableOutputPath(path: string): Promise<string> {
  const targetPath = await resolveOutputPath(path, "out_path");
  const root = await realOutputRoot();
  const parent = dirname(targetPath);
  await validateExistingOutputAncestors(root, parent, "out_path");
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  assertInsideRealOutputDir(root, realParent, "out_path", { allowRoot: true });

  try {
    const info = await lstat(targetPath);
    if (info.isSymbolicLink()) {
      const realTarget = await realpath(targetPath);
      assertInsideRealOutputDir(root, realTarget, "out_path");
    }
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    // Missing target is fine; writeFile will create it.
  }
  return targetPath;
}

async function resolveSource(opts: ConvertImageOptions): Promise<SourceImage> {
  if (opts.asset_id) {
    const record = AssetRegistry.get(opts.asset_id);
    if (!record) {
      throw new ValidationError(
        `No asset found for id "${opts.asset_id}". It may have expired or never been registered.`,
      );
    }

    const validType = record.type === "output" || record.type === "input" || record.type === "temp";
    const fetchType: "output" | "input" | "temp" = validType
      ? (record.type as "output" | "input" | "temp")
      : "output";
    const image = await getOutputImage(record.filename, fetchType, record.subfolder);
    if (!SUPPORTED_SOURCE_MIME.test(image.mimeType)) {
      throw new ValidationError(
        `Asset "${opts.asset_id}" is not a supported image (mime: ${image.mimeType}).`,
      );
    }
    return {
      label: `asset ${opts.asset_id} (${record.filename})`,
      bytes: Buffer.from(image.base64, "base64"),
    };
  }

  if (!opts.path) {
    throw new ValidationError("convert_image requires either asset_id or path.");
  }

  const source = await resolveSourcePath(opts.path);
  return {
    label: source.path,
    bytes: await readFile(source.path),
  };
}

function buildEncoder(
  input: Buffer,
  opts: ConvertImageOptions,
): ReturnType<typeof sharp> {
  const image = sharp(input, { limitInputPixels: limitInputPixels() });
  if (opts.format === "png") {
    return image.png({ quality: opts.quality });
  }
  if (opts.format === "jpeg") {
    return image.jpeg({
      quality: opts.quality,
      progressive: opts.progressive,
    });
  }
  return image.webp({
    quality: opts.quality,
    lossless: opts.lossless,
    effort: opts.effort,
  });
}

function validateEncodeOptions(opts: ConvertImageOptions): void {
  if (
    opts.quality !== undefined &&
    (!Number.isInteger(opts.quality) || opts.quality < 1 || opts.quality > 100)
  ) {
    throw new ValidationError("quality must be an integer between 1 and 100.");
  }
  if (
    opts.effort !== undefined &&
    (!Number.isInteger(opts.effort) || opts.effort < 0 || opts.effort > 6)
  ) {
    throw new ValidationError("effort must be an integer between 0 and 6.");
  }
}

export async function convertImage(
  opts: ConvertImageOptions,
): Promise<ConvertImageResult> {
  if (Boolean(opts.asset_id) === Boolean(opts.path)) {
    throw new ValidationError("Provide exactly one image source: asset_id or path.");
  }
  validateEncodeOptions(opts);

  const source = await resolveSource(opts);
  const converted = await buildEncoder(source.bytes, opts).toBuffer();
  const mimeType = MIME_BY_FORMAT[opts.format];
  const outPath = opts.out_path
    ? await resolveWritableOutputPath(opts.out_path)
    : undefined;

  if (outPath) {
    await writeFile(outPath, converted);
  }

  const sourceBytes = source.bytes.length;
  const outputBytes = converted.length;
  const bytesSaved = sourceBytes - outputBytes;
  const summary = {
    source: source.label,
    format: opts.format,
    mime_type: mimeType,
    source_bytes: sourceBytes,
    output_bytes: outputBytes,
    bytes_saved: bytesSaved,
    out_path: outPath,
  };

  return {
    content: [
      { type: "text", text: JSON.stringify(summary, null, 2) },
      {
        type: "image",
        data: converted.toString("base64"),
        mimeType,
      },
    ],
    format: opts.format,
    mimeType,
    sourceBytes,
    outputBytes,
    bytesSaved,
    outPath,
  };
}
