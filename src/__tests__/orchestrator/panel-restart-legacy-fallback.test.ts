// #425 / panel #253/#266: panel_restart_comfyui must not dead-end when the
// built-in Manager exposes NO reboot endpoint (legacy Manager 3.x: the v2 route
// 405s, the legacy route 404s). For a LOCAL, process-controllable target it now
// falls back to the headless managed restart (kill + relaunch). A busy-guard or
// security refusal must NOT trigger that fallback (it would abort a running
// render / defeat Manager security), and a REMOTE target has no local process to
// restart — both return the refusal verbatim.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  remoteMode: { value: false },
  restart: vi.fn(async () => ({ stopped: true, started: true, ready: true, message: "restarted" })),
}));

// isRemoteMode() gates the fallback; keep the rest of config real.
vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return { ...actual, isRemoteMode: () => hoisted.remoteMode.value };
});

// The headless managed restart is the fallback mechanism — stub it so no real
// process/port is touched, and so we can assert whether it was invoked.
vi.mock("../../services/process-control.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/process-control.js")>();
  return { ...actual, restartComfyUI: hoisted.restart };
});

import {
  buildPanelToolDefs,
  rebootNoEndpoint,
  __panelToolsTestHooks,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { getBootLocalComfyUIBaseUrl } from "../../config.js";

// The managed kill+relaunch takes our OWN boot instance DOWN then UP, so signal (a)
// (boot-endpoint DOWN→UP) confirms the cycle. Point the tab at the boot origin.
const BOOT_BASE = (getBootLocalComfyUIBaseUrl() ?? "http://127.0.0.1:8188").replace(/\/+$/, "");

const NO_ENDPOINT_TEXT =
  "Could not reach any ComfyUI-Manager reboot endpoint — ComfyUI was NOT restarted " +
  "(is the built-in Manager enabled?). Tried: POST /v2/manager/reboot → HTTP 405; " +
  "GET /manager/reboot → HTTP 404";

function nonError(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** ctx whose comfy_reboot dispatch (bridge.send) returns a caller-supplied RAW reply
 *  object. `frontsBoot` controls whether the bound tab provably fronts the boot
 *  instance (tabIsLocal + origin match) — the gate for running the managed restart. */
function makeCtx(
  rebootReply: Record<string, unknown>,
  frontsBoot = true,
): { ctx: PanelToolCtx; calls: string[] } {
  const calls: string[] = [];
  const ctx = {
    call: async () => {
      throw new Error("ctx.call must not be used for reboot dispatch");
    },
    confirm: async () => "yes" as const,
    ensureReachable: () => {},
    bridge: {
      send: async (cmd: { cmd: string }) => {
        calls.push(cmd.cmd);
        return rebootReply;
      },
      tabOrigin: () => (frontsBoot ? BOOT_BASE : "http://127.0.0.1:9191"),
      // The reboot gate reads the SERVER-OBSERVED handshake origin (tabServerOrigin).
      tabServerOrigin: () => (frontsBoot ? BOOT_BASE : "http://127.0.0.1:9191"),
      tabIsLocal: () => frontsBoot,
    } as unknown as PanelToolCtx["bridge"],
    tabId: "t",
  } as unknown as PanelToolCtx;
  return { ctx, calls };
}

const NO_ENDPOINT_REPLY = { rebooting: false, error: NO_ENDPOINT_TEXT };

function restartTool() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_restart_comfyui");
  if (!def) throw new Error("panel_restart_comfyui not found");
  return def;
}

beforeEach(() => {
  hoisted.remoteMode.value = false;
  hoisted.restart.mockClear();
  hoisted.restart.mockResolvedValue({ stopped: true, started: true, ready: true, message: "restarted" });
  __panelToolsTestHooks.setPanelRebootTiming({
    settleMs: 0,
    budgetMs: 50,
    intervalMs: 1,
    probeTimeoutMs: 5,
  });
  // OUR independent boot-endpoint recovery observation runs concurrently with the
  // managed restart (we do NOT trust restartComfyUI's own readiness). Default: a real
  // cycle (down then healthy → observed-cycle).
  const seq: Array<"healthy" | "down"> = ["down", "down", "healthy"];
  let i = 0;
  __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(i++, seq.length - 1)]);
});

afterEach(() => {
  __panelToolsTestHooks.setPanelRebootTiming(null);
  __panelToolsTestHooks.setHealthProbe(null);
});

describe("rebootNoEndpoint classifier", () => {
  it("matches a genuine no-endpoint refusal", () => {
    expect(rebootNoEndpoint(nonError(NO_ENDPOINT_TEXT))).toBe(true);
  });
  it("does NOT match a busy-guard refusal", () => {
    expect(
      rebootNoEndpoint(nonError("Refused: a generation is in progress; restart aborted.")),
    ).toBe(false);
  });
  it("does NOT match a Manager-security refusal", () => {
    expect(
      rebootNoEndpoint(nonError("Reboot refused (HTTP 403) — Manager security forbids it.")),
    ).toBe(false);
  });
  it("does NOT match an error ToolResult (in-flight drop)", () => {
    expect(rebootNoEndpoint({ isError: true, content: [{ type: "text", text: NO_ENDPOINT_TEXT }] })).toBe(false);
  });
});

