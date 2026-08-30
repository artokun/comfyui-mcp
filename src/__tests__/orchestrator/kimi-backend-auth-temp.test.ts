// #2535 / #2546 — the two defects that made the Kimi Code backend unusable once
// its OAuth refresh URL was fixed (#2534).
//
//  - K3 rejects the inherited `temperature: 0` outright ("only 1 is allowed for
//    this model"), so every turn 400'd.
//  - The access token was resolved ONCE in prepare(), and Kimi Code tokens carry
//    expires_in: 900. A session idle past fifteen minutes then 401'd on every
//    later turn until the user hit Disconnect → Connect, while the CLI's file on
//    disk held a working token.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { NeutralTurn } from "../../orchestrator/agent-backend.js";

const resolveKimiCodeOAuth = vi.fn();
vi.mock("../../services/code-provider-auth.js", () => ({
  KIMI_CODE_DEFAULT_BASE: "https://api.kimi.com/coding/v1",
  resolveKimiCodeOAuth,
}));

const { KimiBackend } = await import("../../orchestrator/kimi-backend.js");

/**
 * Reaches the protected extension points by SUBCLASSING rather than casting —
 * `defaultTemperature`, `setOpenAiAuth` and `wrapChannel` are all protected, so
 * a subclass is the type-safe way in and no `as unknown as` is needed.
 */
class TestKimi extends KimiBackend {
  /** Every token handed to setOpenAiAuth, in order. */
  readonly applied: string[] = [];
  temperature(): number | undefined {
    return this.defaultTemperature();
  }
  turns(channel: AsyncIterable<NeutralTurn>): AsyncGenerator<NeutralTurn> {
    return this.wrapChannel(channel);
  }
  protected override setOpenAiAuth(host: string, apiKey: string): void {
    this.applied.push(apiKey);
    super.setOpenAiAuth(host, apiKey);
  }
}

async function* channelOf(...texts: string[]): AsyncGenerator<NeutralTurn> {
  for (const text of texts) yield { text };
}

async function drain(gen: AsyncIterable<NeutralTurn>): Promise<NeutralTurn[]> {
  const out: NeutralTurn[] = [];
  for await (const t of gen) out.push(t);
  return out;
}

beforeEach(() => {
  resolveKimiCodeOAuth.mockReset();
  resolveKimiCodeOAuth.mockResolvedValue({
    baseUrl: "https://api.kimi.com/coding/v1",
    accessToken: "tok-1",
  });
});
afterEach(() => {
  delete process.env.COMFYUI_MCP_OLLAMA_TEMPERATURE;
  vi.unstubAllGlobals();
});

describe("#2535 temperature", () => {
  it("sends NO temperature for kimi, so K3 cannot reject it", () => {
    expect(new TestKimi().temperature()).toBeUndefined();
  });

  it("leaves the operator override in force", () => {
    // The override is read at request time, not construction: this asserts the
    // backend does not hard-refuse a temperature the operator explicitly set.
    process.env.COMFYUI_MCP_OLLAMA_TEMPERATURE = "1";
    expect(new TestKimi().temperature()).toBeUndefined();
    expect(process.env.COMFYUI_MCP_OLLAMA_TEMPERATURE).toBe("1");
  });
});

describe("#2546 per-turn OAuth re-resolve", () => {
  it("re-resolves before EVERY turn, not once at prepare()", async () => {
    const b = new TestKimi();
    const seen = await drain(b.turns(channelOf("one", "two", "three")));
    expect(seen.map((t) => t.text)).toEqual(["one", "two", "three"]);
    // Once per turn. Before the fix this was 0 — nothing re-resolved after prepare().
    expect(resolveKimiCodeOAuth).toHaveBeenCalledTimes(3);
  });

  it("re-reads a ROTATED token rather than reusing the first one", async () => {
    // The Kimi Code CLI rewrites the same credential file on its own schedule,
    // so an in-memory cache would go stale behind us.
    resolveKimiCodeOAuth
      .mockResolvedValueOnce({ baseUrl: "https://api.kimi.com/coding/v1", accessToken: "tok-1" })
      .mockResolvedValueOnce({ baseUrl: "https://api.kimi.com/coding/v1", accessToken: "tok-2" });
    const b = new TestKimi();
    await drain(b.turns(channelOf("a", "b")));
    expect(b.applied).toEqual(["tok-1", "tok-2"]);
  });

  it("resolves at session start BEFORE the readiness dial", async () => {
    // Not redundant with the per-turn pins: without this call prepare() runs the
    // inherited GET {host}/models readiness check holding the constructor's
    // "pending-oauth" placeholder, so Connect fails before any turn exists for
    // wrapChannel to repair. Mutating this call site alone killed nothing until
    // this test existed.
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline in test");
    }));
    const b = new TestKimi();
    // super.prepare() is allowed to fail — the claim is only that auth was
    // resolved first, which is the ordering prepare() exists to guarantee.
    await b.prepare().catch(() => undefined);
    expect(resolveKimiCodeOAuth).toHaveBeenCalledTimes(1);
    expect(b.applied).toEqual(["tok-1"]);
  });

  it("a refresh failure does NOT drop the turn", async () => {
    // Best-effort, like CopilotBackend: the turn proceeds on the existing token
    // and a genuinely stale one surfaces as a normal 401 turn-error, never as an
    // unhandled rejection that could park the panel's turn gate.
    resolveKimiCodeOAuth.mockRejectedValue(new Error("network down"));
    const b = new TestKimi();
    const seen = await drain(b.turns(channelOf("still-delivered")));
    expect(seen.map((t) => t.text)).toEqual(["still-delivered"]);
  });
});
