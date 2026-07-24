import type { ComfyUINodeDef, ObjectInfo, WorkflowJSON } from "../comfyui/types.js";
import { getObjectInfo } from "../comfyui/client.js";
import { enqueueWorkflow } from "./workflow-executor.js";
import {
  isApiNode,
  generateWithApiNode,
  type ApiNodesDeps,
  type GenerateWithApiNodeResult,
} from "./api-nodes.js";
import { ValidationError } from "../utils/errors.js";

/**
 * generate_3d — produce a 3D model (glb/obj/fbx/ply) from a text prompt or an
 * input image.
 *
 * PATH CHOSEN (investigated 2026-07-24): current ComfyUI ships hosted partner
 * 3D nodes in core (`comfy_api_nodes`) — Tripo, Meshy, Rodin and Hunyuan3D
 * (Tencent), all under categories like "partner/3d/Tripo" with FILE_3D_*
 * outputs and OUTPUT_NODE=true. We therefore route through the SAME
 * generateWithApiNode machinery used by the generate_with_api_node tool: no
 * local 3D pack install is required, only a comfy.org API key/login on the
 * server (or COMFY_API_KEY here). Detection is dynamic against /object_info,
 * so the tool degrades honestly when the server has no 3D-capable API nodes
 * (old build, --disable-api-nodes) with an actionable error naming local-pack
 * alternatives.
 */

const defaultDeps: ApiNodesDeps = {
  getObjectInfo,
  enqueue: enqueueWorkflow,
};

/** Node id used for the LoadImage feeder in image mode ("1"/"2" are reserved). */
const LOAD_IMAGE_NODE_ID = "10";

/** Widget-ish input types that don't need an upstream link. */
const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);

function inputType(spec: unknown): string | string[] {
  if (Array.isArray(spec)) return spec[0] as string | string[];
  return String(spec);
}

function isWidgetType(type: string | string[]): boolean {
  if (Array.isArray(type)) return true; // inline combo options
  const t = type.toUpperCase();
  return WIDGET_TYPES.has(t) || t.includes("COMBO") || t.includes("AUTOGROW");
}

/** Does this node output a 3D model file? */
function has3dOutput(def: ComfyUINodeDef): boolean {
  return (Array.isArray(def.output) ? def.output : []).some((o) =>
    String(o).toUpperCase().startsWith("FILE_3D"),
  );
}

/** Is the node in a 3D category (e.g. "partner/3d/Tripo", "api node/3d/Rodin")? */
function has3dCategory(def: ComfyUINodeDef): boolean {
  return /(^|\/)3d(\/|$)/i.test(def.category ?? "");
}

/** A hosted partner/API node that produces a 3D model. */
export function is3dApiNode(def: ComfyUINodeDef): boolean {
  return isApiNode(def) && (has3dOutput(def) || has3dCategory(def));
}

/** Names of required link-type inputs (non-widget — need an upstream node). */
function requiredLinkInputs(def: ComfyUINodeDef): Array<{ name: string; type: string }> {
  const out: Array<{ name: string; type: string }> = [];
  for (const [name, spec] of Object.entries(def.input?.required ?? {})) {
    const type = inputType(spec);
    if (!isWidgetType(type)) out.push({ name, type: String(type).toUpperCase() });
  }
  return out;
}

function findStringPromptInput(def: ComfyUINodeDef): string | undefined {
  for (const section of [def.input?.required, def.input?.optional]) {
    for (const [name, spec] of Object.entries(section ?? {})) {
      const type = inputType(spec);
      if (typeof type === "string" && type.toUpperCase() === "STRING" && /prompt/i.test(name)) {
        return name;
      }
    }
  }
  return undefined;
}

/** Can this 3D node run from just a text prompt (no required link inputs)? */
export function isTextCapable(def: ComfyUINodeDef): boolean {
  if (requiredLinkInputs(def).length > 0) return false;
  // Must actually accept a prompt.
  const req = def.input?.required ?? {};
  return Object.entries(req).some(([name, spec]) => {
    const type = inputType(spec);
    return typeof type === "string" && type.toUpperCase() === "STRING" && /prompt/i.test(name);
  });
}

