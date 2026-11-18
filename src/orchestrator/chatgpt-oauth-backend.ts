// ChatGPT subscription via direct Codex OAuth (~/.codex/auth.json) — hits the
// Codex Responses endpoint the CLI uses, NOT api.openai.com or codex app-server.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";
import { errorText } from "./error-text.js";
import type { AgentEvent, BackendStartOptions, ModelChoice, NeutralTurn } from "./agent-backend.js";
import { CHATGPT_CAPABILITIES, stampTurn } from "./agent-backend.js";
import { resolveOpenAICodexOAuth } from "../services/code-provider-auth.js";
import { asRateLimitError, sanitizeDetail, sendWithRateLimitRetry } from "./rate-limit.js";
import { OllamaBackend, type OllamaBackendDeps } from "./ollama-backend.js";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CHATGPT_SYSTEM_PROMPT = [
  "You are the ComfyUI agent in a sidebar panel. Answer in Markdown.",
  "",
  "You have exactly six tools:",
  "- list_tools / describe_tool / call_tool — headless ComfyUI server.",
  "- panel_list_tools / panel_describe_tool / panel_call_tool — live canvas.",
  "",
  "Describe a tool before its first call. Finish tasks by running tools, not inventing results.",
].join("\n");

// GPT-5.6-only policy (2026-07-20): Luna is the family's cost-conscious
// variant — the successor default to the retired gpt-5.4-mini.
export const CHATGPT_DEFAULT_MODEL =
  process.env.COMFYUI_MCP_CHATGPT_MODEL?.trim() || "gpt-5.6-luna";

const MAX_TOOL_ROUNDS = 32;

type CodexInputItem = Record<string, unknown>;

type TurnMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
  tool_call_id?: string;
  /** Inline image payloads (raw base64) for user messages — rendered as
   *  Responses-API `input_image` data-URL items. Per-model like the Ollama
   *  family: always attempted, stripped once with an honest note if the
   *  endpoint rejects them (see runCodexTurn). */
  images?: string[];
  /** Mime types parallel to `images`. */
  imageMimes?: string[];
};

function msgOf(err: unknown): string {
  return errorText(err);
}

/** Codex model slugs (gpt-*, codex-*) — not Claude panel ids.
 *
 *  Its job is to keep a CLAUDE id the panel pushes (claude-opus-5) from being sent
 *  to ChatGPT, not to decide which ChatGPT generation is current. It used to be
 *  `/^gpt-5/`, which made `setModel` silently ignore every gpt-6 pick: no error,
 *  the model just never changed. `gpt-oss` is excluded because it is an
 *  open-weight model served by Ollama, matching ollama-backend's classifier. */
export function isChatGptModel(id: string): boolean {
  const m = id.trim().toLowerCase();
  return /^gpt-(?!oss)/.test(m) || m.startsWith("codex") || m.includes("codex");
}

function codexModelsCachePath(home = homedir()): string {
  const root = process.env.CODEX_HOME || join(home, ".codex");
  return join(root, "models_cache.json");
}

/** One entry of the Codex CLI's models cache. Current Codex writes the server's
 *  own catalog metadata; older versions wrote bare ids, so every field past `id`
 *  is optional and its absence is meaningful (see `hasCatalogMetadata`). */
export interface CodexModelEntry {
  id: string;
  label?: string;
  /** "list" = offer it; "hide" = usable but not for a picker (internal or reserve models). */
  visibility?: string;
  /** Server ordering: 1 is the model Codex itself puts first. */
  priority?: number;
  /** The server's retirement notice: the model to move to and when the old one stops working. */
  upgrade?: { model: string; retirementAt?: string };
}

