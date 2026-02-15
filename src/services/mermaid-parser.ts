import type {
  WorkflowJSON,
  WorkflowNode,
  ObjectInfo,
  ComfyUINodeDef,
  NodeInputSpec,
} from "../comfyui/types.js";
import { ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// Parsed representation of a mermaid node
interface ParsedNode {
  id: string;
  label: string; // First line: class_type or _meta.title
  values: Record<string, string>; // key:value pairs from the label
}

// Parsed representation of a mermaid edge
interface ParsedEdge {
  sourceId: string;
  targetId: string;
  dataType: string | undefined; // e.g., "MODEL", "CLIP", "LATENT"
}

// Full parse result
interface ParsedMermaid {
  nodes: Map<string, ParsedNode>;
  edges: ParsedEdge[];
  direction: "LR" | "TB";
}

// Result of resolving a mermaid back to a workflow
export interface MermaidToWorkflowResult {
  workflow: WorkflowJSON;
  warnings: string[];
}

/**
 * Parse a mermaid flowchart string into structured nodes and edges.
 */
export function parseMermaid(mermaidText: string): ParsedMermaid {
  // Strip code fence if present
  let text = mermaidText.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:mermaid)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  const lines = text.split("\n").map((l) => l.trim());
  const nodes = new Map<string, ParsedNode>();
  const edges: ParsedEdge[] = [];
  let direction: "LR" | "TB" = "LR";

  for (const line of lines) {
    // Parse direction from flowchart declaration
    const dirMatch = line.match(/^flowchart\s+(LR|TB|TD|RL)$/);
    if (dirMatch) {
      direction = dirMatch[1] === "TD" ? "TB" : (dirMatch[1] as "LR" | "TB");
      continue;
    }

    // Skip subgraph/end/style/linkStyle lines
    if (
      line.startsWith("subgraph ") ||
      line === "end" ||
      line.startsWith("style ") ||
      line.startsWith("linkStyle ") ||
      line === ""
    ) {
      continue;
    }

    // Try to parse as edge: sourceId -->|TYPE| targetId  OR  sourceId --> targetId
    const edgeMatch = line.match(
      /^(\S+)\s+--+>(?:\|([^|]*)\|)?\s*(\S+)$/,
    );
    if (edgeMatch) {
      edges.push({
        sourceId: edgeMatch[1],
        targetId: edgeMatch[3],
        dataType: edgeMatch[2] || undefined,
      });
      continue;
    }

    // Try to parse as node definition with various shapes
    const nodeResult = parseNodeLine(line);
    if (nodeResult) {
      nodes.set(nodeResult.id, nodeResult);
    }
  }

  if (nodes.size === 0) {
    throw new ValidationError(
      "Could not parse any nodes from mermaid text. Expected format: flowchart LR/TB with node definitions.",
    );
  }

  return { nodes, edges, direction };
}

/**
 * Parse a single node definition line.
 * Handles all shape variants:
 *   id["label"]        — rectangle (loading, utility)
 *   id(["label"])       — stadium (conditioning)
 *   id{{"label"}}       — hexagon (sampling)
 *   id("label")         — rounded (image)
 *   id((("label")))     — triple circle (output)
 *   id(("label"))       — double circle
 */
function parseNodeLine(line: string): ParsedNode | null {
  // Match: id followed by shape-wrapped label
  // The id is one or more non-whitespace chars at the start (before the shape opener)
  const patterns = [
    // Triple circle: id((("label")))
    /^(\S+?)\(\(\("(.+?)"\)\)\)$/,
    // Double circle: id(("label"))
    /^(\S+?)\(\("(.+?)"\)\)$/,
    // Hexagon: id{{"label"}}
    /^(\S+?)\{\{"(.+?)"\}\}$/,
    // Stadium: id(["label"])
    /^(\S+?)\(\["(.+?)"\]\)$/,
    // Rounded: id("label")
    /^(\S+?)\("(.+?)"\)$/,
    // Rectangle: id["label"]
    /^(\S+?)\["(.+?)"\]$/,
  ];

  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match) {
      const id = match[1];
      const rawLabel = match[2];
      return parseLabel(id, rawLabel);
    }
  }

  return null;
}

/**
 * Parse the inner label text.
 * Format: "ClassName\nkey:value key2:value2"
 * or: "Title\nkey:value key2:value2"
 */
