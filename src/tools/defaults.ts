import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DefaultsManager } from "../services/defaults-manager.js";
import { getSettings, getSetting, setSetting } from "../comfyui/client.js";
import { errorToToolResult } from "../utils/errors.js";

const UNSET_NOTE = "unset (frontend default applies)";

/**
 * The two generation-defaults tools and the two ComfyUI UI-settings tools
 * collapsed into one action-parameterized `get_defaults` tool (0.50.0 surface
 * consolidation, slice 7).
 *
 * TWO STORES, ONE TOOL, AND THEY ARE NOT THE SAME STORE. This is the thing to
 * get right here, because conflating them is a wrong ANSWER, not a cosmetic
 * slip:
 *
 *   - action:"get"/"set" read and write OUR store — the MCP server's own
 *     generation defaults (width, steps, cfg, sampler, checkpoint), resolved
 *     from a config file + COMFYUI_DEFAULT_* env vars + a runtime layer, and
 *     consumed by our workflow-construction tools. Nothing outside comfyui-mcp
 *     reads it. Works with no ComfyUI running at all.
 *   - action:"get_ui"/"set_ui" read and write COMFYUI's OWN store — the
 *     frontend's per-user `Comfy.*` UI settings that its Settings panel writes,
 *     served over HTTP by the ComfyUI user manager. Nothing in comfyui-mcp
 *     consumes it; it changes what the ComfyUI browser UI does. Requires a
 *     reachable local or remote ComfyUI, and is unavailable in Comfy Cloud mode.
 *
 * Setting `steps` in one has no effect on the other, and there is no id or key
 * that exists in both. The `_ui` suffix is the whole signal, so it stays in the
 * action names rather than being folded into a `store` parameter.
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: only `action` can be schema-required — `values` is required for
 * "set" only, `id` is required for "set_ui" but optional for "get_ui", and
 * `value` is required for "set_ui" only. Every VALUE constraint the old tools
 * had is unchanged at the zod layer; the handler enforces per-action presence
 * and names the missing field — the one deliberate behavioural difference a
 * flat enum permits. Each branch calls the same function the old tool called,
 * with the same arguments, and returns the identical content block.
 */
