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
    panelConnectionIdentity: () => ({ generation: 1, tabSessionId: "browser-tab-a" }),
    awaitPostRestartReachable: async () => true,
    tabCanMutateGraph: () => true,
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
  // The #742 refuse-safe preflight passes by default here (the live one would
  // probe real processes/ports); these tests exercise the post-dispatch paths.
  __panelToolsTestHooks.setLocalRestartPreflight(async () => ({ ok: true }));
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
  __panelToolsTestHooks.setLocalRestartPreflight(null);
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

  it("does not claim graph tools are ready when the legacy restart reconnects a stale panel bundle (#709)", async () => {
    const { ctx } = makeCtx(NO_ENDPOINT_REPLY);
    ctx.awaitPostRestartReachable = async () => true;
    ctx.tabCanMutateGraph = () => false; // stale pre-workflow-stamp browser bundle

    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    const out = JSON.parse(res.content.find((c) => c.type === "text")!.text as string);
    expect(out.server_ready).toBe(true);
    expect(out.panel_tab_reconnected).toBe(true);
    expect(out.graph_tools_ready).toBe(false);
    expect(out.ready).toBe(false);
    expect(String(out.note)).toMatch(/stale panel bundle|Hard-refresh.*Ctrl\+Shift\+R/i);
    expect(String(out.note)).not.toMatch(/rebind with panel_set_workflow_target/i);
  });

  it("does not claim graph tools are ready when the legacy restart server recovers before its panel tab", async () => {
    const { ctx } = makeCtx(NO_ENDPOINT_REPLY);
    ctx.awaitReachable = async () => true; // the pre-restart tab is still reachable
    ctx.awaitPostRestartReachable = async () => false;
    ctx.tabCanMutateGraph = () => true;

    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    const out = JSON.parse(res.content.find((c) => c.type === "text")!.text as string);
    expect(out.server_ready).toBe(true);
    expect(out.panel_tab_reconnected).toBe(false);
    expect(out.graph_tools_ready).toBe(false);
    expect(out.ready).toBe(false);
    expect(String(out.note)).toMatch(/has NOT reconnected|rebind/i);
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
    // local instance and claim success.
    //
    // Since #814 the guard fires EARLIER and harder: an unbindable local target is
    // refused before any reboot is dispatched at all, so the legacy fallback is never
    // reached. The assertion this test exists for — the wrong local server is not
    // restarted — holds a fortiori.
    const { ctx } = makeCtx(NO_ENDPOINT_REPLY, /* frontsBoot */ false);
    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    expect(hoisted.restart).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/cannot tell which server the restart would stop/i);
  });

  it("busy-guard refusal → NEVER falls back (does not abort a running render)", async () => {
    const { ctx } = makeCtx({ rebooting: false, error: "Refused: a generation is in progress." });
    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    expect(hoisted.restart).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain("in progress");
  });
});

