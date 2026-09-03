// #2521 — panel_run returned queued_unknown three times while ComfyUI never
// logged "got prompt" and the queue stayed empty. retry_guidance still said a
// /prompt had left the panel and may have been accepted. Fail closed as not
// queued when there is no prompt_id and the server never logged a prompt.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPanelToolDefs,
  __panelRunTestHooks,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { RunCompletions } from "../../orchestrator/run-completion-journal.js";
import { QueueMonitor } from "../../services/queue-monitor.js";

const LEFT_THE_PANEL = "already left the panel";
const MAY_HAVE_BEEN_ACCEPTED = "may have been accepted";
const UNFIXED_QUEUE_LIST = 'queue (action:"list")';

type QueueMonitorPrivate = {
  selfQueuedIds: Set<string>;
  lastSelfQueueTs: number | null;
  state: {
    connected: boolean;
    runningPromptId: string | null;
    pendingPromptIds: string[];
    queueRemaining: number;
    lastCompleted: { promptId: string; status: string; at: number } | null;
  };
};

const qm = QueueMonitor as QueueMonitorPrivate;

function panelRun() {
  const def = buildPanelToolDefs().find((candidate) => candidate.name === "panel_run");
  if (!def) throw new Error("panel_run tool not found");
  return def;
}

function textOf(res: { content?: Array<{ type: string; text?: string }> }): string {
  return res.content?.find((content) => content.type === "text")?.text ?? "";
}

function queuedUnknownReply(extra: Record<string, unknown> = {}): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          queued_unknown: true,
          indeterminate_count: 1,
          error:
            "The full-graph run could not be confirmed: the frontend's queue call did not answer within this run's 15s command budget (#1565).",
          retry_guidance:
            "No prompt was CONFIRMED queued, but 1 /prompt request(s) DID leave the panel — ComfyUI may have been accepted them.",
          ...extra,
        }),
      },
    ],
  };
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
    tabId: "test-tab-2521",
  };
  return { ctx, calls };
}

function resetQueueMonitor(): void {
  qm.selfQueuedIds.clear();
  qm.lastSelfQueueTs = null;
  qm.state.connected = false;
  qm.state.runningPromptId = null;
  qm.state.pendingPromptIds = [];
  qm.state.queueRemaining = 0;
  qm.state.lastCompleted = null;
}

beforeEach(() => {
  RunCompletions.reset();
  resetQueueMonitor();
});

afterEach(() => {
  __panelRunTestHooks.setGotPromptLinesProbe(null);
  RunCompletions.reset();
  resetQueueMonitor();
});

describe("classifyQueuedUnknownReach (#2521)", () => {
  const dispatchedAt = Date.parse("2026-08-29T14:09:00");

  it("fail-closes when logs are readable and have no post-dispatch got prompt", () => {
    const reach = __panelRunTestHooks.classifyQueuedUnknownReach({
      dispatchedAt,
      logLines: [
        "2026-08-29T14:08:24 - [INFO] got prompt",
        "2026-08-29T14:08:48 - [INFO] Prompt executed in 24.18 seconds",
      ],
      queueObserved: true,
      queueIdle: true,
      newPromptVisible: false,
      completedAfterDispatch: false,
    });
    expect(reach.kind).toBe("not-queued");
    expect(reach.gotPrompt).toBe(false);
  });

  it("treats an empty readable log as not queued", () => {
    const reach = __panelRunTestHooks.classifyQueuedUnknownReach({
      dispatchedAt,
      logLines: [],
      queueObserved: false,
      queueIdle: true,
      newPromptVisible: false,
      completedAfterDispatch: false,
    });
    expect(reach.kind).toBe("not-queued");
  });

  it("keeps reached when a got prompt lands after dispatch", () => {
    const reach = __panelRunTestHooks.classifyQueuedUnknownReach({
      dispatchedAt,
      logLines: [
        "2026-08-29T14:08:24 - [INFO] got prompt",
        "2026-08-29T14:09:05 - [INFO] got prompt",
      ],
      queueObserved: true,
      queueIdle: true,
      newPromptVisible: false,
      completedAfterDispatch: false,
    });
    expect(reach.kind).toBe("reached");
    expect(reach.gotPrompt).toBe(true);
  });

  it("does not fail closed when logs are unread and the queue was not observed", () => {
    const reach = __panelRunTestHooks.classifyQueuedUnknownReach({
      dispatchedAt,
      logLines: null,
      queueObserved: false,
      queueIdle: true,
      newPromptVisible: false,
      completedAfterDispatch: false,
    });
    expect(reach.kind).toBe("unobserved");
  });

  it("fail-closes on an observed idle queue when logs are unread", () => {
    const reach = __panelRunTestHooks.classifyQueuedUnknownReach({
      dispatchedAt,
      logLines: null,
      queueObserved: true,
      queueIdle: true,
      newPromptVisible: false,
      completedAfterDispatch: false,
    });
    expect(reach.kind).toBe("not-queued");
  });

  it("keeps reached when a new queue prompt is visible even without a log line", () => {
    const reach = __panelRunTestHooks.classifyQueuedUnknownReach({
      dispatchedAt,
      logLines: null,
      queueObserved: true,
      queueIdle: false,
      newPromptVisible: true,
      completedAfterDispatch: false,
    });
    expect(reach.kind).toBe("reached");
  });
});

