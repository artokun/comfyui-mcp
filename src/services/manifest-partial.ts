/**
 * #1699 — leftover custom_node entries apply_manifest never submitted.
 *
 * The ComfyUI-Manager queue only knows about tasks it was given. When
 * apply_manifest's time budget expires, later custom_nodes are reported
 * "pending" / "not started" and are NEVER enqueued; an accepted-but-ambiguous
 * operation can also remain unresolved. panel_node_queue_status then reports a
 * drained queue (total_count: 0, is_processing: false) which agents read as
 * "all installs finished". This module is the fast process-local record of
 * both unsubmitted and unresolved names. Panel-spawned children also publish
 * the same record through manifest-outcome-channel.ts so apply_manifest and
 * panel_node_queue_status share one source of truth across their process
 * boundary.
 */

import { publishManifestOutcome } from "./manifest-outcome-channel.js";

export interface ManifestPartialInstall {
  kind: "custom_nodes_not_started";
  /** Human label for THIS apply (pack name, path, or "this inline manifest"). */
  source: string;
  /** custom_node ids that were never submitted to ComfyUI-Manager. */
  not_started: string[];
  /** custom_node ids submitted but unresolved when the budget elapsed. */
  still_installing: string[];
  /**
   * A subset of still_installing whose install promise did not settle before
   * apply_manifest returned. No Manager or local-fallback outcome is known for
   * these entries, so neither queue state nor local cloning is authorized by
   * this result.
   */
  outcome_unknown?: string[];
  /** Entries whose local direct-install fallback was selected after a timeout. */
  local_fallback?: string[];
  /** Entries whose late local direct-install fallback finished unsuccessfully. */
  local_fallback_failed?: string[];
  message: string;
}

let leftover: ManifestPartialInstall | null = null;
let lastRecordTarget: string | undefined;

export function recordManifestPartial(
  partial: ManifestPartialInstall | null,
  options: { target?: string } = {},
): void {
  if (options.target !== undefined) lastRecordTarget = options.target;
  leftover =
    partial &&
    (partial.not_started.length > 0 ||
      partial.still_installing.length > 0 ||
      (partial.outcome_unknown?.length ?? 0) > 0 ||
      (partial.local_fallback?.length ?? 0) > 0 ||
      (partial.local_fallback_failed?.length ?? 0) > 0)
      ? {
          ...partial,
          not_started: [...partial.not_started],
          still_installing: [...partial.still_installing],
          ...(partial.outcome_unknown?.length
            ? { outcome_unknown: [...partial.outcome_unknown] }
            : {}),
          ...(partial.local_fallback?.length
            ? { local_fallback: [...partial.local_fallback] }
            : {}),
          ...(partial.local_fallback_failed?.length
            ? { local_fallback_failed: [...partial.local_fallback_failed] }
            : {}),
        }
      : null;
  if (leftover) {
    if (!leftover.outcome_unknown?.length) delete leftover.outcome_unknown;
    if (!leftover.local_fallback?.length) delete leftover.local_fallback;
    if (!leftover.local_fallback_failed?.length) delete leftover.local_fallback_failed;
  }
  publishManifestOutcome(leftover, { target: options.target ?? lastRecordTarget });
}

export function getManifestPartialLeftover(): ManifestPartialInstall | null {
  return leftover;
}

/** Test seam — production callers replace leftovers via recordManifestPartial. */
export function clearManifestPartialLeftover(): void {
  leftover = null;
  publishManifestOutcome(null, { target: lastRecordTarget });
}

/**
 * Reconcile a timed-out git install when its late fallback actually changes
 * phase. The callback can run after apply_manifest has returned, so updating
 * only the result object would leave queue status permanently stale.
 */
