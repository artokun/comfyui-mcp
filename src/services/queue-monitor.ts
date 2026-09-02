// Passive ComfyUI render watchdog for the panel orchestrator.
//
// The orchestrator never sees live render progress on its own: panel_run queues
// through the user's BROWSER, and the per-agent comfyui MCP only opens its WS for
// its own generate calls. So a render that wedges (a single sampler step running
// for minutes at high resolution) is invisible here — which is how a stalled job
// once let the agent stack three more behind it before anyone noticed.
//
// This service opens its OWN lightweight WebSocket to COMFYUI_URL, and — on
// modern ComfyUI — supplements it with a cheap HTTP poll (see poll() below).
// The WS handlers keep the full event vocabulary for older servers, but on
// ComfyUI 0.28 a passive (non-originating) client receives ONLY `status`
// frames: execution_start / executing / execution_* AND progress /
// progress_state are all sid-scoped to the QUEUING client (verified wire-level
// on a live 0.28.0 — a foreign run delivers nothing but queue_remaining
// transitions here). So run ATTRIBUTION for foreign jobs must come from HTTP:
//   • GET /queue        — queue_running entries are [number, prompt_id, ...],
//                          which names the running prompt (issue #258);
//   • GET /history tail — a run that starts AND finishes between polls still
//                          lands in history, so diffing the newest ids yields a
//                          completion event with success/error status even when
//                          no live signal was ever observed (issue #259).
// It holds the last-known run state and derives a stall/backlog report the
// orchestrator surfaces to the agent as a turn-start note (the same channel as
// the crash-dump injector).
//
// Everything here is BEST-EFFORT: if the socket can't open or drops, the report
// is simply "inactive" and nothing in the orchestrator changes. It must never
// throw into the main path.

import { type RawData } from "ws";
import { logger } from "../utils/logger.js";
import { getComfyUIAuthHeaders } from "../config.js";
import { LoopbackWebSocket } from "../transport/loopback-websocket.js";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { sameOrigin } from "../utils/origin.js";

interface MonitorState {
  connected: boolean;
  runningPromptId: string | null;
  // Prompt ids of the PENDING (queued, not yet running) tasks, from GET /queue's
  // queue_pending. Enables per-item self-attribution: a backlog is only the agent's
  // own batch when the running job AND every pending job are ids we queued (#559).
  // Best-effort (poll-derived); empty when the poll hasn't populated it.
  pendingPromptIds: string[];
  currentNode: string | null;
  progressValue: number | null;
  progressMax: number | null;
  // ComfyUI's status.exec_info.queue_remaining — the total tasks the server still
  // has (running + pending). Last-known value between status frames.
  queueRemaining: number;
  // Node id → class_type for the RUNNING prompt's graph, captured from the
  // /queue poll's queue_running entry — the only place this passive client
  // learns class types on modern ComfyUI (sid-scoped frames never arrive here).
  // Drives the training exemption in report() (#1652): TrainLoraNode & co. emit
  // no per-step progress frames, so the hard stall floor would otherwise fire on
  // EVERY healthy training run past 30 minutes. Empty until the poll captures
  // the graph; cleared with the run.
  runningNodeClassTypes: Record<string, string>;
  // Monotonic ms timestamp of the last FORWARD-progress signal (node advanced or
  // progress value ticked up) while a job runs. A stuck step re-emits the same
  // progress value, which must NOT refresh this — that's how we see the stall.
  lastActivityTs: number | null;
  // LIVENESS heartbeats — the server is alive here (even if a long node emits no
  // FORWARD progress) when EITHER is fresh (#183):
  //   lastFrameTs      — any ws frame of any type arrived (server socket alive).
  //   lastServerAliveTs — a /queue HTTP poll SUCCEEDED (server answered).
  // A busy, progress-silent node (tiled VAE decode, audio/video sampling, a big
  // model load) keeps the 1 Hz poll fresh, so it is NOT mistaken for a wedge; a
  // server that stops answering lets both lapse → a real stall still surfaces.
  lastFrameTs: number | null;
  lastServerAliveTs: number | null;
  // The most recent completed run (from the /history tail diff or, on older
  // ComfyUI, the execution_success/error WS events). Sticky: survives idle so a
  // tab that connects late still learns what just finished.
  lastCompleted: CompletionEvent | null;
}

/** How a finished run ended. `interrupted` = cancelled mid-run. */
export type CompletionStatus = "success" | "error" | "interrupted";

/** One finished run, observed live (WS) or recovered from the /history tail. */
export interface CompletionEvent {
  promptId: string;
  status: CompletionStatus;
  /** ms epoch when WE observed the completion (not ComfyUI's own timestamp). */
  at: number;
}

export interface StallReport {
  /** A job is running but its node + progress have not advanced for >= stallMs. */
  stalled: boolean;
  /** More than one task in flight (running + pending) — a backlog the agent may
   *  not realize it created by re-queuing behind a slow job. */
  backlog: boolean;
  /** True when the in-flight work is attributable to THIS session (a prompt id we
   *  queued, or a very recent self-queue) — a deliberate batch, not a foreign or
   *  stuck job. The backlog warning is suppressed in that case (#559). */
  selfAttributed: boolean;
  /** True when a VISIBLE in-flight prompt id is not one this session queued.
   *  Extra queueRemaining with no such id is stale accounting, not proof of
   *  foreign work — the turn note must not claim "this session didn't queue"
   *  unless this is true (#559 recurrence). */
  foreignVisible: boolean;
  runningPromptId: string | null;
  currentNode: string | null;
  /** running + pending, from ComfyUI's own queue_remaining. */
  queueDepth: number;
  /** ms the running job has been idle (0 when not stalled). */
  stalledForMs: number;
  /** e.g. "0/4" when a progress frame has been seen, else null. */
  progress: string | null;
}

