// #2529 — panel_run(to_node_id) refused ComfyUI-VideoHelperSuite VHS_VideoCombine
// as "not an output node" because the panel keys constructor.nodeData.output_node,
// which that custom frontend class omits. Live /object_info.output_node is true.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPanelToolDefs,
  __panelToolsTestHooks,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { RunCompletions } from "../../orchestrator/run-completion-journal.js";
import {
  setEnqueueScopedOutputNodeForTests,
  setOutputNodeObjectInfoForTests,
} from "../../services/output-node.js";
import type { ObjectInfo } from "../../comfyui/types.js";

const VHS_REFUSAL =
  `node 380 (VHS_VideoCombine) is not an output node — "run to node" can ` +
  `only target an output node such as SaveImage, PreviewImage, or SaveVideo.`;

function panelRun() {
  const def = buildPanelToolDefs().find((candidate) => candidate.name === "panel_run");
  if (!def) throw new Error("panel_run tool not found");
  return def;
}

function panelQueryGraph() {
  const def = buildPanelToolDefs().find((candidate) => candidate.name === "panel_query_graph");
  if (!def) throw new Error("panel_query_graph tool not found");
  return def;
}

function textOf(res: ToolResult): string {
  return (res.content ?? [])
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function objectInfo(outputNode: boolean): { ok: true; object_info: ObjectInfo } {
  return {
    ok: true,
    object_info: {
      VHS_VideoCombine: {
        input: { required: { images: ["IMAGE", {}] } },
        output: ["VHS_FILENAMES"],
        output_is_list: [false],
        output_name: ["Filenames"],
        name: "VHS_VideoCombine",
        display_name: "Video Combine",
        description: "",
        category: "Video Helper Suite",
        output_node: outputNode,
      },
    },
  };
}

function runCtx(script: {
  graphRun?: (cmd: Record<string, unknown>, attempt: number) => Record<string, unknown> | ToolResult;
  objectInfo?: Record<string, unknown>;
}): { ctx: PanelToolCtx; runs: Record<string, unknown>[] } {
  const runs: Record<string, unknown>[] = [];
  const ctx: PanelToolCtx = {
    call: async (cmd) => {
      if (cmd.cmd === "graph_get_object_info") {
        return {
          content: [{ type: "text", text: JSON.stringify(script.objectInfo ?? objectInfo(true)) }],
        };
      }
      if (cmd.cmd === "graph_query") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                total: 1,
                shown: 1,
                text: JSON.stringify({ id: 380, type: "VHS_VideoCombine" }),
                nodes: [{ id: 380, type: "VHS_VideoCombine" }],
              }),
            },
          ],
        };
      }
      if (cmd.cmd !== "graph_run") {
        return { content: [{ type: "text", text: "{}" }] };
      }
      runs.push(cmd);
      const reply = script.graphRun
        ? script.graphRun(cmd, runs.length)
        : { queued: false, error: VHS_REFUSAL };
      if ("content" in reply) return reply as ToolResult;
      return { content: [{ type: "text", text: JSON.stringify(reply) }] };
    },
    confirm: async () => "yes" as const,
    bridge: {} as PanelToolCtx["bridge"],
    tabId: "t-2529",
  };
  return { ctx, runs };
}

beforeEach(() => {
  RunCompletions.reset();
  __panelToolsTestHooks.setRetrySettleMs(0);
  setOutputNodeObjectInfoForTests(undefined);
  setEnqueueScopedOutputNodeForTests(null);
});

afterEach(() => {
  __panelToolsTestHooks.setRetrySettleMs(null);
  setOutputNodeObjectInfoForTests(undefined);
  setEnqueueScopedOutputNodeForTests(null);
  RunCompletions.reset();
});

