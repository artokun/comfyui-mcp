import { join } from "node:path";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import type { GenerationEntry } from "./generation-tracker.js";
import type { FileHasher } from "./file-hasher.js";

/**
 * Node class types we recognize for extracting generation settings.
 */
const SAMPLER_NODES = new Set([
  "KSampler",
  "KSamplerAdvanced",
  "SamplerCustom",
  "QwenImageIntegratedKSampler",
]);

const MODEL_LOADER_NODES = new Set([
  "CheckpointLoaderSimple",
  "CheckpointLoader",
  "UNETLoader",
  "unCLIPCheckpointLoader",
]);

const LORA_NODES = new Set([
  "LoraLoader",
  "LoraLoaderModelOnly",
]);

const VAE_DECODE_NODES = new Set([
  "VAEDecode",
  "VAEDecodeTiled",
]);

interface WorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
}

type WorkflowJSON = Record<string, WorkflowNode>;

/**
 * Resolve a node input reference. ComfyUI links are [nodeId, outputIndex].
 */
function resolveRef(
  workflow: WorkflowJSON,
  value: unknown,
): WorkflowNode | null {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string") {
    return workflow[value[0]] ?? null;
  }
  return null;
}

/**
 * Walk upward from a sampler node to find the model loader.
 */
function findModelLoader(
  workflow: WorkflowJSON,
  samplerNode: WorkflowNode,
): WorkflowNode | null {
  // KSampler.model input
  const modelRef = samplerNode.inputs.model;
  if (!modelRef) return null;

  const modelNode = resolveRef(workflow, modelRef);
  if (!modelNode) return null;

  // Direct loader
  if (MODEL_LOADER_NODES.has(modelNode.class_type)) return modelNode;

  // LoRA in between — follow through
  if (LORA_NODES.has(modelNode.class_type)) {
    const upstream = resolveRef(workflow, modelNode.inputs.model);
    if (upstream && MODEL_LOADER_NODES.has(upstream.class_type)) return upstream;
  }

  return null;
}

/**
 * Walk upward from a sampler node to find a LoRA loader.
 */
function findLoraLoader(
  workflow: WorkflowJSON,
  samplerNode: WorkflowNode,
): WorkflowNode | null {
  const modelRef = samplerNode.inputs.model;
  if (!modelRef) return null;

  const modelNode = resolveRef(workflow, modelRef);
  if (!modelNode) return null;

  if (LORA_NODES.has(modelNode.class_type)) return modelNode;

  return null;
}

/**
 * Determine model family from checkpoint name and node types.
 */
function inferModelFamily(
  checkpointName: string,
  loaderClassType: string,
  samplerInputs: Record<string, unknown>,
): string {
  const lower = checkpointName.toLowerCase();

  // Specific finetuned models first (before generic "qwen" match)
  if (lower.includes("copax")) return "qwen_finetuned";
  if (lower.includes("redcraft")) return "qwen_finetuned";
  if (lower.includes("ultimaterealism") || lower.includes("imageized")) return "qwen_finetuned";
  if (lower.includes("z-image") || lower.includes("zimage")) return "z_image";

  // Generic architecture matches
  if (lower.includes("qwen") && lower.includes("edit")) return "qwen_image_edit";
  if (lower.includes("qwen")) return "qwen_image";
  if (lower.includes("flux")) return "flux";
  if (lower.includes("sdxl") || lower.includes("sd_xl")) return "sdxl";
  if (lower.includes("illustrious")) return "illustrious";
  if (lower.includes("pony")) return "pony";
  if (lower.includes("sd3") || lower.includes("sd_3")) return "sd35";

  // Check by loader type
  if (loaderClassType === "UNETLoader") {
    if (samplerInputs.auraflow_shift != null) return "qwen_image";
  }

  return "unknown";
}

/**
 * Extract generation settings from a ComfyUI API-format workflow.
 * Returns null if no sampler node is found.
 */
