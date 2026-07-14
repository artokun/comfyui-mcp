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

/** How long after an interrupt to wait for the aborted turn's `result` (which
 *  releases the turn gate at the correct moment) before force-releasing it as a
 *  fallback. Short enough to feel immediate if a result somehow never arrives;
 *  in the normal case the result lands well within this and the gate opens then.
 *  Overridable (tuning / tests) via COMFYUI_MCP_INTERRUPT_RELEASE_MS. */
const INTERRUPT_RELEASE_FALLBACK_MS =
  Number(process.env.COMFYUI_MCP_INTERRUPT_RELEASE_MS) || 1500;

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
  /** A tool the agent invoked — for a compact "activity" line (tool visibility). */
  onToolCall?: (tabId: string, name: string) => void;
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
  /** After an interrupt we DON'T force the turn gate open synchronously — that
   *  fed the next batch into the backend before the aborted turn had settled, so
   *  Claude took the message into the session but started no turn on it (wedged
   *  until the slow idle watchdog or the next message). Instead the aborted
   *  turn's `result` event drives completeTurn() at the right moment; this is a
   *  short fallback that opens the gate anyway if no result ever arrives, so an
   *  interrupt can never stop cold. */
  private interruptReleaseTimer: ReturnType<typeof setTimeout> | null = null;
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
    // The turn that's in flight RIGHT NOW — the one we're aborting. Captured
    // before the await so the release fallback below targets exactly this turn's
    // gate (not a later one the channel may legitimately advance to if the
    // aborted turn's result lands during the await).
    const interruptedTurn = this.yieldedTurns;
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
      // Do NOT force the gate open here. Synchronously releasing it fed the next
      // batch (the re-queued turn + the "send now" message) into Claude before the
      // aborted turn had settled — the SDK took the message into the session but
      // started no turn on it, so it sat wedged until the slow idle watchdog (or
      // the user's next message) nudged it. Instead let the aborted turn's
      // `result` event drive completeTurn() — that fires once the SDK has finished
      // tearing the turn down and is ready for the next prompt, so the re-queued
      // batch is fed at the right moment and answered immediately. The fallback
      // guarantees we still advance if no result ever arrives.
      this.armInterruptReleaseFallback(interruptedTurn);
    }
  }

  /** Bounded safety net for interrupt(): if the aborted turn's `result` (which
   *  opens the gate via completeTurn) hasn't arrived shortly, force the gate so an
   *  interrupt can't stop cold. `guardTurn` is the interrupted turn's number —
   *  we only force-release while THAT turn is still the one the gate waits on, so
   *  a result that lands during the await (advancing the channel to a new, legit
   *  in-flight turn) can't be wrongly cut short. Cancelled by completeTurn(). */
  private armInterruptReleaseFallback(guardTurn: number): void {
    if (this.interruptReleaseTimer) clearTimeout(this.interruptReleaseTimer);
    this.interruptReleaseTimer = setTimeout(() => {
      this.interruptReleaseTimer = null;
      if (this.closed) return;
      // Fire only if the SAME interrupted turn still hasn't completed (no result
      // arrived). If a result landed, completedTurns has reached guardTurn (and
      // completeTurn already cleared this timer), so this is a no-op.
      if (this.completedTurns < guardTurn) {
        logger.debug(
          `[panel-agent ${this.short()}] interrupt: no result within ${INTERRUPT_RELEASE_FALLBACK_MS}ms — releasing the gate`,
        );
        this.releaseTurns();
      }
    }, INTERRUPT_RELEASE_FALLBACK_MS);
    this.interruptReleaseTimer.unref?.();
  }

  private clearInterruptReleaseFallback(): void {
    if (this.interruptReleaseTimer) {
      clearTimeout(this.interruptReleaseTimer);
      this.interruptReleaseTimer = null;
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
    // A real result settled the (interrupted or clean) turn — the post-interrupt
    // fallback is no longer needed.
    this.clearInterruptReleaseFallback();
    this.completedTurns = Math.min(this.completedTurns + 1, this.yieldedTurns);
    const w = this.turnWaiter;
    this.turnWaiter = null;
    w?.();
  }

  /** Force the gate open regardless of results (interrupt fallback / shutdown) so
   *  an interrupt advances to the next pending batch instead of stopping cold. */
  private releaseTurns(): void {
    this.clearInterruptReleaseFallback();
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
      // Set below if the backend fails because the resume target is gone; keeps a
      // recoverable resume-miss from counting toward the give-up threshold.
      let resumeMiss = false;
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
        const emsg = msgOf(err);
        logger.error(`[panel-agent ${this.short()}] stream error: ${emsg}`);
        // A resume whose target session no longer exists — e.g. the orchestrator was
        // relaunched from a different cwd, or the session transcript was pruned —
        // fails with "No conversation found with session ID: <id>". Retrying the SAME
        // resume just loops until the give-up threshold trips and self-exits the whole
        // orchestrator (a live bridge left serving a permanently-dead agent). Drop the
        // dead resume target so the NEXT iteration starts a FRESH session and
        // self-heals; queued messages (this.queue) survive and replay.
        if (/No conversation found with session ID/i.test(emsg)) {
          logger.warn(
            `[panel-agent ${this.short()}] resume target is gone — starting a fresh session`,
          );
          this.sessionId = null;
          resumeSessionId = undefined;
          resumeMiss = true;
        }
        // SELF-HEAL: a crash mid-turn (the SDK process dying, e.g. code
        // 4294967295) leaves the triggering message unprocessed. Resuming the
        // session finds the turn already recorded as ended, so it produces empty
        // "success" turns and the user's request is silently EATEN. Re-queue the
        // in-flight message so the restarted/fresh session actually re-runs it.
        // Idempotent enough: a duplicate render beats a lost request, and the
        // quickRestarts give-up guard still bounds a message that crash-loops.
        if (this.inFlight) {
          const interrupted = this.inFlight;
          this.inFlight = null;
          this.queue.unshift(interrupted);
          logger.warn(
            `[panel-agent ${this.short()}] crash mid-turn — re-queued the interrupted message so it isn't lost`,
          );
        }
      }
      // Session ended (cleanly or via error) — disarm any armed watchdog AND the
      // interrupt-release fallback so a stale timer from the dead session can't fire
      // into the restarted one (the restart resets the gate counters to 0, so a
      // leftover fallback armed for old turn N would force-release the new session's
      // first turn — gate run-ahead). The gate counters are reset next iteration.
      this.clearIdleWatchdog();
      this.clearInterruptReleaseFallback();
      if (this.closed) break;
      // Session ended on its own — bound rapid failure loops so a persistently
      // broken SDK doesn't spin forever or black-hole each message.
      // A recoverable resume-miss (handled above by dropping the dead session) must
      // NOT count toward the give-up threshold — the next iteration starts fresh.
      quickRestarts = !resumeMiss && Date.now() - startedAt < 5000 ? quickRestarts + 1 : 0;
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
      case "tool_call": {
        // Tool visibility — surface the agent's actions (a canvas-less mobile
        // client otherwise sees only a spinner between reply bubbles). Only the
        // START phase is forwarded as a compact activity line.
        this.busy = true;
        this.deps.onTurn?.(this.tabId, "working");
        if (ev.phase === "start") {
          this.deps.onToolCall?.(this.tabId, ev.name);
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
  /** A tool the agent invoked — for a compact "activity" line (tool visibility). */
  onToolCall?: (tabId: string, name: string) => void;
  /** Fired when the agent dequeues a message (read moment) — carries the mid. */
  onSeen?: (tabId: string, mid: string) => void;
  /** Build the per-tab live-graph MCP server (bound to the tab id). May return
   *  undefined for a backend that hosts its panel_* tools out-of-process (codex/
   *  gemini use the loopback HTTP MCP instead of this in-process SDK server). */
  makePanelServer?: (tabId: string) => McpSdkServerConfigWithInstance | undefined;
  /** Bundled plugin dir whose skills make the agent an expert (optional). */
  pluginPath?: string;
  /**
   * Optional backend factory (per agent key `panelTabId::backend`). The manager
   * injects the returned backend into the PanelAgent; returning undefined selects
   * the default in-process ClaudeBackend. Single-port multi-provider: index.ts
   * builds a Codex/Gemini backend for those keys and undefined for claude keys.
   */
  makeBackend?: (tabId: string) => AgentBackend | undefined;
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
  /** Tabs awaiting a comfyui-MCP-env respawn (a tool secret was saved). Value is
   *  an optional nudge to enqueue after the resumed agent comes back (e.g. "retry
   *  the download"). Applied at the next idle so the saving turn finishes first. */
  private pendingMcpRestart = new Map<string, string | null>();
  /** Default model/effort for newly-spawned agents (the env/config defaults). */
  private model: string;
  private effort?: Effort;
  /** Per-key model/effort OVERRIDE set by the picker (set_options). Keyed by the
   *  COMPOSITE agent key `tabId::backend`, so a model/effort chosen for one
   *  provider NEVER bleeds into another: a Codex "gpt-5.5" pick must not become the
   *  Claude spawn's model (which errors "model gpt-5.5 may not exist"). A provider
   *  switch calls reset(oldKey), which drops that key's override, so the new
   *  backend falls back to its OWN default. A same-provider reconnect reuses the
   *  same key, so the user's pick persists. */
  private modelByKey = new Map<string, string>();
  private effortByKey = new Map<string, Effort | undefined>();

  constructor(opts: PanelAgentManagerOptions) {
    this.opts = opts;
    this.model = opts.model;
    this.effort = opts.effort;
  }

  /** The model a newly-spawned agent for `tabId` should use: the per-key override
   *  (picker) when set for THIS key, else the shared default. */
  private modelFor(tabId: string): string {
    return this.modelByKey.get(tabId) ?? this.model;
  }
  /** The effort a newly-spawned agent for `tabId` should use: the per-key override
   *  (picker) when set for THIS key, else the shared default. */
  private effortFor(tabId: string): Effort | undefined {
    return this.effortByKey.has(tabId) ? this.effortByKey.get(tabId) : this.effort;
  }

  private makeAgent(tabId: string): PanelAgent {
    // Inject the toggle-selected backend (Codex) when provided; otherwise the
    // PanelAgent constructor defaults to ClaudeBackend (existing behavior).
    const backend = this.opts.makeBackend?.(tabId);
    return new PanelAgent(tabId, {
      mcpServers: this.opts.mcpServers,
      comfyuiUrl: this.opts.comfyuiUrl,
      systemAppend: this.opts.systemAppend,
      model: this.modelFor(tabId),
      effort: this.effortFor(tabId),
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
        // The safe point to apply any deferred session-restart (effort change
        // and/or comfyui-MCP-env respawn). COALESCED into a single replacement so
        // an agent is never restarted twice in a row (which would lose the resume
        // id of the just-spawned, not-yet-session'd agent).
        if (state === "done") this.applyPendingRestarts(id);
      },
      onThinking: this.opts.onThinking,
      onToolCall: this.opts.onToolCall,
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

  /** Update the MCP server set used for NEWLY-spawned agents. The orchestrator
   *  calls this after a tool secret is saved so the rebuilt comfyui server env
   *  (now carrying the secret) is what the next spawn passes. Already-running
   *  agents keep their current env until they respawn — drive that with
   *  restartAllForMcpEnv() so the live comfyui MCP subprocess is recreated. */
  setMcpServers(mcpServers: Options["mcpServers"]): void {
    this.opts.mcpServers = mcpServers;
  }

  /** Update the ComfyUI URL used for NEWLY-spawned agents (image-byte fetching).
   *  Codex/Gemini backends read the URL via the orchestrator's per-spawn env, so a
   *  restartAllForMcpEnv() after this points every provider at the new target. */
  setComfyuiUrl(comfyuiUrl: string): void {
    this.opts.comfyuiUrl = comfyuiUrl;
  }

  /** Respawn every active tab's agent (resume + carry-over) so the live comfyui
   *  MCP subprocess is recreated with the updated env. Deferred to each tab's
   *  next idle so the turn that SAVED the secret finishes first (we never
   *  interrupt a live reply). `nudge`, if given, is enqueued to each resumed
   *  agent so it auto-continues (e.g. retries the download the secret unblocked). */
  restartAllForMcpEnv(nudge?: string): void {
    for (const tabId of this.agents.keys()) {
      this.pendingMcpRestart.set(tabId, nudge ?? null);
      // Apply immediately when the tab is already idle; otherwise it fires on the
      // next turn-done via applyPendingRestarts().
      this.applyPendingRestarts(tabId);
    }
  }

  /**
   * Apply any deferred session-restart for a tab once it's idle — COALESCING a
   * pending effort change and a pending comfyui-MCP-env respawn into ONE
   * replacement. Both are session-construction changes (effort + mcpServers) that
   * the manager has already stored on itself, so a single spawn picks up both.
   *
   * Doing them separately would restart the agent twice in a row: the first spawn
   * resumes from the OLD agent's session id, but the SECOND would resume from the
   * just-spawned agent whose session id hasn't been emitted yet (null) — silently
   * dropping the conversation. Coalescing replaces the original agent exactly once
   * with the correct resume id and fires the retry nudge a single time.
   *
   * No-op unless something is pending and the agent has fully settled (idle).
   */
  private applyPendingRestarts(tabId: string): void {
    const wantEffort = this.pendingEffortRestart.has(tabId);
    const wantMcp = this.pendingMcpRestart.has(tabId);
    if (!wantEffort && !wantMcp) return;
    const agent = this.agents.get(tabId);
    if (!agent || agent.isStopped) {
      this.pendingEffortRestart.delete(tabId);
      this.pendingMcpRestart.delete(tabId);
      return;
    }
    // Still mid-work (a queued message will start the next turn) — wait for the
    // next idle so we don't restart between back-to-back turns.
    if (agent.isBusy || agent.hasPending) return;
    // Only the MCP respawn carries a retry nudge.
    const nudge = wantMcp ? (this.pendingMcpRestart.get(tabId) ?? undefined) : undefined;
    this.pendingEffortRestart.delete(tabId);
    this.pendingMcpRestart.delete(tabId);
    const carried = this.restartAgentResume(tabId, agent, nudge);
    const reasons = [wantEffort ? "effort" : null, wantMcp ? "comfyui-mcp-env" : null]
      .filter(Boolean)
      .join("+");
    logger.info(
      `[panel-orchestrator] tab ${tabId.slice(0, 8)} restart applied (idle, reason=${reasons}, ${carried} queued carried over${nudge ? " + retry nudge" : ""})`,
    );
  }

  /** Cancel a still-queued message for a tab (user edited/deleted it before the
   *  agent read it). Returns true if it was removed from the queue. */
  cancelQueued(tabId: string, mid: string): boolean {
    return this.agents.get(tabId)?.cancelQueued(mid) ?? false;
  }

  /** Replace a tab's agent with a fresh one (picks up the manager's current
   *  model/effort/mcpServers), resuming the conversation and carrying over any
   *  unsent queued messages. `nudge`, if given, is enqueued after the carried-over
   *  messages so the resumed agent auto-continues. Returns how many were carried. */
  private restartAgentResume(tabId: string, oldAgent: PanelAgent, nudge?: string): number {
    const resume = oldAgent.sessionId ?? undefined;
    const pending = oldAgent.takePending();
    const fresh = this.spawn(tabId, resume); // new agent owns the tab now
    for (const item of pending) fresh.send(item.text, { images: item.images });
    if (nudge) fresh.send(nudge);
    void oldAgent.stop(); // retire the old one; it's no longer mapped
    return pending.length;
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

  /**
   * Rebind an agent from its current (stale) tabId to a new tabId — recovers
   * from a panel tab-id scheme migration (e.g. random UUID → deterministic
   * tmp:/wf: prefixed ids) without losing the conversation. The agent's panel
   * tools still carry the old tabId; the UiBridge's tabMigrations map (see
   * ui-bridge.ts resolveTarget) redirects those calls to the new connection.
   * Returns true if an agent was rebound.
   */
  rebindAgent(oldKey: string, newKey: string): boolean {
    if (oldKey === newKey) return false;
    if (this.agents.has(newKey)) return false;
    const agent = this.agents.get(oldKey);
    if (!agent || agent.isStopped) return false;
    this.agents.delete(oldKey);
    this.agents.set(newKey, agent);
    const resume = this.pendingResume.get(oldKey);
    if (resume) {
      this.pendingResume.delete(oldKey);
      this.pendingResume.set(newKey, resume);
    }
    const effortRestart = this.pendingEffortRestart.has(oldKey);
    if (effortRestart) {
      this.pendingEffortRestart.delete(oldKey);
      this.pendingEffortRestart.add(newKey);
    }
    const mcpRestart = this.pendingMcpRestart.get(oldKey);
    if (mcpRestart !== undefined) {
      this.pendingMcpRestart.delete(oldKey);
      this.pendingMcpRestart.set(newKey, mcpRestart);
    }
    const model = this.modelByKey.get(oldKey);
    if (model) {
      this.modelByKey.delete(oldKey);
      this.modelByKey.set(newKey, model);
    }
    const effort = this.effortByKey.get(oldKey);
    if (effort) {
      this.effortByKey.delete(oldKey);
      this.effortByKey.set(newKey, effort);
    }
    this.opts.sessionStore?.clear(oldKey);
    return true;
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
      // Resume order: the orchestrator's OWN durable copy wins — it is the source
      // of truth and the only survivor when the process was killed and respawned
      // (a wedge restart). The panel's `hello.resume` is only a HINT, used when we
      // have no record (e.g. a brand-new orchestrator whose disk was wiped while a
      // panel still holds a session id). Making the panel authoritative is what
      // caused the reconnect "flip-flop": a stale/duplicate panel claim could
      // override the session the orchestrator is actually holding. The store is
      // keyed per (tab, backend), so a provider switch finds no entry here and
      // correctly starts fresh (the panel replays the transcript to seed it).
      const resume =
        this.opts.sessionStore?.get(tabId) ?? this.pendingResume.get(tabId);
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
   * restart is deferred to the next idle moment (applyPendingRestarts); if idle,
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

    if (typeof next.model === "string" && next.model && next.model !== this.modelFor(tabId)) {
      // Per-KEY override (tabId::backend) so this pick can't poison a different
      // provider's spawn — the switch-then-error bug (Codex gpt-5.5 → Claude).
      this.modelByKey.set(tabId, next.model);
      changes.push(`model=${next.model}`);
    }

    // null clears effort back to the SDK default; undefined leaves it untouched.
    let effortChanged = false;
    if (next.effort !== undefined) {
      const nextEffort = next.effort ?? undefined;
      if (nextEffort !== this.effortFor(tabId)) {
        this.effortByKey.set(tabId, nextEffort);
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
        // Mark the restart pending, then let the COALESCING applier decide: if the
        // agent is idle it restarts now (folding in any pending comfyui-MCP-env
        // respawn + its nudge as a single replacement); if mid-turn it defers to
        // the next turn-done. This guarantees the agent is never restarted twice.
        this.pendingEffortRestart.add(tabId);
        const busy = agent.isBusy || agent.hasPending;
        this.applyPendingRestarts(tabId);
        if (busy) {
          deferred = true;
        } else {
          restarted = true;
        }
      }
    }

    if (changes.length) {
      logger.info(
        `[panel-orchestrator] tab ${tabId.slice(0, 8)} options: ${changes.join(" ")}${deferred ? " (effort restart deferred to idle)" : ""}`,
      );
    }
    return { model: this.modelFor(tabId), effort: this.effortFor(tabId), restarted, deferred };
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
    this.pendingMcpRestart.delete(tabId);
    // Drop this key's picker override so a provider switch (which reset()s the old
    // key) can't carry the old provider's model/effort into the new backend's spawn.
    this.modelByKey.delete(tabId);
    this.effortByKey.delete(tabId);
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
    this.pendingMcpRestart.clear();
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
