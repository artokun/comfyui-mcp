// #1996 — `panel_restart_comfyui` on a 200+ pack install reported
//
//   rebooting:true ready:false confirmed_cycle:false
//   recovered_ms:127254  probes:603  saw_down:true
//
// and then every `panel_*` call failed with "no connected tab … Connected: none"
// until the browser tab was refreshed by hand. ComfyUI itself was fine: a health
// check taken afterwards answered 0.33.0 with the freshly installed node present.
//
// WHAT THE NUMBERS ESTABLISH. 603 probes over 127.25 s is ~211 ms per iteration
// against `intervalMs` 200 ms and `probeTimeoutMs` 2000 ms — ~11 ms per probe,
// i.e. fast connection refusals, not timeouts (a hung probe would have produced
// ~63 iterations, not 603). The observer did NOT see a healthy server and call it
// unhealthy; the port was closed for the whole window and the observer STOPPED
// LOOKING at `COMFYUI_PANEL_REBOOT_BUDGET_S`, default 120 s, while the same file
// declares `MAX_REBOOT_BUDGET_MS = 240_000` safe.
//
// THE COUPLING, which is the half that hurts. `awaitPostRestartReachable` — the
// bounded wait for the tab to re-register, and the only thing on this path that
// calls `ensureReachable()` to heal the session binding onto the returning tab —
// sat AFTER `if (!recovery.ready) return …`. So a boot slower than the budget did
// not merely lose the readiness answer: it forfeited the reconnect wait as well.
// One number denied two independent things.
//
// These tests drive the real handler. The first one is the reproduction: on the
// pre-fix code `awaitPostRestartReachable` is never entered at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resetClient = vi.fn();
const resetObjectInfoCache = vi.fn();
const getSystemStats = vi.fn(async () => {
  throw new Error("ECONNRESET");
});

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  getSystemStats: () => getSystemStats(),
  resetClient: () => resetClient(),
  resetObjectInfoCache: () => resetObjectInfoCache(),
}));

const { buildPanelToolDefs, __panelToolsTestHooks } = await import(
  "../../orchestrator/panel-tools.js"
);
import { getBootLocalComfyUIBaseUrl } from "../../config.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const BOOT_BASE = (getBootLocalComfyUIBaseUrl() ?? "http://127.0.0.1:8188").replace(/\/+$/, "");

const parse = (res: ToolResult): Record<string, unknown> =>
  JSON.parse(res.content.find((c) => c.type === "text")!.text as string);

interface ReconnectCall {
  before: { generation: number; tabSessionId: string } | undefined;
  budgetMs: number | undefined;
}

function makeCtx(opts: {
  /** What the (spied) post-restart reconnect wait resolves to. */
  tabReturns: boolean;
  /** Omit the pre-restart identity, i.e. nothing was ever watched. */
  noBaseline?: boolean;
}): { ctx: PanelToolCtx; reconnectCalls: ReconnectCall[] } {
  const reconnectCalls: ReconnectCall[] = [];
  const bridge = {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "comfy_reboot") return { rebooting: true };
      return {};
    },
    tabOrigin: () => BOOT_BASE,
    tabServerOrigin: () => BOOT_BASE,
    tabIsLocal: () => true,
    canReach: () => true,
  } as unknown as PanelToolCtx["bridge"];
  const ctx = {
    call: async () => {
      throw new Error("ctx.call must not be used by reboot readiness");
    },
    confirm: async () => "yes" as const,
    ensureReachable: () => {},
    bridge,
    tabId: "bound-tab",
    panelConnectionIdentity: () =>
      opts.noBaseline ? undefined : { generation: 7, tabSessionId: "sess-1996" },
    awaitPostRestartReachable: async (
      before: { generation: number; tabSessionId: string } | undefined,
      budgetMs?: number,
    ) => {
      reconnectCalls.push({ before, budgetMs });
      return opts.tabReturns;
    },
    tabCanMutateGraph: () => true,
  } as unknown as PanelToolCtx;
  return { ctx, reconnectCalls };
}

function rebootHandler() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_restart_comfyui");
  if (!def) throw new Error("panel_restart_comfyui not found");
  return def.handler;
}

beforeEach(() => {
  resetClient.mockClear();
  resetObjectInfoCache.mockClear();
  getSystemStats.mockReset();
  getSystemStats.mockImplementation(async () => {
    throw new Error("ECONNRESET");
  });
  __panelToolsTestHooks.setLocalRestartPreflight(async () => ({ ok: true }));
  // A budget the boot outruns: the endpoint is refused for the whole window,
  // which is the reporter's shape scaled down from 127 s to 120 ms.
  __panelToolsTestHooks.setPanelRebootTiming({
    settleMs: 0,
    budgetMs: 120,
    intervalMs: 5,
    probeTimeoutMs: 10,
  });
  __panelToolsTestHooks.setHealthProbe(async () => "down");
});

