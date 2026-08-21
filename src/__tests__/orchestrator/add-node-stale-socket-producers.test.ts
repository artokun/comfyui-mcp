// #1944 — panel_add_node("SeedVR2VideoUpscaler") is refused after 5s even when
// SeedVR2LoadDiTModel and SeedVR2LoadVAEModel are already on the live canvas
// outputting SEEDVR2_DIT / SEEDVR2_VAE. The add-node guard's socket proof
// reads those producers off a single-class /object_info payload, so sibling
// outputs look missing. Retrying the add re-runs the same proof.
//
// The orchestrator must keep the panel's refusal, consult the live graph the
// reporter used (graph_find_nodes / panel_query_graph), and name the producers
// that are already there — plus the copy/paste workaround that actually works.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";

/** The reporter's exact panel refusal (issue #1944), in the panel's real wording. */
const REPORTER_REFUSAL =
  `Cannot add "SeedVR2VideoUpscaler": 2 required input types had no widget after 5.0s ` +
  `waiting for node extensions to register.\n` +
  `- input "dit" (declared type "SEEDVR2_DIT"): no installed node outputs ` +
  `"SEEDVR2_DIT" and no frontend widget is registered for it.\n` +
  `- input "vae" (declared type "SEEDVR2_VAE"): no installed node outputs ` +
  `"SEEDVR2_VAE" and no frontend widget is registered for it.`;

function liveProducers(output: string) {
  if (output === "SEEDVR2_DIT") {
    return {
      matches: [
        {
          id: 11,
          type: "SeedVR2LoadDiTModel",
          outputs: [{ slot: 0, name: "DIT_MODEL", type: "SEEDVR2_DIT", links: 0 }],
        },
      ],
      count: 1,
    };
  }
  if (output === "SEEDVR2_VAE") {
    return {
      matches: [
        {
          id: 12,
          type: "SeedVR2LoadVAEModel",
          outputs: [{ slot: 0, name: "VAE", type: "SEEDVR2_VAE", links: 0 }],
        },
      ],
      count: 1,
    };
  }
  return { matches: [], count: 0 };
}

function bridge(opts: {
  message: string;
  producers?: (output: string) => { matches: unknown[]; count: number } | "throw";
}) {
  const calls: Array<Record<string, unknown>> = [];
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push(cmd);
      if (cmd.cmd === "graph_find_nodes") {
        const output = typeof cmd.output === "string" ? cmd.output : "";
        const reply = (opts.producers ?? liveProducers)(output);
        if (reply === "throw") throw new Error("graph_find_nodes failed");
        return reply;
      }
      throw new Error(opts.message);
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  return { b, calls };
}

async function addNode(
  classType: string,
  message: string,
  producers?: (output: string) => { matches: unknown[]; count: number } | "throw",
) {
  const { b, calls } = bridge({ message, producers });
  const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_add_node");
  if (!def) throw new Error("panel_add_node is not registered");
  const res: ToolResult = await def.handler({ class_type: classType } as never, ctx);
  return {
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    isError: res.isError === true,
    calls,
  };
}

