// Grok (xAI) backend — the provider-specific adapter behind the AgentBackend
// port, driving the Grok CLI over its **ACP (Agent Client Protocol)** mode
// (`grok agent stdio`), a JSON-RPC 2.0 client over stdio. This is a faithful
// MIRROR of grok-backend.ts: same self-contained line-framed JSON-RPC client,
// same per-turn event-queue bridge, same terminal-result invariant, same
// Windows/POSIX process-tree kill.
//
// PanelAgent keeps all provider-agnostic orchestration (queue, turn-gate, bridge
// push, self-restart) and drives this backend via
// `for await (const ev of backend.run({...}))`. See
// docs/design/agent-backend-injection.md.
//
// PROTOCOL MAPPING (AgentBackend ↔ ACP, per agentclientprotocol.com + the
// Gemini CLI docs/cli/acp-mode.md):
//   - prepare()           = spawn `grok agent` + `initialize` handshake
//   - session             = an ACP SESSION (`session/new` new | `session/load` resume)
//   - run() loop turn     = `session/prompt` (ONE request per neutral channel batch);
//                           the request RESOLVES with a `stopReason` at turn end
//                           (unlike Codex, where turn/start returns immediately
//                           and a separate turn/completed notification ends it).
//                           Images ride inline as base64 `image` ContentBlocks.
//   - assistant_delta     ← `session/update` { update.sessionUpdate:"agent_message_chunk",
//                            content:{type:"text",text} }
//   - assistant_delta(th) ← `session/update` { ...:"agent_thought_chunk", ... } (thinking)
//   - assistant (commit)  ← the accumulated agent_message_chunk text, emitted once
//                            when the session/prompt request resolves (ACP has no
//                            separate "final message" notification — the chunks ARE
//                            the message; the prompt response is the turn boundary)
//   - tool_call(start)    ← `session/update` { ...:"tool_call", toolCallId, title, kind }
//   - tool_call(end)      ← `session/update` { ...:"tool_call_update", status:
//                            "completed"|"failed" }
//   - result              ← the `session/prompt` response { stopReason }
//   - error               ← a failed `session/prompt` / the child dying mid-turn
//   - interrupt()         → `session/cancel` (notification); the in-flight prompt
//                            then resolves with stopReason:"cancelled"
//   - listModels()        ← a static catalog (gemini-2.5-pro / -flash) — ACP exposes
//                            no model enumeration; the model is selected at SPAWN via
//                            the CLI `--model` flag (see resolveBin/spawn below)
//
// AUTH (NO API KEY — the CLI owns auth): Gemini CLI authenticates itself via
// Google OAuth / Code Assist (the user runs `gemini` once to sign in). This
// backend NEVER passes an API key; it just spawns the already-authenticated CLI.
// If the CLI is signed out, `session/new` returns an `auth_required` error — we
// attempt one `authenticate` with the first advertised auth method, then surface
// a clear "run `gemini` and sign in" message (the OAuth browser flow itself is
// owned by the CLI and cannot be completed headlessly).
//
// PARITY with Codex/Claude: the Gemini backend gets the SAME tool surface — the
// headless `comfyui` stdio MCP plus the `panel` HTTP MCP for live-graph panel_*
// tools — declared to `session/new` as ACP McpServers. The panel system prompt
// is prepended to the FIRST turn's prompt (ACP `session/new` has no system /
// instructions field, mirroring the Codex app-server's thread/start).
//
// ASSUMPTIONS we could NOT verify without the live `gemini` CLI (flagged inline,
// see also the PR body): the exact ACP McpServer http variant shape, the
// session/load resume semantics, the auth_required retry, and live model
// switching (we set the model at spawn via --model since ACP exposes no standard
// per-session model setter). Each is the closest faithful mapping to the
// documented ACP spec.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { logger } from "../utils/logger.js";
import { buildAgentSpawnEnv } from "../services/panel-secrets.js";
import {
  type AgentBackend,
  type AgentCapabilities,
  type AgentEvent,
  type BackendStartOptions,
  type ModelChoice,
  type NeutralTurn,
  GROK_CAPABILITIES,
} from "./agent-backend.js";
import type { ImageRef } from "./panel-agent.js";
import {
  resolveGrokOAuth,
  type CodeProviderAuthDeps,
  type GrokOAuthCredentials,
} from "../services/code-provider-auth.js";
import { OAUTH_PROVIDERS, assertAllowedTokenHost, grokTokenFile, redactTokens } from "../services/oauth-flow.js";
import { OllamaBackend } from "./ollama-backend.js";

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Kill an entire process tree, not just the direct child. On the Windows
 * PATH/shell fallback the direct child is a cmd.exe/`.cmd` shim whose grandchild
 * is the real `gemini` node process — killing only the shell leaves the tree
 * alive. Use `taskkill /T /F`. On POSIX, signal the process group (negative pid)
 * so a shell + its child both die, falling back to the single pid. Best-effort +
 * swallows errors: it runs during teardown and must never throw into the host.
 * (Identical to codex-backend's killProcessTree — same spawn posture.)
 */
function killProcessTree(pid: number | undefined): void {
  if (!Number.isFinite(pid)) return;
  const p = pid as number;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(p), "/T", "/F"], { windowsHide: true });
    } catch {
      try {
        process.kill(p);
      } catch {
        // already gone
      }
    }
    return;
  }
  try {
    process.kill(-p, "SIGTERM"); // process group (we spawn detached on POSIX)
  } catch {
    try {
      process.kill(p, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

// ---- minimal JSON-RPC-2.0-over-stdio client for `grok agent` ----
// A self-contained line-framed (newline-delimited) JSON-RPC 2.0 client, modeled
// 1:1 on codex-backend's AppServerClient. The only wire differences from the
// codex app-server client are: (1) we stamp `jsonrpc:"2.0"` on every outbound
// message (ACP is strict JSON-RPC 2.0), and (2) the server→client request set we
// auto-approve is the ACP one (session/request_permission).

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

type NotificationHandler = (msg: RpcMessage) => void;

/** An Error carrying the JSON-RPC error `data` so the auth_required reason
 *  survives the request rejection (used to drive the authenticate retry). */
class RpcError extends Error {
  code?: number;
  data?: unknown;
  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

class AcpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; method: string }
  >();
  private nextId = 1;
  private closed = false;
  private exitResolved = false;
  /** The error that ended the connection (null = clean exit). */
  exitError: Error | null = null;
  stderr = "";
  notificationHandler: NotificationHandler | null = null;
  private resolveExit!: () => void;
  /** Resolves when the `gemini` process exits or errors — runTurn() races its
   *  per-turn drain against this so a child that dies mid-prompt never deadlocks
   *  the turn forever (mirrors codex P0-2). */
  readonly exitPromise: Promise<void>;

  constructor(
    private readonly cmd: string,
    private readonly args: string[],
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly useShell: boolean,
  ) {
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  /** Spawn `grok agent` and perform the ACP `initialize` handshake. Returns the
   *  agent's initialize result (capabilities + authMethods). NOTE: ACP has NO
   *  `initialized` notification (that's MCP, not ACP) — initialize is a plain
   *  request/response, after which we go straight to session/new. */
  async initialize(clientInfo: {
    name: string;
    title: string;
    version: string;
  }): Promise<AcpInitializeResult> {
    this.proc = spawn(this.cmd, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: this.useShell,
      // POSIX: own process group so close() can kill the whole tree with one
      // negative-pid signal. Windows uses taskkill /T instead.
      detached: process.platform !== "win32",
    }) as ChildProcessWithoutNullStreams;

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    // Route pipe errors (EPIPE when the child dies mid-turn) through handleExit so
    // the turn rejects cleanly instead of crashing the host as an uncaught error.
    this.proc.stdin.on("error", (error) => this.handleExit(error));
    this.proc.stdout.on("error", (error) => this.handleExit(error));
    this.proc.on("error", (error) => this.handleExit(error));
    this.proc.on("exit", (code, signal) => {
      const detail =
        code === 0
          ? null
          : new Error(
              `grok agent exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${this.stderr ? ` ${this.stderr.trim().split(/\r?\n/).slice(-2).join(" ")}` : ""}`,
            );
      this.handleExit(detail);
    });

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.handleLine(line));

    // ACP initialize: negotiate protocol version + advertise client capabilities.
    // We do NOT implement the client fs/terminal methods, so advertise them false
    // (the agent then won't issue fs/read_text_file, terminal/*, etc.).
    const result = await this.request<AcpInitializeResult>("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo,
    });
    return result;
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("grok agent client is closed."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown = {}): void {
    if (this.closed) return;
    // Fire-and-forget: a write failure (dead child) must not throw into the caller.
    try {
      this.send({ method, params });
    } catch {
      // connection gone; pending requests already rejected via handleExit
    }
  }

  private send(message: RpcMessage): void {
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      this.handleExit(this.exitError ?? new Error("grok agent stdin is not available."));
      throw this.exitError ?? new Error("grok agent stdin is not available.");
    }
    // ACP is strict JSON-RPC 2.0 — every outbound frame carries `jsonrpc:"2.0"`.
    const framed: RpcMessage = { jsonrpc: "2.0", ...message };
    try {
      stdin.write(`${JSON.stringify(framed)}\n`);
    } catch (err) {
      this.handleExit(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  /**
   * The auto-approve RESULT for a server→client request, or null if it isn't one
   * we should auto-grant. The panel agent is an ISOLATED background agent (same
   * posture as Claude's bypassPermissions / Codex's auto-approve), so we grant
   * tool-permission requests to keep the live-graph work flowing.
   *
   * ACP permission flow: the agent sends `session/request_permission`
   * ({ sessionId, toolCall, options:[{ optionId, name, kind }] }) and expects
   * { outcome: { outcome:"selected", optionId } }. We pick the most-permissive
   * "allow" option (allow_always > allow_once); if none is offered we cancel.
   */
  private autoApproveResult(msg: RpcMessage): Record<string, unknown> | null {
    if (msg.method !== "session/request_permission") return null;
    const params = (msg.params ?? {}) as { options?: Array<{ optionId?: string; kind?: string }> };
    const options = Array.isArray(params.options) ? params.options : [];
    const pick =
      options.find((o) => o.kind === "allow_always") ??
      options.find((o) => o.kind === "allow_once") ??
      // Fall back to any option whose id/kind reads as an allow.
      options.find((o) => /allow/i.test(o.kind ?? "") || /allow/i.test(o.optionId ?? ""));
    if (pick?.optionId) {
      return { outcome: { outcome: "selected", optionId: pick.optionId } };
    }
    // No allow option offered → decline gracefully so the agent moves on.
    return { outcome: { outcome: "cancelled" } };
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch (error) {
      this.handleExit(new Error(`Failed to parse grok agent JSONL: ${msgOf(error)}`));
      return;
    }
    // Server→client request (id + method). Auto-approve permission prompts; reply
    // method-not-found to anything else so the protocol keeps moving (we declared
    // no fs/terminal client capabilities, so those shouldn't arrive).
    if (message.id !== undefined && message.method) {
      const result = this.autoApproveResult(message);
      if (result) {
        logger.debug(`[grok-backend] auto-approving server request ${message.method}`);
        this.send({ id: message.id, result });
      } else {
        logger.debug(
          `[grok-backend] unsupported server request ${message.method} — replying method-not-found`,
        );
        this.send({
          id: message.id,
          error: { code: -32601, message: `Unsupported server request: ${message.method}` },
        });
      }
      return;
    }
    // Response to one of our requests.
    if (message.id !== undefined) {
      const p = this.pending.get(message.id as number);
      if (!p) return;
      this.pending.delete(message.id as number);
      if (message.error) {
        p.reject(
          new RpcError(
            message.error.message ?? `grok agent ${p.method} failed.`,
            message.error.code,
            message.error.data,
          ),
        );
      } else {
        p.resolve(message.result ?? {});
      }
      return;
    }
    // Notification.
    if (message.method) this.notificationHandler?.(message);
  }

  private handleExit(error: Error | null): void {
    if (this.exitResolved) return;
    this.exitResolved = true;
    this.exitError = error;
    for (const p of this.pending.values())
      p.reject(error ?? new Error("grok agent connection closed."));
    this.pending.clear();
    this.resolveExit();
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.exitPromise;
      return;
    }
    this.closed = true;
    this.notificationHandler = null;
    this.rl?.close();
    this.rl = null;
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.proc.stdin.end();
      } catch {
        // already gone
      }
      const proc = this.proc;
      // Give a graceful stdin-EOF shutdown a beat, then KILL THE WHOLE TREE — on
      // the Windows shell fallback the direct child is a shim whose grandchild is
      // the real gemini node process, so proc.kill() alone would orphan it.
      setTimeout(() => {
        if (proc.exitCode === null) killProcessTree(proc.pid);
      }, 50).unref?.();
    }
    await this.exitPromise;
    this.proc = null;
  }
}