describe("logHasGotPromptAfter (#2521)", () => {
  const dispatchedAt = Date.parse("2026-08-29T14:09:00");

  it("ignores a got prompt that finished before this dispatch", () => {
    expect(
      __panelRunTestHooks.logHasGotPromptAfter(
        ["2026-08-29T14:08:24 - [INFO] got prompt"],
        dispatchedAt,
      ),
    ).toBe(false);
  });

  it("accepts ISO and space-separated ComfyUI timestamps after dispatch", () => {
    expect(
      __panelRunTestHooks.logHasGotPromptAfter(
        ["2026-08-29T14:09:12 - [INFO] got prompt"],
        dispatchedAt,
      ),
    ).toBe(true);
    expect(
      __panelRunTestHooks.logHasGotPromptAfter(
        ["2026-08-29 14:09:12 [INFO] got prompt"],
        dispatchedAt,
      ),
    ).toBe(true);
  });

  it("treats an untimestamped got prompt as possible evidence", () => {
    expect(__panelRunTestHooks.logHasGotPromptAfter(["[INFO] got prompt"], dispatchedAt)).toBe(
      true,
    );
  });
});

describe("panel_run id-less queued_unknown fails closed when ComfyUI never got the prompt (#2521)", () => {
  it("full-graph: empty logs + idle queue is not queued, and does not claim the request left the panel", async () => {
    __panelRunTestHooks.setGotPromptLinesProbe(async () => [
      "2026-08-29T14:08:24 - [INFO] got prompt",
      "2026-08-29T14:08:48 - [INFO] Prompt executed in 24.18 seconds",
    ]);
    qm.state.connected = true;
    const { ctx, calls } = makeRunCtx(queuedUnknownReply());

    const res = await panelRun().handler({}, ctx);
    const text = textOf(res);

    expect(calls).toHaveLength(1);
    expect(res.isError).toBe(true);
    expect(text).toMatch(/not queued|did not queue|never logged/i);
    expect(text).toContain("got prompt");
    expect(text.toLowerCase()).toContain("you may retry");
    expect(text).not.toContain(LEFT_THE_PANEL);
    expect(text.toLowerCase()).not.toContain(MAY_HAVE_BEEN_ACCEPTED);
    expect(text).not.toContain(UNFIXED_QUEUE_LIST);
    expect(text).not.toContain("[UNCERTAIN]");
    expect(QueueMonitor.attributeRun("anything")).toBe("not-mine");
  });

  it("scoped run: the same empty-log idle-queue shape is not queued", async () => {
    __panelRunTestHooks.setGotPromptLinesProbe(async () => []);
    qm.state.connected = true;
    const { ctx, calls } = makeRunCtx(
      queuedUnknownReply({
        error:
          "The queue acknowledgement did not include a usable prompt_id, so the panel cannot confirm or correlate this run.",
      }),
    );

    const res = await panelRun().handler({ to_node_id: 35 }, ctx);
    const text = textOf(res);

    expect(calls).toHaveLength(1);
    expect(res.isError).toBe(true);
    expect(text).not.toContain(LEFT_THE_PANEL);
    expect(text.toLowerCase()).not.toContain(MAY_HAVE_BEEN_ACCEPTED);
    expect(text.toLowerCase()).toContain("you may retry");
    expect(text).toContain("enqueue_workflow");
  });

  it("keeps queued_unknown when ComfyUI DID log got prompt after dispatch", async () => {
    __panelRunTestHooks.setGotPromptLinesProbe(async () => [
      "2099-01-01T00:00:00 - [INFO] got prompt",
    ]);
    qm.state.connected = true;
    const { ctx, calls } = makeRunCtx(queuedUnknownReply());

    const res = await panelRun().handler({ to_node_id: 9 }, ctx);
    const text = textOf(res);

    expect(calls).toHaveLength(1);
    expect(res.isError).toBeFalsy();
    expect(text).toContain("[UNCERTAIN]");
    expect(text).toContain("Do NOT re-run panel_run");
    expect(text).toContain(LEFT_THE_PANEL);
  });

  it("unread logs + unobserved queue do not claim the request left the panel", async () => {
    __panelRunTestHooks.setGotPromptLinesProbe(async () => null);
    const { ctx, calls } = makeRunCtx(queuedUnknownReply());

    const res = await panelRun().handler({}, ctx);
    const text = textOf(res);

    expect(calls).toHaveLength(1);
    expect(res.isError).toBeFalsy();
    expect(text).toContain("[UNCERTAIN]");
    expect(text).not.toContain(LEFT_THE_PANEL);
    expect(text.toLowerCase()).not.toContain(MAY_HAVE_BEEN_ACCEPTED);
    expect(text).toContain(__panelRunTestHooks.PANEL_QUEUED_UNKNOWN_UNOBSERVED_RETRY_GUIDANCE);
    expect(text).not.toContain(UNFIXED_QUEUE_LIST);
  });

  it("partial queued_unknown with known ids is still ticketed, not fail-closed", async () => {
    __panelRunTestHooks.setGotPromptLinesProbe(async () => []);
    qm.state.connected = true;
    const { ctx, calls } = makeRunCtx(
      queuedUnknownReply({
        queued: true,
        complete: false,
        partially_queued: true,
        queued_prompt_ids: ["p-known-2521"],
      }),
    );

    const res = await panelRun().handler({ batch_count: 2, to_node_id: 9 }, ctx);
    const text = textOf(res);

    expect(calls).toHaveLength(1);
    expect(res.isError).toBeFalsy();
    expect(RunCompletions.ticketFor("p-known-2521")).toBeDefined();
    expect(text).toContain("p-known-2521");
    expect(text).toContain("[UNCERTAIN]");
  });

  it("the not-queued fail string itself never claims a /prompt left the panel", () => {
    const msg = __panelRunTestHooks.panelQueueNotQueuedMessage({
      kind: "not-queued",
      gotPrompt: false,
      queueIdle: true,
      queueObserved: true,
    });
    expect(msg.toLowerCase()).toContain("did not queue");
    expect(msg.toLowerCase()).toContain("nothing was queued");
    expect(msg).toContain("got prompt");
    expect(msg.toLowerCase()).toContain("you may retry");
    expect(msg).toContain("enqueue_workflow");
    expect(msg).not.toContain(LEFT_THE_PANEL);
    expect(msg.toLowerCase()).not.toContain(MAY_HAVE_BEEN_ACCEPTED);
    expect(msg).not.toContain(UNFIXED_QUEUE_LIST);
    expect(msg).not.toContain("Do NOT re-run panel_run");
  });
});
