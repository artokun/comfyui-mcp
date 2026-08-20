// #1846 — panel_open_workflow reported unknown because the canvas differed from
// the loaded state on `definitions` after unknown placeholders rehydrated.
//
// The open bound the requested workflow; a later outline/query showed the right
// nodes with real schemas. Verification was treating node-definition / widget-
// schema normalization as a failed open.
//
// Tests drive panel_open_workflow. Dest file comes through the same userdata
// read that handler uses; live canvas comes from graph_serialize.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";
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

const TAB = "wf:workflows/rehydrate.json";
const PATH = "workflows/rehydrate.json";
const LIVE = "77777777-7777-4777-8777-777777777777";
const PRIOR = "11111111-1111-4111-8111-111111111111";
const SG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const DEFINITIONS_ONLY =
  `workflow_open RAN and the canvas IS bound to ${PATH} — that much was proven — but the graph ` +
  `does not match the state that was loaded. Specifically: definitions.`;

function destGraph(opts?: {
  innerType?: string;
  innerWidgets?: unknown[];
  links?: unknown[];
  extraNode?: Record<string, unknown>;
}) {
  const innerType = opts?.innerType ?? "CustomPackNode";
  const innerWidgets = opts?.innerWidgets ?? ["ckpt.safetensors"];
  const links = opts?.links ?? [
    [1, 1, 0, 2, 0, "IMAGE"],
    [2, 2, 0, 3, 0, "IMAGE"],
  ];
  const nodes: Array<Record<string, unknown>> = [
    {
      id: 1,
      type: "LoadImage",
      widgets_values: ["photo.png"],
      widgets_values_named: { image: "photo.png" },
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
    links,
    extra: { comfyui_mcp: { workflow_path: PATH, workflow_uuid: LIVE } },
    definitions: {
      subgraphs: [
        {
          id: SG_ID,
          name: "Inner",
          nodes: [
            {
              id: 10,
              type: innerType,
              widgets_values: innerWidgets,
              inputs: [],
              outputs: [],
            },
          ],
          links: [],
        },
      ],
    },
  };
}

function liveGraph(opts?: { innerType?: string; innerWidgets?: unknown[]; links?: unknown[] }) {
  const innerType = opts?.innerType ?? "CustomPackNode";
  const innerWidgets = opts?.innerWidgets ?? ["ckpt.safetensors"];
  const links = opts?.links ?? [
    [1, 1, 0, 2, 0, "IMAGE"],
    [2, 2, 0, 3, 0, "IMAGE"],
  ];
  return {
    nodes: [
      {
        id: 1,
        type: "LoadImage",
        widgets_values: ["photo.png"],
        widgets_values_named: { image: "photo.png" },
      },
      { id: 2, type: SG_ID, widgets_values: [] },
      {
        id: 3,
        type: "SaveImage",
        widgets_values: ["out"],
        widgets_values_named: { filename_prefix: "out" },
      },
    ],
    links,
    extra: { comfyui_mcp: { workflow_path: PATH, workflow_uuid: LIVE } },
    definitions: {
      subgraphs: [
        {
          id: SG_ID,
          name: "Inner",
          nodes: [
            {
              id: 10,
              type: innerType,
              size: [280, 140],
              order: 2,
              properties: { "Node name for S&R": innerType },
              widgets_values: innerWidgets,
              widgets_values_named: { ckpt_name: innerWidgets[0] },
              inputs: [{ name: "image", type: "IMAGE", link: null }],
              outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
            },
          ],
          links: [],
          state: { lastNodeId: 14, lastLinkId: 3 },
        },
      ],
    },
  };
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
      if (cmd.cmd === "workflow_open") throw new Error(DEFINITIONS_ONLY);
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
    tabs: () => [{ tab_id: TAB, title: "rehydrate", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: (_t: string, uuid: string) => {
      calls.push(`adopt:${uuid}`);
      stamp = uuid;
      return true;
    },
    workflowUuidFor: () => ({ known: Boolean(stamp), uuid: stamp }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  return { b, calls, stampOf: () => stamp };
}

beforeEach(() => {
  destByKey.clear();
  const qm = QueueMonitor as unknown as { state: { runningPromptId: string | null } };
  qm.state.runningPromptId = null;
});

afterEach(() => {
  destByKey.clear();
  const qm = QueueMonitor as unknown as { state: { runningPromptId: string | null } };
  qm.state.runningPromptId = null;
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
  const res: ToolResult = await def.handler({ path: PATH } as never, ctx);
  return {
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    isError: res.isError === true,
    calls,
    stamp: stampOf(),
  };
}

describe("panel_open_workflow ignores definition/schema normalization after rehydrate (#1846)", () => {
  it("the reporter's case: definitions-only mismatch after placeholder rehydration succeeds", async () => {
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

  it("an unknown placeholder type rehydrated to the real class is still dest", async () => {
    const { isError } = await openWorkflow({
      dest: destGraph({ innerType: "Unknown" }),
      live: liveGraph({ innerType: "CustomPackNode" }),
      graphQuery: "mismatch",
    });

    expect(isError).toBe(false);
  });

  it("a dest widget value the live graph does not hold stays unknown", async () => {
    const { isError, text, calls } = await openWorkflow({
      dest: destGraph({ innerWidgets: ["ckpt.safetensors"] }),
      live: liveGraph({ innerWidgets: ["other.safetensors"] }),
      graphQuery: "mismatch",
    });

    expect(isError).toBe(true);
    expect(calls.map((c) => c)).toContain("graph_serialize");
    expect(text).not.toMatch(/content_normalized/);
    expect(text).toMatch(/definitions/);
  });

  it("a rewired dest link stays unknown", async () => {
    const { isError, text } = await openWorkflow({
      dest: destGraph({
        links: [
          [1, 1, 0, 2, 0, "IMAGE"],
          [2, 2, 0, 3, 0, "IMAGE"],
        ],
      }),
      live: liveGraph({
        links: [
          [1, 1, 0, 3, 0, "IMAGE"],
          [2, 2, 0, 3, 0, "IMAGE"],
        ],
      }),
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
