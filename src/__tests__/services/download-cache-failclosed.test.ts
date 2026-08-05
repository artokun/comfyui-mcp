import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #467 P1-B: assertComplete() must FAIL CLOSED when an authoritative expected size
// is known but the written file's size can't be read (a transient stat failure) —
// it must NOT finalize (rename .partial into cache) an unverifiable download.
//
// Force that by wrapping node:fs/promises' stat so it throws while a flag is set;
// everything else passes through to the real implementation.
const statCtl = { fail: false };
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    stat: async (p: Parameters<typeof actual.stat>[0], ...rest: unknown[]) => {
      if (statCtl.fail) throw Object.assign(new Error("EIO: simulated stat failure"), { code: "EIO" });
      // @ts-expect-error passthrough
      return actual.stat(p, ...rest);
    },
  };
});

vi.mock("../../config.js", () => {
  const config = {
    comfyuiPath: undefined as string | undefined,
    huggingfaceToken: undefined as string | undefined,
    civitaiApiToken: undefined as string | undefined,
  };
  return { config, isRemoteMode: () => !config.comfyuiPath };
});

import { config } from "../../config.js";
import { downloadWithCache } from "../../services/download-cache.js";

const fetchMock = vi.fn();
let tempDir: string;
let cacheDir: string;
let comfyDir: string;

beforeEach(async () => {
  statCtl.fail = false;
  tempDir = await mkdtemp(join(tmpdir(), "comfyui-mcp-failclosed-"));
  cacheDir = join(tempDir, "cache");
  comfyDir = join(tempDir, "comfy");
  process.env.COMFYUI_DOWNLOAD_CACHE_DIR = cacheDir;
  delete process.env.COMFYUI_LRU_CACHE_SIZE_GB;
  config.comfyuiPath = comfyDir;
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(async () => {
  statCtl.fail = false;
  vi.unstubAllGlobals();
  delete process.env.COMFYUI_DOWNLOAD_CACHE_DIR;
  await rm(tempDir, { recursive: true, force: true });
});

describe("assertComplete fail-closed (#467 P1-B)", () => {
  it("does NOT finalize (rename into cache) when the size can't be verified against a known Content-Length", async () => {
    // A full body WITH an authoritative Content-Length. Normally this verifies and
    // finalizes; with stat failing at completion it must fail closed instead.
    // The stat must fail AT COMPLETION, which is what this test is about. Flipping
    // the flag before the call would instead trip the staged-file ownership check
    // (an unreadable staged file now refuses BEFORE writing, rather than being
    // mistaken for "no partial" and truncated) — a different, also-correct
    // refusal, but not the one named here. Flip it once the body is consumed.
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            c.enqueue(new TextEncoder().encode("the-model-bytes"));
            statCtl.fail = true;
            c.close();
          },
        }),
        { status: 200, statusText: "OK", headers: { "content-length": "15" } },
      ),
    );

    await expect(
      downloadWithCache({
        url: "https://example.com/models/failclosed.safetensors",
        headers: {},
        targetPath: join(comfyDir, "out.safetensors"),
      }),
      // Either fail-closed refusal is correct here, and which one fires depends on
      // WHICH stat the simulated EIO reaches first. The completion check says "I
      // could not verify the size"; the staged-file ownership check says "I could
      // not read the staged file, so I will not act on it". Both refuse for the
      // same reason — an unreadable file is not a known-good one — and the
      // load-bearing assertion below (nothing was finalized) is unchanged either way.
    ).rejects.toThrow(/could not be verified|not finalizing|could not be read/i);

    // Crucially: nothing was renamed into the cache as a "successful" download.
    statCtl.fail = false;
    const cached = await readdir(cacheDir).catch(() => [] as string[]);
    expect(cached.some((f) => f.endsWith(".safetensors"))).toBe(false);
  });
});
