// #2778 — panel_connect refuses subgraph INT rail "Scene Seed" onto
// LocalWildcardText.seed as "INT is not compatible with INT" while the same
// rail already feeds KSampler.seed / FaceDetailer.seed.
//
// Tests drive the shipped helpers AND the panel_connect wrap — a reimplementation
// here would stay green if the wrap were deleted.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  railSocketTypesCompatible,
  resolveRailSlotRetry,
  retryRailSlotConnect,
  subgraphInputTypeRefusal,
} from "../../services/rail-slot-connect.js";
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
  fileURLToPath(new URL("../../services/rail-slot-connect.ts", import.meta.url)),
  "utf8",
);

const REPORTER_ERROR =
  "Error: connect refused - subgraph input Scene Seed (INT) is not compatible with node 67 input seed (INT)";

const PANEL_ERROR =
  'Error: connect refused — subgraph input "Scene Seed" (INT) is not compatible with node 67 input "seed" (INT)';

const COERCED_SPEC_ERROR =
  "Error: connect refused — subgraph input \"Scene Seed\" (INT,[object Object]) is not compatible with node 67 input \"seed\" (INT)";

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

describe("subgraph INT rail type-refusal parse (#2778)", () => {
  it("parses the reporter's exact sentence", () => {
    const refusal = subgraphInputTypeRefusal(REPORTER_ERROR);
    expect(refusal).toEqual({
      railName: "Scene Seed",
      railType: "INT",
      nodeId: "67",
      inputName: "seed",
      inputType: "INT",
    });
  });

  it("parses the panel's quoted form", () => {
    const refusal = subgraphInputTypeRefusal(PANEL_ERROR);
    expect(refusal?.railName).toBe("Scene Seed");
    expect(refusal?.inputName).toBe("seed");
  });

  it("parses Array.toString() widget-spec display", () => {
    const refusal = subgraphInputTypeRefusal(COERCED_SPEC_ERROR);
    expect(refusal?.railType).toBe("INT,[object Object]");
    expect(railSocketTypesCompatible(refusal?.railType, refusal?.inputType)).toBe(true);
  });

  it("does not treat a MODEL→CLIP refusal as an INT rail false negative", () => {
    const text =
      'connect refused — subgraph input "MODEL" (MODEL) is not compatible with node 3 input "clip" (CLIP)';
    const refusal = subgraphInputTypeRefusal(text);
    expect(refusal).not.toBeNull();
    expect(railSocketTypesCompatible(refusal?.railType, refusal?.inputType)).toBe(false);
  });
});

describe("resolveRailSlotRetry", () => {
  const args = { from_node_id: -10, from_output: "Scene Seed", to_node_id: 67, to_input: "seed" };

  it("retries INT widget-spec → INT", () => {
    const refusal = subgraphInputTypeRefusal(REPORTER_ERROR);
    expect(refusal).not.toBeNull();
    const plan = resolveRailSlotRetry(refusal!, args, {
      rails: {
        input: {
          provides_outputs: [{ name: "Scene Seed", type: ["INT", { min: 0, max: 0xffffffffffffffff }] }],
        },
      },
      nodes: [
        {
          id: 67,
          type: "LocalWildcardText",
          inputs: [{ name: "seed", type: "INT" }],
        },
      ],
    });
    expect(plan).toMatchObject({
      from_node_id: -10,
      from_output: "Scene Seed",
      to_node_id: 67,
      to_input: "seed",
      auto_match: false,
    });
  });

  it("does not retry when the live target is a different concrete type", () => {
    const refusal = subgraphInputTypeRefusal(REPORTER_ERROR);
    expect(refusal).not.toBeNull();
    expect(
      resolveRailSlotRetry(refusal!, args, {
        nodes: [{ id: 67, type: "CLIPTextEncode", inputs: [{ name: "seed", type: "CLIP" }] }],
      }),
    ).toBeNull();
  });
});

