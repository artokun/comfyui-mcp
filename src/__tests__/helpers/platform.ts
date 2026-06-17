// Cross-platform test helpers. The suite was originally authored on macOS; these
// utilities let tests run correctly on Windows too.

import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";

let symlinkCapability: boolean | null = null;

/**
 * Whether this process can create filesystem symlinks. On Windows, symlink
 * creation requires Developer Mode or elevated privileges, so tests that build
 * a real symlink as a fixture (e.g. to verify the product REJECTS a path that
 * escapes a sandbox) cannot set up on a stock Windows dev machine. The product
 * code under test is unaffected — this only gates the test fixture.
 */
export function canCreateSymlinks(): boolean {
  if (symlinkCapability !== null) return symlinkCapability;
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "comfyui-mcp-symtest-"));
    symlinkSync(join(dir, "target"), join(dir, "link"));
    symlinkCapability = true;
  } catch {
    symlinkCapability = false;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
  return symlinkCapability;
}

/**
 * `it` that runs only when real symlinks can be created. On platforms/privilege
 * levels where they can't (typically Windows without Developer Mode), the test
 * is skipped rather than failing in fixture setup.
 */
export const itWithSymlinks = it.skipIf(!canCreateSymlinks());
