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
import { errorText } from "./error-text.js";
import type {
  AgentBackend,
  AgentEvent,
  BackendId,
  BackendStartOptions,
  ModelChoice,
  NeutralTurn,
} from "./agent-backend.js";
import type { ImageRef } from "./panel-agent.js";
import { OLLAMA_CAPABILITIES, stampTurn } from "./agent-backend.js";
import type { GeminiMcpServerSpec } from "./gemini-backend.js";
import { resolvePrompt } from "../services/prompt-overrides.js";
import { retiredToolMessage } from "../tools/vocabulary.js";
import { PANEL_TOOL_MCP_TIMEOUT_MS } from "./panel-tools.js";

type McpToolInfo = { name: string; description?: string; inputSchema?: unknown };
type McpCallResult = { isError?: boolean; content?: Array<{ type: string; text?: string }> };

/** The slice of the MCP SDK Client the backend uses — injectable for tests.
 *  callTool mirrors the SDK's real 3-arg signature (params, resultSchema?,
 *  options?) so a per-request timeout can ride along: the SDK's 60s default
 *  kills long-blocking panel card tools client-side before the user answers
 *  (#325). */
export interface McpToolClient {
  listTools(): Promise<{ tools: McpToolInfo[] }>;
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { timeout?: number },
  ): Promise<McpCallResult>;
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
   *  MCP + the panel HTTP MCP. The comfyui child spawns COMPACT by default (see
   *  comfyuiSpawnEnv) — an explicit COMFYUI_MCP_TOOL_MODE in the spec or the
   *  user's own env wins (#667). */
  mcpServers?: Record<string, GeminiMcpServerSpec>;
  /** Panel system prompt (persona), prepended to the system message. */
  systemAppend?: string;
  /** Context window tokens for /api/chat options.num_ctx. Default is
   *  MODEL-AWARE: for our fine-tune (artokun/gemma4-comfyui-mcp:*) num_ctx is
   *  OMITTED so the tag's baked Modelfile window (65536) governs — request
   *  options override Modelfile params, and a blanket 16384 here silently
   *  clamped the fine-tune and truncated conversations mid-flight. Stock
   *  models keep 16384 (their tags bake no window and Ollama's own default is
   *  4096). Env COMFYUI_MCP_OLLAMA_NUM_CTX overrides everything — the
   *  architecture allows up to 128K (e2b/e4b) / 256K (12b), VRAM permitting. */
  numCtx?: number;
  /** Test seam: replaces the MCP client construction from mcpServers specs. */
  connectToolClients?: () => Promise<{ comfyui?: McpToolClient; panel?: McpToolClient }>;
  /** Panel backend id when reusing this driver for GLM/Kimi/Ollama (default ollama). */
  backendId?: BackendId;
}

/**
 * Spawn env for the headless comfyui MCP child (#667).
 *
 * Compact is the default on this path because the backend feeds the advertised
 * tool defs straight into a small local model's context — the full ~200-schema
 * list can fill most of a 16k num_ctx before the conversation starts, so the
 * child must expose the 3 meta-tools unless the user asked otherwise.
 *
 * Precedence: an explicit COMFYUI_MCP_TOOL_MODE — the spec's (the
 * orchestrator's resolved lane mode, see resolveHttpLaneComfyToolMode) or the
 * user's own env — WINS; the compact default applies only when neither sets it.
 */
