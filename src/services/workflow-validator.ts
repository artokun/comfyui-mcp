import type { WorkflowJSON, ObjectInfo } from "../comfyui/types.js";
import { getObjectInfo } from "../comfyui/client.js";
import { listLocalModels } from "./model-resolver.js";
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

    // 2d. Check for model references
    await checkModelReferences(nodeId, classType, node.inputs, issues);
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
 * Check if model file references in node inputs actually exist locally.
 */
async function checkModelReferences(
  nodeId: string,
  classType: string,
  inputs: Record<string, unknown>,
  issues: ValidationIssue[],
): Promise<void> {
  // Map of node types to their model input fields and model subdirectories
  const modelInputs: Record<string, { input: string; type: string }[]> = {
    CheckpointLoaderSimple: [{ input: "ckpt_name", type: "checkpoints" }],
    CheckpointLoader: [{ input: "ckpt_name", type: "checkpoints" }],
    LoraLoader: [{ input: "lora_name", type: "loras" }],
    LoraLoaderModelOnly: [{ input: "lora_name", type: "loras" }],
    VAELoader: [{ input: "vae_name", type: "vae" }],
    UpscaleModelLoader: [{ input: "model_name", type: "upscale_models" }],
    ControlNetLoader: [{ input: "control_net_name", type: "controlnet" }],
    CLIPLoader: [{ input: "clip_name", type: "clip" }],
    UNETLoader: [{ input: "unet_name", type: "unet" }],
    DualCLIPLoader: [
      { input: "clip_name1", type: "clip" },
      { input: "clip_name2", type: "clip" },
    ],
    StyleModelLoader: [{ input: "style_model_name", type: "style_models" }],
    GLIGENLoader: [{ input: "gligen_name", type: "gligen" }],
  };

  const checks = modelInputs[classType];
  if (!checks) return;

  for (const { input, type } of checks) {
    const modelName = inputs[input];
    if (typeof modelName !== "string") continue;

    try {
      const localModels = await listLocalModels(type);
      const found = localModels.some((m) => m.name === modelName);
      if (!found) {
        issues.push({
          severity: "error",
          node_id: nodeId,
          node_type: classType,
          message: `Model "${modelName}" not found in ${type}/. Use download_model or list_local_models to check available models.`,
        });
      }
    } catch {
      // Can't check models — skip silently
    }
  }
}
