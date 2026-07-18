// Persisted TOOL secrets for the orchestrator's BUILT-IN comfyui MCP server.
//
// The orchestrator spawns the comfyui MCP server (this build, in normal/stdio
// mode) as a subprocess with a FIXED env it controls (COMFYUI_URL, progress dir,
// COMFYUI_PATH…). Tool secrets the user supplies at runtime through the panel —
// e.g. a CivitAI API token for download_civitai_model, a HuggingFace token for
// download_model — must reach THAT subprocess's env. They can't go into the
// user's ~/.claude.json mcpServers map (user-mcp-config.ts), because that map is
// for the user's OWN, inherited MCP servers; the built-in comfyui server doesn't
// read it. So we persist them here, the orchestrator merges them into the comfyui
// server's spawn env (buildComfyuiMcpEnv), and respawns the server so a live one
// picks up the new value WITHOUT the user fighting reloads.
//
// SECURITY: the file holds raw secrets, so it is written 0600 (owner-only). The
// raw value NEVER enters a log or the agent's chat context — callers pass it
// straight from the panel's secure input, and only the env-var KEYS are ever
// logged (see comfyuiSecretKeys()).

import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "../utils/logger.js";
import { OPENAI_KEY_PROVIDERS } from "./openai-provider-registry.js";

interface PanelSecrets {
  /** Env vars injected into the built-in comfyui MCP server's spawn env. */
  comfyuiEnv?: Record<string, string>;
  /** Env vars the ORCHESTRATOR reads in-process (not the comfyui child) — e.g.
   *  the OpenRouter API key for the OpenRouter provider backend. Kept SEPARATE
   *  from comfyuiEnv (different allowlist) so a provider key is never injected
   *  into the tool subprocess and a tool token never reaches the LLM backend. */
  agentEnv?: Record<string, string>;
  /** STATUS-ONLY mirror of in-panel OAuth sign-ins (Codex/Grok/Copilot), keyed by
   *  provider id. Holds NO secrets — the native token files (~/.codex/auth.json,
   *  ~/.grok/auth.json, ~/.comfyui-mcp/copilot-auth.json) are the source of truth
   *  for token material. This is deliberately NOT under either allowlist above:
   *  it is read by the panel UI to show "signed in as …" without ever touching a
   *  credential. `setOAuthStatus` sanitizes on write so a hand-edited/corrupt file
   *  can never smuggle anything beyond the five known status fields. */
  oauthStatus?: Record<string, OAuthStatusRecord>;
}

/** Status-only record for an in-panel OAuth sign-in. NEVER put token material here. */
export interface OAuthStatusRecord {
  provider: string;
  account_label: string;
  obtained_at: number;
  expires_at?: number;
  experimental?: boolean;
}

// STRICT ALLOWLIST of env keys a panel-collected secret may set on the comfyui
// MCP child process. The child is a Node subprocess (process.execPath), so an
// arbitrary key (NODE_OPTIONS, PATH, COMFYUI_PATH, LD_PRELOAD, …) could hijack or
// clobber it. We therefore permit ONLY known credential vars the comfyui tools
// read — both on SAVE (reject otherwise) and on LOAD (filter), so even a hand-
// edited or corrupt panel-secrets.json can never inject anything else.
//   CIVITAI_API_TOKEN  → download_civitai_model (config.civitaiApiToken)
//   HUGGINGFACE_TOKEN  → HuggingFace downloads   (config.huggingfaceToken)
//   HF_TOKEN           → HuggingFace alias some tooling/hub libs honor
export const COMFYUI_SECRET_ENV_ALLOWLIST = [
  "CIVITAI_API_TOKEN",
  "HUGGINGFACE_TOKEN",
  "HF_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "RUNCOMFY_API_KEY",
  "REGISTRY_ACCESS_TOKEN",
] as const;

const ALLOWLIST_SET = new Set<string>(COMFYUI_SECRET_ENV_ALLOWLIST);

/** Is `key` a permitted comfyui tool-secret env var? */
export function isAllowedComfyuiSecretKey(key: string): boolean {
  return ALLOWLIST_SET.has(key);
}

