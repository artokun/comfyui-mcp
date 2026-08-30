// #977 — the completion notification could only speak one way.
//
// Every finished render injected "Reply with ONE short sentence … you do NOT
// need to call any tools", which reads as "stop now". Paired with panel_run's
// own "just end your turn now and wait", the emergent default was
// queue → end turn → render → one sentence → end turn — so a user running a
// five-variant sweep had to send a message to advance every single step.
//
// That directly contradicted the orchestrator's own system prompt, which tells
// the agent to treat a todo list as a loop and not stop between steps. The
// per-event text won because it is the most recent and most specific thing in
// context.
//
// The agent's checklist was the machine-readable signal all along — it had
// already declared the plan — but panel_set_todo was a pure pass-through to the
// panel UI and the orchestrator retained nothing.

import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetTodoState,
  canonicalTodoEntries,
  planInFlight,
  recordTodo,
  runCompletionDirective,
  todoFor,
  todoListsMatch,
} from "../../orchestrator/todo-state.js";

const item = (text: string, status: string) => ({ text, status });

beforeEach(() => __resetTodoState());

describe("#977: a declared plan is remembered", () => {
  it("counts the unfinished entries", () => {
    recordTodo("t1", [
      item("variant A", "completed"),
      item("variant B", "pending"),
      item("variant C", "pending"),
    ]);
    expect(todoFor("t1")?.pending).toBe(2);
    expect(planInFlight("t1")).toBe(true);
  });

  it("treats the plan as finished once every entry is settled", () => {
    recordTodo("t1", [item("a", "completed"), item("b", "done")]);
    expect(planInFlight("t1")).toBe(false);
  });

  it("accepts the statuses a plan actually uses", () => {
    for (const s of ["pending", "in_progress", "in-progress", "todo", "active"]) {
      __resetTodoState();
      recordTodo("t1", [item("x", s)]);
      expect(planInFlight("t1"), s).toBe(true);
    }
  });

  it("keeps tabs separate — one tab's sweep is not another's", () => {
    recordTodo("t1", [item("a", "pending")]);
    recordTodo("t2", [item("a", "completed")]);
    expect(planInFlight("t1")).toBe(true);
    expect(planInFlight("t2")).toBe(false);
  });

  it("replaces the snapshot rather than accumulating", () => {
    recordTodo("t1", [item("a", "pending"), item("b", "pending")]);
    recordTodo("t1", [item("a", "completed"), item("b", "completed")]);
    expect(planInFlight("t1")).toBe(false);
  });
});

describe("#977: in-flight requires POSITIVE evidence", () => {
  // The suppression changes an instruction the agent obeys, so it must never
  // fire on absence. Every one of these is "we do not know of a plan", and the
  // ordinary acknowledge-and-stop wording has to remain the default.
  it("is false with no checklist at all", () => {
    expect(planInFlight("never-set")).toBe(false);
    expect(planInFlight(undefined)).toBe(false);
  });

  it("is false for an empty checklist", () => {
    recordTodo("t1", []);
    expect(planInFlight("t1")).toBe(false);
  });

  // An unrecognised status cannot manufacture an in-flight plan — otherwise a
  // future panel status string would silently suppress the yield nudge forever.
  it("is false for statuses it does not recognise", () => {
    recordTodo("t1", [item("a", "blocked"), item("b", ""), { text: "c" }]);
    expect(planInFlight("t1")).toBe(false);
  });

  // A malformed payload tells us nothing; keeping the previous snapshot would
  // leave it claiming work remains long after the plan ended.
  it("FORGETS on a malformed payload rather than keeping a stale plan", () => {
    recordTodo("t1", [item("a", "pending")]);
    expect(planInFlight("t1")).toBe(true);
    recordTodo("t1", "not-an-array");
    expect(planInFlight("t1")).toBe(false);
    expect(todoFor("t1")).toBeUndefined();
  });

  it("ignores a missing tab id instead of recording under one", () => {
    recordTodo(undefined, [item("a", "pending")]);
    expect(planInFlight(undefined)).toBe(false);
  });
});

describe("#977: retention is bounded", () => {
  it("does not grow without limit across synthetic tab ids", () => {
    for (let i = 0; i < 200; i++) recordTodo(`tab-${i}`, [item("a", "pending")]);
    // The newest is kept; the oldest have been evicted.
    expect(planInFlight("tab-199")).toBe(true);
    expect(planInFlight("tab-0")).toBe(false);
  });
});

// #977 — the WIRING. The rules above are about the snapshot; these are about the
// two places that must actually use it: panel_set_todo recording what the agent
// declared, and the completion notice reading it.
describe("#977: panel_set_todo records what the agent declared", () => {
  it("retains the checklist it forwards to the panel", async () => {
    const { buildPanelToolDefs, makePanelToolCtx } = await import(
      "../../orchestrator/panel-tools.js"
    );
    const def = buildPanelToolDefs().find((d) => d.name === "panel_set_todo");
    expect(def).toBeDefined();
    const bridge = { push: () => 1, canReach: () => true } as never;
    const ctx = makePanelToolCtx(bridge, "tab-sweep");
    (ctx as { call: unknown }).call = async () => ({ content: [{ type: "text", text: "ok" }] });

    await def!.handler(
      {
        items: [
          { text: "variant A", status: "completed" },
          { text: "variant B", status: "pending" },
        ],
      },
      ctx,
    );

    // The panel keeps the UI copy; this is the orchestrator's own record, which
    // is what the completion notice consults.
    expect(planInFlight("tab-sweep")).toBe(true);
    expect(todoFor("tab-sweep")?.pending).toBe(1);
  });
});

