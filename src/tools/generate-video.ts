import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateVideo, type GenerateVideoDeps } from "../services/generate-video.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import { listLocalModels } from "../services/model-resolver.js";
import { errorToToolResult } from "../utils/errors.js";

// The service requires SPECIFIC LTX deps (checkpoint / gemma encoder / LoRAs) and
// builds its own actionable "missing dependency" errors from the full per-category
// listing. It wraps this in safeList (throw → null = "can't determine, don't
// block"), so DON'T swallow errors here — let listLocalModels throw when there's
// no server, otherwise an empty list would read as "determined empty" and falsely
// report every dependency missing.
async function listModels(type: string): Promise<string[]> {
  const models = await listLocalModels(type);
  return models.map((m) => m.name);
}

const deps: GenerateVideoDeps = {
  listModels,
  enqueue: (workflow) => enqueueWorkflow(workflow),
};

export function registerGenerateVideoTool(server: McpServer): void {
  server.tool(
    "generate_video",
    "Generate a short video from a text prompt (text-to-video), or animate a start image (image-to-video " +
      "when `image` is given) — the high-level entry point. Composes an LTX-2.3 distilled workflow on your " +
      "LOCAL GPU using the render-verified Comfy-Org node stack (gemma text encoder + abliterated/distilled " +
      "LoRAs). Needs the LTX-2.3 models (~24-46GB): install with apply_manifest --path " +
      "packs/ltx-2.3-txt2vid/manifest.yaml (or ltx-2.3-img2vid for i2v); returns an actionable error if the " +
      "checkpoint is missing. seconds is converted to an 8n+1 frame count. For i2v, higher `strength` means " +
      "MORE adherence to the start frame but LESS motion (1.0 can freeze the clip) — keep ~0.6. This minimal " +
      "path omits the synchronized audio + stage-2 spatial upscale that the full ltx-2.3 packs ship. Returns " +
      "prompt_id immediately; the video is written under output/video/ — find it with list_output_images " +
      "(VHS/SaveVideo outputs may not appear in /history).",
    {
      prompt: z.string().describe("Text description of the video (actions over time, visual details)"),
      image: z
        .string()
        .optional()
        .describe("For image-to-video: filename of the start image in ComfyUI's input dir (upload it first)"),
      negative_prompt: z.string().optional().describe("Negative prompt (default: empty / from defaults)"),
      seconds: z.number().positive().optional().describe("Clip length in seconds (default 4; ~10s max)"),
      resolution: z
        .string()
        .optional()
        .describe("'WIDTHxHEIGHT' e.g. '768x512' (rounded to multiples of 32; default 768x512)"),
      fps: z.number().positive().optional().describe("Frames per second (default 25)"),
      strength: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("i2v only: adherence to the start frame, 0-1 (default 0.6; higher = less motion)"),
      steps: z.number().int().positive().optional().describe("Sampling steps (default 8 for the distilled model)"),
      cfg: z.number().positive().optional().describe("CFG scale (default 1.0 for the distilled model)"),
      seed: z.number().int().optional().describe("Seed (omit to randomize)"),
      checkpoint: z
        .string()
        .optional()
        .describe("LTX checkpoint filename in models/checkpoints/; auto-selected if omitted"),
      filename_prefix: z.string().optional().describe("Output filename prefix (default 'video/ltx-2.3')"),
    },
    async (args) => {
      try {
        const result = await generateVideo(args, deps);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "enqueued",
                  tool: "generate_video",
                  mode: result.mode,
                  prompt_id: result.prompt_id,
                  queue_remaining: result.queue_remaining,
                  checkpoint: result.checkpoint,
                  width: result.width,
                  height: result.height,
                  length_frames: result.length,
                  fps: result.fps,
                  note: "Video is written under output/video/. VHS/SaveVideo outputs may not show in /history — use list_output_images to find it.",
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
