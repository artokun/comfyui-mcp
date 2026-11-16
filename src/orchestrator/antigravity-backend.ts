// Google Antigravity CLI backend (issue #262) â€” the provider adapter behind the
// AgentBackend port for `agy`, the official Antigravity CLI that replaced the
// individual-tier Gemini CLI subscription path on 2026-06-18 (Google AI Pro /
// Ultra / free tiers moved to Antigravity; Gemini CLI remains for enterprise +
// API-key users, and keeps its own separate `gemini` backend here).
//
// Unlike the ACP/app-server adapters (gemini/codex), `agy` exposes NO documented
// machine-readable streaming protocol â€” only a plain-text non-interactive print
// mode. So this adapter is a SPAWN-PER-TURN driver over the supported public
// surface, exactly as requested in #262 ("start with final-text responses"):
//
//   turn N=1        agy -p "<prompt>" [--model m] --dangerously-skip-permissions
//   turn N>1        agy -c -p "<prompt>" ...        (--continue = latest conversation)
//   resume          same as N>1 (`-c`); `agy` owns conversation storage
//   interrupt()     kill the in-flight child process tree (Windows taskkill /T /F)
//   listModels()    parse `agy models` (live account catalog â€” no static list)
//
// stdout is streamed to the panel as assistant deltas as it arrives (agy prints
// the final answer progressively in -p mode; if a build buffers, the deltas just
// land at once â€” still correct). There is no per-turn rewind anchor and no
// in-process MCP: forkAtAnchor=false, inProcessMcp=false.
//
// AUTH: the CLI owns authentication (system keyring + Google Sign-In). Per #262
// we deliberately do NOT read tokens from the keyring or Antigravity state files
// â€” readiness is "the executable exists", and the real auth signal is whether
// `agy models` answers (the connect ack's model probe). An unauthenticated CLI
// gets an actionable "run `agy` once and sign in" message.
//
// MCP / ComfyUI tools â€” VERIFIED LIVE against agy 1.1.5 (2026-07-21): the CLI
// honors ONLY the global shared `~/.gemini/config/mcp_config.json`; the
// workspace `.agents/mcp_config.json` path in third-party docs is IDE-only and
// silently ignored by `agy -p`. Before the first turn we MERGE our two servers â€”
// the headless `comfyui` stdio MCP and the per-tab `panel` HTTP MCP â€” into that
// file under our own names, preserving every other entry byte-for-byte.
// Merge-safe and reversible (delete the two keys); global rather than
// workspace-scoped only because the CLI offers nothing narrower.
//
// LIMITS (flagged honestly, mirrors the issue's "reduced capabilities" ask):
//   - `-p` prints plain text: no structured tool-call events, so the panel shows
//     no per-tool progress for agy turns (onActivity still fires on every stdout
//     chunk, keeping the idle watchdog armed).
//   - `--continue` binds to the account's LATEST conversation; a user running
//     `agy` interactively in parallel â€” or a SECOND antigravity panel tab â€”
//     can steal continuity (tab A's next turn continues tab B's thread). The
//     supported surface offers no way to read the new conversation's id from
//     -p output; revisit if a future agy prints one.
//   - The prompt rides argv, so it is visible in the OS process list for the
//     child's lifetime (same-host processes can read the conversation) and is
//     capped at ~32K chars on Windows (preflighted with a legible error).
//   - No documented image-input path for -p â†’ vision=false (image refs are
//     already named in the turn text as a fallback).

import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

/** The per-turn child: stdin ignored (agy takes the prompt via argv), stdout +
 *  stderr piped. */
type AgyChild = ChildProcessByStdio<null, Readable, Readable>;

// SECURITY: agy is Google's LLM-vendor CLI â€” its subprocess must NOT inherit the
// user's TOOL secrets (RunPod/CivitAI/HF/RunComfy/Registry tokens, AND the
// GEMINI/GOOGLE keys, which panel-secrets classifies as tool secrets). The
// official Antigravity CLI docs (antigravity.google/docs/cli) say agy
// authenticates via the native system keyring + browser/SSH OAuth â€” it does NOT
// document any API-key env auth â€” so there is NO confirmed need to re-admit the
// GEMINI/GOOGLE keys, and doing so would expose tool credentials to the agy
// subprocess. We therefore strip EVERY tool-only secret (no keep-list).
//   NOTE: if a future agy version documents API-key env auth (e.g. GEMINI_API_KEY),
//   re-admit that specific key deliberately here via buildAgentSpawnEnv(..., { keep })
//   with a justification â€” do not blanket-keep.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "../utils/logger.js";
import { errorText, promptText } from "./error-text.js";
import { buildAgentSpawnEnv } from "../services/panel-secrets.js";
import {
  type AgentBackend,
  type AgentEvent,
  type BackendStartOptions,
  type ModelChoice,
  type NeutralTurn,
  ANTIGRAVITY_CAPABILITIES,
  stampTurn,
} from "./agent-backend.js";
import type { GeminiMcpServerSpec } from "./gemini-backend.js";
import { AcpClient, type AcpInitializeResult, type RpcMessage } from "./gemini-backend.js";
import type { ImageRef } from "./panel-agent.js";

function msgOf(err: unknown): string {
  return errorText(err);
}