afterEach(() => {
  __panelToolsTestHooks.setPanelRebootTiming(null);
  __panelToolsTestHooks.setHealthProbe(null);
  __panelToolsTestHooks.setLocalRestartPreflight(null);
  __panelToolsTestHooks.setReconnectWaitTiming(null);
});

describe("#1996 a boot slower than the readiness budget must not forfeit the tab-reconnect wait", () => {
  it("REPRODUCTION: the reconnect wait is ENTERED even though readiness expired", async () => {
    // Pre-fix this array is EMPTY: `awaitPostRestartReachable` sits after
    // `if (!recovery.ready) return …`, so the reporter's 127 s window did not
    // merely fail to certify the boot — it never looked at the tab at all, and
    // never ran the `ensureReachable()` heal that rebinds the session onto a
    // returning tab.
    const { ctx, reconnectCalls } = makeCtx({ tabReturns: false });

    const out = parse(await rebootHandler()({ force: false }, ctx));

    expect(reconnectCalls.length).toBe(1);
    // Watched with a REAL budget, not a starved zero — the readiness observation
    // must leave room for it inside the whole-handler deadline.
    expect(reconnectCalls[0]!.budgetMs ?? 0).toBeGreaterThan(0);
    // …and it was handed the identity captured BEFORE the dispatch, so a stale
    // pre-restart socket can never satisfy it.
    expect(reconnectCalls[0]!.before).toEqual({ generation: 7, tabSessionId: "sess-1996" });

    // THE REFUSAL IS UNCHANGED. An unobserved boot is still an unobserved boot.
    expect(out.ready).toBe(false);
    expect(out.confirmed_cycle).toBe(false);
    expect(out.server_ready).toBe(false);
    expect(out.saw_down).toBe(true);
    expect(String(out.note)).toMatch(/has not become healthy within/);
    expect(String(out.note)).toMatch(/do NOT assume it is back/);
    // The tab was watched and did not come back — a real observation, reported.
    expect(out.panel_tab_reconnected).toBe(false);
  });

  it("a tab that DOES re-register is reported, without upgrading the boot to a success", async () => {
    // The dangerous fix here is turning an honest refusal into a false success.
    // A returning tab says the panel socket is routable again; it says NOTHING
    // about whether THIS ComfyUI instance completed a down→up cycle, which is the
    // only thing `confirmed_cycle`/`server_ready` may ever assert.
    const { ctx, reconnectCalls } = makeCtx({ tabReturns: true });

    const out = parse(await rebootHandler()({ force: false }, ctx));

    expect(reconnectCalls.length).toBe(1);
    expect(out.panel_tab_reconnected).toBe(true);
    expect(out.confirmed_cycle).toBe(false);
    expect(out.server_ready).toBe(false);
    expect(out.ready).toBe(false); // graph tools stay withheld on an unproven boot
    expect(String(out.note)).toMatch(/do NOT assume it is back/);
    // It must not claim the server is healthy anywhere.
    expect(String(out.note)).not.toMatch(/healthy again/);
  });

  it("no pre-restart baseline ⇒ the reconnect stays 'unknown', never a bare false", async () => {
    // #654's distinction survives the reordering: `false` must keep meaning
    // "watched, did not come back" and never "nothing was watched".
    const { ctx } = makeCtx({ tabReturns: false, noBaseline: true });

    const out = parse(await rebootHandler()({ force: false }, ctx));

    expect(out.panel_tab_reconnected).toBe("unknown");
    expect(out.ready).toBe(false);
  });
});

