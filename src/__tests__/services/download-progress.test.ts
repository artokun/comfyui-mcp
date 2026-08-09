import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// download-progress.ts captures COMFYUI_MCP_PROGRESS_DIR at import — re-import
// per test with a fresh dir (same resetModules pattern as config tests).
const OLD_ENV = process.env;
let dir: string;
let mod: typeof import("../../services/download-progress.js");

beforeEach(async () => {
  vi.resetModules();
  process.env = { ...OLD_ENV };
  dir = mkdtempSync(join(tmpdir(), "dl-progress-test-"));
  process.env.COMFYUI_MCP_PROGRESS_DIR = dir;
  mod = await import("../../services/download-progress.js");
});

afterEach(() => {
  process.env = OLD_ENV;
  rmSync(dir, { recursive: true, force: true });
});

function pendingFiles(): string[] {
  return readdirSync(dir).filter((f) => f.startsWith(mod.CONTROL_PREFIX));
}

describe("download target stamping (#269)", () => {
  it("stamps the row with the writer's COMFYUI_URL at write time", () => {
    process.env.COMFYUI_URL = "https://podabc-3000.proxy.runpod.net";
    mod.reportDownloadProgress({ id: "a1", name: "m.safetensors", downloaded: 1, total: 2, bytes_per_sec: 1, status: "downloading" }, true);
    const row = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith("a1-"))!), "utf-8"));
    expect(row.target).toBe("https://podabc-3000.proxy.runpod.net");
    expect(row.status).toBe("downloading");
  });
});

describe("download tab stamping (#547)", () => {
  it("stamps the row with the writer's COMFYUI_MCP_TAB so the orchestrator can wake that tab's agent", () => {
    process.env.COMFYUI_MCP_TAB = "tab-abc123";
    mod.reportDownloadProgress({ id: "t1", name: "m.safetensors", downloaded: 1, total: 2, bytes_per_sec: 1, status: "done" }, true);
    const row = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith("t1-"))!), "utf-8"));
    expect(row.tab).toBe("tab-abc123");
    expect(row.status).toBe("done");
  });

  it("omits tab when no COMFYUI_MCP_TAB is set (non-panel / in-process caller)", () => {
    delete process.env.COMFYUI_MCP_TAB;
    mod.reportDownloadProgress({ id: "t2", name: "m.safetensors", downloaded: 1, total: 2, bytes_per_sec: 1, status: "done" }, true);
    const row = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith("t2-"))!), "utf-8"));
    expect(row.tab).toBeUndefined();
  });

  it("an explicit p.tab overrides the env stamp", () => {
    process.env.COMFYUI_MCP_TAB = "env-tab";
    mod.reportDownloadProgress({ id: "t3", name: "m", downloaded: 1, total: 2, bytes_per_sec: 1, status: "downloading", tab: "explicit-tab" }, true);
    const row = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith("t3-"))!), "utf-8"));
    expect(row.tab).toBe("explicit-tab");
  });
});

describe("readDownloadProgress (target-scoped read, #290)", () => {
  it("reads back a row written under a remote COMFYUI_URL (target-scoped filename)", () => {
    // The writer scopes the filename by target; readDownloadProgress must find it
    // without knowing the target (the old single-file read returned null here).
    process.env.COMFYUI_URL = "https://podabc-3000.proxy.runpod.net";
    mod.reportDownloadProgress({ id: "d1", name: "m.safetensors", downloaded: 42, total: 100, bytes_per_sec: 7, status: "downloading" }, true);
    const p = mod.readDownloadProgress("d1");
    expect(p).not.toBeNull();
    expect(p?.id).toBe("d1");
    expect(p?.downloaded).toBe(42);
  });

  it("returns the most-recently-updated variant when the same id has several targets", () => {
    writeFileSync(join(dir, "d2-local.json"), JSON.stringify({ id: "d2", name: "m", downloaded: 10, total: 100, bytes_per_sec: 1, status: "downloading", updated: 1000 }));
    writeFileSync(join(dir, "d2-pod.json"), JSON.stringify({ id: "d2", name: "m", downloaded: 55, total: 100, bytes_per_sec: 1, status: "downloading", updated: 2000 }));
    expect(mod.readDownloadProgress("d2")?.downloaded).toBe(55);
  });

  it("returns null when nothing has been written for the id", () => {
    expect(mod.readDownloadProgress("nope")).toBeNull();
  });
});

