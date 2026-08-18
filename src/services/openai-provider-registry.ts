// Single source of truth for the SIMPLE OpenAI-compatible API-key provider family.
//
// Before this registry, adding one such provider (e.g. the recent `moonshot`)
// meant editing ~10 scattered sites — a BackendId union, a `*_CAPABILITIES`
// const, a near-identical `class extends OllamaBackend`, a `resolve*Credentials`
// fn, a model var + makeBackend branch + probe branch + KNOWN_BACKENDS set + boot
// log + currentModelFor branch + connect-ack block in orchestrator/index.ts, a
// SECOND KNOWN_BACKENDS list, a backend-readiness branch, and a CREDENTIAL_SLOTS
// entry + AGENT_SECRET_ENV_ALLOWLIST addition — all copy-pasting the same
// identity. This table now DESCRIBES each provider once; the scattered lists
// DERIVE from it.
//
// SCOPE — this covers ONLY the simple api-key family that shares one shape:
// resolve an env key (throw if absent) → OllamaBackend openai dialect. The
// CLI/OAuth/SDK/local providers (claude, codex, chatgpt, gemini, grok, ollama,
// lmstudio, llamacpp, copilot) do NOT fit one table and keep their bespoke
// wiring. `openrouter`/`custom` are OpenAI-compatible too but degrade gracefully
// with no key (rather than throwing) and carry a different readiness shape +
// up-front connect-ack guards, so they also stay bespoke.
//
// LAYERING — this is a pure-DATA leaf module: it imports NOTHING from the
// services/orchestrator layers, so both `services/panel-secrets` (slots +
// allowlist) and `orchestrator/{backend-readiness,index}` can import it without
// creating a cycle. Credential resolution lives in `services/code-provider-auth`
// (which reads these env keys itself); backend construction lives in
// `orchestrator/index.ts` (which owns OllamaBackend). This module carries only
// the copy/identity that used to be duplicated. (`i18n` is itself a leaf — node
// builtins only — so translating the ready lines below keeps that property.)

import { processLocale, trFor } from "../i18n/index.js";

/** The simple OpenAI-compatible API-key providers, by id. */
export type OpenAiKeyProviderId = "glm" | "kimi" | "moonshot" | "minimax" | "atlascloud";

export interface OpenAiKeyProvider {
  /** Panel backend id (a member of orchestrator BackendId). */
  id: OpenAiKeyProviderId;
  /**
   * Credential-slot label shown in the panel's API Keys card. Deliberately NOT
   * translated: every one of these is a product name ("GLM / Zhipu", "MiniMax"),
   * and a user hunting for the slot that matches the key they just copied off a
   * vendor's dashboard needs the vendor's own spelling.
   */
  slotLabel: string;
  /**
   * Credential-slot help text shown in the panel's API Keys card. Still English:
   * it is baked into the module-level `CREDENTIAL_SLOTS` const in panel-secrets,
   * evaluated once at import, so it has no reader to follow — translating the slot
   * help means making that list a per-request accessor, which is a separate change
   * from these banners.
   */
  slotHelp: string;
  /**
   * The env var(s) that carry this provider's API key. `envKeys[0]` is the
   * PRIMARY — used for masked-state display, the keyed-providers boot log, and
   * as the readiness signal's first candidate. The panel's credential slot fans
   * a saved value out to EVERY key (alias support). NOTE: this ordering is the
   * slot/display ordering, which is independent of the resolve* PRECEDENCE order
   * in code-provider-auth.ts (glm reads ZAI_API_KEY first there) — readiness and
   * the allowlist are order-agnostic (`some`/`Set`), so both are satisfied.
   */
  envKeys: string[];
  /** Env var that overrides the default model. */
  modelEnv: string;
  /** Default model tag when `modelEnv` is unset. Read at module load (mirrors the
   *  old GLM_DEFAULT_MODEL/MOONSHOT_DEFAULT_MODEL/KIMI_DEFAULT_MODEL consts). */
  defaultModel: string;
  /** Label the connect-ack falls back to when the model probe returns no ids. */
  ackFallbackLabel: string;
  /**
   * Connect-ack "ready" line, given the resolved agent label.
   *
   * `locale` is the language of the panel tab the line is destined for — this is a
   * `say` frame a PERSON reads, so it follows that reader, not this process. Omitting
   * it (or passing "", which is how an unset panel language arrives) falls back to the
   * process locale; `readyBannerText` always passes one through.
   */
  readyMessage: (agentLabel: string, locale?: string) => string;
  /** Connect-ack "degraded" line (model probe empty / construction failed). */
  degradedMessage: string;
  /**
   * True for the SIMPLE api-key shape: readiness = "ready iff one of `envKeys`
   * is set", and the provider is constructed by the generic OpenAI-key backend
   * factory (throw-if-absent credential resolve → OllamaBackend openai). False
   * for `kimi`, whose OAuth dual-auth path (KIMI_API_KEY *or* a Kimi Code login
   * file) keeps its bespoke KimiBackend + resolveKimiCodeOAuth + readiness
   * branch. Registry membership still unifies kimi's list/slot/allowlist/model/
   * connect-ack metadata — only its auth code path stays hand-written.
   */
  simpleKeyAuth: boolean;
}

