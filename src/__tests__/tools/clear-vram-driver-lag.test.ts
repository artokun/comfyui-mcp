// #2704 — clear_vram printed `Current VRAM: 2805/32607 MB free` on an RTX 5090
// (cudaMallocAsync) right after unloading ~29 GB, while a get_system_stats
// moments later read 32268615680 (~30 GB) from the SAME endpoint. A Qwen Image
// Edit generation needing ~19 GB then ran fine, so ~30 GB really was free.
//
// The report blamed the 5s settle cap and prescribed raising it to 12s. Driving
// the real loop shows that is inert: the cap is never reached. The torch pool
// releases in ~400ms while the DRIVER counter stays frozen at its pre-/free
// value, and that torch movement satisfied the loop's change-then-plateau test,
// so it returned the frozen driver number after ~780ms. Stillness cannot tell a
// plateau from a release that has not begun — only a pre-/free BASELINE can,
// and only if it ignores the torch pool.
//
// These tests drive the registered `clear_vram` handler against that timing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  comfyApiFetch: vi.fn(),
  getSystemStats: vi.fn(),
}));

vi.mock("../../comfyui/client.js", () => ({
  comfyApiFetch: (...args: unknown[]) => mocks.comfyApiFetch(...args),
  getSystemStats: (...args: unknown[]) => mocks.getSystemStats(...args),
}));

import {
  CLEAR_VRAM_SETTLE_INTERVAL_MS,
  CLEAR_VRAM_SETTLE_MIN_MS,
  CLEAR_VRAM_SETTLE_TIMEOUT_MS,
  registerMemoryManagementTools,
} from "../../tools/memory-management.js";
import type { SystemStats } from "../../comfyui/types.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

interface Registered {
  name: string;
  shape: z.ZodRawShape;
  handler: Handler;
}

function registered(): Registered[] {
  const tools: Registered[] = [];
  const server = {
    tool: (name: string, _desc: string, shape: z.ZodRawShape, handler: Handler) => {
      tools.push({ name, shape, handler });
    },
  };
  registerMemoryManagementTools(server as never);
  return tools;
}

function call(args: Record<string, unknown>) {
  const tools = registered();
  const [{ shape, handler }] = tools;
  return handler(z.object(shape).parse(args) as Record<string, unknown>);
}

const textOf = (res: Awaited<ReturnType<Handler>>) =>
  res.content.map((c) => c.text).join(" ");

// The reporter's exact bytes.
const TOTAL = 34_190_458_880;
/** ~2805 MB — what CUDA still reported while the driver had not released. */
const STALE_FREE = 2805 * 1024 * 1024;
/** ~30 GB — the follow-up get_system_stats (action:"stats") reading. */
const TRUE_FREE = 32_268_615_680;
const TORCH_TOTAL = 100_663_296;
/** Torch pool while the models were loaded... */
const TORCH_BUSY = 8_388_608;
/** ...and after torch hands it back, ~400ms in. Reported as `Torch: 78/96 MB`. */
const TORCH_FREE_AFTER = 82_575_360;

function gpuStats(vramFree: number, torchFree: number): SystemStats {
  return {
    system: { os: "win32", python_version: "3.12", embedded_python: false },
    devices: [
      {
        name: "cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync",
        type: "cuda",
        index: 0,
        vram_total: TOTAL,
        vram_free: vramFree,
        torch_vram_total: TORCH_TOTAL,
        torch_vram_free: torchFree,
      },
    ],
  };
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0);
}

const STALE_LINE = `Current VRAM: ${mb(STALE_FREE)}/${mb(TOTAL)} MB free`;
const TRUE_LINE = `Current VRAM: ${mb(TRUE_FREE)}/${mb(TOTAL)} MB free`;
const UNSETTLED_CAVEAT = "had not finished releasing";

function freeOk(): Response {
  return new Response(null, { status: 200 });
}

/**
 * Drive one clear_vram to completion. The mock answers as the reported card
 * did: the torch pool is handed back at 400ms, while the DRIVER counter stays
 * frozen at its pre-/free value until `driverReleasesAtMs`.
 *
 * Returns the sample times so a test can assert WHEN the loop gave up, not just
 * what it printed.
 */
