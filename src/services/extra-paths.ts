import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { config } from "../config.js";
import { ValidationError } from "../utils/errors.js";

export const EXTRA_PATH_TARGETS = ["auto", "standalone", "desktop"] as const;
export type ExtraPathTarget = (typeof EXTRA_PATH_TARGETS)[number];

export interface ExtraPathCategory {
  category: string;
  paths: string[];
}

export interface ExtraPathGroup {
  name: string;
  base_path?: string;
  is_default?: unknown;
  categories: ExtraPathCategory[];
}

export interface ExtraPathsConfigInfo {
  target: Exclude<ExtraPathTarget, "auto">;
  path: string;
  exists: boolean;
  groups: ExtraPathGroup[];
  notes: string[];
}

export interface ExtraPathMutationResult extends ExtraPathsConfigInfo {
  changed: boolean;
  message: string;
}

interface ExtraPathOptions {
  target?: ExtraPathTarget;
  configPath?: string;
}

interface ExtraPathMutationOptions extends ExtraPathOptions {
  group?: string;
  category: string;
  path: string;
  isDefault?: boolean;
}

const RESERVED_KEYS = new Set(["base_path", "is_default"]);
const SAFE_KEY_RE = /^[A-Za-z0-9_.-]+$/;
const CONTROL_RE = /[\x00\r\n]/;

function assertSafeKey(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError(`${label} must be a non-empty string.`);
  if (!SAFE_KEY_RE.test(trimmed)) {
    throw new ValidationError(
      `${label} may contain only letters, numbers, dot, dash, and underscore: ${value}`,
    );
  }
  return trimmed;
}

function assertPathValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError("Path must be a non-empty string.");
  if (CONTROL_RE.test(trimmed)) {
    throw new ValidationError("Path must not contain NUL or newline characters.");
  }
  return trimmed;
}

function desktopConfigPath(): string {
  const p = platform();
  if (p === "win32") {
    const root = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(root, "ComfyUI", "extra_models_config.yaml");
  }
  if (p === "darwin") {
    return join(homedir(), "Library", "Application Support", "ComfyUI", "extra_models_config.yaml");
  }
  const root = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(root, "ComfyUI", "extra_models_config.yaml");
}

function standaloneConfigPath(): string {
  if (!config.comfyuiPath) {
    throw new ValidationError(
      "No local ComfyUI path is known. Set COMFYUI_PATH, set a default workspace, " +
        "or pass config_path explicitly.",
    );
  }
  return join(config.comfyuiPath, "extra_model_paths.yaml");
}

function resolveTargetPath(opts: ExtraPathOptions = {}): {
  target: Exclude<ExtraPathTarget, "auto">;
  path: string;
} {
  if (opts.configPath) {
    return {
      target: opts.target === "desktop" ? "desktop" : "standalone",
      path: opts.configPath,
    };
  }

  const target = opts.target ?? "auto";
  if (target === "desktop") return { target, path: desktopConfigPath() };
  if (target === "standalone") return { target, path: standaloneConfigPath() };

  const desktop = desktopConfigPath();
  if (existsSync(desktop)) return { target: "desktop", path: desktop };
  return { target: "standalone", path: standaloneConfigPath() };
}

function splitPaths(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((line) => line.trim())
      .filter(Boolean);
  }
  return [];
}

function readGroup(raw: unknown, name: string): ExtraPathGroup | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const categories: ExtraPathCategory[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (RESERVED_KEYS.has(key)) continue;
    const paths = splitPaths(value);
    if (paths.length > 0) categories.push({ category: key, paths });
  }
  return {
    name,
    base_path: typeof obj.base_path === "string" ? obj.base_path : undefined,
    is_default: obj.is_default,
    categories,
  };
}

function parseConfig(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const parsed = parseYaml(text, { maxAliasCount: 50 });
  if (parsed == null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError("Extra paths config must be a YAML object.");
  }
  return parsed as Record<string, unknown>;
}

async function readConfigFile(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  return parseConfig(await readFile(path, "utf-8"));
}

function summarize(
  target: Exclude<ExtraPathTarget, "auto">,
  path: string,
  raw: Record<string, unknown>,
): ExtraPathsConfigInfo {
  const groups: ExtraPathGroup[] = [];
  for (const [name, value] of Object.entries(raw)) {
    const group = readGroup(value, name);
    if (group) groups.push(group);
  }
  const notes = [
    target === "desktop"
      ? "Desktop uses extra_models_config.yaml in the OS ComfyUI app-data directory."
      : "Standalone/manual installs use extra_model_paths.yaml in the ComfyUI root.",
    "Categories are generic ComfyUI search-path keys, so model folders and custom_nodes can both be represented when supported by the running ComfyUI build.",
    "Restart ComfyUI after editing this file so startup path registration is rebuilt.",
  ];
  return { target, path, exists: existsSync(path), groups, notes };
}

