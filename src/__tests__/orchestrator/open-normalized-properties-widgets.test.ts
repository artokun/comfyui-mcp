// #2494 — panel_open_workflow switched to an already-open workflow, proved
// identity, and then reported Error because per-node ue_properties / widget
// representations differed after frontend configure. A later graph_outline
// showed the same node ids/types. A successful tab switch with only
// frontend-owned bags rewritten is not an unknown open.
//
// Tests drive panel_open_workflow. Dest file comes through the same userdata
// read that handler uses; live canvas comes from graph_serialize. Matcher
// cases pin openLiveMatchesDestAfterReconnect (the handler-used additive
// matcher) so a later wiring change cannot pass by skipping dest-vs-live.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";
import {
  openLiveMatchesDestAfterReconnect,
  openLiveMatchesDestContent,
} from "../../orchestrator/open-identity-normalization.js";
import { QueueMonitor } from "../../services/queue-monitor.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const destByKey = new Map<string, Record<string, unknown>>();

vi.mock("../../services/userdata-library.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/userdata-library.js")>();
  return {
    ...actual,
    userdataFetch: async (route: string) => {
      for (const [key, graph] of destByKey) {
        if (route.includes(encodeURIComponent(key)) || route.includes(key)) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(graph),
          } as Response;
        }
      }
      throw new Error(`no dest fixture for ${route}`);
    },
  };
});

const { buildPanelToolDefs, makePanelToolCtx } = await import("../../orchestrator/panel-tools.js");

const TAB = "wf:workflows/ue.json";
const PATH = "workflows/ue.json";
const LIVE = "77777777-7777-4777-8777-777777777777";
const PRIOR = "11111111-1111-4111-8111-111111111111";
const SG_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROMPT = "a cinematic portrait of a woman in gold light";

const UE_ONLY =
  `workflow_open RAN and the canvas IS bound to ${PATH} — that much was proven — but the graph ` +
  `on it does not match the state that was loaded, and every node that was loaded is on it with ` +
  `the same id and type, and nothing extra appeared — no node was lost. What differs is per-node ` +
  `(properties, widgets_values_named); within properties, the keys that differ are: ue_properties. ` +
  `You are on the right workflow. You are NOT on the wrong workflow: ${PATH} IS the active one. ` +
  `This reply carries NO fence refresh.`;

const DEST_UE = {
  widget_ue_connectable: {},
  input_ue_unconnectable: {},
};
const LIVE_UE = {
  widget_ue_connectable: {},
  input_ue_unconnectable: {},
  version: "7.8",
};

function destGraph(opts?: { prompt?: string; extraNode?: Record<string, unknown> }) {
  const prompt = opts?.prompt ?? PROMPT;
  const nodes: Array<Record<string, unknown>> = [
    {
      id: 1,
      type: "CLIPTextEncode",
      properties: { ue_properties: DEST_UE },
      widgets_values: [prompt],
      widgets_values_named: { text: prompt, clip: "" },
    },
    { id: 2, type: SG_ID, widgets_values: [] },
    {
      id: 3,
      type: "SaveImage",
      widgets_values: ["out"],
      widgets_values_named: { filename_prefix: "out" },
    },
  ];
  if (opts?.extraNode) nodes.push(opts.extraNode);
  return {
    nodes,
    links: [
      [1, 1, 0, 2, 0, "CONDITIONING"],
      [2, 2, 0, 3, 0, "IMAGE"],
    ],
    extra: { comfyui_mcp: { workflow_path: PATH, workflow_uuid: LIVE } },
    definitions: {
      subgraphs: [
        {
          id: SG_ID,
          name: "Inner",
          nodes: [
            {
              id: 10,
              type: "KSampler",
              properties: { ue_properties: DEST_UE },
              widgets_values: [123, "randomize", 20],
              widgets_values_named: { seed: 123, control_after_generate: "randomize", steps: 20 },
            },
          ],
          links: [],
        },
      ],
    },
  };
}

function liveGraph(opts?: { prompt?: string; omitDefinitions?: boolean }) {
  const prompt = opts?.prompt ?? PROMPT;
  const graph: Record<string, unknown> = {
    nodes: [
      {
        id: 1,
        type: "CLIPTextEncode",
        size: [280, 140],
        properties: { ue_properties: LIVE_UE, "Node name for S&R": "CLIPTextEncode" },
        widgets_values: [prompt],
        widgets_values_named: { text: prompt },
      },
      { id: 2, type: SG_ID, widgets_values: [] },
      {
        id: 3,
        type: "SaveImage",
        widgets_values: ["out", "extra-frontend-slot"],
        widgets_values_named: { filename_prefix: "out", extra: "frontend" },
      },
    ],
    links: [
      [1, 1, 0, 2, 0, "CONDITIONING"],
      [2, 2, 0, 3, 0, "IMAGE"],
    ],
    extra: { comfyui_mcp: { workflow_path: PATH, workflow_uuid: LIVE } },
  };
  if (!opts?.omitDefinitions) {
    graph.definitions = {
      subgraphs: [
        {
          id: SG_ID,
          name: "Inner",
          nodes: [
            {
              id: 10,
              type: "KSampler",
              properties: { ue_properties: LIVE_UE },
              widgets_values: [123, "randomize", 20, 7.5],
              widgets_values_named: {
                seed: 123,
                control_after_generate: "randomize",
                steps: 20,
                cfg: 7.5,
              },
            },
          ],
          links: [],
        },
      ],
    };
  }
  return graph;
}

type GraphQuery = "answers" | "mismatch";

