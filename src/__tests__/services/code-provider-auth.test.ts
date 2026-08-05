import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveGlmCodeCredentials,
  resolveKimiCodeOAuth,
  resolveMoonshotCredentials,
  resolveMiniMaxCredentials,
  resolveOpenAICodexOAuth,
  __testing,
} from "../../services/code-provider-auth.js";

describe("resolveGlmCodeCredentials", () => {
  const keys = ["ZAI_API_KEY", "GLM_API_KEY", "ZHIPUAI_API_KEY", "ZHIPU_API_KEY"] as const;

  afterEach(() => {
    for (const k of keys) delete process.env[k];
    delete process.env.COMFYUI_MCP_GLM_BASE_URL;
  });

  it("reads ZAI_API_KEY and default base URL", () => {
    process.env.ZAI_API_KEY = "zai-test-key";
    const creds = resolveGlmCodeCredentials();
    expect(creds.apiKey).toBe("zai-test-key");
    expect(creds.baseUrl).toBe(__testing.GLM_CODE_DEFAULT_BASE);
  });

  it("throws when no GLM key is set", () => {
    expect(() => resolveGlmCodeCredentials()).toThrow(/ZAI_API_KEY/);
  });
});

describe("resolveMoonshotCredentials", () => {
  afterEach(() => {
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.COMFYUI_MCP_MOONSHOT_BASE_URL;
  });

  it("reads MOONSHOT_API_KEY and default base URL", () => {
    process.env.MOONSHOT_API_KEY = "sk-moonshot-test";
    const creds = resolveMoonshotCredentials();
    expect(creds.apiKey).toBe("sk-moonshot-test");
    expect(creds.baseUrl).toBe(__testing.MOONSHOT_DEFAULT_BASE);
  });

  it("honors a base URL override (trailing slash stripped)", () => {
    process.env.MOONSHOT_API_KEY = "sk-moonshot-test";
    process.env.COMFYUI_MCP_MOONSHOT_BASE_URL = "https://api.moonshot.cn/v1/";
    expect(resolveMoonshotCredentials().baseUrl).toBe("https://api.moonshot.cn/v1");
  });

  it("throws when MOONSHOT_API_KEY is not set", () => {
    expect(() => resolveMoonshotCredentials()).toThrow(/MOONSHOT_API_KEY/);
  });
});

describe("resolveMiniMaxCredentials", () => {
  afterEach(() => {
    delete process.env.MINIMAX_API_KEY;
    delete process.env.COMFYUI_MCP_MINIMAX_BASE_URL;
  });

  it("reads MINIMAX_API_KEY and default base URL", () => {
    process.env.MINIMAX_API_KEY = "minimax-test-key";
    const creds = resolveMiniMaxCredentials();
    expect(creds.apiKey).toBe("minimax-test-key");
    expect(creds.baseUrl).toBe(__testing.MINIMAX_DEFAULT_BASE);
  });

  it("honors a base URL override (trailing slash stripped)", () => {
    process.env.MINIMAX_API_KEY = "minimax-test-key";
    process.env.COMFYUI_MCP_MINIMAX_BASE_URL = "https://api.minimaxi.com/v1/";
    expect(resolveMiniMaxCredentials().baseUrl).toBe("https://api.minimaxi.com/v1");
  });

  it("throws when MINIMAX_API_KEY is not set", () => {
    expect(() => resolveMiniMaxCredentials()).toThrow(/MINIMAX_API_KEY/);
  });
});

describe("resolveOpenAICodexOAuth", () => {
  let home = "";

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "codex-oauth-test-"));
  });

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("returns access token and account id from auth.json", async () => {
    const dir = join(home, ".codex");
    await mkdir(dir, { recursive: true });
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
    await writeFile(
      join(dir, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: `hdr.${payload}.sig`,
          refresh_token: "rt-1",
          account_id: "acct-123",
        },
      }),
      "utf8",
    );

    const creds = await resolveOpenAICodexOAuth({ home, now: () => Date.now() });
    expect(creds.accessToken).toMatch(/^hdr\./);
    expect(creds.accountId).toBe("acct-123");
  });
});

