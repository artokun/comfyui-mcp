// #2542 — panel_connect refuses PrimitiveNode wildcard output ("connect to
// widget input", type *) to LogicIF.when_true / when_false (also *).
// Both slots advertise *; the primitive is supposed to become typed via the
// downstream destination. Distinct from #2536 (forceInput-only STRING).
//
// Tests drive the shipped helpers AND the panel_connect wrap — a reimplementation
// here would stay green if the wrap were deleted.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  inferConcreteTypeFromNode,
  isForceInputOnlyStringSlot,
  isLiteGraphWildcardSlotType,
  parseLiveWildcardNodes,
  resolveLiveWildcardRetry,
  resolveWildcardConnectRetry,
  retryWildcardSlotConnect,
  wildcardToWildcardRefusal,
  type LiveWildcardNode,
  type LiveWildcardSlot,
} from "../../services/wildcard-slot-connect.js";
import { isTypeCompatible } from "../../services/slot-compat.js";
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
  fileURLToPath(new URL("../../services/wildcard-slot-connect.ts", import.meta.url)),
  "utf8",
);

const REPORTER_ERROR =
  "Error: Could not connect node 2741 (PrimitiveNode) → node 2740 (LogicIF).\n" +
  ' Node 2741 outputs: [0] "connect to widget input" (*)\n' +
  ' Node 2740 inputs: [0] "when_true" (*), [1] "when_false" (*)\n' +
  " No input on node 2740 accepts type *.";

const REQUESTED_LINE_ERROR =
  "Could not connect node 2741 (PrimitiveNode) → node 2740 (LogicIF).\n" +
  'Requested: from_output=auto → to_input="when_false".\n' +
  'Node 2741 outputs: [0] "connect to widget input" (*)\n' +
  'Node 2740 inputs:  [0] "when_true" (*), [1] "when_false" (*)\n' +
  "No input on node 2740 accepts type *. Tip: check wiring with panel_query_graph.";

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

function slot(partial: Partial<LiveWildcardSlot> & Pick<LiveWildcardSlot, "name">): LiveWildcardSlot {
  return {
    slot: 0,
    type: "*",
    widget: undefined,
    forceInput: false,
    ...partial,
  };
}

const PRIMITIVE: LiveWildcardNode = {
  id: "2741",
  type: "PrimitiveNode",
  widgets: null,
  widgetsKnown: true,
  inputs: [],
  outputs: [slot({ name: "connect to widget input", type: "*", slot: 0 })],
};

const LOGIC_IF = {
  id: 2740,
  type: "LogicIF",
  widgets: { boolean: true },
  inputs: [
    { slot: 0, name: "when_true", type: "*" },
    { slot: 1, name: "when_false", type: "*" },
    { slot: 2, name: "boolean", type: "BOOLEAN", widget: { name: "boolean" } },
  ],
  outputs: [{ slot: 0, name: "*", type: "*" }],
};

describe("wildcard-to-wildcard refusal parse (#2542)", () => {
  it("parses the reporter's exact panel sentence", () => {
    const refusal = wildcardToWildcardRefusal(REPORTER_ERROR);
    expect(refusal).not.toBeNull();
    expect(refusal?.outputs).toEqual([{ index: 0, name: "connect to widget input", type: "*" }]);
    expect(refusal?.inputs.map((s) => s.name)).toEqual(["when_true", "when_false"]);
    expect(refusal?.inputs.every((s) => isLiteGraphWildcardSlotType(s.type))).toBe(true);
  });

  it("parses the current slotDiagnostic form with a Requested line", () => {
    const refusal = wildcardToWildcardRefusal(REQUESTED_LINE_ERROR);
    expect(refusal?.inputs.map((s) => s.name)).toEqual(["when_true", "when_false"]);
  });

  it("does not treat a concrete type mismatch as wildcard-to-wildcard", () => {
    const text =
      "Could not connect node 4 (CheckpointLoaderSimple) → node 3 (KSampler).\n" +
      'Node 4 outputs: [0] "MODEL" (MODEL), [1] "CLIP" (CLIP)\n' +
      'Node 3 inputs:  [0] "model" (MODEL)\n' +
      "No input on node 3 accepts type CLIP.";
    expect(wildcardToWildcardRefusal(text)).toBeNull();
  });
});

