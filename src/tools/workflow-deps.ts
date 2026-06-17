import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import {
  extractWorkflowDependencies,
  installWorkflowDependencies,
  defaultWorkflowDepsDeps,
} from "../services/workflow-deps.js";
import { errorToToolResult, ValidationError } from "../utils/errors.js";

function parseWorkflow(input: unknown): WorkflowJSON {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ValidationError("Workflow JSON must be an object with node IDs as keys");
      }
      return parsed as WorkflowJSON;
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(`Invalid JSON string: ${(err as Error).message}`);
    }
  }
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as WorkflowJSON;
  }
  throw new ValidationError("Workflow must be a JSON string or object");
}

export function registerWorkflowDepsTools(server: McpServer): void {
  server.tool(
    "extract_workflow_dependencies",
    "Analyze a ComfyUI workflow (API JSON) and determine which custom node packs it requires. " +
      "Maps each node class_type to its owning node pack using ComfyUI-Manager mappings and the " +
      "server's installed node definitions, reporting which packs are installed vs missing. " +
      "Works remotely (HTTP only) — mirrors `comfy-cli node deps-in-workflow`.",
    {
      workflow: z
        .union([z.string(), z.record(z.string(), z.any())])
        .describe("ComfyUI workflow in API format (JSON string or object)"),
    },
    async (args) => {
      try {
        const workflow = parseWorkflow(args.workflow);
        const result = await extractWorkflowDependencies(workflow, defaultWorkflowDepsDeps());

        const lines: string[] = [];
        lines.push(
          `## Workflow dependencies (${result.classTypes.length} node type(s))`,
          "",
        );

        if (result.requiredPacks.length === 0) {
          lines.push("All node types are core/built-in ComfyUI nodes. No custom node packs required.");
        } else {
          lines.push(`### Required custom node packs (${result.requiredPacks.length})`);
          for (const pack of result.requiredPacks) {
            const missing = result.missingPacks.includes(pack);
            lines.push(`- ${pack}${missing ? "  — **NOT INSTALLED**" : "  — installed"}`);
          }
          lines.push("");
        }

        if (result.missingPacks.length > 0) {
          lines.push(
            `### Missing packs (${result.missingPacks.length})`,
            ...result.missingPacks.map((p) => `- ${p}`),
            "",
            "Run `install_workflow_dependencies` to install them on the connected ComfyUI via ComfyUI-Manager.",
            "",
          );
        }

        if (result.unresolved.length > 0) {
          lines.push(
            `### Unresolved node types (${result.unresolved.length})`,
            "These class_types are neither installed nor known to ComfyUI-Manager:",
            ...result.unresolved.map((c) => `- ${c}`),
            "",
          );
        }

        lines.push("### Per-node mapping");
        for (const dep of result.dependencies) {
          const where = dep.builtin
            ? "built-in"
            : dep.pack
              ? `${dep.pack} (${dep.installed ? "installed" : "missing"})`
              : dep.installed
                ? "installed, pack unknown"
                : "UNRESOLVED";
          lines.push(`- \`${dep.class_type}\` → ${where}`);
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "install_workflow_dependencies",
    "Resolve and install the custom node packs a ComfyUI workflow requires via ComfyUI-Manager. " +
      "Determines the missing packs, resets the Manager queue, queues the installs, starts the " +
      "worker, and reports what was installed/already-present/unresolved. Runs server-side through " +
      "ComfyUI-Manager on the connected instance (works against a local OR remote --comfyui-url " +
      "target); a ComfyUI restart is typically needed before new nodes load. Mirrors " +
      "`comfy-cli node install-deps`.",
    {
      workflow: z
        .union([z.string(), z.record(z.string(), z.any())])
        .describe("ComfyUI workflow in API format (JSON string or object)"),
    },
    async (args) => {
      try {
        const workflow = parseWorkflow(args.workflow);
        const result = await installWorkflowDependencies(workflow, defaultWorkflowDepsDeps());

        const lines: string[] = [];
        if (result.installed.length > 0) {
          lines.push(
            `## Queued ${result.installed.length} node pack(s) for install`,
            ...result.installed.map((p) => `- ${p}`),
            "",
            "ComfyUI-Manager is processing the install queue. A ComfyUI restart is typically " +
              "required before the new nodes become available.",
            "",
          );
        } else {
          lines.push("## No packs needed installation", "");
        }

        if (result.alreadyInstalled.length > 0) {
          lines.push(
            `### Already installed (${result.alreadyInstalled.length})`,
            ...result.alreadyInstalled.map((p) => `- ${p}`),
            "",
          );
        }

        if (result.unresolved.length > 0) {
          lines.push(
            `### Could not resolve (${result.unresolved.length})`,
            "Not found in ComfyUI-Manager — install manually:",
            ...result.unresolved.map((p) => `- ${p}`),
            "",
          );
        }

        if (result.queue) {
          const q = result.queue;
          lines.push(
            "### Manager queue status",
            `- total: ${q.total_count ?? "?"}, done: ${q.done_count ?? "?"}, ` +
              `in progress: ${q.in_progress_count ?? "?"}, processing: ${q.is_processing ?? "?"}`,
          );
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
