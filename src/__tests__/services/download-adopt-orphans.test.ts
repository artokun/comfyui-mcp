// #1567 (item 3) — a NEW session AUTO-ADOPTS the downloads its predecessor's death
// orphaned, instead of leaving the user cancel × N + re-issue × N.
//
// A respawned (or crashed) tool session took its in-flight transfers with it but left
// their records reading "downloading": action:"status" proved each owner dead, and the
// .partial files were still on disk — everything a resume needs — yet recovery was nine
// manual cancels and nine manual re-issues for ~48 GB. `adoptOrphanedDownloadJobs` is the
// recovery the record was always rich enough to perform, and these tests pin both
// directions: what gets adopted (proven-dead owner + resumable partial + intact URL +
// local route) and, one refusal at a time, what must be LEFT on the manual path.
//
// The model-resolver seam is mocked the way download-jobs.test.ts mocks it (the writer
// never touches a network or a real models dir), EXCEPT that the real
// findResumablePartialForLocalDownload / applyHfEndpoint stay live — the partial lookup
// deriving the writer's cache identity is the thing under test, and mocking it would
// test the mock.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  resolvers: [] as Array<{ resolve: (p: string) => void; reject: (e: Error) => void; url: string }>,
  calls: [] as Array<{ url: string; sub?: string; filename?: string }>,
  routeToManager: false,
  routeThrows: false,
  /** URLs resolveDownloadTarget should refuse — models a destination that no
   *  longer resolves (the re-issue half of adoption must fail closed). */
  failResolveFor: new Set<string>(),
}));

vi.mock("../../services/model-resolver.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/model-resolver.js")>(
    "../../services/model-resolver.js",
  );
  return {
    ...actual,
    // The route decision adoption stands down on: a Manager-routed session must not
    // "resume" a local orphan (that would be a fresh server-side dispatch).
    shouldDispatchDownloadToManager: vi.fn(async () => {
      if (hoisted.routeThrows) throw new Error("no live server in this test");
      return hoisted.routeToManager;
    }),
    // The writer: never streams. Captures the re-issue arguments and pends until the
    // test resolves it, exactly like the download-jobs.test.ts harness.
    downloadModel: vi.fn(
      (
        url: string,
        sub?: string,
        filename?: string,
        _auth?: unknown,
        _dispatch?: boolean,
        _onResume?: unknown,
        signal?: AbortSignal,
        onTrayId?: (trayId: string) => void,
      ) => {
        hoisted.calls.push({ url, sub, filename });
        onTrayId?.(`prog-${url}`);
        return new Promise<string>((resolve, reject) => {
          hoisted.resolvers.push({ resolve, reject, url });
          if (signal) {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }
        });
      },
    ),
    resolveDownloadTarget: vi.fn(async (url: string, sub: string, filename?: string) => {
      if (hoisted.failResolveFor.has(url)) throw new Error("models root is gone");
      const base = filename || String(url).split("/").pop() || "model.safetensors";
      return { targetDir: `/M/${sub}`, filename: base, targetPath: `/M/${sub}/${base}` };
    }),
    // #369 post-landing verification — no live server here, so the honest unknown.
    verifyLandedModel: vi.fn(async (targetPath: string) => ({
      verifiedPath: targetPath,
      liveVisible: "unknown" as const,
      note: "no live server in this test",
    })),
    // The pre-flight listing baseline must not reach a network from a test.
    liveListingHasEntry: vi.fn(async () => undefined),
  };
});

import {
  adoptOrphanedDownloadJobs,
  downloadIdFor,
  listDownloadJobs,
  resetDownloadJobs,
} from "../../services/download-jobs.js";
import {
  setProgressDir,
  PERSIST_OWNER,
  __resetStableRecordsDir,
} from "../../services/download-progress.js";
import {
  findResumablePartial,
  stagedPartialPathForTarget,
  stagedPartialPathForUrl,
  __downloadCacheTestHooks,
} from "../../services/download-cache.js";
import { localDownloadCacheIdentity } from "../../services/model-resolver.js";
import { config } from "../../config.js";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join as pathJoin, dirname } from "node:path";

