// Residuals of the panel session/tab-binding cluster left after PR #587
// (tab-id migration + stable resume). These cover the "Connected: none" window a
// full ComfyUI restart / soft-reload opens, in which the browser's own socket has
// not re-hello'd yet — the defining condition of:
//   - mcp-panel #400: graph tools "no connected tab … Connected: none" right after
//     a restart-completion event (the single ~400ms retry always loses the race);
//   - mcp-panel #402: panel_open_workflow / panel_save_workflow fire into a dead
//     binding and return OUTCOME UNKNOWN / "Failed to fetch";
//   - mcp #474: panel_set_workflow_target({mode:"current"}) — the documented
//     recovery signal — hard-fails when zero tabs are connected instead of clearing
//     the stale binding and following the tab once one reconnects.
// The shared fix is a bounded pre-send `ctx.awaitReachable()` that waits out that
// window and rebinds a current-mode session onto the reconnected tab.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetPanelBaseCache } from "../../services/panel-workspace.js";

const resetClient = vi.fn();
const resetObjectInfoCache = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: () => resetClient(),
  resetObjectInfoCache: () => resetObjectInfoCache(),
}));

const { buildPanelToolDefs, makePanelToolCtx, __panelToolsTestHooks, __openWorkflowTestHooks } =
  await import("../../orchestrator/panel-tools.js");
import { getBootLocalComfyUIBaseUrl } from "../../config.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import { markCapabilityRefusal, markDispatched } from "../../services/ui-bridge.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const BOOT_BASE = (getBootLocalComfyUIBaseUrl() ?? "http://127.0.0.1:8188").replace(/\/+$/, "");
const defByName = (name: string) => {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`${name} not found`);
  return def;
};
const parse = (res: ToolResult): Record<string, unknown> =>
  JSON.parse(res.content.find((c) => c.type === "text")!.text as string);
const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text;

/**
 * A bridge modelling the ONE fact that matters here: which tab ids are live, as a
 * MUTABLE set the test can flip mid-flight (a tab reconnecting after a restart).
 * `tabs()` + `canReach` + `resolveActiveTabId` mirror the real UiBridge helpers, so
 * `awaitReachable`/`ensureReachable` behave exactly as in production.
 */
function reconnectingBridge(initial: string[] = []) {
  const live = new Set(initial);
  const headless = new Set<string>(); // tab ids that are canvas-less viewers
  const sent: Array<{ cmd: Record<string, unknown>; tabId?: string }> = [];
  const bridge = {
    send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
      const id = opts?.tabId;
      if (id && !live.has(id)) {
        // Mirror the REAL UiBridge.resolveTarget refusal: it rejects BEFORE any socket
        // write, LISTS the actually-connected tabs (not "none" when others are live), and
        // carries the authoritative typed dispatched:false flag the tool layer keys on.
        const connected = [...live].map((t) => `${t.slice(0, 8)} ("${t}")`).join(", ") || "none";
        throw markDispatched(new Error(`no connected tab with id "${id}". Connected: ${connected}`), false);
      }
      sent.push({ cmd, tabId: id });
      // workflow_list answers the open-verify probe with `active` = the routed tab.
      if (cmd.cmd === "workflow_list") {
        return { workflows: [...live].map((t) => ({ key: t, active: true })), active: { key: id } };
      }
      return { ok: true, routedTo: id };
    },
    push: () => 1,
    canReach: (id: string) => live.has(id),
    isHeadless: (id: string) => headless.has(id),
    tabs: () => [...live].map((t) => ({ tab_id: t, title: t, connected_at: 0 })),
    resolveActiveTabId: () => {
      if (live.size === 1) return [...live][0];
      if (live.size === 0) throw new Error("Panel not reachable: no panel connected");
      throw new Error("Multiple panel tabs are connected and none is last active — pass tab_id.");
    },
  } as unknown as PanelToolCtx["bridge"];
  return { bridge, live, headless, sent };
}

beforeEach(() => {
  // #1222 - the panel-base cache is module-level. Its production guards
  // (target key, target generation, 60s TTL) never fire inside one test file,
  // so a resolution primed by one test is inherited by the next -- and
  // panelRecoveryContext() reads it to choose between two ENTIRELY different
  // remedies, making which assertion passes depend on execution order.
  //
  // Per FILE, not global: a setup file cannot import this module, because
  // setupFiles runs before per-suite vi.mock factories apply and the early
  // import resolves against the real environment instead. Copied from
  // panel-recovery-cluster.test.ts, which does this correctly and is not
  // one of the flaky files.
  __resetPanelBaseCache();
  // Keep the reconnect wait fast so tests don't sit through the real ~35s budget.
  __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 500, intervalMs: 5 });
  // The #742 refuse-safe preflight passes by default here (the live one would
  // probe real processes/ports); these tests exercise the post-dispatch paths.
  __panelToolsTestHooks.setLocalRestartPreflight(async () => ({ ok: true }));
});
afterEach(() => {
  __panelToolsTestHooks.setReconnectWaitTiming(null);
  __panelToolsTestHooks.setRetrySettleMs(null);
  __panelToolsTestHooks.setLocalRestartPreflight(null);
  __openWorkflowTestHooks.setOpenVerifyTiming(null);
  resetClient.mockClear();
  resetObjectInfoCache.mockClear();
});

