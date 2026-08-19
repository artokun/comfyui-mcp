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
import { COMPLETION_DISAGREEMENT_NOTE } from "./download-done-guard.js";
import { downloadsAtRiskOfRespawn } from "../services/download-jobs.js";
import { orphanedByDeferredRespawnNote } from "../services/panel-secrets.js";
import { errorText, promptText } from "./error-text.js";
import {
  MAX_SESSION_PREVIEW_ATTACHMENTS,
  MAX_SESSION_PREVIEW_BYTES,
  previewByteBudgetLabel,
  type PreviewLedger,
} from "./preview-budget.js";
import type { SessionStore } from "./session-store.js";
import type { AgentBackend, AgentEvent, NeutralTurn } from "./agent-backend.js";
import { type AudioRef, dedupeAudioRefs, noAudioPartText } from "./audio-attachment.js";
import { runErrorNotice } from "./cli-remedy.js";
import { runCompletionDirective } from "./todo-state.js";
import { retargetIsWorthNudging, staleTargetNudge } from "./retarget-nudge.js";
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
  return errorText(err);
}

/**
 * Opening clause naming WHICH run a completion belongs to (#468).
 *
 * The whole point is that the agent must never read a completion as the answer
 * to its own `panel_run` unless the orchestrator PROVED it by exact prompt id.
 * So:
 *  • matched      → say so, and name the id.
 *  • foreign      → real run, real id, but not one this session queued. Say
 *                   UNDETERMINED and forbid treating it as the awaited render.
 *  • unidentified → no id at all. Same, plus how to find out for certain.
 * An event with no correlation field (a legacy/simulated frame) gets the old
 * neutral wording — unchanged behavior.
 */
function runIdentityPreamble(ev: {
  prompt_id?: string;
  run_correlation?: string;
  /** #925 — the id has been ours before; see run-completion-journal. */
  run_correlation_prior?: boolean;
}): string {
  const pid = typeof ev.prompt_id === "string" && ev.prompt_id.trim() ? ev.prompt_id.trim() : null;
  switch (ev.run_correlation) {
    case "matched":
      return `This is the run YOU queued with panel_run (prompt ${pid}). `;
    case "foreign":
      // #925 — TWO DIFFERENT FACTS, and only one of them is "not yours". A
      // completion with no open ticket may be a run this session never queued,
      // or a run it DID queue whose ticket has since been evicted (the map is
      // capped), or a re-delivery after the first was acked. The reporter hit the
      // second: their own prompt id, confirmed successful in ComfyUI's history,
      // and the orchestrator told the agent it was not theirs — which does not
      // merely mislabel it, it instructs the agent to disbelieve a correct
      // result. Both stay UNDETERMINED and both are refused identically; what
      // changes is that we stop asserting the one thing we do not know.
      if (ev.run_correlation_prior) {
        return (
          `This run (prompt ${pid}) WAS queued from this session, but it can no longer be tied to a ` +
          `specific run of yours — the orchestrator tracks a bounded number of runs and this one has ` +
          `aged out, or the id was queued again and now stands for more than one. So its origin is ` +
          `UNDETERMINED even though the id is one of yours, and it CANNOT be treated as proof that ` +
          `the render you are waiting on finished. Do NOT treat it as that render; confirm with ` +
          `get_history (action:"list") which of your runs this id belongs to before acting. `
        );
      }
      return (
        `This run (prompt ${pid}) does NOT match any run you queued with panel_run — its origin is UNDETERMINED. ` +
        `Do NOT treat it as the render you are waiting on; if you are still waiting on your own run, verify it with get_history (action:"list") before acting. `
      );
    case "unidentified":
      return (
        `The panel reported NO prompt id for this run, so it CANNOT be correlated to the render you queued — its origin is UNDETERMINED. ` +
        `Do NOT assume it is your run; verify yours with get_history (action:"list") before acting on it. `
      );
    default:
      return pid ? `(prompt ${pid}) ` : ``;
  }
}

/** Idle window for the per-turn freeze watchdog: if a turn that's in flight
 *  receives NO events at all for this long, treat it as stalled. Generous (legit
 *  tool work is slow but still streams progress) and overridable for tests via
 *  COMFYUI_MCP_TURN_IDLE_MS. Default 3.5 min. */
const TURN_IDLE_MS = Number(process.env.COMFYUI_MCP_TURN_IDLE_MS) || 210_000;

/** Automatic render previews are context, not the user's explicit attachment
 * request. Keep them from turning a turn into an unbounded multimodal one (a
 * seven-way comparison can expose dozens of PreviewImage outputs). The panel
 * already shows every output; the agent only needs a representative bounded set.
 * Foreign/unidentified completions get no pixels at all because their own
 * correlation preamble forbids the agent from treating them as its awaited run.
 *
 * PER TURN, NOT PER EVENT — and that distinction is the whole budget. channel()
 * drains the WHOLE queue into one turn and flatMaps the attachments, so a
 * per-event cap of 8 delivers 8N for N completions that land while the agent is
 * busy. Measured before this was fixed: four matched completions queued during
 * one turn put 32 images on the next one, which is exactly #1516's compounding
 * shape. Enforced in two places doing DIFFERENT jobs: injectEvent spends the
 * remaining budget, which is what lets a notice state a count true of the turn
 * it EXPECTS to land in; the drain caps the assembled batch, and is the only
 * place that knows the turn that actually happened.
 *
 * The gap between those two is real and measured, not theoretical. An in-flight
 * batch is not on `queue`, so injectEvent cannot see it: with 8 previews in
 * flight, a completion arriving behind them is told the budget is untouched and
 * commits its own 8. An interrupt then requeues the in-flight items beside it and
 * one drain sees 16. The ceiling holds (8 delivered), but the second completion's
 * notice already claimed "attached below" for images that no longer ride the
 * turn — so the drain has to CORRECT that claim, not merely enforce the number.
 * Counting in-flight items at inject time is not the fix: a turn that ends
 * normally never comes back, so charging for it would starve every sequential
 * render of its preview. */
const MAX_RUN_COMPLETION_IMAGE_ATTACHMENTS = 8;

/** Name outputs so `get_image action:"get"` can actually fetch them.
 *
 *  Filename alone is not a coordinate: `type` defaults to "output" and a
 *  PreviewImage lives in `temp`, so a bare name sends the agent looking in the
 *  wrong directory. Only the parts that differ from the default are spelled out,
 *  to keep an ordinary output list readable. */
function describeImageRefs(refs: ImageRef[]): string {
  return refs
    .map((i) => {
      const type = i.type ?? "output";
      const sub = i.subfolder ? `, subfolder:"${i.subfolder}"` : "";
      return type === "output" && !i.subfolder ? i.filename : `${i.filename} (type:"${type}"${sub})`;
    })
    .join(", ");
}

/** Longest a single tool call may hold the idle watchdog off before it's treated
 *  as genuinely stuck rather than legitimately slow. An MCP tool call streams NO
 *  progress notification between its start and end (e.g. install_custom_node
 *  awaiting ComfyUI-Manager's 600s cap), so while one is in flight the turn is
 *  working even though the app-server is silent — the watchdog must not trip. But
 *  a tool open past THIS is more likely wedged than slow, so the watchdog is
 *  allowed to fire. Generous (> Manager's 600s). Read live (not a load-time
 *  const) so it stays overridable per test. */
function toolBusyMaxMs(): number {
  return Number(process.env.COMFYUI_MCP_TOOL_BUSY_MAX_MS) || 900_000;
}

/** #1567 — how often a HELD credential respawn re-asks whether the transfers it is waiting
 *  on have finished. Nothing else can wake it: `applyPendingRestarts` runs at turn-done, and
 *  a user watching a long download is idle by definition. Read live (not a load-time const)
 *  so it stays overridable per test, like `toolBusyMaxMs` above. */
function respawnHoldPollMs(): number {
  return Number(process.env.COMFYUI_MCP_RESPAWN_HOLD_POLL_MS) || 15_000;
}

/** #1567 — how long every at-risk transfer may make NO progress before a held respawn stops
 *  waiting on them and fires anyway (with the orphan note). This is the ONLY thing that ends
 *  a hold other than the transfers finishing: a wall-clock cap would kill a healthy 48 GB
 *  download for being long, which is the loss the hold exists to prevent. Generous enough to
 *  ride out a slow mirror's stall, short enough that a dead transfer cannot pin a respawn for
 *  the rest of the session. Overridable via COMFYUI_MCP_RESPAWN_HOLD_STALL_MS. */
function respawnHoldStallMs(): number {
  return Number(process.env.COMFYUI_MCP_RESPAWN_HOLD_STALL_MS) || 120_000;
}

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
  /** #1516 — set by PanelAgent on AUTOMATIC run-completion previews (never on a
   *  user's explicit attachment, which keeps its own reviewed policy). This is
   *  what the backend keys the cumulative per-conversation byte ledger on, and
   *  it never arrives from the panel wire — only injectEvent sets it. */
  automatic?: boolean;
}

/** One queued user turn (a panel message, or an injected panel event).
 *
 *  `eventTokens` carry #468's run-completion journal tokens through the queue.
 *  A completion is only ACKED once the turn that carried it ended, so an item
 *  that is queued-but-unread when the agent dies (or whose turn is abandoned by
 *  the stall watchdog) is handed BACK to the journal and replayed instead of
 *  vanishing with the agent. */
export interface QueueItem {
  text: string;
  images?: ImageRef[];
  /** Audio attachments this item is carrying (#790). */
  audio?: AudioRef[];
  mid?: string;
  /** Run-completion journal tokens this item is carrying (#468). */
  eventTokens?: string[];
  /** True when this item is NOTHING BUT an injected panel event — its whole text
   *  is the event, so removing it removes the event and loses no user message.
   *  A re-queued turn restores the original items rather than one merged item
   *  (see PanelAgent.inFlight), so this stays accurate across an interrupt or a
   *  crash re-queue. */
  completionOnly?: boolean;
  /** #1489 — this item is an injected RUN-ERROR notice. Marked so a burst of them
   *  coalesces into one turn instead of nesting: each `injectRunError` used to
   *  interrupt the live turn and RE-QUEUE it, and after the first error that live turn
   *  is itself an error turn — so error N re-queued errors 1..N-1 and the drain batched
   *  them. Measured on a cancelled 27-scene batch: turn lengths 419 → 827 → 1237 chars
   *  for three prompts, carrying the user's original message along at the bottom. */
  runError?: boolean;
  /** #1489 — the TAB this run-error notice came from. Coalescing is scoped to it: the
   *  item keeps ONE `mid`, and that mid is what pins the error-handling turn to the
   *  erroring workflow's tab (#884 P0 — "a render error on A silently editing B"). Folding
   *  a notice from tab B into tab A's item would discard B's origin and route "diagnose and
   *  fix it" at A's graph, which is that exact P0 reintroduced (codex). Same tab, same pin,
   *  safe to merge; different tab, keep them apart. */
  runErrorOriginTab?: string;
}

/** The turn currently in flight, captured at dispatch so an interrupt or a
 *  mid-turn crash can re-queue it. */
export interface InFlightTurn {
  text: string;
  images?: ImageRef[];
  /** Audio attachments this turn is carrying (#790). */
  audio?: AudioRef[];
  /** Run-completion journal tokens this turn is carrying (#468). */
  eventTokens?: string[];
  /** The ORIGINAL queue items this turn was built from. A re-queue restores
   *  THESE, not one merged item, so an injected run completion stays its own
   *  `completionOnly` item instead of being welded into a user turn's text
   *  (#468). Without that, held mail could retain a completion's TEXT after its
   *  token had been handed back and replayed elsewhere — one completion, two
   *  agent turns, the second indistinguishable from a real one. */
  items: QueueItem[];
}

export interface PanelAgentDeps {
  /** mcpServers config for the spawned agent (the comfyui MCP). */
  mcpServers: Options["mcpServers"];
  /** Base URL of the ComfyUI instance, for fetching image bytes (/view). */
  comfyuiUrl?: string;
  /** Persona appended to the claude_code system-prompt preset. */
  systemAppend: string;
  /** Pinned model (e.g. claude-opus-5). */
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
  /** Report the SDK session id once known, so the panel can persist/resume it.
   *  `model` is the SDK-resolved model (#376), used to correct the ready banner. */
  onSession?: (tabId: string, sessionId: string, model?: string) => void;
  /** #1516 — the cumulative automatic-preview ledger changed (previews were
   *  committed to a turn, or delivery stopped at the budget). The manager
   *  persists it beside the session id so an orchestrator RESTART does not
   *  reset the budget while the provider conversation it bounds lives on. */
  onPreviewLedger?: (tabId: string, ledger: PreviewLedger) => void;
  /** #1516 — the durable ledger the session store holds for the conversation
   *  this agent is expected to resume. Adopted ONLY when the live session id
   *  proves to be exactly `sid`; a different conversation starts at zero. */
  initialPreviewLedger?: PreviewLedger & { sid: string };
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
  /** #468 — the turn CARRYING these run-completion journal tokens ended, so the
   *  completions genuinely reached the agent. The journal drops them. */
  /** #486 — `carrier` identifies the AGENT INSTANCE whose turn carried these
   *  tokens, so a journal can refuse an ack from anything else. */
  onEventDelivered?: (tabId: string, tokens: string[], from?: { carrier?: string }) => void;
  /** #468 — these run-completion journal tokens are being handed BACK for replay.
   *  `carried` true means a turn actually DISPATCHED with them and then ended
   *  (the agent read the text; only its ack couldn't be proven) — the journal
   *  bounds that cycle. `carried` false/absent means a teardown handed them back
   *  and NOBODY read them, which must never count toward that bound. */
  onEventUndelivered?: (tabId: string, tokens: string[], opts?: { carried?: boolean }) => void;
  /** In-process MCP server giving the agent LIVE control of this tab's graph. */
  panelServer?: McpSdkServerConfigWithInstance;
  /**
   * Absolute path to the bundled comfyui-mcp plugin dir. When set, its skills
   * (IDEOGRAM/WAN/LTX/etc. expertise) are loaded into the agent so it's an
   * expert out of the box. Omitted if the plugin can't be found.
   */
  pluginPath?: string;
  /** Live Blind-mode predicate (issue #90, conversation-wide per #884). The
   *  Claude backend's PreToolUse gate reads it at each NATIVE tool call —
   *  the SDK subprocess's own Read/WebFetch deliver pixels outside the MCP
   *  scrub, so per-spawn env alone cannot keep the Blind promise. */
  isBlind?: () => boolean;
}

/**
 * One persistent streaming session for a single panel tab. Messages typed in
 * the panel are queued via `send()` and yielded into the live `query()` session
 * as user turns; the session never closes until `stop()`.
 */