describe("control channel (#269 MCP child → orchestrator)", () => {
  it("round-trips a target request as its own file (url + watchPodId)", () => {
    expect(mod.requestTargetChange({ url: "https://podabc-3000.proxy.runpod.net", watchPodId: "podabc" })).toBeTruthy();
    expect(pendingFiles()).toHaveLength(1);
    const list = mod.listTargetChangeRequests(dir);
    expect(list).toHaveLength(1);
    expect(list[0].req.url).toBe("https://podabc-3000.proxy.runpod.net");
    expect(list[0].req.watchPodId).toBe("podabc");
    expect(typeof list[0].req.updated).toBe("number");
  });

  it("supports watch-only, unwatch, local-resolve, and connectWhenReady requests", () => {
    expect(mod.requestTargetChange({ watchPodId: "podX" })).toBeTruthy();
    expect(mod.requestTargetChange({ local: true, unwatch: true })).toBeTruthy();
    expect(mod.requestTargetChange({ watchPodId: "podC", connectWhenReady: { url: "https://podc-3000.proxy.runpod.net", podId: "podC" } })).toBeTruthy();
    const reqs = mod.listTargetChangeRequests(dir).map((p) => p.req);
    expect(reqs.some((r) => r.watchPodId === "podX" && !r.url)).toBe(true);
    expect(reqs.some((r) => r.local === true && r.unwatch === true)).toBe(true);
    expect(reqs.some((r) => r.connectWhenReady?.podId === "podC")).toBe(true);
  });

  it("consumes exactly the file read — concurrent children can't clobber (codex)", () => {
    expect(mod.requestTargetChange({ url: "http://127.0.0.1:8188" })).toBeTruthy();
    expect(mod.requestTargetChange({ url: "https://podz-3000.proxy.runpod.net" })).toBeTruthy();
    const list = mod.listTargetChangeRequests(dir);
    expect(list).toHaveLength(2);
    mod.consumeTargetChange(list[0].file); // consume ONE
    const rest = mod.listTargetChangeRequests(dir);
    expect(rest).toHaveLength(1); // the other request survives untouched
  });

  it("ignores + reaps requests older than the TTL", () => {
    expect(mod.requestTargetChange({ url: "http://127.0.0.1:8188" })).toBeTruthy();
    const [file] = pendingFiles();
    writeFileSync(join(dir, file), JSON.stringify({ url: "http://127.0.0.1:8188", updated: Date.now() - 61_000 }));
    expect(mod.listTargetChangeRequests(dir)).toHaveLength(0);
    expect(pendingFiles()).toHaveLength(0); // reaped
  });

  it("redacts userinfo from stamped/requested target URLs", () => {
    process.env.COMFYUI_URL = "https://user:secret@podabc-3000.proxy.runpod.net";
    mod.reportDownloadProgress({ id: "r1", name: "m", downloaded: 1, total: 1, bytes_per_sec: 1, status: "downloading" }, true);
    const row = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith("r1-"))!), "utf-8"));
    expect(row.target).not.toContain("secret");
    expect(mod.requestTargetChange({ url: "https://user:secret@podabc-3000.proxy.runpod.net" })).toBeTruthy();
    expect(mod.listTargetChangeRequests(dir)[0].req.url).not.toContain("secret");
  });

  it("is inactive with no progress dir (non-panel mode)", async () => {
    vi.resetModules();
    delete process.env.COMFYUI_MCP_PROGRESS_DIR;
    const bare = await import("../../services/download-progress.js");
    expect(bare.requestTargetChange({ url: "http://127.0.0.1:8188" })).toBeNull();
    expect(bare.listTargetChangeRequests(dir)).toHaveLength(0);
  });
});

