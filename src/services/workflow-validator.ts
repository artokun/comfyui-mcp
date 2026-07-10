import type { WorkflowJSON, ObjectInfo, NodeInputSpec } from "../comfyui/types.js";
import { getObjectInfo } from "../comfyui/client.js";
import { logger } from "../utils/logger.js";
import { analyzeGraphHealth, type GraphHealth } from "./workflow-health.js";

export interface ValidationIssue {
  severity: "error" | "warning" | "info";
  node_id: string;
  node_type: string;
  message: string;
  /** Health-finding kind (disconnected, duplicate_model_load, …) when the issue came from graph-health. */
  kind?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  summary: string;
  /** Structured graph-health analysis, present when `health` was requested. */
  health?: GraphHealth;
}

/**
 * Validate a workflow without executing it.
 * Checks for missing nodes, broken connections, type mismatches, and missing models.
 *
 * @param workflow The workflow to validate (API format).
 * @param options.health Merge graph-health heuristics (disconnected nodes, duplicate
 *   model loads, orphaned branches, muted/bypassed) as info/warning issues plus a
 *   structured `health` section. Health findings NEVER flip `valid`. Default true.
 */
export async function validateWorkflow(
  workflow: WorkflowJSON,
  options: { health?: boolean } = {},
): Promise<ValidationResult> {
  const includeHealth = options.health ?? true;
  const issues: ValidationIssue[] = [];

  // 1. Fetch available node definitions
  let objectInfo: ObjectInfo;
  try {
    objectInfo = await getObjectInfo();
  } catch (err) {
    return {
      valid: false,
      issues: [
        {
          severity: "error",
          node_id: "",
          node_type: "",
          message: `Cannot connect to ComfyUI to validate: ${err instanceof Error ? err.message : err}`,
        },
      ],
      summary: "Validation failed: cannot reach ComfyUI",
    };
  }

  const nodeIds = Object.keys(workflow);

  // 2. Check each node
  for (const nodeId of nodeIds) {
    const node = workflow[nodeId];
    const classType = node.class_type;

    // 2a. Check node type exists
    const nodeDef = objectInfo[classType];
    if (!nodeDef) {
      issues.push({
        severity: "error",
        node_id: nodeId,
        node_type: classType,
        message: `Unknown node type "${classType}". This node may not be installed.`,
      });
      continue; // Can't validate inputs without the definition
    }

    // 2b. Check required inputs are present
    const requiredInputs = nodeDef.input?.required ?? {};
    for (const [inputName, inputSpec] of Object.entries(requiredInputs)) {
      if (!(inputName in node.inputs)) {
        issues.push({
          severity: "error",
          node_id: nodeId,
          node_type: classType,
          message: `Missing required input "${inputName}"`,
        });
      }
    }

    // 2c. Check connections point to existing nodes
    for (const [inputName, value] of Object.entries(node.inputs)) {
      if (
        Array.isArray(value) &&
        value.length === 2 &&
        typeof value[0] === "string" &&
        typeof value[1] === "number"
      ) {
        const [sourceId, outputIndex] = value;
        if (!workflow[sourceId]) {
          issues.push({
            severity: "error",
            node_id: nodeId,
            node_type: classType,
            message: `Input "${inputName}" references node "${sourceId}" which doesn't exist in the workflow`,
          });
          continue;
        }

        // Check output index is valid
        const sourceNode = workflow[sourceId];
        const sourceDef = objectInfo[sourceNode.class_type];
        if (sourceDef && sourceDef.output) {
          if (outputIndex >= sourceDef.output.length) {
            issues.push({
              severity: "error",
              node_id: nodeId,
              node_type: classType,
              message: `Input "${inputName}" references output index ${outputIndex} of node "${sourceId}" (${sourceNode.class_type}), but it only has ${sourceDef.output.length} outputs`,
            });
          }
        }
      }
    }

    // 2d. Check every combo (dropdown) value against objectInfo's valid options
    checkComboValues(nodeId, classType, node.inputs, issues, objectInfo);
  }

  // 3. Check for cycles (basic: no self-references)
  for (const nodeId of nodeIds) {
    const node = workflow[nodeId];
    for (const [inputName, value] of Object.entries(node.inputs)) {
      if (
        Array.isArray(value) &&
        value.length === 2 &&
        value[0] === nodeId
      ) {
        issues.push({
          severity: "error",
          node_id: nodeId,
          node_type: node.class_type,
          message: `Self-referencing connection on input "${inputName}"`,
        });
      }
    }
  }

  // 4. Check for output nodes
  const hasOutput = nodeIds.some((id) => {
    const ct = workflow[id].class_type;
    return (
      ct === "SaveImage" ||
      ct === "PreviewImage" ||
      ct === "SaveAnimatedWEBP" ||
      ct === "SaveAnimatedPNG" ||
      objectInfo[ct]?.output_node === true
    );
  });
  if (!hasOutput) {
    issues.push({
      severity: "warning",
      node_id: "",
      node_type: "",
      message: "Workflow has no output node (SaveImage, PreviewImage, etc.). Nothing will be generated.",
    });
  }

  // 5. Graph-health heuristics (merged as info/warning issues — never flip `valid`).
  let health: GraphHealth | undefined;
  if (includeHealth) {
    health = analyzeGraphHealth(workflow, objectInfo);
    for (const f of health.findings) {
      // Authoritative missing_required_input is already reported as an error above
      // (step 2b) for installed nodes — don't double-report. The heuristic variant
      // (uninstalled node) is NOT covered by the validator, so it adds value.
      if (f.kind === "missing_required_input" && !f.heuristic) continue;
      issues.push({
        severity: f.severity,
        node_id: f.node_ids[0] ?? "",
        node_type: f.node_type ?? "",
        message: f.detail,
        kind: f.kind,
      });
    }
  }

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const valid = errors.length === 0;

  const summary = valid
    ? warnings.length > 0
      ? `Workflow is valid with ${warnings.length} warning(s)`
      : "Workflow is valid"
    : `Workflow has ${errors.length} error(s) and ${warnings.length} warning(s)`;

  return { valid, issues, summary, health };
}

