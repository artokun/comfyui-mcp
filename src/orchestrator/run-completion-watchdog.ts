// #1789 — the completion `panel_run` PROMISED, delivered by the orchestrator's
// own eyes when the panel's never arrives.
//
// THE PROMISE AND WHO KEEPS IT. `panel_run` returns "[IMPORTANT] You will be
// notified automatically … Just end your turn now and wait." Exactly one
// mechanism can keep that: the panel observes ComfyUI's `execution_success`,
// composes an `executed` agent_event and sends it over the bridge. Everything
// downstream of that frame is already durable (run-completion-journal.ts) —
// correlated once, journaled, replayed until the turn that carried it ends.
//
// WHAT WAS UNGUARDED IS UPSTREAM OF IT. If the frame is never SENT, nothing in
// this process notices. `openRun` returning true — which is the entire test the
// rider's promise is gated on — proves only that a completion could be
// RECOGNISED, never that one will arrive. So an open ticket that will be
// answered and one that never will were the same observation, and the reported
// failure is the second one: the render finished in 28.77 s, ComfyUI logged it
// cleanly, `/history` had it, and the agent — having been told in so many words
// not to poll — sat idle until a human broke the silence.
//
// AND THE ORCHESTRATOR ALREADY SAW IT FINISH. QueueMonitor observes a finish on
// EITHER of two channels, both funnelling through its own recordCompletion: the
// broadcast WS `execution_success`/`execution_error`/`execution_interrupted`
// frames, and a 1 Hz `GET /history` tail diff that catches what modern ComfyUI
// scopes to the queuing client only, including runs shorter than a poll tick
// (#258/#259) and runs queued from the browser. Which channel saw it is not
// knowable downstream, so nothing here names one. Those observations went to ONE
// consumer, the `queue_status` UI broadcast, and were dropped on the floor. The
// completion this session was
// promised was in the orchestrator's hands and thrown away.
//
// This module is the join, and only the join:
//   observe()  — a QueueMonitor completion whose prompt id has an UNANSWERED
//                panel_run ticket is armed with the time we saw it.
//   tick()     — once the grace has elapsed, ask AGAIN. Still unanswered ⇒ the
//                panel is never going to report it: synthesise the completion
//                from what ComfyUI told us and hand it to the same journal the
//                real frame would have used.
//
// WHY A GRACE RATHER THAN IMMEDIATELY. The panel's frame is the better one — it
// carries the output images, the duration and the metadata. Ours used to carry
// only a terminal status and a pointer (#1789); #1853 fills the images from
// the same completed /history record JobWatcher already parses, so a dropped
// panel frame still yields the output filenames. Never fabricated: no history
// entry, no usable media refs, or a fetch failure ⇒ images stay []. The normal
// path lands within a second or two, and the panel's OWN recovery sweep
// re-reconciles every 20 s, so a grace comfortably past both lets the real
// frame win every time it is coming. Past the grace there are exactly two
// shapes, and NEITHER loses anything — stated precisely, because the coalescing
// one is the narrower case, not the general one (gate finding):
//   • nothing took the synthesised entry (no live agent at that instant), so it
//     is still `pending` — the journal COALESCES the real payload onto it
//     (record()), and the agent sees ONE turn, with the images. This is the only
//     path on which the extra turn disappears.
//   • an agent DID take it, so the entry is `handed_off` or acked — the real
//     frame then arrives on its own, still correlated `matched`, flagged a
//     possible repeat, and NEVER discarded. Cost: one extra turn. That is the
//     standing trade this journal is built on (a duplicate beats a loss), and it
//     is the price of the grace being finite rather than a downgrade.
//
// WHAT IT DELIBERATELY IS NOT. It is not a poller for runs nobody queued, not a
// second delivery channel, and not a claim that ComfyUI is reachable: when the
// monitor is pointed elsewhere or cannot poll, it observes nothing and this does
// nothing — the same silence as before, which is why the rider also stopped
// promising more than this can keep.

import { getHistory, type HistoryEntry } from "../comfyui/client.js";
import { buildCompletionNotification } from "../services/job-watcher.js";
import { logger } from "../utils/logger.js";
import type { CompletionStatus } from "../services/queue-monitor.js";
import type { CompletionPayload, RunTicket } from "./run-completion-journal.js";

type CompletionImage = NonNullable<CompletionPayload["images"]>[number];

/** One completion QueueMonitor observed, held until its grace expires. */
interface ArmedCompletion {
  promptId: string;
  status: CompletionStatus;
  /** Monotonic-ish ms (the injected clock) when WE observed the finish. */
  observedAt: number;
}