export class PanelAgent {
  /** This agent's own (composite `tabId::backend`) key. MUTABLE only via
   *  {@link rebindTabId}: a panel tab-id migration re-keys the manager's map, and
   *  the agent must move WITH it or every `this.tabId` read (callbacks, bridge
   *  pushes, sessionStore persistence, the bound panel MCP server) keeps addressing
   *  the DEAD pre-migration tab (#568 Defect 1). */
  tabId: string;
  /**
   * Identity of THIS agent object, for the whole of its life (#486).
   *
   * Deliberately independent of `tabId`: a tab-id migration re-keys the same
   * conversation and must NOT invalidate an ack, while a provider switch builds a
   * NEW agent — which is exactly the case that must not be able to certify the
   * previous conversation's answer. The instance is the thing that distinguishes
   * those two, so the carrier identity is the instance and nothing else.
   */
  private static instanceSeq = 0;
  readonly carrierId = `pa${++PanelAgent.instanceSeq}`;
  private deps: PanelAgentDeps;
  /** The injected provider adapter (Claude today). PanelAgent owns the queue,
   *  turn-gate, rewind tracking and self-restart; the backend owns the SDK call,
   *  option building, and SDKMessage→AgentEvent normalization. */
  private backend: AgentBackend;
  private queue: Array<QueueItem> = [];
  private waiting: (() => void) | null = null;
  private closed = false;
  /** The user message(s) of the turn currently in flight — captured at dispatch so
   *  an INTERRUPT (panel "send now") can RE-QUEUE the interrupted text ahead of the
   *  new message, instead of dropping the work the agent was mid-reply on. Cleared
   *  on a clean turn result (nothing to re-queue) and on stall/rewind (abandoned on
   *  purpose). Null whenever no turn is in flight. */
  private inFlight: InFlightTurn | null = null;
  /** Run-completion journal tokens carried by the turn currently in flight
   *  (#468). Acked when that turn's `result` lands; handed back to the journal
   *  when the turn is abandoned (stall watchdog) or the agent is stopped. */
  private turnEventTokens: string[] = [];
  /** The turn marker `turnEventTokens` belongs to (#468). A completion is acked
   *  only by the result of the turn that CARRIED it — see the `result` case. */
  private turnEventTokensMarker = 0;
  /**
   * Has the backend produced ANY event for the turn currently in flight?
   *
   * This is what "carried" means for #468's bounded replay: the token is
   * attached at DISPATCH, but the backend may not have consumed the yielded turn
   * yet (Claude awaits output-image resolution before submitting it). Aborting
   * in that window — a rewind, or the watchdog on a turn that produced nothing —
   * means the completion never reached the model, so it must NOT count toward
   * the settle bound. One event is proof of receipt. Reset at each dispatch.
   */
  private turnProducedEvents = false;
  /** True while a turn is in flight (working→done). Lets the manager defer a
   *  session-restarting option change (effort) until the turn finishes, instead
   *  of interrupting and silently dropping the in-flight reply. */
  private busy = false;
  /** True once THIS turn's failure has been surfaced to the user — set by the
   *  `error` event case so an error-subtype `result` right behind it doesn't
   *  paint a second failure line. Reset when a turn starts (busy = true). */
  private errorSurfaced = false;
  /** True between a USER-initiated interrupt (Stop / send-now) and the aborted
   *  turn's terminal result. The Claude SDK reports an interrupted turn as an
   *  error-subtype result (error_during_execution), which the never-end-in-
   *  silence guard below would otherwise paint as "⚠️ That turn failed" — a
   *  scary failure line for something the user did on purpose. Cleared on the
   *  next result and at the next turn dispatch, so a REAL later failure still
   *  surfaces. */
  private interruptRequested = false;
  // ---- turn idle watchdog (freeze safety net) ----
  // A stalled turn (the backend stops emitting ANY events — e.g. a wedged Codex
  // app-server) would otherwise leave the panel "working" forever. This is an
  // IDLE timer (reset on every received event), NOT a hard turn cap: legit tool
  // work is slow but still streams progress/tool events, so only a TRUE stall
  // (no events at all for the whole window) trips it. A capable provider first
  // receives an explicit harness-stall notice, never a synthetic user rejection.
  // If that recovery is unavailable or remains silent for another window, the
  // guarded interrupt() flow provides the existing bounded gate-release fallback
  // so the next queued batch never runs ahead of a wedged turn settling (#728).
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guards against a trip firing twice / racing a real result for one turn. */
  private idleTripped = false;
  /** A provider-native, non-user-cancel recovery is attempted at most once per turn. */
  private stallRecoverySteered = false;
  /** Tool calls started (item/started) but not yet ended (item/completed). A tool
   *  in flight is legitimate work even when the app-server sends nothing, so the
   *  watchdog defers while this is > 0 — the fix for the #307-review finding that
   *  narrowing raw-notification liveness could false-trip a long silent tool call.
   *  Reset per turn so a leaked start can't wedge the next turn's watchdog. */
  private openToolCalls = 0;
  /** When the current run of open tool calls began (0 → 1 transition), so the
   *  defer can be bounded by TOOL_BUSY_MAX_MS. */
  private toolBusySince = 0;
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
  /** The turn number the pending interrupt-release fallback is guarding — the turn
   *  an interrupt aborted. The fallback force-releases only while THIS turn is still
   *  the one parked on the gate, so a stale timer can't cut a later, legit turn
   *  short. Refreshed on every interrupt(). See armInterruptReleaseFallback(). */
  private interruptGuardTurn = 0;
  /** Monotonic marker of the CURRENT in-flight turn, mirrored from the backend's
   *  mint: the backend increments its marker once per turn it reads from the
   *  channel and stamps it on every event of that turn; PanelAgent increments
   *  this once per turn it YIELDS — same sequence, same reset point (run start)
   *  — so the Nth dispatched turn's events all carry marker N (#728 r3). Events
   *  stamped with an OLDER marker are stragglers from an abandoned turn and are
   *  dead-lettered (see handleEvent). Backends that never stamp (turn undefined)
   *  get NO dead-lettering — previous behavior. */
  private currentTurnMarker = 0;
  /** Marker of the turn the interrupt-release fallback most recently ABANDONED
   *  (force-released with no terminal result). Its stragglers are provably dead
   *  even before the next dispatch increments currentTurnMarker. 0 = none. */
  private abandonedTurnMarker = 0;
  /** Mutable so the model/effort picker can change them at runtime. */
  private model: string;
  private effort?: Effort;
  /** UUID of the last assistant message seen — reported as the turn anchor on
   *  result, and used as the resume point when forking (rewind). */
  private lastAssistantUuid: string | null = null;
  /** Set by requestRewind() to fork the session on the next (re)start. `anchor`
   *  is the assistant UUID to resume up to (drop everything after); null = fresh. */
  private pendingRewind: { anchor: string | null } | null = null;
  /** #1700 — next start resumes history into a NEW session so the current
   *  mcpServers (re-read from ~/.claude.json) replace the session-recorded set. */
  private pendingForkOnResume = false;
  /** Captured from the session's init message; enables resume across restarts. */
  sessionId: string | null = null;
  /** #1516 — cumulative AUTOMATIC previews committed to turns of the CURRENT
   *  provider conversation (charged at the drain, the point of fact). Reset
   *  whenever the session id changes: a fresh conversation starts at zero. */
  private previewImagesCharged = 0;
  /** #1516 — the byte half of the ledger ADOPTED from the durable store (see
   *  initialPreviewLedger). Live bytes come from the backend; the total is
   *  previewBytesBase + backend.automaticPreviewBytes(). */
  private previewBytesBase = 0;
  /** #1516 — automatic previews composed but NOT delivered, accounted where the
   *  withholding was decided (session budget at inject, either budget at the
   *  drain trim). Diagnostics; each was named in an agent-visible note. */
  private previewWithheldSession = 0;
  /** #1516 — the session id the charged ledger belongs to; reconciled lazily. */
  private previewLedgerSid: string | null = null;
  /** #1516 — durable ledger awaiting adoption once the live session id proves
   *  to be the conversation it was recorded against (never applied blindly). */
  private pendingPreviewLedger: (PreviewLedger & { sid: string }) | null = null;
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
  /** The model the IN-FLIGHT turn was dispatched with. A live setModel can change
   *  this.model mid-turn (the outgoing turn still runs on the old model), so the
   *  result event's contextWindow must only be cached when the turn's model still
   *  matches the current one — otherwise a late old-model result would restore the
   *  wrong denominator after a switch (#543). */
  private turnModel: string | null = null;
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
    this.pendingPreviewLedger = deps.initialPreviewLedger ?? null;
    // Default to the Claude adapter; injectable so a future toggle can swap it.
    this.backend =
      backend ??
      new ClaudeBackend({
        mcpServers: deps.mcpServers,
        comfyuiUrl: deps.comfyuiUrl,
        systemAppend: deps.systemAppend,
        panelServer: deps.panelServer,
        pluginPath: deps.pluginPath,
        isBlind: deps.isBlind,
      });
  }

  private short(): string {
    return this.tabId.slice(0, 8);
  }

  /** Re-point this agent onto a migrated tab id (#568 Defect 1). The manager's
   *  rebindAgent() re-keys its map, but the agent ALSO carries its own tabId —
   *  every callback (onTurn/onSay/onSession → sessionStore) fires with it, bridge
   *  pushes route by it, and the bound panel MCP server resolves `panel_*` against
   *  it. Left stale, the agent keeps addressing the DEAD pre-migration tab
   *  (panel_* → "no connected tab"; pushes/persists land under an orphaned id).
   *  Update the field AND the panel server's bound tab so nothing drifts.
   *  `panelTabId` is the bare panel id (no ::backend) the panel server binds to. */
  rebindTabId(newKey: string, panelTabId: string): void {
    this.tabId = newKey;
    const server = this.deps.panelServer as
      | (McpSdkServerConfigWithInstance & { rebindTab?: (t: string) => void })
      | undefined;
    server?.rebindTab?.(panelTabId);
  }

  /** Queue a panel message and wake the streaming generator (the "channel in").
   *  `images` are ComfyUI refs delivered inline as image blocks (vision). */
  send(
    text: string,
    opts?: {
      title?: string;
      images?: ImageRef[];
      audio?: AudioRef[];
      mid?: string;
      eventTokens?: string[];
      /** Re-delivery of an injected panel event (#468). MUST be preserved by every
       *  carry-over path: an item that loses this marker is a completion the
       *  detach logic can no longer remove from held mail, so its text survives
       *  after its token has been replayed elsewhere — one completion, two turns. */
      completionOnly?: boolean;
    },
  ): void {
    if (opts?.title) this.title = opts.title;
    this.queue.push({
      text,
      images: opts?.images,
      audio: opts?.audio,
      mid: opts?.mid,
      ...(opts?.completionOnly ? { completionOnly: true } : {}),
      ...(opts?.eventTokens?.length ? { eventTokens: [...opts.eventTokens] } : {}),
    });
    const wake = this.waiting;
    this.waiting = null;
    wake?.();
  }

  /** Hand a set of run-completion journal tokens back as UNDELIVERED (#468), so
   *  the journal re-arms them for replay instead of letting them die with this
   *  agent / this abandoned turn. Never throws into the caller's path. */
  /** Capture-and-clear the in-flight turn in one step. Also the read that
   *  survives control-flow narrowing (channel() assigns `inFlight` from another
   *  function, so a direct read after a `= null` looks like `never` to TS). */
  private takeInFlight(): InFlightTurn | null {
    const turn = this.inFlight;
    this.inFlight = null;
    return turn;
  }

  private releaseEventTokens(tokens: string[] | undefined, opts: { carried?: boolean } = {}): void {
    if (!tokens?.length) return;
    try {
      this.deps.onEventUndelivered?.(this.tabId, [...tokens], opts);
    } catch (err) {
      logger.warn(`[panel-agent ${this.short()}] releasing completion tokens: ${msgOf(err)}`);
    }
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
    this.pendingForkOnResume = false; // rewind owns the next start's fork shape
    // The dropped turn may have been carrying a run completion — that is news,
    // not conversation, so hand it back for replay rather than rewinding it away
    // (#468).
    const rewoundTokens = this.turnEventTokens;
    this.turnEventTokens = [];
    // CARRIED only if the backend actually RECEIVED this turn. A rewind during
    // the pre-submission window (Claude resolving output images) aborts a turn
    // the model never saw, and counting that toward the settle bound could
    // retire a completion nobody read.
    this.releaseEventTokens(rewoundTokens, { carried: this.turnProducedEvents });
    // Break the current stream so start()'s loop re-enters and forks.
    void this.backend.interrupt().catch(() => {});
    const wake = this.waiting;
    this.waiting = null;
    wake?.();
  }

  /** #1700 — next start resumes history into a NEW session so the current
   *  mcpServers replace the set recorded with the old session. */
  requestForkOnResume(): void {
    this.pendingForkOnResume = true;
  }

  /**
   * Pull a still-queued INJECTED COMPLETION back off the queue by its journal
   * token (#468). Returns true only if it was found and removed — false once the
   * turn carrying it has started, where the text is already in the model's
   * context and cannot be recalled.
   *
   * Needed because the event's wording is materialized when it is queued: if the
   * journal later has to WEAKEN that completion's correlation (a prompt id
   * reused, a conversation replaced), the already-queued copy would still claim
   * "this is the run YOU queued". Revoking lets the journal re-deliver the
   * downgraded, honest version instead. Only `completionOnly` items are eligible,
   * so no user message is ever removed.
   */
  revokeEvent(token: string): boolean {
    const i = this.queue.findIndex((item) => item.completionOnly && item.eventTokens?.includes(token));
    if (i < 0) return false;
    this.queue.splice(i, 1);
    return true;
  }

  /**
   * Attach a journal token to the turn that is RUNNING RIGHT NOW (#486).
   *
   * A `panel_ask` answer goes back to the model as a TOOL RESULT, not as an
   * injected event — so it has no hand-off to ack. But the tool call happens
   * INSIDE a live turn, and this class already knows exactly when a turn is
   * proven to have been read: `turnEventTokens` are acked only when that turn's
   * own marked `result` lands (#468). Riding the same wires makes "the model
   * received this answer" a fact rather than an assumption, which is the whole
   * point — a `tools/call` that was abandoned never produces that result, so its
   * token is released unacked and the answer stays accounted for.
   *
   * Returns false when there is no turn in flight to attach to; the caller then
   * treats the answer as unacked, which is the conservative reading.
   */
  attachTurnToken(token: string): boolean {
    if (!this.inFlight) return false;
    if (this.turnEventTokens.includes(token)) return true;
    this.turnEventTokens.push(token);
    return true;
  }

  /** How many AUTOMATIC preview images are already queued for the next turn.
   *
   *  Keyed on `completionOnly`, which marks an injected panel event, so a user's
   *  explicit attachment never spends the preview budget — #1516 asks for those
   *  to have their own reviewed policy rather than sharing this one implicitly. */
  private queuedPreviewImageCount(): number {
    return this.queue.reduce(
      (n, it) => n + (it.completionOnly ? (it.images?.length ?? 0) : 0),
      0,
    );
  }

  /** #1516 — keep the cumulative preview ledger attached to the conversation it
   *  measures. The session id only becomes known at the init event and can
   *  change under us (fresh fork, resume-miss restart, provider switch), so
   *  this runs lazily at every budget decision: a new id resets the ledger to
   *  zero, and the durable pending ledger is adopted ONLY when the live id is
   *  exactly the one it was recorded against — a ledger applied to the wrong
   *  conversation would either starve a fresh one or un-bound an old one. */
  private reconcilePreviewLedger(): void {
    if (this.sessionId === this.previewLedgerSid) return;
    this.previewLedgerSid = this.sessionId;
    this.previewImagesCharged = 0;
    this.previewBytesBase = 0;
    this.previewWithheldSession = 0;
    if (this.sessionId && this.pendingPreviewLedger) {
      if (this.pendingPreviewLedger.sid === this.sessionId) {
        this.previewImagesCharged = this.pendingPreviewLedger.images;
        this.previewBytesBase = this.pendingPreviewLedger.bytes;
      }
      this.pendingPreviewLedger = null;
    }
  }

  /** #1516 — cumulative delivered automatic-preview BYTES for the current
   *  conversation: the durable base (pre-restart) plus what this process's
   *  backend actually fetched. Backends that do not report bytes contribute
   *  zero and are bounded by the image count alone. */
  private sessionPreviewBytes(): number {
    return this.previewBytesBase + (this.backend.automaticPreviewBytes?.() ?? 0);
  }

  /** #1516 — how many automatic previews this conversation may still receive:
   *  the tighter of the remaining COUNT and the remaining BYTES. Bytes
   *  delivered so far is what is knowable here — the in-flight turn's fetches
   *  have not happened yet — so the byte gate can overshoot by at most one
   *  turn's worth; the backend enforces the same budget at fetch time, which
   *  is the bound of record (see codex-backend's image loop). */
  private sessionPreviewBudgetLeft(): number {
    this.reconcilePreviewLedger();
    if (this.sessionPreviewBytes() >= MAX_SESSION_PREVIEW_BYTES) return 0;
    return Math.max(0, MAX_SESSION_PREVIEW_ATTACHMENTS - this.previewImagesCharged);
  }

  /** #1516 — the cumulative automatic-preview ledger, for diagnostics: what was
   *  delivered to the current provider conversation, what was withheld at the
   *  session budget, and the budget itself. */
  previewBudgetStatus(): PreviewLedger & {
    withheld: number;
    budgetImages: number;
    budgetBytes: number;
  } {
    this.reconcilePreviewLedger();
    return {
      images: this.previewImagesCharged,
      bytes: this.sessionPreviewBytes(),
      withheld: this.previewWithheldSession,
      budgetImages: MAX_SESSION_PREVIEW_ATTACHMENTS,
      budgetBytes: MAX_SESSION_PREVIEW_BYTES,
    };
  }

  /** #1516 — persist the ledger through the manager so an orchestrator restart
   *  does not reset a budget the still-living provider conversation keeps
   *  accumulating against. Bytes are read NOW (the in-flight turn's fetches
   *  lag), so the stored value is a lower bound — disclosed, and refreshed on
   *  every later change. */
  private reportPreviewLedger(): void {
    if (!this.deps.onPreviewLedger) return;
    try {
      this.deps.onPreviewLedger(this.tabId, {
        images: this.previewImagesCharged,
        bytes: this.sessionPreviewBytes(),
      });
    } catch (err) {
      logger.debug(`[panel-agent ${this.short()}] preview-ledger report failed: ${msgOf(err)}`);
    }
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
  injectEvent(
    ev: {
      kind?: string;
      images?: ImageRef[];
      error?: string;
      note?: string;
      // #1574 — set by the orchestrator when the job RECORD still reads "downloading" for
      // a row claiming done. Disclosed on the event; never used to suppress it.
      downloads?: Array<{
        name: string;
        status: string;
        supersededByLive?: boolean;
        recordDisagrees?: boolean;
      }>;
      /** #468 — run identity + how it correlates to a run this session queued. */
      prompt_id?: string;
      run_correlation?: "matched" | "foreign" | "unidentified";
      run_correlation_prior?: boolean;
      replayed?: boolean;
      dropped_completions?: number;
      possible_repeat?: boolean;
      /** #486 - a validated `panel_ask` answer that no tool call was alive to
       *  receive, carried together with the question it (and only it) answers. */
      ask_question?: string | null;
      ask_answer?: string;
      ask_correlation?: "matched" | "foreign";
      ask_answered_at?: number;
      dropped_answers?: number;
    },
    opts?: {
      eventToken?: string;
      /** #884 P0 — synthetic origin mid: rides the queue so the injected turn
       *  fires onSeen at dequeue and acquires its origin pin/stamp like any
       *  user turn (a run error on tab A must pin A, never follow the active
       *  tab — confirming-gate 2). */
      mid?: string;
    },
  ): boolean {
    // A closed agent's queue is never drained again, so accepting an event here
    // would silently swallow it (#468). REFUSE — and deliberately do NOT hand the
    // token back through onEventUndelivered: the caller is the journal's own
    // flush, which keeps a refused entry pending from the `false` return. Calling
    // back would recurse (release → flush → inject → release → …).
    if (this.closed) return false;
    let text: string | null = null;
    let images: ImageRef[] | undefined;
    if (ev.kind === "executed") {
      const imgs = ev.images ?? [];
      const correlationIsUntrusted =
        ev.run_correlation === "foreign" || ev.run_correlation === "unidentified";
      // Bound the SAME list that becomes the attachment. An entry with no
      // filename has never been attachable — this filter used to sit down at the
      // `images =` assignment, long before any bound existed — so counting one
      // here would make the sentence below claim a number of pixels the turn does
      // not carry, and blame the bound for a drop it did not cause. `filename:
      // string` is the TYPE; the payload arrives over the wire, which is why
      // `names` still needs its own "(unnamed)" fallback.
      const attachableImgs = imgs.filter((i) => i.filename);
      // Spend what is LEFT of this turn's budget, not a fresh 8. Everything
      // already queued is drained into the same turn as this event, so a per-
      // event cap is not a cap at all. Synchronous from here to `queue.push`
      // below, so nothing drains in between — but this counts the QUEUE only. A
      // batch already in flight is invisible here and can be requeued back onto
      // this one, which is why the drain corrects the count rather than trusting
      // it (see MAX_RUN_COMPLETION_IMAGE_ATTACHMENTS).
      const previewBudgetLeft = Math.max(
        0,
        MAX_RUN_COMPLETION_IMAGE_ATTACHMENTS - this.queuedPreviewImageCount(),
      );
      // #1516 — ...AND what is left of the CONVERSATION's cumulative budget.
      // The per-turn bound above stops one turn from going unbounded; this one
      // stops N turns from accumulating 8N inline images into a Codex rollout
      // that compaction then recopies without a media-aware bound. Queued
      // previews are charged against the session budget HERE too (they drain
      // into this conversation), so a burst queueing behind a busy turn cannot
      // over-commit it. `sessionBound` remembers WHICH budget spoke, so the
      // notice below names the bound that actually fired.
      const sessionBudgetLeft = Math.max(
        0,
        this.sessionPreviewBudgetLeft() - this.queuedPreviewImageCount(),
      );
      const sessionBound = sessionBudgetLeft < previewBudgetLeft;
      const effectiveBudget = sessionBound ? sessionBudgetLeft : previewBudgetLeft;
      const attachedImgs = correlationIsUntrusted
        ? []
        : attachableImgs.slice(0, effectiveBudget);
      const omittedImgs = attachableImgs.length - attachedImgs.length;
      // #1516 — account for what the SESSION budget withheld (diagnostics +
      // durable ledger). Only the session-bound case counts here: a per-turn
      // trim is the pre-existing turn budget doing its job, and an untrusted
      // correlation never had pixels to withhold.
      if (sessionBound && !correlationIsUntrusted && omittedImgs > 0) {
        this.previewWithheldSession += omittedImgs;
        this.reportPreviewLedger();
      }
      // The unnamed remainder. Every sentence below counts outputs with
      // `imgs.length` but attaches and names from `attachableImgs`, so on a MIXED
      // event — one output with a filename, one without — the two disagree and
      // nothing said so: the turn reported 2 outputs, attached 1, and closed with
      // "The image(s) are attached below". The all-unnamed case has its own branch;
      // this is the case where a named sibling kept the generic wording alive, and
      // it also makes `omittedImgs` understate the drop above 8. Unnamed outputs
      // have no coordinates, so the honest remedy here is get_history, not
      // get_image — offering a fetch we cannot address is the false remedy the
      // sibling branches already refuse.
      const unnamedImgs = imgs.length - attachableImgs.length;
      // What the agent is NOT being shown, in coordinates it can actually call
      // get_image with. `names` is filenames only and a `note` replaces it
      // outright, so neither can carry a withheld PreviewImage that lives in
      // `temp` or a subfolder — get_image would default to type "output" and
      // miss it. Withholding pixels is only honest if the pointer works.
      const withheldImgs = correlationIsUntrusted
        ? attachableImgs
        : attachableImgs.slice(attachedImgs.length);
      const withheldRefs = describeImageRefs(withheldImgs);
      const names = imgs.map((i) => i.filename).filter(Boolean).join(", ") || "(unnamed)";
      // A custom `note` (e.g. the panel's video-storyboard summary) replaces the
      // default image-acknowledgement wording so the agent is told accurately
      // what it's looking at (a contact sheet of a video, not a still image).
      const note = typeof ev.note === "string" && ev.note.trim() ? ev.note.trim() : null;
      text =
        `[panel event] ` +
        // #468 — a completion that was journaled and re-delivered says so, so the
        // agent reads it as "this landed late", not as a second render.
        (ev.replayed
          ? `(RE-DELIVERED — this completion could not be handed to you when it arrived.) `
          : ``) +
        // An eviction dropped older completions for this tab — say so rather than
        // let them disappear (#468). The agent must treat those runs as unknown.
        (typeof ev.dropped_completions === "number" && ev.dropped_completions > 0
          ? `⚠️ ${ev.dropped_completions} EARLIER completion(s) for this tab could not be delivered and were dropped — treat the outcome of those runs as UNDETERMINED and check get_history (action:"list") if you were waiting on one. `
          : ``) +
        // An id-less completion whose content matches one already reported. We
        // will NOT swallow it (identical content is not proof of identity, and a
        // swallowed render is a silent loss), so hand the judgement to the agent.
        (ev.possible_repeat
          ? `⚠️ POSSIBLE REPEAT: a completion with identical outputs was already reported to you recently, and this one carries no prompt id to tell them apart. It may be the same event re-sent, or a second render that produced identical filenames — do NOT count it twice without checking with get_history (action:"list"). `
          : ``) +
        runIdentityPreamble(ev) +
        (note
          ? `${note} `
          : `A run on the user's canvas just finished and produced ${imgs.length} output image(s): ${names}. `) +
        // Only claim images are attached when some actually are (a note-only event —
        // e.g. a video that produced no storyboard — has none), and only when this
        // backend can actually see them — a text-only backend told "attached below"
        // would confabulate having viewed the render.
        // Withheld pixels are disclosed WITH their coordinates, so the remedy is
        // callable rather than reassuring (#1516). Deliberately not "nothing was
        // lost": preview outputs live in ComfyUI's temp folder and a restart
        // clears it, so the honest claim is that a fetch is the way to look — not
        // that the fetch is guaranteed to succeed.
        (imgs.length
          ? this.backend.capabilities.vision
            ? correlationIsUntrusted
              ? // An UNDETERMINED run can also arrive with no usable filename —
                // this is the id-less case, so that pairing is ordinary, not
                // exotic. Offering "fetch it with get_image:" followed by an
                // empty list would be the exact false remedy this branch exists
                // to avoid.
                withheldRefs
                ? `The outputs are already shown to the user in the panel, but their pixels are NOT attached to this agent turn because the run's origin is UNDETERMINED. Fetch one with get_image action:"get" if you need to look: ${withheldRefs}. `
                : `The outputs are already shown to the user in the panel, but their pixels are NOT attached to this agent turn because the run's origin is UNDETERMINED — and the panel reported no usable filename for them, so they cannot be fetched by name either. Check get_history (action:"list") if you need to know what ran. `
              : // Nothing had a usable filename, so nothing COULD be attached —
                // and there are no coordinates to offer either. Say that rather
                // than the default "attached below", which would promise pixels
                // this turn does not carry.
                attachableImgs.length === 0
                ? `The panel reported no usable filename for ${imgs.length === 1 ? "it" : "them"}, so ${imgs.length === 1 ? "it is" : "they are"} NOT attached to this agent turn and cannot be fetched by name — check get_history (action:"list") if you need to see what this run produced. `
                : attachedImgs.length === 0
                  ? sessionBound
                    ? `NONE of these outputs are attached to this agent turn: this conversation's cumulative automatic-preview budget (${MAX_SESSION_PREVIEW_ATTACHMENTS} images / ~${previewByteBudgetLabel()}) is spent — the bound that keeps a long session from accumulating unbounded inline media the provider retains and recopies at compaction. All ${imgs.length} are shown to the user in the panel — fetch one with get_image action:"get" if you need to look: ${withheldRefs}. `
                    : `NONE of these outputs are attached to this agent turn: earlier completion(s) in this same turn already spent its ${MAX_RUN_COMPLETION_IMAGE_ATTACHMENTS}-image preview budget. All ${imgs.length} are shown to the user in the panel — fetch one with get_image action:"get" if you need to look: ${withheldRefs}. `
                  : omittedImgs > 0
                    ? sessionBound
                      ? `The first ${attachedImgs.length} image(s) are attached below; all ${imgs.length} outputs are already shown to the user in the panel. ${omittedImgs} further preview(s) were omitted because this conversation's cumulative automatic-preview budget (${MAX_SESSION_PREVIEW_ATTACHMENTS} images / ~${previewByteBudgetLabel()}) is nearly spent — fetch one with get_image action:"get" if you need it: ${withheldRefs}. `
                      : `The first ${attachedImgs.length} image(s) are attached below; all ${imgs.length} outputs are already shown to the user in the panel. ${omittedImgs} further preview(s) were omitted to keep this TURN's image context bounded — fetch one with get_image action:"get" if you need it: ${withheldRefs}. `
                    : `The image(s) are attached below and already shown to the user in the panel. `
            : `You cannot view images on this provider, but they are already shown to the user in the panel. `
          : ``) +
        // Said on TOP of whichever branch fired, because every one of them is
        // arithmetically incomplete while an unnamed output is in the event: the
        // counts above are over `imgs.length` and the attachments are not. Only
        // reached when something WAS attachable — the all-unnamed case already
        // says this in its own words, and a text-only backend attaches nothing to
        // contradict.
        (imgs.length && this.backend.capabilities.vision && attachableImgs.length && unnamedImgs > 0
          ? `${unnamedImgs} of those ${imgs.length} output(s) arrived with no usable filename, so ${unnamedImgs === 1 ? "it is" : "they are"} NOT attached to this agent turn and cannot be fetched by name — check get_history (action:"list") if you need to see ${unnamedImgs === 1 ? "it" : "them"}. `
          : ``) +
        // #977 — this used to be a FIXED "you do NOT need to call any tools",
        // i.e. "stop now", sent after every render. Paired with panel_run's own
        // "just end your turn now and wait", the emergent default was:
        // queue → end turn → render → one sentence → end turn. A user running a
        // five-variant sweep had to send a message to advance every step, while
        // the system prompt was telling the agent to treat a todo list as a loop
        // and not stop between steps. The per-event text won because it is the
        // most recent and most specific thing in context.
        //
        // The agent's own checklist is the signal: if it declared a plan and
        // entries remain, this render is a STEP, not an ending. Positive
        // evidence only — no checklist, or one that is finished, keeps the
        // acknowledge-and-stop wording, so nothing changes for a single render.
        runCompletionDirective(this.tabId);
      // Attach the outputs inline so the agent SEES the render without a fetch —
      // up to the bound above. Past it (or for an UNDETERMINED origin) the text
      // says so and points at get_image, so a fetch is needed but never a guess.
      if (this.backend.capabilities.vision) {
        // `automatic` is what the backend's cumulative byte ledger keys on —
        // a user's explicit attachment never carries it and never spends the
        // session preview budget (#1516).
        images = attachedImgs.map((i) => ({ ...i, type: i.type ?? "output", automatic: true }));
      }
    } else if (ev.kind === "ask_answer") {
      // #486 — the user ANSWERED a question card, but no tool call was alive to
      // receive it (the `tools/call` that asked had already timed out or been
      // abandoned). The answer was journaled instead of lost; this is it.
      //
      // The QUESTION is always carried with the ANSWER, and the wording pins the
      // answer to that question explicitly. Losing an answer costs a re-ask;
      // letting one be read as the answer to a DIFFERENT question makes the
      // agent act on a decision the user never made — so an answer that could
      // not be tied to a question this session asked says exactly that and asks
      // for nothing to be inferred from it.
      const answer = typeof ev.ask_answer === "string" ? ev.ask_answer : "";
      if (!answer) return false;
      const ageS = Math.max(
        0,
        Math.round((Date.now() - (ev.ask_answered_at ?? Date.now())) / 1000),
      );
      text =
        `[panel event] ` +
        (ev.replayed
          ? `(RE-DELIVERED — this answer could not be handed to you when it arrived.) `
          : ``) +
        (ev.possible_repeat
          ? `⚠️ You may already have been given this answer — do not act on it twice. `
          : ``) +
        (typeof ev.dropped_answers === "number" && ev.dropped_answers > 0
          ? `⚠️ ${ev.dropped_answers} further validated answer(s) on this tab were dropped before delivery — their content is UNDETERMINED. `
          : ``) +
        (ev.ask_correlation === "matched" && ev.ask_question
          ? `The user DID answer a question card you put up ${ageS}s ago, but their answer could not be returned ` +
            `to the panel_ask call that asked (it had already timed out), so the tool reported no answer. Here it is:\n\n` +
            `QUESTION YOU ASKED: ${ev.ask_question}\n` +
            `THE USER'S ANSWER: ${answer}\n\n` +
            `This is their answer to THAT question and to nothing else — do not apply it to any other decision, ` +
            `and do not ask it again. If you already proceeded without it, say so and reconcile. `
          : `A user answered a question card ${ageS}s ago and the answer could NOT be tied to any question this ` +
            `session asked — its meaning is UNDETERMINED. Reported so it is not silently discarded:\n\n` +
            `QUESTION: ${ev.ask_question ?? "(unrecorded)"}\n` +
            `ANSWER: ${answer}\n\n` +
            `Do NOT treat this as the answer to anything you are currently deciding. If you need that decision, ` +
            `ask again with panel_ask. `) +
        `Reply with ONE short sentence and continue — no tool call is required just to acknowledge this.`;
    } else if (ev.kind === "run_error") {
      text =
        `[panel event] The user's workflow run just ERRORED: ${ev.error ?? "unknown error"}. ` +
        `If it relates to what you were doing, diagnose it (panel_get_errors has the details) and offer a fix.`;
    } else if (ev.kind === "download_done") {
      // A model download the agent kicked off (download_model / apply_manifest)
      // just settled. Mirror the render-finished path so the agent is WOKEN with
      // the result instead of having to poll download_model action:"status" in sleep loops
      // (#547). NON-urgent: queued like `executed`, not front-inserted — a landed
      // download never interrupts a live turn. Coalesced upstream (one event per
      // batch of settled downloads for this tab), so a multi-file pack install
      // wakes the agent ONCE, not per file.
      const dl = (ev.downloads ?? []).filter((d) => d && d.name);
      if (dl.length === 0) return false;
      const done = dl.filter((d) => d.status === "done").map((d) => d.name);
      // #1150 — a FAILED attempt whose filename is being downloaded RIGHT NOW by
      // a newer attempt. The two share a name but not an id, so the panel#489
      // supersession key never matched and the eviction never fired: a reporter
      // was woken with "Model download FAILED: <name>" for two files that
      // download_model action:"status" showed streaming at 20% and 13% seconds
      // later. Naming them the same way as a real failure is what made the agent
      // report a false failure to the user.
      const failedDead = dl.filter((d) => d.status !== "done" && !d.supersededByLive);
      const failedRetried = dl.filter((d) => d.status !== "done" && d.supersededByLive);
      const failed = [...failedDead, ...failedRetried].map((d) => d.name);
      const parts: string[] = [];
      // This event is raised by the TRANSFER, which finishes BEFORE the placement
      // check against the connected ComfyUI does. Saying "finished" here would be a
      // bare success claim during that window (#369) — a model can land in an
      // install the running server never reads — so the wording says only what the
      // event actually proves and points at download_model action:"status" for the verdict.
      if (done.length) parts.push(`transfer completed: ${done.join(", ")}`);
      // #1574 — the completion is built from the progress ROW; `download_model
      // action:"status"` answers from the job RECORD. When the record still says the bytes
      // are moving, say so ON the event rather than announcing a bare completion: a reporter
      // got "transfer completed" for an 11.46GB file minutes before it existed on disk, and
      // acted on it. Disclosed, never suppressed — see download-done-guard.ts for why
      // dropping the event would be the worse failure.
      const disagrees = dl.some((d) => d.status === "done" && d.recordDisagrees);
      if (disagrees) parts.push(COMPLETION_DISAGREEMENT_NOTE);
      if (failedDead.length) parts.push(`FAILED: ${failedDead.map((d) => d.name).join(", ")}`);
      if (failedRetried.length) {
        parts.push(
          `an EARLIER attempt failed for ${failedRetried.map((d) => d.name).join(", ")}, but a ` +
            `NEWER download of that name is IN FLIGHT right now — do NOT report these as failed`,
        );
      }
      const plural = dl.length > 1 ? "these downloads" : "it";
      text =
        `[panel event] Model download ${parts.join("; ")}. ` +
        // The claim was UNCONDITIONAL, so a FAILED-only batch asserted that bytes
        // transferred — for a 404, zero bytes moved. Worse, it argued against the
        // correct reading: the reporter's agent had a sentence insisting the
        // transfer completed while the file was still streaming (#1150). It is
        // only ever a statement about the `done` entries.
        (done.length
          ? // #1574 — this sentence ASSERTS the bytes finished. When the job record still
            // says they are moving, that is precisely the claim we cannot make, and stating
            // it right after the caveat argues against our own disclosure — the same defect
            // #1150 fixed here for the FAILED case, in the other direction. Report what the
            // tray said instead of asserting it happened.
            (disagrees
              ? `The tray reported the bytes finished for the completed one${done.length > 1 ? "s" : ""}, ` +
                `but see the caveat above before relying on that; `
              : `The bytes finished transferring for the completed one${done.length > 1 ? "s" : ""}; `) +
            `whether the connected ComfyUI can actually LOAD ${plural} is confirmed separately. `
          : `NOTHING is claimed to have transferred here. `) +
        `If you were waiting on ${plural} to continue a task, ` +
        `call download_model action:"status" FIRST for the verified path and placement verdict${failed.length ? " or the error detail" : ""} — ` +
        `do not tell the user a model is ready until download_model action:"status" confirms it` +
        (failedRetried.length
          ? `, and do not tell them one failed until status shows no live attempt for that name`
          : "") +
        `. Otherwise reply with ONE short sentence acknowledging it and no tool calls.`;
    }
    if (!text) return false;
    this.busy = true;
    this.deps.onTurn?.(this.tabId, "working"); // event triggers a turn — show working
    this.queue.push({
      text,
      images,
      completionOnly: true, // the whole item IS the event — safe to drop wholesale
      // #884 P0 — the (synthetic) mid carries the event's ORIGIN through the
      // queue so the dequeue fires onSeen and the injected turn acquires its
      // origin pin/stamp like any user turn. Without it, an injected turn never
      // pinned and its tool calls followed whatever tab was active (a run
      // error on A silently editing B — confirming-gate 2, P0).
      ...(opts?.mid ? { mid: opts.mid } : {}),
      ...(opts?.eventToken ? { eventTokens: [opts.eventToken] } : {}),
    });
    const wake = this.waiting;
    this.waiting = null;
    wake?.();
    return true;
  }

  /** Push a ComfyUI EXECUTION error into the session with urgency — the "hey,
   *  look at me" path. Renders fail ASYNC (minutes after the agent queued them via
   *  panel_run), so without this the agent never learns and carries on as if the
   *  run succeeded. INTERRUPT any live turn (re-queued so it resumes AFTER the
   *  error), then put the error at the FRONT of the queue so the agent addresses
   *  it before anything else. */
  async injectRunError(
    error: string,
    opts?: { mid?: string; originTab?: string },
  ): Promise<void> {
    if (this.closed) return;
    // #889 — "the workflow run YOU JUST QUEUED" was a fixed template, sent to a
    // session whose agent had never called panel_run at all. It then burned a
    // panel_get_errors round trip on a failure it did not cause, and the
    // imperative made that costly rather than cosmetic: told to STOP and to
    // relate the error to its work, an agent will find a relation.
    const text = runErrorNotice(error);

    // #1489 — A BURST MUST COALESCE, NOT NEST.
    //
    // One error interrupting a user turn is the intended behaviour and stays. The defect
    // is what happens to the SECOND one: the interrupt re-queues the turn it stopped, and
    // after the first error that turn is an error turn — so error N re-queued errors
    // 1..N-1 and the drain batched them into one message. A cancelled 27-scene batch
    // therefore produced a block that grew by one prompt every turn and dragged the user's
    // original message along at the bottom. Reproduced against this method: three prompts
    // gave turns of 419 → 827 → 1237 chars, the last carrying all three plus the user's.
    //
    // Note this is NOT a deduplication problem and a dedupe would not have helped — each
    // notice names a different prompt id, so all N texts are distinct.
    //
    // Two cases, both of which avoid a second interrupt:
    //   • an error turn is already QUEUED and has not started — fold this notice into it,
    //     so N errors arrive as one turn listing N prompts;
    //   • an error turn is already IN FLIGHT — queue normally and let it be picked up
    //     next. Interrupting the agent's error handling to hand it another error just
    //     restarts the work with more text.
    // ORIGIN-SCOPED (codex P0). Not keyed on `mid`: `mintInjectionOrigin` returns a fresh
    // `evt-<uuid>` per event, so mid equality is never true and would disable coalescing
    // outright. The tab is the thing that must match, because the tab is what the pin
    // resolves to.
    const originTab = opts?.originTab;
    const queuedError = originTab
      ? this.queue.find((item) => item.runError && item.runErrorOriginTab === originTab)
      : undefined;
    if (queuedError) {
      queuedError.text = `${queuedError.text}\n\n${text}`;
      return;
    }
    // `some`, NOT `every` — and that distinction is the whole fix. The in-flight turn is a
    // BATCH: the drain merges the re-queued user message with the error notice, so an
    // error turn's items are [error, USER_PROMPT] and `every` is false. Written with
    // `every` first, this branch never fired and the measured turn lengths were
    // byte-identical to the bug (419 → 827 → 1237). The question worth asking is "is the
    // agent already being told about an error", and `some` asks it.
    const inFlightIsError = !!this.inFlight && this.inFlight.items.some((i) => i.runError);
    if (this.inFlight && !inFlightIsError) {
      // Stop the live turn and re-queue it so the agent handles the error FIRST,
      // then resumes whatever it was doing.
      await this.interrupt({ requeueInFlight: true });
    }
    this.busy = true;
    this.deps.onTurn?.(this.tabId, "working");
    // #884 P0 — the synthetic origin mid pins the error-handling turn to the
    // ERRORING workflow's tab (via onSeen at dequeue), so "diagnose and fix it"
    // edits the graph that failed — never whichever tab happens to be active.
    // `runError` marks this as an error notice so a following burst folds into it
    // (#1489) instead of interrupting again and re-queueing this turn.
    this.queue.unshift({
      text,
      runError: true,
      ...(originTab ? { runErrorOriginTab: originTab } : {}),
      ...(opts?.mid ? { mid: opts.mid } : {}),
    }); // front: ahead of any re-queued interrupted turn
    const wake = this.waiting;
    this.waiting = null;
    wake?.();
  }

  /** Switch the model live (the SDK applies it to the next turn). */
  async setModel(model: string): Promise<void> {
    if (model === this.model) return;
    this.model = model;
    // Drop the outgoing model's cached context window (#543). The new model may
    // have a different (smaller) window; scoring the next turn against the old
    // denominator would under-report fill. reportStatus omits contextPct while
    // the cache is 0, so the panel holds its last reading until the next result
    // event refreshes the window for the incoming model. `used` is still reported.
    this.contextWindow = 0;
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
   *  them to the replacement agent instead of dropping them. Items keep their
   *  panel `mid`, so re-delivery still flips the right bubble on dequeue (seen),
   *  AND their run-completion tokens (#468), so a carried-over completion is
   *  acked by the replacement agent rather than replayed as a duplicate. */
  takePending(): Array<QueueItem> {
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
    // The aborted turn's result is EXPECTED (and error-subtyped on the Claude
    // SDK) — don't let the result case report it as a turn failure.
    this.interruptRequested = true;
    // Re-queue the interrupted turn ONLY for "send now" (requeueInFlight) — there
    // the user wants BOTH the interrupted message and the new one answered. A plain
    // Stop / Ctrl+C / Esc (requeueInFlight=false) must NOT re-queue, or it would
    // silently re-run the turn the user just stopped (double tool actions).
    // #468 — the interrupted turn's run-completion tokens travel with its text.
    // Re-queued: they ride the re-queued item and are acked when THAT turn ends.
    // Dropped (plain Stop): hand them back so the completion is replayed rather
    // than dying with the turn the user cancelled.
    const interruptedTokens = this.turnEventTokens;
    this.turnEventTokens = [];
    if (interrupted && opts.requeueInFlight) {
      // Front of the queue: the interrupted work is addressed before whatever the
      // user sends next (which is appended after this interrupt is handled). The
      // ORIGINAL items go back (not one merged item) — the next splice re-joins
      // them into the same text, while an injected completion stays a separate
      // `completionOnly` item that a later detach can remove cleanly (#468).
      this.queue.unshift(...interrupted.items);
    } else {
      // UNCARRIED on purpose. This is a plain Stop — a deliberate human act that
      // does not repeat on its own, so it cannot form the automatic loop the
      // bound exists to break; settling a completion on the user's third Stop
      // would be a surprise, not a safeguard. (The stall watchdog and rewind DO
      // auto-repeat, so those are carried.)
      this.releaseEventTokens(interruptedTokens);
    }
    // Track the turn this interrupt is aborting (the one holding the gate). The
    // fallback only force-releases while THIS turn is still the one parked on the
    // gate, so a stale timer left by an idle/settled interrupt can't cut a LATER,
    // legit turn short. Updated on every interrupt (a storm keeps it pointed at the
    // still-stuck turn); the coalesced timer keeps the earliest deadline.
    this.interruptGuardTurn = this.yieldedTurns;
    // Arm the fallback BEFORE the await, not in a `finally` after it: if
    // backend.interrupt() itself hangs, a `finally`-armed net would never start and
    // the gate would stay parked forever. Armed here, the timer runs regardless;
    // a result that lands first calls completeTurn → clears it (no premature fire).
    // Do NOT force the gate open synchronously — that fed the next batch (the
    // re-queued turn + the "send now" message) into the backend before the aborted
    // turn had settled, so the SDK took the message but started no turn on it (wedged
    // until the idle watchdog). Let the aborted turn's `result` drive completeTurn()
    // at the right moment; the fallback only fires if no result ever arrives.
    this.armInterruptReleaseFallback();
    try {
      await this.backend.interrupt();
    } catch (err) {
      logger.debug(`[panel-agent ${this.short()}] interrupt: ${msgOf(err)}`);
    }
  }

  /** Bounded safety net for interrupt(): if the aborted turn's `result` (which
   *  opens the gate via completeTurn) hasn't arrived shortly, force the gate so an
   *  interrupt can't stop cold. Cancelled by completeTurn()/releaseTurns().
   *
   *  ROBUST TO AN INTERRUPT STORM (#568 Defect 2). The old version did
   *  `clearTimeout` + re-arm on EVERY interrupt, so a burst of "send now" landing
   *  closer together than the window kept cancelling the pending net before it
   *  could ever fire — the gate stayed shut and NO turn started again ("Interrupted."
   *  with PENDING messages that no send-now flushes). The fix:
   *   1. COALESCE — if a timer is already armed, keep it. The net set by the FIRST
   *      interrupt of an unsettled burst is an ABSOLUTE ceiling that later interrupts
   *      cannot postpone. completeTurn/releaseTurns clear it, so a burst that DOES
   *      settle (a result lands) re-arms a fresh ceiling on the next interrupt.
   *   2. GUARD by the tracked interrupted turn (`interruptGuardTurn`), NOT the bare
   *      live gate. A stale timer left by an idle or already-settled interrupt must
   *      not fire against a LATER legit turn that merely happens to be parked — only
   *      release while the turn this interrupt aborted is still the one stuck. The
   *      guard is refreshed on every interrupt, so a storm keeps it pointed at the
   *      still-stuck turn while the coalesced deadline holds. */
  private armInterruptReleaseFallback(): void {
    if (this.interruptReleaseTimer) return; // coalesce — keep the earliest deadline
    this.interruptReleaseTimer = setTimeout(() => {
      this.interruptReleaseTimer = null;
      if (this.closed) return;
      // Fire only if the tracked interrupted turn still hasn't completed. A result
      // would have called completeTurn → advanced completedTurns AND cleared this
      // timer, so surviving to fire here means the gate is genuinely stuck on it.
      if (this.completedTurns < this.interruptGuardTurn) {
        logger.debug(
          `[panel-agent ${this.short()}] interrupt: no result within ${INTERRUPT_RELEASE_FALLBACK_MS}ms — releasing the gate`,
        );
        // Mark the abandoned turn CLOSED: its terminal result never arrived, so
        // its straggler emissions are provably dead (their stamped marker is ≤
        // this watermark) and dead-letter rather than paint against — or complete
        // the gate of — the turn that replaces it.
        this.abandonedTurnMarker = this.currentTurnMarker;
        this.releaseTurns();
      }
    }, INTERRUPT_RELEASE_FALLBACK_MS);
    this.interruptReleaseTimer.unref?.();
  }

  /** INVARIANT that makes the net starvation-free rather than merely eventually-
   *  scheduled, and the reason every clear lives behind this one seam: the fallback is
   *  only ever cleared at a point where the gate is (or is about to be) OPEN —
   *  completeTurn() and releaseTurns() both open it, and start()'s session-ended clear
   *  is followed by a counter reset on the next loop iteration. So "an interrupt
   *  happened and the gate is still closed" implies a timer is armed, and that timer's
   *  deadline was set by the FIRST interrupt of the burst (arm coalesces) while its
   *  guard tracks the LATEST interrupt's still-stuck turn. A storm can therefore neither
   *  postpone the release nor aim it at the wrong turn. Any new clear site must preserve
   *  this — clearing while the gate stays shut re-creates the #568 wedge. */
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
    // #468 — every run completion this agent still holds (queued-but-unread, or
    // carried by the turn we're tearing down) goes BACK to the journal. A tab
    // that is genuinely gone has its entries dropped explicitly by the
    // orchestrator (forget); everything else is replayed into the replacement
    // agent. Done before the awaits below so a concurrent spawn can pick them up.
    const orphanedTokens = [...this.queue.flatMap((it) => it.eventTokens ?? []), ...this.turnEventTokens];
    this.turnEventTokens = [];
    for (const item of this.queue) delete item.eventTokens;
    this.releaseEventTokens(orphanedTokens);
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
      // Coerce each part before joining: a structured payload that slipped past
      // ingress would otherwise stringify to "[object Object]" here (#175).
      let text = batch.map((it) => promptText(it.text)).join("\n\n");
      // #1516 — THE PER-TURN CEILING ON AUTOMATIC PREVIEWS, and the reason it
      // lives here rather than only at injectEvent: this line is where N
      // completions become ONE turn. A per-event cap of 8 measured 32 images on
      // one turn for four queued completions.
      //
      // injectEvent's budget is the ESTIMATE — true when written, and blind to
      // any batch already in flight. This is the FACT. The two diverge on a
      // measured path (in-flight previews requeued beside a completion that
      // budgeted as if the queue were empty), which is why the block below
      // corrects the notices instead of assuming they agree with the outcome.
      // A user's own attachment is never touched — only `completionOnly` items,
      // which are the injected panel events.
      // The drain is also where the CUMULATIVE session budget (#1516) meets the
      // fact of the turn: the ceiling is the tighter of the per-turn 8 and what
      // the conversation has left. injectEvent already charged queued previews
      // against its estimate, so an in-flight batch (invisible there) is the
      // divergence this line absorbs — same estimate/fact split as the per-turn
      // budget above.
      let previewBudget = Math.min(
        MAX_RUN_COMPLETION_IMAGE_ATTACHMENTS,
        this.sessionPreviewBudgetLeft(),
      );
      const trimmedPreviews: ImageRef[] = [];
      let deliveredPreviews = 0;
      let images = batch.flatMap((it) => {
        const refs = it.images ?? [];
        if (!it.completionOnly) return refs;
        const take = refs.slice(0, Math.max(0, previewBudget));
        previewBudget -= take.length;
        deliveredPreviews += take.length;
        trimmedPreviews.push(...refs.slice(take.length));
        return take;
      });
      // Charge the conversation for what THIS turn actually carries, and persist
      // the ledger so a restart does not reset the budget of a conversation that
      // lives on. A replayed (interrupted-then-requeued) batch charges AGAIN —
      // deliberately: the replay really does write those pixels into the
      // provider thread a second time, which is the accumulation being bounded.
      if (deliveredPreviews > 0) {
        this.previewImagesCharged += deliveredPreviews;
        this.reportPreviewLedger();
      }
      // A trim here means a notice ABOVE is now wrong: it was composed when its
      // images were going to ride this turn, and they are not. Measured sequence
      // — 8 previews in flight, a second completion queued behind them (its own
      // budget reads as untouched, because in-flight items are not on `queue`),
      // then an interrupt requeues the first batch: one drain sees 16, delivers
      // 8, and the second completion's "attached below" describes nothing.
      //
      // So this cannot be a log line. The agent is the one being misled, the
      // agent is the one that has to be told, and it needs the coordinates
      // because the trimmed completion may have carried a custom `note` — in
      // which case its filenames appear NOWHERE else in this turn and get_image
      // is otherwise impossible. Suppressed only for a text-only backend, which
      // has its own notice below and no attachments to contradict.
      if (trimmedPreviews.length && this.backend.capabilities.vision) {
        text +=
          `\n\n[panel note: ${trimmedPreviews.length} automatic preview image(s) were NOT attached to this turn. ` +
          `Several run completions were merged into one turn and they SHARE one bounded automatic-preview budget (at most ${MAX_RUN_COMPLETION_IMAGE_ATTACHMENTS} per turn, and a cumulative per-conversation ceiling of ${MAX_SESSION_PREVIEW_ATTACHMENTS} images / ~${previewByteBudgetLabel()}), ` +
          `so a notice above may say its images are "attached below" when they are not — where they disagree, THIS note is the accurate one. ` +
          `They are outputs on the ComfyUI side that this turn does not carry — fetch any of them with get_image action:"get" — ${describeImageRefs(trimmedPreviews)}.]`;
        // These previews are withheld from the conversation for good (the note
        // redirects to get_image), so the diagnostics counter accounts them.
        this.previewWithheldSession += trimmedPreviews.length;
        this.reportPreviewLedger();
        logger.info(
          `[panel-agent ${this.short()}] trimmed ${trimmedPreviews.length} automatic preview image(s) at the drain ` +
            `(completions merged into one turn); the turn says so and names them (#1516)`,
        );
      }
      // Deduped across the BATCH, not just within one message: two queued
      // messages that each carried the same file become one turn here, and the
      // duplicate would spend a second of the turn's two audio slots on bytes
      // already attached — the user then hears that a file they sent "does not
      // fit" while it is on the request twice.
      let audio = dedupeAudioRefs(batch.flatMap((it) => it.audio ?? []));
      // #790 — the SAME contract as the image gate below, for hearing. A backend
      // with no audio content part must never simply receive `turn.audio` and
      // drop it: the user would ask about a sound and get an answer composed
      // from the text alone, with nothing in the transcript revealing the model
      // never heard it. Refuse here, once, for every audio-less adapter, and say
      // so in BOTH directions (`audio` is undeclared → treated as false, the
      // only safe reading for an out-of-tree backend).
      if (audio.length && !this.backend.capabilities.audio) {
        for (const ref of audio) {
          this.deps.onSay(this.tabId, `🔇 ${noAudioPartText(this.backend.id, ref.filename)}`);
        }
        text +=
          `\n\n[panel note: the user attached ${audio.length} audio file(s) (${audio
            .map((a) => a.filename)
            .join(", ")}), but this provider has NO audio input and you did NOT receive them. ` +
          `Do not describe, transcribe or analyse their contents, and do not imply you heard them — ` +
          `say plainly that the audio could not reach you on this provider.]`;
        audio = [];
      }
      if (images.length && !this.backend.capabilities.vision) {
        // Text-only backend: every non-vision adapter silently ignores image
        // refs, which reads to the user as "it ignored my screenshot". Say so
        // visibly, and tell the MODEL too so it can't pretend it saw them.
        this.deps.onSay(
          this.tabId,
          `📎 This provider is text-only, so I can't see the ${images.length > 1 ? "images" : "image"} you attached. ` +
            `Describe what's in it, or switch to a vision-capable provider (Claude, Codex, or Gemini) and re-send.`,
        );
        text +=
          `\n\n[panel note: the user attached ${images.length} image(s), but this provider is text-only and you CANNOT see them. ` +
          `Do not claim or imply you saw them — if the content matters, ask the user to describe it or switch to a vision-capable provider.]`;
        images = [];
      }
      if (this.closed) return;
      // Remember the in-flight turn's user text so an interrupt mid-reply can
      // re-queue it (send-now must address BOTH the interrupted and new message).
      // #468 — the run-completion tokens this batch carries. They ride with the
      // in-flight capture so a crash-requeue keeps them attached, and are ACKED
      // only when this turn's `result` lands (proof the agent actually read the
      // completion), not merely because it was spliced off the queue.
      const carriedTokens = batch.flatMap((it) => it.eventTokens ?? []);
      // SAFETY NET: the previous turn ended without acking (no result at all, or
      // only a traceless one the ack gate rejected). Its completions are about to
      // be overwritten here, so hand them back first — the flush re-queues them
      // into a LATER turn rather than letting them vanish at the handover.
      if (this.turnEventTokens.length) {
        const stale = this.turnEventTokens;
        this.turnEventTokens = [];
        // CARRIED only if that turn produced events (proof the backend received
        // it) — the same rule as the result and abandon paths.
        this.releaseEventTokens(stale, { carried: this.turnProducedEvents });
      }
      this.turnEventTokens = carriedTokens;
      this.inFlight = {
        text,
        ...(images.length ? { images } : {}),
        ...(audio.length ? { audio } : {}),
        ...(carriedTokens.length ? { eventTokens: carriedTokens } : {}),
        items: batch,
      };
      this.yieldedTurns += 1; // this batch is turn N
      // Mirror the backend's turn-marker mint: the Nth turn yielded here is the
      // Nth turn the backend reads — its events carry marker N (#728 r3).
      this.currentTurnMarker += 1;
      this.turnEventTokensMarker = this.currentTurnMarker;
      this.turnProducedEvents = false; // no proof of receipt yet (#468)
      // Mark the turn in flight AT DISPATCH (not on the first event). Without this
      // the watchdog's `busy` guard would be false for the exact zero-event freeze
      // it's meant to catch, so onTurnStalled() would no-op. (handleEvent's later
      // `busy = true` becomes a harmless no-op.) Also shows "working" immediately.
      this.errorSurfaced = false; // fresh turn → its failure (if any) is unreported
      this.interruptRequested = false; // a stale interrupt can't mute THIS turn's failure
      this.busy = true;
      // Snapshot the model this turn runs on, so a live setModel mid-turn can't let
      // the outgoing turn's result restore the wrong context window (#543).
      this.turnModel = this.model;
      this.deps.onTurn?.(this.tabId, "working");
      // Drop the PREVIOUS turn's watchdog state at dispatch: a stale idle timer
      // left by an abandoned turn (its result never disarmed it — e.g. after the
      // interrupt fallback, whose stragglers are now dead-lettered instead) would
      // otherwise fire into THIS turn and trip it spuriously, and a latched
      // idleTripped would leave this turn with no watchdog at all. Fresh turn →
      // fresh watchdog.
      this.clearIdleWatchdog();
      // Arm the freeze watchdog AT DISPATCH: a turn that produces NO events at all
      // (the exact ROOT CAUSE B freeze — turn/start sent, no notifications ever
      // returned) never reaches handleEvent, so arming here is what catches it.
      // Subsequent events re-arm it (handleEvent → bumpIdleWatchdog); a clean
      // result disarms it.
      this.bumpIdleWatchdog();
      yield { text, ...(images.length ? { images } : {}), ...(audio.length ? { audio } : {}) };
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
      // Consume once: a later self-restart must not keep forking unless asked again.
      const forkSession = this.pendingForkOnResume && !!resume && !rewind?.anchor;
      this.pendingForkOnResume = false;
      const startedAt = Date.now();
      // Set below if the backend fails because the resume target is gone; keeps a
      // recoverable resume-miss from counting toward the give-up threshold.
      let resumeMiss = false;
      // Fresh channel → reset the turn-gate counters so a restart/resume never
      // inherits a stale offset that would mis-gate the first batch. The backend's
      // turn-marker mint also restarts with the new run, so the mirrored markers
      // reset too (and a restarted session can never receive the OLD session's
      // straggler emissions anyway).
      this.yieldedTurns = 0;
      this.completedTurns = 0;
      this.turnWaiter = null;
      this.currentTurnMarker = 0;
      this.abandonedTurnMarker = 0;
      // The #468 ack gate mirrors the marker reset: no marker minted by the dead
      // run can satisfy the new one's first turn.
      this.turnEventTokensMarker = 0;
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
          ...(forkSession ? { forkSession: true } : {}),
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
        // fails with "No conversation found with session ID: <id>". Current Codex
        // can instead report "no rollout found for thread id <uuid>" for the same
        // pruned/missing-target condition (#277). Retrying the SAME resume just
        // loops until the give-up threshold trips and self-exits the whole
        // orchestrator (a live bridge left serving a permanently-dead agent). Drop
        // the dead resume target so the NEXT iteration starts a FRESH session and
        // self-heals; queued messages (this.queue) survive and replay.
        // GUARD (#278): only treat this as a recoverable resume-MISS when this
        // start actually RESUMED something. A FRESH start (no resume) that emits
        // the same text is a real, non-recoverable failure and MUST count toward
        // the rapid-restart give-up bound below — otherwise resumeMiss would reset
        // the counter forever and spin an infinite restart loop.
        if (resume && /(?:No conversation found with session ID|no rollout found for thread id)/i.test(emsg)) {
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
        // Read through takeInFlight(): channel() assigns this.inFlight from
        // another function, which control-flow analysis can't see, so a direct
        // read here is narrowed to `null` by the `= null` at the top of the loop.
        const interrupted = this.takeInFlight();
        if (interrupted) {
          // Its run-completion tokens (#468) ride the re-queued items, so they
          // are acked when the RE-RUN turn ends — not left dangling on a turn
          // whose session died. The ORIGINAL items go back, so a completion
          // stays its own `completionOnly` item (never welded into user text).
          this.turnEventTokens = [];
          this.queue.unshift(...interrupted.items);
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
      // A turn that never produced a `result` (the session just ended) never
      // acked its run completions. Hand them back so the restarted session
      // replays them instead of the completion dying with the dead session
      // (#468). No-op after a clean result or the crash re-queue above.
      const strandedTokens = this.turnEventTokens;
      const strandedWereReceived = this.turnProducedEvents;
      this.turnEventTokens = [];
      // Same rule again: a session that DID receive this turn (it emitted marked
      // events) and then died without a terminal result is a bounded replay
      // cycle — a session that kept dropping before receiving it is not, and
      // must never count toward the settle bound.
      this.releaseEventTokens(strandedTokens, { carried: strandedWereReceived });
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
    this.stallRecoverySteered = false;
    // The turn ended — drop any tool-busy state so a start whose matching end was
    // never seen (errored/interrupted turn) can't defer the NEXT turn's watchdog.
    this.openToolCalls = 0;
    this.toolBusySince = 0;
  }

  /** The exact notice injected into capable providers when a harness watchdog
   *  sees a frozen turn. It must never be conflated with a user cancellation. */
  private static readonly STALL_RECOVERY_NOTICE =
    "[harness stall notice] This turn stalled with no activity and was detected by the harness. " +
    "The user did NOT reject or cancel this tool call. Do not tell the user that they stopped it. " +
    "Inspect side effects if the call may have started; otherwise it is safe to retry the same call.";

  /** Finish the legacy interruption path after no native stall recovery is
   *  available. This retains the existing gate/restart safety for old providers. */
  private finishStalledTurn(alreadyReported: boolean): void {
    this.busy = false;
    // The stalled turn is abandoned — don't re-queue its text (a wedged message
    // could otherwise loop on every interrupt, and it may already have performed
    // tool side effects).
    this.inFlight = null;
    // …but a run COMPLETION the abandoned turn was carrying is not the agent's
    // work, it's news the agent still needs (#468). Hand its tokens back so the
    // journal replays them into the next turn instead of losing them with the
    // turn we just wrote off.
    //
    // THIS is the abandon path. The #587 steer path deliberately does NOT come
    // here: there the turn stays live and keeps carrying its tokens, so releasing
    // them would replay a completion the live turn still holds.
    //
    // CARRIED only if the backend produced at least one event for this turn —
    // i.e. it demonstrably received the completion and then went silent. A turn
    // that produced NOTHING never reached the model, so it must not count toward
    // the settle bound (that freeze is bounded by the self-restart give-up
    // machinery instead, which tears the agent down rather than quietly retiring
    // a completion nobody saw).
    const stalledTokens = this.turnEventTokens;
    this.turnEventTokens = [];
    this.releaseEventTokens(stalledTokens, { carried: this.turnProducedEvents });
    if (!alreadyReported) {
      this.deps.onSay(
        this.tabId,
        "⚠️ The agent stopped responding (the turn stalled with no activity). I've cleared it — please try again.",
      );
    }
    this.deps.onTurn?.(this.tabId, "done");
    // Do NOT completeTurn() here: the gate must stay held until the turn genuinely
    // ends. interrupt() arms the bounded release fallback and stops the wedged
    // backend; the aborted turn's `result` (or that fallback) releases the next
    // queued batch at the right moment. The self-restart loop in start() recovers
    // the session.
    void this.interrupt();
  }

  /** Attempt one provider-native recovery before the legacy interrupt path.
   *  A steer is an explicit agent-facing harness notice, not a synthetic user
   *  rejection. Its short re-arm preserves the ordinary bounded fallback if the
   *  provider remains frozen after accepting it. */
  private async recoverStalledTurn(stalledMarker: number, alreadyReported: boolean): Promise<void> {
    const recover = this.backend.recoverStalledTurn;
    if (!recover || this.stallRecoverySteered) {
      this.finishStalledTurn(alreadyReported);
      return;
    }
    this.stallRecoverySteered = true;
    let steered = false;
    try {
      steered = await recover.call(this.backend, PanelAgent.STALL_RECOVERY_NOTICE);
    } catch (err) {
      logger.debug(`[panel-agent ${this.short()}] stalled-turn recovery: ${msgOf(err)}`);
    }
    // The active turn may have completed while the asynchronous steer request was
    // in flight. Never resurrect a settled or replacement turn.
    const stillCurrent =
      !this.closed &&
      this.busy &&
      this.currentTurnMarker === stalledMarker &&
      this.completedTurns < this.yieldedTurns;
    if (!steered || !stillCurrent) {
      if (stillCurrent) this.finishStalledTurn(alreadyReported);
      return;
    }
    // The provider accepted the precise notice. Keep the turn authoritative and
    // allow a second full idle window; if it remains frozen, the next watchdog
    // trip falls through to the established bounded interrupt/restart recovery.
    this.idleTripped = false;
    this.bumpIdleWatchdog();
    if (!alreadyReported) {
      this.deps.onSay(
        this.tabId,
        "⚠️ The agent stalled with no activity. I sent it a harness-stall notice — you did NOT cancel it; it can inspect state and retry safely.",
      );
    }
  }

  /** The current turn produced NO events for the whole idle window → it's frozen.
   *  First send a capable provider an explicit non-user-cancel notice. If that
   *  is unavailable (or it remains silent through another full window), surface
   *  the legacy clear + use the guarded interrupt() flow so the turn-gate opens
   *  only when the turn GENUINELY ends (the aborted turn's terminal result, or the
   *  bounded interrupt-release fallback if none arrives) — not synchronously here,
   *  which let the next queued batch run before the wedged turn had settled.
   *  errorSurfaced + interruptRequested suppress the follow-up interrupted
   *  result's "turn failed" line (#728). Idempotent per trip via idleTripped. */
  private onTurnStalled(): void {
    if (this.closed || this.idleTripped || !this.busy) return;
    // A tool call in flight is legitimate work even with a silent app-server (an
    // MCP tool call has no progress notification between its start and end). Defer
    // and re-arm rather than kill a healthy long tool call — UNLESS a tool has
    // been open past TOOL_BUSY_MAX_MS, in which case it's more likely wedged than
    // slow and we fall through to the real trip. (#307 review finding.)
    if (this.openToolCalls > 0 && Date.now() - this.toolBusySince < toolBusyMaxMs()) {
      this.bumpIdleWatchdog();
      return;
    }
    this.idleTripped = true;
    this.idleTimer = null;
    // ONE failure report per turn: if an `error` event already painted this turn's
    // failure line (errorSurfaced), the stall warning would be a SECOND report for
    // the same turn — suppress it (the log line below still records the stall).
    // Otherwise the stall warning below IS this turn's failure report — mark it
    // surfaced so the backend's terminal `{ ok: false, subtype: "interrupted" }`
    // result (or a late `error` event) isn't painted as a second, contradictory
    // failure. (interrupt() also sets interruptRequested, so the result case
    // treats that result as the interrupt landing, not a new failure.)
    const alreadyReported = this.errorSurfaced;
    const recovery = this.stallRecoverySteered || !this.backend.recoverStalledTurn
      ? " via legacy interrupt"
      : " with provider notice";
    logger.error(
      `[panel-agent ${this.short()}] turn stalled — no events for ${Math.round(TURN_IDLE_MS / 1000)}s; recovering${recovery}${alreadyReported ? " (failure already reported)" : " and surfacing error"}`,
    );
    this.errorSurfaced = true;
    const stalledMarker = this.currentTurnMarker;
    // #468 note: the run-completion tokens this turn is carrying are handed back
    // in finishStalledTurn(), NOT here. #587 introduced a path where the stall is
    // recovered by STEERING the provider and the turn stays live — releasing the
    // tokens on that path would replay the completion into a turn that is still
    // holding it, i.e. a duplicate. Only the genuinely-abandoned path releases.
    void this.recoverStalledTurn(stalledMarker, alreadyReported);
  }

  // Handle a canonical AgentEvent from the backend. This is the provider-agnostic
  // half of what used to be route(SDKMessage): all the panel orchestration (turn
  // gate, busy/working indicator, anchor tracking, usage meter, onSay commit)
  // lives here; the backend already normalized the provider's native messages.
  private handleEvent(ev: AgentEvent): void {
    // CLOSED GUARD (#570 P0a): once stopped, emit NOTHING. stop()/retire() set `closed`
    // fire-and-forget, but the backend's `for await` loop may still yield one buffered
    // event before it observes the flag — and forwarding it would fire onSession/onSay/
    // onStream callbacks that the bridge's same-socket migration alias routes to the tab
    // this agent was retired in favor of (a leak of the old workflow's reply/session into
    // the switched-to one). Dropping the event is safe: a stopped agent's turn is over.
    if (this.closed) return;
    // DEAD-LETTER by turn marker (#728 r3): an event stamped with a turn OLDER
    // than the in-flight turn — or belonging to the fallback-abandoned turn — is
    // a straggler from a turn that is no longer current. It is logged but NEVER
    // painted (a dead turn's error must not report against the new turn) and
    // NEVER gate-affecting (a dead turn's result must not completeTurn the new
    // turn's gate early, nor clear its watchdog/busy). Events with NO marker
    // (legacy backend, or session-level traffic) skip this entirely — previous
    // behavior; better a rare duplicate than a wedge.
    if (
      typeof ev.turn === "number" &&
      (ev.turn <= this.abandonedTurnMarker || ev.turn < this.currentTurnMarker)
    ) {
      logger.debug(
        `[panel-agent ${this.short()}] dead-lettered a straggler ${ev.type} from turn ${ev.turn} (current=${this.currentTurnMarker}, abandoned≤${this.abandonedTurnMarker})`,
      );
      return;
    }
    // Proof the backend RECEIVED the in-flight turn (#468). On a backend that
    // DECLARES turn markers, only an event stamped with THIS turn counts: #728
    // deliberately lets UNMARKED events past the dead-letter guard for gate
    // liveness, and Claude emits an unmarked terminal for a result it cannot
    // match to any submitted turn — a stale one of those, arriving while the new
    // turn is still pre-submission, would otherwise "prove" a receipt that never
    // happened and let the settle bound retire a completion nobody saw.
    if (this.backend.capabilities.turnMarkers === true) {
      if (typeof ev.turn === "number" && ev.turn === this.currentTurnMarker) {
        this.turnProducedEvents = true;
      }
    } else {
      this.turnProducedEvents = true; // nothing to compare against
    }
    // Any event means the turn is alive — reset the idle watchdog. The `result`
    // case below disarms it entirely (turn ended). Placed before the switch so it
    // covers every event type without per-case bumps.
    this.bumpIdleWatchdog();
    switch (ev.type) {
      case "session": {
        this.sessionId = ev.sessionId;
        if (ev.model) this.model = ev.model;
        // Pass the SDK-resolved model so the panel can correct a ready banner that
        // was sent with the pre-init default (#376).
        this.deps.onSession?.(this.tabId, ev.sessionId, ev.model);
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
          // Enter "tool busy": while a tool runs the app-server can be silent for
          // longer than the idle window, so onTurnStalled() defers rather than
          // trips (bounded by TOOL_BUSY_MAX_MS). Stamp the start of the run on the
          // 0 → 1 edge only, so several overlapping tools share one deadline.
          if (this.openToolCalls === 0) this.toolBusySince = Date.now();
          this.openToolCalls += 1;
          this.deps.onToolCall?.(this.tabId, ev.name);
        } else {
          this.openToolCalls = Math.max(0, this.openToolCalls - 1);
        }
        break;
      }
      case "error": {
        // A backend-reported turn error (codex/gemini/grok emit these before
        // their error result). Without this case the message fell through
        // `default` and the user watched a turn end in TOTAL silence — the
        // exact "three Hellos into the void" failure from the support thread.
        // Surface it as a visible chat line; the follow-up `result` event still
        // advances the turn gate normally. ONE report per turn: if the failure
        // was already surfaced (the stall watchdog's warning, or an earlier
        // error event this turn), skip the chat line but still log it (#728).
        const detail = typeof ev.message === "string" && ev.message.trim() ? ev.message.trim() : "unknown error";
        // #1524 — a SESSION notice (an MCP server the session did not come up
        // with) is not a turn failure. It arrives at init, before any turn
        // exists, so the turn framing below would name a turn that never ran and
        // offer a retry that re-runs nothing. It also must not spend the
        // once-per-turn error slot: doing so would let a notice about the
        // toolset swallow the first genuine turn error after it.
        if (ev.sessionNotice) {
          this.deps.onSay(this.tabId, `⚠️ ${detail}`);
          logger.error(`[panel-agent ${this.short()}] session notice: ${detail}`);
          break;
        }
        if (!this.errorSurfaced) {
          this.errorSurfaced = true;
          // #886: a "completed but unverified" disclosure is NOT a turn failure
          // — the turn may have finished real work — and its message is
          // self-contained. Framing it as "turn failed … nothing was lost, try
          // again" would be two lies (it didn't fail; something may have been
          // DONE) and would invite a destructive duplicate retry.
          this.deps.onSay(
            this.tabId,
            ev.unverifiedCompletion
              ? `⚠️ ${detail}`
              : `⚠️ The ${this.model} turn failed: ${detail}\n\nNothing was lost — try again, switch models from the composer picker, or check the terminal running the orchestrator for more detail.`,
          );
        }
        logger.warn(`[panel-agent ${this.short()}] backend error: ${detail}`);
        break;
      }
      case "result": {
        // Cache the context window + cost from the result, then re-report using
        // the last assistant usage (the true current context). Track the LATEST
        // reported window, not the max ever seen: the model can change mid-session
        // (setModel is live) and a smaller-window model must shrink the denominator,
        // otherwise the meter under-reports fill against a stale larger window (#543).
        // Only cache when the turn's model still matches the current one — a result
        // from a turn whose model was switched away mid-flight carries the OUTGOING
        // model's window, which must NOT restore the denominator setModel cleared.
        if (ev.contextWindow && this.turnModel === this.model) {
          this.contextWindow = ev.contextWindow;
        }
        if (this.lastUsage) this.reportStatus(this.lastUsage, ev.costUsd);
        this.busy = false;
        // Turn completed → nothing to re-queue on a later interrupt. (A clean
        // completion must NOT have its message re-queued.)
        this.inFlight = null;
        // #468 — the turn that CARRIED the run completion(s) has ended, so they
        // demonstrably reached the model's context. Ack them: the journal drops
        // them and settles their run tickets. This is the ONLY ack point; every
        // other exit from a turn hands the tokens back for replay.
        //
        // ACK GATE: only THIS turn's own result may ack. On a backend that
        // DECLARES turn markers, an UNMARKED result is a traceless straggler
        // (Claude emits one for a result it cannot match to a submitted turn)
        // that the #728 dead-letter deliberately lets through for gate liveness
        // — it must not also retire a completion the CURRENT turn is carrying,
        // or a turn that then stalls would have nothing left to hand back.
        //
        // The capability is DECLARED, never inferred from "have I seen a marker
        // yet": a zero-output turn's straggler arrives BEFORE the replacement
        // turn stamps anything, so an observation-based gate is unsound in
        // exactly the window it exists to protect. A backend that declares no
        // markers keeps the pre-#468 behavior (nothing to compare against).
        //
        // Not ackable → hand the tokens BACK right here, so a completion can
        // never dangle on a turn that has already ended. The journal re-queues
        // it into a later turn: a duplicate at worst, never a loss.
        if (this.turnEventTokens.length) {
          const carried = this.turnEventTokens;
          this.turnEventTokens = [];
          const ackable =
            this.backend.capabilities.turnMarkers !== true ||
            (typeof ev.turn === "number" && ev.turn === this.turnEventTokensMarker);
          if (ackable) {
            try {
              this.deps.onEventDelivered?.(this.tabId, carried, { carrier: this.carrierId });
            } catch (err) {
              logger.warn(`[panel-agent ${this.short()}] acking completion tokens: ${msgOf(err)}`);
            }
          } else {
            logger.warn(
              `[panel-agent ${this.short()}] an unmarked result cannot ack turn ${this.turnEventTokensMarker}'s run completion(s) — handing ${carried.length} back for replay (#468)`,
            );
            // CARRIED only with PROOF the backend received this turn — the same
            // rule as every other release. An UNMARKED result bypasses the #728
            // dead-letter gate, so it may be a straggler from an abandoned turn
            // arriving while this one is still pre-submission; counting it would
            // let three such stragglers settle a completion nobody ever saw.
            this.releaseEventTokens(carried, { carried: this.turnProducedEvents });
          }
        }
        // Turn ended cleanly → disarm the freeze watchdog. (If it already tripped,
        // completeTurn() is a capped no-op, so the gate can't double-advance.)
        this.clearIdleWatchdog();
        this.completeTurn(); // turn finished → release the next queued batch
        // Report this turn's anchor (last assistant UUID) so the panel can later
        // fork the conversation here for a rewind.
        if (this.lastAssistantUuid) this.deps.onTurnAnchor?.(this.tabId, this.lastAssistantUuid);
        this.deps.onTurn?.(this.tabId, "done");
        // Failed turn that never produced a visible error (the claude SDK path
        // reports failures only via the result subtype; the `error` event case
        // covers codex/gemini/grok) → say SOMETHING. A turn must never end in
        // silence, error turns included. EXCEPT a turn the user just interrupted
        // (Stop / send-now): its error-subtype result is the interrupt landing,
        // not a failure.
        const wasInterrupted = this.interruptRequested;
        this.interruptRequested = false; // one result consumes the flag
        if ((ev.ok === false || /error/i.test(ev.subtype ?? "")) && !this.errorSurfaced && !wasInterrupted) {
          this.errorSurfaced = true;
          this.deps.onSay(
            this.tabId,
            `⚠️ That turn failed (${ev.subtype ?? "error"}) without a reply. ` +
              `Nothing was lost — try again, switch models from the composer picker, or check the orchestrator terminal for detail.`,
          );
        }
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
  onSession?: (tabId: string, sessionId: string, model?: string) => void;
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
  /** Per-KEY mcpServers factory (key = tabId::backend). When provided it wins
   *  over the static `mcpServers` for every spawn — required for per-tab spawn
   *  env like the Blind content gate (panel issue #90): a static object shared
   *  across tabs cannot express per-tab COMFYUI_MCP_BLIND. */
  makeMcpServers?: (key: string) => Options["mcpServers"];
  /** Per-KEY systemAppend factory (key = tabId::backend). When provided it wins
   *  over the static `systemAppend` for every spawn — required so the ENVIRONMENT
   *  block's `Backend:` line names the tab's ACTUAL backend rather than the
   *  process default (#358). Falls back to `systemAppend` when it returns
   *  undefined or is unset. */
  makeSystemAppend?: (key: string) => string | undefined;
  /** Bundled plugin dir whose skills make the agent an expert (optional). */
  pluginPath?: string;
  /** Live Blind-mode predicate (issue #90) — see PanelAgentDeps.isBlind. */
  isBlind?: () => boolean;
  /**
   * Optional backend factory (per agent key `panelTabId::backend`). The manager
   * injects the returned backend into the PanelAgent; returning undefined selects
   * the default in-process ClaudeBackend. Single-port multi-provider: index.ts
   * builds a Codex/Gemini backend for those keys and undefined for claude keys.
   */
  makeBackend?: (tabId: string) => AgentBackend | undefined;
  /**
   * Fired when a tab's agent FAILED TO START — a hard reject from
   * backend.prepare()/run before any session existed (e.g. an OpenAI-dialect
   * provider rejecting an invalid API key with a 401, or an unreachable
   * endpoint). This is a PER-TAB, recoverable condition (issue #250): the
   * manager has already dropped the dead agent, so once the user fixes the
   * credentials the next message / Disconnect → Connect on the SAME tab spawns
   * a fresh agent. The orchestrator should degrade THAT tab (honest say +
   * degraded ack) and must NOT self-exit — a bad key on one tab used to take
   * down every other tab. When absent, the manager falls back to a generic
   * onSay notice (still per-tab, still no fatal escalation).
   */
  onStartFailure?: (tabId: string, message: string) => void;
  /**
   * Fired when a tab's agent dies FATALLY: its bounded self-restart loop gave up
   * (the session kept dropping immediately). This is the "agent backend is dead"
   * signal: the orchestrator is alive and the bridge is up, but no agent will
   * ever handshake. The orchestrator wires this to a clean self-exit so the panel
   * pack's bridge-death → reclaim + sticky-reconnect path respawns a FRESH
   * orchestrator, instead of leaving the user wedged on "bridge open but no panel
   * agent responded". `reason` is a short human label for the log.
   * NOTE (issue #250): plain start failures no longer route here — they are
   * per-tab configuration errors handled by onStartFailure above.
   */
  onAgentFatal?: (tabId: string, reason: string) => void;
  /** #468 — a turn carrying these run-completion journal tokens ENDED, so the
   *  completions genuinely reached the agent. Forwarded verbatim from the agent. */
  /** #486 — `carrier` identifies the AGENT INSTANCE whose turn carried these
   *  tokens, so a journal can refuse an ack from anything else. */
  onEventDelivered?: (tabId: string, tokens: string[], from?: { carrier?: string }) => void;
  /** #468 — these run-completion journal tokens came back UNDELIVERED (agent
   *  stopped, turn abandoned, injection refused). Re-arm them for replay.
   *  `carried` true = a turn ran with them and ended (the agent read the text,
   *  only the ack is unprovable) — the only cycle the journal bounds. */
  onEventUndelivered?: (tabId: string, tokens: string[], opts?: { carried?: boolean }) => void;
  /** #468 — a fresh agent is mapped and ready for this key. The orchestrator
   *  uses it to replay any journaled run completions the previous agent never
   *  delivered, so a completion survives the restart that lost it. */
  onAgentReady?: (tabId: string) => void;
  /**
   * Durable per-tab session store. When set, the manager persists each tab's SDK
   * session id here and uses it as the resume fallback when a tab first spawns —
   * so the conversation survives the orchestrator PROCESS being killed (a wedge
   * auto-restart), independent of whether the panel re-sends `hello.resume`.
   */
  sessionStore?: SessionStore;
  /** #570 P0 — resolve the trusted workflow-identity uuid for a composite agent key, so a
   *  persisted exact session is BOUND to the workflow it belongs to (detecting a saved
   *  workflow overwritten in place: same tab id, new uuid). undefined when unknown. */
  identityForKey?: (key: string) => string | undefined;
}

/**
 * What a requested comfyui-MCP-env respawn actually did for ONE agent (#826):
 *   "applied"   — the agent was idle, so it was replaced RIGHT NOW. The tool
 *                 subprocess is being recreated with the rebuilt env. Observed.
 *   "scheduled" — the agent is mid-turn; the replacement is queued for its next
 *                 idle. NOT done yet, and callers must not describe it as done.
 *   "no-agent"  — there is no live agent on this key, so nothing was or will be
 *                 respawned by this call. Never report this as a success.
 * Returned so a caller can state what happened instead of asserting a respawn it
 * never observed — the exact defect in #826.
 */
export type McpEnvRestartOutcome = "applied" | "scheduled" | "no-agent";

/** Per-outcome counts across every live agent for one env change. */
export interface McpEnvRestartTally {
  /** Sessions that were genuinely live — i.e. actually classified as applied or
   *  scheduled. Counted from the OUTCOMES, not from the map size: a key can be
   *  mapped to an already-stopped agent, and reporting "of 1 live" when zero
   *  sessions existed overstates the work (codex gate, round 1, finding 6). */
  live: number;
  applied: number;
  scheduled: number;
}

/** Fold one agent's outcome into a tally. "no-agent" counts as NOTHING — an
 *  agent that was already stopped, or vanished between the key snapshot and the
 *  apply, was not respawned and nothing will respawn it; it must inflate neither
 *  "applied" (work that never happened), nor "scheduled" (work nothing will do),
 *  nor "live". Exported so that third state is directly testable; it is
 *  otherwise only reachable via a stopped-but-still-mapped agent. */
export function tallyRestart(tally: McpEnvRestartTally, outcome: McpEnvRestartOutcome): void {
  if (outcome === "applied") {
    tally.applied++;
    tally.live++;
  } else if (outcome === "scheduled") {
    tally.scheduled++;
    tally.live++;
  }
}

/** Owns one PanelAgent per tab id, spawned lazily on the tab's first message. */
export class PanelAgentManager {
  private agents = new Map<string, PanelAgent>();
  private opts: PanelAgentManagerOptions;
  /** Per-tab session id to resume on the next spawn (reload restore). */
  private pendingResume = new Map<string, string>();
  /** Held mail (issue #256): messages queued into an agent that then FAILED to
   *  start (prepare() rejected before the channel was ever consumed) are
   *  captured here at settle(err) instead of dying with the agent — the next
   *  spawn on the same composite key re-delivers them, so nothing sent into the
   *  spawn → prepare()-reject window is silently dropped. */
  private heldMessages = new Map<string, Array<QueueItem>>();
  /** Tabs whose effort changed mid-turn — the session restart is deferred to the
   *  next idle moment so we never interrupt (and silently drop) a live reply. */
  private pendingEffortRestart = new Set<string>();
  /** Tabs awaiting a comfyui-MCP-env respawn (a tool secret was saved). Value is
   *  an optional nudge to enqueue after the resumed agent comes back (e.g. "retry
   *  the download"). Applied at the next idle so the saving turn finishes first. */
  private pendingMcpRestart = new Map<string, string | null>();
  /** #1700 — tabs whose pending MCP restart must FORK the session so the
   *  freshly-read MCP server set replaces the session-recorded one. */
  private pendingForkOnRestart = new Set<string>();
  /** #1429 — tabs whose queued MCP-restart nudge is a RETARGET nudge, mapped to
   *  the EARLIEST address they were stranded on. Two jobs: it tells a retarget
   *  nudge apart from a per-request retry nudge (#164, which must never be
   *  overwritten), and it makes A→B→C inside one turn report A→C rather than the
   *  obsolete A→B. Cleared wherever pendingMcpRestart is. */
  private pendingRetargetFrom = new Map<string, string>();
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

  /** The picker's model OVERRIDE for this composite key (`tabId::backend`), if
   *  any — undefined when the key runs the shared default. Lets the models
   *  push report the model this tab will ACTUALLY spawn with as `current`,
   *  instead of the backend default the override supersedes. */
  modelOverrideFor(tabId: string): string | undefined {
    return this.modelByKey.get(tabId);
  }

  /** The reasoning effort this key runs at — its picker override when set, else
   *  the shared default. Unlike {@link modelOverrideFor} this folds the default
   *  in, because there is no second source to fall back to: the caller (the
   *  orchestrator publishing the agent's identity for report_issue) wants the
   *  value in force, not whether it was overridden. */
  currentEffortFor(tabId: string): Effort | undefined {
    return this.effortFor(tabId);
  }

  private makeAgent(tabId: string): PanelAgent {
    // Inject the toggle-selected backend (Codex) when provided; otherwise the
    // PanelAgent constructor defaults to ClaudeBackend (existing behavior).
    const backend = this.opts.makeBackend?.(tabId);
    return new PanelAgent(tabId, {
      // The factory (fresh per spawn — re-reads closures AND per-tab state like
      // the Blind gate) wins over the static set (kept for tests/back-compat).
      mcpServers: this.opts.makeMcpServers?.(tabId) ?? this.opts.mcpServers,
      comfyuiUrl: this.opts.comfyuiUrl,
      systemAppend: this.opts.makeSystemAppend?.(tabId) ?? this.opts.systemAppend,
      model: this.modelFor(tabId),
      effort: this.effortFor(tabId),
      onSay: this.opts.onSay,
      onStream: this.opts.onStream,
      onStatus: this.opts.onStatus,
      // Persist the session id to our durable store (resume-after-restart) BEFORE
      // forwarding it to the panel — so it's on disk the moment the SDK reports it.
      onSession: (id, sid, model) => {
        this.opts.sessionStore?.set(id, sid, this.opts.identityForKey?.(id));
        this.opts.onSession?.(id, sid, model);
      },
      // #1516 — persist the cumulative preview ledger beside the session id it
      // belongs to. setPreviewLedger REFUSES a session mismatch, so a ledger is
      // only ever stored against the exact conversation it measures — a stale
      // report for a since-replaced session is dropped, not misfiled.
      onPreviewLedger: (id, ledger) => {
        const sid = this.agents.get(id)?.sessionId;
        if (sid) this.opts.sessionStore?.setPreviewLedger(id, sid, ledger);
      },
      // #1516 — hand the freshly-spawned agent the durable ledger of the
      // conversation it is expected to resume; the agent adopts it only when
      // the live session id proves to be that exact conversation.
      initialPreviewLedger: this.opts.sessionStore?.previewLedger(tabId),
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
      onEventDelivered: this.opts.onEventDelivered,
      onEventUndelivered: this.opts.onEventUndelivered,
      panelServer: this.opts.makePanelServer?.(tabId),
      pluginPath: this.opts.pluginPath,
      isBlind: this.opts.isBlind,
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

  /** Whether a live agent (session) exists for this composite key — used to flag
   *  the mobile mirror picker's "session attached" dot, and as the SYNCHRONOUS half
   *  of {@link interrupt}'s outcome for callers that must report it without waiting
   *  on the backend's (possibly slow, possibly hung) interrupt round-trip (#568).
   *
   *  LIVE means live, not merely mapped. reset()/retire() unmap through unbindAgent()
   *  BEFORE stopping, but stopAll() sets `closed` on every agent and keeps them mapped
   *  until each awaited stop() resolves — an unbounded window when a backend hangs.
   *  A closed agent takes no message, runs no turn and accepts no interrupt, so every
   *  caller of this ("is there an agent I can act on?") must see through that window. */
  hasLiveAgent(key: string): boolean {
    const agent = this.agents.get(key);
    return !!agent && !agent.isStopped;
  }

  /** #570 P0 — true when this key holds ANY per-tab live/queued state that reset() would
   *  tear down: a live agent, an armed pending resume, OR failed-start held mail (a backend
   *  prepare failure drops the agent but PARKS its queued user messages here, with no
   *  session). The identity boundary gates on this so an in-place workflow replacement is
   *  torn down even in the spawn→first-session window or after a prepare failure — otherwise
   *  the next message re-delivers the prior workflow's parked mail into the replacement. */
  hasAnyState(key: string): boolean {
    return this.agents.has(key) || this.pendingResume.has(key) || (this.heldMessages.get(key)?.length ?? 0) > 0;
  }

  /** Composite keys of every live agent. Used to deliver a download-completion
   *  event to the SINGLE live agent when a settled download row carries no tab
   *  stamp (a pre-fix row, or an in-process/mobile caller) — the orchestrator
   *  wakes it only when there is exactly one, never fanning out to unrelated
   *  tabs (#547). */
  liveKeys(): string[] {
    return [...this.agents.keys()];
  }

  /** Respawn every active tab's agent (resume + carry-over) so the live comfyui
   *  MCP subprocess is recreated with the updated env. Deferred to each tab's
   *  next idle so the turn that SAVED the secret finishes first (we never
   *  interrupt a live reply). `nudge`, if given, is enqueued to each resumed
   *  agent so it auto-continues (e.g. retries the download the secret unblocked). */
  restartAllForMcpEnv(nudge?: string): McpEnvRestartTally {
    // Snapshot the key set: applyPendingRestarts REPLACES entries in this.agents
    // (spawn + retire) while we iterate, and mutating a Map during its own
    // iteration is how a tab silently gets skipped.
    const keys = [...this.agents.keys()];
    const tally: McpEnvRestartTally = { live: 0, applied: 0, scheduled: 0 };
    for (const tabId of keys) {
      // A SILENT env respawn (no nudge) must NOT downgrade a tab that already has
      // a retry nudge queued (#164): a concurrent env change on another tab, or a
      // retarget, would otherwise erase a still-pending per-request nudge before
      // its busy agent could apply it. Keep the existing nudge; still coalesce.
      if (nudge === undefined && this.pendingMcpRestart.get(tabId)) {
        tallyRestart(tally, this.applyPendingRestarts(tabId));
        continue;
      }
      this.pendingMcpRestart.set(tabId, nudge ?? null);
      // Whatever is queued now is not a retarget nudge any more (#1429) — leaving
      // the marker set lets the NEXT retarget claim this one as its own.
      this.pendingRetargetFrom.delete(tabId);
      // Apply immediately when the tab is already idle; otherwise it fires on the
      // next turn-done via applyPendingRestarts().
      tallyRestart(tally, this.applyPendingRestarts(tabId));
    }
    return tally;
  }

  /**
   * #1429 — the ComfyUI target moved, so every tab's comfyui MCP child must be
   * respawned to learn the new address. Identical to restartAllForMcpEnv() except
   * for what a MID-TURN tab is told afterwards.
   *
   * A tab that is busy cannot have its child replaced now, so it goes on serving
   * `from` for the rest of that turn. It gets a nudge naming both addresses. A
   * tab that is IDLE respawns before it can run anything and gets NOTHING: a
   * nudge is a real agent turn (restartAgentResume delivers it as one), not a log
   * line, so a false one costs the user a response about nothing.
   *
   * Two orderings this has to get right, both found in adversarial review:
   *
   *   * A per-request retry nudge (#164, "the download you just tried can be
   *     retried now") is MORE SPECIFIC than a retarget nudge and must never be
   *     overwritten by one — hence pendingRetargetFrom, which is what tells the
   *     two apart when a nudge is already queued.
   *   * Two retargets inside one turn (A→B then B→C) must tell the agent A→C.
   *     Keeping the first message would state a target the respawned child is
   *     NOT on, which is worse than saying nothing — so the ORIGIN is what
   *     persists, and the message is recomposed against the current target.
   */
  retargetAllForMcpEnv(from: string | null | undefined, to: string): McpEnvRestartTally {
    // A startup seed (no previous target) or a same-address reaffirmation is not
    // a move: nothing ever ran against a different address, so there is nothing
    // to report and this degrades to the ordinary silent respawn.
    if (!retargetIsWorthNudging(from, to)) return this.restartAllForMcpEnv();

    const keys = [...this.agents.keys()];
    const tally: McpEnvRestartTally = { live: 0, applied: 0, scheduled: 0 };
    for (const tabId of keys) {
      const queued = this.pendingMcpRestart.get(tabId);
      const queuedIsRetarget = this.pendingRetargetFrom.has(tabId);
      // #164: a queued PER-REQUEST nudge wins outright. (A queued `null` is a
      // silent pending respawn — no payload to protect — so it falls through.)
      if (queued && !queuedIsRetarget) {
        tallyRestart(tally, this.applyPendingRestarts(tabId));
        continue;
      }
      // The EARLIEST address this tab was stranded on is the true `from`.
      const origin = this.pendingRetargetFrom.get(tabId) ?? (from as string);
      // #1443 — ASK THE QUESTION ABOUT THE PAIR THAT GETS REPORTED.
      //
      // Whether this call is a move was decided from the INCOMING from→to, which is
      // the right question for the caller and the wrong one for this tab: the
      // message is composed from its PRESERVED origin. A tab held mid-turn across
      // A→B→A has origin A and to A — it never left A — and was told, in a real
      // agent turn, that its target changed from A to A. A→B→C, the case preserving
      // the origin exists for, is correct; this is its degenerate sibling.
      const stranded = retargetIsWorthNudging(origin, to);
      // Recompose BEFORE applying, not after: if the tab went idle in between,
      // applyPendingRestarts delivers whatever is queued right now, and a stale
      // A→B message would go out while the child is being respawned onto C.
      this.pendingMcpRestart.set(
        tabId,
        queuedIsRetarget && stranded ? staleTargetNudge(origin, to) : null,
      );
      const outcome = this.applyPendingRestarts(tabId);
      if (outcome === "scheduled" && stranded) {
        // Mid-turn: the tab is stranded on `origin` until the turn ends. Record
        // the origin so a further retarget in the same turn keeps it, and queue
        // the message the deferred respawn will carry.
        this.pendingRetargetFrom.set(tabId, origin);
        this.pendingMcpRestart.set(tabId, staleTargetNudge(origin, to));
      } else {
        // Applied, no agent, or a ROUND TRIP that landed back on `origin`: either
        // way this tab has nothing to be told. The respawn still happens — it is
        // the same env, so it is harmless — but it goes out silently.
        this.pendingRetargetFrom.delete(tabId);
      }
      tallyRestart(tally, outcome);
    }
    return tally;
  }

  /** Single-tab variant of restartAllForMcpEnv — used when ONE tab's tool-server
   *  spawn env changed (e.g. the Blind toggle, issue #90). Same coalesced
   *  at-idle replacement; no-op when the tab has no live agent. */
  restartForMcpEnv(key: string, nudge?: string): McpEnvRestartOutcome {
    if (!this.agents.has(key)) return "no-agent";
    // A SILENT restart (no nudge — a blind-mode toggle #90, a provider-key
    // refresh #278) must NOT erase a per-request secret nudge already queued for
    // this tab (#164). A real nudge still replaces/refreshes any existing one.
    if (nudge === undefined && this.pendingMcpRestart.get(key)) {
      return this.applyPendingRestarts(key);
    }
    this.pendingMcpRestart.set(key, nudge ?? null);
    // Whatever is queued now, it is no longer a retarget nudge (#1429). Leaving
    // the marker set would make the NEXT retarget classify this per-request nudge
    // as its own and overwrite it — the exact #164 erasure, one step removed.
    this.pendingRetargetFrom.delete(key);
    return this.applyPendingRestarts(key);
  }

  /**
   * #1700 — respawn this conversation so panel_add_mcp / panel_remove_mcp take
   * effect. Same coalesced at-idle replacement as restartForMcpEnv, but the
   * replacement FORKS: a plain resume would restore the MCP set recorded with
   * the old session (the reporter's `magic` server stayed failed after reload).
   * makeMcpServers() re-reads ~/.claude.json on the new spawn.
   */
  restartForMcpConfig(key: string, nudge?: string): McpEnvRestartOutcome {
    if (this.agents.has(key)) this.pendingForkOnRestart.add(key);
    return this.restartForMcpEnv(key, nudge);
  }

  /** Rebuild a live agent because its PROVIDER credential rotated (#278): keyed
   *  backends (OpenRouter/Custom/GLM/Kimi/Moonshot) capture the API key at
   *  construction, so a rotated/revoked key only takes effect on a fresh spawn.
   *  Reuses the coalesced at-idle restart (a fresh makeBackend reads the new
   *  env key) WITHOUT a retry nudge — this is a silent key refresh, not the
   *  download-401 flow. No-op when the tab has no live agent. */
  restartForProviderKey(key: string): void {
    this.restartForMcpEnv(key);
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
  /**
   * #1567 — ARM the orphan check for the next respawn, for ONE tab.
   *
   * Only a comfyui CREDENTIAL change may arm this, and the caller says which tab it
   * belongs to. Both restrictions come from review, and each fixes a real defect in the
   * first version, which hooked every restart unconditionally:
   *
   *  - `applyPendingRestarts` also serves retargets (#1429) and the base_path recovery
   *    respawn. Those are not credential saves, so a note saying one "was saved earlier"
   *    would have been false — and `retargetAllForMcpEnv` deliberately gives an IDLE tab
   *    NO turn, which an unconditional note broke for any tab while a download ran.
   *  - `restartAllForMcpEnv` applies each tab separately and the download list is global,
   *    so every restarted tab would have reported the SAME transfers. The credential
   *    respawn does replace every tab's comfyui child, so the global list is the right
   *    set — it just has to be told once, exactly like the retry nudge it travels with.
   *
   * `null` means "no particular tab" (a Settings-slot save): the first tab to restart
   * carries it. Either way it is consumed once.
   */
  /**
   * The credential-save respawn: restart every tab's comfyui child AND watch for what that
   * kills. One call rather than arm-then-restart, deliberately.
   *
   * Arming separately left a window that review's leak finding lives in: a watch created by
   * one call and bound by a LATER `restartAllForMcpEnv` would attach itself to whatever
   * tabs that later, unrelated respawn happened to queue. Creating and binding it in the
   * same call means a watch can never outlive the save that made it — if this save queues
   * nothing, it dies here.
   */
  restartAllForMcpEnvAfterCredentialChange(tabId: string | null): McpEnvRestartTally {
    this.credentialOrphanWatch = { tab: tabId, awaiting: new Set() };
    // #1567 item 2 — mark EVERY tab this save is about to respawn, BEFORE the loop that
    // respawns them, because an idle tab is replaced inside that call and would otherwise
    // reach the hold check unmarked.
    //
    // This deliberately does NOT ride on `credentialOrphanWatch`. That watch answers "who
    // gets TOLD, once" and is consumed by the first delivery; the hold has to answer "may
    // THIS tab's child be torn down yet", per tab, for as long as the restart is owed. An
    // early version keyed the hold off the watch and lost the second tab of a two-tab save
    // the moment the first one was served — that tab then killed its own transfers.
    for (const key of this.liveKeys()) this.credentialRespawnTabs.add(key);
    const tally = this.restartAllForMcpEnv();
    // An idle tab consumed it inside that call; otherwise bind it to exactly the tabs that
    // still owe a restart, and drop it when there are none.
    if (this.credentialOrphanWatch) {
      const awaiting = this.liveKeys().filter((k) => this.pendingMcpRestart.has(k));
      if (awaiting.length === 0) this.credentialOrphanWatch = null;
      else this.credentialOrphanWatch.awaiting = new Set(awaiting);
    }
    // Same trim for the marks: a tab that respawned (or had no agent) inside that call owes
    // nothing more to this save, so it must not stay marked and hold a LATER restart.
    for (const key of [...this.credentialRespawnTabs]) {
      if (!this.pendingMcpRestart.has(key)) this.credentialRespawnTabs.delete(key);
    }
    return tally;
  }
  /**
   * `tab` is who it is for; `awaiting` is what keeps it from LEAKING (review, P1).
   *
   * Consuming it only on delivery is not enough: a save that queues no restart at all — no
   * managed tabs — or whose named tab disappears before its restart runs would leave this
   * armed forever, and the next unrelated mcp-env respawn would then present a stale
   * "a credential was saved earlier" note. `awaiting` is the exact set of tabs this save
   * queued; the watch dies when that set empties, whether or not anything was delivered.
   */
  private credentialOrphanWatch: { tab: string | null; awaiting: Set<string> } | null = null;

  /** #1567 — this tab will never deliver the armed watch (its restart is being dropped).
   *  When nothing is left that could, the watch dies rather than waiting for a respawn it
   *  has no relationship to. */
  private releaseOrphanWatch(tabId: string): void {
    const watch = this.credentialOrphanWatch;
    if (!watch) return;
    watch.awaiting.delete(tabId);
    if (watch.awaiting.size === 0) this.credentialOrphanWatch = null;
  }

  /** #1567 item 2 — tabs whose still-owed MCP respawn came from a CREDENTIAL save, and are
   *  therefore allowed to wait for in-flight transfers. Membership is dropped the moment the
   *  restart resolves (applied, or the tab is gone), so it can never delay an unrelated one. */
  private credentialRespawnTabs = new Set<string>();

  /**
   * #1567 item 2 — a credential respawn that came due while transfers are running is HELD.
   *
   * `bytes`/`movedAt` are the stall detector, and the reason the hold has no wall-clock cap:
   * a cap does precisely the damage the hold exists to prevent — it kills a healthy 48 GB
   * transfer for being long. What it waits on instead is PROGRESS, so a dead or wedged
   * transfer stops being waited on after one stall window while a live one is waited on for
   * as long as it keeps moving.
   *
   * One record for the whole manager because the thing being waited on is global: the at-risk
   * enumeration lists every downloading job on this machine, not this tab's.
   */
  private respawnHold: {
    tabs: Set<string>;
    timer: ReturnType<typeof setInterval> | null;
    since: number;
    /** Total bytes fetched across the at-risk set at the last observation. */
    bytes: number;
    /** When that total last CHANGED — not when it was last read. */
    movedAt: number;
  } | null = null;

  /** How long the respawn now being applied was held, for the note. 0 when it was not. */
  private heldForMs(tabId: string): number {
    const hold = this.respawnHold;
    return hold?.tabs.has(tabId) ? Math.max(0, Date.now() - hold.since) : 0;
  }

  /** What a respawn would orphan right now, or `null` for COULD NOT TELL. Never throws.
   *
   *  The two are different answers and the caller treats them differently — collapsing a
   *  failed enumeration into `[]` is a real defect the gate caught here: an EIO on one poll
   *  tick reads as "the downloads finished", releases a hold that was working, and kills the
   *  48 GB transfer it had been protecting for an hour. */
  private atRiskNow(): { id: string; filename: string; bytes: number }[] | null {
    try {
      return downloadsAtRiskOfRespawn();
    } catch (err) {
      logger.debug("[panel-orchestrator] could not enumerate downloads a respawn would orphan", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * #1567 item 2 — WAIT rather than kill: is this credential respawn still worth holding?
   *
   * The reporter's loss was not that the respawn was late, it was that firing it destroyed
   * ~48 GB of transfers that had every reason to be alive. A QUEUED respawn is by definition
   * not urgent — it has already waited turns — and for a comfyui credential the running tools
   * re-read the value from disk at use time, so nothing about the new credential is waiting on
   * the rebuild. The transfers are what cannot be recreated cheaply, so they win.
   *
   * Called once per decision point (turn-done, or a poll tick), and it is also where the
   * stall bookkeeping is updated — so it must be called ONLY when the answer will be acted on.
   */
  private holdRespawnForTransfers(tabId: string): boolean {
    const atRisk = this.atRiskNow();
    const now = Date.now();
    if (atRisk === null) {
      // COULD NOT TELL. This may not answer either question, so it answers neither: it does
      // not start a hold (a hold on an unknown is a respawn that may never fire, and this is
      // the pre-#1567 behaviour, which killed nothing that was not already being killed), and
      // it does not END one — the case the gate found, where one EIO on a poll tick undoes an
      // hour of correctly protecting a live transfer.
      //
      // A hold survives on the stall clock, which is exactly right while the state is
      // unreadable: no progress can be OBSERVED, so `movedAt` does not advance, and repeated
      // failure gives up after the same window a frozen transfer would. Unreadable state
      // therefore delays the respawn by at most one stall window rather than indefinitely.
      const held = this.respawnHold;
      if (!held?.tabs.has(tabId)) return false;
      if (now - held.movedAt < respawnHoldStallMs()) return true;
      logger.info(
        `[panel-orchestrator] tab ${tabId.slice(0, 8)} credential respawn giving up its hold — the ` +
          `transfers it was waiting on could not be read for ${Math.round(respawnHoldStallMs() / 1000)}s (#1567)`,
      );
      return false;
    }
    if (atRisk.length === 0) {
      // Drained. This is the good ending: the respawn fires having killed nothing.
      if (this.respawnHold?.tabs.has(tabId)) {
        logger.info(
          `[panel-orchestrator] tab ${tabId.slice(0, 8)} credential respawn released after ` +
            `${Math.round(this.heldForMs(tabId) / 1000)}s — the transfers it was waiting on are done (#1567)`,
        );
      }
      this.releaseRespawnHold(tabId);
      return false;
    }
    const bytes = atRisk.reduce((n, d) => n + d.bytes, 0);
    const hold = this.respawnHold;
    if (!hold) {
      this.respawnHold = { tabs: new Set([tabId]), timer: null, since: now, bytes, movedAt: now };
      this.startRespawnHoldPoll();
      logger.info(
        `[panel-orchestrator] tab ${tabId.slice(0, 8)} credential respawn HELD — ${atRisk.length} ` +
          `download(s) in flight; it fires when they finish, or stop making progress (#1567)`,
      );
      return true;
    }
    hold.tabs.add(tabId);
    // ANY change is activity, including a DECREASE: one transfer finishing shrinks the set
    // and the total, and reading that as "no progress" would start the stall clock running
    // during the very thing being waited for.
    if (bytes !== hold.bytes) {
      hold.bytes = bytes;
      hold.movedAt = now;
    }
    if (now - hold.movedAt < respawnHoldStallMs()) return true;
    logger.info(
      `[panel-orchestrator] tab ${tabId.slice(0, 8)} credential respawn giving up its hold after ` +
        `${Math.round((now - hold.since) / 1000)}s — ${atRisk.length} download(s) made no progress ` +
        `for ${Math.round(respawnHoldStallMs() / 1000)}s (#1567)`,
    );
    return false;
  }

  /** Drop this tab from the hold, and retire the whole record (and its timer) with the last
   *  one. Called from every path that resolves a restart, so a hold cannot outlive its tabs. */
  private releaseRespawnHold(tabId: string): void {
    const hold = this.respawnHold;
    if (!hold) return;
    hold.tabs.delete(tabId);
    if (hold.tabs.size > 0) return;
    if (hold.timer) clearInterval(hold.timer);
    this.respawnHold = null;
  }

  /**
   * The only thing that can wake a held respawn.
   *
   * `applyPendingRestarts` runs at turn-done, so without this a tab that goes idle and stays
   * idle — which is exactly what a user watching a 48 GB download does — would hold its
   * respawn forever with nothing left to re-ask the question. The tick re-enters
   * `applyPendingRestarts`, which re-evaluates the hold and fires the restart when it lifts.
   *
   * unref'd: a pending respawn must never be the reason the process cannot exit.
   */
  private startRespawnHoldPoll(): void {
    const hold = this.respawnHold;
    if (!hold || hold.timer) return;
    hold.timer = setInterval(() => {
      // Snapshot: applyPendingRestarts mutates hold.tabs (and can retire the record).
      for (const tabId of [...(this.respawnHold?.tabs ?? [])]) this.applyPendingRestarts(tabId);
    }, respawnHoldPollMs());
    hold.timer.unref?.();
  }

  /** #1567 — what this respawn is about to orphan, enumerated NOW rather than at save
   *  time. Never throws: a rebuild that fails because its warning failed is strictly
   *  worse than a rebuild with no warning.
   *
   *  It is NOT non-blocking, and the earlier comment claiming otherwise was wrong
   *  (review): this reads job records and each active download's progress with sync IO,
   *  so a stalled filesystem stalls here. That is tolerated because it now runs at most
   *  once per credential save rather than on every restart — the same IO the save path
   *  already performs, moved to where it can see the right answer. A try/catch cannot
   *  time-bound a blocking syscall and is not pretended to. */
  private deferredRespawnOrphanNote(heldMs: number): string | null {
    try {
      return orphanedByDeferredRespawnNote(downloadsAtRiskOfRespawn(), heldMs);
    } catch (err) {
      logger.debug("[panel-orchestrator] could not enumerate downloads a respawn will orphan", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private applyPendingRestarts(tabId: string): McpEnvRestartOutcome {
    const wantEffort = this.pendingEffortRestart.has(tabId);
    const wantMcp = this.pendingMcpRestart.has(tabId);
    if (!wantEffort && !wantMcp) return "no-agent";
    const agent = this.agents.get(tabId);
    if (!agent || agent.isStopped) {
      this.pendingEffortRestart.delete(tabId);
      this.pendingMcpRestart.delete(tabId);
      this.pendingForkOnRestart.delete(tabId);
      this.pendingRetargetFrom.delete(tabId);
      // #1567 — this restart is being dropped, so it will never deliver an armed watch,
      // and there is no longer a session whose transfers a hold could protect.
      this.releaseOrphanWatch(tabId);
      this.credentialRespawnTabs.delete(tabId);
      this.releaseRespawnHold(tabId);
      return "no-agent";
    }
    // Still mid-work (a queued message will start the next turn) — wait for the
    // next idle so we don't restart between back-to-back turns.
    if (agent.isBusy || agent.hasPending) return "scheduled";
    // #1567 item 2 — WAIT FOR THE TRANSFERS, don't kill them.
    //
    // Everything below this line replaces the tool session, which is what orphaned the
    // reporter's nine downloads. A credential respawn has no deadline — the tools re-read
    // the credential from disk at use time, so it is a tidy-up, not the thing that makes
    // the new value work — and the transfers it would destroy cost hours and tens of GB.
    //
    // Two exclusions, both about respawns that are NOT tidy-ups:
    //   * unmarked tabs — a base_path recovery or any other plain mcp-env respawn, which
    //     this has no license to delay;
    //   * a RETARGET (#1429), where the running child is addressing the machine the user
    //     just left. Waiting there prolongs calls landing on the wrong ComfyUI, which is
    //     the failure retargeting exists to end. It kills the transfers, and the note
    //     below says so.
    const mayHold =
      wantMcp && this.credentialRespawnTabs.has(tabId) && !this.pendingRetargetFrom.has(tabId);
    if (mayHold && this.holdRespawnForTransfers(tabId)) return "scheduled";
    // Held or not, this restart is now resolving, so the mark is spent. Read the hold's age
    // BEFORE releasing it — that is what the note reports.
    const heldMs = this.heldForMs(tabId);
    this.credentialRespawnTabs.delete(tabId);
    this.releaseRespawnHold(tabId);
    // Only the MCP respawn carries a retry nudge.
    const nudge = wantMcp ? (this.pendingMcpRestart.get(tabId) ?? undefined) : undefined;
    // #1567 — RE-TAKE the at-risk snapshot HERE. The save-time one (#1378) is taken
    // before the emit because for an APPLIED respawn the emit is the damage. For a
    // QUEUED one the damage is this line, arbitrarily many turns later, so a save-time
    // snapshot cannot see a transfer that started in between — which is exactly what
    // happened: nothing in flight at save, nine downloads started over the next two
    // turns, all killed here with no warning at any point.
    //
    // ONLY for an armed credential respawn, and ONLY once — see
    // armCredentialRespawnOrphanWatch. A note on any other restart would be both untrue
    // and a spurious agent TURN, which is a response the user did not ask for.
    const watch = this.credentialOrphanWatch;
    const watched = wantMcp && watch !== null && (watch.tab === null || watch.tab === tabId);
    // A tab leaves `awaiting` when its queued restart RESOLVES, whichever way — delivery
    // retires the whole watch, and anything else just means this tab can no longer be the
    // one to deliver it (review, round 3).
    //
    // Releasing only on the dropped path was not enough. A save on tab A with B also busy
    // leaves awaiting={A,B}; retiring A trims it to {B}; B then restarts successfully,
    // matches nothing, and releases nothing — so the set never empties. The watch sits
    // there until a recreated A restarts and collects a warning about a save from long
    // before it existed.
    //
    // The busy early-return above is deliberately upstream of this: "scheduled" means the
    // tab still owes a restart, so it has not resolved and must stay in the set.
    if (watched) this.credentialOrphanWatch = null;
    else this.releaseOrphanWatch(tabId);
    const orphanNote = watched ? this.deferredRespawnOrphanNote(heldMs) : null;
    const finalNudge = orphanNote ? [nudge, orphanNote].filter(Boolean).join("\n\n") : nudge;
    this.pendingEffortRestart.delete(tabId);
    this.pendingMcpRestart.delete(tabId);
    this.pendingRetargetFrom.delete(tabId);
    const forkSession = this.pendingForkOnRestart.delete(tabId);
    const carried = this.restartAgentResume(tabId, agent, finalNudge, { forkSession });
    const reasons = [
      wantEffort ? "effort" : null,
      wantMcp ? (forkSession ? "mcp-config" : "comfyui-mcp-env") : null,
    ]
      .filter(Boolean)
      .join("+");
    logger.info(
      `[panel-orchestrator] tab ${tabId.slice(0, 8)} restart applied (idle, reason=${reasons}, ${carried} queued carried over${nudge ? " + retry nudge" : ""})`,
    );
    return "applied";
  }

  /** Cancel a still-queued message for a tab (user edited/deleted it before the
   *  agent read it). Returns true if it was removed from the queue. Also reaches
   *  HELD mail (issue #256 follow-up): after a failed start parks messages in
   *  heldMessages there is no live agent, but the user can still delete/edit the
   *  bubble — without this the cancelled prompt would execute on the next spawn
   *  (possibly alongside its replacement). */
  cancelQueued(tabId: string, mid: string): boolean {
    if (this.agents.get(tabId)?.cancelQueued(mid)) return true;
    const held = this.heldMessages.get(tabId);
    if (held) {
      const i = held.findIndex((item) => item.mid === mid);
      if (i >= 0) {
        held.splice(i, 1);
        if (held.length === 0) this.heldMessages.delete(tabId);
        return true;
      }
    }
    return false;
  }

  /** Replace a tab's agent with a fresh one (picks up the manager's current
   *  model/effort/mcpServers), resuming the conversation and carrying over any
   *  unsent queued messages. `nudge`, if given, is enqueued after the carried-over
   *  messages so the resumed agent auto-continues. Returns how many were carried. */
  private restartAgentResume(
    tabId: string,
    oldAgent: PanelAgent,
    nudge?: string,
    spawnOpts?: { forkSession?: boolean },
  ): number {
    const resume = oldAgent.sessionId ?? undefined;
    const pending = oldAgent.takePending();
    const fresh = this.spawn(tabId, resume, spawnOpts); // new agent owns the tab now
    for (const item of pending) {
      fresh.send(item.text, {
        images: item.images,
        // #790 — carry AUDIO across the restart too. Dropping it here would
        // re-deliver the message as text-only with no refusal and no notice:
        // the user's question about a sound, answered from the text alone,
        // with nothing anywhere saying the audio went missing.
        audio: item.audio,
        mid: item.mid,
        // #468 — carry the run-completion tokens over so the replacement agent
        // acks the completion it inherited (rather than the journal replaying it
        // as a second copy), AND the completionOnly marker with them: an item
        // that loses it can no longer be removed from held mail later, so its
        // text would outlive its token.
        ...(item.completionOnly ? { completionOnly: true } : {}),
        ...(item.eventTokens?.length ? { eventTokens: item.eventTokens } : {}),
      });
    }
    if (nudge) fresh.send(nudge);
    void oldAgent.stop(); // retire the old one; it's no longer mapped
    return pending.length;
  }

  /** Last usage snapshot for a tab's agent (for re-pushing the meter on connect). */
  lastStatusFor(tabId: string): UsageStatus | null {
    return this.agents.get(tabId)?.lastStatus ?? null;
  }

  /** Feed a ComfyUI execution event to an EXISTING agent (no-op if none — we
   *  never spawn an agent just to react to an event). Returns whether the agent
   *  TOOK it onto its queue — not that it was read; a run completion carrying an
   *  `eventToken` is only acked when the turn that delivered it ends (#468). */
  injectEvent(
    tabId: string,
    ev: {
      kind?: string;
      images?: ImageRef[];
      error?: string;
      note?: string;
      // #1574 — set by the orchestrator when the job RECORD still reads "downloading" for
      // a row claiming done. Disclosed on the event; never used to suppress it.
      downloads?: Array<{
        name: string;
        status: string;
        supersededByLive?: boolean;
        recordDisagrees?: boolean;
      }>;
      prompt_id?: string;
      run_correlation?: "matched" | "foreign" | "unidentified";
      run_correlation_prior?: boolean;
      replayed?: boolean;
      dropped_completions?: number;
      possible_repeat?: boolean;
      /** #486 - a validated `panel_ask` answer that no tool call was alive to
       *  receive, carried together with the question it (and only it) answers. */
      ask_question?: string | null;
      ask_answer?: string;
      ask_correlation?: "matched" | "foreign";
      ask_answered_at?: number;
      dropped_answers?: number;
    },
    opts?: {
      eventToken?: string;
      /** #884 P0 — synthetic origin mid: rides the queue so the injected turn
       *  fires onSeen at dequeue and acquires its origin pin/stamp like any
       *  user turn (a run error on tab A must pin A, never follow the active
       *  tab — confirming-gate 2). */
      mid?: string;
    },
  ): boolean {
    const agent = this.agents.get(tabId);
    if (!agent || agent.isStopped) return false; // best-effort; don't enqueue into a closed agent
    return agent.injectEvent(ev, opts);
  }

  /** Pull a still-queued injected completion back off a tab's agent by journal
   *  token (#468), so a weakened correlation can be re-delivered honestly.
   *  False when there is no such agent or the turn carrying it already started. */
  revokeEvent(tabId: string, token: string): boolean {
    const agent = this.agents.get(tabId);
    if (!agent || agent.isStopped) return false;
    return agent.revokeEvent(token);
  }

  /**
   * Ride a journal token on the tab's IN-FLIGHT turn so that turn's result acks
   * it (#486).
   *
   * Returns the CARRIER IDENTITY the token was attached to — the agent key plus
   * that agent's instance identity — or null when there is no agent or no turn
   * running. The caller freezes it onto the entry and the journal refuses any
   * ack that does not match, so a provider switch (which re-points the tab at a
   * different agent) can never let one conversation's turn certify another's
   * answer.
   */
  attachTurnToken(tabId: string, token: string): string | null {
    const agent = this.agents.get(tabId);
    if (!agent || agent.isStopped) return null;
    if (!agent.attachTurnToken(token)) return null;
    return agent.carrierId;
  }

  /** Push a ComfyUI execution error to a tab's agent — interrupt the live turn
   *  and front-queue the error so the agent stops and addresses it. */
  async injectRunError(
    tabId: string,
    error: string,
    opts?: { mid?: string; originTab?: string },
  ): Promise<boolean> {
    const agent = this.agents.get(tabId);
    if (!agent || agent.isStopped) return false;
    await agent.injectRunError(error, opts);
    return true;
  }

  private spawn(tabId: string, resume?: string, spawnOpts?: { forkSession?: boolean }): PanelAgent {
    const agent = this.makeAgent(tabId);
    if (spawnOpts?.forkSession) agent.requestForkOnResume();
    this.agents.set(tabId, agent);
    logger.info(
      `[panel-orchestrator] spawning agent for tab ${tabId.slice(0, 8)}${resume ? " (resume)" : ""} (${this.agents.size} active)`,
    );
    // Re-deliver mail orphaned by a previous FAILED start on this key (issue
    // #256): the doomed agent's still-queued messages were captured at
    // settle(err) below; queue them into the fresh agent FIRST so they run
    // ahead of whatever message triggered this spawn (chronological order).
    // If this start fails too, settle(err) captures them right back — no loss.
    const held = this.heldMessages.get(tabId);
    if (held?.length) {
      this.heldMessages.delete(tabId);
      for (const item of held) {
        agent.send(item.text, {
          images: item.images,
          audio: item.audio, // #790 — see restartAgentResume: never re-deliver an audio turn as text-only
          mid: item.mid,
          // #468 — preserve the completionOnly marker across EVERY re-delivery.
          // A second consecutive failed start would otherwise return this item to
          // held mail unmarked, making its text un-removable by a later detach.
          ...(item.completionOnly ? { completionOnly: true } : {}),
          ...(item.eventTokens?.length ? { eventTokens: item.eventTokens } : {}),
        });
      }
      logger.info(
        `[panel-orchestrator] tab ${tabId.slice(0, 8)} re-delivering ${held.length} message(s) held from the previous failed start`,
      );
    }
    // #468 — a fresh agent is mapped and can take mail: replay any run
    // completions journaled while this key had no live agent. Fired BEFORE
    // start() so the replay is queued ahead of the session coming up, and after
    // held mail so ordering stays chronological.
    try {
      this.opts.onAgentReady?.(tabId);
    } catch (err) {
      logger.warn(`[panel-orchestrator] tab ${tabId.slice(0, 8)} completion replay: ${msgOf(err)}`);
    }
    // start() now SELF-RESTARTS internally on session-end, so it only settles on
    // an intentional stop() or after it gives up (repeated immediate failures),
    // or it rejects on a hard start failure. In the give-up / reject cases, drop
    // the dead agent (if still mapped and not stopped on purpose) so the next
    // user message spawns a fresh one.
    const settle = (err?: unknown) => {
      if (agent.isStopped) return;
      // Locate the agent by IDENTITY, not by its spawn-time key (issue #255):
      // rebindAgent() may have moved a still-starting agent to a NEW key (panel
      // tab-id migration), and the old key-based guard (agents.get(tabId) !==
      // agent) early-returned in that case — a prepare()-rejected agent then
      // stayed mapped under the new key forever: hasLiveAgent true, queue never
      // drained, no warning, tab wedged until reset. The failure must clean up
      // (and report onStartFailure for) whatever key CURRENTLY maps this agent.
      let key: string | undefined;
      for (const [k, a] of this.agents) {
        if (a === agent) {
          key = k;
          break;
        }
      }
      if (key === undefined) return; // already replaced/dropped — nothing to settle
      const gaveUp = agent.gaveUp;
      this.agents.delete(key);
      if (err) {
        const m = msgOf(err);
        logger.error(`[panel-agent ${key.slice(0, 8)}] failed to start: ${m}`);
        // Held mail (issue #256): prepare() rejected before the channel was
        // ever consumed, so EVERY message sent since the spawn is still in the
        // agent's queue — including the one that triggered it. Capture them
        // (BEFORE stop(), which closes the agent) for re-delivery by the next
        // spawn on this key, so nothing dies silently with the doomed agent.
        this.holdOrphanedMail(key, agent.takePending(), "a failed start");
        // PER-TAB degradation (issue #250): a hard start failure is almost
        // always a tab-local configuration error — an invalid API key (the
        // endpoint 401s in prepare()), an unreachable base URL, a missing CLI
        // login. It must degrade THIS tab only. The old escalation
        // (onAgentFatal → orchestrator self-exit) killed every OTHER tab too,
        // including healthy sessions on different providers. The agent slot was
        // cleared above, so after the user fixes the key, the next message /
        // Disconnect → Connect spawns a fresh agent on the same tab.
        // Report under the CURRENT key (not the spawn-time tabId) so the
        // orchestrator's composite-key → panel-tab split reaches the tab that
        // owns the agent NOW, even after a rebind (issue #255).
        if (this.opts.onStartFailure) this.opts.onStartFailure(key, m);
        else this.opts.onSay(key, `⚠️ The panel agent could not start: ${m}`);
        // Insurance, not correctness: every current backend self-cleans when
        // prepare() throws, but that's per-backend convention — stop() makes
        // backend.close?.() a guarantee now that the process SURVIVES this
        // path (it used to exit, which mooted cleanup).
        void agent.stop().catch(() => {});
      } else if (gaveUp) {
        // The bounded self-restart loop gave up — the session keeps dropping.
        // Same treatment as the hard-start failure above for the agent's QUEUE
        // (#468): its still-unread messages — a run completion among them — were
        // dying here. `settle` only unmapped the agent, so a completion sitting
        // in its queue stayed `handed_off` in the journal, a state deliverPending
        // skips: no replay, ever. Capture the queue into held mail (its tokens
        // ride along, so a respawn re-delivers exactly once) and stop() the agent
        // so anything left over is handed back.
        this.holdOrphanedMail(key, agent.takePending(), "an agent that gave up");
        void agent.stop().catch(() => {});
        // Fatal signal: let the orchestrator self-exit + respawn.
        this.opts.onAgentFatal?.(key, "agent session kept dropping (self-restart gave up)");
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

  /** Reorder a tab's still-queued messages to the panel's desired flush order.
   *  Also applies to HELD mail (a failed start parked the queue — the panel can
   *  still drag bubbles while the tab is degraded), with the same stable-sort
   *  semantics as PanelAgent.reorderQueue. */
  reorderQueue(tabId: string, order: string[]): boolean {
    let applied = false;
    const held = this.heldMessages.get(tabId);
    if (Array.isArray(order) && held && held.length >= 2) {
      const rank = new Map(order.map((mid, i) => [mid, i]));
      const at = (mid?: string) => (mid && rank.has(mid) ? rank.get(mid)! : Number.MAX_SAFE_INTEGER);
      held.sort((a, b) => at(a.mid) - at(b.mid));
      applied = true;
    }
    const agent = this.agents.get(tabId);
    if (!agent || agent.isStopped) return applied;
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
    // DURABLE state migrates even when no live agent exists (codex review:
    // the agent may have been reaped while its persisted session survives —
    // skipping this meant the rebound tab started a fresh conversation).
    const moveDurable = () => {
      if (this.pendingResume.has(oldKey)) {
        this.pendingResume.set(newKey, this.pendingResume.get(oldKey)!);
        this.pendingResume.delete(oldKey);
      }
      const persisted = this.opts.sessionStore?.get(oldKey);
      // Carry the identity binding across the tab-id migration (same workflow, so the
      // uuid is unchanged) — read the OLD entry's binding, since tabStableIdentity for the
      // new tab may not be populated yet at rebind time.
      const persistedIdentity = this.opts.sessionStore?.identityOf(oldKey);
      if (persisted) this.opts.sessionStore?.set(newKey, persisted, persistedIdentity);
      this.opts.sessionStore?.clear(oldKey);
      // Held mail from a failed start migrates too (issue #256) — it exists
      // precisely when NO live agent does, so it must move in the durable pass
      // for the rebound tab's next spawn to re-deliver it. Old-key mail is
      // older, so it goes ahead of anything already held under the new key.
      const heldOld = this.heldMessages.get(oldKey);
      if (heldOld?.length) {
        this.heldMessages.set(newKey, [...heldOld, ...(this.heldMessages.get(newKey) ?? [])]);
      }
      this.heldMessages.delete(oldKey);
    };
    const agent = this.agents.get(oldKey);
    if (!agent || agent.isStopped) {
      moveDurable();
      return false;
    }
    this.agents.delete(oldKey);
    this.agents.set(newKey, agent);
    // The live agent must ADOPT the new id, not just be re-filed under it (#568
    // Defect 1). A panel tab id never contains the "::" backend separator, so the
    // segment before the LAST "::" is the bare panel tab the panel server binds to.
    const sep = newKey.lastIndexOf("::");
    const panelTabId = sep >= 0 ? newKey.slice(0, sep) : newKey;
    agent.rebindTabId(newKey, panelTabId);
    // has()-based moves throughout (codex review): truthy checks dropped
    // legitimate null/undefined sentinels (e.g. restart-without-nudge, an
    // explicit effort-override clear).
    if (this.pendingEffortRestart.has(oldKey)) {
      this.pendingEffortRestart.delete(oldKey);
      this.pendingEffortRestart.add(newKey);
    }
    if (this.pendingMcpRestart.has(oldKey)) {
      this.pendingMcpRestart.set(newKey, this.pendingMcpRestart.get(oldKey)!);
      this.pendingMcpRestart.delete(oldKey);
    }
    if (this.pendingForkOnRestart.delete(oldKey)) this.pendingForkOnRestart.add(newKey);
    // #1567 — the mark and the hold classify that same queued restart, so they travel with
    // it. Left behind, the renamed tab's credential respawn stops being one this may wait
    // for, and fires into whatever downloads are running under the new key.
    if (this.credentialRespawnTabs.delete(oldKey)) this.credentialRespawnTabs.add(newKey);
    const hold = this.respawnHold;
    if (hold?.tabs.delete(oldKey)) hold.tabs.add(newKey);
    // The marker classifies that value (#1429), so it has to travel with it: left
    // behind, the renamed tab's queued retarget nudge reads as a per-request one
    // and the next retarget preserves an obsolete target instead of recomposing.
    if (this.pendingRetargetFrom.has(oldKey)) {
      this.pendingRetargetFrom.set(newKey, this.pendingRetargetFrom.get(oldKey)!);
      this.pendingRetargetFrom.delete(oldKey);
    }
    if (this.modelByKey.has(oldKey)) {
      this.modelByKey.set(newKey, this.modelByKey.get(oldKey)!);
      this.modelByKey.delete(oldKey);
    }
    if (this.effortByKey.has(oldKey)) {
      this.effortByKey.set(newKey, this.effortByKey.get(oldKey)!);
      this.effortByKey.delete(oldKey);
    }
    moveDurable();
    return true;
  }

  /** Route a panel message to its tab's agent, creating the agent if needed.
   *  Never routes into a stopped agent (whose channel is closed) — respawns so
   *  the message reaches a live session. */
  send(
    tabId: string,
    text: string,
    meta?: { title?: string; images?: ImageRef[]; audio?: AudioRef[]; mid?: string },
  ): void {
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
      // #570 — the durable exact record wins ONLY when its OWNING identity matches this tab's
      // current identity. A destination session collided-onto from another tab (the same wf:<path>
      // or reused key) can carry a DIFFERENT owning identity than the tab connecting now; inheriting
      // it would attach this tab to another tab's conversation. When the stored identity differs
      // from the current one, IGNORE the durable record and fall back to the (validated) hint —
      // this is the last-line guard behind the hello-handler choke point that resets such a record.
      // Both-unknown (pre-`u` record or identity-less tab) fails OPEN, preserving prior behaviour.
      const durable = this.opts.sessionStore?.get(tabId);
      const durableIdentity = this.opts.sessionStore?.identityOf(tabId);
      const currentIdentity = this.opts.identityForKey?.(tabId);
      const durableOwnedByThisTab =
        durable !== undefined &&
        (durableIdentity === undefined ||
          currentIdentity === undefined ||
          durableIdentity === currentIdentity);
      const resume = (durableOwnedByThisTab ? durable : undefined) ?? this.pendingResume.get(tabId);
      this.pendingResume.delete(tabId);
      agent = this.spawn(tabId, resume);
    }
    agent.send(text, { title: meta?.title, images: meta?.images, audio: meta?.audio, mid: meta?.mid });
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

  /**
   * THE SINGLE TEARDOWN SEAM for unbinding a key's agent (#468). Every path that
   * stops an agent must go through here, so a future third teardown can't
   * silently re-open the hole that `retire()` had: it preserved `heldMessages`
   * without releasing the run-completion tokens parked in them, leaving those
   * entries `handed_off` — a state `deliverPending()` skips — with no agent left
   * to consume them and no disclosure.
   *
   * Held mail is DETACHED from its completion tokens either way: the message
   * text keeps whatever preservation semantics the caller wants, while ownership
   * of the completion returns to the journal, which replays it to whatever agent
   * serves this panel tab next (a different provider's key included — the
   * journal is keyed by panel tab).
   *
   * `dropHeldMail` distinguishes the two callers: reset() is an explicit fresh
   * start and discards the mail; retire() preserves it for when the workflow is
   * reopened. Returns the unbound agent (if any) for the caller to stop.
   */
  private unbindAgent(key: string, opts: { dropHeldMail: boolean; reason: string }): PanelAgent | undefined {
    const agent = this.agents.get(key);
    this.agents.delete(key);
    // #1567 — this tab can no longer deliver an armed orphan watch. The single choke point
    // for removal, so a retire/reset cannot strand one waiting on a tab that is gone.
    this.releaseOrphanWatch(key);
    // …and its held respawn dies with it: the session whose transfers the hold was protecting
    // is being torn down here regardless, so waiting longer protects nothing and would leave
    // a poll timer re-entering applyPendingRestarts for a key with no agent.
    this.credentialRespawnTabs.delete(key);
    this.releaseRespawnHold(key);
    this.detachHeldCompletions(key, opts.reason);
    if (opts.dropHeldMail) this.heldMessages.delete(key);
    return agent;
  }

  /**
   * Hand a key's HELD-MAIL run completions back to the journal (#468).
   *
   * The completion must leave held mail ENTIRELY, not just lose its token.
   * Stripping the token alone left the event's TEXT sitting in preserved mail:
   * `retire()` keeps that mail, so switching Claude→Codex handed the journal's
   * token to Codex (delivered, correctly) and then switching BACK to Claude
   * re-delivered the retained text as an ordinary user message — no token, no
   * `possible_repeat` flag, indistinguishable from a real second completion.
   * Preservation semantics are for the user's own mail; a completion whose token
   * has moved on is not that.
   *
   * Dropping the item is safe precisely because an injected event is always its
   * own `completionOnly` item — a re-queued turn restores the original items
   * rather than one merged blob — so no user message is ever removed with it.
   *
   * Every release here is UNCARRIED (the default): nobody read these, so they
   * must not count toward the journal's bounded replay cycle. Only a turn that
   * ran and ended is `carried`.
   */
  /**
   * Park a dead agent's unsent mail for the next spawn — but NEVER its injected
   * completions (#468).
   *
   * Held mail is unbounded and the journal's revocation can only reach a LIVE
   * agent's queue, so a completion parked here is a copy the journal can no
   * longer count or cap: each failed-start/retry cycle would strand another
   * capped batch in held mail, and the whole pile eventually drains into one
   * turn. Completions are revocable by design and the JOURNAL is their record —
   * so they are handed back instead, and replayed (bounded) into whatever agent
   * comes next. Only the user's own messages are held.
   */
  private holdOrphanedMail(key: string, orphaned: QueueItem[], reason: string): void {
    if (!orphaned.length) return;
    const completions = orphaned.filter((it) => it.completionOnly);
    const mail = orphaned.filter((it) => !it.completionOnly);
    if (mail.length) {
      this.heldMessages.set(key, [...(this.heldMessages.get(key) ?? []), ...mail]);
      logger.warn(
        `[panel-orchestrator] tab ${key.slice(0, 8)} holding ${mail.length} undelivered message(s) from ${reason} — re-delivered on the next successful start`,
      );
    }
    const tokens = completions.flatMap((it) => it.eventTokens ?? []);
    if (!tokens.length) return;
    logger.warn(
      `[panel-orchestrator] tab ${key.slice(0, 8)}: ${tokens.length} run completion(s) were queued on ${reason} — returned to the journal (never held) for bounded replay (#468)`,
    );
    try {
      this.opts.onEventUndelivered?.(key, tokens);
    } catch (err) {
      logger.warn(`[panel-orchestrator] tab ${key.slice(0, 8)} returning orphaned completions: ${msgOf(err)}`);
    }
  }

  private detachHeldCompletions(key: string, reason: string): void {
    const held = this.heldMessages.get(key);
    if (!held?.length) return;
    const tokens: string[] = [];
    const keep: QueueItem[] = [];
    for (const item of held) {
      if (!item.eventTokens?.length) {
        keep.push(item);
        continue;
      }
      tokens.push(...item.eventTokens);
      delete item.eventTokens; // the journal owns it now — never ack it twice
      if (item.completionOnly) continue; // …and the event's text goes with it
      // Defensive: a token on a non-completionOnly item would mean the item
      // carries user text too, so it must survive — but then its embedded event
      // text could be re-delivered untracked. Construction prevents this; log
      // loudly if it ever happens rather than silently allowing a phantom.
      logger.error(
        `[panel-orchestrator] tab ${key.slice(0, 8)} ${reason}: held item carried a completion token but is not completionOnly — keeping its text (#468)`,
      );
      keep.push(item);
    }
    if (keep.length !== held.length) this.heldMessages.set(key, keep);
    if (!tokens.length) return;
    logger.warn(
      `[panel-orchestrator] tab ${key.slice(0, 8)} ${reason}: ${tokens.length} run completion(s) were parked in held mail — returned to the journal for replay (#468)`,
    );
    try {
      this.opts.onEventUndelivered?.(key, tokens);
    } catch (err) {
      logger.warn(`[panel-orchestrator] tab ${key.slice(0, 8)} releasing held completion tokens: ${msgOf(err)}`);
    }
  }

  /** Forget a tab's agent so the next message starts a brand-new session. The
   *  map mutation is synchronous and the old agent is stopped fire-and-forget,
   *  so the caller (e.g. resume_session) can set a new pendingResume right after
   *  without a concurrent send() spawning a non-resumed agent in an await gap.
   *  Returns whether the durable session clear actually reached disk — false
   *  means this process starts fresh but an orchestrator restart could resume
   *  the cleared conversation, which the caller must disclose rather than
   *  report a clean New chat (codex confirming-gate P1: false-success). */
  reset(tabId: string): { durableCleared: boolean } {
    // Unbind through the SHARED teardown seam (#468) — it is what guarantees a
    // run completion parked in held mail is handed back rather than discarded.
    const agent = this.unbindAgent(tabId, { dropHeldMail: true, reason: "reset" });
    this.pendingResume.delete(tabId);
    // Forget the durable session too — a NEW chat must start fresh, so the disk
    // fallback in send() can't resurrect the conversation the user just cleared.
    // (resume_session calls reset() then setResume() with the chosen id, so the
    // historical session is re-armed right after and re-persisted on next onSession.)
    const durableCleared = this.opts.sessionStore ? this.opts.sessionStore.clear(tabId) : true;
    this.pendingEffortRestart.delete(tabId); // a reset supersedes any deferred restart
    this.pendingMcpRestart.delete(tabId);
    this.pendingForkOnRestart.delete(tabId);
    this.pendingRetargetFrom.delete(tabId); // #1429 — nothing queued, nothing to classify
    // Drop this key's picker override so a provider switch (which reset()s the old
    // key) can't carry the old provider's model/effort into the new backend's spawn.
    this.modelByKey.delete(tabId);
    this.effortByKey.delete(tabId);
    if (agent) {
      logger.info(`[panel-orchestrator] tab ${tabId.slice(0, 8)} reset — new session next message`);
      void agent.stop();
    }
    return { durableCleared };
  }

  /** Stop and UNBIND a tab's live agent WITHOUT touching its durable session — used
   *  when the same browser socket switches to a DIFFERENT workflow (a validated uuid
   *  change, #570 P0a). Unlike reset() — which CLEARS the durable session for a New
   *  chat — this preserves sessionStore/pendingResume/held mail, so the retired
   *  workflow resumes exactly where it left off when reopened, while its now-stopped
   *  agent can no longer push frames that the bridge migration alias would leak into
   *  the newly-targeted view.
   *
   *  Held mail is PRESERVED (that is the point) but its run completions are NOT
   *  (#468): with the agent gone they would sit `handed_off` forever — a state
   *  `deliverPending()` skips — so a provider switch that retires the key would
   *  silently swallow them. The shared teardown detaches and returns them, and it
   *  runs even when no live agent owns the key (a retire with only held mail is
   *  exactly the case that lost them). */
  retire(tabId: string): void {
    const agent = this.unbindAgent(tabId, { dropHeldMail: false, reason: "retire" });
    if (!agent) return;
    void agent.stop();
    logger.info(
      `[panel-orchestrator] tab ${tabId.slice(0, 8)} retired (workflow switch on the same socket) — durable session preserved`,
    );
  }

  /** Interrupt a tab's live agent. Returns whether a live agent actually TOOK the
   *  interrupt — an interrupt addressed to a key with no agent is a silent no-op that
   *  arms NO recovery at all (no turn gate is held, no release fallback is scheduled),
   *  so the caller must not report it as a completed cancellation. Reporting "done"
   *  for an interrupt nothing received is the same could-not/did-not conflation that
   *  made #568 look like a wedge nobody could explain. */
  async interrupt(tabId: string, opts: { requeueInFlight?: boolean } = {}): Promise<boolean> {
    const agent = this.agents.get(tabId);
    // MAP PRESENCE IS NOT LIVENESS. stopAll() sets `closed` synchronously on every
    // agent but keeps them MAPPED until each awaited stop() resolves — and stop()
    // awaits the backend, which can hang. An interrupt arriving in that window has
    // nothing that can take it, so returning true here would fabricate exactly the
    // success this method exists to stop fabricating. Bail without awaiting, too: a
    // hung backend.interrupt() must not be able to stall the answer.
    if (!agent || agent.isStopped) return false;
    await agent.interrupt(opts);
    return true;
  }

  async stopAll(): Promise<void> {
    this.pendingEffortRestart.clear();
    this.pendingMcpRestart.clear();
    this.pendingForkOnRestart.clear();
    // #1567 — no restart is owed any more, so nothing may be held for one. The poll timer is
    // unref'd, but a shutdown that leaves it running would keep re-entering
    // applyPendingRestarts against agents this method is in the middle of stopping.
    this.credentialRespawnTabs.clear();
    if (this.respawnHold?.timer) clearInterval(this.respawnHold.timer);
    this.respawnHold = null;
    // #468 — go through the same detach seam as reset()/retire() for EVERY key
    // before dropping held mail. The journal is about to be reported on by the
    // orchestrator's shutdown disclosure, and an entry still marked `handed_off`
    // because its token died inside discarded held mail would be missed by the
    // replay AND read as merely "in flight" rather than lost.
    for (const key of [...this.heldMessages.keys()]) {
      this.detachHeldCompletions(key, "shutdown");
    }
    this.heldMessages.clear();
    await Promise.all([...this.agents.values()].map((a) => a.stop()));
    this.agents.clear();
  }

  count(): number {
    return this.agents.size;
  }

  /** True when any message is parked in the held-mail map (a start failure
   *  captured a doomed agent's queue for re-delivery, issue #256). Surfaced so
   *  the self-restart gate can refuse to restart while mail is parked —
   *  teardown (stopAll) ERASES held mail, so an auto-restart while it exists
   *  would silently drop the very messages the hold protects. */
  hasHeldMail(): boolean {
    for (const msgs of this.heldMessages.values()) {
      if (msgs.length > 0) return true;
    }
    return false;
  }

  /** True when this key's agent has a turn in flight (or messages queued to
   *  start one imminently) — i.e. the panel's working spinner belongs to a REAL
   *  turn that will push its own turn:"done". The orchestrator's held-during-gen
   *  branch checks this before clearing the spinner, so a tab-wide turn:"done"
   *  can never hide an ACTIVE turn's spinner or disarm its resume nudge. */
  isTurnActive(key: string): boolean {
    const agent = this.agents.get(key);
    return !!agent && !agent.isStopped && (agent.isBusy || agent.hasPending);
  }

  /** True when NO agent is mid-turn or holding queued messages AND no failed-
   *  start mail is parked for re-delivery — the only moment a self-restart may
   *  replace the process without eating a reply (or erasing held mail). */
  allIdle(): boolean {
    for (const a of this.agents.values()) {
      if (a.isBusy || a.hasPending) return false;
    }
    return !this.hasHeldMail();
  }

  get defaults(): { model: string; effort?: Effort } {
    return { model: this.model, effort: this.effort };
  }
}
