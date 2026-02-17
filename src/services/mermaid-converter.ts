import type { WorkflowJSON, WorkflowNode } from "../comfyui/types.js";

export type NodeCategory =
  | "loading"
  | "conditioning"
  | "sampling"
  | "image"
  | "output"
  | "utility";

interface MermaidOptions {
  showValues?: boolean;
  direction?: "LR" | "TB";
}

export interface ConnectionEdge {
  sourceId: string;
  outputIndex: number;
  targetId: string;
  inputName: string;
}

const CATEGORY_MATCHERS: Array<{ category: NodeCategory; test: (ct: string) => boolean }> = [
  { category: "output", test: (ct) => ct === "SaveImage" || ct === "PreviewImage" },
  {
    category: "loading",
    test: (ct) =>
      ct.startsWith("CheckpointLoader") ||
      ct.startsWith("CLIPLoader") ||
      ct.startsWith("VAELoader") ||
      ct.startsWith("LoraLoader") ||
      ct.startsWith("ControlNetLoader"),
  },
  {
    category: "conditioning",
    test: (ct) =>
      ct === "CLIPTextEncode" ||
      ct === "ConditioningCombine" ||
      ct === "ConditioningSetArea" ||
      ct === "ControlNetApply",
  },
  {
    category: "sampling",
    test: (ct) => ct.startsWith("KSampler") || ct === "SamplerCustom",
  },
  {
    category: "image",
    test: (ct) =>
      ct === "VAEDecode" ||
      ct === "VAEEncode" ||
      ct === "LoadImage" ||
      ct.startsWith("ImageScale") ||
      ct.startsWith("ImageUpscale"),
  },
];

function categorizeNode(classType: string): NodeCategory {
  for (const matcher of CATEGORY_MATCHERS) {
    if (matcher.test(classType)) return matcher.category;
  }
  return "utility";
}

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  loading: "Loading",
  conditioning: "Conditioning",
  sampling: "Sampling",
  image: "Image",
  output: "Output",
  utility: "Utility",
};

// Mermaid shapes per category
export function wrapNodeLabel(id: string, label: string, category: NodeCategory): string {
  switch (category) {
    case "sampling":
      return `${id}{{"${label}"}}`;
    case "conditioning":
      return `${id}(["${label}"])`;
    case "loading":
      return `${id}["${label}"]`;
    case "image":
      return `${id}("${label}")`;
    case "output":
      return `${id}((("${label}")))`;
    case "utility":
    default:
      return `${id}["${label}"]`;
  }
}

// Color mapping for connection data types
export const TYPE_COLORS: Record<string, string> = {
  MODEL: "blue",
  LATENT: "red",
  CONDITIONING: "orange",
  IMAGE: "green",
  CLIP: "purple",
  VAE: "teal",
};

export function isConnection(value: unknown): value is [string, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "number"
  );
}

// Values worth showing in node labels
export const DISPLAY_VALUES = new Set([
  "seed",
  "steps",
  "cfg",
  "denoise",
  "sampler_name",
  "scheduler",
  "width",
  "height",
  "ckpt_name",
  "text",
  "upscale_model",
  "image",
]);

export function buildNodeLabel(
  node: WorkflowNode,
  showValues: boolean,
): string {
  const title = node._meta?.title ?? node.class_type;
  if (!showValues) return title;

  const parts: string[] = [];
  for (const [key, value] of Object.entries(node.inputs)) {
    if (isConnection(value)) continue;
    if (!DISPLAY_VALUES.has(key)) continue;

    let display: string;
    if (typeof value === "string") {
      // Truncate long strings (prompts, filenames)
      display = value.length > 30 ? value.slice(0, 27) + "..." : value;
    } else {
      display = String(value);
    }
    parts.push(`${key}:${display}`);
  }

  if (parts.length === 0) return title;
  return `${title}<br/>${parts.join(" ")}`;
}

export function extractConnections(workflow: WorkflowJSON): ConnectionEdge[] {
  const edges: ConnectionEdge[] = [];
  for (const [targetId, node] of Object.entries(workflow)) {
    for (const [inputName, value] of Object.entries(node.inputs)) {
      if (isConnection(value)) {
        edges.push({
          sourceId: value[0],
          outputIndex: value[1],
          targetId,
          inputName,
        });
      }
    }
  }
  return edges;
}