/** Can this 3D node run from a single input image (exactly one required IMAGE link)? */
export function isImageCapable(def: ComfyUINodeDef): { ok: boolean; imageInput?: string } {
  const links = requiredLinkInputs(def);
  const images = links.filter((l) => l.type === "IMAGE");
  if (images.length !== 1 || links.length !== images.length) return { ok: false };
  return { ok: true, imageInput: images[0].name };
}

/** Preferred class_types per mode, best-supported first. */
const PREFERRED: Record<Generate3dMode, string[]> = {
  text: [
    "TripoTextToModelNode",
    "MeshyTextToModelNode",
    "TencentTextToModelNode",
    "Rodin3D_Gen25_Text",
    "TripoP1TextToModelNode",
  ],
  image: [
    "TripoImageToModelNode",
    "MeshyImageToModelNode",
    "TencentImageToModelNode",
    "Rodin3D_Gen25_Image",
    "TripoP1ImageToModelNode",
  ],
};

export type Generate3dMode = "text" | "image";

export interface ThreeDNodeCandidate {
  class_type: string;
  display_name: string;
  category: string;
  /** 3D file formats the node outputs (e.g. ["GLB"], ["GLB","OBJ"]). */
  formats: string[];
  /** Name of the required IMAGE input (image-capable nodes only). */
  image_input?: string;
}

function formatsOf(def: ComfyUINodeDef): string[] {
  const out: string[] = [];
  for (const o of Array.isArray(def.output) ? def.output : []) {
    const s = String(o).toUpperCase();
    if (s === "FILE_3D") out.push("3D");
    else if (s.startsWith("FILE_3D_")) out.push(s.slice("FILE_3D_".length));
  }
  return [...new Set(out)];
}

/** Discover 3D-capable API nodes on the connected server, for a given mode. */
export function find3dApiNodes(
  objectInfo: ObjectInfo,
  mode: Generate3dMode,
): ThreeDNodeCandidate[] {
  const out: ThreeDNodeCandidate[] = [];
  for (const [classType, def] of Object.entries(objectInfo)) {
    if (!def || !is3dApiNode(def)) continue;
    if (mode === "text") {
      if (!isTextCapable(def)) continue;
      out.push({
        class_type: classType,
        display_name: def.display_name || classType,
        category: def.category ?? "",
        formats: formatsOf(def),
      });
    } else {
      const cap = isImageCapable(def);
      if (!cap.ok) continue;
      out.push({
        class_type: classType,
        display_name: def.display_name || classType,
        category: def.category ?? "",
        formats: formatsOf(def),
        image_input: cap.imageInput,
      });
    }
  }
  out.sort((a, b) => a.class_type.localeCompare(b.class_type));
  return out;
}

function pickCandidate(
  candidates: ThreeDNodeCandidate[],
  mode: Generate3dMode,
): ThreeDNodeCandidate {
  for (const preferred of PREFERRED[mode]) {
    const hit = candidates.find((c) => c.class_type === preferred);
    if (hit) return hit;
  }
  return candidates[0];
}

function noBackendError(mode: Generate3dMode): ValidationError {
  return new ValidationError(
    `No 3D-capable API/partner nodes for ${mode}-to-3D were found on the connected ComfyUI, ` +
      `so generate_3d has no backend to run on. Recent ComfyUI builds ship hosted 3D partner nodes ` +
      `in core (Tripo, Meshy, Rodin, Hunyuan3D — categories like "partner/3d/..."); they may be ` +
      `missing because the ComfyUI build is old or API nodes are disabled (--disable-api-nodes). ` +
      `Fixes: (1) update ComfyUI (update_comfyui) and remove --disable-api-nodes, then retry; or ` +
      `(2) install a LOCAL 3D pack and build a workflow with it — e.g. install_custom_node with ` +
      `"ComfyUI-Hunyuan3DWrapper" (image-to-3D) or "ComfyUI-Flowty-TripoSR" (image-to-3D). ` +
      `Nothing was installed automatically.`,
  );
}

