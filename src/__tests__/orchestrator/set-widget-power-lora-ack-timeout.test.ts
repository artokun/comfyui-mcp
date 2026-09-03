// #2495 — panel_set_widget creating lora_1 on a freshly added Power Lora Loader
// timed out after 90s even though the row had already been inserted. The next
// lora_2 write and panel_query_graph both succeeded, so the caller received
// outcome-unknown for a successful dynamic-widget mutation.
//
// The panel's refresh-before-validate wait lives in the other repo. This process
// can still settle a tagged no-reply with ONE graph_query read-back and return
// applied/refresh-pending instead of a mutating-delivery error.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

const { buildPanelToolDefs, makePanelToolCtx } = await import("../../orchestrator/panel-tools.js");
import { markReplyTimeout } from "../../services/ui-bridge.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const TAB = "11111111-2222-3333-4444-555555555555";
const OTHER_TAB = "99999999-8888-7777-6666-555555555555";
const MUTATION_RID = "rid-set-widget-2495";
const NODE_ID = 82;
const LORA_VALUE =
  '{"on":true,"lora":"subdir/turbo.safetensors","strength":1,"strengthTwo":null}';
const LORA_OBJECT = {
  on: true,
  lora: "subdir/turbo.safetensors",
  strength: 1,
  strengthTwo: null,
};

const textOf = (res: ToolResult): string =>
  res.content.map((c) => ("text" in c ? (c.text ?? "") : "")).join(" ");

const ackTimeout = (cmd: string, ms: number): Error =>
  new Error(
    `Panel tab ${TAB} did not reply to "${cmd}" within ${ms} ms — the ComfyUI tab may be ` +
      `backgrounded or frozen. This command MUTATES and was already delivered to the tab, so it ` +
      `may have been applied despite the missing reply — check the current state before ` +
      `re-issuing it; a blind retry can apply it twice`,
  );

let sent: Array<{ cmd: string; tabId?: string; widget?: unknown }> = [];

function powerLoraDetail(
  widgets: Record<string, unknown> | undefined,
  type = "Power Lora Loader (rgthree)",
) {
  return {
    truncated: false,
    viewing: { scope: "root" },
    nodes: [
      {
        id: NODE_ID,
        type,
        is_subgraph: false,
        widgets: widgets ?? {},
        inputs: [],
      },
    ],
  };
}

