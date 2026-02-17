import type { WorkflowJSON, ObjectInfo } from "../comfyui/types.js";
import { isConnection } from "./mermaid-converter.js";

export interface SectionInfo {
  name: string;
  label: string;
  nodeIds: Set<string>;
  keyTypes: string[];
  inEdges: Array<{ fromSection: string; dataTypes: Set<string> }>;
  outEdges: Array<{ toSection: string; dataTypes: Set<string> }>;
}

export interface VirtualEdge {
  sourceNodeId: string;
  targetNodeId: string;
  key: string;
}

export interface DetectionResult {
  sections: Map<string, SectionInfo>;
  virtualEdges: VirtualEdge[];
  nodeToSection: Map<string, string>;
  getSetNodeIds: Set<string>;
}

const CATEGORY_ALIASES: Record<string, string> = {
  loaders: "loading",
  _for_testing: "utility",
  api: "utility",
  utils: "utility",
  // Custom node pack categories
  bootleg: "loading",             // ComfyUI-GGUF (UNET/CLIP loaders)
  gguf: "loading",                // gguf pack (CLIP loaders)
  rgthree: "loading",             // rgthree (Lora Loader Stack, etc.)
  seedvr2: "image",               // SeedVR2 (video upscaler)
  "video helper suite": "output", // VHS (Video Combine)
};

// Meta-categories where the second level is more meaningful
const META_CATEGORIES = new Set(["advanced"]);

// Known core pipeline section names
const KNOWN_SECTIONS = new Set([
  "loading", "conditioning", "sampling", "latent",
  "image", "output", "mask", "utility",
]);

// Strip emoji and special characters from a category string
function cleanCategory(category: string): string {
  return category.replace(/[^\p{L}\p{N}\s/\-_]/gu, "").trim();
}

// Normalize a ComfyUI category string to a top-level section name
export function normalizeCategoryName(category: string): string {
  const cleaned = cleanCategory(category);
  const parts = cleaned.split("/").map((p) => p.toLowerCase().trim());
  // For meta-categories like "advanced/loaders", use the second level
  let key = parts[0];
  if (META_CATEGORIES.has(key) && parts.length > 1) {
    key = parts[1];
  }

  // Check direct alias
  const aliased = CATEGORY_ALIASES[key];
  if (aliased) return aliased;

  // If key is already a known section, use it
  if (KNOWN_SECTIONS.has(key)) return key;

  // Check if any sub-part of the category path is a known section or has an alias
  // e.g., "KJNodes/image" → sub-part "image" is known
  // e.g., "GetSetNode_Pro/loaders" → sub-part "loaders" aliases to "loading"
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (CATEGORY_ALIASES[part]) return CATEGORY_ALIASES[part];
    if (KNOWN_SECTIONS.has(part)) return part;
  }

  // Fall back to the cleaned key
  return key;
}

// Get/Set node class types we recognize
const GET_NODE_TYPES = new Set(["GetNode", "PRO_GetNode", "SetNode_GetNode"]);
const SET_NODE_TYPES = new Set(["SetNode", "PRO_SetNode", "SetNode_SetNode"]);

function isGetNode(classType: string): boolean {
  return GET_NODE_TYPES.has(classType);
}

function isSetNode(classType: string): boolean {
  return SET_NODE_TYPES.has(classType);
}

// Resolve Get/Set pairs into virtual edges
export function resolveGetSetPairs(workflow: WorkflowJSON): VirtualEdge[] {
  const setters = new Map<string, string>(); // key -> node ID
  const getters = new Map<string, string[]>(); // key -> node IDs

  for (const [id, node] of Object.entries(workflow)) {
    if (isSetNode(node.class_type)) {
      // Prefer Constant (the actual wire key) over title (which may have "Set_" prefix)
      const key =
        (node.inputs.Constant as string) ??
        (node._meta?.title as string) ??
        "";
      if (key) setters.set(key, id);
    } else if (isGetNode(node.class_type)) {
      const key =
        (node.inputs.Constant as string) ??
        (node._meta?.title as string) ??
        "";
      if (key) {
        if (!getters.has(key)) getters.set(key, []);
        getters.get(key)!.push(id);
      }
    }
  }

  const edges: VirtualEdge[] = [];
  for (const [key, setterId] of setters) {
    const getterIds = getters.get(key);
    if (!getterIds) continue;
    for (const getterId of getterIds) {
      edges.push({ sourceNodeId: setterId, targetNodeId: getterId, key });
    }
  }
  return edges;
}

