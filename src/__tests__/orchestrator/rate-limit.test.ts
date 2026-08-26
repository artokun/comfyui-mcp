// 429, and what a turn does about it.
//
// The reported failure: kimi-k3 returned `429 … organization max RPM: 3, please
// try again after 1 seconds` FOUR tool rounds into a turn, and the turn died —
// with the provider's raw envelope, account id included, pasted into the chat.
// Three separate things had to be true for that, and each gets a case here: the
// wait was never read, the retry never happened, and the body was never
// sanitized.

import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../orchestrator/agent-backend.js";
import {
  RateLimitError,
  asRateLimitError,
  classifyRateLimit,
  humanWait,
  gaveUpNotice,
  sanitizeDetail,
  sendWithRateLimitRetry,
} from "../../orchestrator/rate-limit.js";

const h = (init: Record<string, string> = {}) => new Headers(init);

/** The exact body from the bug report, account identifiers and all. */
const KIMI_429 = JSON.stringify({
  error: {
    message:
      "Your account org-7df23a26037240f88f967fb1c64d8e3f<cak-fc91zq3o4h0b111bug391> request reached organization max RPM: 3, please try again after 1 seconds",
    type: "rate_limit_reached_error",
  },
});

describe("classifyRateLimit", () => {
  it("is silent on anything that is not a 429", () => {
    // The module owns ONE status. A 500 or a 400 must reach each backend's
    // existing error path untouched, or this becomes a rewrite of every failure.
    expect(classifyRateLimit(200, h(), "")).toBeNull();
    expect(classifyRateLimit(400, h(), "rate limit")).toBeNull();
    expect(classifyRateLimit(500, h(), "")).toBeNull();
    expect(classifyRateLimit(402, h(), "insufficient_quota")).toBeNull();
  });

  it("reads the wait out of the provider's prose (the reported case)", () => {
    const v = classifyRateLimit(429, h(), KIMI_429);
    expect(v?.kind).toBe("retryable");
    expect(v?.retryAfterMs).toBe(1000);
  });

  it("sanitizes a high-vowel labeled bare id in fallback detail", () => {
    const v = classifyRateLimit(
      429,
      h(),
      JSON.stringify({ error: { message: "account qavexidopulnertiskym is limited" } }),
    );
    expect(v?.detail).toBe("account <redacted> is limited");
  });

  it("prefers Retry-After over the prose, in seconds or as a date", () => {
    expect(classifyRateLimit(429, h({ "retry-after": "20" }), KIMI_429)?.retryAfterMs).toBe(20_000);
    const soon = new Date(Date.now() + 30_000).toUTCString();
    const ms = classifyRateLimit(429, h({ "retry-after": soon }), "")?.retryAfterMs ?? 0;
    expect(ms).toBeGreaterThan(25_000);
    expect(ms).toBeLessThanOrEqual(30_000);
  });

  it("never returns a NEGATIVE wait from a Retry-After date in the past", () => {
    // Some limiters send the window's start. A negative sleep would silently
    // become an instant retry — the one thing a 429 asked us not to do.
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(classifyRateLimit(429, h({ "retry-after": past }), "")?.retryAfterMs).toBe(0);
  });

  it("falls back to the OpenAI-style reset counters", () => {
    expect(classifyRateLimit(429, h({ "x-ratelimit-reset-requests": "6m0s" }), "")?.retryAfterMs).toBe(360_000);
    expect(classifyRateLimit(429, h({ "x-ratelimit-reset-tokens": "500ms" }), "")?.retryAfterMs).toBe(500);
  });

  it("does not mistake a non-duration header for a wait", () => {
    // "3 requests" parses as "3" under a lax reader, and a 3ms backoff against a
    // per-minute limiter is a retry storm.
    const v = classifyRateLimit(429, h({ "x-ratelimit-reset-requests": "3 requests" }), "");
    expect(v?.kind).toBe("unknown");
    expect(v?.retryAfterMs).toBeUndefined();
  });

  it("calls an exhausted quota QUOTA even when a retry window came with it", () => {
    // Both OpenAI and moonshot answer an empty balance with a 429 that still
    // carries a hint. Honouring it would sleep, retry, and fail identically.
    const v = classifyRateLimit(
      429,
      h({ "retry-after": "5" }),
      JSON.stringify({ error: { message: "You exceeded your current quota", type: "insufficient_quota" } }),
    );
    expect(v?.kind).toBe("quota");
  });

  it("does not quote the provider's retry instruction back at the user", () => {
    // We already obeyed it — the wait was parsed out of this very sentence. Left
    // in, it reads as a contradiction beside the outcome ("did not recover after
    // 3 attempts … please try again after 1 seconds").
    const v = classifyRateLimit(429, h(), KIMI_429);
    expect(v?.detail).not.toMatch(/try again/i);
    // …and the part the user cannot learn any other way survives.
    expect(v?.detail).toContain("max RPM: 3");
  });

  it("reports a 429 with no readable window as unknown, not as a guess", () => {
    const v = classifyRateLimit(429, h(), "Too Many Requests");
    expect(v?.kind).toBe("unknown");
    expect(v?.retryAfterMs).toBeUndefined();
  });

  it("ignores an HTML block page instead of quoting it at the user", () => {
    const v = classifyRateLimit(429, h(), "<html><body><h1>429 Too Many Requests</h1></body></html>");
    expect(v?.kind).toBe("unknown");
    expect(v?.detail).toBeUndefined();
  });
});

