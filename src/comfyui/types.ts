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