/** Ordered registry. Order is preserved wherever the derived lists are order-
 *  sensitive (credential slots, keyed-providers boot log, KNOWN_BACKENDS). */
export const OPENAI_KEY_PROVIDERS: OpenAiKeyProvider[] = [
  {
    id: "glm",
    slotLabel: "GLM / Zhipu",
    slotHelp: "Z.AI Coding Plan (GLM / Zhipu)",
    envKeys: ["GLM_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY", "ZAI_API_KEY"],
    modelEnv: "COMFYUI_MCP_GLM_MODEL",
    defaultModel: process.env.COMFYUI_MCP_GLM_MODEL?.trim() || "glm-5.2",
    ackFallbackLabel: "GLM",
    readyMessage: (agentLabel, locale) =>
      trFor(
        locale || processLocale(),
        "banner.ready.glm",
        "🟢 comfyui-mcp agent ready — {label} on your Z.AI GLM Coding Plan. Ask away.",
        { label: agentLabel },
      ),
    degradedMessage:
      "⚠️ The background agent isn't responding — GLM Code API couldn't start. Set ZAI_API_KEY (Z.AI Coding Plan), then Disconnect → Connect to retry.",
    simpleKeyAuth: true,
  },
  {
    id: "kimi",
    slotLabel: "Kimi (API)",
    slotHelp: "Kimi via API key (vs its OAuth)",
    envKeys: ["KIMI_API_KEY"],
    modelEnv: "COMFYUI_MCP_KIMI_MODEL",
    defaultModel: process.env.COMFYUI_MCP_KIMI_MODEL?.trim() || "kimi-for-coding",
    ackFallbackLabel: "Kimi",
    readyMessage: (agentLabel, locale) =>
      trFor(
        locale || processLocale(),
        "banner.ready.kimi",
        "🟢 comfyui-mcp agent ready — {label} on your Kimi Code subscription. Ask away.",
        { label: agentLabel },
      ),
    degradedMessage:
      "⚠️ The background agent isn't responding — Kimi Code couldn't start. Run Kimi Code login (~/.kimi/credentials/kimi-code.json) or set KIMI_API_KEY, then Disconnect → Connect to retry.",
    // OAuth dual-auth — KimiBackend + resolveKimiCodeOAuth + bespoke readiness stay.
    simpleKeyAuth: false,
  },
  {
    id: "moonshot",
    slotLabel: "Kimi K3 (Moonshot)",
    slotHelp: "Kimi K3 via the Moonshot platform API key",
    envKeys: ["MOONSHOT_API_KEY"],
    modelEnv: "COMFYUI_MCP_MOONSHOT_MODEL",
    defaultModel: process.env.COMFYUI_MCP_MOONSHOT_MODEL?.trim() || "kimi-k3",
    ackFallbackLabel: "Kimi K3",
    readyMessage: (agentLabel, locale) =>
      trFor(
        locale || processLocale(),
        "banner.ready.moonshot",
        "🟢 comfyui-mcp agent ready — {label} on your Moonshot platform (Kimi K3) API key. Ask away.",
        { label: agentLabel },
      ),
    degradedMessage:
      "⚠️ The background agent isn't responding — Moonshot (Kimi K3) couldn't start. Set MOONSHOT_API_KEY from platform.kimi.ai, then Disconnect → Connect to retry.",
    simpleKeyAuth: true,
  },
  {
    id: "minimax",
    slotLabel: "MiniMax",
    slotHelp: "MiniMax M3 via the MiniMax platform API key",
    envKeys: ["MINIMAX_API_KEY"],
    modelEnv: "COMFYUI_MCP_MINIMAX_MODEL",
    defaultModel: process.env.COMFYUI_MCP_MINIMAX_MODEL?.trim() || "MiniMax-M3",
    ackFallbackLabel: "MiniMax",
    readyMessage: (agentLabel, locale) =>
      trFor(
        locale || processLocale(),
        "banner.ready.minimax",
        "🟢 comfyui-mcp agent ready — {label} on your MiniMax platform API key. Ask away.",
        { label: agentLabel },
      ),
    degradedMessage:
      "⚠️ The background agent isn't responding — MiniMax couldn't start. Set MINIMAX_API_KEY from platform.minimax.io, then Disconnect → Connect to retry.",
    simpleKeyAuth: true,
  },
  {
    id: "atlascloud",
    slotLabel: "Atlas Cloud",
    slotHelp: "Atlas Cloud OpenAI-compatible LLM API",
    envKeys: ["ATLASCLOUD_API_KEY"],
    modelEnv: "COMFYUI_MCP_ATLASCLOUD_MODEL",
    defaultModel: process.env.COMFYUI_MCP_ATLASCLOUD_MODEL?.trim() || "qwen/qwen3.5-flash",
    ackFallbackLabel: "Atlas Cloud",
    readyMessage: (agentLabel, locale) =>
      trFor(
        locale || processLocale(),
        "banner.ready.atlascloud",
        "🟢 comfyui-mcp agent ready — {label} via Atlas Cloud. Ask away.",
        { label: agentLabel },
      ),
    degradedMessage:
      "⚠️ The background agent isn't responding — Atlas Cloud couldn't start. Set ATLASCLOUD_API_KEY, then Disconnect → Connect to retry.",
    simpleKeyAuth: true,
  },
];

