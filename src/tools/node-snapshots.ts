import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  saveNodeSnapshot,
  restoreNodeSnapshot,
  listNodeSnapshots,
} from "../services/node-snapshots.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerNodeSnapshotsTools(server: McpServer): void {
  server.tool(
    "save_node_snapshot",
    "Save a snapshot of the current ComfyUI custom-node and version state via " +
      "ComfyUI-Manager (mirrors `comfy node save-snapshot`). With no name, " +
      "Manager assigns a timestamped snapshot (works against remote instances). " +
      "Provide a name to write a custom-named snapshot file — this requires a " +
      "local ComfyUI install and is unavailable in remote (--comfyui-url) mode.",
    {
      name: z
        .string()
        .optional()
        .describe(
          "Optional custom snapshot name (no extension, no path separators). " +
            "Omit to let ComfyUI-Manager assign a timestamped name.",
        ),
    },
    async (args) => {
      try {
        const result = await saveNodeSnapshot(args.name);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "restore_node_snapshot",
    "Restore a previously saved custom-node snapshot via ComfyUI-Manager " +
      "(mirrors `comfy node restore-snapshot`). ComfyUI-Manager applies the " +
      "custom-node changes on the next ComfyUI restart. Use list_node_snapshots " +
      "to find available snapshot names.",
    {
      name: z
        .string()
        .describe("Name of the snapshot to restore (as shown by list_node_snapshots)."),
    },
    async (args) => {
      try {
        const result = await restoreNodeSnapshot(args.name);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "list_node_snapshots",
    "List available custom-node snapshots known to ComfyUI-Manager " +
      "(mirrors `comfy node` snapshot listing).",
    {},
    async () => {
      try {
        const result = await listNodeSnapshots();
        const text = result.unsupported
          ? (result.message ?? "Node snapshots are not supported on this ComfyUI-Manager build.")
          : result.snapshots.length === 0
            ? "No node snapshots found."
            : `Available node snapshots (${result.snapshots.length}):\n` +
              result.snapshots.map((s) => `- ${s}`).join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
