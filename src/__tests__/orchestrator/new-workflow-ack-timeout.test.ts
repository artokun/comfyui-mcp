// #2705 — `panel_new_workflow` timed out AFTER the new tab was already created.
//
// The reporter's sequence, verbatim from the issue:
//
//   1. bound to a saved workflow tab
//   2. panel_new_workflow({})  ->  15s ack timeout, "may have been applied"
//   3. panel_graph_outline     ->  refused: "workflow instance mismatch …
//                                  issued for 3b86446a…, tab reported d2d3e6f4…"
//   4. panel_set_workflow_target({mode:"current"})  ->  binds, blank graph
//
// So the mutation reached the panel and APPLIED; only the acknowledgement was
// lost. Two consequences, and the old code had neither:
//
//   * the OUTCOME stayed unknown, even though the panel journals a rid-correlated
//     receipt for exactly this command (#402/#514 `last_open`), and
//   * the session's workflow-instance FENCE was never re-pointed, so every graph
//     call afterwards was refused against the workflow the user had just left.
//
// `panel_open_workflow` has had this recovery since #215/#319/#496. The whole of
// `panel_new_workflow` was `ctx.call(...)` then `if (res.isError) return res` —
// which returns before the fence refresh below it and never asks the panel what
// happened.
//
// WHAT MAKES A RECOVERY SAFE HERE. `workflow_new` is NOT idempotent: a blind
// retry leaves a second blank tab. So nothing may be inferred from `active`
// matching (after a reconnect the frontend restores a tab by itself), and nothing
// may say "safe to retry" unless the panel journaled a clean negative. The only
// evidence used is the receipt for THIS exact rid AND this exact command name,
// corroborated — for the identity adoption — against the live active record still
// naming the routing key the receipt says this command minted.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __openWorkflowTestHooks,
  buildPanelToolDefs,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

const textOf = (res: ToolResult): string =>
  res.content.find((c) => c.type === "text")?.text ?? "";
const jsonOf = (res: ToolResult): Record<string, unknown> => JSON.parse(textOf(res));

/** RFC-shaped: the fence regex requires a [1-5] version and an [89ab] variant. */
const NEW_UUID = "d2d3e6f4-d810-4149-a496-c6ff47bca22e";
const PRIOR_UUID = "3b86446a-94c7-4f6f-94ff-086df603b568";
const RID = "new-rid-1";
/** The per-instance routing handle the panel mints for the tab it just created. */
const NEW_KEY = "tmp:9f2c1a";

const newWorkflow = () => buildPanelToolDefs().find((d) => d.name === "panel_new_workflow")!;

/** The bridge's own ack-timeout text for `workflow_new` — the exact message the
 *  reporter quoted, which is what `isAckTimeout(res, "workflow_new")` keys on. */
const ackTimeout = (): ToolResult => ({
  content: [
    {
      type: "text" as const,
      text:
        `Error: Panel tab wf:workflows/mine.json did not reply to "workflow_new" within 15000 ms — ` +
        `the ComfyUI tab may be backgrounded or frozen. This command MUTATES and was already ` +
        `delivered to the tab, so it may have been applied despite the missing reply`,
    },
  ],
  isError: true,
});

/** The #402 mid-command reconnect drop — the other outcome-unknown shape. */
const reconnectDrop = (): ToolResult => ({
  content: [{ type: "text" as const, text: "Error: tab disconnected mid-command — OUTCOME UNKNOWN" }],
  isError: true,
});

/** A receipt for THIS rid, applied, naming the tab it created. */
const appliedReceipt = (over: Record<string, unknown> = {}) => ({
  rid: RID,
  answers_only_command_rid: RID,
  cmd: "workflow_new",
  requested: null,
  resolved: { path: null, filename: null, routing_key: NEW_KEY },
  applied: true,
  ...over,
});

/** `workflow_list` reporting the created tab as the live active canvas. */
const listWithActiveNewTab = (receipt: Record<string, unknown>) => ({
  active_confirmed: true,
  active: {
    path: null,
    filename: null,
    title: "Unsaved Workflow",
    key: NEW_KEY,
    routing_key: NEW_KEY,
    workflow_uuid: NEW_UUID,
  },
  workflows: [{ path: null, filename: null, key: NEW_KEY, routing_key: NEW_KEY, active: true }],
  last_open: receipt,
});

let fence: string | undefined;
let stamps: string[];
let cmds: string[];

/**
 * Programmable ctx. `newReply` decides what `workflow_new` answers; each
 * `workflow_list` yields the next entry in `listReplies` (the last repeats).
 * `rid: null` models a bridge/panel pair that exposes no request id at all.
 */
