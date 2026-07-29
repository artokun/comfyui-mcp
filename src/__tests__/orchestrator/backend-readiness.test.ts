// Readiness is computed on the machine that RUNS the agents (this orchestrator),
// not the ComfyUI host — so a remote pod no longer false-flags "CLI not installed".
//
// Claude is the SDK host (no CLI): always usable here. Codex/Gemini need their CLI
// on PATH AND a cached login. These tests drive PATH + a fake HOME so the on-disk
// probes are deterministic across platforms.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, delimiter } from "node:path";
import { backendReadiness, allBackendReadiness } from "../../orchestrator/backend-readiness.js";

const REAL_PATH = process.env.PATH;
const REAL_GEMINI_HOME = process.env.GEMINI_CLI_HOME;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "readiness-"));
  // Empty PATH by default so nothing resolves unless a test adds it.
  process.env.PATH = "";
  delete process.env.GEMINI_CLI_HOME;
});

afterEach(() => {
  process.env.PATH = REAL_PATH;
  if (REAL_GEMINI_HOME === undefined) delete process.env.GEMINI_CLI_HOME;
  else process.env.GEMINI_CLI_HOME = REAL_GEMINI_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

/** Create a fake CLI binary on a dir and add that dir to PATH. */
function putOnPath(name: string): void {
  const dir = join(tmp, "bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), "#!/bin/sh\n");
  process.env.PATH = [dir, process.env.PATH].filter(Boolean).join(delimiter);
}

describe("backendReadiness", () => {
  it("reports Claude ready unconditionally (SDK host, no CLI)", () => {
    const r = backendReadiness("claude");
    expect(r).toEqual({ backend: "claude", cli: true, auth: true, ready: true });
  });

  it("is case-insensitive", () => {
    expect(backendReadiness("CLAUDE").ready).toBe(true);
  });

  it("codex: not ready with neither CLI nor login", () => {
    const r = backendReadiness("codex", { home: tmp });
    expect(r.cli).toBe(false);
    expect(r.ready).toBe(false);
  });

  it("codex: CLI on PATH but no login → cli true, not ready", () => {
    putOnPath(process.platform === "win32" ? "codex.cmd" : "codex");
    const r = backendReadiness("codex", { home: tmp });
    expect(r.cli).toBe(true);
    expect(r.auth).toBe(false);
    expect(r.ready).toBe(false);
  });

  it("codex: CLI on PATH AND login on disk → ready", () => {
    putOnPath(process.platform === "win32" ? "codex.cmd" : "codex");
    mkdirSync(join(tmp, ".codex"), { recursive: true });
    writeFileSync(join(tmp, ".codex", "auth.json"), "{}");
    const r = backendReadiness("codex", { home: tmp });
    expect(r.cli).toBe(true);
    expect(r.auth).toBe(true);
    expect(r.ready).toBe(true);
  });

  it("grok: CLI on PATH AND auth.json on disk → ready", () => {
    putOnPath(process.platform === "win32" ? "grok.cmd" : "grok");
    mkdirSync(join(tmp, ".grok"), { recursive: true });
    writeFileSync(join(tmp, ".grok", "auth.json"), "{}");
    const r = backendReadiness("grok", { home: tmp });
    expect(r.cli).toBe(true);
    expect(r.auth).toBe(true);
    expect(r.ready).toBe(true);
  });

  it("gemini: honors GEMINI_CLI_HOME for the oauth creds path", () => {
    putOnPath(process.platform === "win32" ? "gemini.cmd" : "gemini");
    const gh = join(tmp, "geminihome");
    mkdirSync(join(gh, ".gemini"), { recursive: true });
    writeFileSync(join(gh, ".gemini", "oauth_creds.json"), "{}");
    process.env.GEMINI_CLI_HOME = gh;
    const r = backendReadiness("gemini", { home: tmp });
    expect(r.cli).toBe(true);
    expect(r.auth).toBe(true);
    expect(r.ready).toBe(true);
  });

  it("chatgpt: ready when ~/.codex/auth.json exists (no CLI)", () => {
    mkdirSync(join(tmp, ".codex"), { recursive: true });
    writeFileSync(join(tmp, ".codex", "auth.json"), "{}");
    const r = backendReadiness("chatgpt", { home: tmp });
    expect(r.cli).toBe(true);
    expect(r.auth).toBe(true);
    expect(r.ready).toBe(true);
  });

  it("glm: ready when ZAI_API_KEY is set", () => {
    process.env.ZAI_API_KEY = "zai-key";
    const r = backendReadiness("glm", { home: tmp });
    expect(r.ready).toBe(true);
    delete process.env.ZAI_API_KEY;
  });

  it("kimi: ready with oauth file or KIMI_API_KEY", () => {
    mkdirSync(join(tmp, ".kimi", "credentials"), { recursive: true });
    writeFileSync(join(tmp, ".kimi", "credentials", "kimi-code.json"), "{}");
    process.env.KIMI_SHARE_DIR = join(tmp, ".kimi");
    const r = backendReadiness("kimi", { home: tmp });
    expect(r.ready).toBe(true);
    delete process.env.KIMI_SHARE_DIR;
  });

  it("moonshot: ready when MOONSHOT_API_KEY is set (distinct from kimi)", () => {
    const real = process.env.MOONSHOT_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    expect(backendReadiness("moonshot", { home: tmp }).ready).toBe(false);
    process.env.MOONSHOT_API_KEY = "sk-moonshot-test";
    const r = backendReadiness("moonshot", { home: tmp });
    expect(r.auth).toBe(true);
    expect(r.ready).toBe(true);
    if (real === undefined) delete process.env.MOONSHOT_API_KEY;
    else process.env.MOONSHOT_API_KEY = real;
  });

  it("minimax: ready when MINIMAX_API_KEY is set", () => {
    const real = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    expect(backendReadiness("minimax", { home: tmp }).ready).toBe(false);
    process.env.MINIMAX_API_KEY = "minimax-test-key";
    const r = backendReadiness("minimax", { home: tmp });
    expect(r.auth).toBe(true);
    expect(r.ready).toBe(true);
    if (real === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = real;
  });

  it("unknown backend is never ready", () => {
    expect(backendReadiness("bogus").ready).toBe(false);
  });

  it("custom: ready iff a base URL is configured (caller-resolved or env)", () => {
    const realBase = process.env.COMFYUI_MCP_CUSTOM_BASE_URL;
    delete process.env.COMFYUI_MCP_CUSTOM_BASE_URL;
    expect(backendReadiness("custom").ready).toBe(false);
    expect(backendReadiness("custom", { customEndpointConfigured: true }).ready).toBe(true);
    process.env.COMFYUI_MCP_CUSTOM_BASE_URL = "http://127.0.0.1:8000/v1";
    // opts wins even when explicitly false (the caller resolved persisted settings)
    expect(backendReadiness("custom", { customEndpointConfigured: false }).ready).toBe(false);
    expect(backendReadiness("custom").ready).toBe(true);
    if (realBase === undefined) delete process.env.COMFYUI_MCP_CUSTOM_BASE_URL;
    else process.env.COMFYUI_MCP_CUSTOM_BASE_URL = realBase;
  });
});

describe("backendReadiness: in-panel OAuth status", () => {
  // The readiness fns take an injectable `oauthStatus` array + `now` (ms) so a
  // test never has to touch the real ~/.comfyui-mcp/panel-secrets.json. Status
  // records mirror OAuthStatusRecord: { provider, account_label, obtained_at,
  // expires_at? (unix SECONDS), experimental? }.
  const NOW = 1_700_000_000_000; // fixed ms clock
  const FUTURE = Math.floor(NOW / 1000) + 3600; // +1h, in seconds
  const PAST = Math.floor(NOW / 1000) - 3600; // -1h, in seconds

  it("non-expired panel OAuth entry → auth true even when CLI+file are absent", () => {
    // Empty PATH (no CLI) + fake home with no auth.json (no native file).
    const r = backendReadiness("codex", {
      home: tmp,
      now: NOW,
      oauthStatus: [{ provider: "codex", account_label: "user@example.com", obtained_at: NOW, expires_at: FUTURE }],
    });
    expect(r.cli).toBe(false); // no CLI on PATH
    expect(r.auth).toBe(true); // flipped true purely by the panel-OAuth entry
    expect(r.ready).toBe(false); // still gated on cli for codex
  });

  it("EXPIRED panel OAuth entry does NOT flip auth on its own (falls back to CLI/file check)", () => {
    const r = backendReadiness("grok", {
      home: tmp,
      now: NOW,
      oauthStatus: [{ provider: "grok", account_label: "x@ai", obtained_at: NOW, expires_at: PAST }],
    });
    // No ~/.grok/auth.json in the fake home either, so the OR-fallback yields false.
    expect(r.auth).toBe(false);
  });

  it("panel OAuth entry with NO expires_at is treated as non-expiring (auth true)", () => {
    const r = backendReadiness("codex", {
      home: tmp,
      now: NOW,
      oauthStatus: [{ provider: "codex", account_label: "user@example.com", obtained_at: NOW }],
    });
    expect(r.auth).toBe(true);
  });

  it("expired panel entry still yields auth true when the native CLI/file login exists (OR-fallback)", () => {
    // The external-CLI login path must keep winning regardless of a stale mirror entry.
    putOnPath(process.platform === "win32" ? "codex.cmd" : "codex");
    mkdirSync(join(tmp, ".codex"), { recursive: true });
    writeFileSync(join(tmp, ".codex", "auth.json"), "{}");
    const r = backendReadiness("codex", {
      home: tmp,
      now: NOW,
      oauthStatus: [{ provider: "codex", account_label: "stale", obtained_at: NOW, expires_at: PAST }],
    });
    expect(r.auth).toBe(true);
    expect(r.ready).toBe(true);
  });

  it("external-CLI login with NO panel OAuth entry still yields auth true (backward-compat)", () => {
    putOnPath(process.platform === "win32" ? "grok.cmd" : "grok");
    mkdirSync(join(tmp, ".grok"), { recursive: true });
    writeFileSync(join(tmp, ".grok", "auth.json"), "{}");
    const r = backendReadiness("grok", { home: tmp, now: NOW, oauthStatus: [] });
    expect(r.auth).toBe(true);
    expect(r.ready).toBe(true);
  });
});

describe("allBackendReadiness", () => {
  it("rolls up any_ready (Claude alone makes it true)", () => {
    const { backends, any_ready } = allBackendReadiness(["claude", "codex", "gemini"]);
    expect(backends).toHaveLength(3);
    expect(any_ready).toBe(true);
    expect(backends.find((b) => b.backend === "claude")?.ready).toBe(true);
  });

  it("real homedir stays untouched by the probe", () => {
    // Sanity: the function must not throw on a real environment.
    process.env.PATH = REAL_PATH ?? "";
    expect(() => allBackendReadiness(["claude", "codex", "gemini"])).not.toThrow();
    expect(typeof homedir()).toBe("string");
  });
});
