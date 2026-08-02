// Pin-write handling of pending panel-affecting work (#689).
//
// update_all and deferred snapshot restores are handed to ComfyUI-Manager and
// applied out of band (see panel-pin-guard.ts). Before this fix, a pin written
// inside their window only WARNED that the queued work could still move the
// now-pinned panel — violating the owner's constraint "never auto-update over
// an explicit pin". This module is what the pin-write path calls, inside the
// pin's critical section, to actually CANCEL that work:
//
//   update-all       → POST <prefix>/manager/queue/reset on the server the op
//                      was queued on (the marker's recorded base), which drops
//                      every PENDING Manager task. A task the worker already
//                      dequeued keeps running and CANNOT be cancelled — both
//                      halves are reported, never just the convenient one.
//   snapshot-restore → delete <manager files>/startup-scripts/
//                      restore-snapshot.json before the next ComfyUI restart
//                      consumes it (local installs only).
//
// HONESTY RULES (the point of the exercise):
//   - SHARED queue counts never identify OUR update_all: unrelated pending
//     tasks look exactly like it. A cancel is only PROVEN on v4, where the
//     panel's per-pack task id (`${uiId}_${pack}`) can be checked against the
//     queue history and this orchestrator's tasks are countable via the
//     client_id filter. On 3.x / legacy-UI, or without a recorded ui_id, a
//     reset would be BLIND — it could wipe others' pending work while the
//     update_all runs on regardless — so none is sent (could-not-verify).
//   - Queue counts are read BEFORE and AFTER any reset; the report names the
//     pending-dropped numbers rather than claiming the panel was saved.
//   - The marker is cleared ONLY for what was provably cancelled or proven no
//     longer pending. Everything else — in-flight work, remote hosts, reset
//     failures, unreadable state — keeps the marker and its warning.
//   - A marker proves things ONLY about the server recorded in it. A marker
//     with no recorded base, or whose base is not the current target, must
//     NEVER be resolved on the current target's evidence: a queue reset or a
//     local file deletion there may hit the WRONG ComfyUI while the original
//     work still runs. Those paths act best-effort at most, report UNVERIFIED
//     / cannot-cancel, and keep the marker.
//   - A queue reset is BLUNT: it drops ALL pending Manager tasks, not just the
//     update_all. The report says so.

import { getComfyUIBaseUrl } from "../config.js";
import {
  detectManagerApi,
  fetchManagerClientQueueCounts,
  fetchManagerQueueCounts,
  fetchManagerTaskHistoryEntry,
  type ManagerApi,
  type ManagerTaskHistoryEntry,
} from "./node-management.js";
import {
  clearPanelPendingOp,
  PANEL_PACK_ALIASES,
  type PanelPendingOp,
} from "./panel-pin-guard.js";
import { logger } from "../utils/logger.js";

export type PanelPendingCancelOutcome =
  /** Provably cancelled before it could run; marker cleared. */
  | "cancelled"
  /** Provably nothing left to cancel (queue empty+idle / no restore file), so
   *  the window is closed — but the work may ALREADY have landed; marker
   *  cleared, and the report says the panel may already have moved. */
  | "already-drained"
  /** Pending work was dropped, but a task was already RUNNING and cannot be
   *  cancelled; marker KEPT, warning preserved. */
  | "partially-cancelled"
  /** Nothing pending; the task is in flight on the Manager worker and cannot
   *  be cancelled; marker KEPT, warning preserved. */
  | "already-running"
  /** The state could not be read, the reset/delete failed, or the marker
   *  itself could not be cleared — nothing is claimed; marker KEPT. */
  | "could-not-verify"
  /** The deferred restore file lives on a remote ComfyUI host; marker KEPT. */
  | "cannot-cancel-remote"
  /** A marker kind this build has no cancellation route for (e.g. the
   *  synthetic unreadable-record marker); marker KEPT. */
  | "cannot-cancel";

export interface PanelPendingCancelReport {
  op: PanelPendingOp;
  outcome: PanelPendingCancelOutcome;
  /** Whether the pending-op marker was removed (only ever true for
   *  "cancelled" / "already-drained"). */
  markerCleared: boolean;
  /** Human-facing explanation — appended to the pin result verbatim. */
  detail: string;
  /** update-all only: pending tasks read BEFORE the reset. */
  pendingBefore?: number;
  /** update-all only: pending tasks read AFTER the reset. */
  pendingAfter?: number;
  /** update-all only: tasks in flight after the reset (cannot be cancelled). */
  inProgress?: number;
}

