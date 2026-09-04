// Choosing a validated local CONNECTED-PANEL origin to retry a failed headless
// read against (#2149).
//
// The browser handshake is useful provenance, but a server-observed origin can
// still be a remote/tunnel/LAN page. This module is deliberately stricter than
// canonicalOrigin: only an HTTP(S) origin with no credentials, path, query, or
// fragment, and only loopback hosts, is eligible for direct MCP contact.

import { canonicalOrigin } from "../utils/origin.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export type PanelFallbackChoice =
  | { kind: "none" }
  | { kind: "same"; origin: string }
  | { kind: "ambiguous"; origins: string[] }
  | { kind: "use"; origin: string }
  | { kind: "invalid"; count: number };

/** Parse an HTTP(S) URL and return its origin, rejecting credentials and fragments. */
export function httpOriginOf(raw: unknown, allowPath = true, allowQuery = true): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    if (parsed.username || parsed.password || (!allowQuery && (parsed.hash || parsed.search))) return undefined;
    if (!allowPath && parsed.pathname !== "/") return undefined;
    return parsed.origin === "null" ? undefined : parsed.origin;
  } catch {
    return undefined;
  }
}

/** Normalize a candidate panel origin, with no path/query/userinfo allowed. */
export function normalizePanelOrigin(raw: unknown): string | undefined {
  return httpOriginOf(raw, false, false);
}

/** Only loopback origins are safe for direct MCP contact in this fallback. */
export function isLoopbackPanelOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return LOOPBACK_HOSTS.has(host);
  } catch {
    return false;
  }
}

/** The MCP target and fallback candidate must both be local loopback origins. */
export function isSafePanelOriginForMcp(failedTarget: string, candidate: string): boolean {
  const targetOrigin = httpOriginOf(failedTarget);
  const candidateOrigin = normalizePanelOrigin(candidate);
  return (
    targetOrigin !== undefined &&
    candidateOrigin !== undefined &&
    isLoopbackPanelOrigin(targetOrigin) &&
    isLoopbackPanelOrigin(candidateOrigin)
  );
}

/** Choose exactly one validated local panel origin different from the failed target. */
export function choosePanelFallbackOrigin(
  failedTarget: string,
  origins: readonly string[],
): PanelFallbackChoice {
  const targetOrigin = httpOriginOf(failedTarget);
  if (targetOrigin === undefined || !isLoopbackPanelOrigin(targetOrigin)) return { kind: "none" };

  const byCanonical = new Map<string, string>();
  let invalidCount = 0;
  for (const raw of origins) {
    const origin = normalizePanelOrigin(raw);
    if (origin === undefined || !isSafePanelOriginForMcp(failedTarget, origin)) {
      invalidCount++;
      continue;
    }
    const canon = canonicalOrigin(origin);
    if (canon === undefined) {
      invalidCount++;
      continue;
    }
    if (!byCanonical.has(canon)) byCanonical.set(canon, origin);
  }
  // A valid origin must never survive beside malformed, unsupported, or remote
  // input. That would turn a mixed trust set into a silently selected target.
  if (invalidCount > 0) return { kind: "invalid", count: invalidCount };
  if (byCanonical.size === 0) return { kind: "none" };

  const targetCanonical = canonicalOrigin(targetOrigin);
  if (targetCanonical === undefined) return { kind: "none" };
  const different: string[] = [];
  let same: string | undefined;
  for (const [canon, origin] of byCanonical) {
    if (canon === targetCanonical) same = origin;
    else different.push(origin);
  }
  if (different.length === 0) return same ? { kind: "same", origin: same } : { kind: "none" };
  if (different.length > 1) return { kind: "ambiguous", origins: different };
  return { kind: "use", origin: different[0] };
}

/** Explain why a panel set was not retried. */
export function describeDeclinedPanelFallback(choice: PanelFallbackChoice): string {
  if (choice.kind === "ambiguous") {
    return (
      ` I did NOT retry against a connected panel: ${choice.origins.length} different local ` +
      `ComfyUI origins are connected (${choice.origins.join(", ")}), and choosing one of ` +
      `them would risk answering from a server you did not mean. Point COMFYUI_URL at the one you want.`
    );
  }
  if (choice.kind === "invalid") {
    return (
      ` I did NOT retry against a connected panel: ${choice.count} connected origin` +
      `${choice.count === 1 ? " was" : "s were"} malformed, unsupported, remote, or otherwise ` +
      `unsafe for direct MCP contact.`
    );
  }
  return "";
}

/** #2836 — a published origin set that cannot be proven is not a guessed target. */
export type PanelReadOriginResolution =
  | { kind: "unknown" }
  | { kind: "unproven" }
  | { kind: "proven"; origin: string; apiBase: string };

const UNDEFINED_API_BASE_RE =
  /Cannot read propert(?:y|ies) of undefined \(reading ['"]?api_base['"]?\)|Cannot read property ['"]?api_base['"]? of undefined/i;

/** Resolve the connected panel origin and API base before a fallback read. */
export function resolvePanelReadOrigin(
  origins: readonly string[],
  apiBase: string | undefined,
): PanelReadOriginResolution {
  if (origins.length === 0) return { kind: "unknown" };
  const proven: string[] = [];
  for (const raw of origins) {
    const origin = normalizePanelOrigin(raw);
    if (origin === undefined) return { kind: "unproven" };
    proven.push(origin);
  }
  if (proven.length === 0) return { kind: "unproven" };
  if (typeof apiBase !== "string") return { kind: "unproven" };
  return { kind: "proven", origin: proven[0], apiBase };
}

/**
 * #2839 — the compact comfyui child may list templates from its configured
 * target only when that target is the unique published panel origin. Mixed,
 * malformed, or empty sets stay unproven so a guessed URL is never contacted.
 */
export function provenPanelOriginMatchesConfiguredTarget(
  origins: readonly string[],
  configuredTarget: string,
): boolean {
  const targetOrigin = httpOriginOf(configuredTarget);
  const targetCanon = targetOrigin ? canonicalOrigin(targetOrigin) : undefined;
  if (!targetCanon || origins.length === 0) return false;
  const canons = new Set<string>();
  for (const raw of origins) {
    const origin = normalizePanelOrigin(raw);
    if (origin === undefined) return false;
    const canon = canonicalOrigin(origin);
    if (canon === undefined) return false;
    canons.add(canon);
  }
  return canons.size === 1 && canons.has(targetCanon);
}

/** True when the panel-side crash was `undefined.api_base`, not a transport result. */
export function isUndefinedApiBaseFailure(error: unknown): boolean {
  const parts: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (!(current instanceof Error)) break;
    parts.push(current.message);
    if ("reason" in current && typeof current.reason === "string") {
      parts.push(current.reason);
    }
    current = current.cause;
  }
  return parts.some((part) => UNDEFINED_API_BASE_RE.test(part));
}
