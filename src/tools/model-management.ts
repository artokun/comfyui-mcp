import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  searchHuggingFaceModels,
  listLocalModels,
  downloadModel,
  MODEL_SUBDIRS,
} from "../services/model-resolver.js";
import { errorToToolResult } from "../utils/errors.js";

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
    "Search HuggingFace Hub for models usable in ComfyUI (checkpoints, LoRAs, VAEs, ControlNets, etc.). Read-only and network-only: queries HuggingFace over HTTP, does NOT require a running ComfyUI or COMFYUI_PATH and does not download anything. Returns a ranked list with modelId, author, downloads, likes, and tags. Pick a result's download URL and pass it to download_model to install it locally. For packs of custom nodes (not models) use search_custom_nodes.",
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
        const savedPath = await downloadModel(
          args.url,
          args.target_subfolder,
          args.filename,
          args.auth,
        );

        return {
          content: [
            {
              type: "text",
              text: `Model downloaded successfully to:\n${savedPath}`,
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
    "List model files available to the connected ComfyUI, grouped by type. Read-only. Queries ComfyUI's /models REST endpoint first (works with remote ComfyUI and respects extra_model_paths.yaml — symlinked / mounted dirs the install-path filesystem scan would miss), then falls back to a filesystem scan of COMFYUI_PATH/models/ when the REST endpoint is unavailable. Size and modified time are only available on the filesystem fallback path. Use to see which models are already available before generating or downloading; use search_models to discover new models on HuggingFace, then download_model to fetch them.",
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
