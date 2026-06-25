// OpenAI Codex backend — the provider-specific adapter behind the AgentBackend
// port, driving Codex over the `codex app-server` JSON-RPC protocol (NOT
// `codex exec` string-scraping). This mirrors how our own `openai-codex` plugin
// drives the app-server (see the plugin's scripts/lib/app-server.mjs +
// codex.mjs); the protocol mapping is commented inline below.
//
// PanelAgent keeps all provider-agnostic orchestration (queue, turn-gate, bridge
// push, self-restart) and drives this backend via
// `for await (const ev of backend.run({...}))`. See
// docs/design/agent-backend-injection.md.
//
// PROTOCOL MAPPING (port → app-server):
//   - session            = a Codex THREAD (`thread/start` new | `thread/resume` by id)
//   - run() loop turn     = `turn/start` (one turn per neutral channel batch);
//                           images ride as `localImage` input items (file paths)
//   - assistant_delta     ← `item/agentMessage/delta` ({itemId, delta})
//   - assistant_delta(th) ← `item/reasoning/{text,summaryText}Delta` (thinking)
//   - assistant (commit)  ← `item/completed` for an `agentMessage` item
//   - result              ← `turn/completed` ({threadId, turn:{status}})
//   - error               ← `error` notification ({error:{message}})
//   - interrupt()         → `turn/interrupt` ({threadId, turnId})
//   - listModels()        ← `config/read` (or a sensible static fallback)
//
// FULL PARITY with Claude: the Codex backend now drives the live ComfyUI canvas
// AND the headless comfyui MCP, with the panel system prompt — everything Claude
// can do. Two MCP servers are declared to the app-server at launch via `-c`
// overrides:
//   - `comfyui` (stdio): the headless comfyui MCP (this build's dist/index.js),
//     mirroring the env the Claude path passes (COMFYUI_URL / COMFYUI_PATH / …).
//   - `panel`   (http) : the orchestrator-hosted loopback HTTP MCP that exposes
//     the SHARED panel_* live-graph tools, routed by tab id
//     (http://127.0.0.1:<port>/<tabId>). See panel-mcp-http.ts + panel-tools.ts.
// The app-server can only host CONFIG-DECLARED MCP servers (not an in-process SDK
// server), which is exactly why panel_* is exposed over HTTP for this backend.
// The panel system prompt is prepended to the FIRST turn (the app-server's
// thread/start has no instructions field).

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { logger } from "../utils/logger.js";
import {
  type AgentBackend,
  type AgentEvent,
  type BackendStartOptions,
  type ModelChoice,
  type NeutralTurn,
  CODEX_CAPABILITIES,
} from "./agent-backend.js";
import type { ImageRef } from "./panel-agent.js";

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Kill an entire process tree, not just the direct child. On the Windows
 * PATH/shell fallback the direct child is a cmd.exe/shim whose grandchild is the
 * real `codex` node process — killing only the shell leaves the tree alive. Use
 * `taskkill /T /F` (mirrors the reference client's terminateProcessTree). On
 * POSIX, signal the process group (negative pid) so a shell + its child both die,
 * falling back to the single pid. Best-effort + swallows errors: it runs during
 * teardown and must never throw into the host process.
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

// ---- minimal JSON-RPC-over-stdio client for `codex app-server` ----
// A self-contained line-framed JSON-RPC client, modeled on the plugin's
// SpawnedCodexAppServerClient. We deliberately vendor this tiny client rather
// than depend on the plugin's internals: it only needs request/notify + a single
// notification handler, and keeping it here makes the backend self-contained.

interface RpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

type NotificationHandler = (msg: RpcMessage) => void;

class AppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; method: string }
  >();
  private nextId = 1;
  private closed = false;
  private exitResolved = false;
  /** The error that ended the connection (null = clean exit). Readable so a turn
   *  can surface a meaningful message when the child dies mid-turn. */
  exitError: Error | null = null;
  stderr = "";
  notificationHandler: NotificationHandler | null = null;
  private resolveExit!: () => void;
  /** Resolves when the app-server process exits or errors (P0-2): runTurn() races
   *  its per-turn drain against this so a child that dies after turn/start resolved
   *  but before turn/completed doesn't deadlock the turn forever. */
  readonly exitPromise: Promise<void>;

  constructor(
    private readonly bin: string,
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    // Extra `-c key=value` config overrides appended after `app-server` (used to
    // declare the comfyui + panel MCP servers — full Codex/Claude tool parity).
    private readonly extraArgs: string[] = [],
  ) {
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  /** Spawn `codex app-server`, perform the initialize handshake, and return. */
  async initialize(clientInfo: { title: string; name: string; version: string }): Promise<void> {
    // On Windows the bundled bin is a node launcher script; spawn it via the
    // current node so we don't depend on a `codex` shim being on PATH. When `bin`
    // is a plain "codex" (PATH fallback) we still spawn it directly.
    const isJs = /\.(c|m)?js$/i.test(this.bin);
    const cmd = isJs ? process.execPath : this.bin;
    // `-c` overrides go AFTER the `app-server` subcommand (they're app-server
    // flags). They declare the comfyui (stdio) + panel (http) MCP servers.
    const baseArgs = isJs ? [this.bin, "app-server"] : ["app-server"];
    const args = [...baseArgs, ...this.extraArgs];
    // When falling back to a `codex` on PATH on Windows, the resolvable entry is a
    // `.cmd`/`.ps1` shim — spawn without a shell can't find it (ENOENT). Use a
    // shell in that case (mirrors the plugin's client). The bundled-dep lane runs
    // the `.js` launcher via node directly, so it never needs a shell.
    const useShell = !isJs && process.platform === "win32";
    this.proc = spawn(cmd, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: useShell,
      // On POSIX, put the child in its OWN process group so close() can kill the
      // whole tree (shell + grandchild) with a single negative-pid signal. On
      // Windows we use taskkill /T instead, so detached isn't needed there.
      detached: process.platform !== "win32",
    }) as ChildProcessWithoutNullStreams;

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    // Swallow stream errors on the child's pipes. When the app-server child dies
    // mid-turn, the NEXT write to stdin (or a read on stdout) raises an async
    // 'error' event (EPIPE on Windows) — with no listener Node treats it as an
    // uncaughtException and the orchestrator's handler would exit the whole
    // process. Route them through handleExit instead so the turn rejects cleanly
    // (P0-2) and the host survives. (P0-2)
    this.proc.stdin.on("error", (error) => this.handleExit(error));
    this.proc.stdout.on("error", (error) => this.handleExit(error));
    this.proc.on("error", (error) => this.handleExit(error));
    this.proc.on("exit", (code, signal) => {
      const detail =
        code === 0
          ? null
          : new Error(
              `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${this.stderr ? ` ${this.stderr.trim().split(/\r?\n/).slice(-2).join(" ")}` : ""}`,
            );
      this.handleExit(detail);
    });

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.handleLine(line));

    // JSON-RPC handshake: initialize (request) then initialized (notification).
    // We opt IN to the delta notifications (by NOT opting out) so we can stream
    // assistant + reasoning text token-by-token; the plugin opts them out because
    // it only captures final messages.
    await this.request("initialize", {
      clientInfo,
      capabilities: { experimentalApi: false, optOutNotificationMethods: [] },
    });
    this.notify("initialized", {});
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("codex app-server client is closed."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown = {}): void {
    if (this.closed) return;
    // Fire-and-forget: a write failure (dead child) must not throw into the caller
    // — handleExit already records it and rejects pending requests.
    try {
      this.send({ method, params });
    } catch {
      // connection gone; pending requests already rejected via handleExit
    }
  }

  private send(message: RpcMessage): void {
    const stdin = this.proc?.stdin;
    // Stream gone / destroyed (child died) — surface as a connection exit so any
    // pending request rejects, rather than throwing an unhandled error from a
    // fire-and-forget notify() (P0-2).
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      this.handleExit(this.exitError ?? new Error("codex app-server stdin is not available."));
      throw this.exitError ?? new Error("codex app-server stdin is not available.");
    }
    try {
      stdin.write(`${JSON.stringify(message)}\n`);
    } catch (err) {
      // Synchronous write failure (EPIPE) on a child that just died.
      this.handleExit(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  /**
   * The auto-approve RESULT for a server→client approval/permission/elicitation
   * request, or null if the request isn't an approval we should auto-grant.
   *
   * Decision shapes differ per request method (from the app-server protocol):
   *   - execCommandApproval / applyPatchApproval → { decision: ReviewDecision }
   *     where ReviewDecision = "approved" | "denied" | …
   *   - item/commandExecution/requestApproval, item/fileChange/requestApproval,
   *     item/permissions/requestApproval → { decision: "accept" | … }
   *   - mcpServer/elicitation/request → an MCP elicitation result
   *     ({ action: "accept", content: {} }).
   * We grant the affirmative for each so the headless background agent (same
   * isolation posture as Claude's bypassPermissions) is never blocked.
   */
  private autoApproveDecision(method: string): Record<string, unknown> | null {
    switch (method) {
      case "execCommandApproval":
      case "applyPatchApproval":
        return { decision: "approved" };
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval":
        return { decision: "accept" };
      case "mcpServer/elicitation/request":
        return { action: "accept", content: {} };
      default:
        return null;
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch (error) {
      this.handleExit(new Error(`Failed to parse codex app-server JSONL: ${msgOf(error)}`));
      return;
    }
    // Server→client request. The app-server asks the client to approve commands,
    // file edits, MCP tool elicitations, and permission requests. The panel agent
    // is an ISOLATED background agent (same posture as the Claude path's
    // bypassPermissions), so we AUTO-APPROVE these to keep the live-graph work
    // flowing — otherwise a panel_* MCP tool call hangs on an approval prompt the
    // headless orchestrator can't surface. Anything we don't recognize still gets
    // a method-not-found so the protocol keeps moving.
    if (message.id !== undefined && message.method) {
      const decision = this.autoApproveDecision(message.method);
      if (decision) {
        logger.debug(`[codex-backend] auto-approving server request ${message.method}`);
        this.send({ id: message.id, result: decision });
      } else {
        logger.debug(`[codex-backend] unsupported server request ${message.method} — replying method-not-found`);
        this.send({ id: message.id, error: { code: -32601, message: `Unsupported server request: ${message.method}` } });
      }
      return;
    }
    // Response to one of our requests.
    if (message.id !== undefined) {
      const p = this.pending.get(message.id);
      if (!p) return;
      this.pending.delete(message.id);
      if (message.error) p.reject(new Error(message.error.message ?? `codex app-server ${p.method} failed.`));
      else p.resolve(message.result ?? {});
      return;
    }
    // Notification.
    if (message.method) this.notificationHandler?.(message);
  }

  private handleExit(error: Error | null): void {
    if (this.exitResolved) return;
    this.exitResolved = true;
    this.exitError = error;
    for (const p of this.pending.values()) p.reject(error ?? new Error("codex app-server connection closed."));
    this.pending.clear();
    this.resolveExit();
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.exitPromise;
      return;
    }
    this.closed = true;
    // Drop the notification handler so a late notification can't re-enter a
    // torn-down turn during shutdown.
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
      // the real codex node process, so proc.kill() alone would orphan it.
      setTimeout(() => {
        if (proc.exitCode === null) killProcessTree(proc.pid);
      }, 50).unref?.();
    }
    await this.exitPromise;
    this.proc = null;
  }
}

