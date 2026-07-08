// Ollama local-LLM adapter for the panel orchestrator (issue #97's panel phase).
//
// Unlike the Claude/Codex/Gemini adapters, the "provider" here is a plain HTTP
// daemon with OpenAI-style tool calling and NO agent harness — so this backend
// owns the whole agentic loop itself: it streams /api/chat NDJSON, dispatches
// tool calls, and feeds results back until the model produces a final answer.
//
// Local models can't survive the full ~200-schema comfyui surface plus ~40
// panel_* schemas, so the model sees exactly SIX tools (the "tool router"
// pattern from issue #97):
//   list_tools / describe_tool / call_tool      — passthrough to a headless
//     comfyui MCP subprocess spawned in COMPACT mode (3 meta-tools built in)
//   panel_list_tools / panel_describe_tool / panel_call_tool — synthesized
//     here over the orchestrator's loopback panel HTTP MCP (live-graph tools)
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
  NeutralTurn,
} from "./agent-backend.js";
import { OLLAMA_CAPABILITIES } from "./agent-backend.js";
import type { GeminiMcpServerSpec } from "./gemini-backend.js";

type McpToolInfo = { name: string; description?: string; inputSchema?: unknown };
type McpCallResult = { isError?: boolean; content?: Array<{ type: string; text?: string }> };

/** The slice of the MCP SDK Client the backend uses — injectable for tests. */
export interface McpToolClient {
  listTools(): Promise<{ tools: McpToolInfo[] }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<McpCallResult>;
  close(): Promise<void>;
}

/** Provider config for the Ollama backend. Mirrors GeminiBackendDeps. */
export interface OllamaBackendDeps {
  cwd?: string;
  /** Default model tag for new sessions (e.g. qwen3:4b, gemma4:e4b). */
  model?: string;
  /** Ollama HTTP endpoint (default http://127.0.0.1:11434 / OLLAMA_HOST). */
  host?: string;
  /** Wire dialect: "ollama" (native /api/chat NDJSON, default) or "openai"
   *  (any OpenAI-compatible /v1/chat/completions SSE — OpenRouter, DeepSeek,
   *  vLLM, LM Studio, …). With "openai", `host` is the base URL incl. /v1. */
  api?: "ollama" | "openai";
  /** Bearer key for the openai dialect (hosted endpoints). Never logged. */
  apiKey?: string;
  comfyuiUrl?: string;
  /** Same spec shape the Codex/Gemini backends take: the headless comfyui stdio
   *  MCP + the panel HTTP MCP. The comfyui spawn env is overridden with
   *  COMFYUI_MCP_TOOL_MODE=compact so it exposes the 3 meta-tools directly. */
  mcpServers?: Record<string, GeminiMcpServerSpec>;
  /** Panel system prompt (persona), prepended to the system message. */
  systemAppend?: string;
  /** Context window tokens for /api/chat options.num_ctx (default 16384). */
  numCtx?: number;
  /** Test seam: replaces the MCP client construction from mcpServers specs. */
  connectToolClients?: () => Promise<{ comfyui?: McpToolClient; panel?: McpToolClient }>;
}

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  /** Ollama-dialect tool-result pairing (by name). */
  tool_name?: string;
  /** OpenAI-dialect tool-result pairing (by call id). */
  tool_call_id?: string;
};

type OllamaToolCall = {
  id?: string;
  function: { name: string; arguments: Record<string, unknown> | string; index?: number };
};

/** Convert the neutral in-memory history to the OpenAI wire shape: tool-call
 *  arguments must be JSON STRINGS, every call needs an id, and tool results
 *  pair by tool_call_id (tool_name is an Ollama-ism the strict endpoints
 *  reject). */
function toOpenAiMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === "assistant" && m.tool_calls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.tool_calls.map((tc, i) => ({
          id: tc.id ?? `call_${i}`,
          type: "function",
          function: {
            name: tc.function.name,
            arguments:
              typeof tc.function.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments ?? {}),
          },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.tool_call_id ?? "call_0", content: m.content };
    }
    return { role: m.role, content: m.content };
  });
}

// Our FINE-TUNED gemma4 — QLoRA-trained on 1055 server-verified comfyui-mcp
// trajectories over the full 178-tool surface (hf.co/artokun/gemma4-comfyui-mcp),
// so it knows this exact tool suite natively. Supersedes stock gemma4:e4b (the
// previous arena best, 9/10). Ladder: :e2b ~2 GB VRAM at q4 / :e4b ~3.5 GB
// (default) / :12b ~8 GB — `ollama pull artokun/gemma4-comfyui-mcp:<size>`.
const DEFAULT_MODEL = "artokun/gemma4-comfyui-mcp:e4b";
const MAX_TOOL_ROUNDS = 32;

/**
 * The Ollama system prompt REPLACES the frontier panel prompt: that one is
 * thousands of tokens and instructs the agent to call dozens of tools BY NAME
 * (panel_get_graph, list_packs, …) that don't exist on this backend's 6-tool
 * router — a small model obeys it, hits "unknown tool", and gives up. This one
 * is short, router-shaped, and (deliberately, for local models) does NOT carry
 * the NSFW consent-gate flow — only the absolute hard limits.
 */
const OLLAMA_SYSTEM_PROMPT = [
  "You are the ComfyUI agent in a sidebar panel, driving the user's live ComfyUI graph and server. Answer in normal Markdown.",
  "",
  "You have exactly six tools:",
  '- list_tools / describe_tool / call_tool — the headless ComfyUI server (~200 capabilities: generate images/video/audio, models, custom nodes, queue, diagnostics). Flow: list_tools {"search": ...} → describe_tool {"name": ...} → call_tool {"name": ..., "args": {...}}.',
  "- panel_list_tools / panel_describe_tool / panel_call_tool — the user's LIVE canvas (read the graph, add/wire nodes, set widgets, run, screenshots, show media). Same flow.",
  "",
  "Rules:",
  "- Catalog entries are tool NAMES, not data. Finish every task by actually running tools; never invent results.",
  "- Describe a tool before its first call so you use the right parameters. If a call errors, read the error — it includes the expected schema — fix the args and retry.",
  "- To see or show any generated image/video, run the panel_show_media tool via panel_call_tool.",
  "- Workflows with API nodes cost the user PAID credits; local-GPU workflows are free. Ask before anything that might spend credits.",
].join("\n");

/**
 * Curated OpenRouter models that top the comfyui-mcp LLM Arena on the full tool
 * surface — surfaced at the TOP of the openai-mode picker so users don't have
 * to dig them out of OpenRouter's 300+ catalog. ToS-open where noted (these are
 * also the fine-tune teachers). The label carries context-window and tier hints
 * the picker shows verbatim; `context1m` marks the 1M-context models that get
 * the full tool surface + SOTA prompt with room to spare.
 */
export interface RecommendedModel {
  id: string;
  label: string;
  context1m?: boolean;
}
export const RECOMMENDED_OPENROUTER_MODELS: readonly RecommendedModel[] = [
  { id: "xiaomi/mimo-v2.5", label: "MiMo v2.5 (1M · SOTA · open)", context1m: true },
  { id: "minimax/minimax-m3", label: "MiniMax M3 (1M · SOTA · open)", context1m: true },
  { id: "moonshotai/kimi-k2.5", label: "Kimi K2.5 (SOTA · open)" },
  { id: "z-ai/glm-5.1", label: "GLM 5.1 (SOTA · open)" },
  { id: "deepseek/deepseek-v3.2", label: "DeepSeek v3.2 (open)" },
];

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function textOf(result: McpCallResult): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

