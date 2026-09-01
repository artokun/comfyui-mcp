// #2050 — clear_vram printed the /system_stats sample taken immediately after
// POST /free, while CUDA was still releasing. The reporter's MiniMax H3 unload
// showed `Current VRAM: 1205/24564 MB free`; a follow-up
// get_system_stats (action:"stats") had vram_free: 23985913856.
//
// These tests drive the registered `clear_vram` handler. The mock /system_stats
// answers as a lagging CUDA driver would: stale bytes until release completes,
// then the follow-up counters. The handler must print the settled reading.

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

function handler(): Handler {
  const tools = registered();
  expect(tools).toHaveLength(1);
  expect(tools[0]!.name).toBe("clear_vram");
  return tools[0]!.handler;
}

function call(args: Record<string, unknown>) {
  const [{ shape }] = registered();
  return handler()(z.object(shape).parse(args) as Record<string, unknown>);
}

const textOf = (res: Awaited<ReturnType<Handler>>) =>
  res.content.map((c) => c.text).join(" ");

/** Reporter's exact follow-up /system_stats bytes. */
const SETTLED_FREE = 23_985_913_856;
const TOTAL = 25_756_696_576;
/** The 1205 MB free that clear_vram printed immediately after /free. */
const STALE_FREE = 1205 * 1024 * 1024;
const TORCH_FREE = 40 * 1024 * 1024;
const TORCH_TOTAL = 64 * 1024 * 1024;

function gpuStats(vramFree: number): SystemStats {
  return {
    system: {
      os: "win32",
      python_version: "3.12",
      embedded_python: false,
    },
    devices: [
      {
        name: "cuda:0",
        type: "cuda",
        index: 0,
        vram_total: TOTAL,
        vram_free: vramFree,
        torch_vram_total: TORCH_TOTAL,
        torch_vram_free: TORCH_FREE,
      },
    ],
  };
}

const STALE = gpuStats(STALE_FREE);
const SETTLED = gpuStats(SETTLED_FREE);

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0);
}

const STALE_LINE = `Current VRAM: ${mb(STALE_FREE)}/${mb(TOTAL)} MB free`;
const SETTLED_LINE = `Current VRAM: ${mb(SETTLED_FREE)}/${mb(TOTAL)} MB free`;

function freeOk(): Response {
  return new Response(null, { status: 200 });
}

async function runClear(args: Record<string, unknown>) {
  const pending = call(args);
  await vi.advanceTimersByTimeAsync(
    CLEAR_VRAM_SETTLE_TIMEOUT_MS + CLEAR_VRAM_SETTLE_INTERVAL_MS,
  );
  return await pending;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-21T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("clear_vram post-unload VRAM (#2050)", () => {
  it("prints the settled follow-up VRAM, not the immediate 1205 MB sample", async () => {
    // CUDA still reports the pre-release occupancy until 600ms after /free —
    // inside the old single-read window, inside two 250ms polls, but before
    // CLEAR_VRAM_SETTLE_MIN_MS. Without the min wait, two equal stale reads
    // would print 1205 MB and return.
    const freeAt = Date.now();
    mocks.comfyApiFetch.mockResolvedValue(freeOk());
    mocks.getSystemStats.mockImplementation(async () =>
      Date.now() - freeAt < 600 ? STALE : SETTLED,
    );

    const res = await runClear({ unload_models: true, free_memory: true });

    expect(mocks.comfyApiFetch).toHaveBeenCalledWith(
      "/free",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ unload_models: true, free_memory: true }),
      }),
    );
    expect(textOf(res)).toContain("VRAM cleared successfully (models unloaded, memory freed).");
    expect(textOf(res)).not.toContain(STALE_LINE);
    expect(textOf(res)).toContain(SETTLED_LINE);
    expect(mocks.getSystemStats.mock.calls.length).toBeGreaterThan(1);
  });

  it("keeps polling while VRAM is still climbing past the min wait", async () => {
    const freeAt = Date.now();
    mocks.comfyApiFetch.mockResolvedValue(freeOk());
    mocks.getSystemStats.mockImplementation(async () => {
      const elapsed = Date.now() - freeAt;
      // Still climbing at CLEAR_VRAM_SETTLE_MIN_MS; plateaus after 1.5s.
      if (elapsed >= 1_500) return SETTLED;
      const t = elapsed / 1_500;
      return gpuStats(STALE_FREE + (SETTLED_FREE - STALE_FREE) * t);
    });

    const res = await runClear({ unload_models: true, free_memory: true });

    expect(textOf(res)).not.toContain(STALE_LINE);
    expect(textOf(res)).toContain(SETTLED_LINE);
  });

  it("still reports an already-stable reading after the min wait", async () => {
    const sampledAt: number[] = [];
    mocks.comfyApiFetch.mockResolvedValue(freeOk());
    mocks.getSystemStats.mockImplementation(async () => {
      sampledAt.push(Date.now());
      return SETTLED;
    });

    const res = await runClear({ unload_models: true, free_memory: true });

    expect(textOf(res)).toContain(SETTLED_LINE);
    expect(sampledAt.length).toBeGreaterThan(1);
    expect(sampledAt.at(-1)! - sampledAt[0]!).toBeGreaterThanOrEqual(CLEAR_VRAM_SETTLE_MIN_MS);
  });

  it("does not poll /system_stats when /free fails", async () => {
    mocks.comfyApiFetch.mockResolvedValue(
      new Response("OOM in unload", { status: 500, statusText: "Internal Server Error" }),
    );

    const res = await runClear({ unload_models: true, free_memory: true });

    // #2704 added ONE read before POST /free — the settle baseline, which must
    // be sampled before the mutation to be worth anything. The polling this
    // guards against is the settle LOOP, so the count is pinned exactly rather
    // than loosened to "some": a loop leaking in behind a failed /free would
    // run many more than one.
    expect(mocks.getSystemStats).toHaveBeenCalledTimes(1);
    expect(textOf(res)).toMatch(/Failed to free VRAM/);
    expect(textOf(res)).not.toContain("Current VRAM:");
  });

  it("still reports success when /system_stats never answers", async () => {
    mocks.comfyApiFetch.mockResolvedValue(freeOk());
    mocks.getSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await runClear({ unload_models: true, free_memory: true });

    expect(textOf(res)).toContain("VRAM cleared successfully (models unloaded, memory freed).");
    expect(textOf(res)).not.toContain("Current VRAM:");
  });

  it("omits a stale first sample when a later stats read fails", async () => {
    mocks.comfyApiFetch.mockResolvedValue(freeOk());
    mocks.getSystemStats
      .mockResolvedValueOnce(STALE)
      .mockRejectedValue(new Error("ETIMEDOUT"));

    const res = await runClear({ unload_models: true, free_memory: true });

    expect(textOf(res)).toContain("VRAM cleared successfully (models unloaded, memory freed).");
    expect(textOf(res)).not.toContain("Current VRAM:");
    expect(textOf(res)).not.toContain(STALE_LINE);
  });
});
