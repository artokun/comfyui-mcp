import type {
  WorkflowJSON,
  ObjectInfo,
  ComfyUINodeDef,
  UiWorkflow,
  UiNode,
  UiLink,
  SubgraphDefinition,
  SubgraphLink,
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

// ── Component / subgraph expansion ──────────────────────────────────────────

interface ExpandResult {
  expanded: UiWorkflow;
  warnings: string[];
}

/**
 * Expand component/subgraph nodes by flattening their inner graphs into the
 * outer workflow.  Component nodes have a UUID `type` that matches a definition
 * in `workflow.definitions.subgraphs`.  Each inner node gets a unique ID to
 * avoid collisions with outer nodes or other component instances.
 *
 * Handles nested components (component inside component) iteratively up to a
 * maximum depth of 10.
 */
export function expandComponents(ui: UiWorkflow): ExpandResult {
  const subgraphs = ui.definitions?.subgraphs;
  if (!subgraphs || subgraphs.length === 0) {
    return { expanded: ui, warnings: [] };
  }

  // Build subgraph lookup: UUID → definition
  const sgMap = new Map<string, SubgraphDefinition>();
  for (const sg of subgraphs) {
    sgMap.set(sg.id, sg);
  }

  // Deep-clone so we don't mutate the caller's data
  let nodes: UiNode[] = JSON.parse(JSON.stringify(ui.nodes));
  let links: UiLink[] = JSON.parse(JSON.stringify(ui.links));
  const warnings: string[] = [];

  // Find max IDs for safe remapping
  let nextNodeId = 1;
  let nextLinkId = 1;
  for (const n of nodes) nextNodeId = Math.max(nextNodeId, n.id + 1);
  for (const l of links) nextLinkId = Math.max(nextLinkId, l[0] + 1);
  for (const sg of subgraphs) {
    for (const n of sg.nodes) nextNodeId = Math.max(nextNodeId, n.id + 1);
    for (const l of sg.links) nextLinkId = Math.max(nextLinkId, l.id + 1);
  }

  const MAX_DEPTH = 10;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const componentNodes = nodes.filter((n) => sgMap.has(n.type));
    if (componentNodes.length === 0) break;

    for (const compNode of componentNodes) {
      const sg = sgMap.get(compNode.type)!;

      // Skip muted / bypassed component nodes
      if (compNode.mode === 2 || compNode.mode === 4) {
        warnings.push(
          `Component node ${compNode.id} ("${sg.name}") is muted/bypassed — skipping expansion.`,
        );
        // Remove it so the main converter doesn't warn about unknown type
        nodes = nodes.filter((n) => n.id !== compNode.id);
        continue;
      }

      const result = expandSingleComponent(
        compNode,
        sg,
        nodes,
        links,
        nextNodeId,
        nextLinkId,
      );
      nodes = result.nodes;
      links = result.links;
      nextNodeId = result.nextNodeId;
      nextLinkId = result.nextLinkId;
      warnings.push(...result.warnings);
    }
  }

  const expanded: UiWorkflow = {
    ...ui,
    nodes,
    links,
  };
  return { expanded, warnings };
}

/**
 * Expand a single component node, returning the modified nodes & links arrays.
 */
