// panel#1292 — `panel_set_workflow_target({mode:"current"})` reported
// `graph_binding:"bound"` from the workflow-instance fence, then the next
// `panel_graph_outline` / `panel_set_todo` failed because the turn-origin pin
// was still `null` (`issued from multiple workflows at once`).
//
// Same class as panel#888, which only fixed `mode:"pinned"`. Two holes:
//   1. Same-batch siblings start while the pin is still null, even if the bind
//      later recovers it.
//   2. `bound` can be emitted from the fence even when `repinScopeToActive`
//      declined.
//
// Contract: after this tool reports `graph_binding:"bound"`, `resolvedPinOf`
// for that conversation is a live tab, not `null`. Tests drive the shipped
// UiBridge + panel-tools + TurnOriginTracker path — not a source-text grep.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import WebSocket from "ws";

import { UiBridge } from "../../services/ui-bridge.js";
import { SHARED_SESSION_SCOPE } from "../../services/session-scope.js";
import {
  TurnOriginTracker,
  makeScopeRepinHandler,
  makeScopeTargetResolver,
} from "../../orchestrator/turn-origins.js";
import { buildPanelToolDefs, makePanelToolCtx, type ToolResult } from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import { waitFor } from "../helpers/wait-for.js";

const SCOPE_KEY = `${SHARED_SESSION_SCOPE}::claude`;
const TAB_A = "wf:tab-one:workflows/a.json";
const TAB_B = "wf:tab-two:workflows/b.json";
const TAB_C = "wf:tab-three:workflows/c.json";
const PATH_A = "workflows/a.json";
const UUID = "11111111-1111-4111-8111-111111111111";

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join("\n");

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

async function startBridge(): Promise<{ bridge: UiBridge; port: number }> {
  let lastErr = "no attempt made";
  for (let attempt = 0; attempt < 6; attempt++) {
    const p = await freePort();
    const b = new UiBridge(p);
    b.start();
    if (await b.whenReady()) return { bridge: b, port: p };
    lastErr = `bind to ${p} lost a close→rebind race`;
    await b.stop();
  }
  throw new Error(`could not bind a free bridge port after 6 attempts: ${lastErr}`);
}

function connectPanel(port: number, tabId: string, title: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    sock.on("open", () => {
      sock.send(
        JSON.stringify({
          type: "hello",
          tab_id: tabId,
          title,
          enforces_workflow_stamp: true,
          enforces_workflow_stamp_at_write: true,
        }),
      );
      resolve(sock);
    });
    sock.on("error", reject);
  });
}

function autoReply(sock: WebSocket, tag: string, path: string): void {
  sock.on("message", (buf) => {
    const msg = JSON.parse(buf.toString());
    if (!msg.rid || !msg.cmd) return;
    if (msg.cmd === "workflow_list") {
      sock.send(
        JSON.stringify({
          rid: msg.rid,
          ok: true,
          result: {
            active: {
              path,
              routing_key: `wf:${path}`,
              workflow_uuid: UUID,
              active: true,
            },
            workflows: [
              {
                path,
                routing_key: `wf:${path}`,
                workflow_uuid: UUID,
                active: true,
              },
            ],
          },
        }),
      );
      return;
    }
    sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { from: tag, cmd: msg.cmd } }));
  });
}

