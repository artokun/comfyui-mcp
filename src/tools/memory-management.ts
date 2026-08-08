import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getClient, getSystemStats } from "../comfyui/client.js";
import { errorToToolResult } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export function registerMemoryManagementTools(server: McpServer): void {
  server.tool(
    "clear_vram",
    "Free GPU VRAM by unloading cached models from ComfyUI. Use this between generation runs with different model families (e.g. switching from SDXL to Flux) or when running low on VRAM. Optionally unload only models or only memory.",
    {
      unload_models: z
        .boolean()
        .optional()
        .default(true)
        .describe("Unload all cached models (default: true)"),
      free_memory: z
        .boolean()
        .optional()
        .default(true)
        .describe("Free cached memory/intermediates (default: true)"),
    },
    async (args) => {
      try {
        const client = getClient();

        // ComfyUI's /free endpoint accepts POST with JSON body
        const res = await client.fetchApi("/free", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            unload_models: args.unload_models,
            free_memory: args.free_memory,
          }),
        });

        if (!res.ok) {
          // unknown-ok: "" is interpolated into an ERROR MESSAGE and nothing else — the
          // HTTP status is reported either way, so an unreadable body costs detail in the
          // text, never a wrong conclusion. Verified there is no branch on this value.
          const text = await res.text().catch(() => "");
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to free VRAM: ${res.status} ${res.statusText}${text ? `\n${text}` : ""}`,
              },
            ],
          };
        }

        // Get updated stats
        let statsText = "";
        try {
          const stats = await getSystemStats();
          const gpu = stats.devices?.[0];
          if (gpu) {
            const vramFreeMB = (gpu.vram_free / 1024 / 1024).toFixed(0);
            const vramTotalMB = (gpu.vram_total / 1024 / 1024).toFixed(0);
            const torchFreeMB = (gpu.torch_vram_free / 1024 / 1024).toFixed(0);
            const torchTotalMB = (gpu.torch_vram_total / 1024 / 1024).toFixed(0);
            statsText = `\n\nCurrent VRAM: ${vramFreeMB}/${vramTotalMB} MB free | Torch: ${torchFreeMB}/${torchTotalMB} MB free`;
          }
        } catch {
          // Best effort
        }

        const actions: string[] = [];
        if (args.unload_models) actions.push("models unloaded");
        if (args.free_memory) actions.push("memory freed");

        return {
          content: [
            {
              type: "text" as const,
              text: `VRAM cleared successfully (${actions.join(", ")}).${statsText}`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

}

/**
 * The embeddings listing, no longer a tool of its own.
 *
 * 0.50.0 slice 11 folded it into `list_local_models` (action:"embeddings") —
 * both read what the connected ComfyUI has installed, so they belong on the same
 * tool. The body is the old handler verbatim: same /api/embeddings read, same
 * rendering, same "No embeddings installed." degradation.
 */
export async function getEmbeddingsAction(): Promise<CallToolResult> {
      try {
        const client = getClient();
        const res = await client.fetchApi("/api/embeddings");
        const embeddings = (await res.json()) as string[];

        if (!Array.isArray(embeddings) || embeddings.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No embeddings installed.",
              },
            ],
          };
        }

        const lines = embeddings.map((e, i) => `${i + 1}. ${e}`);

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${embeddings.length} embedding(s):\n\n${lines.join("\n")}\n\nUsage in prompts: \`embedding:name\` (e.g. \`embedding:${embeddings[0]}\`)`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
}
