// #509 + coordinator honesty re-review: panel_restart_comfyui must certify
// ready:true ONLY on the ONE sound proof that the driven ComfyUI instance actually
// cycled — a boot-endpoint DOWN→UP transition directly observed on the immutable,
// family-bound boot endpoint. A lone "healthy" (which could be the pre-reboot process
// or a different instance at the same address) must NEVER certify, and a panel-tab
// reconnect is NOT a proof (tab_id is client-supplied; the socket churn says nothing
// about the possibly-remote ComfyUI). When there is no probeable boot endpoint we
// report an HONEST dispatched/couldn't-confirm (ready:false) — distinct from a false
// ready AND from the old #509 false-timeout error.

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
import { getBootLocalComfyUIBaseUrl } from "../../config.js";
import { markDispatched } from "../../services/ui-bridge.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

type ProbeSeq = Array<"healthy" | "down" | "unknown">;

// The orchestrator's immutable boot endpoint — the only thing the observer probes.
const BOOT_BASE = (getBootLocalComfyUIBaseUrl() ?? "http://127.0.0.1:8188").replace(/\/+$/, "");

const parse = (res: ToolResult): Record<string, unknown> =>
  JSON.parse(res.content.find((c) => c.type === "text")!.text as string);

/**
 * Build a fake panel ctx for the reboot handler.
 *  - reboot: the comfy_reboot reply object, OR an Error to throw (a mid-command drop).
 *  - origin / local: what tabOrigin/tabIsLocal report (the gate for the boot probe).
 */
function makeCtx(opts: {
  reboot: Record<string, unknown> | Error;
  origin?: string | null;
  local?: boolean;
  confirmSeen?: (timeoutMs: number | undefined) => void;
  /** Delay the comfy_reboot dispatch reply (ms) — models a slow reboot ack so the
   *  test can prove the observer's deadline starts AFTER the dispatch. */
  dispatchDelayMs?: number;
}): { ctx: PanelToolCtx; sends: Array<Record<string, unknown>> } {
  const sends: Array<Record<string, unknown>> = [];
  const bridge = {
    send: async (cmd: Record<string, unknown>) => {
      sends.push(cmd);
      if (cmd.cmd === "comfy_reboot") {
        if (opts.dispatchDelayMs) await new Promise((r) => setTimeout(r, opts.dispatchDelayMs));
        if (opts.reboot instanceof Error) throw opts.reboot;
        return opts.reboot;
      }
      return {};
    },
    // The reboot self-probe gate reads the SERVER-OBSERVED handshake origin
    // (tabServerOrigin), not the spoofable hello.comfyui_url (tabOrigin). Drive both from
    // `origin` so tests model a browser served from that origin.
    tabOrigin: () => (opts.origin === undefined ? BOOT_BASE : (opts.origin ?? undefined)),
    tabServerOrigin: () => (opts.origin === undefined ? BOOT_BASE : (opts.origin ?? undefined)),
    tabIsLocal: () => opts.local ?? true,
    canReach: () => true,
  } as unknown as PanelToolCtx["bridge"];
  const ctx = {
    call: async () => {
      throw new Error("ctx.call must not be used by reboot readiness");
    },
    confirm: async (_q: string, _h: string, timeoutMs?: number) => {
      opts.confirmSeen?.(timeoutMs);
      return "yes" as const;
    },
    ensureReachable: () => {},
    bridge,
    tabId: "bound-tab",
  } as unknown as PanelToolCtx;
  return { ctx, sends };
}

function rebootHandler() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_restart_comfyui");
  if (!def) throw new Error("panel_restart_comfyui not found");
  return def.handler;
}

// The bridge's canonical POST-write mid-command drop carries the TYPED dispatched:true
// flag (the command WAS written before the socket died) — the authoritative accept signal.
const DROP = markDispatched(
  new Error(
    'panel tab abc disconnected mid-command ("comfy_reboot") — OUTCOME UNKNOWN: the command was already sent',
  ),
  true,
);

