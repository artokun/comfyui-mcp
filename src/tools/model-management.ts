import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  searchHuggingFaceModels,
  listLocalModels,
  listLocalModelsWithCoverage,
  currentLiveModelsRoot,
  verifyManagerVisibility,
  MODEL_SUBDIRS,
} from "../services/model-resolver.js";
import type { ModelListingCoverage } from "../services/model-resolver.js";
import { EXTRA_PATH_TARGETS } from "../services/extra-paths.js";
import { isRemoteMode } from "../config.js";
import {
  startDownloadJob,
  getDownloadJob,
  findDownloadJob,
  listDownloadJobs,
  listDownloadJobCandidates,
  cancelDownloadJob,
  describePlacement,
  type DownloadJob,
} from "../services/download-jobs.js";
import { readDownloadProgress } from "../services/download-progress.js";
import { errorToToolResult, ModelError } from "../utils/errors.js";
import {
  downloadCivitaiModelAction,
  removeModelAction,
  searchCivitaiCreatorsAction,
  searchCivitaiModelsAction,
} from "./model-extras.js";
import {
  addExtraPathAction,
  listExtraPathsAction,
  removeExtraPathAction,
} from "./extra-paths.js";
import { resolveMissingModelsAction } from "./missing-models.js";
import { getEmbeddingsAction } from "./memory-management.js";

/**
 * The fourteen model tools collapsed into two action-parameterized tools
 * (0.50.0 surface consolidation, slice 11):
 *
 *   download_model     — acquisition: find a model, fetch it, watch/stop the fetch
 *   list_local_models  — inventory:   what is installed, and where ComfyUI looks
 *
 * SHAPE: both are a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: only `action` can be schema-required, because a field that is
 * mandatory for one action is meaningless for another (`url` for "download",
 * ignored by "search"). Every branch calls the identical function its old tool
 * called, with the identical arguments, and returns the identical content block;
 * the handler enforces per-action PRESENCE and names the missing field — the one
 * deliberate behavioural difference a flat enum permits.
 *
 * MERGED VALUE CONSTRAINTS: where two actions shared a parameter name with
 * DIFFERENT zod constraints, the schema keeps the LOOSEST of them (so no caller
 * that used to be accepted is now refused) and the handler re-imposes the
 * tighter one for the actions that had it. That is why `requireNonEmpty` and the
 * `limit` ceilings exist below: they are the old schemas' `.min(1)` / `.max(n)`
 * moved down one layer, not new policy. Without them the fold would silently
 * WIDEN what each action accepts — the #839 failure mode, where introducing a
 * union without updating what reads it turns a false refusal into a false
 * acceptance.
 */

/**
 * How long download_model waits before handing back a handle instead of a path.
 * Long enough that ordinary files (LoRAs, VAEs, cache hits) still return a path
 * as they always did; short enough that a big checkpoint never pins the turn.
 */
function downloadGraceMs(): number {
  const raw = Number(process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 20_000;
}

const modelTypeEnum = z.enum(MODEL_SUBDIRS);

// Download target subfolder: accept ANY relative subfolder under models/ (not
// just the standard MODEL_SUBDIRS), since custom nodes expect models in arbitrary
// or nested dirs (e.g. 'loras/<subdir>', a brand-new model type). The service
// (resolveModelSubfolder) guards against absolute paths and traversal escapes.
const downloadTargetSchema = z
  .string()
  .min(1)
  .describe(
    `REQUIRED for action:"download" and action:"download_civitai". ` +
      `Target subfolder under ComfyUI models/. Standard names: ${MODEL_SUBDIRS.join(", ")}. ` +
      `Any other relative subfolder (incl. nested like 'loras/<subdir>') is allowed; ` +
      `absolute paths and '..' escapes are rejected.`,
  );

const downloadAuthSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bearer"),
    token: z.string().min(1).describe("Bearer token value"),
  }),
  z.object({
    type: z.literal("basic"),
    username: z.string().describe("Basic auth username"),
    password: z.string().describe("Basic auth password"),
  }),
  z.object({
    type: z.literal("header"),
    header_name: z.string().min(1).describe("HTTP header name"),
    header_value: z.string().describe("HTTP header value"),
  }),
  z.object({
    type: z.literal("query"),
    query_param: z.string().min(1).describe("Query parameter name"),
    query_value: z.string().describe("Query parameter value"),
  }),
  z.object({
    type: z.literal("s3"),
    access_key_id: z.string().min(1).describe("AWS/S3-compatible access key id"),
    secret_access_key: z.string().min(1).describe("AWS/S3-compatible secret access key"),
    session_token: z.string().optional().describe("Optional temporary session token"),
    region: z.string().optional().describe("Optional AWS region override"),
    endpoint: z.string().url().optional().describe("Optional S3-compatible endpoint for R2-style storage"),
  }),
]);

/**
 * Per-action ceilings for the merged `limit`, preserved from the old per-tool
 * schemas. The four folded searches capped it differently (50 / 25 / 50 / 20),
 * and only two of the four services clamp internally — searchHuggingFaceModels
 * and resolveCandidatesDetailed pass `limit` straight through, so the schema
 * ceiling WAS the only guard for those two.
 */
const LIMIT_MAX: Record<string, number> = {
  search: 50,
  search_civitai: 25,
  search_creators: 50,
  resolve_missing: 20,
};

/**
 * A required-for-this-action field is missing.
 *
 * ABSENCE only, never falsiness: `""` and `0` passed several of the old schemas
 * and reached the service, which answers with its own validation/not-found
 * error. A `!x` guard would swallow that path and substitute generic text —
 * a real behaviour regression, not a tidier message.
 */
function requireField<T>(tool: string, action: string, field: string, value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`${tool} action:"${action}" requires \`${field}\` — ${what}.`);
  }
  return value;
}

/**
 * Re-imposes an old schema's `.min(1)` on a field the merged schema had to
 * loosen. Deliberately NOT an absence guard: `undefined` is handled by
 * requireField (or is legitimately optional), and the ONLY thing this rejects is
 * the empty string that the retired tool's zod layer rejected too. Keeping the
 * refusal here means the fold neither widens nor narrows what the action takes.
 */
function requireNonEmpty(tool: string, action: string, field: string, value: string | undefined, what: string): void {
  if (value !== undefined && value.length === 0) {
    throw new Error(`${tool} action:"${action}" requires a non-empty \`${field}\` — ${what}.`);
  }
}

function requireLimitInRange(tool: string, action: string, limit: number | undefined): void {
  const max = LIMIT_MAX[action];
  if (limit !== undefined && max !== undefined && limit > max) {
    throw new Error(
      `${tool} action:"${action}" accepts \`limit\` up to ${max} (got ${limit}).`,
    );
  }
}

