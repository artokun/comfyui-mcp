import { isAbsolute, relative, resolve, sep } from "node:path";
import { stat } from "node:fs/promises";
import { listLocalModels, MODEL_SUBDIRS, type LocalModel } from "./model-resolver.js";
import { getSystemStats } from "../comfyui/client.js";
import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Local-model discovery fallback for the comfy_cli tool's models_* actions
// (issue #460). The read-only listing actions (list-folders, list-folder,
// search, show) don't
// actually need the separate comfy-cli executable: the connected ComfyUI
// already exposes what's installed via its /models REST endpoint (with a
// COMFYUI_PATH filesystem scan behind it). This reproduces those actions
// directly through the existing listLocalModels() path so model discovery
// keeps working on a plain local install with no comfy-cli on PATH — mirroring
// the live /object_info fallback for comfy_cli action:"search_nodes" (#354).
// ---------------------------------------------------------------------------

/**
 * comfy-cli's `models search --type` maps its `--type` value to the real ComfyUI
 * model folder before scanning. This mirrors comfy-cli's `_TYPE_TO_FOLDER`
 * (comfy_cli/command/models/search.py) EXACTLY so a `--type` that comfy-cli
 * would resolve is resolved identically here — otherwise a valid fallback search
 * returns a wrong empty result. Values not in the map pass through unchanged.
 */
const TYPE_ALIASES: Record<string, string> = {
  checkpoint: "checkpoints",
  checkpoints: "checkpoints",
  lora: "loras",
  loras: "loras",
  vae: "vae",
  controlnet: "controlnet",
  upscale: "upscale_models",
  upscale_models: "upscale_models",
  clip: "clip",
  clip_vision: "clip_vision",
  unet: "diffusion_models",
  diffusion: "diffusion_models",
  diffusion_models: "diffusion_models",
  style: "style_models",
  style_models: "style_models",
  embeddings: "embeddings",
  hypernetworks: "hypernetworks",
  gligen: "gligen",
};

function resolveModelFolder(type: string): string {
  return TYPE_ALIASES[type.toLowerCase()] ?? type;
}

function posixRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** Drop a leading `models/` so `models/vae/foo.safetensors` matches listing paths. */
function stripModelsPrefix(rel: string): string {
  const n = posixRel(rel);
  return /^models\//i.test(n) ? n.slice("models/".length) : n;
}

function pathBasename(rel: string): string {
  const parts = posixRel(rel).split("/").filter(Boolean);
  return parts.at(-1) ?? rel;
}

function pathDirname(rel: string): string | undefined {
  const parts = posixRel(rel).split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(0, -1).join("/") : undefined;
}

function modelRelPath(model: LocalModel): string {
  if (isAbsolute(model.path)) return posixRel(`${model.type}/${model.name}`);
  return stripModelsPrefix(model.path);
}

/**
 * Folder the caller asked for: explicit `folder`/`type`, else the directory
 * prefix of a relative `name` (e.g. `vae/qwen_image_vae.safetensors`).
 */
function showFolderHint(args: { name: string; folder?: string; type?: string }): string | undefined {
  const fromArg = (args.folder ?? args.type)?.trim();
  if (fromArg) return resolveModelFolder(fromArg);
  const dir = pathDirname(stripModelsPrefix(args.name.trim()));
  if (!dir) return undefined;
  const head = dir.split("/")[0];
  return head ? resolveModelFolder(head) : undefined;
}

function showArgFolderConflictsName(args: { name: string; folder?: string; type?: string }): boolean {
  const fromArg = (args.folder ?? args.type)?.trim();
  const nameDir = pathDirname(stripModelsPrefix(args.name.trim()));
  const nameHead = nameDir?.split("/")[0];
  if (!fromArg || !nameHead) return false;
  return resolveModelFolder(fromArg).toLowerCase() !== resolveModelFolder(nameHead).toLowerCase();
}

/**
 * Exact (case-insensitive) basename matches, optionally narrowed by folder/type
 * or a relative path. Array order is not a selector — #2504's bug was
 * `Array.find` reporting whichever duplicate happened to be listed first.
 */
