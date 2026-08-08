// #1071 — the fence repair was gated behind the one call the wedge blocks.
//
// A session fenced to a workflow instance that is no longer active has EVERY
// panel_* call refused with "workflow instance mismatch", and the documented
// recovery (panel_set_workflow_target({mode:"current"})) cannot help: it recovers
// by reading workflow_list, and workflow_list is NOT exempt from the panel's fence
// (activeWorkflowFenceApplies exempts only canvas-independent ops, workflow_open /
// workflow_new, and non-active-targeted rename/close). The recovery probe is
// refused by the very fence it exists to repair. A reporter called it five times
// over twenty minutes and lost the canvas for the rest of the task.
//
// `workflow_open` IS exempt, so it still round-trips — and its reply already
// carries the answer. The panel publishes `workflow_uuid` there only after a FINAL
// SYNCHRONOUS check that the target is still the active workflow (#716,
// activeWorkflowUuidForOpenReply), omitting it otherwise expressly so "the MCP
// keeps its existing fence fail-closed". It is a fence-quality value the panel went
// out of its way to prove.
//
// refreshOpenWorkflowUuid ignored it unless the workflow_list read ALSO succeeded
// and confirmed — so in the wedged state it took the early return and left the
// session fenced to the dead instance forever.
//
// THREE outcomes for that read, and the difference is the bug:
//   answered + confirms    → prefer the just-read value (freshest)
//   answered + contradicts → adopt NOTHING (another tab won the active slot)
//   could not ask          → adopt the reply's proven uuid (this file's subject)

import { beforeEach, describe, expect, it } from "vitest";

import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

// RFC-shaped on purpose: the fence regex requires a [1-5] version and an [89ab]
// variant nibble, and an arbitrary-looking placeholder is silently rejected —
// which is how a sibling test once "proved" a working fix did not work.
const OPENED_UUID = "11111111-2222-4333-8444-555555555555";
const PRIOR_UUID = "99999999-8888-4777-a666-555555555555";
const OTHER_UUID = "22222222-3333-4444-8555-666666666666";

const PATH = "workflows/a.json";
const ROUTING = `wf:${PATH}`;

let fence: string | undefined;
let sent: Array<Record<string, unknown>>;
let stamps: string[];

const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text;

/** The panel's real workflow_open reply, with the #716 uuid present or withheld. */
function openReply(withUuid: boolean): Record<string, unknown> {
  return {
    opened: { path: PATH, filename: "a.json" },
    routing_key: ROUTING,
    ...(withUuid ? { workflow_uuid: OPENED_UUID } : {}),
    modified: false,
    open_seq: 7,
  };
}

/**
 * `listBehaviour` models what the panel does with the corroborating read:
 *  - "refused"     → the panel's executor throws the fence error. ctx.call catches
 *                    it and returns a fail() ToolResult, so this arrives as
 *                    `res.isError` — NOT as a rejection. This is the wedge.
 *  - "unparseable" → a reply that is not JSON: answered nothing.
 *  - "confirms"    → active IS the workflow we opened
 *  - "contradicts" → another tab won the active slot
 */
