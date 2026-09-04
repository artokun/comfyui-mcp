// #1477 — the download cache was invisible.
//
// It is a second, content-addressed copy of every model ever downloaded, kept so a
// re-download is free. It lives under the HOME volume while the models land wherever
// ComfyUI keeps them, and with COMFYUI_LRU_CACHE_SIZE_GB unset `evictLruIfNeeded`
// returns immediately — so the default is unbounded growth on the system drive.
//
// Two reporters found it the same way, with a disk-usage treemap: 0.24 + 2.72 GB
// after two models landed on F:, then 37.63 GB across 11 entries on C: while the
// models were on D:. Neither found it from anything this server printed, because
// nothing this server printed had ever named the directory.
//
// These pin the reporting, not a limit. What the default limit ought to be is a
// separate decision and deliberately not made here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same hazard as empty-listing-wiring.test.ts: the record store resolves its path
// once at module load, so redirecting it after the import would read the
// developer's own records and fail only inside the full suite.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir: osTmp } = require("node:os") as typeof import("node:os");
  const { join: j } = require("node:path") as typeof import("node:path");
  process.env.COMFYUI_MCP_DATA_DIR = mkdtempSync(j(osTmp(), "cmcp-1477-"));
});

// The listing render (as opposed to the empty-listing note) needs a tracked job,
// and startDownloadJob resolves a destination and routing before it streams. Stub
// just those three so no live server is required — the same three the sibling
// model-management tool tests stub, for the same reason.
vi.mock("../../services/model-resolver.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/model-resolver.js")>(
    "../../services/model-resolver.js",
  );
  return {
    ...actual,
    downloadModel: () => new Promise<string>(() => {}), // never settles: the job stays live
    shouldDispatchDownloadToManager: async () => false,
    resolveDownloadTarget: async (url: string, sub: string, filename?: string) => {
      const name = filename ?? String(url).split("/").pop() ?? "model.safetensors";
      return { targetDir: `/m/${sub}`, filename: name, targetPath: `/m/${sub}/${name}` };
    },
  };
});

import { downloadCacheFootprint } from "../../services/download-cache.js";
import { setProgressDir } from "../../services/download-progress.js";
import { resetDownloadJobs, startDownloadJob } from "../../services/download-jobs.js";
import { registerModelManagementTools } from "../../tools/model-management.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function downloadTool(): ToolHandler {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, ...rest: unknown[]) => {
      handlers.set(name, rest.find((a) => typeof a === "function") as ToolHandler);
    },
  };
  registerModelManagementTools(server as never);
  return handlers.get("download_model")!;
}

let tempDir: string;
let cacheDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "comfyui-mcp-footprint-"));
  cacheDir = join(tempDir, "cache");
  process.env.COMFYUI_DOWNLOAD_CACHE_DIR = cacheDir;
  delete process.env.COMFYUI_LRU_CACHE_SIZE_GB;
});

afterEach(async () => {
  delete process.env.COMFYUI_DOWNLOAD_CACHE_DIR;
  delete process.env.COMFYUI_LRU_CACHE_SIZE_GB;
  await rm(tempDir, { recursive: true, force: true });
});

/** A cache directory holding one landed entry, its sidecar, and one live partial. */
async function seedCache(): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, "abc123.safetensors"), "0123456789"); // 10 B retained
  await writeFile(join(cacheDir, ".abc123.safetensors.ct"), "application/octet-stream");
  await writeFile(join(cacheDir, ".def456.safetensors.partial"), "01234"); // 5 B staged
}