/** Kill an entire process tree (identical posture to gemini/codex-backend):
 *  Windows taskkill /T /F; POSIX negative-pid process-group signal with a
 *  single-pid fallback. Best-effort â€” teardown must never throw. */
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
    process.kill(-p, "SIGTERM");
  } catch {
    try {
      process.kill(p, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

/**
 * Resolve the `agy` executable. Order: COMFYUI_MCP_ANTIGRAVITY_PATH (explicit
 * escape hatch) â†’ PATH (agy / agy.exe) â†’ the official installers' well-known
 * locations (%LOCALAPPDATA%\agy\bin on Windows, ~/.local/bin elsewhere).
 * Returns an absolute path when found on disk, the bare name as a last resort,
 * or null when clearly absent. We never spawn through a shell â€” the prompt is
 * user data, and the official installers ship a real executable (a `.cmd` npm
 * shim is NOT supported; Node refuses shell-less .cmd spawns post-CVE-2024-27980,
 * and shell quoting of arbitrary prompt text would be an injection risk).
 */
export function resolveAgyBin(home: string = homedir()): string | null {
  const override = process.env.COMFYUI_MCP_ANTIGRAVITY_PATH?.trim();
  if (override) return override;
  const names = process.platform === "win32" ? ["agy.exe", "agy"] : ["agy"];
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of (process.env.PATH || "").split(sep).filter(Boolean)) {
    for (const name of names) {
      try {
        const full = join(dir, name);
        if (existsSync(full)) return full;
      } catch {
        // unreadable PATH entry â€” skip
      }
    }
  }
  const wellKnown =
    process.platform === "win32"
      ? [join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "agy", "bin", "agy.exe")]
      : [join(home, ".local", "bin", "agy"), "/usr/local/bin/agy", "/opt/homebrew/bin/agy"];
  for (const p of wellKnown) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // skip
    }
  }
  return null;
}

/** Parse a Go-style duration ("45m", "5m0s", "1h30m") to ms; null when unparseable. */
export function parseGoDurationMs(s: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s.trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000;
}

/** Strip ANSI escape sequences (agy's TUI heritage may color even -p output). */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/**
 * Parse `agy models` output into ModelChoices. The format is not a documented
 * contract, so this is deliberately TOLERANT: strip ANSI, take each non-empty
 * line, drop obvious headers/rules/prose, strip list markers and a
 * "(default)"/"(current)" tag, and keep the first token when it looks like a
 * model id. A `*`-marked or "(default)" row is surfaced first. Returns [] when
 * nothing parses (the panel degrades gracefully on an empty list).
 */
export function parseAgyModels(output: string): ModelChoice[] {
  const out: ModelChoice[] = [];
  let defaultId: string | null = null;
  for (const raw of stripAnsi(output).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Header / separator / prose rows.
    if (/^[-=â”€â”‚+|]+$/.test(line)) continue;
    if (/^(available|models?|name|id|description|usage|use )\b/i.test(line) && !/^[a-z0-9][\w.:/-]*$/i.test(line)) continue;
    const marked = /^[*âœ“âœ”>]/.test(line);
    const cleaned = line.replace(/^[*âœ“âœ”>â€¢\-\s]+/, "");
    const isDefault = marked || /\((default|current|active)\)/i.test(cleaned);
    const token = cleaned.split(/\s+/)[0]?.replace(/[,;]$/, "") ?? "";
    // A plausible model id: starts alphanumeric, id-ish charset, has a digit or
    // dash (filters prose words like "Run"), not an obvious column header.
    if (!/^[a-z0-9][\w.:/-]*$/i.test(token)) continue;
    if (!/[\d-]/.test(token)) continue;
    if (/^(name|model|models|id)$/i.test(token)) continue;
    if (out.some((m) => m.id === token)) continue;
    out.push({ id: token });
    if (isDefault && !defaultId) defaultId = token;
  }
  if (defaultId) {
    out.sort((a, b) => (a.id === defaultId ? -1 : b.id === defaultId ? 1 : 0));
  }
  return out;
}

/**
 * Merge our MCP servers into a workspace `.agents/mcp_config.json`, preserving
 * every entry we don't own. Antigravity's schema (per the official docs): local
 * servers are { command, args, env: {K:V} }, remote ones { serverUrl }. Handles
 * both the bare { name: {...} } layout and a { mcpServers: { name: {...} } }
 * wrapper, preferring whichever the existing file already uses (wrapper when
 * creating fresh). Returns the merged JSON text it wrote (for tests).
 */
export function mergeAgyMcpConfig(
  existingText: string | null,
  servers: Record<string, GeminiMcpServerSpec>,
): string {
  let root: Record<string, unknown> = {};
  try {
    if (existingText?.trim()) {
      const parsed: unknown = JSON.parse(existingText);
      // Parseable-but-non-object (array/scalar): named keys set on an array are
      // silently dropped by stringify, and spreading a scalar makes garbage â€”
      // neither is a valid mcp config, so start from a fresh wrapper instead.
      // (ensureMcpConfig refuses to touch such a file at all; this guard keeps
      // the pure function safe for direct callers.)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>;
      }
    }
  } catch {
    // Unparseable user file: do NOT clobber it â€” merge into a fresh wrapper and
    // let the caller decide; we keep the unparseable original under a backup key
    // is worse than refusing. Treat as empty but log at the call site.
    root = {};
  }
  const hasWrapper =
    typeof root.mcpServers === "object" && root.mcpServers !== null && !Array.isArray(root.mcpServers);
  // If the file is bare-layout (top-level server entries, no mcpServers key and
  // at least one object value), keep that layout; otherwise use the wrapper.
  const bareLayout =
    !hasWrapper && Object.values(root).some((v) => typeof v === "object" && v !== null);
  const target: Record<string, unknown> = bareLayout
    ? root
    : ((root.mcpServers as Record<string, unknown>) ?? {});
  for (const [name, spec] of Object.entries(servers)) {
    target[name] = specToAgyEntry(spec);
  }
  const merged = bareLayout ? target : { ...root, mcpServers: target };
  return `${JSON.stringify(merged, null, 2)}\n`;
}

