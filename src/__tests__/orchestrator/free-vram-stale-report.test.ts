// #2050 recurrence — panel_free_vram on 0.52.146 / panel 0.15.124 reported
// freed:true, a ~32 MB torch pool, and occupied_devices:[cuda:0] at 1.2 GB
// free; a health read ~0.2s later showed 10.7 GB free. The MCP clear_vram
// path already polls after /free (#2052); the panel path printed the first
// /system_stats sample. These tests drive the registered panel_free_vram
// handler. The mock occupancy answers as a lagging CUDA driver would.

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
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";
import {
  VRAM_SETTLE_INTERVAL_MS,
  VRAM_SETTLE_TIMEOUT_MS,
} from "../../services/vram-settle.js";

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

let sent: string[] = [];

function bridge(reply: "timeout" | "ok"): PanelToolCtx["bridge"] {
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test double for the panel bridge, not a live UiBridge
  return {
    send: async (cmd: Record<string, unknown>) => {
      sent.push(String(cmd.cmd));
      if (cmd.cmd !== "free_vram") return { ok: true };
      if (reply === "ok") return { freed: true, unload_models: true, free_memory: true };
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
  } as unknown as PanelToolCtx["bridge"];
}

async function run(reply: "timeout" | "ok"): Promise<{ text: string; isError: boolean }> {
  const ctx = makePanelToolCtx(bridge(reply), TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_free_vram");
  if (!def) throw new Error("panel_free_vram is not registered");
  const pending = def.handler({} as never, ctx);
  await vi.advanceTimersByTimeAsync(VRAM_SETTLE_TIMEOUT_MS + VRAM_SETTLE_INTERVAL_MS);
  const res: ToolResult = await pending;
  return { text: textOf(res), isError: res.isError === true };
}

const GIB = 1024 * 1024 * 1024;
/** Reporter: RTX 4070 SUPER 12 GB. */
const TOTAL = 12 * GIB;
/** Immediate post-/free sample: 1.2 GB free. */
const STALE_FREE = Math.round(1.2 * GIB);
/** Health read ~0.2s later: 10.7 GB free. */
const SETTLED_FREE = Math.round(10.7 * GIB);
/** Tiny leftover torch pool (~32 MB) — not a torch pin. */
const TORCH = 32 * 1024 * 1024;
/** Still globally occupied after a partial climb (2 GB / 12 GB = 16.7% < 20%). */
const STILL_OCCUPIED_FREE = 2 * GIB;

type Device = {
  name: string;
  index: number;
  vram_total: number;
  vram_free: number;
  torch_vram_total: number;
  torch_vram_free: number;
};

function gpu(vramFree: number): Device {
  return {
    name: "cuda:0",
    index: 0,
    vram_total: TOTAL,
    vram_free: vramFree,
    torch_vram_total: TORCH,
    torch_vram_free: 0,
  };
}

const STALE = [gpu(STALE_FREE)];
const SETTLED = [gpu(SETTLED_FREE)];
const STILL_OCCUPIED = [gpu(STILL_OCCUPIED_FREE)];

function setDevicesOverTime(sampleAt: (elapsedMs: number) => Device[] | null): void {
  const started = Date.now();
  __panelToolsTestHooks.setReadVramDevices(async () => sampleAt(Date.now() - started));
}

beforeEach(() => {
  sent = [];
  mocks.comfyuiFetch.mockReset();
  mocks.comfyuiFetch.mockResolvedValue({ status: 200 });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-29T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  __panelToolsTestHooks.setFreeVramDirect(null);
  __panelToolsTestHooks.setReadVramDevices(null);
});

describe("panel_free_vram post-unload VRAM (#2050)", () => {
  it("does not report occupied_devices from the immediate 1.2 GB sample", async () => {
    // CUDA still reports the pre-release occupancy until 200ms after /free —
    // the 0.52.146 recurrence window. A single read would name cuda:0 occupied
    // at 1.2 GB free next to a 32 MB torch pool.
    setDevicesOverTime((elapsed) => (elapsed < 200 ? STALE : SETTLED));

    const out = await run("ok");

    expect(sent).toEqual(["free_vram"]);
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/"freed": true/);
    expect(out.text).not.toMatch(/"freed": false/);
    expect(out.text).not.toMatch(/occupied_devices/);
    expect(out.text).not.toContain(String(STALE_FREE));
    expect(out.text).not.toMatch(/STILL PINNED/);
  });

  it("does not treat two equal stale reads inside the min wait as settled", async () => {
    // CUDA still reports 1.2 GB free until 600ms — inside two 250ms polls,
    // before VRAM_SETTLE_MIN_MS. Without the min wait, two equal stale reads
    // would print occupied_devices at 1.2 GB and return.
    setDevicesOverTime((elapsed) => (elapsed < 600 ? STALE : SETTLED));

    const out = await run("ok");

    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/"freed": true/);
    expect(out.text).not.toMatch(/occupied_devices/);
    expect(out.text).not.toContain(String(STALE_FREE));
  });

  it("keeps polling while VRAM is still climbing past the min wait", async () => {
    setDevicesOverTime((elapsed) => {
      if (elapsed >= 1_500) return SETTLED;
      const t = elapsed / 1_500;
      return [gpu(STALE_FREE + (SETTLED_FREE - STALE_FREE) * t)];
    });

    const out = await run("ok");

    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/"freed": true/);
    expect(out.text).not.toMatch(/occupied_devices/);
    expect(out.text).not.toContain(String(STALE_FREE));
  });

  it("reports occupied_devices from the settled sample when the card stays occupied", async () => {
    setDevicesOverTime((elapsed) => (elapsed < 200 ? STALE : STILL_OCCUPIED));

    const out = await run("ok");

    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/"freed": true/);
    expect(out.text).toMatch(/occupied_devices/);
    expect(out.text).toContain(String(STILL_OCCUPIED_FREE));
    expect(out.text).not.toContain(String(STALE_FREE));
    expect(out.text).toMatch(/device 0/);
  });

  it("omits occupied_devices when a later stats read fails", async () => {
    let n = 0;
    __panelToolsTestHooks.setReadVramDevices(async () => {
      n += 1;
      return n === 1 ? STALE : null;
    });

    const out = await run("ok");

    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/"freed": true/);
    expect(out.text).not.toMatch(/occupied_devices/);
    expect(out.text).not.toContain(String(STALE_FREE));
  });

  it("settles vram_after on the frozen-tab server-side path too", async () => {
    setDevicesOverTime((elapsed) => (elapsed < 200 ? STALE : SETTLED));

    const out = await run("timeout");

    expect(mocks.comfyuiFetch).toHaveBeenCalled();
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/"freed": true/);
    expect(out.text).toMatch(/"verified": "server-side"/);
    expect(out.text).not.toMatch(/occupied_devices/);
    const payload = JSON.parse(out.text) as {
      vram_before?: Array<{ vram_free?: number }>;
      vram_after?: Array<{ vram_free?: number }>;
    };
    // before is the pre-/free snapshot (can still be the 1.2 GB occupancy).
    expect(payload.vram_before?.[0]?.vram_free).toBe(STALE_FREE);
    expect(payload.vram_after?.[0]?.vram_free).toBe(SETTLED_FREE);
  });
});
