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
import { OPENAI_KEY_PROVIDERS, providerModelHint } from "./openai-provider-registry.js";

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
  "RUNPOD_API_KEY",
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

// ── Canonical env-secret store: ~/.comfyui-mcp/.env ─────────────────────────
// The SINGLE source of truth for flat API-token secrets (RUNPOD/CIVITAI/HF/…).
// config.ts loads this file into process.env at boot for BOTH the orchestrator
// and every spawned comfyui-mcp agent, so a token here reaches everywhere with
// no separate injection. (Structured OAuth login state stays in the JSON store —
// it isn't a flat KEY=value env var.) Writes are a surgical single-line upsert:
// the rest of the user's .env — comments, other keys — is preserved byte-for-byte.

/** Path to the canonical dotenv. Matches config.ts; overridable for tests. */
export function envFilePath(): string {
  return process.env.COMFYUI_MCP_ENV_FILE || join(homedir(), ".comfyui-mcp", ".env");
}

/** Encode a value for a .env line — quote only when it contains characters a
 *  bare value can't hold; double-quoted + JSON-escaped is dotenv-compatible. */
function encodeEnvValue(value: string): string {
  return /[\s#"'\\]/.test(value) ? JSON.stringify(value) : value;
}

/** Upsert `KEY=value` into the canonical .env, 0600, preserving every other line
 *  (comments included). Replaces the first uncommented `KEY=` line, else appends. */
function upsertEnvFile(key: string, value: string): void {
  const p = envFilePath();
  mkdirSync(dirname(p), { recursive: true });
  const raw = existsSync(p) ? readFileSync(p, "utf-8") : "";
  const lines = raw.length ? raw.split(/\r?\n/) : [];
  const line = `${key}=${encodeEnvValue(value)}`;
  const re = new RegExp(`^\\s*${key}\\s*=`);
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (!replaced && re.test(lines[i])) {
      lines[i] = line;
      replaced = true;
    }
  }
  if (!replaced) {
    // Drop a single trailing empty line so we don't accumulate blanks, then add.
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(line);
    lines.push("");
  }
  writeFileSync(p, lines.join("\n"), { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* chmod is a no-op on Windows; ignore */
  }
}

/** Remove every uncommented `KEY=` line from the canonical .env. Returns whether
 *  anything was removed. */
function removeEnvFileKey(key: string): boolean {
  const p = envFilePath();
  if (!existsSync(p)) return false;
  const lines = readFileSync(p, "utf-8").split(/\r?\n/);
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const kept = lines.filter((l) => !re.test(l));
  if (kept.length === lines.length) return false;
  writeFileSync(p, kept.join("\n"), { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* ignore */
  }
  return true;
}

/** True when `key` may be persisted (union of the comfyui-tool + agent-provider
 *  allowlists — both now land in the same canonical .env). */
export function isAllowedSecretKey(key: string): boolean {
  return isAllowedComfyuiSecretKey(key) || isAllowedAgentSecretKey(key);
}

/**
 * THE canonical secret setter: persist a flat token to ~/.comfyui-mcp/.env,
 * apply it to process.env immediately (so in-process readers see it now), and
 * emit so the orchestrator re-probes provider readiness AND respawns the agent
 * on idle (the respawn reloads .env → the child gets the new key). Rejects a
 * non-allowlisted key so a stray key can never be written.
 */
export function setEnvSecret(key: string, value: string): void {
  const trimmed = key.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error(`Invalid env var name "${key}" — use a valid shell identifier.`);
  }
  if (!isAllowedSecretKey(trimmed)) {
    throw new Error(
      `Env var "${trimmed}" is not an accepted secret. Allowed: ${[...new Set([...COMFYUI_SECRET_ENV_ALLOWLIST, ...AGENT_SECRET_ENV_ALLOWLIST])].join(", ")}.`,
    );
  }
  upsertEnvFile(trimmed, value);
  process.env[trimmed] = value; // live in-process effect (env wins over the file)
  // Only a COMFYUI tool secret should restart the comfyui MCP child + inject the
  // "retry the download that needed this token" nudge (#269): saving an
  // agent-ONLY provider key (OPENROUTER/GLM/KIMI…) previously restarted every
  // agent with that nonsensical download-retry message. Agent-only keys fire
  // just "agentChange" (readiness/model refresh) below.
  if (isAllowedComfyuiSecretKey(trimmed)) emitter.emit("change");
  if (isAllowedAgentSecretKey(trimmed)) emitter.emit("agentChange"); // flip provider readiness live
}

/** Canonical remover: drop a token from .env + process.env + emit. Also PURGES
 *  the legacy panel-secrets.json maps (#269): without this a key revoked from
 *  .env would RESURRECT on the next boot, because migrateSecretsToEnv() re-adds
 *  any key still present in the JSON store that .env no longer provides. */
export function removeEnvSecret(key: string): boolean {
  const removed = removeEnvFileKey(key);
  if (process.env[key] !== undefined) delete process.env[key];
  // Purge the legacy JSON maps so a revoked key can't resurrect via migration.
  const s = read();
  let purgedJson = false;
  for (const map of [s.comfyuiEnv, s.agentEnv]) {
    if (map && Object.prototype.hasOwnProperty.call(map, key)) {
      delete map[key];
      purgedJson = true;
    }
  }
  if (purgedJson) write(s);
  const changed = removed || purgedJson;
  if (changed) {
    if (isAllowedComfyuiSecretKey(key)) emitter.emit("change"); // comfyui-only restart (#269)
    if (isAllowedAgentSecretKey(key)) emitter.emit("agentChange");
  }
  return changed;
}

/**
 * One-time migration to the canonical .env: any flat token still living in the
 * legacy panel-secrets.json (comfyuiEnv / agentEnv) is upserted into .env unless
 * .env / a real env var already provides it. NON-DESTRUCTIVE — it only ADDS
 * missing keys; it never rewrites unrelated .env lines and never deletes from the
 * JSON store (left inert). Idempotent. Returns the keys migrated.
 */
export function migrateSecretsToEnv(): string[] {
  const s = read();
  const migrated: string[] = [];
  for (const map of [s.comfyuiEnv, s.agentEnv]) {
    if (!map || typeof map !== "object") continue;
    for (const [k, v] of Object.entries(map)) {
      if (typeof v !== "string" || !v) continue;
      if (!isAllowedSecretKey(k)) continue;
      if (process.env[k]) continue; // .env / real env already wins
      upsertEnvFile(k, v);
      process.env[k] = v;
      migrated.push(k);
    }
  }
  return migrated;
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
  // Canonical source is process.env (loaded from ~/.comfyui-mcp/.env at boot +
  // updated live by setEnvSecret), allowlist-filtered.
  const out: Record<string, string> = {};
  for (const k of COMFYUI_SECRET_ENV_ALLOWLIST) {
    const v = process.env[k];
    if (typeof v === "string" && v) out[k] = v;
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
  setEnvSecret(trimmed, value); // canonical store = ~/.comfyui-mcp/.env
}

/** Remove a stored comfyui secret. Returns false if absent. Emits on removal. */
export function removeComfyuiSecret(key: string): boolean {
  return removeEnvSecret(key);
}

/** The persisted agent-provider secrets (e.g. OPENROUTER_API_KEY), filtered
 *  through the agent allowlist. Never logged. */
export function loadAgentSecretEnv(): Record<string, string> {
  // Canonical source is process.env (from ~/.comfyui-mcp/.env), allowlist-filtered.
  const out: Record<string, string> = {};
  for (const k of AGENT_SECRET_ENV_ALLOWLIST) {
    const v = process.env[k];
    if (typeof v === "string" && v) out[k] = v;
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
  // Canonical secrets already come from ~/.comfyui-mcp/.env (dotenv at boot). This
  // now performs the one-time, non-destructive migration of any legacy tokens
  // still in panel-secrets.json into .env, so everything converges to one place.
  // Idempotent — a no-op once migrated. (Kept this name so the boot/agent-change
  // callers are unchanged.)
  return migrateSecretsToEnv();
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
  setEnvSecret(trimmed, value); // canonical store = ~/.comfyui-mcp/.env
}

/** Remove a stored agent secret. Returns false if absent. Also drops it from
 *  process.env (setAgentSecret put it there — a revoked key must stop applying
 *  NOW, not on the next restart). Emits on removal. */
export function removeAgentSecret(key: string): boolean {
  return removeEnvSecret(key);
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

// ── Agent-provider spawn env (tool-secret scoping) ───────────────────────────
// Tool secrets (RunPod/HF/CivitAI/RunComfy/Registry tokens…) live in process.env
// because config.ts loads ~/.comfyui-mcp/.env at boot and setEnvSecret applies
// live. That is CORRECT for the comfyui tool child (buildComfyuiMcpEnv), but the
// agent-provider subprocesses (Codex app-server, Gemini/Grok CLI…) must NEVER
// inherit them — a tool credential has no business in an LLM vendor's process.
// buildAgentSpawnEnv is the single spawn-env builder those backends use: a copy
// of process.env with every TOOL-ONLY secret key stripped.

/** Secret env keys that are TOOL-only (comfyui allowlist minus agent allowlist)
 *  — these must never reach an agent-provider subprocess's env. */
export const TOOL_ONLY_SECRET_ENV_KEYS: readonly string[] =
  COMFYUI_SECRET_ENV_ALLOWLIST.filter((k) => !AGENT_ALLOWLIST_SET.has(k));

/**
 * Build the env an AGENT-PROVIDER subprocess (Codex/Gemini/Grok CLI…) spawns
 * with: `base` (default process.env) with all tool-only secret keys removed.
 * `keep` re-admits specific keys when they double as the provider's OWN
 * credential (e.g. GEMINI_API_KEY for the Gemini CLI — same vendor, not a leak).
 */
export function buildAgentSpawnEnv(
  base: NodeJS.ProcessEnv = process.env,
  opts: { keep?: readonly string[] } = {},
): NodeJS.ProcessEnv {
  const keep = new Set(opts.keep ?? []);
  const out: NodeJS.ProcessEnv = { ...base };
  for (const k of TOOL_ONLY_SECRET_ENV_KEYS) {
    if (!keep.has(k)) delete out[k];
  }
  return out;
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
      // Append the generated model hint so the card says which model the
      // provider is actually on and how to change it — the override env var
      // existed but was invisible outside the source.
      help: `${p.slotHelp} · ${providerModelHint(p)}`,
    }),
  ),
  { id: "civitai", label: "Civitai", envKeys: ["CIVITAI_API_TOKEN"], store: "comfyui", help: "Model downloads" },
  { id: "huggingface", label: "HuggingFace", envKeys: ["HF_TOKEN", "HUGGINGFACE_TOKEN"], store: "comfyui", help: "Model downloads" },
  { id: "google", label: "Google / Gemini", envKeys: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"], store: "comfyui", help: "Nano Banana concept images" },
  { id: "runcomfy", label: "RunComfy", envKeys: ["RUNCOMFY_API_KEY"], store: "comfyui", help: "Cloud pods / training" },
  { id: "runpod", label: "RunPod", envKeys: ["RUNPOD_API_KEY"], store: "comfyui", help: "Manage GPU pods (status/start/stop/connect)" },
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
