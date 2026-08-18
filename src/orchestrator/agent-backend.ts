// Agent backend port — the provider-neutral seam that lets the panel orchestrator
// run on different agent providers (Claude Agent SDK today, OpenAI Codex next) via
// dependency injection. See design/agent-backend-injection.md.
//
// PanelAgent keeps the orchestration (queue, turn-gate, bridge push, rewind-anchor
// tracking, self-restart) and delegates the provider-specific bits — opening a
// session, normalizing the provider's message stream to canonical AgentEvents,
// interrupt, model enumeration, session resume/fork — to an injected AgentBackend.

import type { ImageRef } from "./panel-agent.js";
import type { AudioRef } from "./audio-attachment.js";

export type BackendId =
  | "claude"
  | "codex"
  | "chatgpt"
  | "gemini"
  | "antigravity"
  | "pi"
  | "grok"
  | "glm"
  | "kimi"
  | "moonshot"
  | "minimax"
  | "atlascloud"
  | "ollama"
  | "openrouter"
  | "copilot";

/**
 * A user turn in PROVIDER-NEUTRAL form. PanelAgent owns the queue/turn-gate and
 * yields these; the backend shapes them into its provider's native user message
 * (e.g. Claude `SDKUserMessage`, resolving image refs to inline blocks). This is
 * the "channel in" seam — PanelAgent never deals in `SDKUserMessage`.
 */
export interface NeutralTurn {
  /** The combined user text for this turn. */
  text: string;
  /** ComfyUI image refs to deliver inline (vision), resolved by the backend. */
  images?: ImageRef[];
  /** ComfyUI audio refs to deliver inline (hearing, #790), resolved by the
   *  backend. Only reaches a backend whose `AgentCapabilities.audio` is true —
   *  PanelAgent refuses centrally (and visibly) for the rest, so an audio-less
   *  adapter can never receive an attachment it would quietly discard. */
  audio?: AudioRef[];
}

/**
 * What a backend can do. The panel degrades gracefully on the flags it can't honor
 * (e.g. hide the conversation-rollback scope when `forkAtAnchor` is false).
 */
export interface AgentCapabilities {
  /** Push turns into one live session over time (vs. resume-per-turn). */
  persistentChannel: boolean;
  /** Emits incremental assistant/thinking deltas (not just final messages). */
  streamingDeltas: boolean;
  /** Can stop a turn in-flight without ending the session. */
  interruptMidTurn: boolean;
  /** Can fork/resume the conversation at a specific turn anchor (rollback). */
  forkAtAnchor: boolean;
  /** Hosts in-process tools (Claude `createSdkMcpServer`) vs. config MCP servers. */
  inProcessMcp: boolean;
  /** Can enumerate the account's available models. */
  modelEnumeration: boolean;
  /** Surfaces provider slash commands. */
  slashCommands: boolean;
  /** Supports lifecycle hooks. */
  hooks: boolean;
  /** Accepts inline image input in a user turn (vision). When false, image refs
   *  the panel sends are ignored by the backend (text-only). */
  vision: boolean;
  /**
   * This backend has an audio content part IMPLEMENTED for its wire protocol
   * (#790). It is a statement about OUR code, not about any model: whether the
   * selected model can actually hear is established per-turn by the backend
   * (Ollama `/api/show` capabilities; the ACP `audio` prompt capability), and a
   * model that cannot gets an explicit refusal naming what would work.
   *
   * false is the honest default for an adapter with no audio part at all —
   * PanelAgent then refuses the attachment centrally and tells the user AND the
   * model, rather than letting the bytes vanish into a text-only turn.
   *
   * Optional so an out-of-tree backend that omits it is treated as audio-less,
   * which is the only safe reading: the failure mode of a wrong `true` is a
   * silently unheard attachment.
   */
  audio?: boolean;
  /**
   * Stamps the #728 TURN MARKER (`AgentEvent.turn`) on the events it emits for a
   * submitted turn. DECLARED, never inferred: #468's run-completion ack requires
   * knowing up front whether an UNMARKED `result` could be a straggler from an
   * abandoned turn. Inferring it from "have I seen a marker yet" is unsound while
   * still unlearned — a zero-output turn's traceless terminal arrives before the
   * replacement turn stamps anything, and would falsely ack (and destroy the
   * replay of) a completion the replacement turn is carrying.
   *
   * true  → an unmarked result never acks a completion; the carrying turn's own
   *         marked result does (an unmarked one hands the tokens back instead).
   * false → a legacy/third-party backend that never stamps; unmarked results ack,
   *         the pre-#468 behavior.
   *
   * Optional so an out-of-tree backend that omits it is treated as non-stamping,
   * which is the conservative reading for something that also never dead-letters.
   */
  turnMarkers?: boolean;
}