export async function loadCodexModels(home = homedir()): Promise<CodexModelEntry[]> {
  const path = codexModelsCachePath(home);
  if (!existsSync(path)) return [];
  try {
    type Raw = {
      id?: string;
      slug?: string;
      name?: string;
      display_name?: string;
      visibility?: string;
      priority?: number;
      upgrade?: { model?: string; retirement_at?: string } | null;
    };
    const raw = JSON.parse(await readFile(path, "utf8")) as { models?: Raw[]; data?: Raw[] };
    const seen = new Set<string>();
    const out: CodexModelEntry[] = [];
    for (const m of [...(raw.models ?? []), ...(raw.data ?? [])]) {
      const id = m.id ?? m.slug ?? m.name;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        ...(m.display_name ? { label: m.display_name } : {}),
        ...(typeof m.visibility === "string" ? { visibility: m.visibility } : {}),
        ...(typeof m.priority === "number" ? { priority: m.priority } : {}),
        ...(m.upgrade?.model
          ? { upgrade: { model: m.upgrade.model, ...(m.upgrade.retirement_at ? { retirementAt: m.upgrade.retirement_at } : {}) } }
          : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** True when the cache carries the server's catalog (current Codex). A bare-id
 *  cache from an older Codex has none of these, and falls back to the 5.6 floor. */
function hasCatalogMetadata(entries: CodexModelEntry[]): boolean {
  return entries.some((e) => e.visibility !== undefined || e.priority !== undefined);
}

/** gpt-<major>[.<minor>] → [major, minor]; null for unversioned ids (gpt-reserve, codex-*). */
function gptVersion(id: string): [number, number] | null {
  const m = /^gpt-(\d+)(?:\.(\d+))?/.exec(id.trim().toLowerCase());
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
}

/** At or above the 2026-07-20 deprecation floor (gpt-5.6). A FLOOR, not a pin:
 *  every newer generation passes. */
function atLeastGpt56(id: string): boolean {
  const v = gptVersion(id);
  return !!v && (v[0] > 5 || (v[0] === 5 && v[1] >= 6));
}

/** What the server offers for a picker, in the server's own order. */
function listedByPriority(entries: CodexModelEntry[]): CodexModelEntry[] {
  return entries
    .filter((e) => e.visibility !== "hide")
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER));
}

/**
 * The ChatGPT model a session starts on when the user named none: the Codex
 * catalog's top-ranked listed model (priority 1).
 *
 * A baked id here goes stale the day a generation ships — gpt-5.6-luna was still
 * the default after the catalog described it as an "Older fast and efficient
 * model". The catalog is per-account and refreshed by the Codex CLI, so its top
 * pick is both current and something this account can use. An explicit
 * COMFYUI_MCP_CHATGPT_MODEL always wins, and a cache without catalog metadata
 * (older Codex) falls back to the baked default, so nothing gets worse offline.
 */
export async function resolveChatGptDefaultModel(home = homedir()): Promise<string> {
  const explicit = process.env.COMFYUI_MCP_CHATGPT_MODEL?.trim();
  if (explicit) return explicit;
  const entries = await loadCodexModels(home);
  if (!hasCatalogMetadata(entries)) return CHATGPT_DEFAULT_MODEL;
  return listedByPriority(entries)[0]?.id ?? CHATGPT_DEFAULT_MODEL;
}

function isRetired(entry: CodexModelEntry | undefined, now = Date.now()): boolean {
  if (!entry?.upgrade) return false;
  const at = entry.upgrade.retirementAt ? Date.parse(entry.upgrade.retirementAt) : NaN;
  // An upgrade notice with no (or an unparseable) date is treated as retired:
  // the server is saying "move", and keeping the user on it is the riskier side.
  return Number.isNaN(at) || now >= at;
}

function toResponsesTools(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return tools.map((t) => {
    const fn = (t.function ?? t) as { name?: string; description?: string; parameters?: unknown };
    return {
      type: "function",
      name: fn.name,
      description: fn.description ?? "",
      parameters: fn.parameters ?? { type: "object", properties: {} },
    };
  });
}

function historyToCodexInput(messages: TurnMessage[]): CodexInputItem[] {
  const items: CodexInputItem[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      items.push({
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: m.content },
          // Responses-API image items take the data URL as a plain string
          // (unlike chat/completions' nested image_url object).
          ...(m.images ?? []).map((b64, i) => ({
            type: "input_image",
            image_url: `data:${m.imageMimes?.[i] ?? "image/png"};base64,${b64}`,
          })),
        ],
      });
      continue;
    }
    if (m.role === "assistant") {
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          items.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.name,
            arguments: tc.arguments || "{}",
          });
        }
      }
      if (m.content.trim()) {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: m.content }],
        });
      }
      continue;
    }
    if (m.role === "tool" && m.tool_call_id) {
      items.push({
        type: "function_call_output",
        call_id: m.tool_call_id,
        output: m.content,
      });
    }
  }
  return items;
}

/** ChatGPT direct OAuth backend — Codex Responses SSE + shared 6-tool router. */
export class ChatGptOAuthBackend extends OllamaBackend {
  readonly id = "chatgpt" as const;
  readonly capabilities = CHATGPT_CAPABILITIES;

  private accessToken = "";
  private accountId = "";
  private turnHistory: TurnMessage[] = [];
  private chatgptSessionId: string | null = null;

