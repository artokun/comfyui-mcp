// The panel version pin, enforced where the PANEL PACK IS IDENTIFIED AS THE
// TARGET — not where the panel-specific entry point happens to be.
//
// WHY THIS FILE EXISTS. The first cut of the pin put its guard inside
// `runPanelAction` and called that "the mutation choke point". It isn't one. The
// panel IS an ordinary custom node pack, so the generic node tools are a second,
// wider door into exactly the same ComfyUI-Manager mutation:
//
//     install_custom_node(action:"update", id="comfyui-agent-panel")
//                                                     → updateCustomNode(...)
//     install_custom_node(action:"update", id="all")  → updateCustomNode(...)
//     install_custom_node(action:"reinstall", id="comfyui-mcp-panel")
//                                                     → reinstallCustomNode(...)
//     update-all                                      → updateAllCustomNodes()
//
// None of those go through `runPanelAction`, so none of them saw the pin. A
// pinned user was one `id="all"` away from being moved. The guard therefore
// lives at the SERVICE layer of the generic mutations, where every caller —
// tools, apply_manifest, dependency installers, anything future — must pass.
//
// This module deliberately imports NOTHING from panel-installer or
// node-management: panel-installer already imports node-management's mutations,
// so a guard that reached back into either would create an import cycle. It
// depends only on the pin store (and panel-recovery, which is itself a leaf over
// config + panel-workspace and reaches back into neither).

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeFileDurable } from "../utils/durable-write.js";
import { logger } from "../utils/logger.js";
import {
  describePanelManagementRedirect,
  panelRecoveryContext,
} from "./panel-recovery.js";
import {
  describePanelPin,
  getPanelPinState,
  PANEL_PIN_ENV_VAR,
  type PanelPinState,
} from "./panel-settings.js";
import { assertNotWritingRealHomeInTests } from "./test-isolation-guard.js";

/** Thrown when a pin forbids a mutation. Distinct so callers can recognise it. */
export class PanelPinnedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanelPinnedError";
  }
}

/**
 * Every spelling of "the sidebar panel pack" a caller might pass as an id. The
 * Comfy Registry name and the repo/dir name differ, and both are accepted by
 * ComfyUI-Manager, so both must match here.
 */
export const PANEL_PACK_ALIASES = [
  "comfyui-agent-panel", // Comfy Registry id / pyproject [project].name
  "comfyui-mcp-panel", // repo name, and the custom_nodes dir it installs to
] as const;

/** A bulk target that necessarily includes the panel. */
function isBulkTarget(id: string): boolean {
  return id === "all" || id === "*";
}

/**
 * Reduce any target spelling to a bare repo/pack name.
 *
 * This MUST cover every ref-carrying form `parseGitUrl` accepts, because those
 * are the forms a caller can actually pass: naively taking the last path segment
 * turned `…/comfyui-mcp-panel.git@v0.11.28` into `comfyui-mcp-panel.git@v0.11.28`
 * and `…/comfyui-mcp-panel/tree/main` into `main`, so BOTH slipped past the
 * matcher and moved a pinned panel. Kept deliberately independent of
 * node-management's parser: panel-installer already imports node-management, so
 * reaching back into it from here would be an import cycle.
 */
