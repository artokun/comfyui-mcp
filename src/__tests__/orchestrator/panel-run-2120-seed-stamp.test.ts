// #2120 — panel_run(to_node_id) treated a DaSiWa_SeedControl / KSampler
// queue-time seed roll as a real graph mismatch, refused both scoped
// dispatches, then dropped the orchestrator transport on the safe retry.
//
// The panel certifies that nothing was queued. A seed-only drift list
// (`53 seed_value`, `47 noise_seed`, `53 seed`) is queue-time volatility,
// not a topology/widget edit. A mixed list (seed + steps) still fails closed.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPanelToolDefs,
  __panelRunTestHooks,
  __panelToolsTestHooks,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { RunCompletions } from "../../orchestrator/run-completion-journal.js";

const RACE =
  "run-to-node scope for node 29 was NOT applied: the workflow graph CHANGED after the run " +
  "was queued - the deferred dispatch would render a modified workflow, not the one that was " +
  "scoped. Nothing was queued - refusing to fall through to a full-graph execution (#556).";

const SEED_VALUE_RACE =
  "The differing entry: 53 seed_value. " + RACE;

const NOISE_SEED_RACE =
  "The differing entry: 47 noise_seed. " + RACE;

const MIXED_RACE =
  "The differing entries: 53 seed_value; 12 steps. " + RACE;

const UNDISPATCHED_TRANSPORT =
  "Transport send error: WorkerTransport error: HTTP request failed sending request to " +
  "http://127.0.0.1:9198/orchestrator::codex";

function panelRun() {
  const def = buildPanelToolDefs().find((candidate) => candidate.name === "panel_run");
  if (!def) throw new Error("panel_run tool not found");
  return def;
}

function textOf(res: ToolResult): string {
  return (res.content ?? [])
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function runCtx(
  replies: Array<Record<string, unknown>>,
  extra: Partial<PanelToolCtx> = {},
): {
  ctx: PanelToolCtx;
  runs: Record<string, unknown>[];
} {
  const runs: Record<string, unknown>[] = [];
  const ctx: PanelToolCtx = {
    call: async (cmd) => {
      if (cmd.cmd !== "graph_run") return { content: [{ type: "text", text: "{}" }] };
      const reply = replies[runs.length] ?? { queued: true };
      runs.push(cmd);
      if (typeof reply.__throw === "string") throw new Error(reply.__throw);
      if (typeof reply.__error === "string") {
        return { content: [{ type: "text", text: `Error: ${reply.__error}` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(reply) }] };
    },
    confirm: async () => "yes" as const,
    bridge: {} as PanelToolCtx["bridge"],
    tabId: "t-2120",
    ...extra,
  };
  return { ctx, runs };
}

function answered(error: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error }) }] };
}

function rejectionOf(error: string): ToolResult {
  return { content: [{ type: "text", text: error }] };
}

beforeEach(() => {
  RunCompletions.reset();
  __panelToolsTestHooks.setRetrySettleMs(0);
});

afterEach(() => {
  __panelToolsTestHooks.setRetrySettleMs(null);
  RunCompletions.reset();
});

