// #2007 — panel mutations blocked by fixed /object_info timeouts on a healthy
// large install.
//
// Reported: panel_graph_outline succeeds with backend_socket=up and
// mutations_ready=true, then panel_add_node("LoadImage"), panel_refresh_nodes,
// and panel_set_widget all fail because /object_info did not answer inside the
// panel's fixed 10s/5s shares. The canvas is readable; schema-guarded edits are
// not. refresh_nodes also CLEARS the last-known schema, so calling it as the
// recovery makes the next widget write worse — except for #2202's stale-combo
// timeout, where the panel has already retired that snapshot and a refresh is
// the safe way to restore it for later unrelated writes.
//
// These drive the real tool defs. The panel's 5s/10s shares live in the other
// repo; this process can still (1) retry a before-create/before-write refusal
// without dispatching refresh_nodes, (2) stop advertising mutations_ready:true
// once that refusal has been observed, and (3) reserve refresh_nodes for the
// acknowledged #2202 stale-combo timeout where the panel has already retired
// its schema snapshot.

import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetPanelSchemaReadinessForTest,
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";

/** The reporter's exact panel_add_node refusal (issue #2007). */
const ADD_UNAVAILABLE =
  `cannot verify node type "LoadImage" against the ComfyUI backend ` +
  `(object_info is unavailable — the backend is unreachable or the fetch failed). ` +
  `Refusing to add rather than trust a possibly-stale node cache (#458). Reconnect ComfyUI and retry.`;

/** The reporter's exact panel_set_widget refusal (issue #2007). */
const SET_WIDGET_BUDGET =
  `Cannot set widget "text" on node 12: no usable /object_info schema was obtained. ` +
  `api.getNodeDefs() exceeded 10000ms share; GET /object_info exceeded 5000ms share; ` +
  `no whole schema observed.`;

const SET_WIDGET_STARVATION =
  `Cannot set widget on node 12 ("OpenAICompatibleLLM"): cannot verify the node type against the ` +
  `ComfyUI backend — no usable /object_info schema was obtained. Tried 2 routes: ` +
  `api.getNodeDefs() did not answer within its 10000ms share of the 20000ms budget; ` +
  `GET /object_info did not answer within its 5000ms share of the 20000ms budget. ` +
  `Refusing to write rather than trust a possibly-stale node cache (#458). ` +
  `Reconnect ComfyUI and retry.`;

const STALE_COMBO_REFRESH_TIMEOUT =
  `panel_set_widget refused "image" on node 12 (LoadImage): the value is not in this ` +
  `combo's current option list, and the authoritative refresh that would have re-read ` +
  `the list — a node-def refresh started by another tool call — was still running ` +
  `when this command's time budget ran out waiting for it, so the revalidation did NOT ` +
  `complete. That refresh is still running and is registering exactly the list this ` +
  `write needs, so RETRY in a few seconds. This refusal cannot tell a genuinely-invalid ` +
  `value from one the refresh would have accepted. NOTHING WAS WRITTEN. Call ` +
  `panel_refresh_nodes if retrying keeps failing.`;

const STALE_SCHEMA =
  `"LoadImage" required input "image" was added or retyped since this page loaded its node ` +
  `schema, so creating it now would build the OLD shape. Call panel_refresh_nodes and retry.`;

function textOf(res: ToolResult): string {
  return res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");
}

function parseJson(res: ToolResult): Record<string, unknown> {
  const text = res.content.find((c) => c.type === "text")?.text;
  return JSON.parse(text ?? "{}") as Record<string, unknown>;
}

function bridge(send: (cmd: Record<string, unknown>) => Promise<unknown>) {
  const calls: string[] = [];
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push(String(cmd.cmd));
      return send(cmd);
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  return { b, calls };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  send: (cmd: Record<string, unknown>) => Promise<unknown>,
): Promise<{ res: ToolResult; calls: string[]; text: string }> {
  const { b, calls } = bridge(send);
  const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`${name} is not registered`);
  const res = await def.handler(args as never, ctx);
  return { res, calls, text: textOf(res) };
}

