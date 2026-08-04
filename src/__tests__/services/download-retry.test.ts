// #470 / #817 — a transfer that survives an interruption.
//
// Two layers are covered here:
//   1. the CLASSIFIER, in isolation: which failures may be retried at all. The
//      whole safety of automatic retry rests on this being conservative, so the
//      fatal cases are asserted as hard as the transient ones.
//   2. the RETRY LOOP end-to-end through downloadModel: that a dropped transfer
//      is resumed IN THE SAME CALL, that a cancel is never retried, and — the
//      question this cluster exists to answer — that a resumed transfer can
//      NEVER splice bytes from a different object.

import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => {
  const config = {
    comfyuiPath: undefined as string | undefined,
    huggingfaceToken: undefined as string | undefined,
    civitaiApiToken: undefined as string | undefined,
  };
  return { config, isRemoteMode: () => !config.comfyuiPath };
});

/** Every progress row the download machinery publishes. Recorded through a module
 *  mock because the real reporter writes to COMFYUI_MCP_PROGRESS_DIR, which is read
 *  from the environment at import time and so cannot be turned on from a test. What
 *  matters here is WHICH rows are emitted, not where they land. */
const progressRows = vi.hoisted(() => [] as Array<{ status: string }>);
vi.mock("../../services/download-progress.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/download-progress.js")>(
    "../../services/download-progress.js",
  );
  return {
    ...actual,
    reportDownloadProgress: (p: { status: string }) => {
      progressRows.push({ status: p.status });
    },
  };
});

/** The cloud (S3/Azure) downloader is the vendor SDK; stub it so the watchdog's
 *  behaviour around it can be exercised without a real bucket. Everything else in
 *  the storage module (URL detection, principal keying) stays real. */
vi.mock("../../services/storage/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/storage/index.js")>(
    "../../services/storage/index.js",
  );
  return { ...actual, downloadCloudUrlToFile: vi.fn() };
});

import { config } from "../../config.js";
import { downloadCacheFs } from "../../services/download-cache.js";
import { downloadModel } from "../../services/model-resolver.js";
import {
  abortableDelay,
  backoffDelayMs,
  classifyDownloadFailure,
  downloadRetryPolicy,
  setDownloadRetryPolicyForTests,
} from "../../services/download-retry.js";
import { ModelError } from "../../utils/errors.js";

describe("classifyDownloadFailure (#470)", () => {
  describe("transient — safe to retry, the partial stays resumable", () => {
    it("recognises undici's bare `terminated` — the exact failure #470 reported", () => {
      const err = new TypeError("terminated");
      const cls = classifyDownloadFailure(err);
      expect(cls.retryable).toBe(true);
      expect(cls.reason).toMatch(/dropped mid-transfer/i);
    });

    it("recognises a transport code NESTED in the cause chain, not just on the top error", () => {
      const socket = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
      const outer = Object.assign(new TypeError("fetch failed"), { cause: socket });
      // `fetch failed` alone is NOT in the fragment list — this must pass on the
      // nested CODE, which is what proves the cause walk is doing the work.
      expect(classifyDownloadFailure(outer).retryable).toBe(true);
      expect(classifyDownloadFailure(outer).reason).toMatch(/UND_ERR_SOCKET/);
    });

    it("recognises ECONNRESET reported on a ModelError's details (fetchOrThrow's shape)", () => {
      const err = new ModelError("Download request ... failed", { code: "ECONNRESET" });
      expect(classifyDownloadFailure(err).retryable).toBe(true);
    });

    it("retries the back-off statuses the host itself asks for, and 5xx", () => {
      for (const status of [408, 429, 500, 502, 503, 504]) {
        expect(classifyDownloadFailure(new ModelError("x", { status })).retryable).toBe(true);
      }
    });

    it("honours an explicit `retryable: true` contract from the raising code", () => {
      // This is how download-cache flags a truncated body whose partial is a valid
      // prefix. Message-independent by design.
      const err = new ModelError("anything at all", { retryable: true });
      expect(classifyDownloadFailure(err).retryable).toBe(true);
    });
  });

  describe("fatal — a retry cannot fix it, and hammering makes it worse", () => {
    it("does NOT retry 403 — #470 traced a 403 to an instant re-request after an abort", () => {
      const err = new ModelError("Download failed: 403 Forbidden", { status: 403 });
      const cls = classifyDownloadFailure(err);
      expect(cls.retryable).toBe(false);
      expect(cls.reason).toMatch(/403/);
    });

    it("does NOT retry 401/404 (auth/gating/absent)", () => {
      for (const status of [401, 404, 410, 451]) {
        expect(classifyDownloadFailure(new ModelError("x", { status })).retryable).toBe(false);
      }
    });

    it("a DEFINITE status wins over prose that happens to contain a transient word", () => {
      // The regression this guards: a 403 whose body/message mentions a
      // "terminated" session must not fall through to the message-fragment test
      // and be retried. A known status is a definite answer in BOTH directions.
      const err = new ModelError("Download failed: 403 Forbidden — connection terminated by policy", {
        status: 403,
      });
      expect(classifyDownloadFailure(err).retryable).toBe(false);
    });

    it("honours an explicit `retryable: false` veto even for a transient-looking message", () => {
      const err = new ModelError("the connection terminated", { retryable: false });
      expect(classifyDownloadFailure(err).retryable).toBe(false);
    });

    it("does NOT retry the #473 non-model payload rejection", () => {
      const err = new ModelError(
        "Download rejected: the response body is an HTML login page, not a model payload",
      );
      expect(classifyDownloadFailure(err).retryable).toBe(false);
    });

    it("does NOT retry the #343/#467 resume-integrity refusals", () => {
      for (const message of [
        "Download resume rejected: a 206 for byte 4+ must carry a complete, consistent Content-Range",
        "Download resume rejected: the server now reports a total size of 8 bytes, but the original download recorded 4096",
        "Download oversized: wrote 900 bytes but the file is only 800",
        "Download produced a 0-byte file — the source sent no data. Removed it; retry.",
      ]) {
        expect(classifyDownloadFailure(new ModelError(message)).retryable).toBe(false);
      }
    });

    it("does NOT retry on the fetch wrapper's 'network layer' prose alone", () => {
      // fetchOrThrow wraps EVERY thrown fetch as "…failed at the network layer: …".
      // If that phrase counted as a transient signature, an expired TLS
      // certificate, a misconfigured proxy and an aborted request would all look
      // retryable — inverting this module's fail-safe default for the entire class
      // of fetch failures. The transport CODE decides instead.
      const wrapper =
        "Download request to the model host failed at the network layer: unable to verify the " +
        "first certificate. This is a connectivity/TLS/proxy failure reaching the file host.";
      expect(classifyDownloadFailure(new ModelError(wrapper)).retryable).toBe(false);
      // …and the very same wrapper WITH a transport code is still retried, so this
      // is about the prose carrying no evidence, not about distrusting the wrapper.
      expect(
        classifyDownloadFailure(new ModelError(wrapper, { code: "ECONNRESET" })).retryable,
      ).toBe(true);
    });

    it("defaults to NOT retryable for an error it does not recognise", () => {
      // The fail-safe direction: an unclassified failure behaves exactly as it did
      // before automatic retry existed.
      expect(classifyDownloadFailure(new Error("something entirely new")).retryable).toBe(false);
      expect(classifyDownloadFailure("not even an error").retryable).toBe(false);
    });
  });
});