export function normalizePackTarget(id: string): string {
  let s = (id ?? "").trim().toLowerCase();
  if (!s) return "";
  // Drop query strings / fragments first.
  s = s.split(/[?#]/)[0] ?? "";
  // Forge "browse at a ref" forms (GitHub/GitLab/Gitea/Bitbucket), mirroring
  // parseGitUrl's list.
  s = s.replace(/\/-\/(tree|commit)\/.*$/, "");
  s = s.replace(/\/(tree|commit|commits|src)\/.*$/, "");
  s = s.replace(/\/releases\/tag\/.*$/, "");
  s = s.replace(/\/+$/, "");
  // Last path segment (handles bare ids, "author/repo", and full URLs).
  let seg = s.split(/[/\\]/).filter(Boolean).pop() ?? "";
  // npm/pip style `repo@ref` / `repo.git@ref`. The segment can no longer contain
  // an scp-style `git@host:` user part, since that lives before the ":".
  seg = seg.split("@")[0] ?? "";
  return seg.replace(/\.git$/, "");
}

/**
 * Does this mutation target cover the panel pack?
 *
 * Matches the bare aliases and every git-URL spelling that resolves to them,
 * case-insensitively — ComfyUI-Manager resolves all of these to the same pack,
 * so treating any of them as "not the panel" reopens the door this guard closes.
 * `"all"` is included because a bulk update moves the panel along with
 * everything else.
 */
export function targetsPanelPack(id: string): boolean {
  const raw = (id ?? "").trim().toLowerCase();
  if (!raw) return false;
  if (isBulkTarget(raw)) return true;
  if ((PANEL_PACK_ALIASES as readonly string[]).includes(raw)) return true;
  return (PANEL_PACK_ALIASES as readonly string[]).includes(normalizePackTarget(raw));
}

/** Is this an exact single-pack panel target (i.e. NOT a bulk "all")? */
export function targetsPanelPackExactly(id: string): boolean {
  const raw = (id ?? "").trim().toLowerCase();
  return !isBulkTarget(raw) && targetsPanelPack(id);
}

/**
 * Read the pin so that NO failure mode reads as "unpinned" — a reader that
 * throws is reported as an indeterminate pin, which counts as pinned.
 */
function readPin(): PanelPinState {
  try {
    return getPanelPinState();
  } catch (err) {
    logger.warn(
      `[panel] could not read the panel version pin: ${
        err instanceof Error ? err.message : String(err)
      } — treating the panel as PINNED (refusing to move it).`,
    );
    return { pinned: true, source: "settings", indeterminate: true };
  }
}

/**
 * Refuse a generic node mutation that would move a PINNED panel.
 *
 * `action` and `id` are only used to build the message; the decision is the
 * pin's. A bulk target gets its own wording because there is no way to update
 * everything-except-the-panel through ComfyUI-Manager — the user has to unpin or
 * update packs individually, and saying so is more useful than a generic refusal.
 */
export function assertPanelPinAllows(action: string, id: string): void {
  if (!targetsPanelPack(id)) return;
  const pin = readPin();
  if (!pin.pinned) return;

  const bulk = !targetsPanelPackExactly(id);
  const envNote =
    pin.source === "env"
      ? ` (this pin comes from the ${PANEL_PIN_ENV_VAR} environment variable, so it ` +
        `must be unset/changed in the environment — unpin cannot remove it)`
      : ``;

  // #774/#784 — the way out of this refusal must be a way the caller can
  // actually take. `install_comfyui(action:'panel', panel_action:'unpin')` is the right instruction in a
  // local session and a dead end in a remote/cloud one, where install_comfyui(action:'panel')
  // cannot act at all. So the LEAD instruction switches with the session rather
  // than being appended to. An env pin already carries its own instruction (unset
  // the variable), which is host-side either way and needs no substitution.
  const usable = panelRecoveryContext().installPanelUsable;
  const clearIt = usable
    ? `clear the pin with install_comfyui(action:'panel', panel_action:'unpin')${envNote}`
    : pin.source === "env"
      ? // An env pin is not cleared by any tool anywhere, so naming one would be
        // noise on top of a dead end — say plainly where the variable lives.
        `clear the pin ON THE COMFYUI HOST: unset ${PANEL_PIN_ENV_VAR} in that ` +
        `machine's environment (or ~/.comfyui-mcp/.env) and restart the ` +
        `orchestrator running there`
      : `clear the pin ON THE COMFYUI HOST — install_comfyui(action:'panel') cannot act in this ` +
        `session, so remove it from that machine's ` +
        `~/.comfyui-mcp/panel-settings.json and restart the orchestrator ` +
        `running there`;

  throw new PanelPinnedError(
    bulk
      ? `Refusing to ${action} "${id}": that would also move the sidebar panel pack, ` +
        `which is ${describePanelPin(pin)}. ComfyUI-Manager cannot update ` +
        `everything-except-one-pack, so either ${clearIt} and re-run, or update the ` +
        `other packs individually by id.`
      : `Refusing to ${action} the sidebar panel pack ("${id}"): it is ` +
        `${describePanelPin(pin)}. A pin is honoured even when a newer panel exists — ` +
        `${clearIt}, then re-run.`,
  );
}

/**
 * Refuse a panel-pack mutation on a path that has NO on-disk verification —
 * currently the sidebar `panel_install_node` / `panel_update_node` tools (which
 * drive the user's built-in ComfyUI Manager through the browser) and
 * `install_custom_node` action:"fix".
 *
 * These cannot be redirected into the verified path: `panel_*` acts on the
 * panel's own host through the browser Manager (which may not even be the
 * filesystem this process can read), and `fix` has no verified equivalent. Both
 * report success from the Manager queue alone — precisely the #639 signal that
 * proves nothing. Rather than let the panel be moved unverifiably, or pretend we
 * checked, they refuse and name the tool that does verify.
 *
 * The pin is reported FIRST when set, because that is the more specific reason.
 *
 * #774/#784 — the REDIRECT is resolved from the session context rather than
 * hardcoded to "use install_comfyui(action:'panel')". Pairing this refusal with a pointer at a
 * tool that is a no-op here (remote/cloud) or absent here (the embedded
 * `panel_*` surface) is what closed the loop into a deadlock: every door the
 * user tried named another door that was also shut. Refusing remains correct —
 * this path genuinely cannot verify the move — but the way out must be real.
 */
export function assertPanelNotTargetedUnverifiable(
  toolName: string,
  // `unknown` on purpose: panel-tool handlers receive loosely-typed args, and a
  // guard that forced a cast at every call site would eventually be skipped.
  id: unknown,
): void {
  if (typeof id !== "string" || !targetsPanelPack(id)) return;
  assertPanelPinAllows(toolName, id); // pinned → the pin message wins
  throw new PanelPinnedError(
    `${toolName} cannot manage the comfyui-mcp sidebar panel pack ("${id}"). That ` +
      `path reports success as soon as the ComfyUI-Manager queue drains, which a ` +
      `stale Manager does WITHOUT doing any work (#639) and which cannot see a ` +
      `".bak" shadow copy shadowing the real panel (#641) — so it could tell you the ` +
      `panel updated when it did not. ${describePanelManagementRedirect()}`,
  );
}

// ---------------------------------------------------------------------------
// Cross-process mutation lock
//
// The first cut serialized panel mutations with a module-global promise chain.
// That is not enough and the claim built on it was wrong: running more than one
// orchestrator process is ordinary here (one per MCP client). Process A could
// pass its final pin check and begin an awaited Manager update while process B
// wrote a pin against its own, entirely separate chain — and A would then move a
// now-pinned panel.
//
// So the lock is a FILE under ~/.comfyui-mcp/, which is the only thing both
// processes share. In-process we still chain (a file lock alone would spin), and
// the whole thing is re-entrant so `runPanelAction` can call a guarded service
// function while already holding it.
// ---------------------------------------------------------------------------

/**
 * An explicitly-set-but-EMPTY redirect is a mistake, not an intent to use the
 * default — and treating it as unset hid exactly that mistake once already:
 * node-snapshots.test.ts assigned `"\0"` intending an fs-rejected path, Node
 * truncated the assignment to `""`, and the write silently fell through to the
 * developer's real home (#866). Fail loudly at resolution time instead.
 */
function redirectedStatePath(envVar: string, fallback: string): string {
  const value = process.env[envVar];
  if (value !== undefined && value.trim() === "") {
    throw new Error(
      `${envVar} is set but EMPTY. An empty override does not mean "use the default" — ` +
        `it falls through to the default (${fallback}) with no sign anything was wrong, ` +
        `which is how a test run came to write the developer's real home directory (#866). ` +
        `Set ${envVar} to a real path or unset it entirely.`,
    );
  }
  return value ?? fallback;
}

/** Lock file path. Overridable so tests never touch the real home directory. */
export function panelLockPath(): string {
  return redirectedStatePath(
    "COMFYUI_MCP_PANEL_LOCK",
    join(homedir(), ".comfyui-mcp", "panel-op.lock"),
  );
}

/** Default acquisition budget. Callers that must not block (the fire-and-forget
 *  on-load ensure) pass something much shorter. */
const DEFAULT_ACQUIRE_MS = 60_000;

const POLL_MS = 100;

let inProcessChain: Promise<unknown> = Promise.resolve();

/**
 * Marks the async context of the current lock HOLDER, so re-entrancy is scoped
 * to work actually running inside it.
 *
 * A process-global "held" flag was wrong and dangerous: while an update held the
 * lock, an UNRELATED concurrent request (a pin write, say) saw the flag set and
 * sailed straight through — landing precisely in the window between the update's
 * final pin check and its Manager call. AsyncLocalStorage makes the exemption
 * apply only to callers nested within the holder's own execution.
 */
const lockHolderContext = new AsyncLocalStorage<true>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Is the process that wrote a lock still running? */
/**
 * Whether the process that took a lock is still running — as far as a PID can
 * say, which is not very far.
 *
 * `process.kill(pid, 0)` answers "a process with that NUMBER exists". That is not
 * "our holder is alive" (codex gate P1): PIDs are recycled, so after a crashed
 * holder's number is reused by an unrelated program, the old answer was a
 * confident "STILL RUNNING" that refused the reclaim FOREVER — leaving #760's
 * wedge in place through the very fix meant to clear it. An existence check
 * standing in for an identity check is this repo's dominant fold pointed at a
 * positive.
 *
 * So this reports THREE states, and the caller must not collapse them:
 *   - `false`   — no such process. Provably not our holder.
 *   - `true`    — a process with that pid exists AND the lock is young enough
 *                 that recycling is not a plausible explanation.
 *   - `"unsure"` — a process exists, but the lock is old enough that the number
 *                 may since have been reused. Liveness is UNDETERMINED.
 *
 * The `startedAt` on the record is the LOCK's creation time, not the process's,
 * so it cannot establish identity either; closing that properly needs a
 * per-process start time this module does not have. What it CAN do is stop
 * asserting the strong claim.
 */
function pidLiveness(pid: unknown, ageMs: number): boolean | "unsure" {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  let exists: boolean;
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(pid, 0);
    exists = true;
  } catch (err) {
    // EPERM = the process exists but belongs to someone else — still there.
    exists = (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
  if (!exists) return false;
  // The boundary is STALE_LOCK_MS, not an invented interval (codex gate). Six
  // hours was indefensible in both directions: PIDs can be recycled far sooner,
  // and a genuine operation running longer would have been called undetermined.
  //
  // STALE_LOCK_MS is the line this module already draws for "no legitimate panel
  // operation is still running", and it is exactly the right one here. Inside it,
  // an existing pid IS evidence about our holder — the operation could still be
  // going. Outside it, the holder should have finished, so an existing pid is
  // equally well explained by a crash plus reuse, and claiming either is a guess.
  //
  // Note the reclaim path refuses on age before it ever consults liveness, so
  // "unsure" only ever describes a lock old enough for the doubt to be real.
  return ageMs > STALE_LOCK_MS ? "unsure" : true;
}

/**
 * A lock is PROVABLY abandoned only when it is BOTH older than this AND owned
 * by a dead process. Panel operations are ComfyUI-Manager queue cycles
 * measured in seconds to minutes; ten minutes is far beyond a legitimate one,
 * so a lock older than that with a dead owner cannot be a live op — while a
 * younger lock, even with a dead-looking owner, stays untouched.
 */
const STALE_LOCK_MS = 10 * 60_000;

/** What observing the lock file could establish about its holder. */
interface PanelLockObservation {
  /** Milliseconds since the lock file's mtime. */
  ageMs: number;
  /** The file's exact bytes when readable — the reclaim's compare token. */
  raw?: string;
  /** The recorded owner pid, when the content parses and carries a valid one. */
  pid?: number;
  /** When the lock was taken (the record's startedAt), for messages. */
  startedAt?: string;
  /** Pid liveness — only set when a valid pid was recorded. */
  /** Tri-state: see `pidLiveness`. "unsure" must NOT be read as either boolean. */
  alive?: boolean | "unsure";
  /** Why the content proved nothing about the owner (unreadable/corrupt/pid). */
  contentProblem?: string;
}

/**
 * Observe the lock WITHOUT acting on it. Returns undefined when the path
 * cannot be opened (usually: vanished) — the caller's next create attempt or
 * re-observation settles that.
 *
 * Stat and read go through ONE descriptor, so the age and the owner bytes
 * always describe the SAME instance: with separate path-based calls, a lock
 * replaced between the stat and the read would pair the OLD lock's mtime with
 * the FRESH lock's pid, and a young lock could be judged old (codex gate). A
 * lock file is written once at creation, so an mtime/size change between the
 * two fstats means in-place interference — indeterminate, not stale.
 *
 * Deliberately conservative: any content that cannot yield a valid pid is a
 * `contentProblem`, NOT a dead owner. An unreadable/corrupt lock cannot prove
 * abandonment, and treating "we couldn't tell" as "the owner is gone" is how a
 * live holder's lock gets deleted (#796's fold, pointed at a positive).
 */
function observePanelLock(path: string): PanelLockObservation | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    // ONLY ENOENT proves absence. Any other open failure (permissions, AV
    // interference, I/O) means the lock is present but uninspectable — that
    // must read as indeterminate, never as "no lock" (codex gate).
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    let ageMs = 0;
    try {
      ageMs = Math.max(0, Date.now() - statSync(path).mtimeMs);
    } catch {
      // display-only
    }
    return {
      ageMs,
      contentProblem: `could not be opened (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  try {
    const before = fstatSync(fd);
    const raw = readFileSync(fd, "utf-8");
    const after = fstatSync(fd);
    const ageMs = Math.max(0, Date.now() - after.mtimeMs);
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
      return { ageMs, contentProblem: "changed while being read" };
    }
    let record: { pid?: unknown; startedAt?: unknown };
    try {
      record = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown };
    } catch {
      return { ageMs, raw, contentProblem: "is not valid JSON" };
    }
    const startedAt = typeof record?.startedAt === "string" ? record.startedAt : undefined;
    const pid = record?.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      return { ageMs, raw, startedAt, contentProblem: "records no valid owner pid" };
    }
    return { ageMs, raw, pid, startedAt, alive: pidLiveness(pid, ageMs) };
  } catch (err) {
    // A mid-read failure (e.g. the fd turned out to be a directory). The age
    // here is display-only — the contentProblem is what the decision reads.
    let ageMs = 0;
    try {
      ageMs = Math.max(0, Date.now() - statSync(path).mtimeMs);
    } catch {
      // vanished mid-observation; the message just says what it can
    }
    return {
      ageMs,
      contentProblem: `unreadable (${err instanceof Error ? err.message : String(err)})`,
    };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // nothing to do with a close failure on a read-only observation
    }
  }
}

/** "12 minutes" / "3 hours" — for human-facing lock messages. */
function describeLockAge(ageMs: number): string {
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 120) return `${minutes} minutes`;
  return `${Math.round(minutes / 60)} hours`;
}

/** Compose the observed lock state as one sentence for error/report text. */
function describeObservedLock(path: string, obs: PanelLockObservation): string {
  const age = describeLockAge(obs.ageMs);
  if (obs.pid === undefined) {
    return (
      `The lock at ${path} was taken ${age} ago, but its content ${obs.contentProblem}, ` +
      `so its owner cannot be identified.`
    );
  }
  return (
    `The lock at ${path} was taken ${age} ago by pid ${obs.pid}` +
    `${obs.startedAt ? ` (started ${obs.startedAt})` : ""}, and ` +
    (obs.alive === "unsure"
      ? `a process with that pid exists — but the lock is old enough that the number may ` +
        `since have been reused, so whether the ORIGINAL owner is still running cannot be ` +
        `determined from the pid alone.`
      : obs.alive
        ? `that process is STILL RUNNING.`
        : `that process is no longer running.`)
  );
}

export interface PanelLockReclaimResult {
  outcome: "no-lock" | "reclaimed" | "refused";
  /** What was observed and what was (not) done — safe to relay verbatim. */
  detail: string;
}

/**
 * Reclaim the panel operation lock — ONLY when it is provably abandoned
 * (#760): older than STALE_LOCK_MS AND owned by a recorded pid that is dead.
 * Every other state refuses, because deleting a lock whose holder might be
 * alive is how two panel mutations run at once.
 *
 * This is the explicit, operator/agent-invoked recovery that the acquire
 * path's timeout message names. The acquire loop itself NEVER reclaims
 * automatically (#779): Node has no atomic compare-and-rename, so between a
 * stale observation and a delete, a concurrent (e.g. pre-upgrade)
 * orchestrator could replace the path with a fresh lock and have it stolen.
 * The same race is bounded here by RENAMING the file aside first and
 * comparing its bytes against the observed ones: a lock that was replaced
 * between observation and reclaim does not match and is never deleted. The
 * restore is a HARD LINK, not a rename — rename would silently overwrite a
 * fresh lock that appeared at the path in the meantime, while linkSync fails
 * with EEXIST and both files are reported, nothing destroyed.
 */
export function reclaimAbandonedPanelLock(): PanelLockReclaimResult {
  const path = panelLockPath();
  // A test pointed at the real home must never move or delete a lock a live
  // orchestrator is holding — reclaim is exactly the operation that does.
  assertNotWritingRealHomeInTests(path, "the panel operation lock");
  const obs = observePanelLock(path);
  if (!obs) {
    return {
      outcome: "no-lock",
      detail:
        `No panel operation lock is present at ${path} — nothing to reclaim. ` +
        `Whatever was blocking panel operations is already gone.`,
    };
  }
  const manual =
    `To clear it by hand instead: stop or restart every comfyui-mcp orchestrator, ` +
    `verify none remain, delete this exact lock file, then retry.`;
  const refuse = (why: string): PanelLockReclaimResult => ({
    outcome: "refused",
    detail: `Refusing to reclaim the panel operation lock: ${why} ${manual}`,
  });

  // No valid pid → abandonment is unprovable at ANY age; say what the content
  // actually showed rather than hiding behind the age gate.
  if (obs.pid === undefined) {
    return refuse(
      `it is ${describeLockAge(obs.ageMs)} old, but its content ${obs.contentProblem}, ` +
        `so there is no owner whose death could prove it abandoned.`,
    );
  }
  if (obs.ageMs <= STALE_LOCK_MS) {
    return refuse(
      `it was taken only ${describeLockAge(obs.ageMs)} ago — inside the ` +
        `${STALE_LOCK_MS / 60_000}-minute window in which a slow ComfyUI-Manager ` +
        `operation is still legitimate, so it cannot be called abandoned.`,
    );
  }
  if (obs.alive === "unsure") {
    // NOT "STILL RUNNING" (codex gate P1). The old code asserted that from a bare
    // existence check, so a recycled PID refused this reclaim indefinitely — #760's
    // wedge surviving its own fix. Still refusing is right (deleting a live lock is
    // worse than leaving a stuck one), but the reason has to be true, and the user
    // needs the manual path that the false certainty used to hide.
    return refuse(
      `it is ${describeLockAge(obs.ageMs)} old and a process with pid ${obs.pid} exists, ` +
        `but at that age the pid may have been REUSED by an unrelated program — so whether ` +
        `the original owner is still running cannot be determined, and abandonment cannot ` +
        `be proven. Nothing was deleted. If you are certain no panel operation is running ` +
        `(check that pid: if it is not a comfyui-mcp orchestrator, it is not the owner), ` +
        `delete ${path} by hand.`,
    );
  }
  // NOTE: there is deliberately no `obs.alive === true` branch here. With the
  // reuse doubt bounded by STALE_LOCK_MS — the same line the age check above
  // draws — any lock that reaches this point is already past it, so liveness is
  // "unsure" or a proven dead pid. A `STILL RUNNING` branch would be unreachable
  // code that reads like a live guarantee. `describeLock` still reports a running
  // owner for YOUNGER locks, where an existing pid really is evidence.

  // Provably abandoned. Rename aside, verify the moved file is the EXACT bytes
  // that were judged abandoned, and only then delete.
  const claim = `${path}.reclaim-${randomUUID()}`;
  try {
    renameSync(path, claim);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return {
        outcome: "no-lock",
        detail:
          `The abandoned lock at ${path} disappeared before it could be reclaimed — ` +
          `another process removed it first. This call deleted nothing.`,
      };
    }
    return refuse(
      `moving it aside failed (${err instanceof Error ? err.message : String(err)}), ` +
        `so its current state could not be verified.`,
    );
  }
  let moved: string | undefined;
  try {
    moved = readFileSync(claim, "utf-8");
  } catch {
    moved = undefined;
  }
  if (moved === undefined || moved !== obs.raw) {
    // The path was REPLACED between the observation and the rename: what was
    // moved aside is a different (possibly live) holder's lock. Put it back
    // with a HARD LINK, never a rename — a rename would silently OVERWRITE a
    // fresh lock that landed at the path in the meantime (codex gate), while
    // linkSync fails with EEXIST and leaves both files intact.
    try {
      linkSync(claim, path);
    } catch (err) {
      if (existsSync(path)) {
        return {
          outcome: "refused",
          detail:
            `The lock at ${path} changed mid-reclaim, and yet another lock appeared at ` +
            `the path before the replaced one could be restored. Nothing was deleted or ` +
            `overwritten: the replaced lock is preserved at ${claim}. Stop every ` +
            `comfyui-mcp orchestrator, verify none remain, then reconcile both files ` +
            `by hand.`,
        };
      }
      return {
        outcome: "refused",
        detail:
          `The lock at ${path} changed mid-reclaim and restoring it failed ` +
          `(${err instanceof Error ? err.message : String(err)}). Nothing was deleted: ` +
          `the replaced lock is preserved at ${claim} and the path is currently free. ` +
          `Stop every comfyui-mcp orchestrator, verify none remain, then reconcile ` +
          `both files by hand.`,
      };
    }
    // The restore succeeded. The claim name is now a duplicate (hard link) of
    // the restored lock, so removing it is cosmetic — a failure here must NOT
    // be reported as a restore failure (codex gate).
    const restored = refuse(
      `the lock changed between inspection and reclaim — a DIFFERENT holder's lock ` +
        `is now at ${path}. It was put back untouched; nothing was deleted.`,
    );
    try {
      rmSync(claim, { force: true });
      return restored;
    } catch {
      return {
        ...restored,
        detail:
          `${restored.detail} (A duplicate name for it remains at ${claim} — a hard ` +
          `link to the same restored lock; delete it by hand, it blocks nothing.)`,
      };
    }
  }
  // The abandoned lock is verified and moved aside; the lock path is already
  // free, so the reclaim HAS succeeded — a failure removing the aside copy is
  // cleanup, and must be reported as such, never as a reclaim failure (codex).
  const reclaimed: PanelLockReclaimResult = {
    outcome: "reclaimed",
    detail:
      `Reclaimed the abandoned panel operation lock at ${path}: it was ` +
      `${describeLockAge(obs.ageMs)} old and its owner, pid ${obs.pid}` +
      `${obs.startedAt ? ` (started ${obs.startedAt})` : ""}, is no longer running. ` +
      `That abandoned lock no longer blocks panel operations; if another operation ` +
      `has since taken a fresh lock there, the usual wait/timeout applies to it.`,
  };
  try {
    rmSync(claim, { force: true });
    return reclaimed;
  } catch (err) {
    return {
      ...reclaimed,
      detail:
        `${reclaimed.detail} (Removing the renamed-aside copy at ${claim} failed: ` +
        `${
          err instanceof Error ? err.message : String(err)
        } — delete that file by hand; it blocks nothing.)`,
    };
  }
}

/** The `token` from a lock record, or undefined when it cannot be read. Used to
 *  identify a lock across observations (#1489); pid+startedAt alone cannot. */
function lockRecordToken(obs: { raw?: string }): string | undefined {
  if (typeof obs.raw !== "string") return undefined;
  try {
    const t = (JSON.parse(obs.raw) as { token?: unknown }).token;
    return typeof t === "string" ? t : undefined;
  } catch {
    return undefined;
  }
}

async function acquireFileLock(timeoutMs: number): Promise<() => void> {
  const path = panelLockPath();
  assertNotWritingRealHomeInTests(path, "the panel operation lock");
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  // #1489 — throttle for the dead-owner probe below. The poll runs every 100 ms
  // and `observePanelLock` does a stat + read, so probing on every tick would be
  // ~600 syscall pairs over a full wait to answer a question that cannot change
  // that fast. First probe fires immediately (the common case is a lock left by
  // an orchestrator that died some time ago, and that is answerable at once).
  const LIVENESS_PROBE_MS = 1_000;
  let nextLivenessProbe = 0;
  /** `pid@startedAt` of a dead+stale lock seen on the PREVIOUS probe. The fast
   *  path fires only when the next probe sees the same one — see below. */
  let deadOwnerCandidate: string | undefined;

  for (;;) {
    try {
      // Hoisted above the open so the RELEASE closure can close over it: the
      // release must be able to prove the file it is about to delete is the one
      // this iteration created (see the closure below).
      const token = randomUUID();
      // "wx" = create-exclusive: atomic across processes, which is the whole point.
      const fd = openSync(path, "wx");
      try {
        // A short writeSync is NOT a failure return — it reports the bytes
        // actually written. Loop to completion; a zero-byte progress means the
        // record would be truncated (an unreadable owner pid that reclaim can
        // never prove abandoned — the #760 wedge again), so fail the init and
        // let the cleanup below remove the husk (codex gate). The payload is
        // ASCII (pid + ISO timestamp), so string offsets track byte offsets.
        // `token` is what makes this lock IDENTIFIABLE, not merely attributable
        // (codex gate P0). pid+startedAt cannot distinguish two locks taken by the
        // same process, and more importantly they cannot tell the release closure
        // whether the file still at the path is the one it created — which is the
        // question that matters once a lock can be RECLAIMED out from under a
        // holder.
        const payload = JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          token,
        });
        let written = 0;
        while (written < payload.length) {
          const n = writeSync(fd, payload.slice(written), null, "utf-8");
          if (n <= 0) {
            throw new Error(
              `short write on the panel operation lock (${written}/${payload.length} bytes)`,
            );
          }
          written += n;
        }
        // Durable (#798): the recorded pid is the ONLY thing a post-crash
        // observation (the timeout report / reclaimAbandonedPanelLock) can prove
        // abandonment from — a buffered loss would leave an ownerless lock that
        // nothing can verify or reclaim.
        fsyncSync(fd);
        closeSync(fd);
      } catch (initErr) {
        // A failed init must not leave the husk behind: this call created the
        // file (exclusive create) and no mutation has run under it, so a
        // leftover would wedge every later acquire behind a lock whose recorded
        // owner is alive but holds nothing — and reclaim would rightly refuse
        // it (codex gate). Only the file THIS call created can be removed here:
        // no other process can have created or reclaimed the path in between
        // (reclaim requires an old lock with a dead owner; this one is fresh
        // and this process is alive).
        try {
          closeSync(fd); // may already be closed if closeSync itself threw
        } catch {
          // the init failure is the one to report
        }
        try {
          rmSync(path, { force: true });
        } catch (cleanupErr) {
          throw new Error(
            `Could not initialise the panel operation lock at ${path} (${
              initErr instanceof Error ? initErr.message : String(initErr)
            }), and removing the just-created file also failed (${
              cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
            }). The leftover lock is NOT held by any operation — delete that file ` +
              `by hand, then retry.`,
          );
        }
        throw initErr;
      }
      return () => {
        // PROVE OWNERSHIP BEFORE DELETING — and do it in a way a concurrent
        // reclaim cannot invalidate (codex gate P0, twice).
        //
        // A bare `rmSync(path)` deletes whatever is at the path, including a lock
        // another process took after ours was reclaimed. Reading the token first
        // is not enough either: read-then-unlink is TOCTOU, because a reclaimer
        // can rename the verified file aside and a third agent can take the freed
        // pathname in the gap — so the unlink still lands on a stranger.
        //
        // RENAME FIRST. That atomically removes whatever is at the path and puts
        // it somewhere only we know, so the thing we then inspect is the thing we
        // will act on. It is the same technique `reclaimAbandonedPanelLock` uses
        // for the same reason, including the hard-link restore that can never
        // overwrite a lock that landed in the gap.
        const claim = `${path}.release-${randomUUID()}`;
        try {
          renameSync(path, claim);
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return; // already gone
          logger.warn(
            `[panel] could not take the panel op lock at ${path} aside to release it (${
              err instanceof Error ? err.message : String(err)
            }); it may still be held. If no panel operation is running, delete that file.`,
          );
          return;
        }

        // The path is free from here on, whatever we decide — so the only
        // remaining question is what to do with the file in hand.
        let held: string | undefined;
        for (let attempt = 0; attempt < 2 && held === undefined; attempt++) {
          try {
            held = readFileSync(claim, "utf-8");
          } catch {
            held = undefined; // one retry: a transient read must not decide this
          }
        }
        let heldToken: unknown;
        if (held !== undefined) {
          try {
            heldToken = (JSON.parse(held) as { token?: unknown }).token;
          } catch {
            heldToken = undefined;
          }
        }

        if (held !== undefined && heldToken === token) {
          // Ours. Deleting the file we are holding aside cannot touch anyone else.
          try {
            rmSync(claim, { force: true });
          } catch (err) {
            logger.warn(
              `[panel] released the panel op lock but could not delete ${claim}: ${
                err instanceof Error ? err.message : String(err)
              }. It is no longer at ${path}, so it blocks nothing; delete it at your leisure.`,
            );
          }
          return;
        }

        // NOT ours, or unidentifiable. Either way we must not destroy it — put it
        // back. `linkSync` (never `renameSync`) so a lock that landed at the path
        // in the meantime is not overwritten.
        try {
          linkSync(claim, path);
          rmSync(claim, { force: true });
          logger.warn(
            `[panel] the panel op lock at ${path} was ${
              held === undefined
                ? "unreadable at release"
                : "no longer the one this operation took (it was reclaimed or replaced while the operation ran)"
            }, so it was restored rather than deleted. Another operation may hold it.`,
          );
        } catch {
          logger.warn(
            `[panel] the panel op lock at ${path} was ${
              held === undefined ? "unreadable" : "not the one this operation took"
            } at release, and restoring it failed — most likely because another lock ` +
              `already occupies the path, which is the outcome that matters. Nothing was ` +
              `deleted; the file taken aside is preserved at ${claim}.`,
          );
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
        // Anything other than "already held" is a real failure. FAIL CLOSED:
        // proceeding without the lock is how a pinned user gets moved.
        throw new Error(
          `Could not take the panel operation lock at ${path}: ${
            err instanceof Error ? err.message : String(err)
          }. Refusing to mutate the panel without it.`,
        );
      }
      if (Date.now() >= deadline) {
        // Report the OBSERVED state of the lock that blocked us — the remedy
        // differs by whether its owner is alive, and "another operation is in
        // progress" is a claim we could not verify without looking.
        const obs = observePanelLock(path);
        if (!obs) {
          if (!existsSync(path)) {
            // It vanished between EEXIST and the deadline: the next create
            // attempt settles it, so keep looping rather than report a timeout
            // against a lock that is no longer there.
            continue;
          }
          // Present but not inspectable (a permissions/IO failure on stat is
          // NOT proof the holder is gone) — fail closed with the manual path.
          throw new Error(
            `Timed out after ${timeoutMs}ms waiting for the panel operation lock ` +
              `(${path}). The lock file exists but could not be inspected, so its ` +
              `owner is unknown and it cannot be auto-reclaimed. To recover it by ` +
              `hand: stop or restart every comfyui-mcp orchestrator, verify none ` +
              `remain, delete this exact lock file, then retry.`,
          );
        }
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for the panel operation lock. ` +
            `${describeObservedLock(path, obs)} The lock is never auto-reclaimed: a ` +
            `concurrent pre-upgrade orchestrator could replace an observed stale path ` +
            `with a fresh lock. To recover a proven abandoned lock, run ` +
            `install_comfyui(action:'panel', panel_action:'unlock') — it re-verifies that the recorded owner is ` +
            `dead and the lock is old before deleting anything, and refuses otherwise. ` +
            `Or do it by hand: stop or restart every comfyui-mcp orchestrator, verify ` +
            `none remain, delete this exact lock file, then retry.`,
        );
      }
      // #1489 — a PROVABLY DEAD owner is knowable now, so do not spend the rest
      // of the 60 s discovering it. This is a latency narrowing ONLY: the outcome
      // is the same refusal with the same remedy, delivered when it is first
      // provable instead of at the deadline.
      //
      // Deliberately NOT an auto-reclaim. #779 made stale-lock recovery
      // fail closed on purpose — a concurrent pre-upgrade orchestrator can
      // replace an observed stale path with a fresh lock, so deleting on our own
      // observation can destroy a live holder's lock. `panel_action:"unlock"`
      // re-verifies under its own rules and stays the only path that removes
      // anything.
      //
      // ONLY `alive === false` short-circuits. `"unsure"` is a recycled-pid
      // maybe and MUST keep waiting — treating it as dead is the exact
      // existence-for-identity fold `pidLiveness` was written to stop. `true`
      // means a real operation may still be running.
      // AGE GATES BEFORE LIVENESS, matching `reclaimAbandonedPanelLock`, which
      // refuses on age before it ever consults a pid. A FRESH lock is protected
      // even when its recorded owner is dead — that is a deliberate rule with
      // its own test ("does NOT reclaim a fresh lock even when its recorded pid
      // is dead"), and an early report that ignored it would be this module
      // holding two different opinions about what freshness means. Short-cutting
      // only the STALE case still covers the report, whose lock had been
      // blocking long enough to need a manual unlock.
      if (Date.now() >= nextLivenessProbe) {
        nextLivenessProbe = Date.now() + LIVENESS_PROBE_MS;
        const early = observePanelLock(path);
        // TWO CONSISTENT OBSERVATIONS, a probe interval apart (review finding).
        //
        // One reading is not enough to cut a wait short. Between observing a
        // dead+stale lock and raising the refusal, another process can release
        // and a third can take a FRESH one at the same path — and we would then
        // reject a legitimate current holder while asserting its owner is dead.
        // The deadline path does not have this problem: by then the full budget
        // is spent and the refusal is owed regardless of what sits there now.
        //
        // Identity is `pid + startedAt` from the record, not the path. A
        // replacement changes it and resets the candidate, so the fast path only
        // fires on a lock that was demonstrably the same one for a full probe
        // interval. It cannot close the window absolutely — nothing short of an
        // atomic take can — but it converts "one glance" into "unchanged across
        // a second", and the failure it protects is a false refusal, never a
        // deletion.
        // The record's `token` is what makes a lock IDENTIFIABLE rather than
        // merely attributable — it exists because pid+startedAt cannot
        // distinguish two locks taken by the same process, and a replacement
        // could in principle reuse both (review finding). Include it, and fall
        // back to the raw record when it cannot be parsed, so an unreadable
        // record can never fingerprint-match a different unreadable one.
        const fingerprint =
          early && early.alive === false && early.ageMs >= STALE_LOCK_MS
            ? `${String(early.pid)}@${String(early.startedAt)}#${lockRecordToken(early) ?? `raw:${String(early.raw)}`}`
            : undefined;
        const confirmed = fingerprint !== undefined && fingerprint === deadOwnerCandidate;
        deadOwnerCandidate = fingerprint;
        if (confirmed && early) {
          // Stated as an OBSERVATION, not as present-tense fact. The lock can
          // still be replaced between this read and this throw — that window is
          // inherent to observe-then-act and no amount of re-reading removes it
          // (review, round 2). What two matching probes DO establish is that the
          // sentence below was true for a full interval, which is a claim this
          // can actually keep. The cost of being overtaken is one spurious error
          // on a retryable operation; nothing is deleted either way.
          throw new Error(
            `The panel operation lock at ${path} was held, for at least the last ` +
              `${Math.round(LIVENESS_PROBE_MS / 1000)}s, by a process that is no longer ` +
              `running. ${describeObservedLock(path, early)} Not waiting out the remaining ` +
              `timeout, and not deleting it either: a concurrent orchestrator could have ` +
              `replaced it since it was observed. To clear a proven abandoned lock, run ` +
              `install_comfyui(action:'panel', panel_action:'unlock') — it re-verifies that the recorded ` +
              `owner is dead and the lock is old before deleting anything, and refuses ` +
              `otherwise. Or do it by hand: stop or restart every comfyui-mcp orchestrator, ` +
              `verify none remain, delete this exact lock file, then retry.`,
          );
        }
      }
      await sleep(POLL_MS);
    }
  }
}