// ---- ACP type shapes (the subset we read; best-effort, defensive) ----

interface AcpAuthMethod {
  id?: string;
  name?: string;
  description?: string;
}

interface AcpInitializeResult {
  protocolVersion?: number;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    mcpCapabilities?: { http?: boolean; sse?: boolean };
  };
  authMethods?: AcpAuthMethod[];
  agentInfo?: { name?: string; title?: string; version?: string };
}

// ---- model catalog ----
// ACP exposes no model enumeration, and the model is fixed at SPAWN via the CLI
// `--model` flag — so we surface a static catalog of the current Gemini family.
// Gemini's "thinking" is a token BUDGET, not a discrete effort scale, so we do
// NOT advertise supportsEffort/supportedEffortLevels: the panel's normalizeModels
// then hides the effort dropdown (omission is the documented "no effort control"
// signal). gemini-2.5-pro is the default.
const GROK_MODELS: ModelChoice[] = [
  { id: "grok-composer-2.5-fast", label: "Grok Composer 2.5 Fast" },
  { id: "grok-build", label: "Grok Build" },
];
const GROK_DEFAULT_MODEL = "grok-composer-2.5-fast";

/** Does this id look like a Grok model (vs. the Claude panel model PanelAgent
 *  unconditionally passes as opts.model)? Used so the configured Grok model
 *  wins — mirrors codex-backend's isCodexModel guard (P1-1). */
function isGrokModel(id: string): boolean {
  return /^grok[-/]/i.test(id);
}

/** A declared MCP server for the ACP session. Either a stdio command (the headless
 *  comfyui MCP) or a streamable-HTTP url (the panel_* loopback server). Identical
 *  shape to codex-backend's CodexMcpServerSpec so the orchestrator can build one
 *  config for both. */
export type GrokMcpServerSpec =
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { transport: "http"; url: string };

/**
 * Convert our MCP server specs into the ACP `session/new` `mcpServers` array.
 * ACP stdio McpServer: { name, command, args, env:[{name,value}] }. Streamable
 * HTTP MCP uses the SSE variant ({ type:"sse", name, url, headers:[] }) — the
 * live Grok/Gemini CLIs reject { type:"http" } with Invalid params.
 */
export function buildAcpMcpServers(
  servers: Record<string, GrokMcpServerSpec>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const [name, spec] of Object.entries(servers)) {
    if (spec.transport === "stdio") {
      out.push({
        name,
        command: spec.command,
        args: spec.args ?? [],
        env: Object.entries(spec.env ?? {}).map(([k, v]) => ({ name: k, value: v })),
      });
    } else {
      out.push({ type: "sse", name, url: spec.url, headers: [] });
    }
  }
  return out;
}

