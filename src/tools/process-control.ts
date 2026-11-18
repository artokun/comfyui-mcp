import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  stopComfyUI,
  startComfyUI,
  restartComfyUI,
  describeLifecycleStatus,
} from "../services/process-control.js";
import { errorToToolResult } from "../utils/errors.js";

/**
 * The three ComfyUI process-lifecycle tools collapsed into one
 * action-parameterized `restart_comfyui` tool (0.50.0 surface consolidation,
 * slice 7), plus the read-only `action:"status"` (#2948).
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: all three retired tools took NO parameters at all, so `action`
 * is not merely the only schema-required field, it is the only field. There is
 * consequently no per-action presence guard to write here — the handler's only
 * job is to dispatch. Each branch calls the same service function the old tool
 * called, with the same (empty) arguments, and returns the identical content
 * block: the service result as pretty-printed JSON.
 */
export function registerProcessControlTools(server: McpServer): void {
  server.tool(
    "restart_comfyui",
    "Control the lifecycle of the ComfyUI server process. Driven by the `action` parameter:\n" +
      '- action:"restart" — Restart ComfyUI: stops the running process (capturing its config), waits for the port to free, relaunches with the same arguments, and polls the API for bounded readiness. Also works against a REMOTE/tunnelled ComfyUI (via --comfyui-url) by rebooting through ComfyUI-Manager over HTTP and polling for it to come back (requires ComfyUI-Manager present and its security level permitting the reboot). When COMFYUI_RESTART_COMMAND is set, a LOCAL restart runs that command instead of kill+relaunch — the recovery path for an externally managed install (a container, a systemd unit, a launcher) whose launch path cannot be proven from here. This is the normal way to reload newly installed custom nodes, and the escalation when queue (action:"cancel") reports a job WEDGED. On Windows restart_comfyui never launches ComfyUI itself. A local restart there asks ComfyUI-Manager to reboot a ComfyUI Desktop backend whose supervisor is verified, or INFERRED from Desktop\'s launch arguments when the process tree cannot be read (disclosed in the result; a server started by hand with Desktop\'s flags would stay down); or reboots a verified EZi/CEI proxy backend; or runs COMFYUI_RESTART_COMMAND (keeping what that command starts outside the agent\'s process tree is up to the command). Any restart that would need restart_comfyui to relaunch ComfyUI is refused BEFORE anything is stopped. Other launch paths (comfy_cli server_start/server_restart, commands you run yourself) are not covered by this.\n' +
      '- action:"start" — Start ComfyUI using process info saved from a previous action:"stop" call. Supports both Desktop app and manual Python installs on macOS/Linux. Polls the API for bounded readiness before reporting ready. Local installs only. NOT available on Windows: a process launched from here belongs to the agent\'s process tree and can be killed when the agent closes or updates, so start always refuses there (startup:"not-attempted") — start ComfyUI from the Desktop app or its own launcher.\n' +
      '- action:"stop" — Stop the running ComfyUI process. Captures process info so it can be restarted with action:"start". Kills the process tree and resets the WebSocket client. Local installs only. Anything queued or rendering is lost. On Windows the stop is one-way from this tool: action:"start" cannot bring it back (the result says has_restart_info:false), so only stop when ComfyUI should stay down until someone restarts it by hand; to cycle it use action:"restart", which refuses rather than leaving ComfyUI down when it cannot bring it back.\n' +
      '- action:"status" — READ-ONLY: report what start, stop and restart would do right now, and whether this tool could bring ComfyUI back after a stop (stop.recoverable_by_start "yes"/"no"/"unknown", with manual_recovery_reason and the manual restart_hint), plus the restart route and its evidence (verified-supervisor, inferred-supervisor, proven-launch-files, validated-command, user-configured, corroborated-proxy, unverified-remote, none). Stops, launches, reboots and writes nothing. For maintenance, call it BEFORE action:"stop", and cycle ComfyUI with action:"restart" rather than stop+start. It is a prediction: each action re-checks when it runs and may still refuse. target_stable:false means the ComfyUI target changed while it was checking, so every answer is "unknown" — retry.',
    {
      action: z
        .enum(["restart", "start", "stop", "status"])
        .describe(
          'Which process operation to perform. None of them takes any other parameter. "restart" stops and relaunches in one call (and is the only action that also works against a remote/tunnelled ComfyUI); "start" relaunches from the info a previous "stop" saved (never on Windows); "stop" kills the running process tree; "status" is read-only and changes nothing — call it before "stop".',
        ),
    },
    async (args) => {
      try {
        const json = (value: unknown) => ({
          content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
        });

        switch (args.action) {
          case "restart":
            return json(await restartComfyUI());
          case "start":
            return json(await startComfyUI());
          case "stop":
            return json(await stopComfyUI());
          case "status":
            return json(await describeLifecycleStatus());
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown restart_comfyui action "${String(exhaustive)}". Expected one of: restart, start, stop, status.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
