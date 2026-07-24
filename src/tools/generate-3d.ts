import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generate3d } from "../services/generate-3d.js";
import { errorToToolResult } from "../utils/errors.js";

/**
 * generate_3d — 3D model generation via the connected ComfyUI's hosted partner
 * 3D nodes (Tripo / Meshy / Rodin / Hunyuan3D), reusing the same machinery as
 * generate_with_api_node. See ../services/generate-3d.ts for the
 * path-selection rationale and capability detection.
 */
export function registerGenerate3dTools(server: McpServer): void {
  server.tool(
    "generate_3d",
    "Generate a 3D model (glb/obj/fbx) from a text prompt or an input image, using the connected " +
      "ComfyUI's hosted partner 3D nodes (Tripo, Meshy, Rodin, Hunyuan3D — auto-detected from the " +
      "server; these are paid API nodes needing a comfy.org API key/login on the server or COMFY_API_KEY here). " +
      "Builds and enqueues a minimal workflow and returns immediately with the prompt_id — poll " +
      "get_job_status / get_history for the resulting model file (saved to ComfyUI's output directory). " +
      "For image mode, upload the image first with upload_image and pass its filename. " +
      "If the server has no 3D-capable API nodes, returns an actionable error naming local-pack alternatives.",
    {
      mode: z
        .enum(["text", "image"])
        .describe('"text" = text-to-3D from prompt; "image" = image-to-3D from an uploaded input image.'),
      prompt: z
        .string()
        .optional()
        .describe(
          "Text description of the 3D model (required for mode 'text'; in mode 'image' it is passed along only if the chosen node accepts a prompt).",
        ),
      image: z
        .string()
        .optional()
        .describe(
          "ComfyUI input-image filename (required for mode 'image'). Upload local files first with upload_image.",
        ),
      node: z
        .string()
        .optional()
        .describe(
          'Explicit 3D API node class_type to use (e.g. "MeshyTextToModelNode"); auto-selected if omitted. Use list_api_nodes with filter "3d" to see options.',
        ),
      inputs: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          "Provider-specific extra inputs passed through to the node (e.g. style, texture, quality). Use get_api_node_schema on the chosen node for valid keys.",
        ),
      disable_random_seed: z
        .boolean()
        .optional()
        .describe("If true, do not randomize seed inputs."),
    },
    async (args) => {
      try {
        const result = await generate3d({
          mode: args.mode,
          prompt: args.prompt,
          image: args.image,
          node: args.node,
          inputs: args.inputs,
          disable_random_seed: args.disable_random_seed,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "enqueued",
                  prompt_id: result.prompt_id,
                  queue_remaining: result.queue_remaining,
                  node: result.class_type,
                  display_name: result.display_name,
                  category: result.category,
                  formats: result.formats,
                  alternatives: result.alternatives,
                  notes: result.notes,
                  workflow: result.workflow,
                  next: "Poll get_job_status / get_history with the prompt_id; the 3D model file is written to ComfyUI's output directory when the job completes.",
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
