// #2120 — panel_run(to_node_id) treated a DaSiWa_SeedControl / KSampler
// queue-time seed roll as a real graph mismatch, refused both scoped
// dispatches, then dropped the orchestrator transport on the safe retry.
//
// The panel certifies that nothing was queued. A seed-only drift list
// (`53 seed_value`, `47 noise_seed`, `53 seed`) is queue-time volatility,
// as is DaSiWa's paired `53 seed_control_state; 53 seed_value` stamp. A mixed
// list (seed + steps) still fails closed, and an outer transport failure is
// handled by codex-backend's control-plane fence rather than this handler.

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

const DASIWA_SEED_CONTROL_RACE =
  "The differing entries: 53 seed_control_state; 53 seed_value. " + RACE;

const NOISE_SEED_RACE =
  "The differing entry: 47 noise_seed. " + RACE;

const MIXED_RACE =
  "The differing entries: 53 seed_value; 12 steps. " + RACE;

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
  it("classifies the exact DaSiWa state-plus-seed drift, but not state alone", () => {
    expect(__panelRunTestHooks.isQueueTimeSeedInputName("seed_value")).toBe(true);
    expect(__panelRunTestHooks.isQueueTimeSeedInputName("noise_seed")).toBe(true);
    expect(__panelRunTestHooks.isQueueTimeSeedInputName("seed")).toBe(true);
    expect(__panelRunTestHooks.isQueueTimeSeedInputName("steps")).toBe(false);
    expect(__panelRunTestHooks.isQueueTimeSeedInputName("seed_control_state")).toBe(false);
    expect(__panelRunTestHooks.stampRaceDriftTokens(DASIWA_SEED_CONTROL_RACE)).toEqual([
      "53 seed_control_state",
      "53 seed_value",
    ]);
    expect(
      __panelRunTestHooks.isSeedRunToNodeStampRace(
        answered(DASIWA_SEED_CONTROL_RACE),
        rejectionOf(DASIWA_SEED_CONTROL_RACE),
      ),
    ).toBe(true);
    const stateOnly = DASIWA_SEED_CONTROL_RACE.replace("; 53 seed_value", "");
    expect(
      __panelRunTestHooks.isSeedRunToNodeStampRace(answered(stateOnly), rejectionOf(stateOnly)),
    ).toBe(false);
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

  it("re-issues the combined DaSiWa state and seed drift through the production panel_run handler", async () => {
    const { ctx, runs } = runCtx([
      { error: DASIWA_SEED_CONTROL_RACE },
      { error: DASIWA_SEED_CONTROL_RACE },
      { queued: true, prompt_id: "p-dasiwa-seedcontrol" },
    ]);
    const res = await panelRun().handler({ to_node_id: 29 }, ctx);

    expect(res.isError).toBeFalsy();
    expect(runs).toHaveLength(3);
    expect(textOf(res)).toContain("p-dasiwa-seedcontrol");
    expect(textOf(res)).toMatch(/re-issued 2 times/);
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

  it("does not re-dispatch when the scoped retry itself throws a transport failure", async () => {
    const transport = "WorkerTransport: HTTP request failed sending request";
    const { ctx, runs } = runCtx([
      { error: SEED_VALUE_RACE },
      { __throw: transport },
      { queued: true, prompt_id: "must-not-dispatch" },
    ]);
    const res = await panelRun().handler({ to_node_id: 29 }, ctx);

    expect(res.isError).toBe(true);
    expect(runs).toHaveLength(2);
    expect(textOf(res)).toContain(transport);
    expect(textOf(res)).not.toContain("must-not-dispatch");
  });
});
