// #2501 — after a ComfyUI restart, panel_list_workflows showed the saved
// workflow already active. panel_open_workflow of that same path returned a
// workflow_open error because dest-vs-live treated frontend-normalized per-node
// fields (inputs/outputs/properties/widgets_values/widgets_values_named) as a
// failed load, while proving every loaded node had the same id/type and nothing
// extra appeared. A later panel_graph_outline showed the expected graph.
//
// Tests drive panel_open_workflow and the shipped dest-vs-live matchers. Dest
// file comes through the same userdata read the handler uses; live canvas comes
// from graph_serialize.

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

const { buildPanelToolDefs, makePanelToolCtx, __openWorkflowTestHooks } = await import(
  "../../orchestrator/panel-tools.js"
);

const TAB = "wf:workflows/custom.json";
const PATH = "workflows/custom.json";
const LIVE = "77777777-7777-4777-8777-777777777777";
const PRIOR = "11111111-1111-4111-8111-111111111111";
const CKPT = "ckpt.safetensors";

const IDENTITY_PROVEN =
  `workflow_open RAN and the canvas IS bound to ${PATH} — that much was proven — but the graph ` +
  `on it does not match the state that was loaded. It reports differences in nodes, links, ` +
  `inputs, outputs, properties, widgets_values and widgets_values_named, while also stating ` +
  `every loaded node is present with the same id/type and nothing extra appeared. You are NOT ` +
  `on the wrong workflow: ${PATH} IS the active one. This reply carries NO fence refresh.`;

type QueueMonitorIdle = { state: { runningPromptId: string | null } };

function setQueueIdle(): void {
  (QueueMonitor as QueueMonitorIdle).state.runningPromptId = null;
}

function destGraph(opts?: { ckpt?: string; extraNode?: Record<string, unknown>; links?: unknown[] }) {
  const ckpt = opts?.ckpt ?? CKPT;
  const nodes: Array<Record<string, unknown>> = [
    {
      id: 1,
      type: "CustomPackNode",
      widgets_values: [ckpt, 20],
      widgets_values_named: { ckpt_name: ckpt, steps: 20, unused_schema: "" },
    },
    {
      id: 2,
      type: "SaveImage",
      widgets_values: ["out"],
      widgets_values_named: { filename_prefix: "out" },
    },
  ];
  if (opts?.extraNode) nodes.push(opts.extraNode);
  return {
    nodes,
    links: opts?.links ?? [[1, 1, 0, 2, 0, "IMAGE"]],
    extra: { comfyui_mcp: { workflow_path: PATH, workflow_uuid: LIVE } },
  };
}

function liveGraph(opts?: { ckpt?: string; links?: unknown[] }) {
  const ckpt = opts?.ckpt ?? CKPT;
  return {
    nodes: [
      {
        id: 1,
        type: "CustomPackNode",
        size: [280, 140],
        order: 0,
        properties: {
          "Node name for S&R": "CustomPackNode",
          ue_properties: { version: "7.8", widget_ue_connectable: {} },
        },
        widgets_values: [
          { name: "ckpt_name", type: "combo", value: ckpt },
          { name: "steps", type: "int", value: "20" },
          { name: "cfg", type: "float", value: 7.5 },
        ],
        widgets_values_named: {
          ckpt_name: { name: "ckpt_name", type: "combo", value: ckpt },
          steps: "20",
          cfg: 7.5,
        },
        inputs: [{ name: "model", type: "MODEL", link: null }],
        outputs: [{ name: "IMAGE", type: "IMAGE", links: [1] }],
      },
      {
        id: 2,
        type: "SaveImage",
        widgets_values: ["out", ""],
        widgets_values_named: { filename_prefix: "out", extra: "" },
      },
    ],
    links: opts?.links ?? [
      { id: 1, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0, type: "IMAGE" },
    ],
    extra: { comfyui_mcp: { workflow_path: PATH, workflow_uuid: LIVE } },
  };
}

type GraphQuery = "answers" | "mismatch";

function bridge(opts: {
  live: Record<string, unknown>;
  graphQuery: GraphQuery;
  stamp?: string;
  unconfirmedLists?: number;
}) {
  const calls: string[] = [];
  let stamp: string | undefined = opts.stamp ?? LIVE;
  let listCalls = 0;
  const unconfirmedLists = opts.unconfirmedLists ?? 0;
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push(String(cmd.cmd));
      if (cmd.cmd === "workflow_list") {
        listCalls += 1;
        const active = { path: PATH, routing_key: `wf:${PATH}`, workflow_uuid: LIVE };
        return {
          active,
          workflows: [{ ...active, active: true }],
          active_confirmed: listCalls > unconfirmedLists,
        };
      }
      if (cmd.cmd === "workflow_open") throw new Error(IDENTITY_PROVEN);
      if (cmd.cmd === "graph_query") {
        if (opts.graphQuery === "mismatch") {
          throw new Error(
            `workflow instance mismatch: issued for workflow instance ${PRIOR} but canvas is ${LIVE}`,
          );
        }
        return { ids: [1, 2], node_count: 2 };
      }
      if (cmd.cmd === "graph_serialize") {
        return { workflow: opts.live, node_count: 2 };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "custom", connected_at: 0 }],
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

