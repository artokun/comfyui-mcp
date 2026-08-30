// #2527 — panel_set_widget can time out after the command was already
// delivered. An immediate panel_query_graph then echoes the pre-write value,
// a retry_of is rejected as a different command or workflow, and a later
// ordinary write reports the timed-out value as `previous`.
//
// The shipped tools against a real UiBridge must (a) wait for that settlement
// or disclose the outstanding mutation on the graph read, and (b) answer
// retry_of from the exact delivered receipt once the frontend has settled.

import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { UiBridge } from "../../services/ui-bridge.js";
import {
  __panelToolsTestHooks,
  buildPanelToolDefs,
  makePanelToolCtx,
  RETRY_TOKEN_CMDS,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import { waitFor } from "../helpers/wait-for.js";

const TAB = "wf:workflows/Wan Animate 720x1280 49f Test.json";
const WORKFLOW_UUID = "11111111-1111-4111-8111-111111111111";
const NODE_ID = 44;
const WIDGET = "block_size";
const OLD_VALUE = 8;
const NEW_VALUE = 12;

let bridge: UiBridge;
let port: number;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = addr && typeof addr === "object" ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(p)));
    });
  });
}

async function startBridge(): Promise<void> {
  let lastErr = "no attempt made";
  for (let attempt = 0; attempt < 6; attempt++) {
    port = await freePort();
    bridge = new UiBridge(port);
    bridge.start();
    if (await bridge.whenReady()) {
      bridge.setTabWorkflowUuidResolver(() => WORKFLOW_UUID);
      bridge.setLateMutationFilter((cmdName) => RETRY_TOKEN_CMDS.has(cmdName));
      return;
    }
    lastErr = `bind to ${port} lost a close→rebind race`;
    await bridge.stop();
  }
  throw new Error(`could not bind a free bridge port after 6 attempts: ${lastErr}`);
}

function connectPanel(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    sock.on("open", () => {
      sock.send(
        JSON.stringify({
          type: "hello",
          tab_id: TAB,
          title: "Wan Animate",
          tab_session_id: "browser-tab-2527",
          enforces_workflow_stamp: true,
          enforces_workflow_stamp_at_write: true,
          enforces_expected_node_type_at_write: true,
          enforces_expected_node_identity_at_write: true,
        }),
      );
      resolve(sock);
    });
    sock.on("error", reject);
  });
}

function viewing() {
  return {
    scope: "root",
    kind: "root",
    workflow: "Wan Animate.json",
    workflow_uuid: WORKFLOW_UUID,
    graph_identity: "graph:root-2527",
  };
}

function nodeAt(value: number) {
  return {
    id: NODE_ID,
    type: "WanVideoBlockSwap",
    is_subgraph: false,
    node_identity: `node:${NODE_ID}`,
    widgets: { [WIDGET]: value },
  };
}

function textOf(res: ToolResult): string {
  return res.content.map((c) => ("text" in c ? (c.text ?? "") : "")).join(" ");
}