function firstSentence(text: string, maxLen = 160): string {
  const line = (text.split(/(?<=\.)\s+/, 1)[0] ?? text).replace(/\s+/g, " ").trim();
  return line.length <= maxLen ? line : `${line.slice(0, maxLen - 1).trimEnd()}…`;
}

/** Does this id look like a model this backend can run? PanelAgent
 *  unconditionally passes the panel's Claude model as opts.model — this guard
 *  keeps the configured model in charge unless the panel explicitly picked one
 *  of ours. Ollama tags carry a ":" (qwen3:4b); hosted OpenAI-compatible slugs
 *  carry a "/" vendor prefix (deepseek/deepseek-v3.2, anthropic/claude-…).
 *  Mirrors gemini-backend's isGeminiModel. */
export function isOllamaModel(id: string): boolean {
  return (id.includes(":") || id.includes("/")) && !/^claude|^gpt|^gemini/i.test(id);
}

export class OllamaBackend implements AgentBackend {
  readonly id = "ollama" as const;
  readonly capabilities = OLLAMA_CAPABILITIES;
  private deps: OllamaBackendDeps;
  private host: string;
  private model: string;
  private disposed = false;
  private prepared = false;
  /** In-flight turn abort — interrupt() aborts the current fetch/loop. */
  private turnAbort: AbortController | null = null;
  private comfy: McpToolClient | null = null;
  private panel: McpToolClient | null = null;
  /** comfyui compact meta-tool defs (from tools/list) — handed to the model verbatim. */
  private comfyTools: McpToolInfo[] = [];
  /** panel_* tool list (full defs stay HERE; the model gets 3 meta-tools). */
  private panelTools: McpToolInfo[] = [];
  /** Conversation history for the live session (Ollama is stateless per request). */
  private history: ChatMessage[] = [];
  private sessionId: string | null = null;

  /** Wire dialect (see OllamaBackendDeps.api). */
  private api: "ollama" | "openai";
  private apiKey: string | undefined;

