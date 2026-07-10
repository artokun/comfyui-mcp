import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { workflowToDsl, dslToWorkflow } from "../services/workflow-dsl.js";
import { isTypeCompatible, type SlotType } from "../services/slot-compat.js";
import { getObjectInfo } from "../comfyui/client.js";
import type { ObjectInfo, WorkflowJSON } from "../comfyui/types.js";
import { errorToToolResult } from "../utils/errors.js";

/** A connection input value: [sourceNodeId, outputIndex], where the source id exists in the graph. */
function isConnection(value: unknown, workflow: WorkflowJSON): value is [string, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "number" &&
    Number.isInteger(value[1]) &&
    Object.prototype.hasOwnProperty.call(workflow, value[0])
  );
}

/** Declared type of a node input `key` from /object_info (string, COMBO array, or undefined if absent). */
function declaredInputType(def: ObjectInfo[string], key: string): SlotType | undefined {
  const spec = def.input?.required?.[key] ?? def.input?.optional?.[key];
  if (!Array.isArray(spec)) return undefined;
  const type = spec[0];
  return typeof type === "string" || Array.isArray(type) ? type : undefined;
}

function fmtType(t: SlotType): string {
  return Array.isArray(t) ? "COMBO" : t;
}

/**
 * Advisory wiring checks for a parsed DSL graph against a live /object_info map.
 * Read-only: returns human-readable warnings; NEVER throws for graph content.
 * Uses the shared slot-compat rules so it agrees with the panel's connect resolver.
 */
export function computeWiringWarnings(workflow: WorkflowJSON, objectInfo: ObjectInfo): string[] {
  const warnings: string[] = [];
  for (const [id, node] of Object.entries(workflow)) {
    const def = objectInfo[node.class_type];
    if (!def) {
      warnings.push(`unknown class_type "${node.class_type}"`);
      continue;
    }
    for (const [key, value] of Object.entries(node.inputs ?? {})) {
      if (!isConnection(value, workflow)) continue;
      const [srcId, idx] = value;
      const srcNode = workflow[srcId];
      const srcDef = objectInfo[srcNode.class_type];
      if (!srcDef) continue; // source class unknown — already flagged on that node
      const outputs = srcDef.output ?? [];
      if (idx < 0 || idx >= outputs.length) {
        warnings.push(
          `output index ${idx} out of range for ${srcNode.class_type} (${outputs.length} outputs: ${outputs.join(", ")})`,
        );
        continue;
      }
      const inType = declaredInputType(def, key);
      if (inType === undefined) continue; // unknown input key — not our concern here
      const outType = outputs[idx];
      if (!isTypeCompatible(outType, inType)) {
        warnings.push(`type mismatch: ${srcId}.${idx} (${fmtType(outType)}) → ${id}.${key} (${fmtType(inType)})`);
      }
    }
  }
  return warnings;
}

/**
 * Parse a DSL string, then — only when ComfyUI is reachable — attach advisory
 * wiring warnings. ComfyUI being offline/unreachable is swallowed silently so
 * the conversion is identical to the offline path (no warnings). The conversion
 * NEVER fails because of warnings.
 */
export async function dslToWorkflowWithWarnings(
  dsl: string,
): Promise<{ workflow: WorkflowJSON; warnings: string[] }> {
  const workflow = dslToWorkflow(dsl);
  let warnings: string[] = [];
  try {
    const objectInfo = await getObjectInfo();
    warnings = computeWiringWarnings(workflow, objectInfo);
  } catch {
    // ComfyUI offline/unreachable — advisory warnings are best-effort; skip silently.
  }
  return { workflow, warnings };
}

export function registerWorkflowDslTools(server: McpServer): void {
  server.tool(
    "workflow_to_dsl",
    "Convert a ComfyUI API-format workflow into a compact, human/LLM-readable DSL — easier to read and edit than raw JSON, and round-trips losslessly back via dsl_to_workflow. Connections render as `key <- nodeId.outputIndex`, literals as `key = <JSON>`. (Experimental.)",
    {
      workflow: z
        .record(z.string(), z.any())
        .describe("ComfyUI workflow in API format (node ID -> {class_type, inputs})"),
    },
    async ({ workflow }) => {
      try {
        return { content: [{ type: "text" as const, text: workflowToDsl(workflow) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "dsl_to_workflow",
    "Convert the compact workflow DSL (see workflow_to_dsl) back into executable ComfyUI API-format JSON. Useful for authoring/editing workflows in the legible DSL, then converting to run with enqueue_workflow. When ComfyUI is reachable, the result also carries advisory `warnings` (unknown class_type, output index out of range, type mismatches) — the conversion still succeeds regardless. (Experimental.)",
    {
      dsl: z.string().describe("Workflow DSL text"),
    },
    async ({ dsl }) => {
      try {
        const { workflow, warnings } = await dslToWorkflowWithWarnings(dsl);
        const content = [{ type: "text" as const, text: JSON.stringify(workflow, null, 2) }];
        if (warnings.length > 0) {
          content.push({
            type: "text" as const,
            text: `Advisory wiring warnings (conversion still succeeded):\n${warnings.map((w) => `- ${w}`).join("\n")}`,
          });
        }
        return { content };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