/** Clear the marker and fold the outcome into the report when even THAT
 *  fails — a proven cancel with an unremovable marker must keep warning. */
function finalize(
  op: PanelPendingOp,
  report: Omit<PanelPendingCancelReport, "op" | "markerCleared">,
): PanelPendingCancelReport {
  const cleared = clearPanelPendingOp(op);
  return {
    ...report,
    op,
    markerCleared: cleared,
    outcome: cleared ? report.outcome : "could-not-verify",
    detail: cleared
      ? report.detail
      : `${report.detail} — HOWEVER the pending-op marker itself could not be ` +
        `cleared, so its warning remains.`,
  };
}

async function cancelUpdateAll(op: PanelPendingOp): Promise<PanelPendingCancelReport> {
  // A marker proves things only about the server RECORDED in it. Without a
  // base (markers written before the capture existed), the current target may
  // be a different ComfyUI entirely — its queue state says NOTHING about the
  // server the update_all was queued on. Never a proven cancel from that.
  if (!op.base) return cancelUpdateAllUnbased(op);
  const base = op.base;

  // A reset is only worth sending — and only REPORTABLE as a cancel — when
  // OUR update_all's state is provable. Shared queue counts can never provide
  // that (unrelated pending tasks look exactly like ours), so the dialect
  // decides what is provable at all.
  let api: ManagerApi;
  try {
    api = await detectManagerApi(base);
  } catch {
    return {
      op,
      outcome: "could-not-verify",
      markerCleared: false,
      detail:
        `could not reach the ComfyUI-Manager on ${base} — NOTHING was sent. ` +
        `The queued update_all may still be pending; the warning stands.`,
    };
  }

  if (api !== "v2") return cancelUpdateAllUnattributable(op, base, api);
  if (!op.uiId) return cancelUpdateAllNoUiId(op, base);
  return cancelUpdateAllProvable(op, base, op.uiId);
}

/**
 * 3.x and legacy-UI (v2-batch) Managers expose no task history and no client
 * filter, so OUR update_all can never be told apart from unrelated pending
 * work — and a queue reset there is always BLIND (it could wipe someone
 * else's queued tasks while ours runs on). Never send one (#689 round 3).
 */
async function cancelUpdateAllUnattributable(
  op: PanelPendingOp,
  base: string,
  api: ManagerApi,
): Promise<PanelPendingCancelReport> {
  const counts = await fetchManagerQueueCounts(base);
  const dialect = api === "legacy" ? "3.x" : "legacy-UI";
  if (!counts) {
    return {
      op,
      outcome: "could-not-verify",
      markerCleared: false,
      detail:
        `could not read the ComfyUI-Manager queue on ${base} — NOTHING was ` +
        `sent. The queued update_all may still be pending; the warning stands.`,
    };
  }
  if (counts.pending === 0 && counts.inProgress === 0 && !counts.processing) {
    return finalize(op, {
      outcome: "already-drained",
      detail:
        `the Manager queue on ${base} was already empty and idle, so there was ` +
        `NOTHING left to cancel — the update_all already drained (or never ` +
        `reached the queue). The panel may ALREADY have been moved — check ` +
        `install_panel(action='status').`,
      pendingBefore: 0,
      pendingAfter: 0,
      inProgress: 0,
    });
  }
  if (counts.pending === 0) {
    const busy =
      counts.inProgress > 0
        ? `${counts.inProgress} task(s) are RUNNING`
        : `the queue worker is busy`;
    return {
      op,
      outcome: "already-running",
      markerCleared: false,
      detail:
        `cannot cancel — the Manager queue on ${base} has nothing pending but ` +
        `${busy}, and in-flight work cannot be cancelled (a queue reset only ` +
        `drops PENDING work). The update_all may STILL move the panel after ` +
        `this pin — check install_panel(action='status') once it settles.`,
      pendingBefore: 0,
      pendingAfter: 0,
      inProgress: counts.inProgress,
    };
  }
  return {
    op,
    outcome: "could-not-verify",
    markerCleared: false,
    detail:
      `${counts.pending} task(s) are pending on this ${dialect} ComfyUI-Manager, ` +
      `which exposes no task history — the queued update_all cannot be told ` +
      `apart from UNRELATED pending work, and a queue reset would be blind: it ` +
      `could wipe someone else's queued tasks while the update_all runs on ` +
      `regardless. NO reset was sent; the warning stands.`,
    pendingBefore: counts.pending,
    inProgress: counts.inProgress,
  };
}

