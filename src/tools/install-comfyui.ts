import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isRemoteMode } from "../config.js";
import { installComfyUI } from "../services/install-comfyui.js";
import { MANAGER_CONFIG_ACTIONS } from "../services/manager-config.js";
import { RemoteModeError, errorToToolResult } from "../utils/errors.js";
import { updateAllAction, updateComfyUiCoreAction } from "./update-comfyui.js";
import { PANEL_ACTIONS, panelAction } from "./install-panel.js";
import { SELF_UPDATE_ACTIONS, selfUpdateAction } from "./self-update.js";
import { getEnvironmentAction } from "./workspace-env.js";
import { configureManagerAction } from "./manager-config.js";

/**
 * The install/environment tools collapsed into one action-parameterized
 * `install_comfyui` tool (0.50.0 surface consolidation, slice 13): seven tools,
 * seven actions.
 *
 * The slice originally folded eight. Review took the RFC's documented fallback
 * for `apply_manifest` and left it STANDALONE — it is the most-referenced name
 * on the whole surface (143 in-repo mentions, nearly all of them one-line
 * install INSTRUCTIONS in pack headers, blog posts and the installer-packs
 * skill), and burying the repo's most-taught operation inside a seven-action
 * description cost more than the slot it saved.
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: only `action` can be schema-required — `target_path` is required
 * by action:"install" and meaningless elsewhere, `manager_setting` by
 * action:"configure_manager", and the rest are per-action optionals. Every VALUE
 * constraint the old tools had is unchanged at the zod layer (`target_path`
 * keeps its .min(1), `manager_setting` its enum), and the handler enforces
 * per-action PRESENCE while NAMING the missing field — the one deliberate
 * behavioural difference a flat enum permits. The guards test ABSENCE, never
 * falsiness.
 *
 * THREE FOLDED TOOLS ALREADY HAD AN `action` OF THEIR OWN — the panel install,
 * the self-update and the Manager configuration. Two fields cannot share one name in a flat
 * object, so those sub-selectors become `panel_action`, `self_update_action` and
 * `manager_setting`. That is a rename of a model-facing argument, which a fold
 * otherwise avoids; here it is forced by the shape, and each keeps its enum
 * VALUES and its default verbatim (`panel_action` and `self_update_action` both
 * still default to "status", so the bare action is still the read-only one).
 *
 * `version` is DELIBERATELY shared rather than split: both `install_comfyui` and
 * `install_comfyui(action:'panel')` called their argument `version`, and `action` already says
 * which one is meant. Splitting it would rename an argument that did not have
 * to change.
 *
 * BLAST RADIUS IS NOT UNIFORM, and the description says so per action:
 * action:"install" writes a whole new ComfyUI tree, action:"self_update" mutates THIS
 * npm package, action:"panel" mutates the sidebar node-pack, and action:"update" /
 * action:"update_all" move ComfyUI core and every installed node pack
 * respectively. Nothing here is read-only except action:"environment",
 * panel_action:"status" and self_update_action:"status".
 */