function makeCtx(opts: {
  newReply: () => ToolResult;
  listReplies?: Array<Record<string, unknown> | null>;
  rid?: string | null;
  canMutate?: boolean;
  refuseStamp?: boolean;
}): PanelToolCtx {
  let listIdx = 0;
  const refreshWorkflowUuid = vi.fn((_tabId: string, uuid: string) => {
    // `refuseStamp` models the bridge declining the stamp (no routable tab for
    // this session): a uuid was published and STILL nothing was adopted.
    if (opts.refuseStamp) return false;
    fence = uuid;
    stamps.push(uuid);
    return true;
  });
  const bridge: Pick<
    PanelToolCtx["bridge"],
    "workflowUuidFor" | "refreshWorkflowUuid" | "isHeadless"
  > = {
    workflowUuidFor: () => ({ known: true, uuid: fence }),
    refreshWorkflowUuid,
    isHeadless: () => false,
  };
  const ctx: Pick<PanelToolCtx, "call" | "confirm" | "tabId" | "tabGraphMutationCapability"> & {
    bridge: typeof bridge;
  } = {
    call: async (
      cmd: Record<string, unknown>,
      _timeoutMs?: number,
      onDispatchedRid?: (rid: string) => void,
    ) => {
      cmds.push(cmd.cmd as string);
      if (cmd.cmd === "workflow_new") {
        if (opts.rid !== null) onDispatchedRid?.(opts.rid ?? RID);
        return opts.newReply();
      }
      if (cmd.cmd === "workflow_list") {
        const replies = opts.listReplies ?? [];
        const reply = replies.length ? replies[Math.min(listIdx, replies.length - 1)] : null;
        listIdx++;
        return { content: [{ type: "text" as const, text: JSON.stringify(reply ?? {}) }] };
      }
      return { content: [{ type: "text" as const, text: "{}" }] };
    },
    confirm: async () => "yes" as const,
    tabId: "tab-1",
    tabGraphMutationCapability: () => ({ known: true, canMutate: opts.canMutate ?? true }),
    bridge,
  };
  // ONE assertion, and the members above are TYPE-CHECKED against the real
  // interfaces by the `Pick`s — so a signature drift in PanelToolCtx or UiBridge
  // still breaks this harness instead of being papered over by `as unknown as`.
  // The cast only supplies the members these handlers never touch.
  return ctx as PanelToolCtx;
}

beforeAll(() => {
  // Fast, deterministic verify timing so these don't wait the real ~6s budget.
  __openWorkflowTestHooks.setOpenVerifyTiming({ budgetMs: 200, intervalMs: 1, probeTimeoutMs: 50 });
});
afterAll(() => {
  __openWorkflowTestHooks.setOpenVerifyTiming(null);
});
beforeEach(() => {
  fence = PRIOR_UUID; // the wedge: still stamped with the workflow we just left
  stamps = [];
  cmds = [];
});

describe("#2705: an unacked workflow_new is settled by the panel's own receipt", () => {
  it("reports the creation as applied-but-unacked instead of an unknown outcome", async () => {
    const res = await newWorkflow().handler(
      {},
      makeCtx({ newReply: ackTimeout, listReplies: [listWithActiveNewTab(appliedReceipt())] }),
    );
    expect(res.isError).toBeFalsy();
    const body = jsonOf(res);
    expect(body.created).toBe(true);
    // The machine-readable verdict the issue asked for — no prose parsing.
    expect(body.applied_but_ack_timed_out).toBe(true);
    expect(body.recovered).toBe(true);
    expect(body.routing_key).toBe(NEW_KEY);
    // It actually asked the panel; the old code returned before any probe.
    expect(cmds).toEqual(["workflow_new", "workflow_list"]);
  });

  // THE fix, stated directly: step 3 of the report must stop happening.
  it("re-points the session fence at the canvas the timed-out command created", async () => {
    const ctx = makeCtx({
      newReply: ackTimeout,
      listReplies: [listWithActiveNewTab(appliedReceipt())],
    });
    const res = await newWorkflow().handler({}, ctx);
    expect(stamps).toEqual([NEW_UUID]);
    expect(fence).toBe(NEW_UUID);
    expect(fence).not.toBe(PRIOR_UUID);
    expect(jsonOf(res).workflow_instance_adopted).toBe(true);
    expect(jsonOf(res).graph_binding).toBe("bound");
  });

  it("recovers a mid-command reconnect drop the same way", async () => {
    const res = await newWorkflow().handler(
      {},
      makeCtx({ newReply: reconnectDrop, listReplies: [listWithActiveNewTab(appliedReceipt())] }),
    );
    expect(res.isError).toBeFalsy();
    expect(jsonOf(res).applied_but_ack_timed_out).toBe(true);
    expect(fence).toBe(NEW_UUID);
    // …but does not tell the user their tab was SLOW when it disconnected.
    expect(String(jsonOf(res).note)).toMatch(/disconnected mid-command/);
    expect(String(jsonOf(res).note)).not.toMatch(/within the 15s window/);
  });

  it("never claims the recovered tab is BLANK, and never invites a retry", async () => {
    const res = await newWorkflow().handler(
      {},
      makeCtx({ newReply: ackTimeout, listReplies: [listWithActiveNewTab(appliedReceipt())] }),
    );
    const body = jsonOf(res);
    // The panel journals the receipt BEFORE deciding the tab is provably empty
    // (#708), so `applied:true` proves created-and-active, never blank.
    expect(body.empty).toBe("unknown");
    expect(String(body.note)).toMatch(/NOT PROVEN BLANK/);
    expect(String(body.note)).toMatch(/panel_graph_outline/);
    expect(String(body.note)).toMatch(/Do NOT call panel_new_workflow again/i);
  });
});