/**
 * Run `fn` with exclusive rights to mutate the panel or its pin, across BOTH
 * async callers in this process and other orchestrator processes.
 *
 * Re-entrant: a nested call while this process already holds the lock runs
 * immediately (the in-process chain guarantees only one holder is executing, so
 * a nested acquisition can only come from the holder itself). Rejections never
 * wedge the chain.
 */
export function withPanelMutationLock<T>(
  fn: () => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  // Only work running INSIDE the current holder is exempt — not everything that
  // happens to overlap it in this process.
  if (lockHolderContext.getStore()) return fn();

  // `run` is the chain's settle CALLBACK — deliberately a function, NOT an
  // invoked IIFE (note: no trailing `()`). Passing an already-started promise
  // to .then() would resolve callers immediately with the chain's value while
  // the guarded work floated unfinished. Written without the `(async () =>
  // {...})` grouping parens because that shape reads as an IIFE and has been
  // mis-reviewed as one; the semantics were and are: callers resolve only
  // after the guarded action AND the release complete.
  const run = async (): Promise<T> => {
    const release = await acquireFileLock(opts.timeoutMs ?? DEFAULT_ACQUIRE_MS);
    try {
      return await lockHolderContext.run(true, fn);
    } finally {
      release();
    }
  };

  const started = inProcessChain.then(run, run);
  inProcessChain = started.then(
    () => undefined,
    () => undefined,
  );
  return started;
}

