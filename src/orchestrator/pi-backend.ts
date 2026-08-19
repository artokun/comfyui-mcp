// pi.dev CLI backend (issue #491, "include pi.dev as an agent") — the provider
// adapter behind the AgentBackend port for `pi`, the open-source multi-provider
// coding agent from earendil-works (https://pi.dev). Unlike codex/gemini (ACP /
// app-server), `pi` exposes a DOCUMENTED machine-readable event stream via its
// `--mode json` flag (JSON-lines on stdout), which this adapter parses — so it
// gets real streaming deltas, per-tool progress, and a RESUMABLE session id, a
// step up from the plain-text antigravity adapter it is otherwise modeled on.
//
//   turn N=1 (fresh)   pi --mode json [--model m] [--provider p] "<prompt>"
//   turn N>1 / resume  pi --session <id> --mode json ... "<prompt>"
//   interrupt()        kill the in-flight child process tree
//   listModels()       parse `pi --list-models` (padded text table)
//
// SESSION: `pi --mode json` prints a session header `{"type":"session","id":...}`
// as its first line. We capture that uuid and drive continuity with
// `--session <id>` (pi accepts a session file OR id), and REPORT it up the stack
// so PanelAgent can persist it and resume across restarts. This is genuine
// per-conversation continuity, not antigravity's "latest conversation" sentinel.
//
// NO MCP — IMPORTANT LIMITATION: pi has NO Model Context Protocol client (verified
// against the earendil-works/pi repo tree, CHANGELOG, and extensions docs — pi's
// tool surface is its OWN built-in tools (bash/read/write/edit/grep/…) plus
// TypeScript extensions registered via `pi.registerTool()`, never external MCP
// servers). So unlike every other CLI backend here, pi CANNOT be handed our
// `comfyui` (stdio) + `panel` (http) MCP servers — a pi turn drives the local
// workspace with pi's own tools but does not get the ComfyUI panel_* / comfyui
// tools. This is surfaced honestly in the ready banner. (Full ComfyUI-tool parity
// would require shipping a pi EXTENSION that bridges to the panel HTTP MCP —
// tracked as follow-up, out of scope for #491's "include pi as an agent".)
//
// AUTH: pi resolves credentials from (1) `~/.pi/agent/auth.json` (API keys and
// OAuth subscriptions written by `/login`), (2) provider env vars (pi's full map
// is transcribed in pi-credentials.ts), (3) a `~/.pi/agent/models.json` custom
// provider carrying its own apiKey/oauth, and (4) Google Vertex ADC. Detection
// of all four — which is what drives readiness, since `--list-models` is not an
// auth probe — lives in pi-credentials.ts. We
// spawn with buildAgentSpawnEnv() (no keep-list): the ComfyUI TOOL secrets
// (RunPod/CivitAI/RunComfy/Registry, and the Google/HF keys that panel-secrets
// classifies as tool secrets) are stripped so an LLM-vendor process never sees a
// tool credential — pi's own provider keys (ANTHROPIC/OPENAI/XAI/OpenRouter/…)
// are NOT tool secrets and pass through untouched, and its subscription auth
// lives in auth.json regardless. A pi user who wants the Google/HuggingFace
// providers via env should put those keys in ~/.pi/agent/auth.json (their env
// vars are ComfyUI-tool-scoped and intentionally withheld from agent subprocesses).
//
// LIMITS (flagged honestly):
//   - No ComfyUI MCP tools (see above).
//   - The prompt rides argv, so it is visible in the OS process list for the
//     child's lifetime and is capped at ~32K chars on Windows (preflighted).
//   - No documented image-input path for headless mode → vision=false (image
//     refs are already named in the turn text as a fallback).
//   - `pi --list-models` prints pi's built-in provider CATALOG (not gated on
//     which keys are configured), so it proves the CLI launches but is NOT an
//     auth probe — a keyless pi can greet ready and then fail the first turn with
//     an actionable provider/credential error.

import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import { errorText, promptText } from "./error-text.js";
import { looksLikeAuthFailure, providerAuthRemedy, qualifySlashCommands } from "./cli-remedy.js";
import { buildAgentSpawnEnv } from "../services/panel-secrets.js";
import {
  type AgentBackend,
  type AgentEvent,
  type BackendStartOptions,
  type ModelChoice,
  type NeutralTurn,
  PI_CAPABILITIES,
  stampTurn,
} from "./agent-backend.js";

