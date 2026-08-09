import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  getLogs,
  getHistory,
  type HistoryEntry,
} from "../comfyui/client.js";
import { selectNewestHistoryEntry, extractWorkflowGraph } from "../services/history-select.js";
import { validateWorkflow } from "../services/workflow-validator.js";
import { errorToToolResult } from "../utils/errors.js";
import {
  generationStatsAction,
  suggestSettingsAction,
} from "./generation-tracker.js";

/** The `execution_error` payload ComfyUI records in a history entry's status.messages. */
interface ExecutionErrorInfo {
  node_id?: string | number;
  node_type?: string;
  exception_type?: string;
  exception_message?: string;
  traceback?: string[];
}

function findExecutionError(entry: HistoryEntry): ExecutionErrorInfo | null {
  const msg = (entry.status?.messages ?? []).find((m) => m[0] === "execution_error");
  return msg ? (msg[1] as ExecutionErrorInfo) : null;
}

/** The `execution_interrupted` payload (user/agent cancel mid-run). */
interface ExecutionInterruptedInfo {
  node_id?: string | number;
  node_type?: string;
}

function findExecutionInterrupted(entry: HistoryEntry): ExecutionInterruptedInfo | null {
  const msg = (entry.status?.messages ?? []).find((m) => m[0] === "execution_interrupted");
  return msg ? ((msg[1] ?? {}) as ExecutionInterruptedInfo) : null;
}

/**
 * The Status line + outcome section of a diagnosis. Exported for tests.
 *
 * ComfyUI records an INTERRUPTED run with status_str "error" (plus an
 * execution_interrupted message and NO execution_error) — echoing that raw
 * "error" made cancelled runs read as failures ("Render failed" on mobile,
 * see comfyui-mcp-mobile#23). Report it as interrupted instead; a genuine
 * execution_error always wins over the interrupted marker.
 */
export function formatRunOutcome(entry: HistoryEntry): string[] {
  const lines: string[] = [];
  const execError = findExecutionError(entry);
  const interrupted = execError ? null : findExecutionInterrupted(entry);
  lines.push(`**Status**: ${interrupted ? "interrupted" : (entry.status?.status_str ?? "unknown")}`);

  if (execError) {
    lines.push("");
    lines.push("### Runtime failure");
    lines.push(`**Failed node**: ${execError.node_id ?? "?"} (${execError.node_type ?? "unknown type"})`);
    if (execError.exception_type) lines.push(`**Type**: ${execError.exception_type}`);
    if (execError.exception_message) {
      lines.push(`**Message**: ${execError.exception_message}`);
    }
    if (Array.isArray(execError.traceback) && execError.traceback.length > 0) {
      // Tail only — the last frames carry the cause, and a full traceback can
      // be hundreds of lines (this reply goes straight into an agent's context).
      const tail = execError.traceback.slice(-12);
      lines.push("");
      lines.push("```");
      lines.push(tail.join("").trimEnd());
      lines.push("```");
    }
  } else if (interrupted) {
    lines.push("");
    lines.push("### Interrupted");
    const where =
      interrupted.node_id !== undefined
        ? ` at node ${interrupted.node_id}${interrupted.node_type ? ` (${interrupted.node_type})` : ""}`
        : "";
    lines.push(
      `**This run was interrupted/cancelled${where}** — it did not crash. Nothing is broken; re-queue it if the cancellation wasn't intended.`,
    );
  } else {
    lines.push("");
    lines.push(
      "_No runtime error recorded for this run_ — if the user still sees a problem, it was likely rejected BEFORE execution (see validation below) or the run simply produced an unwanted result.",
    );
  }
  return lines;
}

/**
 * Pick the run to diagnose. An explicit id wins; otherwise prefer the most recent
 * FAILED run over a newer successful one — "why did it fail?" should land on the
 * failure even when the user has since kicked off something that worked.
 */
function selectRunToDiagnose(
  history: Record<string, HistoryEntry>,
  promptId?: string,
): [string, HistoryEntry] | undefined {
  if (promptId) return selectNewestHistoryEntry(history, promptId);
  const failed = Object.entries(history).filter(([, e]) => findExecutionError(e));
  if (failed.length > 0) return selectNewestHistoryEntry(Object.fromEntries(failed));
  return selectNewestHistoryEntry(history);
}