describe("awaitReachable primitive (#400/#402)", () => {
  it("returns immediately (no wait) for a HEALTHY session", async () => {
    const { bridge } = reconnectingBridge(["live-tab"]);
    const ctx = makePanelToolCtx(bridge, "live-tab", new WorkflowTargetStore());
    const t0 = Date.now();
    await expect(ctx.awaitReachable!()).resolves.toBe(true);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("WAITS out the 0-tab window, then rebinds onto the reconnected tab", async () => {
    const { bridge, live } = reconnectingBridge([]); // Connected: none
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", new WorkflowTargetStore());
    setTimeout(() => live.add("reconnected-tab"), 40); // the browser re-hellos
    const ok = await ctx.awaitReachable!();
    expect(ok).toBe(true);
    expect(ctx.tabId).toBe("reconnected-tab"); // rebound onto the live tab
  });

  it("gives up (false) if nothing reconnects within budget — never hangs", async () => {
    const { bridge } = reconnectingBridge([]);
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", new WorkflowTargetStore());
    const ok = await ctx.awaitReachable!(60);
    expect(ok).toBe(false);
    expect(ctx.tabId).toBe("stale-tmp-tab"); // never guessed a tab
  });

  it("does NOT rebind onto an AMBIGUOUS multi-tab reconnect (strict-single)", async () => {
    const { bridge, live } = reconnectingBridge([]);
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", new WorkflowTargetStore());
    setTimeout(() => {
      live.add("a-tab");
      live.add("b-tab");
    }, 20);
    const ok = await ctx.awaitReachable!();
    expect(ok).toBe(false); // refuses to guess among 2 tabs
    expect(ctx.tabId).toBe("stale-tmp-tab");
  });

  it("returns FAST (does not spin the budget) when interactive tabs exist but can't bind — stale multi-tab", async () => {
    __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 5000, intervalMs: 50 });
    const { bridge } = reconnectingBridge(["a-tab", "b-tab"]); // 2 interactive, none is ours
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", new WorkflowTargetStore());
    const t0 = Date.now();
    const ok = await ctx.awaitReachable!();
    expect(ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000); // did NOT wait the 5s budget
  });

  it("returns FAST for a stale PINNED session with a sole reconnected canvas (no stall)", async () => {
    __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 5000, intervalMs: 50 });
    const { bridge } = reconnectingBridge(["desktop-canvas"]);
    const store = new WorkflowTargetStore();
    store.set("stale-pinned-tab", { mode: "pinned", path: "workflows/p.json" });
    const ctx = makePanelToolCtx(bridge, "stale-pinned-tab", store);
    const t0 = Date.now();
    const ok = await ctx.awaitReachable!();
    expect(ok).toBe(false); // pinned stays strict — not silently rebound
    expect(Date.now() - t0).toBeLessThan(1000); // and does not stall the budget
  });

  it("does NOT bind onto a lone HEADLESS (canvas-less) reconnect — returns false", async () => {
    const { bridge, live, headless } = reconnectingBridge([]);
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", new WorkflowTargetStore());
    // Only a mobile mirror / remote viewer reconnects — it has no canvas.
    setTimeout(() => {
      live.add("headless-viewer");
      headless.add("headless-viewer");
    }, 30);
    const ok = await ctx.awaitReachable!(150);
    expect(ok).toBe(false); // canvas-less → not a usable graph binding
    expect(ctx.tabId).toBe("stale-tmp-tab"); // never bound onto the headless viewer
  });

  it("binds onto the DESKTOP canvas tab when it reconnects (ignoring a headless viewer alongside)", async () => {
    const { bridge, live, headless } = reconnectingBridge([]);
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", new WorkflowTargetStore());
    // The canvas tab comes back; no headless viewer present → sole interactive tab.
    setTimeout(() => live.add("desktop-canvas"), 30);
    void headless; // (documents intent: no headless entry added here)
    const ok = await ctx.awaitReachable!();
    expect(ok).toBe(true);
    expect(ctx.tabId).toBe("desktop-canvas");
  });
});

describe("#402 panel_save_workflow awaits a stable binding before dispatch", () => {
  it("waits out the restart window, then saves against the reconnected tab", async () => {
    const { bridge, live, sent } = reconnectingBridge([]);
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", new WorkflowTargetStore());
    setTimeout(() => live.add("reconnected-tab"), 40);
    const res = await defByName("panel_save_workflow").handler({}, ctx);
    expect(res.isError).toBeFalsy();
    // Locate the SAVE frame by name rather than by position: #1045 added a
    // `workflow_list` fence probe after each save, so the save is no longer last.
    // What this test is about is which TAB the save reached.
    const save = sent.find((s) => (s.cmd as { cmd?: string })?.cmd === "workflow_save");
    expect(save?.cmd).toMatchObject({ cmd: "workflow_save" });
    expect(save?.tabId).toBe("reconnected-tab"); // never fired into the dead binding
  });

  it("REFUSES (zero sends) when no tab reconnects within budget — never dispatches into a dead binding", async () => {
    const { bridge, sent } = reconnectingBridge([]); // stays Connected: none
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", new WorkflowTargetStore());
    const res = await defByName("panel_save_workflow").handler({ name: "new" }, ctx);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no reachable panel tab|Nothing was\s+sent/i);
    expect(sent.length).toBe(0); // the mutating save was never dispatched
  });

  it("panel_open_workflow also REFUSES (zero sends) when nothing reconnects", async () => {
    const { bridge, sent } = reconnectingBridge([]);
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", new WorkflowTargetStore());
    const res = await defByName("panel_open_workflow").handler({ path: "workflows/x.json" }, ctx);
    expect(res.isError).toBe(true);
    expect(sent.length).toBe(0);
  });
});

describe("#402 panel_open_workflow verifies a mid-command reconnect DROP (OUTCOME UNKNOWN)", () => {
  it("turns an OUTCOME-UNKNOWN drop into a confirmed open via workflow_list", async () => {
    __openWorkflowTestHooks.setOpenVerifyTiming({ budgetMs: 200, intervalMs: 5, probeTimeoutMs: 50 });
    const live = new Set(["live-tab"]);
    let dropped = false;
    const bridge = {
      send: async (
        cmd: Record<string, unknown>,
        opts?: { tabId?: string; onDispatchedRid?: (rid: string) => void },
      ) => {
        if (cmd.cmd === "workflow_open") {
          opts?.onDispatchedRid?.("open-rid-402");
          if (!dropped) {
            dropped = true;
            // The write landed but the socket died before a reply — the bridge's
            // canonical POST-write mutating drop.
            throw new Error(
              'panel tab live-tab disconnected mid-command ("workflow_open") — OUTCOME UNKNOWN: the command was already sent',
            );
          }
        }
        if (cmd.cmd === "workflow_list") {
          // After the drop, only the exact request-id receipt confirms the open.
          return {
            workflows: [{ key: "wf:workflows/x.json", active: true }],
            active: { path: "workflows/x.json" },
            active_confirmed: true,
            last_open: {
              rid: "open-rid-402",
              answers_only_command_rid: "open-rid-402",
              cmd: "workflow_open",
              requested: "workflows/x.json",
              resolved: { path: "workflows/x.json", filename: "x.json", routing_key: "wf:workflows/x.json" },
              applied: true,
            },
          };
        }
        return { ok: true, routedTo: opts?.tabId };
      },
      push: () => 1,
      canReach: (id: string) => live.has(id),
      tabs: () => [...live].map((t) => ({ tab_id: t, title: t, connected_at: 0 })),
      resolveActiveTabId: () => [...live][0],
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "live-tab", new WorkflowTargetStore());

    const res = await defByName("panel_open_workflow").handler({ path: "workflows/x.json" }, ctx);
    expect(res.isError).toBeFalsy();
    const out = parse(res);
    expect(out.recovered).toBe(true);
    expect(out.opened).toMatchObject({ path: "workflows/x.json" });
  });

  it("a PRE-write 'NOT dispatched' failure is NOT re-verified (surfaced as-is)", async () => {
    __openWorkflowTestHooks.setOpenVerifyTiming({ budgetMs: 200, intervalMs: 5, probeTimeoutMs: 50 });
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        if (cmd.cmd === "workflow_open") {
          throw new Error('failed to send "workflow_open" — the command was NOT dispatched (socket write failed)');
        }
        return { ok: true };
      },
      push: () => 1,
      canReach: () => true,
      tabs: () => [{ tab_id: "live-tab", title: "t", connected_at: 0 }],
      resolveActiveTabId: () => "live-tab",
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "live-tab", new WorkflowTargetStore());
    const res = await defByName("panel_open_workflow").handler({ path: "workflows/x.json" }, ctx);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/NOT dispatched/i);
  });
});

