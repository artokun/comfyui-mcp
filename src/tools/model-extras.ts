import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { unlink, writeFile } from "node:fs/promises";
import { isLocalMode, config } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  downloadModel,
  resolveExistingModelFile,
  MODEL_SUBDIRS,
} from "../services/model-resolver.js";
import {
  resolveCivitaiModel,
  resolveCivitaiModelVersion,
  buildCivitaiMarkdown,
  searchCivitaiModels,
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
      "{model_version_id, target_subfolder} → wire/prompt with the trained words. SFW-only by default. " +
      "For HuggingFace search use search_models.",
    {
      query: z.string().min(1).describe("Keyword search (e.g. 'detail enhancer', 'anime style', a character name)"),
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
        const hits = await searchCivitaiModels(args.query, {
          types: args.types,
          baseModels: args.base_models,
          sort: args.sort,
          nsfw: args.nsfw,
          limit: args.limit,
        });
        if (hits.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  `No CivitAI models matched "${args.query}"` +
                  (args.base_models?.length ? ` for base ${args.base_models.join("/")}` : "") +
                  `. Try a broader query, drop the filters, or search HuggingFace with search_models.`,
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
                `${hits.length} CivitAI result(s) for "${args.query}":\n\n${lines.join("\n\n")}\n\n` +
                `Next: download_civitai_model {"model_version_id": <id>, "target_subfolder": "<loras|checkpoints|...>"} — then use the trigger words in the prompt.` +
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
        const savedPath = await downloadModel(
          resolved.downloadUrl,
          args.target_subfolder,
          filename,
        );

        const lines = [
          "CivitAI model downloaded successfully:",
          `  ${savedPath}`,
        ];
        if (resolved.modelName) lines.push(`  Model: ${resolved.modelName}`);
        lines.push(`  Version id: ${resolved.versionId}`);

        // Write usage-docs sidecars beside the file so the panel agent has the
        // description, trigger words, and example generation params on hand.
        // Local-only: remote mode has no local FS (savedPath is a status string).
        if (isLocalMode() && resolved.metadata) {
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

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