/** Provider config the Gemini backend needs. Mirrors CodexBackendDeps. */
export interface GrokBackendDeps {
  /** Working directory for the ACP session (defaults to opts.cwd / process cwd). */
  cwd?: string;
  /** Default model for new sessions (e.g. gemini-2.5-pro); set at SPAWN via --model. */
  model?: string;
  /**
   * Base URL of the ComfyUI instance, for fetching image bytes (/view). When set,
   * NeutralTurn image refs are fetched and delivered inline as base64 `image`
   * ContentBlocks on the prompt (vision parity with the Claude path).
   */
  comfyuiUrl?: string;
  /**
   * MCP servers to declare to the ACP `session/new` — the headless `comfyui`
   * stdio MCP + the `panel` HTTP MCP for live-graph tools (full tool parity).
   */
  mcpServers?: Record<string, GrokMcpServerSpec>;
  /**
   * Panel system prompt (persona). ACP `session/new` has no instructions field,
   * so this is PREPENDED to the first turn's prompt as a clearly-marked
   * system/context preamble; later turns send plain text.
   */
  systemAppend?: string;
  /**
   * Test seam: override how the direct-token OAuth credentials are resolved
   * (defaults to `resolveGrokOAuth` from code-provider-auth.ts). Threaded through
   * to the internal `GrokDirectBackend` too, so the mode-decision probe and the
   * live token refresh both go through the same injected resolver.
   */
  resolveGrokOAuth?: (deps?: CodeProviderAuthDeps) => Promise<GrokOAuthCredentials>;
}

/**
 * The Gemini CLI ACP adapter. One instance per PanelAgent; it holds the live ACP
 * client + current session id and re-opens on each `run()`.
 *
 * DIRECT-TOKEN SELECTION (Task 6): this class is also the public facade used
 * everywhere (`new GrokBackend(deps)`, wired in orchestrator/index.ts). On the
 * FIRST call to any AgentBackend method it decides — once, cached for the life of
 * this instance — whether `~/.grok/auth.json` holds a usable OAuth token
 * (`resolveGrokOAuth`, mirroring `resolveOpenAICodexOAuth`'s resolve+refresh). If
 * so, EVERY call delegates to an internal `GrokDirectBackend` (a Responses-style
 * HTTP adapter hitting `https://api.x.ai/v1`, reusing the same 6-tool router as
 * Ollama/ChatGPT — see below). If the token file is absent, unreadable, or its
 * refresh fails, the decision is "no" and this class's OWN ACP/CLI body below
 * runs exactly as before — NO behavior change on that path. The Grok CLI thus
 * becomes optional: only needed when no in-panel OAuth sign-in has happened.
 */
export class GrokBackend implements AgentBackend {
  readonly id = "grok" as const;
  private deps: GrokBackendDeps;
  /** Memoized mode decision: resolves to a live GrokDirectBackend when a usable
   *  OAuth token was found, or `null` to mean "use this class's own ACP body".
   *  Decided at most once per instance (see the class doc above). */
  private modePromise: Promise<GrokDirectBackend | null> | null = null;
  /** Synchronous mirror of the resolved mode for the `capabilities` getter:
   *  `undefined` = not yet decided, a backend = direct mode, `null` = ACP mode.
   *  Set by resolveMode() the instant its probe settles. */
  private resolvedDirect: GrokDirectBackend | null | undefined = undefined;
  private client: AcpClient | null = null;
  /** The client an in-flight prepare() is spinning up, tracked so a concurrent
   *  close() can tear it down before it's published (P0-A). */
  private preparingClient: AcpClient | null = null;
  /** Set once close() runs — a tripwire so an in-flight prepare() disposes its
   *  local client instead of publishing it (P0-A). */
  private disposed = false;
  /** Cached resolved spawn command/args/shell (set in prepare()). */
  private spawnSpec: { cmd: string; args: string[]; useShell: boolean } | null = null;
  /** The live ACP session id — used for session/prompt + session/cancel. */
  private sessionId: string | null = null;
  /** The model requested for new sessions (applied at SPAWN via --model). */
  private model: string | undefined;
  /** The model the LIVE `grok agent` child was actually spawned with. Gemini
   *  pins the model at spawn, so when this drifts from `this.model` (a live
   *  setModel) the run loop respawns the CLI before the next turn (P1). */
  private spawnedModel: string | undefined;
  /** Capabilities the agent advertised at initialize (loadSession / image / http). */
  private agentCaps: AcpInitializeResult["agentCapabilities"] = undefined;
  private authMethods: AcpAuthMethod[] = [];
  /** True until the panel system prompt has been prepended to a turn. Reset
   *  whenever a NEW session starts (run()). */
  private needsSystemPreamble = false;

  constructor(deps: GrokBackendDeps = {}) {
    this.deps = deps;
    this.model = deps.model;
  }

  /**
   * Capabilities MUST reflect the mode that will actually serve turns — never
   * advertise one this backend won't honor (over-reporting `vision` would make a
   * caller send images the direct 6-tool-router path silently drops = data loss).
   * `capabilities` is a synchronous `readonly` on the AgentBackend port, but the
   * mode is resolved lazily/async — so:
   *   - once the mode is KNOWN → report the real descriptor (direct = vision:false,
   *     ACP = the full GROK_CAPABILITIES incl. vision:true).
   *   - while UNKNOWN but the direct path is REACHABLE (a `~/.grok/auth.json`
   *     exists, or a resolveGrokOAuth seam is injected) → report conservatively
   *     with `vision:false`. Under-reporting is safe (the panel just won't offer
   *     images); over-reporting is not.
   *   - while UNKNOWN and the direct path is NOT reachable (no token file) → the
   *     ACP path is the only possibility, so report its full capabilities.
   * The xAI vision contract is unverified (Task 8), so the direct path never
   * claims vision until that's confirmed. */
  get capabilities(): AgentCapabilities {
    if (this.resolvedDirect !== undefined) {
      return this.resolvedDirect ? this.resolvedDirect.capabilities : GROK_CAPABILITIES;
    }
    const directReachable = !!this.deps.resolveGrokOAuth || existsSync(grokTokenFile);
    return directReachable ? { ...GROK_CAPABILITIES, vision: false } : GROK_CAPABILITIES;
  }

  /**
   * Decide ONCE (memoized) whether a direct OAuth token is usable: probes
   * `resolveGrokOAuth` (or the injected test seam) and, on success, builds the
   * `GrokDirectBackend` that every AgentBackend method below will delegate to.
   * On ANY failure (no `~/.grok/auth.json`, unreadable, expired-with-no-refresh,
   * refresh network error, wrong-shape file) it caches `null`, meaning "fall
   * back to this class's own ACP/CLI body" — the probe itself does no spawning
   * and no network call beyond the token endpoint, so a missing/foreign
   * `~/.grok/auth.json` (e.g. the Grok CLI's OWN native login, a different JSON
   * shape) is indistinguishable from "not signed in" and correctly falls back.
   */
  private resolveMode(): Promise<GrokDirectBackend | null> {
    if (!this.modePromise) {
      const resolveOAuth = this.deps.resolveGrokOAuth ?? resolveGrokOAuth;
      this.modePromise = resolveOAuth()
        .then((creds) => {
          // Thread the ALREADY-resolved credentials into the direct backend so its
          // prepare() reuses them instead of probing resolveGrokOAuth a second time
          // (single-probe on the success path — the task's explicit requirement).
          const direct = new GrokDirectBackend({
            cwd: this.deps.cwd,
            model: this.deps.model,
            comfyuiUrl: this.deps.comfyuiUrl,
            mcpServers: this.deps.mcpServers,
            systemAppend: this.deps.systemAppend,
            resolveGrokOAuth: this.deps.resolveGrokOAuth,
            initialCredentials: creds,
          });
          this.resolvedDirect = direct;
          return direct;
        })
        .catch(() => {
          this.resolvedDirect = null;
          return null;
        });
    }
    return this.modePromise;
  }

