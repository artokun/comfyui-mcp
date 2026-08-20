// #1175 — a `graph_run` acknowledged AFTER its reply timeout, END TO END over a
// REAL bridge.
//
// The report: `panel_run({to_node_id:8})` returned outcome-unknown on the 20 s
// bound; the panel acknowledged that same run 5.3 s later, having queued it. The
// queue listing the disclosure sends the caller to was still empty, so the one
// check on offer read as "nothing was queued" for a run that was.
//
// WHY A REAL BRIDGE, when the reconcile is a few lines over an existing map.
//
// The whole fix turns on ONE identity: the rid panel_run observes at dispatch
// must be the rid UiBridge keys retention by when the timer fires. A stubbed
// bridge supplies both sides of that from the test's own hand and passes whether
// or not they agree — the exact hole #694's own e2e file was written to close.
// So nothing here hands a rid to anything: the panel replies late on the wire,
// the bridge retains under whatever it minted, and panel_run has to find it.
//
// The second thing only a real bridge can show is that a recovered run takes the
// SAME PATH an on-time one takes. The reconcile rebuilds `ctx.call`'s result from
// the panel's own reply body, so prompt-id ticketing and the anti-poll guidance
// have to fall out unchanged. A test that asserted only "it says RECOVERED" would
// pass over a fix that recovered the fact and lost the render.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import WebSocket from "ws";
import { UiBridge, MAX_LATE_MUTATION_RESULT_CHARS } from "../../services/ui-bridge.js";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  RETRY_TOKEN_CMDS,
  __panelToolsTestHooks,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

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

/** Same harness as late-mutation-e2e.test.ts: retry past the close→rebind race so
 *  a bind flake is never reported as a feature failure. */
async function startBridgeOnFreePort(): Promise<{ bridge: UiBridge; port: number }> {
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

let bridge: UiBridge;
let port: number;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  ({ bridge, port } = await startBridgeOnFreePort());
  bridge.setTabWorkflowUuidResolver(() => "11111111-1111-4111-8111-111111111111");
  // EXACTLY what orchestrator/index.ts installs (asserted at the source in
  // late-mutation-e2e.test.ts). Retention is fail-closed: without it the bridge
  // keeps nothing and there is nothing to reconcile.
  bridge.setLateMutationFilter((cmdName) => RETRY_TOKEN_CMDS.has(cmdName));
  // The GRACE is real code under test; its DURATION is not. Ten seconds of real
  // waiting per negative case proves nothing the loop does not already prove.
  __panelToolsTestHooks.setRunLateAckGraceMs(1500);
});

afterEach(async () => {
  __panelToolsTestHooks.setRunLateAckGraceMs(null);
  for (const s of sockets.splice(0)) s.close();
  await bridge.stop();
});

/** Connect a scripted panel AND wait for the bridge to have registered its hello.
 *  Resolving on the socket's `open` alone is a race: the hello is still in flight,
 *  and a dispatch issued in that window is refused with "Connected: none" — a
 *  harness artefact that reads exactly like the tab being gone. */
async function connectPanel(tabId: string): Promise<WebSocket> {
  const sock = await openPanel(tabId);
  for (let i = 0; i < 100 && !bridge.tabs().some((t) => t.tab_id === tabId); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return sock;
}

function openPanel(tabId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(sock);
    sock.on("open", () => {
      sock.send(
        JSON.stringify({
          type: "hello",
          tab_id: tabId,
          title: "workflow-a",
          enforces_workflow_stamp: true,
          enforces_workflow_stamp_at_write: true,
        }),
      );
      resolve(sock);
    });
    sock.on("error", reject);
  });
}

/**
 * A panel that answers `graph_run` only after `delayMs` — i.e. after its reply
 * timer has already fired. Records every rid it saw, so "was this dispatched
 * twice?" is answered from the WIRE rather than from the tool's own account.
 *
 * `delayMs: null` means it never answers at all.
 */
