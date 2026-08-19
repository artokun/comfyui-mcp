// Qwen Code backend — the provider-specific adapter behind the AgentBackend
// port, driving the Qwen Code CLI over its **ACP (Agent Client Protocol)** mode
// (`qwen --acp`), a JSON-RPC 2.0 client over stdio. This is a faithful MIRROR
// of gemini-backend.ts: same self-contained line-framed JSON-RPC client, same
// per-turn event-queue bridge, same terminal-result invariant, same
// Windows/POSIX process-tree kill. Qwen Code was forked from the Gemini CLI, so
// its ACP surface (`initialize` → `session/new` → `session/prompt`, streamed
// `session/update` notifications, `session/cancel`) is the same protocol.
//
// PanelAgent keeps all provider-agnostic orchestration (queue, turn-gate, bridge
// push, self-restart) and drives this backend via
// `for await (const ev of backend.run({...}))`. See
// design/agent-backend-injection.md.
//
// TRANSPORT CHOICE (issue #1417): Qwen Code ALSO ships an experimental
// `qwen serve` HTTP/SSE daemon whose northbound API multiplexes ONE agent across
// many clients — and which itself speaks ACP to a spawned `qwen --acp` child.
// The Agent Panel wants exactly the opposite (one orchestrator-scoped session
// per tab), so this backend takes the stdio `qwen --acp` path directly and the
// daemon is deliberately NOT used (no daemon lifecycle, no SSE replay layer, no
// bearer-auth surface — `qwen serve` is the transport Qwen itself marks
// experimental).
//
// AUTH (the CLI owns auth): Qwen Code authenticates via `qwen` → `/auth`
// (Alibaba ModelStudio Coding Plan, third-party providers, or a custom
// OpenAI/Anthropic/Gemini-compatible endpoint), persisted in
// ~/.qwen/settings.json, or via env keys (DASHSCOPE_API_KEY,
// BAILIAN_CODING_PLAN_API_KEY, OPENAI_API_KEY/OPENAI_BASE_URL) — all forwarded
// through the spawned process.env. The Qwen OAuth free tier was DISCONTINUED
// 2026-04-15, so a CLI that was previously signed in can carry a stale
// `qwen-oauth` selectedType + dead cached creds that OUTRANK a valid env key
// (session/new succeeds, the first prompt then dies) — the exact trap the
// Gemini backend hit with the retired Google individual login. We therefore
// authenticate PROACTIVELY with the `openai` auth method when an env key is set
// (see pickAuthMethod), and otherwise react to an `auth_required` error from
// session/new with a single `authenticate` retry, surfacing an actionable
// sign-in message if it still fails.
//
// PARITY with Codex/Gemini: the Qwen backend gets the SAME tool surface — the
// headless `comfyui` stdio MCP plus the `panel` HTTP MCP for live-graph panel_*
// tools — declared to `session/new` as ACP McpServers. The panel system prompt
// is prepended to the FIRST turn's prompt (ACP `session/new` has no system /
// instructions field).
//
// WINDOWS: Qwen Code is commonly installed as `qwen.cmd`, which Node cannot
// spawn shell-lessly — so on win32 we spawn through the shell (mirroring the
// Gemini PATH fallback) and close() kills the whole process TREE (the direct
// child is the cmd shim, the grandchild the real qwen node process).
//
// ASSUMPTIONS we could NOT verify without the live `qwen` CLI (flagged inline,
// see also the PR body): the exact ACP McpServer http/sse variant shape (we
// reuse the `sse` mapping the live Gemini/Grok CLIs require), the session/load
// resume semantics, the auth_required retry, and live model switching (the
// model is set at SPAWN via --model since ACP exposes no standard per-session
// model setter). Each is the closest faithful mapping to the documented ACP
// spec.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { logger } from "../utils/logger.js";
import { errorText, promptText } from "./error-text.js";
import { buildAgentSpawnEnv } from "../services/panel-secrets.js";
import {
  type AgentBackend,
  type AgentEvent,
  type BackendStartOptions,
  type ModelChoice,
  type NeutralTurn,
  QWEN_CAPABILITIES,
  stampTurn,
} from "./agent-backend.js";
import type { ImageRef } from "./panel-agent.js";

