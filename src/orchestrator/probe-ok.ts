import { comfyuiFetch } from "../comfyui/fetch.js";

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
    // comfyuiFetch carries configured auth and the literal-first loopback
    // fallback used by every ComfyUI HTTP caller.
    const res = await comfyuiFetch(url, { signal: ctl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}