export interface RunCompletionWatchdogDeps {
  /** The still-unanswered ticket for this run, or undefined. Asked TWICE — once
   *  to arm, once at expiry — because the whole point is the state changing in
   *  between (the panel's real frame landing). */
  awaiting: (promptId: string) => RunTicket | undefined;
  /** Journal + flush a synthesised completion for `ticket`. */
  deliver: (payload: CompletionPayload, ticket: RunTicket) => void;
  /**
   * Resolve output refs from the completed prompt's ComfyUI history. Wired to
   * `resolveHistoryCompletionImages` in production. Missing / throwing / empty
   * is the #1789 status-only notice, never a fabricated image.
   */
  resolveOutputs?: (promptId: string) => Promise<CompletionPayload["images"]>;
  /** How long to let the panel's own frame (and its 20 s reconcile sweep) win
   *  before filling in. */
  graceMs?: number;
  now?: () => number;
}

/**
 * Longer than the panel's own run-reconcile sweep period (20 s) plus a full
 * reconcile round trip, so the panel's recovery — which delivers the IMAGES —
 * is given every chance before we fill in with a pointer.
 */
export const DEFAULT_SYNTHESIS_GRACE_MS = 45_000;

/** Cap on armed observations. A run's arm is dropped the moment it expires, so
 *  this only ever bounds a burst of self-queued renders finishing at once. */
const MAX_ARMED = 256;

export interface RunCompletionWatchdog {
  /** Feed QueueMonitor's drained completions in. Never throws. */
  observe(events: ReadonlyArray<{ promptId: string; status: CompletionStatus }>): void;
  /** Expire armed observations; synthesise for the ones still unanswered. */
  tick(): Promise<void>;
  /** Diagnostics/tests: how many completions are currently armed. */
  armedCount(): number;
}

