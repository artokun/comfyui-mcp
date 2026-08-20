// #1671: panel_restart_comfyui cannot recover when a crash takes the panel
// bridge offline. The confirmation card used to be the only path, so a CUDA
// 502 / dead tab answered "the panel could not be reached to ask" and left
// the recovery command depending on the component that had just disappeared.
//
// The shipped path now falls back to the headless managed restart of the
// configured local process when:
//   - confirm is UNREACHABLE (the card never appeared)
//   - ComfyUI is not healthy (down, or ambiguous like an empty-body 502)
//   - the target is a known local boot instance
// Confirmation and busy-queue stay: an explicit decline still does not
// restart; a still-healthy server still does not auto-restart (#1332); a
// readable busy queue still refuses without force:true.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  remoteMode: { value: false },
  configBase: { value: null as string | null },
  restart: vi.fn(async () => ({ stopped: true, started: true, ready: true, message: "restarted" })),
  getQueueVerified: vi.fn(async () => {
    throw new Error("fetch failed");
  }),
}));

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    isRemoteMode: () => hoisted.remoteMode.value || actual.isRemoteMode(),
    getComfyUIBaseUrl: () => hoisted.configBase.value ?? actual.getComfyUIBaseUrl(),
  };
});

vi.mock("../../services/process-control.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/process-control.js")>();
  return { ...actual, restartComfyUI: hoisted.restart };
});

vi.mock("../../comfyui/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../comfyui/client.js")>();
  return { ...actual, getQueueVerified: hoisted.getQueueVerified };
});

vi.mock("../../services/instance-witness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/instance-witness.js")>()),
  acquireInstanceWitness: async () => undefined,
}));

import {
  buildPanelToolDefs,
  __panelToolsTestHooks,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { config, getBootLocalComfyUIBaseUrl } from "../../config.js";

const BOOT_BASE = (getBootLocalComfyUIBaseUrl() ?? "http://127.0.0.1:8188").replace(/\/+$/, "");

const text = (res: ToolResult): string =>
  res.content.find((c) => c.type === "text")!.text as string;
const parse = (res: ToolResult): Record<string, unknown> => JSON.parse(text(res));

function restartTool() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_restart_comfyui");
  if (!def) throw new Error("panel_restart_comfyui not found");
  return def;
}

/** The crash: confirmation cannot be asked, and the tab handshake is gone. */
function makeOfflineCtx(opts?: {
  confirm?: "yes" | "no" | "unreachable";
  /** Last-known handshake Origin — undefined models a tab that is truly gone. */
  serverOrigin?: string | undefined;
  tabIsLocal?: boolean;
}): { ctx: PanelToolCtx; sends: Array<Record<string, unknown>> } {
  const sends: Array<Record<string, unknown>> = [];
  const ctx = {
    call: async () => {
      throw new Error("ctx.call must not be used by the restart handler");
    },
    confirm: async () => opts?.confirm ?? "unreachable",
    ensureReachable: () => {},
    bridge: {
      send: async (cmd: Record<string, unknown>) => {
        sends.push(cmd);
        throw new Error("panel tab is not open");
      },
      tabOrigin: () => undefined,
      tabServerOrigin: () => opts?.serverOrigin,
      tabIsLocal: () => opts?.tabIsLocal ?? false,
      canReach: () => false,
    } as unknown as PanelToolCtx["bridge"],
    tabId: "dead-tab",
    panelConnectionIdentity: () => undefined,
    awaitPostRestartReachable: async () => false,
    tabCanMutateGraph: () => false,
  } as unknown as PanelToolCtx;
  return { ctx, sends };
}

function scriptProbe(samples: Array<"healthy" | "down" | "unknown">): void {
  let i = 0;
  __panelToolsTestHooks.setHealthProbe(async () => samples[Math.min(i++, samples.length - 1)]);
}

/**
 * Decline window must never see healthy (that folds into #1332 / recovered).
 * After the decline window, observeRecovery needs an immediate down→up —
 * leftover "unknown" samples on a 50ms Windows timer would eat the budget.
 */
function scriptCrashThenRecover(decline: "unknown" | "down"): void {
  let firstProbeAt: number | undefined;
  let recoverySamples = 0;
  __panelToolsTestHooks.setHealthProbe(async () => {
    // Measured from the FIRST probe, not fixture setup: handler work before
    // decline sampling (Windows CI especially) used to eat the 80ms budget so
    // every sample looked healthy and the crash path folded into #1332.
    firstProbeAt ??= Date.now();
    if (Date.now() - firstProbeAt < 120) return decline;
    recoverySamples++;
    return recoverySamples < 2 ? "down" : "healthy";
  });
}

