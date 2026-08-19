// #1656 — the OTHER half: a carried stamp that the live canvas CONFIRMS must stop
// being treated as inherited, or the fix is worse than the bug.
//
// The dispatch gate refuses an active-canvas command while the routed tab's stamp is
// one CARRIED onto a new tab id by a same-socket re-hello that could not resolve an
// identity. That window is entered by a rename/save whose hello merely RACED the
// canvas identity — where the canvas is in fact the very workflow the caller named.
// Left alone, the session would keep refusing edits to a canvas the panel agrees is
// correct, and the reporter of #1330 has already shown what that costs (14 refusals).
//
// So the read-only mismatch probe carries the repair. When the corroborated
// `workflow_list` says the LIVE canvas is the same instance the fence already names,
// that is an observation of the tab under its CURRENT id: the value is confirmed and
// the provenance is promoted from inherited to observed, through the orchestrator's
// identity validator, never off the refusal's prose.
//
// It goes through `corroborateTabStamp`, NOT `refreshWorkflowUuid` — and the difference
// is the whole safety argument. `refreshWorkflowUuid` WRITES a stamp (and a
// conversation's issue-time stamp with it), which is precisely the retarget #1646
// removed from this probe. `corroborateTabStamp` writes no stamp at all: the
// orchestrator re-checks that the uuid ALREADY equals the tab's current stamp and
// refuses outright when it does not, so the only thing it can change is a provenance
// bit. The DIVERGED case — live canvas is a different workflow — reaches neither.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { markDispatched } from "../../services/ui-bridge.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:route1:workflows/krea2_lora_ab_compare.json";
const CARRIED_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** The bridge's #1656 refusal, verbatim in shape: pre-dispatch, typed dispatched:false,
 *  and carrying the stamp in the form panel-tools reads back. */
const carriedRefusal = (): Error =>
  markDispatched(
    new Error(
      `workflow instance mismatch: this command was issued for workflow instance ${CARRIED_UUID}, ` +
        `and the tab it routed to has not re-established its workflow identity since it ` +
        `re-registered under a new id — the uuid it currently carries (${CARRIED_UUID}) was ` +
        `inherited from the tab id it replaced, so it is not evidence about the canvas now ` +
        `mounted there. Nothing was dispatched. Re-target with ` +
        `panel_set_workflow_target({mode:"current"}), then retry.`,
    ),
    false,
  );

function harness(liveUuid: string) {
  /** Every uuid offered to the provenance-only corroborator by this call. */
  const corroborated: string[] = [];
  /** Every uuid handed to the RETARGETING fence write — must stay empty here. */
  const retargeted: string[] = [];
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "workflow_list") {
        const active = {
          path: "workflows/krea2_lora_ab_compare.json",
          routing_key: TAB,
          workflow_uuid: liveUuid,
        };
        return { active, workflows: [{ ...active, active: true }], active_confirmed: true };
      }
      throw carriedRefusal();
    },
    push: () => 1,
    canReach: (id: string) => id === TAB,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    // The RETARGETING write. It must never be reached by a read-only mismatch probe.
    refreshWorkflowUuid: (_tabId: string, uuid: string) => {
      retargeted.push(uuid);
      return true;
    },
    // The provenance-only promotion. The real implementation refuses unless the uuid
    // already equals the tab's stamp; this records what it was offered.
    corroborateTabStamp: (_tabId: string, uuid: string) => {
      corroborated.push(uuid);
      return true;
    },
    // The session's fence — the carried uuid the command was issued for.
    workflowUuidFor: () => ({ known: true, uuid: CARRIED_UUID }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  return { bridge: b, corroborated, retargeted };
}

async function connect(liveUuid: string): Promise<{
  text: string;
  res: ToolResult;
  corroborated: string[];
  retargeted: string[];
}> {
  const { bridge, corroborated, retargeted } = harness(liveUuid);
  const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_connect");
  if (!def) throw new Error("panel_connect is not registered");
  const res: ToolResult = await def.handler(
    { from_node: 1, from_slot: 0, to_node: 2, to_slot: 0 } as never,
    ctx,
  );
  return {
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    res,
    corroborated,
    retargeted,
  };
}

describe("#1656 — a carried stamp the live canvas CONFIRMS is corroborated, not left inherited", () => {
  it("promotes the provenance when workflow_list names the SAME instance", async () => {
    const { text, corroborated, retargeted } = await connect(CARRIED_UUID);
    // The corroboration ran, offering exactly the uuid already in force — and the
    // RETARGETING write was not reached at all, so no fence moved.
    expect(corroborated).toEqual([CARRIED_UUID]);
    expect(retargeted).toEqual([]);
    // The verdict is unchanged: still the transient reading, still one informed retry.
    expect(text).toMatch(/TRANSIENT/);
    expect(text).toMatch(/RETRY THIS EXACT CALL ONCE/);
    // And the refusal itself is preserved — the call still fails.
    expect(text).toMatch(/workflow instance mismatch/);
  });

  it("adopts NOTHING when the live canvas is a DIFFERENT workflow (#1646 stands)", async () => {
    const { text, corroborated, retargeted } = await connect(OTHER_UUID);
    expect(corroborated).toEqual([]);
    expect(retargeted).toEqual([]);
    expect(text).toMatch(/DIFFERENT workflow/);
    expect(text).toContain(OTHER_UUID);
    // The fence stays on the workflow the caller named, so later edits keep being
    // refused rather than landing on the other canvas.
    expect(text).toMatch(/The fence is unchanged/);
  });
});