describe("attempt-supersession (panel#489)", () => {
  const T = "https://host"; // shared target for same-logical-download attempts

  it("stamps the attempt epoch onto the written row", () => {
    mod.reportDownloadProgress(
      { id: "s1", name: "seedvr2_dit.safetensors", downloaded: 1, total: 2, bytes_per_sec: 1, status: "downloading", attempt: 12345 },
      true,
    );
    const row = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith("s1-"))!), "utf-8"));
    expect(row.attempt).toBe(12345);
  });

  it("drops a late FAILED terminal from a superseded attempt while the retry progresses", () => {
    // The reported case: two SeedVR2 files. An OLDER attempt (N) fails AFTER a NEWER
    // attempt (N+1) for the SAME URL-derived id + SAME target has begun and is actively
    // progressing. attempt N's terminal "error" row is a late artifact of an abandoned
    // attempt.
    const dit = "a1b2c3"; // deterministic URL-derived id (same for both attempts)
    const errorN = { id: dit, target: T, name: "seedvr2_dit.safetensors", status: "error", attempt: 1000 };
    const downloadingN1 = { id: dit, target: T, name: "seedvr2_dit.safetensors", status: "downloading", attempt: 2000 };

    const newest = mod.newestAttemptEpochs([errorN, downloadingN1]);
    // The late FAILED terminal of attempt N is SUPERSEDED → must be dropped (no event).
    expect(mod.isSupersededAttempt(errorN, newest)).toBe(true);
    // The live progressing row is the current attempt — never suppressed.
    expect(mod.isSupersededAttempt(downloadingN1, newest)).toBe(false);
  });

  it("suppresses a superseded attempt's stale DOWNLOADING row too (no duplicate tray/idle-veto row)", () => {
    // An abandoned attempt (N) that died mid-transfer left a stale "downloading" row; the
    // retry (N+1) is live. N's row must be dropped so it doesn't duplicate the tray row or
    // wrongly veto pod idle-stop next to the live retry.
    const id = "dd77ee";
    const staleN = { id, target: T, name: "m", status: "downloading", attempt: 1000 };
    const liveN1 = { id, target: T, name: "m", status: "downloading", attempt: 2000 };
    const newest = mod.newestAttemptEpochs([staleN, liveN1]);
    expect(mod.isSupersededAttempt(staleN, newest)).toBe(true);
    expect(mod.isSupersededAttempt(liveN1, newest)).toBe(false);
  });

  it("a superseding newer attempt that itself already finished still drops the older terminal", () => {
    // Newer attempt N+1 completed (done) while the older N left a stale error behind
    // (distinct per-attempt files). The newest attempt wins regardless of status.
    const id = "bb22cc";
    const errorN = { id, target: T, name: "m", status: "error", attempt: 1000 };
    const doneN1 = { id, target: T, name: "m", status: "done", attempt: 2000 };
    const newest = mod.newestAttemptEpochs([errorN, doneN1]);
    expect(mod.isSupersededAttempt(errorN, newest)).toBe(true);
    expect(mod.isSupersededAttempt(doneN1, newest)).toBe(false); // the current attempt emits
  });

  it("a genuine CURRENT failure (no newer attempt) still emits", () => {
    const id = "d4e5f6";
    const errorNow = { id, target: T, name: "seedvr2_vae.safetensors", status: "error", attempt: 5000 };
    const newest = mod.newestAttemptEpochs([errorNow]);
    expect(mod.isSupersededAttempt(errorNow, newest)).toBe(false);
  });

  it("does NOT suppress a terminal when the newer row is the SAME attempt (equal epoch)", () => {
    const id = "eeee11";
    const errorNewer = { id, target: T, name: "m", status: "error", attempt: 3000 };
    const downloadingSame = { id, target: T, name: "m", status: "downloading", attempt: 3000 };
    const newest = mod.newestAttemptEpochs([errorNewer, downloadingSame]);
    expect(mod.isSupersededAttempt(errorNewer, newest)).toBe(false);
  });

  it("scopes supersession by (id, target): a concurrent LOCAL + POD download of the same URL is independent (#269)", () => {
    // Same URL-derived id, DIFFERENT targets (local vs pod). A genuine LOCAL failure must
    // NOT be suppressed just because a POD transfer of the same URL is downloading — they
    // are independent downloads, not retries of each other. This is the P1-B regression
    // an id-only scope would have caused.
    const id = "cafe01";
    const localError = { id, target: "http://127.0.0.1:8188", name: "m", status: "error", attempt: 1000 };
    const podDownloading = { id, target: "https://pod-3000.proxy.runpod.net", name: "m", status: "downloading", attempt: 2000 };
    const newest = mod.newestAttemptEpochs([localError, podDownloading]);
    // The local failure is genuine for its own target — it still emits.
    expect(mod.isSupersededAttempt(localError, newest)).toBe(false);
  });

  it("is conservative for rows missing an attempt epoch (pre-fix writer / non-model reporter)", () => {
    const id = "legacy1";
    const errorNoEpoch = { id, target: T, name: "m", status: "error" }; // no attempt
    const downloadingNoEpoch = { id, target: T, name: "m", status: "downloading" }; // no attempt
    // A row without an epoch establishes no supersession.
    expect(mod.newestAttemptEpochs([downloadingNoEpoch]).size).toBe(0);
    // A row without an epoch is never suppressed, even against an epoched newer row.
    const newest = mod.newestAttemptEpochs([{ id, target: T, name: "m", status: "downloading", attempt: 9000 }]);
    expect(mod.isSupersededAttempt(errorNoEpoch, newest)).toBe(false);
  });

  it("per-attempt files: a retry writes its OWN file so both attempts coexist on disk", () => {
    // The id is URL-derived, so both attempts share id + target; the attempt epoch in the
    // filename keeps them in SEPARATE files — the retry can never overwrite the live row.
    process.env.COMFYUI_URL = T;
    const id = "pa0001";
    mod.reportDownloadProgress({ id, name: "m", downloaded: 5, total: 10, bytes_per_sec: 1, status: "downloading", attempt: 2000 }, true);
    mod.reportDownloadProgress({ id, name: "m", downloaded: 0, total: 0, bytes_per_sec: 0, status: "error", attempt: 1000 }, true);
    const files = readdirSync(dir).filter((f) => f.startsWith(`${id}-`));
    expect(files).toHaveLength(2); // two distinct per-attempt files, no overwrite
    // Both rows are readable; the orchestrator (not this reader) decides which wins.
    const rows = files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")));
    expect(rows.some((r) => r.status === "downloading" && r.attempt === 2000)).toBe(true);
    expect(rows.some((r) => r.status === "error" && r.attempt === 1000)).toBe(true);
  });

  it("owner-scopes the progress filename so two processes never share (and clobber) one file", () => {
    // The attempt epoch alone can tie across processes (same ms); the per-process owner
    // segment guarantees distinct files regardless, so a late terminal from one process
    // can never overwrite another process's live row.
    process.env.COMFYUI_URL = T;
    const id = "own001";
    mod.reportDownloadProgress({ id, name: "m", downloaded: 1, total: 2, bytes_per_sec: 1, status: "downloading", attempt: 1000 }, true);
    const f = readdirSync(dir).find((x) => x.startsWith(`${id}-`))!;
    expect(f).toContain(`-o${mod.PERSIST_OWNER}`);
    // A different process (different owner) writing the SAME id+target+epoch lands on a
    // DIFFERENT file — both rows survive, none is clobbered.
    writeFileSync(join(dir, `${id}-x-a1000-oOTHEROWNER.json`), JSON.stringify({ id, target: T, name: "m", status: "error", attempt: 1000, updated: 1 }));
    expect(readdirSync(dir).filter((x) => x.startsWith(`${id}-`))).toHaveLength(2);
  });

  it("mirrors the orchestrator poll: the superseded attempt's row is filtered out of the emitted rows", () => {
    // A faithful slice of pollDownloads' phased reconcile: the newer attempt's live
    // row is broadcast, the older attempt's FAILED row is dropped — so the tray/agent
    // never sees a FAILED that contradicts the active transfer.
    const id = "poll01";
    const rows = [
      { id, target: T, name: "seedvr2_dit.safetensors", status: "error", attempt: 1000, updated: 1_000 },
      { id, target: T, name: "seedvr2_dit.safetensors", status: "downloading", attempt: 2000, updated: 2_000 },
    ];
    const newest = mod.newestAttemptEpochs(rows);
    const emitted = rows.filter((r) => !mod.isSupersededAttempt(r, newest));
    expect(emitted).toHaveLength(1);
    expect(emitted[0].status).toBe("downloading");
    expect(emitted.some((r) => r.status === "error")).toBe(false);
  });
});

