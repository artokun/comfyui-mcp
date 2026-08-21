// Coverage for the panel-bridge OAuth handlers (oauth_begin/status/signout) —
// unit-tested directly against the exported, deps-injected functions so no
// live bridge socket, network, or filesystem is needed. Mirrors the injected-
// ctx style of src/__tests__/orchestrator/panel-tools.test.ts.

import { describe, expect, it, vi } from "vitest";
import {
  handleOAuthBegin,
  handleOAuthStatus,
  handleOAuthSignout,
  type OAuthBridgeDeps,
} from "../../orchestrator/oauth-bridge.js";
import type { OAuthProviderConfig, OAuthTokens } from "../../services/oauth-flow.js";
import type { OAuthStatusRecord } from "../../services/panel-secrets.js";

const CODEX: OAuthProviderConfig = {
  id: "codex",
  label: "ChatGPT",
  kind: "loopback_pkce",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  clientId: "client-codex",
  scopes: ["openid"],
  tokenFile: "/tmp/codex-auth.json",
  apiHostAllowlist: ["auth.openai.com"],
};

const COPILOT: OAuthProviderConfig = {
  id: "copilot",
  label: "GitHub Copilot",
  kind: "device_code",
  authorizeUrl: "",
  tokenUrl: "https://github.com/login/oauth/access_token",
  deviceCodeUrl: "https://github.com/login/device/code",
  clientId: "client-copilot",
  scopes: ["read:user"],
  tokenFile: "/tmp/copilot-auth.json",
  apiHostAllowlist: ["github.com"],
  experimental: true,
};

const PROVIDERS: Record<string, OAuthProviderConfig> = { codex: CODEX, copilot: COPILOT };

const FAKE_TOKENS: OAuthTokens = { access_token: "unused-in-test", raw: {} };

describe("handleOAuthBegin", () => {
  it("unknown provider → error", async () => {
    await expect(
      handleOAuthBegin({ provider: "bogus" }, { providers: PROVIDERS }),
    ).rejects.toThrow(/unknown oauth provider/i);
  });

  it("refuses an experimental provider (copilot) without allow_experimental", async () => {
    const beginDeviceCode = vi.fn();
    await expect(
      handleOAuthBegin({ provider: "copilot" }, { providers: PROVIDERS, beginDeviceCode }),
    ).rejects.toThrow(/experimental/i);
    expect(beginDeviceCode).not.toHaveBeenCalled();
  });

  it("device provider (copilot) with allow_experimental:true returns {mode:'device', user_code}", async () => {
    const beginDeviceCode = vi.fn().mockResolvedValue({
      user_code: "ABCD-1234",
      verification_url: "https://github.com/login/device",
      device_code: "dev-code-xyz",
      interval: 5,
      expires_in: 900,
    });
    // Never resolves during the test — proves the poll runs in the background
    // and does not block the oauth_begin reply.
    const pollDeviceToken = vi.fn().mockReturnValue(new Promise<OAuthTokens>(() => {}));
    const persistOAuthResult = vi.fn();

    const result = await handleOAuthBegin(
      { provider: "copilot", allow_experimental: true },
      { providers: PROVIDERS, beginDeviceCode, pollDeviceToken, persistOAuthResult },
    );

    expect(result).toEqual({
      provider: "copilot",
      mode: "device",
      user_code: "ABCD-1234",
      verification_url: "https://github.com/login/device",
    });
    expect(beginDeviceCode).toHaveBeenCalledWith(COPILOT, {});
    expect(pollDeviceToken).toHaveBeenCalledWith(COPILOT, "dev-code-xyz", {});
    // The reply must never carry token material.
    expect(JSON.stringify(result)).not.toMatch(/access_token|refresh_token/);
  });

  it("loopback provider (codex) returns {mode:'loopback', opened:true} immediately, then persists + notifies on completion", async () => {
    let resolveFlow!: (t: OAuthTokens) => void;
    const runLoopbackPKCE = vi.fn(
      () =>
        new Promise<OAuthTokens>((resolve) => {
          resolveFlow = resolve;
        }),
    );
    const persistOAuthResult = vi.fn().mockResolvedValue({ account_label: "user@example.com" });
    const onAuthChanged = vi.fn();

    const result = await handleOAuthBegin(
      { provider: "codex" },
      { providers: PROVIDERS, runLoopbackPKCE, persistOAuthResult, onAuthChanged },
    );

    expect(result).toEqual({ provider: "codex", mode: "loopback", opened: true });
    expect(onAuthChanged).not.toHaveBeenCalled(); // flow hasn't completed yet

    resolveFlow(FAKE_TOKENS);
    // Let the background .then() chain flush.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(persistOAuthResult).toHaveBeenCalledWith("codex", FAKE_TOKENS, {});
    expect(onAuthChanged).toHaveBeenCalledWith("codex");
  });

  it("reports a background flow failure via onBackgroundError, without rejecting the outer call again", async () => {
    const runLoopbackPKCE = vi.fn().mockRejectedValue(new Error("state mismatch"));
    const onBackgroundError = vi.fn();

    const result = await handleOAuthBegin(
      { provider: "codex" },
      { providers: PROVIDERS, runLoopbackPKCE, onBackgroundError },
    );
    expect(result).toEqual({ provider: "codex", mode: "loopback", opened: true });

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(onBackgroundError).toHaveBeenCalledWith("codex", "state mismatch");
  });
});