  /**
   * Resolve how to spawn `grok agent --always-approve stdio`. The Grok CLI must
   * be on PATH (installed via Grok Build / xAI). The `--model` flag pins the
   * model at spawn (ACP has no standard per-session model setter). On Windows,
   * `grok` may resolve to a `.cmd` shim — spawn with a shell when needed.
   */
  private resolveSpawn(): { cmd: string; args: string[]; useShell: boolean } {
    if (this.spawnSpec) return this.spawnSpec;
    const modelArgs = this.model ? ["--model", this.model] : [];
    const cmd = "grok";
    const args = ["agent", ...modelArgs, "--always-approve", "stdio"];
    const useShell = process.platform === "win32";
    this.spawnSpec = { cmd, args, useShell };
    return this.spawnSpec;
  }

  /**
   * Fetch a ComfyUI image (/view) and return it as an ACP base64 `image`
   * ContentBlock ({ type:"image", mimeType, data }) — or null on any failure (the
   * text reference still names the image as a fallback). Unlike Codex (which
   * spills to a temp file for its path-based localImage item), ACP takes inline
   * base64, so this mirrors ClaudeBackend.fetchImageBlock exactly (only the key
   * names differ: ACP uses `mimeType`/`data`).
   */
  private async fetchImageBlock(ref: ImageRef): Promise<Record<string, unknown> | null> {
    if (!this.deps.comfyuiUrl || !ref?.filename) return null;
    try {
      const u = new URL("/view", this.deps.comfyuiUrl);
      u.searchParams.set("filename", ref.filename);
      u.searchParams.set("type", ref.type || "input");
      if (ref.subfolder) u.searchParams.set("subfolder", ref.subfolder);
      const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      let mt = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mt)) {
        mt = "image/png"; // ComfyUI outputs are PNG by default
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 12 * 1024 * 1024) return null; // keep context sane (parity with Claude)
      return { type: "image", mimeType: mt, data: buf.toString("base64") };
    } catch {
      return null;
    }
  }

  /**
   * Preflight: resolve + spawn `grok agent` and perform the ACP `initialize`
   * handshake. Fails fast with a clear reject so a missing binary surfaces
   * immediately instead of being retried as a dropped session. Idempotent —
   * reuses the live client. NOTE: the actual login (Google OAuth) is verified
   * lazily at `session/new` (ACP returns auth_required there) — see run() — since
   * ACP has no pre-session account probe; flagged in the PR body.
   */
  async prepare(): Promise<void> {
    if (this.disposed) throw new Error("grok backend is closed.");
    const direct = await this.resolveMode();
    if (direct) {
      await direct.prepare?.();
      return;
    }
    if (this.client) return;
    const { cmd, args, useShell } = this.resolveSpawn();
    const cwd = this.deps.cwd ?? process.cwd();
    // SECURITY: spawn with the agent env — process.env MINUS tool-only secrets
    // (RunPod/HF/CivitAI… tokens; they belong only to the comfyui tool child).
    const client = new AcpClient(cmd, args, cwd, buildAgentSpawnEnv(), useShell);
    // Publish the in-flight client BEFORE the startup awaits so a concurrent
    // close() can find and kill it (P0-A).
    this.preparingClient = client;
    const abortIfDisposed = async (): Promise<void> => {
      if (!this.disposed) return;
      if (this.preparingClient === client) this.preparingClient = null;
      await client.close().catch(() => {});
      throw new Error("grok backend was closed during prepare().");
    };
    try {
      let init: AcpInitializeResult;
      try {
        init = await client.initialize({
          name: "comfyui-mcp",
          title: "comfyui-mcp panel",
          version: "0.16.0",
        });
      } catch (err) {
        await client.close().catch(() => {});
        throw new Error(
          `Could not start the Grok CLI in ACP mode (grok backend). Install the Grok CLI (Grok Build / xAI) and ensure \`grok\` is on PATH, then sign in with \`grok\`. Details: ${msgOf(err)}`,
        );
      }
      await abortIfDisposed();
      this.agentCaps = init.agentCapabilities;
      this.authMethods = Array.isArray(init.authMethods) ? init.authMethods : [];
      this.client = client;
      // Record what the live child was spawned with so a later setModel can detect
      // the model drifted and respawn (the model is spawn-pinned via --model) (P1).
      this.spawnedModel = this.model;
      logger.info(
        `[grok-backend] ACP ready (protocol ${init.protocolVersion ?? "?"}, agent ${init.agentInfo?.name ?? "grok"}${this.authMethods.length ? `, ${this.authMethods.length} auth method(s)` : ""})`,
      );
    } finally {
      if (this.preparingClient === client) this.preparingClient = null;
    }
  }

  /** Ensure a live ACP session exists, creating (session/new) or resuming
   *  (session/load) one. Handles an `auth_required` error from session/new by
   *  attempting a single `authenticate` with the first advertised method, then
   *  retrying — surfacing a clear sign-in message if it still fails. Returns the
   *  session id. */
  private async ensureSession(client: AcpClient, cwd: string, resumeId: string | null): Promise<string> {
    const mcpServers = this.deps.mcpServers ? buildAcpMcpServers(this.deps.mcpServers) : [];
    const canLoad = this.agentCaps?.loadSession === true;
    // RESUME (session/load) — whole-session only (forkAtAnchor=false). Only if the
    // agent advertised loadSession; otherwise fall through to a fresh session.
    if (resumeId && canLoad) {
      try {
        await client.request("session/load", { sessionId: resumeId, cwd, mcpServers });
        this.sessionId = resumeId;
        this.needsSystemPreamble = false; // persona already delivered on the original first turn
        return resumeId;
      } catch (err) {
        logger.warn(`[grok-backend] session/load failed (${msgOf(err)}) — starting a fresh session`);
      }
    }
    // NEW session, with one auth_required retry.
    const createNew = async (): Promise<string> => {
      const res = await client.request<{ sessionId?: string }>("session/new", { cwd, mcpServers });
      if (!res?.sessionId) throw new Error("grok agent session/new returned no sessionId.");
      return res.sessionId;
    };
    try {
      this.sessionId = await createNew();
    } catch (err) {
      if (this.isAuthRequired(err) && this.authMethods[0]?.id) {
        // The CLI owns auth (Google OAuth). Try the first advertised method once;
        // if the CLI isn't already signed in this cannot complete headlessly.
        try {
          await client.request("authenticate", { methodId: this.authMethods[0].id });
          this.sessionId = await createNew();
        } catch {
          throw new Error(
            "Grok CLI is not signed in. Run `grok` once and complete the xAI sign-in, then reconnect.",
          );
        }
      } else if (this.isAuthRequired(err)) {
        throw new Error(
          "Grok CLI is not signed in. Run `grok` once and complete the xAI sign-in, then reconnect.",
        );
      } else {
        throw err;
      }
    }
    this.needsSystemPreamble = !!this.deps.systemAppend; // fresh session → persona on first turn
    return this.sessionId!;
  }

  /** Does this error look like an ACP `auth_required`? Reads the JSON-RPC error
   *  data.reason carried by RpcError, falling back to the message text. */
  private isAuthRequired(err: unknown): boolean {
    if (err instanceof RpcError) {
      const data = err.data as { reason?: string } | undefined;
      if (data?.reason === "auth_required") return true;
    }
    return /auth.?required|authenticat|not.*(logged|signed).*in/i.test(msgOf(err));
  }

  /**
   * Open/continue an ACP session and yield canonical AgentEvents. The user
   * channel (PanelAgent's gated queue) is consumed ONE turn at a time: each
   * neutral batch becomes a `session/prompt`, whose streamed session/update
   * notifications are normalized to AgentEvents, and only after the prompt
   * resolves (stopReason) do we read the next batch (the channel async-iteration
   * IS the turn-gate).
   */
  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    const direct = await this.resolveMode();
    if (direct) {
      yield* direct.run(opts);
      return;
    }
    // MODEL PRECEDENCE (P1): apply the panel-selected model BEFORE prepare() so the
    // FIRST spawn uses it (the model is spawn-pinned via `--model`; preparing first
    // would spawn the wrong model). PanelAgent.start() usually passes opts.model =
    // the CLAUDE panel model, which is NOT a valid Gemini model — so the configured
    // Gemini model (deps.model, from COMFYUI_MCP_GEMINI_MODEL) wins; only honor
    // opts.model when it actually looks like a Gemini model (e.g. the user picked
    // one in the panel, which arrives as opts.model on a fresh spawn).
    if (opts.model && isGrokModel(opts.model)) this.model = opts.model;

    await this.prepare();
    if (!this.client) throw new Error("grok agent not initialized");
    const cwd = opts.cwd ?? this.deps.cwd ?? process.cwd();

    // forkAtAnchor is false → ignore opts.rewindAnchor; whole-session resume only.
    const resumeId = opts.resume ?? opts.sessionId ?? null;
    let sessionId = await this.ensureSession(this.client, cwd, resumeId);

    // The session id is our session id (PanelAgent persists it for resume).
    yield {
      type: "session",
      sessionId,
      ...(this.model ? { model: this.model } : {}),
    };

    // Process the neutral channel one turn at a time.
    for await (const turn of opts.channel) {
      // LIVE MODEL SWITCH (P1): PanelAgent treats setModel as live and does NOT
      // restart run() for a model-only change, so the persistent loop adopts it
      // here. The model is spawn-pinned, so a switch means respawning the CLI with
      // the new --model — which necessarily starts a FRESH session (a model swap
      // can't carry the old session forward). Done transparently before the turn;
      // we emit a new `session` event so PanelAgent persists the new id.
      if (this.spawnedModel !== this.model) {
        await this.respawnForModelChange();
        if (!this.client) throw new Error("grok agent respawn failed");
        sessionId = await this.ensureSession(this.client, cwd, null);
        yield {
          type: "session",
          sessionId,
          ...(this.model ? { model: this.model } : {}),
        };
      }
      yield* this.runTurn(this.client, turn, opts.onActivity);
    }
  }

  /** Tear down the live `grok agent` child (process-tree kill) and re-spawn it
   *  with the current `this.model`'s `--model` flag, so a live setModel takes
   *  effect. The model is spawn-pinned, so this is the only way to switch it. The
   *  caller then opens a fresh session on the new child. */
  private async respawnForModelChange(): Promise<void> {
    const old = this.client;
    this.client = null;
    this.sessionId = null;
    if (old) {
      old.notificationHandler = null;
      await old.close().catch(() => {});
    }
    this.spawnSpec = null; // force resolveSpawn to rebuild argv with the new --model
    logger.info(`[grok-backend] model switch → respawning grok agent with --model ${this.model ?? "(default)"}`);
    await this.prepare(); // spawns with this.model; records spawnedModel
  }

  /** Run ONE turn: send session/prompt + stream its session/update notifications →
   *  AgentEvents, resolving when the prompt request returns a stopReason, OR when
   *  the child exits mid-turn (never deadlock). ACP's prompt request IS the turn
   *  boundary, so — unlike Codex — there is no separate completion notification and
   *  no turn-id buffering: the sessionId is known before the prompt is sent. */
  private async *runTurn(
    client: AcpClient,
    turn: NeutralTurn,
    onActivity?: () => void,
  ): AsyncGenerator<AgentEvent> {
    const sessionId = this.sessionId!;
    // Event queue bridging the push-based notification handler to this pull-based
    // async generator (identical pattern to codex-backend).
    const queue: AgentEvent[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    const push = (ev: AgentEvent) => {
      queue.push(ev);
      wake?.();
      wake = null;
    };
    const finish = () => {
      done = true;
      wake?.();
      wake = null;
    };

    // Accumulate the assistant reply text across agent_message_chunk so we can emit
    // ONE authoritative `assistant` commit when the turn ends (ACP has no separate
    // final-message notification). messageId (when present) groups the deltas + the
    // commit under one bubble id, mirroring the Claude/Codex stream reconciliation.
    let assistantText = "";
    let messageId: string | null = null;

    // Stream bubble state (reasoning vs reply each open/close their own stream).
    let streamOpen = false;
    let streamKind: "text" | "thinking" | null = null;
    const openStream = (id: string | null, kind: "text" | "thinking") => {
      if (streamOpen && streamKind === kind) return;
      if (streamOpen) push({ type: "stream_end" }); // switch kinds → close the old one
      streamOpen = true;
      streamKind = kind;
      push({ type: "stream_start", id });
    };
    const closeStream = () => {
      if (streamOpen) {
        push({ type: "stream_end" });
        streamOpen = false;
        streamKind = null;
      }
    };

    // EXACTLY ONE terminal `result` (PanelAgent's turn-gate only advances on a
    // result; a missing one parks the channel forever). This idempotent helper
    // emits an `error` + `{result, ok:false}` and finishes; no-op once a result
    // has fired (so the prompt rejection AND the exit watcher can both call it).
    let finishedResult = false;
    const emitTerminalError = (message: string) => {
      if (finishedResult) return;
      finishedResult = true;
      closeStream();
      push({ type: "error", message });
      push({ type: "result", ok: false, subtype: "error" });
      finish();
    };

    let interrupted = false;

    // tool_call carries the title/kind; tool_call_update (ACP) repeats only the
    // toolCallId — so remember each call's display name to label its end event.
    const toolNames = new Map<string, string>();

    // Normalize ONE session/update notification into canonical AgentEvents.
    const apply = (msg: RpcMessage) => {
      if (finishedResult) return;
      const params = (msg.params ?? {}) as Record<string, unknown>;
      // Only our session's updates.
      if (params.sessionId && params.sessionId !== sessionId) return;
      const update = (params.update ?? {}) as Record<string, unknown>;
      const kind = update.sessionUpdate as string | undefined;
      switch (kind) {
        case "agent_message_chunk": {
          const content = update.content as { type?: string; text?: string } | undefined;
          const text = content?.type === "text" ? content.text : undefined;
          const id = (update.messageId as string | undefined) ?? null;
          if (typeof text === "string" && text) {
            if (id) messageId = id;
            openStream(messageId, "text");
            assistantText += text;
            push({ type: "assistant_delta", text });
          }
          break;
        }
        case "agent_thought_chunk": {
          // Extended-thinking streaming. Open a reasoning stream on the FIRST delta
          // so PanelAgent (which drops assistant_delta when no stream is open)
          // renders early thinking, mirroring codex P2-1.
          const content = update.content as { type?: string; text?: string } | undefined;
          const text = content?.type === "text" ? content.text : undefined;
          if (typeof text === "string" && text) {
            openStream(messageId, "thinking");
            push({ type: "assistant_delta", text, thinking: true });
          }
          break;
        }
        case "tool_call": {
          // A tool call was requested — emit tool_call(start) for panel visibility.
          const id = update.toolCallId as string | undefined;
          const name =
            (update.title as string | undefined) ||
            (update.kind as string | undefined) ||
            id ||
            "tool";
          if (id) toolNames.set(id, name);
          push({ type: "tool_call", name, phase: "start", detail: update });
          break;
        }
        case "tool_call_update": {
          // Progress + completion of a tool call. Emit tool_call(end) only on a
          // TERMINAL status; intermediate in_progress updates just keep the
          // watchdog armed (onActivity already fired for them). ACP's update
          // repeats only the toolCallId, so reuse the remembered title for the name.
          const status = update.status as string | undefined;
          if (status === "completed" || status === "failed") {
            const id = update.toolCallId as string | undefined;
            const name =
              (update.title as string | undefined) ||
              (id ? toolNames.get(id) : undefined) ||
              (update.kind as string | undefined) ||
              id ||
              "tool";
            push({ type: "tool_call", name, phase: "end", detail: update });
          }
          break;
        }
        // plan / available_commands_update / session_info_update / current_mode_update
        // carry no AgentEvent — onActivity (below) already re-armed the watchdog.
        default:
          break;
      }
    };

    const prev = client.notificationHandler;
    client.notificationHandler = (msg: RpcMessage) => {
      // LIVENESS: ANY notification while this turn is in flight means the agent is
      // alive — fire onActivity BEFORE filtering/translating so even updates that
      // produce no AgentEvent (a long MCP tool call mid-generation) keep
      // PanelAgent's idle watchdog armed. A genuine zero-event freeze never
      // reaches here, so the real freeze-catch is preserved.
      try {
        onActivity?.();
      } catch {
        // a watchdog bump must never break the protocol reader
      }
      if (msg.method === "session/update") apply(msg);
      else prev?.(msg); // anything else (other methods) → pass through
    };

    // Watch for the child dying mid-turn: end the turn with a terminal result so
    // the local drain is woken instead of waiting forever. emitTerminalError is a
    // no-op if a result already fired, so it's safe alongside the prompt rejection.
    void client.exitPromise.then(() => {
      if (done) return;
      emitTerminalError(
        client.exitError ? msgOf(client.exitError) : "grok agent connection closed.",
      );
    });

    // FIRST-TURN PERSONA: ACP session/new has no instructions field, so the panel
    // system prompt is prepended to the first turn's prompt as a clearly-marked
    // system/context preamble (later turns send plain text). Mirrors codex.
    let turnText = turn.text;
    if (this.needsSystemPreamble && this.deps.systemAppend) {
      turnText =
        `<system>\n${this.deps.systemAppend}\n</system>\n\n` +
        `The user's first message follows.\n\n${turn.text}`;
      this.needsSystemPreamble = false;
    }

    // Build the prompt ContentBlock[]: the text block first (preserves prompt
    // context), then any resolved inline base64 image blocks (vision parity).
    // Images are only attached when the agent advertised promptCapabilities.image
    // (default-allow when the capability is unknown).
    const prompt: Array<Record<string, unknown>> = [{ type: "text", text: turnText }];
    const imagesAllowed = this.agentCaps?.promptCapabilities?.image !== false;
    if (imagesAllowed) {
      for (const ref of turn.images ?? []) {
        const block = await this.fetchImageBlock(ref);
        if (block) prompt.push(block);
      }
    }

    try {
      // session/prompt is a REQUEST that RESOLVES with a stopReason at turn end.
      client
        .request<{ stopReason?: string }>("session/prompt", { sessionId, prompt })
        .then((res) => {
          if (finishedResult) return;
          finishedResult = true;
          closeStream();
          const stop = res?.stopReason;
          // Commit the accumulated assistant text (if any) as the authoritative
          // turn-ending message — no per-turn rewind anchor (forkAtAnchor=false).
          const text = assistantText.trim();
          if (text) push({ type: "assistant", text, ...(messageId ? { id: messageId } : {}) });
          // end_turn / max_tokens / max_turn_requests = a real completion; cancelled
          // (user interrupt) and refusal are not "ok".
          const ok = !!stop && stop !== "cancelled" && stop !== "refusal";
          push({ type: "result", ok, ...(stop ? { subtype: stop } : {}) });
          finish();
        })
        .catch((err) => {
          // A failed prompt ends the turn. When the child dies mid-turn handleExit
          // rejects this BEFORE exitPromise resolves, so this .catch runs first —
          // it MUST end with a terminal result (the idempotent helper guarantees
          // exactly one), or the exit watcher then sees done and hangs the gate.
          if (interrupted) emitTerminalError("grok turn interrupted.");
          else emitTerminalError(msgOf(err));
        });

      // Drain the bridged queue until the turn completes.
      while (true) {
        while (queue.length) {
          yield queue.shift()!;
        }
        if (done) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      while (queue.length) yield queue.shift()!;
    } finally {
      // Mark interrupted so a late prompt rejection doesn't surface a spurious
      // error after teardown.
      interrupted = true;
      // Restore the prior handler ONLY if it's still ours (close() may have nulled
      // it during shutdown — don't resurrect a stale handler onto a dead client).
      if (client.notificationHandler && !client.exitError) client.notificationHandler = prev ?? null;
    }
  }

  /** Stop the current turn without ending the session → `session/cancel`
   *  (notification). The in-flight session/prompt then resolves with
   *  stopReason:"cancelled", which the run-turn path turns into a terminal result. */
  async interrupt(): Promise<void> {
    const direct = await this.resolveMode();
    if (direct) {
      await direct.interrupt();
      return;
    }
    const client = this.client;
    if (!client || !this.sessionId) return;
    try {
      client.notify("session/cancel", { sessionId: this.sessionId });
    } catch (err) {
      logger.debug(`[grok-backend] interrupt: ${msgOf(err)}`);
    }
  }

  /** Switch the model live. ACP pins the model at spawn (`--model`), so this can't
   *  reconfigure a running child — instead it marks the model dirty (this.model !=
   *  this.spawnedModel) and invalidates the cached spawn spec. The persistent run()
   *  loop then RESPAWNS the `grok agent` CLI with the new --model (and a fresh
   *  session) transparently before the next turn (see run()'s live-switch branch).
   *  If the backend hasn't spawned yet, the first prepare() simply uses the new
   *  model. Ignores non-Gemini ids (PanelAgent may pass the Claude panel model). */
  async setModel(model: string): Promise<void> {
    const direct = await this.resolveMode();
    if (direct) {
      await direct.setModel?.(model);
      return;
    }
    if (!isGrokModel(model)) return;
    this.model = model;
    this.spawnSpec = null; // next spawn rebuilds argv with the new --model
  }

  /**
   * Model enumeration. In direct-token mode this delegates to GrokDirectBackend
   * (a live GET /v1/models probe). In ACP mode, ACP exposes no model catalog, so
   * we surface a static set (the current Grok CLI composer family); the panel
   * picker degrades gracefully on an empty list. No effort metadata (Grok's ACP
   * mode has no discrete effort scale) → the panel hides the effort dropdown.
   */
  async listModels(): Promise<ModelChoice[]> {
    const direct = await this.resolveMode();
    if (direct) return direct.listModels();
    return GROK_MODELS;
  }

  /** Permanently dispose of the backend (AgentBackend.close): kill the gemini
   *  process TREE (Windows shell-fallback grandchild included), remove listeners,
   *  null the client. Idempotent + safe when never prepared. Mirrors codex (P0-1):
   *  interrupt() is a no-op when idle, so without this the child is orphaned. */
  async close(): Promise<void> {
    this.disposed = true; // tripwire FIRST (an in-flight prepare() bails) (P0-A)
    const direct = await this.resolveMode();
    if (direct) {
      await direct.close?.();
      return;
    }
    const client = this.client;
    const preparing = this.preparingClient;
    this.client = null;
    this.preparingClient = null;
    this.sessionId = null;
    if (client) {
      client.notificationHandler = null;
      await client.close().catch(() => {});
    }
    if (preparing && preparing !== client) {
      preparing.notificationHandler = null;
      await preparing.close().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Direct-token Grok (xAI) backend — Task 6 of the in-panel OAuth plan.
//
// Hits `https://api.x.ai/v1/responses` with the OAuth bearer resolved from
// `~/.grok/auth.json` (resolveGrokOAuth), instead of driving the Grok CLI over
// ACP. This reuses the SAME Responses-style SSE adapter SHAPE as
// chatgpt-oauth-backend.ts's Codex adapter (prior research judged xAI's public
// API to be codex_responses-adapter compatible) and the SAME 6-tool router as
// Ollama/ChatGPT (OllamaBackend.dispatch/connectTools/buildModelTools) — a
// small model-agnostic HTTP endpoint has no agent harness of its own, so this
// backend owns the whole tool loop the way Ollama/ChatGPT already do.
//
// DIVERGENCES from the Codex adapter (xAI is NOT a re-skinned ChatGPT):
//   - No `chatgpt-account-id` header — that's OpenAI/ChatGPT account-routing
//     plumbing with no xAI equivalent; the bearer token alone identifies the
//     account.
//   - Every outbound request is host-allowlist-checked (assertAllowedTokenHost
//     against OAUTH_PROVIDERS.grok.apiHostAllowlist, i.e. `x.ai`/`*.x.ai`)
//     before the bearer is attached, and any error response body is REDACTED
//     (redactTokens, from oauth-flow.ts — the single shared redactor) before
//     it can reach a thrown message or a log line — the access token itself
//     is never logged anywhere in this path.
//   - Model slug + exact endpoint sub-path are UNVERIFIED against the live xAI
//     API (no network access at authoring time, and no Task-1 research
//     artifact survived for this session to consult). GROK_XAI_DEFAULT_MODEL
//     reuses the ACP CLI's existing composer alias as a placeholder rather
//     than inventing a new model string; listModels() prefers a live
//     `GET /v1/models` probe over any hardcoded catalog. CONFIRM both against
//     xAI's docs (or override via COMFYUI_MCP_GROK_XAI_MODEL) before relying
//     on this path in production — see the task-6 report for the flagged risk.
// ---------------------------------------------------------------------------

export const GROK_XAI_API_BASE = "https://api.x.ai/v1";
// The exact Responses sub-path is UNVERIFIED against the live xAI API (Task 8's
// smoke test confirms it). Made overridable via COMFYUI_MCP_GROK_XAI_RESPONSES_URL
// so if the real path differs it's a config flip, not a code change — whatever URL
// is used still passes assertAllowedTokenHost (x.ai/*.x.ai) before any bearer.
export const GROK_XAI_RESPONSES_URL =
  process.env.COMFYUI_MCP_GROK_XAI_RESPONSES_URL?.trim() || `${GROK_XAI_API_BASE}/responses`;
const GROK_XAI_MODELS_URL = `${GROK_XAI_API_BASE}/models`;
const GROK_MAX_TOOL_ROUNDS = 32;

/** `x.ai` / `*.x.ai` — the same allowlist the OAuth engine already enforces for
 *  the Grok token endpoint (oauth-flow.ts), reused here for the DATA API calls. */
function grokApiHostAllowlist(): string[] {
  return OAUTH_PROVIDERS.grok?.apiHostAllowlist ?? ["x.ai"];
}

// UNVERIFIED against the live xAI model catalog (see the divergences note
// above) — reuses the ACP CLI's default composer alias as a safe, non-invented
// placeholder rather than guessing a raw-API model slug. Override with
// COMFYUI_MCP_GROK_XAI_MODEL once confirmed, or rely on listModels()'s live
// /v1/models probe to surface the account's real slugs.
export const GROK_XAI_DEFAULT_MODEL =
  process.env.COMFYUI_MCP_GROK_XAI_MODEL?.trim() || GROK_DEFAULT_MODEL;

export const GROK_XAI_SYSTEM_PROMPT = [
  "You are the ComfyUI agent in a sidebar panel. Answer in Markdown.",
  "",
  "You have exactly six tools:",
  "- list_tools / describe_tool / call_tool — headless ComfyUI server.",
  "- panel_list_tools / panel_describe_tool / panel_call_tool — live canvas.",
  "",
  "Describe a tool before its first call. Finish tasks by running tools, not inventing results.",
].join("\n");

type GrokTurnMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
  tool_call_id?: string;
};

type GrokResponsesInputItem = Record<string, unknown>;

/** OpenAI-tool-def → Responses `tools[]` shape (identical to Codex's toResponsesTools). */
function grokToolsToResponses(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return tools.map((t) => {
    const fn = (t.function ?? t) as { name?: string; description?: string; parameters?: unknown };
    return {
      type: "function",
      name: fn.name,
      description: fn.description ?? "",
      parameters: fn.parameters ?? { type: "object", properties: {} },
    };
  });
}

/** In-memory turn history → Responses `input[]` items (identical shaping to
 *  Codex's historyToCodexInput — same Responses `input` schema). */
function grokHistoryToResponsesInput(messages: GrokTurnMessage[]): GrokResponsesInputItem[] {
  const items: GrokResponsesInputItem[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      items.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: m.content }],
      });
      continue;
    }
    if (m.role === "assistant") {
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          items.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.name,
            arguments: tc.arguments || "{}",
          });
        }
      }
      if (m.content.trim()) {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: m.content }],
        });
      }
      continue;
    }
    if (m.role === "tool" && m.tool_call_id) {
      items.push({
        type: "function_call_output",
        call_id: m.tool_call_id,
        output: m.content,
      });
    }
  }
  return items;
}

