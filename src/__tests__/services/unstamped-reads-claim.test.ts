// #1519 — the write refusal promised that graph reads still work. In two different
// states, that promise was false.
//
// The reporter switched workflows and the very first live-canvas read came back
//
//   workflow instance mismatch: this command carries no workflow-instance stamp,
//   and the active canvas reports 2b3f4684-… Nothing was applied.
//
// The orchestrator strips the stamp when it has no trusted one, and the refusal it
// prints for a WRITE in that state ended with "Reads and view-only commands still
// work (graph_outline, graph_query, …)". A current panel refuses an UNSTAMPED
// command outright — reads included — because #718 closed that fail-open hole
// ("An UNSTAMPED command is refused too … an advertised fence must not fail open").
//
// THE SECOND STATE, and why this file works the way it does. The first fix asked
// "is there a trusted stamp?" and kept the promise whenever there was one. That is
// PRESENCE, and the question is AGREEMENT: a read succeeds when the stamp still
// equals the ACTIVE canvas, and the resolver deliberately answers with the workflow
// the turn was ISSUED FOR, which is allowed to go stale. So the fix moved the false
// promise from the no-stamp branch into the stale-stamp branch — the same defect,
// one branch over. Review (P1) caught it; the first version of THIS FILE did not,
// because it asserted only WORDING.
//
// So every claim here is checked against a real read OUTCOME. The fixture panel
// applies the panel's own rule, transcribed from comfyui-mcp-panel:
//
//   activeWorkflowFenceApplies  — every graph_* command is fenced; workflow_list is
//                                 exempt (it is the recovery probe, panel #759)
//   commandWorkflowMismatch     — a missing stamp is a mismatch, and so is a stamp
//                                 that does not equal the active uuid
//
// and every fenced case carries a CONTROL with a matching stamp, so a green
// assertion cannot come from a fixture that simply refuses everything.
//
// The direction that matters most is asserted from the SOCKET rather than from the
// message: correcting a sentence must not turn into letting a write through. A
// mutating command with no stamp is still refused before anything is written, and a
// READ is still dispatched exactly as before — this change moves no fence.

import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildPanelToolDefs } from "../../orchestrator/panel-tools.js";
import { UiBridge } from "../../services/ui-bridge.js";
import { panelToolForGraphCmd } from "../../services/panel-graph-cmd-tools.js";

let bridge: UiBridge;
const sockets: WebSocket[] = [];
let port = 0;

/** Same free-port strategy as ui-bridge.test.ts — a fixed range flakes on loaded
 *  Windows CI, and a lost bind race there surfaces as a misattributed failure. */
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

beforeEach(async () => {
  for (let attempt = 0; attempt < 6; attempt++) {
    port = await freePort();
    bridge = new UiBridge(port);
    bridge.start();
    if (await bridge.whenReady()) break;
    await bridge.stop();
  }
});

afterEach(async () => {
  for (const s of sockets.splice(0)) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  await bridge?.stop();
});

interface FakePanel {
  /** Every frame the bridge wrote to this tab, so "was it dispatched?" is answered
   *  by observation rather than inferred from the error text. */
  received: Array<Record<string, unknown>>;
}

/**
 * A panel tab that advertises whatever `hello` says.
 *
 * `activeUuid` makes it FENCE like a real panel: it answers a command whose stamp
 * does not equal that uuid with the panel's own instance-mismatch refusal. Omit it
 * for a panel with no fence at all (an old build), which answers everything.
 */
async function connectPanel(
  tabId: string,
  hello: Record<string, unknown>,
  activeUuid?: string,
): Promise<FakePanel> {
  const received: Array<Record<string, unknown>> = [];
  const sock = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(sock);
  await new Promise<void>((resolve, reject) => {
    sock.on("open", () => resolve());
    sock.on("error", reject);
  });
  sock.on("message", (raw) => {
    let f: Record<string, unknown>;
    try {
      f = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return; // a non-JSON frame is not a command
    }
    received.push(f);
    if (typeof f.rid !== "string" || typeof f.cmd !== "string") return;
    const stamp = typeof f.workflow_uuid === "string" ? f.workflow_uuid : "";
    // commandIsCanvasTargetless: the recovery probe is exempt from the fence.
    const fenced = activeUuid !== undefined && f.cmd !== "workflow_list";
    // commandWorkflowMismatch: no stamp is a mismatch; so is a different stamp.
    const mismatch = !stamp || stamp !== activeUuid;
    const reply =
      fenced && mismatch
        ? {
            rid: f.rid,
            ok: false,
            error:
              `workflow instance mismatch: ` +
              (stamp
                ? `this command was issued for workflow instance ${stamp}`
                : `this command carries no workflow-instance stamp`) +
              `, and the active canvas reports ${activeUuid}. Nothing was applied.`,
          }
        : { rid: f.rid, ok: true, result: { nodes: [] } };
    try {
      sock.send(JSON.stringify(reply));
    } catch {
      /* the socket died — the caller times out */
    }
  });
  sock.send(JSON.stringify({ type: "hello", tab_id: tabId, title: tabId, ...hello }));
  // Let the hello register before dispatching.
  const deadline = Date.now() + 2000;
  while (!bridge.tabs().some((t) => t.tab_id === tabId)) {
    if (Date.now() > deadline) throw new Error(`tab ${tabId} never registered`);
    await new Promise((r) => setTimeout(r, 10));
  }
  return { received };
}

