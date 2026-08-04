// Transient-failure classification + backoff for the local streaming download
// path (#470, #817).
//
// WHY THIS EXISTS
// A multi-GB transfer over a modest link WILL be interrupted — a CDN drop, a
// proxy reset, an undici `terminated`. Before this, ONE such blip terminated the
// whole job permanently ("failed: terminated"), and the caller's only recourse
// was to re-issue `download_model` by hand. The bytes on disk were not lost (the
// `.partial` + `.etag` sidecar machinery from #343/#467 preserves and safely
// resumes them), but a human/agent had to notice and act. This module supplies
// the policy that lets the SAME call recover by itself: retry with backoff,
// resuming from the preserved partial each attempt.
//
// FAIL-SAFE BY CONSTRUCTION
// `classifyDownloadFailure` defaults to NOT retryable. Only an explicitly
// enumerated transport/transient signal opts an error in. An unrecognized error
// therefore behaves EXACTLY as it did before this module existed (surface it,
// once). That direction of default matters: a wrongly-retried integrity refusal
// would re-run a corruption path several times and burn bandwidth, while a
// wrongly-NOT-retried transport blip merely reproduces today's behavior.
//
// NEVER RETRIED (deliberately absent from the transient set):
//   - user cancellation — the caller's abort is checked by the loop itself,
//     before classification, so a cancel can never be "recovered from";
//   - 4xx other than 408/429 — auth/gating/not-found; a retry cannot fix them
//     and, per #470's own report, an instant re-request is what earned a 403;
//   - #473 non-model payload rejections — an HTML/JSON auth page is a
//     configuration problem, not a blip;
//   - the #343/#467 resume/integrity refusals (bad Content-Range, size
//     disagreement, oversized body) — those mean the SERVER is misbehaving or
//     the object changed; hammering it is not a remedy.

import { logger } from "../utils/logger.js";

/**
 * Marker placed on a ModelError's `details` by the code that RAISES it, when
 * that code knows the failure is transient and the on-disk `.partial` is still a
 * valid resume candidate. Preferred over message matching: the message is prose
 * that gets reworded, the flag is a contract.
 */
export interface RetryableDetails {
  retryable?: boolean;
  code?: unknown;
  status?: unknown;
}

/**
 * Node/undici error codes that denote a TRANSPORT interruption — the connection
 * died, not the request being wrong. Every one of these leaves the bytes already
 * written to the `.partial` intact and range-resumable.
 */
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ENETUNREACH",
  "ENETRESET",
  "ENETDOWN",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "ERR_STREAM_PREMATURE_CLOSE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_RESPONSE_STATUS_CODE",
]);

/**
 * HTTP statuses worth another attempt. 408/429 are the server ASKING for one;
 * 5xx is the server failing transiently. Everything else 4xx is a request the
 * retry cannot change.
 */
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Message fragments for transport failures that arrive with NO usable code.
 * undici surfaces a mid-body socket death as a bare `TypeError: terminated`
 * whose code lives (if anywhere) on a nested cause — this is the exact string
 * #470 reported. Kept deliberately SHORT and anchored to whole-ish phrases so it
 * cannot swallow an integrity message: none of the refusals in download-cache.ts
 * contain any of these.
 */
const TRANSIENT_MESSAGE_FRAGMENTS = [
  "terminated",
  "socket hang up",
  "other side closed",
  "premature close",
  "connection closed",
  "network layer",
];

export interface FailureClassification {
  retryable: boolean;
  /** Why — surfaced in the log line and (on final failure) the error text, so a
   *  reader can tell "we gave up after N tries" from "we never tried again". */
  reason: string;
}

/** Walk an error's `cause` chain collecting every `code` seen. undici nests the
 *  real `ECONNRESET`/`UND_ERR_SOCKET` one or two levels under a bare TypeError. */
function codesOf(err: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    const c = (cur as { code?: unknown }).code;
    if (typeof c === "string") codes.push(c);
    cur = (cur as { cause?: unknown }).cause;
  }
  // A ModelError carries the unwrapped fetch code on `details.code` (fetchOrThrow).
  const details = (err as { details?: RetryableDetails })?.details;
  if (details && typeof details.code === "string") codes.push(details.code);
  return codes;
}

/** Every message in the cause chain, lower-cased and joined. */
function messagesOf(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    if (cur.message) parts.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  if (parts.length === 0) parts.push(String(err));
  return parts.join(" | ").toLowerCase();
}

/**
 * Decide whether a failed download attempt may be retried IN THE SAME CALL.
 *
 * Defaults to `false`. The caller must ALSO have established that the user did
 * not cancel — this function deliberately does not inspect abort state, because
 * "the user cancelled" is not a property of the error (an AbortError is raised
 * by our own stall watchdog too, and THAT one is retryable). Keeping the two
 * concerns apart is what stops a cancel from being retried into a completion.
 */
