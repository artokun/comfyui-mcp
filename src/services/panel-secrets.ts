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

interface PanelSecrets {
  /** Env vars injected into the built-in comfyui MCP server's spawn env. */
  comfyuiEnv?: Record<string, string>;
  /** Env vars the ORCHESTRATOR reads in-process (not the comfyui child) — e.g.
   *  the OpenRouter API key for the OpenRouter provider backend. Kept SEPARATE
   *  from comfyuiEnv (different allowlist) so a provider key is never injected
   *  into the tool subprocess and a tool token never reaches the LLM backend. */
  agentEnv?: Record<string, string>;
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
export const AGENT_SECRET_ENV_ALLOWLIST = ["OPENROUTER_API_KEY", "COMFYUI_MCP_CUSTOM_API_KEY"] as const;
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
