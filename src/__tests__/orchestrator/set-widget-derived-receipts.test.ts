// #2918 / #2931 / #2933 — panel_set_widget returned applied:true for writes that
// never took effect:
//   - DenoLocalLLMRefiner `system_prompt`: the pack's setupNode() re-applies the
//     widget values it captured at load, so the next panel_query_graph showed the
//     old prompt (#2918).
//   - MiniMaxH3Easy `prompt`: the pack's prompt editor copies its own document back
//     over the widget on serialize and rebuilds an unlinked prompt at queue (#2933).
//   - Lora Loader (LoraManager) `text`: the write sticks and reads back equal, but
//     the backend ignores `text` and applies only the DOM-owned `loras` list (#2931).
//
// Drives the shipped panel_set_widget through makePanelToolCtx with the live
// protocol shapes (viewing.graph_identity, node_identity, widget_labels,
// driven_by_link, expected_node_* fences). The mock panel resolves widget
// addresses the way the panel does (exact, NAME[i], dotted, case-insensitive,
// display label) and applies a write on receive; a later change is modelled as
// code that runs on a later macrotask — the window between the panel's
// in-envelope verification and the next command it serves.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

const { buildPanelToolDefs, makePanelToolCtx } = await import("../../orchestrator/panel-tools.js");
import type { TabPromotedScopeRead, TabWorkflowUuidRead } from "../../services/ui-bridge.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const TAB = "wf:workflows/derived-receipts.json";
const WORKFLOW_UUID = "29330000-0000-4000-8000-000000000000";
const GRAPH_ID = "graph:root-2933";
const NODE_ID = 2;
const NODE_IDENTITY = "node:2:original";
const MUTATION_RID = "rid-set-widget-2933";
const OLD_PROMPT = "The girl in <Picture 1> is staying mostly still and periodically blinks.";
const NEW_PROMPT = "The girl in <Picture 1> is standing still and breathing deeply and slowly.";
const LORA_LOADER = "Lora Loader (LoraManager)";

type Sent = { cmd: string; payload: Record<string, unknown> };

type Harness = {
  nodeType?: string;
  widgets?: Record<string, unknown>;
  /** Renamed widgets: name -> display label (the panel's `widget_labels`). */
  labels?: Record<string, string>;
  /** Widgets a link overrides at run time (the panel's `driven_by_link`). */
  drivenByLink?: Record<string, unknown>;
  /** Code that runs on a later macrotask after a write lands. */
  afterWrite?: (live: Record<string, unknown>) => void;
  /** Override what the post-write graph read reports. */
  readback?: {
    graphIdentity?: string;
    nodeIdentity?: string;
    value?: unknown;
    error?: boolean;
    duplicate?: boolean;
    reconnectDuring?: boolean;
    /** Replace the whole reply with a malformed shape. */
    raw?: unknown;
  };
  /** Omit the receiver's per-object node incarnation (older panel). */
  noNodeIdentity?: boolean;
  /** A forwarding-only context with no capability API (no ordinary plan). */
  legacy?: boolean;
  /** Every node read fails (identity unavailable). */
  readsFail?: boolean;
  setReplyExtras?: Record<string, unknown>;
  /** The node that answers later reads is a replacement of this type. */
  typeAfterWrite?: string;
  /** The canvas switched workflow/graph after the write. */
  graphAfterWrite?: string;
};

let sent: Sent[] = [];
let dispatchedWrites = 0;

const textOf = (res: ToolResult): string =>
  res.content.map((c) => ("text" in c ? (c.text ?? "") : "")).join(" ");

const cmds = (): string[] => sent.map((s) => s.cmd);

/** The panel's resolveWidgetAddress + resolveWidgetByName order, reduced to what these
 *  tests use: exact name, NAME[i], exact dotted base, then a display label (skipped
 *  when the whole string matches a name case-insensitively), then the unique
 *  case-insensitive whole name (#524), then the case-insensitive dotted base (#560). */
function resolveAddress(
  address: string,
  live: Record<string, unknown>,
  labels: Record<string, string>,
): string {
  const names = Object.keys(live);
  if (names.includes(address)) return address;
  const selector = address.match(/^(.+)\[(\d+)\]$/);
  if (selector && names.includes(selector[1])) return selector[1];
  const dot = address.indexOf(".");
  const head = dot > 0 ? address.slice(0, dot) : null;
  if (head && names.includes(head)) return head;
  const fold = (wanted: string) => names.filter((n) => n.toLowerCase() === wanted.toLowerCase());
  if (fold(address).length === 0) {
    const labelled = Object.entries(labels).filter(([, label]) => label === address);
    if (labelled.length === 1) return labelled[0][0];
  }
  if (fold(address).length === 1) return fold(address)[0];
  if (head && fold(head).length === 1) return fold(head)[0];
  return address;
}

