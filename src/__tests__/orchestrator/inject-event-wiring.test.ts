// The call sites three fixes could not reach.
//
// #889 (run-error attribution), #977 (continue-the-plan), and the run-error
// notice each landed with their DECISION mutation-verified and their CALL SITE
// not: everything inside PanelAgent.injectEvent / injectRunError is only
// reachable through a live backend, so replacing the composed call with a
// hardcoded string broke no test. Each time the honest move was to extract a
// named function and SAY that one call remained unverified.
//
// makeCaptureBackend removes that wall: the backend contract is small, and
// consuming its "channel in" shows the exact text an injected event puts in
// front of the agent — which is what those fixes are about. These tests drive
// the REAL PanelAgent, so a regression in the wiring fails here rather than
// shipping.

import { beforeEach, describe, expect, it } from "vitest";
import { PanelAgent } from "../../orchestrator/panel-agent.js";
import { makeCaptureBackend } from "./helpers/capture-backend.js";
import { __resetTodoState, recordTodo } from "../../orchestrator/todo-state.js";
import { QueueMonitor } from "../../services/queue-monitor.js";

type QMPriv = { selfQueuedIds: Set<string>; lastSelfQueueTs: number | null };
const qm = QueueMonitor as unknown as QMPriv;

function startAgent(tabId: string) {
  const backend = makeCaptureBackend();
  const agent = new PanelAgent(
    tabId,
    { mcpServers: {}, systemAppend: "", model: "m" } as never,
    backend,
  );
  void agent.start();
  return { agent, backend };
}

beforeEach(() => {
  __resetTodoState();
  qm.selfQueuedIds.clear();
  qm.lastSelfQueueTs = null;
});

describe("#977: the completion event carries the plan-aware directive", () => {
  it("tells the agent to CONTINUE when its checklist has unfinished items", async () => {
    recordTodo("tab-sweep", [
      { text: "variant A", status: "completed" },
      { text: "variant B", status: "pending" },
    ]);
    const { agent, backend } = startAgent("tab-sweep");
    await agent.injectEvent({ kind: "executed", images: [{ filename: "a.png" }] } as never);

    const [turn] = await backend.waitForTurns(1);
    expect(turn.text).toMatch(/CONTINUE your plan/);
    expect(turn.text).toMatch(/do NOT stop here or wait for the user/);
    // The instruction that caused the yield is gone from the delivered text.
    expect(turn.text).not.toMatch(/you do NOT need to call any tools/);
    await agent.stop?.();
  });

  // The default must be untouched: a single render with no declared plan still
  // acknowledges and stops.
  it("keeps acknowledge-and-stop when no plan was declared", async () => {
    const { agent, backend } = startAgent("tab-single");
    await agent.injectEvent({ kind: "executed", images: [{ filename: "a.png" }] } as never);

    const [turn] = await backend.waitForTurns(1);
    expect(turn.text).toMatch(/you do NOT need to call any tools/);
    expect(turn.text).not.toMatch(/CONTINUE your plan/);
    await agent.stop?.();
  });
});

// #2369 — replayed completions omit CONTINUE to break loops.
// A re-delivered completion has no plan context to continue — it is journaled
// after an MCP reconnect. Replayed completions that include "CONTINUE your plan"
// turn a single late handoff into an unbounded loop: each replay becomes a new
// user turn, the agent replies, and the next replay cycles it again. Replayed
// completions always get acknowledge-and-stop, even if a plan remains in flight.
describe("#2369: replayed completions omit the CONTINUE instruction", () => {
  it("omits CONTINUE for replayed even when a plan is in flight", async () => {
    recordTodo("tab-replay-plan", [
      { text: "variant A", status: "completed" },
      { text: "variant B", status: "pending" },
    ]);
    const { agent, backend } = startAgent("tab-replay-plan");
    // A fresh completion gets CONTINUE when a plan is in flight.
    await agent.injectEvent({ kind: "executed", images: [{ filename: "a.png" }] } as never);
    const [freshTurn] = await backend.waitForTurns(1);
    expect(freshTurn.text).toMatch(/CONTINUE your plan/);
    await agent.stop?.();
    // Now inject the same completion as replayed. It must NOT get CONTINUE.
    recordTodo("tab-replay-plan", [
      { text: "variant A", status: "completed" },
      { text: "variant B", status: "pending" },
    ]);
    const { agent: agent2, backend: backend2 } = startAgent("tab-replay-plan");
    await agent2.injectEvent(
      { kind: "executed", images: [{ filename: "a.png" }], replayed: true } as never,
    );

    const [replayTurn] = await backend2.waitForTurns(1);
    // Replayed must NOT get CONTINUE, even with the same plan.
    expect(replayTurn.text).not.toMatch(/CONTINUE your plan/);
    expect(replayTurn.text).toMatch(/you do NOT need to call any tools/);
    await agent2.stop?.();
  });

  it("uses acknowledge-and-stop for replayed when plan is in flight", async () => {
    recordTodo("tab-replay-ack", [{ text: "step 1", status: "pending" }]);
    const { agent, backend } = startAgent("tab-replay-ack");
    await agent.injectEvent(
      { kind: "executed", images: [{ filename: "a.png" }], replayed: true } as never,
    );

    const [turn] = await backend.waitForTurns(1);
    expect(turn.text).toMatch(/you do NOT need to call any tools/);
    expect(turn.text).toMatch(/ONE short sentence/);
    await agent.stop?.();
  });
});

describe("#889: the run-error notice carries the real attribution", () => {
  const ERR = "Render status for prompt 9d70fd9d-1c2b-4e3f-8a01-7c6d5e4f3a2b could not be confirmed";

  // The reported session: reads and graph edits only, never a panel_run. It was
  // told "the workflow run YOU JUST QUEUED errored" and spent a round trip on a
  // failure it did not cause.
  it("says the agent did NOT queue it when this session has queued nothing", async () => {
    const { agent, backend } = startAgent("tab-err");
    await agent.injectRunError(ERR);

    const [turn] = await backend.waitForTurns(1);
    expect(turn.text).toMatch(/You did NOT queue this run/);
    expect(turn.text).not.toMatch(/you just queued/);
    await agent.stop?.();
  });

  it("keeps the urgent wording for a run the agent provably queued", async () => {
    QueueMonitor.markSelfQueued("9d70fd9d-1c2b-4e3f-8a01-7c6d5e4f3a2b");
    const { agent, backend } = startAgent("tab-err-own");
    await agent.injectRunError(ERR);

    const [turn] = await backend.waitForTurns(1);
    expect(turn.text).toMatch(/run you queued ERRORED/);
    expect(turn.text).toMatch(/STOP/);
    await agent.stop?.();
  });
});