describe("retryRailSlotConnect", () => {
  it("THE REPORTED CASE: Scene Seed INT rail → LocalWildcardText.seed retries and lands", async () => {
    const calls: Record<string, unknown>[] = [];
    const res = await retryRailSlotConnect(
      { from_node_id: -10, from_output: "Scene Seed", to_node_id: 67, to_input: "seed" },
      textResult(REPORTER_ERROR, true),
      async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_query") {
          return jsonResult({
            truncated: false,
            rails: {
              input: {
                provides_outputs: [{ name: "Scene Seed", type: ["INT", { min: 0, max: 1e15 }] }],
              },
            },
            nodes: [
              {
                id: 67,
                type: "LocalWildcardText",
                inputs: [{ name: "seed", type: "INT" }],
              },
            ],
          });
        }
        if (cmd.cmd === "graph_connect") {
          return jsonResult({
            connected: {
              from: { subgraph_input: "Scene Seed" },
              to: { node_id: 67, input: "seed" },
            },
          });
        }
        return textResult(`unexpected ${String(cmd.cmd)}`, true);
      },
    );
    expect(res.isError).toBeUndefined();
    expect(allText(res)).toMatch(/#2778/);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_query", "graph_connect"]);
    expect(calls[1]).toMatchObject({
      cmd: "graph_connect",
      from_node_id: -10,
      from_output: "Scene Seed",
      to_node_id: 67,
      to_input: "seed",
      auto_match: false,
    });
  });

  it("does not inspect a successful connect", async () => {
    const calls: Record<string, unknown>[] = [];
    const connected = jsonResult({ connected: true });
    const res = await retryRailSlotConnect(
      { from_node_id: -10, to_node_id: 67 },
      connected,
      async (cmd) => {
        calls.push(cmd);
        return jsonResult({});
      },
    );
    expect(JSON.parse(allText(res))).toEqual({ connected: true });
    expect(calls).toEqual([]);
  });

  it("leaves a MODEL→CLIP rail mismatch alone", async () => {
    const calls: Record<string, unknown>[] = [];
    const failed = textResult(
      'connect refused — subgraph input "MODEL" (MODEL) is not compatible with node 3 input "clip" (CLIP)',
      true,
    );
    const res = await retryRailSlotConnect(
      { from_node_id: -10, from_output: "MODEL", to_node_id: 3, to_input: "clip" },
      failed,
      async (cmd) => {
        calls.push(cmd);
        return jsonResult({});
      },
    );
    expect(res.isError).toBe(true);
    expect(allText(res)).toMatch(/MODEL/);
    expect(calls).toEqual([]);
  });
});

describe("panel_connect ships the subgraph INT rail retry (#2778)", () => {
  it("handlers dispatch through retryRailSlotConnect", () => {
    expect(PANEL_SRC).toMatch(/retryRailSlotConnect\(/);
    expect(PANEL_SRC).toMatch(/retryConnectAgainstLiveGraph\(/);
    expect(PANEL_SRC).toMatch(/"panel_connect"/);
    expect(SERVICE_SRC).toMatch(/cmd: "graph_query"/);
    expect(SERVICE_SRC).toMatch(/cmd: "graph_connect"/);
    expect(SERVICE_SRC).toMatch(/auto_match: false/);
  });

  it("documents INT rail fan-out on the tool itself", () => {
    const description = defByName("panel_connect").description;
    expect(description).toContain("Scene Seed");
    expect(description).toContain("LocalWildcardText");
  });

  it("THE REPORTED CASE through the registered panel_connect handler", async () => {
    const calls: Record<string, unknown>[] = [];
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_connect") {
          if (cmd.auto_match === false && cmd.to_input === "seed") {
            return jsonResult({
              connected: {
                from: { subgraph_input: "Scene Seed" },
                to: { node_id: 67, input: "seed" },
              },
            });
          }
          return textResult(REPORTER_ERROR, true);
        }
        if (cmd.cmd === "graph_query") {
          return jsonResult({
            truncated: false,
            nodes: [
              {
                id: 67,
                type: "LocalWildcardText",
                inputs: [{ name: "seed", type: ["INT", { min: 0, max: 1e15 }] }],
              },
            ],
          });
        }
        return textResult(`unexpected ${String(cmd.cmd)}`, true);
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "wf:2778-reported",
    };

    const res = await defByName("panel_connect").handler(
      { from_node_id: -10, from_output: "Scene Seed", to_node_id: 67, to_input: "seed" },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(allText(res)).toMatch(/#2778/);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_connect",
      "graph_query",
      "graph_connect",
      "graph_query",
    ]);
    expect(calls[2]).toMatchObject({
      from_output: "Scene Seed",
      to_input: "seed",
      auto_match: false,
    });
  });
});
