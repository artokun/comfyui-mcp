import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  resolvers: [] as Array<{ resolve: (p: string) => void; reject: (e: Error) => void; url: string }>,
  calls: 0,
  remote: false,
  resolveTargetCalls: 0,
  // Routing-predicate instrumentation. `dispatchQueue` lets a test make the
  // predicate FLIP between evaluations; `dispatchEvals` counts how many times it
  // was actually evaluated; `lastDispatchArg` records the decision threaded into
  // downloadModel — together they prove the route is decided ONCE and the writer
  // follows it (#420 codex round 1 split-brain guard).
  dispatchQueue: [] as boolean[],
  dispatchEvals: 0,
  lastDispatchArg: undefined as boolean | undefined,
  // The per-download AbortSignal threaded into downloadModel (#515) — captured so a
  // cancel test can prove the abort reached the writer.
  lastSignal: undefined as AbortSignal | undefined,
  // The onTrayId callback threaded into downloadModel (#515) — captured so a test can
  // prove the job's trayId realigns with the actual tray-row id (post-auth/HF rewrite).
  lastOnTrayId: undefined as ((trayId: string) => void) | undefined,
  // The onLanded callback threaded into downloadModel (#515) — captured so a test can
  // prove the job commits done synchronously at the destination rename.
  lastOnLanded: undefined as ((targetPath: string) => void) | undefined,
}));

// isRemoteMode gates the identity branch in startDownloadJob. Keep every other
// real config export (logger etc. depend on them); only the flag is controlled.
vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return { ...actual, isRemoteMode: () => hoisted.remote };
});

// startDownloadJob resolves the canonical destination with the SHARED
// resolveDownloadTarget (so the job is keyed by the exact on-disk targetPath the
// write lands at) and then streams via downloadModel. Mock both: the resolver
// deterministically maps (url, subfolder, filename) → targetPath and REJECTS an
// invalid filename exactly as the real one does, so these tests exercise
// startDownloadJob's keying/adoption/rejection without a live server. The real
// resolveDownloadTarget resolution semantics (trim, "..", url-not-in-identity,
// blank/path-ful rejection) are covered against the real code in
// model-resolver.test.ts.
vi.mock("../../services/model-resolver.js", () => ({
  // The single routing decision startDownloadJob now consults to choose the job
  // identity: manager-dispatch (remote OR #420 reconnect-fallback) skips local
  // target resolution; local streams key by the resolved targetPath. `dispatchQueue`
  // (when non-empty) supplies successive return values so a test can FLIP the
  // predicate between evaluations; otherwise it mirrors `hoisted.remote`.
  shouldDispatchDownloadToManager: vi.fn(async () => {
    hoisted.dispatchEvals += 1;
    return hoisted.dispatchQueue.length ? hoisted.dispatchQueue.shift()! : hoisted.remote;
  }),
  // Capture the routing decision THREADED IN by startDownloadJob (5th arg) so a
  // test can assert the writer used the job's decision, not a fresh evaluation.
  downloadModel: vi.fn(
    (
      url: string,
      _sub?: string,
      _fn?: string,
      _auth?: unknown,
      dispatchToManager?: boolean,
      _onResume?: unknown,
      signal?: AbortSignal,
      onTrayId?: (trayId: string) => void,
      onLanded?: (targetPath: string) => void,
    ) => {
      hoisted.calls += 1;
      hoisted.lastDispatchArg = dispatchToManager;
      hoisted.lastSignal = signal;
      hoisted.lastOnTrayId = onTrayId;
      hoisted.lastOnLanded = onLanded;
      // Model the writer reporting the physical tray id (a hash of the post-auth/HF
      // request URL). Keyed by URL so same-URL jobs to different destinations share one
      // progressId (they coalesce onto one physical stream/row), as in production.
      onTrayId?.(`prog-${url}`);
      return new Promise<string>((resolve, reject) => {
        hoisted.resolvers.push({ resolve, reject, url });
        // Model a real fetch/pipeline: aborting the signal rejects the transfer.
        if (signal) {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }
      });
    },
  ),
  resolveDownloadTarget: vi.fn(async (url: string, sub: string, filename?: string) => {
    hoisted.resolveTargetCalls += 1;
    const s = String(sub ?? "").trim();
    if (filename !== undefined) {
      if (filename === "" || filename.includes("/") || filename.includes("\\")) {
        throw new Error("Invalid model filename");
      }
      return { targetDir: `/M/${s}`, filename, targetPath: `/M/${s}/${filename}` };
    }
    const base = String(url).split("/").pop() || "model.safetensors";
    return { targetDir: `/M/${s}`, filename: base, targetPath: `/M/${s}/${base}` };
  }),
  // #369 post-landing verification. These tests have no filesystem/server, so the
  // stub reports the honest "could not check" verdict and echoes the path back —
  // the real verification semantics live in model-resolver.test.ts.
  verifyLandedModel: vi.fn(async (targetPath: string) => ({
    verifiedPath: targetPath,
    liveVisible: "unknown" as const,
    note: "no live server in this test",
  })),
}));

