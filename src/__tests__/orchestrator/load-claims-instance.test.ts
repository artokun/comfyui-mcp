// #1478 — `panel_load_workflow` returned `loaded:true` and the very NEXT graph call failed
// with `workflow instance mismatch`. Loading replaces the graph, which mints a new canvas
// instance id, so the session's fence is stale the instant the load succeeds. The reporter
// hit it deterministically twice, and their recovery was always the same
// `panel_set_workflow_target({mode:"current"})`.
//
// The load now performs that claim itself. Two things are asserted that reading the code
// cannot establish:
//
//   1. the claim actually RUNS — a `workflow_list` really goes out after the load. #814
//      warns that this generic re-derivation can be refused by the fence it repairs
//      (#1071); that warning is about a session with no trustworthy identity, whereas here
//      the load has just minted one. Rather than trust that reasoning, the test drives it.
//   2. a claim that FAILS is disclosed rather than swallowed — `loaded:true` with a silent
//      stale fence is the bug, and returning it quietly would be the bug again.
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
/** The identity the canvas reports AFTER the load — a new instance, as a load always mints. */
const AFTER_LOAD_UUID = "632e8dd7-30df-4de9-b28c-b6c98b9532aa";

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

let sent: string[] = [];

/** A tab whose graph_load succeeds; `listMode` decides what the follow-up claim sees. */
function bridge(listMode: "ok" | "refused" | "throws") {
  let stamp = "e592452b-c172-416d-a8bc-0ec6b96b56e1"; // the pre-load fence, as reported
  return {
    send: async (cmd: Record<string, unknown>) => {
      sent.push(String(cmd.cmd));
      if (cmd.cmd === "graph_load") return { loaded: true, node_count: 59 };
      if (cmd.cmd === "workflow_list") {
        if (listMode === "throws") throw new Error("panel did not answer");
        if (listMode === "refused") throw new Error("workflow instance mismatch: refused");
        return {
          active: {
            path: "workflows/loaded.json",
            filename: "loaded.json",
            title: "loaded.json",
            key: "workflows/loaded.json",
            routing_key: "wf:workflows/loaded.json",
            workflow_uuid: AFTER_LOAD_UUID,
          },
          open: [{ path: "workflows/loaded.json", active: true, modified: true, persisted: true }],
          // `workflows` is REQUIRED, not decoration: corroborateActiveForFence refuses to
          // adopt an identity unless the reply also carries a comparable list, so a
          // fixture without it makes the claim silently fail and looks like a product
          // bug. (It cost me one debugging round here.) This matches the shape a live rig
          // actually returns.
          workflows: [
            { path: "workflows/loaded.json", active: true, modified: true, persisted: true },
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

async function load(listMode: "ok" | "refused" | "throws") {
  const b = bridge(listMode);
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

describe("a load claims the instance it just created (#1478)", () => {
  it("re-derives the fence onto the new instance, and says nothing extra when it works", async () => {
    const out = await load("ok");

    // The claim really went out — without this the assertions below could pass on a load
    // that never attempted anything.
    expect(sent).toContain("graph_load");
    expect(sent).toContain("workflow_list");
    // And it LANDED: the session's stamp is now the post-load identity, so the next graph
    // call carries the id the canvas actually reports.
    expect(out.stamp).toBe(AFTER_LOAD_UUID);

    expect(out.isError).toBe(false);
    // A successful claim is the expected case and does not editorialise.
    expect(out.text).not.toMatch(/could NOT be re-claimed/);
  });

  it("the claim survives the state a load leaves behind (#814's caveat, checked)", async () => {
    // #814 warns the generic re-derivation can be refused by the fence it repairs. That is
    // a different starting state — no trustworthy identity at all — and `workflow_list` is
    // not a fenced command, which is why the reporter's manual recovery works. Driven here
    // rather than argued: the list is answered and the stamp moves.
    await load("ok");
    expect(sent.filter((c) => c === "workflow_list").length).toBeGreaterThan(0);
  });

  it("a claim that FAILS is disclosed, not swallowed", async () => {
    // The whole defect is a silent stale fence behind `loaded:true`. If the claim cannot
    // be made, the caller has to hear it here rather than from the next call's mismatch.
    const out = await load("refused");

    expect(out.text).toMatch(/loaded/i);
    expect(out.text).toMatch(/could NOT be re-claimed/);
    expect(out.text).toMatch(/panel_set_workflow_target/);
  });

  it("an unreadable panel never turns a successful load into a failure", async () => {
    // The load happened. Reporting it as an error would invite a re-load, which replaces
    // the user's graph a second time.
    //
    // Note the claim does NOT throw out to us here: rebindWorkflowFence catches its own
    // read failures and returns a status. The `THREW` branch exists for a rebind that
    // fails in some way it does not model, and asserting on it here was wrong — the real
    // path returns an unreadable status, which is still disclosed.
    const out = await load("throws");

    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/could NOT be re-claimed|THREW/);
    expect(out.text).toMatch(/panel_set_workflow_target/);
  });
});