function scriptRunPanel(
  sock: WebSocket,
  result: unknown,
  delayMs: number | null,
): { rids: string[]; lateReplySent: Promise<void> } {
  const rids: string[] = [];
  let markSent: () => void = () => {};
  const lateReplySent = new Promise<void>((r) => (markSent = r));
  sock.on("message", (buf) => {
    const msg = JSON.parse(buf.toString()) as { rid?: string; cmd?: string };
    if (typeof msg.rid !== "string" || msg.cmd !== "graph_run") return;
    const rid = msg.rid;
    rids.push(rid);
    if (delayMs === null) return;
    setTimeout(() => {
      sock.send(JSON.stringify({ rid, ok: true, result }));
      markSent();
    }, delayMs);
  });
  return { rids, lateReplySent };
}

/**
 * The REAL ctx with one property shortened: panel_run passes an EXPLICIT 20 000 ms
 * to ctx.call, so unlike the #694 e2e a default cannot be lowered — the value is
 * clamped instead. The bound is not what this file asserts; what it asserts is
 * what happens once the bound has been missed.
 */
function fastCtx(tabId: string, capMs = 120): PanelToolCtx {
  const real = makePanelToolCtx(bridge, tabId);
  const ctx = Object.create(real) as PanelToolCtx;
  ctx.call = (cmd, t, onDispatchedRid) =>
    real.call(cmd, Math.min(t ?? capMs, capMs), onDispatchedRid);
  return ctx;
}

const panelRun = () => buildPanelToolDefs().find((d) => d.name === "panel_run")!;

/** The rid an agent would copy out of the failure text, exactly as told to. */
function ridFromHint(text: string): string | undefined {
  return /retry_of:"([^"]+)"/.exec(text)?.[1];
}

