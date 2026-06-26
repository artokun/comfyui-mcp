// Panel agent — one persistent Claude Agent SDK streaming session per ComfyUI
// panel tab. This is the autonomous background driver for the sidebar panel: the
// orchestrator (src/orchestrator/index.ts) owns the UI bridge and feeds each
// tab's user messages into that tab's session here; the agent's replies flow
// back out to the panel chat.
//
// Why the Agent SDK (not --sdk-url / CCR-v2): we need a persistent background
// agent with a live "channel in" (push messages over time), interrupt/inject,
// and SUBSCRIPTION auth with no API key — without patching the claude binary.
// `query({ prompt: <async generator> })` is exactly that: the generator stays
// open (the channel in), `Query.interrupt()` stops a live turn, and with
// ANTHROPIC_API_KEY unset the SDK reads the on-disk claude.ai OAuth login
// (verified: the session reports apiKeySource=none on this machine).
//
// The spawned agent runs THIS comfyui-mcp build as its MCP server in normal
// mode, so it talks to the live ComfyUI over COMFYUI_URL and never contends for
// the bridge port the orchestrator owns.

import type {
  Options,
  ModelInfo,
  SlashCommand,
  McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../utils/logger.js";
import type { SessionStore } from "./session-store.js";
import type { AgentBackend, AgentEvent, NeutralTurn } from "./agent-backend.js";
import {
  ClaudeBackend,
  fetchSupportedModels,
  fetchSupportedCommands,
} from "./claude-backend.js";

export type { ModelInfo, SlashCommand };
// The provider-specific Claude probes live in claude-backend.ts now; re-export
// them so the orchestrator (index.ts) keeps importing them from here.
export { fetchSupportedModels, fetchSupportedCommands };

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Idle window for the per-turn freeze watchdog: if a turn that's in flight
 *  receives NO events at all for this long, treat it as stalled. Generous (legit
 *  tool work is slow but still streams progress) and overridable for tests via
 *  COMFYUI_MCP_TURN_IDLE_MS. Default 3.5 min. */
const TURN_IDLE_MS = Number(process.env.COMFYUI_MCP_TURN_IDLE_MS) || 210_000;

/** Reasoning effort levels. This is the PROVIDER-NEUTRAL union of every backend's
 *  scale so a value chosen for one provider survives a switch to another:
 *    • Claude scale: low | medium | high | xhigh | max
 *    • Codex scale:  none | minimal | low | medium | high | xhigh
 *  The shared levels (low/medium/high/xhigh) map 1:1; the off-scale ones (Claude
 *  "max", Codex "none"/"minimal") are mapped to the nearest valid level by the
 *  TARGET backend (ClaudeBackend / CodexBackend), so PanelAgent stores the user's
 *  intent verbatim and never has to drop it on a provider switch. */
export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
/** The full neutral set, ordered low→high (for nearest-level mapping). */
export const EFFORTS: Effort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
export function isEffort(v: unknown): v is Effort {
  return typeof v === "string" && (EFFORTS as string[]).includes(v);
}

/** A turn-usage snapshot pushed to the panel for the context/usage meter. */
export interface UsageStatus {
  /** Fraction of the context window in use after the turn (0..1), if known. */
  contextPct?: number;
  /** Approximate tokens occupying the context window after the turn. */
  used?: number;
  /** Model's total context window size, if reported. */
  contextWindow?: number;
  /** Model id that served the turn. */
  model?: string;
  /** Cumulative session cost in USD, if reported. */
  costUsd?: number;
}

/** A live streaming delta for the panel — incremental thinking/reply text as the
 *  model produces it (from SDKPartialAssistantMessage stream events). `id` is the
 *  SDK message id, so the frontend groups deltas into one bubble and the final
 *  authoritative `say` (carrying the same id) replaces the streamed preview. */
export interface StreamDelta {
  /** "think" = extended-thinking text, "text" = reply text, "end" = message done. */
  phase: "think" | "text" | "end";
  /** SDK message id grouping all deltas of one assistant message. */
  id: string;
  /** The incremental text chunk (absent for phase "end"). */
  delta?: string;
}

/** Optional metadata attached to a committed `onSay` so the frontend can reconcile
 *  it with a live streaming bubble (same `id`) instead of duplicating it. */
export interface SayMeta {
  /** SDK message id — matches the StreamDelta.id of the live preview, if any. */
  id?: string;
  /** True when this text was already streamed via onStream (so the bubble exists). */
  streamed?: boolean;
}

/** A ComfyUI image reference the panel sends so the orchestrator can fetch the
 *  bytes from /view and deliver them to the agent as an inline image block —
 *  saving the agent a fetch round-trip. */
export interface ImageRef {
  filename: string;
  subfolder?: string;
  type?: string; // "input" | "output" | "temp" (ComfyUI /view folder)
}

export interface PanelAgentDeps {
  /** mcpServers config for the spawned agent (the comfyui MCP). */
  mcpServers: Options["mcpServers"];
  /** Base URL of the ComfyUI instance, for fetching image bytes (/view). */
  comfyuiUrl?: string;
  /** Persona appended to the claude_code system-prompt preset. */
  systemAppend: string;
  /** Pinned model (e.g. claude-opus-4-8). */
  model: string;
  /** Reasoning effort for the session (low..max). Omitted = SDK default. */
  effort?: Effort;
  /** Route the agent's words into the panel chat for this tab. `meta.id` lets the
   *  frontend reconcile a committed message with its live streaming preview. */
  onSay: (tabId: string, text: string, meta?: SayMeta) => void;
  /** Live incremental thinking/reply text as the model streams (optional). */
  onStream?: (tabId: string, ev: StreamDelta) => void;
  /** Report per-turn usage (context meter) for this tab. */
  onStatus?: (tabId: string, status: UsageStatus) => void;
  /** Report the SDK session id once known, so the panel can persist/resume it. */
  onSession?: (tabId: string, sessionId: string) => void;
  /** Report each turn's ending assistant-message UUID — the anchor the panel
   *  stores so a later "rewind conversation to here" can fork the session at that
   *  point (resumeSessionAt + forkSession). */
  onTurnAnchor?: (tabId: string, uuid: string) => void;
  /** Report turn lifecycle so the panel shows a "working" indicator that stays
   *  up through silent tool work and clears when the turn ends. */
  onTurn?: (tabId: string, state: "working" | "done") => void;
  /** Live extended-thinking token count, for a "thinking… (N)" indicator. */
  onThinking?: (tabId: string, tokens: number) => void;
  /** Fired when the agent DEQUEUES a message and starts processing it (the true
   *  "read" moment) — carries the client mid so the panel can flip that bubble
   *  from queued/muted to read. */
  onSeen?: (tabId: string, mid: string) => void;
  /** In-process MCP server giving the agent LIVE control of this tab's graph. */
  panelServer?: McpSdkServerConfigWithInstance;
  /**
   * Absolute path to the bundled comfyui-mcp plugin dir. When set, its skills
   * (IDEOGRAM/WAN/LTX/etc. expertise) are loaded into the agent so it's an
   * expert out of the box. Omitted if the plugin can't be found.
   */
  pluginPath?: string;
}

/**
 * One persistent streaming session for a single panel tab. Messages typed in
 * the panel are queued via `send()` and yielded into the live `query()` session
 * as user turns; the session never closes until `stop()`.
 */
export class PanelAgent {
  readonly tabId: string;
  private deps: PanelAgentDeps;
  /** The injected provider adapter (Claude today). PanelAgent owns the queue,
   *  turn-gate, rewind tracking and self-restart; the backend owns the SDK call,
   *  option building, and SDKMessage→AgentEvent normalization. */
  private backend: AgentBackend;
  private queue: Array<{ text: string; images?: ImageRef[]; mid?: string }> = [];
  private waiting: (() => void) | null = null;
  private closed = false;
  /** The user message(s) of the turn currently in flight — captured at dispatch so
   *  an INTERRUPT (panel "send now") can RE-QUEUE the interrupted text ahead of the
   *  new message, instead of dropping the work the agent was mid-reply on. Cleared
   *  on a clean turn result (nothing to re-queue) and on stall/rewind (abandoned on
   *  purpose). Null whenever no turn is in flight. */
  private inFlight: { text: string; images?: ImageRef[] } | null = null;
  /** True while a turn is in flight (working→done). Lets the manager defer a
   *  session-restarting option change (effort) until the turn finishes, instead
   *  of interrupting and silently dropping the in-flight reply. */
  private busy = false;
  // ---- turn idle watchdog (freeze safety net) ----
  // A stalled turn (the backend stops emitting ANY events — e.g. a wedged Codex
  // app-server) would otherwise leave the panel "working" forever. This is an
  // IDLE timer (reset on every received event), NOT a hard turn cap: legit tool
  // work is slow but still streams progress/tool events, so only a TRUE stall
  // (no events at all for the whole window) trips it. On trip we surface a clear
  // terminal error, advance the turn-gate (so the next queued batch runs), and
  // best-effort interrupt the backend. Composes with the backend's own terminal
  // result: completeTurn() is capped at yieldedTurns, so a late real result after
  // a trip can't double-advance the gate.
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guards against a trip firing twice / racing a real result for one turn. */
  private idleTripped = false;
  // ---- turn gate (race-free) ----
  // The channel releases ONE batch per turn so the SDK can't read ahead (which
  // prematurely "read" queued messages and lost them on interrupt). Implemented
  // with MONOTONIC COUNTERS, not a resolver: after yielding batch N the channel
  // waits until completedTurns >= yieldedTurns. This is deadlock-proof — if the
  // turn's result fires BEFORE the channel parks, the counter has already caught
  // up and the channel never blocks (the resolver version deadlocked on that
  // race, stranding every later message).
  private yieldedTurns = 0;
  private completedTurns = 0;
  private turnWaiter: (() => void) | null = null;
  /** Mutable so the model/effort picker can change them at runtime. */
  private model: string;
  private effort?: Effort;
  /** UUID of the last assistant message seen — reported as the turn anchor on
   *  result, and used as the resume point when forking (rewind). */
  private lastAssistantUuid: string | null = null;
  /** Set by requestRewind() to fork the session on the next (re)start. `anchor`
   *  is the assistant UUID to resume up to (drop everything after); null = fresh. */
  private pendingRewind: { anchor: string | null } | null = null;
  /** Captured from the session's init message; enables resume across restarts. */
  sessionId: string | null = null;
  /** Id of the assistant message currently streaming (from message_start), so
   *  stream deltas and the final committed `say` share one bubble id. */
  private streamMsgId: string | null = null;
  title: string | undefined;
  /** Usage from the most recent assistant API response — the CURRENT context
   *  size (input + cache), as opposed to result.usage which sums every internal
   *  call in the turn and wildly overstates context fill. */
  private lastUsage: Record<string, number> | null = null;
  /** Context window for the active model, cached from result.modelUsage. */
  private contextWindow = 0;
  /** Last status pushed — re-sent on reconnect so the meter isn't blank. */
  lastStatus: UsageStatus | null = null;
  /** Set true when start()'s bounded self-restart loop GAVE UP (the session kept
   *  dropping immediately) — as opposed to an intentional stop(). The manager
   *  reads this to distinguish a fatal "agent backend is dead" settle (which must
   *  bubble up so the orchestrator can self-exit + let the pack respawn a clean
   *  one) from an ordinary retire. */
  gaveUp = false;

  constructor(tabId: string, deps: PanelAgentDeps, backend?: AgentBackend) {
    this.tabId = tabId;
    this.deps = deps;
    this.model = deps.model;
    this.effort = deps.effort;
    // Default to the Claude adapter; injectable so a future toggle can swap it.
    this.backend =
      backend ??
      new ClaudeBackend({
        mcpServers: deps.mcpServers,
        comfyuiUrl: deps.comfyuiUrl,
        systemAppend: deps.systemAppend,
        panelServer: deps.panelServer,
        pluginPath: deps.pluginPath,
      });
  }

  private short(): string {
    return this.tabId.slice(0, 8);
  }

  /** Queue a panel message and wake the streaming generator (the "channel in").
   *  `images` are ComfyUI refs delivered inline as image blocks (vision). */
  send(text: string, opts?: { title?: string; images?: ImageRef[]; mid?: string }): void {
    if (opts?.title) this.title = opts.title;
    this.queue.push({ text, images: opts?.images, mid: opts?.mid });
    const wake = this.waiting;
    this.waiting = null;
    wake?.();
  }

  /** Rewind the CONVERSATION: fork the session at `anchor` (an assistant UUID
   *  reported via onTurnAnchor) so everything after it is dropped from the agent's
   *  memory, then restart. `anchor` null forks to a fresh session. The edited
   *  message arrives separately as the next user_message (queued + drained by the
   *  forked channel). The graph (code) scope is handled panel-side. */
  requestRewind(anchor: string | null): void {
    this.pendingRewind = { anchor };
    if (anchor === null) this.sessionId = null; // fresh fork → don't resume
    // A rewind deliberately DROPS everything after the anchor (the edited message
    // arrives separately), so the interrupted turn's text must NOT be re-queued.
    this.inFlight = null;
    // Break the current stream so start()'s loop re-enters and forks.
    void this.backend.interrupt().catch(() => {});
    const wake = this.waiting;
    this.waiting = null;
    wake?.();
  }

  /** Drop a still-queued message (the user cancelled/edited it before the agent
   *  got to it). Returns true if it was found and removed; false if it was
   *  already dequeued (the turn started — too late to cancel). */
  cancelQueued(mid: string): boolean {
    const i = this.queue.findIndex((item) => item.mid === mid);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    return true;
  }

  /** Reorder still-queued messages to match the panel's desired flush order.
   *  `order` is a list of mids; queued items are sorted by their index in it
   *  (items not named keep their relative order, after the named ones). Only the
   *  not-yet-dequeued queue is touched — a turn already in flight is unaffected. */
  reorderQueue(order: string[]): void {
    if (!Array.isArray(order) || this.queue.length < 2) return;
    const rank = new Map(order.map((mid, i) => [mid, i]));
    const at = (mid?: string) => (mid && rank.has(mid) ? rank.get(mid)! : Number.MAX_SAFE_INTEGER);
    // Stable sort by desired rank (JS Array.sort is stable), so unnamed items
    // keep their relative order and trail the explicitly-ordered ones.
    this.queue.sort((a, b) => at(a.mid) - at(b.mid));
  }

  /**
   * Inject a ComfyUI execution event (run finished / errored) as a turn, so the
   * agent learns its render landed and can comment — solving "the asset never
   * reached the agent." Only meaningful when a session is live (the manager only
   * calls this for an existing agent, so we never spawn one just for an event).
   */
  injectEvent(ev: { kind?: string; images?: ImageRef[]; error?: string; note?: string }): void {
    let text: string | null = null;
    let images: ImageRef[] | undefined;
    if (ev.kind === "executed") {
      const imgs = ev.images ?? [];
      const names = imgs.map((i) => i.filename).filter(Boolean).join(", ") || "(unnamed)";
      // A custom `note` (e.g. the panel's video-storyboard summary) replaces the
      // default image-acknowledgement wording so the agent is told accurately
      // what it's looking at (a contact sheet of a video, not a still image).
      const note = typeof ev.note === "string" && ev.note.trim() ? ev.note.trim() : null;
      text =
        `[panel event] ` +
        (note
          ? `${note} `
          : `A run on the user's canvas just finished and produced ${imgs.length} output image(s): ${names}. `) +
        // Only claim images are attached when some actually are (a note-only event —
        // e.g. a video that produced no storyboard — has none).
        (imgs.length ? `The image(s) are attached below and already shown to the user in the panel. ` : ``) +
        `Reply with ONE short sentence acknowledging the result and suggesting a sensible next step — you do NOT need to call any tools. Don't repeat an earlier comment.`;
      // Attach the outputs inline so the agent SEES the render (no fetch needed).
      images = imgs.filter((i) => i.filename).map((i) => ({ ...i, type: i.type ?? "output" }));
    } else if (ev.kind === "run_error") {
      text =
        `[panel event] The user's workflow run just ERRORED: ${ev.error ?? "unknown error"}. ` +
        `If it relates to what you were doing, diagnose it (panel_get_errors has the details) and offer a fix.`;
    }
    if (!text) return;
    this.busy = true;
    this.deps.onTurn?.(this.tabId, "working"); // event triggers a turn — show working
    this.queue.push({ text, images });
    const wake = this.waiting;
    this.waiting = null;
    wake?.();
  }

  /** Push a ComfyUI EXECUTION error into the session with urgency — the "hey,
   *  look at me" path. Renders fail ASYNC (minutes after the agent queued them via
   *  panel_run), so without this the agent never learns and carries on as if the
   *  run succeeded. INTERRUPT any live turn (re-queued so it resumes AFTER the
   *  error), then put the error at the FRONT of the queue so the agent addresses
   *  it before anything else. */
  async injectRunError(error: string): Promise<void> {
    if (this.closed) return;
    const text =
      `[panel event] ⚠️ The workflow run you just queued ERRORED on the user's canvas: ${error}. ` +
      `STOP — do not carry on as if it succeeded. If it relates to what you were doing, diagnose it ` +
      `(panel_get_errors has the full node-level details) and fix it; otherwise tell the user briefly.`;
    if (this.inFlight) {
      // Stop the live turn and re-queue it so the agent handles the error FIRST,
      // then resumes whatever it was doing.
      await this.interrupt({ requeueInFlight: true });
    }
    this.busy = true;
    this.deps.onTurn?.(this.tabId, "working");
    this.queue.unshift({ text }); // front: ahead of any re-queued interrupted turn
    const wake = this.waiting;
    this.waiting = null;
    wake?.();
  }

  /** Switch the model live (the SDK applies it to the next turn). */
  async setModel(model: string): Promise<void> {
    if (model === this.model) return;
    this.model = model;
    try {
      // setModel is live: no session restart, the next turn uses it.
      await this.backend.setModel?.(model);
      logger.info(`[panel-agent ${this.short()}] model → ${model}`);
    } catch (err) {
      logger.debug(`[panel-agent ${this.short()}] setModel: ${msgOf(err)}`);
    }
  }

  /**
   * Record a new effort. The SDK takes effort as a session option, so this only
   * affects the live session if the caller restarts it (the manager recreates
   * the agent with resume so the conversation continues). Returns true if it
   * changed.
   */
  setEffortPending(effort: Effort | undefined): boolean {
    if (effort === this.effort) return false;
    this.effort = effort;
    return true;
  }

  /** True once stop() was called — distinguishes an intentional shutdown from
   *  an SDK session that ended on its own (so the manager can self-heal). */
  get isStopped(): boolean {
    return this.closed;
  }

  /** True while a turn is actively running (between working and done). */
  get isBusy(): boolean {
    return this.busy;
  }
  /** True when messages are queued but not yet consumed (a turn is about to
   *  start). The manager waits for both !busy and !hasPending before a restart. */
  get hasPending(): boolean {
    return this.queue.length > 0;
  }
  /** Remove and return any unsent queued messages — so a session restart can hand
   *  them to the replacement agent instead of dropping them. */
  takePending(): Array<{ text: string; images?: ImageRef[] }> {
    const items = this.queue;
    this.queue = [];
    return items;
  }

  get currentModel(): string {
    return this.model;
  }
  get currentEffort(): Effort | undefined {
    return this.effort;
  }

  /** Stop the current turn without ending the session (a "stop" button, or the
   *  panel "send now" which interrupts then sends). The turn ends → release the
   *  next queued message so an interrupt ADVANCES to the next pending turn (and
   *  only stops cold when nothing is queued).
   *
   *  SEND-NOW PARITY: an interrupt mid-reply was DROPPING the message the agent
   *  was working on (only the new "send now" message got answered). So if a turn
   *  is in flight when we interrupt, RE-QUEUE its user text at the FRONT of the
   *  queue. The new message (sent right after the interrupt) lands behind it, so
   *  the next turn drains BOTH into one batch — interrupted-first — and the agent
   *  addresses both. Cleared so a later clean result can't re-queue it again. */
  async interrupt(opts: { requeueInFlight?: boolean } = {}): Promise<void> {
    // Capture + clear BEFORE the async backend call so a result racing in can't
    // both clear it and have us re-queue a stale copy.
    const interrupted = this.inFlight;
    this.inFlight = null;
    // Re-queue the interrupted turn ONLY for "send now" (requeueInFlight) — there
    // the user wants BOTH the interrupted message and the new one answered. A plain
    // Stop / Ctrl+C / Esc (requeueInFlight=false) must NOT re-queue, or it would
    // silently re-run the turn the user just stopped (double tool actions).
    if (interrupted && opts.requeueInFlight) {
      // Front of the queue: the interrupted work is addressed before whatever the
      // user sends next (which is appended after this interrupt is handled).
      this.queue.unshift({ text: interrupted.text, images: interrupted.images });
    }
    try {
      await this.backend.interrupt();
    } catch (err) {
      logger.debug(`[panel-agent ${this.short()}] interrupt: ${msgOf(err)}`);
    } finally {
      this.releaseTurns();
    }
  }

  /** End the session and release the agent (tab closed / orchestrator shutdown). */
  async stop(): Promise<void> {
    this.closed = true;
    this.inFlight = null; // teardown must not leave a turn that could be re-queued
    this.clearIdleWatchdog(); // don't let a turn watchdog fire after teardown
    const wake = this.waiting;
    this.waiting = null;
    wake?.(); // let the generator observe `closed` and return
    this.releaseTurns(); // and unblock it if it's parked at the turn gate
    try {
      await this.backend.interrupt();
    } catch {
      // already winding down
    }
    // Permanently dispose of the backend's resources (kill any child process
    // tree, drop the live connection). interrupt() alone is a no-op when idle, so
    // a backend that owns a child process (Codex app-server) would otherwise be
    // orphaned across stop/reset/effort-restart/stopAll/shutdown. Idempotent.
    try {
      await this.backend.close?.();
    } catch {
      // best-effort teardown
    }
  }

  /** A turn finished (result) → let the channel release the next batch. Capped at
   *  yieldedTurns so an interrupt + a late result for the same turn can't double-
   *  count and let the gate run ahead. */
  private completeTurn(): void {
    this.completedTurns = Math.min(this.completedTurns + 1, this.yieldedTurns);
    const w = this.turnWaiter;
    this.turnWaiter = null;
    w?.();
  }

  /** Force the gate open regardless of results (interrupt / shutdown) so an
   *  interrupt advances to the next pending batch instead of stopping cold. */
  private releaseTurns(): void {
    this.completedTurns = this.yieldedTurns;
    const w = this.turnWaiter;
    this.turnWaiter = null;
    w?.();
  }

  // The streaming "channel in": an async generator that stays open and yields a
  // user turn whenever the panel sends one. The session idles between messages
  // and wakes the moment send() pushes — solving "can't wake an idle session".
  // ONE batch is released per turn (counter gate) so the backend can't read ahead.
  // Yields PROVIDER-NEUTRAL turns ({text, images}); the backend shapes them into
  // its native user message (Claude resolves the image refs to inline blocks).
  private async *channel(): AsyncGenerator<NeutralTurn> {
    while (!this.closed) {
      if (this.queue.length === 0) {
        // Idle & settled (we only reach here after the prior turn's gate opened):
        // reset the counters to 0. Keeps them small and SELF-HEALS any drift a
        // post-interrupt stray result may have introduced during a busy burst.
        this.yieldedTurns = 0;
        this.completedTurns = 0;
        await new Promise<void>((resolve) => {
          this.waiting = resolve;
        });
      }
      if (this.closed) return;
      // Drain the WHOLE queue into ONE turn — rapid-fire follow-ups are handled
      // together (I see them all and reply once) rather than one-per-turn. Each
      // message is now actually being taken off the queue: fire onSeen for every
      // mid so all their bubbles flip from queued/muted to read at once.
      const batch = this.queue.splice(0, this.queue.length);
      if (batch.length === 0) continue;
      for (const it of batch) {
        if (it.mid) this.deps.onSeen?.(this.tabId, it.mid);
      }
      const text = batch.map((it) => it.text).join("\n\n");
      const images = batch.flatMap((it) => it.images ?? []);
      if (this.closed) return;
      // Remember the in-flight turn's user text so an interrupt mid-reply can
      // re-queue it (send-now must address BOTH the interrupted and new message).
      this.inFlight = { text, ...(images.length ? { images } : {}) };
      this.yieldedTurns += 1; // this batch is turn N
      // Mark the turn in flight AT DISPATCH (not on the first event). Without this
      // the watchdog's `busy` guard would be false for the exact zero-event freeze
      // it's meant to catch, so onTurnStalled() would no-op. (handleEvent's later
      // `busy = true` becomes a harmless no-op.) Also shows "working" immediately.
      this.busy = true;
      this.deps.onTurn?.(this.tabId, "working");
      // Arm the freeze watchdog AT DISPATCH: a turn that produces NO events at all
      // (the exact ROOT CAUSE B freeze — turn/start sent, no notifications ever
      // returned) never reaches handleEvent, so arming here is what catches it.
      // Subsequent events re-arm it (handleEvent → bumpIdleWatchdog); a clean
      // result disarms it.
      this.bumpIdleWatchdog();
      yield { text, ...(images.length ? { images } : {}) };
      // Hold the next batch until THIS turn completes. Race-free: if the result
      // already fired (completedTurns caught up) we don't park at all, so the
      // channel can never deadlock and strand later messages.
      while (!this.closed && this.completedTurns < this.yieldedTurns) {
        await new Promise<void>((resolve) => {
          this.turnWaiter = resolve;
        });
      }
    }
  }

  /**
   * Run the persistent session, SELF-RESTARTING when the SDK session ends on its
   * own (idle/error). The input queue (`this.queue`) and `sessionId` survive
   * across restarts, so pending messages aren't lost and context resumes — this
   * is the durable fix for the "connected but dead" wedge (previously a session
   * that ended left a dead agent and every later message queued into a channel
   * that was never read). Resolves only on stop() or after repeated immediate
   * failures (gives up + tells the user). Safe to call once.
   */
  async start(resumeSessionId?: string): Promise<void> {
    let quickRestarts = 0;
    // Preflight the backend (e.g. lazy-load the optional SDK) OUTSIDE the restart
    // loop so a HARD startup failure (missing dependency, bad runtime) surfaces
    // immediately as a clear reject — instead of being caught as a "dropped
    // session", retried four times, and reported as "session keeps ending".
    await this.backend.prepare?.();
    while (!this.closed) {
      // A pending rewind (one-shot) forks the session at its anchor; otherwise
      // resume normally.
      const rewind = this.pendingRewind;
      this.pendingRewind = null;
      // A fresh fork (anchor === null) must NOT resume anything — not even the
      // resumeSessionId start() was called with — or it silently continues the old
      // session instead of starting clean. (requestRewind(null) clears sessionId;
      // this also suppresses the resumeSessionId fallback.)
      const resume = rewind?.anchor === null ? undefined : (this.sessionId ?? resumeSessionId);
      const startedAt = Date.now();
      // Fresh channel → reset the turn-gate counters so a restart/resume never
      // inherits a stale offset that would mis-gate the first batch.
      this.yieldedTurns = 0;
      this.completedTurns = 0;
      this.turnWaiter = null;
      // Drop the prior session's last assistant UUID so a fork can't report a
      // stale (pre-fork) anchor for the first turn of the new session.
      this.lastAssistantUuid = null;
      // A fresh channel won't have an in-flight turn — clear any stale capture so
      // a post-restart interrupt can't re-queue a dead session's message.
      this.inFlight = null;
      try {
        // Drive the injected backend: it builds the provider session (resume/fork),
        // shapes the neutral channel into native turns, and yields canonical events.
        for await (const ev of this.backend.run({
          channel: this.channel(),
          model: this.model,
          ...(this.effort ? { effort: this.effort } : {}),
          ...(resume ? { resume } : {}),
          sessionId: this.sessionId,
          rewindAnchor: rewind?.anchor ?? null,
          // LIVENESS: re-arm the freeze watchdog on ANY sign the backend is alive —
          // not just translated AgentEvents. A long Codex tool call (panel_run →
          // a multi-minute ComfyUI generation) emits raw app-server notifications
          // throughout but may translate to NO AgentEvents during the wait; without
          // this the watchdog would falsely trip on a HEALTHY generation and
          // interrupt the turn. handleEvent() still bumps on real events; this
          // covers the silent-but-working gap between them. A genuine zero-event
          // freeze fires neither path, so the real-stall catch is preserved.
          onActivity: () => this.bumpIdleWatchdog(),
        })) {
          this.handleEvent(ev);
        }
      } catch (err) {
        if (this.closed) break;
        logger.error(`[panel-agent ${this.short()}] stream error: ${msgOf(err)}`);
      }
      // Session ended (cleanly or via error) — disarm any armed watchdog so a stale
      // timer from the dead session can't fire into the restarted one. The gate
      // counters are reset at the top of the next iteration.
      this.clearIdleWatchdog();
      if (this.closed) break;
      // Session ended on its own — bound rapid failure loops so a persistently
      // broken SDK doesn't spin forever or black-hole each message.
      quickRestarts = Date.now() - startedAt < 5000 ? quickRestarts + 1 : 0;
      if (quickRestarts >= 4) {
        logger.error(`[panel-agent ${this.short()}] session keeps ending immediately — giving up`);
        this.sessionId = null; // don't resume a session that won't stay up
        // Flag the fatal give-up so the manager → orchestrator can self-exit and
        // let the pack respawn a clean orchestrator (root-cause fix for the
        // "bridge open but no panel agent responded" wedge: a live orchestrator
        // serving a permanently-dead agent). We DON'T onSay the old "Disconnect →
        // Connect" nudge here — the orchestrator is about to exit and the panel's
        // sticky reconnect respawns automatically.
        this.gaveUp = true;
        break;
      }
      logger.warn(
        `[panel-agent ${this.short()}] session ended — restarting${this.sessionId ? " (resume)" : ""}`,
      );
      await new Promise((r) => setTimeout(r, 250));
    }
    logger.info(`[panel-agent ${this.short()}] stopped`);
  }

  /** (Re)arm the per-turn idle watchdog. Called on every event received while a
   *  turn could be in flight, so the timer only fires after a FULL idle window
   *  with no events — a true stall. A no-op once a turn has already tripped (until
   *  the next turn re-arms via a fresh event after clearIdleWatchdog). */
  private bumpIdleWatchdog(): void {
    if (this.closed || this.idleTripped) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.onTurnStalled(), TURN_IDLE_MS);
    this.idleTimer.unref?.();
  }

  /** Disarm the idle watchdog (turn ended cleanly, or session restarting). */
  private clearIdleWatchdog(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.idleTripped = false;
  }

  /** The current turn produced NO events for the whole idle window → it's frozen.
   *  Surface a clear error, clear the "working" indicator, advance the turn-gate
   *  so the next queued batch can run, and best-effort interrupt the backend so a
   *  wedged child stops. Idempotent per turn via idleTripped; completeTurn() is
   *  capped at yieldedTurns so a late real result can't double-advance the gate. */
  private onTurnStalled(): void {
    if (this.closed || this.idleTripped || !this.busy) return;
    this.idleTripped = true;
    this.idleTimer = null;
    logger.error(
      `[panel-agent ${this.short()}] turn stalled — no events for ${Math.round(TURN_IDLE_MS / 1000)}s; surfacing error and releasing the gate`,
    );
    this.deps.onSay(
      this.tabId,
      "⚠️ The agent stopped responding (the turn stalled with no activity). I've cleared it — please try again.",
    );
    this.busy = false;
    // The stalled turn is abandoned + surfaced as an error — don't re-queue its
    // text (a wedged message could otherwise loop on every interrupt).
    this.inFlight = null;
    this.completeTurn(); // release the next queued batch instead of hanging
    this.deps.onTurn?.(this.tabId, "done");
    // Best-effort: stop the wedged turn so the backend doesn't keep a dead child
    // half-alive. The self-restart loop in start() recovers the session.
    void this.backend.interrupt().catch(() => {});
  }

  // Handle a canonical AgentEvent from the backend. This is the provider-agnostic
  // half of what used to be route(SDKMessage): all the panel orchestration (turn
  // gate, busy/working indicator, anchor tracking, usage meter, onSay commit)
  // lives here; the backend already normalized the provider's native messages.
  private handleEvent(ev: AgentEvent): void {
    // Any event means the turn is alive — reset the idle watchdog. The `result`
    // case below disarms it entirely (turn ended). Placed before the switch so it
    // covers every event type without per-case bumps.
    this.bumpIdleWatchdog();
    switch (ev.type) {
      case "session": {
        this.sessionId = ev.sessionId;
        if (ev.model) this.model = ev.model;
        this.deps.onSession?.(this.tabId, ev.sessionId);
        logger.info(
          `[panel-agent ${this.short()}] init model=${ev.model} session=${ev.sessionId.slice(0, 8)} effort=${this.effort ?? "default"}`,
        );
        break;
      }
      case "thinking": {
        // Live extended-thinking token count → drives a "thinking… (N)" meter
        // so the user can see the agent reasoning (not stuck) before any text.
        this.busy = true;
        this.deps.onTurn?.(this.tabId, "working");
        this.deps.onThinking?.(this.tabId, ev.tokens);
        break;
      }
      case "stream_start": {
        // Live partial output (includePartialMessages). The backend already
        // decoded the raw stream events; group deltas + the final commit by id.
        if (!this.deps.onStream) break;
        this.streamMsgId = ev.id;
        break;
      }
      case "assistant_delta": {
        if (!this.deps.onStream) break;
        const id = this.streamMsgId;
        if (!id) break;
        this.deps.onTurn?.(this.tabId, "working");
        this.deps.onStream(this.tabId, { phase: ev.thinking ? "think" : "text", id, delta: ev.text });
        break;
      }
      case "stream_end": {
        if (!this.deps.onStream) break;
        if (this.streamMsgId) this.deps.onStream(this.tabId, { phase: "end", id: this.streamMsgId });
        this.streamMsgId = null;
        break;
      }
      case "assistant": {
        // Still working — keep the panel's indicator alive through the turn.
        this.busy = true;
        this.deps.onTurn?.(this.tabId, "working");
        // Remember this message's UUID — it's the rewind anchor for the turn.
        if (typeof ev.uuid === "string") this.lastAssistantUuid = ev.uuid;
        // Each assistant API response carries the CURRENT context size — report
        // it live so the meter updates throughout the turn, not just at the end.
        if (ev.usage) {
          this.lastUsage = ev.usage;
          this.reportStatus(ev.usage);
        }
        // Commit the authoritative reply text as ONE message. With streaming on,
        // the panel already showed a live preview (matched by this message id);
        // the commit replaces it with the final text. Without streaming (or for
        // injected events), it just renders a normal bubble.
        if (ev.text) {
          this.deps.onSay(this.tabId, ev.text, { id: ev.id, streamed: true });
        }
        break;
      }
      case "result": {
        // Cache the context window + cost from the result, then re-report using
        // the last assistant usage (the true current context).
        if (ev.contextWindow && ev.contextWindow > this.contextWindow) {
          this.contextWindow = ev.contextWindow;
        }
        if (this.lastUsage) this.reportStatus(this.lastUsage, ev.costUsd);
        this.busy = false;
        // Turn completed → nothing to re-queue on a later interrupt. (A clean
        // completion must NOT have its message re-queued.)
        this.inFlight = null;
        // Turn ended cleanly → disarm the freeze watchdog. (If it already tripped,
        // completeTurn() is a capped no-op, so the gate can't double-advance.)
        this.clearIdleWatchdog();
        this.completeTurn(); // turn finished → release the next queued batch
        // Report this turn's anchor (last assistant UUID) so the panel can later
        // fork the conversation here for a rewind.
        if (this.lastAssistantUuid) this.deps.onTurnAnchor?.(this.tabId, this.lastAssistantUuid);
        this.deps.onTurn?.(this.tabId, "done");
        logger.info(
          `[panel-agent ${this.short()}] turn done (subtype=${ev.subtype})`,
        );
        break;
      }
      default:
        break;
    }
  }

  /** Push a context/usage snapshot derived from a single API response's usage.
   *  `used` is that response's PROMPT size (fresh + cached input) = the current
   *  context fill — NOT cumulative, and NOT including output tokens. */
  private reportStatus(usage: Record<string, number>, costUsd?: number): void {
    if (!this.deps.onStatus) return;
    try {
      const used =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
      const status: UsageStatus = {
        used,
        model: this.model,
        ...(this.contextWindow
          ? { contextWindow: this.contextWindow, contextPct: used / this.contextWindow }
          : {}),
        ...(typeof costUsd === "number" ? { costUsd } : {}),
      };
      this.lastStatus = status;
      this.deps.onStatus(this.tabId, status);
    } catch (err) {
      logger.debug(`[panel-agent ${this.short()}] usage report failed: ${msgOf(err)}`);
    }
  }
}

