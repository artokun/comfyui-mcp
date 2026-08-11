// #1370 — `download_model action:"status"` told users "the partial was left on disk and
// can be resumed by re-issuing the download". Nothing ever stat'd the file. The reporter
// paused a 33 GB download BECAUSE of that sentence, found no partial anywhere, and
// restarted from zero.
//
// THE FIXTURES HERE ARE BUILT FROM THE PRODUCTION PATH FUNCTION, NOT FROM A NAME I TYPED.
// My first version of this file created `.<destination filename>.partial` and searched for
// the same string, so it passed while production stages under
// `.<sha256(cacheIdentity)[0:32]><ext>.partial` — keyed by the CACHE identity, not the
// destination. The lookup would have missed every real partial and reported "no partial
// found" for downloads that had one: this issue's own bug inverted, and worse, because the
// original at least erred toward "your bytes are safe".
//
// A test whose fixture encodes the belief under test cannot fail for the reason it exists.
// Deriving the path from `stagedPartialPathForUrl` is what makes the two impossible to
// disagree.

import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findResumablePartial, stagedPartialPathForUrl } from "../../services/download-cache.js";

const URL_A = "https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/flux2_dev_fp8mixed.safetensors";
const URL_B = "https://huggingface.co/Comfy-Org/other/resolve/main/mistral_3_small.safetensors";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  delete process.env.COMFYUI_DOWNLOAD_CACHE_DIR;
});

async function useTempCache(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dl-partial-"));
  dirs.push(dir);
  process.env.COMFYUI_DOWNLOAD_CACHE_DIR = dir;
}

/** Stage a partial exactly where the writer would put it for this URL. */
async function stagePartialFor(url: string, bytes: number): Promise<string> {
  const p = stagedPartialPathForUrl(url);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, Buffer.alloc(bytes, 1));
  return p;
}

describe("findResumablePartial reports what is ACTUALLY staged (#1370)", () => {
  it("finds the partial the writer would have staged for this URL", async () => {
    await useTempCache();
    const staged = await stagePartialFor(URL_A, 4096);
    const found = await findResumablePartial(URL_A);
    expect(found?.bytes).toBe(4096);
    expect(found?.path).toBe(staged);
  });

  it("the staged name is HASHED and HIDDEN — both details cost a round", async () => {
    // Two separate mistakes, one per review round:
    //   1. searched `.<destination filename>.partial` — wrong KEY (the writer stages by
    //      cache identity, not destination);
    //   2. derived the cache path correctly and dropped the LEADING DOT, so it looked for
    //      `hash.ext.partial` while the writer wrote `.hash.ext.partial`.
    // Each time the lookup found nothing and would have told a user holding 30 GB of
    // resumable bytes to start over. The dot is asserted separately because the previous
    // version of this test used `/[0-9a-f]{32}\.safetensors\.partial$/`, which matches
    // happily with OR without it.
    await useTempCache();
    const p = stagedPartialPathForUrl(URL_A);
    const name = basename(p);
    expect(p, "must not be keyed on the destination filename").not.toMatch(/flux2_dev_fp8mixed/);
    expect(name.startsWith("."), `staged file must be hidden, got ${name}`).toBe(true);
    expect(name).toMatch(/^\.[0-9a-f]{32}\.safetensors\.partial$/);
  });

  it("WIRING: the WRITER stages through the same function the lookup reads", async () => {
    // The root cause of both rounds was two parallel derivations of one path, each
    // confident and one wrong. A test that only compares the helper against itself cannot
    // see that — my fixtures were built by calling the helper under test, so they agreed
    // with every wrong version of it.
    //
    // This asserts the writer does not hand-roll the path any more. It is the only check
    // here that could have failed while all the others passed.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../services/download-cache.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*/g, "");
    expect(src).toMatch(/const partial = stagedPartialPathForTarget\(target\);/);
    // …and the hand-rolled expression exists in exactly ONE place: the shared helper.
    const handRolled = src.match(/join\(cacheDir\(\), `\.\$\{basename\([a-z]+\)\}\.partial`\)/g) ?? [];
    expect(handRolled.length, "the staged path must be built in exactly one place").toBe(1);
  });

  it("returns NULL when nothing is staged — the reporter's case", async () => {
    await useTempCache();
    expect(await findResumablePartial(URL_A)).toBeNull();
  });

  it("does not report ANOTHER download's partial as this one's", async () => {
    // The staged name is keyed on the URL, so two downloads never share one. Reporting a
    // neighbour's bytes as resumable would be a new false claim, not a fix for the old one.
    await useTempCache();
    await stagePartialFor(URL_B, 8192);
    expect(await findResumablePartial(URL_A)).toBeNull();
    expect((await findResumablePartial(URL_B))?.bytes).toBe(8192);
  });

  it("a ZERO-BYTE partial is reported as absent", async () => {
    // Resuming from it saves nothing, and calling it resumable restates this bug in
    // miniature: a claim of retained bytes where there are none.
    await useTempCache();
    await stagePartialFor(URL_A, 0);
    expect(await findResumablePartial(URL_A)).toBeNull();
  });

  it("ignores the COMPLETED cache entry — only the staged .partial is resumable", async () => {
    await useTempCache();
    const partial = stagedPartialPathForUrl(URL_A);
    const completed = partial.replace(/\.partial$/, "");
    await mkdir(dirname(completed), { recursive: true });
    await writeFile(completed, Buffer.alloc(8192, 1));
    expect(await findResumablePartial(URL_A)).toBeNull();
  });

  it("a missing or unparseable URL yields null rather than throwing", async () => {
    await useTempCache();
    expect(await findResumablePartial(undefined)).toBeNull();
    expect(await findResumablePartial("")).toBeNull();
    expect(await findResumablePartial("not a url")).toBeNull();
  });
});
