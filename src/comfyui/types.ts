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
}

export type NodeInputSpec = [string | string[], Record<string, unknown>?];

export type ObjectInfo = Record<string, ComfyUINodeDef>;

export interface WorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
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
}

// link: [link_id, source_node_id, source_slot, target_node_id, target_slot, type_name]
export type UiLink = [number, number, number, number, number, string];

export interface UiWorkflow {
  nodes: UiNode[];
  links: UiLink[];
  version?: number;
  extra?: Record<string, unknown>;
  config?: Record<string, unknown>;
  groups?: unknown[];
}
