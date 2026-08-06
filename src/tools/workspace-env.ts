import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  getWorkspace,
  setDefaultWorkspace,
  listWorkspaces,
  getEnvironment,
} from "../services/workspace-env.js";
import { errorToToolResult } from "../utils/errors.js";

/**
 * The three workspace tools collapsed into one action-parameterized `workspace`
 * tool (0.49.0 surface consolidation, slice 6).
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: only `action` can be schema-required — `path` is required by
 * set_default and meaningless for get/list. Every VALUE constraint the old
 * tools had is unchanged at the zod layer (`path` keeps its .min(1), so an
 * empty string fails exactly as it did before); the handler enforces per-action
 * PRESENCE and names the missing field — the one deliberate behavioural
 * difference a flat enum permits. Each branch calls the same workspace-env
 * service the old tool called, with the same arguments, and returns the
 * identical JSON content block.
 */
export function registerWorkspaceEnvTools(server: McpServer): void {
  server.tool(
    "workspace",
    "Inspect and manage ComfyUI workspaces (local installs). Driven by the `action` parameter:\n" +
      '- action:"get" — Report the active ComfyUI workspace (mirrors `comfy-cli which`): the local installation path being used (from COMFYUI_PATH or auto-detection), the source of that path, any persisted default workspace, and the resolved API target the MCP server talks to.\n' +
      '- action:"set_default" — Persist a default ComfyUI workspace path to the MCP config file (mirrors `comfy-cli set-default`). The value is stored under the OS config dir (e.g. ~/.config/comfyui-mcp/workspace.json) and reported by action:"get"/action:"list". Does NOT change the live API target. `path` is REQUIRED, e.g. {action:"set_default", path:"/opt/ComfyUI"}.\n' +
      '- action:"list" — List known/auto-detected ComfyUI installations on this machine. Scans common install locations across macOS, Linux, and Windows and marks which one is active and which is the saved default.',
    {
      action: z
        .enum(["get", "set_default", "list"])
        .describe(
          'Which workspace operation to perform. "get" and "list" take no other parameters; "set_default" requires `path`.',
        ),
      path: z
        .string()
        .min(1)
        .optional()
        .describe(
          'action:"set_default" — REQUIRED absolute path to a ComfyUI installation directory to remember as the default workspace.',
        ),
    },
    async (args) => {
      try {
        const json = (value: unknown) => ({
          content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
        });

        switch (args.action) {
          case "get":
            return json(await getWorkspace());
          case "set_default":
            // path cannot be schema-required in a flat shape, so the handler
            // enforces per-action presence and names the missing field — the
            // same information the old per-tool schema gave a caller.
            //
            // ABSENCE only, never falsiness: an empty `path` fails the .min(1)
            // value constraint exactly as it did before this consolidation,
            // and the service's own non-empty validation still answers.
            if (args.path === undefined) {
              throw new Error(
                'workspace action:"set_default" requires `path` — the absolute path to a ComfyUI installation directory.',
              );
            }
            return json(await setDefaultWorkspace(args.path));
          case "list":
            return json(await listWorkspaces());
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown workspace action "${String(exhaustive)}". Expected one of: get, set_default, list.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

}

/**
 * `install_comfyui (action:"environment")` — what the retired `install_comfyui (action:"environment")`
 * tool did (0.50.0 slice 13). Same workspace-env service, same JSON block; the
 * `workspace` tool above is untouched.
 */
export async function getEnvironmentAction(): Promise<CallToolResult> {
  const info = await getEnvironment();
  return {
    content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
  };
}