/** Remove OUR server entries from an agy mcp_config.json, preserving everything
 *  else. OWNERSHIP-AWARE (codex review): an entry is deleted only when its
 *  current content deep-equals the snapshot WE wrote â€” a same-named entry
 *  overwritten meanwhile by another tab/process is someone else's live config
 *  and is left alone. Returns the new text, or null when there is nothing to
 *  change (missing/unparseable/non-object file, or no owned keys present). */
export function removeAgyMcpServers(
  existingText: string | null,
  written: Record<string, string>, // name -> JSON.stringify of the entry we wrote
): string | null {
  if (!existingText?.trim()) return null;
  let root: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(existingText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    root = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const hasWrapper =
    typeof root.mcpServers === "object" && root.mcpServers !== null && !Array.isArray(root.mcpServers);
  const target = hasWrapper ? (root.mcpServers as Record<string, unknown>) : root;
  let changed = false;
  for (const [name, snapshot] of Object.entries(written)) {
    if (name in target && JSON.stringify(target[name]) === snapshot) {
      delete target[name];
      changed = true;
    }
  }
  if (!changed) return null;
  return `${JSON.stringify(root, null, 2)}\n`;
}

/** May this env var be written to disk? STRICT ALLOWLIST (codex review: a
 *  denylist can't satisfy a "no secrets" guarantee â€” PRIVATE_KEY, AUTHORIZATION,
 *  DB_PASS, cookies, connection strings all slip past name patterns): only
 *  our own operational namespace goes to disk, and even there anything
 *  credential-shaped (COMFYUI_AUTH_TOKENâ€¦) is excluded. Everything else is
 *  withheld â€” the comfyui MCP server re-reads every stored token itself at boot
 *  (~/.comfyui-mcp/.env + panel secrets, the same canonical store the
 *  orchestrator's spawn-env merge draws from), so withholding loses nothing. */
function isDiskSafeEnvKey(key: string): boolean {
  if (!/^COMFYUI(_MCP)?_[A-Z0-9_]+$/.test(key) && key !== "COMFYUI_URL" && key !== "COMFYUI_PATH")
    return false;
  return !/(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|PRIVATE)/i.test(key);
}

/** Reduce a spec's env to disk-safe keys before it is written. Returns the
 *  sanitized servers plus the withheld key names (for an honest log line).
 *  Exported for tests. */
export function sanitizeMcpServersForDisk(
  servers: Record<string, GeminiMcpServerSpec>,
): { servers: Record<string, GeminiMcpServerSpec>; withheld: string[] } {
  const out: Record<string, GeminiMcpServerSpec> = {};
  const withheld: string[] = [];
  for (const [name, spec] of Object.entries(servers)) {
    if (spec.transport !== "stdio" || !spec.env) {
      out[name] = spec;
      continue;
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.env)) {
      if (isDiskSafeEnvKey(k)) env[k] = v;
      else withheld.push(k);
    }
    out[name] = { ...spec, env };
  }
  return { servers: out, withheld };
}

/** The exact JSON entry written for a spec (shared by merge + the ownership
 *  snapshot so the close()-time content compare can never drift). */
export function specToAgyEntry(spec: GeminiMcpServerSpec): Record<string, unknown> {
  return spec.transport === "stdio"
    ? { command: spec.command, args: spec.args ?? [], env: spec.env ?? {} }
    : { serverUrl: spec.url };
}

/** Atomic write: tmp file + rename, so a crash mid-write can never leave the
 *  user's global config truncated (the unparseable-file guard would then
 *  refuse to touch it forever). */
function writeFileAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

/** The MCP config file agy 1.1.5 actually honors â€” VERIFIED LIVE 2026-07-21:
 *  the workspace `.agents/mcp_config.json` and `~/.gemini/antigravity-cli/mcp/`
 *  paths circulating in third-party docs are IGNORED by the CLI; only the
 *  global shared `~/.gemini/config/mcp_config.json` attaches servers to a
 *  `-p` session (get_system_stats (action:"health") round-trip confirmed against a live ComfyUI). */
export function agyMcpConfigPath(home: string = homedir()): string {
  return join(home, ".gemini", "config", "mcp_config.json");
}

/** ACP session ids are UUIDs â€” the shape guards against the old `-p`
 *  sentinel ("antigravity-latest") being passed to session/load. */
const ACP_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CLIENT_INFO = { name: "comfyui-mcp-panel", title: "comfyui-mcp panel", version: "1.0.0" };

/** Provider config the Antigravity backend needs. Mirrors GeminiBackendDeps. */
export interface AntigravityBackendDeps {
  /** Working directory for agy. */
  cwd?: string;
  /** Model for turns (applied per session via ACP `session/set_model`). Unset =
   *  the account's default. */
  model?: string;
  /** MCP servers to merge into agy's global mcp_config.json (see agyMcpConfigPath).
   *  `agy acp` also attaches servers declared in `session/new` (verified: a probe
   *  server declared only there received initialize + tools/list and its tool was
   *  called; a session declaring six servers reached all six). It is not free:
   *  per-session servers are ADDED to the global config's set, and the CLI trims
   *  servers once the combined tool count grows — the panel's own tools drop from
   *  55 visible (declared with comfyui-compact alone) to 42 with five more servers
   *  present. So exactly ONE mechanism is used, the global file, to avoid two
   *  copies of the same servers competing for the budget. */
  mcpServers?: Record<string, GeminiMcpServerSpec>;
  /** Panel system prompt â€” prepended to the FIRST turn (ACP session/new has no
   *  instructions field). */
  systemAppend?: string;
  /** Override the MCP config file location (tests). Default agyMcpConfigPath(). */
  mcpConfigPath?: string;
  /** ComfyUI base URL â€” image refs are fetched from /view and inlined as ACP
   *  base64 image blocks. Unset = no vision (the ref is still named in the text). */
  comfyuiUrl?: string;
}