function formatHistoryEntry(
  promptId: string,
  entry: HistoryEntry,
): string {
  const lines: string[] = [];
  const status = entry.status;

  lines.push(`## Execution: ${promptId}`);
  lines.push(`**Status**: ${status.status_str} | Completed: ${status.completed}`);

  // Timing from messages
  const messages = status.messages || [];
  const start = messages.find((m) => m[0] === "execution_start");
  const end = messages.find(
    (m) => m[0] === "execution_success" || m[0] === "execution_error",
  );
  if (start && end) {
    const startTs = (start[1] as { timestamp: number }).timestamp;
    const endTs = (end[1] as { timestamp: number }).timestamp;
    const durationSec = ((endTs - startTs) / 1000).toFixed(2);
    lines.push(`**Duration**: ${durationSec}s`);
  }

  // Cached nodes
  const cached = messages.find((m) => m[0] === "execution_cached");
  if (cached) {
    const cachedNodes = (cached[1] as { nodes: string[] }).nodes;
    if (cachedNodes.length > 0) {
      lines.push(`**Cached nodes**: ${cachedNodes.join(", ")}`);
    }
  }

  // Error details
  const errorMsg = messages.find((m) => m[0] === "execution_error");
  if (errorMsg) {
    const errData = errorMsg[1] as Record<string, unknown>;
    lines.push("");
    lines.push("### Error Details");

    if (errData.node_id) {
      lines.push(`**Failed node**: ${errData.node_id} (${errData.node_type || "unknown type"})`);
    }
    if (errData.exception_message) {
      lines.push(`**Exception**: ${errData.exception_message}`);
    }
    if (errData.exception_type) {
      lines.push(`**Type**: ${errData.exception_type}`);
    }
    if (Array.isArray(errData.traceback) && errData.traceback.length > 0) {
      lines.push("");
      lines.push("**Traceback**:");
      lines.push("```");
      lines.push(errData.traceback.join(""));
      lines.push("```");
    }
  }

  // Interrupted
  const interrupted = messages.find((m) => m[0] === "execution_interrupted");
  if (interrupted) {
    lines.push("");
    lines.push("**Execution was interrupted/cancelled**");
  }

  const outputKeys = Object.keys(entry.outputs || {});
  if (outputKeys.length > 0) {
    lines.push("");
    lines.push(`### Outputs (${outputKeys.length} nodes)`);
    for (const nodeId of outputKeys) {
      const raw = entry.outputs[nodeId];
      if (!raw || typeof raw !== "object") {
        lines.push(`- Node ${nodeId}: (no output data)`);
        continue;
      }
      const output = raw as Record<string, unknown>;
      // Expand media filenames so callers can use get_image directly.
      // Video keys ('videos', 'video', 'gifs') adapted from jcd315's fork
      // (jcd315/comfyui-mcp-muse, commit e13342ec).
      const mediaKeys = ["images", "videos", "video", "gifs"] as const;
      const expanded: string[] = [];
      for (const key of mediaKeys) {
        const items = output[key];
        if (!Array.isArray(items)) continue;
        const fileList = (
          items as Array<{ filename: string; subfolder?: string; type?: string }>
        )
          .map((m) => {
            const path = m.subfolder ? `${m.subfolder}/${m.filename}` : m.filename;
            // Carry each ref's ComfyUI directory TYPE (output/temp/input) so the
            // caller passes the RIGHT `type` to get_image (#554): preview/compare
            // nodes (e.g. PixaromaCompare) write to temp/, not output/, and
            // get_image defaults to output — the old summary dropped the type, so
            // the documented get_image(type:"output") call 404'd on a temp file.
            const type = typeof m.type === "string" && m.type ? m.type : "output";
            return `${path} (type=${type})`;
          })
          .join(", ");
        if (fileList) expanded.push(`${key} → **${fileList}**`);
      }
      if (expanded.length > 0) {
        lines.push(`- Node ${nodeId}: ${expanded.join("; ")}`);
      } else {
        const outputTypes = Object.keys(output);
        lines.push(`- Node ${nodeId}: ${outputTypes.join(", ")}`);
      }
    }
  }

  return lines.join("\n");
}

const HISTORY_ACTIONS = ["list", "diagnose", "stats", "suggest"] as const;

/**
 * `get_system_stats (action:"logs")` — what the retired `get_system_stats (action:"logs")` tool did
 * (0.50.0 slice 13). Same /internal/logs read, same keyword filter, same
 * default-100 tail, same ANSI strip, same "No log lines found" text.
 *
 * `keyword` keeps its TRUTHINESS check rather than an absence check: an empty
 * keyword matched every line before this consolidation ("".toLowerCase() is a
 * substring of everything), and that is the behaviour callers have. This is the
 * filter's own semantics, not a requiredness guard.
 */
