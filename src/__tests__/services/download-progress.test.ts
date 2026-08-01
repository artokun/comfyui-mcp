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
