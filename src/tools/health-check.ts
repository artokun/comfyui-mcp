import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runHealthCheck } from "../services/health-check.js";

/**
 * `get_system_stats (action:"health")` — what the retired `get_system_stats (action:"health")` tool
 * did (0.50.0 slice 13). Same service, same arguments, same single text block.
 */
export async function healthCheckAction(args: {
  model_categories?: string[];
  recent_errors?: number;
}): Promise<CallToolResult> {
  const text = await runHealthCheck({
    modelCategories: args.model_categories,
    recentErrors: args.recent_errors,
  });
  return { content: [{ type: "text" as const, text }] };
}