describe("resolveWildcardConnectRetry", () => {
  it("names LogicIF.when_false when that slot was requested", () => {
    const refusal = wildcardToWildcardRefusal(REPORTER_ERROR);
    expect(refusal).not.toBeNull();
    expect(
      resolveWildcardConnectRetry(refusal!, {
        from_node_id: 2741,
        to_node_id: 2740,
        to_input: "when_false",
      }),
    ).toEqual({
      from_output: "connect to widget input",
      to_input: "when_false",
      via: "explicit",
      resolvedType: null,
    });
  });

  it("does not guess between two `*` inputs when to_input is omitted", () => {
    const refusal = wildcardToWildcardRefusal(REPORTER_ERROR);
    expect(refusal).not.toBeNull();
    expect(
      resolveWildcardConnectRetry(refusal!, { from_node_id: 2741, to_node_id: 2740 }),
    ).toBeNull();
  });
});

describe("live wildcard retry / #2536 guard", () => {
  it("infers a concrete type from a sibling widget slot", () => {
    const nodes = parseLiveWildcardNodes({ truncated: false, nodes: [PRIMITIVE, LOGIC_IF] });
    expect(nodes).not.toBeNull();
    const target = nodes!.find((n) => n.id === "2740");
    expect(inferConcreteTypeFromNode(target!)).toBe("BOOLEAN");
  });

  it("permits PrimitiveNode `*` → LogicIF.when_false `*`", () => {
    const nodes = parseLiveWildcardNodes({ truncated: false, nodes: [PRIMITIVE, LOGIC_IF] });
    const source = nodes!.find((n) => n.id === "2741")!;
    const target = nodes!.find((n) => n.id === "2740")!;
    const plan = resolveLiveWildcardRetry(
      source,
      target,
      { from_node_id: 2741, to_node_id: 2740, to_input: "when_false" },
      {
        from_output: "connect to widget input",
        to_input: "when_false",
        via: "explicit",
        resolvedType: null,
      },
    );
    expect(plan).toMatchObject({ to_input: "when_false", via: "explicit" });
    expect(isTypeCompatible("*", "*")).toBe(true);
  });

  it("uses typed-resolution when the destination slot is already concrete", () => {
    const source = PRIMITIVE;
    const target: LiveWildcardNode = {
      id: "2740",
      type: "LogicIF",
      widgets: {},
      widgetsKnown: true,
      inputs: [slot({ name: "when_false", type: "INT", slot: 1 })],
      outputs: [slot({ name: "INT", type: "INT", slot: 0 })],
    };
    const plan = resolveLiveWildcardRetry(
      source,
      target,
      { from_node_id: 2741, to_node_id: 2740, to_input: "when_false" },
      {
        from_output: "connect to widget input",
        to_input: "when_false",
        via: "explicit",
        resolvedType: null,
      },
    );
    expect(plan).toEqual({
      from_output: "connect to widget input",
      to_input: "when_false",
      via: "typed",
      resolvedType: "INT",
    });
  });

  it("does not retry PrimitiveNode onto a forceInput-only STRING", () => {
    expect(
      isForceInputOnlyStringSlot(
        slot({ name: "lora_path", type: "STRING", forceInput: true }),
        {},
        true,
      ),
    ).toBe(true);

    const target: LiveWildcardNode = {
      id: "5",
      type: "ApplyAnimaLoraFromPath",
      widgets: {},
      widgetsKnown: true,
      inputs: [slot({ name: "lora_path", type: "STRING", forceInput: true, slot: 0 })],
      outputs: [],
    };
    const plan = resolveLiveWildcardRetry(
      PRIMITIVE,
      target,
      { from_node_id: 2741, to_node_id: 5, to_input: "lora_path" },
      { from_output: "connect to widget input", to_input: "lora_path", via: "explicit", resolvedType: null },
    );
    expect(plan).toBeNull();
  });
});

