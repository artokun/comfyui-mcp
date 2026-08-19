// #1656 (recurrence on 0.52.3, which already carries #1682's dispatch gate) —
// during an `Untitled` → saved-name instance transition six graph mutations
// returned normal success payloads, none of them persisted, and only the SEVENTH
// was refused by the instance fence.
//
// WHY THE EXISTING GATE WAS SATISFIED. #1682 refuses an active-canvas command
// when "the session's stamp and the routed tab's LAST-ADVERTISED identity are
// both known and disagree". The value it reads as the tab's last-advertised
// identity is `tabCommandWorkflowUuid.get(conn.tabId)` — and on the same-socket
// re-hello that mints the new tab id (a workflow switch, or the tmp: → wf:
// transition a save/rename performs), `carryWorkflowCommandStamp` COPIES the
// retiring id's uuid onto the new id and only overwrites it `if (newIdentity)`.
// So in the window where the hello could not resolve an identity, the "advertised
// identity" of the new canvas is the PREVIOUS canvas's uuid.
//
// That is not merely "sometimes equal". The conversation's issue-time stamp is
// captured FROM the same map at user-message time
// (`turnOrigins.recordForMid(mid, tabCommandWorkflowUuid.get(tab), tab)`), so the
// carry copies the exact string the session stamp was derived from onto the tab
// the command will land on. The two sides of the agreement gate are then EQUAL BY
// CONSTRUCTION, precisely in the window where the canvas changed — the gate is
// guaranteed to pass exactly when it is needed. The seventh mutation was refused
// because by then a hello had finally resolved a real identity for the new canvas.
//
// These tests drive the REAL UiBridge over a real socket, and use the REAL
// `carryWorkflowCommandStamp` the orchestrator's hello handler calls, with the
// resolver wired the way `orchestrator/index.ts` wires it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import WebSocket from "ws";
import { UiBridge, dispatchOutcomeOf } from "../../services/ui-bridge.js";
import { isScopeAddress } from "../../services/session-scope.js";
import { carryWorkflowCommandStamp } from "../../orchestrator/session-store.js";
import { waitFor } from "../helpers/wait-for.js";

/** The Untitled instance's per-instance uuid — the one the turn was issued for. */
const UUID_UNTITLED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** The identity the saved canvas eventually advertises. */
const UUID_SAVED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TAB_UNSAVED = "tmp:11111111-1111-4111-8111-111111111111";
const TAB_SAVED = "wf:route1:workflows/krea2_lora_ab_compare.json";
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