beforeEach(() => {
  __resetPanelSchemaReadinessForTest();
});

describe("panel_add_node retries a schema-budget refusal without refresh_nodes (#2007)", () => {
  it("THE REPORTED CASE: LoadImage add that times out then succeeds on the retry", async () => {
    let adds = 0;
    const { res, calls, text } = await callTool(
      "panel_add_node",
      { class_type: "LoadImage" },
      async (cmd) => {
        if (cmd.cmd !== "graph_add_node") return { ok: true };
        adds += 1;
        if (adds === 1) throw new Error(ADD_UNAVAILABLE);
        return { ok: true, node_id: 20, type: "LoadImage" };
      },
    );

    expect(res.isError).toBeFalsy();
    expect(calls.filter((c) => c === "graph_add_node")).toHaveLength(2);
    expect(calls).not.toContain("refresh_nodes");
    expect(text).not.toMatch(/object_info is unavailable/);
    expect(JSON.stringify(parseJson(res))).toContain("LoadImage");
  });

  it("retries EXACTLY once — a still-timed-out add is not looped, and names the budget", async () => {
    const { res, calls, text } = await callTool(
      "panel_add_node",
      { class_type: "LoadImage" },
      async (cmd) => {
        if (cmd.cmd === "graph_add_node") throw new Error(ADD_UNAVAILABLE);
        return { ok: true };
      },
    );

    expect(res.isError).toBe(true);
    expect(calls.filter((c) => c === "graph_add_node")).toHaveLength(2);
    expect(calls).not.toContain("refresh_nodes");
    expect(text).toContain("object_info is unavailable");
    expect(text).toMatch(/already retried ONCE/);
    expect(text).toMatch(/Do NOT call panel_refresh_nodes/);
    expect(text).toMatch(/mutations_ready/);
    expect(text).not.toMatch(/FRONTEND-ONLY/);
  });

  it("does not retry a frontend-only type — that is #2000's note, not a second add", async () => {
    const markdown =
      `cannot verify node type "MarkdownNote" against the ComfyUI backend ` +
      `(object_info is unavailable — the backend is unreachable or the fetch failed). ` +
      `Refusing to add rather than trust a possibly-stale node cache (#458). Reconnect ComfyUI and retry.`;
    const { res, calls, text } = await callTool(
      "panel_add_node",
      { class_type: "MarkdownNote" },
      async (cmd) => {
        if (cmd.cmd === "graph_add_node") throw new Error(markdown);
        return { ok: true };
      },
    );

    expect(res.isError).toBe(true);
    expect(calls.filter((c) => c === "graph_add_node")).toHaveLength(1);
    expect(calls).not.toContain("refresh_nodes");
    expect(text).toMatch(/FRONTEND-ONLY/);
  });

  it("an UNRELATED failure is never retried", async () => {
    const { res, calls } = await callTool(
      "panel_add_node",
      { class_type: "LoadImage" },
      async (cmd) => {
        if (cmd.cmd === "graph_add_node") throw new Error("node id 12 is not on the canvas");
        return { ok: true };
      },
    );

    expect(res.isError).toBe(true);
    expect(calls.filter((c) => c === "graph_add_node")).toHaveLength(1);
    expect(calls).not.toContain("refresh_nodes");
  });

  it("the #1329 stale-schema path still dispatches refresh_nodes", async () => {
    let adds = 0;
    const { res, calls } = await callTool(
      "panel_add_node",
      { class_type: "LoadImage" },
      async (cmd) => {
        if (cmd.cmd === "refresh_nodes") return { refreshed: true };
        if (cmd.cmd !== "graph_add_node") return { ok: true };
        adds += 1;
        if (adds === 1) throw new Error(STALE_SCHEMA);
        return { ok: true, node_id: 20 };
      },
    );

    expect(res.isError).toBeFalsy();
    expect(calls).toEqual(["graph_add_node", "refresh_nodes", "graph_add_node"]);
  });
});

