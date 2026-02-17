import type { WorkflowJSON, ObjectInfo } from "../comfyui/types.js";
import type { SectionInfo, VirtualEdge } from "./workflow-sections.js";
import {
  buildNodeLabel,
  wrapNodeLabel,
  escapeForMermaid,
  extractConnections,
  guessOutputType,
  isConnection,
  DISPLAY_VALUES,
  TYPE_COLORS,
} from "./mermaid-converter.js";

interface HierarchicalOptions {
  showValues?: boolean;
  direction?: "LR" | "TB";
}

// Section shapes for the overview diagram
const SECTION_SHAPES: Record<string, (id: string, label: string) => string> = {
  sampling: (id, label) => `${id}{{"${label}"}}`,
  conditioning: (id, label) => `${id}(["${label}"])`,
  loading: (id, label) => `${id}[["${label}"]]`,
  output: (id, label) => `${id}((("${label}")))`,
  image: (id, label) => `${id}("${label}")`,
};

// Sanitize section name for use as a mermaid node ID (alphanumeric + underscore only)
function sectionId(name: string): string {
  return "sec_" + name.replace(/[^a-zA-Z0-9]/g, "_");
}

function sectionShape(sectionName: string, id: string, label: string): string {
  const shaper = SECTION_SHAPES[sectionName];
  if (shaper) return shaper(id, label);
  return `${id}["${label}"]`;
}

export function generateOverview(
  workflow: WorkflowJSON,
  sections: Map<string, SectionInfo>,
  options: HierarchicalOptions = {},
): string {
  const { direction = "TB" } = options;
  const lines: string[] = [`flowchart ${direction}`];

  // Emit section nodes
  for (const [name, section] of sections) {
    const nodeCount = section.nodeIds.size;
    const keyTypesStr = section.keyTypes.join(", ");
    const label = escapeForMermaid(
      `${section.label} (${nodeCount} nodes)<br/>${keyTypesStr}`,
    );
    lines.push(`  ${sectionShape(name, sectionId(name), label)}`);
  }

  // Emit cross-section edges
  // Deduplicate: collect all unique from->to pairs with their data types
  const edgePairs = new Map<string, Set<string>>();
  for (const [name, section] of sections) {
    for (const outEdge of section.outEdges) {
      const key = `${sectionId(name)}->${sectionId(outEdge.toSection)}`;
      if (!edgePairs.has(key)) edgePairs.set(key, new Set());
      for (const dt of outEdge.dataTypes) {
        edgePairs.get(key)!.add(dt);
      }
    }
  }

  for (const [key, dataTypes] of edgePairs) {
    const [from, to] = key.split("->");
    const typeLabel = [...dataTypes].slice(0, 4).join(", ");
    if (typeLabel) {
      lines.push(`  ${from} -->|${escapeForMermaid(typeLabel)}| ${to}`);
    } else {
      lines.push(`  ${from} --> ${to}`);
    }
  }

  // Style classes
  lines.push("");
  lines.push("  classDef sampling fill:#ff9,stroke:#f90,stroke-width:2px");
  lines.push("  classDef loading fill:#9cf,stroke:#36f,stroke-width:2px");
  lines.push(
    "  classDef conditioning fill:#fc9,stroke:#f60,stroke-width:2px",
  );
  lines.push("  classDef output fill:#9f9,stroke:#0a0,stroke-width:2px");
  lines.push("  classDef image fill:#c9f,stroke:#60f,stroke-width:2px");

  // Apply classes to section nodes
  for (const [name] of sections) {
    const cls = ["sampling", "loading", "conditioning", "output", "image"].includes(name)
      ? name
      : undefined;
    if (cls) {
      lines.push(`  class ${sectionId(name)} ${cls}`);
    }
  }

  return lines.join("\n");
}

