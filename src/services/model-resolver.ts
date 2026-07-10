import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { readdir, stat, mkdir } from "node:fs/promises";
import { join, basename, resolve, relative, sep, isAbsolute } from "node:path";
import { config, isRemoteMode } from "../config.js";
import { getClient } from "../comfyui/client.js";
import { getExtraModelRoots } from "./extra-paths.js";
import { getSavedDefaultWorkspaceSync } from "./workspace-env.js";
import { installModelViaManager } from "./node-management.js";
import { ModelError, ValidationError } from "../utils/errors.js";
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

/**
 * Map our internal model category (a MODEL_SUBDIRS value, i.e. the literal
 * ComfyUI models/ folder name) to a key that ComfyUI-Manager's
 * `model_dir_name_map` understands. When an install-model task is sent with
 * `save_path: "default"`, Manager resolves the destination folder by looking
 * `type` up in this map; an unmapped value resolves to None and the install is
 * a SILENT no-op (the model never lands). So every category we route to Manager
 * with a default save_path must map to a real key here. Categories with NO
 * Manager key (diffusers, hypernetworks, photomaker, style_models) are handled
 * by sending an explicit save_path (the folder name) instead — see
 * managerModelDestination().
 */
const MANAGER_MODEL_TYPE_MAP: Record<string, string> = {
  checkpoints: "checkpoints",
  loras: "lora",
  vae: "vae",
  upscale_models: "upscale",
  controlnet: "controlnet",
  embeddings: "embeddings",
  clip: "clip",
  diffusion_models: "diffusion_model",
  gligen: "gligen",
  text_encoders: "text_encoders",
  unet: "unet",
};

/**
 * Resolve the ComfyUI-Manager install-model { type, save_path } pair for a
 * target model directory. `category` is our internal model folder (a
 * MODEL_SUBDIRS value, or the first path segment of a target subfolder).
 * `relPath` is the full relative path under models/ when a NESTED destination
 * is wanted (e.g. "loras/pusa"); omit/equal-to-category for a top-level folder.
 *
 * Contract (verified against ComfyUI-Manager 4.2.2 do_install_model):
 *   - `save_path` is ALWAYS sent. Manager's get_model_dir does
 *     `if data["save_path"] != "default": <use save_path verbatim>` else it
 *     resolves the folder from `type` via model_dir_name_map. A missing/None
 *     save_path makes get_model_dir bail (→ None) and nothing installs.
 *   - For a nested target we send the explicit relPath (Manager writes there
 *     verbatim, so the type-map is bypassed).
 *   - For a top-level category that HAS a Manager type-map key we send
 *     "default" and the mapped type.
 *   - For a top-level category with NO Manager key we send the category folder
 *     as save_path so Manager writes into models/<category> directly.
 */
export function managerModelDestination(
  category: string,
  relPath?: string,
): { type: string; save_path: string } {
  const type = MANAGER_MODEL_TYPE_MAP[category] ?? category;
  if (relPath && relPath !== category) {
    return { type, save_path: relPath };
  }
  if (MANAGER_MODEL_TYPE_MAP[category]) {
    return { type, save_path: "default" };
  }
  return { type, save_path: category };
}

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

/**
 * Resolve the local ComfyUI base directory for filesystem operations. Prefers
 * COMFYUI_PATH / auto-detection (config.comfyuiPath); when that's unset and we're
 * NOT targeting a remote ComfyUI, falls back to the saved default workspace (set
 * via set_default_workspace) so local downloads and model lookups work without
 * COMFYUI_PATH — matching what get_environment / get_workspace already report.
 * Never falls back to a local workspace in remote mode (that dir isn't the remote
 * target). Returns undefined when no usable local path exists.
 */
function resolveComfyUIBase(): string | undefined {
  if (config.comfyuiPath) return config.comfyuiPath;
  if (isRemoteMode()) return undefined;
  return getSavedDefaultWorkspaceSync();
}

