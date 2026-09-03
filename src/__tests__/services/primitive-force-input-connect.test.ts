// #2536 — panel_connect reports success for a frontend PrimitiveNode wired to a
// forceInput-only STRING (ApplyAnimaLoraFromPath.lora_path). panel_query_graph
// shows the LiteGraph link, then panel_run omits the required input.
//
// Tests drive the shipped helpers AND the panel_connect wrap — a reimplementation
// here would stay green if the wrap were deleted.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  backendStringProducerConnectAdvice,
  findTargetConnectInput,
  hasSerializableWidgetBinding,
  isForceInputOnlyNonWidget,
  isFrontendPrimitiveNodeType,
  parseLiveConnectNodes,
  primitiveForceInputRefusal,
  verifyPrimitiveForceInputAfterConnect,
  type LiveConnectInput,
} from "../../services/primitive-force-input-connect.js";
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
  fileURLToPath(new URL("../../services/primitive-force-input-connect.ts", import.meta.url)),
  "utf8",
);

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

function input(partial: Partial<LiveConnectInput> & Pick<LiveConnectInput, "name">): LiveConnectInput {
  return {
    slot: 0,
    type: "STRING",
    widget: undefined,
    forceInput: false,
    connectedFrom: null,
    ...partial,
  };
}

const PRIMITIVE = {
  id: 12,
  type: "PrimitiveNode",
  widgets: { value: "C:/models/loras/foo.safetensors" },
  inputs: [],
  outputs: [{ name: "STRING", type: "STRING" }],
};

const FORCE_INPUT_TARGET = {
  id: 5,
  type: "ApplyAnimaLoraFromPath",
  widgets: {},
  inputs: [
    {
      slot: 0,
      name: "lora_path",
      type: "STRING",
      forceInput: true,
      connected_from: { node_id: 12, output_slot: 0 },
    },
  ],
};

