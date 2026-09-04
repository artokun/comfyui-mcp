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
import { processLocale, trFor } from "../i18n/index.js";

/**
 * The "🟢 comfyui-mcp agent ready — <label> …" greeting for a given backend, with
 * `label` (the model/agent name) substituted in. `customBaseUrl` is only used by
 * the custom-endpoint backend. Mirrors the connect-handler's provider phrasing
 * exactly so an initial banner and a later correction are identical but for the
 * model name.
 *
 * LOCALE. This text is pushed as a `say` frame, so it lands in a chat bubble inside a
 * specific panel tab and belongs in THAT reader's language — hence `trFor`, not `tr`.
 * The panel's hello frame carries no language field yet, so `locale` is an explicit
 * parameter the caller supplies: when it is omitted we fall back to the process locale
 * (`--lang` / `COMFYUI_MCP_LANG` / `LANG`), which on a loopback install is the same
 * person's own setting and is a far better guess than hard-coding English. Once the
 * panel reports its language, threading it here is a one-argument change and every
 * greeting below follows automatically.
 *
 * The 🟢/⚠ markers are NOT translated. They are the status signal a reader scans for
 * before reading a word, they mean the same thing in every language, and a catalog
 * that drops or swaps one changes what the line asserts — so each fallback carries
 * its marker and every translation is expected to reproduce it verbatim.
 */
export function readyBannerText(
  backend: string,
  label: string,
  customBaseUrl = "",
  locale?: string,
): string {
  // `||`, not `??`: an unset panel language serializes as "" far more often than as
  // undefined, and an empty string is not a locale — it would resolve to English and
  // quietly skip the `--lang` the user actually set.
  const loc = locale || processLocale();
  const t = (key: string, fallback: string) => trFor(loc, key, fallback, { label, url: customBaseUrl });
  const reg = openAiKeyProvider(backend);
  if (reg) return reg.readyMessage(label, loc);
  switch (backend) {
    case "codex":
      return t("banner.ready.codex", "🟢 comfyui-mcp agent ready — {label} on your Codex (ChatGPT) account. Ask away.");
    case "chatgpt":
      return t("banner.ready.chatgpt", "🟢 comfyui-mcp agent ready — {label} on your ChatGPT subscription (direct OAuth). Ask away.");
    case "gemini":
      return t("banner.ready.gemini", "🟢 comfyui-mcp agent ready — {label} on your Google account (Gemini Code Assist). Ask away.");
    case "antigravity":
      return t("banner.ready.antigravity", "🟢 comfyui-mcp agent ready — {label} on your Google AI subscription via Antigravity CLI. Note: agy turns show final answers only (no live tool progress). Ask away.");
    case "pi":
      // Deliberately hedged: readiness for pi is a DISK check (a well-formed,
      // present credential), never a proven-working one — a revoked key or a
      // spent quota only shows up on the first real turn, so don't promise more
      // than "we found a credential" (#491). The hedge is the POINT of this
      // string, so it has to survive translation — keep it in every catalog.
      return t("banner.ready.pi", "🟢 comfyui-mcp agent ready — {label} via the pi CLI on your own provider credential (found on this machine; pi checks it on your first message). Note: pi has no ComfyUI tools (no MCP) — it works with its own coding tools on the local workspace, not the panel canvas. Ask away.");
    case "grok":
      return t("banner.ready.grok", "🟢 comfyui-mcp agent ready — {label} on your Grok (xAI) account. Ask away.");
    case "ollama":
      return t("banner.ready.ollama", "🟢 comfyui-mcp agent ready — {label} running locally via Ollama (no account, no API key). Small local models are slower and simpler than frontier ones — expect fewer frills. Ask away.");
    case "lmstudio":
      return t("banner.ready.lmstudio", "🟢 comfyui-mcp agent ready — {label} running locally via LM Studio (no account, no API key). Small local models are slower and simpler than frontier ones — expect fewer frills. Ask away.");
    case "llamacpp":
      return t("banner.ready.llamacpp", "🟢 comfyui-mcp agent ready — {label} running locally via llama.cpp (no account, no API key). Small local models are slower and simpler than frontier ones — expect fewer frills. Ask away.");
    case "custom":
      return t("banner.ready.custom", "🟢 comfyui-mcp agent ready — {label} via your custom endpoint ({url}). Ask away.");
    case "openrouter":
      return t("banner.ready.openrouter", "🟢 comfyui-mcp agent ready — {label} via OpenRouter (hosted API, your OPENROUTER_API_KEY). Ask away.");
    case "copilot":
      return t("banner.ready.copilot", "🟢 comfyui-mcp agent ready — {label} on your GitHub Copilot subscription (⚠ experimental, ToS risk — you opted in). Ask away.");
    default:
      return t("banner.ready.claude", "🟢 comfyui-mcp agent ready — {label} on your Claude subscription. Ask away.");
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
  /** Language of the tab this correction is destined for — see readyBannerText. */
  locale?: string;
}): string | null {
  const { backend, advertisedLabel, resolvedModel, customBaseUrl = "", locale } = opts;
  if (typeof advertisedLabel !== "string" || !advertisedLabel) return null;
  if (typeof resolvedModel !== "string" || !resolvedModel.trim()) return null;
  if (resolvedModel === advertisedLabel) return null;
  return readyBannerText(backend, resolvedModel, customBaseUrl, locale);
}