export async function getLogsAction(args: {
  max_lines?: number;
  keyword?: string;
}): Promise<CallToolResult> {
  // #1223 — the keyword filter and the tail are handed to getLogs so they run on
  // the RAW log, BEFORE redaction. Filtering here meant matching against text the
  // scrub had already rewritten, so `keyword:"ltxvideo"` answered "No log lines
  // found" for a log that contained it — an absence claim about a line that was
  // right there. Selection and redaction have to happen in that order, and the
  // only way to guarantee it is to not have the raw lines here at all.
  const maxLines = args.max_lines ?? 100;
  const lines = await getLogs({ keyword: args.keyword, maxLines });

  // Strip ANSI escape codes for readability
  const clean = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

  const text =
    clean.length === 0
      ? `No log lines found${args.keyword ? ` matching \"${args.keyword}\"` : ""}.`
      : clean.join("\n");

  return { content: [{ type: "text" as const, text }] };
}
export function registerDiagnosticsTools(server: McpServer): void {
  server.tool(
    "get_history",
    "Read what has already been generated on this machine — execution history, why a run failed, and the settings your past renders actually used. Driven by the `action` parameter:\n" +
      '- action:"list" — Execution history for a ComfyUI prompt: status, timing, cached nodes, and output details (media filenames for get_image action:\"get\"). Also carries the raw error/traceback. To diagnose WHY a run FAILED or what is missing, prefer action:"diagnose" — it returns the same failure info PLUS missing models (with the file + widget) and missing node types, which this action does not. Use action:"list" when you need the run\'s OUTPUTS or timing for a specific prompt_id.\n' +
      '- action:"diagnose" — WHY DID MY RENDER FAIL / WHAT IS MISSING? Explains a failed run in ONE call, without needing a canvas — the headless counterpart to the panel\'s panel_get_errors ("why is this red?"), so mobile/remote sessions get the same answer. Returns: the failed node (id, type) with its `exception_type` + message and a trimmed traceback; **missing_models** (the exact model file that is not installed and the widget holding it — feed the filename to download_model action:\'search_civitai\', then action:\'download_civitai\' — or action:\'search\' then action:\'download\' — to fix it); **missing_node_types** (node classes this install lacks — feed to search_custom_nodes, then install_custom_node); and any other per-input validation errors. Call this whenever a run fails, an enqueue is rejected, or the user asks what is missing — instead of guessing from raw logs. With no prompt_id it diagnoses the most recent FAILED run (falling back to the most recent run). Read-only.\n' +
      '- action:"stats" — Statistics from this MCP server\'s LOCAL generation-history database (populated as you run workflows; NOT from ComfyUI, and not the same source as action:"list"): total generations, count of unique sampler/scheduler/steps/CFG combos, a per-model-family breakdown, and the most-reused settings. Read-only; works without a running ComfyUI. Returns empty stats until you have generated images. For concrete recommended settings rather than aggregate counts, use action:"suggest".\n' +
      '- action:"suggest" — Recommend concrete, proven sampler/scheduler/steps/CFG (and denoise/shift/LoRA) settings derived from that same LOCAL generation-history database. Read-only and works without a running ComfyUI. Narrow results by `model_family`, `lora_hash`, or a name `search`; with no filter it returns the top settings across all history. Returns a ranked list with each combo\'s reuse count, or a "no history" message until you have generated images. Use this for ready-to-apply values; use action:"stats" for aggregate counts and breakdowns rather than specific suggestions.',
    {
      action: z
        .enum(HISTORY_ACTIONS)
        .describe(
          'Which history view to return. "list" and "diagnose" read ComfyUI\'s execution history and take an optional `prompt_id`; "stats" and "suggest" read this server\'s own local generation-settings database and take `model_family` (plus `lora_hash`/`search`/`limit` for "suggest"). No action requires any other field.',
        ),
      prompt_id: z
        .string()
        .optional()
        .describe(
          'Actions "list" and "diagnose" — the prompt ID to look up (returned by enqueue_workflow). For action:"list", if omitted, returns the most recent COMMITTED execution (chosen by ComfyUI\'s queue number, not dict order); immediately after a run finishes it can briefly lag by one until ComfyUI commits the new entry, so pass the prompt_id from enqueue_workflow to get that exact run, and prefer the run-finished event for naming a just-produced output. For action:"diagnose", omit to diagnose the most recent FAILED run — preferred over a newer successful one — falling back to the most recent run if nothing failed.',
        ),
      model_family: z
        .string()
        .optional()
        .describe(
          'Actions "stats" and "suggest" — model-family key to scope to, e.g. \'sdxl\', \'flux\', \'qwen_image\', \'illustrious\'.',
        ),
      lora_hash: z
        .string()
        .optional()
        .describe('action:"suggest" — AutoV2 hash (10 chars) of a specific LoRA to find settings for.'),
      search: z
        .string()
        .optional()
        .describe("action:\"suggest\" — full-text search on model/LoRA filenames (e.g. 'copax', 'lightning')."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('action:"suggest" — max results (default 10).'),
    },
    async (args) => {
      try {
        switch (args.action) {
          case "list": {
            const history = await getHistory(args.prompt_id);
            const selected = selectNewestHistoryEntry(history, args.prompt_id);

            if (!selected) {
              return {
                content: [
                  {
                    type: "text",
                    text: args.prompt_id
                      ? `No history found for prompt ${args.prompt_id}.`
                      : "No execution history available.",
                  },
                ],
              };
            }

            const [promptId, entry] = selected;
            const text = formatHistoryEntry(promptId, entry);
            return { content: [{ type: "text", text }] };
          }
          case "diagnose": {
            const history = await getHistory(args.prompt_id);
            const selected = selectRunToDiagnose(history, args.prompt_id);
            if (!selected) {
              return {
                content: [
                  {
                    type: "text",
                    text: args.prompt_id
                      ? `No history found for prompt ${args.prompt_id}.`
                      : "No execution history available — nothing has run yet on this ComfyUI.",
                  },
                ],
              };
            }

            const [promptId, entry] = selected;
            const lines: string[] = [];
            lines.push(`## Diagnosis: ${promptId}`);
            // 1. Status + outcome: runtime failure, interruption, or clean.
            lines.push(...formatRunOutcome(entry));

            // 2. Re-validate the exact graph that ran, so we can name what's missing.
            //    Reuses the same validator behind create_workflow (action:"validate") — the graph is the
            //    one ComfyUI recorded, so this reflects what actually executed.
            const graph = extractWorkflowGraph(entry);
            if (!graph) {
              lines.push("");
              lines.push(
                "_This history entry has no recorded graph_, so missing models/nodes can't be checked for it.",
              );
            } else {
              const result = await validateWorkflow(graph, { health: false });
              const errors = result.issues.filter((i) => i.severity === "error");
              const missingModels = errors.filter((i) => i.kind === "missing_model");
              const missingNodeTypes = errors.filter((i) => i.kind === "missing_node_type");
              const otherErrors = errors.filter(
                (i) => i.kind !== "missing_model" && i.kind !== "missing_node_type",
              );

              if (missingModels.length > 0) {
                lines.push("");
                lines.push("### Missing models");
                for (const i of missingModels) {
                  lines.push(
                    `- **${i.value ?? "(unknown file)"}** — node ${i.node_id} (${i.node_type}), widget \`${i.input ?? "?"}\``,
                  );
                }
                lines.push(
                  "_Fix_: download_model action:\"search_civitai\" (or action:\"search\") by that filename, then download_model action:\"download\" (or action:\"download_civitai\") into the loader's directory.",
                );
              }

              if (missingNodeTypes.length > 0) {
                lines.push("");
                lines.push("### Missing node types (packs this install lacks)");
                const uniq = [...new Set(missingNodeTypes.map((i) => i.node_type))];
                for (const t of uniq) lines.push(`- **${t}**`);
                lines.push(
                  "_Fix_: search_custom_nodes for the owning pack, install_custom_node with action:'install', then restart ComfyUI to load it.",
                );
              }

              if (otherErrors.length > 0) {
                lines.push("");
                lines.push("### Validation errors");
                for (const i of otherErrors.slice(0, 20)) {
                  lines.push(`- node ${i.node_id} (${i.node_type}): ${i.message}`);
                }
                if (otherErrors.length > 20) {
                  lines.push(`- …and ${otherErrors.length - 20} more`);
                }
              }

              if (errors.length === 0) {
                lines.push("");
                lines.push(
                  "_The recorded graph validates clean_ — nothing is missing, so the failure was a runtime one (see above), not a setup problem.",
                );
              }
            }

            return { content: [{ type: "text", text: lines.join("\n") }] };
          }
          case "stats":
            return await generationStatsAction({ model_family: args.model_family });
          case "suggest":
            return await suggestSettingsAction({
              model_family: args.model_family,
              lora_hash: args.lora_hash,
              search: args.search,
              limit: args.limit,
            });
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown get_history action "${String(exhaustive)}". Expected one of: ${HISTORY_ACTIONS.join(", ")}.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