describe("handleOAuthStatus", () => {
  it("returns {providers: readOAuthStatus()} — status only, no token fields", () => {
    const records: OAuthStatusRecord[] = [
      { provider: "codex", account_label: "user@example.com", obtained_at: 1000 },
    ];
    const readOAuthStatus = vi.fn().mockReturnValue(records);
    const result = handleOAuthStatus({}, { readOAuthStatus });
    expect(result).toEqual({ providers: records });
    expect(JSON.stringify(result)).not.toMatch(/access_token|refresh_token|id_token/);
  });
});

describe("handleOAuthSignout", () => {
  it("unknown provider → error, clearOAuth never called", () => {
    const clearOAuth = vi.fn();
    expect(() =>
      handleOAuthSignout({ provider: "bogus" }, { providers: PROVIDERS, clearOAuth }),
    ).toThrow(/unknown oauth provider/i);
    expect(clearOAuth).not.toHaveBeenCalled();
  });

  it("clears the provider and notifies onAuthChanged, returning {ok:true}", () => {
    const clearOAuth = vi.fn();
    const onAuthChanged = vi.fn();
    const result = handleOAuthSignout(
      { provider: "codex" },
      { providers: PROVIDERS, clearOAuth, onAuthChanged },
    );
    expect(result).toEqual({ ok: true, provider: "codex" });
    expect(clearOAuth).toHaveBeenCalledWith("codex", {});
    expect(onAuthChanged).toHaveBeenCalledWith("codex");
  });

  it("echoes the provider so the panel can correlate the ack to the right row", () => {
    // Two providers cleared in succession must each return their OWN id — this
    // is what lets the panel route overlapping acks correctly (Fix 1a).
    const codexResult = handleOAuthSignout({ provider: "codex" }, { providers: PROVIDERS, clearOAuth: vi.fn() });
    const copilotResult = handleOAuthSignout({ provider: "copilot" }, { providers: PROVIDERS, clearOAuth: vi.fn() });
    expect(codexResult.provider).toBe("codex");
    expect(copilotResult.provider).toBe("copilot");
  });
});

// deps type sanity — keeps the injected-deps surface honest at compile time: the
// exact object the tests above inject must satisfy the deps contract.
({ providers: PROVIDERS, clearOAuth: vi.fn() }) satisfies OAuthBridgeDeps;