function parseLabel(id: string, rawLabel: string): ParsedNode {
  // Unescape mermaid HTML entities
  const label = rawLabel.replace(/#quot;/g, '"');

  // Split on literal \n (the escaped newline in mermaid syntax)
  const parts = label.split("\\n");
  const title = parts[0].trim();

  const values: Record<string, string> = {};
  if (parts.length > 1) {
    // The rest is space-separated key:value pairs
    const valuesStr = parts.slice(1).join(" ");
    // Parse key:value pairs. Values can contain colons (filenames like model.safetensors),
    // so we match key up to first colon, then value up to next key or end.
    // Pattern: word chars + colon + value (up to next space-followed-by-word-colon, or end)
    const kvRegex = /(\w+):(.+?)(?=\s+\w+:|$)/g;
    let kvMatch: RegExpExecArray | null;
    while ((kvMatch = kvRegex.exec(valuesStr)) !== null) {
      values[kvMatch[1]] = kvMatch[2].trim();
    }
  }

  return { id, label: title, values };
}

/**
 * Resolve a parsed mermaid graph into a valid ComfyUI workflow JSON
 * using node definitions from /object_info.
 */
export function resolveWorkflow(
  parsed: ParsedMermaid,
  objectInfo: ObjectInfo,
): MermaidToWorkflowResult {
  const workflow: WorkflowJSON = {};
  const warnings: string[] = [];

  // Build lookup: display_name → class_type
  const displayNameMap = new Map<string, string>();
  for (const [className, def] of Object.entries(objectInfo)) {
    if (def.display_name) {
      displayNameMap.set(def.display_name.toLowerCase(), className);
    }
    // Also map the class name itself (case-insensitive)
    displayNameMap.set(className.toLowerCase(), className);
  }

  // Phase 1: Resolve each node's class_type
  const nodeClassTypes = new Map<string, string>();
  for (const [id, node] of parsed.nodes) {
    const resolved = resolveClassType(node.label, objectInfo, displayNameMap);
    if (resolved) {
      nodeClassTypes.set(id, resolved);
    } else {
      // Try inferring from connection data type signature
      const inferred = inferClassTypeFromConnections(
        id,
        parsed.edges,
        objectInfo,
      );
      if (inferred) {
        nodeClassTypes.set(id, inferred);
        logger.info(
          `Node ${id}: Inferred class_type "${inferred}" from connection signature for label "${node.label}"`,
        );
      } else {
        warnings.push(
          `Node ${id}: Could not resolve "${node.label}" to a known ComfyUI node type. Using label as class_type.`,
        );
        nodeClassTypes.set(id, node.label);
      }
    }
  }

  // Phase 2: Create workflow nodes with empty inputs
  for (const [id, node] of parsed.nodes) {
    const classType = nodeClassTypes.get(id)!;
    workflow[id] = {
      class_type: classType,
      inputs: {},
    };

    // If the label differs from class_type, preserve it as _meta.title
    if (node.label !== classType) {
      workflow[id]._meta = { title: node.label };
    }
  }

  // Phase 3: Wire connections using edge data types + object_info
  for (const edge of parsed.edges) {
    const sourceClassType = nodeClassTypes.get(edge.sourceId);
    const targetClassType = nodeClassTypes.get(edge.targetId);

    if (!sourceClassType || !targetClassType) {
      warnings.push(
        `Edge ${edge.sourceId} → ${edge.targetId}: source or target node not found, skipping.`,
      );
      continue;
    }

    const sourceDef = objectInfo[sourceClassType];
    const targetDef = objectInfo[targetClassType];

    if (!sourceDef || !targetDef) {
      warnings.push(
        `Edge ${edge.sourceId} → ${edge.targetId}: missing object_info for ${!sourceDef ? sourceClassType : targetClassType}. Using best guess.`,
      );
      // Best effort: put connection as first matching input
      if (edge.dataType) {
        const inputName = guessInputNameByType(edge.dataType, targetClassType);
        if (inputName) {
          workflow[edge.targetId].inputs[inputName] = [edge.sourceId, 0];
        }
      }
      continue;
    }

    // Find the output index on the source that produces this data type
    let outputIndex = 0;
    if (edge.dataType && sourceDef.output) {
      const idx = sourceDef.output.indexOf(edge.dataType);
      if (idx >= 0) {
        outputIndex = idx;
      } else {
        warnings.push(
          `Edge ${edge.sourceId} → ${edge.targetId}: data type "${edge.dataType}" not found in ${sourceClassType} outputs [${sourceDef.output.join(", ")}]. Using index 0.`,
        );
      }
    }

    // Find the input name on the target that accepts this data type.
    // Use the source node's title as a hint for disambiguation
    // (e.g., "Positive Prompt" → positive, "Negative Prompt" → negative).
    const sourceTitle = parsed.nodes.get(edge.sourceId)?.label ?? "";
    const inputName = findInputForType(
      targetDef,
      edge.dataType,
      workflow[edge.targetId].inputs,
      sourceTitle,
    );

    if (inputName) {
      workflow[edge.targetId].inputs[inputName] = [edge.sourceId, outputIndex];
    } else {
      warnings.push(
        `Edge ${edge.sourceId} → ${edge.targetId}: could not find input on ${targetClassType} that accepts "${edge.dataType}".`,
      );
    }
  }

  // Phase 4: Fill widget values from parsed labels
  for (const [id, node] of parsed.nodes) {
    const classType = nodeClassTypes.get(id)!;
    const def = objectInfo[classType];
    if (!def) continue;

    for (const [key, rawValue] of Object.entries(node.values)) {
      // Don't overwrite connections
      if (isConnectionValue(workflow[id].inputs[key])) continue;

      // Coerce value to the correct type based on objectInfo
      const coerced = coerceValue(key, rawValue, def);
      if (coerced !== undefined) {
        workflow[id].inputs[key] = coerced;
      } else {
        // Fall back to string
        workflow[id].inputs[key] = rawValue;
      }
    }
  }

  // Phase 5: Fill remaining required inputs with defaults from objectInfo
  for (const [id] of parsed.nodes) {
    const classType = nodeClassTypes.get(id)!;
    const def = objectInfo[classType];
    if (!def) continue;

    fillDefaults(workflow[id], def, warnings, id);
  }

  return { workflow, warnings };
}

/**
 * Infer class_type by matching a node's connection signature against all known node types.
 * E.g., a node that receives CLIP and outputs CONDITIONING is very likely CLIPTextEncode.
 */
function inferClassTypeFromConnections(
  nodeId: string,
  edges: ParsedEdge[],
  objectInfo: ObjectInfo,
): string | null {
  // Collect incoming and outgoing data types for this node
  const incomingTypes = new Set<string>();
  const outgoingTypes = new Set<string>();

  for (const edge of edges) {
    if (edge.targetId === nodeId && edge.dataType) {
      incomingTypes.add(edge.dataType);
    }
    if (edge.sourceId === nodeId && edge.dataType) {
      outgoingTypes.add(edge.dataType);
    }
  }

  if (incomingTypes.size === 0 && outgoingTypes.size === 0) return null;

  // Score each node type by how well it matches the signature
  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const [className, def] of Object.entries(objectInfo)) {
    let score = 0;

    // Check outgoing types match outputs
    if (outgoingTypes.size > 0) {
      const outputSet = new Set(def.output);
      for (const t of outgoingTypes) {
        if (outputSet.has(t)) score += 2;
      }
    }

    // Check incoming types match inputs
    if (incomingTypes.size > 0) {
      const allInputs = {
        ...def.input.required,
        ...def.input.optional,
      };
      const inputTypes = new Set(
        Object.values(allInputs).map((spec) =>
          typeof spec[0] === "string" ? spec[0] : "",
        ),
      );
      for (const t of incomingTypes) {
        if (inputTypes.has(t)) score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = className;
    }
  }

  // Require a minimum score to avoid false matches
  return bestScore >= 2 ? bestMatch : null;
}

/**
 * Resolve a label to a known class_type.
 */
function resolveClassType(
  label: string,
  objectInfo: ObjectInfo,
  displayNameMap: Map<string, string>,
): string | null {
  // Direct match against class names
  if (objectInfo[label]) return label;

  // Case-insensitive match
  const lower = label.toLowerCase();
  const fromDisplay = displayNameMap.get(lower);
  if (fromDisplay) return fromDisplay;

  // Fuzzy: try removing spaces (e.g., "Checkpoint Loader Simple" → "CheckpointLoaderSimple")
  const noSpaces = label.replace(/\s+/g, "");
  if (objectInfo[noSpaces]) return noSpaces;

  // Try display name without spaces
  const fromDisplayNoSpaces = displayNameMap.get(noSpaces.toLowerCase());
  if (fromDisplayNoSpaces) return fromDisplayNoSpaces;

  return null;
}

/**
 * Find an input on the target node that accepts the given data type.
 * Avoids assigning to an input that already has a connection.
 * Uses sourceTitle as a hint when multiple inputs accept the same type
 * (e.g., KSampler has both "positive" and "negative" CONDITIONING inputs).
 */
function findInputForType(
  targetDef: ComfyUINodeDef,
  dataType: string | undefined,
  currentInputs: Record<string, unknown>,
  sourceTitle?: string,
): string | null {
  if (!dataType) return null;

  const allInputs = {
    ...targetDef.input.required,
    ...targetDef.input.optional,
  };

  // Collect all matching, unwired inputs
  const candidates: string[] = [];
  for (const [inputName, spec] of Object.entries(allInputs)) {
    if (isConnectionValue(currentInputs[inputName])) continue;

    const acceptedType = spec[0];
    const matches =
      (typeof acceptedType === "string" && acceptedType === dataType) ||
      (Array.isArray(acceptedType) && acceptedType.includes(dataType));
    if (matches) {
      candidates.push(inputName);
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Multiple candidates — use sourceTitle to pick the best match.
  // E.g., title "Positive Prompt" should match input named "positive",
  // and "Negative Prompt" should match "negative".
  if (sourceTitle) {
    const titleLower = sourceTitle.toLowerCase();
    for (const inputName of candidates) {
      if (titleLower.includes(inputName.toLowerCase())) {
        return inputName;
      }
    }
  }

  // Fall back to first available
  return candidates[0];
}

/**
 * Fallback: guess input name from data type for common patterns.
 */
function guessInputNameByType(
  dataType: string,
  _targetClassType: string,
): string | null {
  const typeToInput: Record<string, string> = {
    MODEL: "model",
    CLIP: "clip",
    VAE: "vae",
    CONDITIONING: "positive", // ambiguous but common
    LATENT: "latent_image",
    IMAGE: "images",
    MASK: "mask",
    CONTROL_NET: "control_net",
    UPSCALE_MODEL: "upscale_model",
  };
  return typeToInput[dataType] ?? null;
}

/**
 * Coerce a string value to the expected type based on objectInfo.
 */
function coerceValue(
  key: string,
  rawValue: string,
  def: ComfyUINodeDef,
): unknown {
  const spec = findInputSpec(key, def);
  if (!spec) return undefined;

  const [typeOrEnum, options] = spec;

  // Enum type (array of allowed string values)
  if (Array.isArray(typeOrEnum)) {
    // Return the raw value if it's in the enum, otherwise closest match
    if (typeOrEnum.includes(rawValue)) return rawValue;
    // Try case-insensitive
    const found = typeOrEnum.find(
      (v) => typeof v === "string" && v.toLowerCase() === rawValue.toLowerCase(),
    );
    return found ?? rawValue;
  }

  switch (typeOrEnum) {
    case "INT": {
      const n = Number(rawValue);
      return Number.isFinite(n) ? Math.round(n) : undefined;
    }
    case "FLOAT": {
      const n = Number(rawValue);
      return Number.isFinite(n) ? n : undefined;
    }
    case "BOOLEAN":
      return rawValue === "true" || rawValue === "1";
    case "STRING":
      return rawValue;
    default:
      // Unknown type — might be a connection type like MODEL, CLIP
      // Don't set scalar values for connection types
      return undefined;
  }
}

/**
 * Find the input spec for a given key in a node definition.
 */
function findInputSpec(
  key: string,
  def: ComfyUINodeDef,
): NodeInputSpec | null {
  if (def.input.required?.[key]) return def.input.required[key];
  if (def.input.optional?.[key]) return def.input.optional[key];
  return null;
}

/**
 * Fill required inputs that weren't set by connections or parsed values.
 */
function fillDefaults(
  node: WorkflowNode,
  def: ComfyUINodeDef,
  warnings: string[],
  nodeId: string,
): void {
  const required = def.input.required ?? {};

  for (const [inputName, spec] of Object.entries(required)) {
    // Skip if already set
    if (node.inputs[inputName] !== undefined) continue;

    const [typeOrEnum, options] = spec;

    // Connection types (MODEL, CLIP, etc.) — can't fill with defaults, skip
    if (
      typeof typeOrEnum === "string" &&
      typeOrEnum === typeOrEnum.toUpperCase() &&
      typeOrEnum.length > 1 &&
      !["INT", "FLOAT", "STRING", "BOOLEAN"].includes(typeOrEnum)
    ) {
      continue;
    }

    // Enum: use first option as default
    if (Array.isArray(typeOrEnum) && typeOrEnum.length > 0) {
      node.inputs[inputName] = typeOrEnum[0];
      continue;
    }

    // Use explicit default if available
    if (options && "default" in options) {
      node.inputs[inputName] = options.default;
      continue;
    }

    // No default available
    logger.debug(
      `Node ${nodeId} (${node.class_type}): required input "${inputName}" has no value or default`,
    );
  }

  // Also fill optional inputs that have defaults (for completeness)
  const optional = def.input.optional ?? {};
  for (const [inputName, spec] of Object.entries(optional)) {
    if (node.inputs[inputName] !== undefined) continue;
    const [, options] = spec;
    if (options && "default" in options) {
      node.inputs[inputName] = options.default;
    }
  }
}

function isConnectionValue(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "number"
  );
}