// STRICT ALLOWLIST of env keys the ORCHESTRATOR itself may read from the store.
// These configure the agent provider backends in-process (never a subprocess),
// so the injection surface is different from the comfyui child's — but we keep
// the same allowlist discipline so a corrupt file can't set arbitrary env.
//   OPENROUTER_API_KEY → the OpenRouter provider backend (OllamaBackend openai)
//   COMFYUI_MCP_CUSTOM_API_KEY → the user-defined Custom endpoint provider
// The registry providers' keys (GLM_API_KEY/ZHIPU*/ZAI_API_KEY, KIMI_API_KEY,
// MOONSHOT_API_KEY) are DERIVED from openai-provider-registry so a new api-key
// provider is allowlisted by adding one registry entry, not editing this array.
export const AGENT_SECRET_ENV_ALLOWLIST: readonly string[] = [
  "OPENROUTER_API_KEY",
  "COMFYUI_MCP_CUSTOM_API_KEY",
  ...OPENAI_KEY_PROVIDERS.flatMap((p) => p.envKeys),
];
const AGENT_ALLOWLIST_SET = new Set<string>(AGENT_SECRET_ENV_ALLOWLIST);

/** Is `key` a permitted orchestrator agent-secret env var? */
export function isAllowedAgentSecretKey(key: string): boolean {
  return AGENT_ALLOWLIST_SET.has(key);
}

/** Secrets file path. Overridable for tests. */
export function panelSecretsPath(): string {
  return (
    process.env.COMFYUI_MCP_PANEL_SECRETS ||
    join(homedir(), ".comfyui-mcp", "panel-secrets.json")
  );
}

// In-process change channel: the tool handler that saves a secret runs in the
// SAME process as the orchestrator (both the in-process Claude panel server and
// the Codex loopback HTTP MCP are hosted by the orchestrator), so a module-level
// emitter is enough to tell the orchestrator to re-inject + respawn.
const emitter = new EventEmitter();

/** Subscribe to "a comfyui tool secret changed". Returns an unsubscribe fn. */
export function onComfyuiSecretsChanged(cb: () => void): () => void {
  emitter.on("change", cb);
  return () => {
    emitter.off("change", cb);
  };
}

