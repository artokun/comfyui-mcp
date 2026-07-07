import type {
  WorkflowJSON,
  ObjectInfo,
  ComfyUINodeDef,
  NodeInputSpec,
  UiWorkflow,
  UiNode,
  UiNodeInput,
  UiNodeOutput,
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
  // V3 dynamic combo: a string type carrying an `options` list (e.g.
  // COMFY_DYNAMICCOMBO_V3) — the selected option's key is a widget value.
  const cfg = spec[1] as { options?: unknown } | undefined;
  if (Array.isArray(cfg?.options)) return true;
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
 * Whether an input spec is a POSITIONAL widget — one that occupies a slot in the
 * UI's `widgets_values` array. Inline combos (`["a","b"]`), v3 dynamic combos
 * (a string type carrying an `options` list), and the standard scalar widget
 * types all qualify; link/list types (IMAGE, COMFY_AUTOGROW_V3, …) do not.
 */
function isPositionalWidgetSpec(spec: unknown): boolean {
  if (!Array.isArray(spec)) return false;
  const type = spec[0];
  if (Array.isArray(type)) return true; // inline combo options
  const cfg = spec[1] as { options?: unknown } | undefined;
  if (Array.isArray(cfg?.options)) return true; // dynamic combo (options-carrying)
  return ["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"].includes(String(type));
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
  if (!spec) return false;
  if ((spec[1] as Record<string, unknown> | undefined)?.control_after_generate === true)
    return true;
  // ComfyUI's frontend auto-adds a control_after_generate widget to seed-type INT
  // widgets even when object_info doesn't flag it (e.g. UltimateSDUpscale.seed,
  // KSamplerAdvanced.noise_seed). The saved widgets_values then carry the extra
  // "fixed"/"randomize"/… value that must be skipped during mapping.
  if (
    spec[0] === "INT" &&
    (inputName === "seed" || inputName === "noise_seed" || inputName === "rand_seed")
  )
    return true;
  return false;
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

// ── De-virtualization (Get/Set/Reroute) pre-pass ────────────────────────────

const WIRING_VIRTUAL_TYPES = new Set([
  "GetNode", "SetNode", "PRO_GetNode", "PRO_SetNode",
  "SetNode_GetNode", "SetNode_SetNode",
]);
const isGetVirtual = (t: string) => WIRING_VIRTUAL_TYPES.has(t) && /get/i.test(t);
const isSetVirtual = (t: string) =>
  WIRING_VIRTUAL_TYPES.has(t) && /set/i.test(t) && !/get/i.test(t);
const isWiringVirtual = (t: string | undefined) =>
  t != null && (t === "Reroute" || isGetVirtual(t) || isSetVirtual(t));

/**
 * Pre-pass: strip the pure "wiring" virtual nodes — KJNodes **Get/Set** bus nodes
 * and **Reroute** — by rewriting each consumer's link straight to the real
 * upstream source (following chains, and Get→bus→Set→source). Runs on the
 * top-level graph AND every subgraph definition, BEFORE expansion, so the
 * expander and the main converter only ever see real nodes and real links. This
 * removes the recurring class of dangling-ref bugs where a skipped virtual node
 * left its consumers (sometimes across a subgraph boundary) pointing at a node
 * that isn't in the prompt. PrimitiveNode is a value-provider, not a wire, so it
 * is left for the link loop (which has object_info to map the widget by name).
 */
function deVirtualizeGraph(
  nodes: UiNode[] | undefined,
  links: unknown[] | undefined,
): void {
  if (!nodes?.length || !links?.length) return;
  const dict = !Array.isArray(links[0]);
  const lid = (l: any) => (dict ? l.id : l[0]);
  const lsrc = (l: any) => (dict ? l.origin_id : l[1]);
  const lsrcSlot = (l: any) => (dict ? l.origin_slot : l[2]);
  const ltgt = (l: any) => (dict ? l.target_id : l[3]);
  const setLsrc = (l: any, n: unknown, s: unknown) => {
    if (dict) { l.origin_id = n; l.origin_slot = s; }
    else { l[1] = n; l[2] = s; }
  };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const linkById = new Map((links as any[]).map((l) => [lid(l), l]));
  const busSet = new Map<string, UiNode>();
  for (const n of nodes) {
    if (isSetVirtual(n.type)) {
      const b = n.widgets_values?.[0];
      if (b != null) busSet.set(String(b), n);
    }
  }
  const incoming = (node: UiNode) => {
    const inp = (node.inputs ?? []).find((i) => i.link != null);
    const l = inp?.link != null ? linkById.get(inp.link) : undefined;
    return l ? { node: lsrc(l), slot: lsrcSlot(l) } : null;
  };
  const resolveReal = (
    nodeId: unknown,
    slot: unknown,
    depth = 0,
  ): { node: unknown; slot: unknown } | null => {
    if (depth > 100) return null;
    const node = byId.get(nodeId as number);
    if (!node) return { node: nodeId, slot };
    if (node.type === "Reroute") {
      const s = incoming(node);
      return s ? resolveReal(s.node, s.slot, depth + 1) : null;
    }
    if (isGetVirtual(node.type)) {
      const b = node.widgets_values?.[0];
      const setN = b != null ? busSet.get(String(b)) : undefined;
      if (!setN) return null;
      const s = incoming(setN);
      return s ? resolveReal(s.node, s.slot, depth + 1) : null;
    }
    return { node: nodeId, slot };
  };

  const drop = new Set<unknown>();
  for (const l of links as any[]) {
    const srcType = byId.get(lsrc(l))?.type;
    if (srcType === "Reroute" || (srcType && isGetVirtual(srcType))) {
      const real = resolveReal(lsrc(l), lsrcSlot(l));
      if (real && !isWiringVirtual(byId.get(real.node as number)?.type)) {
        setLsrc(l, real.node, real.slot);
      } else {
        drop.add(lid(l)); // unresolved bus/reroute — drop like a dead link
      }
    }
  }
  const keptLinks = (links as any[]).filter((l) => {
    if (drop.has(lid(l))) return false;
    if (isWiringVirtual(byId.get(ltgt(l))?.type)) return false; // link into a virtual
    if (isWiringVirtual(byId.get(lsrc(l))?.type)) return false; // still-virtual source
    return true;
  });
  const keptNodes = nodes.filter((n) => !isWiringVirtual(n.type));
  nodes.length = 0;
  nodes.push(...keptNodes);
  links.length = 0;
  (links as any[]).push(...keptLinks);
}

/** Strip wiring virtuals from the top-level graph and every subgraph definition. */
function deVirtualize(ui: UiWorkflow): void {
  deVirtualizeGraph(ui.nodes, ui.links as unknown[]);
  for (const sg of ui.definitions?.subgraphs ?? []) {
    deVirtualizeGraph(sg.nodes, sg.links as unknown[]);
  }
}

// ── Component / subgraph expansion ──────────────────────────────────────────

/**
 * Collect every node `type` referenced by a UI workflow — top-level nodes plus
 * the internal nodes of every subgraph definition. Used to backfill object_info
 * for node types missing from the bulk /object_info response.
 */
export function collectNodeTypes(ui: UiWorkflow): string[] {
  const types = new Set<string>();
  for (const n of ui.nodes ?? []) if (n.type) types.add(n.type);
  for (const sg of ui.definitions?.subgraphs ?? []) {
    for (const n of sg.nodes ?? []) if (n.type) types.add(n.type);
  }
  return [...types];
}

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

        // If the external source is ITSELF a component instance (expanded in a
        // later iteration), register this new link on its output slot so its own
        // step-7 output rewiring re-targets it. Without this, an A→B subgraph
        // edge dangles when B expands before A (A's original output link to B was
        // removed here, but the replacement isn't on A's output list).
        const srcNode = outerNodes.find((n) => n.id === srcNodeId);
        const srcOut = srcNode?.outputs?.[srcSlot];
        if (srcOut) (srcOut.links ??= []).push(newId);

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
      if (process.env.DEBUG_EXPAND) logger.info(`EXPAND ${sg.name} out '${compOutput.name}' links=${JSON.stringify(compOutput.links)} sgLinkIds=${JSON.stringify(sgOutput.linkIds)} innerSrc=${innerSrcId}`);
      if (innerSrcId == null) continue;
      const remappedSrc = nodeRemap.get(innerSrcId);
      if (remappedSrc == null) continue;

      // Rewire each outer link that consumes this component output
      for (const outerLinkId of compOutput.links) {
        const outerLink = outerLinkMap.get(outerLinkId);
        if (process.env.DEBUG_EXPAND) logger.info(`  rewire link ${outerLinkId}: ${outerLink ? "found -> tgt "+outerLink[3] : "NOT in outerLinkMap"}`);
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

  // ── 9. Resolve virtual PrimitiveNode nodes inside the subgraph ──────────
  // The legacy virtual "PrimitiveNode" produces a widget value but isn't a real
  // executable node, so bake its value onto the target's widgets_values. The
  // typed primitives (PrimitiveInt/Float/Boolean/String) ARE real nodes that
  // output a value — leave them as link sources so the main converter maps them
  // by name (baking them by widget index mis-positions V3 nested inputs like
  // "resize_type.width", which aren't 1:1 with the inputs[] widget order).
  const PRIMITIVE_TYPES = new Set(["PrimitiveNode", "CustomCombo"]);
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

// ── API → UI conversion ─────────────────────────────────────────────────────

/**
 * Detect an API-format workflow: a non-empty record whose every value is a
 * node object with a string `class_type`. (`inputs` may be absent on
 * degenerate nodes; class_type is the discriminator.)
 */
export function isApiFormat(obj: unknown): obj is WorkflowJSON {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return false;
  const values = Object.values(obj as Record<string, unknown>);
  if (values.length === 0) return false;
  return values.every(
    (v) =>
      typeof v === "object" &&
      v !== null &&
      !Array.isArray(v) &&
      typeof (v as { class_type?: unknown }).class_type === "string",
  );
}

/** An API-format connection reference: ["<nodeId>", <outputSlot>]. */
function isLinkRef(v: unknown, nodeKeys: Set<string>): v is [string | number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    (typeof v[0] === "string" || typeof v[0] === "number") &&
    typeof v[1] === "number" &&
    nodeKeys.has(String(v[0]))
  );
}

/** The UI slot `type` string for a widget input spec. */
function widgetSlotType(spec: NodeInputSpec): string {
  const t = spec[0];
  return Array.isArray(t) ? "COMBO" : t;
}

/**
 * A sensible widgets_values entry for a widget the API graph didn't provide:
 * the spec default, else the first combo option, else a type-appropriate zero.
 * Used both for omitted widgets (ComfyUI would apply the same default) and as
 * the positional placeholder under a link-fed widget input.
 */
function widgetDefaultValue(spec: NodeInputSpec): unknown {
  const [type, cfg] = spec;
  const c = cfg as
    | { default?: unknown; options?: Array<{ key?: unknown } | string> }
    | undefined;
  if (c?.default !== undefined) return c.default;
  if (Array.isArray(type)) return type[0];
  if (Array.isArray(c?.options)) {
    const first = c.options[0];
    return typeof first === "object" && first !== null ? first.key : first;
  }
  switch (type) {
    case "INT":
    case "FLOAT":
      return 0;
    case "STRING":
      return "";
    case "BOOLEAN":
      return false;
    default:
      return undefined;
  }
}

interface PendingLink {
  srcKey: string;
  srcSlot: number;
  tgtKey: string;
  tgtSlotIdx: number;
  expectedType: string;
}

/**
 * Convert an API-format workflow to UI (canvas) format with a generated
 * layout. The inverse of convertUiToApi for well-formed graphs:
 * `convertUiToApi(convertApiToUi(x).workflow)` reproduces `x` (modulo layout,
 * string-normalized link refs, and filled-in defaults for omitted widgets —
 * both deliberate: the canvas itself materializes every widget when queueing).
 * One knowing asymmetry: `_meta.mode` muted/bypassed becomes UI mode 2/4 and
 * the node is PRESERVED on canvas, but convertUiToApi excludes mode-2/4 nodes
 * from the executable prompt (correct queue semantics), so those nodes don't
 * survive a UI→API round-trip.
 *
 * objectInfo is definitional: widget ORDER in widgets_values comes from
 * input_order (the same order convertUiToApi consumes), including the phantom
 * control_after_generate slot after seed-type widgets and V3 dynamic-combo
 * nested values ("combo.nested" dotted keys) after their combo.
 */
export function convertApiToUi(
  api: WorkflowJSON,
  objectInfo: ObjectInfo,
): { workflow: UiWorkflow; warnings: string[] } {
  const warnings: string[] = [];
  const keys = Object.keys(api);
  const keySet = new Set(keys);

  // Numeric node ids; non-numeric API keys (rare, hand-written) get remapped,
  // as does a key whose numeric value another key already claimed ("1" vs
  // "01" both Number() to 1 — duplicate node ids would corrupt the canvas).
  let maxId = 0;
  for (const k of keys) {
    const n = Number(k);
    if (Number.isInteger(n) && n > 0) maxId = Math.max(maxId, n);
  }
  const idFor = new Map<string, number>();
  const usedIds = new Set<number>();
  for (const k of keys) {
    const n = Number(k);
    if (Number.isInteger(n) && n > 0 && !usedIds.has(n)) {
      idFor.set(k, n);
      usedIds.add(n);
    } else {
      idFor.set(k, ++maxId);
      usedIds.add(maxId);
      warnings.push(
        `Node key "${k}" is not a usable unique positive integer — remapped to id ${maxId} (connections preserved).`,
      );
    }
  }

  const uiNodes = new Map<string, UiNode>();
  const pending: PendingLink[] = [];

  for (const key of keys) {
    const apiNode = api[key];
    const classType = apiNode.class_type;
    const apiInputs = (apiNode.inputs ?? {}) as Record<string, unknown>;
    const def = objectInfo[classType];
    const id = idFor.get(key)!;

    const uiInputs: UiNodeInput[] = [];
    const widgetsValues: unknown[] = [];
    const consumed = new Set<string>();

    if (!def) {
      // Best-effort: keep connections; carry literals as positional widgets in
      // key order. convertUiToApi will skip this node too (same warning), so
      // the graph degrades symmetrically instead of silently losing wiring.
      warnings.push(
        `Node ${key} (${classType}): not found in object_info — custom node may not be installed. Slot layout is best-effort.`,
      );
      for (const [name, val] of Object.entries(apiInputs)) {
        if (isLinkRef(val, keySet)) {
          uiInputs.push({ name, type: "*", link: null });
          pending.push({
            srcKey: String(val[0]),
            srcSlot: val[1],
            tgtKey: key,
            tgtSlotIdx: uiInputs.length - 1,
            expectedType: "*",
          });
        } else {
          widgetsValues.push(val);
        }
      }
    } else {
      const orderedNames = getOrderedInputNames(def);
      for (const name of orderedNames) {
        const spec = def.input.required?.[name] ?? def.input.optional?.[name];
        if (!spec) continue;
        consumed.add(name);
        const raw = apiInputs[name];

        if (isWidgetInput(name, def)) {
          // A widget input fed by a link is a "converted widget" in the UI:
          // an inputs[] slot carrying widget:{name}, with a positional
          // placeholder kept in widgets_values so downstream widget indices
          // stay aligned (convertUiToApi assigns the placeholder, then the
          // link overrides it by name).
          let effective: unknown;
          if (isLinkRef(raw, keySet)) {
            effective = widgetDefaultValue(spec);
            uiInputs.push({
              name,
              type: widgetSlotType(spec),
              link: null,
              widget: { name },
            });
            pending.push({
              srcKey: String(raw[0]),
              srcSlot: raw[1],
              tgtKey: key,
              tgtSlotIdx: uiInputs.length - 1,
              expectedType: widgetSlotType(spec),
            });
          } else {
            effective = raw !== undefined ? raw : widgetDefaultValue(spec);
          }
          widgetsValues.push(effective);

          // Phantom "fixed"/"randomize" widget after control_after_generate
          // seeds — convertUiToApi skips exactly one entry here.
          if (hasControlAfterGenerate(name, def)) widgetsValues.push("fixed");

          // V3 dynamic combo: the selected option's nested POSITIONAL widgets
          // follow the combo value in widgets_values; their API values arrive
          // as dotted "combo.nested" keys.
          const opts = (
            spec[1] as
              | { options?: Array<{ key?: unknown; inputs?: { required?: Record<string, unknown> } }> }
              | undefined
          )?.options;
          const nested = Array.isArray(opts)
            ? opts.find((o) => o?.key === effective)?.inputs?.required
            : undefined;
          if (nested) {
            for (const [nName, nSpec] of Object.entries(nested)) {
              if (!isPositionalWidgetSpec(nSpec)) continue;
              const dotted = `${name}.${nName}`;
              consumed.add(dotted);
              const nRaw = apiInputs[dotted];
              widgetsValues.push(
                nRaw !== undefined ? nRaw : widgetDefaultValue(nSpec as NodeInputSpec),
              );
            }
          }
        } else {
          // Link (connection) input — always present as a slot, wired or not.
          const slotType = typeof spec[0] === "string" ? spec[0] : "COMBO";
          uiInputs.push({ name, type: slotType, link: null });
          if (isLinkRef(raw, keySet)) {
            pending.push({
              srcKey: String(raw[0]),
              srcSlot: raw[1],
              tgtKey: key,
              tgtSlotIdx: uiInputs.length - 1,
              expectedType: slotType,
            });
          } else if (raw !== undefined) {
            warnings.push(
              `Node ${key} (${classType}): input "${name}" expects a connection but got a literal value — dropped (wire it or use a Primitive node).`,
            );
          }
        }
      }

      // rgthree Power Lora Loader: loras arrive as lora_1..lora_N input objects
      // (the shape convertUiToApi emits); in the UI they live in widgets_values.
      if (/Power Lora Loader/.test(classType)) {
        const loraKeys = Object.keys(apiInputs)
          .filter((k) => /^lora_\d+$/.test(k))
          .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
        for (const lk of loraKeys) {
          consumed.add(lk);
          const v = apiInputs[lk];
          if (v && typeof v === "object" && !Array.isArray(v)) widgetsValues.push(v);
        }
      }

      // Anything left is either a stray link (wire it anyway, extra slot) or a
      // literal on an input the node definition doesn't declare (warn — it
      // would be silently lost on a UI round-trip).
      for (const [name, val] of Object.entries(apiInputs)) {
        if (consumed.has(name)) continue;
        if (isLinkRef(val, keySet)) {
          uiInputs.push({ name, type: "*", link: null });
          pending.push({
            srcKey: String(val[0]),
            srcSlot: val[1],
            tgtKey: key,
            tgtSlotIdx: uiInputs.length - 1,
            expectedType: "*",
          });
        } else {
          warnings.push(
            `Node ${key} (${classType}): input "${name}" is not declared by the node definition — value carried nowhere in UI format and will not round-trip.`,
          );
        }
      }
    }

    // Output slots straight from the definition. (COMBO outputs appear as
    // option arrays in some defs — normalize to a "COMBO" slot type.)
    const outputs: UiNodeOutput[] = ((def?.output ?? []) as unknown[]).map((t, i) => ({
      name: def?.output_name?.[i] ?? (typeof t === "string" ? t : "COMBO"),
      type: typeof t === "string" ? t : "COMBO",
      links: [],
    }));

    const meta = apiNode._meta as { title?: string; mode?: string } | undefined;
    const mode = meta?.mode === "muted" ? 2 : meta?.mode === "bypassed" ? 4 : 0;

    const uiNode: UiNode = {
      id,
      type: classType,
      pos: [0, 0],
      size: [280, 100], // finalized by the layout pass
      flags: {},
      order: 0,
      mode,
      inputs: uiInputs,
      outputs,
      properties: { "Node name for S&R": classType },
      widgets_values: widgetsValues,
    };
    if (meta?.title && meta.title !== classType) uiNode.title = meta.title;
    uiNodes.set(key, uiNode);
  }

  // ── Materialize links ────────────────────────────────────────────────────
  const links: UiLink[] = [];
  let lastLinkId = 0;
  for (const p of pending) {
    const src = uiNodes.get(p.srcKey);
    const tgt = uiNodes.get(p.tgtKey)!;
    if (!src) continue; // ref to a key we never materialized (can't happen: keySet-gated)
    // Ensure the source has a slot at srcSlot even if its def was unknown.
    while ((src.outputs ??= []).length <= p.srcSlot) {
      src.outputs.push({ name: `out_${src.outputs.length}`, type: "*", links: [] });
    }
    const srcOut = src.outputs[p.srcSlot];
    const linkType = srcOut.type !== "*" ? srcOut.type : p.expectedType;
    const linkId = ++lastLinkId;
    (srcOut.links ??= []).push(linkId);
    tgt.inputs![p.tgtSlotIdx].link = linkId;
    links.push([linkId, src.id, p.srcSlot, tgt.id, p.tgtSlotIdx, linkType]);
  }

  // ── Generated layout: topological layers, left → right ──────────────────
  const layerByKey = new Map<string, number>(keys.map((k) => [k, 0]));
  const edges = pending
    .map((p) => [p.srcKey, p.tgtKey] as const)
    .filter(([s, t]) => s !== t);
  // Bounded relaxation — cycle-safe and plenty for real graph depths.
  for (let pass = 0; pass < keys.length; pass++) {
    let changed = false;
    for (const [s, t] of edges) {
      const want = layerByKey.get(s)! + 1;
      if (want > layerByKey.get(t)!) {
        layerByKey.set(t, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const byLayer = new Map<number, string[]>();
  for (const k of keys) {
    const l = layerByKey.get(k)!;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(k);
  }
  const X_START = 40;
  const X_STEP = 380;
  const Y_START = 60;
  const Y_GAP = 60;
  let order = 0;
  for (const layer of [...byLayer.keys()].sort((a, b) => a - b)) {
    let y = Y_START;
    for (const k of byLayer.get(layer)!) {
      const n = uiNodes.get(k)!;
      const slots = Math.max(n.inputs?.length ?? 0, n.outputs?.length ?? 0);
      const widgets = Array.isArray(n.widgets_values) ? n.widgets_values.length : 0;
      const height = Math.max(60, 36 + 22 * slots + 26 * widgets);
      n.pos = [X_START + layer * X_STEP, y];
      n.size = [280, height];
      n.order = order++;
      y += height + Y_GAP;
    }
  }

  const nodes = keys.map((k) => uiNodes.get(k)!);
  const workflow: UiWorkflow = {
    last_node_id: Math.max(0, ...nodes.map((n) => n.id)),
    last_link_id: lastLinkId,
    nodes,
    links,
    groups: [],
    config: {},
    extra: {},
    version: 0.4,
  };

  logger.info(
    `Converted API workflow to UI format: ${nodes.length} nodes, ${links.length} links`,
  );
  return { workflow, warnings };
}

/**
 * Convert a ComfyUI UI-format workflow to API format.
 * Requires objectInfo from /object_info to map widgets_values to named inputs.
 */
export function convertUiToApi(
  ui: UiWorkflow,
  objectInfo: ObjectInfo,
): ConversionResult {
  // Clone (don't mutate the caller's workflow), strip the wiring virtuals
  // (Get/Set bus + Reroute) so the expander + converter only see real links,
  // then expand component/subgraph nodes.
  const cleaned = structuredClone(ui);
  deVirtualize(cleaned);
  const { expanded, warnings: expandWarnings } = expandComponents(cleaned);

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

  // Get/Set node types that need special handling (not in object_info)
  const GET_SET_TYPES = new Set([
    "GetNode", "SetNode", "PRO_GetNode", "PRO_SetNode",
    "SetNode_GetNode", "SetNode_SetNode",
  ]);

  const nodesById = new Map(expanded.nodes.map((n) => [n.id, n]));

  const isGetType = (t: string) => GET_SET_TYPES.has(t) && /get/i.test(t);
  const isSetType = (t: string) =>
    GET_SET_TYPES.has(t) && /set/i.test(t) && !/get/i.test(t);

  // bus name (SetNode "Constant") -> the link feeding that SetNode's value input
  const busSource = new Map<string, number>();
  for (const n of expanded.nodes) {
    if (!isSetType(n.type)) continue;
    const bus = n.widgets_values?.[0];
    const inp = (n.inputs ?? []).find((i) => i.link != null);
    if (bus != null && inp?.link != null) busSource.set(String(bus), inp.link);
  }

  // Resolve a UI input link to a live [nodeId, slot], mirroring ComfyUI's
  // graphToPrompt: virtual Get/Set bus nodes are resolved through to the real
  // source; muted (mode 2) sources drop the connection; bypassed (mode 4)
  // sources pass through — the consumer reconnects to the bypassed node's input
  // whose type matches the requested output slot (same index first, then any
  // type match), recursing through chains of bypassed/virtual nodes.
  const resolveSource = (
    linkId: number,
    depth = 0,
  ): { id: string; slot: number } | null => {
    if (depth > 100) return null;
    const link = linkMap.get(linkId);
    if (!link) return null;
    const src = nodesById.get(link.sourceNodeId);
    if (!src) {
      return { id: String(link.sourceNodeId), slot: link.sourceSlot };
    }
    // Virtual GetNode: follow the bus to the SetNode that wrote it.
    if (isGetType(src.type)) {
      const bus = src.widgets_values?.[0];
      const setLink = bus != null ? busSource.get(String(bus)) : undefined;
      return setLink != null ? resolveSource(setLink, depth + 1) : null;
    }
    // Virtual SetNode passthrough: follow its value input.
    if (isSetType(src.type)) {
      const inp = (src.inputs ?? []).find((i) => i.link != null);
      return inp?.link != null ? resolveSource(inp.link, depth + 1) : null;
    }
    // Reroute passthrough: a virtual node that just forwards its single input to
    // all outputs — follow its input link to the real source.
    if (src.type === "Reroute") {
      const inp = (src.inputs ?? []).find((i) => i.link != null);
      return inp?.link != null ? resolveSource(inp.link, depth + 1) : null;
    }
    const mode = src.mode ?? 0;
    if (mode === 0) {
      return { id: String(link.sourceNodeId), slot: link.sourceSlot };
    }
    if (mode === 2) return null; // muted: connection dropped
    if (mode === 4) {
      // bypass: find a matching-type input to pass through
      const outType = link.typeName;
      const inputs = src.inputs ?? [];
      let cand: (typeof inputs)[number] | undefined = inputs[link.sourceSlot];
      if (!cand || cand.link == null || (outType && cand.type !== outType)) {
        cand = inputs.find(
          (i) => i.link != null && (!outType || i.type === outType),
        );
      }
      if (!cand || cand.link == null) return null;
      return resolveSource(cand.link, depth + 1);
    }
    return null;
  };

  for (const node of expanded.nodes) {
    // Muted (2) and bypassed (4) nodes are excluded from the prompt entirely;
    // their downstream connections are rewired via resolveSource above.
    if (node.mode === 2 || node.mode === 4) continue;

    const nodeId = String(node.id);
    const classType = node.type;

    // Skip internal litegraph node types
    if (SKIP_TYPES.has(classType)) continue;

    // Virtual Get/Set bus nodes are not real ComfyUI nodes (not in object_info
    // and rejected by /prompt). Drop them — resolveSource rewires consumers
    // straight through the bus to the real upstream source.
    if (GET_SET_TYPES.has(classType)) continue;

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

    // Some nodes (e.g. VHS_VideoCombine) store widgets_values as a name->value
    // object instead of a positional array. Map those by name directly.
    if (!Array.isArray(widgetValues)) {
      const wv = widgetValues as Record<string, unknown>;
      for (const name of widgetNames) {
        if (name in wv) inputs[name] = wv[name];
      }
    } else {
    let widgetIdx = 0;
    for (const name of widgetNames) {
      if (widgetIdx >= widgetValues.length) break;
      const value = widgetValues[widgetIdx];
      inputs[name] = value;
      widgetIdx++;

      // If this input has control_after_generate, skip the next widgets_values entry
      if (hasControlAfterGenerate(name, def) && widgetIdx < widgetValues.length) {
        widgetIdx++;
      }

      // V3 dynamic combo: the selected option adds nested required inputs whose
      // values follow in widgets_values (e.g. method="rcas" -> strength=0.55).
      const spec =
        (def.input?.required as Record<string, unknown>)?.[name] ??
        (def.input?.optional as Record<string, unknown>)?.[name];

      // Classic combo widget: if the saved value isn't one of the valid options
      // (a stale UI-helper combo like Impact's "Select to add Wildcard", or a
      // value from a node version with different options), fall back to the
      // default first option. ComfyUI hard-rejects "Value not in list" otherwise,
      // so defaulting is strictly safer than passing the stale value through.
      const comboOpts = Array.isArray(spec) ? spec[0] : undefined;
      if (
        Array.isArray(comboOpts) &&
        comboOpts.length > 0 &&
        !comboOpts.includes(value as never)
      ) {
        inputs[name] = comboOpts[0];
      }

      const opts = (
        Array.isArray(spec)
          ? (spec[1] as { options?: Array<{ key?: unknown; inputs?: { required?: Record<string, unknown> } }> })
          : undefined
      )?.options;
      const nested = Array.isArray(opts)
        ? opts.find((o) => o?.key === value)?.inputs?.required
        : undefined;
      if (nested) {
        // V3 dynamic-combo nested inputs are keyed with the combo's id as a
        // "<combo>.<nested>" prefix (ComfyUI rebuilds the nested dict from these
        // via dynamic_paths). A flat "<nested>" key is rejected as missing.
        // Only POSITIONAL widget nested inputs consume a widgets_values slot —
        // non-widget nested inputs (AUTOGROW lists like Nano Banana 2's
        // "images", or IMAGE/link types) have no saved widget value, so skipping
        // them keeps the positional mapping aligned.
        for (const [nName, nSpec] of Object.entries(nested)) {
          if (widgetIdx >= widgetValues.length) break;
          if (!isPositionalWidgetSpec(nSpec)) continue;
          inputs[`${name}.${nName}`] = widgetValues[widgetIdx];
          widgetIdx++;
        }
      }
    }
    }

    // Fill any required input not covered by widgets_values or a link with its
    // object_info default, so /prompt validation doesn't reject on a missing
    // required input (e.g. a node version added a required widget the saved graph
    // predates, or a special widget type the widget-index mapping skipped). Link
    // inputs (IMAGE/LATENT/etc.) have no default, so they're left alone.
    for (const name of orderedNames) {
      if (name in inputs) continue;
      const spec = (def.input?.required as Record<string, unknown>)?.[name];
      if (!Array.isArray(spec)) continue;
      const [type, config] = spec as [
        unknown,
        { default?: unknown; options?: Array<{ key?: unknown }> }?,
      ];
      let dflt: unknown;
      if (Array.isArray(type)) {
        dflt = config?.default ?? type[0]; // combo list: default or first option
      } else if (Array.isArray(config?.options) && config.options.length) {
        // dynamic combo (e.g. COMFY_DYNAMICCOMBO_V3): default or first option key
        dflt = config.default ?? config.options[0]?.key ?? config.options[0];
      } else {
        dflt = config?.default;
      }
      if (dflt !== undefined) inputs[name] = dflt;
    }

    // Map linked inputs from node's inputs array (bypass/mute resolved)
    if (node.inputs) {
      for (const input of node.inputs) {
        if (input.link == null) continue;
        // A virtual PrimitiveNode feeding a widget input provides a literal value,
        // not a connection — it's skipped from the prompt, so use its widget value
        // (e.g. a shared seed/steps PrimitiveNode wired into several samplers).
        const link = linkMap.get(input.link);
        const srcNode = link ? nodesById.get(link.sourceNodeId) : undefined;
        if (srcNode?.type === "PrimitiveNode") {
          const val = srcNode.widgets_values?.[0];
          if (val !== undefined) inputs[input.name] = val;
          continue;
        }
        const resolved = resolveSource(input.link);
        if (resolved) inputs[input.name] = [resolved.id, resolved.slot];
      }
    }

    // rgthree "Power Lora Loader" stores its loras in widgets_values as a list of
    // {on, lora, strength, strengthTwo} objects, NOT as named inputs — its Python
    // reads them from kwargs keyed lora_1, lora_2, …. Translate them here so the
    // loras actually apply; otherwise the node loads zero loras (e.g. a 4-step
    // lightning video workflow then renders badly under-denoised / blurry).
    if (/Power Lora Loader/.test(classType)) {
      const wv = Array.isArray(node.widgets_values) ? node.widgets_values : [];
      let li = 1;
      for (const w of wv) {
        if (
          w &&
          typeof w === "object" &&
          !Array.isArray(w) &&
          "lora" in (w as Record<string, unknown>)
        ) {
          inputs[`lora_${li++}`] = w;
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
    const meta: Record<string, unknown> = {};
    if (title && title !== classType) meta.title = title;
    if (Object.keys(meta).length > 0) {
      workflow[nodeId]._meta = meta as { title?: string };
    }
  }

  // Prune dangling input references — a connection to a node id that isn't in
  // the prompt (e.g. a consumer of an expanded-away subgraph instance that the
  // component expansion didn't remap). ComfyUI errors hard ("Node X not found")
  // on these, so drop the connection like an unresolved link.
  const validIds = new Set(Object.keys(workflow));
  let prunedRefs = 0;
  for (const node of Object.values(workflow)) {
    const ins = node.inputs as Record<string, unknown>;
    for (const [name, val] of Object.entries(ins)) {
      if (
        Array.isArray(val) &&
        val.length === 2 &&
        typeof val[0] === "string" &&
        !validIds.has(val[0])
      ) {
        if (process.env.DEBUG_PRUNE) logger.info(`PRUNE: ${(node as {class_type?:string}).class_type}.${name} -> missing ${val[0]}`);
        delete ins[name];
        prunedRefs++;
      }
    }
  }
  if (prunedRefs > 0) {
    warnings.push(`Pruned ${prunedRefs} dangling input reference(s) to nodes not in the prompt.`);
  }

  // Drop links whose source output type clearly mismatches the consuming input's
  // expected type. ComfyUI hard-rejects a type-mismatched link ("Return type
  // mismatch between linked nodes") and fails the whole output branch, so a
  // mismatch means the link is already broken — dropping it cannot regress a
  // working graph (which has none). For an optional input the input simply
  // becomes absent (valid); this rescues e.g. an Impact detailer whose
  // bbox_detector got mis-resolved onto an IMAGE output by a virtual bus.
  // Restricted to custom object types (uppercase, non-primitive) so primitive
  // coercions (INT/FLOAT/…) and wildcard ("*") inputs are never touched.
  // A "strict" object type is a concrete custom type (IMAGE, MODEL, BBOX_DETECTOR…).
  // Exclude primitives (coercible) and polymorphic/wildcard types — notably the V3
  // COMFY_* meta-types (e.g. COMFY_MATCHTYPE_V3, which match whatever they connect
  // to) and ANY/* — so a valid IMAGE↔COMFY_MATCHTYPE_V3 link is never dropped.
  const isObjectType = (t: unknown): t is string =>
    typeof t === "string" &&
    /^[A-Z][A-Z0-9_]*$/.test(t) &&
    !t.startsWith("COMFY_") &&
    !["INT", "FLOAT", "STRING", "BOOLEAN", "NUMBER", "ANY"].includes(t);
  let droppedMismatch = 0;
  for (const node of Object.values(workflow)) {
    const def = objectInfo[node.class_type];
    if (!def) continue;
    const ins = node.inputs as Record<string, unknown>;
    for (const [name, val] of Object.entries(ins)) {
      if (!Array.isArray(val) || val.length !== 2 || typeof val[0] !== "string") {
        continue;
      }
      const srcDef = objectInfo[workflow[val[0]]?.class_type];
      const srcOut = srcDef?.output?.[val[1] as number];
      const inSpec = def.input.required?.[name] ?? def.input.optional?.[name];
      const expected = Array.isArray(inSpec) ? inSpec[0] : undefined;
      if (isObjectType(expected) && isObjectType(srcOut) && expected !== srcOut) {
        if (process.env.DEBUG_PRUNE) {
          logger.info(`TYPEDROP: ${node.class_type}.${name} expected ${expected} got ${srcOut}`);
        }
        delete ins[name];
        droppedMismatch++;
      }
    }
  }
  if (droppedMismatch > 0) {
    warnings.push(`Dropped ${droppedMismatch} type-mismatched link(s).`);
  }

  const nodeCount = Object.keys(workflow).length;
  const skipped = expanded.nodes.length - nodeCount;
  logger.info(
    `Converted UI workflow: ${nodeCount} nodes (${skipped} skipped)`,
  );

  return { workflow, warnings };
}
