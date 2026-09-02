// panel#2191 — `panel_screenshot` timed out at 20 000 ms on a live, answering tab.
//
// The reporter laid out a 264-node / 63-group workflow and called
// panel_screenshot({padding:50}). It was declared "backgrounded or frozen" while,
// in the same session on the same graph, panel_query_graph, panel_get_errors
// (all 264 nodes) and panel_save_workflow all completed. That is not a frozen
// tab; it is a busy-but-alive main thread — the exact condition
// graph_get_errors' own budget comment in panel-tools.ts describes.
//
// graph_get_errors survives that graph because it dispatches with the bounded
// 90 s read budget. panel_screenshot dispatched with NO timeoutMs at all and took
// the bare default, even though its cost scales with the graph the same way: it
// forces one synchronous LiteGraph repaint of every node and group at the fitted
// transform, PNG-encodes it, and repaints again on restore.
//
// WHY THIS FILE ASSERTS THE CALL SITE, NOT A HELPER. The fix is one option key on
// one `ctx.bridge.send`. `defaultBridgeTimeoutMs("graph_screenshot")` cannot see
// it — that helper answers what an UNSPECIFIED dispatch gets, and both defaults
// are currently 20 000 anyway, so a helper-level assertion is green with or
// without the fix. The only observation that distinguishes them is what the real
// registered handler actually passes, so that is what is watched here: the tool
// surface from buildPanelToolDefs(), driven, with the send options recorded.
//
// And the budget is pinned RELATIVELY, to the value panel_get_errors uses, not to
// the literal 90 000. The number's provenance is "the bounded budget this repo
// already gives an idempotent read on a busy panel main thread"; writing 90_000
// here would let the two drift apart silently and would promote a borrowed
// constant into an independent claim about how long a screenshot takes. It is
// not that — see the PR: no browser run was possible to measure a real capture.
import { describe, it, expect } from "vitest";
import { buildPanelToolDefs } from "../../orchestrator/panel-tools.js";
import { BRIDGE_DEFAULT_TIMEOUT_MS, BRIDGE_READ_DEFAULT_TIMEOUT_MS } from "../../services/ui-bridge.js";

type Handler = ReturnType<typeof buildPanelToolDefs>[number]["handler"];
type HandlerCtx = Parameters<Handler>[1];

/** What a driven handler asked the panel to wait for, per door. */
type Observed = {
  /** `ctx.bridge.send(cmd, { timeoutMs })` — panel_screenshot's door. */
  sendTimeouts: Map<string, number | undefined>;
  /** `ctx.call(cmd, timeoutMs)` — panel_get_errors' door (positional). */
  callTimeouts: Map<string, number | undefined>;
};

/**
 * Drive one registered tool and record the ack budget it asked for.
 *
 * The handler is allowed to throw once it has dispatched — several of these do
 * more work on the reply than a synthetic ctx can satisfy, and the dispatch has
 * already been observed by then.
 */
async function driveTool(name: string, args: Record<string, unknown> = {}): Promise<Observed> {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  // Guard the guard: a typo'd tool name would make every assertion below vacuous.
  expect(def, `${name} must be a registered tool`).toBeTruthy();

  const observed: Observed = { sendTimeouts: new Map(), callTimeouts: new Map() };
  const nameOf = (cmd: unknown): string | undefined => {
    const c = (cmd as { cmd?: unknown } | undefined)?.cmd;
    return typeof c === "string" ? c : undefined;
  };

  const stub = {
    call: async (cmd: Record<string, unknown>, timeoutMs?: number) => {
      const c = nameOf(cmd);
      if (c) observed.callTimeouts.set(c, timeoutMs);
      return { content: [{ type: "text", text: "{}" }] };
    },
    confirm: async () => "yes" as const,
    bridge: {
      send: async (cmd: unknown, opts?: { timeoutMs?: number }) => {
        const c = nameOf(cmd);
        if (c) observed.sendTimeouts.set(c, opts?.timeoutMs);
        // A 1x1 transparent PNG, so panel_screenshot gets past `if (!res?.image)`
        // and the rest of its body runs the way production's would.
        return {
          image:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
          mimeType: "image/png",
        };
      },
      push: () => 1,
      canReach: () => true,
      isHeadless: () => false,
      tabs: () => [{ tab_id: "tab-1", title: "t", connected_at: 0 }],
      resolveActiveTabId: () => "tab-1",
    },
    tabId: "tab-1",
    ensureReachable: () => {},
  };

  try {
    /* PanelToolCtx is a large orchestrator interface and this probe implements only the five members the two driven tools touch (call, bridge.send, tabId, ensureReachable, confirm) — a structurally complete ctx would be a fake of the thing under observation, and the sibling probe in graph-command-effect.test.ts narrows the same way. */
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test probe implements only the ctx members the driven tools touch; see the note above
    await def!.handler(args, stub as unknown as HandlerCtx);
  } catch {
    /* dispatch already recorded; a synthetic ctx cannot satisfy every reply path */
  }
  return observed;
}

describe("panel#2191 — panel_screenshot dispatches with the bounded read budget", () => {
  it("passes an explicit timeoutMs on the send, instead of falling through to the default", async () => {
    const { sendTimeouts } = await driveTool("panel_screenshot", { padding: 50 });

    // Guard the guard: if the handler never reached its dispatch, "not the
    // default" would be true because nothing was observed at all.
    expect(
      sendTimeouts.has("graph_screenshot"),
      "panel_screenshot must have dispatched graph_screenshot",
    ).toBe(true);

    const budget = sendTimeouts.get("graph_screenshot");
    expect(budget, "the screenshot must not be dispatched with no budget").toBeTypeOf("number");
    // The regression, stated as the reporter would: the window it was cut off at.
    expect(budget).toBeGreaterThan(BRIDGE_DEFAULT_TIMEOUT_MS);
    expect(budget).toBeGreaterThan(BRIDGE_READ_DEFAULT_TIMEOUT_MS);
    // Still BOUNDED. A read may wait longer than a write; it may not wait forever,
    // or a genuinely frozen tab never surfaces as frozen at all.
    expect(Number.isFinite(budget as number)).toBe(true);
  });

  it("takes the SAME budget as panel_get_errors, the read it was measured against", async () => {
    // Relative, not a literal. panel_get_errors earned this number for the
    // identical failure — "declared 'backgrounded or frozen' at 20 000 ms by a
    // tab that had just answered four commands and did reply, late" — and it is
    // the reason that tool succeeded on the very graph this one timed out on. If
    // someone retunes that budget, the screenshot must move with it rather than
    // silently keeping a stale copy.
    const shot = (await driveTool("panel_screenshot", { padding: 50 })).sendTimeouts.get(
      "graph_screenshot",
    );
    const errs = (await driveTool("panel_get_errors")).callTimeouts.get("graph_get_errors");

    expect(errs, "panel_get_errors must have dispatched graph_get_errors").toBeTypeOf("number");
    expect(shot).toBe(errs);
  });
});
