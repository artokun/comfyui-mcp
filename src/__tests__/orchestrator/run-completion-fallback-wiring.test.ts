// #1789 — the two things a unit test of the watchdog cannot see.
//
// 1. THE CALL SITE. createRunCompletionWatchdog can be perfect and never run.
//    The watchdog only exists if the orchestrator TEES QueueMonitor's drained
//    completions into observe() and TICKS it — both inline in the
//    startPanelOrchestrator closure, which needs a live bridge, agents and a
//    socket to construct. Same treatment as the other index.ts boundary
//    wirings (carried-stamp-wiring, agent-identity-wiring,
//    shared-session-invariant): pinned at source.
//
//    The tee is load-bearing in a way a "does observe() appear anywhere" check
//    would miss: drainCompletions() SPLICES, so calling it a second time for
//    the watchdog would race the broadcaster and each consumer would see only
//    part of the burst. The assertion is therefore about the SHAPE — one drain,
//    both consumers.
//
// 2. THE PROMISE. panel_run's rider is what told the reporting agent to stop
//    looking. It is driven here through the real tool handler, so the fallback
//    sentence cannot be quietly dropped while the tests stay green.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildPanelToolDefs, makePanelToolCtx, type PanelToolCtx } from "../../orchestrator/panel-tools.js";
import { QueueMonitor } from "../../services/queue-monitor.js";
import { RunCompletions } from "../../orchestrator/run-completion-journal.js";
import { registerQueueManagementTools } from "../../tools/queue-management.js";

const indexSrc = (): string =>
  readFileSync(new URL("../../orchestrator/index.ts", import.meta.url), "utf8");

/**
 * The BODY of a function, brace-matched from its opening `{`.
 *
 * A fixed-size `slice(at, at + N)` window is not scope: it reads past the
 * closing brace, so a guard that MOVED out of the function still satisfies a
 * `toContain` against the window. Match the braces instead.
 */
const functionBody = (src: string, signature: string): string => {
  const at = src.indexOf(signature);
  if (at < 0) throw new Error(`orchestrator source no longer contains ${signature}`);
  const open = src.indexOf("{", at);
  if (open < 0) throw new Error(`no body found for ${signature}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced body for ${signature}`);
};

