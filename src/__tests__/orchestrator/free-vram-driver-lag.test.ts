// #2704 on the PANEL path. The same lagging driver that made clear_vram print
// a stale VRAM figure makes panel_free_vram publish a stale VERDICT: a card
// read before the driver released looks globally occupied, so the reply names
// occupied_devices and reports the pre-release byte count as the outcome of
// the free.
//
// The frozen-tab path is the one that can be fixed, because freeVramDirect
// already samples the counters BEFORE it posts /free — that pre-mutation
// sample is what turns "the number stopped moving" into "the release landed".
// The ack path has no such sample (the tab posted /free before it replied) and
// deliberately keeps the older best-effort rule.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  comfyuiFetch: vi.fn(),
}));

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: (...args: unknown[]) => mocks.comfyuiFetch(...args),
}));

const { buildPanelToolDefs, makePanelToolCtx, __panelToolsTestHooks } = await import(
  "../../orchestrator/panel-tools.js"
);
import { getBootLocalComfyUIBaseUrl } from "../../config.js";
import { markReplyTimeout } from "../../services/ui-bridge.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import type { ToolResult } from "../../orchestrator/panel-tools.js";
import { VRAM_SETTLE_INTERVAL_MS, VRAM_SETTLE_TIMEOUT_MS } from "../../services/vram-settle.js";

const TAB = "11111111-2222-3333-4444-555555555555";
const BOOT_BASE = (getBootLocalComfyUIBaseUrl() ?? "http://127.0.0.1:8188").replace(/\/+$/, "");

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

const ackTimeout = (cmd: string, ms: number): Error =>
  new Error(
    `Panel tab ${TAB} did not reply to "${cmd}" within ${ms} ms — the ComfyUI tab may be ` +
      `backgrounded or frozen. This command MUTATES and was already delivered to the tab, so it ` +
      `may have been applied despite the missing reply — check the current state before ` +
      `re-issuing it; a blind retry can apply it twice`,
  );

function bridge() {
  return {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd !== "free_vram") return { ok: true };
      throw markReplyTimeout(ackTimeout("free_vram", 15000));
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: () => true,
    workflowUuidFor: () => ({ known: false }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    tabIsLocal: () => true,
    tabServerOrigin: () => BOOT_BASE,
  };
}

const GIB = 1024 * 1024 * 1024;
const TOTAL = 12 * GIB;
/** 1.2 GB of 12 GB = 10% free: "occupied" by the same rule the panel applies. */
const STALE_FREE = Math.round(1.2 * GIB);
/** What the card really had once the driver caught up. */
const SETTLED_FREE = Math.round(10.7 * GIB);
const TORCH_TOTAL = 32 * 1024 * 1024;

function gpu(vramFree: number, torchFree: number) {
  return {
    name: "cuda:0",
    index: 0,
    vram_total: TOTAL,
    vram_free: vramFree,
    torch_vram_total: TORCH_TOTAL,
    torch_vram_free: torchFree,
  };
}

/**
 * The reported timing: torch hands its pool back almost at once, the driver
 * stays frozen at the pre-/free number until `driverReleasesAtMs`.
 *
 * The torch movement is the whole trap — it is enough to make the combined
 * counters "change then plateau", which is what certified the frozen driver
 * number as settled.
 */
function setDriverLag(driverReleasesAtMs: number): { sampledAt: number[]; freeAt: () => number } {
  let freeAt: number | null = null;
  const sampledAt: number[] = [];
  mocks.comfyuiFetch.mockImplementation(async () => {
    freeAt = Date.now();
    return { status: 200 };
  });
  __panelToolsTestHooks.setReadVramDevices(async () => {
    sampledAt.push(Date.now());
    if (freeAt == null) return [gpu(STALE_FREE, 0)];
    const since = Date.now() - freeAt;
    return [
      gpu(since >= driverReleasesAtMs ? SETTLED_FREE : STALE_FREE, since >= 400 ? TORCH_TOTAL : 0),
    ];
  });
  return { sampledAt, freeAt: () => freeAt as number };
}

/** An idle card: /free releases nothing and no counter moves, before or after. */
function setIdleCard(): { sampledAt: number[]; freeAt: () => number } {
  let freeAt: number | null = null;
  const sampledAt: number[] = [];
  mocks.comfyuiFetch.mockImplementation(async () => {
    freeAt = Date.now();
    return { status: 200 };
  });
  __panelToolsTestHooks.setReadVramDevices(async () => {
    sampledAt.push(Date.now());
    return [gpu(SETTLED_FREE, TORCH_TOTAL)];
  });
  return { sampledAt, freeAt: () => freeAt as number };
}

