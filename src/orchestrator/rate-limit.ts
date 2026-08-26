// HTTP 429 across every backend that talks to a provider over HTTP.
//
// WHY THIS EXISTS
// Each streaming backend had the same three lines — `if (!res.ok) throw new
// Error(\`… http ${status}: ${await res.text()}\`)` — and a 429 fell through them
// like any other failure: the turn died, and the provider's raw JSON was pasted
// into the panel. Live on kimi-k3 that read:
//
//   ⚠️ The kimi-k3 turn failed: ollama backend: https://api.moonshot.ai/v1/chat/
//   completions http 429: {"error":{"message":"Your account org-7df23a…<cak-fc91…>
//   request reached organization max RPM: 3, please try again after 1 seconds"}}
//
// Three separate defects in one line. The turn was thrown away over a ONE SECOND
// wait, after four successful tool rounds. The user was handed a provider's
// internal envelope instead of a sentence. And that envelope carried their
// organization id and a credential-shaped token into the chat log — from which it
// went into a screenshot, which is how this bug was reported.
//
// WHAT THIS MODULE DECIDES, AND WHAT IT REFUSES TO
// A 429 is the provider telling us to wait, so the honest response is to wait —
// but only when it says HOW LONG and the wait is bounded. Everything here is
// built around that distinction:
//
//   retryable — a wait window we can sit out. Retried, within a hard budget.
//   quota     — the account is out of credit/quota. More requests cannot help;
//               retrying would burn the budget to arrive at the same answer, so
//               this NEVER retries however short a window came with it.
//   unknown   — a 429 with no window we could parse. Surfaced immediately rather
//               than retried on a guessed delay: a fabricated backoff against an
//               unknown limiter is how a rate limit becomes a rate-limit storm.
//
// The default is to NOT retry. A 429 opts in by carrying a parseable window, the
// same direction of default services/download-retry.ts takes, and for the same
// reason: a wrongly-not-retried request reproduces exactly today's behaviour,
// while a wrongly-retried one hammers a limiter that just asked us to stop.
//
// NOTHING FROM THE PROVIDER IS ECHOED RAW. See sanitizeDetail.

import type { AgentEvent } from "./agent-backend.js";
import { redactTokens } from "../services/oauth-flow.js";
import { logger } from "../utils/logger.js";

