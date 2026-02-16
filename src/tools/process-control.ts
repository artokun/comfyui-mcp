import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  stopComfyUI,
  startComfyUI,
  restartComfyUI,
} from "../services/process-control.js";
import { errorToToolResult } from "../utils/errors.js";

export function registerProcessControlTools(server: McpServer): void {
  server.tool(
    "stop_comfyui",
    "Stop the running ComfyUI process. Captures process info so it can be restarted with start_comfyui. Kills the process tree and resets the WebSocket client.",
    {},
    async () => {
      try {
        const result = await stopComfyUI();
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "start_comfyui",
    "Start ComfyUI using process info saved from a previous stop_comfyui call. Supports both Desktop app and manual Python installs. Waits up to 60s for the API to become ready.",
    {},
    async () => {
      try {
        const result = await startComfyUI();
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "restart_comfyui",
    "Restart ComfyUI: stops the running process (capturing its config), waits for the port to free, relaunches with the same arguments, and waits for the API to become ready.",
    {},
    async () => {
      try {
        const result = await restartComfyUI();
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
