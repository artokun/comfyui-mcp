// #2209 — the recovery the agreement gate's own refusal prescribes now CLEARS it.
//
// Reported shape: after a workflow-tab switch, `panel_graph_outline` refused on a
// workflow-instance mismatch; `panel_set_workflow_target({mode:"current"})` answered that
// mode current was applied but that it had NOT restored the graph binding, "because it
// compared the live canvas rather than the routed tab handshake identity"; the next graph
// read refused identically; and retrying that identical read once succeeded.
//
// That disclosure is #1494's, and it was accurate — the two sides compare different facts:
//
//   the dispatch-time agreement gate (ui-bridge send / stampTargetVerdict)
//        session stamp  vs  the identity the ROUTED TAB last advertised
//   the rebind recovery (rebindWorkflowFence)
//        session stamp  vs  the LIVE canvas read back with workflow_list
//
// When the ADVERTISEMENT is the stale side the rebind has nothing to move (the fence
// already names the live canvas) and the gate goes on refusing every graph command, reads
// included. The only thing that ever cleared it was the panel noticing its own drift and
// re-advertising — which is what the reporter's "retry the identical read once" was
// waiting for, and which the panel only attempts MISMATCH_REHELLO_MAX_PER_IDENTITY (3)
// times per identity before the session is wedged for good.
//
// So mode:"current" now performs that same write itself, from the observation it already
// made. These tests measure the EFFECT — the advertisement the gate reads, and whether a
// previously-refused `graph_add_node` reaches the socket — not the reply's claims about
// itself. The refresh validator below mirrors the orchestrator's real one
// (orchestrator/index.ts `setTabWorkflowUuidResolver`) gate for gate, including the
// conversation-stamp write that must NOT happen on this path.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import WebSocket from "ws";

import { UiBridge } from "../../services/ui-bridge.js";
import { isScopeAddress } from "../../services/session-scope.js";
import { workflowIdentityParts } from "../../orchestrator/session-store.js";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import { waitFor } from "../helpers/wait-for.js";

/** What the session is fenced to, and what the live canvas keeps reporting. */
const LIVE = "4808c797-417c-4c33-8ab0-99cf2f6ba648";
/** The stale value the routed tab's last handshake left behind. */
const STALE = "caf45251-53ad-431b-afdd-02239fdb7119";
/** A third instance — never this session's stamp, so never reconcilable onto it. */
const OTHER = "9f0e6d21-7c4a-4b7e-9a11-5d2c3f8e4b60";
const TAB = "wf:route1:workflows/a.json";
const SCOPE = "orchestrator::claude";
/** A browser panel always presents one; the relay path is the case that has none. */
const ORIGIN = "http://127.0.0.1:8188";

/** The orchestrator's key normalisation (index.ts `panelTabOf`), mirrored so the test's
 *  map is keyed exactly the way production keys it. */
const AGENT_KEY_SEP = "::";
function panelTabOf(key: string): string {
  const i = key.lastIndexOf(AGENT_KEY_SEP);
  return i >= 0 ? key.slice(0, i) : key;
}

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

/** A self-corroborating workflow_list reply — the active record also appears in the
 *  open-workflow list flagged active, which is what corroboration requires. */
function settled(uuid: string): Record<string, unknown> {
  const active = { path: "workflows/a.json", routing_key: TAB, workflow_uuid: uuid };
  return { active, workflows: [{ ...active, active: true }], active_confirmed: true };
}

