// #2438 — panel_run's queued_unknown receipt told the model to inspect a live
// queue with `queue (action:"list")`. That tool is not on the live-canvas
// surface, and the headless ComfyUI route may be unreachable even while the
// panel is connected. The shipped guidance must name a real next step on THIS
// surface: wait for an UNDETERMINED completion, do not re-run.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPanelToolDefs,
  __panelRunTestHooks,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { RunCompletions } from "../../orchestrator/run-completion-journal.js";

/** The Panel/orchestrator phrasing that sent agents to a missing inspector. */
const UNFIXED_QUEUE_LIST = 'queue (action:"list")';
const UNFIXED_QUEUE_ACTION_LIST = "queue action:list";
const UNFIXED_FOLLOW_PANEL = "Follow the Panel's retry_guidance";

function panelRun() {
  const def = buildPanelToolDefs().find((candidate) => candidate.name === "panel_run");
  if (!def) throw new Error("panel_run tool not found");
  return def;
}

function textOf(res: { content?: Array<{ type: string; text?: string }> }): string {
  return res.content?.find((content) => content.type === "text")?.text ?? "";
}

function makeRunCtx(reply: ToolResult): { ctx: PanelToolCtx; calls: unknown[] } {
  const calls: unknown[] = [];
  const ctx: PanelToolCtx = {
    call: async (cmd) => {
      calls.push(cmd);
      return reply;
    },
    confirm: async () => "yes" as const,
    bridge: {} as PanelToolCtx["bridge"],
    tabId: "test-tab",
  };
  return { ctx, calls };
}

beforeEach(() => {
  RunCompletions.reset();
  __panelRunTestHooks.setGotPromptLinesProbe(async () => null);
});

afterEach(() => {
  __panelRunTestHooks.setGotPromptLinesProbe(null);
  RunCompletions.reset();
});

describe("panel_run queued_unknown guidance stays on this surface (#2438)", () => {
  it("the shipped retry_guidance string itself does not name the missing inspector", () => {
    const shipped = __panelRunTestHooks.PANEL_QUEUED_UNKNOWN_RETRY_GUIDANCE;
    expect(shipped).toContain("Do NOT re-run panel_run");
    expect(shipped).toContain("UNDETERMINED completion");
    expect(shipped).toContain("no render-queue inspection tool");
    expect(shipped).not.toContain(UNFIXED_QUEUE_LIST);
    expect(shipped.toLowerCase()).not.toContain(UNFIXED_QUEUE_ACTION_LIST);
    expect(shipped).not.toContain(UNFIXED_FOLLOW_PANEL);
  });

  it("rewrites a Panel queue-list retry_guidance instead of forwarding it", () => {
    const unfixed: ToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            queued_unknown: true,
            retry_guidance: `Check ${UNFIXED_QUEUE_LIST} before retrying the unresolved request.`,
          }),
        },
      ],
    };
    const rewritten = __panelRunTestHooks.applyQueuedUnknownRetryGuidance(unfixed);
    const text = textOf(rewritten);
    expect(text).not.toContain(`Check ${UNFIXED_QUEUE_LIST}`);
    expect(text).not.toContain(UNFIXED_QUEUE_LIST);
    expect(text).toContain(__panelRunTestHooks.PANEL_QUEUED_UNKNOWN_RETRY_GUIDANCE);
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toMatchObject({
      queued_unknown: true,
      retry_guidance: __panelRunTestHooks.PANEL_QUEUED_UNKNOWN_RETRY_GUIDANCE,
    });
  });

  it("id-less queued_unknown does not tell the caller to check queue action:list", async () => {
    const reply: ToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            queued_unknown: true,
            error:
              "run-to-node scope for node 35: a verified-scoped /prompt request FAILED to complete - the /prompt request itself threw (Failed to fetch).",
            indeterminate_count: 1,
            retry_guidance: `Check ${UNFIXED_QUEUE_LIST} before retrying.`,
          }),
        },
      ],
    };
    const { ctx, calls } = makeRunCtx(reply);
    const res = await panelRun().handler({ to_node_id: 35 }, ctx);
    const text = textOf(res);

    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(text).not.toContain(UNFIXED_QUEUE_LIST);
    expect(text.toLowerCase()).not.toContain(UNFIXED_QUEUE_ACTION_LIST);
    expect(text).not.toContain(UNFIXED_FOLLOW_PANEL);
    expect(text).toContain("[UNCERTAIN]");
    expect(text).not.toContain("already left the panel");
    expect(text.toLowerCase()).not.toContain("may have been accepted");
    expect(text).toContain(__panelRunTestHooks.PANEL_QUEUED_UNKNOWN_UNOBSERVED_RETRY_GUIDANCE);
    expect(text).toContain("No second panel_run was dispatched");
  });

  it("partial queued_unknown keeps known ids ticketed and still withholds the inspector", async () => {
    const reply: ToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            queued_unknown: true,
            queued: true,
            complete: false,
            partially_queued: true,
            queued_prompt_ids: ["p-known-1"],
            retry_guidance: `Inspect with ${UNFIXED_QUEUE_LIST} before retrying the unresolved request.`,
          }),
        },
      ],
    };
    const { ctx, calls } = makeRunCtx(reply);
    const res = await panelRun().handler({ batch_count: 2, to_node_id: 9 }, ctx);
    const text = textOf(res);

    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(RunCompletions.ticketFor("p-known-1")).toBeDefined();
    expect(text).toContain("p-known-1");
    expect(text).not.toContain(UNFIXED_QUEUE_LIST);
    expect(text.toLowerCase()).not.toContain(UNFIXED_QUEUE_ACTION_LIST);
    expect(text).not.toContain(UNFIXED_FOLLOW_PANEL);
    expect(text).toContain("Do NOT re-run panel_run");
    expect(text).toContain("UNDETERMINED completion");
  });
});