export interface PanelAgentManagerOptions {
  mcpServers: Options["mcpServers"];
  systemAppend: string;
  model: string;
  effort?: Effort;
  /** ComfyUI base URL, for fetching image bytes to inline into agent turns. */
  comfyuiUrl?: string;
  onSay: (tabId: string, text: string, meta?: SayMeta) => void;
  /** Live incremental thinking/reply deltas (streaming). */
  onStream?: (tabId: string, ev: StreamDelta) => void;
  onStatus?: (tabId: string, status: UsageStatus) => void;
  onSession?: (tabId: string, sessionId: string) => void;
  onTurnAnchor?: (tabId: string, uuid: string) => void;
  onTurn?: (tabId: string, state: "working" | "done") => void;
  /** Live extended-thinking token count, for a "thinking… (N)" indicator. */
  onThinking?: (tabId: string, tokens: number) => void;
  /** Fired when the agent dequeues a message (read moment) — carries the mid. */
  onSeen?: (tabId: string, mid: string) => void;
  /** Build the per-tab live-graph MCP server (bound to the tab id). */
  makePanelServer?: (tabId: string) => McpSdkServerConfigWithInstance;
  /** Bundled plugin dir whose skills make the agent an expert (optional). */
  pluginPath?: string;
  /**
   * Optional backend factory (per tab). When set, the manager injects this
   * backend into each PanelAgent instead of the default Claude adapter — this is
   * the PANEL_AGENT_BACKEND toggle's seam (index.ts builds a CodexBackend here).
   * Omitted = default ClaudeBackend (existing behavior, 100% unchanged).
   */
  makeBackend?: (tabId: string) => AgentBackend;
  /**
   * Fired when a tab's agent dies FATALLY — either it failed to start (hard
   * reject from backend.prepare/run) or its bounded self-restart loop gave up
   * (the session kept dropping immediately). This is the "agent backend is dead"
   * signal: the orchestrator is alive and the bridge is up, but no agent will
   * ever handshake. The orchestrator wires this to a clean self-exit so the panel
   * pack's bridge-death → reclaim + sticky-reconnect path respawns a FRESH
   * orchestrator, instead of leaving the user wedged on "bridge open but no panel
   * agent responded". `reason` is a short human label for the log.
   */
  onAgentFatal?: (tabId: string, reason: string) => void;
  /**
   * Durable per-tab session store. When set, the manager persists each tab's SDK
   * session id here and uses it as the resume fallback when a tab first spawns —
   * so the conversation survives the orchestrator PROCESS being killed (a wedge
   * auto-restart), independent of whether the panel re-sends `hello.resume`.
   */
  sessionStore?: SessionStore;
}

