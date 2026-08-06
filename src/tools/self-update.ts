import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runSelfUpdate, selfUpdateStatus } from "../services/self-update.js";

/** The two self-update operations, unchanged from the retired `install_comfyui (action:"self_update")`
 *  tool's own `action` enum (0.50.0 slice 13). They moved to
 *  `self_update_action` because the folded tool's own `action` selects the
 *  family member — two fields cannot share one name in a flat schema. */
export const SELF_UPDATE_ACTIONS = ["status", "update"] as const;

export type SelfUpdateAction = (typeof SELF_UPDATE_ACTIONS)[number];

/**
 * `install_comfyui (action:"self_update")` — what the retired `install_comfyui (action:"self_update")`
 * tool did, selected by `self_update_action` (0.50.0 slice 13). Same
 * self-update service, same JSON content block.
 */
export async function selfUpdateAction(
  action: SelfUpdateAction,
): Promise<CallToolResult> {
  const result = action === "status" ? await selfUpdateStatus() : await runSelfUpdate();
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}