// #1150 — the (id, target) supersession key cannot see a corrected retry.
//
// Two 404s were re-issued with corrected URLs and the same target filenames.
// A new URL is a new id, so the eviction never fired and both filenames flushed
// as failures — while download_model action:"status" showed them streaming at
// 20% and 13%. This asks the narrower question the event text actually needs:
// is the thing I am about to call failed currently arriving?
describe("markSupersededByLive (#1150)", () => {
  const live = (name: string) => ({ name, status: "downloading" });

  it("flags a failure whose filename is downloading RIGHT NOW", () => {
    const settled = [{ name: "big.safetensors", status: "error" }];
    mod.markSupersededByLive(settled, [live("big.safetensors")]);
    expect(settled[0]).toMatchObject({ supersededByLive: true });
  });

  it("leaves a genuinely dead failure alone", () => {
    const settled = [{ name: "gone.safetensors", status: "error" }];
    mod.markSupersededByLive(settled, [live("other.safetensors")]);
    expect(settled[0].supersededByLive).toBeUndefined();
  });

  it("never flags a SUCCESS — 'done' is settled regardless of what else is live", () => {
    // A second copy of the same name streaming elsewhere does not un-complete a
    // transfer that finished.
    const settled = [{ name: "big.safetensors", status: "done" }];
    mod.markSupersededByLive(settled, [live("big.safetensors")]);
    expect(settled[0].supersededByLive).toBeUndefined();
  });

  it("ignores live rows that are not actually downloading", () => {
    const settled = [{ name: "big.safetensors", status: "error" }];
    mod.markSupersededByLive(settled, [
      { name: "big.safetensors", status: "done" },
      { name: "big.safetensors", status: "error" },
    ]);
    expect(settled[0].supersededByLive).toBeUndefined();
  });

  it("ignores nameless rows rather than matching them to each other", () => {
    const settled = [{ name: "", status: "error" }];
    mod.markSupersededByLive(settled, [{ name: undefined, status: "downloading" }]);
    expect(settled[0].supersededByLive).toBeUndefined();
  });

  it("handles the reporter's shape: two failures, both retried", () => {
    const settled = [
      { name: "MiniMax-H3_FL2VA-NVFP4-HQ.safetensors", status: "error" },
      { name: "MiniMax-H3_FL2VA-NVFP4-LQ.safetensors", status: "error" },
    ];
    mod.markSupersededByLive(settled, [
      live("MiniMax-H3_FL2VA-NVFP4-HQ.safetensors"),
      live("MiniMax-H3_FL2VA-NVFP4-LQ.safetensors"),
    ]);
    expect(settled.every((s) => s.supersededByLive === true)).toBe(true);
  });
});