function ridFromHint(text: string): string | undefined {
  return /retry_of:"([^"]+)"/.exec(text)?.[1];
}

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} is not registered`);
  return def;
}

/** Production panel_set_widget passes the 90s refresh budget; the race under
 *  test is independent of that number, so the write's reply window is shrunk. */
function fastCtx(): PanelToolCtx {
  const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
  const inner = ctx.call.bind(ctx);
  ctx.call = (cmd, timeoutMs, onDispatchedRid, beforeDispatch, options) =>
    inner(
      cmd,
      typeof cmd.cmd === "string" && cmd.cmd === "graph_set_widget" ? 80 : timeoutMs,
      onDispatchedRid,
      beforeDispatch,
      options,
    );
  return ctx;
}

type ScriptedPanel = {
  applied: number;
  writes: Array<Record<string, unknown>>;
};

function attachPanel(
  sock: WebSocket,
  opts: { applyDelayMs: number | null; rejectRetryAfterApply?: boolean },
): ScriptedPanel {
  const state = { applied: OLD_VALUE, writes: [] as Array<Record<string, unknown>> };
  let pendingWrite: Record<string, unknown> | null = null;
  const applyPending = () => {
    if (!pendingWrite || typeof pendingWrite.rid !== "string") return;
    state.applied = NEW_VALUE;
    sock.send(
      JSON.stringify({
        rid: pendingWrite.rid,
        ok: true,
        result: {
          set: {
            node_id: pendingWrite.node_id,
            widget: pendingWrite.widget,
            previous: OLD_VALUE,
            value: NEW_VALUE,
          },
        },
      }),
    );
    pendingWrite = null;
  };
  sock.on("message", (buf) => {
    const raw: unknown = JSON.parse(buf.toString());
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const msg: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) msg[key] = value;
    if (typeof msg.rid !== "string" || typeof msg.cmd !== "string") return;
    if (msg.cmd === "graph_set_widget") {
      state.writes.push(msg);
      if (opts.rejectRetryAfterApply && msg.retry_of && state.applied === NEW_VALUE) {
        sock.send(
          JSON.stringify({
            rid: msg.rid,
            ok: false,
            error: "retry_of refers to a different command or workflow.",
          }),
        );
        return;
      }
      pendingWrite = msg;
      if (opts.applyDelayMs === null) return;
      setTimeout(applyPending, opts.applyDelayMs);
      return;
    }
    const result =
      msg.cmd === "graph_query"
        ? {
            viewing: viewing(),
            truncated: false,
            nodes: [nodeAt(state.applied)],
            node_count: 1,
          }
        : msg.cmd === "graph_get_subgraph"
          ? {
              viewing: viewing(),
              truncated: false,
              node_count: 1,
              nodes: [nodeAt(state.applied)],
            }
          : { ok: true };
    sock.send(JSON.stringify({ rid: msg.rid, ok: true, result }));
  });
  return {
    get applied() {
      return state.applied;
    },
    get writes() {
      return state.writes;
    },
  };
}

beforeEach(async () => {
  await startBridge();
});

afterEach(async () => {
  __panelToolsTestHooks.setOutstandingMutationReadSettleMs(null);
  await bridge.stop();
});

describe("late panel_set_widget timeout vs stale graph read (#2527)", () => {
  it("a graph read after the timeout waits for the late apply instead of echoing the old value", async () => {
    const sock = await connectPanel();
    attachPanel(sock, { applyDelayMs: 160 });
    await waitFor(() => expect(bridge.canReach(TAB)).toBe(true));
    const ctx = fastCtx();

    const first = await defByName("panel_set_widget").handler(
      { node_id: NODE_ID, widget: WIDGET, value: NEW_VALUE },
      ctx,
    );
    expect(first.isError, textOf(first)).toBe(true);
    expect(textOf(first)).toMatch(/did not reply to "graph_set_widget"/);
    expect(ridFromHint(textOf(first))).toBeTruthy();

    const read = await defByName("panel_query_graph").handler(
      { ids: [NODE_ID], fields: "detail", limit: 1 },
      ctx,
    );
    expect(read.isError, textOf(read)).not.toBe(true);
    expect(textOf(read)).toContain(String(NEW_VALUE));
    expect(textOf(read)).not.toMatch(/"block_size": 8/);
    expect(textOf(read)).not.toMatch(/OUTCOME UNKNOWN: \d+ delivered mutation/);
    sock.close();
  });

  it("discloses an outstanding outcome-unknown mutation when the frontend has not settled", async () => {
    __panelToolsTestHooks.setOutstandingMutationReadSettleMs(80);
    const sock = await connectPanel();
    attachPanel(sock, { applyDelayMs: null });
    await waitFor(() => expect(bridge.canReach(TAB)).toBe(true));
    const ctx = fastCtx();

    const first = await defByName("panel_set_widget").handler(
      { node_id: NODE_ID, widget: WIDGET, value: NEW_VALUE },
      ctx,
    );
    expect(first.isError).toBe(true);
    const hintRid = ridFromHint(textOf(first));
    expect(hintRid).toBeTruthy();

    const read = await defByName("panel_query_graph").handler(
      { ids: [NODE_ID], fields: "detail", limit: 1 },
      ctx,
    );
    expect(read.isError, textOf(read)).not.toBe(true);
    expect(textOf(read)).toMatch(/OUTCOME UNKNOWN: 1 delivered mutation/);
    expect(textOf(read)).toContain(`retry_of:"${hintRid}"`);
    expect(textOf(read)).toContain("graph_set_widget");
    expect(textOf(read)).toMatch(/may show values from before those writes applied/);
    sock.close();
  });

  it("retry_of of the exact delivered write succeeds after a late frontend reply", async () => {
    const sock = await connectPanel();
    const panel = attachPanel(sock, { applyDelayMs: 120, rejectRetryAfterApply: true });
    await waitFor(() => expect(bridge.canReach(TAB)).toBe(true));
    const ctx = fastCtx();

    const first = await defByName("panel_set_widget").handler(
      { node_id: NODE_ID, widget: WIDGET, value: NEW_VALUE },
      ctx,
    );
    const hintRid = ridFromHint(textOf(first));
    expect(hintRid).toBeTruthy();

    await waitFor(() => {
      expect(hintRid && bridge.peekLateMutation(hintRid)).toBeTruthy();
    });
    expect(panel.applied).toBe(NEW_VALUE);
    const writesBeforeRetry = panel.writes.length;

    const retry = await defByName("panel_set_widget").handler(
      { node_id: NODE_ID, widget: WIDGET, value: NEW_VALUE, retry_of: hintRid },
      ctx,
    );
    expect(retry.isError, textOf(retry)).not.toBe(true);
    expect(textOf(retry)).not.toMatch(/different command or workflow/);
    expect(textOf(retry)).toMatch(/DID complete|block_size|"value": 12/);
    expect(panel.writes.length, "settled retry_of must not re-dispatch").toBe(writesBeforeRetry);
    sock.close();
  });
});