describe("sanitizeDetail", () => {
  it("strips the account identifiers the reported error published", () => {
    const out = sanitizeDetail(JSON.parse(KIMI_429).error.message);
    expect(out).not.toContain("org-7df23a26037240f88f967fb1c64d8e3f");
    expect(out).not.toContain("cak-fc91zq3o4h0b111bug391");
    // …while keeping the part that explains the limit, which is why the message
    // is shown at all.
    expect(out).toContain("max RPM: 3");
  });

  it("masks identifier SHAPES, not a list of known vendor prefixes", () => {
    // The next provider's prefix is not in any list we could have written.
    const out = sanitizeDetail("workspace wsp_9f8e7d6c5b4a3f2e1d0c and key sk-abcdefghijklmnop are limited");
    expect(out).not.toContain("9f8e7d6c5b4a3f2e1d0c");
    expect(out).not.toContain("abcdefghijklmnop");
  });

  it("redacts an identifier that has no digit in it at all", () => {
    // The reported case. 22 alphabetic characters, no separator, no digit.
    const alpha = sanitizeDetail("account abcdefghijklmnopqrstuv is limited");
    expect(alpha).not.toContain("abcdefghijklmnopqrstuv");
    expect(alpha).toContain("is limited");

    // The control that made the hole visible: the SAME string with its last
    // character changed to a digit was already redacted. Both must behave alike —
    // whether a vendor happened to mint an id with a digit in it is not a
    // property of how secret the id is.
    const digit = sanitizeDetail("account abcdefghijklmnopqrstu9 is limited");
    expect(digit).not.toContain("abcdefghijklmnopqrstu9");

    // …and it must not depend on a label sitting in front of the id, either. An
    // id is redacted for its shape, not for the word that happens to precede it.
    for (const sentence of [
      "rate limit reached for abcdefghijklmnopqrstuv",
      "the tenant abcdefghijklmnopqrstuv exceeded its quota",
      "your plan abcdefghijklmnopqrstuv has no credits",
      "rate limited (abcdefghijklmnopqrstuv)",
    ]) {
      expect(sanitizeDetail(sentence)).not.toContain("abcdefghijklmnopqrstuv");
    }
  });

  it("redacts low-diversity all-alphabetic account identifiers", () => {
    expect(sanitizeDetail("account aeiouaeiouaeiouaeiou is limited")).toBe("account <redacted> is limited");
  });

  it("redacts all-alphabetic identifiers with structured labels", () => {
    expect(sanitizeDetail("account_id=abcdefghijklmnopqrstuv")).toBe("account_id=<redacted>");
    expect(sanitizeDetail("user_id qavexidopulnertiskym is limited")).toBe("user_id <redacted> is limited");
  });

  it("redacts user-labeled identifiers for terminal statuses", () => {
    for (const label of ["user", "the user", "your user"]) {
      for (const status of ["disabled", "blocked", "expired"]) {
        expect(sanitizeDetail(`${label} abcdefghijklmnopqrstuv is ${status}`)).toBe(
          `${label} <redacted> is ${status}`,
        );
      }
    }
  });

  it("redacts punctuation-wrapped and bracketed labels", () => {
    expect(sanitizeDetail("account: abcdefghijklmnopqrstuv is limited")).toBe(
      "account: <redacted> is limited",
    );
    expect(sanitizeDetail("account (abcdefghijklmnopqrstuv) is limited")).toBe(
      "account (<redacted>) is limited",
    );
    expect(sanitizeDetail("account: [abcdefghijklmnopqrstuv] is limited")).toBe(
      "account: [<redacted>] is limited",
    );
    expect(sanitizeDetail("account=[abcdefghijklmnopqrstuv]")).toBe("account=[<redacted>]");
    expect(sanitizeDetail("user: [abcdefghijklmnopqrstuv] is disabled")).toBe(
      "user: [<redacted>] is disabled",
    );
    expect(sanitizeDetail("account_id=[abcdefghijklmnopqrstuv]")).toBe("account_id=[<redacted>]");
  });

  it("redacts a hyphen-attached identifier atomically", () => {
    expect(sanitizeDetail("account qavexidopulnertiskym-extra-more is limited")).toBe(
      "account <redacted> is limited",
    );
    expect(sanitizeDetail("account qavexidopulnertiskymtion is limited")).toBe(
      "account <redacted> is limited",
    );
    expect(sanitizeDetail("account qavexidopulnertisktion is limited")).toBe(
      "account <redacted> is limited",
    );
    expect(sanitizeDetail("account qavexidopulnertiskymaeiotion is limited")).toBe(
      "account <redacted> is limited",
    );
    expect(sanitizeDetail("account qavexidopulnertiskym_extra_more is limited")).toBe(
      "account <redacted> is limited",
    );
    expect(sanitizeDetail("account qavexidopulnertiskym--extra--more is limited")).toBe(
      "account <redacted> is limited",
    );
    expect(sanitizeDetail("wrapper_qavexidopulnertiskym_suffix")).toBe("wrapper_<redacted>");
    expect(sanitizeDetail("wrapper--qavexidopulnertiskym--suffix")).toBe("wrapper--<redacted>");
  });

  it("redacts punctuation, hyphen labels, and composite labels atomically", () => {
    expect(sanitizeDetail("account, abcdefghijklmnopqrstuv")).toBe("account, <redacted>");
    expect(sanitizeDetail("account.abcdefghijklmnopqrstuv")).toBe("account.<redacted>");
    expect(sanitizeDetail("account!abcdefghijklmnopqrstuv")).toBe("account!<redacted>");
    expect(sanitizeDetail("account?abcdefghijklmnopqrstuv")).toBe("account?<redacted>");
    expect(sanitizeDetail("account--abcdefghijklmnopqrstuv")).toBe("account--<redacted>");
    expect(sanitizeDetail("account-[abcdefghijklmnopqrstuv]")).toBe("account-[<redacted>]");
    expect(sanitizeDetail("account_[abcdefghijklmnopqrstuv]")).toBe("account_[<redacted>]");
    expect(sanitizeDetail("the-user-abcdefghijklmnopqrstuv")).toBe("the-user-<redacted>");
    expect(sanitizeDetail("the-user_abcdefghijklmnopqrstuv")).toBe("the-user_<redacted>");
    expect(sanitizeDetail("your-user-abcdefghijklmnopqrstuv")).toBe("your-user-<redacted>");
    expect(sanitizeDetail("your-user_abcdefghijklmnopqrstuv")).toBe("your-user_<redacted>");
    expect(sanitizeDetail("account_abcdefghijklmnopqrstuv")).toBe("account_<redacted>");
    expect(sanitizeDetail("user_abcdefghijklmnopqrstuv")).toBe("user_<redacted>");
    expect(sanitizeDetail("account_identifier_abcdefghijklmnopqrstuv")).toBe(
      "account_identifier_<redacted>",
    );
    expect(sanitizeDetail("account_identifier_[abcdefghijklmnopqrstuv]")).toBe(
      "account_identifier_[<redacted>]",
    );
    expect(sanitizeDetail("account_identifier-abcdefghijklmnopqrstuv")).toBe(
      "account_identifier-<redacted>",
    );
    expect(sanitizeDetail("account_identifier=abcdefghijklmnopqrstuv")).toBe(
      "account_identifier=<redacted>",
    );
  });

  it("leaves long ordinary prose words readable", () => {
    expect(sanitizeDetail("account compartmentalization policy")).toBe("account compartmentalization policy");
    expect(sanitizeDetail("the user uncharacteristically exceeded the limit")).toBe(
      "the user uncharacteristically exceeded the limit",
    );
    expect(sanitizeDetail("account compartmentalization is limited")).toBe(
      "account compartmentalization is limited",
    );
    expect(sanitizeDetail("account: compartmentalization policy")).toBe("account: compartmentalization policy");
    expect(sanitizeDetail("the user: uncharacteristically exceeded")).toBe(
      "the user: uncharacteristically exceeded",
    );
    expect(sanitizeDetail("user-uncharacteristically")).toBe("user-uncharacteristically");
    expect(sanitizeDetail("account-compartmentalization")).toBe("account-compartmentalization");
    expect(sanitizeDetail("user_uncharacteristically")).toBe("user_uncharacteristically");
    expect(sanitizeDetail("account_compartmentalization")).toBe("account_compartmentalization");
    expect(sanitizeDetail("account compartmentalization_v2 is limited")).toBe(
      "account compartmentalization_v2 is limited",
    );
  });

  it("leaves an ordinary sentence readable", () => {
    const out = sanitizeDetail("Rate limit reached for gpt-4o in organization on requests per min (RPM): Limit 500");
    expect(out).toContain("requests per min");
    expect(out).toContain("Limit 500");

    // The other half of #2313. Dropping the digit requirement widened the bare-run
    // rule, and the whole point of showing a 429 is the explanation — so the
    // explanations have to keep arriving intact. None of these contains an
    // unbroken 20-character run, because sentences have spaces in them.
    for (const sentence of [
      "organization requests per minute exceeded",
      "You exceeded your current quota, please check your plan and billing details.",
      "Your credit balance is too low to access the API.",
      "request reached organization max RPM: 3, please try again after 1 seconds",
      "Too many concurrent requests. Reduce concurrency and retry.",
      "Free tier limit reached. Upgrade your plan at the billing dashboard to continue.",
    ]) {
      expect(sanitizeDetail(sentence)).not.toContain("<redacted>");
    }

    // The threshold is bracketed from BOTH sides on purpose. The case above pins
    // it at or below 22 characters (a 22-character id must vanish); this pins it
    // above 18, so nobody "hardens" the rule down into ordinary long words.
    expect(sanitizeDetail("this request was disproportionately large")).toContain("disproportionately");
  });

  it("redacts an email address", () => {
    expect(sanitizeDetail("quota for art@example.com exhausted")).not.toContain("art@example.com");
  });

  it("masks a long email local part as one address", () => {
    expect(sanitizeDetail("quota for abcdefghijklmnopqrstuv@example.com exhausted")).toBe(
      "quota for <redacted> exhausted",
    );
  });

  // Hyphens defeated both shape rules: the longest unbroken run inside a UUID is 12
  // characters, so the bare-run rule (20+) never fired, and the prefixed rule matched
  // only the TAIL. The second case below is the dangerous one — it used to come back as
  // "550e8400-e29b-41d4-a716-<redacted>", which READS as sanitized while 24 of its 36
  // characters shipped. Nobody re-checks a redaction that already looks done.
  it("redacts a UUID-shaped account id whole, with or without a vendor prefix", () => {
    const prefixed = sanitizeDetail("org-12345678-1234-1234-1234-123456789012 reached its limit");
    expect(prefixed).not.toContain("12345678");
    expect(prefixed).not.toContain("123456789012");
    expect(prefixed).toContain("org-");

    const bare = sanitizeDetail("account 550e8400-e29b-41d4-a716-446655440000 limit");
    // No FRAGMENT survives — asserting only on the full string would pass on the partial.
    for (const part of ["550e8400", "e29b", "41d4", "a716", "446655440000"]) {
      expect(bare).not.toContain(part);
    }
    expect(bare).toContain("account");

    // Gate round 2: a prefix GLUED to the uuid with no separator slipped past the
    // optional-prefix group and left the same misleading partial one layer down.
    const glued = sanitizeDetail("org550e8400-e29b-41d4-a716-446655440000 hit its cap");
    for (const part of ["org550e8400", "550e8400", "e29b", "41d4", "a716", "446655440000"]) {
      expect(glued).not.toContain(part);
    }
    expect(glued).toContain("hit its cap");
    expect(bare).toContain("limit");
  });

  it("still leaves hyphenated prose and header names alone", () => {
    // The UUID rule is shape-specific on purpose: widening it to any hyphenated run
    // would eat the parts of a 429 that explain the limit, which is why it is shown.
    const out = sanitizeDetail("rate limit exceeded; see x-ratelimit-reset-requests");
    expect(out).toContain("x-ratelimit-reset-requests");
  });
});

