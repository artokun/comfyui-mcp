import { readFileSync } from "node:fs";

/**
 * The version reported when our own manifest cannot be read or parsed.
 *
 * `0.0.0` was used first and codex was right to reject it: it is a legal SemVer that a real
 * manifest could carry, so the fallback was indistinguishable from a genuine value — the
 * same ambiguity the hardcoded "0.1.0" created. A prerelease tag cannot collide with a
 * published release of this package and still parses as SemVer for any client that tries.
 */
export const UNKNOWN_VERSION = "0.0.0-unknown";

/**
 * #1447 — the version this build actually is, for `serverInfo.version`.
 *
 * Lives in its own module for two reasons, both learned in review:
 *
 *  - it must be CHEAP. `detectInstallMode()` answers a bigger question (global vs npx vs
 *    checkout) and pays an `lstatSync`/`realpathSync` walk for it. Callers that run after
 *    their transport is up can afford that; this value is needed while the MCP server is
 *    being constructed, i.e. on the handshake path — and a symlink-resolving directory walk
 *    in front of the handshake is self-defeating in a fix filed under "startup exceeds the
 *    client's timeout".
 *  - it must be TESTABLE for real. Asserting on `boot.ts`'s source text cannot tell "reads
 *    the manifest" from "reads the manifest and then returns something else" (codex), and
 *    `boot.ts` is a program that seizes stdio, so a test cannot import it. A small function
 *    with an injectable reader can be executed instead of described.
 *
 * The default manifest URL is resolved from THIS module's own location, so it can never
 * pick up a parent directory's package.json: `dist/utils/package-version.js` → `dist/../`
 * and `src/utils/package-version.ts` → the repo root, both the package root.
 */
export function readPackageVersion(
  manifestUrl: URL = new URL("../../package.json", import.meta.url),
  read: (url: URL) => string = (url) => readFileSync(url, "utf-8"),
): string {
  try {
    // A UTF-8 BOM makes JSON.parse throw (codex): npm writes manifests without one, but a
    // hand-edited file on Windows can carry it, and losing the real version to an editor's
    // byte-order mark would be a silly way to reintroduce the exact ambiguity this fixes.
    const raw = read(manifestUrl).replace(/^﻿/, "");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" && version ? version : UNKNOWN_VERSION;
  } catch {
    // Deliberately NOT a plausible-looking version. The literal this replaced was "0.1.0",
    // which read as data and made every bug report ambiguous; a sentinel no release of this
    // package can carry is a signal that something is wrong.
    return UNKNOWN_VERSION;
  }
}