// #425 RECURRENCE, reported by the owner against 0.50.27 on a remote RunPod H100:
// "server-scoped restart_comfyui received HTTP 405 from the Manager reboot routes.
// The newly installed lee-rife nodes remained unavailable until a provider/host
// restart."
//
// The v0.48.20 fallback is LOCAL-ONLY and correctly does nothing on a remote
// target — there is no process on this machine to cycle. But the fall-through
// returned the bare "no reboot endpoint … was NOT restarted", so nothing told
// them a HOST restart was the actual requirement, or that the nodes they had just
// installed were not loaded. That silence is what closed my earlier triage of this
// issue too early.
describe("#425 remote: the refusal must name what will actually work", () => {
  beforeEach(() => {
    hoisted.remoteMode.value = true;
  });

  it("says the managed local restart does not apply, and why", async () => {
    const { ctx } = makeCtx(NO_ENDPOINT_REPLY);
    const text = ((await restartTool().handler({}, ctx)) as ToolResult).content[0].text;

    expect(text).toContain("was NOT restarted"); // the original refusal survives
    expect(text).toMatch(/REMOTE/);
    expect(text).toMatch(/no process on this machine to cycle/i);
  });

  it("explains the 405 as a missing route, not an auth failure", async () => {
    // The frontend catchall answers every unregistered POST with 405, so a 405 from
    // a Manager route means the dialect has no reboot API — chasing credentials is
    // the wrong direction.
    const { ctx } = makeCtx(NO_ENDPOINT_REPLY);
    const text = ((await restartTool().handler({}, ctx)) as ToolResult).content[0].text;

    expect(text).toMatch(/not registered on the running Manager/i);
    expect(text).toMatch(/rather than an auth failure/i);
  });

  it("names the host restart, including the RunPod cycle, and warns about billing", async () => {
    const { ctx } = makeCtx(NO_ENDPOINT_REPLY);
    const text = ((await restartTool().handler({}, ctx)) as ToolResult).content[0].text;

    expect(text).toMatch(/restart the HOST/i);
    // The note travels inside a JSON envelope, so its quotes arrive ESCAPED —
    // a regex written around bare quotes never matches (it did not, first try).
    expect(text).toMatch(/runpod \(action:\\?"stop\\?"\)/);
    expect(text).toMatch(/runpod \(action:\\?"start\\?"\)/);
    expect(text).toMatch(/billing/i);
  });

  it("tells the caller not to report the new nodes as ready", async () => {
    // The reporter's actual loss: they believed the install had taken effect.
    const { ctx } = makeCtx(NO_ENDPOINT_REPLY);
    const text = ((await restartTool().handler({}, ctx)) as ToolResult).content[0].text;

    expect(text).toMatch(/stays unavailable until the ComfyUI process itself restarts/i);
    expect(text).toMatch(/Do NOT report the newly installed nodes as ready/);
  });

  it("still does NOT cycle the pod itself", async () => {
    // stop/resume bills, interrupts everything else on the box, and on a spot
    // instance may not come back. That is the user's call, not a side effect of
    // asking to restart ComfyUI.
    const { ctx } = makeCtx(NO_ENDPOINT_REPLY);
    await restartTool().handler({}, ctx);

    expect(hoisted.restart).not.toHaveBeenCalled();
  });
});

// panel#654 — `panel_tab_reconnected:false` was emitted for a reconnect that was
// never watched. `awaitPostRestartReachable` opens with `if (before == null)
// return false`, and `before` is undefined whenever the panel advertised no tab
// session id, the socket was not OPEN at capture time, or the tab did not
// resolve. The reporter's output is reproducible with the panel never failing.
//
// These live here because this file already owns the scaffolding that reaches a
// restart REPLY. A pure-function assertion cannot show the gate held: routing
// `ready` through the classification left the whole suite green when measured.
describe("#654 an unwatched reconnect is reported as unknown, and is still not ready", () => {
  it("no pre-restart baseline ⇒ panel_tab_reconnected:'unknown', ready stays false", async () => {
    const { ctx } = makeCtx(NO_ENDPOINT_REPLY);
    ctx.panelConnectionIdentity = () => undefined; // panel advertised no tab session id
    ctx.awaitPostRestartReachable = async () => false; // and so nothing is watched
    ctx.tabCanMutateGraph = () => true; // isolate: capability is NOT the reason

    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    const out = JSON.parse(res.content.find((c) => c.type === "text")!.text as string);

    expect(out.server_ready).toBe(true);
    expect(out.panel_tab_reconnected).toBe("unknown"); // not a bare false
    // THE GATE. Unknown must never buy readiness — this is the assertion that
    // catches `ready: graphToolsReady || tabReconnect === "unknown"`.
    expect(out.ready).toBe(false);
    expect(out.graph_tools_ready).toBe(false);
    expect(String(out.note)).toMatch(/could NOT be determined/);
    // …and it must not narrate a cause nobody observed.
    expect(String(out.note)).toMatch(/WHY is not/);
  });

  it("a WATCHED reconnect that did not return is still a real false", async () => {
    const { ctx } = makeCtx(NO_ENDPOINT_REPLY);
    ctx.panelConnectionIdentity = () => ({ generation: 1, tabSessionId: "browser-tab-a" });
    ctx.awaitPostRestartReachable = async () => false;
    ctx.tabCanMutateGraph = () => true;

    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    const out = JSON.parse(res.content.find((c) => c.type === "text")!.text as string);

    expect(out.panel_tab_reconnected).toBe(false); // the honest negative survives
    expect(out.ready).toBe(false);
    expect(String(out.note)).not.toMatch(/could NOT be determined/);
  });
});
