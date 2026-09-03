import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import {
  resolveEffectiveComfyUICodeBaseLive,
  resolveInstallInterpreter,
} from "./workspace-env.js";
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
  /** The checkout's git state before and after the pull (#945). Present
   *  whenever it could be read; absent for a non-git install. */
  revision?: {
    before: string | null;
    after: string | null;
    /** Branch name, or null when HEAD is DETACHED (a release tag checkout). */
    branch: string | null;
    /** The configured upstream (e.g. "origin/master"), when there is one. */
    upstream: string | null;
    /** Whether `after` was proven equal to the upstream's tip. `null` = could
     *  not be checked, which is NOT the same as false. */
    matches_upstream: boolean | null;
  };
}

/** Why a `git pull` that exited 0 nevertheless moved nothing (#945). */
export interface CoreUpdateBlocker {
  reason: "detached" | "no-upstream" | "behind-upstream" | "unverifiable";
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
 * Read-only git probe. Returns trimmed stdout, or null when the command fails
 * for ANY reason — not a git repo, no upstream, an unknown ref. Never throws:
 * these calls exist to describe the checkout, and a failed description must not
 * take down the update itself.
 */
function gitProbe(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const t = (out ?? "").trim();
    return t === "" ? null : t;
  } catch {
    return null;
  }
}

/** ComfyUI's historical default, then the generic git default. */
const UPDATE_BRANCHES = ["master", "main"] as const;

/**
 * Stale remote-tracking ref vs new nested ref: `refs/remotes/origin/dev` exists
 * as a file, so git cannot create `refs/remotes/origin/dev/<child>` (#2524).
 * Git's own hint is `git remote prune origin`. Other lock failures (index.lock,
 * another process) must NOT match — those are not cured by pruning.
 */
export function isStaleRemoteRefLock(output: string): boolean {
  const nestedLock = /cannot lock ref\s+['"]?refs\/remotes\/origin\//i.test(output);
  const parentExists = /exists/i.test(output);
  const pruneHint = /git remote prune origin/i.test(output);
  return (nestedLock && parentExists) || pruneHint;
}

/** `git pull` on a DETACHED HEAD: fetch may work, merge has no branch (#2524). */
export function isDetachedPullFailure(output: string): boolean {
  return /you are not currently on a branch/i.test(output);
}

interface AttachAttempt {
  switched: boolean;
  branch: string | null;
  dirty: boolean;
}

function localUpdateBranch(cwd: string): string | null {
  for (const name of UPDATE_BRANCHES) {
    if (gitProbe(["show-ref", "--verify", `refs/heads/${name}`], cwd)) {
      return name;
    }
  }
  return null;
}

/** Empty porcelain = clean. A failed status is NOT clean — we cannot prove it. */
function workingTreeClean(cwd: string): boolean {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return (out ?? "").trim() === "";
  } catch {
    return false;
  }
}

/**
 * `install_comfyui(action:"update")` is an explicit request to move the
 * checkout. A detached release-tag HEAD (Comfy Desktop / `git checkout vX.Y.Z`)
 * has no branch for `git pull` to merge with. When a local master/main exists
 * and the tree is clean, switch onto it before pulling. Dirty trees and
 * missing local branches are left untouched — switching those is not ours.
 */
function tryAttachUpdateBranch(
  cwd: string,
  currentBranch: string | null,
  steps: CommandResult[],
): AttachAttempt {
  if (currentBranch) return { switched: false, branch: currentBranch, dirty: false };
  const branch = localUpdateBranch(cwd);
  if (!branch) return { switched: false, branch: null, dirty: false };
  const dirty = !workingTreeClean(cwd);
  if (dirty) return { switched: false, branch, dirty: true };
  steps.push(runCommand("git", ["checkout", branch], cwd));
  return { switched: true, branch, dirty: false };
}

function detachedPullRefusalMessage(comfyuiPath: string, attach: AttachAttempt): string {
  const intro =
    `ComfyUI core was NOT updated in ${comfyuiPath}: HEAD is DETACHED ` +
    `(a tag or bare commit, which is how release-tag and Comfy Desktop installs are set up), ` +
    `so \`git pull\` has no branch to merge with.`;
  const tail = "Python requirements were NOT reinstalled, because nothing changed that would need them.";
  if (attach.branch && attach.dirty) {
    return (
      `${intro} Local branch "${attach.branch}" exists, but the working tree is not clean ` +
      `so this tool will not switch branches. Commit or stash local changes, then ` +
      `\`git checkout ${attach.branch}\` and retry. ${tail}`
    );
  }
  if (attach.branch) {
    return (
      `${intro} Switch to "${attach.branch}" first ` +
      `(\`git checkout ${attach.branch} && git pull --ff-only\`) and retry. ${tail}`
    );
  }
  return (
    `${intro} Switch to a branch first, e.g. \`git checkout master && git pull --ff-only\`. ` +
    `Check for local edits before switching (\`git status\`). ${tail}`
  );
}