describe("PrimitiveNode widget-binding helpers (#2536)", () => {
  it("identifies only the frontend PrimitiveNode", () => {
    expect(isFrontendPrimitiveNodeType("PrimitiveNode")).toBe(true);
    expect(isFrontendPrimitiveNodeType("PrimitiveStringMultiline")).toBe(false);
    expect(isFrontendPrimitiveNodeType("CLIPTextEncode")).toBe(false);
  });

  it("treats input.widget as a serializable binding", () => {
    expect(hasSerializableWidgetBinding(input({ name: "text", widget: { name: "text" } }))).toBe(true);
    expect(hasSerializableWidgetBinding(input({ name: "text", widget: "text" }))).toBe(true);
    expect(hasSerializableWidgetBinding(input({ name: "lora_path" }))).toBe(false);
  });

  it("proves forceInput-only / non-widget from the live row", () => {
    expect(
      isForceInputOnlyNonWidget(input({ name: "lora_path", forceInput: true }), {}, true),
    ).toBe(true);
    expect(isForceInputOnlyNonWidget(input({ name: "lora_path" }), {}, true)).toBe(true);
    expect(
      isForceInputOnlyNonWidget(input({ name: "text", widget: { name: "text" } }), {}, true),
    ).toBe(false);
    expect(isForceInputOnlyNonWidget(input({ name: "text" }), { text: "a cat" }, true)).toBe(false);
    expect(isForceInputOnlyNonWidget(input({ name: "text" }), null, false)).toBe(false);
  });

  it("finds the reporter's lora_path by name and by connected_from", () => {
    const nodes = parseLiveConnectNodes({ truncated: false, nodes: [PRIMITIVE, FORCE_INPUT_TARGET] });
    expect(nodes).not.toBeNull();
    const target = nodes!.find((n) => n.id === "5");
    expect(target).toBeDefined();
    expect(findTargetConnectInput(target!, 12, "lora_path")?.name).toBe("lora_path");
    expect(findTargetConnectInput(target!, 12, undefined)?.name).toBe("lora_path");
  });

  it("names PrimitiveStringMultiline in the refusal", () => {
    const text = primitiveForceInputRefusal({
      fromNodeId: 12,
      toNodeId: 5,
      toType: "ApplyAnimaLoraFromPath",
      inputName: "lora_path",
      inputType: "STRING",
      disconnected: true,
    });
    expect(text).toMatch(/PrimitiveNode #12/);
    expect(text).toMatch(/lora_path/);
    expect(text).toMatch(/forceInput-only/);
    expect(text).toMatch(/PrimitiveStringMultiline/);
    expect(text).toContain(backendStringProducerConnectAdvice("lora_path"));
    expect(text).toMatch(/disconnected/);
    expect(text).toMatch(/#2536/);
  });
});

describe("verifyPrimitiveForceInputAfterConnect", () => {
  it("THE REPORTED CASE: PrimitiveNode → forceInput STRING is refused and undone", async () => {
    const calls: Record<string, unknown>[] = [];
    const connected = jsonResult({
      connected: { from_node_id: 12, to_node_id: 5, to_input: "lora_path" },
    });
    const res = await verifyPrimitiveForceInputAfterConnect(
      { from_node_id: 12, from_output: "STRING", to_node_id: 5, to_input: "lora_path" },
      connected,
      async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_query") {
          return jsonResult({ truncated: false, nodes: [PRIMITIVE, FORCE_INPUT_TARGET] });
        }
        if (cmd.cmd === "graph_disconnect") {
          return jsonResult({ disconnected: { node_id: 5, input: "lora_path" } });
        }
        return textResult(`unexpected ${String(cmd.cmd)}`, true);
      },
    );
    expect(res.isError).toBe(true);
    expect(allText(res)).toMatch(/PrimitiveStringMultiline/);
    expect(allText(res)).toMatch(/lora_path/);
    expect(allText(res)).not.toMatch(/"connected"/);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_query", "graph_disconnect"]);
    expect(calls[1]).toMatchObject({ cmd: "graph_disconnect", node_id: 5, input: "lora_path" });
  });

  it("refuses a forceInput-less STRING that has no widget map entry either", async () => {
    const res = await verifyPrimitiveForceInputAfterConnect(
      { from_node_id: 12, to_node_id: 5, to_input: "lora_path" },
      jsonResult({ connected: true }),
      async (cmd) => {
        if (cmd.cmd === "graph_query") {
          return jsonResult({
            truncated: false,
            nodes: [
              PRIMITIVE,
              {
                id: 5,
                type: "ApplyAnimaLoraFromPath",
                widgets: {},
                inputs: [
                  {
                    name: "lora_path",
                    type: "STRING",
                    connected_from: { node_id: 12, output_slot: 0 },
                  },
                ],
              },
            ],
          });
        }
        return jsonResult({ disconnected: true });
      },
    );
    expect(res.isError).toBe(true);
    expect(allText(res)).toMatch(/no serializable widget binding/);
  });

  it("allows PrimitiveNode → a widget STRING (CLIPTextEncode.text)", async () => {
    const calls: Record<string, unknown>[] = [];
    const connected = jsonResult({ connected: true });
    const res = await verifyPrimitiveForceInputAfterConnect(
      { from_node_id: 12, from_output: "STRING", to_node_id: 6, to_input: "text" },
      connected,
      async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_query") {
          return jsonResult({
            truncated: false,
            nodes: [
              PRIMITIVE,
              {
                id: 6,
                type: "CLIPTextEncode",
                widgets: { text: "a cat" },
                inputs: [
                  {
                    name: "text",
                    type: "STRING",
                    widget: { name: "text" },
                    connected_from: { node_id: 12, output_slot: 0 },
                  },
                ],
              },
            ],
          });
        }
        return textResult(`unexpected ${String(cmd.cmd)}`, true);
      },
    );
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(allText(res))).toEqual({ connected: true });
    expect(calls.map((c) => c.cmd)).toEqual(["graph_query"]);
  });

  it("allows a backend PrimitiveStringMultiline on the same forceInput STRING", async () => {
    const res = await verifyPrimitiveForceInputAfterConnect(
      { from_node_id: 9, from_output: "STRING", to_node_id: 5, to_input: "lora_path" },
      jsonResult({ connected: true }),
      async (cmd) => {
        if (cmd.cmd === "graph_query") {
          return jsonResult({
            truncated: false,
            nodes: [
              { id: 9, type: "PrimitiveStringMultiline", widgets: { value: "foo" }, inputs: [] },
              FORCE_INPUT_TARGET,
            ],
          });
        }
        return textResult(`unexpected ${String(cmd.cmd)}`, true);
      },
    );
    expect(res.isError).toBeUndefined();
  });

  it("does not inspect a failed connect", async () => {
    const calls: Record<string, unknown>[] = [];
    const failed = textResult("Error: type mismatch", true);
    const res = await verifyPrimitiveForceInputAfterConnect(
      { from_node_id: 12, to_node_id: 5, to_input: "lora_path" },
      failed,
      async (cmd) => {
        calls.push(cmd);
        return jsonResult({});
      },
    );
    expect(res.isError).toBe(true);
    expect(allText(res)).toMatch(/type mismatch/);
    expect(calls).toEqual([]);
  });

  it("falls open on a truncated or unreadable detail probe", async () => {
    const connected = jsonResult({ connected: true });
    const truncated = await verifyPrimitiveForceInputAfterConnect(
      { from_node_id: 12, to_node_id: 5, to_input: "lora_path" },
      connected,
      async () => jsonResult({ truncated: true, nodes: [PRIMITIVE, FORCE_INPUT_TARGET] }),
    );
    expect(truncated.isError).toBeUndefined();

    const unreadable = await verifyPrimitiveForceInputAfterConnect(
      { from_node_id: 12, to_node_id: 5, to_input: "lora_path" },
      connected,
      async () => textResult("not json"),
    );
    expect(unreadable.isError).toBeUndefined();
  });
});

