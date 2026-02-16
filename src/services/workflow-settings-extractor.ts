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
 *
 * Base versions confirmed via CivitAI hash lookup + HuggingFace:
 *  - copaxTimeless_qwenUltraRealistic → Qwen-Image-2512 (CivitAI #118111, user confirmed)
 *  - qwenUltimateRealism_v11 (Imageized) → original Qwen-Image (CivitAI #2027494, published Oct 2025)
 *  - qwenImageEditRemix_v10 → Qwen-Image-Edit-2511 (HuggingFace Phr00t/Qwen-Image-Edit-Rapid-AIO)
 *  - redcraftRedzimage → Z-Image family (NOT Qwen)
 */
function inferModelFamily(
  checkpointName: string,
  loaderClassType: string,
  samplerInputs: Record<string, unknown>,
): string {
  const lower = checkpointName.toLowerCase();

  // --- Z-Image family (check BEFORE Qwen — redcraftRedzimage contains both "redcraft" and "redzim") ---
  if (lower.includes("z-image") || lower.includes("zimage") || lower.includes("redzim")) return "z_image";

  // --- Qwen Image versioned models (order: version in filename → known finetuned → generic) ---

  // Extract Qwen version if present: matches "2512", "2511", "2509", etc.
  const qwenVersionMatch = lower.match(/(?:qwen[_-]?(?:image)?[_-]?)?(25\d{2})/);
  const qwenVersion = qwenVersionMatch?.[1]; // e.g. "2512", "2511", "2509"

  // Qwen versioned base models (official releases with version in filename)
  if (qwenVersion) {
    const isEdit = lower.includes("edit") || qwenVersion === "2511" || qwenVersion === "2509";
    return isEdit ? `qwen_image_${qwenVersion}_edit` : `qwen_image_${qwenVersion}`;
  }

  // Qwen finetuned models with CONFIRMED base versions
  if (lower.includes("copax") && lower.includes("qwen")) return "qwen_image_2512_finetuned";
  if (lower.includes("ultimaterealism")) return "qwen_image_finetuned";
  if (lower.includes("qwen") && lower.includes("editremix")) return "qwen_image_2511_edit_finetuned";

  // Qwen generic (has "qwen" but no version number and not a known finetune)
  if (lower.includes("qwen") && lower.includes("edit")) return "qwen_image_edit";
  if (lower.includes("qwen") && lower.includes("image")) return "qwen_image";

  // --- Non-Qwen architectures ---
  if (lower.includes("flux") || lower.includes("klein")) return "flux";
  if (lower.includes("wan2")) return "wan";
  if (lower.includes("ltx")) return "ltx";
  if (lower.includes("sdxl") || lower.includes("sd_xl")) return "sdxl";
  if (lower.includes("illustrious")) return "illustrious";
  if (lower.includes("pony")) return "pony";
  if (lower.includes("sd3") || lower.includes("sd_3")) return "sd35";

  // Fallback: infer from loader type + sampler hints
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
    // QwenImageIntegratedKSampler: v1 uses "unet" input, v2 uses "model" input
    const modelInput = inputs.model ?? inputs.unet;
    const unetRef = resolveRef(workflow, modelInput);
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

    // Hash the model file — try multiple directories since ComfyUI maps
    // UNETLoader to both unet/ and diffusion_models/, and CheckpointLoader
    // to checkpoints/
    if (config.comfyuiPath) {
      const candidateDirs =
        loaderClassType === "UNETLoader"
          ? ["unet", "diffusion_models", "checkpoints"]
          : ["checkpoints", "unet", "diffusion_models"];
      const fileType = loaderClassType === "UNETLoader" ? "unet" : "checkpoint";

      for (const dir of candidateDirs) {
        try {
          const hashResult = await hasher.getHash(
            join(config.comfyuiPath, "models", dir, modelName),
            fileType,
          );
          modelHash = hashResult.autov2;
          break; // Found it
        } catch {
          // Not in this directory, try next
        }
      }

      if (modelHash === "UNKNOWN") {
        logger.warn(`Model file not found in any directory: ${modelName}`);
      }
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
