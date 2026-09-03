// #2487 — panel_strip_workflow refused a live-canvas capture after a verified
// pin because routing state compared the session stamp against a stale
// last-advertised workflow instance, even though enter/exit subgraph had just
// succeeded on the pinned canvas.
//
// Reported shape: panel_set_workflow_target({mode:"pinned"}) answered
// pin_verified_active:true, panel_enter_subgraph / panel_exit_subgraph worked,
// then panel_strip_workflow({}) failed with
//
//   workflow instance mismatch: this command was issued for workflow instance
//   <A>, but the tab it routed to has since reported a different active
//   workflow (<B>). Nothing was dispatched. Re-target with
//   panel_set_workflow_target({mode:"current"})
//
// That recovery RELEASES the pin. The live canvas was still the pinned
// workflow; the advertisement was the stale side. Strip captures via
// bridge.send, so it hit the #1656 stamp-target gate without ctx.call's
// mismatch diagnosis. The fix re-resolves the pin against the live canvas and
// reconciles that advertisement when the pin still names it.
//
// These tests measure the EFFECT — whether graph_serialize reaches the socket —
// over a real UiBridge, not the reply's claims about itself.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:net";
import WebSocket from "ws";

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: async () => {
    throw new Error("COMFYUI_URL must not be consulted for a live-canvas strip");
  },
  backfillObjectInfo: async (bulk: unknown) => bulk,
  resetClient: () => {},
  resetObjectInfoCache: () => {},
}));

const { buildPanelToolDefs, makePanelToolCtx } = await import("../../orchestrator/panel-tools.js");
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";
import { UiBridge } from "../../services/ui-bridge.js";
import { isScopeAddress } from "../../services/session-scope.js";
import { workflowIdentityParts } from "../../orchestrator/session-store.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import { waitFor } from "../helpers/wait-for.js";

const LIVE = "4808c797-417c-4c33-8ab0-99cf2f6ba648";
const STALE = "caf45251-53ad-431b-afdd-02239fdb7119";
const TAB = "wf:route1:workflows/a.json";
const SCOPE = "orchestrator::claude";
const PATH = "workflows/a.json";
const OTHER_PATH = "workflows/other.json";
const ORIGIN = "http://127.0.0.1:8188";

const AGENT_KEY_SEP = "::";
function panelTabOf(key: string): string {
  const i = key.lastIndexOf(AGENT_KEY_SEP);
  return i >= 0 ? key.slice(0, i) : key;
}

const NODES = [
  { id: 1, type: "KSampler", widgets_values: [7, 20], inputs: [], outputs: [] },
];
const KSAMPLER_DEF = {
  input: { required: { seed: ["INT"], steps: ["INT"] } },
  output: [],
  name: "KSampler",
};

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

function textOf(res: ToolResult): string {
  return res.content.map((c) => ("text" in c ? (c as { text: string }).text : "")).join("\n");
}

