// #875 — the phone pairing token, persisted so it stops rotating per run.
//
// A user asked to pin the orchestrator version because "updating the npm version
// bricks my communication with the agent". The version was never the cause: the
// self-restarter is on by default, and a restart rotated the pairing token, so
// the URL their phone had saved was dead. They were told to set
// COMFYUI_MCP_PAIR_TOKEN — which works, but requires knowing that the thing that
// broke was a token at all.
//
// Generating it once and reusing it removes that rotation for everyone with no
// configuration. The reporter's own note on the trust model is the right one:
// the token is already password-equivalent and already handed to a phone over a
// QR/URL, so writing it to the user's own config dir does not change who can
// reach what. It lives beside the session store and panel secrets, which are the
// same class of local-only material.
//
// This is HALF the fix. A tunnel URL also carries a cloudflared quick-tunnel
// hostname, which is minted fresh every run and cannot be pinned — so a stable
// token makes the LAN URL durable and a tunnel URL still rotates. pair-durability
// reports exactly that at pair time; nothing here may imply otherwise.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { logger } from "../utils/logger.js";

/** Where the token lives. Overridable for tests — this must NEVER be written
 *  under a real home directory from a test run. */
export function pairTokenPath(): string {
  return (
    process.env.COMFYUI_MCP_PAIR_TOKEN_FILE ||
    join(homedir(), ".comfyui-mcp", "pair-token")
  );
}

/** A token we minted: 24 random bytes, hex — the same shape the per-session path
 *  used, so nothing downstream sees a different kind of value. */
function mint(): string {
  return randomBytes(24).toString("hex");
}

/**
 * Accept only what we would have minted. A file that has been truncated,
 * half-written, or filled with something else must not become the credential a
 * phone is told to trust — and a short/empty read is exactly what an interrupted
 * write leaves behind.
 */
function usable(raw: string): string | null {
  const t = raw.trim();
  return /^[0-9a-f]{48}$/.test(t) ? t : null;
}

/**
 * The stable pairing token: the one on disk, or a freshly minted one persisted
 * for next time.
 *
 * NEVER throws and never returns an empty string. If the file cannot be read or
 * written — a read-only home, a permissions problem — this falls back to a
 * per-session token, which is exactly the behaviour that existed before. Pairing
 * degrades to "works now, dies on restart" rather than failing outright, and the
 * caller is told which it got so pair-durability can say so.
 */
export function loadOrCreatePairToken(): { token: string; persisted: boolean } {
  const path = pairTokenPath();
  try {
    if (existsSync(path)) {
      const existing = usable(readFileSync(path, "utf-8"));
      if (existing) return { token: existing, persisted: true };
      // Present but unusable. Do NOT reuse it, and do not silently keep a file
      // that will fail the same way every boot — replace it with a good one.
      logger.warn(
        `[pair-token] ${path} did not contain a usable token (truncated or edited); minting a new one`,
      );
    }
  } catch (err) {
    logger.warn(
      `[pair-token] could not read ${path}: ${err instanceof Error ? err.message : String(err)} — using a per-session token`,
    );
    return { token: mint(), persisted: false };
  }

  const token = mint();
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Write-then-rename so an interrupted write cannot leave a half-token that
    // the next boot would read as the credential.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, token, { mode: 0o600 });
    renameSync(tmp, path);
    try {
      chmodSync(path, 0o600); // no-op on Windows; belt-and-braces on POSIX
    } catch {
      /* best-effort — the rename already carried the mode on POSIX */
    }
    return { token, persisted: true };
  } catch (err) {
    logger.warn(
      `[pair-token] could not persist a stable token to ${path}: ${err instanceof Error ? err.message : String(err)} — ` +
        `pairing still works, but the URL your phone saves will stop working after a restart`,
    );
    return { token, persisted: false };
  }
}