describe("gaveUpNotice", () => {
  // agent-backend.ts documents `outcomeUnknown` as "renderers must NOT add the generic
  // 'Nothing was lost — try again' prompt", and codex-backend.ts calls that phrase unsafe
  // "when a mutation's dispatch/outcome was not established". A 429 mid tool-loop is that
  // case: this module exists because completed tool rounds were being discarded, which
  // means they RAN. Promising nothing was lost invites re-sending a prompt whose earlier
  // steps already changed the graph.
  it("never tells the user nothing was lost", () => {
    const cases = [
      gaveUpNotice("m", { kind: "unknown", detail: "slow down" }, 0),
      gaveUpNotice("m", { kind: "unknown", detail: "slow down" }, 2),
      gaveUpNotice("m", { kind: "unknown" }, 0, false),
    ];
    for (const line of cases) {
      expect(line).not.toMatch(/nothing was lost/i);
      // …and says the thing that replaces it, so this is not satisfied by an empty string.
      expect(line).toMatch(/re-sending runs those steps again/i);
    }
  });

  it("still names the model and the remedy", () => {
    const line = gaveUpNotice("kimi-k3", { kind: "unknown", detail: "max RPM: 3" }, 0);
    expect(line).toContain("kimi-k3");
    expect(line).toContain("max RPM: 3");
    expect(line).toContain("composer picker");
  });

  it("a quota wall keeps its own remedy AND still warns the turn stopped part-way", () => {
    // Gate round 3: the partial-turn warning was added to the two retryable branches and
    // not to this one. A quota 429 arrives at the same point in the tool loop and leaves
    // the same half-applied graph — and this branch actively tells the user to top up and
    // resend, so it is the branch where the omission does the most damage.
    const line = gaveUpNotice("m", { kind: "quota", detail: "out of credit" }, 0);
    expect(line).toMatch(/Retrying will not help/i);
    expect(line).not.toMatch(/nothing was lost/i);
    expect(line).toMatch(/check the canvas before you resend/i);
  });
});