/**
 * v4 without a recorded ui_id: the update_all's tasks can be narrowed to this
 * orchestrator (client filter) but not identified individually, so a reset
 * still cannot be PROVEN to drop them — and it always drops unrelated work
 * too. Only queue states that need no reset are provable here (#689 round 3).
 */
async function cancelUpdateAllNoUiId(
  op: PanelPendingOp,
  base: string,
): Promise<PanelPendingCancelReport> {
  const mine = await fetchManagerClientQueueCounts(base);
  if (!mine) {
    return {
      op,
      outcome: "could-not-verify",
      markerCleared: false,
      detail:
        `could not read this orchestrator's queue state on ${base} — NOTHING ` +
        `was sent. The queued update_all may still be pending; the warning stands.`,
    };
  }
  if (mine.pending === 0 && mine.inProgress === 0 && !mine.processing) {
    return finalize(op, {
      outcome: "already-drained",
      detail:
        `nothing enqueued by this orchestrator is pending or running on ${base} ` +
        `— the update_all already drained (or never queued), so there was ` +
        `NOTHING left to cancel. The panel may ALREADY have been moved — check ` +
        `install_panel(action='status').`,
      pendingBefore: 0,
      pendingAfter: 0,
      inProgress: 0,
    });
  }
  // In-flight first, as in the ui_id path: running work cannot be cancelled
  // regardless of what else is pending, and no reset may be sent into it.
  if (mine.inProgress > 0 || mine.processing) {
    const busy =
      mine.inProgress > 0
        ? `${mine.inProgress} task(s) from this orchestrator are RUNNING`
        : `the queue worker is busy`;
    return {
      op,
      outcome: "already-running",
      markerCleared: false,
      detail:
        `cannot cancel — ${busy} on ${base} and the update_all's tasks may be ` +
        `among them; in-flight work cannot be cancelled (a queue reset only ` +
        `drops PENDING work). NO reset was sent. The update_all may STILL move ` +
        `the panel after this pin.`,
      pendingBefore: mine.pending,
      inProgress: mine.inProgress,
    };
  }
  return {
    op,
    outcome: "could-not-verify",
    markerCleared: false,
    detail:
      `the marker recorded no ui_id, so the update_all cannot be told apart ` +
      `from the ${mine.pending} task(s) this orchestrator has pending on ${base} ` +
      `(other installs/updates included) — a queue reset could wipe unrelated ` +
      `work and STILL not provably drop it. NO reset was sent; the warning stands.`,
    pendingBefore: mine.pending,
    inProgress: mine.inProgress,
  };
}

/**
 * The panel's per-pack update task in the v4 queue history: the entry when it
 * COMPLETED, null when it provably did not, undefined when history is
 * unreadable. update_all names each per-pack task `${uiId}_${packKey}`, and
 * the panel's pack key is one of its two aliases.
 */
async function panelTaskState(
  uiId: string,
  base: string,
): Promise<ManagerTaskHistoryEntry | null | undefined> {
  let unknown = false;
  for (const alias of PANEL_PACK_ALIASES) {
    const entry = await fetchManagerTaskHistoryEntry(`${uiId}_${alias}`, base);
    if (entry) return entry;
    if (entry === undefined) unknown = true;
  }
  return unknown ? undefined : null;
}

/**
 * v4 with a recorded ui_id — the only PROVABLE cancel on a shared queue
 * (#689 round 3). The panel's per-pack task id is checked against the queue
 * history (completed ⇒ already-drained), and this orchestrator's tasks are
 * counted via the client filter (none pending/running ⇒ already-drained;
 * running ⇒ already-running; provably pending ⇒ a reset that is then
 * RE-PROVEN to have removed the panel's task).
 */
