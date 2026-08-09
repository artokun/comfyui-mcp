import { lookup } from "node:dns/promises";
import { unreachableHostMessage, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

/** Default cap on how long we wait for a workflow URL to respond. */
const DEFAULT_TIMEOUT_MS = 15_000;
/** Default cap on the workflow payload size (workflows are JSON, rarely > a few MB). */
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
/** Default cap on the DNS lookup so a slow/hanging resolver can't stall the tool. */
const DEFAULT_DNS_TIMEOUT_MS = 5_000;

/**
 * Known "share" hosts that serve an HTML page (or require an authenticated API
 * call) rather than raw workflow JSON. We can't resolve these to a graph, so we
 * fail fast with a clear instruction instead of fetching a web page and choking
 * on the HTML.
 */
const UNSUPPORTED_SHARE_HOSTS = [
  "comfyworkflows.com",
  "openart.ai",
  "civitai.com",
  "comfy.icu",
  "pixfor.us",
];

export interface FetchWorkflowResult {
  /** Parsed JSON payload (unknown shape — caller validates it's a workflow). */
  json: unknown;
  /** The final URL actually fetched (after blob→raw normalization). */
  finalUrl: string;
}

/**
 * Normalize well-known workflow URLs to their raw-JSON equivalent, and reject
 * share hosts we can't resolve.
 *
 * - GitHub blob pages (`github.com/o/r/blob/ref/path.json`) → the raw file on
 *   `raw.githubusercontent.com`.
 * - GitHub `?raw=true` blob links → raw host too.
 * - Known share hosts (comfyworkflows, openart, civitai, …) → throw with a hint
 *   to paste the raw `.json` URL.
 *
 * Anything else is returned unchanged.
 */
export function normalizeWorkflowUrl(rawUrl: string): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    // Leave parsing/validation errors to assertSafeUrl, which gives a better message.
    return rawUrl;
  }

  const host = u.hostname.toLowerCase();

  // github.com/<owner>/<repo>/blob/<ref>/<path...> → raw.githubusercontent.com
  if (host === "github.com" || host === "www.github.com") {
    const parts = u.pathname.split("/").filter(Boolean);
    const blobIdx = parts.indexOf("blob");
    if (blobIdx >= 2 && blobIdx < parts.length - 1) {
      const owner = parts[0];
      const repo = parts[1];
      const rest = parts.slice(blobIdx + 1).join("/");
      return `https://raw.githubusercontent.com/${owner}/${repo}/${rest}`;
    }
  }

  // Refuse share hosts that don't serve raw JSON.
  if (
    UNSUPPORTED_SHARE_HOSTS.some((h) => host === h || host.endsWith("." + h))
  ) {
    throw new ValidationError(
      `Unsupported share host "${host}" — it serves a web page, not raw workflow JSON, ` +
        `and we can't resolve it without that site's API. Open the workflow there, then paste ` +
        `the direct raw .json URL (e.g. a raw.githubusercontent.com link or a "Save (API Format)" ` +
        `export hosted as a .json file).`,
    );
  }

  return rawUrl;
}

/**
 * Reject any URL that isn't a plain http(s) request to a public host. Blocks
 * file:// and other schemes, loopback, link-local, private, and CGNAT ranges to
 * avoid SSRF (e.g. tricking the server into fetching its own /admin or the cloud
 * metadata endpoint at 169.254.169.254).
 *
 * This is the LITERAL-host check; `fetchWorkflowFromUrl` additionally resolves
 * the hostname via DNS and re-runs these checks against every resolved address
 * (defeating DNS-rebinding) and refuses to follow redirects.
 */
export function assertSafeUrl(rawUrl: string): URL {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new ValidationError(`Invalid URL: ${rawUrl}`);
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ValidationError(
      `Only http/https URLs are supported (got "${u.protocol}"). ` +
        `file://, data:, and other schemes are rejected.`,
    );
  }

  const host = u.hostname.toLowerCase();
  if (isBlockedHost(host)) {
    throw new ValidationError(
      `Refusing to fetch from internal/loopback host "${host}" (SSRF guard). ` +
        `Only public http/https hosts are allowed.`,
    );
  }

  return u;
}

/**
 * True for hostnames/IPs that point at the local machine or a private network.
 * Exported for unit testing.
 */
export function isBlockedHost(host: string): boolean {
  if (!host) return true;

  // Hostname-based internal names.
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;

  // IPv6 (URL.hostname strips the surrounding brackets).
  if (host.includes(":")) {
    const h = host.replace(/^\[|\]$/g, "");
    if (h === "::1" || h === "::") return true; // loopback / unspecified
    const low = h.toLowerCase();
    // Unique-local fc00::/7 (fc.. / fd..) and link-local fe80::/10 (fe8/fe9/fea/feb).
    if (/^f[cd]/.test(low)) return true;
    if (/^fe[89ab]/.test(low)) return true;
    // IPv4-mapped IPv6 (::ffff:127.0.0.1) — extract the trailing v4 literal.
    const v4 = low.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4) return isBlockedIpv4(v4[1]);
    return false;
  }

  // IPv4 literal.
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return isBlockedIpv4(host);
  }

  return false;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n > 255)) {
    return true; // malformed → reject
  }
  const [a, b] = parts;
  if (a === 0 || a === 127 || a === 10) return true; // this-host / loopback / private
  if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
  if (a === 192 && b === 168) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/** Reject a promise that doesn't settle within `ms`, with a clear label. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Resolve a hostname and reject if ANY resolved address is internal/private.
 * This defeats DNS-rebinding: a hostname that passes the literal-host check but
 * resolves to loopback/RFC1918/link-local/metadata/CGNAT/IPv6-ULA is blocked.
 * IP literals resolve to themselves, so this is a no-op-but-safe for those.
 * Bounded so a slow resolver can't hang the tool. Exported for testing.
 */
