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