function bridge(opts: {
  writeReply?: "timeout" | "acked-error" | "acked-error-timeout-worded" | "ok";
  probeWidgets?: Record<string, unknown> | "timeout" | "missing";
  probeType?: string;
  loseTabAfterWrite?: boolean;
}) {
  let tabGone = false;
  return {
    send: async (
      cmd: Record<string, unknown>,
      o?: { timeoutMs?: number; tabId?: string; onDispatchedRid?: (rid: string) => void },
    ) => {
      sent.push({
        cmd: String(cmd.cmd),
        tabId: o?.tabId,
        widget: cmd.widget,
      });
      if (cmd.cmd === "graph_set_widget") {
        if (opts.writeReply === "acked-error") {
          throw new Error('Cannot set widget "lora_1" on node 82: value is not a JSON object');
        }
        if (opts.writeReply === "acked-error-timeout-worded") {
          throw new Error(
            `Panel tab ${TAB} did not reply to "graph_set_widget" within 90000 ms — the ` +
              `ComfyUI tab may be backgrounded or frozen. Reported by the widget writer: ` +
              `nothing was applied.`,
          );
        }
        if (opts.writeReply === "ok" || opts.writeReply === undefined) {
          o?.onDispatchedRid?.(MUTATION_RID);
          return {
            set: { node_id: NODE_ID, widget: cmd.widget, previous: undefined, value: cmd.value },
            created_widget: cmd.widget,
          };
        }
        if (opts.loseTabAfterWrite) tabGone = true;
        o?.onDispatchedRid?.(MUTATION_RID);
        throw markReplyTimeout(ackTimeout("graph_set_widget", 90000));
      }
      if (cmd.cmd === "graph_query") {
        if (opts.probeWidgets === "timeout") throw ackTimeout("graph_query", 8000);
        if (opts.probeWidgets === "missing") return powerLoraDetail({}, opts.probeType);
        return powerLoraDetail(opts.probeWidgets ?? { lora_1: LORA_OBJECT }, opts.probeType);
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: (id: string) => (tabGone ? id === OTHER_TAB : id === TAB),
    isHeadless: () => false,
    tabs: () =>
      tabGone
        ? [{ tab_id: OTHER_TAB, title: "other", connected_at: 0 }]
        : [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => (tabGone ? OTHER_TAB : TAB),
    refreshWorkflowUuid: () => true,
    workflowUuidFor: () => ({ known: false }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as PanelToolCtx["bridge"];
}

async function runSetWidget(
  opts: Parameters<typeof bridge>[0],
  args: Record<string, unknown> = { node_id: NODE_ID, widget: "lora_1", value: LORA_VALUE },
): Promise<{ text: string; isError: boolean; boundTab: string; json: Record<string, unknown> | null }> {
  const ctx = makePanelToolCtx(bridge(opts), TAB, new WorkflowTargetStore());
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
  return { text, isError: res.isError === true, boundTab: ctx.tabId, json };
}

beforeEach(() => {
  sent = [];
});

describe("an unacknowledged Power Lora row write is settled by a read (#2495)", () => {
  it("THE REPORTED CASE: times out after creating lora_1, then reports the row as applied", async () => {
    const out = await runSetWidget({
      writeReply: "timeout",
      probeWidgets: { lora_1: LORA_OBJECT },
    });

    expect(sent.map((s) => s.cmd)).toEqual(["graph_set_widget", "graph_query"]);
    expect(out.isError).toBe(false);
    expect(out.json).toMatchObject({
      applied: true,
      acknowledged: false,
      refresh_pending: true,
      created_widget: "lora_1",
      mutation_id: MUTATION_RID,
    });
    expect(out.text).toMatch(/CHECKED FOR YOU/);
    expect(out.text).toMatch(/not evidence the write failed/);
    expect(out.text).not.toMatch(/a blind retry can apply it twice/);
  });

  it("reports the write as NOT applied when the node has no lora_1 row", async () => {
    const out = await runSetWidget({ writeReply: "timeout", probeWidgets: "missing" });

    expect(sent.map((s) => s.cmd)).toEqual(["graph_set_widget", "graph_query"]);
    expect(out.isError).toBe(true);
    expect(out.json).toMatchObject({
      applied: false,
      acknowledged: false,
      mutation_id: MUTATION_RID,
    });
    expect(out.text).toMatch(/does NOT/);
    expect(out.text).toMatch(/lora_1/);
  });

  it("reports the write as NOT applied when the live row does not match the request", async () => {
    const out = await runSetWidget({
      writeReply: "timeout",
      probeWidgets: { lora_1: { on: true, lora: "other.safetensors", strength: 0.2 } },
    });

    expect(out.isError).toBe(true);
    expect(out.json).toMatchObject({ applied: false, mutation_id: MUTATION_RID });
    expect(out.text).toMatch(/does NOT/);
  });

  it("returns a mutation receipt when the settling read itself cannot answer", async () => {
    const out = await runSetWidget({ writeReply: "timeout", probeWidgets: "timeout" });

    expect(sent.map((s) => s.cmd)).toEqual(["graph_set_widget", "graph_query"]);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/may have been applied despite the missing reply/);
    expect(out.text).toMatch(/"applied": "unknown"/);
    expect(out.text).toMatch(new RegExp(`"mutation_id": "${MUTATION_RID}"`));
    expect(out.text).toMatch(/Do not guess/);
  });

  it("does not second-guess an ACKED executor error", async () => {
    const out = await runSetWidget({ writeReply: "acked-error" });

    expect(sent.map((s) => s.cmd)).not.toContain("graph_query");
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/not a JSON object/);
    expect(out.text).not.toMatch(/CHECKED FOR YOU/);
    expect(out.text).not.toMatch(/mutation_id/);
  });

  it("does not settle a same-named row on a different node type", async () => {
    const out = await runSetWidget({
      writeReply: "timeout",
      probeWidgets: { lora_1: LORA_OBJECT },
      probeType: "Some Other Loader",
    });

    expect(sent.map((s) => s.cmd)).toEqual(["graph_set_widget", "graph_query"]);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/\"applied\": \"unknown\"/);
    expect(out.text).toMatch(/Do not guess/);
    expect(out.text).not.toMatch(/CHECKED FOR YOU/);
  });

  it("does not settle an ACKED error reproducing the canonical sentence VERBATIM", async () => {
    const out = await runSetWidget({ writeReply: "acked-error-timeout-worded" });

    expect(out.text).toMatch(
      /did not reply to "graph_set_widget" within 90000 ms — the ComfyUI tab may be backgrounded or frozen/,
    );
    expect(sent.map((s) => s.cmd)).not.toContain("graph_query");
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/nothing was applied/);
    expect(out.text).not.toMatch(/CHECKED FOR YOU/);
  });

  it("claims nothing when the probe lands on a DIFFERENT tab", async () => {
    const out = await runSetWidget({
      writeReply: "timeout",
      probeWidgets: { lora_1: LORA_OBJECT },
      loseTabAfterWrite: true,
    });

    expect(out.boundTab).toBe(OTHER_TAB);
    expect(sent.some((s) => s.cmd === "graph_query")).toBe(true);
    expect(out.isError).toBe(true);
    expect(out.text).not.toMatch(/CHECKED FOR YOU/);
    expect(out.text).not.toMatch(/"applied": true/);
    expect(out.text).toMatch(/"applied": "unknown"/);
    expect(out.text).toMatch(new RegExp(`"mutation_id": "${MUTATION_RID}"`));
  });

  it("does not take a graph read on a successful ACK", async () => {
    const out = await runSetWidget({ writeReply: "ok" });

    expect(sent.map((s) => s.cmd)).toEqual(["graph_set_widget"]);
    expect(out.isError).toBe(false);
    expect(out.text).not.toMatch(/CHECKED FOR YOU/);
    expect(out.text).not.toMatch(/refresh_pending/);
  });

  it("does not settle an ordinary non-lora widget timeout", async () => {
    const out = await runSetWidget(
      { writeReply: "timeout", probeWidgets: { lora_1: LORA_OBJECT } },
      { node_id: NODE_ID, widget: "steps", value: 30 },
    );

    expect(sent.map((s) => s.cmd)).toEqual(["graph_set_widget"]);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/may have been applied despite the missing reply/);
    expect(out.text).not.toMatch(/CHECKED FOR YOU/);
  });
});
