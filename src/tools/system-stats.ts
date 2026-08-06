import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSystemInfo } from "../services/workflow-executor.js";
import { errorToToolResult } from "../utils/errors.js";
import { getLogsAction } from "./diagnostics.js";
import { healthCheckAction } from "./health-check.js";

/**
 * The server/machine READS collapsed into one action-parameterized
 * `get_system_stats` tool (0.50.0 surface consolidation, slice 13): three
 * tools, three actions.
 *
 * The slice originally folded six. Review took the RFC's documented fallback
 * for three of them and left `clear_vram`, `report_issue` and `calculate`
 * STANDALONE: the first is the OOM panic button and belongs at one call's
 * reach, the second files a PUBLIC GitHub issue and had no business on a tool
 * named 'get system stats', and the third is a pure offline utility with
 * nothing to do with server state. What is left here is coherent — three
 * read-only views of the same connected server.
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: only `action` can be schema-required — `max_lines`/`keyword`
 * belong to "logs" and `model_categories`/`recent_errors` to "health", and
 * none of them is required by anything ("stats" takes no parameters at all).
 * Every VALUE constraint the old tools had is unchanged at the zod layer:
 * `max_lines` keeps its .int().min(1).max(2000) and `recent_errors` its
 * .int().min(0).max(200), so an out-of-range value fails exactly where it did
 * before. There is therefore no per-action presence guard on this tool — no
 * action has a required field — and adding one would be inventing a refusal
 * the old tools never had.
 *
 * READ-ONLY, all three. Nothing here mutates the server, the workspace or this
 * package, and nothing here leaves the machine.
 */
export function registerSystemStatsTools(server: McpServer): void {
  const ACTIONS = ["stats", "logs", "health"] as const;
  server.tool(
    "get_system_stats",
    "Inspect the connected ComfyUI server: what it is running on, what it has logged, and whether it is healthy enough to dispatch work to. All three actions are READ-ONLY — nothing here mutates anything. Driven by the `action` parameter:\n" +
      '- action:"stats" — Get system information from the connected ComfyUI server: GPU device(s), total/free VRAM, ComfyUI/Python/PyTorch versions, and OS details. Requires a running ComfyUI server (works against local or remote targets); read-only, takes no parameters. Returns the raw /system_stats JSON. Use to confirm connectivity and check available VRAM before enqueuing large workflows. Errors if the server is unreachable.\n' +
      '- action:"logs" — Get ComfyUI server runtime logs. Useful for debugging execution errors, model loading issues, missing nodes, and Python tracebacks. `max_lines` tails the end (default 100), `keyword` filters case-insensitively.\n' +
      '- action:"health" — Pre-flight diagnostic for the connected ComfyUI: one call that aggregates the signals an agent should check before dispatching a batch. Reports ComfyUI version/Python/PyTorch, GPU name + VRAM free/total, system RAM free, queue depth (running + pending), per-category /models populations (catches empty dropdowns from a misconfigured extra_model_paths.yaml), and recent errors from /internal/logs. Read-only — no mutation. Use this when a job fails for an unexpected reason, before a long batch run, or to confirm a remote ComfyUI is healthy. Originally contributed by github.com/joaolvivas.',
    {
      action: z
        .enum(ACTIONS)
        .describe(
          'Which read to perform. "stats" takes no other parameters; "logs" takes `max_lines`/`keyword`; "health" takes `model_categories`/`recent_errors`. None of them is required.',
        ),
      max_lines: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe(
          'action:"logs" — maximum number of log lines to return from the end (default: 100).',
        ),
      keyword: z
        .string()
        .optional()
        .describe(
          'action:"logs" — filter log lines containing this keyword (case-insensitive). Examples: \'error\', \'warning\', \'VRAM\', a node name.',
        ),
      model_categories: z
        .array(z.string())
        .optional()
        .describe(
          'action:"health" — override the model categories to poll (defaults to checkpoints, diffusion_models, loras, vae, text_encoders, controlnet).',
        ),
      recent_errors: z
        .number()
        .int()
        .min(0)
        .max(200)
        .optional()
        .describe(
          'action:"health" — how many recent error/traceback lines to include from /internal/logs (default 20, max 200).',
        ),
    },
    async (args) => {
      try {
        switch (args.action) {
          case "stats":
            return {
              content: [
                { type: "text" as const, text: JSON.stringify(await getSystemInfo(), null, 2) },
              ],
            };
          case "logs":
            return await getLogsAction({
              max_lines: args.max_lines,
              keyword: args.keyword,
            });
          case "health":
            return await healthCheckAction({
              model_categories: args.model_categories,
              recent_errors: args.recent_errors,
            });
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown get_system_stats action "${String(exhaustive)}". Expected one of: ${ACTIONS.join(", ")}.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
