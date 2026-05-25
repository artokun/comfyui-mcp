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

export function resolveModel(id?: string): LanguageModel {
  const modelId = id ?? process.env.COMFYUI_MCP_AGENT_MODEL ?? DEFAULT_MODEL;
  return registry.languageModel(modelId as RegistryModelId);
}