export function generateSectionDetail(
  workflow: WorkflowJSON,
  sections: Map<string, SectionInfo>,
  sectionName: string,
  options: HierarchicalOptions = {},
): string {
  const { showValues = true, direction = "LR" } = options;
  const section = sections.get(sectionName);
  if (!section) {
    const available = [...sections.keys()].join(", ");
    throw new Error(`Section "${sectionName}" not found. Available sections: ${available}`);
  }

  const lines: string[] = [`flowchart ${direction}`];
  const nodeIds = section.nodeIds;

  // Categorize each node using a simple heuristic for shape wrapping
  function simpleCategory(
    classType: string,
  ): "sampling" | "conditioning" | "loading" | "image" | "output" | "utility" {
    if (classType.startsWith("KSampler") || classType === "SamplerCustom")
      return "sampling";
    if (
      classType === "CLIPTextEncode" ||
      classType.startsWith("Conditioning")
    )
      return "conditioning";
    if (
      classType.startsWith("CheckpointLoader") ||
      classType.startsWith("CLIPLoader") ||
      classType.startsWith("VAELoader") ||
      classType.startsWith("LoraLoader")
    )
      return "loading";
    if (classType === "SaveImage" || classType === "PreviewImage")
      return "output";
    if (
      classType === "VAEDecode" ||
      classType === "VAEEncode" ||
      classType === "LoadImage" ||
      classType.startsWith("ImageScale")
    )
      return "image";
    return "utility";
  }

  // Emit main section nodes
  lines.push(`  subgraph ${section.label}`);
  for (const id of nodeIds) {
    const node = workflow[id];
    if (!node) continue;
    const label = escapeForMermaid(buildNodeLabel(node, showValues));
    const cat = simpleCategory(node.class_type);
    lines.push(`    ${wrapNodeLabel(id, label, cat)}`);
  }
  lines.push("  end");

  // Find boundary nodes: nodes in other sections that connect to/from this section
  const allEdges = extractConnections(workflow);
  const boundaryNodes = new Map<
    string,
    { label: string; direction: "in" | "out"; sectionName: string }
  >();

  for (const edge of allEdges) {
    const sourceInSection = nodeIds.has(edge.sourceId);
    const targetInSection = nodeIds.has(edge.targetId);

    if (sourceInSection && !targetInSection) {
      // Outgoing edge: target is a boundary node
      const targetNode = workflow[edge.targetId];
      if (targetNode && !boundaryNodes.has(edge.targetId)) {
        // Find which section the target belongs to
        let targetSectionName = "?";
        for (const [sName, sInfo] of sections) {
          if (sInfo.nodeIds.has(edge.targetId)) {
            targetSectionName = sInfo.label;
            break;
          }
        }
        boundaryNodes.set(edge.targetId, {
          label: `${targetNode._meta?.title ?? targetNode.class_type} (${targetSectionName})`,
          direction: "out",
          sectionName: targetSectionName,
        });
      }
    } else if (!sourceInSection && targetInSection) {
      // Incoming edge: source is a boundary node
      const sourceNode = workflow[edge.sourceId];
      if (sourceNode && !boundaryNodes.has(edge.sourceId)) {
        let sourceSectionName = "?";
        for (const [sName, sInfo] of sections) {
          if (sInfo.nodeIds.has(edge.sourceId)) {
            sourceSectionName = sInfo.label;
            break;
          }
        }
        boundaryNodes.set(edge.sourceId, {
          label: `${sourceNode._meta?.title ?? sourceNode.class_type} (${sourceSectionName})`,
          direction: "in",
          sectionName: sourceSectionName,
        });
      }
    }
  }

  // Emit boundary nodes
  if (boundaryNodes.size > 0) {
    lines.push(`  subgraph External`);
    for (const [id, info] of boundaryNodes) {
      const escapedLabel = escapeForMermaid(info.label);
      lines.push(`    ${id}:::boundary["${escapedLabel}"]`);
    }
    lines.push("  end");
  }

  // Emit edges (only those where at least one endpoint is in this section)
  for (const edge of allEdges) {
    const sourceInSection = nodeIds.has(edge.sourceId);
    const targetInSection = nodeIds.has(edge.targetId);
    const sourceIsBoundary = boundaryNodes.has(edge.sourceId);
    const targetIsBoundary = boundaryNodes.has(edge.targetId);

    // Require at least one endpoint actually in the section (not just boundary)
    const touchesSection = sourceInSection || targetInSection;
    const bothVisible =
      (sourceInSection || sourceIsBoundary) &&
      (targetInSection || targetIsBoundary);

    if (touchesSection && bothVisible) {
      const sourceNode = workflow[edge.sourceId];
      const dataType = sourceNode
        ? guessOutputType(sourceNode.class_type, edge.outputIndex)
        : "";
      const labelPart = dataType ? `|${dataType}|` : "";

      if (labelPart) {
        lines.push(`  ${edge.sourceId} -->${labelPart} ${edge.targetId}`);
      } else {
        lines.push(`  ${edge.sourceId} --> ${edge.targetId}`);
      }
    }
  }

  // Boundary styling
  lines.push("");
  lines.push(
    "  classDef boundary fill:#eee,stroke:#999,stroke-width:1px,stroke-dasharray: 5 5",
  );

  return lines.join("\n");
}

