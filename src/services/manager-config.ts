import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, getComfyUIBaseUrl } from "../config.js";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { ComfyUIError, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

/**
 * ComfyUI-Manager configuration, mirroring `comfy-cli manager` capabilities.
 *
 * Mechanism (hybrid):
 *  - Prefer the ComfyUI-Manager HTTP API (works against remote ComfyUI too).
 *  - Fall back to editing Manager's `config.ini` (under config.comfyuiPath) only
 *    for settings the HTTP API cannot change (network_mode, security_level).
 *
 * Endpoints / config keys are taken verbatim from Comfy-Org/ComfyUI-Manager:
 *  - glob/manager_server.py  (HTTP routes: preview_method, db_mode,
 *    policy/component, policy/update, channel_url_list, queue/reset)
 *  - glob/manager_core.py    (config.ini `[default]` section keys + valid values)
 */

export class ManagerConfigError extends ComfyUIError {
  constructor(message: string, details?: unknown) {
    super(message, "MANAGER_CONFIG_ERROR", details);
    this.name = "ManagerConfigError";
  }
}

/** Small Manager-specific fetch helper (no shared client per unit conventions). */
async function managerFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = `${getComfyUIBaseUrl()}${path}`;
  logger.debug("ComfyUI-Manager API request", { url, method: init?.method ?? "GET" });
  let res: Response;
  try {
    res = await comfyuiFetch(url, init);
  } catch (err) {
    throw new ManagerConfigError(
      `Could not reach ComfyUI-Manager at ${url}. Is ComfyUI running with ComfyUI-Manager installed?`,
      { url, cause: err instanceof Error ? err.message : String(err) },
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ManagerConfigError(
      `ComfyUI-Manager API ${res.status}: ${res.statusText || "request failed"}`,
      { url, status: res.status, body },
    );
  }
  return res;
}

// --- Valid values, taken from manager_core.py read_config() defaults ---

// config.ini `[default]` section keys (manager_core.py write_config()).
const VALID_NETWORK_MODES = ["public", "private", "offline"] as const;
const VALID_SECURITY_LEVELS = ["strong", "normal", "normal-", "weak"] as const;

// HTTP-settable values (manager_server.py set_* handlers).
const VALID_PREVIEW_METHODS = ["auto", "latent2rgb", "taesd", "none"] as const;
const VALID_DB_MODES = ["local", "cache", "remote"] as const;
// Component sharing policy dropdown (js/comfyui-manager.js) → switch in
// js/components-manager.js handles 'higher'/'mine'; anything else == 'workflow'.
const VALID_COMPONENT_POLICIES = ["workflow", "higher", "mine"] as const;
// Update policy dropdown (js/comfyui-manager.js); only 'nightly-comfyui' is
// compared server-side (manager_server.py update_comfyui). The bare
// 'stable'/'nightly' values are not valid update_policy settings.
const VALID_UPDATE_POLICIES = ["stable-comfyui", "nightly-comfyui"] as const;

export type NetworkMode = (typeof VALID_NETWORK_MODES)[number];
export type SecurityLevel = (typeof VALID_SECURITY_LEVELS)[number];
export type PreviewMethod = (typeof VALID_PREVIEW_METHODS)[number];
export type DbMode = (typeof VALID_DB_MODES)[number];
export type ComponentPolicy = (typeof VALID_COMPONENT_POLICIES)[number];
export type UpdatePolicy = (typeof VALID_UPDATE_POLICIES)[number];

export interface ManagerConfigResult {
  /** Human-readable description of what was applied. */
  message: string;
  /** Whether the change was applied via the HTTP API ("api") or config.ini ("config-file"). */
  via: "api" | "config-file";
  /** Resulting state value, when known. */
  state?: string;
}

function assertOneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): T {
  if (!allowed.includes(value as T)) {
    throw new ValidationError(
      `Invalid ${label} "${value}". Expected one of: ${allowed.join(", ")}.`,
    );
  }
  return value as T;
}

// --- HTTP-API backed settings ---

