// #1778 — panel_save_workflow was fence-refused WITHOUT corroborating, so a
// save-only retry loop never self-healed.
//
// Split out of #1656, where an independent gate constructed the case and a control run
// proved it pre-dates that fix. The panel fences far more than `graph_*`:
// `activeWorkflowFenceApplies` covers everything that is not canvas-targetless /
// workflow_open / workflow_new, which includes the four ACTIVE-workflow mutators
// workflow_save, workflow_save_as, workflow_rename and workflow_close.
//
// Orchestrator-side, both halves of the repair read their scope off the `graph_` prefix
// instead: `isMutatingGraphCmd` is an allowlist of `graph_*` names and `isFencedGraphRead`
// requires the prefix outright. So a fence refusal on `workflow_save` matched NEITHER,
// fell all the way through to the generic `dispatched:false` wrapper, and fired no probe
// at all — which means `rebindWorkflowFence`'s `corroborateTabStamp` (#1656, the
// promotion that lets a CARRIED-but-confirmed stamp dispatch) never ran.
//
// Measured on the reporter's rig, one session, one stamp: `panel_graph_outline` was
// refused, probed, corroborated, and its retry went through; `panel_save_workflow({})`
// was refused with an EMPTY corroboration every time. A caller that only ever retries
// the save therefore stays refused indefinitely — until it happens to issue some
// unrelated `graph_*` call, or takes the remedy the refusal names.
//
// NOTHING IS WRITTEN BY EITHER STATE. The fence is checked pre-dispatch and the refusal
// is typed `dispatched:false`, so the cost is a stuck loop and a wasted turn, not data —
// which is also what makes "retry this exact call once" safe to say here.
//
// The generic wrapper's prose was the second, smaller half: it guesses "the tab may be
// disconnected, still reconnecting … or the binding is stale". In this state the tab is
// connected and routing fine; what is stale is the stamp. Reaching the real branch
// retires that guess as a side effect, and this file pins that too.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import {
  isCapabilityRefusal,
  markCapabilityRefusal,
  markDispatched,
} from "../../services/ui-bridge.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:route1:workflows/krea2_lora_ab_compare.json";
const CARRIED_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** The fence refusal in the shape the bridge mints it: PRE-dispatch, typed
 *  `dispatched:false`, and stating both sides of the comparison it performed. */
const fenceRefusal = (): Error =>
  markDispatched(
    new Error(
      `workflow instance mismatch: this command was issued for workflow instance ` +
        `${CARRIED_UUID}, and the tab it routed to has not re-established its workflow ` +
        `identity since it re-registered under a new id — the uuid it currently carries ` +
        `(${CARRIED_UUID}) was inherited from the tab id it replaced, so it is not evidence ` +
        `about the canvas now mounted there. Nothing was dispatched. Re-target with ` +
        `panel_set_workflow_target({mode:"current"}), then retry.`,
    ),
    false,
  );

// ── The two LOOK-ALIKES, quoted from the bridge's own templates ───────────────
//
// Both are minted by the SAME `"<cmd>" cannot be safely targeted to the active
// workflow` reject in ui-bridge, both are `dispatched:false`, and both carry the
// literal words "workflow instance mismatch" inside the `readsNote` that describes
// what a DIFFERENT command would get. `isWorkflowInstanceMismatch` is an unanchored
// phrase match, so it fires on both — which is why the new arm needs discriminators
// the `graph_*` arm gets for free from the #1401 branch sitting above it.

/** `capabilityMissing` — the panel does not enforce the fence contract a write needs.
 *  Typed with the bridge's own symbol marker. NEITHER a retry NOR a rebind can add
 *  the missing capability (#709), so appending that suffix contradicts the refusal. */
const capabilityRefusal = (): Error =>
  markCapabilityRefusal(
    markDispatched(
      new Error(
        `"workflow_save" cannot be safely targeted to the active workflow: panel tab ` +
          `${TAB} does not recheck workflow targeting at the graph write boundary after ` +
          `asynchronous work (detected panel 0.11.40; a graph WRITE needs panel 0.11.62+, ` +
          `the first build that rechecks the fence after an await). Update the panel and ` +
          `hard-refresh the browser tab. WHETHER GRAPH READS STILL WORK IS NOT KNOWN FROM ` +
          `HERE, and is not claimed: a read carries this session's stamp (${CARRIED_UUID}), ` +
          `and this tab's panel runs it only while that stamp still names the ACTIVE canvas ` +
          `— a comparison only the panel can make. If the workflow was switched or replaced ` +
          `after this session bound to it, graph_outline / graph_query are refused with ` +
          `"workflow instance mismatch" as well; if it was not, they work. Try ` +
          `panel_list_workflows — the panel exempts that read from this fence (it is the ` +
          `recovery probe), though a build predating the exemption fences it too. Non-graph ` +
          `tools are unaffected.`,
      ),
      false,
    ),
  );