describe("#1789 — the history fallback is WIRED into the orchestrator, not merely available", () => {
  it("SOURCE: completion fences remain reclaimable until the real turn ack", () => {
    const src = indexSrc();
    expect(src).toContain("onAccepted: (identity) => completionFenceTokens.set(token, identity)");
    expect(src).not.toContain("replay: payload.replayed === true");
    const ackAt = src.indexOf("function ackEventToken(");
    expect(ackAt).toBeGreaterThan(-1);
    const ackBlock = src.slice(ackAt, ackAt + 1500);
    expect(ackBlock).toContain("completionFence.markDelivered(identity)");
    expect(ackBlock).toContain("RunCompletions.ack(token)");
    expect(ackBlock).toContain("completionFence.release(identity)");
  });

  // #2341 — THE CALL SITE, not the helper.
  //
  // scheduleRunCompletion() can be a perfect idempotency gate and never run.
  // flushRunCompletions is the ONE place a journaled panel_run completion turns
  // into an agent turn, so if its deliverPending callback stops routing through
  // the gate, the recovered-completion replay storm comes straight back while
  // every unit test of the gate stays green — the helper is still correct, just
  // unreachable. Bypassing the gate here left 4257/4258 tests passing before
  // this pin existed.
  it("SOURCE: #2341 — flushRunCompletions schedules through the durable fence, never straight into injectEvent", () => {
    const body = functionBody(indexSrc(), "function flushRunCompletions(");
    // The journal's delivery callback hands every offer to the one gate…
    expect(body).toContain("scheduleRunCompletion({");
    // …against the DURABLE process-wide fence, not a fresh per-call one that
    // would forget the completion across the reconnect it exists to survive.
    expect(body).toContain("fence: completionFence,");
    // …and the injection is reachable ONLY as that gate's `inject` option, so an
    // edit cannot route around the fence while leaving the call in place.
    const gateAt = body.indexOf("scheduleRunCompletion({");
    const injectAt = body.indexOf("manager.injectEvent(");
    expect(injectAt).toBeGreaterThan(gateAt);
    expect(body.slice(gateAt, injectAt)).toContain("inject: () =>");
  });

  it("SOURCE: the orchestrator constructs the watchdog against the real journal", () => {
    const src = indexSrc();
    expect(src).toContain("createRunCompletionWatchdog({");
    const start = src.indexOf("createRunCompletionWatchdog({");
    const block = src.slice(start, start + 1800);
    // It asks the journal whether the run is still owed a completion…
    expect(block).toContain("RunCompletions.awaitingCompletion(");
    // …and delivers through the SAME arrival path the panel's frame uses, so the
    // completion is correlated, journaled and replayable rather than pushed raw.
    expect(block).toContain("RunCompletions.record(");
    expect(block).toContain("flushRunCompletions(");
    // #1853 — outputs come from the shipped /history parse, not a status-only
    // pointer. A second path that invented filenames would be the over-claim.
    expect(block).toContain("resolveOutputs:");
    expect(block).toContain("resolveHistoryCompletionImages(");
    // #1556 — reconnect looks the still-owed ids up in /history, not only in
    // the QueueMonitor drain that may have already missed them.
    expect(block).toContain("lookupStatus:");
    expect(block).toContain("resolveHistoryCompletionStatus(");
  });

  it("SOURCE: QueueMonitor's completions are TEED to the watchdog from the broadcaster's single drain", () => {
    const src = indexSrc();
    // Exactly one drain call site — a second one would race the broadcaster.
    const drains = src.match(/QueueMonitor\.drainCompletions\(\)/g) ?? [];
    expect(drains).toHaveLength(1);
    const start = src.indexOf("createQueueStatusBroadcaster(");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 900);
    expect(block).toContain("QueueMonitor.drainCompletions()");
    expect(block).toContain(".observe(completions)");
  });

  it("SOURCE: the watchdog is ticked on the poll timer, AFTER the drain that feeds it", () => {
    const src = indexSrc();
    const start = src.indexOf("const queueStatusTimer = setInterval(");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 700);
    expect(block).toContain("wd.tick()");
    // Ordering matters: the broadcaster tick is what arms the watchdog, so
    // expiring first would delay every arm by a whole poll interval.
    expect(block.indexOf("queueStatusBroadcaster.tick()")).toBeLessThan(
      block.indexOf("wd.tick()"),
    );
  });

  it("SOURCE: a panel hello reconciles owed panel_run ids against ComfyUI history immediately", () => {
    const src = indexSrc();
    const helloAt = src.indexOf('if (event.type === "hello" && event.tab_id)');
    expect(helloAt).toBeGreaterThan(-1);
    // The hello handler is large; pin the reconcile next to the queue_status
    // seed that already runs on connect, not some unrelated later hello.
    const seedAt = src.indexOf("buildQueueStatusFrame(QueueMonitor.snapshot())", helloAt);
    expect(seedAt).toBeGreaterThan(helloAt);
    const block = src.slice(seedAt, seedAt + 900);
    expect(block).toContain("runCompletionWatchdog?.reconcile(");
    expect(block).toContain("RunCompletions.owedCompletions()");
  });
});

// ---------------------------------------------------------------------------

type QMPriv = {
  url: string | null;
  stopped: boolean;
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
const qm = QueueMonitor as unknown as QMPriv;

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} not found`);
  return def;
}

function makeCtx(runReply: Record<string, unknown>): PanelToolCtx {
  const bridge = {
    send: async () => ({}),
    push: () => 1,
    canReach: () => true,
  } as unknown as PanelToolCtx["bridge"];
  const ctx = makePanelToolCtx(bridge, "test-tab");
  (ctx as { call: PanelToolCtx["call"] }).call = async () => ({
    content: [{ type: "text", text: JSON.stringify(runReply) }],
  });
  return ctx;
}

function firstText(res: { content?: Array<{ type: string; text?: string }> }): string {
  return res.content?.find((c) => c.type === "text")?.text ?? "";
}

beforeEach(() => {
  RunCompletions.reset();
  qm.url = "http://127.0.0.1:9999";
  qm.stopped = false;
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
  RunCompletions.reset();
  qm.selfQueuedIds.clear();
  qm.lastSelfQueueTs = null;
  qm.stopped = true;
  qm.url = null;
});

/**
 * Drive the REAL `queue` tool with the call the rider just told the agent to
 * make, and report whether the tool ACCEPTED it.
 *
 * This is the assertion the first cut of #1789 was missing, and the gate caught
 * it: the batch branch printed `queue (action:"status")` with no id, which
 * queue-management.ts's `requirePromptId` REFUSES — so an agent obeying the
 * fallback got an error instead of a status, the reported bug's own shape one
 * level in. A test that only string-matched the rider pinned the broken form.
 *
 * The parse is deliberately narrow (exact literal shapes the rider emits) and
 * THROWS on anything it does not recognise, so a reworded remedy fails loudly
 * here instead of silently going unchecked.
 *
 * `isError` is the only thing read: a reachability failure is a different fact
 * from a validation refusal, and the local `queue` handler answers both shapes
 * without a live ComfyUI (verified: `list` and `status`+id return JSON, bare
 * `status` returns isError "requires `prompt_id`").
 */
async function queueCallIsAccepted(call: string): Promise<boolean> {
  let captured: ((a: Record<string, unknown>) => Promise<{ isError?: boolean }>) | null = null;
  registerQueueManagementTools({
    tool: (name: string, _d: unknown, _s: unknown, h: (a: Record<string, unknown>) => Promise<{ isError?: boolean }>) => {
      if (name === "queue") captured = h;
    },
  } as never);
  if (!captured) throw new Error("the queue tool was not registered");
  const withId = call.match(/^queue \(action:"([a-z_]+)", prompt_id:"([^"]+)"\)$/);
  const bare = call.match(/^queue \(action:"([a-z_]+)"\)$/);
  const args = withId
    ? { action: withId[1], prompt_id: withId[2] }
    : bare
      ? { action: bare[1] }
      : null;
  if (!args) throw new Error(`the rider's remedy is in an unrecognised shape: ${call}`);
  const res = await (captured as (a: Record<string, unknown>) => Promise<{ isError?: boolean }>)(args);
  return res.isError !== true;
}

