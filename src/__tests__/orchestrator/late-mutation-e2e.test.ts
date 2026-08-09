// #694 — the late-mutation notice, END TO END over a REAL bridge.
//
// WHY THIS FILE EXISTS, when both halves already have coverage.
//
// ui-bridge.test.ts drives the real bridge but reads the outcome by calling
// `bridge.takeLateMutation(rid)` with a rid harvested off the wire.
// panel-retry-identity.test.ts drives the real tool defs and the real
// makePanelToolCtx, but against a bridge whose `takeLateMutation` is a stub fed
// from a scripted map. Both pass if the two halves disagree about WHICH rid.
//
// And they could disagree, silently. The caller is handed a token by
// panel-tools (`retry_of:"<dispatchedRid>"`, from the onDispatchedRid observer);
// retention is keyed by a rid minted inside UiBridge.dispatch. Nothing in the
// suite asserts those are the same string. If they ever diverge — a re-dispatch
// that mints a fresh rid, an observer moved before the mint, a rebind — the
// feature is inert in production while every existing test still passes,
// because every existing test supplies the rid itself.
//
// So this file hands NOTHING to the drain. It reads the rid out of the retry
// hint the way an agent would (regex over the error text), and asserts that
// string is the one the bridge saw on the wire and keyed retention by. That
// identity is the feature's single point of failure.
//
// DELIBERATELY SHORT TIMEOUTS. The production default for a write is 20 s
// (BRIDGE_DEFAULT_TIMEOUT_MS), and an earlier throwaway version of this probe
// used it: first attempt times out at 20 s, panel replies at 21.5 s, retry
// succeeds. It passes, and it costs 25 s of CI for no extra proof — the rid is
// minted, observed, retained and drained by the same code paths regardless of
// the number. The deadline is not what is under test, so `fastCtx` below shrinks
// it and everything else stays real.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { UiBridge } from "../../services/ui-bridge.js";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  RETRY_TOKEN_CMDS,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text;

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

/** Same shape as ui-bridge.test.ts's harness: retry past the close→rebind race
 *  so a bind flake is never reported as a feature failure. */
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
  // A trusted workflow identity, so a `targeted` graph command clears the #570
  // write fence and actually reaches the socket. Without it the dispatch is
  // refused pre-write (dispatched:false), no rid is minted, and this file would
  // be testing the fence instead of the feature.
  bridge.setTabWorkflowUuidResolver(() => "11111111-1111-4111-8111-111111111111");
  // EXACTLY what orchestrator/index.ts installs. Retention is fail-closed, so
  // without this the bridge keeps nothing — see the fail-closed case below, and
  // the SOURCE assertion that production really does install this same filter.
  bridge.setLateMutationFilter((cmdName) => RETRY_TOKEN_CMDS.has(cmdName));
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await bridge.stop();
});