describe("panel_set_widget retries a schema-budget refusal (#2007)", () => {
  it("THE REPORTED CASE: share-timeout write then succeeds on the retry", async () => {
    let writes = 0;
    const { res, calls, text } = await callTool(
      "panel_set_widget",
      { node_id: 12, widget: "text", value: "hello" },
      async (cmd) => {
        if (cmd.cmd !== "graph_set_widget") return { ok: true };
        writes += 1;
        if (writes === 1) throw new Error(SET_WIDGET_BUDGET);
        return { ok: true, node_id: 12, widget: "text", previous: "", value: "hello" };
      },
    );

    expect(res.isError).toBeFalsy();
    expect(calls.filter((c) => c === "graph_set_widget")).toHaveLength(2);
    expect(calls).not.toContain("refresh_nodes");
    expect(text).not.toMatch(/no whole schema/);
  });

  it("retries EXACTLY once and says not to refresh_nodes", async () => {
    const { res, calls, text } = await callTool(
      "panel_set_widget",
      { node_id: 12, widget: "text", value: "hello" },
      async (cmd) => {
        if (cmd.cmd === "graph_set_widget") throw new Error(SET_WIDGET_BUDGET);
        return { ok: true };
      },
    );

    expect(res.isError).toBe(true);
    expect(calls.filter((c) => c === "graph_set_widget")).toHaveLength(2);
    expect(text).toMatch(/already retried ONCE/);
    expect(text).toMatch(/Do NOT call panel_refresh_nodes/);
  });

  it("#2202 restores schema after a stale-combo refresh timeout before an unrelated write", async () => {
    let writes = 0;
    const { b, calls } = bridge(async (cmd) => {
      if (cmd.cmd === "graph_set_widget") {
        writes += 1;
        if (writes === 1) throw new Error(STALE_COMBO_REFRESH_TIMEOUT);
        return { ok: true, node_id: 20, widget: "text", previous: "", value: "hello" };
      }
      if (cmd.cmd === "refresh_nodes") return { refreshed: true };
      return { ok: true };
    });
    const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
    const setWidget = buildPanelToolDefs().find((d) => d.name === "panel_set_widget");
    if (!setWidget) throw new Error("panel_set_widget is not registered");

    const combo = await setWidget.handler(
      { node_id: 12, widget: "image", value: "new.png" } as never,
      ctx,
    );
    expect(combo.isError).toBe(true);
    expect(textOf(combo)).toMatch(/#2202 recovery/);

    const unrelated = await setWidget.handler(
      { node_id: 20, widget: "text", value: "hello" } as never,
      ctx,
    );
    expect(unrelated.isError).toBeFalsy();
    expect(calls).toEqual(["graph_set_widget", "refresh_nodes", "graph_set_widget"]);
  });

  it("does not refresh for an ordinary combo-value refusal", async () => {
    const ordinaryRefusal =
      `panel_set_widget refused "image" on node 12 (LoadImage): after refreshing combo ` +
      `options: "new.png" is not a valid option`;
    const { b, calls } = bridge(async (cmd) => {
      if (cmd.cmd === "graph_set_widget") throw new Error(ordinaryRefusal);
      return { refreshed: true };
    });
    const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
    const setWidget = buildPanelToolDefs().find((d) => d.name === "panel_set_widget");
    if (!setWidget) throw new Error("panel_set_widget is not registered");

    const refused = await setWidget.handler(
      { node_id: 12, widget: "image", value: "new.png" } as never,
      ctx,
    );
    expect(refused.isError).toBe(true);
    expect(calls).toEqual(["graph_set_widget"]);
  });

  it("records a starvation refusal so the next outline does not advertise readiness", async () => {
    const { b } = bridge(async (cmd) => {
      if (cmd.cmd === "graph_set_widget") throw new Error(SET_WIDGET_STARVATION);
      if (cmd.cmd === "graph_outline") {
        return {
          outline: "12 OpenAICompatibleLLM",
          node_count: 1,
          backend_socket: "up",
          mutations_ready: true,
        };
      }
      return { ok: true };
    });
    const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
    const defs = buildPanelToolDefs();
    const setWidget = defs.find((d) => d.name === "panel_set_widget");
    const outline = defs.find((d) => d.name === "panel_graph_outline");
    if (!setWidget || !outline) throw new Error("tools missing");

    const refused = await setWidget.handler(
      { node_id: 12, widget: "system_prompt", value: "hello" } as never,
      ctx,
    );
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/refresh TIMEOUT, not a missing node/i);

    const next = parseJson(await outline.handler({} as never, ctx));
    expect(next.mutations_ready).toBe(false);
  });
});

