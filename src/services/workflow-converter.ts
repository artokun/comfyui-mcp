import type {
  WorkflowJSON,
  ObjectInfo,
  ComfyUINodeDef,
  UiWorkflow,
  UiNode,
  UiLink,
} from "../comfyui/types.js";
import { logger } from "../utils/logger.js";

export interface ConversionResult {
  workflow: WorkflowJSON;
  warnings: string[];
}

interface LinkInfo {
  sourceNodeId: number;
  sourceSlot: number;
  targetNodeId: number;
  targetSlot: number;
  typeName: string;
}

/**
 * Detect whether a parsed object is in ComfyUI UI format (nodes + links arrays)
 * vs API format (string keys with class_type + inputs).
 */
export function isUiFormat(obj: unknown): obj is UiWorkflow {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return false;
  const record = obj as Record<string, unknown>;
  return Array.isArray(record.nodes) && Array.isArray(record.links);
}

/**
 * Check if an input spec represents a widget (value input) vs a link (connection input).
 * Widget inputs have an array type spec like ["INT", {...}] or ["STRING", {...}].
 * Link inputs have a plain string type like "MODEL" or "CLIP".
 */
function isWidgetInput(
  inputName: string,
  def: ComfyUINodeDef,
): boolean {
  const spec =
    def.input.required?.[inputName] ?? def.input.optional?.[inputName];
  if (!spec) return false;

  const typeSpec = spec[0];
  // If the type is an array of choices like ["option1", "option2"], it's a widget
  if (Array.isArray(typeSpec)) return true;
  // Standard widget types
  const WIDGET_TYPES = new Set([
    "INT",
    "FLOAT",
    "STRING",
    "BOOLEAN",
    "COMBO",
  ]);
  return WIDGET_TYPES.has(typeSpec);
}

/**
 * Check if an input has control_after_generate in its spec config.
 * These inputs (like seed, noise_seed) have a phantom "fixed"/"randomize" widget
 * in the UI's widgets_values array that doesn't correspond to any named input.
 */
function hasControlAfterGenerate(
  inputName: string,
  def: ComfyUINodeDef,
): boolean {
  const spec =
    def.input.required?.[inputName] ?? def.input.optional?.[inputName];
  if (!spec || !spec[1]) return false;
  return (spec[1] as Record<string, unknown>).control_after_generate === true;
}

/**
 * Get the ordered list of input names from a node definition.
 * Uses input_order if available, otherwise falls back to object keys.
 */
function getOrderedInputNames(def: ComfyUINodeDef): string[] {
  const names: string[] = [];
  if (def.input_order) {
    if (def.input_order.required) names.push(...def.input_order.required);
    if (def.input_order.optional) names.push(...def.input_order.optional);
  } else {
    // Fallback: use object key order
    if (def.input.required) names.push(...Object.keys(def.input.required));
    if (def.input.optional) names.push(...Object.keys(def.input.optional));
  }
  return names;
}

/**
 * Convert a ComfyUI UI-format workflow to API format.
 * Requires objectInfo from /object_info to map widgets_values to named inputs.
 */
