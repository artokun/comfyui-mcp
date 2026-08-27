import { getComfyUIAuthHeaders } from "../config.js";

/**
 * Boolean URL probe with a timeout — hello-retarget and pending-pod connect.
 *
 * Module-level FUNCTION DECLARATION, not a nested `const` arrow. #2425: the
 * hello path used to close over a `const probeOk` declared ~2000 lines below
 * in the same function; a hello arriving in that window threw
 * `Cannot access 'probeOk' before initialization`, swallowed as an ignored
 * unhandled rejection, so the retarget silently did not happen. A declaration
 * at this scope is initialized before any handler runs, and still hoists if
 * someone later inlines it.
 */
export async function probeOk(url: string, timeoutMs = 8_000): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // Carry configured auth (COMFYUI_AUTH_TOKEN / custom header) — a
    // protected pod's ComfyUI 401s otherwise and connect:true always times
    // out (codex finding).
    const res = await fetch(url, { signal: ctl.signal, headers: getComfyUIAuthHeaders() });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}
