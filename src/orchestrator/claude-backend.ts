// Claude Agent SDK backend — the provider-specific adapter behind the
// AgentBackend port. It owns everything that knows about
// `@anthropic-ai/claude-agent-sdk`: the lazy SDK import, the `query()` call,
// Claude `Options` building (including forkSession/resumeSessionAt/resume),
// model/command enumeration, the live model setter, interrupt, and the
// normalization of `SDKMessage` → canonical `AgentEvent`.
//
// PanelAgent keeps all provider-agnostic orchestration (queue, turn-gate, bridge
// push, rewind-anchor tracking, self-restart) and drives this backend via
// `for await (const ev of backend.run({...}))`. See
// design/agent-backend-injection.md.

import type {
  Query,
  SDKMessage,
  SDKUserMessage,
  Options,
  ModelInfo,
  SlashCommand,
  McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../utils/logger.js";
import { errorText } from "./error-text.js";
import { buildAgentSpawnEnv } from "../services/panel-secrets.js";
import { loadTurnRegistry, saveTurnRegistry, tombstoneTurn } from "./turn-registry.js";
import {
  degradedMcpNotice,
  emptyToolsMcpNotice,
  inspectMcpServers,
  serversWithoutTools,
  reconnectableMcpStatus,
  recoveredMcpNotice,
  unrecoveredMcpNotice,
} from "./mcp-session-health.js";
import type { DegradedMcpServer } from "./mcp-session-health.js";
import { randomUUID } from "node:crypto";
import {
  type AgentBackend,
  type AgentEvent,
  type BackendStartOptions,
  type ModelChoice,
  type NeutralTurn,
  CLAUDE_CAPABILITIES,
} from "./agent-backend.js";
import { makeBlindNativeHook } from "./blind-native-gate.js";
import type { Effort, ImageRef } from "./panel-agent.js";

// ---- reasoning effort mapping ----
// Effort is now a provider-neutral union (it must survive a provider switch — see
// panel-agent.ts Effort). The Agent SDK only accepts the Claude scale
// (low|medium|high|xhigh|max), so map any off-scale neutral value (Codex's
// "none"/"minimal") to the nearest valid Claude level. Shared levels pass through.
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
function toClaudeEffort(effort: string | undefined): Effort | undefined {
  if (!effort) return undefined;
  const e = effort.toLowerCase();
  if (CLAUDE_EFFORTS.has(e)) return e as Effort;
  if (e === "none" || e === "minimal") return "low"; // Codex's sub-low → Claude's floor
  return undefined; // unknown → SDK default
}

// The Agent SDK is an OPTIONAL dependency (it pulls in ~100 packages and is only
// needed for the panel orchestrator), so load it lazily and fail with a clear
// message rather than at import time for everyone.
let queryFn: typeof import("@anthropic-ai/claude-agent-sdk").query | null = null;
export async function loadQuery(): Promise<NonNullable<typeof queryFn>> {
  if (queryFn) return queryFn;
  try {
    const mod = await import("@anthropic-ai/claude-agent-sdk");
    queryFn = mod.query;
  } catch {
    throw new Error(
      "The panel orchestrator requires the optional dependency @anthropic-ai/claude-agent-sdk. Install it with: npm i @anthropic-ai/claude-agent-sdk",
    );
  }
  return queryFn;
}

function msgOf(err: unknown): string {
  return errorText(err);
}

/**
 * Ask the SDK which models the current account can actually use — so the panel's
 * picker reflects the live subscription instead of a hardcoded list. This is the
 * only model-enumeration path that works on the subscription/OAuth lane:
 * `query.supportedModels()` (the public Models API and `claude` CLI both require
 * an API key, which we deliberately don't have here).
 *
 * Runs a minimal throwaway session — no MCP servers, no plugins/skills — so it's
 * cheap; the control request resolves right after init, then we tear it down.
 * Returns [] on any failure so the panel can fall back gracefully.
 */
export async function fetchSupportedModels(model: string): Promise<ModelInfo[]> {
  const query = await loadQuery();
  let stop = false;
  let wake: (() => void) | null = null;
  // An idle channel: keeps the control connection open without ever consuming a
  // turn, until we tear it down.
  async function* idle(): AsyncGenerator<SDKUserMessage> {
    while (!stop) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  const q = query({
    prompt: idle(),
    options: {
      model,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      strictMcpConfig: true,
      mcpServers: {},
      // SECURITY: the SDK spawns a Claude Code subprocess; `env` REPLACES its
      // environment entirely. Pass the agent env (process.env MINUS tool-only
      // secrets) so RunPod/HF/CivitAI tokens never reach the LLM subprocess.
      // Claude auth is OAuth-file-based (ANTHROPIC_API_KEY is deliberately unset).
      env: buildAgentSpawnEnv(),
    } as Options,
  });
  // The transport is pumped by iterating the query — do it in the background so
  // the control request (supportedModels) gets its response.
  const drain = (async () => {
    try {
      for await (const _ of q) {
        void _;
      }
    } catch {
      // torn down below
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Never hang forever: a stuck probe would leave a permanently-pending
    // cached promise and the panel would never get its model list.
    const models = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("supportedModels timed out")), 20000);
      }),
    ]);
    logger.info(`[panel-orchestrator] supportedModels: ${models.map((m) => m.value).join(", ") || "(none)"}`);
    return models;
  } catch (err) {
    logger.warn(`[panel-orchestrator] supportedModels probe failed: ${msgOf(err)}`);
    return [];
  } finally {
    if (timer) clearTimeout(timer);
    stop = true;
    // Cast re-widens: TS narrows the closure-mutated local back to its init value.
    (wake as (() => void) | null)?.();
    try {
      await q.interrupt();
    } catch {
      // already winding down
    }
    void drain;
  }
}

/**
 * Probe the SDK for the slash commands this account/session exposes (built-ins
 * like /compact, plus any loaded skills) so the panel can surface them in the
 * composer's completion menu. Same throwaway-session pattern as
 * fetchSupportedModels; returns [] on any failure so the panel degrades cleanly.
 */
export async function fetchSupportedCommands(model: string): Promise<SlashCommand[]> {
  const query = await loadQuery();
  let stop = false;
  let wake: (() => void) | null = null;
  async function* idle(): AsyncGenerator<SDKUserMessage> {
    while (!stop) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  const q = query({
    prompt: idle(),
    options: {
      model,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      strictMcpConfig: true,
      mcpServers: {},
      // SECURITY: agent env only (no tool-only secrets) — see fetchSupportedModels.
      env: buildAgentSpawnEnv(),
    } as Options,
  });
  const drain = (async () => {
    try {
      for await (const _ of q) {
        void _;
      }
    } catch {
      // torn down below
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const commands = await Promise.race([
      q.supportedCommands(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("supportedCommands timed out")), 20000);
      }),
    ]);
    logger.info(
      `[panel-orchestrator] supportedCommands: ${commands.map((c) => "/" + c.name).join(", ") || "(none)"}`,
    );
    return commands;
  } catch (err) {
    logger.warn(`[panel-orchestrator] supportedCommands probe failed: ${msgOf(err)}`);
    return [];
  } finally {
    if (timer) clearTimeout(timer);
    stop = true;
    (wake as (() => void) | null)?.();
    try {
      await q.interrupt();
    } catch {
      // already winding down
    }
    void drain;
  }
}

/** Provider config the Claude backend needs to build the SDK session — the
 *  subset of PanelAgentDeps that maps onto Claude `Options`. */
