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
  // A SECOND temp dir stands in for the developer's real home, and `os.homedir()`
  // is pointed at it. That is what makes these deterministic: the failure mode is
  // "the mirror read falls through to the real home", and without a real home we
  // control, a test can only assert the absence of its own fixture — which proves
  // nothing, because a genuine leak surfaces a REAL provider like `codex`, not the
  // fixture. (That was the first version of this test, and the gate was right to
  // reject it: it passed identically whether the fix was present or reverted.)
  let scopedHome: string;
  let pretendRealHome: string;

  beforeEach(async () => {
    scopedHome = await mkdtemp(join(tmpdir(), "cmcp-oauth-scoped-"));
    pretendRealHome = await mkdtemp(join(tmpdir(), "cmcp-oauth-realish-"));
    // The env override is the OTHER redirect and outranks `home` by design; it must
    // stay unset so these prove the `home` ARGUMENT alone scopes the read.
    delete process.env.COMFYUI_MCP_PANEL_SECRETS;

    // The stand-in real home holds an ordinary, plausible signed-in provider —
    // exactly what a developer machine signed into codex would have.
    await mkdir(join(pretendRealHome, ".comfyui-mcp"), { recursive: true });
    await writeFile(
      join(pretendRealHome, ".comfyui-mcp", "panel-secrets.json"),
      JSON.stringify({
        oauthStatus: {
          codex: { provider: "codex", account_label: "dev@example.test", obtained_at: 1_700_000_000 },
        },
      }),
      "utf-8",
    );

    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => pretendRealHome };
    });
    vi.resetModules();
  });

  afterEach(async () => {
    vi.doUnmock("node:os");
    vi.resetModules();
    await rm(scopedHome, { recursive: true, force: true });
    await rm(pretendRealHome, { recursive: true, force: true });
  });

  it("an EMPTY injected home yields no records — the real home's logins do not leak in", async () => {
    const { readOAuthStatus } = await import("../../services/code-provider-auth.js");
    const records = readOAuthStatus(scopedHome);

    // The assertion that actually discriminates: with the fix reverted, the mirror
    // read resolves against homedir() and returns the `codex` record above.
    expect(
      records.find((r) => r.provider === "codex"),
      "a provider from the real home must not appear for an empty injected home",
    ).toBeUndefined();
    expect(records, "nothing at all should be found under an empty home").toEqual([]);
  });

  it("reads the mirror from the injected home, not the real one", async () => {
    await mkdir(join(scopedHome, ".comfyui-mcp"), { recursive: true });
    await writeFile(
      join(scopedHome, ".comfyui-mcp", "panel-secrets.json"),
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
    const records = readOAuthStatus(scopedHome);

    const scoped = records.find((r) => r.provider === "fixture-only-provider");
    expect(scoped, "the injected home's mirror entry must be returned").toBeDefined();
    expect(scoped?.account_label).toBe("scoped@example.test");
    // Both directions in one place: the right file was read AND the wrong one was not.
    expect(records.find((r) => r.provider === "codex")).toBeUndefined();
  });
});