describe("panel_add_node names live sibling socket producers (#1944)", () => {
  it("the reporter's case: keeps the refusal and names the loaders already on the canvas", async () => {
    const { text, isError, calls } = await addNode("SeedVR2VideoUpscaler", REPORTER_REFUSAL);

    expect(isError).toBe(true);
    expect(text).toContain(REPORTER_REFUSAL);
    expect(text).toContain("SeedVR2LoadDiTModel #11");
    expect(text).toContain("SeedVR2LoadVAEModel #12");
    expect(text).toMatch(/SEEDVR2_DIT/);
    expect(text).toMatch(/SEEDVR2_VAE/);
    expect(text).toMatch(/live canvas ALREADY has nodes that output/i);
    expect(text).toMatch(/Retrying panel_add_node will keep failing/);
    expect(text).toMatch(/panel_refresh_nodes will not/);
    expect(text).toMatch(/panel_copy_nodes \/ panel_paste_nodes/);
    expect(text).toMatch(/Do not retry this class_type/);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_add_node",
      "graph_find_nodes",
      "graph_find_nodes",
    ]);
    expect(calls.filter((c) => c.cmd === "graph_add_node")).toHaveLength(1);
    expect(calls).not.toContainEqual(expect.objectContaining({ cmd: "refresh_nodes" }));
  });

  it("does not retry or refresh — those re-run the same stale proof", async () => {
    const { calls } = await addNode("SeedVR2VideoUpscaler", REPORTER_REFUSAL);
    expect(calls.filter((c) => c.cmd === "graph_add_node")).toHaveLength(1);
    expect(calls.some((c) => c.cmd === "refresh_nodes")).toBe(false);
  });

  it("asks the live graph for each unproven output type", async () => {
    const { calls } = await addNode("SeedVR2VideoUpscaler", REPORTER_REFUSAL);
    const finds = calls.filter((c) => c.cmd === "graph_find_nodes");
    expect(finds.map((c) => c.output).sort()).toEqual(["SEEDVR2_DIT", "SEEDVR2_VAE"]);
  });

  it("leaves a genuine missing-producer refusal alone when the live graph has none", async () => {
    const { text, isError, calls } = await addNode("SeedVR2VideoUpscaler", REPORTER_REFUSAL, () => ({
      matches: [],
      count: 0,
    }));

    expect(isError).toBe(true);
    expect(text).toContain(REPORTER_REFUSAL);
    expect(text).not.toMatch(/live canvas ALREADY has nodes that output/i);
    expect(text).not.toContain("SeedVR2LoadDiTModel");
    expect(calls.filter((c) => c.cmd === "graph_add_node")).toHaveLength(1);
  });

  it("an unreadable live graph does not invent producers", async () => {
    const { text, isError } = await addNode(
      "SeedVR2VideoUpscaler",
      REPORTER_REFUSAL,
      () => "throw",
    );

    expect(isError).toBe(true);
    expect(text).toContain(REPORTER_REFUSAL);
    expect(text).not.toMatch(/live canvas ALREADY has nodes that output/i);
  });

  it("a LoRA Manager Vue-widget wait is still the #1708 note, not this one", async () => {
    const lora =
      `Cannot add "Lora Loader (LoraManager)": 1 required input type had no widget after 5.0s ` +
      `waiting for node extensions to register.\n` +
      `- input "text" (declared type "AUTOCOMPLETE_TEXT_LORAS"): no installed node outputs ` +
      `"AUTOCOMPLETE_TEXT_LORAS" and no frontend widget is registered for it.`;
    const { text, isError, calls } = await addNode("Lora Loader (LoraManager)", lora);

    expect(isError).toBe(true);
    expect(text).toContain(lora);
    expect(text).toContain("LoRA Text Loader (LoraManager)");
    expect(text).not.toMatch(/live canvas ALREADY has nodes that output/i);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_add_node"]);
  });

  it("the tool description names the live-graph copy/paste workaround", () => {
    const def = buildPanelToolDefs().find((d) => d.name === "panel_add_node");
    if (!def) throw new Error("panel_add_node is not registered");
    expect(def.description).toMatch(/no installed node outputs/);
    expect(def.description).toMatch(/panel_copy_nodes \/ panel_paste_nodes/);
    expect(def.description).toMatch(/SEEDVR2_DIT/);
  });

  it("a healthy add is untouched — one call, no graph search", async () => {
    const calls: string[] = [];
    const b = {
      send: async (cmd: Record<string, unknown>) => {
        calls.push(String(cmd.cmd));
        return { ok: true, node_id: 13 };
      },
      push: () => 1,
      canReach: () => true,
      isHeadless: () => false,
      tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => TAB,
      tabCanMutateGraph: () => true,
      tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
    const def = buildPanelToolDefs().find((d) => d.name === "panel_add_node");
    if (!def) throw new Error("panel_add_node is not registered");
    const res = await def.handler({ class_type: "SeedVR2VideoUpscaler" } as never, ctx);

    expect(res.isError).toBeFalsy();
    expect(calls).toEqual(["graph_add_node"]);
    const text = res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");
    expect(text).not.toMatch(/Do not retry this class_type/);
  });
});
