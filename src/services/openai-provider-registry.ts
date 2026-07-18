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
// the copy/identity that used to be duplicated.

/** The simple OpenAI-compatible API-key providers, by id. */
export type OpenAiKeyProviderId = "glm" | "kimi" | "moonshot";

export interface OpenAiKeyProvider {
  /** Panel backend id (a member of orchestrator BackendId). */
  id: OpenAiKeyProviderId;
  /** Credential-slot label shown in the panel's API Keys card. */
  slotLabel: string;
  /** Credential-slot help text shown in the panel's API Keys card. */
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
  /** Connect-ack "ready" line, given the resolved agent label. */
  readyMessage: (agentLabel: string) => string;
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
    slotHelp: "GLM provider",
    envKeys: ["GLM_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY", "ZAI_API_KEY"],
    modelEnv: "COMFYUI_MCP_GLM_MODEL",
    defaultModel: process.env.COMFYUI_MCP_GLM_MODEL?.trim() || "glm-4.7",
    ackFallbackLabel: "GLM",
    readyMessage: (agentLabel) =>
      `🟢 comfyui-mcp agent ready — ${agentLabel} on your Z.AI GLM Coding Plan. Ask away.`,
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
    readyMessage: (agentLabel) =>
      `🟢 comfyui-mcp agent ready — ${agentLabel} on your Kimi Code subscription. Ask away.`,
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
    readyMessage: (agentLabel) =>
      `🟢 comfyui-mcp agent ready — ${agentLabel} on your Moonshot platform (Kimi K3) API key. Ask away.`,
    degradedMessage:
      "⚠️ The background agent isn't responding — Moonshot (Kimi K3) couldn't start. Set MOONSHOT_API_KEY from platform.kimi.ai, then Disconnect → Connect to retry.",
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
