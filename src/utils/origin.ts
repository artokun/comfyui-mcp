// Comparing two ORIGINS for "is this the same server" (#1175).
//
// `http://127.0.0.1:8188` and `http://localhost:8188` are the same ComfyUI, and
// comparing the strings says they are not. A reporter's panel was on the first
// while the headless target was the second — the headless restart worked and
// then probed 127.0.0.1:8188, proving they were one instance — and the
// orchestrator still reported "a DIFFERENT address" and advised pointing
// COMFYUI_URL at an origin it was already pointed at.
//
// The same blindness scopes the workflow-instance fence, which is keyed by
// origin: a fence adopted under one spelling would refuse under the other. That
// half is not hypothetical either, because the relay path now DERIVES its origin
// from COMFYUI_URL (#1077) while the loopback path OBSERVES the browser's — two
// independent sources that can easily disagree only in spelling.
//
// WHY THIS IS ITS OWN MODULE. Three loopback notions already exist
// (`isLoopbackServerUrl`, `port-owner`'s LOOPBACK/WILDCARD split,
// `env-capabilities`' LOCAL/REMOTE test) and they legitimately differ — one
// treats `0.0.0.0` as local, another must keep bind-wildcards separate from
// connect addresses. None of them answers "are these two origins the same
// server", so this adds that one question rather than bending any of them.

/**
 * Loopback spellings treated as ONE host.
 *
 * Deliberately the exact four, not all of 127.0.0.0/8: two servers really can
 * bind 127.0.0.1:8188 and 127.0.0.2:8188 at the same time, and calling those the
 * same origin would be a false identity — the failure this exists to prevent,
 * mirrored. `localhost` can resolve to ::1 rather than 127.0.0.1 on some
 * systems, which is the one genuine assumption here; it is the right one,
 * because when it is wrong the resulting message ("the browser can reach this
 * and this process cannot — a firewall, a container boundary, or a server bound
 * to one interface") is a BETTER description of a v4/v6 split than "point
 * COMFYUI_URL somewhere else" was.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** The canonical loopback spelling, so every alias collapses to one key. */
const LOOPBACK_CANONICAL = "localhost";

/**
 * `scheme://host[:port]` with loopback aliases collapsed, or undefined when
 * `url` is not a URL. The SCHEME is never collapsed: http and https on one host
 * are different origins by every other rule in this codebase, and a proxy can
 * genuinely serve different things on each.
 */
export function canonicalOrigin(url: string | undefined): string | undefined {
  if (typeof url !== "string" || !url.trim()) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  const origin = parsed.origin;
  // A scheme with no authority (file:, data:) has the literal origin "null".
  if (!origin || origin === "null") return undefined;
  const host = parsed.hostname.toLowerCase();
  const canonHost = LOOPBACK_HOSTS.has(host) ? LOOPBACK_CANONICAL : host;
  // Rebuild rather than string-replace: `parsed.port` is "" for a default port,
  // which is exactly the normalisation `origin` already applies, and a host can
  // otherwise appear inside the scheme or a userinfo section.
  return `${parsed.protocol}//${canonHost}${parsed.port ? `:${parsed.port}` : ""}`;
}

/** True when two URLs name the same origin, loopback aliases included. */
export function sameOrigin(a: string | undefined, b: string | undefined): boolean {
  const left = canonicalOrigin(a);
  const right = canonicalOrigin(b);
  // Two unparseable inputs are not "the same origin" — that would make every
  // piece of junk equal to every other, and callers use this to decide whether
  // to report a mismatch.
  return left !== undefined && left === right;
}
