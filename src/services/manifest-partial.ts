/**
 * #1699 — leftover custom_node entries apply_manifest never submitted.
 *
 * The ComfyUI-Manager queue only knows about tasks it was given. When
 * apply_manifest's time budget expires, later custom_nodes are reported
 * "pending" / "not started" and are NEVER enqueued. panel_node_queue_status
 * then reports a drained queue (total_count: 0, is_processing: false) which
 * agents read as "all installs finished". This module is the process-local
 * record of those unsubmitted names so apply_manifest (which names the
 * PARTIAL INSTALL) and panel_node_queue_status (which refuses to look
 * complete while they remain) share one source of truth.
 */

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
  message: string;
}

let leftover: ManifestPartialInstall | null = null;

export function recordManifestPartial(partial: ManifestPartialInstall | null): void {
  leftover =
    partial && partial.not_started.length > 0
      ? {
          ...partial,
          not_started: [...partial.not_started],
          still_installing: [...partial.still_installing],
          ...(partial.outcome_unknown
            ? { outcome_unknown: [...partial.outcome_unknown] }
            : {}),
        }
      : null;
}

export function getManifestPartialLeftover(): ManifestPartialInstall | null {
  return leftover;
}

/** Test seam — production callers replace leftovers via recordManifestPartial. */
export function clearManifestPartialLeftover(): void {
  leftover = null;
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
  if (opts.notStarted.length === 0) return null;
  const names = opts.notStarted.join(", ");
  const outcomeUnknown = (opts.outcomeUnknown ?? []).filter((id) =>
    opts.stillInstalling.includes(id),
  );
  const still = opts.stillInstalling.length
    ? outcomeUnknown.length
      ? ` Still unresolved: ${opts.stillInstalling.join(", ")}. For ${outcomeUnknown.join(", ")}, ` +
        `the install outcome is UNKNOWN and no local direct-install fallback is ` +
        `authorized from this result; do not use queue status alone to decide completion.`
      : ` Still installing (ON the queue, pollable): ${opts.stillInstalling.join(", ")}.`
    : "";
  const n = opts.notStarted.length;
  return {
    kind: "custom_nodes_not_started",
    source: opts.source,
    not_started: [...opts.notStarted],
    still_installing: [...opts.stillInstalling],
    ...(outcomeUnknown.length ? { outcome_unknown: [...outcomeUnknown] } : {}),
    message:
      `PARTIAL INSTALL of ${opts.source}: ${n} custom_node ` +
      `${n === 1 ? "entry was" : "entries were"} NEVER submitted to ` +
      `ComfyUI-Manager (${names}). panel_node_queue_status going idle does NOT ` +
      `mean they installed — they are not on that queue. Do not restart ComfyUI ` +
      `yet. Re-run apply_manifest with the same pack/path/manifest to submit the ` +
      `remaining entries.` +
      still,
  };
}

export function formatQueueStatusPartialNote(partial: ManifestPartialInstall): string {
  return (
    `WARNING — PARTIAL INSTALL, QUEUE DRAIN IS NOT COMPLETION. apply_manifest of ` +
    `${partial.source} never submitted: ${partial.not_started.join(", ")}. ` +
    `Those entries are NOT on the ComfyUI-Manager queue, so this status (even ` +
    `total_count: 0 / is_processing: false) cannot account for them. Re-run ` +
    `apply_manifest to submit the remaining custom_nodes. Do not restart ComfyUI ` +
    `until those entries report applied or skipped.`
  );
}