async function runClear(opts: {
  driverReleasesAtMs: number;
  baselineFree?: number;
  /**
   * An idle card: nothing was loaded, so /free releases nothing and NO counter
   * moves — before or after. Keeping the counters genuinely static is what
   * makes this a control: a fixture whose driver value differs across /free
   * would satisfy the movement test by accident and could not detect the
   * occupancy gate being removed.
   */
  idle?: boolean;
}) {
  const sampledAt: number[] = [];
  let freeAt: number | null = null;
  mocks.comfyApiFetch.mockImplementation(async () => {
    freeAt = Date.now();
    return freeOk();
  });
  mocks.getSystemStats.mockImplementation(async () => {
    const now = Date.now();
    sampledAt.push(now);
    const baselineFree = opts.baselineFree ?? STALE_FREE;
    if (opts.idle) return gpuStats(baselineFree, TORCH_FREE_AFTER);
    // Before POST /free: the loaded card, torch pool occupied.
    if (freeAt == null) return gpuStats(baselineFree, TORCH_BUSY);
    const since = now - freeAt;
    return gpuStats(
      since >= opts.driverReleasesAtMs ? TRUE_FREE : STALE_FREE,
      since >= 400 ? TORCH_FREE_AFTER : TORCH_BUSY,
    );
  });

  const pending = call({ unload_models: true, free_memory: true });
  await vi.advanceTimersByTimeAsync(
    CLEAR_VRAM_SETTLE_TIMEOUT_MS + CLEAR_VRAM_SETTLE_INTERVAL_MS * 2,
  );
  return { res: await pending, sampledAt, freeAt: () => freeAt };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("clear_vram against a driver that releases late (#2704)", () => {
  it("waits out an 8s driver release instead of printing the frozen 2805 MB", async () => {
    // The whole report in one case. Before the fix the loop returned at ~780ms
    // with STALE_FREE, because the torch pool moving at 400ms counted as "the
    // release happened" and the next equal pair looked like a plateau.
    const { res, sampledAt, freeAt } = await runClear({ driverReleasesAtMs: 8_000 });

    expect(textOf(res)).toContain("VRAM cleared successfully");
    expect(textOf(res)).toContain(TRUE_LINE);
    expect(textOf(res)).not.toContain(STALE_LINE);
    // ...and it is reported as a measured figure, with no hedge attached.
    expect(textOf(res)).not.toContain(UNSETTLED_CAVEAT);
    // It really did keep polling past the release, rather than getting the
    // right answer by luck on a single late read.
    expect(sampledAt.at(-1)! - freeAt()!).toBeGreaterThanOrEqual(8_000);
  });

  it("samples the baseline BEFORE /free, since a later one is already stale", async () => {
    // A baseline taken after /free is the frozen value itself, so it could
    // never show the release land. Order is the whole point of the fix.
    const order: string[] = [];
    mocks.comfyApiFetch.mockImplementation(async () => {
      order.push("free");
      return freeOk();
    });
    mocks.getSystemStats.mockImplementation(async () => {
      order.push("stats");
      return gpuStats(STALE_FREE, TORCH_BUSY);
    });

    const pending = call({ unload_models: true, free_memory: true });
    await vi.advanceTimersByTimeAsync(CLEAR_VRAM_SETTLE_TIMEOUT_MS + CLEAR_VRAM_SETTLE_INTERVAL_MS);
    await pending;

    expect(order[0]).toBe("stats");
    expect(order[1]).toBe("free");
  });

  it("prints the reading but says so when the release never lands inside the cap", async () => {
    // Never releasing is indistinguishable from releasing at cap+1ms, so the
    // number is still the best available — it just must not be presented as a
    // measured post-release figure. Torch DOES move here, so this also pins
    // that torch movement alone never counts as the driver releasing.
    const { res } = await runClear({ driverReleasesAtMs: Number.MAX_SAFE_INTEGER });

    expect(textOf(res)).toContain("VRAM cleared successfully");
    expect(textOf(res)).toContain(STALE_LINE);
    expect(textOf(res)).toContain(UNSETTLED_CAVEAT);
  });

  it("does not spend the cap on a card that was already mostly free", async () => {
    // The cost of waiting for movement is paid only where movement is expected.
    // An idle card has nothing to release, so clear_vram must stay as fast as
    // it was before #2704 rather than blocking for the full 12s.
    const { res, sampledAt, freeAt } = await runClear({
      driverReleasesAtMs: Number.MAX_SAFE_INTEGER,
      baselineFree: TRUE_FREE, // ~94% free: not occupied
      idle: true,
    });

    const waited = sampledAt.at(-1)! - freeAt()!;
    expect(waited).toBeLessThan(CLEAR_VRAM_SETTLE_MIN_MS + CLEAR_VRAM_SETTLE_INTERVAL_MS * 3);
    expect(waited).toBeLessThan(CLEAR_VRAM_SETTLE_TIMEOUT_MS);
    expect(textOf(res)).toContain(TRUE_LINE);
    // Nothing was in doubt here, so nothing should be hedged.
    expect(textOf(res)).not.toContain(UNSETTLED_CAVEAT);
  });

  it("does not claim a reading is settled when the baseline could not be read", async () => {
    // An unreadable baseline and an idle card both arrive at the settle loop
    // with nothing to check. Collapsing them would publish an unprovable
    // reading as a measured one — the exact failure this change exists to stop.
    let freeAt: number | null = null;
    mocks.comfyApiFetch.mockImplementation(async () => {
      freeAt = Date.now();
      return freeOk();
    });
    mocks.getSystemStats.mockImplementation(async () => {
      // The pre-/free read fails; every read after /free succeeds and sits
      // frozen on the pre-release value.
      if (freeAt == null) throw new Error("ECONNRESET");
      return gpuStats(STALE_FREE, TORCH_FREE_AFTER);
    });

    const pending = call({ unload_models: true, free_memory: true });
    await vi.advanceTimersByTimeAsync(
      CLEAR_VRAM_SETTLE_TIMEOUT_MS + CLEAR_VRAM_SETTLE_INTERVAL_MS * 2,
    );
    const res = await pending;

    expect(textOf(res)).toContain(STALE_LINE);
    expect(textOf(res)).toContain(UNSETTLED_CAVEAT);
  });

  it("does not wait for a release nobody asked for", async () => {
    // /free with both flags off releases nothing. Arming the wait purely on
    // baseline occupancy would sit out the full cap on a busy card and then
    // warn that it "had not finished releasing" — for an operation that was
    // never going to move the number.
    const sampledAt: number[] = [];
    let freeAt: number | null = null;
    mocks.comfyApiFetch.mockImplementation(async () => {
      freeAt = Date.now();
      return freeOk();
    });
    mocks.getSystemStats.mockImplementation(async () => {
      sampledAt.push(Date.now());
      return gpuStats(STALE_FREE, TORCH_BUSY); // occupied and perfectly static
    });

    const pending = call({ unload_models: false, free_memory: false });
    await vi.advanceTimersByTimeAsync(
      CLEAR_VRAM_SETTLE_TIMEOUT_MS + CLEAR_VRAM_SETTLE_INTERVAL_MS * 2,
    );
    const res = await pending;

    expect(sampledAt.at(-1)! - freeAt!).toBeLessThan(CLEAR_VRAM_SETTLE_TIMEOUT_MS);
    expect(textOf(res)).toContain(STALE_LINE);
    expect(textOf(res)).not.toContain(UNSETTLED_CAVEAT);
  });

  it("does not arm the wait on a device that reports no usable VRAM total", async () => {
    // `free / total` says nothing when total is 0 or tiny, and an occupancy
    // rule that reads such a device as "occupied" would block every clear_vram
    // for the full cap on hardware it cannot measure at all.
    const sampledAt: number[] = [];
    let freeAt: number | null = null;
    mocks.comfyApiFetch.mockImplementation(async () => {
      freeAt = Date.now();
      return freeOk();
    });
    mocks.getSystemStats.mockImplementation(async () => {
      sampledAt.push(Date.now());
      return {
        system: { os: "win32", python_version: "3.12", embedded_python: false },
        devices: [
          {
            name: "cpu",
            type: "cpu",
            index: 0,
            vram_total: 0,
            vram_free: 0,
            torch_vram_total: 0,
            torch_vram_free: 0,
          },
        ],
      } satisfies SystemStats;
    });

    const pending = call({ unload_models: true, free_memory: true });
    await vi.advanceTimersByTimeAsync(
      CLEAR_VRAM_SETTLE_TIMEOUT_MS + CLEAR_VRAM_SETTLE_INTERVAL_MS * 2,
    );
    await pending;

    expect(sampledAt.at(-1)! - freeAt!).toBeLessThan(CLEAR_VRAM_SETTLE_TIMEOUT_MS);
  });
});
