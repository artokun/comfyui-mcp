// #875 — the pairing token stops rotating per run.
//
// A user asked to pin the orchestrator version because "updating the npm version
// bricks my communication with the agent". The version was never the cause: the
// self-restarter is on by default (hourly npm check, restarts when idle), and a
// restart minted a fresh pairing token — so the URL their phone had saved was
// dead. The documented answer was to set COMFYUI_MCP_PAIR_TOKEN, which works but
// requires knowing that the thing that broke was a token at all.
//
// Persisting it removes that rotation for everyone with no configuration.
//
// HALF the fix, deliberately: a tunnel URL also carries a cloudflared quick-tunnel
// hostname, minted fresh every run with no way to pin it. A stable token makes the
// LAN URL durable; a tunnel URL still rotates, and pair-durability must keep
// saying so.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreatePairToken, pairTokenPath } from "../../orchestrator/pair-token-store.js";

let dir: string;
let file: string;
const OLD = process.env.COMFYUI_MCP_PAIR_TOKEN_FILE;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmcp-pairtok-"));
  file = join(dir, "pair-token");
  process.env.COMFYUI_MCP_PAIR_TOKEN_FILE = file;
});

afterEach(() => {
  if (OLD === undefined) delete process.env.COMFYUI_MCP_PAIR_TOKEN_FILE;
  else process.env.COMFYUI_MCP_PAIR_TOKEN_FILE = OLD;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("the pairing token survives a restart", () => {
  it("mints one on first use and persists it", () => {
    const first = loadOrCreatePairToken();

    expect(first.persisted).toBe(true);
    expect(first.token).toMatch(/^[0-9a-f]{48}$/);
    expect(readFileSync(file, "utf-8").trim()).toBe(first.token);
  });

  it("returns the SAME token on the next run — this is the whole fix", () => {
    const first = loadOrCreatePairToken();
    const second = loadOrCreatePairToken(); // a fresh process would do exactly this

    expect(second.token).toBe(first.token);
    expect(second.persisted).toBe(true);
  });

  it("honours the configured path", () => {
    expect(pairTokenPath()).toBe(file);
  });
});

describe("a damaged token file is replaced, never trusted", () => {
  // An interrupted write is the realistic way this goes wrong, and a truncated
  // value must not become the credential a phone is told to trust.
  it.each([
    ["truncated", "abc123"],
    ["empty", ""],
    ["not hex", "z".repeat(48)],
    ["hand-edited prose", "my-token"],
  ])("replaces a %s file with a fresh valid token", (_label, content) => {
    writeFileSync(file, content);

    const got = loadOrCreatePairToken();

    expect(got.token).toMatch(/^[0-9a-f]{48}$/);
    expect(got.token).not.toBe(content);
    expect(got.persisted).toBe(true);
    // …and the bad value is gone, so the next boot does not repeat the warning.
    expect(readFileSync(file, "utf-8").trim()).toBe(got.token);
  });

  it("tolerates surrounding whitespace rather than discarding a good token", () => {
    const good = "a".repeat(48);
    writeFileSync(file, `\n${good}\n`);

    expect(loadOrCreatePairToken().token).toBe(good);
  });
});

describe("it degrades instead of failing", () => {
  // A read-only home or a permissions problem must not break pairing outright.
  // The old behaviour — a per-session token — is the correct fallback, and the
  // caller is told which it got so pair-durability can report honestly rather
  // than claiming a stability the URL does not have.
  it("falls back to a per-session token when the path cannot be written", () => {
    // A directory where the file goes: mkdir succeeds, the write cannot.
    process.env.COMFYUI_MCP_PAIR_TOKEN_FILE = dir; // dir itself, not a file in it

    const got = loadOrCreatePairToken();

    expect(got.token).toMatch(/^[0-9a-f]{48}$/);
    expect(got.persisted).toBe(false); // the honest half
  });
});

describe("the file is not world-readable", () => {
  it("writes the token 0600 on POSIX", () => {
    if (process.platform === "win32") return; // POSIX modes are meaningless here
    loadOrCreatePairToken();

    expect(statSync(file).mode & 0o077).toBe(0);
  });
});