export function reconcileManifestPartialLocalFallback(
  id: string,
  state: "selected" | "applied" | "failed",
): void {
  if (!leftover) return;
  const has = (items: string[] | undefined): boolean => items?.includes(id) === true;
  if (
    state === "selected" &&
    !has(leftover.still_installing) &&
    !has(leftover.outcome_unknown)
  ) {
    return;
  }
  const remove = (items: string[] | undefined): string[] =>
    (items ?? []).filter((item) => item !== id);
  const add = (items: string[] | undefined): string[] =>
    has(items) ? [...(items ?? [])] : [...(items ?? []), id];

  if (state === "selected") {
    leftover = {
      ...leftover,
      outcome_unknown: remove(leftover.outcome_unknown),
      local_fallback: add(leftover.local_fallback),
      local_fallback_failed: remove(leftover.local_fallback_failed),
      message:
        `${leftover.message} Reconciliation: the earlier UNKNOWN outcome has now selected ` +
        `a local direct-install fallback for "${id}". It is in progress; do not ` +
        `use Manager queue status or re-issue the node while it runs.`,
    };
  } else if (state === "applied") {
    leftover = {
      ...leftover,
      still_installing: remove(leftover.still_installing),
      outcome_unknown: remove(leftover.outcome_unknown),
      local_fallback: remove(leftover.local_fallback),
      local_fallback_failed: remove(leftover.local_fallback_failed),
      message:
        `${leftover.message} Reconciliation: the local fallback for "${id}" completed; ` +
        `the entry is no longer unresolved.`,
    };
  } else {
    leftover = {
      ...leftover,
      still_installing: remove(leftover.still_installing),
      outcome_unknown: remove(leftover.outcome_unknown),
      local_fallback: remove(leftover.local_fallback),
      local_fallback_failed: add(leftover.local_fallback_failed),
      message:
        `${leftover.message} Reconciliation: the local direct-install fallback for "${id}" ` +
        `finished unsuccessfully. Inspect the filesystem/error before retrying.`,
    };
  }
  recordManifestPartial(leftover);
}

export function describeManifestSource(opts: {
  pack?: string;
  path?: string;
}): string {
  const pack = opts.pack?.trim();
  if (pack) return `pack "${pack}"`;
  const path = opts.path?.trim();
  if (path) return `path "${path}"`;
  return "this inline manifest";
}

export function formatNotStartedMessage(item: string): string {
  return (
    `PARTIAL INSTALL — "${item}" was NOT STARTED and was NEVER submitted to the ` +
    `ComfyUI-Manager queue. The apply_manifest time budget elapsed while earlier ` +
    `packs were still installing. A drained panel_node_queue_status is NOT ` +
    `completion of this entry (the queue cannot include work it was never given) ` +
    `and is NOT a reason to restart ComfyUI. Re-run apply_manifest with the same ` +
    `pack/path/manifest to submit the remaining unsubmitted custom_node entries.`
  );
}

export function formatStillInstallingMessage(
  opts: { outcomeUnknown?: boolean } = {},
): string {
  if (opts.outcomeUnknown) {
    return (
      "Install outcome is UNKNOWN because the apply_manifest time budget elapsed before " +
      "the Manager operation settled. It may still be running on the ComfyUI-Manager " +
      "queue, or it may later settle to a result that does not authorize cloning. No " +
      "local direct-install fallback is authorized from this unresolved result. This " +
      "is NOT a failure and must not be re-issued. Do not use Manager queue status alone " +
      "to decide completion; verify the custom_nodes directory after the operation " +
      "settles."
    );
  }
  return (
    "Still installing on the ComfyUI-Manager queue when the apply_manifest time " +
    "budget elapsed. This is NOT a failure — the install continues server-side. " +
    "Poll panel_node_queue_status for THIS entry only. Do not treat a drained " +
    "queue as proof that later unsubmitted entries installed, and do not re-issue " +
    "this node."
  );
}

