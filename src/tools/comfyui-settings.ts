import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSettings, getSetting, setSetting } from "../comfyui/client.js";
import { errorToToolResult } from "../utils/errors.js";

const UNSET_NOTE = "unset (frontend default applies)";

export function registerComfyUISettingsTools(server: McpServer): void {
  server.tool(
    "get_comfyui_settings",
    "Read the ComfyUI frontend's per-user UI settings (the Comfy.* ids the Settings panel writes, served by the frontend user manager). Read-only. This is NOT get_defaults — get_defaults is our own MCP SQLite store, while these are ComfyUI's own persisted UI settings. Provide `id` to read one setting's raw stored value; omit `id` to list all stored settings (optionally narrowed by `filter`). Known ids include Comfy.Validation.Workflows (boolean; its strictness rejects some custom-node workflows), Comfy.PreviewMethod (auto|latent2rgb|taesd|none), Comfy.LinkRenderMode (0 straight / 1 linear / 2 spline / 3 hidden), Comfy.UseNewMenu, and Comfy.Sidebar.Location. Ids are frontend-defined and stored verbatim; keys never written by the user are absent here and fall back to invisible frontend defaults. Values are surfaced with their raw stored type (no coercion). Requires a reachable local or remote ComfyUI; not available in Comfy Cloud mode.",
    {
      id: z
        .string()
        .optional()
        .describe("Setting id, e.g. 'Comfy.Validation.Workflows'. Omit to list all stored settings."),
      filter: z
        .string()
        .optional()
        .describe("Case-insensitive substring filter on setting ids when listing (e.g. 'preview'). Ignored when `id` is given."),
    },
    async (args) => {
      try {
        if (args.id !== undefined) {
          const value = await getSetting(args.id);
          const payload =
            value === undefined ? { id: args.id, value: null, note: UNSET_NOTE } : { id: args.id, value };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          };
        }

        const all = await getSettings();
        const filter = args.filter?.toLowerCase();
        const settings: Record<string, unknown> = {};
        for (const key of Object.keys(all).sort()) {
          if (filter && !key.toLowerCase().includes(filter)) continue;
          settings[key] = all[key];
        }
        const payload = {
          count: Object.keys(settings).length,
          note: "Only explicitly-stored settings appear here; unset ids use frontend defaults not exposed by this API.",
          settings,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "set_comfyui_setting",
    "Modify the ComfyUI user's persisted frontend UI setting by id. This writes ComfyUI's OWN user settings store (the Comfy.* ids the Settings panel manages) — NOT get_defaults/set_defaults, which is our separate MCP store. The change is persisted immediately and takes effect on the next frontend load/refresh (an already-open UI tab keeps its old value until reloaded). The value is stored as-is: booleans/numbers are NOT coerced from strings, so pass true (not \"true\") and 2 (not \"2\"). Known ids: Comfy.Validation.Workflows (boolean; loosening it lets stricter custom-node workflows load), Comfy.PreviewMethod (auto|latent2rgb|taesd|none), Comfy.LinkRenderMode (0 straight / 1 linear / 2 spline / 3 hidden), Comfy.UseNewMenu, Comfy.Sidebar.Location. Ids are frontend-defined; an unknown id is stored verbatim and simply ignored by the UI. Returns { id, previous, value } — the prior value is read first so you can report and undo the change (previous is null when the key was unset).",
    {
      id: z.string().describe("Setting id, e.g. 'Comfy.Validation.Workflows'."),
      value: z
        .union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.any()), z.array(z.any())])
        .describe("New value. Stored as-is; booleans/numbers are NOT coerced from strings (pass true, not \"true\")."),
    },
    async (args) => {
      try {
        const prev = await getSetting(args.id);
        await setSetting(args.id, args.value);
        const result = {
          id: args.id,
          previous: prev === undefined ? null : prev,
          value: args.value,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