export function convertUiToApi(
  ui: UiWorkflow,
  objectInfo: ObjectInfo,
): ConversionResult {
  const workflow: WorkflowJSON = {};
  const warnings: string[] = [];

  // Build link lookup: linkId → LinkInfo
  const linkMap = new Map<number, LinkInfo>();
  for (const link of ui.links) {
    if (!Array.isArray(link) || link.length < 6) continue;
    const [linkId, sourceNodeId, sourceSlot, targetNodeId, targetSlot, typeName] =
      link as UiLink;
    linkMap.set(linkId, {
      sourceNodeId,
      sourceSlot,
      targetNodeId,
      targetSlot,
      typeName,
    });
  }

  // Build a set of node IDs for validating link targets
  const nodeIdSet = new Set(ui.nodes.map((n) => n.id));

  // Node types that are purely visual/internal and have no API equivalent
  const SKIP_TYPES = new Set(["Reroute", "Note", "PrimitiveNode", "MarkdownNote"]);

  // Get/Set node types that need special handling (not in object_info)
  const GET_SET_TYPES = new Set([
    "GetNode", "SetNode", "PRO_GetNode", "PRO_SetNode",
    "SetNode_GetNode", "SetNode_SetNode",
  ]);

  for (const node of ui.nodes) {
    const nodeId = String(node.id);
    const classType = node.type;

    // Skip internal litegraph node types
    if (SKIP_TYPES.has(classType)) continue;

    // Determine mode status
    const isMuted = node.mode === 2 || node.mode === 4;

    // Handle Get/Set nodes specially — they're not in object_info but are
    // important for understanding data flow. Use the node's title as the key.
    if (GET_SET_TYPES.has(classType)) {
      const title = node.title ?? node._meta?.title ?? "";
      const inputs: Record<string, unknown> = {};

      // For SetNode, wire the incoming connection
      if (node.inputs) {
        for (const input of node.inputs) {
          if (input.link != null) {
            const linkInfo = linkMap.get(input.link);
            if (linkInfo && nodeIdSet.has(linkInfo.sourceNodeId)) {
              inputs[input.name] = [String(linkInfo.sourceNodeId), linkInfo.sourceSlot];
            }
          }
        }
      }

      // Store the key used for Get/Set matching
      if (node.widgets_values && node.widgets_values.length > 0) {
        inputs.Constant = node.widgets_values[0];
      }

      workflow[nodeId] = {
        class_type: classType,
        inputs,
        _meta: { title: title || undefined },
      };
      if (isMuted) {
        workflow[nodeId]._meta = { ...workflow[nodeId]._meta, mode: "muted" } as never;
      }
      continue;
    }

    const def = objectInfo[classType];
    if (!def) {
      warnings.push(
        `Node ${nodeId} (${classType}): not found in object_info — custom node may not be installed. Skipping.`,
      );
      continue;
    }

    const inputs: Record<string, unknown> = {};

    // Get ordered input names and figure out which are widgets vs links
    const orderedNames = getOrderedInputNames(def);
    const widgetNames: string[] = [];
    for (const name of orderedNames) {
      if (isWidgetInput(name, def)) {
        widgetNames.push(name);
      }
    }

    // Map widgets_values to named widget inputs.
    // Some INT inputs with "control_after_generate": true (like seed, noise_seed) have
    // a phantom widget value in widgets_values ("fixed"/"randomize"/"increment"/"decrement")
    // that doesn't correspond to any named input — we must skip those.
    const widgetValues = node.widgets_values ?? [];
    let widgetIdx = 0;
    for (const name of widgetNames) {
      if (widgetIdx >= widgetValues.length) break;
      inputs[name] = widgetValues[widgetIdx];
      widgetIdx++;

      // If this input has control_after_generate, skip the next widgets_values entry
      if (hasControlAfterGenerate(name, def) && widgetIdx < widgetValues.length) {
        widgetIdx++;
      }
    }

    // Map linked inputs from node's inputs array
    if (node.inputs) {
      for (const input of node.inputs) {
        if (input.link != null) {
          const linkInfo = linkMap.get(input.link);
          if (linkInfo && nodeIdSet.has(linkInfo.sourceNodeId)) {
            inputs[input.name] = [String(linkInfo.sourceNodeId), linkInfo.sourceSlot];
          }
        }
      }
    }

    // Build the API node
    workflow[nodeId] = {
      class_type: classType,
      inputs,
    };

    // Preserve title and mode metadata
    const title = node.title ?? node._meta?.title;
    const meta: Record<string, unknown> = {};
    if (title && title !== classType) meta.title = title;
    if (isMuted) meta.mode = "muted";
    if (Object.keys(meta).length > 0) {
      workflow[nodeId]._meta = meta as { title?: string };
    }
  }

  const nodeCount = Object.keys(workflow).length;
  const skipped = ui.nodes.length - nodeCount;
  logger.info(
    `Converted UI workflow: ${nodeCount} nodes (${skipped} skipped)`,
  );

  return { workflow, warnings };
}
