import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runSelfUpdate, selfUpdateStatus } from "../services/self-update.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerSelfUpdateTools(server: McpServer): void {
  server.tool(
    "self_update",
    "Check or apply a self-update of the comfyui-mcp npm package against the npm " +
      "registry. The server also auto-checks on start (opt out with " +
      "COMFYUI_MCP_AUTOUPDATE=0). Detects the install mode: a dev install (npm " +
      "link / source checkout) is NEVER updated; global/local installs are updated " +
      "via npm; npx fetches latest on next run. The running process cannot hot-swap " +
      "its own code — after an update you must RECONNECT (/mcp) or restart the " +
      "orchestrator to load the new version. This tool does not auto-restart.",
    {
      action: z
        .enum(["status", "update"])
        .default("status")
        .describe(
          "status: report install mode + current vs latest version + dev-link note " +
            "(never errors). update: update to the latest published version " +
            "(refuses on a dev link; no-op when already up to date or for npx).",
        ),
    },
    async ({ action }) => {
      try {
        const result =
          action === "status" ? await selfUpdateStatus() : await runSelfUpdate();
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
