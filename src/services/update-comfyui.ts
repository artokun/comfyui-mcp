import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { config } from "../config.js";
import { resolveInstallInterpreter } from "./workspace-env.js";
import { queueUpdateAllCustomNodes } from "./node-management.js";
import { ProcessControlError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import {
  recordPanelPendingOp,
  UPDATE_ALL_PENDING_MS,
  withPanelPinGuard,
} from "./panel-pin-guard.js";

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

  // Resolve the requirements install's interpreter BEFORE `git pull` mutates the
  // checkout: it must be the interpreter the RUNNING server imports from, never a
  // configured-workspace venv/PATH guess the server may not see (#651). Fail
  // closed when the live interpreter cannot be verified.
  const requirements = join(comfyuiPath, "requirements.txt");
  let venvPython: string | undefined;
  let pythonReason = "";
  if (existsSync(requirements)) {
    const resolved = await resolveInstallInterpreter(comfyuiPath);
    if (!resolved.python) {
      throw new ProcessControlError(
        `Cannot update ComfyUI core. ${resolved.reason} ` +
          "Set COMFYUI_PYTHON to the interpreter ComfyUI runs with, or restart ComfyUI through this MCP server and retry.",
      );
    }
    venvPython = resolved.python;
    pythonReason = ` ${resolved.reason}`;
  }

  // 1. git pull the core repo.
  steps.push(runCommand("git", ["pull"], comfyuiPath));

  // 2. Reinstall requirements into the resolved interpreter's env (never this
  //    server's Python). requirements.txt lives in the repo root.
  if (venvPython) {
    if (pm === "uv") {
      // `--python` pins uv to the resolved interpreter rather than an ambient env.
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
    message: `ComfyUI core updated in ${comfyuiPath} using ${pm}.${pythonReason}`,
  };
}

/**
 * Update all installed custom nodes via the ComfyUI-Manager HTTP API.
 * Queues the update-all task then starts the queue worker (fire-and-forget —
 * the updates run asynchronously; unlike update_node with id "all", which
 * drains the queue).
 *
 * Routed through the Manager dialect machinery in node-management.ts (#656),
 * so the route follows the detected dialect instead of a hardcoded legacy
 * assumption:
 *   legacy 3.x:     POST /manager/queue/update_all      (mode in the JSON body)
 *   v4 / v2-batch:  POST /v2/manager/queue/update_all   (mode/client_id/ui_id
 *                                                      as query params)
 * then POST <same prefix>/start to kick the worker.
 */
export async function updateAllCustomNodes(): Promise<UpdateNodesResult> {
  // PIN GUARD — "update everything" includes the sidebar panel pack, so this is
  // one of the doors into a pinned panel that does NOT pass through
  // install_comfyui(action:'panel')/runPanelAction. See panel-pin-guard.ts. The pin check AND the
  // queue/start calls run inside the panel mutation lock, so a pin cannot be
  // written between them (the pin-write path takes the same lock). The Manager
  // then drains the queue ASYNCHRONOUSLY — outside anything this process can
  // serialize — which is exactly why the result below reports "queued", never
  // "updated".
  return withPanelPinGuard("update", "all", async () => {
    // Persist and VERIFY the warning marker BEFORE the remote request. Once the
    // Manager has accepted update-all, a later pin cannot stop its worker; a
    // marker write after that point could fail and leave the later pin claiming
    // protection it cannot provide. If the request itself fails, retain this
    // conservative marker: a transport failure cannot prove Manager did not
    // accept the request.
    //
    // The marker starts BASE-UNKNOWN on purpose (#689 round 3): the base that
    // matters is the one the ENQUEUE actually uses (captured inside
    // queueUpdateAllCustomNodes), and guessing it here risks a retarget leaving
    // the marker naming the WRONG server — which a later pin would reset and
    // clear as "cancelled" while the update lands elsewhere. A base-unknown
    // marker routes to the unverified/no-reset path instead.
    const detail =
      `an update-all request may have been handed to ComfyUI-Manager and can update EVERY ` +
      `installed pack — the sidebar panel included — on the Manager's own schedule ` +
      `(usually seconds to minutes; a ComfyUI restart then loads the result)`;
    recordPanelPendingOp("update-all", detail, UPDATE_ALL_PENDING_MS);
    const result = await queueUpdateAllCustomNodes();

    // Enrich the marker with what the ENQUEUE actually used: the base it
    // captured at invocation and the ui_id of the attempt that landed (a
    // self-heal retry mints a fresh one). On v4 the ui_id identifies the
    // update-all's per-pack tasks (each `${ui_id}_${pack}`) in the queue
    // history, which is what makes a later pin's cancel PROVABLE (#689 round
    // 3). keepRecordOnFailure: the operation is ALREADY with the Manager, so a
    // failed enrichment must leave the marker in place (the pre-handoff
    // rollback would delete the record of a live pending op — codex gate). The
    // marker then stays as last successfully written — possibly base-unknown,
    // never a stale base — so the pin-cancel path treats it as unverifiable
    // and sends no blind reset. Refusing now would punish a success.
    try {
      recordPanelPendingOp("update-all", detail, UPDATE_ALL_PENDING_MS, {
        base: result.base,
        uiId: result.uiId,
        keepRecordOnFailure: true,
      });
    } catch (err) {
      logger.warn(
        `[panel] update-all is queued, but the enriched pending-op marker could ` +
          `not be confirmed durably written — the marker remains as last ` +
          `successfully written (possibly base-unknown), so a later pin may ` +
          `report it as unverifiable rather than cancel blindly: ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
    }

    return {
      // Queue acceptance is not proof a generic/bulk Manager update moved the
      // sidebar panel on disk; keep the result explicitly unverified.
      updated: false,
      endpoint: result.endpoint,
      queue_started: result.queueStarted,
      manager_response: result.managerResponse,
      message: result.queueStarted
        ? "Queued updates for all custom nodes via ComfyUI-Manager and started the queue worker. " +
          "Completion is unverified; the sidebar panel may still change later."
        : "Queued updates for all custom nodes via ComfyUI-Manager. " +
          "Could not confirm the queue worker started — check ComfyUI-Manager.",
    };
  });
}

