// Agent backend port — the provider-neutral seam that lets the panel orchestrator
// run on different agent providers (Claude Agent SDK today, OpenAI Codex next) via
// dependency injection. See docs/design/agent-backend-injection.md.
//
// PanelAgent keeps the orchestration (queue, turn-gate, bridge push, rewind-anchor
// tracking, self-restart) and delegates the provider-specific bits — opening a
// session, normalizing the provider's message stream to canonical AgentEvents,
// interrupt, model enumeration, session resume/fork — to an injected AgentBackend.

import type { ImageRef } from "./panel-agent.js";

export type BackendId = "claude" | "codex";

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
}

/**
 * Canonical event stream. Every adapter normalizes its provider's native messages
 * (Claude `SDKMessage`, Codex app-server notifications) onto these so the
 * orchestration layer is provider-agnostic.
 */
export type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "assistant_delta"; text: string; thinking?: boolean }
  /** A turn-ending assistant message; `uuid` (when present) is the rewind anchor. */
  | { type: "assistant"; text: string; uuid?: string }
  | { type: "tool_call"; name: string; phase: "start" | "end"; detail?: unknown }
  | { type: "result"; ok: boolean; usage?: unknown }
  | { type: "rate_limit"; resetsAt?: number; kind?: string }
  | { type: "error"; message: string };

export interface ModelChoice {
  id: string;
  label?: string;
}

export interface BackendStartOptions {
  /** Resume an existing session/thread by id. */
  resume?: string;
  /** Fork the conversation at this anchor — honored only if `forkAtAnchor`. */
  rewindAnchor?: string | null;
  /** Model id (provider-specific). */
  model?: string;
  /** Working directory for the agent. */
  cwd: string;
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
  /** Open/continue a session; the returned iterable yields canonical events. */
  run(opts: BackendStartOptions): AsyncIterable<AgentEvent>;
  /** Push a user turn into the live session (channel-in). */
  send(text: string, meta?: SendMeta): void;
  /** Stop the current turn without ending the session (if supported). */
  interrupt(): Promise<void>;
  /** Models the current account can use (empty if `modelEnumeration` is false). */
  listModels(): Promise<ModelChoice[]>;
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
};
