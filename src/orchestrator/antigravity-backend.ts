// Google Antigravity CLI backend (issue #262) — the provider adapter behind the
// AgentBackend port for `agy`, the official Antigravity CLI that replaced the
// individual-tier Gemini CLI subscription path on 2026-06-18 (Google AI Pro /
// Ultra / free tiers moved to Antigravity; Gemini CLI remains for enterprise +
// API-key users, and keeps its own separate `gemini` backend here).
//
// Unlike the ACP/app-server adapters (gemini/codex), `agy` exposes NO documented
// machine-readable streaming protocol — only a plain-text non-interactive print
// mode. So this adapter is a SPAWN-PER-TURN driver over the supported public
// surface, exactly as requested in #262 ("start with final-text responses"):
//
//   turn N=1        agy -p "<prompt>" [--model m] --dangerously-skip-permissions
//   turn N>1        agy -c -p "<prompt>" ...        (--continue = latest conversation)
//   resume          same as N>1 (`-c`); `agy` owns conversation storage
//   interrupt()     kill the in-flight child process tree (Windows taskkill /T /F)
//   listModels()    parse `agy models` (live account catalog — no static list)
//
// stdout is streamed to the panel as assistant deltas as it arrives (agy prints
// the final answer progressively in -p mode; if a build buffers, the deltas just
// land at once — still correct). There is no per-turn rewind anchor and no
// in-process MCP: forkAtAnchor=false, inProcessMcp=false.
//
// AUTH: the CLI owns authentication (system keyring + Google Sign-In). Per #262
// we deliberately do NOT read tokens from the keyring or Antigravity state files
// — readiness is "the executable exists", and the real auth signal is whether
// `agy models` answers (the connect ack's model probe). An unauthenticated CLI
// gets an actionable "run `agy` once and sign in" message.
//
// MCP / ComfyUI tools — VERIFIED LIVE against agy 1.1.5 (2026-07-21): the CLI
// honors ONLY the global shared `~/.gemini/config/mcp_config.json`; the
// workspace `.agents/mcp_config.json` path in third-party docs is IDE-only and
// silently ignored by `agy -p`. Before the first turn we MERGE our two servers —
// the headless `comfyui` stdio MCP and the per-tab `panel` HTTP MCP — into that
// file under our own names, preserving every other entry byte-for-byte.
// Merge-safe and reversible (delete the two keys); global rather than
// workspace-scoped only because the CLI offers nothing narrower.
//
// LIMITS (flagged honestly, mirrors the issue's "reduced capabilities" ask):
//   - `-p` prints plain text: no structured tool-call events, so the panel shows
//     no per-tool progress for agy turns (onActivity still fires on every stdout
//     chunk, keeping the idle watchdog armed).
//   - `--continue` binds to the account's LATEST conversation; a user running
//     `agy` interactively in parallel can steal continuity. The supported
//     surface offers no way to read the new conversation's id from -p output.
//   - No documented image-input path for -p → vision=false (image refs are
//     already named in the turn text as a fallback).

import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

/** The per-turn child: stdin ignored (agy takes the prompt via argv), stdout +
 *  stderr piped. */
type AgyChild = ChildProcessByStdio<null, Readable, Readable>;
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "../utils/logger.js";
import {
  type AgentBackend,
  type AgentEvent,
  type BackendStartOptions,
  type ModelChoice,
  type NeutralTurn,
  ANTIGRAVITY_CAPABILITIES,
} from "./agent-backend.js";
import type { GeminiMcpServerSpec } from "./gemini-backend.js";

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Kill an entire process tree (identical posture to gemini/codex-backend):
 *  Windows taskkill /T /F; POSIX negative-pid process-group signal with a
 *  single-pid fallback. Best-effort — teardown must never throw. */
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
 * escape hatch) → PATH (agy / agy.exe) → the official installers' well-known
 * locations (%LOCALAPPDATA%\agy\bin on Windows, ~/.local/bin elsewhere).
 * Returns an absolute path when found on disk, the bare name as a last resort,
 * or null when clearly absent. We never spawn through a shell — the prompt is
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
        // unreadable PATH entry — skip
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

