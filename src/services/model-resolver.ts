import { createHash, randomBytes } from "node:crypto";
import { existsSync, type Stats } from "node:fs";
import { platform } from "node:os";
import { readdir, stat, mkdir, readFile, lstat, realpath } from "node:fs/promises";
import { dirname, join, basename, normalize, resolve, relative, sep, isAbsolute, extname } from "node:path";
import { config, getComfyUIBaseUrl, isRemoteMode } from "../config.js";
import { getClient, getLogs, getSystemStats, comfyApiFetch } from "../comfyui/client.js";
import { getExtraModelRoots, getLiveExtraModelRoots } from "./extra-paths.js";
import {
  liveRootFromArgv,
  resolveEffectiveComfyUIBase,
  resolveLiveServerRoot,
} from "./workspace-env.js";
import { installModelViaManager } from "./node-management.js";
import { ModelError, ValidationError, unreachableHostMessage } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { downloadWithCache, findResumablePartial, probeRemoteModelPayload } from "./download-cache.js";
import { reportDownloadProgress } from "./download-progress.js";
import type { ResumeReporter } from "./download-resume-diag.js";
import { modelNotFoundMessage } from "./model-root-scope.js";
import {
  resolveModelsDirWithBases,
  parseModelsDirFromArgv,
  parseExtraModelPathsConfigsFromArgvRaw,
  hasUnresolvableRelativeModelDirFlag,
  isLiveAuthoritativeModelsDir,
  modelsDirNamedByServer,
  type LiveServerSnapshot,
  type ModelsDirSource,
} from "./output-dir.js";
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
 * Registered extra_model_paths categories that are NOT model-weight folders and
 * must NEVER be treated as a valid download destination — even when a symlink
 * under models/ resolves into one (#633 symlink allowance). The critical entry is
 * `custom_nodes`: ComfyUI IMPORTS Python from it at startup, so allowing a model
 * download (arbitrary bare filename) to land there would turn a file fetch into
 * arbitrary CODE execution. extra_model_paths configs routinely register
 * `custom_nodes` alongside model folders (see extra-paths.ts), so the symlink
 * allowance filters these out and honors only genuine model roots — a download can
 * reach a model dir on another drive (the #633 intent) but never a code directory.
 * Compared case-insensitively.
 */
const NON_MODEL_EXTRA_CATEGORIES = new Set(["custom_nodes"]);

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
  /** Trigger/activation words from the CivitAI download sidecar, when present —
   *  so the agent applies them automatically when generating with this model. */
  triggerWords?: string[];
  /** Base model from the CivitAI sidecar (e.g. "SDXL 1.0"), when present. */
  baseModel?: string;
  /** Canonical CivitAI page URL from the sidecar (carries the modelId and the
   *  INSTALLED modelVersionId) — provenance for humans and the anchor clients
   *  use to check whether a newer version exists on CivitAI. */
  civitaiUrl?: string;
}

/**
 * Resolve the local ComfyUI base directory for filesystem operations. Prefers
 * COMFYUI_PATH / auto-detection (config.comfyuiPath); when that's unset and we're
 * NOT targeting a remote ComfyUI, falls back to the saved default workspace (set
 * via workspace action:"set_default") so local downloads and model lookups work without
 * COMFYUI_PATH — matching what install_comfyui (action:"environment") / workspace action:"get" already report.
 * Never falls back to a local workspace in remote mode (that dir isn't the remote
 * target). Returns undefined when no usable local path exists.
 */
/** A stable per-PROCESS tiebreak (0..999) folded into every attempt epoch so two
 *  DIFFERENT processes that start an attempt in the very same millisecond still get
 *  DISTINCT epochs (codex finding). Equal epochs would collide on the per-attempt
 *  filename (a real clobber) AND defeat supersession (the predicate needs strictly
 *  greater). Live processes on one host have distinct pids, but a random nonce avoids
 *  even a pid-reuse tie; the space only needs to separate the rare same-URL,
 *  same-target, same-ms double-start. */
const ATTEMPT_TIEBREAK = randomBytes(2).readUInt16BE(0) % 1000;

/** Strictly-monotonic attempt epoch (panel#489). Wall-clock milliseconds DOMINATE the
 *  ordering (× 1000), so a retry — which starts later in real time — always outranks the
 *  attempt it replaced, even across a reconnect respawn in a different process. The
 *  low-order tiebreak makes concurrent same-ms attempts in different processes distinct
 *  (no filename clobber, decisive supersession). Within THIS process the value never
 *  repeats or goes backward — two same-ms retries (or a small local clock rollback) still
 *  get increasing generations; a tie would let a stale FAILED slip through. (Cross-process
 *  ordering still assumes the wall clock does not jump backward by more than a retry gap —
 *  a severe NTP step is out of scope, as it is for any wall-clock generation.) */
let lastAttemptEpoch = 0;
function nextAttemptEpoch(): number {
  const base = Date.now() * 1000 + ATTEMPT_TIEBREAK;
  lastAttemptEpoch = Math.max(base, lastAttemptEpoch + 1);
  return lastAttemptEpoch;
}

function resolveComfyUIBase(): string | undefined {
  return resolveEffectiveComfyUIBase();
}

function getModelsRoot(): string {
  const base = resolveComfyUIBase();
  if (!base) {
    throw new ModelError(
      "No local ComfyUI path configured. Set the COMFYUI_PATH environment variable, " +
        "or save a default workspace with workspace (action:\"set_default\").",
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
  // Captured ONCE: the credential getters resolve from the canonical store on
  // every access, so testing one read and interpolating another can send a
  // different token — or `Bearer undefined` — if the store is rewritten in
  // between (codex gate, round 6, finding 3).
  const hfToken = config.huggingfaceToken;
  if (hfToken) {
    headers["Authorization"] = `Bearer ${hfToken}`;
  }

  const url = applyHfEndpoint(`https://huggingface.co/api/models?${params}`);
  logger.debug("HuggingFace API request", { url });

  // Third-party API: bound the wait so a stalled response cannot wedge the
  // turn. Same class as #1026 — an unbounded metadata call has no limit at
  // all and hangs until the caller gives up.
  //
  // #1136: an unreachable HuggingFace is the failure most easily mistaken for
  // "no such model" — this call backs model SEARCH, and its caller renders a
  // zero-length array as "nothing found". Only errors thrown by fetch() itself
  // take this path; an HTTP status is a real answer and keeps its own wording.
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) }).catch(
    (err: unknown) => {
      const { message, code } = unreachableHostMessage(err, url, "the HuggingFace model search", {
        remedy:
          "If huggingface.co is blocked in your region, set HF_ENDPOINT to a reachable mirror " +
          "(e.g. https://hf-mirror.com) and retry.",
      });
      throw new ModelError(message, { url, code });
    },
  );
  if (!res.ok) {
    // unknown-ok: "" is interpolated into an ERROR MESSAGE and nothing else — the
    // HTTP status is reported either way, so an unreadable body costs detail in the
    // text, never a wrong conclusion. Verified there is no branch on this value.
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

/**
 * Discover the GGUF model-folder categories a running ComfyUI has registered, by
 * asking `GET /models` (which returns every key in `folder_names_and_paths`) and
 * keeping the `*_gguf` ones our static MODEL_SUBDIRS list doesn't already cover.
 *
 * This is what fixes #526: core `/models/<dir>` only lists extensions in
 * `supported_pt_extensions` (no `.gguf`), so a static scan of MODEL_SUBDIRS misses
 * every GGUF model. But those files are not hidden — ComfyUI-GGUF (and every
 * derivative) registers its own categories (`unet_gguf`, `clip_gguf`) with a
 * `.gguf` filter, and ComfyUI serves them over REST like any other category.
 * Listing them surfaces GGUF models authoritatively: it reflects the LIVE server,
 * honours extra_model_paths, works remotely, and needs no filesystem scan or folder
 * guessing — each model is typed by the category ComfyUI itself registered.
 *
 * Why only `*_gguf` and not "every non-core category `/models` reports": `/models`
 * exposes category NAMES but not their extension sets, so there is no safe way to
 * tell a weight-bearing custom category from an extension-BLIND one (ComfyUI's own
 * `custom_nodes` / `datasets` register with an empty set and would list every file
 * under them — source code, arbitrary data — flooding the output). The `_gguf`
 * suffix is a reliable, self-describing signal for GGUF model folders (the subject
 * of #526) and cannot flood. Surfacing other loader categories (e.g. TensorRT's
 * `.engine`) is a separate enhancement that needs per-category extension knowledge.
 *
 * Best-effort: returns [] when `/models` is unavailable (older server / error), in
 * which case the caller still lists the core categories and, offline, the filesystem
 * fallback still finds `.gguf` files on disk under their real folders.
 */
/** A `*_gguf` registry category (ComfyUI-GGUF's `unet_gguf`/`clip_gguf`, …). */
function isGgufCategory(dir: string): boolean {
  return /_gguf$/i.test(dir);
}

/**
 * The physical folders a KNOWN `*_gguf` view is backed by — used ONLY to recognise when
 * the SAME file is surfaced both via the view and via one of the real folders it
 * aliases. ComfyUI-GGUF registers `unet_gguf` over the `diffusion_models` folders
 * (`unet/` + `diffusion_models/`) and `clip_gguf` over the `text_encoders` folders
 * (`text_encoders/` + `clip/`); that is the complete set for standard ComfyUI-GGUF.
 * Never used for a model's reported `type`.
 */
const GGUF_BACKING_DIRS: Record<string, string[]> = {
  unet_gguf: ["unet", "diffusion_models"],
  clip_gguf: ["text_encoders", "clip"],
};

/**
 * The real folder(s) a scanned category resolves to, for de-dup identity. A KNOWN
 * `*_gguf` view resolves to the physical folders it aliases (so the same file surfaced
 * via the view and via its backing core folder collapses to one). EVERY other category
 * — a core category, OR an UNKNOWN/unmapped `*_gguf` — resolves to ITSELF. We must NOT
 * assume an unknown `<x>_gguf` aliases a same-named `<x>` folder: a genuinely distinct
 * `<x>_gguf/model.gguf` would then be wrongly collapsed against a real `<x>/model.gguf`
 * and dropped. Lookup is case-insensitive.
 *
 * This intentionally targets only the duplication THIS fix can introduce. The
 * pre-existing overlap between ComfyUI's own back-compat categories (e.g.
 * `diffusion_models` also listing `unet/`) is left exactly as on main: its provenance
 * is erased over REST, so collapsing it would risk discarding distinct same-name files.
 */
function identityFoldersFor(category: string): string[] {
  const lower = category.toLowerCase();
  return GGUF_BACKING_DIRS[lower] ?? [lower];
}

/**
 * Identity keys for a file within a scanned category — `<backing-folder>/<relname>`.
 * The RELATIVE name (which may include subfolders) is used, not just the basename: a
 * `*_gguf` view and its backing core folder report the SAME relative path for the same
 * file, so keying on it collapses that alias duplicate while keeping genuinely distinct
 * files (same basename in a different subfolder, or in a different real folder)
 * separate. The folder segment is lowercased (folder/category names are effectively
 * case-insensitive); the relative NAME is used verbatim — its case and path separators
 * matter (`Model.gguf` ≠ `model.gguf`, and a literal `a\b` ≠ nested `a/b` on POSIX).
 * That's safe because a single call de-dups within ONE source (all HTTP or all
 * filesystem), so the same file always arrives with identical spelling. `add` returns
 * false (recording nothing) when the file is already present under any of its backing
 * folders, so callers skip the duplicate; otherwise it records every key and returns
 * true.
 */
function makeModelDeduper(): { add: (category: string, name: string) => boolean } {
  const seen = new Set<string>();
  return {
    add(category: string, name: string): boolean {
      const keys = identityFoldersFor(category).map((folder) => `${folder}/${name}`);
      if (keys.some((k) => seen.has(k))) return false;
      for (const k of keys) seen.add(k);
      return true;
    },
  };
}

/**
 * Weight-file extensions. The gate that makes discovering the WHOLE registry
 * safe (#962).
 *
 * #526 deliberately scoped discovery to `*_gguf` because `/models` also lists
 * extension-BLIND registries — `custom_nodes`, `datasets` and friends register
 * an EMPTY extension set, so `/models/<that>` returns every file in the folder
 * and folding one in would flood the listing with arbitrary files. That reason
 * is sound, and a denylist of category NAMES cannot answer it: the set is open,
 * since any custom node can register its own.
 *
 * Filtering the FILES instead closes it for good. A discovered category
 * contributes only recognisable weights, so an extension-blind registry full of
 * .txt/.json/.py contributes nothing — while a `.safetensors` under a key
 * MODEL_SUBDIRS never heard of finally becomes visible, which is the whole of
 * #962.
 */
const WEIGHT_EXTS = new Set([
  ".safetensors",
  ".ckpt",
  ".pt",
  ".pth",
  ".bin",
  ".gguf",
  ".sft",
  ".onnx",
  ".engine", // TensorRT
]);

async function discoverExtraCategories(
  client: ReturnType<typeof getClient>,
): Promise<string[]> {
  try {
    const res = await comfyApiFetch("/models");
    if (!res.ok) return [];
    const json = (await res.json()) as unknown;
    if (!Array.isArray(json)) return [];
    const core = new Set<string>(MODEL_SUBDIRS);
    // EVERY registered category we don't already scan, not just `*_gguf` (#962).
    //
    // MODEL_SUBDIRS is a hardcoded list of 15 folder names. Anything ComfyUI
    // registers outside it — a custom node's own folder, an extra_model_paths
    // entry, a fork's renamed weights dir — was invisible to this tool BY
    // CONSTRUCTION. A reporter had a remote server whose UNETLoader listed and
    // loaded `krastBf16_v3.safetensors` while `list_local_models` answered "no
    // diffusion_models models found" AND "no unet models found": the weights
    // were registered under a key neither name covers, and a hardcoded list can
    // never find them.
    //
    // `/models` is ComfyUI's own answer to "what folders do I serve?", so
    // discovery replaces the guess rather than supplementing it.
    return [
      ...new Set(
        json.filter((c): c is string => typeof c === "string" && c.trim() !== "" && !core.has(c)),
      ),
    ];
  } catch (err) {
    logger.debug("HTTP /models category discovery failed", { err });
    return [];
  }
}

/**
 * Where a model listing's emptiness came from (#918).
 *
 * An empty `LocalModel[]` used to be indistinguishable from "ComfyUI never
 * answered": every per-category read swallowed its error, `httpReturnedAny`
 * stayed false, the filesystem fallback returned [] because a remote setup has
 * no `comfyuiPath`, and the tool printed "No local models found." A reporter
 * read that as a misconfigured URL and told the user so — the listing was
 * correct minutes later, once the server finished warming up.
 *
 * So the listing now carries HOW it knows. "The server said zero" and "the
 * server said nothing" are different facts and must not render the same way.
 */
export type ModelListingCoverage = {
  /** Categories ComfyUI answered for — an OK response with an array body.
   *  Their emptiness is a verified fact. */
  answered: string[];
  /** Categories whose read failed or returned an unusable body, with why. Their
   *  emptiness is UNKNOWN, not zero. */
  unanswered: { dir: string; reason: string }[];
  /** Categories the server answered 404 for — it does NOT register them (#1015).
   *  A definite answer, not a gap: modern ComfyUI renamed `clip` → `text_encoders`
   *  and `unet` → `diffusion_models`, so the old names 404 on every current
   *  install. Kept distinct from `unanswered` so they never degrade a complete
   *  listing to "partial", and distinct from `answered` because the server holds
   *  no such folder at all rather than an empty one. */
  absent?: string[];
  /** Set when HTTP listing was unavailable as a whole (no client, cloud mode,
   *  category discovery threw) — every category is then unanswered. */
  httpUnavailable?: string;
  /** True when results came from the filesystem scan rather than HTTP. */
  usedFilesystem: boolean;
  /** Set when neither path could run: no HTTP answer AND no local install path
   *  to scan, which is the exact shape that produced the false "no models". */
  noSourceAvailable?: boolean;
  /**
   * Other categories THIS server registers, collected only when a FILTERED call
   * came back empty (#962).
   *
   * The unfiltered path already discovers every registered category, and its own
   * comment says why a filtered one skips discovery: "a FILTERED call already
   * names its exact category". True for the lookup — and it is exactly what makes
   * the answer misleading. The reporter called
   * `list_local_models({model_type:"diffusion_models"})` and `{"unet"}` on a
   * server whose UNETLoader was loading `krastBf16_v3.safetensors` at that
   * moment. Both names answered 200 with `[]`, honestly, because the weights are
   * registered under neither of them.
   *
   * So a filtered empty is a true statement about the wrong folder, and it is
   * dressed as a fact about the install. Only when we would otherwise report
   * "none" do we spend one `/models` call to say where else to look.
   *
   * Undefined means the question was never asked (a non-empty result, or the
   * category list could not be read) — never "there are no other categories",
   * which is what an empty array means.
   */
  otherRegisteredCategories?: string[];
};

/**
 * Why a category's body would not parse — stated from what was OBSERVED (#1015).
 *
 * The previous wording covered every parse failure with one sentence: "returned
 * a non-JSON body instead of JSON (a proxy, login page, or a server still
 * starting answers this way)". For an HTML body that is a fair reading. For an
 * EMPTY body it is three guesses stacked on a fact we already hold exactly — the
 * server answered, the status was fine, and it sent zero bytes. None of the
 * three offered causes produces an empty body, so the one case where the
 * evidence is unambiguous got the vaguest description.
 *
 * The reporter's ask was precisely this: "return the raw endpoint/status so
 * callers can distinguish an empty category from a transport/parse failure."
 * The status is now carried in every branch, because a parse failure at 200 and
 * a parse failure at 502 are different problems.
 *
 * Note what this does NOT claim. An empty body is not read as "the category is
 * empty" — that is the #918 conflation this whole coverage type exists to
 * prevent. An unparsable answer leaves the category UNANSWERED regardless of
 * why; this only makes the why accurate.
 */
export function describeUnparsableBody(status: number, body: string): string {
  const at = `HTTP ${status}`;
  if (body.trim() === "") {
    return (
      `ComfyUI answered ${at} with an EMPTY body (${body.length} byte${body.length === 1 ? "" : "s"}) — ` +
      `it reported nothing about this category either way`
    );
  }
  if (/^\s*</.test(body)) {
    return (
      `ComfyUI returned HTML instead of JSON ` +
      `(${at} — a proxy, a login page, or a server still starting answers this way)`
    );
  }
  // Neither empty nor markup: quote a bounded excerpt so the cause is
  // diagnosable without dumping a large body into the tool result. Collapse
  // whitespace so a multi-line payload stays on one line.
  const excerpt = body.trim().replace(/\s+/g, " ").slice(0, 80);
  return (
    `ComfyUI answered ${at} with a body that is not JSON ` +
    `(${body.length} bytes, starts: ${JSON.stringify(excerpt)})`
  );
}

/** Model listing plus the provenance needed to describe it honestly. */
export async function listLocalModelsWithCoverage(
  modelType?: string,
): Promise<{ models: LocalModel[]; coverage: ModelListingCoverage }> {
  const coverage: ModelListingCoverage = {
    answered: [],
    unanswered: [],
    absent: [],
    usedFilesystem: false,
  };
  const models = await collectLocalModels(modelType, coverage);
  // #962 — a filtered call that found nothing is about to say "none". Before it
  // does, ask the server what it actually registers. Bounded to this one case,
  // so the common paths pay nothing.
  if (models.length === 0 && modelType !== undefined && coverage.answered.includes(modelType)) {
    coverage.otherRegisteredCategories = await otherRegisteredCategories(modelType);
  }
  return { models, coverage };
}

/**
 * Categories this ComfyUI registers, minus the one already asked about (#962).
 *
 * Undefined on any failure: "we could not ask" must not render as "there is
 * nowhere else to look", which is the same fold the coverage type exists for.
 */
async function otherRegisteredCategories(asked: string): Promise<string[] | undefined> {
  try {
    const res = await comfyApiFetch("/models");
    if (!res.ok) return undefined;
    const json = (await res.json()) as unknown;
    if (!Array.isArray(json)) return undefined;
    return [
      ...new Set(
        json.filter(
          (c): c is string => typeof c === "string" && c.trim() !== "" && c !== asked,
        ),
      ),
    ];
  } catch (err) {
    logger.debug("could not read the registered category list for an empty filtered listing", {
      err,
    });
    return undefined;
  }
}

export async function listLocalModels(
  modelType?: string,
): Promise<LocalModel[]> {
  return (await listLocalModelsWithCoverage(modelType)).models;
}

async function collectLocalModels(
  modelType: string | undefined,
  coverage: ModelListingCoverage,
): Promise<LocalModel[]> {
  const dirsToScan: string[] = modelType ? [modelType] : [...MODEL_SUBDIRS];
  const results: LocalModel[] = [];

  // Path 1 — HTTP REST. ComfyUI's `/models/<dir>` endpoint reports what is
  // actually available to workflows, including symlinked / mounted dirs from
  // `extra_model_paths.yaml`. Pure filesystem scans of the install dir miss
  // those, and they fail entirely in remote/cloud mode where comfyuiPath is
  // undefined. Originally contributed by João Lucas (github.com/joaolvivas) in
  // joaolvivas/comfyui-mcp-byjlucas@e2ae39c8 (2026-05-12).
  const coreDirs = new Set<string>(MODEL_SUBDIRS);
  let httpReturnedAny = false;
  try {
    const client = getClient(); // throws CLOUD_UNSUPPORTED in cloud mode
    // For an unfiltered listing, scan every category the server REGISTERS that
    // MODEL_SUBDIRS doesn't already cover. That began as ComfyUI-GGUF's `*_gguf`
    // views (#526, the `.gguf` weights core `/models/<dir>` omits) and is now the
    // whole registry (#962): a hardcoded list of 15 folder names cannot find
    // weights a custom node, a fork, or an extra_model_paths entry registered
    // under some other key — and a reporter's UNETLoader was loading exactly such
    // a file while this tool reported none.
    //
    // A FILTERED call already names its exact category, so it needs no discovery.
    if (!modelType) {
      for (const cat of await discoverExtraCategories(client)) dirsToScan.push(cat);
    }
    // A `*_gguf` view aliases real folders, so the same file can be reported both
    // via the view and via a core category (e.g. a custom node that re-registers
    // `diffusion_models` to also admit `.gguf`). De-dup by resolved-folder identity
    // so it surfaces once, without collapsing genuinely distinct same-name files.
    const dedup = makeModelDeduper();
    for (const dir of dirsToScan) {
      try {
        const res = await comfyApiFetch(`/models/${dir}`);
        // A non-OK status or a non-array body means we did NOT learn what this
        // category holds. Recording the reason is the whole point: continuing
        // silently is what let a warming-up server look like an empty install.
        //
        // …with ONE exception, and it is the opposite fold (#1015). A 404 is the
        // server answering DEFINITIVELY that it does not serve this category —
        // "determined not present", not "could not determine". Modern ComfyUI
        // renamed two of the folders in MODEL_SUBDIRS (clip → text_encoders,
        // unet → diffusion_models), so a current install 404s the old names.
        // Reproduced on a live 0.31 server:
        //
        //   clip             HTTP 404 bytes=0
        //   unet             HTTP 404 bytes=0
        //   text_encoders    HTTP 200 bytes=297
        //   diffusion_models HTTP 200 bytes=360
        //
        // Counting those as unread put a permanent "Partial listing — 2
        // categories could not be read" on every healthy modern install, telling
        // a user their inventory was incomplete when it was complete — and naming
        // aliases whose real contents were already listed under the new names.
        //
        // Recorded as ABSENT rather than dropped silently, so an unfiltered
        // listing can still say which categories this server does not register.
        if (res.status === 404) {
          (coverage.absent ??= []).push(dir);
          continue;
        }
        if (!res.ok) {
          coverage.unanswered.push({ dir, reason: `HTTP ${res.status}` });
          continue;
        }
        // Parse from TEXT rather than res.json(): a proxy, login page, or a
        // still-starting server answers 200 with HTML, and res.json() then throws
        // `Unexpected token '<', "<!doctype "...` — a raw parser message that says
        // nothing about what actually happened. #918 called that out on the sibling
        // tool; classify it here instead of leaking it.
        const body = await res.text();
        let files: unknown;
        try {
          files = JSON.parse(body);
        } catch {
          coverage.unanswered.push({ dir, reason: describeUnparsableBody(res.status, body) });
          continue;
        }
        if (!Array.isArray(files)) {
          coverage.unanswered.push({
            dir,
            reason: `the response was JSON but not an array (got ${files === null ? "null" : typeof files})`,
          });
          continue;
        }
        coverage.answered.push(dir);
        for (const name of files) {
          if (typeof name !== "string") continue;
          // Hardening for any `*_gguf` category (discovered OR explicitly requested):
          // emit ONLY `.gguf` files. A well-behaved category registers a `{".gguf"}`
          // filter, but a malformed one could register an EMPTY extension set (which
          // lists every file) over a shared dir — without this guard that would flood
          // the output. Core categories never contain `.gguf`, so this stays additive.
          if (isGgufCategory(dir) && !name.toLowerCase().endsWith(".gguf")) continue;
          // #962 — the same hardening, generalised to every DISCOVERED category.
          // Discovery now folds in the whole registry, which includes
          // extension-blind entries (custom_nodes, datasets, a custom node's own)
          // whose `/models/<dir>` returns every file in the folder. Requiring a
          // weight extension is what keeps that from flooding the listing, and it
          // is the reason discovery can be widened at all. CORE categories are
          // untouched — their behaviour is unchanged.
          if (!coreDirs.has(dir) && !WEIGHT_EXTS.has(extname(name).toLowerCase())) continue;
          if (!dedup.add(dir, name)) continue; // same file already surfaced elsewhere
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
        coverage.unanswered.push({
          dir,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (httpReturnedAny) {
      await enrichWithCivitaiMetadata(results);
      return results;
    }
  } catch (err) {
    logger.debug("HTTP model listing unavailable, trying filesystem", { err });
    coverage.httpUnavailable = err instanceof Error ? err.message : String(err);
    // The outer throw (no client / cloud mode / GGUF discovery) aborts before any
    // per-category read, so nothing below it was answered either.
    for (const dir of dirsToScan) {
      if (
        !coverage.answered.includes(dir) &&
        // A category already answered 404 was ANSWERED — the later outer failure
        // does not un-answer it (#1015).
        !(coverage.absent ?? []).includes(dir) &&
        !coverage.unanswered.some((u) => u.dir === dir)
      ) {
        coverage.unanswered.push({ dir, reason: coverage.httpUnavailable });
      }
    }
  }

  // Path 2 — filesystem fallback. Only useful in pure local mode without
  // extra_model_paths.yaml. Returning empty here is only the RIGHT answer when
  // HTTP actually answered; when it didn't, this is the false-empty path from
  // #918 and the caller has to be told the difference (coverage.noSourceAvailable).
  if (!config.comfyuiPath) {
    coverage.noSourceAvailable = coverage.unanswered.length > 0;
    return results;
  }
  coverage.usedFilesystem = true;
  const modelsRoot = join(config.comfyuiPath, "models");
  const dedup = makeModelDeduper();
  for (const dir of dirsToScan) {
    const dirPath = join(modelsRoot, dir);
    let entries: string[];
    try {
      entries = await readdir(dirPath, { recursive: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Same `.gguf`-only guard as the HTTP path for `*_gguf` categories (e.g. an
      // explicit `listLocalModels("unet_gguf")`): never list non-gguf files here.
      if (isGgufCategory(dir) && !entry.toLowerCase().endsWith(".gguf")) continue;
      const filePath = join(dirPath, entry);
      try {
        const info = await stat(filePath);
        if (!info.isFile()) continue;
        if (!dedup.add(dir, entry)) continue; // same file already surfaced elsewhere
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

  await enrichWithCivitaiMetadata(results);
  return results;
}

/**
 * Best-effort: attach `triggerWords` + `baseModel` from each model's CivitAI
 * sidecar (`<file>.civitai.json`, written by download_model action:"download_civitai") so the
 * agent applies the trigger words automatically when generating. Silent when a
 * sidecar is missing or there's no local filesystem (remote/cloud).
 */
async function enrichWithCivitaiMetadata(models: LocalModel[]): Promise<void> {
  const base = resolveComfyUIBase();
  if (!base) return;
  const modelsRoot = join(base, "models");
  await Promise.all(
    models.map(async (m) => {
      // FS-scan paths are absolute; HTTP paths are `dir/name` relative to models/.
      const abs = isAbsolute(m.path) ? m.path : join(modelsRoot, m.path);
      try {
        const raw = await readFile(`${abs}.civitai.json`, "utf8");
        const j = JSON.parse(raw) as {
          trainedWords?: unknown;
          baseModel?: unknown;
          modelId?: unknown;
          versionId?: unknown;
          sourceUrl?: unknown;
        };
        if (Array.isArray(j.trainedWords) && j.trainedWords.length > 0) {
          m.triggerWords = j.trainedWords.map(String);
        }
        if (typeof j.baseModel === "string" && j.baseModel) {
          m.baseModel = j.baseModel;
        }
        // Provenance: prefer the sidecar's canonical sourceUrl; reconstruct it
        // from the ids for older sidecars that predate sourceUrl. Both shapes
        // exist in the wild: /models/<id>?modelVersionId=<vid> (model known)
        // and /model-versions/<vid> (version-only downloads).
        if (typeof j.sourceUrl === "string" && isCivitaiUrl(j.sourceUrl)) {
          m.civitaiUrl = j.sourceUrl;
        } else if (typeof j.versionId === "number") {
          m.civitaiUrl =
            typeof j.modelId === "number"
              ? `https://civitai.com/models/${j.modelId}?modelVersionId=${j.versionId}`
              : `https://civitai.com/model-versions/${j.versionId}`;
        }
      } catch {
        // No sidecar (or unreadable) — leave the model un-enriched.
      }
    }),
  );
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
 * True when `url`'s PARSED hostname is huggingface.co (or a subdomain). The single
 * authority for the "is this a Hugging Face host?" credential decision — used by BOTH the
 * local streaming download and the #473 remote flip probe. NEVER a substring match:
 * `https://attacker.example/m.safetensors?ref=huggingface.co` and
 * `https://huggingface.co.evil.com/...` both parse to a non-HF host and get NO token
 * (a substring `url.includes("huggingface.co")` would leak HF_TOKEN to them). An
 * unparseable url is not HF (no token).
 */
function isHuggingFaceHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "huggingface.co" || host.endsWith(".huggingface.co");
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

// ---------------------------------------------------------------------------
// Live-server visibility (#369): does the CONNECTED ComfyUI actually read here?
// ---------------------------------------------------------------------------

/**
 * The file extensions ComfyUI core registers for its model folders
 * (`folder_paths.supported_pt_extensions`). Deliberately EXCLUDES `.gguf` and
 * other custom-node-registered types: this set is used to decide whether a
 * candidate directory's contents SHOULD appear in the live server's listing, and
 * over-including would turn "core doesn't list this type" into a false refusal.
 */
const CORE_MODEL_EXTENSIONS = new Set([
  ".ckpt",
  ".pt",
  ".pt2",
  ".bin",
  ".pth",
  ".safetensors",
  ".sft",
]);

/**
 * Model categories whose `/models/<category>` endpoint can NEVER enumerate FILES,
 * so "the server does not list this file" is not evidence about the server at all.
 * ComfyUI core registers `diffusers` with the extension contract `["folder"]`
 * (folder_paths.py) — an extension no real file ever matches — so the listing is
 * empty BY DESIGN: ComfyUI loads a diffusers model as a whole directory and never
 * lists the component files inside one (`hunyuan3d-paint-v2-0-turbo/vae/diffusion_pytorch_model.bin`,
 * `.../text_encoder/pytorch_model.bin`). Sampling those component files and
 * finding them "missing" from the listing was the #844 false "a DIFFERENT install"
 * refusal — the omission is CONTRACTUAL, not evidential.
 * For these categories the listing is inconclusive about files in BOTH directions:
 * absence proves nothing (the pre-write refusal) and a landed file's presence
 * cannot be confirmed from it either (the post-write check) — both must report
 * "unknown", never a determined negative.
 */
const CATEGORIES_WITHOUT_FILE_ENUMERATION = new Set(["diffusers"]);

/** Is this category's live listing contractually incapable of naming FILES? */
function categoryCannotEnumerateFiles(category: string): boolean {
  return CATEGORIES_WITHOUT_FILE_ENUMERATION.has(category.trim().toLowerCase());
}

/** The models/ CATEGORY a target subfolder belongs to — its first path segment
 *  (`"loras/sdxl"` → `"loras"`), which is the folder name ComfyUI's `/models/<cat>`
 *  endpoint is keyed by. */
function categoryOf(targetSubfolder: string): string {
  return (targetSubfolder ?? "").trim().split(/[\\/]+/).filter(Boolean)[0] ?? "";
}

/** The part of a target subfolder BELOW its category (`"loras/sdxl/x"` → `"sdxl/x"`,
 *  `"loras"` → `""`). ComfyUI's `/models/<category>` listing is relative to the
 *  category, so this is what a landed file's entry must be prefixed with. */
function subfolderRemainder(targetSubfolder: string): string {
  const parts = (targetSubfolder ?? "").trim().split(/[\\/]+/).filter(Boolean);
  return parts.slice(1).join("/");
}

/**
 * What the LIVE server reports for a model category via its own `/models/<cat>`
 * endpoint — the SAME source of truth `list_local_models` reads, which is exactly
 * why #369 was so confusing: the reader asked the server and the writer asked
 * COMFYUI_PATH, and the two disagreed silently.
 *
 * Returns `undefined` (INCONCLUSIVE — never an empty array) when the server is
 * unreachable, the endpoint is absent/errors, the body is not a string array, OR
 * the category's enumeration contract cannot name files at all
 * (CATEGORIES_WITHOUT_FILE_ENUMERATION — there an answered-but-empty listing is
 * the contract speaking, not the server's contents). Callers must treat
 * inconclusive as "no evidence", never as "no files".
 */
export async function liveCategoryListing(
  category: string,
): Promise<string[] | undefined> {
  if (!category) return undefined;
  if (categoryCannotEnumerateFiles(category)) return undefined;
  try {
    const res = await comfyApiFetch(`/models/${encodeURIComponent(category)}`);
    if (!res.ok) return undefined;
    const json = (await res.json()) as unknown;
    if (!Array.isArray(json)) return undefined;
    return json.filter((n): n is string => typeof n === "string");
  } catch {
    return undefined;
  }
}

/**
 * Model files under a category directory, as CATEGORY-RELATIVE paths — the exact
 * form ComfyUI's `/models/<category>` listing uses (`"sdxl/x.safetensors"`). Bare
 * basenames would make `loras/a/shared.safetensors` look accounted for by a live
 * `loras/b/shared.safetensors` from a different install (codex gate, round 9).
 */
async function coreModelFilesUnder(categoryDir: string): Promise<string[]> {
  let entries: string[] | undefined;
  try {
    entries = await readdir(categoryDir, { recursive: true });
  } catch {
    return [];
  }
  // Not just tidiness: this feeds a REFUSAL, so an unreadable/odd listing must
  // become "no evidence", never a crash inside the download path.
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e) => typeof e === "string" && CORE_MODEL_EXTENSIONS.has(extname(e).toLowerCase()))
    .map((e) => normRel(e));
}

/** How many populated categories of the candidate models root we cross-check.
 *  Bounded so a large models tree costs a handful of cheap HTTP calls, not one
 *  per folder. */
const DISAGREEMENT_PROBE_CATEGORIES = 6;

/** How many model files a fully-agreeing category must hold before it CORROBORATES
 *  that the live server reads this root (#1147). One is not enough: two unrelated
 *  installs routinely share a single popular checkpoint, and a category holding
 *  only that file is "fully accounted for" by coincidence (codex gate, round 5).
 *  Two independent names both coinciding is not an ordinary explanation. */
const CORROBORATING_CONTAINMENT_MIN_FILES = 2;

/** Immediate subdirectories of the candidate models root, in a stable order. */
async function categoriesUnder(modelsRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(modelsRoot, { withFileTypes: true });
    if (!Array.isArray(entries)) return [];
    const names: string[] = [];
    for (const e of entries) {
      const entry = e as { name?: unknown; isDirectory?: unknown } | null;
      if (!entry || typeof entry.isDirectory !== "function") continue;
      if (typeof entry.name !== "string") continue;
      if ((entry.isDirectory as () => boolean)()) names.push(entry.name);
    }
    return names.sort();
  } catch {
    return [];
  }
}

/**
 * REFUSE a destination the connected ComfyUI demonstrably does not read from.
 *
 * Runs ONLY when the models root came from LOCAL CONFIGURATION that the running
 * server never vouched for (`configured-base` / `base-anchored`) — a live-resolved
 * root is already authoritative and needs no second opinion. The test is a pure
 * disagreement check against the server's own `/models/<category>` listing: if a
 * category directory in the candidate root holds core-extension model files and the
 * live server lists NONE of them, that root is not part of its search path. That is
 * the #369 signature exactly (3 files on disk, 24 unrelated files in the live
 * listing), and catching it BEFORE the transfer saves the user the multi-GB download
 * that would otherwise be reported as a success and then be invisible.
 *
 * The evidence is gathered ROOT-WIDE, not just from the target category: a stale
 * install commonly has an EMPTY `diffusion_models/` while its `checkpoints/` is full
 * of files the live server has never heard of (codex gate, round 1 — the target
 * category alone made an empty-but-wrong destination look evidence-free).
 *
 * Agreement means CONTAINMENT, not overlap (codex gate, round 5): a directory the
 * server scans has ALL of its model files in that server's listing. A single shared
 * filename proves nothing — two unrelated installs routinely hold the same popular
 * checkpoint — so overlap alone must never suppress the refusal.
 *
 * CORROBORATION (#1147): a category the server lists COMPLETELY, holding more than
 * one file, is positive evidence that it reads this ROOT — every one of those names
 * would have to coincide otherwise. That outweighs a single unaccounted file in
 * another category, which has ordinary explanations that say nothing about the root
 * (an unregistered extension, a cached listing, a nested HuggingFace dump). So the
 * scan does not stop at the first disagreement, and a tree the server demonstrably
 * reads is not refused over a stray file. A tree it accounts for NOWHERE — the #369
 * signature — has no such category to offer and still refuses.
 *
 * POSITIVE EVIDENCE ONLY. There is deliberately no "the live server lists models
 * this tree cannot account for" rule: being unable to EXPLAIN the server's models is
 * absence of evidence, not proof that this destination belongs to another install
 * (maintainer ruling). Unaccountable is a proceed-unverified state — see the note at
 * the end of the body.
 *
 * Fails OPEN on anything inconclusive — server unreachable, endpoint missing, an
 * empty candidate directory, a category whose listing contractually cannot name
 * files (`diffusers`, #844: its component files are absent from the listing by
 * DESIGN, so their "absence" is not disagreement), or full containment. It must
 * never block a legitimate download into a fresh or shared models tree.
 */
async function assertDestinationVisibleToLiveServer(
  modelsRoot: string,
  targetSubfolder: string,
  source: ModelsDirSource,
  snapshot: LiveServerSnapshot,
): Promise<void> {
  // A live-resolved root that EXISTS on this filesystem is authoritative and needs
  // no second opinion. A live-resolved root that does NOT exist locally is a
  // different animal: a loopback ComfyUI inside Docker / behind an SSH forward
  // reports its CONTAINER-side `--models-directory`, and writing that path here
  // silently creates a host directory the server never reads (codex gate, round 3).
  // The check below is cheap and fails open, so run it for that case too.
  // Only a root the SERVER ITSELF named skips this (#369). `observed-root` reads
  // as live-authoritative elsewhere and is not wrong to — it beats local config —
  // but it is INFERRED from where the interpreter lives, and that inference can
  // land on a stale bundle whose python happens to be on PATH. The exemption
  // needs a statement from the server, not our best reading of the OS.
  if (modelsDirNamedByServer(source) && existsSync(modelsRoot)) return;
  if (!snapshot.reachable || isRemoteMode()) return;

  // The target category first (it is the one that matters), then the rest of the
  // root — so a populated sibling can still expose a wrong install when the target
  // folder happens to be empty.
  const target = categoryOf(targetSubfolder);
  const present = await categoriesUnder(modelsRoot);
  const primary = [...(target ? [target] : []), ...present.filter((c) => c !== target)];

  let probed = 0;
  let worst: { category: string; missing: string[]; onDisk: number; live: number } | undefined;
  let corroborating: { category: string; files: number } | undefined;

  for (const category of primary) {
    if (probed >= DISAGREEMENT_PROBE_CATEGORIES) break;
    const onDisk = await coreModelFilesUnder(join(modelsRoot, category));
    if (onDisk.length === 0) continue; // nothing here to contradict anything
    const listing = await liveCategoryListing(category);
    if (listing === undefined) continue; // the server can't speak for it — no evidence
    // #1147 — AN EMPTY LISTING IS NOT DISAGREEMENT.
    //
    // The #369 signature this guard exists for is a POPULATED listing that
    // describes a different tree: 3 files on disk, 24 unrelated files live. That
    // is positive evidence — the server demonstrably scans SOMETHING ELSE for
    // this category.
    //
    // An empty listing says only that the server named nothing here, and that is
    // equally explained by a server that reads this very directory but does not
    // enumerate it the way a filesystem walk does. A reporter's portable install
    // held models/birefnet/BiRefNet_lite/model.safetensors — a HuggingFace repo
    // dump — while /models/birefnet answered empty, and the download was refused
    // into the correct, running install, with their loras/ agreeing perfectly.
    //
    // So "0 live entries" cannot distinguish "wrong install" from "a category
    // this server does not scan like we do", and this guard refuses only on
    // positive evidence. The same reasoning the surrounding code already applies
    // to `diffusers` (#844), whose listing contractually names no files —
    // generalized from one hardcoded category to the condition underneath it.
    if (listing.length === 0) continue;
    probed += 1;
    // CONTAINMENT, not overlap. If this directory really is one the server reads, it
    // SCANS it — so EVERY core-extension file in it must appear in the listing. A
    // merely-overlapping name proves nothing: two unrelated installs routinely share
    // `sd_xl_base_1.0.safetensors`, and treating that as agreement let a download
    // proceed into a stale tree (codex gate, round 5). Compared as CATEGORY-RELATIVE
    // paths, so `a/shared.safetensors` is not accounted for by a live
    // `b/shared.safetensors` (codex gate, round 9).
    const liveNames = new Set(listing.map((n) => normRel(n)));
    const missing = onDisk.filter((n) => !liveNames.has(n));
    if (missing.length === 0) {
      // This folder is fully accounted for — it AGREES, and that is itself positive
      // evidence (see the corroboration note below). Keep the largest such category:
      // the more names that had to coincide, the less coincidence explains it.
      if (
        onDisk.length >= CORROBORATING_CONTAINMENT_MIN_FILES &&
        onDisk.length > (corroborating?.files ?? 0)
      ) {
        corroborating = { category, files: onDisk.length };
      }
      continue;
    }
    // Record the FIRST disagreement, but do NOT stop scanning. Evidence that this
    // root IS read can only come from the categories after it, and breaking here
    // threw it away — see the corroboration note below (#1147, 0.51.56).
    if (!worst) worst = { category, missing, onDisk: onDisk.length, live: listing.length };
  }

  // #1147 — CORROBORATED READERSHIP OUTWEIGHS A SINGLE UNACCOUNTED FILE.
  //
  // A reporter's ComfyUI Desktop install was refused an `animatediff_models`
  // download because ONE unlisted file under `ipadapter` was read as proof of a
  // different install, while that same server listed other categories of that same
  // tree file for file. This guard gathered positive evidence in the REFUSE
  // direction and discarded the positive evidence it had already computed in the
  // PROCEED direction — `missing.length === 0` was a bare `continue`, and the first
  // disagreement `break`ed before any later category could speak.
  //
  // The two facts are not symmetric:
  //
  //   A category the server lists COMPLETELY is evidence about the ROOT. For a
  //   different install to produce it, EVERY name in that category would have to
  //   coincide — which is why one file is not enough (two unrelated installs really
  //   do share `sd_xl_base_1.0.safetensors`; codex gate round 5), and why the
  //   largest agreeing category is the one worth keeping.
  //
  //   A file the server does not name is evidence about that FILE. It has ordinary
  //   explanations that say nothing about the root: an extension not registered for
  //   that category, a listing cached before the file arrived, a nested HuggingFace
  //   dump (#1147's original birefnet report), a folder a custom node registers
  //   against a different path.
  //
  // The #369 signature is a tree the server accounts for NOWHERE — 3 files on disk,
  // 24 unrelated files live. That still refuses, here and for an inferred root
  // (#1562), because a stale bundle has no fully-agreeing category to offer.
  //
  // Bounded by DISAGREEMENT_PROBE_CATEGORIES like the disagreement scan itself: a
  // tree whose agreeing category sorts past the budget is refused as before.
  if (worst && corroborating) {
    logger.info(
      `[models] "${worst.category}" holds ${worst.missing.length} file(s) the server does not ` +
        `list, but it lists all ${corroborating.files} file(s) of "${corroborating.category}" ` +
        `in this same tree — proceeding (#1147).`,
    );
    worst = undefined;
  }

  if (worst) {
    const sample = worst.missing.slice(0, 3).join(", ");
    throw new ModelError(
      `Refusing to download into "${modelsRoot}": the connected ComfyUI ` +
        `(${getComfyUIBaseUrl()}) does not read from it. Its "${worst.category}" folder holds ` +
        `${worst.onDisk} model file(s), ${worst.missing.length} of which the running server does ` +
        `NOT list (e.g. ${sample}) — if it scanned this directory it would see all of them, so ` +
        "this is a DIFFERENT install than the one serving you. This destination came from local " +
        "configuration (COMFYUI_PATH / the saved default workspace), not from the running server, " +
        "which could not tell us its own install root. Point COMFYUI_PATH at the ComfyUI that is " +
        "actually running, or launch it with an absolute --base-directory, then retry.",
    );
  }

  // NOTE — there is deliberately NO 'the server lists models this tree does not contain'
  // refusal. That inference is itself absence of evidence: not being able to ACCOUNT
  // for the server's models is not proof the destination belongs to a different
  // install. The roots could be registered by a config we cannot read, one deleted
  // after the server loaded it, or a path shape nobody has enumerated yet — and each
  // time that rule was tightened it produced another FALSE REFUSAL of a legitimate
  // setup (an external drive, a moved YAML). Per the maintainer ruling, unaccountable
  // is a PROCEED-UNVERIFIED state, not a refusal: the download goes through and the
  // post-write check reports honestly. This guard refuses only on POSITIVE evidence —
  // files sitting in this tree that the running server demonstrably does not read.
}

/** Normalize a listing entry / relative path for comparison (ComfyUI reports
 *  OS-native separators). */
function normRel(s: string): string {
  return s.replace(/\\/g, "/").replace(/^\.?\//, "");
}

/** The category-relative entry a file at `<models>/<targetSubfolder>/<filename>`
 *  would appear as in ComfyUI's `/models/<category>` listing. */
function listingEntryFor(targetSubfolder: string, filename: string): string {
  const rest = subfolderRemainder(targetSubfolder);
  return normRel(rest ? `${rest}/${filename}` : filename);
}

/**
 * Was this exact entry ALREADY in the live server's listing before we wrote?
 *
 * Captured BEFORE the transfer so the post-write check can tell "the server now
 * sees the file BECAUSE we wrote it" from "the server already had a file of that
 * name somewhere else". Without that distinction a download into a stale tree that
 * happens to share a filename with the live install verifies as `visible` and is
 * reported as a success (codex gate, round 3). `undefined` = the server could not
 * answer, so nothing is known either way.
 */
export async function liveListingHasEntry(
  targetSubfolder: string,
  filename: string,
): Promise<boolean | undefined> {
  const listing = await liveCategoryListing(categoryOf(targetSubfolder));
  if (listing === undefined) return undefined;
  const wanted = listingEntryFor(targetSubfolder, filename);
  return listing.some((n) => normRel(n) === wanted);
}

/**
 * Does the live server list a file with this BASENAME anywhere in the category?
 *
 * Deliberately looser than `liveListingHasEntry`: the manifest's existing-file
 * lookup itself matches a basename anywhere in the served category (a `checkpoints`
 * target satisfied by `checkpoints/sdxl/big.safetensors`), so confirming it with an
 * exact-path check would FAIL legitimate nested installs. This is used only as an
 * ADDITIONAL requirement on the skip path — it can rule a skip out, never in on its
 * own. `undefined` = the server could not answer.
 */
export async function liveListingHasBasename(
  category: string,
  filename: string,
): Promise<boolean | undefined> {
  const listing = await liveCategoryListing(categoryOf(category));
  if (listing === undefined) return undefined;
  const wanted = basename(filename);
  return listing.some((n) => basename(normRel(n)) === wanted);
}

/**
 * Is `absPath` inside a directory tree the CONNECTED server actually reads models
 * from — its primary models root, or a LIVE-registered extra model root (the #633
 * external-drive shape)?
 *
 * `undefined` means UNKNOWN, not "no": the primary root itself could only be
 * resolved from local configuration the running server never vouched for, so
 * containment in it says nothing. Callers must treat unknown as unconfirmed, never
 * as confirmation. Never throws.
 */
export interface LiveRootMembership {
  /** true = inside a tree the server reads; false = demonstrably not; undefined =
   *  only local configuration could answer, so nothing is known. */
  inRoots: boolean | undefined;
  /** The live primary models root this answer was computed against, when it was
   *  live-authoritative. Returned so a caller can STAMP the exact root it checked
   *  rather than taking a second, possibly-later observation (codex gate, r12). */
  liveRoot?: string;
}

export async function isUnderLiveModelRoots(
  absPath: string,
  /** The models CATEGORY the path belongs to. Live extra roots are category-scoped
   *  (`{ category, dir }`), so a `checkpoints` root must never vouch for a LoRA
   *  (codex gate, round 6). Omitted = consider every root. */
  category?: string,
): Promise<LiveRootMembership> {
  /** Canonicalize so a junctioned/symlinked root is compared by where it REALLY
   *  lives. `C:\ComfyUI\models` being a junction to `D:\Models` is a legitimate,
   *  supported layout; a lexical-only compare would call a correctly-placed file
   *  "outside the live roots" and fabricate a failure (codex gate, round 6). */
  const canon = async (p: string): Promise<{ real: string; lex: string; ok: boolean }> => {
    const lex = resolve(p);
    try {
      return { real: resolve(await realpath(p)), lex, ok: true };
    } catch {
      return { real: lex, lex, ok: false }; // not created yet / unreadable
    }
  };
  const target = await canon(absPath);
  const under = (root: { real: string; lex: string }): boolean => {
    const hit = (r: string, t: string): boolean => t === r || t.startsWith(r + sep);
    // Either canonical form matching is enough — only ONE side may be resolvable.
    return (
      hit(root.real, target.real) ||
      hit(root.lex, target.lex) ||
      hit(root.real, target.lex) ||
      hit(root.lex, target.real)
    );
  };

  let dest: Awaited<ReturnType<typeof resolveModelsDirWithBases>>;
  try {
    dest = await resolveModelsDirWithBases();
  } catch {
    return { inRoots: undefined };
  }
  // Same narrowing as the pre-write guard, and for the sharper reason (#369,
  // review): this answer authorizes the POST-write "visible" verdict. An INFERRED
  // root that is actually stale makes the membership test pass against a root the
  // server does not read, and a live listing that names the file for an unrelated
  // reason — the user already had that model — then reads as proof the download
  // landed somewhere the server can see. That is #369's original symptom exactly:
  // reported success, model never appears.
  //
  // Answering UNKNOWN here costs a correct `observed-root` install its confident
  // "visible" and gives it the qualified note instead. That is the right trade:
  // the note names the file, the root, and the remedy, whereas the false positive
  // is silent and the user discovers it at queue time.
  //
  // One exception (#369, the 0.52.1 reports): an extra model root is vouched for by
  // the server's OWN command line when argv carries an ABSOLUTE
  // --extra-model-paths-config — that statement is independent of how the PRIMARY
  // root was derived, and a download redirected onto such a root
  // (resolveModelSubfolderWithLiveRoot) must be able to confirm here, or the file
  // lands exactly where the server reads and is STILL reported unconfirmed. With no
  // argv-named config the extra roots may come from the auto-loaded config beside
  // an INFERRED main.py — that inherits the inference and vouches for nothing, so
  // the early UNKNOWN stands. The unvouched primary still cannot support a
  // NEGATIVE answer below: unknown stays unknown, never "outside the live roots".
  const primaryNamed = modelsDirNamedByServer(dest.source);
  if (
    !primaryNamed &&
    !parseExtraModelPathsConfigsFromArgvRaw(dest.snapshot.argv).some((p) => isAbsolute(p))
  ) {
    return { inRoots: undefined };
  }
  const liveRoot = resolve(dest.modelsDir);

  let extra: Awaited<ReturnType<typeof getLiveExtraModelRoots>> | undefined;
  try {
    extra = await getLiveExtraModelRoots(dest.snapshot);
  } catch {
    extra = undefined;
  }
  const wantCat = (category ?? "").trim().toLowerCase();

  // A negative answer is only honest when everything it rests on could actually be
  // canonicalized; otherwise say UNKNOWN rather than accuse a correct placement.
  let fullyCanonical = target.ok;
  if (primaryNamed) {
    const primary = await canon(dest.modelsDir);
    fullyCanonical = fullyCanonical && primary.ok;
    if (under(primary)) return { inRoots: true, liveRoot };
  }

  if (extra?.authoritative) {
    for (const r of extra.roots) {
      if (wantCat && String(r.category ?? "").trim().toLowerCase() !== wantCat) continue;
      const rc = await canon(r.dir);
      fullyCanonical = fullyCanonical && rc.ok;
      if (under(rc)) return { inRoots: true, liveRoot };
    }
  }
  if (!primaryNamed) return { inRoots: undefined, liveRoot };
  if (!extra) return { inRoots: undefined, liveRoot };
  // The live roots are known and this path is in none of them.
  if (!extra.authoritative) return { inRoots: undefined, liveRoot };
  return { inRoots: fullyCanonical ? false : undefined, liveRoot };
}

/**
 * The models root the connected server reads RIGHT NOW — and ONLY when that answer
 * is LIVE-AUTHORITATIVE. A transient `/system_stats` outage makes the resolver fall
 * back to COMFYUI_PATH, and reporting THAT as "what the server reads now" would
 * downgrade a correctly verified download with a false "a DIFFERENT install"
 * warning (codex gate, round 12). Unknown is the honest answer there. Never throws.
 */
/** Do two absolute models roots name the same directory? Windows paths are
 *  case-insensitive and mix separators, so comparing them raw would report a
 *  server "change" that never happened. */
export function sameModelsRoot(a: string, b: string): boolean {
  const norm = (s: string): string => {
    const slashed = s.replace(/\\/g, "/").replace(/\/+$/, "");
    return platform() === "win32" ? slashed.toLowerCase() : slashed;
  };
  return norm(a) === norm(b);
}

export async function currentLiveModelsRoot(): Promise<string | undefined> {
  try {
    const dest = await resolveModelsDirWithBases();
    if (!isLiveAuthoritativeModelsDir(dest.source)) return undefined;
    return resolve(dest.modelsDir);
  } catch {
    return undefined;
  }
}

/**
 * Why a destination could not be confirmed, and how the USER can upgrade themselves
 * into a verified answer.
 *
 * Saying "unconfirmed" without saying WHY leaves the user with nothing to act on.
 * The running server reported a relative `main.py` with no working directory, so its
 * own report is not enough to pin the install, and the root had to come from
 * somewhere it never named.
 *
 * #1587 — this used to assert a CONJUNCTION as the cause: "...AND the process
 * listening on the ComfyUI port could not be identified". That second half is often
 * FALSE. On ComfyUI Desktop the process is identified — the same session's
 * `install_comfyui(action:"environment")` reports `python_probe_trusted:true` with a
 * process-table PID — and the root is STILL unpinnable, because an interpreter's
 * location is evidence of where the BINARY lives, not of where the server reads
 * (see `modelsDirNamedByServer`, and the measured stale-portable-python shape in
 * #1374). Telling that user their process could not be identified sends them to fix
 * something that is not broken, and "make its process observable" is advice they
 * have already followed.
 *
 * So the reasons are stated as ALTERNATIVES, and the `lsof` gap — real, and worth
 * naming on POSIX — is offered as a possibility to check rather than as a finding.
 */
function unverifiableDestinationRemedy(): string {
  const probe =
    platform() === "win32"
      ? ""
      : " If the process on that port could not be identified at all, that needs `lsof`, " +
        "which is missing on many minimal images — installing it makes future downloads " +
        "verifiable.";
  return (
    "This happens when the running ComfyUI names a RELATIVE main.py with no working " +
    "directory, so its models root has to come from somewhere the server did not name — " +
    "local configuration, or the install tree around the interpreter the OS reports for " +
    "the process on that port (which locates the BINARY, not the models the server " +
    `reads).${probe} To get a definite answer, NAME the root: point COMFYUI_PATH at the ` +
    "ComfyUI that is actually running, or launch it with an absolute --base-directory. " +
    "Meanwhile, confirm with list_local_models."
  );
}

export interface LandedModelVerification {
  /** The path CONFIRMED to exist on disk after the download (symlinks resolved).
   *  This — never the intended path — is what callers report. */
  verifiedPath?: string;
  /** The live models root this verdict was made against. A reader that finds the
   *  CONNECTED server reading a different root must treat the verdict as stale
   *  rather than re-assert it (codex gate, round 11). */
  verifiedAgainstRoot?: string;
  /** Whether the CONNECTED ComfyUI actually lists the landed file. */
  liveVisible: "visible" | "not-visible" | "unknown";
  /** Why, for anything other than a plain "visible". */
  note?: string;
}

/** How many times we re-ask the live server before concluding a landed file is
 *  invisible to it. ComfyUI caches its folder listings and invalidates on the
 *  directory mtime, so the first re-read normally already sees the new file; the
 *  retries only cover a filesystem whose mtime lands a beat late. */
const LIVE_VISIBILITY_ATTEMPTS = 3;
const LIVE_VISIBILITY_RETRY_MS = 1000;

/** What asking the LIVE server whether it can see a Manager-dispatched model
 *  established. Three states, because "the server did not list it" and "the
 *  server could not be asked" are different facts (#796). */
export type ManagerVisibility = "visible" | "not-listed" | "unknown";

/**
 * What the caller established about whether the connected server ALREADY listed
 * this entry before the dispatch started. THREE states, and the third is
 * load-bearing (#1374 review, P1-1).
 *
 * `false` is the only one that licenses crediting a later listing to THIS
 * dispatch. `true` means a same-named file was already there. `"unknown"` means
 * the baseline was never established — the name was not known up front, or the
 * pre-dispatch listing could not be read — and that is NOT the same fact as
 * "was not listed before". Spelling both as `undefined` is what let a
 * PRE-EXISTING file answer "visible" for a dispatch that fetched nothing, which
 * is the #369 trap wearing a Manager's clothes.
 */
export type ListedBeforeBaseline = boolean | "unknown";

/**
 * Ask the CONNECTED server whether it now lists a model a Manager dispatch was
 * supposed to fetch (#1086).
 *
 * `verifyLandedModel` cannot answer this: it stats the local filesystem first and
 * returns `unknown` outright in remote mode, because there is no local file to
 * stat — which is exactly the case a Manager dispatch creates. But the LISTING
 * question is answerable remotely, since `liveListingHasEntry` asks the server.
 *
 * A reporter lost a multi-GB model to this. ComfyUI-Manager picks its own
 * destination root and does not necessarily honour `extra_model_paths`, so their
 * file landed in the install's base models directory — an ephemeral 20GB overlay
 * — while their ComfyUI read from a 100GB volume. Nothing contradicted the
 * "download complete" until a pod restart made the file simply absent.
 *
 * "not-listed" IS NOT FAILURE, and callers must not render it as one. A Manager
 * dispatch returns when the task is ACCEPTED, so a large file is still arriving
 * for minutes afterwards, and "not there yet" and "landed somewhere the server
 * cannot read" are indistinguishable from here. What this does establish is the
 * difference between those two and a CONFIRMED presence, which is the thing the
 * caller previously had no way to learn except by asking by hand.
 *
 * Never throws: a verification hiccup must not turn a transfer into an error.
 */
export async function verifyManagerVisibility(
  targetSubfolder: string,
  filename: string,
  opts?: {
    attempts?: number;
    retryMs?: number;
    /** Tri-state — see ListedBeforeBaseline. OMITTING it is NOT "it was not
     *  there before": an absent baseline is an unknown one, and is treated
     *  exactly like `"unknown"`. Only an explicit `false` licenses a `visible`
     *  verdict. */
    listedBefore?: ListedBeforeBaseline;
    /** The listing probe, injectable so this is testable without a live server.
     *  Defaults to liveListingHasEntry — which a test CANNOT intercept by mocking
     *  the module, because the call below resolves a module-local binding rather
     *  than going through the namespace object. A first draft of the tests for
     *  this function silently queried the developer's real ComfyUI instead. */
    probe?: (subfolder: string, name: string) => Promise<boolean | undefined>;
  },
): Promise<{ visibility: ManagerVisibility; note: string }> {
  const probe = opts?.probe ?? liveListingHasEntry;
  // It was ALREADY listed before the download, so the listing cannot attribute
  // what it sees to this dispatch — a pre-existing file of the same name would
  // read as a successful landing (the same trap verifyLandedModel's `listedBefore`
  // guards on the local path).
  if (opts?.listedBefore === true) {
    return {
      visibility: "unknown",
      note:
        `The connected ComfyUI already listed "${filename}" in ${targetSubfolder} BEFORE this ` +
        `dispatch, so its presence now does not establish that this download landed — it may ` +
        `still be the older file. Compare the file size or hash on the server if that matters.`,
    };
  }
  // #1374 review, P1-1 — AN UNKNOWN BASELINE IS NOT A NEGATIVE ONE.
  //
  // `listedBefore === false` is the ONLY answer that lets a listing seen now be
  // credited to this dispatch. Anything else — an explicit `"unknown"`, or an
  // omitted option — means nobody established what the server listed beforehand,
  // so a hit here is equally consistent with a file that was always there. The
  // previous shape checked only `=== true`, which folded "we could not find out"
  // into "it was not there" and re-opened the #369 trap on the one route that
  // had never had a guard against it.
  //
  // This is NOT short-circuited like the `true` case: a NEGATIVE answer is still
  // worth reporting (and is the #1374 finding), and an unaskable server is still
  // `unknown`. Only the POSITIVE direction is withheld.
  const baselineIsNegative = opts?.listedBefore === false;
  const attempts = Math.max(1, opts?.attempts ?? LIVE_VISIBILITY_ATTEMPTS);
  const retryMs = opts?.retryMs ?? LIVE_VISIBILITY_RETRY_MS;
  let asked = false;
  for (let i = 0; i < attempts; i++) {
    let has: boolean | undefined;
    try {
      has = await probe(targetSubfolder, filename);
    } catch {
      has = undefined; // never throws outward — see the docblock
    }
    if (has === true && !baselineIsNegative) {
      return {
        visibility: "unknown",
        note:
          `The connected ComfyUI lists "${filename}" in ${targetSubfolder} now, but whether it ` +
          `ALREADY listed that name before this dispatch was never established, so the listing ` +
          `cannot be attributed to this download — it may be a pre-existing file of the same ` +
          `name. Compare the file size or hash on the server if that matters.`,
      };
    }
    if (has === true) {
      return {
        visibility: "visible",
        note:
          `The connected ComfyUI now lists ${targetSubfolder}/${filename}, so the dispatch ` +
          `landed somewhere it reads. That is PLACEMENT, not validity: a listing proves a file ` +
          `of that NAME exists, and Manager writes whatever the URL returned under the name you ` +
          `asked for. #473 is exactly this — a CivitAI login page saved as a .safetensors, ` +
          `listed happily, and only discovered when LoraLoader failed to deserialize it. ` +
          `Manager cannot carry this MCP's credentials, so an auth-gated URL is the case to ` +
          `distrust: if the file is implausibly small for its kind (a login page is ~10KB), ` +
          `treat it as failed and re-fetch it locally with COMFYUI_PATH set.`,
      };
    }
    if (has === false) asked = true;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, retryMs));
  }
  if (!asked) {
    return {
      visibility: "unknown",
      note:
        `The connected ComfyUI could not be asked whether it lists ${targetSubfolder}/${filename}, ` +
        `so nothing about this dispatch's destination was established.`,
    };
  }
  return {
    visibility: "not-listed",
    note:
      `The connected ComfyUI does NOT list ${targetSubfolder}/${filename}. That is not proof of ` +
      `failure — a Manager dispatch returns when the task is ACCEPTED, so a large file may still ` +
      `be arriving. But if it does not appear shortly, the file landed somewhere this server does ` +
      `not read: ComfyUI-Manager picks its own destination root and does not necessarily honour ` +
      `extra_model_paths, which on a container is commonly an ephemeral overlay that loses the ` +
      `file on restart. Re-check with list_local_models, and check free space on the install's ` +
      `own models directory rather than your configured model root.`,
  };
}

/**
 * Confirm, AFTER a download lands, that the bytes are (a) really on disk and
 * (b) somewhere the LIVE server reads from — then report the path we actually
 * confirmed. Reporting the INTENDED path is what made #369 a fabricated success:
 * `download_model action:"status"` said "done … landed at <stale install>" while the running
 * ComfyUI could not see the file at all.
 *
 * Never throws: a completed transfer must not be turned into a failure by a
 * verification hiccup. An inconclusive answer is reported as `unknown` with the
 * reason, which callers surface instead of an unqualified success.
 */
export async function verifyLandedModel(
  targetPath: string,
  targetSubfolder: string,
  opts?: {
    attempts?: number;
    retryMs?: number;
    /** Whether the live server ALREADY listed this exact entry BEFORE the download
     *  (liveListingHasEntry, captured by the job before it started). */
    listedBefore?: boolean;
  },
): Promise<LandedModelVerification> {
  let verifiedPath: string | undefined;
  try {
    const info = await stat(targetPath);
    if (!info.isFile()) {
      return {
        liveVisible: "unknown",
        note: `${targetPath} exists but is not a file.`,
      };
    }
    try {
      verifiedPath = resolve(await realpath(targetPath));
    } catch {
      verifiedPath = resolve(targetPath);
    }
  } catch {
    return {
      liveVisible: "unknown",
      note: `The file could not be confirmed on disk at ${targetPath}.`,
    };
  }

  if (isRemoteMode()) {
    return {
      verifiedPath,
      liveVisible: "unknown",
      note: "The connected ComfyUI is remote, so local on-disk placement cannot be checked against it.",
    };
  }

  const category = categoryOf(targetSubfolder);
  // Match the FULL path the server would report relative to the category, not the
  // bare filename: `/models/loras` lists nested entries as "a/foo.safetensors", so a
  // basename comparison would call a download into `loras/a` "visible" because the
  // LIVE tree happens to hold an unrelated `loras/b/foo.safetensors` — a direct
  // false success (codex gate, round 2). Separators are normalized because ComfyUI
  // reports OS-native ones.
  const wanted = listingEntryFor(targetSubfolder, basename(targetPath));
  const attempts = opts?.attempts ?? LIVE_VISIBILITY_ATTEMPTS;
  const retryMs = opts?.retryMs ?? LIVE_VISIBILITY_RETRY_MS;

  // Is the directory we wrote into one the RUNNING server told us about? Only then
  // does "the server lists this name" prove that the bytes we just wrote are the
  // ones it will load. On a locally-configured root a pre-existing entry of the
  // same name in the LIVE tree would otherwise verify our write into a STALE tree
  // as a success (codex gate, round 3) — so a name that was already listed BEFORE
  // the download proves nothing there.
  // Is the file inside a tree the RUNNING server actually reads? `true` makes the
  // listing decisive; `false` means it demonstrably is not (a ComfyUI restart onto
  // a DIFFERENT install between the write and this check produces exactly that —
  // codex gate, round 4); `undefined` means only local configuration could answer,
  // so a pre-existing listing entry proves nothing about OUR bytes.
  const landed = verifiedPath ?? resolve(targetPath);
  // Membership is checked on the LEXICAL write path, not the realpath'd landed
  // path: the server scans `<modelsRoot>/<category>` RECURSIVELY FOLLOWING LINKS
  // (folder_paths.recursive_search walks with followlinks=True), so "this file
  // sits at a path the server walks" is answered by the path as written. Checking
  // the realpath instead called a file landed through an in-tree junction —
  // `models/vae -> E:\StabilityMatrix\models\VAE` (#870), or a nested link like
  // `models/vae/vendor -> ...` — "outside every directory the server reads", a
  // false not-visible for a file the server demonstrably lists. The canonical
  // forms inside still cover a junctioned ROOT (compared by where it really
  // lives), and a host path that merely aliases a container-side root was already
  // vouched lexically whenever no link was involved — this extends that existing,
  // accepted exposure to linked paths rather than adding a new one.
  const membership = await isUnderLiveModelRoots(resolve(targetPath), category);
  const destinationIsLiveAuthoritative = membership.inRoots === true;
  if (membership.inRoots === false) {
    const liveRoot = membership.liveRoot;
    return {
      verifiedPath,
      verifiedAgainstRoot: liveRoot,
      liveVisible: "not-visible",
      note:
        `The file IS on disk at ${landed}, but that is OUTSIDE every directory the ` +
        `connected ComfyUI (${getComfyUIBaseUrl()}) reads models from` +
        (liveRoot ? ` (its models directory is ${liveRoot})` : "") +
        ". This happens when the running server is replaced by a different install " +
        "while a download is in flight. Move the file into the running server's models " +
        "tree, or re-download now that the correct server is connected.",
    };
  }
  // A listing hit only PROVES something about the bytes we just wrote when the
  // directory we wrote to is one the RUNNING server told us it reads. On any other
  // destination the listing describes a tree we cannot tie to this write:
  //   - the name may have been there all along (round 3);
  //   - the pre-write listing may have been unavailable, so "it appeared" is not
  //     established (round 14);
  //   - the server answering AFTER the write may not even be the one that answered
  //     BEFORE it, and its own same-named model then masquerades as ours (round 17).
  // Each of those was a separate route to a fabricated success, and every fix that
  // stopped short of this rule left another. So: a non-authoritative destination is
  // reported HONESTLY as unconfirmed. It costs a noisier message on hosts where the
  // live root cannot be pinned; it never refuses, never fails, and never lies.
  const ambiguous = !destinationIsLiveAuthoritative;

  // A category whose listing contractually contains NO files (`diffusers`, #844)
  // can neither confirm nor deny a landed FILE — its absence from the listing is
  // the contract speaking, not the server. Without this branch the loop below
  // would read that contractual absence as "the server does NOT list it" — the
  // same could-not-determine → determined-not fold as the pre-write refusal,
  // pointed at the user whose download just succeeded.
  if (categoryCannotEnumerateFiles(category)) {
    return {
      verifiedPath,
      liveVisible: "unknown",
      note:
        `The file IS on disk at ${verifiedPath}, but the connected ComfyUI ` +
        `(${getComfyUIBaseUrl()}) cannot confirm it from its model listing: ComfyUI ` +
        `never lists individual files under "${category}" (it loads a "${category}" ` +
        "model as a whole directory, and the endpoint's listing is empty by design), " +
        "so absence there is contractual, not a mismatch. Confirm the model's " +
        "directory is complete on disk.",
    };
  }

  let sawListing = false;
  for (let i = 0; i < attempts; i++) {
    const listing = await liveCategoryListing(category);
    if (listing !== undefined) {
      sawListing = true;
      if (listing.some((n) => normRel(n) === wanted)) {
        // RE-CHECK membership AFTER the listing. The root check and the listing are
        // two separate observations; a ComfyUI restart onto a DIFFERENT install
        // between them would otherwise let the NEW server's own same-named model
        // confirm OUR file, which that server cannot read (codex gate, round 11).
        const still = await isUnderLiveModelRoots(resolve(targetPath), category);
        if (still.inRoots === false) {
          return {
            verifiedPath,
            // Stamp the root THIS check ran against — never a third, later
            // observation, which could name yet another server (codex gate, r12).
            verifiedAgainstRoot: still.liveRoot,
            liveVisible: "not-visible",
            note:
              `The file IS on disk at ${landed}, but the connected ComfyUI ` +
              `(${getComfyUIBaseUrl()}) changed while this was being checked and no longer ` +
              "reads from that location — the entry it lists is its OWN file of the same name. " +
              "Re-download now that the correct server is connected.",
          };
        }
        if (!ambiguous) {
          return {
            verifiedPath,
            // The root the POST-listing membership check just validated against —
            // taking a fresh observation here could stamp a server that replaced it
            // between the two awaits (codex gate, round 12).
            verifiedAgainstRoot: still.liveRoot ?? membership.liveRoot,
            liveVisible: "visible",
          };
        }
        return {
          verifiedPath,
          liveVisible: "unknown",
          note:
            `The connected ComfyUI (${getComfyUIBaseUrl()}) lists "${wanted}" under "${category}", ` +
            "but this destination was not named by the running server — it came from local " +
            "configuration, or was inferred from where the server's interpreter lives — so that " +
            "listing cannot be tied to the file just written to " +
            `${verifiedPath} — it may be the server's own copy elsewhere` +
            (opts?.listedBefore === true
              ? " (it already listed that name before this download)"
              : opts?.listedBefore === undefined
                ? " (whether it listed that name before this download could not be checked)"
                : "") +
            ". " +
            unverifiableDestinationRemedy(),
        };
      }
    }
    if (i < attempts - 1 && retryMs > 0) {
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
  if (!sawListing) {
    return {
      verifiedPath,
      liveVisible: "unknown",
      note:
        `The connected ComfyUI (${getComfyUIBaseUrl()}) did not answer for the ` +
        `"${category}" model folder, so it could not be confirmed that it reads from this location.`,
    };
  }
  // A CORE category's listing enumerates only ComfyUI's own weight extensions
  // (folder_paths.supported_pt_extensions — mirrored above as CORE_MODEL_EXTENSIONS).
  // A landed file of any OTHER type (.gguf, .onnx, .engine, …) is served, if at all,
  // through a custom node's OWN registered category (ComfyUI-GGUF's unet_gguf /
  // clip_gguf views, #526), so its absence from THIS listing is contractual — the
  // #844 diffusers fold one level down: not the category but the FILE'S EXTENSION is
  // outside the enumeration contract. A listing HIT above still confirmed the file
  // (a node may re-register the core category to admit the type); only the MISS is
  // inconclusive, and it must not render as "the server does NOT list it". The
  // 0.51.56 #369 report was exactly that fold: a correctly-placed .gguf answered
  // with WARNING: NOT VISIBLE and a "move the file" remedy for a file that was
  // already where the server reads.
  const ext = extname(basename(targetPath)).toLowerCase();
  const isCoreCategory = (MODEL_SUBDIRS as readonly string[]).includes(category.toLowerCase());
  if (isCoreCategory && !CORE_MODEL_EXTENSIONS.has(ext)) {
    return {
      verifiedPath,
      liveVisible: "unknown",
      note:
        `The file IS on disk at ${verifiedPath}, but the connected ComfyUI ` +
        `(${getComfyUIBaseUrl()}) cannot confirm it from its "${category}" listing: that ` +
        `endpoint enumerates only ComfyUI's core weight extensions ` +
        `(${[...CORE_MODEL_EXTENSIONS].join(", ")}), and "${ext || "(none)"}" is not one ` +
        `of them. A file of this type is served through a custom node's own registered ` +
        `category instead (for .gguf, ComfyUI-GGUF's "unet_gguf"/"clip_gguf" views), so ` +
        `its ABSENCE here is contractual, not evidence of misplacement. Confirm with ` +
        `list_local_models, which reads those categories too — and if no installed node ` +
        `registers a category serving this file type, this server cannot load it at all.`,
    };
  }
  // #369 (0.52.1 recurrence) — RESOLVE THE ROOT **WITH** ITS PROVENANCE.
  //
  // This used to call `resolveModelsDir()`, which reports the models dir whatever
  // its `source` — including `configured-base`, the one value a reachable server
  // never vouched for. The verdict below then compared the landed path against it
  // and, finding the file inside, told the user the connected ComfyUI READS that
  // directory. But that root is the very one this download chose, so the file is
  // inside it BY CONSTRUCTION: the comparison is true for a correct destination and
  // for a stale second install alike, and cannot tell them apart. On the reporter's
  // macOS Comfy Desktop pair (two installs under ~/ComfyUI-Installs, the live one
  // reached through extra_model_paths) that produced "it is in the right place …
  // Do NOT move the file" for ~25 GB written where the running server never looks.
  //
  // So the SOURCE travels with the path, and only a server-NAMED root licenses the
  // claim. `modelsDirNamedByServer` — not `isLiveAuthoritativeModelsDir` — because
  // an `observed-root` is INFERRED from where the interpreter lives and is exactly
  // the inference that lands on the wrong install (#1562).
  let liveModelsDir: string | undefined;
  let liveModelsDirNamedByServer = false;
  try {
    const dest = await resolveModelsDirWithBases();
    liveModelsDir = dest.modelsDir;
    liveModelsDirNamedByServer = modelsDirNamedByServer(dest.source);
  } catch {
    liveModelsDir = undefined;
    liveModelsDirNamedByServer = false;
  }
  return {
    verifiedPath,
    ...notVisibleVerdict({
      verifiedPath,
      liveModelsDir,
      liveModelsDirNamedByServer,
      wanted,
      category,
      baseUrl: getComfyUIBaseUrl(),
      // The membership answer above was computed on the LEXICAL write path and is
      // canonical-aware: a destination reached through an in-tree junction
      // (StabilityMatrix, #870) realpaths OUTSIDE the lexical live root, so the
      // verdict's own path comparison would call a correctly-placed file
      // misplaced and prescribe moving it (#369, 0.51.56).
      knownInsideLiveRoots: membership.inRoots === true,
    }),
  };
}

/**
 * The verdict for a file that is on disk but absent from the live listing (#1131).
 *
 * "Not listed" has THREE causes, and the first two take OPPOSITE remedies:
 *
 *   INSIDE a root the SERVER NAMED — not misplaced. The server simply has not
 *     re-read that folder yet: ComfyUI caches its loader option lists and
 *     invalidates them on the directory's mtime, so a check this soon after the
 *     write routinely races it. Telling that user to "move the file into the
 *     running server's models tree" names a directory the file is ALREADY in — a
 *     remedy that cannot be followed, which is what #1131's reporter received.
 *
 *   OUTSIDE that root — genuinely in the wrong place. Move it.
 *
 *   INSIDE a root NOBODY VOUCHED FOR — unknown, and it must be SAID (#369, the
 *     0.52.1 recurrence). This third state used to be folded into the first,
 *     because the containment test ran against whatever `resolveModelsDir()`
 *     returned — including a `configured-base`/`observed-root` value the running
 *     server never named. That root is the one the download itself resolved to, so
 *     the landed file is inside it BY CONSTRUCTION and the test answers "inside"
 *     for a correct destination and a stale second install alike. It is the same
 *     shape as #1603: two states, one indistinguishable answer, and no way to say
 *     "unknown". The reporter's macOS Comfy Desktop pair got "so it is in the right
 *     place … Do NOT move the file" for ~25 GB written into an install the running
 *     server (reached through extra_model_paths) never reads.
 *
 * The unverified branch is deliberately NOT the move remedy either: refusing to
 * assert readership is not evidence of misplacement, and #1131's harm was exactly
 * an unfollowable move instruction. It states both candidates, orders them by
 * likelihood, and names the ONE check that separates them.
 *
 * The DECISION lives here rather than at the call site so it is covered by the
 * same tests as the wording; a branch chosen upstream and passed in as a boolean
 * would be exactly the untested wiring this repo keeps getting caught by.
 */
export function notVisibleVerdict(args: {
  verifiedPath: string;
  liveModelsDir: string | undefined;
  wanted: string;
  category: string;
  baseUrl: string;
  /** The caller's CANONICAL membership answer for the lexical write path
   *  (isUnderLiveModelRoots). true means the file sits in a tree the server reads
   *  even when the REALPATH'd verifiedPath escapes the lexical root — a
   *  StabilityMatrix junction (`models/vae` → the shared store, #870) realpaths
   *  outside it, and comparing paths alone would prescribe moving a file that is
   *  already in the right place (#369). */
  knownInsideLiveRoots?: boolean;
  /** Did the RUNNING SERVER ITSELF name `liveModelsDir` (`modelsDirNamedByServer`
   *  — its own `--models-directory`/`--base-directory`/argv `main.py` root), or did
   *  it come from local configuration / an inference the server never vouched for?
   *  Only the former licenses "the connected ComfyUI reads this directory": the
   *  path comparison below is against the root THIS DOWNLOAD CHOSE, so it is true
   *  by construction and cannot distinguish a correct destination from a stale
   *  install (#369). Omitted ⇒ NOT named, because an unstated provenance is an
   *  unknown one. */
  liveModelsDirNamedByServer?: boolean;
}): { liveVisible: "not-visible"; note: string } {
  const { verifiedPath, liveModelsDir, wanted, category, baseUrl } = args;
  const insideLexically = liveModelsDir !== undefined && isUnderRoot(verifiedPath, liveModelsDir);
  const rootIsServerNamed = args.liveModelsDirNamedByServer === true;
  // Containment ALONE is not readership. It counts only when the root it is
  // measured against came from the server (`rootIsServerNamed`), or when the
  // caller's canonical membership answer — which applies that same narrowing
  // itself, and additionally covers live extra roots and in-tree junctions —
  // already said yes.
  const insideLiveRoot = (insideLexically && rootIsServerNamed) || args.knownInsideLiveRoots === true;
  // On disk under the root we resolved, with nothing establishing that the server
  // reads it. Neither remedy is earned; say so, and name the check that decides.
  const insideUnverifiedRoot = insideLexically && !insideLiveRoot;
  if (insideUnverifiedRoot) {
    return {
      liveVisible: "not-visible",
      note:
        `The file IS on disk at ${verifiedPath}, inside ${liveModelsDir} — the models root this ` +
        `download resolved to. Whether the connected ComfyUI (${baseUrl}) READS that root is ` +
        `UNCONFIRMED: the running server never named its own models directory, so this root came ` +
        `from local configuration (COMFYUI_PATH / the saved default workspace) or was inferred ` +
        `from where the server's interpreter lives — and the file is inside it either way, ` +
        `because that is the root the download picked. That server does not list "${wanted}" ` +
        `under "${category}".\n\n` +
        `TWO very different things produce exactly this, and only one is a problem:\n` +
        `  1. a STALE LISTING — ComfyUI caches its loader options and invalidates them on the ` +
        `directory's mtime, so a check this soon after a write routinely races it; or\n` +
        `  2. a DIFFERENT INSTALL — the bytes are in a models tree the running server never ` +
        `scans, which is #369 and is how multi-GB downloads get reported as landed and are ` +
        `never seen again.\n\n` +
        `Do not move it on the strength of this message alone, and do not treat it as placed ` +
        `either. SEPARATE THE TWO: refresh the node/model definitions — install_comfyui ` +
        `(action:"refresh_nodes"), or the panel's refresh — then re-check with list_local_models. ` +
        `If it STILL does not appear, it is case 2: list_local_models (action:"list_paths") ` +
        `reports the roots the running server actually reads — move the file into the one for ` +
        `"${category}". To make future downloads verifiable, point COMFYUI_PATH at the install ` +
        `that is actually running, or launch it with an absolute --base-directory.`,
    };
  }
  return {
    // Still not VISIBLE — we did not observe it in the listing, and #369 exists
    // because an unobserved placement must not render as confirmed. The verdict
    // is unchanged; what changes is the explanation and the remedy.
    liveVisible: "not-visible",
    note: insideLiveRoot
      ? // The lexical phrasing NAMES the directory as one the server reads, so it may
        // only be used when the SERVER named that directory. Otherwise the membership
        // answer is what vouched for the placement (an extra root / a junction), and
        // the wording that does not attribute the root is the honest one.
        (insideLexically && rootIsServerNamed
          ? `The file IS on disk at ${verifiedPath}, which is INSIDE the models directory the ` +
            `connected ComfyUI reads (${liveModelsDir}) — so it is in the right place. `
          : `The file IS on disk at ${verifiedPath}, which is inside a models tree the ` +
            `connected ComfyUI reads — reached through a link/junction` +
            `${liveModelsDir ? ` under ${liveModelsDir}` : ""}, so its real path lying ` +
            `outside that directory is the layout working as intended, not a misplacement. `) +
        `That server does not list "${wanted}" under "${category}" YET, which almost always ` +
        `means its cached loader options have not been re-read since the write (ComfyUI ` +
        `invalidates them on the directory's mtime). Do NOT move the file. Refresh the ` +
        `node/model definitions — install_comfyui (action:"refresh_nodes"), or the panel's ` +
        `refresh — or restart ComfyUI, then check list_local_models again.`
      : `The file IS on disk at ${verifiedPath}, but the connected ComfyUI ` +
        `(${baseUrl}) does NOT list "${wanted}" under "${category}" — it will not be ` +
        `usable in a workflow from there.` +
        // Same rule as above: name it as WHAT THE SERVER READS only when the server
        // named it. An unvouched root is still worth printing — it is where the
        // bytes are — but as the destination this download resolved to, not as a
        // fact about the server (#369).
        (liveModelsDir
          ? rootIsServerNamed
            ? ` The models directory that server reads is ${liveModelsDir}.`
            : ` This download resolved its destination root to ${liveModelsDir} from local ` +
              `configuration — the running server never named its own models directory, so that ` +
              `is not a confirmed answer for where the file belongs; list_local_models ` +
              `(action:"list_paths") reports the roots it actually reads.`
          : "") +
        " Move the file into the running server's models tree (or point COMFYUI_PATH at that install and re-download).",
  };
}

/**
 * Is `file` inside `root`? Compared on NORMALIZED paths (#1131).
 *
 * Windows mixes separators and is case-insensitive, so `C:\ComfyUI\models` and
 * `c:/comfyui/models` name the same directory — comparing raw strings would call
 * a correctly-placed file misplaced and print the "move it there" remedy for a
 * file already there. The boundary check requires a separator so `…/models2`
 * never counts as inside `…/models`.
 */
export function isUnderRoot(
  file: string,
  root: string,
  platform: string = process.platform,
): boolean {
  const norm = (s: string): string => {
    const slashed = s.replace(/\\/g, "/").replace(/\/+$/, "");
    return platform === "win32" ? slashed.toLowerCase() : slashed;
  };
  const f = norm(file);
  const r = norm(root);
  return f === r || f.startsWith(`${r}/`);
}

/**
 * Like resolveModelSubfolder, but roots the destination at the CONNECTED
 * server's real models directory (its `--base-directory`/models, read from
 * /system_stats argv) rather than blindly at `<COMFYUI_PATH>/models`. On a
 * ComfyUI Desktop install those diverge, so a download rooted at COMFYUI_PATH
 * lands somewhere the live server never reads — reported success, model
 * invisible (issues #346/#369). Falls back to `<COMFYUI_PATH>/models` when the
 * server is unreachable or was not launched with `--base-directory`. Applies the
 * same containment guard as the sync variant.
 */
export async function resolveModelSubfolderPreferServer(
  targetSubfolder: string,
): Promise<string> {
  return (await resolveModelSubfolderWithLiveRoot(targetSubfolder)).targetDir;
}

/**
 * As `resolveModelSubfolderPreferServer`, but also returns the LIVE models root that
 * THIS resolution used — when it was live-authoritative.
 *
 * The writer must bind its destination to the server the destination was computed
 * for. Taking a separate observation afterwards leaves a window in which the server
 * is replaced BETWEEN the resolution and the capture, so both later observations
 * agree with each other while the target still points into the previous install
 * (codex gate, round 18). Returning it from the same call closes that window.
 */
export async function resolveModelSubfolderWithLiveRoot(
  targetSubfolder: string,
): Promise<{ targetDir: string; liveRootAtResolve?: string }> {
  const raw = (targetSubfolder ?? "").trim();
  if (!raw) {
    throw new ModelError("target_subfolder is required (e.g. 'loras', 'checkpoints').");
  }
  if (isAbsolute(raw)) {
    throw new ModelError(
      `target_subfolder must be relative to models/, not absolute: ${raw}`,
    );
  }
  // ONE /system_stats call yields the models dir, the base-install dirs the
  // code-root veto needs, AND the snapshot the escape-authorizer uses — so they can
  // never disagree (a second stats call could straddle a server restart and combine
  // model roots from server B with code bases from server A; #633 codex).
  // The category is passed so the #851 inventory rescue can corroborate the folder this
  // download actually writes into. A sibling category's match would not establish it.
  //
  // Derived from the NORMALIZED subfolder, not the raw string: `target_subfolder` accepts
  // equivalent spellings, and `loras/../checkpoints` writes to `checkpoints` while its
  // raw first segment is `loras`. Taking the raw one would corroborate `loras`, whose
  // listing may well match, and authorize a `checkpoints` destination nothing vouched
  // for — the sibling-category hole re-opened through a spelling. An escaping form gets
  // an empty category (so no rescue can happen); the containment check just below is
  // what refuses it.
  const normalizedSub = normalize(raw);
  const escapes =
    normalizedSub === ".." ||
    normalizedSub.startsWith(`..${sep}`) ||
    normalizedSub.startsWith("../");
  const { modelsDir, baseDirs, snapshot, source } = await resolveModelsDirWithBases({
    targetCategory: escapes ? "" : categoryOf(normalizedSub),
  });
  let modelsRoot = resolve(modelsDir);
  let targetDir = resolve(modelsRoot, raw);
  if (targetDir !== modelsRoot && !targetDir.startsWith(modelsRoot + sep)) {
    throw new ModelError(`Refusing to write outside the models directory: ${raw}`);
  }
  // #369 (the 0.52.1 reports) — a root the SERVER NAMED beats our best inference.
  //
  // When the primary root came from local configuration or from an INFERRED live
  // root, every guard below can do no better than fail OPEN on an empty tree
  // (#1147's deliberate trade: an empty listing contradicts nothing), so a stale
  // second install received the write whenever its evidence was silent — the
  // 0.52.1 reports had gigabytes land in the non-running install while the
  // connected Desktop server's models lived in the shared root its
  // --extra-model-paths-config declares (the very root list_paths shows).
  //
  // That config flag is the server's OWN command line naming a root it reads this
  // category from — a statement, not an inference — so it outranks the unvouched
  // primary and the download goes THERE instead. The gate is deliberately the
  // exact evidence: an ABSOLUTE --extra-model-paths-config in argv (a relative
  // one cannot be located from this process and fails closed, per extra-paths),
  // an AUTHORITATIVE read of it, and a MODEL category (never custom_nodes — a
  // download must not become a Python import). Anything less keeps the existing
  // resolution and its corroboration guards untouched.
  const serverNamedPrimary = modelsDirNamedByServer(source);
  let redirectedToExtraRoot = false;
  if (!serverNamedPrimary && snapshot.reachable && !isRemoteMode()) {
    const category = categoryOf(normalizedSub).toLowerCase();
    const argvNamesConfig = parseExtraModelPathsConfigsFromArgvRaw(snapshot.argv).some(
      (p) => isAbsolute(p),
    );
    if (argvNamesConfig && category && !NON_MODEL_EXTRA_CATEGORIES.has(category)) {
      const extra = await getLiveExtraModelRoots(snapshot);
      const namedRoot = extra.authoritative
        ? extra.roots.find((r) => r.category.trim().toLowerCase() === category)
        : undefined;
      if (namedRoot) {
        const extraRoot = resolve(namedRoot.dir);
        const redirected = resolve(extraRoot, subfolderRemainder(normalizedSub));
        if (redirected !== extraRoot && !redirected.startsWith(extraRoot + sep)) {
          throw new ModelError(`Refusing to write outside the models directory: ${raw}`);
        }
        logger.info(
          `Downloading into the extra model root the connected server named for "${category}" ` +
            `(${extraRoot}) instead of the unvouched primary root (${modelsRoot}) — the root the ` +
            `server's --extra-model-paths-config declares is where it actually reads (#369).`,
        );
        modelsRoot = extraRoot;
        targetDir = redirected;
        redirectedToExtraRoot = true;
      }
    }
  }
  if (!redirectedToExtraRoot) {
    // The root did NOT come from the running server (it could not tell us where it
    // lives, so we fell back to local config). Before writing, check the one thing
    // that can still expose a stale-install destination: the server's own listing for
    // this category. #369 shipped 4.88 GB into a directory the live ComfyUI had never
    // heard of; refusing here costs nothing and saves the transfer. (A server-named
    // primary is not skipped here either — the guard itself decides, because a named
    // root that does not EXIST locally, e.g. a container-side --models-directory,
    // still gets the cheap check. Only the REDIRECTED destination is exempt: the
    // server's own config named it, so disagreeing with our inference is moot.)
    await assertDestinationVisibleToLiveServer(modelsRoot, raw, source, snapshot);
  }
  // Path-string containment (above) is not enough: an EXISTING symlink somewhere
  // between modelsRoot and targetDir could redirect the real write OUTSIDE the
  // models dir. Because THIS resolver is the single canonical write-target for
  // every local download (startDownloadJob keying AND downloadModel's write), the
  // guard belongs here — co-located with the resolution the write actually uses —
  // so it can never diverge from a caller's separate pre-validation (e.g.
  // apply_manifest resolving the root a second time; #490 codex review). Runs on
  // the REDIRECTED root too: its code-root veto is what keeps a malicious or
  // miswritten extra-paths entry from turning this into a write into custom_nodes.
  await assertNoEscapingSymlinkAncestor(modelsRoot, targetDir, raw, baseDirs, snapshot);
  return {
    targetDir,
    // A redirected destination is bound to the EXTRA root, but the writer's
    // mid-flight swap check compares PRIMARY roots (currentLiveModelsRoot), so
    // there is no honest value to bind here — leave it unknown, exactly like any
    // other non-server-named primary. The post-write check still verifies the
    // landed file against the connected server.
    liveRootAtResolve:
      !redirectedToExtraRoot && isLiveAuthoritativeModelsDir(source) ? modelsRoot : undefined,
  };
}

/**
 * Enforce that a local model download can ONLY land where the running ComfyUI
 * actually reads model WEIGHTS — never in a directory it imports Python from.
 * Applied to the resolved write target BEFORE any mkdir/write.
 *
 * The veto set is built from the running server's OWN configuration and canonical
 * (realpath-collapsed) so it matches by real on-disk location regardless of mounts:
 *   • codeRoots (VETO, inclusive/over-veto) — the dirs ComfyUI IMPORTS PYTHON from
 *     (`custom_nodes`): each base-install dir's `custom_nodes` (from the base dirs
 *     the caller derived from the SAME /system_stats call), the models-root sibling,
 *     and every `custom_nodes`-category extra root (live AND static). A download
 *     must NEVER land inside one — that is arbitrary CODE execution, not a model
 *     install — so this is checked by RESOLVED REAL PATH, not category label, and
 *     it wins even when a model category also claims the same physical dir.
 *
 * A symlink/junction INSIDE the models tree may redirect the write anywhere that
 * veto does not cover (#870 — this SUPERSEDES the #633-era "only a live-registered
 * extra root authorizes an escape" rule, codex P0d). The redirect is a physical
 * fixture of the user's own models directory — placed there by the user or their
 * launcher — and ComfyUI's own scanner FOLLOWS directory symlinks
 * (`folder_paths.recursive_search` walks with `followlinks=True`), so a write
 * through one lands where the server actually reads. The earlier rule could never
 * authorize the mainstream StabilityMatrix layout: it junctions each shared model
 * folder (`models/vae` → `E:\comfy\StabilityMatrix\models\VAE`) and registers
 * NOTHING — the junction IS the registration, so no live-root lookup can vouch
 * for the target, and requiring one refused a correct install (a
 * could-not-determine → determined-not fold, pointed at refusal). An exotic
 * redirect that lands somewhere the server does not list is not hidden: the
 * post-write check (verifyLandedModel) reports it honestly.
 *
 * Hardening invariants (codex P0a/P0b):
 *   - The PRIMARY models root itself is code-root-vetoed: if it canonicalizes into
 *     a `custom_nodes` dir (e.g. `--models-directory <base>/custom_nodes`, or a
 *     models junction into custom_nodes), EVERY write is refused — the primary root
 *     is never blanket-exempt.
 *   - A path segment that EXISTS as a symlink but whose target cannot be
 *     canonicalized (dangling / circular / unreadable) is REJECTED — never treated
 *     as an absent segment (which would let a later recursive mkdir FOLLOW the link
 *     out of every root). Only a genuinely-absent segment (ENOENT/ENOTDIR from
 *     lstat) is safe to skip; any other lstat error fails closed.
 *   - An escaping symlink whose REAL target falls under a code root is REJECTED —
 *     the in-tree authorization above never extends to a directory ComfyUI imports
 *     Python from.
 *
 * ACCEPTED RESIDUAL (P0c — TOCTOU): this is a pathname-time check. The Node runtime
 * has no `openat`/per-segment `O_NOFOLLOW` traversal, so a LOCAL process that can
 * replace an accepted directory/symlink AFTER this check but BEFORE the writer's
 * mkdir/rename could still redirect the write. This race is inherent to pathname
 * validation (it affects any accepted path, symlinked or not). It is ACCEPTED as a
 * non-blocker: this runs on the user's OWN single-user machine, so a
 * concurrently-racing local process is out of scope (maintainer ruling —
 * "downloads should go where the user wants; it's their computer"). We deliberately
 * do NOT reject symlinked/external destinations to defend against it — that would
 * break the legitimate #633 external-drive and #870 StabilityMatrix use cases.
 * The refusals this guard DOES make are the ACCIDENTAL-corruption ones only: a
 * dangling/unresolvable escape (P0a) and a write into a code dir / custom_nodes
 * (P0b). Fully eliminating the race would require trusted directory-handle
 * traversal (native support) and is out of scope.
 */
async function assertNoEscapingSymlinkAncestor(
  root: string,
  target: string,
  label: string,
  /** Candidate ComfyUI base-install dirs, derived by the CALLER from the SAME
   *  /system_stats call that resolved the models dir (resolveModelsDirWithBases).
   *  The code-root veto derives `<base>/custom_nodes` from these — threaded in
   *  rather than re-fetched here so it can never disagree with the models dir a
   *  divergent --models-directory produced (fail-open race; #633 codex round 4). */
  baseInstallDirs: string[] = [],
  /** The SAME /system_stats snapshot the models/base dirs came from — its live
   *  extra roots feed the code-root VETO (a live-registered custom_nodes dir is
   *  refused as a destination), so the veto reflects ONE consistent server state
   *  (codex inter-snapshot race). Since #870 it no longer AUTHORIZES anything:
   *  an in-tree symlink's redirect is authorized by its location, not by config. */
  liveSnapshot: LiveServerSnapshot = { reachable: false },
): Promise<void> {
  // Canonical root: if the models dir is itself a symlink/junction, resolve it so
  // descendants are checked against where it REALLY lives (not the lexical path).
  // The ROOT itself must be inspected too (P0): a DANGLING primary `models` symlink
  // would otherwise pass (realpath fails → treated as "not created") and the
  // recursive write would follow it OUT of every root — a normal user's broken
  // models symlink escaping. lstat the root FIRST: allow only a genuinely-absent
  // (ENOENT) root; reject a symlinked root whose realpath fails; fail closed on any
  // other lstat error.
  let realRoot: string;
  try {
    const rootInfo = await lstat(root);
    try {
      realRoot = resolve(await realpath(root));
    } catch {
      if (rootInfo.isSymbolicLink()) {
        throw new ModelError(
          `Refusing to write through a models-directory symlink that cannot be resolved (dangling or circular): ${label}`,
        );
      }
      // A non-symlink dir whose realpath raced away — treat as absent; the writer
      // recreates it inside the lexical root.
      realRoot = resolve(root);
    }
  } catch (err) {
    if (err instanceof ModelError) throw err;
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      realRoot = resolve(root); // root not yet created — lexical containment only.
    } else {
      throw new ModelError(
        `Refusing to resolve the models directory safely (${code ?? "unreadable"}): ${label}`,
      );
    }
  }
  const canon = async (d: string): Promise<string> => {
    try {
      return resolve(await realpath(d));
    } catch {
      return resolve(d); // not yet created — compare lexically
    }
  };
  const underAny = (real: string, roots: string[]): boolean =>
    roots.some((r) => real === r || real.startsWith(r + sep));

  // Build the CODE roots (veto) EAGERLY — the code veto must also cover the
  // primary root (P0b), so it can't be deferred to an escape.
  const baseDirSet = new Set<string>([
    dirname(realRoot),
    ...baseInstallDirs.map((b) => resolve(b)),
  ]);
  const codeRoots: string[] = [];
  for (const b of baseDirSet) codeRoots.push(await canon(join(b, "custom_nodes")));
  const isCodeCategory = (cat: string): boolean =>
    NON_MODEL_EXTRA_CATEGORIES.has(cat.trim().toLowerCase());
  // Static extra roots contribute to the VETO only (over-veto is always safe): any
  // custom_nodes dir the static config knows about is refused as a destination.
  let staticExtra: Awaited<ReturnType<typeof getExtraModelRoots>> = [];
  try {
    staticExtra = await getExtraModelRoots();
  } catch {
    staticExtra = [];
  }
  for (const er of staticExtra) {
    if (isCodeCategory(er.category)) codeRoots.push(await canon(er.dir));
  }
  // LIVE, server-authoritative roots contribute their custom_nodes to the VETO.
  // Self-derived from the live /system_stats snapshot (the launched
  // --extra-model-paths-config files + the live install's own extra_model_paths.yaml)
  // — NEVER a stale local workspace config. They no longer form an ALLOW list
  // (#870): an in-tree symlink redirect is authorized by sitting inside the user's
  // own models tree, not by appearing in a server-declared root set (a
  // StabilityMatrix junction target is declared nowhere).
  let live: Awaited<ReturnType<typeof getLiveExtraModelRoots>> = {
    authoritative: false,
    roots: [],
  };
  try {
    live = await getLiveExtraModelRoots(liveSnapshot);
  } catch {
    live = { authoritative: false, roots: [] };
  }
  for (const er of live.roots) {
    if (isCodeCategory(er.category)) codeRoots.push(await canon(er.dir));
  }

  const isUnderCode = (real: string): boolean => underAny(real, codeRoots);

  // P0b: the PRIMARY models root must not itself resolve into a code directory
  // (e.g. `--models-directory <base>/custom_nodes`, or a models junction into
  // custom_nodes) — otherwise a plain download (no symlink) writes into a dir
  // ComfyUI imports = RCE. Refuse ALL writes in that case.
  if (isUnderCode(realRoot)) {
    throw new ModelError(
      `Refusing to write into a ComfyUI code directory (the models root resolves inside custom_nodes): ${label}`,
    );
  }

  // Walk descendants only: from target up to (but NOT including) root.
  let cursor = target;
  while (cursor !== root && cursor.startsWith(root + sep)) {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(cursor);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // Only a GENUINELY-absent segment is safe to skip (the writer creates it
      // inside root). Any other lstat failure (EACCES/EIO/ELOOP/…) fails closed —
      // we must not proceed to mkdir past a segment we couldn't inspect (P0a).
      if (code === "ENOENT" || code === "ENOTDIR") {
        const parent = dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
        continue;
      }
      throw new ModelError(
        `Refusing to resolve the download path safely (${code ?? "unreadable segment"}): ${label}`,
      );
    }
    if (info.isSymbolicLink()) {
      let real: string;
      try {
        real = resolve(await realpath(cursor));
      } catch {
        // P0a: the segment IS a symlink but its target can't be canonicalized
        // (dangling / circular / unreadable). Treating it as absent would let the
        // recursive mkdir FOLLOW it OUT of every root. Reject — never proceed.
        throw new ModelError(
          `Refusing to write through a symlink that cannot be resolved (dangling or circular): ${label}`,
        );
      }
      // The segment is a symlink/junction INSIDE the models tree (every cursor in
      // this walk is under the root by construction). Wherever it points, the
      // redirect is a fixture of the user's own models directory and ComfyUI's
      // scanner follows it (recursive_search walks with followlinks=True) — so the
      // write stays where the server reads. This is the StabilityMatrix layout
      // (#870): junctioned category folders whose targets no config declares. The
      // ONLY remaining refusal is a landing inside a CODE root — a model download
      // must never become a Python import.
      if (isUnderCode(real)) {
        throw new ModelError(
          `Refusing to write through a symlink that resolves into a ComfyUI code directory (custom_nodes): ${label}`,
        );
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

export interface ResolvedDownloadTarget {
  /** Absolute resolved destination directory (server-preferred models dir + subfolder). */
  targetDir: string;
  /** Validated bare filename (basename, no separators). */
  filename: string;
  /** Absolute final path the file is written to: join(targetDir, filename). */
  targetPath: string;
  /** The LIVE models root THIS resolution used, when live-authoritative. The writer
   *  binds to it so the bytes cannot start in a tree the server stopped reading
   *  between the resolution and the write (codex gate, round 18). */
  liveRootAtResolve?: string;
}

/**
 * The SINGLE source of truth for a model download's final on-disk destination,
 * shared by downloadModel (the writer) AND the background job registry (which
 * keys jobs by this canonical `targetPath`, so any two requests that resolve to
 * the SAME file are one writer, and invalid inputs are rejected up front exactly
 * as the write would reject them). Extracted so the two can never drift.
 *
 * Resolution: server-preferred models dir + subfolder via
 * resolveModelSubfolderPreferServer (which TRIMS the subfolder, collapses
 * "."/"..", and containment-guards against escapes/absolute paths), then the
 * filename rule — an OMITTED filename derives from the URL pathname basename
 * (→ "model.safetensors" fallback); ANY DEFINED filename is taken as its
 * basename and REJECTED if it contained a path separator, or is blank / "." /
 * "..". Throws ModelError on an invalid subfolder or filename.
 */
export async function resolveDownloadTarget(
  url: string,
  targetSubfolder: string,
  filename?: string,
): Promise<ResolvedDownloadTarget> {
  const { targetDir, liveRootAtResolve } =
    await resolveModelSubfolderWithLiveRoot(targetSubfolder);
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
  const targetPath = join(targetDir, resolvedFilename);
  if (!resolve(targetPath).startsWith(resolve(targetDir) + sep)) {
    throw new ModelError(
      "Refusing to write outside the target model directory.",
      { filename: rawFilename },
    );
  }
  // #1371 — a stale COMFYUI_PATH wrote a model into a DIFFERENT local install than the
  // one serving the session. There is deliberately NO divergent-install refusal in THIS
  // function anymore. The one added for this issue took a SECOND, fresh server
  // observation here (isUnderLiveModelRoots re-resolved the models dir), and nothing
  // pinned the server across that await. Characterization tests (#1550) measured the
  // result: in the steady state — one server, both observations agreeing — the branch
  // could never fire, because a source that admits the guard (the destination did NOT
  // come from the server) can never be one that answers it (the evidence bails unless
  // the server NAMED the root); it fired only when the server changed mid-resolution,
  // i.e. it judged the destination against a DIFFERENT server than the one that
  // produced it. Nondeterministic exactly where it was needed, unsound where it fired.
  //
  // The coverage for this report is instead deterministic and lives with the SINGLE
  // resolution that produced targetDir, so the destination and the evidence can never
  // come from two different observations of the server:
  //   - resolveModelsDirWithBases REFUSES a configured base the server's own listing
  //     positively contradicts (output-dir.ts, "DO NOT WRITE INTO A BASE THE SERVER
  //     DEMONSTRABLY DOES NOT READ"), and refuses an unanchorable relative-main.py
  //     server outright unless the base corroborates it;
  //   - assertDestinationVisibleToLiveServer (same snapshot) refuses the #369
  //     signature — a POPULATED on-disk category the live listing does not account
  //     for;
  //   - the writer binds to liveRootAtResolve and re-checks currentLiveModelsRoot
  //     before any bytes move, so a mid-flight server swap is refused when both roots
  //     are server-named;
  //   - verifyLandedModel confirms the landed file against the connected server AFTER
  //     the write, so any residual wrong destination is reported, never a silent
  //     success.
  // What remains unguardable BY DESIGN: the server's root is known but not on this
  // filesystem (Docker / port-forward / remote mount), where COMFYUI_PATH may
  // legitimately be the mapped host path. No local evidence can distinguish that from
  // a stale install, and the maintainer ruling is to proceed with the existing
  // unconfirmed-visibility disclosure rather than refuse a correct setup.
  return { targetDir, filename: resolvedFilename, targetPath, liveRootAtResolve };
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
        "workspace (action:\"set_default\").",
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

  // #1474 — say WHY only these roots were searched. `list_paths` may display roots
  // this resolver refused to enumerate (it backs DELETION, so it uses only roots
  // provable from the running server's launch arguments), and the caller was left
  // holding two tools that disagreed with nothing to reconcile them.
  throw new ModelError(
    modelNotFoundMessage({ relativePath, searched }),
    { path: relativePath, searched },
  );
}

/**
 * The auth HEADERS the LOCAL download path would apply for `url` — explicit auth first,
 * else the auto HuggingFace/CivitAI host-token injection. MIRRORS the header build in
 * `downloadModel`'s local streaming path (kept in sync with it) and is used ONLY by the
 * #473 remote flip probe: a credentialed fetch that turns a non-model response into a real
 * model proves the URL is authentication-gated (the exact bug — a local token Manager can
 * never receive). Returns `{}` when no credential applies (a public/anonymous URL).
 */
function localAuthHeadersFor(
  url: string,
  auth: DownloadAuth | undefined,
  /** Whether the ORIGINAL (pre-HF_ENDPOINT-rewrite) url was a huggingface.co url — threaded
   *  from downloadModel so an HF_ENDPOINT mirror still gets the token (mirrors the local
   *  streaming path; without it a rewritten url would parse to the mirror host and drop the
   *  token → a false-negative). */
  wasHfUrl: boolean,
): Record<string, string> {
  const request = applyDownloadAuth(url, auth);
  const headers: Record<string, string> = { ...request.headers };
  // HF token: attach ONLY when the url's PARSED hostname is huggingface.co (or a subdomain),
  // or the ORIGINAL url was a HF url that HF_ENDPOINT rewrote to a trusted mirror. NEVER a
  // substring match (see isHuggingFaceHost). isCivitaiUrl is likewise hostname-parsed, so
  // the CivitAI branch is safe by construction.
  const hfToken = config.huggingfaceToken;
  const civitaiToken = config.civitaiApiToken;
  if (!auth && hfToken && (wasHfUrl || isHuggingFaceHost(url))) {
    headers["Authorization"] = `Bearer ${hfToken}`;
  } else if (!auth && civitaiToken && isCivitaiUrl(url)) {
    headers["Authorization"] = `Bearer ${civitaiToken}`;
  }
  return headers;
}

/**
 * #1567 (item 3) — the resumable `.partial` a LOCAL writer for `url` would pick up
 * if the download were re-issued RIGHT NOW, or null when none is found.
 *
 * The bare-URL `findResumablePartial(url)` reproduces the writer's staged name only
 * for an UNAUTHENTICATED download: the cache identity folds in the representation
 * headers (#467 P1-2), and the common gated case — a CivitAI/HuggingFace token from
 * the environment, exactly the #1567 reporter's setup — sends one, so its partial
 * is staged under a name the bare URL never produces and the plain lookup reports
 * "no partial" for gigabytes that are sitting on disk.
 *
 * This wrapper rebuilds the request the local streaming path would make TODAY —
 * the same HF_ENDPOINT rewrite and the same env-credential header block
 * `downloadModel` applies, through the same `localAuthHeadersFor` definition, so
 * the lookup and the writer cannot drift apart — and stats the partial under THAT
 * identity. Explicit per-request auth (and cloud credentials) are deliberately NOT
 * reproducible here: a job record keeps no credential, so those partials miss, and
 * a miss means "none found under the identity a re-issue would use now", never
 * "none exists".
 */
export async function findResumablePartialForLocalDownload(
  url: string,
): Promise<{ path: string; bytes: number } | null> {
  const wasHfUrl = /^https?:\/\/huggingface\.co([/?#]|$)/i.test(url);
  const rewritten = applyHfEndpoint(url);
  return findResumablePartial(rewritten, localAuthHeadersFor(rewritten, undefined, wasHfUrl));
}

/**
 * #1086 — what a Manager dispatch does NOT establish.
 *
 * This used to end with "the file lists under /models when complete", which is a
 * PREDICTION, not an observation, and it was wrong for the reporter: ComfyUI-Manager
 * installed into the container base root (/opt/ComfyUI/models) while the server READ
 * models from /workspace/models via extra_model_paths. The file never listed, the
 * 20 GB overlay was discarded on pod restart, and a multi-GB model was lost — after
 * we had reported the transfer as proceeding to a destination we never checked.
 *
 * We cannot fix the destination from here: extra_model_paths.yaml lives on the
 * TARGET filesystem, and for a remote install this process cannot read it. What we
 * can stop doing is asserting where the bytes will land.
 *
 * NAMES THE CHECK, not just the risk. "Verify it yourself" without saying how is a
 * dead end; list_local_models reads through the SAME roots the server reads, so a
 * file that appears there is genuinely reachable by a workflow.
 */
/**
 * The destination ComfyUI-Manager LOGGED for `filename`, read back from
 * `/internal/logs` (#1086).
 *
 * The standing caveat says we cannot know where a Manager dispatch lands, because
 * `extra_model_paths.yaml` lives on the target filesystem. That is true of the
 * CONFIG — and the reporter's own evidence shows it is not true of the OUTCOME.
 * Manager announces the absolute path it picked, in both generations:
 *
 *   glob/manager_server.py:1063  f"Install model '{name}' from '{url}' into '{path}'"
 *   legacy/manager_server.py:634 (identical)
 *
 * which is how they discovered their Wan 2.2 file had gone to
 * `/opt/ComfyUI/models` while the server read `/workspace/models` — a 20GB overlay
 * that discarded it on the next pod restart.
 *
 * So the destination is unknowable only until we look. This looks.
 *
 * Returns undefined when the log could not be read OR carried no such line —
 * DELIBERATELY not distinguished here, because the caller's remedy is identical
 * (fall back to the caveat) and inventing a distinction the caller cannot act on
 * would be noise. What must never happen is an unread log rendering as a
 * destination, which is why undefined is the only other answer.
 *
 * Matches the LAST occurrence: a filename can be installed more than once in a
 * session, and the newest line is the dispatch we just made.
 */
/**
 * Are these two absolute paths written in the SAME path syntax? (#1086, codex review)
 *
 * A destination read from the REMOTE server's log is in that host's syntax, while
 * a root resolved here has been through node's `resolve()` — which on Windows
 * turns "/workspace/models" into "C:\workspace\models". Comparing across that
 * boundary always answers OUTSIDE, for a destination that may be exactly right,
 * and a false OUTSIDE is the dangerous direction: it cries wolf about a good file
 * and contradicts a LISTED verdict in the same message.
 *
 * Deliberately crude — POSIX-absolute vs drive-letter is the only distinction that
 * matters here, and anything it cannot classify is treated as incomparable rather
 * than guessed.
 */
/**
 * The extra_model_paths directories the LIVE server reads, or undefined when that
 * could not be established (#1086, codex review).
 *
 * Undefined is load-bearing: "we could not read the extra roots" must not render
 * as "there are none", which would let a destination under a perfectly good extra
 * root be reported as unusable.
 */
async function liveExtraRootDirs(): Promise<string[] | undefined> {
  try {
    const snapshot = await resolveModelsDirWithBases();
    const live = await getLiveExtraModelRoots(snapshot.snapshot);
    if (!live.authoritative) return undefined;
    return live.roots.map((r) => r.dir).filter((d): d is string => typeof d === "string");
  } catch {
    return undefined;
  }
}

function samePathDomain(a: string, b: string): boolean {
  const kind = (p: string): "posix" | "win32" | "unknown" => {
    if (/^[A-Za-z]:[\/]/.test(p)) return "win32";
    if (p.startsWith("\\\\")) return "win32"; // UNC
    if (p.startsWith("/")) return "posix";
    return "unknown";
  };
  const ka = kind(a);
  const kb = kind(b);
  return ka !== "unknown" && ka === kb;
}

/**
 * The FILENAME a Manager dispatch actually used, from a finished job (#1086,
 * codex review).
 *
 * `job.filename` is OPTIONAL — a URL-only download never sets it — and the
 * fallback in use was `job.path.split(/[\/]/).pop()`. For a Manager dispatch
 * `job.path` is not a path at all; it is
 *
 *     "checkpoints/foo.safetensors (dispatched to the remote ComfyUI via …)"
 *
 * so that fallback returned the whole descriptive tail. Every consumer then
 * searched for a filename that cannot match anything: the destination read below
 * misses, and `verifyManagerVisibility` — which used the identical fallback long
 * before this change — probed a name the server could never list, quietly turning
 * every URL-only Manager download into an unverifiable one.
 *
 * Take the leading "<subfolder>/<filename>" that descriptor is built from,
 * stopping at the " (" the note begins with.
 */
export function managerJobFilename(job: {
  filename?: string;
  path?: string;
}): string {
  if (job.filename) return job.filename;
  const head = (job.path ?? "").split(" (")[0];
  return head.split(/[\/]/).pop() ?? "";
}

export function parseManagerInstallDestination(
  logText: string,
  filename: string,
): string | undefined {
  if (!logText || !filename) return undefined;
  // The name is interpolated into the line inside single quotes, so match it as a
  // whole quoted token — a bare substring would let `clip_vision_h.safetensors`
  // be matched by a line about `clip_vision_h.safetensors.part`.
  const esc = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`Install model '${esc}' from '[^']*' into '([^']+)'`, "g");
  let last: string | undefined;
  for (const m of logText.matchAll(re)) last = m[1];
  return last;
}

/**
 * Read the live server's log and report where Manager said it put `filename`,
 * plus whether that is inside the models root the server actually reads (#1086).
 *
 * Never throws: this runs after a transfer, and a diagnostic that cannot be
 * gathered must not turn a completed dispatch into an error.
 */
export async function describeManagerDestination(
  filename: string,
  opts?: {
    /** Injectable so this is testable without a live server. */
    readLog?: () => Promise<string | undefined>;
    liveModelsDir?: string | undefined;
    /** The server's extra_model_paths roots, or undefined when they could not be
     *  established. Injectable for tests; defaults to the live read. */
    extraRoots?: () => Promise<string[] | undefined>;
  },
): Promise<string | undefined> {
  let text: string | undefined;
  try {
    // getLogs() already carries the reconnect-and-retry a Manager reboot needs
    // (#399) — a restart is exactly what precedes many of these reads.
    text =
      opts?.readLog !== undefined
        ? await opts.readLog()
        : (await getLogs()).join("\n");
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  const dest = parseManagerInstallDestination(text, filename);
  if (!dest) return undefined;

  const root = opts?.liveModelsDir;
  // #1086 (codex review, PR #1190) — ONLY compare when the comparison is
  // trustworthy, and the two ways it is not are both dangerous in the SAME
  // direction: a false OUTSIDE cries wolf about a file that is fine, and
  // contradicts a LISTED verdict sitting in the same message.
  //
  //  - PATH DOMAIN. `dest` comes from the REMOTE server's log, so it is that
  //    host's path syntax. `currentLiveModelsRoot()` runs its value through
  //    node's `resolve()`, which on a WINDOWS orchestrator turns the remote
  //    "/workspace/models" into "C:\workspace\models". Comparing those two
  //    always says OUTSIDE — for a destination that is exactly right.
  //  - EXTRA ROOTS. This compares one PRIMARY root, while a server can read
  //    several. A destination under a legitimately-registered extra root would
  //    be reported as unusable while `verifyManagerVisibility` lists it.
  //
  // So the INSIDE/OUTSIDE verdict is asserted only when the domains agree, and
  // an OUTSIDE reading also has to survive the extra roots. Anything else falls
  // back to locating the file WITHOUT judging it — which is still far more than
  // the old "we cannot know where this lands".
  if (root !== undefined && !samePathDomain(dest, root)) {
    return (
      `ComfyUI-Manager reported writing it to ${dest}. That path is on the ComfyUI ` +
      `host and could not be compared with the models directory known here ` +
      `(${root}) — they are written in different path syntaxes, so no INSIDE/OUTSIDE ` +
      `verdict is claimed. Check list_local_models to confirm the server can read it.`
    );
  }
  if (root === undefined) {
    // We know WHERE, but not whether that is a place the server reads — and the
    // second half is the one that decides whether the file is usable. Say the
    // first without implying the second.
    return (
      `ComfyUI-Manager reported writing it to ${dest}. Whether that path is one the ` +
      `connected server reads could not be established from here, so this locates the ` +
      `file without confirming it is usable — check list_local_models.`
    );
  }
  if (isUnderRoot(dest, root)) {
    return (
      `ComfyUI-Manager reported writing it to ${dest}, which is INSIDE the models ` +
      `directory that server reads (${root}).`
    );
  }
  // An OUTSIDE reading has to survive the EXTRA roots before it is asserted: a
  // server reads more than one tree, and a destination under a registered extra
  // root is fine. Unreadable extra roots mean we cannot rule that out, so the
  // verdict is withheld rather than guessed — the same three-state discipline as
  // everywhere else here.
  const extra = await (opts?.extraRoots !== undefined
    ? opts.extraRoots()
    : liveExtraRootDirs());
  if (extra === undefined) {
    return (
      `ComfyUI-Manager reported writing it to ${dest}, which is not under the primary ` +
      `models directory the connected server reads (${root}). Whether that server also ` +
      `reads it through an extra_model_paths entry could NOT be checked from here, so ` +
      `this is not being called unusable — confirm with list_local_models.`
    );
  }
  if (extra.some((r) => typeof r === "string" && isUnderRoot(dest, r))) {
    return (
      `ComfyUI-Manager reported writing it to ${dest}, which is outside the primary ` +
      `models directory (${root}) but INSIDE an extra_model_paths root that server ` +
      `reads — so it is reachable.`
    );
  }
  return (
    `⚠ ComfyUI-Manager reported writing it to ${dest}, which is OUTSIDE the models ` +
    `directory the connected server reads (${root}) — so a workflow there will NOT see ` +
    `it. This is the extra_model_paths case: Manager picks its own destination root ` +
    `and does not necessarily honour that config. On a container the base models ` +
    `directory is commonly an EPHEMERAL OVERLAY, which discards the file on the next ` +
    `restart — move it into ${root} now, or re-download with COMFYUI_PATH set so this ` +
    `MCP streams it to a destination it controls.`
  );
}

export function managerDestinationCaveat(): string {
  return (
    "ComfyUI-Manager chooses the destination root itself and does not necessarily honour " +
    "extra_model_paths — so this has NOT established where the file lands. Confirm with " +
    "list_local_models before relying on it. A model that never appears there was written " +
    "somewhere the server does not read, commonly the install's base models directory; on a " +
    "container that is often an ephemeral overlay, which loses the file on restart."
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
  signal?: AbortSignal,
  /** Whether the ORIGINAL url (before any HF_ENDPOINT rewrite the caller applied) was a
   *  huggingface.co url — threaded to the #473 flip probe's credential derivation so an
   *  HF_ENDPOINT mirror still gets the HF token (matches the local streaming path). */
  wasHfUrl = false,
): Promise<string> {
  // Cancelled before we dispatched — do not hand the fetch to the remote Manager at all.
  if (signal?.aborted) throw new DOMException("The download was cancelled.", "AbortError");
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

  // #473 remote residual. The MCP cannot fully close this on the remote path: a server-side
  // Manager fetch can't carry our auth headers, the MCP never sees the landed bytes, and
  // there is no remote primitive to sniff, size, or delete the file afterward — so a
  // login-gated URL makes Manager save an HTML/JSON auth page under the `.safetensors` name
  // and report its queue task "done", a corrupt "model" under a false success. (The
  // authoritative fix is a host-side authenticated transport — the MCP-to-panel streamed
  // upload the issue scopes — tracked separately.)
  //
  // What the MCP CAN do here WITHOUT ever wrongly blocking a legitimate download: detect,
  // with HIGH CONFIDENCE, that the URL is AUTHENTICATION-GATED and warn LOUDLY, so a
  // dispatched auth/login page is never silently mistaken for a real model. Proof is a
  // credential FLIP: an unauthenticated fetch (what Manager does) returns a non-model
  // auth/error page, but the SAME url fetched WITH the credential the local path would
  // apply (which Manager can NEVER receive) returns a real model — IP-independent evidence
  // of token gating, the exact reported bug. We deliberately DO NOT refuse the dispatch:
  // the ComfyUI host fetches from a DIFFERENT network vantage and could still succeed
  // (e.g. an IP allowlist the MCP isn't on), so a hard refusal from the MCP's vantage
  // could block a download that would actually work. A prominent warning that never blocks
  // is the safe ceiling of what the MCP can assert remotely.
  const modelExt = extname(resolvedFilename).toLowerCase();
  const probe = await probeRemoteModelPayload(dispatchUrl, modelExt, signal, {
    // The auth the LOCAL path would apply — used ONLY to prove auth-gating via a credential
    // flip; Manager can never receive these headers. Derived from `url` (pre-query-fold) so
    // host detection (civitai/hf) matches the local streaming path. `wasHfUrl` preserves the
    // pre-HF_ENDPOINT-rewrite HF identity so a mirror still gets the token.
    authHeaders: localAuthHeadersFor(url, auth, wasHfUrl),
  });
  if (signal?.aborted) throw new DOMException("The download was cancelled.", "AbortError");
  if (probe.verdict === "non-model") {
    const what =
      probe.kind === "html"
        ? "an HTML page (a login/authentication or error page)"
        : probe.kind === "json"
          ? "a JSON document (an API error or auth challenge)"
          : "an authentication/error response";
    let host = "";
    try {
      host = new URL(dispatchUrl).hostname;
    } catch {
      /* host is only used to tailor the remediation hint */
    }
    const isCivitai = /(^|\.)civitai\.com$/i.test(host);
    const remediation = isCivitai
      ? `set CIVITAI_API_TOKEN on the ComfyUI HOST (the MCP's locally-configured token is ` +
        `NOT forwarded to a remote ComfyUI-Manager), or download to a LOCAL ComfyUI where the ` +
        `token is applied and the payload is validated on disk`
      : `configure the credential on the ComfyUI host, or download to a LOCAL ComfyUI where the ` +
        `credential is applied and the payload is validated on disk`;
    // #473 — REFUSE, do not dispatch. The probe has PROVEN the gate: the same URL
    // returns a login/error page unauthenticated and a real model with the
    // credential, and Manager fetches server-side without our headers. Dispatching
    // anyway is knowingly writing a corrupt file under the caller's chosen
    // filename — it then LISTS as a model and fails much later inside a loader
    // ("header too large" / "Expecting value"), which is how this issue was
    // reported three times.
    //
    // Owner's call (2026-08-08) after weighing the false-refusal risk: a ComfyUI
    // HOST that carries its OWN token would have succeeded, and is now blocked.
    // That case is speculative, has two documented ways out (below), and fails
    // LOUDLY at the point of the request; the corrupt-file case is real,
    // recurring, and fails silently hours later on someone else's canvas.
    logger.warn(
      "Refusing an authentication-gated model dispatch to ComfyUI-Manager (it cannot carry our credentials)",
      { url: redactUrlForLogs(dispatchUrl, sensitiveParams), filename: resolvedFilename },
    );
    throw new ModelError(
      `Refusing to dispatch "${resolvedFilename}" to ComfyUI-Manager: this URL is ` +
        `AUTHENTICATION-GATED. An unauthenticated fetch returns ${what}, while the SAME URL ` +
        `fetched WITH the configured credential returns a real model — and ComfyUI-Manager ` +
        `fetches server-side and cannot carry this MCP's auth headers. It would therefore save ` +
        `that auth/error page under "${resolvedFilename}" as a CORRUPT model, which lists ` +
        `normally and only fails later at load time ("header too large" / "Expecting value"). ` +
        `NOTHING was downloaded and nothing was written. To download it, ${remediation}.`,
      { url: redactUrlForLogs(dispatchUrl, sensitiveParams), filename: resolvedFilename },
    );
  }

  logger.info("Dispatching model install to remote ComfyUI via ComfyUI-Manager", {
    url: redactUrlForLogs(dispatchUrl, sensitiveParams),
    type: managerType,
    save_path: managerSavePath,
    filename: resolvedFilename,
  });

  try {
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
  } catch (err) {
    // #1374 — the ONLY failure entitled to the route explanation: Manager was contacted
    // and Manager is what failed. Scoped to this call rather than the whole function
    // because everything above it — target resolution, the remote payload preflight — can
    // fail for reasons unrelated to the route. The first version wrapped the lot and
    // matched on error text; the preflight's own auth-gated refusal mentions
    // ComfyUI-Manager, so it was misattributed anyway. A flag at the call site cannot be
    // fooled by prose.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    const why = await explainManagerDownloadRoute();
    if (!why) throw err;
    const raw = err instanceof Error ? err.message : String(err);
    throw new ModelError(`${raw}

WHY THIS WENT THROUGH ComfyUI-Manager AT ALL: ${why}`, {
      url,
    });
  }

  // Cancelled while the dispatch was in flight (#515): the local job is cancelled.
  // We CAN'T recall a Manager queue task, so the host may keep fetching — but this
  // must NOT be reported as a completed local download. Throw so the job records
  // "cancelled" (the tool message notes the server may still be fetching).
  if (signal?.aborted) throw new DOMException("The download was cancelled.", "AbortError");

  // #947 — "the REMOTE ComfyUI" is not what this decision established. The route
  // is chosen by shouldDispatchDownloadToManager(), which sends work to the
  // Manager whenever it cannot resolve a local models directory to stream into —
  // and a LOOPBACK server does that routinely: no COMFYUI_PATH, no saved
  // workspace, and a `python main.py` argv whose root cannot be derived.
  //
  // A reporter on http://127.0.0.1:8188 was told their download went "to the
  // remote ComfyUI", concluded the orchestrator had misclassified a local server,
  // and filed against the classification. isRemoteMode() was right the whole
  // time; the SENTENCE was wrong. Say what was actually decided, and name the
  // setting that would have kept the download local.
  const routeNote = isRemoteMode()
    ? "dispatched to the remote ComfyUI via ComfyUI-Manager"
    : "dispatched to the connected ComfyUI via ComfyUI-Manager — this MCP could not resolve a " +
      "local models directory to stream into (no COMFYUI_PATH, no saved workspace, and the " +
      "running server's launch arguments did not identify one). That is a routing fallback, NOT " +
      "a claim that the server is remote; set COMFYUI_PATH to stream directly instead";
  return `${normalizedSubfolder}/${resolvedFilename} (${routeNote} — download continues server-side. ${managerDestinationCaveat()})${authWarning}`;
}

/**
 * Decide whether a model download must be handed to the CONNECTED ComfyUI's
 * ComfyUI-Manager (a server-side fetch) instead of being streamed to local disk.
 *
 * Returns true when:
 *   - REMOTE mode — there is no local filesystem at all (the original behavior); OR
 *   - we are NOMINALLY LOCAL (loopback target) but have NO resolvable local base:
 *     COMFYUI_PATH is unset — or was LOST across a panel/orchestrator reconnect
 *     (#420) — and no default workspace is saved, AND the connected server did not
 *     advertise a discoverable `--base-directory` to stream into, YET a live server
 *     IS reachable to accept a Manager dispatch. This is exactly the reconnect
 *     failure in #420: the previous session downloaded fine, the reconnect dropped
 *     the effective base, and the local path then threw "no local ComfyUI path
 *     configured" instead of routing through the still-connected Manager (the same
 *     route list_local_models keeps using over HTTP). #418 fixed base resolution
 *     at START; this keeps downloads working when the base goes missing LATER.
 *
 * Stays LOCAL (false) whenever a local base is resolvable (resolveEffectiveComfyUIBase)
 * OR the server reports a base/models dir we can write to directly; also false when
 * no server is reachable, so the local resolver surfaces its clear, actionable error
 * rather than silently succeeding.
 */
/**
 * WHY a download went to ComfyUI-Manager, reported as CURRENT STATE (#1374).
 *
 * The reporter's LOCAL install could not download at all: every attempt died on
 * "ComfyUI-Manager's queue API is not reachable", for a capability that needs no Manager.
 * That error is raised in generic Manager code which cannot know it is serving a download,
 * so it named the thing that BROKE and not the decision that made Manager necessary --
 * this MCP could not work out where the connected server keeps its models. Only the second
 * has a remedy the user can apply.
 *
 * FOUR REVIEW ROUNDS WENT INTO A MESSAGE, and every one found the same shape of fault: a
 * diagnostic claiming to narrate the routing DECISION while reading state that might not
 * be the state that decision was made from. A second /system_stats read could describe a
 * different server. A process-global record of the first read could be overwritten by a
 * concurrent download. Stamping the target closed the simple overwrite but not an
 * A -> B -> A retarget.
 *
 * Each fix made the window smaller instead of closing it, so what changes here is the
 * CLAIM. This reports the state as it is now and says so. It cannot be stale, because it
 * no longer asserts it was ever anything else -- and the argv/cwd a reporter needs in
 * order to say which case they hit is exactly as useful either way.
 */
export async function explainManagerDownloadRoute(): Promise<string> {
  if (isRemoteMode()) {
    return (
      "This MCP is in REMOTE mode (--comfyui-url) RIGHT NOW, so downloads are dispatched " +
      "to the connected ComfyUI's Manager by design -- there is no local models directory " +
      "to stream into. Manager must be installed and enabled on that host. (Current state: " +
      "if the target was changed since this download started, it may not be why this one " +
      "took that route.)"
    );
  }
  let argv: string[] | undefined;
  let cwd: string | undefined;
  try {
    const stats = await getSystemStats();
    argv = (stats as { system?: { argv?: string[] } })?.system?.argv;
    cwd = (stats as { system?: { cwd?: string } })?.system?.cwd;
  } catch {
    // Nothing observed now. Say nothing rather than guess why the route was taken.
    return "";
  }
  // Rendered RAW rather than JSON.stringify'd: a Windows argv comes back with doubled
  // backslashes, in the one line that exists to be pasted into a bug report.
  const detail =
    `Reading the connected server NOW: argv[0]=${argv?.[0] ?? "(none)"} and ` +
    `cwd=${cwd ?? "(not reported)"}. (Current state -- if the server was restarted or ` +
    `retargeted since this download started, it may not be what the routing decision saw.)`;
  if (hasUnresolvableRelativeModelDirFlag(argv, cwd)) {
    return (
      `Your ComfyUI was started with a RELATIVE --base-directory/--models-directory and did ` +
      `not report its working directory, so this MCP cannot tell where its models actually ` +
      `live -- writing locally would put the file somewhere the server never reads. ${detail} ` +
      `FIX: restart ComfyUI with an ABSOLUTE --base-directory, or set COMFYUI_PATH to the ` +
      `install root, and a local download will stream directly with no Manager involved.`
    );
  }
  const liveRoot = resolveLiveServerRoot(argv, cwd, { remote: false });
  if (liveRoot.root && !existsSync(liveRoot.root)) {
    return (
      `The connected ComfyUI reports its install root as ${liveRoot.root}, which does not ` +
      `exist on THIS machine -- it is a container-side or remote path (a Docker/SSH-forwarded ` +
      `loopback server looks local but is not). Writing there would create a bogus directory ` +
      `instead of reaching the server, so the fetch is handed to its Manager. ${detail} ` +
      `FIX: enable Manager on that host, or run this MCP where the models directory really is.`
    );
  }
  return (
    `This MCP could not resolve where the connected ComfyUI keeps its models, so it handed ` +
    `the fetch to that server's Manager instead of streaming locally. ${detail} ` +
    `FIX: set COMFYUI_PATH to the ComfyUI install root (the directory containing main.py) -- ` +
    `a local download then streams directly and needs no Manager. Please include this whole ` +
    `paragraph if you report it (#1374): the argv/cwd above is what identifies which case ` +
    `this is.`
  );
}

export async function shouldDispatchDownloadToManager(): Promise<boolean> {
  if (isRemoteMode()) return true;
  try {
    const stats = await getSystemStats();
    const argv = (stats as { system?: { argv?: string[] } })?.system?.argv;
    const cwd = (stats as { system?: { cwd?: string } })?.system?.cwd;
    // Ask the LIVE server FIRST. A server launched with a RELATIVE
    // --base-directory/--models-directory that did NOT report its cwd has an UNKNOWN
    // real models dir: any local guess (COMFYUI_PATH or the main.py root) would be
    // the WRONG place it never reads (#346). Route such a download through the
    // server's Manager (server-side write, lands correctly) rather than writing
    // locally or hard-failing. This MUST win over the COMFYUI_PATH / main.py-root
    // local short-circuits below (codex — it was previously skipped when a local
    // base was configured).
    if (hasUnresolvableRelativeModelDirFlag(argv, cwd)) return true;
    // Resolvable. A configured/auto-detected COMFYUI_PATH or saved default workspace
    // → stream local.
    if (resolveEffectiveComfyUIBase()) return false;
    // Reachable server: stream locally when it exposes a base/models dir we can
    // write to (--base-directory/--models-directory) OR when we can derive its own
    // install root from argv (its main.py path) — the SAME live-first root the
    // downloader writes into (resolveModelsDir). Keeping this in lockstep with
    // resolveModelsDir is what lets a panel-connected local server with no
    // COMFYUI_PATH stream models into its live install (#463) instead of bouncing
    // through the Manager (which then fails when Manager isn't installed). Only
    // dispatch to the Manager when NEITHER is discoverable (#420 reconnect with an
    // opaque/relative argv we can't resolve).
    if (parseModelsDirFromArgv(argv, cwd)) return false;
    // Derive the server's own install root through the ONE canonical resolver — the
    // SAME notion resolveModelsDirWithBases writes into, so this predicate can never
    // disagree with the destination (#369). It covers the relative-`main.py`-no-cwd
    // shape (Desktop / Windows portable) that the old argv-only check could not
    // resolve, which needlessly bounced those installs through the Manager (and then
    // failed outright when Manager isn't installed). Only treat the root as a LOCAL
    // stream target when it ACTUALLY EXISTS on this filesystem: a loopback ComfyUI
    // inside Docker / behind an SSH port-forward reports a container-side path that
    // is NOT the host's, so writing there would create a bogus host directory
    // instead of reaching the server. When it isn't locally present, hand the fetch
    // to the connected Manager (server-side write), which lands correctly regardless.
    const liveRoot = resolveLiveServerRoot(argv, cwd, { remote: false }).root;
    if (liveRoot && existsSync(liveRoot)) return false;
    return true;
  } catch {
    // No reachable server → nothing to dispatch to. A configured local base still
    // streams local; otherwise let the local resolver surface its clear error.
    return false;
  }
}

export async function downloadModel(
  url: string,
  targetSubfolder: string,
  filename?: string,
  auth?: DownloadAuth,
  /**
   * The ALREADY-DECIDED route (Manager vs local disk). startDownloadJob computes
   * shouldDispatchDownloadToManager() ONCE to key the job identity, then threads
   * that same decision here so the writer can never diverge from the key — a
   * reconnect/reachability flip BETWEEN two evaluations would otherwise split the
   * job (Manager-key + local-writer, or a duplicate job) (#420 codex round 1).
   * Omitted by direct callers (the download_model tool path without a job), which
   * evaluate the predicate themselves.
   */
  dispatchToManager?: boolean,
  /** Sink for the resume decision, threaded from the job so the outcome is stored
   *  on that job (#467). Omitted by direct callers (no job to report to). */
  onResume?: ResumeReporter,
  /** Per-download abort signal, threaded from the job's AbortController into the
   *  fetch + stream pipeline so download_model action:"cancel" aborts exactly this transfer (#515).
   *  Omitted by direct callers (no cancellation handle). */
  signal?: AbortSignal,
  /** Reports the ACTUAL progress-tray id (a hash of the post-auth/post-HF-rewrite
   *  request URL) back to the job, so the job's trayId matches the id the streaming
   *  and done rows are written under. Without it a query-auth or HF_ENDPOINT-rewritten
   *  download's tray row is keyed differently from the job's original-URL trayId — so
   *  download_model action:"status" byte display AND cancel cleanup would target the wrong id. Called
   *  only on the LOCAL streaming path (the Manager path writes no streaming rows). */
  onTrayId?: (trayId: string) => void,
  /** Fired the instant the completed, validated file is renamed into its destination
   *  (#515) — so the job can commit "done" with NO window where the file exists but the
   *  job still reads "downloading". Local paths only (the remote Manager dispatch has no
   *  local rename; the caller commits done when this function returns). */
  onLanded?: (targetPath: string) => void,
): Promise<string> {
  // Cancelled before we did anything — never start a transfer (local OR server-side).
  if (signal?.aborted) throw new DOMException("The download was cancelled.", "AbortError");
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
  // Use the route the caller already decided (job path), else evaluate it now
  // (direct callers). Never re-evaluate when a decision was threaded in — that is
  // the split-brain guard: the writer must follow the SAME route the job id was
  // keyed on, even if reachability/base config flipped since (#420 codex round 1).
  const routeToManager =
    dispatchToManager ?? (await shouldDispatchDownloadToManager());
  if (routeToManager) {
    // Thread the PRE-rewrite HF identity so the flip probe's credential derivation keeps the
    // HF token flowing to an HF_ENDPOINT mirror (matches the local path below).
    // The route explanation lives INSIDE the dispatch (see downloadModelViaManagerRemote),
    // where a flag records whether Manager was actually contacted. Matching on error text
    // from out here could not tell a Manager failure from a preflight refusal that happens
    // to mention Manager.
    return await downloadModelViaManagerRemote(url, targetSubfolder, filename, auth, signal, wasHfUrl);
  }

  // Root the destination at the LIVE server's models dir (its --base-directory),
  // not blindly at COMFYUI_PATH/models — otherwise a Desktop install downloads
  // into a stale checkout the running server never reads (#346/#369). Resolution
  // + filename validation go through the SHARED resolveDownloadTarget so the
  // background job registry keys jobs by the exact same targetPath.
  //
  // DELIBERATE: this RE-RESOLVES rather than reusing the target startDownloadJob
  // keyed on. If the live server was replaced in between (a restart onto the same
  // port serving a DIFFERENT install), the freshly resolved root is the one the
  // server now reads, and the stale key is the one that would put the file where
  // nobody looks — so the CURRENT destination wins over a stable key. `onLanded`
  // reports the real path back to the job, and verifyLandedModel confirms it, so
  // nothing is ever reported at the stale path. Accepted residual (disclosed):
  // across such a restart the job's serialization key can name the previous
  // destination, so a concurrent same-file request may run a duplicate transfer.
  // That is bounded by the existing per-writer O_EXCL temp + atomic rename (#467) —
  // a duplicate download, never a corrupt file — and is strictly preferable to
  // writing into an install the server no longer serves.
  const {
    targetDir,
    targetPath,
    filename: resolvedFilename,
    // BIND the destination to the server it was resolved for. Re-resolving is right,
    // but the answer must not go stale between resolving it and writing: a ComfyUI
    // replaced during the mkdir would otherwise take the bytes into the root the
    // PREVIOUS server read. This root comes from the SAME resolution that produced
    // targetPath — capturing it separately afterwards would leave a window in which
    // the swap happens BEFORE the capture, so both later observations agree while the
    // target still points into the old install (codex gate, round 18). Both roots
    // must be live-authoritative to compare; when either is unknown there is nothing
    // to bind, and the (already never-confirmed) non-authoritative path applies.
    liveRootAtResolve: rootAtResolve,
  } = await resolveDownloadTarget(url, targetSubfolder, filename);

  // Ensure target directory exists
  await mkdir(targetDir, { recursive: true });

  const rootBeforeWrite = await currentLiveModelsRoot();
  if (rootAtResolve && rootBeforeWrite && !sameModelsRoot(rootAtResolve, rootBeforeWrite)) {
    throw new ModelError(
      `Refusing to start this download: the connected ComfyUI changed while the destination was ` +
        `being prepared. It read "${rootAtResolve}" when the destination was resolved and reads ` +
        `"${rootBeforeWrite}" now, so "${targetPath}" is no longer where the running server ` +
        "looks. Re-issue the download now that the current server is connected.",
    );
  }

  const request = applyDownloadAuth(url, auth);
  const headers: Record<string, string> = { ...request.headers };
  // HF token: attach ONLY when the url's PARSED hostname is huggingface.co (or a subdomain),
  // or the ORIGINAL url was a HF url that HF_ENDPOINT rewrote to a trusted mirror (wasHfUrl).
  // NEVER a substring match — `https://evil.example/m.safetensors?ref=huggingface.co` parses
  // to evil.example and must get NO token (a credential-leak; the same parsed-host authority
  // the remote flip probe uses).
  const hfToken = config.huggingfaceToken;
  const civitaiToken = config.civitaiApiToken;
  if (!auth && hfToken && (wasHfUrl || isHuggingFaceHost(url))) {
    headers["Authorization"] = `Bearer ${hfToken}`;
  } else if (!auth && civitaiToken && isCivitaiUrl(url)) {
    // CivitAI auth travels as a request header (never in the URL/query) so the
    // token can't leak into logs, errors, or redirect URLs. fetch drops the
    // header on the cross-origin redirect to the already-signed download host.
    headers["Authorization"] = `Bearer ${civitaiToken}`;
  }

  const sensitiveParams =
    auth?.type === "query" ? [auth.query_param] : undefined;
  const logUrl = redactUrlForLogs(request.url, sensitiveParams);
  logger.info(`Downloading model to ${targetPath}`, { url: logUrl });

  // Stable id for the panel tray, keyed on the (pre-redirect) URL so resumes and
  // retries map to the same row. Name is the friendly file name.
  const progressId = createHash("sha256").update(request.url).digest("hex").slice(0, 16);
  // Attempt generation/epoch (panel#489): the id is URL-derived (deterministic), so a
  // retry of the SAME URL reuses it — attempt N and attempt N+1 are otherwise
  // indistinguishable. Stamp this attempt's start epoch on every row it writes so the
  // orchestrator can drop a LATE terminal (failed/done) row from a superseded attempt
  // once a newer attempt for the same id is already progressing. nextAttemptEpoch()
  // guarantees STRICT monotonicity within this process, so two same-millisecond retries
  // never tie (a tie would leave neither able to supersede the other); across processes
  // the wall clock orders a later spawn after an earlier one.
  const progress = { id: progressId, name: resolvedFilename, attempt: nextAttemptEpoch() };
  // Tell the job the id the tray rows actually use, so status display + cancel
  // cleanup key on the SAME id even when auth/HF-endpoint rewrote the request URL.
  onTrayId?.(progressId);

  try {
    await downloadWithCache({
      url: request.url,
      headers,
      targetPath,
      logUrl,
      storageAuth: auth?.type === "s3" ? { s3: auth } : undefined,
      progress,
      onResume,
      signal,
      onLanded,
      // #1635 — the failure hint must know a per-request override authenticated
      // this request, so a CivitAI 401 indicts THAT credential instead of
      // claiming no CIVITAI_API_TOKEN is configured.
      callerAuth: auth !== undefined,
    });
  } catch (err) {
    // On a user cancel (#515) the transfer was aborted, not a real failure — do NOT
    // emit an "error" row (the job reports "cancelled"). The tray row is cleared by the
    // JOB layer (finalizeCancelled), which is registry-aware so it can't wipe a
    // coalesced sibling's live row; clearing here would clear that shared row blindly.
    // For a genuine error, surface a failed row, then rethrow.
    if (!signal?.aborted) {
      reportDownloadProgress({ ...progress, downloaded: 0, total: 0, bytes_per_sec: 0, status: "error" }, true);
    }
    throw err;
  }

  const info = await stat(targetPath);
  // The file has MATERIALIZED to its destination and passed model-payload/size
  // validation. We deliberately do NOT abort here on a late cancel: the file on disk is
  // a complete, valid model, so the honest outcome is a completed download (the job
  // reports "done"). A cancel that arrived BEFORE the file landed already made this
  // function THROW — via the stream abort, or the cache-layer pre-materialize /
  // pre-rename guards — so it never reaches this point. (Rolling a validated landed file
  // back would be unsafe.) Result: file present ⟺ done; file absent ⟺ cancelled.
  logger.info(`Download complete: ${resolvedFilename} (${(info.size / 1024 / 1024).toFixed(1)} MB)`);
  // Ensure a terminal "done" row even on a cache hit (no streaming happened).
  reportDownloadProgress(
    { ...progress, downloaded: info.size, total: info.size, bytes_per_sec: 0, status: "done" },
    true,
  );

  return targetPath;
}