/**
 * The Antigravity CLI adapter, over `agy acp` (ACP = JSON-RPC 2.0 on stdio).
 *
 * ISSUE #3010: this used to drive `agy -p`, the plain-text print mode, which
 * carries no image input â€” so `ANTIGRAVITY_CAPABILITIES.vision` had to be false
 * and the panel visibly refused every attached image ("This provider is
 * text-onlyâ€¦"). `agy` ships an ACP server (verified live, Antigravity ACP Server
 * 1.5.9) that advertises `promptCapabilities.image = true` and takes inline
 * base64 image blocks. Speaking ACP also brings back what `-p` could not give:
 * streamed thinking, per-tool progress events, `session/cancel` interrupts, real
 * session ids for resume, and a prompt that rides stdin instead of argv (the
 * ~32K Windows command-line ceiling of #2234/#2309 disappears).
 *
 * One instance per PanelAgent; the ACP child is persistent, like gemini's.
 *
 * MCP servers stay in agy's global config file (see AntigravityBackendDeps): a
 * per-session declaration works too, but it is additive, and the CLI trims tools
 * when the total grows — so exactly one mechanism is used, the pre-existing one.
 */
export class AntigravityBackend implements AgentBackend {
  readonly id = "antigravity" as const;
  readonly capabilities = ANTIGRAVITY_CAPABILITIES;
  private deps: AntigravityBackendDeps;
  private model: string | undefined;
  private bin: string | null | undefined; // undefined = not yet resolved

  /** The live ACP client (one `agy acp` child per backend instance). */
  private client: AcpClient | null = null;
  /** The client an in-flight prepare() is spinning up, tracked so a concurrent
   *  close() can tear it down before it is published. */
  private preparingClient: AcpClient | null = null;
  /** The live ACP session id â€” used for session/prompt + session/cancel. */
  private sessionId: string | null = null;
  /** What the agent advertised at initialize (promptCapabilities.imageâ€¦). */
  private agentCaps: AcpInitializeResult["agentCapabilities"] = undefined;
  /** True until the first turn of a FRESH session has gone out (the panel system
   *  prompt is prepended to it). */
  private needsSystemPreamble = false;
  /** True from runTurn entry until settle â€” a turn is definitely in flight. */
  private turnActive = false;
  private interrupted = false;
  /** Expiry for an interrupt armed while NO turn was active (a Stop pressed right
   *  after Send must survive the pre-turn window; a stray idle Stop must not stay
   *  armed and cancel the user's next message minutes later). */
  private idleInterruptExpiry: NodeJS.Timeout | null = null;
  private disposed = false;
  /** Reasoning effort for turns (low|medium|high) â†’ ACP `thought_level`. */
  private effort: string | undefined;

  constructor(deps: AntigravityBackendDeps = {}) {
    this.deps = deps;
    this.model = deps.model;
  }

  private resolveBin(): string {
    if (this.bin === undefined) this.bin = resolveAgyBin();
    if (!this.bin) {
      throw new Error(
        "Antigravity CLI (`agy`) not found. Install it from https://antigravity.google " +
          "(Windows: `irm https://antigravity.google/cli/install.ps1 | iex`; macOS/Linux: " +
          "`curl -fsSL https://antigravity.google/cli/install.sh | bash`), run `agy` once to " +
          "sign in with your Google account, then reconnect. You can also point " +
          "COMFYUI_MCP_ANTIGRAVITY_PATH at the executable.",
      );
    }
    return this.bin;
  }

  /** Spawn `agy acp` + the ACP `initialize` handshake (idempotent: reuses a live
   *  client). The global mcp_config.json is written FIRST â€” the CLI reads it once
   *  at spawn, so a late write means this child has no ComfyUI/panel tools.
   *  Auth is verified lazily at session/new (ACP has no pre-session probe). */
  async prepare(): Promise<void> {
    if (this.disposed) throw new Error("antigravity backend is closed.");
    if (this.client) return;
    this.ensureMcpConfig();
    const bin = this.resolveBin();
    const cwd = this.deps.cwd ?? process.cwd();
    const args = [
      "acp",
      // The panel agent is an ISOLATED background agent (same posture as Claude
      // bypassPermissions / the ACP auto-approve): tool calls must not block on an
      // interactive prompt that nothing will ever answer.
      "--dangerously-skip-permissions",
    ];
    // SECURITY: spawn with the agent env â€” process.env MINUS every tool-only
    // secret. agy authenticates through the system keyring + browser OAuth and
    // documents no API-key env auth, so there is NO keep-list (same posture as the
    // `-p` adapter this replaces).
    const client = new AcpClient(bin, args, cwd, buildAgentSpawnEnv(), false);
    this.preparingClient = client;
    try {
      const init = await client.initialize(CLIENT_INFO);
      if (this.disposed) {
        await client.close().catch(() => {});
        throw new Error("antigravity backend is closed.");
      }
      this.agentCaps = init.agentCapabilities;
      this.client = client;
      logger.info(
        `[antigravity-backend] ACP ready (protocol ${init.protocolVersion ?? "?"}, ` +
          `agent ${init.agentInfo?.name ?? "agy"}, ` +
          `vision ${this.agentCaps?.promptCapabilities?.image === true ? "yes" : "no"})`,
      );
    } finally {
      if (this.preparingClient === client) this.preparingClient = null;
    }
  }

  /** Convert a ComfyUI image ref (/view) into an ACP inline base64 image
   *  ContentBlock â€” or null when it cannot be fetched (the text reference still
   *  names the image as a fallback). Same posture as Gemini/Claude: inline base64,
   *  12 MiB cap. */
  private async fetchImageBlock(ref: ImageRef): Promise<Record<string, unknown> | null> {
    const base = this.deps.comfyuiUrl ?? process.env.COMFYUI_URL;
    if (!base || !ref?.filename) return null;
    try {
      const u = new URL("/view", base);
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
      if (buf.length > 12 * 1024 * 1024) return null; // keep context sane
      return { type: "image", mimeType: mt, data: buf.toString("base64") };
    } catch {
      return null;
    }
  }