/** Owns one PanelAgent per tab id, spawned lazily on the tab's first message. */
export class PanelAgentManager {
  private agents = new Map<string, PanelAgent>();
  private opts: PanelAgentManagerOptions;
  /** Per-tab session id to resume on the next spawn (reload restore). */
  private pendingResume = new Map<string, string>();
  /** Tabs whose effort changed mid-turn — the session restart is deferred to the
   *  next idle moment so we never interrupt (and silently drop) a live reply. */
  private pendingEffortRestart = new Set<string>();
  /** Default model/effort for newly-spawned agents (mutated by the picker). */
  private model: string;
  private effort?: Effort;

  constructor(opts: PanelAgentManagerOptions) {
    this.opts = opts;
    this.model = opts.model;
    this.effort = opts.effort;
  }

  private makeAgent(tabId: string): PanelAgent {
    // Inject the toggle-selected backend (Codex) when provided; otherwise the
    // PanelAgent constructor defaults to ClaudeBackend (existing behavior).
    const backend = this.opts.makeBackend?.(tabId);
    return new PanelAgent(tabId, {
      mcpServers: this.opts.mcpServers,
      comfyuiUrl: this.opts.comfyuiUrl,
      systemAppend: this.opts.systemAppend,
      model: this.model,
      effort: this.effort,
      onSay: this.opts.onSay,
      onStream: this.opts.onStream,
      onStatus: this.opts.onStatus,
      // Persist the session id to our durable store (resume-after-restart) BEFORE
      // forwarding it to the panel — so it's on disk the moment the SDK reports it.
      onSession: (id, sid) => {
        this.opts.sessionStore?.set(id, sid);
        this.opts.onSession?.(id, sid);
      },
      onTurnAnchor: this.opts.onTurnAnchor,
      // Wrap onTurn so the manager learns when a turn ends — the safe point to
      // apply a deferred, session-restarting effort change.
      onTurn: (id, state) => {
        this.opts.onTurn?.(id, state);
        if (state === "done") this.applyDeferredRestart(id);
      },
      onThinking: this.opts.onThinking,
      onSeen: this.opts.onSeen,
      panelServer: this.opts.makePanelServer?.(tabId),
      pluginPath: this.opts.pluginPath,
    }, backend);
  }

