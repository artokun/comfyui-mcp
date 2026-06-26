import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { config, getComfyUIBaseUrl } from "../config.js";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { ProcessControlError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandResult {
  command: string;
  ok: boolean;
  output: string;
}

export interface UpdateCoreResult {
  updated: boolean;
  comfyui_path: string;
  package_manager: "uv" | "pip";
  steps: CommandResult[];
  message: string;
}

export interface UpdateNodesResult {
  updated: boolean;
  endpoint: string;
  queue_started: boolean;
  message: string;
  manager_response?: unknown;
}

// ---------------------------------------------------------------------------
// Cross-platform helpers
// ---------------------------------------------------------------------------

const IS_WIN = platform() === "win32";

/**
 * Run a command, capturing stdout+stderr. Throws ProcessControlError on
 * non-zero exit so callers can surface a clear failure.
 */
function runCommand(
  file: string,
  args: string[],
  cwd: string,
): CommandResult {
  const command = [file, ...args].join(" ");
  logger.info(`Running: ${command}`, { cwd });
  try {
    const output = execFileSync(file, args, {
      cwd,
      encoding: "utf-8",
      timeout: 300_000,
      // Inherit env so PATH resolves git/uv/pip; merge stderr into stdout.
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { command, ok: true, output: (output ?? "").trim() };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const out = [e.stdout, e.stderr]
      .map((b) => (b == null ? "" : b.toString()))
      .join("")
      .trim();
    throw new ProcessControlError(
      `Command failed: ${command}\n${out || e.message || "unknown error"}`,
    );
  }
}

/**
 * Detect whether the ComfyUI install is managed by `uv` (a `.venv` created by
 * uv, or a uv lock present) versus plain pip. Falls back to checking whether
 * the `uv` binary is available on PATH. Defaults to pip.
 */
function detectPackageManager(comfyuiPath: string): "uv" | "pip" {
  // A uv-managed project typically has a uv.lock or pyproject managed by uv.
  if (
    existsSync(join(comfyuiPath, "uv.lock")) ||
    existsSync(join(comfyuiPath, ".venv", "uv-receipt.toml"))
  ) {
    return "uv";
  }
  // Otherwise see if `uv` is callable.
  try {
    execFileSync(IS_WIN ? "uv.exe" : "uv", ["--version"], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return "uv";
  } catch {
    return "pip";
  }
}

/**
 * Resolve the ComfyUI workspace's own Python interpreter — its `.venv`/`venv`
 * if present — so dependency installs target the workspace env, NOT the Python
 * running this MCP server. Falls back to PATH python when no venv exists.
 */
function resolveWorkspacePython(comfyuiPath: string): string {
  for (const venv of [".venv", "venv"]) {
    const py = IS_WIN
      ? join(comfyuiPath, venv, "Scripts", "python.exe")
      : join(comfyuiPath, venv, "bin", "python");
    if (existsSync(py)) return py;
  }
  return IS_WIN ? "python" : "python3";
}

/**
 * Resolve the ComfyUI install path or throw a clear error explaining that core
 * updates require a local install (not available in remote --comfyui-url mode).
 */
function requireComfyUIPath(): string {
  const path = config.comfyuiPath;
  if (!path) {
    throw new ProcessControlError(
      "Cannot update ComfyUI core: no local install path is configured. " +
        "Core updates run git/pip against the ComfyUI directory and are not " +
        "available when targeting a remote instance via --comfyui-url / COMFYUI_URL. " +
        "Set COMFYUI_PATH to the local ComfyUI checkout to enable this.",
    );
  }
  if (!existsSync(path)) {
    throw new ProcessControlError(
      `Configured ComfyUI path does not exist: ${path}. Set COMFYUI_PATH correctly.`,
    );
  }
  return path;
}

// ---------------------------------------------------------------------------
// Manager HTTP client (local helper — no shared module)
// ---------------------------------------------------------------------------

function managerBaseUrl(): string {
  return getComfyUIBaseUrl();
}

interface ManagerFetchResult {
  ok: boolean;
  status: number;
  body: unknown;
}

async function managerFetch(
  path: string,
  init?: RequestInit,
  timeoutMs = 30_000,
): Promise<ManagerFetchResult> {
  const url = `${managerBaseUrl()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await comfyuiFetch(url, { ...init, signal: controller.signal });
    let body: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProcessControlError(
      `Failed to reach ComfyUI-Manager at ${url}: ${msg}. ` +
        "Is ComfyUI running with ComfyUI-Manager installed?",
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Update ComfyUI core: `git pull` in config.comfyuiPath, then reinstall its
 * Python requirements via uv or pip. Mirrors `comfy-cli update`.
 */
export async function updateComfyUICore(): Promise<UpdateCoreResult> {
  const comfyuiPath = requireComfyUIPath();
  const pm = detectPackageManager(comfyuiPath);
  const steps: CommandResult[] = [];

  // 1. git pull the core repo.
  steps.push(runCommand("git", ["pull"], comfyuiPath));

  // 2. Reinstall requirements into the WORKSPACE venv (never this server's
  //    Python). requirements.txt lives in the repo root.
  const requirements = join(comfyuiPath, "requirements.txt");
  if (existsSync(requirements)) {
    const venvPython = resolveWorkspacePython(comfyuiPath);
    if (pm === "uv") {
      // `--python` pins uv to the workspace venv rather than an ambient env.
      steps.push(
        runCommand(
          "uv",
          ["pip", "install", "--python", venvPython, "-r", "requirements.txt"],
          comfyuiPath,
        ),
      );
    } else {
      steps.push(
        runCommand(
          venvPython,
          ["-m", "pip", "install", "-r", "requirements.txt"],
          comfyuiPath,
        ),
      );
    }
  } else {
    logger.warn(`No requirements.txt found at ${requirements}; skipping dependency install`);
  }

  return {
    updated: true,
    comfyui_path: comfyuiPath,
    package_manager: pm,
    steps,
    message: `ComfyUI core updated in ${comfyuiPath} using ${pm}.`,
  };
}

/**
 * Update all installed custom nodes via the ComfyUI-Manager HTTP API.
 * Queues the update_all task then starts the queue worker.
 *
 * Endpoints (confirmed against Comfy-Org/ComfyUI-Manager):
 *   POST /manager/queue/update_all   — queue update of all nodes
 *   POST /manager/queue/start        — start processing the queue
 */
export async function updateAllCustomNodes(): Promise<UpdateNodesResult> {
  const endpoint = "/manager/queue/update_all";

  const queued = await managerFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "default" }),
  });

  if (!queued.ok) {
    throw new ProcessControlError(
      `ComfyUI-Manager returned ${queued.status} for ${endpoint}: ` +
        `${typeof queued.body === "string" ? queued.body : JSON.stringify(queued.body)}`,
    );
  }

  // Kick off the worker that drains the queue.
  let queueStarted = false;
  try {
    const started = await managerFetch("/manager/queue/start", { method: "POST" });
    queueStarted = started.ok;
  } catch (err) {
    logger.warn("Queued node updates but failed to start the queue worker", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    updated: true,
    endpoint,
    queue_started: queueStarted,
    manager_response: queued.body,
    message: queueStarted
      ? "Queued updates for all custom nodes via ComfyUI-Manager and started the queue worker. " +
        "Updates run asynchronously; a ComfyUI restart may be required afterward."
      : "Queued updates for all custom nodes via ComfyUI-Manager. " +
        "Could not confirm the queue worker started — check ComfyUI-Manager.",
  };
}