export interface QueueSnapshot {
  connected: boolean;
  running: boolean;
  runningPromptId: string | null;
  queueDepth: number;
  /** The node id currently executing (ComfyUI graph node id), null when idle. */
  currentNode: string | null;
  /** Progress of the current node (sampler steps), null before the first tick. */
  progressValue: number | null;
  progressMax: number | null;
  /** The most recent completed run (sticky; null until one completes). */
  lastCompleted: CompletionEvent | null;
  /** True when the in-flight work is attributable to THIS session (#559). */
  selfAttributed: boolean;
  /** STRICT attribution for the panel_run duplicate fence (#862): true only
   *  when every visible in-flight prompt id is one this session queued AND the
   *  reported depth is fully accounted for — the coarse recent-self-queue
   *  fallback never counts here. */
  selfAttributedProven: boolean;
  /** #2684 — ms epoch of the last evidence the monitored ComfyUI answered HERE:
   *  a successful `/queue` poll (`lastServerAliveTs`) or any decodable ws frame
   *  (`lastFrameTs`), whichever is newer. null when neither has ever happened.
   *
   *  This is the SAME heartbeat `report()` reduces to `serverAlive`, exposed so
   *  a consumer of `running`/`runningPromptId` can tell a live claim from a
   *  last-known one. Every other field here is last-known state with no expiry;
   *  without this there is no way to ask how old that state is, which is how a
   *  never-confirmed run kept being named as present-tense fact (#2684). */
  lastServerContactTs: number | null;
}

/**
 * `new URL(...).pathname` with trailing slashes stripped, "" when unparseable.
 * Only ever reached for parseable input — `sameComfyTarget` calls `sameOrigin`
 * first, which rejects everything `new URL` cannot take.
 */
function basePathOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/**
 * True when `next` names the ComfyUI this monitor is already pointed at, differing
 * only in SPELLING (#1615) — `http://127.0.0.1:8188` and `http://localhost:8188`
 * are one server, and a panel hello can re-spell the target without moving it.
 *
 * The base path is compared separately because it is not part of an origin, and
 * two ComfyUI can genuinely sit behind one reverse proxy at /comfy-a and /comfy-b
 * — collapsing those would be a FALSE identity, the mirror of the bug this fixes.
 * A null previous target never matches: there is no prior server to have owned
 * anything on.
 */
function sameComfyTarget(prev: string | null, next: string): boolean {
  if (!prev || !sameOrigin(prev, next)) return false;
  return basePathOf(prev) === basePathOf(next);
}

const RECONNECT_MS = 5000;
// How long after a self-queue (panel_run) the in-flight work is still treated as
// this session's own batch when the running prompt id can't be matched directly
// (e.g. the panel reply carried no prompt_id). A sweep of a dozen renders at tens
// of seconds each drains well inside this, so a deliberate batch never trips the
// backlog warning; a genuinely foreign job appearing long after our last queue
// still surfaces (#559).
const SELF_QUEUE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
// /history tail entries fetched per poll. Wide enough that a realistic burst
// of sub-second runs between 1 Hz polls stays inside the window; when a diff
// still saturates it (every entry new), we log the potential gap instead of
// silently claiming coverage.
const HISTORY_TAIL_ITEMS = 32;
// Absolute floor of zero-forward-progress time after which a running job is
// flagged as stalled EVEN when the server still looks alive here — the backstop
// for a genuine in-node deadlock on a reachable ComfyUI (#183). Far beyond any
// legitimate single-node NON-training runtime (a long tiled VAE decode / video
// sample is minutes, not half an hour), so it never trips on a healthy render.
// Training nodes legitimately exceed it (hours of silent tqdm), which is why
// report() exempts runs whose graph contains a known trainer class (#1652).
const HARD_STALL_FLOOR_MS = 30 * 60 * 1000; // 30 minutes
/**
 * #2684 — how long the monitored ComfyUI may stay SILENT before a believed
 * running prompt stops being reported as present-tense fact.
 *
 * Keeping the last-known run across a blip is deliberate and right: one timed-out
 * poll is not proof a render finished, and clearing on it would falsely report an
 * active job as done. What was wrong is that the belief had no upper bound — when
 * the monitored target stops answering entirely (`fetchJson` returns null on abort,
 * timeout or non-2xx, and `applyQueue` then returns before it can clear), nothing
 * ever downgrades "is running" to "was running, unverified since".
 *
 * 30 s is chosen against the two clocks that bound it. Below: the poll runs at
 * ~1 Hz with a 2.5 s timeout, so 30 s of total silence is ten-plus consecutive
 * failed polls AND zero ws frames — well past any transient blip. Above: the
 * default stall threshold is 180 s and the live setting floors at 15 s, so the
 * busy note downgrades BEFORE `report()` can raise a STALLED notice off the same
 * lapsed heartbeat. That ordering is the point: the reported session got both
 * statements at once, one derived from the other's negation.
 */
export const RUNNING_UNCONFIRMED_MS = 30_000;
// Node classes whose HEALTHY runtime legitimately exceeds the hard floor with
// ZERO forward-progress frames: ComfyUI's built-in LoRA training only rewrites
// a tqdm bar on stdout — no per-step `progress` WS frames — so lastActivityTs
// never bumps and idleFor grows monotonically for the whole run (#1652). A
// 1500-step SDXL LoRA at ~2.6 s/it runs ~65 minutes and crossed the 30-minute
// floor every single time; the false STALLED note (whose remedy is to CANCEL
// the run) was structural, not a race. Best-effort list of known trainer
// classes — deliberately narrow: a class that also appears in ordinary render
// graphs (e.g. LoraModelLoader) must NOT be added, or common renders would
// silently lose the deadlock backstop.
const TRAINING_NODE_CLASS_TYPES = new Set([
  "TrainLoraNode", // ComfyUI core
  "TrainLoraNodeAdvanced", // core advanced variant
  "LoraTrainer", // common community trainer packs
]);