function showMatches(models: LocalModel[], args: { name: string; folder?: string; type?: string }): LocalModel[] {
  if (showArgFolderConflictsName(args)) return [];
  const needle = stripModelsPrefix(args.name.trim());
  const wantBase = pathBasename(needle).toLowerCase();
  const nameDir = pathDirname(needle);
  const folder = showFolderHint(args);

  return models.filter((m) => {
    if (pathBasename(m.name).toLowerCase() !== wantBase) return false;
    if (folder && m.type.toLowerCase() !== folder.toLowerCase()) return false;
    if (nameDir?.includes("/")) {
      const wantRel = needle.toLowerCase();
      const gotRel = modelRelPath(m).toLowerCase();
      const gotName = posixRel(m.name).toLowerCase();
      if (gotRel !== wantRel && !gotRel.endsWith(`/${wantRel}`) && gotName !== wantRel) return false;
    }
    return true;
  });
}

function pickShowMatch(models: LocalModel[], args: { name: string; folder?: string; type?: string }): LocalModel {
  const hits = showMatches(models, args);
  const only = hits[0];
  if (hits.length === 1 && only) return only;
  if (hits.length === 0) {
    throw new Error(`Model '${args.name}' was not found among the connected ComfyUI's local models.`);
  }
  const listed = [...hits]
    .sort((a, b) => modelRelPath(a).localeCompare(modelRelPath(b)))
    .map((m) => `  ${modelRelPath(m)}`)
    .join("\n");
  throw new Error(
    `Model '${args.name}' matches ${hits.length} local files:\n${listed}\n` +
      "Pass folder, type, or a relative path (e.g. vae/qwen_image_vae.safetensors) to select one.",
  );
}

/** HTTP listings leave size/mtime blank; stat the file when a local path is known. */
async function enrichShowStats(match: LocalModel): Promise<LocalModel> {
  if (match.size > 0 && match.modified) return match;
  let abs: string | undefined;
  if (isAbsolute(match.path)) {
    abs = match.path;
  } else if (config.comfyuiPath) {
    const modelsRoot = resolve(config.comfyuiPath, "models");
    const target = resolve(modelsRoot, match.path);
    const rel = relative(modelsRoot, target);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && target.startsWith(modelsRoot + sep)) {
      abs = target;
    }
  }
  if (!abs) return match;
  try {
    const info = await stat(abs);
    if (!info.isFile()) return match;
    return { ...match, size: info.size, modified: info.mtime.toISOString() };
  } catch {
    return match;
  }
}

/** Read-only comfy_cli models_* actions that can be served without comfy-cli. */
export type LocalModelsListAction = "list-folders" | "list-folder" | "search" | "show";

export function isLocalModelsListAction(action: string): action is LocalModelsListAction {
  return action === "list-folders" || action === "list-folder" || action === "search" || action === "show";
}

export interface LocalModelsFallbackResult {
  command: string;
  data: unknown;
}

/**
 * When listLocalModels() yields nothing it may be an empty (but reachable)
 * server, OR it may mean we have no usable local source at all. The latter must
 * be a clear error rather than a silent empty list, so callers know to install
 * comfy-cli or point at a reachable ComfyUI. A local COMFYUI_PATH always counts
 * as a source; otherwise we probe the connected server cheaply via system_stats.
 */
async function assertLocalSourceAvailable(): Promise<void> {
  if (config.comfyuiPath) return;
  try {
    await getSystemStats();
    return; // server reachable — an empty result is a legitimate answer
  } catch (err) {
    // #796 — "UNREACHABLE" IS A SPECIFIC CLAIM, and this made it for every way
    // the probe can fail. A 401, a 500, a timeout, and an HTML page from a
    // reverse proxy that forwards the UI but not the API all produced "the
    // connected ComfyUI server is unreachable" and the remedy "connect to a
    // running ComfyUI server" — which the user has already done in three of
    // those four.
    //
    // The irony is that this threw the answer away: `getSystemStats` already
    // fails with the diagnosis #828/#952/#954 built for exactly this, naming
    // what answered, with which status and content type, and what to check. It
    // is scrubbed at the source, so it is safe to carry.
    //
    // The claim is now the observation — the probe did not yield readable stats
    // — and the CAUSE comes from the error rather than from a guess.
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(
      "comfy-cli was not found and no local model source could be established: COMFYUI_PATH is unset, " +
        `and the connected ComfyUI's /system_stats could not be read. ${why} ` +
        "Install comfy-cli>=1.11.1 (or set COMFY_CLI_PATH), set COMFYUI_PATH, or point at a ComfyUI whose API answers.",
    );
  }
}