// ---- model fallback ----
// config/read does not enumerate a model CATALOG (it reports the active provider
// + model), so when we can't derive a list we fall back to the current Codex
// model family. The panel picker degrades gracefully on an empty list.
const CODEX_FALLBACK_MODELS: ModelChoice[] = [
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.5-codex", label: "GPT-5.5 Codex" },
];

/** Does this id look like an OpenAI/Codex model (vs. a Claude panel model)? Used
 *  to ignore the Claude panel model PanelAgent unconditionally passes as
 *  opts.model, so the configured Codex model wins (P1-1). Anthropic ids start with
 *  "claude"/"anthropic"; Codex ids are gpt-, o-series, codex-, or chatgpt-. */
function isCodexModel(id: string): boolean {
  const m = id.toLowerCase();
  if (m.startsWith("claude") || m.startsWith("anthropic")) return false;
  return /^(gpt-|o\d|codex|chatgpt)/.test(m) || m.includes("codex");
}

// ---- reasoning effort mapping ----
// Codex's reasoning-effort scale differs from Claude's: Codex accepts
// none|minimal|low|medium|high|xhigh (the app-server `turn/start` `effort` field;
// see the reference openai-codex plugin's codex.mjs), while the panel/Claude
// scale is low|medium|high|xhigh|max. The shared levels map 1:1; the only
// off-scale source value is Claude "max", which has no Codex equivalent and maps
// to the nearest valid level (xhigh). Unknown/empty → null (app-server default).
const CODEX_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
function toCodexEffort(effort: string | undefined): string | null {
  if (!effort) return null;
  const e = effort.toLowerCase();
  if ((CODEX_EFFORTS as readonly string[]).includes(e)) return e;
  if (e === "max") return "xhigh"; // Claude's top level → Codex's nearest valid
  return null; // unknown level → let the app-server pick its default
}