describe("humanWait", () => {
  it("reads as a duration a person would say", () => {
    expect(humanWait(900)).toBe("900ms");
    expect(humanWait(1000)).toBe("1s");
    expect(humanWait(20_000)).toBe("20s");
    expect(humanWait(150_000)).toBe("2m30s");
    expect(humanWait(120_000)).toBe("2m");
  });
});

/** A send() that answers with the queued statuses, then 200 forever. */
function scriptedSend(responses: Array<{ status: number; body?: string; headers?: Record<string, string> }>) {
  const calls: number[] = [];
  let i = 0;
  const send = async (): Promise<Response> => {
    calls.push(Date.now());
    const spec = responses[i] ?? { status: 200 };
    i += 1;
    return new Response(spec.body ?? "", { status: spec.status, headers: spec.headers });
  };
  return { send, sent: () => i, calls };
}

async function drain(gen: AsyncGenerator<AgentEvent, Response>): Promise<{ events: AgentEvent[]; res: Response }> {
  const events: AgentEvent[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, res: step.value };
    events.push(step.value);
  }
}

describe("sendWithRateLimitRetry", () => {
  const opts = () => ({ model: "kimi-k3", label: "test-backend", signal: new AbortController().signal });

  it("waits out the reported one-second window and lets the turn continue", async () => {
    vi.useFakeTimers();
    try {
      const { send, sent } = scriptedSend([{ status: 429, body: KIMI_429 }]);
      const run = drain(sendWithRateLimitRetry(send, opts()));
      await vi.advanceTimersByTimeAsync(1000);
      const { events, res } = await run;
      expect(res.status).toBe(200);
      expect(sent()).toBe(2); // the 429, then the retry that worked
      // A one-second wait is invisible to the user; announcing it would be noise
      // about a non-event.
      expect(events).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("announces a wait long enough to look like a hang", async () => {
    vi.useFakeTimers();
    try {
      const { send } = scriptedSend([{ status: 429, headers: { "retry-after": "20" }, body: KIMI_429 }]);
      const run = drain(sendWithRateLimitRetry(send, opts()));
      await vi.advanceTimersByTimeAsync(20_000);
      const { events, res } = await run;
      expect(res.status).toBe(200);
      expect(events).toHaveLength(1);
      const ev = events[0];
      expect(ev.type).toBe("rate_limit");
      if (ev.type !== "rate_limit") throw new Error("unreachable");
      expect(ev.retryInMs).toBe(20_000);
      expect(ev.message).toContain("kimi-k3");
      expect(ev.message).toContain("20s");
      // The line a user reads must not carry what the body carried.
      expect(ev.message).not.toContain("org-7df23a26037240f88f967fb1c64d8e3f");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands back every other status untouched, body unread", async () => {
    // The callers' error paths all do `await res.text()`. Consuming the body
    // here would turn their messages into empty strings.
    const { send, sent } = scriptedSend([{ status: 500, body: "upstream exploded" }]);
    const { events, res } = await drain(sendWithRateLimitRetry(send, opts()));
    expect(res.status).toBe(500);
    expect(sent()).toBe(1);
    expect(events).toHaveLength(0);
    expect(await res.text()).toBe("upstream exploded");
  });

  it("gives up after the retry budget and throws a finished sentence", async () => {
    vi.useFakeTimers();
    try {
      const always = Array.from({ length: 9 }, () => ({ status: 429, body: KIMI_429 }));
      const { send, sent } = scriptedSend(always);
      const run = drain(sendWithRateLimitRetry(send, opts())).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10_000);
      const err = asRateLimitError(await run);
      expect(err).toBeInstanceOf(RateLimitError);
      expect(sent()).toBe(4); // the original + 3 retries
      expect(err?.message).toContain("kimi-k3");
      expect(err?.message).toContain("3 attempts");
      expect(err?.message).not.toContain("org-7df23a26037240f88f967fb1c64d8e3f");
    } finally {
      vi.useRealTimers();
    }
  });

  it("declines a window that would blow the total-wait budget, rather than truncating it", async () => {
    // Sleeping LESS than the provider asked for is a retry we already know is
    // too early — so an over-budget window is refused outright.
    const { send, sent } = scriptedSend([{ status: 429, headers: { "retry-after": "600" }, body: "slow down" }]);
    const err = asRateLimitError(await drain(sendWithRateLimitRetry(send, opts())).catch((e: unknown) => e));
    expect(err).toBeInstanceOf(RateLimitError);
    expect(sent()).toBe(1);
  });

  it("never retries an exhausted quota, however short the window it came with", async () => {
    const body = JSON.stringify({ error: { message: "You exceeded your current quota", type: "insufficient_quota" } });
    const { send, sent } = scriptedSend([{ status: 429, headers: { "retry-after": "1" }, body }]);
    const err = asRateLimitError(await drain(sendWithRateLimitRetry(send, opts())).catch((e: unknown) => e));
    expect(sent()).toBe(1);
    expect(err?.kind).toBe("quota");
    expect(err?.message).toContain("Retrying will not help");
  });

  it("does not retry a 429 that named no window", async () => {
    const { send, sent } = scriptedSend([{ status: 429, body: "Too Many Requests" }]);
    const err = asRateLimitError(await drain(sendWithRateLimitRetry(send, opts())).catch((e: unknown) => e));
    expect(sent()).toBe(1);
    expect(err?.kind).toBe("unknown");
    expect(err?.message).toContain("did not say how long to wait");
  });

  it("does not claim the provider stayed silent when the body was unreadable", async () => {
    // #796 — an unreadable body and an empty one leave us equally uninformed, but
    // "it did not say how long to wait" is a claim about what ARRIVED.
    const send = async (): Promise<Response> =>
      new Response(new ReadableStream({ start: (c) => c.error(new Error("connection reset")) }), { status: 429 });
    const err = asRateLimitError(await drain(sendWithRateLimitRetry(send, opts())).catch((e: unknown) => e));
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err?.message).toContain("could not be read");
    expect(err?.message).not.toContain("did not say how long to wait");
  });

  it("still honours a Retry-After header when the body is unreadable", async () => {
    // The headers survive a body we could not read, so a real window is still a
    // real window — refusing to retry here would be over-caution, not caution.
    vi.useFakeTimers();
    try {
      let n = 0;
      const send = async (): Promise<Response> => {
        n += 1;
        if (n > 1) return new Response("", { status: 200 });
        return new Response(new ReadableStream({ start: (c) => c.error(new Error("reset")) }), {
          status: 429,
          headers: { "retry-after": "1" },
        });
      };
      const run = drain(sendWithRateLimitRetry(send, opts()));
      await vi.advanceTimersByTimeAsync(1000);
      expect((await run).res.status).toBe(200);
      expect(n).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("abandons the wait when the turn is interrupted", async () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      const { send, sent } = scriptedSend([{ status: 429, headers: { "retry-after": "30" }, body: "slow down" }]);
      const run = drain(sendWithRateLimitRetry(send, { ...opts(), signal: ac.signal })).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(100);
      ac.abort();
      const err = await run;
      expect(err).toBeInstanceOf(Error);
      // The retry never fired: an interrupt must not sit out a 30-second window.
      expect(sent()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the turn watchdog fed across the wait", async () => {
    // 3.5 minutes of silence trips the stall watchdog. A wait is the request
    // making progress, not a wedged backend.
    vi.useFakeTimers();
    try {
      const onActivity = vi.fn();
      const { send } = scriptedSend([{ status: 429, headers: { "retry-after": "20" }, body: "slow down" }]);
      const run = drain(sendWithRateLimitRetry(send, { ...opts(), onActivity }));
      await vi.advanceTimersByTimeAsync(20_000);
      await run;
      expect(onActivity).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