const GROK_DIRECT_CAPABILITIES = {
  persistentChannel: true,
  streamingDeltas: true,
  interruptMidTurn: true,
  forkAtAnchor: false,
  inProcessMcp: false,
  modelEnumeration: true, // live GET /v1/models probe
  slashCommands: false,
  hooks: false,
  vision: false, // the 6-tool router is text-only (mirrors Ollama/ChatGPT); NeutralTurn.images unused here
};

/** Direct-token Grok (xAI) backend — see the module-level comment above for the
 *  full rationale and the divergences from the Codex adapter it mirrors. */
export class GrokDirectBackend extends OllamaBackend {
  readonly id = "grok" as const;
  readonly capabilities = GROK_DIRECT_CAPABILITIES;

  private accessToken = "";
  private grokTurnHistory: GrokTurnMessage[] = [];
  private grokSessionId: string | null = null;
  private resolveOAuth: (deps?: CodeProviderAuthDeps) => Promise<GrokOAuthCredentials>;
  /** Credentials `GrokBackend.resolveMode()` ALREADY resolved to pick the mode,
   *  handed straight to prepare() so the initial preflight does NOT re-probe
   *  `resolveGrokOAuth` (single-probe on the success path). Consumed once, then
   *  cleared; `resolveOAuth` remains for any future mid-session re-resolve. */
  private initialCredentials: GrokOAuthCredentials | undefined;

