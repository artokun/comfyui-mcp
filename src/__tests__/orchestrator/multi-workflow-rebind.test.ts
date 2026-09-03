// #1001 recurrence — after reconnect, mixed-origin completions (or a turn with
// several workflow-origin blocks) must route graph tools to the live bound /
// current / unique tab instead of failing closed as AMBIGUOUS or wrapping the
// refusal as "still reconnecting". Tests drive the shipped TurnOriginTracker
// + makeScopeTargetResolver + panel_graph_outline path.

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
const CODEX_KEY = `${SHARED_SESSION_SCOPE}::codex`;
const TAB_LIVE = "wf:tab-live:workflows/a.json";
const TAB_A = "wf:tab-one:workflows/a.json";
const TAB_B = "wf:tab-two:workflows/b.json";
const PATH = "workflows/a.json";
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

function autoReply(sock: WebSocket, path: string): void {
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
    sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { cmd: msg.cmd, from: path } }));
  });
}

describe("#1001 mixed-origin reconnect inherits the live bound tab", () => {
  let bridge: UiBridge;
  let port: number;
  let tracker: TurnOriginTracker;
  let tabBackends: Map<string, string>;
  let scopeKey: string;

  beforeEach(async () => {
    ({ bridge, port } = await startBridge());
    bridge.setTabWorkflowUuidResolver(() => UUID);
    tabBackends = new Map();
    scopeKey = SCOPE_KEY;
    const backendOfKey = (key: string): string =>
      key.includes("::") ? key.slice(key.lastIndexOf("::") + 2) : "claude";
    const backendForTab = (tab: string): string => tabBackends.get(tab) ?? "claude";
    tracker = new TurnOriginTracker({
      backendForTab,
      backendOfKey,
      uuidOfTab: () => UUID,
      liveTabOf: (tab) => bridge.liveTabIdFor(tab),
      currentTabOf: (key) => {
        const active = bridge.liveLastActiveTabId();
        if (!active || bridge.isHeadless(active)) return undefined;
        return backendForTab(active) === backendOfKey(key) ? active : undefined;
      },
      uniqueLiveTabOf: (key) => {
        const backend = backendOfKey(key);
        const interactive = bridge
          .tabs()
          .map((t) => t.tab_id)
          .filter((t) => !bridge.isHeadless(t));
        const eligible = interactive.filter((t) => backendForTab(t) === backend);
        if (eligible.length === 1) return eligible[0];
        if (eligible.length === 0 && interactive.length === 1) return interactive[0];
        return undefined;
      },
      claimTab: (tab, backend) => {
        tabBackends.set(tab, backend);
      },
      warn: () => {},
    });
    const scopeAgentKeyOf = (scopeId: string): string =>
      scopeId === SHARED_SESSION_SCOPE ? scopeKey : scopeId;
    bridge.setScopeTargetResolver(makeScopeTargetResolver({ tracker, scopeAgentKeyOf }));
    bridge.setScopeRepinHandler(
      makeScopeRepinHandler({
        bridge,
        tracker,
        scopeAgentKeyOf,
        backendForTab,
        backendOfKey,
        info: () => {},
        claimTab: (tab, backend) => {
          tabBackends.set(tab, backend);
        },
      }),
    );
  });

  afterEach(async () => {
    await bridge.stop();
  });

  function tools(key = SCOPE_KEY) {
    const defs = buildPanelToolDefs();
    const ctx = makePanelToolCtx(bridge, key, new WorkflowTargetStore());
    return {
      ctx,
      outline: defs.find((d) => d.name === "panel_graph_outline")!,
    };
  }

  async function replayTwoWorkflows(key: string): Promise<void> {
    const e1 = tracker.mintInjectionOrigin(TAB_A);
    const e2 = tracker.mintInjectionOrigin(TAB_B);
    tracker.onSeen(key, e1);
    tracker.onSeen(key, e2);
    await waitFor(() => expect(tracker.pinOf(key)).not.toBeUndefined());
  }

  it("one connected tab: graph_outline succeeds after mixed injected origins without a manual rebind", async () => {
    const sock = await connectPanel(port, TAB_LIVE, "live");
    autoReply(sock, PATH);
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));

    await replayTwoWorkflows(SCOPE_KEY);
    expect(tracker.pinOf(SCOPE_KEY)).toBe(TAB_LIVE);
    expect(tracker.resolvedPinOf(SCOPE_KEY)).toBe(TAB_LIVE);

    const { ctx, outline } = tools();
    const res = await outline.handler({}, ctx);
    expect(res.isError, textOf(res as ToolResult)).toBeFalsy();
    expect(textOf(res as ToolResult)).not.toContain("issued from multiple workflows at once");
    expect(textOf(res as ToolResult)).not.toContain("still reconnecting");
    sock.close();
  });

  it("two live tabs and none bound: graph_outline still refuses as AMBIGUOUS", async () => {
    const a = await connectPanel(port, TAB_A, "a");
    const b = await connectPanel(port, TAB_B, "b");
    autoReply(a, PATH);
    autoReply(b, "workflows/b.json");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(2));

    tracker.recordForMid("m-a", UUID, TAB_A);
    tracker.recordForMid("m-b", UUID, TAB_B);
    tracker.onSeen(SCOPE_KEY, "m-a");
    tracker.onSeen(SCOPE_KEY, "m-b");
    await waitFor(() => expect(tracker.pinOf(SCOPE_KEY)).toBeNull());

    const { ctx, outline } = tools();
    const res = await outline.handler({}, ctx);
    expect(res.isError).toBe(true);
    expect(textOf(res as ToolResult)).toContain("issued from multiple workflows at once");
    expect(textOf(res as ToolResult)).not.toContain("still reconnecting");
    a.close();
    b.close();
  });

  it("Codex reconnect: unique canvas attributed to the default backend is adopted; outline is not 'still reconnecting'", async () => {
    scopeKey = CODEX_KEY;
    const sock = await connectPanel(port, TAB_LIVE, "live");
    autoReply(sock, PATH);
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    tabBackends.set(TAB_A, "codex");
    tabBackends.set(TAB_B, "codex");
    // Hello omitted backend — the unique canvas joined the default conversation.
    tabBackends.set(TAB_LIVE, "claude");

    await replayTwoWorkflows(CODEX_KEY);
    expect(tracker.pinOf(CODEX_KEY)).toBe(TAB_LIVE);
    expect(tabBackends.get(TAB_LIVE)).toBe("codex");

    const { ctx, outline } = tools(CODEX_KEY);
    const res = await outline.handler({}, ctx);
    const text = textOf(res as ToolResult);
    expect(res.isError, text).toBeFalsy();
    expect(text).not.toContain("issued from multiple workflows at once");
    expect(text).not.toContain("still reconnecting");
    sock.close();
  });

  it("routing-time adopt: mixed origins close as null, then the unique hello un-wedges graph_outline", async () => {
    const e1 = tracker.mintInjectionOrigin(TAB_A);
    const e2 = tracker.mintInjectionOrigin(TAB_B);
    tracker.onSeen(SCOPE_KEY, e1);
    tracker.onSeen(SCOPE_KEY, e2);
    await waitFor(() => expect(tracker.pinOf(SCOPE_KEY)).toBeNull());

    const sock = await connectPanel(port, TAB_LIVE, "live");
    autoReply(sock, PATH);
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));

    const { ctx, outline } = tools();
    const res = await outline.handler({}, ctx);
    const text = textOf(res as ToolResult);
    expect(res.isError, text).toBeFalsy();
    expect(tracker.resolvedPinOf(SCOPE_KEY)).toBe(TAB_LIVE);
    expect(text).not.toContain("still reconnecting");
    sock.close();
  });
});