/**
 * Canonical event stream. Every adapter normalizes its provider's native messages
 * (Claude `SDKMessage`, Codex app-server notifications) onto these so the
 * orchestration layer is provider-agnostic.
 *
 * NOTE: this is a superset of the minimal design sketch — it carries the extra
 * fields PanelAgent needs to drive the panel UI losslessly (the streamed-message
 * id for delta/commit reconciliation, per-response usage for the live context
 * meter, the result subtype/contextWindow/cost, live thinking-token counts). A
 * non-Claude backend simply omits the optional fields it can't supply.
 */
export type AgentEvent = (
  /** Session opened/continued; `model` is the SDK-reported active model, if any. */
  | { type: "session"; sessionId: string; model?: string }
  /** Incremental assistant/thinking text (token-by-token streaming). */
  | { type: "assistant_delta"; text: string; thinking?: boolean }
  /** A streamed message began; `id` groups its deltas + the final commit. */
  | { type: "stream_start"; id: string | null }
  /** The streamed message finished (close the live preview bubble). */
  | { type: "stream_end" }
  /** Live extended-thinking token count, for a "thinking… (N)" indicator. */
  | { type: "thinking"; tokens: number }
  /** A turn-ending assistant message; `uuid` (when present) is the rewind anchor.
   *  `id` matches the streamed preview; `usage` is that response's prompt usage. */
  | { type: "assistant"; text: string; uuid?: string; id?: string; usage?: Record<string, number> }
  | { type: "tool_call"; name: string; phase: "start" | "end"; detail?: unknown }
  /** A turn completed. `contextWindow`/`costUsd`/`subtype` are provider extras. */
  | {
      type: "result";
      ok: boolean;
      usage?: unknown;
      subtype?: string;
      contextWindow?: number;
      costUsd?: number;
    }
  | { type: "rate_limit"; resetsAt?: number; kind?: string }
  | {
      type: "error";
      message: string;
      /** The error is a "completed but UNVERIFIED" disclosure (#886): a result
       *  arrived for a turn whose record was lost at a session restart. The
       *  turn may have completed real work — it is NOT a failure and NOT a
       *  verified success, so renderers must not frame it as either (no "turn
       *  failed", no "nothing was lost — try again"). */
      unverifiedCompletion?: boolean;
      /** The error is about the SESSION, not about a turn (#1524): it is emitted
       *  at session start — before any turn exists — so the turn framing every
       *  other error gets ("the <model> turn failed … try again") would name a
       *  turn that never ran and offer a retry that changes nothing. It must be
       *  rendered as its own self-contained line, and must NOT consume the
       *  once-per-turn error slot, or a session notice would silence the first
       *  REAL turn error that follows it. */
      sessionNotice?: boolean;
    }
) & {
  /** Backend-minted TURN MARKER (#728): a monotonically increasing id (1 = the
   *  first turn read from the channel in this run) the backend stamps on every
   *  event it emits FOR a submitted turn, so PanelAgent can attribute stragglers:
   *  an event stamped with a turn OLDER than the in-flight turn is dead-lettered
   *  (logged, never painted, never gate-affecting) instead of corrupting the turn
   *  that replaced an abandoned one. OMITTED = legacy/third-party backend (or an
   *  event outside any turn, like session init) — NO dead-lettering, previous
   *  behavior (better a rare duplicate than a wedge). */
  turn?: number;
};

