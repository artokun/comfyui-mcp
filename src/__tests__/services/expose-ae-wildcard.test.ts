// #2493 — panel_expose_subgraph_input misses Anything Everywhere?'s wildcard
// after Convert to Subgraph. The panel's name lookup lists widget sockets
// (group_regex); the live LiteGraph array still carries the frontend wildcard
// as a display label / unique `*` slot. Tests drive the shipped resolver AND
// the handler wrap — a reimplementation in this file would stay green if the
// wrap were deleted.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  extraLiveWildcardIndexNote,
  liveExposeNodeFromQuery,
  liveNamesMatchAvailable,
  missingAeWildcardNote,
  missingInputSlotRefusal,
  resolveExposeInputAgainstLiveSlots,
  retryExposeSubgraphInput,
  type LiveInputSlot,
} from "../../services/expose-ae-wildcard.js";
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
  fileURLToPath(new URL("../../services/expose-ae-wildcard.ts", import.meta.url)),
  "utf8",
);

const REPORTER_ERROR =
  'Error: No input slot named "anything" (available: group_regex)';

const REPORTER_LIVE: LiveInputSlot = {
  slot: 0,
  name: "group_regex",
  label: "anything",
  localized_name: null,
  type: "*",
};

function slot(partial: Partial<LiveInputSlot> & Pick<LiveInputSlot, "slot" | "name">): LiveInputSlot {
  return {
    label: null,
    localized_name: null,
    type: null,
    ...partial,
  };
}

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

describe("missingInputSlotRefusal (#2493)", () => {
  it("parses the reporter's exact panel sentence", () => {
    expect(missingInputSlotRefusal(REPORTER_ERROR)).toEqual({
      requested: "anything",
      available: ["group_regex"],
    });
  });

  it("treats available: none as an empty list", () => {
    expect(missingInputSlotRefusal('No input slot named "pixels" (available: none)')).toEqual({
      requested: "pixels",
      available: [],
    });
  });

  it("returns null for a different refusal", () => {
    expect(missingInputSlotRefusal("Must be inside a subgraph")).toBeNull();
  });
});

describe("liveExposeNodeFromQuery", () => {
  const node = {
    id: 1310,
    type: "Anything Everywhere?",
    inputs: [{ slot: 0, name: "group_regex", label: "anything", type: "*" }],
  };

  it("reads a nodes[] wrapper", () => {
    expect(liveExposeNodeFromQuery({ nodes: [node] }, 1310)).toEqual({
      id: "1310",
      type: "Anything Everywhere?",
      inputs: [REPORTER_LIVE],
    });
  });

  it("reads JSONL in text, the current panel detail shape", () => {
    expect(liveExposeNodeFromQuery({ text: JSON.stringify(node) }, "1310")?.inputs[0]?.label).toBe(
      "anything",
    );
  });

  it("ignores a different node id", () => {
    expect(liveExposeNodeFromQuery({ nodes: [node] }, 9)).toBeNull();
  });
});