/**
 * Check that every combo (dropdown) widget value is one ComfyUI actually offers —
 * mirroring ComfyUI's OWN frontend validator, which rejects an out-of-list value
 * with `value_not_in_list` (the "N ERRORS" the user sees in the error panel). This
 * catches BOTH classes the frontend flags as errors:
 *   - missing models (a `*.safetensors`/`*.gguf`/… value not in the loader's list,
 *     incl. the empty-list case when nothing is installed), and
 *   - any other invalid dropdown value (a wrong `type`, `sampler_name`, `scheduler`,
 *     an uploaded-file name that isn't present, etc.).
 * Uses /object_info's authoritative option lists (all model search paths, subdirs,
 * and custom loaders — no hardcoded mappings). A value fed by a CONNECTION (not a
 * literal widget value) is skipped: it can't be validated statically.
 */
function checkComboValues(
  nodeId: string,
  classType: string,
  inputs: Record<string, unknown>,
  issues: ValidationIssue[],
  objectInfo: ObjectInfo,
): void {
  const nodeDef = objectInfo[classType];
  if (!nodeDef) return;

  const allInputDefs: Record<string, NodeInputSpec> = {
    ...nodeDef.input?.required,
    ...nodeDef.input?.optional,
  };

  for (const [inputName, inputSpec] of Object.entries(allInputDefs)) {
    // A combo input's spec is `[ [...options], {config?} ]`. Non-combos (INT/FLOAT/
    // STRING/BOOLEAN, or a linked node-type string) have a non-array first element.
    if (!Array.isArray(inputSpec) || !Array.isArray(inputSpec[0])) continue;

    const value = inputs[inputName];
    // Only a literal widget value is checkable; a connection is `[nodeId, outIdx]`.
    if (typeof value !== "string") continue;

    const validValues = inputSpec[0] as unknown[];
    // Only validate string option lists (model names, types, samplers, schedulers…).
    // A non-empty non-string/mixed list (rare) is skipped to avoid false positives;
    // an EMPTY list is validated (that's the "nothing installed" → not in [] case).
    if (validValues.length > 0 && !validValues.every((v) => typeof v === "string")) continue;
    if (validValues.includes(value)) continue;

    const isModel = /\.(safetensors|gguf|ckpt|pt|pth|bin|sft)$/i.test(value);
    const hint = isModel
      ? " This model file isn't installed here (or ComfyUI needs a restart to see it) — download it or fix the path/filename."
      : validValues.length
        ? ` Valid options: ${(validValues as string[])
            .slice(0, 8)
            .map((v) => `"${v}"`)
            .join(", ")}${validValues.length > 8 ? ", …" : ""}.`
        : ` No options are available for "${inputName}" on this ComfyUI (the source list is empty).`;

    issues.push({
      severity: "error",
      node_id: nodeId,
      node_type: classType,
      message: `"${inputName}" = "${value}" is not in the list of valid options (value_not_in_list).${hint}`,
    });
  }
}