  /** Update the system-prompt append used for NEWLY-spawned agents. Lets the
   *  orchestrator refresh the live ENVIRONMENT-CAPABILITIES block (e.g. after a
   *  ComfyUI restart where Triton/SageAttention may now be installed) without
   *  rebuilding the manager. Already-running agents keep their original prompt
   *  until they next respawn (a soft reload / new session). */
  setSystemAppend(systemAppend: string): void {
    this.opts.systemAppend = systemAppend;
  }

  /** Cancel a still-queued message for a tab (user edited/deleted it before the
   *  agent read it). Returns true if it was removed from the queue. */
  cancelQueued(tabId: string, mid: string): boolean {
    return this.agents.get(tabId)?.cancelQueued(mid) ?? false;
  }

  /** Effort is a session-construction option (no live setter), so changing it
   *  needs a fresh resumed session. Do it ONLY when the tab is idle — restart
   *  with resume, and hand any queued-but-unsent messages to the new agent so
   *  nothing is lost. Called on every turn-done; a no-op unless a restart is
   *  pending and the agent has fully settled. */
  private applyDeferredRestart(tabId: string): void {
    if (!this.pendingEffortRestart.has(tabId)) return;
    const agent = this.agents.get(tabId);
    if (!agent || agent.isStopped) {
      this.pendingEffortRestart.delete(tabId);
      return;
    }
    // Still mid-work (a queued message will start the next turn) — wait for the
    // next idle so we don't restart between back-to-back turns.
    if (agent.isBusy || agent.hasPending) return;
    this.pendingEffortRestart.delete(tabId);
    this.restartForEffort(tabId, agent);
  }

