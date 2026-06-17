// Panel agent — one persistent Claude Agent SDK streaming session per ComfyUI
// panel tab. This is the autonomous background driver for the sidebar panel: the
// orchestrator (src/orchestrator/index.ts) owns the UI bridge and feeds each
// tab's user messages into that tab's session here; the agent's replies flow
// back out to the panel chat.
//
// Why the Agent SDK (not --sdk-url / CCR-v2): we need a persistent background
// agent with a live "channel in" (push messages over time), interrupt/inject,
// and SUBSCRIPTION auth with no API key — without patching the claude binary.
// `query({ prompt: <async generator> })` is exactly that: the generator stays
// open (the channel in), `Query.interrupt()` stops a live turn, and with
// ANTHROPIC_API_KEY unset the SDK reads the on-disk claude.ai OAuth login
// (verified: the session reports apiKeySource=none on this machine).
//
// The spawned agent runs THIS comfyui-mcp build as its MCP server in normal
// (non-channels) mode, so it talks to the live ComfyUI over COMFYUI_URL and
// never contends for the bridge port the orchestrator owns.

import type {
  Query,
  SDKMessage,
  SDKUserMessage,
  Options,
} from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../utils/logger.js";

// The Agent SDK is an OPTIONAL dependency (it pulls in ~100 packages and is only
// needed for the panel orchestrator), so load it lazily and fail with a clear
// message rather than at import time for everyone.
let queryFn: typeof import("@anthropic-ai/claude-agent-sdk").query | null = null;
async function loadQuery(): Promise<NonNullable<typeof queryFn>> {
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

export interface PanelAgentDeps {
  /** mcpServers config for the spawned agent (the comfyui MCP, non-channels). */
  mcpServers: Options["mcpServers"];
  /** Persona appended to the claude_code system-prompt preset. */
  systemAppend: string;
  /** Pinned model (e.g. claude-opus-4-8). */
  model: string;
  /** Route the agent's words into the panel chat for this tab. */
  onSay: (tabId: string, text: string) => void;
  /**
   * Absolute path to the bundled comfyui-mcp plugin dir. When set, its skills
   * (IDEOGRAM/WAN/LTX/etc. expertise) are loaded into the agent so it's an
   * expert out of the box. Omitted if the plugin can't be found.
   */
  pluginPath?: string;
}

/**
 * One persistent streaming session for a single panel tab. Messages typed in
 * the panel are queued via `send()` and yielded into the live `query()` session
 * as user turns; the session never closes until `stop()`.
 */
export class PanelAgent {
  readonly tabId: string;
  private deps: PanelAgentDeps;
  private q: Query | null = null;
  private queue: string[] = [];
  private waiting: (() => void) | null = null;
  private closed = false;
  /** Captured from the session's init message; enables resume across restarts. */
  sessionId: string | null = null;
  title: string | undefined;

  constructor(tabId: string, deps: PanelAgentDeps) {
    this.tabId = tabId;
    this.deps = deps;
  }

  private short(): string {
    return this.tabId.slice(0, 8);
  }

  /** Queue a panel message and wake the streaming generator (the "channel in"). */
  send(text: string, title?: string): void {
    if (title) this.title = title;
    this.queue.push(text);
    const wake = this.waiting;
    this.waiting = null;
    wake?.();
  }

  /** Stop the current turn without ending the session (a "stop" button). */
  async interrupt(): Promise<void> {
    try {
      await this.q?.interrupt();
    } catch (err) {
      logger.debug(`[panel-agent ${this.short()}] interrupt: ${msgOf(err)}`);
    }
  }

  /** End the session and release the agent (tab closed / orchestrator shutdown). */
  async stop(): Promise<void> {
    this.closed = true;
    const wake = this.waiting;
    this.waiting = null;
    wake?.(); // let the generator observe `closed` and return
    try {
      await this.q?.interrupt();
    } catch {
      // already winding down
    }
  }

  // The streaming "channel in": an async generator that stays open and yields a
  // user turn whenever the panel sends one. The session idles between messages
  // and wakes the moment send() pushes — solving "can't wake an idle session".
  private async *channel(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      if (this.queue.length === 0) {
        await new Promise<void>((resolve) => {
          this.waiting = resolve;
        });
      }
      if (this.closed) return;
      const text = this.queue.shift();
      if (text === undefined) continue;
      yield {
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
      };
    }
  }

  /**
   * Start the persistent session. Resolves only when the session ends. Safe to
   * call once; `send()` may be called before this resolves (messages queue).
   */
  async start(resumeSessionId?: string): Promise<void> {
    const query = await loadQuery();
    const options: Options = {
      model: this.deps.model,
      permissionMode: "bypassPermissions",
      // Required alongside bypassPermissions (intentional, isolated background agent).
      allowDangerouslySkipPermissions: true,
      mcpServers: this.deps.mcpServers,
      // Only our comfyui MCP — never inherit the user's project/user MCP config
      // (which may run a second comfyui in --channels mode that grabs the port).
      strictMcpConfig: true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: this.deps.systemAppend,
      },
      // Load the bundled comfyui-mcp plugin so the agent has model expertise
      // (IDEOGRAM/WAN/LTX/Qwen/… skills) out of the box — "install the package
      // = expert agent". Omitted if the plugin dir can't be found.
      ...(this.deps.pluginPath
        ? {
            plugins: [{ type: "local" as const, path: this.deps.pluginPath }],
            skills: "all" as const,
          }
        : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    };

    this.q = query({ prompt: this.channel(), options });
    try {
      for await (const message of this.q) this.route(message);
    } catch (err) {
      if (!this.closed) {
        logger.error(`[panel-agent ${this.short()}] stream error: ${msgOf(err)}`);
      }
    } finally {
      logger.info(`[panel-agent ${this.short()}] session ended`);
    }
  }

  private route(message: SDKMessage): void {
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          this.sessionId = message.session_id;
          logger.info(
            `[panel-agent ${this.short()}] init model=${message.model} session=${message.session_id.slice(0, 8)} apiKeySource=${message.apiKeySource} skills=${message.skills?.length ?? 0}`,
          );
        }
        break;
      case "assistant": {
        // Relay each text block into the panel chat — progress and final reply.
        const content = (message.message?.content ?? []) as Array<{
          type: string;
          text?: string;
        }>;
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            const text = block.text.trim();
            if (text) this.deps.onSay(this.tabId, text);
          }
        }
        break;
      }
      case "result":
        logger.info(
          `[panel-agent ${this.short()}] turn done (subtype=${message.subtype})`,
        );
        break;
      default:
        break;
    }
  }
}