/** How many times one request may be re-sent after a 429. */
export function rateLimitMaxRetries(): number {
  const n = Number(process.env.COMFYUI_MCP_RATE_LIMIT_RETRIES);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

/**
 * Ceiling on the TOTAL time one request may spend waiting out 429s.
 *
 * A per-attempt cap is not enough: three 25s windows are individually reasonable
 * and together are 75 seconds of a user watching a spinner. The budget is spent
 * across attempts, and a window that would overrun it is declined rather than
 * truncated — sleeping less than the provider asked for is a retry we already
 * know is too early.
 */
export function rateLimitMaxTotalWaitMs(): number {
  const n = Number(process.env.COMFYUI_MCP_RATE_LIMIT_MAX_WAIT_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

/**
 * Waits at or above this get a line in the chat; shorter ones pass in silence.
 *
 * A sub-second retry is invisible to the user — the turn just continues, a beat
 * later — and announcing it would be noise about a non-event. A 20-second one is
 * indistinguishable from a hang unless we say what is happening.
 */
export function rateLimitAnnounceMs(): number {
  const n = Number(process.env.COMFYUI_MCP_RATE_LIMIT_ANNOUNCE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 2_000;
}

export type RateLimitKind = "retryable" | "quota" | "unknown";

export interface RateLimitVerdict {
  kind: RateLimitKind;
  /** The wait the provider named. Present only for `retryable`. */
  retryAfterMs?: number;
  /** A SANITIZED fragment of the provider's explanation, or undefined. */
  detail?: string;
}

/** An error whose `message` is already the finished, user-facing sentence. */
export class RateLimitError extends Error {
  readonly kind: RateLimitKind;
  readonly retryAfterMs?: number;
  constructor(message: string, kind: RateLimitKind, retryAfterMs?: number) {
    super(message);
    this.name = "RateLimitError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Is this the error the retry driver gave up with? (Backends branch on it.) */
export function asRateLimitError(err: unknown): RateLimitError | null {
  return err instanceof RateLimitError ? err : null;
}

/** Body markers that mean "more requests will not help until the user acts". */
const QUOTA_MARKERS = [
  "insufficient_quota",
  "quota_exceeded",
  "billing_hard_limit_reached",
  "exceeded your current quota",
  "credit balance is too low",
  "out of credits",
  "no remaining credits",
  "payment required",
];

/** `1s`, `500ms`, `6m0s`, `1.5s` — the duration form OpenAI-compatible endpoints
 *  use for `x-ratelimit-reset-*`. Returns ms, or null if it is not that shape. */
function parseResetDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g;
  let total = 0;
  let saw = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    saw = true;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    total += n * (m[2] === "ms" ? 1 : m[2] === "s" ? 1000 : m[2] === "m" ? 60_000 : 3_600_000);
  }
  // Reject trailing junk: "6m0s" is a duration, "6 messages" is not. The matches
  // must account for the whole string once the separators are removed.
  if (!saw || s.replace(re, "").replace(/[\s,]/g, "") !== "") return null;
  return Math.round(total);
}

/**
 * `Retry-After`: delta-seconds or an HTTP-date (RFC 9110 §10.2.3).
 *
 * A date in the PAST yields 0, not a negative wait — some limiters send the
 * window's start rather than its end, and a negative sleep would silently become
 * an instant retry with no wait at all.
 */
function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const at = Date.parse(s);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return null;
}

/** "please try again after 1 seconds", "retry in 500ms", "try again in 2 minutes". */
function parseWaitFromProse(text: string): number | null {
  const m = text.match(
    /\b(?:try again|retry|retry again|wait)\b[^.\n]{0,40}?\b(\d+(?:\.\d+)?)\s*(ms|millis(?:econds?)?|s|secs?|seconds?|m|mins?|minutes?|h|hours?)\b/i,
  );
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  const mult = unit.startsWith("ms") || unit.startsWith("milli")
    ? 1
    : unit.startsWith("s")
      ? 1000
      : unit.startsWith("m")
        ? 60_000
        : 3_600_000;
  return Math.round(n * mult);
}

/**
 * Strip anything that identifies the ACCOUNT out of a provider message.
 *
 * `redactTokens` covers credentials in the shapes OAuth uses, and it is applied
 * first — but it knows nothing about `org-7df23a26037240f88f967fb1c64d8e3f` or
 * `cak-fc91zq3o4h0b111bug391`, which is exactly what leaked. The rule here is
 * SHAPE, not a list of known prefixes: a prefixed opaque run, or a long bare
 * run, is an identifier whatever the vendor calls it, and no rate-limit
 * explanation needs one to be useful. A vendor inventing a new prefix tomorrow is
 * covered without a code change, and so is one that mints ids with no digit in
 * them (#2313) — shape here means LENGTH and the absence of a space, never a
 * character class, and never a guess at whether a run reads like English.
 *
 * Deliberately aggressive. Over-redaction costs a few characters of an error
 * message; under-redaction publishes an account id into a chat log that gets
 * screenshotted.
 */
export function sanitizeDetail(raw: string, max = 200): string {
  const masked = redactTokens(raw)
    // UUID-shaped ids FIRST, with any prefix attached. Their hyphens defeat both
    // rules below: the longest unbroken run inside a UUID is 12 characters, so the
    // bare-run rule never fires, and the prefixed rule matches only the TAIL —
    // which is worse than missing it outright, because
    // `550e8400-e29b-41d4-a716-<redacted>` reads as sanitized while 24 of its 36
    // characters shipped. A partial redaction nobody re-checks is the dangerous
    // shape here, so this runs before anything can produce one.
    .replace(
      /\b(?:([A-Za-z][A-Za-z0-9]{1,12})[-_])?[A-Za-z0-9]{0,32}[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}[A-Za-z0-9]{0,32}\b/g,
      (_m, prefix: string | undefined) => (prefix ? `${prefix}-<redacted>` : "<redacted>"),
    )
    // prefixed opaque identifiers: org-…, cak-…, key_…, acct-…
    .replace(/\b([A-Za-z][A-Za-z0-9]{1,12}[-_])[A-Za-z0-9]{10,}\b/g, "$1<redacted>")
    // bare long runs (an id that came without a prefix). LENGTH is the whole
    // test: there is deliberately no `(?=[A-Za-z0-9]*\d)` lookahead requiring
    // a digit. That lookahead was here until #2313, and it meant an all-alphabetic
    // id — `account abcdefghijklmnopqrstuv is limited` — passed through untouched
    // while the same string ending in a digit was redacted. Neither other rule
    // caught it: the prefixed rule needs a `-`/`_`, and the UUID rule needs the
    // UUID shape.
    //
    // Do NOT put it back to protect prose — it does not buy what it looks like it
    // buys. Measured over 1.19M word tokens of this repo's comments, docs and
    // user-facing strings, exactly ONE all-lowercase run of 20+ characters is an
    // English word (`nondeterministically`, once), and it has never appeared in a
    // 429. An unbroken 20-character alphanumeric run is an identifier; an
    // explanatory sentence has spaces in it, and every space ends a run.
    .replace(/\b[A-Za-z0-9]{20,}\b/g, "<redacted>")
    // e-mail addresses occasionally appear in quota messages
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "<redacted>");
  return masked.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Pull the human sentence out of a provider error body.
 *
 * OpenAI-compatible bodies nest it at `error.message`; some endpoints answer with
 * bare text or HTML. Anything not JSON is used only if it is SHORT — a limiter's
 * HTML block page has no sentence worth showing, and pasting its first 200
 * characters is how the raw-dump problem started.
 */
function extractMessage(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const err = parsed?.error;
    const candidate =
      (err && typeof err === "object" ? (err as Record<string, unknown>).message : undefined) ??
      (typeof err === "string" ? err : undefined) ??
      parsed?.message ??
      parsed?.detail;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    return undefined;
  } catch {
    if (trimmed.length > 300 || /^\s*</.test(trimmed)) return undefined;
    return trimmed;
  }
}

/**
 * Drop the provider's "please try again after N seconds" clause from the text
 * shown to a user.
 *
 * That clause is an instruction to the CLIENT, and the client has already obeyed
 * it — the wait was parsed out of this very sentence. Quoting it back reads as a
 * contradiction next to the outcome ("did not recover after 3 attempts … please
 * try again after 1 seconds") and tells the user to do something we did for them.
 * What is left is the part they cannot act on any other way: WHICH limit was hit.
 */
function stripRetryHint(text: string): string {
  return text
    .replace(
      /[,;.]?\s*(?:please\s+)?(?:try again|retry(?: again)?|wait)\b[^.\n]{0,40}?\b\d+(?:\.\d+)?\s*(?:ms|millis(?:econds?)?|s|secs?|seconds?|m|mins?|minutes?|h|hours?)\b\.?/gi,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Classify a response as a rate limit, or not at all.
 *
 * 429 ONLY. A 402/403 for billing is a different conversation with the user (and
 * a different remedy), and folding it in here would have this module telling
 * someone to "wait" for a limit that no amount of waiting clears.
 */
export function classifyRateLimit(status: number, headers: Headers, body: string): RateLimitVerdict | null {
  if (status !== 429) return null;
  const message = extractMessage(body);
  const haystack = `${body} ${message ?? ""}`.toLowerCase();
  const detail = message ? sanitizeDetail(stripRetryHint(message)) : undefined;

  // Quota is decided BEFORE the window is read, and outranks it. Moonshot and
  // OpenAI both answer an exhausted balance with a 429 that still carries a
  // retry hint; honouring that hint would sleep, retry, and fail identically.
  if (QUOTA_MARKERS.some((marker) => haystack.includes(marker))) {
    return { kind: "quota", detail };
  }

  const waitMs =
    parseRetryAfter(headers.get("retry-after")) ??
    parseResetDuration(headers.get("x-ratelimit-reset-requests") ?? "") ??
    parseResetDuration(headers.get("x-ratelimit-reset-tokens") ?? "") ??
    parseResetDuration(headers.get("x-ratelimit-reset") ?? "") ??
    (message ? parseWaitFromProse(message) : null);

  if (waitMs === null) return { kind: "unknown", detail };
  return { kind: "retryable", retryAfterMs: waitMs, detail };
}

/** "1s" / "20s" / "2m30s" — for a sentence a person reads, not a machine. */
export function humanWait(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s ? `${m}m${s}s` : `${m}m`;
}

/** The line shown while waiting out a window (announced waits only). */
export function retryingNotice(model: string, waitMs: number, verdict: RateLimitVerdict): string {
  const because = verdict.detail ? ` (${verdict.detail})` : "";
  return `⏳ ${model} is rate limited${because}. Retrying in ${humanWait(waitMs)}…`;
}

/** The sentence the turn ends on when waiting is not an option, or did not work. */
export function gaveUpNotice(
  model: string,
  verdict: RateLimitVerdict,
  attempts: number,
  /** Whether the provider's response body could be read at all (#796): "it did
   *  not say how long to wait" is a claim about what arrived, and must not be
   *  made about a body we never managed to read. */
  bodyReadable = true,
): string {
  const because = verdict.detail ? ` — ${verdict.detail}` : "";
  if (verdict.kind === "quota") {
    return (
      `⚠️ ${model} rejected the request: the account is out of quota or credit${because}. ` +
      `Retrying will not help — top up or change plan with the provider, or switch models from the composer picker. ` +
      `The turn stopped part-way, so if it had already started changing the graph, check the canvas before you resend.`
    );
  }
  if (attempts > 0) {
    return (
      `⚠️ ${model} is rate limited and did not recover after ${attempts} ${attempts === 1 ? "attempt" : "attempts"}${because}. ` +
      `Try again in a moment or switch models from the composer picker — but if the turn had already started changing the graph, check the canvas before re-sending, because re-sending runs those steps again.`
    );
  }
  const why =
    verdict.kind !== "unknown"
      ? ""
      : bodyReadable
        ? "The provider did not say how long to wait, so the request was not retried automatically. "
        : "Its response could not be read, so there was no wait to honour and the request was not retried automatically. ";
  return (
    `⚠️ ${model} hit its rate limit${because}. ${why}` +
    `Try again in a moment or switch models from the composer picker — but if the turn had already started changing the graph, check the canvas before re-sending, because re-sending runs those steps again.`
  );
}

/** Abort-aware sleep: an interrupt during a backoff must not sit out the window. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Send a request, waiting out 429s that name a bounded window.
 *
 * Yields `rate_limit` events for waits worth announcing and RETURNS the response
 * to the caller, which keeps its own handling for every other status — a 500 or a
 * 400 reaches the existing error path untouched, so this changes one status and
 * nothing else.
 *
 * BODY OWNERSHIP: the body is read here ONLY on a 429 (to classify it). A
 * response returned to the caller therefore always has its body unread, which is
 * what the callers' `await res.text()` error paths assume. A 429 we give up on
 * never comes back as a response — it is thrown as a RateLimitError whose message
 * is already the finished sentence — so no caller is ever handed a response whose
 * body this consumed.
 */
export async function* sendWithRateLimitRetry(
  send: () => Promise<Response>,
  opts: { model: string; label: string; signal: AbortSignal; onActivity?: () => void },
): AsyncGenerator<AgentEvent, Response> {
  const maxRetries = rateLimitMaxRetries();
  const budgetMs = rateLimitMaxTotalWaitMs();
  let spentMs = 0;
  let attempts = 0;

  for (;;) {
    const res = await send();
    if (res.status !== 429) return res;

    // 429 — from here the body belongs to us.
    //
    // An UNREADABLE body is not an empty one (#796). Both leave us without the
    // provider's explanation, but they support different sentences: "it did not
    // say how long to wait" is a claim about what the provider sent, and making
    // it about a body we failed to read would be a confident wrong answer. The
    // headers survive either way, so a Retry-After still yields a real retry.
    const read = await res
      .text()
      .then((text) => ({ readable: true, text }))
      .catch(() => ({ readable: false, text: "" }));
    const verdict = classifyRateLimit(res.status, res.headers, read.text) ?? { kind: "unknown" as const };
    const waitMs = verdict.retryAfterMs;

    const outOfAttempts = attempts >= maxRetries;
    const overBudget = typeof waitMs === "number" && spentMs + waitMs > budgetMs;
    const retryable = verdict.kind === "retryable" && typeof waitMs === "number";

    if (!retryable || outOfAttempts || overBudget) {
      const why =
        verdict.kind === "quota"
          ? "quota exhausted"
          : outOfAttempts
            ? `out of retries after ${attempts}`
            : overBudget
              ? `window ${humanWait(waitMs ?? 0)} would exceed the ${humanWait(budgetMs)} budget`
              : read.readable
                ? "no retry window given"
                : "response body unreadable";
      logger.warn(`[${opts.label}] 429 from ${opts.model}, not retrying (${why})`);
      throw new RateLimitError(
        gaveUpNotice(opts.model, verdict, attempts, read.readable),
        verdict.kind,
        waitMs,
      );
    }

    attempts += 1;
    spentMs += waitMs;
    logger.info(
      `[${opts.label}] 429 from ${opts.model} — waiting ${humanWait(waitMs)} (attempt ${attempts}/${maxRetries}, ${humanWait(spentMs)} of ${humanWait(budgetMs)} spent)`,
    );
    if (waitMs >= rateLimitAnnounceMs()) {
      yield {
        type: "rate_limit",
        kind: verdict.kind,
        resetsAt: Date.now() + waitMs,
        retryInMs: waitMs,
        message: retryingNotice(opts.model, waitMs, verdict),
      };
    }
    // The turn watchdog must keep seeing life: this IS the request making
    // progress, and a silent 20s would otherwise read like a stalled backend.
    opts.onActivity?.();
    await sleep(waitMs, opts.signal);
    opts.onActivity?.();
  }
}