describe("panel_run seed-only stamp race (#2120)", () => {
  it("classifies DaSiWa seed_value / noise_seed as queue-time seed volatility", () => {
    expect(__panelRunTestHooks.isQueueTimeSeedInputName("seed_value")).toBe(true);
    expect(__panelRunTestHooks.isQueueTimeSeedInputName("noise_seed")).toBe(true);
    expect(__panelRunTestHooks.isQueueTimeSeedInputName("seed")).toBe(true);
    expect(__panelRunTestHooks.isQueueTimeSeedInputName("steps")).toBe(false);
    expect(__panelRunTestHooks.isQueueTimeSeedInputName("seed_control_state")).toBe(false);
    expect(__panelRunTestHooks.stampRaceDriftTokens(SEED_VALUE_RACE)).toEqual(["53 seed_value"]);
    expect(
      __panelRunTestHooks.isSeedRunToNodeStampRace(
        answered(SEED_VALUE_RACE),
        rejectionOf(SEED_VALUE_RACE),
      ),
    ).toBe(true);
    expect(
      __panelRunTestHooks.isSeedRunToNodeStampRace(
        answered(NOISE_SEED_RACE),
        rejectionOf(NOISE_SEED_RACE),
      ),
    ).toBe(true);
  });

  it("fails closed when the stamp names a non-seed widget alongside a seed", () => {
    expect(
      __panelRunTestHooks.isSeedRunToNodeStampRace(answered(MIXED_RACE), rejectionOf(MIXED_RACE)),
    ).toBe(false);
  });

  it("re-issues a random-mode SeedControl seed_value race until the stamp settles", async () => {
    const { ctx, runs } = runCtx([
      { error: SEED_VALUE_RACE },
      { error: SEED_VALUE_RACE },
      { queued: true, prompt_id: "p-seedcontrol" },
    ]);
    const res = await panelRun().handler({ to_node_id: 29 }, ctx);

    expect(res.isError).toBeFalsy();
    expect(runs).toHaveLength(3);
    expect(runs[2]).toMatchObject({ cmd: "graph_run", to_node_id: 29 });
    expect(textOf(res)).toMatch(/re-issued 2 times/);
    expect(textOf(res)).toMatch(/queued NOTHING/i);
  });

  it("does not spend the extra seed retry on a real graph mismatch", async () => {
    const { ctx, runs } = runCtx([
      { error: MIXED_RACE },
      { error: MIXED_RACE },
      { queued: true, prompt_id: "must-not-dispatch" },
    ]);
    const res = await panelRun().handler({ to_node_id: 29 }, ctx);

    expect(res.isError).toBe(true);
    expect(runs).toHaveLength(2);
    expect(textOf(res)).toMatch(/re-issued exactly once/);
    expect(textOf(res)).not.toContain("must-not-dispatch");
  });

  it("reconnects an undispatched transport drop on the seed-stamp retry instead of leaving the caller without a result", async () => {
    let rebinds = 0;
    const { ctx, runs } = runCtx(
      [
        { error: SEED_VALUE_RACE },
        { __error: UNDISPATCHED_TRANSPORT },
        { queued: true, prompt_id: "p-after-reconnect" },
      ],
      {
        rebindToActiveTab: () => {
          rebinds += 1;
          return { previous: "t-2120", current: "t-2120", rebound: true };
        },
      },
    );
    const res = await panelRun().handler({ to_node_id: 29 }, ctx);

    expect(res.isError).toBeFalsy();
    expect(rebinds).toBe(1);
    expect(runs).toHaveLength(3);
    expect(textOf(res)).toMatch(/p-after-reconnect/);
    expect(textOf(res)).not.toMatch(/HTTP request failed/);
  });

  it("still stops when a dispatched transport failure carries retry_of", async () => {
    const dispatched =
      `${UNDISPATCHED_TRANSPORT}; retry_of:"rid-seed-retry"`;
    const { ctx, runs } = runCtx([
      { error: SEED_VALUE_RACE },
      { __error: dispatched },
      { queued: true, prompt_id: "must-not-dispatch" },
    ]);
    const res = await panelRun().handler({ to_node_id: 29 }, ctx);

    expect(res.isError).toBe(true);
    expect(runs).toHaveLength(2);
    expect(textOf(res)).toContain('retry_of:"rid-seed-retry"');
    expect(textOf(res)).not.toContain("must-not-dispatch");
  });

  it("reconnects a thrown undispatched send error and still queues the scoped run", async () => {
    const { ctx, runs } = runCtx([
      { error: SEED_VALUE_RACE },
      { __throw: UNDISPATCHED_TRANSPORT },
      { queued: true, prompt_id: "p-thrown-reconnect" },
    ]);
    const res = await panelRun().handler({ to_node_id: 29 }, ctx);

    expect(res.isError).toBeFalsy();
    expect(runs).toHaveLength(3);
    expect(textOf(res)).toMatch(/p-thrown-reconnect/);
  });
});
