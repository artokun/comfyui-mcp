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
//   observe()  — a QueueMonitor completion is held with the time we saw it. An
//                already-open panel_run ticket is the normal case, but a fast
//                render may arrive before panel_run can open its ticket, so the
//                expiry check below re-asks whether the run became ours.
//   tick()     — once the grace has elapsed, ask AGAIN. Still unanswered ⇒ the
//                panel is never going to report it: synthesise the completion
//                from what ComfyUI told us and hand it to the same journal the
//                real frame would have used.
//
// WHY A GRACE RATHER THAN IMMEDIATELY. The panel's frame is the better one — it
// carries duration and metadata the history record does not. #1853 already
// fills images from that record, so a dropped panel frame is not a missing
// output. Waiting past the panel's own 20 s recovery sweep (#1789) left a
// successful run silent for 45 s when that sweep also missed (#1556). A
// reconnect / missed-WS recovery does not wait at all: reconcile() looks the
// still-owed prompt ids up in /history and synthesises immediately.
//
// HOW LONG, AND WHY IT IS NOT A GUESS (#2001). #1556 replaced 45 s with 5 s on
// the premise that the panel's frame "lands within a second or two; that is the
// only race the grace has to win". It is not. The panel composes ONE
// consolidated frame and does not send until every part of it resolves, and the
// panel's OWN code bounds that work well past 5 s:
//   • stills — per output it HEADs /view for Content-Length and loads the image
//     to read its natural size, each bounded by an 8 s timeout
//     (`fetchImageBytes` / `fetchImageDimensions` in comfyui-mcp-panel);
//   • video — a storyboard contact sheet per segment, bounded at 25 s
//     (`videoStoryboardTimeoutMs`).
// So a 5 s grace pre-empts a panel that is merely still working, and the notice
// it then writes says in so many words that the panel "never delivered its
// completion event" — which #2001 reported as a panel bug, twice, five seconds
// after two clean SaveImage renders. Back-to-back renders are exactly the shape
// that stalls those probes: ComfyUI serves /view from the same process that is
// already sampling the next job.
//
// The two defaults below are therefore READ OFF the panel's own bounds instead
// of estimated, and the longer one is spent only on a run whose /history record
// shows media the panel has to build a storyboard for. A stills run — #1556's
// case and #2001's — is still answered in 10 s, not 45.
// Past the grace there are exactly two shapes, and NEITHER loses anything —
// stated precisely, because the coalescing one is the narrower case, not the
// general one (gate finding):
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
import { buildCompletionNotification, type CompletionNotification } from "../services/job-watcher.js";
import { logger } from "../utils/logger.js";
import type { CompletionStatus } from "../services/queue-monitor.js";
import type { CompletionPayload, RunTicket } from "./run-completion-journal.js";

type CompletionImage = NonNullable<CompletionPayload["images"]>[number];

/** History parse used by the watchdog: images plus ComfyUI's own duration. */
export interface ResolvedHistoryCompletion {
  images: CompletionImage[];
  duration_ms: number;
  timestamp: string;
  status: CompletionNotification["status"];
}

/** One completion QueueMonitor observed, held until its grace expires. */
interface ArmedCompletion {
  promptId: string;
  status: CompletionStatus;
  /** Monotonic-ish ms (the injected clock) when WE observed the finish. */
  observedAt: number;
  /**
   * Whether a live ticket existed when this observation arrived. Unticketed
   * observations are retained for the dispatch/reply race (#2021), but are
   * preferred for eviction when the bounded arm set is full. A later
   * `awaiting()` check at expiry is authoritative.
   */
  ticketedAtObservation?: true;
  /**
   * This arm reached the stills grace and /history showed media the panel has
   * to build a storyboard for, so it was re-armed ONCE against the longer
   * bound. Set on the re-arm and never cleared: the extension is granted at
   * most once per run, so a panel frame that is never coming still lands at
   * `storyboardGraceMs` rather than being deferred again and again (#2001).
   */
  extended?: true;
}

