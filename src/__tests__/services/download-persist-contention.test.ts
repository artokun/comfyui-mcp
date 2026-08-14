// #1545 — "Download completion event can arrive before status changes from
// downloading to done."
//
// The completion event is raised from the ORCHESTRATOR's in-memory job, while
// `download_model action:"status"` reads the persisted record (from the spawned
// stdio child). Two things let those disagree for seconds:
//
//   1. `commitDone` called `persistJobRecord(job)` and DISCARDED the result.
//      That function returns false when its atomic replace loses to a reader
//      holding the record open — and it then keeps the PRIOR complete record
//      rather than risk a torn write, so the durable answer stays "downloading".
//   2. The replace "retried a few times" with NO delay between attempts, so all
//      five completed within microseconds and lost to the same reader open.
//      Effectively one attempt.
//
// The reporter's own polling is what created the contention: `status` opens the
// exact file the writer is replacing, so the tool the completion event tells you
// to call is the one that can keep the answer stale.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

/** Attempt timestamps recorded by the renameSync stub. */
let renameAttempts: number[] = [];
/** How many attempts should fail before one succeeds. */
let failFirstN = 0;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      // performance.now(), not Date.now(): the latter quantises to ~15ms on
      // Windows, so every measured gap read as 0 or 15 regardless of the actual
      // backoff — which let a flat-2ms schedule pass a >=15ms assertion.
      renameAttempts.push(performance.now());
      if (renameAttempts.length <= failFirstN) {
        const err = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err; // the Windows sharing-violation shape
      }
      return actual.renameSync(from, to);
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  renameAttempts = [];
  failFirstN = 0;
  dir = mkdtempSync(join(tmpdir(), "dlpersist-"));
  process.env.COMFYUI_MCP_DATA_DIR = dir;
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

const JOB = {
  id: "ea552f6476f1c9ba",
  url: "https://example.invalid/model.safetensors",
  filename: "krea2TurboOfficialComfy.safetensors",
  status: "done" as const,
  started_at: 1,
  finished_at: 2,
};

async function persist(job: Record<string, unknown>) {
  const mod = await import("../../services/download-progress.js");
  return mod.persistDownloadJob(job as never);
}

describe("#1545 the terminal record survives a reader holding it open", () => {
  it("reports FAILURE rather than silently keeping the stale record", async () => {
    failFirstN = 99; // every attempt loses
    expect(await persist(JOB)).toBe(false);
    // And it left no torn/partial file behind for a reader to pick up.
    const stray = readdirSync(dir === "" ? "." : dir, { recursive: true } as never) as string[];
    expect(stray.some((f) => String(f).endsWith(".tmp"))).toBe(false);
  });

  it("SUCCEEDS when the contention clears after a few attempts", async () => {
    failFirstN = 3; // the 4th lands
    expect(await persist(JOB)).toBe(true);
    expect(renameAttempts.length).toBe(4);
  });

  it("SPREADS the retries out — five instant attempts are one attempt", async () => {
    // The defect: the loop had no delay, so all five collided with the same
    // reader open. Without a real gap between attempts the retries buy nothing,
    // and this is the only assertion that can tell the two apart.
    failFirstN = 4; // the 5th lands, so all four backoffs are exercised
    expect(await persist(JOB)).toBe(true);
    expect(renameAttempts.length).toBe(5);

    // Measured between ATTEMPTS rather than around the whole call: total elapsed
    // is dominated by module load and fs work, so an "elapsed >= 25ms" bound
    // passed even with no backoff at all — it was measuring the harness.
    const gaps = renameAttempts.slice(1).map((t, i) => t - renameAttempts[i]);
    expect(gaps.length).toBe(4);

    // TOTAL backoff, and only a "a delay exists" bound — which is all that can
    // honestly be asserted here. MEASURED on Windows: the timer granularity
    // floors every sleep at ~15ms, so [2,5,10,20] totals ~73ms and a flat
    // [2,2,2,2] totals ~62ms. Per-gap thresholds cannot separate those, and an
    // earlier version of this test claimed they could. What the fix actually
    // buys is that the attempts are SPREAD rather than simultaneous.
    //
    // The floor is 25ms, NOT 40: the configured sleeps total 37ms, and on a
    // high-resolution host (Linux CI) Atomics.wait lands near that — so a 40ms
    // floor would have failed a CORRECT implementation (review finding). My
    // ~73ms measurement was Windows granularity, not the schedule.
    const totalBackoff = gaps.reduce((a, b) => a + b, 0);
    expect(totalBackoff).toBeGreaterThanOrEqual(25);

    // CORROBORATION, not proof. Wall-clock cannot be a reliable discriminator in
    // either direction here: too high a floor fails a correct implementation on a
    // fast host, and any floor can be met by host/event-loop jitter with no
    // backoff at all (review, round 2). So the structural fact is asserted too —
    // deterministic, and immune to a loaded CI box.
    const src = readFileSync(
      new URL("../../services/download-progress.ts", import.meta.url),
      "utf8",
    );
    const loop = src.slice(
      src.indexOf("let renamed = false;"),
      src.indexOf("if (!renamed) {"),
    );
    expect(loop).toMatch(/sleepSyncMs\(RENAME_BACKOFF_MS\[attempt - 1\]/);
    expect(loop).toMatch(/if \(attempt > 0\)/); // never before the first attempt
  });

  it("does not retry at all when the first attempt lands", async () => {
    // The cost falls only on actual contention. Asserting elapsed TIME here was
    // useless — a 2ms first-attempt sleep is inside any tolerance a non-flaky
    // bound can have (mutation M2), and 2ms on a completed download is not a
    // defect worth a test. The attempt COUNT is the real invariant.
    expect(await persist(JOB)).toBe(true);
    expect(renameAttempts.length).toBe(1);
  });

  it("commitDone CHECKS the persist result — the primary fix, and nothing else here sees it", async () => {
    // Review finding: every other test in this file calls persistDownloadJob
    // directly, so removing commitDone's check and its warning left them all
    // green. commitDone is a closure inside downloadModelJob and cannot be
    // driven without a whole download, so the honest instrument is the source —
    // bounded to the function, and asserting the PROPERTY (the result is
    // consumed) rather than an exact spelling.
    const src = readFileSync(
      new URL("../../services/download-jobs.ts", import.meta.url),
      "utf8",
    );
    const start = src.indexOf("const commitDone = (");
    expect(start).toBeGreaterThan(0);
    const open = src.indexOf("{", src.indexOf("=>", start));
    let depth = 0;
    let end = open;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    const body = src.slice(open, end);

    // The bare, result-discarding call is exactly the defect.
    expect(body).not.toMatch(/^\s*persistJobRecord\(job\);\s*$/m);
    // The result must be consumed in a condition...
    expect(body).toMatch(/if \(!persistJobRecord\(job\)[\s\S]{0,80}\)/);
    // ...and the failure must say something, or it is silent again.
    expect(body).toMatch(/logger\.warn\(/);
  });

  it("a published record reads back as the terminal state", async () => {
    expect(await persist(JOB)).toBe(true);
    // Located rather than assumed: the records directory is resolved by the
    // module (channel dir, else the stable dir), and hard-coding a layout here
    // tested my guess about the path instead of the write.
    const all = readdirSync(dir, { recursive: true, encoding: "utf8" }) as unknown as string[];
    const records = all.filter((f) => String(f).endsWith(".json"));
    expect(records.length).toBe(1);
    const rec = JSON.parse(readFileSync(join(dir, records[0]), "utf8"));
    expect(rec.status).toBe("done");
    expect(rec.id).toBe(JOB.id);
  });
});
