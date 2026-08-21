// #1639 — while a ComfyUI prompt is running, a graph_* MUTATION can time out with
// "tab may be backgrounded or frozen" and an unknown outcome. The orchestrator CAN
// see the running prompt via QueueMonitor (HTTP /queue, independent of the panel
// tab), so it fails a write closed BEFORE dispatch and the agent gets an explicit
// QUEUE BUSY instead of a 20/30s unknown-outcome timeout. `graph_run` is excluded:
// queuing behind an in-flight job is the documented sweep path.
//
// panel#1489 — that fence was applied to READS too, and this file used to pin
// exactly that (`expect(sent).toEqual([])` for panel_query_graph and
// panel_graph_outline). It should not have: a read that fails carries no unknown
// outcome, so refusing it unsent bought no safety and cost the agent its only way
// to LOOK at the graph mid-render.
//
// The property under test is therefore the SPLIT: `targeted` graph commands are
// refused unsent, `inert` ones are dispatched, and a dispatched read that does
// time out still comes back named QUEUE BUSY rather than "backgrounded or frozen".
// The classification is read from GRAPH_CMD_EFFECT, not from a second list.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  panelToolForGraphCmd,
  QUEUE_BUSY_READ_TOOLS,
  RETRY_TOKEN_CMD_BY_TOOL,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { GRAPH_CMD_EFFECT } from "../../services/ui-bridge.js";
import { QueueMonitor } from "../../services/queue-monitor.js";
import {
  markDispatched,
  markMidCommandDisconnect,
  markReplyTimeout,
} from "../../services/ui-bridge.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "11111111-2222-4333-8444-555555555555";

