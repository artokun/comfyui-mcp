import { createHash } from "node:crypto";
import { readdir, stat, mkdir } from "node:fs/promises";
import { join, basename, resolve, sep, isAbsolute } from "node:path";
import { config } from "../config.js";
import { getClient } from "../comfyui/client.js";
import { ModelError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { downloadWithCache } from "./download-cache.js";
import { reportDownloadProgress } from "./download-progress.js";
import {
  applyDownloadAuth,
  redactUrlForLogs,
  type DownloadAuth,
} from "./download-auth.js";

export const MODEL_SUBDIRS = [
  "checkpoints",
  "loras",
  "vae",
  "upscale_models",
  "controlnet",
  "embeddings",
  "clip",
  "diffusers",
  "diffusion_models",
  "gligen",
  "hypernetworks",
  "photomaker",
  "style_models",
  "text_encoders",
  "unet",
] as const;

export type ModelType = (typeof MODEL_SUBDIRS)[number];

export interface HFModelResult {
  id: string;
  modelId: string;
  author: string;
  tags: string[];
  downloads: number;
  likes: number;
  lastModified: string;
}

export interface LocalModel {
  name: string;
  path: string;
  size: number;
  modified: string;
  type: string;
}

function getModelsRoot(): string {
  if (!config.comfyuiPath) {
    throw new ModelError("COMFYUI_PATH is not configured. Set the COMFYUI_PATH environment variable.");
  }
  return join(config.comfyuiPath, "models");
}

export async function searchHuggingFaceModels(
  query: string,
  options: { filter?: string; limit?: number } = {},
): Promise<HFModelResult[]> {
  const { filter, limit = 10 } = options;
  const params = new URLSearchParams({
    search: query,
    limit: String(limit),
  });
  if (filter) params.set("filter", filter);

  const headers: Record<string, string> = {};
  if (config.huggingfaceToken) {
    headers["Authorization"] = `Bearer ${config.huggingfaceToken}`;
  }

  const url = `https://huggingface.co/api/models?${params}`;
  logger.debug("HuggingFace API request", { url });

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ModelError(
      `HuggingFace API ${res.status}: ${res.statusText}`,
      { url, status: res.status, body },
    );
  }

  const data = (await res.json()) as Array<Record<string, unknown>>;

  return data.map((m) => ({
    id: String(m.id ?? m._id ?? ""),
    modelId: String(m.modelId ?? m.id ?? ""),
    author: String(m.author ?? ""),
    tags: Array.isArray(m.tags) ? m.tags.map(String) : [],
    downloads: Number(m.downloads ?? 0),
    likes: Number(m.likes ?? 0),
    lastModified: String(m.lastModified ?? ""),
  }));
}

