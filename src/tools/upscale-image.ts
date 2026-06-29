import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { upscaleImage, type UpscaleImageDeps } from "../services/upscale-image.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import { listLocalModels } from "../services/model-resolver.js";
import { errorToToolResult } from "../utils/errors.js";

async function resolveUpscaleModel(): Promise<string | undefined> {
  try {
    const models = await listLocalModels("upscale_models");
    return models[0]?.name;
  } catch {
    return undefined;
  }
}

const deps: UpscaleImageDeps = {
  resolveUpscaleModel,
  enqueue: (workflow) => enqueueWorkflow(workflow),
};

export function registerUpscaleImageTool(server: McpServer): void {
  server.tool(
    "upscale_image",
    "Upscale an image with an ESRGAN super-resolution model — the high-level entry point. " +
      "Builds an UpscaleModelLoader → ImageUpscaleWithModel workflow (scale=2 supersamples the 4x " +
      "result back down for sharper output) and enqueues it on your LOCAL GPU. Upload the source first " +
      "with upload_image (or stage a prior output with stage_output_as_input), then pass its filename. " +
      "Needs an upscale model in models/upscale_models/ (e.g. 4x-ClearRealityV1 / 4x_foolhardy_Remacri, " +
      "provided by the anima/ernie packs or download_model); returns an actionable error if none is found. " +
      "Returns prompt_id immediately; the upscaled asset_id arrives in the completion notification.",
    {
      image: z
        .string()
        .describe("Filename of the source image in ComfyUI's input dir (upload it first with upload_image)"),
      scale: z
        .union([z.literal(2), z.literal(4)])
        .optional()
        .describe("Net upscale factor: 2 or 4 (default 4)"),
      model: z
        .string()
        .optional()
        .describe("Upscale model file in models/upscale_models/; auto-selected from local models if omitted"),
    },
    async (args) => {
      try {
        const result = await upscaleImage(args, deps);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "enqueued",
                  tool: "upscale_image",
                  prompt_id: result.prompt_id,
                  queue_remaining: result.queue_remaining,
                  model: result.model,
                  scale: result.scale,
                  note: "Upscaled asset_id arrives in the completion notification; use view_image with it.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