  constructor(
    deps: Pick<GrokBackendDeps, "cwd" | "model" | "comfyuiUrl" | "mcpServers" | "systemAppend"> & {
      resolveGrokOAuth?: (deps?: CodeProviderAuthDeps) => Promise<GrokOAuthCredentials>;
      /** The credentials the facade already resolved when deciding the mode. */
      initialCredentials?: GrokOAuthCredentials;
    } = {},
  ) {
    super({
      cwd: deps.cwd,
      comfyuiUrl: deps.comfyuiUrl,
      mcpServers: deps.mcpServers,
      systemAppend: deps.systemAppend,
      backendId: "grok",
      api: "openai",
      host: "https://unused", // never dialed — every request goes straight to GROK_XAI_RESPONSES_URL
      model: deps.model ?? GROK_XAI_DEFAULT_MODEL,
    });
    this.model = deps.model ?? GROK_XAI_DEFAULT_MODEL;
    this.resolveOAuth = deps.resolveGrokOAuth ?? resolveGrokOAuth;
    this.initialCredentials = deps.initialCredentials;
  }

  override async prepare(): Promise<void> {
    if (this.disposed) throw new Error("grok backend is closed.");
    if (this.prepared) return;
    // Prefer the credentials the facade already resolved to pick this mode — the
    // initial preflight must NOT re-probe resolveGrokOAuth (single-probe on the
    // success path). Only re-resolve if none were threaded in (e.g. a direct
    // instantiation in a test or a future caller).
    const creds = this.initialCredentials ?? (await this.resolveOAuth());
    this.initialCredentials = undefined; // consumed
    this.accessToken = creds.accessToken;
    await this.connectTools();
    this.prepared = true;
    logger.info(
      `[grok-backend] ready (direct xAI OAuth, model ${this.model}, ${this.comfyTools.length} comfyui meta-tools, ${this.panelTools.length} panel tools behind the router)`,
    );
  }

