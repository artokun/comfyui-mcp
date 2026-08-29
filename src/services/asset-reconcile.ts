import { fetchImage, getHistory, type HistoryEntry } from "../comfyui/client.js";
import { buildCompletionNotification } from "./job-watcher.js";
import { extractWorkflowGraph } from "./history-select.js";
import { hasAffirmativeSuccessStatus, historyCompletionTimeMs } from "./job-history.js";
import { AssetRegistry } from "./asset-registry.js";
import { logger } from "../utils/logger.js";

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
 * Newly reconciled images are also required to be fetchable through ComfyUI's
 * `/view` before they enter the registry.
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
}

/** Only the newest N completed prompts are reconciled per call. */
const DEFAULT_MAX_PROMPTS = 25;

function queueNumberOf(entry: HistoryEntry): number {
  const p = entry?.prompt as unknown;
  return Array.isArray(p) ? Number(p[0]) || 0 : 0;
}

export async function reconcileAssetsFromHistory(opts: {
  maxPrompts?: number;
  now?: () => number;
} = {}): Promise<ReconcileResult> {
  const maxPrompts = opts.maxPrompts ?? DEFAULT_MAX_PROMPTS;
  const now = opts.now ?? Date.now;

  const history = await getHistory();
  const completed = Object.entries(history)
    .filter(([, entry]) => entry?.status?.completed === true)
    .sort((a, b) => queueNumberOf(b[1]) - queueNumberOf(a[1]))
    .slice(0, maxPrompts);

  let registered = 0;
  let skippedExisting = 0;
  let skippedUnavailable = 0;

  for (const [promptId, entry] of completed) {
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
    for (const output of notification.outputs) {
      const images = [];
      for (const img of output.images) {
        // Keep the original (watched or earlier-reconciled) record: its
        // createdAt and any already-handed-out asset_id stay stable.
        if (AssetRegistry.has(promptId, img)) {
          skippedExisting++;
          continue;
        }

        // History can outlive the file it describes (for example, if the
        // output was moved or cleaned up immediately after completion). The
        // registry is consumed by get_image (action:"view"), so only add a
        // newly reconciled image after the same /view fetch succeeds.
        try {
          const fetchType =
            img.type === "input" || img.type === "temp" || img.type === "output" ? img.type : "output";
          await fetchImage(img.filename, fetchType, img.subfolder);
        } catch (error) {
          skippedUnavailable++;
          logger.debug("Skipping history image that ComfyUI /view could not fetch", {
            prompt_id: promptId,
            filename: img.filename,
            subfolder: img.subfolder,
            type: img.type,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        images.push(img);
      }
      if (images.length > 0) fresh.push({ node_id: output.node_id, images });
    }
    if (fresh.length === 0) continue;

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

  const result = { scanned: completed.length, registered, skippedExisting, skippedUnavailable };
  if (result.registered > 0) {
    logger.info("Reconciled assets from ComfyUI history", result);
  }
  return result;
}
