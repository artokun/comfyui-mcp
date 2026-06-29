import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  removeBackground,
  REMBG_NODE,
  type RemoveBackgroundDeps,
} from "../services/remove-background.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import { getObjectInfo } from "../comfyui/client.js";
import { errorToToolResult } from "../utils/errors.js";

async function isNodeInstalled(classType: string): Promise<boolean | undefined> {
  try {
    const objectInfo = await getObjectInfo();
    return Object.prototype.hasOwnProperty.call(objectInfo, classType);
  } catch {
    // Can't reach the server / object_info — let execution surface any problem.
    return undefined;
  }
}

const deps: RemoveBackgroundDeps = {
  isNodeInstalled,
  enqueue: (workflow) => enqueueWorkflow(workflow),
};

export function registerRemoveBackgroundTool(server: McpServer): void {
  server.tool(
    "remove_background",
    "Remove an image's background, returning a transparent (RGBA) cutout — the high-level entry point. " +
      `Builds a LoadImage → ${REMBG_NODE} → SaveImage workflow using the ComfyUI-RMBG (BiRefNet) matting ` +
      "node and enqueues it on your LOCAL GPU. Upload the source first with upload_image (or stage a prior " +
      "output with stage_output_as_input), then pass its filename. Requires the ComfyUI-RMBG custom node " +
      "(pack: wan-transparent, or install_custom_node 'comfyui-rmbg'); the BiRefNet model auto-downloads on " +
      "first run. If the node isn't installed, returns an actionable error telling you how to install it. " +
      "Returns prompt_id immediately; the cutout asset_id arrives in the completion notification.",
    {
      image: z
        .string()
        .describe("Filename of the source image in ComfyUI's input dir (upload it first with upload_image)"),
      model: z
        .string()
        .optional()
        .describe("BiRefNet matting model (default 'BiRefNet_toonout'; auto-downloaded by ComfyUI-RMBG)"),
      filename_prefix: z
        .string()
        .optional()
        .describe("Output filename prefix (default 'ComfyUI_cutout')"),
    },
    async (args) => {
      try {
        const result = await removeBackground(args, deps);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "enqueued",
                  tool: "remove_background",
                  prompt_id: result.prompt_id,
                  queue_remaining: result.queue_remaining,
                  model: result.model,
                  note: "Transparent cutout asset_id arrives in the completion notification; use view_image with it.",
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
