// #742: panel_restart_comfyui must NEVER report "Cancelled — ComfyUI was not
// restarted" while the server is actually DOWN (a stop already happened — e.g. a
// reboot accepted moments earlier in the same turn stopped ComfyUI, the panel tab
// died with it, and the confirm card then failed into a catch-all "no"). And on a
// Pinokio-style install (externally supervised; no main.py/interpreter resolvable
// from here, so NO provable relaunch) the restart must be REFUSED before anything
// is stopped — a plain Manager restart kills the process and the supervisor does
// not re-launch it, which is exactly the #742 lost-server.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resetClient = vi.fn();
const resetObjectInfoCache = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: () => resetClient(),
  resetObjectInfoCache: () => resetObjectInfoCache(),
}));

// r9/r10/r11: a MUTABLE runtime-config base AND target generation, so tests
// can retarget getComfyUIBaseUrl() mid-flight (config-only retarget) while the
// tab fronting stays put. null → the real configured base; the generation is
// bumped by tests the way every real retarget bumps it.
const hoistedConfig = vi.hoisted(() => ({
  configBase: { value: null as string | null },
  generation: { value: 0 },
  /** #814: drive REMOTE mode, the one target shape the widened preflight gate
   *  deliberately excludes (no local process to assess). */
  remote: { value: false },
}));
vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    getComfyUIBaseUrl: () => hoistedConfig.configBase.value ?? actual.getComfyUIBaseUrl(),
    getComfyuiTargetGeneration: () => hoistedConfig.generation.value,
    isRemoteMode: () => hoistedConfig.remote.value || actual.isRemoteMode(),
  };
});

const { buildPanelToolDefs, makePanelToolCtx, __panelToolsTestHooks } = await import(
  "../../orchestrator/panel-tools.js"
);
import { getBootLocalComfyUIBaseUrl } from "../../config.js";
import {
  __processControlTestHooks,
  getRestartDispatchRecord,
  PROCESS_WIDE_RESTART_DISPATCH_TOKEN,
} from "../../services/process-control.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

// The orchestrator's immutable boot endpoint — what the decline-probe and the
// refuse-safe preflight bind to when the tab provably fronts our boot instance.
const BOOT_BASE = (getBootLocalComfyUIBaseUrl() ?? "http://127.0.0.1:8188").replace(/\/+$/, "");

const text = (res: ToolResult): string =>
  res.content.find((c) => c.type === "text")!.text as string;
const parse = (res: ToolResult): Record<string, unknown> => JSON.parse(text(res));

function makeCtx(opts: {
  /** #1332 — "unreachable" is the fourth outcome: the card could not be put to the
   *  user, or its answer could not be retrieved. It reaches the same decline branch. */
  confirm: "yes" | "no" | "unreachable";
  /** Whether the bound tab provably fronts our local boot instance (the gate
   *  for both the boot-endpoint probe and the #742 preflight). */
  frontsBoot?: boolean;
  /** MUTABLE fronting — models a session that REBINDS mid-test: the bridge
   *  getters read `fronts.current` at call time. Overrides frontsBoot. */
  fronts?: { current: boolean };
  /** The comfy_reboot reply (default: an accepted `{rebooting: true}`). */
  rebootReply?: Record<string, unknown>;
  /** Called on every ctx.ensureReachable() — lets a test land a retarget at a
   *  specific point in the handler (the DISPATCH point is the third call). */
  onEnsureReachable?: () => void;
  /** #1593 — the SERVER-OBSERVED handshake Origin, overridden independently of
   *  `frontsBoot`. The two are separable in reality and the distinction is the
   *  whole point: a tab can be unbindable (so the restart is refused) while its
   *  origin is a perfectly concrete address that PROVES it is a different server
   *  from the configured one. Without this the fixture can only produce the
   *  "unproven" verdict, and the branch that matters is unreachable. */
  serverOrigin?: string;
}): { ctx: PanelToolCtx; sends: Array<Record<string, unknown>> } {
  const sends: Array<Record<string, unknown>> = [];
  const frontsBoot = opts.frontsBoot ?? true;
  const rebootReply = opts.rebootReply ?? { rebooting: true };
  const fronted = () => opts.fronts?.current ?? frontsBoot;
  const bridge = {
    send: async (cmd: Record<string, unknown>) => {
      sends.push(cmd);
      if (cmd.cmd === "comfy_reboot") return rebootReply;
      return {};
    },
    tabOrigin: () => (fronted() ? BOOT_BASE : undefined),
    // The gate reads the SERVER-OBSERVED handshake origin, not the spoofable hello URL.
    tabServerOrigin: () => opts.serverOrigin ?? (fronted() ? BOOT_BASE : undefined),
    tabIsLocal: () => fronted(),
    canReach: () => true,
  } as unknown as PanelToolCtx["bridge"];
  const ctx = {
    call: async () => {
      throw new Error("ctx.call must not be used by the restart handler");
    },
    confirm: async () => opts.confirm,
    ensureReachable: () => opts.onEnsureReachable?.(),
    bridge,
    tabId: "bound-tab",
    panelConnectionIdentity: () => ({ generation: 1, tabSessionId: "browser-tab-a" }),
    awaitPostRestartReachable: async () => true,
    tabCanMutateGraph: () => true,
  } as unknown as PanelToolCtx;
  return { ctx, sends };
}

function restartTool() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_restart_comfyui");
  if (!def) throw new Error("panel_restart_comfyui not found");
  return def;
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
  // Fast decline-probe recheck window (the real one is ~6s). Wide enough that
  // real-timer slop can't eat it before a scripted mid-window sample lands.
  __panelToolsTestHooks.setDeclineProbeTiming({
    windowMs: 100,
    intervalMs: 5,
    probeTimeoutMs: 5,
  });
  // Default: the local relaunch preflight PASSES (the live preflightLocalRestart
  // would probe real processes/ports). The refusal tests override it.
  __panelToolsTestHooks.setLocalRestartPreflight(async () => ({ ok: true }));
  // r4/r5: no restart dispatch on record unless a test seeds one (also clears
  // any record a prior test left behind).
  __processControlTestHooks.reset();
  // r9: real configured base unless a test retargets it mid-flight.
  hoistedConfig.configBase.value = null;
  hoistedConfig.generation.value = 0;
  hoistedConfig.remote.value = false;
});

afterEach(() => {
  __panelToolsTestHooks.setPanelRebootTiming(null);
  __panelToolsTestHooks.setHealthProbe(null);
  __panelToolsTestHooks.setLocalRestartPreflight(null);
  __panelToolsTestHooks.setDeclineProbeTiming(null);
  __processControlTestHooks.reset();
  hoistedConfig.configBase.value = null;
  hoistedConfig.generation.value = 0;
  hoistedConfig.remote.value = false;
});