/** Registry ids in order — spliced into the KNOWN_BACKENDS lists. */
export const OPENAI_KEY_PROVIDER_IDS: OpenAiKeyProviderId[] = OPENAI_KEY_PROVIDERS.map((p) => p.id);

const BY_ID = new Map<string, OpenAiKeyProvider>(OPENAI_KEY_PROVIDERS.map((p) => [p.id, p]));

/** The registry entry for `id`, or undefined for a non-registry backend. */
export function openAiKeyProvider(id: string): OpenAiKeyProvider | undefined {
  return BY_ID.get(id);
}

/** The registry entry for `id` only when it uses the SIMPLE api-key shape
 *  (readiness = env-key-set; generic backend factory). Excludes `kimi`. */
export function simpleKeyProvider(id: string): OpenAiKeyProvider | undefined {
  const p = BY_ID.get(id);
  return p && p.simpleKeyAuth ? p : undefined;
}

/** The current model for a registry provider: env override, else default. Mirrors
 *  the old `<provider>Model = process.env.<MODEL_ENV> ?? <DEFAULT_MODEL>`. */
export function openAiKeyProviderModel(p: OpenAiKeyProvider): string {
  return process.env[p.modelEnv] ?? p.defaultModel;
}

/**
 * One-line "which model am I on, and how do I change it?" hint for the panel's
 * API Keys card.
 *
 * These providers ship a pinned default (glm-5.2, kimi-for-coding, kimi-k3) and
 * a `modelEnv` override, but NOTHING in the UI ever said the override existed —
 * so a user on a newer model (e.g. GLM 5.2) had no way to discover they could
 * point at it without reading the source. Generated from the registry rather
 * than hand-written per provider, so it can never drift from the real default.
 *
 * Reports the ACTIVE model (env override if set, else the default) and names the
 * env var either way, so the card also answers "why am I not on the model I set?".
 */
export function providerModelHint(p: OpenAiKeyProvider): string {
  const active = openAiKeyProviderModel(p);
  return active === p.defaultModel
    ? `Model ${active} (default) — set ${p.modelEnv} to use another.`
    : `Model ${active} (via ${p.modelEnv}; default ${p.defaultModel}).`;
}
