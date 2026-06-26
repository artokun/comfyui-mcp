import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { config, getComfyUIBaseUrl } from "../config.js";
import { getSystemStats } from "../comfyui/client.js";
import { logger } from "../utils/logger.js";
import { ValidationError } from "../utils/errors.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Workspace config persistence (mirrors comfy-cli set-default / which)
// ---------------------------------------------------------------------------

interface WorkspaceConfig {
  defaultWorkspace?: string;
}

/**
 * Resolve the path to the workspace config JSON file.
 * Uses XDG_CONFIG_HOME when set, otherwise ~/.config/comfyui-mcp/workspace.json.
 */
function defaultWorkspaceConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const root = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(root, "comfyui-mcp", "workspace.json");
}

// Module-level override hook so tests can point at a temp file. Defaults to the
// platform config path lazily (so env changes in tests are picked up before set).
let configPathOverride: string | undefined;

export function configureWorkspace(opts: { configPath?: string }): void {
  configPathOverride = opts.configPath;
}

export function resetWorkspaceConfig(): void {
  configPathOverride = undefined;
}

function workspaceConfigPath(): string {
  return configPathOverride ?? defaultWorkspaceConfigPath();
}

async function readWorkspaceConfig(): Promise<WorkspaceConfig> {
  const path = workspaceConfigPath();
  if (!existsSync(path)) return {};
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      logger.warn("Workspace config is not a JSON object, ignoring", { path });
      return {};
    }
    // Validate the shape rather than blindly casting: defaultWorkspace must be a
    // non-empty string when present, else it is dropped.
    const cfg: WorkspaceConfig = {};
    const dw = (parsed as Record<string, unknown>).defaultWorkspace;
    if (typeof dw === "string" && dw.trim().length > 0) {
      cfg.defaultWorkspace = dw;
    } else if (dw !== undefined) {
      logger.warn("Ignoring invalid defaultWorkspace in workspace config", {
        path,
        type: typeof dw,
      });
    }
    return cfg;
  } catch (err) {
    logger.warn("Failed to parse workspace config, ignoring", {
      path,
      error: err instanceof Error ? err.message : err,
    });
    return {};
  }
}

