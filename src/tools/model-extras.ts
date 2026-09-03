import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { unlink, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isLocalMode, config } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  resolveExistingModelFile,
  currentLiveModelsRoot,
} from "../services/model-resolver.js";
import { startDownloadJob, describePlacement } from "../services/download-jobs.js";
import type { DownloadAuth } from "../services/download-auth.js";

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
  type CivitaiLeaderboard,
  type CivitaiMetadata,
  type CivitaiSort,
} from "../services/civitai-resolver.js";
import { ValidationError, errorToToolResult } from "../utils/errors.js";

/**
 * The four model "extras" handlers, no longer registered as tools of their own.
 *
 * 0.50.0 slice 11 folded them into the two action-parameterized survivors in
 * ./model-management.ts — the model-file deleter became list_local_models
 * (action:"remove") and the three CivitAI tools became download_model
 * (action:"search_civitai"|"search_creators"|"download_civitai"). The BODIES are
 * unchanged and stay here, next to the CivitAI resolver imports and the sidecar
 * writer they use; only the wrapper changed, from `server.tool(...)` to an
 * exported function the dispatcher calls. Per-action requiredness is enforced by
 * the dispatcher before it calls these, so each one still receives exactly the
 * arguments its old schema guaranteed.
 */

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

export async function removeModelAction(args: { path: string }): Promise<CallToolResult> {
      if (!isLocalMode()) {
        return remoteUnsupported(
          'list_local_models action:"remove" is not supported against a remote ComfyUI. It deletes a ' +
            "file on the ComfyUI host's local filesystem, which the MCP cannot " +
            "reach in remote (--comfyui-url / COMFYUI_URL) mode. Delete the file " +
            "directly on the ComfyUI host instead.",
        );
      }
      try {
        const { path: target, info } = await resolveExistingModelFile(args.path, {
          mode: "remove",
        });

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
}

export async function searchCivitaiModelsAction(args: {
  query?: string;
  creator?: string;
  types?: string[];
  base_models?: string[];
  sort?: CivitaiSort;
  nsfw?: boolean;
  limit?: number;
}): Promise<CallToolResult> {
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
                    ? `, check the exact username with download_model action:"search_creators" (creators with only NSFW models need nsfw:true)`
                    : "") +
                  `, or search HuggingFace with download_model action:"search".` +
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
                `Next: download_model {"action": "download_civitai", "model_version_id": <id>, "target_subfolder": "<loras|checkpoints|...>"} — then use the trigger words in the prompt.` +
                capNote +
                tokenNote,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
}

export async function searchCivitaiCreatorsAction(args: {
  query?: string;
  board?: CivitaiLeaderboard;
  limit?: number;
}): Promise<CallToolResult> {
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
                  `Next: download_model {"action": "search_civitai", "creator": "<username>"} to list a creator's models.`,
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
                `Next: download_model {"action": "search_civitai", "creator": "<username>"} to list a creator's models, then action:"download_civitai".`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
}

export async function downloadCivitaiModelAction(args: {
  target_subfolder: string;
  model_version_id?: number;
  model_id?: number;
  filename?: string;
  auth?: DownloadAuth;
  model_root?: string;
}): Promise<CallToolResult> {
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
                `If the user wanted a LoRA/checkpoint, re-run download_model action:"search_civitai" with types:["LORA"] (or ["Checkpoint"]) and download a hit whose type matches. Do not tell the user a model was installed.`,
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
          args.auth,
          postDownload,
          undefined,
          args.model_root,
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
                  `downloading, then read download_model \`action:"status"\` with this id — do not re-issue the ` +
                  `download and do not report it as incomplete.`,
              },
            ],
          };
        }
        if (job.status === "cancelled") {
          // A concurrent download_model action:"cancel" landed during this grace window — do NOT fall
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
        // ONE placement policy shared with download_model action:"download"/"status" (#369):
        // "downloaded successfully" is licensed ONLY by a placement the connected
        // ComfyUI actually confirmed. Anything else is reported with its caveat.
        const placement = describePlacement(job, {
          liveModelsDir: await currentLiveModelsRoot(),
        });
        const lines = job.viaManager
          ? [
              "CivitAI model DISPATCHED to the remote ComfyUI via ComfyUI-Manager (server-side fetch):",
              `  ${savedPath}`,
              `  NOTE: ${placement.warning}`,
            ]
          : placement.confirmed
            ? [
                `CivitAI model downloaded successfully${placement.pathQualifier}:`,
                `  ${savedPath}`,
              ]
            : placement.wrongPlace
              ? [
                  "CivitAI download finished, but the model is NOT usable by the connected ComfyUI.",
                  `  ${placement.pathLabel}${placement.pathQualifier}: ${savedPath}`,
                  `  ${placement.warning}`,
                  "  Do NOT tell the user the model is ready — it is not visible to the server that would load it.",
                ]
              : [
                  `CivitAI model ${placement.pathLabel}${placement.pathQualifier}:`,
                  `  ${savedPath}`,
                  `  NOTE: ${placement.warning}`,
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
}