type QMPriv = {
  url: string | null;
  stopped: boolean;
  selfQueuedIds: Set<string>;
  lastSelfQueueTs: number | null;
  state: {
    connected: boolean;
    runningPromptId: string | null;
    pendingPromptIds: string[];
    currentNode: string | null;
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

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

function makeBridge(opts?: { timeoutCmds?: Set<string> }) {
  const sent: string[] = [];
  const timeoutCmds = opts?.timeoutCmds ?? new Set<string>();
  const bridge = {
    send: async (cmd: Record<string, unknown>, o?: { onDispatchedRid?: (rid: string) => void }) => {
      sent.push(String(cmd.cmd));
      o?.onDispatchedRid?.("rid-timeout-1");
      if (timeoutCmds.has(String(cmd.cmd))) {
        throw markReplyTimeout(
          new Error(
            `Panel tab ${TAB} did not reply to "${cmd.cmd}" within 20000 ms — the ComfyUI tab ` +
              `may be backgrounded or frozen`,
          ),
        );
      }
      return { ok: true, ids: [1], node_count: 1 };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: () => true,
    workflowUuidFor: () => ({ known: true, uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  return { bridge, sent };
}

/** Put a foreign prompt in flight, exactly as the reporter's repro does. */
function startRender(promptId = "p-in-flight", node: string | null = null): void {
  qm.state.runningPromptId = promptId;
  qm.state.currentNode = node;
  qm.state.queueRemaining = 1;
}

beforeEach(() => {
  qm.url = "http://127.0.0.1:9999";
  qm.stopped = false;
  qm.selfQueuedIds.clear();
  qm.lastSelfQueueTs = null;
  qm.state.connected = true;
  qm.state.runningPromptId = null;
  qm.state.pendingPromptIds = [];
  qm.state.currentNode = null;
  qm.state.queueRemaining = 0;
  qm.state.lastServerAliveTs = Date.now();
  qm.state.lastFrameTs = Date.now();
});

afterEach(() => {
  qm.selfQueuedIds.clear();
  qm.lastSelfQueueTs = null;
  qm.state.runningPromptId = null;
  qm.state.currentNode = null;
  qm.state.queueRemaining = 0;
  qm.stopped = true;
  qm.url = null;
});

describe("read-only graph inspection is allowed while a prompt runs (panel#1489)", () => {
  it("panel_graph_outline IS dispatched mid-render and returns the graph", async () => {
    startRender();

    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_graph_outline").handler({} as never, ctx);

    // The reported failure: rejected before dispatch, so the agent never saw the graph.
    expect(sent).toEqual(["graph_outline"]);
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).not.toMatch(/QUEUE BUSY/);
    expect(textOf(res)).not.toMatch(/was NOT sent/);
  });

  it("panel_query_graph IS dispatched mid-render", async () => {
    startRender();

    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_query_graph").handler(
      { ids: [1], fields: "ids" } as never,
      ctx,
    );

    expect(sent).toEqual(["graph_query"]);
    expect(res.isError).not.toBe(true);
  });

  it("panel_get_errors IS dispatched mid-render — the recurrence report's second command", async () => {
    startRender();

    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_get_errors").handler({} as never, ctx);

    // Diagnosing a stalled render is the moment this read matters most, and it was
    // refused for being spelled graph_*.
    expect(sent).toEqual(["graph_get_errors"]);
    expect(res.isError).not.toBe(true);
  });

  it("an inert non-read (a selection change) is dispatched too — the gate keys on EFFECT", async () => {
    startRender();

    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    // graph_select_nodes is GRAPH_CMD_EFFECT "inert" but is NOT in
    // BRIDGE_READONLY_CMDS — so this fails if the split is ever re-derived from
    // the re-dispatch-safety list instead of the effect ledger (#778's defect).
    const res = await defByName("panel_select_nodes").handler({ node_ids: [1] } as never, ctx);

    expect(sent).toEqual(["graph_select_nodes"]);
    expect(res.isError).not.toBe(true);
  });
});

describe("graph MUTATIONS still fail fast while a prompt is running (#1639)", () => {
  it("panel_set_widget is NOT delivered — outcome is known (nothing applied)", async () => {
    startRender();

    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_set_widget").handler(
      { node_id: 3, widget: "text", value: "a cat" } as never,
      ctx,
    );
    const text = textOf(res);

    expect(sent).toEqual([]);
    expect(res.isError).toBe(true);
    expect(text).toMatch(/QUEUE BUSY/);
    expect(text).toMatch(/was NOT sent — nothing was applied/);
    expect(text).toMatch(/running prompt p-in-flight/);
    // #1933 — it must name the TOOL the caller called, not the bridge command
    // that tool dispatches. The reporter quoted the old wording back verbatim:
    // "graph_set_widget was NOT sent", naming something they never called.
    expect(text).toMatch(/panel_set_widget was NOT sent/);
    expect(text).toMatch(/panel_set_widget MUTATES the workflow/);
    expect(text).not.toMatch(/(?<![a-z_])graph_set_widget(?![a-z_])/);
    // A mutation that never left must not invite retry_of / unknown-outcome.
    expect(text).not.toMatch(/may have been applied/);
    expect(text).not.toMatch(/retry_of/);
  });

  it("the refusal names the reads that ARE available instead of sending the agent to poll", async () => {
    startRender("p-in-flight", "42");

    const { bridge } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_set_widget").handler(
      { node_id: 3, widget: "text", value: "a cat" } as never,
      ctx,
    );
    const text = textOf(res);

    expect(text).toMatch(/currently at node 42/);
    expect(text).toMatch(/NOT fenced/);
    // #1933 — the reads are named by their REGISTERED tool names. The previous
    // assertion was `toMatch(/graph_outline/)`, which `panel_graph_outline` and
    // the wrong bare `graph_outline` both satisfy — so it stayed green for the
    // whole life of the defect. Anchored on both sides, it cannot.
    expect(text).toMatch(/panel_graph_outline \/ panel_query_graph \/ panel_get_errors/);
    expect(text).not.toMatch(/\(graph_outline/);
    // The old text told every caller reads were unavailable too. Nothing may say so.
    expect(text).not.toMatch(/including read-only/);
  });

  // #1933 — the load-bearing property, and the one no assertion held before:
  // every tool name this refusal utters must be a tool the caller can actually
  // call. A recovery instruction naming a non-tool is worse than none — the
  // agent following it gets "unknown tool" during an already-degraded state.
  it("every tool name in the refusal is a REGISTERED tool", async () => {
    startRender();

    const { bridge } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_set_widget").handler(
      { node_id: 3, widget: "text", value: "a cat" } as never,
      ctx,
    );

    const registered = new Set(buildPanelToolDefs().map((d) => d.name));
    // Read from the MESSAGE, not from the constant — a test that re-reads the
    // list the code built the string from would pass on a string built from a
    // different list.
    const mentioned = textOf(res).match(/panel_[a-z0-9_]+/g) ?? [];
    expect(mentioned.length).toBeGreaterThan(0);
    for (const name of new Set(mentioned)) expect([name, registered.has(name)]).toEqual([name, true]);

    // And the inverse: no bare bridge command survives anywhere in the text.
    // `graph_` never appears except as the tail of a `panel_graph_*` tool name.
    expect(textOf(res)).not.toMatch(/(?<![a-z_])graph_[a-z_]+/);
  });

  it("the three advertised reads are registered AND are the ones the fence lets past", () => {
    const registered = new Set(buildPanelToolDefs().map((d) => d.name));
    for (const name of QUEUE_BUSY_READ_TOOLS) {
      expect([name, registered.has(name)]).toEqual([name, true]);
    }
    // The claim "are NOT fenced" has to be true of the commands behind them, or
    // the message is accurate about names and wrong about behaviour.
    for (const cmd of ["graph_outline", "graph_query", "graph_get_errors"]) {
      expect([cmd, GRAPH_CMD_EFFECT[cmd]]).toEqual([cmd, "inert"]);
    }
  });

  // #1933 — the reverse index must resolve every command this fence can refuse,
  // or a real refusal silently falls back to the anonymous subject.
  //
  // Enumerating from GRAPH_CMD_EFFECT is complete, not merely convenient: the
  // ledger FAILS CLOSED, so an unlisted graph_* command is fenced too and would
  // be invisible here — except that graph-command-effect.test.ts holds the
  // COMPLETENESS half, scanning every "graph_..." literal in the orchestrator
  // sources and requiring an entry. That test is what makes this enumeration
  // exhaustive; without it this assertion would be narrower than it reads.
  it("every command the fence can refuse resolves to a tool, except ambiguous graph_load", () => {
    const refusable = Object.entries(GRAPH_CMD_EFFECT)
      .filter(([cmd, effect]) => cmd.startsWith("graph_") && cmd !== "graph_run" && effect === "targeted")
      .map(([cmd]) => cmd);
    expect(refusable.length).toBeGreaterThan(20);

    const unresolved = refusable.filter((cmd) => panelToolForGraphCmd(cmd) === undefined);
    // graph_load is dispatched by TWO tools (panel_load_workflow and
    // panel_flatten_workflow), so the index declines to pick one. That is the
    // designed behaviour, not a coverage hole — pinned here so a future
    // "cleanup" that makes it guess fails.
    expect(unresolved).toEqual(["graph_load"]);
    expect(
      Object.entries(RETRY_TOKEN_CMD_BY_TOOL).filter(([, cmd]) => cmd === "graph_load").length,
    ).toBe(2);

    // And a resolved one resolves to the RIGHT tool, not merely to some tool.
    expect(panelToolForGraphCmd("graph_set_widget")).toBe("panel_set_widget");
    expect(panelToolForGraphCmd("graph_auto_layout")).toBe("panel_auto_layout");
  });

  it("an ambiguous command falls back to a subject that names no tool", async () => {
    startRender();

    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    // Dispatch graph_load through ctx.call directly: both tools that reach it
    // read the live canvas first, so this is the only way to exercise the
    // fallback branch at the point the fence actually runs.
    const res = await ctx.call({ cmd: "graph_load", workflow: { nodes: [], links: [] } });
    const text = textOf(res);

    expect(sent).toEqual([]);
    expect(res.isError).toBe(true);
    expect(text).toMatch(/QUEUE BUSY/);
    expect(text).toMatch(/This edit was NOT sent — nothing was applied/);
    // It must not invent a tool: naming one of two possible callers would be a
    // confidently wrong answer, which is the defect class, not a smaller one.
    expect(text).not.toMatch(/panel_load_workflow/);
    expect(text).not.toMatch(/panel_flatten_workflow/);
    expect(text).not.toMatch(/(?<![a-z_])graph_load(?![a-z_])/);
  });

  it("a targeted command that is not a node edit is fenced as well", async () => {
    startRender();

    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    // graph_auto_layout moves every node; "targeted" in the ledger, and absent from
    // the MUTATING_GRAPH_EDIT_CMDS allowlist used by the reconnect gate.
    const res = await defByName("panel_auto_layout").handler({} as never, ctx);

    expect(sent).toEqual([]);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/QUEUE BUSY/);
  });

  it("idle queue: the same mutation is dispatched", async () => {
    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_set_widget").handler(
      { node_id: 3, widget: "text", value: "a cat" } as never,
      ctx,
    );

    expect(sent).toEqual(["graph_set_widget"]);
    expect(res.isError).not.toBe(true);
  });

  it("graph_run is still dispatched — queuing behind an in-flight job is the sweep path", async () => {
    qm.state.runningPromptId = "p-own";
    qm.state.queueRemaining = 1;
    QueueMonitor.markSelfQueued("p-own");

    const { bridge, sent } = makeBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    // panel_run's own duplicate fence would refuse an unaccounted job; mark it ours.
    const res = await defByName("panel_run").handler({ allow_duplicate: true } as never, ctx);

    expect(sent).toContain("graph_run");
    expect(textOf(res)).not.toMatch(/was NOT sent/);
  });
});