function bridgeFor(
  listBehaviour: "refused" | "unparseable" | "confirms" | "contradicts",
  withUuid = true,
) {
  return {
    send: async (cmd: Record<string, unknown>) => {
      sent.push(cmd);
      if (cmd.cmd === "workflow_open") return openReply(withUuid);
      if (cmd.cmd === "workflow_list") {
        if (listBehaviour === "refused") {
          throw new Error(
            "workflow instance mismatch: this command targets a different workflow than the active canvas",
          );
        }
        if (listBehaviour === "unparseable") return "not json at all";
        if (listBehaviour === "contradicts") {
          return {
            active: {
              path: "workflows/somethingelse.json",
              filename: "somethingelse.json",
              title: "Other",
              key: "wf:workflows/somethingelse.json",
              routing_key: "wf:workflows/somethingelse.json",
              workflow_uuid: OTHER_UUID,
            },
            active_confirmed: true,
            workflows: [],
          };
        }
        return {
          active: {
            path: PATH,
            filename: "a.json",
            title: "A",
            key: ROUTING,
            routing_key: ROUTING,
            workflow_uuid: OPENED_UUID,
          },
          active_confirmed: true,
          workflows: [{ path: PATH, filename: "a.json", key: ROUTING, routing_key: ROUTING, active: true, persisted: true }],
        };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: "tab-1", title: "A", connected_at: 0 }],
    resolveActiveTabId: () => "tab-1",
    workflowUuidFor: () => ({ known: true, uuid: fence }),
    refreshWorkflowUuid: (_tabId: string, uuid: string) => {
      fence = uuid;
      stamps.push(uuid);
      return true;
    },
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

const ctxWith = (b: ReturnType<typeof bridgeFor>): PanelToolCtx => makePanelToolCtx(b, "tab-1");
const openWorkflow = () => buildPanelToolDefs().find((d) => d.name === "panel_open_workflow")!;

beforeEach(() => {
  sent = [];
  stamps = [];
  fence = PRIOR_UUID; // the wedge: fenced to the instance we are no longer on
});

describe("a refused corroborating read no longer strands the fence", () => {
  it("adopts the open reply's proven uuid when workflow_list is REFUSED", async () => {
    await openWorkflow().handler({ path: PATH }, ctxWith(bridgeFor("refused")));

    expect(sent.map((c) => c.cmd)).toContain("workflow_list"); // it still tries the fresher source
    expect(fence).toBe(OPENED_UUID);
    expect(fence).not.toBe(PRIOR_UUID);
  });

  it("adopts it when the reply cannot be parsed — same information content: none", async () => {
    await openWorkflow().handler({ path: PATH }, ctxWith(bridgeFor("unparseable")));

    expect(fence).toBe(OPENED_UUID);
  });

  // Fail-closed is preserved: a panel that could NOT prove the uuid omits it, and
  // an omitted uuid must refresh nothing rather than being invented.
  it("adopts nothing when the reply carries no uuid", async () => {
    await openWorkflow().handler({ path: PATH }, ctxWith(bridgeFor("refused", false)));

    expect(stamps).toEqual([]);
    expect(fence).toBe(PRIOR_UUID);
  });
});

describe("an answered read still governs", () => {
  it("prefers the just-read active uuid when it confirms", async () => {
    await openWorkflow().handler({ path: PATH }, ctxWith(bridgeFor("confirms")));

    expect(fence).toBe(OPENED_UUID);
    expect(stamps.length).toBe(1);
  });

  // The safety case. A readable answer naming a DIFFERENT active workflow means
  // another tab won the slot between the open and the read; stamping our target's
  // uuid then would fence this session to a canvas that is not mounted. The reply
  // is older than the read, so it must NOT override it.
  it("adopts nothing when the read names a different active workflow", async () => {
    await openWorkflow().handler({ path: PATH }, ctxWith(bridgeFor("contradicts")));

    expect(stamps).toEqual([]);
    expect(fence).toBe(PRIOR_UUID);
  });
});

describe("the open itself is still reported honestly", () => {
  it("does not turn a refused corroboration into a failed open", async () => {
    const res = await openWorkflow().handler({ path: PATH }, ctxWith(bridgeFor("refused")));

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain(PATH);
  });
});

// The other half of #1071: when the rebind genuinely cannot recover, the message
// must name the recovery that CAN. The reporter called mode:"current" five times
// over twenty minutes because the advice was "retry in a moment" — advice that
// cannot work, since the read it retries is the one the fence refuses.
describe("the unrecoverable rebind points at the fence-exempt recovery", () => {
  const setTarget = () => buildPanelToolDefs().find((d) => d.name === "panel_set_workflow_target")!;

  it("leads with panel_open_workflow and says why it works", async () => {
    // A bridge whose every read is refused — the wedged session.
    const wedged = {
      send: async (cmd: Record<string, unknown>) => {
        sent.push(cmd);
        throw new Error(
          "workflow instance mismatch: this command targets a different workflow than the active canvas",
        );
      },
      push: () => 1,
      canReach: () => true,
      isHeadless: () => false,
      tabs: () => [{ tab_id: "tab-1", title: "A", connected_at: 0 }],
      resolveActiveTabId: () => "tab-1",
      workflowUuidFor: () => ({ known: true, uuid: PRIOR_UUID }),
      refreshWorkflowUuid: () => false,
      tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    } as unknown as PanelToolCtx["bridge"];

    const res = await setTarget().handler({ mode: "current" }, makePanelToolCtx(wedged, "tab-1", new WorkflowTargetStore()));
    const text = textOf(res);

    expect(text).toContain("panel_open_workflow");
    // The REASON, not just the name — an agent that knows why will not retry the
    // rebind instead.
    expect(text).toMatch(/EXEMPTS workflow_open/);
    expect(text).toMatch(/retrying this call cannot work/);
    // And the trap that would otherwise follow: listing is fenced too.
    expect(text).toMatch(/panel_list_workflows is fenced too/);
  });

  it("no longer leads with bare 'retry in a moment'", async () => {
    const wedged = {
      send: async () => {
        throw new Error("workflow instance mismatch: this command targets a different workflow");
      },
      push: () => 1,
      canReach: () => true,
      isHeadless: () => false,
      tabs: () => [{ tab_id: "tab-1", title: "A", connected_at: 0 }],
      resolveActiveTabId: () => "tab-1",
      workflowUuidFor: () => ({ known: true, uuid: PRIOR_UUID }),
      refreshWorkflowUuid: () => false,
      tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    } as unknown as PanelToolCtx["bridge"];

    const text = textOf(
      await setTarget().handler({ mode: "current" }, makePanelToolCtx(wedged, "tab-1", new WorkflowTargetStore())),
    );
    // Retry is still offered, but it must not be the FIRST instruction.
    const openAt = text.indexOf("panel_open_workflow");
    const retryAt = text.indexOf("retry");
    expect(openAt).toBeGreaterThan(-1);
    expect(openAt).toBeLessThan(retryAt);
  });
});

// WHY the read failed decides the remedy — bucketing the two would hand half the
// callers an instruction they cannot act on. A dead tab is not a fence problem:
// reopening needs a tab too, so "retry" really is the reachable move there.
describe("the remedy branches on the cause, not on the symptom", () => {
  const setTarget = () => buildPanelToolDefs().find((d) => d.name === "panel_set_workflow_target")!;

  function wedgedWith(message: string) {
    return {
      send: async () => {
        throw new Error(message);
      },
      push: () => 1,
      canReach: () => true,
      isHeadless: () => false,
      tabs: () => [{ tab_id: "tab-1", title: "A", connected_at: 0 }],
      resolveActiveTabId: () => "tab-1",
      workflowUuidFor: () => ({ known: true, uuid: PRIOR_UUID }),
      refreshWorkflowUuid: () => false,
      tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    } as unknown as PanelToolCtx["bridge"];
  }

  it("keeps the retry lead when the panel simply is not answering", async () => {
    const text = textOf(
      await setTarget().handler(
        { mode: "current" },
        makePanelToolCtx(wedgedWith("no connected tab"), "tab-1", new WorkflowTargetStore()),
      ),
    );

    expect(text).toMatch(/WHAT TO DO: retry in a moment/);
    // Reopening needs a tab too, so it must NOT be advertised as the fix here.
    expect(text).not.toMatch(/reopen the workflow you want/);
  });

  it("switches to the reopen lead when the FENCE is what refused", async () => {
    const text = textOf(
      await setTarget().handler(
        { mode: "current" },
        makePanelToolCtx(
          wedgedWith("workflow instance mismatch: this command targets a different workflow"),
          "tab-1",
          new WorkflowTargetStore(),
        ),
      ),
    );

    expect(text).toMatch(/reopen the workflow you want/);
    expect(text).not.toMatch(/WHAT TO DO: retry in a moment/);
  });
});
