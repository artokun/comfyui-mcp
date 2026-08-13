// #1473 — right after a ComfyUI restart, `panel_set_workflow_target({mode:"current"})`
// returned isError:true saying the graph binding was NOT restored… and the reporter's very
// next `panel_graph_outline` succeeded with the expected graph. The session was never
// wedged; it was told it was.
//
// #1401 had already got the MESSAGE right for this shape: when the panel's reported identity
// MATCHES the fence the session already holds, it says so, says it is not a claim that graph
// tools work, and tells the caller to settle it with a graph read. What was left is that it
// still reported FAILURE — so this takes the advice it gives instead of handing the caller a
// failure plus homework.
//
// Narrow by design: the probe runs only on the matching-uuid path, where the two remaining
// possibilities (a reconciliation race vs a stale/background record) are indistinguishable
// by inspection and trivially distinguishable by asking.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

const { buildPanelToolDefs, makePanelToolCtx } = await import("../../orchestrator/panel-tools.js");
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const TAB = "11111111-2222-3333-4444-555555555555";
/** The uuid the session is already fenced to AND the one the panel reports. */
const SAME_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_UUID = "99999999-8888-4777-8666-555555555555";

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

let sent: string[] = [];

/**
 * A panel mid-reconciliation: it answers `workflow_list` but flags the active record
 * UNCONFIRMED, so nothing may be adopted. `activeUuid` decides whether that record names the
 * fence this session already holds. `graphReadOk` decides whether the settling probe passes.
 */
function bridge(opts: {
  activeUuid: string;
  /** "ok" passes; "mismatch" is a real fence refusal; "timeout" is an inconclusive failure. */
  graphRead: "ok" | "mismatch" | "timeout";
  canMutate?: boolean;
}) {
  return {
    send: async (cmd: Record<string, unknown>) => {
      sent.push(String(cmd.cmd));
      if (cmd.cmd === "workflow_list") {
        return {
          active: {
            path: "workflows/a.json",
            filename: "a.json",
            title: "a.json",
            key: "workflows/a.json",
            routing_key: "wf:workflows/a.json",
            workflow_uuid: opts.activeUuid,
          },
          open: [{ path: "workflows/a.json", active: true, modified: false, persisted: true }],
          workflows: [{ path: "workflows/a.json", active: true, modified: false, persisted: true }],
          // The panel itself says "do not trust this yet" — the reported shape.
          active_confirmed: false,
        };
      }
      if (cmd.cmd === "graph_query") {
        if (opts.graphRead === "mismatch") {
          throw new Error(
            "workflow instance mismatch: this command was issued for workflow instance X, " +
              "and the active canvas reports Y. Nothing was applied.",
          );
        }
        if (opts.graphRead === "timeout") {
          // NOT a fence verdict: the tab was backgrounded and never answered. ctx.call turns
          // this into an error result too, which is exactly the conflation being guarded.
          throw new Error("timed out after 8000ms waiting for the panel to answer graph_query");
        }
        return { ids: [1] };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: (id: string) => id === TAB,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: () => true,
    workflowUuidFor: () => ({ known: true, uuid: SAME_UUID }),
    tabCanMutateGraph: () => opts.canMutate !== false,
    tabGraphMutationCapability: () => ({
      known: true,
      canMutate: opts.canMutate !== false,
      ...(opts.canMutate === false ? { because: "capability" as const } : {}),
    }),
  } as unknown as PanelToolCtx["bridge"];
}

async function setTargetCurrent(opts: {
  activeUuid: string;
  graphRead: "ok" | "mismatch" | "timeout";
  canMutate?: boolean;
}) {
  const ctx = makePanelToolCtx(bridge(opts), TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_set_workflow_target");
  if (!def) throw new Error("panel_set_workflow_target is not registered");
  const res: ToolResult = await def.handler({ mode: "current" } as never, ctx);
  return { text: textOf(res), isError: res.isError === true };
}

beforeEach(() => {
  sent = [];
});

describe("an UNCONFIRMED record whose uuid matches the fence gets its answer up front (#1473)", () => {
  it("probes a graph read and reports what it found", async () => {
    const out = await setTargetCurrent({ activeUuid: SAME_UUID, graphRead: "ok" });

    // The probe really ran — without this the assertions could pass on a branch that
    // simply stopped failing, which would be a claim rather than a measurement.
    expect(sent).toContain("graph_query");

    // STILL A FAILURE, and that is #1401's reasoned call, not an oversight: "softening the
    // DIAGNOSIS must not soften the RESULT — the rebind genuinely did not happen." It did
    // not. What changed is that the caller learns, in this reply, that nothing is broken —
    // instead of discovering it one call later.
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/CHECKED FOR YOU/);
    expect(out.text).toMatch(/it SUCCEEDED/);
    expect(out.text).toMatch(/READS work against it/);
    expect(out.text).toMatch(/reconciliation race/);
    expect(out.text).toMatch(/No recovery step is needed/);
    // And it does not overclaim: the rebind itself is still reported as not having happened.
    expect(out.text).toMatch(/rebind itself still did not happen/);
  });

  it("keeps the failure when the graph read is REFUSED", async () => {
    // Then the reply really was stale and graph tools really are wedged — today's verdict
    // is correct and stays, remedy and all.
    const out = await setTargetCurrent({ activeUuid: SAME_UUID, graphRead: "mismatch" });

    expect(sent).toContain("graph_query");
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/did NOT restore/);
    // The probe's answer is reported either way — a refused read CONFIRMS the wedge, which
    // is worth saying rather than leaving the caller to re-derive it.
    expect(out.text).toMatch(/REFUSED by the instance fence/);
  });

  it("does NOT probe when the reported identity differs from the fence", async () => {
    // The other path is a genuine certain failure: the session is fenced to a different
    // instance and graph tools will keep failing. Probing there would spend a round trip to
    // learn something already known, and a passing read would not make the fence right.
    const out = await setTargetCurrent({ activeUuid: OTHER_UUID, graphRead: "ok" });

    expect(sent).not.toContain("graph_query");
    expect(out.isError).toBe(true);
  });

  it("an INCONCLUSIVE probe claims nothing in either direction (codex P1)", async () => {
    // `ctx.call` turns a transport failure into an error result too, so reading every error
    // as "refused" would invent a wedge out of a backgrounded tab — and would contradict
    // this block's own rule that an unknown answer says nothing.
    const out = await setTargetCurrent({ activeUuid: SAME_UUID, graphRead: "timeout" });

    expect(sent).toContain("graph_query");
    expect(out.isError).toBe(true);
    expect(out.text).not.toMatch(/CHECKED FOR YOU/);
    expect(out.text).not.toMatch(/REFUSED by the instance fence/);
    expect(out.text).not.toMatch(/it SUCCEEDED/);
  });

  it("a passing READ does not promise MUTATIONS work (codex P1)", async () => {
    // The write fence is a separate capability: a panel can serve reads while refusing every
    // mutation. Saying "no recovery step is needed" there would send someone to edit a graph
    // that will refuse them.
    const out = await setTargetCurrent({
      activeUuid: SAME_UUID,
      graphRead: "ok",
      canMutate: false,
    });

    expect(out.text).toMatch(/READS work against it/);
    expect(out.text).toMatch(/MUTATIONS are a separate matter/);
    expect(out.text).not.toMatch(/No recovery step is needed/);
  });
});