describe("#1656 recurrence — a CARRIED stamp is not the routed tab's advertised identity", () => {
  let bridge: UiBridge;
  let port: number;

  /** The orchestrator's `tabCommandWorkflowUuid`. */
  const advertised = new Map<string, string>();
  /** The orchestrator's carried-provenance set (tab ids whose current stamp was
   *  carried from a retired id and never re-proven for THIS id). */
  const carried = new Set<string>();
  /** The conversation's issue-time stamp (`turnOrigins.stampOf`). */
  let sessionStamp: string | undefined;

  let received: Array<Record<string, unknown>>;

  const hello = (sock: WebSocket, tabId: string) =>
    sock.send(
      JSON.stringify({
        type: "hello",
        tab_id: tabId,
        title: tabId,
        enforces_workflow_stamp: true,
        enforces_workflow_stamp_at_write: true,
      }),
    );

  beforeEach(async () => {
    advertised.clear();
    carried.clear();
    sessionStamp = undefined;
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
    bridge.setCarriedTabStampPredicate((id) => (isScopeAddress(id) ? false : carried.has(id)));
  });

  afterEach(async () => {
    await bridge.stop();
  });

  function connectPanel(tabId: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}`);
      sock.on("open", () => {
        hello(sock, tabId);
        resolve(sock);
      });
      sock.on("error", reject);
      sock.on("message", (buf) => {
        const msg = JSON.parse(buf.toString());
        if (msg.rid && msg.cmd) {
          received.push(msg);
          sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { cmd: msg.cmd } }));
        }
      });
    });
  }

  /** The orchestrator's hello handler, for the identity half only: carry the
   *  retiring id's stamp onto the new one, then overwrite it IF this hello
   *  resolved a trusted identity. Uses the production `carryWorkflowCommandStamp`. */
  function orchestratorHello(migratedFrom: string, panelTab: string, newIdentity?: string): void {
    if (carryWorkflowCommandStamp(advertised, migratedFrom, panelTab)) carried.add(panelTab);
    else carried.delete(panelTab);
    carried.delete(migratedFrom);
    if (newIdentity) {
      advertised.set(panelTab, newIdentity);
      carried.delete(panelTab);
    }
  }

  it("refuses an active-canvas mutation whose only agreement comes from the CARRY", async () => {
    advertised.set(TAB_UNSAVED, UUID_UNTITLED);
    // The turn's stamp is captured FROM the same map (turnOrigins.recordForMid).
    sessionStamp = advertised.get(TAB_UNSAVED);
    const sock = await connectPanel(TAB_UNSAVED);
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB_UNSAVED));

    // The Untitled workflow is saved under a name: the panel re-hellos on the SAME
    // socket under a wf:<path> id, and THIS hello lands before the canvas identity
    // is readable, so it carries no workflow_uuid (#1331's window).
    hello(sock, TAB_SAVED);
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB_SAVED));
    orchestratorHello(TAB_UNSAVED, TAB_SAVED, undefined);
    received.length = 0;

    // The carry made the two sides equal — by construction, not by observation.
    expect(advertised.get(TAB_SAVED)).toBe(UUID_UNTITLED);
    expect(sessionStamp).toBe(UUID_UNTITLED);
    expect(carried.has(TAB_SAVED)).toBe(true);

    for (const cmd of ["graph_connect", "graph_set_widget", "graph_outline", "workflow_save"]) {
      const err = await bridge.send({ cmd }, { tabId: SCOPE }).then(
        () => null,
        (e) => e as Error,
      );
      expect(err, `${cmd} must not be dispatched onto an unproven canvas`).not.toBeNull();
      expect(err!.message).toMatch(/^workflow instance mismatch:/);
      // The refusal says WHY: the agreement is unproven, not observed.
      expect(err!.message).toContain("has not re-established its workflow identity");
      expect(err!.message).toContain('panel_set_workflow_target({mode:"current"})');
      expect(dispatchOutcomeOf(err)).toBe(false);
    }
    // NOTHING reached the panel — the six "successful" mutations of the report.
    expect(received).toEqual([]);
    sock.close();
  });

  // THE BUG ITSELF, on the same code path. An uninstalled predicate is defined to mean
  // "proven", which is precisely the pre-#1656 gate: it sees two equal uuids and calls
  // that agreement. Same sockets, same carry, same commands — and every one of them
  // reaches the panel, stamped with the PREVIOUS canvas's uuid. Six accepted mutations
  // and a seventh refusal is what that looks like from the caller's side.
  it("BASELINE (predicate absent = pre-#1656): the very same sequence DISPATCHES", async () => {
    bridge.setCarriedTabStampPredicate(() => false);
    advertised.set(TAB_UNSAVED, UUID_UNTITLED);
    sessionStamp = advertised.get(TAB_UNSAVED);
    const sock = await connectPanel(TAB_UNSAVED);
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB_UNSAVED));
    hello(sock, TAB_SAVED);
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB_SAVED));
    orchestratorHello(TAB_UNSAVED, TAB_SAVED, undefined);
    received.length = 0;

    for (const cmd of ["graph_connect", "graph_set_widget", "workflow_save"]) {
      await expect(bridge.send({ cmd }, { tabId: SCOPE })).resolves.toEqual({ cmd });
    }
    expect(received.map((f) => f.cmd)).toEqual([
      "graph_connect",
      "graph_set_widget",
      "workflow_save",
    ]);
    // …carrying the RETIRED tab's uuid as this command's target.
    expect(received.every((f) => f.workflow_uuid === UUID_UNTITLED)).toBe(true);
    sock.close();
  });

  it("keeps the recovery probe and navigation dispatchable so the rebind is not circular", async () => {
    advertised.set(TAB_UNSAVED, UUID_UNTITLED);
    sessionStamp = advertised.get(TAB_UNSAVED);
    const sock = await connectPanel(TAB_UNSAVED);
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB_UNSAVED));
    hello(sock, TAB_SAVED);
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB_SAVED));
    orchestratorHello(TAB_UNSAVED, TAB_SAVED, undefined);
    received.length = 0;

    for (const cmd of ["workflow_list", "workflow_open", "workflow_new", "nodes_search"]) {
      await expect(bridge.send({ cmd }, { tabId: SCOPE })).resolves.toEqual({ cmd });
    }
    expect(received.map((f) => f.cmd)).toEqual([
      "workflow_list",
      "workflow_open",
      "workflow_new",
      "nodes_search",
    ]);

    // The documented rebind proves an identity for THIS tab id, which clears the
    // carried provenance — and the same mutations then dispatch normally.
    advertised.set(TAB_SAVED, UUID_SAVED);
    carried.delete(TAB_SAVED);
    sessionStamp = UUID_SAVED;
    received.length = 0;
    await expect(bridge.send({ cmd: "graph_connect" }, { tabId: SCOPE })).resolves.toEqual({
      cmd: "graph_connect",
    });
    expect(received[0].workflow_uuid).toBe(UUID_SAVED);
    sock.close();
  });

  it("leaves a PROVEN agreement dispatching — the carry is the only thing withdrawn", async () => {
    advertised.set(TAB_UNSAVED, UUID_UNTITLED);
    sessionStamp = advertised.get(TAB_UNSAVED);
    const sock = await connectPanel(TAB_UNSAVED);
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB_UNSAVED));

    // Same transition, but this hello DOES resolve the identity — and it is the
    // same instance (a save/rename keeps the per-instance uuid). Nothing changes:
    // the agreement is observed, so the command dispatches.
    hello(sock, TAB_SAVED);
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB_SAVED));
    orchestratorHello(TAB_UNSAVED, TAB_SAVED, UUID_UNTITLED);
    received.length = 0;
    expect(carried.has(TAB_SAVED)).toBe(false);

    await expect(bridge.send({ cmd: "graph_connect" }, { tabId: SCOPE })).resolves.toEqual({
      cmd: "graph_connect",
    });
    expect(received[0].workflow_uuid).toBe(UUID_UNTITLED);
    sock.close();
  });

  it("still refuses a plain DISAGREEMENT with #1682's message, carry or not", async () => {
    advertised.set(TAB_UNSAVED, UUID_UNTITLED);
    sessionStamp = UUID_UNTITLED;
    const sock = await connectPanel(TAB_UNSAVED);
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB_UNSAVED));
    hello(sock, TAB_SAVED);
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB_SAVED));
    orchestratorHello(TAB_UNSAVED, TAB_SAVED, UUID_SAVED);
    received.length = 0;

    const err = await bridge.send({ cmd: "graph_outline" }, { tabId: SCOPE }).then(
      () => null,
      (e) => e as Error,
    );
    expect(err).not.toBeNull();
    expect(err!.message).toContain(`issued for workflow instance ${UUID_UNTITLED}`);
    expect(err!.message).toContain(`different active workflow (${UUID_SAVED})`);
    expect(received).toEqual([]);
    sock.close();
  });
});

describe("#1656 — carryWorkflowCommandStamp reports whether it CARRIED", () => {
  it("is true only when the retiring id's stamp was actually copied forward", () => {
    const stamps = new Map<string, string>([["tmp:old", UUID_UNTITLED]]);
    expect(carryWorkflowCommandStamp(stamps, "tmp:old", "wf:new")).toBe(true);
    expect(stamps.get("wf:new")).toBe(UUID_UNTITLED);
    expect(stamps.has("tmp:old")).toBe(false);
  });

  it("is false when the new id already holds its OWN (newer) evidence", () => {
    const stamps = new Map<string, string>([
      ["tmp:old", UUID_UNTITLED],
      ["wf:new", UUID_SAVED],
    ]);
    expect(carryWorkflowCommandStamp(stamps, "tmp:old", "wf:new")).toBe(false);
    expect(stamps.get("wf:new")).toBe(UUID_SAVED);
  });

  it("is false when the retiring id had no stamp to carry", () => {
    const stamps = new Map<string, string>();
    expect(carryWorkflowCommandStamp(stamps, "tmp:old", "wf:new")).toBe(false);
    expect(stamps.has("wf:new")).toBe(false);
  });
});