describe("#2705: what the recovery refuses to conclude", () => {
  it("does not adopt an identity when the created tab is no longer active", async () => {
    const res = await newWorkflow().handler(
      {},
      makeCtx({
        newReply: ackTimeout,
        listReplies: [
          {
            active_confirmed: true,
            // A DIFFERENT canvas is in view now — its uuid must never fence us.
            active: {
              path: "workflows/other.json",
              routing_key: "wf:workflows/other.json",
              workflow_uuid: "11111111-2222-4333-8444-555555555555",
            },
            last_open: appliedReceipt(),
          },
        ],
      }),
    );
    // The creation still HAPPENED — retracting that would be the worse lie.
    expect(res.isError).toBeFalsy();
    const body = jsonOf(res);
    expect(body.created).toBe(true);
    expect(body.workflow_instance_adopted).toBe(false);
    expect(body.graph_binding).toBe("not_recovered");
    expect(stamps).toEqual([]);
    expect(fence).toBe(PRIOR_UUID);
    expect(String(body.note)).toMatch(/panel_set_workflow_target/);
  });

  it("does not adopt when the active record carries no usable instance identity", async () => {
    const res = await newWorkflow().handler(
      {},
      makeCtx({
        newReply: ackTimeout,
        listReplies: [
          {
            active_confirmed: true,
            // Right tab, but the panel withheld the uuid (#716 fail-closed).
            active: { path: null, key: NEW_KEY, routing_key: NEW_KEY },
            last_open: appliedReceipt(),
          },
        ],
      }),
    );
    expect(res.isError).toBeFalsy();
    expect(jsonOf(res).workflow_instance_adopted).toBe(false);
    expect(stamps).toEqual([]);
    expect(fence).toBe(PRIOR_UUID);
  });

  it("reports NOT-adopted when the bridge itself declines the stamp", async () => {
    const res = await newWorkflow().handler(
      {},
      makeCtx({
        newReply: ackTimeout,
        listReplies: [listWithActiveNewTab(appliedReceipt())],
        refuseStamp: true,
      }),
    );
    expect(res.isError).toBeFalsy();
    const body = jsonOf(res);
    expect(body.created).toBe(true);
    // A uuid WAS published; the adoption still did not happen. Saying "the panel
    // published no identity" here would name the wrong cause.
    expect(body.workflow_instance_adopted).toBe(false);
    expect(body.graph_binding).toBe("not_recovered");
    expect(String(body.note)).toMatch(/this bridge did not accept the stamp/);
    expect(fence).toBe(PRIOR_UUID);
  });

  it("does not read an EARLIER command's receipt as an answer about this one", async () => {
    const res = await newWorkflow().handler(
      {},
      makeCtx({
        newReply: ackTimeout,
        listReplies: [listWithActiveNewTab(appliedReceipt({ rid: "older-rid", answers_only_command_rid: "older-rid" }))],
      }),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/outcome is undetermined/i);
    expect(textOf(res)).not.toMatch(/safe to call panel_new_workflow again/i);
    expect(fence).toBe(PRIOR_UUID);
  });

  it("does not accept a workflow_OPEN receipt that happens to carry this rid", async () => {
    const res = await newWorkflow().handler(
      {},
      makeCtx({
        newReply: ackTimeout,
        listReplies: [listWithActiveNewTab(appliedReceipt({ cmd: "workflow_open" }))],
      }),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/outcome is undetermined/i);
    expect(fence).toBe(PRIOR_UUID);
  });

  it('says "safe to retry" ONLY for a journaled clean negative', async () => {
    const res = await newWorkflow().handler(
      {},
      makeCtx({
        newReply: ackTimeout,
        listReplies: [
          {
            active_confirmed: true,
            last_open: appliedReceipt({ applied: false, error: "command service unavailable" }),
          },
        ],
      }),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/confirmed NOT applied/);
    expect(textOf(res)).toMatch(/safe to call panel_new_workflow again/);
    expect(textOf(res)).toMatch(/command service unavailable/);
    expect(fence).toBe(PRIOR_UUID);
  });

  it('treats applied:"unknown" as undetermined — never as a clean negative', async () => {
    const res = await newWorkflow().handler(
      {},
      makeCtx({
        newReply: ackTimeout,
        listReplies: [
          {
            active_confirmed: true,
            // The panel's own wording for "it may have got partway".
            last_open: appliedReceipt({
              applied: "unknown",
              error: "workflow_new created a tab but lost ownership",
            }),
          },
        ],
      }),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/outcome is undetermined/i);
    expect(textOf(res)).toMatch(/lost ownership/);
    // The cost of getting this wrong is a SECOND blank tab, so the message must
    // not merely omit the retry advice — it must forbid it.
    expect(textOf(res)).toMatch(/Do NOT re-issue/);
    expect(textOf(res)).not.toMatch(/safe to call panel_new_workflow again/i);
    expect(fence).toBe(PRIOR_UUID);
  });

  it("identifies an older panel that cannot make receipt claims at all", async () => {
    const res = await newWorkflow().handler(
      {},
      // No `active_confirmed`, no `last_open` — the #514 capability probe.
      makeCtx({ newReply: ackTimeout, listReplies: [{ active: { path: null, routing_key: NEW_KEY } }] }),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/does not provide request-id-correlated open receipts/);
    expect(fence).toBe(PRIOR_UUID);
  });

  it("stays undetermined when the bridge exposed no request id to correlate on", async () => {
    const res = await newWorkflow().handler(
      {},
      makeCtx({
        newReply: ackTimeout,
        rid: null,
        listReplies: [listWithActiveNewTab(appliedReceipt())],
      }),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/did not expose a request id/);
    // No rid means no correlation is possible, so it must not even probe.
    expect(cmds).toEqual(["workflow_new"]);
    expect(fence).toBe(PRIOR_UUID);
  });

  it("names the STALE FENCE on every undetermined exit, not just the unknown outcome", async () => {
    const res = await newWorkflow().handler(
      {},
      makeCtx({ newReply: ackTimeout, listReplies: [{ active_confirmed: true }] }),
    );
    expect(res.isError).toBe(true);
    // An agent that reads only "outcome unknown" and then meets a mismatch has no
    // way to know the two are the same event.
    expect(textOf(res)).toMatch(/workflow instance mismatch/);
    expect(textOf(res)).toMatch(/panel_set_workflow_target/);
  });
});

