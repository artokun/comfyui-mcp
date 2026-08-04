import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  searchHuggingFaceModels,
  listLocalModels,
  currentLiveModelsRoot,
  MODEL_SUBDIRS,
} from "../services/model-resolver.js";
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

export function registerModelManagementTools(server: McpServer): void {
  server.tool(
    "search_models",
    "Search HuggingFace Hub for models usable in ComfyUI (checkpoints, LoRAs, VAEs, ControlNets, etc.). Read-only and network-only: queries HuggingFace over HTTP, does NOT require a running ComfyUI or COMFYUI_PATH and does not download anything. Returns a ranked list with modelId, author, downloads, likes, and tags. Pick a result's download URL and pass it to download_model to install it locally. For CIVITAI searches ('find a Flux LoRA on Civitai') use search_civitai_models instead — it filters by type + base model and returns ids for download_civitai_model. For packs of custom nodes (not models) use search_custom_nodes.",
    {
      query: z.string().describe("Search query (e.g. 'SDXL', 'flux', 'controlnet')"),
      filter: z
        .string()
        .optional()
        .describe("Optional HuggingFace pipeline/library tag to narrow results, e.g. 'diffusers' or 'text-to-image'"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results to return (default 10)"),
    },
    async (args) => {
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
                  `   Tags: ${m.tags.slice(0, 5).join(", ") || "none"}`,
              )
              .join("\n\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "download_model",
    "Download a model file to the connected ComfyUI's models directory from a URL (HuggingFace, direct HTTP(S), s3://, or Azure Blob). PREFER this over a raw shell download (curl/wget) for model weights: it lands the file in the right models/ subfolder. LOCAL ComfyUI: streams to disk and surfaces live progress in the panel download tray. REMOTE ComfyUI: dispatches the fetch to the ComfyUI host via the ComfyUI-Manager install-model HTTP API (downloaded server-side; a per-request `auth` header can't be forwarded). This requires the host's Manager to run with network_mode=personal_cloud (or loopback) and a permissive security level — a stricter gate silently rejects the download, and Manager reports the queue task 'done' even on failure, so a remote dispatch does not guarantee the file landed. target_subfolder accepts any relative subfolder (incl. nested, e.g. 'loras/<subdir>').",
    {
      url: z.string().url().describe("Direct download URL for the model file"),
      target_subfolder: downloadTargetSchema,
      filename: z
        .string()
        .optional()
        .describe("Override filename (auto-detected from URL if omitted)"),
      auth: downloadAuthSchema
        .optional()
        .describe(
          "Optional per-request authentication for private/gated model URLs. " +
            "When provided it overrides built-in HuggingFace/CivitAI token handling.",
        ),
    },
    async (args) => {
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
          const text = job.viaManager
            ? `Download DISPATCHED to the remote ComfyUI via ComfyUI-Manager (server-side fetch):\n${job.path}\n\n` +
              `NOTE: ${placement.warning}`
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
          // A concurrent cancel_download landed during this grace window (e.g. a reissue
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
                `Tell the user it is downloading, then check \`download_status\` with this id ` +
                `when they ask. Do NOT call download_model again for this URL — a repeat ` +
                `request adopts the same job rather than starting a second copy, but saying ` +
                `"I'll leave it to you" or reporting it as incomplete would be wrong.`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "download_status",
    "Check on model downloads started by download_model. Reports each download's state (downloading / done / error / cancelled), its destination path once it lands, and byte progress when the panel progress channel is enabled. " +
      "Use this after download_model reports a download is still running — that means the transfer is in flight, NOT that it failed. " +
      "Survives a sidebar/tool-session reconnect: an in-flight download started in a previous session is still resolvable by its id (or by `url`), so you can confirm it's still running instead of starting a duplicate. Read-only.",
    {
      id: z
        .string()
        .optional()
        .describe("Download id from download_model. Omit to list every tracked download (incl. in-flight ones from before a reconnect)."),
      tray_id: z
        .string()
        .optional()
        .describe("Disambiguator, shown on every row as `(tray <tray_id>)`. Only needed when two rows share one `id` — two different source URLs downloading to the SAME destination file. Pass it WITH `id` to select exactly one of them."),
      url: z
        .string()
        .url()
        .optional()
        .describe("Adopt an in-flight download by its source URL when you don't have the id (e.g. after a reconnect) — reports the matching job without starting a duplicate."),
    },
    async (args) => {
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
                    `Re-run download_status with \`tray_id\` set to the one you mean. ` +
                    `Note that two of these are writing the SAME file — decide which to keep and cancel_download the other (also by \`tray_id\`).`,
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
                  ? `No download matching ${selector}. It has either finished long ago (settled records are pruned after a while) or never started — check the panel download tray before re-downloading. Within the SAME session, re-issuing an identical in-flight download adopts it rather than duplicating; across a reconnect, confirm via the tray first.`
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
            ? `\n    AMBIGUOUS id: another row in this listing shares \`${j.id}\` — these are DIFFERENT source URLs writing the SAME destination file, so the last writer wins and the result may be a mix. Select this one with \`tray_id\`: \`${j.trayId}\`. Pass that same tray_id to cancel_download to stop THIS one specifically.`
            : "";
          // Same single placement policy the download_model renderer uses (#369):
          // a bare "landed at" is only ever printed for a CONFIRMED placement.
          const placement =
            j.status === "done" ? describePlacement(j, { liveModelsDir }) : undefined;
          const detail =
            j.status === "done" && placement
              ? j.viaManager
                ? `\n    dispatched to the remote ComfyUI via ComfyUI-Manager (server-side fetch): ${j.path}\n    NOTE: ${placement.warning}`
                : placement.confirmed
                  ? `\n    ${placement.pathLabel}${placement.pathQualifier}: ${j.path}`
                  : `\n    ${placement.pathLabel}${placement.pathQualifier}: ${j.path}\n    ${placement.wrongPlace ? "WARNING" : "NOTE"}: ${placement.warning}`
              : j.status === "error"
                ? `\n    failed: ${j.error}`
                : j.status === "cancelled"
                  ? (j.viaManager
                      ? `\n    cancelled — this was a remote ComfyUI-Manager dispatch, so there is NO local partial to resume, and the host MAY still be fetching server-side (there's no Manager recall API). Re-issuing starts a NEW server-side dispatch (a duplicate, not a resume). Check list_local_models to see whether the file landed before deciding.`
                      : `\n    cancelled — the partial was left on disk and can be resumed by re-issuing the download (it picks up where it left off)`) +
                    // A recovery-critical note from cancellation cleanup (e.g. a previous
                    // destination file preserved under a .bak path because it couldn't be
                    // restored) — surface it so the user can recover, not mask it.
                    (j.error ? `\n    IMPORTANT: ${j.error}` : "")
                  : `\n    still streaming — started ${Math.round((Date.now() - j.started_at) / 1000)}s ago`;
          const staleNote =
            j.status === "downloading" && j.staleInflight
              ? `\n    NOTE: heartbeat stale for ${Math.round((j.staleForMs ?? 0) / 1000)}s. The owning session may have reconnected, and the transfer may still be running. Do NOT re-issue download_model while this warning remains: the original owner may still be writing the same .partial. Wait and check download_status again; only after confirming the .partial has stopped growing should you decide on recovery. Do not report this download as failed or missing.`
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
                  ? "the resume was REJECTED for safety — re-issue download_model to restart cleanly"
                  : "the resume was REJECTED for safety — re-issue download_model to retry"
                : "re-downloading in full";
            resumeNote = `\n    resume: ${diag.outcome} — ${fate} because ${why}; ${next}`;
          }
          return `${head}${detail}${collisionNote}${staleNote}${resumeNote}\n    from: ${j.url}`;
        });

        const header =
          collidingIds.length > 0
            ? `## Downloads\n\nNOTE: ${collidingIds.length} id(s) below name MORE THAN ONE download (same destination file, different source URLs). Use the \`tray_id\` shown on each row — not the id alone — with download_status and cancel_download.\n`
            : "## Downloads\n";
        return { content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "cancel_download",
    "Cancel ONE in-flight model download started by download_model / download_civitai_model, by its id (from download_status or the tool that started it). Aborts only that download's transfer — other downloads keep running. The partially-downloaded bytes are left on disk as a resumable .partial and are NEVER reported as a completed file, so nothing corrupt lands in your models directory; re-issuing the same download later resumes where it left off. Idempotent: cancelling an already-finished, failed, or already-cancelled download just reports its current state. Only downloads owned by the current server session can be aborted — a download started before a reconnect is reported but must be stopped from the panel download tray. NOTE: for a download dispatched to a REMOTE ComfyUI via ComfyUI-Manager (server-side fetch), the local job is marked cancelled but the host may keep fetching — there is no Manager API to stop it.",
    {
      id: z
        .string()
        .min(1)
        .describe("The download id to cancel (from download_model / download_civitai_model / download_status)."),
      tray_id: z
        .string()
        .optional()
        .describe("Disambiguator, shown on every download_status row as `(tray <tray_id>)`. Required only when the `id` names more than one download (two different source URLs writing the SAME destination file) — then it selects exactly which one to abort."),
    },
    async (args) => {
      try {
        const res = cancelDownloadJob(args.id, args.tray_id);
        if (!res.found) {
          const candidates = res.candidates ?? [];
          return {
            content: [
              {
                type: "text",
                text: candidates.length > 0
                  ? `No download with id \`${args.id}\` AND tray \`${args.tray_id}\`. The id is tracked, but its tray ids are: ${candidates.map((c) => `\`${c.trayId}\` (${c.status})`).join(", ")}. Re-check download_status and use one of those.`
                  : `No download with id \`${args.id}\` to cancel. It may have already finished and been pruned, or the id is wrong — check download_status.`,
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
                  `Re-run cancel_download with \`tray_id\` set to the one you want stopped. ` +
                  `(A download owned by a PREVIOUS session still cannot be aborted from here — that one must be stopped from the panel download tray — but it is now selectable, so you can at least confirm which it is with download_status.)`,
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
                  `Check \`download_status\` with this id to see the final state. ` +
                  `(If this was a remote/ComfyUI-Manager server-side download, the host may keep fetching — there's no Manager API to stop it.)`,
              },
            ],
          };
        }
        if (!res.owned) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Download \`${args.id}\` is tracked (status: ${res.status}) but was started by a different/previous server session, so it can't be aborted from here. ` +
                  `Stop it from the panel download tray instead.`,
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
    },
  );

  server.tool(
    "list_local_models",
    "List model files available to the connected ComfyUI, grouped by type. Read-only. Queries ComfyUI's /models REST endpoint first (works with remote ComfyUI and respects extra_model_paths.yaml — symlinked / mounted dirs the install-path filesystem scan would miss), then falls back to a filesystem scan of COMFYUI_PATH/models/ when the REST endpoint is unavailable. Size and modified time are only available on the filesystem fallback path. Use to see which models are already available before generating or downloading; use search_models to discover new models on HuggingFace, then download_model to fetch them. For models fetched via download_civitai_model, any CivitAI trigger/activation words and base model are shown inline (read from the `<file>.civitai.json` sidecar) — apply those trigger words in your prompt when generating with that model. A `civitai:` line under an entry is that model's CivitAI page URL (modelId + INSTALLED modelVersionId, from the same sidecar) — use it to reference the source or check for newer versions.",
    {
      model_type: modelTypeEnum
        .optional()
        .describe(
          "Filter by model type (e.g. 'checkpoints', 'loras'). Lists all types if omitted.",
        ),
    },
    async (args) => {
      try {
        const models = await listLocalModels(args.model_type);

        if (models.length === 0) {
          const scope = args.model_type
            ? `No ${args.model_type} models found.`
            : "No local models found.";
          return { content: [{ type: "text", text: scope }] };
        }

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

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