export async function assertHostResolvesSafe(
  host: string,
  timeoutMs: number = DEFAULT_DNS_TIMEOUT_MS,
): Promise<void> {
  let results: Array<{ address: string }>;
  try {
    results = await withTimeout(
      lookup(host, { all: true }),
      timeoutMs,
      `DNS lookup for "${host}"`,
    );
  } catch (err) {
    const e = err as Error;
    throw new ValidationError(
      `Could not resolve host "${host}": ${e?.message ?? err}`,
    );
  }

  if (!results || results.length === 0) {
    throw new ValidationError(`Host "${host}" did not resolve to any address.`);
  }

  for (const r of results) {
    if (isBlockedHost(r.address)) {
      throw new ValidationError(
        `Refusing to fetch "${host}" — it resolves to internal/private address ` +
          `${r.address} (SSRF guard / DNS-rebinding protection).`,
      );
    }
  }
}

/**
 * Fetch and JSON-parse a workflow from a remote URL with SSRF, timeout, and
 * size guards. Throws ValidationError (never a raw fetch error) on any failure
 * so callers can surface a clean message via errorToToolResult.
 *
 * SSRF defenses: http/https only; literal-host check; DNS resolution with every
 * resolved address re-checked against the private/internal ranges; and redirects
 * are NOT followed (a 30x to an internal target is rejected — raw workflow-JSON
 * hosts don't need redirects, and GitHub blob→raw is normalized up front).
 */
export async function fetchWorkflowFromUrl(
  rawUrl: string,
  opts?: { timeoutMs?: number; maxBytes?: number; dnsTimeoutMs?: number },
): Promise<FetchWorkflowResult> {
  const normalized = normalizeWorkflowUrl(rawUrl);
  const u = assertSafeUrl(normalized);
  await assertHostResolvesSafe(u.hostname, opts?.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS);

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(u, {
      signal: controller.signal,
      // Do NOT auto-follow redirects — a public URL could 30x to an internal
      // target that bypasses the DNS/host checks above.
      redirect: "manual",
      headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.5" },
    });
  } catch (err) {
    const e = err as Error;
    if (e?.name === "AbortError") {
      throw new ValidationError(
        `Timed out after ${timeoutMs}ms fetching workflow from "${u.hostname}".`,
      );
    }
    // #1136 — reaching here means `fetch` REJECTED, so no response was received.
    // Whether the TCP handshake completed (TLS error, RST) is invisible to the
    // user and irrelevant to the harm: nothing was retrieved, so nothing follows
    // about whether the workflow exists. The shared helper says exactly that and
    // names the host; it also separates "did not respond in time" from "could
    // not reach" using the undici timeout codes, which a hand-rolled code list
    // kept getting wrong.
    throw new ValidationError(
      unreachableHostMessage(err, u.toString(), "fetching the workflow").message,
    );
  } finally {
    clearTimeout(timer);
  }

  // redirect:"manual" surfaces redirects as an opaqueredirect response (status 0
  // in Node/undici) or, in test doubles, a literal 3xx. Reject either rather
  // than following into a possibly-internal Location.
  if (
    res.type === "opaqueredirect" ||
    res.status === 0 ||
    (res.status >= 300 && res.status < 400)
  ) {
    throw new ValidationError(
      `Workflow URL responded with a redirect (status ${res.status}) — redirects are ` +
        `not followed (SSRF guard). Use the final direct .json URL instead.`,
    );
  }

  if (!res.ok) {
    throw new ValidationError(
      `Workflow URL returned ${res.status} ${res.statusText}. ` +
        `Check the link points at a public raw .json file.`,
    );
  }

  // Pre-flight size check via Content-Length when present.
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared && declared > maxBytes) {
    throw new ValidationError(
      `Workflow payload too large (${declared} bytes > ${maxBytes} byte limit).`,
    );
  }

  const text = await res.text();
  if (text.length > maxBytes) {
    throw new ValidationError(
      `Workflow payload too large (${text.length} bytes > ${maxBytes} byte limit).`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    const preview = text.slice(0, 120).replace(/\s+/g, " ").trim();
    throw new ValidationError(
      `URL did not return valid JSON (got: "${preview}…"). ` +
        `If this is a share/preview page, paste the raw workflow JSON URL instead.`,
    );
  }

  logger.info("Fetched workflow from URL", { finalUrl: u.toString(), bytes: text.length });
  return { json, finalUrl: u.toString() };
}