/**
 * Derive a display name for a Codex app-server `item` (from item/started and
 * item/completed) when it represents a TOOL-like action — an MCP tool call, a
 * shell command, a file change, a web search, etc. Returns null for non-tool
 * items (agentMessage / reasoning), which the delta/commit paths already handle,
 * so the caller skips emitting a tool_call for them. Best-effort + defensive: the
 * exact item shape varies by app-server version, so we probe the common name
 * fields and fall back to the item `type`.
 */
export function toolNameOf(item: Record<string, unknown> | undefined): string | null {
  if (!item || typeof item !== "object") return null;
  const type = typeof item.type === "string" ? item.type : undefined;
  // These item types are text/reasoning, not tools — they're surfaced via the
  // assistant_delta / assistant commit paths, so don't double-report them.
  if (type === "agentMessage" || type === "reasoning") return null;
  // MCP tool calls carry a tool name (and often a server) — prefer the most
  // specific identifier available, then fall back to the item type.
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = item[k];
      if (typeof v === "string" && v) return v;
    }
    return undefined;
  };
  const server = pick("server", "serverName");
  const tool = pick("tool", "toolName", "name", "command");
  if (tool) return server ? `${server}.${tool}` : tool;
  // No explicit name field — use the item type as the label (commandExecution,
  // fileChange, webSearch, …) so the panel at least shows that a tool ran.
  return type ?? null;
}

/** A declared MCP server for the Codex app-server. Either a stdio command (the
 *  headless comfyui MCP) or a streamable-HTTP url (the panel_* loopback server). */
export type CodexMcpServerSpec =
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { transport: "http"; url: string };

/** Provider config the Codex backend needs. A small subset of PanelAgentDeps. */
export interface CodexBackendDeps {
  /** Working directory for the Codex thread (defaults to opts.cwd / process cwd). */
  cwd?: string;
  /** Default model for new threads (e.g. gpt-5.4-codex). */
  model?: string;
  /**
   * Base URL of the ComfyUI instance, for fetching image bytes (/view). When set,
   * NeutralTurn image refs are fetched and written to temp files, then delivered
   * to the turn as `localImage` input items (vision parity with the Claude path).
   */
  comfyuiUrl?: string;
  /**
   * MCP servers to declare to `codex app-server` via `-c mcp_servers.<name>.*`
   * overrides at launch — gives Codex the same tool surface as Claude (the
   * headless `comfyui` stdio MCP + the `panel` HTTP MCP for live-graph tools).
   */
  mcpServers?: Record<string, CodexMcpServerSpec>;
  /**
   * Panel system prompt (persona). The app-server's thread/start has no
   * instructions field, so this is PREPENDED to the first turn's input as a
   * clearly-marked system/context preamble; later turns send plain text.
   */
  systemAppend?: string;
}

/**
 * Build the `-c key=value` CLI overrides that declare the given MCP servers to
 * `codex app-server`. Values are TOML literals: strings are JSON-quoted, arrays
 * are JSON arrays (valid TOML). Mirrors `codex mcp add` / the config.toml format.
 */