/** Stamp every event of a per-turn stream with the backend-minted `turn` marker
 *  (see AgentEvent.turn). Backends mint one incrementing marker per turn read
 *  from the channel and wrap their per-turn generator: events inside a turn are
 *  stamped; a `session` event (outside any turn) passes through unstamped. */
export async function* stampTurn(
  stream: AsyncIterable<AgentEvent>,
  turn: number,
): AsyncGenerator<AgentEvent> {
  for await (const ev of stream) {
    yield ev.type === "session" ? ev : { ...ev, turn };
  }
}

export interface ModelChoice {
  id: string;
  label?: string;
  /**
   * Whether this model exposes a reasoning-effort control. The panel's
   * `normalizeModels` reads this (and/or `supportedEffortLevels`): if NEITHER is
   * present it treats the model as having no effort control and hides the picker.
   * Mirrors the Agent SDK `ModelInfo.supportsEffort` shape.
   */
  supportsEffort?: boolean;
  /**
   * The reasoning-effort levels this model accepts (provider-specific scale). The
   * panel uses these to populate the effort dropdown. Mirrors the Agent SDK
   * `ModelInfo.supportedEffortLevels` shape (kept as a plain `string[]` so the
   * Codex scale — none|minimal|…|xhigh — fits, not just the Claude scale).
   */
  supportedEffortLevels?: string[];
}

export interface BackendStartOptions {
  /** Resume an existing session/thread by id. */
  resume?: string;
  /** Fork the conversation at this anchor — honored only if `forkAtAnchor`. */
  rewindAnchor?: string | null;
  /** Model id (provider-specific). */
  model?: string;
  /** Working directory for the agent. */
  cwd?: string;
  /**
   * The current captured session id (Claude forks from `sessionId ?? resume`).
   * PanelAgent tracks this across restarts; the backend reads it when forking.
   */
  sessionId?: string | null;
  /** Reasoning effort for the session (provider-specific; ignored if unsupported). */
  effort?: string;
  /**
   * The provider-neutral "channel in": an async iterable of user turns. The
   * backend shapes each into its native user message and pushes it into the live
   * session. PanelAgent gates this so exactly one batch is released per turn.
   */
  channel: AsyncIterable<NeutralTurn>;
  /**
   * LIVENESS signal — fired by the backend on ANY sign the provider is alive for
   * the active turn, even when that signal is NOT translated into an AgentEvent.
   * PanelAgent wires this to its per-turn idle watchdog so a healthy-but-quiet
   * turn (e.g. a Codex MCP tool call running a multi-minute ComfyUI generation
   * that emits only raw app-server notifications, never AgentEvents) keeps the
   * watchdog armed and does NOT falsely trip. The backend should call it on every
   * raw notification (Codex app-server) / every SDKMessage (Claude) — cheap and
   * idempotent. A TRUE freeze (the provider emits nothing at all) never fires it,
   * so the watchdog still catches a real zero-event hang. Optional.
   */
  onActivity?: () => void;
}

export interface SendMeta {
  images?: ImageRef[];
  /** Audio attachments for this turn (#790). */
  audio?: AudioRef[];
  title?: string;
  mid?: string;
}

/**
 * The injection point. `ClaudeBackend` wraps the Agent SDK; `CodexBackend` will
 * wrap the `codex app-server` JSON-RPC protocol.
 */
