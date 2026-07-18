// Agent backend port — the provider-neutral seam that lets the panel orchestrator
// run on different agent providers (Claude Agent SDK today, OpenAI Codex next) via
// dependency injection. See docs/design/agent-backend-injection.md.
//
// PanelAgent keeps the orchestration (queue, turn-gate, bridge push, rewind-anchor
// tracking, self-restart) and delegates the provider-specific bits — opening a
// session, normalizing the provider's message stream to canonical AgentEvents,
// interrupt, model enumeration, session resume/fork — to an injected AgentBackend.

import type { ImageRef } from "./panel-agent.js";

export type BackendId =
  | "claude"
  | "codex"
  | "chatgpt"
  | "gemini"
  | "grok"
  | "glm"
  | "kimi"
  | "moonshot"
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
export type AgentEvent =
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
  | { type: "error"; message: string };

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
  /** Switch the model on the LIVE session (next turn uses it), if supported. */
  setModel?(model: string): Promise<void>;
  /** Models the current account can use (empty if `modelEnumeration` is false). */
  listModels(): Promise<ModelChoice[]>;
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
