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

export function registerModelManagementTools(server: McpServer): void {
  server.tool(
    "search_models",
    "Search HuggingFace for models compatible with ComfyUI (checkpoints, LoRAs, VAEs, etc.)",
    {
      query: z.string().describe("Search query (e.g. 'SDXL', 'flux', 'controlnet')"),
      filter: z
        .string()
        .optional()
        .describe("HuggingFace tag filter (e.g. 'diffusers', 'text-to-image')"),
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
    "Download a model file to the ComfyUI models directory from a URL (HuggingFace or direct link)",
    {
      url: z.string().url().describe("Direct download URL for the model file"),
      target_subfolder: modelTypeEnum.describe(
        "Target subfolder under ComfyUI models/ (e.g. 'checkpoints', 'loras', 'vae')",
      ),
      filename: z
        .string()
        .optional()
        .describe("Override filename (auto-detected from URL if omitted)"),
    },
    async (args) => {
      try {
        const savedPath = await downloadModel(
          args.url,
          args.target_subfolder,
          args.filename,
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
    "List model files installed in the local ComfyUI models directory",
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
            const sizeMB = (m.size / 1024 / 1024).toFixed(1);
            lines.push(`- ${m.name} (${sizeMB} MB) — modified ${m.modified}`);
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
