// Which panel-agent backends share THIS machine's GPU with ComfyUI while a
// render runs — the single locality determination behind the VRAM handoff in
// orchestrator/index.ts (free the local model's VRAM where the server has an
// unload surface, HOLD chats until the render finishes, then warm back).
//
// "Local" = the backend's server answers on a LOOPBACK URL: same machine,
// same GPU. A remote host (e.g. COMFYUI_MCP_LLAMACPP_HOST=http://gpu-box:8080/v1)
// is someone else's VRAM and must NOT be gated — holding those chats would
// stall work for a contention that doesn't exist.

/** Loopback-URL locality test (127.0.0.1 / localhost / [::1], any port, with
 *  or without a path suffix like /v1). ONE regex for every backend in the
 *  handoff so the locality rule can't drift between providers. */
export function isLoopbackServerUrl(host: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(host);
}

/** True when the llama.cpp server (llama-server, or llama-swap in front of it)
 *  is local — its model holds VRAM on the GPU ComfyUI renders on. */
export function isLocalLlamacpp(host: string): boolean {
  return isLoopbackServerUrl(host);
}

/** Per-backend answers to "is this backend's LLM server local?" — computed at
 *  the gate from the live config (dialect + base URLs). */
export interface LocalVramLocality {
  /** Native-ollama dialect (an "openai"-dialect ollama backend points at a
   *  hosted OpenAI-compatible endpoint — not local VRAM). */
  ollama: boolean;
  lmstudio: boolean;
  llamacpp: boolean;
}

/** True when `backend`'s LLM shares the GPU ComfyUI renders on, so its chats
 *  are HELD while a render runs (and its model unloaded where the server has
 *  an unload surface). Any other backend — claude/codex/gemini/custom/… —
 *  never touches local VRAM. */
export function backendSharesRenderGpu(backend: string, local: LocalVramLocality): boolean {
  switch (backend) {
    case "ollama":
      return local.ollama;
    case "lmstudio":
      return local.lmstudio;
    case "llamacpp":
      return local.llamacpp;
    default:
      return false;
  }
}

/** Is the render-time VRAM handoff on? Default on; opt out with
 *  COMFYUI_MCP_PAUSE_LOCAL_ON_GEN=0 — the neutral name now that the handoff
 *  covers three backends. The legacy COMFYUI_MCP_OLLAMA_PAUSE_ON_GEN=0 is
 *  still honored when the new name is unset. */
export function pauseLocalOnGenEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.COMFYUI_MCP_PAUSE_LOCAL_ON_GEN ?? env.COMFYUI_MCP_OLLAMA_PAUSE_ON_GEN) !== "0";
}

/**
 * ONE hold notice per render, per recipient — not one per held message (#2290).
 *
 * The hold itself is announced at the moment a chat is withheld, but a person who types
 * three lines in a row during one render triggers that code path three times, and three
 * identical "a render is running" bubbles read worse than the silence they replaced. This
 * tracks which recipients have already been told about the render currently in flight.
 *
 * Scoped to the RECIPIENT (the tab the notice is pushed to), not to the shared conversation:
 * a second tab that sends its own message during the same render has been told nothing yet,
 * and "I've queued your message" is only true for whoever sent one.
 *
 * `reset()` marks a hold-episode boundary — the render ended (or a new one began), so the
 * next held message is a new wait and announces again.
 */
export class RenderHoldNotice {
  private readonly told = new Set<string>();

  /** True exactly once per recipient per hold episode: this caller should announce. */
  claim(recipient: string): boolean {
    if (this.told.has(recipient)) return false;
    this.told.add(recipient);
    return true;
  }

  /** A new hold episode starts (or the current one ended) — everyone is untold again. */
  reset(): void {
    this.told.clear();
  }
}