describe("resolveExposeInputAgainstLiveSlots", () => {
  it("THE REPORTED CASE: label anything on a unique * slot named group_regex", () => {
    expect(
      resolveExposeInputAgainstLiveSlots({
        requested: "anything",
        available: ["group_regex"],
        nodeType: "Anything Everywhere?",
        inputs: [REPORTER_LIVE],
      }),
    ).toEqual({ to_input: "group_regex", via: "label", slot: 0, name: "group_regex" });
  });

  it("does not expose a STRING widget socket as the virtual bus", () => {
    expect(
      resolveExposeInputAgainstLiveSlots({
        requested: "anything",
        available: ["group_regex"],
        nodeType: "Anything Everywhere?",
        inputs: [slot({ slot: 0, name: "group_regex", label: "anything", type: "STRING" })],
      }),
    ).toBeNull();
  });

  it("maps a unique * wildcard by type when the requested name is anything", () => {
    expect(
      resolveExposeInputAgainstLiveSlots({
        requested: "anything",
        available: ["ue_in"],
        nodeType: "Anything Everywhere",
        inputs: [slot({ slot: 0, name: "ue_in", type: "*" })],
      }),
    ).toEqual({ to_input: "ue_in", via: "wildcard", slot: 0, name: "ue_in" });
  });

  it("does not guess among Anything Everywhere3's three * slots", () => {
    expect(
      resolveExposeInputAgainstLiveSlots({
        requested: "anything",
        available: ["anything", "anything2", "anything3"],
        nodeType: "Anything Everywhere3",
        inputs: [
          slot({ slot: 0, name: "anything", type: "*" }),
          slot({ slot: 1, name: "anything2", type: "*" }),
          slot({ slot: 2, name: "anything3", type: "*" }),
        ],
      }),
    ).toEqual({ to_input: "anything", via: "wildcard", slot: 0, name: "anything" });
  });

  it("refuses an index remap when live names are not the panel's available list", () => {
    expect(
      resolveExposeInputAgainstLiveSlots({
        requested: "anything",
        available: ["group_regex"],
        nodeType: "Anything Everywhere?",
        inputs: [
          slot({ slot: 0, name: "anything", type: "*" }),
          slot({ slot: 1, name: "group_regex", type: "STRING" }),
        ],
      }),
    ).toBeNull();
  });

  it("is case-insensitive on labels", () => {
    expect(
      resolveExposeInputAgainstLiveSlots({
        requested: "Anything",
        available: ["group_regex"],
        nodeType: "Anything Everywhere?",
        inputs: [slot({ slot: 0, name: "group_regex", label: "ANYTHING", type: "*" })],
      })?.to_input,
    ).toBe("group_regex");
  });

  it("matches localized_name when label is absent", () => {
    expect(
      resolveExposeInputAgainstLiveSlots({
        requested: "anything",
        available: ["group_regex"],
        nodeType: "Anything Everywhere?",
        inputs: [slot({ slot: 0, name: "group_regex", localized_name: "anything", type: "*" })],
      })?.to_input,
    ).toBe("group_regex");
  });
});

describe("disclosure notes", () => {
  it("names the live * index when the panel listed a different array", () => {
    const note = extraLiveWildcardIndexNote("anything", ["group_regex"], {
      id: "1310",
      type: "Anything Everywhere?",
      inputs: [
        slot({ slot: 0, name: "anything", type: "*" }),
        slot({ slot: 1, name: "group_regex", type: "STRING" }),
      ],
    });
    expect(note).toMatch(/to_input:0/);
    expect(note).toMatch(/#2493/);
    expect(liveNamesMatchAvailable(["group_regex"], [slot({ slot: 0, name: "anything", type: "*" })])).toBe(
      false,
    );
  });

  it("says the wildcard is gone when live inputs are only widget sockets", () => {
    const note = missingAeWildcardNote("anything", ["group_regex"], {
      id: "1310",
      type: "Anything Everywhere?",
      inputs: [slot({ slot: 0, name: "group_regex", label: "anything", type: "STRING" })],
    });
    expect(note).toMatch(/no wildcard/);
    expect(note).toMatch(/group_regex/);
    expect(note).toMatch(/#2493/);
  });

  it("does not attach the AE note to an unrelated missing slot", () => {
    expect(
      missingAeWildcardNote("pixels", ["image"], {
        id: "2",
        type: "VAEDecode",
        inputs: [slot({ slot: 0, name: "samples", type: "LATENT" })],
      }),
    ).toBeNull();
  });
});

describe("retryExposeSubgraphInput", () => {
  it("forwards a successful expose with no extra query", async () => {
    const calls: Record<string, unknown>[] = [];
    const res = await retryExposeSubgraphInput({ to_node_id: 9, to_input: "model" }, async (cmd) => {
      calls.push(cmd);
      return jsonResult({ exposed: { name: "model" } });
    });
    expect(calls).toEqual([
      { cmd: "graph_expose_subgraph_input", to_node_id: 9, to_input: "model", name: undefined },
    ]);
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(allText(res))).toEqual({ exposed: { name: "model" } });
  });

  it("retries the reporter's label with the addressable live name", async () => {
    const calls: Record<string, unknown>[] = [];
    const res = await retryExposeSubgraphInput(
      { to_node_id: 1310, to_input: "anything", name: "bus" },
      async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_expose_subgraph_input" && cmd.to_input === "anything") {
          return textResult(REPORTER_ERROR, true);
        }
        if (cmd.cmd === "graph_query") {
          return jsonResult({
            nodes: [
              {
                id: 1310,
                type: "Anything Everywhere?",
                inputs: [{ slot: 0, name: "group_regex", label: "anything", type: "*" }],
              },
            ],
          });
        }
        if (cmd.cmd === "graph_expose_subgraph_input" && cmd.to_input === "group_regex") {
          return jsonResult({ exposed: { name: "bus", to: { node_id: 1310, input: "group_regex" } } });
        }
        return textResult("unexpected", true);
      },
    );
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_expose_subgraph_input",
      "graph_query",
      "graph_expose_subgraph_input",
    ]);
    expect(calls[2]).toMatchObject({
      cmd: "graph_expose_subgraph_input",
      to_node_id: 1310,
      to_input: "group_regex",
      name: "bus",
    });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0]!.text!)).toMatchObject({ exposed: { name: "bus" } });
    expect(allText(res)).toMatch(/#2493/);
    expect(allText(res)).toMatch(/group_regex/);
  });

  it("does not retry a STRING widget socket labelled anything", async () => {
    const calls: Record<string, unknown>[] = [];
    const res = await retryExposeSubgraphInput({ to_node_id: 1310, to_input: "anything" }, async (cmd) => {
      calls.push(cmd);
      if (cmd.cmd === "graph_expose_subgraph_input") return textResult(REPORTER_ERROR, true);
      return jsonResult({
        nodes: [
          {
            id: 1310,
            type: "Anything Everywhere?",
            inputs: [{ slot: 0, name: "group_regex", label: "anything", type: "STRING" }],
          },
        ],
      });
    });
    expect(calls.map((c) => c.cmd)).toEqual(["graph_expose_subgraph_input", "graph_query"]);
    expect(res.isError).toBe(true);
    expect(allText(res)).toContain(REPORTER_ERROR);
    expect(allText(res)).toMatch(/no wildcard/);
  });

  it("leaves a numeric to_input refusal alone", async () => {
    const calls: Record<string, unknown>[] = [];
    const res = await retryExposeSubgraphInput({ to_node_id: 1310, to_input: 0 }, async (cmd) => {
      calls.push(cmd);
      return textResult("input slot index 0 out of range (node has 0)", true);
    });
    expect(calls).toHaveLength(1);
    expect(res.isError).toBe(true);
    expect(allText(res)).not.toMatch(/#2493/);
  });
});

