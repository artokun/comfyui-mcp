import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { unlink, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isLocalMode, config } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  resolveExistingModelFile,
  MODEL_SUBDIRS,
} from "../services/model-resolver.js";
import { startDownloadJob } from "../services/download-jobs.js";

/** Mirrors download_model's grace window — see download-jobs.ts. CivitAI
 *  checkpoints are routinely multi-GB, so this is the path that actually
 *  triggered the reported hang. */
function civitaiGraceMs(): number {
  const raw = Number(process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 20_000;
}
import {
  resolveCivitaiModel,
  resolveCivitaiModelVersion,
  buildCivitaiMarkdown,
  searchCivitaiModels,
  searchCivitaiCreators,
  fetchCivitaiTopCreators,
  type CivitaiMetadata,
} from "../services/civitai-resolver.js";
import { ValidationError, errorToToolResult } from "../utils/errors.js";

/**
 * Write the CivitAI metadata sidecars next to a freshly downloaded model:
 * `<file>.civitai.json` (structured, incl. example generation params) and
 * `<file>.civitai.md` (agent-readable usage docs + example recipes). Best-effort
 * — a sidecar failure never fails the download. Returns the sidecar paths written.
 */
async function writeCivitaiSidecar(
  savedPath: string,
  metadata: CivitaiMetadata,
): Promise<{ json: string; md: string } | null> {
  try {
    const jsonPath = `${savedPath}.civitai.json`;
    const mdPath = `${savedPath}.civitai.md`;
    await writeFile(jsonPath, JSON.stringify(metadata, null, 2), "utf8");
    await writeFile(mdPath, buildCivitaiMarkdown(metadata), "utf8");
    return { json: jsonPath, md: mdPath };
  } catch (err) {
    logger.warn("Failed to write CivitAI metadata sidecar", {
      savedPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Graceful "not supported remotely" tool result (no isError), matching the
 *  degrade-don't-throw pattern list_local_models uses. */
function remoteUnsupported(message: string) {
  return { content: [{ type: "text" as const, text: message }] };
}

export function registerModelExtrasTools(server: McpServer): void {
  server.tool(
    "remove_model",
    "Delete a model file from the local ComfyUI models directories. Resolves the " +
      "path across ALL configured roots — the primary <COMFYUI_PATH>/models AND " +
      "every directory in extra_model_paths.yaml / extra_models_config.yaml (e.g. " +
      "models stored on another drive like E:\\) — the same roots ComfyUI loads " +
      "from. The path must stay within a known root (path traversal and absolute " +
      "escapes are rejected). LOCAL-ONLY: deletes from the local filesystem, so it " +
      "is not supported against a remote ComfyUI (remove the file on the host).",
    {
      path: z
        .string()
        .min(1)
        .describe(
          "Model file path relative to the ComfyUI models/ directory " +
            "(e.g. 'checkpoints/sd_xl_base_1.0.safetensors'). The leading segment " +
            "is the category used to locate the file in extra roots too.",
        ),
    },
    async (args) => {
      if (!isLocalMode()) {
        return remoteUnsupported(
          "remove_model is not supported against a remote ComfyUI. It deletes a " +
            "file on the ComfyUI host's local filesystem, which the MCP cannot " +
            "reach in remote (--comfyui-url / COMFYUI_URL) mode. Delete the file " +
            "directly on the ComfyUI host instead.",
        );
      }
      try {
        const { path: target, info } = await resolveExistingModelFile(args.path);

        if (!info.isFile()) {
          throw new ValidationError(
            `Not a file (refusing to remove): ${args.path}`,
          );
        }

        const sizeMB = (info.size / 1024 / 1024).toFixed(1);
        await unlink(target);

        return {
          content: [
            {
              type: "text" as const,
              text: `Removed model:\n  ${target}\n  (${sizeMB} MB freed)`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "search_civitai_models",
    "Search CivitAI by keyword for checkpoints, LoRAs, embeddings, VAEs, and ControlNets — THE tool for " +
      "'find me a <base model> LoRA on Civitai'. Read-only and network-only (public CivitAI REST API; no " +
      "token or running ComfyUI required; CIVITAI_API_TOKEN unlocks gated results). Filter by `types` " +
      "(LORA, Checkpoint, TextualInversion, VAE, Controlnet, …) and `base_models` (CivitAI labels: " +
      "'Flux.1 D', 'SDXL 1.0', 'SD 1.5', 'Pony', 'Illustrious', 'Wan Video') — ALWAYS pass base_models when " +
      "the user's checkpoint family is known, so results actually fit their setup. Each hit returns the " +
      "model_id and version_id that download_civitai_model takes directly, plus trigger words to use in the " +
      "prompt after installing. Flow: search_civitai_models → pick a hit → download_civitai_model " +
      "{model_version_id, target_subfolder} → wire/prompt with the trained words. Pass `creator` (exact " +
      "username, e.g. from search_civitai_creators) to list ONE creator's models — with or without a query. " +
      "SFW-only by default. For HuggingFace search use search_models.",
    {
      query: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Keyword search (e.g. 'detail enhancer', 'anime style', a character name). " +
            "Optional when creator is given (then it narrows that creator's models).",
        ),
      creator: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Only models by this CivitAI creator (EXACT username — find it with " +
            "search_civitai_creators). At least one of query/creator is required.",
        ),
      types: z
        .array(z.enum(["Checkpoint", "LORA", "LoCon", "DoRA", "TextualInversion", "VAE", "Controlnet", "Upscaler", "MotionModule", "Workflows"]))
        .optional()
        .describe("Only these model types (e.g. ['LORA'])."),
      base_models: z
        .array(z.string())
        .optional()
        .describe("Only these base-model families, CivitAI labels: 'Flux.1 D', 'SDXL 1.0', 'SD 1.5', 'Pony', 'Illustrious', 'Wan Video', …"),
      sort: z
        .enum(["Highest Rated", "Most Downloaded", "Newest"])
        .optional()
        .describe("Ranking (default 'Highest Rated')."),
      nsfw: z.boolean().optional().describe("Include NSFW results (default false)."),
      limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)."),
    },
    async (args) => {
      try {
        if (!args.query?.trim() && !args.creator?.trim()) {
          throw new ValidationError(
            "Provide a query, a creator (exact username), or both.",
          );
        }
        const { hits, scanned, scanCapped } = await searchCivitaiModels(args.query ?? "", {
          types: args.types,
          baseModels: args.base_models,
          sort: args.sort,
          nsfw: args.nsfw,
          limit: args.limit,
          creator: args.creator,
        });
        // Creator+keyword scans are bounded (client-side keyword filter over
        // paged results) — never present a capped miss as definitive.
        const capNote = scanCapped
          ? `\nNOTE: the keyword was matched client-side over only this creator's first ${scanned} models (scan cap) — matching models past that may exist. Narrow with types/base_models, or drop the query to list everything.`
          : "";
        const what = [
          args.query?.trim() && `"${args.query}"`,
          args.creator?.trim() && `creator ${args.creator}`,
        ]
          .filter(Boolean)
          .join(" by ");
        if (hits.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  `No CivitAI models matched ${what}` +
                  (args.base_models?.length ? ` for base ${args.base_models.join("/")}` : "") +
                  `. Try a broader query, drop the filters` +
                  (args.creator
                    ? `, check the exact username with search_civitai_creators (creators with only NSFW models need nsfw:true)`
                    : "") +
                  `, or search HuggingFace with search_models.` +
                  capNote,
              },
            ],
          };
        }
        const lines = hits.map((h, i) => {
          const stats = [
            h.base_model && `base ${h.base_model}`,
            h.downloads != null && `${h.downloads.toLocaleString()} downloads`,
            h.thumbs_up != null && `${h.thumbs_up} 👍`,
            h.size_mb && `~${h.size_mb} MB`,
            h.nsfw && "NSFW",
          ]
            .filter(Boolean)
            .join(" · ");
          const words = h.trained_words?.length ? `\n   trigger words: ${h.trained_words.join(", ")}` : "";
          return (
            `${i + 1}. **${h.name}** (${h.type ?? "?"}) by ${h.creator ?? "unknown"} — ${stats}\n` +
            `   model_id: ${h.model_id} · model_version_id: ${h.version_id ?? "?"} (${h.version_name ?? "latest"})${words}`
          );
        });
        // Civitai downloads are token-gated even though search is open — warn
        // BEFORE the model burns rounds on 401s (live E2E failure shape).
        const tokenNote = config.civitaiApiToken
          ? ""
          : `\nNOTE: no CIVITAI_API_TOKEN is configured — downloads WILL fail with 401 until the user sets one (panel Settings › “Set CivitAI token…”, or the CIVITAI_API_TOKEN env var; created at civitai.com/user/account). Ask them to set it before attempting a download.`;
        return {
          content: [
            {
              type: "text",
              text:
                `${hits.length} CivitAI result(s) for ${what}:\n\n${lines.join("\n\n")}\n\n` +
                `Next: download_civitai_model {"model_version_id": <id>, "target_subfolder": "<loras|checkpoints|...>"} — then use the trigger words in the prompt.` +
                capNote +
                tokenNote,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "search_civitai_creators",
    "Find CivitAI CREATORS — THE tool for 'who are the top creators on Civitai' and 'find creator <name>'. " +
      "Read-only and network-only (no token or running ComfyUI required). Two modes: with NO query it returns " +
      "the site's creator LEADERBOARD (civitai.com/leaderboard — rank, score, downloads, likes; pick a `board`: " +
      "'overall' [default], 'overall_90' [last 90 days], 'overall_nsfw' [mature], 'new_creators' [first model " +
      "<30 days ago]); with a `query` it searches usernames (public /api/v1/creators; partial match, returns " +
      "model counts, NOT ranked). Each hit's username feeds search_civitai_models {creator: <username>} " +
      "directly. Flow: search_civitai_creators → pick a creator → search_civitai_models {creator, types?} → " +
      "download_civitai_model. SCOPE CAVEAT: the /api/v1/creators index only lists creators who have published " +
      "MODELS. A creator who posts only images/videos (no models) legitimately returns 0 hits here — that is a " +
      "gap in this endpoint, NOT proof the creator doesn't exist. For a media-only creator, browse their images " +
      "via the panel CivitAI browser (panel_open_civitai {creator}) or the logged-in browser session instead.",
    {
      query: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Username search (partial match, e.g. 'alcait'). Omit to get the top-creators leaderboard instead.",
        ),
      board: z
        .enum(["overall", "overall_90", "overall_nsfw", "new_creators"])
        .optional()
        .describe(
          "Leaderboard to rank by when no query is given (default 'overall'). Ignored with a query.",
        ),
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)."),
    },
    async (args) => {
      try {
        if (args.query?.trim()) {
          const { hits, total } = await searchCivitaiCreators(args.query, {
            limit: args.limit,
          });
          if (hits.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `No CivitAI creators matched "${args.query}". Usernames match on substrings — ` +
                    `try a shorter fragment, or omit the query for the top-creators leaderboard. ` +
                    `Note: this index only covers creators who have published MODELS — a creator who ` +
                    `posts only images/videos won't appear here even if the exact username is correct. ` +
                    `For a media-only creator, browse their posts via the panel CivitAI browser instead.`,
                },
              ],
            };
          }
          const lines = hits.map(
            (h, i) =>
              `${i + 1}. **${h.username}** — ${h.model_count ?? 0} model(s) · ${h.profile_url}`,
          );
          return {
            content: [
              {
                type: "text",
                text:
                  `${hits.length} CivitAI creator(s) for "${args.query}"` +
                  (total != null ? ` (${total.toLocaleString()} total match${total === 1 ? "" : "es"})` : "") +
                  `:\n\n${lines.join("\n")}\n\n` +
                  `Next: search_civitai_models {"creator": "<username>"} to list a creator's models.`,
              },
            ],
          };
        }

        const board = args.board ?? "overall";
        const hits = await fetchCivitaiTopCreators({ board, limit: args.limit });
        if (hits.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `CivitAI returned an empty "${board}" leaderboard. Try again later or search by name with a query.`,
              },
            ],
          };
        }
        const lines = hits.map((h) => {
          const stats = [
            h.score != null && `score ${h.score.toLocaleString()}`,
            h.downloads != null && `${h.downloads.toLocaleString()} downloads`,
            h.thumbs_up != null && `${h.thumbs_up.toLocaleString()} 👍`,
            h.entries != null && `${h.entries} model(s) counted`,
          ]
            .filter(Boolean)
            .join(" · ");
          return `${h.position ?? "?"}. **${h.username}** — ${stats}\n   ${h.profile_url}`;
        });
        return {
          content: [
            {
              type: "text",
              text:
                `Top ${hits.length} CivitAI creators ("${board}" leaderboard):\n\n${lines.join("\n\n")}\n\n` +
                `Next: search_civitai_models {"creator": "<username>"} to list a creator's models, then download_civitai_model.`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "download_civitai_model",
    "Download a model from CivitAI into the connected ComfyUI's models/ directory. " +
      "Resolves a CivitAI model id (latest version) or a model-version id to a download " +
      "URL via the CivitAI REST API. LOCAL ComfyUI (COMFYUI_PATH set): streams the file " +
      "to disk under <COMFYUI_PATH>/models/<target_subfolder>/ and returns the saved " +
      "absolute path. REMOTE ComfyUI: dispatches the download to the ComfyUI host via " +
      "the ComfyUI-Manager install-model HTTP API (fetched server-side). Provide at least " +
      "one of model_id or model_version_id. Gated/early-access models require " +
      "CIVITAI_API_TOKEN locally (sent as a bearer header, never in the URL); remote " +
      "Manager-side fetches rely on tokens configured on the ComfyUI host. NOTE " +
      "(remote): the server-side install requires the host's ComfyUI-Manager to run " +
      "with network_mode=personal_cloud (or loopback) and a permissive security level; " +
      "a stricter gate silently rejects the download, and Manager reports the queue " +
      "task 'done' even on failure — so a remote dispatch does not guarantee the file landed.",
    {
      target_subfolder: z
        .string()
        .min(1)
        .describe(
          `Target subfolder under ComfyUI models/. Standard names: ${MODEL_SUBDIRS.join(", ")}. ` +
            `Any other relative subfolder (incl. nested like 'loras/<subdir>') is allowed; ` +
            `absolute paths and '..' escapes are rejected.`,
        ),
      model_version_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "CivitAI model-version id (from the URL ?modelVersionId=...). " +
            "If both model_id and model_version_id are given, this selects the " +
            "specific version of that model.",
        ),
      model_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "CivitAI model id. The latest version is used unless model_version_id " +
            "is also provided.",
        ),
      filename: z
        .string()
        .optional()
        .describe(
          "Override the saved filename (defaults to the CivitAI file name, or " +
            "the URL basename).",
        ),
    },
    async (args) => {
      try {
        if (args.model_id === undefined && args.model_version_id === undefined) {
          throw new ValidationError(
            "Provide either model_id or model_version_id.",
          );
        }

        const resolved =
          args.model_id !== undefined
            ? await resolveCivitaiModel(args.model_id, args.model_version_id)
            : await resolveCivitaiModelVersion(args.model_version_id!);

        const filename = args.filename ?? resolved.filename;

        // Everything that used to run inline AFTER the await now runs as the
        // job's completion hook, so it still happens when a big CivitAI
        // checkpoint outlives the tool call. Its output lands on job.notes.
        const postDownload = async (savedPath: string): Promise<string[]> => {
          const lines: string[] = [];
          // NOT-A-MODEL guard (live panel finding: the agent downloaded a
          // 'Workflows'-type zip into loras/ and told the user their LoRA was
          // installed). Loud warning when the entry type / file extension can't
          // load as a model so the agent corrects course instead of celebrating.
          const civitaiType = resolved.metadata?.modelType;
          const NON_MODEL_TYPES = new Set(["Workflows", "Poses", "Wildcards", "Other"]);
          const fileExt = (filename ?? savedPath).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
          const NON_MODEL_EXTS = new Set(["zip", "rar", "7z", "json", "txt", "png", "jpg"]);
          if ((civitaiType && NON_MODEL_TYPES.has(civitaiType)) || (fileExt && NON_MODEL_EXTS.has(fileExt))) {
            lines.push(
              `  WARNING: this CivitAI entry is type "${civitaiType ?? "unknown"}" (file: .${fileExt ?? "?"}) — it is NOT a loadable model file and will not appear in a ${args.target_subfolder} loader. ` +
                `If the user wanted a LoRA/checkpoint, re-run search_civitai_models with types:["LORA"] (or ["Checkpoint"]) and download a hit whose type matches. Do not tell the user a model was installed.`,
            );
          }

          // Write usage-docs sidecars beside the file so the panel agent has the
          // description, trigger words, and example generation params on hand.
          // Only when the file actually landed on the LOCAL filesystem: a real
          // streamed download returns an ABSOLUTE path, whereas a remote OR
          // reconnect-fallback Manager dispatch (#420) returns a human-readable
          // status descriptor — writing a sidecar beside that string would create a
          // stray file. isAbsolute(savedPath) distinguishes the two precisely
          // (a Manager dispatch is loopback-"local" mode too, so isLocalMode() alone
          // would misfire on the #420 fallback).
          if (isAbsolute(savedPath) && resolved.metadata) {
            const sidecar = await writeCivitaiSidecar(savedPath, resolved.metadata);
            if (sidecar) {
              const tw = resolved.metadata.trainedWords;
              if (tw.length) lines.push(`  Trigger words: ${tw.join(", ")}`);
              const recipes = resolved.metadata.examples.filter(
                (e) => e.meta && Object.keys(e.meta).length > 0,
              ).length;
              lines.push(
                `  Metadata: ${sidecar.md}` +
                  (recipes ? ` (${recipes} example recipe${recipes === 1 ? "" : "s"})` : ""),
              );
            }
          }
          return lines;
        };

        const { job, settled } = await startDownloadJob(
          resolved.downloadUrl,
          args.target_subfolder,
          filename,
          undefined,
          postDownload,
        );

        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          settled,
          new Promise<void>((r) => {
            timer = setTimeout(r, civitaiGraceMs());
          }),
        ]);
        if (timer) clearTimeout(timer);

        if (job.status === "error") {
          return errorToToolResult(new Error(job.error ?? "CivitAI download failed"));
        }
        if (job.status === "downloading") {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `CivitAI download STARTED and is still running — id \`${job.id}\`.\n` +
                  (resolved.modelName ? `  Model: ${resolved.modelName}\n` : "") +
                  `  Version id: ${resolved.versionId}\n\n` +
                  `This is NOT a failure. The file is streaming to disk and will land on its own; ` +
                  `trigger words and metadata are written when it completes. Tell the user it is ` +
                  `downloading, then read \`download_status\` with this id — do not re-issue the ` +
                  `download and do not report it as incomplete.`,
              },
            ],
          };
        }
        if (job.status === "cancelled") {
          // A concurrent cancel_download landed during this grace window — do NOT fall
          // through to the success renderer (which would dereference an unset job.path).
          return {
            content: [
              {
                type: "text" as const,
                text: job.viaManager
                  ? `CivitAI download \`${job.id}\` was cancelled. It was a remote ComfyUI-Manager dispatch, so there is no local partial to resume; the host MAY still be fetching server-side. Check list_local_models to see if it landed; re-issuing starts a NEW dispatch, not a resume.`
                  : `CivitAI download \`${job.id}\` was cancelled. A resumable partial may remain on disk — re-issue the same download to resume it.`,
              },
            ],
          };
        }

        const savedPath = job.path!;
        const lines = job.viaManager
          ? [
              "CivitAI model DISPATCHED to the remote ComfyUI via ComfyUI-Manager (server-side fetch):",
              `  ${savedPath}`,
              "  NOTE: the dispatch was ACCEPTED, NOT verified as landed — ComfyUI-Manager reports its queue task 'done' even on failure. Confirm with list_local_models before relying on it.",
            ]
          : [
              "CivitAI model downloaded successfully:",
              `  ${savedPath}`,
            ];
        if (resolved.modelName) lines.push(`  Model: ${resolved.modelName}`);
        lines.push(`  Version id: ${resolved.versionId}`);
        lines.push(...(job.notes ?? []));

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