/** The single remedy the rider's [FALLBACK] line tells the agent to run. */
function fallbackCallIn(text: string): string {
  const m = text.match(/make ONE check with (queue \(action:"[a-z_]+"(?:, prompt_id:"[^"]+")?\))/);
  if (!m) throw new Error(`no [FALLBACK] remedy found in the rider:\n${text}`);
  return m[1];
}

describe("#1789 — panel_run's rider stops promising more than the code can keep", () => {
  it("keeps the anti-poll instruction AND names one bounded fallback with the prompt id", async () => {
    const res = await defByName("panel_run").handler({}, makeCtx({ queued: true, prompt_id: "p-1789" }));
    const text = firstText(res);

    // The anti-poll instruction stays PRIMARY — that is what keeps an agent from
    // burning a turn a second on a two-minute render.
    expect(text).toContain("do NOT poll queue");
    expect(text).toContain("Just end your turn now and wait");

    // …but it no longer forbids ever looking. The escape hatch is stated, bounded,
    // and actionable in ONE call: the prompt id is right there.
    expect(text).toContain("[FALLBACK]");
    expect(text).toContain("it cannot be GUARANTEED");
    expect(text).toContain('queue (action:"status", prompt_id:"p-1789")');
    expect(text).toContain("One check, not a loop");
  });

  it("omits a prompt id it cannot name (a batch queued several)", async () => {
    const res = await defByName("panel_run").handler(
      {},
      makeCtx({ queued: true, prompt_id: "p-a", prompt_ids: ["p-a", "p-b"] }),
    );
    const text = firstText(res);
    expect(text).toContain("[FALLBACK]");
    // No invented single id when the run queued more than one — and the remedy
    // is the action that takes none, not a status call with the id left off.
    expect(text).toContain('queue (action:"list")');
    expect(text).not.toContain('prompt_id:"p-a"');
    expect(text).not.toContain('queue (action:"status")');
  });

  // THE POINT OF THE WHOLE FALLBACK: the call it names has to RUN. Both branches,
  // executed against the real tool rather than string-matched.
  it("SINGLE run — the remedy the rider prints is ACCEPTED by the queue tool", async () => {
    const text = firstText(
      await defByName("panel_run").handler({}, makeCtx({ queued: true, prompt_id: "p-1789" })),
    );
    const call = fallbackCallIn(text);
    expect(call).toBe('queue (action:"status", prompt_id:"p-1789")');
    expect(await queueCallIsAccepted(call)).toBe(true);
  });

  it("BATCH — the remedy the rider prints is ACCEPTED by the queue tool", async () => {
    const text = firstText(
      await defByName("panel_run").handler(
        {},
        makeCtx({ queued: true, prompt_id: "p-a", prompt_ids: ["p-a", "p-b"] }),
      ),
    );
    const call = fallbackCallIn(text);
    expect(call).toBe('queue (action:"list")');
    expect(await queueCallIsAccepted(call)).toBe(true);
  });

  // The guard's own guard: prove queueCallIsAccepted can SAY NO, or the two
  // assertions above are a rubber stamp. This is the exact call the first cut
  // shipped.
  it("…and that acceptance check is not vacuous — the shipped-broken form is REFUSED", async () => {
    expect(await queueCallIsAccepted('queue (action:"status")')).toBe(false);
  });

  it("the UNCORRELATABLE branch is unchanged — it never told the agent to idle", async () => {
    const res = await defByName("panel_run").handler({}, makeCtx({ queued: true }));
    const text = firstText(res);
    expect(text).toContain("NO prompt id");
    expect(text).toContain("Do NOT simply idle and wait indefinitely");
    expect(text).not.toContain("[FALLBACK]");
  });
});