function read(): PanelSecrets {
  const p = panelSecretsPath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as PanelSecrets) : {};
  } catch (err) {
    // Never echo file contents (they're secret) — just the parse failure.
    logger.warn(`[panel-secrets] could not parse ${p}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

function write(secrets: PanelSecrets): void {
  const p = panelSecretsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  // mkdirSync may have created the file before the mode took effect on some
  // platforms; re-assert owner-only. Best-effort (no-op / unsupported on Windows).
  try {
    chmodSync(p, 0o600);
  } catch {
    /* chmod is a no-op on Windows; ignore */
  }
}

// SANITIZE on every write: copy only the five known status fields and coerce
// their types. Even a hand-edited or corrupt panel-secrets.json therefore can
// never inject anything beyond this shape into the mirror — critically, it
// can never smuggle in token material via an unexpected key.
function sanitizeOAuthStatus(rec: OAuthStatusRecord): OAuthStatusRecord {
  const out: OAuthStatusRecord = {
    provider: String(rec?.provider ?? "").trim(),
    account_label: String(rec?.account_label ?? "").trim(),
    obtained_at:
      typeof rec?.obtained_at === "number" && Number.isFinite(rec.obtained_at)
        ? rec.obtained_at
        : Date.now(),
  };
  if (typeof rec?.expires_at === "number" && Number.isFinite(rec.expires_at)) {
    out.expires_at = rec.expires_at;
  }
  if (typeof rec?.experimental === "boolean") {
    out.experimental = rec.experimental;
  }
  return out;
}

/** Upsert the status-only OAuth mirror entry for `rec.provider`. Sanitizes the
 *  record first (see `sanitizeOAuthStatus`) — callers pass status fields only,
 *  never token material. */
export function setOAuthStatus(rec: OAuthStatusRecord): void {
  const sanitized = sanitizeOAuthStatus(rec);
  if (!sanitized.provider) throw new Error("setOAuthStatus: record is missing a provider id.");
  const secrets = read();
  const status =
    secrets.oauthStatus && typeof secrets.oauthStatus === "object" ? secrets.oauthStatus : {};
  status[sanitized.provider] = sanitized;
  secrets.oauthStatus = status;
  write(secrets);
}

/** All stored OAuth status records (re-sanitized on read, defense in depth). */
export function listOAuthStatus(): OAuthStatusRecord[] {
  const status = read().oauthStatus;
  if (!status || typeof status !== "object") return [];
  return Object.values(status).map(sanitizeOAuthStatus);
}

/** Remove a provider's status mirror entry. No-op if absent. */
export function clearOAuthStatus(provider: string): void {
  const secrets = read();
  const status = secrets.oauthStatus;
  if (!status || typeof status !== "object" || !(provider in status)) return;
  delete status[provider];
  secrets.oauthStatus = status;
  write(secrets);
}

/** The persisted env vars to inject into the comfyui MCP server. Never logged.
 *  FILTERED through the allowlist (defense in depth): even a hand-edited/corrupt
 *  panel-secrets.json can only ever contribute allowlisted credential keys. */
export function loadComfyuiSecretEnv(): Record<string, string> {
  const env = read().comfyuiEnv;
  if (!env || typeof env !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (isAllowedComfyuiSecretKey(k) && typeof v === "string") out[k] = v;
  }
  return out;
}

/** The env-var KEYS currently stored (e.g. for a redacted log line). No values. */
export function comfyuiSecretKeys(): string[] {
  return Object.keys(loadComfyuiSecretEnv());
}

/**
 * Persist a secret as an env var for the built-in comfyui MCP server, then emit
 * a change so the orchestrator re-injects it and respawns the server. `value` is
 * the raw secret (the caller already applied any prefix); it is never logged.
 */
export function setComfyuiSecret(key: string, value: string): void {
  const trimmed = key.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error(`Invalid env var name "${key}" — use a valid shell identifier (letters, digits, underscore).`);
  }
  if (!isAllowedComfyuiSecretKey(trimmed)) {
    // SECURITY: never let an arbitrary key reach the comfyui Node child's env.
    throw new Error(
      `Env var "${trimmed}" is not an accepted comfyui tool secret. Allowed: ${COMFYUI_SECRET_ENV_ALLOWLIST.join(", ")}.`,
    );
  }
  const secrets = read();
  const env = secrets.comfyuiEnv && typeof secrets.comfyuiEnv === "object" ? secrets.comfyuiEnv : {};
  env[trimmed] = value;
  secrets.comfyuiEnv = env;
  write(secrets);
  emitter.emit("change");
}

/** Remove a stored comfyui secret. Returns false if absent. Emits on removal. */
export function removeComfyuiSecret(key: string): boolean {
  const secrets = read();
  const env = secrets.comfyuiEnv;
  if (!env || !(key in env)) return false;
  delete env[key];
  secrets.comfyuiEnv = env;
  write(secrets);
  emitter.emit("change");
  return true;
}

/** The persisted agent-provider secrets (e.g. OPENROUTER_API_KEY), filtered
 *  through the agent allowlist. Never logged. */
export function loadAgentSecretEnv(): Record<string, string> {
  const env = read().agentEnv;
  if (!env || typeof env !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (isAllowedAgentSecretKey(k) && typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Copy stored agent secrets into process.env so every in-process reader
 * (openrouterDeps, backendReadiness, the ollama key fallback) sees one source
 * of truth. An EXPLICIT env value WINS — the shell/.env stays the escape hatch;
 * the store only fills what env didn't provide. Called at orchestrator startup
 * and whenever an agent secret changes. Returns the keys it hydrated.
 */
export function hydrateAgentSecretsIntoEnv(): string[] {
  const hydrated: string[] = [];
  for (const [k, v] of Object.entries(loadAgentSecretEnv())) {
    if (!process.env[k]) {
      process.env[k] = v;
      hydrated.push(k);
    }
  }
  return hydrated;
}

/** Subscribe to "an agent provider secret changed". Returns an unsubscribe fn. */
export function onAgentSecretsChanged(cb: () => void): () => void {
  emitter.on("agentChange", cb);
  return () => {
    emitter.off("agentChange", cb);
  };
}

/**
 * Persist an agent-provider secret (e.g. OPENROUTER_API_KEY) to the 0600 store
 * and hydrate it into process.env immediately, then emit so the orchestrator
 * re-probes readiness / re-pushes the model list. Rejects non-allowlisted keys.
 */
export function setAgentSecret(key: string, value: string): void {
  const trimmed = key.trim();
  if (!isAllowedAgentSecretKey(trimmed)) {
    throw new Error(
      `Env var "${trimmed}" is not an accepted agent secret. Allowed: ${AGENT_SECRET_ENV_ALLOWLIST.join(", ")}.`,
    );
  }
  const secrets = read();
  const env = secrets.agentEnv && typeof secrets.agentEnv === "object" ? secrets.agentEnv : {};
  env[trimmed] = value;
  secrets.agentEnv = env;
  write(secrets);
  process.env[trimmed] = value; // a freshly-set key must take effect now (env wins)
  emitter.emit("agentChange");
}

/** Remove a stored agent secret. Returns false if absent. Also drops it from
 *  process.env (setAgentSecret put it there — a revoked key must stop applying
 *  NOW, not on the next restart). Emits on removal. */
export function removeAgentSecret(key: string): boolean {
  const secrets = read();
  const env = secrets.agentEnv;
  if (!env || !(key in env)) return false;
  delete env[key];
  secrets.agentEnv = env;
  write(secrets);
  delete process.env[key];
  emitter.emit("agentChange");
  return true;
}

/**
 * Build the comfyui MCP server's spawn env: the orchestrator's `base` env
 * (COMFYUI_URL, progress dir, COMFYUI_PATH…) MERGED with the persisted tool
 * secrets. Secrets win over base on a key clash (a user-supplied token overrides
 * any inherited default). This is THE single env-builder both provider paths
 * (Claude in-process + Codex stdio) use, so a saved secret reaches either.
 */
export function buildComfyuiMcpEnv(base: Record<string, string>): Record<string, string> {
  return { ...base, ...loadComfyuiSecretEnv() };
}

export interface CredentialSlot {
  id: string;
  label: string;
  envKeys: string[];
  store: "comfyui" | "agent";
  help?: string;
}

/** UI credential slots. Each slot writes ALL its envKeys (alias fan-out) into its
 *  store. `store` decides which allowlist/setter applies. */
export const CREDENTIAL_SLOTS: CredentialSlot[] = [
  { id: "openrouter", label: "OpenRouter", envKeys: ["OPENROUTER_API_KEY"], store: "agent", help: "Hosted models (MiMo, MiniMax, GPT, Claude…)" },
  // The simple api-key providers (glm/kimi/moonshot) are DERIVED from the
  // openai-provider-registry — one entry there feeds its slot here automatically.
  ...OPENAI_KEY_PROVIDERS.map(
    (p): CredentialSlot => ({
      id: p.id,
      label: p.slotLabel,
      envKeys: p.envKeys,
      store: "agent",
      help: p.slotHelp,
    }),
  ),
  { id: "civitai", label: "Civitai", envKeys: ["CIVITAI_API_TOKEN"], store: "comfyui", help: "Model downloads" },
  { id: "huggingface", label: "HuggingFace", envKeys: ["HF_TOKEN", "HUGGINGFACE_TOKEN"], store: "comfyui", help: "Model downloads" },
  { id: "google", label: "Google / Gemini", envKeys: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"], store: "comfyui", help: "Nano Banana concept images" },
  { id: "runcomfy", label: "RunComfy", envKeys: ["RUNCOMFY_API_KEY"], store: "comfyui", help: "Cloud pods / training" },
  { id: "registry", label: "Comfy Registry", envKeys: ["REGISTRY_ACCESS_TOKEN"], store: "comfyui", help: "Publishing custom nodes" },
];

const SLOT_BY_ID = new Map(CREDENTIAL_SLOTS.map((s) => [s.id, s]));

/** Mask a secret for display: first 4 + ellipsis + last 3. Short values fully masked. */
export function maskSecret(v: string): string {
  if (v.length <= 8) return "•".repeat(v.length);
  return `${v.slice(0, 4)}…${v.slice(-3)}`;
}

/** Set every env key of a slot (alias fan-out) into its store. Throws on unknown slot. */
export function setPanelSecret(slotId: string, value: string): void {
  const slot = SLOT_BY_ID.get(slotId);
  if (!slot) throw new Error(`unknown credential slot "${slotId}"`);
  const set = slot.store === "agent" ? setAgentSecret : setComfyuiSecret;
  for (const key of slot.envKeys) set(key, value);
}

/** Clear a slot: remove EVERY env key (alias fan-out, mirroring setPanelSecret)
 *  from its store. Returns true if anything was removed. Throws on unknown slot.
 *  This is the revoke path (issue #203) — without it a saved key could only be
 *  overwritten, never removed, short of hand-editing panel-secrets.json. */
export function clearPanelSecret(slotId: string): boolean {
  const slot = SLOT_BY_ID.get(slotId);
  if (!slot) throw new Error(`unknown credential slot "${slotId}"`);
  const remove = slot.store === "agent" ? removeAgentSecret : removeComfyuiSecret;
  let removed = false;
  for (const key of slot.envKeys) removed = remove(key) || removed;
  return removed;
}

/** Masked per-slot state: set = the slot's PRIMARY (first) env key has a stored value. */
export function listPanelSecretsMasked(): { id: string; label: string; set: boolean; masked: string | null }[] {
  const comfyui = loadComfyuiSecretEnv();
  const agent = loadAgentSecretEnv();
  return CREDENTIAL_SLOTS.map((slot) => {
    const store = slot.store === "agent" ? agent : comfyui;
    const primary = slot.envKeys[0];
    const val = store[primary];
    return { id: slot.id, label: slot.label, set: !!val, masked: val ? maskSecret(val) : null };
  });
}
