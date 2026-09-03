// #2788 — `acquireFileLock` used to wait (or fast-refuse) behind a lock whose
// recorded owner was already gone, naming `panel_action:'unlock'` as the
// recovery nobody on the install path was there to run. Acquire now takes that
// lock through `reclaimAbandonedPanelLock`: proven-dead owner only, rename-aside
// + byte compare so a living replacement is not stolen, fail closed when death
// cannot be proven.
//
// The three liveness states are the whole test surface:
//   false     — no such process. Provably not our holder → take the lock.
//   "unsure"  — pid exists but the lock is old enough that the number may have
//               been recycled → keep waiting. Treating this as dead is the
//               existence-for-identity fold `pidLiveness` exists to prevent.
//   true      — a real operation may still be running → keep waiting.
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

describe("#2788 a provably dead lock owner is reclaimed so the waiter can proceed", () => {
  it("takes a stale lock whose owner is gone instead of waiting out the budget", async () => {
    writeLock(DEAD_PID, 20 * 60_000);
    const { withPanelMutationLock } = await lockModule();

    const started = Date.now();
    const result = await withPanelMutationLock(async () => "ran", {
      timeoutMs: 30_000,
    });
    const elapsed = Date.now() - started;

    expect(result).toBe("ran");
    expect(elapsed).toBeLessThan(5_000);
  });

  it("takes a FRESH lock whose owner is already gone (#1953 self-restart shape)", async () => {
    writeLock(DEAD_PID, 1_000);
    const { withPanelMutationLock } = await lockModule();
    await expect(
      withPanelMutationLock(async () => "ran", { timeoutMs: 2_500 }),
    ).resolves.toBe("ran");
  });

  it("runs the guarded operation under the lock it just took", async () => {
    writeLock(DEAD_PID, 20 * 60_000);
    const { withPanelMutationLock } = await lockModule();
    const op = vi.fn(async () => "ran");

    await expect(withPanelMutationLock(op, { timeoutMs: 5_000 })).resolves.toBe("ran");
    expect(op).toHaveBeenCalledOnce();
  });

  it("an UNSURE owner is not stolen — wait, then fail closed", async () => {
    // A pid that DOES exist (our own) on a lock old enough that recycling is a
    // plausible explanation → liveness is undetermined. Reclaiming here would
    // be the exact wrong call: the operation may genuinely be running.
    writeLock(process.pid, 20 * 60_000);
    const { withPanelMutationLock } = await lockModule();
    const { existsSync } = await import("node:fs");

    const started = Date.now();
    const err = await withPanelMutationLock(async () => "unreachable", {
      timeoutMs: 1_200,
    }).catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Timed out/i);
    expect((err as Error).message).toMatch(/unproven owner is left in place/i);
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    expect(existsSync(join(dir, "panel-op.lock"))).toBe(true);
  });

  it("a LIVE owner is not stolen — wait, then fail closed", async () => {
    writeLock(process.pid, 1_000);
    const { withPanelMutationLock } = await lockModule();
    const { existsSync } = await import("node:fs");

    const err = await withPanelMutationLock(async () => "unreachable", {
      timeoutMs: 1_200,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Timed out/i);
    expect((err as Error).message).toMatch(/living owner is never stolen/i);
    expect(existsSync(join(dir, "panel-op.lock"))).toBe(true);
  });

  it("an uninspectable lock is not stolen — a bad read is not proof of death", async () => {
    writeFileSync(join(dir, "panel-op.lock"), "not json at all");
    const { withPanelMutationLock } = await lockModule();
    const { existsSync } = await import("node:fs");

    const started = Date.now();
    const err = await withPanelMutationLock(async () => "unreachable", {
      timeoutMs: 1_200,
    }).catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Timed out/i);
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    expect(existsSync(join(dir, "panel-op.lock"))).toBe(true);
  });

});
