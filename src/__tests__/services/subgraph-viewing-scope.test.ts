// #2553 — last confirmed subgraph viewing survives a later mutation that
// finds the canvas back at root.

import { afterEach, describe, expect, it } from "vitest";

import {
  applyLiveRootViewing,
  callAndRememberViewing,
  callWithRememberedSubgraph,
  clearRememberedViewingScope,
  clearStaleSubgraphIdentity,
  isOutsideSubgraphRefusal,
  noteConfirmedViewing,
  parseViewingScope,
  rememberedSubgraphOwner,
  rememberedViewingScope,
  type ToolResultLike,
} from "../../services/subgraph-viewing-scope.js";

const TAB = "tab-2553";
const ROOT_ERROR =
  "panel_unexpose_subgraph_input must be run INSIDE a subgraph - call panel_enter_subgraph first";

function jsonResult(payload: unknown, isError = false): ToolResultLike {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function textResult(text: string, isError = false): ToolResultLike {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

afterEach(() => {
  clearRememberedViewingScope();
});

describe("parseViewingScope / isOutsideSubgraphRefusal", () => {
  it("reads a subgraph owner and a root view", () => {
    expect(
      parseViewingScope({ scope: "subgraph", owner_node_id: 96, title: "Stage" }),
    ).toEqual({ scope: "subgraph", ownerNodeId: "96" });
    expect(parseViewingScope({ scope: "root" })).toEqual({
      scope: "root",
      ownerNodeId: null,
    });
    expect(parseViewingScope({ kind: "root" })).toBeNull();
  });

  it("matches the reported panel refusal and not a generic missing-node error", () => {
    expect(isOutsideSubgraphRefusal(ROOT_ERROR)).toBe(true);
    expect(
      isOutsideSubgraphRefusal(
        "graph_expose_subgraph_input must be run INSIDE a subgraph (no subgraph.addInput on the active graph)",
      ),
    ).toBe(true);
    expect(
      isOutsideSubgraphRefusal("No node with id 188 in the current graph. Node 188 lives INSIDE a subgraph"),
    ).toBe(false);
  });
});

describe("noteConfirmedViewing", () => {
  it("records a query confirmation and an enter fallback owner", () => {
    expect(
      noteConfirmedViewing(TAB, {
        viewing: { scope: "subgraph", owner_node_id: 96 },
      }),
    ).toEqual({ scope: "subgraph", ownerNodeId: "96" });
    expect(rememberedSubgraphOwner(TAB)).toBe("96");

    clearRememberedViewingScope(TAB);
    expect(
      noteConfirmedViewing(TAB, { entered: 12, settled: true }, { enteredNodeId: 12 }),
    ).toEqual({ scope: "subgraph", ownerNodeId: "12" });
  });

  it("an explicit root confirmation clears the subgraph owner", () => {
    noteConfirmedViewing(TAB, { viewing: { scope: "subgraph", owner_node_id: 96 } });
    noteConfirmedViewing(TAB, { viewing: { scope: "root" } });
    expect(rememberedSubgraphOwner(TAB)).toBeNull();
    expect(rememberedViewingScope(TAB)).toEqual({ scope: "root", ownerNodeId: null });
  });

  it("applyLiveRootViewing and clearStaleSubgraphIdentity drop a leftover subgraph owner (#2518)", () => {
    noteConfirmedViewing(TAB, { viewing: { scope: "subgraph", owner_node_id: 96 } });
    expect(applyLiveRootViewing(TAB, { scope: "root", workflow_uuid: "aaa" })).toBe(true);
    expect(rememberedSubgraphOwner(TAB)).toBeNull();
    expect(rememberedViewingScope(TAB)).toEqual({
      scope: "root",
      ownerNodeId: null,
      workflowUuid: "aaa",
    });

    noteConfirmedViewing(TAB, { viewing: { scope: "subgraph", owner_node_id: 12 } });
    clearStaleSubgraphIdentity(TAB);
    expect(rememberedSubgraphOwner(TAB)).toBeNull();
    expect(rememberedViewingScope(TAB)).toBeNull();
  });
});

describe("callWithRememberedSubgraph", () => {
  it("re-enters the last confirmed owner after a later call finds root", async () => {
    await callAndRememberViewing(
      TAB,
      { cmd: "graph_enter_subgraph", node_id: 96 },
      async () =>
        jsonResult({
          entered: 96,
          viewing: { scope: "subgraph", owner_node_id: 96 },
          settled: true,
        }),
    );
    await callAndRememberViewing(
      TAB,
      { cmd: "graph_query", fields: "ids", limit: 1 },
      async () => jsonResult({ viewing: { scope: "subgraph", owner_node_id: 96 }, total: 4 }),
    );

    let canvas: "root" | "subgraph" = "root";
    const calls: Record<string, unknown>[] = [];
    const res = await callWithRememberedSubgraph(
      TAB,
      { cmd: "graph_unexpose_subgraph_input", name: "model" },
      async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_unexpose_subgraph_input") {
          if (canvas !== "subgraph") return textResult(`Error: ${ROOT_ERROR}`, true);
          return jsonResult({ removed: { side: "input", name: "model" } });
        }
        if (cmd.cmd === "graph_query") {
          return jsonResult({
            viewing: canvas === "subgraph" ? { scope: "subgraph", owner_node_id: 96 } : { scope: "root" },
          });
        }
        if (cmd.cmd === "graph_enter_subgraph") {
          canvas = "subgraph";
          return jsonResult({
            entered: cmd.node_id,
            viewing: { scope: "subgraph", owner_node_id: cmd.node_id },
            settled: true,
          });
        }
        return textResult("unexpected", true);
      },
      15000,
    );

    expect(res.isError).toBeUndefined();
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_unexpose_subgraph_input",
      "graph_query",
      "graph_enter_subgraph",
      "graph_unexpose_subgraph_input",
    ]);
    expect(calls[2]).toMatchObject({ cmd: "graph_enter_subgraph", node_id: 96 });
    expect(res.content.some((c) => c.text?.includes("artokun/comfyui-mcp#2553"))).toBe(true);
  });

  it("does not re-enter after an explicit root confirmation", async () => {
    noteConfirmedViewing(TAB, { viewing: { scope: "subgraph", owner_node_id: 96 } });
    await callAndRememberViewing(TAB, { cmd: "graph_exit_subgraph" }, async () =>
      jsonResult({ viewing: { scope: "root" }, settled: true }),
    );

    const calls: Record<string, unknown>[] = [];
    const res = await callWithRememberedSubgraph(
      TAB,
      { cmd: "graph_unexpose_subgraph_input", name: "model" },
      async (cmd) => {
        calls.push(cmd);
        return textResult(`Error: ${ROOT_ERROR}`, true);
      },
    );
    expect(res.isError).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_unexpose_subgraph_input"]);
  });

  it("refuses to restore a subgraph belonging to a different workflow", async () => {
    noteConfirmedViewing(TAB, {
      viewing: { scope: "subgraph", owner_node_id: 96, workflow_uuid: "aaa" },
    });
    const calls: Record<string, unknown>[] = [];
    const res = await callWithRememberedSubgraph(
      TAB,
      { cmd: "graph_unexpose_subgraph_input", name: "model" },
      async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_unexpose_subgraph_input") return textResult(`Error: ${ROOT_ERROR}`, true);
        return jsonResult({ viewing: { scope: "root", workflow_uuid: "bbb" } });
      },
    );
    expect(res.isError).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_unexpose_subgraph_input", "graph_query"]);
    expect(calls.some((c) => c.cmd === "graph_enter_subgraph")).toBe(false);
    expect(res.content.some((c) => c.text?.includes("aaa") && c.text.includes("bbb"))).toBe(true);
  });
});
