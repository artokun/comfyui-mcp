import {
  updateComfyUICore,
  updateAllCustomNodes,
} from "../services/update-comfyui.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * `install_comfyui (action:"update")` — the core-update half of what the retired
 * `install_comfyui (action:"update")` tool did (0.50.0 slice 13). The service call, its arguments
 * and the JSON content block are unchanged; only the surface moved.
 */
export async function updateComfyUiCoreAction(): Promise<CallToolResult> {
  const result = await updateComfyUICore();
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

/**
 * `install_comfyui (action:"update_all")` — the custom-node bulk update, which
 * had its own standalone tool until 0.50.0 slice 13. Same service, same JSON.
 */
export async function updateAllAction(): Promise<CallToolResult> {
  const result = await updateAllCustomNodes();
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}