// Find which real nodes feed into a Set node and which real nodes consume from a Get node
function resolveGetSetConnections(
  workflow: WorkflowJSON,
  virtualEdges: VirtualEdge[],
): Array<{ sourceNodeId: string; targetNodeId: string; dataType: string }> {
  const resolved: Array<{
    sourceNodeId: string;
    targetNodeId: string;
    dataType: string;
  }> = [];

  for (const ve of virtualEdges) {
    // The Set node receives data from some real node
    const setNode = workflow[ve.sourceNodeId];
    if (!setNode) continue;

    // Find what feeds into the SetNode's value input
    let feederId: string | undefined;
    for (const [, value] of Object.entries(setNode.inputs)) {
      if (isConnection(value)) {
        feederId = value[0];
        break;
      }
    }

    // Find what the GetNode feeds into
    const getNode = workflow[ve.targetNodeId];
    if (!getNode) continue;

    // For cross-section edge purposes, connect feeder -> consumers of GetNode
    const consumersOfGet: string[] = [];
    for (const [nodeId, node] of Object.entries(workflow)) {
      for (const [, value] of Object.entries(node.inputs)) {
        if (isConnection(value) && value[0] === ve.targetNodeId) {
          consumersOfGet.push(nodeId);
        }
      }
    }

    if (feederId) {
      for (const consumerId of consumersOfGet) {
        resolved.push({
          sourceNodeId: feederId,
          targetNodeId: consumerId,
          dataType: ve.key,
        });
      }
    }
  }

  return resolved;
}