beforeEach(() => {
  hoisted.remoteMode.value = false;
  hoisted.configBase.value = null;
  hoisted.restart.mockClear();
  hoisted.restart.mockResolvedValue({ stopped: true, started: true, ready: true, message: "restarted" });
  hoisted.getQueueVerified.mockReset();
  hoisted.getQueueVerified.mockRejectedValue(new Error("fetch failed"));
  config.comfyuiRestartCommand = undefined;
  __panelToolsTestHooks.setLocalRestartPreflight(async () => ({ ok: true }));
  __panelToolsTestHooks.setPanelRebootTiming({
    settleMs: 0,
    budgetMs: 400,
    intervalMs: 5,
    probeTimeoutMs: 5,
  });
  __panelToolsTestHooks.setDeclineProbeTiming({
    windowMs: 40,
    intervalMs: 5,
    probeTimeoutMs: 5,
  });
});

afterEach(() => {
  config.comfyuiRestartCommand = undefined;
  __panelToolsTestHooks.setPanelRebootTiming(null);
  __panelToolsTestHooks.setHealthProbe(null);
  __panelToolsTestHooks.setLocalRestartPreflight(null);
  __panelToolsTestHooks.setDeclineProbeTiming(null);
  hoisted.remoteMode.value = false;
  hoisted.configBase.value = null;
});

