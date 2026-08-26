// panel#1728 — a normal Panel queued_unknown reply can arrive before the
// scoped /prompt request has exposed its prompt id. The MCP consumer must use
// the existing bounded queue receipt path, then open the ordinary journal ticket.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  __panelToolsTestHooks,
  type PanelToolCtx,
} from "../../orchestrator/panel-tools.js";
import { RunCompletions } from "../../orchestrator/run-completion-journal.js";
import { QueueMonitor } from "../../services/queue-monitor.js";

type QueueMonitorPrivate = {
  selfQueuedIds: Set<string>;
  lastSelfQueueTs: number | null;
  state: {
    connected: boolean;
    runningPromptId: string | null;
    pendingPromptIds: string[];
    queueRemaining: number;
    lastServerAliveTs: number | null;
    lastFrameTs: number | null;
  };
};

const qm = QueueMonitor as unknown as QueueMonitorPrivate;

function panelRun() {
  const def = buildPanelToolDefs().find((candidate) => candidate.name === "panel_run");
  if (!def) throw new Error("panel_run tool not found");
  return def;
}

function textOf(res: { content?: Array<{ type: string; text?: string }> }): string {
  return res.content?.find((content) => content.type === "text")?.text ?? "";
}

beforeEach(() => {
  __panelToolsTestHooks.setRunLateAckGraceMs(450);
  RunCompletions.reset();
  qm.selfQueuedIds.clear();
  qm.lastSelfQueueTs = null;
  qm.state.connected = true;
  qm.state.runningPromptId = null;
  qm.state.pendingPromptIds = [];
  qm.state.queueRemaining = 0;
  qm.state.lastServerAliveTs = Date.now();
  qm.state.lastFrameTs = Date.now();
});

afterEach(() => {
  __panelToolsTestHooks.setRunLateAckGraceMs(null);
  RunCompletions.reset();
  qm.selfQueuedIds.clear();
  qm.lastSelfQueueTs = null;
  qm.state.runningPromptId = null;
  qm.state.pendingPromptIds = [];
  qm.state.queueRemaining = 0;
});

