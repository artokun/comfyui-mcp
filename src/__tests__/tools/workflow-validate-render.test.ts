import { describe, expect, it, beforeEach, vi } from "vitest";

// Render-layer regression for #342 / #505: the tool must DERIVE its "ready to
// execute" verdict from the surfaced errors and must NOT mask authoritative
// combo/enum/model errors (which carry `kind`) behind "No issues found".
const validateWorkflowMock = vi.fn();
vi.mock("../../services/workflow-validator.js", () => ({
  validateWorkflow: (...a: unknown[]) => validateWorkflowMock(...a),
}));

// 0.50.0 slice 14: this rendering no longer registers a tool of its own — it is
// create_workflow (action:"validate"). The render is exercised through the
// exported action body rather than through a registrar, so these cases stay
// about the RENDER; the dispatch that reaches it is covered by
// src/__tests__/tools/workflow-compose.test.ts.
import { validateWorkflowAction } from "../../tools/workflow-validate.js";
import type { ValidationResult } from "../../services/workflow-validator.js";

const run = async (result: ValidationResult): Promise<string> => {
  validateWorkflowMock.mockResolvedValue(result);
  const out = await validateWorkflowAction({
    workflow: { "1": { class_type: "SaveImage", inputs: {} } },
  });
  return out.content.map((c) => c.text).join("\n");
};

beforeEach(() => {
  validateWorkflowMock.mockReset();
});

describe("create_workflow action:\"validate\" render — verdict is derived from errors (#342)", () => {
  it("never says 'ready to execute' when the result is invalid with a real error", async () => {
    const text = await run({
      valid: false,
      summary: "Workflow has 1 error(s) and 0 warning(s)",
      issues: [
        {
          severity: "error",
          node_id: "1",
          node_type: "KSampler",
          message: "Missing required input \"model\"",
        },
      ],
    });
    expect(text).toContain("Workflow has 1 error(s)");
    expect(text).not.toContain("ready to execute");
    // The error itself must be listed, not hidden.
    expect(text).toContain("### Errors");
    expect(text).toContain('Missing required input "model"');
  });

  it("a genuinely-valid workflow says ready to execute with no error section", async () => {
    const text = await run({
      valid: true,
      summary: "Workflow is valid",
      issues: [],
    });
    expect(text).toContain("ready to execute");
    expect(text).not.toContain("### Errors");
  });
});

describe("create_workflow action:\"validate\" render — authoritative combo errors are surfaced (#505)", () => {
  it("surfaces a value_not_in_list combo error (which carries `kind`) in the Errors section", async () => {
    const text = await run({
      valid: false,
      summary: "Workflow has 1 error(s) and 0 warning(s)",
      issues: [
        {
          severity: "error",
          node_id: "1",
          node_type: "CLIPLoader",
          kind: "value_not_in_list",
          input: "type",
          value: "gemma",
          message: '"type" = "gemma" is not in the list of valid options (value_not_in_list).',
        },
      ],
    });
    expect(text).toContain("### Errors");
    expect(text).toContain("value_not_in_list");
    // Must NOT be masked behind the "No issues found" summary.
    expect(text).not.toContain("No issues found");
    expect(text).not.toContain("ready to execute");
  });

  it("surfaces a missing_model error (carries `kind`) rather than claiming no issues", async () => {
    const text = await run({
      valid: false,
      summary: "Workflow has 1 error(s) and 0 warning(s)",
      issues: [
        {
          severity: "error",
          node_id: "2",
          node_type: "UNETLoader",
          kind: "missing_model",
          input: "unet_name",
          value: "missing.gguf",
          message: '"unet_name" = "missing.gguf" is not in the list of valid options.',
        },
      ],
    });
    expect(text).toContain("missing.gguf");
    expect(text).not.toContain("No issues found");
  });

  it("keeps graph-health findings (health:true) out of Errors but still shows the health section", async () => {
    const text = await run({
      valid: true,
      summary: "Workflow is valid",
      issues: [
        {
          severity: "info",
          node_id: "3",
          node_type: "LoadImage",
          kind: "disconnected",
          health: true,
          message: "Node 3 is disconnected from any output",
        },
      ],
      health: {
        summary: "1 heuristic finding",
        findings: [
          {
            severity: "info",
            kind: "disconnected",
            heuristic: true,
            detail: "Node 3 is disconnected from any output",
            node_ids: ["3"],
            node_type: "LoadImage",
          },
        ],
      } as never,
    });
    // Health issue is NOT surfaced as an error, and the valid verdict holds.
    expect(text).not.toContain("### Errors");
    expect(text).toContain("ready to execute");
    expect(text).toContain("### Graph health");
  });
});

describe('create_workflow action:"validate" render -- a health WARNING is not "No issues found" (#2678)', () => {
  // The reported graph validated clean and executed with no error, then rendered a
  // flat field. If the verdict line still reads "No issues found. The workflow is
  // ready to execute." above the warning that says so, the finding is shipped dormant:
  // the caller stops reading at line 3.
  const withHealthWarning = (severity: "warning" | "info"): ValidationResult =>
    ({
      valid: true,
      summary: `Workflow is valid with ${severity === "warning" ? 1 : 0} warning(s)`,
      issues: [
        {
          severity,
          node_id: "9",
          node_type: "KSampler",
          kind: "partial_denoise_empty_latent",
          health: true,
          message: "Node 9 (KSampler) runs denoise=0.65 on a latent taken straight from node 8 (EmptyLatentImage)",
        },
      ],
      health: {
        summary: "5 nodes, 5 types",
        findings: [
          {
            severity,
            kind: "partial_denoise_empty_latent",
            detail:
              "Node 9 (KSampler) runs denoise=0.65 on a latent taken straight from node 8 (EmptyLatentImage), which emits an EMPTY latent.",
            node_ids: ["9", "8"],
            node_type: "KSampler",
          },
        ],
      },
    }) as never;

  it("does not claim 'No issues found' when a graph-health warning is present", async () => {
    const text = await run(withHealthWarning("warning"));
    expect(text).not.toContain("No issues found");
    expect(text).not.toContain("ready to execute");
    // It must still be honest that ComfyUI will accept and run the graph...
    expect(text).toContain("No blocking errors");
    // ...and point at the section that explains why that is not the same as correct.
    expect(text).toMatch(/1 graph-health warning/);
    expect(text).toContain("### Graph health");
    expect(text).toContain("EmptyLatentImage");
  });

  it("leaves the plain ready-to-execute wording alone for an INFO-level finding", async () => {
    const text = await run(withHealthWarning("info"));
    expect(text).toContain("No issues found. The workflow is ready to execute.");
    expect(text).toContain("### Graph health");
  });

  it("still says ready to execute for a genuinely clean graph with no health findings", async () => {
    const text = await run({
      valid: true,
      summary: "Workflow is valid",
      issues: [],
      health: { summary: "3 nodes, 3 types", findings: [] } as never,
    });
    expect(text).toContain("No issues found. The workflow is ready to execute.");
  });
});
