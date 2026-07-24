import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  submitBatch,
  batchStatus,
  batchOutput,
  waitForBatch,
  WAIT_HARD_CAP_S,
} from "../services/batch-manager.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import { errorToToolResult } from "../utils/errors.js";

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

export function registerBatchTools(server: McpServer): void {
  server.tool(
    "submit_batch",
    "Enqueue MANY ComfyUI workflows under one durable batch_id. Provide EITHER `workflows` (array of API-format workflows) OR one `workflow` plus a `sweep` (array of flat input-override sets — each set produces one job, applied to every node that already has that input, like modify_workflow). Reuses the enqueue_workflow path (seeds re-randomized unless disable_random_seed). Returns { batch_id, count, prompt_ids }; the batch_id → prompt_ids mapping is persisted to disk and stays valid across server restarts. Follow with get_batch_status / wait_for_batch / get_batch_output.",
    {
      workflows: z
        .array(z.record(z.string(), z.any()))
        .optional()
        .describe("Array of ComfyUI workflows in API format (node ID -> {class_type, inputs}). Mutually exclusive with workflow+sweep."),
      workflow: z
        .record(z.string(), z.any())
        .optional()
        .describe("One base workflow in API format, used with `sweep`."),
      sweep: z
        .array(z.record(z.string(), z.any()))
        .optional()
        .describe('Param sweep: one job per override set, e.g. [{"cfg":6},{"cfg":8,"steps":30}]. Each key is set on every node that already has that input.'),
      disable_random_seed: z
        .boolean()
        .optional()
        .describe("If true, do not randomize seed values (default randomizes per job)."),
    },
    async (args) => {
      try {
        const result = await submitBatch({
          workflows: args.workflows as WorkflowJSON[] | undefined,
          workflow: args.workflow as WorkflowJSON | undefined,
          sweep: args.sweep,
          disable_random_seed: args.disable_random_seed,
        });
        return json(result);
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "get_batch_status",
    "Per-job status for a batch created by submit_batch: each prompt_id's state (pending/running/done/error/unknown) plus rollup counts and all_terminal. Batch ids are durable — they survive server restarts. Uses the same status source as get_job_status.",
    {
      batch_id: z.string().describe("The batch_id returned by submit_batch."),
    },
    async (args) => {
      try {
        return json(await batchStatus(args.batch_id));
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "get_batch_output",
    "Collected outputs for a batch's COMPLETED jobs: for each done prompt_id, the raw ComfyUI history `outputs` (node id → images/videos/audio filenames, same data get_history reports — feed filenames to get_image). Jobs still pending/running are listed with their state; errored jobs carry the error message. Safe to call before the batch finishes.",
    {
      batch_id: z.string().describe("The batch_id returned by submit_batch."),
    },
    async (args) => {
      try {
        return json(await batchOutput(args.batch_id));
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "wait_for_batch",
    `Block until every job in the batch is terminal (done or error) or the timeout elapses, then return the same rollup as get_batch_status plus timed_out/waited_s. Default timeout 300s, hard cap ${WAIT_HARD_CAP_S}s — it can never hang; if timed_out is true, call it again or poll get_batch_status.`,
    {
      batch_id: z.string().describe("The batch_id returned by submit_batch."),
      timeout_s: z
        .number()
        .optional()
        .describe(`Max seconds to wait (default 300, hard cap ${WAIT_HARD_CAP_S}).`),
    },
    async (args) => {
      try {
        return json(await waitForBatch(args.batch_id, args.timeout_s));
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