describe("#474 panel_set_workflow_target({mode:'current'}) recovery", () => {
  it("DEFERS (does not hard-fail) when zero tabs are connected, clearing the stale binding", async () => {
    const { bridge } = reconnectingBridge([]); // Connected: none — nothing to bind yet
    const store = new WorkflowTargetStore();
    store.set("stale-tmp-tab", { mode: "pinned", path: "workflows/old.json" });
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", store);

    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    expect(res.isError).toBeFalsy();
    const out = parse(res);
    expect(out.deferred).toBe(true);
    expect(out.mode).toBe("current"); // stale pin released
    expect(textOf(res)).toMatch(/reconnect/i);
  });

  it("binds immediately when a tab reconnects during the recovery call", async () => {
    const { bridge, live } = reconnectingBridge([]);
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", new WorkflowTargetStore());
    setTimeout(() => live.add("reconnected-tab"), 40);
    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(ctx.tabId).toBe("reconnected-tab");
    expect(textOf(res)).toContain("Rebound this session");
  });

  it("still FAILS (no defer) when the rebind is AMBIGUOUS among multiple live tabs", async () => {
    const { bridge } = reconnectingBridge(["a-tab", "b-tab"]);
    const ctx = makePanelToolCtx(bridge, "dead-tab", new WorkflowTargetStore());
    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    expect(res.isError).toBe(true);
    // #971 — this used to match the BRIDGE's raw /Multiple panel tabs/, which ended
    // "— pass tab_id". This tool has no tab_id parameter and #754 strict schemas make
    // an unknown key a hard error, so that instruction could not be followed and the
    // session had no exit. The refusal is unchanged (still fails, still does not
    // defer, still does not guess); only its wording is now actionable.
    expect(textOf(res)).toMatch(/Several ComfyUI tabs are connected/i);
    expect(textOf(res)).not.toMatch(/pass tab_id/i);
    expect(ctx.tabId).toBe("dead-tab");
  });

  it("DEFERS (never binds headless) when the only connected client is a headless viewer", async () => {
    const { bridge, live, headless } = reconnectingBridge([]);
    live.add("headless-viewer");
    headless.add("headless-viewer"); // sole connection is canvas-less
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", new WorkflowTargetStore());
    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(parse(res).deferred).toBe(true); // treated as "nothing bindable yet"
    expect(ctx.tabId).toBe("stale-tmp-tab"); // NEVER bound onto the headless viewer
  });

  it("binds the DESKTOP canvas tab when a headless viewer is also connected", async () => {
    const { bridge, live, headless } = reconnectingBridge([]);
    live.add("desktop-canvas");
    live.add("phone-mirror");
    headless.add("phone-mirror"); // one canvas tab + one headless viewer
    const ctx = makePanelToolCtx(bridge, "dead-tab", new WorkflowTargetStore());
    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(ctx.tabId).toBe("desktop-canvas"); // bound the sole interactive tab, not the mirror
  });

});

describe("headless-aware reconnect recovery (#400/#402)", () => {
  it("panel_reload of a STALE session binds the sole desktop tab when a headless viewer is also open (not 'multiple tabs')", async () => {
    const { bridge, live, headless } = reconnectingBridge([]);
    live.add("desktop-canvas");
    live.add("phone-mirror");
    headless.add("phone-mirror");
    const ctx = makePanelToolCtx(bridge, "dead-tab", new WorkflowTargetStore());
    const res = await defByName("panel_reload").handler({}, ctx);
    // The ambiguity guard counts only interactive tabs, so desktop+headless is NOT
    // ambiguous — it rebinds onto the sole canvas tab and dispatches.
    expect(textOf(res)).not.toMatch(/multiple tabs/i);
    expect(ctx.tabId).toBe("desktop-canvas");
  });
});

