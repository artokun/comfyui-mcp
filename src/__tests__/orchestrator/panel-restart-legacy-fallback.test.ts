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

// #1904 live-probe gate: nothing here may open a REAL WebSocket. The branch
// under test stubs restartComfyUI itself, so the witness is never reached —
// pin that by stubbing the acquisition outright.
vi.mock("../../services/instance-witness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/instance-witness.js")>()),
  acquireInstanceWitness: async () => undefined,
}));

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

// #1996 — the headless path carried the SAME coupling the bound path did:
//
//   const tabBack = recovery.ready ? await ctx.awaitPostRestartReachable(…) : false;
//
// so a kill+relaunch whose cold start outran the observation window never looked at
// the tab, and then reported a bare `false` about it. The bound path's version of this
// is covered behaviourally in panel-restart-slow-boot-reconnect.test.ts; this file owns
// the scaffolding that reaches the HEADLESS reply, so its half lives here.
describe("#1996 an unconfirmed managed restart still watches for the tab", () => {
  it("watches the tab even when OUR observation never certified the cycle", async () => {
    // The endpoint never goes down, so the managed restart is honestly
    // couldn't-confirm — and the tab is watched anyway.
    __panelToolsTestHooks.setHealthProbe(async () => "healthy");
    const { ctx } = makeCtx(NO_ENDPOINT_REPLY);
    let watched = 0;
    ctx.panelConnectionIdentity = () => ({ generation: 1, tabSessionId: "browser-tab-a" });
    ctx.awaitPostRestartReachable = async () => {
      watched++;
      return true;
    };
    ctx.tabCanMutateGraph = () => true;

    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    const out = JSON.parse(res.content.find((c) => c.type === "text")!.text as string);

    expect(watched).toBe(1); // 0 before the fix — the wait was never entered
    expect(out.panel_tab_reconnected).toBe(true);
    // AND THE REFUSAL IS INTACT. A reconnected browser socket is not a booted
    // ComfyUI: `ready` must stay false or this fix has manufactured a success.
    expect(out.server_ready).toBe(false);
    expect(out.confirmed_cycle).toBe(false);
    expect(out.ready).toBe(false);
    expect(out.graph_tools_ready).toBe(false);
    expect(String(out.note)).toMatch(/did NOT become healthy within/);
  });

  it("a watched tab that did not come back is a real false here too", async () => {
    __panelToolsTestHooks.setHealthProbe(async () => "healthy");
    const { ctx } = makeCtx(NO_ENDPOINT_REPLY);
    ctx.panelConnectionIdentity = () => ({ generation: 1, tabSessionId: "browser-tab-a" });
    ctx.awaitPostRestartReachable = async () => false;
    ctx.tabCanMutateGraph = () => true;

    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    const out = JSON.parse(res.content.find((c) => c.type === "text")!.text as string);

    expect(out.panel_tab_reconnected).toBe(false);
    expect(out.ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #1996 review round 1 (codex P1) — the reserve did not follow to THIS path.
//
// The bound path's readiness deadline is clamped by
// `readinessDeadlineWithReconnectReserve` so the observation cannot eat the tab
// reconnect wait. The headless/legacy path computed its own deadline as
//
//   const proofDeadline = Math.min(Date.now() + legacyProofWindow, overallDeadline);
//
// with no reserve — so the identical starvation survives here. The arithmetic,
// from the file's own constants: OVERALL_MAX_MS 255s, legacyProofWindow 140s
// (LEGACY_SYNC_WORST_CASE_MS 40s + LEGACY_COLD_START_OBS_MS 100s), reconnect
// wait 35s. A confirmation answered at ~90s leaves 165s, the admission gate
// (>=140s) lets the restart run, the proof window claims 140 of those 165, and
// the tab wait is handed the 25s residual — LESS than the 35s a tab is allowed.
// A tab that re-registers at 30s is then reported `panel_tab_reconnected:false`.
//
// REACHABILITY is not hypothetical. Of the three callers of
// runHeadlessManagedRestart, the #1671 crash-recovery one is entered precisely
// BECAUSE the confirmation card went unanswered — which costs the full
// RESTART_CONFIRM_TIMEOUT_MS (90s) plus the ~6s decline probe before this path
// even starts. The 90s in this test is the cheap case, not the worst one.
//
// HOW THIS RUNS FAST. Only `Date` is faked; timers stay real. The confirmation
// advances the clock 90s, and each health probe advances it 20s, so the 140s
// proof window is consumed in ~7 probes and ~1.4s of wall clock. Nothing here
// re-implements the production arithmetic — the handler computes its own
// deadlines from its own constants, and the test only observes the budget the
// reconnect wait is actually handed.
describe("#1996 r1 (codex P1): the headless path must reserve the reconnect wait too", () => {
  // The harness's virtual clock advances in discrete PROBE_STEP_MS jumps, so the
  // observation always overshoots its deadline by up to one step before noticing.
  // In production that overshoot is one real probe interval (200ms) and is
  // invisible; here it is the resolution limit of the measurement, so it is named
  // and subtracted rather than absorbed into a looser number. 5s keeps it well
  // clear of the 10s that separates the fixed residual from the broken one.
  const PROBE_STEP_MS = 5_000;

  /** Drive the headless path with `elapsedBeforeMs` already burned on the card,
   *  and report the budget the tab-reconnect wait was actually handed. */
  async function runWithSlowConfirm(elapsedBeforeMs: number, tabReturnsAfterMs: number) {
    const prevInterval = process.env.COMFYUI_PANEL_REBOOT_INTERVAL_S;
    vi.useFakeTimers({ toFake: ["Date"] });
    __panelToolsTestHooks.setPanelRebootTiming(null); // REAL 140s legacy proof window
    // Shrink only the REAL sleep between probes (floored at 50ms by observeRecovery);
    // the virtual clock still advances PROBE_STEP_MS per probe, so the full 140s
    // window is consumed in ~28 probes and ~1.4s of wall clock.
    process.env.COMFYUI_PANEL_REBOOT_INTERVAL_S = "0.01";
    try {
      // The endpoint never comes back, so the proof window runs to its deadline —
      // the case where the residual handed to the tab wait is smallest.
      __panelToolsTestHooks.setHealthProbe(async () => {
        vi.setSystemTime(Date.now() + PROBE_STEP_MS);
        return "down";
      });
      const { ctx } = makeCtx(NO_ENDPOINT_REPLY);
      ctx.confirm = (async () => {
        vi.setSystemTime(Date.now() + elapsedBeforeMs);
        return "yes" as const;
      }) as PanelToolCtx["confirm"];
      ctx.panelConnectionIdentity = () => ({ generation: 1, tabSessionId: "browser-tab-a" });
      let handedBudgetMs = -1;
      // A perfectly ordinary tab: it re-registers `tabReturnsAfterMs` after being
      // asked for, and comes back if — and only if — it is given that long.
      ctx.awaitPostRestartReachable = async (_before, budgetMs?: number) => {
        handedBudgetMs = budgetMs ?? 0;
        return handedBudgetMs >= tabReturnsAfterMs;
      };
      ctx.tabCanMutateGraph = () => true;

      const res = (await restartTool().handler({}, ctx)) as ToolResult;
      const out = JSON.parse(res.content.find((c) => c.type === "text")!.text as string);
      return { handedBudgetMs, out };
    } finally {
      vi.useRealTimers();
      if (prevInterval === undefined) delete process.env.COMFYUI_PANEL_REBOOT_INTERVAL_S;
      else process.env.COMFYUI_PANEL_REBOOT_INTERVAL_S = prevInterval;
    }
  }

  it("a confirmation answered at ~90s must NOT starve the tab wait below its own budget", async () => {
    // 255s overall − 90s on the card = 165s left. The admission gate (≥140s) lets the
    // restart run, and pre-fix the 140s proof window claimed all but ~25 of those.
    const allowed = __panelToolsTestHooks.getReconnectWaitTiming().budgetMs; // 35s
    const { handedBudgetMs, out } = await runWithSlowConfirm(90_000, 28_000);

    // THE DEFECT, as the observation rather than the arithmetic: the wait is handed
    // less than a tab is allowed to take. Pre-fix ~20–25s here; the reserve makes it
    // the full budget, less one step of the harness's own clock resolution.
    expect(handedBudgetMs).toBeGreaterThanOrEqual(allowed - PROBE_STEP_MS);
    // …and the consequence that makes it a P1 rather than a rounding error: a tab
    // that came back normally, at 28s, is no longer reported as never having come
    // back. 28s is outside the pre-fix residual and inside the post-fix one, so this
    // separates the two behaviours rather than restating the number above.
    expect(out.panel_tab_reconnected).toBe(true);
    // The refusal is untouched — the endpoint genuinely never answered.
    expect(out.server_ready).toBe(false);
    expect(out.ready).toBe(false);
  });

  it("the #1671 caller's own timings — an UNANSWERED card — keep the tab wait whole too", async () => {
    // Reachability is not hypothetical. runHeadlessManagedRestart's #1671 caller is
    // entered BECAUSE the confirmation card went unanswered, which costs the full
    // RESTART_CONFIRM_TIMEOUT_MS (90s) plus the ~6s decline probe. Modelling that
    // 96s here (through the same no-endpoint route, which shares the code under
    // test) leaves 159s — still admitted, and pre-fix the residual was ~19s.
    const allowed = __panelToolsTestHooks.getReconnectWaitTiming().budgetMs;
    const { handedBudgetMs, out } = await runWithSlowConfirm(96_000, 28_000);

    expect(handedBudgetMs).toBeGreaterThanOrEqual(allowed - PROBE_STEP_MS);
    expect(out.panel_tab_reconnected).toBe(true);
  });
});
