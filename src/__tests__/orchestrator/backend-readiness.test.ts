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