export function guessOutputType(
  classType: string,
  outputIndex: number,
): string {
  // Common patterns from ComfyUI node definitions
  const outputMap: Record<string, string[]> = {
    CheckpointLoaderSimple: ["MODEL", "CLIP", "VAE"],
    "CheckpointLoader|simple": ["MODEL", "CLIP", "VAE"],
    LoraLoader: ["MODEL", "CLIP"],
    CLIPTextEncode: ["CONDITIONING"],
    KSampler: ["LATENT"],
    KSamplerAdvanced: ["LATENT"],
    SamplerCustom: ["LATENT"],
    VAEDecode: ["IMAGE"],
    VAEEncode: ["LATENT"],
    EmptyLatentImage: ["LATENT"],
    LoadImage: ["IMAGE", "MASK"],
    ImageUpscaleWithModel: ["IMAGE"],
    ImageScale: ["IMAGE"],
    SaveImage: [],
    PreviewImage: [],
    SetLatentNoiseMask: ["LATENT"],
    UpscaleModelLoader: ["UPSCALE_MODEL"],
    ConditioningCombine: ["CONDITIONING"],
    ControlNetLoader: ["CONTROL_NET"],
    ControlNetApply: ["CONDITIONING"],
    CLIPLoader: ["CLIP"],
    VAELoader: ["VAE"],
  };

  const outputs = outputMap[classType];
  if (outputs && outputIndex < outputs.length) {
    return outputs[outputIndex];
  }
  return "";
}

export function escapeForMermaid(str: string): string {
  return str.replace(/"/g, "#quot;");
}

export function convertToMermaid(
  workflow: WorkflowJSON,
  options: MermaidOptions = {},
): string {
  const { showValues = true, direction = "LR" } = options;
  const lines: string[] = [`flowchart ${direction}`];

  // Group nodes by category
  const groups = new Map<NodeCategory, Array<{ id: string; node: WorkflowNode }>>();
  for (const [id, node] of Object.entries(workflow)) {
    const cat = categorizeNode(node.class_type);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push({ id, node });
  }

  // Emit subgraphs in a stable order
  const categoryOrder: NodeCategory[] = [
    "loading",
    "conditioning",
    "sampling",
    "image",
    "output",
    "utility",
  ];

  for (const cat of categoryOrder) {
    const nodes = groups.get(cat);
    if (!nodes || nodes.length === 0) continue;

    lines.push(`  subgraph ${CATEGORY_LABELS[cat]}`);
    for (const { id, node } of nodes) {
      const label = escapeForMermaid(buildNodeLabel(node, showValues));
      lines.push(`    ${wrapNodeLabel(id, label, cat)}`);
    }
    lines.push("  end");
  }

  // Emit edges
  const edges = extractConnections(workflow);
  for (const edge of edges) {
    const sourceNode = workflow[edge.sourceId];
    const dataType = sourceNode
      ? guessOutputType(sourceNode.class_type, edge.outputIndex)
      : "";

    const color = dataType ? TYPE_COLORS[dataType] : undefined;
    const labelPart = dataType ? `|${dataType}|` : "";

    if (color) {
      lines.push(`  ${edge.sourceId} -->${labelPart} ${edge.targetId}`);
    } else {
      lines.push(`  ${edge.sourceId} --> ${edge.targetId}`);
    }
  }

  // Add style classes for colored edges
  const usedTypes = new Set(
    edges
      .map((e) => {
        const src = workflow[e.sourceId];
        return src ? guessOutputType(src.class_type, e.outputIndex) : "";
      })
      .filter(Boolean),
  );

  if (usedTypes.size > 0) {
    lines.push("");
    for (const t of usedTypes) {
      const color = TYPE_COLORS[t];
      if (color) {
        lines.push(`  linkStyle default stroke:${color}`);
        break; // mermaid linkStyle default applies to all; skip individual for simplicity
      }
    }
  }

  return lines.join("\n");
}
