import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isLocalMode } from "../config.js";
import {
  installCustomNode,
  updateCustomNode,
  reinstallCustomNode,
  fixCustomNode,
  listInstalledNodes,
  syncNodeDependencies,
  type InstalledNode,
} from "../services/node-management.js";
import { errorToToolResult } from "../utils/errors.js";

/** Graceful "not supported remotely" tool result (no isError), matching the
 *  degrade-don't-throw pattern list_local_models uses. */
function remoteUnsupported(message: string) {
  return { content: [{ type: "text" as const, text: message }] };
}

const modeSchema = z
  .enum(["remote", "local", "cache"])
  .optional()
  .describe(
    "ComfyUI-Manager data source mode (default 'remote'): 'remote' fetches the live node list, 'local'/'cache' use bundled/cached data.",
  );

const useCmCliSchema = z
  .boolean()
  .optional()
  .describe(
    "Force the cm-cli.py subprocess instead of the ComfyUI-Manager HTTP API. Requires a local ComfyUI install (COMFYUI_PATH); errors in remote --comfyui-url mode.",
  );

const channelSchema = z
  .string()
  .optional()
  .describe("ComfyUI-Manager channel name (default 'default').");

function formatInstalledNodes(nodes: InstalledNode[]): string {
  if (nodes.length === 0) return "No custom nodes installed.";
  return nodes
    .map((n, i) => {
      const idParts = [
        n.cnrId ? `cnr:${n.cnrId}` : null,
        n.auxId ? `git:${n.auxId}` : null,
      ].filter(Boolean);
      const idStr = idParts.length ? ` [${idParts.join(", ")}]` : "";
      return (
        `${i + 1}. ${n.module}${idStr}\n` +
        `   version: ${n.version ?? "unknown"} | ${n.enabled ? "enabled" : "disabled"}`
      );
    })
    .join("\n");
}

export function registerNodeManagementTools(server: McpServer): void {
  server.tool(
    "install_custom_node",
    "Install a ComfyUI custom node pack by registry id (e.g. 'comfyui-impact-pack'), git URL, or name. Uses the ComfyUI-Manager HTTP API (works against remote instances) and falls back to the cm-cli subprocess when forced. A ComfyUI restart may be required to load newly installed nodes.",
    {
      id: z
        .string()
        .describe("Registry id, git URL, or node-pack name to install."),
      source: z
        .enum(["registry", "git", "auto"])
        .optional()
        .describe(
          "How to interpret `id` (default 'auto', which detects git URLs vs registry ids).",
        ),
      version: z
        .string()
        .optional()
        .describe(
          "Version to install (e.g. 'latest', 'nightly', or a semver). For git installs, this is treated as a git ref unless `ref` is also provided. Registry installs default to 'latest'.",
        ),
      ref: z
        .string()
        .optional()
        .describe(
          "Git ref (commit SHA, branch, or tag) to pin when installing a git URL. Overrides any ref parsed from the URL and any `version` value. Ignored for registry-id installs.",
        ),
      mode: modeSchema,
      channel: channelSchema,
      useCmCli: useCmCliSchema,
    },
    async (args) => {
      try {
        const result = await installCustomNode(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "update_custom_node",
    "Update an installed ComfyUI custom node pack, or pass 'all' to update every installed pack. Uses the ComfyUI-Manager HTTP API with a cm-cli subprocess fallback.",
    {
      id: z
        .string()
        .describe("Registry id / module name to update, or 'all' for every pack."),
      mode: modeSchema,
      channel: channelSchema,
      useCmCli: useCmCliSchema,
    },
    async (args) => {
      try {
        const result = await updateCustomNode(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "reinstall_custom_node",
    "Reinstall a ComfyUI custom node pack (uninstall then install). Uses the ComfyUI-Manager HTTP API with a cm-cli subprocess fallback. A ComfyUI restart may be required.",
    {
      id: z.string().describe("Registry id / module name to reinstall."),
      version: z
        .string()
        .optional()
        .describe("Version to reinstall (default 'latest')."),
      mode: modeSchema,
      channel: channelSchema,
      useCmCli: useCmCliSchema,
    },
    async (args) => {
      try {
        const result = await reinstallCustomNode(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "fix_custom_node",
    "Repair a ComfyUI custom node pack's install and Python dependencies, or pass 'all' to repair every pack. Single-pack repair uses the ComfyUI-Manager HTTP API; 'all' and forced runs use the cm-cli subprocess (requires a local ComfyUI install).",
    {
      id: z
        .string()
        .describe("Registry id / module name to repair, or 'all' for every pack."),
      mode: modeSchema,
      channel: channelSchema,
      useCmCli: useCmCliSchema,
    },
    async (args) => {
      // "all" repairs every pack via the cm-cli subprocess, which needs a local
      // ComfyUI install. Single-pack repair uses the Manager HTTP API and works
      // remotely, so only guard the "all" case here.
      if (args.id.trim().toLowerCase() === "all" && !isLocalMode()) {
        return remoteUnsupported(
          "fix_custom_node id=\"all\" is not supported against a remote ComfyUI. " +
            "Repairing every pack runs the cm-cli subprocess, which requires a " +
            "local ComfyUI install (COMFYUI_PATH). Repair a single pack by id " +
            "instead (that uses the ComfyUI-Manager HTTP API and works remotely).",
        );
      }
      try {
        const result = await fixCustomNode(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "list_installed_nodes",
    "List installed ComfyUI custom node packs with their version and enabled/disabled state. Uses the ComfyUI-Manager HTTP API (works against remote instances); the cm-cli fallback returns names only.",
    {
      mode: z
        .enum(["default", "imported"])
        .optional()
        .describe(
          "'default' lists all installed packs; 'imported' lists only those successfully imported this session.",
        ),
      useCmCli: useCmCliSchema,
    },
    async (args) => {
      try {
        const nodes = await listInstalledNodes(args);
        return {
          content: [{ type: "text" as const, text: formatInstalledNodes(nodes) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "sync_node_dependencies",
    "Reconcile the Python dependencies of all installed custom node packs (comfy-cli `node uv-sync` analogue). Runs cm-cli restore-dependencies as a subprocess and requires a local ComfyUI install (COMFYUI_PATH); errors in remote --comfyui-url mode.",
    {},
    async () => {
      if (!isLocalMode()) {
        return remoteUnsupported(
          "sync_node_dependencies is not supported against a remote ComfyUI. It " +
            "runs the cm-cli restore-dependencies subprocess, which requires a " +
            "local ComfyUI install (COMFYUI_PATH). Reconcile dependencies on the " +
            "ComfyUI host instead.",
        );
      }
      try {
        const result = await syncNodeDependencies();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
