// #2502 — after a completed render, panel_graph_outline lists live root node
// 127, then panel_connect from 127 to a newly added 149 is refused:
// "No node with id 127 in the current graph". Mutation lookup was bound to a
// stale graph object while reads already walked the live snapshot.
//
// Tests drive the shipped connect/lookup helpers AND the panel_connect wrap —
// a reimplementation here would stay green if the wrap were deleted.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  canonicalConnectNodeId,
  isMissingNodeInCurrentGraphRefusal,
  isUsableLiveGraphBinding,
  liveGraphHasConnectEndpoints,
  liveGraphHasNodeId,
  missingNodeIdInCurrentGraph,
  parseLiveGraphBinding,
  retryConnectAgainstLiveGraph,
} from "../../services/connect-live-graph.js";
import {
  buildPanelToolDefs,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

const PANEL_SRC = readFileSync(
  fileURLToPath(new URL("../../orchestrator/panel-tools.ts", import.meta.url)),
  "utf8",
);
const SERVICE_SRC = readFileSync(
  fileURLToPath(new URL("../../services/connect-live-graph.ts", import.meta.url)),
  "utf8",
);

const REPORTER_ERROR =
  "Error: No node with id 127 in the current graph - and it is not in any other scope either.";

const INSIDE_SUBGRAPH_ERROR =
  "No node with id 188 in the current graph. Node 188 lives INSIDE a subgraph — call panel_enter_subgraph first";

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
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function allText(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

describe("missing-node current-graph refusal (#2502)", () => {
  it("parses the reporter's exact panel sentence", () => {
    expect(isMissingNodeInCurrentGraphRefusal(REPORTER_ERROR)).toBe(true);
    expect(missingNodeIdInCurrentGraph(REPORTER_ERROR)).toBe("127");
    expect(canonicalConnectNodeId("127")).toBe("127");
    expect(canonicalConnectNodeId(127)).toBe("127");
  });

  it("does not treat a subgraph-scope miss as a stale-identity miss", () => {
    expect(isMissingNodeInCurrentGraphRefusal(INSIDE_SUBGRAPH_ERROR)).toBe(false);
    expect(missingNodeIdInCurrentGraph(INSIDE_SUBGRAPH_ERROR)).toBeNull();
  });
});

describe("live graph lookup / binding", () => {
  it("accepts the outline-shaped live query that lists both connect endpoints", () => {
    const payload = {
      viewing: { scope: "root", graph_identity: "graph:depth-anything-root" },
      truncated: false,
      matched: 2,
      ids: [127, 149],
      text: "127,149",
    };
    expect(parseLiveGraphBinding(payload.viewing)).toEqual({
      scope: "root",
      graphIdentity: "graph:depth-anything-root",
    });
    expect(isUsableLiveGraphBinding(parseLiveGraphBinding(payload.viewing))).toBe(true);
    expect(liveGraphHasNodeId(payload, 127)).toBe(true);
    expect(liveGraphHasNodeId(payload, "149")).toBe(true);
    expect(liveGraphHasConnectEndpoints(payload, 127, 149)).toBe(true);
    expect(liveGraphHasNodeId(payload, 12)).toBe(false);
  });

  it("rejects a truncated or malformed live snapshot instead of guessing", () => {
    expect(
      liveGraphHasNodeId({ truncated: true, ids: [127], viewing: { scope: "root" } }, 127),
    ).toBe(false);
    expect(parseLiveGraphBinding({ scope: "root", graph_identity: 17 })).toBeNull();
    expect(isUsableLiveGraphBinding({ scope: "other" })).toBe(false);
    expect(parseLiveGraphBinding({ kind: "root" })).toBeNull();
  });
});

describe("retryConnectAgainstLiveGraph", () => {
  it("forwards a successful connect with no extra query", async () => {
    const calls: Record<string, unknown>[] = [];
    const res = await retryConnectAgainstLiveGraph(
      { from_node_id: 1, from_output: "IMAGE", to_node_id: 2, to_input: "image" },
      async (cmd) => {
        calls.push(cmd);
        return jsonResult({ connected: true });
      },
    );
    expect(calls).toEqual([
      {
        cmd: "graph_connect",
        from_node_id: 1,
        from_output: "IMAGE",
        to_node_id: 2,
        to_input: "image",
        auto_match: undefined,
      },
    ]);
    expect(res.isError).toBeUndefined();
  });

  it("THE REPORTED CASE: outline-live node 127 is retried after a stale connect miss", async () => {
    let mutationGraph: "stale" | "live" = "stale";
    const calls: Record<string, unknown>[] = [];
    const res = await retryConnectAgainstLiveGraph(
      { from_node_id: 127, from_output: "IMAGE", to_node_id: 149, to_input: "image" },
      async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_connect") {
          if (mutationGraph === "stale") {
            return textResult(REPORTER_ERROR, true);
          }
          return jsonResult({
            connected: { from: 127, to: 149, from_output: "IMAGE", to_input: "image" },
          });
        }
        if (cmd.cmd === "graph_query") {
          mutationGraph = "live";
          return jsonResult({
            viewing: { scope: "root", graph_identity: "graph:depth-anything-root" },
            truncated: false,
            matched: 2,
            ids: [127, 149],
            text: "127,149",
          });
        }
        return textResult(`unexpected ${String(cmd.cmd)}`, true);
      },
    );

    expect(calls.map((c) => c.cmd)).toEqual(["graph_connect", "graph_query", "graph_connect"]);
    expect(calls[1]).toMatchObject({
      cmd: "graph_query",
      ids: [127, 149],
      fields: "ids",
    });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0]!.text!)).toMatchObject({
      connected: { from: 127, to: 149 },
    });
    expect(allText(res)).toMatch(/#2502/);
    expect(allText(res)).toMatch(/panel_graph_outline/);
  });

  it("leaves a genuine missing node alone", async () => {
    const calls: Record<string, unknown>[] = [];
    const res = await retryConnectAgainstLiveGraph(
      { from_node_id: 127, to_node_id: 149 },
      async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_connect") return textResult(REPORTER_ERROR, true);
        return jsonResult({
          viewing: { scope: "root" },
          truncated: false,
          matched: 1,
          ids: [149],
          text: "149",
        });
      },
    );
    expect(calls.map((c) => c.cmd)).toEqual(["graph_connect", "graph_query"]);
    expect(res.isError).toBe(true);
    expect(allText(res)).toBe(REPORTER_ERROR);
  });

  it("does not retry a subgraph-scope miss", async () => {
    const calls: Record<string, unknown>[] = [];
    const res = await retryConnectAgainstLiveGraph(
      { from_node_id: 188, to_node_id: 1 },
      async (cmd) => {
        calls.push(cmd);
        return textResult(INSIDE_SUBGRAPH_ERROR, true);
      },
    );
    expect(calls.map((c) => c.cmd)).toEqual(["graph_connect"]);
    expect(res.isError).toBe(true);
  });
});

