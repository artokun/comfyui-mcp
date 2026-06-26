import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { stat, unlink } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { config } from "../config.js";
import { downloadModel, MODEL_SUBDIRS } from "../services/model-resolver.js";
import {
  resolveCivitaiModel,
  resolveCivitaiModelVersion,
} from "../services/civitai-resolver.js";
import { ModelError, ValidationError, errorToToolResult } from "../utils/errors.js";

/**
 * Resolve the local ComfyUI models directory.
 * Mirrors the (unexported) helper in model-resolver.ts; throws a clear error
 * when COMFYUI_PATH is unavailable (e.g. when targeting a remote ComfyUI).
 */
function getModelsRoot(): string {
  if (!config.comfyuiPath) {
    throw new ModelError(
      "COMFYUI_PATH is not configured. remove_model operates on the local " +
        "filesystem and is unavailable when targeting a remote ComfyUI. " +
        "Set the COMFYUI_PATH environment variable.",
    );
  }
  return resolve(config.comfyuiPath, "models");
}

/**
 * Resolve a user-supplied relative model path against the models root and
 * confirm the result stays strictly inside the models directory.
 * Rejects path traversal (`..`) and absolute-path escapes.
 */
function resolveWithinModels(modelsRoot: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new ValidationError(
      `Path must be relative to the models directory, not absolute: ${relativePath}`,
    );
  }

  const target = resolve(modelsRoot, relativePath);
  const rel = relative(modelsRoot, target);

  // `rel` starting with ".." (or being absolute on a different root/drive)
  // means the resolved path escaped the models directory.
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new ValidationError(
      `Refusing to operate outside the models directory: ${relativePath}`,
    );
  }

  // Defense-in-depth: ensure the resolved path is a descendant of the root.
  if (!target.startsWith(modelsRoot + sep)) {
    throw new ValidationError(
      `Refusing to operate outside the models directory: ${relativePath}`,
    );
  }

  return target;
}

export function registerModelExtrasTools(server: McpServer): void {
  server.tool(
    "remove_model",
    "Delete a model file from the local ComfyUI models directory. The path must " +
      "stay within models/ (path traversal and absolute escapes are rejected).",
    {
      path: z
        .string()
        .min(1)
        .describe(
          "Model file path relative to the ComfyUI models/ directory " +
            "(e.g. 'checkpoints/sd_xl_base_1.0.safetensors').",
        ),
    },
    async (args) => {
      try {
        const modelsRoot = getModelsRoot();
        const target = resolveWithinModels(modelsRoot, args.path);

        let info;
        try {
          info = await stat(target);
        } catch {
          throw new ModelError(
            `Model file not found: ${args.path} (resolved to ${target})`,
            { path: args.path, resolved: target },
          );
        }

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
    "Download a model from CivitAI into the local ComfyUI models/ directory and " +
      "return the saved absolute path. Resolves a CivitAI model id (latest version) " +
      "or a model-version id to a download URL via the CivitAI REST API, then streams " +
      "the file to disk. LOCAL-ONLY: writes under <COMFYUI_PATH>/models/<target_subfolder>/ " +
      "and errors when COMFYUI_PATH is unset (e.g. a remote --comfyui-url target). Provide " +
      "at least one of model_id or model_version_id. Gated/early-access models require " +
      "CIVITAI_API_TOKEN (sent as a bearer header, never in the URL); without it they fail.",
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