/**
 * #1933 — the whole fence-reachable surface, driven end to end.
 *
 * grok review (#1937 r1) found two tools wrongly excused below as unreachable:
 * `panel_edit_node` (only the EMPTY edit is rejected) and `panel_clear` (reaches
 * `graph_clear` once confirm says yes). Both excuses were statements about the
 * CALL this file happened to make, not about what production can reach — and an
 * undriven fenced tool is exactly where a wrong unique pairing goes unnoticed,
 * the same shape as the `toMatch(/graph_outline/)` assertion that let #1933 ship.
 * Both are driven now, and both mutations against them are asserted to bite.
 *
 * The reverse index is built by inverting RETRY_TOKEN_CMD_BY_TOOL, a map
 * maintained for a DIFFERENT question (#694: which tools mint a retry token).
 * `panel-retry-identity.test.ts` (f) already proves every KEY of that map is a
 * registered tool, so the index can never emit a name that does not exist. What
 * nothing proved is the PAIRING — that the tool on the left is the tool a caller
 * reaches the command on the right through. A forward entry that is simply wrong
 * about that would leave the retry machinery working (it only ever asks whether a
 * tool mints a token) while this message names a real but WRONG tool, which is
 * strictly worse than the bug being fixed, because the name is plausible.
 *
 * #778 is the standing record of what reading one list for another question
 * costs, so this does not argue the pairing from the map. It CALLS all 34 with
 * a prompt in flight and reads the tool name back out of the refusal the tool
 * itself produced. The pairings are not uniform — `panel_set_property` dispatches
 * `graph_set_node_property`, `panel_set_node_title` dispatches `graph_set_title`
 * — so a prefix rule would pass a review and fail here.
 */
