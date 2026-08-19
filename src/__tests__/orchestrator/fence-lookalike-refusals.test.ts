// #1778/#1782 follow-up — THE PHRASE IS NOT THE STATE.
//
// #1782 widened the #1330 corroboration branch to the four active-workflow mutators
// (`workflow_save` / `workflow_save_as` / `workflow_rename` / `workflow_close`), which
// was right: they are fenced exactly as a graph edit is, and without it a save-only
// retry loop never self-healed.
//
// What came with it is an ordering problem the `graph_*` arm never had to face.
// `isWorkflowInstanceMismatch` is an UNANCHORED `/workflow instance mismatch/i`, and it
// is not the only thing that says those words. The bridge's `"<cmd>" cannot be safely
// targeted to the active workflow` reject quotes them inside its `readsNote` — to
// describe what a DIFFERENT command would get — and carries the second look-alike,
// `no trusted identity`, in its `why` clause. Both are `dispatched:false`. Both satisfy
// the phrase match.
//
// For a mutating graph edit that never surfaced, by ORDERING rather than by design: the
// #1401 branch catches `no trusted identity` for `isMutatingGraphCmd` first, and the
// capability hijack is pre-existing there. The four mutators have no branch above them,
// so the widening handed each of these two states the OTHER's remedy:
//
//   capability refusal      previously reached `isCapabilityRefusal` and surfaced
//                           VERBATIM. Now prefixed "was NOT applied", charged a wasted
//                           workflow_list round trip, and given the retry/rebind suffix
//                           #709 exists to suppress — three lines after the refusal
//                           says rebinding cannot add the missing capability. A
//                           REGRESSION: correct before, wrong after.
//   no trusted identity     gets #1330's "retry once, the fence already names the live
//                           canvas" for a state whose own docstring says "a mismatch
//                           may clear by itself, this never does".
//
// The discriminators are typed-or-explicit, never a second reading of the same prose:
// `isCapabilityRefusal` is the bridge's own symbol marker, and `isNoTrustedIdentityRefusal`
// matches a distinct phrase a mismatch refusal never contains. Scoped to the widened arm,
// so `isMutatingGraphCmd` keeps its exact behaviour and nothing about the graph path moves.

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
const STAMP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** `capabilityMissing` — the connected panel does not enforce the workflow-stamp
 *  contract a write needs (#570/#718). Typed with the bridge's own symbol marker.
 *  Quoted from ui-bridge's templates: the `readsNote` really does name the phrase. */
const capabilityRefusal = (): Error =>
  markCapabilityRefusal(
    markDispatched(
      new Error(
        `"workflow_save" cannot be safely targeted to the active workflow: panel tab ` +
          `${TAB} does not recheck workflow targeting at the graph write boundary after ` +
          `asynchronous work (detected panel 0.11.40; a graph WRITE needs panel 0.11.62+, ` +
          `the first build that rechecks the fence after an await). Update the panel and ` +
          `hard-refresh the browser tab. WHETHER GRAPH READS STILL WORK IS NOT KNOWN FROM ` +
          `HERE, and is not claimed: a read carries this session's stamp (${STAMP}), and ` +
          `this tab's panel runs it only while that stamp still names the ACTIVE canvas — ` +
          `a comparison only the panel can make. If the workflow was switched or replaced ` +
          `after this session bound to it, graph_outline / graph_query are refused with ` +
          `"workflow instance mismatch" as well; if it was not, they work. Try ` +
          `panel_list_workflows — the panel exempts that read from this fence (it is the ` +
          `recovery probe), though a build predating the exemption fences it too. ` +
          `Non-graph tools are unaffected.`,
      ),
      false,
    ),
  );

/** The #1331 state: the fence contract IS advertised, but the workflow has no identity
 *  to fence against. NOT capability-marked — the panel is fine, the canvas is not — so
 *  the distinct phrase is the only thing that separates it. */
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

function harness(refusal: () => Error) {
  const corroborated: string[] = [];
  const sent: string[] = [];
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      sent.push(String(cmd.cmd));
      if (cmd.cmd === "workflow_list") {
        const active = {
          path: "workflows/krea2_lora_ab_compare.json",
          routing_key: TAB,
          workflow_uuid: STAMP,
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
    refreshWorkflowUuid: () => true,
    corroborateTabStamp: (_tabId: string, uuid: string) => {
      corroborated.push(uuid);
      return true;
    },
    workflowUuidFor: () => ({ known: true, uuid: STAMP }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  return { bridge: b, corroborated, sent };
}

async function save(refusal: () => Error): Promise<{
  text: string;
  corroborated: string[];
  sent: string[];
}> {
  const h = harness(refusal);
  const ctx = makePanelToolCtx(h.bridge, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_save_workflow");
  if (!def) throw new Error("panel_save_workflow is not registered");
  const res: ToolResult = await def.handler({} as never, ctx);
  return {
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    corroborated: h.corroborated,
    sent: h.sent,
  };
}

describe("#1778 follow-up — the widened arm must not adopt refusals that merely QUOTE the fence", () => {
  it("a CAPABILITY refusal keeps its own words and pays no probe", async () => {
    // Assert the fixture really does trip the phrase match, or this test could pass
    // for the wrong reason — a fixture that never reached the branch proves nothing.
    const raw = capabilityRefusal();
    expect(/workflow instance mismatch/i.test(raw.message)).toBe(true);
    expect(isCapabilityRefusal(raw)).toBe(true);

    const { text, corroborated, sent } = await save(capabilityRefusal);

    // There is no fence state to corroborate here, so the round trip is pure waste.
    expect(sent).not.toContain("workflow_list");
    expect(corroborated).toEqual([]);
    // #709: neither a retry nor a rebind can add a missing capability, so the branch
    // that orders one must not run. Its verdict text is the tell.
    expect(text).not.toMatch(/CHECKED/);
    expect(text).not.toMatch(/RETRY THIS EXACT CALL ONCE/);
    // What the caller gets instead is the refusal the bridge actually wrote.
    expect(text).toMatch(/cannot be safely targeted to the active workflow/);
    expect(text).toMatch(/hard-refresh the browser tab/);
  });

  it("a NO-TRUSTED-IDENTITY refusal is not handed the mismatch remedy", async () => {
    const raw = noTrustedIdentityRefusal();
    expect(/workflow instance mismatch/i.test(raw.message)).toBe(true);
    // The typed marker cannot separate this one — the panel is capable; the canvas
    // has no identity — so the discriminator has to be the distinct phrase.
    expect(isCapabilityRefusal(raw)).toBe(false);

    const { text, corroborated, sent } = await save(noTrustedIdentityRefusal);

    expect(sent).not.toContain("workflow_list");
    expect(corroborated).toEqual([]);
    // The pair the repo forbids conflating: a mismatch may clear by itself, this
    // never does — so "retry once, the fence already names the live canvas" is the
    // wrong half and would send the caller round a loop that cannot converge.
    expect(text).not.toMatch(/CHECKED/);
    expect(text).not.toMatch(/RETRY THIS EXACT CALL ONCE/);
    expect(text).toMatch(/no trusted identity/);
  });
});