describe("panel_refresh_nodes names a timed-out whole-schema fetch (#2007)", () => {
  it("THE REPORTED CASE: refreshed:false / object_info_fetch_failed is not a down backend", async () => {
    const { res, text } = await callTool("panel_refresh_nodes", {}, async (cmd) => {
      if (cmd.cmd === "refresh_nodes") {
        return { refreshed: false, reason: "object_info_fetch_failed" };
      }
      return { ok: true };
    });

    expect(res.isError).toBeFalsy();
    expect(text).toContain("object_info_fetch_failed");
    expect(text).toMatch(/CLEARS the last-known schema/i);
    expect(text).toMatch(/not down/i);
  });

  it("does not clear a blocked connection on a non-authoritative register failure", async () => {
    const { b } = bridge(async (cmd) => {
      if (cmd.cmd === "graph_add_node") throw new Error(ADD_UNAVAILABLE);
      if (cmd.cmd === "refresh_nodes") return { refreshed: false, reason: "register_failed" };
      if (cmd.cmd === "graph_outline") {
        return { outline: "12 LoadImage", node_count: 1, backend_socket: "up", mutations_ready: true };
      }
      return { ok: true };
    });
    const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
    const defs = buildPanelToolDefs();
    const add = defs.find((d) => d.name === "panel_add_node");
    const refresh = defs.find((d) => d.name === "panel_refresh_nodes");
    const outline = defs.find((d) => d.name === "panel_graph_outline");
    if (!add || !refresh || !outline) throw new Error("tools missing");

    await add.handler({ class_type: "LoadImage" } as never, ctx);
    await refresh.handler({} as never, ctx);

    expect(parseJson(await outline.handler({} as never, ctx)).mutations_ready).toBe(false);
  });
});