const FENCED_TOOL_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  panel_add_node: { type: "KSampler" },
  // grok review (#1937 r1): reachable with any ONE editable field —
  // validatePanelEditNodeArgs rejects only the EMPTY edit, so {node_id, title}
  // sails through to ctx.call({ cmd: "graph_edit_node" }).
  panel_edit_node: { node_id: 3, title: "t" },
  // grok review (#1937 r1): reachable once confirm answers yes; the handler then
  // does ctx.call({ cmd: "graph_clear" }). See CONFIRM_YES below.
  panel_clear: {},
  panel_remove_node: { node_id: 3 },
  panel_connect: { from_node: 1, from_slot: 0, to_node: 2, to_slot: 0 },
  panel_disconnect: { node_id: 2, input: 0 },
  panel_configure_app_mode: { inputs: [] },
  panel_set_widget: { node_id: 3, widget: "text", value: "x" },
  panel_remove_widget: { node_id: 3, widget: "text" },
  panel_set_property: { node_id: 3, property: "p", value: 1 },
  panel_move_node: { node_id: 3, x: 1, y: 2 },
  panel_resize_node: { node_id: 3, width: 100, height: 100 },
  panel_auto_layout: {},
  panel_create_subgraph: { node_ids: [1, 2] },
  panel_subgraph_group: { group_id: 0 },
  panel_paste_nodes: {},
  panel_save_subgraph: { node_id: 3, name: "s" },
  panel_add_subgraph: { name: "s" },
  panel_create_group: { title: "g", node_ids: [1] },
  panel_move_group: { group_id: 0, x: 1, y: 1 },
  panel_edit_group: { group_id: 0, title: "g2" },
  panel_remove_group: { group_id: 0 },
  panel_set_node_title: { node_id: 3, title: "t" },
  panel_set_node_collapsed: { node_id: 3, collapsed: true },
  panel_set_node_mode: { node_id: 3, mode: "mute" },
  panel_set_node_color: { node_id: 3, color: "red" },
  panel_move_rail: { node_id: 3, slot: 0, direction: "up" },
  panel_promote_widget: { node_id: 3, widget: "text" },
  panel_expose_subgraph_output: { node_id: 3, name: "o" },
  panel_expose_subgraph_input: { node_id: 3, name: "i" },
  panel_unexpose_subgraph_output: { node_id: 3, name: "o" },
  panel_unexpose_subgraph_input: { node_id: 3, name: "i" },
  panel_unpack_subgraph: { node_id: 3 },
  panel_update_node: { node_id: 3 },
};

