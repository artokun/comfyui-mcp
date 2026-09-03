import { getHistory, type HistoryEntry } from "../comfyui/client.js";
import { buildCompletionNotification } from "./job-watcher.js";
import { extractWorkflowGraph } from "./history-select.js";
import { hasAffirmativeSuccessStatus, historyCompletionTimeMs } from "./job-history.js";
import { AssetRegistry, normalizeAssetImage } from "./asset-registry.js";
import { getOutputImage } from "./image-management.js";
import { logger } from "../utils/logger.js";
import { raceAbort } from "../comfyui/fetch.js";

/**
 * Reconcile the in-memory AssetRegistry with ComfyUI's /history (#751).
 *
 * The registry is populated by JobWatcher, which only sees prompts THIS process
 * submitted via enqueueWorkflow. A render dispatched any other way — panel_run
 * (the panel queues via the browser's own app.queuePrompt), an earlier MCP
 * session, or anything before a server restart — completes without a watcher,
 * so its outputs never registered and get_image (action:"list_assets") read as empty even though
 * get_history showed them. Reconciling on demand closes that gap: outputs that
 * really exist in history are registered with source "history-reconcile",
 * with the prompt's recorded graph as the workflow snapshot (so
 * generate_image (action:"regenerate") /
 * get_image (action:"asset_metadata") keep working) and the run's real completion time as
 * createdAt (so ordering, `since` filters, and TTL expiry stay truthful).
 *
 * Nothing is fabricated: an entry registers only when its history status
 * affirmatively says success (hasAffirmativeSuccessStatus — the predicate
 * shared with the watched path: status_str === "success" AND no
 * error/interrupt message, with missing, unknown, or contradictory status
 * failing toward NOT registering), it carries a usable prompt graph, it lists
 * real image outputs, and it has a real execution_success timestamp for
 * createdAt (execution_start is not completion time, and "now" would silently
 * misorder — untimed entries are skipped, not guessed). Entries older than
 * the registry TTL register but read as expired immediately — the TTL stays
 * the single source of truth for record lifetime.
 * Newly reconciled images are also required to pass the same guarded `/view`
 * consumer used by get_image before they enter the registry.
 */

export interface ReconcileResult {
  /** Completed prompts inspected (after the recency cap). */
  scanned: number;
  /** Newly registered records. */
  registered: number;
  /** History outputs already present in the registry (left untouched). */
  skippedExisting: number;
  /** History image outputs that ComfyUI's /view could not fetch. */
  skippedUnavailable: number;
  /** Whether the bounded history/probe work budget stopped reconciliation early. */
  probeLimitReached: boolean;
}

/** Only the newest N completed prompts are reconciled per call. */
const DEFAULT_MAX_PROMPTS = 25;
/** Bound successfully validated history images even when one prompt is unbounded. */
const DEFAULT_MAX_IMAGE_PROBES = 16;
/** Keep failed availability probes bounded without consuming the success budget. */
const DEFAULT_MAX_FAILED_PROBES = 8;
/** Hard ceiling across both successful and failed availability probes. */
export const MAX_RECONCILIATION_PROBE_ATTEMPTS = 16;
/** A list operation must not wait on a wedged history image indefinitely. */
export const RECONCILIATION_DEADLINE_MS = 5_000;
/** A single unavailable ref must not block later useful refs for the full HTTP budget. */
export const RECONCILIATION_PROBE_TIMEOUT_MS = 1_000;

function boundedImageProbeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_IMAGE_PROBES;
  return Math.min(DEFAULT_MAX_IMAGE_PROBES, Math.max(0, Math.floor(value)));
}

function boundedFailedProbeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_FAILED_PROBES;
  return Math.min(DEFAULT_MAX_FAILED_PROBES, Math.max(0, Math.floor(value)));
}

function boundedProbeAttemptLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_RECONCILIATION_PROBE_ATTEMPTS;
  return Math.min(MAX_RECONCILIATION_PROBE_ATTEMPTS, Math.max(0, Math.floor(value)));
}

function boundedDuration(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(60_000, Math.max(1, Math.floor(value)));
}

function queueNumberOf(entry: HistoryEntry): number {
  const p = entry?.prompt as unknown;
  return Array.isArray(p) ? Number(p[0]) || 0 : 0;
}

