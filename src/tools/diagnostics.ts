import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getLogs,
  getHistory,
  type HistoryEntry,
} from "../comfyui/client.js";
import { selectNewestHistoryEntry, extractWorkflowGraph } from "../services/history-select.js";
import { validateWorkflow } from "../services/workflow-validator.js";
import { errorToToolResult } from "../utils/errors.js";

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
          items as Array<{ filename: string; subfolder?: string }>
        )
          .map((m) => (m.subfolder ? `${m.subfolder}/${m.filename}` : m.filename))
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

export function registerDiagnosticsTools(server: McpServer): void {
  server.tool(
    "get_logs",
    "Get ComfyUI server runtime logs. Useful for debugging execution errors, model loading issues, missing nodes, and Python tracebacks.",
    {
      max_lines: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe("Maximum number of log lines to return from the end (default: 100)"),
      keyword: z
        .string()
        .optional()
        .describe("Filter log lines containing this keyword (case-insensitive). Examples: 'error', 'warning', 'VRAM', a node name"),
    },
    async (args) => {
      try {
        let lines = await getLogs();

        // Filter by keyword if provided
        if (args.keyword) {
          const kw = args.keyword.toLowerCase();
          lines = lines.filter((line) => line.toLowerCase().includes(kw));
        }

        // Tail to max_lines
        const maxLines = args.max_lines ?? 100;
        if (lines.length > maxLines) {
          lines = lines.slice(-maxLines);
        }

        // Strip ANSI escape codes for readability
        const clean = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

        const text = clean.length === 0
          ? `No log lines found${args.keyword ? ` matching "${args.keyword}"` : ""}.`
          : clean.join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "get_history",
    "Get execution history for a ComfyUI prompt. Returns status, timing, cached nodes, output details, and full error information including Python tracebacks. Use after a failed enqueue_workflow to diagnose what went wrong.",
    {
      prompt_id: z
        .string()
        .optional()
        .describe(
          "Specific prompt ID to look up (returned by enqueue_workflow). If omitted, returns the most recent COMMITTED execution (chosen by ComfyUI's queue number, not dict order). Note: immediately after a run finishes it can briefly lag by one until ComfyUI commits the new entry — pass the prompt_id from enqueue_workflow to get that exact run, and prefer the run-finished event for naming a just-produced output.",
        ),
    },
    async (args) => {
      try {
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
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "diagnose_run",
    "WHY DID MY RENDER FAIL / WHAT'S MISSING? Explains a failed run in ONE call, without needing a canvas — the headless counterpart to the panel's panel_view_errored_nodes (\"why is this red?\"), so mobile/remote sessions get the same answer. Returns: the failed node (id, type) with its `exception_type` + message and a trimmed traceback; **missing_models** (the exact model file that isn't installed and the widget holding it — feed the filename to search_civitai_models/download_model to fix it); **missing_node_types** (node classes this install lacks — feed to search_custom_nodes/install_custom_node); and any other per-input validation errors. Call this whenever a run fails, an enqueue is rejected, or the user asks what's missing — instead of guessing from raw logs. With no prompt_id it diagnoses the most recent FAILED run (falling back to the most recent run). Read-only.",
    {
      prompt_id: z
        .string()
        .optional()
        .describe(
          "Specific run to diagnose (the prompt_id from enqueue_workflow). Omit to diagnose the most recent FAILED run — preferred over a newer successful one — falling back to the most recent run if nothing failed.",
        ),
    },
    async (args) => {
      try {
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
        lines.push(`**Status**: ${entry.status?.status_str ?? "unknown"}`);

        // 1. Runtime failure (what actually blew up mid-execution).
        const execError = findExecutionError(entry);
        if (execError) {
          lines.push("");
          lines.push("### Runtime failure");
          lines.push(
            `**Failed node**: ${execError.node_id ?? "?"} (${execError.node_type ?? "unknown type"})`,
          );
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
        } else {
          lines.push("");
          lines.push(
            "_No runtime error recorded for this run_ — if the user still sees a problem, it was likely rejected BEFORE execution (see validation below) or the run simply produced an unwanted result.",
          );
        }

        // 2. Re-validate the exact graph that ran, so we can name what's missing.
        //    Reuses the same validator behind validate_workflow — the graph is the
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
              "_Fix_: search_civitai_models / search_models by that filename, then download_model (or download_civitai_model) into the loader's directory.",
            );
          }

          if (missingNodeTypes.length > 0) {
            lines.push("");
            lines.push("### Missing node types (packs this install lacks)");
            const uniq = [...new Set(missingNodeTypes.map((i) => i.node_type))];
            for (const t of uniq) lines.push(`- **${t}**`);
            lines.push(
              "_Fix_: search_custom_nodes for the owning pack, install_custom_node, then restart ComfyUI to load it.",
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
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
