import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  executeWorkflow,
  enqueueWorkflow,
  getSystemInfo,
} from "../services/workflow-executor.js";
import { errorToToolResult } from "../utils/errors.js";
import { getTracker } from "../services/generation-tracker.js";
import { extractSettings } from "../services/workflow-settings-extractor.js";
import { logger } from "../utils/logger.js";

export function registerWorkflowExecuteTools(server: McpServer): void {
  server.tool(
    "run_workflow",
    "Execute a ComfyUI workflow (API format JSON). Returns generated images as base64. The workflow must be in ComfyUI's API/prompt format — a mapping of node IDs to {class_type, inputs}.",
    {
      workflow: z
        .record(z.string(), z.any())
        .describe("ComfyUI workflow in API format (node ID -> {class_type, inputs})"),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Execution timeout in milliseconds (default: 10 minutes)"),
      disable_random_seed: z
        .boolean()
        .optional()
        .describe("If true, do not randomize seed values"),
    },
    async (args) => {
      try {
        const result = await executeWorkflow(args.workflow, {
          timeout_ms: args.timeout_ms,
          disable_random_seed: args.disable_random_seed,
        });

        const content: Array<
          { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
        > = [];

        content.push({
          type: "text",
          text: `Workflow executed successfully. prompt_id: ${result.prompt_id}, images: ${result.images.length}`,
        });

        for (const img of result.images) {
          content.push({
            type: "image",
            data: img.data,
            mimeType: img.mime,
          });
        }

        // Log generation settings (best-effort, don't fail the response)
        try {
          const tracker = getTracker();
          const settings = await extractSettings(args.workflow, tracker.fileHasher);
          if (settings) {
            const { settingsHash, reuseCount } = tracker.logGeneration(settings);
            logger.info("Generation tracked", { settingsHash, reuseCount });
          }
        } catch (trackErr) {
          logger.warn("Failed to track generation settings", {
            error: trackErr instanceof Error ? trackErr.message : trackErr,
          });
        }

        return { content };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "enqueue_workflow",
    "Fire-and-forget: submit a ComfyUI workflow for execution and return immediately with the prompt_id and queue position. Does not wait for completion. Use get_job_status to check progress later.",
    {
      workflow: z
        .record(z.string(), z.any())
        .describe("ComfyUI workflow in API format (node ID -> {class_type, inputs})"),
      disable_random_seed: z
        .boolean()
        .optional()
        .describe("If true, do not randomize seed values"),
    },
    async (args) => {
      try {
        const result = await enqueueWorkflow(args.workflow, {
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

  server.tool(
    "get_system_stats",
    "Get ComfyUI system information including GPU, VRAM, Python version, and OS details.",
    {},
    async () => {
      try {
        const stats = await getSystemInfo();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(stats, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
