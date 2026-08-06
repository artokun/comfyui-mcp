import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isLocalMode } from "../config.js";
import {
  installCustomNode,
  updateCustomNode,
  reinstallCustomNode,
  fixCustomNode,
  disableCustomNode,
  enableCustomNode,
  uninstallCustomNode,
  listInstalledNodes,
  syncNodeDependencies,
  parseGitUrl,
  type InstalledNode,
} from "../services/node-management.js";
import { errorToToolResult } from "../utils/errors.js";
import { getComfyCliVersion, resolveComfyCliExecutable, shouldUseComfyCli } from "../services/comfy-cli.js";
import {
  assertPanelNotTargetedUnverifiable,
  targetsPanelPackExactly,
} from "../services/panel-pin-guard.js";
import { runPanelAction } from "../services/panel-installer.js";
import { SEMVER_RE } from "../services/ui-bridge.js";

/**
 * The sidebar panel pack is an ordinary custom node pack, so `install_custom_node`
 * action:"install" / action:"update" / action:"reinstall" can target it by id. The
 * generic services report success straight off the ComfyUI-Manager queue result,
 * which a stale Manager 3.x drains WITHOUT doing any work (#639) — and they know
 * nothing about `.bak` shadow copies (#641). Reaching the panel through them
 * would therefore reintroduce both bugs through a side door.
 *
 * So a call that names the panel is REDIRECTED into the verified path, which
 * re-reads the pack from disk and fails closed unless it provably moved. (The pin
 * is enforced deeper still, in the services themselves — see panel-pin-guard.ts —
 * so bulk targets like "all" are covered even though they cannot be redirected.)
 */
/**
 * Can the verified panel path honour this git ref as a registry version?
 *
 * The verified path installs from the Comfy Registry, so the only refs it can
 * honour are the ones that ARE registry versions: the channel names, or a
 * strict semver (ui-bridge's canonical grammar; a leading-"v" tag means the
 * same version, and the registry spelling is the bare form). Anything else — a
 * branch, a sha — would silently become something other than what was asked.
 */
function registryInstallableRef(ref: string): string | undefined {
  if (ref === "nightly" || ref === "latest") return ref;
  if (!SEMVER_RE.test(ref)) return undefined;
  return ref.replace(/^v(?=\d)/, "");
}

async function runVerifiedPanelAction(
  action: "install" | "update" | "reinstall",
  id: string,
  opts: { version?: string; ref?: string; source?: string } = {},
) {
  // Options the verified path cannot honour are REFUSED, not dropped. Silently
  // ignoring a caller's `ref` and then reporting success would be doing
  // something other than what was asked — a smaller cousin of the exact lie this
  // whole feature guards against. (`version` IS honoured; it is threaded through.)
  if (opts.ref || opts.source === "git") {
    throw new Error(
      `"${id}" is the comfyui-mcp sidebar panel pack, which is managed through the ` +
        `verified panel path (it re-reads the pack from disk afterwards and fails ` +
        `closed on a ComfyUI-Manager no-op or a shadow copy). That path installs from ` +
        `the Comfy Registry, so a git \`ref\`/\`source: "git"\` cannot be honoured and ` +
        `will NOT be silently ignored. Drop the git options to install it normally, ` +
        `or manage a git checkout of the panel yourself (a symlinked dev install is ` +
        `never touched by these tools).`,
    );
  }

  // A ref EMBEDDED in the id itself ("...comfyui-mcp-panel.git@v0.11.28",
  // ".../tree/v0.11.28") is just as much a requested version as the `version`
  // option — and it used to DIE here: targetsPanelPackExactly matched the URL,
  // the redirect threaded only `version`, and the user got NIGHTLY while the
  // response implied success. Honour the refs the registry path can honour;
  // refuse the rest, exactly like the git options above.
  const embeddedRef = parseGitUrl(id).ref;
  let version = opts.version;
  if (embeddedRef) {
    const registryVersion = registryInstallableRef(embeddedRef);
    if (!registryVersion) {
      throw new Error(
        `"${id}" embeds git ref "${embeddedRef}", which the verified panel path ` +
          `cannot honour: it installs the comfyui-mcp sidebar panel pack from the ` +
          `Comfy Registry, where only a strict semver (e.g. v0.11.28), "nightly" or ` +
          `"latest" names a version. Use a release tag, or pass \`version\` instead.`,
      );
    }
    if (version && version !== registryVersion) {
      throw new Error(
        `Conflicting panel versions: the id embeds "@${embeddedRef}" but ` +
          `\`version\` says "${version}". Pick one — this tool will not guess.`,
      );
    }
    if (action === "update") {
      throw new Error(
        `"${id}" embeds git ref "${embeddedRef}", but update always pulls the ` +
          `channel tip — a ref cannot be honoured. Use install/reinstall with the ` +
          `ref to get a specific panel version.`,
      );
    }
    version = registryVersion;
  }

  const result = await runPanelAction(action, undefined, { version });
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            ...result,
            routedVia: "install_comfyui(action:\'panel\')",
            note:
              `"${id}" is the comfyui-mcp sidebar panel pack, so this ${action} ran ` +
              `through the verified panel path: the version above was RE-READ from ` +
              `disk after the operation, and a Manager no-op or a shadow copy would ` +
              `have failed instead of reporting success. ` +
              (version
                ? embeddedRef
                  ? `The ref embedded in the URL (@${embeddedRef}) was honoured as ` +
                    `the target version (${version}). `
                  : `Your requested version (${version}) was used as the target. `
                : `It targets the 'nightly' channel. `) +
              `The mode/channel/useCmCli options do not apply on this path. Use ` +
              `install_comfyui(action:\'panel\') directly for status/sync/pin.`,
          },
          null,
          2,
        ),
      },
    ],
  };
}