/**
 * `git pull`, recovering once from the stale origin/dev vs origin/dev/* ref-lock
 * by pruning origin. Other pull failures propagate unchanged.
 */
function runGitPullWithStaleRefRetry(cwd: string, steps: CommandResult[]): CommandResult {
  try {
    const pulled = runCommand("git", ["pull"], cwd);
    steps.push(pulled);
    return pulled;
  } catch (err) {
    if (!(err instanceof ProcessControlError) || !isStaleRemoteRefLock(err.message)) {
      throw err;
    }
    steps.push({ command: "git pull", ok: false, output: err.message });
    steps.push(runCommand("git", ["remote", "prune", "origin"], cwd));
    const retried = runCommand("git", ["pull"], cwd);
    steps.push(retried);
    return retried;
  }
}

/**
 * Decide whether `git pull` actually updated the checkout (#945).
 *
 * A `git pull` on a DETACHED HEAD — which is how Comfy Desktop's release-tag
 * installs sit — prints "Already up to date." and exits 0 while moving nothing.
 * The same happens when `remote.origin.fetch` carries only a tag refspec, so
 * `origin/master` is never fetched and stays stale (or absent). Both were
 * reported as `updated: true`, and the requirements were then reinstalled for a
 * checkout that had not moved. The reporter's install stayed pinned at v0.30.2
 * while master had advanced.
 *
 * The rule: a sha that CHANGED proves an update. A sha that did not change
 * proves nothing on its own — it is only "already current" if it can be shown
 * equal to the upstream tip. Everything else is reported as NOT updated, with
 * the reason, because the alternative is the false success above.
 */
export function classifyCoreUpdate(state: {
  before: string | null;
  after: string | null;
  branch: string | null;
  upstream: string | null;
  upstreamSha: string | null;
}): { updated: boolean; matchesUpstream: boolean | null; blocker?: CoreUpdateBlocker } {
  // The sha moved: the pull did something. Nothing else needs proving.
  if (state.before && state.after && state.before !== state.after) {
    return { updated: true, matchesUpstream: null };
  }
  // Not a git checkout at all (both probes failed) — say so rather than guess.
  if (!state.after) {
    return {
      updated: false,
      matchesUpstream: null,
      blocker: {
        reason: "unverifiable",
        message:
          "the ComfyUI directory's git revision could not be read, so whether the pull changed anything is UNKNOWN. " +
          "If this is not a git checkout, `git pull` cannot update it at all — update through the installer you used.",
      },
    };
  }

  if (!state.branch) {
    return {
      updated: false,
      matchesUpstream: null,
      blocker: {
        reason: "detached",
        message:
          "HEAD is DETACHED (a tag or bare commit, which is how release-tag and Comfy Desktop installs are set up), so " +
          "`git pull` has no branch to fast-forward and reports \"Already up to date.\" without moving anything. " +
          "Switch to a branch first, e.g. `git checkout master && git pull --ff-only`. " +
          "Check for local edits before switching (`git status`) — this tool will not move your HEAD for you.",
      },
    };
  }

  if (!state.upstream) {
    return {
      updated: false,
      matchesUpstream: null,
      blocker: {
        reason: "no-upstream",
        message:
          `branch "${state.branch}" has no upstream configured, so \`git pull\` has nothing to pull from and exits ` +
          `without changing the checkout. Set one with \`git branch --set-upstream-to=origin/${state.branch} ${state.branch}\`.`,
      },
    };
  }

  // Upstream is configured but its tip is unreadable — classically a
  // `remote.origin.fetch` that only carries `+refs/tags/*`, so the remote branch
  // ref was never created locally. This is the reported install's exact shape.
  if (!state.upstreamSha) {
    return {
      updated: false,
      matchesUpstream: null,
      blocker: {
        reason: "unverifiable",
        message:
          `the upstream "${state.upstream}" could not be resolved locally, so there is no way to tell whether this ` +
          `checkout is current. That usually means \`remote.origin.fetch\` carries only a tag refspec, so the remote ` +
          `branch is never fetched. Check it with \`git config --get-all remote.origin.fetch\`, and add the branch ` +
          `refspec if it is missing: \`git config --add remote.origin.fetch +refs/heads/${state.branch}:refs/remotes/origin/${state.branch}\`.`,
      },
    };
  }

  if (state.after === state.upstreamSha) {
    // The one honest "nothing to do": proven equal to the upstream tip.
    return { updated: true, matchesUpstream: true };
  }

  return {
    updated: false,
    matchesUpstream: false,
    blocker: {
      reason: "behind-upstream",
      message:
        `the pull exited cleanly but the checkout is still at ${state.after.slice(0, 8)} while ${state.upstream} is at ` +
        `${state.upstreamSha.slice(0, 8)} — so it did NOT update. Fetch and fast-forward explicitly ` +
        `(\`git fetch origin && git merge --ff-only ${state.upstream}\`) and check \`git status\` for local changes that block it.`,
    },
  };
}