async function cancelUpdateAllProvable(
  op: PanelPendingOp,
  base: string,
  uiId: string,
): Promise<PanelPendingCancelReport> {
  // 1. Did the panel's task already RUN? (Queue history = completed tasks.)
  const panelLookup = await panelTaskState(uiId, base);
  if (panelLookup === undefined) {
    return {
      op,
      outcome: "could-not-verify",
      markerCleared: false,
      detail:
        `the Manager's queue history on ${base} could not be read, so whether ` +
        `the panel's update task already ran is UNKNOWN — NOTHING was sent; ` +
        `the warning stands.`,
    };
  }
  if (panelLookup) {
    return finalize(op, {
      outcome: "already-drained",
      detail:
        `the panel's update task (${panelLookup.uiId}) is in the Manager's ` +
        `queue history on ${base} — it already RAN` +
        `${panelLookup.result ? ` (${panelLookup.result})` : ""}, so there was ` +
        `NOTHING left to cancel. The panel may ALREADY have been moved — check ` +
        `install_panel(action='status').`,
      pendingBefore: 0,
      pendingAfter: 0,
      inProgress: 0,
    });
  }

  // 2. Not completed. Is anything of OURS still pending or running?
  const mine = await fetchManagerClientQueueCounts(base);
  if (!mine) {
    return {
      op,
      outcome: "could-not-verify",
      markerCleared: false,
      detail:
        `this orchestrator's queue state on ${base} could not be read — ` +
        `NOTHING was sent; the warning stands.`,
    };
  }
  // In-flight FIRST: a running task of ours may be the panel's update, and
  // in-flight work cannot be cancelled — regardless of what else is pending.
  // Checking pending first would send a reset into a live update (#689 round 4).
  if (mine.inProgress > 0 || mine.processing) {
    const busy =
      mine.inProgress > 0
        ? `${mine.inProgress} task(s) from this orchestrator are RUNNING`
        : `the queue worker is busy`;
    return {
      op,
      outcome: "already-running",
      markerCleared: false,
      detail:
        `cannot cancel — ${busy} on ${base} and the panel's task may be among ` +
        `them; in-flight work cannot be cancelled (a queue reset only drops ` +
        `PENDING work, so it would only wipe unrelated queued tasks). NO reset ` +
        `was sent. The update_all may STILL move the panel after this pin.`,
      pendingBefore: mine.pending,
      inProgress: mine.inProgress,
    };
  }
  if (mine.pending === 0) {
    return finalize(op, {
      outcome: "already-drained",
      detail:
        `the panel's update task is not pending, not running, and not in the ` +
        `Manager's (bounded) queue history on ${base} — it never ran or already ` +
        `finished, so there was NOTHING left to cancel. The panel may ALREADY ` +
        `have been moved — check install_panel(action='status').`,
      pendingBefore: 0,
      pendingAfter: 0,
      inProgress: 0,
    });
  }

  // A v4 history entry proves only that the marked task has not completed; it
  // does not prove which pending queue entry belongs to this update_all. The
  // only available cancellation endpoint resets the ENTIRE shared queue, so
  // using it here can delete unrelated work. Keep the marker and warning until
  // Manager exposes an owned, atomic per-task cancellation API.
  return {
    op,
    outcome: "could-not-verify",
    markerCleared: false,
    detail:
      `the panel task has not reached the Manager history and ${mine.pending} ` +
      `task(s) from this orchestrator are pending on ${base}, but ComfyUI-Manager ` +
      `offers only a queue-wide reset. That reset could delete unrelated pending ` +
      `work and cannot prove it cancelled this update_all, so NOTHING was sent; ` +
      `the warning stands.`,
    pendingBefore: mine.pending,
    inProgress: mine.inProgress,
  };
}

/**
 * A base-less update-all marker (written before the base capture existed).
 * The current target may be a different ComfyUI entirely, so its queue state
 * proves NOTHING about the server the update_all was queued on — and a reset
 * there could wipe an innocent queue while the original update still runs.
 * NO reset is ever sent from here; every outcome is UNVERIFIED and keeps the
 * marker (#689 round 3 — round 2's best-effort reset retired for exactly the
 * blind-reset reason above).
 */
