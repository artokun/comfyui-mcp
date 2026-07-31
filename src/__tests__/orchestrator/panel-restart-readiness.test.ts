// panel_restart_comfyui reboot-DISPATCH classification: a CONFIRMED ack
// (rebooting:true) or an EXPECTED mid-command drop ("OUTCOME UNKNOWN") is a fired
// reboot (drop caches, then poll for restart PROOF); a PRE-DISPATCH "is not open"
// (no reboot was sent) or a busy-guard REFUSAL (rebooting:false) is NOT fired —
// returned verbatim, caches untouched, no poll.
//   #493 (comfyui-mcp) + #222/#263/#266/#306/#307 (comfyui-mcp-panel).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resetClient = vi.fn();
const resetObjectInfoCache = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: () => resetClient(),
  resetObjectInfoCache: () => resetObjectInfoCache(),
}));

const { buildPanelToolDefs, __panelToolsTestHooks } = await import(
  "../../orchestrator/panel-tools.js"
);
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const parse = (res: ToolResult): Record<string, unknown> =>
  JSON.parse(res.content.find((c) => c.type === "text")!.text as string);

/** A ctx whose comfy_reboot dispatch (via bridge.send) returns `reply` or throws
 *  `throwMsg`. Readiness never certifies here (no down→up, no reconnect). */
function ctxReboot(reply: Record<string, unknown> | null, throwMsg?: string): PanelToolCtx {
  return {
    call: async () => {
      throw new Error("ctx.call must not be used for reboot dispatch");
    },
    confirm: async () => "yes" as const,
    ensureReachable: () => {},
    bridge: {
      send: async () => {
        if (throwMsg) throw new Error(throwMsg);
        return reply ?? {};
      },
      tabOrigin: () => undefined,
      tabIsLocal: () => false,
      tabSockId: () => "s0",
      canReach: () => false,
    } as unknown as PanelToolCtx["bridge"],
    tabId: "test-tab",
  } as unknown as PanelToolCtx;
}

function rebootHandler() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_restart_comfyui");
  if (!def) throw new Error("panel_restart_comfyui not found");
  return def.handler;
}

beforeEach(() => {
  resetClient.mockClear();
  resetObjectInfoCache.mockClear();
  __panelToolsTestHooks.setPanelRebootTiming({
    settleMs: 0,
    budgetMs: 60,
    intervalMs: 5,
    probeTimeoutMs: 10,
  });
});

afterEach(() => {
  __panelToolsTestHooks.setPanelRebootTiming(null);
  __panelToolsTestHooks.setHealthProbe(null);
});

describe("panel_restart_comfyui reboot-dispatch classification", () => {
  it("CONFIRMED ack (rebooting:true) is a fired reboot → caches dropped, readiness polled", async () => {
    const res = await rebootHandler()({ force: false }, ctxReboot({ rebooting: true }));
    const out = parse(res);
    expect(out.rebooting).toBe(true);
    expect(resetClient).toHaveBeenCalledTimes(1);
    expect(resetObjectInfoCache).toHaveBeenCalledTimes(1);
  });

  it("EXPECTED drop (OUTCOME UNKNOWN) is a fired reboot → caches dropped", async () => {
    const res = await rebootHandler()(
      { force: false },
      ctxReboot(null, 'panel tab abc disconnected mid-command ("comfy_reboot") — OUTCOME UNKNOWN'),
    );
    expect(parse(res).rebooting).toBe(true);
    expect(resetClient).toHaveBeenCalledTimes(1);
  });

  it("PRE-DISPATCH 'is not open' (no reboot sent) → returned verbatim, caches untouched", async () => {
    const res = await rebootHandler()(
      { force: false },
      ctxReboot(null, "Panel tab abc12345 is not open"),
    );
    expect(res.isError).toBe(true);
    expect(resetClient).not.toHaveBeenCalled();
    expect(resetObjectInfoCache).not.toHaveBeenCalled();
  });

  it("REFUSAL (busy guard, rebooting:false) → returned verbatim, no cache reset", async () => {
    const res = await rebootHandler()(
      { force: false },
      ctxReboot({ rebooting: false, blocked_busy: true, queue_running: 1 }),
    );
    const out = parse(res);
    expect(out.rebooting).toBe(false);
    expect(out.blocked_busy).toBe(true);
    expect(resetClient).not.toHaveBeenCalled();
  });
});
