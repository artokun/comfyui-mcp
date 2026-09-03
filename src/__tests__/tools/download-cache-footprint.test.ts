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

import { downloadCacheFootprint } from "../../services/download-cache.js";
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
});