  /** Replace a tab's agent with a fresh one (new model/effort), resuming the
   *  conversation and carrying over any unsent queued messages. */
  private restartForEffort(tabId: string, oldAgent: PanelAgent): void {
    const resume = oldAgent.sessionId ?? undefined;
    const pending = oldAgent.takePending();
    const fresh = this.spawn(tabId, resume); // new agent (updated this.effort) owns the tab
    for (const item of pending) fresh.send(item.text, { images: item.images });
    void oldAgent.stop(); // retire the old one; it's no longer mapped
    logger.info(
      `[panel-orchestrator] tab ${tabId.slice(0, 8)} effort restart applied (idle, ${pending.length} queued carried over)`,
    );
  }

  /** Last usage snapshot for a tab's agent (for re-pushing the meter on connect). */
  lastStatusFor(tabId: string): UsageStatus | null {
    return this.agents.get(tabId)?.lastStatus ?? null;
  }

  /** Feed a ComfyUI execution event to an EXISTING agent (no-op if none — we
   *  never spawn an agent just to react to an event). Returns whether delivered. */
  injectEvent(tabId: string, ev: { kind?: string; images?: ImageRef[]; error?: string; note?: string }): boolean {
    const agent = this.agents.get(tabId);
    if (!agent || agent.isStopped) return false; // best-effort; don't enqueue into a closed agent
    agent.injectEvent(ev);
    return true;
  }