export interface AgentBackend {
  readonly id: BackendId;
  readonly capabilities: AgentCapabilities;
  /** One-time preflight (e.g. lazy-load the SDK / warm a connection), run OUTSIDE
   *  the self-restart loop so a hard startup failure surfaces immediately rather
   *  than being retried as a dropped session. Idempotent; optional. */
  prepare?(): Promise<void>;
  /** Open/continue a session; the returned iterable yields canonical events. The
   *  user "channel in" is supplied via `opts.channel` (PanelAgent owns the queue
   *  and turn-gate), so the provider-specific message shaping lives in the backend. */
  run(opts: BackendStartOptions): AsyncIterable<AgentEvent>;
  /** Stop the current turn without ending the session (if supported). */
  interrupt(): Promise<void>;
  /**
   * Try to recover a watchdog-stalled turn without representing the interruption
   * as a user cancellation. Returns true only when the provider accepted the
   * supplied agent-facing notice; callers must retain their normal interrupt
   * fallback for older providers/protocols.
   */
  recoverStalledTurn?(notice: string): Promise<boolean>;
  /** Switch the model on the LIVE session (next turn uses it), if supported. */
  setModel?(model: string): Promise<void>;
  /** Models the current account can use (empty if `modelEnumeration` is false). */
  listModels(): Promise<ModelChoice[]>;
  /**
   * #1516 — fetched BYTES of AUTOMATIC run-completion previews this backend has
   * actually delivered into the CURRENT provider conversation (ImageRefs flagged
   * `automatic`; a user's explicit attachments are never counted). PanelAgent
   * reads this when composing an injection so the cumulative per-conversation
   * byte budget (preview-budget.ts) is enforced against real fetch sizes, not a
   * count-times-constant guess. Optional: a backend that does not report bytes
   * is bounded by the image COUNT alone. Reset by the backend whenever the
   * underlying provider conversation changes (a fresh thread starts at zero).
   */
  automaticPreviewBytes?(): number;
  /** Permanently dispose of the backend's resources: kill any child process tree,
   *  remove listeners, drop the live connection. Called by PanelAgent.stop() and on
   *  every path that retires/replaces an agent (reset, effort restart, stopAll).
   *  MUST be idempotent and safe to call when never started. Optional — a backend
   *  with nothing to tear down can omit it (interrupt() alone is not enough: a
   *  backend that owns a child process orphans it if only interrupt() runs). */
  close?(): Promise<void>;
}

/** Capability descriptor for the Claude Agent SDK backend. */
export const CLAUDE_CAPABILITIES: AgentCapabilities = {
  persistentChannel: true,
  streamingDeltas: true,
  interruptMidTurn: true,
  forkAtAnchor: true,
  inProcessMcp: true,
  modelEnumeration: true,
  slashCommands: true,
  hooks: true,
  vision: true, // resolves image refs to inline base64 blocks (shapeTurn)
  audio: false, // the Anthropic Messages API has no audio input block (#790)
  turnMarkers: true, // claude-backend stamps every event from the #745 per-turn trace FIFO
};

/** Capability descriptor for the Codex app-server backend (Phase 2). */
export const CODEX_CAPABILITIES: AgentCapabilities = {
  persistentChannel: true, // thread + turn/start (resume by threadId)
  streamingDeltas: true,
  interruptMidTurn: true, // turn/interrupt
  forkAtAnchor: false, // thread/resume is whole-thread only (for now)
  inProcessMcp: false, // config-declared MCP servers only
  modelEnumeration: true, // config/read
  slashCommands: false,
  hooks: false,
  vision: true, // gpt-5.5 sees images; delivered as `localImage` turn input items
  audio: false, // codex app-server turn input accepts text + localImage only (#790)
  turnMarkers: true, // stampTurn() wraps each per-turn stream
};

/** Capability descriptor for the Gemini CLI ACP backend (Agent Client Protocol).
 *  Mirrors the Codex posture: a persistent session over a JSON-RPC-over-stdio
 *  client, streaming deltas + tool calls, interrupt via `session/cancel`, and
 *  config-declared MCP servers (no in-process SDK MCP). forkAtAnchor is false —
 *  ACP `session/load` is whole-session only, with no per-turn rewind anchor. */