describe("#442 defect 4: a MUTATING panel command names the rebind on a no-route refusal", () => {
  it("panel_set_widget surfaces an actionable rebind hint (not the bare bridge error) when its tab is gone and the session is multi-tab", async () => {
    // Two interactive tabs are live but NEITHER is this session's — the strict-single
    // silent auto-heal (ensureReachable) refuses to guess, so the send fires into a dead
    // binding and the bridge REFUSES BEFORE dispatch (typed dispatched:false). This is the
    // exact condition a user hit ~6× with panel_set_widget while panel_list_workflows still
    // answered (the two channels briefly disagree after a reconnect).
    const { bridge, sent } = reconnectingBridge(["a-tab", "b-tab"]);
    const ctx = makePanelToolCtx(bridge, "dead-tab", new WorkflowTargetStore());

    const res = await defByName("panel_set_widget").handler(
      { node_id: 7, widget: "steps", value: 20 },
      ctx,
    );
    expect(res.isError).toBe(true);
    const text = textOf(res);
    // Names the documented recovery call (parity with the retry-safe graph_get_errors path).
    expect(text).toContain('panel_set_workflow_target({mode:"current"})');
    // A pre-dispatch no-route refusal provably applied nothing — say so, and never retry it.
    expect(text).toMatch(/Nothing was applied/i);
    // The raw bridge cause is preserved (and, faithfully, lists the live tabs — not "none").
    expect(text).toMatch(/no connected tab with id "dead-tab"/);
    expect(sent.length).toBe(0); // the mutating write was NEVER dispatched (no double-apply)
  });

  it("#709: a CAPABILITY refusal surfaces its own guidance verbatim — no futile retry/rebind suffix", async () => {
    // The connected tab runs a stale panel bundle (no workflow-stamp enforcement).
    // The bridge refuses pre-dispatch with the SAME typed dispatched:false flag as a
    // transient no-route — but the generic "retry / rebind with
    // panel_set_workflow_target({mode:"current"})" wrapper can never clear a missing
    // capability, contradicts the refusal's own text, and sent agents into a loop.
    const capabilityCause = markCapabilityRefusal(
      markDispatched(
        new Error(
          `"graph_set_widget" cannot be safely targeted to the active workflow: panel tab ` +
            `wf:workflows/x.json does not enforce per-command workflow targeting (detected panel ` +
            `0.11.20; this MCP requires panel 0.11.35+). Run install_comfyui(action:'panel', panel_action:'update'), ` +
            `restart ComfyUI, then hard-refresh the ComfyUI browser tab (Ctrl+Shift+R); rebinding ` +
            `cannot add the missing capability. Read-only graph commands still work.`,
        ),
        false,
      ),
    );
    const live = new Set(["wf:workflows/x.json"]);
    const sent: Array<{ cmd: Record<string, unknown> }> = [];
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
        if (opts?.tabId && !live.has(opts.tabId)) throw new Error("unexpected route");
        throw capabilityCause; // the gate's pre-dispatch refusal
      },
      push: () => 1,
      canReach: (id: string) => live.has(id),
      tabs: () => [...live].map((t) => ({ tab_id: t, title: t, connected_at: 0 })),
      resolveActiveTabId: () => [...live][0],
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "wf:workflows/x.json", new WorkflowTargetStore());

    const res = await defByName("panel_set_widget").handler(
      { node_id: 7, widget: "steps", value: 20 },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(sent.length).toBe(0); // pre-dispatch: nothing was sent
    const text = textOf(res);
    // The refusal's own, correct recovery is surfaced…
    expect(text).toMatch(/hard-refresh the ComfyUI browser tab/);
    expect(text).toMatch(/rebinding cannot add the missing capability/);
    // …and the contradictory generic advice is NOT appended.
    expect(text).not.toContain('rebind with panel_set_workflow_target({mode:"current"})');
    expect(text).not.toMatch(/Retry in a moment/);
  });

  it("#709/#1331: a NO-IDENTITY refusal carries an actionable recovery, now MEASURED", async () => {
    // Same gate, THIRD branch: the panel enforces the stamp but the workflow has no
    // trusted identity to fence against. The error is dispatched:false but deliberately
    // NOT capability-marked, so this must NOT be left bare — #709's requirement, and it
    // still holds.
    //
    // WHAT CHANGED (#1331), and why this test moved with it. #709 asserted the LITERAL
    // generic wrapper, "rebind with panel_set_workflow_target({mode:'current'})". Two
    // different states produce this identical message and they need opposite remedies:
    // when the session is bound to a stale tab and the LIVE canvas has an identity, the
    // rebind genuinely re-resolves it; when the live canvas has none, the rebind reads
    // an identity to adopt, finds none, and reports success while every mutation keeps
    // failing. The reporter of #1331 got the second and followed the advice for the
    // first, costing four calls to reach a state the panel already believed it was in.
    //
    // So the orchestrator now MEASURES which state it is in rather than printing one
    // remedy for both. The requirement #709 protects — an actionable recovery, the
    // cause preserved, nothing applied — is unchanged and asserted below.
    //
    // The bridge also had to become realistic: it used to throw the identity refusal
    // for EVERY command, including workflow_list. That state cannot occur — the
    // refusal's own text says read-only commands still work — and it is what a
    // re-derivation reads.
    const identityCause = markDispatched(
      new Error(
        `"graph_set_widget" cannot be safely targeted to the active workflow: this workflow ` +
          `has no trusted identity for the panel to fence the command against. Read-only graph ` +
          `commands (graph_outline, graph_query, graph_get_state) still work.`,
      ),
      false,
    );
    const live = new Set(["wf:workflows/x.json"]);
    const sent: Array<{ cmd: Record<string, unknown> }> = [];
    const LIVE_UUID = "44444444-4444-4444-8444-444444444444";
    let listCalls = 0;
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
        if (opts?.tabId && !live.has(opts.tabId)) throw new Error("unexpected route");
        if (cmd.cmd === "workflow_list") {
          // #709's actual state: the LIVE canvas does have an identity, so the rebind
          // can re-resolve it — which is precisely why retry/rebind was right here.
          listCalls += 1;
          const active = {
            path: "workflows/x.json",
            routing_key: "wf:workflows/x.json",
            workflow_uuid: LIVE_UUID,
          };
          return { active, workflows: [{ ...active, active: true }], active_confirmed: true };
        }
        throw identityCause;
      },
      push: () => 1,
      canReach: (id: string) => live.has(id),
      isHeadless: () => false,
      tabs: () => [...live].map((t) => ({ tab_id: t, title: t, connected_at: 0 })),
      resolveActiveTabId: () => [...live][0],
      refreshWorkflowUuid: () => true,
      // panel#1339 — THE HARNESS WAS DESCRIBING A STATE THE BRIDGE CANNOT BE IN, and the
      // collapsed message is what hid it. This said `{ known: true, uuid: LIVE_UUID }`:
      // a fence PRESENT on this tab and already equal to the live canvas. But the
      // refusal above is raised only when `resolveTabWorkflowUuid(tabId)` is EMPTY
      // (ui-bridge: `hasTrustedStamp` false), and `workflowUuidFor` reads that same
      // resolver — so a real bridge cannot refuse with "no trusted identity" AND report
      // a fence for the same tab in the same breath.
      //
      // With that shape the rebind returned `already_current`, not `refreshed` — the
      // opposite state — and the assertions below still passed, because ONE sentence
      // covered both. The test was pinning the wrong branch and could not tell.
      // `{ known: true }` is the read that matches the refusal: the fence is definitively
      // ABSENT (FenceRead's own contract), which is #709's state and yields `refreshed`.
      workflowUuidFor: () => ({ known: true }),
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "wf:workflows/x.json", new WorkflowTargetStore());

    const res = await defByName("panel_set_widget").handler(
      { node_id: 7, widget: "steps", value: 20 },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(sent.length).toBe(0);
    const text = textOf(res);
    expect(text).toMatch(/no trusted identity/); // the cause is preserved…
    // …the live canvas was actually re-read — not asserted from text alone…
    expect(listCalls).toBeGreaterThan(0);
    // …and the recovery is the one that fits THIS state: the fence was re-derived, so
    // the caller retries rather than being sent to re-open a workflow that is fine.
    expect(text).toMatch(/CHECKED: the live canvas DOES carry an identity/);
    expect(text).toContain(LIVE_UUID);
    expect(text).toMatch(/RETRY THIS EXACT CALL ONCE/);
    // panel#1339 — and pin WHICH branch produced that, structurally. Asserting only on
    // the sentence is how this test silently drifted onto `already_current` above; the
    // field is the thing that can tell the two apart, so it is what the test reads.
    expect(
      (res.structuredContent as { panel_fence?: { rebind_status?: string } } | undefined)
        ?.panel_fence?.rebind_status,
    ).toBe("refreshed");
  });

  it("does NOT mis-wrap a POST-dispatch executor failure that merely quotes 'no connected tab' as 'nothing applied'", async () => {    // A LIVE tab that ACCEPTS the command (it IS dispatched, pushed to `sent`) but whose
    // executor rejects with a message quoting the routing phrase. Because the typed flag is
    // absent (dispatchOutcomeOf === undefined, not false), the wrapper must NOT fire — the
    // raw executor error surfaces and we never falsely claim nothing applied.
    const live = new Set(["live-tab"]);
    const sent: Array<{ cmd: Record<string, unknown> }> = [];
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
        if (opts?.tabId && !live.has(opts.tabId)) throw new Error("unexpected route");
        sent.push({ cmd }); // the command WAS dispatched
        // Executor reply ok:false becomes a plain Error (no dispatched symbol), text quotes
        // the routing phrase to prove the wrapper keys on the TYPED flag, not the text.
        throw new Error('graph_set_widget failed: internal reference to "no connected tab" in a stale cache');
      },
      push: () => 1,
      canReach: (id: string) => live.has(id),
      tabs: () => [...live].map((t) => ({ tab_id: t, title: t, connected_at: 0 })),
      resolveActiveTabId: () => [...live][0],
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "live-tab", new WorkflowTargetStore());

    const res = await defByName("panel_set_widget").handler(
      { node_id: 7, widget: "steps", value: 20 },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(sent.length).toBe(1); // it really was dispatched
    const text = textOf(res);
    expect(text).not.toMatch(/Nothing was applied/i); // never a false "nothing applied"
    expect(text).toContain("stale cache"); // the raw executor error is surfaced as-is
  });

  it("still self-heals the common SINGLE-tab case (a sole reconnected tab) — set_widget succeeds silently", async () => {
    // Only ONE interactive tab is live (under a new id after a reconnect). The strict-single
    // auto-heal rebinds onto it BEFORE the send, so the ordinary case never even sees the
    // error — the improved message is reserved for the genuinely ambiguous multi-tab case.
    const { bridge, sent } = reconnectingBridge(["sole-tab"]);
    const ctx = makePanelToolCtx(bridge, "dead-tab", new WorkflowTargetStore());

    const res = await defByName("panel_set_widget").handler(
      { node_id: 7, widget: "steps", value: 20 },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(ctx.tabId).toBe("sole-tab"); // rebound onto the sole live tab
    expect(sent.at(-1)?.cmd).toMatchObject({ cmd: "graph_set_widget" });
    expect(sent.at(-1)?.tabId).toBe("sole-tab");
  });
});