describe("a stale routed-tab advertisement is RECONCILED by mode:\"current\" (#2209)", () => {
  let bridge: UiBridge;
  let port: number;

  /** The two answers the bug is about: the per-tab advertised identity
   *  (tabCommandWorkflowUuid) and the conversation's issue-time stamp
   *  (turnOrigins.stampOf). */
  const advertised = new Map<string, string>();
  const carried = new Set<string>();
  let sessionStamp: string | undefined;
  /** What the fake panel says the LIVE canvas is when workflow_list is read. */
  let liveCanvas: string;
  let received: Array<Record<string, unknown>>;
  /** Every (tabId, uuid) the refresh validator was asked to adopt. */
  let adoptions: Array<{ tabId: string; uuid: string }>;

  beforeEach(async () => {
    advertised.clear();
    carried.clear();
    sessionStamp = undefined;
    liveCanvas = LIVE;
    received = [];
    adoptions = [];
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
      // The orchestrator's validator, gate for gate (index.ts). The conversation-stamp
      // write at the end is deliberately kept: it is what makes an adoption addressed to
      // a SCOPE address move the session, so a reconciliation that quietly addressed the
      // caller instead of the routed tab would show up as a moved `sessionStamp`.
      (id, uuid) => {
        adoptions.push({ tabId: id, uuid });
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
        carried.delete(panelTab);
        if (isScopeAddress(id)) sessionStamp = identity.uuid;
        return true;
      },
    );
    bridge.setCarriedTabStampPredicate((id) => !isScopeAddress(id) && carried.has(panelTabOf(id)));
  });

  afterEach(async () => {
    await bridge.stop();
  });

  /** `null` means send NO Origin header — `undefined` would take the default. */
  function connectPanel(tabId: string, origin: string | null = ORIGIN): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
      sock.on("open", () => {
        sock.send(
          JSON.stringify({
            type: "hello",
            tab_id: tabId,
            title: tabId,
            enforces_workflow_stamp: true,
            enforces_workflow_stamp_at_write: true,
          }),
        );
        resolve(sock);
      });
      sock.on("error", reject);
      sock.on("message", (buf) => {
        const msg = JSON.parse(buf.toString());
        if (!msg.rid || !msg.cmd) return;
        received.push(msg);
        const result = msg.cmd === "workflow_list" ? settled(liveCanvas) : { cmd: msg.cmd };
        sock.send(JSON.stringify({ rid: msg.rid, ok: true, result }));
      });
    });
  }

  /** The reported state: the session's stamp names the live canvas, the routed tab's last
   *  advertisement does not. */
  async function inTheReportedState(origin: string | null = ORIGIN): Promise<WebSocket> {
    advertised.set(TAB, STALE);
    sessionStamp = LIVE;
    const sock = await connectPanel(TAB, origin);
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB));
    received.length = 0;
    return sock;
  }

  async function setWorkflowTargetCurrent(): Promise<ToolResult> {
    const ctx = makePanelToolCtx(bridge, SCOPE, new WorkflowTargetStore());
    const def = buildPanelToolDefs().find((d) => d.name === "panel_set_workflow_target");
    if (!def) throw new Error("panel_set_workflow_target is not registered");
    return def.handler({ mode: "current" } as never, ctx);
  }

  it("THE REPORTED FLOW: the refusal, the recovery, and the SAME read going through", async () => {
    const sock = await inTheReportedState();

    // Step 3 of the report — refused pre-dispatch, nothing reaches the socket.
    const before = await bridge.send({ cmd: "graph_add_node" }, { tabId: SCOPE }).then(
      () => null,
      (e) => e as Error,
    );
    expect(before?.message).toContain(`issued for workflow instance ${LIVE}`);
    expect(before?.message).toContain(`different active workflow (${STALE})`);
    expect(received.map((f) => f.cmd)).toEqual([]);

    // Step 4 — the recovery the refusal itself names.
    const res = await setWorkflowTargetCurrent();
    const text = res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");
    expect(received.map((f) => f.cmd)).toContain("workflow_list");
    expect(res.isError).toBeFalsy();
    expect(text).toContain('"graph_binding": "bound"');
    expect(text).toContain('"graph_binding_status": "reconciled"');
    expect(text).toContain(STALE); // it NAMES the stale value it replaced
    expect(text).not.toContain("did NOT restore this session's graph binding");

    // THE EFFECT, not the claim: the value the gate reads has moved…
    expect(advertised.get(TAB)).toBe(LIVE);
    // …the adoption was addressed to the ROUTED TAB, so no conversation stamp moved…
    expect(adoptions).toEqual([{ tabId: TAB, uuid: LIVE }]);
    expect(sessionStamp).toBe(LIVE);
    // …and step 5, the read that kept refusing, now reaches the panel.
    received.length = 0;
    await expect(bridge.send({ cmd: "graph_add_node" }, { tabId: SCOPE })).resolves.toBeTruthy();
    expect(received.map((f) => f.cmd)).toEqual(["graph_add_node"]);
    sock.close();
  });

  it("the gate's own capability verdict stops refusing — the probe the reply reports from", async () => {
    const sock = await inTheReportedState();
    expect(bridge.tabGraphMutationCapability(SCOPE)).toEqual({
      known: true,
      canMutate: false,
      because: "target_disagreement",
    });
    await setWorkflowTargetCurrent();
    expect(bridge.tabGraphMutationCapability(SCOPE)).toEqual({ known: true, canMutate: true });
    sock.close();
  });

  it("REFUSES to write anything but the identity the session already holds", async () => {
    // The safety argument, driven directly: an observation that is not this session's own
    // stamp can never be adopted here, so this path cannot re-point a session at another
    // canvas however it is called.
    const sock = await inTheReportedState();
    expect(bridge.reconcileStampTarget(SCOPE, OTHER)).toEqual({
      ok: false,
      why: "stamp_moved",
      landedOn: STALE,
      reason: LIVE,
    });
    expect(advertised.get(TAB)).toBe(STALE);
    expect(adoptions).toEqual([]);
    sock.close();
  });

  it("does nothing when the two AGREE, and nothing on a CARRIED pair", async () => {
    // `carried` is an EQUAL pair whose provenance is doubted (#1656) and it has its own
    // non-writing remedy (corroborateTabStamp). Reconciling has no business firing on it.
    advertised.set(TAB, LIVE);
    sessionStamp = LIVE;
    const sock = await connectPanel(TAB);
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB));
    expect(bridge.reconcileStampTarget(SCOPE, LIVE)).toEqual({ ok: false, why: "no_disagreement" });
    carried.add(TAB);
    expect(bridge.reconcileStampTarget(SCOPE, LIVE)).toEqual({ ok: false, why: "no_disagreement" });
    expect(adoptions).toEqual([]);
    sock.close();
  });

  it("a REFUSED reconciliation keeps the honest failure and says why", async () => {
    // The production case with no server-observed Origin (a relay connection): the
    // validator can never adopt, so the reply must go on reporting a wedged session
    // rather than claiming the repair it attempted.
    const sock = await inTheReportedState(null);
    const res = await setWorkflowTargetCurrent();
    const text = res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");
    expect(res.isError).toBe(true);
    expect(text).toContain("did NOT restore this session's graph binding");
    expect(text).toContain("was ATTEMPTED and did not go through");
    expect(text).toContain("no server-observed Origin");
    expect(text).not.toContain('"graph_binding": "bound"');
    // Nothing moved: the gate still refuses, exactly as it did before the call.
    expect(advertised.get(TAB)).toBe(STALE);
    expect(bridge.tabGraphMutationCapability(SCOPE)).toEqual({
      known: true,
      canMutate: false,
      because: "target_disagreement",
    });
    sock.close();
  });

  it("a READ-ONLY mismatch diagnosis reconciles NOTHING (#1646 stays intact)", async () => {
    // The refused mutation's own diagnosis probes with `adopt:false`. A diagnosis that
    // repaired its own subject would be the #1646 corruption in a friendlier costume, so
    // the advertisement must survive it untouched — and the diagnosis must point at the
    // call that IS allowed to write.
    const sock = await inTheReportedState();
    const ctx = makePanelToolCtx(bridge, SCOPE, new WorkflowTargetStore());
    const def = buildPanelToolDefs().find((d) => d.name === "panel_add_node");
    if (!def) throw new Error("panel_add_node is not registered");
    const res: ToolResult = await def.handler({ node_type: "KSampler" } as never, ctx);
    const text = res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

    expect(res.isError).toBe(true);
    expect(received.map((f) => f.cmd)).toContain("workflow_list");
    expect(advertised.get(TAB)).toBe(STALE);
    expect(adoptions).toEqual([]);
    expect(text).toContain('panel_set_workflow_target({mode:"current"})');
    expect(text).toContain("RECONCILES");
    expect(received.map((f) => f.cmd)).not.toContain("graph_add_node");
    sock.close();
  });
});