beforeEach(() => {
  destByKey.clear();
  __openWorkflowTestHooks.setOpenContentHandshakeStepsMs([0]);
  setQueueIdle();
});

afterEach(() => {
  destByKey.clear();
  __openWorkflowTestHooks.setOpenContentHandshakeStepsMs(null);
  setQueueIdle();
});

async function openWorkflow(opts: {
  dest: Record<string, unknown>;
  live: Record<string, unknown>;
  graphQuery: GraphQuery;
  stamp?: string;
  unconfirmedLists?: number;
}) {
  destByKey.set(PATH, opts.dest);
  const { b, calls, stampOf } = bridge(opts);
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

describe("openLiveMatchesDestAfterReconnect ignores frontend-derived node fields (#2501)", () => {
  it("matches when identity, node id/type, and link topology agree and only frontend fields moved", () => {
    expect(openLiveMatchesDestContent(liveGraph(), destGraph())).toBe(false);
    expect(openLiveMatchesDestAfterReconnect(liveGraph(), destGraph())).toBe(true);
  });

  it("matches dest positional widgets against live named/envelope serialize", () => {
    const dest = {
      nodes: [{ id: 1, type: "CLIPTextEncode", widgets_values: ["a cinematic portrait"] }],
      links: [],
    };
    const live = {
      nodes: [
        {
          id: 1,
          type: "CLIPTextEncode",
          properties: { ue_properties: { version: "7.8" } },
          widgets_values: { text: { name: "text", type: "string", value: "a cinematic portrait" } },
          inputs: [{ name: "clip", type: "CLIP", link: null }],
          outputs: [{ name: "CONDITIONING", type: "CONDITIONING", links: [] }],
        },
      ],
      links: [],
    };
    expect(openLiveMatchesDestContent(live, dest)).toBe(false);
    expect(openLiveMatchesDestAfterReconnect(live, dest)).toBe(true);
  });

  it("does not match a dest widget value the live graph does not hold", () => {
    expect(openLiveMatchesDestAfterReconnect(liveGraph({ ckpt: "other.safetensors" }), destGraph())).toBe(
      false,
    );
  });

  it("does not match a rewired dest link", () => {
    expect(
      openLiveMatchesDestAfterReconnect(
        liveGraph({ links: [[1, 1, 0, 1, 0, "IMAGE"]] }),
        destGraph(),
      ),
    ).toBe(false);
  });

  it("does not match a dest node missing from the live canvas", () => {
    expect(
      openLiveMatchesDestAfterReconnect(
        liveGraph(),
        destGraph({ extraNode: { id: 99, type: "Note", widgets_values: ["keep"] } }),
      ),
    ).toBe(false);
  });
});

describe("panel_open_workflow ignores frontend-derived node fields after reconnect (#2501)", () => {
  it("the reporter's case: already-active saved workflow after restart succeeds", async () => {
    const { text, isError, calls, stamp } = await openWorkflow({
      dest: destGraph(),
      live: liveGraph(),
      graphQuery: "answers",
      stamp: LIVE,
      unconfirmedLists: 1,
    });

    expect(isError).toBe(false);
    expect(calls).toContain("workflow_list");
    expect(calls).toContain("graph_serialize");
    expect(stamp).toBe(LIVE);
    expect(text).toMatch(/content_normalized/);
    expect(text).toMatch(/Opened/);
    expect(text).not.toMatch(/CONTENT MISMATCH/);
    expect(text).not.toMatch(/Treat the canvas as UNKNOWN/);
    expect(text).not.toMatch(/PREVIOUS workflow/);
  });

  it("the reminted-uuid restart: fence mismatch, then dest topology matches", async () => {
    const { text, isError, stamp } = await openWorkflow({
      dest: destGraph(),
      live: liveGraph(),
      graphQuery: "mismatch",
      stamp: PRIOR,
    });

    expect(isError).toBe(false);
    expect(stamp).toBe(LIVE);
    expect(text).toMatch(/content_normalized/);
    expect(text).not.toMatch(/CONTENT MISMATCH/);
  });

  it("a dest widget value the live graph does not hold stays unknown", async () => {
    const { isError, text } = await openWorkflow({
      dest: destGraph(),
      live: liveGraph({ ckpt: "other.safetensors" }),
      graphQuery: "answers",
      stamp: LIVE,
    });

    expect(isError).toBe(true);
    expect(text).not.toMatch(/content_normalized/);
    expect(text).toMatch(/widgets_values/);
  });

  it("a rewired dest link stays unknown", async () => {
    const { isError, text } = await openWorkflow({
      dest: destGraph(),
      live: liveGraph({ links: [[1, 1, 0, 1, 0, "IMAGE"]] }),
      graphQuery: "answers",
      stamp: LIVE,
    });

    expect(isError).toBe(true);
    expect(text).not.toMatch(/content_normalized/);
  });

  it("a dest node missing from the live canvas stays unknown", async () => {
    const { isError, text } = await openWorkflow({
      dest: destGraph({ extraNode: { id: 99, type: "Note", widgets_values: ["keep"] } }),
      live: liveGraph(),
      graphQuery: "answers",
      stamp: LIVE,
    });

    expect(isError).toBe(true);
    expect(text).not.toMatch(/content_normalized/);
  });
});