export interface RunCompletionWatchdogDeps {
  /** The still-unanswered ticket for this run, or undefined. Asked TWICE — once
   *  to arm, once at expiry — because the whole point is the state changing in
   *  between (the panel's real frame landing). */
  awaiting: (promptId: string) => RunTicket | undefined;
  /**
   * Distinguishes an already-known but no-longer-owed ticket from a prompt id
   * that has never been ticketed. The latter can be the #2021 dispatch/reply
   * race; the former is a duplicate observation the journal already owns.
   */
  knownTicket?: (promptId: string) => RunTicket | undefined;
  /** Journal + flush a synthesised completion for `ticket`. */
  deliver: (payload: CompletionPayload, ticket: RunTicket) => void;
  /**
   * Resolve output refs (and, when available, history timing) from the
   * completed prompt's ComfyUI history. Wired to `resolveHistoryCompletion` in
   * production. Missing / throwing / empty is the #1789 status-only notice,
   * never a fabricated image.
   */
  resolveOutputs?: (
    promptId: string,
  ) => Promise<CompletionPayload["images"] | ResolvedHistoryCompletion | undefined>;
  /**
   * Terminal status of a prompt in ComfyUI history, or null if it is missing /
   * still running / unreadable. Wired to `resolveHistoryCompletionStatus` in
   * production. Used by reconcile() so a reconnect does not have to wait for
   * QueueMonitor to observe the same finish again.
   */
  lookupStatus?: (promptId: string) => Promise<CompletionStatus | null>;
  /** How long to let the panel's own in-flight frame win before filling in. */
  graceMs?: number;
  /** The extended bound for a run whose outputs the panel has to storyboard
   *  before it can send (#2001). Never applies to reconcile(), which is a
   *  missed-WS recovery and does not wait at all. */
  storyboardGraceMs?: number;
  now?: () => number;
}

/**
 * Past the panel's own bounded STILLS compose — two 8 s probes per output, run
 * in parallel (`fetchImageBytes` / `fetchImageDimensions`) — and not past its
 * 20 s recovery sweep. #1853 already attaches history outputs, so waiting for
 * that sweep only prolonged the silence when the sweep itself was the thing
 * that missed (#1556). Reconnect skips this entirely (see reconcile()).
 *
 * #2001 — this was 5 s, which is SHORTER than the panel's own bound, so one
 * stalled HEAD against a ComfyUI busy with the next render was enough for the
 * orchestrator to declare the panel silent while it was still composing.
 */
export const DEFAULT_SYNTHESIS_GRACE_MS = 10_000;

/**
 * The longer bound, spent ONLY on a run whose /history record carries media
 * that cannot be attached inline — i.e. exactly the runs for which the panel is
 * building a video storyboard before it sends. Read off the panel's own
 * `videoStoryboardTimeoutMs` (25 s), past which the panel abandons the
 * storyboard and sends its note-only fallback, so beyond this "still composing"
 * has stopped being a possible explanation for the silence (#2001).
 */
export const DEFAULT_STORYBOARD_GRACE_MS = 30_000;

/** Cap on armed observations. A run's arm is dropped the moment it expires, so
 *  this only ever bounds a burst of self-queued renders finishing at once. */
const MAX_ARMED = 256;

export interface RunCompletionWatchdog {
  /** Feed QueueMonitor's drained completions in. Never throws. */
  observe(events: ReadonlyArray<{ promptId: string; status: CompletionStatus }>): void;
  /** Mark a just-opened panel_run ticket so a fast completion arm cannot be
   * evicted as an unknown observation during a completion burst. */
  markTicketed(promptIds: readonly string[]): void;
  /** Expire armed observations; synthesise for the ones still unanswered. */
  tick(): Promise<void>;
  /**
   * #1556 — deliver NOW for still-owed runs that ComfyUI history already
   * shows finished. Used on panel hello/reconnect (and any other missed-WS
   * recovery) so the agent is not left idle for the grace. Already-armed
   * observations are flushed immediately even without a history lookup.
   * Never throws. Exactly-once: a run the journal already holds is skipped.
   */
  reconcile(promptIds: readonly string[]): Promise<void>;
  /** Diagnostics/tests: how many completions are currently armed. */
  armedCount(): number;
}

