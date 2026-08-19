// #1710 — opening a save-as copy bound the dest tab, then save refused because
// extra.comfyui_mcp still named the source, and outline showed an empty promoted
// prompt the dest file still held.
//
// Tests drive panel_open_workflow / panel_save_workflow. Dest file comes through
// the same userdata read those handlers use.

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

const TAB = "wf:workflows/copy.json";
const DEST = "workflows/copy.json";
const SOURCE = "workflows/source.json";
const DEST_UUID = "77777777-7777-4777-8777-777777777777";
const SOURCE_UUID = "11111111-1111-4111-8111-111111111111";
const PROMPT = "a cinematic portrait of a woman in gold light";

const IDENTITY_PROVEN =
  `workflow_open RAN and the canvas IS bound to ${DEST} — that much was proven — but the graph ` +
  `on it does not match the state that was loaded, and every node that was loaded is on it with ` +
  `the same id and type, and nothing extra appeared — no node was lost. What differs is per-node ` +
  `fields. You are on the right workflow. You are NOT on the wrong workflow: ${DEST} IS the ` +
  `active one. This reply carries NO fence refresh.`;

const STAMP_REFUSAL =
  `REFUSED to save: the canvas about to overwrite "${DEST}" is stamped as belonging to ` +
  `"${SOURCE}" (extra.comfyui_mcp.workflow_path), which is a different workflow that still ` +
  `exists. Writing it would replace that file's content with a graph that does not belong to it.`;

function destGraph(prompt: string) {
  return {
    nodes: [
      {
        id: 78,
        type: "FLUX",
        properties: { proxyWidgets: [["12", "text"]] },
        widgets_values: [prompt],
        widgets_values_named: { text: prompt },
      },
      { id: 12, type: "CLIPTextEncode", widgets_values: [prompt], widgets_values_named: { text: prompt } },
    ],
    links: [],
    extra: { comfyui_mcp: { workflow_path: DEST, workflow_uuid: DEST_UUID } },
  };
}

function liveGraph(opts: { extraPath: string; prompt: string }) {
  return {
    nodes: [
      {
        id: 78,
        type: "FLUX",
        properties: { proxyWidgets: [["12", "text"]] },
        widgets_values: [opts.prompt],
        widgets_values_named: { text: opts.prompt },
      },
      {
        id: 12,
        type: "CLIPTextEncode",
        widgets_values: [opts.prompt],
        widgets_values_named: { text: opts.prompt },
      },
    ],
    links: [],
    extra: { comfyui_mcp: { workflow_path: opts.extraPath, workflow_uuid: SOURCE_UUID } },
  };
}

type Mode = "open" | "save";

function bridge(opts: {
  live: Record<string, unknown>;
  saveFirst?: "refuse" | "ok";
}) {
  const calls: Array<Record<string, unknown>> = [];
  let stamp: string | undefined = SOURCE_UUID;
  let saves = 0;
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push({ ...cmd });
      if (cmd.cmd === "workflow_list") {
        const active = { path: DEST, routing_key: `wf:${DEST}`, workflow_uuid: DEST_UUID };
        return { active, workflows: [{ ...active, active: true }], active_confirmed: true };
      }
      if (cmd.cmd === "workflow_open") throw new Error(IDENTITY_PROVEN);
      if (cmd.cmd === "graph_query") {
        return { ids: [78, 12], node_count: 2 };
      }
      if (cmd.cmd === "graph_serialize") {
        return { workflow: opts.live, node_count: 2 };
      }
      if (cmd.cmd === "graph_load") {
        return { loaded: true };
      }
      if (cmd.cmd === "workflow_save") {
        saves += 1;
        if (opts.saveFirst === "refuse" && saves === 1) throw new Error(STAMP_REFUSAL);
        return { saved: true, workflow: DEST };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "copy", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: (_t: string, uuid: string) => {
      calls.push({ cmd: `adopt:${uuid}` });
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
  destByKey.set("workflows/copy.json", destGraph(PROMPT));
  const qm = QueueMonitor as unknown as { state: { runningPromptId: string | null } };
  qm.state.runningPromptId = null;
});

afterEach(() => {
  destByKey.clear();
  const qm = QueueMonitor as unknown as { state: { runningPromptId: string | null } };
  qm.state.runningPromptId = null;
});

async function run(mode: Mode, live: Record<string, unknown>, saveFirst?: "refuse" | "ok") {
  const { b, calls, stampOf } = bridge({ live, saveFirst });
  const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
  const name = mode === "open" ? "panel_open_workflow" : "panel_save_workflow";
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`${name} is not registered`);
  const args = mode === "open" ? { path: DEST } : {};
  const res: ToolResult = await def.handler(args as never, ctx);
  return {
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    isError: res.isError === true,
    calls,
    stamp: stampOf(),
    loaded: calls.find((c) => c.cmd === "graph_load")?.graph as Record<string, unknown> | undefined,
  };
}

describe("panel_open_workflow rebinds dest identity after frontend normalization (#1710)", () => {
  it("the reporter's case: dest nodes, source extra, empty promoted prompt — open succeeds", async () => {
    const { text, isError, calls, stamp, loaded } = await run(
      "open",
      liveGraph({ extraPath: SOURCE, prompt: "" }),
    );

    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toContain("graph_serialize");
    expect(calls.map((c) => c.cmd)).toContain("graph_load");
    expect(stamp).toBe(DEST_UUID);
    expect(text).toMatch(/identity_rebound/);
    expect(text).toMatch(/Restored/);
    expect(loaded?.extra).toMatchObject({
      comfyui_mcp: { workflow_path: DEST, workflow_uuid: DEST_UUID },
    });
    const flux = (loaded?.nodes as Array<Record<string, unknown>>)?.find((n) => n.id === 78);
    expect(flux?.widgets_values).toEqual([PROMPT]);
    expect(flux?.widgets_values_named).toEqual({ text: PROMPT });
  });

  it("does not restamp when a non-empty live widget disagrees with dest — #1639 stays closed", async () => {
    const { isError, calls, stamp } = await run(
      "open",
      liveGraph({ extraPath: SOURCE, prompt: "the SOURCE prompt still on the previous graph" }),
    );

    expect(isError).toBe(true);
    expect(calls.map((c) => c.cmd)).not.toContain("graph_load");
    expect(stamp).toBe(SOURCE_UUID);
  });
});

describe("panel_save_workflow restamps dest extra then retries (#1710)", () => {
  it("the reporter's save refusal becomes a save after dest identity is rebound", async () => {
    const { text, isError, calls, stamp, loaded } = await run(
      "save",
      liveGraph({ extraPath: SOURCE, prompt: "" }),
      "refuse",
    );

    expect(isError).toBe(false);
    expect(calls.filter((c) => c.cmd === "workflow_save")).toHaveLength(2);
    expect(calls.map((c) => c.cmd)).toContain("graph_load");
    expect(stamp).toBe(DEST_UUID);
    expect(text).toMatch(/saved/i);
    expect(loaded?.extra).toMatchObject({
      comfyui_mcp: { workflow_path: DEST },
    });
  });

  it("keeps the refusal when dest content is not what is on the canvas", async () => {
    const { isError, calls } = await run(
      "save",
      liveGraph({ extraPath: SOURCE, prompt: "the SOURCE prompt still on the previous graph" }),
      "refuse",
    );

    expect(isError).toBe(true);
    expect(calls.filter((c) => c.cmd === "workflow_save")).toHaveLength(1);
    expect(calls.map((c) => c.cmd)).not.toContain("graph_load");
  });
});
