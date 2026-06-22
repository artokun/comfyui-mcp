# Agent backend injection (Claude / Codex toggle)

**Status:** design + Phase 1 (in progress) · **Branch:** `feat/agent-backend-injection`

## Motivation

The panel orchestrator is hard-wired to the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`) in `src/orchestrator/panel-agent.ts`. We want
the agent backend to be **dependency-injected** so the same panel/orchestrator can
run on a different provider — starting with **OpenAI Codex** — selected by a toggle.

Design goals:

1. **No extra user install.** The backend ships as an **optional npm dependency**
   (exactly like `@anthropic-ai/claude-agent-sdk` today). Codex is `@openai/codex`.
2. **One port, many adapters.** The orchestrator depends on a provider-neutral
   `AgentBackend` interface; each provider is an adapter. Capability flags let the
   panel degrade gracefully when a backend can't do something.
3. **Generalizes.** The same contract is the "OpenAI ↔ Claude DI schema" and the
   path to future backends.

## How each provider is driven ("clink" points)

- **Claude** — `query({ prompt: AsyncIterable<SDKUserMessage>, options })`: a
  persistent streaming session (channel-in), `Query.interrupt()`, `forkSession` +
  `resumeSessionAt`, `supportedModels()`. Subscription auth (claude.ai OAuth, no key).
- **Codex** — the **`codex app-server`** JSON-RPC protocol over stdio (this is how
  our own `openai-codex` plugin drives it — see
  `plugins/openai-codex/.../scripts/lib/app-server.mjs`, `CodexAppServerClient`),
  **not** `codex exec` string-scraping. Methods: `thread/start`, `thread/resume`,
  `turn/start`, **`turn/interrupt`**, streaming notifications (`turn/started`,
  item deltas, `turn/completed`), `config/read`, `account/read`. ChatGPT login auth
  (subscription, no key). `codex exec --json` is the simpler one-shot fallback.

## Capability matrix

| Port capability | Claude Agent SDK | Codex app-server |
|---|---|---|
| `persistentChannel` (push turns over time) | live generator | thread + `turn/start` (resume by threadId) |
| `streamingDeltas` | ✅ `SDKMessage` | ✅ notifications |
| `interruptMidTurn` | ✅ `Query.interrupt()` | ✅ `turn/interrupt` |
| `forkAtAnchor` (rollback a conversation to a turn) | ✅ `forkSession`+`resumeSessionAt` | ⚠️ resume whole thread only → **degrade** |
| `inProcessMcp` | ✅ `createSdkMcpServer` | ❌ config MCP servers → **expose panel tools as a real MCP server** |
| `modelEnumeration` | ✅ `supportedModels()` | ✅ `config/read` |
| `keylessAuth` | ✅ claude.ai OAuth | ✅ ChatGPT login |

Two real adjustments: conversation-rollback is capability-gated off for Codex, and
the panel `panel_*` tools must be reachable as a standalone MCP server (the one
shared refactor) since Codex can't host in-process SDK tools.

## The port (provider-neutral)

```ts
type BackendId = "claude" | "codex";

interface AgentCapabilities {
  persistentChannel: boolean;
  streamingDeltas: boolean;
  interruptMidTurn: boolean;
  forkAtAnchor: boolean;
  inProcessMcp: boolean;
  modelEnumeration: boolean;
  slashCommands: boolean;
  hooks: boolean;
}

// Canonical event stream — every adapter normalizes its provider's messages to this.
type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "assistant_delta"; text: string; thinking?: boolean }
  | { type: "assistant"; text: string; uuid?: string }   // turn-ending assistant msg (anchor)
  | { type: "tool_call"; name: string; phase: "start" | "end"; detail?: unknown }
  | { type: "result"; ok: boolean; usage?: unknown }
  | { type: "rate_limit"; resetsAt?: number; kind?: string }
  | { type: "error"; message: string };

interface BackendStartOptions {
  resume?: string;                 // session/thread id
  rewindAnchor?: string | null;    // only honored when capabilities.forkAtAnchor
  model?: string;
  cwd: string;
  // MCP wiring is provided in a backend-appropriate form by the orchestrator.
}

interface AgentBackend {
  readonly id: BackendId;
  readonly capabilities: AgentCapabilities;
  /** Open/continue a session; the returned iterable yields canonical events. */
  run(opts: BackendStartOptions): AsyncIterable<AgentEvent>;
  /** Push a user turn into the live session (channel-in). */
  send(text: string, meta?: { images?: unknown[]; title?: string }): void;
  interrupt(): Promise<void>;
  listModels(): Promise<Array<{ id: string; label?: string }>>;
}
```

The existing `PanelAgent` keeps the **orchestration** (queue, turn-gate, bridge
push, rewind-anchor tracking, self-restart) and delegates the **provider-specific**
bits (SDK call, option building, message→event normalization, interrupt, models,
session/fork) to an injected `AgentBackend`.

## Phased plan

1. **Seam (zero behavior change).** Add `agent-backend.ts` (port + events +
   capabilities) and wrap today's Claude path as `ClaudeBackend`. Orchestrator
   depends on the port. Build + 577 tests + 9/9 harness stay green.
2. **Codex adapter.** `CodexBackend` over `codex app-server` (`@openai/codex` as an
   optional dep), interrupt via `turn/interrupt`, models via `config/read`,
   conversation-rollback gated off.
3. **Toggle.** `PANEL_AGENT_BACKEND=claude|codex` (env/config) + panel selector;
   capability flags drive panel UI (e.g. hide conversation-rollback for Codex).
4. **Shared MCP refactor.** Expose `panel_*` as a standalone MCP server so non-Claude
   backends can use the live-graph tools.
5. **Generalize.** Document the canonical schema as the provider DI contract.

## Open questions

- Codex mid-thread fork: confirm whether the app-server can resume a thread
  truncated to a turn (would re-enable conversation-rollback for Codex).
- Whether to vendor a minimal app-server client or depend on `@openai/codex`'s.
- Panel-tools MCP server transport (stdio vs loopback HTTP) for the Codex backend.