  constructor(deps: Omit<OllamaBackendDeps, "api" | "host" | "apiKey" | "backendId"> = {}) {
    super({
      ...deps,
      backendId: "ollama",
      api: "openai",
      host: "https://unused",
      model: deps.model ?? CHATGPT_DEFAULT_MODEL,
    });
    this.model = deps.model ?? CHATGPT_DEFAULT_MODEL;
  }

  override async prepare(): Promise<void> {
    if (this.disposed) throw new Error("chatgpt backend is closed.");
    if (this.prepared) return;
    const creds = await resolveOpenAICodexOAuth();
    this.accessToken = creds.accessToken;
    this.accountId = creds.accountId;
    await this.connectTools();
    this.prepared = true;
    logger.info(
      `[chatgpt-oauth-backend] ready (Codex Responses, model ${this.model}, ${this.comfyTools.length} comfyui meta-tools, ${this.panelTools.length} panel tools behind the router)`,
    );
  }

  private codexAuthHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.accessToken}`,
      "chatgpt-account-id": this.accountId,
    };
  }

  private async *codexResponsesStream(
    instructions: string,
    input: CodexInputItem[],
    tools: Array<Record<string, unknown>>,
    signal: AbortSignal,
    onActivity?: () => void,
  ): AsyncGenerator<
    AgentEvent,
    {
      content: string;
      toolCalls: Array<{ id: string; name: string; arguments: string }>;
      usage?: Record<string, number>;
      streamId: string | null;
    }
  > {
    const keepalive = onActivity ? setInterval(onActivity, 5000) : null;
    let res: Response;
    try {
      // Capture the model BEFORE the async boundary. The thunk below is re-invoked
      // after a rate-limit backoff, and re-reading `this.model` there sends the retried
      // request to whatever the user switched to during the wait — while the notice they
      // already saw names the old one. One turn, two models, no way to tell from the log.
      const model = this.model;
      // 429s are waited out when the window is bounded and named; every other
      // status falls through unchanged (orchestrator/rate-limit.ts).
      res = yield* sendWithRateLimitRetry(
        () =>
          fetch(CODEX_RESPONSES_URL, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "text/event-stream",
              ...this.codexAuthHeaders(),
            },
            body: JSON.stringify({
              model,
              instructions,
              input,
              tools: toResponsesTools(tools),
              stream: true,
              store: false,
            }),
            signal,
          }),
        { model, label: "chatgpt-oauth-backend", signal, onActivity },
      );
    } finally {
      if (keepalive) clearInterval(keepalive);
    }
    if (!res.ok || !res.body) {
      // Never a 429 — sendWithRateLimitRetry owns that status.
      throw new Error(
        // unknown-ok: "" is interpolated into an ERROR MESSAGE and nothing else — the
        // HTTP status is reported either way, so an unreadable body costs detail in the
        // text, never a wrong conclusion. Verified there is no branch on this value.
        // Redacted like grok's sibling path: a provider error body can carry an
        // account id or a credential-shaped token, and this string is rendered
        // into the panel chat verbatim.
        `Codex Responses http ${res.status}: ${sanitizeDetail(await res.text().catch(() => ""), 400)}`,
      );
    }

    let content = "";
    const partial = new Map<string, { id: string; name: string; args: string }>();
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
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let eventType = "";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data || data === "[DONE]") continue;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }

        const type = eventType || String(payload.type ?? "");
        if (type === "response.output_text.delta") {
          const delta = String(payload.delta ?? "");
          if (delta) {
            if (!streamOpen) {
              streamOpen = true;
              yield { type: "stream_start", id: streamId };
            }
            content += delta;
            yield { type: "assistant_delta", text: delta };
          }
        }

        if (type === "response.function_call_arguments.delta") {
          const itemId = String(payload.item_id ?? payload.call_id ?? "call");
          const slot = partial.get(itemId) ?? { id: itemId, name: "", args: "" };
          if (payload.name) slot.name = String(payload.name);
          if (payload.arguments) slot.args += String(payload.arguments);
          partial.set(itemId, slot);
        }

        if (type === "response.output_item.done") {
          const item = (payload.item ?? payload) as Record<string, unknown>;
          if (item.type === "function_call") {
            const id = String(item.call_id ?? item.id ?? randomUUID());
            partial.set(id, {
              id,
              name: String(item.name ?? ""),
              args: String(item.arguments ?? "{}"),
            });
          }
        }

        if (type === "response.completed") {
          const u =
            (payload.response as { usage?: Record<string, number> } | undefined)?.usage ??
            (payload.usage as Record<string, number> | undefined);
          if (u) {
            usage = {
              input_tokens: Number(u.input_tokens ?? 0),
              output_tokens: Number(u.output_tokens ?? 0),
            };
          }
        }
      }
    }

    if (streamOpen) yield { type: "stream_end" };
    const toolCalls = [...partial.values()]
      .filter((t) => t.name)
      .map((t) => ({ id: t.id, name: t.name, arguments: t.args || "{}" }));
    return { content, toolCalls, usage, streamId: streamOpen ? streamId : null };
  }

  override async *run(opts: BackendStartOptions): AsyncIterable<AgentEvent> {
    await this.prepare();
    if (opts.model && isChatGptModel(opts.model)) this.model = opts.model;

    const fresh = !this.chatgptSessionId || (opts.resume && opts.resume !== this.chatgptSessionId);
    this.chatgptSessionId = opts.resume ?? this.chatgptSessionId ?? `chatgpt-${randomUUID()}`;
    if (fresh) this.turnHistory = [];
    yield { type: "session", sessionId: this.chatgptSessionId, model: this.model };

    const instructions = [CHATGPT_SYSTEM_PROMPT, this.deps.systemAppend].filter(Boolean).join("\n\n");

    let turnSeq = 0;
    for await (const turn of opts.channel) {
      yield* stampTurn(this.runCodexTurn(turn, instructions, opts), ++turnSeq);
    }
  }

  private async *runCodexTurn(
    turn: NeutralTurn,
    instructions: string,
    opts: BackendStartOptions,
  ): AsyncIterable<AgentEvent> {
    const abort = new AbortController();
    this.turnAbort = abort;
    const tools = this.buildModelTools();
    // Vision (same contract as the Ollama family): always attempt inline
    // delivery — GPT models take images, and if the endpoint rejects them the
    // strip-and-retry below degrades honestly instead of failing the turn.
    const userMsg: TurnMessage = { role: "user", content: turn.text };
    if (turn.images?.length) {
      const resolved = (await Promise.all(turn.images.slice(0, 4).map((r) => this.fetchImageB64(r)))).filter(
        (r): r is { b64: string; mime: string } => r !== null,
      );
      if (resolved.length) {
        userMsg.images = resolved.map((r) => r.b64);
        userMsg.imageMimes = resolved.map((r) => r.mime);
      }
    }
    this.turnHistory.push(userMsg);

    let resultEmitted = false;
    let imagesStripped = false;
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const stream = this.codexResponsesStream(
          instructions,
          historyToCodexInput(this.turnHistory),
          tools,
          abort.signal,
          opts.onActivity,
        );
        let content = "";
        let toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
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
          // A RateLimitError is NOT an image rejection. Without this clause a 429 on any
          // history carrying an image lands here, strips the images, tells the user this
          // endpoint rejected image input, and then answers WITHOUT the image — a false
          // explanation and a silently degraded answer, both from a rate limit the retry
          // above already knows how to wait out. Let it through to the 429 handling.
          if (
            !abort.signal.aborted &&
            !asRateLimitError(err) &&
            !imagesStripped &&
            this.turnHistory.some((m) => m.images?.length)
          ) {
            imagesStripped = true;
            logger.warn(
              `[chatgpt-oauth-backend] image input rejected (${msgOf(err).slice(0, 200)}) — retrying without images`,
            );
            for (const m of this.turnHistory) {
              if (m.images?.length) {
                delete m.images;
                delete m.imageMimes;
                m.content +=
                  "\n[note: the attached image(s) were removed — this model/endpoint rejected image input. You did NOT see them; tell the user so if it matters.]";
              }
            }
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
          this.turnHistory.push({ role: "assistant", content });
          yield { type: "assistant", text: content, id: streamId ?? undefined, usage };
          yield { type: "result", ok: true, usage };
          resultEmitted = true;
          return;
        }

        this.turnHistory.push({ role: "assistant", content, tool_calls: toolCalls });
        for (const tc of toolCalls) {
          if (abort.signal.aborted) throw new Error("interrupted");
          yield { type: "tool_call", name: tc.name, phase: "start", detail: tc.arguments };
          const { text, isError } = await this.dispatch(tc.name, tc.arguments);
          opts.onActivity?.();
          yield { type: "tool_call", name: tc.name, phase: "end", detail: { isError } };
          this.turnHistory.push({
            role: "tool",
            tool_call_id: tc.id,
            content: text.slice(0, 16000),
          });
        }
      }
      yield {
        type: "assistant",
        text: "(stopped: too many tool rounds in one turn — ask me to continue)",
      };
      yield { type: "result", ok: false, subtype: "max_tool_rounds" };
      resultEmitted = true;
    } catch (err) {
      const interrupted = abort.signal.aborted;
      const rateLimited = asRateLimitError(err);
      if (!interrupted) {
        logger.warn(`[chatgpt-oauth-backend] turn failed: ${msgOf(err)}`);
        if (rateLimited) {
          // Already a finished sentence naming the model, the reason and the
          // remedy — it travels alone rather than under a "chatgpt backend:" prefix
          // that would blame this adapter for the provider's limit.
          yield { type: "error", message: rateLimited.message, rateLimit: true };
        } else {
          yield { type: "error", message: `chatgpt backend: ${msgOf(err)}` };
          yield {
            type: "assistant",
            text: `⚠️ The model request failed: ${msgOf(err).slice(0, 400)}`,
          };
        }
      }
      if (!resultEmitted) {
        yield {
          type: "result",
          ok: false,
          subtype: interrupted ? "interrupted" : rateLimited ? "rate_limit" : "error",
        };
      }
    } finally {
      if (this.turnAbort === abort) this.turnAbort = null;
    }
  }

  override async setModel(model: string): Promise<void> {
    if (isChatGptModel(model)) this.model = model;
  }

  override async listModels(): Promise<ModelChoice[]> {
    const entries = await loadCodexModels();
    return hasCatalogMetadata(entries) ? this.listFromCatalog(entries) : this.listFromBareIds(entries);
  }

  /**
   * Current Codex: follow the server's own catalog.
   *
   * This replaces a hardcoded "GPT-5.6-only" policy that was meant to hide OLDER
   * models but was written as "show only gpt-5.6*", so it hid NEWER ones too:
   * gpt-6-astra and gpt-6.1-sol sat in a fresh cache and never reached the picker,
   * and a gen-6 pick was force-migrated back to 5.6 as "deprecated". The catalog
   * already says everything that policy guessed at — what to list (`visibility`),
   * in what order (`priority`), and what is being retired and its replacement
   * (`upgrade`) — so a new generation needs no code change here.
   */
  private listFromCatalog(entries: CodexModelEntry[]): ModelChoice[] {
    const byId = new Map(entries.map((e) => [e.id, e]));
    const listed = listedByPriority(entries);
    const active = byId.get(this.model);
    // Migrate the ACTIVE model only on a real signal. Re-inserting a dead model at
    // the head kept it selected and 400ing every turn (codex review), so:
    //   • retired per the server's own notice -> its named replacement;
    //   • absent from the catalog entirely    -> the catalog's top-ranked model.
    // A HIDDEN model is not dead (the user or env chose it deliberately), and a
    // model with an upgrade notice still works until its retirement date.
    let target: string | undefined;
    if (isRetired(active)) target = active?.upgrade?.model;
    else if (!active && listed.length) target = listed[0].id;
    if (target && target !== this.model) {
      logger.info(`[chatgpt-oauth-backend] active model ${this.model} is retired or unavailable — migrating to ${target}`);
      this.model = target;
    }
    const head = byId.get(this.model);
    const rest = listed.filter((e) => e.id !== this.model).slice(0, 40);
    return [{ id: this.model, label: head?.label ?? this.model }, ...rest.map((e) => ({ id: e.id, label: e.label ?? e.id }))];
  }

  /** Older Codex wrote bare ids with no catalog metadata. Keep the 2026-07-20
   *  deprecation, but as a floor: hide what is OLDER than gpt-5.6 when anything
   *  at or above it exists, and let every newer generation through. A cache with
   *  nothing at or above the floor keeps its full list, so older plans never brick. */
  private listFromBareIds(entries: CodexModelEntry[]): ModelChoice[] {
    const cached = entries.map((e) => e.id);
    const fam = cached.filter(atLeastGpt56);
    const ids = fam.length
      ? fam
      : cached.length
        ? cached
        : ["gpt-5.6-sol", "gpt-5.6-terra", CHATGPT_DEFAULT_MODEL];
    if (fam.length && this.model && !atLeastGpt56(this.model)) {
      logger.info(
        `[chatgpt-oauth-backend] active model ${this.model} is deprecated — migrating to ${CHATGPT_DEFAULT_MODEL}`,
      );
      this.model = ids.includes(CHATGPT_DEFAULT_MODEL) ? CHATGPT_DEFAULT_MODEL : ids[0];
    }
    const rest = ids.filter((id) => id !== this.model).slice(0, 40);
    return [this.model, ...rest].map((id) => ({ id, label: id }));
  }
}