  constructor(deps: OllamaBackendDeps = {}) {
    this.deps = deps;
    this.api = deps.api ?? "ollama";
    this.apiKey = deps.apiKey;
    this.host = (deps.host ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    this.model = deps.model ?? DEFAULT_MODEL;
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }

  async prepare(): Promise<void> {
    if (this.disposed) throw new Error("ollama backend is closed.");
    if (this.prepared) return;
    let version = "?";
    try {
      if (this.api === "openai") {
        const res = await fetch(`${this.host}/models`, {
          headers: this.authHeaders(),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`http ${res.status}`);
        version = "openai-compatible";
      } else {
        const res = await fetch(`${this.host}/api/version`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) throw new Error(`http ${res.status}`);
        version = ((await res.json()) as { version?: string }).version ?? "?";
      }
    } catch (err) {
      throw new Error(
        this.api === "openai"
          ? `The OpenAI-compatible endpoint at ${this.host} is not reachable or rejected the key (${msgOf(err)}).`
          : `Ollama is not reachable at ${this.host} (${msgOf(err)}). Start it with \`ollama serve\` (install: https://ollama.com/download), then \`ollama pull ${this.model}\` — our gemma4 fine-tuned on the comfyui-mcp tool suite (free, runs locally; \`:e2b\` fits ~2 GB VRAM, \`:e4b\` ~3.5 GB, \`:12b\` ~8 GB).`,
      );
    }
    await this.connectTools();
    this.prepared = true;
    logger.info(
      `[ollama-backend] ready (${this.api === "openai" ? `openai-compatible @ ${this.host}` : `ollama ${version}`}, model ${this.model}, ${this.comfyTools.length} comfyui meta-tools, ${this.panelTools.length} panel tools behind the router)`,
    );
  }

  private async connectTools(): Promise<void> {
    if (this.deps.connectToolClients) {
      const { comfyui, panel } = await this.deps.connectToolClients();
      this.comfy = comfyui ?? null;
      this.panel = panel ?? null;
    } else if (this.deps.mcpServers) {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      for (const [name, spec] of Object.entries(this.deps.mcpServers)) {
        try {
          const client = new Client({ name: `ollama-backend-${name}`, version: "0.0.0" });
          if (spec.transport === "stdio") {
            const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
            await client.connect(
              new StdioClientTransport({
                command: spec.command,
                args: spec.args ?? [],
                // Compact mode: the subprocess itself exposes the 3 meta-tools.
                env: { ...process.env, ...spec.env, COMFYUI_MCP_TOOL_MODE: "compact" },
              }),
            );
            this.comfy = client as unknown as McpToolClient;
          } else {
            const { StreamableHTTPClientTransport } = await import(
              "@modelcontextprotocol/sdk/client/streamableHttp.js"
            );
            await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)));
            this.panel = client as unknown as McpToolClient;
          }
        } catch (err) {
          logger.warn(`[ollama-backend] could not connect MCP server '${name}': ${msgOf(err)}`);
        }
      }
    }
    if (this.comfy) this.comfyTools = (await this.comfy.listTools()).tools;
    if (this.panel) this.panelTools = (await this.panel.listTools()).tools;
  }

  /** The six OpenAI-style tool defs the model sees. */
  private buildModelTools(): Array<Record<string, unknown>> {
    const defs: Array<Record<string, unknown>> = [];
    for (const t of this.comfyTools) {
      defs.push({
        type: "function",
        function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema ?? { type: "object", properties: {} } },
      });
    }
    if (this.panel && this.panelTools.length) {
      defs.push(
        {
          type: "function",
          function: {
            name: "panel_list_tools",
            description:
              "List the live-canvas panel tools (the user's open ComfyUI graph): names + one-line summaries. Use panel_describe_tool then panel_call_tool to run one.",
            parameters: {
              type: "object",
              properties: { search: { type: "string", description: "Case-insensitive substring filter." } },
            },
          },
        },
        {
          type: "function",
          function: {
            name: "panel_describe_tool",
            description: "Full description and JSON Schema for one panel tool.",
            parameters: {
              type: "object",
              properties: { name: { type: "string", description: "Exact panel tool name." } },
              required: ["name"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "panel_call_tool",
            description: "Run a panel tool by name with args matching its panel_describe_tool schema.",
            parameters: {
              type: "object",
              properties: {
                name: { type: "string", description: "Exact panel tool name." },
                args: { description: "The tool's parameters as an object (JSON-encoded string also accepted)." },
              },
              required: ["name"],
            },
          },
        },
      );
    }
    return defs;
  }

  /** Dispatch one model tool call; returns display text (never throws). */
  private async dispatch(name: string, rawArgs: Record<string, unknown> | string): Promise<{ text: string; isError: boolean }> {
    let args: Record<string, unknown> = {};
    if (typeof rawArgs === "string") {
      try {
        args = rawArgs.trim() ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
      } catch {
        return { text: `arguments were not valid JSON: ${rawArgs.slice(0, 200)}`, isError: true };
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs;
    }

    try {
      if (this.comfyTools.some((t) => t.name === name)) {
        if (!this.comfy) return { text: "comfyui tools are unavailable in this session.", isError: true };
        const res = await this.comfy.callTool({ name, arguments: args });
        return { text: textOf(res), isError: !!res.isError };
      }
      if (name === "panel_list_tools") {
        const search = typeof args.search === "string" ? args.search.toLowerCase() : "";
        const matching = search
          ? this.panelTools.filter(
              (t) => t.name.toLowerCase().includes(search) || (t.description ?? "").toLowerCase().includes(search),
            )
          : this.panelTools;
        if (!matching.length) return { text: `No panel tools matched '${search}'. Call panel_list_tools with no filter to see all ${this.panelTools.length}.`, isError: false };
        const lines = matching.map((t) => `- ${t.name}: ${firstSentence(t.description ?? "")}`);
        return {
          text: `Live-canvas panel tools — ${matching.length} of ${this.panelTools.length}. Next: panel_describe_tool {"name": ...} then panel_call_tool.\n${lines.join("\n")}`,
          isError: false,
        };
      }
      if (name === "panel_describe_tool") {
        const wanted = typeof args.name === "string" ? args.name : "";
        const tool = this.panelTools.find((t) => t.name === wanted);
        if (!tool) {
          const close = this.panelTools.filter((t) => t.name.includes(wanted)).slice(0, 5).map((t) => t.name);
          return { text: `Unknown panel tool '${wanted}'.${close.length ? ` Did you mean: ${close.join(", ")}?` : ""} Use panel_list_tools.`, isError: true };
        }
        return {
          text: `# ${tool.name}\n\n${tool.description ?? ""}\n\nParameters (JSON Schema):\n${JSON.stringify(tool.inputSchema ?? {}, null, 1)}\n\nRun it with: panel_call_tool {"name": "${tool.name}", "args": {...}}`,
          isError: false,
        };
      }
      if (name === "panel_call_tool") {
        if (!this.panel) return { text: "panel tools are unavailable in this session.", isError: true };
        const wanted = typeof args.name === "string" ? args.name : typeof args.tool_name === "string" ? (args.tool_name as string) : "";
        if (!this.panelTools.some((t) => t.name === wanted)) {
          return { text: `Unknown panel tool '${wanted}'. Use panel_list_tools.`, isError: true };
        }
        let inner = args.args ?? args.arguments ?? {};
        if (typeof inner === "string") {
          try {
            inner = inner.trim() ? (JSON.parse(inner) as Record<string, unknown>) : {};
          } catch {
            return { text: `args was not valid JSON: ${(inner as string).slice(0, 200)}`, isError: true };
          }
        }
        if (inner === null || typeof inner !== "object" || Array.isArray(inner)) {
          return { text: `args must be a JSON object. See panel_describe_tool {"name": "${wanted}"}.`, isError: true };
        }
        const res = await this.panel.callTool({ name: wanted, arguments: inner as Record<string, unknown> });
        if (res.isError) {
          logger.warn(`[ollama-backend] panel tool '${wanted}' returned isError: ${textOf(res).slice(0, 300)}`);
        }
        return { text: textOf(res), isError: !!res.isError };
      }
      // FORGIVING DIRECT DISPATCH — small models routinely call an inner tool
      // by its bare name instead of going through the router. If the name is a
      // real panel tool, run it on the panel client; anything else is handed to
      // the compact server's call_tool, whose unknown-name error carries
      // close-match suggestions the model can recover from.
      if (this.panel && this.panelTools.some((t) => t.name === name)) {
        const res = await this.panel.callTool({ name, arguments: args });
        return { text: textOf(res), isError: !!res.isError };
      }
      if (this.comfy && this.comfyTools.some((t) => t.name === "call_tool")) {
        const res = await this.comfy.callTool({ name: "call_tool", arguments: { name, args } });
        return { text: textOf(res), isError: !!res.isError };
      }
      const known = [...this.comfyTools.map((t) => t.name), "panel_list_tools", "panel_describe_tool", "panel_call_tool"];
      return { text: `Unknown tool '${name}'. Available: ${known.join(", ")}.`, isError: true };
    } catch (err) {
      logger.warn(`[ollama-backend] tool '${name}' dispatch failed: ${msgOf(err)}`);
      return { text: `Tool '${name}' failed: ${msgOf(err)}`, isError: true };
    }
  }

  /** One /api/chat request (streaming). YIELDS delta events as chunks arrive and
   *  RETURNS the accumulated assistant message + usage (read via iterator.next()
   *  in runTurn so deltas stream through run() live). */
  private async *chatStream(
    messages: ChatMessage[],
    tools: Array<Record<string, unknown>>,
    signal: AbortSignal,
    onActivity?: () => void,
  ): AsyncGenerator<
    AgentEvent,
    { content: string; toolCalls: OllamaToolCall[]; usage?: Record<string, number>; streamId: string | null }
  > {
    // Keep the turn watchdog armed while the request is pending: a cold model
    // load can sit 30s+ before the first byte — the provider is alive (the
    // HTTP request is in flight), it's just loading weights into VRAM.
    const keepalive = onActivity ? setInterval(onActivity, 5000) : null;
    let res: Response;
    try {
      res =
        this.api === "openai"
          ? await fetch(`${this.host}/chat/completions`, {
              method: "POST",
              headers: { "content-type": "application/json", ...this.authHeaders() },
              body: JSON.stringify({
                model: this.model,
                messages: toOpenAiMessages(messages),
                tools,
                tool_choice: "auto",
                stream: true,
                stream_options: { include_usage: true },
                // Cap the output reservation: without it some models default to
                // 65k, which both invites runaways and 402s on low prepaid
                // balances (the request reserves credits for max_tokens).
                max_tokens: Number(process.env.COMFYUI_MCP_OLLAMA_MAX_TOKENS) || 8192,
              }),
              signal,
            })
          : await fetch(`${this.host}/api/chat`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                model: this.model,
                messages,
                tools,
                stream: true,
                options: { num_ctx: this.deps.numCtx ?? 16384 },
              }),
              signal,
            });
    } finally {
      if (keepalive) clearInterval(keepalive);
    }
    if (!res.ok || !res.body) {
      throw new Error(
        `${this.api === "openai" ? `${this.host}/chat/completions` : "ollama /api/chat"} http ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`,
      );
    }
    if (this.api === "openai") {
      return yield* this.readOpenAiSse(res.body, onActivity);
    }

    let content = "";
    const toolCalls: OllamaToolCall[] = [];
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
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let chunk: {
          message?: { content?: string; thinking?: string; tool_calls?: OllamaToolCall[] };
          done?: boolean;
          prompt_eval_count?: number;
          eval_count?: number;
          error?: string;
        };
        try {
          chunk = JSON.parse(line);
        } catch {
          continue;
        }
        if (chunk.error) throw new Error(`ollama: ${chunk.error}`);
        const delta = chunk.message?.content ?? "";
        if (delta) {
          if (!streamOpen) {
            streamOpen = true;
            yield { type: "stream_start", id: streamId };
          }
          content += delta;
          yield { type: "assistant_delta", text: delta };
        }
        if (chunk.message?.thinking) {
          // thinking deltas need an open bubble too (think-window rendering)
          if (!streamOpen) {
            streamOpen = true;
            yield { type: "stream_start", id: streamId };
          }
          yield { type: "assistant_delta", text: chunk.message.thinking, thinking: true };
        }
        if (chunk.message?.tool_calls?.length) toolCalls.push(...chunk.message.tool_calls);
        if (chunk.done) {
          usage = {
            input_tokens: chunk.prompt_eval_count ?? 0,
            output_tokens: chunk.eval_count ?? 0,
          };
        }
      }
    }
    if (streamOpen) yield { type: "stream_end" };
    // streamId is returned only when a bubble was opened, so the assistant
    // COMMIT can carry the same id — that reconciliation is what lets the
    // panel replace the plain-text live bubble with the markdown-rendered
    // message. A missing id left the raw text on screen (no markdown).
    return { content, toolCalls, usage, streamId: streamOpen ? streamId : null };
  }

  /** OpenAI-compatible SSE reader: `data:` lines with choices[0].delta.
   *  Tool calls stream as FRAGMENTS keyed by index (name once, arguments as
   *  string chunks) — accumulate them into whole calls. */
  private async *readOpenAiSse(
    body: ReadableStream<Uint8Array>,
    onActivity?: () => void,
  ): AsyncGenerator<
    AgentEvent,
    { content: string; toolCalls: OllamaToolCall[]; usage?: Record<string, number>; streamId: string | null }
  > {
    let content = "";
    let usage: Record<string, number> | undefined;
    let streamOpen = false;
    const streamId = randomUUID();
    const partial = new Map<number, { id?: string; name: string; args: string }>();
    let buffer = "";
    const reader = body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string | null;
              reasoning?: string | null;
              tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
            };
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          error?: { message?: string };
        };
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        if (chunk.error?.message) throw new Error(`endpoint: ${chunk.error.message}`);
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          if (!streamOpen) {
            streamOpen = true;
            yield { type: "stream_start", id: streamId };
          }
          content += delta.content;
          yield { type: "assistant_delta", text: delta.content };
        }
        if (delta?.reasoning) {
          if (!streamOpen) {
            streamOpen = true;
            yield { type: "stream_start", id: streamId };
          }
          yield { type: "assistant_delta", text: delta.reasoning, thinking: true };
        }
        for (const tc of delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const slot = partial.get(idx) ?? { id: undefined, name: "", args: "" };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          partial.set(idx, slot);
        }
        if (chunk.usage) {
          usage = {
            input_tokens: chunk.usage.prompt_tokens ?? 0,
            output_tokens: chunk.usage.completion_tokens ?? 0,
          };
        }
      }
    }
    if (streamOpen) yield { type: "stream_end" };
    const toolCalls: OllamaToolCall[] = [...partial.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, s]) => ({ id: s.id ?? `call_${i}`, function: { name: s.name, arguments: s.args || "{}" } }));
    return { content, toolCalls, usage, streamId: streamOpen ? streamId : null };
  }

  async *run(opts: BackendStartOptions): AsyncIterable<AgentEvent> {
    await this.prepare();
    if (opts.model && isOllamaModel(opts.model)) this.model = opts.model;

    // Ollama is stateless — "session" is our in-memory history. A resume id is
    // honored in name (the panel replays the transcript as context anyway).
    const fresh = !this.sessionId || (opts.resume && opts.resume !== this.sessionId);
    this.sessionId = opts.resume ?? this.sessionId ?? `ollama-${randomUUID()}`;
    if (fresh) {
      // deps.systemAppend (the frontier panel prompt) is intentionally NOT
      // used — see OLLAMA_SYSTEM_PROMPT.
      this.history = [{ role: "system", content: OLLAMA_SYSTEM_PROMPT }];
    }
    yield { type: "session", sessionId: this.sessionId, model: this.model };

    for await (const turn of opts.channel) {
      yield* this.runTurn(turn, opts);
    }
  }

  private async *runTurn(turn: NeutralTurn, opts: BackendStartOptions): AsyncIterable<AgentEvent> {
    const abort = new AbortController();
    this.turnAbort = abort;
    const tools = this.buildModelTools();
    this.history.push({ role: "user", content: turn.text });

    let resultEmitted = false;
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        // Drain the chat stream manually: yield each delta event as it arrives,
        // and capture the generator's RETURN value (the accumulated message).
        const stream = this.chatStream(this.history, tools, abort.signal, opts.onActivity);
        let content = "";
        let toolCalls: OllamaToolCall[] = [];
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
          // Record the final answer in history too — without this, the NEXT
          // turn's context is missing the model's own previous replies (and
          // the transcript dump ends mid-conversation on a tool message).
          this.history.push({ role: "assistant", content });
          yield { type: "assistant", text: content, id: streamId ?? undefined, usage };
          yield { type: "result", ok: true, usage };
          resultEmitted = true;
          return;
        }

        this.history.push({ role: "assistant", content, tool_calls: toolCalls });
        for (const [i, tc] of toolCalls.entries()) {
          if (abort.signal.aborted) throw new Error("interrupted");
          const name = tc.function?.name ?? "?";
          yield { type: "tool_call", name, phase: "start", detail: tc.function?.arguments };
          const { text, isError } = await this.dispatch(name, tc.function?.arguments ?? {});
          opts.onActivity?.();
          yield { type: "tool_call", name, phase: "end", detail: { isError } };
          this.history.push({
            role: "tool",
            tool_name: name,
            tool_call_id: tc.id ?? `call_${i}`,
            content: text.slice(0, 16000),
          });
        }
      }
      // Round budget exhausted — commit what we have so the turn gate advances.
      yield {
        type: "assistant",
        text: "(stopped: too many tool rounds in one turn — ask me to continue)",
      };
      yield { type: "result", ok: false, subtype: "max_tool_rounds" };
      resultEmitted = true;
    } catch (err) {
      const interrupted = abort.signal.aborted;
      if (!interrupted) {
        // Surface the failure IN the chat too — an error event alone leaves the
        // panel silent (the turn just ends), which reads as a wedge.
        logger.warn(`[ollama-backend] turn failed: ${msgOf(err)}`);
        yield { type: "error", message: `ollama backend: ${msgOf(err)}` };
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
      this.dumpTranscript();
    }
  }

  /**
   * Fine-tune datagen hook: when COMFYUI_MCP_TRANSCRIPT_DIR is set, snapshot
   * the session's OpenAI-shaped message history after every turn (overwrite —
   * the last write holds the whole conversation). Off in normal operation;
   * consumed by scripts/panel-arena.mjs to harvest training trajectories.
   */
  private dumpTranscript(): void {
    const dir = process.env.COMFYUI_MCP_TRANSCRIPT_DIR;
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${this.sessionId ?? "session"}.json`),
        JSON.stringify({ model: this.model, messages: this.history }, null, 2),
      );
    } catch (err) {
      logger.warn(`[ollama-backend] transcript dump failed: ${msgOf(err)}`);
    }
  }

  async interrupt(): Promise<void> {
    this.turnAbort?.abort();
  }

  async setModel(model: string): Promise<void> {
    // Ollama picks the model per request — a live switch is just bookkeeping.
    if (isOllamaModel(model)) this.model = model;
  }

  async listModels(): Promise<ModelChoice[]> {
    try {
      if (this.api === "openai") {
        const res = await fetch(`${this.host}/models`, {
          headers: this.authHeaders(),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return [{ id: this.model, label: this.model }];
        const data = (await res.json()) as { data?: Array<{ id?: string }> };
        const ids = (data.data ?? []).map((m) => m.id).filter((n): n is string => !!n);
        const available = new Set(ids);
        // Curated arena winners first (only those the endpoint actually serves),
        // with their context/tier labels; then the configured model; then a
        // bounded slice of the rest — OpenRouter's 300+ catalog isn't a browser.
        const recommended = RECOMMENDED_OPENROUTER_MODELS.filter((m) => available.has(m.id));
        const recIds = new Set(recommended.map((m) => m.id));
        const rest = ids.filter((id) => id !== this.model && !recIds.has(id)).slice(0, 40);
        const out: ModelChoice[] = recommended.map((m) => ({ id: m.id, label: m.label }));
        if (!recIds.has(this.model)) out.push({ id: this.model, label: this.model });
        for (const id of rest) out.push({ id, label: id });
        return out;
      }
      const res = await fetch(`${this.host}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return [];
      const data = (await res.json()) as { models?: Array<{ name?: string }> };
      return (data.models ?? [])
        .map((m) => m.name)
        .filter((n): n is string => !!n)
        .map((id) => ({ id, label: id }));
    } catch {
      return this.api === "openai" ? [{ id: this.model, label: this.model }] : [];
    }
  }

  async close(): Promise<void> {
    this.disposed = true;
    this.turnAbort?.abort();
    await this.comfy?.close().catch(() => {});
    await this.panel?.close().catch(() => {});
    this.comfy = null;
    this.panel = null;
    this.prepared = false;
  }
}