/**
 * Run a panel-moving mutation atomically with its pin check.
 *
 * assertPanelPinAllows alone is a TOCTOU race: the check passes, and THEN a pin
 * can be written before/while the ComfyUI-Manager operation runs (an update-all
 * drain takes seconds), so the update lands on a by-then-pinned panel. The pin
 * WRITE path takes this same lock, so checking inside it and holding it across
 * the whole mutation means a pin either lands before the op starts (and blocks
 * it) or after it finishes (and blocks the next one) — never in the middle.
 *
 * Targets that cannot move the panel skip the lock entirely: there is no pin
 * decision to make for them, and serializing every unrelated pack mutation
 * behind panel ops would be pointless contention.
 *
 * Re-entrant via withPanelMutationLock: runPanelAction already holds the lock
 * when it calls the guarded node-management mutations, so nesting is immediate.
 */
export function withPanelPinGuard<T>(
  action: string,
  id: string,
  op: () => Promise<T>,
): Promise<T> {
  if (!targetsPanelPack(id)) return op();
  return withPanelMutationLock(() => {
    assertPanelPinAllows(action, id);
    return op();
  });
}

// ---------------------------------------------------------------------------
// Pending panel-affecting operations
//
// Some panel-moving operations are handed to ComfyUI-Manager and then applied
// OUT OF BAND: update-all drains on the Manager's own worker after we return,
// and a snapshot restore is deferred to the next ComfyUI restart. The mutation
// lock cannot be held across that window (it would wedge pinning for minutes
// to days), and no completion/apply path exists IN THIS PROCESS to re-check a
// pin at — the Manager, not us, is the applying agent, which is exactly why
// the window exists. So each op records a marker here (with an expiry), and
// the pin-write path reads it inside the pin's critical section.
//
// A pin written while a marker is active does NOT just warn (#689): it
// attempts to CANCEL the pending work first (reset the Manager task queue /
// delete the deferred-restore file), clears the marker only for what was
// PROVABLY cancelled or proven no longer pending, and keeps the warning for
// the residue — in-flight work, remote hosts, anything unverifiable. The
// lock-held variants — install_custom_node(action:"update", id="all"), which waits
// for the drain inside the lock, and every install_comfyui(action:'panel') mutation — need no marker:
// no pin can be written inside their window at all.
// ---------------------------------------------------------------------------

