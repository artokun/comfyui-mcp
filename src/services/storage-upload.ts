import { realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { config } from "../config.js";
import { AssetRegistry } from "./asset-registry.js";
import { getOutputImage } from "./image-management.js";
import {
  uploadToStorage,
  type UploadDestination,
  type StorageUploadResult,
  type StorageUploadSource,
} from "./storage/index.js";
import { ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { redactUrlForLogs } from "./download-auth.js";

export interface UploadOutputOptions {
  asset_id?: string;
  path?: string;
  destination: UploadDestination;
}

export interface UploadOutputResult {
  source: {
    filename: string;
    path?: string;
    asset_id?: string;
    mime_type?: string;
    bytes?: number;
  };
  uploads: StorageUploadResult[];
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
};

function getOutputDir(): string {
  if (!config.comfyuiPath) {
    throw new ValidationError(
      "COMFYUI_PATH is not configured. Set the COMFYUI_PATH environment variable.",
    );
  }
  return resolve(config.comfyuiPath, "output");
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertInsideOutput(root: string, candidate: string, label: string): void {
  if (!isInsideOrEqual(root, candidate) || candidate === root) {
    throw new ValidationError(`${label} must stay within the ComfyUI output directory.`);
  }
}

function resolveOutputPath(path: string): string {
  if (path.trim().length === 0) {
    throw new ValidationError("path must be a non-empty path.");
  }
  const outputDir = getOutputDir();
  const resolved = isAbsolute(path) ? resolve(path) : resolve(outputDir, path);
  if (resolved === outputDir || !resolved.startsWith(outputDir + sep)) {
    throw new ValidationError("path must stay within the ComfyUI output directory.");
  }
  return resolved;
}

function inferMimeType(filename: string): string {
  return MIME_BY_EXTENSION[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

async function sourceFromPath(path: string): Promise<StorageUploadSource & { bytes: number }> {
  const lexicalPath = resolveOutputPath(path);
  const root = await realpath(getOutputDir());
  // unknown-ok: the caller REFUSES on undefined (the throw immediately below), so a
  // failed observation and a genuine absence both fail closed. The only cost is that
  // the message says "not found" for e.g. a permission error — noted, not dangerous,
  // because nothing proceeds on the unknown.
  const sourcePath = await realpath(lexicalPath).catch(() => undefined);
  if (!sourcePath) {
    throw new ValidationError(`Upload source not found: ${lexicalPath}`);
  }
  assertInsideOutput(root, sourcePath, "path");

  // unknown-ok: undefined fails the isFile() test below and refuses, same as a
  // genuine non-file. A path realpath just resolved that cannot then be stat-ed is
  // not usable either way.
  const info = await stat(sourcePath).catch(() => undefined);
  if (!info?.isFile()) {
    throw new ValidationError(`Upload source not found: ${sourcePath}`);
  }

  const filename = basename(sourcePath);
  return {
    path: sourcePath,
    filename,
    contentType: inferMimeType(filename),
    bytes: info.size,
  };
}

async function sourceFromAsset(assetId: string): Promise<StorageUploadSource & { bytes: number }> {
  const record = AssetRegistry.get(assetId);
  if (!record) {
    throw new ValidationError(
      `No asset found for id "${assetId}". It may have expired or never been registered.`,
    );
  }
  const validType = record.type === "output" || record.type === "input" || record.type === "temp";
  const fetchType: "output" | "input" | "temp" = validType
    ? (record.type as "output" | "input" | "temp")
    : "output";
  const image = await getOutputImage(record.filename, fetchType, record.subfolder);
  const data = Buffer.from(image.base64, "base64");
  return {
    data,
    filename: image.filename,
    contentType: image.mimeType,
    bytes: data.length,
  };
}

function redactDestinationForLogs(destination: UploadDestination): unknown {
  if ("http" in destination) return { http: { url: redactUrlForLogs(destination.http.url) } };
  return destination;
}

export async function uploadOutput(opts: UploadOutputOptions): Promise<UploadOutputResult> {
  if (Boolean(opts.asset_id) === Boolean(opts.path)) {
    throw new ValidationError("Provide exactly one upload source: asset_id or path.");
  }

  const source = opts.asset_id
    ? await sourceFromAsset(opts.asset_id)
    : await sourceFromPath(opts.path!);

  logger.info("Uploading ComfyUI output to cloud storage", {
    source: source.path ?? `asset:${opts.asset_id}`,
    destination: redactDestinationForLogs(opts.destination),
  });

  const upload = await uploadToStorage(source, opts.destination);
  return {
    source: {
      filename: source.filename,
      path: source.path,
      asset_id: opts.asset_id,
      mime_type: source.contentType,
      bytes: source.bytes,
    },
    uploads: [upload],
  };
}