/** POST {value} to a Manager endpoint and read the resulting GET state. */
async function setViaApi(
  postPath: string,
  value: string,
  getPath: string = postPath,
): Promise<string> {
  await managerFetch(postPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
  // Read back the resulting state (these GET endpoints return text/plain).
  const res = await managerFetch(getPath, { method: "GET" });
  return (await res.text()).trim();
}

export async function setPreviewMethod(
  value: string,
): Promise<ManagerConfigResult> {
  const v = assertOneOf(value, VALID_PREVIEW_METHODS, "preview method");
  const state = await setViaApi("/manager/preview_method", v);
  return {
    message: `Set ComfyUI-Manager preview method to "${v}".`,
    via: "api",
    state,
  };
}

export async function setDbMode(value: string): Promise<ManagerConfigResult> {
  const v = assertOneOf(value, VALID_DB_MODES, "db mode");
  const state = await setViaApi("/manager/db_mode", v);
  return {
    message: `Set ComfyUI-Manager database mode to "${v}".`,
    via: "api",
    state,
  };
}

export async function setComponentPolicy(
  value: string,
): Promise<ManagerConfigResult> {
  const v = assertOneOf(value, VALID_COMPONENT_POLICIES, "component policy");
  const state = await setViaApi("/manager/policy/component", v);
  return {
    message: `Set ComfyUI-Manager component policy to "${v}".`,
    via: "api",
    state,
  };
}

export async function setUpdatePolicy(
  value: string,
): Promise<ManagerConfigResult> {
  const v = assertOneOf(value, VALID_UPDATE_POLICIES, "update policy");
  const state = await setViaApi("/manager/policy/update", v);
  return {
    message: `Set ComfyUI-Manager update policy to "${v}".`,
    via: "api",
    state,
  };
}

/**
 * Set the active channel by name. The Manager POST expects a channel *name*
 * (e.g. "default", "dev"); it resolves it to a URL internally and ignores
 * unknown names, so we verify against the returned selection.
 */
export async function setChannel(value: string): Promise<ManagerConfigResult> {
  if (!value || !value.trim()) {
    throw new ValidationError("Channel name must be a non-empty string.");
  }
  const name = value.trim();
  await managerFetch("/manager/channel_url_list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: name }),
  });
  const res = await managerFetch("/manager/channel_url_list", { method: "GET" });
  const data = (await res.json()) as { selected?: string };
  const selected = data.selected ?? "custom";
  // Manager silently ignores unknown channel names, leaving selection unchanged.
  if (selected !== name) {
    throw new ManagerConfigError(
      `ComfyUI-Manager did not switch to channel "${name}" (still "${selected}"). The channel name may be unknown.`,
      { requested: name, selected },
    );
  }
  return {
    message: `Set ComfyUI-Manager channel to "${name}".`,
    via: "api",
    state: selected,
  };
}

/**
 * Reset the Manager task queue. This is the runtime, HTTP-reachable analog of
 * `comfy-cli manager clear` (which clears reserved startup actions locally).
 */
export async function resetQueue(): Promise<ManagerConfigResult> {
  await managerFetch("/manager/queue/reset", { method: "POST" });
  return {
    message: "Reset the ComfyUI-Manager task queue (cleared pending actions).",
    via: "api",
  };
}

// --- config.ini fallback for settings with no HTTP setter ---

/**
 * Candidate locations of ComfyUI-Manager's config.ini relative to the ComfyUI
 * install root, newest layout first (see manager_core.update_user_directory /
 * manager_migration.get_manager_path). All live under `<comfyui>/user/`.
 */
function managerConfigCandidates(comfyuiPath: string): string[] {
  return [
    join(comfyuiPath, "user", "__manager", "config.ini"),
    join(comfyuiPath, "user", "default", "ComfyUI-Manager", "config.ini"),
    // Legacy git-clone install location.
    join(comfyuiPath, "custom_nodes", "ComfyUI-Manager", "config.ini"),
  ];
}

function resolveManagerConfigPath(): string {
  if (!config.comfyuiPath) {
    throw new ManagerConfigError(
      "This setting has no ComfyUI-Manager HTTP endpoint and must be written to config.ini, " +
        "but no ComfyUI install path is known. Set COMFYUI_PATH (or run against a local install).",
    );
  }
  const candidates = managerConfigCandidates(config.comfyuiPath);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new ManagerConfigError(
    `Could not find ComfyUI-Manager config.ini under "${config.comfyuiPath}". Looked in: ${candidates.join(", ")}. Is ComfyUI-Manager installed?`,
    { candidates },
  );
}

/**
 * Minimal in-place editor for the `[default]` section of Manager's config.ini.
 * Updates an existing `key = value` line or appends one to the section. Avoids
 * a full INI rewrite so unrelated keys/comments are preserved.
 */