function getModelsRoot(): string {
  const base = resolveComfyUIBase();
  if (!base) {
    throw new ModelError(
      "No local ComfyUI path configured. Set the COMFYUI_PATH environment variable, " +
        "or save a default workspace with set_default_workspace.",
    );
  }
  return join(base, "models");
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

  const url = applyHfEndpoint(`https://huggingface.co/api/models?${params}`);
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

/** Network-restricted regions (issue #127): honor the de-facto HF_ENDPOINT
 *  mirror var (e.g. https://hf-mirror.com) by rewriting huggingface.co URLs at
 *  the API/download boundary. Only http(s) endpoints are accepted; anything
 *  else leaves the URL untouched. Adapted from 1696762169/comfyui-mcp 6a2bd96. */
export function applyHfEndpoint(url: string): string {
  const ep = process.env.HF_ENDPOINT?.trim().replace(/\/+$/, "");
  if (!ep || !/^https?:\/\//i.test(ep)) return url;
  return url.replace(/^https?:\/\/huggingface\.co(?=[/?#]|$)/i, ep);
}

/** Issue #127: CIVITAI_ENABLED=0 disables Civitai access cleanly — tools fail
 *  fast with a clear message instead of hanging against an unreachable host
 *  (Civitai is blocked in some regions). Adapted from 1696762169/comfyui-mcp
 *  a6441c0. */
export function civitaiDisabled(): boolean {
  const v = (process.env.CIVITAI_ENABLED ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "no";
}

export const CIVITAI_DISABLED_MESSAGE =
  "Civitai access is disabled by config (CIVITAI_ENABLED=0) — common on networks where civitai.com is unreachable. " +
  "Unset CIVITAI_ENABLED to re-enable, or download the file elsewhere and pass a direct URL to download_model.";

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

/**
 * Resolve a relative-to-models path against a known root, keeping the result
 * strictly INSIDE that root. Rejects absolute inputs, "" / "." (the root
 * itself), and ".." traversal escapes. Shared by the primary and extra-root
 * lookups so every candidate gets the same containment guarantee.
 */
function containWithinRoot(rootDir: string, relativePath: string): string {
  const root = resolve(rootDir);
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new ValidationError(
      `Refusing to operate outside the models directory: ${relativePath}`,
    );
  }
  // Defense-in-depth: the resolved path must be a descendant of the root and
  // not merely share its string prefix (e.g. "models-evil" vs "models").
  if (target !== root && !target.startsWith(root + sep)) {
    throw new ValidationError(
      `Refusing to operate outside the models directory: ${relativePath}`,
    );
  }
  return target;
}

export interface ResolvedModelFile {
  /** Absolute path to the existing entry on disk. */
  path: string;
  /** The root directory it was found under (primary models/ or an extra root). */
  root: string;
  /** fs.Stats for the entry, so callers don't need to re-stat. */
  info: Stats;
}

/**
 * Locate an existing model file given a path relative to ComfyUI's models/
 * directory, searching ACROSS every configured root: the primary
 * `<COMFYUI_PATH>/models` AND every directory declared in
 * extra_model_paths.yaml / extra_models_config.yaml (e.g. models stored on
 * another drive such as E:\). This mirrors the set of roots ComfyUI itself
 * loads from, so a model installed under an extra root can be found (and
 * removed) the same way as one under the primary install.
 *
 * Resolution rules:
 *  - The primary root is searched with the full relative path.
 *  - Extra roots are per-category (the first path segment, e.g. "checkpoints"),
 *    so the remainder of the path is resolved within each matching root.
 *  - Every candidate is containment-checked against its own root; absolute
 *    paths and ".." traversal are rejected (security guard preserved).
 *  - A matching FILE wins; if only a directory matches it is returned so the
 *    caller can surface a precise "not a file" error.
 *
 * Throws ValidationError for absolute/traversal inputs and ModelError when the
 * entry is not found in any root (the message lists the roots searched).
 */
export async function resolveExistingModelFile(
  relativePath: string,
): Promise<ResolvedModelFile> {
  if (!resolveComfyUIBase()) {
    throw new ModelError(
      "No local ComfyUI path configured. Locating/removing a local model operates on " +
        "the local filesystem and is unavailable when targeting a remote ComfyUI. " +
        "Set the COMFYUI_PATH environment variable, or save a default workspace with " +
        "set_default_workspace.",
    );
  }
  const raw = (relativePath ?? "").trim();
  if (!raw) {
    throw new ValidationError("Model path is required.");
  }
  // Reject absolute paths cross-platform: posix-absolute (isAbsolute), a Windows
  // drive-letter root (E:\ / E:/), or a UNC path (\\server\share). isAbsolute()
  // alone is host-OS-dependent — it wouldn't flag "E:/…" on Linux/macOS — but this
  // guard must hold regardless of where the orchestrator runs (the host may be
  // Windows, where E:\ is a real model drive a caller could try to escape to).
  if (isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
    throw new ValidationError(
      `Path must be relative to the models directory, not absolute: ${relativePath}`,
    );
  }

  const searched: string[] = [];
  let dirHit: ResolvedModelFile | undefined;

  // Primary root: <COMFYUI_PATH>/models/<relativePath>. containWithinRoot throws
  // on traversal/escape, preserving the existing security behavior.
  const modelsRoot = resolve(getModelsRoot());
  const primaryTarget = containWithinRoot(modelsRoot, raw);
  searched.push(modelsRoot);
  try {
    const info = await stat(primaryTarget);
    if (info.isFile()) return { path: primaryTarget, root: modelsRoot, info };
    dirHit = { path: primaryTarget, root: modelsRoot, info };
  } catch {
    // Not present under the primary root; fall through to extra roots.
  }

  // Extra roots are declared per category, so peel off the first path segment
  // and resolve the remainder within each matching extra directory.
  const segments = raw.split(/[/\\]+/).filter(Boolean);
  const category = segments[0];
  const remainder = segments.slice(1).join("/");
  if (category && remainder) {
    const extraRoots = await getExtraModelRoots();
    for (const er of extraRoots) {
      if (er.category !== category) continue;
      const rootDir = resolve(er.dir);
      let target: string;
      try {
        target = containWithinRoot(rootDir, remainder);
      } catch {
        // A remainder that can't safely resolve within this root is skipped
        // rather than failing the whole lookup.
        continue;
      }
      searched.push(rootDir);
      try {
        const info = await stat(target);
        if (info.isFile()) return { path: target, root: rootDir, info };
        if (!dirHit) dirHit = { path: target, root: rootDir, info };
      } catch {
        // Not present under this extra root; keep searching.
      }
    }
  }

  if (dirHit) return dirHit;

  throw new ModelError(
    `Model file not found: ${relativePath}. Searched ${searched.length} root(s): ` +
      `${searched.join(", ")}`,
    { path: relativePath, searched },
  );
}

/**
 * Remote-mode download: hand the file off to the connected ComfyUI host via
 * ComfyUI-Manager's `install-model` task. Validates the subfolder/filename with
 * the same guards as the local path (no traversal, bare filename) before
 * dispatch, then returns a human-readable descriptor of where it will land.
 */
async function downloadModelViaManagerRemote(
  url: string,
  targetSubfolder: string,
  filename?: string,
  auth?: DownloadAuth,
): Promise<string> {
  const raw = (targetSubfolder ?? "").trim();
  if (!raw) {
    throw new ModelError("target_subfolder is required (e.g. 'loras', 'checkpoints').");
  }
  if (isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
    throw new ModelError(
      `target_subfolder must be relative to models/, not absolute: ${raw}`,
    );
  }
  const segments = raw.split(/[/\\]+/).filter(Boolean);
  if (segments.length === 0 || segments.includes("..")) {
    throw new ModelError(`Invalid target_subfolder: ${raw}`);
  }
  const normalizedSubfolder = segments.join("/");
  const modelType = segments[0];

  const rawFilename =
    filename ?? (basename(new URL(url).pathname) || "model.safetensors");
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

  // Resolve auth for a server-side (Manager) fetch. Manager fetches the URL on
  // the ComfyUI host and cannot receive our per-request HTTP headers, so:
  //   - query auth → fold the param into the URL (works server-side);
  //   - header/basic/bearer → cannot be forwarded; surface a clear warning so we
  //     don't report a clean success for a download that will fail unauthenticated;
  //   - s3 → no URL/header mutation here (Manager can't use our SigV4 creds either).
  let dispatchUrl = url;
  let authWarning = "";
  if (auth?.type === "query") {
    // applyDownloadAuth folds the query_param/query_value into the URL.
    dispatchUrl = applyDownloadAuth(url, auth).url;
  } else if (auth && (auth.type === "header" || auth.type === "basic" || auth.type === "bearer")) {
    authWarning =
      ` WARNING: ${auth.type} auth cannot be forwarded to ComfyUI-Manager's` +
      ` server-side fetch — if this URL requires authentication, the download will` +
      ` fail. Use a query-auth'd/signed URL, or configure the credential (e.g. an` +
      ` HF/CivitAI token) on the ComfyUI host.`;
  } else if (auth?.type === "s3") {
    authWarning =
      ` WARNING: s3 auth cannot be forwarded to ComfyUI-Manager's server-side fetch;` +
      ` if this URL requires S3 credentials, the download will fail.`;
  }

  // Map our category to a Manager-valid { type, save_path }. For a nested
  // target we hand Manager the full relative path; for a top-level category we
  // send "default" (mapped types) or the folder name (unmapped categories) so
  // the model actually lands. See managerModelDestination().
  const { type: managerType, save_path: managerSavePath } = managerModelDestination(
    modelType,
    segments.length > 1 ? normalizedSubfolder : undefined,
  );

  const sensitiveParams = auth?.type === "query" ? [auth.query_param] : undefined;
  logger.info("Dispatching model install to remote ComfyUI via ComfyUI-Manager", {
    url: redactUrlForLogs(dispatchUrl, sensitiveParams),
    type: managerType,
    save_path: managerSavePath,
    filename: resolvedFilename,
  });

  await installModelViaManager({
    // Manager's do_install_model reads json_data['name'] (required, non-empty).
    // We only have the filename to identify the model here, so use it.
    name: resolvedFilename,
    url: dispatchUrl,
    filename: resolvedFilename,
    type: managerType,
    save_path: managerSavePath,
    // Panel tray: watch OUR canonical category for the file to land (#143).
    trayCategory: modelType,
  });

  return `${normalizedSubfolder}/${resolvedFilename} (dispatched to the remote ComfyUI via ComfyUI-Manager — download continues server-side; the file lists under /models when complete)${authWarning}`;
}

export async function downloadModel(
  url: string,
  targetSubfolder: string,
  filename?: string,
  auth?: DownloadAuth,
): Promise<string> {
  // Region flags (issue #127) applied at THE choke point every download path
  // funnels through (local disk AND the remote Manager dispatch below).
  const wasHfUrl = /^https?:\/\/huggingface\.co([/?#]|$)/i.test(url);
  url = applyHfEndpoint(url);
  if (isCivitaiUrl(url) && civitaiDisabled()) {
    throw new ModelError(CIVITAI_DISABLED_MESSAGE);
  }
  // REMOTE mode: the MCP has no local filesystem, so a local-disk download is
  // impossible. Dispatch the download to the connected ComfyUI host through
  // ComfyUI-Manager's `install-model` task instead — it fetches the file
  // server-side into the right models/ subfolder. The CivitAI/HuggingFace URL
  // (and any auth-resolved URL) was already resolved by the caller. Query-style
  // auth is folded into the URL before dispatch (Manager fetches server-side and
  // can carry query params); header/basic/bearer auth can't be forwarded to
  // Manager, so those are surfaced as a clear warning rather than reported as a
  // clean success.
  if (isRemoteMode()) {
    return downloadModelViaManagerRemote(url, targetSubfolder, filename, auth);
  }

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
  // wasHfUrl keeps the token flowing when HF_ENDPOINT rewrote the host to a
  // mirror (mirrors proxy gated repos and accept the same Bearer token).
  if (!auth && config.huggingfaceToken && (wasHfUrl || url.includes("huggingface.co"))) {
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
