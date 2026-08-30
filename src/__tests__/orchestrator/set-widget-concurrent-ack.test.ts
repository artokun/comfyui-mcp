// #2559 — six concurrent panel_set_widget calls applied their widget mutations
// but the combined MCP tool call never completed. The panel's WS listener is
// async-per-message and coalesces schema work; it applies each write immediately
// and only then ACKs. Holding the per-tab graph lane until that ACK meant the
// sixth write could never dispatch, so the frontend never flushed the coalesced
// replies and every waiter hung past the outer tools/call budget.
//
// The property under test is the SHIPPED tool: real panel_set_widget defs against
// a real UiBridge + a mock panel that applies on receive and ACKs every
// graph_set_widget together once six are in flight — the collision the live
// frontend exhibits. Each call must settle (resolve or reject), not hang.

import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { UiBridge } from "../../services/ui-bridge.js";
import { buildPanelToolDefs, makePanelToolCtx, type ToolResult } from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import { waitFor } from "../helpers/wait-for.js";

const TAB = "wf:workflows/video_minimax_h3_i2v.json";
const WORKFLOW_UUID = "11111111-1111-4111-8111-111111111111";
const WRITES = [
  { node_id: 1, widget: "text", value: "a" },
  { node_id: 2, widget: "text", value: "b" },
  { node_id: 3, widget: "text", value: "c" },
  { node_id: 4, widget: "text", value: "d" },
  { node_id: 5, widget: "text", value: "e" },
  { node_id: 6, widget: "text", value: "f" },
] as const;

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
          title: "video_minimax_h3_i2v",
          tab_session_id: "browser-tab-2559",
          enforces_workflow_stamp: true,
          enforces_workflow_stamp_at_write: true,
          enforces_expected_node_type_at_write: true,
        }),
      );
      resolve(sock);
    });
    sock.on("error", reject);
  });
}

function viewing() {
  return { scope: "root", kind: "root", workflow: "video_minimax_h3_i2v.json", workflow_uuid: WORKFLOW_UUID };
}

function ordinaryNode(id: unknown) {
  return {
    id,
    type: "CLIPTextEncode",
    is_subgraph: false,
    node_identity: `node:${String(id)}`,
    widgets: { text: "old" },
  };
}

function replyQuery(msg: Record<string, unknown>): Record<string, unknown> {
  const ids = Array.isArray(msg.ids) ? msg.ids : [msg.node_id ?? 1];
  const id = ids[0];
  return {
    viewing: viewing(),
    truncated: false,
    nodes: [ordinaryNode(id)],
    node_count: 1,
  };
}

function setWidgetResult(msg: Record<string, unknown>): Record<string, unknown> {
  return {
    set: {
      node_id: msg.node_id,
      widget: msg.widget,
      previous: "old",
      value: msg.value,
    },
  };
}

/** Apply every graph_set_widget immediately; ACK them only once six are in flight.
 *  Reads/preflight commands reply at once so promotion probes cannot stall the batch. */
function attachCoalescingPanel(sock: WebSocket): { applied: Array<Record<string, unknown>> } {
  const applied: Array<Record<string, unknown>> = [];
  const pendingWrites: Array<Record<string, unknown>> = [];
  const flushWrites = () => {
    for (const msg of pendingWrites.splice(0)) {
      if (typeof msg.rid !== "string") continue;
      sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: setWidgetResult(msg) }));
    }
  };
  sock.on("message", (buf) => {
    const msg = JSON.parse(buf.toString()) as Record<string, unknown>;
    if (typeof msg.rid !== "string" || typeof msg.cmd !== "string") return;
    if (msg.cmd === "graph_set_widget") {
      applied.push({ node_id: msg.node_id, widget: msg.widget, value: msg.value });
      pendingWrites.push(msg);
      if (pendingWrites.length >= WRITES.length) flushWrites();
      return;
    }
    const result =
      msg.cmd === "graph_query"
        ? replyQuery(msg)
        : msg.cmd === "graph_get_subgraph"
          ? {
              viewing: viewing(),
              truncated: false,
              node_count: 1,
              nodes: [ordinaryNode(msg.node_id ?? 1)],
            }
          : { ok: true };
    sock.send(JSON.stringify({ rid: msg.rid, ok: true, result }));
  });
  return { applied };
}

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} is not registered`);
  return def;
}

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

async function settleSoon<T>(p: Promise<T>, ms = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`did not settle within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

beforeEach(async () => {
  await startBridge();
});

afterEach(async () => {
  await bridge.stop();
});

describe("concurrent panel_set_widget settlement (#2559)", () => {
  it("each of six concurrent writes settles after the frontend acks the coalesced batch", async () => {
    const sock = await connectPanel();
    const { applied } = attachCoalescingPanel(sock);
    await waitFor(() => expect(bridge.canReach(TAB)).toBe(true));

    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const setWidget = defByName("panel_set_widget");
    const results = await settleSoon(
      Promise.all(WRITES.map((args) => setWidget.handler({ ...args } as never, ctx))),
    );

    expect(applied).toHaveLength(WRITES.length);
    expect(results).toHaveLength(WRITES.length);
    for (const res of results) {
      expect(res.isError).not.toBe(true);
      expect(textOf(res)).not.toMatch(/did not reply/);
      expect(textOf(res)).not.toMatch(/did not settle/);
      const payload = JSON.parse(textOf(res)) as { set?: { value?: unknown } };
      expect(payload.set?.value).toBeDefined();
    }
    sock.close();
  });

  it("coalesced ACKs that reuse one rid still settle every in-flight graph_set_widget", async () => {
    const sock = await connectPanel();
    const pending: Array<Record<string, unknown>> = [];
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString()) as Record<string, unknown>;
      if (typeof msg.rid !== "string" || typeof msg.cmd !== "string") return;
      if (msg.cmd !== "graph_set_widget") {
        sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { ok: true } }));
        return;
      }
      pending.push(msg);
      if (pending.length < WRITES.length) return;
      const sharedRid = pending[0]?.rid;
      for (const frame of pending) {
        sock.send(
          JSON.stringify({
            rid: sharedRid,
            ok: true,
            result: setWidgetResult(frame),
          }),
        );
      }
    });
    await waitFor(() => expect(bridge.canReach(TAB)).toBe(true));

    const settled = await settleSoon(
      Promise.all(
        WRITES.map((args) =>
          bridge.send(
            { cmd: "graph_set_widget", node_id: args.node_id, widget: args.widget, value: args.value },
            { tabId: TAB, timeoutMs: 800 },
          ),
        ),
      ),
    );

    expect(settled).toHaveLength(WRITES.length);
    for (const result of settled) {
      expect(result).toMatchObject({ set: { widget: "text" } });
    }
    sock.close();
  });
});
