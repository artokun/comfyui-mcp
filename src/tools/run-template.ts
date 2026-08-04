import { readFileSync } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolvePackWorkflowFile, enumeratePacks } from "./skills-access.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import { modifyWorkflow, type ModifyOperation } from "../services/workflow-composer.js";
import {
  isUiFormat,
  isApiFormat,
  isLinkRef,
  convertUiToApi,
} from "../services/workflow-converter.js";
import { getJobStatus } from "../services/queue-manager.js";
import { getObjectInfo, getHistory } from "../comfyui/client.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import { errorToToolResult, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Rank pack names by similarity to the query for the not-found error. */
function nearMatches(query: string, names: string[]): string[] {
  const q = query.toLowerCase();
  const scored = names
    .map((name) => {
      const n = name.toLowerCase();
      let score = 0;
      if (n === q) score = 100;
      else if (n.includes(q) || q.includes(n)) score = 50;
      else {
        // shared token overlap (packs are dash-delimited, e.g. anima-txt2img)
        const qTokens = new Set(q.split(/[-_ ]+/).filter(Boolean));
        for (const t of n.split(/[-_ ]+/)) if (qTokens.has(t)) score += 10;
      }
      return { name, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 8).map((s) => s.name);
}

/**
 * Parse "<nodeId>.<widget_name>" override keys (the SAME convention
 * get_template_schema emits, so schema→run round-trips) into set_input
 * operations, validating each against the resolved API graph.
 */
function overridesToOps(
  workflow: WorkflowJSON,
  overrides: Record<string, unknown>,
): ModifyOperation[] {
  const ops: ModifyOperation[] = [];
  const nodeKeys = new Set(Object.keys(workflow));
  for (const [key, value] of Object.entries(overrides)) {
    const dot = key.indexOf(".");
    if (dot <= 0 || dot === key.length - 1) {
      throw new ValidationError(
        `Invalid override key "${key}". Use "<nodeId>.<widget_name>", e.g. "3.seed" or "6.text" (the keys get_template_schema reports).`,
      );
    }
    const nodeId = key.slice(0, dot);
    const widget = key.slice(dot + 1);
    const node = workflow[nodeId];
    if (!node) {
      // #809: an id list clipped at 40 with no marker looks exhaustive, so a caller
      // whose node sits past the cut concludes the id does not exist at all. Say it was
      // cut, and name the tool that reports every override key.
      const allIds = Object.keys(workflow);
      const ids = allIds.slice(0, 40).join(", ");
      const more =
        allIds.length > 40
          ? ` (+${allIds.length - 40} more not listed — get_template_schema reports every override key)`
          : "";
      throw new ValidationError(
        `Override "${key}": no node "${nodeId}" in the template's graph. Node ids: ${ids}${more}`,
      );
    }
    const widgetInputs = Object.entries(node.inputs ?? {})
      .filter(([, v]) => !isLinkRef(v, nodeKeys))
      .map(([k]) => k);
    if (!node.inputs || !(widget in node.inputs)) {
      const avail = widgetInputs.join(", ") || "(none)";
      throw new ValidationError(
        `Override "${key}": node ${nodeId} (${node.class_type}) has no input "${widget}". Overridable widgets: ${avail}`,
      );
    }
    if (isLinkRef(node.inputs[widget], nodeKeys)) {
      throw new ValidationError(
        `Override "${key}": input "${widget}" on node ${nodeId} (${node.class_type}) is a graph CONNECTION, not a widget — overriding it would break the graph. Overridable widgets: ${widgetInputs.join(", ") || "(none)"}. Use modify_workflow to rewire connections.`,
      );
    }
    ops.push({ op: "set_input", node_id: nodeId, input_name: widget, value });
  }
  return ops;
}

/** Load a template's graph and normalize it to API format for enqueue. */
async function loadTemplateApiGraph(wfFile: string): Promise<WorkflowJSON> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(wfFile, "utf8"));
  } catch (err) {
    throw new ValidationError(
      `Template workflow file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (isApiFormat(parsed)) return parsed;
  if (isUiFormat(parsed)) {
    const objectInfo = await getObjectInfo();
    const { workflow, warnings } = convertUiToApi(parsed, objectInfo);
    if (warnings.length) {
      logger.warn("run_template: UI→API conversion warnings", { warnings });
    }
    return workflow;
  }
  throw new ValidationError(
    "Template workflow is neither UI nor API format — cannot enqueue it.",
  );
}

export function registerRunTemplateTools(server: McpServer): void {
  server.tool(
    "run_template",
    "ONE-SHOT: run a named workflow template (a bundled pack from list_packs) with optional overrides. Resolves the template's expert graph, applies overrides, and enqueues it — replacing the manual read_pack_workflow → modify_workflow → enqueue_workflow chain. Override keys are '<nodeId>.<widget_name>' (e.g. {'6.text': 'a cat', '3.seed': 42}) — the SAME keys the companion get_template_schema tool reports (when available), so schema→run round-trips; only widget values can be overridden, never graph connections. By default returns {prompt_id} immediately; pass wait:true to block until the job completes and return its outputs (images etc.). Unresolvable template names return a clear error with near-matches.",
    {
      template: z
        .string()
        .min(1)
        .describe("Template name — a bundled pack directory (from list_packs), e.g. 'anima-txt2img'."),
      overrides: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          "Widget overrides keyed '<nodeId>.<widget_name>' (get_template_schema's keys), e.g. {'6.text': 'a red fox', '3.steps': 20}.",
        ),
      wait: z
        .boolean()
        .optional()
        .describe("Block until the job completes and return its outputs. Default false: return {prompt_id} immediately."),
      timeout_s: z
        .number()
        .positive()
        .optional()
        .describe("Max seconds to wait when wait:true (default 300). On timeout the job keeps running; poll queue (action:\"status\")."),
      disable_random_seed: z
        .boolean()
        .optional()
        .describe("If true, do not randomize seed values (combine with a seed override to reproduce exactly)."),
    },
    async (args) => {
      try {
        // 1. Resolve the template (same resolution as read_pack_workflow).
        const wfFile = resolvePackWorkflowFile(args.template);
        if (!wfFile) {
          const known = enumeratePacks()
            .filter((p) => p.has_workflow)
            .map((p) => String(p.name));
          const near = nearMatches(args.template, known);
          throw new ValidationError(
            `No template named "${args.template}".` +
              (near.length
                ? ` Did you mean: ${near.join(", ")}?`
                : ` Available templates: ${known.join(", ") || "(none bundled)"}.`) +
              " Use list_packs to browse all templates.",
          );
        }

        // 2. Load + normalize to API format, then apply overrides via the
        //    shared modifyWorkflow (set_input) service.
        let workflow = await loadTemplateApiGraph(wfFile);
        const overrides = args.overrides ?? {};
        const ops = overridesToOps(workflow, overrides);
        if (ops.length) {
          workflow = modifyWorkflow(workflow, ops).workflow;
        }

        // 3. Enqueue via the existing enqueue service.
        const result = await enqueueWorkflow(workflow, {
          disable_random_seed: args.disable_random_seed,
        });

        const base = {
          status: "enqueued",
          template: args.template,
          prompt_id: result.prompt_id,
          queue_remaining: result.queue_remaining,
          overrides_applied: Object.keys(overrides),
        };

        if (!args.wait) {
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(base, null, 2) },
            ],
          };
        }

        // 4. Minimal wait: poll the job-status service until done or timeout.
        //    (Kept deliberately simple — for a bare enqueue, call
        //    enqueue_workflow and poll queue action:"status" yourself.)
        const timeoutMs = (args.timeout_s ?? 300) * 1000;
        const start = Date.now();
        for (;;) {
          const status = await getJobStatus(result.prompt_id);
          if (status.done) {
            let outputs: unknown = null;
            try {
              const history = await getHistory(result.prompt_id);
              outputs = history[result.prompt_id]?.outputs ?? null;
            } catch (err) {
              logger.warn("run_template: could not fetch outputs from history", {
                prompt_id: result.prompt_id,
                error: err instanceof Error ? err.message : err,
              });
            }
            const failed = Boolean(status.error);
            return {
              ...(failed ? { isError: true } : {}),
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      ...base,
                      status: failed ? "failed" : "completed",
                      ...(status.error ? { error: status.error } : {}),
                      ...(status.text_outputs ? { text_outputs: status.text_outputs } : {}),
                      outputs,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
          if (Date.now() - start >= timeoutMs) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      ...base,
                      status: "timeout",
                      message: `Job still ${status.running ? "running" : "pending"} after ${args.timeout_s ?? 300}s — it was NOT cancelled. Poll queue (action:"status") with prompt_id "${result.prompt_id}" for completion.`,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
          await sleep(1500);
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