describe("panel#1292 mode:'current' recovers the turn pin before claiming bound", () => {
  let bridge: UiBridge;
  let port: number;
  let tracker: TurnOriginTracker;
  let tabBackends: Map<string, string>;

  beforeEach(async () => {
    ({ bridge, port } = await startBridge());
    bridge.setTabWorkflowUuidResolver(() => UUID);
    tabBackends = new Map();
    const backendOfKey = (key: string): string =>
      key.includes("::") ? key.slice(key.lastIndexOf("::") + 2) : "claude";
    const backendForTab = (tab: string): string => tabBackends.get(tab) ?? "claude";
    tracker = new TurnOriginTracker({
      backendForTab,
      backendOfKey,
      uuidOfTab: () => UUID,
      liveTabOf: (tab) => bridge.liveTabIdFor(tab),
      warn: () => {},
    });
    const scopeAgentKeyOf = (scopeId: string): string =>
      scopeId === SHARED_SESSION_SCOPE ? SCOPE_KEY : scopeId;
    bridge.setScopeTargetResolver(makeScopeTargetResolver({ tracker, scopeAgentKeyOf }));
    bridge.setScopeRepinHandler(
      makeScopeRepinHandler({
        bridge,
        tracker,
        scopeAgentKeyOf,
        backendForTab,
        backendOfKey,
        info: () => {},
      }),
    );
  });

  afterEach(async () => {
    await bridge.stop();
  });

  async function pinAmbiguous(tabs: string[]): Promise<void> {
    tabs.forEach((tab, i) => {
      tracker.recordForMid(`m-${i}`, UUID, tab);
      tracker.onSeen(SCOPE_KEY, `m-${i}`);
    });
    await waitFor(() => expect(tracker.pinOf(SCOPE_KEY)).toBeNull());
  }

  function tools() {
    const defs = buildPanelToolDefs();
    const ctx = makePanelToolCtx(bridge, SCOPE_KEY, new WorkflowTargetStore());
    return {
      ctx,
      setTarget: defs.find((d) => d.name === "panel_set_workflow_target")!,
      outline: defs.find((d) => d.name === "panel_graph_outline")!,
      setTodo: defs.find((d) => d.name === "panel_set_todo")!,
    };
  }

  it("same-batch panel_graph_outline does not fail ambiguous while mode:current recovers the pin", async () => {
    const a = await connectPanel(port, TAB_A, "a");
    const b = await connectPanel(port, TAB_B, "b");
    autoReply(a, "tab-a", PATH_A);
    autoReply(b, "tab-b", "workflows/b.json");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(2));
    a.send(JSON.stringify({ type: "user_message", text: "from a" }));
    await waitFor(() => expect(bridge.resolveActiveScopeTab()).toBe(TAB_A));
    await pinAmbiguous([TAB_A, TAB_B]);

    const { ctx, setTarget, outline } = tools();
    // Outline first: it hits the null pin, then waits for the bind in this batch.
    const outlineP = outline.handler({}, ctx);
    const bindP = setTarget.handler({ mode: "current" }, ctx);
    const [outlineRes, bindRes] = await Promise.all([outlineP, bindP]);

    expect(tracker.resolvedPinOf(SCOPE_KEY), "the bind must recover the turn pin").toBe(TAB_A);
    expect(bridge.canReach(SCOPE_KEY)).toBe(true);
    expect(outlineRes.isError, textOf(outlineRes as ToolResult)).toBeFalsy();
    expect(textOf(outlineRes as ToolResult)).not.toContain("issued from multiple workflows at once");
    const bindText = textOf(bindRes as ToolResult);
    if (bindText.includes('"graph_binding": "bound"') || bindText.includes('"graph_binding":"bound"')) {
      expect(typeof tracker.resolvedPinOf(SCOPE_KEY)).toBe("string");
      expect(tracker.resolvedPinOf(SCOPE_KEY)).not.toBeNull();
    }
    expect(bindRes.isError, bindText).toBeFalsy();
    a.close();
    b.close();
  });

  it("same-batch panel_set_todo rides the same recovery", async () => {
    const a = await connectPanel(port, TAB_A, "a");
    const b = await connectPanel(port, TAB_B, "b");
    autoReply(a, "tab-a", PATH_A);
    autoReply(b, "tab-b", "workflows/b.json");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(2));
    a.send(JSON.stringify({ type: "user_message", text: "from a" }));
    await waitFor(() => expect(bridge.resolveActiveScopeTab()).toBe(TAB_A));
    await pinAmbiguous([TAB_A, TAB_B]);

    const { ctx, setTarget, setTodo } = tools();
    const todoP = setTodo.handler({ items: [{ text: "x", status: "pending" }] }, ctx);
    const bindP = setTarget.handler({ mode: "current" }, ctx);
    const [todoRes, bindRes] = await Promise.all([todoP, bindP]);

    expect(tracker.resolvedPinOf(SCOPE_KEY)).toBe(TAB_A);
    expect(todoRes.isError, textOf(todoRes as ToolResult)).toBeFalsy();
    expect(bindRes.isError, textOf(bindRes as ToolResult)).toBeFalsy();
    a.close();
    b.close();
  });

  it("does not emit graph_binding bound when the turn pin stays null", async () => {
    // Active tab belongs to another backend; this conversation has two eligible
    // tabs, so mode:"current" cannot name one — the #1077 stuck case.
    const a = await connectPanel(port, TAB_A, "a");
    const b = await connectPanel(port, TAB_B, "b");
    const c = await connectPanel(port, TAB_C, "c");
    autoReply(a, "tab-a", PATH_A);
    autoReply(b, "tab-b", "workflows/b.json");
    autoReply(c, "tab-c", "workflows/c.json");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(3));
    tabBackends.set(TAB_B, "codex");
    b.send(JSON.stringify({ type: "user_message", text: "from b" }));
    await waitFor(() => expect(bridge.resolveActiveScopeTab()).toBe(TAB_B));
    await pinAmbiguous([TAB_A, TAB_C]);

    const { ctx, setTarget, outline } = tools();
    const bindRes = await setTarget.handler({ mode: "current" }, ctx);
    const bindText = textOf(bindRes as ToolResult);

    expect(tracker.resolvedPinOf(SCOPE_KEY)).toBeNull();
    expect(bindText).not.toMatch(/"graph_binding":\s*"bound"/);
    expect(bindText).toMatch(/pin was NOT moved|turn routing|issued from multiple workflows/i);

    const outlineRes = await outline.handler({}, ctx);
    expect(outlineRes.isError).toBe(true);
    expect(textOf(outlineRes as ToolResult)).toContain("issued from multiple workflows at once");
    a.close();
    b.close();
    c.close();
  });

  it("a graph call with no bind in flight still refuses the null pin (does not hang)", async () => {
    const a = await connectPanel(port, TAB_A, "a");
    const b = await connectPanel(port, TAB_B, "b");
    autoReply(a, "tab-a", PATH_A);
    autoReply(b, "tab-b", "workflows/b.json");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(2));
    await pinAmbiguous([TAB_A, TAB_B]);

    const { ctx, outline } = tools();
    const started = Date.now();
    const outlineRes = await outline.handler({}, ctx);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(outlineRes.isError).toBe(true);
    expect(textOf(outlineRes as ToolResult)).toContain("issued from multiple workflows at once");
    a.close();
    b.close();
  });

  it("after bound, resolvedPinOf is a live tab — sequential follow-up also routes", async () => {
    const a = await connectPanel(port, TAB_A, "a");
    const b = await connectPanel(port, TAB_B, "b");
    autoReply(a, "tab-a", PATH_A);
    autoReply(b, "tab-b", "workflows/b.json");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(2));
    a.send(JSON.stringify({ type: "user_message", text: "from a" }));
    await waitFor(() => expect(bridge.resolveActiveScopeTab()).toBe(TAB_A));
    await pinAmbiguous([TAB_A, TAB_B]);

    const { ctx, setTarget, outline } = tools();
    const bindRes = await setTarget.handler({ mode: "current" }, ctx);
    const bindText = textOf(bindRes as ToolResult);
    expect(bindRes.isError, bindText).toBeFalsy();
    expect(typeof tracker.resolvedPinOf(SCOPE_KEY)).toBe("string");
    expect(bridge.canReach(tracker.resolvedPinOf(SCOPE_KEY) as string)).toBe(true);
    if (bindText.includes("graph_binding")) {
      expect(bindText).toMatch(/"graph_binding":\s*"bound"/);
    }

    const outlineRes = await outline.handler({}, ctx);
    expect(outlineRes.isError, textOf(outlineRes as ToolResult)).toBeFalsy();
    a.close();
    b.close();
  });
});
