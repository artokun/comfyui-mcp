import { listLocalModels, MODEL_SUBDIRS } from "./model-resolver.js";
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
      const models = await listLocalModels();
      if (models.length === 0) await assertLocalSourceAvailable();
      const needle = args.name.toLowerCase();
      // comfy `models show <name>` addresses a specific model by name — return
      // the EXACT (case-insensitive) match only. A substring guess would report
      // an arbitrary model (e.g. show "flux" picking one of several), so no
      // exact match is a clear not-found.
      const match = models.find((m) => m.name.toLowerCase() === needle);
      if (!match) throw new Error(`Model '${args.name}' was not found among the connected ComfyUI's local models.`);
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