export interface ClaudeBackendDeps {
  /** mcpServers config for the spawned agent (the comfyui MCP). */
  mcpServers: Options["mcpServers"];
  /** Base URL of the ComfyUI instance, for fetching image bytes (/view). */
  comfyuiUrl?: string;
  /** Persona appended to the claude_code system-prompt preset. */
  systemAppend: string;
  /** In-process MCP server giving the agent LIVE control of this tab's graph. */
  panelServer?: McpSdkServerConfigWithInstance;
  /** Absolute path to the bundled comfyui-mcp plugin dir (skills), if found. */
  pluginPath?: string;
  /** Live Blind-mode predicate (issue #90, conversation-wide per #884). Read at
   *  each NATIVE tool call by the PreToolUse gate — the SDK subprocess keeps
   *  Claude Code's own Read/WebFetch, which deliver pixels without any MCP tool
   *  in the path, so the env-based MCP scrub alone cannot keep the promise. */
  isBlind?: () => boolean;
}

/** Bound on unresolved turn traces (wedged turns whose result never arrives).
 *  Overflow evicts the oldest trace — and POISONS classification rather than
 *  silently realigning it: the pop that crosses the evicted gap (and any
 *  traceless result) fails closed as unverifiable, never ok:true (#745 r3). */
const MAX_UNRESOLVED_TURNS = 16;

/** Bound on REMEMBERED dead-session turn ids (#886). The set exists to
 *  recognize a late result from a restarted session — it is not a
 *  classification input, so a cap here only bounds how far back recognition
 *  reaches; beyond it a stray falls back to the plain traceless report. */
const MAX_REMEMBERED_DEAD_TURNS = 64;

/**
 * The Claude Agent SDK adapter. One instance per PanelAgent; it holds the live
 * `Query` for the current session and re-creates it on each `run()`.
 */