export function registerModelManagementTools(server: McpServer): void {
  server.tool(
    "download_model",
    "Find model weights and get them onto the connected ComfyUI, and track the transfers. Driven by the `action` parameter:\n" +
      '- action:"download" — Download a model file to the connected ComfyUI\'s models directory from a URL (HuggingFace, direct HTTP(S), s3://, or Azure Blob). Requires `url` + `target_subfolder`. PREFER this over a raw shell download (curl/wget) for model weights: it lands the file in the right models/ subfolder. LOCAL ComfyUI: streams to disk and surfaces live progress in the panel download tray. REMOTE ComfyUI: dispatches the fetch to the ComfyUI host via the ComfyUI-Manager install-model HTTP API (downloaded server-side; a per-request `auth` header can\'t be forwarded). This requires the host\'s Manager to run with network_mode=personal_cloud (or loopback) and a permissive security level — a stricter gate silently rejects the download, and Manager reports the queue task \'done\' even on failure, so a remote dispatch does not guarantee the file landed. target_subfolder accepts any relative subfolder (incl. nested, e.g. \'loras/<subdir>\').\n' +
      '- action:"status" — Check on downloads started by action:"download" / action:"download_civitai". Reports each download\'s state (downloading / done / error / cancelled), its destination path once it lands, and byte progress when the panel progress channel is enabled. Use this after a download reports it is still running — that means the transfer is in flight, NOT that it failed. What a reconnect preserves depends on WHO was transferring. A download this MCP streams LOCALLY survives an agent/sidebar reconnect — it keeps running and is normally resolvable by `id` or by `url` — but dies with an ORCHESTRATOR RESTART, where re-issuing is correct; any carried-over record for it is terminal (`error`) carrying an INTERRUPTED note, and is findable by `id` ONLY, never by `url` (the carry-over drops the url lookup key). A download dispatched to ComfyUI-Manager is the opposite: it is committed done the moment the dispatch is ACCEPTED, and with an aria2 sidecar the host may still be streaming gigabytes — a restart does NOT kill it and produces no interrupted record, so do NOT re-issue a Manager download on the strength of one; confirm with list_local_models first or you start a second copy of a live transfer. NOT FOUND NEVER MEANS STOPPED: both the cross-session record and the restart carry-over are written best-effort, so their absence is evidence of nothing either way. Omit `id` and `url` to list every tracked download. A previous session\'s download whose heartbeat has gone stale is reported with a stale-heartbeat NOTE: action:"cancel" can close it once the writer is proven gone, and re-issuing action:"download" then resumes or restarts it. Read-only.\n' +
      '- action:"cancel" — Cancel ONE in-flight download by its `id` (from action:"status" or from the download that started it) — REQUIRED, and it must be the id of the download you mean, since a wrong id stops someone else\'s transfer. Aborts only that download\'s transfer; other downloads keep running. An id that names no tracked download is reported as such, not silently treated as success. The partially-downloaded bytes are left on disk as a resumable .partial and are NEVER reported as a completed file, so nothing corrupt lands in your models directory; re-issuing the same download later resumes where it left off. Idempotent: cancelling an already-finished, failed, or already-cancelled download just reports its current state. A download whose AbortController lives in ANOTHER live session cannot be aborted from here (stop it from the panel download tray) — but a download left \'downloading\' by a session that is PROVEN gone (heartbeat stale AND its process no longer exists) CAN be cancelled from here: the stale record is closed as cancelled, after which re-issuing action:"download" resumes the leftover .partial or restarts cleanly. While the writer cannot be proven gone, the cancel refuses rather than risk two writers on one file. NOTE: for a download dispatched to a REMOTE ComfyUI via ComfyUI-Manager (server-side fetch), the local job is marked cancelled but the host may keep fetching — there is no Manager API to stop it.\n' +
      '- action:"search" — Search HuggingFace Hub for models usable in ComfyUI (checkpoints, LoRAs, VAEs, ControlNets, etc.); `query` is required. Read-only and network-only: queries HuggingFace over HTTP, does NOT require a running ComfyUI or COMFYUI_PATH and does not download anything. Returns a ranked list with modelId, author, downloads, likes, and tags. Pick a result\'s download URL and pass it to action:"download". For CIVITAI searches (\'find a Flux LoRA on Civitai\') use action:"search_civitai" instead — it filters by type + base model and returns ids for action:"download_civitai". For packs of custom nodes (not models) use search_custom_nodes.\n' +
      '- action:"search_civitai" — Search CivitAI by keyword for checkpoints, LoRAs, embeddings, VAEs, and ControlNets — THE action for \'find me a <base model> LoRA on Civitai\'. Read-only and network-only (public CivitAI REST API; no token or running ComfyUI required; CIVITAI_API_TOKEN unlocks gated results). Filter by `types` (LORA, Checkpoint, TextualInversion, VAE, Controlnet, …) and `base_models` (CivitAI labels: \'Flux.1 D\', \'SDXL 1.0\', \'SD 1.5\', \'Pony\', \'Illustrious\', \'Wan Video\') — ALWAYS pass base_models when the user\'s checkpoint family is known, so results actually fit their setup. Each hit returns the model_id and version_id that action:"download_civitai" takes directly, plus trigger words to use in the prompt after installing. Flow: action:"search_civitai" → pick a hit → action:"download_civitai" {model_version_id, target_subfolder} → wire/prompt with the trained words. Pass `creator` (exact username, e.g. from action:"search_creators") to list ONE creator\'s models — with or without a `query`; at least one of the two is required. SFW-only by default. For HuggingFace search use action:"search".\n' +
      '- action:"search_creators" — Find CivitAI CREATORS — THE action for \'who are the top creators on Civitai\' and \'find creator <name>\'. Read-only and network-only (no token or running ComfyUI required). Two modes: with NO `query` it returns the site\'s creator LEADERBOARD (civitai.com/leaderboard — rank, score, downloads, likes; pick a `board`: \'overall\' [default], \'overall_90\' [last 90 days], \'overall_nsfw\' [mature], \'new_creators\' [first model <30 days ago]); with a `query` it searches usernames (public /api/v1/creators; partial match, returns model counts, NOT ranked). Each hit\'s username feeds action:"search_civitai" {creator: <username>} directly. SCOPE CAVEAT: the /api/v1/creators index only lists creators who have published MODELS. A creator who posts only images/videos (no models) legitimately returns 0 hits here — that is a gap in this endpoint, NOT proof the creator doesn\'t exist. For a media-only creator, browse their images via the panel CivitAI browser (panel_open_civitai {creator}) or the logged-in browser session instead.\n' +
      '- action:"download_civitai" — Download a model from CivitAI into the connected ComfyUI\'s models/ directory. Requires `target_subfolder` plus at least one of `model_id` / `model_version_id`. Resolves a CivitAI model id (latest version) or a model-version id to a download URL via the CivitAI REST API. LOCAL ComfyUI (COMFYUI_PATH set): streams the file to disk under <COMFYUI_PATH>/models/<target_subfolder>/ and returns the saved absolute path. REMOTE ComfyUI: dispatches the download to the ComfyUI host via the ComfyUI-Manager install-model HTTP API (fetched server-side). Gated/early-access models require CIVITAI_API_TOKEN locally (sent as a bearer header, never in the URL); remote Manager-side fetches rely on tokens configured on the ComfyUI host. NOTE (remote): the server-side install requires the host\'s ComfyUI-Manager to run with network_mode=personal_cloud (or loopback) and a permissive security level; a stricter gate silently rejects the download, and Manager reports the queue task \'done\' even on failure — so a remote dispatch does not guarantee the file landed.\n' +
      '- action:"resolve_missing" — Find the model files a `workflow` needs but this ComfyUI does NOT have, and search CivitAI + HuggingFace for installable candidates. THE action for \'this Template says a model is missing — go get it\'. Detects by comparing each model widget against the option list the server actually publishes, so it covers checkpoints, LoRAs, VAEs, ControlNets, UNets, CLIP and custom-pack model types without any per-node mapping. Each candidate reports size, source, precision/quantisation (fp16 / fp8 / GGUF Q4_K_M …) and whether it FITS this GPU\'s VRAM — so when the exact file is too big you can see the quantised variant that isn\'t. Read-only: it downloads nothing. Pass a chosen candidate to action:"download" (url) or action:"download_civitai" (id), using the reported directory as target_subfolder. For missing custom NODE PACKS (not models) use list_packs (action:"install_deps") instead.',
    {
      action: z
        .enum([
          "download",
          "status",
          "cancel",
          "search",
          "search_civitai",
          "search_creators",
          "download_civitai",
          "resolve_missing",
        ])
        .describe(
          'Which model operation to perform. "download" requires `url` + `target_subfolder`; ' +
            '"status" takes an optional `id`/`tray_id`/`url` (omit all three to list everything); ' +
            '"cancel" requires `id` (optional `tray_id`); "search" requires `query`; ' +
            '"search_civitai" requires `query` and/or `creator`; "search_creators" takes an optional ' +
            '`query` (omit for the leaderboard `board`); "download_civitai" requires `target_subfolder` ' +
            'plus `model_id` and/or `model_version_id`; "resolve_missing" requires `workflow`.',
        ),
      url: z
        .string()
        .url()
        .optional()
        .describe(
          'REQUIRED for action:"download" — the direct download URL for the model file. ' +
            'OPTIONAL for action:"status" — adopt an in-flight download by its source URL when you ' +
            "don't have the id (e.g. after a reconnect); reports the matching job without starting a duplicate.",
        ),
      target_subfolder: downloadTargetSchema.optional(),
      filename: z
        .string()
        .optional()
        .describe(
          'action:"download" — override filename (auto-detected from the URL if omitted). ' +
            'action:"download_civitai" — override the saved filename (defaults to the CivitAI file ' +
            "name, or the URL basename).",
        ),
      auth: downloadAuthSchema
        .optional()
        .describe(
          'action:"download" — optional per-request authentication for private/gated model URLs. ' +
            "When provided it overrides built-in HuggingFace/CivitAI token handling.",
        ),
      id: z
        .string()
        .optional()
        .describe(
          'The download id. REQUIRED for action:"cancel" — this is the handle that says WHICH ' +
            'transfer to stop, so take it from action:"status" (or from the reply that started the ' +
            "download) rather than guessing; an id that matches nothing is reported as not found. " +
            'OPTIONAL for action:"status" — omit to list every tracked download (incl. in-flight ' +
            "ones from before a reconnect).",
        ),
      tray_id: z
        .string()
        .optional()
        .describe(
          'action:"status" / action:"cancel" — use this when two rows come back with the SAME `id`, ' +
            "so the id alone cannot say which one you mean. That happens when two different source " +
            "URLs are downloading to the same destination file. Every row prints its own tray id as " +
            "`(tray <tray_id>)` — pass that here, together with `id`, to report on (or stop) exactly one of them.",
        ),
      query: z
        .string()
        .optional()
        .describe(
          'REQUIRED for action:"search" — the HuggingFace search query (e.g. \'SDXL\', \'flux\', \'controlnet\'). ' +
            'action:"search_civitai" — keyword search (e.g. \'detail enhancer\', a character name); ' +
            "optional when `creator` is given (then it narrows that creator's models). " +
            'action:"search_creators" — username search (partial match, e.g. \'alcait\'); omit to get ' +
            "the top-creators leaderboard instead.",
        ),
      filter: z
        .string()
        .optional()
        .describe(
          'action:"search" — optional HuggingFace pipeline/library tag to narrow results, e.g. ' +
            "'diffusers' or 'text-to-image'.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe(
          "Max results (default 10, or 8 candidates per missing model for " +
            'action:"resolve_missing"). Per-action ceilings, unchanged from the tools this folds in: ' +
            '"search" 50, "search_civitai" 25, "search_creators" 50, "resolve_missing" 20.',
        ),
      creator: z
        .string()
        .min(1)
        .optional()
        .describe(
          'action:"search_civitai" — only models by this CivitAI creator (EXACT username — find it ' +
            'with action:"search_creators"). At least one of query/creator is required.',
        ),
      types: z
        .array(z.enum(["Checkpoint", "LORA", "LoCon", "DoRA", "TextualInversion", "VAE", "Controlnet", "Upscaler", "MotionModule", "Workflows"]))
        .optional()
        .describe('action:"search_civitai" — only these model types (e.g. [\'LORA\']).'),
      base_models: z
        .array(z.string())
        .optional()
        .describe(
          'action:"search_civitai" — only these base-model families, CivitAI labels: ' +
            "'Flux.1 D', 'SDXL 1.0', 'SD 1.5', 'Pony', 'Illustrious', 'Wan Video', …",
        ),
      sort: z
        .enum(["Highest Rated", "Most Downloaded", "Newest"])
        .optional()
        .describe('action:"search_civitai" — ranking (default \'Highest Rated\').'),
      nsfw: z
        .boolean()
        .optional()
        .describe('action:"search_civitai" — include NSFW results (default false).'),
      board: z
        .enum(["overall", "overall_90", "overall_nsfw", "new_creators"])
        .optional()
        .describe(
          'action:"search_creators" — leaderboard to rank by when no query is given ' +
            "(default 'overall'). Ignored with a query.",
        ),
      model_version_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'action:"download_civitai" — CivitAI model-version id (from the URL ?modelVersionId=...). ' +
            "If both model_id and model_version_id are given, this selects the specific version of that model.",
        ),
      model_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'action:"download_civitai" — CivitAI model id. The latest version is used unless ' +
            "model_version_id is also provided.",
        ),
      workflow: z
        .union([z.string(), z.record(z.string(), z.any())])
        .optional()
        .describe(
          'REQUIRED for action:"resolve_missing" — the ComfyUI workflow in API format (JSON string or object).',
        ),
    },
    // #1106 — friction-ADDING hints only; see the note on `runpod`. readOnlyHint is
    // deliberately never set: it removes a host confirmation rather than adding one.
    {
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: false,
    },
    async (args) => {
      try {
        requireLimitInRange("download_model", args.action, args.limit);

        switch (args.action) {
          case "download":
            return await downloadAction({
              url: requireField(
                "download_model",
                "download",
                "url",
                args.url,
                "the direct download URL for the model file",
              ),
              target_subfolder: requireField(
                "download_model",
                "download",
                "target_subfolder",
                args.target_subfolder,
                "the models/ subfolder to land the file in (e.g. 'checkpoints', 'loras')",
              ),
              filename: args.filename,
              auth: args.auth,
            });
          case "status":
            return await statusAction({ id: args.id, tray_id: args.tray_id, url: args.url });
          case "cancel": {
            const id = requireField(
              "download_model",
              "cancel",
              "id",
              args.id,
              'the id of the download to stop, from action:"status"',
            );
            // The retired tool's `.min(1)`, re-imposed. The merged `id` had to
            // drop it for action:"status", where "" legitimately means "list
            // everything" — but an EMPTY id naming which transfer to abort is
            // not a selector at all, and letting it through would turn a schema
            // refusal into a not-found report about a download nobody named.
            requireNonEmpty(
              "download_model",
              "cancel",
              "id",
              id,
              'the id of the download to stop, from action:"status"',
            );
            return await cancelAction({ id, tray_id: args.tray_id });
          }
          case "search":
            return await searchAction({
              query: requireField(
                "download_model",
                "search",
                "query",
                args.query,
                "the HuggingFace search query",
              ),
              filter: args.filter,
              limit: args.limit,
            });
          case "search_civitai":
            // The old tool's `.min(1)` on query/creator, re-imposed here: the merged
            // `query` had to drop it for action:"search", whose schema accepted "".
            requireNonEmpty(
              "download_model",
              "search_civitai",
              "query",
              args.query,
              "a keyword to search CivitAI for (or omit it and pass `creator`)",
            );
            return await searchCivitaiModelsAction({
              query: args.query,
              creator: args.creator,
              types: args.types,
              base_models: args.base_models,
              sort: args.sort,
              nsfw: args.nsfw,
              limit: args.limit,
            });
          case "search_creators":
            requireNonEmpty(
              "download_model",
              "search_creators",
              "query",
              args.query,
              "a username fragment to search for (or omit it for the leaderboard)",
            );
            return await searchCivitaiCreatorsAction({
              query: args.query,
              board: args.board,
              limit: args.limit,
            });
          case "download_civitai":
            return await downloadCivitaiModelAction({
              target_subfolder: requireField(
                "download_model",
                "download_civitai",
                "target_subfolder",
                args.target_subfolder,
                "the models/ subfolder to land the file in (e.g. 'checkpoints', 'loras')",
              ),
              model_version_id: args.model_version_id,
              model_id: args.model_id,
              filename: args.filename,
            });
          case "resolve_missing":
            return await resolveMissingModelsAction({
              workflow: requireField(
                "download_model",
                "resolve_missing",
                "workflow",
                args.workflow,
                "the workflow (API format, JSON string or object) whose models to check",
              ),
              limit: args.limit,
            });
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown download_model action "${String(exhaustive)}". Expected one of: download, status, cancel, search, search_civitai, search_creators, download_civitai, resolve_missing.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "list_local_models",
    "Inspect what models this ComfyUI has installed, and where it looks for them. Driven by the `action` parameter:\n" +
      '- action:"list" — List model files available to the connected ComfyUI, grouped by type. Read-only. Queries ComfyUI\'s /models REST endpoint first (works with remote ComfyUI and respects extra_model_paths.yaml — symlinked / mounted dirs the install-path filesystem scan would miss), then falls back to a filesystem scan of COMFYUI_PATH/models/ when the REST endpoint is unavailable. Size and modified time are only available on the filesystem fallback path. Use to see which models are already available before generating or downloading; use download_model action:"search" to discover new models on HuggingFace, then action:"download" to fetch them. For models fetched via download_model action:"download_civitai", any CivitAI trigger/activation words and base model are shown inline (read from the `<file>.civitai.json` sidecar) — apply those trigger words in your prompt when generating with that model. A `civitai:` line under an entry is that model\'s CivitAI page URL (modelId + INSTALLED modelVersionId, from the same sidecar) — use it to reference the source or check for newer versions.\n' +
      '- action:"remove" — DELETES a model FILE from the local ComfyUI models directories. `path` is REQUIRED and is a file path relative to models/. THIS IS DESTRUCTIVE AND HAS NO UNDO: the file is unlinked, not moved to a recycle bin, and a large checkpoint can take hours to re-download — confirm the exact path with the user (action:"list" shows it) before calling. Resolves the path across ALL configured roots — the primary <COMFYUI_PATH>/models AND every directory in extra_model_paths.yaml / extra_models_config.yaml (e.g. models stored on another drive like E:\\) — the same roots ComfyUI loads from. The path must stay within a known root (path traversal and absolute escapes are rejected), and a directory is refused. LOCAL-ONLY: deletes from the local filesystem, so it is not supported against a remote ComfyUI (remove the file on the host). Do NOT confuse this with action:"remove_path", which edits a config file and deletes nothing.\n' +
      '- action:"embeddings" — List textual-inversion embeddings installed on the connected ComfyUI server (read from its /api/embeddings endpoint, i.e. the models/embeddings folder). Requires a running, reachable ComfyUI (local or remote); takes no other parameters. Returns the embedding names; reference them in positive or negative prompts as embedding:name (e.g. embedding:easynegative). Read-only.\n' +
      '- action:"list_paths" — View ComfyUI extra search-path config for standalone/manual installs and ComfyUI Desktop. Read-only. Resolves LIVE-FIRST: the file the running ComfyUI actually reads (its --extra-model-paths-config, else the extra_model_paths.yaml beside its main.py), falling back to the local heuristic only when no server is reachable — <ComfyUI root>/extra_model_paths.yaml (COMFYUI_PATH, else the saved default workspace from workspace action:"set_default") or the Desktop app-data extra_models_config.yaml. Reports generic categories, so model categories and custom_nodes entries are both visible when present. Because it is read-only it never refuses a reachable LOCAL server just because its argv does not prove which file it reads: it shows the server-named config when that file exists here, else the local auto-selected one, always labelled as unconfirmed rather than presented as the live server\'s. action:"add_path"/action:"remove_path" still refuse in that state — a write to an unproven file would be a silent no-op.\n' +
      '- action:"add_path" — Add a directory to a ComfyUI extra search-path YAML config; `category` + `path` are REQUIRED. Use this for model categories such as checkpoints/loras/vae and, on ComfyUI builds that support it, custom_nodes. Writes the config file and returns the updated view; restart ComfyUI to apply.\n' +
      '- action:"remove_path" — Remove a directory from a ComfyUI extra search-path YAML config; `category` + `path` are REQUIRED. Matches the stored path exactly. This edits the YAML only — it deletes NO model files and frees no disk space (that is action:"remove"). Restart ComfyUI after removing an active path.',
    {
      action: z
        .enum(["list", "remove", "embeddings", "list_paths", "add_path", "remove_path"])
        .describe(
          'Which inventory operation to perform. "list" (optional `model_type`), "embeddings" and ' +
            '"list_paths" are READ-ONLY. "remove" DELETES the model file named by `path` — required, ' +
            'and destructive. "add_path"/"remove_path" edit the extra-search-path YAML and require ' +
            "`category` + `path`; they never touch model files.",
        ),
      model_type: modelTypeEnum
        .optional()
        .describe(
          'action:"list" — filter by model type (e.g. \'checkpoints\', \'loras\'). Lists all types if omitted.',
        ),
      path: z
        .string()
        .min(1)
        .optional()
        .describe(
          "REQUIRED by three actions, and it means two DIFFERENT things — read this before calling. " +
            'action:"remove": the MODEL FILE to DELETE, relative to the ComfyUI models/ directory ' +
            "(e.g. 'checkpoints/sd_xl_base_1.0.safetensors'); the leading segment is the category used " +
            'to locate the file in extra roots too. action:"add_path" / action:"remove_path": a ' +
            "DIRECTORY to add to / remove from the extra-search-path YAML for `category` (absolute " +
            "paths are safest; relative paths are resolved by ComfyUI) — no file is deleted.",
        ),
      target: z
        .enum(EXTRA_PATH_TARGETS)
        .optional()
        .describe(
          'action:"list_paths" / "add_path" / "remove_path" — config target. auto (default) is ' +
            "LIVE-FIRST: the running ComfyUI's own --extra-model-paths-config, else the " +
            "extra_model_paths.yaml next to its main.py. When no server is reachable, auto shows the " +
            "Desktop config if one exists, otherwise standalone. When a reachable LOCAL server does " +
            "not expose main.py, listing degrades to the server-named config (if it exists here) or " +
            "the local auto-selected one, explicitly marked as an unconfirmed display fallback; " +
            "mutations refuse instead. standalone forces <ComfyUI root>/extra_model_paths.yaml, where " +
            "the root is COMFYUI_PATH (or an auto-detected install) and falls back to the saved " +
            "default workspace; desktop forces the OS app-data extra_models_config.yaml. Use " +
            "standalone/desktop (or config_path) to deliberately target a file the running server does not read.",
        ),
      config_path: z
        .string()
        .optional()
        .describe(
          'action:"list_paths" / "add_path" / "remove_path" — explicit YAML config path override, ' +
            "mainly for advanced/manual installs.",
        ),
      group: z
        .string()
        .optional()
        .describe(
          'action:"add_path" / "remove_path" — top-level YAML group to edit. Defaults to comfyui_mcp.',
        ),
      category: z
        .string()
        .min(1)
        .optional()
        .describe(
          'REQUIRED for action:"add_path" / action:"remove_path" — the ComfyUI search-path category, ' +
            "e.g. checkpoints, loras, vae, diffusion_models, unet_gguf, or custom_nodes.",
        ),
      is_default: z
        .boolean()
        .optional()
        .describe(
          'action:"add_path" — set is_default on a newly-created group. Existing groups are not overwritten.',
        ),
    },
    async (args) => {
      try {
        switch (args.action) {
          case "list":
            return await listAction({ model_type: args.model_type });
          case "remove":
            // The ONLY branch that unlinks a file. Nothing above it can reach the
            // delete: every other action either returns before this switch arm or
            // dispatches to a read/YAML-only function, and `path` alone is inert —
            // it is the ACTION that selects deletion, which is exactly why this
            // arm is the one with the loudest description.
            return await removeModelAction({
              path: requireField(
                "list_local_models",
                "remove",
                "path",
                args.path,
                "the model FILE to delete, relative to models/ (e.g. 'loras/old.safetensors')",
              ),
            });
          case "embeddings":
            return await getEmbeddingsAction();
          case "list_paths":
            return await listExtraPathsAction({
              target: args.target,
              config_path: args.config_path,
            });
          case "add_path":
            return await addExtraPathAction({
              target: args.target,
              config_path: args.config_path,
              group: args.group,
              category: requireField(
                "list_local_models",
                "add_path",
                "category",
                args.category,
                "the ComfyUI search-path category, e.g. 'checkpoints' or 'loras'",
              ),
              path: requireField(
                "list_local_models",
                "add_path",
                "path",
                args.path,
                "the DIRECTORY to add for that category",
              ),
              is_default: args.is_default,
            });
          case "remove_path":
            return await removeExtraPathAction({
              target: args.target,
              config_path: args.config_path,
              group: args.group,
              category: requireField(
                "list_local_models",
                "remove_path",
                "category",
                args.category,
                "the ComfyUI search-path category the directory is listed under",
              ),
              path: requireField(
                "list_local_models",
                "remove_path",
                "path",
                args.path,
                "the DIRECTORY to remove from the config (no model file is deleted)",
              ),
            });
          default: {
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown list_local_models action "${String(exhaustive)}". Expected one of: list, remove, embeddings, list_paths, add_path, remove_path.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// The five handler bodies that already lived in this file, unchanged apart from
// their wrapper: `server.tool(name, desc, shape, async (args) => {…})` became a
// plain function the dispatcher above calls. Every service call, every rendered
// string and every error path is byte-identical to the retired tool's.
// ---------------------------------------------------------------------------

/** ← the retired standalone HuggingFace search tool (now action:"search"). */
async function searchAction(args: {
  query: string;
  filter?: string;
  limit?: number;
}): Promise<CallToolResult> {
      try {
        const results = await searchHuggingFaceModels(args.query, {
          filter: args.filter,
          limit: args.limit,
        });

        const text = results.length === 0
          ? `No models found for "${args.query}".`
          : results
              .map(
                (m, i) =>
                  `${i + 1}. **${m.modelId}** by ${m.author || "unknown"}\n` +
                  `   Downloads: ${m.downloads.toLocaleString()} | Likes: ${m.likes}\n` +
                  // #809: a silently-clipped tag list reads as the model's COMPLETE tag
                  // set, so a caller filtering on tags draws a false conclusion. Say how
                  // many more there are; the 5-tag cap itself is fixed.
                  `   Tags: ${m.tags.slice(0, 5).join(", ") || "none"}${m.tags.length > 5 ? ` (+${m.tags.length - 5} more; fixed 5-tag preview that no parameter raises — the rest are only on the model's Hub page)` : ""}`,
              )
              .join("\n\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorToToolResult(err);
      }
}

/** ← download_model (the pre-fold single-purpose tool) */
async function downloadAction(args: {
  url: string;
  target_subfolder: string;
  filename?: string;
  auth?: z.infer<typeof downloadAuthSchema>;
}): Promise<CallToolResult> {
      try {
        // Start it, then wait only a GRACE WINDOW rather than the whole
        // transfer. Small files (a VAE, a LoRA, a cache hit) still finish
        // inside the window and return a path exactly as before, so the common
        // case is unchanged. A multi-GB checkpoint hands back a handle instead
        // of pinning the turn for ten minutes — which is what made the agent
        // look stuck and then wrongly disclaim a download that was running.
        const { job, settled } = await startDownloadJob(
          args.url,
          args.target_subfolder,
          args.filename,
          args.auth,
        );

        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          settled,
          new Promise<void>((r) => {
            timer = setTimeout(r, downloadGraceMs());
          }),
        ]);
        if (timer) clearTimeout(timer);

        if (job.status === "done") {
          // ONE placement policy for every consumer (#369): only a file the running
          // ComfyUI actually lists may be called a success. A Manager dispatch, a
          // still-pending check and an inconclusive check are all unconfirmed.
          const placement = describePlacement(job, {
            liveModelsDir: await currentLiveModelsRoot(),
          });
          // #1086 — ASK the server instead of telling the caller to. The Manager
          // branch could only ever say "confirm with list_local_models yourself",
          // and a reporter who did not lost a multi-GB model to an ephemeral
          // overlay. The listing question IS answerable remotely, so answer it.
          // "not-listed" is deliberately not rendered as failure: the dispatch
          // returns on ACCEPTANCE, so a large file may still be arriving.
          // unknown-ok: undefined is the COULD-NOT-VERIFY state, and it is kept
          // distinct from both "visible" and "not-listed" below — the render
          // appends the note only when one exists, and never upgrades a missing
          // verification into a confirmation. (verifyManagerVisibility documents
          // that it never throws, so this catch is belt-and-braces.)
          const managerSeen = job.viaManager
            ? await verifyManagerVisibility(
                job.target_subfolder,
                job.filename ?? (job.path ?? "").split(/[\\/]/).pop() ?? "",
                { attempts: 1 },
              ).catch(() => undefined)
            : undefined;
          const text = job.viaManager
            ? `Download DISPATCHED to the remote ComfyUI via ComfyUI-Manager (server-side fetch):\n${job.path}\n\n` +
              // #473 — "CONFIRMED" was WRONG here, and it was my regression in
              // 0.50.29. A listing proves a file of that NAME exists; Manager
              // writes whatever the URL returned under the name you asked for,
              // and it cannot carry this MCP's credentials. A reporter on 0.50.34
              // got six byte-identical 10,038-byte CivitAI login pages saved as
              // models, and said this check "sometimes upgraded the
              // filename-presence check to CONFIRMED" — which is precisely the
              // fabricated success #473 has now been reported for three times.
              //
              // The word stays out of the Manager branch entirely. LISTED is the
              // observation; validity is not established here and must not be
              // implied by the label.
              (managerSeen?.visibility === "visible"
                ? `LISTED (placement only, NOT validity): ${managerSeen.note}`
                : `NOTE: ${placement.warning}` +
                  (managerSeen ? `\n\n${managerSeen.note}` : ""))
            : placement.confirmed
              ? `Model downloaded successfully to${placement.pathQualifier}:\n${job.path}`
              : placement.wrongPlace
                ? // NOT a success. The bytes are on disk but the running ComfyUI does not
                  // read from there, so calling this "downloaded successfully" is the exact
                  // fabricate-success failure of #369.
                  `Download finished, but the model is NOT usable by the connected ComfyUI.\n\n` +
                  `${placement.pathLabel}${placement.pathQualifier}:\n${job.path}\n\n` +
                  `${placement.warning}\n\n` +
                  `Do NOT tell the user the model is ready — it is not visible to the server that would load it.`
                : `Model ${placement.pathLabel}${placement.pathQualifier}:\n${job.path}\n\n` +
                  `NOTE: ${placement.warning}`;
          return {
            content: [{ type: "text", text }],
          };
        }
        if (job.status === "error") {
          return errorToToolResult(new ModelError(job.error ?? "Download failed", { url: args.url }));
        }
        if (job.status === "cancelled") {
          // A concurrent action:"cancel" landed during this grace window (e.g. a reissue
          // adopted a running job, then that id was cancelled).
          return {
            content: [
              {
                type: "text",
                text: job.viaManager
                  ? `Download \`${job.id}\` was cancelled. It was a remote ComfyUI-Manager dispatch, so there is no local partial to resume; the host MAY still be fetching server-side (no Manager recall API). Check list_local_models to see if it landed; re-issuing starts a NEW dispatch, not a resume.`
                  : `Download \`${job.id}\` was cancelled. A resumable partial may remain on disk — re-issue the same download to resume it (it picks up where it left off).`,
              },
            ],
          };
        }

        const p = readDownloadProgress(job.progressId ?? job.trayId);
        const pct =
          p && p.total > 0 ? ` (${Math.floor((p.downloaded / p.total) * 100)}%)` : "";
        return {
          content: [
            {
              type: "text",
              text:
                `Download STARTED and is still running${pct} — id \`${job.id}\`.\n\n` +
                `This is NOT a failure and you must not describe it as one. The file is ` +
                `streaming to disk in the background and will land on its own.\n\n` +
                `Tell the user it is downloading, then check download_model \`action:"status"\` with this id ` +
                `when they ask. Do NOT call action:"download" again for this URL — a repeat ` +
                `request adopts the same job rather than starting a second copy, but saying ` +
                `"I'll leave it to you" or reporting it as incomplete would be wrong.`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
}

/** ← the retired standalone download-status tool (now action:"status"). */
async function statusAction(args: {
  id?: string;
  tray_id?: string;
  url?: string;
}): Promise<CallToolResult> {
      try {
        const byId = args.id ? getDownloadJob(args.id, args.tray_id) : undefined;
        const byUrl = !byId && args.url ? findDownloadJob({ url: args.url }) : undefined;
        const list =
          args.id || args.url
            ? [byId ?? byUrl].filter((j): j is DownloadJob => !!j)
            : listDownloadJobs();

        if (list.length === 0) {
          // #822: an id that answers to SEVERAL downloads resolved to none. That is
          // not "no such download" — reporting it as one turns "could not determine
          // which" into a definite (and wrong) verdict, and leaves the caller with
          // no move. Name the candidates and the exact selector that picks one.
          const candidates = args.id && !args.tray_id ? listDownloadJobCandidates(args.id) : [];
          if (candidates.length > 1) {
            const rows = candidates
              .map(
                (c) =>
                  `  - tray \`${c.trayId}\` — ${c.status}, started ${Math.round((Date.now() - c.started_at) / 1000)}s ago, from: ${c.url}`,
              )
              .join("\n");
            return {
              content: [
                {
                  type: "text",
                  text:
                    `The id \`${args.id}\` matches ${candidates.length} DIFFERENT downloads, so it cannot select one. ` +
                    `That id is derived from the DESTINATION file, and these downloads fetch different source URLs into the same destination:\n${rows}\n\n` +
                    `Re-run download_model \`action:"status"\` with \`tray_id\` set to the one you mean. ` +
                    `Note that two of these are writing the SAME file — decide which to keep and stop the other with \`action:"cancel"\` (also by \`tray_id\`).`,
                },
              ],
            };
          }
          const selector = args.id
            ? `id \`${args.id}\`${args.tray_id ? ` + tray \`${args.tray_id}\`` : ""}`
            : args.url
              ? `url \`${args.url}\``
              : "";
          return {
            content: [
              {
                type: "text",
                text: (args.id || args.url)
                  ? `No download matching ${selector}. Several causes reach this same message and it does not distinguish them — treat it as "not found", NOT as "finished": it may have finished long ago (settled records are pruned after a while), never started, been interrupted by an orchestrator restart with the carry-over that records that (#1148) not having run (it is best-effort by design), been looked up by \`url\` when only a carried-over record exists (those are findable by \`id\` only), or been given a valid \`id\` with a \`tray_id\` that does not match it. Check the panel download tray before re-downloading. Within the SAME session, re-issuing an identical in-flight download adopts it rather than duplicating; across a reconnect, confirm via the tray first.`
                  : "No downloads are being tracked.",
              },
            ],
          };
        }

        // ONE resolution for the whole listing: a verdict made against a
        // DIFFERENT ComfyUI than the one connected now must not be re-asserted (#369).
        const liveModelsDir = await currentLiveModelsRoot();
        // #822: `id` is derived from the DESTINATION (+auth), so two rows fetching
        // different URLs into one file legitimately share it. The composite
        // (id, trayId) is the real handle — render trayId on EVERY row so the
        // printed handle always identifies exactly one download, and shout when a
        // listing actually contains a collision (two writers, one file).
        const idCounts = new Map<string, number>();
        for (const j of list) idCounts.set(j.id, (idCounts.get(j.id) ?? 0) + 1);
        const collidingIds = [...idCounts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
        const lines = list.map((j) => {
          const p = readDownloadProgress(j.progressId ?? j.trayId);
          const bytes =
            p && p.total > 0
              ? `  ${(p.downloaded / 1024 ** 3).toFixed(2)}/${(p.total / 1024 ** 3).toFixed(2)} GB (${Math.floor((p.downloaded / p.total) * 100)}%)`
              : p && p.downloaded > 0
                ? `  ${(p.downloaded / 1024 ** 3).toFixed(2)} GB so far`
                : "";
          const head = `- \`${j.id}\` (tray \`${j.trayId}\`) **${j.status}**${bytes}`;
          const collisionNote = idCounts.get(j.id)! > 1
            ? `\n    AMBIGUOUS id: another row in this listing shares \`${j.id}\` — these are DIFFERENT source URLs writing the SAME destination file, so the last writer wins and the result may be a mix. Select this one with \`tray_id\`: \`${j.trayId}\`. Pass that same tray_id to \`action:"cancel"\` to stop THIS one specifically.`
            : "";
          // Same single placement policy the action:"download" renderer uses (#369):
          // a bare "landed at" is only ever printed for a CONFIRMED placement.
          const placement =
            j.status === "done" ? describePlacement(j, { liveModelsDir }) : undefined;
          const detail =
            j.status === "done" && placement
              ? j.viaManager
                ? // #947 — say what the ROUTE was, not that the server is remote.
                  // The Manager route is taken whenever no local models directory
                  // could be resolved, which a loopback server hits routinely; a
                  // reporter on 127.0.0.1 read "remote" as a misclassification.
                  `\n    dispatched to the ${isRemoteMode() ? "remote" : "connected"} ComfyUI via ComfyUI-Manager (server-side fetch)${isRemoteMode() ? "" : " — no local models directory was resolvable, so this MCP could not stream it itself; that is a routing fallback, not a remote server"}: ${j.path}\n    NOTE: ${placement.warning}`
                : placement.confirmed
                  ? `\n    ${placement.pathLabel}${placement.pathQualifier}: ${j.path}`
                  : `\n    ${placement.pathLabel}${placement.pathQualifier}: ${j.path}\n    ${placement.wrongPlace ? "WARNING" : "NOTE"}: ${placement.warning}`
              : j.status === "error"
                ? j.interruptedByRestart
                  ? // #1148 — NOT a transfer failure. The process it streamed
                    // inside exited, which the previous behaviour rendered as
                    // "No download matching id": the job silently ceased to exist
                    // while the contract told the caller to keep waiting.
                    `\n    INTERRUPTED — ${j.error}`
                  : `\n    failed: ${j.error}`
                : j.status === "cancelled"
                  ? (j.reclaimedDead
                      ? // #858: NO live transfer was aborted — the writer was already
                        // dead — so this must not claim a partial was deliberately
                        // left by a cancel (none may exist).
                        (j.viaManager
                          ? `\n    cancelled — the previous session's writer was confirmed GONE (its process no longer exists), so a later session closed its stale record; no live transfer was aborted. This was a remote ComfyUI-Manager dispatch: the host MAY still be fetching server-side (no Manager recall API) and there is NO local partial to resume — check list_local_models to see whether the file landed; re-issuing starts a NEW dispatch.`
                          : `\n    cancelled — the previous session's writer was confirmed GONE (its process no longer exists), so a later session closed its stale record; no live transfer was aborted. Any .partial the dead writer left was untouched — re-issue the download to resume from it, or to restart cleanly if there is none.`)
                      : j.viaManager
                        ? `\n    cancelled — this was a remote ComfyUI-Manager dispatch, so there is NO local partial to resume, and the host MAY still be fetching server-side (there's no Manager recall API). Re-issuing starts a NEW server-side dispatch (a duplicate, not a resume). Check list_local_models to see whether the file landed before deciding.`
                        : `\n    cancelled — the partial was left on disk and can be resumed by re-issuing the download (it picks up where it left off)`) +
                    // A recovery-critical note from cancellation cleanup (e.g. a previous
                    // destination file preserved under a .bak path because it couldn't be
                    // restored) — surface it so the user can recover, not mask it.
                    (j.error ? `\n    IMPORTANT: ${j.error}` : "")
                  : `\n    still streaming — started ${Math.round((Date.now() - j.started_at) / 1000)}s ago`;
          const staleNote =
            j.status === "downloading" && j.staleInflight
              ? `\n    NOTE: heartbeat stale for ${Math.round((j.staleForMs ?? 0) / 1000)}s. The owning session may have reconnected, and the transfer may still be running. Do NOT re-issue download_model action:"download" while this warning remains: the original owner may still be writing the same .partial. To recover, call download_model \`action:"cancel"\` with this id and tray_id — it closes the stale record once the writer is PROVEN gone (its process no longer exists) and refuses while that cannot be proven. After a successful cancel, re-issuing action:"download" resumes any .partial the dead writer left, or restarts cleanly. Do not report this download as failed or missing.`
              : "";
          // Surface a declined resume so the agent/user knows a pre-existing
          // .partial was discarded and why — instead of it being silent (#467).
          // The decision is stored on THIS job by its own physical download, so it
          // can never be a stale/other job's.
          const diag = j.resume;
          let resumeNote = "";
          if (diag && diag.outcome !== "resumed") {
            const gb = (diag.discardedBytes / 1024 ** 3).toFixed(2);
            const why =
              diag.outcome === "declined:no-validator"
                ? "the host sent no ETag/Last-Modified validator to verify a safe resume (common on Hugging Face's Xet/CAS CDN)"
                : diag.outcome === "declined:full-response"
                  ? "the host answered with a full response instead of a 206 — the upstream changed, or it doesn't support resuming"
                  : diag.outcome === "declined:unverifiable"
                    ? "the resume crossed origins to a CDN that gave no content-addressed validator, so an unchanged upstream couldn't be proven"
                    : "the upstream file changed since the partial was written, so appending would corrupt it";
            // Honest about BOTH what happened to the partial and what's next.
            // A 206 refusal whose removal failed (diag.discarded === false) must
            // NOT claim the partial was discarded (#467).
            const fate = diag.discarded
              ? `discarded ${gb} GB of a prior .partial`
              : `refused to append a ${gb} GB prior .partial but could NOT remove it (delete the .partial manually if a retry keeps failing)`;
            const next =
              j.status === "error"
                ? diag.discarded
                  ? 'the resume was REJECTED for safety — re-issue download_model action:"download" to restart cleanly'
                  : 'the resume was REJECTED for safety — re-issue download_model action:"download" to retry'
                : "re-downloading in full";
            resumeNote = `\n    resume: ${diag.outcome} — ${fate} because ${why}; ${next}`;
          }
          return `${head}${detail}${collisionNote}${staleNote}${resumeNote}\n    from: ${j.url}`;
        });

        const header =
          collidingIds.length > 0
            ? `## Downloads\n\nNOTE: ${collidingIds.length} id(s) below name MORE THAN ONE download (same destination file, different source URLs). Use the \`tray_id\` shown on each row — not the id alone — with \`action:"status"\` and \`action:"cancel"\`.\n`
            : "## Downloads\n";
        return { content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }] };
      } catch (err) {
        return errorToToolResult(err);
      }
}

/** ← the retired standalone download-cancel tool (now action:"cancel"). */
async function cancelAction(args: { id: string; tray_id?: string }): Promise<CallToolResult> {
      try {
        const res = cancelDownloadJob(args.id, args.tray_id);
        if (!res.found) {
          const candidates = res.candidates ?? [];
          return {
            content: [
              {
                type: "text",
                text: candidates.length > 0
                  ? `No download with id \`${args.id}\` AND tray \`${args.tray_id}\`. The id is tracked, but its tray ids are: ${candidates.map((c) => `\`${c.trayId}\` (${c.status})`).join(", ")}. Re-check \`action:"status"\` and use one of those.`
                  : `No download with id \`${args.id}\` to cancel. It may have already finished and been pruned, or the id is wrong — check \`action:"status"\`.`,
              },
            ],
          };
        }
        if (res.ambiguous) {
          const rows = (res.candidates ?? [])
            .map(
              (c) =>
                `  - tray \`${c.trayId}\` — ${c.status}, started ${Math.round((Date.now() - c.started_at) / 1000)}s ago, from: ${c.url}`,
            )
            .join("\n");
          return {
            content: [
              {
                type: "text",
                text:
                  `Refusing to cancel \`${args.id}\` on the id alone: it denotes MORE than one download — different source URLs ` +
                  `writing the SAME destination file, so cancelling by id could stop the wrong one.\n` +
                  (rows ? `${rows}\n\n` : "\n") +
                  `Re-run download_model \`action:"cancel"\` with \`tray_id\` set to the one you want stopped. ` +
                  `(A download left over from a PREVIOUS session is selectable this way too: with its tray_id, action:"cancel" closes it once the writer is proven gone, and refuses — pointing at the panel download tray — while the writer may still be alive.)`,
              },
            ],
          };
        }
        if (res.aborted) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Cancellation requested for \`${args.id}\` — the transfer is being aborted. ` +
                  `If it hadn't finished, it stops with a resumable partial and nothing corrupt lands (re-issue the same download later to resume). ` +
                  `If it had ALREADY completed at the moment you cancelled, the finished file is present and the download reports as done — that's expected (cancel lost the race), not a bug. ` +
                  `Check download_model \`action:"status"\` with this id to see the final state. ` +
                  `(If this was a remote/ComfyUI-Manager server-side download, the host may keep fetching — there's no Manager API to stop it.)`,
              },
            ],
          };
        }
        if (res.reclaimed) {
          // #858: the record said "downloading" but its writer is PROVEN gone — no
          // live transfer existed to abort, so say exactly what happened and give
          // the one remedy that now works: re-issue.
          return {
            content: [
              {
                type: "text",
                text:
                  `Download \`${args.id}\` was still listed as downloading from a previous session, but that session is confirmed GONE — its process no longer exists and its heartbeat had stopped — so there was no live transfer left to abort. ` +
                  `The stale record has been closed as **cancelled**.` +
                  (res.staleRecordLeft
                    ? ` The dead session's original record file could not be deleted (a transient filesystem error), so action:"status" may keep showing its stale row for a while — it no longer blocks cancelling or re-issuing, and it expires on its own.`
                    : "") +
                  `\n\n` +
                  (res.job?.viaManager
                    ? `It was a remote ComfyUI-Manager dispatch, so the host MAY still be fetching server-side (there is no Manager recall API) — check list_local_models to see whether the file landed. Re-issuing starts a NEW dispatch, not a resume.`
                    : `To get the file, re-issue the same download_model \`action:"download"\` request: it resumes from any .partial the dead session left on disk, or restarts cleanly if there is none.`),
              },
            ],
          };
        }
        if (!res.owned) {
          // A SETTLED record from another session is an idempotent no-op, not a
          // refusal — "can't be aborted" about a download that already finished
          // would report failure for work that succeeded.
          if (res.status && res.status !== "downloading") {
            return {
              content: [
                {
                  type: "text",
                  text: `Download \`${args.id}\` is already **${res.status}** — nothing to cancel.`,
                },
              ],
            };
          }
          // Still (possibly) in flight under another session. WHY we cannot act
          // differs, and the difference carries the remedy (#858 refuse-vs-disclose):
          const staleSecs = Math.round((res.job?.staleForMs ?? 0) / 1000);
          const detail =
            res.reclaimDenied === "owner-alive"
              ? `its heartbeat has been stale for ${staleSecs}s, but the session that started it is STILL RUNNING (its process is alive), so the transfer may still be writing the .partial and aborting it from here is refused`
              : res.reclaimDenied === "owner-unknown"
                ? `its heartbeat has been stale for ${staleSecs}s, but whether the writing session is gone cannot be proven from here (its record carries no writer identity to check), so aborting it from here is refused — it may still be writing`
                : res.reclaimDenied === "persist-failed"
                  ? `the session that started it is confirmed gone, but closing its stale record failed transiently`
                  : `it is owned by another session with a live heartbeat, so the transfer is actively writing`;
          const remedy =
            res.reclaimDenied === "persist-failed"
              ? `Retry download_model \`action:"cancel"\`.`
              : `Stop it from the panel download tray instead.`;
          return {
            content: [
              {
                type: "text",
                text:
                  `Download \`${args.id}\` is tracked (status: ${res.status}) but was started by a different/previous server session: ${detail}. ` +
                  remedy,
              },
            ],
          };
        }
        // Found + owned but already settled — idempotent no-op.
        return {
          content: [
            {
              type: "text",
              text: `Download \`${args.id}\` is already **${res.status}** — nothing to cancel.`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
}

/**
 * What an EMPTY model listing is entitled to claim (#918).
 *
 * Three different situations used to print the same sentence:
 *   1. ComfyUI answered for every category and every one was empty — a genuinely
 *      empty install. "No models found" is true, and only here.
 *   2. Some categories answered, others didn't — we know less than we're asked.
 *   3. Nothing answered and there is no local path to scan (the remote/warming-up
 *      case) — we know NOTHING, and the old text asserted an empty install.
 *
 * Exported for tests: the distinction is the fix, so it is pinned directly.
 */
export function describeEmptyModelListing(
  modelType: string | undefined,
  coverage: ModelListingCoverage,
): string {
  const scope = modelType ? `${modelType} models` : "local models";
  if (coverage.unanswered.length === 0) {
    // Verified: the server was asked and said zero. For a FILTERED call that is
    // a true statement about ONE folder, and #962 is what it costs when it is
    // read as a fact about the install: a reporter's UNETLoader was loading
    // krastBf16_v3.safetensors while "diffusion_models" and "unet" both
    // answered 200 with []. The weights were registered under neither name.
    //
    // The unfiltered path discovers every registered category; a filtered one
    // skips discovery precisely because it "already names its exact category".
    // So say which other folders this server actually has.
    const others = coverage.otherRegisteredCategories;
    if (modelType && others !== undefined && others.length > 0) {
      const shown = others.slice(0, 20).join(", ");
      const more = others.length > 20 ? `, …and ${others.length - 20} more` : "";
      return (
        `No models in "${modelType}" — ComfyUI answered for that category and it is empty.\n\n` +
        `That is a fact about ONE folder, not about this install. This server also registers: ` +
        `${shown}${more}.\n\n` +
        `Weights a custom node, a fork, or an extra_model_paths entry registered under another ` +
        `key are loadable in a workflow while being absent from "${modelType}" — so if a loader ` +
        `on the canvas is offering a file, it is coming from one of those. Run list_local_models ` +
        `with NO model_type to list every registered category, or name one of the above.`
      );
    }
    return modelType ? `No ${modelType} models found.` : "No local models found.";
  }

  const detail = coverage.unanswered
    .slice(0, 8)
    .map((u) => `- ${u.dir}: ${u.reason}`)
    .join("\n");
  const more =
    coverage.unanswered.length > 8 ? `\n- …and ${coverage.unanswered.length - 8} more` : "";

  if (coverage.answered.length === 0) {
    // We learned nothing at all. Say that, and do NOT say "none".
    return (
      `Could not determine which ${scope} are installed — ComfyUI did not answer the model listing. ` +
      `This is NOT the same as having none: the models may be present and simply unlistable right now.\n\n` +
      `Categories that could not be read:\n${detail}${more}\n\n` +
      (coverage.noSourceAvailable
        ? `There is also no local ComfyUI path to scan as a fallback (this is a remote/cloud setup), so there is no second source to check.\n\n`
        : "") +
      `Most often the server is still starting, or a proxy is returning HTML instead of JSON. ` +
      `Retry in a few seconds; if it persists, check the ComfyUI URL with get_system_stats (action:"health") before concluding anything about the install.`
    );
  }

  return (
    `No ${scope} were found in the categories ComfyUI answered for (${coverage.answered.join(", ")}), ` +
    `but ${coverage.unanswered.length} categor${coverage.unanswered.length === 1 ? "y" : "ies"} could not be read, ` +
    `so this is a PARTIAL answer — models may exist in the categories below.\n\n${detail}${more}\n\n` +
    `Retry before concluding they are absent.`
  );
}

/** ← list_local_models (the pre-fold single-purpose tool) */
async function listAction(args: {
  model_type?: z.infer<typeof modelTypeEnum>;
}): Promise<CallToolResult> {
      try {
        const { models, coverage } = await listLocalModelsWithCoverage(args.model_type);

        if (models.length === 0) {
          // #918: "found none" is a CLAIM, and it may not be one we're entitled
          // to make. When a category never answered — server warming up, a proxy
          // returning HTML, no route to it at all — its emptiness is unknown, and
          // saying "No models found" reads as a verified empty install. A reporter
          // acted on exactly that and told a user their URL was misconfigured; the
          // same call succeeded minutes later.
          return {
            content: [{ type: "text", text: describeEmptyModelListing(args.model_type, coverage) }],
          };
        }
        // Some categories answered and some didn't: the list below is real but
        // PARTIAL, and a missing model may simply be in the part we couldn't read.
        const partial =
          coverage.unanswered.length > 0 && !coverage.usedFilesystem
            ? `\n\n⚠ Partial listing — ${coverage.unanswered.length} categor${coverage.unanswered.length === 1 ? "y" : "ies"} could not be read ` +
              `(${coverage.unanswered.map((u) => `${u.dir}: ${u.reason}`).join("; ")}). ` +
              `Models in those categories are NOT absent, they are unlisted — retry if something you expect is missing.`
            : "";

        // Group by type
        const grouped = new Map<string, typeof models>();
        for (const m of models) {
          const list = grouped.get(m.type) ?? [];
          list.push(m);
          grouped.set(m.type, list);
        }

        const lines: string[] = [];
        for (const [type, list] of grouped) {
          lines.push(`## ${type} (${list.length})`);
          for (const m of list) {
            // Size/modified are only populated on the filesystem-scan path.
            // The HTTP /models endpoint just returns filenames, so we render
            // a bare name in that case.
            if (m.size > 0) {
              const sizeMB = (m.size / 1024 / 1024).toFixed(1);
              lines.push(`- ${m.name} (${sizeMB} MB) — modified ${m.modified}`);
            } else {
              lines.push(`- ${m.name}`);
            }
            // Surface CivitAI sidecar hints so the agent applies the trigger
            // words (and picks the right base model) when it builds a workflow.
            if (m.triggerWords && m.triggerWords.length > 0) {
              lines.push(
                `    trigger words: ${m.triggerWords.join(", ")}` +
                  (m.baseModel ? `  ·  base: ${m.baseModel}` : ""),
              );
            } else if (m.baseModel) {
              lines.push(`    base: ${m.baseModel}`);
            }
            // Provenance: the sidecar's CivitAI page URL carries the modelId
            // and the INSTALLED modelVersionId — link back to the source, and
            // let clients check whether a newer version exists on CivitAI.
            if (m.civitaiUrl) {
              lines.push(`    civitai: ${m.civitaiUrl}`);
            }
          }
          lines.push("");
        }

        return { content: [{ type: "text", text: lines.join("\n") + partial }] };
      } catch (err) {
        return errorToToolResult(err);
      }
}