export function listSections(
  workflow: WorkflowJSON,
  sections: Map<string, SectionInfo>,
): string {
  const lines: string[] = [];
  const totalNodes = Object.keys(workflow).length;

  lines.push(`## Workflow Overview: ${totalNodes} total nodes, ${sections.size} sections\n`);

  for (const [name, section] of sections) {
    lines.push(`### ${section.label} (${section.nodeIds.size} nodes)`);
    lines.push(`Key types: ${section.keyTypes.join(", ")}`);

    if (section.inEdges.length > 0) {
      const inSummary = section.inEdges
        .map(
          (e) =>
            `${e.fromSection} (${[...e.dataTypes].join(", ")})`,
        )
        .join("; ");
      lines.push(`Receives from: ${inSummary}`);
    }

    if (section.outEdges.length > 0) {
      const outSummary = section.outEdges
        .map(
          (e) =>
            `${e.toSection} (${[...e.dataTypes].join(", ")})`,
        )
        .join("; ");
      lines.push(`Sends to: ${outSummary}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

// Key widget values to show in AI summary (superset of DISPLAY_VALUES)
const SUMMARY_VALUES = new Set([
  ...DISPLAY_VALUES,
  "add_noise",
  "start_at_step",
  "end_at_step",
  "return_with_leftover_noise",
  "noise_seed",
  "lora_01",
  "strength_01",
  "lora_02",
  "strength_02",
  "clip_name",
  "unet_name",
  "vae_name",
  "type",
  "weight_dtype",
  "model_name",
  "shift",
  "length",
  "batch_size",
  "generation_mode",
  "positive_prompt",
  "negative_prompt",
  "crop",
  "num_frames",
]);

function formatNodeSummary(
  id: string,
  node: { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } },
): string {
  const title = node._meta?.title;
  const classType = node.class_type;
  const nameStr = title && title !== classType ? `${classType} "${title}"` : classType;

  // Collect key settings
  const settings: string[] = [];
  for (const [key, value] of Object.entries(node.inputs)) {
    if (isConnection(value)) continue;
    if (!SUMMARY_VALUES.has(key)) continue;

    let display: string;
    if (typeof value === "string") {
      // Truncate long strings
      display = value.length > 50 ? value.slice(0, 47) + "..." : value;
    } else {
      display = String(value);
    }
    settings.push(`${key}=${display}`);
  }

  const settingsStr = settings.length > 0 ? ` — ${settings.join(", ")}` : "";
  return `  ${id}: ${nameStr}${settingsStr}`;
}

export function generateSummary(
  workflow: WorkflowJSON,
  sections: Map<string, SectionInfo>,
  objectInfo: ObjectInfo,
  virtualEdges: VirtualEdge[],
  nodeToSection: Map<string, string>,
  getSetNodeIds: Set<string>,
): string {
  const lines: string[] = [];
  const totalNodes = Object.keys(workflow).length;
  const getSetCount = getSetNodeIds.size;

  lines.push(
    `# Workflow: ${totalNodes} nodes (${totalNodes - getSetCount} real + ${getSetCount} Get/Set), ${sections.size} sections`,
  );
  lines.push("");

  // Sections with node details
  for (const [, section] of sections) {
    lines.push(`## ${section.label} (${section.nodeIds.size} nodes)`);

    // Node list with IDs and key settings
    for (const id of section.nodeIds) {
      const node = workflow[id];
      if (!node) continue;
      lines.push(formatNodeSummary(id, node));
    }

    // Cross-section data flow using real output types from object_info
    const receives: string[] = [];
    const sends: string[] = [];

    for (const inEdge of section.inEdges) {
      const types = [...inEdge.dataTypes].join(", ");
      receives.push(`← ${inEdge.fromSection}: ${types}`);
    }
    for (const outEdge of section.outEdges) {
      const types = [...outEdge.dataTypes].join(", ");
      sends.push(`→ ${outEdge.toSection}: ${types}`);
    }

    if (receives.length > 0 || sends.length > 0) {
      lines.push("  Data flow:");
      for (const r of receives) lines.push(`    ${r}`);
      for (const s of sends) lines.push(`    ${s}`);
    }
    lines.push("");
  }

  // Virtual wires (Get/Set)
  if (virtualEdges.length > 0) {
    lines.push("## Virtual Wires (Get/Set)");

    // Group by key
    const wiresByKey = new Map<
      string,
      { setterId: string; getterIds: string[] }
    >();
    for (const ve of virtualEdges) {
      if (!wiresByKey.has(ve.key)) {
        wiresByKey.set(ve.key, { setterId: ve.sourceNodeId, getterIds: [] });
      }
      wiresByKey.get(ve.key)!.getterIds.push(ve.targetNodeId);
    }

    for (const [key, wire] of wiresByKey) {
      // Find what feeds into the SetNode
      const setNode = workflow[wire.setterId];
      let feederInfo = "";
      if (setNode) {
        for (const [, value] of Object.entries(setNode.inputs)) {
          if (isConnection(value)) {
            const feederId = value[0];
            const feederNode = workflow[feederId];
            if (feederNode) {
              const feederSection = nodeToSection.get(feederId) ?? "?";
              feederInfo = ` fed by ${feederId}:${feederNode._meta?.title ?? feederNode.class_type} [${feederSection}]`;
            }
            break;
          }
        }
      }

      // Find what consumes from each GetNode
      const consumers: string[] = [];
      for (const getterId of wire.getterIds) {
        for (const [nodeId, node] of Object.entries(workflow)) {
          for (const [inputName, value] of Object.entries(node.inputs)) {
            if (isConnection(value) && value[0] === getterId) {
              const consumerSection = nodeToSection.get(nodeId) ?? "?";
              consumers.push(
                `${nodeId}:${node._meta?.title ?? node.class_type}.${inputName} [${consumerSection}]`,
              );
            }
          }
        }
      }

      lines.push(
        `  "${key}": Set(${wire.setterId})${feederInfo} → Get(${wire.getterIds.join(", ")})`,
      );
      if (consumers.length > 0) {
        for (const c of consumers) {
          lines.push(`    → ${c}`);
        }
      }
    }
    lines.push("");
  }

  // Connection graph: list all direct node-to-node connections for reference
  lines.push("## Connection Graph");
  const allEdges = extractConnections(workflow);
  for (const edge of allEdges) {
    const sourceNode = workflow[edge.sourceId];
    const targetNode = workflow[edge.targetId];
    if (!sourceNode || !targetNode) continue;

    // Get real output type from object_info
    const def = objectInfo[sourceNode.class_type];
    const outputType =
      def?.output?.[edge.outputIndex] ??
      guessOutputType(sourceNode.class_type, edge.outputIndex) ??
      "?";

    lines.push(
      `  ${edge.sourceId}:${sourceNode.class_type}[${edge.outputIndex}] --${outputType}--> ${edge.targetId}:${targetNode.class_type}.${edge.inputName}`,
    );
  }

  return lines.join("\n");
}