/** A pid guaranteed dead: a child process that already exited (the download-jobs
 *  test suite's own pattern — the probe must answer ESRCH, not "cannot tell"). */
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid;

/** An UNAUTHENTICATED-looking host: no env credential attaches to it, so the
 *  writer's cache identity for these URLs is the bare URL — letting a test stage
 *  the partial with the exported one-definition helpers. */
const URL_X = "https://models.example.invalid/big.safetensors";
const URL_Y = "https://models.example.invalid/other.safetensors";
/** The reporter's actual case: a gated HuggingFace URL whose env token folds into
 *  the cache identity (#467 P1-2), so the bare-URL lookup cannot find its partial. */
const URL_HF = "https://huggingface.co/org/repo/resolve/main/gated.safetensors";

/** Simulate ANOTHER (dead) session's persisted in-flight record on disk — a
 *  distinct owner-scoped control-job- file. Mirrors download-jobs.test.ts. */
function writeForeignJobRecord(
  dir: string,
  rec: {
    id: string;
    trayId: string;
    progressId: string;
    url: string;
    owner: string;
    filename?: string;
    viaManager?: boolean;
    downloadRoute?: "direct" | "proxied";
    partialPath?: string;
    partialIdentity?: unknown;
    status?: "downloading" | "done" | "error" | "cancelled";
    ageMs?: number;
    pid?: number;
    target?: string;
  },
): void {
  const status = rec.status ?? "downloading";
  writeFileSync(
    pathJoin(dir, `control-job-${rec.id}-${rec.owner}.json`),
    JSON.stringify({
      id: rec.id,
      trayId: rec.trayId,
      progressId: rec.progressId,
      url: rec.url,
      target_subfolder: "loras",
      filename: rec.filename,
      via_manager: rec.viaManager,
      download_route: rec.downloadRoute,
      partialPath: rec.partialPath,
      partial_identity: rec.partialIdentity,
      status,
      started_at: Date.now(),
      finished_at: status === "downloading" ? undefined : Date.now(),
      owner: rec.owner,
      target: rec.target,
      pid: rec.pid,
      updated: Date.now() - (rec.ageMs ?? 0),
    }),
  );
}

