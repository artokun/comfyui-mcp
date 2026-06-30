import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { unlink } from "node:fs/promises";
import { isLocalMode } from "../config.js";
import {
  downloadModel,
  resolveExistingModelFile,
  MODEL_SUBDIRS,
} from "../services/model-resolver.js";
import {
  resolveCivitaiModel,
  resolveCivitaiModelVersion,
} from "../services/civitai-resolver.js";
import { ValidationError, errorToToolResult } from "../utils/errors.js";

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

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