export function registerDefaultsTools(server: McpServer): void {
  server.tool(
    "get_defaults",
    "Read and write settings — either OUR generation defaults or ComfyUI's own frontend UI settings. These are two SEPARATE stores and the `action` says which one you mean:\n" +
      '- action:"get" — Return the merged view of OUR generation defaults with per-source attribution. Precedence (lowest → highest): config file → COMFYUI_DEFAULT_* env vars → runtime overrides via action:"set". Per-call MCP tool args always win over these defaults when consumed by a workflow-construction tool. Read-only, and works even with no ComfyUI running.\n' +
      '- action:"set" — Update OUR generation defaults from `values`. By default updates the in-memory runtime layer (lost on restart); pass persist:true to also write the change into the config file (~/.config/comfyui-mcp/config.json by default). Use this to avoid repeating common values like width, height, steps, cfg, sampler, checkpoint.\n' +
      '- action:"get_ui" — Read COMFYUI\'s OWN per-user frontend UI settings (the Comfy.* ids its Settings panel writes, served by the frontend user manager). This is a DIFFERENT store from action:"get" — nothing here feeds our generation defaults. Read-only. Provide `id` to read one setting\'s raw stored value; omit `id` to list all stored settings (optionally narrowed by `filter`). Known ids include Comfy.Validation.Workflows (boolean; its strictness rejects some custom-node workflows), Comfy.PreviewMethod (auto|latent2rgb|taesd|none), Comfy.LinkRenderMode (0 straight / 1 linear / 2 spline / 3 hidden), Comfy.UseNewMenu, and Comfy.Sidebar.Location. Ids are frontend-defined and stored verbatim; keys never written by the user are absent here and fall back to invisible frontend defaults. Values are surfaced with their raw stored type (no coercion). Requires a reachable local or remote ComfyUI; not available in Comfy Cloud mode.\n' +
      '- action:"set_ui" — Modify one of COMFYUI\'s OWN persisted frontend UI settings by `id`. This writes ComfyUI\'s user settings store, NOT our generation defaults (that is action:"set"). The change is persisted immediately and takes effect on the next frontend load/refresh (an already-open UI tab keeps its old value until reloaded). The value is stored as-is: booleans/numbers are NOT coerced from strings, so pass true (not "true") and 2 (not "2"). Known ids: Comfy.Validation.Workflows (boolean; loosening it lets stricter custom-node workflows load), Comfy.PreviewMethod (auto|latent2rgb|taesd|none), Comfy.LinkRenderMode (0 straight / 1 linear / 2 spline / 3 hidden), Comfy.UseNewMenu, Comfy.Sidebar.Location. Ids are frontend-defined; an unknown id is stored verbatim and simply ignored by the UI. Returns { id, previous, value } — the prior value is read first so you can report and undo the change (previous is null when the key was unset).',
    {
      action: z
        .enum(["get", "set", "get_ui", "set_ui"])
        .describe(
          'Which settings operation to perform, and on WHICH store. "get"/"set" are the MCP server\'s own generation defaults (width, steps, cfg, …); "get_ui"/"set_ui" are ComfyUI\'s separate frontend UI settings (the Comfy.* ids). "get" takes no other parameters; "set" requires `values` (optional `persist`); "get_ui" takes an optional `id` or `filter`; "set_ui" requires `id` + `value`.',
        ),
      values: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          'action:"set" — REQUIRED. Key/value map of GENERATION defaults to set. Keys are typically lowercase (e.g. width, steps). Not for Comfy.* UI ids — those go through action:"set_ui".',
        ),
      persist: z
        .boolean()
        .optional()
        .describe('action:"set" — if true, write to the config file in addition to runtime.'),
      id: z
        .string()
        .optional()
        .describe(
          'ComfyUI UI setting id, e.g. \'Comfy.Validation.Workflows\'. REQUIRED for action:"set_ui". OPTIONAL for action:"get_ui" — omit to list all stored settings.',
        ),
      filter: z
        .string()
        .optional()
        .describe(
          'action:"get_ui" — case-insensitive substring filter on setting ids when listing (e.g. \'preview\'). Ignored when `id` is given.',
        ),
      value: z
        .union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.any()), z.array(z.any())])
        .optional()
        .describe(
          'action:"set_ui" — REQUIRED. New value for the ComfyUI UI setting. Stored as-is; booleans/numbers are NOT coerced from strings (pass true, not "true").',
        ),
    },
    async (args) => {
      try {
        const json = (value: unknown) => ({
          content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
        });

        // values/id/value cannot be schema-required in a flat shape, so the
        // handler enforces per-action presence and names the missing field — the
        // same information the old per-tool schemas gave a caller.
        //
        // ABSENCE only, never falsiness. Each of these passed its old schema and
        // reached the service, which answers on its own terms:
        //   - `values: {}` is a legal no-op set;
        //   - `id: ""` reaches GET/POST /settings/, which answers for itself;
        //   - and `value` is the sharp one — false, 0 and "" are all LEGAL
        //     ComfyUI setting values, and `Comfy.Validation.Workflows: false` is
        //     the single most common real write this tool performs. A `!value`
        //     guard would refuse exactly that call.
        switch (args.action) {
          case "get": {
            // #796 — a config file that exists and failed to load left this
            // reporting the built-in/env defaults as though nothing were wrong,
            // while the user's file sat on disk being ignored. Their renders were
            // already using different settings; the only signal went to a log.
            const configError = DefaultsManager.configLoadError?.();
            return json({
              config_path: DefaultsManager.getConfigPath(),
              defaults: DefaultsManager.getAll(),
              ...(configError
                ? {
                    config_not_applied: {
                      reason: configError,
                      note:
                        `The config file at the path above EXISTS but could not be loaded, so NONE of ` +
                        `its values are in effect — the defaults listed here are the built-in and ` +
                        `environment ones only. Fix that file (a trailing comma is the usual cause) ` +
                        `and reload. Until then, persisting a new default moves the unloadable file ` +
                        `aside rather than overwriting it.`,
                    },
                  }
                : {}),
            });
          }
          case "set": {
            if (args.values === undefined) {
              throw new Error(
                'get_defaults action:"set" requires `values` — the key/value map of generation defaults to set, e.g. {"width":1024,"steps":30}.',
              );
            }
            await DefaultsManager.set(args.values, { persist: args.persist });
            return json({
              status: args.persist ? "updated_runtime_and_config" : "updated_runtime",
              config_path: DefaultsManager.getConfigPath(),
              defaults: DefaultsManager.getAll(),
            });
          }
          case "get_ui": {
            if (args.id !== undefined) {
              const value = await getSetting(args.id);
              return json(
                value === undefined
                  ? { id: args.id, value: null, note: UNSET_NOTE }
                  : { id: args.id, value },
              );
            }

            const all = await getSettings();
            const filter = args.filter?.toLowerCase();
            const settings: Record<string, unknown> = {};
            for (const key of Object.keys(all).sort()) {
              if (filter && !key.toLowerCase().includes(filter)) continue;
              settings[key] = all[key];
            }
            return json({
              count: Object.keys(settings).length,
              note: "Only explicitly-stored settings appear here; unset ids use frontend defaults not exposed by this API.",
              settings,
            });
          }
          case "set_ui": {
            if (args.id === undefined) {
              throw new Error(
                'get_defaults action:"set_ui" requires `id` — the ComfyUI UI setting id, e.g. \'Comfy.Validation.Workflows\'.',
              );
            }
            if (args.value === undefined) {
              throw new Error(
                'get_defaults action:"set_ui" requires `value` — the new value for that ComfyUI UI setting (false and 0 are legal values; omit the field only if you meant a different action).',
              );
            }
            const prev = await getSetting(args.id);
            await setSetting(args.id, args.value);
            return json({
              id: args.id,
              previous: prev === undefined ? null : prev,
              value: args.value,
            });
          }
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown get_defaults action "${String(exhaustive)}". Expected one of: get, set, get_ui, set_ui.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