/** Graceful "not supported remotely" tool result (no isError), matching the
 *  degrade-don't-throw pattern list_local_models uses. */
function remoteUnsupported(message: string) {
  return { content: [{ type: "text" as const, text: message }] };
}

function preferLocalComfyCli(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  if (!isLocalMode()) return false;
  const executable = resolveComfyCliExecutable();
  if (!executable) return false;
  return shouldUseComfyCli(
    undefined,
    true,
    executable,
    getComfyCliVersion(),
  );
}

/**
 * `mode` means two DIFFERENT things in this family, and the fold has to carry
 * both without renaming either.
 *
 * - install/update/reinstall/fix took `mode: "remote"|"local"|"cache"` — the
 *   ComfyUI-Manager DATA SOURCE.
 * - list took `mode: "default"|"imported"` — WHICH installed packs to report.
 *
 * A flat schema has one `mode`, so the enum is the union and the handler
 * refuses a value the chosen action cannot honour, naming the ones it can. That
 * refusal is not new behaviour: the retired installed-list tool rejected
 * mode:"remote" too, at the zod layer — the fold only MOVES the
 * rejection into the handler, where it can say which values are valid for the
 * action you asked for instead of listing all five.
 *
 * Renaming one of them (`list_mode`) was the obvious alternative and is worse:
 * DEAD_NAMES advertises a mechanical migration (the retired list tool's `{mode}` →
 * `install_custom_node({action:"list", mode})`), and a rename breaks exactly
 * that rewrite with an "unrecognized key" error that names no remedy.
 */
const MANAGER_MODES = ["remote", "local", "cache"] as const;
const LIST_MODES = ["default", "imported"] as const;
type ManagerModeValue = (typeof MANAGER_MODES)[number];
type ListModeValue = (typeof LIST_MODES)[number];

const modeSchema = z
  .enum([...MANAGER_MODES, ...LIST_MODES])
  .optional()
  .describe(
    'Two distinct meanings, one per action group. For actions "install"/"update"/"reinstall"/"fix": the ComfyUI-Manager data source (default \'remote\'); \'remote\' fetches the live node list, \'local\'/\'cache\' use bundled/cached data. For action:"list": \'default\' lists all installed packs, \'imported\' lists only those successfully imported this session. Passing a value from the wrong group is refused, naming the ones the action accepts.',
  );