describe("panel_run late prompt reconciliation (#1728)", () => {
  it("turns an id-less queued_unknown receipt into one ticket without redispatch", async () => {
    let calls = 0;
    let receiptTaken = false;
    const completionKey = JSON.stringify(["panel-1728", "orchestrator::claude", "prompt-1728", "generation-a"]);
    const bridge = {
      send: async () => ({}),
      canReach: () => true,
      peekLateRunReceipt: (runRid: string) =>
        runRid === "run-rid-1728"
          ? {
              runRid,
              tabId: "panel-1728",
              promptIds: ["prompt-1728"],
              completionKeys: [{ promptId: "prompt-1728", completionKey }],
              lateByMs: 25,
            }
          : undefined,
      takeLateRunReceipt: (runRid: string) => {
        if (runRid !== "run-rid-1728" || receiptTaken) return undefined;
        receiptTaken = true;
        return {
          runRid,
          tabId: "panel-1728",
          promptIds: ["prompt-1728"],
          completionKeys: [{ promptId: "prompt-1728", completionKey }],
          lateByMs: 25,
        };
      },
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "panel-1728");
    ctx.call = async (_cmd, _timeout, observeRid) => {
      calls++;
      observeRid?.("run-rid-1728");
      // This is the late watchdog observation: the Panel has already answered
      // queued_unknown, but a new prompt is now visible after this dispatch.
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              queued_unknown: true,
              indeterminate_count: 1,
              inFlight: 1,
              error: "scoped dispatch budget expired before prompt_id arrived",
            }),
          },
        ],
      };
    };

    const res = await panelRun().handler({ to_node_id: 38 }, ctx);
    const text = textOf(res);

    expect(calls).toBe(1);
    expect(res.isError).toBeFalsy();
    expect(text).toMatch(/"prompt_id"\s*:\s*"prompt-1728"/);
    expect(text).toContain("[RECOVERED]");
    expect(text).toContain("completion ticket");
    expect(RunCompletions.ticketFor("prompt-1728")).toMatchObject({
      promptId: "prompt-1728",
      completionKey,
    });
    expect(receiptTaken).toBe(true);

    // The real journal path now correlates the later bridge executed frame to
    // the ticket, and its pending coalescer keeps duplicate frames to one entry.
    const ticket = RunCompletions.ticketFor("prompt-1728");
    const first = RunCompletions.record(
      "panel-1728",
      { kind: "executed", prompt_id: "prompt-1728", images: [{ filename: "out.png" }] },
      ticket?.conversation === undefined ? undefined : { conversation: ticket.conversation },
    );
    const second = RunCompletions.record(
      "panel-1728",
      { kind: "executed", prompt_id: "prompt-1728", images: [{ filename: "out.png" }] },
      ticket?.conversation === undefined ? undefined : { conversation: ticket.conversation },
    );
    expect(first.correlation.status).toBe("matched");
    expect(second.correlation.status).toBe("matched");
    const frames: unknown[] = [];
    RunCompletions.deliverPending("panel-1728", (payload) => {
      frames.push(payload);
      return true;
    });
    expect(frames).toHaveLength(1);
  });

  it("does not infer a full-graph queued_unknown result from a queue observation", async () => {
    const bridge = {
      send: async () => ({}),
      canReach: () => true,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "panel-1728-full");
    ctx.call = async () => {
      qm.state.runningPromptId = "prompt-full-foreign";
      qm.state.queueRemaining = 1;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ queued_unknown: true, indeterminate_count: 1 }),
          },
        ],
      };
    };

    const res = await panelRun().handler({}, ctx);

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("no completion ticket can be opened");
    expect(RunCompletions.ticketFor("prompt-full-foreign")).toBeUndefined();
  });

  it("does not reopen a normal-reply ticket when its exact receipt arrives later", async () => {
    let handoff: ((receipt: { runRid: string; tabId: string; promptIds: string[] }) => void) | null = null;
    let receipt: { runRid: string; tabId: string; promptIds: string[] } | undefined;
    const bridge = {
      send: async () => ({}),
      canReach: () => true,
      peekLateRunReceipt: (runRid: string) =>
        receipt && receipt.runRid === runRid ? { ...receipt, lateByMs: 250 } : undefined,
      takeLateRunReceipt: (runRid: string) => {
        if (!receipt || receipt.runRid !== runRid) return undefined;
        const taken = { ...receipt, lateByMs: 250 };
        receipt = undefined;
        return taken;
      },
      registerLateRunReceiptHandoff: (_rid: string, _tabId: string, onReceipt: typeof handoff) => {
        handoff = onReceipt;
        return () => {
          handoff = null;
        };
      },
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "panel-normal-late-1728");
    ctx.call = async (_cmd, _timeout, observeRid) => {
      observeRid?.("run-rid-normal-late-1728");
      return {
        content: [
          { type: "text", text: JSON.stringify({ queued: true, prompt_id: "prompt-normal-late-1728" }) },
        ],
      };
    };

    await panelRun().handler({ to_node_id: 38 }, ctx);
    const ticketBeforeReceipt = RunCompletions.ticketFor("prompt-normal-late-1728");
    expect(ticketBeforeReceipt?.reused).toBeUndefined();
    const seqBeforeReceipt = ticketBeforeReceipt?.seq;

    receipt = {
      runRid: "run-rid-normal-late-1728",
      tabId: "panel-normal-late-1728",
      promptIds: ["prompt-normal-late-1728"],
    };
    handoff?.(receipt);

    const ticketAfterReceipt = RunCompletions.ticketFor("prompt-normal-late-1728");
    expect(ticketAfterReceipt?.seq).toBe(seqBeforeReceipt);
    expect(ticketAfterReceipt?.reused).toBeUndefined();
    RunCompletions.record(
      "panel-normal-late-1728",
      { kind: "executed", prompt_id: "prompt-normal-late-1728" },
      undefined,
    );
    RunCompletions.record(
      "panel-normal-late-1728",
      { kind: "executed", prompt_id: "prompt-normal-late-1728" },
      undefined,
    );
    const frames: unknown[] = [];
    RunCompletions.deliverPending("panel-normal-late-1728", (payload) => {
      frames.push(payload);
      return true;
    });
    expect(frames).toHaveLength(1);
  });

  it("does not reopen a QueueMonitor fallback ticket when its exact receipt arrives later", async () => {
    let handoff: ((receipt: { runRid: string; tabId: string; promptIds: string[] }) => void) | null = null;
    let receipt: { runRid: string; tabId: string; promptIds: string[] } | undefined;
    const bridge = {
      send: async () => ({}),
      canReach: () => true,
      peekLateRunReceipt: (runRid: string) =>
        receipt && receipt.runRid === runRid ? { ...receipt, lateByMs: 250 } : undefined,
      takeLateRunReceipt: (runRid: string) => {
        if (!receipt || receipt.runRid !== runRid) return undefined;
        const taken = { ...receipt, lateByMs: 250 };
        receipt = undefined;
        return taken;
      },
      registerLateRunReceiptHandoff: (_rid: string, _tabId: string, onReceipt: typeof handoff) => {
        handoff = onReceipt;
        return () => {
          handoff = null;
        };
      },
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "panel-queue-fallback-1728");
    ctx.call = async (_cmd, _timeout, observeRid) => {
      observeRid?.("run-rid-queue-fallback-1728");
      qm.state.runningPromptId = "prompt-queue-fallback-1728";
      return {
        content: [
          { type: "text", text: JSON.stringify({ queued_unknown: true, indeterminate_count: 1, inFlight: 1 }) },
        ],
      };
    };

    await panelRun().handler({ to_node_id: 38 }, ctx);
    const ticketBeforeReceipt = RunCompletions.ticketFor("prompt-queue-fallback-1728");
    expect(ticketBeforeReceipt?.reused).toBeUndefined();
    const seqBeforeReceipt = ticketBeforeReceipt?.seq;

    receipt = {
      runRid: "run-rid-queue-fallback-1728",
      tabId: "panel-queue-fallback-1728",
      promptIds: ["prompt-queue-fallback-1728"],
    };
    handoff?.(receipt);

    const ticketAfterReceipt = RunCompletions.ticketFor("prompt-queue-fallback-1728");
    expect(ticketAfterReceipt?.seq).toBe(seqBeforeReceipt);
    expect(ticketAfterReceipt?.reused).toBeUndefined();
    RunCompletions.record(
      "panel-queue-fallback-1728",
      { kind: "executed", prompt_id: "prompt-queue-fallback-1728" },
      undefined,
    );
    RunCompletions.record(
      "panel-queue-fallback-1728",
      { kind: "executed", prompt_id: "prompt-queue-fallback-1728" },
      undefined,
    );
    const frames: unknown[] = [];
    RunCompletions.deliverPending("panel-queue-fallback-1728", (payload) => {
      frames.push(payload);
      return true;
    });
    expect(frames).toHaveLength(1);
  });

  it("waits for the complete exact batch before falling back to the first queue prompt", async () => {
    let calls = 0;
    let receiptReads = 0;
    let receiptTaken = false;
    const allPromptIds = ["batch-prompt-1", "batch-prompt-2", "batch-prompt-3"];
    const bridge = {
      send: async () => ({}),
      canReach: () => true,
      peekLateRunReceipt: (runRid: string) => {
        if (runRid !== "run-rid-batch-1728") return undefined;
        receiptReads += 1;
        // QueueMonitor sees the first prompt before the exact receipt frames
        // finish arriving. The reconcile must keep the weaker observation as a
        // candidate while merging the later exact batch, rather than returning
        // the first id and stranding the rest in the bridge TTL map.
        const promptIds =
          receiptReads < 2
            ? []
            : receiptReads < 3
              ? allPromptIds.slice(0, 1)
              : allPromptIds;
        return { runRid, tabId: "panel-batch-1728", promptIds, lateByMs: 30 };
      },
      takeLateRunReceipt: (runRid: string) => {
        if (runRid !== "run-rid-batch-1728" || receiptTaken) return undefined;
        receiptTaken = true;
        return { runRid, tabId: "panel-batch-1728", promptIds: allPromptIds, lateByMs: 30 };
      },
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "panel-batch-1728");
    ctx.call = async (_cmd, _timeout, observeRid) => {
      calls += 1;
      observeRid?.("run-rid-batch-1728");
      qm.state.runningPromptId = allPromptIds[0];
      qm.state.queueRemaining = 2;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              queued_unknown: true,
              indeterminate_count: 3,
              inFlight: 3,
            }),
          },
        ],
      };
    };

    const res = await panelRun().handler({ batch_count: 3, to_node_id: 38 }, ctx);

    expect(calls).toBe(1);
    expect(receiptReads).toBeGreaterThanOrEqual(3);
    expect(receiptTaken).toBe(true);
    expect(textOf(res)).toContain('"prompt_ids"');
    expect(textOf(res)).toContain("exact captured prompt");
    for (const promptId of allPromptIds) {
      expect(RunCompletions.ticketFor(promptId)?.promptId).toBe(promptId);
      const ticket = RunCompletions.ticketFor(promptId);
      RunCompletions.record("panel-batch-1728", { kind: "executed", prompt_id: promptId }, undefined);
      RunCompletions.record("panel-batch-1728", { kind: "executed", prompt_id: promptId }, undefined);
      expect(ticket).toBeDefined();
    }
    const frames: unknown[] = [];
    RunCompletions.deliverPending("panel-batch-1728", (payload) => {
      frames.push(payload);
      return true;
    });
    expect(frames).toHaveLength(3);
  });

  it("opens the exact ticket when a receipt arrives after the reconcile grace", async () => {
    __panelToolsTestHooks.setRunLateAckGraceMs(25);
    let calls = 0;
    let handoff: ((receipt: { runRid: string; tabId: string; promptIds: string[] }) => void) | null = null;
    let receipt: { runRid: string; tabId: string; promptIds: string[] } | undefined;
    const bridge = {
      send: async () => ({}),
      canReach: () => true,
      peekLateRunReceipt: (runRid: string) =>
        receipt && receipt.runRid === runRid ? { ...receipt, lateByMs: 100 } : undefined,
      takeLateRunReceipt: (runRid: string) => {
        if (!receipt || receipt.runRid !== runRid) return undefined;
        const taken = { ...receipt, lateByMs: 100 };
        receipt = undefined;
        return taken;
      },
      registerLateRunReceiptHandoff: (_rid: string, _tabId: string, onReceipt: typeof handoff) => {
        handoff = onReceipt;
        return () => {
          handoff = null;
        };
      },
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "panel-late-1728");
    ctx.call = async (_cmd, _timeout, observeRid) => {
      calls += 1;
      observeRid?.("run-rid-late-1728");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ queued_unknown: true, indeterminate_count: 1, inFlight: 1 }),
          },
        ],
      };
    };

    const res = await panelRun().handler({ to_node_id: 38 }, ctx);
    expect(calls).toBe(1);
    expect(RunCompletions.ticketFor("prompt-after-grace")).toBeUndefined();
    receipt = { runRid: "run-rid-late-1728", tabId: "panel-late-1728", promptIds: ["prompt-after-grace"] };
    handoff?.(receipt);

    const ticket = RunCompletions.ticketFor("prompt-after-grace");
    expect(ticket?.promptId).toBe("prompt-after-grace");
    RunCompletions.record("panel-late-1728", { kind: "executed", prompt_id: "prompt-after-grace" }, undefined);
    RunCompletions.record("panel-late-1728", { kind: "executed", prompt_id: "prompt-after-grace" }, undefined);
    const frames: unknown[] = [];
    RunCompletions.deliverPending("panel-late-1728", (payload) => {
      frames.push(payload);
      return true;
    });
    expect(frames).toHaveLength(1);
    expect(res.isError).toBeFalsy();
  });

  it("registers a timeout handoff before returning so a beyond-grace receipt still tickets", async () => {
    __panelToolsTestHooks.setRunLateAckGraceMs(25);
    let handoff: ((receipt: { runRid: string; tabId: string; promptIds: string[] }) => void) | null = null;
    let receipt: { runRid: string; tabId: string; promptIds: string[] } | undefined;
    const bridge = {
      send: async () => ({}),
      canReach: () => true,
      peekLateRunReceipt: (runRid: string) =>
        receipt && receipt.runRid === runRid ? { ...receipt, lateByMs: 250 } : undefined,
      takeLateRunReceipt: (runRid: string) => {
        if (!receipt || receipt.runRid !== runRid) return undefined;
        const taken = { ...receipt, lateByMs: 250 };
        receipt = undefined;
        return taken;
      },
      registerLateRunReceiptHandoff: (_rid: string, _tabId: string, onReceipt: typeof handoff) => {
        handoff = onReceipt;
        return () => {
          handoff = null;
        };
      },
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "panel-timeout-1728");
    ctx.call = async (_cmd, _timeout, observeRid) => {
      observeRid?.("run-rid-timeout-1728");
      const result = {
        isError: true,
        content: [
          {
            type: "text",
            text: "Error: Panel tab panel-timeout-1728 did not reply to \"graph_run\" within 20 ms",
          },
        ],
      };
      return __panelToolsTestHooks.markRunReplyTimeout(result);
    };

    const res = await panelRun().handler({ to_node_id: 38 }, ctx);
    expect(res.isError).toBe(true);
    expect(handoff).toBeTypeOf("function", "the timeout must install the bounded late owner before returning");
    expect(RunCompletions.ticketFor("prompt-after-timeout-1728")).toBeUndefined();

    receipt = {
      runRid: "run-rid-timeout-1728",
      tabId: "panel-timeout-1728",
      promptIds: ["prompt-after-timeout-1728"],
    };
    handoff?.(receipt);

    expect(RunCompletions.ticketFor("prompt-after-timeout-1728")?.promptId).toBe(
      "prompt-after-timeout-1728",
    );
    RunCompletions.record(
      "panel-timeout-1728",
      { kind: "executed", prompt_id: "prompt-after-timeout-1728" },
      undefined,
    );
    RunCompletions.record(
      "panel-timeout-1728",
      { kind: "executed", prompt_id: "prompt-after-timeout-1728" },
      undefined,
    );
    const frames: unknown[] = [];
    RunCompletions.deliverPending("panel-timeout-1728", (payload) => {
      frames.push(payload);
      return true;
    });
    expect(frames).toHaveLength(1);
  });

  it("registers a transport handoff when ctx.call throws before returning", async () => {
    let handoff: ((receipt: { runRid: string; tabId: string; promptIds: string[] }) => void) | null = null;
    let receipt: { runRid: string; tabId: string; promptIds: string[] } | undefined;
    const bridge = {
      send: async () => ({}),
      canReach: () => true,
      peekLateRunReceipt: (runRid: string) =>
        receipt && receipt.runRid === runRid ? { ...receipt, lateByMs: 250 } : undefined,
      takeLateRunReceipt: (runRid: string) => {
        if (!receipt || receipt.runRid !== runRid) return undefined;
        const taken = { ...receipt, lateByMs: 250 };
        receipt = undefined;
        return taken;
      },
      registerLateRunReceiptHandoff: (_rid: string, _tabId: string, onReceipt: typeof handoff) => {
        handoff = onReceipt;
        return () => {
          handoff = null;
        };
      },
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "panel-disconnect-1728");
    ctx.call = async (_cmd, _timeout, observeRid) => {
      observeRid?.("run-rid-disconnect-1728");
      throw new Error("bridge socket closed after dispatch");
    };

    const res = await panelRun().handler({ to_node_id: 38 }, ctx);
    expect(res.isError).toBe(true);
    expect(handoff).toBeTypeOf("function");

    receipt = {
      runRid: "run-rid-disconnect-1728",
      tabId: "panel-disconnect-1728",
      promptIds: ["prompt-after-disconnect-1728"],
    };
    handoff?.(receipt);
    expect(RunCompletions.ticketFor("prompt-after-disconnect-1728")?.promptId).toBe(
      "prompt-after-disconnect-1728",
    );
    RunCompletions.record(
      "panel-disconnect-1728",
      { kind: "executed", prompt_id: "prompt-after-disconnect-1728" },
      undefined,
    );
    RunCompletions.record(
      "panel-disconnect-1728",
      { kind: "executed", prompt_id: "prompt-after-disconnect-1728" },
      undefined,
    );
    const frames: unknown[] = [];
    RunCompletions.deliverPending("panel-disconnect-1728", (payload) => {
      frames.push(payload);
      return true;
    });
    expect(frames).toHaveLength(1);
  });
});