export interface PanelPendingOp {
  /** What is pending: "update-all" | "snapshot-restore" (unknown kinds are
   *  tolerated when reading, so an older/newer record never reads as clear). */
  kind: string;
  /** Unique record id (records written before ids existed fall back to
   *  kind+queuedAt matching — which collides for two records minted in the
   *  same millisecond, so a stale clear could take the live one with it). */
  id?: string;
  /** When it was handed to ComfyUI-Manager (ISO). */
  queuedAt: string;
  /** When the warning lapses (ISO). After this the pin governs as usual — the
   *  pending op has either landed (the pin then holds FUTURE ops) or failed. */
  expiresAt: string;
  /** Human-facing explanation for the pin-write warning. */
  detail: string;
  /** The ComfyUI base URL the op was handed to, captured at enqueue time. A
   *  pin-write cancellation must target the ORIGINAL server even if the
   *  orchestrator has since been retargeted; when absent (older markers) the
   *  cancel falls back to the current target and says so in its report. */
  base?: string;
  /** update-all only: the ui_id of the enqueue attempt that actually landed
   *  (v4 derives each per-pack task id as `${uiId}_${pack}`), so a v4 host can
   *  later answer "did the panel's task already run" via
   *  /v2/manager/queue/history?ui_id=…. */
  uiId?: string;
}