export interface Generate3dArgs {
  mode: Generate3dMode;
  /** Text description of the model (required in text mode; optional extra guidance in image mode if the node accepts it). */
  prompt?: string;
  /** ComfyUI input-image filename (image mode). Upload first with upload_image. */
  image?: string;
  /** Explicit 3D API node class_type to use (overrides auto-selection). */
  node?: string;
  /** Provider-specific extra inputs passed through to the node (see get_api_node_schema). */
  inputs?: Record<string, unknown>;
  disable_random_seed?: boolean;
}

export interface Generate3dResult extends GenerateWithApiNodeResult {
  class_type: string;
  display_name: string;
  category: string;
  /** 3D output formats the chosen node produces. */
  formats: string[];
  /** Other 3D nodes that could have been used for this mode. */
  alternatives: string[];
}

/**
 * Generate a 3D model from text or an image by enqueueing a minimal workflow
 * around a hosted partner 3D node (Tripo/Meshy/Rodin/Hunyuan3D), reusing the
 * generate_with_api_node machinery. Returns immediately with the prompt_id.
 */
export async function generate3d(
  args: Generate3dArgs,
  deps: ApiNodesDeps = defaultDeps,
): Promise<Generate3dResult> {
  if (args.mode === "text" && !args.prompt?.trim()) {
    throw new ValidationError('mode "text" requires a non-empty prompt.');
  }
  if (args.mode === "image" && !args.image?.trim()) {
    throw new ValidationError(
      'mode "image" requires an input image filename (upload one first with upload_image).',
    );
  }

  const objectInfo = await deps.getObjectInfo();
  const candidates = find3dApiNodes(objectInfo, args.mode);
  if (candidates.length === 0) throw noBackendError(args.mode);

  let chosen: ThreeDNodeCandidate;
  if (args.node) {
    const hit = candidates.find((c) => c.class_type === args.node);
    if (!hit) {
      throw new ValidationError(
        `Node "${args.node}" is not a ${args.mode}-capable 3D API node on this server. ` +
          `Available: ${candidates.map((c) => c.class_type).join(", ")}.`,
      );
    }
    chosen = hit;
  } else {
    chosen = pickCandidate(candidates, args.mode);
  }

  const def = objectInfo[chosen.class_type];
  const inputs: Record<string, unknown> = { ...(args.inputs ?? {}) };
  let extra_nodes: WorkflowJSON | undefined;
  const preNotes: string[] = [];

  if (args.mode === "text") {
    const promptName = findStringPromptInput(def) ?? "prompt";
    if (!(promptName in inputs)) inputs[promptName] = args.prompt;
  } else {
    const imageInput = chosen.image_input ?? "image";
    inputs[imageInput] = [LOAD_IMAGE_NODE_ID, 0];
    extra_nodes = {
      [LOAD_IMAGE_NODE_ID]: {
        class_type: "LoadImage",
        inputs: { image: args.image },
        _meta: { title: "Load Input Image" },
      },
    };
    if (args.prompt?.trim()) {
      const promptName = findStringPromptInput(def);
      if (promptName) {
        if (!(promptName in inputs)) inputs[promptName] = args.prompt;
      } else {
        preNotes.push(
          `"${chosen.class_type}" takes no text prompt input — the prompt was ignored (image-only node).`,
        );
      }
    }
  }

  const result = await generateWithApiNode(
    {
      class_type: chosen.class_type,
      inputs,
      disable_random_seed: args.disable_random_seed,
      extra_nodes,
    },
    deps,
  );

  return {
    ...result,
    notes: [...preNotes, ...result.notes],
    class_type: chosen.class_type,
    display_name: chosen.display_name,
    category: chosen.category,
    formats: chosen.formats,
    alternatives: candidates
      .map((c) => c.class_type)
      .filter((c) => c !== chosen.class_type),
  };
}
