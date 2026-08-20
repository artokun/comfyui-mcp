// #1866 — panel_free_vram reported `{freed:true}` after POST /free, while a
// fresh get_system_stats read showed GPU 2 still almost fully occupied.
//
// The reporter ran Raylight sequence-parallel MiniMax H3 with a parallel CLIP
// loader on GPUs 2/3. /free unloads ComfyUI's model manager only; Ray workers
// and custom-node allocations stay resident. The tool must not claim VRAM was
// freed when a device remains pinned — it must name the pinned device(s).
//
// #1887 — two states #1866 did not distinguish:
//   1. Occupancy is read from the tab's proven local server
//      (captureRebootHealthBase), never getComfyUIBaseUrl(). A hello from
//      another tab can retarget the global base; reporting that GPU as this
//      command's failure is a wrong-target failure.
//   2. Pin detection keys on torch_vram_* (this process's allocator), not
//      device-global vram_free. Another process holding the card is not a
//      ComfyUI /free failure and must not prescribe panel_restart_comfyui.
//
// These tests pass `base` into the injected reader and assert it. Discarding
// the argument is what made a `const base = "http://wrong.example:1"` mutation
// of annotateFreeVramAck leave every test green.
//
// #1895 — an occupied card whose torch pool is empty must still NAME the
// device (isError stays false). An unproven tab must not look like a
// measured GPU. Tests drive annotateFreeVramAck / deviceStillPinned directly.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

const { buildPanelToolDefs, makePanelToolCtx, __panelToolsTestHooks } = await import(
  "../../orchestrator/panel-tools.js"
);
import { getBootLocalComfyUIBaseUrl, getComfyUIBaseUrl, setComfyuiTarget } from "../../config.js";
import { markReplyTimeout } from "../../services/ui-bridge.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const TAB = "11111111-2222-3333-4444-555555555555";
const BOOT_BASE = (getBootLocalComfyUIBaseUrl() ?? "http://127.0.0.1:8188").replace(/\/+$/, "");

/** A distinct loopback instance — not the boot server, still classified local. */
function otherLoopback(base: string): string {
  const u = new URL(base);
  u.port = u.port === "18188" ? "18189" : "18188";
  return u.toString().replace(/\/+$/, "");
}

const OTHER_BASE = otherLoopback(BOOT_BASE);

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
let queriedBases: string[] = [];
let originalTarget: string;

function bridge(opts: {
  reply: "timeout" | "ok";
  origin?: string | null;
}): PanelToolCtx["bridge"] {
  return {
    send: async (cmd: Record<string, unknown>) => {
      sent.push(String(cmd.cmd));
      if (cmd.cmd !== "free_vram") return { ok: true };
      if (opts.reply === "ok") return { freed: true, unload_models: true, free_memory: true };
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
    tabServerOrigin: () =>
      opts.origin === undefined ? BOOT_BASE : (opts.origin ?? undefined),
  } as unknown as PanelToolCtx["bridge"];
}

async function run(
  reply: "timeout" | "ok",
  opts?: { origin?: string | null },
): Promise<{ text: string; isError: boolean; ctx: PanelToolCtx }> {
  const ctx = makePanelToolCtx(bridge({ reply, origin: opts?.origin }), TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_free_vram");
  if (!def) throw new Error("panel_free_vram is not registered");
  const res: ToolResult = await def.handler({} as never, ctx);
  return { text: textOf(res), isError: res.isError === true, ctx };
}

/** Inject occupancy. The reader MUST consume `base` — that is the #1887
 *  assertion. Returning devices for any host is what hid the wrong-target
 *  read; tests below check which host was actually asked. */
function setDevices(
  devices: Array<{
    name?: string;
    index?: number;
    vram_total?: number;
    vram_free?: number;
    torch_vram_total?: number;
    torch_vram_free?: number;
  }> | null,
): void {
  __panelToolsTestHooks.setReadVramDevices(async (base: string) => {
    queriedBases.push(base);
    return devices;
  });
}

function expectQueriedProven(ctx: PanelToolCtx): void {
  const proven = __panelToolsTestHooks.captureRebootHealthBase(ctx);
  expect(proven).toBeTruthy();
  expect(queriedBases).toEqual([proven]);
}

const FREED_ACK_BODY = { freed: true, unload_models: true, free_memory: true };

function ackFreed(): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(FREED_ACK_BODY, null, 2) }],
  };
}

/** Reporter: 4× RTX 2080 Ti, 21 GB. GPU 2 at vram_free=187552724 and
 *  torch_vram_free=53072852; GPUs 0,1,3 each ~9.3 GiB free. */
