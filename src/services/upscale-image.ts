import type { WorkflowJSON } from "../comfyui/types.js";
import { createWorkflow } from "./workflow-composer.js";
import { DefaultsManager } from "./defaults-manager.js";
import { ValidationError } from "../utils/errors.js";
import { assertSafeInputFilename } from "../utils/input-paths.js";

export interface UpscaleImageArgs {
  /** Filename (in ComfyUI's input dir) of the image to upscale. */
  image: string;
  /** Net upscale factor (default 4). With the default 4x model, scale=2
   *  supersamples the 4x result back to 2x (sharper). */
  scale?: 2 | 4;
  /** Upscale model file in models/upscale_models/; auto-resolved if omitted. */
  model?: string;
}

export interface UpscaleImageDeps {
  /** Resolve a local upscale model filename when none is given/defaulted. */
  resolveUpscaleModel: () => Promise<string | undefined>;
  enqueue: (workflow: WorkflowJSON) => Promise<{ prompt_id: string; queue_remaining?: number }>;
}

export interface UpscaleImageResult {
  prompt_id: string;
  queue_remaining?: number;
  model: string;
  scale: 2 | 4;
}

/**
 * Build + enqueue an ESRGAN upscale workflow (UpscaleModelLoader →
 * ImageUpscaleWithModel, with an optional downsample for scale=2). Resolves the
 * upscale model from the arg, then defaults, then the first local upscale model,
 * and throws an actionable error if none can be found.
 */
export async function upscaleImage(
  args: UpscaleImageArgs,
  deps: UpscaleImageDeps,
): Promise<UpscaleImageResult> {
  if (!args.image || !args.image.trim()) {
    throw new ValidationError(
      "image is required — the filename of an image already in ComfyUI's input dir " +
        "(upload it first with upload_image, or stage an output with stage_output_as_input).",
    );
  }
  assertSafeInputFilename(args.image, "image");

  const scale: 2 | 4 = args.scale ?? 4;
  if (scale !== 2 && scale !== 4) {
    throw new ValidationError("scale must be 2 or 4.");
  }

  const resolved = DefaultsManager.apply(
    args.model !== undefined ? { upscale_model: args.model } : {},
  );

  let model = (resolved.upscale_model as string | undefined) ?? args.model;
  if (!model) {
    model = await deps.resolveUpscaleModel();
  }
  if (!model) {
    throw new ValidationError(
      "No upscale model specified or found in models/upscale_models/. Pass `model`, " +
        "or download one, e.g. download_model url=" +
        "https://huggingface.co/Aitrepreneur/FLX/resolve/main/4x-ClearRealityV1.pth " +
        "target_subfolder=upscale_models. The anima/ernie packs also provide upscale " +
        "models via apply_manifest.",
    );
  }

  const workflow = createWorkflow("upscale", {
    image_path: args.image,
    upscale_model: model,
    scale,
  });

  const { prompt_id, queue_remaining } = await deps.enqueue(workflow);
  return { prompt_id, queue_remaining, model, scale };
}
