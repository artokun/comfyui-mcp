import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistOAuthResult, readOAuthStatus, clearOAuth } from "../../services/code-provider-auth.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "oauth-land-"));
  process.env.COMFYUI_MCP_PANEL_SECRETS = join(home, "panel-secrets.json");
});

it("codex: writes ~/.codex/auth.json in tokens{} shape + a status mirror without token material", async () => {
  const idToken = "h." + Buffer.from(JSON.stringify({ chatgpt_account_id: "acct_1", email: "a@b.co" })).toString("base64url") + ".s";
  const { account_label } = await persistOAuthResult("codex", {
    access_token: "AT", refresh_token: "RT", id_token: idToken, raw: {},
  }, { home });
  const auth = JSON.parse(readFileSync(join(home, ".codex", "auth.json"), "utf8"));
  expect(auth.tokens.access_token).toBe("AT");
  expect(auth.tokens.account_id).toBe("acct_1");
  expect(account_label).toContain("a@b.co");
  const status = readOAuthStatus();
  const codex = status.find((s) => s.provider === "codex")!;
  expect(codex.account_label).toContain("a@b.co");
  // mirror must NOT contain the token
  expect(JSON.stringify(status)).not.toContain("AT");
});

it("copilot: writes its own store + status flagged experimental", async () => {
  await persistOAuthResult("copilot", { access_token: "ghu_AT", raw: { token_type: "bearer" } }, { home });
  expect(existsSync(join(home, ".comfyui-mcp", "copilot-auth.json"))).toBe(true);
  const c = readOAuthStatus().find((s) => s.provider === "copilot")!;
  expect(c.experimental).toBe(true);
});

it("writes native token files 0600 (POSIX)", async () => {
  if (process.platform === "win32") return; // mode not enforced on Windows
  await persistOAuthResult("grok", { access_token: "AT", refresh_token: "RT", expires_in: 3600, raw: {} }, { home });
  const mode = statSync(join(home, ".grok", "auth.json")).mode & 0o777;
  expect(mode).toBe(0o600);
});

it("clearOAuth removes the native file and the mirror entry", async () => {
  await persistOAuthResult("copilot", { access_token: "ghu_AT", raw: {} }, { home });
  clearOAuth("copilot", { home });
  expect(existsSync(join(home, ".comfyui-mcp", "copilot-auth.json"))).toBe(false);
  expect(readOAuthStatus().find((s) => s.provider === "copilot")).toBeUndefined();
});