/**
 * Extensions the completion `images` array may carry.
 *
 * #1861 — an ALLOWLIST, not a video denylist. The only consumer of `images` attaches
 * them inline with the media type forced to `image/png` ("ComfyUI outputs are PNG by
 * default"), so anything that is not actually an image is sent to the model as PNG bytes
 * that are not PNG. A SaveVideo `.mp4` from /history took that path: the panel never
 * produced this shape — its video ref is an uploaded `storyboard_<base>.png` or
 * note-only — which is why the coercion was safe until the watchdog began reading
 * /history directly. An unknown extension therefore fails CLOSED: named in the note,
 * never attached.
 *
 * The question this asks is NOT "is it an image" — it is "can the attach path label
 * these bytes honestly?" `claude-backend.ts:390` keeps only `image/{png,jpeg,gif,webp}`
 * and rewrites everything else to `image/png`. So `.bmp` is excluded even though it IS
 * an image: ComfyUI serves it `image/bmp` (WAS-Suite `Image Save` writes them), and it
 * would ship as PNG-declared BMP — a smaller lie than an .mp4, but the same one.
 * Widening this set is only safe alongside the backend's.
 */
const ATTACHABLE_IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif)$/i;

/** Split media refs into what may be attached inline and what may only be named. */
export function partitionAttachableMedia(refs: CompletionImage[]): {
  images: CompletionImage[];
  other: CompletionImage[];
} {
  const images: CompletionImage[] = [];
  const other: CompletionImage[] = [];
  for (const ref of refs) {
    (ATTACHABLE_IMAGE_EXT_RE.test(ref.filename) ? images : other).push(ref);
  }
  return { images, other };
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
 * Flatten a history entry through `buildCompletionNotification` — the same
 * parse JobWatcher and asset reconcile already ship — so duration, finished-at,
 * status, and media refs are one observation (#2512).
 */
export function parseHistoryCompletion(
  promptId: string,
  entry: HistoryEntry,
): ResolvedHistoryCompletion {
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
  return {
    images: usableHistoryImages(refs),
    duration_ms: notification.duration_ms,
    timestamp: notification.timestamp,
    status: notification.status,
  };
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
  return parseHistoryCompletion(promptId, entry).images;
}

/**
 * Fetch `/history/<promptId>` and return the real output refs, or [] when the
 * record is missing, unreadable, or lists no usable media. Never fabricates.
 */
export async function resolveHistoryCompletion(
  promptId: string,
  fetchHistory: (id: string) => Promise<Record<string, HistoryEntry>> = getHistory,
): Promise<ResolvedHistoryCompletion | undefined> {
  const id = typeof promptId === "string" ? promptId.trim() : "";
  if (!id) return undefined;
  try {
    const history = await fetchHistory(id);
    const entry = history?.[id];
    if (!entry) return undefined;
    return parseHistoryCompletion(id, entry);
  } catch (err) {
    logger.debug(
      `[run-completion-watchdog] history fetch for ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

export async function resolveHistoryCompletionImages(
  promptId: string,
  fetchHistory: (id: string) => Promise<Record<string, HistoryEntry>> = getHistory,
): Promise<CompletionImage[]> {
  const parsed = await resolveHistoryCompletion(promptId, fetchHistory);
  return parsed?.images ?? [];
}

/**
 * Terminal status of a /history record, or null when the run is not proven
 * finished. Fail-closed: a missing entry, a missing status, or a still-running
 * record must not synthesise a completion. Interrupted is recognised from the
 * execution_interrupted message even when status_str is not "interrupted".
 */
export function completionStatusFromHistoryEntry(entry: unknown): CompletionStatus | null {
  if (!entry || typeof entry !== "object") return null;
  const st = (entry as { status?: unknown }).status;
  if (!st || typeof st !== "object") return null;
  const status = st as { status_str?: unknown; completed?: unknown; messages?: unknown };
  const messages = Array.isArray(status.messages) ? status.messages : [];
  const has = (type: string) => messages.some((m) => Array.isArray(m) && m[0] === type);
  if (has("execution_interrupted")) return "interrupted";
  if (has("execution_error") || status.status_str === "error") return "error";
  if (status.completed === true || status.status_str === "success") return "success";
  return null;
}

/**
 * Fetch `/history/<promptId>` and return its terminal status, or null when the
 * record is missing, unreadable, or not yet complete. Never invents a finish.
 */
export async function resolveHistoryCompletionStatus(
  promptId: string,
  fetchHistory: (id: string) => Promise<Record<string, HistoryEntry>> = getHistory,
): Promise<CompletionStatus | null> {
  const id = typeof promptId === "string" ? promptId.trim() : "";
  if (!id) return null;
  try {
    const history = await fetchHistory(id);
    return completionStatusFromHistoryEntry(history?.[id]);
  } catch (err) {
    logger.debug(
      `[run-completion-watchdog] history status for ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
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
function formatRunDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function resolvedFromOutputs(
  value: CompletionPayload["images"] | ResolvedHistoryCompletion | undefined,
): { images: CompletionImage[]; duration_ms?: number; timestamp?: string } {
  if (!value) return { images: [] };
  if (Array.isArray(value)) return { images: usableHistoryImages(value) };
  return {
    images: usableHistoryImages(value.images),
    duration_ms: value.duration_ms,
    timestamp: value.timestamp,
  };
}

export function synthesizeCompletionPayload(
  armed: ArmedCompletion,
  opts: {
    deliveredAt: number;
    images?: CompletionPayload["images"];
    durationMs?: number;
    finishedAt?: string;
  },
): CompletionPayload {
  const waitedS = Math.max(0, Math.round((opts.deliveredAt - armed.observedAt) / 1000));
  const { images, other: otherMedia } = partitionAttachableMedia(usableHistoryImages(opts.images));
  const durationSuffix =
    typeof opts.durationMs === "number" ? ` after ${formatRunDuration(opts.durationMs)}` : "";
  const outcome =
    armed.status === "success"
      ? "finished SUCCESSFULLY"
      : armed.status === "interrupted"
        ? `was INTERRUPTED (cancelled before it finished)${durationSuffix}`
        : "FAILED";
  const refName = (m: CompletionImage) => (m.subfolder ? `${m.subfolder}/${m.filename}` : m.filename);
  const names = images.map(refName).join(", ");
  // Named, never attached — the agent still learns the render produced them.
  const otherNote =
    otherMedia.length > 0
      ? ` NOT attached (not an inline-attachable image): ${otherMedia.map(refName).join(", ")}.`
      : "";
  const next =
    armed.status === "success"
      ? images.length > 0
        ? `The output file(s) from ComfyUI history are attached: ${names}.${otherNote}`
        : otherMedia.length > 0
          ? `The output(s) are NOT attached — this run produced media that cannot be sent inline.${otherNote} ` +
            `Fetch with get_image (action:"list_outputs") or get_history for this prompt id.`
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
    ...(typeof opts.durationMs === "number" ? { duration_ms: opts.durationMs } : {}),
    ...(opts.finishedAt ? { finished_at: opts.finishedAt } : {}),
    note:
      `The render you queued (prompt ${armed.promptId}) ${outcome}. No completion for it reached the ` +
      `orchestrator in the ${waitedS}s after that finish was observed here, so this notice was ` +
      `synthesised from ComfyUI itself — its execution event or its history record. That is all this ` +
      `orchestrator observed: the panel may never have sent its own completion, or it may still be ` +
      `composing one. If a completion for this same prompt id arrives later, flagged a possible repeat, ` +
      `it is THIS run and not a second render — do not report it twice. ${next}`,
  };
}

export function createRunCompletionWatchdog({
  awaiting,
  knownTicket,
  deliver,
  resolveOutputs,
  lookupStatus,
  graceMs = DEFAULT_SYNTHESIS_GRACE_MS,
  storyboardGraceMs = DEFAULT_STORYBOARD_GRACE_MS,
  now = () => Date.now(),
}: RunCompletionWatchdogDeps): RunCompletionWatchdog {
  /** promptId → the observation we are holding. FIRST observation wins: a
   *  re-observation must not push the deadline out (that is how a repeatedly
   *  re-reported completion would never expire and the agent would wait
   *  forever — the exact failure being fixed). */
  const armed = new Map<string, ArmedCompletion>();
  /** promptIds currently being synthesised. Reconcile must not re-arm one
   *  tick() has already spent — that would double-deliver if the history
   *  fetch is still in flight. */
  const inflight = new Set<string>();

  const arm = (
    promptId: string,
    status: CompletionStatus,
    observedAt: number,
    ticketedAtObservation = false,
  ): void => {
    const existing = armed.get(promptId);
    if (existing) {
      // A repeated QueueMonitor observation after panel_run received its reply
      // upgrades the arm's eviction priority without moving its deadline.
      if (ticketedAtObservation) existing.ticketedAtObservation = true;
      return;
    }
    if (inflight.has(promptId)) return;
    armed.set(promptId, {
      promptId,
      status,
      observedAt,
      ...(ticketedAtObservation ? { ticketedAtObservation: true } : {}),
    });
    while (armed.size > MAX_ARMED) {
      // Unknown/foreign completions are only held for the ticket-opening race;
      // do not let a burst of them evict arms that were already owed by a
      // panel_run ticket. If every arm is ticketed, retain FIFO eviction.
      const unticketed = [...armed.entries()].find(([, entry]) => !entry.ticketedAtObservation);
      const oldest = unticketed?.[0] ?? armed.keys().next().value;
      if (oldest === undefined) break;
      armed.delete(oldest);
    }
  };

  const expire = async (ignoreGrace: boolean): Promise<void> => {
    if (armed.size === 0) return;
    const at = now();
    for (const entry of [...armed.values()]) {
      // An extended arm is due at `storyboardGraceMs` measured from the SAME
      // observation, never from the extension: the extension is only granted
      // once `graceMs` has already elapsed, so a storyboardGraceMs below it
      // simply means the next tick delivers. There is deliberately no floor —
      // one would be unreachable (proved by mutating it: nothing changed).
      const dueAfter = entry.extended ? storyboardGraceMs : graceMs;
      // Interrupted has no better panel frame coming (it is deferred until the
      // next prompt, with wall-clock duration). Deliver at interrupt time (#2512).
      const skipGrace = ignoreGrace || entry.status === "interrupted";
      if (!skipGrace && at - entry.observedAt < dueAfter) continue;
      // Disarm FIRST and unconditionally: whatever happens below, this
      // observation is spent. Leaving it armed on a throwing deliver() would
      // re-fire it on every later tick.
      armed.delete(entry.promptId);
      inflight.add(entry.promptId);
      let ticket: RunTicket | undefined;
      try {
        ticket = awaiting(entry.promptId);
      } catch (err) {
        inflight.delete(entry.promptId);
        logger.debug(
          `[run-completion-watchdog] could not re-check prompt ${entry.promptId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      // The panel's own frame landed inside the grace — the normal case, and
      // the one this must stay quiet for.
      if (!ticket) {
        inflight.delete(entry.promptId);
        continue;
      }
      // An unknown arm observed before this dispatch cannot be the run whose
      // ticket just opened. The journal's claimRaced timestamp guard already
      // applies to journaled entries; apply the same fail-closed boundary to
      // the watchdog's in-memory, not-yet-journaled arm (#2021).
      if (typeof ticket.dispatchedAt === "number" && entry.observedAt < ticket.dispatchedAt) {
        inflight.delete(entry.promptId);
        continue;
      }
      try {
        let images: CompletionImage[] = [];
        let durationMs: number | undefined;
        let finishedAt: string | undefined;
        if (resolveOutputs) {
          try {
            const resolved = resolvedFromOutputs(await resolveOutputs(entry.promptId));
            images = resolved.images;
            durationMs = resolved.duration_ms;
            finishedAt = resolved.timestamp;
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
          // #2001 — DO NOT ANNOUNCE A SILENCE THE PANEL HAS NOT REACHED YET.
          //
          // Media that cannot be attached inline (a SaveVideo .mp4) is exactly
          // the shape for which the panel is building a storyboard contact
          // sheet before it sends its ONE consolidated frame, and the panel
          // bounds that at 25 s — past our ordinary grace. Re-arm this
          // observation ONCE against that bound rather than pre-empt it. The
          // extension is granted at most once (`extended` is never cleared), so
          // a frame that is genuinely never coming is still answered at
          // `storyboardGraceMs`, never later.
          //
          // Deliberately NOT applied on reconcile(): that path is a missed-WS /
          // hello recovery whose whole point is that it does not wait (#1556).
          if (
            !skipGrace &&
            !entry.extended &&
            partitionAttachableMedia(images).other.length > 0
          ) {
            armed.set(entry.promptId, { ...entry, extended: true });
            logger.debug(
              `[run-completion-watchdog] prompt ${entry.promptId} produced media the panel has to storyboard — holding the synthesis until ${Math.round(
                storyboardGraceMs / 1000,
              )}s after the finish instead of ${Math.round(graceMs / 1000)}s (#2001)`,
            );
            continue;
          }
        }
        // #1789 item 3 — the failure is OBSERVABLE from here on. Until now the
        // only detector of a lost completion was a human noticing the agent had
        // gone quiet.
        logger.warn(
          `[run-completion-watchdog] prompt ${entry.promptId} finished (${entry.status}) ${Math.round(
            (at - entry.observedAt) / 1000,
          )}s ago and NO completion for it has reached the orchestrator — synthesising one from its own ComfyUI observation so the agent that was told to end its turn and wait is not left idle. The panel may never have sent one or may still be composing it; either way this run is answered now (#1789/#2001)`,
        );
        deliver(
          synthesizeCompletionPayload(entry, {
            deliveredAt: at,
            images,
            durationMs,
            finishedAt,
          }),
          ticket,
        );
      } catch (err) {
        logger.warn(
          `[run-completion-watchdog] could not deliver the synthesised completion for prompt ${entry.promptId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        inflight.delete(entry.promptId);
      }
    }
  };

  return {
    observe(events) {
      for (const ev of events ?? []) {
        try {
          const promptId = typeof ev?.promptId === "string" ? ev.promptId.trim() : "";
          if (!promptId) continue;
          // Usually this is an open ticket. A fast render can finish before the
          // panel's graph_run reply returns its prompt id to panel_run (#2021),
          // though, so retain an unticketed observation until expiry and ask
          // again there. A genuinely foreign render is then discarded silently.
          let ticketedAtObservation = false;
          try {
            ticketedAtObservation = Boolean(awaiting(promptId));
            // `awaiting()` is intentionally false once the journal has a
            // completion, including after ACK. Do not retain those duplicate
            // observations; only a prompt id with no known ticket is a
            // candidate for the pre-openRun race.
            if (!ticketedAtObservation && knownTicket?.(promptId)) continue;
          } catch (err) {
            logger.debug(
              `[run-completion-watchdog] could not check prompt ${promptId} while observing: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          arm(promptId, ev.status, now(), ticketedAtObservation);
        } catch (err) {
          logger.debug(
            `[run-completion-watchdog] observe skipped an event: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },

    markTicketed(promptIds) {
      for (const raw of promptIds ?? []) {
        const promptId = typeof raw === "string" ? raw.trim() : "";
        if (!promptId) continue;
        const entry = armed.get(promptId);
        if (entry) entry.ticketedAtObservation = true;
      }
    },

    async tick() {
      await expire(false);
    },

    async reconcile(promptIds) {
      try {
        if (lookupStatus) {
          for (const raw of promptIds ?? []) {
            try {
              const promptId = typeof raw === "string" ? raw.trim() : "";
              if (!promptId || armed.has(promptId) || inflight.has(promptId)) continue;
              if (!awaiting(promptId)) continue;
              let status: CompletionStatus | null = null;
              try {
                status = await lookupStatus(promptId);
              } catch (err) {
                logger.debug(
                  `[run-completion-watchdog] history status for ${promptId} unavailable: ${err instanceof Error ? err.message : String(err)}`,
                );
                continue;
              }
              if (!status) continue;
              // A panel frame that landed DURING the lookup still wins.
              if (!awaiting(promptId)) continue;
              // observedAt = now: we just learned it finished. expire(true)
              // skips the grace; waitedS in the note is the lookup latency.
              arm(promptId, status, now(), true);
            } catch (err) {
              logger.debug(
                `[run-completion-watchdog] reconcile skipped a prompt: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
        await expire(true);
      } catch (err) {
        logger.debug(
          `[run-completion-watchdog] reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    armedCount() {
      return armed.size;
    },
  };
}