export function registerInstallComfyUITools(server: McpServer): void {
  // ONE line on purpose: the dead-name gate licenses an action literal only
  // where a `[` or `,` precedes it on the SAME line (vocabulary.ts,
  // ACTION_LITERAL_LEAD), which a one-name-per-line array does not satisfy.
  // prettier-ignore
  const ACTIONS = ["install", "update", "update_all", "panel", "self_update", "environment", "configure_manager"] as const;
  server.tool(
    "install_comfyui",
    "Install, update and configure the local ComfyUI installation, its sidebar panel, and this MCP server itself. Driven by the `action` parameter:\n" +
      '- action:"install" — Install ComfyUI locally: git-clone it into `target_path`, create a dedicated workspace virtualenv (<target>/.venv), and install Python requirements INTO that venv (never the Python running this MCP server) via pip or uv. ComfyUI-Manager is installed from manager_requirements.txt when present, else git-cloned as a fallback. Mirrors `comfy-cli install`. LOCAL, subprocess-only and independent of any remote --comfyui-url target; the target dir must be empty or non-existent (an existing install is never overwritten). Runs SYNCHRONOUSLY and can take several minutes (large git clone + full torch/dependency install); the call blocks until done. On success returns a JSON report { installed, targetPath, venvPath, comfyuiUrl, managerInstalled, managerVia, version, pythonInstaller, steps[] }. Does NOT start ComfyUI. `target_path` is REQUIRED.\n' +
      '- action:"update" — Update the ComfyUI CORE install: runs `git pull` in the configured ComfyUI directory and reinstalls its Python requirements (auto-detecting uv vs pip). Requires a local install (COMFYUI_PATH); returns a clear error when targeting a remote instance via --comfyui-url. The requirements install targets the running server\'s own interpreter (recorded when this server launched ComfyUI, or an explicit COMFYUI_PYTHON); when that interpreter cannot be verified the update refuses rather than install into a guessed environment — start ComfyUI or connect first. Does NOT touch custom nodes.\n' +
      '- action:"update_all" — Update ALL installed CUSTOM NODES via the ComfyUI-Manager HTTP API. Mirrors `comfy-cli update all`. This does NOT update ComfyUI core — use action:"update" for that. Works against the connected instance (local or remote); updates run asynchronously and a ComfyUI restart may be required afterward. REFUSED while the comfyui-mcp sidebar panel is version-pinned, because \'all\' would move the pinned panel too and ComfyUI-Manager cannot update everything-except-one-pack — clear the pin with action:"panel" + panel_action:"unpin", or update the other packs individually by id.\n' +
      '- action:"panel" — Install, update, reinstall, sync, pin, unpin, unlock, or report status of the ComfyUI sidebar panel (\'comfyui-agent-panel\' on the Comfy Registry; repo comfyui-mcp-panel) in the LOCAL ComfyUI\'s custom_nodes, selected by `panel_action` (default "status"). Uses the same ComfyUI-Manager path as install_custom_node and always targets the \'nightly\' (git-HEAD) channel. Local-only (no-op/refuses in remote/cloud mode) and NEVER modifies a dev install (a symlinked panel dir). After install/update/reinstall/sync, ComfyUI must be RESTARTED to load the new/updated node — this tool does not auto-restart. The panel is also auto-installed-if-missing when the MCP server loads. A version PIN (panel_action:"pin") holds the panel where it is: while a pin is set, install/update/reinstall/sync and the auto-install all refuse, and \'sync\' only warns that a newer panel exists. Panel operations are serialized across orchestrator processes by a lock file that is never auto-reclaimed — if a crashed orchestrator wedges it, panel_action:"unlock" reclaims the lock once it is provably abandoned. This is the SIDEBAR PANEL only; it never touches ComfyUI core or this npm package.\n' +
      '- action:"self_update" — Check or apply a self-update of the comfyui-mcp NPM PACKAGE (this MCP server), selected by `self_update_action` (default "status"). The server also auto-checks on start (opt out with COMFYUI_MCP_AUTOUPDATE=0). Detects the install mode: a dev install (npm link / source checkout) is NEVER updated; global/local installs are updated via npm; npx fetches latest on next run. The running process cannot hot-swap its own code — after an update you must RECONNECT (/mcp) or restart the orchestrator to load the new version. This tool does not auto-restart. On Windows the running orchestrator holds its own sharp DLL locked, so an in-place npm replace fails (EBUSY); the update is then handed to a deferred helper that finishes it once the orchestrator has fully stopped, and the new version loads at the next start. A failed update reports npm\'s own error output. This updates comfyui-mcp ITSELF — not ComfyUI (action:"update"), not the sidebar panel (action:"panel"), and not custom nodes (install_comfyui (action:"update_all")).\n' +
      '- action:"environment" — Report ComfyUI environment info (mirrors `comfy-cli env`): the running instance details from /system_stats (OS, Python, ComfyUI version, GPU/VRAM — works for remote targets) plus local probes when a workspace path is available (Python version, git revision, ComfyUI-Manager version, and key pip packages like torch/CUDA). The local python probe targets the interpreter the RUNNING server uses (its venv / embedded / standalone python, resolved from the live server), never a bare `python` on PATH. Degrades gracefully and NEVER guesses: when the correct interpreter can\'t be confirmed, `local.python_probe_trusted` is false, `local.packages` is omitted, and `local.python_probe_reason` says why — an absent package list means UNDETERMINED, never \'not installed\'. READ-ONLY.\n' +
      '- action:"configure_manager" — Configure ComfyUI-Manager settings, mirroring `comfy-cli manager` subcommands; `manager_setting` picks which setting and `value` its new value. Most settings use the ComfyUI-Manager HTTP API (works against remote ComfyUI); set_network_mode and set_security_level have no HTTP setter and are written to Manager\'s config.ini (requires a known local ComfyUI path; restart ComfyUI to apply).',
    {
      action: z
        .enum(ACTIONS)
        .describe(
          'Which install/environment operation to perform. action:"update", action:"update_all" and action:"environment" take no other parameters; action:"install" requires `target_path`; action:"panel" takes `panel_action` (+ `version`/`reason` for a pin); action:"self_update" takes `self_update_action`; action:"configure_manager" requires `manager_setting` (+ `value`).',
        ),
      target_path: z
        .string()
        .min(1)
        .optional()
        .describe(
          'action:"install" — REQUIRED absolute path to the workspace directory to install ComfyUI into. Must be empty or non-existent.',
        ),
      skip_manager: z
        .boolean()
        .optional()
        .describe(
          'action:"install" — if true, do not clone/install ComfyUI-Manager. Default false (Manager is installed).',
        ),
      use_uv: z
        .boolean()
        .optional()
        .describe(
          'action:"install" — if true, prefer `uv pip install` over plain pip when uv is available on PATH. Falls back to pip if uv is missing. Default false.',
        ),
      version: z
        .string()
        .optional()
        .describe(
          'action:"install" — ComfyUI version to install (comfy-cli semantics): "nightly" (default-branch HEAD), ' +
            '"latest" (newest release tag), or a semantic version like "0.3.40" (checked out as ' +
            "tag v0.3.40). Raw git refs/branches are rejected. Omit to track the default branch HEAD. " +
            'ALSO used by action:"panel" + panel_action:"pin", where it is the PANEL version to hold at, ' +
            "e.g. '0.11.20' (take it from the installedVersion that panel_action:\"status\" reports).",
        ),
      panel_action: z
        .enum(PANEL_ACTIONS)
        .default("status")
        .describe(
          'action:"panel" — which sidebar-panel operation to run. status: report ' +
            "installed/version/dev-symlink/pin plus a sync assessment (never errors). " +
            "sync: bring the panel up to what this orchestrator needs — no-ops when " +
            "already current, WARNS ONLY when pinned, and reports the version re-read " +
            "from disk afterwards. install: add the panel (nightly). update: pull the " +
            "latest nightly. Works on either install shape — a git checkout is " +
            "fast-forwarded, and a Comfy Registry ZIP install (which has no .git) is " +
            "replaced with a verified fresh clone, keeping the previous copy outside " +
            "custom_nodes. Success is always re-read from disk. reinstall: uninstall + " +
            "reinstall (nightly). pin: hold the panel at a version (requires `version`). " +
            "unpin: clear the pin so a sync can proceed. unlock: recover from a " +
            "crashed/killed orchestrator's leftover panel operation lock — reclaims it " +
            "ONLY when it is provably abandoned (older than the stale threshold AND its " +
            "recorded owner process is dead), and refuses with the observed state " +
            "otherwise. install/update/reinstall/sync refuse on a dev symlink or an " +
            "active pin, and require a local workspace (COMFYUI_PATH or the saved " +
            "default workspace).",
        ),
      reason: z
        .string()
        .optional()
        .describe(
          'action:"panel" + panel_action:"pin" only: why the user is pinning (stored with the pin).',
        ),
      self_update_action: z
        .enum(SELF_UPDATE_ACTIONS)
        .default("status")
        .describe(
          'action:"self_update" — status: report install mode + current vs latest version + ' +
            "dev-link note (never errors). update: update to the latest published version " +
            "(refuses on a dev link; no-op when already up to date or for npx).",
        ),
      manager_setting: z
        .enum(MANAGER_CONFIG_ACTIONS)
        .optional()
        .describe(
          'action:"configure_manager" — REQUIRED. Which ComfyUI-Manager setting to change. ' +
            "HTTP API: set_preview_method, set_db_mode, set_component_policy, " +
            "set_update_policy, set_channel, reset_queue. config.ini fallback: " +
            "set_network_mode, set_security_level.",
        ),
      value: z
        .string()
        .optional()
        .describe(
          'action:"configure_manager" — value for the chosen `manager_setting` (omit only for reset_queue). ' +
            "Allowed values per setting — " +
            "set_preview_method: auto | latent2rgb | taesd | none; " +
            "set_db_mode: local | cache | remote; " +
            "set_component_policy: workflow | higher | mine; " +
            "set_update_policy: stable-comfyui | nightly-comfyui; " +
            "set_channel: a channel name (e.g. default); " +
            "set_network_mode: public | private | offline; " +
            "set_security_level: strong | normal | normal- | weak. " +
            "HTTP-API settings take effect live; the config.ini ones " +
            "(set_network_mode, set_security_level) apply only after a ComfyUI restart.",
        ),
    },
    // #1106 — friction-ADDING hints only; see the note on `runpod`. readOnlyHint is
    // deliberately never set: it removes a host confirmation rather than adding one.
    {
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: false,
    },
    async (args) => {
      try {
        switch (args.action) {
          case "install": {
            // target_path cannot be schema-required in a flat shape, so the
            // handler enforces per-action presence and names the missing field —
            // the same information the old per-tool schema gave a caller.
            //
            // ABSENCE only, never falsiness: an empty `target_path` fails the
            // .min(1) value constraint exactly as it did before this
            // consolidation, and the install service's own validation still
            // answers. A `!target_path` guard would swallow that path and
            // substitute generic text.
            if (args.target_path === undefined) {
              throw new Error(
                'install_comfyui action:"install" requires `target_path` — the absolute path to an empty or non-existent directory to install ComfyUI into.',
              );
            }
            if (isRemoteMode()) {
              throw new RemoteModeError(
                'install_comfyui action:"install" installs ComfyUI on the local machine and is not ' +
                  "available when targeting a remote instance via --comfyui-url.",
              );
            }
            const result = installComfyUI({
              targetPath: args.target_path,
              skipManager: args.skip_manager,
              useUv: args.use_uv,
              version: args.version,
            });
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            };
          }
          case "update":
            return await updateComfyUiCoreAction();
          case "update_all":
            return await updateAllAction();
          case "panel":
            return await panelAction(args.panel_action, args.version, args.reason);
          case "self_update":
            return await selfUpdateAction(args.self_update_action);
          case "environment":
            return await getEnvironmentAction();
          case "configure_manager":
            // Same absence-only rule: `manager_setting` is enum-constrained, so
            // an invalid VALUE still fails at the zod layer exactly as the old
            // tool's required `action` did.
            if (args.manager_setting === undefined) {
              throw new Error(
                'install_comfyui action:"configure_manager" requires `manager_setting` — which ComfyUI-Manager setting to change (e.g. set_preview_method, set_db_mode, reset_queue).',
              );
            }
            return await configureManagerAction(args.manager_setting, args.value);
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown install_comfyui action "${String(exhaustive)}". Expected one of: ${ACTIONS.join(", ")}.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