// The other half of the wiring: the completion notice must actually READ the
// snapshot. Extracted as a named function precisely because, inline in
// PanelAgent.injectEvent, a mutation that ignored the plan entirely — the exact
// regression this fixes — broke no test at all.
describe("#977: the completion directive follows the plan", () => {
  it("keeps acknowledge-and-stop when there is no plan", () => {
    const d = runCompletionDirective("t1");
    expect(d).toMatch(/you do NOT need to call any tools/);
    expect(d).not.toMatch(/CONTINUE your plan/);
  });

  it("tells the agent to CONTINUE when entries remain", () => {
    recordTodo("t1", [item("A", "completed"), item("B", "pending")]);
    const d = runCompletionDirective("t1");
    expect(d).toMatch(/CONTINUE your plan/);
    expect(d).toMatch(/do NOT stop here or wait for the user/);
    // The instruction that caused the yield must be gone, not merely softened.
    expect(d).not.toMatch(/you do NOT need to call any tools/);
  });

  it("returns to acknowledge-and-stop once the plan finishes", () => {
    recordTodo("t1", [item("A", "pending")]);
    expect(runCompletionDirective("t1")).toMatch(/CONTINUE your plan/);
    recordTodo("t1", [item("A", "completed")]);
    expect(runCompletionDirective("t1")).toMatch(/you do NOT need to call any tools/);
  });

  // Both wordings still ask for the one-sentence acknowledgement — the user is
  // watching the panel and a silent continuation would read as a hang.
  it("always asks for the short acknowledgement", () => {
    recordTodo("t1", [item("A", "pending")]);
    expect(runCompletionDirective("t1")).toMatch(/ONE short sentence/);
    __resetTodoState();
    expect(runCompletionDirective("t1")).toMatch(/ONE short sentence/);
  });
});

// #2369 — replayed completions break loops by conditioning the instruction.
// A re-delivered completion has no plan context to continue — it is an ancient
// message journaled after an MCP reconnect. Replayed completions that include
// "CONTINUE your plan" turn a single late handoff into an unbounded loop:
// each replay becomes a new user turn, the agent replies, and the next replay
// cycles it again. Replayed completions always get acknowledge-and-stop, even
// if a plan remains in flight.
describe("#2369: replayed completions omit the CONTINUE instruction", () => {
  it("omits CONTINUE for replayed even when a plan is in flight", () => {
    recordTodo("t1", [item("A", "pending"), item("B", "pending")]);
    const nreplayed = runCompletionDirective("t1");
    const replayed = runCompletionDirective("t1", { replayed: true });
    // Normal completion tells the agent to CONTINUE when a plan remains.
    expect(nreplayed).toMatch(/CONTINUE your plan/);
    // Replayed completion NEVER gets CONTINUE, even with the same plan.
    expect(replayed).not.toMatch(/CONTINUE your plan/);
  });

  it("uses acknowledge-and-stop for replayed when plan is in flight", () => {
    recordTodo("t1", [item("A", "pending")]);
    const replayed = runCompletionDirective("t1", { replayed: true });
    expect(replayed).toMatch(/you do NOT need to call any tools/);
  });

  it("still asks for the one-sentence acknowledgement when replayed", () => {
    recordTodo("t1", [item("A", "pending")]);
    const replayed = runCompletionDirective("t1", { replayed: true });
    expect(replayed).toMatch(/ONE short sentence/);
  });

  it("uses the same wording for replayed as for no plan at all", () => {
    recordTodo("t1", [item("A", "pending")]);
    const replayed = runCompletionDirective("t1", { replayed: true });
    __resetTodoState();
    const noPlan = runCompletionDirective("t1");
    expect(replayed).toBe(noPlan);
  });
});

describe("#2481: a delivered checklist can be compared to a later tray read", () => {
  it("treats a missing status as pending, matching the schema default", () => {
    expect(todoListsMatch([{ text: "a" }], [{ text: "a", status: "pending" }])).toBe(true);
    expect(canonicalTodoEntries([{ text: "a" }])).toEqual([{ text: "a", status: "pending" }]);
  });

  it("folds content/text and status aliases before comparing", () => {
    expect(
      todoListsMatch(
        [{ text: "a", status: "in_progress" }],
        [{ content: "a", status: "active" }],
      ),
    ).toBe(true);
  });

  it("does not treat a different list as a match", () => {
    expect(todoListsMatch([{ text: "a" }], [{ text: "b" }])).toBe(false);
    expect(todoListsMatch([{ text: "a" }], [{ text: "a" }, { text: "b" }])).toBe(false);
    expect(todoListsMatch([{ text: "a", status: "done" }], [{ text: "a", status: "active" }])).toBe(
      false,
    );
  });

  it("accepts two empty lists as the same cleared tray", () => {
    expect(todoListsMatch([], [])).toBe(true);
  });

  it("refuses a payload that is not a checklist", () => {
    expect(canonicalTodoEntries("nope")).toBeNull();
    expect(canonicalTodoEntries([{ status: "pending" }])).toBeNull();
    expect(todoListsMatch([{ text: "a" }], { items: [{ text: "a" }] })).toBe(false);
  });
});