function connectPanel(tabId: string): Promise<WebSocket> {
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
 * A panel that answers `graph_set_node_mode`: the FIRST attempt only after
 * `firstReplyDelayMs` (i.e. after its reply timer has already fired), every
 * later attempt immediately — the panel #521 ledger recognising the retry.
 * Records every rid it saw on the wire.
 */
function scriptPanel(
  sock: WebSocket,
  firstReplyDelayMs: number,
): { rids: string[]; lateReplySent: Promise<void> } {
  const rids: string[] = [];
  // Resolved the instant the late reply is actually written, so the test waits
  // on the EVENT rather than on a sleep long enough to probably cover it.
  let markSent: () => void;
  const lateReplySent = new Promise<void>((r) => (markSent = r));
  sock.on("message", (buf) => {
    const msg = JSON.parse(buf.toString()) as { rid?: string; cmd?: string };
    if (typeof msg.rid !== "string" || msg.cmd !== "graph_set_node_mode") return;
    const rid = msg.rid;
    rids.push(rid);
    const reply = JSON.stringify({ rid, ok: true, result: { node_id: 126, mode: "active" } });
    if (rids.length === 1) {
      setTimeout(() => {
        sock.send(reply);
        markSent();
      }, firstReplyDelayMs);
    } else {
      sock.send(reply);
    }
  });
  return { rids, lateReplySent };
}

/** The reply is written asynchronously; give the bridge's message loop the tick
 *  it needs to receive and record it. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
}

/**
 * The REAL ctx, with one property shortened: `call` supplies a tight default
 * deadline when the handler passes none (panel_set_node_mode passes none, so it
 * would otherwise wait the full 20 s production default). Everything the test
 * asserts on — the onDispatchedRid observer, the retry-token mint, the retry_of
 * attachment, the drain — is the untouched production implementation, reached
 * through this one delegation.
 */
function fastCtx(tabId: string, timeoutMs = 60): PanelToolCtx {
  const real = makePanelToolCtx(bridge, tabId);
  const ctx = Object.create(real) as PanelToolCtx;
  ctx.call = (cmd, t, onDispatchedRid) => real.call(cmd, t ?? timeoutMs, onDispatchedRid);
  return ctx;
}

const setNodeMode = () => buildPanelToolDefs().find((d) => d.name === "panel_set_node_mode")!;

/** The rid an agent would copy out of the failure text, exactly as told to. */
function ridFromHint(text: string): string | undefined {
  return /retry_of:"([^"]+)"/.exec(text)?.[1];
}

const indexSrc = (): string =>
  readFileSync(new URL("../../orchestrator/index.ts", import.meta.url), "utf8");