/** Strip ANSI escape sequences (agy's TUI heritage may color even -p output). */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;?]*[ -/]*[@-~]/g, "");
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
    if (/^[-=─│+|]+$/.test(line)) continue;
    if (/^(available|models?|name|id|description|usage|use )\b/i.test(line) && !/^[a-z0-9][\w.:/-]*$/i.test(line)) continue;
    const marked = /^[*✓✔>]/.test(line);
    const cleaned = line.replace(/^[*✓✔>•\-\s]+/, "");
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
    if (existingText?.trim()) root = JSON.parse(existingText) as Record<string, unknown>;
  } catch {
    // Unparseable user file: do NOT clobber it — merge into a fresh wrapper and
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
    target[name] =
      spec.transport === "stdio"
        ? { command: spec.command, args: spec.args ?? [], env: spec.env ?? {} }
        : { serverUrl: spec.url };
  }
  const merged = bareLayout ? target : { ...root, mcpServers: target };
  return `${JSON.stringify(merged, null, 2)}\n`;
}

/** The MCP config file agy 1.1.5 actually honors — VERIFIED LIVE 2026-07-21:
 *  the workspace `.agents/mcp_config.json` and `~/.gemini/antigravity-cli/mcp/`
 *  paths circulating in third-party docs are IGNORED by the CLI; only the
 *  global shared `~/.gemini/config/mcp_config.json` attaches servers to a
 *  `-p` session (health_check round-trip confirmed against a live ComfyUI). */
export function agyMcpConfigPath(home: string = homedir()): string {
  return join(home, ".gemini", "config", "mcp_config.json");
}

/** Provider config the Antigravity backend needs. Mirrors GeminiBackendDeps. */
export interface AntigravityBackendDeps {
  /** Working directory for agy. */
  cwd?: string;
  /** Model for turns (passed via --model). Unset = the account's default. */
  model?: string;
  /** MCP servers to merge into agy's global mcp_config.json (see agyMcpConfigPath). */
  mcpServers?: Record<string, GeminiMcpServerSpec>;
  /** Panel system prompt — prepended to the FIRST turn (agy -p has no system flag). */
  systemAppend?: string;
  /** Override the MCP config file location (tests). Default agyMcpConfigPath(). */
  mcpConfigPath?: string;
}

/** Sentinel session id: agy owns conversation storage and -p output carries no
 *  conversation id, so "resume" means `--continue` (the account's latest). */
const AGY_SESSION_SENTINEL = "antigravity-latest";

/**
 * The Antigravity CLI adapter. One instance per PanelAgent; spawn-per-turn, so
 * there is no persistent child between turns — only the in-flight one.
 */
export class AntigravityBackend implements AgentBackend {
  readonly id = "antigravity" as const;
  readonly capabilities = ANTIGRAVITY_CAPABILITIES;
  private deps: AntigravityBackendDeps;
  private model: string | undefined;
  private bin: string | null | undefined; // undefined = not yet resolved
  /** The in-flight per-turn child (interrupt/close kill its tree). */
  private child: AgyChild | null = null;
  private interrupted = false;
  /** True from runTurn entry until settle — a turn is definitely in flight. */
  private turnActive = false;
  /** Expiry for an interrupt armed while NO turn was active. Two truths clash:
   *  a Stop pressed right after Send must survive the pre-spawn window (the
   *  03080bc bug — the turn is coming, just not visible to us yet), but a stray
   *  Stop while genuinely idle must NOT stay armed and cancel the user's next
   *  unrelated message minutes later. The backend can't see PanelAgent's queue
   *  to tell the two apart, so an idle-armed interrupt self-expires after a
   *  short grace: an imminent turn (Stop-after-Send) starts within it and
   *  consumes the flag; nothing starting means it was a stray Stop. */
  private idleInterruptExpiry: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** False until the first turn of a FRESH conversation completes; resumed
   *  sessions start true so every turn continues the latest conversation. */
  private continueNext = false;
  private needsSystemPreamble = false;
  private mcpConfigWritten = false;

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

  /** One-time preflight: resolve the executable so a missing install fails fast
   *  with the actionable message above (mirrors the other CLI backends). */
  async prepare(): Promise<void> {
    if (this.disposed) throw new Error("antigravity backend is closed.");
    this.resolveBin();
  }