export async function listLocalModels(
  modelType?: string,
): Promise<LocalModel[]> {
  const dirsToScan: string[] = modelType ? [modelType] : [...MODEL_SUBDIRS];
  const results: LocalModel[] = [];

  // Path 1 — HTTP REST. ComfyUI's `/models/<dir>` endpoint reports what is
  // actually available to workflows, including symlinked / mounted dirs from
  // `extra_model_paths.yaml`. Pure filesystem scans of the install dir miss
  // those, and they fail entirely in remote/cloud mode where comfyuiPath is
  // undefined. Originally contributed by João Lucas (github.com/joaolvivas) in
  // joaolvivas/comfyui-mcp-byjlucas@e2ae39c8 (2026-05-12).
  let httpReturnedAny = false;
  try {
    const client = getClient(); // throws CLOUD_UNSUPPORTED in cloud mode
    for (const dir of dirsToScan) {
      try {
        const res = await client.fetchApi(`/models/${dir}`);
        if (!res.ok) continue;
        const files = (await res.json()) as unknown;
        if (!Array.isArray(files)) continue;
        for (const name of files) {
          if (typeof name !== "string") continue;
          httpReturnedAny = true;
          results.push({
            name,
            path: `${dir}/${name}`, // ComfyUI-relative; absolute path unknown via REST
            size: 0,
            modified: "",
            type: dir,
          });
        }
      } catch (err) {
        logger.debug(`HTTP /models/${dir} failed, continuing`, { err });
      }
    }
    if (httpReturnedAny) return results;
  } catch (err) {
    logger.debug("HTTP model listing unavailable, trying filesystem", { err });
  }

  // Path 2 — filesystem fallback. Only useful in pure local mode without
  // extra_model_paths.yaml. Return empty (don't throw) when there's no local
  // path: that's the correct answer for remote/cloud setups where ComfyUI
  // simply didn't return anything over HTTP.
  if (!config.comfyuiPath) return results;
  const modelsRoot = join(config.comfyuiPath, "models");
  for (const dir of dirsToScan) {
    const dirPath = join(modelsRoot, dir);
    let entries: string[];
    try {
      entries = await readdir(dirPath, { recursive: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const filePath = join(dirPath, entry);
      try {
        const info = await stat(filePath);
        if (!info.isFile()) continue;
        results.push({
          name: entry,
          path: filePath,
          size: info.size,
          modified: info.mtime.toISOString(),
          type: dir,
        });
      } catch {
        // Skip files we can't stat
      }
    }
  }

  return results;
}

/** True when `url`'s host is civitai.com (or a subdomain), parsed safely. */
function isCivitaiUrl(url: string): boolean {
  try {
    const host = new URL(url).host.toLowerCase();
    return host === "civitai.com" || host.endsWith(".civitai.com");
  } catch {
    return false;
  }
}

/**
 * Validate a target subfolder under models/ and resolve it to an absolute dir
 * that is guaranteed to stay INSIDE models/. Accepts a known MODEL_SUBDIRS name
 * OR an arbitrary (possibly nested, e.g. "loras/pusa") relative subfolder, while
 * rejecting absolute paths and traversal escapes. Exported so callers can resolve
 * an arbitrary target without duplicating the guard.
 */
export function resolveModelSubfolder(targetSubfolder: string): string {
  const raw = (targetSubfolder ?? "").trim();
  if (!raw) {
    throw new ModelError("target_subfolder is required (e.g. 'loras', 'checkpoints').");
  }
  if (isAbsolute(raw)) {
    throw new ModelError(
      `target_subfolder must be relative to models/, not absolute: ${raw}`,
    );
  }
  const modelsRoot = resolve(getModelsRoot());
  const targetDir = resolve(modelsRoot, raw);
  // Confirm the resolved dir stays strictly inside models/ (blocks ".." escapes).
  if (targetDir !== modelsRoot && !targetDir.startsWith(modelsRoot + sep)) {
    throw new ModelError(
      `Refusing to write outside the models directory: ${raw}`,
    );
  }
  return targetDir;
}

export async function downloadModel(
  url: string,
  targetSubfolder: string,
  filename?: string,
  auth?: DownloadAuth,
): Promise<string> {
  const targetDir = resolveModelSubfolder(targetSubfolder);

  // Ensure target directory exists
  await mkdir(targetDir, { recursive: true });

  const rawFilename =
    filename ?? (basename(new URL(url).pathname) || "model.safetensors");
  // Guard against path traversal: the filename must be a bare basename so it
  // cannot escape targetDir via separators or "..".
  const resolvedFilename = basename(rawFilename);
  if (
    resolvedFilename !== rawFilename ||
    resolvedFilename === "" ||
    resolvedFilename === "." ||
    resolvedFilename === ".."
  ) {
    throw new ModelError(
      "Invalid model filename: must be a plain filename without path separators or '..'.",
      { filename: rawFilename },
    );
  }
  const targetPath = join(targetDir, resolvedFilename);
  // Defense-in-depth: confirm the resolved path stays inside targetDir.
  if (!resolve(targetPath).startsWith(resolve(targetDir) + sep)) {
    throw new ModelError(
      "Refusing to write outside the target model directory.",
      { filename: rawFilename },
    );
  }

  const request = applyDownloadAuth(url, auth);
  const headers: Record<string, string> = { ...request.headers };
  if (!auth && config.huggingfaceToken && url.includes("huggingface.co")) {
    headers["Authorization"] = `Bearer ${config.huggingfaceToken}`;
  } else if (!auth && config.civitaiApiToken && isCivitaiUrl(url)) {
    // CivitAI auth travels as a request header (never in the URL/query) so the
    // token can't leak into logs, errors, or redirect URLs. fetch drops the
    // header on the cross-origin redirect to the already-signed download host.
    headers["Authorization"] = `Bearer ${config.civitaiApiToken}`;
  }

  const sensitiveParams =
    auth?.type === "query" ? [auth.query_param] : undefined;
  const logUrl = redactUrlForLogs(request.url, sensitiveParams);
  logger.info(`Downloading model to ${targetPath}`, { url: logUrl });

  // Stable id for the panel tray, keyed on the (pre-redirect) URL so resumes and
  // retries map to the same row. Name is the friendly file name.
  const progressId = createHash("sha256").update(request.url).digest("hex").slice(0, 16);
  const progress = { id: progressId, name: resolvedFilename };

  try {
    await downloadWithCache({
      url: request.url,
      headers,
      targetPath,
      logUrl,
      storageAuth: auth?.type === "s3" ? { s3: auth } : undefined,
      progress,
    });
  } catch (err) {
    // Surface a failed row in the tray, then rethrow for the tool to report.
    reportDownloadProgress({ ...progress, downloaded: 0, total: 0, bytes_per_sec: 0, status: "error" }, true);
    throw err;
  }

  const info = await stat(targetPath);
  logger.info(`Download complete: ${resolvedFilename} (${(info.size / 1024 / 1024).toFixed(1)} MB)`);
  // Ensure a terminal "done" row even on a cache hit (no streaming happened).
  reportDownloadProgress(
    { ...progress, downloaded: info.size, total: info.size, bytes_per_sec: 0, status: "done" },
    true,
  );

  return targetPath;
}