async function writeWorkspaceConfig(cfg: WorkspaceConfig): Promise<void> {
  const path = workspaceConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cfg, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// ComfyUI install auto-detection
// (mirrors detectComfyUIPaths logic in src/config.ts — kept local because that
//  helper is not exported and config.ts is owned by another unit)
// ---------------------------------------------------------------------------

/**
 * Auto-detect ComfyUI installation directories. Checks common locations on
 * macOS, Linux, and Windows. Returns all found paths, most-preferred first.
 */
export function detectComfyUIInstalls(): string[] {
  const home = homedir();
  const candidates: string[] = [];

  // macOS: ComfyUI Desktop app stores data here
  candidates.push(join(home, "Documents", "ComfyUI"));
  // macOS: Application Support
  candidates.push(join(home, "Library", "Application Support", "ComfyUI"));
  // Common manual install locations
  candidates.push(join(home, "ComfyUI"));
  candidates.push(join(home, "code", "ComfyUI"));
  candidates.push(join(home, "projects", "ComfyUI"));
  candidates.push(join(home, "src", "ComfyUI"));
  // Linux common paths
  candidates.push("/opt/ComfyUI");
  candidates.push(join(home, ".local", "share", "ComfyUI"));
  // Windows common paths
  candidates.push(join(home, "AppData", "Local", "ComfyUI"));
  candidates.push(join(home, "Desktop", "ComfyUI"));
  // Windows: ComfyUI Desktop app installs here
  candidates.push(
    join(home, "AppData", "Local", "Programs", "ComfyUI", "resources", "ComfyUI"),
  );

  // Scan ~/Documents and ~/My Documents for any ComfyUI-named directories
  const documentsDirs = [join(home, "Documents"), join(home, "My Documents")];
  for (const dir of documentsDirs) {
    try {
      if (!existsSync(dir)) continue;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.toLowerCase().includes("comfyui")) {
          const fullPath = join(dir, entry.name);
          if (!candidates.includes(fullPath)) candidates.push(fullPath);
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  return candidates.filter((p) => {
    if (!existsSync(p)) return false;
    if (!p.includes("Documents")) return true;
    return existsSync(join(p, "models")) || existsSync(join(p, "custom_nodes"));
  });
}

// ---------------------------------------------------------------------------
// get_workspace — mirrors comfy-cli which
// ---------------------------------------------------------------------------

export interface WorkspaceInfo {
  workspace_path?: string;
  workspace_source: "env" | "auto-detected" | "default-config" | "none";
  default_workspace?: string;
  api_target: string;
}

export async function getWorkspace(): Promise<WorkspaceInfo> {
  const cfg = await readWorkspaceConfig();
  const apiTarget = getComfyUIBaseUrl();

  let source: WorkspaceInfo["workspace_source"];
  if (config.comfyuiPath) {
    // config.comfyuiPath is COMFYUI_PATH env or auto-detection
    source = process.env.COMFYUI_PATH ? "env" : "auto-detected";
  } else if (cfg.defaultWorkspace) {
    source = "default-config";
  } else {
    source = "none";
  }

  return {
    workspace_path: config.comfyuiPath ?? cfg.defaultWorkspace,
    workspace_source: source,
    default_workspace: cfg.defaultWorkspace,
    api_target: apiTarget,
  };
}

// ---------------------------------------------------------------------------
// set_default_workspace — mirrors comfy-cli set-default
// ---------------------------------------------------------------------------

export interface SetDefaultResult {
  saved: boolean;
  default_workspace: string;
  config_path: string;
  exists: boolean;
}

export async function setDefaultWorkspace(
  path: string,
): Promise<SetDefaultResult> {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("Workspace path must be a non-empty string.");
  }

  const cfg = await readWorkspaceConfig();
  cfg.defaultWorkspace = trimmed;
  await writeWorkspaceConfig(cfg);

  return {
    saved: true,
    default_workspace: trimmed,
    config_path: workspaceConfigPath(),
    exists: existsSync(trimmed),
  };
}

// ---------------------------------------------------------------------------
// list_workspaces — auto-detected installs + active + saved default
// ---------------------------------------------------------------------------

export interface WorkspaceListEntry {
  path: string;
  active: boolean;
  is_default: boolean;
  looks_valid: boolean;
}

export interface WorkspaceList {
  active_workspace?: string;
  default_workspace?: string;
  workspaces: WorkspaceListEntry[];
}

export async function listWorkspaces(): Promise<WorkspaceList> {
  const cfg = await readWorkspaceConfig();
  const detected = detectComfyUIInstalls();

  // Merge detected installs with active path and saved default so the caller
  // sees a complete picture even if one isn't in the detection list.
  const paths = new Set<string>(detected);
  if (config.comfyuiPath) paths.add(config.comfyuiPath);
  if (cfg.defaultWorkspace) paths.add(cfg.defaultWorkspace);

  const workspaces: WorkspaceListEntry[] = [...paths].map((p) => ({
    path: p,
    active: p === config.comfyuiPath,
    is_default: p === cfg.defaultWorkspace,
    looks_valid:
      existsSync(join(p, "models")) || existsSync(join(p, "custom_nodes")),
  }));

  return {
    active_workspace: config.comfyuiPath,
    default_workspace: cfg.defaultWorkspace,
    workspaces,
  };
}

// ---------------------------------------------------------------------------
// get_environment — mirrors comfy-cli env
// ---------------------------------------------------------------------------

const IS_WIN = platform() === "win32";

/** Run a command quietly; return trimmed stdout or undefined on any failure. */
async function probe(
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts?.cwd,
      timeout: 8000,
      windowsHide: true,
    });
    const out = (stdout || stderr || "").trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the python executable to probe, preferring a venv inside the workspace. */
function pythonCandidates(workspacePath: string | undefined): string[] {
  const names = IS_WIN ? ["python.exe", "python"] : ["python3", "python"];
  const candidates: string[] = [];
  if (workspacePath) {
    const venvBin = IS_WIN
      ? join(workspacePath, ".venv", "Scripts")
      : join(workspacePath, ".venv", "bin");
    for (const n of names) {
      const p = join(venvBin, n);
      if (existsSync(p)) candidates.push(p);
    }
  }
  // Fall back to PATH-resolved interpreters
  candidates.push(...names);
  return candidates;
}

async function probePython(
  workspacePath: string | undefined,
): Promise<{ executable: string; version: string } | undefined> {
  for (const exe of pythonCandidates(workspacePath)) {
    const version = await probe(exe, ["--version"]);
    if (version) return { executable: exe, version: version.replace(/^Python\s+/i, "") };
  }
  return undefined;
}

async function probePipPackages(
  pythonExe: string,
  names: string[],
): Promise<Record<string, string>> {
  // `pip show` is portable across pip/uv-managed venvs.
  const found: Record<string, string> = {};
  const out = await probe(pythonExe, [
    "-m",
    "pip",
    "show",
    ...names,
  ]);
  if (!out) return found;
  // `pip show A B C` emits records separated by a line of "---".
  for (const block of out.split(/^---$/m)) {
    const nameMatch = block.match(/^Name:\s*(.+)$/m);
    const verMatch = block.match(/^Version:\s*(.+)$/m);
    if (nameMatch && verMatch) {
      found[nameMatch[1].trim().toLowerCase()] = verMatch[1].trim();
    }
  }
  return found;
}

async function probeGitRev(
  workspacePath: string,
): Promise<{ rev?: string; branch?: string } | undefined> {
  if (!existsSync(join(workspacePath, ".git"))) return undefined;
  const rev = await probe("git", ["rev-parse", "--short", "HEAD"], {
    cwd: workspacePath,
  });
  const branch = await probe("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: workspacePath,
  });
  if (!rev && !branch) return undefined;
  return { rev, branch };
}

