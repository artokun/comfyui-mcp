import { homedir } from "node:os";
import { join } from "node:path";

/**
 * One bounded history for both `connect` and `--panel-orchestrator`.
 * They enter the same long-lived runtime; keeping one stable path means a
 * panel-launched terminal and a manually launched connect process are equally
 * diagnosable without making the broker guess where the child will write.
 */
export function orchestratorLogPath(
  options: { home?: string; dataDir?: string } = {},
): string {
  const configuredDataDir =
    options.dataDir === undefined
      ? process.env.COMFYUI_MCP_DATA_DIR?.trim()
      : options.dataDir.trim();
  const dataDir = configuredDataDir || join(options.home ?? homedir(), ".comfyui-mcp");
  return join(dataDir, "launch-logs", "connect-orchestrator.log");
}