describe("#1996 the readiness budget", () => {
  it("defaults above the window the reporter measured as still-down", () => {
    const prev = process.env.COMFYUI_PANEL_REBOOT_BUDGET_S;
    try {
      delete process.env.COMFYUI_PANEL_REBOOT_BUDGET_S;
      const t = __panelToolsTestHooks.computeRebootTimingFromEnv();
      // The reporter's own measurement: the port was still refused at 127.25 s.
      // A default of 120 s could not have observed that boot however healthy it
      // became a second later.
      expect(t.budgetMs).toBeGreaterThan(127_254);
      expect(t.budgetMs).toBe(180_000);
    } finally {
      if (prev === undefined) delete process.env.COMFYUI_PANEL_REBOOT_BUDGET_S;
      else process.env.COMFYUI_PANEL_REBOOT_BUDGET_S = prev;
    }
  });

  it("still fits the whole-handler deadline WITH the reconnect wait reserved", () => {
    const prev = process.env.COMFYUI_PANEL_REBOOT_BUDGET_S;
    try {
      delete process.env.COMFYUI_PANEL_REBOOT_BUDGET_S;
      const t = __panelToolsTestHooks.computeRebootTimingFromEnv();
      const reconnect = __panelToolsTestHooks.getReconnectWaitTiming();
      // OVERALL_MAX_MS is 255 s. Readiness + the reconnect wait it must not eat,
      // plus a ≥30 s allowance for the confirmation card, the reboot ack and the
      // post-restart argv read, has to stay inside it — this is the arithmetic
      // that picks 180 s rather than the 240 s env ceiling.
      expect(t.budgetMs + reconnect.budgetMs + 30_000).toBeLessThanOrEqual(255_000);
    } finally {
      if (prev === undefined) delete process.env.COMFYUI_PANEL_REBOOT_BUDGET_S;
      else process.env.COMFYUI_PANEL_REBOOT_BUDGET_S = prev;
    }
  });

  it("the env ceiling can no longer starve the reconnect wait", () => {
    // 240 s of readiness inside a 255 s handler leaves 15 s, and the pre-fix code
    // handed `overallDeadline - Date.now()` straight to the reconnect wait — so
    // the value the file called safe was exactly the one that silently zeroed it.
    // The reservation is what makes the ceiling honest.
    const overallDeadline = 255_000;
    const reserve = 35_000;
    expect(
      __panelToolsTestHooks.readinessDeadlineWithReconnectReserve({
        now: 0,
        budgetMs: 240_000,
        overallDeadline,
        reserveMs: reserve,
      }),
    ).toBe(overallDeadline - reserve);
    // It never pushes the deadline into the past, and it never EXTENDS a budget
    // that already fits.
    expect(
      __panelToolsTestHooks.readinessDeadlineWithReconnectReserve({
        now: 0,
        budgetMs: 180_000,
        overallDeadline,
        reserveMs: reserve,
      }),
    ).toBe(180_000);
    expect(
      __panelToolsTestHooks.readinessDeadlineWithReconnectReserve({
        now: 250_000,
        budgetMs: 180_000,
        overallDeadline,
        reserveMs: reserve,
      }),
    ).toBe(250_000);
  });
});

// ---------------------------------------------------------------------------
// WIRING. The reservation is a ONE-LINE assignment at the call site, and a
// helper-only suite survives that call site being reverted to
// `Math.min(Date.now() + timing.budgetMs, overallDeadline)` — which type-checks,
// reads exactly like the code it replaced, and restores the starvation in full.
// (#1971 in this repo sat unreached for releases for precisely that reason.) The
// behavioural half of this cannot be driven without a ~250s handler, so the call
// site is asserted directly.
// ---------------------------------------------------------------------------
describe("#1996 WIRING: the bound readiness deadline goes through the reserve", () => {
  const src = (): string => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    return readFileSync(new URL("../../orchestrator/panel-tools.ts", import.meta.url), "utf8");
  };

  it("the bound path assigns gate.deadline via the reserve, with the LIVE reconnect budget", () => {
    const s = src();
    expect((s.match(/gate\.deadline = readinessDeadlineWithReconnectReserve\(\{/g) ?? []).length).toBe(1);
    // Reading the reserve from reconnectWaitTiming() is what keeps it correct when a
    // user raises COMFYUI_PANEL_RECONNECT_WAIT_S; a hard-coded 35_000 would silently
    // under-reserve for them.
    // Exactly ONE unreserved `gate.deadline` assignment survives: the REMOTE branch,
    // which returns without ever waiting for a tab, so it has nothing to reserve for.
    expect(
      (s.match(/gate\.deadline = Math\.min\(Date\.now\(\) \+ timing\.budgetMs, overallDeadline\);/g) ?? [])
        .length,
    ).toBe(1);
  });

  it("BOTH restart paths clamp their observation with the SAME reserve (r1 codex P1)", () => {
    // The review finding was not that the reserve was wrong — it was that it did not
    // FOLLOW to the legacy/headless path, whose `proofDeadline` computed its own
    // unreserved `Math.min(Date.now() + legacyProofWindow, overallDeadline)` and
    // reproduced the identical starvation. This is the per-call-site adoption gap that
    // left #1971's version probe unreached for releases, so it is pinned as a COUNT of
    // adopting call sites rather than as "the bound one is correct".
    const s = src();
    expect((s.match(/readinessDeadlineWithReconnectReserve\(\{/g) ?? []).length).toBe(2);
    // Both read the LIVE reconnect budget rather than a hard-coded 35_000, so raising
    // COMFYUI_PANEL_RECONNECT_WAIT_S reserves more on BOTH paths, not one.
    expect((s.match(/reserveMs: reconnectWaitTiming\(\)\.budgetMs/g) ?? []).length).toBe(2);
    // The exact pre-fix expression on the headless path must be gone entirely.
    expect(
      /const proofDeadline = Math\.min\(Date\.now\(\) \+ legacyProofWindow, overallDeadline\);/.test(s),
      "the headless proof deadline is unreserved again",
    ).toBe(false);
  });

  it("neither restart path gates the reconnect wait on the readiness verdict any more", () => {
    // The exact pre-fix shape on the headless path. Its behavioural coverage lives in
    // panel-restart-legacy-fallback.test.ts; this catches a re-introduction anywhere.
    expect(/const tabBack = recovery\.ready\s*\n?\s*\?/.test(src())).toBe(false);
  });
});