describe("#1477 downloadCacheFootprint measures what the cache is holding", () => {
  it("reports nothing, and does not throw, when the directory has never been created", async () => {
    const f = await downloadCacheFootprint();
    expect(f.unreadable).toBe(true);
    expect(f.retainedBytes).toBe(0);
    expect(f.stagedBytes).toBe(0);
    // Still names where it WOULD be — that is the thing the reporters could not find.
    expect(f.dir).toBe(cacheDir);
  });

  it("counts landed entries as retained", async () => {
    await seedCache();
    const f = await downloadCacheFootprint();
    expect(f.retainedEntries).toBe(1);
    expect(f.retainedBytes).toBe(10);
  });

  it("counts the .ct sidecar too, so the buckets ACCOUNT FOR the directory", async () => {
    // The fixture has always written this sidecar; nothing asserted on it, and the
    // first version of the report dropped it from BOTH buckets — hidden, so not
    // retained; not `.partial`, so not staged. The numbers then could not be
    // reconciled against `du`, which is the one thing a footprint report is for.
    await seedCache();
    const f = await downloadCacheFootprint();
    expect(f.sidecarEntries).toBe(1);
    expect(f.sidecarBytes).toBe("application/octet-stream".length);
    // Every FILE in the directory lands in exactly one bucket.
    expect(f.retainedBytes + f.stagedBytes + f.sidecarBytes).toBe(
      10 + 5 + "application/octet-stream".length,
    );
    expect(f.retainedEntries + f.stagedEntries + f.sidecarEntries).toBe(3);
  });

  it("counts a resumable partial as STAGED, never as retained", async () => {
    await seedCache();
    const f = await downloadCacheFootprint();
    // The distinction is the point: eviction skips dot-prefixed files, so calling a
    // partial "retained" would invite deleting the bytes a download is resuming from.
    expect(f.stagedEntries).toBe(1);
    expect(f.stagedBytes).toBe(5);
    expect(f.retainedBytes).toBe(10);
  });

  it("does not count the Content-Type sidecar as an entry of its own", async () => {
    await seedCache();
    const f = await downloadCacheFootprint();
    expect(f.retainedEntries + f.stagedEntries).toBe(2);
  });

  it("reports the eviction limit, and 0 when eviction is off", async () => {
    await seedCache();
    expect((await downloadCacheFootprint()).limitBytes).toBe(0);
    process.env.COMFYUI_LRU_CACHE_SIZE_GB = "2";
    expect((await downloadCacheFootprint()).limitBytes).toBe(2 * 1024 ** 3);
  });
});