function bridge(opts: { live: Record<string, unknown>; graphQuery: GraphQuery }) {
  const calls: string[] = [];
  let stamp: string | undefined = PRIOR;
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push(String(cmd.cmd));
      if (cmd.cmd === "workflow_list") {
        const active = { path: PATH, routing_key: `wf:${PATH}`, workflow_uuid: LIVE };
        return { active, workflows: [{ ...active, active: true }], active_confirmed: true };
      }
      if (cmd.cmd === "workflow_open") throw new Error(UE_ONLY);
      if (cmd.cmd === "graph_query") {
        if (opts.graphQuery === "mismatch") {
          throw new Error(
            `workflow instance mismatch: issued for workflow instance ${PRIOR} but canvas is ${LIVE}`,
          );
        }
        return { ids: [1, 2, 3], node_count: 3 };
      }
      if (cmd.cmd === "graph_serialize") {
        return { workflow: opts.live, node_count: 3 };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "ue", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: (_t: string, uuid: string) => {
      calls.push(`adopt:${uuid}`);
      stamp = uuid;
      return true;
    },
    workflowUuidFor: () => ({ known: Boolean(stamp), uuid: stamp }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as PanelToolCtx["bridge"];
  return { b, calls, stampOf: () => stamp };
}

type QueueMonitorIdle = { state: { runningPromptId: string | null } };

function setQueueIdle(): void {
  (QueueMonitor as QueueMonitorIdle).state.runningPromptId = null;
}

beforeEach(() => {
  destByKey.clear();
  setQueueIdle();
});

afterEach(() => {
  destByKey.clear();
  setQueueIdle();
});

async function openWorkflow(opts: {
  dest: Record<string, unknown>;
  live: Record<string, unknown>;
  graphQuery: GraphQuery;
}) {
  destByKey.set(PATH, opts.dest);
  const { b, calls, stampOf } = bridge({ live: opts.live, graphQuery: opts.graphQuery });
  const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_open_workflow");
  if (!def) throw new Error("panel_open_workflow is not registered");
  const res: ToolResult = await def.handler({ path: PATH }, ctx);
  return {
    text: res.content.map((c) => ("text" in c ? (c.text ?? "") : "")).join(" "),
    isError: res.isError === true,
    calls,
    stamp: stampOf(),
  };
}

describe("openLiveMatchesDestAfterReconnect ignores frontend-owned ue_properties / widget representations (#2494)", () => {
  it("matches when only ue_properties and named widget bags differ", () => {
    expect(openLiveMatchesDestAfterReconnect(liveGraph(), destGraph())).toBe(true);
  });

  it("matches dest positional widgets against a live named-only serialize", () => {
    const dest = {
      nodes: [{ id: 1, type: "CLIPTextEncode", widgets_values: [PROMPT] }],
      links: [],
    };
    const live = {
      nodes: [{ id: 1, type: "CLIPTextEncode", widgets_values: { text: PROMPT } }],
      links: [],
    };
    expect(openLiveMatchesDestContent(live, dest)).toBe(false);
    expect(openLiveMatchesDestAfterReconnect(live, dest)).toBe(true);
  });

  it("matches when live serialize omits nested subgraph definitions", () => {
    expect(openLiveMatchesDestContent(liveGraph({ omitDefinitions: true }), destGraph())).toBe(false);
    expect(openLiveMatchesDestAfterReconnect(liveGraph({ omitDefinitions: true }), destGraph())).toBe(true);
  });

  it("does not match a dest widget value the live graph does not hold", () => {
    expect(openLiveMatchesDestAfterReconnect(liveGraph({ prompt: "other prompt" }), destGraph())).toBe(false);
  });
});

describe("panel_open_workflow ignores ue_properties / widget representation after a tab switch (#2494)", () => {
  it("the reporter's case: identity-proven ue_properties mismatch of an already-open graph succeeds", async () => {
    const { text, isError, calls, stamp } = await openWorkflow({
      dest: destGraph(),
      live: liveGraph(),
      graphQuery: "mismatch",
    });

    expect(isError).toBe(false);
    expect(calls).toContain("graph_serialize");
    expect(stamp).toBe(LIVE);
    expect(text).toMatch(/content_normalized/);
    expect(text).toMatch(/Opened/);
    expect(text).not.toMatch(/Treat the canvas as UNKNOWN/);
    expect(text).not.toMatch(/PREVIOUS workflow/);
  });

  it("the same dest is accepted when the prior fence still answers", async () => {
    const { isError, text } = await openWorkflow({
      dest: destGraph(),
      live: liveGraph(),
      graphQuery: "answers",
    });

    expect(isError).toBe(false);
    expect(text).toMatch(/content_normalized/);
  });

  it("an omitted live subgraph definition is still dest after a successful switch", async () => {
    const { isError, text } = await openWorkflow({
      dest: destGraph(),
      live: liveGraph({ omitDefinitions: true }),
      graphQuery: "mismatch",
    });

    expect(isError).toBe(false);
    expect(text).toMatch(/content_normalized/);
  });

  it("a dest widget value the live graph does not hold stays unknown", async () => {
    const { isError, text } = await openWorkflow({
      dest: destGraph(),
      live: liveGraph({ prompt: "the SOURCE prompt still on the previous graph" }),
      graphQuery: "mismatch",
    });

    expect(isError).toBe(true);
    expect(text).not.toMatch(/content_normalized/);
  });

  it("a dest node missing from the live canvas stays unknown", async () => {
    const { isError, text } = await openWorkflow({
      dest: destGraph({ extraNode: { id: 99, type: "Note", widgets_values: ["keep"] } }),
      live: liveGraph(),
      graphQuery: "mismatch",
    });

    expect(isError).toBe(true);
    expect(text).not.toMatch(/content_normalized/);
  });
});