const GIB = 1024 * 1024 * 1024;
const TOTAL = 21 * GIB;
const GPU2_FREE = 187552724;
const GPU2_TORCH_FREE = 53072852;
const MOSTLY_FREE = Math.round(9.3 * GIB);

const reporterDevices = [
  { name: "cuda:0", index: 0, vram_total: TOTAL, vram_free: MOSTLY_FREE, torch_vram_total: TOTAL, torch_vram_free: MOSTLY_FREE },
  { name: "cuda:1", index: 1, vram_total: TOTAL, vram_free: MOSTLY_FREE, torch_vram_total: TOTAL, torch_vram_free: MOSTLY_FREE },
  { name: "cuda:2", index: 2, vram_total: TOTAL, vram_free: GPU2_FREE, torch_vram_total: TOTAL, torch_vram_free: GPU2_TORCH_FREE },
  { name: "cuda:3", index: 3, vram_total: TOTAL, vram_free: MOSTLY_FREE, torch_vram_total: TOTAL, torch_vram_free: MOSTLY_FREE },
];

const allMostlyFree = reporterDevices.map((d) => ({
  ...d,
  vram_free: MOSTLY_FREE,
  torch_vram_free: MOSTLY_FREE,
}));

/** Live /system_stats from #1887: device-global 3.09% free (old logic: PINNED)
 *  while this ComfyUI's torch pool is 32 MiB — it holds ~nothing. */
const otherProcessHoldsCard = [
  {
    name: "cuda:0",
    index: 0,
    vram_total: 25756696576,
    vram_free: 795579336,
    torch_vram_total: 33554432,
    torch_vram_free: 0,
  },
];

const deviceGlobalOccupiedTorchAbsent = [
  {
    name: "cuda:0",
    index: 0,
    vram_total: 25756696576,
    vram_free: 795579336,
  },
];

beforeEach(() => {
  sent = [];
  queriedBases = [];
  originalTarget = getComfyUIBaseUrl();
});

afterEach(() => {
  setComfyuiTarget(originalTarget);
  __panelToolsTestHooks.setFreeVramDirect(null);
  __panelToolsTestHooks.setReadVramDevices(null);
});

describe("panel_free_vram does not claim VRAM freed when a device stays pinned (#1866)", () => {
  it("names GPU 2 as still pinned after the panel's freed:true ack", async () => {
    setDevices(reporterDevices);
    const out = await run("ok");

    expect(sent).toEqual(["free_vram"]);
    expectQueriedProven(out.ctx);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/"freed": false/);
    expect(out.text).not.toMatch(/"freed": true/);
    expect(out.text).toContain(String(GPU2_FREE));
    expect(out.text).toMatch(/"index": 2/);
    expect(out.text).toMatch(/device 2/);
    expect(out.text).toMatch(/model manager/);
    expect(out.text).toMatch(/panel_restart_comfyui/);
    // Siblings the reporter called "mostly free" are not listed as pinned.
    expect(out.text).not.toMatch(/device 0/);
    expect(out.text).not.toMatch(/device 1/);
    expect(out.text).not.toMatch(/device 3/);
  });

  it("still reports freed when occupancy matches the siblings that were mostly free", async () => {
    setDevices(allMostlyFree);
    const out = await run("ok");

    expectQueriedProven(out.ctx);
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/"freed": true/);
    expect(out.text).not.toMatch(/STILL PINNED/);
  });

  it("leaves the panel ack untouched when occupancy cannot be read", async () => {
    setDevices(null);
    const out = await run("ok");

    expectQueriedProven(out.ctx);
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/"freed": true/);
    expect(out.text).not.toMatch(/pinned_devices/);
  });

  it("does not claim freed on the frozen-tab settle when /system_stats still shows GPU 2 pinned", async () => {
    __panelToolsTestHooks.setFreeVramDirect(async (base: string) => {
      queriedBases.push(base);
      return {
        ok: true,
        before: reporterDevices,
        after: reporterDevices,
      };
    });
    const out = await run("timeout");

    expectQueriedProven(out.ctx);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/"freed": false/);
    expect(out.text).not.toMatch(/"freed": true/);
    expect(out.text).toContain(String(GPU2_FREE));
    expect(out.text).toMatch(/device 2/);
    expect(out.text).toMatch(/"verified": "server-side"/);
  });
});