describe("#400 panel_restart_comfyui awaits the tab reconnect before returning", () => {
  beforeEach(() => {
    __panelToolsTestHooks.setPanelRebootTiming({ settleMs: 0, budgetMs: 200, intervalMs: 5, probeTimeoutMs: 20 });
  });
  afterEach(() => {
    __panelToolsTestHooks.setPanelRebootTiming(null);
    __panelToolsTestHooks.setHealthProbe(null);
  });

  it("certified ready:true only after the panel tab re-registers, rebinding onto it", async () => {
    // Boot endpoint goes DOWN then HEALTHY → certified observed-cycle.
    const seq = ["down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(i++, seq.length - 1)] as "down" | "healthy");

    const live = new Set<string>(["bound-tab"]);
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
        if (cmd.cmd === "comfy_reboot") {
          // The reboot drops the tab's socket; the browser re-registers a moment later.
          live.delete("bound-tab");
          setTimeout(() => live.add("reconnected-tab"), 40);
          return { rebooting: true };
        }
        const id = opts?.tabId;
        if (id && !live.has(id)) throw new Error(`no connected tab with id "${id}". Connected: none`);
        return { ok: true, routedTo: id };
      },
      push: () => 1,
      canReach: (id: string) => live.has(id),
      tabs: () => [...live].map((t) => ({ tab_id: t, title: t, connected_at: 0 })),
      resolveActiveTabId: () => {
        if (live.size === 1) return [...live][0];
        if (live.size === 0) throw new Error("Panel not reachable: no panel connected");
        throw new Error("Multiple panel tabs are connected and none is last active — pass tab_id.");
      },
      tabOrigin: () => BOOT_BASE,
      tabServerOrigin: () => BOOT_BASE,
      tabIsLocal: () => true,
      tabConnectionIdentity: (id: string) =>
        live.has(id)
          ? { generation: id === "reconnected-tab" ? 2 : 1, tabSessionId: "browser-tab-a" }
          : undefined,
      tabCanMutateGraph: () => true,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "bound-tab", new WorkflowTargetStore());
    ctx.confirm = async () => "yes" as const; // skip the human confirm card

    const out = parse(await defByName("panel_restart_comfyui").handler({ force: false }, ctx));
    expect(out.ready).toBe(true);
    expect(out.server_ready).toBe(true);
    expect(out.confirmed_cycle).toBe(true);
    expect(out.panel_tab_reconnected).toBe(true); // did not hand back a tabless window
    expect(ctx.tabId).toBe("reconnected-tab"); // rebound onto the reconnected tab
  });

  it("does not treat the pre-restart reachable tab as a post-restart reconnect (#709)", async () => {
    __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 60, intervalMs: 5 });
    const seq = ["down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () =>
      seq[Math.min(i++, seq.length - 1)] as "down" | "healthy",
    );

    // The old websocket remains briefly reachable. It has not sent a new hello, so
    // a restart result must not call it a reconnected, graph-ready panel.
    const live = new Set<string>(["bound-tab"]);
    const bridge = {
      send: async () => ({ rebooting: true }),
      push: () => 1,
      canReach: (id: string) => live.has(id),
      tabs: () => [...live].map((t) => ({ tab_id: t, title: t, connected_at: 0 })),
      resolveActiveTabId: () => "bound-tab",
      tabOrigin: () => BOOT_BASE,
      tabServerOrigin: () => BOOT_BASE,
      tabIsLocal: () => true,
      tabConnectionIdentity: (id: string) =>
        live.has(id) ? { generation: 1, tabSessionId: "browser-tab-a" } : undefined,
      tabCanMutateGraph: () => true,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "bound-tab", new WorkflowTargetStore());
    ctx.confirm = async () => "yes" as const;

    const out = parse(await defByName("panel_restart_comfyui").handler({ force: false }, ctx));
    expect(out.server_ready).toBe(true);
    expect(out.panel_tab_reconnected).toBe(false);
    expect(out.graph_tools_ready).toBe(false);
    expect(out.ready).toBe(false);
  });

  it("does not certify a different browser tab that reuses the rebooted workflow id (#709)", async () => {
    __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 60, intervalMs: 5 });
    const seq = ["down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () =>
      seq[Math.min(i++, seq.length - 1)] as "down" | "healthy",
    );

    // The original browser tab receives the reboot. Before it reconnects, a
    // different browser tab opens the same saved workflow, so it has the exact
    // same routing tab id but a new hello generation and its own tab session id.
    // Generation + tab id alone would fabricate ready:true here.
    let generation = 1;
    let tabSessionId = "browser-tab-original";
    const bridge = {
      send: async () => {
        generation = 2;
        tabSessionId = "browser-tab-other";
        return { rebooting: true };
      },
      push: () => 1,
      canReach: () => true,
      tabs: () => [{ tab_id: "wf:shared.json", title: "shared", connected_at: 0 }],
      resolveActiveTabId: () => "wf:shared.json",
      tabOrigin: () => BOOT_BASE,
      tabServerOrigin: () => BOOT_BASE,
      tabIsLocal: () => true,
      tabConnectionIdentity: () => ({ generation, tabSessionId }),
      tabCanMutateGraph: () => true,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "wf:shared.json", new WorkflowTargetStore());
    ctx.confirm = async () => "yes" as const;

    const out = parse(await defByName("panel_restart_comfyui").handler({ force: false }, ctx));
    expect(out.server_ready).toBe(true);
    expect(out.panel_tab_reconnected).toBe(false);
    expect(out.graph_tools_ready).toBe(false);
    expect(out.ready).toBe(false);
  });

  it("does not claim graph tools are ready when the reconnected tab has stale JS", async () => {
    const seq = ["down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () =>
      seq[Math.min(i++, seq.length - 1)] as "down" | "healthy",
    );

    const live = new Set<string>(["bound-tab"]);
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
        if (cmd.cmd === "comfy_reboot") {
          live.delete("bound-tab");
          setTimeout(() => live.add("reconnected-tab"), 40);
          return { rebooting: true };
        }
        const id = opts?.tabId;
        if (id && !live.has(id)) throw new Error(`no connected tab with id "${id}". Connected: none`);
        return { ok: true, routedTo: id };
      },
      push: () => 1,
      canReach: (id: string) => live.has(id),
      tabs: () => [...live].map((t) => ({ tab_id: t, title: t, connected_at: 0 })),
      resolveActiveTabId: () => {
        if (live.size === 1) return [...live][0];
        throw new Error("Panel not reachable: no panel connected");
      },
      tabOrigin: () => BOOT_BASE,
      tabServerOrigin: () => BOOT_BASE,
      tabIsLocal: () => true,
      tabConnectionIdentity: (id: string) =>
        live.has(id)
          ? { generation: id === "reconnected-tab" ? 2 : 1, tabSessionId: "browser-tab-a" }
          : undefined,
      tabCanMutateGraph: () => false, // stale pre-workflow-stamp browser bundle
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "bound-tab", new WorkflowTargetStore());
    ctx.confirm = async () => "yes" as const;

    const out = parse(await defByName("panel_restart_comfyui").handler({ force: false }, ctx));
    expect(out.server_ready).toBe(true);
    expect(out.panel_tab_reconnected).toBe(true);
    expect(out.graph_tools_ready).toBe(false);
    expect(out.ready).toBe(false);
    expect(String(out.note)).toMatch(/stale panel bundle|Hard-refresh.*Ctrl\+Shift\+R/i);
    expect(String(out.note)).not.toMatch(/rebind with panel_set_workflow_target/i);
  });

  it("returns ready:false (server_ready:true) when the panel tab NEVER reconnects", async () => {
    // Keep the reconnect wait short so the test doesn't sit through the budget.
    __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 60, intervalMs: 5 });
    const seq = ["down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(i++, seq.length - 1)] as "down" | "healthy");

    const live = new Set<string>(["bound-tab"]);
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
        if (cmd.cmd === "comfy_reboot") {
          live.delete("bound-tab"); // tab drops and never comes back
          return { rebooting: true };
        }
        const id = opts?.tabId;
        if (id && !live.has(id)) throw new Error(`no connected tab with id "${id}". Connected: none`);
        return { ok: true, routedTo: id };
      },
      push: () => 1,
      canReach: (id: string) => live.has(id),
      tabs: () => [...live].map((t) => ({ tab_id: t, title: t, connected_at: 0 })),
      resolveActiveTabId: () => {
        if (live.size === 1) return [...live][0];
        throw new Error("Panel not reachable: no panel connected");
      },
      tabOrigin: () => BOOT_BASE,
      tabServerOrigin: () => BOOT_BASE,
      tabIsLocal: () => true,
      tabConnectionIdentity: (id: string) =>
        live.has(id) ? { generation: 1, tabSessionId: "browser-tab-a" } : undefined,
      tabCanMutateGraph: () => true,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "bound-tab", new WorkflowTargetStore());
    ctx.confirm = async () => "yes" as const;

    const out = parse(await defByName("panel_restart_comfyui").handler({ force: false }, ctx));
    expect(out.server_ready).toBe(true); // ComfyUI really did cycle
    expect(out.ready).toBe(false); // but graph tools are NOT usable — honest, not a false green
    expect(out.panel_tab_reconnected).toBe(false);
    expect(String(out.note)).toMatch(/has NOT reconnected|rebind/i);
  });
});