describe("resolveKimiCodeOAuth", () => {
  let home = "";

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kimi-oauth-test-"));
  });

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
    delete process.env.KIMI_API_KEY;
  });

  it("prefers KIMI_API_KEY when set", async () => {
    process.env.KIMI_API_KEY = "kimi-api-key";
    const creds = await resolveKimiCodeOAuth({ home });
    expect(creds.accessToken).toBe("kimi-api-key");
    expect(creds.baseUrl).toBe(__testing.KIMI_CODE_DEFAULT_BASE);
  });

  it("resolves the kimi-code CLI dir (~/.kimi-code) over the legacy ~/.kimi", async () => {
    // Regression: the port defaulted to the legacy kimi-cli path (~/.kimi); the
    // current kimi-code CLI writes to ~/.kimi-code. The resolver must find the
    // current dir first, and still fall back to the legacy dir when only it exists.
    const write = async (dir: string, token: string) => {
      const d = join(home, dir, "credentials");
      await mkdir(d, { recursive: true });
      await writeFile(
        join(d, "kimi-code.json"),
        JSON.stringify({ access_token: token, expires_at: Math.floor(Date.now() / 1000) + 3600 }),
        "utf8",
      );
    };
    // Legacy only → falls back.
    await write(".kimi", "legacy-token");
    expect((await resolveKimiCodeOAuth({ home })).accessToken).toBe("legacy-token");
    // Current present → preferred over legacy.
    await write(".kimi-code", "current-token");
    expect((await resolveKimiCodeOAuth({ home })).accessToken).toBe("current-token");
  });

  it("refreshes expired kimi-code.json tokens", async () => {
    const credDir = join(home, ".kimi-code", "credentials");
    await mkdir(credDir, { recursive: true });
    await writeFile(
      join(credDir, "kimi-code.json"),
      JSON.stringify({
        access_token: "stale",
        refresh_token: "rt-kimi",
        expires_at: Math.floor(Date.now() / 1000) - 60,
      }),
      "utf8",
    );

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "fresh-kimi",
          refresh_token: "rt-kimi-2",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const creds = await resolveKimiCodeOAuth({
      home,
      fetch: fetchMock as typeof fetch,
      now: () => Date.now(),
    });
    expect(creds.accessToken).toBe("fresh-kimi");
    expect(fetchMock).toHaveBeenCalledOnce();
    const saved = JSON.parse(await readFile(join(credDir, "kimi-code.json"), "utf8")) as {
      access_token?: string;
    };
    expect(saved.access_token).toBe("fresh-kimi");
  });
});
describe("nativeCliStatus (CLI-auth detection for oauth_status)", () => {
  let home = "";

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cli-status-test-"));
  });

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  const jwt = (claims: Record<string, unknown>) =>
    `hdr.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

  it("detects an existing codex CLI login (email from id_token, '(CLI)' suffix)", async () => {
    const dir = join(home, ".codex");
    await mkdir(dir, { recursive: true });
    const exp = Math.floor(Date.now() / 1000) + 3600;
    await writeFile(
      join(dir, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: jwt({ exp }),
          refresh_token: "rt-1",
          id_token: jwt({ email: "dev@example.com" }),
        },
      }),
    );
    const rec = __testing.nativeCliStatus("codex", home);
    expect(rec).not.toBeNull();
    expect(rec!.provider).toBe("codex");
    expect(rec!.account_label).toBe("dev@example.com (CLI)");
    // refresh token present → no expiry pinned (CLI renews indefinitely)
    expect(rec!.expires_at).toBeUndefined();
  });

  it("returns null when there is no auth file", () => {
    expect(__testing.nativeCliStatus("codex", home)).toBeNull();
  });

  it("returns null for an expired access-only token (no refresh)", async () => {
    const dir = join(home, ".codex");
    await mkdir(dir, { recursive: true });
    const exp = Math.floor(Date.now() / 1000) - 3600;
    await writeFile(
      join(dir, "auth.json"),
      JSON.stringify({ tokens: { access_token: jwt({ exp }) } }),
    );
    expect(__testing.nativeCliStatus("codex", home)).toBeNull();
  });

  it("detects flat-shape files (grok) and never returns token material", async () => {
    const dir = join(home, ".grok");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "auth.json"),
      JSON.stringify({ access_token: "opaque-token-abc", refresh_token: "rt-2" }),
    );
    const rec = __testing.nativeCliStatus("grok", home);
    expect(rec).not.toBeNull();
    expect(rec!.account_label).toBe("CLI session");
    expect(JSON.stringify(rec)).not.toContain("opaque-token-abc");
    expect(JSON.stringify(rec)).not.toContain("rt-2");
  });
});

describe("readOAuthStatus — home scoping (#859)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "cmcp-oauth-home-"));
    // The panel-secrets env override is the OTHER redirect and must stay unset
    // here: this test exists to prove the `home` ARGUMENT alone scopes the read.
    delete process.env.COMFYUI_MCP_PANEL_SECRETS;
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("reads the mirror from the injected home, not the developer's real one", async () => {
    // A provider id no real machine would have signed in. If the mirror read
    // falls through to the real home, this record is simply absent — which is
    // exactly the failure #859 describes, and why the assertion is on THIS
    // record rather than on a count (a count passes on a signed-out machine).
    await mkdir(join(tmp, ".comfyui-mcp"), { recursive: true });
    await writeFile(
      join(tmp, ".comfyui-mcp", "panel-secrets.json"),
      JSON.stringify({
        oauthStatus: {
          "fixture-only-provider": {
            provider: "fixture-only-provider",
            account_label: "scoped@example.test",
            obtained_at: 1_700_000_000,
          },
        },
      }),
      "utf-8",
    );

    const { readOAuthStatus } = await import("../../services/code-provider-auth.js");
    const records = readOAuthStatus(tmp);

    const scoped = records.find((r) => r.provider === "fixture-only-provider");
    expect(scoped, "the injected home's mirror entry must be returned").toBeDefined();
    expect(scoped?.account_label).toBe("scoped@example.test");
  });

  it("returns no mirror entries for an EMPTY injected home", async () => {
    // The inverse, and the half that actually catches a developer's real logins
    // leaking in: with nothing written under `tmp`, anything returned here that
    // is not a detected native CLI session came from outside the fixture.
    const { readOAuthStatus } = await import("../../services/code-provider-auth.js");
    const records = readOAuthStatus(tmp);

    expect(
      records.find((r) => r.provider === "fixture-only-provider"),
      "no record may survive from a previous test's home",
    ).toBeUndefined();
  });
});