/** update-all drains in minutes on the Manager's worker; an hour is far beyond
 *  a legitimate drain, so reclaiming then cannot cut a live op short. */
export const UPDATE_ALL_PENDING_MS = 60 * 60_000;

/** A snapshot restore is applied at the next ComfyUI restart, which this
 *  process cannot observe — that could be days away. The marker cannot outlive
 *  restarts forever, so it expires after a week and says so in its detail. */
export const SNAPSHOT_RESTORE_PENDING_MS = 7 * 24 * 60 * 60_000;

/** Marker file path. Overridable so tests never touch the real home directory. */
export function panelPendingOpsPath(): string {
  return redirectedStatePath(
    "COMFYUI_MCP_PANEL_PENDING",
    join(homedir(), ".comfyui-mcp", "panel-pending-ops.json"),
  );
}

function isPanelPendingOp(value: unknown): value is PanelPendingOp {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const op = value as Record<string, unknown>;
  return (
    typeof op.kind === "string" &&
    typeof op.queuedAt === "string" &&
    typeof op.expiresAt === "string" &&
    typeof op.detail === "string" &&
    (op.base === undefined || typeof op.base === "string") &&
    (op.uiId === undefined || typeof op.uiId === "string")
  );
}

/** Why a read produced no usable ops. The distinction that matters is `empty`
 *  vs `unparseable`, and it exists because collapsing them wedged `update-all`
 *  permanently (#847).
 *
 *  A ZERO-BYTE file is not "a record we cannot read" — it is a file with no
 *  bytes, so there is no operation recorded in it and nothing to lose by
 *  superseding it. An unparseable file with CONTENT may well describe a real
 *  queued operation whose warning we simply cannot decode, and overwriting that
 *  destroys the warning. Same "we got nothing usable", two different questions. */
type PendingOpsReadState = "absent" | "empty" | "readable" | "unparseable";

interface PendingOpsRead {
  ops: PanelPendingOp[];
  /** True when we cannot prove nothing is pending — `empty` counts, because an
   *  interrupted write is indistinguishable from a file that never got content. */
  unreadable: boolean;
  state: PendingOpsReadState;
}

/**
 * Replace the marker atomically: write a uniquely-named temp beside it, fsync,
 * then rename over the target.
 *
 * `writeFileSync` TRUNCATES in place, so a crash after truncation and before the
 * content lands leaves a ZERO-BYTE file that previously held real operations.
 * That is what made "an empty file records nothing" untrue for this writer, and
 * it is the hole the independent gate found in the first cut of #847 — the write
 * path would have superseded such a file and silently dropped a queued
 * operation's warning. A rename is atomic: a reader sees the whole old content or
 * the whole new content, never nothing.
 *
 * The temp name carries a uuid because two agents share this rig, and a fixed
 * `.tmp` would let concurrent writers clobber each other's staging file.
 */
