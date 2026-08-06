import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  configureManager,
  type ManagerConfigAction,
} from "../services/manager-config.js";

/**
 * `install_comfyui (action:"configure_manager")` — what the retired
 * `install_comfyui (action:"configure_manager")` tool did, selected by `manager_setting` (0.50.0 slice
 * 13). The setting enum moved off `action` because the folded tool's own
 * `action` selects the family member; the service call, its two arguments and
 * the rendered text block are unchanged.
 */
export async function configureManagerAction(
  setting: ManagerConfigAction,
  value: string | undefined,
): Promise<CallToolResult> {
  const result = await configureManager(setting, value);
  const stateLine = result.state !== undefined ? `\nResulting state: ${result.state}` : "";
  return {
    content: [
      {
        type: "text" as const,
        text: `${result.message} (via ${result.via})${stateLine}`,
      },
    ],
  };
}
