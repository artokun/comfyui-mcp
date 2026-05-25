import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { createProviderRegistry } from "ai";
import type { LanguageModel } from "ai";

// ---------------------------------------------------------------------------
// Provider registry for the experimental embedded-agent-panel POC.
//
// Picks the language model per request from a single registry, keyed by a
// `provider:model` string (the AI SDK default separator). Default is Anthropic
// with the model from COMFYUI_MCP_AGENT_MODEL. Provider API keys are read from
// the usual env vars by each provider package (ANTHROPIC_API_KEY, etc.).
//
// Not part of the default MCP server — only used behind COMFYUI_MCP_AGENT_POC.
// ---------------------------------------------------------------------------

export const registry = createProviderRegistry({
  anthropic,
  openai,
  google,
});

const DEFAULT_MODEL = "anthropic:claude-sonnet-4-5";

/**
 * Resolve the language model for a request.
 *
 * @param id Optional `provider:model` id (e.g. "anthropic:claude-sonnet-4-5").
 *   Falls back to COMFYUI_MCP_AGENT_MODEL, then a sensible default.
 */
// The registry's languageModel() is typed against a strict union of known
// model ids. We accept any `provider:model` string at runtime, so widen the
// parameter type to the registry's loose template-literal overload.
type RegistryModelId = Parameters<typeof registry.languageModel>[0];

/**
 * The set of model ids a request is allowed to select: the server default
 * (COMFYUI_MCP_AGENT_MODEL or DEFAULT_MODEL) plus any explicitly allow-listed
 * via COMFYUI_MCP_AGENT_ALLOWED_MODELS (comma-separated `provider:model`).
 */
function allowedModels(): Set<string> {
  const set = new Set<string>([DEFAULT_MODEL]);
  const envDefault = process.env.COMFYUI_MCP_AGENT_MODEL?.trim();
  if (envDefault) set.add(envDefault);
  const extra = process.env.COMFYUI_MCP_AGENT_ALLOWED_MODELS;
  if (extra) {
    for (const m of extra.split(",")) {
      const t = m.trim();
      if (t) set.add(t);
    }
  }
  return set;
}

export function resolveModel(id?: string): LanguageModel {
  const fallback = process.env.COMFYUI_MCP_AGENT_MODEL?.trim() || DEFAULT_MODEL;
  // Only honour a client-supplied model id if it is explicitly allow-listed.
  // Otherwise ignore it and use the server default — this stops a leaked tunnel
  // URL from letting a caller select arbitrary (expensive) models on your keys.
  const requested = id?.trim();
  const modelId =
    requested && allowedModels().has(requested) ? requested : fallback;
  return registry.languageModel(modelId as RegistryModelId);
}