export function formatLocalFallbackMessage(): string {
  return (
    "A local direct-install fallback is still in progress in this MCP process when the " +
    "apply_manifest time budget elapsed. This is NOT queued server-side work and is NOT " +
    "on the ComfyUI-Manager queue. Do not use Manager queue status to track this local " +
    "work or re-issue this node while the fallback is running; verify the custom_nodes " +
    "directory after it finishes."
  );
}

export function buildManifestPartial(opts: {
  source: string;
  notStarted: string[];
  stillInstalling: string[];
  outcomeUnknown?: string[];
}): ManifestPartialInstall | null {
  const outcomeUnknown = (opts.outcomeUnknown ?? []).filter((id) =>
    opts.stillInstalling.includes(id),
  );
  if (opts.notStarted.length === 0 && opts.stillInstalling.length === 0) return null;
  const names = opts.notStarted.join(", ");
  const still = opts.stillInstalling.length
    ? outcomeUnknown.length
      ? ` Still unresolved: ${opts.stillInstalling.join(", ")}. For ${outcomeUnknown.join(", ")}, ` +
        `the install outcome is UNKNOWN and no local direct-install fallback is ` +
        `authorized from this result; do not use queue status alone to decide completion.`
      : ` Still installing (ON the queue, pollable): ${opts.stillInstalling.join(", ")}.`
    : "";
  const n = opts.notStarted.length;
  const unsubmitted =
    n > 0
      ? `${n} custom_node ${n === 1 ? "entry was" : "entries were"} NEVER submitted to ` +
        `ComfyUI-Manager (${names}). panel_node_queue_status going idle does NOT ` +
        `mean they installed — they are not on that queue. Do not restart ComfyUI ` +
        `yet. Re-run apply_manifest with the same pack/path/manifest to submit the ` +
        `remaining entries.`
      : `No custom_node entries were left unsubmitted, but the submitted entries ` +
        `below remain unresolved; panel_node_queue_status going idle does NOT prove ` +
        `this apply_manifest completed.`;
  return {
    kind: "custom_nodes_not_started",
    source: opts.source,
    not_started: [...opts.notStarted],
    still_installing: [...opts.stillInstalling],
    ...(outcomeUnknown.length ? { outcome_unknown: [...outcomeUnknown] } : {}),
    message:
      `PARTIAL INSTALL of ${opts.source}: ${unsubmitted}` +
      still,
  };
}

export function formatQueueStatusPartialNote(partial: ManifestPartialInstall): string {
  const unsubmitted = partial.not_started.length
    ? `apply_manifest of ${partial.source} never submitted: ${partial.not_started.join(", ")}. ` +
      `Those entries are NOT on the ComfyUI-Manager queue, so this status cannot ` +
      `account for them. Re-run apply_manifest to submit the remaining custom_nodes.`
    : "No entries were left unsubmitted, but submitted entries remain unresolved.";
  const unresolved = partial.still_installing.length
    ? ` Unresolved submitted entries: ${partial.still_installing.join(", ")}.` +
      (partial.outcome_unknown?.length
        ? ` For ${partial.outcome_unknown.join(", ")}, the install outcome is UNKNOWN; ` +
          `no local direct-install fallback is authorized and queue idle is not proof ` +
          `of completion. Verify the custom_nodes directory before reissuing.`
        : " Do not treat queue idle as proof that this apply_manifest completed.")
      : "";
  const local = partial.local_fallback?.length
    ? ` Local direct-install fallback is in progress for ${partial.local_fallback.join(", ")}. ` +
      `This work is NOT on the Manager queue; wait for it to settle and do not re-issue it.`
    : "";
  const failed = partial.local_fallback_failed?.length
    ? ` Local direct-install fallback failed for ${partial.local_fallback_failed.join(", ")}. ` +
      `Queue status cannot determine that result; inspect the install error before retrying.`
    : "";
  return `WARNING — PARTIAL INSTALL, QUEUE DRAIN IS NOT COMPLETION. ${unsubmitted}${unresolved}${local}${failed}`;
}