const useCmCliSchema = z
  .boolean()
  .optional()
  .describe(
    'Prefer the official comfy-cli subprocess instead of the ComfyUI-Manager HTTP API. Local operations use comfy-cli by default; set false to force Manager HTTP. Requires a local ComfyUI install — for actions "install"/"disable"/"enable"/"uninstall", an unavailable CLI falls back to Manager HTTP automatically (disclosed in the result); "update"/"reinstall"/"fix"/"list" do not fall back.',
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
      const state =
        n.enabled === undefined ? "state unknown" : n.enabled ? "enabled" : "disabled";
      return (
        `${i + 1}. ${n.module}${idStr}\n` +
        `   version: ${n.version ?? "unknown"} | ${state}`
      );
    })
    .join("\n");
}

/**
 * The nine custom-node LIFECYCLE tools collapsed into one action-parameterized
 * `install_custom_node` tool (0.50.0 surface consolidation, slice 12).
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: only `action` can be schema-required — `id` is required for the
 * seven pack-targeting actions and meaningless for "list"/"sync_deps". Every
 * VALUE constraint the old tools had is unchanged at the zod layer (`source`
 * keeps its enum, `mode` the union of the two vocabularies documented above);
 * the handler enforces per-action presence and names the missing field — the one
 * deliberate behavioural difference a flat enum permits. Each branch calls the
 * same service function the old tool called, with the same arguments, and
 * returns the identical content block (JSON for the mutations, the formatted
 * list for "list").
 *
 * NINE actions, not the RFC's ~8. `disable`/`enable`/`uninstall` shipped in #775
 * AFTER the consolidation plan was measured, and they are custom-node lifecycle
 * verbs by any reading — a pack you install is a pack you disable and remove.
 *
 * REGISTRY DISCOVERY IS NOT HERE. Searching registry.comfy.org and reading one
 * pack's details live in `search_custom_nodes`, which survives as its own
 * two-action tool. Everything on THIS tool either runs third-party pack code
 * (install/update/reinstall/fix/sync_deps) or mutates what is installed
 * (uninstall/enable/disable); the two registry lookups are read-only and
 * network-only and need neither a running ComfyUI nor COMFYUI_PATH. Different
 * blast radius — and the NAME is the unit that both the call_tool whitelist and
 * the ollama loop-breaker reason about, so the split is what lets each of them
 * stay honest without per-action special cases.
 *
 * ADMISSION: `install_custom_node` is on the orchestrator's direct call_tool
 * whitelist, which authorizes by NAME and then forwards arbitrary action
 * arguments. Only the retired install entry and the retired installed-list
 * entry were ever whitelisted, so the folded name is ACTION-scoped to exactly
 * install+list — see CALL_TOOL_ACTION_WHITELIST in
 * src/orchestrator/call-tool-admission.ts.
 */