export async function listExtraPaths(
  opts: ExtraPathOptions = {},
): Promise<ExtraPathsConfigInfo> {
  const resolved = resolveTargetPath(opts);
  const raw = await readConfigFile(resolved.path);
  return summarize(resolved.target, resolved.path, raw);
}

/** One model search directory contributed by extra_model_paths configuration. */
export interface ExtraModelRoot {
  /** The ComfyUI category key (e.g. "checkpoints", "loras") the dir serves. */
  category: string;
  /** Absolute directory on disk that ComfyUI loads this category's models from. */
  dir: string;
  /** The owning config group name (for diagnostics). */
  group: string;
}

/**
 * Enumerate every model directory declared in the active extra_model_paths /
 * extra_models_config file — i.e. the same extra roots (often on other drives
 * like E:\) that ComfyUI itself loads models from. Each entry pairs a category
 * key with the absolute directory that serves it (paths are resolved against the
 * group's base_path when relative). Returns [] when no config exists or no local
 * ComfyUI path is known. Best-effort: never throws (a malformed/unreadable
 * config yields []), so callers can treat extra roots as an additive search set.
 */
export async function getExtraModelRoots(
  opts: ExtraPathOptions = {},
): Promise<ExtraModelRoot[]> {
  let info: ExtraPathsConfigInfo;
  try {
    info = await listExtraPaths(opts);
  } catch {
    return [];
  }
  const roots: ExtraModelRoot[] = [];
  for (const group of info.groups) {
    const base = group.base_path?.trim();
    for (const category of group.categories) {
      for (const p of category.paths) {
        const dir = isAbsolute(p)
          ? resolve(p)
          : base
            ? resolve(base, p)
            : resolve(p);
        roots.push({ category: category.category, dir, group: group.name });
      }
    }
  }
  return roots;
}

function ensureGroup(raw: Record<string, unknown>, name: string): Record<string, unknown> {
  const existing = raw[name];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const group: Record<string, unknown> = {};
  raw[name] = group;
  return group;
}

async function writeConfigFile(path: string, raw: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringifyYaml(raw, { lineWidth: 0 }), "utf-8");
}

export async function addExtraPath(
  opts: ExtraPathMutationOptions,
): Promise<ExtraPathMutationResult> {
  const resolved = resolveTargetPath(opts);
  const groupName = assertSafeKey(opts.group ?? "comfyui_mcp", "Group");
  const category = assertSafeKey(opts.category, "Category");
  const nextPath = assertPathValue(opts.path);
  if (RESERVED_KEYS.has(category)) {
    throw new ValidationError(`"${category}" is a reserved config key, not a path category.`);
  }

  const raw = await readConfigFile(resolved.path);
  const group = ensureGroup(raw, groupName);
  if (opts.isDefault !== undefined && group.is_default === undefined) {
    group.is_default = opts.isDefault;
  }

  const paths = splitPaths(group[category]);
  const changed = !paths.includes(nextPath);
  if (changed) {
    paths.push(nextPath);
    group[category] = paths.join("\n");
    await writeConfigFile(resolved.path, raw);
  }
  const info = summarize(resolved.target, resolved.path, raw);
  return {
    ...info,
    changed,
    message: changed
      ? `Added ${nextPath} to ${groupName}.${category}. Restart ComfyUI to apply it.`
      : `${nextPath} is already present in ${groupName}.${category}.`,
  };
}

export async function removeExtraPath(
  opts: ExtraPathMutationOptions,
): Promise<ExtraPathMutationResult> {
  const resolved = resolveTargetPath(opts);
  const groupName = assertSafeKey(opts.group ?? "comfyui_mcp", "Group");
  const category = assertSafeKey(opts.category, "Category");
  const removePath = assertPathValue(opts.path);

  const raw = await readConfigFile(resolved.path);
  const group = raw[groupName];
  let changed = false;
  if (group && typeof group === "object" && !Array.isArray(group)) {
    const obj = group as Record<string, unknown>;
    const remaining = splitPaths(obj[category]).filter((p) => p !== removePath);
    changed = remaining.length !== splitPaths(obj[category]).length;
    if (changed) {
      if (remaining.length > 0) obj[category] = remaining.join("\n");
      else delete obj[category];
      await writeConfigFile(resolved.path, raw);
    }
  }
  const info = summarize(resolved.target, resolved.path, raw);
  return {
    ...info,
    changed,
    message: changed
      ? `Removed ${removePath} from ${groupName}.${category}. Restart ComfyUI to apply it.`
      : `${removePath} was not present in ${groupName}.${category}.`,
  };
}
