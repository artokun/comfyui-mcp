// llama.cpp (llama-server) probes for the panel orchestrator — the two
// launch-time gotchas the provider must surface instead of failing cryptically:
//
//   * `--jinja` is MANDATORY for tool calling: without it llama-server rejects
//     any request carrying `tools` (and can never emit finish_reason=
//     tool_calls). A server that "connects fine" then errors on the first real
//     message reads as a wedge — detect it at connect time instead.
//   * context is fixed at LAUNCH (`-c`), not per request: the comfyui-mcp tool
//     payload needs ~16K minimum, so a small n_ctx silently truncates. /props
//     reports the server's actual window.
//
// Best-effort: failures return "unknown" rather than blocking a connect.

import { logger } from "../utils/logger.js";

/** Server-side facts from llama-server's native GET /props. */
export interface LlamacppProps {
  nCtx?: number;
  modelPath?: string;
}

/** The REST root (strip a trailing /v1 — native endpoints hang off the root). */
function serverRoot(host: string): string {
  return host.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export async function llamacppProps(host: string): Promise<LlamacppProps> {
  try {
    const res = await fetch(`${serverRoot(host)}/props`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return {};
    const body = (await res.json()) as {
      default_generation_settings?: { n_ctx?: number };
      model_path?: string;
    };
    return {
      nCtx: body.default_generation_settings?.n_ctx,
      modelPath: body.model_path,
    };
  } catch {
    return {};
  }
}

/** Can this server take tool-calling requests?
 *
 *  Primary signal: /props `chat_template_caps.supports_tools` — authoritative
 *  on current builds (which enable jinja BY DEFAULT; verified live on b9945:
 *  a plain launch reports supports_tools:true and accepts tools). Fallback for
 *  OLD builds (where --jinja was opt-in and tools requests get REJECTED): a
 *  minimal max_tokens-1 tools request, "no" on the tools/jinja error signature. */
export async function llamacppToolsReady(
  host: string,
  model: string,
): Promise<"yes" | "no" | "unknown"> {
  try {
    const res = await fetch(`${serverRoot(host)}/props`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const body = (await res.json()) as {
        chat_template_caps?: { supports_tools?: boolean; supports_tool_calls?: boolean };
      };
      const caps = body.chat_template_caps;
      if (caps && (caps.supports_tools === false || caps.supports_tool_calls === false)) {
        logger.warn("[llamacpp] /props reports the chat template does NOT support tools");
        return "no";
      }
      if (caps?.supports_tools || caps?.supports_tool_calls) return "yes";
    }
  } catch {
    // fall through to the request probe
  }
  try {
    const res = await fetch(`${host.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ok" }],
        tools: [
          {
            type: "function",
            function: { name: "noop", description: "noop", parameters: { type: "object", properties: {} } },
          },
        ],
        max_tokens: 1,
      }),
      // generous: this may also be the JIT/model warm-up request
      signal: AbortSignal.timeout(120000),
    });
    if (res.ok) return "yes";
    // unknown-ok: "" cannot match either marker, so an unreadable body falls
    // through to the `return "unknown"` below rather than to `return "no"` — the
    // three states are already distinct and a failed read lands on the right one.
    const text = (await res.text().catch(() => "")).toLowerCase();
    if (text.includes("jinja") || text.includes("tools")) {
      logger.warn(`[llamacpp] tools probe rejected (server without --jinja?): ${text.slice(0, 160)}`);
      return "no";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}
