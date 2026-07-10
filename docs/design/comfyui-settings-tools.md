# ComfyUI `/settings` read/write tools

**Status:** implemented (this PR)

> **Safety gating deferred.** The original design gated `set_comfyui_setting` behind a `settings-writes` safety gate (spec PR #172). That gates effort was closed/deferred; gating is now tracked under **ROADMAP Theme G**. This PR ships `set_comfyui_setting` **ungated** — its tool description states plainly that it modifies the ComfyUI user's persisted UI settings and that changes take effect on the next frontend load/refresh.

> Prior art: [filliptm/ComfyUI_FL-MCP](https://github.com/filliptm/ComfyUI_FL-MCP) `comfy_settings_get`/`comfy_settings_set`. We add filtering, previous-value capture for undo, multi-user/version-drift handling, and gate integration.

## Motivation

ComfyUI's frontend persists per-user settings via `GET /settings`, `GET /settings/{id}`, `POST /settings/{id}` (served by the user manager). Our `get_defaults`/`set_defaults` is our own SQLite store — unrelated. Agents currently cannot toggle e.g. `Comfy.Validation.Workflows` (whose strictness rejects some custom-node workflows), the link render mode, or `Comfy.PreviewMethod`; the panel agent has real use cases (diagnose "why does the user's UI reject this workflow", set preview method before long jobs).

## Tool API

### `get_comfyui_settings` — read-only, category `server`

```ts
{
  id: z.string().optional()
    .describe("Setting id, e.g. 'Comfy.Validation.Workflows'. Omit to list all settings."),
  filter: z.string().optional()
    .describe("Case-insensitive substring filter on setting ids when listing (e.g. 'preview')."),
}
```

With `id`: `{ id, value }` — value is the raw stored JSON, or an explicit "unset (frontend default applies)" note. Without `id`: a sorted `id: value` listing (filtered), with a caveat that unset keys use frontend defaults invisible to this API.

### `set_comfyui_setting` — write, category `server` (ungated; gating deferred to ROADMAP Theme G)

```ts
{
  id: z.string().describe("Setting id, e.g. 'Comfy.Validation.Workflows'"),
  value: z.union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.any()), z.array(z.any())])
    .describe("New value. Stored as-is; booleans/numbers are NOT coerced from strings."),
}
```

Result: `{ id, previous, value }` — the old value is read first so the agent can report and undo. The description enumerates useful known ids — `Comfy.Validation.Workflows` (boolean), `Comfy.PreviewMethod` (`auto|latent2rgb|taesd|none`), `Comfy.LinkRenderMode` (0 straight / 1 linear / 2 spline / 3 hidden), `Comfy.UseNewMenu`, `Comfy.Sidebar.Location` — and notes that ids are frontend-defined: unknown ids are stored verbatim and ignored by the UI, and changes take effect on the next frontend load/refresh.

Gating: **deferred to ROADMAP Theme G.** This tool ships ungated in this PR. Because it is server/user config, when gates land it belongs to a dedicated `settings-writes` category — deliberately **not** the `workflow-writes` category. Until then, the tool description makes the write and its "takes effect on next frontend load/refresh" semantics explicit.

## Implementation

### Client integration — `src/comfyui/client.ts`

Follow the exact `freeMemory`/`getLogs` pattern (`getClient().fetchApi(...)`, cloud-mode dispatch):

```ts
export async function getSettings(): Promise<Record<string, unknown>>       // GET /settings
export async function getSetting(id: string): Promise<unknown>              // GET /settings/{encodeURIComponent(id)}
export async function setSetting(id: string, value: unknown): Promise<void> // POST /settings/{id}, JSON body = raw value
```

- Cloud mode: `requireLocalMode("settings")` — Comfy Cloud exposes no per-user settings store; simplest correct behavior, revisit if that changes. Remote mode works (plain REST) and inherits `comfyuiFetch` auth headers.

### Version drift / error handling

- Multi-user ComfyUI (`--multi-user`) requires a `comfy-user` header; without it `/settings` can 404 or hit another user's store. Document that multi-user servers need `COMFYUI_AUTH_COMFY_USER` set (headers already injected by `comfyuiFetch`).
- 404 on the bare `/settings` route → clear error: "This ComfyUI version/config does not expose the user settings API (requires the standard frontend user manager)."
- `GET /settings/{id}` for an unset key returns empty body on some versions and `null` on others — treat empty/`null`/parse-failure uniformly as "unset (frontend default applies)".
- Older frontends store some values as strings (`"true"`) — pass through verbatim, never coerce; surface the raw stored type.

### New tool file — `src/tools/comfyui-settings.ts`

`registerComfyUISettingsTools(server)`, registered as `["server", registerComfyUISettingsTools]` **appended at the end of `TOOL_GROUPS`** (registration order is observable per `index.ts:53-57` — never insert mid-list). Errors via `errorToToolResult` (`src/utils/errors.ts`).

## Test plan (vitest)

`src/__tests__/tools/comfyui-settings.test.ts` (pattern: `queue-management.test.ts` — `vi.mock` the client): list + filter rendering; single get incl. unset-key handling; set returns `{previous, value}`; 404 → friendly version-drift error; cloud mode throws `CLOUD_UNSUPPORTED`. Optional integration test under `COMFYUI_INTEGRATION=true`: get → set → restore round-trip on a scratch key.

## Rollout / compat

Additive. Ships ungated (safety gating deferred to ROADMAP Theme G). If/when gates land, the future `settings-writes` category wraps `set_comfyui_setting` via `TOOL_GATES`; no tool-surface change is required. Until then, the tool description states that it modifies the ComfyUI user's persisted UI settings and takes effect on the next frontend load/refresh.