function jsonOf(res: ToolResult): Record<string, unknown> {
  try {
    return JSON.parse(textOf(res)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Self-corroborating workflow_list: the active record also appears in the
 *  open-workflow list flagged active, which is what pin verification and fence
 *  corroboration both require. */
function settled(uuid: string, path = PATH): Record<string, unknown> {
  const filename = path.split("/").pop();
  const active = {
    path,
    filename,
    key: path,
    // Current panels advertise wf:<route>:<path> (#640), not wf:<path>.
    routing_key: TAB,
    workflow_uuid: uuid,
  };
  return {
    active,
    workflows: [{ ...active, active: true }],
    active_confirmed: true,
  };
}

describe("panel_strip_workflow honors a verified pin over a stale advertisement (#2487)", () => {
  let bridge: UiBridge;
  let port: number;

  const advertised = new Map<string, string>();
  let sessionStamp: string | undefined;
  let liveCanvas: string;
  let livePath: string;
  let received: Array<Record<string, unknown>>;

  beforeEach(async () => {
    advertised.clear();
    sessionStamp = undefined;
    liveCanvas = LIVE;
    livePath = PATH;
    received = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      port = await freePort();
      bridge = new UiBridge(port);
      bridge.start();
      if (await bridge.whenReady()) break;
      await bridge.stop();
      if (attempt === 5) throw new Error("could not bind a free bridge port");
    }
    bridge.setTabWorkflowUuidResolver(
      (id) => (isScopeAddress(id) ? sessionStamp : advertised.get(panelTabOf(id))),
      (id, uuid) => {
        if (!bridge.canReach(id)) return { ok: false, reason: `the routed tab ${id} is gone` };
        const panelTab = isScopeAddress(id) ? bridge.resolveSharedTabId(id) : panelTabOf(id);
        if (!panelTab) return { ok: false, reason: `${id} does not name a panel tab` };
        const identity = workflowIdentityParts({
          workflowUuid: uuid,
          origin: bridge.tabServerOrigin(id),
        });
        if (!identity) {
          return { ok: false, reason: `there is no server-observed Origin for ${id}` };
        }
        advertised.set(panelTab, identity.uuid);
        if (isScopeAddress(id)) sessionStamp = identity.uuid;
        return true;
      },
    );
  });

  afterEach(async () => {
    await bridge.stop();
  });

  function connectPanel(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN });
      sock.on("open", () => {
        sock.send(
          JSON.stringify({
            type: "hello",
            tab_id: TAB,
            title: TAB,
            enforces_workflow_stamp: true,
            enforces_workflow_stamp_at_write: true,
          }),
        );
        resolve(sock);
      });
      sock.on("error", reject);
      sock.on("message", (buf) => {
        const msg = JSON.parse(buf.toString()) as Record<string, unknown>;
        if (!msg.rid || !msg.cmd) return;
        received.push(msg);
        const cmd = String(msg.cmd);
        let result: unknown = { cmd };
        if (cmd === "workflow_list") result = settled(liveCanvas, livePath);
        else if (cmd === "graph_serialize") result = { workflow: { nodes: NODES, links: [] } };
        else if (cmd === "graph_get_state") result = { nodes: NODES, links: [] };
        else if (cmd === "graph_get_object_info") {
          result = {
            ok: true,
            served_by: ORIGIN,
            object_info: { KSampler: KSAMPLER_DEF },
          };
        } else if (cmd === "graph_enter_subgraph") result = { ok: true, scope: "subgraph" };
        else if (cmd === "graph_exit_subgraph") {
          // Production: enter AND exit succeed; the advertisement then drifts
          // (subgraph navigation remints / re-hellos a different instance) so
          // the NEXT fenced command is what the stamp-target gate refuses.
          advertised.set(TAB, STALE);
          result = { ok: true, scope: "root" };
        }
        sock.send(JSON.stringify({ rid: msg.rid, ok: true, result }));
      });
    });
  }

  function ctxFor(store: WorkflowTargetStore): PanelToolCtx {
    return makePanelToolCtx(bridge, SCOPE, store);
  }

  async function tool(name: string, args: Record<string, unknown>, ctx: PanelToolCtx): Promise<ToolResult> {
    const def = buildPanelToolDefs().find((d) => d.name === name);
    if (!def) throw new Error(`${name} is not registered`);
    return def.handler(args as never, ctx);
  }

  async function inPinnedState(): Promise<{ sock: WebSocket; ctx: PanelToolCtx; store: WorkflowTargetStore }> {
    advertised.set(TAB, LIVE);
    sessionStamp = LIVE;
    const sock = await connectPanel();
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB));
    received.length = 0;
    const store = new WorkflowTargetStore();
    const ctx = ctxFor(store);
    const pin = await tool("panel_set_workflow_target", { mode: "pinned", path: PATH }, ctx);
    expect(pin.isError, textOf(pin)).toBeFalsy();
    expect(jsonOf(pin).pin_verified_active).toBe(true);
    return { sock, ctx, store };
  }

  it("THE REPORTED FLOW: verified pin, enter/exit, then strip still captures", async () => {
    const { sock, ctx } = await inPinnedState();

    const entered = await tool("panel_enter_subgraph", { node_id: 12 }, ctx);
    expect(entered.isError, textOf(entered)).toBeFalsy();
    const exited = await tool("panel_exit_subgraph", {}, ctx);
    expect(exited.isError, textOf(exited)).toBeFalsy();
    expect(advertised.get(TAB)).toBe(STALE);
    expect(sessionStamp).toBe(LIVE);

    // THE GATE, measured: a fenced graph command is refused pre-dispatch
    // against the stale advertisement, nothing reaches the socket. This is
    // the state strip used to fail in.
    received.length = 0;
    const refused = await bridge.send({ cmd: "graph_serialize" }, { tabId: SCOPE }).then(
      () => null,
      (e) => e as Error,
    );
    expect(refused?.message).toContain(`issued for workflow instance ${LIVE}`);
    expect(refused?.message).toContain(`different active workflow (${STALE})`);
    expect(received.map((f) => f.cmd)).toEqual([]);

    const strip = await tool("panel_strip_workflow", {}, ctx);
    expect(strip.isError, textOf(strip)).toBeFalsy();
    expect(textOf(strip)).toMatch(/Stripped to 1 nodes/);
    expect(received.map((f) => f.cmd)).toContain("graph_serialize");
    expect(advertised.get(TAB)).toBe(LIVE);
    expect(sessionStamp).toBe(LIVE);
    sock.close();
  });

  it("a pin to a DIFFERENT live canvas is not laundered into a capture", async () => {
    // Fail closed: honoring the pin must not adopt whatever happens to be
    // active. The live canvas is PATH; the pin names OTHER_PATH.
    advertised.set(TAB, STALE);
    sessionStamp = LIVE;
    livePath = PATH;
    const sock = await connectPanel();
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB));
    const store = new WorkflowTargetStore();
    store.set(SCOPE, { mode: "pinned", path: OTHER_PATH, filename: "other.json" });
    const ctx = ctxFor(store);
    received.length = 0;

    await expect(tool("panel_strip_workflow", {}, ctx)).rejects.toThrow(
      /Couldn't capture the live canvas/,
    );
    expect(received.map((f) => f.cmd)).not.toContain("graph_serialize");
    expect(advertised.get(TAB)).toBe(STALE);
    sock.close();
  });

  it("does not repair an ambiguous basename pin against another directory", async () => {
    // A lenient/older panel may preserve the caller's bare filename as the pin.
    // That filename is not enough to identify workflows/other/a.json when the
    // live canvas is a same-basename workflow in another directory.
    advertised.set(TAB, STALE);
    sessionStamp = LIVE;
    livePath = "workflows/other/a.json";
    const sock = await connectPanel();
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB));
    const store = new WorkflowTargetStore();
    store.set(SCOPE, { mode: "pinned", path: "a.json", filename: "a.json" });
    const ctx = ctxFor(store);
    received.length = 0;

    await expect(tool("panel_strip_workflow", {}, ctx)).rejects.toThrow(
      /Couldn't capture the live canvas[\s\S]*workflow instance mismatch/,
    );
    expect(received.map((f) => f.cmd)).not.toContain("graph_serialize");
    expect(advertised.get(TAB)).toBe(STALE);
    sock.close();
  });

  it("without a pin the mismatch still refuses — the fence is not weakened", async () => {
    advertised.set(TAB, STALE);
    sessionStamp = LIVE;
    const sock = await connectPanel();
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB));
    const ctx = ctxFor(new WorkflowTargetStore());
    received.length = 0;

    await expect(tool("panel_strip_workflow", {}, ctx)).rejects.toThrow(
      /Couldn't capture the live canvas[\s\S]*workflow instance mismatch/,
    );
    expect(received.map((f) => f.cmd)).not.toContain("graph_serialize");
    expect(advertised.get(TAB)).toBe(STALE);
    sock.close();
  });
});