function makeBridge(h: Harness): PanelToolCtx["bridge"] {
  const live: Record<string, unknown> = { ...(h.widgets ?? { text: OLD_PROMPT }) };
  const labels = h.labels ?? {};
  let nodeType = h.nodeType ?? "CLIPTextEncode";
  let graphIdentity = GRAPH_ID;
  let wrote = false;
  let generation = 1;
  const viewing = (graph = graphIdentity) => ({
    scope: "root",
    kind: "root",
    workflow: "derived-receipts.json",
    workflow_uuid: WORKFLOW_UUID,
    graph_identity: graph,
  });
  const row = (widgets: Record<string, unknown>, nodeIdentity = NODE_IDENTITY) => ({
    id: NODE_ID,
    type: nodeType,
    is_subgraph: false,
    ...(h.noNodeIdentity ? {} : { node_identity: nodeIdentity }),
    widgets,
    ...(Object.keys(labels).length ? { widget_labels: labels } : {}),
    ...(h.drivenByLink ? { driven_by_link: h.drivenByLink } : {}),
    inputs: [],
  });

  const shape = {
    send: async (
      cmd: Record<string, unknown>,
      o?: { beforeDispatch?: () => void; onDispatchedRid?: (rid: string) => void },
    ) => {
      sent.push({ cmd: String(cmd.cmd), payload: cmd });
      if (cmd.cmd === "graph_set_widget") {
        o?.beforeDispatch?.();
        o?.onDispatchedRid?.(MUTATION_RID);
        dispatchedWrites += 1;
        const widget = resolveAddress(String(cmd.widget), live, labels);
        const previous = live[widget];
        live[widget] = cmd.value;
        wrote = true;
        if (h.typeAfterWrite) nodeType = h.typeAfterWrite;
        if (h.graphAfterWrite) graphIdentity = h.graphAfterWrite;
        if (h.afterWrite) setTimeout(() => h.afterWrite!(live), 0);
        return {
          set: { node_id: cmd.node_id, widget, previous, value: cmd.value },
          ...(h.setReplyExtras ?? {}),
        };
      }
      if (cmd.cmd === "graph_query") {
        if (h.readsFail) throw new Error("graph_query failed: tab busy");
        // Let code scheduled by the write run first, as it would on the page.
        if (wrote) await new Promise((resolve) => setTimeout(resolve, 5));
        if (wrote && h.readback) {
          if (h.readback.reconnectDuring) generation = 2;
          if (h.readback.error) throw new Error("graph_query failed: tab busy");
          if ("raw" in h.readback) return h.readback.raw;
          const widgets = {
            ...live,
            ...("value" in h.readback ? { [Object.keys(live)[0]!]: h.readback.value } : {}),
          };
          return {
            viewing: viewing(h.readback.graphIdentity),
            truncated: false,
            nodes: [
              {
                ...row(widgets, h.readback.nodeIdentity),
                ...(h.readback.duplicate
                  ? { duplicate_widgets: { [Object.keys(live)[0]!]: [{ index: 0 }, { index: 1 }] } }
                  : {}),
              },
            ],
            node_count: 1,
          };
        }
        return { viewing: viewing(), truncated: false, nodes: [row({ ...live })], node_count: 1 };
      }
      if (cmd.cmd === "graph_get_subgraph") {
        throw new Error(`Node ${NODE_ID} (${nodeType}) is not a subgraph`);
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "derived-receipts", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: () => true,
    workflowUuidFor: (): TabWorkflowUuidRead => ({ known: true, uuid: WORKFLOW_UUID }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    tabConnectionIdentity: () => ({ generation, tabSessionId: "browser-tab-2933" }),
    promotedScopeFor: (): TabPromotedScopeRead => ({
      known: true,
      scope: "root",
      ownerNodeId: null,
      workflowUuid: WORKFLOW_UUID,
      graphIdentity: GRAPH_ID,
    }),
    tabExpectedNodeTypeFenceCapability: () => true,
    tabExpectedNodeIdentityFenceCapability: () => true,
    tabExpectedScopeGraphIdentityFenceCapability: () => true,
    tabPromotedTerminalWitnessCapability: () => true,
    tabPromotedParentRailFenceCapability: () => true,
    tabReceiverResolvable: () => true,
  } as Partial<PanelToolCtx["bridge"]>;
  if (h.legacy) {
    delete shape.tabPromotedTerminalWitnessCapability;
  }
  return shape as PanelToolCtx["bridge"];
}

async function setWidget(h: Harness, args: Record<string, unknown>) {
  const ctx = makePanelToolCtx(makeBridge(h), TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_set_widget");
  if (!def) throw new Error("panel_set_widget is not registered");
  const res: ToolResult = await def.handler(args as never, ctx);
  const text = textOf(res);
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { res, text, json, isError: res.isError === true };
}

const readbackOf = (json: Record<string, unknown> | null) =>
  (json?.post_write_readback ?? {}) as Record<string, unknown>;

beforeEach(() => {
  sent = [];
  dispatchedWrites = 0;
});

describe("known frontend-owned widgets are refused before dispatch (#2931, #2933)", () => {
  it.each([
    LORA_LOADER,
    "Lora Stacker (LoraManager)",
    "WanVideo Lora Select (LoraManager)",
    "Create Hook LoRA (LoraManager)",
  ])("refuses `text` on %s even though it would read back equal", async (nodeType) => {
    const out = await setWidget(
      { nodeType, widgets: { text: "", loras: [] } },
      { node_id: NODE_ID, widget: "text", value: "<lora:VIA_Breast_Anima:0.8>" },
    );

    expect(out.isError).toBe(true);
    expect(out.text).toContain(`cannot set "text" on ${nodeType}`);
    expect(out.text).toMatch(/applies only the DOM-backed "loras" list/);
    expect(out.text).toMatch(/No graph_set_widget was dispatched/);
    expect(out.text).toMatch(/Do not retry panel_set_widget on this widget/);
    expect(cmds()).not.toContain("graph_set_widget");
    expect(dispatchedWrites).toBe(0);
  });

  it("names the pack's text-driven loader and a backend STRING producer for Lora Loader", async () => {
    const out = await setWidget(
      { nodeType: LORA_LOADER, widgets: { text: "", loras: [] } },
      { node_id: NODE_ID, widget: "loras", value: "[]" },
    );

    expect(out.isError).toBe(true);
    expect(out.text).toContain(`cannot set "loras" on ${LORA_LOADER}`);
    expect(out.text).toContain(`Use "LoRA Text Loader (LoraManager)" instead`);
    expect(out.text).toMatch(/PrimitiveStringMultiline, set its STRING widget, then panel_connect that STRING output to "lora_syntax"/);
    expect(dispatchedWrites).toBe(0);
  });

  it("names the WanVideo text variant for WanVideo Lora Select", async () => {
    const out = await setWidget(
      { nodeType: "WanVideo Lora Select (LoraManager)", widgets: { text: "", loras: [] } },
      { node_id: NODE_ID, widget: "text", value: "<lora:a:1>" },
    );

    expect(out.text).toContain(`"WanVideo Lora Select From Text (LoraManager)"`);
    expect(dispatchedWrites).toBe(0);
  });

  it.each([
    ["MiniMaxH3Easy", "prompt"],
    ["MiniMaxH3Easy", "h3_prompt_mentions"],
    ["MiniMaxH3EasyContextSegments", "prompt"],
    ["MiniMaxH3EasySelectedVideoContext", "prompt"],
  ])("refuses %s.%s with the link remedy", async (nodeType, widget) => {
    const out = await setWidget(
      { nodeType, widgets: { prompt: OLD_PROMPT, h3_prompt_mentions: OLD_PROMPT } },
      { node_id: NODE_ID, widget, value: NEW_PROMPT },
    );

    expect(out.isError).toBe(true);
    expect(out.text).toContain(`cannot set "${widget}" on ${nodeType}`);
    expect(out.text).toMatch(/panel_connect that STRING output to "prompt"/);
    expect(out.text).not.toMatch(/PrimitiveNode\b/);
    expect(dispatchedWrites).toBe(0);
  });

  it.each([
    ["CLIPTextEncode", "text"],
    ["PrimitiveStringMultiline", "value"],
    ["SomeOtherNode", "prompt"],
  ])("keeps the plain setter path, with no extra probe, for %s.%s", async (nodeType, widget) => {
    const out = await setWidget(
      { nodeType, widgets: { [widget]: "old" } },
      { node_id: NODE_ID, widget, value: "new" },
    );

    expect(out.isError).toBe(false);
    expect(out.json?.set).toMatchObject({ node_id: NODE_ID, widget, value: "new" });
    // preflight scope read, the write, and the post-write read-back — nothing else.
    expect(cmds()).toEqual(["graph_query", "graph_set_widget", "graph_query"]);
    expect(dispatchedWrites).toBe(1);
  });

  it.each([
    ["MiniMaxH3Easy", "seed"],
    [LORA_LOADER, "strength_model"],
  ])("keeps an unrelated widget writable on the affected type %s (%s)", async (nodeType, widget) => {
    const out = await setWidget(
      { nodeType, widgets: { [widget]: "old", text: "", prompt: "" } },
      { node_id: NODE_ID, widget, value: "new" },
    );

    expect(out.isError).toBe(false);
    expect(dispatchedWrites).toBe(1);
  });

  it("fences the refusal on the PROVEN type: no extra probe for a guarded name", async () => {
    await setWidget(
      { nodeType: "MiniMaxH3Easy", widgets: { prompt: OLD_PROMPT } },
      { node_id: NODE_ID, widget: "prompt", value: NEW_PROMPT },
    );
    expect(cmds()).toEqual(["graph_query"]);
  });
});

describe("aliases cannot walk past the refusal (#2931 review P1)", () => {
  it.each([
    ["text[0]", ["graph_query"]],
    ["TEXT", ["graph_query"]],
    ["Text", ["graph_query"]],
    // A dotted address also takes the existing dynamic-combo detail probe (#2299).
    ["text.anything", ["graph_query", "graph_query"]],
  ])(
    "refuses the name alias %s on a typed LoraManager node without a label read",
    async (address, expectedCmds) => {
      const out = await setWidget(
        { nodeType: LORA_LOADER, widgets: { text: "", loras: [] } },
        { node_id: NODE_ID, widget: address, value: "<lora:a:1>" },
      );

      expect(out.isError).toBe(true);
      expect(out.text).toContain(`cannot set "text" (addressed as "${address}") on ${LORA_LOADER}`);
      expect(cmds()).toEqual(expectedCmds);
      expect(dispatchedWrites).toBe(0);
    },
  );

  it("resolves a display label onto `text` from one detail read and refuses it", async () => {
    const out = await setWidget(
      {
        nodeType: LORA_LOADER,
        widgets: { text: "", loras: [], strength_model: 1 },
        labels: { text: "LoRA syntax" },
      },
      { node_id: NODE_ID, widget: "LoRA syntax", value: "<lora:a:1>" },
    );

    expect(out.isError).toBe(true);
    expect(out.text).toContain(`cannot set "text" (addressed as "LoRA syntax") on ${LORA_LOADER}`);
    expect(cmds()).toEqual(["graph_query", "graph_query"]);
    expect(sent[1]?.payload).toMatchObject({ fields: "detail", ids: [NODE_ID] });
    expect(dispatchedWrites).toBe(0);
  });

  it("resolves an H3 Easy prompt label and refuses it", async () => {
    const out = await setWidget(
      { nodeType: "MiniMaxH3Easy", widgets: { prompt: OLD_PROMPT }, labels: { prompt: "Shot" } },
      { node_id: NODE_ID, widget: "Shot", value: NEW_PROMPT },
    );

    expect(out.isError).toBe(true);
    expect(out.text).toContain(`cannot set "prompt" (addressed as "Shot") on MiniMaxH3Easy`);
    expect(dispatchedWrites).toBe(0);
  });

  it("refuses an address on an affected type whose target cannot be read", async () => {
    // The preflight read succeeds; every later read fails.
    let reads = 0;
    const harness: Harness = { nodeType: LORA_LOADER, widgets: { text: "", loras: [] } };
    const bridge = makeBridge(harness);
    const send = bridge.send.bind(bridge);
    (bridge as { send: typeof send }).send = async (cmd, o) => {
      if (cmd.cmd === "graph_query" && ++reads > 1) {
        sent.push({ cmd: "graph_query", payload: cmd });
        throw new Error("graph_query failed");
      }
      return send(cmd, o);
    };
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const def = buildPanelToolDefs().find((d) => d.name === "panel_set_widget")!;
    const res = await def.handler(
      { node_id: NODE_ID, widget: "Some Label", value: "x" } as never,
      ctx,
    );

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/could not be resolved to a canonical widget name before dispatch/);
    expect(textOf(res)).toMatch(/No graph_set_widget was dispatched/);
    expect(dispatchedWrites).toBe(0);
  });

  it("refuses a label two widgets carry on an affected type", async () => {
    const out = await setWidget(
      {
        nodeType: LORA_LOADER,
        widgets: { text: "", strength_model: 1 },
        labels: { text: "dup", strength_model: "dup" },
      },
      { node_id: NODE_ID, widget: "dup", value: "x" },
    );

    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/more than one widget is labelled "dup"/);
    expect(dispatchedWrites).toBe(0);
  });

  // Round-2 review: a case-folded dotted base is NOT an exact dotted base. The
  // panel's exact-base step misses STRENGTH_MODEL, and its label step resolves
  // the whole string to `text` before any case-folded lookup runs.
  it("refuses a label that the panel resolves before a case-folded dotted base", async () => {
    const out = await setWidget(
      {
        nodeType: LORA_LOADER,
        widgets: { text: "", strength_model: 1 },
        labels: { text: "STRENGTH_MODEL.value" },
      },
      { node_id: NODE_ID, widget: "STRENGTH_MODEL.value", value: "<lora:a:1>" },
    );

    expect(out.isError).toBe(true);
    expect(out.text).toContain(
      `cannot set "text" (addressed as "STRENGTH_MODEL.value") on ${LORA_LOADER}`,
    );
    expect(dispatchedWrites).toBe(0);
  });

  it("control: an EXACT dotted base wins over the same label", async () => {
    const out = await setWidget(
      {
        nodeType: LORA_LOADER,
        widgets: { text: "", strength_model: 1 },
        labels: { text: "strength_model.value" },
      },
      { node_id: NODE_ID, widget: "strength_model.value", value: "0.5" },
    );

    expect(out.text).not.toMatch(/cannot set|could not be resolved/);
    expect(dispatchedWrites).toBe(1);
    expect(sent.find((c) => c.cmd === "graph_set_widget")?.payload.widget).toBe("strength_model.value");
  });

  it("refuses a case-folded dotted base onto `text` when no label intervenes (#560)", async () => {
    const out = await setWidget(
      { nodeType: LORA_LOADER, widgets: { text: "", strength_model: 1 } },
      { node_id: NODE_ID, widget: "TEXT.value", value: "<lora:a:1>" },
    );

    expect(out.isError).toBe(true);
    expect(out.text).toContain(`cannot set "text" (addressed as "TEXT.value") on ${LORA_LOADER}`);
    expect(dispatchedWrites).toBe(0);
  });

  it("control: a case-folded dotted base onto an unrelated widget is written", async () => {
    const out = await setWidget(
      { nodeType: LORA_LOADER, widgets: { text: "", strength_model: 1 } },
      { node_id: NODE_ID, widget: "STRENGTH_MODEL.value", value: "0.5" },
    );

    expect(out.text).not.toMatch(/cannot set|could not be resolved/);
    expect(dispatchedWrites).toBe(1);
  });
});

describe("untyped (legacy) writes probe guarded names and disclose what they could not check", () => {
  it("refuses legacy LoraManager `text` after one identity probe", async () => {
    const out = await setWidget(
      { legacy: true, nodeType: LORA_LOADER, widgets: { text: "", loras: [] } },
      { node_id: NODE_ID, widget: "text", value: "<lora:a:1>" },
    );

    expect(out.isError).toBe(true);
    expect(out.text).toContain(`cannot set "text" on ${LORA_LOADER}`);
    expect(cmds()).toEqual(["graph_query"]);
    expect(dispatchedWrites).toBe(0);
  });

  it("refuses legacy MiniMaxH3Easy `prompt` and its index alias", async () => {
    for (const address of ["prompt", "prompt[0]"]) {
      sent = [];
      const out = await setWidget(
        { legacy: true, nodeType: "MiniMaxH3Easy", widgets: { prompt: OLD_PROMPT } },
        { node_id: NODE_ID, widget: address, value: NEW_PROMPT },
      );
      expect(out.isError).toBe(true);
      expect(out.text).toContain(`cannot set "prompt"`);
    }
    expect(dispatchedWrites).toBe(0);
  });

  it("keeps a legacy CLIPTextEncode `text` write after its probe, with no disclosure", async () => {
    const out = await setWidget(
      { legacy: true, widgets: { text: "old" } },
      { node_id: NODE_ID, widget: "text", value: "new" },
    );

    expect(out.isError).toBe(false);
    expect(cmds()).toEqual(["graph_query", "graph_set_widget"]);
    expect(out.json?.post_write_readback).toBeUndefined();
  });

  it("discloses that the checks did not run when the node cannot be read", async () => {
    const out = await setWidget(
      { legacy: true, readsFail: true, widgets: { text: "old" } },
      { node_id: NODE_ID, widget: "text", value: "new" },
    );

    expect(out.isError).toBe(false);
    expect(out.json?.set).toMatchObject({ value: "new" });
    const readback = readbackOf(out.json);
    expect(readback.status).toBe("unverified");
    expect(String(readback.reason)).toMatch(/node type could not be read/);
    expect(String(readback.note)).toMatch(/panel acknowledged this write/);
    expect(String(readback.note)).toMatch(/not a durability or execution claim/);
  });

  // Round-2 review: a legacy context has no node incarnation, so no later read can be
  // bound to the node that took the write. The semantic check is reported as
  // unverified, and no node type is attributed to the write.
  it.each([
    ["the written node is still a LoraManager node", { nodeType: LORA_LOADER }],
    [
      "the node was replaced by a LoraManager node after the write",
      { nodeType: "CLIPTextEncode", typeAfterWrite: LORA_LOADER },
    ],
    [
      "the LoraManager node was replaced by a plain node after the write",
      { nodeType: LORA_LOADER, typeAfterWrite: "CLIPTextEncode" },
    ],
    [
      "the canvas switched workflow after the write",
      { nodeType: LORA_LOADER, graphAfterWrite: "graph:other-workflow" },
    ],
  ] as const)(
    "keeps a label alias the panel resolved onto `text` acknowledged but unverified when %s",
    async (_label, shape) => {
      const out = await setWidget(
        {
          legacy: true,
          widgets: { text: "", loras: [] },
          labels: { text: "LoRA syntax" },
          ...shape,
        },
        { node_id: NODE_ID, widget: "LoRA syntax", value: "<lora:a:1>" },
      );

      expect(out.isError).toBe(false);
      expect(out.json?.set).toMatchObject({ widget: "text", value: "<lora:a:1>" });
      const readback = readbackOf(out.json);
      expect(readback.status).toBe("unverified");
      expect(String(readback.reason)).toMatch(/resolved "LoRA syntax" to "text"/);
      expect(String(readback.reason)).toMatch(/no later read can be bound to that node/);
      expect(String(readback.note)).toMatch(/panel acknowledged this write/);
      // No node type is asserted for the write, and no read is taken to "find" one.
      expect(out.text).not.toMatch(/on Lora Loader \(LoraManager\)|on CLIPTextEncode/);
      expect(cmds()).toEqual(["graph_set_widget"]);
      expect(dispatchedWrites).toBe(1);
    },
  );

  it("leaves a legacy label alias onto an unguarded widget unchanged", async () => {
    const out = await setWidget(
      { legacy: true, widgets: { seed: 1 }, labels: { seed: "Seed value" } },
      { node_id: NODE_ID, widget: "Seed value", value: "7" },
    );

    expect(out.isError).toBe(false);
    expect(out.json?.post_write_readback).toBeUndefined();
    expect(cmds()).toEqual(["graph_set_widget"]);
  });
});

describe("one fenced read after an acknowledged string write (#2918, #2933)", () => {
  it("#2918: a value not observed afterwards is reported as such, without replaying", async () => {
    const out = await setWidget(
      {
        nodeType: "DenoLocalLLMRefiner",
        widgets: { system_prompt: "OLD planner prompt" },
        afterWrite: (live) => {
          live.system_prompt = "OLD planner prompt";
        },
      },
      { node_id: NODE_ID, widget: "system_prompt", value: "NEW planner prompt" },
    );

    expect(out.isError).toBe(true);
    expect(out.json).toMatchObject({
      acknowledged: true,
      value_observed_after_write: false,
      mutation_id: MUTATION_RID,
      requested: { node_id: NODE_ID, widget: "system_prompt", value: "NEW planner prompt" },
      previous: "OLD planner prompt",
      post_write_readback: {
        status: "mismatch",
        observed: "OLD planner prompt",
        observed_equals_previous: true,
        confirmed_by: "graph read after write",
      },
    });
    expect(out.json).not.toHaveProperty("applied");
    const note = String(out.json?.note);
    expect(note).toMatch(/value the panel reported as previous/);
    expect(note).toMatch(/not that the write never applied, and not why/);
    expect(note).toMatch(/another edit \(the user or another agent\)/);
    expect(note).toMatch(/does not say what a run would use/);
    expect(note).toMatch(/Nothing was retried\. Inspect the node/);
    expect(note).not.toMatch(/will not (help|change)/);
    expect(cmds()).toEqual(["graph_query", "graph_set_widget", "graph_query"]);
    expect(dispatchedWrites).toBe(1);
    expect(sent[2]?.payload).toMatchObject({
      cmd: "graph_query",
      ids: [NODE_ID],
      fields: "detail",
      limit: 1,
    });
  });

  it("a concurrent edit restoring the previous value gets the same neutral receipt", async () => {
    // Another agent (or the user) puts "old" back between the ack and the read.
    const out = await setWidget(
      { widgets: { text: "old" }, afterWrite: (live) => void (live.text = "old") },
      { node_id: NODE_ID, widget: "text", value: "new" },
    );

    expect(out.isError).toBe(true);
    expect(readbackOf(out.json)).toMatchObject({ status: "mismatch", observed_equals_previous: true });
    expect(String(out.json?.note)).not.toMatch(/node's own frontend code .* put its state back/);
    expect(dispatchedWrites).toBe(1);
  });

  it("a concurrent edit to a third value is named as a different value", async () => {
    const out = await setWidget(
      { widgets: { text: "old" }, afterWrite: (live) => void (live.text = "someone else's text") },
      { node_id: NODE_ID, widget: "text", value: "new" },
    );

    expect(out.isError).toBe(true);
    expect(readbackOf(out.json)).toMatchObject({
      status: "mismatch",
      observed: "someone else's text",
      observed_equals_previous: false,
    });
    expect(String(out.json?.note)).toMatch(/it showed a different value/);
  });

  it("a link-driven widget's mismatch says the link supplies the run value", async () => {
    const out = await setWidget(
      {
        widgets: { text: "old" },
        drivenByLink: { text: { node_id: 9, output_slot: 0 } },
        afterWrite: (live) => void (live.text = "old"),
      },
      { node_id: NODE_ID, widget: "text", value: "new" },
    );

    expect(out.isError).toBe(true);
    expect(readbackOf(out.json)).toMatchObject({
      status: "mismatch",
      driven_by_link: { node_id: 9, output_slot: 0 },
    });
    expect(String(out.json?.note)).toMatch(/linked source supplies the value/);
  });

  it("a link-driven widget's match still says the stored value is not what runs", async () => {
    const out = await setWidget(
      { widgets: { text: "old" }, drivenByLink: { text: { node_id: 9, output_slot: 0 } } },
      { node_id: NODE_ID, widget: "text", value: "new" },
    );

    expect(out.isError).toBe(false);
    expect(readbackOf(out.json)).toMatchObject({ status: "matched", driven_by_link: { node_id: 9 } });
    expect(String(readbackOf(out.json).note)).toMatch(/linked source supplies the value/);
  });

  it("marks a write the read shows held as matched, and says what that does not prove", async () => {
    const out = await setWidget(
      { widgets: { text: "old" } },
      { node_id: NODE_ID, widget: "text", value: "new" },
    );

    expect(out.isError).toBe(false);
    expect(out.json).toMatchObject({
      set: { node_id: NODE_ID, widget: "text", previous: "old", value: "new" },
      post_write_readback: { status: "matched" },
    });
    expect(String(readbackOf(out.json).note)).toMatch(/cannot see a later change/);
    expect(cmds()).toEqual(["graph_query", "graph_set_widget", "graph_query"]);
  });

  it("clear:true writes \"\" and is read back like any string", async () => {
    const held = await setWidget(
      { widgets: { text: "old" } },
      { node_id: NODE_ID, widget: "text", clear: true },
    );
    expect(held.isError).toBe(false);
    expect(held.json?.set).toMatchObject({ value: "" });
    expect(readbackOf(held.json).status).toBe("matched");

    sent = [];
    const restored = await setWidget(
      { widgets: { text: "old" }, afterWrite: (live) => void (live.text = "old") },
      { node_id: NODE_ID, widget: "text", clear: true },
    );
    expect(restored.isError).toBe(true);
    expect(restored.json).toMatchObject({
      requested: { value: "" },
      post_write_readback: { status: "mismatch", observed: "old" },
    });
  });

  it("does not wait for, or claim to see, a change that lands after the read", async () => {
    const out = await setWidget(
      {
        widgets: { text: "old" },
        afterWrite: (live) => {
          setTimeout(() => {
            live.text = "old";
          }, 50);
        },
      },
      { node_id: NODE_ID, widget: "text", value: "new" },
    );

    expect(out.isError).toBe(false);
    expect(readbackOf(out.json).status).toBe("matched");
  });

  it.each([
    ["the graph read fails", { error: true }, /graph read failed/],
    ["the graph view changed", { graphIdentity: "graph:other" }, /same graph view/],
    ["the node id is a new incarnation", { nodeIdentity: "node:2:replacement" }, /different node incarnation/],
    ["the connection changed during the read", { reconnectDuring: true }, /connection changed during the read-back/],
    ["several widgets share the name", { duplicate: true }, /several widgets on the node are named/],
    ["the reply is not JSON", { raw: "#2 CLIPTextEncode · text=old" }, /same graph view/],
    ["the reply names no node", { raw: { viewing: { scope: "root", graph_identity: GRAPH_ID, workflow_uuid: WORKFLOW_UUID }, nodes: [] } }, /exactly one complete node row/],
    ["the reply was truncated", { raw: { viewing: { scope: "root", graph_identity: GRAPH_ID, workflow_uuid: WORKFLOW_UUID }, truncated: true, nodes: [] } }, /exactly one complete node row/],
    [
      "the row omits the widget",
      { raw: { viewing: { scope: "root", graph_identity: GRAPH_ID, workflow_uuid: WORKFLOW_UUID }, nodes: [{ id: NODE_ID, type: "CLIPTextEncode", node_identity: NODE_IDENTITY, widgets: {} }] } },
      /did not list "text"/,
    ],
    [
      "the value is a non-scalar",
      { raw: { viewing: { scope: "root", graph_identity: GRAPH_ID, workflow_uuid: WORKFLOW_UUID }, nodes: [{ id: NODE_ID, type: "CLIPTextEncode", node_identity: NODE_IDENTITY, widgets: { text: { a: 1 } } }] } },
      /as a scalar/,
    ],
    [
      "the value is the panel's [binary] placeholder",
      { raw: { viewing: { scope: "root", graph_identity: GRAPH_ID, workflow_uuid: WORKFLOW_UUID }, nodes: [{ id: NODE_ID, type: "CLIPTextEncode", node_identity: NODE_IDENTITY, widgets: { text: "[binary]" } }] } },
      /as a scalar/,
    ],
  ] as const)("keeps the acknowledgement but marks it unverified when %s", async (_label, readback, reason) => {
    const out = await setWidget(
      { widgets: { text: "old" }, readback: { value: "old", ...readback } },
      { node_id: NODE_ID, widget: "text", value: "new" },
    );

    expect(out.isError).toBe(false);
    expect(out.json?.set).toMatchObject({ value: "new" });
    const readbackField = readbackOf(out.json);
    expect(readbackField.status).toBe("unverified");
    expect(String(readbackField.reason)).toMatch(reason);
    expect(String(readbackField.note)).toMatch(/panel acknowledged this write .* current value was not verified/);
    expect(dispatchedWrites).toBe(1);
  });

  it("does not read back when the panel published no node incarnation", async () => {
    const out = await setWidget(
      { widgets: { text: "old" }, noNodeIdentity: true },
      { node_id: NODE_ID, widget: "text", value: "new" },
    );

    expect(out.isError).toBe(false);
    expect(out.json?.post_write_readback).toMatchObject({ status: "unverified" });
    expect(cmds().filter((c) => c === "graph_query")).toHaveLength(1);
  });

  it("treats a value clipped by the panel's cap as unverified, not as a mismatch", async () => {
    const long = `clip-${"x".repeat(2200)}`;
    const out = await setWidget(
      {
        widgets: { text: "old" },
        readback: {
          value:
            "clip-" +
            "x".repeat(100) +
            "…(+2100 chars cut at the 2048-char per-widget cap, which `max_chars` does not raise)",
        },
      },
      { node_id: NODE_ID, widget: "text", value: long },
    );

    expect(out.isError).toBe(false);
    expect(out.json?.post_write_readback).toMatchObject({ status: "unverified" });
    // The long value asks the pinpoint read for the full widget.
    expect(sent[2]?.payload.widget_max_chars).toBeGreaterThanOrEqual(long.length);
  });

  it("summarizes long values in a mismatch receipt unless echo:full", async () => {
    const long = `prompt-${"y".repeat(1500)}`;
    const harness: Harness = {
      widgets: { text: OLD_PROMPT },
      afterWrite: (live) => {
        live.text = OLD_PROMPT;
      },
    };
    const summary = await setWidget(harness, { node_id: NODE_ID, widget: "text", value: long });
    expect(summary.json?.requested).toMatchObject({ value: { chars: long.length } });

    sent = [];
    const full = await setWidget(harness, {
      node_id: NODE_ID,
      widget: "text",
      value: long,
      echo: "full",
    });
    expect(full.json?.requested).toMatchObject({ value: long });
  });

  it("does not read back numeric, deferred, or refresh-pending writes", async () => {
    await setWidget({ widgets: { steps: 20 } }, { node_id: NODE_ID, widget: "steps", value: 30 });
    expect(cmds()).toEqual(["graph_query", "graph_set_widget"]);

    sent = [];
    await setWidget(
      { widgets: { text: "old" } },
      { node_id: NODE_ID, widget: "text", value: "new", defer_until_idle: true, expected_value: "old" },
    );
    expect(cmds()).toEqual(["graph_query", "graph_set_widget"]);

    sent = [];
    await setWidget(
      { widgets: { text: "old" }, setReplyExtras: { refresh_pending: true } },
      { node_id: NODE_ID, widget: "text", value: "new" },
    );
    expect(cmds()).toEqual(["graph_query", "graph_set_widget"]);
  });
});
