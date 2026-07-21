/**
 * PER-TAB start-failure notice (issue #250, extracted for testability — issue
 * #255 review finding 5): when a tab's agent backend rejects at
 * prepare()/first-connect (an invalid API key 401ing on an OpenAI-dialect
 * provider, an unreachable endpoint), the orchestrator degrades THAT tab only.
 * This module builds the exact bridge frames the orchestrator pushes:
 *
 *   1. an honest `say` naming the provider, with check-your-key guidance
 *      (hint selected via the OpenAI-key provider registry when the backend is
 *      a registered key provider, with openrouter/custom/generic fallbacks);
 *   2. a degraded `ack` so the panel shows the real state;
 *   3. `turn: done` — the user_message path already pushed turn:"working", and
 *      the panel clears its thinking spinner ONLY on turn:"done"; without this
 *      the degraded tab sits on a live spinner for the 120s safety timeout
 *      (adversarial review of #253, finding 1).
 *
 * The manager reports failures under the COMPOSITE agent key
 * (`panelTabId::backend`); frames must go to the PANEL tab, so the composite
 * key is split here on its LAST separator (a panel tab id never contains "::";
 * backend names never do).
 */
import { openAiKeyProvider } from "../services/openai-provider-registry.js";

export const AGENT_KEY_SEP = "::";

/** The panel tab id half of a composite agent key (the whole key when bare). */
export function panelTabOfKey(key: string): string {
  const i = key.lastIndexOf(AGENT_KEY_SEP);
  return i >= 0 ? key.slice(0, i) : key;
}

/** The backend half of a composite agent key (`fallback` when bare). */
export function backendOfKey(key: string, fallback: string): string {
  const i = key.lastIndexOf(AGENT_KEY_SEP);
  return i >= 0 ? key.slice(i + AGENT_KEY_SEP.length) : fallback;
}

/** Check-your-credentials guidance for a backend that failed to start. */
export function startFailureHint(backend: string): string {
  const reg = openAiKeyProvider(backend);
  if (reg) {
    return `Check your ${reg.slotLabel} API key in the API Keys card (${reg.envKeys[0]}), then Disconnect → Connect to retry.`;
  }
  if (backend === "openrouter") {
    return "Check your OpenRouter API key in the API Keys card (OPENROUTER_API_KEY), then Disconnect → Connect to retry.";
  }
  if (backend === "custom") {
    return "Check the base URL and API key in Settings → Custom endpoint, then Disconnect → Connect to retry.";
  }
  return "Check the provider's credentials/login, then Disconnect → Connect to retry.";
}

export interface StartFailureNotice {
  /** The PANEL tab the frames must be pushed to (composite key split). */
  panelTab: string;
  /** The backend half of the composite key (names the provider in the say). */
  backend: string;
  /** Bridge frames, in push order: say → degraded ack → turn done. */
  frames: Array<Record<string, unknown>>;
}

/** Build the per-tab degradation frames for a start failure on `key`. */
export function buildStartFailureNotice(
  key: string,
  message: string,
  defaultBackend: string,
): StartFailureNotice {
  const backend = backendOfKey(key, defaultBackend);
  const panelTab = panelTabOfKey(key);
  const hint = startFailureHint(backend);
  return {
    panelTab,
    backend,
    frames: [
      { type: "say", text: `⚠️ The ${backend} agent could not start: ${message} — ${hint}` },
      { type: "ack", ok: false, kind: "degraded" },
      { type: "turn", state: "done" },
    ],
  };
}
