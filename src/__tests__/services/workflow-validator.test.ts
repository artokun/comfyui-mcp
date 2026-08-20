import { describe, expect, it, beforeEach, vi } from "vitest";

// validateWorkflow reaches ComfyUI only through getObjectInfo — mock it to feed a
// deterministic node catalog so we can exercise the combo (value_not_in_list) logic.
const getObjectInfoMock = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: (...a: unknown[]) => getObjectInfoMock(...a),
}));

import { validateWorkflow } from "../../services/workflow-validator.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

// Minimal /object_info: a CLIPLoader with a MODEL combo + a non-model `type` combo,
// a UNETLoader whose model list is EMPTY (nothing installed), and a SaveImage output.
const OBJECT_INFO = {
  CLIPLoader: {
    input: {
      required: {
        clip_name: [["good_clip.safetensors", "other.safetensors"], {}],
        type: [["qwen_image", "lumina2", "sdxl"], {}],
      },
    },
    output: ["CLIP"],
  },
  UNETLoader: {
    input: { required: { unet_name: [[], {}], weight_dtype: [["default", "fp8"], {}] } },
    output: ["MODEL"],
  },
  SaveImage: { input: { required: {} }, output: [], output_node: true },
} as const;

beforeEach(() => {
  getObjectInfoMock.mockReset();
  getObjectInfoMock.mockResolvedValue(OBJECT_INFO);
});

const wf = (nodes: Record<string, { class_type: string; inputs: Record<string, unknown> }>) =>
  nodes as unknown as WorkflowJSON;