describe("backoff schedule (#470)", () => {
  it("doubles from the base and saturates at the cap — never an instant re-request", () => {
    const p = { maxAttempts: 5, backoffBaseMs: 2000, backoffCapMs: 30_000, stallTimeoutMs: 0 };
    expect(backoffDelayMs(1, p)).toBe(2000);
    expect(backoffDelayMs(2, p)).toBe(4000);
    expect(backoffDelayMs(3, p)).toBe(8000);
    expect(backoffDelayMs(4, p)).toBe(16_000);
    expect(backoffDelayMs(5, p)).toBe(30_000); // capped, not 32000
    expect(backoffDelayMs(9, p)).toBe(30_000);
    // The FIRST wait must be a real wait: an immediate re-request is what earned
    // the 403 in #470.
    expect(backoffDelayMs(1, p)).toBeGreaterThan(0);
  });
});

describe("abortableDelay (#470)", () => {
  it("rejects immediately when the signal is already aborted", async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(abortableDelay(60_000, ctl.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("wakes EARLY on abort instead of sleeping out the full backoff", async () => {
    const ctl = new AbortController();
    const started = Date.now();
    const p = abortableDelay(30_000, ctl.signal);
    setTimeout(() => ctl.abort(), 10);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("COMFYUI_DOWNLOAD_MAX_ATTEMPTS / _STALL_TIMEOUT_S env overrides (#470/#817)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("lets an operator disable retry entirely with maxAttempts=1", () => {
    process.env.COMFYUI_DOWNLOAD_MAX_ATTEMPTS = "1";
    expect(downloadRetryPolicy().maxAttempts).toBe(1);
  });

  it("lets an operator disable the stall watchdog with 0 seconds", () => {
    process.env.COMFYUI_DOWNLOAD_STALL_TIMEOUT_S = "0";
    expect(downloadRetryPolicy().stallTimeoutMs).toBe(0);
  });

  it("ignores garbage rather than collapsing the policy to NaN", () => {
    process.env.COMFYUI_DOWNLOAD_MAX_ATTEMPTS = "banana";
    expect(downloadRetryPolicy().maxAttempts).toBeGreaterThan(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// End-to-end through downloadModel: the retry loop, the resume it performs, and
// the identity proof it must never skip.
// ───────────────────────────────────────────────────────────────────────────────

const fetchMock = vi.fn();
let tempDir: string;
let cacheDir: string;
let comfyDir: string;

function cacheHashFor(url: string): string {
  return createHash("sha256").update(`v2\n${url}`).digest("hex").slice(0, 32);
}
function cachePaths(url: string) {
  const hash = cacheHashFor(url);
  const partial = join(cacheDir, `.${hash}.safetensors.partial`);
  return { partial, sidecar: `${partial}.etag`, target: join(cacheDir, `${hash}.safetensors`) };
}

/** A 200 that DECLARES more bytes than it delivers — the shape of a transfer the
 *  network cut short. The written prefix stays on disk and is range-resumable. */
function shortBody(body: string, declaredTotal: number, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    statusText: "OK",
    headers: { "content-length": String(declaredTotal), ...headers },
  });
}

function headersOf(callIndex: number): Record<string, string> {
  const [, init] = fetchMock.mock.calls[callIndex] as [string, { headers: Record<string, string> }];
  return init.headers;
}

describe("download retry + resume, end to end (#470)", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "comfyui-mcp-retry-test-"));
    cacheDir = join(tempDir, "cache");
    comfyDir = join(tempDir, "comfy");
    process.env.COMFYUI_DOWNLOAD_CACHE_DIR = cacheDir;
    delete process.env.COMFYUI_LRU_CACHE_SIZE_GB;
    delete process.env.COMFYUI_DOWNLOAD_MAX_ATTEMPTS;
    delete process.env.COMFYUI_DOWNLOAD_STALL_TIMEOUT_S;
    config.comfyuiPath = comfyDir;
    config.huggingfaceToken = undefined;
    config.civitaiApiToken = undefined;
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    // Real retries, but with waits short enough for a test suite.
    setDownloadRetryPolicyForTests({
      maxAttempts: 3,
      backoffBaseMs: 5,
      backoffCapMs: 20,
      stallTimeoutMs: 0,
    });
    await mkdir(cacheDir, { recursive: true });
    progressRows.length = 0;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.COMFYUI_DOWNLOAD_CACHE_DIR;
    setDownloadRetryPolicyForTests({
      maxAttempts: 5,
      backoffBaseMs: 2000,
      backoffCapMs: 30_000,
      stallTimeoutMs: 120_000,
    });
    await rm(tempDir, { recursive: true, force: true });
  });

  it("resumes an interrupted transfer IN THE SAME CALL instead of losing the partial (#470)", async () => {
    const url = "https://example.com/models/interrupted.safetensors";

    // Attempt 1: declares 16 bytes, delivers 8, then the connection dies. This is
    // #470's "failed: terminated" — before the fix, the call ended here and the 8
    // bytes were only recoverable by a HUMAN re-issuing download_model.
    fetchMock.mockResolvedValueOnce(shortBody("AAAABBBB", 16, { etag: '"obj-v1"' }));
    // Attempt 2: the retry range-resumes from byte 8 and the server completes it.
    fetchMock.mockResolvedValueOnce(
      new Response("CCCCDDDD", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 8-15/16" },
      }),
    );

    const target = await downloadModel(url, "checkpoints", "interrupted-out.safetensors");

    // ONE call produced the whole file — the caller never had to notice or act.
    await expect(readFile(target, "utf-8")).resolves.toBe("AAAABBBBCCCCDDDD");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The retry RESUMED — it did not re-fetch the 8 bytes already on disk.
    expect(headersOf(0).Range).toBeUndefined();
    expect(headersOf(1).Range).toBe("bytes=8-");
    // …and it proved identity first: the validator recorded at WRITE time was
    // replayed as If-Range on the resume.
    expect(headersOf(1)["If-Range"]).toBe('"obj-v1"');
  });

  it("a resumed retry can NEVER splice bytes from a DIFFERENT object — an If-Range miss restarts", async () => {
    const url = "https://example.com/models/changed-between-attempts.safetensors";

    // Attempt 1 writes a prefix of object v1 and records v1's validator.
    fetchMock.mockResolvedValueOnce(shortBody("V1V1", 8, { etag: '"obj-v1"' }));
    // Between attempts the upstream file is REPLACED. The origin evaluates our
    // If-Range, sees a mismatch and answers 200 with the WHOLE new object.
    fetchMock.mockResolvedValueOnce(
      new Response("V2V2V2V2", { status: 200, statusText: "OK", headers: { etag: '"obj-v2"' } }),
    );

    const target = await downloadModel(url, "checkpoints", "changed-out.safetensors");

    // The decisive assertion: the file is ENTIRELY object v2. Not "V1V1V2V2V2V2",
    // which is what appending onto the stale prefix would have produced.
    await expect(readFile(target, "utf-8")).resolves.toBe("V2V2V2V2");
    expect(headersOf(1)["If-Range"]).toBe('"obj-v1"');
  });

  it("a retry with NO recorded write-time identity restarts rather than resuming blind", async () => {
    const url = "https://example.com/models/no-validator.safetensors";

    // Attempt 1: short body and NO validator header at all, so no sidecar is
    // written. The 4 bytes on disk have no recorded identity.
    fetchMock.mockResolvedValueOnce(shortBody("XXXX", 8));
    fetchMock.mockResolvedValueOnce(new Response("YYYYYYYY", { status: 200, statusText: "OK" }));

    const target = await downloadModel(url, "checkpoints", "no-validator-out.safetensors");

    // No Range was sent on the retry — an unverifiable partial is restarted, never
    // appended to. (Losing 4 bytes is the correct trade against splicing them onto
    // bytes that might belong to something else, #343/#467.)
    expect(headersOf(1).Range).toBeUndefined();
    await expect(readFile(target, "utf-8")).resolves.toBe("YYYYYYYY");
  });

  it("does NOT retry a 403 — it fetches exactly once (#470's CDN-block observation)", async () => {
    const url = "https://example.com/models/forbidden.safetensors";
    fetchMock.mockImplementation(async () => new Response("nope", { status: 403, statusText: "Forbidden" }));

    await expect(
      downloadModel(url, "checkpoints", "forbidden-out.safetensors"),
    ).rejects.toThrow(/403/);

    // Exactly one request. A retry loop that retried everything would have made
    // three — and, per #470, re-requesting an aborted URL immediately is what got
    // the reporter CDN-blocked in the first place.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after the attempt budget and reports how much progress SURVIVED", async () => {
    const url = "https://example.com/models/always-dies.safetensors";
    // Every attempt delivers a little more, then dies. Never completes.
    // A fresh Response per call — one Response object cannot be read twice.
    fetchMock.mockImplementation(async () => shortBody("AB", 100, { etag: '"stable"' }));

    const err = await downloadModel(url, "checkpoints", "always-dies-out.safetensors").catch(
      (e: unknown) => e,
    );

    expect(String((err as Error).message)).toMatch(/after 3 attempts/i);
    // The remedy must be usable from where the caller now stands: the bytes are
    // still there and re-issuing resumes them.
    expect(String((err as Error).message)).toMatch(/preserved on disk|resumes from there/i);
    // And that claim is TRUE — asserted against disk, not against the sentence.
    const { partial } = cachePaths(url);
    await expect(stat(partial).then((s) => s.size)).resolves.toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports 'no partial survived' — as a FACT, not a shrug — when no bytes were ever staged", async () => {
    // The mirror of the test above, and the reason `partialSize` separates ABSENT
    // from UNREADABLE. A 503 is retryable but never streams a body, so no .partial
    // is ever created. "There is nothing to resume" is KNOWN here, and reporting it
    // as "could not be read" would be a shrug where a fact was available — the same
    // failure mode as the reverse, just pointing the other way.
    const url = "https://example.com/models/never-staged.safetensors";
    fetchMock.mockImplementation(
      async () => new Response("upstream busy", { status: 503, statusText: "Service Unavailable" }),
    );

    const err = await downloadModel(url, "checkpoints", "never-staged-out.safetensors").catch(
      (e: unknown) => e,
    );
    const message = String((err as Error).message);
    expect(message).toMatch(/after 3 attempts/i);
    expect(message).toMatch(/No partial data survived/);
    expect(message).not.toMatch(/could NOT be read/);
    expect(message).not.toMatch(/preserved on disk/);
    // The claim is TRUE — checked against the filesystem, not against the sentence.
    const { partial } = cachePaths(url);
    await expect(stat(partial)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3); // a 503 really is retried
  });

  it("a CANCEL during backoff stops the download — it is never retried into a completion", async () => {
    const url = "https://example.com/models/cancel-mid-backoff.safetensors";
    setDownloadRetryPolicyForTests({ backoffBaseMs: 10_000, backoffCapMs: 10_000 });
    const ctl = new AbortController();

    const { partial } = cachePaths(url);
    // Attempt 1 fails transiently, so the loop enters its (10s) backoff. Fire the
    // cancel only once attempt 1's bytes are actually ON DISK, so this test is
    // about the BACKOFF window and never races the stream itself.
    fetchMock.mockImplementationOnce(async () => {
      void (async () => {
        for (let i = 0; i < 400; i += 1) {
          const size = await stat(partial).then((s) => s.size).catch(() => 0);
          if (size >= 4) break;
          await new Promise((r) => setTimeout(r, 5));
        }
        ctl.abort();
      })();
      return shortBody("AAAA", 99, { etag: '"v"' });
    });
    // …and this response must NEVER be consumed.
    fetchMock.mockImplementation(async () => new Response("SHOULD-NOT-BE-FETCHED", { status: 200 }));

    const started = Date.now();
    await expect(
      downloadModel(url, "checkpoints", "cancelled-out.safetensors", undefined, undefined, undefined, ctl.signal),
    ).rejects.toThrow();

    // It woke on the cancel rather than sleeping out the full backoff…
    expect(Date.now() - started).toBeLessThan(9_000);
    // …and made no second request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The partial is deliberately left behind, resumable, exactly as a cancel promises.
    await expect(stat(partial).then((s) => s.size)).resolves.toBe(4);
  });

  it("a cancel whose error IS classified transient is still not retried — cancellation is decided by the signal, not by the message", async () => {
    // The hazard this pins. Aborting a fetch mid-BODY makes undici raise
    // `TypeError: terminated` — the exact signature #470 asked us to retry, and
    // one this suite asserts elsewhere IS retryable. If the loop classified the
    // error instead of consulting the caller's signal first, a user's cancel would
    // be "recovered from" and the download would run on after they stopped it.
    const url = "https://example.com/models/cancel-looks-transient.safetensors";
    const ctl = new AbortController();

    // Not a hypothesis — the error this transport raises really is retryable:
    expect(classifyDownloadFailure(new TypeError("terminated")).retryable).toBe(true);

    fetchMock.mockImplementationOnce(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("AAAA"));
          setTimeout(() => {
            // Order matters and is deterministic: both statements run in ONE
            // synchronous tick, so the caller's signal is already aborted by the
            // time the pipeline's rejection is handled in a later microtask.
            c.error(new TypeError("terminated"));
            ctl.abort();
          }, 5);
        },
      });
      return new Response(stream, {
        status: 200,
        statusText: "OK",
        headers: { "content-length": "64", etag: '"v"' },
      });
    });
    fetchMock.mockImplementation(async () => new Response("MUST-NOT-BE-FETCHED", { status: 200 }));

    await expect(
      downloadModel(
        url,
        "checkpoints",
        "cancel-transient-out.safetensors",
        undefined,
        undefined,
        undefined,
        ctl.signal,
      ),
    ).rejects.toThrow();

    // No second attempt: the cancel was honoured, not classified away.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("abandons and resumes a WEDGED transfer that delivers no bytes at all (#470 stall / #817 bounded attempt)", async () => {
    const url = "https://example.com/models/wedged.safetensors";
    setDownloadRetryPolicyForTests({ maxAttempts: 2, stallTimeoutMs: 150 });

    // Attempt 1: 4 bytes arrive, then the socket goes silent FOREVER without
    // closing. Before the watchdog this sat "in flight" indefinitely — #470 watched
    // one do nothing for ~30 minutes.
    fetchMock.mockImplementationOnce(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("AAAA"));
          // never closes, never enqueues again
        },
      });
      return new Response(stream, {
        status: 200,
        statusText: "OK",
        headers: { "content-length": "8", etag: '"wedge-v1"' },
      });
    });
    // Attempt 2 resumes from the 4 bytes the wedged attempt DID write.
    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/8" },
      }),
    );

    const target = await downloadModel(url, "checkpoints", "wedged-out.safetensors");

    await expect(readFile(target, "utf-8")).resolves.toBe("AAAABBBB");
    // The stall was bounded AND the progress it had made was kept.
    expect(headersOf(1).Range).toBe("bytes=4-");
    expect(headersOf(1)["If-Range"]).toBe('"wedge-v1"');
  }, 20_000);

  it("a RETRIED attempt never publishes a terminal 'error' progress row — the agent is not told a running download failed (#470/#547)", async () => {
    // The orchestrator treats the FIRST terminal row as the download's outcome and
    // wakes the tab's agent with it (#547). If an attempt that is ABOUT TO BE
    // RETRIED emitted "error", the agent would be told the download failed while it
    // was still running — and its natural response, re-issuing, is the
    // second-writer hazard the download machinery exists to prevent.
    const url = "https://example.com/models/no-false-failure.safetensors";
    fetchMock.mockResolvedValueOnce(shortBody("AAAA", 8, { etag: '"v"' }));
    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/8" },
      }),
    );

    await downloadModel(url, "checkpoints", "no-false-failure-out.safetensors");

    expect(fetchMock).toHaveBeenCalledTimes(2); // a retry really did happen…
    // …and it was invisible as an OUTCOME: no failure was ever announced.
    expect(progressRows.map((r) => r.status)).not.toContain("error");
    expect(progressRows.map((r) => r.status)).toContain("done");
  });

  it("STILL announces a terminal 'error' once the retry loop genuinely gives up", async () => {
    // The mirror of the test above: withholding the per-attempt rows must not turn
    // a real failure into silence.
    const url = "https://example.com/models/really-fails.safetensors";
    fetchMock.mockImplementation(async () => shortBody("AB", 100, { etag: '"v"' }));

    await expect(
      downloadModel(url, "checkpoints", "really-fails-out.safetensors"),
    ).rejects.toThrow(/after 3 attempts/i);

    const errorRows = progressRows.filter((r) => r.status === "error");
    // Exactly one — not one per attempt, and not zero.
    expect(errorRows).toHaveLength(1);
  });

  it("does NOT arm the stall watchdog for a cloud (S3/Azure) transfer, which reports no byte progress", async () => {
    // A cloud transfer is performed by the vendor SDK, which writes the file
    // itself and never calls back per chunk — so the watchdog's liveness clock
    // would never be refreshed and a perfectly healthy multi-GB transfer would
    // look stalled from its first second. That is not merely wasteful: the cloud
    // path cannot range-resume, so each "retry" TRUNCATES the partial and starts
    // over, destroying real progress on a loop that could never terminate.
    setDownloadRetryPolicyForTests({ maxAttempts: 3, stallTimeoutMs: 100 });

    const cloudDownload = vi.mocked(
      (await import("../../services/storage/index.js")).downloadCloudUrlToFile,
    );
    // A transfer that takes far longer than the stall window but is perfectly alive.
    cloudDownload.mockImplementation(async (_url, targetPath) => {
      await new Promise((r) => setTimeout(r, 500));
      await writeFile(targetPath as string, "CLOUD-PAYLOAD-BYTES");
    });

    const target = await downloadModel(
      "s3://bucket/models/slow.safetensors",
      "checkpoints",
      "cloud-slow-out.safetensors",
    );

    // It completed — it was never aborted as "stalled" — and it ran only once.
    await expect(readFile(target, "utf-8")).resolves.toBe("CLOUD-PAYLOAD-BYTES");
    expect(cloudDownload).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("REFUSES to retry onto a partial another writer moved — two transfers must never interleave into one file", async () => {
    // The `.partial` is keyed by the download's representation, so a SECOND
    // PROCESS running the same download writes this exact file. Cross-process
    // dedup is best-effort by design (#529). Before the retry loop, a failed
    // attempt simply ended; now we go quiet for a backoff and come BACK to append —
    // so if someone else moved the file meanwhile, appending would interleave two
    // streams into one file. Nothing WE do touches the partial between attempts,
    // so any size change is proof of another writer.
    const url = "https://example.com/models/contended.safetensors";
    const { partial } = cachePaths(url);
    // A backoff long enough that the other writer provably acts DURING it, after
    // our own attempt has fully unwound (which takes single-digit ms here).
    setDownloadRetryPolicyForTests({ backoffBaseMs: 2_000, backoffCapMs: 2_000 });

    fetchMock.mockImplementationOnce(async () => {
      // Simulate the other writer replacing the staged file during our backoff.
      void (async () => {
        for (let i = 0; i < 400; i += 1) {
          const size = await stat(partial).then((s) => s.size).catch(() => 0);
          if (size >= 4) break;
          await new Promise((r) => setTimeout(r, 5));
        }
        await new Promise((r) => setTimeout(r, 250)); // our attempt has ended; the backoff is running
        await writeFile(partial, "SOMEONE-ELSES-LONGER-CONTENT");
      })();
      return shortBody("AAAA", 64, { etag: '"v"' });
    });
    fetchMock.mockImplementation(async () => new Response("MUST-NOT-BE-FETCHED", { status: 200 }));

    const err = await downloadModel(url, "checkpoints", "contended-out.safetensors").catch(
      (e: unknown) => e,
    );
    const message = String((err as Error).message);
    expect(message).toMatch(/another download is writing the same staged file/i);
    // It stops instead of competing — no second request was issued.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // And it DESTROYS NOTHING: the other writer's bytes are exactly as they left them.
    await expect(readFile(partial, "utf-8")).resolves.toBe("SOMEONE-ELSES-LONGER-CONTENT");
    // The remedy names what the caller can do from here.
    expect(message).toMatch(/download_status/);
    expect(message).toMatch(/re-issue/i);
  });

  it("emits exactly ONE terminal error row even when the cache path bails out to the direct-download fallback", async () => {
    // downloadWithCache falls back to a direct stream when the cache layer throws
    // something that is not a ModelError (an unusable cache dir, say). That
    // fallback stream is a separate call into streamUrlToFile, so unless it also
    // defers, the failure is announced twice — once by the fallback and once by
    // downloadModel — for a single download.
    const url = "https://example.com/models/cache-unavailable.safetensors";
    // Break the cache layer with a NON-ModelError so the fallback path is taken.
    vi.spyOn(downloadCacheFs, "mkdir").mockRejectedValue(new Error("cache dir unusable"));
    // The body must fail DURING streaming, not at the status line: a non-2xx throws
    // before any row is emitted, so it would not exercise the emit at all.
    fetchMock.mockImplementation(async () => shortBody("AB", 100));

    await expect(
      downloadModel(url, "checkpoints", "cache-unavailable-out.safetensors"),
    ).rejects.toThrow();

    expect(progressRows.filter((r) => r.status === "error")).toHaveLength(1);
  });

  it("catches another writer that re-staged a DIFFERENT object at the SAME byte count", async () => {
    // The splice the size check alone would miss, and the one that actually
    // corrupts: another writer truncates the shared staged file and re-stages a
    // DIFFERENT upstream object to exactly the same length. Our resume would then
    // append v1's suffix onto v2's prefix and every downstream check — size,
    // Content-Range, total — would still pass.
    //
    // It cannot do that without writing the new object's validator to the sidecar,
    // which is why the snapshot covers the sidecar and not just the size.
    const url = "https://example.com/models/same-size-swap.safetensors";
    const { partial, sidecar } = cachePaths(url);
    setDownloadRetryPolicyForTests({ backoffBaseMs: 2_000, backoffCapMs: 2_000 });

    fetchMock.mockImplementationOnce(async () => {
      void (async () => {
        for (let i = 0; i < 400; i += 1) {
          const size = await stat(partial).then((s) => s.size).catch(() => 0);
          if (size >= 4) break;
          await new Promise((r) => setTimeout(r, 5));
        }
        await new Promise((r) => setTimeout(r, 250));
        // SAME length, DIFFERENT object — byte count is unchanged.
        await writeFile(partial, "ZZZZ");
        await writeFile(sidecar, '"obj-v2"');
      })();
      return shortBody("AAAA", 64, { etag: '"obj-v1"' });
    });
    fetchMock.mockImplementation(async () => new Response("MUST-NOT-BE-FETCHED", { status: 200 }));

    const err = await downloadModel(url, "checkpoints", "same-size-swap-out.safetensors").catch(
      (e: unknown) => e,
    );
    const message = String((err as Error).message);
    expect(message).toMatch(/another download is writing the same staged file/i);
    // It names WHY — the validator, not the size, is what gave it away.
    expect(message).toMatch(/resume validator changed/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Nothing of the other writer's was destroyed.
    await expect(readFile(partial, "utf-8")).resolves.toBe("ZZZZ");
    await expect(readFile(sidecar, "utf-8")).resolves.toBe('"obj-v2"');
  });

  it("catches another writer that acts DURING the request — between deciding how to resume and writing", async () => {
    // The TOCTOU the between-attempts snapshot alone does NOT cover, and the one
    // that produces a valid-LOOKING corrupt file:
    //   1. we read the staged file (4 bytes of v1) and its v1 validator;
    //   2. we issue a ranged request for v1's remainder;
    //   3. WHILE that request is in flight, another writer truncates and re-stages
    //      v2, writing 4 bytes and v2's validator;
    //   4. we append v1's suffix onto v2's prefix — landing on exactly the
    //      authoritative total, so size, Content-Range and total all still pass.
    // Re-checking immediately before the write is what stops step 4.
    const url = "https://example.com/models/toctou.safetensors";
    const { partial, sidecar } = cachePaths(url);
    await writeFile(partial, "V1V1");
    await writeFile(sidecar, '"obj-v1"');

    fetchMock.mockImplementationOnce(async () => {
      // The other writer lands while our request is being served.
      await writeFile(partial, "V2V2");
      await writeFile(sidecar, '"obj-v2"');
      return new Response("V1SUFFIX", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-11/12" },
      });
    });
    fetchMock.mockImplementation(async () => new Response("MUST-NOT-BE-FETCHED", { status: 200 }));

    const err = await downloadModel(url, "checkpoints", "toctou-out.safetensors").catch(
      (e: unknown) => e,
    );
    expect(String((err as Error).message)).toMatch(
      /another download is writing the same staged file/i,
    );
    // The spliced file was never written: the staged bytes are still exactly what
    // the other writer left, with no v1 suffix appended.
    await expect(readFile(partial, "utf-8")).resolves.toBe("V2V2");
    // And it is not retried into the same splice on a later attempt.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a CLOUD retry never truncates a staged file another writer has grown — the most destructive path checks first", async () => {
    // The cloud (S3/Azure) path cannot range-resume: it TRUNCATES the staged file
    // and re-downloads in full. Under automatic retry that turns a later attempt
    // into a destructive writer — before #470 a failed cloud attempt simply ended
    // and could never come back to clobber anyone. If another process staged real
    // progress while we were backing off, truncating destroys work that is not ours
    // and that (unlike an HTTP resume) nothing can cheaply re-fetch.
    const url = "s3://bucket/models/contended-cloud.safetensors";
    // A cloud cache path folds in the storage principal, so take it from what the
    // downloader is actually handed rather than recomputing it here.
    let stagedPath = "";
    setDownloadRetryPolicyForTests({ maxAttempts: 3, backoffBaseMs: 1_500, backoffCapMs: 1_500 });

    const cloudDownload = vi.mocked(
      (await import("../../services/storage/index.js")).downloadCloudUrlToFile,
    );
    let call = 0;
    cloudDownload.mockImplementation(async (_url, targetPath) => {
      call += 1;
      stagedPath = targetPath as string;
      if (call === 1) {
        await writeFile(stagedPath, "OURS");
        // The other writer stages substantial progress during our backoff.
        void (async () => {
          await new Promise((r) => setTimeout(r, 250));
          await writeFile(stagedPath, "SOMEONE-ELSES-MANY-GIGABYTES");
        })();
        throw Object.assign(new Error("connection reset by peer"), { code: "ECONNRESET" });
      }
      // A later attempt must never get here with the other writer's bytes staged.
      await writeFile(stagedPath, "CLOBBERED");
      throw new Error("second cloud attempt");
    });

    const err = await downloadModel(url, "checkpoints", "contended-cloud-out.safetensors").catch(
      (e: unknown) => e,
    );
    expect(String((err as Error).message)).toMatch(
      /another download is writing the same staged file/i,
    );
    // THE assertion: the other writer's bytes are untouched. A truncate here would
    // have been silent, unrecoverable, multi-gigabyte data loss.
    await expect(readFile(stagedPath, "utf-8")).resolves.toBe("SOMEONE-ELSES-MANY-GIGABYTES");
  }, 20_000);

  it("an integrity REFUSAL never deletes a partial another writer re-staged — refusing our response is not licence to clean up theirs", async () => {
    // The refusal paths (#467) remove the staged file and its sidecar, which is
    // right when the file is OURS. If another writer re-staged it while our request
    // was in flight it is not — and "we got a bad response" must not become "we
    // deleted your multi-gigabyte partial". The interference check therefore sits
    // BEFORE those refusals, not after them.
    const url = "https://example.com/models/refusal-vs-other-writer.safetensors";
    const { partial, sidecar } = cachePaths(url);
    await writeFile(partial, "OURS");
    await writeFile(sidecar, '"obj-v1"');

    fetchMock.mockImplementationOnce(async () => {
      // The other writer re-stages while we wait for the response…
      await writeFile(partial, "SOMEONE-ELSES-CONTENT");
      await writeFile(sidecar, '"obj-v2"');
      // …and the response we get is one the integrity guards would REFUSE and then
      // clean up after (a 206 whose Content-Range starts at the wrong offset).
      return new Response("XXXX", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 999-1002/1003" },
      });
    });
    fetchMock.mockImplementation(async () => new Response("MUST-NOT-BE-FETCHED", { status: 200 }));

    const err = await downloadModel(url, "checkpoints", "refusal-out.safetensors").catch(
      (e: unknown) => e,
    );
    expect(String((err as Error).message)).toMatch(
      /another download is writing the same staged file/i,
    );
    // Neither the partial nor the sidecar was cleaned up on the other writer's behalf.
    await expect(readFile(partial, "utf-8")).resolves.toBe("SOMEONE-ELSES-CONTENT");
    await expect(readFile(sidecar, "utf-8")).resolves.toBe('"obj-v2"');
  });

  it("does NOT promise a resume for bytes with no recorded identity — they exist, but a re-issue re-fetches them", async () => {
    // A partial with no validator sidecar is deliberately RESTARTED, not resumed
    // (#343/#467): there is no recorded proof of which object those bytes belong
    // to. Telling the caller "re-issuing resumes from there" would be a remedy they
    // cannot act on — the bytes are real, but they will be downloaded again.
    const url = "https://example.com/models/no-validator-giveup.safetensors";
    // Short bodies with NO validator header at all, so no sidecar is ever written.
    fetchMock.mockImplementation(async () => shortBody("ABCD", 100));

    const err = await downloadModel(url, "checkpoints", "no-validator-giveup-out.safetensors").catch(
      (e: unknown) => e,
    );
    const message = String((err as Error).message);
    expect(message).toMatch(/after 3 attempts/i);
    // It states the bytes exist…
    expect(message).toMatch(/of partial data is on disk/);
    // …and is honest that they will NOT be resumed, and why.
    expect(message).toMatch(/restart from the beginning rather than resume/);
    expect(message).toMatch(/no recorded proof of WHICH object/);
    expect(message).not.toMatch(/resumes from there/);
    // The bytes really are there, and really have no validator — checked on disk.
    const { partial, sidecar } = cachePaths(url);
    await expect(stat(partial).then((s) => s.size)).resolves.toBeGreaterThan(0);
    await expect(stat(sidecar)).rejects.toThrow();
  });

  it("REFUSES a retry whose ownership it cannot establish — an unreadable staged file is not 'unchanged'", async () => {
    // Fail-CLOSED across the retry boundary. If the stat that records what we left
    // behind fails transiently, we do not know what is on disk — and "I could not
    // read it" must not be treated as "it is still mine", because the very next
    // thing a restart does is truncate it. The gate's sequence: attempt 1 stages
    // bytes and fails, its final stat errors, another writer grows the file during
    // the backoff, and the retry destroys their multi-gigabyte progress.
    const url = "https://example.com/models/unreadable-ownership.safetensors";

    const realStat = downloadCacheFs.stat;
    let attemptsSeen = 0;
    let statsSinceAttempt = 0;
    vi.spyOn(downloadCacheFs, "stat").mockImplementation(async (...args) => {
      const path = String(args[0]);
      if (attemptsSeen > 0 && path.endsWith(".partial")) {
        statsSinceAttempt += 1;
        // The FIRST post-response read is this attempt's own pre-write check; the
        // NEXT is the record of what we LEFT BEHIND — make exactly that one fail,
        // with EACCES rather than ENOENT (a MISSING file is knowably 0 bytes and
        // must NOT be treated as unknown).
        if (statsSinceAttempt >= 2) {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        }
      }
      return realStat(...(args as Parameters<typeof realStat>));
    });
    fetchMock.mockImplementation(async () => {
      attemptsSeen += 1;
      return shortBody("AAAA", 64, { etag: '"v"' });
    });

    const err = await downloadModel(url, "checkpoints", "unreadable-out.safetensors").catch(
      (e: unknown) => e,
    );
    expect(String((err as Error).message)).toMatch(/size could not be read/i);
    // It stopped rather than proceeding to truncate on an assumption.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("REFUSES a retry whose VALIDATOR it cannot read — an unknown validator sends the attempt down the truncating path", async () => {
    // The sidecar half of the same fail-closed rule, and it is not cosmetic:
    // readValidatorSidecar() reads "unreadable" as "no validator", which routes the
    // attempt to the 200-RESTART path — and that path TRUNCATES the staged file. So
    // an unknown validator plus a same-size replacement by another writer during
    // the backoff would silently destroy their partial.
    const url = "https://example.com/models/unreadable-validator.safetensors";
    const { partial, sidecar } = cachePaths(url);
    // Staged bytes plus a validator path that CANNOT be read (a blocked directory —
    // EISDIR, not ENOENT; a MISSING sidecar is knowably "no validator" and is a
    // legitimate clean restart).
    await writeFile(partial, "PRECIOUS-BYTES");
    await mkdir(sidecar, { recursive: true });
    await writeFile(join(sidecar, "blocker"), "x");

    fetchMock.mockImplementation(async () => new Response("FULL-REPLACEMENT", { status: 200 }));

    const err = await downloadModel(url, "checkpoints", "unreadable-validator-out.safetensors").catch(
      (e: unknown) => e,
    );
    // A validator-related refusal — from this guard or from #467's more precise
    // stale-sidecar one. What must NEVER happen is proceeding to the truncating
    // restart on a validator nobody could read.
    expect(String((err as Error).message)).toMatch(
      /resume validator could not be read|remove or empty the stale resume-validator sidecar|restart failed/i,
    );
    // The decisive assertion: the staged bytes were not truncated on the way out.
    await expect(readFile(partial, "utf-8")).resolves.toBe("PRECIOUS-BYTES");
  });

  it("a cancel that lands DURING the pre-write check still leaves the resumable partial on disk", async () => {
    // The interference check awaits, so a cancel can arrive inside it. Every path
    // after that hook deletes or truncates the staged file, and a cancelled
    // download is promised a resumable partial — erasing it on the way out would be
    // exactly the data loss that promise denies.
    const url = "https://example.com/models/cancel-in-hook.safetensors";
    const { partial, sidecar } = cachePaths(url);
    // A partial with NO validator: the resume declines and the restart path would
    // TRUNCATE it — the destructive branch this guards.
    await writeFile(partial, "PRECIOUS-BYTES");
    const ctl = new AbortController();

    fetchMock.mockImplementationOnce(async () => {
      // Cancel while the response is being handled, i.e. around the hook.
      setTimeout(() => ctl.abort(), 0);
      await new Promise((r) => setTimeout(r, 20));
      return new Response("FULL-REPLACEMENT-BODY", { status: 200, statusText: "OK" });
    });
    fetchMock.mockImplementation(async () => new Response("MUST-NOT-BE-FETCHED", { status: 200 }));

    await expect(
      downloadModel(
        url,
        "checkpoints",
        "cancel-in-hook-out.safetensors",
        undefined,
        undefined,
        undefined,
        ctl.signal,
      ),
    ).rejects.toThrow();

    // The bytes a cancel promises to leave behind are still there, untruncated.
    await expect(readFile(partial, "utf-8")).resolves.toBe("PRECIOUS-BYTES");
    await expect(stat(sidecar)).rejects.toThrow(); // and no validator was paired with them
  });

  it("does not claim 'the host never sent a validator' when the sidecar merely could not be READ", async () => {
    // Three states, not two. Reporting an unreadable sidecar as "no validator was
    // ever sent" is a definite verdict drawn from absence of evidence, and it tells
    // the caller their bytes will be re-downloaded when they may well resume.
    const url = "https://example.com/models/unreadable-sidecar.safetensors";
    const { sidecar } = cachePaths(url);
    fetchMock.mockImplementation(async () => shortBody("ABCD", 100, { etag: '"v"' }));
    // Block the sidecar path so reading it fails with EISDIR, not ENOENT.
    await mkdir(sidecar, { recursive: true });
    await writeFile(join(sidecar, "blocker"), "x");

    const err = await downloadModel(url, "checkpoints", "unreadable-sidecar-out.safetensors").catch(
      (e: unknown) => e,
    );
    const message = String((err as Error).message);
    if (/after 3 attempts/i.test(message)) {
      expect(message).toMatch(/could not be read/);
      expect(message).not.toMatch(/the host never sent/);
    } else {
      // An earlier, more precise guard (#467's stale-sidecar refusal) claimed it —
      // which is also correct, and is exactly why the pre-write check does not
      // fail closed on a sidecar that was already unreadable.
      expect(message).toMatch(/sidecar|validator/i);
    }
  });

  it("the RECURSIVE restart inherits the ownership check — a foreign writer during it is refused, not truncated", async () => {
    // The recursive `streamUrlToFile(...)` restart (taken when a cross-origin 206
    // cannot be PROVEN to be the same object) must inherit the full context of the
    // call it replaces. If it dropped `beforeWrite`, the restart would run its
    // truncating 200 path with NO ownership check — reopening the exact hazard the
    // pre-write check exists to close, one level down.
    //
    // This drives a foreign writer into the RECURSIVE request's window specifically.
    const url = "https://huggingface.co/org/repo/resolve/main/recursive-restart.safetensors";
    const { partial, sidecar } = cachePaths(url);
    await writeFile(partial, "V1V1");
    // A CONTENT-ADDRESSED validator, so the resume is attempted and the cross-origin
    // 206 below is judged against it.
    await writeFile(sidecar, `xet\n"obj-v1"\n8\nxet`);

    let hop = 0;
    fetchMock.mockImplementation(async () => {
      hop += 1;
      if (hop === 1) {
        // HF resolve → CAS CDN, carrying a DIFFERENT content hash: the resume is
        // unprovable, so the code recurses into a clean full restart.
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://cas-bridge.xethub.hf.co/xet-bridge-us/obj?sig=q",
            "x-linked-etag": '"obj-v2"',
          },
        });
      }
      if (hop === 2) {
        return new Response("ZZZZ", {
          status: 206,
          statusText: "Partial Content",
          headers: { "content-range": "bytes 4-7/8" },
        });
      }
      // hop 3 IS the recursive restart's request. A foreign writer stages its own
      // transfer into the shared file while it is in flight.
      await writeFile(partial, "SOMEONE-ELSES-PARTIAL");
      await writeFile(sidecar, `xet\n"obj-v9"\n21\nxet`);
      return new Response("FULL-REPLACEMENT-BODY", { status: 200, statusText: "OK" });
    });

    const err = await downloadModel(url, "checkpoints", "recursive-restart-out.safetensors").catch(
      (e: unknown) => e,
    );
    expect(String((err as Error).message)).toMatch(
      /another download is writing the same staged file/i,
    );
    // The recursive restart did NOT truncate the foreign writer's bytes.
    await expect(readFile(partial, "utf-8")).resolves.toBe("SOMEONE-ELSES-PARTIAL");
  });

  /** Drive the cross-origin-unprovable-206 path, which makes streamUrlToFile
   *  RECURSE into a clean full restart. `onRestart` supplies that restart's
   *  response, which is the request the recursion actually issues. */
  function mockRecursiveRestart(onRestart: () => Promise<Response>): void {
    let hop = 0;
    fetchMock.mockImplementation(async () => {
      hop += 1;
      if (hop === 1) {
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://cas-bridge.xethub.hf.co/xet-bridge-us/obj?sig=q",
            "x-linked-etag": '"obj-v2"',
          },
        });
      }
      if (hop === 2) {
        return new Response("ZZZZ", {
          status: 206,
          statusText: "Partial Content",
          headers: { "content-range": "bytes 4-7/8" },
        });
      }
      return onRestart();
    });
  }

  async function stageUnprovableResume(url: string): Promise<void> {
    const { partial, sidecar } = cachePaths(url);
    await writeFile(partial, "V1V1");
    await writeFile(sidecar, `xet\n"obj-v1"\n8\nxet`);
  }

  it("the RECURSIVE restart inherits onBytes — a healthy trickling restart is not killed as stalled", async () => {
    // If the recursion dropped `onBytes`, the outer stall timer would never be
    // reset during the restarted full-body transfer, so a download that is
    // CONTINUOUSLY writing bytes would be aborted as stalled — the watchdog
    // destroying progress that is being made.
    const url = "https://huggingface.co/org/repo/resolve/main/recursive-trickle.safetensors";
    await stageUnprovableResume(url);
    // One attempt only, so a watchdog abort is fatal and cannot be masked by a
    // retry that happens to succeed. The transfer runs for ~3s against a 250 ms
    // stall window — the watchdog gets many chances to fire, so a pass here means
    // it genuinely never had cause to.
    setDownloadRetryPolicyForTests({ maxAttempts: 1, stallTimeoutMs: 250 });

    mockRecursiveRestart(async () => {
      // Bytes arrive steadily, each gap well under the stall window, for a total
      // duration many times OVER it.
      const stream = new ReadableStream<Uint8Array>({
        async start(c) {
          for (let i = 0; i < 20; i += 1) {
            await new Promise((r) => setTimeout(r, 150));
            c.enqueue(new TextEncoder().encode("AB"));
          }
          c.close();
        },
      });
      return new Response(stream, {
        status: 200,
        statusText: "OK",
        headers: { "content-length": "40" },
      });
    });

    const target = await downloadModel(url, "checkpoints", "recursive-trickle-out.safetensors");
    await expect(readFile(target, "utf-8")).resolves.toBe("AB".repeat(20));
  }, 30_000);

  it("the stall watchdog IS armed across the recursive restart — a wedged restart is abandoned and retried", async () => {
    // The companion to the trickle test above: that one shows a healthy restart is
    // not killed, this one shows a WEDGED restart still is. Together they pin the
    // watchdog's behaviour on the recursive path in both directions.
    const url = "https://huggingface.co/org/repo/resolve/main/recursive-wedge.safetensors";
    await stageUnprovableResume(url);
    setDownloadRetryPolicyForTests({ maxAttempts: 2, stallTimeoutMs: 150 });

    let restarts = 0;
    mockRecursiveRestart(async () => {
      restarts += 1;
      if (restarts === 1) {
        // Bytes stop arriving and the socket never closes.
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode("AAAA"));
          },
        });
        return new Response(stream, {
          status: 200,
          statusText: "OK",
          headers: { "content-length": "8" },
        });
      }
      return new Response("COMPLETE", { status: 200, statusText: "OK" });
    });

    const target = await downloadModel(url, "checkpoints", "recursive-wedge-out.safetensors");
    // It did not hang: the wedged restart was bounded and the retry finished it.
    await expect(readFile(target, "utf-8")).resolves.toBe("COMPLETE");
    expect(restarts).toBe(2);
  }, 30_000);

  it("the RECURSIVE restart inherits deferErrorRow — it does not announce a failure the outer loop is still retrying", async () => {
    // If the recursion dropped `deferErrorRow`, a retryable failure inside the
    // restarted stream would publish a terminal `error` row while the outer retry
    // loop was still going. A caller reading that as failure re-issues — and
    // re-issuing is what creates the second writer that truncated #817's model.
    const url = "https://huggingface.co/org/repo/resolve/main/recursive-defer.safetensors";
    await stageUnprovableResume(url);

    let restarts = 0;
    mockRecursiveRestart(async () => {
      restarts += 1;
      // First restart is cut short (retryable); the retry then completes.
      return restarts === 1
        ? shortBody("AAAA", 16)
        : new Response("COMPLETE-BODY-16", { status: 200, statusText: "OK" });
    });

    await downloadModel(url, "checkpoints", "recursive-defer-out.safetensors");

    expect(restarts).toBeGreaterThan(1); // the retry really happened…
    // …and no failure was ever announced for a download that succeeded.
    expect(progressRows.map((r) => r.status)).not.toContain("error");
    expect(progressRows.map((r) => r.status)).toContain("done");
  }, 20_000);

  it("the #473 poison CLEANUP checks ownership first — a foreign writer's partial is not discarded as our leftover", async () => {
    // The last window the retry loop added without an ownership check. Between the
    // retry-boundary check and the poison guards inside resumeOffsetFromDisk, a
    // foreign writer can replace the staged file. A surviving `.rejected` marker
    // (its removal having transiently failed on a PRIOR attempt of ours) then makes
    // our automatic retry discard THEIR partial as if it were our poisoned leftover.
    // The foreign write must land INSIDE that window — after the boundary check has
    // read the file, before the cleanup acts on it. The marker `stat` sits exactly
    // in between, so hooking it places the writer precisely where the bug lives.
    // (A write during the BACKOFF is a different, already-covered window: the
    // boundary check catches it and the cleanup guard is never reached.)
    const url = "https://example.com/models/poison-vs-foreign.safetensors";
    const { partial, sidecar } = cachePaths(url);
    await writeFile(partial, "OURS");
    await writeFile(sidecar, '"v"');
    // A stale marker from an earlier rejection of OURS whose removal failed.
    await writeFile(`${partial}.rejected`, "stale marker");

    const realStat = downloadCacheFs.stat;
    let planted = false;
    vi.spyOn(downloadCacheFs, "stat").mockImplementation(async (...args) => {
      const path = String(args[0]);
      if (!planted && path.endsWith(".rejected")) {
        planted = true;
        // The foreign writer replaces the staged file right here.
        await writeFile(partial, "SOMEONE-ELSES-MANY-GIGABYTES");
        await writeFile(sidecar, '"their-object"');
      }
      return realStat(...(args as Parameters<typeof realStat>));
    });

    fetchMock.mockImplementation(async () => new Response("BODY", { status: 200 }));

    const err = await downloadModel(url, "checkpoints", "poison-vs-foreign-out.safetensors").catch(
      (e: unknown) => e,
    );
    expect(String((err as Error).message)).toMatch(
      /another download is writing the same staged file/i,
    );
    // Their partial and their validator are both untouched — not discarded as
    // "a previously-rejected leftover" of ours.
    await expect(readFile(partial, "utf-8")).resolves.toBe("SOMEONE-ELSES-MANY-GIGABYTES");
    await expect(readFile(sidecar, "utf-8")).resolves.toBe('"their-object"');
  }, 20_000);

  it("the #473 BODY-SNIFF cleanup checks ownership first — a foreign partial that merely LOOKS non-model is not discarded", async () => {
    // The second destructive branch inside resumeOffsetFromDisk. It discards a
    // partial whose head sniffs as HTML/JSON, on the theory that it is our own
    // rejected auth page. If a foreign writer replaced the staged file after our
    // boundary check, that head is THEIRS — and a legitimate transfer whose first
    // bytes happen to start with "<" (an SVG, an XML asset) would be destroyed.
    const url = "https://example.com/models/bodysniff-vs-foreign.safetensors";
    const { partial, sidecar } = cachePaths(url);
    await writeFile(partial, "OURS-BINARY-PREFIX");
    await writeFile(sidecar, '"v"');

    const realStat = downloadCacheFs.stat;
    let planted = false;
    vi.spyOn(downloadCacheFs, "stat").mockImplementation(async (...args) => {
      const path = String(args[0]);
      // The marker probe runs BEFORE the body sniff, so this lands the foreign
      // write in the window between our boundary check and that sniff.
      if (!planted && path.endsWith(".rejected")) {
        planted = true;
        await writeFile(partial, "<?xml version='1.0'?><their-in-progress-asset/>");
        await writeFile(sidecar, '"their-object"');
      }
      return realStat(...(args as Parameters<typeof realStat>));
    });

    fetchMock.mockImplementation(async () => new Response("BODY", { status: 200 }));

    const err = await downloadModel(url, "checkpoints", "bodysniff-vs-foreign-out.safetensors").catch(
      (e: unknown) => e,
    );
    expect(String((err as Error).message)).toMatch(
      /another download is writing the same staged file/i,
    );
    // Their bytes survive, even though they sniff as "not a model".
    await expect(readFile(partial, "utf-8")).resolves.toBe(
      "<?xml version='1.0'?><their-in-progress-asset/>",
    );
  });

  it("a retry that lands on a POISONED partial (#473 leftover) restarts instead of resuming onto it", async () => {
    const url = "https://example.com/models/poisoned.safetensors";
    const { partial, sidecar } = cachePaths(url);
    // A prior attempt rejected an HTML auth page and could not remove the leftover.
    await writeFile(partial, "<!DOCTYPE html><html>login</html>");
    await writeFile(sidecar, '"poison"');
    await writeFile(`${partial}.rejected`, "rejected");

    fetchMock.mockResolvedValueOnce(new Response("REALMODELBYTES", { status: 200, statusText: "OK" }));

    const target = await downloadModel(url, "checkpoints", "poisoned-out.safetensors");

    // No Range: the poisoned bytes were never a resume candidate on ANY attempt.
    expect(headersOf(0).Range).toBeUndefined();
    await expect(readFile(target, "utf-8")).resolves.toBe("REALMODELBYTES");
  });
});
