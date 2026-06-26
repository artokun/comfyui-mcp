import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  panelStatus,
  runPanelAction,
} from "../services/panel-installer.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerInstallPanelTools(server: McpServer): void {
  server.tool(
    "install_panel",
    "Install, update, reinstall, or report status of the ComfyUI sidebar panel " +
      "('comfyui-agent-panel' on the Comfy Registry; repo comfyui-mcp-panel) in the " +
      "LOCAL ComfyUI's custom_nodes. Uses the same ComfyUI-Manager path as " +
      "install_custom_node and always targets the 'nightly' (git-HEAD) channel. " +
      "Local-only (no-op/refuses in remote/cloud mode) and NEVER modifies a dev " +
      "install (a symlinked panel dir). After install/update/reinstall, ComfyUI must " +
      "be RESTARTED to load the new/updated node — this tool does not auto-restart. " +
      "The panel is also auto-installed-if-missing when the MCP server loads.",
    {
      action: z
        .enum(["status", "install", "update", "reinstall"])
        .default("status")
        .describe(
          "status: report installed/version/dev-symlink (never errors). " +
            "install: add the panel (nightly). update: pull the latest nightly. " +
            "reinstall: uninstall + reinstall (nightly). install/update/reinstall " +
            "refuse on a dev symlink and require a local COMFYUI_PATH.",
        ),
    },
    async ({ action }) => {
      try {
        if (action === "status") {
          const status = await panelStatus();
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(status, null, 2) },
            ],
          };
        }
        const result = await runPanelAction(action);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