function expandSingleComponent(
  compNode: UiNode,
  sg: SubgraphDefinition,
  outerNodes: UiNode[],
  outerLinks: UiLink[],
  nextNodeId: number,
  nextLinkId: number,
): {
  nodes: UiNode[];
  links: UiLink[];
  nextNodeId: number;
  nextLinkId: number;
  warnings: string[];
} {
  const warnings: string[] = [];
  const inputNodeId = sg.inputNode.id; // typically -10
  const outputNodeId = sg.outputNode.id; // typically -20

  // ── 1. Remap inner node IDs ──────────────────────────────────────────────
  const nodeRemap = new Map<number, number>(); // oldInner → newOuter
  for (const inner of sg.nodes) {
    nodeRemap.set(inner.id, nextNodeId++);
  }

  // ── 2. Remap inner link IDs ──────────────────────────────────────────────
  const linkRemap = new Map<number, number>();
  for (const inner of sg.links) {
    linkRemap.set(inner.id, nextLinkId++);
  }

  // ── 3. Build inner link lookup ───────────────────────────────────────────
  const innerLinkById = new Map<number, SubgraphLink>();
  for (const l of sg.links) innerLinkById.set(l.id, l);

  // ── 4. Clone inner nodes with remapped IDs ──────────────────────────────
  const newNodes: UiNode[] = [];
  for (const inner of sg.nodes) {
    const cloned: UiNode = JSON.parse(JSON.stringify(inner));
    cloned.id = nodeRemap.get(inner.id)!;

    // Remap link references in inputs
    if (cloned.inputs) {
      for (const inp of cloned.inputs) {
        if (inp.link != null) {
          inp.link = linkRemap.get(inp.link) ?? inp.link;
        }
      }
    }
    // Remap link references in outputs
    if (cloned.outputs) {
      for (const out of cloned.outputs) {
        if (out.links) {
          out.links = out.links.map((lid) => linkRemap.get(lid) ?? lid);
        }
      }
    }

    newNodes.push(cloned);
  }

  // ── 5. Convert inner links to outer array format ────────────────────────
  // Skip links involving virtual input/output nodes — those get rewired.
  const newLinks: UiLink[] = [];
  for (const il of sg.links) {
    if (il.origin_id === inputNodeId || il.target_id === outputNodeId) continue;
    const newId = linkRemap.get(il.id)!;
    const newSrc = nodeRemap.get(il.origin_id);
    const newTgt = nodeRemap.get(il.target_id);
    if (newSrc == null || newTgt == null) {
      warnings.push(
        `Component "${sg.name}": inner link ${il.id} references unknown node — skipping.`,
      );
      continue;
    }
    newLinks.push([newId, newSrc, il.origin_slot, newTgt, il.target_slot, il.type]);
  }

  // ── 6. Rewire external inputs (outer → component → inner) ──────────────
  // Build outer link map for quick lookup
  const outerLinkMap = new Map<number, UiLink>();
  for (const ol of outerLinks) outerLinkMap.set(ol[0], ol);

  const linksToRemove = new Set<number>(); // outer link IDs to remove
  const linksToAdd: UiLink[] = [];

  if (compNode.inputs) {
    for (let slotIdx = 0; slotIdx < compNode.inputs.length; slotIdx++) {
      const compInput = compNode.inputs[slotIdx];
      if (compInput.link == null) continue;

      const outerLink = outerLinkMap.get(compInput.link);
      if (!outerLink) continue;

      const srcNodeId = outerLink[1];
      const srcSlot = outerLink[2];

      // Find the matching subgraph input by name
      const sgInput = sg.inputs.find((inp) => inp.name === compInput.name);
      if (!sgInput) {
        warnings.push(
          `Component "${sg.name}": could not match input "${compInput.name}" — skipping rewire.`,
        );
        continue;
      }

      // For each inner link from the virtual input node, create a new outer link
      for (const innerLinkId of sgInput.linkIds) {
        const il = innerLinkById.get(innerLinkId);
        if (!il || il.origin_id !== inputNodeId) continue;
        const remappedTarget = nodeRemap.get(il.target_id);
        if (remappedTarget == null) continue;

        const newId = nextLinkId++;
        linksToAdd.push([newId, srcNodeId, srcSlot, remappedTarget, il.target_slot, il.type]);

        // Update the cloned inner node's input to point to the new link
        const targetNode = newNodes.find((n) => n.id === remappedTarget);
        if (targetNode?.inputs) {
          for (const inp of targetNode.inputs) {
            if (inp.link === linkRemap.get(innerLinkId)) {
              inp.link = newId;
            }
          }
        }
      }

      linksToRemove.add(compInput.link);
    }
  }

  // ── 7. Rewire external outputs (inner → component → outer) ─────────────
  if (compNode.outputs) {
    for (let slotIdx = 0; slotIdx < compNode.outputs.length; slotIdx++) {
      const compOutput = compNode.outputs[slotIdx];
      if (!compOutput.links || compOutput.links.length === 0) continue;

      // Find the matching subgraph output by name
      const sgOutput = sg.outputs.find((out) => out.name === compOutput.name);
      if (!sgOutput) {
        warnings.push(
          `Component "${sg.name}": could not match output "${compOutput.name}" — skipping rewire.`,
        );
        continue;
      }

      // Find the inner node that produces this output
      let innerSrcId: number | null = null;
      let innerSrcSlot = 0;
      for (const innerLinkId of sgOutput.linkIds) {
        const il = innerLinkById.get(innerLinkId);
        if (il && il.target_id === outputNodeId) {
          innerSrcId = il.origin_id;
          innerSrcSlot = il.origin_slot;
          break;
        }
      }
      if (innerSrcId == null) continue;
      const remappedSrc = nodeRemap.get(innerSrcId);
      if (remappedSrc == null) continue;

      // Rewire each outer link that consumes this component output
      for (const outerLinkId of compOutput.links) {
        const outerLink = outerLinkMap.get(outerLinkId);
        if (!outerLink) continue;

        const tgtNodeId = outerLink[3];
        const tgtSlot = outerLink[4];
        const linkType = outerLink[5];

        const newId = nextLinkId++;
        linksToAdd.push([newId, remappedSrc, innerSrcSlot, tgtNodeId, tgtSlot, linkType]);

        // Update the outer target node's input to reference the new link
        const tgtNode = outerNodes.find((n) => n.id === tgtNodeId);
        if (tgtNode?.inputs) {
          for (const inp of tgtNode.inputs) {
            if (inp.link === outerLinkId) {
              inp.link = newId;
            }
          }
        }

        linksToRemove.add(outerLinkId);
      }
    }
  }

  // ── 8. Apply proxy widget values ────────────────────────────────────────
  const proxyWidgets: [string, string][] =
    (compNode.properties?.proxyWidgets as [string, string][]) ?? [];
  const widgetValues = compNode.widgets_values ?? [];

  for (let i = 0; i < proxyWidgets.length; i++) {
    const [innerNodeIdStr, widgetName] = proxyWidgets[i];
    const value = i < widgetValues.length ? widgetValues[i] : undefined;
    if (value === undefined || value === null) continue;

    const innerNodeIdNum = Number(innerNodeIdStr);
    const remapped = nodeRemap.get(innerNodeIdNum);
    if (remapped == null) continue;

    const targetNode = newNodes.find((n) => n.id === remapped);
    if (!targetNode) continue;

    // Find the widget position in widgets_values by counting widget-type inputs
    const widgetIdx = findWidgetIndex(targetNode, widgetName);
    if (widgetIdx != null) {
      if (!targetNode.widgets_values) targetNode.widgets_values = [];
      targetNode.widgets_values[widgetIdx] = value;
    }
  }

  // ── 9. Resolve PrimitiveNode-type nodes inside the subgraph ─────────────
  // PrimitiveNode/PrimitiveInt/PrimitiveFloat/PrimitiveBoolean/PrimitiveStringMultiline
  // produce widget values but get skipped by the main converter. Resolve them
  // by pushing their value onto the target node's widgets_values.
  const PRIMITIVE_TYPES = new Set([
    "PrimitiveNode", "PrimitiveInt", "PrimitiveFloat",
    "PrimitiveBoolean", "PrimitiveStringMultiline", "CustomCombo",
  ]);
  const primitiveNodeIds = new Set(
    newNodes.filter((n) => PRIMITIVE_TYPES.has(n.type)).map((n) => n.id),
  );
  if (primitiveNodeIds.size > 0) {
    // For each new link FROM a primitive node, set the value on the target
    for (const link of newLinks) {
      const [, srcId, , tgtId, tgtSlot] = link;
      if (!primitiveNodeIds.has(srcId)) continue;

      const primNode = newNodes.find((n) => n.id === srcId);
      const tgtNode = newNodes.find((n) => n.id === tgtId);
      if (!primNode || !tgtNode) continue;

      const primValue =
        primNode.widgets_values && primNode.widgets_values.length > 0
          ? primNode.widgets_values[0]
          : undefined;
      if (primValue === undefined) continue;

      // Find the target input at tgtSlot that has a widget
      if (tgtNode.inputs) {
        const tgtInput = tgtNode.inputs.find(
          (inp) => inp.link === link[0] && inp.widget,
        );
        if (tgtInput) {
          const idx = findWidgetIndex(tgtNode, tgtInput.widget!.name);
          if (idx != null) {
            if (!tgtNode.widgets_values) tgtNode.widgets_values = [];
            tgtNode.widgets_values[idx] = primValue;
          }
          // Clear the link so the main converter treats this as a widget value
          tgtInput.link = null;
        }
      }
    }
  }

  // ── 10. Assemble result ─────────────────────────────────────────────────
  const resultNodes = [
    ...outerNodes.filter((n) => n.id !== compNode.id),
    ...newNodes,
  ];
  const resultLinks = [
    ...outerLinks.filter((l) => !linksToRemove.has(l[0])),
    ...newLinks,
    ...linksToAdd,
  ];

  return {
    nodes: resultNodes,
    links: resultLinks,
    nextNodeId,
    nextLinkId,
    warnings,
  };
}