function msgOf(err: unknown): string {
  return errorText(err);
}

/**
 * Kill an entire process tree, not just the direct child. On the Windows
 * PATH/shell fallback the direct child is a cmd.exe/`.cmd` shim whose grandchild
 * is the real `qwen` node process — killing only the shell leaves the tree
 * alive. Use `taskkill /T /F`. On POSIX, signal the process group (negative pid)
 * so a shell + its child both die, falling back to the single pid. Best-effort +
 * swallows errors: it runs during teardown and must never throw into the host.
 * (Identical to gemini-backend's killProcessTree — same spawn posture.)
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

// ---- minimal JSON-RPC-2.0-over-stdio client for `qwen --acp` ----
// A self-contained line-framed (newline-delimited) JSON-RPC 2.0 client, modeled
// 1:1 on gemini-backend's AcpClient (which is itself modeled on codex-backend's
// AppServerClient). The server→client request set we auto-approve is the ACP
// one (session/request_permission).

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
  /** Resolves when the `qwen` process exits or errors — runTurn() races its
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

  /** Spawn `qwen --acp` and perform the ACP `initialize` handshake. Returns the
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
              `qwen --acp exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${this.stderr ? ` ${this.stderr.trim().split(/\r?\n/).slice(-2).join(" ")}` : ""}`,
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
    if (this.closed) return Promise.reject(new Error("qwen --acp client is closed."));
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
      this.handleExit(this.exitError ?? new Error("qwen --acp stdin is not available."));
      throw this.exitError ?? new Error("qwen --acp stdin is not available.");
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
      this.handleExit(new Error(`Failed to parse qwen --acp JSONL: ${msgOf(error)}`));
      return;
    }
    // Server→client request (id + method). Auto-approve permission prompts; reply
    // method-not-found to anything else so the protocol keeps moving (we declared
    // no fs/terminal client capabilities, so those shouldn't arrive).
    if (message.id !== undefined && message.method) {
      const result = this.autoApproveResult(message);
      if (result) {
        logger.debug(`[qwen-backend] auto-approving server request ${message.method}`);
        this.send({ id: message.id, result });
      } else {
        logger.debug(
          `[qwen-backend] unsupported server request ${message.method} — replying method-not-found`,
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
            message.error.message ?? `qwen --acp ${p.method} failed.`,
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
      p.reject(error ?? new Error("qwen --acp connection closed."));
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
      // the real qwen node process, so proc.kill() alone would orphan it.
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
// `--model` flag — so we surface a static catalog of the current Qwen coding
// family (the models the Alibaba ModelStudio Coding Plan advertises for
// `qwen --model`, per qwenlm.github.io/qwen-code-docs). Qwen Code's own default
// is qwen3-coder-plus; COMFYUI_MCP_QWEN_MODEL overrides, and any id the CLI
// accepts (a custom modelProviders entry, e.g.) works the same way.
const QWEN_MODELS: ModelChoice[] = [
  { id: "qwen3-coder-plus", label: "Qwen3 Coder Plus" },
  { id: "qwen3-coder-next", label: "Qwen3 Coder Next" },
  { id: "qwen3.7-plus", label: "Qwen3.7 Plus" },
];
const QWEN_DEFAULT_MODEL = "qwen3-coder-plus";

/** Does this id look like a Qwen model (vs. the Claude panel model PanelAgent
 *  unconditionally passes as opts.model)? Used so the configured Qwen model
 *  wins — mirrors gemini-backend's isGeminiModel guard (P1-1). */
function isQwenModel(id: string): boolean {
  // Qwen ids start with "qwen" with NO separator (qwen3-coder-plus, qwen3.7-plus).
  return /^qwen/i.test(id);
}

/** A declared MCP server for the ACP session. Either a stdio command (the headless
 *  comfyui MCP) or a streamable-HTTP url (the panel_* loopback server). Identical
 *  shape to gemini-backend's GeminiMcpServerSpec so the orchestrator can build one
 *  config for all the ACP backends. */