describe("panel_free_vram reads occupancy from this tab's server, not the global base (#1887)", () => {
  it("queries the proven local base after getComfyUIBaseUrl is retargeted to another host", async () => {
    setDevices(reporterDevices);
    expect(setComfyuiTarget(OTHER_BASE)).toBe(true);
    // Premise: the global configured base is no longer this tab's server.
    expect(__panelToolsTestHooks.sameHttpBase(getComfyUIBaseUrl(), BOOT_BASE)).toBe(false);

    const out = await run("ok");
    const proven = __panelToolsTestHooks.captureRebootHealthBase(out.ctx);
    expect(proven).toBeTruthy();
    expect(__panelToolsTestHooks.sameHttpBase(proven, getComfyUIBaseUrl())).toBe(false);
    expect(queriedBases).toEqual([proven]);
    // Occupancy is THIS tab's GPU 2, not whatever the retargeted host would show.
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/"index": 2/);
    expect(out.text).toMatch(/panel_restart_comfyui/);
  });

  it("does not name another server's GPU as this tab's failed free", async () => {
    // Tab fronts a DIFFERENT local instance than boot. Global is the boot
    // server. Returning pinned devices if that host is queried makes a
    // wrong-target read fail this test — the #1878 tests were blind to it.
    // #1895 — the ack is no longer byte-identical to a measured GPU: it must
    // say occupancy was never re-read. Swapping the gate to getComfyUIBaseUrl()
    // still fails: queriedBases would be non-empty and GPU 2 would be named.
    setDevices(reporterDevices);
    expect(setComfyuiTarget(BOOT_BASE)).toBe(true);
    const out = await run("ok", { origin: OTHER_BASE });

    expect(__panelToolsTestHooks.captureRebootHealthBase(out.ctx)).toBeNull();
    expect(queriedBases).toEqual([]);
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/"freed": true/);
    expect(out.text).not.toMatch(/"freed": false/);
    expect(out.text).not.toMatch(/STILL PINNED/);
    expect(out.text).not.toMatch(/panel_restart_comfyui/);
    expect(out.text).not.toMatch(/"index": 2/);
    expect(out.text).toMatch(/"occupancy_reread": false/);
    expect(out.text).toMatch(/never re-read/);
  });
});

describe("panel_free_vram attributes a pin to this ComfyUI's torch pool, not the whole card (#1887)", () => {
  it("does not blame ComfyUI when the torch pool is empty and another process holds the card", async () => {
    setDevices(otherProcessHoldsCard);
    const out = await run("ok");

    expectQueriedProven(out.ctx);
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/"freed": true/);
    expect(out.text).not.toMatch(/"freed": false/);
    expect(out.text).not.toMatch(/STILL PINNED/);
    // #1895 — silence was the bug. Keep isError false but name the device,
    // the live counter, and that /system_stats cannot say which process.
    expect(out.text).toContain("795579336");
    expect(out.text).toMatch(/device 0/);
    expect(out.text).toMatch(/device globally/);
    expect(out.text).toMatch(/cannot name which process/);
    expect(out.text).toMatch(/Ray/);
    expect(out.text).toMatch(/second ComfyUI/);
    expect(out.text).toMatch(/will not/);
  });

  it("does not treat device-global vram_free as a pin when torch counters are absent", async () => {
    setDevices(deviceGlobalOccupiedTorchAbsent);
    const out = await run("ok");

    expectQueriedProven(out.ctx);
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/"freed": true/);
    expect(out.text).not.toMatch(/"freed": false/);
    expect(out.text).not.toMatch(/STILL PINNED/);
    expect(out.text).toContain("795579336");
    expect(out.text).toMatch(/device 0/);
    expect(out.text).toMatch(/cannot name which process/);
  });

  it("still names a pin when THIS instance's torch pool is occupied even if the card looks free", async () => {
    // Inverse discriminator: device-global mostly free (old vram_free rule
    // would report success) while GPU 2's torch pool matches the reporter's
    // 0.24% leftover — that is ComfyUI's doing.
    const torchPinnedDeviceGlobalFree = reporterDevices.map((d) =>
      d.index === 2
        ? { ...d, vram_free: MOSTLY_FREE, torch_vram_free: GPU2_TORCH_FREE }
        : { ...d, vram_free: MOSTLY_FREE, torch_vram_free: MOSTLY_FREE },
    );
    setDevices(torchPinnedDeviceGlobalFree);
    const out = await run("ok");

    expectQueriedProven(out.ctx);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/"freed": false/);
    expect(out.text).toMatch(/device 2/);
    expect(out.text).toMatch(/panel_restart_comfyui/);
    expect(out.text).not.toMatch(/device 0/);
  });
});