export function buildMcpConfigArgs(servers: Record<string, CodexMcpServerSpec>): string[] {
  const args: string[] = [];
  const lit = (s: string) => JSON.stringify(s); // safe TOML string literal
  for (const [name, spec] of Object.entries(servers)) {
    if (spec.transport === "stdio") {
      args.push("-c", `mcp_servers.${name}.command=${lit(spec.command)}`);
      if (spec.args && spec.args.length) {
        args.push("-c", `mcp_servers.${name}.args=${JSON.stringify(spec.args)}`);
      }
      for (const [k, v] of Object.entries(spec.env ?? {})) {
        args.push("-c", `mcp_servers.${name}.env.${k}=${lit(v)}`);
      }
    } else {
      // Streamable HTTP MCP server — `url` is what `codex mcp add --url` sets.
      args.push("-c", `mcp_servers.${name}.url=${lit(spec.url)}`);
    }
  }
  return args;
}

/**
 * The Codex app-server adapter. One instance per PanelAgent; it holds the live
 * app-server client + current thread/turn ids and re-opens on each `run()`.
 */
export class CodexBackend implements AgentBackend {
  readonly id = "codex" as const;
  readonly capabilities = CODEX_CAPABILITIES;
  private deps: CodexBackendDeps;
  private client: AppServerClient | null = null;
  /** The client currently being spun up by an in-flight prepare(), tracked so a
   *  concurrent close() can tear it down even before it's published to
   *  this.client (P0-A: close() racing prepare() must never leak the child). */
  private preparingClient: AppServerClient | null = null;
  /** Set once close() runs — a hard tripwire so an in-flight prepare() that wakes
   *  up after close() disposes its local client instead of publishing it (P0-A). */
  private disposed = false;
  /** Cached resolved path to the codex binary/launcher (set in prepare()). */
  private bin: string | null = null;
  /** The live thread + turn ids — used for `turn/interrupt`. */
  private threadId: string | null = null;
  private turnId: string | null = null;
  /** The model requested for new turns (mutable for a future live setModel). */
  private model: string | undefined;
  /** The Codex reasoning effort for new turns, already mapped to a valid Codex
   *  level (null = let the app-server choose). Captured from run(opts.effort). */
  private effort: string | null = null;
  /** True until the panel system prompt has been prepended to a turn. The
   *  app-server's thread/start has no instructions field, so the persona rides on
   *  the FIRST turn's input; reset whenever a NEW thread starts (run()). */
  private needsSystemPreamble = false;
  /** Temp image files written for delivered turn images (the app-server's
   *  `localImage` input item takes a PATH, so /view bytes are spilled to disk).
   *  Tracked so each turn cleans up its own files, and close() sweeps any
   *  stragglers. */
  private tempImageFiles = new Set<string>();

  constructor(deps: CodexBackendDeps = {}) {
    this.deps = deps;
    this.model = deps.model;
  }

  /**
   * Resolve the codex binary: prefer the bundled `@openai/codex` launcher (via
   * require.resolve of its package bin) so no separate install is needed; fall
   * back to a `codex` on PATH. Throws a clear message if neither is available.
   */
  private resolveBin(): string {
    if (this.bin) return this.bin;
    try {
      const require = createRequire(import.meta.url);
      // The package exposes bin/codex.js; resolve its package.json then derive the
      // bin path relative to the package dir (works regardless of OS separators).
      const pkgPath = require.resolve("@openai/codex/package.json");
      const pkg = require("@openai/codex/package.json") as { bin?: Record<string, string> | string };
      const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.codex;
      if (binRel) {
        const sep = pkgPath.includes("\\") ? "\\" : "/";
        const pkgDir = pkgPath.replace(/[\\/]package\.json$/, "");
        this.bin = `${pkgDir}${sep}${binRel.replace(/^\.[\\/]/, "")}`;
      }
    } catch {
      // bundled package not installed — fall through to PATH.
    }
    if (!this.bin) this.bin = "codex"; // PATH fallback (a `codex` on PATH)
    return this.bin;
  }