/**
 * Tools in the retry map that this probe deliberately does not drive, each for a
 * stated reason. Pinned as a SET so a tool silently dropping out of coverage —
 * by gaining a required argument, say — turns into a failure here rather than
 * quietly shrinking what is checked.
 */
const NOT_DRIVEN: Readonly<Record<string, string>> = {
  // Never fenced: GRAPH_CMD_EFFECT "inert" (selection / scope / clipboard). The
  // map admits them for the retry question only (#694), not this one.
  panel_select_nodes: "inert — the fence lets it past",
  panel_copy_nodes: "inert — the fence lets it past",
  panel_enter_subgraph: "inert — the fence lets it past",
  panel_exit_subgraph: "inert — the fence lets it past",
  // Both dispatch graph_load, which the index refuses to resolve; and both read
  // the live canvas before dispatching, so neither reaches the fence with a
  // constructible argument here. Covered by the ambiguity test above instead.
  panel_load_workflow: "graph_load — ambiguous, covered separately",
  panel_flatten_workflow: "graph_load — ambiguous, covered separately",
  // workflow_* commands, not graph_* — outside this fence entirely.
  panel_save_workflow: "workflow_save is not a graph_ command",
  panel_rename_workflow: "workflow_rename is not a graph_ command",
  panel_close_workflow: "workflow_close is not a graph_ command",
  // Deliberately exempt: queuing behind an in-flight job is the sweep path.
  panel_run: "graph_run is excluded from the fence by design",
};

/**
 * Tools whose handler gates dispatch behind a confirm card. The harness answers
 * YES so the call reaches the fence — without it `panel_clear` returns
 * "Cancelled" and produces no refusal to read a name out of, which is exactly
 * how it came to be mis-excused as unreachable.
 */