describe("adoptOrphanedDownloadJobs (#1567 item 3)", () => {
  let recordDir = "";
  let cacheDir = "";
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    hoisted.resolvers.length = 0;
    hoisted.calls.length = 0;
    hoisted.routeToManager = false;
    hoisted.routeThrows = false;
    hoisted.failResolveFor.clear();
    resetDownloadJobs();
    saved.COMFYUI_MCP_DATA_DIR = process.env.COMFYUI_MCP_DATA_DIR;
    saved.COMFYUI_DOWNLOAD_CACHE_DIR = process.env.COMFYUI_DOWNLOAD_CACHE_DIR;
    saved.HF_ENDPOINT = process.env.HF_ENDPOINT;
    saved.COMFYUI_URL = process.env.COMFYUI_URL;
    // A mirror endpoint would rewrite the HF URL and change the staged identity the
    // authed-partial case derives — pin it away rather than depend on CI's env.
    delete process.env.HF_ENDPOINT;
    recordDir = mkdtempSync(pathJoin(tmpdir(), "adopt-records-"));
    cacheDir = mkdtempSync(pathJoin(tmpdir(), "adopt-cache-"));
    process.env.COMFYUI_MCP_DATA_DIR = recordDir;
    process.env.COMFYUI_DOWNLOAD_CACHE_DIR = cacheDir;
    __resetStableRecordsDir();
    setProgressDir(recordDir);
  });

  afterEach(() => {
    resetDownloadJobs();
    setProgressDir("");
    config.huggingfaceToken = undefined;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    __resetStableRecordsDir();
    rmSync(recordDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  /** Stage a non-zero `.partial` the way the writer names it, for a bare-identity URL. */
function stagePartial(url: string, bytes: number): void {
    const p = stagedPartialPathForUrl(url);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, Buffer.alloc(bytes, 1));
  }

  function localProof(url: string): { partialPath: string; partialIdentity: unknown } {
    const identity = localDownloadCacheIdentity(url);
    return { partialPath: identity.partialPath, partialIdentity: identity.partialIdentity };
  }

  it("adopts a proven-dead orphan whose partial is staged — cancel + re-issue collapse into the new session", async () => {
    const id = "orphan1567x0000001";
    const owner = "dead-session";
    const proof = localProof(URL_X);
    writeForeignJobRecord(recordDir, {
      id,
      trayId: downloadIdFor(URL_X),
      progressId: "prog-dead-1",
      url: URL_X,
      owner,
      filename: "big.safetensors",
      viaManager: false,
      downloadRoute: "direct",
      ...proof,
      ageMs: 10 * 60 * 1000,
      pid: deadPid(),
    });
    stagePartial(URL_X, 8192);

    const adopted = await adoptOrphanedDownloadJobs();

    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ id, filename: "big.safetensors", resumedBytes: 8192 });
    // The download was RE-ISSUED with the record's own request…
    expect(hoisted.calls).toEqual([
      { url: URL_X, sub: "loras", filename: "big.safetensors" },
    ]);
    // …and is tracked as this session's live job…
    const job = listDownloadJobs().find((j) => j.url === URL_X && j.status === "downloading");
    expect(job).toBeDefined();
    // …while the dead owner's record file is gone, replaced by THIS session's
    // administrative close (durable BEFORE the dead file was removed — #858 order).
    expect(() =>
      readFileSync(pathJoin(recordDir, `control-job-${id}-${owner}.json`), "utf8"),
    ).toThrow();
    const ours = JSON.parse(
      readFileSync(pathJoin(recordDir, `control-job-${id}-${PERSIST_OWNER}.json`), "utf8"),
    );
    expect(ours.status).toBe("cancelled");
    expect(ours.reclaimed_dead).toBe(true);
  });

  it("leaves a proven-dead orphan with NO staged partial on the manual path — a from-zero restart is a new download, not a recovery", async () => {
    const id = "orphan1567x0000002";
    const owner = "dead-session";
    writeForeignJobRecord(recordDir, {
      id,
      trayId: downloadIdFor(URL_X),
      progressId: "prog-dead-2",
      url: URL_X,
      owner,
      ageMs: 10 * 60 * 1000,
      pid: deadPid(),
    });
    // No partial staged.

    const adopted = await adoptOrphanedDownloadJobs();

    expect(adopted).toEqual([]);
    expect(hoisted.calls).toEqual([]);
    // Untouched: the record still answers status, and cancel + re-issue still works.
    expect(
      JSON.parse(readFileSync(pathJoin(recordDir, `control-job-${id}-${owner}.json`), "utf8")).status,
    ).toBe("downloading");
  });

  it("does not adopt a pod record while this process targets local ComfyUI", async () => {
    const id = "orphan-target-mismatch";
    const owner = "dead-pod-session";
    process.env.COMFYUI_URL = "http://127.0.0.1:8188";
    writeForeignJobRecord(recordDir, {
      id,
      trayId: downloadIdFor(URL_X),
      progressId: "prog-pod-mismatch",
      url: URL_X,
      owner,
      target: "https://pod-3000.proxy.runpod.net",
      ageMs: 10 * 60 * 1000,
      pid: deadPid(),
    });
    stagePartial(URL_X, 8192);

    expect(await adoptOrphanedDownloadJobs()).toEqual([]);
    expect(hoisted.calls).toEqual([]);
    expect(() =>
      readFileSync(pathJoin(recordDir, `control-job-${id}-${owner}.json`), "utf8"),
    ).not.toThrow();
  });

  it("refuses an orphan whose writer process is still ALIVE — another session's live download is never touched", async () => {
    const id = "orphan1567x0000003";
    const owner = "other-live-session";
    writeForeignJobRecord(recordDir, {
      id,
      trayId: downloadIdFor(URL_X),
      progressId: "prog-live-3",
      url: URL_X,
      owner,
      ageMs: 10 * 60 * 1000,
      pid: process.pid, // stale heartbeat, provably-live process
    });
    stagePartial(URL_X, 8192);

    expect(await adoptOrphanedDownloadJobs()).toEqual([]);
    expect(hoisted.calls).toEqual([]);
    expect(() =>
      readFileSync(pathJoin(recordDir, `control-job-${id}-${owner}.json`), "utf8"),
    ).not.toThrow();
  });

  it("refuses a record with NO writer pid — unprovable is not dead (#761)", async () => {
    const id = "orphan1567x0000004";
    const owner = "pre-858-session";
    writeForeignJobRecord(recordDir, {
      id,
      trayId: downloadIdFor(URL_X),
      progressId: "prog-unknown-4",
      url: URL_X,
      owner,
      ageMs: 10 * 60 * 1000,
      // no pid
    });
    stagePartial(URL_X, 8192);

    expect(await adoptOrphanedDownloadJobs()).toEqual([]);
    expect(hoisted.calls).toEqual([]);
  });

  it("NEVER adopts a remote Manager dispatch — the host may still be fetching, and a 'resume' would be a second dispatch into one destination", async () => {
    const id = "orphan1567x0000005";
    const owner = "dead-session";
    writeForeignJobRecord(recordDir, {
      id,
      trayId: downloadIdFor(URL_X),
      progressId: "prog-dead-5",
      url: URL_X,
      owner,
      viaManager: true,
      ageMs: 10 * 60 * 1000,
      pid: deadPid(),
    });
    stagePartial(URL_X, 8192);

    expect(await adoptOrphanedDownloadJobs()).toEqual([]);
    expect(hoisted.calls).toEqual([]);
    expect(() =>
      readFileSync(pathJoin(recordDir, `control-job-${id}-${owner}.json`), "utf8"),
    ).not.toThrow();
  });

  it("refuses a record whose persisted URL lost its query auth — re-issuing a redacted URL fetches a different representation", async () => {
    // persistDownloadJob strips ?token=… before disk. The trayId hashes the ORIGINAL
    // URL, so a record whose stored URL no longer hashes to its trayId is exactly
    // that redacted shape — and must be left for the user rather than re-issued
    // without its credential.
    const id = "orphan1567x0000006";
    const owner = "dead-session";
    writeForeignJobRecord(recordDir, {
      id,
      trayId: "original-urls-tray-id", // ≠ downloadIdFor(rec.url): the stored URL was rewritten
      progressId: "prog-dead-6",
      url: URL_X,
      owner,
      ageMs: 10 * 60 * 1000,
      pid: deadPid(),
    });
    stagePartial(URL_X, 8192);

    expect(await adoptOrphanedDownloadJobs()).toEqual([]);
    expect(hoisted.calls).toEqual([]);
  });

  it("stands down when a FRESH record for the same id exists — another session already adopted the orphan", async () => {
    const id = "orphan1567x0000007";
    writeForeignJobRecord(recordDir, {
      id,
      trayId: downloadIdFor(URL_X),
      progressId: "prog-dead-7",
      url: URL_X,
      owner: "dead-session",
      ageMs: 10 * 60 * 1000,
      pid: deadPid(),
    });
    // The adopter's fresh in-flight record for the SAME id (its own owner file).
    writeForeignJobRecord(recordDir, {
      id,
      trayId: downloadIdFor(URL_X),
      progressId: "prog-dead-7",
      url: URL_X,
      owner: "the-session-that-got-here-first",
      ageMs: 0,
      pid: process.pid,
    });
    stagePartial(URL_X, 8192);

    expect(await adoptOrphanedDownloadJobs()).toEqual([]);
    expect(hoisted.calls).toEqual([]);
    // …and the dead record was NOT reclaimed either — stand down means stand down.
    expect(() =>
      readFileSync(pathJoin(recordDir, `control-job-${id}-dead-session.json`), "utf8"),
    ).not.toThrow();
  });

  it("ignores terminal records — a finished or cancelled download is not an orphan", async () => {
    for (const [i, status] of ["done", "cancelled", "error"].entries()) {
      writeForeignJobRecord(recordDir, {
        id: `orphan1567x000008${i}`,
        trayId: downloadIdFor(URL_X),
        progressId: `prog-term-${i}`,
        url: URL_X,
        owner: `dead-session-${i}`,
        status: status as "done",
        ageMs: 10 * 60 * 1000,
        pid: deadPid(),
      });
    }
    stagePartial(URL_X, 8192);

    expect(await adoptOrphanedDownloadJobs()).toEqual([]);
    expect(hoisted.calls).toEqual([]);
  });

  it("stands down entirely on the Manager route — 'resuming' a local orphan server-side is a fresh dispatch, not a resume", async () => {
    hoisted.routeToManager = true;
    writeForeignJobRecord(recordDir, {
      id: "orphan1567x0000009",
      trayId: downloadIdFor(URL_X),
      progressId: "prog-dead-9",
      url: URL_X,
      owner: "dead-session",
      ageMs: 10 * 60 * 1000,
      pid: deadPid(),
    });
    stagePartial(URL_X, 8192);

    expect(await adoptOrphanedDownloadJobs()).toEqual([]);
    expect(hoisted.calls).toEqual([]);
  });

  it("fails closed when the route cannot even be decided — no server answer, no adoption", async () => {
    hoisted.routeThrows = true;
    writeForeignJobRecord(recordDir, {
      id: "orphan1567x0000010",
      trayId: downloadIdFor(URL_X),
      progressId: "prog-dead-10",
      url: URL_X,
      owner: "dead-session",
      ageMs: 10 * 60 * 1000,
      pid: deadPid(),
    });
    stagePartial(URL_X, 8192);

    await expect(adoptOrphanedDownloadJobs()).resolves.toEqual([]);
    expect(hoisted.calls).toEqual([]);
  });

  it("a failed re-issue does not throw and leaves the orphan CLOSED, not wedged", async () => {
    const id = "orphan1567x0000011";
    const proof = localProof(URL_X);
    writeForeignJobRecord(recordDir, {
      id,
      trayId: downloadIdFor(URL_X),
      progressId: "prog-dead-11",
      url: URL_X,
      owner: "dead-session",
      viaManager: false,
      downloadRoute: "direct",
      ...proof,
      ageMs: 10 * 60 * 1000,
      pid: deadPid(),
    });
    stagePartial(URL_X, 8192);
    hoisted.failResolveFor.add(URL_X);

    const adopted = await adoptOrphanedDownloadJobs();

    expect(adopted).toEqual([]);
    expect(hoisted.calls).toEqual([]);
    // The reclaim already ran (close-before-destroy): the user is left exactly where
    // the manual path leaves them after a cancel — free to re-issue — never wedged
    // between "do not re-issue" and "not yours".
    const ours = JSON.parse(
      readFileSync(pathJoin(recordDir, `control-job-${id}-${PERSIST_OWNER}.json`), "utf8"),
    );
    expect(ours.status).toBe("cancelled");
    expect(ours.reclaimed_dead).toBe(true);
  });

  it("finds the partial an ENV-CREDENTIALED download staged — the reporter's actual case (#1567)", async () => {
    // The cache identity folds the Authorization header in (#467 P1-2), so a gated
    // download's partial is NOT staged under the bare URL's name. Pin both halves:
    // the bare lookup misses it, and the adoption lookup — which rebuilds the
    // headers a re-issue would send now — finds it and resumes.
    config.huggingfaceToken = "hf-test-token";
    const proof = localProof(URL_HF);
    const authedTarget = __downloadCacheTestHooks.cachePathForUrl(URL_HF, {
      Authorization: "Bearer hf-test-token",
    });
    const staged = stagedPartialPathForTarget(authedTarget);
    mkdirSync(dirname(staged), { recursive: true });
    writeFileSync(staged, Buffer.alloc(4096, 1));
    // The half that made the reporter's partials invisible to the naive lookup:
    expect(await findResumablePartial(URL_HF)).toBeNull();

    const id = "orphan1567x0000012";
    writeForeignJobRecord(recordDir, {
      id,
      trayId: downloadIdFor(URL_HF),
      progressId: "prog-dead-12",
      url: URL_HF,
      owner: "dead-session",
      filename: "gated.safetensors",
      viaManager: false,
      downloadRoute: "direct",
      ...proof,
      ageMs: 10 * 60 * 1000,
      pid: deadPid(),
    });

    const adopted = await adoptOrphanedDownloadJobs();

    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ id, filename: "gated.safetensors", resumedBytes: 4096 });
    expect(hoisted.calls).toEqual([
      { url: URL_HF, sub: "loras", filename: "gated.safetensors" },
    ]);
  });

  it("refuses an authed orphan when the current configured identity no longer matches", async () => {
    config.huggingfaceToken = "hf-test-token";
    const proof = localProof(URL_HF);
    const staged = proof.partialPath;
    mkdirSync(dirname(staged), { recursive: true });
    writeFileSync(staged, Buffer.alloc(4096, 1));
    config.huggingfaceToken = "hf-different-token";
    const id = "orphan1567x0000012-mismatch";
    writeForeignJobRecord(recordDir, {
      id,
      trayId: downloadIdFor(URL_HF),
      progressId: "prog-dead-12-mismatch",
      url: URL_HF,
      owner: "dead-session",
      filename: "gated.safetensors",
      viaManager: false,
      downloadRoute: "direct",
      ...proof,
      ageMs: 10 * 60 * 1000,
      pid: deadPid(),
    });

    expect(await adoptOrphanedDownloadJobs()).toEqual([]);
    expect(hoisted.calls).toEqual([]);
    expect(() => readFileSync(pathJoin(recordDir, `control-job-${id}-dead-session.json`), "utf8"))
      .not.toThrow();
  });

  it("adopts ONE of two dead records sharing an id — the second reclaim must not clobber the live replacement's record", async () => {
    // Two dead sessions each left an in-flight record for the SAME download (same
    // id). The record snapshot is taken before the loop, so without an explicit
    // this-pass guard the second record's reclaim would write its administrative
    // cancel over the replacement job's fresh owner-scoped file.
    const id = "orphan1567x0000013";
    for (const owner of ["dead-session-a", "dead-session-b"]) {
      const proof = localProof(URL_X);
      writeForeignJobRecord(recordDir, {
        id,
        trayId: downloadIdFor(URL_X),
        progressId: "prog-dead-13",
        url: URL_X,
        owner,
        viaManager: false,
        downloadRoute: "direct",
        ...proof,
        ageMs: 10 * 60 * 1000,
        pid: deadPid(),
      });
    }
    stagePartial(URL_X, 8192);

    const adopted = await adoptOrphanedDownloadJobs();

    expect(adopted).toHaveLength(1);
    expect(hoisted.calls).toHaveLength(1);
    // The replacement job is live and its OWN record still says so — not the
    // cancelled state a second reclaim would have clobbered it with.
    const live = listDownloadJobs().find((j) => j.url === URL_X && j.status === "downloading");
    expect(live).toBeDefined();
    // The second dead owner's record was left alone (a later pass owns it).
    expect(() =>
      readFileSync(pathJoin(recordDir, `control-job-${id}-dead-session-b.json`), "utf8"),
    ).not.toThrow();
  });

  it("WIRING: every new session boots the adoption pass", async () => {
    // The feature is exactly "the new session adopts" — if boot.ts stops calling
    // this, every guard above still passes and the recovery silently stops
    // happening. Assert the call the same way the respawn-orphans suite asserts
    // its emitter wiring: on the source, comments stripped.
    const src = readFileSync(new URL("../../boot.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*/g, "");
    expect(src).toMatch(/adoptOrphanedDownloadJobs/);
    expect(src).toMatch(/adoptOrphanedDownloadsOnLoad\(\)/);
  });
});