describe("panel_run accepts VHS_VideoCombine as to_node_id from object_info (#2529)", () => {
  it("FAILS closed when object_info does not mark the class as an output node", async () => {
    const { ctx, runs } = runCtx({ objectInfo: objectInfo(false) });
    const res = await panelRun().handler({ to_node_id: 380 }, ctx);

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not an output node/);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.output_node).toBeUndefined();
  });

  it("re-issues graph_run with output_node:true once object_info says OUTPUT_NODE", async () => {
    const { ctx, runs } = runCtx({
      graphRun: (cmd, attempt) => {
        if (attempt === 1) return { queued: false, error: VHS_REFUSAL };
        expect(cmd.output_node).toBe(true);
        expect(cmd.to_node_id).toBe(380);
        return { queued: true, prompt_id: "p-vhs-retry" };
      },
    });
    const res = await panelRun().handler({ to_node_id: 380 }, ctx);

    expect(res.isError).toBeFalsy();
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({
      cmd: "graph_run",
      to_node_id: 380,
      output_node: true,
    });
    expect(textOf(res)).toMatch(/p-vhs-retry/);
    expect(RunCompletions.ticketFor("p-vhs-retry")).toBeDefined();
  });

  it("falls back to /prompt partial_execution_targets when the panel still refuses", async () => {
    const enqueued: Array<{ targets: string[] }> = [];
    setEnqueueScopedOutputNodeForTests(async (_workflow, targets) => {
      enqueued.push({ targets });
      return { prompt_id: "p-vhs-http" };
    });
    const { ctx, runs } = runCtx({
      graphRun: () => ({ queued: false, error: VHS_REFUSAL }),
    });
    const res = await panelRun().handler({ to_node_id: 380 }, ctx);

    expect(res.isError).toBeFalsy();
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(enqueued).toEqual([{ targets: ["380"] }]);
    expect(textOf(res)).toMatch(/p-vhs-http/);
    expect(textOf(res)).toMatch(/output_node_source/);
    expect(RunCompletions.ticketFor("p-vhs-http")).toBeDefined();
  });

  it("surfaces a direct fallback enqueue error instead of restoring the original refusal", async () => {
    setEnqueueScopedOutputNodeForTests(async () => {
      throw new Error(
        "OUTCOME UNDETERMINED: the POST to /prompt was accepted and may already be queued",
      );
    });
    const { ctx } = runCtx({
      graphRun: () => ({ queued: false, error: VHS_REFUSAL }),
    });
    const res = await panelRun().handler({ to_node_id: 380 }, ctx);

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/direct \/prompt fallback failed/);
    expect(textOf(res)).toMatch(/OUTCOME UNDETERMINED/);
    expect(textOf(res)).not.toMatch(/nothing was queued/i);
  });

  it("surfaces an unknown outcome when the recovery graph_run retry throws", async () => {
    const { ctx } = runCtx({
      graphRun: (_cmd, attempt) => {
        if (attempt === 1) return { queued: false, error: VHS_REFUSAL };
        throw new Error("socket closed after dispatch");
      },
    });
    const res = await panelRun().handler({ to_node_id: 380 }, ctx);

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/outcome is UNKNOWN/);
    expect(textOf(res)).toMatch(/socket closed after dispatch/);
  });

  it("does not recover a non-output class (KSampler) even if the refusal shape matches", async () => {
    const samplerRefusal =
      `node 12 (KSampler) is not an output node — "run to node" can ` +
      `only target an output node such as SaveImage, PreviewImage, or SaveVideo.`;
    const { ctx, runs } = runCtx({
      objectInfo: {
        ok: true,
        object_info: {
          KSampler: {
            input: { required: {} },
            output: ["LATENT"],
            output_is_list: [false],
            output_name: ["LATENT"],
            name: "KSampler",
            display_name: "KSampler",
            description: "",
            category: "sampling",
            output_node: false,
          },
        },
      },
      graphRun: () => ({ queued: false, error: samplerRefusal }),
    });
    const res = await panelRun().handler({ to_node_id: 12 }, ctx);

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not an output node/);
    expect(runs).toHaveLength(1);
  });
});

describe("panel_query_graph stamps is_output from object_info (#2529)", () => {
  it("adds is_output:true on VHS_VideoCombine when object_info.output_node is true", async () => {
    setOutputNodeObjectInfoForTests(objectInfo(true).object_info);
    const { ctx } = runCtx({});
    const res = await panelQueryGraph().handler({ ids: [380], fields: "detail" }, ctx);
    const payload = JSON.parse(textOf(res)) as {
      nodes?: Array<{ type?: string; is_output?: boolean }>;
    };
    expect(payload.nodes?.[0]).toMatchObject({
      type: "VHS_VideoCombine",
      is_output: true,
    });
  });
});
