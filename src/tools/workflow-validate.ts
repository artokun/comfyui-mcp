import type { WorkflowJSON } from "../comfyui/types.js";
import { validateWorkflow } from "../services/workflow-validator.js";
import { ValidationError } from "../utils/errors.js";

function parseWorkflow(input: unknown): WorkflowJSON {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ValidationError("Workflow JSON must be an object with node IDs as keys");
      }
      return parsed as WorkflowJSON;
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(`Invalid JSON string: ${(err as Error).message}`);
    }
  }
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as WorkflowJSON;
  }
  throw new ValidationError("Workflow must be a JSON string or object");
}

/**
 * `create_workflow (action:"validate")` — the body of the retired standalone
 * workflow-validation tool, verbatim (0.50.0 slice 14).
 *
 * It no longer registers a tool of its own: the surface consolidation folded it
 * into `create_workflow`, which owns the schema and the single try/catch. The
 * WORK stayed here, unchanged — same `validateWorkflow` call, same arguments,
 * same rendered content block — so this file remains the one place the
 * "verdict is derived from the surfaced errors" rendering of #342/#505 lives.
 *
 * Throws instead of returning `errorToToolResult`: the caller wraps every action
 * in the identical `errorToToolResult` catch, so a failure produces the same
 * result object it always did.
 */
export async function validateWorkflowAction(args: {
  workflow: unknown;
  health?: boolean;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const workflow = parseWorkflow(args.workflow);
  const result = await validateWorkflow(workflow, { health: args.health });

  const lines: string[] = [];
  lines.push(`## ${result.summary}`);
  lines.push("");

  // Health findings are rendered in their own "### Graph health" section —
  // exclude them from the Errors/Warnings buckets to avoid double-listing.
  // NOTE: partition on `.health`, NOT `.kind`. Authoritative validator issues
  // (missing_node_type / missing_model / value_not_in_list) also carry `kind`,
  // so filtering by `!i.kind` (the old logic) masked real errors behind
  // "No issues found" while the header still counted them (#342, #505).
  const nonHealth = result.issues.filter((i) => !i.health);
  const errors = nonHealth.filter((i) => i.severity === "error");
  const warnings = nonHealth.filter((i) => i.severity === "warning");

  if (errors.length === 0 && warnings.length === 0) {
    // Health findings are deliberately excluded from the buckets above, so an
    // empty bucket does NOT mean an empty report. Claiming "No issues found"
    // over a graph-health WARNING contradicts the header (which counts health
    // warnings) and buries the one line the caller needed — #2678 was a graph
    // that "validated and executed successfully" and rendered a flat field.
    // Info-level findings stay on the plain ready-to-execute wording; only a
    // warning changes the verdict line.
    // Counted from `issues` -- the very array being partitioned -- so this can never
    // disagree with the header. Reading `result.health.findings` instead would leave a
    // caller whose issues carry health warnings but whose `health` section is absent
    // being told "No issues found" over its own warning.
    const healthWarnings = result.issues.filter(
      (i) => i.health && i.severity === "warning",
    ).length;
    // Verdict is DERIVED from the surfaced errors, never asserted independently.
    lines.push(
      result.valid
        ? healthWarnings > 0
          ? `Nothing here blocks execution, but ${healthWarnings} graph-health warning(s) below flag a graph that may not produce what you intend — read them before running.`
          : "No issues found. The workflow is ready to execute."
        : "No errors were surfaced, but the workflow is NOT valid — see the header and graph-health section below.",
    );
  } else {
    if (errors.length > 0) {
      lines.push("### Errors");
      for (const issue of errors) {
        const loc = issue.node_id
          ? `Node ${issue.node_id} (${issue.node_type})`
          : "Workflow";
        lines.push(`- **${loc}**: ${issue.message}`);
      }
      lines.push("");
    }

    if (warnings.length > 0) {
      lines.push("### Warnings");
      for (const issue of warnings) {
        const loc = issue.node_id
          ? `Node ${issue.node_id} (${issue.node_type})`
          : "Workflow";
        lines.push(`- **${loc}**: ${issue.message}`);
      }
    }
  }

  if (result.health) {
    lines.push("");
    lines.push("### Graph health");
    lines.push(`- ${result.health.summary}`);
    for (const f of result.health.findings) {
      const tag = f.heuristic ? `${f.severity}, heuristic` : f.severity;
      lines.push(`- [${tag}] ${f.detail}`);
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: lines.join("\n"),
      },
    ],
  };
}