export type QwenMcpServerSpec =
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { transport: "http"; url: string };

/**
 * Convert our MCP server specs into the ACP `session/new` `mcpServers` array.
 * ACP stdio McpServer: { name, command, args, env:[{name,value}] }. Streamable
 * HTTP MCP rides the SSE variant ({ type:"sse", name, url, headers:[] }) — the
 * live Gemini (and Grok) CLIs reject { type:"http" } with Invalid params on the
 * FIRST user message, after a successful connect ack, so the old "http" mapping
 * made a panel-MCP-attached tab look connected but fail on first use.
 * (Identical to gemini-backend's buildAcpMcpServers — same wire shape.)
 */
export function buildAcpMcpServers(
  servers: Record<string, QwenMcpServerSpec>,
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

/** Provider config the Qwen backend needs. Mirrors GeminiBackendDeps. */
export interface QwenBackendDeps {
  /** Working directory for the ACP session (defaults to opts.cwd / process cwd). */
  cwd?: string;
  /** Default model for new sessions (e.g. qwen3-coder-plus); set at SPAWN via --model. */
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
  mcpServers?: Record<string, QwenMcpServerSpec>;
  /**
   * Panel system prompt (persona). ACP `session/new` has no instructions field,
   * so this is PREPENDED to the first turn's prompt as a clearly-marked
   * system/context preamble; later turns send plain text.
   */
  systemAppend?: string;
}

/** The env keys that count as a Qwen-side credential for the auth flow: the
 *  Dashscope standard key, the Coding Plan key, or a generic OpenAI-compatible
 *  key (the CLI's `openai` auth type reads OPENAI_API_KEY/OPENAI_BASE_URL). */
const QWEN_AUTH_ENV_KEYS = ["DASHSCOPE_API_KEY", "BAILIAN_CODING_PLAN_API_KEY", "OPENAI_API_KEY"] as const;

function qwenAuthKeyPresent(): boolean {
  return QWEN_AUTH_ENV_KEYS.some((k) => !!process.env[k]?.trim());
}

/**
 * The Qwen Code CLI ACP adapter. One instance per PanelAgent; it holds the live
 * ACP client + current session id and re-opens on each `run()`.
 */
export class QwenBackend implements AgentBackend {
  readonly id = "qwen" as const;
  readonly capabilities = QWEN_CAPABILITIES;
  private deps: QwenBackendDeps;
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
  /** The model the LIVE `qwen --acp` child was actually spawned with. Qwen Code
   *  pins the model at spawn, so when this drifts from `this.model` (a live
   *  setModel) the run loop respawns the CLI before the next turn (P1). */
  private spawnedModel: string | undefined;
  /** Capabilities the agent advertised at initialize (loadSession / image / http). */
  private agentCaps: AcpInitializeResult["agentCapabilities"] = undefined;
  private authMethods: AcpAuthMethod[] = [];
  /** True until the panel system prompt has been prepended to a turn. Reset
   *  whenever a NEW session starts (run()). */
  private needsSystemPreamble = false;

  constructor(deps: QwenBackendDeps = {}) {
    this.deps = deps;
    this.model = deps.model;
  }

  /**
   * Resolve how to spawn `qwen --acp`. Unlike Gemini there is NO bundled npm
   * package in this repo — the Qwen Code CLI is a separate install
   * (`npm i -g @qwen-code/qwen-code`, brew, or the standalone installer), so we
   * resolve `qwen` from PATH. A PATH `qwen` on Windows resolves to a
   * `.cmd`/`.ps1` shim, which spawn can't find WITHOUT a shell — hence
   * useShell on win32 (mirrors gemini-backend's PATH fallback; the tree kill in
   * close() handles the shim's grandchild). The `--model` flag pins the model
   * at spawn (ACP has no standard per-session model setter).
   */
  private resolveSpawn(): { cmd: string; args: string[]; useShell: boolean } {
    if (this.spawnSpec) return this.spawnSpec;
    const modelArgs = this.model ? ["--model", this.model] : [];
    this.spawnSpec = {
      cmd: "qwen",
      args: ["--acp", ...modelArgs],
      useShell: process.platform === "win32",
    };
    return this.spawnSpec;
  }

  /**
   * Fetch a ComfyUI image (/view) and return it as an ACP base64 `image`
   * ContentBlock ({ type:"image", mimeType, data }) — or null on any failure (the
   * text reference still names the image as a fallback). ACP takes inline base64,
   * so this mirrors GeminiBackend.fetchImageBlock exactly.
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
   * Preflight: resolve + spawn `qwen --acp` and perform the ACP `initialize`
   * handshake. Fails fast with a clear reject so a missing binary surfaces
   * immediately instead of being retried as a dropped session. Idempotent —
   * reuses the live client. NOTE: the actual login is verified lazily at
   * `session/new` (ACP returns auth_required there) — see ensureSession() —
   * since ACP has no pre-session account probe; flagged in the PR body.
   */
  async prepare(): Promise<void> {
    if (this.disposed) throw new Error("qwen backend is closed.");
    if (this.client) return;
    const { cmd, args, useShell } = this.resolveSpawn();
    const cwd = this.deps.cwd ?? process.cwd();
    // SECURITY: spawn with the agent env — process.env MINUS tool-only secrets
    // (RunPod/HF/CivitAI… tokens; they belong only to the comfyui tool child).
    // The Qwen auth env keys (DASHSCOPE_API_KEY & co.) are NOT tool-only, so
    // they pass through unchanged — they are this provider's OWN credential.
    const client = new AcpClient(cmd, args, cwd, buildAgentSpawnEnv(process.env), useShell);
    // Publish the in-flight client BEFORE the startup awaits so a concurrent
    // close() can find and kill it (P0-A).
    this.preparingClient = client;
    const abortIfDisposed = async (): Promise<void> => {
      if (!this.disposed) return;
      if (this.preparingClient === client) this.preparingClient = null;
      await client.close().catch(() => {});
      throw new Error("qwen backend was closed during prepare().");
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
          `Could not start the Qwen Code CLI in ACP mode (qwen backend). Install Qwen Code (npm i -g @qwen-code/qwen-code, or ensure \`qwen\` is on PATH) and sign in (run \`qwen\` once and complete /auth, or set DASHSCOPE_API_KEY / BAILIAN_CODING_PLAN_API_KEY). Details: ${msgOf(err)}`,
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
        `[qwen-backend] ACP ready (protocol ${init.protocolVersion ?? "?"}, agent ${init.agentInfo?.name ?? "qwen"}${this.authMethods.length ? `, ${this.authMethods.length} auth method(s)` : ""})`,
      );
    } finally {
      if (this.preparingClient === client) this.preparingClient = null;
    }
  }

  /** Ensure a live ACP session exists, creating (session/new) or resuming
   *  (session/load) one. Handles an `auth_required` error from session/new by
   *  attempting a single `authenticate` with the picked method (see
   *  pickAuthMethod), then retrying — surfacing a clear sign-in message if it
   *  still fails. Returns the session id. */
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
        logger.warn(`[qwen-backend] session/load failed (${msgOf(err)}) — starting a fresh session`);
      }
    }
    // NEW session, with one auth_required retry.
    const createNew = async (): Promise<string> => {
      const res = await client.request<{ sessionId?: string }>("session/new", { cwd, mcpServers });
      if (!res?.sessionId) throw new Error("qwen --acp session/new returned no sessionId.");
      return res.sessionId;
    };
    // PROACTIVE API-key auth. When a Qwen-side env key is set we authenticate up
    // front rather than only reacting to `auth_required`. Why: a CLI that was
    // previously signed in via Qwen OAuth keeps `security.auth.selectedType:
    // "qwen-oauth"` + cached OAuth creds, which OUTRANK the env key — and the
    // Qwen OAuth free tier was discontinued 2026-04-15, so `session/new` can
    // SUCCEED via the dead OAuth without ever raising `auth_required`, then fail
    // at request time. Authenticating with the openai method here switches the
    // CLI onto the env key and clears the stale creds (mirrors gemini-backend's
    // GEMINI_API_KEY proactive auth after the 2026-06-18 Google login sunset).
    if (qwenAuthKeyPresent()) {
      const apiKeyMethod = this.pickAuthMethod();
      if (apiKeyMethod) {
        try {
          await client.request("authenticate", { methodId: apiKeyMethod });
        } catch (err) {
          logger.warn(
            `[qwen-backend] proactive API-key authenticate failed (${msgOf(err)}) — continuing to session/new`,
          );
        }
      }
    }
    try {
      this.sessionId = await createNew();
    } catch (err) {
      if (!this.isAuthRequired(err)) throw err;
      // The CLI owns auth. Pick the openai/api-key method when an env key is set
      // rather than blindly the first advertised method; the key itself already
      // reaches the CLI via the spawned process.env.
      const methodId = this.pickAuthMethod();
      if (!methodId) throw new Error(this.authFailureMessage());
      try {
        await client.request("authenticate", { methodId });
        this.sessionId = await createNew();
      } catch {
        throw new Error(this.authFailureMessage());
      }
    }
    this.needsSystemPreamble = !!this.deps.systemAppend; // fresh session → persona on first turn
    return this.sessionId!;
  }

  /** Choose the ACP auth method for the `authenticate` retry. Prefers the
   *  openai / api-key method when a Qwen-side env key is set — blindly taking
   *  authMethods[0] could pick the discontinued qwen-oauth flow, which
   *  dead-loops headlessly. Falls back to the first advertised method when no
   *  key is set or no api-key-ish method is advertised. We match against the
   *  CLI's own advertised methods rather than hardcoding the literal, so this
   *  survives auth-type value changes across qwen-code versions. */
  private pickAuthMethod(): string | undefined {
    const methods = this.authMethods;
    if (methods.length === 0) return undefined;
    if (qwenAuthKeyPresent()) {
      const hay = (m: AcpAuthMethod) =>
        `${m.id ?? ""} ${m.name ?? ""} ${m.description ?? ""}`.toLowerCase();
      // Strong match: the canonical openai auth-type value (Qwen Code's
      // OpenAI-compatible / Dashscope / Coding Plan path).
      const strong = methods.find((m) => m.id === "openai" || m.id === "use_openai");
      if (strong?.id) return strong.id;
      // Loose fallback: an api-key-ish method that is clearly NOT oauth.
      const loose = methods.find((m) => {
        const h = hay(m);
        return /api.?key|openai|dashscope|coding.?plan/.test(h) && !/oauth|sign.?in|log.?in/.test(h);
      });
      if (loose?.id) return loose.id;
    }
    return methods[0]?.id;
  }

  /** A clear sign-in error: points key-holders at a likely bad key, and everyone
   *  else at the two supported sign-in paths (interactive /auth, or an env key). */
  private authFailureMessage(): string {
    return qwenAuthKeyPresent()
      ? "Qwen Code CLI rejected the API key. Ensure DASHSCOPE_API_KEY / BAILIAN_CODING_PLAN_API_KEY / " +
          "OPENAI_API_KEY is valid (and OPENAI_BASE_URL points at the right endpoint for a Coding Plan key), " +
          "then Disconnect → Connect to retry."
      : "Qwen Code CLI is not authenticated. Run `qwen` once and complete /auth (Alibaba ModelStudio Coding " +
          "Plan or a provider API key — the Qwen OAuth free tier ended 2026-04-15), or set DASHSCOPE_API_KEY " +
          "in ~/.comfyui-mcp/.env, then Disconnect → Connect to retry.";
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
    // MODEL PRECEDENCE (P1): apply the panel-selected model BEFORE prepare() so the
    // FIRST spawn uses it (the model is spawn-pinned via `--model`; preparing first
    // would spawn the wrong model). PanelAgent.start() usually passes opts.model =
    // the CLAUDE panel model, which is NOT a valid Qwen model — so the configured
    // Qwen model (deps.model, from COMFYUI_MCP_QWEN_MODEL) wins; only honor
    // opts.model when it actually looks like a Qwen model (e.g. the user picked
    // one in the panel, which arrives as opts.model on a fresh spawn).
    if (opts.model && isQwenModel(opts.model)) this.model = opts.model;

    await this.prepare();
    if (!this.client) throw new Error("qwen --acp not initialized");
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
    let turnSeq = 0;
    for await (const turn of opts.channel) {
      // LIVE MODEL SWITCH (P1): PanelAgent treats setModel as live and does NOT
      // restart run() for a model-only change, so the persistent loop adopts it
      // here. The model is spawn-pinned, so a switch means respawning the CLI with
      // the new --model — which necessarily starts a FRESH session (a model swap
      // can't carry the old session forward). Done transparently before the turn;
      // we emit a new `session` event so PanelAgent persists the new id.
      if (this.spawnedModel !== this.model) {
        await this.respawnForModelChange();
        if (!this.client) throw new Error("qwen --acp respawn failed");
        sessionId = await this.ensureSession(this.client, cwd, null);
        yield {
          type: "session",
          sessionId,
          ...(this.model ? { model: this.model } : {}),
        };
      }
      yield* stampTurn(this.runTurn(this.client, turn, opts.onActivity), ++turnSeq);
    }
  }

  /** Tear down the live `qwen --acp` child (process-tree kill) and re-spawn it
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
    logger.info(`[qwen-backend] model switch → respawning qwen --acp with --model ${this.model ?? "(default)"}`);
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
    // async generator (identical pattern to gemini-backend).
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
        client.exitError ? msgOf(client.exitError) : "qwen --acp connection closed.",
      );
    });

    // FIRST-TURN PERSONA: ACP session/new has no instructions field, so the panel
    // system prompt is prepended to the first turn's prompt as a clearly-marked
    // system/context preamble (later turns send plain text). Mirrors gemini.
    let turnText = promptText(turn.text);
    if (this.needsSystemPreamble && this.deps.systemAppend) {
      turnText =
        `<system>\n${this.deps.systemAppend}\n</system>\n\n` +
        `The user's first message follows.\n\n${turnText}`;
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
          if (interrupted) emitTerminalError("qwen turn interrupted.");
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
    const client = this.client;
    if (!client || !this.sessionId) return;
    try {
      client.notify("session/cancel", { sessionId: this.sessionId });
    } catch (err) {
      logger.debug(`[qwen-backend] interrupt: ${msgOf(err)}`);
    }
  }

  /** Switch the model live. ACP pins the model at spawn (`--model`), so this can't
   *  reconfigure a running child — instead it marks the model dirty (this.model !=
   *  this.spawnedModel) and invalidates the cached spawn spec. The persistent run()
   *  loop then RESPAWNS the `qwen --acp` CLI with the new --model (and a fresh
   *  session) transparently before the next turn (see run()'s live-switch branch).
   *  If the backend hasn't spawned yet, the first prepare() simply uses the new
   *  model. Ignores non-Qwen ids (PanelAgent may pass the Claude panel model). */
  async setModel(model: string): Promise<void> {
    if (!isQwenModel(model)) return;
    this.model = model;
    this.spawnSpec = null; // next spawn rebuilds argv with the new --model
  }

  /**
   * Qwen model enumeration. ACP exposes no model catalog, so we surface a static
   * set (the current Qwen coding family); the panel picker degrades gracefully on
   * an empty list. No effort metadata (no discrete effort scale) → the panel
   * hides the effort dropdown.
   */
  async listModels(): Promise<ModelChoice[]> {
    return QWEN_MODELS;
  }

  /** Permanently dispose of the backend (AgentBackend.close): kill the qwen
   *  process TREE (Windows shell-fallback grandchild included), remove listeners,
   *  null the client. Idempotent + safe when never prepared. Mirrors codex (P0-1):
   *  interrupt() is a no-op when idle, so without this the child is orphaned. */
  async close(): Promise<void> {
    this.disposed = true; // tripwire FIRST (an in-flight prepare() bails) (P0-A)
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

// Expose the default model id for the orchestrator wiring (COMFYUI_MCP_QWEN_MODEL
// fallback) without duplicating the literal.
export { QWEN_DEFAULT_MODEL };