export class ClaudeBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  private deps: ClaudeBackendDeps;
  private q: Query | null = null;
  // #740 turn-truthfulness, with TURN IDENTITY (#745 r2 review): every submitted
  // turn gets a trace; stream messages accrue to the LATEST trace, and each
  // terminal result is classified against the trace it belongs to (results
  // arrive in submission order, possibly with a turn's result missing or LATE —
  // the panel's no-result fallback releases the next turn and tolerates the
  // late result, panel-agent.ts:671 — so the backend must too). A late result
  // from a superseded turn therefore classifies by ITS OWN flags and never
  // resets or consumes the in-flight turn's state. A turn that produced NO
  // user-visible content is never a successful turn, and a blocking SDK
  // informational message (prevent_continuation — e.g. a UserPromptSubmit hook
  // denied the prompt) fails its turn even when the SDK's own result still
  // arrives with subtype "success". `interrupted` mirrors PanelAgent's
  // interruptRequested: an interrupted turn's empty result is the interrupt
  // landing, not an empty-turn failure — and only the turn that was in flight
  // when interrupt() landed may be marked.
  //
  // FAIL CLOSED (#745 r3/r4 review): classification must never produce ok:true
  // without positive evidence. A normal successful turn ALWAYS has a trace, so
  // a result whose trace is missing (stray from a dead session, or pushed off
  // by the MAX_UNRESOLVED_TURNS bound) or whose id crosses an evicted-turn gap
  // is UNVERIFIABLE → ok:false, never a forwarded success. The gap case is
  // additionally STICKY: once a pop crosses an evicted-turn gap the FIFO
  // alignment is unrecoverable (content accrued to a mismatched trace is not
  // proof of ITS turn's success), so `classificationPoisoned` fails every later
  // result in the session closed — cleared only by a genuine run() restart.
  private turnSeq = 0;
  private lastResultTurnId = 0;
  private classificationPoisoned = false;
  /** Run-relative zero for turn MARKERS (#728): set at every run() entry to the
   *  backend-wide lastResultTurnId, so event stamps are 1-based per run and
   *  match PanelAgent's per-dispatch mirror. */
  private markerBase = 0;
  /** Interrupted traces PARKED by subtype-aware correlation (#728 r5): an
   *  interrupted turn ends with an INTERRUPTED-subtype result, so when a result
   *  with any other subtype arrives while the oldest trace is interrupted and a
   *  newer trace exists, that turn's result is permanently LOST and the arriving
   *  result belongs to the newer turn — the interrupted trace is skipped
   *  (parked) rather than popped. The park legitimizes the resulting forward
   *  jump in lastResultTurnId, and lets a genuinely interrupted late landing
   *  still pop its OWN trace (a backward pop) and classify/stamp by its flags. */
  private parkedInterrupted = new Set<number>();
  /** Interrupted traces whose late landing already HAPPENED (moved out of
   *  parkedInterrupted on the pop) — consumption tracking so a SECOND
   *  interrupted landing can never re-consume a landed trace; with no
   *  unconsumed candidate it fails closed as traceless (#728 r6). */
  private consumedInterrupted = new Set<number>();
  private turns: Array<{
    id: number;
    hasContent: boolean;
    blockReason: string | null;
    interrupted: boolean;
  }> = [];

  // #886 — "submitted" must survive the session: when a run() restart drops the
  // live traces above, their ids move here (and a RESUMED session rehydrates
  // them from the durable registry written by the previous process). A
  // traceless result while this set is non-empty is then RECOGNIZED for what
  // it most likely is — a turn that was in flight when its session died,
  // completing late — and reported as "completed but unverified": never a
  // fabricated success (fail-closed #745 stands), but also no longer the false
  // "could not be matched to any submitted turn", which claimed the turn never
  // existed when only its record was lost. Insertion-ordered; recognition
  // consumes the oldest entry (results land in submission order).
  //
  // Entries are owner-TAGGED (`<instanceId>:<turnId>`): turnSeq restarts per
  // process, so two instances can each leave their own turn "1" outstanding —
  // untagged ids would collapse those into one record and the second late
  // result would be falsely reported as matching no submission (codex gate).
  private readonly instanceId = randomUUID();
  private rememberedDeadTurns = new Set<string>();
  /** The remembered set's bound dropped a record at some point — persisted
   *  into the registry file (`incomplete`) so a RESPAWN also knows the record
   *  is not provably complete, not just this process (codex gate r2). */
  private rememberedIncomplete = false;
  /** Session id the durable registry file belongs to (learned at init). Null
   *  until then — a submission pulled before init is processed can't be filed
   *  under a session nobody can resume yet. */
  private registrySessionId: string | null = null;
  /** A registry read/write failed — the record of outstanding turns is not
   *  provably complete, so log it and never lean on the registry's ABSENCE as
   *  evidence in that state. */
  private registryDegraded = false;

  // #885 — a stall is not a user rejection. The Agent SDK has no mid-turn steer
  // (Codex's turn/steer equivalent): a user message pushed into the stream is
  // queued by the CLI until the current turn ENDS — exactly what a frozen turn
  // cannot do — so the notice cannot ride the stalled turn itself. What must
  // not happen is the transcript keeping ONLY the interrupt's generic
  // user-rejection payload: on the next turn the model reads it and tells the
  // user "you cancelled" — a lie about the user's own actions. So the notice
  // is held here and prepended (clearly delimited as harness text, not the
  // user's words) to the NEXT user turn, where it lands in the transcript
  // right beside that payload. recoverStalledTurn therefore returns false:
  // PanelAgent keeps its proven bounded interrupt/restart recovery for the
  // frozen turn, and the correction rides the turn after.
  private pendingStallNotice: string | null = null;
  /** turnSeq when the notice was stored — a genuine `success` landing for that
   *  turn means the "stall" recovered by itself and the notice is stale. */
  private pendingStallNoticeTurn = 0;

  constructor(deps: ClaudeBackendDeps) {
    this.deps = deps;
  }

  /** Preflight: lazy-load the Agent SDK once so a missing optional dependency
   *  fails fast (a clear "install @anthropic-ai/claude-agent-sdk" reject) rather
   *  than being retried as a dropped session inside the restart loop. Idempotent. */
  async prepare(): Promise<void> {
    await loadQuery();
  }

  /** Fetch a ComfyUI image and wrap it as an Anthropic base64 image block, or
   *  null on any failure (the text reference still names it as a fallback). */
  private async fetchImageBlock(ref: ImageRef): Promise<unknown | null> {
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
        mt = "image/png"; // Anthropic-supported set; ComfyUI outputs are PNG by default
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 12 * 1024 * 1024) return null; // keep context sane
      return { type: "image", source: { type: "base64", media_type: mt, data: buf.toString("base64") } };
    } catch {
      return null;
    }
  }

  /** Shape one provider-neutral turn into a Claude `SDKUserMessage`, resolving
   *  image refs to inline base64 blocks so the agent SEES them in this turn (no
   *  get_image view/fetch round-trip). */
  private async shapeTurn(turn: NeutralTurn): Promise<SDKUserMessage> {
    let text = turn.text;
    // #885 — deliver the held stall correction AHEAD of the user's words, so
    // the model reads the true origin of the interrupt right next to the
    // generic rejection payload it would otherwise take at face value. The
    // notice names the PREVIOUS turn explicitly: on this new turn, a bare
    // "this turn stalled" would mispoint.
    if (this.pendingStallNotice) {
      text =
        `${this.pendingStallNotice}\n\n` +
        `[harness note: the notice above is about the PREVIOUS turn — the one the harness cleared. ` +
        `It is not part of the user's message and the user did not write it. The user's message follows.]\n\n` +
        text;
      this.pendingStallNotice = null;
    }
    const images = turn.images ?? [];
    let content: unknown = text;
    if (images.length) {
      const blocks: unknown[] = [];
      for (const ref of images) {
        const b = await this.fetchImageBlock(ref);
        if (b) blocks.push(b);
      }
      if (blocks.length) content = [{ type: "text", text }, ...blocks];
    }
    return {
      type: "user",
      message: { role: "user", content } as SDKUserMessage["message"],
      parent_tool_use_id: null,
    };
  }

  /** MCP servers this run currently knows are DOWN, name → reconnect attempted.
   *  An episode opens when the `init` report or a turn-end status poll finds a
   *  configured server unusable (#1524), and closes when a later poll reads it
   *  connected again — whether our reconnect brought it back or the harness's
   *  own supervision did. The boolean bounds retries: ONE automatic reconnect
   *  per episode, so a server that stays down is reported once, not fought on
   *  every turn. */
  private mcpDown = new Map<string, boolean>();

  /** Say — in the log — that this session does not have servers it was given.
   *  Shared by the init check and the turn-end watch so both report identically. */
  private reportDegradedMcp(
    degraded: readonly DegradedMcpServer[],
    reported: readonly { name: string; status: string }[] | undefined,
    sessionId: string,
    when = "started",
  ): void {
    logger.error(
      `[claude-backend] session ${sessionId.slice(0, 8)} ${when} WITHOUT ` +
        `${degraded.map((d) => `${d.name}=${d.status ?? "absent"}`).join(" ")} ` +
        `(reported: ${(reported ?? []).map((s) => `${s.name}=${s.status}`).join(" ") || "none"})`,
    );
  }

  /**
   * One best-effort read of the harness's MCP server statuses. `undefined`
   * means "nothing learned" — a harness without the method, a poll that
   * throws, or an empty report all land here, and all three must leave the
   * session exactly as informed as before: silent, never guessed at.
   */
  private async pollMcpStatus(q: Query): Promise<Array<{ name: string; status: string }> | undefined> {
    try {
      const reported = await q.mcpServerStatus?.();
      return Array.isArray(reported) && reported.length > 0 ? reported : undefined;
    } catch (err) {
      logger.debug(`[claude-backend] mcpServerStatus: ${msgOf(err)}`);
      return undefined;
    }
  }

  /**
   * Watch the toolset for a MID-SESSION drop, and try to bring it back (#1524).
   *
   * The reporter's session came up healthy and lost all 92 panel_* tools hours
   * in: the harness's own reconnect brought `comfyui` back and never retried
   * the in-process panel server — and since `init` is the only MCP report a
   * session PUSHES, nothing host-side ever learned of it. There is no
   * mid-session push to listen for (the SDK's message vocabulary has none), so
   * the only detection is to ASK: one `mcpServerStatus()` poll per turn end —
   * turn-driven, so it needs no timer and cannot spam — read against the set
   * this session was actually given.
   *
   * Recovery is the SDK's own verb, `reconnectMcpServer()` ("reconnects a
   * disconnected or failed MCP server"), bounded to ONE attempt per
   * down-episode. The attempt is never claimed to have worked on the strength
   * of the call alone: the status is re-read once and the re-read is what the
   * notice quotes. `needs-auth` and `disabled` are reported but not retried —
   * the first waits on the user, the second is a deliberate off switch.
   *
   * Best-effort throughout: a harness without these control methods, or a poll
   * that throws, leaves the session as informed as it was before this existed
   * — silent — and never takes the turn stream down with it.
   */
  private async checkMcpServers(q: Query): Promise<AgentEvent[]> {
    const names = Object.keys(this.mcpServersForRun() ?? {});
    if (names.length === 0) return [];
    let reported = await this.pollMcpStatus(q);
    if (!reported) return [];
    const events: AgentEvent[] = [];

    // Attempt the one reconnect each down server is owed BEFORE reporting, so a
    // drop the reconnect fixes right away is narrated once and accurately,
    // instead of "gone" followed by "back". Servers just found down (no open
    // episode) and episodes opened at init (attempt owed to this turn boundary)
    // are both due; an episode already retried is not.
    const triable = inspectMcpServers(names, reported).degraded.filter(
      (d) => this.mcpDown.get(d.name) !== true && reconnectableMcpStatus(d.status),
    );
    const attempted = new Set<string>();
    // Whether the post-attempt status re-read was READ. "Reconnect failed" is
    // only claimable when it was — otherwise the still-down reading is the
    // pre-attempt one and the notice must not assert an outcome nobody saw.
    let verdictRead = true;
    if (typeof q.reconnectMcpServer === "function") {
      for (const d of triable) {
        attempted.add(d.name);
        this.mcpDown.set(d.name, true); // the attempt is spent, whatever it returns
        try {
          await q.reconnectMcpServer(d.name);
        } catch (err) {
          logger.debug(`[claude-backend] reconnectMcpServer(${d.name}): ${msgOf(err)}`);
        }
      }
      if (attempted.size > 0) {
        // The verdict on the attempts: re-read once. A failed re-read keeps the
        // pre-attempt reading — the servers stay "down" — the safe direction.
        const after = await this.pollMcpStatus(q);
        if (after) reported = after;
        else verdictRead = false;
      }
    }

    const degraded = inspectMcpServers(names, reported).degraded;
    const downNow = new Set(degraded.map((d) => d.name));

    // Episodes that CLOSED: the server reads connected again. An episode our
    // own attempt just closed says so; one the harness healed on its own
    // (the reporter watched `comfyui` do exactly this) is reported as what it
    // is — it came back, and we did not do it.
    const backByUs: string[] = [];
    const backOnItsOwn: string[] = [];
    for (const name of [...this.mcpDown.keys()]) {
      if (downNow.has(name)) continue;
      this.mcpDown.delete(name);
      (attempted.has(name) ? backByUs : backOnItsOwn).push(name);
    }
    if (backByUs.length) {
      logger.info(`[claude-backend] MCP reconnect brought back: ${backByUs.join(", ")}`);
      events.push({ type: "error", sessionNotice: true, message: recoveredMcpNotice(backByUs, true) });
    }
    if (backOnItsOwn.length) {
      logger.info(`[claude-backend] MCP servers connected again on their own: ${backOnItsOwn.join(", ")}`);
      events.push({ type: "error", sessionNotice: true, message: recoveredMcpNotice(backOnItsOwn, false) });
    }

    // Episodes still OPEN that have not been reported yet: a fresh drop whose
    // reconnect just failed, an init-time episode whose owed attempt failed
    // (the init notice promised the outcome), and drops there is no attempt
    // for. One line per server per episode — a server that stays down is not
    // re-narrated on every turn.
    const unreported = degraded.filter((d) => attempted.has(d.name) || !this.mcpDown.has(d.name));
    const failedAttempt = unreported.filter((d) => attempted.has(d.name));
    const notRetriable = unreported.filter(
      (d) => !attempted.has(d.name) && !reconnectableMcpStatus(d.status),
    );
    const unsupported = unreported.filter(
      (d) => !attempted.has(d.name) && reconnectableMcpStatus(d.status),
    );
    for (const d of unreported) this.mcpDown.set(d.name, true);
    if (failedAttempt.length) {
      // "Did not bring it back" is claimable only off the post-attempt re-read;
      // when that re-read could not be read the attempt is reported WITHOUT an
      // outcome — "did not come back" would be a claim nobody checked (#1228).
      const why = verdictRead ? "reconnect-failed" : "unverified";
      this.reportDegradedMcp(failedAttempt, reported, this.registrySessionId ?? "", "lost");
      events.push({
        type: "error",
        sessionNotice: true,
        message: unrecoveredMcpNotice(failedAttempt, why),
      });
    }
    if (notRetriable.length) {
      this.reportDegradedMcp(notRetriable, reported, this.registrySessionId ?? "", "lost");
      events.push({
        type: "error",
        sessionNotice: true,
        message: unrecoveredMcpNotice(notRetriable, "not-retriable"),
      });
    }
    if (unsupported.length) {
      this.reportDegradedMcp(unsupported, reported, this.registrySessionId ?? "", "lost");
      events.push({
        type: "error",
        sessionNotice: true,
        message: unrecoveredMcpNotice(unsupported, "unsupported"),
      });
    }
    return events;
  }

  /**
   * The MCP server set this session is given: the comfyui stdio child, plus the
   * in-process panel server when this key drives the canvas.
   *
   * Split out of buildOptions() so #1524's init check can name the servers we
   * ASKED for without re-deriving them. Deriving them twice is how the check
   * would end up comparing the session's report against a set the session was
   * never handed — which is a false alarm in one direction and blindness in the
   * other, and neither shows up in a test that builds both sides itself.
   */
  private mcpServersForRun(): Options["mcpServers"] {
    return {
      ...this.deps.mcpServers,
      // Live-graph control of THIS tab's open workflow (in-process; talks to
      // the bridge). Lets the agent build on what the user sees.
      ...(this.deps.panelServer ? { panel: this.deps.panelServer } : {}),
    };
  }

  private buildOptions(opts: BackendStartOptions): Options {
    const model = opts.model;
    const effort = toClaudeEffort(opts.effort);
    const resume = opts.resume;
    const rewindAnchor = opts.rewindAnchor;
    // Rewind: fork the conversation at the anchor (resume up to that message, then
    // branch into a new session id) so everything after it is dropped. A null
    // anchor means "fresh session" (handled by clearing resume below).
    //
    // #1700 — a plain `resume` restores the MCP server set recorded WITH that
    // session, so a panel_remove_mcp that re-read ~/.claude.json still launched
    // the deleted server (and kept reporting it as failed). `forkSession`
    // without an anchor keeps history but applies THIS run's mcpServers.
    const resumeTarget = opts.sessionId ?? resume;
    const rewindOpts = rewindAnchor
      ? { resume: resumeTarget, resumeSessionAt: rewindAnchor, forkSession: true }
      : opts.forkSession && resumeTarget
        ? { resume: resumeTarget, forkSession: true }
        : null;
    return {
      model,
      permissionMode: "bypassPermissions",
      // Required alongside bypassPermissions (intentional, isolated background agent).
      allowDangerouslySkipPermissions: true,
      // Stream partial assistant messages so the panel can show thinking + reply
      // text live (token-by-token) instead of only the final block. route() turns
      // these into onStream deltas; the final assistant message still commits the
      // authoritative text via onSay (reconciled by message id).
      includePartialMessages: true,
      mcpServers: this.mcpServersForRun(),
      // Only our comfyui MCP — never inherit the user's project/user MCP config
      // (which may run a second comfyui that grabs the bridge port).
      strictMcpConfig: true,
      // Blind (issue #90) must also bind the subprocess's NATIVE tools: Read
      // renders image files (and PDFs / notebook outputs) and WebFetch can hand
      // back ComfyUI's own /view content, both entirely outside the MCP scrub.
      // The hook consults isBlind() per call, so a live toggle applies to the
      // NEXT tool call — no respawn required, unlike the env gate.
      hooks: {
        PreToolUse: [{ hooks: [makeBlindNativeHook(this.deps.isBlind) as never] }],
      },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: this.deps.systemAppend,
      },
      // Reasoning effort, when the picker has set one.
      ...(effort ? { effort } : {}),
      // Load the bundled comfyui-mcp plugin so the agent has model expertise
      // (IDEOGRAM/WAN/LTX/Qwen/… skills) out of the box — "install the package
      // = expert agent". Omitted if the plugin dir can't be found.
      ...(this.deps.pluginPath
        ? {
            plugins: [{ type: "local" as const, path: this.deps.pluginPath }],
            skills: "all" as const,
          }
        : {}),
      ...(rewindOpts ?? (resume ? { resume } : {})),
      // SECURITY: the SDK spawns a Claude Code subprocess; `env` REPLACES its
      // environment entirely. Pass the agent env (process.env MINUS tool-only
      // secrets — RunPod/HF/CivitAI tokens) so tool credentials never reach the
      // LLM subprocess. Claude auth is OAuth-file-based (no env key needed).
      env: buildAgentSpawnEnv(),
    } as Options;
  }

  /**
   * Open the Claude session and yield canonical AgentEvents. The user channel
   * (PanelAgent's gated queue) is shaped turn-by-turn into `SDKUserMessage`s by
   * `shapeTurn`; the SDK's `SDKMessage`s are normalized into `AgentEvent`s.
   */
  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    const query = await loadQuery();
    const self = this;
    // A (re)started session can never produce results for turns submitted to a
    // PREVIOUS session through the live FIFO — clear it and advance the result
    // sequence past EVERY turn stamped so far (turnSeq), whether or not traces
    // remain: in a FULLY DRAINED (e.g. poisoned) session the FIFO is already
    // empty, but the sequence must still move past the old ids or the new
    // session's first result re-crosses the old gap and falsely re-poisons
    // (#745 r5). This genuine restart boundary is also the ONLY reset of the
    // sticky classification poison (#745 r4). Done here, at run() entry (BEFORE
    // the new query exists), rather than on system/init: the SDK's prompt drain
    // legitimately pulls the first batch before init is processed, and an
    // init-time clear would unmark that genuinely in-flight turn (#745).
    //
    // But "the trace is gone" must not become "no turn was ever submitted"
    // (#886): the dead session's unresolved ids are REMEMBERED (and, when this
    // run RESUMES a session, rehydrated from the durable registry a previous
    // process wrote), so a stray late result is recognized as a submitted
    // turn's late landing and reported "completed but unverified" instead of
    // "matched to no submitted turn". Recognition never upgrades a result to
    // ok:true — fail-closed stands.
    for (const dead of this.turns) this.rememberDeadTurn(`${this.instanceId}:${dead.id}`);
    this.turns.length = 0;
    this.lastResultTurnId = this.turnSeq;
    this.classificationPoisoned = false;
    // #1524 — MCP health is per SESSION. A restart re-runs every connection, so
    // the previous run's down-episodes and their "already retried" marks must
    // not suppress the new session's report or its one reconnect attempt.
    this.mcpDown.clear();
    this.parkedInterrupted.clear(); // dead session's parks die with it
    this.consumedInterrupted.clear(); // …and its landing history
    this.markerBase = this.lastResultTurnId; // turn markers are run-relative (#728)
    const resumeTarget = opts.resume ?? opts.sessionId ?? null;
    // Registry writes before init (the prompt drain can submit ahead of it)
    // file under the resume target — the session they will actually run in.
    // A fresh start files nothing until init names the new session.
    this.registrySessionId = resumeTarget;
    if (resumeTarget) {
      const loaded = loadTurnRegistry(resumeTarget);
      // Hydrate whatever the session's files prove is outstanding — including
      // this instance's OWN file (tags dedupe against the in-memory carry, and
      // tombstones keep already-reported strays from resurrecting). A degraded
      // or self-declared-incomplete record must not later ground the confident
      // "matched to no submitted turn".
      for (const tag of loaded.tags) this.rememberDeadTurn(tag);
      if (loaded.kind === "degraded" || loaded.incomplete) {
        this.registryDegraded = true;
        logger.warn(
          `[claude-backend] turn registry for the resumed session is ${loaded.kind === "degraded" ? `unreadable (${loaded.reason})` : "incomplete"} — outstanding-turn recognition is degraded (#886)`,
        );
      }
    }
    // Wrap the neutral channel: shape each turn into the SDK's native form right
    // before it's read, so PanelAgent never deals in SDKUserMessage.
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      for await (const turn of opts.channel) {
        const msg = await self.shapeTurn(turn);
        // The batch is handed to the SDK: stamp the turn's identity. Its trace
        // accrues this turn's content/block/interrupt flags until its terminal
        // result pops it (FIFO) for classification. Bounded: wedged turns whose
        // result never arrives would otherwise grow the queue without limit.
        // Eviction is recorded via the id sequence — the pop that crosses the
        // evicted gap fails closed as unverifiable (#745 r3), it does NOT
        // silently realign classification onto the wrong turn.
        self.turns.push({ id: ++self.turnSeq, hasContent: false, blockReason: null, interrupted: false });
        if (self.turns.length > MAX_UNRESOLVED_TURNS) {
          const evicted = self.turns.shift();
          logger.warn(
            `[claude-backend] over ${MAX_UNRESOLVED_TURNS} unresolved turns — evicted turn ${evicted?.id}'s trace; its result will fail closed as unverifiable (#740)`,
          );
        }
        self.saveRegistry(); // the submission record must survive a restart (#886)
        yield msg;
      }
    }
    const q = query({ prompt: prompt(), options: this.buildOptions(opts) });
    this.q = q;
    // TURN MARKERS (#728): stamp every event with the marker of the turn it
    // BELONGS to, derived from the #745 per-turn trace FIFO (the SDK's input
    // pump and output reader are independent streams, so the marker can't ride
    // the input side). RESULT-message events are stamped by route() itself with
    // the trace it popped (the result's OWN turn, subtype-aware — #728 r5);
    // every other message is stamped here with the NEWEST in-flight trace (the
    // turn currently producing output). markerBase re-zeroes the backend-wide
    // trace ids per run (1 = this run's first turn), matching PanelAgent's
    // per-dispatch mirror (Nth submitted turn = marker N).
    for await (const message of q) {
      // LIVENESS: every SDKMessage — including the ones route() doesn't translate
      // (tool-progress, rate-limit, etc.) — is a sign the session is alive, so
      // re-arm PanelAgent's idle watchdog. Claude already streams continuously, so
      // this is effectively a no-op for behavior here; it keeps the watchdog's
      // re-arm source uniform across both backends via the port.
      opts.onActivity?.();
      const streamTurn = this.turns[this.turns.length - 1]?.id;
      for (const ev of this.route(message)) {
        // Session init arrives OUTSIDE any turn — leave it unstamped (an
        // unmarked event is never dead-lettered). Result-message events arrive
        // pre-stamped by route().
        if (ev.type === "session" || message.type === "result") {
          yield ev;
          continue;
        }
        yield streamTurn === undefined ? ev : { ...ev, turn: streamTurn - this.markerBase };
      }
      // #1524 — watch the toolset at every turn end: poll the servers this
      // session was given, attempt the one reconnect each down server is owed,
      // and narrate the outcome. Placed here rather than in route() because it
      // has to await control requests, and after the turn's own events so a
      // session notice never interleaves into the middle of a reply.
      if (message.type === "result") {
        for (const ev of await this.checkMcpServers(q)) yield ev;
      }
    }
  }

  /** Switch the model live (the SDK applies it to the next turn). */
  async setModel(model: string): Promise<void> {
    try {
      // setModel is live: no session restart, the next turn uses it. The optional
      // call keeps an older SDK (or a test double) without setModel a silent no-op.
      await this.q?.setModel?.(model);
    } catch (err) {
      logger.debug(`[claude-backend] setModel: ${msgOf(err)}`);
    }
  }

  async interrupt(): Promise<void> {
    // Scope the empty-turn blessing to the turn actually in flight (the latest
    // unresolved submission): an interrupt() with NO turn in flight leaves no
    // state behind, and a superseded turn's trace keeps whatever mark IT earned
    // (#745 review).
    const active = this.turns[this.turns.length - 1];
    if (active) active.interrupted = true;
    await this.q?.interrupt();
  }

  /**
   * #885 — record the harness-stall notice so the NEXT user turn carries it
   * into the transcript beside the interrupt's generic user-rejection payload
   * (see the pendingStallNotice field comment for why the notice cannot ride
   * the stalled turn itself on this provider). Returns false: no mid-turn
   * steer exists here, so PanelAgent keeps its bounded interrupt/restart
   * recovery for the frozen turn — the notice's job is only to stop the agent
   * from telling the user THEY cancelled, and to tell it a retry is safe.
   */
  async recoverStalledTurn(notice: string): Promise<boolean> {
    if (notice.trim()) {
      this.pendingStallNotice = notice;
      this.pendingStallNoticeTurn = this.turnSeq;
    }
    return false;
  }

  /** Permanently dispose of the live SDK query. The Agent SDK has no explicit
   *  "dispose" beyond interrupt(), which both stops the in-flight turn and lets
   *  the underlying transport wind down once the prompt generator is no longer
   *  iterated (PanelAgent.stop() closes the channel before calling this). We then
   *  drop our reference so the query can be GC'd. Idempotent + safe when never
   *  started (q is null) — and a true no-op for Claude's behavior: stop() already
   *  called interrupt(), so this only releases the reference. */
  async close(): Promise<void> {
    const q = this.q;
    this.q = null;
    if (!q) return;
    try {
      await q.interrupt();
    } catch {
      // already winding down / never fully started
    }
  }

  async listModels(): Promise<ModelChoice[]> {
    return [];
  }

  /** Remember a submitted turn whose result can no longer arrive through the
   *  live FIFO (its session restarted). Recognition-only (#886): membership
   *  changes what an unmatched result can honestly be CALLED, never how it is
   *  classified. Bounded — oldest drops first, but a drop means the record is
   *  no longer provably complete, so it degrades recognition (the hedged
   *  wording) rather than silently reverting to the confident negative. */
  private rememberDeadTurn(tag: string): void {
    if (this.rememberedDeadTurns.has(tag)) return;
    this.rememberedDeadTurns.add(tag);
    if (this.rememberedDeadTurns.size > MAX_REMEMBERED_DEAD_TURNS) {
      const oldest = this.rememberedDeadTurns.keys().next().value;
      if (oldest !== undefined) this.rememberedDeadTurns.delete(oldest);
      this.registryDegraded = true;
      this.rememberedIncomplete = true; // persisted — a respawn must hedge too
      logger.warn(
        `[claude-backend] over ${MAX_REMEMBERED_DEAD_TURNS} remembered dead turns — dropped the oldest record; outstanding-turn recognition is degraded (#886)`,
      );
    }
  }

  /** Consume the oldest remembered dead-turn tag, if any — a recognized late
   *  landing spends the record (in memory, in this instance's file, and in the
   *  session's tombstones) so a second stray can never re-claim it. */
  private takeOldestRememberedDeadTurn(): string | null {
    const oldest = this.rememberedDeadTurns.keys().next().value;
    if (oldest === undefined) return null;
    this.rememberedDeadTurns.delete(oldest);
    const sid = this.registrySessionId;
    if (sid) {
      try {
        tombstoneTurn(sid, oldest);
      } catch (err) {
        // A lost tombstone can only REVIVE an already-reported record (a
        // repeated hedged disclosure) — never a fabricated success. Log, move on.
        logger.warn(`[claude-backend] turn tombstone write failed: ${msgOf(err)} (#886)`);
      }
    }
    this.saveRegistry();
    return oldest;
  }

  /** Persist which submitted turns are still outstanding (#886). A failure
   *  degrades recognition (flagged + logged) but must never break the turn
   *  itself — the registry is a recognition aid, not load-bearing for the
   *  turn in flight.
   *
   *  Ordering: saves happen AFTER the trace push/pop they record. A crash in
   *  the pop→save window leaves a STALE record (a turn whose result was seen
   *  still listed outstanding) — over-recognition, which produces the hedged
   *  "completed but unverified" disclosure. The reverse order could LOSE a
   *  record, and a lost record produces the confident "matched to no
   *  submitted turn" — a false assertion — so over-recognition is the
   *  deliberate failure side. */
  private saveRegistry(): void {
    const sid = this.registrySessionId;
    if (!sid) return;
    try {
      saveTurnRegistry(
        sid,
        this.instanceId,
        this.turns.map((t) => t.id),
        [...this.rememberedDeadTurns],
        this.rememberedIncomplete,
      );
    } catch (err) {
      this.registryDegraded = true;
      logger.warn(
        `[claude-backend] turn registry write failed: ${msgOf(err)} — outstanding-turn recognition is degraded (#886)`,
      );
    }
  }

  /** Normalize one SDK message into zero or more canonical AgentEvents. */
  private *route(message: SDKMessage): Generator<AgentEvent> {
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          // New session (or a restarted one). No turn state is reset here: all
          // of it is per-turn (the `turns` FIFO), and dead traces from a
          // previous session were already carried into `rememberedDeadTurns`
          // at run() entry — an init-time clear could unmark a turn the prompt
          // drain already handed to the SDK before this init was processed
          // (#745 review).
          // The durable turn registry is keyed by THIS session id from now on
          // (#886) — including a pre-init submission the prompt drain already
          // pulled, which couldn't be filed before the session id was known.
          this.registrySessionId = message.session_id;
          this.saveRegistry();
          yield {
            type: "session",
            sessionId: message.session_id,
            ...(message.model ? { model: message.model } : {}),
          };
          logger.info(
            `[panel-agent] init model=${message.model} session=${message.session_id.slice(0, 8)} apiKeySource=${message.apiKeySource} skills=${message.skills?.length ?? 0}`,
          );
          // #1524 — the session just told us which of its MCP servers actually
          // connected. Say so when one did not, instead of letting the agent run
          // for hours against a toolset that was silently thinned. This is the
          // reported failure exactly: `comfyui` came back after a mid-session
          // drop, the 92 `panel_*` tools did not, and the only signal anywhere
          // was a tool-list diff the agent had to notice on its own.
          //
          // It reports the observation, not a cause. WHY a server goes missing is
          // still open on #1524 and the candidates need different fixes; this
          // fires the same either way, which is the point — it turns a silent,
          // unreproducible degradation into one that names itself the moment it
          // happens, on whichever transport it happens to.
          const health = inspectMcpServers(
            Object.keys(this.mcpServersForRun() ?? {}),
            message.mcp_servers,
          );
          // A server still CONNECTING at init is not a failure — server startup
          // does not block the session, so a slow one is legitimately `pending`
          // here and connected a moment later. It needs no tracking of its own:
          // the turn-end watch (checkMcpServers) reads every configured server
          // at each turn boundary, so a pending server that goes on to FAIL
          // surfaces there as a fresh drop, and one that connects simply never
          // opens an episode.
          //
          // A server already DOWN at init opens its episode now — reported
          // below, with the reconnect it is owed landing at the first turn end.
          for (const d of health.degraded) this.mcpDown.set(d.name, false);
          if (health.degraded.length) {
            this.reportDegradedMcp(health.degraded, message.mcp_servers, message.session_id);
            yield { type: "error", sessionNotice: true, message: degradedMcpNotice(health.degraded) };
          }
          // #2742 — the check above compares STATUS, and the variant five reporters
          // hit on 0.52.174-0.52.178 passes it: `panel=connected` in every session
          // with zero panel_* tools reaching the model. `connected` was being read
          // as proof of a usable toolset. The init message carries the tool list, so
          // the emptiness is right there and was simply never looked at — which is
          // why the reporters had to establish it with ToolSearch, and one
          // reinstalled twice while every signal said the panel was fine.
          const emptyServers = serversWithoutTools(
            Object.keys(this.mcpServersForRun() ?? {}),
            message.mcp_servers,
            message.tools,
          );
          if (emptyServers.length) {
            logger.error(
              `[claude-backend] session ${message.session_id.slice(0, 8)} started with MCP server(s) ` +
                `${emptyServers.join(", ")} CONNECTED but contributing zero tools ` +
                `(tools=${message.tools?.length ?? 0}, mcp tools=${(message.tools ?? []).filter((t) => t.startsWith("mcp__")).length})`,
            );
            yield { type: "error", sessionNotice: true, message: emptyToolsMcpNotice(emptyServers) };
          }
        } else if (message.subtype === "thinking_tokens") {
          // Live extended-thinking token count → drives a "thinking… (N)" meter
          // so the user can see the agent reasoning (not stuck) before any text.
          const t = message.estimated_tokens;
          if (typeof t === "number") {
            yield { type: "thinking", tokens: t };
          }
        } else if (message.subtype === "informational") {
          // #740: SDK informational banners are host-rendered plaintext (hook
          // feedback, status lines, slash-command notices) — never drop one the
          // turn logic depends on. A BLOCKING one (prevent_continuation, e.g. a
          // UserPromptSubmit hook denied the prompt) means execution stops here,
          // yet the SDK still ends the turn with a result whose subtype is
          // "success". Record the reason on the CURRENT turn's trace so that
          // turn's result is classified as the failure it actually is, and
          // surface the reason now so the user never watches a turn silently
          // produce nothing.
          // Older SDK builds spelled the flag in camelCase; the `in` probe reads
          // it without claiming the typed message carries it.
          const prevent =
            message.prevent_continuation === true ||
            ("preventContinuation" in message && message.preventContinuation === true);
          const content = typeof message.content === "string" ? message.content.trim() : "";
          if (prevent) {
            const reason = content || "blocked by a hook";
            const turn = this.turns[this.turns.length - 1];
            if (turn) turn.blockReason = reason;
            logger.warn(`[claude-backend] turn blocked: ${reason}`);
            yield {
              type: "error",
              message: content || "The turn was blocked before it could produce a reply.",
            };
          } else if (content) {
            // Non-blocking notices don't affect turn classification — the panel
            // doesn't render them, but keep them visible in the log.
            logger.info(`[claude-backend] informational (${message.level ?? "info"}): ${content}`);
          }
        } else if (message.subtype === "local_command_output") {
          // Slash-command output (/usage, /voice, …) IS the turn's visible
          // payload, so the turn counts as having content and is not
          // misclassified as an empty one. (The panel doesn't render these
          // banners today — unchanged.)
          const turn = this.turns[this.turns.length - 1];
          if (turn) turn.hasContent = true;
        }
        break;
      case "stream_event": {
        // Live partial output (includePartialMessages). Turn the raw Anthropic
        // stream events into thinking/reply deltas the panel renders token-by-
        // token. The authoritative text still commits via the `assistant` case.
        const ev = message.event;
        if (!ev) break;
        if (ev.type === "message_start") {
          const mid = ev.message?.id;
          yield { type: "stream_start", id: typeof mid === "string" ? mid : null };
        } else if (ev.type === "content_block_delta") {
          const d = ev.delta;
          if (!d) break;
          if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking) {
            yield { type: "assistant_delta", text: d.thinking, thinking: true };
          } else if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
            yield { type: "assistant_delta", text: d.text };
          }
        } else if (ev.type === "message_stop") {
          yield { type: "stream_end" };
        }
        break;
      }
      case "assistant": {
        // An assistant message means the model actually responded — the CURRENT
        // (latest submitted, still unresolved) turn counts as having content
        // (#740). In-stream messages always belong to the newest in-flight turn:
        // a superseded turn's output ends with its own result, which pops it.
        const turn = this.turns[this.turns.length - 1];
        if (turn) turn.hasContent = true;
        // Remember this message's UUID — it's the rewind anchor for the turn.
        const auid = message.uuid;
        // Each assistant API response carries the CURRENT context size — report
        // it live so the meter updates throughout the turn, not just at the end.
        const u = message.message?.usage;
        // Commit the authoritative reply text as ONE message. With streaming on,
        // the panel already showed a live preview (matched by this message id);
        // the commit replaces it with the final text. Without streaming (or for
        // injected events), it just renders a normal bubble.
        const content = (message.message?.content ?? []) as Array<{
          type: string;
          text?: string;
          name?: string;
        }>;
        const text = content
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("\n\n")
          .trim();
        const id = message.message?.id;
        yield {
          type: "assistant",
          text,
          ...(typeof auid === "string" ? { uuid: auid } : {}),
          ...(id ? { id } : {}),
          ...(u ? { usage: u } : {}),
        };
        // TOOL VISIBILITY: surface each tool the agent invoked as a tool_call
        // event, so a canvas-less mobile client can show the agent's actions
        // (not just a spinner). The panel infers these from its live canvas.
        for (const b of content) {
          if (b.type === "tool_use" && typeof b.name === "string") {
            yield { type: "tool_call", name: b.name, phase: "start" };
          }
        }
        break;
      }
      case "result": {
        // Cache the context window + cost from the result, then re-report using
        // the last assistant usage (the true current context).
        let contextWindow: number | undefined;
        for (const mu of Object.values(message.modelUsage ?? {})) {
          if (mu?.contextWindow && (contextWindow === undefined || mu.contextWindow > contextWindow)) {
            contextWindow = mu.contextWindow;
          }
        }
        // #740: classify the result truthfully, against the trace of the turn it
        // BELONGS to (#745 r2). Results arrive in submission order, so the oldest
        // unresolved trace is this result's turn — even when the result is LATE
        // (an earlier turn was interrupted, produced nothing, and the panel's
        // fallback already released the next turn; panel-agent.ts:671 tolerates
        // that late result, and so does this FIFO: popping the old trace leaves
        // the in-flight turn's state untouched). The SDK reports subtype
        // "success" even for a turn a blocking hook prevented from producing ANY
        // output, and for a turn that simply ended with no assistant message —
        // the panel must never present either as a silent empty success.
        //
        // FAIL CLOSED (#745 r3/r4): ok:true requires positive evidence. A normal
        // successful turn ALWAYS has a trace (stamped at submission), so a
        // result that is TRACELESS (stray from a dead session, or pushed off by
        // the MAX_UNRESOLVED_TURNS bound) or whose id crosses an EVICTED-turn
        // gap is anomalous by construction — unverifiable, never a forwarded
        // success. (The panel consumes every result as completion/done, so a
        // pass-through would NOT be inert.) The gap case is STICKY: alignment
        // is unrecoverable once crossed, so the poison is terminal for the
        // session — content evidence must not rescue it (it accrued to a
        // mismatched trace, which is not proof of ITS turn's success).
        // SUBTYPE-AWARE correlation on the SDK's REAL result vocabulary
        // (#728 r5–r10): results arrive as `success` or `error_*` — an
        // interrupted turn ends with an error_during_execution result (the
        // interrupt landing); there is no "interrupted" result subtype.
        //
        // UNIFORM write-off (r10): an interrupted turn the PANEL killed (its
        // trace is marked) that was then SUPERSEDED by a newer submission never
        // delivers — the turn gate only submits newer work after the older
        // turn's result was written off. So for EVERY landing (success or
        // error_*): any interrupted-marked trace OLDER than the oldest LIVE
        // non-interrupted trace is written off (parked as lost), and the
        // landing pops that oldest live non-interrupted trace — a healthy
        // turn's genuine success or error classifies by ITS flags (a genuine
        // error_during_execution from a healthy newer turn is NOT blessed and
        // is NOT attributed to the killed older turn). With NO live
        // non-interrupted trace, the landing is an interrupt landing and pops
        // the oldest LIVE interrupted trace (kills settle in submission order —
        // the older turn's legitimate landing still pops the older trace, even
        // when a newer interrupted turn's trace exists from queued input), else
        // the oldest PARKED-but-unconsumed interrupted trace (a late landing
        // for a written-off turn — the r6 tolerance), else nothing (anomalous
        // → traceless fail-closed below). Each trace still lands at most once
        // (landed parks move to consumedInterrupted).
        const resultSubtype: string = message.subtype;
        const oldestLive = this.turns.findIndex((t) => !t.interrupted);
        if (oldestLive > 0) {
          for (let i = 0; i < oldestLive; i++) {
            if (this.turns[i].interrupted) this.parkedInterrupted.add(this.turns[i].id);
          }
        }
        let idx = oldestLive;
        if (idx < 0) {
          idx = this.turns.findIndex((t) => t.interrupted && !this.parkedInterrupted.has(t.id));
        }
        if (idx < 0) {
          idx = this.turns.findIndex(
            (t) => t.interrupted && this.parkedInterrupted.has(t.id) && !this.consumedInterrupted.has(t.id),
          );
        }
        const trace = idx >= 0 ? (this.turns.splice(idx, 1)[0] ?? null) : null;
        if (trace) {
          // The pop retires the turn's outstanding record (#886) — in this
          // instance's own file AND in the session's tombstones: a concurrent
          // resumer may have copied this turn's id into its own file as a dead
          // record while it was still live, and only a tombstone invalidates
          // that replica (rewriting this instance's file does not). A lost
          // tombstone can only revive the copy as a hedged over-recognition —
          // never a fabricated success — so a failure logs and moves on.
          const sid = this.registrySessionId;
          if (sid) {
            try {
              tombstoneTurn(sid, `${this.instanceId}:${trace.id}`);
            } catch (err) {
              logger.warn(`[claude-backend] turn tombstone write failed: ${msgOf(err)} (#886)`);
            }
          }
          this.saveRegistry();
        }
        let unverifiable: string | null = null;
        // #886: an unmatched result with a REMEMBERED outstanding submission is
        // a different report than one with none. Both fail closed — only the
        // honesty of the message differs.
        let unverifiedCompletion = false;
        if (this.classificationPoisoned) {
          unverifiable = "Turn bookkeeping was poisoned by an earlier overflow — no result in this session can be verified";
        } else if (!trace) {
          const deadId = this.takeOldestRememberedDeadTurn();
          if (deadId !== null) {
            // A turn WAS submitted (before a session restart dropped its trace)
            // and never reported an outcome — this result is most plausibly its
            // late landing. Say exactly that: not a success (unverifiable — the
            // match is inference, not proof), and not a failure either — the
            // turn may have finished real work, and "turn failed, try again"
            // would invite a destructive duplicate retry.
            unverifiedCompletion = true;
            unverifiable =
              `A result (reported as "${resultSubtype}") arrived that matches no live turn, but a turn ` +
              `submitted before the session restarted never reported an outcome — this is most likely that ` +
              `turn completing late. It may have finished real work (files written, changes made), yet I ` +
              `cannot verify which turn it was, so I am NOT counting it as a success. Check what that turn ` +
              `was doing before asking for it again, so the work is not done twice.`;
            logger.warn(
              `[claude-backend] traceless result (${resultSubtype}) recognized as a likely late landing for a pre-restart submitted turn — completed but unverified, failing closed (#886)`,
            );
          } else if (this.registryDegraded) {
            // The recognition record itself is not provably complete — do not
            // assert the negative as confidently as a healthy registry allows.
            unverifiable =
              "The result could not be matched to any submitted turn, and the durable turn record " +
              "could not be fully read or written, so an outstanding earlier submission can't be ruled out";
            logger.warn(`[claude-backend] ${unverifiable} — unverifiable, failing closed (#740/#886)`);
          } else {
            unverifiable = "The result could not be matched to any submitted turn";
            logger.warn(`[claude-backend] ${unverifiable} — unverifiable, failing closed (#740)`);
          }
        } else {
          let crossesGap = false;
          if (trace.id > this.lastResultTurnId + 1) {
            // Forward jump: legit only when EVERY skipped id is a parked
            // interrupted trace; anything else is an evicted-turn gap.
            for (let id = this.lastResultTurnId + 1; id < trace.id && !crossesGap; id++) {
              if (!this.parkedInterrupted.has(id)) crossesGap = true;
            }
          } else if (trace.id <= this.lastResultTurnId) {
            // Backward pop: legit only for a parked (or landed-once) interrupted
            // trace's deferred landing.
            crossesGap = !(this.parkedInterrupted.has(trace.id) || this.consumedInterrupted.has(trace.id));
          }
          if (crossesGap) {
            // The pop crossed an evicted-turn gap → poison the session (do NOT
            // advance lastResultTurnId to the wrong trace's id — alignment is
            // unrecoverable, so resyncing would just hide the next mismatch).
            this.classificationPoisoned = true;
            unverifiable = "Turn bookkeeping overflowed, so the result cannot be matched to its turn";
            logger.warn(
              `[claude-backend] result crosses an evicted-turn gap (popped turn ${trace.id}, expected ${this.lastResultTurnId + 1}) — unverifiable; classification poisoned for the rest of the session (#740)`,
            );
          } else {
            // A legitimately popped park is now LANDED — consumed once, so a
            // second landing for it finds no candidate (#728 r6).
            if (this.parkedInterrupted.delete(trace.id)) this.consumedInterrupted.add(trace.id);
            if (trace.id > this.lastResultTurnId) this.lastResultTurnId = trace.id;
          }
        }
        // The result's OWN turn marker (#728): stamped here, where the trace it
        // popped is known (a per-message stamp in run() could not see the
        // subtype-aware skip). A traceless result stays UNMARKED so its
        // fail-closed error and gate completion still reach the panel.
        const stamp = trace ? { turn: trace.id - this.markerBase } : {};
        // An interrupted turn's terminal (an error_during_execution landing for
        // its own interrupted-marked trace) is the interrupt LANDING, not a
        // failure — blessed like a success; the empty-turn guard below still
        // spares it. Any other error_* subtype classifies by the trace's own
        // flags (a genuine failure for a non-interrupted turn).
        let ok =
          resultSubtype === "success" ||
          (resultSubtype === "error_during_execution" && trace !== null && trace.interrupted);
        if (unverifiable !== null) {
          // Fail closed with the reason VISIBLE — including an anomalous
          // interrupted landing with no unconsumed candidate (#728 r6), whose
          // ok is already false.
          ok = false;
          yield {
            type: "error",
            // The recognized late landing's message is self-contained (it says
            // "not counted as a success" itself) and flagged so the panel
            // doesn't frame it as a failure (#886).
            message: unverifiedCompletion
              ? unverifiable
              : `${unverifiable} — reporting the turn as unverifiable rather than a success.`,
            ...(unverifiedCompletion ? { unverifiedCompletion: true } : {}),
            ...stamp,
          };
        } else if (ok && trace !== null && trace.blockReason !== null) {
          // The blocking informational already yielded the visible error above.
          ok = false;
        } else if (ok && trace !== null && !trace.hasContent && !trace.interrupted) {
          ok = false;
          logger.warn("[claude-backend] result/success with no assistant content — reporting a failed turn (#740)");
          yield {
            type: "error",
            message: "The model ended the turn without producing a reply.",
            ...stamp,
          };
        }
        // #885: a SELF landing for the stalled turn (success OR a genuine
        // error — i.e. not the interrupt's doing) means the turn ended on its
        // own and no rejection payload ever landed in the transcript, so the
        // held correction would be stale; drop it. An INTERRUPT landing
        // (trace.interrupted) is exactly the case the notice exists for.
        if (
          this.pendingStallNotice !== null &&
          trace !== null &&
          !trace.interrupted &&
          trace.id >= this.pendingStallNoticeTurn
        ) {
          this.pendingStallNotice = null;
        }
        yield {
          type: "result",
          ok,
          subtype: message.subtype,
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(typeof message.total_cost_usd === "number" ? { costUsd: message.total_cost_usd } : {}),
          ...stamp,
        };
        break;
      }
      default:
        // Parity with the original route(): other SDK message types (incl. SDK
        // rate-limit and tool-progress events) are not surfaced — the panel never
        // consumed them. The canonical AgentEvent union still declares `rate_limit`
        // and `tool_call` for other backends / a future Claude enhancement to emit.
        break;
    }
  }
}