describe("#2705: a genuine acked failure is NOT a candidate for recovery", () => {
  it("returns the panel's own executor error verbatim, with no receipt probe", async () => {
    const panelError = (): ToolResult => ({
      content: [
        {
          type: "text" as const,
          text:
            "Error: workflow_new could not take the workflow switch/reload section because " +
            "another workflow operation is still in flight. Retry in a moment.",
        },
      ],
      isError: true,
    });
    const res = await newWorkflow().handler(
      {},
      makeCtx({ newReply: panelError, listReplies: [listWithActiveNewTab(appliedReceipt())] }),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/still in flight/);
    expect(cmds).toEqual(["workflow_new"]);
    expect(fence).toBe(PRIOR_UUID);
  });

  it("does not fire on another command's ack timeout wearing the same preamble", async () => {
    // The command name lives INSIDE the anchored pattern. A workflow_OPEN timeout
    // surfacing here must not open workflow_new's recovery — that is what would
    // let one command's receipt settle a different command's outcome.
    const otherTimeout = (): ToolResult => ({
      content: [
        {
          type: "text" as const,
          text: `Error: Panel tab abcd1234 did not reply to "workflow_open" within 15000 ms`,
        },
      ],
      isError: true,
    });
    const res = await newWorkflow().handler(
      {},
      makeCtx({ newReply: otherTimeout, listReplies: [listWithActiveNewTab(appliedReceipt())] }),
    );
    expect(res.isError).toBe(true);
    expect(cmds).toEqual(["workflow_new"]);
    expect(fence).toBe(PRIOR_UUID);
  });
});