const CONFIRM_YES: ReadonlySet<string> = new Set(["panel_clear"]);

describe("the refusal names the CALLING tool, across the whole fenced surface (#1933)", () => {
  it("every tool in the retry map is either driven here or explicitly excused", () => {
    const uncovered = Object.keys(RETRY_TOKEN_CMD_BY_TOOL).filter(
      (t) => !(t in FENCED_TOOL_ARGS) && !(t in NOT_DRIVEN),
    );
    expect(uncovered).toEqual([]);
    // And the excuses cannot rot into cover for a tool that no longer exists.
    const registered = new Set(buildPanelToolDefs().map((d) => d.name));
    for (const name of Object.keys(NOT_DRIVEN)) {
      expect([name, registered.has(name)]).toEqual([name, true]);
    }
  });

  it("names ITSELF, not the bridge command, for all of them", async () => {
    const mismatches: string[] = [];
    let checked = 0;

    for (const [tool, args] of Object.entries(FENCED_TOOL_ARGS)) {
      startRender();
      const { bridge, sent } = makeBridge();
      const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
      if (CONFIRM_YES.has(tool)) ctx.confirm = async () => "yes";
      const text = textOf(await defByName(tool).handler(args as never, ctx));

      if (!/QUEUE BUSY/.test(text)) {
        // Not "skip": a tool listed here is expected to reach the fence, so
        // falling short of it is a coverage regression, not a pass.
        mismatches.push(`${tool}: never reached the fence — ${text.slice(0, 120)}`);
        continue;
      }
      // Nothing may have been dispatched, or "was NOT sent" is a false claim.
      expect([tool, sent]).toEqual([tool, []]);

      const named = text.match(/(?:Error:\s*)?(\S+) was NOT sent/)?.[1];
      if (named !== tool) mismatches.push(`${tool}: refusal named ${String(named)}`);
      checked += 1;
    }

    expect(mismatches).toEqual([]);
    // A guard against the whole loop silently becoming a no-op.
    expect(checked).toBe(Object.keys(FENCED_TOOL_ARGS).length);
    expect(checked).toBeGreaterThan(33);
  });
});

describe("a graph_* timeout while a prompt is running is named QUEUE BUSY (#1639)", () => {
  it("a READ that times out mid-render still names the running prompt", async () => {
    startRender();

    const { bridge, sent } = makeBridge({ timeoutCmds: new Set(["graph_outline"]) });
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_graph_outline").handler({} as never, ctx);
    const text = textOf(res);

    // This is the half of #1639 that survives: the read is attempted, and when the
    // tab genuinely cannot answer, the diagnosis is still explicit rather than a
    // bare "backgrounded or frozen".
    expect(sent).toContain("graph_outline");
    expect(res.isError).toBe(true);
    expect(text).toMatch(/did not reply to "graph_outline"/);
    expect(text).toMatch(/QUEUE BUSY/);
    expect(text).toMatch(/running prompt p-in-flight/);
    expect(text).toMatch(/running: 0/);
  });

  it("that diagnosis does not over-claim: a backgrounded tab is ruled out only once idle", async () => {
    startRender();

    const { bridge } = makeBridge({ timeoutCmds: new Set(["graph_outline"]) });
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const text = textOf(await defByName("panel_graph_outline").handler({} as never, ctx));

    // Reads reach this path now, and a read that goes unanswered mid-render is
    // genuinely ambiguous — the render is the LIKELY cause, not a proven one. The
    // note used to flatly assert "this is not a backgrounded or frozen tab", which
    // is a claim the orchestrator cannot make about a tab that just went silent.
    expect(text).toMatch(/most likely reason/);
    expect(text).not.toMatch(/this is not a backgrounded or frozen tab/i);
    expect(text).toMatch(/if it still does not answer once the queue is idle/i);
  });

  it("graph_run's missing ack names the running prompt instead of a frozen tab", async () => {
    startRender();
    QueueMonitor.markSelfQueued("p-in-flight");

    const { bridge, sent } = makeBridge({ timeoutCmds: new Set(["graph_run"]) });
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_run").handler({ allow_duplicate: true } as never, ctx);
    const text = textOf(res);

    expect(sent).toContain("graph_run");
    expect(res.isError).toBe(true);
    expect(text).toMatch(/did not reply to "graph_run"/);
    expect(text).toMatch(/QUEUE BUSY/);
    expect(text).toMatch(/running prompt p-in-flight/);
  });

  it("an idle queue does not append QUEUE BUSY onto a genuine timeout", async () => {
    const { bridge } = makeBridge({ timeoutCmds: new Set(["graph_run"]) });
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_run").handler({} as never, ctx);
    const text = textOf(res);

    expect(res.isError).toBe(true);
    expect(text).toMatch(/did not reply to "graph_run"/);
    expect(text).not.toMatch(/QUEUE BUSY/);
  });
});