function usableHistoryImages(images: CompletionPayload["images"]): CompletionImage[] {
  if (!Array.isArray(images)) return [];
  const out: CompletionImage[] = [];
  const seen = new Set<string>();
  for (const img of images) {
    const filename = typeof img?.filename === "string" ? img.filename.trim() : "";
    if (!filename) continue;
    const subfolder = typeof img.subfolder === "string" ? img.subfolder : "";
    const type = typeof img.type === "string" && img.type ? img.type : "output";
    const key = `${subfolder}\0${type}\0${filename}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      filename,
      ...(subfolder ? { subfolder } : {}),
      type,
    });
  }
  return out;
}

/**
 * Flatten a history entry's media into the completion-payload `images` shape.
 * Extraction is `buildCompletionNotification` — the same parse JobWatcher and
 * asset reconcile already ship — so a SaveVideo `videos` ref and a SaveImage
 * `images` ref take the same path a watched completion would.
 */
export function historyOutputRefsFromEntry(
  promptId: string,
  entry: HistoryEntry,
): CompletionImage[] {
  const notification = buildCompletionNotification(promptId, entry, 0);
  const refs: CompletionImage[] = [];
  for (const node of notification.outputs) {
    for (const img of node.images) {
      refs.push({ filename: img.filename, subfolder: img.subfolder, type: img.type });
    }
  }
  for (const node of notification.video_outputs) {
    for (const vid of node.videos) {
      refs.push({ filename: vid.filename, subfolder: vid.subfolder, type: vid.type });
    }
  }
  return usableHistoryImages(refs);
}

/**
 * Fetch `/history/<promptId>` and return the real output refs, or [] when the
 * record is missing, unreadable, or lists no usable media. Never fabricates.
 */
export async function resolveHistoryCompletionImages(
  promptId: string,
  fetchHistory: (id: string) => Promise<Record<string, HistoryEntry>> = getHistory,
): Promise<CompletionImage[]> {
  const id = typeof promptId === "string" ? promptId.trim() : "";
  if (!id) return [];
  try {
    const history = await fetchHistory(id);
    const entry = history?.[id];
    if (!entry) return [];
    return historyOutputRefsFromEntry(id, entry);
  } catch (err) {
    logger.debug(
      `[run-completion-watchdog] history fetch for ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Compose the synthesised completion payload.
 *
 * Every claim in it is one the orchestrator actually observed. Output refs are
 * only those resolved from the completed prompt's /history record (#1853);
 * without them the notice stays status-only (#1789) and points at get_image /
 * get_history. It does not name WHICH channel saw the finish, because
 * recordCompletion is fed by both the WS execution events and the /history
 * diff and does not record which one won. It does not say the panel is broken,
 * only that its completion never arrived here. Naming the delay is what lets
 * the agent tell this apart from a fresh render finishing now.
 *
 * A FAILED run is reported through this same non-urgent `executed` shape rather
 * than `run_error`: run_error INTERRUPTS the live turn and front-queues "your
 * run just ERRORED, diagnose it", which is the right blast radius for a live
 * failure the panel reported and the wrong one for a status this watchdog read
 * out of a terminal record possibly a minute later. The note states the failure
 * plainly and names the tool that reads the detail.
 */
export function synthesizeCompletionPayload(
  armed: ArmedCompletion,
  opts: { deliveredAt: number; images?: CompletionPayload["images"] },
): CompletionPayload {
  const waitedS = Math.max(0, Math.round((opts.deliveredAt - armed.observedAt) / 1000));
  const images = usableHistoryImages(opts.images);
  const outcome =
    armed.status === "success"
      ? "finished SUCCESSFULLY"
      : armed.status === "interrupted"
        ? "was INTERRUPTED (cancelled before it finished)"
        : "FAILED";
  const names = images
    .map((img) => (img.subfolder ? `${img.subfolder}/${img.filename}` : img.filename))
    .join(", ");
  const next =
    armed.status === "success"
      ? images.length > 0
        ? `The output file(s) from ComfyUI history are attached: ${names}.`
        : `The output file(s) are NOT attached to this notice — the orchestrator read the run's terminal ` +
          `status, not its images. Fetch them with get_image (action:"list_outputs") ` +
          `or get_history for this prompt id before describing or using the result.`
      : armed.status === "interrupted"
        ? `Nothing crashed; it did not run to completion. Re-queue it if the cancellation was unintended.`
        : `Read the failure with panel_get_errors, or get_history for this prompt id. Do NOT report the ` +
          `run as successful.`;
  return {
    kind: "executed",
    prompt_id: armed.promptId,
    images,
    // Machine-readable provenance: this completion was NOT reported by the panel.
    completion_source: "orchestrator-history-watchdog",
    run_status: armed.status,
    note:
      `The render you queued (prompt ${armed.promptId}) ${outcome}, but the panel never delivered its ` +
      `completion event, so this notice was synthesised by the orchestrator from ComfyUI itself — its ` +
      `execution event or its history record — about ${waitedS}s after the run finished. ${next}`,
  };
}

export function createRunCompletionWatchdog({
  awaiting,
  deliver,
  resolveOutputs,
  graceMs = DEFAULT_SYNTHESIS_GRACE_MS,
  now = () => Date.now(),
}: RunCompletionWatchdogDeps): RunCompletionWatchdog {
  /** promptId → the observation we are holding. FIRST observation wins: a
   *  re-observation must not push the deadline out (that is how a repeatedly
   *  re-reported completion would never expire and the agent would wait
   *  forever — the exact failure being fixed). */
  const armed = new Map<string, ArmedCompletion>();

  return {
    observe(events) {
      for (const ev of events ?? []) {
        try {
          const promptId = typeof ev?.promptId === "string" ? ev.promptId.trim() : "";
          if (!promptId || armed.has(promptId)) continue;
          // Only runs THIS session queued and is still owed a completion for.
          // A foreign render (the user pressed Queue Prompt) has no ticket and
          // was never promised anything, so it must never wake the agent.
          if (!awaiting(promptId)) continue;
          armed.set(promptId, { promptId, status: ev.status, observedAt: now() });
          while (armed.size > MAX_ARMED) {
            const oldest = armed.keys().next().value;
            if (oldest === undefined) break;
            armed.delete(oldest);
          }
        } catch (err) {
          logger.debug(
            `[run-completion-watchdog] observe skipped an event: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },

    async tick() {
      if (armed.size === 0) return;
      const at = now();
      for (const entry of [...armed.values()]) {
        if (at - entry.observedAt < graceMs) continue;
        // Disarm FIRST and unconditionally: whatever happens below, this
        // observation is spent. Leaving it armed on a throwing deliver() would
        // re-fire it on every later tick.
        armed.delete(entry.promptId);
        let ticket: RunTicket | undefined;
        try {
          ticket = awaiting(entry.promptId);
        } catch (err) {
          logger.debug(
            `[run-completion-watchdog] could not re-check prompt ${entry.promptId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        // The panel's own frame landed inside the grace — the normal case, and
        // the one this must stay quiet for.
        if (!ticket) continue;
        try {
          let images: CompletionImage[] = [];
          if (resolveOutputs) {
            try {
              images = usableHistoryImages(await resolveOutputs(entry.promptId));
            } catch (err) {
              logger.debug(
                `[run-completion-watchdog] history outputs for ${entry.promptId} unavailable: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            // A panel frame that landed DURING the fetch still wins.
            try {
              ticket = awaiting(entry.promptId);
            } catch (err) {
              logger.debug(
                `[run-completion-watchdog] could not re-check prompt ${entry.promptId} after history fetch: ${err instanceof Error ? err.message : String(err)}`,
              );
              continue;
            }
            if (!ticket) continue;
          }
          // #1789 item 3 — the failure is OBSERVABLE from here on. Until now the
          // only detector of a lost completion was a human noticing the agent had
          // gone quiet.
          logger.warn(
            `[run-completion-watchdog] prompt ${entry.promptId} finished (${entry.status}) ${Math.round(
              (at - entry.observedAt) / 1000,
            )}s ago and the panel NEVER reported its completion — synthesising one from the orchestrator's own ComfyUI observation so the agent that was told to end its turn and wait is not left idle (#1789)`,
          );
          deliver(synthesizeCompletionPayload(entry, { deliveredAt: at, images }), ticket);
        } catch (err) {
          logger.warn(
            `[run-completion-watchdog] could not deliver the synthesised completion for prompt ${entry.promptId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },

    armedCount() {
      return armed.size;
    },
  };
}