describe('#1477 the WIRING: download_model action:"status" says it out loud', () => {
  it("names the directory, the size, and that nothing evicts it", async () => {
    await seedCache();
    const text = (await downloadTool()({ action: "status" })).content[0].text;
    expect(text).toContain("Download cache");
    expect(text).toContain(cacheDir);
    expect(text).toContain("Eviction is OFF");
    // The lever, because the workaround that fixed it for the reporter was only
    // discoverable by reading download-cache.js.
    expect(text).toContain("COMFYUI_LRU_CACHE_SIZE_GB");
    expect(text).toContain("COMFYUI_DOWNLOAD_CACHE_DIR");
    // The sidecar bucket must be PRINTED, not merely computed. Without this the
    // third number exists only in the return value, the reader is left with the
    // same unexplained remainder against `du` that the two-bucket version had,
    // and every assertion above still passes.
    expect(text).toMatch(/sidecar/i);
    expect(text).toContain(".ct/.etag");
  });

  it("reports the limit instead of the levers once eviction is on", async () => {
    await seedCache();
    process.env.COMFYUI_LRU_CACHE_SIZE_GB = "2";
    const text = (await downloadTool()({ action: "status" })).content[0].text;
    expect(text).toContain("Eviction is ON");
    expect(text).not.toContain("Eviction is OFF");
  });

  it("stays silent when the cache is empty, so polling does not accrete text", async () => {
    await mkdir(cacheDir, { recursive: true });
    const text = (await downloadTool()({ action: "status" })).content[0].text;
    expect(text).not.toContain("Download cache");
  });

  // "There is no cache yet" and "the cache is THERE and I cannot read it" were one
  // value, and the note treated both as nothing-to-say. The second is the case where
  // naming the directory matters most: #1477 exists because nothing this server
  // printed had ever named it, and a user whose cache is unreadable is exactly the
  // one who ends up back at a disk-usage treemap.
  //
  // Reached without mocks by pointing the cache at a FILE — readdir then fails
  // ENOTDIR, on every platform, and it is a real way to mis-set the env var.
  it("distinguishes a MISSING cache from an unreadable one", async () => {
    await mkdir(tempDir, { recursive: true });
    await writeFile(cacheDir, "not a directory");
    const f = await downloadCacheFootprint();
    expect(f.unreadable).toBe(true);
    expect(f.unreadableCode).toBe("ENOTDIR");
  });

  it("a missing cache reports ENOENT, which is what keeps the note silent", async () => {
    const f = await downloadCacheFootprint();
    expect(f.unreadable).toBe(true);
    expect(f.unreadableCode).toBe("ENOENT");
  });

  it("an UNREADABLE cache is named and called unknown, never reported as zero", async () => {
    await mkdir(tempDir, { recursive: true });
    await writeFile(cacheDir, "not a directory");
    const text = (await downloadTool()({ action: "status" })).content[0].text;
    expect(text).toContain("Download cache");
    expect(text).toContain(cacheDir);
    expect(text).toContain("UNKNOWN");
    // The failure mode this replaces: a confident 0.00 GB for a cache that may hold
    // tens of gigabytes.
    expect(text).not.toContain("0.00 GB");
  });

  // The two call sites are separate exits and a test that only reaches one leaves
  // the other free to be deleted silently — verified by mutating each alone. This
  // is also the surface that matters most: someone watching a transfer is exactly
  // who should see the second copy of it accumulating.
  it("reaches the LISTING render too, not just the empty-listing note", async () => {
    const progressDir = await mkdtemp(join(tmpdir(), "cmcp-1477-progress-"));
    const savedUrl = process.env.COMFYUI_URL;
    process.env.COMFYUI_URL = "http://127.0.0.1:8188";
    setProgressDir(progressDir);
    resetDownloadJobs();
    try {
      await seedCache();
      await startDownloadJob("https://example.com/live.safetensors", "checkpoints");
      const text = (await downloadTool()({ action: "status" })).content[0].text;
      expect(text).toContain("## Downloads");
      expect(text).toContain("Download cache");
      expect(text).toContain(cacheDir);
    } finally {
      resetDownloadJobs();
      if (savedUrl === undefined) delete process.env.COMFYUI_URL;
      else process.env.COMFYUI_URL = savedUrl;
      await rm(progressDir, { recursive: true, force: true });
    }
  });
});

// The footprint's "retained" bucket is only meaningful if it means exactly what
// eviction would free. Both sites used to carry their OWN copy of
// `!name.startsWith(".")`, while the footprint's comment asserted the two "cannot
// disagree" — true by coincidence, not by construction. A later change to either
// copy would silently invalidate the one number the report exists to provide.
describe("#1477 the retention predicate is shared, not restated", () => {
  const SRC = readFileSync(
    new URL("../../services/download-cache.ts", import.meta.url),
    "utf8",
  );

  it("defines the predicate exactly once", () => {
    const defs = SRC.split("function isRetainedCacheEntry(").length - 1;
    expect(defs).toBe(1);
  });

  it("uses it at BOTH the eviction and footprint sites", () => {
    const uses = SRC.split("isRetainedCacheEntry(").length - 1;
    // one definition + two call sites
    expect(uses).toBe(3);
  });

  it("leaves no second copy of the raw dot-prefix test", () => {
    // `.partial` / sidecar classification legitimately inspects names; what must
    // not come back is a bare re-implementation of the RETENTION test.
    expect(SRC).not.toContain('entry.isFile() && !entry.name.startsWith(".")');
    expect(SRC).not.toContain('!entry.name.startsWith(".")');
  });
});