function setIniDefaultKey(contents: string, key: string, value: string): string {
  // Strip any CR/NUL to mirror Manager's own CRLF-injection sanitization.
  const safeValue = value.replace(/[\r\n\x00]/g, "");
  const lines = contents.split("\n");

  let inDefault = false;
  let defaultHeaderIdx = -1;
  let lastDefaultLineIdx = -1;
  const keyRe = new RegExp(`^\\s*${key}\\s*=`, "i");

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const sectionMatch = /^\[(.+)\]\s*$/.exec(trimmed);
    if (sectionMatch) {
      const section = sectionMatch[1].trim().toLowerCase();
      inDefault = section === "default";
      if (inDefault) defaultHeaderIdx = i;
      continue;
    }
    if (inDefault) {
      if (trimmed !== "") lastDefaultLineIdx = i;
      if (keyRe.test(lines[i])) {
        lines[i] = `${key} = ${safeValue}`;
        return lines.join("\n");
      }
    }
  }

  if (defaultHeaderIdx === -1) {
    // No [default] section: append a fresh one.
    const sep = contents.endsWith("\n") || contents === "" ? "" : "\n";
    return `${contents}${sep}[default]\n${key} = ${safeValue}\n`;
  }

  // Insert after the last non-empty line within [default].
  const insertAt = (lastDefaultLineIdx === -1 ? defaultHeaderIdx : lastDefaultLineIdx) + 1;
  lines.splice(insertAt, 0, `${key} = ${safeValue}`);
  return lines.join("\n");
}

function setManagerConfigKeyOnDisk(key: string, value: string): string {
  const path = resolveManagerConfigPath();
  let contents: string;
  try {
    contents = readFileSync(path, "utf-8");
  } catch (err) {
    throw new ManagerConfigError(`Could not read ${path}.`, {
      path,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  const updated = setIniDefaultKey(contents, key, value);
  try {
    writeFileSync(path, updated, "utf-8");
  } catch (err) {
    throw new ManagerConfigError(`Could not write ${path}.`, {
      path,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  return path;
}

export function setNetworkMode(value: string): ManagerConfigResult {
  const v = assertOneOf(value, VALID_NETWORK_MODES, "network mode");
  const path = setManagerConfigKeyOnDisk("network_mode", v);
  return {
    message:
      `Set ComfyUI-Manager network_mode to "${v}" in ${path}. ` +
      "Restart ComfyUI for the change to take effect.",
    via: "config-file",
    state: v,
  };
}

export function setSecurityLevel(value: string): ManagerConfigResult {
  const v = assertOneOf(value, VALID_SECURITY_LEVELS, "security level");
  const path = setManagerConfigKeyOnDisk("security_level", v);
  return {
    message:
      `Set ComfyUI-Manager security_level to "${v}" in ${path}. ` +
      "Restart ComfyUI for the change to take effect.",
    via: "config-file",
    state: v,
  };
}

// --- Action dispatch ---

export const MANAGER_CONFIG_ACTIONS = [
  "set_preview_method",
  "set_db_mode",
  "set_component_policy",
  "set_update_policy",
  "set_channel",
  "reset_queue",
  "set_network_mode",
  "set_security_level",
] as const;

export type ManagerConfigAction = (typeof MANAGER_CONFIG_ACTIONS)[number];

const ACTIONS_REQUIRING_VALUE: ReadonlySet<ManagerConfigAction> = new Set([
  "set_preview_method",
  "set_db_mode",
  "set_component_policy",
  "set_update_policy",
  "set_channel",
  "set_network_mode",
  "set_security_level",
]);

export async function configureManager(
  action: ManagerConfigAction,
  value?: string,
): Promise<ManagerConfigResult> {
  if (ACTIONS_REQUIRING_VALUE.has(action) && (value === undefined || value === "")) {
    throw new ValidationError(`Action "${action}" requires a "value".`);
  }

  switch (action) {
    case "set_preview_method":
      return setPreviewMethod(value as string);
    case "set_db_mode":
      return setDbMode(value as string);
    case "set_component_policy":
      return setComponentPolicy(value as string);
    case "set_update_policy":
      return setUpdatePolicy(value as string);
    case "set_channel":
      return setChannel(value as string);
    case "reset_queue":
      return resetQueue();
    case "set_network_mode":
      return setNetworkMode(value as string);
    case "set_security_level":
      return setSecurityLevel(value as string);
    default: {
      // Exhaustiveness guard.
      const _never: never = action;
      throw new ValidationError(`Unknown action "${_never as string}".`);
    }
  }
}