  /** Push a ComfyUI execution error to a tab's agent — interrupt the live turn
   *  and front-queue the error so the agent stops and addresses it. */
  async injectRunError(tabId: string, error: string): Promise<boolean> {
    const agent = this.agents.get(tabId);
    if (!agent || agent.isStopped) return false;
    await agent.injectRunError(error);
    return true;
  }

  private spawn(tabId: string, resume?: string): PanelAgent {
    const agent = this.makeAgent(tabId);
    this.agents.set(tabId, agent);
    logger.info(
      `[panel-orchestrator] spawning agent for tab ${tabId.slice(0, 8)}${resume ? " (resume)" : ""} (${this.agents.size} active)`,
    );
    // start() now SELF-RESTARTS internally on session-end, so it only settles on
    // an intentional stop() or after it gives up (repeated immediate failures),
    // or it rejects on a hard start failure. In the give-up / reject cases, drop
    // the dead agent (if still mapped and not stopped on purpose) so the next
    // user message spawns a fresh one.
    const settle = (err?: unknown) => {
      if (this.agents.get(tabId) !== agent || agent.isStopped) return;
      const gaveUp = agent.gaveUp;
      this.agents.delete(tabId);
      if (err) {
        const m = msgOf(err);
        logger.error(`[panel-agent ${tabId.slice(0, 8)}] failed to start: ${m}`);
        this.opts.onSay(tabId, `⚠️ The panel agent could not start: ${m}`);
        // Hard start failure (e.g. the codex app-server can't spawn/handshake, the
        // Claude SDK can't init) → fatal: the orchestrator should exit so a fresh
        // one is respawned rather than serving a dead agent.
        this.opts.onAgentFatal?.(tabId, `agent failed to start: ${m}`);
      } else if (gaveUp) {
        // The bounded self-restart loop gave up — the session keeps dropping. Same
        // fatal signal: let the orchestrator self-exit + respawn.
        this.opts.onAgentFatal?.(tabId, "agent session kept dropping (self-restart gave up)");
      }
    };
    void agent.start(resume).then(
      () => settle(),
      (err) => settle(err),
    );
    return agent;
  }

