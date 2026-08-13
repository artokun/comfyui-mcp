// #1478 — `panel_load_workflow` returned `loaded:true` and the very NEXT graph call failed
// with `workflow instance mismatch`. Loading replaces the graph, which mints a new canvas
// instance id, so the session's fence is stale the instant the load succeeds. The refusal
// then says "NO PANEL COMMAND CLAIMED IT", pointing the reader at "the user switched tabs"
// when a panel command one call earlier is what moved it.
//
// THE LOAD DOES NOT AUTO-REPAIR THE FENCE, and that is the interesting part. An earlier
// version of this fix ran the same re-derivation the documented recovery runs, and codex
// found the P1: that call adopts WHATEVER IS ACTIVE NOW with no tie to the load, so a user
// switching to canvas B between the load's ack and the follow-up read would stamp the
// session to B — and the next edit would land on B though the load modified A. A
// wrong-graph write is exactly what the fence exists to prevent.
//
// So the load states the fact instead, at the moment it becomes true.
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
const PRE_LOAD_UUID = "e592452b-c172-416d-a8bc-0ec6b96b56e1";
/** A DIFFERENT workflow, as if the user switched tabs during the load. */
const OTHER_UUID = "632e8dd7-30df-4de9-b28c-b6c98b9532aa";

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

let sent: string[] = [];

function bridge(loadReply: Record<string, unknown> = { loaded: true, format: "api", node_count: 59 }) {
  let stamp = PRE_LOAD_UUID;
  return {
    send: async (cmd: Record<string, unknown>) => {
      sent.push(String(cmd.cmd));
      if (cmd.cmd === "graph_load") return loadReply;
      if (cmd.cmd === "workflow_list") {
        // The hazard shape: by the time anyone asks, the ACTIVE canvas is a different
        // workflow. Adopting this would retarget the session away from what was loaded.
        return {
          active: {
            path: "workflows/other.json",
            filename: "other.json",
            title: "other.json",
            key: "workflows/other.json",
            routing_key: "wf:workflows/other.json",
            workflow_uuid: OTHER_UUID,
          },
          open: [{ path: "workflows/other.json", active: true, modified: false, persisted: true }],
          workflows: [
            { path: "workflows/other.json", active: true, modified: false, persisted: true },
          ],
          active_confirmed: true,
        };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: (id: string) => id === TAB,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: (_tabId: string, uuid: string) => {
      stamp = uuid;
      return true;
    },
    workflowUuidFor: () => ({ known: true, uuid: stamp }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    __stamp: () => stamp,
  } as unknown as PanelToolCtx["bridge"] & { __stamp: () => string };
}

async function load(loadReply?: Record<string, unknown>) {
  const b = bridge(loadReply);
  const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_load_workflow");
  if (!def) throw new Error("panel_load_workflow is not registered");
  const res: ToolResult = await def.handler(
    { graph: { nodes: [{ id: 1, type: "KSampler" }] } } as never,
    ctx,
  );
  return { text: textOf(res), isError: res.isError === true, stamp: b.__stamp() };
}

beforeEach(() => {
  sent = [];
});

describe("a load discloses the fence it just invalidated (#1478)", () => {
  it("says the fence is stale, why, and how to clear it", async () => {
    const out = await load();

    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/loaded/i);
    expect(out.text).toMatch(/CAN re-mint the canvas workflow instance/);
    expect(out.text).toMatch(/panel_set_workflow_target/);
    // The specific misdirection this replaces: the downstream refusal blames a tab switch.
    expect(out.text).toMatch(/NOT the user switching tabs/);
    // CONDITIONAL, never categorical. Four review rounds falsified every version that
    // asserted the fence IS stale: a UI load preserves the instance outright, and a second
    // API load into the same already-active workflow reuses the object so its uuid does
    // not change either. The reply cannot tell those apart, so the note must not pretend to.
    expect(out.text).toMatch(/If your next graph command is refused/);
    expect(out.text).toMatch(/If the next command is not refused, nothing needs doing/);
    expect(out.text).not.toMatch(/will be refused/);
  });

  it("does NOT adopt whatever is active — the P0 an auto-rebind would have created", async () => {
    // With the user on a different canvas, an auto-rebind would stamp OTHER_UUID and the
    // next edit would land on the wrong graph. The fence must stay where it was, so the
    // next command is REFUSED (loudly) rather than silently retargeted.
    const out = await load();

    expect(out.stamp).toBe(PRE_LOAD_UUID);
    expect(out.stamp).not.toBe(OTHER_UUID);
  });

  it("costs no extra round trip", async () => {
    // The earlier version called the re-derivation, which on a panel that cannot
    // corroborate spends up to four 6-second probes plus recheck sleeps — to reach an
    // answer it must not use. Only the load itself goes out now.
    await load();

    expect(sent).toEqual(["graph_load"]);
  });

  it("a reply that did NOT replace the graph gets no stale-fence claim (codex r2)", async () => {
    // Keyed on the reply saying `loaded:true`, not merely on the call not erroring. A
    // non-error envelope reporting `loaded:false` replaced nothing, and asserting a stale
    // fence there would invent a consequence of a load that never happened — the same
    // unmeasured-claim defect this note exists to remove.
    const out = await load({ loaded: false, error: "nothing was applied" });

    expect(out.text).not.toMatch(/CAN re-mint the canvas workflow instance/);
    expect(out.text).not.toMatch(/panel_set_workflow_target/);
  });

  it("a UI-format load PRESERVES the instance, so it gets no note (codex r3)", async () => {
    // Checked in the panel: the UI path passes `__cmcpKeepInstance: true` whenever a
    // workflow is active, deliberately keeping the instance so the agent's own follow-up
    // commands are not rejected. Only the API path (`loadApiJson`) re-mints — and it is
    // the one the reporter hit, whose reply reads `format:"api"`.
    //
    // A blanket note would therefore have been FALSE for the commonest load, which is the
    // same fabricated-consequence defect this whole change exists to remove.
    const out = await load({ loaded: true, node_count: 12 });

    expect(out.text).toMatch(/loaded/i);
    expect(out.text).not.toMatch(/CAN re-mint the canvas workflow instance/);
    expect(out.text).not.toMatch(/panel_set_workflow_target/);
  });
});
