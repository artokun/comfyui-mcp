// #2537 — panel_run fails with the bare frontend throw
// "Dynamic widget doesn't exist on node" on the first queue after graph edits,
// then an identical retry a few seconds later succeeds. The throw is
// graphToPrompt racing a COMFY_DYNAMICCOMBO_V3 widget rebuild (SaveVideo
// format.codec, MinimaxH3LatentUpscaler3D mode.scale); it happens BEFORE
// /prompt is posted, so the first dispatch queued nothing.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPanelToolDefs,
  __panelRunTestHooks,
  __panelToolsTestHooks,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { RunCompletions } from "../../orchestrator/run-completion-journal.js";

const DYNAMIC_WIDGET = "Dynamic widget doesn't exist on node";
const WRAPPED =
  `NOT queued: this workflow could not be serialized into a prompt because ` +
  `graphToPrompt threw. The frontend serializer reported: "${DYNAMIC_WIDGET}". ` +
  `Nothing was queued and the queue is untouched. This is the ComfyUI frontend ` +
  `or an extension's serializer error, not evidence that a node type is missing; ` +
  `inspect the named widget or extension before retrying.`;

function panelRun() {
  const def = buildPanelToolDefs().find((candidate) => candidate.name === "panel_run");
  if (!def) throw new Error("panel_run tool not found");
  return def;
}

