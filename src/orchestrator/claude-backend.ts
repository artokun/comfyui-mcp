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
// docs/design/agent-backend-injection.md.

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
import {
  type AgentBackend,
  type AgentEvent,
  type BackendStartOptions,
  type ModelChoice,
  type NeutralTurn,
  CLAUDE_CAPABILITIES,
} from "./agent-backend.js";
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
  return err instanceof Error ? err.message : String(err);
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
}

/**
 * The Claude Agent SDK adapter. One instance per PanelAgent; it holds the live
 * `Query` for the current session and re-creates it on each `run()`.
 */
export class ClaudeBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  private deps: ClaudeBackendDeps;
  private q: Query | null = null;

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
   *  view_image/get_image round-trip). */
  private async shapeTurn(turn: NeutralTurn): Promise<SDKUserMessage> {
    const text = turn.text;
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

  private buildOptions(opts: BackendStartOptions): Options {
    const model = opts.model;
    const effort = toClaudeEffort(opts.effort);
    const resume = opts.resume;
    const rewindAnchor = opts.rewindAnchor;
    // Rewind: fork the conversation at the anchor (resume up to that message, then
    // branch into a new session id) so everything after it is dropped. A null
    // anchor means "fresh session" (handled by clearing resume below).
    const rewindOpts = rewindAnchor
      ? { resume: opts.sessionId ?? resume, resumeSessionAt: rewindAnchor, forkSession: true }
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
      mcpServers: {
        ...this.deps.mcpServers,
        // Live-graph control of THIS tab's open workflow (in-process; talks to
        // the bridge). Lets the agent build on what the user sees.
        ...(this.deps.panelServer ? { panel: this.deps.panelServer } : {}),
      },
      // Only our comfyui MCP — never inherit the user's project/user MCP config
      // (which may run a second comfyui that grabs the bridge port).
      strictMcpConfig: true,
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
    // Wrap the neutral channel: shape each turn into the SDK's native form right
    // before it's read, so PanelAgent never deals in SDKUserMessage.
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      for await (const turn of opts.channel) {
        yield await self.shapeTurn(turn);
      }
    }
    const q = query({ prompt: prompt(), options: this.buildOptions(opts) });
    this.q = q;
    for await (const message of q) {
      // LIVENESS: every SDKMessage — including the ones route() doesn't translate
      // (tool-progress, rate-limit, etc.) — is a sign the session is alive, so
      // re-arm PanelAgent's idle watchdog. Claude already streams continuously, so
      // this is effectively a no-op for behavior here; it keeps the watchdog's
      // re-arm source uniform across both backends via the port.
      opts.onActivity?.();
      yield* this.route(message);
    }
  }

  /** Switch the model live (the SDK applies it to the next turn). */
  async setModel(model: string): Promise<void> {
    try {
      // setModel is live: no session restart, the next turn uses it.
      await (this.q as unknown as { setModel?: (m: string) => Promise<void> })?.setModel?.(model);
    } catch (err) {
      logger.debug(`[claude-backend] setModel: ${msgOf(err)}`);
    }
  }

  async interrupt(): Promise<void> {
    await this.q?.interrupt();
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

  /** Normalize one SDK message into zero or more canonical AgentEvents. */
  private *route(message: SDKMessage): Generator<AgentEvent> {
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          yield {
            type: "session",
            sessionId: message.session_id,
            ...(message.model ? { model: message.model } : {}),
          };
          logger.info(
            `[panel-agent] init model=${message.model} session=${message.session_id.slice(0, 8)} apiKeySource=${message.apiKeySource} skills=${message.skills?.length ?? 0}`,
          );
        } else if (message.subtype === "thinking_tokens") {
          // Live extended-thinking token count → drives a "thinking… (N)" meter
          // so the user can see the agent reasoning (not stuck) before any text.
          const t = (message as unknown as { estimated_tokens?: number }).estimated_tokens;
          if (typeof t === "number") {
            yield { type: "thinking", tokens: t };
          }
        }
        break;
      case "stream_event": {
        // Live partial output (includePartialMessages). Turn the raw Anthropic
        // stream events into thinking/reply deltas the panel renders token-by-
        // token. The authoritative text still commits via the `assistant` case.
        const ev = (message as unknown as { event?: Record<string, unknown> }).event;
        if (!ev) break;
        const evType = ev.type as string | undefined;
        if (evType === "message_start") {
          const mid = (ev.message as { id?: string } | undefined)?.id;
          yield { type: "stream_start", id: typeof mid === "string" ? mid : null };
        } else if (evType === "content_block_delta") {
          const d = ev.delta as { type?: string; text?: string; thinking?: string } | undefined;
          if (!d) break;
          if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking) {
            yield { type: "assistant_delta", text: d.thinking, thinking: true };
          } else if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
            yield { type: "assistant_delta", text: d.text };
          }
        } else if (evType === "message_stop") {
          yield { type: "stream_end" };
        }
        break;
      }
      case "assistant": {
        // Remember this message's UUID — it's the rewind anchor for the turn.
        const auid = (message as unknown as { uuid?: string }).uuid;
        // Each assistant API response carries the CURRENT context size — report
        // it live so the meter updates throughout the turn, not just at the end.
        const u = (message.message as unknown as { usage?: Record<string, number> })?.usage;
        // Commit the authoritative reply text as ONE message. With streaming on,
        // the panel already showed a live preview (matched by this message id);
        // the commit replaces it with the final text. Without streaming (or for
        // injected events), it just renders a normal bubble.
        const content = (message.message?.content ?? []) as Array<{
          type: string;
          text?: string;
        }>;
        const text = content
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("\n\n")
          .trim();
        const id = (message.message as unknown as { id?: string })?.id;
        yield {
          type: "assistant",
          text,
          ...(typeof auid === "string" ? { uuid: auid } : {}),
          ...(id ? { id } : {}),
          ...(u ? { usage: u } : {}),
        };
        break;
      }
      case "result": {
        // Cache the context window + cost from the result, then re-report using
        // the last assistant usage (the true current context).
        const m = message as unknown as {
          modelUsage?: Record<string, { contextWindow?: number }>;
          total_cost_usd?: number;
        };
        let contextWindow: number | undefined;
        for (const mu of Object.values(m.modelUsage ?? {})) {
          if (mu?.contextWindow && (contextWindow === undefined || mu.contextWindow > contextWindow)) {
            contextWindow = mu.contextWindow;
          }
        }
        yield {
          type: "result",
          ok: message.subtype === "success",
          subtype: message.subtype,
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(typeof m.total_cost_usd === "number" ? { costUsd: m.total_cost_usd } : {}),
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
