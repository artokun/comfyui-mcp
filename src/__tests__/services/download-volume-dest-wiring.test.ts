// #1477 — the destination-volume clause existed and was never reachable.
//
// The report: a 32 GB model bound for D:, staged into the cache on C:, which could
// not hold it. `insufficientCacheSpaceMessage` has accepted `destDir`/`destFree`
// since it was written — and says, when the destination has room and the cache does
// not, that this is one setting rather than a fatal error. No production caller ever
// passed them, so that clause could not fire: the capability was built and not
// connected, and the unit tests covered the MESSAGE while nothing covered the WIRING.

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkCacheVolumeSpace } from "../../services/download-volume.js";

const CACHE_SRC = fileURLToPath(new URL("../../services/download-cache.ts", import.meta.url));
/** Larger than any real volume, so the refusal fires against real statfs. */
const A_PETABYTE = 1024 ** 5;

describe("#1477 a cache-volume refusal names the DESTINATION volume", () => {
  it("carries the destination through to the message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmcp-1477-vol-"));
    const dest = mkdtempSync(join(tmpdir(), "cmcp-1477-dest-"));
    try {
      const withDest = await checkCacheVolumeSpace({
        needBytes: A_PETABYTE,
        cacheDir: dir,
        destDir: dest,
      });
      expect(withDest).toBeTruthy();
      expect(withDest).toContain(dest);

      // Without it, the same refusal cannot mention a destination at all — which is
      // exactly what every real download produced before this was threaded.
      const withoutDest = await checkCacheVolumeSpace({
        needBytes: A_PETABYTE,
        cacheDir: dir,
      });
      expect(withoutDest).toBeTruthy();
      expect(withoutDest).not.toContain(dest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it("returns null when the volume has room, destination or not", async () => {
    // The neighbour that must not regress: threading a destination must not make an
    // ordinary download refuse.
    const dir = mkdtempSync(join(tmpdir(), "cmcp-1477-ok-"));
    try {
      expect(await checkCacheVolumeSpace({ needBytes: 1024, cacheDir: dir, destDir: dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#1477 the production download path actually supplies it", () => {
  // Source pins, and labelled as such: driving a real multi-gigabyte download to
  // exhaustion is not a unit test. These are what would have caught the gap — the
  // message tests passed the whole time the clause was unreachable.
  const src = readFileSync(CACHE_SRC, "utf8");

  it("the volume precheck is given destDir", () => {
    const at = src.indexOf("checkCacheVolumeSpace({");
    expect(at).toBeGreaterThan(-1);
    const call = src.slice(at, src.indexOf("});", at));
    // The SHORTHAND pass-through specifically. `toContain("destDir")` also passes on
    // `destDir: undefined`, which disables the feature while reading as wired — a
    // guard that matches a different clause than the one it is named for.
    expect(call).toMatch(/(^|\s)destDir,/m);
    expect(call).not.toMatch(/destDir\s*:\s*undefined/);
  });

  it("downloadWithCache threads the FINAL destination down", () => {
    // The layers below see the CACHE path, so this value is only knowable here.
    const at = src.indexOf("const cachePath = await downloadIntoCache(");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, src.indexOf(");", at))).toContain("dirname(options.targetPath)");
  });
});
