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
import { type ToolModeDecision, resolveToolModeForModel } from "../services/tool-mode-policy.js";
import type { ToolMode } from "../transport/cli.js";
import {
  type AudioConfidence,
  type AudioOutcome,
  type AudioRef,
  type AudioFetchResult,
  MAX_AUDIO_ATTACHMENTS,
  audioDeliveredModelNote,
  audioModelNote,
  audioUnverifiedModelNote,
  audioUserNotice,
  fetchAudioAttachment,
  modelLacksAudioText,
  openAiAudioFormat,
  tooManyAudioText,
} from "./audio-attachment.js";
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
 * Tool mode for the headless comfyui MCP child this backend spawns (#667, #788).
 *
 * Compact is the floor on this path because the backend feeds the advertised
 * tool defs straight into a local model's context — the full schema list can
 * fill most of a 16k num_ctx before the conversation starts.
 *
 * #788 adds the missing direction: when nobody has chosen a mode, the MODEL
 * decides. A large local model is no longer held to the 3-tool router just
 * because it is local (provider was always a bad proxy — see
 * services/tool-mode-policy.ts), and a small one keeps the compact default.
 *
 * Precedence is unchanged where it existed: an explicit COMFYUI_MCP_TOOL_MODE —
 * the spec's or the user's own env — WINS, in BOTH directions. Auto-selection
 * only fills the gap where the previous code applied a blind `?? "compact"`.
 */
export function comfyuiSpawnToolMode(
  specEnv: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
  model?: string,
): ToolModeDecision {
  return resolveToolModeForModel({ model, env, callerEnv: specEnv });
}

/**
 * Spawn env for the headless comfyui MCP child. Thin wrapper over
 * comfyuiSpawnToolMode so callers that only need the env keep the old shape.
 */
export function comfyuiSpawnEnv(
  specEnv: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
  model?: string,
) {
  return {
    ...env,
    ...specEnv,
    COMFYUI_MCP_TOOL_MODE: comfyuiSpawnToolMode(specEnv, env, model).mode,
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
  /** Inline AUDIO payloads (raw base64, no data: prefix) — #790. Kept in a
   *  SEPARATE field from `images` even though Ollama's native wire merges the
   *  two, because the OpenAI dialect does not: audio there is an `input_audio`
   *  part and an audio data-URL in an `image_url` part is a hard 400 ("invalid
   *  image input", reproduced live). One field for both would guarantee that
   *  mis-encode on every openai-dialect endpoint. */
  audios?: string[];
  /** Mime types parallel to `audios`. */
  audioMimes?: string[];
  /** True once a request carrying THIS message's media came back successfully
   *  (#790). A later strip still removes the bytes - the retry has to be clean -
   *  but the note it leaves must not tell the model it never received media it
   *  demonstrably did. Fabricating a non-delivery for an accepted attachment is
   *  the same class of error as hiding a real one. */
  mediaDelivered?: boolean;
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
    if (m.role === "user" && (m.images?.length || m.audios?.length)) {
      return {
        role: "user",
        content: [
          { type: "text", text: m.content },
          ...(m.images ?? []).map((b64, i) => ({
            type: "image_url",
            image_url: { url: `data:${m.imageMimes?.[i] ?? "image/png"};base64,${b64}` },
          })),
          // #790 — the OpenAI audio content part. Verified live against Ollama's
          // /v1/chat/completions (gemma4:e2b transcribed a WAV delivered this
          // way); it is also the shape OpenAI-compatible hosts implement.
          ...(m.audios ?? []).map((b64, i) => ({
            type: "input_audio",
            input_audio: { data: b64, format: openAiAudioFormat(m.audioMimes?.[i] ?? "audio/wav") },
          })),
        ],
      };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * Convert the neutral in-memory history to the NATIVE Ollama wire shape.
 *
 * The one transform that matters: Ollama has no separate audio field — audio
 * bytes ride in `message.images[]`, the same array as pictures. That is not a
 * guess: Ollama's own OpenAI-compatible transcription endpoint does exactly this
 * (`FromTranscriptionRequest` puts the uploaded AudioData into `Images`), and it
 * was confirmed live on 2026-08-04 — a WAV posted in `images[]` to gemma4:e2b
 * came back correctly transcribed, and cost +40 prompt tokens over the same
 * text-only turn, while the same bytes under an `audio` key cost 0 extra tokens
 * (i.e. were silently ignored). Our internal `audios`/`audioMimes` fields are
 * dropped here so nothing ships a key the daemon would discard.
 */
function toOllamaMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const { audios, audioMimes, ...rest } = m;
    void audioMimes; // native wire infers the container from the bytes
    if (!audios?.length) return rest as unknown as Record<string, unknown>;
    return { ...rest, images: [...(m.images ?? []), ...audios] } as unknown as Record<string, unknown>;
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
 *
 * And it makes NO claim about the headless server, for the same reason. Two earlier
 * drafts said its tools were "unaffected" and that a restart would bring the canvas
 * back. Neither is observed here: connectTools() catches a failed headless connection
 * independently and leaves `comfy` null, so this prompt can be emitted with NOTHING
 * connected; and the tool set is fixed for the life of the session, so the panel
 * router cannot return within it — while a restart only helps if the bind succeeds
 * next time, which a still-occupied port will not. Retracting a false capability
 * claim and attaching two fresh unverified ones in its place is the same defect
 * wearing the fix's clothes.
 */
export function ollamaPanelRetraction(panelRouterAvailable: boolean): string {
  if (panelRouterAvailable) return "";
  return [
    "",
    "",
    "CORRECTION — THIS OVERRIDES THE TOOL LIST ABOVE:",
    "The live-canvas router did not start this session. panel_list_tools, panel_describe_tool and panel_call_tool DO NOT EXIST right now — do not call them, and never claim to have read or edited the user's canvas.",
    "That is ALL this tells you. It says nothing about the headless ComfyUI server, which is a separate connection that can succeed or fail on its own — so go by the tool list you were actually handed, not by any count named above. If it carries list_tools / describe_tool / call_tool, use them; if it carries nothing either, say so rather than guessing.",
    "The panel tools cannot come back during this session — the tool set was fixed when it started. If the user asks about the graph open in front of them, tell them the live-canvas tools failed to start and that you have no way to reach the canvas until the orchestrator is restarted. Do not promise that a restart will fix it: whether it does depends on why the bind failed, and a port that is still occupied will fail the same way again.",
  ].join("\n");
}

const OLLAMA_PROMPT_HEAD = [
  "You are the ComfyUI agent in a sidebar panel, driving the user's live ComfyUI graph and server. Answer in normal Markdown.",
  "",
];

/** Tool-surface paragraph for the COMPACT router (the default surface). */
const OLLAMA_PROMPT_TOOLS_COMPACT = [
  "You have exactly six tools:",
  '- list_tools / describe_tool / call_tool — the headless ComfyUI server (~200 capabilities: generate images/video/audio, models, custom nodes, queue, diagnostics). Flow: list_tools {"search": ...} → describe_tool {"name": ...} → call_tool {"name": ..., "args": {...}}.',
  "- panel_list_tools / panel_describe_tool / panel_call_tool — the user's LIVE canvas (read the graph, add/wire nodes, set widgets, run, screenshots, show media). Same flow.",
  "",
];

/**
 * Tool-surface paragraph when the comfyui child was spawned FULL (#788).
 *
 * This has to vary with the mode. The compact wording tells the model it "has
 * exactly six tools" and routes everything through call_tool — which is simply
 * FALSE once the child advertises its whole catalog directly, and a model that
 * believes it keeps calling a router that is no longer the way in. Auto-selecting
 * full while asserting the tools don't exist would make the new selection worse
 * than the old default, not better.
 *
 * The count is deliberately not stated: it is whatever the live catalog holds,
 * and #726 rewrites it.
 */
const OLLAMA_PROMPT_TOOLS_FULL = [
  "Your tools come in two groups:",
  "- The headless ComfyUI server's tools are advertised to you DIRECTLY, by name, with their schemas — generate images/video/audio, manage models and custom nodes, drive the queue, run diagnostics. Call them straight; there is no router to go through for those.",
  '- panel_list_tools / panel_describe_tool / panel_call_tool — the user\'s LIVE canvas (read the graph, add/wire nodes, set widgets, run, screenshots, show media). These ARE a router: panel_list_tools {"search": ...} → panel_describe_tool {"name": ...} → panel_call_tool {"name": ..., "args": {...}}.',
  "",
];

const OLLAMA_PROMPT_RULES = [
  "Rules:",
  "- Catalog entries are tool NAMES, not data. Finish every task by actually running tools; never invent results.",
  "- Describe a tool before its first call so you use the right parameters. If a call errors, read the error — it includes the expected schema — fix the args and retry.",
  "- To read the user's graph, ALWAYS start with panel_graph_outline (a compact text map) via panel_call_tool. For specifics use panel_query_graph — filter by types/where ('cfg>7'), traverse upstream_of/downstream_of, or read ONE node's exact detail with {ids:[id], fields:'detail'}. Its output is token-bounded, so it can never flood your context.",
  "- To EDIT the graph — add a node (e.g. a LoraLoader after a download), wire slots, set widgets, run — those are PANEL tools too: panel_call_tool with panel_add_node / panel_connect / panel_set_widget / panel_run. Do NOT search the headless list_tools catalog for graph editing; it is not there.",
  "- To see or show any generated image/video, run the panel_show_media tool via panel_call_tool.",
  "- Workflows with API nodes cost the user PAID credits; local-GPU workflows are free. Ask before anything that might spend credits.",
];

/** The built-in prompt for a given tool mode. `full` is reached only via #788's
 *  per-model auto-selection or an explicit override. */
export function ollamaSystemPrompt(mode: ToolMode = "compact"): string {
  return [
    ...OLLAMA_PROMPT_HEAD,
    ...(mode === "full" ? OLLAMA_PROMPT_TOOLS_FULL : OLLAMA_PROMPT_TOOLS_COMPACT),
    ...OLLAMA_PROMPT_RULES,
  ].join("\n");
}

/** The COMPACT prompt as a named export: it is the default surface, and the text
 *  the panel's prompt editor registers and can override. */
export const OLLAMA_SYSTEM_PROMPT = ollamaSystemPrompt("compact");

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

/**
 * The `action` of a consolidated tool call, so a per-tool heuristic can be
 * scoped to ONE action of a tool whose other actions are unrelated (and, for
 * download_model, expensive). Returns undefined for a flat tool, a non-string
 * action, or arguments that do not parse — every caller must treat that as "not
 * this action" rather than guessing.
 *
 * Tolerates the string-encoded arguments some Ollama builds send, which is the
 * same reason the repeat-call key stringifies rather than reads them.
 */
function toolCallAction(args: unknown): string | undefined {
  let obj: unknown = args;
  if (typeof args === "string") {
    try {
      obj = JSON.parse(args);
    } catch {
      return undefined;
    }
  }
  if (!obj || typeof obj !== "object") return undefined;
  const action = (obj as { action?: unknown }).action;
  return typeof action === "string" ? action : undefined;
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
  // `gpt-oss:120b` is an Ollama tag for a LOCAL model, not a hosted OpenAI one,
  // and #788 names it as a model that auto-selects the full tool surface. The
  // blanket ^gpt exclusion refused to switch to it: the panel would show the new
  // model while the backend kept running the old one and its tool surface -
  // wrong-model confusion exactly where model-keyed selection is the promise.
  return (id.includes(":") || id.includes("/")) && !isHostedFrontierModel(id);
}

/** The hosted families PanelAgent may pass through unconditionally. This is the
 *  ONLY thing the model-id guards are really defending against. */
function isHostedFrontierModel(id: string): boolean {
  return /^claude|^gemini/i.test(id) || (/^gpt/i.test(id) && !/^gpt-oss/i.test(id));
}

/**
 * Will THIS backend instance take `id` as its model?
 *
 * The shape rules above are an Ollama-tag heuristic, and they are wrong for the
 * OpenAI-compatible dialect: that picker is populated from the endpoint's OWN
 * `/models` catalog, which returns whatever the server calls its models -
 * LM Studio's `local-model-70b` has neither a colon nor a slash. Rejecting those
 * meant a live switch was silently ignored while PanelAgent recorded and
 * displayed the new model: the next turn ran the OLD model on the OLD tool
 * surface, which is exactly the wrong-model confusion #788's model-keyed
 * selection exists to prevent.
 *
 * The one thing worth guarding stays guarded on both dialects: PanelAgent passes
 * the panel's Claude model into every backend, and that must never be adopted.
 */
export function acceptsModelId(id: string, api: "ollama" | "openai"): boolean {
  if (!id.trim()) return false;
  if (isHostedFrontierModel(id)) return false;
  // Native Ollama: a real tag always carries a ":" or an org "/" prefix, and the
  // heuristic is what keeps a stray bare word from being adopted as a model.
  if (api === "ollama") return id.includes(":") || id.includes("/");
  // OpenAI-compatible: the id came from this endpoint's own catalog.
  return true;
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
  /** The tool-mode decision the comfyui child was ACTUALLY spawned with (#788),
   *  kept so the active mode and its REASON are visible rather than inferred.
   *  Never updated speculatively: it must always describe the live surface, so a
   *  model switch only rewrites it once the child has really been respawned. */
  protected toolModeDecision: ToolModeDecision | null = null;
  /** The comfyui child's spawn-spec env, retained so a live model switch can
   *  re-decide the tool mode against the same caller-level pins (#788). */
  protected comfySpecEnv: Record<string, string> | undefined;

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
      `[ollama-backend] ready (${this.api === "openai" ? `openai-compatible @ ${this.host}` : `ollama ${version}`}, model ${this.model}, ${this.comfyTools.length} comfyui tools, ${this.panelTools.length} panel tools behind the router)` +
        (this.toolModeDecision ? ` — ${this.toolModeDecision.explain}` : ""),
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
            // #788 — record WHY this surface is what it is, so the ready line can
            // say it. "compact was applied" and "compact was applied because of
            // the model" are different facts and the user is owed the second one.
            this.comfySpecEnv = spec.env;
            const decision = comfyuiSpawnToolMode(spec.env, process.env, this.model);
            const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
            await client.connect(
              new StdioClientTransport({
                command: spec.command,
                args: spec.args ?? [],
                env: comfyuiSpawnEnv(spec.env, process.env, this.model),
              }),
            );
            this.comfy = client as unknown as McpToolClient;
            // Recorded ONLY once the child is really up. This catch swallows
            // connect failures, so setting it earlier would leave a decision
            // describing a surface that does not exist — and reconcile would
            // then see "already in the right mode" and never retry the spawn.
            this.toolModeDecision = decision;
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
    // A client that CONNECTED can still fail to enumerate. Leaving `comfy` and
    // the tool-mode decision in place with an empty catalog would report a
    // surface the model does not actually have, and reconcile would read it as
    // live-and-matching and never retry the spawn. Tear it down instead.
    try {
      if (this.comfy) this.comfyTools = (await this.comfy.listTools()).tools;
    } catch (err) {
      logger.warn(`[ollama-backend] comfyui tool listing failed: ${msgOf(err)} — dropping the tool surface`);
      await this.comfy?.close().catch(() => {});
      this.comfy = null;
      this.comfyTools = [];
      this.clearToolModeDecision();
    }
    try {
      if (this.panel) this.panelTools = (await this.panel.listTools()).tools;
    } catch (err) {
      logger.warn(`[ollama-backend] panel tool listing failed: ${msgOf(err)} — dropping the panel surface`);
      await this.panel?.close().catch(() => {});
      this.panel = null;
      this.panelTools = [];
    }
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
                messages: toOllamaMessages(messages),
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
      // Stamp the HTTP status on the error. The media strip-and-retry (#790)
      // must fire ONLY on a request the endpoint actually rejected: a connection
      // reset or a truncated stream is not evidence that the model refused the
      // attachment, and saying "you were not heard" on one of those would report
      // a delivery state nobody observed.
      throw Object.assign(
        new Error(
          // unknown-ok: "" is interpolated into an ERROR MESSAGE and nothing else — the
          // HTTP status is reported either way, so an unreadable body costs detail in the
          // text, never a wrong conclusion. Verified there is no branch on this value.
          `${this.api === "openai" ? `${this.host}/chat/completions` : "ollama /api/chat"} http ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`,
        ),
        { httpStatus: res.status },
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

  /**
   * The system prompt for the surface that ACTUALLY exists right now: the tool
   * mode the comfyui child was really spawned with, plus the retraction for a
   * panel router that was never registered.
   *
   * ONE builder, used by both the session opener and the post-switch rewrite,
   * because those are the two places the prompt is written and they must not
   * disagree. An earlier shape rebuilt the prompt after a live model switch
   * WITHOUT the retraction, which silently restored the "you have panel_*"
   * claim in a session whose router had failed to bind.
   *
   * `resolvePrompt` still returns a user override unchanged; the retraction is
   * appended either way, because it corrects what was REGISTERED and no prompt
   * override or tool mode changes that.
   */
  protected systemPromptForSurface(): string {
    return (
      resolvePrompt("backend.ollama", ollamaSystemPrompt(this.toolModeDecision?.mode ?? "compact")) +
      ollamaPanelRetraction(this.panelRouterAvailable())
    );
  }

  async *run(opts: BackendStartOptions): AsyncIterable<AgentEvent> {
    await this.prepare();
    if (opts.model && acceptsModelId(opts.model, this.api)) this.model = opts.model;

    // Ollama is stateless — "session" is our in-memory history. A resume id is
    // honored in name (the panel replays the transcript as context anyway).
    const fresh = !this.sessionId || (opts.resume && opts.resume !== this.sessionId);
    this.sessionId = opts.resume ?? this.sessionId ?? `ollama-${randomUUID()}`;
    if (fresh) {
      // deps.systemAppend (the frontier panel prompt) is intentionally NOT
      // used — see OLLAMA_SYSTEM_PROMPT.
      // #788 — the prompt must describe the surface that was ACTUALLY advertised
      // to this model. A user override (the panel's prompt editor) still wins;
      // only the built-in default varies by mode.
      //
      // The panel-tools retraction rides the same message: it cannot reach this
      // lane via systemAppend (this adapter drops that), so it is re-derived from
      // what this backend knows first-hand — whether it actually registered the
      // panel router — and appended here. Without it the prompt goes on promising
      // panel routers that were never registered (#841 lineage). Built by
      // systemPromptForSurface(), which the post-model-switch rewrite also uses,
      // so the two writers cannot disagree about what this session was told.
      this.history = [{ role: "system", content: this.systemPromptForSurface() }];
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
      const hadMedia = !!(m.images?.length || m.audios?.length);
      if (!hadMedia) continue;
      const delivered = m.mediaDelivered === true;
      const kinds = [m.images?.length ? "image(s)" : null, m.audios?.length ? "audio" : null]
        .filter(Boolean)
        .join(" and ");
      delete m.images;
      delete m.imageMimes;
      delete m.audios;
      delete m.audioMimes;
      m.content += delivered
        ? // The model DID receive this earlier; it is only being dropped from
          // context so the retry is clean. Telling it otherwise would fabricate
          // a non-delivery.
          `\n[note: the attached ${kinds} were removed from this message so a rejected request could be retried. You DID receive them earlier in this conversation - nothing was lost, but they are no longer in your context.]`
        : `\n[note: the attached ${kinds} were removed - this model/endpoint rejected media input. You did NOT receive them: you did not see any image and did not hear any audio. Say so plainly rather than describing, transcribing or guessing at the contents.]`;
    }
  }

  /**
   * Capabilities the SERVER reports for the active model (#790), or null when we
   * could not establish them.
   *
   * Only `POST /api/show` is authoritative. `GET /api/tags` also returns a
   * `capabilities` array and it is NOT the same answer: measured live on
   * 2026-08-04, `gemma4:e2b` came back as ["completion","tools","thinking"] from
   * /api/tags and ["completion","vision","audio","tools","thinking"] from
   * /api/show — the SAME model, one list missing both media capabilities. Using
   * the cheap list would refuse audio to a model that can hear.
   *
   * null means UNKNOWN, never "no". A probe that fails (daemon busy loading a
   * model, a non-Ollama OpenAI-compatible host with no such endpoint) is an
   * operation that failed, not a capability verdict — callers must degrade to
   * "attempt and say it is unconfirmed", not to a refusal.
   *
   * Deliberately NOT memoised. An Ollama tag is MUTABLE — `ollama pull` replaces
   * the weights under the same name — so a cached verdict can outlive the model
   * it described, and the dangerous direction is silent: audio sent to a model
   * that can no longer hear it and reported as delivered. This runs only on a
   * turn that actually carries audio, and it is one local HTTP request.
   */
  protected async probeModelCapabilities(): Promise<string[] | null> {
    if (this.api !== "ollama") return null; // no capability endpoint on this dialect
    try {
      const res = await fetch(`${this.host}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        logger.warn(`[ollama-backend] /api/show for ${this.model} returned http ${res.status} — model capabilities unknown`);
        return null;
      }
      const body = (await res.json()) as { capabilities?: unknown };
      if (!Array.isArray(body.capabilities)) {
        logger.warn(`[ollama-backend] /api/show for ${this.model} carried no capabilities array — unknown`);
        return null;
      }
      const caps = body.capabilities.filter((c): c is string => typeof c === "string");
      // A payload that is an array but yields no usable strings (or lost entries
      // to the filter) is MALFORMED, not an answer. Reading it as "no audio"
      // would turn a broken response into a confident refusal.
      if (caps.length === 0 || caps.length !== body.capabilities.length) {
        logger.warn(`[ollama-backend] /api/show for ${this.model} returned a malformed capabilities array - unknown`);
        return null;
      }
      return caps;
    } catch (err) {
      logger.warn(`[ollama-backend] /api/show probe failed for ${this.model}: ${msgOf(err)} — model capabilities unknown`);
      return null;
    }
  }

  /**
   * Fetch one audio attachment out of ComfyUI and classify it (#790). Every
   * failure path returns a REFUSAL carrying user-facing text, so no caller can
   * accidentally treat "couldn't read it" as "nothing to attach".
   */
  protected async resolveAudio(ref: AudioRef): Promise<AudioFetchResult> {
    return fetchAudioAttachment(this.deps.comfyuiUrl, ref);
  }

  /**
   * Attach this turn's audio to `userMsg` and report what actually happened.
   *
   * Order matters: establish the model's capability BEFORE fetching anything, so
   * a model that cannot hear produces a refusal naming a model that can rather
   * than a download plus a shrug.
   */
  protected async attachAudio(
    userMsg: ChatMessage,
    refs: readonly AudioRef[],
  ): Promise<{ outcomes: AudioOutcome[]; confidence: AudioConfidence }> {
    const outcomes: AudioOutcome[] = [];
    const caps = await this.probeModelCapabilities();
    if (caps && !caps.includes("audio")) {
      for (const ref of refs) {
        outcomes.push({
          status: "refused",
          filename: ref.filename,
          reason: "model-lacks-audio-capability",
          text: modelLacksAudioText(this.model, caps, ref.filename),
        });
      }
      return { outcomes, confidence: "established" };
    }
    // caps === null → the probe could not run. That is not a refusal (a guard
    // that fails is not a verdict): attempt delivery and mark it unconfirmed.
    const confidence: AudioConfidence = caps ? "established" : "unverified";
    for (const [i, ref] of refs.entries()) {
      if (i >= MAX_AUDIO_ATTACHMENTS) {
        outcomes.push({
          status: "refused",
          filename: ref.filename,
          reason: "too-large",
          text: tooManyAudioText(ref.filename, MAX_AUDIO_ATTACHMENTS),
        });
        continue;
      }
      const r = await this.resolveAudio(ref);
      if (!r.ok) {
        outcomes.push(r.outcome);
        continue;
      }
      (userMsg.audios ??= []).push(r.b64);
      (userMsg.audioMimes ??= []).push(r.mime);
      outcomes.push({ status: "delivered", filename: ref.filename, mime: r.mime, bytes: r.bytes });
    }
    return { outcomes, confidence };
  }

  private async *runTurn(turn: NeutralTurn, opts: BackendStartOptions): AsyncIterable<AgentEvent> {
    const abort = new AbortController();
    this.turnAbort = abort;
    // #788 — a live model switch may have changed which tool surface this model
    // should get. Reconcile BEFORE buildModelTools reads the catalog, and here
    // rather than in setModel because nothing is in flight at this point.
    await this.reconcileToolModeForModel();
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
    // #790 — audio. Unlike images this is NOT "always attempt": Ollama reports a
    // per-model capability list, so a model that cannot hear is told so by name
    // instead of being handed bytes it will ignore. Refusals are surfaced to the
    // user AND written into the turn text, so neither side can proceed as if the
    // sound had been heard.
    let audioOutcomes: AudioOutcome[] = [];
    let audioConfidence: AudioConfidence = "unverified";
    if (turn.audio?.length) {
      ({ outcomes: audioOutcomes, confidence: audioConfidence } = await this.attachAudio(userMsg, turn.audio));
      const refusalNote = audioModelNote(audioOutcomes);
      if (refusalNote) userMsg.content += refusalNote;
      const deliveredCount = audioOutcomes.filter((o) => o.status === "delivered").length;
      if (deliveredCount) {
        userMsg.content +=
          audioConfidence === "unverified"
            ? audioUnverifiedModelNote(deliveredCount)
            : audioDeliveredModelNote(deliveredCount, this.model);
      }
    }
    this.history.push(userMsg);
    if (audioOutcomes.length) {
      const notice = audioUserNotice(audioOutcomes, audioConfidence, this.model);
      if (notice) yield { type: "assistant", text: notice };
    }
    // What THIS turn attached, captured now: stripImagesFromHistory deletes the
    // fields, and the correction below must describe the sense the USER just
    // sent — not whatever happens to be left in the retained history.
    const turnSentAudio = !!userMsg.audios?.length;
    const turnSentImages = !!userMsg.images?.length;
    // Has THIS turn's media survived a successful request yet? Session-wide
    // proof is too coarse in the other direction: an earlier audio file landing
    // is not evidence that the one attached NOW was accepted (a codec the model
    // can't decode, a longer clip). Per-turn is the boundary at which "the model
    // did not receive it" is both plausible and, after the strip, true.
    let turnMediaAccepted = false;

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
    //
    // Keyed on `tool` + `action` for consolidated tools, and that is not
    // cosmetic: 0.50.0 slice 11 folded the HuggingFace search into
    // download_model action:"search", and the SAME tool name now also STARTS
    // MULTI-GB DOWNLOADS. Counting the bare name would answer a fourth
    // download_model {action:"download"} in one turn with a "SEARCH LIMIT"
    // refusal instead of downloading, and end the turn at eight — a fold
    // turning legitimate calls into refusals because the thing reading the
    // name was not updated with it (#839).
    const DISCOVERY_TOOLS = new Set([
      "list_tools",
      "panel_list_tools",
      'download_model action:"search"',
      // 0.50.0 slice 12: was the bare name. `search_custom_nodes` SURVIVES the
      // fold, but it now also covers the retired pack-DETAILS lookup as
      // action:"details" — and that name was never counted here. Keying the bare
      // name would start counting a call that never counted, on the workflow
      // that is CORRECT: search once, then read `details` for three or four
      // candidate packs. The fourth would be answered with "STOP searching"
      // while the model is doing exactly the right thing, and at eight the turn
      // breaks. Same #839 shape as the download_model case above, so the same
      // remedy: key the ACTION, and count only the keyword search.
      'search_custom_nodes action:"search"',
    ]);
    const discoveryCounts = new Map<string, number>();
    let emptyFinalRetried = false;
    let attachmentsStripped = false;
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
          // A request carrying THIS TURN's media came back. The model has it,
          // so a later error in this turn must not be reported as a rejection of
          // it (see the catch below) — that would fabricate a delivery failure
          // for media the model demonstrably received.
          if (turnSentImages || turnSentAudio) turnMediaAccepted = true;
          // Mark every message whose media just rode a successful request, so a
          // later strip can tell "you never got this" from "this was removed
          // from context after you got it".
          for (const m of this.history) {
            if (m.images?.length || m.audios?.length) m.mediaDelivered = true;
          }
        } catch (err) {
          // GRACEFUL IMAGE DEGRADATION: if the request carried inline images
          // and the endpoint rejected it (text-only model — e.g. DeepSeek 400s
          // on image parts; a non-vision Ollama model can error at prompt
          // build), retry ONCE with the images stripped and an honest note in
          // both directions. Any other failure re-throws to the normal handler.
          //
          // `turnMediaAccepted` is the guard against fabricating a failure:
          // once a request carrying THIS TURN's attachments has come back
          // successfully, the endpoint demonstrably took them, so a later error
          // — a middle tool round, a subsequent turn whose history still holds
          // the earlier media — is something else. Stripping then, and telling
          // the user "you were not heard", would report a delivery failure that
          // never happened for media the model had already received.
          //
          // …and it must be an OBSERVED rejection: the endpoint answered the
          // request carrying the media with an error STATUS, so nothing was
          // generated from it. A connection reset, a truncated body, or a
          // mid-stream failure after a 200 carries no status and says nothing
          // about the attachment — stripping on those would tell the user the
          // model "did NOT hear" something we never saw it refuse.
          //
          // 4xx ONLY, deliberately. A 5xx is the endpoint failing, not the
          // endpoint refusing what we sent: an upstream outage or a crashed
          // worker would be narrated as "${model} rejected the request carrying
          // the audio" — a cause we never observed — and the retry cannot help
          // anyway, because the next request meets the same broken endpoint. The
          // media-rejection statuses this recovers from are 4xx on both wires:
          // Ollama answers an unusable image part with 400 ("this model is
          // missing data required for image input") and the OpenAI dialect with
          // 400 ("invalid image input"), both reproduced live.
          const status = (err as { httpStatus?: number } | null)?.httpStatus;
          const requestWasRejected = typeof status === "number" && status >= 400 && status < 500;
          // Arm ONLY when THIS turn attached media that has not yet come back
          // from a successful request. Two things follow, and both matter:
          //   • media accepted earlier in this turn is never blamed for a later
          //     error (it demonstrably arrived), and
          //   • a turn that attached nothing makes no claim at all about media
          //     inherited from an earlier turn — that media was already
          //     delivered, and "you did not hear it" would be false.
          // A NEW file is always judged on its own: an earlier clip landing is
          // not evidence about a different one (codec, length).
          const unprovenMedia = (turnSentImages || turnSentAudio) && !turnMediaAccepted;
          if (!abort.signal.aborted && requestWasRejected && !attachmentsStripped && unprovenMedia) {
            attachmentsStripped = true;
            logger.warn(
              `[ollama-backend] media input rejected (${msgOf(err).slice(0, 200)}) — retrying without attachments`,
            );
            this.stripImagesFromHistory();
            // #790 — the correction for an attachment we had already told the
            // user was on the request. Two things must stay honest here.
            //
            // The SENSE that was lost: "can't see it" after an audio rejection
            // would be a second wrong statement on top of the first.
            //
            // The CAUSE: the endpoint's error carries no attribution, so when
            // the request carried BOTH kinds we do not know which one it
            // objected to — and must not pick one. The wording below is about
            // what we OBSERVED (the request carrying X was rejected, X is now
            // gone) rather than a diagnosis we cannot make.
            //
            // The wording keys off what THIS turn attached, not off what is
            // left in the retained history: if the user attached nothing now
            // and only an older turn's media was carried along, saying "I
            // couldn't hear your audio" would be about a file they did not
            // just send.
            yield {
              type: "assistant",
              text:
                turnSentAudio && turnSentImages
                  ? `📎🔇 ${this.model} rejected the request carrying the attachments, so I'm continuing without them — I did NOT see the image and did NOT hear the audio, and the endpoint didn't say which one it objected to. Describe the image in words, and switch to a model that reports audio support (\`ollama pull gemma4:e4b\`) if you need me to listen.`
                  : turnSentAudio
                    ? `🔇 ${this.model} rejected the request carrying the audio attachment, so I'm continuing without it — I did NOT hear it and won't describe it. Switch to an audio-capable model (\`ollama pull gemma4:e4b\`), or ask me to run a ComfyUI audio-analysis node over the file instead.`
                    : `📎 ${this.model} rejected image input, so I'm continuing without the attachment — I can't see the image. Describe it in words, or switch to a vision-capable model.`,
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
          // The consolidated form first, then the bare name — so a tool whose
          // whole surface is discovery still counts, while a consolidated tool
          // counts only for the action that actually searches.
          const action = toolCallAction(args);
          const discoveryKey = action !== undefined && DISCOVERY_TOOLS.has(`${name} action:"${action}"`)
            ? `${name} action:"${action}"`
            : DISCOVERY_TOOLS.has(name)
              ? name
              : undefined;
          const discoveryHits = discoveryKey
            ? (discoveryCounts.set(discoveryKey, (discoveryCounts.get(discoveryKey) ?? 0) + 1),
              discoveryCounts.get(discoveryKey)!)
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
                      `SEARCH LIMIT: you have called ${discoveryKey} ${discoveryHits} times without finding a matching tool — it is very likely NOT in this catalog. STOP searching. ` +
                      `Common misses: GRAPH/CANVAS actions (add a node, connect slots, set a widget, run the workflow) are PANEL tools — panel_call_tool {"name":"panel_add_node"} / panel_connect / panel_set_widget / panel_run, listed by panel_list_tools, NOT here. ` +
                      `Civitai keyword search is download_model action:"search_civitai" (filter by types + base_models, then action:"download_civitai"); ` +
                      `model families like krea2 / qwen-image-edit / wan / ltxv are installer PACKS — call_tool {"name":"list_packs"}. ` +
                      `Otherwise, tell the user plainly what IS available and ask how they want to proceed. Do not call ${discoveryKey} again.`,
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
              m.images?.length || m.audios?.length
                ? {
                    ...m,
                    ...(m.images?.length ? { images: m.images.map(() => "[inline image omitted]") } : {}),
                    ...(m.audios?.length ? { audios: m.audios.map(() => "[inline audio omitted]") } : {}),
                  }
                : m,
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
    // Ollama picks the model per request — a live switch is just bookkeeping for
    // the CHAT side. The TOOL SURFACE is not: the comfyui child was spawned with
    // a mode chosen for the previous model (#788), so switching 4B → 70B (or
    // back) would otherwise leave the new model on the old model's surface while
    // the ready line still explained the old decision. Flag it here and let the
    // next turn re-spawn at a point where nothing is in flight.
    if (!acceptsModelId(model, this.api)) return;
    this.model = model;
  }

  /**
   * Re-spawn the comfyui child when the ACTIVE model wants a different tool
   * surface than the one it is running (#788).
   *
   * Called at the top of a turn, which is the only safe point: no request is in
   * flight, so tearing the MCP client down cannot orphan a call. If the re-spawn
   * fails the old decision is left in place — `toolModeDecision` must always
   * describe the surface that actually exists, never the one we wanted.
   */
  /** See reconcileToolModeForModel: an indirect clear, so control-flow analysis
   *  does not pin the field to `null` past the re-spawn that refills it. */
  private clearToolModeDecision(): void {
    this.toolModeDecision = null;
  }

  protected async reconcileToolModeForModel(): Promise<void> {
    // NOTE this reads `this.model` - the model actually in use - not whatever the
    // panel last displayed. `setModel` still refuses the hosted frontier ids
    // PanelAgent passes through unconditionally (see acceptsModelId), and a
    // refused switch leaves `this.model` alone. Reading the live value is what
    // keeps the tool surface consistent with the model that will actually serve
    // the turn, rather than with a selection that never took effect.
    if (!this.deps.mcpServers) return; // the child isn't ours to respawn
    const next = comfyuiSpawnToolMode(this.comfySpecEnv, process.env, this.model);
    const live = this.toolModeDecision;
    // `live && this.comfy` is the test for "a surface actually exists". A
    // previous respawn that failed leaves one or both unset, and that must read
    // as MISSING (retry) rather than as matching.
    if (live && this.comfy && next.mode === live.mode) {
      // Same surface — only the explanation needs to catch up to the new model,
      // and a model change is worth saying out loud: the reason changed even
      // though the mode didn't.
      if (live.model !== next.model) logger.info(`[ollama-backend] ${next.explain}`);
      this.toolModeDecision = next;
      return;
    }
    const previous = live ?? { mode: "(none)" as const };
    logger.info(
      `[ollama-backend] model is now ${this.model}; tool surface ${previous.mode} → ${next.mode} — respawning the comfyui tool server`,
    );
    const staleComfy = this.comfy;
    const stalePanel = this.panel;
    this.comfy = null;
    this.panel = null;
    this.comfyTools = [];
    this.panelTools = [];
    // Clear the decision BEFORE tearing down: from here until connectTools
    // re-sets it, no surface exists, and that is what it must say. Cleared via a
    // method so the compiler does not narrow the field to `null` for the rest of
    // this function -- connectTools() below legitimately re-sets it.
    this.clearToolModeDecision();
    await staleComfy?.close().catch(() => {});
    await stalePanel?.close().catch(() => {});
    try {
      await this.connectTools();
    } catch (err) {
      logger.warn(`[ollama-backend] tool-server respawn failed after model switch: ${msgOf(err)}`);
    }
    // The system prompt is written once, when a session opens — but a LIVE
    // model switch changes the surface underneath an existing conversation.
    // Leaving the old prompt in history is not a cosmetic mismatch: it tells a
    // model now holding the whole catalog that it "has exactly six tools" and
    // must go through call_tool, so the auto-selected surface goes unused.
    // Rewrite it to match what was actually spawned.
    //
    // Rewritten on BOTH outcomes, and always through systemPromptForSurface():
    // the respawn tore the PANEL client down too, so the retraction has to be
    // re-derived from the router that is live NOW. Dropping it here — or
    // skipping the rewrite when the respawn failed — would put the "you have
    // panel_list_tools / panel_describe_tool / panel_call_tool" claim back into
    // a conversation whose router is gone, which is the exact false capability
    // claim ollamaPanelRetraction exists to retract.
    const system = this.history[0];
    if (system?.role === "system") system.content = this.systemPromptForSurface();
    if (this.toolModeDecision) {
      logger.info(`[ollama-backend] ${this.toolModeDecision.explain}`);
    } else {
      // connectTools swallows a connect failure, so an absent decision here is
      // the real signal that the respawn did not land. The next turn retries.
      logger.warn(
        `[ollama-backend] no comfyui tool surface after the switch to ${this.model} — will retry on the next turn`,
      );
    }
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
