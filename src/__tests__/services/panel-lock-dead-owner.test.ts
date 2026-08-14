// #1489 (lock half) — `acquireFileLock` polled until the 60 s deadline and only
// THEN called `observePanelLock` to say what had blocked it. A lock left by an
// orchestrator that died an hour ago therefore cost a full minute to report
// something that was provable on the first tick.
//
// The narrowing is LATENCY ONLY: same refusal, same remedy, raised as soon as
// the owner is provably gone. It must NOT become an auto-reclaim — #779 made
// stale-lock recovery fail closed on purpose, because a concurrent pre-upgrade
// orchestrator can replace an observed stale path with a fresh lock.
//
// The three liveness states are the whole test surface, and only ONE of them may
// short-circuit:
//   false     — no such process. Provably not our holder → fail fast.
//   "unsure"  — pid exists but the lock is old enough that the number may have
//               been recycled → keep waiting. Treating this as dead is the
//               existence-for-identity fold `pidLiveness` exists to prevent.
//   true      — a real operation may still be running → keep waiting.
//
// NOTE ON ASSERTIONS: the fast path is identified by "Not waiting out the
// remaining timeout", NOT by "is no longer running". The ORDINARY timeout
// message contains that phrase too (describeObservedLock composes it), so
// keying on it cannot tell the two paths apart in EITHER direction — every
// assertion in this file was written that way at first, which made the
// positives weak and one negative outright wrong.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

/**
 * A lock file owned by `pid`, made to look `ageMs` old.
 *
 * The age that decides anything is the file's MTIME, not the `startedAt` in the
 * payload — `observePanelLock` reads `statSync(path).mtimeMs`. A first version of
 * this helper only wrote an old-looking timestamp into the JSON, so every lock
 * read as brand new, the stale gate never opened, and three tests sat through
 * the full 30 s budget instead of failing loudly.
 */
function writeLock(pid: number, ageMs: number): void {
  const path = join(dir, "panel-op.lock");
  writeFileSync(
    path,
    JSON.stringify({
      pid,
      startedAt: new Date(Date.now() - ageMs).toISOString(),
      token: "test-token",
    }),
  );
  const when = (Date.now() - ageMs) / 1000;
  utimesSync(path, when, when);
}

/** A pid that cannot exist, so `process.kill(pid, 0)` proves absence. */
const DEAD_PID = 0x7ffffffe;

beforeEach(() => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), "cmcp-locktest-"));
  process.env.COMFYUI_MCP_PANEL_LOCK = join(dir, "panel-op.lock");
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_PANEL_LOCK;
  rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

async function lockModule() {
  return await import("../../services/panel-pin-guard.js");
}

