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

import WebSocket from "ws";
import { logger } from "../utils/logger.js";
import { getComfyUIAuthHeaders } from "../config.js";
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
// legitimate single-node runtime (a long tiled VAE decode / video sample is
// minutes, not half an hour), so it never trips on a healthy render.
const HARD_STALL_FLOOR_MS = 30 * 60 * 1000; // 30 minutes

class QueueMonitorImpl {
  private ws: WebSocket | null = null;
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
   *  not ours. */
  private isSelfAttributed(): boolean {
    const inFlight: string[] = [];
    if (this.state.runningPromptId) inFlight.push(this.state.runningPromptId);
    inFlight.push(...this.state.pendingPromptIds);
    const recentSelfQueue =
      this.lastSelfQueueTs != null && Date.now() - this.lastSelfQueueTs < SELF_QUEUE_WINDOW_MS;

    if (this.selfQueuedIds.size > 0 && inFlight.length > 0) {
      // We receive a prompt id for every job we queue, so any VISIBLE in-flight id
      // that isn't one of ours is definitively a foreign job → not our batch.
      if (inFlight.some((id) => !this.selfQueuedIds.has(id))) return false;
      // Every VISIBLE in-flight job is ours. The pending ids are poll-derived and can
      // lag a rapid burst of queues, so queueRemaining (updated live by status frames)
      // may exceed what we've captured. If the poll has fully accounted for the depth,
      // the whole queue is provably ours; if some items aren't captured yet, only
      // treat them as ours when we self-queued recently (the reported case — queuing a
      // batch faster than the 1 Hz poll). A stale unseen item with NO recent self-queue
      // is treated as possibly-foreign so the warning still fires.
      const depth = Math.max(inFlight.length, Math.max(0, this.state.queueRemaining));
      if (inFlight.length >= depth) return true;
      return recentSelfQueue;
    }
    // No ids to match against (the panel never surfaced one) or nothing identifiable
    // in flight yet → fall back to the coarse recent-self-queue timestamp.
    return recentSelfQueue;
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
    const inFlight: string[] = [];
    if (this.state.runningPromptId) inFlight.push(this.state.runningPromptId);
    inFlight.push(...this.state.pendingPromptIds);
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
    let ws: WebSocket;
    try {
      // Ride the same auth as HTTP (COMFYUI_AUTH_* + Cloudflare Access service
      // token) on the WS handshake, so the watchdog reaches a ComfyUI behind a
      // proxy / CF Access. undefined when unauth'd → identical to `new WebSocket(url)`.
      const authHeaders = getComfyUIAuthHeaders();
      ws = new WebSocket(
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
    ws.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
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
    } else if (running.length === 0 && this.state.runningPromptId !== null) {
      // Empty queue → the tracked run is over. Skip the clear if a run was
      // adopted AFTER this fetch began (the response would be stale for it).
      if ((this.state.lastActivityTs ?? 0) <= fetchStart) {
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
    let status: CompletionStatus;
    if (st?.completed === true || st?.status_str === "success" || st === undefined) {
      status = "success";
    } else if (messages.some((m) => Array.isArray(m) && m[0] === "execution_interrupted")) {
      status = "interrupted";
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
    };
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
    const heartbeatTs = Math.max(this.state.lastServerAliveTs ?? 0, this.state.lastFrameTs ?? 0);
    const serverAlive = heartbeatTs > 0 && now - heartbeatTs < stallMs;
    // Backstop so a genuine in-node DEADLOCK on a still-reachable server isn't
    // suppressed FOREVER: after a long hard floor of zero forward progress, flag
    // regardless of liveness. A real deadlock usually holds Python's GIL, which
    // also freezes ComfyUI's own HTTP handler → the /queue heartbeat lapses and
    // `serverAlive` catches it at stallMs without this floor; the floor only
    // covers the rarer non-GIL wedge (a node stuck in a network/IO wait) that
    // keeps HTTP alive. The floor is a deliberate finite tradeoff: a healthy but
    // progress-silent node exceeding it is re-flagged (unavoidable — "busy" and
    // "wedged" are indistinguishable from outside past some horizon), so it is
    // set far beyond any legitimate single-node runtime.
    const hardStalled = running && idleFor >= Math.max(stallMs, HARD_STALL_FLOOR_MS);
    const stalled = running && idleFor >= stallMs && (!serverAlive || hardStalled);
    const progress =
      this.state.progressValue !== null && this.state.progressMax !== null
        ? `${this.state.progressValue}/${this.state.progressMax}`
        : null;
    return {
      stalled,
      backlog: queueDepth > 1,
      selfAttributed: this.isSelfAttributed(),
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