describe("validateWorkflow — combo value_not_in_list parity with the ComfyUI frontend", () => {
  it("flags a non-model combo value that isn't in the list as an ERROR (with valid options)", async () => {
    const r = await validateWorkflow(
      wf({
        "1": { class_type: "CLIPLoader", inputs: { clip_name: "good_clip.safetensors", type: "gemma" } },
        "9": { class_type: "SaveImage", inputs: {} },
      }),
    );
    const typeErr = r.issues.find((i) => i.node_id === "1" && /"type"/.test(i.message));
    expect(typeErr?.severity).toBe("error");
    expect(typeErr?.message).toMatch(/value_not_in_list/);
    expect(typeErr?.message).toMatch(/qwen_image/); // surfaces the valid options
    expect(r.valid).toBe(false);
  });

  it("flags a missing MODEL as an error with a download hint (not just a warning)", async () => {
    const r = await validateWorkflow(
      wf({
        "1": { class_type: "CLIPLoader", inputs: { clip_name: "missing.safetensors", type: "qwen_image" } },
        "9": { class_type: "SaveImage", inputs: {} },
      }),
    );
    const err = r.issues.find((i) => i.node_id === "1" && /clip_name/.test(i.message));
    expect(err?.severity).toBe("error");
    expect(err?.message).toMatch(/isn't installed|download/i);
  });

  it("flags any value against an EMPTY option list (the 'nothing installed → not in []' case)", async () => {
    const r = await validateWorkflow(
      wf({
        "2": { class_type: "UNETLoader", inputs: { unet_name: "z_image_turbo_bf16.safetensors", weight_dtype: "default" } },
        "9": { class_type: "SaveImage", inputs: {} },
      }),
    );
    const err = r.issues.find((i) => i.node_id === "2" && /unet_name/.test(i.message));
    expect(err?.severity).toBe("error");
    expect(err?.message).toMatch(/value_not_in_list/);
  });

  it("passes a fully valid combo graph (no value_not_in_list issues)", async () => {
    const r = await validateWorkflow(
      wf({
        "1": { class_type: "CLIPLoader", inputs: { clip_name: "good_clip.safetensors", type: "qwen_image" } },
        "9": { class_type: "SaveImage", inputs: {} },
      }),
    );
    expect(r.issues.filter((i) => /value_not_in_list/.test(i.message))).toHaveLength(0);
    expect(r.valid).toBe(true);
  });

  it("skips a combo fed by a CONNECTION (can't validate a linked value statically)", async () => {
    const r = await validateWorkflow(
      wf({
        "1": { class_type: "CLIPLoader", inputs: { clip_name: ["3", 0], type: "qwen_image" } },
        "3": { class_type: "CLIPLoader", inputs: { clip_name: "good_clip.safetensors", type: "qwen_image" } },
        "9": { class_type: "SaveImage", inputs: {} },
      }),
    );
    expect(r.issues.find((i) => i.node_id === "1" && /clip_name/.test(i.message))).toBeUndefined();
  });
});

describe("validateWorkflow — COMFY_AUTOGROW_V3 required inputs", () => {
  const autogrowObjectInfo = {
    PrimitiveInt: {
      input: { required: { value: ["INT", { default: 0 }] } },
      output: ["INT"],
    },
    ComfyMathExpression: {
      input: {
        required: {
          expression: ["STRING", { default: "a + b" }],
          values: ["COMFY_AUTOGROW_V3", { min: 1 }],
        },
      },
      output: ["FLOAT", "INT", "BOOLEAN"],
    },
  } as const;

  it("accepts dotted child entries without a separate parent value", async () => {
    getObjectInfoMock.mockResolvedValue(autogrowObjectInfo);
    const r = await validateWorkflow(
      wf({
        "1": { class_type: "PrimitiveInt", inputs: { value: 8 } },
        "2": {
          class_type: "ComfyMathExpression",
          inputs: { expression: "a / 2", "values.a": ["1", 0] },
        },
      }),
      { health: false },
    );
    expect(r.issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
    expect(r.valid).toBe(true);
  });

  it("still reports a missing required AUTOGROW input when it has no children", async () => {
    getObjectInfoMock.mockResolvedValue(autogrowObjectInfo);
    const r = await validateWorkflow(
      wf({
        "2": { class_type: "ComfyMathExpression", inputs: { expression: "a / 2" } },
      }),
      { health: false },
    );
    expect(r.issues).toContainEqual(
      expect.objectContaining({
        node_id: "2",
        message: 'Missing required input "values"',
      }),
    );
    expect(r.valid).toBe(false);
  });
});

describe("validateWorkflow — graph-health merge", () => {
  it("merges health findings (warning/info) without flipping `valid` and returns a health section", async () => {
    // Combo-clean graph, but structurally an isolated CLIPLoader (nothing reads it).
    const r = await validateWorkflow(
      wf({
        "1": { class_type: "CLIPLoader", inputs: { clip_name: "good_clip.safetensors", type: "qwen_image" } },
        "9": { class_type: "SaveImage", inputs: {} },
      }),
    );
    // No hard errors → still valid despite the health warning.
    expect(r.valid).toBe(true);
    expect(r.health).toBeDefined();
    const healthIssues = r.issues.filter((i) => i.kind);
    expect(healthIssues.length).toBeGreaterThan(0);
    // The disconnected finding is present and tagged with its kind.
    expect(r.issues.some((i) => i.kind === "disconnected" && i.node_id === "1")).toBe(true);
    // valid stays errors-only: no health issue is an error.
    expect(r.issues.filter((i) => i.kind && i.severity === "error")).toHaveLength(0);
  });

  it("omits the health section when health:false", async () => {
    const r = await validateWorkflow(
      wf({
        "1": { class_type: "CLIPLoader", inputs: { clip_name: "good_clip.safetensors", type: "qwen_image" } },
        "9": { class_type: "SaveImage", inputs: {} },
      }),
      { health: false },
    );
    expect(r.health).toBeUndefined();
    expect(r.issues.some((i) => i.kind)).toBe(false);
  });
});

// #1869 — create_workflow (action:"validate") on a saved UI graph used to report
// false type/enum errors because action-button tokens serialized into
// widgets_values were paired against /object_info from slot 0.
describe("validateWorkflow — UI graph with serialized action buttons (#1869)", () => {
  const AM_OBJECT_INFO = {
    AMVideoRead: {
      input: {
        required: {
          file_path: ["STRING", { default: "" }],
          frame_mode: [["single", "range", "all"], { default: "all" }],
          first_frame: ["INT", { default: 1 }],
          last_frame: ["INT", { default: -1 }],
        },
      },
      output: ["IMAGE"],
      output_node: true,
    },
  } as const;

  const FILE_PATH = "D:/shots/plate.mov";
  const uiWorkflow = {
    nodes: [
      {
        id: 1,
        type: "AMVideoRead",
        mode: 0,
        inputs: [],
        outputs: [{ name: "IMAGE", type: "IMAGE", links: null }],
        widgets_values: [
          "browse",
          "open_in_explorer",
          "copy_path",
          FILE_PATH,
          "range",
          "detect_range",
          12,
          48,
        ],
      },
    ],
    links: [],
  } as unknown as WorkflowJSON;

  it("does not report action-button tokens as combo/enum errors", async () => {
    getObjectInfoMock.mockResolvedValue(AM_OBJECT_INFO);
    const r = await validateWorkflow(uiWorkflow, { health: false });
    const text = r.issues.map((i) => i.message).join("\n");
    expect(text).not.toMatch(/open_in_explorer/);
    expect(text).not.toMatch(/copy_path/);
    expect(text).not.toMatch(/detect_range/);
    expect(r.issues.filter((i) => i.kind === "value_not_in_list")).toHaveLength(0);
    expect(r.issues.filter((i) => i.severity === "error")).toHaveLength(0);
    expect(r.valid).toBe(true);
  });
});