class QueueMonitorImpl {
  private ws: LoopbackWebSocket | null = null;
  private url: string | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Generation start/end transition hooks (for the Ollama VRAM pause). Fired on
  // the idle→running edge and the running→idle edge, best-effort (a throwing
  // handler must never break the monitor). `busy` is our own edge-tracking flag,
  // distinct from runningPromptId (which flips null between backlogged prompts).
  private busy = false;
  private onRunStart: (() => void) | null = null;
  private onRunEnd: (() => void) | null = null;
  private state: MonitorState = {
    connected: false,
    runningPromptId: null,
    pendingPromptIds: [],
    currentNode: null,
    progressValue: null,
    progressMax: null,
    queueRemaining: 0,
    runningNodeClassTypes: {},
    lastActivityTs: null,
    lastFrameTs: null,
    lastServerAliveTs: null,
    lastCompleted: null,
  };
  // ---- HTTP-poll bookkeeping (the broadcast-safe channel on modern ComfyUI) ----
  private pollInFlight = false;
  // Bumped on every start()/stop(). A poll captures it before fetching and
  // abandons its (now stale) responses if a retarget happened while awaiting —
  // otherwise an in-flight /queue answer from the OLD ComfyUI could mutate
  // state for the NEW one.
  private pollGeneration = 0;
  // When THIS monitor came up (ms epoch) — the priming cutoff for the history
  // diff: tail entries that completed before this predate us and are swallowed;
  // ones that completed after (a run finishing during startup) are reported.
  private monitorStartTs = Date.now();
  // /history tail diff: the ids seen on the previous poll.
  private historyPrimed = false;
  private historySeen = new Set<string>();
  // Prompt ids already reported as completed — dedupes the WS event vs. the
  // history diff observing the same finish. Bounded FIFO.
  private completedReported = new Set<string>();
  // Completions not yet drained by the broadcaster. Bounded.
  private pendingCompletions: CompletionEvent[] = [];
  /** Prompt that just left /queue this poll — record its history even if the
   *  id was already in the tail (an in-progress row becoming interrupted). */
  private vanishedPromptId: string | null = null;
  // ---- self-attribution for the backlog warning (#559) ----
  // Prompt ids THIS orchestrator queued via panel_run, plus the ms timestamp of
  // the most recent self-queue. A backlog made entirely of the agent's own recent
  // jobs is an EXPECTED batch (a sweep/comparison), not evidence of a wedge, so it
  // must not trigger the destructive cancel-with-clear_pending remedy.
  private selfQueuedIds = new Set<string>();
  private lastSelfQueueTs: number | null = null;

  /** Open the watchdog WS to ComfyUI. Idempotent per-URL; best-effort (never
   *  throws). A retarget (new URL) or a prior stop() must re-open the socket:
   *  the orchestrator calls stop()+start(newUrl) when ComfyUI is retargeted
   *  (e.g. 127.0.0.1→localhost from a panel hello), so a stale `this.url` must
   *  NOT early-return — that left the watchdog permanently disconnected. */
  start(comfyuiUrl: string): void {
    if (this.url === comfyuiUrl && !this.stopped) return; // already live on this URL
    // #1615 — read BEFORE `this.url` is overwritten below, and before our own
    // stop() (which leaves the url intact). It has to be captured here rather
    // than checked at the top, because the production retarget path in
    // orchestrator/index.ts calls QueueMonitor.stop() ITSELF and only then
    // start(url): by then `this.stopped` is true, so any early-return guarded on
    // it would never fire on the one path that matters.
    const respelledSameTarget = sameComfyTarget(this.url, comfyuiUrl);
    this.stop(); // tear down any prior socket/reconnect timer (also on URL change)
    this.url = comfyuiUrl;
    this.stopped = false;
    // A (re)start may target a DIFFERENT ComfyUI whose history tail is all new
    // to us — invalidate any in-flight poll (generation bump), re-prime the
    // diff, and drop completion state that belonged to the old target so its
    // backlog can neither replay nor leak across the retarget.
    this.pollGeneration++;
    this.monitorStartTs = Date.now();
    this.historyPrimed = false;
    this.historySeen.clear();
    this.completedReported.clear();
    this.pendingCompletions.length = 0;
    this.vanishedPromptId = null;
    this.state.lastCompleted = null;
    // Self-queued prompt ids belong to the OLD target — a fresh ComfyUI's jobs are
    // foreign to us until we queue them, so drop the attribution (#559).
    //
    // #1615 — but ONLY when the target actually moved. A panel hello arriving as
    // `localhost:8188` while we are live on `127.0.0.1:8188` is a retarget by
    // string and the same server in fact, and clearing here made every render
    // STILL IN FLIGHT ON IT unattributable. panel_run's duplicate fence keys on
    // exactly that ledger (`selfAttributedProven`), so it then refused every run
    // — including a scoped to_node_id preview — until the queue drained. Those
    // jobs never became foreign; only their spelling changed. Ownership is a
    // property of the SERVER, so it survives a re-spelling, and a genuine
    // retarget still drops it.
    if (!respelledSameTarget) {
      this.selfQueuedIds.clear();
      this.lastSelfQueueTs = null;
    }
    // Liveness heartbeats belong to the OLD target — reset so a fresh target's
    // stall clock doesn't inherit a stale "alive" (or a stale "dark") reading.
    this.state.lastFrameTs = null;
    this.state.lastServerAliveTs = null;
    this.connect();
  }

  /** Register generation-transition handlers (idempotent overwrite). Called by
   *  the orchestrator to unload/warm the local Ollama model around renders. */
  setTransitionHandlers(h: { onRunStart?: () => void; onRunEnd?: () => void }): void {
    this.onRunStart = h.onRunStart ?? null;
    this.onRunEnd = h.onRunEnd ?? null;
  }

