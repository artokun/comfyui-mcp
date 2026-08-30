import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getQueueSummary,
  getJobStatus,
  getQueuedWorkflow,
  moveQueuedJob,
  editQueuedJob,
  cancelRunningJobEscalating,
  cancelQueuedJob,
  clearAllQueued,
} from "../services/queue-manager.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import { errorToToolResult } from "../utils/errors.js";

/**
 * The eight queue/jobs tools collapsed into one action-parameterized `queue`
 * tool (0.49.0 surface consolidation, slice 4).
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: only `action` can be schema-required — `prompt_id` is required
 * for status/get_workflow/move/edit/cancel_queued, optional for cancel, and
 * meaningless for list/clear, and `position` is required for move but optional
 * for edit. Every VALUE constraint the old tools had is unchanged at the zod
 * layer; the handler enforces per-action presence and names the missing field —
 * the one deliberate behavioural difference a flat enum permits. Each branch
 * calls the same service function the old tool called, with the same arguments,
 * and returns the identical content block (JSON for the query actions, the
 * prose messages for cancel/cancel_queued/clear, isError on a cancel whose
 * outcome no live /queue read settled).
 */
export function registerQueueManagementTools(server: McpServer): void {
  server.tool(
    "queue",
    "Inspect and manage the ComfyUI execution queue. Driven by the `action` parameter:\n" +
      '- action:"list" — The job running now plus all pending jobs, each with its prompt_id and position. Read-only; requires a reachable ComfyUI server (works against local or remote --comfyui-url). Omits queued workflow payloads by default to keep output small; set include_workflows:true when you need to inspect or edit the exact pending payload. Use this before action:"cancel" (running), action:"cancel_queued"/action:"clear" (pending), action:"move", or action:"edit".\n' +
      '- action:"status" — Check ONE job by its prompt_id (the id returned by enqueue_workflow). Queries the connected ComfyUI server; requires it to be running. Returns JSON with running, pending, and done booleans, plus optional status_str, error details, and execution_stats from ComfyUI history once the job is done. If the prompt is neither running nor queued AND /history has no record of it (a restart wipes both), it returns done:false + found:false with an explanatory message — a prompt ComfyUI never executed is NOT a completion, so do not wait for its outputs. Also returns text_outputs when the workflow contained text-preview nodes (Preview as Text, ShowText, …) — those produce no image file, so this is the ONLY way to read their result; report that text back to the user. Use action:"list" to see the whole queue at once, and get_history for full output filenames.\n' +
      '- action:"get_workflow" — The full workflow payload for one PENDING queue item by prompt_id. Read-only. Does not work for the currently running job because ComfyUI cannot safely edit a job after execution starts.\n' +
      '- action:"move" — Move a PENDING queue item to the front or back by removing it and re-enqueuing its saved workflow payload; `position` ("front"|"back") is required. The job receives a NEW prompt_id; the old prompt_id is removed. Running jobs cannot be moved.\n' +
      '- action:"edit" — Edit a PENDING queue item by removing it and re-enqueuing an updated workflow. Provide either a complete replacement `workflow` or `node_inputs` patches keyed by node id; `position` selects where to requeue (default back). The job receives a NEW prompt_id; the old prompt_id is removed. Running jobs cannot be edited.\n' +
      '- action:"cancel" — Stop the CURRENTLY RUNNING job ROBUSTLY. Sends an interrupt, then WAITS and verifies the job actually stopped — ComfyUI only honors interrupts BETWEEN steps, so a long single step (e.g. a high-res video sampler) can ignore a plain cancel. If the interrupt isn\'t honored it escalates to freeing VRAM (POST /free) and re-checks; if it STILL won\'t die it reports the job as WEDGED and tells you to restart_comfyui (an HTTP cancel cannot kill a stuck step). Set clear_pending:true to also drop ALL pending jobs in the same call — the correct "reset the queue" action, since cancelling alone leaves pending jobs that would run next. The partial result is discarded. With `prompt_id` given, only interrupts the running job when its prompt_id matches; omit to interrupt whatever is currently running. Use action:"cancel_queued" to remove one specific PENDING job instead.\n' +
      '- action:"cancel_queued" — Remove one specific PENDING job from the queue by prompt_id, then VERIFY the removal against a live /queue read on both sides of it. Only PENDING jobs can be removed this way: ComfyUI silently ignores the request for a job it has already started, so if the job won the race and is now RUNNING this reports isError and tells you the outputs will still be delivered — use action:"cancel" to interrupt that. Also reports isError when the prompt_id was not in the queue at all (it already finished, or was never queued) rather than calling that a removal.\n' +
      '- action:"clear" — Clear ALL pending jobs from the queue. Does not affect the currently running job.',
    {
      action: z
        .enum(["list", "status", "get_workflow", "move", "edit", "cancel", "cancel_queued", "clear"])
        .describe(
          'Which queue operation to perform. "list" and "clear" take no other parameters; "status", "get_workflow" and "cancel_queued" require `prompt_id`; "move" requires `prompt_id` + `position`; "edit" requires `prompt_id` (optional `workflow`/`node_inputs`/`position`); "cancel" takes an optional `prompt_id` and `clear_pending`.',
        ),
      prompt_id: z
        .string()
        .optional()
        .describe(
          'The prompt_id of a job (the id returned by enqueue_workflow). REQUIRED for actions "status", "get_workflow", "move", "edit" and "cancel_queued" (a PENDING queue item for all but "status"). OPTIONAL for action:"cancel" — if given, only interrupts the running job when its prompt_id matches; omit to interrupt whatever is currently running.',
        ),
      include_workflows: z
        .boolean()
        .optional()
        .describe(
          'action:"list" — include each running/pending job\'s workflow payload and extra_data. Can be large.',
        ),
      position: z
        .enum(["front", "back"])
        .optional()
        .describe(
          'Where to requeue the job. REQUIRED for action:"move". OPTIONAL for action:"edit" — defaults to back.',
        ),
      workflow: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          'action:"edit" — optional complete replacement API-format workflow. If omitted, the existing queued workflow is patched with `node_inputs`.',
        ),
      node_inputs: z
        .record(z.string(), z.record(z.string(), z.any()))
        .optional()
        .describe(
          'action:"edit" — optional input patches keyed by node id, e.g. {"3":{"steps":30,"cfg":7}}.',
        ),
      clear_pending: z
        .boolean()
        .optional()
        .describe(
          'action:"cancel" — also clear ALL pending jobs (recommended when resetting after a stuck/slow render, so a re-queue doesn\'t stack behind a backlog). Default false.',
        ),
    },
    async (args) => {
      try {
        const json = (value: unknown) => ({
          content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
        });

        // prompt_id/position cannot be schema-required in a flat shape, so the
        // handler enforces per-action presence and names the missing field — the
        // same information the old per-tool schemas gave a caller.
        //
        // ABSENCE only, never falsiness: `prompt_id: ""` passed z.string() before
        // this consolidation and reached the service, which answers with its own
        // not-found/validation error. A `!prompt_id` guard would swallow that path
        // and answer with generic text instead.
        const requirePromptId = (action: string, what: string): string => {
          if (args.prompt_id === undefined) {
            throw new Error(`queue action:"${action}" requires \`prompt_id\` — ${what}.`);
          }
          return args.prompt_id;
        };

        switch (args.action) {
          case "list":
            return json(await getQueueSummary({ include_workflows: args.include_workflows }));
          case "status":
            return json(await getJobStatus(requirePromptId("status", "the job to check")));
          case "get_workflow":
            return json(
              await getQueuedWorkflow(
                requirePromptId("get_workflow", "a PENDING queue item"),
              ),
            );
          case "move": {
            const promptId = requirePromptId("move", "a PENDING queue item to move");
            if (args.position === undefined) {
              throw new Error('queue action:"move" requires `position` — "front" or "back".');
            }
            return json(await moveQueuedJob(promptId, args.position));
          }
          case "edit":
            return json(
              await editQueuedJob({
                prompt_id: requirePromptId("edit", "a PENDING queue item to edit"),
                workflow: args.workflow as WorkflowJSON | undefined,
                node_inputs: args.node_inputs,
                position: args.position,
              }),
            );
          case "cancel": {
            const result = await cancelRunningJobEscalating({
              prompt_id: args.prompt_id,
              clear_pending: args.clear_pending,
            });
            // An MCP success is read as "the cancel did what it said", so it
            // may only be given for an outcome a LIVE /queue read settled —
            // about the job this call addressed, which is all a cancel ever
            // promised (a queue that advances to the next job is not an error;
            // clear_pending is the switch for emptying it). `wedged` alone is
            // not that test: an unreachable /queue
            // makes the service report `target_state:"unknown"` with
            // `wedged:false`, and answering that with a plain success turns the
            // service's honest "could not determine" back into "determined it
            // stopped" — one level up. Same for a `clear_pending` the caller
            // asked for that did not complete: the backlog it was meant to
            // remove may still be there to stack behind.
            //
            // DISCLOSE, DO NOT HIDE: `result.message` is returned unchanged in
            // both cases. The cancel may well have happened — for an unreadable
            // queue that is one of the live possibilities — and the message says
            // so, along with what to check. isError marks the outcome unsettled;
            // it does not claim the cancel failed.
            //
            // And NOT on `unverified`, which is a caveat about WHY the job
            // stopped, not WHETHER: `target_state:"stopped"` there comes from a
            // live read of an empty queue. Failing that would refuse a caller
            // the queue it can see is free.
            const unsettled = result.target_state !== "stopped" || !!result.pending_clear_failed;
            return {
              content: [{ type: "text" as const, text: result.message }],
              ...(unsettled ? { isError: true } : {}),
            };
          }
          case "cancel_queued": {
            const promptId = requirePromptId("cancel_queued", "the pending job to remove");
            const outcome = await cancelQueuedJob(promptId);
            // NEVER report a removal we did not observe. ComfyUI's /queue delete
            // no-ops for a job that already started, so the old unconditional
            // "removed successfully." told the agent it had superseded a render
            // that then ran to completion and delivered its outputs (#1632).
            // Same contract as action:"cancel" right above: isError marks a
            // request that was NOT carried out, and the prose says what the job
            // is actually doing and what to do instead — it does not hide it.
            if (!outcome.removed) {
              const text =
                outcome.state === "running"
                  ? `Queued job ${promptId} was NOT removed — it is already RUNNING. ` +
                    `action:"cancel_queued" only removes PENDING items, so this job will run to ` +
                    `completion and its outputs WILL still be delivered. Use action:"cancel" with ` +
                    `this prompt_id to interrupt it.`
                  : outcome.state === "absent"
                    ? `Queued job ${promptId} was NOT removed — it is not in the queue. It already ` +
                      `finished, was removed earlier, or was never queued; if it finished, its ` +
                      `outputs already exist. Check action:"status" for this prompt_id.`
                    : `Queued job ${promptId} is STILL PENDING after the remove request — the ` +
                      `removal did not take effect. Re-check with action:"list".`;
              return { content: [{ type: "text" as const, text }], isError: true };
            }
            return {
              content: [
                {
                  type: "text" as const,
                  text: outcome.verified
                    ? `Queued job ${promptId} removed successfully.`
                    : `Queued job ${promptId}: the removal request succeeded, but /queue could not ` +
                      `be read to confirm the job was pending and is now gone. Verify with ` +
                      `action:"list".`,
                },
              ],
            };
          }
          case "clear":
            await clearAllQueued();
            return {
              content: [
                {
                  type: "text" as const,
                  text: "All pending queue items cleared successfully.",
                },
              ],
            };
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown queue action "${String(exhaustive)}". Expected one of: list, status, get_workflow, move, edit, cancel, cancel_queued, clear.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