describe("panel_restart_comfyui — legacy no-endpoint fallback", () => {
  it("LOCAL + no-endpoint → falls back to the managed restart; OUR observation confirms the cycle", async () => {
    const { ctx } = makeCtx(NO_ENDPOINT_REPLY);
    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    expect(hoisted.restart).toHaveBeenCalledTimes(1);
    const out = JSON.parse(res.content.find((c) => c.type === "text")!.text as string);
    // Confirmed by OUR concurrent boot-endpoint observation (down then healthy) — not by
    // restartComfyUI's own (possibly first-healthy) readiness.
    expect(out.ready).toBe(true);
    expect(out.confirmed_cycle).toBe(true);
    expect(out.via).toBe("observed-cycle");
    expect(String(out.note)).toMatch(/came back healthy/i);
    expect(res.isError).toBeFalsy();
  });

  it("Desktop first-healthy (NO observed down) → couldn't-confirm (a no-op leaves the endpoint healthy)", async () => {
    // A legacy restart is AMBIGUOUS: a Desktop Manager-reboot that's first-healthy, or a
    // preflight no-op, leaves the endpoint healthy WITHOUT a real cycle. We require an
    // OBSERVED down here, so an always-healthy endpoint → couldn't-confirm (coordinator P1).
    hoisted.restart.mockResolvedValue({ stopped: true, started: true, ready: true, message: "rebooted" });
    __panelToolsTestHooks.setHealthProbe(async () => "healthy"); // never observed going down
    const { ctx } = makeCtx(NO_ENDPOINT_REPLY);
    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    const out = JSON.parse(res.content.find((c) => c.type === "text")!.text as string);
    expect(out.ready).toBe(false);
    expect(out.confirmed_cycle).toBe(false);
    expect(res.isError).toBeFalsy();
  });

  it("managed restart runs but the endpoint NEVER becomes healthy → couldn't-confirm", async () => {
    __panelToolsTestHooks.setHealthProbe(async () => "down"); // never comes back up
    const { ctx } = makeCtx(NO_ENDPOINT_REPLY);
    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    const out = JSON.parse(res.content.find((c) => c.type === "text")!.text as string);
    expect(out.ready).toBe(false);
    expect(out.confirmed_cycle).toBe(false);
    expect(res.isError).toBeFalsy();
  });

  it("managed restart has a spawn_error (process could not launch) → actionable error", async () => {
    hoisted.restart.mockResolvedValue({
      stopped: true,
      started: false,
      message: "spawn ENOENT",
      spawn_error: { code: "ENOENT" } as never,
    });
    __panelToolsTestHooks.setHealthProbe(async () => "down"); // never comes up
    const { ctx } = makeCtx(NO_ENDPOINT_REPLY);
    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/did not restart|spawn ENOENT/i);
  });

  it("DEFINITIVE no-restart (stopped:false, started:false — no process / unsafe relaunch) → actionable error, no false success", async () => {
    // restartComfyUI refused before stopping anything, so the endpoint is the OLD process.
    // A still-healthy endpoint must NOT be certified — fail clearly (coordinator P1).
    hoisted.restart.mockResolvedValue({ stopped: false, started: false, message: "No ComfyUI process found" });
    __panelToolsTestHooks.setHealthProbe(async () => "healthy"); // old process still up
    const { ctx } = makeCtx(NO_ENDPOINT_REPLY);
    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/did not restart|No ComfyUI process found/i);
  });

  it("SLOW cold start: startComfyUI's readiness poll EXPIRES (started:false) but OUR proof confirms within budget", async () => {
    // coordinator MEDIUM: a genuine cold start slower than startComfyUI's own poll
    // (started:false) must NOT be a terminal failure — our concurrent DOWN→UP proof
    // (down,down,healthy) sees the real cycle and confirms.
    hoisted.restart.mockResolvedValue({ stopped: true, started: false, message: "readiness poll expired" });
    const { ctx } = makeCtx(NO_ENDPOINT_REPLY);
    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    const out = JSON.parse(res.content.find((c) => c.type === "text")!.text as string);
    expect(out.ready).toBe(true);
    expect(out.confirmed_cycle).toBe(true);
    expect(res.isError).toBeFalsy();
  });

  it("REMOTE + no-endpoint → does NOT kill+relaunch; returns the refusal verbatim", async () => {
    hoisted.remoteMode.value = true;
    const { ctx } = makeCtx(NO_ENDPOINT_REPLY);
    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    expect(hoisted.restart).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain("was NOT restarted");
  });

  it("bound tab does NOT front the boot instance → does NOT restart the wrong local server", async () => {
    // The managed kill+relaunch acts on the orchestrator's global target; if we can't
    // prove the bound tab fronts THAT (boot) instance, we must not restart a different
    // local instance and claim success — return the refusal verbatim instead.
    const { ctx } = makeCtx(NO_ENDPOINT_REPLY, /* frontsBoot */ false);
    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    expect(hoisted.restart).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain("was NOT restarted");
  });

  it("busy-guard refusal → NEVER falls back (does not abort a running render)", async () => {
    const { ctx } = makeCtx({ rebooting: false, error: "Refused: a generation is in progress." });
    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    expect(hoisted.restart).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain("in progress");
  });
});