/** Read ComfyUI-Manager version from its local install if present. */
async function readManagerVersion(
  workspacePath: string,
): Promise<string | undefined> {
  const dirNames = ["ComfyUI-Manager", "comfyui-manager"];
  for (const dirName of dirNames) {
    const file = join(workspacePath, "custom_nodes", dirName, "pyproject.toml");
    try {
      if (!existsSync(file)) continue;
      // Tiny TOML peek — only the version line, no full parser needed.
      const text = await readFile(file, "utf-8");
      const m = text.match(/^version\s*=\s*["']([^"']+)["']/m);
      if (m) return m[1];
      // Presence without a parseable version still tells us it's installed.
      return "installed";
    } catch {
      // try next
    }
  }
  // Fallback: directory presence
  for (const dirName of dirNames) {
    if (existsSync(join(workspacePath, "custom_nodes", dirName))) {
      return "installed";
    }
  }
  return undefined;
}

export interface EnvironmentInfo {
  // Running instance (from /system_stats — works remotely)
  running_instance: {
    reachable: boolean;
    api_target: string;
    os?: string;
    python_version?: string;
    embedded_python?: boolean;
    comfyui_version?: string;
    devices?: Array<{
      name: string;
      type: string;
      vram_total_mb?: number;
      vram_free_mb?: number;
    }>;
    error?: string;
  };
  // Local workspace probes (omitted/degraded when no local path)
  local: {
    workspace_path?: string;
    python?: { executable: string; version: string };
    git?: { rev?: string; branch?: string };
    comfyui_manager_version?: string;
    packages?: Record<string, string>;
    note?: string;
  };
}

const KEY_PACKAGES = [
  "torch",
  "torchvision",
  "torchaudio",
  "xformers",
  "numpy",
  "transformers",
  "diffusers",
  "comfyui-frontend-package",
];

export async function getEnvironment(): Promise<EnvironmentInfo> {
  const apiTarget = getComfyUIBaseUrl();

  // 1. Running instance via /system_stats (works for remote targets too)
  const running: EnvironmentInfo["running_instance"] = {
    reachable: false,
    api_target: apiTarget,
  };
  try {
    const stats = await getSystemStats();
    running.reachable = true;
    running.os = stats.system.os;
    running.python_version = stats.system.python_version;
    running.embedded_python = stats.system.embedded_python;
    running.comfyui_version = stats.system.comfyui_version;
    running.devices = (stats.devices ?? []).map((d) => ({
      name: d.name,
      type: d.type,
      vram_total_mb:
        typeof d.vram_total === "number"
          ? Math.round(d.vram_total / (1024 * 1024))
          : undefined,
      vram_free_mb:
        typeof d.vram_free === "number"
          ? Math.round(d.vram_free / (1024 * 1024))
          : undefined,
    }));
  } catch (err) {
    running.error = err instanceof Error ? err.message : String(err);
  }

  // 2. Local probes — use the active path, else fall back to the saved default
  //    workspace (set via set_default_workspace) so `env` still inspects a known
  //    local install when COMFYUI_PATH isn't set.
  const local: EnvironmentInfo["local"] = {};
  const cfg = await readWorkspaceConfig();
  const workspacePath = config.comfyuiPath ?? cfg.defaultWorkspace;
  if (!workspacePath) {
    local.note =
      "No local ComfyUI path configured (COMFYUI_PATH unset, none auto-detected, " +
      "and no saved default workspace). Local environment probes skipped; remote " +
      "/system_stats used instead.";
    return { running_instance: running, local };
  }

  local.workspace_path = workspacePath;
  if (!config.comfyuiPath && cfg.defaultWorkspace) {
    local.note = `Using saved default workspace "${cfg.defaultWorkspace}" (COMFYUI_PATH not set).`;
  }

  const py = await probePython(workspacePath);
  if (py) {
    local.python = py;
    const pkgs = await probePipPackages(py.executable, KEY_PACKAGES);
    if (Object.keys(pkgs).length > 0) local.packages = pkgs;
  } else {
    local.note = [
      local.note,
      "Python interpreter not found on PATH or in workspace .venv.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  const git = await probeGitRev(workspacePath);
  if (git) local.git = git;

  const managerVersion = await readManagerVersion(workspacePath);
  if (managerVersion) local.comfyui_manager_version = managerVersion;

  return { running_instance: running, local };
}
