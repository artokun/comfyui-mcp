import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  scaffoldCustomNode,
  publishCustomNode,
} from "../services/node-authoring.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerNodeAuthoringTools(server: McpServer): void {
  server.tool(
    "scaffold_custom_node",
    "Generate a new ComfyUI custom-node pack from a template into " +
      "<COMFYUI_PATH>/custom_nodes/<name>/. Writes pyproject.toml (with the " +
      "[tool.comfy] PublisherId/DisplayName/Icon table the Comfy Registry " +
      "requires), __init__.py exporting NODE_CLASS_MAPPINGS / " +
      "NODE_DISPLAY_NAME_MAPPINGS, and src/nodes.py containing a runnable sample " +
      "node (INPUT_TYPES/RETURN_TYPES/FUNCTION/CATEGORY). Optionally emits a " +
      "web/js frontend stub and wires WEB_DIRECTORY. This is the FIRST step of " +
      "the author loop: scaffold here, then restart_comfyui to load it, test it, " +
      "and finally publish_custom_node. LOCAL-ONLY: it writes to your local " +
      "ComfyUI install and requires COMFYUI_PATH (it does nothing for a remote " +
      "--comfyui-url target). Names must be a safe lowercase slug and cannot " +
      "escape custom_nodes/; an existing non-empty directory is left untouched " +
      "unless overwrite is true. Use this to CREATE a pack you author — to " +
      "install someone else's pack use install_custom_node instead.",
    {
      name: z
        .string()
        .describe(
          "Pack folder name — a safe lowercase slug (letters, digits, hyphens, underscores), e.g. 'my-cool-nodes'. Becomes the directory under custom_nodes/ and the pyproject [project].name.",
        ),
      display_name: z
        .string()
        .describe("Human-readable name shown in the ComfyUI node menu and the registry listing."),
      category: z
        .string()
        .optional()
        .describe("Node menu category for the sample node (default 'custom')."),
      description: z
        .string()
        .optional()
        .describe("Short description written to pyproject [project].description."),
      publisher_id: z
        .string()
        .optional()
        .describe(
          "Your Comfy Registry publisher id, stamped into [tool.comfy].PublisherId. If omitted a placeholder is written that you must replace before publishing.",
        ),
      with_frontend: z
        .boolean()
        .optional()
        .describe("If true, also generate a web/js/<name>.js extension stub and set WEB_DIRECTORY (default false)."),
      overwrite: z
        .boolean()
        .optional()
        .describe("If true, overwrite template files in an existing pack directory instead of refusing (default false)."),
    },
    async (args) => {
      try {
        const result = scaffoldCustomNode({
          name: args.name,
          displayName: args.display_name,
          category: args.category,
          description: args.description,
          publisherId: args.publisher_id,
          withFrontend: args.with_frontend,
          overwrite: args.overwrite,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "publish_custom_node",
    "Publish a local custom-node pack to the public Comfy Registry " +
      "(registry.comfy.org) by running `comfy node publish` inside the pack " +
      "directory. First validates the pack's pyproject.toml has the required " +
      "[project].name, [project].version and [tool.comfy].PublisherId (refusing " +
      "the scaffold placeholder), then publishes using the API key from the " +
      "REGISTRY_ACCESS_TOKEN environment variable (passed to comfy-cli via the " +
      "environment, never via logged arguments). This is the LAST step of the " +
      "author loop and an IRREVERSIBLE, EXTERNAL action: it creates/updates a " +
      "PUBLIC registry version that this tool cannot undo. Requires comfy-cli " +
      "installed and REGISTRY_ACCESS_TOKEN set. LOCAL-ONLY: it reads and runs " +
      "against a pack on the local filesystem and is meaningless for a remote " +
      "--comfyui-url target. To create a pack first, use scaffold_custom_node.",
    {
      name: z
        .string()
        .optional()
        .describe("Pack folder name under <COMFYUI_PATH>/custom_nodes/ to publish. Provide this or `path`."),
      path: z
        .string()
        .optional()
        .describe("Explicit absolute path to the pack directory to publish. Overrides `name` when both are given."),
    },
    async (args) => {
      try {
        const result = publishCustomNode({ name: args.name, path: args.path });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
