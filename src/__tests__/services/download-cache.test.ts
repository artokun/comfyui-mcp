import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
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
    // #1374 — the route decision stamps the target it was made against, so this mock
    // has to provide it. Faked rather than spread from the real config: these suites
    // control `config` themselves and a real base URL would not match what they set.
    getComfyUIBaseUrl: () => `http://127.0.0.1:8188`,
  };
});

import { config } from "../../config.js";
import { downloadCacheFs } from "../../services/download-cache.js";
import { downloadModel } from "../../services/model-resolver.js";
import type { ResumeDiagnostic } from "../../services/download-resume-diag.js";
import { setDownloadRetryPolicyForTests } from "../../services/download-retry.js";

/** Capture the resume decision a physical download reports (#467). The decision
 *  is delivered to the CALLER via an onResume callback (no shared map), so a test
 *  passes this box's `onResume` to downloadModel and reads `box.d` afterward. */
function resumeCapture() {
  const box: { d?: ResumeDiagnostic } = {};
  return { box, onResume: (d: ResumeDiagnostic) => { box.d = d; } };
}

/** Mirror of the impl's cache identity (download-cache.ts): the 32-hex cache-file
 *  hash for a URL + optional request headers. Kept in lockstep with cacheIdentity
 *  — namespaced (#467 P1-C) and header-aware (#467 P1-2). */