export interface PanelAgentManagerOptions {
  mcpServers: Options["mcpServers"];
  systemAppend: string;
  model: string;
  onSay: (tabId: string, text: string) => void;
  /** Bundled plugin dir whose skills make the agent an expert (optional). */
  pluginPath?: string;
}

/** Owns one PanelAgent per tab id, spawned lazily on the tab's first message. */
export class PanelAgentManager {
  private agents = new Map<string, PanelAgent>();
  private opts: PanelAgentManagerOptions;

  constructor(opts: PanelAgentManagerOptions) {
    this.opts = opts;
  }

  /** Route a panel message to its tab's agent, creating the agent if needed. */
  send(tabId: string, text: string, meta?: { title?: string }): void {
    let agent = this.agents.get(tabId);
    if (!agent) {
      agent = new PanelAgent(tabId, {
        mcpServers: this.opts.mcpServers,
        systemAppend: this.opts.systemAppend,
        model: this.opts.model,
        onSay: this.opts.onSay,
        pluginPath: this.opts.pluginPath,
      });
      this.agents.set(tabId, agent);
      logger.info(
        `[panel-orchestrator] spawning agent for tab ${tabId.slice(0, 8)} (${this.agents.size} active)`,
      );
      // Fire-and-forget: start() resolves only when the session ends.
      void agent.start().catch((err) => {
        this.agents.delete(tabId);
        const m = msgOf(err);
        logger.error(`[panel-agent ${tabId.slice(0, 8)}] failed to start: ${m}`);
        this.opts.onSay(tabId, `⚠️ The panel agent could not start: ${m}`);
      });
    }
    agent.send(text, meta?.title);
  }

  async interrupt(tabId: string): Promise<void> {
    await this.agents.get(tabId)?.interrupt();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.agents.values()].map((a) => a.stop()));
    this.agents.clear();
  }

  count(): number {
    return this.agents.size;
  }
}
