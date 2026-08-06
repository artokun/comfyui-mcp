import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  enqueueWorkflow,
  getSystemInfo,
} from "../services/workflow-executor.js";
import { getHistory } from "../comfyui/client.js";
import {
  selectNewestHistoryEntry,
  extractWorkflowGraph,
} from "../services/history-select.js";
import { applyOverrides } from "../services/asset-registry.js";
import { errorToToolResult, ValidationError } from "../utils/errors.js";
import { getTracker } from "../services/generation-tracker.js";
import { extractSettings } from "../services/workflow-settings-extractor.js";
import { logger } from "../utils/logger.js";
import { runWorkflowUrlAction } from "./workflow-url.js";
import { templateSchemaAction } from "./template-schema.js";
import { runTemplateAction } from "./run-template.js";

/**
 * The five ENQUEUE ENTRY POINTS collapsed into one action-parameterized
 * `enqueue_workflow` tool (0.50.0 surface consolidation, slice 16).
 *
 * `enqueue_workflow` is the SURVIVOR and keeps its registration slot; the four
 * satellite entry points it absorbed are listed, with their replacement call
 * forms, in DEAD_NAMES (src/tools/vocabulary.ts) — the one place a retired name
 * is allowed to live, so that a stale mention anywhere else stays detectable.
 *
 * `enqueue_workflow` REMAINS A NAMED ENTRY POINT and is never itself subsumed:
 * it is the single highest-stakes call on the surface (it starts real GPU work),
 * and the RFC is explicit that the four satellites fold INTO it rather than the
 * five folding into some new umbrella name. A model that only ever learned
 * `enqueue_workflow` still finds it exactly where it was.
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: only `action` can be schema-required — `workflow` is required
 * for "enqueue" and meaningless elsewhere, `url` only for "run_url", `template`
 * for the two template actions. Every VALUE constraint the old tools had
 * is unchanged at the zod layer (`run` keeps its `.default(false)`, `timeout_s`
 * its `.positive()`); the handler enforces per-action PRESENCE and names the
 * missing field — the one deliberate behavioural difference a flat enum permits.
 * The guards test ABSENCE, not falsiness: `url: ""` passed z.string() before and
 * reached the fetch service, which answers with its own validation error, and
 * still does.
 *
 * ADMISSION: only action:"enqueue" is reachable from the orchestrator's direct
 * call_tool channel. That is not a detail — see CALL_TOOL_ACTION_WHITELIST in
 * src/orchestrator/call-tool-admission.ts, where action:"run_url" (fetch a
 * workflow from an ARBITRARY URL and execute it) is deliberately refused.
 */
const ENQUEUE_ACTIONS = ["enqueue", "rerun", "run_url", "template_schema", "run_template"] as const;

