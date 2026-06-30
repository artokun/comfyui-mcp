import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { applyManifest, manifestSchema } from "../services/manifest.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerManifestTools(server: McpServer): void {
  server.tool(
    "apply_manifest",
    "Apply a ComfyUI setup manifest from an inline object or .json/.yaml/.yml file. Composes custom-node installs and model downloads, installs pip packages, and reports apt entries as skipped (system packages need manual/root installation). LOCAL ComfyUI (COMFYUI_PATH set): nodes/models land on the local filesystem and pip installs into the ComfyUI Python env. REMOTE ComfyUI: custom_nodes and models are routed through the ComfyUI-Manager HTTP API (handled on the host), while pip and apt entries are reported as skipped (no remote equivalent). Each item reports applied/skipped/failed independently.",
    {
      manifest: manifestSchema
        .optional()
        .describe(
          "Inline manifest object. Provide exactly one of `manifest` or `path`.",
        ),
      path: z
        .string()
        .optional()
        .describe(
          "Path to a .json, .yaml, or .yml manifest file. Provide exactly one of `manifest` or `path`.",
        ),
    },
    async (args) => {
      try {
        const result = await applyManifest(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
