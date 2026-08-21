// Extended types for ComfyUI operations

export interface ComfyUINodeDef {
  input: {
    required?: Record<string, NodeInputSpec>;
    optional?: Record<string, NodeInputSpec>;
    hidden?: Record<string, NodeInputSpec>;
  };
  input_order?: {
    required?: string[];
    optional?: string[];
  };
  output: string[];
  output_is_list: boolean[];
  output_name: string[];
  name: string;
  display_name: string;
  description: string;
  category: string;
  output_node: boolean;
  python_module?: string;
  /**
   * Set to `true` by ComfyUI's /object_info for hosted partner/API nodes
   * (the server emits this from the node class's `API_NODE` attribute).
   * Authoritative marker for API nodes; the `category` typically also starts
   * with "api node/" (e.g. "api node/image/BFL").
   */
  api_node?: boolean;
  deprecated?: boolean;
  experimental?: boolean;
}

export type NodeInputSpec = [string | string[], Record<string, unknown>?];

export type ObjectInfo = Record<string, ComfyUINodeDef>;

export interface WorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string; mode?: string };
}

export type WorkflowJSON = Record<string, WorkflowNode>;

export interface QueueStatus {
  queue_running: QueueItem[];
  queue_pending: QueueItem[];
}

export type QueueItem = [number, string, Record<string, unknown>, unknown, unknown];

export interface SystemStats {
  system: {
    os: string;
    python_version: string;
    embedded_python: boolean;
    argv?: string[];
    comfyui_version?: string;
    /** Reported by recent ComfyUI, e.g. "2.11.0.dev20260123+cu130". */
    pytorch_version?: string;
    /** Working directory of the running server, when a build reports it. */
    cwd?: string;
    ram_total?: number;
    ram_free?: number;
    /** The frontend version this ComfyUI asked for (panel#779). */
    required_frontend_version?: string;
    /** Installed Python packages ComfyUI reports on, e.g. comfyui-frontend-package. */
    comfy_package_versions?: Array<{ name?: string; installed?: string }>;
  };
  devices: Array<{
    name: string;
    type: string;
    index: number;
    vram_total: number;
    vram_free: number;
    torch_vram_total: number;
    torch_vram_free: number;
  }>;
}

export interface JobResult {
  prompt_id: string;
  images: Array<{
    data: string; // base64
    mime: string;
  }>;
  node_outputs: Record<string, unknown>;
}

export interface JobProgress {
  value: number;
  max: number;
  node?: string;
  prompt_id?: string;
}

// Subgraph / component types (used in workflow definitions)

export interface SubgraphLink {
  id: number;
  origin_id: number;
  origin_slot: number;
  target_id: number;
  target_slot: number;
  type: string;
}

export interface SubgraphInput {
  id: string;
  name: string;
  type: string;
  linkIds: number[];
  localized_name?: string;
  label?: string;
  pos?: [number, number];
}

export interface SubgraphOutput {
  id: string;
  name: string;
  type: string;
  linkIds: number[];
  localized_name?: string;
  label?: string;
  pos?: [number, number];
}

export interface SubgraphDefinition {
  id: string;
  version?: number;
  name: string;
  inputNode: { id: number; bounding?: number[] };
  outputNode: { id: number; bounding?: number[] };
  inputs: SubgraphInput[];
  outputs: SubgraphOutput[];
  widgets?: unknown[];
  nodes: UiNode[];
  links: SubgraphLink[];
  groups?: unknown[];
  state?: Record<string, unknown>;
  revision?: number;
  config?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

// UI format types (what ComfyUI web UI saves)

export interface UiNodeInput {
  name: string;
  type: string;
  link: number | null;
  widget?: { name: string };
  slot_index?: number;
}

export interface UiNodeOutput {
  name: string;
  type: string;
  links: number[] | null;
  slot_index?: number;
}

export interface UiNode {
  id: number;
  type: string;
  pos: [number, number] | { 0: number; 1: number };
  size?: [number, number] | { 0: number; 1: number };
  flags?: Record<string, unknown>;
  order?: number;
  mode?: number; // 0=always, 2=muted, 4=bypassed
  inputs?: UiNodeInput[];
  outputs?: UiNodeOutput[];
  properties?: Record<string, unknown>;
  widgets_values?: unknown[];
  title?: string;
  _meta?: { title?: string };
  /**
   * INTERNAL, never serialized: widget values resolved BY NAME during subgraph
   * expansion — a promoted ("proxy") widget value pushed down from the subgraph
   * node, or a virtual PrimitiveNode's literal baked onto its consumer. Applied
   * by convertUiToApi against object_info, which is authoritative about widget
   * names; carrying them by name avoids the positional guessing that used to
   * drop them or land them on the wrong widget (issue #361).
   */
  resolvedWidgetValues?: Record<string, unknown>;
  /**
   * INTERNAL, never serialized: the panel's AUTHORITATIVE name→value map for this
   * node's widgets, captured from the live canvas alongside the serialized graph
   * (see applyCapturedWidgetValues). When present it REPLACES `widgets_values` as
   * the converter's widget source, which is the whole point: `widgets_values` is a
   * bare positional array whose order is the FRONTEND's, while the converter can
   * only reconstruct an order from object_info's — and for custom nodes that add or
   * reorder widgets in JS the two disagree, silently landing each value on the wrong
   * widget (#961/#955/#361). A name-keyed map has no order to disagree about.
   *
   * It is deliberately a SEPARATE field rather than an object written into
   * `widgets_values`: several call sites legitimately read that array BY INDEX
   * (a subgraph node's proxyWidgets, a PrimitiveNode's literal at [0], a Set/Get
   * node's bus name), and handing them an object would silently drop those values.
   */
  capturedWidgetValues?: Record<string, unknown>;
}

// link: [link_id, source_node_id, source_slot, target_node_id, target_slot, type_name]
export type UiLink = [number, number, number, number, number, string];

export interface UiWorkflow {
  nodes: UiNode[];
  links: UiLink[];
  last_node_id?: number;
  last_link_id?: number;
  version?: number;
  extra?: Record<string, unknown>;
  config?: Record<string, unknown>;
  groups?: unknown[];
  definitions?: {
    subgraphs?: SubgraphDefinition[];
  };
}
