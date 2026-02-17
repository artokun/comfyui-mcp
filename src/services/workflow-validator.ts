import type { WorkflowJSON, ObjectInfo, NodeInputSpec } from "../comfyui/types.js";
import { getObjectInfo } from "../comfyui/client.js";
import { logger } from "../utils/logger.js";

export interface ValidationIssue {
  severity: "error" | "warning";
  node_id: string;
  node_type: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  summary: string;
}

/**
 * Validate a workflow without executing it.
 * Checks for missing nodes, broken connections, type mismatches, and missing models.
 */
export async function validateWorkflow(
  workflow: WorkflowJSON,
): Promise<ValidationResult> {
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

    // 2d. Check for model references using objectInfo dropdown values
    checkModelReferences(nodeId, classType, node.inputs, issues, objectInfo);
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

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const valid = errors.length === 0;

  const summary = valid
    ? warnings.length > 0
      ? `Workflow is valid with ${warnings.length} warning(s)`
      : "Workflow is valid"
    : `Workflow has ${errors.length} error(s) and ${warnings.length} warning(s)`;

  return { valid, issues, summary };
}

/**
 * Check if model file references in node inputs exist in ComfyUI's known models.
 * Uses /object_info dropdown values (ComfyUI's authoritative model list) instead of
 * scanning the filesystem directly. This correctly handles all model search paths,
 * subdirectories, and custom loaders without hardcoded mappings.
 */
function checkModelReferences(
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
    const value = inputs[inputName];
    if (typeof value !== "string") continue;

    // Only check combo inputs (dropdowns) that have an array of valid values
    if (!Array.isArray(inputSpec) || !Array.isArray(inputSpec[0])) continue;

    const validValues = inputSpec[0] as string[];

    // Only check values that look like model files (by extension)
    if (!/\.(safetensors|gguf|ckpt|pt|pth|bin|sft)$/i.test(value)) continue;

    if (!validValues.includes(value)) {
      issues.push({
        severity: "warning",
        node_id: nodeId,
        node_type: classType,
        message: `Model "${value}" not found in ${classType}'s "${inputName}" options (${validValues.length} available). The model may need to be downloaded or ComfyUI restarted.`,
      });
    }
  }
}