describe("panel_restart_comfyui — crash takes the panel bridge offline (#1671)", () => {
  it("the issue: empty-body 502 (ambiguous) + dead tab → headless restart, not a 'could not be reached' dead-end", async () => {
    // Decline window samples 502-class unknown; recovery then observes down→up.
    scriptCrashThenRecover("unknown");
    const { ctx, sends } = makeOfflineCtx();

    const res = await restartTool().handler({}, ctx);
    const o = parse(res);

    expect(hoisted.restart).toHaveBeenCalledTimes(1);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
    expect(o.rebooting).toBe(true);
    expect(o.server_ready).toBe(true);
    expect(o.confirmed_cycle).toBe(true);
    expect(String(o.note)).toMatch(/panel bridge was offline/i);
    expect(String(o.note)).toMatch(/headless managed restart/i);
    expect(res.isError).toBeFalsy();
  });

  it("ECONNREFUSED crash (down for the whole decline window) also recovers through the headless path", async () => {
    scriptCrashThenRecover("down");
    const { ctx, sends } = makeOfflineCtx();

    const res = await restartTool().handler({}, ctx);
    const o = parse(res);

    expect(hoisted.restart).toHaveBeenCalledTimes(1);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
    expect(o.server_ready).toBe(true);
    expect(String(o.note)).toMatch(/panel bridge was offline/i);
  });

  it("#1332 preserved: UNREACHABLE + still-HEALTHY does NOT auto-restart", async () => {
    scriptProbe(["healthy"]);
    const { ctx, sends } = makeOfflineCtx();

    const t = text(await restartTool().handler({}, ctx));

    expect(hoisted.restart).not.toHaveBeenCalled();
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
    expect(t).toMatch(/did NOT dispatch a restart/);
    expect(t).toMatch(/could not be reached to ask/);
    expect(t).toMatch(/server is reachable now/);
    expect(t).toMatch(/restart_comfyui/);
  });

  it("confirmation safeguard: an EXPLICIT decline while down does NOT restart", async () => {
    scriptProbe(["down", "down", "down", "down", "down", "down"]);
    const { ctx, sends } = makeOfflineCtx({ confirm: "no" });

    const t = text(await restartTool().handler({}, ctx));

    expect(hoisted.restart).not.toHaveBeenCalled();
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
    expect(t).toMatch(/ComfyUI is DOWN|ComfyUI appears to be DOWN/i);
    expect(t).not.toMatch(/panel bridge was offline/i);
  });

  it("busy-queue safeguard: a readable busy queue refuses without force — nothing was stopped", async () => {
    hoisted.getQueueVerified.mockResolvedValue({
      queue_running: [{}],
      queue_pending: [],
    } as never);
    scriptProbe(["unknown", "unknown", "unknown", "unknown", "unknown", "unknown"]);
    const { ctx, sends } = makeOfflineCtx();

    const res = await restartTool().handler({}, ctx);
    const o = parse(res);

    expect(hoisted.restart).not.toHaveBeenCalled();
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
    expect(o.refused).toBe(true);
    expect(String(o.note)).toMatch(/in progress or queued/);
    expect(String(o.note)).toMatch(/force:true/);
  });

  it("force:true restarts even with a readable busy queue", async () => {
    hoisted.getQueueVerified.mockResolvedValue({
      queue_running: [{}],
      queue_pending: [],
    } as never);
    scriptCrashThenRecover("unknown");
    const { ctx } = makeOfflineCtx();

    const res = await restartTool().handler({ force: true }, ctx);
    expect(hoisted.restart).toHaveBeenCalledTimes(1);
    expect(parse(res).server_ready).toBe(true);
  });

  it("unreadable queue on an already-unhealthy server is the crash — restart proceeds (not a refuse)", async () => {
    hoisted.getQueueVerified.mockRejectedValue(new Error("HTTP 502"));
    scriptCrashThenRecover("unknown");
    const { ctx } = makeOfflineCtx();

    const res = await restartTool().handler({}, ctx);
    expect(hoisted.restart).toHaveBeenCalledTimes(1);
    expect(parse(res).server_ready).toBe(true);
  });

  it("a proven-different panel origin does NOT restart the configured server", async () => {
    scriptProbe(["unknown", "unknown", "unknown", "unknown", "unknown", "unknown"]);
    const { ctx, sends } = makeOfflineCtx({
      serverOrigin: "http://127.0.0.1:9999",
      tabIsLocal: true,
    });

    const res = await restartTool().handler({}, ctx);
    const o = parse(res);

    expect(hoisted.restart).not.toHaveBeenCalled();
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
    expect(o.refused).toBe(true);
    expect(String(o.note)).toMatch(/did NOT dispatch a restart/);
    expect(String(o.note)).toMatch(/Do NOT reach for restart_comfyui/);
  });

  it("preflight failure refuses BEFORE anything is stopped — unrelaunchable process is not killed", async () => {
    __panelToolsTestHooks.setLocalRestartPreflight(async () => ({
      ok: false,
      reason: "Resolved ComfyUI script does not exist on disk: main.py",
    }));
    scriptProbe(["unknown", "unknown", "unknown", "unknown", "unknown", "unknown"]);
    const { ctx } = makeOfflineCtx();

    const res = await restartTool().handler({}, ctx);
    const o = parse(res);

    expect(hoisted.restart).not.toHaveBeenCalled();
    expect(o.refused).toBe(true);
    expect(String(o.note)).toMatch(/Refusing to restart ComfyUI/);
    expect(String(o.note)).toMatch(/main\.py/);
  });

  it("COMFYUI_RESTART_COMMAND skips the failing preflight and runs the configured command", async () => {
    config.comfyuiRestartCommand = "docker restart comfyui";
    __panelToolsTestHooks.setLocalRestartPreflight(async () => ({
      ok: false,
      reason: "Resolved ComfyUI script does not exist on disk: main.py",
    }));
    scriptCrashThenRecover("unknown");
    const { ctx, sends } = makeOfflineCtx();

    const res = await restartTool().handler({}, ctx);
    const o = parse(res);

    expect(hoisted.restart).toHaveBeenCalledTimes(1);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
    expect(String(o.note)).toMatch(/COMFYUI_RESTART_COMMAND/);
  });

  it("REMOTE mode does not invent a local process to kill", async () => {
    hoisted.remoteMode.value = true;
    scriptProbe(["down", "down", "down", "down", "down", "down"]);
    const { ctx } = makeOfflineCtx();

    const t = text(await restartTool().handler({}, ctx));

    expect(hoisted.restart).not.toHaveBeenCalled();
    expect(t).toMatch(/ComfyUI is DOWN|ComfyUI appears to be DOWN/i);
  });

  it("does not claim graph-tools ready when the tab never came back — #654 honesty on this path too", async () => {
    scriptCrashThenRecover("unknown");
    const { ctx } = makeOfflineCtx();

    const o = parse(await restartTool().handler({}, ctx));
    expect(o.server_ready).toBe(true);
    expect(o.ready).toBe(false);
    expect(o.graph_tools_ready).toBe(false);
    expect(o.panel_tab_reconnected).toBe("unknown");
  });
});