  /** Merge our MCP servers into agy's global mcp_config.json (once per backend
   *  instance) — the ONLY location the CLI honors (verified live; see
   *  agyMcpConfigPath). Merge-safe: every entry we don't own is preserved
   *  byte-for-byte, and removal = deleting our two keys. Being a GLOBAL file,
   *  the per-tab `panel` entry is last-writer-wins across concurrent
   *  antigravity tabs (each run() rewrites it) — an accepted edge for now.
   *  Failure is non-fatal: the agent still answers, just without ComfyUI tools —
   *  logged so the gap is visible. */
  private ensureMcpConfig(): void {
    if (this.mcpConfigWritten || !this.deps.mcpServers || !Object.keys(this.deps.mcpServers).length)
      return;
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
        try {
          JSON.parse(existing);
        } catch {
          logger.warn(
            `[antigravity-backend] ${file} exists but is not valid JSON — leaving it untouched (ComfyUI MCP tools will be unavailable to agy until it parses)`,
          );
          return;
        }
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, mergeAgyMcpConfig(existing, this.deps.mcpServers), "utf8");
      this.mcpConfigWritten = true;
      logger.info(`[antigravity-backend] merged comfyui/panel MCP servers into ${file}`);
    } catch (err) {
      logger.warn(`[antigravity-backend] could not write ${file}: ${msgOf(err)}`);
    }
  }

  /**
   * Drive the session: one `agy -p` child per neutral turn, continuity via
   * `--continue`. The channel async-iteration IS the turn gate (PanelAgent
   * releases one batch per turn).
   */
  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    await this.prepare();
    // Panel may pass the CLAUDE panel model unconditionally in opts.model — but a
    // simple "reject claude-*" filter is WRONG here: Antigravity's own catalog
    // legitimately offers Claude models (verified live: claude-sonnet-4-6,
    // claude-opus-4-6-thinking ride the Google subscription). So validate
    // claude-shaped ids against the account's real `agy models` catalog and only
    // drop the ones that aren't in it (the panel's Anthropic-side default).
    // Non-claude ids are honored directly — they can only have come from our own
    // picker (fed by listModels) or explicit config.
    if (opts.model) this.model = (await this.acceptableModel(opts.model)) ?? this.model;
    const cwd = opts.cwd ?? this.deps.cwd ?? process.cwd();
    this.ensureMcpConfig();

    const resuming = !!(opts.resume ?? opts.sessionId);
    this.continueNext = resuming;
    this.needsSystemPreamble = !resuming && !!this.deps.systemAppend;

    yield {
      type: "session",
      sessionId: AGY_SESSION_SENTINEL,
      ...(this.model ? { model: this.model } : {}),
    };

    for await (const turn of opts.channel) {
      yield* this.runTurn(turn, cwd, opts.onActivity);
    }
  }

  /** Run ONE turn = one `agy -p` child. stdout streams as assistant deltas;
   *  exit 0 commits the accumulated text and a successful result; a non-zero
   *  exit (or spawn failure) surfaces an error + failed result. Exactly one
   *  terminal result per turn (PanelAgent's gate depends on it). */
  private async *runTurn(
    turn: NeutralTurn,
    cwd: string,
    onActivity?: () => void,
  ): AsyncGenerator<AgentEvent> {
    let text = turn.text;
    if (this.needsSystemPreamble && this.deps.systemAppend) {
      text =
        `<system>\n${this.deps.systemAppend}\n</system>\n\n` +
        `The user's first message follows.\n\n${turn.text}`;
      this.needsSystemPreamble = false;
    }
    // Image refs: no documented -p image input — the refs are already named in
    // the turn text (vision=false tells the panel up front).

    const bin = this.resolveBin();
    const timeout = process.env.COMFYUI_MCP_ANTIGRAVITY_PRINT_TIMEOUT?.trim() || "45m";
    const args = [
      ...(this.continueNext ? ["-c"] : []),
      "-p",
      text,
      "--print-timeout",
      timeout,
      // The panel agent is an isolated background agent (same posture as
      // Claude bypassPermissions / the ACP auto-approve): tool calls must not
      // block on an interactive prompt that nothing will ever answer.
      "--dangerously-skip-permissions",
      ...(this.model ? ["--model", this.model] : []),
    ];

    // NOTE: `interrupted` is deliberately NOT cleared here. A Stop can land
    // while this turn is still starting up (run() awaits prepare() and the
    // channel before reaching runTurn), and clearing at turn START silently
    // discarded it — the turn then ran with nothing able to stop it. The flag is
    // cleared when a turn SETTLES instead, so it survives setup and the child
    // assignment below acts on it. A pending idle-armed interrupt is now
    // definitely aimed at THIS turn — cancel its expiry so it's consumed here.
    this.turnActive = true;
    if (this.idleInterruptExpiry) {
      clearTimeout(this.idleInterruptExpiry);
      this.idleInterruptExpiry = null;
    }

    // Windows caps the whole CreateProcess command line at 32,767 chars, and the
    // prompt rides argv. The panel system preamble alone is ~29K on the first
    // turn, so a transcript replay / pasted workflow can blow past it — spawn
    // then fails with a cryptic EINVAL/E2BIG. Preflight with a legible error.
    if (process.platform === "win32") {
      const cmdLen = bin.length + args.reduce((n, a) => n + a.length + 3, 0);
      if (cmdLen > 30_000) {
        this.turnActive = false;
        yield {
          type: "error",
          message:
            `This message is too large for the Antigravity CLI (${cmdLen} chars; Windows caps a command line at ~32K, and agy takes the prompt as an argument). ` +
            "Send a shorter message, or start a fresh chat to drop replayed context.",
        };
        yield { type: "result", ok: false, subtype: "error" };
        return;
      }
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

    let out = "";
    let errOut = "";
    let streamOpen = false;

    let child: AgyChild;
    try {
      child = spawn(bin, args, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      }) as AgyChild;
    } catch (err) {
      yield { type: "error", message: `Could not start agy: ${msgOf(err)}` };
      yield { type: "result", ok: false, subtype: "error" };
      return;
    }
    this.child = child;

    // LIVENESS heartbeat: agy -p may print NOTHING for minutes while it works
    // (tool calls, long generations) — there is no event stream to observe. The
    // child process being alive is the only honest liveness signal, so bump the
    // idle watchdog on an interval while it runs. A truly hung child is bounded
    // by agy's own --print-timeout, which ends the turn with a non-zero exit.
    const heartbeat = setInterval(() => {
      try {
        onActivity?.();
      } catch {
        // watchdog bump must never throw
      }
    }, 15_000);
    heartbeat.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      try {
        onActivity?.();
      } catch {
        // watchdog bump must never break the reader
      }
      const clean = stripAnsi(chunk);
      if (!clean) return;
      out += clean;
      if (!streamOpen) {
        streamOpen = true;
        push({ type: "stream_start", id: null });
      }
      push({ type: "assistant_delta", text: clean });
    });
    child.stderr.on("data", (chunk: string) => {
      try {
        onActivity?.();
      } catch {
        // ignore
      }
      errOut += chunk;
    });

    let settled = false;
    const settle = (code: number | null, spawnErr?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      if (this.child === child) this.child = null;
      if (streamOpen) push({ type: "stream_end" });
      const finalText = out.trim();
      if (this.interrupted) {
        if (finalText) push({ type: "assistant", text: finalText });
        push({ type: "result", ok: false, subtype: "cancelled" });
      } else if (spawnErr || code !== 0) {
        const stderrTail = stripAnsi(errOut).trim().split(/\r?\n/).slice(-3).join(" ").trim();
        const authish = /sign.?in|log.?in|auth|credential|unauthoriz/i.test(stderrTail + finalText);
        const message = spawnErr
          ? /ENOENT/i.test(spawnErr.message)
            ? "Antigravity CLI (`agy`) could not be launched — it may have been uninstalled. Reinstall from https://antigravity.google and reconnect."
            : `agy failed to start: ${spawnErr.message}`
          : authish
            ? `Antigravity CLI is not signed in. Run \`agy\` once in a terminal, complete the Google Sign-In, then send your message again.${stderrTail ? ` (agy: ${stderrTail})` : ""}`
            : `agy exited with code ${code}.${stderrTail ? ` ${stderrTail}` : ""}`;
        push({ type: "error", message });
        push({ type: "result", ok: false, subtype: "error" });
      } else {
        if (finalText) push({ type: "assistant", text: finalText });
        // From here on, continue the conversation agy just recorded.
        this.continueNext = true;
        push({ type: "result", ok: true, subtype: "end_turn" });
      }
      // Clear the interrupt HERE (turn end), not at turn start — see the note
      // where the queue is set up. The flag has now been consumed to pick this
      // turn's result, so the next turn starts clean. turnActive closes with it:
      // interrupts landing from now until the next runTurn are idle no-ops.
      this.interrupted = false;
      this.turnActive = false;
      finish();
    };
    child.on("error", (err) => settle(null, err));
    child.on("exit", (code) => settle(code));

    // An interrupt can arrive while spawn() is in flight — `this.child` was
    // still null then, so interrupt() could only raise the flag. Honor it now.
    // This MUST come after the exit/error listeners above: killing earlier can
    // deliver the child's death before anything is listening, and then the turn
    // never settles (exactly what hung the interrupt test).
    if (this.interrupted) killProcessTree(child.pid);

    // Drain the bridged queue until the child settles.
    while (true) {
      while (queue.length) yield queue.shift()!;
      if (done) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    while (queue.length) yield queue.shift()!;
  }

  /** Stop the current turn: kill the in-flight child's process tree. The next
   *  turn continues the conversation (`-c`) with whatever agy recorded. */
  async interrupt(): Promise<void> {
    // Set the flag FIRST and UNCONDITIONALLY. `this.child` is only assigned
    // after spawn() returns, so an interrupt landing in that window used to hit
    // the `if (!child) return` below, leave `interrupted` false, and never kill
    // anything — the turn then ran to completion with nothing able to stop it
    // (the original 03080bc bug). run() re-checks this flag the moment it
    // assigns the child, so a kill is never lost.
    this.interrupted = true;
    if (this.idleInterruptExpiry) clearTimeout(this.idleInterruptExpiry);
    this.idleInterruptExpiry = null;
    if (!this.turnActive) {
      // Armed while NO turn was in flight: either a Stop racing its own turn's
      // startup (honor it — a turn starts within ms and consumes the flag) or a
      // stray idle Stop (PanelAgent interrupts unconditionally, e.g. rewind).
      // Self-expire so the stray case can't linger and spuriously cancel the
      // user's NEXT message (the post-03080bc poisoning regression).
      const t = setTimeout(() => {
        this.idleInterruptExpiry = null;
        if (!this.turnActive) this.interrupted = false;
      }, 500);
      t.unref?.();
      this.idleInterruptExpiry = t;
    }
    const child = this.child;
    if (!child) return; // spawn window — run() kills it as soon as it exists
    killProcessTree(child.pid);
  }

  /** The account's model catalog, fetched lazily via `agy models` and cached for
   *  the backend's lifetime. Null when the probe fails (unauthenticated etc.) —
   *  callers then fall back to the claude-prefix heuristic. */
  private catalog: Set<string> | null = null;
  private async ensureCatalog(): Promise<Set<string> | null> {
    if (this.catalog) return this.catalog;
    try {
      this.catalog = new Set((await this.listModels()).map((m) => m.id));
    } catch (err) {
      logger.debug(`[antigravity-backend] catalog probe failed: ${msgOf(err)}`);
      this.catalog = null;
    }
    return this.catalog;
  }

  /** Decide whether `model` is usable for THIS provider: non-claude ids pass
   *  (they come from our own picker/config); claude-shaped ids are checked
   *  against the live catalog — Antigravity DOES serve some claude-* models, but
   *  the panel also leaks its Anthropic-side default (e.g. claude-opus-4-8)
   *  through opts.model, which must be dropped. Returns the model when
   *  acceptable, undefined when not. Catalog unavailable → drop claude ids
   *  (conservative: a wrong --model makes every turn fail). */
  private async acceptableModel(model: string): Promise<string | undefined> {
    if (!/^claude/i.test(model)) return model;
    const catalog = await this.ensureCatalog();
    return catalog?.has(model) ? model : undefined;
  }

  /** Switch the model for subsequent turns (--model is per-spawn, so this is
   *  free — no respawn dance). Drops ids the account's catalog can't serve
   *  (see acceptableModel). */
  async setModel(model: string): Promise<void> {
    const ok = await this.acceptableModel(model);
    if (ok) this.model = ok;
  }

  /**
   * Enumerate the account's models via `agy models` (per #262: parse the live
   * catalog, never ship a static list). Also serves as the safe auth probe: an
   * unauthenticated CLI fails here → the connect ack degrades with sign-in
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
          env: process.env,
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

  /** Dispose: kill any in-flight child tree. Idempotent, safe when never started. */
  async close(): Promise<void> {
    this.disposed = true;
    const child = this.child;
    this.child = null;
    if (child) {
      this.interrupted = true;
      killProcessTree(child.pid);
    }
  }
}