/** The #1331 state: the fence contract IS advertised, but the workflow has no identity
 *  to fence against. NOT capability-marked — the panel is fine, the canvas is not — so
 *  the discriminating phrase is the only thing that separates it. And the separation
 *  matters: "a mismatch may clear by itself, this never does". */
const noTrustedIdentityRefusal = (): Error =>
  markDispatched(
    new Error(
      `"workflow_save" cannot be safely targeted to the active workflow: this workflow has ` +
        `no trusted identity for the panel to fence the command against. GRAPH READS ARE ` +
        `REFUSED TOO, for this same missing stamp: this tab's panel enforces the ` +
        `per-command fence and refuses an UNSTAMPED command rather than fail open, so ` +
        `graph_outline / graph_query answer "workflow instance mismatch: this command ` +
        `carries no workflow-instance stamp" as well. Try panel_list_workflows — the panel ` +
        `exempts that read from this fence (it is the recovery probe), though a build ` +
        `predating the exemption fences it too. Non-graph tools are unaffected.`,
    ),
    false,
  );

function harness(liveUuid: string, refusal: () => Error = fenceRefusal) {
  /** Every uuid offered to the provenance-only corroborator — the self-heal. */
  const corroborated: string[] = [];
  /** Every uuid handed to the RETARGETING fence write — must stay empty (#1646). */
  const retargeted: string[] = [];
  /** Which commands the panel was actually asked to run. */
  const sent: string[] = [];
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      sent.push(String(cmd.cmd));
      if (cmd.cmd === "workflow_list") {
        const active = {
          path: "workflows/krea2_lora_ab_compare.json",
          routing_key: TAB,
          workflow_uuid: liveUuid,
        };
        return { active, workflows: [{ ...active, active: true }], active_confirmed: true };
      }
      throw refusal();
    },
    push: () => 1,
    canReach: (id: string) => id === TAB,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: (_tabId: string, uuid: string) => {
      retargeted.push(uuid);
      return true;
    },
    corroborateTabStamp: (_tabId: string, uuid: string) => {
      corroborated.push(uuid);
      return true;
    },
    workflowUuidFor: () => ({ known: true, uuid: CARRIED_UUID }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  return { bridge: b, corroborated, retargeted, sent };
}

async function runTool(
  tool: string,
  args: Record<string, unknown>,
  liveUuid: string,
  refusal: () => Error = fenceRefusal,
): Promise<{
  text: string;
  res: ToolResult;
  corroborated: string[];
  retargeted: string[];
  sent: string[];
}> {
  const { bridge, corroborated, retargeted, sent } = harness(liveUuid, refusal);
  const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === tool);
  if (!def) throw new Error(`${tool} is not registered`);
  const res: ToolResult = await def.handler(args as never, ctx);
  return {
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    res,
    corroborated,
    retargeted,
    sent,
  };
}