import {
  startDownloadJob,
  getDownloadJob,
  findDownloadJob,
  listDownloadJobs,
  listDownloadJobCandidates,
  cancelDownloadJob,
  resetDownloadJobs,
  downloadIdFor,
  describePlacement,
} from "../../services/download-jobs.js";
import { setProgressDir, PERSIST_OWNER } from "../../services/download-progress.js";
import * as progressModule from "../../services/download-progress.js";
import { downloadModel, resolveDownloadTarget } from "../../services/model-resolver.js";
import { mkdtemp, mkdir, symlink, writeFile, readFile, rm as fsRm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

/** Simulate ANOTHER MCP session's persisted in-flight record on disk: a distinct
 *  owner-scoped control-job- file (owner ≠ this process's PERSIST_OWNER). Used to
 *  exercise cross-session sibling detection without a second process. */
async function writeForeignJobRecord(
  dir: string,
  rec: {
    id: string;
    trayId: string;
    progressId: string;
    url: string;
    owner: string;
    dest_key?: string;
    /** Route-independent request key (for local↔Manager route-flip adoption). */
    req_key?: string;
    /** Age of the record's `updated` stamp in ms (defaults to fresh). */
    ageMs?: number;
    /** Terminal status to simulate (defaults to an in-flight "downloading" record). */
    status?: "downloading" | "done" | "error" | "cancelled";
    /** Landed path for a "done" record. */
    path?: string;
  },
): Promise<void> {
  const status = rec.status ?? "downloading";
  const body = {
    id: rec.id,
    trayId: rec.trayId,
    progressId: rec.progressId,
    url: rec.url,
    target_subfolder: "loras",
    dest_key: rec.dest_key,
    req_key: rec.req_key,
    status,
    path: rec.path,
    started_at: Date.now(),
    finished_at: status === "downloading" ? undefined : Date.now(),
    owner: rec.owner,
    updated: Date.now() - (rec.ageMs ?? 0),
  };
  await writeFile(pathJoin(dir, `control-job-${rec.id}-${rec.owner}.json`), JSON.stringify(body));
}

const URL_A = "https://huggingface.co/org/repo/resolve/main/big.safetensors";
const URL_B = "https://huggingface.co/org/repo/resolve/main/other.safetensors";

describe("download job registry", () => {
  beforeEach(() => {
    hoisted.resolvers.length = 0;
    hoisted.calls = 0;
    hoisted.remote = false;
    hoisted.resolveTargetCalls = 0;
    hoisted.dispatchQueue.length = 0;
    hoisted.dispatchEvals = 0;
    hoisted.lastDispatchArg = undefined;
    hoisted.lastSignal = undefined;
    hoisted.lastOnTrayId = undefined;
    hoisted.lastOnLanded = undefined;
    resetDownloadJobs();
  });

  it("reports a download as in flight rather than finished or failed", async () => {
    // The bug being fixed: an unfinished download must never read as failure.
    const { job } = await startDownloadJob(URL_A, "checkpoints");
    expect(job.status).toBe("downloading");
    expect(job.path).toBeUndefined();
    expect(job.error).toBeUndefined();
  });

  it("exposes the URL-only tray id plus a destination-keyed job id", async () => {
    const { job } = await startDownloadJob(URL_A, "checkpoints");
    // trayId matches the panel tray / progress-file row (URL-only hash).
    expect(job.trayId).toBe(downloadIdFor(URL_A));
    // The public job id is keyed by the resolved destination, still 16 hex.
    expect(job.id).toHaveLength(16);
    expect(getDownloadJob(job.id)?.trayId).toBe(job.trayId);
  });

  it("adopts an in-flight download to the same destination instead of a second copy", async () => {
    const first = await startDownloadJob(URL_A, "checkpoints");
    const second = await startDownloadJob(URL_A, "checkpoints");
    expect(hoisted.calls).toBe(1);
    expect(second.job).toBe(first.job);
    expect(listDownloadJobs()).toHaveLength(1);
  });

  it("starts a genuinely different destination separately", async () => {
    await startDownloadJob(URL_A, "checkpoints"); // → /M/checkpoints/big.safetensors
    await startDownloadJob(URL_B, "checkpoints"); // → /M/checkpoints/other.safetensors
    expect(hoisted.calls).toBe(2);
    expect(listDownloadJobs()).toHaveLength(2);
  });

  it("keys by destination, not URL — different subfolder/filename → distinct pollable jobs", async () => {
    const a = await startDownloadJob(URL_A, "checkpoints");
    const b = await startDownloadJob(URL_A, "loras", "renamed.safetensors");
    expect(hoisted.calls).toBe(2);
    expect(listDownloadJobs()).toHaveLength(2);
    // Distinct public ids (different destinations), shared URL-only trayId.
    expect(a.job.id).not.toBe(b.job.id);
    expect(a.job.trayId).toBe(b.job.trayId);
    expect(getDownloadJob(a.job.id)).toBe(a.job);
    expect(getDownloadJob(b.job.id)).toBe(b.job);
  });

  it("treats TWO different URLs writing the SAME destination as one job (one writer)", async () => {
    // Identity is the resolved targetPath, NOT the URL — two URLs aimed at one
    // file must serialize to a single writer, not race.
    const first = await startDownloadJob(URL_A, "checkpoints", "model.safetensors");
    const second = await startDownloadJob(URL_B, "checkpoints", "model.safetensors");
    expect(second.job).toBe(first.job);
    expect(second.job.id).toBe(first.job.id);
    expect(hoisted.calls).toBe(1);
    expect(listDownloadJobs()).toHaveLength(1);
  });

  it("rejects an invalid filename up front (as downloadModel would), not a silent merge", async () => {
    await expect(startDownloadJob(URL_A, "checkpoints", "dir/x.safetensors")).rejects.toThrow();
    await expect(startDownloadJob(URL_A, "checkpoints", "")).rejects.toThrow();
    // Nothing was registered for the rejected inputs.
    expect(listDownloadJobs()).toHaveLength(0);
    expect(hoisted.calls).toBe(0);
  });

  it("records the landed path on success", async () => {
    const { job, settled } = await startDownloadJob(URL_A, "checkpoints");
    hoisted.resolvers[0].resolve("C:/models/checkpoints/big.safetensors");
    await settled;
    expect(job.status).toBe("done");
    expect(job.path).toBe("C:/models/checkpoints/big.safetensors");
    expect(job.finished_at).toBeGreaterThan(0);
  });

  it("captures a failure without rejecting the stored promise", async () => {
    // An unhandled rejection here would kill the process over a 404.
    const { job, settled } = await startDownloadJob(URL_A, "checkpoints");
    hoisted.resolvers[0].reject(new Error("HTTP 404"));
    await expect(settled).resolves.toBeUndefined();
    expect(job.status).toBe("error");
    expect(job.error).toContain("404");
  });

  it("allows a retry once a download has failed", async () => {
    const first = await startDownloadJob(URL_A, "checkpoints");
    hoisted.resolvers[0].reject(new Error("network reset"));
    await first.settled;
    // Adoption must not pin a dead job forever — a retry has to start a new one.
    const retry = await startDownloadJob(URL_A, "checkpoints");
    expect(hoisted.calls).toBe(2);
    expect(getDownloadJob(retry.job.id)?.status).toBe("downloading");
  });

  it("in remote mode keys WITHOUT resolving a local target and dispatches to the Manager", async () => {
    // Regression guard: the shared resolver throws when no local models dir exists
    // (COMFYUI_PATH unset). Remote downloads go straight to the Manager, so
    // startDownloadJob must NOT resolve a local targetPath in remote mode.
    hoisted.remote = true;
    const { job } = await startDownloadJob(URL_A, "checkpoints");
    expect(job.status).toBe("downloading");
    expect(hoisted.resolveTargetCalls).toBe(0); // no local resolution attempted
    expect(hoisted.calls).toBe(1); // downloadModel invoked (takes the Manager path)
    // A repeated identical remote request still adopts the in-flight job.
    const again = await startDownloadJob(URL_A, "checkpoints");
    expect(again.job).toBe(job);
    expect(hoisted.calls).toBe(1);
  });

  it("#420: a reconnect-fallback Manager route keys WITHOUT resolving a local target", async () => {
    // After a reconnect drops the effective base, shouldDispatchDownloadToManager
    // returns true for a nominally-local session (driven here by hoisted.remote).
    // startDownloadJob must then take the Manager path and NOT resolve a local
    // targetPath (which would throw "no local ComfyUI path configured") — the exact
    // #420 immediate failure. Adoption of a repeated request must still hold.
    hoisted.remote = true;
    const { job } = await startDownloadJob(URL_A, "loras");
    expect(job.status).toBe("downloading");
    expect(hoisted.resolveTargetCalls).toBe(0);
    expect(hoisted.calls).toBe(1);
    const again = await startDownloadJob(URL_A, "loras");
    expect(again.job).toBe(job);
    expect(hoisted.calls).toBe(1);
  });

  it("#420 split-brain guard: the writer follows the job's ONE routing decision even if reachability would flip", async () => {
    // The predicate awaits live /system_stats + mutable base config, so it could
    // return DIFFERENT answers at the two points it used to be evaluated (job-id
    // keying, then the writer). Model that flip: first eval → Manager, a hypothetical
    // second eval → local. The fix evaluates ONCE and threads the result through, so:
    hoisted.dispatchQueue.push(true, false); // [job-eval → true, would-be writer-eval → false]
    const { job } = await startDownloadJob(URL_A, "loras");
    // Keyed as a Manager job off the FIRST (only) evaluation — no local target resolved.
    expect(hoisted.resolveTargetCalls).toBe(0);
    // The predicate was evaluated EXACTLY ONCE (the "false" in the queue is untouched)…
    expect(hoisted.dispatchEvals).toBe(1);
    expect(hoisted.dispatchQueue).toEqual([false]);
    // …and the writer received that SAME decision (true), NOT a fresh re-evaluation.
    expect(hoisted.lastDispatchArg).toBe(true);
    // One request → one writer, one job. No split, no duplicate.
    expect(hoisted.calls).toBe(1);
    expect(listDownloadJobs()).toHaveLength(1);
  });

  it("threads the LOCAL decision into the writer too (not just the Manager case)", async () => {
    // Symmetric guard: a local job must hand downloadModel dispatchToManager=false
    // so the writer streams to the same targetPath the id was keyed on.
    hoisted.remote = false;
    await startDownloadJob(URL_A, "checkpoints");
    expect(hoisted.resolveTargetCalls).toBe(1); // local id keyed by resolved target
    expect(hoisted.dispatchEvals).toBe(1);
    expect(hoisted.lastDispatchArg).toBe(false);
  });

  it("#420 cross-call dedup: a Manager→local flip BETWEEN two calls still finds the one in-flight job", async () => {
    // The registry index must be ROUTE-INDEPENDENT (#420 codex round 2). Two
    // SEPARATE calls for the SAME request, with a reachability flip between them
    // (call 1 → Manager, call 2 → local), used to compute DIFFERENT keys (remote
    // tuple vs resolved local path) — so call 2 missed the in-flight entry and
    // started a SECOND writer onto one file. With a stable request key, call 2
    // adopts call 1.
    hoisted.dispatchQueue.push(true, false);
    const first = await startDownloadJob(URL_A, "loras");
    const second = await startDownloadJob(URL_A, "loras");
    expect(second.job).toBe(first.job); // same in-flight job, no duplicate
    expect(hoisted.calls).toBe(1); // exactly ONE writer for the request
    expect(listDownloadJobs()).toHaveLength(1); // one registry entry, not two
  });

  it("#420 cross-call dedup: a local→Manager flip BETWEEN two calls also finds the one job", async () => {
    // The reverse flip direction must dedup too.
    hoisted.dispatchQueue.push(false, true);
    const first = await startDownloadJob(URL_A, "loras");
    const second = await startDownloadJob(URL_A, "loras");
    expect(second.job).toBe(first.job);
    expect(hoisted.calls).toBe(1);
    expect(listDownloadJobs()).toHaveLength(1);
  });

  it("#420 rule 1: B adopts A's destination, then a B-repeat after a local→Manager flip still finds the ONE writer", async () => {
    // A and B are DIFFERENT urls resolving to the SAME local destination. B adopts
    // A by destination; the adoption must re-index B's request key onto A. Otherwise
    // a later B-repeat whose route FLIPS to Manager (dropping the destination key)
    // has only its request key, misses A, and starts a SECOND writer onto one file.
    hoisted.dispatchQueue.push(false, false, true); // A local, B local (adopts A), B-repeat Manager
    const a = await startDownloadJob(URL_A, "checkpoints", "m.safetensors");
    const b = await startDownloadJob(URL_B, "checkpoints", "m.safetensors");
    expect(b.job).toBe(a.job); // B adopts A by destination
    const bAgain = await startDownloadJob(URL_B, "checkpoints", "m.safetensors");
    expect(bAgain.job).toBe(a.job); // still the SAME writer, via B's re-indexed request key
    expect(hoisted.calls).toBe(1); // ONE writer for one file — no double-write
    expect(listDownloadJobs()).toHaveLength(1);
  });

  it("#420 rule 3: a FINISHED entry is not adopted and never shadows a live writer on the same destination", async () => {
    // X finishes; a different-url request to the SAME destination starts a fresh
    // writer Y; then repeating X's request must adopt the LIVE Y — not the dead X,
    // and not a third writer.
    const x = await startDownloadJob(URL_A, "checkpoints", "m.safetensors");
    hoisted.resolvers[0].resolve("C:/models/checkpoints/m.safetensors");
    await x.settled;
    expect(x.job.status).toBe("done");

    const y = await startDownloadJob(URL_B, "checkpoints", "m.safetensors"); // same dest, X done → new writer
    expect(y.job).not.toBe(x.job);
    expect(hoisted.calls).toBe(2);

    const xAgain = await startDownloadJob(URL_A, "checkpoints", "m.safetensors"); // X's request repeats
    expect(xAgain.job).toBe(y.job); // adopts the LIVE writer, not the finished X
    expect(hoisted.calls).toBe(2); // no duplicate started
    expect(listDownloadJobs()).toHaveLength(1); // finished X retired; only Y remains
  });

  it("#420 rule 2: retiring a superseded entry never deletes a live writer's index row", async () => {
    // X (finished) is superseded by Y (live) on the same destination; subsequent
    // same-destination requests must keep adopting the single live Y — its index
    // rows are never deleted out from under it by a stale retire.
    const x = await startDownloadJob(URL_A, "checkpoints", "m.safetensors");
    hoisted.resolvers[0].resolve("C:/models/checkpoints/m.safetensors");
    await x.settled;

    const y = await startDownloadJob(URL_A, "checkpoints", "m.safetensors"); // retires X, starts Y
    expect(y.job).not.toBe(x.job);
    expect(y.job.status).toBe("downloading");

    const viaB = await startDownloadJob(URL_B, "checkpoints", "m.safetensors");
    const viaBAgain = await startDownloadJob(URL_B, "checkpoints", "m.safetensors");
    expect(viaB.job).toBe(y.job);
    expect(viaBAgain.job).toBe(y.job);
    expect(hoisted.calls).toBe(2); // only X then Y ever wrote
    expect(listDownloadJobs()).toHaveLength(1);
  });

  it("lists newest first", async () => {
    await startDownloadJob(URL_A, "checkpoints");
    await new Promise((r) => setTimeout(r, 2));
    await startDownloadJob(URL_B, "loras");
    expect(listDownloadJobs()[0].url).toBe(URL_B);
  });

  // #467 P1-A: the job layer dedups BEFORE the header-aware cache layer, so it must
  // fold auth into its keys — otherwise two concurrent same-URL+same-dest calls with
  // DIFFERENT auth adopt the first job and the second caller gets the first's bytes
  // AND resume callback. #467 P1-C: two such distinct jobs to ONE destination are
  // SERIALIZED (not run concurrently) so each callback sees its own bytes.
  it("does NOT coalesce concurrent same-URL+same-dest jobs with DIFFERENT auth (distinct + serialized)", async () => {
    const a = await startDownloadJob(URL_A, "checkpoints", undefined, { type: "bearer", token: "alice" });
    const b = await startDownloadJob(URL_A, "checkpoints", undefined, { type: "bearer", token: "bob" });
    // Two DISTINCT jobs — the second was NOT adopted.
    expect(b.job).not.toBe(a.job);
    expect(b.job.id).not.toBe(a.job.id);
    expect(listDownloadJobs()).toHaveLength(2);
    // Serialized on the shared destination: only A's writer has started; B waits.
    expect(hoisted.calls).toBe(1);

    // Completing A releases B's OWN writer (its own bytes/callback, not A's).
    hoisted.resolvers[0].resolve("/M/checkpoints/big.safetensors");
    await a.settled;
    // Let B's chained continuation run.
    await new Promise((r) => setTimeout(r, 0));
    expect(hoisted.calls).toBe(2);
  });

  it("serializes same-dest different-auth so each onComplete sees ITS OWN bytes (#467 P1-C)", async () => {
    // Simulate the shared destination: each writer overwrites it with its own token,
    // and each job's onComplete records what it observed there.
    let destContent = "";
    const seen: Record<string, string> = {};
    const orig = vi.mocked(downloadModel).getMockImplementation();
    vi.mocked(downloadModel).mockImplementation(
      async (_url: string, sub: string, fn?: string, auth?: unknown) => {
        hoisted.calls += 1;
        destContent = (auth as { token?: string })?.token ?? "none"; // "materialize"
        return `/M/${sub}/${fn ?? "big.safetensors"}`;
      },
    );
    try {
      const a = await startDownloadJob(URL_A, "checkpoints", "m.safetensors", { type: "bearer", token: "alice" }, async () => {
        seen.alice = destContent; // read the destination during Alice's own callback
        return [];
      });
      const b = await startDownloadJob(URL_A, "checkpoints", "m.safetensors", { type: "bearer", token: "bob" }, async () => {
        seen.bob = destContent;
        return [];
      });
      await Promise.all([a.settled, b.settled]);

      // Each callback saw ITS OWN representation's bytes — Bob's writer did not swap
      // the destination out from under Alice's callback (would fail without #467 P1-C).
      expect(seen.alice).toBe("alice");
      expect(seen.bob).toBe("bob");
    } finally {
      if (orig) vi.mocked(downloadModel).mockImplementation(orig);
    }
  });

  it("serializes case-variant same-file destinations on case-insensitive filesystems (#467 P1-C)", async () => {
    // Same (no) auth but case-variant subfolders resolve to distinct path STRINGS,
    // so they are distinct jobs — but on a case-insensitive FS they are ONE physical
    // file and must be serialized.
    const a = await startDownloadJob(URL_A, "checkpoints", "m.safetensors");
    const b = await startDownloadJob(URL_A, "Checkpoints", "m.safetensors");
    expect(b.job).not.toBe(a.job);
    if (process.platform === "win32" || process.platform === "darwin") {
      expect(hoisted.calls).toBe(1); // serialized — same physical file
      hoisted.resolvers[0].resolve("/M/checkpoints/m.safetensors");
      await a.settled;
      await new Promise((r) => setTimeout(r, 0));
      expect(hoisted.calls).toBe(2);
    } else {
      expect(hoisted.calls).toBe(2); // case-sensitive FS → genuinely different files
    }
  });

  it("serializes REMOTE different-auth jobs whose subfolders canonicalize to one destination (#467 P1-C)", async () => {
    hoisted.remote = true; // Manager dispatch — no local target resolution
    // Same file+URL, subfolders that trim/normalize to the SAME remote destination,
    // but DIFFERENT auth → distinct jobs that must be serialized (one server file).
    const a = await startDownloadJob(URL_A, " loras/sub ", "m.safetensors", { type: "bearer", token: "alice" });
    const b = await startDownloadJob(URL_A, "loras//sub", "m.safetensors", { type: "bearer", token: "bob" });
    expect(b.job).not.toBe(a.job); // distinct (different auth)
    expect(hoisted.calls).toBe(1); // serialized on the canonical remote destination
    hoisted.resolvers[0].resolve("ok");
    await a.settled;
    await new Promise((r) => setTimeout(r, 0));
    expect(hoisted.calls).toBe(2);
  });

  it("serializes different-auth jobs whose SYMLINKED subfolders resolve to one physical file (#467 P1-C)", async () => {
    // Build base/real and base/alias -> base/real; the destination tail (sub/m)
    // doesn't exist yet (the writer would mkdir it), exercising the deepest-existing
    // -ancestor realpath collapse.
    const base = await mkdtemp(pathJoin(tmpdir(), "djobs-symlink-"));
    const realDir = pathJoin(base, "real");
    const aliasDir = pathJoin(base, "alias");
    await mkdir(realDir, { recursive: true });
    try {
      await symlink(realDir, aliasDir, "junction");
    } catch {
      await fsRm(base, { recursive: true, force: true });
      return; // symlinks/junctions unsupported here — skip
    }
    try {
      // Two distinct-auth jobs whose resolved targetPaths differ only by alias vs real.
      vi.mocked(resolveDownloadTarget)
        .mockResolvedValueOnce({ targetDir: pathJoin(aliasDir, "sub"), filename: "m.safetensors", targetPath: pathJoin(aliasDir, "sub", "m.safetensors") })
        .mockResolvedValueOnce({ targetDir: pathJoin(realDir, "sub"), filename: "m.safetensors", targetPath: pathJoin(realDir, "sub", "m.safetensors") });

      const a = await startDownloadJob(URL_A, "checkpoints", "m.safetensors", { type: "bearer", token: "alice" });
      const b = await startDownloadJob(URL_A, "checkpoints", "m.safetensors", { type: "bearer", token: "bob" });
      expect(b.job).not.toBe(a.job); // distinct (different auth + different lexical path)
      // realpath collapses alias→real for the EXISTING prefix, so both share a chain.
      expect(hoisted.calls).toBe(1);
      hoisted.resolvers[0].resolve("ok");
      await a.settled;
      await new Promise((r) => setTimeout(r, 0));
      expect(hoisted.calls).toBe(2);
    } finally {
      await fsRm(base, { recursive: true, force: true });
    }
  });

  it("STILL coalesces concurrent same-URL+same-dest jobs with the SAME auth", async () => {
    const a = await startDownloadJob(URL_A, "checkpoints", undefined, { type: "bearer", token: "same" });
    const b = await startDownloadJob(URL_A, "checkpoints", undefined, { type: "bearer", token: "same" });
    expect(b.job).toBe(a.job); // adopted the in-flight job (one writer)
    expect(hoisted.calls).toBe(1);
    expect(listDownloadJobs()).toHaveLength(1);
  });

  it("does NOT let an authenticated job adopt a concurrent UNauthenticated one (same dest)", async () => {
    const pub = await startDownloadJob(URL_A, "checkpoints"); // no auth
    const authed = await startDownloadJob(URL_A, "checkpoints", undefined, { type: "bearer", token: "x" });
    // Distinct jobs (not adopted); serialized behind the unauthenticated one.
    expect(authed.job).not.toBe(pub.job);
    expect(hoisted.calls).toBe(1);
    hoisted.resolvers[0].resolve("/M/checkpoints/big.safetensors");
    await pub.settled;
    await new Promise((r) => setTimeout(r, 0));
    expect(hoisted.calls).toBe(2);
  });

  // ── #822: the exposed `id` is not unique, so it cannot select ─────────────
  //
  // `id` is a hash of the DESTINATION (+auth), deliberately: two URLs landing on
  // one file are one writer. The consequence is that `id` is a DESTINATION handle
  // while download_status renders it as though it were a JOB handle — and when a
  // reconnect leaves an orphaned in-flight record, two rows carry the same id and
  // neither can be selected. The composite (id, trayId) is the real identity; this
  // block is about making it reachable from the public surface.
  describe("#822 selecting one download when an id names several", () => {
    it("lists EVERY download an id answers to, keyed by the true (id, trayId) identity", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-822-"));
      setProgressDir(dir);
      try {
        const a = await startDownloadJob(URL_A, "checkpoints");
        // The #822 shape: an orphan from before a reconnect — same destination
        // (same id), different SOURCE URL (different trayId), heartbeat stale.
        await writeForeignJobRecord(dir, {
          id: a.job.id,
          trayId: "orphantrayid0001",
          progressId: "orphan-prog",
          url: URL_B,
          owner: `${PERSIST_OWNER}-reconnected-away`,
          ageMs: 313_000,
        });

        const candidates = listDownloadJobCandidates(a.job.id);
        expect(candidates).toHaveLength(2);
        // Both share the id — which is exactly why the id alone cannot select.
        expect(new Set(candidates.map((c) => c.id))).toEqual(new Set([a.job.id]));
        // …and both are distinguishable by trayId.
        expect(new Set(candidates.map((c) => c.trayId))).toEqual(
          new Set([a.job.trayId, "orphantrayid0001"]),
        );
      } finally {
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("a LIVE foreign download is never hidden behind this session's settled row for the same URL", async () => {
      // `trayId` is a hash of the URL, so it does NOT separate sessions: this
      // session's finished record and ANOTHER session's still-running download of
      // the same URL to the same destination collapse to one (id, trayId) key.
      // Reporting the settled one would hide a running transfer behind a stale
      // verdict — worse than the ambiguity this selector exists to surface, and it
      // would make `tray_id` weaker than the plain by-id lookup in that state.
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-822-"));
      setProgressDir(dir);
      try {
        const a = await startDownloadJob(URL_A, "checkpoints");
        // Our own download is cancelled and settles…
        cancelDownloadJob(a.job.id, a.job.trayId);
        await a.settled;
        expect(a.job.status).toBe("cancelled");

        // …while another session is still downloading the SAME url to the SAME
        // destination (same id, and — because trayId hashes the url — same trayId).
        await writeForeignJobRecord(dir, {
          id: a.job.id,
          trayId: a.job.trayId,
          progressId: "foreign-live-prog",
          url: URL_A,
          owner: `${PERSIST_OWNER}-other`,
        });

        const candidates = listDownloadJobCandidates(a.job.id);
        expect(candidates).toHaveLength(1);
        // The LIVE one is reported, not our cancelled one.
        expect(candidates[0].status).toBe("downloading");
        expect(getDownloadJob(a.job.id, a.job.trayId)?.status).toBe("downloading");
      } finally {
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("getDownloadJob(id, trayId) resolves the ORPHAN — the row that was unreachable", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-822-"));
      setProgressDir(dir);
      try {
        const a = await startDownloadJob(URL_A, "checkpoints");
        await writeForeignJobRecord(dir, {
          id: a.job.id,
          trayId: "orphantrayid0001",
          progressId: "orphan-prog",
          url: URL_B,
          owner: `${PERSIST_OWNER}-reconnected-away`,
          ageMs: 313_000,
        });

        // By id alone you get the local live one (which is fine, and is #761's rule).
        expect(getDownloadJob(a.job.id)?.trayId).toBe(a.job.trayId);
        // With the tray id you get the specific one you asked for — including the
        // orphan, which #822 reported as unselectable by any means.
        const orphan = getDownloadJob(a.job.id, "orphantrayid0001");
        expect(orphan?.trayId).toBe("orphantrayid0001");
        expect(orphan?.url).toBe(URL_B);
        // And a tray id that names nothing resolves to nothing — not to "whichever".
        expect(getDownloadJob(a.job.id, "nosuchtrayid0000")).toBeUndefined();
      } finally {
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("cancel_download with a tray_id aborts EXACTLY the named row of a COLLIDING id, and leaves the other alone", async () => {
      // The real #822 collision: one live local download and one orphaned in-flight
      // record from before a reconnect, sharing an id because they resolve to the
      // same destination file. `tray_id` must pick out precisely one of them.
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-822-"));
      setProgressDir(dir);
      try {
        const a = await startDownloadJob(URL_A, "checkpoints");
        await writeForeignJobRecord(dir, {
          id: a.job.id,
          trayId: "orphantrayid0001",
          progressId: "orphan-prog",
          url: URL_B,
          owner: `${PERSIST_OWNER}-reconnected-away`,
          ageMs: 313_000,
        });
        // Precondition: the id really does name two rows.
        expect(listDownloadJobCandidates(a.job.id)).toHaveLength(2);

        // Naming the ORPHAN must not touch our live transfer…
        const orphan = cancelDownloadJob(a.job.id, "orphantrayid0001");
        expect(orphan.aborted).toBe(false);
        expect(a.job.status).toBe("downloading");

        // …and a tray id that names NOTHING must abort nothing at all.
        const bogus = cancelDownloadJob(a.job.id, "nosuchtrayid0000");
        expect(bogus.found).toBe(false);
        expect(bogus.aborted).toBe(false);
        expect(a.job.status).toBe("downloading");
        // The refusal still lists what the id DOES name, so the caller can retry.
        expect(bogus.candidates?.map((c) => c.trayId).sort()).toEqual(
          [a.job.trayId, "orphantrayid0001"].sort(),
        );

        // Only the exact tray id aborts the live one.
        const right = cancelDownloadJob(a.job.id, a.job.trayId);
        expect(right.aborted).toBe(true);
        await a.settled;
        expect(a.job.status).toBe("cancelled");
      } finally {
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("an ambiguity refusal NAMES the candidates instead of leaving the caller stuck", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-822-"));
      setProgressDir(dir);
      try {
        const a = await startDownloadJob(URL_A, "checkpoints");
        // A FRESH foreign sibling: a genuinely concurrent different-URL download to
        // the same destination. Cancel-by-id must still decline (#515) — but the
        // refusal now carries the tray ids that resolve it, which is the difference
        // between "no move available" and an actionable next step.
        await writeForeignJobRecord(dir, {
          id: a.job.id,
          trayId: "freshtrayid00001",
          progressId: "fresh-prog",
          url: URL_B,
          owner: `${PERSIST_OWNER}-other`,
        });

        const res = cancelDownloadJob(a.job.id);
        expect(res.ambiguous).toBe(true);
        expect(res.aborted).toBe(false);
        expect(res.candidates?.map((c) => c.trayId).sort()).toEqual(
          [a.job.trayId, "freshtrayid00001"].sort(),
        );

        // And naming one resolves it: the local job CAN be cancelled by tray id.
        const chosen = cancelDownloadJob(a.job.id, a.job.trayId);
        expect(chosen.aborted).toBe(true);
        await a.settled;
        expect(a.job.status).toBe("cancelled");
      } finally {
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("a foreign-session download selected by tray_id is reported as NOT abortable here — never falsely aborted", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-822-"));
      setProgressDir(dir);
      try {
        const a = await startDownloadJob(URL_A, "checkpoints");
        await writeForeignJobRecord(dir, {
          id: a.job.id,
          trayId: "orphantrayid0001",
          progressId: "orphan-prog",
          url: URL_B,
          owner: `${PERSIST_OWNER}-reconnected-away`,
          ageMs: 313_000,
        });

        const res = cancelDownloadJob(a.job.id, "orphantrayid0001");
        expect(res.found).toBe(true);
        // We hold no AbortController for another session's writer — say so rather
        // than reporting an abort that did not happen.
        expect(res.owned).toBe(false);
        expect(res.aborted).toBe(false);
        expect(res.job?.url).toBe(URL_B);
        // Our own live download was NOT collateral damage.
        expect(a.job.status).toBe("downloading");
      } finally {
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });
  });

  // ── #515: per-download cancellation ────────────────────────────────────────
  describe("#515 per-download cancellation", () => {
    it("cancels a running download by id — aborts the stream, no false-complete, and never resurrects to done/error", async () => {
      const { job, settled } = await startDownloadJob(URL_A, "checkpoints");
      expect(job.status).toBe("downloading");
      // A signal was threaded into the writer (the abort handle).
      expect(hoisted.lastSignal).toBeInstanceOf(AbortSignal);
      expect(hoisted.lastSignal!.aborted).toBe(false);

      const res = cancelDownloadJob(job.id);
      expect(res.found).toBe(true);
      expect(res.owned).toBe(true);
      expect(res.aborted).toBe(true); // abort REQUESTED (best-effort; final state via settled)
      // The abort reached the writer's signal.
      expect(hoisted.lastSignal!.aborted).toBe(true);

      // The FINAL state is resolved by the settled closure: the writer's stream rejects
      // because of the abort (modeled in the mock), so it settles as cancelled — never a
      // false "error" and never a false-complete (no landed path).
      await settled;
      expect(job.status).toBe("cancelled");
      expect(job.error).toBeUndefined();
      expect(job.path).toBeUndefined();
    });

    it("cancel only aborts the targeted download — other in-flight downloads keep running", async () => {
      const a = await startDownloadJob(URL_A, "checkpoints");
      const b = await startDownloadJob(URL_B, "loras");
      expect(hoisted.calls).toBe(2);

      cancelDownloadJob(a.job.id);
      // B is untouched and still streaming.
      expect(b.job.status).toBe("downloading");
      await a.settled; // the abort rejects A's stream → cancelled
      expect(a.job.status).toBe("cancelled");

      // B still completes normally.
      const bResolver = hoisted.resolvers.find((r) => r.url === URL_B)!;
      bResolver.resolve("/M/loras/other.safetensors");
      await b.settled;
      expect(b.job.status).toBe("done");
      expect(b.job.path).toBe("/M/loras/other.safetensors");
    });

    it("is idempotent — a second cancel, or a cancel of a finished/failed job, is a no-op", async () => {
      const { job, settled } = await startDownloadJob(URL_A, "checkpoints");
      cancelDownloadJob(job.id);
      await settled;
      const again = cancelDownloadJob(job.id);
      expect(again.aborted).toBe(false);
      expect(again.status).toBe("cancelled");

      // A completed download can't be cancelled.
      const done = await startDownloadJob(URL_B, "loras");
      hoisted.resolvers.find((r) => r.url === URL_B)!.resolve("/M/loras/other.safetensors");
      await done.settled;
      const res = cancelDownloadJob(done.job.id);
      expect(res.aborted).toBe(false);
      expect(res.status).toBe("done");
      expect(done.job.status).toBe("done");
    });

    it("reports a not-found id honestly", () => {
      const res = cancelDownloadJob("deadbeefdeadbeef");
      expect(res.found).toBe(false);
      expect(res.aborted).toBe(false);
    });

    it("marks a remote Manager-dispatched job viaManager, and a cancel during dispatch reports cancelled (not done)", async () => {
      hoisted.remote = true; // route to the remote ComfyUI-Manager dispatch
      const { job, settled } = await startDownloadJob(URL_A, "checkpoints");
      expect(job.viaManager).toBe(true);

      // A cancel while the dispatch is in flight must NOT be converted to "done" by a
      // dispatch return — the mock rejects on abort exactly as the real remote path
      // throws on abort, so the job settles as cancelled.
      cancelDownloadJob(job.id);
      await settled;
      expect(job.status).toBe("cancelled");
      expect(job.path).toBeUndefined();
    });

    it("declines cancel-by-id (and status-by-id) when a live foreign session shares the id with a different trayId", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-persist-"));
      setProgressDir(dir);
      try {
        const a = await startDownloadJob(URL_A, "checkpoints");
        // A concurrent foreign session downloads a DIFFERENT url to the SAME dest+auth:
        // same id, different (fresh) trayId.
        await writeForeignJobRecord(dir, {
          id: a.job.id,
          trayId: "foreigntrayid000",
          progressId: "foreign-prog",
          url: URL_B,
          owner: `${PERSIST_OWNER}-other`,
        });

        // cancel_download by id must DECLINE (could hit the wrong concurrent download).
        const res = cancelDownloadJob(a.job.id);
        expect(res.ambiguous).toBe(true);
        expect(res.aborted).toBe(false);
        expect(a.job.status).toBe("downloading"); // not cancelled
        // status-by-id likewise declines rather than silently reporting the local one.
        expect(getDownloadJob(a.job.id)).toBeUndefined();

        // A STALE foreign record (dead session) does NOT block the local id — cancel works.
        await fsRm(pathJoin(dir, `control-job-${a.job.id}-${PERSIST_OWNER}-other.json`), { force: true });
        await writeForeignJobRecord(dir, {
          id: a.job.id,
          trayId: "foreigntrayid000",
          progressId: "foreign-prog",
          url: URL_B,
          owner: `${PERSIST_OWNER}-dead`,
          ageMs: 10 * 60 * 1000,
        });
        expect(getDownloadJob(a.job.id)?.id).toBe(a.job.id);
        const res2 = cancelDownloadJob(a.job.id);
        expect(res2.aborted).toBe(true);
        await a.settled;
        expect(a.job.status).toBe("cancelled");
      } finally {
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("cancelling a coalesced sibling does NOT clear the active owner's shared progress row (only the last one out clears it)", async () => {
      const clearSpy = vi.spyOn(progressModule, "clearDownloadProgress");
      try {
        // Two DIFFERENT-destination jobs for the same URL coalesce onto one physical
        // stream and share ONE progress row (progressId). Simulate the writer having
        // reported that shared id to both.
        const ja = await startDownloadJob(URL_A, "checkpoints");
        const jb = await startDownloadJob(URL_A, "loras");
        ja.job.progressId = "sharedprogressid";
        jb.job.progressId = "sharedprogressid";
        clearSpy.mockClear();

        // Cancel the coalesced sibling B while owner A is still in flight — A's live
        // row MUST survive (B must not clear the shared id). The clean-up runs in B's
        // settled closure (registry-aware), so await it.
        const resB = cancelDownloadJob(jb.job.id);
        expect(resB.aborted).toBe(true);
        await jb.settled;
        expect(jb.job.status).toBe("cancelled");
        expect(clearSpy).not.toHaveBeenCalledWith("sharedprogressid");

        // Now cancel the owner A — no other in-flight job shares the id, so the row is
        // finally cleared.
        const resA = cancelDownloadJob(ja.job.id);
        expect(resA.aborted).toBe(true);
        await ja.settled;
        expect(clearSpy).toHaveBeenCalledWith("sharedprogressid");
      } finally {
        clearSpy.mockRestore();
      }
    });

    it("does NOT clear another SESSION's shared progress row on cancel — even for the SAME job id (owner-scoped sibling check)", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-persist-"));
      setProgressDir(dir);
      const clearSpy = vi.spyOn(progressModule, "clearDownloadProgress");
      try {
        // This session starts A locally; it shares progressId "prog-URL_A" with the row.
        const a = await startDownloadJob(URL_A, "checkpoints");
        expect(a.job.progressId).toBe(`prog-${URL_A}`);

        // ANOTHER session is running the SAME logical download — SAME deterministic id
        // AND the same progressId, but a DIFFERENT owner (distinct persisted file).
        await writeForeignJobRecord(dir, {
          id: a.job.id,
          trayId: a.job.trayId,
          progressId: `prog-${URL_A}`,
          url: URL_A,
          owner: `${PERSIST_OWNER}-other`,
        });
        clearSpy.mockClear();

        // Cancelling our copy must NOT clear the row — the other session still uses it.
        // (id-based exclusion would miss the foreign same-id record; owner-based catches it.)
        const res = cancelDownloadJob(a.job.id);
        expect(res.aborted).toBe(true);
        await a.settled;
        expect(clearSpy).not.toHaveBeenCalledWith(`prog-${URL_A}`);
      } finally {
        clearSpy.mockRestore();
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("a STALE (crashed-session) foreign record does NOT suppress cleanup of a sole cancelled job", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-persist-"));
      setProgressDir(dir);
      const clearSpy = vi.spyOn(progressModule, "clearDownloadProgress");
      try {
        const a = await startDownloadJob(URL_A, "checkpoints");
        // A crashed session left a stale in-flight record (heartbeat stopped long ago).
        await writeForeignJobRecord(dir, {
          id: a.job.id,
          trayId: a.job.trayId,
          progressId: `prog-${URL_A}`,
          url: URL_A,
          owner: `${PERSIST_OWNER}-dead`,
          ageMs: 10 * 60 * 1000, // 10 min old → well past the staleness threshold
        });
        clearSpy.mockClear();
        const res = cancelDownloadJob(a.job.id);
        expect(res.aborted).toBe(true);
        await a.settled;
        // The dead session's stale record must NOT block our clean-up.
        expect(clearSpy).toHaveBeenCalledWith(`prog-${URL_A}`);
      } finally {
        clearSpy.mockRestore();
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("DOES clear the row on cancel when this session is the only owner", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-persist-"));
      setProgressDir(dir);
      const clearSpy = vi.spyOn(progressModule, "clearDownloadProgress");
      try {
        const a = await startDownloadJob(URL_A, "checkpoints");
        expect(a.job.progressId).toBe(`prog-${URL_A}`);
        clearSpy.mockClear();
        const res = cancelDownloadJob(a.job.id);
        expect(res.aborted).toBe(true);
        await a.settled;
        // Sole owner, no sibling in either store → the row IS cleared.
        expect(clearSpy).toHaveBeenCalledWith(`prog-${URL_A}`);
      } finally {
        clearSpy.mockRestore();
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("records the actual tray-row id as progressId WITHOUT disturbing the stable trayId (so cancel cleanup + URL adoption both work)", async () => {
      const { job } = await startDownloadJob(URL_A, "checkpoints");
      expect(job.trayId).toBe(downloadIdFor(URL_A));
      // The writer reports the id the tray rows are ACTUALLY written under (a hash of
      // the post-auth/HF-rewrite request URL).
      expect(hoisted.lastOnTrayId).toBeInstanceOf(Function);
      hoisted.lastOnTrayId!("aaaabbbbccccdddd");
      // progressId adopts it (used for byte display + cancel cleanup)…
      expect(job.progressId).toBe("aaaabbbbccccdddd");
      // …but trayId stays the STABLE original-URL hash so URL adoption still resolves.
      expect(job.trayId).toBe(downloadIdFor(URL_A));
      expect(findDownloadJob({ url: URL_A })?.id).toBe(job.id);
    });

    it("a cancel DURING the onComplete post-download hook reports done — the model file already MATERIALIZED", async () => {
      // The physical download FINISHED (downloadModel resolved a path ⇒ the model file
      // materialized + validated to its destination) and THEN onComplete (e.g. the
      // CivitAI sidecar hook) runs. A cancel arriving in that window is too late: the
      // real model is on disk, so the honest outcome is DONE (not a false "cancelled,
      // resumable partial" while a complete file exists at the destination).
      let releaseOnComplete!: () => void;
      const gate = new Promise<void>((r) => {
        releaseOnComplete = r;
      });
      let signalOnCompleteStarted!: () => void;
      const started = new Promise<void>((r) => {
        signalOnCompleteStarted = r;
      });
      const { job, settled } = await startDownloadJob(
        URL_A,
        "checkpoints",
        undefined,
        undefined,
        async () => {
          signalOnCompleteStarted();
          await gate;
          return ["sidecar written"];
        },
      );
      // Finish the transfer so the file has landed and onComplete begins.
      hoisted.resolvers[0].resolve("/M/checkpoints/big.safetensors");
      await started;

      cancelDownloadJob(job.id); // too late — the file already materialized

      releaseOnComplete(); // let the hook finish
      await settled;

      // The completed, validated file is on disk → honest report is done with its path.
      expect(job.status).toBe("done");
      expect(job.path).toBe("/M/checkpoints/big.safetensors");
    });

    it("commits done at the destination rename (onLanded), so a cancel in the rename→return window is a no-op", async () => {
      const { job, settled } = await startDownloadJob(URL_A, "checkpoints", "big.safetensors");
      expect(job.status).toBe("downloading");
      // The writer renames the completed file into place → onLanded fires SYNCHRONOUSLY.
      expect(hoisted.lastOnLanded).toBeInstanceOf(Function);
      hoisted.lastOnLanded!("/M/checkpoints/big.safetensors");
      // Done is committed the instant the file lands — before downloadModel even returns.
      expect(job.status).toBe("done");
      expect(job.path).toBe("/M/checkpoints/big.safetensors");

      // A cancel arriving in the window between landing and the return is a NO-OP
      // (the file is already on disk) — never a false "cancelled" over a complete file.
      const res = cancelDownloadJob(job.id);
      expect(res.aborted).toBe(false);
      expect(res.status).toBe("done");

      hoisted.resolvers[0].resolve("/M/checkpoints/big.safetensors");
      await settled;
      expect(job.status).toBe("done");
    });

    it("a cancel that arrives just before the rename's onLanded continuation still lands as done (no cancelled-over-complete race)", async () => {
      // The exact round-27 race: the destination rename physically completed, but a cancel
      // arrives before its onLanded promise-continuation runs. cancelDownloadJob must NOT
      // synchronously mark the job cancelled — otherwise commitDone (which only advances a
      // "downloading" job) could not correct it and a complete validated file would read
      // "cancelled".
      const { job, settled } = await startDownloadJob(URL_A, "checkpoints", "big.safetensors");
      const res = cancelDownloadJob(job.id);
      expect(res.aborted).toBe(true);
      // NOT synchronously cancelled — the final state is decided by what happened on disk.
      expect(job.status).toBe("downloading");
      // The rename's continuation now fires onLanded → commitDone → done, despite the abort.
      hoisted.lastOnLanded!("/M/checkpoints/big.safetensors");
      expect(job.status).toBe("done");
      expect(job.path).toBe("/M/checkpoints/big.safetensors");
      hoisted.resolvers[0].resolve("/M/checkpoints/big.safetensors");
      await settled;
      expect(job.status).toBe("done");
    });

    it("if the file MATERIALIZES despite a late cancel, the job reports done (a real complete file, not a false 'cancelled')", async () => {
      // Model the race where materialize/rename completed before the abort took effect:
      // downloadModel RESOLVES a path even though the signal was aborted.
      vi.mocked(downloadModel).mockImplementationOnce(
        async (_url: string, sub: string, fn?: string) => `/M/${sub}/${fn ?? "big.safetensors"}`,
      );
      const { job, settled } = await startDownloadJob(URL_A, "checkpoints", "big.safetensors");
      cancelDownloadJob(job.id); // the download already resolved (file landed)
      await settled;
      expect(job.status).toBe("done");
      expect(job.path).toBe("/M/checkpoints/big.safetensors");
    });
  });

  // ── #529: adopt an in-flight download after a session reconnect ─────────────
  describe("#529 reconnect adoption", () => {
    it("still resolves an in-flight download by id (and by URL) after a simulated reconnect", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-persist-"));
      setProgressDir(dir); // enable the cross-session persisted store (as the panel does)
      try {
        const { job } = await startDownloadJob(URL_A, "checkpoints");
        expect(job.status).toBe("downloading");
        const id = job.id;
        // Simulate the writer reporting a DIFFERENT physical progress id (as a
        // query-auth / HF-rewritten URL would) — URL adoption must still work off the
        // stable original-URL trayId, not this rewritten progressId.
        hoisted.lastOnTrayId?.("ffff0000ffff0000");

        // A reconnect respawns the MCP child: the in-memory registry is empty again.
        resetDownloadJobs();
        expect(listDownloadJobs().find((j) => j.id === id && j.status === "downloading")).toBeTruthy();

        // Before the fix this returned undefined ("tracked per server session").
        const adopted = getDownloadJob(id);
        expect(adopted).toBeTruthy();
        expect(adopted!.id).toBe(id);
        expect(adopted!.status).toBe("downloading");
        expect(adopted!.trayId).toBe(downloadIdFor(URL_A));

        // Adoptable by source URL too (no id needed), without starting a duplicate.
        const byUrl = findDownloadJob({ url: URL_A });
        expect(byUrl?.id).toBe(id);
        expect(hoisted.calls).toBe(1); // no second writer spun up
      } finally {
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("declines an ambiguous URL adoption when the same URL has two in-flight destinations across stores", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-persist-"));
      setProgressDir(dir);
      try {
        // Two same-URL downloads to DIFFERENT destinations — distinct jobs, both in
        // flight, both persisted.
        const a = await startDownloadJob(URL_A, "checkpoints");
        const b = await startDownloadJob(URL_A, "loras");
        expect(a.job.id).not.toBe(b.job.id);

        // Reconnect, then re-create ONLY A in this session so the ambiguity spans BOTH
        // stores: in-memory A (URL_A→checkpoints) + persisted-only B (URL_A→loras).
        resetDownloadJobs();
        const a2 = await startDownloadJob(URL_A, "checkpoints");
        expect(a2.job.id).toBe(a.job.id);

        // Adopting by URL alone can't tell A from B — must decline, not guess.
        expect(findDownloadJob({ url: URL_A })).toBeUndefined();
        // …but each is still resolvable by its exact id.
        expect(getDownloadJob(a.job.id)?.id).toBe(a.job.id);
        expect(getDownloadJob(b.job.id)?.id).toBe(b.job.id);
      } finally {
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("lists BOTH same-id/different-trayId physical downloads and declines the ambiguous id lookup", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-persist-"));
      setProgressDir(dir);
      try {
        // This session runs one download (id X, trayId = downloadIdFor(URL_A)).
        const a = await startDownloadJob(URL_A, "checkpoints");
        const id = a.job.id;
        const trayA = a.job.trayId;
        // Another session ran a DISTINCT URL that resolved to the SAME dest+auth: same
        // deterministic id, but a DIFFERENT trayId — a distinct physical download.
        await writeForeignJobRecord(dir, {
          id,
          trayId: "distincttrayid00",
          progressId: "other-prog",
          url: URL_B,
          owner: `${PERSIST_OWNER}-other`,
        });
        // Reconnect: drop the in-memory copy so resolution goes through the persisted
        // store where both records (same id, different trayId) coexist.
        resetDownloadJobs();

        // download_status with no selector must list BOTH, not silently drop one.
        const all = listDownloadJobs();
        const mine = all.filter((j) => j.id === id);
        expect(new Set(mine.map((j) => j.trayId))).toEqual(new Set([trayA, "distincttrayid00"]));
        // An id lookup can't disambiguate the two → decline rather than guess.
        expect(getDownloadJob(id)).toBeUndefined();
      } finally {
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("a STALE foreign same-id/different-trayId record does NOT block resolving the fresh valid job after reconnect", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-persist-"));
      setProgressDir(dir);
      try {
        const a = await startDownloadJob(URL_A, "checkpoints");
        const id = a.job.id;
        const trayA = a.job.trayId;
        // A crashed foreign session left a STALE in-flight record sharing the id with a
        // different trayId. It must NOT permanently make the id unresolvable.
        await writeForeignJobRecord(dir, {
          id,
          trayId: "staletray0000000",
          progressId: "stale-prog",
          url: URL_B,
          owner: `${PERSIST_OWNER}-dead`,
          ageMs: 10 * 60 * 1000,
        });
        // Reconnect: resolution now goes through the persisted store.
        resetDownloadJobs();

        // The fresh valid record (A) must still resolve — the stale one is ignored.
        const got = getDownloadJob(id);
        expect(got?.id).toBe(id);
        expect(got?.trayId).toBe(trayA);
        expect(got?.status).toBe("downloading");
        // cancel_download reports it as tracked-but-not-owned (another session), NOT "not found".
        const res = cancelDownloadJob(id);
        expect(res.found).toBe(true);
        expect(res.owned).toBe(false);
        // URL adoption also ignores the stale sibling and resolves the fresh job.
        expect(findDownloadJob({ url: URL_A })?.id).toBe(id);
      } finally {
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("URL adoption ignores a STALE sibling for the same URL and still resolves the fresh in-flight job", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-persist-"));
      setProgressDir(dir);
      try {
        // Fresh in-flight job for URL_A → checkpoints (this session).
        const a = await startDownloadJob(URL_A, "checkpoints");
        // A STALE crashed record for the SAME URL_A → a different destination (loras):
        // different id AND trayId is the same URL hash, so it matches the URL query too.
        await writeForeignJobRecord(dir, {
          id: "otheridxxxxxxxxx",
          trayId: downloadIdFor(URL_A),
          progressId: "stale-prog",
          url: URL_A,
          owner: `${PERSIST_OWNER}-dead`,
          ageMs: 10 * 60 * 1000,
        });
        // The stale sibling must NOT inflate the ambiguity count → the fresh job resolves.
        expect(findDownloadJob({ url: URL_A })?.id).toBe(a.job.id);
      } finally {
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("never reads a half-written temp as a record (atomic-write safety → no torn-read missed adoption)", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-persist-"));
      setProgressDir(dir);
      try {
        // A valid, complete in-flight record.
        await writeForeignJobRecord(dir, {
          id: "validid000000001",
          trayId: "validtray0000001",
          progressId: "p",
          url: URL_A,
          owner: "sess",
        });
        // A half-written atomic-write temp with GARBAGE bytes (what a reader could see if
        // persist wrote in place). Its name ends in `.tmp`, so no scanner reads it.
        await writeFile(
          pathJoin(dir, `control-job-validid000000001-sess.json.99999-0.tmp`),
          "{ half-written garba",
        );
        // Readers see only the complete record — never the torn temp.
        expect(getDownloadJob("validid000000001")?.status).toBe("downloading");
        expect(listDownloadJobs().filter((j) => j.id === "validid000000001")).toHaveLength(1);
      } finally {
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("keeps a heartbeat-stale in-flight record visible without deleting its persisted state (#761)", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-persist-"));
      setProgressDir(dir);
      try {
        // A reconnect can interrupt the owner's heartbeat while its HTTP transfer and
        // .partial continue. A status read must not erase the only record for it.
        const id = "stalejobxxxxxxxx1";
        const owner = "reconnecting-session";
        await writeForeignJobRecord(dir, {
          id,
          trayId: downloadIdFor(URL_A),
          progressId: "stale-prog",
          url: URL_A,
          owner,
          ageMs: 5 * 60 * 1000,
        });
        const listed = listDownloadJobs().find((j) => j.id === id);
        expect(listed).toMatchObject({ status: "downloading", staleInflight: true });
        expect(listed?.staleForMs).toBeGreaterThan(60_000);
        // The control file survives the read; a later owner heartbeat can refresh it.
        await expect(readFile(pathJoin(dir, `control-job-${id}-${owner}.json`), "utf8")).resolves.toContain(id);
        // URL status can still surface the stale record, but the independent
        // start/adoption and ambiguity paths retain their short freshness checks.
        expect(findDownloadJob({ url: URL_A })).toMatchObject({ id, staleInflight: true });
      } finally {
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("reaps terminal persisted records after the bounded TTL", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-persist-"));
      setProgressDir(dir);
      try {
        const id = "expiredterminal0001";
        const owner = "old-session";
        await writeForeignJobRecord(dir, {
          id,
          trayId: "expiredtray00001",
          progressId: "expired-prog",
          url: URL_A,
          owner,
          status: "done",
          path: "/M/checkpoints/old.safetensors",
          ageMs: 7 * 60 * 60 * 1000,
        });
        expect(listDownloadJobs().some((j) => j.id === id)).toBe(false);
        await expect(readFile(pathJoin(dir, `control-job-${id}-${owner}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("reflects the terminal outcome across a reconnect (a completed job persists as done)", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-persist-"));
      setProgressDir(dir);
      try {
        const { job, settled } = await startDownloadJob(URL_A, "checkpoints");
        const id = job.id;
        hoisted.resolvers[0].resolve("/M/checkpoints/big.safetensors");
        await settled;
        expect(job.status).toBe("done");

        resetDownloadJobs(); // reconnect
        const adopted = getDownloadJob(id);
        expect(adopted?.status).toBe("done");
        expect(adopted?.path).toBe("/M/checkpoints/big.safetensors");
      } finally {
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("a reconnect + reissue ADOPTS another session's in-flight download instead of starting a SECOND writer", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-persist-"));
      setProgressDir(dir);
      try {
        // Session A started the download (this test process stands in for it to compute
        // the real deterministic id), then a DIFFERENT session (owner) owns it in flight.
        const a = await startDownloadJob(URL_A, "checkpoints");
        const id = a.job.id;
        expect(hoisted.calls).toBe(1);
        // Simulate the OTHER session owning the in-flight download, and this session NOT
        // having it: rewrite the record under a different owner and drop our own copy +
        // in-memory registry (a reconnect is a NEW process = NEW owner).
        await fsRm(pathJoin(dir, `control-job-${id}-${PERSIST_OWNER}.json`), { force: true });
        await writeForeignJobRecord(dir, {
          id,
          trayId: a.job.trayId,
          progressId: `prog-${URL_A}`,
          url: URL_A,
          owner: `${PERSIST_OWNER}-other`,
          dest_key: a.job.destKey,
        });
        resetDownloadJobs();

        // Reissue the SAME url/destination — must ADOPT the foreign in-flight job.
        const b = await startDownloadJob(URL_A, "checkpoints");
        expect(b.job.id).toBe(id);
        expect(b.job.status).toBe("downloading");
        // Crucially: NO second physical writer was started for the same file.
        expect(hoisted.calls).toBe(1);
        // The adopted view is read-only (not registered) — settled resolves immediately.
        await expect(b.settled).resolves.toBeUndefined();
      } finally {
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("this session's IN-MEMORY cancelled does NOT mask another session's validated DONE (same id)", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-persist-"));
      setProgressDir(dir);
      try {
        // This session (A) is cancelled locally — its in-memory record is terminal cancelled.
        const a = await startDownloadJob(URL_A, "checkpoints");
        cancelDownloadJob(a.job.id);
        await a.settled;
        expect(a.job.status).toBe("cancelled");
        // Another session (B) landed + VALIDATED the SAME file (done), same id + trayId.
        await writeForeignJobRecord(dir, {
          id: a.job.id,
          trayId: a.job.trayId,
          progressId: `prog-${URL_A}`,
          url: URL_A,
          owner: `${PERSIST_OWNER}-other`,
          status: "done",
          path: "/M/checkpoints/big.safetensors",
        });

        // NON-reconnect: A is STILL in this process's in-memory registry as cancelled — but
        // getDownloadJob and the no-selector list must report B's validated DONE, not A's cancelled.
        const got = getDownloadJob(a.job.id);
        expect(got?.status).toBe("done");
        expect(got?.path).toBe("/M/checkpoints/big.safetensors");
        const listed = listDownloadJobs().find((j) => j.id === a.job.id && j.trayId === a.job.trayId);
        expect(listed?.status).toBe("done");
      } finally {
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("adopts across a local↔Manager route flip via the route-independent reqKey (not just id)", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-persist-"));
      setProgressDir(dir);
      try {
        // This session runs LOCAL → public id = destination hash; capture its reqKey.
        const a = await startDownloadJob(URL_A, "checkpoints");
        const reqKey = a.job.reqKey!;
        const localId = a.job.id;
        expect(reqKey).toBeTruthy();
        // The OTHER session ran the SAME request via the MANAGER route → a DIFFERENT public
        // id (keyed by the request key) but the SAME reqKey + trayId. Remove our own record.
        await fsRm(pathJoin(dir, `control-job-${localId}-${PERSIST_OWNER}.json`), { force: true });
        await writeForeignJobRecord(dir, {
          id: reqKey, // remote route keys the public id by the request key
          trayId: a.job.trayId,
          progressId: "foreign-prog",
          url: URL_A,
          owner: `${PERSIST_OWNER}-other`,
          req_key: reqKey,
        });
        resetDownloadJobs();

        // Reissue LOCALLY (our id = destination hash ≠ the foreign remote id) — must still
        // ADOPT the foreign in-flight download via the route-independent reqKey, not
        // double-write.
        const b = await startDownloadJob(URL_A, "checkpoints");
        expect(b.job.id).toBe(reqKey); // adopted the foreign (remote-keyed) record
        expect(b.job.status).toBe("downloading");
        expect(hoisted.calls).toBe(1); // NO second physical writer
      } finally {
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("stops a completed job's heartbeat when persistence goes inactive (no forever-retrying interval)", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-persist-"));
      setProgressDir(dir);
      vi.useFakeTimers();
      const clearSpy = vi.spyOn(globalThis, "clearInterval");
      try {
        const entry = await startDownloadJob(URL_A, "checkpoints");
        const hb = (entry as { heartbeat?: ReturnType<typeof setInterval> }).heartbeat;
        expect(hb).toBeDefined();
        // Persistence goes INACTIVE, then the download completes. The settled finally's
        // terminal persist no-ops (no dir → not durable), so it does NOT clear the
        // heartbeat there — the heartbeat itself must stop on its next tick.
        setProgressDir("");
        hoisted.resolvers[0].resolve("/M/checkpoints/big.safetensors");
        await entry.settled;
        clearSpy.mockClear();
        // One heartbeat tick later, the terminal branch clears the interval (persistence
        // inactive) — a completed job's interval never does filesystem work forever.
        await vi.advanceTimersByTimeAsync(15_001);
        expect(clearSpy).toHaveBeenCalledWith(hb);
      } finally {
        vi.useRealTimers();
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("installs a heartbeat only when the persisted store is active (no leak on non-panel downloads)", async () => {
      // No progress dir → persistence inactive → NO heartbeat interval (would otherwise
      // leak, retrying a no-op forever since persist never reports durable).
      const noPanel = await startDownloadJob(URL_A, "checkpoints");
      expect((noPanel as { heartbeat?: unknown }).heartbeat).toBeUndefined();

      // With a progress dir → a heartbeat is installed (and cleared by resetDownloadJobs).
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-persist-"));
      setProgressDir(dir);
      try {
        const panel = await startDownloadJob(URL_B, "loras");
        expect((panel as { heartbeat?: unknown }).heartbeat).toBeDefined();
      } finally {
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("does NOT adopt a foreign live download of a DIFFERENT url to the same destination (same id, different trayId)", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-persist-"));
      setProgressDir(dir);
      try {
        // Discover the deterministic id for URL_A → checkpoints, then clear everything.
        const probe = await startDownloadJob(URL_A, "checkpoints");
        const id = probe.job.id;
        const destKey = probe.job.destKey;
        await fsRm(pathJoin(dir, `control-job-${id}-${PERSIST_OWNER}.json`), { force: true });
        resetDownloadJobs();
        // A foreign session is live-downloading a DIFFERENT source url (different trayId)
        // to the SAME destination+auth (same id).
        await writeForeignJobRecord(dir, {
          id,
          trayId: "differenturltray",
          progressId: "foreign-prog",
          url: URL_B,
          owner: `${PERSIST_OWNER}-other`,
          dest_key: destKey,
        });

        // Reissuing URL_A must NOT adopt the foreign URL_B download — it's a distinct
        // logical download. We start our OWN writer for URL_A.
        const b = await startDownloadJob(URL_A, "checkpoints");
        expect(b.job.trayId).toBe(downloadIdFor(URL_A)); // OUR url, not the foreign one
        expect(b.job.status).toBe("downloading");
        expect(hoisted.calls).toBe(2); // our own writer started (probe was call 1)
      } finally {
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });

    it("a validated DONE record WINS over a LATER same-id cancelled/error record (no cancelled-over-complete)", async () => {
      const dir = await mkdtemp(pathJoin(tmpdir(), "djobs-persist-"));
      setProgressDir(dir);
      try {
        const sharedId = "sharedid00000001";
        const sharedTray = "sharedtray000001";
        // Session B landed + VALIDATED the file (done) — EARLIER.
        await writeForeignJobRecord(dir, {
          id: sharedId,
          trayId: sharedTray,
          progressId: "shared-prog",
          url: URL_A,
          owner: "sessionB",
          status: "done",
          path: "/M/checkpoints/m.safetensors",
          ageMs: 5000, // 5s ago
        });
        // Session A cancelled the SAME id LATER — must NOT override the validated file.
        await writeForeignJobRecord(dir, {
          id: sharedId,
          trayId: sharedTray,
          progressId: "shared-prog",
          url: URL_A,
          owner: "sessionA",
          status: "cancelled",
          ageMs: 0, // now (newer than the done)
        });

        // download_status(id) MUST report the validated DONE, not the newer cancelled.
        const got = getDownloadJob(sharedId);
        expect(got?.status).toBe("done");
        expect(got?.path).toBe("/M/checkpoints/m.safetensors");
        // The no-selector list must also surface the DONE for that (id, trayId), not the cancelled.
        const listed = listDownloadJobs().find((j) => j.id === sharedId && j.trayId === sharedTray);
        expect(listed?.status).toBe("done");
      } finally {
        setProgressDir("");
        await fsRm(dir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // describePlacement — the ONE policy every tool renders a finished job with.
  // Exactly one state licenses "success" (#369).
  // -------------------------------------------------------------------------
  describe("describePlacement (#369)", () => {
    const base = {
      id: "j",
      trayId: "t",
      url: "https://example.com/m.safetensors",
      target_subfolder: "checkpoints",
      status: "done" as const,
      path: "/m/checkpoints/m.safetensors",
      started_at: 0,
    };

    it("confirms a file the connected ComfyUI listed, when the reader re-establishes the root", () => {
      const r = describePlacement(
        { ...base, live_visible: "visible", verified_root: "C:/A/models" },
        { liveModelsDir: "C:/A/models" },
      );
      expect(r.confirmed).toBe(true);
      expect(r.wrongPlace).toBe(false);
      expect(r.warning).toBeUndefined();
    });

    it("treats an ABSENT verdict (pre-fix persisted record) as unconfirmed, never success", () => {
      const r = describePlacement(base);
      expect(r.confirmed).toBe(false);
      expect(r.wrongPlace).toBe(false);
      expect(r.warning).toMatch(/NOT been confirmed yet/);
    });

    it("treats a PENDING verdict as unconfirmed", () => {
      const r = describePlacement({ ...base, live_visible: "pending" });
      expect(r.confirmed).toBe(false);
      expect(r.warning).toMatch(/NOT been confirmed yet/);
    });

    it("flags a NOT-VISIBLE verdict as the wrong place and surfaces its note", () => {
      const r = describePlacement({
        ...base,
        live_visible: "not-visible",
        verify_note: "the running server reads elsewhere",
      });
      expect(r.confirmed).toBe(false);
      expect(r.wrongPlace).toBe(true);
      expect(r.warning).toMatch(/NOT VISIBLE/);
      expect(r.warning).toMatch(/reads elsewhere/);
    });

    it("downgrades a VISIBLE verdict made against a DIFFERENT server (codex gate r11)", () => {
      // Server A verified the file; B replaced it on the same endpoint and reads
      // another tree. A reconnect must not re-assert A's confirmation as current.
      const r = describePlacement(
        { ...base, live_visible: "visible", verified_root: "C:/A/models" },
        { liveModelsDir: "D:/B/models" },
      );
      expect(r.confirmed).toBe(false);
      expect(r.pathLabel).not.toBe("landed at");
      expect(r.warning).toMatch(/DIFFERENT install/);
    });

    it("downgrades a VISIBLE verdict that carries NO root once one is knowable (codex gate r16)", () => {
      // The verdict was made against a base-anchored destination (nothing
      // authoritative to stamp). The connected server now reports a real root — the
      // old confirmation was about a different server and cannot be re-asserted.
      const r = describePlacement(
        { ...base, live_visible: "visible" },
        { liveModelsDir: "D:/B/models" },
      );
      expect(r.confirmed).toBe(false);
      expect(r.pathLabel).not.toBe("landed at");
      expect(r.warning).toMatch(/cannot be re-asserted/);
    });

    it("keeps a VISIBLE verdict when the connected server still reads the same root", () => {
      const r = describePlacement(
        { ...base, live_visible: "visible", verified_root: "C:/A/models" },
        { liveModelsDir: "C:/A/models" },
      );
      expect(r.confirmed).toBe(true);
    });

    it("treats differently-spelled Windows roots as the SAME install (codex gate r17)", () => {
      // A false "DIFFERENT install" downgrade of a correct verdict is as harmful as
      // a missed one: Windows paths are case-insensitive and mix separators.
      const r = describePlacement(
        { ...base, live_visible: "visible", verified_root: "C:\\ComfyUI\\models" },
        { liveModelsDir: "c:/comfyui/models" },
      );
      expect(r.confirmed).toBe(process.platform === "win32");
    });

    it("does NOT re-assert a VISIBLE verdict with NO current observation (codex gate r18)", () => {
      // The probe transiently failed, so nothing verified that the server answering
      // NOW can read this file. A MISSING observation is "cannot confirm", never
      // "no contradiction" — the inversion that let a replaced server render as
      // success. Only a reader that re-establishes the verdict may confirm it.
      const r = describePlacement(
        { ...base, live_visible: "visible", verified_root: "C:/A/models" },
        {},
      );
      expect(r.confirmed).toBe(false);
      expect(r.pathLabel).not.toBe("landed at");
      expect(r.warning).toMatch(/could not be asked just now/);
    });

    it("never claims 'verified on disk' when the post-landing stat failed (codex gate r9)", () => {
      const r = describePlacement({
        ...base,
        live_visible: "unknown",
        disk_verified: false,
        verify_note: "the file could not be confirmed on disk",
      });
      expect(r.confirmed).toBe(false);
      expect(r.pathQualifier).not.toContain("verified on disk");
      expect(r.pathQualifier).toContain("NOT found on disk");
    });

    it("never confirms a Manager dispatch, even if a verdict got attached", () => {
      const r = describePlacement({ ...base, viaManager: true, live_visible: "visible" });
      expect(r.confirmed).toBe(false);
      expect(r.warning).toMatch(/NOT verified as landed/);
    });
  });
});
