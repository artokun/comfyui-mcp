import { getComfyUIAuthHeaders } from "../config.js";

/**
 * `fetch` wrapper for ComfyUI HTTP requests that injects the configured generic
 * auth header(s) (COMFYUI_AUTH_* — for self-hosted ComfyUI behind a reverse
 * proxy / API gateway). A no-op when no auth is configured. Explicit headers on
 * the call always win, so it never clobbers a per-request `Content-Type`.
 *
 * Use this instead of the global `fetch` for every call to the user's ComfyUI
 * server. Non-ComfyUI requests (HuggingFace, Civitai, Comfy Cloud) keep using
 * plain `fetch` — Comfy Cloud has its own X-API-Key path in cloud-client.ts.
 */
export function comfyuiFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const auth = getComfyUIAuthHeaders();
  if (Object.keys(auth).length === 0) return fetch(input, init);
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(auth)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return fetch(input, { ...init, headers });
}