describe("panel_connect ships the live-graph lookup (#2502)", () => {
  it("handlers dispatch through retryConnectAgainstLiveGraph", () => {
    expect(PANEL_SRC).toMatch(/retryConnectAgainstLiveGraph\(/);
    expect(PANEL_SRC).toMatch(/"panel_connect"/);
    expect(SERVICE_SRC).toMatch(/cmd: "graph_connect"/);
    expect(SERVICE_SRC).toMatch(/cmd: "graph_query"/);
  });

  it("THE REPORTED CASE through the registered panel_connect handler", async () => {
    let mutationGraph: "stale" | "live" = "stale";
    const calls: Record<string, unknown>[] = [];
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_connect") {
          if (mutationGraph === "stale") {
            return textResult(REPORTER_ERROR, true);
          }
          return jsonResult({ connected: true });
        }
        if (cmd.cmd === "graph_query") {
          mutationGraph = "live";
          return jsonResult({
            viewing: { scope: "root", graph_identity: "graph:depth-anything-root" },
            truncated: false,
            ids: [127, 149],
            text: "127,149",
          });
        }
        return textResult(`unexpected ${String(cmd.cmd)}`, true);
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "wf:2502-reported",
    };

    const res = await defByName("panel_connect").handler(
      { from_node_id: 127, from_output: "IMAGE", to_node_id: 149, to_input: "image" },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(calls.map((c) => c.cmd)).toEqual(["graph_connect", "graph_query", "graph_connect"]);
    expect(allText(res)).toMatch(/#2502/);
  });
});
