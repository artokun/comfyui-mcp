import type { WorkflowJSON } from "../comfyui/types.js";
import { createWorkflow } from "./workflow-composer.js";
import { DefaultsManager } from "./defaults-manager.js";
import { ValidationError } from "../utils/errors.js";
import {
  assertSafeInputFilename,
  assertSafeFilenamePrefix,
} from "../utils/input-paths.js";

export interface RemoveBackgroundArgs {
  /** Filename (in ComfyUI's input dir) of the image to cut out. Upload it first
   *  with upload_image, or stage an output with stage_output_as_input. */
  image: string;
  /** BiRefNet matting model; auto-downloaded by ComfyUI-RMBG on first run. */
  model?: string;
  filename_prefix?: string;
}

export interface RemoveBackgroundDeps {
  /** Returns true/false if the node's install state is known, or undefined when
   *  it can't be determined (no running server) — in which case we proceed and
   *  let execution surface any problem. */
  isNodeInstalled?: (classType: string) => Promise<boolean | undefined>;
  enqueue: (workflow: WorkflowJSON) => Promise<{ prompt_id: string; queue_remaining?: number }>;
}

export interface RemoveBackgroundResult {
  prompt_id: string;
  queue_remaining?: number;
  model: string;
}

/** The ComfyUI-RMBG node class that does the matting. */
export const REMBG_NODE = "BiRefNetRMBG";

const DEFAULTABLE_KEYS = ["model", "filename_prefix"] as const;

/**
 * Build + enqueue a background-removal workflow (LoadImage → BiRefNetRMBG →
 * SaveImage), returning a transparent cutout. Requires the ComfyUI-RMBG custom
 * node pack; if we can confirm it's absent we throw an actionable error instead
 * of enqueuing a graph that will fail at runtime.
 */
export async function removeBackground(
  args: RemoveBackgroundArgs,
  deps: RemoveBackgroundDeps,
): Promise<RemoveBackgroundResult> {
  if (!args.image || !args.image.trim()) {
    throw new ValidationError(
      "image is required — the filename of an image already in ComfyUI's input dir " +
        "(upload it first with upload_image, or stage an output with stage_output_as_input).",
    );
  }
  assertSafeInputFilename(args.image, "image");

  if (deps.isNodeInstalled) {
    const installed = await deps.isNodeInstalled(REMBG_NODE);
    if (installed === false) {
      throw new ValidationError(
        `The background-removal node "${REMBG_NODE}" (ComfyUI-RMBG) is not installed. ` +
          "Install it with apply_manifest --path packs/wan-transparent/manifest.yaml, " +
          "or install_custom_node id 'comfyui-rmbg'. The BiRefNet model auto-downloads " +
          "into models/RMBG/BiRefNet/ on first run.",
      );
    }
  }

  const argsRecord = args as unknown as Record<string, unknown>;
  const seed: Record<string, unknown> = {};
  for (const key of DEFAULTABLE_KEYS) {
    const v = argsRecord[key];
    if (v !== undefined) seed[key] = v;
  }
  const resolved = DefaultsManager.apply(seed);

  // Validate the RESOLVED prefix (post-defaults) — a malicious default
  // filename_prefix must not reach SaveImage unsanitized.
  if (resolved.filename_prefix !== undefined) {
    assertSafeFilenamePrefix(resolved.filename_prefix as string);
  }

  const workflow = createWorkflow("remove_background", {
    image_path: args.image,
    model: resolved.model as string | undefined,
    filename_prefix: resolved.filename_prefix as string | undefined,
  });

  const model =
    (workflow["2"]?.inputs.model as string | undefined) ?? "BiRefNet_toonout";

  const { prompt_id, queue_remaining } = await deps.enqueue(workflow);
  return { prompt_id, queue_remaining, model };
}