/** Give the bridge's message loop the ticks it needs to receive and record a
 *  reply written asynchronously. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
}

describe("panel_run reconciles a late graph_run acknowledgement (#1175)", () => {
  it("THE REPORT: a run acked after the bound is reported as queued, not unknown", async () => {
    const sock = await connectPanel("tab-late-run");
    const panel = scriptRunPanel(sock, { queued: true, prompt_id: "p-late-1" }, 250);
    const ctx = fastCtx("tab-late-run");

    const res = await panelRun().handler({ to_node_id: 8 }, ctx);
    const text = textOf(res);

    expect(res.isError, `expected a recovered success, got: ${text}`).toBeFalsy();
    // The panel's OWN reply body reached the caller — not a sentence describing
    // it. The prompt id exists nowhere else and cannot be inferred from out here.
    expect(text).toContain("p-late-1");
    expect(text).toContain("[RECOVERED]");
    // …and the run took the FULL success path: a prompt id means the completion
    // is correlatable, which is the only thing that licenses the idle-and-wait
    // instruction. Recovering the fact while losing the render would still pass a
    // test that only looked for the banner above.
    expect(text).toContain("notified automatically");
    // ONE dispatch. Nothing here re-issues a run, which is the property that
    // makes reconciling safe at all.
    expect(panel.rids).toHaveLength(1);
  });

  it("does NOT re-dispatch, and no second render is queued", async () => {
    // Stated separately from the assertion above because it is the risk this
    // whole change carries: a reconcile that recovered by ASKING AGAIN would
    // double-render, and the reporter's own words ("without duplicating") are
    // why the retry token was acceptable in the first place.
    const sock = await connectPanel("tab-no-redispatch");
    const panel = scriptRunPanel(sock, { queued: true, prompt_id: "p-once" }, 200);
    const ctx = fastCtx("tab-no-redispatch");
    await panelRun().handler({}, ctx);
    await settle();
    expect(panel.rids).toHaveLength(1);
  });

  it("a late REFUSAL stays a refusal — and says it arrived late", async () => {
    // The bridge retains `ok:true`, which means the executor ANSWERED, not that
    // it queued anything. A recovered `queued:false` is an authoritative verdict
    // and must not be laundered into a success by the recovery that carried it.
    const sock = await connectPanel("tab-late-refusal");
    scriptRunPanel(sock, { queued: false, error: "node 8 is not an output node" }, 250);
    const ctx = fastCtx("tab-late-refusal");

    const res = await panelRun().handler({ to_node_id: 8 }, ctx);
    const text = textOf(res);
    expect(res.isError, `a recovered refusal must stay a failure: ${text}`).toBe(true);
    expect(text).toContain("not an output node");
    expect(text).toContain("[RECOVERED]");
  });

  it("a run that answers ON TIME pays nothing for the grace", async () => {
    // The gate that makes this true is one clause — `isReplyTimeoutResult(res)` —
    // and deleting it kept every other test in this file green while making EVERY
    // healthy run wait out the full grace before returning. The grace has no
    // observable effect on a success other than the wall clock, so the wall clock
    // is what has to be asserted.
    //
    // Measured monotonically: a suite-wide clock change (or a machine whose wall
    // clock steps) must not be readable as the reconcile having fired.
    const sock = await connectPanel("tab-on-time");
    const panel = scriptRunPanel(sock, { queued: true, prompt_id: "p-on-time" }, 0);
    // A bound the panel comfortably beats, and a grace far larger than it — so
    // "did this pay the grace?" is unambiguous in the elapsed time.
    const ctx = fastCtx("tab-on-time", 5_000);
    __panelToolsTestHooks.setRunLateAckGraceMs(4_000);

    const startedAt = performance.now();
    const res = await panelRun().handler({}, ctx);
    const elapsedMs = performance.now() - startedAt;

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("p-on-time");
    expect(textOf(res)).not.toContain("[RECOVERED]");
    expect(panel.rids).toHaveLength(1);
    expect(elapsedMs, "an on-time run waited out the late-ack grace").toBeLessThan(2_000);
  });

  it("a run that NEVER answers is reported exactly as it is today", async () => {
    // The over-fire guard. Reconciling must not invent an outcome for a tab that
    // simply never replied — that caller is still owed the honest unknown and
    // the retry token.
    const sock = await connectPanel("tab-silent-run");
    const panel = scriptRunPanel(sock, {}, null);
    const ctx = fastCtx("tab-silent-run");

    const res = await panelRun().handler({}, ctx);
    const text = textOf(res);
    expect(res.isError).toBe(true);
    expect(text).not.toContain("[RECOVERED]");
    expect(text).toMatch(/did not reply to "graph_run"/);
    expect(ridFromHint(text)).toBe(panel.rids[0]);
  });

  it("an unusable entry is LEFT for the retry token, not consumed by the peek", async () => {
    // The reconcile peeks before it takes precisely so this holds. A body over the
    // retention ceiling cannot rebuild the run — but the FACT of the completion is
    // still the caller's, and draining it here to answer a question we then could
    // not act on would delete the recovery they already had.
    const sock = await connectPanel("tab-oversized");
    const huge = "x".repeat(MAX_LATE_MUTATION_RESULT_CHARS + 1024);
    const panel = scriptRunPanel(sock, { queued: true, prompt_id: "p-huge", pad: huge }, 200);
    const ctx = fastCtx("tab-oversized");

    const first = await panelRun().handler({}, ctx);
    const firstText = textOf(first);
    expect(first.isError, "an unrebuildable run must not be claimed as queued").toBe(true);
    expect(firstText).not.toContain("[RECOVERED]");
    const hintRid = ridFromHint(firstText);
    expect(hintRid).toBe(panel.rids[0]);

    // The notice survived the peek: the retry-token layer can still drain it.
    await panel.lateReplySent;
    await settle();
    const landed = bridge.takeLateMutation(hintRid!);
    expect(landed?.cmd).toBe("graph_run");
    expect("result" in (landed ?? {})).toBe(false);
  });
});

describe("panel_run reconciles a graph_run whose tab dropped after queueing (panel#1524)", () => {
  it("THE REPORT: a paid run that queued then lost the tab is queued:true, not UNKNOWN", async () => {
    const sock = await connectPanel("tab-disco-run");
    const rids: string[] = [];
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString()) as { rid?: string; cmd?: string };
      if (typeof msg.rid !== "string" || msg.cmd !== "graph_run") return;
      rids.push(msg.rid);
      sock.close();
    });
    const ctx = fastCtx("tab-disco-run", 5_000);
    const runP = panelRun().handler({ to_node_id: 3 }, ctx);

    for (let i = 0; i < 100 && rids.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(rids, "graph_run must have been written before the drop").toHaveLength(1);
    await settle();

    const sock2 = await connectPanel("tab-disco-run");
    sock2.send(
      JSON.stringify({
        rid: rids[0],
        ok: true,
        result: { queued: true, prompt_id: "p-poyo-1", ran_to_node: 3 },
      }),
    );

    const res = await runP;
    const text = textOf(res);
    expect(res.isError, `expected a recovered success, got: ${text}`).toBeFalsy();
    expect(text).toContain("p-poyo-1");
    expect(text).toContain("[RECOVERED]");
    expect(text).toContain("notified automatically");
    expect(rids).toHaveLength(1);
  });

  it("a disconnect that never acknowledges and whose queue did not change stays unknown", async () => {
    const sock = await connectPanel("tab-disco-silent");
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString()) as { rid?: string; cmd?: string };
      if (typeof msg.rid === "string" && msg.cmd === "graph_run") sock.close();
    });
    __panelToolsTestHooks.setRunLateAckGraceMs(200);
    const ctx = fastCtx("tab-disco-silent", 5_000);
    const res = await panelRun().handler({}, ctx);
    const text = textOf(res);
    expect(res.isError).toBe(true);
    expect(text).not.toContain("[RECOVERED]");
    expect(text).toMatch(/disconnected mid-command \("graph_run"\)/);
    expect(text).toMatch(/OUTCOME UNKNOWN/);
  });
});

describe("UiBridge late-mutation retention keeps the reply body (#1175)", () => {
  it("peek does not drain, take does", async () => {
    const sock = await connectPanel("tab-peek");
    const panel = scriptRunPanel(sock, { queued: true, prompt_id: "p-peek" }, 200);
    const ctx = fastCtx("tab-peek");
    // Reconcile disabled for this case so the drain under test is OURS: a grace
    // of 0 means panel_run's loop expires before the panel's late reply lands.
    __panelToolsTestHooks.setRunLateAckGraceMs(0);

    const first = await panelRun().handler({}, ctx);
    const rid = ridFromHint(textOf(first));
    expect(rid).toBe(panel.rids[0]);
    await panel.lateReplySent;
    await settle();

    expect(bridge.peekLateMutation(rid!)?.result).toEqual({
      queued: true,
      prompt_id: "p-peek",
    });
    // Twice: a peek that drained would answer undefined the second time.
    expect(bridge.peekLateMutation(rid!)?.result).toEqual({
      queued: true,
      prompt_id: "p-peek",
    });
    expect(bridge.takeLateMutation(rid!)?.result).toEqual({
      queued: true,
      prompt_id: "p-peek",
    });
    expect(bridge.takeLateMutation(rid!)).toBeUndefined();
    expect(bridge.peekLateMutation(rid!)).toBeUndefined();
  });

  it("an OVERSIZED body is dropped and the completion is still retained", async () => {
    const sock = await connectPanel("tab-oversized-unit");
    const huge = "x".repeat(MAX_LATE_MUTATION_RESULT_CHARS + 1024);
    const panel = scriptRunPanel(sock, { queued: true, pad: huge }, 200);
    const ctx = fastCtx("tab-oversized-unit");
    __panelToolsTestHooks.setRunLateAckGraceMs(0);

    const first = await panelRun().handler({}, ctx);
    const rid = ridFromHint(textOf(first));
    await panel.lateReplySent;
    await settle();

    const hit = bridge.peekLateMutation(rid!);
    expect(hit?.ok).toBe(true);
    expect(hit?.cmd).toBe("graph_run");
    // ABSENT, not undefined-valued: the consumer branches on the property, so a
    // present-but-undefined body would read as "the panel replied with nothing".
    expect("result" in (hit ?? {})).toBe(false);
  });
});
