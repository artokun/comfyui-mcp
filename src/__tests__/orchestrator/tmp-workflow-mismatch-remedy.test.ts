// #1480 — the root-workflow-uuid-mismatch guard had no followable exit on a NEVER-SAVED
// tab, so a session could read the canvas and change nothing.
//
// The panel's remedy for this verdict is `panel_open_workflow(<path>)`. An unsaved tab has
// no path — `workflow_list` reports `path: null, filename: null` for it by contract (#186,
// because native ComfyUI reuses the "Unsaved Workflow" title across unsaved tabs) — so the
// reporter passed the TITLE, got "no workflow matching", and found every other documented
// exit closed as well: reload refuses while unsaved, save refuses under this same guard
// (#708). The exit existed the whole time and nothing named it: the per-instance ROUTING
// KEY is a valid `workflow_open` selector, and `workflow_list` already publishes it.
//
// The refusal text below is the panel's VERBATIM message (graph-binding.js
// `graphBindingRefusalMessage`), and the workflow_list replies are the shapes a live rig
// actually returns — an unsaved tab measured on the rig reports exactly the
// `path: null / filename: null / key: tmp:<uuid> / routing_key: tmp:<uuid>` record used
// here. A fixture invented from the issue text would not have proven the classifier keys
// on a field that exists.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

const { buildPanelToolDefs, makePanelToolCtx } = await import("../../orchestrator/panel-tools.js");
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const TAB = "11111111-2222-3333-4444-555555555555";
const ROUTING_KEY = "tmp:ffadfd06-41bb-4448-9ad2-fe307ff3356f";
const SAVED_PATH = "workflows/sdxl-txt2img.json";

/** The panel's own text for this verdict, copied from graphBindingRefusalMessage. */
const PANEL_REFUSAL =
  `[root-workflow-uuid-mismatch] The live canvas carries a different workflow's identity tag ` +
  `than the active workflow, so this command was NOT applied. What the panel observed is the ` +
  `disagreement itself, not what produced it — a load, tab switch or reconnect leaving a stale ` +
  `tag behind is the usual explanation, but none of them was witnessed here. Re-open the active ` +
  `workflow tab (panel_open_workflow) to rebind the graph in place; if that does not clear it, ` +
  `reload the panel (panel_reload scope:frontend), then retry.`;

/** As measured on a live rig: an unsaved tab publishes its routing key and nothing else. */
const UNSAVED_LIST = {
  active: {
    path: null,
    filename: null,
    title: "Unsaved Workflow",
    key: ROUTING_KEY,
    routing_key: ROUTING_KEY,
    workflow_uuid: "defb7763-6e20-4f5a-b9cd-2aeabfea6f08",
  },
  open: [
    {
      path: null,
      filename: null,
      title: "Unsaved Workflow",
      key: ROUTING_KEY,
      routing_key: ROUTING_KEY,
      active: true,
      modified: true,
      persisted: false,
    },
  ],
  active_confirmed: true,
};

const SAVED_LIST = {
  active: {
    path: SAVED_PATH,
    filename: "sdxl-txt2img.json",
    title: "sdxl-txt2img.json",
    key: SAVED_PATH,
    routing_key: `wf:${SAVED_PATH}`,
    workflow_uuid: "defb7763-6e20-4f5a-b9cd-2aeabfea6f08",
  },
  open: [{ path: SAVED_PATH, active: true, modified: false, persisted: true }],
  active_confirmed: true,
};

let listCalls = 0;

/** A tab whose every graph command is refused by the panel's binding guard. */
function bridge(list: unknown | "unreadable") {
  return {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "workflow_list") {
        listCalls += 1;
        if (list === "unreadable") throw new Error("the panel did not answer");
        return list;
      }
      throw new Error(PANEL_REFUSAL);
    },
    push: () => 1,
    canReach: (id: string) => id === TAB,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: () => true,
    workflowUuidFor: () => ({ known: true, uuid: "defb7763-6e20-4f5a-b9cd-2aeabfea6f08" }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

async function run(tool: string, args: Record<string, unknown>, list: unknown): Promise<string> {
  const ctx = makePanelToolCtx(bridge(list), TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === tool);
  if (!def) throw new Error(`${tool} is not registered`);
  const res: ToolResult = await def.handler(args as never, ctx);
  return res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");
}

beforeEach(() => {
  listCalls = 0;
});

describe("root-workflow-uuid-mismatch names a remedy the tab can accept (#1480)", () => {
  it("UNSAVED tab: names the routing key, the only selector it has", async () => {
    const text = await run("panel_connect", { from_node_id: 1, to_node_id: 2 }, UNSAVED_LIST);

    // The tab state was really read. Without this every assertion below could be
    // satisfied by a canned string that never consulted the panel — and a branch that
    // never runs is the failure mode this whole diagnosis exists to avoid.
    expect(listCalls).toBeGreaterThan(0);

    // THE fix: the selector that exists, spelled the way it must be passed.
    expect(text).toContain(ROUTING_KEY);
    expect(text).toMatch(/panel_open_workflow\(\{path: "tmp:/);
    expect(text).toMatch(/NEVER BEEN SAVED/);

    // The two exits the reporter burned turns on, both of which refuse from this state.
    expect(text).toMatch(/Do NOT reach for panel_save_workflow first/);
    expect(text).toMatch(/do NOT reload while the tab is unsaved/);

    // The panel's own refusal is preserved — the diagnosis annotates, it never replaces.
    expect(text).toContain("[root-workflow-uuid-mismatch]");
  });

  it("READS get it too — panel_graph_outline refusing was half the dead end", async () => {
    // The issue's secondary complaint: the read path refused while panel_query_graph
    // succeeded, which made a persistent fault look intermittent. A read that refuses
    // must still name the way out, or the agent only learns it from a later write.
    const text = await run("panel_graph_outline", {}, UNSAVED_LIST);

    expect(listCalls).toBeGreaterThan(0);
    expect(text).toContain(ROUTING_KEY);
    expect(text).toMatch(/NEVER BEEN SAVED/);
  });

  it("SAVED tab: the panel's own <path> advice is reachable, so it is named, not replaced", async () => {
    // The direction that must not regress. This guard is correct for a saved tab, and an
    // over-broad fix that told everyone to pass a routing key would be a new wrong answer.
    const text = await run("panel_connect", { from_node_id: 1, to_node_id: 2 }, SAVED_LIST);

    expect(listCalls).toBeGreaterThan(0);
    expect(text).toContain(SAVED_PATH);
    expect(text).toMatch(/IS saved/);
    expect(text).not.toMatch(/NEVER BEEN SAVED/);
    expect(text).not.toContain("tmp:");
  });

  it("UNREADABLE: promises nothing, because nothing was established", async () => {
    // The failure direction that matters. Naming a selector we could not establish would
    // send the agent to "no workflow matching" — the exact turn #1480 wasted.
    const text = await run("panel_connect", { from_node_id: 1, to_node_id: 2 }, "unreadable");

    expect(text).toMatch(/the answer is UNKNOWN/);
    expect(text).toMatch(/routing_key/);
    expect(text).not.toMatch(/NEVER BEEN SAVED/);
    // Still fails, and still on the panel's own terms.
    expect(text).toContain("[root-workflow-uuid-mismatch]");
  });
});