  /** Rewind a tab's conversation: fork the live session at `anchor` (dropping
   *  everything after). The edited message follows as the next user_message.
   *  Returns false if no live agent. */
  rewind(tabId: string, anchor: string | null): boolean {
    const agent = this.agents.get(tabId);
    if (!agent || agent.isStopped) return false;
    agent.requestRewind(anchor);
    return true;
  }

  /** Reorder a tab's still-queued messages to the panel's desired flush order. */
  reorderQueue(tabId: string, order: string[]): boolean {
    const agent = this.agents.get(tabId);
    if (!agent || agent.isStopped) return false;
    agent.reorderQueue(order);
    return true;
  }

  /** Record a session id to resume when this tab next spawns (reload restore). */
  setResume(tabId: string, sessionId: string): void {
    if (this.agents.has(tabId)) return; // a live agent already owns the session
    this.pendingResume.set(tabId, sessionId);
  }

  /** Route a panel message to its tab's agent, creating the agent if needed.
   *  Never routes into a stopped agent (whose channel is closed) — respawns so
   *  the message reaches a live session. */
  send(tabId: string, text: string, meta?: { title?: string; images?: ImageRef[]; mid?: string }): void {
    let agent = this.agents.get(tabId);
    if (agent?.isStopped) {
      this.agents.delete(tabId);
      agent = undefined;
    }
    if (!agent) {
      // Resume order: the panel's `hello.resume` (freshest, this reconnect) wins;
      // otherwise fall back to our durable disk copy — which is the ONLY survivor
      // when the orchestrator process was killed and respawned (a wedge restart)
      // and the panel hasn't (or can't) re-send the session id. Without this the
      // agent silently forgets the whole conversation after an auto-restart.
      const resume =
        this.pendingResume.get(tabId) ?? this.opts.sessionStore?.get(tabId);
      this.pendingResume.delete(tabId);
      agent = this.spawn(tabId, resume);
    }
    agent.send(text, { title: meta?.title, images: meta?.images, mid: meta?.mid });
  }