describe("#1489 a provably dead lock owner is reported at once", () => {
  it("fails in well under the acquire budget instead of waiting it out", async () => {
    // Ten minutes old and owned by a pid that does not exist.
    writeLock(DEAD_PID, 20 * 60_000); // comfortably past STALE_LOCK_MS
    const { withPanelMutationLock } = await lockModule();

    const started = Date.now();
    // A 30 s budget: before the fix this call could only settle at 30 s.
    const err = await withPanelMutationLock(async () => "unreachable", {
      timeoutMs: 30_000,
    }).catch((e: Error) => e);
    const elapsed = Date.now() - started;

    expect((err as Error).message).toMatch(/Not waiting out the remaining timeout/i);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("still refuses to delete it — the remedy is the unlock tool, not us", async () => {
    // The #779 invariant. Failing FAST must not become failing DESTRUCTIVELY.
    writeLock(DEAD_PID, 20 * 60_000); // comfortably past STALE_LOCK_MS
    const { withPanelMutationLock } = await lockModule();
    const { existsSync } = await import("node:fs");

    const err = await withPanelMutationLock(async () => "unreachable", {
      timeoutMs: 30_000,
    }).catch((e: Error) => e);

    expect((err as Error).message).toMatch(/panel_action:'unlock'/);
    expect(existsSync(join(dir, "panel-op.lock"))).toBe(true);
  });

  it("does NOT run the operation it was guarding", async () => {
    // Failing fast must not be mistaken for proceeding without the lock, which
    // is how a pinned user gets their panel moved.
    writeLock(DEAD_PID, 20 * 60_000); // comfortably past STALE_LOCK_MS
    const { withPanelMutationLock } = await lockModule();
    const op = vi.fn(async () => "ran");

    await withPanelMutationLock(op, { timeoutMs: 30_000 }).catch(() => {});

    expect(op).not.toHaveBeenCalled();
  });

  it("an UNSURE owner keeps waiting and times out normally", async () => {
    // A pid that DOES exist (our own) on a lock old enough that recycling is a
    // plausible explanation → liveness is undetermined. Fast-failing here would
    // be the exact wrong call: the operation may genuinely be running.
    writeLock(process.pid, 20 * 60_000);
    const { withPanelMutationLock } = await lockModule();

    const started = Date.now();
    const err = await withPanelMutationLock(async () => "unreachable", {
      timeoutMs: 1_200,
    }).catch((e: Error) => e);
    const elapsed = Date.now() - started;

    expect((err as Error).message).toMatch(/Timed out/i);
    expect((err as Error).message).not.toMatch(/Not waiting out the remaining timeout/i);
    // It waited the budget rather than short-circuiting.
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
  });

  it("a LIVE owner keeps waiting and times out normally", async () => {
    // Our own pid on a young lock: a real operation could be in flight.
    writeLock(process.pid, 1_000);
    const { withPanelMutationLock } = await lockModule();

    const err = await withPanelMutationLock(async () => "unreachable", {
      timeoutMs: 1_200,
    }).catch((e: Error) => e);

    expect((err as Error).message).toMatch(/Timed out/i);
    expect((err as Error).message).not.toMatch(/Not waiting out the remaining timeout/i);
  });

  it("an uninspectable lock keeps waiting — a bad read is not proof of death", async () => {
    // Garbage where the record should be: `observePanelLock` cannot establish an
    // owner, so nothing is proven and the careful path must still be taken.
    writeFileSync(join(dir, "panel-op.lock"), "not json at all");
    const { withPanelMutationLock } = await lockModule();

    const started = Date.now();
    const err = await withPanelMutationLock(async () => "unreachable", {
      timeoutMs: 1_200,
    }).catch((e: Error) => e);
    const elapsed = Date.now() - started;

    // Asserting only the ABSENCE of a phrase would pass on any early unrelated
    // error, proving nothing about waiting (review finding). Assert the positive
    // outcome and the elapsed time.
    expect((err as Error).message).toMatch(/Timed out/i);
    expect((err as Error).message).not.toMatch(/Not waiting out the remaining timeout/i);
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
  });

  it("a FRESH lock with a dead owner is NOT fast-failed, however long we wait", async () => {
    // The age gate. `reclaimAbandonedPanelLock` refuses on AGE before it ever
    // consults a pid, and this module must not hold a second opinion about what
    // freshness means. The budget is long enough for several probes, so a
    // missing age gate would fire here rather than hide behind a short timeout —
    // which is exactly how mutation M3 slipped through a first version of these
    // tests once the two-observation rule slowed the fast path down.
    writeLock(DEAD_PID, 60_000); // a minute old: dead owner, but FRESH
    const { withPanelMutationLock } = await lockModule();

    const err = await withPanelMutationLock(async () => "unreachable", {
      timeoutMs: 2_500,
    }).catch((e: Error) => e);

    expect((err as Error).message).toMatch(/Timed out/i);
    expect((err as Error).message).not.toMatch(/Not waiting out the remaining timeout/i);
  });

  it("a DIFFERENT dead lock at the same path restarts the two-observation count", async () => {
    // Identity, not merely "something dead is there". If the fingerprint ignored
    // pid/startedAt, probe 2 would confirm the FIRST lock's observation against
    // a second, unrelated one and fast-fail a full interval early.
    //
    // Correct: probe1 sees A, probe2 sees B (candidate resets), probe3 confirms
    // B — so the refusal lands near 2 s, not 1 s. The elapsed bound is what
    // separates the two behaviours.
    writeLock(DEAD_PID, 20 * 60_000);
    const { withPanelMutationLock } = await lockModule();
    const swap = setTimeout(() => writeLock(DEAD_PID - 1, 20 * 60_000), 400);

    const started = Date.now();
    const err = await withPanelMutationLock(async () => "unreachable", {
      timeoutMs: 8_000,
    }).catch((e: Error) => e);
    const elapsed = Date.now() - started;
    clearTimeout(swap);

    expect((err as Error).message).toMatch(/Not waiting out the remaining timeout/i);
    expect(elapsed).toBeGreaterThanOrEqual(1_800);
  });

  it("a replacement reusing pid AND startedAt is still caught by the token", async () => {
    // pid+startedAt is attribution, not identity — the record carries a `token`
    // precisely because two locks from the same process can share both. A
    // replacement that reuses them would collide on a fingerprint built from
    // pid@startedAt alone and be confirmed as the earlier dead lock (review
    // finding). Same elapsed-time discriminator as the sibling test: correct
    // behaviour needs a fresh pair of matching probes after the swap.
    const frozenAge = 20 * 60_000;
    const stamp = new Date(Date.now() - frozenAge).toISOString();
    const writeWithToken = (token: string) => {
      const p = join(dir, "panel-op.lock");
      writeFileSync(p, JSON.stringify({ pid: DEAD_PID, startedAt: stamp, token }));
      const when = (Date.now() - frozenAge) / 1000;
      utimesSync(p, when, when);
    };
    writeWithToken("token-A");
    const { withPanelMutationLock } = await lockModule();
    const swap = setTimeout(() => writeWithToken("token-B"), 400);

    const started = Date.now();
    const err = await withPanelMutationLock(async () => "unreachable", {
      timeoutMs: 8_000,
    }).catch((e: Error) => e);
    const elapsed = Date.now() - started;
    clearTimeout(swap);

    expect((err as Error).message).toMatch(/Not waiting out the remaining timeout/i);
    expect(elapsed).toBeGreaterThanOrEqual(1_800);
  });

  it("a lock REPLACED between probes resets the candidate and is not fast-failed", async () => {
    // The TOCTOU the two-observation rule exists for: a dead+stale lock is seen,
    // then a different holder takes the path before the next probe. Refusing on
    // the stale reading would reject a legitimate current holder while claiming
    // its owner is dead.
    writeLock(DEAD_PID, 20 * 60_000);
    const { withPanelMutationLock } = await lockModule();

    // Swap in a LIVE, fresh lock BETWEEN the two probes. The first fires
    // immediately and the second one probe-interval (1 s) later, so the swap has
    // to land inside that window — at 1_200 ms it arrived after the fast path
    // had already confirmed and thrown at ~1 s.
    const swap = setTimeout(() => writeLock(process.pid, 1_000), 400);

    const err = await withPanelMutationLock(async () => "unreachable", {
      timeoutMs: 3_000,
    }).catch((e: Error) => e);
    clearTimeout(swap);

    expect((err as Error).message).toMatch(/Timed out/i);
    expect((err as Error).message).not.toMatch(/Not waiting out the remaining timeout/i);
  });
});
