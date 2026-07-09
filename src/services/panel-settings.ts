// Persisted panel settings for the orchestrator's background agent. Survives
// soft reloads and full restarts (it's a small JSON file on disk), so a setting
// like the adult-content consent gate stays put and is queryable across the
// session — the agent reads it before deciding whether to surface NSFW work.
//
// The NSFW gate is a SAFETY control: it defaults OFF (keep everything SFW), and
// only flips ON after an explicit, verified-adult opt-in (18+ and adult content
// legal in the user's region). It governs what the system SURFACES and records
// the user's consent. It never overrides hard limits (no minors, no real-person
// sexual deepfakes, no depictions of actual non-consensual acts).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "../utils/logger.js";

export interface NsfwConsent {
  /** True only after a verified-adult opt-in through the consent gate. */
  allowed: boolean;
  /** ISO timestamp of the most recent consent decision. */
  decidedAt?: string;
}

/** Non-secret connection config for the Ollama/OpenAI-compatible backend.
 *  API keys never live here — they stay in env (OPENROUTER_API_KEY etc.). */
export interface OllamaAgentConfig {
  /** Default model tag/id (e.g. "gemma4:12b", "xiaomi/mimo-v2.5"). */
  model?: string;
  /** "ollama" (local /api/chat) or "openai" (any OpenAI-compatible endpoint). */
  api?: "ollama" | "openai";
  /** Endpoint base URL (e.g. https://openrouter.ai/api/v1, incl. /v1). */
  baseUrl?: string;
}

export interface AgentSettings {
  /** User-curated model ids pinned to the top of the panel's model picker. */
  preferredModels?: string[];
  ollama?: OllamaAgentConfig;
  /** LM Studio provider (issue #160) — same shape; api/baseUrl unused today
   *  (fixed openai dialect + COMFYUI_MCP_LMSTUDIO_HOST) but kept for #162. */
  lmstudio?: OllamaAgentConfig;
  /** llama.cpp provider (issue #161) — same shape as lmstudio. */
  llamacpp?: OllamaAgentConfig;
  /** Custom OpenAI-compatible endpoint (issue #162): baseUrl + model, both
   *  user-supplied. The API key stays in the 0600 secrets store
   *  (COMFYUI_MCP_CUSTOM_API_KEY), never here. */
  custom?: OllamaAgentConfig;
}

export interface PanelSettings {
  nsfwConsent?: NsfwConsent;
  agent?: AgentSettings;
}

/** Settings file path. Overridable for tests. */
export function panelSettingsPath(): string {
  return (
    process.env.COMFYUI_MCP_PANEL_SETTINGS ||
    join(homedir(), ".comfyui-mcp", "panel-settings.json")
  );
}

function read(): PanelSettings {
  const p = panelSettingsPath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as PanelSettings) : {};
  } catch (err) {
    logger.warn(`[panel-settings] could not parse ${p}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

function write(settings: PanelSettings): void {
  const p = panelSettingsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(settings, null, 2));
}

/** Current NSFW consent state. Defaults to OFF when never set. */
export function getNsfwConsent(): NsfwConsent {
  return read().nsfwConsent ?? { allowed: false };
}

/**
 * Persist an NSFW consent decision. `allowed` true ONLY after a verified-adult
 * opt-in; false revokes. Stamps the decision time.
 */
export function setNsfwConsent(allowed: boolean): NsfwConsent {
  const decidedAt = new Date().toISOString();
  const settings = read();
  settings.nsfwConsent = { allowed, decidedAt };
  write(settings);
  return settings.nsfwConsent;
}

/** Persisted agent backend/model preferences ({} when never set). */
export function getAgentSettings(): AgentSettings {
  return read().agent ?? {};
}

/**
 * Merge a partial update into the persisted agent settings. `preferredModels`
 * replaces the whole list (the panel sends the full edited list); `ollama`
 * fields merge per-key so e.g. a model change doesn't clobber the base URL.
 */
export function setAgentSettings(patch: AgentSettings): AgentSettings {
  const settings = read();
  const prev = settings.agent ?? {};
  const next: AgentSettings = { ...prev };
  if (patch.preferredModels !== undefined) {
    next.preferredModels = [
      ...new Set(patch.preferredModels.map((m) => m.trim()).filter(Boolean)),
    ].slice(0, 50);
  }
  if (patch.ollama !== undefined) {
    next.ollama = { ...prev.ollama, ...patch.ollama };
  }
  if (patch.lmstudio !== undefined) {
    next.lmstudio = { ...prev.lmstudio, ...patch.lmstudio };
  }
  if (patch.llamacpp !== undefined) {
    next.llamacpp = { ...prev.llamacpp, ...patch.llamacpp };
  }
  if (patch.custom !== undefined) {
    next.custom = { ...prev.custom, ...patch.custom };
  }
  settings.agent = next;
  write(settings);
  return next;
}