describe("annotateFreeVramAck discloses occupied-but-not-torch-pinned (#1895)", () => {
  it("keeps isError false, names device 0, and prints the live 795579336 counter", async () => {
    setDevices(otherProcessHoldsCard);
    const ctx = makePanelToolCtx(bridge({ reply: "ok" }), TAB, new WorkflowTargetStore());
    const out = await __panelToolsTestHooks.annotateFreeVramAck(ctx, ackFreed());

    expectQueriedProven(ctx);
    expect(out.isError === true).toBe(false);
    const text = textOf(out);
    expect(text).toMatch(/"freed": true/);
    expect(text).not.toMatch(/"freed": false/);
    expect(text).toContain("795579336");
    expect(text).toMatch(/device 0/);
    expect(text).toMatch(/"occupied_devices"/);
    expect(text).toMatch(/device globally/);
    expect(text).toMatch(/cannot name which process/);
    expect(text).toMatch(/Ray/);
    expect(text).toMatch(/second ComfyUI/);
    expect(text).toMatch(/will not/);
    expect(text).not.toMatch(/STILL PINNED/);
    expect(text).not.toMatch(/Next: panel_restart_comfyui/);
  });

  it("reads occupancy from captureRebootHealthBase, not getComfyUIBaseUrl", async () => {
    setDevices(otherProcessHoldsCard);
    expect(setComfyuiTarget(OTHER_BASE)).toBe(true);
    const ctx = makePanelToolCtx(bridge({ reply: "ok" }), TAB, new WorkflowTargetStore());
    const out = await __panelToolsTestHooks.annotateFreeVramAck(ctx, ackFreed());

    const proven = __panelToolsTestHooks.captureRebootHealthBase(ctx);
    expect(proven).toBeTruthy();
    expect(__panelToolsTestHooks.sameHttpBase(proven, getComfyUIBaseUrl())).toBe(false);
    expect(queriedBases).toEqual([proven]);
    expect(out.isError === true).toBe(false);
    expect(textOf(out)).toContain("795579336");
  });

  it("does not return a byte-identical freed:true when the tab's server is unproven", async () => {
    setDevices(reporterDevices);
    const ctx = makePanelToolCtx(
      bridge({ reply: "ok", origin: OTHER_BASE }),
      TAB,
      new WorkflowTargetStore(),
    );
    const ack = ackFreed();
    const out = await __panelToolsTestHooks.annotateFreeVramAck(ctx, ack);

    expect(__panelToolsTestHooks.captureRebootHealthBase(ctx)).toBeNull();
    expect(queriedBases).toEqual([]);
    expect(out.isError === true).toBe(false);
    const text = textOf(out);
    expect(text).toMatch(/"freed": true/);
    expect(text).not.toBe(textOf(ack));
    expect(text).toMatch(/"occupancy_reread": false/);
    expect(text).toMatch(/never re-read/);
    expect(text).toMatch(/receipt/);
    expect(text).not.toMatch(/"index": 2/);
    expect(text).not.toMatch(/STILL PINNED/);
    expect(text).not.toMatch(/panel_restart_comfyui/);
  });

  it("discloses an occupied card after a server-side settle without blaming the torch pool", async () => {
    __panelToolsTestHooks.setFreeVramDirect(async (base: string) => {
      queriedBases.push(base);
      return { ok: true, before: otherProcessHoldsCard, after: otherProcessHoldsCard };
    });
    const out = await run("timeout");

    expectQueriedProven(out.ctx);
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/"freed": true/);
    expect(out.text).not.toMatch(/"freed": false/);
    expect(out.text).toContain("795579336");
    expect(out.text).toMatch(/device 0/);
    expect(out.text).toMatch(/"verified": "server-side"/);
    expect(out.text).not.toMatch(/STILL PINNED/);
    expect(out.text).not.toMatch(/Next: panel_restart_comfyui/);
  });
});

describe("deviceStillPinned (#1887 / #1895)", () => {
  const pin = (d: Parameters<typeof __panelToolsTestHooks.deviceStillPinned>[0]) =>
    __panelToolsTestHooks.deviceStillPinned(d);

  it("is false for the live 32 MiB torch pool next to a 97% occupied card", () => {
    expect(pin(otherProcessHoldsCard[0])).toBe(false);
  });

  it("is true for the reporter's GPU 2 torch pool (~0.24% free)", () => {
    expect(pin(reporterDevices[2])).toBe(true);
  });

  it("is false when torch counters are absent", () => {
    expect(pin(deviceGlobalOccupiedTorchAbsent[0])).toBe(false);
  });

  it("measures pool fullness, not reserved share of the card (predicate-shape note)", () => {
    // #1895 item 3: 24 GiB card at 3% device-free, this ComfyUI still reserves
    // 5 GiB of which 4 GiB is unused inside the pool. NOT observed live after
    // /free — documents the current predicate, does not invent a measurement.
    expect(
      pin({
        vram_total: 24 * GIB,
        vram_free: Math.round(0.03 * 24 * GIB),
        torch_vram_total: 5 * GIB,
        torch_vram_free: 4 * GIB,
      }),
    ).toBe(false);
  });
});