  /** Ensure a live session exists (session/new, or session/load on a real id),
   *  then push the selected model + thought level onto it. */
  private async ensureSession(cwd: string, resumeId: string | null): Promise<string> {
    const client = this.client;
    if (!client) throw new Error("agy acp is not initialized");
    // Deliberately empty: servers declared here are ADDED to the global config's,
    // and the CLI trims its tool list once the total grows (measured: panel 55 -> 42
    // with five other servers declared). prepare() already wrote the global file, so
    // declaring here would only duplicate — and duplicates cost real tools.
    const mcpServers: unknown[] = [];
    let resumed = false;
    if (resumeId && ACP_SESSION_ID.test(resumeId) && this.agentCaps?.loadSession === true) {
      try {
        await client.request("session/load", { sessionId: resumeId, cwd, mcpServers });
        this.sessionId = resumeId;
        this.needsSystemPreamble = false; // persona already delivered
        resumed = true;
      } catch (err) {
        logger.warn(`[antigravity-backend] session/load failed (${msgOf(err)}) â€” starting a fresh session`);
      }
    }
    if (!resumed) {
      let res: { sessionId?: string } | undefined;
      try {
        res = await client.request<{ sessionId?: string }>("session/new", { cwd, mcpServers });
      } catch (err) {
        if (/auth|sign|login|credential/i.test(msgOf(err))) {
          throw new Error(
            "Antigravity is not signed in. Run `agy` once from a terminal and complete the " +
              `Google sign-in, then reconnect. (${msgOf(err)})`,
          );
        }
        throw err;
      }
      if (!res?.sessionId) throw new Error("agy acp session/new returned no sessionId.");
      this.sessionId = res.sessionId;
      this.needsSystemPreamble = !!this.deps.systemAppend;
    }
    if (this.model) await this.applyModel();
    if (this.effort) await this.applyThoughtLevel();
    return this.sessionId as string;
  }

  /** Push the selected model onto the live session (ACP accepts it per session, so
   *  a model switch no longer needs a respawn + fresh conversation). */
  private async applyModel(): Promise<void> {
    const client = this.client;
    if (!client || !this.sessionId || !this.model) return;
    try {
      await client.request("session/set_model", { sessionId: this.sessionId, modelId: this.model });
      return;
    } catch (err) {
      logger.debug(`[antigravity-backend] session/set_model rejected (${msgOf(err)}) â€” trying set_config_option`);
    }
    try {
      await client.request("session/set_config_option", {
        sessionId: this.sessionId,
        configId: "model",
        value: this.model,
      });
    } catch (err) {
      logger.warn(`[antigravity-backend] could not select model ${this.model}: ${msgOf(err)}`);
    }
  }

  /** Map the panel's effort scale onto ACP's `thought_level` option. */
  private async applyThoughtLevel(): Promise<void> {
    const client = this.client;
    if (!client || !this.sessionId || !this.effort) return;
    try {
      await client.request("session/set_config_option", {
        sessionId: this.sessionId,
        configId: "thought_level",
        value: this.effort,
      });
    } catch (err) {
      logger.debug(`[antigravity-backend] thought_level ${this.effort} rejected: ${msgOf(err)}`);
    }
  }