describe("panel_connect ships the PrimitiveNode forceInput guard (#2536)", () => {
  it("handlers dispatch through verifyPrimitiveForceInputAfterConnect", () => {
    expect(PANEL_SRC).toMatch(/verifyPrimitiveForceInputAfterConnect\(/);
    expect(PANEL_SRC).toMatch(/"panel_connect"/);
    expect(SERVICE_SRC).toMatch(/cmd: "graph_query"/);
    expect(SERVICE_SRC).toMatch(/cmd: "graph_disconnect"/);
    expect(SERVICE_SRC).toMatch(/PrimitiveStringMultiline/);
  });

  it("documents the PrimitiveNode forceInput refusal on the tool itself", () => {
    const description = defByName("panel_connect").description;
    expect(description).toContain("PrimitiveNode");
    expect(description).toContain("forceInput");
    expect(description).toContain("PrimitiveStringMultiline");
  });

  it("THE REPORTED CASE through the registered panel_connect handler", async () => {
    const calls: Record<string, unknown>[] = [];
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_connect") {
          return jsonResult({
            connected: { from_node_id: 12, to_node_id: 5, to_input: "lora_path" },
          });
        }
        if (cmd.cmd === "graph_query") {
          return jsonResult({ truncated: false, nodes: [PRIMITIVE, FORCE_INPUT_TARGET] });
        }
        if (cmd.cmd === "graph_disconnect") {
          return jsonResult({ disconnected: { node_id: cmd.node_id, input: cmd.input } });
        }
        return textResult(`unexpected ${String(cmd.cmd)}`, true);
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "wf:2536-reported",
    };

    const res = await defByName("panel_connect").handler(
      { from_node_id: 12, from_output: "STRING", to_node_id: 5, to_input: "lora_path" },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(allText(res)).toMatch(/PrimitiveStringMultiline/);
    expect(allText(res)).toMatch(/lora_path/);
    expect(allText(res)).toMatch(/#2536/);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_connect", "graph_query", "graph_disconnect"]);
  });
});
