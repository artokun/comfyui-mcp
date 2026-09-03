// Pre-merge fix (final whole-branch review, orchestrator side): the refresh
// functions in code-provider-auth.ts used to embed the raw provider HTTP
// error body in the thrown message unredacted. The refresh request body
// contains `refresh_token`, and IdPs can echo request params back in error
// bodies, so an error line could leak a live token. These tests pin that a
// leaked-looking refresh_token in the error body never survives into the
// thrown message, for all three refresh paths (Grok, Codex/OpenAI, Kimi),
// plus the adjacent "2xx but malformed JSON" path.
import { describe, expect, it, vi } from "vitest";
import { __testing } from "../../services/code-provider-auth.js";

const { refreshGrokTokens, refreshOpenAICodexTokens, refreshKimiCodeTokens } = __testing;

/** #2534 — refreshKimiCodeTokens now takes its region-resolved token URL.
 *  These tests are about REDACTION, so any valid endpoint serves; the URL
 *  itself is pinned in code-provider-auth.test.ts. */
const KIMI_TOKEN_URL = "https://auth.kimi.com/api/oauth/token";

describe("refresh error paths redact token-shaped material", () => {
  it("refreshGrokTokens: a leaked refresh_token in the error body never reaches the thrown message", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "bad", refresh_token: "LEAKED_RT_123" }), {
          status: 400,
        }),
    );

    const err = await refreshGrokTokens("some-refresh-token", {
      fetch: fetchMock as unknown as typeof fetch,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("bad");
    expect(message).not.toContain("LEAKED_RT_123");
    expect(message).toContain("<redacted>");
  });

  it("refreshGrokTokens: a 2xx-but-malformed body throws a generic error, not the raw text", async () => {
    const fetchMock = vi.fn(
      async () => new Response("not json at all refresh_token=LEAKED_RT_999", { status: 200 }),
    );

    const err = await refreshGrokTokens("some-refresh-token", {
      fetch: fetchMock as unknown as typeof fetch,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).not.toContain("LEAKED_RT_999");
    expect(message).toMatch(/malformed/i);
  });

  it("refreshOpenAICodexTokens: a leaked refresh_token in the error body never reaches the thrown message", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "bad", refresh_token: "LEAKED_RT_123" }), {
          status: 400,
        }),
    );

    const err = await refreshOpenAICodexTokens("some-refresh-token", {
      fetch: fetchMock as unknown as typeof fetch,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("bad");
    expect(message).not.toContain("LEAKED_RT_123");
    expect(message).toContain("<redacted>");
  });

  it("refreshOpenAICodexTokens: a 2xx-but-malformed body throws a generic error, not the raw text", async () => {
    const fetchMock = vi.fn(
      async () => new Response("not json at all refresh_token=LEAKED_RT_999", { status: 200 }),
    );

    const err = await refreshOpenAICodexTokens("some-refresh-token", {
      fetch: fetchMock as unknown as typeof fetch,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).not.toContain("LEAKED_RT_999");
    expect(message).toMatch(/malformed/i);
  });

  it("refreshKimiCodeTokens: a leaked refresh_token in the error body never reaches the thrown message", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "bad", refresh_token: "LEAKED_RT_123" }), {
          status: 400,
        }),
    );

    const err = await refreshKimiCodeTokens("some-refresh-token", KIMI_TOKEN_URL, {
      fetch: fetchMock as unknown as typeof fetch,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("bad");
    expect(message).not.toContain("LEAKED_RT_123");
    expect(message).toContain("<redacted>");
  });

  it("refreshKimiCodeTokens: a 2xx-but-malformed body throws a generic error, not the raw text", async () => {
    const fetchMock = vi.fn(
      async () => new Response("not json at all refresh_token=LEAKED_RT_999", { status: 200 }),
    );

    const err = await refreshKimiCodeTokens("some-refresh-token", KIMI_TOKEN_URL, {
      fetch: fetchMock as unknown as typeof fetch,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).not.toContain("LEAKED_RT_999");
    expect(message).toMatch(/malformed/i);
  });
});