  /**
   * Fetch a ComfyUI image (/view) and spill the bytes to a temp file, returning
   * its absolute path — or null on any failure (the text reference still names the
   * image as a fallback). The app-server `turn/start` `localImage` input item takes
   * a FILE PATH (mirrors the codex CLI `-i, --image <FILE>`), so unlike Claude
   * (inline base64) we must write the bytes to disk. Mirrors
   * ClaudeBackend.fetchImageBlock's source/size guards. Each written path is
   * tracked in tempImageFiles for per-turn + close() cleanup.
   */
  private async fetchImageFile(ref: ImageRef): Promise<string | null> {
    if (!this.deps.comfyuiUrl || !ref?.filename) return null;
    try {
      const u = new URL("/view", this.deps.comfyuiUrl);
      u.searchParams.set("filename", ref.filename);
      u.searchParams.set("type", ref.type || "input");
      if (ref.subfolder) u.searchParams.set("subfolder", ref.subfolder);
      const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const mt = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 12 * 1024 * 1024) return null; // keep context sane (parity with Claude)
      // Preserve a recognizable extension so the model/app-server treat it as the
      // right image type; default to .png (ComfyUI outputs are PNG by default).
      const extFromMime: Record<string, string> = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/gif": ".gif",
        "image/webp": ".webp",
      };
      // Recognized content-type → its extension; otherwise only trust the source
      // filename extension if it's a known image type, else default to .png (don't
      // preserve an arbitrary suffix — parity with Claude mapping unknowns to png).
      const allowedExt = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
      const fileExt = path.extname(ref.filename).toLowerCase();
      const ext = extFromMime[mt] ?? (allowedExt.has(fileExt) ? fileExt : ".png");
      const file = path.join(
        os.tmpdir(),
        `comfyui-codex-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`,
      );
      await fsp.writeFile(file, buf);
      this.tempImageFiles.add(file);
      return file;
    } catch {
      return null;
    }
  }

  /** Delete the given temp image files (best-effort) and drop them from tracking. */
  private async cleanupTempImages(files: Iterable<string>): Promise<void> {
    for (const f of files) {
      this.tempImageFiles.delete(f);
      try {
        await fsp.unlink(f);
      } catch {
        // already gone / never created — best-effort
      }
    }
  }

  /**
   * Preflight: resolve + spawn `codex app-server`, perform the JSON-RPC
   * handshake, and verify the account is logged in (ChatGPT login / CODEX_API_KEY
   * — keyless, like the Claude OAuth lane). Fails fast with a clear reject so a
   * missing binary or signed-out state surfaces immediately instead of being
   * retried as a dropped session. Idempotent — reuses the live client.
   */
  async prepare(): Promise<void> {
    if (this.disposed) throw new Error("codex backend is closed.");
    if (this.client) return;
    const bin = this.resolveBin();
    const cwd = this.deps.cwd ?? process.cwd();
    // Declare the comfyui + panel MCP servers as `-c` overrides so Codex has the
    // same tool surface as Claude (full parity).
    const extraArgs = this.deps.mcpServers ? buildMcpConfigArgs(this.deps.mcpServers) : [];
    const client = new AppServerClient(bin, cwd, process.env, extraArgs);
    // Publish the in-flight client BEFORE the startup awaits so a concurrent
    // close() can find and kill it instead of seeing this.client === null and
    // returning early — which would orphan the spawning app-server child (P0-A).
    this.preparingClient = client;
    // After EVERY await below, re-check disposed: close() may have run during the
    // await and torn down our client out from under us. If so, dispose the local
    // client and bail without publishing it.
    const abortIfDisposed = async (): Promise<void> => {
      if (!this.disposed) return;
      if (this.preparingClient === client) this.preparingClient = null;
      await client.close().catch(() => {});
      throw new Error("codex backend was closed during prepare().");
    };
    try {
      try {
        await client.initialize({ title: "comfyui-mcp panel", name: "comfyui-mcp", version: "0.16.0" });
      } catch (err) {
        await client.close().catch(() => {});
        throw new Error(
          `Could not start the Codex app-server (codex backend). Install the optional dependency with: npm i @openai/codex (or ensure \`codex\` is on PATH). Details: ${msgOf(err)}`,
        );
      }
      await abortIfDisposed();
      // Auth check: account/read tells us whether a ChatGPT login or API key is
      // present. Mirror the plugin's app-server auth probe.
      try {
        const account = await client.request<{
          account?: { type?: string } | null;
          requiresOpenaiAuth?: boolean;
        }>("account/read", { refreshToken: false });
        const loggedIn = !!account?.account || account?.requiresOpenaiAuth === false;
        if (!loggedIn) {
          await client.close().catch(() => {});
          throw new Error(
            "Codex is not logged in. Run `codex login` (ChatGPT login) or set CODEX_API_KEY, then reconnect.",
          );
        }
      } catch (err) {
        await client.close().catch(() => {});
        throw err instanceof Error ? err : new Error(msgOf(err));
      }
      await abortIfDisposed();
      this.client = client;
      logger.info("[codex-backend] app-server ready (logged in)");
    } finally {
      // Either we published it onto this.client, or an error/abort path already
      // closed it — in all cases stop tracking it as in-flight.
      if (this.preparingClient === client) this.preparingClient = null;
    }
  }

  /**
   * Open/continue a Codex thread and yield canonical AgentEvents. The user
   * channel (PanelAgent's gated queue) is consumed ONE turn at a time: each
   * neutral batch becomes a `turn/start`, whose streamed notifications are
   * normalized to AgentEvents, and only after the turn completes do we read the
   * next batch (the channel async-iteration IS the turn-gate).
   */
  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    await this.prepare();
    const client = this.client;
    if (!client) throw new Error("codex app-server not initialized");
    const cwd = opts.cwd ?? this.deps.cwd ?? process.cwd();
    // MODEL PRECEDENCE (P1-1): PanelAgent.start() always passes opts.model = the
    // CLAUDE panel model (e.g. claude-opus-4-8), which is NOT a valid Codex model.
    // The Codex model configured at construction (deps.model, from
    // COMFYUI_MCP_CODEX_MODEL) must win. Only honor opts.model if it actually looks
    // like a Codex model (so a future Codex-aware picker can still switch live);
    // otherwise ignore it and keep the configured Codex model (or the account
    // default when neither is set — model:null lets the app-server choose).
    if (opts.model && isCodexModel(opts.model)) this.model = opts.model;
    // Map the panel/Claude effort scale onto Codex's and apply it to every turn in
    // this session (the panel restarts run() on an effort change, so capturing it
    // here is enough — each new turn reads this.effort). Without this the session
    // ran at the app-server default regardless of the picker (the effort was
    // previously hardcoded to null on turn/start).
    this.effort = toCodexEffort(opts.effort);

    // forkAtAnchor is false (CODEX_CAPABILITIES) → ignore opts.rewindAnchor; we
    // only do whole-thread resume.
    const resumeId = opts.resume ?? opts.sessionId ?? null;
    let threadModel: string | undefined;
    if (resumeId) {
      // thread/resume continues an existing conversation by id.
      const res = await client.request<{ thread: { id: string }; model?: string }>("thread/resume", {
        threadId: resumeId,
        cwd,
        model: this.model ?? null,
        approvalPolicy: "never",
        sandbox: "workspace-write",
      });
      this.threadId = res.thread.id;
      threadModel = res.model;
      // A resumed thread already received the persona on its original first turn —
      // don't repeat it.
      this.needsSystemPreamble = false;
    } else {
      // thread/start opens a fresh conversation.
      const res = await client.request<{ thread: { id: string }; model?: string }>("thread/start", {
        cwd,
        model: this.model ?? null,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        ephemeral: false,
      });
      this.threadId = res.thread.id;
      threadModel = res.model;
      // Fresh thread → prepend the panel persona to the first turn's input.
      this.needsSystemPreamble = !!this.deps.systemAppend;
    }
    // The thread id is our session id (PanelAgent persists it for resume).
    yield {
      type: "session",
      sessionId: this.threadId,
      ...(threadModel ? { model: threadModel } : {}),
    };

    // Process the neutral channel one turn at a time. onActivity is the LIVENESS
    // signal — every raw app-server notification for the active turn re-arms
    // PanelAgent's idle watchdog so a long, quiet generation doesn't falsely trip.
    for await (const turn of opts.channel) {
      yield* this.runTurn(client, turn, opts.onActivity);
    }
  }

  /** Run ONE turn: turn/start + stream its notifications → AgentEvents, resolving
   *  when `turn/completed`/`error` for this thread+turn arrives, OR when the
   *  app-server child exits mid-turn (P0-2 — never deadlock). Notifications are
   *  buffered until the turnId is known and then filtered by belongsToTurn (P1-3)
   *  so a stale/interleaved same-thread notification can't complete the wrong turn. */
  private async *runTurn(
    client: AppServerClient,
    turn: NeutralTurn,
    onActivity?: () => void,
  ): AsyncGenerator<AgentEvent> {
    const threadId = this.threadId!;
    // Event queue bridging the push-based notification handler to this pull-based
    // async generator. The handler enqueues normalized AgentEvents; we drain.
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
    // EVERY terminal path of a turn MUST emit exactly one `result` so PanelAgent's
    // turn-gate advances (it only calls completeTurn() on a result event; a missing
    // result parks its channel forever — panel-agent.ts ~438). This single
    // idempotent helper guarantees that: it emits an `error` event + a single
    // `{type:"result", ok:false}` and finishes, and is a no-op if a result was
    // already emitted (so the error notification, the exit watcher, and the
    // turn/start rejection can all call it without double-finishing) (P0-B).
    let finishedResult = false;
    const emitTerminalError = (message: string) => {
      if (finishedResult) return;
      finishedResult = true;
      closeStream();
      push({ type: "error", message });
      push({ type: "result", ok: false, subtype: "error" });
      finish();
    };

    // ---- turn-id state machine (mirrors the reference captureTurn) ----
    // The turnId isn't known until the turn/start response resolves, and some
    // notifications can arrive BEFORE it. Buffer those, then replay only the ones
    // that belong to this turn once we know the id. After that, filter live.
    let activeTurnId: string | null = null;
    let turnIdKnown = false;
    const buffered: RpcMessage[] = [];
    const belongsToTurn = (msg: RpcMessage): boolean => {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const msgThreadId = params.threadId as string | undefined;
      // Wrong thread → not ours.
      if (msgThreadId && msgThreadId !== threadId) return false;
      const t = params.turn as { id?: string } | undefined;
      const msgTurnId = (params.turnId as string | undefined) ?? t?.id ?? null;
      // No active turn id yet (shouldn't happen post-buffer) or the notification
      // carries no turn id → accept; otherwise require an exact match.
      return activeTurnId === null || msgTurnId === null || msgTurnId === activeTurnId;
    };

    // Track the streamed item id so deltas + the final commit share one bubble id
    // (the panel reconciles by id, like the Claude stream path). Reasoning and
    // reply text each open/close their own stream (P2-1: reasoning was previously
    // emitted without a stream_start, so the panel dropped early thinking deltas).
    let streamOpen = false;
    let streamKind: "text" | "thinking" | null = null;
    let interrupted = false;

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

    // Normalize ONE notification (already confirmed to belong to this turn) into
    // canonical AgentEvents. Pulled out so it can be applied to both live and
    // buffered (replayed) notifications.
    const apply = (msg: RpcMessage) => {
      // Once ANY terminal result has fired (success turn/completed OR a terminal
      // error via emitTerminalError), the turn is done — drop every later
      // notification so a racing/buffered turn/completed can't push a SECOND result
      // (double-completing PanelAgent's gate) or enqueue deltas into a closing
      // iterator. This is the "exactly one result" invariant (P0-B).
      if (finishedResult) return;
      const params = (msg.params ?? {}) as Record<string, unknown>;
      switch (msg.method) {
        case "turn/started": {
          const t = params.turn as { id?: string } | undefined;
          if (t?.id) {
            this.turnId = t.id;
            if (!activeTurnId) activeTurnId = t.id;
          }
          break;
        }
        case "item/agentMessage/delta": {
          const delta = params.delta as string | undefined;
          const itemId = params.itemId as string | undefined;
          if (typeof delta === "string" && delta) {
            openStream(itemId ?? null, "text");
            push({ type: "assistant_delta", text: delta });
          }
          break;
        }
        case "item/reasoning/textDelta":
        case "item/reasoning/summaryTextDelta": {
          // Extended-thinking streaming (raw reasoning + the model's summary).
          // Open a reasoning stream on the FIRST delta (P2-1) so PanelAgent — which
          // drops assistant_delta when no stream is open — renders early thinking.
          const delta = params.delta as string | undefined;
          const itemId = params.itemId as string | undefined;
          if (typeof delta === "string" && delta) {
            openStream(itemId ?? null, "thinking");
            push({ type: "assistant_delta", text: delta, thinking: true });
          }
          break;
        }
        case "item/started": {
          // A non-message item began (a tool/command/MCP call or file change). Emit
          // a tool_call(start) AgentEvent so the panel has TOOL VISIBILITY (the
          // documented P2 gap — Codex previously surfaced no tool activity at all)
          // and the watchdog re-arms on a translated event too. agentMessage /
          // reasoning items aren't "tools" — they're handled by the delta/commit
          // paths above — so skip them here.
          const item = params.item as Record<string, unknown> | undefined;
          const name = toolNameOf(item);
          if (name) push({ type: "tool_call", name, phase: "start", detail: item });
          break;
        }
        case "item/completed": {
          // The authoritative commit for a finished item. Close any open stream
          // (reasoning OR reply) then emit the canonical event: `assistant` for an
          // agentMessage, or tool_call(end) for a finished tool/command/MCP item.
          const item = params.item as Record<string, unknown> | undefined;
          const itemType = item?.type as string | undefined;
          closeStream();
          if (itemType === "agentMessage") {
            const text = ((item?.text as string | undefined) ?? "").trim();
            const id = item?.id as string | undefined;
            push({
              type: "assistant",
              text,
              ...(id ? { id } : {}),
              // No per-turn rewind anchor for Codex (forkAtAnchor=false) — omit uuid.
            });
          } else {
            const name = toolNameOf(item);
            if (name) push({ type: "tool_call", name, phase: "end", detail: item });
          }
          break;
        }
        case "error": {
          // A terminal `error` notification ends the turn: emit it AND finish, so a
          // turn that errors out (no following turn/completed) doesn't hang (P0-2).
          // Routed through the single idempotent terminal-error helper so it can
          // never double-emit with the exit watcher / turn-start rejection (P0-B).
          const e = (params.error ?? {}) as { message?: string };
          emitTerminalError(e.message ?? "Codex error");
          break;
        }
        case "turn/completed": {
          closeStream();
          const t = params.turn as { status?: string } | undefined;
          // Mark a result emitted so a racing terminal-error path stays a no-op.
          finishedResult = true;
          push({ type: "result", ok: t?.status === "completed", ...(t?.status ? { subtype: t.status } : {}) });
          finish();
          break;
        }
        default:
          break;
      }
    };

    const prev = client.notificationHandler;
    client.notificationHandler = (msg: RpcMessage) => {
      // LIVENESS (watchdog re-arm): ANY notification received while this turn is
      // in flight is a sign the app-server is alive and working — fire onActivity
      // BEFORE buffering/filtering/translating, so even raw notifications that
      // produce NO AgentEvent (a long MCP tool call running a multi-minute ComfyUI
      // generation: item/started, item/updated, tool/exec progress, …) keep
      // PanelAgent's idle watchdog armed. Without this a HEALTHY long generation
      // looks idle and the watchdog falsely trips. A genuine zero-event freeze
      // (the app-server emits nothing at all) never reaches here, so the real
      // freeze-catch is preserved. Cheap + best-effort — never let it throw into
      // the JSON-RPC reader.
      try {
        onActivity?.();
      } catch {
        // a watchdog bump must never break the protocol reader
      }
      // Until the turnId is known, buffer everything (we can't yet tell which
      // turn a notification belongs to). Replayed after turn/start resolves.
      if (!turnIdKnown) {
        buffered.push(msg);
        return;
      }
      if (!belongsToTurn(msg)) {
        prev?.(msg); // stale / other-turn / other-thread → pass through
        return;
      }
      apply(msg);
    };

    // Watch for the app-server child dying mid-turn: reject/finish the turn so the
    // local drain below is woken instead of waiting forever (P0-2). Crucially this
    // ALWAYS routes through emitTerminalError so even a child that dies while
    // turn/start is still pending leaves the turn with a terminal `result` — the
    // turn-start .catch() running first (rejecting the pending request) no longer
    // lets this watcher finish() without a result and hang the gate (P0-B).
    void client.exitPromise.then(() => {
      if (done) return;
      // emitTerminalError is a no-op if a result already fired, so it's safe to
      // call alongside the turn-start .catch() (which may run first when the child
      // dies while turn/start is pending) — it guarantees the turn still ends with
      // exactly one terminal result and never hangs the gate (P0-B).
      emitTerminalError(client.exitError ? msgOf(client.exitError) : "codex app-server connection closed.");
    });

    // FIRST-TURN PERSONA: the app-server has no thread-level instructions field,
    // so the panel system prompt is prepended to the first turn's input as a
    // clearly-marked system/context preamble (later turns send plain text).
    let turnText = turn.text;
    if (this.needsSystemPreamble && this.deps.systemAppend) {
      turnText =
        `<system>\n${this.deps.systemAppend}\n</system>\n\n` +
        `The user's first message follows.\n\n${turn.text}`;
      this.needsSystemPreamble = false;
    }

    // IMAGE DELIVERY (vision parity with Claude): fetch each ComfyUI image ref's
    // bytes from /view, spill to a temp file, and add a `localImage` input item
    // (which takes a FILE PATH — the app-server's path-based image variant, mirror
    // of the codex CLI `-i, --image <FILE>`). The text item stays first so the
    // prompt context is preserved; images follow. Falls back to text-only when
    // there are no images (or none resolve). The files written for THIS turn are
    // tracked locally so the finally block cleans them up after the turn ends.
    const turnInput: Array<Record<string, unknown>> = [
      { type: "text", text: turnText, text_elements: [] },
    ];
    const turnTempFiles: string[] = [];
    for (const ref of turn.images ?? []) {
      const file = await this.fetchImageFile(ref);
      if (file) {
        turnTempFiles.push(file);
        turnInput.push({ type: "localImage", path: file });
      }
    }

    try {
      // turn/start delivers the user text plus any resolved image input items.
      client
        .request<{ turn?: { id?: string } }>("turn/start", {
          threadId,
          input: turnInput,
          model: this.model ?? null,
          // Forward the session's mapped Codex effort (null = app-server default).
          effort: this.effort,
          outputSchema: null,
        })
        .then((res) => {
          // Set the active turn id, flush the buffer (replaying only this turn's
          // notifications), then switch the handler to live filtering.
          if (res.turn?.id) {
            this.turnId = res.turn.id;
            activeTurnId = res.turn.id;
          }
          turnIdKnown = true;
          for (const msg of buffered) {
            if (belongsToTurn(msg)) apply(msg);
            else prev?.(msg);
          }
          buffered.length = 0;
        })
        .catch((err) => {
          // A failed turn/start (or an interrupt rejecting it) ends the turn. Also
          // mark the id known so any post-failure notifications stop buffering.
          turnIdKnown = true;
          // CRITICAL (P0-B): when the child dies mid-turn, handleExit() rejects this
          // pending request BEFORE resolving exitPromise — so this .catch() runs
          // first. It MUST end the turn with a terminal `result` (not just an
          // `error` + bare finish()), or the exit watcher then sees done===true and
          // returns without one, hanging PanelAgent's gate forever. Route through
          // the idempotent helper so it always emits exactly one result.
          if (interrupted) {
            // Deliberate teardown (interrupt restored/closed the turn): still end
            // with a result so the gate advances, but no user-facing error.
            emitTerminalError("codex turn interrupted.");
          } else {
            emitTerminalError(msgOf(err));
          }
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
      // Flush any trailing events queued between the last drain and done.
      while (queue.length) yield queue.shift()!;
    } finally {
      // Mark interrupted so a late turn/start rejection / exit doesn't surface as
      // a spurious error after we've already torn the turn down.
      interrupted = true;
      // Restore the prior handler ONLY if it's still ours (close() may have nulled
      // it during shutdown — don't resurrect a stale handler onto a dead client).
      if (client.notificationHandler && !client.exitError) client.notificationHandler = prev ?? null;
      this.turnId = null;
      // Sweep this turn's temp image files now that the app-server has consumed
      // them (the bytes were read at turn/start). Best-effort + non-blocking on the
      // generator's teardown.
      if (turnTempFiles.length) void this.cleanupTempImages(turnTempFiles);
    }
  }

  /** Stop the current turn without ending the thread → `turn/interrupt`. */
  async interrupt(): Promise<void> {
    const client = this.client;
    if (!client || !this.threadId || !this.turnId) return;
    try {
      await client.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
    } catch (err) {
      logger.debug(`[codex-backend] interrupt: ${msgOf(err)}`);
    }
  }

  /**
   * Codex model enumeration. config/read reports the active provider/model rather
   * than a catalog, so we surface a sensible static set (the current Codex model
   * family). Returns [] only if even that can't be determined.
   */
  async listModels(): Promise<ModelChoice[]> {
    return CODEX_FALLBACK_MODELS;
  }

  /** Permanently dispose of the backend (AgentBackend.close): kill the app-server
   *  process TREE (Windows shell-fallback grandchild included), remove listeners,
   *  null the client. Called by PanelAgent.stop() and every agent-replacement path
   *  (reset / effort restart / stopAll / shutdown). Idempotent + safe when never
   *  prepared (client is null). Without this the codex app-server child is orphaned
   *  because interrupt() is a no-op when the turn is idle (P0-1). */
  async close(): Promise<void> {
    // Tripwire FIRST: an in-flight prepare() re-checks this after each await and
    // disposes its local client rather than publishing it (P0-A).
    this.disposed = true;
    const client = this.client;
    // Also tear down any client a concurrent prepare() is mid-spawn on but hasn't
    // published yet — without this, close() would return while that child is still
    // coming up and orphan it (P0-A).
    const preparing = this.preparingClient;
    this.client = null;
    this.preparingClient = null;
    this.threadId = null;
    this.turnId = null;
    if (client) {
      client.notificationHandler = null;
      await client.close().catch(() => {});
    }
    if (preparing && preparing !== client) {
      preparing.notificationHandler = null;
      await preparing.close().catch(() => {});
    }
    // Sweep any temp image files a turn didn't get to clean up (e.g. close() raced
    // an in-flight turn). Snapshot first — cleanupTempImages mutates the set.
    if (this.tempImageFiles.size) {
      await this.cleanupTempImages([...this.tempImageFiles]).catch(() => {});
    }
  }
}