/**
 * Serve a read-only comfy_cli models_* listing action from the connected
 * ComfyUI's local models (via listLocalModels), for use when comfy-cli is
 * absent. Throws when a required argument is missing (mirrors the CLI path).
 */
export async function listLocalModelsFallback(args: {
  action: LocalModelsListAction;
  folder?: string;
  text?: string;
  type?: string;
  name?: string;
  limit?: number;
}): Promise<LocalModelsFallbackResult> {
  switch (args.action) {
    case "list-folders": {
      // comfy `models list-folders` reports the model folder names. We list
      // the folders that actually contain at least one model — the canonical
      // MODEL_SUBDIRS first (in their canonical order), then any additional
      // loader-registered categories present (e.g. ComfyUI-GGUF's `unet_gguf`,
      // `clip_gguf`), so GGUF-only folders aren't silently dropped (#526).
      const models = await listLocalModels();
      if (models.length === 0) await assertLocalSourceAvailable();
      const present = new Set(models.map((m) => m.type));
      const canonical = MODEL_SUBDIRS.filter((f) => present.has(f));
      const extras = [...present].filter(
        (t) => !(MODEL_SUBDIRS as readonly string[]).includes(t),
      );
      const folders = [...canonical, ...extras];
      return { command: "models list-folders", data: { folders } };
    }
    case "list-folder": {
      if (!args.folder) throw new Error("folder is required for list-folder");
      const folder = resolveModelFolder(args.folder);
      const models = await listLocalModels(folder);
      if (models.length === 0) await assertLocalSourceAvailable();
      let files = models.map((m) => m.name);
      // comfy-cli forwards `--limit` for list-folder; cap the same way.
      if (args.limit && args.limit > 0) files = files.slice(0, args.limit);
      return { command: `models list-folder ${folder}`, data: { folder, count: files.length, files } };
    }
    case "search": {
      // Map the CLI's singular `--type` alias to the real folder before scanning.
      const models = await listLocalModels(args.type ? resolveModelFolder(args.type) : undefined);
      if (models.length === 0) await assertLocalSourceAvailable();
      const needle = (args.text ?? "").trim().toLowerCase();
      let hits = needle ? models.filter((m) => m.name.toLowerCase().includes(needle)) : models;
      if (args.limit && args.limit > 0) hits = hits.slice(0, args.limit);
      const results = hits.map((m) => ({ name: m.name, type: m.type, path: m.path }));
      return { command: "models search", data: { count: results.length, results } };
    }
    case "show": {
      if (!args.name) throw new Error("name is required for show");
      const showArgs = { name: args.name, folder: args.folder, type: args.type };
      // Prefer the hinted folder so a filtered REST listing does not even see
      // same-basename files in other categories. The matcher still filters the
      // returned set: mocks (and unfiltered listings) can still yield duplicates.
      const folderHint = showArgFolderConflictsName(showArgs) ? undefined : showFolderHint(showArgs);
      const models = await listLocalModels(folderHint);
      if (models.length === 0) await assertLocalSourceAvailable();
      const match = await enrichShowStats(pickShowMatch(models, showArgs));
      return {
        command: `models show ${args.name}`,
        data: {
          name: match.name,
          type: match.type,
          path: match.path,
          size: match.size,
          modified: match.modified,
          ...(match.baseModel ? { baseModel: match.baseModel } : {}),
          ...(match.triggerWords?.length ? { triggerWords: match.triggerWords } : {}),
          ...(match.civitaiUrl ? { civitaiUrl: match.civitaiUrl } : {}),
        },
      };
    }
  }
}
