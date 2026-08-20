// #1494 — a transient workflow-instance mismatch whose own recovery reported success.
//
// Reported shape, verbatim: `panel_add_node` succeeded, seconds later the next one was
// refused with "workflow instance mismatch: … issued for workflow instance <A>, but the
// routed tab reported <B>", and `panel_set_workflow_target({mode:"current"})` called
// immediately afterwards answered `graph_binding:"bound"`,
// `graph_binding_status:"already_current"` — naming <A>, the very uuid the refusal was
// being measured against. Two answers about one session, contradicting each other.
//
// They contradicted because they compared DIFFERENT facts:
//
//   the dispatch-time agreement gate (#1656, ui-bridge send)
//        session stamp  vs  the identity the ROUTED TAB last advertised in a hello
//   the rebind recovery (rebindWorkflowFence)
//        session stamp  vs  the LIVE canvas read back with workflow_list
//
// When the ADVERTISEMENT is the stale side those two disagree by construction: the live
// canvas equals the stamp (so the rebind short-circuits to `already_current` and repairs
// nothing — `corroborateTabStamp` refuses outright when the values differ), while the
// gate keeps refusing every fenced command against the advertisement nothing has
// touched. The recovery the refusal itself prescribes could not clear the refusal, and
// said it had.
//
// The fix does not move the gate: the refusals below are byte-identical. It gives the
// gate ONE implementation (`stampTargetVerdict`) and lets the capability probe the
// recovery reports from ask it, so "can this session run graph commands" stops being
// answered by a check that cannot see what is refusing them.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import WebSocket from "ws";

import { UiBridge } from "../../services/ui-bridge.js";
import { isScopeAddress } from "../../services/session-scope.js";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import { waitFor } from "../helpers/wait-for.js";

/** What the session was issued for, and what the live canvas keeps reporting. */
const LIVE = "4808c797-417c-4c33-8ab0-99cf2f6ba648";
/** The stale value the routed tab's last handshake left behind. */
const STALE = "caf45251-53ad-431b-afdd-02239fdb7119";
const TAB = "wf:route1:workflows/a.json";
const SCOPE = "orchestrator::claude";

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