function writePanelPendingOpsAtomic(path: string, body: string): void {
  // The third time the suite wrote the developer's real state it was THIS
  // file (#866): the orchestrator reads these markers, so leftovers make every
  // pin write warn about operations that never happened. Refuse at the write —
  // per-test scoping of COMFYUI_MCP_PANEL_PENDING kept eroding exactly the way
  // the issue predicted.
  assertNotWritingRealHomeInTests(path, "the pending panel-operation record");
  // Rebase reconciliation (#847 + #798). Both branches grew a temp+fsync+rename
  // writer for this file. `writeFileDurable` is the stronger one: it does
  // everything this function used to, and then fsyncs the CONTAINING DIRECTORY so
  // the rename's directory entry is itself durable — tolerating the one platform
  // that cannot do that (Windows EPERM) while still failing on a real I/O error.
  // Without that last step a crash can lose the rename even though the file's own
  // fsync succeeded, which is exactly the window this marker exists to cover.
  //
  // Keeping two near-identical writers would have meant one of them silently
  // losing the directory fsync, so this delegates rather than duplicating.
  mkdirSync(dirname(path), { recursive: true });
  writeFileDurable(path, body);
}

function readPanelPendingOpsFile(): PendingOpsRead {
  const path = panelPendingOpsPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    // Only ENOENT proves there is no marker. Permission/I/O errors are
    // indeterminate and must keep a later pin from claiming clean protection.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ops: [], unreadable: false, state: "absent" };
    }
    return { ops: [], unreadable: true, state: "unparseable" };
  }
  // A zero-byte (or whitespace-only) file: `JSON.parse("")` throws, so this used
  // to land in `unparseable` and refuse forever. It stays `unreadable` for the
  // READ question — an interrupted write is indistinguishable from a file that
  // never got content, so a pin must still warn — but it is separately marked so
  // the WRITE path can supersede it. See the type comment above.
  if (raw.trim() === "") {
    return { ops: [], unreadable: true, state: "empty" };
  }
  // A zero-byte file is the signature of a torn pre-#798 write (crash between
  // truncate and write). It provably contains NO record — reading it as
  // "unreadable" would refuse every later update-all / warn on every pin
  // forever, with no recovery path, over a file we can read perfectly well.
  // (Non-empty unparseable content stays unreadable: it COULD have held a
  // record, and failing closed there is the whole point.)
  // Rebase resolution: `main` (#847) settled this as `unreadable: true` with an
  // explicit `state`, NOT a clean empty read. Both facts are load-bearing and they
  // are not in tension: `unreadable` keeps a later pin WARNING (an interrupted
  // write cannot be told from a file that never got content), while `state:
  // "empty"` is what lets a writer supersede it instead of refusing forever. This
  // branch had been rewritten to `unreadable: false`, which silently dropped the
  // warning half.
  if (raw.length === 0) return { ops: [], unreadable: true, state: "empty" };
  try {
    const parsed = JSON.parse(raw) as unknown;
    const ops =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as { ops?: unknown }).ops
        : undefined;
    if (Array.isArray(ops) && ops.every(isPanelPendingOp)) {
      return { ops, unreadable: false, state: "readable" };
    }
  } catch {
    // fall through
  }
  return { ops: [], unreadable: true, state: "unparseable" };
}

/**
 * Record that a panel-affecting operation was handed to ComfyUI-Manager and may
 * still land out-of-band. Replaces any prior marker of the same kind.
 *
 * Call this BEFORE handing the operation to ComfyUI-Manager. A mutation whose
 * out-of-band window cannot be durably recorded must not start: otherwise a
 * user can set a pin immediately afterwards and be told it protects a panel
 * which the already-queued Manager operation is still free to move. The write
 * is fsync'd (so the record cannot be lost while the action it describes
 * survives, #798) and read back before returning, so a successful syscall
 * alone is not treated as proof that the warning is durable.
 *
 * Once this succeeds, callers deliberately leave the marker in place even if
 * their Manager request errors. A transport error cannot prove the remote
 * Manager did not accept the request, and retaining a conservative warning is
 * safer than letting a later pin claim clean protection.
 *
 * On FAILURE the file is rolled back to the PRE-CALL record set — not merely
 * "without this call's record": the write REPLACES a same-kind predecessor,
 * and that predecessor may describe an operation still pending with the
 * Manager (codex gate). The rollback only fires when the file still holds
 * exactly what this call wrote, so a concurrent recorder's work is never
 * erased, and it is skipped entirely when the caller passes
 * `keepRecordOnFailure: true` — a call that merely RE-RECORDS an operation
 * already handed to the Manager (the update-all base/uiId enrichment), where
 * the operation IS pending and the marker must survive a failed enrichment.
 */
export function recordPanelPendingOp(
  kind: "update-all" | "snapshot-restore",
  detail: string,
  ttlMs: number,
  extra: { base?: string; uiId?: string; keepRecordOnFailure?: boolean } = {},
): PanelPendingOp {
  const now = Date.now();
  const op: PanelPendingOp = {
    kind,
    id: randomUUID(),
    queuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    detail,
    ...(extra.base ? { base: extra.base } : {}),
    ...(extra.uiId ? { uiId: extra.uiId } : {}),
  };
  let priorOps: PanelPendingOp[] | undefined;
  try {
    const path = panelPendingOpsPath();
    const prior = readPanelPendingOpsFile();
    // Refuse only when the prior file has CONTENT we cannot decode: that content
    // may describe a real queued operation, and overwriting it destroys a warning
    // we were never able to read.
    //
    // A zero-byte file is NOT that. It records no operation, so superseding it
    // loses nothing — and refusing on it was self-perpetuating (#847): this write
    // is gated behind the check, so the only thing that could replace the bad file
    // was the thing the bad file blocked. Because `recordPanelPendingOp` runs
    // BEFORE the Manager handoff, that wedged `update-all` permanently, until a
    // human deleted the file by hand.
    //
    // The path is named either way. A refusal a user cannot act on from where they
    // are is the other half of what made this a dead end.
    if (prior.unreadable && prior.state !== "empty") {
      throw new Error(
        `existing pending-operation record at ${path} has content that could not be ` +
          `decoded, so it may describe a queued operation whose warning would be lost. ` +
          `Inspect it, then delete it to clear this.`,
      );
    }
    // Captured for #798's rollback: if the durable write lands but the directory
    // fsync fails, the caller restores exactly what was here before.
    priorOps = prior.ops;
    const kept = prior.ops.filter((o) => o.kind !== kind);
    mkdirSync(dirname(path), { recursive: true });
    // Superseding an EMPTY marker unwedges the operation, but it must not also
    // erase the possibility that the empty file masked a real queued op. A
    // pre-existing zero-byte file (written by the old truncating writer, before
    // writePanelPendingOpsAtomic) genuinely CAN be an interrupted write. So carry
    // an explicit indeterminate record forward: the block is lifted, the warning
    // is not. It warns rather than blocks, and clearPanelPendingOp can retire it.
    const carried: PanelPendingOp[] =
      prior.state === "empty"
        ? [
            {
              kind: "unknown",
              queuedAt: new Date(now).toISOString(),
              expiresAt: new Date(now + ttlMs).toISOString(),
              detail:
                `an EMPTY pending-operation marker was found at ${path} and superseded. It recorded ` +
                "no operation, but an interrupted write cannot be told from a file that never got " +
                "content, so a previously queued update or deferred restore may still be outstanding.",
            },
          ]
        : [];
    writePanelPendingOpsAtomic(path, JSON.stringify({ ops: [...carried, ...kept, op] }, null, 2));

    // Verify the exact replacement record, not merely that JSON still parses.
    // A partial/redirected write that drops this operation would recreate the
    // same false-protection window as a write failure.
    const confirmed = readPanelPendingOpsFile();
    if (
      confirmed.unreadable ||
      !confirmed.ops.some(
        (candidate) =>
          candidate.kind === op.kind &&
          candidate.queuedAt === op.queuedAt &&
          candidate.expiresAt === op.expiresAt &&
          candidate.detail === op.detail &&
          candidate.base === op.base &&
          candidate.uiId === op.uiId,
      )
    ) {
      throw new Error("pending-operation record did not survive a read-back verification");
    }
  } catch (err) {
    // The record MAY have landed before the failure (the atomic rename precedes
    // the directory sync, and the read-back can fail after a successful write).
    // This throw means the guarded operation will NOT start — so restore the
    // PRE-CALL record set: our write REPLACED a same-kind predecessor that may
    // still describe a live pending operation, and leaving OUR record instead
    // would warn every later pin about a phantom one (codex gate rounds 4+7).
    // Restore only when the file still holds exactly what this call wrote, so
    // a concurrent recorder's work is never erased; a failed restore leaves
    // the conservative over-warning, which is the safe direction.
    // A CATCH THAT CAN THROW IS NOT A GUARD (codex gate P0). The rollback below
    // lives inside the failure path, so its OWN failure had nowhere to go — it was
    // swallowed, and the refusal was then reported as if the disk were clean. What
    // actually remained was a phantom marker that a later pin reads as a real
    // queued operation: false pending, false cancellation reporting, and no hint
    // that anything was left behind.
    //
    // The rollback still cannot be made infallible here (the record must precede
    // the handoff, so there is no ordering that removes the window). What CAN be
    // made reliable is saying so: the outcome is tracked and disclosed.
    let leftover: string | undefined;
    if (!extra.keepRecordOnFailure && priorOps !== undefined) {
      const recordKey = (o: PanelPendingOp): string => o.id ?? `${o.kind}:${o.queuedAt}`;
      try {
        const path = panelPendingOpsPath();
        const current = readPanelPendingOpsFile();
        if (current.unreadable) {
          leftover =
            `the pending-operation file could not be read back, so whether this call's ` +
            `record is still on disk is UNKNOWN`;
        } else {
          const expected = new Set(
            [...priorOps.filter((o) => o.kind !== kind), op].map(recordKey),
          );
          const unchangedSinceOurWrite =
            current.ops.length === expected.size &&
            current.ops.every((c) => expected.has(recordKey(c)));
          if (unchangedSinceOurWrite) {
            writeFileDurable(path, JSON.stringify({ ops: priorOps }, null, 2));
          } else if (current.ops.some((c) => recordKey(c) === recordKey(op))) {
            // Another recorder changed the file, so rolling back would erase their
            // work. Ours is still in there, and that is a phantom.
            leftover =
              `another operation wrote to the pending-operation file meanwhile, so this ` +
              `call's record was left in place rather than erasing theirs`;
          }
        }
      } catch (rollbackErr) {
        // DO NOT WARN ON THE FAILURE ALONE (codex gate). `writeFileDurable`
        // renames before it fsyncs the directory, so a throw from that last step
        // means the rollback may ALREADY have restored the prior records. Warning
        // regardless produced a false alarm that told the user to delete a
        // "phantom" — which, with a real same-kind predecessor restored, would
        // have been someone's live record. Ask the disk what actually happened.
        let ourRecordStillThere: boolean | undefined;
        try {
          const after = readPanelPendingOpsFile();
          // No "impossible value" sentinel here: an op with no id cannot be
          // matched by id at all, so that is its own answer — undetermined.
          // Reaching for a placeholder is how a literal NUL got into this file
          // once already, which made the whole source read as git-binary.
          ourRecordStillThere = after.unreadable
            ? undefined
            : op.id === undefined
              ? undefined
              : after.ops.some((o) => o.id === op.id);
        } catch {
          ourRecordStillThere = undefined;
        }
        if (ourRecordStillThere === true) {
          leftover =
            `rolling it back ALSO failed (${
              rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
            })`;
        } else if (ourRecordStillThere === undefined) {
          leftover =
            `rolling it back also failed (${
              rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
            }) and the file could not be read back, so whether this call's record ` +
            `remains is UNKNOWN`;
        }
        // ourRecordStillThere === false: the rollback landed before the failure.
        // Nothing was left behind, so nothing to warn about.
      }
    }
    throw new Error(
      `Could not persist the pending ${kind} marker: ${
        err instanceof Error ? err.message : String(err)
      }. Refusing to start an operation that could move the panel after a later pin.` +
        (leftover
          ? ` NOTE: ${leftover}, so a pending-${kind} record may remain at ` +
            `${panelPendingOpsPath()} describing an operation that never started. Later ` +
            `panel operations will warn about it until it expires or is cleared; if that ` +
            `warning is wrong, delete that record.`
          : ""),
    );
  }
  return op;
}

