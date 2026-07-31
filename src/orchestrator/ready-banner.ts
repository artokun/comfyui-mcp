// Ready-banner text (#376) — extracted as a PURE builder so the connect handler
// and the later "real model learned" correction render the SAME phrasing, and so
// it is unit-testable.
//
// The bug (#376): the greeting is sent at HELLO time, before the SDK's init
// message reports the actually-resolved model — so the Claude/default path's
// label was the pre-init env default (COMFYUI_MCP_PANEL_MODEL ?? "claude-opus-5"),
// not the model the agent actually runs. Threading the resolved model through
// onSession lets us RE-SEND a corrected banner (bannerCorrection below) once the
// real model is known.

import { openAiKeyProvider } from "../services/openai-provider-registry.js";

/**
 * The "🟢 comfyui-mcp agent ready — <label> …" greeting for a given backend, with
 * `label` (the model/agent name) substituted in. `customBaseUrl` is only used by
 * the custom-endpoint backend. Mirrors the connect-handler's provider phrasing
 * exactly so an initial banner and a later correction are identical but for the
 * model name.
 */
export function readyBannerText(backend: string, label: string, customBaseUrl = ""): string {
  const reg = openAiKeyProvider(backend);
  if (reg) return reg.readyMessage(label);
  switch (backend) {
    case "codex":
      return `🟢 comfyui-mcp agent ready — ${label} on your Codex (ChatGPT) account. Ask away.`;
    case "chatgpt":
      return `🟢 comfyui-mcp agent ready — ${label} on your ChatGPT subscription (direct OAuth). Ask away.`;
    case "gemini":
      return `🟢 comfyui-mcp agent ready — ${label} on your Google account (Gemini Code Assist). Ask away.`;
    case "antigravity":
      return `🟢 comfyui-mcp agent ready — ${label} on your Google AI subscription via Antigravity CLI. Note: agy turns show final answers only (no live tool progress). Ask away.`;
    case "grok":
      return `🟢 comfyui-mcp agent ready — ${label} on your Grok (xAI) account. Ask away.`;
    case "ollama":
      return `🟢 comfyui-mcp agent ready — ${label} running locally via Ollama (no account, no API key). Small local models are slower and simpler than frontier ones — expect fewer frills. Ask away.`;
    case "lmstudio":
      return `🟢 comfyui-mcp agent ready — ${label} running locally via LM Studio (no account, no API key). Small local models are slower and simpler than frontier ones — expect fewer frills. Ask away.`;
    case "llamacpp":
      return `🟢 comfyui-mcp agent ready — ${label} running locally via llama.cpp (no account, no API key). Small local models are slower and simpler than frontier ones — expect fewer frills. Ask away.`;
    case "custom":
      return `🟢 comfyui-mcp agent ready — ${label} via your custom endpoint (${customBaseUrl}). Ask away.`;
    case "openrouter":
      return `🟢 comfyui-mcp agent ready — ${label} via OpenRouter (hosted API, your OPENROUTER_API_KEY). Ask away.`;
    case "copilot":
      return `🟢 comfyui-mcp agent ready — ${label} on your GitHub Copilot subscription (⚠️ experimental, ToS risk — you opted in). Ask away.`;
    default:
      return `🟢 comfyui-mcp agent ready — ${label} on your Claude subscription. Ask away.`;
  }
}

/**
 * Decide the CORRECTED ready banner to re-send once the SDK reports the real model
 * (#376), or `null` when no correction is warranted. Returns a banner ONLY when:
 *   - a banner WAS actually advertised for this tab (`advertisedLabel` is a
 *     non-empty string) — a resume/reconnect never greeted, so an EMPTY map must
 *     NOT be read as a mismatch and produce a spurious banner; and
 *   - the resolved model is a non-empty string that DIFFERS from that label.
 * So a correct initial banner never duplicates, and a resumed session with no
 * prior greeting is never corrected.
 */
export function bannerCorrection(opts: {
  backend: string;
  advertisedLabel: string | undefined;
  resolvedModel: string | undefined;
  customBaseUrl?: string;
}): string | null {
  const { backend, advertisedLabel, resolvedModel, customBaseUrl = "" } = opts;
  if (typeof advertisedLabel !== "string" || !advertisedLabel) return null;
  if (typeof resolvedModel !== "string" || !resolvedModel.trim()) return null;
  if (resolvedModel === advertisedLabel) return null;
  return readyBannerText(backend, resolvedModel, customBaseUrl);
}
