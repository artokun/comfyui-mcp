import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getQueueSummary,
  getJobStatus,
  cancelRunningJob,
  cancelQueuedJob,
  clearAllQueued,
} from "../services/queue-manager.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerQueueManagementTools(server: McpServer): void {
  server.tool(
    "get_queue",
    "Get the current ComfyUI execution queue showing running and pending jobs.",
    {},
    async () => {
      try {
        const summary = await getQueueSummary();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(summary, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "get_job_status",
    "Check the execution status of a ComfyUI prompt/job by its ID.",
    {
      prompt_id: z.string().describe("The prompt ID returned by run_workflow"),
    },
    async (args) => {
      try {
        const status = await getJobStatus(args.prompt_id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(status, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "cancel_job",
    "Interrupt/cancel the currently running ComfyUI job. Optionally target a specific running job by prompt_id.",
    {
      prompt_id: z
        .string()
        .optional()
        .describe(
          "Optional prompt_id to target a specific running job. If omitted, interrupts the current job.",
        ),
    },
    async (args) => {
      try {
        await cancelRunningJob(args.prompt_id);
        const target = args.prompt_id ?? "current";
        return {
          content: [
            {
              type: "text" as const,
              text: `Job cancelled successfully (target: ${target}).`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "cancel_queued_job",
    "Remove a specific pending job from the ComfyUI queue by prompt_id. Does not affect running jobs.",
    {
      prompt_id: z
        .string()
        .describe("The prompt_id of the pending job to remove from the queue"),
    },
    async (args) => {
      try {
        await cancelQueuedJob(args.prompt_id);
        return {
          content: [
            {
              type: "text" as const,
              text: `Queued job ${args.prompt_id} removed successfully.`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "clear_queue",
    "Clear all pending jobs from the ComfyUI queue. Does not affect the currently running job.",
    {},
    async () => {
      try {
        await clearAllQueued();
        return {
          content: [
            {
              type: "text" as const,
              text: "All pending queue items cleared successfully.",
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