/**
 * Remove a pending-op marker — ONLY the exact record handed in (matched by
 * kind + queuedAt), so a NEWER marker of the same kind recorded after it is
 * never silently dropped.
 *
 * Call this only for an op that was PROVABLY dealt with by the pin-write
 * cancellation path (#689): cancelled before it could run, or proven to be no
 * longer pending. Clearing anything else would let a later pin write report
 * clean protection while queued work is still out there.
 *
 * Read-back verified like recordPanelPendingOp. A WRITE failure does not
 * settle the answer by itself — writeFileDurable's atomic rename precedes the
 * directory sync, so a directory-sync failure can mean the clear DID land —
 * so the post-state is always READ BACK and the observed state reported
 * (codex gate): claiming "the marker remains" when it is gone would attach a
 * phantom warning to the pin result. Only a READ failure (or a marker still
 * present) returns false, leaving the warning in place. Returns true when the
 * exact record is gone afterwards — including when it was already absent
 * (that is the goal state, not a success claim about work this call did).
 */
export function clearPanelPendingOp(op: PanelPendingOp): boolean {
  // Identity by unique id when the record has one; only legacy records fall
  // back to kind+queuedAt (collision-prone in the same millisecond).
  const matches = (candidate: PanelPendingOp): boolean =>
    op.id !== undefined
      ? candidate.id === op.id
      : candidate.kind === op.kind && candidate.queuedAt === op.queuedAt;
  try {
    const path = panelPendingOpsPath();
    const prior = readPanelPendingOpsFile();
    if (prior.unreadable) return false;
    if (!prior.ops.some(matches)) return true; // already gone
    const kept = prior.ops.filter((candidate) => !matches(candidate));
    // Rebase resolution (#847 + #798). Both branches wanted a durable rewrite of
    // this crash-recovery record; they differed in how. `writePanelPendingOpsAtomic`
    // is the stronger of the two — temp file + fsync + rename, so a crash mid-write
    // cannot leave a truncated marker where `writeFileSync` would — and #798's
    // warn-and-verify is kept around it, because a write error here does not prove
    // the clear failed: the read-back below is what settles it.
    try {
      writePanelPendingOpsAtomic(path, JSON.stringify({ ops: kept }, null, 2));
    } catch (writeErr) {
      logger.warn(
        `[panel] the pending ${op.kind} marker clear hit a write error (${
          writeErr instanceof Error ? writeErr.message : String(writeErr)
        }) — verifying the on-disk state before reporting.`,
      );
    }
    const confirmed = readPanelPendingOpsFile();
    return !confirmed.unreadable && !confirmed.ops.some(matches);
  } catch (err) {
    logger.warn(
      `[panel] could not clear the pending ${op.kind} marker: ${
        err instanceof Error ? err.message : String(err)
      } — leaving it (and its warning) in place.`,
    );
    return false;
  }
}

/**
 * The pending panel-affecting operations whose warning window is still open.
 *
 * Reads fail CLOSED, mirroring the pin store: a present-but-unreadable marker
 * file means we cannot prove nothing is pending, so it yields a synthetic
 * indeterminate op and the pin write still warns. Entries with an unparseable
 * expiry are kept (indeterminate = still warn), never dropped.
 */
export function activePanelPendingOps(now: number = Date.now()): PanelPendingOp[] {
  const { ops, unreadable, state } = readPanelPendingOpsFile();
  if (unreadable) {
    // Both branches still WARN — for this question an empty file is genuinely
    // indeterminate, because an interrupted write cannot be told from a file that
    // never got content, and claiming nothing is pending would be the fabrication.
    // They differ only in what the user is told to do, which is the part that was
    // missing: the empty case clears itself, the other needs a decision (#847).
    return [
      {
        kind: "unknown",
        queuedAt: new Date(0).toISOString(),
        expiresAt: new Date(0).toISOString(),
        detail:
          state === "empty"
            ? `the pending panel-operation record at ${panelPendingOpsPath()} is EMPTY, so a queued ` +
              "update or deferred restore may still be outstanding and cannot be confirmed either way. " +
              "It records no operation, so the next panel operation replaces it and this clears on its own — " +
              "deleting the file also clears it immediately."
            : `the pending panel-operation record at ${panelPendingOpsPath()} could not be read, so a queued ` +
              "update or deferred restore may still be outstanding. Its content could not be decoded, so it " +
              "is NOT replaced automatically — inspect it, then delete it to clear this.",
      },
    ];
  }
  // Expiry is informational only. We have no completion signal for a Manager
  // worker/deferred restore, so auto-expiry would falsely green a later pin.
  void now;
  return ops;
}