describe("late-mutation notice, end to end over a real bridge (#694)", () => {
  it("the rid quoted in the retry hint IS the rid the bridge keyed retention by", async () => {
    const sock = await connectPanel("tab-e2e");
    const panel = scriptPanel(sock, 200);
    const ctx = fastCtx("tab-e2e");

    // 1. The reported failure: a write that is dispatched and then not answered
    //    in time. The caller is handed a retry token.
    const first = await setNodeMode().handler({ node_id: 126, mode: "active" }, ctx);
    expect(first.isError, "the first attempt should have timed out").toBe(true);
    const hintRid = ridFromHint(textOf(first));
    expect(hintRid, `no retry token in: ${textOf(first)}`).toBeTruthy();

    // 2. THE ASSERTION THIS FILE EXISTS FOR. Nothing else in the suite pins it:
    //    the token an agent is told to quote must be the rid the bridge minted,
    //    dispatched under, and keyed `timedOutMutations` by.
    expect(panel.rids).toHaveLength(1);
    expect(hintRid, "the retry hint quotes a rid the bridge never dispatched").toBe(panel.rids[0]);

    // 3. The write lands late. The reply carries that same rid and is retained.
    await panel.lateReplySent;
    await settle();

    // 4. The agent retries as instructed — and is told the earlier attempt had
    //    already applied, without ever handing the drain a rid of our choosing.
    const retry = await setNodeMode().handler(
      { node_id: 126, mode: "active", retry_of: hintRid },
      ctx,
    );
    expect(retry.isError).toBeFalsy();
    expect(textOf(retry)).toMatch(/DID complete/);
    expect(textOf(retry)).toContain("graph_set_node_mode");
    expect(textOf(retry)).toContain("tab-e2e");
    // The retry's own result survives underneath the notice.
    expect(retry.content.length).toBeGreaterThan(1);
    // Not a short-circuit: the retry really was dispatched (#683/#687).
    expect(panel.rids).toHaveLength(2);
    expect(panel.rids[1]).not.toBe(panel.rids[0]);
  });

  it("catches a reply that lands WHILE the retry is in flight", async () => {
    // The drain runs after the handler precisely so this case is covered. When
    // it ran first, a panel that unblocked a moment after the agent retried
    // stranded its outcome in the map until TTL — and since a successful retry
    // mints no new token, nobody could ever have drained it.
    const sock = await connectPanel("tab-inflight");
    const rids: string[] = [];
    let firstRid = "";
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString()) as { rid?: string; cmd?: string };
      if (typeof msg.rid !== "string" || msg.cmd !== "graph_set_node_mode") return;
      rids.push(msg.rid);
      if (rids.length === 1) {
        firstRid = msg.rid;
        return; // answered below, only once the retry is already under way
      }
      // The retry arrives: release the FIRST attempt's late reply first, then
      // answer the retry, so the late outcome lands mid-flight.
      sock.send(JSON.stringify({ rid: firstRid, ok: true, result: { mode: "active" } }));
      const retryRid = msg.rid;
      setTimeout(
        () => sock.send(JSON.stringify({ rid: retryRid, ok: true, result: { mode: "active" } })),
        40,
      );
    });
    const ctx = fastCtx("tab-inflight");
    const first = await setNodeMode().handler({ node_id: 126, mode: "active" }, ctx);
    const hintRid = ridFromHint(textOf(first));
    expect(hintRid).toBe(firstRid);

    const retry = await setNodeMode().handler(
      { node_id: 126, mode: "active", retry_of: hintRid },
      ctx,
    );
    expect(textOf(retry)).toMatch(/DID complete/);
  });

  it("says nothing when the write never landed — the ordinary retry", async () => {
    // The same flow with a panel that simply never answers the first attempt.
    // Guards the over-fire: a retry must not claim a completion that never came.
    const sock = await connectPanel("tab-never");
    const rids: string[] = [];
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString()) as { rid?: string; cmd?: string };
      if (typeof msg.rid !== "string" || msg.cmd !== "graph_set_node_mode") return;
      rids.push(msg.rid);
      if (rids.length > 1) sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: {} }));
    });
    const ctx = fastCtx("tab-never");
    const first = await setNodeMode().handler({ node_id: 126, mode: "active" }, ctx);
    const hintRid = ridFromHint(textOf(first));
    expect(hintRid).toBeTruthy();
    await settle();
    const retry = await setNodeMode().handler(
      { node_id: 126, mode: "active", retry_of: hintRid },
      ctx,
    );
    expect(retry.isError).toBeFalsy();
    expect(textOf(retry)).not.toMatch(/DID complete/);
  });

  it("FAIL CLOSED end to end — no filter installed, no notice", async () => {
    // Retention is opt-in from the retry-token layer. This is the whole-stack
    // statement of it: with the filter uninstalled the identical scenario, up to
    // and including a correctly-quoted retry token, reports nothing. If this
    // test ever passes the notice, retention is happening on some path the
    // filter does not gate.
    bridge.setLateMutationFilter(null);
    const sock = await connectPanel("tab-nofilter");
    const panel = scriptPanel(sock, 200);
    const ctx = fastCtx("tab-nofilter");
    const first = await setNodeMode().handler({ node_id: 126, mode: "active" }, ctx);
    const hintRid = ridFromHint(textOf(first));
    expect(hintRid, "the retry token is minted regardless of retention").toBe(panel.rids[0]);
    await panel.lateReplySent;
    await settle();
    const retry = await setNodeMode().handler(
      { node_id: 126, mode: "active", retry_of: hintRid },
      ctx,
    );
    expect(textOf(retry)).not.toMatch(/DID complete/);
  });

  it("SOURCE: the orchestrator installs that filter from RETRY_TOKEN_CMDS", () => {
    // The test above installs the filter itself, which is only honest if
    // production installs the same one. It is wired inside
    // runPanelOrchestrator(), which a unit test cannot boot — so assert the
    // wiring at the source, the way the shared-session and hello-stamp
    // invariants do. Without this, deleting the production install leaves every
    // test in this file green and the feature dead.
    expect(indexSrc()).toMatch(
      /setLateMutationFilter\(\s*\(\s*\w+\s*\)\s*=>\s*RETRY_TOKEN_CMDS\.has\(\s*\w+\s*\)\s*\)/,
    );
  });
});