/** The message `cmd` fails with. */
async function failureOf(cmd: string): Promise<string> {
  try {
    await bridge.send({ cmd }, { timeoutMs: 1500 });
    return "<resolved — expected a refusal>";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** What actually happens to a read: did the panel serve it, or refuse it? */
async function readOutcome(cmd = "graph_outline"): Promise<{ served: boolean; detail: string }> {
  try {
    await bridge.send({ cmd }, { timeoutMs: 1500 });
    return { served: true, detail: "served" };
  } catch (err) {
    return { served: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

const FENCING = { enforces_workflow_stamp: true, enforces_workflow_stamp_at_write: true };
/** Advertises the DISPATCH-time fence but not the at-write recheck, so the write
 *  gate fires while a trusted stamp is present — the state the P1 is about. */
const FENCING_NO_AT_WRITE = { enforces_workflow_stamp: true };
const LIVE = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const STALE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OLD_CLAIM = /Reads and view-only commands still work/;
const REFUSED_CLAIM = /GRAPH READS ARE REFUSED TOO/;
const UNKNOWN_CLAIM = /WHETHER GRAPH READS STILL WORK IS NOT KNOWN FROM HERE/;

describe("a write refusal says only what it can know about reads (#1519)", () => {
  it("NO STAMP: the read is measured to be refused, and the message says so", async () => {
    // #1519's exact state: a current panel, and a session whose fence was never
    // established (or was lost across the workflow switch).
    const panel = await connectPanel("tmp:stampless", FENCING, LIVE);

    // MEASURED FIRST, so the wording below is checked against an outcome.
    const read = await readOutcome();
    expect(read.served, read.detail).toBe(false);
    expect(read.detail).toMatch(/carries no workflow-instance stamp/);

    const msg = await failureOf("graph_add_node");
    // Guard the guard — this must be the no-identity branch, not a capability one,
    // or every assertion below is true for the wrong reason.
    expect(msg).toMatch(/no trusted identity/);
    expect(msg).not.toMatch(OLD_CLAIM);
    expect(msg).toMatch(REFUSED_CLAIM);
    expect(msg).toMatch(/carries no workflow-instance stamp/);
    // A reader that CAN answer: workflow_list is exempt from the panel's fence.
    expect(msg).toMatch(/panel_list_workflows/);
    // It must NOT prescribe a remedy here. panel-tools' #1331 handler MEASURES which
    // no-identity state this is and can conclude that the rebind will NOT clear it;
    // a guess made here would contradict the answer that was checked.
    expect(msg).not.toMatch(/panel_set_workflow_target/);

    // …and nothing was written to the socket. The sentence changed; the gate did not.
    expect(panel.received.filter((f) => f.cmd === "graph_add_node")).toEqual([]);
  });

  it("STALE STAMP: the read is measured to be refused, so the promise is withdrawn (P1)", async () => {
    // THE REVIEW FINDING. A stamp that was trusted when issued, and a canvas that
    // has since moved. "A stamp exists" was treated as proof reads work; it is not.
    const panel = await connectPanel("tmp:stale", FENCING_NO_AT_WRITE, LIVE);
    bridge.setTabWorkflowUuidResolver(() => STALE);

    // MEASURED: the read carrying that trusted stamp is refused.
    const read = await readOutcome();
    expect(read.served, read.detail).toBe(false);
    expect(read.detail).toMatch(/workflow instance mismatch/);
    expect(read.detail).toContain(STALE);
    // …and it is refused BECAUSE of the uuid it carried, not because the fixture
    // refuses reads: the frame really went out stamped with the stale value.
    const sent = panel.received.filter((f) => f.cmd === "graph_outline");
    expect(sent.length).toBe(1);
    expect(sent[0]?.workflow_uuid).toBe(STALE);

    const msg = await failureOf("graph_add_node");
    // The write is refused for the CAPABILITY reason — the branch that used to carry
    // the promise. Guard it, or the assertions below prove nothing.
    expect(msg).toMatch(/does not recheck workflow targeting at the graph write boundary/);
    // The promise is gone, and is not replaced by the opposite unmeasured claim.
    expect(msg).not.toMatch(OLD_CLAIM);
    expect(msg).not.toMatch(REFUSED_CLAIM);
    expect(msg).toMatch(UNKNOWN_CLAIM);
    // It names the stamp the read will carry, which is the fact the caller can act on.
    expect(msg).toContain(STALE);
  });

  it("CURRENT STAMP: the read really is served, and the message still claims nothing", async () => {
    // THE CONTROL for the case above. Same panel, same gate, stamp that names the
    // live canvas — the read is served, which proves the fixture discriminates on
    // the uuid rather than refusing every read.
    //
    // The message stays UNKNOWN here on purpose: this side cannot tell this case
    // from the stale one (`Conn` holds no live canvas uuid, and workflowUuidFor()
    // reads the same resolver the stamp came from), so claiming success would be
    // the mirror image of the bug — right by luck rather than by measurement.
    await connectPanel("tmp:current", FENCING_NO_AT_WRITE, LIVE);
    bridge.setTabWorkflowUuidResolver(() => LIVE);

    const read = await readOutcome();
    expect(read.served, read.detail).toBe(true);

    const msg = await failureOf("graph_add_node");
    expect(msg).toMatch(/does not recheck workflow targeting at the graph write boundary/);
    expect(msg).toMatch(UNKNOWN_CLAIM);
    expect(msg).not.toMatch(REFUSED_CLAIM);
    expect(msg).not.toMatch(OLD_CLAIM);
  });

  it("NO FENCE: the read really is served, and the original sentence is kept", async () => {
    // The over-broad direction. A panel that does not advertise the fence executes
    // the read whatever the stamp says — measured with the fixture's fence OFF,
    // which is what such a panel is — so withdrawing the claim here would send a
    // caller who still has working reads looking for a problem they do not have.
    await connectPanel("tmp:oldpanel", {});
    bridge.setTabWorkflowUuidResolver(() => STALE);

    const read = await readOutcome();
    expect(read.served, read.detail).toBe(true);

    const msg = await failureOf("graph_add_node");
    expect(msg).toMatch(/does not enforce per-command workflow targeting/);
    expect(msg).toMatch(OLD_CLAIM);
    expect(msg).not.toMatch(REFUSED_CLAIM);
    expect(msg).not.toMatch(UNKNOWN_CLAIM);
  });
});

describe("the #1519 correction moves no fence", () => {
  it("still REFUSES a mutating command with no stamp, before anything is written", async () => {
    // The direction a message-only fix must never drift in. Asserted per command and
    // from the socket: a fence bypass would show up as a frame, not as wording.
    const panel = await connectPanel("tmp:mutations", FENCING, LIVE);

    for (const cmd of [
      "graph_add_node",
      "graph_remove_node",
      "graph_set_widget",
      "graph_connect",
      "workflow_save",
      "workflow_close",
    ]) {
      const msg = await failureOf(cmd);
      expect(msg, cmd).toMatch(/cannot be safely targeted to the active workflow/);
      expect(msg, cmd).toMatch(/no trusted identity/);
      expect(panel.received.filter((f) => f.cmd === cmd), cmd).toEqual([]);
    }
  });

  it("still refuses a mutation whose trusted stamp is STALE — the panel decides, and does", async () => {
    // The stale-stamp state must not become a hole either. The bridge dispatches
    // (it cannot know the stamp is stale), the panel refuses on the mismatch, and
    // nothing is applied — the fence working exactly as designed.
    const panel = await connectPanel("tmp:stalewrite", FENCING, LIVE);
    bridge.setTabWorkflowUuidResolver(() => STALE);

    const msg = await failureOf("graph_add_node");
    expect(msg).toMatch(/workflow instance mismatch/);
    const sent = panel.received.filter((f) => f.cmd === "graph_add_node");
    expect(sent.length).toBe(1);
    expect(sent[0]?.workflow_uuid).toBe(STALE);
  });

  it("still DISPATCHES an unstamped read, unstamped — the orchestrator did not start refusing reads", async () => {
    // The other half of "no behaviour change". Refusing reads locally was one of the
    // options #1519 records as open; this change does not take it. The read is still
    // written to the socket, still without a workflow_uuid (the stamp is BRIDGE-owned
    // and there is no trusted one), and it is the PANEL that decides its fate.
    const panel = await connectPanel("tmp:reads", FENCING, LIVE);
    const read = await readOutcome();

    expect(read.served).toBe(false);
    expect(read.detail).toMatch(/workflow instance mismatch/);
    const frames = panel.received.filter((f) => f.cmd === "graph_outline");
    expect(frames.length).toBe(1);
    expect(frames[0]).not.toHaveProperty("workflow_uuid");
  });
});

/** Bare `graph_*` bridge commands — `panel_graph_outline` must not trip this. */
const BARE_GRAPH_CMD = /(?<![a-z_])graph_[a-z_]+/;

function assertEveryPanelNameIsRegistered(msg: string): void {
  const registered = new Set(buildPanelToolDefs().map((d) => d.name));
  // Read from the MESSAGE, not from the constant the string was built from.
  const mentioned = msg.match(/panel_[a-z0-9_]+/g) ?? [];
  expect(mentioned.length).toBeGreaterThan(0);
  for (const name of new Set(mentioned)) {
    // `panel_action` is a parameter key of install_comfyui, not a tool.
    if (name === "panel_action") continue;
    expect([name, registered.has(name)]).toEqual([name, true]);
  }
  expect(msg).not.toMatch(BARE_GRAPH_CMD);
}

describe("#1935 — the instance-mismatch write refusal names TOOLS, not bridge commands", () => {
  it("NO STAMP (refused): names registered reads, and the TOOL that was called", async () => {
    await connectPanel("tmp:stampless-names", FENCING, LIVE);
    const msg = await failureOf("graph_add_node");

    expect(msg).toMatch(REFUSED_CLAIM);
    expect(msg).toMatch(/"panel_add_node" cannot be safely targeted/);
    expect(msg).not.toMatch(/"graph_add_node"/);
    // Anchored on both sides so `graph_outline` and `panel_graph_outline` cannot
    // both satisfy it — the #1933 lesson.
    expect(msg).toMatch(/panel_graph_outline \/ panel_query_graph \/ panel_get_errors/);
    expect(msg).not.toMatch(/\(graph_outline/);
    assertEveryPanelNameIsRegistered(msg);
  });

  it("STALE STAMP (unknown): names registered reads, not graph_outline / graph_query", async () => {
    await connectPanel("tmp:stale-names", FENCING_NO_AT_WRITE, LIVE);
    bridge.setTabWorkflowUuidResolver(() => STALE);
    const msg = await failureOf("graph_add_node");

    expect(msg).toMatch(UNKNOWN_CLAIM);
    expect(msg).toMatch(/"panel_add_node" cannot be safely targeted/);
    expect(msg).toMatch(/panel_graph_outline \/ panel_query_graph \/ panel_get_errors/);
    expect(msg).not.toMatch(/\(graph_outline/);
    assertEveryPanelNameIsRegistered(msg);
  });

  it("NO FENCE (execute): names registered view tools and omits graph_get_state", async () => {
    await connectPanel("tmp:oldpanel-names", {});
    bridge.setTabWorkflowUuidResolver(() => STALE);
    const msg = await failureOf("graph_add_node");

    expect(msg).toMatch(OLD_CLAIM);
    expect(msg).toMatch(/"panel_add_node" cannot be safely targeted/);
    expect(msg).toMatch(/panel_graph_outline/);
    expect(msg).toMatch(/panel_query_graph/);
    expect(msg).toMatch(/panel_find_nodes/);
    expect(msg).toMatch(/panel_list_subgraphs/);
    expect(msg).toMatch(/panel_screenshot/);
    expect(msg).toMatch(/panel_canvas/);
    // Internal pre-0.8.2 fallback — no callable tool. Advertising it is the
    // same defect as advertising graph_outline.
    expect(msg).not.toMatch(/graph_get_state/);
    expect(msg).not.toMatch(/panel_graph_query/);
    assertEveryPanelNameIsRegistered(msg);
  });

  it("the reverse index resolves the advertised reads and declines graph_get_state", () => {
    expect(panelToolForGraphCmd("graph_outline")).toBe("panel_graph_outline");
    expect(panelToolForGraphCmd("graph_query")).toBe("panel_query_graph");
    expect(panelToolForGraphCmd("graph_get_errors")).toBe("panel_get_errors");
    expect(panelToolForGraphCmd("graph_find_nodes")).toBe("panel_find_nodes");
    expect(panelToolForGraphCmd("graph_list_subgraphs")).toBe("panel_list_subgraphs");
    expect(panelToolForGraphCmd("graph_screenshot")).toBe("panel_screenshot");
    expect(panelToolForGraphCmd("graph_canvas")).toBe("panel_canvas");
    expect(panelToolForGraphCmd("graph_get_state")).toBeUndefined();
    expect(panelToolForGraphCmd("graph_add_node")).toBe("panel_add_node");
  });
});