/**
 * Find the widgets_values index for a named widget on a UI node.
 * Counts widget-type inputs (those with a `widget` property) in order.
 */
function findWidgetIndex(node: UiNode, widgetName: string): number | null {
  if (!node.inputs) return null;

  // Widget inputs on a UiNode are entries in `inputs[]` that have a `widget` property.
  // However, not all widgets appear in `inputs[]` — some are only in `widgets_values`.
  // We count only the widget-inputs that appear in the node's inputs array,
  // matching by the `widget.name` field.
  let idx = 0;
  for (const inp of node.inputs) {
    if (inp.widget) {
      if (inp.widget.name === widgetName) return idx;
      idx++;
    }
  }

  // Fallback: if widget is not in inputs[] (pure widget, no link slot),
  // it may be at a fixed position. Search widgets_values if we can match by name.
  // For now, return null — the widget is likely at its default value.
  return null;
}

/**
 * Convert a ComfyUI UI-format workflow to API format.
 * Requires objectInfo from /object_info to map widgets_values to named inputs.
 */
export function convertUiToApi(
  ui: UiWorkflow,
  objectInfo: ObjectInfo,
): ConversionResult {
  // Expand component/subgraph nodes before conversion
  const { expanded, warnings: expandWarnings } = expandComponents(ui);

  const workflow: WorkflowJSON = {};
  const warnings: string[] = [...expandWarnings];

  // Build link lookup: linkId → LinkInfo
  const linkMap = new Map<number, LinkInfo>();
  for (const link of expanded.links) {
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

  // Node types that are purely visual/internal and have no API equivalent
  const SKIP_TYPES = new Set(["Reroute", "Note", "PrimitiveNode", "MarkdownNote"]);

  // Build node-by-id lookup
  const nodeById = new Map(expanded.nodes.map((n) => [n.id, n]));

  // Build set of node IDs that will be included in the output.
  // Excludes: SKIP_TYPES and muted/bypassed nodes (mode 2 or 4).
  // The web UI also excludes muted nodes from the API prompt entirely.
  const outputNodeIds = new Set<number>();
  for (const n of expanded.nodes) {
    const isMuted = n.mode === 2 || n.mode === 4;
    if (SKIP_TYPES.has(n.type) || isMuted) continue;
    outputNodeIds.add(n.id);
  }

  // Resolve Reroute chains: follow Reroute → Reroute → ... → actual source.
  // Returns the final non-Reroute source, or null if the chain is broken.
  const rerouteCache = new Map<number, { sourceNodeId: number; sourceSlot: number } | null>();
  function resolveReroute(nodeId: number): { sourceNodeId: number; sourceSlot: number } | null {
    if (rerouteCache.has(nodeId)) return rerouteCache.get(nodeId)!;
    const node = nodeById.get(nodeId);
    if (!node || node.type !== "Reroute") return null;
    const input = node.inputs?.[0];
    if (!input || input.link == null) {
      rerouteCache.set(nodeId, null);
      return null;
    }
    const linkInfo = linkMap.get(input.link);
    if (!linkInfo) {
      rerouteCache.set(nodeId, null);
      return null;
    }
    const sourceNode = nodeById.get(linkInfo.sourceNodeId);
    if (sourceNode?.type === "Reroute") {
      const resolved = resolveReroute(linkInfo.sourceNodeId);
      rerouteCache.set(nodeId, resolved);
      return resolved;
    }
    const result = { sourceNodeId: linkInfo.sourceNodeId, sourceSlot: linkInfo.sourceSlot };
    rerouteCache.set(nodeId, result);
    return result;
  }

  /**
   * Resolve a link's source, following through Reroute chains and skipping
   * links to nodes that won't be in the output (PrimitiveNode, muted, etc.).
   * Returns the resolved source or null if the link should be dropped.
   */
  function resolveLink(linkInfo: LinkInfo): { sourceNodeId: number; sourceSlot: number } | null {
    const sourceNode = nodeById.get(linkInfo.sourceNodeId);
    if (!sourceNode) return null;

    // Follow Reroute chains to the actual source
    if (sourceNode.type === "Reroute") {
      const resolved = resolveReroute(linkInfo.sourceNodeId);
      if (!resolved) return null;
      // Make sure the resolved source is in the output
      return outputNodeIds.has(resolved.sourceNodeId) ? resolved : null;
    }

    // Skip links to nodes not in the output (PrimitiveNode, muted, etc.)
    if (!outputNodeIds.has(linkInfo.sourceNodeId)) return null;

    return { sourceNodeId: linkInfo.sourceNodeId, sourceSlot: linkInfo.sourceSlot };
  }

  // Get/Set node types that need special handling (not in object_info)
  const GET_SET_TYPES = new Set([
    "GetNode", "SetNode", "PRO_GetNode", "PRO_SetNode",
    "SetNode_GetNode", "SetNode_SetNode",
  ]);

  for (const node of expanded.nodes) {
    const nodeId = String(node.id);
    const classType = node.type;

    // Skip internal litegraph node types and muted/bypassed nodes
    if (!outputNodeIds.has(node.id)) continue;

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
            if (linkInfo) {
              const resolved = resolveLink(linkInfo);
              if (resolved) {
                inputs[input.name] = [String(resolved.sourceNodeId), resolved.sourceSlot];
              }
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

    // Detect widgets that were user-converted to input slots in the UI.
    // When a widget is "Convert to Input", its value is removed from
    // widgets_values. But some nodes use forceInput which also creates
    // input slots with widget properties while keeping values in
    // widgets_values. We distinguish by checking whether widgets_values
    // is shorter than the full expected widget count.
    const convertedWidgets = new Set<string>();
    const widgetValues = node.widgets_values ?? [];
    if (node.inputs) {
      const potentialConverted = new Set<string>();
      for (const input of node.inputs) {
        if (input.widget) potentialConverted.add(input.widget.name);
      }

      if (potentialConverted.size > 0) {
        // Count expected widgets_values entries for the full widget set
        let expectedCount = 0;
        for (const name of widgetNames) {
          expectedCount++;
          if (hasControlAfterGenerate(name, def)) expectedCount++;
        }

        // Only treat as converted if widgets_values is actually shorter
        if (widgetValues.length < expectedCount) {
          for (const name of potentialConverted) convertedWidgets.add(name);
        }
      }
    }

    // Map widgets_values to named widget inputs.
    // Skip converted widgets — their values are NOT in widgets_values.
    // Some INT inputs with "control_after_generate": true (like seed, noise_seed) have
    // a phantom widget value in widgets_values ("fixed"/"randomize"/"increment"/"decrement")
    // that doesn't correspond to any named input — we must skip those.
    let widgetIdx = 0;
    for (const name of widgetNames) {
      if (convertedWidgets.has(name)) {
        // Widget was promoted to an input slot — value is not in widgets_values.
        // Will be set from input.widget.value or overwritten by link below.
        continue;
      }
      if (widgetIdx >= widgetValues.length) break;
      inputs[name] = widgetValues[widgetIdx];
      widgetIdx++;

      // If this input has control_after_generate, skip the next widgets_values entry
      if (hasControlAfterGenerate(name, def) && widgetIdx < widgetValues.length) {
        widgetIdx++;
      }
    }

    // Set fallback values for converted widgets that have no link connected
    if (node.inputs) {
      for (const input of node.inputs) {
        if (input.widget && input.link == null && input.widget.value !== undefined) {
          inputs[input.widget.name] = input.widget.value;
        }
      }
    }

    // Map linked inputs from node's inputs array
    if (node.inputs) {
      for (const input of node.inputs) {
        if (input.link != null) {
          const linkInfo = linkMap.get(input.link);
          if (linkInfo) {
            const resolved = resolveLink(linkInfo);
            if (resolved) {
              inputs[input.name] = [String(resolved.sourceNodeId), resolved.sourceSlot];
            }
          }
        }
      }
    }

    // Build the API node
    workflow[nodeId] = {
      class_type: classType,
      inputs,
    };

    // Preserve title metadata
    const title = node.title ?? node._meta?.title;
    if (title && title !== classType) {
      workflow[nodeId]._meta = { title };
    }
  }

  const nodeCount = Object.keys(workflow).length;
  const skipped = expanded.nodes.length - nodeCount;
  logger.info(
    `Converted UI workflow: ${nodeCount} nodes (${skipped} skipped)`,
  );

  return { workflow, warnings };
}