// #436 — the flap: after a restart a READ (panel_graph_outline) succeeds while the
// very next WRITE (panel_add_node) fails "no connected tab … Connected: none". Root
// cause: reads survive the "Connected: none" window (parked mid-command + retry-once)
// but the live graph MUTATION tools dispatched via ctx.call with NO pre-send wait, so
// they fired straight into the momentarily-empty tab registry. The fix gates every
// mutating graph edit behind the same bounded awaitReachable() that open/save use —
// centralized in ctx.call so no mutating tool can miss it — while leaving the read
// path untouched.
describe("#436 a MUTATING graph edit awaits the reconnect before dispatch", () => {
  it("waits out the post-restart 0-tab window, then dispatches to the reconnected tab (no flap)", async () => {
    const { bridge, live, sent } = reconnectingBridge([]); // Connected: none
    const ctx = makePanelToolCtx(bridge, "wf:workflows/x.json", new WorkflowTargetStore());
    setTimeout(() => live.add("reconnected-tab"), 40); // the browser re-hellos
    const res = await defByName("panel_add_node").handler({ class_type: "KSampler" }, ctx);
    expect(res.isError).toBeFalsy();
    // The mutating edit was dispatched — and to the RECONNECTED tab, never fired into
    // the dead "Connected: none" binding that produced the flap.
    expect(sent.at(-1)?.cmd).toMatchObject({ cmd: "graph_add_node", class_type: "KSampler" });
    expect(sent.at(-1)?.tabId).toBe("reconnected-tab");
    expect(ctx.tabId).toBe("reconnected-tab"); // rebound onto the live tab
  });

  it("REFUSES with ZERO dispatch when nothing reconnects — never fires into the dead binding", async () => {
    const { bridge, sent } = reconnectingBridge([]); // stays Connected: none
    const ctx = makePanelToolCtx(bridge, "wf:workflows/x.json", new WorkflowTargetStore());
    const res = await defByName("panel_add_node").handler({ class_type: "KSampler" }, ctx);
    expect(res.isError).toBe(true);
    expect(sent.length).toBe(0); // the mutating edit was NEVER dispatched
  });

  it("a HEALTHY session dispatches the edit immediately — no added latency", async () => {
    __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 5000, intervalMs: 50 });
    const { bridge, sent } = reconnectingBridge(["live-tab"]);
    const ctx = makePanelToolCtx(bridge, "live-tab", new WorkflowTargetStore());
    const t0 = Date.now();
    const res = await defByName("panel_add_node").handler({ class_type: "KSampler" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(Date.now() - t0).toBeLessThan(1000); // did NOT wait the 5s budget
    expect(sent.at(-1)?.tabId).toBe("live-tab");
  });

  it("panel_set_widget (also mutating) is gated too — waits then dispatches to the reconnected tab", async () => {
    const { bridge, live, sent } = reconnectingBridge([]);
    const ctx = makePanelToolCtx(bridge, "wf:workflows/x.json", new WorkflowTargetStore());
    setTimeout(() => live.add("reconnected-tab"), 40);
    const res = await defByName("panel_set_widget").handler(
      { node_id: 3, widget: "seed", value: 42 },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(sent.at(-1)?.tabId).toBe("reconnected-tab");
  });

  it("does NOT gate an idempotent READ — graph_outline keeps its existing (non-waiting) path", async () => {
    // A read is NOT a mutating graph edit, so the pre-wait must not apply; with a live
    // tab it simply dispatches through its normal path.
    const { bridge, sent } = reconnectingBridge(["live-tab"]);
    const ctx = makePanelToolCtx(bridge, "live-tab", new WorkflowTargetStore());
    const res = await defByName("panel_graph_outline").handler({}, ctx);
    expect(res.isError).toBeFalsy();
    expect(sent.at(-1)?.cmd).toMatchObject({ cmd: "graph_outline" });
  });

  // Codex-flagged: reads that are NOT in BRIDGE_READONLY_CMDS (so an exclusion rule
  // would have wrongly gated them) must NOT wait out the reconnect budget. With a
  // reconnect that never happens, a gated command would spin the whole budget; these
  // reads must return promptly instead (their existing non-waiting behavior).
  it("does NOT gate graph_list_subgraphs (a read absent from BRIDGE_READONLY_CMDS)", async () => {
    __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 5000, intervalMs: 50 });
    const { bridge } = reconnectingBridge([]); // Connected: none, nothing reconnects
    const ctx = makePanelToolCtx(bridge, "stale-tab", new WorkflowTargetStore());
    const t0 = Date.now();
    const res = await defByName("panel_list_subgraphs").handler({}, ctx);
    // It fails (no tab) — but it must FAIL FAST, never spend the 5s budget waiting.
    expect(res.isError).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("does NOT gate training_get_state (a read absent from BRIDGE_READONLY_CMDS)", async () => {
    __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 5000, intervalMs: 50 });
    const { bridge } = reconnectingBridge([]);
    const ctx = makePanelToolCtx(bridge, "stale-tab", new WorkflowTargetStore());
    const t0 = Date.now();
    const res = await defByName("panel_training_get_state").handler({}, ctx);
    expect(res.isError).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

// #1881 — the other half of #436's flap, on the READ side.
//
// After a full ComfyUI Desktop restart the panel's chat frame is delivered while its
// `hello` (the only writer of the connected-tab registry) has not landed yet: the turn
// is live, `Connected: none` is literally true, and panel_graph_outline failed both
// immediately and on a 3s retry. #436 gated MUTATIONS behind awaitReachable() and left
// reads on the flat ~400ms settle, on the reasoning that a read "survives that window
// (it is parked mid-command and is retry-safe)" — but a resolveTarget refusal happens
// BEFORE any socket write, so nothing is parked and the single re-issue simply loses
// the same race reconnectWaitTiming's docstring describes.
describe("#1881 a retry-safe READ waits out the post-restart 0-tab window", () => {
  // The reconnect must land AFTER the settle, or the pre-fix single re-issue would
  // catch it and the test would pass without the fix.
  const settleBeatsReconnect = (): void => {
    __panelToolsTestHooks.setRetrySettleMs(5);
    __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 2000, intervalMs: 5 });
  };

  it("graph_outline recovers: waits for the re-hello, rebinds, and answers", async () => {
    settleBeatsReconnect();
    const { bridge, live, sent } = reconnectingBridge([]); // Connected: none
    const ctx = makePanelToolCtx(bridge, "wf:workflows/x.json", new WorkflowTargetStore());
    setTimeout(() => live.add("reconnected-tab"), 120); // the browser re-hellos, post-settle
    const res = await defByName("panel_graph_outline").handler({}, ctx);
    expect(res.isError).toBeFalsy();
    // Dispatched to the RECONNECTED tab — not into the dead binding, and not refused.
    expect(sent.at(-1)?.cmd).toMatchObject({ cmd: "graph_outline" });
    expect(sent.at(-1)?.tabId).toBe("reconnected-tab");
    expect(ctx.tabId).toBe("reconnected-tab");
  });

  it("workflow_list recovers too — the wait lives in ctx.call, not in one tool", async () => {
    settleBeatsReconnect();
    const { bridge, live, sent } = reconnectingBridge([]);
    const ctx = makePanelToolCtx(bridge, "wf:workflows/x.json", new WorkflowTargetStore());
    setTimeout(() => live.add("reconnected-tab"), 120);
    const res = await defByName("panel_list_workflows").handler({}, ctx);
    expect(res.isError).toBeFalsy();
    expect(sent.at(-1)?.tabId).toBe("reconnected-tab");
  });

  it("still FAILS — bounded — when nothing ever reconnects", async () => {
    settleBeatsReconnect();
    const { bridge, sent } = reconnectingBridge([]); // stays Connected: none
    const ctx = makePanelToolCtx(bridge, "wf:workflows/x.json", new WorkflowTargetStore());
    const t0 = Date.now();
    const res = await defByName("panel_graph_outline").handler({}, ctx);
    expect(res.isError).toBe(true);
    expect(sent.length).toBe(0); // never dispatched into the dead binding
    // Bounded by the reconnect budget — it must not hang, and must not silently
    // succeed. (Budget 2000ms + settle; a generous ceiling keeps this off the
    // wall-clock-flake list while still catching an unbounded wait.)
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  it("a HEALTHY read is untouched — no wait, no extra round trip", async () => {
    __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 5000, intervalMs: 50 });
    const { bridge, sent } = reconnectingBridge(["live-tab"]);
    const ctx = makePanelToolCtx(bridge, "live-tab", new WorkflowTargetStore());
    const t0 = Date.now();
    const res = await defByName("panel_graph_outline").handler({}, ctx);
    expect(res.isError).toBeFalsy();
    expect(Date.now() - t0).toBeLessThan(1000); // did NOT wait the 5s budget
    expect(sent.filter((s) => s.cmd.cmd === "graph_outline").length).toBe(1); // first try
  });

  it("a read whose tab is live but which is NOT retry-safe keeps failing fast", async () => {
    // The wait is inside the retry-safe branch, so a read absent from RETRY_SAFE_CMDS
    // must never reach it — pinned here as well as in the #436 block above, because
    // this is the exact regression the new await could introduce.
    settleBeatsReconnect();
    __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 5000, intervalMs: 5 });
    const { bridge } = reconnectingBridge([]);
    const ctx = makePanelToolCtx(bridge, "stale-tab", new WorkflowTargetStore());
    const t0 = Date.now();
    const res = await defByName("panel_list_subgraphs").handler({}, ctx);
    expect(res.isError).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

// panel#654 — ComfyUI Desktop recoveries of 26–28s after the server was already
// healthy expired the 20s reconnectWaitTiming default. panel_graph_outline then
// reported still reconnecting / Connected: none, and only a hard refresh restored
// the tab. The default is 35s; this pins that number AND drives the shipped
// panel_graph_outline path through reconnectWaitTiming() (env, not the test
// override) so a hello landing after a 20s-scaled budget still answers.
describe("#654 reconnect wait covers a 26-28s Desktop recover", () => {
  const prevWait = (): string | undefined => process.env.COMFYUI_PANEL_RECONNECT_WAIT_S;
  const prevPoll = (): string | undefined => process.env.COMFYUI_PANEL_RECONNECT_POLL_S;
  const restoreEnv = (wait: string | undefined, poll: string | undefined): void => {
    if (wait === undefined) delete process.env.COMFYUI_PANEL_RECONNECT_WAIT_S;
    else process.env.COMFYUI_PANEL_RECONNECT_WAIT_S = wait;
    if (poll === undefined) delete process.env.COMFYUI_PANEL_RECONNECT_POLL_S;
    else process.env.COMFYUI_PANEL_RECONNECT_POLL_S = poll;
  };

  it("default budget is 35s — past the 26-28s Desktop recover, under the 60s ceiling", () => {
    const wait = prevWait();
    const poll = prevPoll();
    delete process.env.COMFYUI_PANEL_RECONNECT_WAIT_S;
    delete process.env.COMFYUI_PANEL_RECONNECT_POLL_S;
    __panelToolsTestHooks.setReconnectWaitTiming(null);
    try {
      const t = __panelToolsTestHooks.getReconnectWaitTiming();
      expect(t.budgetMs).toBe(35_000);
      expect(t.budgetMs).toBeGreaterThan(28_000);
      expect(t.budgetMs).toBeLessThanOrEqual(60_000);
    } finally {
      restoreEnv(wait, poll);
    }
  });

  it("panel_graph_outline recovers when the re-hello lands after a 20s wait would have given up", async () => {
    // Scale: 35s default → 350ms here; a 22s Desktop hello → 220ms, which is past
    // the old 200ms (20s) budget and inside the new one. No override hook — the
    // shipped reconnectWaitTiming() reads the env the production path reads.
    const wait = prevWait();
    const poll = prevPoll();
    process.env.COMFYUI_PANEL_RECONNECT_WAIT_S = "0.35";
    process.env.COMFYUI_PANEL_RECONNECT_POLL_S = "0.02";
    __panelToolsTestHooks.setReconnectWaitTiming(null);
    __panelToolsTestHooks.setRetrySettleMs(5);
    try {
      expect(__panelToolsTestHooks.getReconnectWaitTiming().budgetMs).toBe(350);
      const { bridge, live, sent } = reconnectingBridge([]);
      const ctx = makePanelToolCtx(bridge, "wf:workflows/x.json", new WorkflowTargetStore());
      setTimeout(() => live.add("reconnected-tab"), 220);
      const res = await defByName("panel_graph_outline").handler({}, ctx);
      expect(res.isError).toBeFalsy();
      expect(sent.at(-1)?.cmd).toMatchObject({ cmd: "graph_outline" });
      expect(sent.at(-1)?.tabId).toBe("reconnected-tab");
    } finally {
      restoreEnv(wait, poll);
      __panelToolsTestHooks.setRetrySettleMs(null);
    }
  });
});