function reprFor(headers: Record<string, string> = {}): string {
  const keys = Object.keys(headers);
  if (keys.length === 0) return "";
  const joined = keys
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((k) => `${k.toLowerCase()}=${headers[k]}`)
    .join("\n");
  return createHash("sha256").update(joined).digest("hex").slice(0, 12);
}
function cacheHashFor(url: string, headers: Record<string, string> = {}): string {
  const repr = reprFor(headers);
  const identity = repr ? `v2\n${url}\n${repr}` : `v2\n${url}`;
  return createHash("sha256").update(identity).digest("hex").slice(0, 32);
}

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
  // These tests exercise ONE physical attempt's integrity semantics (#343/#467/#473).
  // #470 added automatic retry on transient failures, which would otherwise re-enter
  // the stream with a mock that has no further queued response. Pin a single attempt
  // and disable the stall watchdog so each assertion is about the attempt itself.
  // Retry behaviour has its own dedicated coverage (download-retry.test.ts).
  setDownloadRetryPolicyForTests({ maxAttempts: 1, stallTimeoutMs: 0 });
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

  it("#515: a cancelled COALESCED caller never materializes its destination", async () => {
    // A and B fetch the SAME url (→ one physical download, coalesced) to DIFFERENT
    // destinations. B is cancelled while awaiting A's shared stream; when A finishes, B
    // must bail BEFORE materializing — no completed file at B's models path.
    let resolveFetch!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((res) => {
        resolveFetch = res;
      }),
    );

    const ctrlB = new AbortController();
    // Start A first and let it become the physical-stream OWNER (fetch fired) before B
    // joins, so B deterministically COALESCES onto A's stream (rather than the reverse).
    const a = downloadModel(
      "https://example.com/models/coalesce.safetensors",
      "checkpoints",
      "a.safetensors",
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const b = downloadModel(
      "https://example.com/models/coalesce.safetensors",
      "loras",
      "b.safetensors",
      undefined,
      undefined,
      undefined,
      ctrlB.signal,
    );
    // Let B reach the coalesce point (await A's shared inflight promise).
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1); // B did NOT start its own fetch
    ctrlB.abort(); // cancel B while it awaits A's shared physical download
    // Attach B's rejection expectation BEFORE resolving A, so B's rejection is never
    // momentarily unhandled once A completes.
    const bRejects = expect(b).rejects.toThrow();
    resolveFetch(okResponse("real model bytes"));

    const aPath = await a;
    await bRejects;
    // A landed; B did NOT (its destination was never materialized).
    await expect(readFile(aPath, "utf-8")).resolves.toBe("real model bytes");
    const bTarget = join(comfyDir, "models", "loras", "b.safetensors");
    await expect(stat(bTarget)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("#515: aborting mid-stream rejects and never finalizes the target (integrity preserved)", async () => {
    // A body that emits one chunk then STALLS forever, so we can abort it mid-transfer.
    let cancelled = false;
    // #980 — the abort used to fire on a 25 ms timer, which is a BET that the
    // pipeline has attached to the body and entered pull() first. On a loaded
    // macOS runner that bet loses: the abort lands before anything reads the
    // stream, the transfer rejects without ever cancelling the body, and
    // `cancelled` stays false. The download behaviour was fine every time — only
    // the corroborating observation raced — but it took main red intermittently,
    // which costs more than the assertion is worth. Wait for the EVENT instead.
    let sawFirstPull!: () => void;
    const firstPull = new Promise<void>((resolve) => {
      sawFirstPull = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("partial-bytes-on-disk"));
      },
      pull() {
        sawFirstPull(); // the pipeline IS reading — safe to abort now
        return new Promise<void>(() => {}); // never resolves — the stream stalls
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        statusText: "OK",
        headers: { "content-length": "1000000" }, // far more than we ever send
      }),
    );

    const controller = new AbortController();
    const p = downloadModel(
      "https://example.com/models/abortme.safetensors",
      "checkpoints",
      "abortme.safetensors",
      undefined,
      undefined,
      undefined,
      controller.signal,
    );
    // Deterministic: block until the pipeline has actually pulled from the body,
    // then abort. No wall-clock bet, so runner load cannot change the outcome.
    await firstPull;
    controller.abort();

    // The transfer rejects (aborted) — it is NOT reported as a successful download.
    await expect(p).rejects.toThrow();
    // The web body was cancelled by the aborted pipeline.
    expect(cancelled).toBe(true);
    // Integrity: the destination file was NEVER created — no truncated partial was
    // renamed into place and reported as complete (#515/#343).
    const target = join(comfyDir, "models", "checkpoints", "abortme.safetensors");
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
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
    const url = "https://example.com/models/resume.safetensors";
    const hash = cacheHashFor(url);
    const partialPath = join(cacheDir, `.${hash}.safetensors.partial`);
    await writeFile(partialPath, "AAAA"); // 4 bytes of prior progress
    // A resume is only attempted when we hold the validator captured on the
    // first attempt (replayed as If-Range); seed it so the resume proceeds.
    await writeFile(`${partialPath}.etag`, '"resume-etag"');

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
    const hash = cacheHashFor(url);
    const partialPath = join(cacheDir, `.${hash}.safetensors.partial`);
    await writeFile(partialPath, "STALE_PARTIAL_CONTENT");
    // With a validator present we send Range+If-Range; the server ignoring the
    // range (or the file having changed) replies 200 and we overwrite cleanly.
    await writeFile(`${partialPath}.etag`, '"stale-etag"');

    fetchMock.mockResolvedValueOnce(okResponse("full body from server"));

    const target = await downloadModel(url, "checkpoints", "fresh.safetensors");

    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers.Range).toBe("bytes=21-"); // requested, but server ignored
    await expect(readFile(target, "utf-8")).resolves.toBe("full body from server");
  });

  it("uses HF X-Linked-Size (not an understated CAS Content-Length) to reject a short fresh download (#467)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://huggingface.co/org/repo/resolve/main/xlsize.safetensors";
    // Hop 1: resolve 302 declares the AUTHORITATIVE object size via X-Linked-Size.
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://cas-bridge.xethub.hf.co/xet-bridge-us/obj?sig=z",
          "x-linked-etag": '"xet-v1"',
          "x-linked-size": "4096",
        },
      }),
    );
    // Hop 2: the CAS 200 UNDERSTATES Content-Length (1024) and streams only 1024 of
    // the real 4096 bytes — a truncating CDN. Trusting Content-Length would finalize
    // a 1 KiB file as the whole 4096-byte model.
    fetchMock.mockResolvedValueOnce(
      new Response("A".repeat(1024), {
        status: 200,
        statusText: "OK",
        headers: { "content-length": "1024" },
      }),
    );

    await expect(
      downloadModel(url, "diffusion_models", "xlsize-out.safetensors"),
    ).rejects.toThrow(/truncat/i);
    // The short body was NOT renamed into cache as complete.
    const cached = await readdir(cacheDir).catch(() => [] as string[]);
    expect(cached.some((f) => f.endsWith(".safetensors"))).toBe(false);
  });

  it("REFUSES an UNSOLICITED partial 206 on a FRESH request — never finalizes a short prefix (#467 P0)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/unsolicited206.safetensors";
    // Fresh request (no seeded partial → no Range sent). A misbehaving server/proxy
    // answers with 206 bytes 0-1023/4096 and Content-Length 1024. Deriving the size
    // from Content-Length (1024) instead of the Content-Range total (4096) would let
    // a 1 KiB prefix be finalized into cache as the whole 4096-byte model.
    fetchMock.mockResolvedValueOnce(
      new Response("A".repeat(1024), {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 0-1023/4096", "content-length": "1024" },
      }),
    );

    await expect(
      downloadModel(url, "checkpoints", "unsolicited206-out.safetensors"),
    ).rejects.toThrow(/no Range|unsolicited|206/i);

    // The short prefix must NOT have been renamed into the cache as a complete file.
    const cached = await readdir(cacheDir).catch(() => [] as string[]);
    expect(cached.some((f) => f.endsWith(".safetensors"))).toBe(false);
  });

  it("rejects a truncated download (Content-Length exceeds bytes received) instead of reporting success (#343)", async () => {
    // Stream body yields only "short" (5 bytes) but the server claims 1000 —
    // pipeline() resolves on the early end, so without the size check this would
    // be saved + reported as a complete download.
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode("short")); c.close(); },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(stream, { status: 200, statusText: "OK", headers: { "content-length": "1000" } }),
    );
    await expect(
      downloadModel("https://example.com/models/trunc.safetensors", "checkpoints", "trunc.safetensors"),
    ).rejects.toThrow(/truncat/i);
  });

  it("rejects and removes a 0-byte download (source sent no data) (#343)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200, statusText: "OK" }));
    await expect(
      downloadModel("https://example.com/models/empty.safetensors", "checkpoints", "empty.safetensors"),
    ).rejects.toThrow(/0-byte/i);
    // The empty file must not linger in the cache to masquerade as a real download.
    const cached = await readdir(cacheDir).catch(() => [] as string[]);
    expect(cached.some((f) => f.endsWith(".safetensors"))).toBe(false);
  });

  it("follows a Hugging Face Xet/CAS cross-origin redirect and drops auth on the hop (#411)", async () => {
    config.huggingfaceToken = "hf_secrettoken";
    const hfUrl =
      "https://huggingface.co/Aitrepreneur/FLX/resolve/main/krea2_turbo_mxfp8.safetensors";
    // 1st hop: HF resolve URL 302s to the pre-signed Xet/CAS CDN (cross-origin).
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://cas-bridge.xethub.hf.co/xet-bridge-us/abc123?sig=xyz" },
      }),
    );
    // 2nd hop: the CDN serves the bytes.
    fetchMock.mockResolvedValueOnce(okResponse("xet model bytes"));

    const target = await downloadModel(hfUrl, "diffusion_models", "krea.safetensors");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Hop 1 carried the HF bearer token...
    const [, firstInit] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(firstInit.headers.Authorization).toBe("Bearer hf_secrettoken");
    // ...but the cross-origin CAS hop must NOT (no token leak to the third-party CDN).
    const [casUrl, secondInit] = fetchMock.mock.calls[1] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(casUrl).toContain("cas-bridge.xethub.hf.co");
    expect(secondInit.headers.Authorization).toBeUndefined();
    await expect(readFile(target, "utf-8")).resolves.toBe("xet model bytes");
  });

  it("surfaces the underlying cause when fetch fails at the network layer instead of a bare 'fetch failed' (#411)", async () => {
    // undici shape: TypeError("fetch failed") whose real reason is on .cause.
    const netErr = new TypeError("fetch failed");
    (netErr as { cause?: unknown }).cause = Object.assign(
      new Error("getaddrinfo ENOTFOUND cas-bridge.xethub.hf.co"),
      { code: "ENOTFOUND" },
    );
    fetchMock.mockRejectedValueOnce(netErr);

    const p = downloadModel(
      "https://huggingface.co/Aitrepreneur/FLX/resolve/main/krea2_turbo_mxfp8.safetensors",
      "diffusion_models",
      "krea.safetensors",
    );
    // Clear + actionable: names the real cause (ENOTFOUND) and the Xet/CAS host,
    // not the generic "fetch failed".
    await expect(p).rejects.toThrow(/network layer/i);
    await expect(p).rejects.toThrow(/ENOTFOUND/);
    await expect(p).rejects.toThrow(/Xet\/CAS/i);
  });

  it("gives a clear error for an unfollowable redirect (3xx with no Location) (#411)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302 }));
    const p = downloadModel(
      "https://huggingface.co/some/repo/resolve/main/model.safetensors",
      "diffusion_models",
      "m.safetensors",
    );
    await expect(p).rejects.toThrow(/no.*Location header/i);
  });

  // Deterministic cache paths for a URL (mirrors cachePathForUrl in the impl).
  function cachePaths(url: string, headers: Record<string, string> = {}) {
    const hash = cacheHashFor(url, headers);
    const target = join(cacheDir, `${hash}.safetensors`);
    const partial = join(cacheDir, `.${hash}.safetensors.partial`);
    return { hash, target, partial, sidecar: `${partial}.etag` };
  }

  it("sends If-Range from the persisted validator and RESTARTS (not appends) when the upstream file changed (#343 edge)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/changed.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    // A leftover partial from a prior attempt, plus the validator we captured then.
    await writeFile(partial, "AAAA");
    await writeFile(sidecar, '"etag-v1"');

    // The file changed upstream → server ignores the Range and returns 200 with
    // the full (new) body. Appending would corrupt; we must overwrite.
    fetchMock.mockResolvedValueOnce(okResponse("FULLNEWBODY"));

    const target = await downloadModel(url, "checkpoints", "changed-out.safetensors");

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Range).toBe("bytes=4-");
    expect(init.headers["If-Range"]).toBe('"etag-v1"');
    // Overwritten with the fresh body — NOT "AAAAFULLNEWBODY".
    await expect(readFile(target, "utf-8")).resolves.toBe("FULLNEWBODY");
  });

  it("sends If-Range and appends a matching 206 whose Content-Range starts at the resume offset (#343 edge)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/match.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    await writeFile(partial, "AAAA");
    await writeFile(sidecar, '"etag-stable"');

    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/8" },
      }),
    );

    const target = await downloadModel(url, "checkpoints", "match-out.safetensors");

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers["If-Range"]).toBe('"etag-stable"');
    await expect(readFile(target, "utf-8")).resolves.toBe("AAAABBBB");
  });

  it("refuses to append a 206 whose Content-Range starts at the WRONG offset (would corrupt) (#343 edge)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/badrange.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    await writeFile(partial, "AAAA"); // resume offset = 4
    await writeFile(sidecar, '"br-etag"');

    // Misbehaving server/proxy: says it's resuming from byte 0, not 4.
    fetchMock.mockResolvedValueOnce(
      new Response("ZZZZZZZZ", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 0-7/8" },
      }),
    );

    await expect(
      downloadModel(url, "checkpoints", "badrange-out.safetensors"),
    ).rejects.toThrow(/resume rejected/i);
    // The corrupt partial (and its sidecar) are removed so a retry starts clean.
    await expect(stat(partial)).rejects.toThrow();
    await expect(stat(sidecar)).rejects.toThrow();
  });

  it("refuses a 206 that omits Content-Range entirely (can't prove the offset) (#343 edge)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/nocr.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    await writeFile(partial, "AAAA");
    await writeFile(sidecar, '"nocr-etag"');

    // 206 but NO Content-Range — we cannot verify where it resumes from.
    fetchMock.mockResolvedValueOnce(
      new Response("ZZZZ", { status: 206, statusText: "Partial Content" }),
    );

    await expect(
      downloadModel(url, "checkpoints", "nocr-out.safetensors"),
    ).rejects.toThrow(/resume rejected/i);
  });

  it("accepts a 206 whose Content-Range uses a mixed-case range unit (RFC 9110 §14.1) (#343 edge)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/mixedcase.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    await writeFile(partial, "AAAA");
    await writeFile(sidecar, '"mc-etag"');

    // "Bytes" (capital B) is a legitimate, case-insensitive range unit.
    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "Bytes 4-7/8" },
      }),
    );

    const target = await downloadModel(url, "checkpoints", "mixedcase-out.safetensors");
    await expect(readFile(target, "utf-8")).resolves.toBe("AAAABBBB");
  });

  it("refuses a SHORT 206 that does not run to the end of the file (RFC 9110 partial range) (#343 edge)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/short206.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    await writeFile(partial, "AAAA"); // resume offset = 4
    await writeFile(sidecar, '"s2-etag"');

    // 206 whose Content-Range says the file is 1000 bytes but only serves
    // bytes 4-7 — appending 4 bytes and using content-length (4) as the target
    // would finalize an 8-byte file as "complete" for a 1000-byte model.
    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/1000" },
      }),
    );

    await expect(
      downloadModel(url, "checkpoints", "short206-out.safetensors"),
    ).rejects.toThrow(/resume rejected/i);
    await expect(stat(partial)).rejects.toThrow();
  });

  it("REFUSES a resume 206 whose total UNDERSTATES the size the original download recorded (#467)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/shrink.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    await writeFile(partial, "AAAA"); // 4 bytes already downloaded
    // Sidecar records the validator AND the authoritative total the ORIGINAL 200
    // declared (4096). A resume 206 that claims a SMALLER total is a server
    // understating the size — must be refused (would finalize a short prefix).
    await writeFile(sidecar, '"etag-v1"\n4096');

    // Internally-consistent but understated 206: bytes 4-7/8 (total 8 ≠ 4096).
    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/8" },
      }),
    );

    await expect(
      downloadModel(url, "checkpoints", "shrink-out.safetensors"),
    ).rejects.toThrow(/total size|reports a total|resume rejected/i);
    // The stale partial + sidecar are removed so a retry restarts clean.
    await expect(stat(partial)).rejects.toThrow();
  });

  it("does NOT resume a validator-less partial — restarts cleanly instead of appending (#343 edge)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/novalidator.safetensors";
    const { partial } = await cachePaths(url);
    // A stale partial with NO sidecar (e.g. left by a pre-fix build). We cannot
    // prove the upstream file is unchanged, so a Range resume is unsafe.
    await writeFile(partial, "AAAA");

    fetchMock.mockResolvedValueOnce(okResponse("FRESHFULLBODY"));

    const target = await downloadModel(url, "checkpoints", "novalidator-out.safetensors");

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    // No Range / If-Range without a trustworthy validator.
    expect(init.headers.Range).toBeUndefined();
    expect(init.headers["If-Range"]).toBeUndefined();
    // The stale prefix is discarded — final file is the fresh body, not "AAAA...".
    await expect(readFile(target, "utf-8")).resolves.toBe("FRESHFULLBODY");
  });

  it("FAILS the download (never silently discards) when the stale partial can't be truncated on restart (#467/#343)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/untruncatable.safetensors";
    const { partial } = await cachePaths(url);
    // Make the partial path a DIRECTORY so writeFile(targetPath, "") (the explicit
    // restart truncation) fails — we must throw, not fall through to a silent "w".
    await fsPromises.mkdir(partial, { recursive: true });

    fetchMock.mockResolvedValueOnce(okResponse("FRESHFULLBODY"));

    await expect(
      downloadModel(url, "checkpoints", "untruncatable-out.safetensors"),
    ).rejects.toThrow(/restart failed|could not truncate/i);
  });

  it("SURFACES a validator-less declined resume instead of silently discarding the partial (#467)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/silentdiscard.safetensors";
    const { partial } = await cachePaths(url);
    // A 21-byte partial with NO sidecar (the HF Xet case: the CAS CDN sent no
    // ETag/Last-Modified on the original body, so none was ever written).
    await writeFile(partial, "STALE_PARTIAL_CONTENT"); // 21 bytes

    fetchMock.mockResolvedValueOnce(okResponse("FRESHFULLBODY"));

    const cap = resumeCapture();
    const target = await downloadModel(
      url, "checkpoints", "silentdiscard-out.safetensors", undefined, undefined, cap.onResume,
    );
    await expect(readFile(target, "utf-8")).resolves.toBe("FRESHFULLBODY");

    // The discard is no longer silent: the decision records WHY and HOW MUCH.
    expect(cap.box.d?.outcome).toBe("declined:no-validator");
    expect(cap.box.d?.discardedBytes).toBe(21);
    expect(cap.box.d?.discarded).toBe(true);
  });

  it("persists a validator from the HF resolve REDIRECT (X-Linked-Etag) so a Xet partial becomes resumable (#467)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://huggingface.co/org/repo/resolve/main/big.safetensors";
    const { partial, sidecar } = await cachePaths(url);

    // Hop 1: resolve URL 302s cross-origin to the CAS CDN, carrying the
    // content-addressed X-Linked-Etag (but no plain ETag).
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://cas-bridge.xethub.hf.co/xet-bridge-us/obj?sig=abc",
          "x-linked-etag": '"xet-content-hash-v1"',
        },
      }),
    );
    // Hop 2: the CAS CDN serves the body with NEITHER ETag NOR Last-Modified,
    // and the stream ends early (truncated) so the partial + sidecar survive.
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode("half")); c.close(); },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        statusText: "OK",
        headers: { "content-length": "1000" },
      }),
    );

    await expect(
      downloadModel(url, "diffusion_models", "big-out.safetensors"),
    ).rejects.toThrow(/truncat/i);

    // Previously NO sidecar was written (final CAS 200 has no validator) so the
    // partial could never resume. Now the redirect's X-Linked-Etag is captured,
    // plus the authoritative total on line 2 (#467).
    await expect(stat(partial)).resolves.toBeTruthy();
    // Line 1 = value, line 2 = total, line 3 = the `xet` content-hash marker (#467).
    await expect(readFile(sidecar, "utf-8")).resolves.toBe('"xet-content-hash-v1"\n1000\nxet');
  });

  it("forwards Range across a cross-origin CAS redirect and APPENDS a 206 (HF Xet resume) (#467)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://huggingface.co/org/repo/resolve/main/resume-xet.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    await writeFile(partial, "AAAA"); // 4 bytes already downloaded
    await writeFile(sidecar, '"xet-content-hash-v1"\n\nxet'); // content-addressed prior

    // Hop 1: resolve URL 302s cross-origin, advertising the SAME content-addressed
    // X-Linked-Etag as the partial — proving the object is unchanged, so the
    // cross-origin 206 append is allowed (a cross-origin resume REQUIRES this).
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://cas-bridge.xethub.hf.co/xet-bridge-us/obj?sig=abc",
          "x-linked-etag": '"xet-content-hash-v1"',
        },
      }),
    );
    // Hop 2: the CAS CDN honors the byte range and returns a 206.
    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/8" },
      }),
    );

    const cap = resumeCapture();
    const target = await downloadModel(
      url, "diffusion_models", "resume-xet-out.safetensors", undefined, undefined, cap.onResume,
    );

    // Hop 1 (resolve) carried Range + If-Range...
    const [, firstInit] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(firstInit.headers.Range).toBe("bytes=4-");
    expect(firstInit.headers["If-Range"]).toBe('"xet-content-hash-v1"');
    // ...and CRUCIALLY the cross-origin CAS hop STILL carried Range (previously
    // dropped with all headers → resume was impossible on Xet).
    const [casUrl, secondInit] = fetchMock.mock.calls[1] as [string, { headers: Record<string, string> }];
    expect(casUrl).toContain("cas-bridge.xethub.hf.co");
    expect(secondInit.headers.Range).toBe("bytes=4-");
    // The bytes were appended, not re-downloaded from 0.
    await expect(readFile(target, "utf-8")).resolves.toBe("AAAABBBB");
    expect(cap.box.d?.outcome).toBe("resumed");
  });

  it("does NOT append a CAS 206 when the redirect's X-Linked-Etag genuinely changed — restarts in the SAME call (#467/#343)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://huggingface.co/org/repo/resolve/main/xet-changed.safetensors";
    const { partial } = await cachePaths(url);
    await writeFile(partial, "AAAA");
    await writeFile(`${partial}.etag`, '"xet-hash-OLD"\n\nxet'); // content-addressed prior, OLD content

    // Hop 1: resolve 302 now advertises a DIFFERENT content hash (file changed).
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://cas-bridge.xethub.hf.co/xet-bridge-us/obj?sig=new",
          "x-linked-etag": '"xet-hash-NEW"',
        },
      }),
    );
    // Hop 2: a misbehaving CAS that honors the stale Range and 206s the NEW object.
    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/8" },
      }),
    );
    // Restart within the same call: re-request from 0 → the fresh full object.
    fetchMock.mockResolvedValueOnce(okResponse("BRANDNEWFULLOBJECT"));

    // We must NOT splice new-object bytes onto the stale prefix, but the SAME call
    // must still complete — no second manual retry (#467).
    const cap = resumeCapture();
    const target = await downloadModel(
      url, "diffusion_models", "xet-changed-out.safetensors", undefined, undefined, cap.onResume,
    );
    // The genuinely-changed file was re-downloaded in full (NOT "AAAABBBB").
    await expect(readFile(target, "utf-8")).resolves.toBe("BRANDNEWFULLOBJECT");
    expect(cap.box.d?.outcome).toBe("declined:etag-changed");
    expect(cap.box.d?.discarded).toBe(true);
  });

  it("does NOT append a cross-origin CAS 206 whose redirect gives NO content validator — restarts in the SAME call (#467/#343)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://huggingface.co/org/repo/resolve/main/xet-unproven.safetensors";
    const { partial } = await cachePaths(url);
    await writeFile(partial, "AAAA");
    await writeFile(`${partial}.etag`, '"xet-hash-v1"\n\nxet'); // content-addressed prior

    // Hop 1: resolve 302s cross-origin WITHOUT an X-Linked-Etag — we cannot prove
    // the CAS object still matches the partial.
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://cas-bridge.xethub.hf.co/xet-bridge-us/obj?sig=x" },
      }),
    );
    // Hop 2: CAS honors the stale Range and 206s — but we must NOT trust it.
    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/8" },
      }),
    );
    // Restart within the same call rather than throwing + demanding a retry.
    fetchMock.mockResolvedValueOnce(okResponse("FULLBODYAGAIN"));

    const cap = resumeCapture();
    const target = await downloadModel(
      url, "diffusion_models", "xet-unproven-out.safetensors", undefined, undefined, cap.onResume,
    );
    // Unverifiable append refused, but the same call re-downloaded in full.
    await expect(readFile(target, "utf-8")).resolves.toBe("FULLBODYAGAIN");
    // Unverifiable, not proven-changed: no validator was available to compare.
    expect(cap.box.d?.outcome).toBe("declined:unverifiable");
  });

  it("REFUSES a resume 206 when a LATER redirect hop reports a changed X-Linked-Etag (multi-hop) (#467/#343)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://huggingface.co/org/repo/resolve/main/multihop.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    await writeFile(partial, "AAAA");
    await writeFile(sidecar, '"xet-hash-v1"\n\nxet'); // content-addressed prior

    // Hop 1: same-origin 302 whose X-Linked-Etag MATCHES the partial...
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://huggingface.co/org/repo/resolve/main/multihop2",
          "x-linked-etag": '"xet-hash-v1"',
        },
      }),
    );
    // Hop 2: a LATER cross-origin 302 that reports a DIFFERENT object — the file
    // changed; an earlier match must not let this slip through.
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://cas-bridge.xethub.hf.co/xet-bridge-us/obj?sig=z",
          "x-linked-etag": '"xet-hash-v2-CHANGED"',
        },
      }),
    );
    // Hop 3: CAS 206 for the changed object.
    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/8" },
      }),
    );
    // Restart within the same call → the fresh full object.
    fetchMock.mockResolvedValueOnce(okResponse("MULTIHOPFULLBODY"));

    const cap = resumeCapture();
    const target = await downloadModel(
      url, "diffusion_models", "multihop-out.safetensors", undefined, undefined, cap.onResume,
    );
    // A changed hash on a LATER hop still triggers a restart-in-call, not an append.
    await expect(readFile(target, "utf-8")).resolves.toBe("MULTIHOPFULLBODY");
    expect(cap.box.d?.outcome).toBe("declined:etag-changed");
  });

  it("declines + SURFACES a full-response resume (If-Range miss / no range support, 200) — safety preserved (#467/#343)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/changed-surfaced.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    await writeFile(partial, "AAAA"); // 4 bytes
    await writeFile(sidecar, '"etag-old"');

    // Upstream changed (or no range support) → server sends full 200, not a 206.
    fetchMock.mockResolvedValueOnce(okResponse("BRANDNEWBODY"));

    const cap = resumeCapture();
    const target = await downloadModel(
      url, "checkpoints", "changed-surfaced-out.safetensors", undefined, undefined, cap.onResume,
    );
    // Overwritten with the fresh body — safety preserved, no corrupt append.
    await expect(readFile(target, "utf-8")).resolves.toBe("BRANDNEWBODY");

    expect(cap.box.d?.outcome).toBe("declined:full-response");
    expect(cap.box.d?.discardedBytes).toBe(4);
  });

  it("persists the validator sidecar on a fresh write so a later resume can guard with If-Range (#343 edge)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/sidecar.safetensors";
    const { partial, sidecar } = await cachePaths(url);

    // Fresh download (no partial) whose stream ends early → truncated, so the
    // partial + its newly-written validator are left on disk for a resume.
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode("half")); c.close(); },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        statusText: "OK",
        headers: { "content-length": "1000", etag: '"captured-v9"' },
      }),
    );

    await expect(
      downloadModel(url, "checkpoints", "sidecar-out.safetensors"),
    ).rejects.toThrow(/truncat/i);

    // The validator was captured and PAIRS with the truncated partial bytes, with
    // the authoritative total (Content-Length 1000) on line 2 (#467).
    await expect(stat(partial)).resolves.toBeTruthy();
    await expect(readFile(sidecar, "utf-8")).resolves.toBe('"captured-v9"\n1000');
  });

  it("REJECTS + removes an OVERSIZED 206 that streams MORE than its Content-Range total (#467 P0-1)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/oversized206.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    await writeFile(partial, "AAAA"); // resume offset 4
    await writeFile(sidecar, '"ov-etag"');

    // 206 claims bytes 4-7/8 (total 8) but the body is 6 bytes → 4+6 = 10 > 8.
    // Without the exact-size check this corrupt 10-byte file would be finalized.
    fetchMock.mockResolvedValueOnce(
      new Response("BBBBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/8" },
      }),
    );

    await expect(
      downloadModel(url, "checkpoints", "oversized206-out.safetensors"),
    ).rejects.toThrow(/oversized/i);
    // The corrupt bytes are removed (NOT left to masquerade as resumable).
    await expect(stat(partial)).rejects.toThrow();
    await expect(stat(sidecar)).rejects.toThrow();
  });

  it("REJECTS + removes an OVERSIZED 200 that streams MORE than its Content-Length (#467 P0-1)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/oversized200.safetensors";
    // 200 claims 4 bytes but streams 9.
    fetchMock.mockResolvedValueOnce(
      new Response("TOOMANYBS", { status: 200, statusText: "OK", headers: { "content-length": "4" } }),
    );
    await expect(
      downloadModel(url, "checkpoints", "oversized200-out.safetensors"),
    ).rejects.toThrow(/oversized/i);
    const cached = await readdir(cacheDir).catch(() => [] as string[]);
    expect(cached.some((f) => f.endsWith(".safetensors"))).toBe(false);
  });

  it("does NOT append a cross-origin 206 whose FINAL response carries a DIFFERENT X-Linked-Etag than the matching redirect — restarts in-call (#467 P0-2)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://huggingface.co/org/repo/resolve/main/finalconflict.safetensors";
    const { partial } = await cachePaths(url);
    await writeFile(partial, "AAAA");
    await writeFile(`${partial}.etag`, '"xet-v1"\n\nxet'); // content-addressed prior

    // Hop 1: resolve 302 cross-origin whose X-Linked-Etag MATCHES the partial...
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://cas-bridge.xethub.hf.co/xet-bridge-us/obj?sig=a",
          "x-linked-etag": '"xet-v1"',
        },
      }),
    );
    // Hop 2: the FINAL CAS 206 advertises a DIFFERENT content hash — the object
    // changed at the CDN. A matching redirect must NOT let this slip through.
    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/8", "x-linked-etag": '"xet-v2-CHANGED"' },
      }),
    );
    // Restart within the same call → the fresh full object.
    fetchMock.mockResolvedValueOnce(okResponse("FINALCONFLICTFULL"));

    const cap = resumeCapture();
    const target = await downloadModel(
      url, "diffusion_models", "finalconflict-out.safetensors", undefined, undefined, cap.onResume,
    );
    // The final-hop change is caught and the object is re-downloaded in full.
    await expect(readFile(target, "utf-8")).resolves.toBe("FINALCONFLICTFULL");
    expect(cap.box.d?.outcome).toBe("declined:etag-changed");
  });

  it("captures the resolve REDIRECT's X-Linked-Etag for the sidecar even when the final CAS 200 carries its OWN per-hop ETag (#467 recurrence root cause)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://huggingface.co/org/repo/resolve/main/perhop.safetensors";
    const { partial, sidecar } = await cachePaths(url);

    // Hop 1: resolve 302 carries the CONTENT-ADDRESSED X-Linked-Etag.
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://cas-bridge.xethub.hf.co/xet-bridge-us/obj?sig=abc",
          "x-linked-etag": '"xet-content-hash-STABLE"',
        },
      }),
    );
    // Hop 2: the CAS 200 ALSO carries its OWN per-node/per-request etag + last-modified
    // (different from the content hash). The sidecar MUST store the content hash — the
    // value the resume change-check reads on the resolve hop — NOT this per-hop ETag,
    // or an unchanged object false-reads as "changed on a redirect hop" (#467).
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode("half")); c.close(); },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        statusText: "OK",
        headers: {
          "content-length": "1000",
          etag: '"cas-per-request-node-etag"',
          "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT",
        },
      }),
    );

    await expect(
      downloadModel(url, "diffusion_models", "perhop-out.safetensors"),
    ).rejects.toThrow(/truncat/i);

    await expect(stat(partial)).resolves.toBeTruthy();
    // The STABLE content hash was persisted (with its line-3 `xet` provenance marker),
    // NOT the CAS per-hop ETag.
    await expect(readFile(sidecar, "utf-8")).resolves.toBe('"xet-content-hash-STABLE"\n1000\nxet');
  });

  it("(a) does NOT falsely reject a resume when X-Linked-Etag is on the resolve hop but ABSENT on the final CAS 206 — partial NOT deleted (#467)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://huggingface.co/org/repo/resolve/main/absent-final.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    await writeFile(partial, "AAAA");
    await writeFile(sidecar, '"xet-content-hash-STABLE"\n\nxet'); // content-addressed prior

    // Hop 1: resolve 302 advertises the SAME content hash as the partial.
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://cas-bridge.xethub.hf.co/xet-bridge-us/obj?sig=abc",
          "x-linked-etag": '"xet-content-hash-STABLE"',
        },
      }),
    );
    // Hop 2: the final CAS 206 carries NO X-Linked-Etag (typical). Absence must NOT
    // be read as a change — the resume must proceed.
    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/8" },
      }),
    );

    const cap = resumeCapture();
    const target = await downloadModel(
      url, "diffusion_models", "absent-final-out.safetensors", undefined, undefined, cap.onResume,
    );
    // Appended, not re-downloaded or deleted.
    await expect(readFile(target, "utf-8")).resolves.toBe("AAAABBBB");
    expect(cap.box.d?.outcome).toBe("resumed");
    expect(cap.box.d?.discarded).toBe(false);
  });

  it("(b) treats an X-Linked-Etag that differs only by quoting / W/ / case as UNCHANGED — resume proceeds (#467)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://huggingface.co/org/repo/resolve/main/normalize.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    await writeFile(partial, "AAAA");
    // Partial captured a content-addressed, bare, upper-case hex hash (line-3 marker).
    await writeFile(sidecar, "DEADBEEFCAFE\n\nxet");

    // Hop 1: resolve 302 reports the SAME hash but weak-prefixed, quoted, lower-case.
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://cas-bridge.xethub.hf.co/xet-bridge-us/obj?sig=abc",
          "x-linked-etag": 'W/"deadbeefcafe"',
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/8" },
      }),
    );

    const cap = resumeCapture();
    const target = await downloadModel(
      url, "diffusion_models", "normalize-out.safetensors", undefined, undefined, cap.onResume,
    );
    await expect(readFile(target, "utf-8")).resolves.toBe("AAAABBBB");
    expect(cap.box.d?.outcome).toBe("resumed");
  });

  it("(c) restarts on a GENUINELY different content hash (hex) — no corrupt append (#467/#630)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://huggingface.co/org/repo/resolve/main/genuine-change.safetensors";
    const { partial } = await cachePaths(url);
    await writeFile(partial, "AAAA");
    await writeFile(`${partial}.etag`, "aaaa1111\n\nxet"); // content-addressed old hash

    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://cas-bridge.xethub.hf.co/xet-bridge-us/obj?sig=new",
          "x-linked-etag": '"bbbb2222"', // genuinely different object
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/8" },
      }),
    );
    fetchMock.mockResolvedValueOnce(okResponse("GENUINELYNEWFULLBODY"));

    const cap = resumeCapture();
    const target = await downloadModel(
      url, "diffusion_models", "genuine-change-out.safetensors", undefined, undefined, cap.onResume,
    );
    // The stale prefix was NOT spliced onto the new object — full re-download.
    await expect(readFile(target, "utf-8")).resolves.toBe("GENUINELYNEWFULLBODY");
    expect(cap.box.d?.outcome).toBe("declined:etag-changed");
  });

  it("(d) a restart decision completes within the SAME call — no second identical call required (#467)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://huggingface.co/org/repo/resolve/main/single-call.safetensors";
    const { partial } = await cachePaths(url);
    await writeFile(partial, "AAAA");
    await writeFile(`${partial}.etag`, '"xet-OLD"\n\nxet'); // content-addressed prior

    // A genuine change forces a restart decision mid-call.
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://cas-bridge.xethub.hf.co/xet-bridge-us/obj?sig=z",
          "x-linked-etag": '"xet-NEW"',
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/8" },
      }),
    );
    fetchMock.mockResolvedValueOnce(okResponse("COMPLETEDINONECALL"));

    // ONE call resolves — it does not throw and does not need a manual retry.
    const target = await downloadModel(url, "diffusion_models", "single-call-out.safetensors");
    await expect(readFile(target, "utf-8")).resolves.toBe("COMPLETEDINONECALL");
    // Exactly the two resume hops + one restart fetch — a single downloadModel call.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does NOT trust a PLAIN/legacy (non-content-hash) validator that coincidentally normalizes equal to a resolve X-Linked-Etag — restarts, never appends (#467 false-negative)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://huggingface.co/org/repo/resolve/main/namespace-collision.safetensors";
    const { partial } = await cachePaths(url);
    await writeFile(partial, "AAAA");
    // A BARE (un-prefixed) sidecar: a plain ETag / legacy value, NOT a content hash.
    // Its hex happens to equal a DIFFERENT object's X-Linked-Etag after normalization.
    await writeFile(`${partial}.etag`, "deadbeef");

    // Hop 1: resolve 302 for a genuinely DIFFERENT object whose content hash is the
    // same hex string (weak-prefixed + quoted) — a namespace collision, not the same
    // bytes. It must NOT be trusted to prove the cross-origin 206 unchanged.
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://cas-bridge.xethub.hf.co/xet-bridge-us/obj?sig=q",
          "x-linked-etag": 'W/"deadbeef"',
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/8" },
      }),
    );
    // Same-call restart rather than a corrupt append.
    fetchMock.mockResolvedValueOnce(okResponse("SAFE-FULL-REDOWNLOAD"));

    const cap = resumeCapture();
    const target = await downloadModel(
      url, "diffusion_models", "namespace-collision-out.safetensors", undefined, undefined, cap.onResume,
    );
    // The stale prefix was NEVER spliced under the collision — full re-download.
    await expect(readFile(target, "utf-8")).resolves.toBe("SAFE-FULL-REDOWNLOAD");
    // A plain prior can't PROVE unchanged cross-origin → unverifiable, not resumed.
    expect(cap.box.d?.outcome).toBe("declined:unverifiable");
  });

  it("(P0a) does NOT tag a plain-ETag fallback as content-hash when X-Linked-Etag is EMPTY (#467)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/empty-xlinked.safetensors";
    const { partial, sidecar } = await cachePaths(url);

    // Fresh 200 with an EMPTY x-linked-etag header (present but blank) + a plain ETag.
    // extractValidator falls back to the plain ETag; that fallback must NOT be flagged
    // content-hash (no line-3 `xet` marker), else it could later normalize-match a
    // different object's X-Linked-Etag and append onto a stale prefix.
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode("half")); c.close(); },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        statusText: "OK",
        headers: { "content-length": "1000", "x-linked-etag": "  ", etag: '"plain-etag-v1"' },
      }),
    );

    await expect(
      downloadModel(url, "checkpoints", "empty-xlinked-out.safetensors"),
    ).rejects.toThrow(/truncat/i);

    await expect(stat(partial)).resolves.toBeTruthy();
    // Plain validator + total, NO `xet` marker line → read back as contentHash:false.
    await expect(readFile(sidecar, "utf-8")).resolves.toBe('"plain-etag-v1"\n1000');
  });

  it("(P0b) treats a legacy sidecar whose line-1 value literally starts with 'xet:' as PLAIN (no line-3 marker) — never appends cross-origin (#467)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://huggingface.co/org/repo/resolve/main/literal-xet.safetensors";
    const { partial } = await cachePaths(url);
    await writeFile(partial, "AAAA");
    // A legacy/plain sidecar whose VALUE happens to be the literal text "xet:deadbeef"
    // and has NO line-3 provenance marker. It must be read as a PLAIN validator
    // (contentHash:false), not mis-parsed as content-hash-tagged.
    await writeFile(`${partial}.etag`, "xet:deadbeef");

    // Cross-origin resolve advertising a hash that would normalize-match the literal
    // value's tail — must NOT be trusted, since the prior is plain.
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://cas-bridge.xethub.hf.co/xet-bridge-us/obj?sig=q",
          "x-linked-etag": '"xet:deadbeef"',
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/8" },
      }),
    );
    fetchMock.mockResolvedValueOnce(okResponse("PLAIN-LITERAL-REDOWNLOAD"));

    const cap = resumeCapture();
    const target = await downloadModel(
      url, "diffusion_models", "literal-xet-out.safetensors", undefined, undefined, cap.onResume,
    );
    await expect(readFile(target, "utf-8")).resolves.toBe("PLAIN-LITERAL-REDOWNLOAD");
    expect(cap.box.d?.outcome).toBe("declined:unverifiable");
  });

  it("(P0c) FAILS the restart (never pairs new bytes with a stale sidecar) when the stale sidecar can't be removed or emptied (#467)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/stuck-sidecar.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    await writeFile(partial, "AAAA");
    // Make the sidecar PATH a directory so both rm (non-empty dir) AND truncate-to-file
    // fail — the restart must fail rather than leave new bytes paired with a stale flag.
    await fsPromises.mkdir(sidecar, { recursive: true });
    await fsPromises.writeFile(join(sidecar, "blocker"), "x"); // non-empty ⇒ rm fails

    // A no-validator resume declines and would restart with a full 200 — but the
    // stale-sidecar neutralization must gate that restart.
    fetchMock.mockResolvedValueOnce(okResponse("SHOULD-NOT-LAND"));

    await expect(
      downloadModel(url, "checkpoints", "stuck-sidecar-out.safetensors"),
    ).rejects.toThrow(/remove or empty the stale resume-validator sidecar|restart failed/i);
  });

  it("does NOT coalesce same-URL downloads carrying DIFFERENT auth headers — each gets its own bytes (#467 P1-2)", async () => {
    const { downloadWithCache } = await import("../../services/download-cache.js");
    await fsPromises.mkdir(comfyDir, { recursive: true });
    const url = "https://example.com/models/gated.safetensors";
    // Two users, two tokens → two representations. They must NOT share a stream.
    fetchMock.mockResolvedValueOnce(okResponse("ALICE-ONLY-BYTES"));
    fetchMock.mockResolvedValueOnce(okResponse("BOB-ONLY-BYTES"));

    const alice = join(comfyDir, "alice.safetensors");
    const bob = join(comfyDir, "bob.safetensors");
    await downloadWithCache({ url, headers: { Authorization: "Bearer alice" }, targetPath: alice });
    await downloadWithCache({ url, headers: { Authorization: "Bearer bob" }, targetPath: bob });

    // Separate representations → separate fetches, no cache coalescing.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(readFile(alice, "utf-8")).resolves.toBe("ALICE-ONLY-BYTES");
    await expect(readFile(bob, "utf-8")).resolves.toBe("BOB-ONLY-BYTES");
  });

  it("separates same-URL downloads by ANY custom auth header, not just known names (#467 P1-2)", async () => {
    const { downloadWithCache } = await import("../../services/download-cache.js");
    await fsPromises.mkdir(comfyDir, { recursive: true });
    const url = "https://example.com/models/customhdr.safetensors";
    // A NON-allowlisted custom auth header still selects a distinct representation.
    fetchMock.mockResolvedValueOnce(okResponse("ALICE-CUSTOM"));
    fetchMock.mockResolvedValueOnce(okResponse("BOB-CUSTOM"));

    const alice = join(comfyDir, "ca.safetensors");
    const bob = join(comfyDir, "cb.safetensors");
    await downloadWithCache({ url, headers: { "X-Custom-Auth": "alice" }, targetPath: alice });
    await downloadWithCache({ url, headers: { "X-Custom-Auth": "bob" }, targetPath: bob });

    expect(fetchMock).toHaveBeenCalledTimes(2); // NOT coalesced despite same URL
    await expect(readFile(alice, "utf-8")).resolves.toBe("ALICE-CUSTOM");
    await expect(readFile(bob, "utf-8")).resolves.toBe("BOB-CUSTOM");
  });

  it("DOES cache/coalesce same-URL downloads with the SAME auth header (public dedup preserved) (#467 P1-2)", async () => {
    const { downloadWithCache } = await import("../../services/download-cache.js");
    await fsPromises.mkdir(comfyDir, { recursive: true });
    const url = "https://example.com/models/sameauth.safetensors";
    fetchMock.mockResolvedValueOnce(okResponse("SHARED-BYTES"));

    const one = join(comfyDir, "one.safetensors");
    const two = join(comfyDir, "two.safetensors");
    await downloadWithCache({ url, headers: { Authorization: "Bearer same" }, targetPath: one });
    await downloadWithCache({ url, headers: { Authorization: "Bearer same" }, targetPath: two });

    // Identical representation → second call is a cache hit, only one fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(readFile(one, "utf-8")).resolves.toBe("SHARED-BYTES");
    await expect(readFile(two, "utf-8")).resolves.toBe("SHARED-BYTES");
  });

  it("reports the resume decision ONLY to the physical stream's caller; a COALESCED consumer gets none (#467 P1-b)", async () => {
    const { downloadWithCache } = await import("../../services/download-cache.js");
    await fsPromises.mkdir(cacheDir, { recursive: true });
    await fsPromises.mkdir(comfyDir, { recursive: true });
    const url = "https://example.com/models/coalesce-diag.safetensors";
    const hash = cacheHashFor(url);
    // Validator-less partial → the ONE physical download declines + reports.
    await writeFile(join(cacheDir, `.${hash}.safetensors.partial`), "OLDPARTIALBYTES");

    // A single, initially-pending fetch — both callers coalesce onto it.
    let release!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((res) => {
        release = res;
      }),
    );

    const capA = resumeCapture();
    const capB = resumeCapture();
    const a = downloadWithCache({ url, headers: {}, targetPath: join(comfyDir, "a.safetensors"), onResume: capA.onResume });
    const b = downloadWithCache({ url, headers: {}, targetPath: join(comfyDir, "b.safetensors"), onResume: capB.onResume });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1)); // coalesced to ONE fetch
    release(okResponse("FRESHFULLBODY"));
    await Promise.all([a, b]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The stream's owner (A) got the decision; the coalesced consumer (B) got NONE
    // — no shared map to clobber, and B is never misattributed A's decision.
    expect(capA.box.d?.outcome).toBe("declined:no-validator");
    expect(capB.box.d).toBeUndefined();
  });

  it("does NOT report a resume decision on a cache HIT (#467)", async () => {
    const { downloadWithCache } = await import("../../services/download-cache.js");
    await fsPromises.mkdir(cacheDir, { recursive: true });
    await fsPromises.mkdir(comfyDir, { recursive: true });
    const url = "https://example.com/models/cachehit-clear.safetensors";
    const hash = cacheHashFor(url);
    // A COMPLETE cache entry → this download is a hit (no fetch, no streamUrlToFile).
    await writeFile(join(cacheDir, `${hash}.safetensors`), "CACHED-BYTES");

    const cap = resumeCapture();
    await downloadWithCache({ url, headers: {}, targetPath: join(comfyDir, "ch.safetensors"), onResume: cap.onResume });

    expect(fetchMock).not.toHaveBeenCalled(); // served from cache
    // No resume/discard happened, so nothing is reported (can't be misattributed).
    expect(cap.box.d).toBeUndefined();
  });

  it("reports same-URL DIFFERENT-auth downloads to their OWN callers (no cross-talk) (#467 P2)", async () => {
    const { downloadWithCache } = await import("../../services/download-cache.js");
    await fsPromises.mkdir(cacheDir, { recursive: true });
    await fsPromises.mkdir(comfyDir, { recursive: true });
    const url = "https://example.com/models/p2.safetensors";
    // Alice and Bob use different auth → different physical cache identities, so
    // each seeds its OWN validator-less partial and gets its OWN decision.
    for (const who of ["alice", "bob"]) {
      const id = cacheHashFor(url, { Authorization: `Bearer ${who}` });
      await writeFile(join(cacheDir, `.${id}.safetensors.partial`), `OLD-${who}`);
    }
    fetchMock.mockResolvedValueOnce(okResponse("ALICE-FRESH"));
    fetchMock.mockResolvedValueOnce(okResponse("BOB-FRESH"));

    const capA = resumeCapture();
    const capB = resumeCapture();
    await downloadWithCache({ url, headers: { Authorization: "Bearer alice" }, targetPath: join(comfyDir, "pa.safetensors"), onResume: capA.onResume });
    await downloadWithCache({ url, headers: { Authorization: "Bearer bob" }, targetPath: join(comfyDir, "pb.safetensors"), onResume: capB.onResume });

    // Each caller received its own decline — no shared key, no cross-talk.
    expect(capA.box.d?.outcome).toBe("declined:no-validator");
    expect(capB.box.d?.outcome).toBe("declined:no-validator");
  });

  it("cloudPrincipalKey separates S3/Azure principals by EXPLICIT auth AND env creds (#467 P1-B)", async () => {
    const { cloudPrincipalKey } = await import("../../services/storage/index.js");
    const s3url = "s3://bucket/key.safetensors";
    // Explicit different access keys → different principals.
    const alice = cloudPrincipalKey(s3url, { s3: { access_key_id: "AK-ALICE", secret_access_key: "x" } });
    const bob = cloudPrincipalKey(s3url, { s3: { access_key_id: "AK-BOB", secret_access_key: "x" } });
    expect(alice).not.toBe(bob);
    expect(alice).toBeTruthy();

    // ENV-derived creds also participate (the cross-principal-leak fix): an
    // env-authenticated principal must differ from anonymous.
    const prev = process.env.AWS_ACCESS_KEY_ID;
    process.env.AWS_ACCESS_KEY_ID = "AK-FROM-ENV";
    const envKey = cloudPrincipalKey(s3url, {});
    delete process.env.AWS_ACCESS_KEY_ID;
    const anonKey = cloudPrincipalKey(s3url, {});
    if (prev !== undefined) process.env.AWS_ACCESS_KEY_ID = prev;
    expect(envKey).not.toBe(anonKey);

    // Azure env connection-string participates too.
    const azUrl = "https://acct.blob.core.windows.net/c/blob.bin";
    const prevAz = process.env.AZURE_STORAGE_CONNECTION_STRING;
    process.env.AZURE_STORAGE_CONNECTION_STRING = "AccountName=acct;AccountKey=KKK==";
    const azEnv = cloudPrincipalKey(azUrl, {});
    delete process.env.AZURE_STORAGE_CONNECTION_STRING;
    const azAnon = cloudPrincipalKey(azUrl, {});
    if (prevAz !== undefined) process.env.AZURE_STORAGE_CONNECTION_STRING = prevAz;
    expect(azEnv).not.toBe(azAnon);

    // Ambient (no explicit key) is STABLE within a process (same nonce) so in-process
    // cache hits stay safe; explicit auth is stable too.
    expect(cloudPrincipalKey(s3url, {})).toBe(cloudPrincipalKey(s3url, {}));
    expect(alice).toBe(cloudPrincipalKey(s3url, { s3: { access_key_id: "AK-ALICE", secret_access_key: "x" } }));

    // SDK-level endpoint env vars change the EFFECTIVE endpoint even with explicit
    // creds → must change the identity (#467 P1-B).
    const explicit = { s3: { access_key_id: "AK", secret_access_key: "x" } };
    const baseline = cloudPrincipalKey(s3url, explicit);
    const prevEp = process.env.AWS_ENDPOINT_URL_S3;
    process.env.AWS_ENDPOINT_URL_S3 = "https://minio.internal:9000";
    const withEp = cloudPrincipalKey(s3url, explicit);
    if (prevEp !== undefined) process.env.AWS_ENDPOINT_URL_S3 = prevEp;
    else delete process.env.AWS_ENDPOINT_URL_S3;
    expect(withEp).not.toBe(baseline);

    // A non-cloud URL contributes no cloud discriminator.
    expect(cloudPrincipalKey("https://example.com/x.safetensors", {})).toBe("");
  });

  it("materializes concurrent same-destination DIFFERENT-representation downloads without poisoning either cache entry (#467)", async () => {
    const { downloadWithCache } = await import("../../services/download-cache.js");
    await fsPromises.mkdir(cacheDir, { recursive: true });
    await fsPromises.mkdir(comfyDir, { recursive: true });
    const url = "https://example.com/models/samedest.safetensors";
    // Two representations (different auth) → two distinct cache entries. Return the
    // body by Authorization header (NOT call order — the two downloads race under
    // Promise.all), so each representation deterministically gets its own bytes and
    // any cross-contamination would be a genuine cache poison, not a mock artifact.
    fetchMock.mockImplementation((_u: string, init: { headers?: Record<string, string> }) =>
      Promise.resolve(
        okResponse(init?.headers?.Authorization === "Bearer alice" ? "ALICE-CACHE-BYTES" : "BOB-CACHE-BYTES"),
      ),
    );
    // ...materialized to the SAME on-disk destination (concurrent writers).
    const dest = join(comfyDir, "same.safetensors");
    await Promise.all([
      downloadWithCache({ url, headers: { Authorization: "Bearer alice" }, targetPath: dest }),
      downloadWithCache({ url, headers: { Authorization: "Bearer bob" }, targetPath: dest }),
    ]);

    // Each cache entry must retain ITS OWN bytes — the atomic temp+rename
    // materialize must never write through a hardlink into the other's inode.
    const aHash = cacheHashFor(url, { Authorization: "Bearer alice" });
    const bHash = cacheHashFor(url, { Authorization: "Bearer bob" });
    await expect(readFile(join(cacheDir, `${aHash}.safetensors`), "utf-8")).resolves.toBe("ALICE-CACHE-BYTES");
    await expect(readFile(join(cacheDir, `${bHash}.safetensors`), "utf-8")).resolves.toBe("BOB-CACHE-BYTES");
    // The destination holds one of the two (last writer wins) — but a VALID one.
    expect(["ALICE-CACHE-BYTES", "BOB-CACHE-BYTES"]).toContain(await readFile(dest, "utf-8"));
    // No leftover temp materialization files.
    const leftovers = (await readdir(comfyDir)).filter((f) => f.includes(".mat-"));
    expect(leftovers).toHaveLength(0);
  });

  it("direct-fallback (materialize failed) does NOT write through a destination hardlink into a cache inode (#467)", async () => {
    const { downloadWithCache } = await import("../../services/download-cache.js");
    await fsPromises.mkdir(cacheDir, { recursive: true });
    await fsPromises.mkdir(comfyDir, { recursive: true });

    // A pre-existing WINNER cache entry, with the destination HARDLINKED to it (as a
    // concurrent successful materialize would leave it).
    const winnerCache = join(cacheDir, "winner.safetensors");
    await writeFile(winnerCache, "WINNER-BYTES");
    const dest = join(comfyDir, "same.safetensors");
    await fsPromises.link(winnerCache, dest); // dest shares WINNER's inode

    // Force materialize to fail at its link/copy stage — BEFORE it touches dest — so
    // downloadWithCache takes the DIRECT fallback while dest is STILL hardlinked to
    // the winner's cache inode (the poison window). link/copyFile are used ONLY by
    // materializeCacheFile, so this doesn't disturb the cache write.
    const linkSpy = vi
      .spyOn(downloadCacheFs, "link")
      .mockRejectedValue(Object.assign(new Error("EXDEV"), { code: "EXDEV" }));
    const copySpy = vi
      .spyOn(downloadCacheFs, "copyFile")
      .mockRejectedValue(Object.assign(new Error("EIO"), { code: "EIO" }));

    const url = "https://example.com/models/fallback-poison.safetensors";
    // Fresh Response per call (cache-write fetch + fallback fetch) — a body streams once.
    fetchMock.mockImplementation(() => Promise.resolve(okResponse("LOSER-FRESH-BYTES")));

    await downloadWithCache({ url, headers: {}, targetPath: dest });

    // The WINNER cache inode must be UNTOUCHED — the fallback wrote a fresh temp and
    // renamed over dest, never streaming "w" THROUGH dest's hardlink into the inode.
    await expect(readFile(winnerCache, "utf-8")).resolves.toBe("WINNER-BYTES");
    // The destination now holds the fallback's freshly-downloaded bytes.
    await expect(readFile(dest, "utf-8")).resolves.toBe("LOSER-FRESH-BYTES");
    // No leftover fallback/materialize temp files.
    const leftovers = (await readdir(comfyDir)).filter((f) => f.includes(".dl-") || f.includes(".mat-"));
    expect(leftovers).toHaveLength(0);
    linkSpy.mockRestore();
    copySpy.mockRestore();
  });

  it("a non-Windows rename failure during materialize/fallback does NOT destroy the existing destination (#467 P1-A)", async () => {
    const { downloadWithCache } = await import("../../services/download-cache.js");
    await fsPromises.mkdir(cacheDir, { recursive: true });
    await fsPromises.mkdir(comfyDir, { recursive: true });
    const dest = join(comfyDir, "keepme.safetensors");
    await writeFile(dest, "ORIGINAL-PRECIOUS-BYTES");

    // Fail ONLY the materialize/fallback swap renames (.mat-/.dl-) with a non-Windows
    // error — the cache-write rename (.partial → cache file) must still pass through.
    const renameSpy = vi
      .spyOn(downloadCacheFs, "rename")
      .mockImplementation(async (from: string, to: string) => {
        if (String(from).includes(".mat-") || String(from).includes(".dl-")) {
          throw Object.assign(new Error("EIO: simulated non-overwrite rename failure"), { code: "EIO" });
        }
        return fsPromises.rename(from, to);
      });

    const url = "https://example.com/models/rename-eio.safetensors";
    fetchMock.mockImplementation(() => Promise.resolve(okResponse("NEW-BYTES")));

    await expect(downloadWithCache({ url, headers: {}, targetPath: dest })).rejects.toThrow(/EIO/i);

    // The EIO path must NOT have removed the destination (that rm only guards the
    // Windows overwrite errors) — the original file is intact.
    await expect(readFile(dest, "utf-8")).resolves.toBe("ORIGINAL-PRECIOUS-BYTES");
    const leftovers = (await readdir(comfyDir)).filter((f) => f.includes(".mat-") || f.includes(".dl-"));
    expect(leftovers).toHaveLength(0);
    renameSpy.mockRestore();
  });

  it("preserves the existing destination when the Windows overwrite retry itself fails (#467)", async () => {
    if (process.platform !== "win32") return; // the backup/restore path is Windows-only
    const { downloadWithCache } = await import("../../services/download-cache.js");
    await fsPromises.mkdir(cacheDir, { recursive: true });
    await fsPromises.mkdir(comfyDir, { recursive: true });
    const dest = join(comfyDir, "precious.safetensors");
    await writeFile(dest, "ORIGINAL-PRECIOUS-BYTES");

    // Force materialize to fail (link/copy) so the DIRECT fallback runs, then make
    // the fallback's temp→dest swap EPERM (triggers the Windows backup dance) and
    // its RETRY EIO (the retry itself fails) — the original dest must be restored.
    const linkSpy = vi.spyOn(downloadCacheFs, "link").mockRejectedValue(Object.assign(new Error("EXDEV"), { code: "EXDEV" }));
    const copySpy = vi.spyOn(downloadCacheFs, "copyFile").mockRejectedValue(Object.assign(new Error("EIO"), { code: "EIO" }));
    let dlToDestAttempts = 0;
    const renameSpy = vi.spyOn(downloadCacheFs, "rename").mockImplementation(async (from: string, to: string) => {
      if (String(from).includes(".dl-") && to === dest) {
        dlToDestAttempts += 1;
        // First: EPERM (can't overwrite) → backup dance. Retry: EIO (retry fails).
        throw Object.assign(new Error(dlToDestAttempts === 1 ? "EPERM" : "EIO"), { code: dlToDestAttempts === 1 ? "EPERM" : "EIO" });
      }
      return fsPromises.rename(from, to); // dest→backup and backup→dest restore run for real
    });

    const url = "https://example.com/models/winretry.safetensors";
    fetchMock.mockImplementation(() => Promise.resolve(okResponse("NEW-BYTES")));

    await expect(downloadWithCache({ url, headers: {}, targetPath: dest })).rejects.toThrow(/EIO/i);
    // The original destination was RESTORED (never lost), despite the failed retry.
    await expect(readFile(dest, "utf-8")).resolves.toBe("ORIGINAL-PRECIOUS-BYTES");
    const leftovers = (await readdir(comfyDir)).filter((f) => /\.(dl|bak)-/.test(f));
    expect(leftovers).toHaveLength(0);
    linkSpy.mockRestore();
    copySpy.mockRestore();
    renameSpy.mockRestore();
  });

  it("PRESERVES the original at a named backup when even the Windows restore fails (never lost) (#467)", async () => {
    if (process.platform !== "win32") return;
    const { downloadWithCache } = await import("../../services/download-cache.js");
    await fsPromises.mkdir(cacheDir, { recursive: true });
    await fsPromises.mkdir(comfyDir, { recursive: true });
    const dest = join(comfyDir, "precious2.safetensors");
    await writeFile(dest, "ORIGINAL-PRECIOUS-BYTES");

    const linkSpy = vi.spyOn(downloadCacheFs, "link").mockRejectedValue(Object.assign(new Error("EXDEV"), { code: "EXDEV" }));
    const copySpy = vi.spyOn(downloadCacheFs, "copyFile").mockRejectedValue(Object.assign(new Error("EIO"), { code: "EIO" }));
    let dlToDest = 0;
    const renameSpy = vi.spyOn(downloadCacheFs, "rename").mockImplementation(async (from: string, to: string) => {
      if (String(from).includes(".dl-") && to === dest) {
        dlToDest += 1;
        throw Object.assign(new Error(dlToDest === 1 ? "EPERM" : "EIO"), { code: dlToDest === 1 ? "EPERM" : "EIO" });
      }
      if (String(from).includes(".bak-") && to === dest) {
        throw Object.assign(new Error("EIO: restore failed too"), { code: "EIO" }); // restore ALSO fails
      }
      return fsPromises.rename(from, to); // dest → .bak backup succeeds
    });

    const url = "https://example.com/models/winrestorefail.safetensors";
    fetchMock.mockImplementation(() => Promise.resolve(okResponse("NEW-BYTES")));

    // The error must NAME the backup so the file is recoverable (not silently lost).
    await expect(downloadWithCache({ url, headers: {}, targetPath: dest })).rejects.toThrow(/PRESERVED at ".*\.bak-.*"/i);
    // The original bytes still exist on disk under the backup name.
    const baks = (await readdir(comfyDir)).filter((f) => f.includes(".bak-"));
    expect(baks).toHaveLength(1);
    await expect(readFile(join(comfyDir, baks[0]), "utf-8")).resolves.toBe("ORIGINAL-PRECIOUS-BYTES");
    // No leftover .dl temp.
    expect((await readdir(comfyDir)).some((f) => f.includes(".dl-"))).toBe(false);
    linkSpy.mockRestore();
    copySpy.mockRestore();
    renameSpy.mockRestore();
  });

  it("does NOT serve a LEGACY bare-URL cache entry to an unauthenticated caller — no cross-auth leak (#467 P1-C)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    await fsPromises.mkdir(comfyDir, { recursive: true });
    const url = "https://example.com/models/legacy.safetensors";
    // Simulate a PRE-upgrade entry cached under the bare-URL namespace (sha256(url),
    // no "v2" prefix) — which the OLD code ALSO used for AUTHENTICATED downloads,
    // so serving it to a new unauthenticated caller would leak auth-scoped bytes.
    const legacyHash = createHash("sha256").update(url).digest("hex").slice(0, 32);
    await writeFile(join(cacheDir, `${legacyHash}.safetensors`), "LEAKED-AUTHED-BYTES");

    fetchMock.mockResolvedValueOnce(okResponse("FRESH-PUBLIC-BYTES"));
    const { downloadWithCache } = await import("../../services/download-cache.js");
    const out = join(comfyDir, "legacy-out.safetensors");
    await downloadWithCache({ url, headers: {}, targetPath: out });

    // The legacy entry is namespaced away → a fresh download happened, no leak.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(readFile(out, "utf-8")).resolves.toBe("FRESH-PUBLIC-BYTES");
  });

  it("never serves a 0-byte cache entry as a hit — re-downloads instead (#343 edge)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/zerohit.safetensors";
    const { target } = await cachePaths(url);
    // A pre-existing empty cache file (interrupted rename / older build / tamper).
    await writeFile(target, "");

    fetchMock.mockResolvedValueOnce(okResponse("real bytes this time"));

    const out = await downloadModel(url, "checkpoints", "zerohit-out.safetensors");

    // The empty hit must NOT have short-circuited the download.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(readFile(out, "utf-8")).resolves.toBe("real bytes this time");
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

// ---------------------------------------------------------------------------
// #473: an auth/error response BODY (HTML login page / JSON error) must NEVER be
// finalized as a `.safetensors` (or any binary-model) file under a false success.
// Before this fix a 200-with-HTML/JSON body of plausible size passed the #467
// size gate and landed as a corrupt model. These drive the content-type/magic-byte
// validation: the offending download FAILS with an actionable error and NO file is
// finalized, while a legitimate binary body still succeeds.
// ---------------------------------------------------------------------------
describe("downloadModel model-payload validation (#473)", () => {
  const HTML_AUTH_PAGE =
    "<!DOCTYPE html>\n<html><head><title>Sign in</title></head>" +
    "<body><form>Please log in to CivitAI to download this model.</form></body></html>";
  const JSON_ERROR = '{"error":"Unauthorized","message":"An API key is required to download this asset."}';

  async function expectRejectedAndNoFile(
    url: string,
    subfolder: string,
    filename: string,
    response: Response,
  ) {
    fetchMock.mockResolvedValueOnce(response);
    await expect(downloadModel(url, subfolder, filename)).rejects.toThrow(/not a model file|model file/i);
    // Nothing finalized in the models dir…
    const modelsDir = join(comfyDir, "models", subfolder);
    const landed = await readdir(modelsDir).catch(() => [] as string[]);
    expect(landed).toHaveLength(0);
    // …and nothing re-servable left in the cache. NOTE: a CivitAI API download URL
    // (…/api/download/models/<id>) is EXTENSIONLESS, so its cache file has no
    // `.safetensors` suffix — an `endsWith(".safetensors")` check would miss a
    // poisoned entry entirely. Assert instead that NO finalized cache entry remains
    // (any non-dot file) and that any leftover artifact is a neutralized 0-byte file.
    const cached = await readdir(cacheDir).catch(() => [] as string[]);
    const finalized = cached.filter((f) => !f.startsWith("."));
    expect(finalized).toHaveLength(0);
    // Any leftover payload/sidecar (.partial/.etag) must be neutralized to 0 bytes so
    // it can't be resumed/re-served. The `.rejected` poison MARKER is EXEMPT — it is a
    // small non-empty sentinel that exists precisely to block a later resume.
    for (const f of cached) {
      if (f.endsWith(".rejected") || f.endsWith(".ct")) continue; // intentional sentinels
      expect((await stat(join(cacheDir, f))).size).toBe(0);
    }
  }

  it("rejects an HTML auth-challenge body saved as .safetensors (text/html)", async () => {
    await expectRejectedAndNoFile(
      "https://civitai.com/api/download/models/3174878",
      "loras",
      "gated.safetensors",
      new Response(HTML_AUTH_PAGE, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
  });

  it("rejects an HTML auth-challenge body even when mislabeled as octet-stream (magic bytes win)", async () => {
    await expectRejectedAndNoFile(
      "https://example.com/models/mislabeled.safetensors",
      "checkpoints",
      "mislabeled.safetensors",
      new Response(HTML_AUTH_PAGE, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/octet-stream" },
      }),
    );
  });

  it("rejects a UTF-16LE HTML auth page saved as .safetensors", async () => {
    // A real auth page can be served UTF-16 (bytes FF FE 3C 00 …). Body magic must
    // decode the BOM and still detect the HTML (codex finding).
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]), // UTF-16LE BOM
      Buffer.from(HTML_AUTH_PAGE, "utf16le"),
    ]);
    await expectRejectedAndNoFile(
      "https://example.com/models/u16.safetensors",
      "checkpoints",
      "u16.safetensors",
      new Response(utf16, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html; charset=utf-16le" },
      }),
    );
  });

  it("rejects a JSON error body saved as .safetensors", async () => {
    await expectRejectedAndNoFile(
      "https://civitai.com/api/download/models/999",
      "loras",
      "err.safetensors",
      new Response(JSON_ERROR, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      }),
    );
  });

  it("rejects an HTML body saved as .pt2 (a non-safetensors binary model format)", async () => {
    await expectRejectedAndNoFile(
      "https://example.com/models/x.pt2",
      "checkpoints",
      "x.pt2",
      new Response(HTML_AUTH_PAGE, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
      }),
    );
  });

  it("surfaces an actionable CivitAI token hint for a CivitAI auth challenge", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(HTML_AUTH_PAGE, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
      }),
    );
    await expect(
      downloadModel("https://civitai.com/api/download/models/1", "loras", "c.safetensors"),
    ).rejects.toThrow(/CIVITAI_API_TOKEN/);
  });

  it("still succeeds for a legitimate binary model body (GGUF magic)", async () => {
    // A real binary payload — leading "GGUF" magic, then bytes that are not text.
    const gguf = Buffer.concat([Buffer.from("GGUF"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00])]);
    fetchMock.mockResolvedValueOnce(
      new Response(gguf, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const out = await downloadModel(
      "https://example.com/models/legit.gguf",
      "checkpoints",
      "legit.gguf",
    );
    expect((await stat(out)).size).toBe(gguf.length);
  });

  it("does NOT reject a legit safetensors whose LE header length starts with byte 0x3C ('<')", async () => {
    // A real safetensors with a 60-byte JSON header: first 8 bytes are the LE length
    // (60 = 0x3C, then NUL padding), so byte 0 is '<'. The NUL bytes that follow prove
    // it is binary, so it must NOT be misclassified as an HTML page (codex finding).
    const header = Buffer.from('{"__metadata__":{"format":"pt"},"a":{"x":1}}'.padEnd(60, " "));
    const lenPrefix = Buffer.alloc(8);
    lenPrefix.writeUInt32LE(header.length, 0); // 60 -> 0x3C 0x00 0x00 0x00 ...
    const body = Buffer.concat([lenPrefix, header, Buffer.from([0x00, 0x11, 0x22, 0x33])]);
    expect(body[0]).toBe(0x3c); // sanity: leading byte is '<'
    fetchMock.mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const out = await downloadModel(
      "https://example.com/models/hdr60.safetensors",
      "checkpoints",
      "hdr60.safetensors",
    );
    expect((await stat(out)).size).toBe(body.length);
  });

  it("does NOT reject a raw .bin binary that happens to start with '<' but is not UTF-8 text", async () => {
    // A generic binary payload whose first byte is '<' (0x3C) followed by bytes that
    // are NOT valid UTF-8 text (bare continuation / invalid lead bytes). Must stay
    // "binary" and download successfully (codex false-positive concern).
    const body = Buffer.from([
      0x3c, 0x80, 0x81, 0xff, 0xfe, 0x3c, 0x00, 0x9a, 0xc0, 0xc1, 0x3c, 0x42, 0x13, 0x37,
    ]);
    fetchMock.mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const out = await downloadModel(
      "https://example.com/models/raw.bin",
      "checkpoints",
      "raw.bin",
    );
    expect((await stat(out)).size).toBe(body.length);
  });

  it("rejects a cached HTML payload on a later cache-hit (per-caller cache gate)", async () => {
    // Poison the cache via a NON-model destination (.json — not validated at stream
    // time), then a .safetensors caller that HITS the same cache entry must still be
    // rejected by the per-caller cache gate, not served the corrupt bytes.
    const url = "https://example.com/models/poison.safetensors";
    fetchMock.mockResolvedValueOnce(
      new Response(HTML_AUTH_PAGE, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
      }),
    );
    // First call to a .json destination: not a model-binary ext, so it caches the
    // HTML body without rejection.
    await downloadModel(url, "checkpoints", "poison.json");
    // Second call, SAME url → cache hit, but destination is .safetensors → rejected.
    await expect(
      downloadModel(url, "loras", "poison.safetensors"),
    ).rejects.toThrow(/not a model file|model file/i);
    const landed = await readdir(join(comfyDir, "models", "loras")).catch(() => [] as string[]);
    expect(landed).toHaveLength(0);
  });

  it("rejects a JSON auth/error body with a non-ASCII (UTF-8) message", async () => {
    await expectRejectedAndNoFile(
      "https://example.com/models/utf8err.safetensors",
      "checkpoints",
      "utf8err.safetensors",
      new Response('{"error":"Неавторизованный запрос — требуется ключ API"}', {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    );
  });

  it("does NOT reject a JSON body for a non-model destination extension (.json config)", async () => {
    // A legitimate `{...}` JSON download to a `.json` sidecar must be untouched by
    // the binary-model validation — we validate by what the destination IS.
    fetchMock.mockResolvedValueOnce(
      new Response('{"scheduler":"ddim"}', {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      }),
    );
    const out = await downloadModel(
      "https://example.com/configs/model_index.json",
      "checkpoints",
      "model_index.json",
    );
    await expect(readFile(out, "utf-8")).resolves.toBe('{"scheduler":"ddim"}');
  });

  // --- codex re-review regressions (P0-1 / P0-2 / P1) -----------------------

  it("rejects a valid HTML page whose only 'control' byte is a form-feed (P0-1, octet-stream)", async () => {
    // FF (\f, 0x0C) is valid HTML whitespace. Before the fix the detector treated it
    // as proof-of-binary and, with a mislabeled octet-stream Content-Type, let the
    // login page finalize as a model. It must be rejected by BODY MAGIC alone.
    await expectRejectedAndNoFile(
      "https://example.com/models/ff.safetensors",
      "checkpoints",
      "ff.safetensors",
      new Response("<html>\f<body>Sign in to download</body></html>", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/octet-stream" },
      }),
    );
  });

  it("rejects an HTML page that LEADS with a form-feed before the tag (P0-1, octet-stream)", async () => {
    // `\f<!DOCTYPE html>…` — the form-feed comes BEFORE the `<`. The leading-whitespace
    // skip must treat \f/\v as whitespace so the FIRST scrutinized char is the tag, not
    // the control byte (else it misclassifies as binary). Rejected by body magic alone.
    await expectRejectedAndNoFile(
      "https://example.com/models/leadff.safetensors",
      "checkpoints",
      "leadff.safetensors",
      new Response("\f\v<!DOCTYPE html><html><body>Sign in</body></html>", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/octet-stream" },
      }),
    );
  });

  it("rejects a UTF-16LE HTML page that LEADS with a form-feed (P0-1, decoded path)", async () => {
    // Same leading-\f case through the UTF-16 decode path (classifyDecodedText).
    const body = Buffer.concat([
      Buffer.from([0xff, 0xfe]), // UTF-16LE BOM
      Buffer.from("\f<!DOCTYPE html><html>Sign in</html>", "utf16le"),
    ]);
    await expectRejectedAndNoFile(
      "https://example.com/models/leadff16.safetensors",
      "checkpoints",
      "leadff16.safetensors",
      new Response(body, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/octet-stream" },
      }),
    );
  });

  it("rejects a form-feed HTML page served as text/html (P0-1, content-type belt)", async () => {
    await expectRejectedAndNoFile(
      "https://civitai.com/api/download/models/3174878",
      "loras",
      "ff2.safetensors",
      new Response("<html>\f<body>Sign in</body></html>", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
  });

  it("rejects a plausibly-sized auth page whose stray control byte breaks the text sniff (P0-1 belt)", async () => {
    // The body carries a raw NUL (0x00) so it can't sniff as UTF-8 text, yet the
    // server LABELS it text/html — the Content-Type belt must reject it regardless.
    await expectRejectedAndNoFile(
      "https://example.com/models/ctl.safetensors",
      "checkpoints",
      "ctl.safetensors",
      new Response(Buffer.from("<html>\x00<body>Sign in</body></html>"), {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
      }),
    );
  });

  it("does NOT reject a raw .bin whose first 64 bytes are printable and START with '<' (P0-2 false-negative)", async () => {
    // The classic false-negative: `<` + 63 printable chars (a full 64-byte sniff of
    // pure ASCII) followed by real binary bytes. Looking at only ~64 bytes would
    // classify it HTML and REJECT a legitimate download. The whole-window text
    // requirement must see the trailing binary and ACCEPT it.
    const body = Buffer.concat([
      Buffer.from("<" + "A".repeat(63)),
      Buffer.from([0x00, 0x80, 0xff]),
    ]);
    fetchMock.mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const out = await downloadModel(
      "https://example.com/models/printable-prefix.bin",
      "checkpoints",
      "printable-prefix.bin",
    );
    expect((await stat(out)).size).toBe(body.length);
  });

  it("rejects a UTF-16BE HTML auth page saved as .safetensors (P0-1 UTF-16 BE)", async () => {
    // A big-endian UTF-16 auth page: BOM FE FF, then each code unit high-byte first.
    const le = Buffer.from("<html><body>Sign in</body></html>", "utf16le");
    const be = Buffer.alloc(le.length);
    for (let k = 0; k < le.length; k += 2) {
      be[k] = le[k + 1];
      be[k + 1] = le[k];
    }
    const body = Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
    await expectRejectedAndNoFile(
      "https://example.com/models/u16be.safetensors",
      "checkpoints",
      "u16be.safetensors",
      new Response(body, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/octet-stream" },
      }),
    );
  });

  it("rejects a UTF-16LE JSON error body saved as .safetensors (P0-1 UTF-16 JSON)", async () => {
    const body = Buffer.concat([
      Buffer.from([0xff, 0xfe]), // UTF-16LE BOM
      Buffer.from('{"error":"Unauthorized"}', "utf16le"),
    ]);
    await expectRejectedAndNoFile(
      "https://example.com/models/u16json.safetensors",
      "checkpoints",
      "u16json.safetensors",
      new Response(body, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/octet-stream" },
      }),
    );
  });

  it("leaves NO resumable poisoned partial after an HTML rejection — a retry restarts clean (P1)", async () => {
    const url = "https://civitai.com/api/download/models/77777";
    // First attempt: an HTML auth page carrying an ETag (which would normally seed a
    // resume sidecar) — it must be rejected and its partial+sidecar discarded.
    fetchMock.mockResolvedValueOnce(
      new Response("<!DOCTYPE html><html><body>Sign in</body></html>", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html", etag: '"abc123"' },
      }),
    );
    await expect(
      downloadModel(url, "loras", "retry.safetensors"),
    ).rejects.toThrow(/not a model file|model file/i);
    // No non-dot cache file, and any leftover .partial/.etag is neutralized (0 bytes).
    const afterReject = await readdir(cacheDir).catch(() => [] as string[]);
    expect(afterReject.filter((f) => !f.startsWith("."))).toHaveLength(0);
    for (const f of afterReject) {
      if (f.endsWith(".rejected") || f.endsWith(".ct")) continue; // intentional sentinels
      expect((await stat(join(cacheDir, f))).size).toBe(0);
    }
    // Second attempt: a real binary model. It must NOT resume onto the poisoned
    // prefix — it downloads clean and finalizes at the correct size.
    const gguf = Buffer.concat([Buffer.from("GGUF"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04])]);
    fetchMock.mockResolvedValueOnce(
      new Response(gguf, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const out = await downloadModel(url, "loras", "retry.safetensors");
    expect((await stat(out)).size).toBe(gguf.length);
  });

  it("does NOT resume onto a leftover REJECTED (HTML) partial even if cleanup earlier failed — re-inspects and restarts fresh (P1 worst-case)", async () => {
    // Simulate the worst case: a prior rejection could NOT remove/truncate the
    // poisoned partial, so both the HTML .partial AND a resume sidecar survive on
    // disk. The next attempt must re-inspect the partial's head, refuse to resume onto
    // the poison, and restart from 0 — regardless of whether cleanup ever succeeded.
    const url = "https://example.com/models/leftover.safetensors";
    const hash = cacheHashFor(url);
    await mkdir(cacheDir, { recursive: true });
    const partial = join(cacheDir, `.${hash}.safetensors.partial`);
    await writeFile(partial, "<!DOCTYPE html><html><body>Sign in to download</body></html>");
    await writeFile(`${partial}.etag`, '"deadbeef"'); // a validator that would enable If-Range
    // A clean binary model is served now.
    const gguf = Buffer.concat([Buffer.from("GGUF"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04])]);
    fetchMock.mockResolvedValueOnce(
      new Response(gguf, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const out = await downloadModel(url, "checkpoints", "leftover.safetensors");
    expect((await stat(out)).size).toBe(gguf.length);
    // The request must NOT have carried a Range header — proof we did not resume onto
    // the poisoned prefix.
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const sentHeaders = (init.headers ?? {}) as Record<string, string>;
    expect(sentHeaders.Range).toBeUndefined();
  });

  it("does NOT resume a partial carrying a poison MARKER even when its bytes sniff as binary (P1 content-type-only)", async () => {
    // The content-type-only rejection case: a prior attempt rejected the download
    // purely on its Content-Type (gone by retry) and dropped a `.rejected` marker; the
    // leftover partial's bytes look BINARY (so body-magic alone wouldn't flag them).
    // The marker guard must still refuse the resume and restart fresh.
    const url = "https://example.com/models/marked.safetensors";
    const hash = cacheHashFor(url);
    await mkdir(cacheDir, { recursive: true });
    const partial = join(cacheDir, `.${hash}.safetensors.partial`);
    await writeFile(partial, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]));
    await writeFile(`${partial}.etag`, '"cafef00d"'); // would enable If-Range
    await writeFile(`${partial}.rejected`, "rejected-non-model-payload");
    const gguf = Buffer.concat([Buffer.from("GGUF"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04])]);
    fetchMock.mockResolvedValueOnce(
      new Response(gguf, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const out = await downloadModel(url, "checkpoints", "marked.safetensors");
    expect((await stat(out)).size).toBe(gguf.length);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const sentHeaders = (init.headers ?? {}) as Record<string, string>;
    expect(sentHeaders.Range).toBeUndefined();
    // Marker cleaned up after the clean finalize.
    await expect(stat(`${partial}.rejected`)).rejects.toThrow();
  });

  it("ACCEPTS a raw .bin whose invalid UTF-8 sequence is cut off at the 512-byte sniff boundary (P0-2 edge)", async () => {
    // `<` + 509 'A' places byte 510 = 0xE0 (a 3-byte lead) with only 0x80 present after
    // it — 0xE0 requires A0..BF, so this is INVALID UTF-8, not a truncated-but-valid
    // run. The text check must validate the present continuation byte and keep it
    // BINARY (accept the download) rather than wave it through as truncated (reject).
    const body = Buffer.concat([
      Buffer.from("<" + "A".repeat(509)), // bytes 0..509
      Buffer.from([0xe0, 0x80]), // bytes 510,511 — invalid continuation at the boundary
      Buffer.from([0x11, 0x22, 0x33, 0x44]), // trailing binary (file > sniff window)
    ]);
    expect(body.length).toBeGreaterThan(512);
    fetchMock.mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const out = await downloadModel(
      "https://example.com/models/edge.bin",
      "checkpoints",
      "edge.bin",
    );
    expect((await stat(out)).size).toBe(body.length);
  });

  it("REJECTS a valid UTF-16LE HTML page whose emoji surrogate is split by the 512-byte sniff boundary (P0-1 edge)", async () => {
    // Pad so a 😀 (surrogate pair D83D DE00) lands its HIGH surrogate at bytes 510–511
    // and its LOW surrogate at 512–513 (outside the window). Decoding the raw window
    // yields a trailing lone high surrogate → U+FFFD, which would make a valid auth
    // page look binary and fail OPEN. Trimming the truncated code unit must let it
    // still classify as HTML and be REJECTED (served here as octet-stream).
    const str = "<" + "a".repeat(253) + "\u{1F600}" + "b".repeat(100);
    const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(str, "utf16le")]);
    // Sanity: the high surrogate's low byte 0x3D sits at index 510.
    expect(body[510]).toBe(0x3d);
    expect(body[511]).toBe(0xd8);
    await expectRejectedAndNoFile(
      "https://example.com/models/u16emoji.safetensors",
      "checkpoints",
      "u16emoji.safetensors",
      new Response(body, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/octet-stream" },
      }),
    );
  });

  it("rejects a Content-Type-only auth body on a later cache REUSE via the persisted Content-Type (#473 reuse gap)", async () => {
    // The body is HTML but carries an embedded NUL, so BODY MAGIC classifies it binary
    // — only the `text/html` Content-Type flags it. It is first cached through a
    // NON-model destination (.json — unvalidated), then a `.safetensors` caller reuses
    // the SAME url cache. The persisted `.ct` Content-Type sidecar must let the reuse
    // gate reject it even though the live header is gone and the bytes sniff binary.
    const url = "https://example.com/models/ct-reuse"; // extensionless → shared cache key
    fetchMock.mockResolvedValueOnce(
      new Response(Buffer.from("<html>\x00<body>Sign in</body></html>"), {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    // Cold cache via a .json (non-model) destination — no model validation, but the
    // Content-Type is persisted beside the cache file.
    await downloadModel(url, "checkpoints", "sidecar-src.json");
    // Reuse via a .safetensors destination → cache HIT → rejected by persisted CT.
    await expect(
      downloadModel(url, "loras", "reuse.safetensors"),
    ).rejects.toThrow(/not a model file|model file/i);
    const landed = await readdir(join(comfyDir, "models", "loras")).catch(() => [] as string[]);
    expect(landed).toHaveLength(0);
  });

  it("clears a STALE text/html .ct sidecar on a later clean octet-stream fill (no false rejection of a real model)", async () => {
    // Regression: a `.ct` sidecar from an earlier HTML response must NOT attach to a
    // later legitimate binary that fills the SAME cache key, or the real model would be
    // wrongly rejected on reuse. Simulate an orphaned sidecar (payload evicted, .ct
    // survived) then a clean octet-stream re-fill — it must succeed and clear the tag.
    const url = "https://example.com/models/stale-ct"; // extensionless → shared key
    const hash = cacheHashFor(url);
    await mkdir(cacheDir, { recursive: true });
    // Cold HTML via a .json (non-model) destination → writes payload + .ct=text/html.
    fetchMock.mockResolvedValueOnce(
      new Response("<html>hi</html>", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
      }),
    );
    await downloadModel(url, "checkpoints", "s.json");
    // Simulate LRU evicting the payload but ORPHANING the sidecar (rm .ct swallowed).
    await rm(join(cacheDir, hash), { force: true });
    const ct = join(cacheDir, `.${hash}.ct`);
    expect((await stat(ct)).size).toBeGreaterThan(0); // stale sidecar present
    // Now a genuine octet-stream model fills the same key (cache miss → fresh fill).
    const gguf = Buffer.concat([Buffer.from("GGUF"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04])]);
    fetchMock.mockResolvedValueOnce(
      new Response(gguf, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const out = await downloadModel(url, "loras", "clean.safetensors");
    expect((await stat(out)).size).toBe(gguf.length); // NOT rejected
    await expect(stat(ct)).rejects.toThrow(); // stale sidecar cleared
  });

  it("IGNORES a stale text/html .ct even at the SAME payload size (head fingerprint, rm-independent)", async () => {
    // Even if a stale sidecar SURVIVES on disk (its clearing rm failed) AND the
    // replacement model happens to have the EXACT same byte length as the prior HTML
    // page, it must not reject the legitimate model: the payload fingerprint hashes the
    // sniff HEAD, which differs between a binary model and an HTML page. Pre-seed a real
    // GGUF cache entry + a stale text/html sidecar whose fingerprint (any prior bytes)
    // won't match the GGUF head; a cache-HIT .safetensors caller must succeed.
    const url = "https://example.com/models/sizeguard"; // extensionless → shared key
    const hash = cacheHashFor(url);
    await mkdir(cacheDir, { recursive: true });
    const gguf = Buffer.concat([Buffer.from("GGUF"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04])]);
    await writeFile(join(cacheDir, hash), gguf); // valid cached model payload (9 bytes)
    // Stale sidecar stamped for a DIFFERENT body of the SAME 9-byte length (html head).
    await writeFile(join(cacheDir, `.${hash}.ct`), "text/html\n9:deadbeefdeadbeef");
    const out = await downloadModel(url, "loras", "sg.safetensors");
    expect((await stat(out)).size).toBe(gguf.length); // cache HIT, NOT rejected
  });
});