export const GEMINI_CAPABILITIES: AgentCapabilities = {
  persistentChannel: true, // session/new + repeated session/prompt
  streamingDeltas: true, // session/update agent_message_chunk / agent_thought_chunk
  interruptMidTurn: true, // session/cancel
  forkAtAnchor: false, // session/load is whole-session only (no anchor fork)
  inProcessMcp: false, // ACP session/new declares config MCP servers only
  modelEnumeration: true, // static catalog (gemini-2.5-pro / -flash) — ACP exposes no catalog
  slashCommands: false,
  hooks: false,
  vision: true, // gemini-2.5 sees images; delivered as inline base64 image ContentBlocks
  // ACP defines an `audio` ContentBlock and requires the agent to advertise the
  // `audio` prompt capability before a client may send one. Neither CLI has been
  // observed advertising it, so the send path could never be exercised — and its
  // failure mode (session/prompt rejecting after the bytes were attached) would
  // surface as a generic error, i.e. an attachment the user is never told did not
  // arrive. Shipping that is the overclaim #790 exists to remove, so this is false
  // and the attachment is refused centrally, naming a path that works.
  audio: false,
  turnMarkers: true, // stampTurn() wraps each per-turn stream
};

/** Capability descriptor for the Antigravity CLI backend (`agy`, issue #262) —
 *  Google's official replacement for the individual-tier Gemini CLI subscription
 *  path (Google AI Pro/Ultra). `agy` exposes no machine-readable event protocol,
 *  only plain-text `-p` print mode + `--continue` conversation continuity — so
 *  this is a spawn-per-turn adapter with honestly reduced capabilities:
 *  streamingDeltas=true is the CLI's own progressive stdout (final answer text
 *  only, no structured tool events), and vision=false (no documented -p image
 *  input). Models come LIVE from `agy models` (no static catalog). */
export const ANTIGRAVITY_CAPABILITIES: AgentCapabilities = {
  persistentChannel: true, // spawn-per-turn, continuity via `agy --continue`
  streamingDeltas: true, // progressive stdout of the final answer
  interruptMidTurn: true, // kill the in-flight child tree; next turn continues
  forkAtAnchor: false, // agy owns conversation storage; no per-turn anchor
  inProcessMcp: false, // workspace .agents/mcp_config.json only
  modelEnumeration: true, // `agy models` (live account catalog)
  slashCommands: false,
  hooks: false,
  vision: false, // no documented image input in -p mode
  audio: false, // `agy -p` has no documented media input at all (#790)
  turnMarkers: true, // stampTurn() wraps each per-turn stream
};

/** Capability descriptor for the pi.dev CLI backend (`pi`, issue #491) — the
 *  open-source multi-provider coding agent from earendil-works. Unlike agy, pi
 *  exposes a DOCUMENTED machine-readable JSON-lines event stream (`--mode json`)
 *  with real text deltas, per-tool events, and a resumable session id — so this
 *  is a spawn-per-turn adapter that parses that stream. inProcessMcp is false and
 *  there is NO config-MCP path either: pi has no MCP client at all (its tools are
 *  built-ins + TS extensions), so a pi turn does NOT get the ComfyUI panel_* /
 *  comfyui tools — a real limitation surfaced in the ready banner. vision=false
 *  (no documented headless image input). Models come from `pi --list-models`. */
export const PI_CAPABILITIES: AgentCapabilities = {
  persistentChannel: true, // spawn-per-turn, continuity via `pi --session <id>`
  streamingDeltas: true, // `--mode json` text_delta events
  interruptMidTurn: true, // kill the in-flight child tree; next turn continues
  forkAtAnchor: false, // whole-session resume only (no per-turn anchor wired)
  inProcessMcp: false, // pi has no MCP client at all (built-in tools + extensions)
  modelEnumeration: true, // `pi --list-models`
  slashCommands: false,
  hooks: false,
  vision: false, // no documented headless image input
  audio: false, // pi's JSON mode has no documented media input (#790)
  turnMarkers: true, // stampTurn() wraps each per-turn stream
};

/** Capability descriptor for the Grok CLI ACP backend (xAI / Grok Build).
 *  Same ACP posture as Gemini: persistent session, streaming deltas, interrupt,
 *  config-declared MCP servers, static model catalog at spawn. */
