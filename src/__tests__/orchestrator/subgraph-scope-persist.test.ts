// #2553 — enter + query confirm subgraph; a later unexpose on a NEW tool call
// must restore that scope instead of silently targeting root.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import {
  clearRememberedViewingScope,
  rememberedSubgraphOwner,
} from "../../services/subgraph-viewing-scope.js";

const SRC = readFileSync(
  fileURLToPath(new URL("../../orchestrator/panel-tools.ts", import.meta.url)),
  "utf8",
);

const ROOT_ERROR =
  "panel_unexpose_subgraph_input must be run INSIDE a subgraph - call panel_enter_subgraph first";

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} not found`);
  return def;
}

function jsonResult(payload: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function textResult(text: string, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

afterEach(() => {
  clearRememberedViewingScope();
});

describe("subgraph viewing scope across panel tool calls (#2553)", () => {
  it("handlers dispatch through the shipped remember/restore helpers", () => {
    expect(SRC).toMatch(/callAndRememberViewing\(/);
    expect(SRC).toMatch(/callWithRememberedSubgraph\(/);
    expect(SRC).toMatch(/cmd: "graph_unexpose_subgraph_input"/);
    expect(SRC).toMatch(/cmd: "graph_enter_subgraph"/);
  });

  it("THE REPORTED CASE: enter, query confirms subgraph, later unexpose still restores it", async () => {
    const tabId = "wf:2553-reported";
    let canvas: "root" | "subgraph" = "root";
    let owner: number | null = null;
    const calls: Record<string, unknown>[] = [];

    const call: PanelToolCtx["call"] = async (cmd) => {
      calls.push(cmd);
      if (cmd.cmd === "graph_enter_subgraph") {
        canvas = "subgraph";
        owner = Number(cmd.node_id);
        return jsonResult({
          entered: cmd.node_id,
          viewing: { scope: "subgraph", owner_node_id: owner },
          settled: true,
        });
      }
      if (cmd.cmd === "graph_query") {
        return jsonResult({
          viewing:
            canvas === "subgraph"
              ? { scope: "subgraph", owner_node_id: owner }
              : { scope: "root" },
          total: 4,
        });
      }
      if (cmd.cmd === "graph_unexpose_subgraph_input") {
        if (canvas !== "subgraph") return textResult(`Error: ${ROOT_ERROR}`, true);
        return jsonResult({
          removed: {
            side: "input",
            name: cmd.name,
            slot: 0,
            interior_links_dropped: 0,
            host_links_dropped: 0,
            host_links_reindexed: true,
          },
        });
      }
      return textResult(`unexpected ${String(cmd.cmd)}`, true);
    };

    const ctxFor = (): PanelToolCtx => ({
      call,
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId,
    });

    // Separate MCP tool calls, same bound tab.
    await defByName("panel_enter_subgraph").handler({ node_id: 96 }, ctxFor());
    expect(rememberedSubgraphOwner(tabId)).toBe("96");

    const queried = await defByName("panel_query_graph").handler({ fields: "ids", limit: 1 }, ctxFor());
    expect(queried.isError).toBeUndefined();
    const queryPayload = JSON.parse(queried.content[0]?.text ?? "{}") as {
      viewing?: { scope?: string };
    };
    expect(queryPayload.viewing?.scope).toBe("subgraph");

    // Canvas pops back to root between calls — the reported loss.
    canvas = "root";

    const unexposed = await defByName("panel_unexpose_subgraph_input").handler(
      { name: "model" },
      ctxFor(),
    );
    expect(unexposed.isError).toBeUndefined();
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_enter_subgraph",
      "graph_query",
      "graph_unexpose_subgraph_input",
      "graph_query",
      "graph_enter_subgraph",
      "graph_unexpose_subgraph_input",
    ]);
    expect(calls[4]).toMatchObject({ cmd: "graph_enter_subgraph", node_id: 96 });
    expect(calls[5]).toMatchObject({ cmd: "graph_unexpose_subgraph_input", name: "model" });
    const removed = JSON.parse(unexposed.content[0]?.text ?? "{}") as {
      removed?: { name?: string };
    };
    expect(removed.removed?.name).toBe("model");
    expect(unexposed.content.some((c) => c.type === "text" && c.text.includes("#2553"))).toBe(
      true,
    );
  });

  it("does not invent a subgraph when this session never confirmed one", async () => {
    const tabId = "wf:2553-never-entered";
    const calls: Record<string, unknown>[] = [];
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        calls.push(cmd);
        return textResult(`Error: ${ROOT_ERROR}`, true);
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId,
    };
    const res = await defByName("panel_unexpose_subgraph_input").handler({ name: "model" }, ctx);
    expect(res.isError).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_unexpose_subgraph_input"]);
    expect(res.content[0]?.text).toMatch(/INSIDE a subgraph/);
  });
});