// #1148 — a tracked download vanished silently across an orchestrator restart.
//
// The persisted store exists so a reconnecting session can still resolve an
// in-flight download by id (#529), and download_model's own status text promises
// exactly that. But the orchestrator nonces its progress dir per start and reaps
// every earlier dir for the port, deleting the store that promise rests on. A
// reporter's 12GB transfer answered "No download matching id" and "No downloads
// are being tracked" — no file, no partial, no error event. 40 minutes lost
// invisibly, while the documented contract told their agent to keep waiting.
//
// The transfer really is dead (it streamed inside the exited process), so this
// resurrects nothing. It replaces the SILENCE with a findable terminal record.
describe("migrateInFlightJobs (#1148)", () => {
  let oldDir: string;

  beforeEach(() => {
    oldDir = mkdtempSync(join(tmpdir(), "cm-old-"));
  });
  afterEach(() => {
    rmSync(oldDir, { recursive: true, force: true });
  });

  // Built from the module's OWN prefix, not a hard-coded "job-": the real files
  // are `control-job-…`, and a literal here would have silently written fixtures
  // the scanner ignores — a test that passes by matching nothing.
  const writeJob = (d: string, rec: Record<string, unknown>) =>
    writeFileSync(
      join(d, `${mod.CONTROL_PREFIX}job-${rec.id}-owner.json`),
      JSON.stringify(rec),
    );

  it("carries an IN-FLIGHT record forward as a findable terminal record", () => {
    writeJob(oldDir, {
      id: "53012d3181fd46b6",
      status: "downloading",
      name: "krea2_turbo_fp8.safetensors",
      received: 700000000,
      total: 12010000000,
      updated: Date.now(),
    });

    expect(mod.migrateInFlightJobs(oldDir, dir)).toBe(1);

    const found = mod.readPersistedDownloadJob("53012d3181fd46b6");
    expect(found).not.toBeNull();
    expect(found!.status).toBe("error");
    expect(found!.interrupted_by_restart).toBe(true);
    // The bytes it had, so a reader can see what was lost.
    expect(found!.received).toBe(700000000);
  });

  it("tells the caller nothing is WATCHING, without claiming the bytes stopped", () => {
    // The original harm was an agent waiting forever on the documented contract,
    // so the record must still end the wait — that half is unchanged.
    //
    // But the previous version of this test pinned "NOT running", "will not
    // resume on its own" and "Re-issue the download", and those are CLAIMS THIS
    // CODE CANNOT MAKE. The migration reads neither the `pid` nor the `owner` it
    // persists, and `writerProcessGone()` exists precisely to answer the question
    // it skips — the cancel path refuses to close a stale record until that probe
    // returns ESRCH (#761/#858). Worse, a download DISPATCHED to ComfyUI-Manager
    // runs on the ComfyUI host, which a restart here does not touch: telling that
    // caller to re-issue starts a second write to the same destination and
    // corrupts the model (#1197).
    //
    // So this test used to enforce the defect. It now pins the honest version:
    // say what we observed (we stopped watching), and do not order a re-issue.
    writeJob(oldDir, { id: "abc", status: "downloading", updated: Date.now() });
    mod.migrateInFlightJobs(oldDir, dir);
    const msg = mod.readPersistedDownloadJob("abc")!.error ?? "";
    // Still ends the wait, and still says the partial may be gone.
    expect(msg).toMatch(/no longer being WATCHED/);
    expect(msg).toMatch(/no further progress will be reported/);
    expect(msg).toMatch(/partial file may have been discarded/);
    // Says what it does NOT establish, and names the host-side case.
    expect(msg).toMatch(/does NOT establish is whether the bytes stopped/);
    expect(msg).toMatch(/ComfyUI-Manager the fetch runs on the ComfyUI host/);
    // Gives a TERMINATING check rather than an unbounded "wait for it".
    // No TIMER-based test. An in-progress model file is never listed by the
    // server (node-management.ts:4093), so "wait N minutes then decide" fires on
    // a HEALTHY multi-hour Manager transfer and sends the caller into the
    // corruption the same message warns about.
    expect(msg).not.toMatch(/couple of minutes|for a (?:few|couple)|within \d+ ?(?:min|second)/i);
    expect(msg).toMatch(/absence proves nothing and a timer is not a test/);
    // The LOCAL case keeps an affirmative next step — removing it entirely
    // recreates #1148's original harm (an agent that will not act).
    expect(msg).toMatch(/streaming locally, nothing is writing it now — re-issue/);
    // The old blanket order must not come back. Anchored to the WORD, not to a
    // whole-line match: `^…$/m` only fired if the entire error was that literal,
    // so the previous version of this assertion could never trip (review §3).
    expect(msg).not.toMatch(/will not resume on its own/);
  });

  it("does NOT migrate a TERMINAL record — its outcome was already delivered", () => {
    // Re-landing a settled record would replay an event the caller already saw.
    for (const status of ["done", "error", "cancelled"]) {
      writeJob(oldDir, { id: `t-${status}`, status, updated: Date.now() });
    }
    expect(mod.migrateInFlightJobs(oldDir, dir)).toBe(0);
  });

  it("survives an unreadable record without dropping the others", () => {
    writeFileSync(join(oldDir, `${mod.CONTROL_PREFIX}job-corrupt-owner.json`), "{not json");
    writeJob(oldDir, { id: "good", status: "downloading", updated: Date.now() });
    expect(mod.migrateInFlightJobs(oldDir, dir)).toBe(1);
    expect(mod.readPersistedDownloadJob("good")).not.toBeNull();
  });

  it("returns 0 for a directory that does not exist", () => {
    expect(mod.migrateInFlightJobs(join(oldDir, "nope"), dir)).toBe(0);
  });

  it("ignores non-job files in the old directory", () => {
    writeFileSync(join(oldDir, `${mod.CONTROL_PREFIX}something.json`), JSON.stringify({ id: "x" }));
    expect(mod.migrateInFlightJobs(oldDir, dir)).toBe(0);
  });
});