export const GROK_CAPABILITIES: AgentCapabilities = {
  persistentChannel: true,
  streamingDeltas: true,
  interruptMidTurn: true,
  forkAtAnchor: false,
  inProcessMcp: false,
  modelEnumeration: true, // grok-composer-2.5-fast / grok-build — ACP exposes no catalog
  slashCommands: false,
  hooks: false,
  vision: true,
  // ACP defines an `audio` ContentBlock and requires the agent to advertise the
  // `audio` prompt capability before a client may send one. Neither CLI has been
  // observed advertising it, so the send path could never be exercised — and its
  // failure mode (session/prompt rejecting after the bytes were attached) would
  // surface as a generic error, i.e. an attachment the user is never told did not
  // arrive. Shipping that is the overclaim #790 exists to remove, so this is false
  // and the attachment is refused centrally, naming a path that works.
  audio: false,
  turnMarkers: true, // stampTurn() wraps each per-turn stream
};

/** Capability descriptor for the Ollama local-LLM backend (issue #97's panel
 *  phase). Ollama is a stateless HTTP daemon, so the backend owns the whole
 *  agentic loop itself (stream /api/chat, dispatch tool calls, repeat) and
 *  keeps the conversation history in-memory — persistentChannel is true from
 *  the panel's perspective, but forkAtAnchor is out. Vision is true at the
 *  BACKEND level: whether images are actually understood is a per-MODEL
 *  property (gemma4 sees them, qwen3 doesn't; DeepSeek's API rejects them), so
 *  the backend always attempts delivery and degrades gracefully — an endpoint
 *  that rejects image input gets one retry with images stripped and an honest
 *  note to both the user and the model. */
export const OLLAMA_CAPABILITIES: AgentCapabilities = {
  persistentChannel: true, // in-memory history + repeated /api/chat
  streamingDeltas: true, // NDJSON chunk stream
  interruptMidTurn: true, // AbortController on the in-flight fetch
  forkAtAnchor: false,
  inProcessMcp: false, // MCP clients internally; the model sees the 6-tool router
  modelEnumeration: true, // GET /api/tags (locally pulled models)
  slashCommands: false,
  hooks: false,
  vision: true, // attempted for every model; graceful strip-and-retry on rejection
  audio: true, // native /api/chat images[] and openai input_audio, both live-verified; per-model gate via /api/show (#790)
  turnMarkers: true, // stampTurn() wraps each per-turn stream
};

/** ChatGPT subscription via direct Codex OAuth (~/.codex/auth.json) — Codex Responses
 *  HTTP backend (not the codex app-server CLI). Same 6-tool router as Ollama. */
export const CHATGPT_CAPABILITIES: AgentCapabilities = {
  persistentChannel: true,
  streamingDeltas: true,
  interruptMidTurn: true,
  forkAtAnchor: false,
  inProcessMcp: false,
  modelEnumeration: true, // ~/.codex/models_cache.json + configured default
  slashCommands: false,
  hooks: false,
  vision: true, // Responses input_image data URLs; strip-and-retry on rejection (#218)
  audio: false, // the Codex Responses models take input_text/input_image only (#790)
  turnMarkers: true, // stampTurn() wraps each per-turn stream
};

/** Kimi Code subscription OAuth or KIMI_API_KEY — OpenAI-compatible coding API. */
export const KIMI_CAPABILITIES: AgentCapabilities = {
  ...OLLAMA_CAPABILITIES,
};

// NOTE: glm/moonshot no longer need dedicated *_CAPABILITIES consts — the generic
// api-key factory (services/openai-provider-registry + makeOpenAiKeyBackend in
// orchestrator/index.ts) builds a plain OllamaBackend, which already reports
// OLLAMA_CAPABILITIES (the value the old GLM_CAPABILITIES/MOONSHOT_CAPABILITIES
// spreads carried). Their BackendId union members are retained above.

/** GitHub Copilot chat via in-panel device-code OAuth — EXPERIMENTAL (ToS risk,
 *  see OAUTH_PROVIDERS.copilot). OpenAI-compatible chat/completions + the same
 *  6-tool router as Ollama/GLM/Kimi. The exact contract (endpoints, headers) is
 *  UNVERIFIED offline — see copilot-backend.ts's module doc. */
export const COPILOT_CAPABILITIES: AgentCapabilities = {
  ...OLLAMA_CAPABILITIES,
};