export function registerNodeManagementTools(server: McpServer): void {
  server.tool(
    "install_custom_node",
    "Install, repair, enable/disable and remove ComfyUI custom node packs on this ComfyUI. To FIND a pack in the public registry first, use search_custom_nodes. Driven by the `action` parameter:\n" +
      '- action:"install" — Install a pack by registry id, git URL, or name. Local installs prefer official comfy-cli when available; remote or CLI-unavailable installs use the ComfyUI-Manager HTTP API. A ComfyUI restart may be required. Targeting the comfyui-mcp sidebar panel pack (\'comfyui-agent-panel\' / \'comfyui-mcp-panel\') is routed through the verified install_comfyui(action:\'panel\') path (the version is re-read from disk afterwards) and is REFUSED while the panel is version-pinned.\n' +
      '- action:"update" — Update an installed pack, or pass id:\'all\' to update every installed pack. Local operations prefer official comfy-cli; remote operations use Manager HTTP. Targeting the sidebar panel pack is routed through the verified install_comfyui(action:\'panel\') path. While the panel is version-pinned, BOTH a direct panel target and \'all\' are REFUSED — \'all\' would move the pinned panel too; clear the pin with install_comfyui(action:\'panel\')(action=\'unpin\') or update other packs individually.\n' +
      '- action:"reinstall" — Reinstall a pack. Local operations prefer official comfy-cli; remote operations use Manager HTTP. A ComfyUI restart may be required. A panel target is routed through the verified install_comfyui(action:\'panel\') path and is REFUSED while the panel is version-pinned.\n' +
      '- action:"fix" — Repair a pack\'s install and Python dependencies, or pass id:\'all\' to repair every pack. Local operations prefer official comfy-cli; remote single-pack repairs use Manager HTTP. REFUSES the sidebar panel pack — \'fix\' has no verified on-disk check, so use install_comfyui(action:\'panel\') for the panel — and refuses \'all\' while the panel is version-pinned.\n' +
      '- action:"uninstall" — Uninstall a pack (removes it). IRREVERSIBLE through this tool — for a cleanup audit prefer action:"disable", which is reversible. The pack must be one ComfyUI-Manager tracks: an id that resolves nowhere is REFUSED before anything is queued (a drained queue would otherwise read exactly like a success), and a pack that is on disk but unmanaged is named so you can remove its directory yourself. After the queue drains the installed-pack list is re-read and the pack must be GONE before anything claims \'uninstalled\'. A ComfyUI restart is required to unload it fully. REFUSES the sidebar panel pack.\n' +
      '- action:"disable" — Disable an installed pack WITHOUT removing it — the reversible first step of a cleanup (re-enable with action:"enable"; action:"uninstall" removes a pack outright). Uses the ComfyUI-Manager HTTP API (works against remote instances) or official comfy-cli locally, and re-reads the installed-pack list afterwards so a Manager no-op is reported as NOT disabled rather than as success. A ComfyUI restart is required for the change to take effect. REFUSES the sidebar panel pack.\n' +
      '- action:"enable" — Re-enable a pack previously disabled with action:"disable". Same Manager/comfy-cli mechanics and the same post-op re-read, so a Manager no-op is reported as NOT enabled rather than as success. A ComfyUI restart is required for the change to take effect. REFUSES the sidebar panel pack.\n' +
      '- action:"list" — List installed packs with their version and enabled/disabled state. Uses the ComfyUI-Manager HTTP API (works against remote instances); the cm-cli fallback returns names only. Read-only.\n' +
      '- action:"sync_deps" — Reconcile the Python dependencies of ALL installed packs through official `comfy node restore-dependencies`. Requires a local ComfyUI install and comfy-cli; takes no other parameters.',
    {
      action: z
        .enum([
          "install",
          "update",
          "reinstall",
          "fix",
          "uninstall",
          "enable",
          "disable",
          "list",
          "sync_deps",
        ])
        .describe(
          'Which custom-node operation to perform. "install", "update", "reinstall", "fix", "uninstall", "enable" and "disable" require `id`; "list" and "sync_deps" take no required parameters.',
        ),
      id: z
        .string()
        .optional()
        .describe(
          'The pack to act on. REQUIRED for actions "install", "update", "reinstall", "fix", "uninstall", "enable" and "disable". For "install" this is a registry id, git URL, or node-pack name (find one with search_custom_nodes); for "update"/"fix" it may also be \'all\' (every installed pack); for "update"/"reinstall"/"fix"/"uninstall"/"enable"/"disable" it is a registry id / module name of an INSTALLED pack.',
        ),
      source: z
        .enum(["registry", "git", "auto"])
        .optional()
        .describe(
          'action:"install" — how to interpret `id` (default \'auto\', which detects git URLs vs registry ids).',
        ),
      version: z
        .string()
        .optional()
        .describe(
          'Version to install. action:"install" — e.g. \'latest\', \'nightly\', or a semver; for git installs this is treated as a git ref unless `ref` is also provided, and registry installs default to \'latest\'. action:"reinstall" — version to reinstall (default \'latest\').',
        ),
      ref: z
        .string()
        .optional()
        .describe(
          'action:"install" — git ref (commit SHA, branch, or tag) to pin when installing a git URL. Overrides any ref parsed from the URL and any `version` value. Ignored for registry-id installs.',
        ),
      mode: modeSchema,
      channel: channelSchema,
      useCmCli: useCmCliSchema,
    },
    async (args) => {
      // `id`/`query` cannot be schema-required in a flat shape, so the handler
      // enforces per-action presence and names the missing field — the same
      // information the old per-tool schemas gave a caller.
      //
      // ABSENCE only, never falsiness: `id: ""` passed z.string() before this
      // consolidation and reached the service, which answers with its own
      // resolves-nowhere / not-found error (and for uninstall, a REFUSAL before
      // anything is queued). A `!id` guard would swallow that path and answer
      // with generic text instead.
      const requireId = (action: string, what: string): string => {
        if (args.id === undefined) {
          throw new Error(`install_custom_node action:"${action}" requires \`id\` — ${what}.`);
        }
        return args.id;
      };

      // The `mode` union split back into the two meanings it carries — see
      // modeSchema. Refusal, never a silent drop: quietly ignoring a `mode` the
      // action cannot honour would run a DIFFERENT operation than the one asked
      // for and report it as success.
      const managerMode = (action: string): ManagerModeValue | undefined => {
        if (args.mode === undefined) return undefined;
        if ((MANAGER_MODES as readonly string[]).includes(args.mode)) {
          return args.mode as ManagerModeValue;
        }
        throw new Error(
          `install_custom_node action:"${action}" does not accept mode:"${args.mode}" — ` +
            `that value belongs to action:"list". Here \`mode\` selects the ComfyUI-Manager ` +
            `data source: ${MANAGER_MODES.map((m) => `"${m}"`).join(", ")}.`,
        );
      };
      const listMode = (): ListModeValue | undefined => {
        if (args.mode === undefined) return undefined;
        if ((LIST_MODES as readonly string[]).includes(args.mode)) {
          return args.mode as ListModeValue;
        }
        throw new Error(
          `install_custom_node action:"list" does not accept mode:"${args.mode}" — ` +
            `that value is the ComfyUI-Manager data source used by ` +
            `action:"install"/"update"/"reinstall"/"fix". Here \`mode\` selects WHICH ` +
            `installed packs to report: ${LIST_MODES.map((m) => `"${m}"`).join(", ")}.`,
        );
      };

      const json = (value: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
      });

      // `fix` id="all" degrades gracefully rather than throwing, and that check
      // ran BEFORE the try/catch in the retired tool (it is a capability
      // statement, not an error). Order preserved: the remote refusal still
      // wins over anything the try block would report.
      if (args.action === "fix" && args.id?.trim().toLowerCase() === "all" && !isLocalMode()) {
        // "all" repairs every pack via the cm-cli subprocess, which needs a local
        // ComfyUI install. Single-pack repair uses the Manager HTTP API and works
        // remotely, so only guard the "all" case here.
        return remoteUnsupported(
          'install_custom_node action:"fix" with id="all" is not supported against a remote ComfyUI. ' +
            "Repairing every pack runs the cm-cli subprocess, which requires a " +
            "local ComfyUI install (COMFYUI_PATH). Repair a single pack by id " +
            "instead (that uses the ComfyUI-Manager HTTP API and works remotely).",
        );
      }
      if (args.action === "sync_deps" && !isLocalMode()) {
        return remoteUnsupported(
          'install_custom_node action:"sync_deps" is not supported against a remote ComfyUI. It ' +
            "runs the cm-cli restore-dependencies subprocess, which requires a " +
            "local ComfyUI install (COMFYUI_PATH). Reconcile dependencies on the " +
            "ComfyUI host instead.",
        );
      }

      try {
        switch (args.action) {
          case "install": {
            const id = requireId("install", "the registry id, git URL, or node-pack name to install");
            // BEFORE the panel branch, deliberately. `mode` was a zod-validated
            // field on every retired tool, so an invalid value was rejected
            // before ANY handler logic ran — including the panel redirect. Doing
            // the redirect first would let mode:"imported" ride into a verified
            // panel mutation that silently ignores it, turning a rejection into
            // an acceptance. (The redirect ignoring a VALID mode is pre-existing
            // and disclosed in its own note; a value the action never accepted
            // is not.)
            const mode = managerMode("install");
            if (targetsPanelPackExactly(id)) {
              return await runVerifiedPanelAction("install", id, {
                version: args.version,
                ref: args.ref,
                source: args.source,
              });
            }
            return json(
              await installCustomNode({
                id,
                source: args.source,
                version: args.version,
                ref: args.ref,
                mode,
                channel: args.channel,
                useCmCli: preferLocalComfyCli(args.useCmCli),
              }),
            );
          }
          case "update": {
            const id = requireId("update", "the registry id / module name to update, or 'all'");
            const mode = managerMode("update"); // before the panel branch — see action:"install"
            if (targetsPanelPackExactly(id)) {
              return await runVerifiedPanelAction("update", id);
            }
            return json(
              await updateCustomNode({
                id,
                mode,
                channel: args.channel,
                useCmCli: preferLocalComfyCli(args.useCmCli),
              }),
            );
          }
          case "reinstall": {
            const id = requireId("reinstall", "the registry id / module name to reinstall");
            const mode = managerMode("reinstall"); // before the panel branch — see action:"install"
            if (targetsPanelPackExactly(id)) {
              return await runVerifiedPanelAction("reinstall", id, {
                version: args.version,
              });
            }
            return json(
              await reinstallCustomNode({
                id,
                version: args.version,
                mode,
                channel: args.channel,
                useCmCli: preferLocalComfyCli(args.useCmCli),
              }),
            );
          }
          case "fix": {
            const id = requireId("fix", "the registry id / module name to repair, or 'all'");
            const mode = managerMode("fix"); // before the panel branch — see action:"install"
            // `fix` has no verified equivalent (it reports success off the Manager
            // queue, which proves nothing — #639), so a panel target is refused
            // rather than redirected. Bulk "all" is handled by the pin guard inside
            // the service.
            if (targetsPanelPackExactly(id)) {
              assertPanelNotTargetedUnverifiable('install_custom_node action:"fix"', id);
            }
            return json(
              await fixCustomNode({
                id,
                mode,
                channel: args.channel,
                useCmCli: preferLocalComfyCli(args.useCmCli),
              }),
            );
          }
          case "uninstall": {
            const id = requireId("uninstall", "the registry id / module name of the installed pack to uninstall");
            if (targetsPanelPackExactly(id)) {
              assertPanelNotTargetedUnverifiable('install_custom_node action:"uninstall"', id);
            }
            return json(
              await uninstallCustomNode({
                id,
                useCmCli: preferLocalComfyCli(args.useCmCli),
              }),
            );
          }
          case "disable": {
            const id = requireId("disable", "the registry id / module name of the installed pack to disable");
            // Same refusal as action:"fix": this path's post-state check reads
            // the Manager list, which cannot see a ".bak" shadow copy (#641) — the
            // panel goes through the verified install_comfyui(action:\'panel\') path only.
            if (targetsPanelPackExactly(id)) {
              assertPanelNotTargetedUnverifiable('install_custom_node action:"disable"', id);
            }
            return json(
              await disableCustomNode({
                id,
                useCmCli: preferLocalComfyCli(args.useCmCli),
              }),
            );
          }
          case "enable": {
            const id = requireId("enable", "the registry id / module name of the installed pack to enable");
            if (targetsPanelPackExactly(id)) {
              assertPanelNotTargetedUnverifiable('install_custom_node action:"enable"', id);
            }
            return json(
              await enableCustomNode({
                id,
                useCmCli: preferLocalComfyCli(args.useCmCli),
              }),
            );
          }
          case "list": {
            const nodes = await listInstalledNodes({
              mode: listMode(),
              useCmCli: args.useCmCli,
            });
            return {
              content: [{ type: "text" as const, text: formatInstalledNodes(nodes) }],
            };
          }
          case "sync_deps":
            return json(await syncNodeDependencies());
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown install_custom_node action "${String(exhaustive)}". Expected one of: install, update, reinstall, fix, uninstall, enable, disable, list, sync_deps.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