export function classifyDownloadFailure(err: unknown): FailureClassification {
  const details = (err as { details?: RetryableDetails })?.details;

  // 1. An explicit contract from the raising code wins over any heuristic — in
  //    BOTH directions, so a site that knows the partial is poison can veto.
  if (details && typeof details.retryable === "boolean") {
    return {
      retryable: details.retryable,
      reason: details.retryable
        ? "the transfer was interrupted mid-stream and the partial file is still resumable"
        : "the failure is not recoverable by retrying",
    };
  }

  // 2. An HTTP status we captured. A DEFINITE non-transient status must LOSE to
  //    nothing below it: return here either way so a 403's prose ("Forbidden")
  //    can never fall through to the message-fragment test.
  const status = typeof details?.status === "number" ? details.status : undefined;
  if (status !== undefined) {
    return TRANSIENT_STATUSES.has(status)
      ? { retryable: true, reason: `the host answered ${status}, which is a transient/back-off status` }
      : { retryable: false, reason: `the host answered ${status}, which a retry cannot change` };
  }

  // 3. A transport error code anywhere in the cause chain.
  for (const code of codesOf(err)) {
    if (TRANSIENT_CODES.has(code)) {
      return { retryable: true, reason: `the connection failed with ${code}` };
    }
  }

  // 4. Last resort: a transport failure that arrived with no code at all.
  const message = messagesOf(err);
  for (const fragment of TRANSIENT_MESSAGE_FRAGMENTS) {
    if (message.includes(fragment)) {
      return { retryable: true, reason: `the connection dropped mid-transfer ("${fragment}")` };
    }
  }

  return { retryable: false, reason: "the failure is not a recognized transport interruption" };
}

/**
 * Tunable retry/stall policy. Defaults are production values; tests override via
 * {@link setDownloadRetryPolicyForTests} so the suite never actually sleeps.
 */
const policy = {
  /** TOTAL attempts per download (1 = the pre-#470 behavior, no retry). */
  maxAttempts: 5,
  /** First backoff delay; doubles each attempt up to `backoffCapMs`. #470 traced
   *  a 403 to an INSTANT re-request after an abort, so the first wait is real. */
  backoffBaseMs: 2_000,
  backoffCapMs: 30_000,
  /**
   * How long an attempt may go with ZERO bytes arriving before it is abandoned
   * and retried (#470's "no growth for ~30 min while still listed in-flight",
   * and the bounded-attempt half of #817). This is a STALL bound, not a total
   * bound: a slow-but-alive 20 GB transfer is never interrupted by it, because
   * every chunk resets the clock. A total-duration cap — the 600s in #817 — is
   * the wrong shape; it kills healthy large transfers and cannot distinguish
   * them from wedged ones.
   */
  stallTimeoutMs: 120_000,
};

export type DownloadRetryPolicy = typeof policy;

/** @internal — test hook to shrink retry/stall timings; not part of the tool API. */
export function setDownloadRetryPolicyForTests(overrides: Partial<DownloadRetryPolicy>): void {
  Object.assign(policy, overrides);
}

function hasEnv(name: string): boolean {
  const raw = process.env[name];
  return raw !== undefined && raw.trim() !== "";
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    logger.warn(`Ignoring ${name}="${raw}" — not a number; using ${fallback}.`);
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** The live policy, with env overrides applied. Read per-download so a setting
 *  change takes effect without a restart. */
export function downloadRetryPolicy(): DownloadRetryPolicy {
  return {
    // 1 disables retry entirely — an explicit, documented escape hatch.
    maxAttempts: envInt("COMFYUI_DOWNLOAD_MAX_ATTEMPTS", policy.maxAttempts, 1, 20),
    backoffBaseMs: policy.backoffBaseMs,
    backoffCapMs: policy.backoffCapMs,
    // 0 disables the stall watchdog (the pre-#470 "wait forever" behavior).
    // The env var is in SECONDS but the policy is in MILLISECONDS, so the
    // fallback is taken in ms and only a PRESENT env value is scaled — routing
    // the default through a seconds round-trip would silently floor any
    // sub-second policy (which is how tests configure a fast watchdog) to zero,
    // i.e. to "no watchdog at all".
    stallTimeoutMs: hasEnv("COMFYUI_DOWNLOAD_STALL_TIMEOUT_S")
      ? envInt("COMFYUI_DOWNLOAD_STALL_TIMEOUT_S", 0, 0, 86_400) * 1000
      : policy.stallTimeoutMs,
  };
}

/** Exponential backoff for `attempt` (1-based: the wait BEFORE attempt 2 is
 *  `attempt = 1`), capped. Deterministic — the caller adds jitter if it wants
 *  it; tests assert the schedule exactly. */
export function backoffDelayMs(attempt: number, p: DownloadRetryPolicy = downloadRetryPolicy()): number {
  const raw = p.backoffBaseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(p.backoffCapMs, raw);
}

/**
 * Sleep that wakes EARLY (and rejects) if `signal` aborts. A cancel issued
 * during a backoff wait must stop the download then and there — not up to 30
 * seconds later when the timer happens to fire.
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The download was cancelled.", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new DOMException("The download was cancelled.", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