/** Read the checkout's git state. Every field is best-effort and may be null. */
function readGitState(cwd: string): {
  head: string | null;
  branch: string | null;
  upstream: string | null;
} {
  return {
    head: gitProbe(["rev-parse", "HEAD"], cwd),
    // --quiet + --short: prints the branch name, fails (→ null) when detached.
    branch: gitProbe(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd),
    upstream: gitProbe(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd),
  };
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
async function requireComfyUICodePath(): Promise<string> {
  const path = await resolveEffectiveComfyUICodeBaseLive();
  if (!path) {
    throw new ProcessControlError(
      "Cannot update ComfyUI core: no local code checkout could be resolved. " +
        "Core updates run git/pip against the ComfyUI directory and are not " +
        "available when targeting a remote instance via --comfyui-url / COMFYUI_URL. " +
        "Set COMFYUI_CODE_PATH to the local checkout (or COMFYUI_PATH for a conventional install) to enable this.",
    );
  }
  if (!existsSync(path)) {
    throw new ProcessControlError(
      `Resolved ComfyUI code path does not exist: ${path}. Set COMFYUI_CODE_PATH (or COMFYUI_PATH) correctly.`,
    );
  }
  return path;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Update ComfyUI core: resolve the running/local checkout, `git pull` there,
 * then reinstall its Python requirements via uv or pip. Mirrors `comfy-cli update`.
 */
export async function updateComfyUICore(): Promise<UpdateCoreResult> {
  const comfyuiPath = await requireComfyUICodePath();
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

  // 1. git pull the core repo — bracketed by a revision read, because a pull
  //    that exits 0 is NOT evidence that anything moved (#945).
  //    A detached version-tag checkout is attached to local master/main first
  //    when the tree is clean (#2524); a stale origin/dev vs origin/dev/*
  //    ref-lock is pruned once and the pull retried.
  const before = readGitState(comfyuiPath);
  const attach = tryAttachUpdateBranch(comfyuiPath, before.branch, steps);
  try {
    runGitPullWithStaleRefRetry(comfyuiPath, steps);
  } catch (err) {
    if (err instanceof ProcessControlError && isDetachedPullFailure(err.message)) {
      if (!steps.some((s) => s.command === "git pull" && !s.ok)) {
        steps.push({ command: "git pull", ok: false, output: err.message });
      }
      const afterDetached = readGitState(comfyuiPath);
      return {
        updated: false,
        comfyui_path: comfyuiPath,
        package_manager: pm,
        steps,
        revision: {
          before: before.head,
          after: afterDetached.head,
          branch: afterDetached.branch,
          upstream: afterDetached.upstream,
          matches_upstream: null,
        },
        message: detachedPullRefusalMessage(comfyuiPath, attach),
      };
    }
    throw err;
  }
  const after = readGitState(comfyuiPath);
  const verdict = classifyCoreUpdate({
    before: before.head,
    after: after.head,
    branch: after.branch,
    upstream: after.upstream,
    upstreamSha: after.upstream ? gitProbe(["rev-parse", after.upstream], comfyuiPath) : null,
  });
  const revision = {
    before: before.head,
    after: after.head,
    branch: after.branch,
    upstream: after.upstream,
    matches_upstream: verdict.matchesUpstream,
  };

  // The checkout did not move and could not be shown to be current. Reinstalling
  // requirements here is what made the old false success convincing — it looked
  // like work. Stop before it and report the reason, so nothing is done in the
  // name of an update that did not happen.
  if (!verdict.updated) {
    return {
      updated: false,
      comfyui_path: comfyuiPath,
      package_manager: pm,
      steps,
      revision,
      message:
        `ComfyUI core was NOT updated in ${comfyuiPath}: ${verdict.blocker?.message ?? "the checkout did not change."} ` +
        `\`git pull\` exited cleanly, which is why this used to be reported as a successful update — it is not one. ` +
        `Python requirements were NOT reinstalled, because nothing changed that would need them.`,
    };
  }

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

  // Distinguish "moved" from "already at the upstream tip" — both are honest
  // successes, but they are different facts and the caller may care which.
  const moved = revision.before !== revision.after;
  const what = moved
    ? `updated ${String(revision.before).slice(0, 8)} → ${String(revision.after).slice(0, 8)}`
    : `already at ${after.upstream} (${String(revision.after).slice(0, 8)}) — nothing to pull`;
  return {
    updated: true,
    comfyui_path: comfyuiPath,
    package_manager: pm,
    steps,
    revision,
    message: `ComfyUI core ${what} in ${comfyuiPath} using ${pm}.${pythonReason}`,
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

