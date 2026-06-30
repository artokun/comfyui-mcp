import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fsPromises from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => {
  const config = {
    comfyuiPath: undefined as string | undefined,
    huggingfaceToken: undefined as string | undefined,
    civitaiApiToken: undefined as string | undefined,
  };
  return {
    config,
    // downloadModel branches on this; these tests always run with comfyuiPath
    // set (local mode), so it returns false.
    isRemoteMode: () => !config.comfyuiPath,
  };
});

import { config } from "../../config.js";
import { downloadCacheFs } from "../../services/download-cache.js";
import { downloadModel } from "../../services/model-resolver.js";

const fetchMock = vi.fn();
let tempDir: string;
let cacheDir: string;
let comfyDir: string;

function okResponse(body: string): Response {
  return new Response(body, { status: 200, statusText: "OK" });
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "comfyui-mcp-cache-test-"));
  cacheDir = join(tempDir, "cache");
  comfyDir = join(tempDir, "comfy");
  process.env.COMFYUI_DOWNLOAD_CACHE_DIR = cacheDir;
  delete process.env.COMFYUI_LRU_CACHE_SIZE_GB;
  config.comfyuiPath = comfyDir;
  config.huggingfaceToken = undefined;
  config.civitaiApiToken = undefined;
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.COMFYUI_DOWNLOAD_CACHE_DIR;
  delete process.env.COMFYUI_LRU_CACHE_SIZE_GB;
  await rm(tempDir, { recursive: true, force: true });
});

describe("downloadModel cache", () => {
  it("downloads on cache miss and reuses the cached file on hit", async () => {
    fetchMock.mockResolvedValueOnce(okResponse("cached model"));

    const first = await downloadModel(
      "https://example.com/models/a.safetensors",
      "checkpoints",
      "first.safetensors",
    );
    const second = await downloadModel(
      "https://example.com/models/a.safetensors",
      "checkpoints",
      "second.safetensors",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(readFile(first, "utf-8")).resolves.toBe("cached model");
    await expect(readFile(second, "utf-8")).resolves.toBe("cached model");
  });

  it("coalesces concurrent downloads for the same source URL", async () => {
    let resolveFetch!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const one = downloadModel(
      "https://example.com/models/concurrent.safetensors",
      "checkpoints",
      "one.safetensors",
    );
    const two = downloadModel(
      "https://example.com/models/concurrent.safetensors",
      "loras",
      "two.safetensors",
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveFetch(okResponse("one network body"));

    const [onePath, twoPath] = await Promise.all([one, two]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(readFile(onePath, "utf-8")).resolves.toBe("one network body");
    await expect(readFile(twoPath, "utf-8")).resolves.toBe("one network body");
  });

  it("falls back to copying when hardlink materialization fails", async () => {
    const linkSpy = vi
      .spyOn(downloadCacheFs, "link")
      .mockRejectedValue(Object.assign(new Error("cross-device link"), { code: "EXDEV" }));
    const copySpy = vi.spyOn(downloadCacheFs, "copyFile");
    fetchMock.mockResolvedValueOnce(okResponse("copy fallback"));

    const target = await downloadModel(
      "https://example.com/models/copy.safetensors",
      "checkpoints",
      "copy.safetensors",
    );

    expect(linkSpy).toHaveBeenCalled();
    expect(copySpy).toHaveBeenCalled();
    await expect(readFile(target, "utf-8")).resolves.toBe("copy fallback");
  });

  it("resumes from a leftover partial file using HTTP Range and appends a 206 response", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    // Pre-seed the .partial that the cache deterministic-names.
    // The cache key derives from sha256(url).slice(0,32) + the URL's pathname extension.
    const url = "https://example.com/models/resume.safetensors";
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 32);
    const partialPath = join(cacheDir, `.${hash}.safetensors.partial`);
    await writeFile(partialPath, "AAAA"); // 4 bytes of prior progress

    // Server returns 206 with the remaining bytes.
    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/8" },
      }),
    );

    const target = await downloadModel(url, "checkpoints", "resumed.safetensors");

    // We sent the Range header reflecting the existing 4 bytes.
    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers.Range).toBe("bytes=4-");

    // The materialized file is the full 8 bytes (existing partial + appended).
    await expect(readFile(target, "utf-8")).resolves.toBe("AAAABBBB");
  });

  it("overwrites the partial when the server replies 200 (Range unsupported)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/norange.safetensors";
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 32);
    const partialPath = join(cacheDir, `.${hash}.safetensors.partial`);
    await writeFile(partialPath, "STALE_PARTIAL_CONTENT");

    fetchMock.mockResolvedValueOnce(okResponse("full body from server"));

    const target = await downloadModel(url, "checkpoints", "fresh.safetensors");

    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers.Range).toBe("bytes=21-"); // requested, but server ignored
    await expect(readFile(target, "utf-8")).resolves.toBe("full body from server");
  });

  it("evicts least-recently-used cache files when the optional limit is exceeded", async () => {
    process.env.COMFYUI_LRU_CACHE_SIZE_GB = String(12 / 1024 / 1024 / 1024);
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const oldFile = join(cacheDir, "old.safetensors");
    await writeFile(oldFile, "0123456789");
    const oldDate = new Date("2000-01-01T00:00:00.000Z");
    await utimes(oldFile, oldDate, oldDate);
    fetchMock.mockResolvedValueOnce(okResponse("new!"));

    await downloadModel(
      "https://example.com/models/new.safetensors",
      "checkpoints",
      "new.safetensors",
    );

    const cacheFiles = await readdir(cacheDir);
    expect(cacheFiles).not.toContain("old.safetensors");
    expect(cacheFiles).toHaveLength(1);
    const remaining = join(cacheDir, cacheFiles[0]);
    expect((await stat(remaining)).size).toBe(4);
  });
});