  /**
   * Apply a model/effort change for a tab. Model switches live (SDK setModel).
   * Effort has no live setter, so it needs a fresh resumed session — but we NEVER
   * do that mid-turn (it would interrupt and silently drop the in-flight reply,
   * which read as "the agent stopped responding"). If a turn is running, the
   * restart is deferred to the next idle moment (applyDeferredRestart); if idle,
   * it happens now. Either way the model change is applied live immediately.
   * `restarted` is true only when the session was actually recreated in this call.
   */
  async setOptions(
    tabId: string,
    next: { model?: string; effort?: Effort | null },
  ): Promise<{ model: string; effort?: Effort; restarted: boolean; deferred: boolean }> {
    const changes: string[] = [];
    let restarted = false;
    let deferred = false;

    if (typeof next.model === "string" && next.model && next.model !== this.model) {
      this.model = next.model;
      changes.push(`model=${next.model}`);
    }

    // null clears effort back to the SDK default; undefined leaves it untouched.
    let effortChanged = false;
    if (next.effort !== undefined) {
      const nextEffort = next.effort ?? undefined;
      if (nextEffort !== this.effort) {
        this.effort = nextEffort;
        effortChanged = true;
        changes.push(`effort=${nextEffort ?? "default"}`);
      }
    }

    const agent = this.agents.get(tabId);
    if (agent) {
      // Apply a model change live regardless of the effort path (so a deferred
      // effort restart doesn't hold up the model switch).
      if (typeof next.model === "string" && next.model) {
        await agent.setModel(next.model);
      }
      if (effortChanged) {
        if (agent.isBusy || agent.hasPending) {
          // Mid-turn → defer; applyDeferredRestart fires on the next turn-done.
          this.pendingEffortRestart.add(tabId);
          deferred = true;
        } else {
          // Idle → restart now (resume + carry over any queued messages).
          this.pendingEffortRestart.delete(tabId);
          this.restartForEffort(tabId, agent);
          restarted = true;
        }
      }
    }

    if (changes.length) {
      logger.info(
        `[panel-orchestrator] tab ${tabId.slice(0, 8)} options: ${changes.join(" ")}${deferred ? " (effort restart deferred to idle)" : ""}`,
      );
    }
    return { model: this.model, effort: this.effort, restarted, deferred };
  }

  /** Forget a tab's agent so the next message starts a brand-new session. The
   *  map mutation is synchronous and the old agent is stopped fire-and-forget,
   *  so the caller (e.g. resume_session) can set a new pendingResume right after
   *  without a concurrent send() spawning a non-resumed agent in an await gap. */
  reset(tabId: string): void {
    const agent = this.agents.get(tabId);
    this.agents.delete(tabId);
    this.pendingResume.delete(tabId);
    // Forget the durable session too — a NEW chat must start fresh, so the disk
    // fallback in send() can't resurrect the conversation the user just cleared.
    // (resume_session calls reset() then setResume() with the chosen id, so the
    // historical session is re-armed right after and re-persisted on next onSession.)
    this.opts.sessionStore?.clear(tabId);
    this.pendingEffortRestart.delete(tabId); // a reset supersedes any deferred restart
    if (agent) {
      logger.info(`[panel-orchestrator] tab ${tabId.slice(0, 8)} reset — new session next message`);
      void agent.stop();
    }
  }

  async interrupt(tabId: string, opts: { requeueInFlight?: boolean } = {}): Promise<void> {
    await this.agents.get(tabId)?.interrupt(opts);
  }

  async stopAll(): Promise<void> {
    this.pendingEffortRestart.clear();
    await Promise.all([...this.agents.values()].map((a) => a.stop()));
    this.agents.clear();
  }

  count(): number {
    return this.agents.size;
  }

  get defaults(): { model: string; effort?: Effort } {
    return { model: this.model, effort: this.effort };
  }
}