describe("panel_run treats a post-queue disconnect as queued when the prompt is new (panel#1524)", () => {
  function makeDisconnectBridge(afterDispatch?: () => void) {
    const sent: string[] = [];
    const bridge = {
      send: async (cmd: Record<string, unknown>, o?: { onDispatchedRid?: (rid: string) => void }) => {
        sent.push(String(cmd.cmd));
        o?.onDispatchedRid?.("rid-disco-1");
        afterDispatch?.();
        throw markMidCommandDisconnect(
          markDispatched(
            new Error(
              `panel tab ${TAB.slice(0, 8)} disconnected mid-command ("${cmd.cmd}") — OUTCOME UNKNOWN: ` +
                `the command was already sent, so the panel may have applied it (for a run, ComfyUI may already be rendering).`,
            ),
            true,
          ),
        );
      },
      push: () => 1,
      canReach: () => true,
      isHeadless: () => false,
      tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => TAB,
      refreshWorkflowUuid: () => true,
      workflowUuidFor: () => ({ known: true, uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      tabCanMutateGraph: () => true,
      tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    } as unknown as PanelToolCtx["bridge"];
    return { bridge, sent };
  }

  it("a NEW running prompt after graph_run disconnects is returned as queued:true", async () => {
    const { bridge, sent } = makeDisconnectBridge(() => {
      qm.state.runningPromptId = "p-poyo-queued";
      qm.state.queueRemaining = 1;
    });
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_run").handler({ to_node_id: 3 } as never, ctx);
    const text = textOf(res);

    expect(sent).toEqual(["graph_run"]);
    expect(res.isError, `expected queued success, got: ${text}`).toBeFalsy();
    expect(text).toContain("p-poyo-queued");
    expect(text).toContain("[RECOVERED]");
    expect(text).toMatch(/queued:true|"queued":\s*true/);
    expect(text).toContain("notified automatically");
    expect(text).toMatch(/Do NOT re-run/i);
  });

  it("the SAME prompt that was already running is NOT claimed as this run", async () => {
    startRender("p-already");
    QueueMonitor.markSelfQueued("p-already");
    const { bridge } = makeDisconnectBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_run").handler({ allow_duplicate: true } as never, ctx);
    const text = textOf(res);

    expect(res.isError).toBe(true);
    expect(text).toMatch(/OUTCOME UNKNOWN/);
    expect(text).not.toContain("[RECOVERED]");
  });

  it("an idle queue after disconnect stays unknown — does not invent a prompt id", async () => {
    const { bridge } = makeDisconnectBridge();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res = await defByName("panel_run").handler({} as never, ctx);
    const text = textOf(res);

    expect(res.isError).toBe(true);
    expect(text).toMatch(/OUTCOME UNKNOWN/);
    expect(text).not.toContain("[RECOVERED]");
    expect(text).not.toMatch(/"queued":\s*true/);
  });
});