async function cancelUpdateAllUnbased(op: PanelPendingOp): Promise<PanelPendingCancelReport> {
  const base = getComfyUIBaseUrl();
  const counts = await fetchManagerQueueCounts(base);
  if (!counts) {
    return {
      op,
      outcome: "could-not-verify",
      markerCleared: false,
      detail:
        `the marker recorded NO server, and the queue on the current target ` +
        `${base} could not be read — the update_all may be queued on a ` +
        `DIFFERENT ComfyUI. NOTHING was sent; the warning stands.`,
    };
  }
  if (counts.pending === 0) {
    const state =
      counts.inProgress > 0 || counts.processing
        ? `has nothing pending but ${counts.inProgress} task(s) running`
        : `is empty and idle`;
    return {
      op,
      outcome: "could-not-verify",
      markerCleared: false,
      detail:
        `the marker recorded NO server. The current target ${base} ${state}, ` +
        `which proves NOTHING about the ComfyUI the update_all was actually ` +
        `queued on — no reset was sent. If ${base} is not that server, the ` +
        `update may still land after this pin; the warning stands.`,
      pendingBefore: 0,
      inProgress: counts.inProgress,
    };
  }
  return {
    op,
    outcome: "could-not-verify",
    markerCleared: false,
    detail:
      `the marker recorded NO server, and ${counts.pending} task(s) are ` +
      `pending on the current target ${base}. Resetting that queue could wipe ` +
      `an innocent server's work while the update_all runs on its real host — ` +
      `so NO reset was sent; the warning stands.`,
    pendingBefore: counts.pending,
    inProgress: counts.inProgress,
  };
}

function cancelSnapshotRestore(op: PanelPendingOp): PanelPendingCancelReport {
  // The deferred restore file lives on the host the restore was REQUESTED
  // against. Local filesystem state proves things only about the CURRENT
  // target: a marker recorded for a different server (e.g. before a
  // remote→local retarget) must NEVER be cleared on local evidence — the
  // remote restore is still scheduled whatever the local disk says.
  const currentBase = getComfyUIBaseUrl();
  if (op.base && op.base !== currentBase) {
    return {
      op,
      outcome: "cannot-cancel",
      markerCleared: false,
      detail:
        `cannot cancel from here — the deferred restore was scheduled on ` +
        `${op.base}, but this orchestrator now targets ${currentBase}. The ` +
        `restore file (<ComfyUI>/user/**/startup-scripts/restore-snapshot.json) ` +
        `lives on ${op.base} and must be deleted THERE before its next ComfyUI ` +
        `restart; the current target's local state says nothing about that ` +
        `host. The warning stands.`,
    };
  }

  // The deferred file has no operation identity: a stale marker for this base
  // is indistinguishable from a later restore requested by another operation.
  // Deleting it would therefore risk cancelling the wrong restore. Keep the
  // marker until Manager provides an owned restore identifier or cancellation
  // endpoint.
  return {
    op,
    outcome: "cannot-cancel",
    markerCleared: false,
    detail:
      `cannot safely cancel the deferred restore on ${currentBase}: Manager's ` +
      `restore-snapshot.json has no operation identity, so deleting it could ` +
      `remove a later unrelated restore. NOTHING was deleted; the warning stands.`,
  };
}

/** Attempt to cancel ONE pending panel-affecting op, honestly reported. */
export async function cancelPanelPendingOp(
  op: PanelPendingOp,
): Promise<PanelPendingCancelReport> {
  try {
    if (op.kind === "update-all") return await cancelUpdateAll(op);
    if (op.kind === "snapshot-restore") return cancelSnapshotRestore(op);
    return {
      op,
      outcome: "cannot-cancel",
      markerCleared: false,
      detail:
        `no cancellation route exists for "${op.kind}" pending ops — the ` +
        `warning stands.`,
    };
  } catch (err) {
    // A cancel must NEVER break the pin write itself: the pin governs every
    // future op either way, and the warning only fails closed.
    logger.warn("[panel] pending-op cancellation threw; keeping the marker", {
      kind: op.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      op,
      outcome: "could-not-verify",
      markerCleared: false,
      detail:
        `cancellation of the pending ${op.kind} failed unexpectedly (${
          err instanceof Error ? err.message : String(err)
        }) — the warning stands.`,
    };
  }
}

/**
 * Attempt to cancel every active pending op, sequentially (Manager state is
 * measured before/after each reset, so parallel attempts would make the
 * counts uninterpretable). One report per op, in the same order.
 */
export async function cancelPanelPendingOps(
  ops: PanelPendingOp[],
): Promise<PanelPendingCancelReport[]> {
  const reports: PanelPendingCancelReport[] = [];
  for (const op of ops) {
    reports.push(await cancelPanelPendingOp(op));
  }
  return reports;
}
