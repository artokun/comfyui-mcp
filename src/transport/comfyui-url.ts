export interface ComfyUITarget {
  host: string;
  port: number;
  ssl: boolean;
  /**
   * Normalized URL path prefix the ComfyUI instance is mounted under, e.g.
   * "/comfyapi" for `https://host/comfyapi`. Empty string when mounted at root.
   * No trailing slash. Preserved so reverse-proxy / API-gateway setups route
   * correctly instead of hitting `/prompt`, `/system_stats`, … at the root.
   */
  basePath: string;
}

/**
 * Trim a URL pathname into a base prefix: no trailing slash, and "" for the
 * root ("" or "/"). "/comfyapi/" → "/comfyapi".
 */
function normalizeBasePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" || trimmed === "/" ? "" : trimmed;
}

/**
 * Parse a full ComfyUI URL (e.g. http://127.0.0.1:8188, https://comfy.example.com,
 * https://host/comfyapi) into host/port/ssl/basePath. Used by --comfyui-url /
 * COMFYUI_URL to target any (incl. remote, reverse-proxied) ComfyUI instance,
 * overriding the COMFYUI_HOST/PORT/SSL env vars.
 */
export function parseComfyUIUrl(url: string): ComfyUITarget {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Unsupported protocol "${u.protocol}" in --comfyui-url (expected http or https)`);
  }
  const ssl = u.protocol === "https:";
  const port = u.port ? Number(u.port) : ssl ? 443 : 80;
  return { host: u.hostname, port, ssl, basePath: normalizeBasePath(u.pathname) };
}
