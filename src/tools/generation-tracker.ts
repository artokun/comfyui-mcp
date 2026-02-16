import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getTracker } from "../services/generation-tracker.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerGenerationTrackerTools(server: McpServer): void {
  server.tool(
    "suggest_settings",
    "Suggest proven sampler/scheduler/steps/CFG settings based on local generation history. " +
      "Query by model family, LoRA hash, or text search on model/LoRA names.",
    {
      model_family: z
        .string()
        .optional()
        .describe(
          "Model family to query (e.g. 'qwen_image', 'sdxl', 'flux', 'illustrious')",
        ),
      lora_hash: z
        .string()
        .optional()
        .describe("AutoV2 hash (10 chars) of a specific LoRA to find settings for"),
      search: z
        .string()
        .optional()
        .describe(
          "Full-text search on model/LoRA filenames (e.g. 'copax', 'lightning')",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results (default 10)"),
    },
    async (args) => {
      try {
        const tracker = getTracker();
        const limit = args.limit ?? 10;

        let results;
        let heading: string;

        if (args.lora_hash) {
          results = tracker.suggestSettingsForLora(args.lora_hash, limit);
          heading = `Top settings for LoRA ${args.lora_hash}`;
        } else if (args.search) {
          results = tracker.searchByName(args.search, limit);
          heading = `Settings matching "${args.search}"`;
        } else if (args.model_family) {
          results = tracker.suggestSettings(args.model_family, limit);
          heading = `Top settings for ${args.model_family}`;
        } else {
          // No filter — show overall top settings
          const stats = tracker.getStats();
          results = stats.topSettings;
          heading = "Top settings across all models";
        }

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No generation history found. Run some workflows first to build up settings data.",
              },
            ],
          };
        }

        const lines = [`## ${heading}\n`];
        for (const [i, s] of results.entries()) {
          const lora = s.loraName
            ? `LoRA: ${s.loraName} (${s.loraStrength})`
            : "no LoRA";
          lines.push(
            `${i + 1}. **${s.sampler}/${s.scheduler}** — ${s.steps} steps, CFG ${s.cfg}` +
              (s.shift != null ? `, shift ${s.shift}` : "") +
              `, denoise ${s.denoise}` +
              `\n   Model: ${s.modelName ?? s.modelHash} (${s.modelFamily})` +
              `\n   ${lora}` +
              `\n   Used ${s.reuseCount}x` +
              (s.presetName ? ` | Preset: ${s.presetName}` : ""),
          );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "generation_stats",
    "Show local generation tracking statistics — total runs, unique combos, breakdown by model family.",
    {
      model_family: z
        .string()
        .optional()
        .describe("Filter stats to a specific model family"),
    },
    async (args) => {
      try {
        const tracker = getTracker();
        const stats = tracker.getStats(args.model_family);

        const lines: string[] = [];

        if (args.model_family) {
          lines.push(`## Generation Stats: ${args.model_family}\n`);
        } else {
          lines.push("## Generation Stats\n");
        }

        lines.push(`- **Total generations**: ${stats.totalGenerations}`);
        lines.push(`- **Unique setting combos**: ${stats.uniqueCombos}`);

        if (stats.modelBreakdown.length > 0) {
          lines.push("\n### By model family\n");
          for (const b of stats.modelBreakdown) {
            lines.push(`- ${b.modelFamily}: ${b.count} generations`);
          }
        }

        if (stats.topSettings.length > 0) {
          lines.push("\n### Most-used settings\n");
          for (const [i, s] of stats.topSettings.entries()) {
            const lora = s.loraName ? ` + ${s.loraName}` : "";
            lines.push(
              `${i + 1}. ${s.modelFamily} / ${s.sampler}/${s.scheduler} / ` +
                `${s.steps} steps / CFG ${s.cfg}${lora} — ${s.reuseCount}x`,
            );
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
