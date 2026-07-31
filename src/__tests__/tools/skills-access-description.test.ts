import { describe, expect, it } from "vitest";
import { registerSkillsAccessTools } from "../../tools/skills-access.js";

// Capture the (name, description) pairs a tool-registration function emits by
// passing a minimal stub that records server.tool(name, description, ...) calls.
function captureToolDescriptions(
  register: (server: { tool: (...args: unknown[]) => void }) => void,
): Map<string, string> {
  const descriptions = new Map<string, string>();
  register({
    tool: (...args: unknown[]) => {
      const [name, description] = args;
      if (typeof name === "string" && typeof description === "string") {
        descriptions.set(name, description);
      }
    },
  });
  return descriptions;
}

describe("list_workflow_templates description (#359 — no core-template overclaim)", () => {
  const descriptions = captureToolDescriptions(registerSkillsAccessTools as never);
  const desc = descriptions.get("list_workflow_templates") ?? "";

  it("registers the tool with a description", () => {
    expect(desc.length).toBeGreaterThan(0);
  });

  it("accurately states it lists custom-node-contributed templates", () => {
    expect(desc).toContain("CUSTOM-NODE");
    expect(desc).toContain("/api/workflow_templates");
  });

  it("does NOT claim to list ComfyUI's own core / bundled package templates", () => {
    // The old wording promised "the comfyui-workflow-templates package + any
    // custom-node-provided templates" — an overclaim, since /api/workflow_templates
    // only returns custom-node example_workflows.
    expect(desc).not.toContain("OFFICIAL ComfyUI workflow templates available");
    expect(desc).not.toContain("comfyui-workflow-templates package + any");
    // It must explicitly flag the scope limit so agents don't conclude "no
    // official template exists" from an empty result.
    expect(desc.toLowerCase()).toContain("does not include");
    expect(desc).toContain("core");
  });
});
