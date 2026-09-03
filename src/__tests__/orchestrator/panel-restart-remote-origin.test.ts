// #2804 — panel_restart_comfyui must restart the SAME remote ComfyUI the live
// panel controls. After a custom-node install the tool was called with
// already_authorized:true against a canvas bound to https://… while
// restart_comfyui still targeted http://127.0.0.1:8188. The identity gate
// only accounted for a local instance and refused, telling the caller to set
// COMFYUI_MCP_FORCE_REMOTE — a process-wide flag this tool does not expose.
//
// The shipped handler now uses the Manager reboot on the tab whose
// server-observed Origin is a concrete non-loopback host. It must not kill
// the configured local process, must not HTTP-probe a guessed origin, and
// must keep refusing unbound/local cases.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resetClient = vi.fn();
const resetObjectInfoCache = vi.fn();
const getQueueVerified = vi.fn(async () => {
  throw new Error("getQueueVerified must not read the configured local queue for a remote panel origin");
});

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  getQueueVerified: (...args: unknown[]) => getQueueVerified(...args),
  resetClient: () => resetClient(),
  resetObjectInfoCache: () => resetObjectInfoCache(),
}));

const hoisted = vi.hoisted(() => ({
  restart: vi.fn(async () => {
    throw new Error("headless restartComfyUI must not run for a bound remote panel origin");
  }),
}));

vi.mock("../../services/process-control.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/process-control.js")>();
  return { ...actual, restartComfyUI: hoisted.restart };
});

const { buildPanelToolDefs, __panelToolsTestHooks } = await import(
  "../../orchestrator/panel-tools.js"
);
import { getBootLocalComfyUIBaseUrl, getComfyUIBaseUrl } from "../../config.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const BOOT_BASE = (getBootLocalComfyUIBaseUrl() ?? "http://127.0.0.1:8188").replace(/\/+$/, "");
const REMOTE_ORIGIN = "https://comfy.example.invalid";

const text = (res: ToolResult): string =>
  res.content.find((c) => c.type === "text")!.text as string;
const parse = (res: ToolResult): Record<string, unknown> => JSON.parse(text(res));

function restartTool() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_restart_comfyui");
  if (!def) throw new Error("panel_restart_comfyui not found");
  return def;
}

function makeCtx(opts: {
  serverOrigin?: string;
  isLocal?: boolean;
  /** Drop the handshake Origin on ensureReachable (a rebind/lost proof). */
  dropOriginOnEnsure?: boolean;
  rebootReply?: Record<string, unknown>;
}): {
  ctx: PanelToolCtx;
  sends: Array<Record<string, unknown>>;
  confirm: ReturnType<typeof vi.fn>;
} {
  const sends: Array<Record<string, unknown>> = [];
  const origin = { current: opts.serverOrigin };
  const confirm = vi.fn(async () => "yes" as const);
  const ctx = {
    call: async () => {
      throw new Error("ctx.call must not be used by the restart handler");
    },
    confirm,
    ensureReachable: () => {
      if (opts.dropOriginOnEnsure) origin.current = undefined;
    },
    bridge: {
      send: async (cmd: Record<string, unknown>) => {
        sends.push(cmd);
        if (cmd.cmd === "comfy_reboot") {
          return opts.rebootReply ?? { rebooting: true };
        }
        return {};
      },
      tabOrigin: () => origin.current,
      tabServerOrigin: () => origin.current,
      tabIsLocal: () => opts.isLocal === true,
      canReach: () => true,
    } as PanelToolCtx["bridge"],
    tabId: "remote-tab",
    panelConnectionIdentity: () => ({ generation: 1, tabSessionId: "browser-tab-remote" }),
    awaitPostRestartReachable: async () => true,
    tabCanMutateGraph: () => true,
  } as PanelToolCtx;
  return { ctx, sends, confirm };
}

beforeEach(() => {
  resetClient.mockClear();
  resetObjectInfoCache.mockClear();
  getQueueVerified.mockClear();
  hoisted.restart.mockClear();
  __panelToolsTestHooks.setVerifiedProxyRestartTarget(async () => undefined);
  __panelToolsTestHooks.setLocalRestartPreflight(async () => {
    throw new Error("local restart preflight must not run for a bound remote panel origin");
  });
  __panelToolsTestHooks.setPanelRebootTiming({
    settleMs: 0,
    budgetMs: 60,
    intervalMs: 5,
    probeTimeoutMs: 10,
  });
  __panelToolsTestHooks.setHealthProbe(async (base) => {
    throw new Error(`must not health-probe ${String(base)} for a bound remote panel origin`);
  });
});

