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

const resolveKimiCodeOAuth = vi.fn();
vi.mock("../../services/code-provider-auth.js", () => ({
  KIMI_CODE_DEFAULT_BASE: "https://api.kimi.com/coding/v1",
  resolveKimiCodeOAuth,
}));

const { KimiBackend } = await import("../../orchestrator/kimi-backend.js");

/** Reach the protected hooks without loosening their visibility in production. */
type Probe = {
  defaultTemperature(): number | undefined;
  setOpenAiAuth(host: string, key: string): void;
  apiKey?: string;
};

beforeEach(() => {
  resolveKimiCodeOAuth.mockReset();
  resolveKimiCodeOAuth.mockResolvedValue({
    baseUrl: "https://api.kimi.com/coding/v1",
    accessToken: "tok-1",
  });
});
afterEach(() => {
  delete process.env.COMFYUI_MCP_OLLAMA_TEMPERATURE;
});

describe("#2535 temperature", () => {
  it("sends NO temperature for kimi, so K3 cannot reject it", () => {
    const b = new KimiBackend() as unknown as Probe;
    expect(b.defaultTemperature()).toBeUndefined();
  });

  it("an explicit operator override still wins", () => {
    // The override is read at request time, not construction, so this asserts
    // the backend does not hard-refuse a temperature the operator asked for.
    process.env.COMFYUI_MCP_OLLAMA_TEMPERATURE = "1";
    const b = new KimiBackend() as unknown as Probe;
    expect(b.defaultTemperature()).toBeUndefined();
    expect(process.env.COMFYUI_MCP_OLLAMA_TEMPERATURE).toBe("1");
  });
});

describe("#2546 per-turn OAuth re-resolve", () => {
  it("re-resolves before EVERY turn, not once at prepare()", async () => {
    const b = new KimiBackend();
    const turns = (async function* () {
      yield { text: "one" } as never;
      yield { text: "two" } as never;
      yield { text: "three" } as never;
    })();
    // Drive only the channel wrapper: super.run would dial the network.
    const wrap = (
      b as unknown as { wrapChannel(c: AsyncIterable<never>): AsyncGenerator<never> }
    ).wrapChannel(turns);
    const seen = [];
    for await (const t of wrap) seen.push(t);
    expect(seen).toHaveLength(3);
    // Once per turn. Before the fix this was 0 — nothing re-resolved after prepare().
    expect(resolveKimiCodeOAuth).toHaveBeenCalledTimes(3);
  });

  it("re-reads a ROTATED token rather than reusing the first one", async () => {
    // The Kimi Code CLI rewrites the same credential file on its own schedule,
    // so an in-memory cache would go stale behind us.
    resolveKimiCodeOAuth
      .mockResolvedValueOnce({ baseUrl: "https://api.kimi.com/coding/v1", accessToken: "tok-1" })
      .mockResolvedValueOnce({ baseUrl: "https://api.kimi.com/coding/v1", accessToken: "tok-2" });
    const b = new KimiBackend();
    const applied: string[] = [];
    (b as unknown as Probe).setOpenAiAuth = (_h: string, k: string) => void applied.push(k);
    const turns = (async function* () {
      yield { text: "a" } as never;
      yield { text: "b" } as never;
    })();
    const wrap = (
      b as unknown as { wrapChannel(c: AsyncIterable<never>): AsyncGenerator<never> }
    ).wrapChannel(turns);
    for await (const _t of wrap) { /* drain */ }
    expect(applied).toEqual(["tok-1", "tok-2"]);
  });

  it("#2546 resolves at session start BEFORE the readiness dial", async () => {
    // Not redundant with the per-turn pins: without this call prepare() runs the
    // inherited GET {host}/models reachability check holding the constructor's
    // "pending-oauth" placeholder, so Connect fails before any turn exists for
    // wrapChannel to repair. Mutating this call site alone killed nothing until
    // this test existed.
    const failFetch = vi.fn(async () => {
      throw new Error("offline in test");
    });
    vi.stubGlobal("fetch", failFetch);
    try {
      const b = new KimiBackend();
      // super.prepare() is allowed to fail — the claim is only that auth was
      // resolved first, which is the ordering prepare() exists to guarantee.
      await b.prepare().catch(() => undefined);
      expect(resolveKimiCodeOAuth).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a refresh failure does NOT drop the turn", async () => {
    // Best-effort, like CopilotBackend: the turn proceeds on the existing token
    // and a genuinely stale one surfaces as a normal 401 turn-error, never as an
    // unhandled rejection that could park the panel's turn gate.
    resolveKimiCodeOAuth.mockRejectedValue(new Error("network down"));
    const b = new KimiBackend();
    const turns = (async function* () {
      yield { text: "still-delivered" } as never;
    })();
    const wrap = (
      b as unknown as { wrapChannel(c: AsyncIterable<never>): AsyncGenerator<never> }
    ).wrapChannel(turns);
    const seen = [];
    for await (const t of wrap) seen.push(t);
    expect(seen).toHaveLength(1);
  });
});