describe("panel_restart_comfyui — decline truthfulness (#742)", () => {
  it("a decline while the server is PERSISTENTLY down reports the lost server — never 'Cancelled'", async () => {
    // The confirm resolved "no" (a decline, OR the card failed into the catch-all
    // "no" because the tab died with the server). The endpoint stays refused for
    // the WHOLE recheck window — only then may the report call it lost (a single
    // ECONNREFUSED is just a normal restart down-window, codex gate). A restart
    // dispatch IS on record (r4), so the report names the causation.
    let probes = 0;
    __panelToolsTestHooks.setHealthProbe(async () => {
      probes++;
      return "down";
    });
    const { ctx, sends } = makeCtx({ confirm: "no" });
    // r4/r5: a restart dispatch IS on record HELD BY THIS SESSION, so the
    // report names the causation.
    __panelToolsTestHooks.seedSessionRestartDispatch(ctx, { at: Date.now(), base: BOOT_BASE });

    const res = await restartTool().handler({}, ctx);
    const t = text(res);

    expect(res.isError).toBeFalsy();
    expect(t).not.toMatch(/^Cancelled/);
    expect(t).not.toMatch(/was not restarted/i);
    expect(t).toMatch(/ComfyUI is DOWN/i);
    expect(t).toMatch(/STOPPED and did not come back/i);
    expect(t).toMatch(/recheck window/i);
    expect(t).toMatch(/start ComfyUI manually/i);
    expect(t).toMatch(/Pinokio/i);
    // NOT a single-probe verdict: the window rechecked before declaring loss.
    expect(probes).toBeGreaterThan(1);
    // Nothing was dispatched after the decline — the report is about PRIOR state.
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("bound full-window DOWN with NO recorded dispatch makes NO causation claim (r4)", async () => {
    // An unrelated crash / manual stop: nothing is on record, so the DOWN
    // report must be causation-free — never blame a restart that isn't
    // provably on record.
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx, sends } = makeCtx({ confirm: "no" });

    const res = await restartTool().handler({}, ctx);
    const t = text(res);

    expect(res.isError).toBeFalsy();
    expect(t).toMatch(/ComfyUI is DOWN/i);
    expect(t).toMatch(/still unreachable after/i);
    expect(t).toMatch(/no restart was dispatched/i);
    expect(t).not.toMatch(/restart initiated earlier/i);
    expect(t).not.toMatch(/was NOT what stopped it/i);
    expect(t).not.toMatch(/STOPPED and did not come back/i);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("bound full-window DOWN with a STALE recorded dispatch makes NO causation claim (r4)", async () => {
    // A dispatch older than the causation window can't explain the current
    // down state — the report stays causation-free.
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx, sends } = makeCtx({ confirm: "no" });
    __panelToolsTestHooks.seedSessionRestartDispatch(ctx, {
      at: Date.now() - 11 * 60_000, // beyond the 10-minute causation window
      base: BOOT_BASE,
    });

    const res = await restartTool().handler({}, ctx);
    const t = text(res);

    expect(res.isError).toBeFalsy();
    expect(t).toMatch(/ComfyUI is DOWN/i);
    expect(t).toMatch(/no restart was dispatched/i);
    expect(t).not.toMatch(/restart initiated earlier/i);
    expect(t).not.toMatch(/STOPPED and did not come back/i);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("bound full-window DOWN with a dispatch recorded for a DIFFERENT instance makes NO causation claim (r4)", async () => {
    // The record must target the SAME instance the decline probed — a restart
    // of some other ComfyUI explains nothing here.
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx, sends } = makeCtx({ confirm: "no" });
    __panelToolsTestHooks.seedSessionRestartDispatch(ctx, {
      at: Date.now(),
      base: "http://127.0.0.1:9999",
    });

    const res = await restartTool().handler({}, ctx);
    const t = text(res);

    expect(res.isError).toBeFalsy();
    expect(t).toMatch(/ComfyUI is DOWN/i);
    expect(t).toMatch(/no restart was dispatched/i);
    expect(t).not.toMatch(/restart initiated earlier/i);
    expect(t).not.toMatch(/STOPPED and did not come back/i);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("a dispatch recorded by ANOTHER SESSION never grounds causation here (r5)", async () => {
    // Two sessions (two ctx objects): session A dispatched the failed restart.
    // Session B's decline over the SAME base must report causation-FREE…
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx: ctxA } = makeCtx({ confirm: "no" });
    const { ctx: ctxB, sends: sendsB } = makeCtx({ confirm: "no" });
    __panelToolsTestHooks.seedSessionRestartDispatch(ctxA, { at: Date.now(), base: BOOT_BASE });

    const resB = await restartTool().handler({}, ctxB);
    const tB = text(resB);

    expect(tB).toMatch(/ComfyUI is DOWN/i);
    expect(tB).toMatch(/no restart was dispatched/i);
    expect(tB).not.toMatch(/restart initiated earlier/i);
    expect(tB).not.toMatch(/STOPPED and did not come back/i);
    expect(sendsB.some((c) => c.cmd === "comfy_reboot")).toBe(false);

    // …while session A's OWN decline over the same base MAY name it.
    const resA = await restartTool().handler({}, ctxA);
    const tA = text(resA);

    expect(tA).toMatch(/ComfyUI is DOWN/i);
    expect(tA).toMatch(/STOPPED and did not come back/i);
    expect(tA).toMatch(/restart initiated earlier/i);
  });

  it("a healthy/recovered decline probe CLEARS the dispatch token — a later independent failure is causation-FREE (r13)", async () => {
    const { ctx } = makeCtx({ confirm: "no" });

    // 1. Healthy FIRST SAMPLE exonerates the recorded dispatch immediately.
    __panelToolsTestHooks.seedSessionRestartDispatch(ctx, { at: Date.now(), base: BOOT_BASE });
    __panelToolsTestHooks.setHealthProbe(async () => "healthy");
    await restartTool().handler({}, ctx);
    expect(__panelToolsTestHooks.getSessionRestartDispatch(ctx)).toBeNull();

    // 2. RECOVERED-in-window (down then healthy) exonerates it too.
    __panelToolsTestHooks.seedSessionRestartDispatch(ctx, { at: Date.now(), base: BOOT_BASE });
    const seq: Array<"down" | "healthy"> = ["down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(i++, seq.length - 1)]);
    const res2 = await restartTool().handler({}, ctx);
    expect(text(res2)).toMatch(/healthy again/i); // the recovery WAS reported
    expect(__panelToolsTestHooks.getSessionRestartDispatch(ctx)).toBeNull();

    // 3. The server now fails INDEPENDENTLY (full-window down): with the
    // dispatch exonerated, the report must be causation-FREE — never "a
    // restart initiated earlier took it down" for a restart that recovered.
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const res3 = await restartTool().handler({}, ctx);
    const t3 = text(res3);
    expect(t3).toMatch(/ComfyUI is DOWN/i);
    expect(t3).toMatch(/no restart was dispatched/i);
    expect(t3).not.toMatch(/restart initiated earlier/i);
    expect(t3).not.toMatch(/STOPPED and did not come back/i);
  });

  it("#1332: an UNREACHABLE card does not claim ComfyUI was not restarted", async () => {
    // The reporter accepted the restart, ComfyUI restarted (a fresh startup line in
    // their server log), and this tool answered "Cancelled — ComfyUI was not
    // restarted." The restart is what dropped the socket its own confirmation had to
    // travel back on, and that transport failure used to arrive here as a decline.
    //
    // The server is HEALTHY throughout, which is the case the probes above cannot
    // distinguish: "nothing happened" and "it restarted and came back" look identical
    // from here. With an explicit decline we know which. Without one we do not.
    __panelToolsTestHooks.setHealthProbe(async () => "healthy");
    const { ctx, sends } = makeCtx({ confirm: "unreachable" });

    const t = text(await restartTool().handler({}, ctx));

    expect(t).not.toContain("Cancelled — ComfyUI was not restarted.");
    expect(t).toMatch(/did NOT dispatch a restart/);
    expect(t).toMatch(/could not be reached to ask/);
    expect(t).toMatch(/no decision was made either way/);
    expect(t).toMatch(/fresh startup line/);
    // Still nothing dispatched — the safe behaviour is untouched.
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("#1332: an EXPLICIT decline still says Cancelled — the truth is kept", async () => {
    // The fix must not blur a real decision into hedging: when the user says no,
    // "ComfyUI was not restarted" is an observation, not a guess.
    __panelToolsTestHooks.setHealthProbe(async () => "healthy");
    const { ctx, sends } = makeCtx({ confirm: "no" });

    const t = text(await restartTool().handler({}, ctx));

    expect(t).toContain("Cancelled — ComfyUI was not restarted.");
    expect(t).not.toMatch(/could not be reached to ask/);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("a decline with the server down-then-HEALTHY inside the window does NOT declare a loss", async () => {
    // A genuinely restarting server is refused during its normal down window
    // (codex gate High #1): a recovery inside the recheck window must NOT be
    // reported as a lost server — the truthful outcome is "it came back".
    const seq: Array<"down" | "healthy"> = ["down", "down", "healthy"];
    let probes = 0;
    __panelToolsTestHooks.setHealthProbe(async () => {
      const s = seq[Math.min(probes, seq.length - 1)];
      probes++;
      return s;
    });
    const { ctx, sends } = makeCtx({ confirm: "no" });

    const res = await restartTool().handler({}, ctx);
    const t = text(res);

    expect(res.isError).toBeFalsy();
    expect(t).not.toMatch(/ComfyUI is DOWN/i);
    expect(t).not.toMatch(/did not come back/i);
    expect(t).not.toMatch(/start ComfyUI manually/i);
    expect(t).toMatch(/^Cancelled — no new restart was dispatched/);
    expect(t).toMatch(/healthy again/i);
    // r14: with NO dispatch on record, the recovery note is CAUSATION-FREE —
    // it must not credit an earlier restart that isn't provably on record.
    expect(t).not.toMatch(/restart initiated earlier/i);
    // It kept polling past the first refused sample instead of declaring loss.
    expect(probes).toBe(3);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("a down-then-HEALTHY recovery names the causation ONLY with a fresh session-held dispatch (r14)", async () => {
    const seq: Array<"down" | "healthy"> = ["down", "healthy"];
    let probes = 0;
    __panelToolsTestHooks.setHealthProbe(async () => {
      const s = seq[Math.min(probes, seq.length - 1)];
      probes++;
      return s;
    });
    const { ctx, sends } = makeCtx({ confirm: "no" });
    __panelToolsTestHooks.seedSessionRestartDispatch(ctx, { at: Date.now(), base: BOOT_BASE });

    const res = await restartTool().handler({}, ctx);
    const t = text(res);

    expect(t).toMatch(/^Cancelled — no new restart was dispatched/);
    expect(t).toMatch(/healthy again/i);
    expect(t).toMatch(/restart initiated earlier/i);
    // The observed recovery exonerates the dispatch either way (r13): the
    // token is cleared even though the note named it.
    expect(__panelToolsTestHooks.getSessionRestartDispatch(ctx)).toBeNull();
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("a decline with a HEALTHY server keeps the plain cancel line (one probe, no stall)", async () => {
    let probes = 0;
    __panelToolsTestHooks.setHealthProbe(async () => {
      probes++;
      return "healthy";
    });
    const { ctx, sends } = makeCtx({ confirm: "no" });

    const res = await restartTool().handler({}, ctx);

    expect(text(res)).toBe("Cancelled — ComfyUI was not restarted.");
    expect(probes).toBe(1); // healthy on the first sample → no recheck window
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("a decline with an UNVERIFIABLE server keeps the plain cancel line (never alarmist)", async () => {
    // "unknown" (a transient 5xx / timeout / ambiguous error) is NOT a proven
    // down — only ECONNREFUSED at the END of the window flips the report.
    __panelToolsTestHooks.setHealthProbe(async () => "unknown");
    const { ctx, sends } = makeCtx({ confirm: "no" });

    const res = await restartTool().handler({}, ctx);

    expect(text(res)).toBe("Cancelled — ComfyUI was not restarted.");
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("an UNBOUND probe target is refused BEFORE the card, so a decline never claims causation (#1819)", async () => {
    // Used to show the card, take a "no", then probe the configured endpoint
    // and talk about whether it was down. That is the reporter's sequence:
    // ask first, then refuse identity. A live unbindable tab is now refused
    // without asking, so the decline probe — and any causation it could mint —
    // never runs.
    let probes = 0;
    __panelToolsTestHooks.setHealthProbe(async () => {
      probes++;
      return "down";
    });
    let confirmCalled = false;
    const { ctx, sends } = makeCtx({ confirm: "no", frontsBoot: false });
    ctx.confirm = async () => {
      confirmCalled = true;
      return "no";
    };

    const res = await restartTool().handler({}, ctx);
    const out = parse(res);

    expect(res.isError).toBeFalsy();
    expect(confirmCalled).toBe(false);
    expect(out.refused).toBe(true);
    expect(out.rebooting).toBe(false);
    expect(String(out.note)).not.toMatch(/restart initiated earlier/i);
    expect(String(out.note)).not.toMatch(/STOPPED and did not come back/i);
    expect(String(out.note)).not.toMatch(/was NOT what stopped it/i);
    expect(probes).toBe(0);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("an UNBOUND probe target that would have recovered is still refused without asking (#1819)", async () => {
    let probes = 0;
    __panelToolsTestHooks.setHealthProbe(async () => {
      probes++;
      return "healthy";
    });
    let confirmCalled = false;
    const { ctx, sends } = makeCtx({ confirm: "no", frontsBoot: false });
    ctx.confirm = async () => {
      confirmCalled = true;
      return "no";
    };

    const out = parse(await restartTool().handler({}, ctx));

    expect(confirmCalled).toBe(false);
    expect(out.refused).toBe(true);
    expect(probes).toBe(0);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("recheck loop NEVER starts an awaited probe after the hard deadline (codex gate r2)", async () => {
    // A long configured window but a deadline expiring mid-loop: the loop must
    // STOP at the deadline — the old code clamped the expired remainder to a
    // 1ms timeout and still awaited one more probe past it. Fake timers make
    // the exact probe-start instants deterministic.
    vi.useFakeTimers();
    try {
      const starts: number[] = [];
      __panelToolsTestHooks.setHealthProbe(async () => {
        starts.push(Date.now());
        return "down";
      });
      const t0 = Date.now();
      const pending = __panelToolsTestHooks.probeDeclineRecovery(
        null,
        5000, // windowMs — far beyond the deadline
        5, // intervalMs
        5, // probeTimeoutMs
        t0 + 20, // hard deadline at +20ms
      );
      await vi.advanceTimersByTimeAsync(10000);
      const out = await pending;

      // Samples at 0/5/10/15ms; at +20 the deadline is exhausted, so NO probe
      // may start there — the old code started (and awaited) one with a
      // clamped 1ms timeout.
      expect(starts.map((s) => s - t0)).toEqual([0, 5, 10, 15]);
      expect(out.attempts).toBe(4);
      // The elapsed time respects the deadline (nowhere near the 5000ms window).
      expect(out.waited_ms).toBeLessThanOrEqual(25);
      // r3: the deadline TRUNCATED the window — a truncated observation can't
      // prove permanence, so even an all-refused run is "ambiguous", NEVER
      // "down" (a lost-server report requires the FULL window).
      expect(out.status).toBe("ambiguous");
    } finally {
      vi.useRealTimers();
    }
  });

  it("recheck loop returns DOWN only when the FULL window ran with final refusal (r3)", async () => {
    // The window completes well before the deadline: every sample refused, so
    // the full-window observation DOES prove the server stayed down.
    vi.useFakeTimers();
    try {
      const starts: number[] = [];
      __panelToolsTestHooks.setHealthProbe(async () => {
        starts.push(Date.now());
        return "down";
      });
      const t0 = Date.now();
      const pending = __panelToolsTestHooks.probeDeclineRecovery(
        null,
        20, // windowMs — completes at +20ms…
        5,
        5,
        t0 + 10000, // …with the deadline far beyond it (no truncation)
      );
      await vi.advanceTimersByTimeAsync(1000);
      const out = await pending;

      // Samples at 0/5/10/15ms; the window's own end stops the loop (no probe
      // starts at +20 with an exhausted remainder).
      expect(starts.map((s) => s - t0)).toEqual([0, 5, 10, 15]);
      expect(out.attempts).toBe(4);
      expect(out.status).toBe("down"); // full-window refusal → provable loss
      expect(out.waited_ms).toBeLessThanOrEqual(25);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recheck loop with an ALREADY-EXPIRED deadline probes nothing and reports ambiguous", async () => {
    // No remaining budget at entry: not even the first probe may start — the
    // verdict is ambiguous, so the report keeps the plain/generic line.
    let probes = 0;
    __panelToolsTestHooks.setHealthProbe(async () => {
      probes++;
      return "down";
    });
    const t0 = Date.now();

    const out = await __panelToolsTestHooks.probeDeclineRecovery(null, 5000, 5, 5, t0 - 1);

    expect(probes).toBe(0);
    expect(out.attempts).toBe(0);
    expect(out.status).toBe("ambiguous");
  });
});

describe("panel_restart_comfyui — Pinokio-style refuse-safe preflight (#742)", () => {
  it("REFUSES before any stop when the relaunch is not provable (Pinokio-shaped install)", async () => {
    // The running local ComfyUI is externally supervised and its main.py /
    // interpreter cannot be resolved from here — a Manager restart would kill it
    // and NOTHING would bring it back (the #742 report).
    __panelToolsTestHooks.setLocalRestartPreflight(async () => ({
      ok: false,
      reason:
        "Resolved ComfyUI script does not exist on disk: main.py — could not " +
        "locate the ComfyUI install.",
    }));
    const { ctx, sends } = makeCtx({ confirm: "yes" });

    const res = await restartTool().handler({}, ctx);
    const out = parse(res);

    expect(res.isError).toBeFalsy();
    expect(out.rebooting).toBe(false);
    expect(out.refused).toBe(true);
    expect(String(out.note)).toMatch(/refusing to restart/i);
    expect(String(out.note)).toMatch(/still running/i);
    expect(String(out.note)).toMatch(/Pinokio/i);
    // CRITICAL: the reboot was NEVER dispatched — no stop can have happened.
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
    // And the reboot caches were not dropped (no restart is in flight).
    expect(resetClient).not.toHaveBeenCalled();
    expect(resetObjectInfoCache).not.toHaveBeenCalled();
  });

  it("a failing preflight with a mid-await REBIND issues NO STALE-TARGET refusal (r8)", async () => {
    // Bound at the preflight decision; the session rebinds to an unconfirmable target
    // DURING the await and the preflight FAILS. r8's rule stands: the refusal must NOT
    // be composed against the STALE pre-await target — "ComfyUI is still running" would
    // describe an instance that was never validated, and the reason would name a
    // diagnosis belonging to a different install.
    //
    // What CHANGED is where the flow lands instead. It used to fall through to an
    // honest unbound dispatch; a local target we cannot identify is now refused at the
    // DISPATCH POINT (#814), so the outcome is a refusal about the CURRENT binding —
    // the panel connection changed — not about the stale one.
    const fronts = { current: true }; // bound when the preflight is decided…
    __panelToolsTestHooks.setLocalRestartPreflight(async () => {
      fronts.current = false; // …but a rebind lands DURING the preflight await
      return {
        ok: false,
        reason:
          "Resolved ComfyUI script does not exist on disk: main.py — could not " +
          "locate the ComfyUI install.",
      };
    });
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx, sends } = makeCtx({ confirm: "yes", fronts });

    const out = parse(await restartTool().handler({}, ctx));
    const note = String(out.note ?? "");

    // The r8 invariant: NOTHING from the stale assessment appears — not its reason,
    // and not a "still running" claim about an instance it never validated.
    expect(note).not.toMatch(/does not exist on disk/i);
    expect(note).not.toMatch(/still running/i);
    // The refusal is about the binding that actually applies now.
    expect(out.refused).toBe(true);
    expect(note).toMatch(/panel connection changed/i);
    // Same condition on this refusal: name the alternative and say why it works.
    expect(note).toMatch(/use restart_comfyui instead/i);
    expect(note).toMatch(/not tied to a browser tab/i);
    // CRITICAL: nothing was dispatched to the unidentified target.
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("a PASSING preflight retargeted mid-await to a SAFE install still does NOT dispatch (r10)", async () => {
    // The preflight returns ok — but the runtime config retargeted DURING its
    // await, so the pass may have validated a DIFFERENT (safe) install while
    // the tab still fronts the original instance. A pass for a different
    // install must never bless a stop of the tab-fronted one: its relaunch is
    // UNPROVEN → refuse, never dispatch.
    __panelToolsTestHooks.setLocalRestartPreflight(async () => {
      hoistedConfig.configBase.value = "http://127.0.0.1:9999"; // retarget mid-await
      hoistedConfig.generation.value += 1; // every real retarget bumps the generation
      return { ok: true }; // a pass — possibly for the WRONG install
    });
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx, sends } = makeCtx({ confirm: "yes", frontsBoot: true });

    const out = parse(await restartTool().handler({}, ctx));
    const note = String(out.note ?? "");

    expect(out.refused).toBe(true);
    expect(note).toMatch(/Refusing to restart/i);
    expect(note).toMatch(/still running/i);
    expect(note).toMatch(/settle/i);
    // CRITICAL: no stop/reboot is sent to the unproven tab-fronted instance.
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("an A→B→A retarget during the preflight await is detected by the generation, not the final base (r11)", async () => {
    // The config base RETURNS to its original value by the end of the await —
    // a final-state comparison sees "unchanged" and would accept the safe pass
    // for install B, then dispatch to the still-tab-fronted dangerous A. The
    // generation was bumped TWICE, so the mutation is caught and the restart
    // is refused.
    __panelToolsTestHooks.setLocalRestartPreflight(async () => {
      hoistedConfig.configBase.value = "http://127.0.0.1:9999"; // A → B
      hoistedConfig.generation.value += 1;
      hoistedConfig.configBase.value = null; // B → A (back to the original base)
      hoistedConfig.generation.value += 1;
      return { ok: true }; // a pass — for install B, not the tab-fronted A
    });
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx, sends } = makeCtx({ confirm: "yes", frontsBoot: true });

    const out = parse(await restartTool().handler({}, ctx));
    const note = String(out.note ?? "");

    expect(out.refused).toBe(true);
    expect(note).toMatch(/Refusing to restart/i);
    expect(note).toMatch(/still running/i);
    expect(note).toMatch(/settle/i);
    // CRITICAL: no stop/reboot is sent to the unproven tab-fronted instance.
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("#814: a LOCAL target the tab cannot be bound to is REFUSED, whatever the local check says", async () => {
    // THE #814 DEFECT, pinned — together with two wrong answers to it.
    //
    // Originally the safety check was gated on the same capture as the CERTIFICATION,
    // so an instance we could not certify was also never assessed: the reboot went out
    // with no evidence, the server stopped, nothing brought it back, and the result
    // honestly said it could not confirm the return.
    //
    // The first fix ran the local preflight anyway and let a PASS proceed. But the
    // assessment describes the orchestrator CONFIGURED instance while the reboot goes
    // to the bound TAB, so a safe local install could authorize stopping an orphaned
    // backend in some other tab. The second tried to keep only the FAIL half, which is
    // incoherent: if the configured target is a good enough proxy to refuse on, it is
    // good enough to proceed on.
    //
    // So an unbindable LOCAL target is refused outright — and the local assessment is
    // not consulted at all, because nothing it could say may be spent on a different
    // instance.
    const preflight = vi.fn(async () => ({ ok: true }));
    __panelToolsTestHooks.setLocalRestartPreflight(preflight);
    const { ctx, sends } = makeCtx({ confirm: "yes", frontsBoot: false });

    const out = parse(await restartTool().handler({}, ctx));

    expect(out.refused).toBe(true);
    expect(out.rebooting).toBe(false);
    expect(String(out.note)).toMatch(/cannot tell which server the restart would stop/i);
    // It reports what it DID — not a 'still running' claim about an instance it has
    // just said it cannot identify (the same rule r8 enforces for a stale target).
    expect(String(out.note)).toMatch(/nothing was stopped/i);
    // A user who loses this entry point is told which one still works AND why: the
    // refusal is a documented trade, not a dead end (coordinator ruling).
    expect(String(out.note)).toMatch(/use restart_comfyui instead/i);
    expect(String(out.note)).toMatch(/not tied to a browser tab/i);
    // A PASSING local assessment did not launder permission for a target it does not
    // describe — and was never even asked.
    expect(preflight).not.toHaveBeenCalled();
    // CRITICAL: nothing was dispatched, so nothing was stopped.
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("#1593: the refusal does NOT send you to restart_comfyui when it would hit a DIFFERENT server", async () => {
    // REACHABILITY, and the reason this issue is not just a wording change.
    //
    // #1593's reporter had a panel on :8189 while the orchestrator was configured
    // for another address. The refusal fired — correctly, it could not account for
    // that instance — and then told them to run restart_comfyui, which targets the
    // CONFIGURED address. That is #851's defect verbatim, in the branch #851 did
    // not cover: a call that recommends another tool without checking which machine
    // that tool points at. On a shared instance, restarting the wrong one is worse
    // than doing nothing.
    //
    // The tab is unbindable (so the refusal fires) but its server-observed Origin
    // is concrete and provably different — the exact shape that was previously
    // collapsed into "recommend it anyway".
    const preflight = vi.fn(async () => ({ ok: true }));
    __panelToolsTestHooks.setLocalRestartPreflight(preflight);
    const { ctx, sends } = makeCtx({
      confirm: "yes",
      frontsBoot: false,
      serverOrigin: "http://127.0.0.1:8189",
    });

    const out = parse(await restartTool().handler({}, ctx));
    const note = String(out.note ?? "");

    expect(out.refused).toBe(true);
    expect(note).toMatch(/cannot tell which server the restart would stop/i);
    // THE change: it warns instead of recommending, and names BOTH addresses so
    // the reader can see which two things failed to be shown equal.
    expect(note).toMatch(/Do NOT reach for restart_comfyui/);
    expect(note).toContain("http://127.0.0.1:8189");
    expect(note).toContain(BOOT_BASE);
    expect(note).not.toMatch(/USE restart_comfyui/);
    // Everything the #814 refusal guarantees is untouched.
    expect(preflight).not.toHaveBeenCalled();
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("#1593: a DNS-ambiguous localhost origin still gets the recommendation", async () => {
    // Absence of proof is not proof of difference (a coordinator P0 that
    // captureRebootHealthBase already honours). `localhost` can resolve to either
    // family, so warning here would send a user away from a tool that would very
    // likely have worked — the cry-wolf failure #1233 was filed for.
    __panelToolsTestHooks.setLocalRestartPreflight(vi.fn(async () => ({ ok: true })));
    const { ctx } = makeCtx({
      confirm: "yes",
      frontsBoot: false,
      serverOrigin: "http://localhost:8188",
    });

    const note = String(parse(await restartTool().handler({}, ctx)).note ?? "");

    expect(note).toMatch(/USE restart_comfyui/);
    expect(note).not.toMatch(/Do NOT reach for restart_comfyui/);
  });

  it("#814: a BOUND local target with a failing assessment refuses with its reason", async () => {
    // The bound path, where the assessment genuinely describes the instance the
    // reboot will reach. A Desktop instance whose supervisor has gone is refused
    // BEFORE anything is stopped, and the specific reason is carried through rather
    // than replaced by a generic one — a Desktop user must not be sent to look at
    // Pinokio's controls.
    const preflight = vi.fn(async () => ({
      ok: false,
      reason: "no Desktop app is still supervising it.",
    }));
    __panelToolsTestHooks.setLocalRestartPreflight(preflight);
    const { ctx, sends } = makeCtx({ confirm: "yes", frontsBoot: true });

    const out = parse(await restartTool().handler({}, ctx));

    expect(preflight).toHaveBeenCalled();
    expect(out.refused).toBe(true);
    expect(out.rebooting).toBe(false);
    expect(String(out.note)).toMatch(/no Desktop app is still supervising it/);
    expect(String(out.note)).toMatch(/still running/i);
    // CRITICAL: nothing was ever dispatched, so nothing was ever stopped.
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("a BOUND local target with a PASSING assessment dispatches as before", async () => {
    // The control: the refusals are about missing or negative evidence, not a
    // blanket denial. When the tab provably fronts our own instance and its
    // relaunch is proven, the restart proceeds exactly as it always did.
    const preflight = vi.fn(async () => ({ ok: true }));
    __panelToolsTestHooks.setLocalRestartPreflight(preflight);
    const { ctx, sends } = makeCtx({ confirm: "yes", frontsBoot: true });

    const out = parse(await restartTool().handler({}, ctx));

    expect(preflight).toHaveBeenCalled();
    expect(out.rebooting).toBe(true);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(true);
  });

  it("a retarget landing AFTER the preflight is caught at the dispatch point", async () => {
    // The dispatch-point check has to compare the tab's instance against the target
    // as it stands THEN. A retarget that lands after the preflight block leaves the
    // tab bound to the old base while the reboot would go to a different configured
    // instance — so a check that only asked "is the tab bound to something?" would
    // wave it through. `ensureReachable` is called at the dispatch point (third
    // call), which is where this lands the move.
    let calls = 0;
    const { ctx, sends } = makeCtx({
      confirm: "yes",
      frontsBoot: true,
      onEnsureReachable: () => {
        calls++;
        if (calls >= 3) {
          hoistedConfig.configBase.value = "http://127.0.0.1:9999";
          hoistedConfig.generation.value += 1;
        }
      },
    });

    const out = parse(await restartTool().handler({}, ctx));

    expect(out.refused).toBe(true);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("#1593: the DISPATCH-POINT refusal also stops recommending the wrong server", async () => {
    // THE SECOND CALL SITE, driven through the real handler. The test above proves
    // this branch is reached and refuses; it says nothing about what it then tells
    // the caller, and reverting this site to the old unconditional "USE
    // restart_comfyui INSTEAD" survives it — and survives the whole suite. So the
    // fix shipped one tested call site and one untested one.
    //
    // This is also the only path that reaches the "different" verdict with a
    // NON-NULL panelBase: the retarget moves the configured target to :9999 while
    // the tab stays provably on the boot instance, so both sides of the comparison
    // are concrete and proven. The preflight-site test reaches the same verdict by
    // the other limb (null base, concrete observed Origin).
    let calls = 0;
    const { ctx, sends } = makeCtx({
      confirm: "yes",
      frontsBoot: true,
      onEnsureReachable: () => {
        calls++;
        if (calls >= 3) {
          hoistedConfig.configBase.value = "http://127.0.0.1:9999";
          hoistedConfig.generation.value += 1;
        }
      },
    });

    const out = parse(await restartTool().handler({}, ctx));
    const note = String(out.note ?? "");

    expect(out.refused).toBe(true);
    expect(note).toMatch(/the panel connection changed while the restart was being prepared/i);
    // Sending this caller to restart_comfyui would aim it at :9999 — the target
    // that was just retargeted AWAY from the instance they are working in.
    expect(note).toMatch(/Do NOT reach for restart_comfyui/);
    expect(note).not.toMatch(/USE restart_comfyui/);
    // Both addresses named, so the reader can see which two failed to match.
    expect(note).toContain("http://127.0.0.1:9999");
    expect(note).toContain(BOOT_BASE);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("a REMOTE target is not assessed — the Manager reboot is its only restart path", async () => {
    // There is no local process to assess, and a supervised remote (the tunnelled
    // Desktop app) restarts through exactly this reboot by design. Refusing here
    // would remove a path that works, which is the opposite of the point.
    hoistedConfig.remote.value = true;
    const preflight = vi.fn(async () => ({ ok: false, reason: "would refuse" }));
    __panelToolsTestHooks.setLocalRestartPreflight(preflight);
    const { ctx, sends } = makeCtx({ confirm: "yes", frontsBoot: false });

    const out = parse(await restartTool().handler({}, ctx));

    expect(preflight).not.toHaveBeenCalled();
    expect(out.rebooting).toBe(true);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(true);
  });

  it("a normal local restart still proceeds when the preflight passes", async () => {
    const seq: Array<"down" | "healthy"> = ["down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(i++, seq.length - 1)]);
    const { ctx, sends } = makeCtx({ confirm: "yes" });

    const out = parse(await restartTool().handler({}, ctx));

    expect(out.rebooting).toBe(true);
    expect(out.ready).toBe(true);
    expect(out.confirmed_cycle).toBe(true);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(true);
    // r4/r5: the dispatch was recorded on acceptance AND cleared when the
    // restart was observed back — a completed restart explains no later down.
    expect(__panelToolsTestHooks.getSessionRestartDispatch(ctx)).toBeNull();
  });
});

describe("panel_restart_comfyui — identity is resolved BEFORE the confirmation card (#1819)", () => {
  // The reporter: first call timed out at 90s ("did NOT restart"), second call was
  // confirmed then refused ("could not confirm that this panel's ComfyUI is the
  // local instance"), then every graph call failed with Connected: none. The card
  // was shown before identity was known, so the same unbindable target produced
  // two outcomes, and the wait left graph tools looking like a reconnect.

  it("an unbindable local target refuses WITHOUT showing a confirmation card", async () => {
    let confirmCalled = false;
    const preflight = vi.fn(async () => ({ ok: true }));
    __panelToolsTestHooks.setLocalRestartPreflight(preflight);
    const { ctx, sends } = makeCtx({ confirm: "yes", frontsBoot: false });
    ctx.confirm = async () => {
      confirmCalled = true;
      return "yes";
    };

    const out = parse(await restartTool().handler({}, ctx));

    expect(confirmCalled).toBe(false);
    expect(sends).toEqual([]);
    expect(preflight).not.toHaveBeenCalled();
    expect(out.refused).toBe(true);
    expect(out.rebooting).toBe(false);
    expect(out.confirmed_cycle).toBe(false);
    expect(String(out.note)).toMatch(/cannot tell which server the restart would stop/i);
  });

  it("a refused restart keeps the live tab and reports one terminal state, not a reconnect", async () => {
    const { ctx, sends } = makeCtx({ confirm: "yes", frontsBoot: false });
    const identityBefore = ctx.panelConnectionIdentity();

    const out = parse(await restartTool().handler({}, ctx));

    expect(out.refused).toBe(true);
    expect(out.rebooting).toBe(false);
    // Nothing was restarted, so graph tools stay usable on the same tab.
    expect(out.ready).toBe(true);
    expect(out.graph_tools_ready).toBe(true);
    expect(out.panel_tab_reconnected).toBe(true);
    expect(ctx.tabId).toBe("bound-tab");
    expect(ctx.bridge.canReach(ctx.tabId)).toBe(true);
    expect(ctx.panelConnectionIdentity()).toEqual(identityBefore);
    expect(resetClient).not.toHaveBeenCalled();
    expect(resetObjectInfoCache).not.toHaveBeenCalled();
    await ctx.bridge.send({ cmd: "graph_get_errors" } as { cmd: string }, {
      tabId: ctx.tabId,
    } as never);
    expect(sends).toEqual([{ cmd: "graph_get_errors" }]);
  });

  it("panel_get_errors still reaches the live tab after an identity refusal (real ctx)", async () => {
    // Drive the shipped handler AND the next graph tool the reporter hit, on the
    // real makePanelToolCtx path — not a stub that skips confirm/call wiring.
    const TAB = "bound-tab";
    const sends: Array<Record<string, unknown>> = [];
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        sends.push(cmd);
        if (cmd.cmd === "graph_get_errors") return { nodes: [], missing_models: [] };
        return { ok: true };
      },
      canReach: () => true,
      isHeadless: () => false,
      tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => TAB,
      tabIsLocal: () => true,
      tabServerOrigin: () => "http://127.0.0.1:8189",
      tabCanMutateGraph: () => true,
      tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());

    const restart = parse(await restartTool().handler({}, ctx));
    expect(restart.refused).toBe(true);
    expect(restart.rebooting).toBe(false);
    expect(restart.ready).toBe(true);
    expect(restart.panel_tab_reconnected).toBe(true);
    expect(sends.some((c) => c.cmd === "ask_user")).toBe(false);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);

    const getErrors = buildPanelToolDefs().find((d) => d.name === "panel_get_errors");
    if (!getErrors) throw new Error("panel_get_errors not found");
    const errors = await getErrors.handler({}, ctx);
    expect(errors.isError).toBeFalsy();
    expect(sends.some((c) => c.cmd === "graph_get_errors")).toBe(true);
    expect(ctx.tabId).toBe(TAB);
    expect(ctx.bridge.canReach(TAB)).toBe(true);
  });
});

describe("panel_restart_comfyui — a declined restart leaves the panel bridge untouched (#916)", () => {
  // #916: a restart CANCELLED at its confirmation card left the panel bridge
  // disconnected ("Panel not reachable: no panel connected" on the very next
  // call). The decline path must be a pure report: it dispatches nothing to
  // the bridge, drops no caches, and leaves the session bound to the same tab.
  it("a clean decline dispatches NOTHING over the bridge and the session stays bound to the same live tab", async () => {
    __panelToolsTestHooks.setHealthProbe(async () => "healthy");
    const { ctx, sends } = makeCtx({ confirm: "no" });
    const identityBefore = ctx.panelConnectionIdentity();

    const res = await restartTool().handler({}, ctx);

    expect(text(res)).toBe("Cancelled — ComfyUI was not restarted.");
    // Not one frame to the panel: no reboot, no reload, no rebind command.
    expect(sends).toEqual([]);
    // No client caches dropped (those belong to an ACCEPTED restart).
    expect(resetClient).not.toHaveBeenCalled();
    expect(resetObjectInfoCache).not.toHaveBeenCalled();
    // The binding is exactly what it was before the card was answered.
    expect(ctx.tabId).toBe("bound-tab");
    expect(ctx.bridge.canReach(ctx.tabId)).toBe(true);
    expect(ctx.panelConnectionIdentity()).toEqual(identityBefore);
    // …so the next panel command routes exactly as before the declined restart.
    await ctx.bridge.send({ cmd: "graph_get_state" } as { cmd: string }, {
      tabId: ctx.tabId,
    } as never);
    expect(sends).toEqual([{ cmd: "graph_get_state" }]);
  });

  it("a decline over a DOWN server reports the loss but STILL dispatches nothing and keeps the binding", async () => {
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx, sends } = makeCtx({ confirm: "no" });
    const identityBefore = ctx.panelConnectionIdentity();

    const res = await restartTool().handler({}, ctx);

    expect(text(res)).toMatch(/ComfyUI is DOWN/i);
    // Even the alarmed report path is observation-only: nothing went out over
    // the bridge, and the session/tab identity is undisturbed.
    expect(sends).toEqual([]);
    expect(resetClient).not.toHaveBeenCalled();
    expect(resetObjectInfoCache).not.toHaveBeenCalled();
    expect(ctx.tabId).toBe("bound-tab");
    expect(ctx.bridge.canReach(ctx.tabId)).toBe(true);
    expect(ctx.panelConnectionIdentity()).toEqual(identityBefore);
  });
});

describe("panel_restart_comfyui — restart dispatch record (r4/r5)", () => {
  it("an ACCEPTED reboot stamps the dispatch record HELD BY its session (target base + time)", async () => {
    // The reboot is accepted but never observed back — the record must stay
    // stamped so a later decline can name the causation.
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx, sends } = makeCtx({ confirm: "yes" });

    const before = Date.now();
    await restartTool().handler({}, ctx);

    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(true);
    const rec = __panelToolsTestHooks.getSessionRestartDispatch(ctx);
    expect(rec).not.toBeNull();
    expect(rec!.at).toBeGreaterThanOrEqual(before);
    expect(__panelToolsTestHooks.sameHttpBase(rec!.base, BOOT_BASE)).toBe(true);
  });

  it("a REFUSED reboot (busy guard) does NOT stamp the record", async () => {
    // A refusal restarts nothing — recording it would fabricate causation.
    __panelToolsTestHooks.setHealthProbe(async () => "healthy");
    const { ctx, sends } = makeCtx({
      confirm: "yes",
      rebootReply: { rebooting: false, blocked_busy: true },
    });

    const out = parse(await restartTool().handler({}, ctx));

    expect(out.rebooting).toBe(false);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(true);
    expect(__panelToolsTestHooks.getSessionRestartDispatch(ctx)).toBeNull();
  });

  it("session A's recovery clears ONLY its own record — session B's survives (r5)", async () => {
    // B has a failed restart on record. A runs its own accepted reboot that
    // recovers: A's record is stamped then cleared on recovery; B's record
    // must be untouched.
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx: ctxB } = makeCtx({ confirm: "no" });
    __panelToolsTestHooks.seedSessionRestartDispatch(ctxB, { at: Date.now(), base: BOOT_BASE });

    const seq: Array<"down" | "healthy"> = ["down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(i++, seq.length - 1)]);
    const { ctx: ctxA } = makeCtx({ confirm: "yes" });

    const out = parse(await restartTool().handler({}, ctxA));

    expect(out.ready).toBe(true); // A's restart recovered
    expect(__panelToolsTestHooks.getSessionRestartDispatch(ctxA)).toBeNull(); // A's cleared
    // B's record survives A's recovery.
    const recB = __panelToolsTestHooks.getSessionRestartDispatch(ctxB);
    expect(recB).not.toBeNull();
    expect(__panelToolsTestHooks.sameHttpBase(recB!.base, BOOT_BASE)).toBe(true);
  });

  it("an UNBOUND accepted reboot stamps NO causation-capable record (r6)", async () => {
    // The reboot is accepted, but the target is unconfirmable (the tab does
    // not provably front our boot instance) — it must NOT stamp a session-held
    // record: the dispatch can't be proven to have hit the instance a later
    // decline would probe. It lands only in the process-wide non-causation
    // slot (documenting that a dispatch happened).
    // REMOTE, because that is where an unbound dispatch still happens: a LOCAL
    // target the tab cannot be tied to is now refused outright (#814 — a stop is
    // never sent to a server we cannot identify). The subject here is unchanged:
    // an unconfirmable dispatch must not stamp a causation-capable record.
    hoistedConfig.remote.value = true;
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx, sends } = makeCtx({ confirm: "yes", frontsBoot: false });

    const out = parse(await restartTool().handler({}, ctx));

    expect(out.rebooting).toBe(true); // accepted, honestly unconfirmable
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(true);
    // No causation-capable stamp on the session…
    expect(__panelToolsTestHooks.getSessionRestartDispatch(ctx)).toBeNull();
    // …only the shared process-wide (never-causation) slot knows of it.
    expect(
      getRestartDispatchRecord(PROCESS_WIDE_RESTART_DISPATCH_TOKEN),
    ).not.toBeNull();
  });

  it("a session that REBINDS to the boot tab after an unbound reboot gets a causation-FREE decline (r6)", async () => {
    // The accepted reboot happened while the session fronted an UNCONFIRMABLE
    // target. The session then rebinds to the boot tab: even with a full-window
    // down on the bound endpoint, the earlier reboot of (possibly) a DIFFERENT
    // instance must not be blamed.
    const fronts = { current: false }; // unbound at reboot time
    const seq: Array<"down" | "healthy"> = ["down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(i++, seq.length - 1)]);
    const { ctx, sends } = makeCtx({ confirm: "yes", fronts });

    // 1. Accepted reboot while UNBOUND — dispatched, honestly unconfirmable. REMOTE,
    // because that is where an unbound dispatch still happens: a LOCAL target the tab
    // cannot be tied to is now refused outright (#814). The scenario under test is
    // unchanged — a reboot of a possibly-different instance must never be blamed for
    // a later down on the bound one.
    hoistedConfig.remote.value = true;
    const out1 = parse(await restartTool().handler({}, ctx));
    expect(out1.rebooting).toBe(true);

    // 2. The session REBINDS to the boot tab and a second card is declined.
    hoistedConfig.remote.value = false;
    fronts.current = true;
    ctx.confirm = async () => "no" as const;
    __panelToolsTestHooks.setHealthProbe(async () => "down"); // full-window refusal

    const res2 = await restartTool().handler({}, ctx);
    const t2 = text(res2);

    expect(t2).toMatch(/ComfyUI is DOWN/i);
    expect(t2).toMatch(/no restart was dispatched/i);
    expect(t2).not.toMatch(/restart initiated earlier/i);
    expect(t2).not.toMatch(/STOPPED and did not come back/i);
    expect(sends.filter((c) => c.cmd === "comfy_reboot")).toHaveLength(1); // only the first
  });

  it("a rebind DURING the preflight await withholds the causation-capable stamp (r7)", async () => {
    // Bound at the preflight DECISION, but the session rebinds to an unconfirmable
    // target MID-AWAIT. r7's rule is that nothing may be stamped against the STALE
    // pre-await bound base — the dispatch-point binding governs.
    //
    // That rule now holds in its strongest form: a local target we cannot identify is
    // refused AT THE DISPATCH POINT (#814), so there is no dispatch and no record at
    // all — neither session-held nor process-wide. A stamp against the stale base was
    // never possible, because nothing was ever sent.
    const fronts = { current: true }; // bound when the preflight is decided…
    __panelToolsTestHooks.setLocalRestartPreflight(async () => {
      fronts.current = false; // …but a rebind lands DURING the preflight await
      return { ok: true };
    });
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx, sends } = makeCtx({ confirm: "yes", fronts });

    const out = parse(await restartTool().handler({}, ctx));

    expect(out.refused).toBe(true);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
    // NOTHING is on record — least of all against the stale bound base.
    expect(__panelToolsTestHooks.getSessionRestartDispatch(ctx)).toBeNull();
    expect(getRestartDispatchRecord(PROCESS_WIDE_RESTART_DISPATCH_TOKEN)).toBeNull();
  });

  it("a dispatch stamped DURING a decline probe survives the exoneration clear (r15)", async () => {
    // A decline probe is in flight when a NEW accepted restart stamps a fresh
    // token in the SAME session. The probe then returns healthy: the
    // exoneration clear must be CLEAR-IF-SAME — it may retire the OLD token it
    // validated, but never evict the NEWER dispatch's record.
    const { ctx, sends } = makeCtx({ confirm: "no" });
    __panelToolsTestHooks.seedSessionRestartDispatch(ctx, { at: Date.now(), base: BOOT_BASE }); // T1

    let probed = 0;
    __panelToolsTestHooks.setHealthProbe(async () => {
      probed++;
      if (probed === 1) {
        // The concurrent accepted restart, mid-probe: stamps T2 (replacing T1)
        // at acceptance; its own observer only ever sees "down" → never ready
        // → no clear of its own.
        ctx.confirm = async () => "yes" as const;
        await restartTool().handler({}, ctx);
        return "healthy";
      }
      return "down";
    });

    await restartTool().handler({}, ctx); // the decline: healthy → exoneration

    // The NEWER dispatch's record SURVIVES the decline's exoneration clear…
    const held = __panelToolsTestHooks.getSessionRestartDispatch(ctx);
    expect(held).not.toBeNull();
    expect(__panelToolsTestHooks.sameHttpBase(held!.base, BOOT_BASE)).toBe(true);
    expect(sends.filter((c) => c.cmd === "comfy_reboot")).toHaveLength(1);

    // …so a later full-window down correctly attributes to the newer dispatch.
    ctx.confirm = async () => "no" as const;
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const res2 = await restartTool().handler({}, ctx);
    const t2 = text(res2);
    expect(t2).toMatch(/ComfyUI is DOWN/i);
    expect(t2).toMatch(/STOPPED and did not come back/i);
    expect(t2).toMatch(/restart initiated earlier/i);
  });
});