/** The per-turn child: stdin ignored (pi takes the prompt via argv), stdout +
 *  stderr piped. */
type PiChild = ChildProcessByStdio<null, Readable, Readable>;

function msgOf(err: unknown): string {
  return errorText(err);
}

/** Kill an entire process tree (identical posture to the other CLI backends):
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
 * Resolve the `pi` executable. Order: COMFYUI_MCP_PI_PATH (explicit escape hatch)
 * → PATH (pi / pi.cmd / pi.exe) → the official installer's well-known locations
 * (~/.local/bin/pi from `curl -fsSL https://pi.dev/install.sh | sh`, plus the
 * usual Homebrew / Windows spots). Returns an absolute path when found on disk,
 * the bare name as a last resort, or null when clearly absent. We never spawn
 * through a shell — the prompt is user data.
 */
export function resolvePiBin(home: string = homedir()): string | null {
  const override = process.env.COMFYUI_MCP_PI_PATH?.trim();
  if (override) {
    // Apply the SAME .cmd/.bat refusal as PATH discovery below — the override
    // must NOT be an escape hatch around it. Node cannot shell-lessly spawn a
    // .cmd/.bat, and we never spawn through a shell (the prompt is user data —
    // shell-quoting it would be an injection risk). A shim override is ignored
    // with a warning so the actionable "install pi/pi.exe" path fires.
    if (/\.(cmd|bat)$/i.test(override)) {
      logger.warn(
        `[pi-backend] COMFYUI_MCP_PI_PATH points at a shell shim (${override}); Node cannot spawn a .cmd/.bat shell-lessly — ignoring it. Point COMFYUI_MCP_PI_PATH at the real pi/pi.exe.`,
      );
      return null;
    }
    return override;
  }
  // A `.cmd`/`.bat` shim is deliberately NOT accepted for SPAWNING: Node refuses
  // shell-less `.cmd` spawns post-CVE-2024-27980, and we never spawn through a
  // shell (the prompt is user data — shell-quoting it would be an injection
  // risk). The official installer ships a real `pi`/`pi.exe`; a .cmd-only install
  // reads as "not found" here with actionable guidance (same stance as agy).
  const names = process.platform === "win32" ? ["pi.exe", "pi"] : ["pi"];
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
      ? [
          join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "pi", "bin", "pi.exe"),
          join(home, ".local", "bin", "pi.exe"),
        ]
      : [join(home, ".local", "bin", "pi"), "/usr/local/bin/pi", "/opt/homebrew/bin/pi"];
  for (const p of wellKnown) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // skip
    }
  }
  return null;
}

/** Parse a Go/JS-style duration ("45m", "5m0s", "1h30m") to ms; null when
 *  unparseable. (Shared shape with the antigravity adapter.) */
export function parsePiDurationMs(s: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s.trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000;
}

/** Strip ANSI escape sequences (pi's TUI heritage may color even table output).
 *  The ESC byte (\x1b) is part of the match — without it a colored token keeps
 *  its leading control char and fails id validation. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/**
 * Parse `pi --list-models` output into ModelChoices. The format is a padded text
 * table with columns `provider  model  context  max-out  thinking  images`
 * (whitespace-aligned, no documented machine contract), so this is deliberately
 * TOLERANT: strip ANSI, drop the header/separator rows, split each data row on
 * runs of 2+ spaces, and take the provider + model columns. The id is
 * `provider/model` (pi's `--model` accepts that prefixed form and it disambiguates
 * the same model offered by multiple providers); the label is the bare model id.
 * Returns [] when nothing parses (the panel degrades gracefully on an empty list).
 */