export async function extractSettings(
  workflow: WorkflowJSON,
  hasher: FileHasher,
): Promise<GenerationEntry | null> {
  // Find the primary sampler node
  let samplerNode: WorkflowNode | null = null;
  let samplerNodeId = "";

  for (const [id, node] of Object.entries(workflow)) {
    if (SAMPLER_NODES.has(node.class_type)) {
      samplerNode = node;
      samplerNodeId = id;
      break;
    }
  }

  if (!samplerNode) {
    logger.debug("No sampler node found in workflow — skipping tracking");
    return null;
  }

  const inputs = samplerNode.inputs;

  // Extract sampler params
  const sampler = String(inputs.sampler_name ?? inputs.sampler ?? "unknown");
  const scheduler = String(inputs.scheduler ?? "unknown");
  const steps = Number(inputs.steps ?? 0);
  const cfg = Number(inputs.cfg ?? inputs.cfg_scale ?? 0);
  const denoise = Number(inputs.denoise ?? 1.0);
  const shift = inputs.auraflow_shift != null ? Number(inputs.auraflow_shift) : null;

  // Extract resolution from latent_image input or direct width/height
  let width = Number(inputs.width ?? 0);
  let height = Number(inputs.height ?? 0);

  if (width === 0 || height === 0) {
    // Try to find EmptyLatentImage node connected to latent_image input
    const latentRef = inputs.latent_image;
    const latentNode = resolveRef(workflow, latentRef);
    if (latentNode) {
      width = Number(latentNode.inputs.width ?? 0);
      height = Number(latentNode.inputs.height ?? 0);
    }
  }

  // Find model loader
  let modelName: string | null = null;
  let modelHash = "UNKNOWN";
  let modelFamily = "unknown";

  const isIntegrated = samplerNode.class_type === "QwenImageIntegratedKSampler";

  let loaderClassType = "CheckpointLoaderSimple";

  if (isIntegrated) {
    // QwenImageIntegratedKSampler has unet, clip, vae inputs directly
    const unetRef = resolveRef(workflow, inputs.unet);
    if (unetRef && MODEL_LOADER_NODES.has(unetRef.class_type)) {
      loaderClassType = unetRef.class_type;
      modelName =
        String(unetRef.inputs.unet_name ?? unetRef.inputs.ckpt_name ?? "");
    }
  } else {
    const loader = findModelLoader(workflow, samplerNode);
    if (loader) {
      loaderClassType = loader.class_type;
      modelName =
        String(loader.inputs.ckpt_name ?? loader.inputs.unet_name ?? "");
    }
  }

  if (modelName) {
    modelFamily = inferModelFamily(modelName, loaderClassType, inputs);

    // Hash the model file — resolve correct models/ subdirectory based on loader type
    try {
      const modelDir =
        loaderClassType === "UNETLoader" ? "unet" : "checkpoints";
      const modelsRoot = config.comfyuiPath
        ? join(config.comfyuiPath, "models", modelDir)
        : "";
      if (modelsRoot) {
        const hashResult = await hasher.getHash(
          join(modelsRoot, modelName),
          loaderClassType === "UNETLoader" ? "unet" : "checkpoint",
        );
        modelHash = hashResult.autov2;
      }
    } catch (err) {
      logger.warn(`Could not hash model file: ${modelName}`, {
        error: err instanceof Error ? err.message : err,
      });
    }
  }

  // Find LoRA
  let loraName: string | null = null;
  let loraHash: string | null = null;
  let loraStrength: number | null = null;
  let loraCivitaiId: number | null = null;

  const loraLoader = isIntegrated ? null : findLoraLoader(workflow, samplerNode);
  if (loraLoader) {
    loraName = String(loraLoader.inputs.lora_name ?? "");
    loraStrength = Number(loraLoader.inputs.strength_model ?? 1.0);

    // Hash the LoRA file
    try {
      const loraPath = config.comfyuiPath
        ? join(config.comfyuiPath, "models", "loras", loraName)
        : "";
      if (loraPath) {
        const hashResult = await hasher.getHash(loraPath, "lora");
        loraHash = hashResult.autov2;
        loraCivitaiId = hashResult.civitaiId;
      }
    } catch (err) {
      logger.warn(`Could not hash LoRA file: ${loraName}`, {
        error: err instanceof Error ? err.message : err,
      });
    }
  }

  return {
    modelFamily,
    modelHash,
    modelName,
    presetName: null, // Could be inferred from model-settings.json match in the future
    sampler,
    scheduler,
    steps,
    cfg,
    denoise,
    shift,
    width,
    height,
    loraHash,
    loraName,
    loraStrength,
    loraCivitaiId,
    negPromptHash: null, // Could hash negative prompt text in the future
  };
}