export function comfyuiSpawnEnv(
  specEnv: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    ...env,
    ...specEnv,
    COMFYUI_MCP_TOOL_MODE:
      specEnv?.COMFYUI_MCP_TOOL_MODE ?? env.COMFYUI_MCP_TOOL_MODE ?? "compact",
  };
}

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  /** Ollama-dialect tool-result pairing (by name). */
  tool_name?: string;
  /** OpenAI-dialect tool-result pairing (by call id). */
  tool_call_id?: string;
  /** Inline image payloads (raw base64, no data: prefix) — Ollama's native
   *  message shape; toOpenAiMessages re-wraps them as image_url content parts.
   *  Whether the MODEL understands them is per-model, not per-provider: we
   *  always attempt delivery, and a rejecting endpoint triggers one images-
   *  stripped retry (see runTurn). */
  images?: string[];
  /** Mime types parallel to `images` (for the openai-dialect data: URLs). */
  imageMimes?: string[];
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
    if (m.role === "user" && m.images?.length) {
      return {
        role: "user",
        content: [
          { type: "text", text: m.content },
          ...m.images.map((b64, i) => ({
            type: "image_url",
            image_url: { url: `data:${m.imageMimes?.[i] ?? "image/png"};base64,${b64}` },
          })),
        ],
      };
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
 * (panel_query_graph, list_packs, …) that don't exist on this backend's 6-tool
 * router — a small model obeys it, hits "unknown tool", and gives up. This one
 * is short, router-shaped, and (deliberately, for local models) does NOT carry
 * the NSFW consent-gate flow — only the absolute hard limits.
 */
/**
 * Retraction appended to OLLAMA_SYSTEM_PROMPT when the panel router was NOT
 * registered for this session (the loopback panel MCP failed to bind, or this
 * backend could not connect to it).
 *
 * The prompt above opens with "You have exactly six tools" and names all three
 * panel_* routers. When `panelRouterAvailable()` is false only three of those six
 * exist, and a small local model told otherwise will call a router that is not
 * there — the same false capability claim the orchestrator retracts for the
 * frontier backends, arriving here by a different road because this adapter
 * deliberately ignores `deps.systemAppend`.
 *
 * Kept blunt and short on purpose: this prompt is written for small models, and the
 * surrounding file's own comment records what happens to them when a prompt names a
 * tool they cannot reach (they hit "unknown tool" and give up).
 *
 * States NO tool COUNT, deliberately. An earlier draft said "THREE tools, not six",
 * which is only true under COMFYUI_MCP_TOOL_MODE=compact — in full mode the headless
 * child registers its whole direct surface and buildModelTools advertises all of it,
 * so the correction would have been a second wrong number replacing the first. It
 * names the three tools that are GONE, which is what was actually observed, and
 * points the model at the list it was really handed.
 */
export function ollamaPanelRetraction(panelRouterAvailable: boolean): string {
  if (panelRouterAvailable) return "";
  return [
    "",
    "",
    "CORRECTION — THIS OVERRIDES THE TOOL LIST ABOVE:",
    "The live-canvas router did not start this session. panel_list_tools, panel_describe_tool and panel_call_tool DO NOT EXIST right now — do not call them, and never claim to have read or edited the user's canvas. Whatever tools you were given for the headless ComfyUI server are unaffected; go by the list you actually received, not by any count named above.",
    "You can still do everything through the headless server: saved workflow FILES on disk (list_workflows, get_workflow, analyze_workflow, query_workflow), generation, the queue, models, custom nodes.",
    "If the user asks about the graph open in front of them, say the live-canvas tools failed to start this session and that restarting the agent is what brings them back.",
  ].join("\n");
}

export const OLLAMA_SYSTEM_PROMPT = [
  "You are the ComfyUI agent in a sidebar panel, driving the user's live ComfyUI graph and server. Answer in normal Markdown.",
  "",
  "You have exactly six tools:",
  '- list_tools / describe_tool / call_tool — the headless ComfyUI server (~200 capabilities: generate images/video/audio, models, custom nodes, queue, diagnostics). Flow: list_tools {"search": ...} → describe_tool {"name": ...} → call_tool {"name": ..., "args": {...}}.',
  "- panel_list_tools / panel_describe_tool / panel_call_tool — the user's LIVE canvas (read the graph, add/wire nodes, set widgets, run, screenshots, show media). Same flow.",
  "",
  "Rules:",
  "- Catalog entries are tool NAMES, not data. Finish every task by actually running tools; never invent results.",
  "- Describe a tool before its first call so you use the right parameters. If a call errors, read the error — it includes the expected schema — fix the args and retry.",
  "- To read the user's graph, ALWAYS start with panel_graph_outline (a compact text map) via panel_call_tool. For specifics use panel_query_graph — filter by types/where ('cfg>7'), traverse upstream_of/downstream_of, or read ONE node's exact detail with {ids:[id], fields:'detail'}. Its output is token-bounded, so it can never flood your context.",
  "- To EDIT the graph — add a node (e.g. a LoraLoader after a download), wire slots, set widgets, run — those are PANEL tools too: panel_call_tool with panel_add_node / panel_connect / panel_set_widget / panel_run. Do NOT search the headless list_tools catalog for graph editing; it is not there.",
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
  { id: "deepseek/deepseek-v4-pro", label: "DeepSeek v4 Pro (open)" },
];

function msgOf(err: unknown): string {
  return errorText(err);
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
  readonly id: BackendId;
  readonly capabilities = OLLAMA_CAPABILITIES;
  protected deps: OllamaBackendDeps;
  protected host: string;
  protected model: string;
  protected disposed = false;
  protected prepared = false;
  /** In-flight turn abort — interrupt() aborts the current fetch/loop. */
  protected turnAbort: AbortController | null = null;
  protected comfy: McpToolClient | null = null;
  protected panel: McpToolClient | null = null;
  /** comfyui compact meta-tool defs (from tools/list) — handed to the model verbatim. */
  protected comfyTools: McpToolInfo[] = [];
  /** panel_* tool list (full defs stay HERE; the model gets 3 meta-tools). */
  protected panelTools: McpToolInfo[] = [];
  /** Conversation history for the live session (Ollama is stateless per request). */
  private history: ChatMessage[] = [];
  private sessionId: string | null = null;

  /** Wire dialect (see OllamaBackendDeps.api). */
  protected api: "ollama" | "openai";
  protected apiKey: string | undefined;

  constructor(deps: OllamaBackendDeps = {}) {
    this.deps = deps;
    this.id = deps.backendId ?? "ollama";
    this.api = deps.api ?? "ollama";
    this.apiKey = deps.apiKey;
    this.host = (deps.host ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    this.model = deps.model ?? DEFAULT_MODEL;
  }

  protected setOpenAiAuth(host: string, apiKey: string): void {
    this.api = "openai";
    this.host = host.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  protected authHeaders(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }

  /** True for our fine-tuned ladder (artokun/gemma4-comfyui-mcp:*), whose
   *  Ollama tags bake num_ctx 65536 into the Modelfile. */
  private isFinetune(): boolean {
    return this.model.includes("gemma4-comfyui-mcp");
  }

  /** num_ctx to SEND (0 = omit and let the Modelfile govern). Precedence:
   *  deps.numCtx (settings) → COMFYUI_MCP_OLLAMA_NUM_CTX env → model-aware
   *  default (fine-tune: omit → baked 65536; stock: 16384). */
  private effectiveNumCtx(): number {
    const envCtx = Number(process.env.COMFYUI_MCP_OLLAMA_NUM_CTX) || 0;
    return this.deps.numCtx ?? (envCtx > 0 ? envCtx : this.isFinetune() ? 0 : 16384);
  }

  /** The context window actually in effect (for pressure warnings): the sent
   *  num_ctx, or the fine-tune's baked 65536 when we omit it. */
  private contextWindow(): number {
    return this.effectiveNumCtx() || 65536;
  }

  /** Sampling options for /api/chat. The fine-tune tags bake `temperature 0`
   *  into their Modelfile — fully greedy decoding, which on a small model is
   *  the classic repetition-loop trap ("goes in circles" — Discord #help), and
   *  contradicts the Gemma team's recommended sampling (temp 1.0, top_k 64,
   *  top_p 0.95). Request options override the Modelfile, so we send explicit
   *  sampling for the fine-tune (env-overridable for experiments); stock
   *  models keep their own tuned defaults unless the env says otherwise. */
  private samplingOptions(): Record<string, number> {
    const envNum = (name: string): number | null => {
      const raw = process.env[name];
      if (raw === undefined || raw === "") return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    const t = envNum("COMFYUI_MCP_OLLAMA_TEMPERATURE");
    const k = envNum("COMFYUI_MCP_OLLAMA_TOP_K");
    const p = envNum("COMFYUI_MCP_OLLAMA_TOP_P");
    const out: Record<string, number> = {};
    if (t !== null) out.temperature = t;
    if (k !== null) out.top_k = k;
    if (p !== null) out.top_p = p;
    if (Object.keys(out).length) return out;
    // Fine-tune default: un-bake the Modelfile's temperature 0.
    return this.isFinetune() ? { temperature: 1.0, top_k: 64, top_p: 0.95 } : {};
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

  protected async connectTools(): Promise<void> {
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
                env: comfyuiSpawnEnv(spec.env),
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

  /** Whether the three panel_* router tools were actually registered for this
   *  session. ONE predicate, consulted by both the tool-def builder and the system
   *  prompt, so the prompt can never promise a router the surface does not carry —
   *  the two drifting apart is precisely the bug this exists to prevent. */
  protected panelRouterAvailable(): boolean {
    return this.panel !== null && this.panelTools.length > 0;
  }

  /** The six OpenAI-style tool defs the model sees (three, when the panel router
   *  is unavailable — see panelRouterAvailable). */
  protected buildModelTools(): Array<Record<string, unknown>> {
    const defs: Array<Record<string, unknown>> = [];
    for (const t of this.comfyTools) {
      defs.push({
        type: "function",
        function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema ?? { type: "object", properties: {} } },
      });
    }
    if (this.panelRouterAvailable()) {
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
  protected async dispatch(name: string, rawArgs: Record<string, unknown> | string): Promise<{ text: string; isError: boolean }> {
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
        // #325 — a blocking card tool (panel_ask / secret / consent) waits on the
        // HUMAN up to ~285-300s server-side; the MCP SDK's 60s default request
        // timeout would kill the call first ("MCP error -32001: Request timed
        // out") and silently drop the user's eventual pick. Carry a timeout that
        // covers the longest card (harmless for fast tools — an upper bound only).
        const res = await this.panel.callTool(
          { name: wanted, arguments: inner as Record<string, unknown> },
          undefined,
          { timeout: PANEL_TOOL_MCP_TIMEOUT_MS },
        );
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
        // Same #325 timeout as the panel_call_tool router path above.
        const res = await this.panel.callTool({ name, arguments: args }, undefined, {
          timeout: PANEL_TOOL_MCP_TIMEOUT_MS,
        });
        return { text: textOf(res), isError: !!res.isError };
      }
      if (this.comfy && this.comfyTools.some((t) => t.name === "call_tool")) {
        const res = await this.comfy.callTool({ name: "call_tool", arguments: { name, args } });
        return { text: textOf(res), isError: !!res.isError };
      }
      // Same retired-name courtesy as the compact server's call_tool (#659):
      // with no call_tool meta to delegate to, this fallback is the last word
      // the model gets, so a ledger name must name its replacement rather than
      // drown in the full Available list.
      const retired = retiredToolMessage(name);
      if (retired) return { text: retired, isError: true };
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
                // Pin temperature for tool precision — the project's recipe
                // everywhere else (arena, GGUF validation, the Ollama tags'
                // Modelfiles all run temp 0). Endpoints with no server-side
                // default (LM Studio serving a raw GGUF) otherwise sample at
                // ~0.8, where small models nondeterministically emit an EMPTY
                // final message after tool results (found live on e2b).
                temperature: process.env.COMFYUI_MCP_OLLAMA_TEMPERATURE
                  ? Number(process.env.COMFYUI_MCP_OLLAMA_TEMPERATURE)
                  : 0,
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
                // See OllamaBackendDeps.numCtx: omit for our fine-tune so the
                // tag's baked 65536 window governs instead of clamping it.
                // samplingOptions un-bakes the fine-tune's Modelfile temp 0.
                options: {
                  ...(this.effectiveNumCtx() ? { num_ctx: this.effectiveNumCtx() } : {}),
                  ...this.samplingOptions(),
                },
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
          // Context-pressure telltale: when the prompt fills ≥85% of the
          // window, the NEXT turn will likely truncate history silently (the
          // model "forgets" the conversation with no error anywhere). Surface
          // it in the orchestrator log so the swamp is diagnosable.
          const win = this.contextWindow();
          if (usage.input_tokens >= win * 0.85) {
            logger.warn(
              `[ollama-backend] context ${usage.input_tokens}/${win} tokens (${Math.round((usage.input_tokens / win) * 100)}%) — history truncation imminent. Raise COMFYUI_MCP_OLLAMA_NUM_CTX (arch supports 128K on :e2b/:e4b, 256K on :12b, VRAM permitting) or start a fresh chat.`,
            );
          }
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
      //
      // Which is exactly why the orchestrator's panel-tools retraction cannot
      // reach this lane: it rides on systemAppend, and this adapter drops that.
      // So the retraction is re-derived HERE from the thing this backend knows
      // first-hand — whether it actually registered the panel router — and appended
      // to its own prompt. Without it, OLLAMA_SYSTEM_PROMPT goes on promising
      // "exactly six tools" including three that were never registered, which is
      // the same false capability claim for ollama / openrouter / lmstudio /
      // llamacpp / custom / kimi.
      this.history = [
        {
          role: "system",
          content:
            resolvePrompt("backend.ollama", OLLAMA_SYSTEM_PROMPT) +
            ollamaPanelRetraction(this.panelRouterAvailable()),
        },
      ];
    }
    yield { type: "session", sessionId: this.sessionId, model: this.model };

    let turnSeq = 0;
    for await (const turn of opts.channel) {
      yield* stampTurn(this.runTurn(turn, opts), ++turnSeq);
    }
  }

  /** Fetch a ComfyUI image ref as raw base64 + mime, or null on any failure
   *  (mirrors ClaudeBackend.fetchImageBlock; the text reference still names the
   *  file as a fallback). */
  protected async fetchImageB64(ref: ImageRef): Promise<{ b64: string; mime: string } | null> {
    if (!this.deps.comfyuiUrl || !ref?.filename) return null;
    try {
      const u = new URL("/view", this.deps.comfyuiUrl);
      u.searchParams.set("filename", ref.filename);
      u.searchParams.set("type", ref.type || "input");
      if (ref.subfolder) u.searchParams.set("subfolder", ref.subfolder);
      const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        logger.warn(`[ollama-backend] image ref fetch failed (${ref.filename}): http ${res.status}`);
        return null;
      }
      let mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)) mime = "image/png";
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 12 * 1024 * 1024) {
        logger.warn(`[ollama-backend] image ref too large to inline (${ref.filename}: ${buf.length} bytes)`);
        return null;
      }
      return { b64: buf.toString("base64"), mime };
    } catch (err) {
      logger.warn(`[ollama-backend] image ref fetch failed (${ref?.filename ?? "?"}): ${msgOf(err)}`);
      return null;
    }
  }

  /** Remove every inline image from history after an endpoint rejected image
   *  input, leaving an honest note in the affected user messages so the model
   *  never pretends it saw them. One-shot per turn (see runTurn). */
  private stripImagesFromHistory(): void {
    for (const m of this.history) {
      if (m.images?.length) {
        delete m.images;
        delete m.imageMimes;
        m.content +=
          "\n[note: the attached image(s) were removed — this model/endpoint rejected image input. You did NOT see them; tell the user so if it matters.]";
      }
    }
  }

  private async *runTurn(turn: NeutralTurn, opts: BackendStartOptions): AsyncIterable<AgentEvent> {
    const abort = new AbortController();
    this.turnAbort = abort;
    const tools = this.buildModelTools();
    // Vision is a per-MODEL property (gemma4 sees images, qwen3 doesn't;
    // DeepSeek's API rejects image parts outright), so ALWAYS attempt delivery:
    // resolve the ComfyUI refs inline and let the strip-and-retry below handle
    // endpoints that reject them.
    const userMsg: ChatMessage = { role: "user", content: turn.text };
    if (turn.images?.length) {
      const resolved = (await Promise.all(turn.images.slice(0, 4).map((r) => this.fetchImageB64(r)))).filter(
        (r): r is { b64: string; mime: string } => r !== null,
      );
      if (resolved.length) {
        userMsg.images = resolved.map((r) => r.b64);
        userMsg.imageMimes = resolved.map((r) => r.mime);
      }
    }
    this.history.push(userMsg);

    let resultEmitted = false;
    // Loop-breaker: small models (especially stock ones) can wedge into
    // re-issuing the SAME tool call verbatim for dozens of rounds (field:
    // 30+ identical list_tools searches hunting a pack name). Track exact
    // (name, args) repeats per turn: 2nd+ identical call is blocked with a
    // corrective tool result instead of dispatched; at 4 repeats the turn is
    // ended outright.
    const seenCalls = new Map<string, number>();
    let maxRepeats = 0;
    // Second wedge shape (field: Discord "circles" report): the model spams a
    // DISCOVERY meta-tool with a DIFFERENT search each round (list_tools
    // {"search":"lora"} → {"search":"civitai"} → {"search":"flux"} …), hunting a
    // capability that isn't in the catalog — every call is unique so the
    // exact-repeat breaker above never fires. Count calls per discovery tool
    // (ignoring args); past a threshold, stop searching and tell it the truth
    // (some capabilities live in OPTIONAL companion servers). describe_tool is
    // NOT here — describing many distinct tools is legitimate exploration.
    const DISCOVERY_TOOLS = new Set(["list_tools", "panel_list_tools", "search_models", "search_custom_nodes"]);
    const discoveryCounts = new Map<string, number>();
    let emptyFinalRetried = false;
    let imagesStripped = false;
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        // Drain the chat stream manually: yield each delta event as it arrives,
        // and capture the generator's RETURN value (the accumulated message).
        const stream = this.chatStream(this.history, tools, abort.signal, opts.onActivity);
        let content = "";
        let toolCalls: OllamaToolCall[] = [];
        let usage: Record<string, number> | undefined;
        let streamId: string | null = null;
        try {
          for (;;) {
            const r = await stream.next();
            if (r.done) {
              ({ content, toolCalls, usage, streamId } = r.value);
              break;
            }
            yield r.value;
          }
        } catch (err) {
          // GRACEFUL IMAGE DEGRADATION: if the request carried inline images
          // and the endpoint rejected it (text-only model — e.g. DeepSeek 400s
          // on image parts; a non-vision Ollama model can error at prompt
          // build), retry ONCE with the images stripped and an honest note in
          // both directions. Any other failure re-throws to the normal handler.
          if (!abort.signal.aborted && !imagesStripped && this.history.some((m) => m.images?.length)) {
            imagesStripped = true;
            logger.warn(`[ollama-backend] image input rejected (${msgOf(err).slice(0, 200)}) — retrying without images`);
            this.stripImagesFromHistory();
            yield {
              type: "assistant",
              text: `📎 ${this.model} rejected image input, so I'm continuing without the attachment — I can't see the image. Describe it in words, or switch to a vision-capable model.`,
            };
            round--; // the rejected request didn't count as a tool round
            continue;
          }
          throw err;
        }

        if (!toolCalls.length) {
          // EMPTY-FINAL recovery (live E2E, native dialect, temp 0): after a
          // run of tool rounds the model sometimes emits a final message with
          // NO content — the turn would "complete" in total silence. Nudge it
          // ONCE to summarize; a second empty reply falls through (never loop).
          if (!content.trim() && round > 0 && !emptyFinalRetried) {
            emptyFinalRetried = true;
            this.history.push({ role: "assistant", content });
            this.history.push({
              role: "user",
              content:
                "(system: your reply was EMPTY. In 1-3 sentences, tell the user what you found or did with the tools above, and what you recommend next. Do not call any more tools.)",
            });
            continue;
          }
          // Record the final answer in history too — without this, the NEXT
          // turn's context is missing the model's own previous replies (and
          // the transcript dump ends mid-conversation on a tool message).
          this.history.push({ role: "assistant", content });
          // NEVER end a tool-using turn in total silence (live panel test: a
          // Civitai 503 → empty final → empty retry → the user stared at a raw
          // tool error with no explanation). History keeps the raw empty
          // content; only the USER-FACING text gets the fallback.
          const finalText =
            content.trim() || (round === 0
              ? content
              : "(I ran the tools above but couldn't compose a reply — check the last tool result. Say “continue” to have me try again, or rephrase the request.)");
          yield { type: "assistant", text: finalText, id: streamId ?? undefined, usage };
          yield { type: "result", ok: true, usage };
          resultEmitted = true;
          return;
        }

        this.history.push({ role: "assistant", content, tool_calls: toolCalls });
        for (const [i, tc] of toolCalls.entries()) {
          if (abort.signal.aborted) throw new Error("interrupted");
          const name = tc.function?.name ?? "?";
          const args = tc.function?.arguments ?? {};
          const callKey = `${name}:${typeof args === "string" ? args : JSON.stringify(args)}`;
          const repeats = (seenCalls.get(callKey) ?? 0) + 1;
          seenCalls.set(callKey, repeats);
          maxRepeats = Math.max(maxRepeats, repeats);
          const discoveryHits = DISCOVERY_TOOLS.has(name)
            ? (discoveryCounts.set(name, (discoveryCounts.get(name) ?? 0) + 1), discoveryCounts.get(name)!)
            : 0;
          yield { type: "tool_call", name, phase: "start", detail: tc.function?.arguments };
          const { text, isError } =
            repeats >= 2
              ? {
                  // Every emitted tool_call still needs a paired tool result
                  // (the wire format breaks otherwise) — answer the repeat
                  // with a corrective nudge instead of re-running it.
                  text:
                    `REPEAT CALL BLOCKED: you already called ${name} with these exact arguments this turn — the result has not changed. ` +
                    `Do not call it again. Use the earlier result, or try DIFFERENT arguments or a different tool. ` +
                    `Model families like krea2 / qwen-image-edit / wan / ltxv are installer PACKS, not tools: call_tool {"name":"list_packs"} to find them, then load one. ` +
                    `If you are stuck, tell the user what you found and ask how to proceed.`,
                  isError: true,
                }
              : discoveryHits >= 4
                ? {
                    // Searched the catalog 4+ times with no hit — the capability
                    // isn't here. Stop, and name the most common trap (Civitai
                    // search lives in the OPTIONAL companion server, not here).
                    text:
                      `SEARCH LIMIT: you have called ${name} ${discoveryHits} times without finding a matching tool — it is very likely NOT in this catalog. STOP searching. ` +
                      `Common misses: GRAPH/CANVAS actions (add a node, connect slots, set a widget, run the workflow) are PANEL tools — panel_call_tool {"name":"panel_add_node"} / panel_connect / panel_set_widget / panel_run, listed by panel_list_tools, NOT here. ` +
                      `Civitai keyword search is the search_civitai_models tool (filter by types + base_models, then download_civitai_model); ` +
                      `model families like krea2 / qwen-image-edit / wan / ltxv are installer PACKS — call_tool {"name":"list_packs"}. ` +
                      `Otherwise, tell the user plainly what IS available and ask how they want to proceed. Do not call ${name} again.`,
                    isError: true,
                  }
                : await this.dispatch(name, args);
          opts.onActivity?.();
          yield { type: "tool_call", name, phase: "end", detail: { isError } };
          this.history.push({
            role: "tool",
            tool_name: name,
            tool_call_id: tc.id ?? `call_${i}`,
            content: text.slice(0, 16000),
          });
        }
        const maxDiscovery = Math.max(0, ...discoveryCounts.values());
        if (maxRepeats >= 4 || maxDiscovery >= 8) {
          logger.warn(
            `[ollama-backend] tool loop broken: repeats=${maxRepeats} discovery=${maxDiscovery} this turn (${this.model})`,
          );
          // Honest, breaker-specific stop copy (live E2E caught the old one
          // recommending the fine-tune TO the fine-tune). Discovery wedge →
          // the capability likely isn't here; repeat wedge → the model stalled.
          const switchTip = this.isFinetune()
            ? ""
            : " If you're on a stock model, `artokun/gemma4-comfyui-mcp:e4b` knows this tool suite and gets stuck far less.";
          yield {
            type: "assistant",
            text:
              maxDiscovery >= 8
                ? `(stopped: I searched the tool catalog ${maxDiscovery} times without finding what I was looking for — that capability probably isn't available here. Tell me how you'd like to proceed.${switchTip})`
                : `(stopped: I kept repeating the same tool call without progress. Try rephrasing the request, or break it into smaller steps.${switchTip})`,
          };
          yield { type: "result", ok: false, subtype: "tool_loop" };
          resultEmitted = true;
          return;
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
        JSON.stringify(
          {
            model: this.model,
            // Inline image payloads are elided — a single screenshot would
            // dwarf the whole conversation in the datagen transcript.
            messages: this.history.map((m) =>
              m.images?.length ? { ...m, images: m.images.map(() => "[inline image omitted]") } : m,
            ),
          },
          null,
          2,
        ),
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
        // Sort the overflow alphabetically so a vendor's models CLUSTER (all
        // deepseek/* together, findable). The cap must cover OpenRouter's WHOLE
        // catalog: because the list is sorted alphabetically, any cap shorter than
        // the catalog silently drops whole late-alphabet vendors — a 150-slice hid
        // every `z-ai/*` model (GLM 5.x), so the list "stopped at moonshot/kimi-k3"
        // and z-ai was unreachable (issue #326; the earlier 40-slice hid
        // deepseek-v4-pro the same way). OpenRouter serves ~300-400 models; keep a
        // large bound so nothing is cut, but still guard against a pathological
        // response. The picker has search, so a long list is fine.
        const rest = ids
          .filter((id) => id !== this.model && !recIds.has(id))
          .sort((a, b) => a.localeCompare(b))
          .slice(0, 1000);
        // llama-server reports its single model as the GGUF's FILE PATH —
        // keep the id verbatim (the server echoes it) but label by basename
        // so the picker isn't a wall of C:\...\model.gguf.
        const labelOf = (id: string) => {
          const cut = Math.max(id.lastIndexOf("/"), id.lastIndexOf("\\"));
          const base = cut >= 0 ? id.slice(cut + 1) : id;
          return base !== id && /\.gguf$/i.test(base) ? base : id;
        };
        const out: ModelChoice[] = recommended.map((m) => ({ id: m.id, label: m.label }));
        // Guard: an UNSET configured model ("" — LM Studio/llama.cpp presets
        // adopt-first-served) must not inject an empty picker entry.
        if (this.model && !recIds.has(this.model)) out.push({ id: this.model, label: labelOf(this.model) });
        for (const id of rest) out.push({ id, label: labelOf(id) });
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
