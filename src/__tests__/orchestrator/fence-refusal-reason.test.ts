// #1077 — a refused fence adoption that cannot say which gate refused it.
//
// The orchestrator's validator has THREE independent gates: the routed tab is
// unreachable, it does not resolve to a live panel tab, or the workflow identity
// did not validate. Every one returned a bare `false`, so the tool could only
// report "The adoption was REFUSED" and offer one remedy — refresh the tab.
//
// That is unactionable in general and WRONG in one specific case. Identity is
// bound to the connection's server-observed Origin, and a relay-backend
// connection has none: `attachRelayConnection(sock)` calls `handleConnection(sock)`
// with no origin argument, and the relay protocol does not forward the browser's
// handshake Origin. So `workflowIdentityParts()` can never validate, the fence can
// NEVER be adopted, and no amount of refreshing changes it. The reporter refreshed
// repeatedly and closed and reopened the tab before tracing it to source.
//
// They also had no orchestrator log to read, which is why the reason has to reach
// the TOOL RESULT and not just stderr.

import { describe, expect, it } from "vitest";
import { UiBridge } from "../../services/ui-bridge.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
} from "../../orchestrator/panel-tools.js";

/** The bridge is the seam: the orchestrator injects the validator, and the tool
 *  layer reads back the reason. Driving it here keeps the test on the contract
 *  rather than on either side's internals. */
function bridgeWithValidator(
  refresh: (tabId: string, uuid: string) => boolean | { ok: true } | { ok: false; reason: string },
): UiBridge {
  const b = new UiBridge(0);
  b.setTabWorkflowUuidResolver(() => undefined, refresh);
  return b;
}

const UUID = "11111111-2222-4333-8444-555555555555";

describe("a refused adoption records WHY", () => {
  it("exposes the validator's reason to the caller", () => {
    const b = bridgeWithValidator(() => ({
      ok: false,
      reason: "the routed tab (wf:x) is no longer reachable, so there is nothing to fence",
    }));

    expect(b.refreshWorkflowUuid("wf:x", UUID)).toBe(false);
    expect(b.lastFenceRefusal("wf:x")).toMatch(/no longer reachable/);
  });

  it("keeps reasons per-tab, so one wedged tab cannot explain another", () => {
    const b = bridgeWithValidator((tabId) =>
      tabId === "wf:a" ? { ok: false, reason: "reason for A" } : { ok: true },
    );

    b.refreshWorkflowUuid("wf:a", UUID);
    b.refreshWorkflowUuid("wf:b", UUID);

    expect(b.lastFenceRefusal("wf:a")).toBe("reason for A");
    expect(b.lastFenceRefusal("wf:b")).toBeUndefined();
  });

  it("clears the reason once an adoption succeeds — it must not outlive its state", () => {
    let refuse = true;
    const b = bridgeWithValidator(() => (refuse ? { ok: false, reason: "temporarily wedged" } : { ok: true }));

    b.refreshWorkflowUuid("wf:x", UUID);
    expect(b.lastFenceRefusal("wf:x")).toBe("temporarily wedged");

    refuse = false;
    expect(b.refreshWorkflowUuid("wf:x", UUID)).toBe(true);
    expect(b.lastFenceRefusal("wf:x")).toBeUndefined();
  });

  // Backward compatibility: the resolver may be a plain boolean (tests register
  // one, and an older injection would too). It must keep working, just without a
  // reason to report.
  it("still accepts a plain boolean validator", () => {
    const b = bridgeWithValidator(() => false);

    expect(b.refreshWorkflowUuid("wf:x", UUID)).toBe(false);
    expect(b.lastFenceRefusal("wf:x")).toBeUndefined();

    const ok = bridgeWithValidator(() => true);
    expect(ok.refreshWorkflowUuid("wf:x", UUID)).toBe(true);
  });

  it("reports false when no validator is registered at all", () => {
    const b = new UiBridge(0);
    expect(b.refreshWorkflowUuid("wf:x", UUID)).toBe(false);
  });
});

// The half that matters to the person reading the tool result.
describe("the refusal message names the gate and matches the remedy to it", () => {
  const setTarget = () =>
    buildPanelToolDefs().find((d) => d.name === "panel_set_workflow_target")!;

  /** A panel that answers workflow_list with a corroborated live identity, so the
   *  rebind reaches the ADOPT step — which is the step being refused. */
  function ctxRefusing(reason: string): PanelToolCtx {
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        if (cmd.cmd === "workflow_list") {
          return {
            active: {
              path: "workflows/a.json",
              filename: "a.json",
              key: "wf:workflows/a.json",
              routing_key: "wf:workflows/a.json",
              workflow_uuid: UUID,
            },
            active_confirmed: true,
            workflows: [
              {
                path: "workflows/a.json",
                filename: "a.json",
                key: "wf:workflows/a.json",
                routing_key: "wf:workflows/a.json",
                active: true,
                persisted: true,
              },
            ],
          };
        }
        return { ok: true };
      },
      push: () => 1,
      canReach: () => true,
      isHeadless: () => false,
      tabs: () => [{ tab_id: "tab-1", title: "A", connected_at: 0 }],
      resolveActiveTabId: () => "tab-1",
      workflowUuidFor: () => ({ known: true, uuid: "99999999-8888-4777-a666-555555555555" }),
      refreshWorkflowUuid: () => false, // the adoption is refused…
      lastFenceRefusal: () => reason, // …and this is why
      tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    } as unknown as PanelToolCtx["bridge"];
    return makePanelToolCtx(bridge, "tab-1", new WorkflowTargetStore());
  }

  const textOf = (res: { content: Array<{ text?: string }> }): string => res.content[0]!.text ?? "";

  it("quotes the reason instead of listing two causes and shrugging", async () => {
    const text = textOf(
      await setTarget().handler({ mode: "current" }, ctxRefusing("the routed tab (wf:x) is no longer reachable")),
    );

    expect(text).toMatch(/refused it because the routed tab \(wf:x\) is no longer reachable/);
    // The old text offered both causes and let the reader pick.
    expect(text).not.toMatch(/this bridge could not say which/);
  });

  // THE ONE THAT COST THE REPORTER THE SESSION. A structural refusal must not be
  // answered with "refresh the tab" — they did that, repeatedly, and closed and
  // reopened the tab too.
  it("does NOT tell the user to refresh when the gate is structural", async () => {
    const text = textOf(
      await setTarget().handler(
        { mode: "current" },
        ctxRefusing(
          "this tab's connection carries no server-observed Origin, and the workflow identity is bound to one",
        ),
      ),
    );

    expect(text).toMatch(/Refreshing the tab will NOT help/);
    expect(text).toMatch(/COMFYUI_MCP_TUNNEL_BACKEND=relay/);
    // The generic remedy must be suppressed, not merely preceded.
    expect(text).not.toMatch(/Ask the user to manually refresh/);
  });

  it("falls back to the generic remedy when the bridge cannot say why", async () => {
    const bridge = {
      ...(ctxRefusing("x").bridge as unknown as Record<string, unknown>),
      lastFenceRefusal: undefined, // an older bridge
    } as unknown as PanelToolCtx["bridge"];

    const text = textOf(
      await setTarget().handler(
        { mode: "current" },
        makePanelToolCtx(bridge, "tab-1", new WorkflowTargetStore()),
      ),
    );

    expect(text).toMatch(/this bridge could not say which/);
    expect(text).toMatch(/Ask the user to manually refresh/);
  });
});