afterEach(() => {
  __panelToolsTestHooks.setVerifiedProxyRestartTarget(null);
  __panelToolsTestHooks.setLocalRestartPreflight(null);
  __panelToolsTestHooks.setPanelRebootTiming(null);
  __panelToolsTestHooks.setHealthProbe(null);
});

describe("panel_restart_comfyui bound remote origin (#2804)", () => {
  it("REPRO: already_authorized against a remote panel Origin dispatches Manager reboot, not a local refuse", async () => {
    expect(getComfyUIBaseUrl().replace(/\/+$/, "")).toBe(BOOT_BASE);
    const { ctx, sends, confirm } = makeCtx({
      serverOrigin: REMOTE_ORIGIN,
      isLocal: false,
    });

    const out = parse(await restartTool().handler({ already_authorized: true }, ctx));

    expect(confirm).not.toHaveBeenCalled();
    expect(hoisted.restart).not.toHaveBeenCalled();
    expect(getQueueVerified).not.toHaveBeenCalled();
    expect(sends.filter((cmd) => cmd.cmd === "comfy_reboot")).toEqual([
      { cmd: "comfy_reboot", force: false },
    ]);
    expect(out.refused).toBeUndefined();
    expect(out.rebooting).toBe(true);
    expect(out.confirmed_cycle).toBe(false);
    expect(String(out.note)).not.toMatch(/COMFYUI_MCP_FORCE_REMOTE/);
    expect(String(out.note)).not.toMatch(/could not confirm that this panel's ComfyUI is/);
  });

  it("keeps the Manager busy guard — a busy refusal is returned verbatim and does not kill local ComfyUI", async () => {
    const { ctx, sends } = makeCtx({
      serverOrigin: REMOTE_ORIGIN,
      isLocal: false,
      rebootReply: { rebooting: false, error: "Refused: a generation is in progress." },
    });

    const res = await restartTool().handler({ already_authorized: true }, ctx);
    const bodyText = text(res);

    expect(sends.filter((cmd) => cmd.cmd === "comfy_reboot")).toHaveLength(1);
    expect(hoisted.restart).not.toHaveBeenCalled();
    expect(bodyText).toMatch(/in progress/);
    expect(bodyText).not.toMatch(/COMFYUI_MCP_FORCE_REMOTE/);
    expect(resetClient).not.toHaveBeenCalled();
  });

  it("does not restart a guessed origin when the handshake Origin is lost at dispatch", async () => {
    const { ctx, sends } = makeCtx({
      serverOrigin: REMOTE_ORIGIN,
      isLocal: false,
      dropOriginOnEnsure: true,
    });

    const out = parse(await restartTool().handler({ already_authorized: true }, ctx));

    expect(out.refused).toBe(true);
    expect(out.rebooting).toBe(false);
    expect(sends.some((cmd) => cmd.cmd === "comfy_reboot")).toBe(false);
    expect(hoisted.restart).not.toHaveBeenCalled();
  });

  it("still refuses an unbound local loopback tab — the remote path is not a guessed-origin bypass", async () => {
    const { ctx, sends } = makeCtx({
      serverOrigin: "http://localhost:8188",
      isLocal: true,
    });
    __panelToolsTestHooks.setLocalRestartPreflight(async () => ({ ok: true }));

    const out = parse(await restartTool().handler({ already_authorized: true }, ctx));

    expect(out.refused).toBe(true);
    expect(sends).toEqual([]);
    expect(hoisted.restart).not.toHaveBeenCalled();
    expect(String(out.note)).toMatch(/could not confirm that this panel's ComfyUI is/);
  });

  it("still refuses a relayed tab whose Origin is the local boot instance", async () => {
    const { ctx, sends } = makeCtx({
      serverOrigin: BOOT_BASE,
      isLocal: false,
    });
    __panelToolsTestHooks.setLocalRestartPreflight(async () => ({ ok: true }));

    const out = parse(await restartTool().handler({ already_authorized: true }, ctx));

    expect(out.refused).toBe(true);
    expect(sends).toEqual([]);
    expect(hoisted.restart).not.toHaveBeenCalled();
    expect(String(out.note)).toMatch(/did not arrive on the local loopback listener/);
  });

  it("a missing handshake Origin is still unbound — nothing is guessed", async () => {
    const { ctx, sends } = makeCtx({ isLocal: false });
    __panelToolsTestHooks.setLocalRestartPreflight(async () => ({ ok: true }));

    const out = parse(await restartTool().handler({ already_authorized: true }, ctx));

    expect(out.refused).toBe(true);
    expect(sends).toEqual([]);
    expect(hoisted.restart).not.toHaveBeenCalled();
  });
});