beforeEach(() => {
  resetClient.mockClear();
  resetObjectInfoCache.mockClear();
  // The #742 refuse-safe preflight passes by default here (the live one would
  // probe real processes/ports); these tests exercise the post-dispatch paths.
  __panelToolsTestHooks.setLocalRestartPreflight(async () => ({ ok: true }));
  __panelToolsTestHooks.setPanelRebootTiming({
    settleMs: 0,
    budgetMs: 200,
    intervalMs: 5,
    probeTimeoutMs: 20,
  });
});

afterEach(() => {
  __panelToolsTestHooks.setPanelRebootTiming(null);
  __panelToolsTestHooks.setHealthProbe(null);
  __panelToolsTestHooks.setLocalRestartPreflight(null);
});

describe("panel_restart_comfyui recovery after an ACCEPTED reboot (coordinator policy)", () => {
  it("accepted (rebooting:true) + any down + healthy → CONFIRMED (observed-cycle)", async () => {
    // ANY down after an accepted reboot counts — acceptance is the guard, not probe
    // strength. A one-off blip on a server we JUST told to reboot is benign.
    const seq: ProbeSeq = ["down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(i++, seq.length - 1)]);
    const { ctx } = makeCtx({ reboot: { rebooting: true } });

    const out = parse(await rebootHandler()({ force: false }, ctx));
    expect(out.ready).toBe(true);
    expect(out.confirmed_cycle).toBe(true);
    expect(out.via).toBe("observed-cycle");
    expect(resetClient).toHaveBeenCalledTimes(1);
    expect(resetObjectInfoCache).toHaveBeenCalledTimes(1);
  });

  it("fast restart: a SINGLE down (would-be transient) after acceptance still CONFIRMS as observed-cycle", async () => {
    // With a modest settle, the initial healthy doesn't short-circuit — we see the one
    // down (any down counts after acceptance) then healthy → observed-cycle.
    __panelToolsTestHooks.setPanelRebootTiming({ settleMs: 100, budgetMs: 400, intervalMs: 5, probeTimeoutMs: 10 });
    const seq: ProbeSeq = ["healthy", "down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(i++, seq.length - 1)]);
    const { ctx } = makeCtx({ reboot: { rebooting: true } });

    const out = parse(await rebootHandler()({ force: false }, ctx));
    expect(out.ready).toBe(true);
    expect(out.via).toBe("observed-cycle");
  });

  it("dropped dispatch + OBSERVED down→up → CONFIRMED (observed-cycle)", async () => {
    // A mid-command drop is AMBIGUOUS (could be a tab-close no-op), so it needs an
    // OBSERVED down→up — which a real rebooting server provides.
    const seq: ProbeSeq = ["down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(i++, seq.length - 1)]);
    const { ctx } = makeCtx({ reboot: DROP });

    const out = parse(await rebootHandler()({ force: false }, ctx));
    expect(out.ready).toBe(true);
    expect(out.confirmed_cycle).toBe(true);
    expect(out.via).toBe("observed-cycle");
  });

  it("#509 frozen tab: a POST-write reply-TIMEOUT (dispatched:true) is treated as accepted → observes recovery", async () => {
    // sock.send() succeeded but a backgrounded/frozen tab never acked within the window.
    // The command WAS written and may still apply, so the bridge tags the timeout
    // dispatched:true — the handler must NOT return the raw timeout error; it observes the
    // boot endpoint and certifies on a real down→up (no #509 false-timeout for a real one).
    const seq: ProbeSeq = ["down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(i++, seq.length - 1)]);
    const replyTimeout = markDispatched(
      new Error('Panel tab abc did not reply to "comfy_reboot" within 15000 ms — the ComfyUI tab may be backgrounded or frozen'),
      true,
    );
    const { ctx } = makeCtx({ reboot: replyTimeout });

    const res = await rebootHandler()({ force: false }, ctx);
    expect(res.isError).not.toBe(true); // NOT surfaced as the raw timeout error
    const out = parse(res);
    expect(out.ready).toBe(true);
    expect(out.via).toBe("observed-cycle");
  });

  it("#509 frozen tab: a POST-write reply-TIMEOUT with NO observed cycle → honest dispatched, not a false timeout error", async () => {
    __panelToolsTestHooks.setHealthProbe(async () => "healthy"); // never goes down (no-op)
    const replyTimeout = markDispatched(
      new Error('Panel tab abc did not reply to "comfy_reboot" within 15000 ms — the ComfyUI tab may be backgrounded or frozen'),
      true,
    );
    const { ctx } = makeCtx({ reboot: replyTimeout });

    const res = await rebootHandler()({ force: false }, ctx);
    expect(res.isError).not.toBe(true);
    const out = parse(res);
    expect(out.ready).toBe(false);
    expect(out.confirmed_cycle).toBe(false);
  });

  it("P1: a DROP that is a NO-OP (tab closed, server stays healthy) → couldn't-confirm, NOT ready", async () => {
    // Closing/reloading the tab right after transmission (before the executor accepted
    // comfy_reboot) leaves ComfyUI healthy. A bare drop must NOT certify a healthy server
    // — it requires an observed down, which never comes → couldn't-confirm.
    __panelToolsTestHooks.setPanelRebootTiming({ settleMs: 5, budgetMs: 200, intervalMs: 5, probeTimeoutMs: 10 });
    __panelToolsTestHooks.setHealthProbe(async () => "healthy"); // never went down
    const { ctx } = makeCtx({ reboot: DROP });

    const out = parse(await rebootHandler()({ force: false }, ctx));
    expect(out.ready).toBe(false);
    expect(out.confirmed_cycle).toBe(false);
    expect(String(out.note)).toMatch(/could NOT confirm|disconnected without rebooting/i);
  });

  it("CONFIRMED accept (rebooting:true) + always healthy (no observed down) → couldn't-confirm", async () => {
    // The panel emits rebooting:true even when it only INFERS a reboot from a dropped
    // fetch, so a confirmed ack is NOT a guarantee — treated like the ambiguous case, it
    // requires an OBSERVED down→up. A server that never goes down → couldn't-confirm.
    __panelToolsTestHooks.setPanelRebootTiming({ settleMs: 5, budgetMs: 200, intervalMs: 5, probeTimeoutMs: 10 });
    __panelToolsTestHooks.setHealthProbe(async () => "healthy");
    const { ctx } = makeCtx({ reboot: { rebooting: true } });

    const out = parse(await rebootHandler()({ force: false }, ctx));
    expect(out.ready).toBe(false);
    expect(out.confirmed_cycle).toBe(false);
    expect(out.saw_down).toBe(false);
  });

  it("#509 FAST reboot: down→up ENTIRELY within the (slow) ack window → CERTIFIES observed-cycle", async () => {
    // The reboot's down→up completes DURING the ack window (the ack takes 150ms; the endpoint
    // is ECONNREFUSED for the first ~90ms then healthy). Because the observer probes
    // CONCURRENTLY with the dispatch, it captures that fast cycle. FAILS-BEFORE the concurrent
    // rewrite: the old ordering awaited the full send() (150ms) THEN observed → by then the
    // endpoint is already healthy → saw_down:false / ready:false (the reopened #509).
    const t0 = Date.now();
    __panelToolsTestHooks.setPanelRebootTiming({ settleMs: 0, budgetMs: 400, intervalMs: 8, probeTimeoutMs: 10 });
    __panelToolsTestHooks.setHealthProbe(async () => (Date.now() - t0 < 90 ? "down" : "healthy"));
    const { ctx } = makeCtx({ reboot: { rebooting: true }, dispatchDelayMs: 150 });

    const out = parse(await rebootHandler()({ force: false }, ctx));
    expect(out.ready).toBe(true);
    expect(out.saw_down).toBe(true);
    expect(out.via).toBe("observed-cycle");
  });

  it("#509 blind window: a down→up in the FIRST interval after the write → CERTIFIES (probe-first, not sleep-first)", async () => {
    // The endpoint is ECONNREFUSED for the first ~80ms after the socket write, then healthy —
    // a full cycle contained INSIDE the first probe interval (interval = 200ms). Only because
    // the observer PROBES IMMEDIATELY at the post-write dispatch instant (probe-first) does it
    // sample the down at ~t0 and certify on the next probe. FAILS-BEFORE with sleep-then-probe:
    // the leading 200ms interval sleep meant the first probe landed at ~225ms — after the cycle
    // — so only healthy was seen (saw_down:false / ready:false). The ack is delayed 120ms so the
    // whole cycle sits inside the concurrent ack window.
    const t0 = Date.now();
    __panelToolsTestHooks.setPanelRebootTiming({ settleMs: 0, budgetMs: 800, intervalMs: 200, probeTimeoutMs: 10 });
    __panelToolsTestHooks.setHealthProbe(async () => (Date.now() - t0 < 80 ? "down" : "healthy"));
    const { ctx } = makeCtx({ reboot: { rebooting: true }, dispatchDelayMs: 120 });

    const out = parse(await rebootHandler()({ force: false }, ctx));
    expect(out.ready).toBe(true);
    expect(out.saw_down).toBe(true);
    expect(out.via).toBe("observed-cycle");
  });

  it("gate: a PRE-write failure NEVER CERTIFIES — a down→up endpoint can't form a cycle before cancel", async () => {
    // The observer is woken concurrently on dispatch, but a PRE-write send failure sets
    // gate.cancelled, so the observer stops after AT MOST one benign read (the accepted
    // sub-ack residual) — it can never see the down THEN the up needed to certify, and the
    // not-accepted branch discards it anyway. So even a scripted down→up endpoint yields the
    // NOT-dispatched error, never a phantom cycle, and never resets the shared client.
    let probeCalls = 0;
    const seq: ProbeSeq = ["down", "healthy"];
    __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(probeCalls++, seq.length - 1)]);
    const typedPreWrite = markDispatched(
      new Error('failed to send "comfy_reboot" — the command was NOT dispatched (ECONNRESET)'),
      false,
    );
    const { ctx } = makeCtx({ reboot: typedPreWrite });

    const res = await rebootHandler()({ force: false }, ctx);
    expect(res.isError).toBe(true); // surfaced as the not-dispatched error, never certified
    expect(probeCalls).toBeLessThanOrEqual(1); // cancelled before a 2nd sample → no down→up
    expect(resetClient).not.toHaveBeenCalled();
  });

  it("P0: a PRE-WRITE send failure (command NOT dispatched) → clear error, NEVER an observed-cycle", async () => {
    // A sock.send() throw BEFORE the write means nothing reached the panel. It must NOT be
    // treated as a dropped/accepted reboot — it is surfaced verbatim and can never certify
    // (the observer is cancelled after at most one benign own-endpoint read; the endpoint
    // stays healthy so no cycle forms, and the not-accepted branch discards it).
    const health = vi.fn(async () => "healthy" as const);
    __panelToolsTestHooks.setHealthProbe(health);
    const preWrite = new Error(
      'failed to send "comfy_reboot" to panel tab abc12345 — the command was NOT dispatched (ECONNRESET)',
    );
    const { ctx } = makeCtx({ reboot: preWrite });

    const res = await rebootHandler()({ force: false }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content.find((c) => c.type === "text")!.text as string).toMatch(/NOT dispatched/i);
    expect(resetClient).not.toHaveBeenCalled(); // a not-dispatched reboot never certifies/resets
  });

  it("P1: a TYPED pre-write failure (dispatched:false) whose TEXT contains 'OUTCOME UNKNOWN' is NOT a drop", async () => {
    // The authoritative signal is the bridge's typed dispatch flag, not string matching.
    // Even if a pre-write send failure's message quotes a post-write phrase, dispatched:false
    // must categorically classify it as NOT-dispatched — surfaced verbatim, never certified.
    const health = vi.fn(async () => "healthy" as const);
    __panelToolsTestHooks.setHealthProbe(health);
    const typedPreWrite = markDispatched(
      new Error('failed to send "comfy_reboot" — NOT dispatched (socket write: OUTCOME UNKNOWN)'),
      false,
    );
    const { ctx } = makeCtx({ reboot: typedPreWrite });

    const res = await rebootHandler()({ force: false }, ctx);
    expect(res.isError).toBe(true); // not accepted → surfaced verbatim, never certified
    expect(resetClient).not.toHaveBeenCalled();
  });

  it("P1: text-only fallback — an older-bridge 'NOT dispatched' wrapper wins over drop phrases", async () => {
    // No typed flag (older bridge). The rebootDropped() text fallback must still let the
    // "NOT dispatched" wrapper win even though the detail quotes "disconnected mid-command".
    const health = vi.fn(async () => "healthy" as const);
    __panelToolsTestHooks.setHealthProbe(health);
    const untyped = new Error(
      'failed to send "comfy_reboot" to panel tab abc — the command was NOT dispatched (disconnected mid-command)',
    );
    const { ctx } = makeCtx({ reboot: untyped });

    const res = await rebootHandler()({ force: false }, ctx);
    expect(res.isError).toBe(true); // treated as NOT dispatched → never certified
    expect(resetClient).not.toHaveBeenCalled();
  });

  it("P0: a `localhost` tab origin is ambiguous → REFUSED, probe (with auth) never sent", async () => {
    // Boot base is the concrete 127.0.0.1 default; the tab advertises
    // http://localhost:8188. localhost may resolve to ::1 in the browser, so we CANNOT
    // prove the tab fronts the 127.0.0.1 instance — captureRebootHealthBase → null.
    //
    // That used to mean an honest dispatched-but-unconfirmable reboot. It now REFUSES
    // (#814): a reboot STOPS whatever the tab fronts, and being unable to say WHICH
    // server that is means being unable to say anything about bringing it back. The
    // original assertion holds more strongly than before — the probe is not merely
    // unsent, nothing is dispatched at all.
    const health = vi.fn(async () => "healthy" as const);
    __panelToolsTestHooks.setHealthProbe(health);
    const { ctx } = makeCtx({ reboot: { rebooting: true }, origin: "http://localhost:8188", local: true });

    const res = await rebootHandler()({ force: false }, ctx);
    expect(res.isError).not.toBe(true);
    const out = parse(res);
    expect(out.refused).toBe(true);
    expect(out.rebooting).toBe(false);
    expect(out.confirmed_cycle).toBe(false);
    expect(health).not.toHaveBeenCalled(); // ambiguous origin → never probed, no auth sent
    expect(String(out.note)).toMatch(/cannot tell which server/i);
  });

  it("Gap: no probeable boot endpoint → REFUSED for a local target, and never a proxy certify", async () => {
    // captureRebootHealthBase → null (non-local tab): there is NO sound proof this
    // instance would cycle, and — since #814 — no proof of WHICH instance would be
    // stopped either. For a LOCAL target that now refuses before dispatch.
    //
    // Everything this test was written to forbid still holds, and more cheaply: no
    // invented proof from a panel reconnect, no #509 false-TIMEOUT error, and the boot
    // probe never consulted. The honest dispatched-but-unconfirmable result remains for
    // REMOTE targets, where the Manager reboot is the only restart path (covered in
    // panel-restart-cancel-truth).
    let healthConsulted = false;
    __panelToolsTestHooks.setHealthProbe(async () => {
      healthConsulted = true;
      return "healthy";
    });
    const { ctx } = makeCtx({ reboot: { rebooting: true }, local: false });

    const res = await rebootHandler()({ force: false }, ctx);
    expect(res.isError).not.toBe(true); // NOT the #509 false-timeout error
    const out = parse(res);
    expect(out.refused).toBe(true);
    expect(out.rebooting).toBe(false);
    expect(out.confirmed_cycle).toBe(false);
    expect(out.via).toBeUndefined(); // no proxy proof value
    expect(healthConsulted).toBe(false); // boot probe never consulted (null base)
    expect(String(out.note)).toMatch(/cannot tell which server/i);
  });

  it("Gap: a DROPPED reboot with no boot endpoint is REFUSED before it can drop", async () => {
    // Same shape via the EXPECTED-DROP accept path: with no probeable endpoint there is
    // no proof of which instance is being stopped, so the refusal happens BEFORE the
    // dispatch — the drop never occurs. Never a false success, which is what this test
    // has always been about.
    const { ctx } = makeCtx({ reboot: DROP, local: false });

    const out = parse(await rebootHandler()({ force: false }, ctx));
    expect(out.refused).toBe(true);
    expect(out.rebooting).toBe(false);
    expect(out.confirmed_cycle).toBe(false);
    expect(String(out.note)).toMatch(/cannot tell which server/i);
  });

  it("accepted but endpoint NEVER becomes healthy → couldn't-confirm (ready:false)", async () => {
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx } = makeCtx({ reboot: { rebooting: true } });

    const out = parse(await rebootHandler()({ force: false }, ctx));
    expect(out.ready).toBe(false);
    expect(out.confirmed_cycle).toBe(false);
    expect(out.saw_down).toBe(true);
    expect(String(out.note)).toContain("went down");
  });

  it("slow ack (dispatch) + recovery within budget CONFIRMS (deadline starts AFTER dispatch)", async () => {
    // The dispatch takes LONGER than the proof budget; only because the deadline is
    // measured from AFTER the dispatch does the recovery fit. A deadline started before
    // the dispatch would false-timeout despite a healthy restart (coordinator finding 5).
    __panelToolsTestHooks.setPanelRebootTiming({ settleMs: 0, budgetMs: 80, intervalMs: 5, probeTimeoutMs: 10 });
    const seq: ProbeSeq = ["down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(i++, seq.length - 1)]);
    const { ctx } = makeCtx({ reboot: { rebooting: true }, dispatchDelayMs: 150 });

    const out = parse(await rebootHandler()({ force: false }, ctx));
    expect(out.ready).toBe(true);
    expect(out.via).toBe("observed-cycle");
  });

  it("REFUSAL (busy guard, rebooting:false) → returned verbatim, no cache reset, NEVER certifies", async () => {
    // The endpoint stays healthy (a refused reboot doesn't restart ComfyUI), so no cycle
    // forms; and the not-accepted branch returns the refusal verbatim and discards the
    // observer. The accepted sub-ack residual is at most one benign own-endpoint read.
    const health = vi.fn(async () => "healthy" as const);
    __panelToolsTestHooks.setHealthProbe(health);
    const { ctx } = makeCtx({ reboot: { rebooting: false, blocked_busy: true, queue_running: 1 } });

    const out = parse(await rebootHandler()({ force: false }, ctx));
    expect(out.rebooting).toBe(false);
    expect(out.blocked_busy).toBe(true);
    expect(out.ready).not.toBe(true); // a refusal never certifies
    expect(resetClient).not.toHaveBeenCalled(); // refusal never resets the shared client
  });

  it("belt-and-suspenders: a DELAYED rebooting:false refusal DISCARDS a (contrived) sampled down→up — NEVER certifies", async () => {
    // No early-accept signal exists, so the concurrent observer probes DURING the (slow) ack
    // window and here it SAMPLES a contrived down→up (recoveryPromise resolves ready) before
    // the refusal is known. On the rebooting:false reply the handler must EXPLICITLY discard
    // that cycle and return the refusal verbatim — a refusal can NEVER certify. (In reality a
    // refused reboot never restarts ComfyUI so no real down→up occurs; this forces the impossible
    // case to prove the discard.)
    const t0 = Date.now();
    __panelToolsTestHooks.setPanelRebootTiming({ settleMs: 0, budgetMs: 400, intervalMs: 8, probeTimeoutMs: 10 });
    __panelToolsTestHooks.setHealthProbe(async () => (Date.now() - t0 < 60 ? "down" : "healthy"));
    const { ctx } = makeCtx({
      reboot: { rebooting: false, blocked_busy: true, queue_running: 1 },
      dispatchDelayMs: 140, // refusal arrives AFTER the observer has sampled the down→up
    });

    const out = parse(await rebootHandler()({ force: false }, ctx));
    expect(out.rebooting).toBe(false); // the refusal is returned verbatim
    expect(out.blocked_busy).toBe(true);
    expect(out.ready).not.toBe(true); // the sampled cycle was DISCARDED — no certification
    expect(out.confirmed_cycle).not.toBe(true);
    expect(resetClient).not.toHaveBeenCalled(); // refusal never resets the shared client
  });

  it("MEDIUM budget: the confirm wait is bounded by the whole-handler budget (< outer 300s)", async () => {
    let seenTimeout: number | undefined = -1;
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx } = makeCtx({
      reboot: { rebooting: true },
      confirmSeen: (t) => {
        seenTimeout = t;
      },
    });

    await rebootHandler()({ force: false }, ctx);

    expect(seenTimeout).toBeGreaterThan(0);
    expect(seenTimeout as number).toBeLessThanOrEqual(255_000); // whole-handler cap
  });
});

describe("loopback family reconciliation (0.0.0.0/:: — but v4 ≠ v6)", () => {
  it("canonicalizes each loopback FAMILY, keeps v4 and v6 DISTINCT, and rewrites wildcards", () => {
    const { isLoopbackOrigin, loopbackProbeUrl, sameHttpBase } = __panelToolsTestHooks;
    expect(isLoopbackOrigin("http://0.0.0.0:8188")).toBe(true);
    expect(isLoopbackOrigin("http://[::]:8188")).toBe(true);
    // P0: the DNS-ambiguous `localhost` has NO concrete family, so it is NOT a
    // directly-probeable loopback literal (a URL can't reveal whether the browser
    // reached 127.0.0.1 or ::1). It must never be pinned to a family we can't verify.
    expect(isLoopbackOrigin("http://localhost:8188")).toBe(false);
    // Wildcard → connectable same-FAMILY loopback.
    expect(loopbackProbeUrl("http://0.0.0.0:8188")).toBe("http://127.0.0.1:8188");
    expect(loopbackProbeUrl("http://[::]:8188")).toBe("http://[::1]:8188");
    // Same CONCRETE family matches (127.0.0.1/0.0.0.0 are v4; ::1/:: are v6).
    expect(sameHttpBase("http://127.0.0.1:8188", "http://0.0.0.0:8188")).toBe(true);
    expect(sameHttpBase("http://[::1]:8188", "http://[::]:8188")).toBe(true);
    // P0: `localhost` does NOT match a concrete 127.0.0.1 literal — the ambiguity is
    // refused, not guessed (so a v6-resolving localhost can't be probed as v4).
    expect(sameHttpBase("http://localhost:8188", "http://127.0.0.1:8188")).toBe(false);
    expect(sameHttpBase("http://localhost:8188", "http://[::1]:8188")).toBe(false);
    // Cross-family does NOT match (v6 A on [::1]:8188 vs v4 B on 127.0.0.1:8188 could be
    // DIFFERENT instances) — coordinator finding 4.
    expect(sameHttpBase("http://127.0.0.1:8188", "http://[::1]:8188")).toBe(false);
    expect(sameHttpBase("http://127.0.0.1:8188", "http://[::]:8188")).toBe(false);
    // And a different port still differs.
    expect(sameHttpBase("http://127.0.0.1:9999", "http://0.0.0.0:8188")).toBe(false);
    // P1: a pathless handshake Origin can NEVER match a path-mounted boot base (basePath),
    // so a reverse-proxied /comfy mount is soundly fail-closed (identity is path-aware, and
    // an Origin carries no path to prove which mount the tab fronts).
    expect(sameHttpBase("http://127.0.0.1:8188", "http://127.0.0.1:8188/comfy")).toBe(false);
    expect(sameHttpBase("http://127.0.0.1:8188/comfy", "http://127.0.0.1:8188")).toBe(false);
  });
});

describe("captureRebootHealthBase gate (server-authorized boot target only)", () => {
  const cap = __panelToolsTestHooks.captureRebootHealthBase;
  // `serverOrigin` = the SERVER-OBSERVED handshake origin the gate trusts; `claimed` =
  // the spoofable hello.comfyui_url (tabOrigin). When only `claimed` is given it models a
  // socket that CLAIMS an origin its handshake does NOT back.
  const mk = (serverOrigin: string | null, local: boolean, claimed?: string | null) =>
    ({
      bridge: {
        tabOrigin: () => (claimed === undefined ? (serverOrigin ?? undefined) : (claimed ?? undefined)),
        tabServerOrigin: () => serverOrigin ?? undefined,
        tabIsLocal: () => local,
      } as unknown as PanelToolCtx["bridge"],
      tabId: "t",
    }) as unknown as PanelToolCtx;

  it("returns the boot base ONLY for a local tab whose HANDSHAKE origin (scheme+host+port, concrete family) matches", () => {
    // A real browser handshake Origin is scheme://host:port with NO path — BOOT_BASE here
    // is the pathless default, so an equal Origin certifies.
    expect(cap(mk(BOOT_BASE, true))).toBe(BOOT_BASE);
    expect(cap(mk(`${BOOT_BASE}/`, true))).toBe(BOOT_BASE); // trailing slash normalized
    expect(cap(mk("http://127.0.0.1:9999", true))).toBeNull(); // different port
    expect(cap(mk("http://[::1]:8188", true))).toBeNull(); // v6 tab vs v4 boot → cross-family
    expect(cap(mk(BOOT_BASE, false))).toBeNull(); // not server-trusted-local
    expect(cap(mk(null, true))).toBeNull(); // no handshake origin
    // P0: a `localhost` handshake origin is AMBIGUOUS (browser may have reached ::1) — it
    // must NOT match the concrete 127.0.0.1 boot base, so the probe (with auth) is never
    // sent to a possibly-different-family instance. Gate → null → honest dispatched.
    expect(cap(mk("http://localhost:8188", true))).toBeNull();
  });

  it("codex High: a SPOOFED hello.comfyui_url does NOT certify — only the handshake origin counts", () => {
    // A non-Comfy local socket CLAIMS the boot URL in its hello (tabOrigin === BOOT_BASE)
    // but its real handshake origin is something else (or absent). The gate must ignore the
    // claim and refuse to probe — else an unrelated boot-instance cycle could false-certify.
    expect(cap(mk("http://127.0.0.1:7777", true, BOOT_BASE))).toBeNull(); // handshake ≠ boot
    expect(cap(mk(null, true, BOOT_BASE))).toBeNull(); // no handshake origin at all
    // Sanity: only when the HANDSHAKE origin itself matches does it probe (claim irrelevant).
    expect(cap(mk(BOOT_BASE, true, "http://evil.example:1"))).toBe(BOOT_BASE);
  });
});

describe("reboot timing env caps (P2)", () => {
  it("hard-caps oversized SETTLE/BUDGET below the outer tools/call budget", () => {
    const prevS = process.env.COMFYUI_PANEL_REBOOT_SETTLE_S;
    const prevB = process.env.COMFYUI_PANEL_REBOOT_BUDGET_S;
    try {
      process.env.COMFYUI_PANEL_REBOOT_SETTLE_S = "301";
      process.env.COMFYUI_PANEL_REBOOT_BUDGET_S = "600";
      const t = __panelToolsTestHooks.computeRebootTimingFromEnv();
      expect(t.settleMs).toBeLessThanOrEqual(10_000);
      expect(t.budgetMs).toBeLessThanOrEqual(240_000);
      expect(t.settleMs + t.budgetMs).toBeLessThan(290_000);
    } finally {
      if (prevS === undefined) delete process.env.COMFYUI_PANEL_REBOOT_SETTLE_S;
      else process.env.COMFYUI_PANEL_REBOOT_SETTLE_S = prevS;
      if (prevB === undefined) delete process.env.COMFYUI_PANEL_REBOOT_BUDGET_S;
      else process.env.COMFYUI_PANEL_REBOOT_BUDGET_S = prevB;
    }
  });
});

describe("looksLikeSystemStats", () => {
  it("accepts a real /system_stats shape, rejects a bare 2xx / non-ComfyUI body", () => {
    const ok = (b: unknown) => __panelToolsTestHooks.looksLikeSystemStats(b);
    expect(ok({ system: { comfyui_version: "0.3" }, devices: [] })).toBe(true);
    expect(ok({ devices: [{ type: "cuda" }] })).toBe(true);
    expect(ok("<html>login</html>")).toBe(false);
    expect(ok({})).toBe(false);
    expect(ok(null)).toBe(false);
  });
});