describe("panel_graph_outline does not keep advertising mutations_ready after a schema-budget miss (#2007)", () => {
  const outlineOk = {
    outline: "12 LoadImage",
    node_count: 19,
    backend_socket: "up",
    mutations_ready: true,
  };

  it("leaves mutations_ready:true when no schema-budget refusal has been observed", async () => {
    const { res } = await callTool("panel_graph_outline", {}, async (cmd) => {
      if (cmd.cmd === "graph_outline") return outlineOk;
      return { ok: true };
    });

    expect(res.isError).toBeFalsy();
    const payload = parseJson(res);
    expect(payload.mutations_ready).toBe(true);
    expect(payload.schema_ready).toBeUndefined();
  });

  it("THE REPORTED SEQUENCE: outline says ready, LoadImage add times out, next outline does not", async () => {
    const { b } = bridge(async (cmd) => {
      if (cmd.cmd === "graph_outline") return outlineOk;
      if (cmd.cmd === "graph_add_node") throw new Error(ADD_UNAVAILABLE);
      return { ok: true };
    });
    const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
    const defs = buildPanelToolDefs();
    const outline = defs.find((d) => d.name === "panel_graph_outline");
    const add = defs.find((d) => d.name === "panel_add_node");
    if (!outline || !add) throw new Error("tools missing");

    const first = parseJson(await outline.handler({} as never, ctx));
    expect(first.mutations_ready).toBe(true);
    expect(first.backend_socket).toBe("up");

    const added = await add.handler({ class_type: "LoadImage" } as never, ctx);
    expect(added.isError).toBe(true);

    const second = parseJson(await outline.handler({} as never, ctx));
    expect(second.mutations_ready).toBe(false);
    expect(second.schema_ready).toBe(false);
    expect(String(second.schema_ready_note)).toMatch(/Do not call panel_refresh_nodes/i);
    expect(second.backend_socket).toBe("up");
    expect(second.outline).toBe("12 LoadImage");
  });

  it("a later successful add restores mutations_ready on the next outline", async () => {
    let adds = 0;
    const { b } = bridge(async (cmd) => {
      if (cmd.cmd === "graph_outline") return outlineOk;
      if (cmd.cmd === "graph_add_node") {
        adds += 1;
        if (adds <= 2) throw new Error(ADD_UNAVAILABLE);
        return { ok: true, node_id: 21, type: "LoadImage" };
      }
      return { ok: true };
    });
    const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
    const defs = buildPanelToolDefs();
    const outline = defs.find((d) => d.name === "panel_graph_outline");
    const add = defs.find((d) => d.name === "panel_add_node");
    if (!outline || !add) throw new Error("tools missing");

    await add.handler({ class_type: "LoadImage" } as never, ctx);
    expect(parseJson(await outline.handler({} as never, ctx)).mutations_ready).toBe(false);

    const okAdd = await add.handler({ class_type: "LoadImage" } as never, ctx);
    expect(okAdd.isError).toBeFalsy();
    expect(parseJson(await outline.handler({} as never, ctx)).mutations_ready).toBe(true);
  });

  it("a frontend-only add does not prove backend schema readiness", async () => {
    const { b } = bridge(async (cmd) => {
      if (cmd.cmd === "graph_outline") return outlineOk;
      if (cmd.cmd === "graph_add_node" && cmd.class_type === "LoadImage") {
        throw new Error(ADD_UNAVAILABLE);
      }
      if (cmd.cmd === "graph_add_node" && cmd.class_type === "MarkdownNote") {
        return { ok: true, node_id: 30, type: "MarkdownNote" };
      }
      return { ok: true };
    });
    const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
    const defs = buildPanelToolDefs();
    const add = defs.find((d) => d.name === "panel_add_node");
    const outline = defs.find((d) => d.name === "panel_graph_outline");
    if (!add || !outline) throw new Error("tools missing");

    await add.handler({ class_type: "LoadImage" } as never, ctx);
    await add.handler({ class_type: "MarkdownNote" } as never, ctx);

    expect(parseJson(await outline.handler({} as never, ctx)).mutations_ready).toBe(false);
  });

  it("keys readiness to the live tab, not a stable scope route", async () => {
    const scope = "orchestrator::test";
    let liveTab = "panel-a";
    const calls: string[] = [];
    const b = {
      send: async (cmd: Record<string, unknown>) => {
        calls.push(String(cmd.cmd));
        if (cmd.cmd === "graph_add_node") throw new Error(ADD_UNAVAILABLE);
        if (cmd.cmd === "graph_outline") return outlineOk;
        return { ok: true };
      },
      push: () => 1,
      canReach: () => true,
      isHeadless: () => false,
      tabs: () => [{ tab_id: liveTab, title: liveTab, connected_at: 0 }],
      resolveSharedTabId: () => liveTab,
      resolveActiveTabId: () => liveTab,
      tabIncarnation: (tabId: string) => `${tabId}-incarnation`,
      tabCanMutateGraph: () => true,
      tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(b, scope, new WorkflowTargetStore());
    const defs = buildPanelToolDefs();
    const add = defs.find((d) => d.name === "panel_add_node");
    const outline = defs.find((d) => d.name === "panel_graph_outline");
    if (!add || !outline) throw new Error("tools missing");

    await add.handler({ class_type: "LoadImage" } as never, ctx);
    liveTab = "panel-b";

    expect(parseJson(await outline.handler({} as never, ctx)).mutations_ready).toBe(true);
    expect(calls.filter((cmd) => cmd === "graph_add_node")).toHaveLength(2);
  });
});