export function parsePiModels(output: string): ModelChoice[] {
  const out: ModelChoice[] = [];
  const seen = new Set<string>();
  for (const raw of stripAnsi(output).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Separator rules (─ === +-| etc.).
    if (/^[-=─│+|_\s]+$/.test(line)) continue;
    const cols = line.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
    if (cols.length < 2) continue;
    const provider = cols[0]!;
    const modelId = cols[1]!;
    // Header row.
    if (/^provider$/i.test(provider) && /^model$/i.test(modelId)) continue;
    // Plausible provider + model ids: id-ish charset, model has a digit or dash
    // (filters prose), neither is an obvious column header word.
    if (!/^[a-z0-9][\w.:-]*$/i.test(provider)) continue;
    if (!/^[a-z0-9][\w.:@/-]*$/i.test(modelId)) continue;
    if (!/[\d-]/.test(modelId)) continue;
    const id = `${provider}/${modelId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: modelId });
  }
  return out;
}

/** Provider config the pi backend needs. */
export interface PiBackendDeps {
  /** Working directory for pi. */
  cwd?: string;
  /** Model for turns (passed via --model; accepts "provider/id"). Unset = pi's
   *  configured default provider/model. */
  model?: string;
  /** Provider for turns (passed via --provider). Unset = pi's default. */
  provider?: string;
  /** Panel system prompt — prepended to the FIRST turn (pi headless has no
   *  system-prompt flag we rely on). Suppressed on resume (the session already
   *  carries it). */
  systemAppend?: string;
  /** A short capability note re-asserted on EVERY turn (fresh AND resume) — pi's
   *  correction that it has NO ComfyUI panel/comfyui tools. Unlike systemAppend
   *  it is NOT suppressed on resume, so a resumed or long-running pi session (the
   *  common path) is always told the truth about its capability (#491 codex
   *  P0a-resume). Kept small so re-sending it every turn is cheap. */
  capabilityNote?: string;
}

/** Sentinel session id used ONLY for the up-front session event of a FRESH
 *  conversation, before pi's `--mode json` header reveals the real uuid. It is
 *  never passed back to `--session` (guarded), so a turn that dies before the
 *  header can't poison resume with a bogus id. */
const PI_SESSION_SENTINEL = "pi-pending";

/**
 * The pi.dev CLI adapter. One instance per PanelAgent; spawn-per-turn, so there
 * is no persistent child between turns — only the in-flight one. Continuity is
 * pi's own session store, addressed by the captured session id.
 */
export class PiBackend implements AgentBackend {
  readonly id = "pi" as const;
  readonly capabilities = PI_CAPABILITIES;
  private deps: PiBackendDeps;
  private model: string | undefined;
  private provider: string | undefined;
  private bin: string | null | undefined; // undefined = not yet resolved
  /** The in-flight per-turn child (interrupt/close kill its tree). */
  private child: PiChild | null = null;
  private interrupted = false;
  /** True from runTurn entry until settle — a turn is definitely in flight. */
  private turnActive = false;
  /** Expiry for an interrupt armed while NO turn was active (see antigravity's
   *  identical rationale: survive a Stop-after-Send race without poisoning the
   *  user's next unrelated message). */
  private idleInterruptExpiry: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** The real pi session id: from the JSON header (fresh) or opts.resume. Drives
   *  `--session` on every turn after it is known, and is REPORTED to PanelAgent
   *  for cross-restart resume. Null until the first header of a fresh session. */
  private piSessionId: string | null = null;
  private needsSystemPreamble = false;

  constructor(deps: PiBackendDeps = {}) {
    this.deps = deps;
    this.model = deps.model;
    this.provider = deps.provider;
  }

  private resolveBin(): string {
    if (this.bin === undefined) this.bin = resolvePiBin();
    if (!this.bin) {
      throw new Error(
        "pi CLI (`pi`) not found. Install it from https://pi.dev " +
          "(macOS/Linux: `curl -fsSL https://pi.dev/install.sh | sh`), configure a provider " +
          "(set a provider API key, or run `pi` once and `/login`), then reconnect. You can " +
          "also point COMFYUI_MCP_PI_PATH at the executable.",
      );
    }
    return this.bin;
  }

  /** One-time preflight: resolve the executable so a missing install fails fast
   *  with the actionable message above (mirrors the other CLI backends). */
  async prepare(): Promise<void> {
    if (this.disposed) throw new Error("pi backend is closed.");
    this.resolveBin();
  }

  /**
   * Drive the session: one `pi --mode json` child per neutral turn, continuity
   * via `--session <capturedId>`. The channel async-iteration IS the turn gate
   * (PanelAgent releases one batch per turn).
   */
  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    await this.prepare();
    // The panel may pass a Claude id in opts.model (its own default) — that is
    // NOT a valid pi model. Only honor opts.model when it looks like a pi id
    // (contains a "/" provider prefix, which our listModels always emits); a bare
    // claude-* id is dropped so pi uses its configured default instead.
    if (opts.model && this.acceptableModel(opts.model)) this.model = opts.model;
    const cwd = opts.cwd ?? this.deps.cwd ?? process.cwd();

    const resumeId = (opts.resume ?? opts.sessionId) || null;
    // Guard against a legacy-persisted bogus sentinel (older builds emitted one
    // before the header arrived); never resume from it.
    if (resumeId && resumeId !== PI_SESSION_SENTINEL) this.piSessionId = resumeId;
    this.needsSystemPreamble = !this.piSessionId && !!this.deps.systemAppend;

    // Report a session id ONLY when it is REAL: on resume we already hold the
    // caller's id, so surface it up front; on a FRESH conversation we emit NO
    // session event until pi's JSON header reveals the real uuid (runTurn pushes
    // it then). This prevents a pre-header failure (spawn error, over-long
    // prompt, early exit) from persisting a bogus "pending" id up the stack.
    if (this.piSessionId) {
      yield {
        type: "session",
        sessionId: this.piSessionId,
        ...(this.model ? { model: this.model } : {}),
      };
    }

    let turnSeq = 0;
    for await (const turn of opts.channel) {
      yield* stampTurn(this.runTurn(turn, cwd, opts.onActivity), ++turnSeq);
    }
  }

  /** Whether `model` is usable for pi. The one thing we MUST reject is the
   *  panel's Anthropic-side default (a bare `claude-*` id with no provider
   *  prefix) leaking through opts.model — passing it to `pi --model` would fail
   *  every turn (and setting `--provider` alongside it does NOT rescue it, so the
   *  provider flag must NOT whitelist it). Everything else — our own
   *  `provider/model` picker ids, or an explicit id the user configured — passes. */
  private acceptableModel(model: string): boolean {
    if (/^claude/i.test(model) && !model.includes("/")) return false;
    return true;
  }

  /** Run ONE turn = one `pi --mode json` child. Parses the JSON-lines event
   *  stream: text deltas stream as assistant deltas, tool_execution_* map to
   *  tool_call events, the session header reveals the resumable id. Exit 0 commits
   *  the accumulated text + a successful result; a non-zero exit (or spawn
   *  failure) surfaces an error + failed result. Exactly one terminal result per
   *  turn (PanelAgent's gate depends on it).
   *
   *  RESUME-MISS SELF-HEAL (artokun/comfyui-mcp-panel#1235): a RESUMED turn that
   *  dies with pi's "No session found matching '<id>'" has a dead resume target
   *  (pruned session store, different cwd/home, a foreign id armed from the
   *  panel's hello.resume hint). Retrying the SAME resume would fail every turn
   *  forever — the panel's `/new` workaround exists precisely because nothing
   *  dropped the dead id. So drop it and re-run THIS turn once as a fresh
   *  session (isRetry guards against a loop); the new header re-persists a valid
   *  id up the stack. The claude/codex equivalents self-heal in PanelAgent's
   *  catch (#277); pi yields error EVENTS instead of throwing, so the heal lives
   *  here. */
  private async *runTurn(
    turn: NeutralTurn,
    cwd: string,
    onActivity?: () => void,
    isRetry = false,
  ): AsyncGenerator<AgentEvent> {
    let text = promptText(turn.text);
    // System blocks, in order: the heavy panel preamble (FIRST fresh turn only)
    // then the capability note (EVERY turn — fresh AND resume). The note comes
    // LAST so, on the first turn, it overrides the preamble's panel_*-tools claim;
    // on resumed/subsequent turns it is re-asserted alone, so a long-running or
    // resumed pi session is never left believing it has ComfyUI tools it can't
    // run (#491 codex P0a-resume).
    const sysBlocks: string[] = [];
    if (this.needsSystemPreamble && this.deps.systemAppend) {
      sysBlocks.push(this.deps.systemAppend);
      this.needsSystemPreamble = false;
    }
    if (this.deps.capabilityNote) sysBlocks.push(this.deps.capabilityNote);
    if (sysBlocks.length) {
      text =
        `<system>\n${sysBlocks.join("\n\n")}\n</system>\n\n` +
        `The user's message follows.\n\n${text}`;
    }
    // Image refs: no documented headless image input — the refs are already named
    // in the turn text (vision=false tells the panel up front).

    const bin = this.resolveBin();
    const resuming = !!this.piSessionId;
    const args = [
      ...(resuming ? ["--session", this.piSessionId as string] : []),
      "--mode",
      "json",
      ...(this.provider ? ["--provider", this.provider] : []),
      ...(this.model ? ["--model", this.model] : []),
      text,
    ];

    // A Stop can land while this turn is still starting up — see the antigravity
    // adapter's note: `interrupted` is cleared on SETTLE, not here, so it survives
    // setup. A pending idle-armed interrupt is now aimed at THIS turn.
    this.turnActive = true;
    if (this.idleInterruptExpiry) {
      clearTimeout(this.idleInterruptExpiry);
      this.idleInterruptExpiry = null;
    }

    // Windows caps the whole command line at ~32K, and the prompt rides argv.
    if (process.platform === "win32") {
      const cmdLen = bin.length + args.reduce((n, a) => n + a.length + 3, 0);
      if (cmdLen > 30_000) {
        this.turnActive = false;
        yield {
          type: "error",
          message:
            `This message is too large for the pi CLI (${cmdLen} chars; Windows caps a command line at ~32K, and pi takes the prompt as an argument). ` +
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

    let assistantText = "";
    let errOut = "";
    let streamOpen = false;
    let lineBuf = "";

    /** Handle one parsed JSON event line from pi's --mode json stream. */
    const handleEvent = (ev: Record<string, unknown>): void => {
      const t = ev.type;
      if (t === "session") {
        // First line: the resumable session uuid. Report it up so PanelAgent
        // persists the REAL id (not the up-front sentinel) for cross-restart
        // resume, and drive continuity from it on the next turn.
        const id = typeof ev.id === "string" ? ev.id : null;
        if (id && id !== this.piSessionId) {
          this.piSessionId = id;
          push({ type: "session", sessionId: id, ...(this.model ? { model: this.model } : {}) });
        }
        return;
      }
      if (t === "message_update") {
        const ame = ev.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
        const delta = typeof ame?.delta === "string" ? ame.delta : "";
        if (!delta) return;
        const kind = typeof ame?.type === "string" ? ame.type : "";
        const thinking = /think|reason/i.test(kind);
        if (!thinking) assistantText += delta;
        if (!streamOpen) {
          streamOpen = true;
          push({ type: "stream_start", id: null });
        }
        push({ type: "assistant_delta", text: delta, ...(thinking ? { thinking: true } : {}) });
        return;
      }
      if (t === "tool_execution_start") {
        const name = typeof ev.toolName === "string" ? ev.toolName : "tool";
        push({ type: "tool_call", name, phase: "start", detail: ev.args });
        return;
      }
      if (t === "tool_execution_end") {
        const name = typeof ev.toolName === "string" ? ev.toolName : "tool";
        push({ type: "tool_call", name, phase: "end", detail: { isError: ev.isError === true } });
        return;
      }
      // agent_start / turn_start / message_start / message_end / turn_end /
      // agent_end / queue_update / compaction_* / *_retry_* — no panel event
      // needed; the process exit is the turn's terminal signal.
    };

    const consumeLines = (chunk: string): void => {
      lineBuf += chunk;
      let nl: number;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // non-JSON noise (shouldn't happen on stdout in json mode)
        }
        if (parsed && typeof parsed === "object") handleEvent(parsed as Record<string, unknown>);
      }
    };

    let child: PiChild;
    try {
      child = spawn(bin, args, {
        cwd,
        env: buildAgentSpawnEnv(), // strip ComfyUI tool secrets; pi's own provider keys pass through
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      }) as PiChild;
    } catch (err) {
      this.turnActive = false;
      yield { type: "error", message: `Could not start pi: ${msgOf(err)}` };
      yield { type: "result", ok: false, subtype: "error" };
      return;
    }
    this.child = child;

    // LIVENESS heartbeat: a pi turn may run long tool calls with quiet stretches.
    const heartbeat = setInterval(() => {
      try {
        onActivity?.();
      } catch {
        // watchdog bump must never throw
      }
    }, 15_000);
    heartbeat.unref?.();

    // HARD CEILING: bound a frozen child. Configurable; default 45m + 2m grace.
    const timeout = process.env.COMFYUI_MCP_PI_PRINT_TIMEOUT?.trim() || "45m";
    let ceilingHit = false;
    let ceilingForce: ReturnType<typeof setTimeout> | null = null;
    const ceilingMs = (parsePiDurationMs(timeout) ?? 45 * 60_000) + 120_000;
    const ceiling = setTimeout(() => {
      ceilingHit = true;
      killProcessTree(child.pid);
      ceilingForce = setTimeout(() => settle(null), 10_000);
      ceilingForce.unref?.();
    }, ceilingMs);
    ceiling.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      try {
        onActivity?.();
      } catch {
        // watchdog bump must never break the reader
      }
      consumeLines(chunk);
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
    let exitFallback: ReturnType<typeof setTimeout> | null = null;
    // Set by settle() when the failure IS the resume-miss: the dead id is dropped
    // and this turn re-runs once as a fresh session (see the runTurn docstring).
    let resumeMiss = false;
    const settle = (code: number | null, spawnErr?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(ceiling);
      if (ceilingForce) clearTimeout(ceilingForce);
      if (exitFallback) clearTimeout(exitFallback);
      if (this.child === child) this.child = null;
      // Flush any trailing buffered line (no final newline).
      if (lineBuf.trim()) consumeLines("\n");
      if (streamOpen) push({ type: "stream_end" });
      const finalText = assistantText.trim();
      if (this.interrupted) {
        if (finalText) push({ type: "assistant", text: finalText });
        push({ type: "result", ok: false, subtype: "cancelled" });
      } else if (ceilingHit) {
        push({
          type: "error",
          message:
            `pi did not finish within ${timeout} (+2m grace) and was terminated, which usually means a frozen CLI. ` +
            "Try again; raise COMFYUI_MCP_PI_PRINT_TIMEOUT for genuinely long jobs.",
        });
        push({ type: "result", ok: false, subtype: "timeout" });
      } else if (spawnErr || code !== 0) {
        const stderrTail = stripAnsi(errOut).trim().split(/\r?\n/).slice(-3).join(" ").trim();
        if (!spawnErr && resuming && !isRetry && /no session found matching/i.test(stderrTail)) {
          // RESUME-MISS (#1235): drop the dead id and retry fresh below — push NO
          // error/result, so the turn's single terminal event comes from the retry.
          resumeMiss = true;
        } else {
          const authish = looksLikeAuthFailure(stderrTail + finalText);
          // #948 — pi's own text says "please run /login", which in a chat panel
          // reads as "type this here" and sends the user somewhere it cannot work.
          // Every path that passes the child's words through is qualified, not just
          // the auth one: a non-auth failure can name a slash command too.
          const message = spawnErr
            ? /ENOENT/i.test(spawnErr.message)
              ? "pi CLI (`pi`) could not be launched — it may have been uninstalled. Reinstall from https://pi.dev and reconnect."
              : `pi failed to start: ${spawnErr.message}`
            : authish
              ? providerAuthRemedy("pi", stderrTail)
              : `pi exited with code ${code}.${stderrTail ? ` ${qualifySlashCommands(stderrTail, "pi")}` : ""}`;
          push({ type: "error", message });
          push({ type: "result", ok: false, subtype: "error" });
        }
      } else {
        if (finalText) push({ type: "assistant", text: finalText });
        push({ type: "result", ok: true, subtype: "end_turn" });
      }
      // Clear the interrupt HERE (turn end), not at turn start — it was consumed
      // to pick this turn's result, so the next turn starts clean.
      this.interrupted = false;
      this.turnActive = false;
      finish();
    };
    child.on("error", (err) => settle(null, err));
    // Settle on 'close' (all stdio drained), NOT 'exit': Node permits stdout to
    // still hold buffered data at 'exit', so settling there could drop a final
    // JSONL line (the last delta or the session header). 'exit' only arms a short
    // fallback in case a stray inherited pipe keeps stdout open past the process.
    child.on("exit", (code) => {
      if (settled || exitFallback) return;
      exitFallback = setTimeout(() => settle(code), 2000);
      exitFallback.unref?.();
    });
    child.on("close", (code) => settle(code));

    // An interrupt can arrive while spawn() is in flight — honor it now (after the
    // exit/close/error listeners are attached, so the kill's events are observed).
    if (this.interrupted) killProcessTree(child.pid);

    try {
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (done) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      while (queue.length) yield queue.shift()!;
    } finally {
      if (!settled) {
        // ABANDONED mid-turn (consumer dropped the generator without close()).
        settled = true;
        clearInterval(heartbeat);
        clearTimeout(ceiling);
        if (ceilingForce) clearTimeout(ceilingForce);
        killProcessTree(child.pid);
        if (this.child === child) this.child = null;
        this.turnActive = false;
        this.interrupted = false;
      }
    }

    if (resumeMiss) {
      // The dead resume id must NEVER be retried, and the fresh session needs the
      // panel preamble a resume suppresses. The retried turn re-reads both.
      logger.warn(
        `[pi-backend] resume target ${this.piSessionId} is gone (pi: no session found matching) — dropping it and retrying the turn as a fresh session (#1235)`,
      );
      this.piSessionId = null;
      this.needsSystemPreamble = !!this.deps.systemAppend;
      yield* this.runTurn(turn, cwd, onActivity, true);
    }
  }

  /** Stop the current turn: kill the in-flight child's process tree. The next
   *  turn continues the pi session (`--session <id>`) with whatever pi recorded. */
  async interrupt(): Promise<void> {
    this.interrupted = true;
    if (this.idleInterruptExpiry) clearTimeout(this.idleInterruptExpiry);
    this.idleInterruptExpiry = null;
    if (!this.turnActive) {
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

  /** Switch the model for subsequent turns (--model is per-spawn, so this is free
   *  — no respawn dance). Rejects ids that don't look like pi ids. */
  async setModel(model: string): Promise<void> {
    if (this.acceptableModel(model)) this.model = model;
  }

  /**
   * Enumerate pi's provider/model catalog via `pi --list-models` (a padded text
   * table). Also serves as the "CLI can launch" probe for the connect ack — note
   * it is NOT an auth probe (pi lists its built-in catalog regardless of which
   * keys are configured).
   */
  async listModels(): Promise<ModelChoice[]> {
    const bin = this.resolveBin();
    return await new Promise<ModelChoice[]>((resolve, reject) => {
      let out = "";
      let err = "";
      let child: PiChild;
      try {
        child = spawn(bin, ["--list-models"], {
          cwd: this.deps.cwd ?? process.cwd(),
          env: buildAgentSpawnEnv(),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        }) as PiChild;
      } catch (e) {
        reject(new Error(`Could not run \`pi --list-models\`: ${msgOf(e)}`));
        return;
      }
      const timer = setTimeout(() => {
        killProcessTree(child.pid);
        reject(new Error("`pi --list-models` timed out after 30s."));
      }, 30_000);
      timer.unref?.();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (c: string) => (out += c));
      child.stderr.on("data", (c: string) => (err += c));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`Could not run \`pi --list-models\`: ${e.message}`));
      });
      // 'close' (stdio drained), not 'exit' — the full table must be captured.
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(parsePiModels(out));
        } else {
          const tail = stripAnsi(err || out).trim().split(/\r?\n/).slice(-2).join(" ");
          reject(
            new Error(
              `\`pi --list-models\` exited with code ${code}${tail ? ` (${tail})` : ""}. ` +
                "Make sure pi is installed (https://pi.dev) and a provider is configured.",
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
    if (this.idleInterruptExpiry) {
      clearTimeout(this.idleInterruptExpiry);
      this.idleInterruptExpiry = null;
    }
  }
}
