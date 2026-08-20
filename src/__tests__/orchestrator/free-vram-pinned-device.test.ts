// #1866 — panel_free_vram reported `{freed:true}` after POST /free, while a
// fresh get_system_stats read showed GPU 2 still almost fully occupied.
//
// The reporter ran Raylight sequence-parallel MiniMax H3 with a parallel CLIP
// loader on GPUs 2/3. /free unloads ComfyUI's model manager only; Ray workers
// and custom-node allocations stay resident. The tool must not claim VRAM was
// freed when a device remains pinned — it must name the pinned device(s).

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
import { getBootLocalComfyUIBaseUrl } from "../../config.js";
import { markReplyTimeout } from "../../services/ui-bridge.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

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

function bridge(opts: { reply: "timeout" | "ok" }): PanelToolCtx["bridge"] {
  return {
    send: async (cmd: Record<string, unknown>) => {
      sent.push(String(cmd.cmd));
      if (cmd.cmd !== "free_vram") return { ok: true };
      // The reporter's exact success payload from the panel.
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
    tabServerOrigin: () => BOOT_BASE,
  } as unknown as PanelToolCtx["bridge"];
}

async function run(reply: "timeout" | "ok"): Promise<{ text: string; isError: boolean }> {
  const ctx = makePanelToolCtx(bridge({ reply }), TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_free_vram");
  if (!def) throw new Error("panel_free_vram is not registered");
  const res: ToolResult = await def.handler({} as never, ctx);
  return { text: textOf(res), isError: res.isError === true };
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

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  __panelToolsTestHooks.setFreeVramDirect(null);
  __panelToolsTestHooks.setReadVramDevices(null);
});

describe("panel_free_vram does not claim VRAM freed when a device stays pinned (#1866)", () => {
  it("names GPU 2 as still pinned after the panel's freed:true ack", async () => {
    __panelToolsTestHooks.setReadVramDevices(async () => reporterDevices);
    const out = await run("ok");

    expect(sent).toEqual(["free_vram"]);
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
    __panelToolsTestHooks.setReadVramDevices(async () => allMostlyFree);
    const out = await run("ok");

    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/"freed": true/);
    expect(out.text).not.toMatch(/STILL PINNED/);
  });

  it("leaves the panel ack untouched when occupancy cannot be read", async () => {
    __panelToolsTestHooks.setReadVramDevices(async () => null);
    const out = await run("ok");

    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/"freed": true/);
    expect(out.text).not.toMatch(/pinned_devices/);
  });

  it("does not claim freed on the frozen-tab settle when /system_stats still shows GPU 2 pinned", async () => {
    __panelToolsTestHooks.setFreeVramDirect(async () => ({
      ok: true,
      before: reporterDevices,
      after: reporterDevices,
    }));
    const out = await run("timeout");

    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/"freed": false/);
    expect(out.text).not.toMatch(/"freed": true/);
    expect(out.text).toContain(String(GPU2_FREE));
    expect(out.text).toMatch(/device 2/);
    expect(out.text).toMatch(/"verified": "server-side"/);
  });
});