export function registerWorkflowExecuteTools(server: McpServer): void {
  server.tool(
    "enqueue_workflow",
    "Submit work to the ComfyUI execution queue — the primary way an agent starts a render. Driven by the `action` parameter:\n" +
      '- action:"enqueue" — Submit an API-format workflow you are already holding (one you built with create_workflow, loaded with get_workflow, or edited with create_workflow action:"modify"). Returns immediately with the prompt_id and queue position; does NOT wait for completion. Seed values in the workflow are used EXACTLY as supplied — they are NOT re-randomized, so a run is reproducible by resubmitting the same workflow (for a fresh-seed re-run of a past job, use action:"rerun"). `workflow` is required. Use queue (action:"status") to check progress later, or get_history (action:"list") to retrieve results and images after completion.\n' +
      '- action:"rerun" — Re-run the workflow behind a PREVIOUS generation. Retrieves the prompt graph from execution history (by `prompt_id`, or the most recent run when omitted — chosen by ComfyUI\'s queue number, same logic as get_history) and re-enqueues it, optionally applying `inputs` overrides. Seeds are re-randomized (within each node\'s declared range) unless disable_random_seed is set or the seed is pinned via `inputs`. Returns the new prompt_id and the source prompt_id it came from. Clear error if no matching history exists. To re-run from a registered ASSET instead of history, use generate_image (action:"regenerate").\n' +
      '- action:"run_url" — Read (and optionally execute) a SHARED workflow from a URL. Fetches the workflow JSON, accepts API-format prompt graphs or UI-format exports (UI is auto-converted via the same converter as get_workflow), validates it, and summarizes it. Supports raw .json links and GitHub blob/raw URLs (blob is normalized to raw); other share hosts that need a site API return a clear \'paste the raw JSON URL\' error. The fetch is bounded (http/https only, timeout + size cap, loopback/private/metadata IPs rejected to prevent SSRF). READ-ONLY unless run=true; when run=true it enqueues the workflow (applying optional `inputs` overrides) and returns the prompt_id. `url` is required.\n' +
      '- action:"template_schema" — Get a template\'s OVERRIDABLE run-time parameters (its \'slots\') BEFORE running it. Pass a bundled pack name (from list_packs action:"list") or a custom-node-contributed workflow template name (from list_packs action:"list_templates") as `template`. Returns `slots` — the meaningful knobs: positive/negative prompt, seed, steps, cfg, sampler/scheduler, width/height, checkpoint/LoRA/model files, denoise, batch_size, input image — plus `other_slots` (every remaining overridable widget), each with a stable key "<nodeId>.<widget_name>", semantic role, type, current value, and min/max/options where the node schema is known. Read-only. Feed the keys DIRECTLY into action:"run_template"\'s `overrides` (same convention) for a schema→run round-trip.\n' +
      '- action:"run_template" — ONE-SHOT: run a named workflow template (a bundled pack from list_packs) with optional `overrides`. Resolves the template\'s expert graph, applies overrides, and enqueues it — replacing the manual list_packs (action:"read_workflow") → create_workflow (action:"modify") → action:"enqueue" chain. Override keys are \'<nodeId>.<widget_name>\' (e.g. {\'6.text\': \'a cat\', \'3.seed\': 42}) — the SAME keys action:"template_schema" reports (when available), so schema→run round-trips; only widget values can be overridden, never graph connections. By default returns {prompt_id} immediately; pass wait:true to block until the job completes and return its outputs (images etc.). Unresolvable template names return a clear error with near-matches. `template` is required.',
    {
      action: z
        .enum(ENQUEUE_ACTIONS)
        .describe(
          'Which enqueue entry point to use. action:"enqueue" requires `workflow`; action:"rerun" takes an optional `prompt_id` (+ `inputs`); action:"run_url" requires `url` (+ `run`/`inputs`); action:"template_schema" and action:"run_template" require `template`; with action:"run_template" you may also pass `overrides`/`wait`/`timeout_s`.',
        ),
      workflow: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          'action:"enqueue" — ComfyUI workflow in API format (node ID -> {class_type, inputs}). REQUIRED for that action.',
        ),
      disable_random_seed: z
        .boolean()
        .optional()
        .describe(
          'If true, do not randomize seed values — applies to action:"rerun" and action:"run_template" (for action:"rerun", combine with inputs.seed to reproduce exactly). It is a NO-OP for action:"enqueue", whose seeds are always used exactly as supplied (issue #865).',
        ),
      prompt_id: z
        .string()
        .optional()
        .describe(
          'action:"rerun" — prompt ID of the generation to re-run. If omitted, uses the most recent execution.',
        ),
      inputs: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          'Overrides applied to every node with a matching input name (e.g. cfg, steps, sampler_name, seed, text). Used by action:"rerun", and by action:"run_url" only when run=true.',
        ),
      url: z
        .string()
        .optional()
        .describe(
          'action:"run_url" — URL of the workflow JSON. Raw .json links and GitHub blob/raw URLs work directly. REQUIRED for that action.',
        ),
      run: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'action:"run_url" — if true, enqueue the fetched workflow for execution and return the prompt_id. ' +
            "Default false: only fetch, validate, and summarize (read-only).",
        ),
      template: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Template name/id: a bundled pack directory name (list_packs action:"list") or a custom-node-contributed workflow template name (list_packs action:"list_templates"). REQUIRED for action:"template_schema" and action:"run_template".',
        ),
      overrides: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          'action:"run_template" — widget overrides keyed \'<nodeId>.<widget_name>\' (action:"template_schema"\'s keys), e.g. {\'6.text\': \'a red fox\', \'3.steps\': 20}.',
        ),
      wait: z
        .boolean()
        .optional()
        .describe(
          'action:"run_template" — block until the job completes and return its outputs. Default false: return {prompt_id} immediately.',
        ),
      timeout_s: z
        .number()
        .positive()
        .optional()
        .describe(
          'action:"run_template" — max seconds to wait when wait:true (default 300). On timeout the job keeps running; poll queue (action:"status").',
        ),
    },
    async (args) => {
      try {
        // workflow/url/template cannot be schema-required in a flat shape, so the
        // handler enforces per-action presence and names the missing field — the
        // same information the old per-tool schemas gave a caller.
        //
        // ABSENCE only, never falsiness: `url: ""` passed z.string() before this
        // consolidation and reached fetchWorkflowFromUrl, which answers with its
        // own validation error; `template: ""` was rejected by z.string().min(1)
        // and still is, at the zod layer where it always lived. A `!x` guard would
        // swallow both paths and answer with generic text instead.
        const requireField = <T>(value: T | undefined, action: string, field: string, what: string): T => {
          if (value === undefined) {
            throw new ValidationError(
              `enqueue_workflow action:"${action}" requires \`${field}\` — ${what}.`,
            );
          }
          return value;
        };

        switch (args.action) {
          case "enqueue": {
            const workflow = requireField(
              args.workflow,
              "enqueue",
              "workflow",
              "the API-format graph to submit",
            );
            // Every seed in this caller-built workflow is caller-fixed; replacing
            // one with a random value silently destroyed reproducible runs and
            // could exceed the node's declared max (issue #865). `args
            // .disable_random_seed` is deliberately NOT forwarded here — see its
            // description.
            const result = await enqueueWorkflow(workflow, {
              disable_random_seed: true,
            });

            // Log generation settings (best-effort, don't fail the response)
            try {
              const tracker = getTracker();
              const settings = await extractSettings(workflow, tracker.fileHasher);
              if (settings) {
                const { settingsHash, reuseCount } = tracker.logGeneration(settings);
                logger.info("Generation tracked", { settingsHash, reuseCount });
              }
            } catch (trackErr) {
              logger.warn("Failed to track generation settings", {
                error: trackErr instanceof Error ? trackErr.message : trackErr,
              });
            }

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
          }
          case "rerun": {
            const history = await getHistory(args.prompt_id);
            const selected = selectNewestHistoryEntry(history, args.prompt_id);
            if (!selected) {
              throw new ValidationError(
                args.prompt_id
                  ? `No execution history found for prompt ${args.prompt_id}.`
                  : "No execution history available to re-run.",
              );
            }

            const [sourcePromptId, entry] = selected;
            const workflow = extractWorkflowGraph(entry);
            if (!workflow) {
              throw new ValidationError(
                `History entry ${sourcePromptId} has no usable prompt graph to re-run.`,
              );
            }

            const next = applyOverrides(workflow, args.inputs);
            const result = await enqueueWorkflow(next, {
              disable_random_seed: args.disable_random_seed,
              // An override like inputs.seed is a caller-fixed value; keep it while
              // the other seeds re-randomize (issue #865).
              preserve_seed_inputs: Object.keys(args.inputs ?? {}),
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
                      source_prompt_id: sourcePromptId,
                      overrides_applied: args.inputs ?? {},
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
          case "run_url":
            return await runWorkflowUrlAction({
              url: requireField(args.url, "run_url", "url", "the URL of the workflow JSON to fetch"),
              run: args.run,
              inputs: args.inputs,
            });
          case "template_schema":
            return await templateSchemaAction({
              template: requireField(args.template, "template_schema", "template", "the pack or workflow-template name to inspect"),
            });
          case "run_template":
            return await runTemplateAction({
              template: requireField(args.template, "run_template", "template", "the bundled pack name to run"),
              overrides: args.overrides,
              wait: args.wait,
              timeout_s: args.timeout_s,
              disable_random_seed: args.disable_random_seed,
            });
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown enqueue_workflow action "${String(exhaustive)}". Expected one of: ${ENQUEUE_ACTIONS.join(", ")}.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

}