  /**
   * Drive the session: ONE `session/prompt` per neutral turn on a persistent ACP
   * child. The channel async-iteration IS the turn gate (PanelAgent releases one
   * batch per turn).
   */
  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    // Panel may pass the CLAUDE panel model unconditionally in opts.model â€” but a
    // simple "reject claude-*" filter is WRONG here: Antigravity's own catalog
    // legitimately offers Claude models. So validate claude-shaped ids against the
    // account's real `agy models` catalog and only drop the ones it cannot serve.
    if (opts.model) this.model = (await this.acceptableModel(opts.model)) ?? this.model;
    // agy maps effort onto ACP's `thought_level` (low|medium|high). Other
    // providers' scales (e.g. Codex xhigh) are ignored.
    if (opts.effort && /^(low|medium|high)$/i.test(opts.effort)) {
      this.effort = opts.effort.toLowerCase();
    }
    await this.prepare();
    if (!this.client) throw new Error("agy acp is not initialized");
    const cwd = opts.cwd ?? this.deps.cwd ?? process.cwd();
    // forkAtAnchor is false â†’ ignore opts.rewindAnchor; whole-session resume only.
    const wanted = opts.resume ?? opts.sessionId ?? null;
    const resumeId = wanted && wanted !== this.sessionId ? wanted : null;
    const sessionId = await this.ensureSession(cwd, resumeId);
    // The ACP session id IS our session id (PanelAgent persists it for resume).
    yield {
      type: "session",
      sessionId,
      ...(this.model ? { model: this.model } : {}),
    };
    let turnSeq = 0;
    for await (const turn of opts.channel) {
      yield* stampTurn(this.runTurn(turn, opts.onActivity), ++turnSeq);
    }
  }

  /** Run ONE turn: `session/prompt` + stream its session/update notifications as
   *  AgentEvents, resolving when the prompt returns a stopReason OR when the child
   *  dies mid-turn (never deadlock). Exactly one terminal result per turn â€” the
   *  PanelAgent gate only advances on a result. */
  private async *runTurn(turn: NeutralTurn, onActivity?: () => void): AsyncGenerator<AgentEvent> {
    const client = this.client;
    const sessionId = this.sessionId;
    if (!client || !sessionId) {
      yield { type: "error", message: "agy acp session is not open." };
      yield { type: "result", ok: false, subtype: "error" };
      return;
    }

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

    let assistantText = "";
    let messageId: string | null = null;
    let streamOpen = false;
    let streamKind: "text" | "thinking" | null = null;
    const openStream = (id: string | null, kind: "text" | "thinking") => {
      if (streamOpen && streamKind === kind) return;
      if (streamOpen) push({ type: "stream_end" });
      streamOpen = true;
      streamKind = kind;
      push({ type: "stream_start", id });
    };
    const closeStream = () => {
      if (!streamOpen) return;
      push({ type: "stream_end" });
      streamOpen = false;
      streamKind = null;
    };

    let finishedResult = false;
    const emitTerminalError = (message: string) => {
      if (finishedResult) return;
      finishedResult = true;
      closeStream();
      push({ type: "error", message });
      push({ type: "result", ok: false, subtype: "error" });
      finish();
    };

    // tool_call carries the title/kind; tool_call_update repeats only the id.
    const toolNames = new Map<string, string>();
    const apply = (msg: RpcMessage) => {
      if (finishedResult) return;
      const params = (msg.params ?? {}) as { sessionId?: string; update?: Record<string, unknown> };
      if (params.sessionId && params.sessionId !== sessionId) return; // not our session
      const update = params.update ?? {};
      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          const content = update.content as { type?: string; text?: string } | undefined;
          const text = content?.type === "text" ? content.text : undefined;
          if (typeof text === "string" && text) {
            if (typeof update.messageId === "string") messageId = update.messageId;
            openStream(messageId, "text");
            assistantText += text;
            push({ type: "assistant_delta", text });
          }
          break;
        }
        case "agent_thought_chunk": {
          const content = update.content as { type?: string; text?: string } | undefined;
          const text = content?.type === "text" ? content.text : undefined;
          if (typeof text === "string" && text) {
            // Open a reasoning stream on the FIRST delta so the panel renders early
            // thinking instead of dropping a delta with no open stream.
            openStream(messageId, "thinking");
            push({ type: "assistant_delta", text, thinking: true });
          }
          break;
        }
        case "tool_call": {
          const id = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
          const name =
            (typeof update.title === "string" && update.title) ||
            (typeof update.kind === "string" && update.kind) ||
            id ||
            "tool";
          if (id) toolNames.set(id, name);
          push({ type: "tool_call", name, phase: "start", detail: update });
          break;
        }
        case "tool_call_update": {
          const status = update.status;
          if (status === "completed" || status === "failed") {
            const id = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
            const name =
              (typeof update.title === "string" && update.title) ||
              (id ? toolNames.get(id) : undefined) ||
              (typeof update.kind === "string" && update.kind) ||
              id ||
              "tool";
            push({ type: "tool_call", name, phase: "end", detail: update });
          }
          break;
        }
        default:
          // plan / available_commands_update / usage_update / session_info_update
          // carry no AgentEvent â€” onActivity below already re-armed the watchdog.
          break;
      }
    };

    const prev = client.notificationHandler;
    client.notificationHandler = (msg: RpcMessage) => {
      // LIVENESS: ANY notification while the turn is in flight means the agent is
      // alive â€” fire onActivity BEFORE filtering so updates that produce no
      // AgentEvent (a long MCP tool call mid-generation) still arm the watchdog.
      try {
        onActivity?.();
      } catch {
        // a watchdog bump must never break the protocol reader
      }
      if (msg.method === "session/update") apply(msg);
      else prev?.(msg);
    };

    void client.exitPromise.then(() => {
      if (done) return;
      emitTerminalError(client.exitError ? msgOf(client.exitError) : "agy acp connection closed.");
    });

    // FIRST-TURN PERSONA: ACP session/new has no instructions field, so the panel
    // system prompt is prepended to the first turn as a marked preamble.
    let turnText = promptText(turn.text);
    if (this.needsSystemPreamble && this.deps.systemAppend) {
      turnText =
        `<system>\n${this.deps.systemAppend}\n</system>\n\n` +
        `The user's first message follows.\n\n${turnText}`;
      this.needsSystemPreamble = false;
    }

    // Prompt ContentBlock[]: the text block first (preserves prompt context), then
    // any resolved inline base64 image blocks. Only when the agent advertised
    // promptCapabilities.image (default-allow when the capability is unknown).
    const prompt: Array<Record<string, unknown>> = [{ type: "text", text: turnText }];
    const refs = turn.images ?? [];
    const imagesAllowed = this.agentCaps?.promptCapabilities?.image !== false;
    let attached = 0;
    if (imagesAllowed) {
      for (const ref of refs) {
        const block = await this.fetchImageBlock(ref);
        if (block) {
          prompt.push(block);
          attached++;
        }
      }
    }
    if (refs.length && attached < refs.length) {
      // Honest fallback: name what did NOT arrive so the model cannot describe an
      // image it never received.
      prompt[0] = {
        type: "text",
        text:
          `${turnText}\n\n[panel note: ${refs.length - attached} of ${refs.length} attached image(s) ` +
          `could not be delivered to you. Do not claim or imply you saw them; if it matters, ask the ` +
          `user to describe them.]`,
      };
    }

    this.turnActive = true;
    if (this.idleInterruptExpiry) {
      clearTimeout(this.idleInterruptExpiry);
      this.idleInterruptExpiry = null;
    }
    if (this.interrupted) {
      // A Stop landed while this turn was setting up: honor it now.
      this.turnActive = false;
      this.interrupted = false;
      yield { type: "error", message: "Antigravity turn interrupted." };
      yield { type: "result", ok: false, subtype: "cancelled" };
      return;
    }

    let interrupted = false;
    try {
      // session/prompt is a REQUEST that RESOLVES with a stopReason at turn end.
      client
        .request<{ stopReason?: string }>("session/prompt", { sessionId, prompt })
        .then((res) => {
          if (finishedResult) return;
          finishedResult = true;
          closeStream();
          // ACP has no final-message notification: commit the accumulated text as
          // ONE authoritative assistant message (groups the deltas under one bubble).
          const text = assistantText.trim();
          if (text) push({ type: "assistant", text, ...(messageId ? { id: messageId } : {}) });
          const stop = res?.stopReason;
          const ok = !!stop && stop !== "cancelled" && stop !== "refusal";
          push({ type: "result", ok, ...(stop ? { subtype: stop } : {}) });
          finish();
        })
        .catch((err) => {
          if (interrupted) emitTerminalError("Antigravity turn interrupted.");
          else emitTerminalError(msgOf(err));
        });

      // Drain the bridged queue until the turn completes.
      while (true) {
        while (queue.length) yield queue.shift() as AgentEvent;
        if (done) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      while (queue.length) yield queue.shift() as AgentEvent;
    } finally {
      interrupted = this.interrupted;
      if (client.notificationHandler && !client.exitError) client.notificationHandler = prev ?? null;
      this.turnActive = false;
      this.interrupted = false;
    }
  }

  /** Stop the current turn: ACP `session/cancel` (graceful â€” the session survives),
   *  then kill the child if the agent does not settle the turn. */
  async interrupt(): Promise<void> {
    this.interrupted = true;
    if (this.idleInterruptExpiry) {
      clearTimeout(this.idleInterruptExpiry);
      this.idleInterruptExpiry = null;
    }
    if (!this.turnActive) {
      // Armed while NO turn was in flight: either a Stop racing its own turn's
      // startup (honor it â€” a turn starts within ms and consumes the flag) or a
      // stray idle Stop (must not cancel the user's NEXT message minutes later).
      const t = setTimeout(() => {
        this.idleInterruptExpiry = null;
        if (!this.turnActive) this.interrupted = false;
      }, 500);
      t.unref?.();
      this.idleInterruptExpiry = t;
      return;
    }
    const client = this.client;
    if (client && this.sessionId) client.notify("session/cancel", { sessionId: this.sessionId });
    // FAILSAFE: an agent that ignores the cancel must still end the turn. Kill the
    // tree; the next turn re-prepares (fresh child + fresh session).
    const dying = client;
    const timer = setTimeout(() => {
      if (!this.turnActive || this.client !== dying) return;
      logger.warn("[antigravity-backend] session/cancel did not settle the turn â€” killing agy");
      this.client = null;
      this.sessionId = null;
      if (dying?.pid) killProcessTree(dying.pid);
    }, 5_000);
    timer.unref?.();
  }


  /** The file ensureMcpConfig actually wrote to (cleanup target for close()). */
  private mcpConfigWritten = false;
  private mcpConfigFile: string | null = null;
  /** Per-entry snapshot of what we wrote (name -> JSON), for ownership-aware
   *  removal on close(). */
  private mcpWrittenEntries: Record<string, string> | null = null;

  /** Merge our MCP servers into agy's global mcp_config.json (once per backend
   *  instance) â€” the ONLY location the CLI honors (verified live; see
   *  agyMcpConfigPath). Merge-safe: every entry we don't own is preserved
   *  byte-for-byte, and removal = deleting our two keys. Being a GLOBAL file,
   *  the per-tab `panel` entry is last-writer-wins across concurrent
   *  antigravity tabs (each run() rewrites it) â€” an accepted edge for now.
   *  Failure is non-fatal: the agent still answers, just without ComfyUI tools â€”
   *  logged so the gap is visible. */
  private ensureMcpConfig(): void {
    // Re-merge on EVERY run(), not once per instance: another tab's close() (or
    // the user) may have removed/overwritten our entries since â€” a session must
    // start from a config that actually contains ITS servers (codex review).
    if (!this.deps.mcpServers || !Object.keys(this.deps.mcpServers).length) return;
    const file = this.deps.mcpConfigPath ?? agyMcpConfigPath();
    const dir = dirname(file);
    try {
      let existing: string | null = null;
      try {
        existing = readFileSync(file, "utf8");
      } catch {
        existing = null;
      }
      if (existing) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(existing);
        } catch {
          logger.warn(
            `[antigravity-backend] ${file} exists but is not valid JSON â€” leaving it untouched (ComfyUI MCP tools will be unavailable to agy until it parses)`,
          );
          return;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          logger.warn(
            `[antigravity-backend] ${file} is valid JSON but not an object â€” leaving it untouched (ComfyUI MCP tools will be unavailable to agy until it is an object)`,
          );
          return;
        }
      }
      // NO SECRETS AT REST: strip credential-looking env keys before the write â€”
      // the comfyui MCP server re-reads its tokens from ~/.comfyui-mcp at boot.
      const { servers, withheld } = sanitizeMcpServersForDisk(this.deps.mcpServers);
      mkdirSync(dir, { recursive: true });
      writeFileAtomic(file, mergeAgyMcpConfig(existing, servers));
      this.mcpConfigWritten = true;
      this.mcpConfigFile = file;
      // Ownership snapshot: exactly what we wrote, per entry â€” close() deletes
      // an entry only while its content still matches this (another tab's
      // overwrite is theirs to keep).
      this.mcpWrittenEntries = Object.fromEntries(
        Object.entries(servers).map(([n, s]) => [n, JSON.stringify(specToAgyEntry(s))]),
      );
      logger.info(
        `[antigravity-backend] merged comfyui/panel MCP servers into ${file}` +
          (withheld.length ? ` (withheld secret env keys: ${withheld.join(", ")} â€” the MCP server reloads them from its own store)` : ""),
      );
    } catch (err) {
      logger.warn(`[antigravity-backend] could not write ${file}: ${msgOf(err)}`);
    }
  }

  /** Undo ensureMcpConfig on dispose: delete OUR keys from the global file so a
   *  later interactive `agy` run doesn't keep spawning our tool server against a
   *  possibly-stale ComfyUI URL and a dead per-tab panel URL. Everything else in
   *  the file is preserved; re-merged on the next run(). Best-effort. */
  private removeMcpConfig(): void {
    if (!this.mcpConfigWritten || !this.mcpConfigFile || !this.mcpWrittenEntries) return;
    const file = this.mcpConfigFile;
    this.mcpConfigWritten = false;
    try {
      let existing: string | null = null;
      try {
        existing = readFileSync(file, "utf8");
      } catch {
        return;
      }
      const cleaned = removeAgyMcpServers(existing, this.mcpWrittenEntries);
      if (cleaned !== null) {
        writeFileAtomic(file, cleaned);
        logger.info(`[antigravity-backend] removed our MCP server entries from ${file}`);
      }
    } catch (err) {
      logger.debug(`[antigravity-backend] mcp_config cleanup skipped: ${msgOf(err)}`);
    }
  }


  /** The account's model catalog, fetched lazily via `agy models` and cached for
   *  the backend's lifetime. Null when the probe fails (unauthenticated etc.) â€”
   *  callers then fall back to the claude-prefix heuristic. */
  private catalog: Set<string> | null = null;
  /** When the last catalog probe FAILED (ms epoch) â€” negative-cached so an
   *  unauthenticated CLI doesn't eat a fresh 30s `agy models` spawn on every
   *  claude-shaped model check (each connect re-runs run()). */
  private catalogFailedAt = 0;
  private static readonly CATALOG_RETRY_MS = 60_000;
  private async ensureCatalog(): Promise<Set<string> | null> {
    if (this.catalog) return this.catalog;
    if (Date.now() - this.catalogFailedAt < AntigravityBackend.CATALOG_RETRY_MS) return null;
    try {
      this.catalog = new Set((await this.listModels()).map((m) => m.id));
    } catch (err) {
      logger.debug(`[antigravity-backend] catalog probe failed: ${msgOf(err)}`);
      this.catalog = null;
      this.catalogFailedAt = Date.now();
    }
    return this.catalog;
  }

  /** Decide whether `model` is usable for THIS provider: non-claude ids pass
   *  (they come from our own picker/config); claude-shaped ids are checked
   *  against the live catalog â€” Antigravity DOES serve some claude-* models, but
   *  the panel also leaks its Anthropic-side default (e.g. claude-opus-5)
   *  through opts.model, which must be dropped. Returns the model when
   *  acceptable, undefined when not. Catalog unavailable â†’ drop claude ids
   *  (conservative: a wrong --model makes every turn fail). */
  private async acceptableModel(model: string): Promise<string | undefined> {
    if (!/^claude/i.test(model)) return model;
    const catalog = await this.ensureCatalog();
    return catalog?.has(model) ? model : undefined;
  }

  /** Switch the model for subsequent turns (--model is per-spawn, so this is
   *  free â€” no respawn dance). Drops ids the account's catalog can't serve
   *  (see acceptableModel). */
  async setModel(model: string): Promise<void> {
    const ok = await this.acceptableModel(model);
    if (ok) this.model = ok;
  }


  /**
   * Enumerate the account's models via `agy models` (per #262: parse the live
   * catalog, never ship a static list). Also serves as the safe auth probe: an
   * unauthenticated CLI fails here â†’ the connect ack degrades with sign-in
   * guidance instead of greeting ready.
   */
  async listModels(): Promise<ModelChoice[]> {
    const bin = this.resolveBin();
    return await new Promise<ModelChoice[]>((resolve, reject) => {
      let out = "";
      let err = "";
      let child: AgyChild;
      try {
        child = spawn(bin, ["models"], {
          cwd: this.deps.cwd ?? process.cwd(),
          env: buildAgentSpawnEnv(), // no keep-list: strip ALL tool-only secrets (agy uses OAuth/keyring)
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        }) as AgyChild;
      } catch (e) {
        reject(new Error(`Could not run \`agy models\`: ${msgOf(e)}`));
        return;
      }
      const timer = setTimeout(() => {
        killProcessTree(child.pid);
        reject(new Error("`agy models` timed out after 30s."));
      }, 30_000);
      timer.unref?.();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (c: string) => (out += c));
      child.stderr.on("data", (c: string) => (err += c));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`Could not run \`agy models\`: ${e.message}`));
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(parseAgyModels(out));
        } else {
          const tail = stripAnsi(err || out).trim().split(/\r?\n/).slice(-2).join(" ");
          reject(
            new Error(
              `\`agy models\` exited with code ${code}${tail ? ` (${tail})` : ""}. ` +
                "If you haven't signed in yet, run `agy` once and complete the Google Sign-In.",
            ),
          );
        }
      });
    });
  }

  /** Dispose: close the ACP client (graceful stdin EOF, then tree kill) and leave
   *  no standing footprint in agy's global config. Idempotent, safe when never
   *  started. */
  async close(): Promise<void> {
    this.disposed = true;
    const client = this.client;
    const preparing = this.preparingClient;
    this.client = null;
    this.sessionId = null;
    if (this.idleInterruptExpiry) {
      clearTimeout(this.idleInterruptExpiry);
      this.idleInterruptExpiry = null;
    }
    // Leave no standing footprint: our entries in the global mcp_config.json would
    // otherwise make every later interactive `agy` run spawn our tool server
    // (stale COMFYUI_URL, dead per-tab panel URL) â€” and that file is read by another
    // product. Re-merged by the next session's run().
    this.removeMcpConfig();
    for (const c of [client, preparing]) {
      if (!c) continue;
      c.notificationHandler = null;
      await c.close().catch(() => {});
    }
  }
}