export function detectSections(
  workflow: WorkflowJSON,
  objectInfo: ObjectInfo,
): DetectionResult {
  const virtualEdges = resolveGetSetPairs(workflow);
  const getSetNodeIds = new Set<string>();
  for (const ve of virtualEdges) {
    getSetNodeIds.add(ve.sourceNodeId);
    getSetNodeIds.add(ve.targetNodeId);
  }
  // Also mark any Get/Set nodes that didn't match a pair
  for (const [id, node] of Object.entries(workflow)) {
    if (isGetNode(node.class_type) || isSetNode(node.class_type)) {
      getSetNodeIds.add(id);
    }
  }

  // Assign each non-Get/Set node to a section based on object_info category
  const nodeToSection = new Map<string, string>();
  const sectionNodes = new Map<string, Set<string>>();

  for (const [id, node] of Object.entries(workflow)) {
    if (getSetNodeIds.has(id)) continue;

    const def = objectInfo[node.class_type];
    const rawCategory = def?.category ?? "utility";
    const section = normalizeCategoryName(rawCategory);

    nodeToSection.set(id, section);
    if (!sectionNodes.has(section)) sectionNodes.set(section, new Set());
    sectionNodes.get(section)!.add(id);
  }

  // Core pipeline sections that should never be merged, regardless of size
  const CORE_SECTIONS = new Set([
    "loading", "loaders", "conditioning", "sampling", "latent",
    "image", "output", "mask",
  ]);

  // Merge small sections (<=2 nodes) into nearest connected section or "utility"
  // Only merge if there are non-small sections to absorb them
  const smallSections = new Set<string>();
  for (const [name, nodes] of sectionNodes) {
    if (nodes.size <= 2 && name !== "utility" && !CORE_SECTIONS.has(name)) {
      smallSections.add(name);
    }
  }

  // Count how many non-small, non-utility sections exist
  const largeSections = [...sectionNodes.keys()].filter(
    (n) => !smallSections.has(n) && n !== "utility",
  );

  // Only merge if there are large sections to absorb small ones
  if (smallSections.size > 0 && largeSections.length > 0) {
    // Find the best merge target for each small section
    const allEdges = extractAllEdges(workflow, getSetNodeIds);

    for (const small of smallSections) {
      const nodes = sectionNodes.get(small)!;
      // Count connections to other sections
      const connectionCounts = new Map<string, number>();
      for (const nodeId of nodes) {
        for (const edge of allEdges) {
          if (edge.sourceId === nodeId) {
            const targetSection = nodeToSection.get(edge.targetId);
            if (targetSection && targetSection !== small && !smallSections.has(targetSection)) {
              connectionCounts.set(
                targetSection,
                (connectionCounts.get(targetSection) ?? 0) + 1,
              );
            }
          }
          if (edge.targetId === nodeId) {
            const sourceSection = nodeToSection.get(edge.sourceId);
            if (sourceSection && sourceSection !== small && !smallSections.has(sourceSection)) {
              connectionCounts.set(
                sourceSection,
                (connectionCounts.get(sourceSection) ?? 0) + 1,
              );
            }
          }
        }
      }

      // Pick the section with the most connections, fall back to "utility"
      let mergeTarget = "utility";
      let maxCount = 0;
      for (const [section, count] of connectionCounts) {
        if (count > maxCount) {
          maxCount = count;
          mergeTarget = section;
        }
      }

      // Ensure merge target exists
      if (!sectionNodes.has(mergeTarget))
        sectionNodes.set(mergeTarget, new Set());

      // Move nodes
      for (const nodeId of nodes) {
        nodeToSection.set(nodeId, mergeTarget);
        sectionNodes.get(mergeTarget)!.add(nodeId);
      }
      sectionNodes.delete(small);
    }
  }

  // Build SectionInfo map
  const sections = new Map<string, SectionInfo>();
  for (const [name, nodeIds] of sectionNodes) {
    // Count class_type occurrences to find key types
    const typeCounts = new Map<string, number>();
    for (const id of nodeIds) {
      const ct = workflow[id].class_type;
      typeCounts.set(ct, (typeCounts.get(ct) ?? 0) + 1);
    }
    // Top 3 most frequent types
    const keyTypes = [...typeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([ct]) => ct);

    const label = name.charAt(0).toUpperCase() + name.slice(1);

    sections.set(name, {
      name,
      label,
      nodeIds,
      keyTypes,
      inEdges: [],
      outEdges: [],
    });
  }

  // Compute cross-section edges from real connections
  const allEdges = extractAllEdges(workflow, getSetNodeIds);
  const crossEdgeMap = new Map<string, Set<string>>(); // "from->to" -> data types

  for (const edge of allEdges) {
    const sourceSection = nodeToSection.get(edge.sourceId);
    const targetSection = nodeToSection.get(edge.targetId);
    if (!sourceSection || !targetSection || sourceSection === targetSection)
      continue;

    const key = `${sourceSection}->${targetSection}`;
    if (!crossEdgeMap.has(key)) crossEdgeMap.set(key, new Set());
    if (edge.dataType) crossEdgeMap.get(key)!.add(edge.dataType);
  }

  // Add virtual (Get/Set) cross-section edges
  const resolvedVirtual = resolveGetSetConnections(
    workflow,
    virtualEdges,
  );
  for (const rv of resolvedVirtual) {
    const sourceSection = nodeToSection.get(rv.sourceNodeId);
    const targetSection = nodeToSection.get(rv.targetNodeId);
    if (!sourceSection || !targetSection || sourceSection === targetSection)
      continue;

    const key = `${sourceSection}->${targetSection}`;
    if (!crossEdgeMap.has(key)) crossEdgeMap.set(key, new Set());
    if (rv.dataType) crossEdgeMap.get(key)!.add(rv.dataType);
  }

  // Populate inEdges/outEdges on sections
  for (const [key, dataTypes] of crossEdgeMap) {
    const [fromName, toName] = key.split("->");
    const fromSection = sections.get(fromName);
    const toSection = sections.get(toName);
    if (fromSection && toSection) {
      fromSection.outEdges.push({ toSection: toName, dataTypes });
      toSection.inEdges.push({ fromSection: fromName, dataTypes });
    }
  }

  return { sections, virtualEdges, nodeToSection, getSetNodeIds };
}

interface SimpleEdge {
  sourceId: string;
  targetId: string;
  dataType: string;
}

function extractAllEdges(
  workflow: WorkflowJSON,
  excludeNodeIds: Set<string>,
): SimpleEdge[] {
  const edges: SimpleEdge[] = [];
  for (const [targetId, node] of Object.entries(workflow)) {
    if (excludeNodeIds.has(targetId)) continue;
    for (const [inputName, value] of Object.entries(node.inputs)) {
      if (isConnection(value)) {
        const sourceId = value[0];
        if (excludeNodeIds.has(sourceId)) continue;
        // Use input name as a rough data type hint
        edges.push({
          sourceId,
          targetId,
          dataType: inputName.toUpperCase(),
        });
      }
    }
  }
  return edges;
}