async function runFrozenTab(): Promise<ToolResult> {
  const ctx = makePanelToolCtx(bridge() as never, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_free_vram");
  if (!def) throw new Error("panel_free_vram is not registered");
  const pending = def.handler({} as never, ctx);
  await vi.advanceTimersByTimeAsync(VRAM_SETTLE_TIMEOUT_MS + VRAM_SETTLE_INTERVAL_MS * 2);
  return await pending;
}

beforeEach(() => {
  mocks.comfyuiFetch.mockReset();
  mocks.comfyuiFetch.mockResolvedValue({ status: 200 });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  __panelToolsTestHooks.setFreeVramDirect(null);
  __panelToolsTestHooks.setReadVramDevices(null);
});

describe("panel_free_vram against a driver that releases late (#2704)", () => {
  it("does not call the card occupied on counters the driver had not released", async () => {
    setDriverLag(8_000);

    const res = await runFrozenTab();
    const text = textOf(res);

    expect(res.isError).not.toBe(true);
    expect(text).toMatch(/"verified": "server-side"/);
    // The verdict, not just the number: a stale read names cuda:0 occupied.
    expect(text).not.toMatch(/occupied_devices/);
    const payload = JSON.parse(text) as {
      vram_after?: Array<{ vram_free?: number }>;
      vram_after_settled?: boolean;
    };
    expect(payload.vram_after?.[0]?.vram_free).toBe(SETTLED_FREE);
    // It waited and SAW the release, so it must not hedge.
    expect(payload.vram_after_settled).toBeUndefined();
  });

  it("marks the counters unconfirmed when the release never lands", async () => {
    setDriverLag(Number.MAX_SAFE_INTEGER);

    const res = await runFrozenTab();
    const text = textOf(res);
    const payload = JSON.parse(text) as {
      vram_after?: Array<{ vram_free?: number }>;
      vram_after_settled?: boolean;
    };

    // Still reported — it is the best reading available — but a card that never
    // released is not a measured post-release figure, and saying so is the
    // difference between an honest unknown and a false occupancy claim.
    expect(payload.vram_after?.[0]?.vram_free).toBe(STALE_FREE);
    expect(payload.vram_after_settled).toBe(false);
  });

  it("does not claim the counters are settled when the pre-/free read failed", async () => {
    // No baseline because the read FAILED is not the same as no baseline
    // because there was nothing to release. Only the second may be published
    // as a measured figure.
    let freeAt: number | null = null;
    mocks.comfyuiFetch.mockImplementation(async () => {
      freeAt = Date.now();
      return { status: 200 };
    });
    __panelToolsTestHooks.setReadVramDevices(async () => {
      if (freeAt == null) return null;
      return [gpu(STALE_FREE, TORCH_TOTAL)];
    });

    const res = await runFrozenTab();
    const payload = JSON.parse(textOf(res)) as { vram_after_settled?: boolean };

    expect(payload.vram_after_settled).toBe(false);
  });

  it("does not let one GPU releasing certify a second that never moved", async () => {
    // Two occupied cards. cuda:0 releases at 2s; cuda:1 stays frozen for good.
    // A release signature joined across devices changes the moment cuda:0
    // moves, so the next stable sample would report BOTH as settled — the torch
    // substitution one level up.
    let freeAt: number | null = null;
    mocks.comfyuiFetch.mockImplementation(async () => {
      freeAt = Date.now();
      return { status: 200 };
    });
    __panelToolsTestHooks.setReadVramDevices(async () => {
      const busy = { ...gpu(STALE_FREE, 0), name: "cuda:1", index: 1 };
      if (freeAt == null) return [gpu(STALE_FREE, 0), busy];
      const since = Date.now() - freeAt;
      return [gpu(since >= 2_000 ? SETTLED_FREE : STALE_FREE, since >= 400 ? TORCH_TOTAL : 0), busy];
    });

    const res = await runFrozenTab();
    const payload = JSON.parse(textOf(res)) as { vram_after_settled?: boolean };

    expect(payload.vram_after_settled).toBe(false);
  });

  it("does not read a REORDERED device list as both cards having released", async () => {
    // /system_stats does not promise a stable device order. Matching the
    // baseline positionally would compare cuda:0's value against cuda:1's,
    // find both "changed", and certify a box where nothing released at all.
    let freeAt: number | null = null;
    mocks.comfyuiFetch.mockImplementation(async () => {
      freeAt = Date.now();
      return { status: 200 };
    });
    const zero = () => gpu(STALE_FREE, 0);
    // Same occupancy, DIFFERENT byte counts, so a positional compare sees a
    // change on both entries the moment the order flips.
    const one = () => ({ ...gpu(STALE_FREE - 4096, 0), name: "cuda:1", index: 1 });
    __panelToolsTestHooks.setReadVramDevices(async () => {
      if (freeAt == null) return [zero(), one()];
      return [one(), zero()]; // reordered, but neither card moved
    });

    const res = await runFrozenTab();
    const payload = JSON.parse(textOf(res)) as { vram_after_settled?: boolean };

    expect(payload.vram_after_settled).toBe(false);
  });

  it("does not read a VANISHED device as one that released", async () => {
    // A card that drops out of the sample proves nothing about its memory.
    // Reading its absence as a release would certify a value nobody observed.
    let freeAt: number | null = null;
    mocks.comfyuiFetch.mockImplementation(async () => {
      freeAt = Date.now();
      return { status: 200 };
    });
    __panelToolsTestHooks.setReadVramDevices(async () => {
      const busy = { ...gpu(STALE_FREE, 0), name: "cuda:1", index: 1 };
      if (freeAt == null) return [gpu(STALE_FREE, 0), busy];
      // cuda:1 disappears; cuda:0 genuinely releases.
      const since = Date.now() - freeAt;
      return [gpu(since >= 2_000 ? SETTLED_FREE : STALE_FREE, since >= 400 ? TORCH_TOTAL : 0)];
    });

    const res = await runFrozenTab();
    const payload = JSON.parse(textOf(res)) as { vram_after_settled?: boolean };

    expect(payload.vram_after_settled).toBe(false);
  });

  it("does not wait for a release on a card that was already free", async () => {
    // Waiting for movement is only justified where movement is expected. An
    // idle card has nothing to release, so this must not sit out the whole cap
    // on a path that has already spent 15s waiting for the tab's ack.
    const { sampledAt, freeAt } = setIdleCard();

    const res = await runFrozenTab();

    expect(sampledAt.at(-1)! - freeAt()).toBeLessThan(VRAM_SETTLE_TIMEOUT_MS);
    const payload = JSON.parse(textOf(res)) as { vram_after_settled?: boolean };
    expect(payload.vram_after_settled).toBeUndefined();
  });
});