  private async *xaiResponsesStream(
    instructions: string,
    input: GrokResponsesInputItem[],
    tools: Array<Record<string, unknown>>,
    signal: AbortSignal,
    onActivity?: () => void,
  ): AsyncGenerator<
    AgentEvent,
    {
      content: string;
      toolCalls: Array<{ id: string; name: string; arguments: string }>;
      usage?: Record<string, number>;
      streamId: string | null;
    }
  > {
    assertAllowedTokenHost(GROK_XAI_RESPONSES_URL, grokApiHostAllowlist());
    const keepalive = onActivity ? setInterval(onActivity, 5000) : null;
    let res: Response;
    try {
      res = await fetch(GROK_XAI_RESPONSES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify({
          model: this.model,
          instructions,
          input,
          tools: grokToolsToResponses(tools),
          stream: true,
          store: false,
        }),
        signal,
      });
    } finally {
      if (keepalive) clearInterval(keepalive);
    }
    if (!res.ok || !res.body) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(`xAI Responses http ${res.status}: ${redactTokens(bodyText).slice(0, 400)}`);
    }

    let content = "";
    const partial = new Map<string, { id: string; name: string; args: string }>();
    let usage: Record<string, number> | undefined;
    let streamOpen = false;
    const streamId = randomUUID();
    let buffer = "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let eventType = "";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data || data === "[DONE]") continue;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }

        const type = eventType || String(payload.type ?? "");
        if (type === "response.output_text.delta") {
          const delta = String(payload.delta ?? "");
          if (delta) {
            if (!streamOpen) {
              streamOpen = true;
              yield { type: "stream_start", id: streamId };
            }
            content += delta;
            yield { type: "assistant_delta", text: delta };
          }
        }

        if (type === "response.function_call_arguments.delta") {
          const itemId = String(payload.item_id ?? payload.call_id ?? "call");
          const slot = partial.get(itemId) ?? { id: itemId, name: "", args: "" };
          if (payload.name) slot.name = String(payload.name);
          if (payload.arguments) slot.args += String(payload.arguments);
          partial.set(itemId, slot);
        }

        if (type === "response.output_item.done") {
          const item = (payload.item ?? payload) as Record<string, unknown>;
          if (item.type === "function_call") {
            const id = String(item.call_id ?? item.id ?? randomUUID());
            partial.set(id, {
              id,
              name: String(item.name ?? ""),
              args: String(item.arguments ?? "{}"),
            });
          }
        }

        if (type === "response.completed") {
          const u =
            (payload.response as { usage?: Record<string, number> } | undefined)?.usage ??
            (payload.usage as Record<string, number> | undefined);
          if (u) {
            usage = {
              input_tokens: Number(u.input_tokens ?? 0),
              output_tokens: Number(u.output_tokens ?? 0),
            };
          }
        }
      }
    }

    if (streamOpen) yield { type: "stream_end" };
    const toolCalls = [...partial.values()]
      .filter((t) => t.name)
      .map((t) => ({ id: t.id, name: t.name, arguments: t.args || "{}" }));
    return { content, toolCalls, usage, streamId: streamOpen ? streamId : null };
  }

  override async *run(opts: BackendStartOptions): AsyncIterable<AgentEvent> {
    await this.prepare();
    if (opts.model && isGrokModel(opts.model)) this.model = opts.model;

    const fresh = !this.grokSessionId || (opts.resume && opts.resume !== this.grokSessionId);
    this.grokSessionId = opts.resume ?? this.grokSessionId ?? `grok-${randomUUID()}`;
    if (fresh) this.grokTurnHistory = [];
    yield { type: "session", sessionId: this.grokSessionId, model: this.model };

    // NOTE: upstream (MichaelDanCurtis fork) routes this through the editable
    // prompt registry (services/prompt-overrides). That registry is not ported
    // here, so the built-in prompt is used directly.
    const instructions = [GROK_XAI_SYSTEM_PROMPT, this.deps.systemAppend]
      .filter(Boolean)
      .join("\n\n");

    for await (const turn of opts.channel) {
      yield* this.runGrokTurn(turn, instructions, opts);
    }
  }

  private async *runGrokTurn(
    turn: NeutralTurn,
    instructions: string,
    opts: BackendStartOptions,
  ): AsyncIterable<AgentEvent> {
    const abort = new AbortController();
    this.turnAbort = abort;
    const tools = this.buildModelTools();
    this.grokTurnHistory.push({ role: "user", content: turn.text });

    let resultEmitted = false;
    try {
      for (let round = 0; round < GROK_MAX_TOOL_ROUNDS; round++) {
        const stream = this.xaiResponsesStream(
          instructions,
          grokHistoryToResponsesInput(this.grokTurnHistory),
          tools,
          abort.signal,
          opts.onActivity,
        );
        let content = "";
        let toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
        let usage: Record<string, number> | undefined;
        let streamId: string | null = null;
        for (;;) {
          const r = await stream.next();
          if (r.done) {
            ({ content, toolCalls, usage, streamId } = r.value);
            break;
          }
          yield r.value;
        }

        if (!toolCalls.length) {
          this.grokTurnHistory.push({ role: "assistant", content });
          yield { type: "assistant", text: content, id: streamId ?? undefined, usage };
          yield { type: "result", ok: true, usage };
          resultEmitted = true;
          return;
        }

        this.grokTurnHistory.push({ role: "assistant", content, tool_calls: toolCalls });
        for (const tc of toolCalls) {
          if (abort.signal.aborted) throw new Error("interrupted");
          yield { type: "tool_call", name: tc.name, phase: "start", detail: tc.arguments };
          const { text, isError } = await this.dispatch(tc.name, tc.arguments);
          opts.onActivity?.();
          yield { type: "tool_call", name: tc.name, phase: "end", detail: { isError } };
          this.grokTurnHistory.push({
            role: "tool",
            tool_call_id: tc.id,
            content: text.slice(0, 16000),
          });
        }
      }
      yield {
        type: "assistant",
        text: "(stopped: too many tool rounds in one turn — ask me to continue)",
      };
      yield { type: "result", ok: false, subtype: "max_tool_rounds" };
      resultEmitted = true;
    } catch (err) {
      const interrupted = abort.signal.aborted;
      if (!interrupted) {
        logger.warn(`[grok-backend] direct-token turn failed: ${msgOf(err)}`);
        yield { type: "error", message: `grok backend: ${msgOf(err)}` };
        yield {
          type: "assistant",
          text: `⚠️ The model request failed: ${msgOf(err).slice(0, 400)}`,
        };
      }
      if (!resultEmitted) {
        yield { type: "result", ok: false, subtype: interrupted ? "interrupted" : "error" };
      }
    } finally {
      if (this.turnAbort === abort) this.turnAbort = null;
    }
  }

  override async setModel(model: string): Promise<void> {
    if (isGrokModel(model)) this.model = model;
  }

  /** Prefer a live account probe over any hardcoded catalog (the exact xAI
   *  model slugs are unverified — see the module-level comment). Falls back to
   *  just the configured model id if the probe fails (offline, wrong scope, …). */
  override async listModels(): Promise<ModelChoice[]> {
    try {
      assertAllowedTokenHost(GROK_XAI_MODELS_URL, grokApiHostAllowlist());
      const res = await fetch(GROK_XAI_MODELS_URL, {
        headers: { authorization: `Bearer ${this.accessToken}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [{ id: this.model, label: this.model }];
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      const ids = (data.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
      if (!ids.length) return [{ id: this.model, label: this.model }];
      const rest = ids.filter((id) => id !== this.model).slice(0, 40);
      return [this.model, ...rest].map((id) => ({ id, label: id }));
    } catch {
      return [{ id: this.model, label: this.model }];
    }
  }
}

// Expose the default model id for the orchestrator wiring (COMFYUI_MCP_GEMINI_MODEL
// fallback) without duplicating the literal.
export { GROK_DEFAULT_MODEL };