describe("#1778 — a fenced workflow SAVE corroborates like a fenced graph edit", () => {
  it("probes and corroborates when the live canvas confirms the carried stamp", async () => {
    const { text, corroborated, retargeted, sent } = await runTool(
      "panel_save_workflow",
      {},
      CARRIED_UUID,
    );

    // THE FIX. Before it, the save refusal fired no probe at all: `workflow_list` was
    // never sent and `corroborateTabStamp` was never offered anything, so the session
    // kept refusing a canvas the panel agrees is the right one and a save-only retry
    // loop could not converge. Both assertions fail when the widened gate is reverted.
    expect(sent).toContain("workflow_list");
    expect(corroborated).toEqual([CARRIED_UUID]);
    // Read-only, exactly as for a graph edit: the RETARGETING write is not reached.
    expect(retargeted).toEqual([]);

    // The refusal is still a refusal — nothing is auto-applied, nothing auto-continues.
    expect(text).toMatch(/workflow instance mismatch/);
    // …and it now carries the verdict that makes the retry informed rather than blind.
    expect(text).toMatch(/CHECKED/);
    expect(text).toMatch(/TRANSIENT/);
    expect(text).toMatch(/RETRY THIS EXACT CALL ONCE/);
    // Structural, not echoed: the fence is checked before the handler runs, so the
    // file was NOT written and the retry cannot double-apply.
    expect(text).toMatch(/NOT applied — nothing changed/);

    // The second half of #1778: the generic wrapper's guess is retired. The tab is
    // connected and routing fine here — only the stamp is stale — so "may be
    // disconnected / still reconnecting" was describing a state that did not exist.
    expect(text).not.toMatch(/may be disconnected/);
    expect(text).not.toMatch(/still reconnecting after a restart\/reload/);
  });

  it("adopts NOTHING when the live canvas is a DIFFERENT workflow (#1646 stands)", async () => {
    const { text, corroborated, retargeted } = await runTool(
      "panel_save_workflow",
      {},
      OTHER_UUID,
    );
    // A save must never be re-pointed onto the canvas its own refusal named as the
    // wrong one — that would write the caller's graph over another workflow's file.
    expect(corroborated).toEqual([]);
    expect(retargeted).toEqual([]);
    expect(text).toMatch(/DIFFERENT workflow/);
    expect(text).toContain(OTHER_UUID);
    expect(text).toMatch(/The fence is unchanged/);
  });

  it("covers the whole fenced set, not just the reported command (rename)", async () => {
    // The gap is not about `panel_save_workflow`; it is about the orchestrator reading
    // this branch's scope off the `graph_` prefix while the panel reads it off the
    // fence. `workflow_rename` refused against the ACTIVE canvas is the same state.
    const { text, corroborated, sent } = await runTool(
      "panel_rename_workflow",
      { name: "renamed" },
      CARRIED_UUID,
    );
    expect(sent).toContain("workflow_list");
    expect(corroborated).toEqual([CARRIED_UUID]);
    expect(text).toMatch(/CHECKED/);
    expect(text).toMatch(/RETRY THIS EXACT CALL ONCE/);
  });

  it("does NOT hijack a CAPABILITY refusal that merely quotes the phrase", async () => {
    // The bridge's capability refusal names "workflow instance mismatch" inside its
    // readsNote, to say what a graph READ would get. The phrase match cannot tell that
    // apart from the fence actually having refused — for `graph_*` the ordering above
    // hides it, and these four have nothing above them.
    const raw = capabilityRefusal();
    // The fixture is only meaningful if it really does trip the phrase match; assert
    // that, or this test could pass for the wrong reason.
    expect(/workflow instance mismatch/i.test(raw.message)).toBe(true);
    expect(isCapabilityRefusal(raw)).toBe(true);

    const { text, corroborated, sent } = await runTool(
      "panel_save_workflow",
      {},
      CARRIED_UUID,
      capabilityRefusal,
    );

    // No probe: there is no fence state to corroborate, and the round trip is wasted.
    expect(sent).not.toContain("workflow_list");
    expect(corroborated).toEqual([]);
    // The capability branch's verbatim surfacing, not #1330's verdict.
    expect(text).not.toMatch(/CHECKED/);
    expect(text).not.toMatch(/RETRY THIS EXACT CALL ONCE/);
    // #709: neither a retry nor a rebind can add the missing capability, so the
    // suffix that orders one must not be appended three lines after the refusal
    // says so.
    expect(text).toMatch(/cannot be safely targeted to the active workflow/);
  });

  it("does NOT hand a NO-TRUSTED-IDENTITY refusal the mismatch remedy", async () => {
    // The pair the repo forbids conflating: a mismatch may clear by itself, this
    // never does. Answering it with "retry once, the fence already names the live
    // canvas" is the wrong half.
    const raw = noTrustedIdentityRefusal();
    expect(/workflow instance mismatch/i.test(raw.message)).toBe(true);
    expect(isCapabilityRefusal(raw)).toBe(false); // the marker cannot separate this one

    const { text, corroborated, sent } = await runTool(
      "panel_save_workflow",
      {},
      CARRIED_UUID,
      noTrustedIdentityRefusal,
    );

    expect(sent).not.toContain("workflow_list");
    expect(corroborated).toEqual([]);
    expect(text).not.toMatch(/CHECKED/);
    expect(text).not.toMatch(/RETRY THIS EXACT CALL ONCE/);
    // The refusal's own words survive, which is where the real remedy lives.
    expect(text).toMatch(/no trusted identity/);
  });

  it("CONTROL: a canvas-INDEPENDENT command is left alone", async () => {
    // The widening is an explicit list, not "everything that is not graph_". The panel
    // exempts canvas-independent Manager/server ops from this fence entirely, so a
    // refusal quoting the phrase for one of them is not a fence state this branch may
    // claim to have diagnosed — it must fall through to the generic handling.
    const { bridge, corroborated, sent } = harness(CARRIED_UUID);
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await ctx.call({ cmd: "manager_getlist" }, 5000);
    expect(res.isError).toBe(true);
    expect(sent).not.toContain("workflow_list");
    expect(corroborated).toEqual([]);
  });
});
