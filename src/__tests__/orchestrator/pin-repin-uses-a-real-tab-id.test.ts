// panel#888 — the test that would have caught BOTH no-op attempts.
//
// A source-text grep ("does panel-tools.ts contain the call?") cannot tell
// reachable code from dead code. My WIRING tests did exactly that and passed
// while the branch provably never fired. This drives the REAL
// panel_set_workflow_target handler and asserts the one property that matters:
//
//   the tab id handed to repinScopeToTab must be a tab that actually EXISTS.
//
// A route the bridge has never heard of refuses every time, which is
// indistinguishable from the bug the fix was meant to close.
//
// THE SHAPE THAT BROKE IT. The panel's own bridge-route module (#640) defines
// two DIFFERENT strings and warns they must not be confused:
//   saved-workflow HANDLE : wf:<path>              <- what the fix derived
//   bridge ROUTE (tab_id) : wf:<tabRouteId>:<path> <- what bridge.tabs() returns
// The handle is path-only *because* two browser tabs can show the same file, so
// it cannot address one of them. ui-bridge.ts's own comment still calls tabId
// "commonly derived from a saved workflow path", which predates #640 and is what
// licensed the wrong derivation.
import { describe, expect, it, vi } from "vitest";

import { buildPanelToolDefs, type PanelToolCtx } from "../../orchestrator/panel-tools.js";
import { makeScopeRepinHandler } from "../../orchestrator/turn-origins.js";

const SCOPE = "orchestrator::claude";
/** A REAL connected tab id: route form, not the path-only handle. */
const LIVE_TAB = "wf:tab-one:workflows/a.json";

const setTarget = () => buildPanelToolDefs().find((d) => d.name === "panel_set_workflow_target")!;

function ctxWith(realHandler: (s: string, p: string) => unknown, listBehaviour: "ambiguous" | "ok"): PanelToolCtx {
  return {
    tabId: SCOPE,
    confirm: async () => "yes" as const,
    call: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "workflow_list") {
        if (listBehaviour === "ambiguous") {
          // The reported state: the corroborating read is refused by the very
          // fence this recovery exists to clear.
          throw new Error(
            `no connected tab can be chosen for "${SCOPE}": the current turn was issued from ` +
              `multiple workflows at once, so its target is ambiguous.`,
          );
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                active: { path: "workflows/a.json", key: "a.json", routing_key: LIVE_TAB },
                workflows: [{ path: "workflows/a.json", key: "a.json", routing_key: LIVE_TAB, active: true }],
              }),
            },
          ],
        };
      }
      return { content: [{ type: "text", text: "{}" }] };
    },
    bridge: {
      tabs: () => [{ tab_id: LIVE_TAB }],
      canReach: () => true,
      isHeadless: () => false,
      push: () => 1,
      refreshWorkflowUuid: () => true,
      repinScopeToWorkflow: (scope: string, wfPath: string) => realHandler(scope, wfPath),
      repinScopeToActive: () => undefined,
    } as unknown as PanelToolCtx["bridge"],
    workflowTarget: {
      get: () => ({ mode: "current" as const }),
      set: (_t: string, v: unknown) => v,
    } as unknown as PanelToolCtx["workflowTarget"],
  } as unknown as PanelToolCtx;
}

describe("#888 the repin must land on a tab the bridge actually has", () => {
  for (const listBehaviour of ["ambiguous", "ok"] as const) {
    it(`resolves the pinned path to a REAL connected tab (workflow_list ${listBehaviour})`, async () => {
      // The REAL handler is wired in, so this drives the whole chain:
      // panel_set_workflow_target -> bridge -> route matching -> repinTo.
      // A spy on the bridge would only prove "some string was passed", which is
      // what the first attempt proved while being inert.
      const repinTo = vi.fn();
      const realHandler = makeScopeRepinHandler({
        bridge: {
          canReach: () => true,
          resolveActiveScopeTab: () => undefined,
          isHeadless: () => false,
          tabs: () => [{ tab_id: LIVE_TAB }],
        },
        tracker: { resolvedPinOf: () => null, repinTo } as never, // null = the ambiguous pin
        scopeAgentKeyOf: () => SCOPE,
        backendForTab: () => "claude",
        backendOfKey: () => "claude",
        info: () => {},
      });

      await setTarget().handler({ mode: "pinned", path: "workflows/a.json" }, ctxWith(realHandler, listBehaviour));

      expect(repinTo, "the ambiguous turn pin was never moved").toHaveBeenCalled();
      const [, tabArg] = repinTo.mock.calls[0] as [string, string];
      expect([LIVE_TAB], `repin landed on ${JSON.stringify(tabArg)}, which is not a connected tab`).toContain(tabArg);
    });
  }
});