  private emitStart(): void {
    if (this.busy) return;
    this.busy = true;
    try {
      this.onRunStart?.();
    } catch (err) {
      logger.debug(`[queue-monitor] onRunStart threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private emitEndIfIdle(): void {
    // Only truly idle when nothing is running AND the queue is drained — between
    // backlogged prompts runningPromptId briefly clears but queueRemaining stays
    // positive, and we must NOT warm the model just to unload it again.
    if (!this.busy) return;
    if (this.state.runningPromptId !== null) return;
    if (this.state.queueRemaining > 0) return;
    this.busy = false;
    try {
      this.onRunEnd?.();
    } catch (err) {
      logger.debug(`[queue-monitor] onRunEnd threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Is a generation currently in flight (edge-tracked)? */
  isBusy(): boolean {
    return this.busy;
  }

  /** Record a prompt THIS orchestrator just queued (panel_run), so the backlog
   *  warning can tell the agent's own deliberate batch from a foreign or stuck
   *  job (#559). `promptId` may be null when the panel reply carried none — the
   *  timestamp alone still marks a recent self-queue. Never throws. */
  markSelfQueued(promptId?: string | null): void {
    this.lastSelfQueueTs = Date.now();
    if (typeof promptId === "string" && promptId) {
      this.selfQueuedIds.add(promptId);
      // Bounded FIFO — Set iterates in insertion order, so drop the oldest.
      while (this.selfQueuedIds.size > 200) {
        const oldest = this.selfQueuedIds.values().next().value;
        if (oldest === undefined) break;
        this.selfQueuedIds.delete(oldest);
      }
    }
  }

  /**
   * Can a run be attributed to THIS session? (#889)
   *
   * Three answers, and the third is the one that was missing. A run-errored
   * notification used to open "The workflow run **you just queued** ERRORED" as
   * a fixed template — for a session whose agent had never called panel_run at
   * all. It then spent a round trip diagnosing a failure it did not cause, which
   * the wording ("STOP — do not carry on as if it succeeded") made expensive
   * rather than merely cosmetic: it invites inventing a connection.
   *
   *   "mine"     — the id is one we recorded queuing. Proven.
   *   "not-mine" — this session has queued NOTHING, so it cannot be ours,
   *                whether or not an id was parsed. Also proven, and it is the
   *                reported case exactly.
   *   "unknown"  — we have queued something, but this run carries no id (or an
   *                unrecognised one). Genuinely undecidable: our own record is
   *                bounded to the last 200 ids and a panel reply may carry none.
   *
   * `unknown` must not collapse into either certainty. Claiming the run is the
   * agent's repeats this bug; claiming it is not risks telling an agent to
   * ignore its own failed render.
   */
  attributeRun(promptId?: string | null): "mine" | "not-mine" | "unknown" {
    const id = typeof promptId === "string" ? promptId.trim() : "";
    if (id && this.selfQueuedIds.has(id)) return "mine";
    // Nothing queued by this session, ever — including the coarse timestamp,
    // which is set even when the panel reply carried no id. There is nothing
    // this session could be the author of.
    if (this.selfQueuedIds.size === 0 && this.lastSelfQueueTs === null) return "not-mine";
    return "unknown";
  }

  /** Prompt ids the monitor can currently SEE (running + poll-derived pending).
   *  Distinct from queueRemaining, which status frames can leave stale/high. */
  private inFlightPromptIds(): string[] {
    const ids: string[] = [];
    if (this.state.runningPromptId) ids.push(this.state.runningPromptId);
    ids.push(...this.state.pendingPromptIds);
    return ids;
  }

  /** True when the ENTIRE in-flight queue is attributable to this session — i.e.
   *  every visible prompt (the running one plus every pending one) is an id we
   *  queued. That is the only safe basis for suppressing the backlog warning: a
   *  single foreign job (running OR pending) means the queue is NOT purely our own
   *  batch and the agent should still be told (#559).
   *
   *  Precise id-matching is used whenever we have ANY recorded self-queued id AND
   *  there is at least one identifiable in-flight prompt. Only when we have no ids
   *  to match against (the panel reply never carried a prompt_id) OR nothing is yet
   *  identifiable do we fall back to the coarse "did we self-queue very recently"
   *  heuristic — so a recent self-queue can NOT mask a job whose id we can see is
   *  not ours.
   *
   *  Extra queueRemaining beyond the visible ids is NOT treated as foreign. Status
   *  frames can leave that counter high after the poll has already listed every
   *  real job (the #559 recurrence: one self-owned running prompt, pending empty,
   *  queueRemaining=2). After the 10-minute window the 1 Hz poll has had hundreds
   *  of chances to name a real extra job; if it hasn't, the extra slot is stale
   *  accounting. The duplicate fence still uses the strict proven form. */
  private isSelfAttributed(): boolean {
    const inFlight = this.inFlightPromptIds();
    const recentSelfQueue =
      this.lastSelfQueueTs != null && Date.now() - this.lastSelfQueueTs < SELF_QUEUE_WINDOW_MS;

    if (this.selfQueuedIds.size > 0 && inFlight.length > 0) {
      // We receive a prompt id for every job we queue, so any VISIBLE in-flight id
      // that isn't one of ours is definitively a foreign job → not our batch.
      if (inFlight.some((id) => !this.selfQueuedIds.has(id))) return false;
      // Every VISIBLE in-flight job is ours. Rapid bursts can leave pending ids
      // lagging queueRemaining; a long self-owned render can leave queueRemaining
      // stale-high after the timestamp window. Neither is a foreign job.
      return true;
    }
    // No ids to match against (the panel never surfaced one) or nothing identifiable
    // in flight yet → fall back to the coarse recent-self-queue timestamp.
    return recentSelfQueue;
  }

  /** True when at least one visible in-flight prompt id is not one we queued.
   *  Empty visibility (depth from status frames only) is unproven, not foreign. */
  private isForeignVisible(): boolean {
    return this.inFlightPromptIds().some((id) => !this.selfQueuedIds.has(id));
  }

  /** The STRICT form of isSelfAttributed, for the panel_run duplicate fence
   *  (#862): true only when the in-flight work is PROVABLY this session's own —
   *  every visible in-flight prompt id is one we queued AND the poll has fully
   *  accounted for the reported depth. The coarse recent-self-queue timestamp
   *  fallback NEVER proves attribution here: it shows this session queued
   *  SOMETHING recently, not that the work in flight is it, and a fence that
   *  refuses a dispatch needs a stronger warrant than a backlog warning does
   *  (codex gate: under the fallback, an unrelated render appearing inside the
   *  10-minute window would have sailed past the fence). The cost is deliberate:
   *  a rapid self-queued burst whose ids the 1 Hz poll has not captured yet, or
   *  a panel that returned no prompt_id, reads as unproven, and the run is
   *  refused with the allow_duplicate override named — a false refusal with an
   *  actionable remedy, never a silent duplicate. */
  private isSelfAttributedProven(): boolean {
    const inFlight = this.inFlightPromptIds();
    if (this.selfQueuedIds.size === 0 || inFlight.length === 0) return false;
    if (inFlight.some((id) => !this.selfQueuedIds.has(id))) return false;
    const depth = Math.max(inFlight.length, Math.max(0, this.state.queueRemaining));
    return inFlight.length >= depth;
  }

  stop(): void {
    this.stopped = true;
    this.pollGeneration++; // strand any in-flight poll's pending responses
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    // Clear the flag here rather than relying on the old socket's `close`: once
    // we null `this.ws`, that socket's now-superseded close handler early-returns
    // (this.ws !== ws) and would otherwise leave `connected` stuck true — through
    // a retarget's stop()+start() gap, or indefinitely if the reconnect fails.
    this.state.connected = false;
  }

  private wsUrl(): string {
    // http(s)://host:port  →  ws(s)://host:port/ws?clientId=...
    const base = (this.url ?? "http://127.0.0.1:8188").replace(/^http/, "ws").replace(/\/+$/, "");
    return `${base}/ws?clientId=comfyui-mcp-watchdog`;
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: LoopbackWebSocket;
    try {
      // Ride the same auth as HTTP (COMFYUI_AUTH_* + Cloudflare Access service
      // token) on the WS handshake, so the watchdog reaches a ComfyUI behind a
      // proxy / CF Access. undefined when unauth'd → identical to `new WebSocket(url)`.
      const authHeaders = getComfyUIAuthHeaders();
      ws = new LoopbackWebSocket(
        this.wsUrl(),
        Object.keys(authHeaders).length ? { headers: authHeaders } : undefined,
      );
    } catch (err) {
      logger.debug(`[queue-monitor] WS construct failed: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    // Guard every handler against a superseded socket: on retarget, stop()+start()
    // opens a new socket while the old one is still async-closing. Without the
    // `this.ws !== ws` check the old socket's late `close` would null out the NEW
    // socket and schedule a spurious reconnect.
    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.state.connected = true;
      logger.debug("[queue-monitor] watchdog WS connected");
    });
    ws.on("message", (raw: RawData, isBinary: boolean) => {
      if (this.ws !== ws) return;
      if (isBinary) return; // preview image frames — ignore
      this.onMessage(raw.toString());
    });
    ws.on("close", () => {
      if (this.ws !== ws) return; // a superseded socket closing — ignore
      this.state.connected = false;
      this.ws = null;
      this.scheduleReconnect();
    });
    ws.on("error", (err: Error) => {
      logger.debug(`[queue-monitor] WS error: ${err.message}`);
      try {
        ws.close();
      } catch {
        /* close handler schedules the reconnect */
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_MS);
    // Don't keep the process alive solely for the watchdog reconnect.
    this.reconnectTimer.unref?.();
  }

  private touchActivity(): void {
    this.state.lastActivityTs = Date.now();
  }

  /** Adopt [promptId] as the running prompt when it's new — the broadcast-safe
   *  substitute for the sid-scoped execution_start this client never receives
   *  on modern ComfyUI. Fires the start transition exactly once per run. */
  private adoptRunningPrompt(promptId: unknown): void {
    if (typeof promptId !== "string" || promptId === this.state.runningPromptId) return;
    this.state.runningPromptId = promptId;
    this.touchActivity();
    this.emitStart();
  }

  private clearRunning(): void {
    this.state.runningPromptId = null;
    this.state.currentNode = null;
    this.state.progressValue = null;
    this.state.progressMax = null;
    this.state.runningNodeClassTypes = {};
    this.state.lastActivityTs = null;
  }

  private onMessage(text: string): void {
    let msg: { type?: string; data?: Record<string, unknown> };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    // Any decodable frame proves the server's ws is alive right now — a liveness
    // heartbeat independent of FORWARD progress, so a long progress-silent node
    // isn't mistaken for a wedge (#183).
    this.state.lastFrameTs = Date.now();
    const data = (msg.data ?? {}) as Record<string, unknown>;
    switch (msg.type) {
      case "status": {
        const status = data.status as Record<string, unknown> | undefined;
        const execInfo = status?.exec_info as Record<string, unknown> | undefined;
        const qr = execInfo?.queue_remaining;
        if (typeof qr === "number") {
          this.state.queueRemaining = qr;
          // A status frame with an empty queue is ComfyUI's authoritative
          // "fully idle" signal. On modern ComfyUI (0.2x) the sid-scoped
          // executing/execution_success events never reach this passive
          // watchdog (see the progress_state case), so a run learned from
          // progress frames would otherwise never clear — drain it here.
          if (qr === 0) {
            if (this.state.runningPromptId !== null) this.clearRunning();
            this.state.pendingPromptIds = []; // fully idle — no pending work
            this.emitEndIfIdle();
          }
        }
        break;
      }
      case "execution_start": {
        this.state.runningPromptId = typeof data.prompt_id === "string" ? data.prompt_id : null;
        this.state.currentNode = null;
        this.state.progressValue = null;
        this.state.progressMax = null;
        this.touchActivity();
        this.emitStart();
        break;
      }
      case "executing": {
        const node = data.node;
        if (node === null || node === undefined) {
          // ComfyUI sends node:null at the end of a prompt's execution.
          this.clearRunning();
          this.emitEndIfIdle();
        } else {
          const n = String(node);
          if (n !== this.state.currentNode) this.touchActivity(); // a new node = real progress
          this.state.currentNode = n;
          if (typeof data.prompt_id === "string") this.state.runningPromptId = data.prompt_id;
        }
        break;
      }
      case "progress": {
        const value = typeof data.value === "number" ? data.value : null;
        const max = typeof data.max === "number" ? data.max : null;
        // ONLY treat an advancing value as activity — a wedged step re-emits the
        // same value, and that must keep the stall clock running.
        if (value !== null && value !== this.state.progressValue) this.touchActivity();
        this.state.progressValue = value;
        this.state.progressMax = max;
        if (typeof data.node === "string") this.state.currentNode = data.node;
        // progress IS broadcast to every client and carries the prompt_id —
        // adopt it, since the sid-scoped execution_start may never have arrived
        // (see the progress_state case below).
        this.adoptRunningPrompt(data.prompt_id);
        break;
      }
      case "progress_state": {
        // Modern ComfyUI (verified live on 0.28): execution_start / executing /
        // execution_success are sent ONLY to the client that queued the prompt,
        // so this passive watchdog never sees them — but progress_state IS
        // broadcast, fires from the first node on, and names the running
        // prompt + node. Derive the run state from it so browser-/agent-queued
        // renders stay visible here (running flag, prompt_id, current node).
        this.adoptRunningPrompt(data.prompt_id);
        const nodes = data.nodes;
        if (nodes && typeof nodes === "object") {
          for (const entry of Object.values(nodes as Record<string, unknown>)) {
            if (!entry || typeof entry !== "object") continue;
            const n = entry as { state?: unknown; node_id?: unknown };
            if (n.state === "running" && typeof n.node_id === "string") {
              if (n.node_id !== this.state.currentNode) this.touchActivity(); // node advanced
              this.state.currentNode = n.node_id;
            }
          }
        }
        break;
      }
      case "execution_success":
      case "execution_error":
      case "execution_interrupted": {
        // Older ComfyUI broadcasts these to every client; modern 0.28 scopes
        // them to the originator (own runs still pass through here when the
        // orchestrator queued them). recordCompletion dedupes against the
        // /history diff seeing the same finish.
        if (typeof data.prompt_id === "string") {
          this.recordCompletion(
            data.prompt_id,
            msg.type === "execution_success" ? "success" : msg.type === "execution_interrupted" ? "interrupted" : "error",
          );
        }
        this.clearRunning();
        this.emitEndIfIdle();
        break;
      }
      default:
        break;
    }
  }

  /** Record one finished run exactly once (WS event and /history diff can both
   *  observe the same finish). Completing the tracked running prompt also
   *  clears the run state. Never throws. */
  private recordCompletion(promptId: string, status: CompletionStatus): void {
    if (this.completedReported.has(promptId)) return;
    this.completedReported.add(promptId);
    // Bounded FIFO — Set iterates in insertion order, so drop the oldest.
    while (this.completedReported.size > 200) {
      const oldest = this.completedReported.values().next().value;
      if (oldest === undefined) break;
      this.completedReported.delete(oldest);
    }
    const ev: CompletionEvent = { promptId, status, at: Date.now() };
    this.state.lastCompleted = ev;
    this.pendingCompletions.push(ev);
    // Bound must exceed the history tail (HISTORY_TAIL_ITEMS) so one saturated
    // diff still reaches the broadcaster whole; beyond that, drop the oldest.
    while (this.pendingCompletions.length > 2 * HISTORY_TAIL_ITEMS) this.pendingCompletions.shift();
    if (this.state.runningPromptId === promptId) {
      this.clearRunning();
      this.emitEndIfIdle();
    }
  }

  /** Hand the not-yet-broadcast completions to the queue_status broadcaster
   *  (each drains exactly once). */
  drainCompletions(): CompletionEvent[] {
    if (this.pendingCompletions.length === 0) return [];
    return this.pendingCompletions.splice(0);
  }

  /** GET a JSON endpoint on the monitored ComfyUI. Best-effort: null on any
   *  failure, hard 2.5s timeout so a wedged server can't pile up polls. */
  private async fetchJson(path: string): Promise<unknown> {
    if (!this.url) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    (timer as { unref?: () => void }).unref?.();
    try {
      const res = await comfyuiFetch(`${this.url.replace(/\/+$/, "")}${path}`, { signal: ctrl.signal });
      if (!res.ok) return null;
      return (await res.json()) as unknown;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** One HTTP poll tick — the broadcast-safe channel on modern ComfyUI, where
   *  the passive WS carries no attribution (see header). Reads GET /queue for
   *  the running prompt_id + true depth (#258) and diffs GET /history's tail
   *  for runs that finished since the last poll — including runs that started
   *  AND finished entirely between polls (#259). Best-effort, never rejects,
   *  self-guards against overlap. Both fetches run in PARALLEL so the
   *  worst-case poll is one timeout, not two — overlapping ticks bail at
   *  pollInFlight, so a serial 5s worst case would stall attribution. */
  async poll(): Promise<void> {
    if (this.stopped || !this.url || this.pollInFlight) return;
    this.pollInFlight = true;
    const gen = this.pollGeneration;
    const fetchStart = Date.now();
    try {
      const [q, h] = await Promise.all([
        this.fetchJson("/queue"),
        this.fetchJson(`/history?max_items=${HISTORY_TAIL_ITEMS}`),
      ]);
      // A stop()/start() (retarget) happened while we were awaiting — these
      // responses belong to the OLD target; writing them would corrupt the
      // fresh state (and re-seed the old server's completions).
      if (gen !== this.pollGeneration || this.stopped) return;
      this.applyQueue(q, fetchStart);
      this.applyHistory(h);
    } catch (err) {
      logger.debug(`[queue-monitor] poll failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.pollInFlight = false;
    }
  }

  private applyQueue(raw: unknown, fetchStart: number): void {
    const q = raw as { queue_running?: unknown; queue_pending?: unknown } | null;
    if (!q || typeof q !== "object") return;
    // The server answered this /queue poll → it's alive here right now. This is
    // the heartbeat that keeps a long, progress-silent node (VAE decode, model
    // load) from being flagged as stalled — and that lapses when the server
    // stops answering, letting a real stall surface (#183).
    this.state.lastServerAliveTs = fetchStart;
    const running = Array.isArray(q.queue_running) ? q.queue_running : [];
    const pending = Array.isArray(q.queue_pending) ? q.queue_pending : [];
    this.state.queueRemaining = running.length + pending.length;
    // queue_pending entries are [number, prompt_id, prompt, extra, outputs] too —
    // record their ids for per-item self-attribution (#559).
    this.state.pendingPromptIds = pending
      .map((entry) => (Array.isArray(entry) && typeof entry[1] === "string" ? entry[1] : null))
      .filter((id): id is string => id !== null);
    // queue_running entries are [number, prompt_id, prompt, extra, outputs] —
    // the ONLY place a passive observer learns WHICH prompt runs on 0.28.
    const first = running[0];
    if (Array.isArray(first) && typeof first[1] === "string") {
      this.adoptRunningPrompt(first[1]);
      // Index 2 is the full prompt graph (node id → { class_type, ... }) — the
      // ONLY place this passive client learns the running run's class types.
      // Captured so report() can tell a long TRAINING node (no per-step
      // progress frames by design, #1652) from a wedge.
      const prompt = first[2];
      const types: Record<string, string> = {};
      if (prompt && typeof prompt === "object" && !Array.isArray(prompt)) {
        for (const [nodeId, def] of Object.entries(prompt as Record<string, unknown>)) {
          const ct = (def as { class_type?: unknown } | null)?.class_type;
          if (typeof ct === "string") types[nodeId] = ct;
        }
      }
      this.state.runningNodeClassTypes = types;
    } else if (running.length === 0 && this.state.runningPromptId !== null) {
      // Empty queue → the tracked run is over. Skip the clear if a run was
      // adopted AFTER this fetch began (the response would be stale for it).
      if ((this.state.lastActivityTs ?? 0) <= fetchStart) {
        this.vanishedPromptId = this.state.runningPromptId;
        this.clearRunning();
        this.emitEndIfIdle();
      }
    } else if (running.length === 0) {
      this.emitEndIfIdle();
    }
  }

  /** Read one /history entry into diff-able facts. `queueNum` is ComfyUI's
   *  monotonic queue counter (prompt[0]) — /history object order is NOT
   *  chronological (see history-select.ts), so this is the only real order
   *  key. `completedTs` is the newest server-side message timestamp (the end
   *  event is always last), null when the entry carries none. */
  private parseHistoryEntry(
    id: string,
    raw: unknown,
  ): { id: string; queueNum: number; status: CompletionStatus; completedTs: number | null } {
    const entry = raw as {
      prompt?: unknown;
      status?: { status_str?: unknown; completed?: unknown; messages?: unknown };
    } | null;
    const st = entry && typeof entry === "object" ? entry.status : undefined;
    const messages = Array.isArray(st?.messages) ? (st.messages as unknown[]) : [];
    const has = (type: string) => messages.some((m) => Array.isArray(m) && m[0] === type);
    let status: CompletionStatus;
    // Interrupt is terminal even when ComfyUI marks completed:true / status_str
    // success-or-error — that used to classify a cancel as a successful finish.
    if (has("execution_interrupted")) {
      status = "interrupted";
    } else if (has("execution_error") || st?.status_str === "error") {
      status = "error";
    } else if (st?.completed === true || st?.status_str === "success" || st === undefined) {
      status = "success";
    } else {
      status = "error";
    }
    let completedTs: number | null = null;
    for (const m of messages) {
      if (!Array.isArray(m)) continue;
      const ts = (m[1] as { timestamp?: unknown } | undefined)?.timestamp;
      if (typeof ts === "number" && (completedTs === null || ts > completedTs)) completedTs = ts;
    }
    const prompt = entry && typeof entry === "object" ? entry.prompt : undefined;
    const queueNum =
      Array.isArray(prompt) && typeof prompt[0] === "number" ? prompt[0] : Number.MAX_SAFE_INTEGER;
    return { id, queueNum, status, completedTs };
  }

  private applyHistory(raw: unknown): void {
    const h = raw as Record<string, unknown> | null;
    if (!h || typeof h !== "object" || Array.isArray(h)) return;
    const ids = Object.keys(h);
    if (!this.historyPrimed) {
      // First look after (re)start. Entries whose completion predates the
      // monitor are swallowed — but a run that finished DURING startup
      // (server-side timestamp after monitorStartTs) is a real completion the
      // subscribers must still see, not priming noise. (Timestamps are the
      // server's clock; against a remote host with heavy skew this degrades to
      // at worst a replayed or swallowed tail entry at startup — best-effort.)
      this.historyPrimed = true;
      this.historySeen = new Set(ids);
      const fresh = ids
        .map((id) => this.parseHistoryEntry(id, h[id]))
        .filter((e) => e.completedTs !== null && e.completedTs > this.monitorStartTs)
        .sort((a, b) => a.queueNum - b.queueNum);
      for (const e of fresh) this.recordCompletion(e.id, e.status);
      return;
    }
    const unseen = ids
      .filter((id) => !this.historySeen.has(id))
      .map((id) => this.parseHistoryEntry(id, h[id]))
      // Oldest-first by ComfyUI's monotonic queue number, so the burst replays
      // in true order and lastCompleted lands on the genuinely newest run.
      .sort((a, b) => a.queueNum - b.queueNum);
    // Saturated window: EVERY entry of a full tail is new since the last
    // successful diff — completions may have scrolled past unobserved. Say so
    // instead of silently claiming full coverage.
    if (unseen.length >= HISTORY_TAIL_ITEMS && unseen.length === ids.length) {
      logger.warn(
        `[queue-monitor] history tail saturated (${unseen.length} new entries in one diff) — some run completions may have been missed between polls`,
      );
    }
    for (const e of unseen) this.recordCompletion(e.id, e.status);
    this.historySeen = new Set(ids);
    // A tracked run that left /queue this tick may already have been in the
    // tail (in-progress). The unseen diff would miss it; record the terminal
    // status now so an interrupt is not held until the next prompt (#2512).
    const vanished = this.vanishedPromptId;
    this.vanishedPromptId = null;
    if (vanished && h[vanished] && !this.completedReported.has(vanished)) {
      const terminal = this.terminalHistoryStatus(h[vanished]);
      if (terminal) this.recordCompletion(vanished, terminal);
    }
  }

  /** Fail-closed: only a proven finish (interrupt / error / completed success). */
  private terminalHistoryStatus(raw: unknown): CompletionStatus | null {
    if (!raw || typeof raw !== "object") return null;
    const st = (raw as { status?: unknown }).status;
    if (!st || typeof st !== "object") return null;
    const status = st as { status_str?: unknown; completed?: unknown; messages?: unknown };
    const messages = Array.isArray(status.messages) ? status.messages : [];
    const has = (type: string) => messages.some((m) => Array.isArray(m) && m[0] === type);
    if (has("execution_interrupted")) return "interrupted";
    if (has("execution_error") || status.status_str === "error") return "error";
    if (status.completed === true || status.status_str === "success") return "success";
    return null;
  }

  /** Cheap snapshot for backpressure (panel_run) and the live `queue_status`
   *  broadcast (queue-status-broadcast.ts): is anything in flight, and where? */
  snapshot(): QueueSnapshot {
    return {
      connected: this.state.connected,
      running: this.state.runningPromptId !== null,
      runningPromptId: this.state.runningPromptId,
      queueDepth: Math.max(0, this.state.queueRemaining),
      currentNode: this.state.currentNode,
      progressValue: this.state.progressValue,
      progressMax: this.state.progressMax,
      lastCompleted: this.state.lastCompleted,
      selfAttributed: this.isSelfAttributed(),
      selfAttributedProven: this.isSelfAttributedProven(),
      lastServerContactTs: this.lastServerContactTs(),
    };
  }

  /** #2684 — newest of the two liveness heartbeats, null when the monitored
   *  server has never answered here. Shared with `report()` so the busy notes
   *  and the STALLED notice cannot disagree about whether the server is alive. */
  private lastServerContactTs(): number | null {
    const ts = Math.max(this.state.lastServerAliveTs ?? 0, this.state.lastFrameTs ?? 0);
    return ts > 0 ? ts : null;
  }

  /** Stall/backlog report for the turn-start injector. */
  report(stallMs: number): StallReport {
    const running = this.state.runningPromptId !== null;
    const now = Date.now();
    const queueDepth = Math.max(running ? 1 : 0, this.state.queueRemaining);
    const idleFor = running && this.state.lastActivityTs ? now - this.state.lastActivityTs : 0;
    // LIVENESS GATE (#183): a legitimately long node emits NO forward progress
    // for minutes (tiled VAE decode, audio/video sampling, a big model load), so
    // "no progress for N seconds" alone false-flagged healthy renders. A job is
    // only stalled when the server has ALSO gone dark HERE — no ws frame and no
    // successful /queue poll within the window. A reachable ComfyUI keeps the
    // 1 Hz poll fresh, so a busy decode stays live and is NOT flagged; a server
    // that stops answering (crashed / event-loop wedged) lets the heartbeat
    // lapse → a real stall still surfaces.
    const heartbeatTs = this.lastServerContactTs();
    const serverAlive = heartbeatTs !== null && now - heartbeatTs < stallMs;
    // Backstop so a genuine in-node DEADLOCK on a still-reachable server isn't
    // suppressed FOREVER: after a long hard floor of zero forward progress, flag
    // regardless of liveness. A real deadlock usually holds Python's GIL, which
    // also freezes ComfyUI's own HTTP handler → the /queue heartbeat lapses and
    // `serverAlive` catches it at stallMs without this floor; the floor only
    // covers the rarer non-GIL wedge (a node stuck in a network/IO wait) that
    // keeps HTTP alive.
    //
    // TRAINING EXEMPTION (#1652): a run whose CURRENT node is a known trainer —
    // or, when the current node is unknown here (the reported case: attaching
    // mid-run sees no progress_state transition, so currentNode stays null for
    // the whole training), whose GRAPH contains one — legitimately sits silent
    // for HOURS, so the floor must not override liveness for it: while the
    // server keeps answering, it is not stalled. The tradeoff, stated plainly:
    // a genuinely wedged trainer on a still-reachable server is no longer
    // hard-flagged — but a GIL-holding deadlock freezes ComfyUI's HTTP too, and
    // `serverAlive` catches that at stallMs regardless of node class. When the
    // graph was never captured (poll never succeeded), nothing is exempt and
    // the floor applies exactly as before.
    const types = this.state.runningNodeClassTypes;
    const currentType = this.state.currentNode !== null ? types[this.state.currentNode] : undefined;
    const trainingRun =
      currentType !== undefined
        ? TRAINING_NODE_CLASS_TYPES.has(currentType)
        : Object.values(types).some((t) => TRAINING_NODE_CLASS_TYPES.has(t));
    const hardStalled = running && !trainingRun && idleFor >= Math.max(stallMs, HARD_STALL_FLOOR_MS);
    const stalled = running && idleFor >= stallMs && (!serverAlive || hardStalled);
    const progress =
      this.state.progressValue !== null && this.state.progressMax !== null
        ? `${this.state.progressValue}/${this.state.progressMax}`
        : null;
    return {
      stalled,
      backlog: queueDepth > 1,
      selfAttributed: this.isSelfAttributed(),
      foreignVisible: this.isForeignVisible(),
      runningPromptId: this.state.runningPromptId,
      currentNode: this.state.currentNode,
      queueDepth,
      stalledForMs: stalled ? idleFor : 0,
      progress,
    };
  }
}

/** Process-wide singleton (one ComfyUI per orchestrator). */
export const QueueMonitor = new QueueMonitorImpl();