function textOf(res: ToolResult): string {
  return (res.content ?? [])
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** A ctx whose graph_run replies are scripted per attempt. */
function runCtx(replies: Array<Record<string, unknown>>): {
  ctx: PanelToolCtx;
  runs: Record<string, unknown>[];
} {
  const runs: Record<string, unknown>[] = [];
  const ctx: PanelToolCtx = {
    call: async (cmd) => {
      if (cmd.cmd !== "graph_run") return { content: [{ type: "text", text: "{}" }] };
      const reply = replies[runs.length] ?? { queued: true };
      runs.push(cmd);
      if (typeof reply.__throw === "string") throw new Error(reply.__throw);
      if (typeof reply.__error === "string") {
        return { content: [{ type: "text", text: `Error: ${reply.__error}` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(reply) }] };
    },
    confirm: async () => "yes" as const,
    bridge: {} as PanelToolCtx["bridge"],
    tabId: "t-2537",
  };
  return { ctx, runs };
}

beforeEach(() => {
  RunCompletions.reset();
  __panelToolsTestHooks.setRetrySettleMs(0);
});

afterEach(() => {
  __panelToolsTestHooks.setRetrySettleMs(null);
  RunCompletions.reset();
});

describe("panel_run dynamic-widget serializer race (#2537)", () => {
  it("re-issues a full-graph run EXACTLY ONCE after the bare frontend throw", async () => {
    const { ctx, runs } = runCtx([
      { __error: DYNAMIC_WIDGET },
      { queued: true, prompt_id: "p-2537" },
    ]);
    const res = await panelRun().handler({}, ctx);

    expect(res.isError).toBeFalsy();
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ cmd: "graph_run" });
    expect(runs[1]?.to_node_id).toBeUndefined();
    expect(textOf(res)).toMatch(/re-issued once/i);
    expect(textOf(res)).toMatch(/nothing was queued/i);
    expect(RunCompletions.ticketFor("p-2537")).toBeDefined();
  });

  it("re-issues a scoped run the same way — the race is not full-graph-only", async () => {
    const { ctx, runs } = runCtx([
      { __error: DYNAMIC_WIDGET },
      { queued: true, prompt_id: "p-2537-scoped" },
    ]);
    const res = await panelRun().handler({ to_node_id: 202 }, ctx);

    expect(res.isError).toBeFalsy();
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ cmd: "graph_run", to_node_id: 202 });
  });

  it("also retries the panel's NOT queued / graphToPrompt wrap (#1654)", async () => {
    const { ctx, runs } = runCtx([
      { __error: WRAPPED },
      { queued: true, prompt_id: "p-1654" },
    ]);
    const res = await panelRun().handler({}, ctx);

    expect(res.isError).toBeFalsy();
    expect(runs).toHaveLength(2);
  });

  it("retries a parsed JSON error carrying the same throw", async () => {
    const { ctx, runs } = runCtx([
      { queued: false, error: DYNAMIC_WIDGET },
      { queued: true, prompt_id: "p-json" },
    ]);
    const res = await panelRun().handler({}, ctx);

    expect(res.isError).toBeFalsy();
    expect(runs).toHaveLength(2);
  });

  it("caps recovery at one retry and tells the caller they MAY re-issue without retry_of", async () => {
    const { ctx, runs } = runCtx([
      { __error: DYNAMIC_WIDGET },
      { __error: DYNAMIC_WIDGET },
      { queued: true, prompt_id: "must-not-dispatch" },
    ]);
    const res = await panelRun().handler({}, ctx);
    const text = textOf(res);

    expect(res.isError).toBe(true);
    expect(runs).toHaveLength(2);
    expect(text).toContain(DYNAMIC_WIDGET);
    expect(text).toMatch(/SECOND dispatch/i);
    expect(text).toMatch(/You MAY re-issue panel_run/i);
    expect(text).toMatch(/do NOT pass retry_of/i);
    expect(text).not.toContain("must-not-dispatch");
  });

  it("does NOT retry an unrelated thrown queuePrompt (#248)", async () => {
    const { ctx, runs } = runCtx([
      {
        __error:
          "app.queuePrompt failed:\nTypeError: Cannot read properties of undefined (reading 'output')",
      },
      { queued: true, prompt_id: "must-not-dispatch" },
    ]);
    const res = await panelRun().handler({}, ctx);

    expect(res.isError).toBe(true);
    expect(runs).toHaveLength(1);
    expect(textOf(res)).not.toMatch(/re-issued/i);
  });

  it("does NOT retry a validation failure", async () => {
    const { ctx, runs } = runCtx([
      {
        node_errors: {
          "5": { class_type: "KSampler", errors: [{ message: "bad seed" }] },
        },
      },
      { queued: true },
    ]);
    const res = await panelRun().handler({}, ctx);

    expect(res.isError).toBe(true);
    expect(runs).toHaveLength(1);
  });

  it("STRUCTURED queue evidence vetoes the throw — queued:true never retries", async () => {
    const { ctx, runs } = runCtx([
      { queued: true, error: DYNAMIC_WIDGET },
      { queued: true, prompt_id: "must-not-dispatch" },
    ]);
    const res = await panelRun().handler({}, ctx);

    expect(res.isError).toBe(true);
    expect(runs).toHaveLength(1);
  });

  it("a reported prompt_id also vetoes the retry", async () => {
    const { ctx, runs } = runCtx([
      { error: DYNAMIC_WIDGET, prompt_id: "p-already-queued" },
      { queued: true },
    ]);
    const res = await panelRun().handler({}, ctx);

    expect(res.isError).toBe(true);
    expect(runs).toHaveLength(1);
  });

  it("does NOT retry a timeout wrapper that merely quotes the phrase", async () => {
    const timeout =
      `the panel tab "wf:workflows/a.json" did not reply to "graph_run" within 20000ms ` +
      `(the last panel error was: ${DYNAMIC_WIDGET}); retry_of:"rid-timeout"`;
    const { ctx, runs } = runCtx([{ __error: timeout }, { queued: true }]);
    const res = await panelRun().handler({}, ctx);

    expect(res.isError).toBe(true);
    expect(runs).toHaveLength(1);
  });

  it("a THROWING second dispatch reports both facts instead of destroying them", async () => {
    const { ctx, runs } = runCtx([
      { __error: DYNAMIC_WIDGET },
      { __throw: "socket exploded" },
    ]);
    const res = await panelRun().handler({}, ctx);
    const text = textOf(res);

    expect(res.isError).toBe(true);
    expect(runs).toHaveLength(2);
    expect(text).toMatch(/outcome is UNKNOWN and it may have queued a render/);
    expect(text).toMatch(/FIRST dispatch threw inside graphToPrompt/);
    expect(text).toMatch(/queued nothing/);
    expect(text).toMatch(/socket exploded/);
  });

  it("waits before re-dispatching instead of racing in the same tick", async () => {
    __panelToolsTestHooks.setRetrySettleMs(40);
    const { ctx, runs } = runCtx([
      { __error: DYNAMIC_WIDGET },
      { queued: true, prompt_id: "p-settle" },
    ]);
    const started = Date.now();
    const res = await panelRun().handler({}, ctx);

    expect(res.isError).toBeFalsy();
    expect(runs).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });

  it("the classifier itself refuses unknown outcomes and queue evidence", () => {
    const throwRes: ToolResult = {
      content: [{ type: "text", text: `Error: ${DYNAMIC_WIDGET}` }],
      isError: true,
    };
    const wrapped: ToolResult = {
      content: [{ type: "text", text: `Error: ${WRAPPED}` }],
      isError: true,
    };
    const jsonErr: ToolResult = {
      content: [{ type: "text", text: JSON.stringify({ error: DYNAMIC_WIDGET }) }],
    };
    const queued: ToolResult = {
      content: [{ type: "text", text: JSON.stringify({ queued: true, error: DYNAMIC_WIDGET }) }],
    };
    const timeout: ToolResult = {
      content: [
        {
          type: "text",
          text: `Error: the panel tab "x" did not reply to "graph_run" (${DYNAMIC_WIDGET})`,
        },
      ],
      isError: true,
    };
    const unrelated: ToolResult = {
      content: [{ type: "text", text: "Error: app.queuePrompt failed" }],
      isError: true,
    };

    expect(__panelRunTestHooks.isRetryableDynamicWidgetRace(throwRes, throwRes)).toBe(true);
    expect(__panelRunTestHooks.isRetryableDynamicWidgetRace(wrapped, wrapped)).toBe(true);
    expect(__panelRunTestHooks.isRetryableDynamicWidgetRace(jsonErr, jsonErr)).toBe(true);
    expect(__panelRunTestHooks.isRetryableDynamicWidgetRace(queued, queued)).toBe(false);
    expect(__panelRunTestHooks.isRetryableDynamicWidgetRace(timeout, timeout)).toBe(false);
    expect(__panelRunTestHooks.isRetryableDynamicWidgetRace(unrelated, unrelated)).toBe(false);
  });
});