describe("panel_expose_subgraph_input attaches the #2493 retry", () => {
  it("the handler calls the shipped retry, not a copy", () => {
    expect(PANEL_SRC).toMatch(/retryExposeSubgraphInput\(/);
    expect(PANEL_SRC).toMatch(/#2493/);
    expect(SERVICE_SRC).toMatch(/cmd: "graph_expose_subgraph_input"/);
    expect(SERVICE_SRC).toMatch(/cmd: "graph_query"/);
  });

  it("the description names the live-slot remap", () => {
    const def = defByName("panel_expose_subgraph_input");
    expect(def.description).toMatch(/#2493/);
    expect(def.description).toMatch(/Anything Everywhere\?/);
    expect(def.description).toMatch(/live LiteGraph/);
    expect(def.description).toMatch(/STRING widget/);
  });

  it("THE REPORTED CASE reaches the retry through the registered handler", async () => {
    const calls: Record<string, unknown>[] = [];
    const ctx: PanelToolCtx = {
      call: async (cmd) => {
        calls.push(cmd);
        if (cmd.cmd === "graph_expose_subgraph_input" && cmd.to_input === "anything") {
          return textResult(REPORTER_ERROR, true);
        }
        if (cmd.cmd === "graph_query") {
          return jsonResult({
            nodes: [
              {
                id: 1310,
                type: "Anything Everywhere?",
                inputs: [{ slot: 0, name: "group_regex", label: "anything", type: "*" }],
              },
            ],
          });
        }
        return jsonResult({ exposed: { name: "anything", to: { node_id: 1310, input: "group_regex" } } });
      },
      confirm: async () => "yes" as const,
      bridge: {} as PanelToolCtx["bridge"],
      tabId: "test-tab",
    };
    const res = await defByName("panel_expose_subgraph_input").handler(
      { to_node_id: 1310, to_input: "anything" },
      ctx,
    );
    expect(calls[0]).toMatchObject({
      cmd: "graph_expose_subgraph_input",
      to_node_id: 1310,
      to_input: "anything",
    });
    expect(calls[2]).toMatchObject({
      cmd: "graph_expose_subgraph_input",
      to_input: "group_regex",
    });
    expect(res.isError).toBeUndefined();
    expect(allText(res)).toMatch(/#2493/);
  });
});