export async function reconcileAssetsFromHistory(opts: {
  maxPrompts?: number;
  /** Maximum number of newly validated images to register. */
  maxImageProbes?: number;
  /** Maximum number of unavailable/malformed refs to probe before stopping. */
  maxFailedProbes?: number;
  /** Maximum total availability probes, regardless of success/failure. */
  maxProbeAttempts?: number;
  /** Whole reconciliation deadline, including the history response read. */
  deadlineMs?: number;
  /** Per-ref deadline, shorter than the normal /view HTTP budget by design. */
  probeTimeoutMs?: number;
  now?: () => number;
} = {}): Promise<ReconcileResult> {
  const maxPrompts = opts.maxPrompts ?? DEFAULT_MAX_PROMPTS;
  const maxImageProbes = boundedImageProbeLimit(opts.maxImageProbes);
  const maxFailedProbes = boundedFailedProbeLimit(opts.maxFailedProbes);
  const maxProbeAttempts = boundedProbeAttemptLimit(opts.maxProbeAttempts);
  const deadlineMs = boundedDuration(opts.deadlineMs, RECONCILIATION_DEADLINE_MS);
  const probeTimeoutMs = boundedDuration(opts.probeTimeoutMs, RECONCILIATION_PROBE_TIMEOUT_MS);
  const now = opts.now ?? Date.now;
  const reconciliationSignal = AbortSignal.timeout(deadlineMs);

  let history: Record<string, HistoryEntry>;
  try {
    history = await raceAbort(reconciliationSignal, () =>
      getHistory(undefined, { signal: reconciliationSignal }),
    );
  } catch (error) {
    if (!reconciliationSignal.aborted) throw error;
    logger.debug("History reconciliation deadline expired while reading /history");
    return {
      scanned: 0,
      registered: 0,
      skippedExisting: 0,
      skippedUnavailable: 0,
      probeLimitReached: true,
    };
  }
  const completed = Object.entries(history)
    .filter(([, entry]) => entry?.status?.completed === true)
    .sort((a, b) => queueNumberOf(b[1]) - queueNumberOf(a[1]))
    .slice(0, maxPrompts);

  let registered = 0;
  let skippedExisting = 0;
  let skippedUnavailable = 0;
  let validatedImages = 0;
  let failedProbes = 0;
  let probeAttempts = 0;
  let probeLimitReached = false;

  reconcilePrompts: for (const [promptId, entry] of completed) {
    // Eligibility keys on the HISTORY entry's own status via the shared
    // affirmative-success predicate (job-history) — the SAME gate the watched
    // path registers through, never the notification builder's default-success.
    if (!hasAffirmativeSuccessStatus(entry)) continue;

    // Parse outputs exactly like the watched path does — same extraction and
    // URL building.
    const notification = buildCompletionNotification(promptId, entry, now());
    if (notification.outputs.length === 0) continue;
    // The recorded graph is the provenance generate_image (action:"regenerate") /
    // get_image (action:"asset_metadata")
    // rely on; without it there is nothing truthful to register.
    const workflow = extractWorkflowGraph(entry);
    if (!workflow) continue;

    // createdAt must be the run's REAL completion time — an entry without a
    // trustworthy execution_success timestamp is skipped rather than guessed
    // (see historyCompletionTimeMs; the watched path can fall back to its own
    // observed finish time, but a reconciler running long after the fact has
    // no such observation).
    const createdAt = historyCompletionTimeMs(entry, now());
    if (createdAt === undefined) {
      logger.debug("Skipping history entry with no usable completion timestamp", {
        prompt_id: promptId,
      });
      continue;
    }

    const fresh = [];
    let stopAfterPrompt = false;
    for (const output of notification.outputs) {
      const images = [];
      for (const img of output.images) {
        const normalizedImg = normalizeAssetImage(img);

        // Keep the original (watched or earlier-reconciled) record: its
        // createdAt and any already-handed-out asset_id stay stable.
        if (AssetRegistry.has(promptId, normalizedImg)) {
          skippedExisting++;
          continue;
        }

        // History can outlive the file it describes (for example, if the
        // output was moved or cleaned up immediately after completion). The
        // registry is consumed by get_image (action:"view"), so only add a
        // newly reconciled image after the same guarded consumer succeeds.
        // Keep both sides of the work bounded even if one history entry contains
        // an attacker-controlled or unexpectedly large image list. Failed refs
        // have their own budget so they cannot consume the budget for later
        // valid records requested by the caller.
        if (
          validatedImages >= maxImageProbes ||
          failedProbes >= maxFailedProbes ||
          probeAttempts >= maxProbeAttempts ||
          reconciliationSignal.aborted
        ) {
          probeLimitReached = true;
          stopAfterPrompt = true;
          break;
        }

        probeAttempts++;
        const probeSignal = AbortSignal.any([
          reconciliationSignal,
          AbortSignal.timeout(Math.min(probeTimeoutMs, deadlineMs)),
        ]);
        try {
          // Race as well as signal: the production consumer observes the signal
          // and cancels its HTTP/body read, while a test double or an older
          // consumer that ignores it still cannot hold the list operation open.
          await raceAbort(probeSignal, () =>
            getOutputImage(
              normalizedImg.filename,
              normalizedImg.type,
              normalizedImg.subfolder,
              { requireImageContent: true, signal: probeSignal },
            ),
          );
        } catch (error) {
          failedProbes++;
          skippedUnavailable++;
          logger.debug("Skipping history image that ComfyUI /view could not fetch", {
            prompt_id: promptId,
            filename: normalizedImg.filename,
            subfolder: normalizedImg.subfolder,
            type: normalizedImg.type,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (reconciliationSignal.aborted) {
          probeLimitReached = true;
          stopAfterPrompt = true;
          break;
        }
        validatedImages++;
        images.push(normalizedImg);
      }
      if (images.length > 0) fresh.push({ node_id: output.node_id, images });
      if (stopAfterPrompt) break;
    }

    if (fresh.length > 0) {
      const records = AssetRegistry.register({
        promptId,
        workflow,
        outputs: fresh,
        source: "history-reconcile",
        createdAt,
        createdAtSource: "history",
      });
      registered += records.length;
    }

    if (probeLimitReached) break reconcilePrompts;
  }

  const result = {
    scanned: completed.length,
    registered,
    skippedExisting,
    skippedUnavailable,
    probeLimitReached,
  };
  if (result.registered > 0) {
    logger.info("Reconciled assets from ComfyUI history", result);
  }
  return result;
}