describe("retryWildcardSlotConnect", () => {
  it("THE REPORTED CASE: PrimitiveNode `*` → LogicIF.when_false retries and lands", async () => {
    const calls: Record<string, unknown>[] = [];
    const res = await retryWildcardSlotConnect(
      { from_node_id: 2741, to_node_id: 2740, to_input: "when_false" },
      textResult(REPORTER_ERROR, true),
      async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_query") {
          return jsonResult({ truncated: false, nodes: [PRIMITIVE, LOGIC_IF] });
        }
        if (cmd.cmd === "graph_connect") {
          return jsonResult({
            connected: {
              from: { node_id: 2741, output: "connect to widget input" },
              to: { node_id: 2740, input: "when_false" },
            },
          });
        }
        return textResult(`unexpected ${String(cmd.cmd)}`, true);
      },
    );
    expect(res.isError).toBeUndefined();
    expect(allText(res)).toMatch(/#2542/);
    expect(allText(res)).toMatch(/wildcard-to-wildcard/);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_query", "graph_connect"]);
    expect(calls[1]).toMatchObject({
      cmd: "graph_connect",
      from_node_id: 2741,
      from_output: "connect to widget input",
      to_node_id: 2740,
      to_input: "when_false",
      auto_match: false,
    });
  });

  it("does not inspect a successful connect", async () => {
    const calls: Record<string, unknown>[] = [];
    const connected = jsonResult({ connected: true });
    const res = await retryWildcardSlotConnect(
      { from_node_id: 1, to_node_id: 2 },
      connected,
      async (cmd) => {
        calls.push(cmd);
        return jsonResult({});
      },
    );
    expect(JSON.parse(allText(res))).toEqual({ connected: true });
    expect(calls).toEqual([]);
  });

  it("does not guess when_true vs when_false when to_input is omitted", async () => {
    const calls: Record<string, unknown>[] = [];
    const res = await retryWildcardSlotConnect(
      { from_node_id: 2741, to_node_id: 2740 },
      textResult(REPORTER_ERROR, true),
      async (cmd) => {
        calls.push(cmd);
        return jsonResult({ connected: true });
      },
    );
    expect(res.isError).toBe(true);
    expect(allText(res)).toMatch(/accepts type \*/);
    expect(calls).toEqual([]);
  });

  it("leaves a CLIP mismatch alone", async () => {
    const calls: Record<string, unknown>[] = [];
    const failed = textResult("No input on node 3 accepts type CLIP.", true);
    const res = await retryWildcardSlotConnect(
      { from_node_id: 4, from_output: "CLIP", to_node_id: 3 },
      failed,
      async (cmd) => {
        calls.push(cmd);
        return jsonResult({});
      },
    );
    expect(res.isError).toBe(true);
    expect(allText(res)).toMatch(/accepts type CLIP/);
    expect(calls).toEqual([]);
  });

  it("retries from the diagnostic listing when the live probe is truncated", async () => {
    const res = await retryWildcardSlotConnect(
      { from_node_id: 2741, to_node_id: 2740, to_input: "when_false" },
      textResult(REPORTER_ERROR, true),
      async (cmd) => {
        if (cmd.cmd === "graph_query") {
          return jsonResult({ truncated: true, nodes: [PRIMITIVE, LOGIC_IF] });
        }
        return jsonResult({ connected: true });
      },
    );
    expect(res.isError).toBeUndefined();
    expect(allText(res)).toMatch(/#2542/);
  });
});

describe("panel_connect ships the wildcard-to-wildcard retry (#2542)", () => {
  it("handlers dispatch through retryWildcardSlotConnect", () => {
    expect(PANEL_SRC).toMatch(/retryWildcardSlotConnect\(/);
    expect(PANEL_SRC).toMatch(/retryConnectAgainstLiveGraph\(/);
    expect(PANEL_SRC).toMatch(/"panel_connect"/);
    expect(SERVICE_SRC).toMatch(/cmd: "graph_query"/);
    expect(SERVICE_SRC).toMatch(/cmd: "graph_connect"/);
    expect(SERVICE_SRC).toMatch(/auto_match: false/);
  });

  it("documents wildcard-to-wildcard on the tool itself", () => {
    const description = defByName("panel_connect").description;
    expect(description).toContain("wildcard-to-wildcard");
    expect(description).toContain("PrimitiveNode");
    expect(description).toContain("LogicIF");
  });

  it("THE REPORTED CASE through the registered panel_connect handler", async () => {
    const calls: Record<string, unknown>[] = [];
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_connect") {
          if (cmd.auto_match === false && cmd.to_input === "when_false") {
            return jsonResult({
              connected: {
                from: { node_id: 2741, output: "connect to widget input" },
                to: { node_id: 2740, input: "when_false" },
              },
            });
          }
          return textResult(REPORTER_ERROR, true);
        }
        if (cmd.cmd === "graph_query") {
          return jsonResult({ truncated: false, nodes: [PRIMITIVE, LOGIC_IF] });
        }
        return textResult(`unexpected ${String(cmd.cmd)}`, true);
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "wf:2542-reported",
    };

    const res = await defByName("panel_connect").handler(
      { from_node_id: 2741, to_node_id: 2740, to_input: "when_false" },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(allText(res)).toMatch(/#2542/);
    // graph_connect + #2542 live probe + explicit retry, then #2536 STRING-only verify.
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_connect",
      "graph_query",
      "graph_connect",
      "graph_query",
    ]);
    expect(calls[2]).toMatchObject({
      from_output: "connect to widget input",
      to_input: "when_false",
      auto_match: false,
    });
  });
});