describe("a stale tab advertisement is REPORTED, not papered over (#1494)", () => {
  let bridge: UiBridge;
  let port: number;

  /** The orchestrator's two answers, modelled separately BECAUSE they diverge in the
   *  bug: the per-tab advertised identity (tabCommandWorkflowUuid, refreshed by every
   *  hello) and the conversation's issue-time stamp (turnOrigins.stampOf). */
  const advertised = new Map<string, string>();
  let sessionStamp: string | undefined;
  let carried: boolean;
  /** What the fake panel says the LIVE canvas is when workflow_list is read. */
  let liveCanvas: string;
  let received: Array<Record<string, unknown>>;

  beforeEach(async () => {
    advertised.clear();
    sessionStamp = undefined;
    carried = false;
    liveCanvas = LIVE;
    received = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      port = await freePort();
      bridge = new UiBridge(port);
      bridge.start();
      if (await bridge.whenReady()) break;
      await bridge.stop();
      if (attempt === 5) throw new Error("could not bind a free bridge port");
    }
    bridge.setTabWorkflowUuidResolver((id) =>
      isScopeAddress(id) ? sessionStamp : advertised.get(id),
    );
    bridge.setCarriedTabStampPredicate((id) => !isScopeAddress(id) && carried);
  });

  afterEach(async () => {
    await bridge.stop();
  });

  function connectPanel(tabId: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}`);
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

  /** The reported state: the session stamp names the live canvas, the routed tab's
   *  last advertisement does not. */
  async function inTheReportedState(): Promise<WebSocket> {
    advertised.set(TAB, STALE);
    sessionStamp = LIVE;
    const sock = await connectPanel(TAB);
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB));
    received.length = 0;
    return sock;
  }

  it("the gate still refuses, in exactly the words that were reported", async () => {
    const sock = await inTheReportedState();
    const err = await bridge.send({ cmd: "graph_add_node" }, { tabId: SCOPE }).then(
      () => null,
      (e) => e as Error,
    );
    expect(err).not.toBeNull();
    expect(err!.message).toContain(`issued for workflow instance ${LIVE}`);
    expect(err!.message).toContain(`different active workflow (${STALE})`);
    // Pre-dispatch: nothing reached the panel.
    expect(received).toEqual([]);
    sock.close();
  });

  it("and the capability probe the recovery reports now SEES that refusal", async () => {
    const sock = await inTheReportedState();
    const cap = bridge.tabGraphMutationCapability(SCOPE);
    expect(cap).toEqual({ known: true, canMutate: false, because: "target_disagreement" });
    // The boolean gate agrees — graph tools really are unusable in this state.
    expect(bridge.tabCanMutateGraph(SCOPE)).toBe(false);
    sock.close();
  });

  it("a CARRIED (inherited) stamp is the same verdict — the other arm of the same gate", async () => {
    advertised.set(TAB, LIVE);
    sessionStamp = LIVE;
    carried = true;
    const sock = await connectPanel(TAB);
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB));
    expect(bridge.tabGraphMutationCapability(SCOPE)).toEqual({
      known: true,
      canMutate: false,
      because: "target_disagreement",
    });
    sock.close();
  });

  it("does NOT fire when the two agree — the settled session is untouched", async () => {
    advertised.set(TAB, LIVE);
    sessionStamp = LIVE;
    const sock = await connectPanel(TAB);
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB));
    expect(bridge.tabGraphMutationCapability(SCOPE)).toEqual({ known: true, canMutate: true });
    // …and a caller addressing the connection by its canonical id reads both answers
    // from one lookup, so it can never be a disagreement.
    expect(bridge.tabGraphMutationCapability(TAB)).toEqual({ known: true, canMutate: true });
    sock.close();
  });

  it("an ABSENT session stamp is still no_identity — the new check is LAST", async () => {
    // A missing value is not divergence. This is the state that would be misreported
    // if the disagreement check ran before the ones it presupposes.
    advertised.set(TAB, LIVE);
    sessionStamp = undefined;
    const sock = await connectPanel(TAB);
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB));
    expect(bridge.tabGraphMutationCapability(SCOPE)).toEqual({
      known: true,
      canMutate: false,
      because: "no_identity",
    });
    sock.close();
  });

  it("END TO END: the rebind stops answering `bound` while the gate is refusing", async () => {
    const sock = await inTheReportedState();
    const ctx = makePanelToolCtx(bridge, SCOPE, new WorkflowTargetStore());
    const def = buildPanelToolDefs().find((d) => d.name === "panel_set_workflow_target");
    if (!def) throw new Error("panel_set_workflow_target is not registered");
    const res: ToolResult = await def.handler({ mode: "current" } as never, ctx);
    const text = res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

    // The recovery really did read the live canvas — without this the assertions
    // below could be satisfied by a reply that never consulted the panel.
    expect(received.map((f) => f.cmd)).toContain("workflow_list");
    // THE REPORTED CONTRADICTION, gone: this is the reply that used to say
    // graph_binding:"bound" / already_current on the very uuid being refused against.
    expect(res.isError).toBe(true);
    expect(text).not.toContain('"graph_binding": "bound"');
    expect(text).toContain("did NOT restore this session's graph binding");
    // It names WHICH comparison is refusing, and a remedy that can actually clear it.
    expect(text).toContain("last advertised");
    expect(text).toContain("panel_open_workflow");
    // And it does not sell the state as reads-only: this gate refuses graph reads too.
    expect(text).not.toContain("Reads work");
    sock.close();
  });

  it("END TO END: the mismatch diagnosis stops prescribing a bare retry it cannot honour", async () => {
    const sock = await inTheReportedState();
    const ctx = makePanelToolCtx(bridge, SCOPE, new WorkflowTargetStore());
    const def = buildPanelToolDefs().find((d) => d.name === "panel_add_node");
    if (!def) throw new Error("panel_add_node is not registered");
    const res: ToolResult = await def.handler({ node_type: "KSampler" } as never, ctx);
    const text = res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

    expect(res.isError).toBe(true);
    // The check ran against the live canvas, and found it agrees with the stamp…
    expect(received.map((f) => f.cmd)).toContain("workflow_list");
    expect(text).toMatch(/CHECKED/);
    // …so #1330's TRANSIENT wording would have fired here and told the caller to
    // re-issue a call the gate compares against the same unchanged advertisement.
    expect(text).not.toContain("RETRY THIS EXACT CALL ONCE");
    expect(text).toContain("last advertised");
    expect(text).toContain("panel_open_workflow");
    // The refusal itself is preserved verbatim — the comparison is the evidence.
    expect(text).toContain(`issued for workflow instance ${LIVE}`);
    expect(text).toContain(STALE);
    // Nothing was dispatched by the refused call; only the diagnosis read the panel.
    expect(received.map((f) => f.cmd)).not.toContain("graph_add_node");
    sock.close();
  });
});
