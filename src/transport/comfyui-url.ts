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
 * Format a parsed ComfyUI host for an authority in a connection URL.
 *
 * IPv6 literals must be bracketed when followed by a port. The configured
 * host remains unchanged here; connection-only callers can use
 * formatComfyUIConnectionHost when they need Node to select either loopback
 * family for a legacy 127.0.0.1 target.
 */
export function formatComfyUIHost(host: string): string {
  const bare = host.replace(/^\[|\]$/g, "");
  return bare.includes(":") ? `[${bare}]` : bare;
}

/** Format a host for a network connection without changing remote identity. */
export function formatComfyUIConnectionHost(host: string): string {
  const bare = host.replace(/^\[|\]$/g, "");
  return bare === "127.0.0.1" ? "localhost" : formatComfyUIHost(bare);
}

/** Apply the connection-only host formatting to a complete ComfyUI URL. */
export function formatComfyUIUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.hostname.replace(/^\[|\]$/g, "") !== "127.0.0.1") return url;

  const hadBareRoot = parsed.pathname === "/" && !parsed.search && !parsed.hash && !/\/$/.test(url.trim());
  parsed.hostname = "localhost";
  const formatted = parsed.href;
  return hadBareRoot ? formatted.slice(0, -1) : formatted;
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
